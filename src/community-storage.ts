// Dataset Commons — storage layer for community (shared) + per-viewer data.
//
// Two platform stores, two honesty rules:
//  - Shared storage holds datasets, items, custom up/down vote records,
//    snapshots, LoRA records, and ledger events. It is postMessage-only and
//    cannot be seeded or written from a server, so every write here goes
//    through the viewer's own host bridge calls.
//  - Per-viewer app storage holds only the viewer's settings and a derived
//    index (my items / my votes / my snapshots). The shared fold is always
//    the source of truth; the per-viewer copy is a cache that can be rebuilt.
//
// Not-permitted is a first-class outcome, never a fake empty: a scope-shaped
// rejection, or an empty shared read on a token that does not carry the shared
// read scope, classifies as 'not-permitted' so the UI can say community data
// isn't loading instead of showing a false zero/empty state.

import { classifyAppStorageError } from '@civitai/app-sdk/blocks';

import type { SharedEntryLike } from './community.js';

export const APP_STORAGE_SCOPES = ['apps:storage:read', 'apps:storage:write'] as const;
export const SHARED_STORAGE_SCOPES = [
  'apps:storage:shared:read',
  'apps:storage:shared:write',
] as const;
export const STORAGE_SCOPES = [...APP_STORAGE_SCOPES, ...SHARED_STORAGE_SCOPES] as const;
export const ALL_APP_SCOPES = ['ai:write:budgeted', ...STORAGE_SCOPES] as const;

export type StorageAccess = 'ready' | 'not-permitted' | 'failed';

export interface SharedListPort {
  list(opts?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ items: readonly SharedEntryLike[]; nextCursor?: string }>;
  append(value: { title: string; body?: string; data?: unknown }): Promise<{ key: string }>;
  update(key: string, value: { title: string; body?: string; data?: unknown }): Promise<void>;
  withdraw(key: string): Promise<{ ok: boolean; deleted: boolean }>;
}

export interface AppStoragePort {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<{ ok: true; sizeBytes?: number }>;
  delete(key: string): Promise<{ ok: true; deleted: boolean }>;
  list(opts?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ keys: Array<{ key: string; updatedAt: Date }>; nextCursor?: string }>;
  getQuota(): Promise<{ usedBytes: number; rowCount: number; limitBytes: number; limitRows: number }>;
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

const SCOPE_DENIED =
  /(shared storage|storage) [a-z ]*requires the apps:storage:(shared:)?(read|write) scope/i;
const PERMISSION_SHAPED = /forbidden|unauthori[sz]ed|consent|permission|scope/i;

/**
 * Classify a storage failure for the UI. Scope/permission-shaped failures are
 * 'not-permitted' (consent or approval fixes them; retrying does not). Known
 * app-storage ceilings and every other failure are 'failed' — a snag the UI
 * can offer to retry without mislabelling it as a permissions problem. The raw
 * host message is never rendered to a viewer.
 */
export function classifyStorageError(error: unknown): Exclude<StorageAccess, 'ready'> {
  const message = errorMessage(error);
  if (SCOPE_DENIED.test(message) || PERMISSION_SHAPED.test(message)) return 'not-permitted';
  void classifyAppStorageError(error);
  return 'failed';
}

/** True when the block token already carries every scope in `required`. */
export function hasScopes(
  scopes: readonly string[] | undefined | null,
  required: readonly string[],
): boolean {
  if (!scopes) return false;
  return required.every((s) => scopes.includes(s));
}

/**
 * Classify a completed shared read. An empty list on a token WITHOUT the
 * shared read scope is not evidence of an empty community — hosts have
 * answered scope-gated reads with silent empty success before — so it
 * classifies as 'not-permitted', never as a real zero.
 */
export function classifySharedRead(
  entries: readonly SharedEntryLike[],
  tokenScopes: readonly string[] | undefined | null,
): StorageAccess {
  if (entries.length === 0 && !hasScopes(tokenScopes, ['apps:storage:shared:read'])) {
    return 'not-permitted';
  }
  return 'ready';
}

export const MAX_SHARED_PAGES = 5;
export const SHARED_PAGE_SIZE = 100;

export interface SharedLoadResult {
  entries: SharedEntryLike[];
  access: StorageAccess;
  /** True when paging stopped at the page cap with more entries unread. */
  truncated: boolean;
}

/** Page the whole shared list (newest-first pages, folded by the caller). */
export async function loadSharedEntries(
  shared: SharedListPort,
  tokenScopes: readonly string[] | undefined | null,
  opts: { maxPages?: number; pageSize?: number } = {},
): Promise<SharedLoadResult> {
  const maxPages = opts.maxPages ?? MAX_SHARED_PAGES;
  const pageSize = opts.pageSize ?? SHARED_PAGE_SIZE;
  const entries: SharedEntryLike[] = [];
  let cursor: string | undefined;
  let truncated = false;
  try {
    for (let page = 0; page < maxPages; page++) {
      const result = await shared.list({ limit: pageSize, cursor });
      entries.push(...result.items);
      cursor = result.nextCursor;
      if (!cursor) break;
      if (page === maxPages - 1) truncated = true;
    }
  } catch (error) {
    return { entries: [], access: classifyStorageError(error), truncated: false };
  }
  return { entries, access: classifySharedRead(entries, tokenScopes), truncated };
}

function dataOf(entry: SharedEntryLike): Record<string, unknown> | null {
  const data = entry.value?.data;
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
}

/**
 * Update the viewer's own existing entry in place when one already matches,
 * instead of appending a duplicate. Mirrors the Arcane Deck pattern: a known
 * key updates; an unknown key adopts the viewer's own matching entry found in
 * the loaded list; only then does it append.
 */
export async function upsertOwnSharedEntry(
  shared: SharedListPort,
  entries: readonly SharedEntryLike[],
  viewerId: number,
  matches: (data: Record<string, unknown>) => boolean,
  value: { title: string; body?: string; data?: unknown },
  knownKey?: string,
): Promise<{ key: string; created: boolean }> {
  if (knownKey) {
    await shared.update(knownKey, value);
    return { key: knownKey, created: false };
  }
  const own = entries.find((e) => {
    if (e.authorUserId !== viewerId) return false;
    const data = dataOf(e);
    return data ? matches(data) : false;
  });
  if (own) {
    await shared.update(own.key, value);
    return { key: own.key, created: false };
  }
  const { key } = await shared.append(value);
  return { key, created: true };
}

// ---------------------------------------------------------------------------
// Per-viewer app storage: settings + derived index, with capped keys
// ---------------------------------------------------------------------------

/**
 * Cap a per-viewer storage key at the host's 200-char limit. Long ids are
 * hashed (FNV-1a, deterministic) rather than silently truncated into a
 * collision.
 */
export function safeAppStorageKey(prefix: string, id: string): string {
  const cleanPrefix = prefix.replace(/[^a-zA-Z0-9:_-]/g, '-').slice(0, 60) || 'dc';
  const cleanId = id.replace(/[^a-zA-Z0-9:_-]/g, '-');
  const full = `${cleanPrefix}:${cleanId}`;
  if (full.length <= 200) return full;
  let hash = 0x811c9dc5;
  for (let i = 0; i < full.length; i++) {
    hash ^= full.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${cleanPrefix}:${cleanId.slice(0, 120)}:${(hash >>> 0).toString(16)}`;
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
  storage: AppStoragePort,
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
  storage: AppStoragePort,
  viewerId: number,
): Promise<{ index: ViewerIndex | null; access: StorageAccess }> {
  try {
    const index = await storage.get<ViewerIndex>(viewerIndexKey(viewerId));
    return { index: index ?? null, access: 'ready' };
  } catch (error) {
    return { index: null, access: classifyStorageError(error) };
  }
}

export type DcTheme = 'dark' | 'light';

export async function saveThemePreference(
  storage: AppStoragePort,
  viewerId: number,
  theme: DcTheme,
): Promise<StorageAccess> {
  try {
    await storage.set(settingsKey(viewerId), { theme });
    return 'ready';
  } catch (error) {
    return classifyStorageError(error);
  }
}

export async function loadThemePreference(
  storage: AppStoragePort,
  viewerId: number,
): Promise<{ theme: DcTheme; access: StorageAccess }> {
  try {
    const saved = await storage.get<{ theme?: unknown }>(settingsKey(viewerId));
    return { theme: saved?.theme === 'light' ? 'light' : 'dark', access: 'ready' };
  } catch (error) {
    return { theme: 'dark', access: classifyStorageError(error) };
  }
}
