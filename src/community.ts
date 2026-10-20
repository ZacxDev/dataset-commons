// Dataset Commons — community data core for the remaining screens (voting
// option (b), decided by Zacx 2026-10-06).
//
// Since 0.2.0 the community lives in the App Blocks DOCUMENT STORE, one shared
// collection per entity: datasets, items, snapshots, loras, ledger, removals
// (declared in block.manifest.json; read and written by ./community-storage.ts).
// The collection says what a document is — there is no `kind` field any more.
// The cutover copy (`scripts/appdata-copy/copy-dataset-commons-to-appdata.sql`
// in the cluster repo) lays the legacy rows down in exactly the shapes below.
//
// Votes are the store's per-viewer MARKS `up` and `down` on the dataset or item
// document itself (the app sets at most one of the two per viewer). The tally
// is `marks.up` − `marks.down` and "my vote" is the store's `viewer.marks`:
// there are no vote records, no `voterId` and no `targetId` any more. Dataset
// votes rank Explore only; item votes feed inclusion + the vote-weighted split
// through training.ts. Later votes on the live dataset never rewrite a frozen
// snapshot.
//
// Identity rule (pinned here, not improvised in the UI): the store never
// discloses a numeric user id, so community records carry the writer's numeric
// id in their OWN data (`ownerId`, `contributorId`, `trainerId`, `actorId` — as
// the legacy rows already did), and snapshot contributor ids use the stable
// string form `user:<id>` so training.ts's string-keyed share math stays
// intact. Display names travel as separate name fields and are never used as
// identity. Who may CHANGE a document is the store's rule: its author only
// (`write: "own"`).

import {
  creditLedgerEvent,
  deriveContributorCredits,
  type DatasetItem,
  type DatasetSnapshot,
  type LedgerEvent,
} from './training.js';

export type VoteValue = -1 | 0 | 1;
export type VoteTargetKind = 'dataset' | 'item';

export const ONSITE_EARNINGS_LINE =
  "Onsite generations aren't reported to apps yet — tracked here when the platform exposes them.";

export const COSMETIC_TRUST_LINE =
  'Vote counts live in shared storage — take them as a signal, not proof.';

/** The shared collections, one per entity. Must match `block.manifest.json`. */
export const COMMUNITY_COLLECTIONS = ['datasets', 'items', 'snapshots', 'loras', 'ledger', 'removals'] as const;
export type CommunityCollection = (typeof COMMUNITY_COLLECTIONS)[number];

/** The two vote marks declared on `datasets` and `items`. */
export const UP_MARK = 'up';
export const DOWN_MARK = 'down';

/** One shared document, as the fold reads it (`toEntry` in ./community-storage.ts). */
export interface SharedEntryLike {
  key: string;
  collection: CommunityCollection;
  data: unknown;
  createdAt: Date | string;
  updatedAt: Date | string;
  /** The `up` / `down` mark counts (0 on a collection that declares no marks). */
  up: number;
  down: number;
  /** The viewer's own vote on this document, from the store's `viewer.marks`. */
  viewerVote: VoteValue;
}

export interface DatasetRecord {
  storageKey?: string;
  datasetId: string;
  ownerId: number;
  ownerName: string;
  name: string;
  description: string;
  targetNote: string;
  createdAt: string;
  updatedAt: string;
}

export interface DatasetItemRecord {
  storageKey?: string;
  itemId: string;
  datasetId: string;
  contributorId: number;
  contributorName: string;
  /** Civitai Image id for the gated read, when the reference carries one. */
  imageId?: number;
  /** Civitai image URL / blob URL / id reference. Metadata only, never bytes. */
  imageRef: string;
  caption: string;
  rightsAsserted: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The vote marks on ONE dataset or item document. */
export interface VoteRecord {
  /** The document the marks sit on — what a vote marks / unmarks. */
  storageKey: string;
  targetKind: VoteTargetKind;
  targetId: string;
  up: number;
  down: number;
  viewerVote: VoteValue;
}

export interface ItemRemovalRecord {
  storageKey?: string;
  itemId: string;
  datasetId: string;
  actorId: number;
  reason: 'owner-remove' | 'contributor-withdraw';
  createdAt: string;
}

export interface LoraRecord {
  storageKey?: string;
  loraId: string;
  datasetId: string;
  snapshotId: string;
  trainerId: number;
  trainerName: string;
  name: string;
  workflowId?: string;
  modelId?: number;
  modelVersionId?: number;
  published: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FoldedCommunity {
  datasets: DatasetRecord[];
  items: DatasetItemRecord[];
  votes: VoteRecord[];
  snapshots: DatasetSnapshot[];
  snapshotStorageKeys: ReadonlyMap<string, string>;
  loras: LoraRecord[];
  ledgerEvents: LedgerEvent[];
  removals: ItemRemovalRecord[];
}

// ---------------------------------------------------------------------------
// Small parsing helpers — shared `data` is unmoderated app state, so every
// field is validated before it is trusted.
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string' && v.length > 0) return v;
  return '';
}

/** Stable snapshot contributor id for a numeric Civitai user id. */
export function contributorKey(userId: number): string {
  return `user:${userId}`;
}

/** Every contributor-id spelling that should count as "this viewer". */
export function viewerAliases(viewerId: number | null, username?: string | null): string[] {
  if (viewerId == null) return username ? [username] : [];
  const aliases = [contributorKey(viewerId), String(viewerId)];
  if (username) aliases.push(username);
  return aliases;
}

function entryTime(entry: SharedEntryLike): string {
  return iso(entry.updatedAt) || iso(entry.createdAt);
}

function latestBy<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  timeOf: (row: T) => string,
  keyTieOf: (row: T) => string,
): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) {
    const key = keyOf(row);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, row);
      continue;
    }
    const t = timeOf(row);
    const pt = timeOf(prev);
    if (t > pt || (t === pt && keyTieOf(row) > keyTieOf(prev))) byKey.set(key, row);
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Fold: shared entries -> typed community records
// ---------------------------------------------------------------------------

export function foldSharedEntries(entries: readonly SharedEntryLike[]): FoldedCommunity {
  const datasets: DatasetRecord[] = [];
  const items: DatasetItemRecord[] = [];
  const votes: VoteRecord[] = [];
  const snapshots: DatasetSnapshot[] = [];
  const snapshotStorageKeys = new Map<string, string>();
  const loras: LoraRecord[] = [];
  const ledgerEvents: LedgerEvent[] = [];
  const removals: ItemRemovalRecord[] = [];

  for (const entry of entries) {
    const data = asRecord(entry.data);
    if (!data) continue;
    const at = entryTime(entry);

    if (entry.collection === 'datasets') {
      const datasetId = str(data.datasetId);
      const ownerId = num(data.ownerId);
      if (!datasetId || ownerId == null) continue;
      datasets.push({
        storageKey: entry.key,
        datasetId,
        ownerId,
        ownerName: str(data.ownerName) || 'unknown',
        name: str(data.name) || 'Untitled dataset',
        description: str(data.description),
        targetNote: str(data.targetNote),
        createdAt: iso(data.createdAt) || iso(entry.createdAt),
        updatedAt: iso(data.updatedAt) || at,
      });
      votes.push({
        storageKey: entry.key,
        targetKind: 'dataset',
        targetId: datasetId,
        up: entry.up,
        down: entry.down,
        viewerVote: entry.viewerVote,
      });
    } else if (entry.collection === 'items') {
      const itemId = str(data.itemId);
      const datasetId = str(data.datasetId);
      const contributorId = num(data.contributorId);
      if (!itemId || !datasetId || contributorId == null) continue;
      const imageId = num(data.imageId);
      items.push({
        storageKey: entry.key,
        itemId,
        datasetId,
        contributorId,
        contributorName: str(data.contributorName) || 'unknown',
        ...(imageId != null && imageId > 0 ? { imageId: Math.trunc(imageId) } : {}),
        imageRef: str(data.imageRef) || str(data.imageUrl),
        caption: str(data.caption),
        rightsAsserted: data.rightsAsserted === true,
        createdAt: iso(data.createdAt) || iso(entry.createdAt),
        updatedAt: iso(data.updatedAt) || at,
      });
      votes.push({
        storageKey: entry.key,
        targetKind: 'item',
        targetId: itemId,
        up: entry.up,
        down: entry.down,
        viewerVote: entry.viewerVote,
      });
    } else if (entry.collection === 'snapshots') {
      if (typeof data.snapshotId !== 'string' || !Array.isArray(data.items)) continue;
      const snapshot = data as unknown as DatasetSnapshot;
      snapshots.push(snapshot);
      const prev = snapshotStorageKeys.get(snapshot.snapshotId);
      if (!prev || entry.key > prev) snapshotStorageKeys.set(snapshot.snapshotId, entry.key);
    } else if (entry.collection === 'loras') {
      const loraId = str(data.loraId);
      const trainerId = num(data.trainerId);
      if (!loraId || trainerId == null) continue;
      const modelId = num(data.modelId);
      const modelVersionId = num(data.modelVersionId);
      loras.push({
        storageKey: entry.key,
        loraId,
        datasetId: str(data.datasetId),
        snapshotId: str(data.snapshotId),
        trainerId,
        trainerName: str(data.trainerName) || 'unknown',
        name: str(data.name) || 'LoRA',
        ...(str(data.workflowId) ? { workflowId: str(data.workflowId) } : {}),
        ...(modelId != null ? { modelId: Math.trunc(modelId) } : {}),
        ...(modelVersionId != null ? { modelVersionId: Math.trunc(modelVersionId) } : {}),
        published: data.published === true,
        createdAt: iso(data.createdAt) || iso(entry.createdAt),
        updatedAt: iso(data.updatedAt) || at,
      });
    } else if (entry.collection === 'ledger') {
      if (typeof data.eventId !== 'string' || typeof data.sourceRef !== 'string') continue;
      const event = data as unknown as LedgerEvent;
      if (
        event.eventType !== 'training' &&
        event.eventType !== 'generation_in_app' &&
        event.eventType !== 'generation_onsite'
      ) {
        continue;
      }
      ledgerEvents.push(event);
    } else if (entry.collection === 'removals') {
      const itemId = str(data.itemId);
      const actorId = num(data.actorId);
      if (!itemId || actorId == null) continue;
      removals.push({
        storageKey: entry.key,
        itemId,
        datasetId: str(data.datasetId),
        actorId,
        reason: data.reason === 'contributor-withdraw' ? 'contributor-withdraw' : 'owner-remove',
        createdAt: iso(data.createdAt) || at,
      });
    }
  }

  const dedupedLedger: LedgerEvent[] = [];
  for (const event of [...ledgerEvents].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const next = creditLedgerEvent(dedupedLedger, event);
    dedupedLedger.splice(0, dedupedLedger.length, ...next.events);
  }

  return {
    datasets: latestBy(datasets, (d) => d.datasetId, (d) => d.updatedAt, (d) => d.storageKey ?? ''),
    items: latestBy(items, (i) => i.itemId, (i) => i.updatedAt, (i) => i.storageKey ?? ''),
    // One tally per dataset/item DOCUMENT; duplicates of one id (a legacy double
    // write) keep their own marks and `tallyVotes` sums them.
    votes,
    snapshots: latestBy(snapshots, (s) => s.snapshotId, (s) => s.createdAt, (s) => s.snapshotId),
    snapshotStorageKeys,
    loras: latestBy(loras, (l) => l.loraId, (l) => l.updatedAt, (l) => l.storageKey ?? ''),
    ledgerEvents: dedupedLedger,
    removals: latestBy(removals, (r) => r.itemId, (r) => r.createdAt, (r) => r.storageKey ?? ''),
  };
}

// ---------------------------------------------------------------------------
// Votes (spec §7.1)
// ---------------------------------------------------------------------------

export interface VoteTally {
  up: number;
  down: number;
  net: number;
  viewerVote: VoteValue;
}

/**
 * The tally for one target: the marks on every document holding it (normally
 * one). `viewerVote` is the viewer's own mark, from the store.
 */
export function tallyVotes(
  votes: readonly VoteRecord[],
  targetKind: VoteTargetKind,
  targetId: string,
): VoteTally {
  let up = 0;
  let down = 0;
  let viewerVote: VoteValue = 0;
  for (const vote of votes) {
    if (vote.targetKind !== targetKind || vote.targetId !== targetId) continue;
    up += vote.up;
    down += vote.down;
    if (vote.viewerVote !== 0) viewerVote = vote.viewerVote;
  }
  return { up, down, net: up - down, viewerVote };
}

/** Clicking the viewer's current value clears it; any other click replaces it. */
export function nextVoteValue(current: VoteValue, clicked: 1 | -1): VoteValue {
  return current === clicked ? 0 : clicked;
}

/** The mark that carries a vote value (`null` for 0, no vote). */
export function markForVote(value: VoteValue): typeof UP_MARK | typeof DOWN_MARK | null {
  return value === 1 ? UP_MARK : value === -1 ? DOWN_MARK : null;
}

/**
 * The document a vote on a target marks: the one already carrying the viewer's
 * mark, else the newest-keyed document holding the target (normally the only one).
 */
export function voteTarget(
  votes: readonly VoteRecord[],
  targetKind: VoteTargetKind,
  targetId: string,
): VoteRecord | null {
  let found: VoteRecord | null = null;
  for (const vote of votes) {
    if (vote.targetKind !== targetKind || vote.targetId !== targetId) continue;
    if (vote.viewerVote !== 0) return vote;
    if (!found || vote.storageKey > found.storageKey) found = vote;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

export interface DatasetItemView extends DatasetItemRecord {
  netVotes: number;
  upVotes: number;
  downVotes: number;
  viewerVote: VoteValue;
  removed: boolean;
  /** True at current votes: net-positive and not removed. */
  includedNow: boolean;
  /** Snapshots this item was actually trained into (included at freeze time). */
  snapshotAppearances: number;
}

export interface DatasetView extends DatasetRecord {
  items: DatasetItemView[];
  netVotes: number;
  viewerVote: VoteValue;
  trainableCount: number;
  loraCount: number;
  snapshotCount: number;
}

export interface LoraView extends LoraRecord {
  dataset?: DatasetRecord;
  snapshot?: DatasetSnapshot;
  events: LedgerEvent[];
}

export interface CommunityView {
  datasets: DatasetView[];
  loras: LoraView[];
}

/** The derived views. The viewer's own votes come from the store's marks, already on `folded.votes`. */
export function buildCommunityView(folded: FoldedCommunity): CommunityView {
  const removedIds = new Set(folded.removals.map((r) => r.itemId));
  const appearances = new Map<string, number>();
  for (const snapshot of folded.snapshots) {
    for (const item of snapshot.items) {
      if (item.included) appearances.set(item.itemId, (appearances.get(item.itemId) ?? 0) + 1);
    }
  }

  const datasets = folded.datasets.map((dataset) => {
    const datasetTally = tallyVotes(folded.votes, 'dataset', dataset.datasetId);
    const items = folded.items
      .filter((item) => item.datasetId === dataset.datasetId)
      .map((item) => {
        const tally = tallyVotes(folded.votes, 'item', item.itemId);
        const removed = removedIds.has(item.itemId);
        return {
          ...item,
          netVotes: tally.net,
          upVotes: tally.up,
          downVotes: tally.down,
          viewerVote: tally.viewerVote,
          removed,
          includedNow: !removed && tally.net > 0,
          snapshotAppearances: appearances.get(item.itemId) ?? 0,
        } satisfies DatasetItemView;
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.itemId.localeCompare(b.itemId));
    return {
      ...dataset,
      items,
      netVotes: datasetTally.net,
      viewerVote: datasetTally.viewerVote,
      trainableCount: items.filter((i) => i.includedNow).length,
      loraCount: folded.loras.filter((l) => l.datasetId === dataset.datasetId).length,
      snapshotCount: folded.snapshots.filter((s) => s.datasetId === dataset.datasetId).length,
    } satisfies DatasetView;
  });

  const datasetById = new Map(folded.datasets.map((d) => [d.datasetId, d]));
  const snapshotById = new Map(folded.snapshots.map((s) => [s.snapshotId, s]));
  const loras = folded.loras.map((lora) => ({
    ...lora,
    dataset: datasetById.get(lora.datasetId),
    snapshot: snapshotById.get(lora.snapshotId),
    events: folded.ledgerEvents
      .filter((e) => e.loraId === lora.loraId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  }));

  return { datasets, loras };
}

export type ExploreSort = 'top-voted' | 'newest' | 'most-trained';

export function filterAndSortDatasets(
  datasets: readonly DatasetView[],
  opts: { query?: string; sort?: ExploreSort } = {},
): DatasetView[] {
  const q = (opts.query ?? '').trim().toLowerCase();
  const rows = datasets.filter((d) => {
    if (!q) return true;
    return (
      d.name.toLowerCase().includes(q) ||
      d.description.toLowerCase().includes(q) ||
      d.ownerName.toLowerCase().includes(q) ||
      d.targetNote.toLowerCase().includes(q)
    );
  });
  const sort = opts.sort ?? 'top-voted';
  return [...rows].sort((a, b) => {
    if (sort === 'newest') return b.createdAt.localeCompare(a.createdAt) || b.netVotes - a.netVotes;
    if (sort === 'most-trained') {
      return b.loraCount - a.loraCount || b.snapshotCount - a.snapshotCount || b.netVotes - a.netVotes;
    }
    return b.netVotes - a.netVotes || b.trainableCount - a.trainableCount || b.createdAt.localeCompare(a.createdAt);
  });
}

/** Live items -> the Train core's DatasetItem shape (removed items never train). */
export function trainingItemsForDataset(dataset: DatasetView): DatasetItem[] {
  return dataset.items
    .filter((item) => !item.removed)
    .map((item) => ({
      itemId: item.itemId,
      contributorId: contributorKey(item.contributorId),
      contributorName: item.contributorName,
      imageUrl: item.imageRef,
      ...(item.imageId != null ? { imageId: item.imageId } : {}),
      caption: item.caption,
      netVotes: item.netVotes,
    }));
}

export interface SnapshotShareRow {
  contributorId: string;
  contributorName: string;
  weight: number;
  share: number;
}

/** Included snapshot items grouped into contributor share rows. */
export function snapshotShareRows(snapshot: DatasetSnapshot): SnapshotShareRow[] {
  const byContributor = new Map<string, SnapshotShareRow>();
  for (const item of snapshot.items) {
    if (!item.included) continue;
    const prev = byContributor.get(item.contributorId);
    if (prev) prev.weight += item.weight;
    else {
      byContributor.set(item.contributorId, {
        contributorId: item.contributorId,
        contributorName: item.contributorName || item.contributorId,
        weight: item.weight,
        share: 0,
      });
    }
  }
  const rows = [...byContributor.values()];
  for (const row of rows) row.share = snapshot.totalWeight > 0 ? row.weight / snapshot.totalWeight : 0;
  return rows.sort((a, b) => b.weight - a.weight || a.contributorId.localeCompare(b.contributorId));
}

// ---------------------------------------------------------------------------
// Ledger views (spec §7.4) — derived, never stored per-viewer as truth
// ---------------------------------------------------------------------------

export interface LedgerRow {
  event: LedgerEvent;
  snapshot?: DatasetSnapshot;
  lora?: LoraRecord;
  credit: number;
  share: number;
}

export interface ViewerLedger {
  rows: LedgerRow[];
  totalTracked: number;
  snapshotsIn: DatasetSnapshot[];
}

export function buildViewerLedger(
  folded: FoldedCommunity,
  viewerId: number | null,
  username?: string | null,
): ViewerLedger {
  const aliases = new Set(viewerAliases(viewerId, username));
  const snapshotById = new Map(folded.snapshots.map((s) => [s.snapshotId, s]));
  const loraById = new Map(folded.loras.map((l) => [l.loraId, l]));
  const snapshotsIn = folded.snapshots.filter((s) =>
    s.items.some((item) => item.included && aliases.has(item.contributorId)),
  );
  const rows: LedgerRow[] = [];
  for (const event of folded.ledgerEvents) {
    const snapshot = snapshotById.get(event.snapshotId);
    if (!snapshot) continue;
    const mine = deriveContributorCredits(event, snapshot).find((c) => aliases.has(c.contributorId));
    if (!mine) continue;
    rows.push({ event, snapshot, lora: loraById.get(event.loraId), credit: mine.credit, share: mine.share });
  }
  rows.sort((a, b) => b.event.createdAt.localeCompare(a.event.createdAt));
  return { rows, totalTracked: rows.reduce((sum, r) => sum + r.credit, 0), snapshotsIn };
}

export function generationLedgerEvent(args: {
  lora: Pick<LoraRecord, 'loraId' | 'snapshotId'>;
  workflowId: string;
  grossBuzz: number;
  now?: string;
}): LedgerEvent {
  return {
    eventId: `ledger_generation_${args.workflowId}`,
    loraId: args.lora.loraId,
    snapshotId: args.lora.snapshotId,
    eventType: 'generation_in_app',
    grossBuzz: Math.max(0, Math.round(args.grossBuzz)),
    sourceRef: args.workflowId,
    createdAt: args.now ?? new Date().toISOString(),
  };
}

/**
 * Ingest an onsite-generation event in the shape #540 would supply. Until the
 * platform route exists this is fixture-driven only — v1 never estimates or
 * back-fills onsite earnings.
 */
export function ingestOnsiteLedgerEvent(
  events: readonly LedgerEvent[],
  candidate: LedgerEvent,
): { events: LedgerEvent[]; credited: boolean } {
  if (candidate.eventType !== 'generation_onsite') return { events: [...events], credited: false };
  if (!candidate.sourceRef || !Number.isFinite(candidate.grossBuzz) || candidate.grossBuzz < 0) {
    return { events: [...events], credited: false };
  }
  return creditLedgerEvent(events, candidate);
}

// ---------------------------------------------------------------------------
// Input validation + image references (spec §6, contribution by URL/ID)
// ---------------------------------------------------------------------------

let idSeq = 0;

/** Client-minted record id (the host mints the storage key separately). */
export function makeRecordId(prefix: string): string {
  idSeq += 1;
  const random =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().slice(0, 8)
      : Math.floor(Math.random() * 0xffffffff).toString(16);
  return `${prefix}_${Date.now().toString(36)}_${idSeq.toString(36)}_${random}`;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

export function validateDatasetInput(input: {
  name: string;
  description: string;
  targetNote: string;
}): Validation<{ name: string; description: string; targetNote: string }> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: 'Give the dataset a name.' };
  return {
    ok: true,
    value: { name, description: input.description.trim(), targetNote: input.targetNote.trim() },
  };
}

export interface ParsedImageReference {
  imageId?: number;
  /** Set when the link points at a Civitai post rather than a single image. */
  postId?: number;
  imageRef: string;
}

/**
 * Parse a contributed Civitai image reference: a bare Image id, an image-page
 * URL carrying the id, or any Civitai-hosted image/blob URL. Anything else is
 * refused rather than stored as an unusable reference.
 */
export function parseImageReference(raw: string): Validation<ParsedImageReference> {
  const input = raw.trim();
  if (!input) return { ok: false, error: 'Add a Civitai image URL or image ID.' };
  if (/^\d+$/.test(input)) {
    const imageId = Number(input);
    if (imageId > 0) return { ok: true, value: { imageId, imageRef: input } };
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, error: 'That does not look like a Civitai image URL or image ID.' };
  }
  if (!/(^|\.)civitai\.com$/i.test(url.hostname) && url.hostname !== 'image.civitai.com') {
    return { ok: false, error: 'Use a Civitai image URL or image ID — v1 stores Civitai references only.' };
  }
  const idMatch = url.pathname.match(/\/images?\/(\d+)/i) ?? url.search.match(/[?&]imageId=(\d+)/i);
  const imageId = idMatch ? Number(idMatch[1]) : undefined;
  if (imageId) return { ok: true, value: { imageId, imageRef: url.toString() } };
  const postMatch = url.pathname.match(/\/posts?\/(\d+)/i);
  if (postMatch) return { ok: true, value: { postId: Number(postMatch[1]), imageRef: url.toString() } };
  return { ok: true, value: { imageRef: url.toString() } };
}

/** True when a stored reference points at a Civitai post, not a single image. */
export function isPostReference(imageRef: string): boolean {
  return /civitai\.com\/posts?\//i.test(imageRef);
}

export function validateContribution(input: {
  imageRef: string;
  imageId?: number;
  caption: string;
  rightsAsserted: boolean;
}): Validation<{ imageRef: string; imageId?: number; caption: string }> {
  if (!input.imageRef.trim() && input.imageId == null) {
    return { ok: false, error: 'Add a Civitai image URL/ID or upload an image first.' };
  }
  const caption = input.caption.trim();
  if (!caption) return { ok: false, error: 'Give the image a caption — captions are the training text.' };
  if (!input.rightsAsserted) {
    return { ok: false, error: 'Confirm you have the right to contribute this image.' };
  }
  return {
    ok: true,
    value: {
      imageRef: input.imageRef.trim(),
      ...(input.imageId != null ? { imageId: input.imageId } : {}),
      caption,
    },
  };
}

// ---------------------------------------------------------------------------
// Document data — what each collection stores. `storageKey` is the document's
// KEY, never part of its data. The cutover copy writes legacy rows in these
// same shapes (the legacy `data` minus `kind`; a snapshot's / ledger event's
// inner object), so a copied document and a new one read identically.
// ---------------------------------------------------------------------------

function withoutStorageKey<T extends { storageKey?: string }>(record: T): Omit<T, 'storageKey'> {
  const { storageKey: _key, ...rest } = record;
  void _key;
  return rest;
}

export const datasetDoc = (record: DatasetRecord) => withoutStorageKey(record);
export const itemDoc = (record: DatasetItemRecord) => withoutStorageKey(record);
export const loraDoc = (record: LoraRecord) => withoutStorageKey(record);
export const removalDoc = (record: ItemRemovalRecord) => withoutStorageKey(record);
export const snapshotDoc = (snapshot: DatasetSnapshot) => snapshot;
export const ledgerDoc = (event: LedgerEvent) => event;

/** One seed document: who writes it, where, and which viewers vote on it. */
export interface CommunitySeedDoc {
  collection: CommunityCollection;
  /** The author's username (the fake store's viewer identity). */
  author: string;
  data: object;
  /** Usernames that set the `up` / `down` mark on it. */
  up?: readonly string[];
  down?: readonly string[];
}

/** A demo seed for the mock harness and tests only — never shipped as production data. */
export function demoSharedSeed(): CommunitySeedDoc[] {
  const dataset: DatasetRecord = {
    datasetId: 'dataset-archive-ink',
    ownerId: 7,
    ownerName: 'archivist',
    name: 'Archive Ink Portraits',
    description: 'Ink portrait references for a character LoRA.',
    targetNote: 'SDXL character LoRA',
    createdAt: '2026-10-05T00:00:00.000Z',
    updatedAt: '2026-10-05T00:00:00.000Z',
  };
  const items: DatasetItemRecord[] = [
    {
      itemId: 'item-a',
      datasetId: dataset.datasetId,
      contributorId: 11,
      contributorName: 'alice',
      imageRef: 'https://civitai.com/v2/consumer/blobs/archive-ink-a',
      caption: 'ink portrait, front view',
      rightsAsserted: true,
      createdAt: '2026-10-05T00:01:00.000Z',
      updatedAt: '2026-10-05T00:01:00.000Z',
    },
    {
      itemId: 'item-b',
      datasetId: dataset.datasetId,
      contributorId: 12,
      contributorName: 'bob',
      imageRef: 'https://civitai.com/v2/consumer/blobs/archive-ink-b',
      caption: 'ink portrait, profile view',
      rightsAsserted: true,
      createdAt: '2026-10-05T00:02:00.000Z',
      updatedAt: '2026-10-05T00:02:00.000Z',
    },
    {
      itemId: 'item-c',
      datasetId: dataset.datasetId,
      contributorId: 11,
      contributorName: 'alice',
      imageRef: 'https://civitai.com/v2/consumer/blobs/archive-ink-c',
      caption: 'ink portrait, back view',
      rightsAsserted: true,
      createdAt: '2026-10-05T00:03:00.000Z',
      updatedAt: '2026-10-05T00:03:00.000Z',
    },
  ];
  // item-a: 5 up; item-b: 1 up; the dataset: 3 up — distinct voters, as the legacy demo.
  const voters = (from: number, n: number) => Array.from({ length: n }, (_, k) => `voter-${from + k}`);
  return [
    { collection: 'datasets', author: 'archivist', data: datasetDoc(dataset), up: voters(27, 3) },
    { collection: 'items', author: 'alice', data: itemDoc(items[0]!), up: voters(21, 5) },
    { collection: 'items', author: 'bob', data: itemDoc(items[1]!), up: voters(26, 1) },
    { collection: 'items', author: 'alice', data: itemDoc(items[2]!) },
  ];
}
