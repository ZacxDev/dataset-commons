// Dataset Commons — storage layer for community (shared) + per-viewer data, on
// the App Blocks DOCUMENT STORE (`app.storage.collection(name)` from
// `@civitai/sdk`, scopes `apps:storage` + `apps:storage:publish`).
//
// Until 0.2.0 both halves were legacy stores: one shared feed
// (`useSharedStorage`) holding every entity behind a `kind` field — votes
// included, as their own records — and the per-viewer KV (`useAppStorage`).
//
// 🔴 THE SHARED DECLARATION (block.manifest.json → storage.collections) IS A
// CONTRACT WITH THE CUTOVER COPY (`scripts/appdata-copy/copy-dataset-commons-to-appdata.sql`
// in the cluster repo), which lays the legacy rows down as:
//   datasets  { shared, own, marks [up, down] }  ← kind 'dataset'  (data minus `kind`)
//   items     { shared, own, marks [up, down] }  ← kind 'item'     (data minus `kind`)
//   snapshots { shared, own }                    ← kind 'snapshot' (data.snapshot)
//   loras     { shared, own }                    ← kind 'lora'     (data minus `kind`)
//   ledger    { shared, own }                    ← kind 'ledger'   (data.event)
//   removals  { shared, own }                    ← kind 'item-removal' (data minus `kind`)
//   votes (kind 'vote', value ±1) → the voter's `up`/`down` MARK on the target doc.
// Same keys as the legacy rows, authors and timestamps carried over, NO indexes
// (the copy writes no index rows; the app reads each collection whole and folds
// client-side, so it filters on nothing server-side). Renaming a collection or a
// mark, or adding an index, strands or breaks the copied data.
//
// - `write: "own"` everywhere: a viewer creates documents; only the author edits
//   or deletes one. That is exactly how the app already behaves (an owner
//   removing SOMEONE ELSE's item writes a `removals` record instead), and it is
//   the narrowest policy that works. Creating and editing need the
//   consent-gated `apps:storage:publish`; reading, voting (marks) and deleting
//   one's own documents need only `apps:storage`.
// - No `showAuthor`: records carry their own display names, as before.
// - Private `kv` (settings + the derived "my index"): the legacy KV keys
//   verbatim, data `{ value }` — the shared copy-kv-to-appdata.sql contract.
//
// Not-permitted is a first-class outcome, never a fake empty: a refusal the
// store explains with a scope/eligibility code classifies as 'not-permitted'.
// (The legacy "an empty read without the read scope is not-permitted" guess is
// gone: the document store REFUSES a missing scope instead of answering empty.)

import type { DocumentStorage, StorageCollection, StorageDocument } from '@civitai/sdk';

import {
  COMMUNITY_COLLECTIONS,
  DOWN_MARK,
  UP_MARK,
  markForVote,
  type CommunityCollection,
  type SharedEntryLike,
  type VoteValue,
} from './community.js';

/** The private collection (settings + the derived per-viewer index). */
export const KV_COLLECTION = 'kv';
/** The consent-gated scope creating or editing a shared document needs. */
export const PUBLISH_SCOPE = 'apps:storage:publish';
export const STORAGE_SCOPES = ['apps:storage', PUBLISH_SCOPE] as const;
export const ALL_APP_SCOPES = ['ai:write:budgeted', ...STORAGE_SCOPES] as const;
/** The collections that carry the vote marks. */
export const VOTED_COLLECTIONS: readonly CommunityCollection[] = ['datasets', 'items'];

export type StorageAccess = 'ready' | 'not-permitted' | 'failed';

/** The store's `code`, or `null` when a failure carries none. */
export function storageErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

/** Refusals a consent grant fixes (and only those). */
export function isConsentRefusal(error: unknown): boolean {
  return storageErrorCode(error) === 'consent_required';
}

/**
 * Classify a storage failure for the UI, by the store's structured `code`.
 * Scope / consent / eligibility refusals are 'not-permitted' (consent or
 * approval fixes them; retrying does not). Everything else is 'failed' — a snag
 * the UI can offer to retry. The raw message is never the classification.
 */
export function classifyStorageError(error: unknown): Exclude<StorageAccess, 'ready'> {
  switch (storageErrorCode(error)) {
    case 'insufficient_scope':
    case 'consent_required':
    case 'collection_not_declared':
    case 'not_eligible':
      return 'not-permitted';
    default:
      return 'failed';
  }
}

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const m = (error as { message?: unknown }).message;
    return typeof m === 'string' ? m : '';
  }
  return '';
}

/**
 * One-line detail for a failed write, safe to show the viewer and precise
 * enough to report from a walk: the store's code and its own sentence, capped
 * so a pathological message can't flood the banner.
 */
export function describeStorageError(error: unknown): string {
  const message = errorMessage(error).trim();
  const code = storageErrorCode(error);
  const text = code && message && !message.includes(code) ? `${code}: ${message}` : message || code || '';
  if (!text) return 'shared storage write failed';
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}

/**
 * Serialize shared-storage writes: every write — and its refresh — runs to
 * completion before the next starts, so a queued write always folds the state
 * the previous write actually landed (the walker's contribute-then-vote-vote
 * cadence).
 */
export function createSerialWriteQueue(): {
  run<T>(fn: () => Promise<T>): Promise<T>;
} {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const result = tail.then(fn, fn);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// The shared store
// ---------------------------------------------------------------------------

/** A store document → the entry the fold reads. The one place a document becomes an entry. */
export function toEntry(
  collection: CommunityCollection,
  doc: StorageDocument<Record<string, unknown>>,
): SharedEntryLike {
  const mine = doc.viewer?.marks ?? [];
  const viewerVote: VoteValue = mine.includes(UP_MARK) ? 1 : mine.includes(DOWN_MARK) ? -1 : 0;
  return {
    key: doc.key,
    collection,
    data: doc.data,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    up: doc.marks[UP_MARK] ?? 0,
    down: doc.marks[DOWN_MARK] ?? 0,
    viewerVote,
  };
}

/** The shared operations the app performs. Every failure REJECTS with the store's error. */
export interface CommunityStore {
  list(
    collection: CommunityCollection,
    opts: { limit: number; cursor?: string },
  ): Promise<{ items: SharedEntryLike[]; nextCursor?: string }>;
  /** Create a document under a SERVER-minted key. */
  create(collection: CommunityCollection, data: object): Promise<{ key: string }>;
  /** Replace a document the viewer authored. */
  put(collection: CommunityCollection, key: string, data: object): Promise<void>;
  /** Delete a document the viewer authored; `false` = nothing was there. */
  remove(collection: CommunityCollection, key: string): Promise<{ deleted: boolean }>;
  /**
   * Move the viewer's vote on a dataset/item document from `from` to `to`:
   * unmark the old mark, then mark the new one (both idempotent).
   */
  setVote(collection: CommunityCollection, key: string, from: VoteValue, to: VoteValue): Promise<void>;
}

export function createCommunityStore(
  docs: () => DocumentStorage | Promise<DocumentStorage>,
): CommunityStore {
  const coll = async (name: CommunityCollection): Promise<StorageCollection<Record<string, unknown>>> =>
    (await docs()).collection<Record<string, unknown>>(name);

  return {
    async list(collection, opts) {
      const page = await (await coll(collection)).list({
        // Oldest first: the fold's latest-wins rules compare timestamps, not order.
        sort: 'createdAt',
        limit: opts.limit,
        ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
      });
      return {
        items: page.items.map((doc) => toEntry(collection, doc)),
        ...(page.nextCursor !== null ? { nextCursor: page.nextCursor } : {}),
      };
    },
    async create(collection, data) {
      const doc = await (await coll(collection)).create(data as Record<string, unknown>);
      return { key: doc.key };
    },
    async put(collection, key, data) {
      await (await coll(collection)).put(key, data as Record<string, unknown>);
    },
    async remove(collection, key) {
      return (await coll(collection)).delete(key);
    },
    async setVote(collection, key, from, to) {
      if (!VOTED_COLLECTIONS.includes(collection)) throw new Error(`${collection} carries no votes`);
      if (from === to) return;
      const c = await coll(collection);
      const old = markForVote(from);
      const next = markForVote(to);
      if (old) await c.unmark(key, old);
      if (next) await c.mark(key, next);
    },
  };
}

export const MAX_SHARED_PAGES = 5;
export const SHARED_PAGE_SIZE = 100;

export interface SharedLoadResult {
  entries: SharedEntryLike[];
  access: StorageAccess;
  /** True when paging stopped at the page cap with more documents unread in some collection. */
  truncated: boolean;
}

/** Read every community collection whole (up to the page cap each), for the caller to fold. */
export async function loadSharedEntries(
  store: CommunityStore,
  opts: { maxPages?: number; pageSize?: number } = {},
): Promise<SharedLoadResult> {
  const maxPages = opts.maxPages ?? MAX_SHARED_PAGES;
  const pageSize = opts.pageSize ?? SHARED_PAGE_SIZE;
  let truncated = false;
  try {
    const perCollection = await Promise.all(
      COMMUNITY_COLLECTIONS.map(async (collection) => {
        const out: SharedEntryLike[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < maxPages; page++) {
          const result = await store.list(collection, { limit: pageSize, cursor });
          out.push(...result.items);
          cursor = result.nextCursor;
          if (!cursor) break;
          if (page === maxPages - 1) truncated = true;
        }
        return out;
      }),
    );
    return { entries: perCollection.flat(), access: 'ready', truncated };
  } catch (error) {
    return { entries: [], access: classifyStorageError(error), truncated: false };
  }
}

// ---------------------------------------------------------------------------
// Per-viewer private storage: settings + derived index, with capped keys
// ---------------------------------------------------------------------------

/** The private `kv` surface: the legacy KV get/set, over `{ value }` documents. */
export interface KvPort {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<{ ok: true }>;
}

/** The KV façade over the private collection (copy-kv-to-appdata.sql's `{ value }` shape). */
export function createKvStorage(docs: () => DocumentStorage | Promise<DocumentStorage>): KvPort {
  const kv = async () => (await docs()).collection<{ value: unknown }>(KV_COLLECTION);
  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      const doc = await (await kv()).get(key);
      return (doc?.data.value ?? null) as T | null;
    },
    async set<T = unknown>(key: string, value: T): Promise<{ ok: true }> {
      await (await kv()).put(key, { value });
      return { ok: true };
    },
  };
}

/** The document store's key rule: 1–128 of `[A-Za-z0-9._:-]`. */
export const DOC_KEY_MAX = 128;

/**
 * Cap a per-viewer storage key at the document store's 128-char limit. Long ids
 * are hashed (FNV-1a, deterministic) rather than silently truncated into a
 * collision. Short keys (every key this app builds today) are unchanged, so they
 * stay the legacy keys the copy carries over.
 */
export function safeAppStorageKey(prefix: string, id: string): string {
  const cleanPrefix = prefix.replace(/[^a-zA-Z0-9:_-]/g, '-').slice(0, 60) || 'dc';
  const cleanId = id.replace(/[^a-zA-Z0-9:_-]/g, '-');
  const full = `${cleanPrefix}:${cleanId}`;
  if (full.length <= DOC_KEY_MAX) return full;
  let hash = 0x811c9dc5;
  for (let i = 0; i < full.length; i++) {
    hash ^= full.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${cleanPrefix}:${cleanId.slice(0, 50)}:${(hash >>> 0).toString(16)}`;
}

export interface ViewerIndex {
  itemIds: string[];
  voteTargets: string[];
  snapshotIds: string[];
  updatedAt: string;
}

export function viewerIndexKey(viewerId: number): string {
  return safeAppStorageKey('dc-my-index', String(viewerId));
}

export function settingsKey(viewerId: number): string {
  return safeAppStorageKey('dc-settings', String(viewerId));
}

/** Save the derived per-viewer index. Returns the access outcome, never throws. */
export async function saveViewerIndex(
  storage: KvPort,
  viewerId: number,
  index: ViewerIndex,
): Promise<StorageAccess> {
  try {
    await storage.set(viewerIndexKey(viewerId), index);
    return 'ready';
  } catch (error) {
    return classifyStorageError(error);
  }
}

export async function loadViewerIndex(
  storage: KvPort,
  viewerId: number,
): Promise<{ index: ViewerIndex | null; access: StorageAccess }> {
  try {
    const index = await storage.get<ViewerIndex>(viewerIndexKey(viewerId));
    return { index: index ?? null, access: 'ready' };
  } catch (error) {
    return { index: null, access: classifyStorageError(error) };
  }
}
