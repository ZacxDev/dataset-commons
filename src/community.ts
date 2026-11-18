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
  imageRefDisplay,
  isCivitaiSiteUrl,
  safeCivitaiMediaUrl,
  safeCivitaiPostUrl,
} from './civitai-url.js';
import {
  creditLedgerEvent,
  deriveContributorCredits,
  parseDataSource,
  type DatasetItem,
  type DatasetSnapshot,
  type LedgerEvent,
  type SnapshotItem,
  type TrainingDataSource,
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
  /** Where the training images came from; absent on records older than the field (= 'snapshot'). */
  dataSource?: TrainingDataSource;
  createdAt: string;
  updatedAt: string;
}

export interface FoldedCommunity {
  datasets: DatasetRecord[];
  items: DatasetItemRecord[];
  votes: VoteRecord[];
  snapshots: DatasetSnapshot[];
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

/** The largest per-item weight a frozen snapshot can carry (net votes are document mark counts). */
const MAX_SNAPSHOT_WEIGHT = 1_000_000;

function parseSnapshotItem(v: unknown): SnapshotItem | null {
  const item = asRecord(v);
  if (!item) return null;
  const itemId = str(item.itemId);
  const contributorId = str(item.contributorId);
  if (!itemId || !contributorId || typeof item.included !== 'boolean') return null;
  const weight = num(item.weight);
  if (weight == null || weight < 0 || weight > MAX_SNAPSHOT_WEIGHT) return null;
  // freezeSnapshot gives an included item weight max(net, 1) and an excluded one 0.
  if (item.included ? weight <= 0 : weight !== 0) return null;
  const frozenNetVotes = num(item.frozenNetVotes);
  if (frozenNetVotes == null || !Number.isInteger(frozenNetVotes)) return null;
  const imageId = num(item.imageId);
  const exclusionReason =
    item.exclusionReason === 'net-not-positive' || item.exclusionReason === 'manual' ? item.exclusionReason : undefined;
  return {
    itemId,
    contributorId,
    ...(typeof item.contributorName === 'string' && item.contributorName ? { contributorName: item.contributorName } : {}),
    imageUrl: str(item.imageUrl),
    ...(imageId != null && imageId > 0 && Number.isSafeInteger(imageId) ? { imageId } : {}),
    caption: str(item.caption),
    frozenNetVotes,
    weight,
    included: item.included,
    ...(!item.included && exclusionReason ? { exclusionReason } : {}),
    ...(item.included && item.ownerOverride === true ? { ownerOverride: true } : {}),
  };
}

/**
 * A stored snapshot, field-validated like every other shared collection, or
 * `null` (ignored) when anything in it is malformed. Snapshots feed the share
 * and credit math, so a directly-written document must not be able to put a
 * non-number, a negative weight or a fabricated denominator into it:
 * `totalWeight` is RECOMPUTED from the items — the stored one is never read —
 * and an item id may appear once.
 */
export function parseSnapshot(data: Record<string, unknown>): DatasetSnapshot | null {
  const snapshotId = str(data.snapshotId);
  const datasetId = str(data.datasetId);
  if (!snapshotId || !datasetId || !Array.isArray(data.items)) return null;
  const items: SnapshotItem[] = [];
  const seen = new Set<string>();
  for (const raw of data.items) {
    const item = parseSnapshotItem(raw);
    if (!item || seen.has(item.itemId)) return null;
    seen.add(item.itemId);
    items.push(item);
  }
  const totalWeight = items.reduce((sum, i) => sum + (i.included ? i.weight : 0), 0);
  return {
    snapshotId,
    datasetId,
    trainerId: str(data.trainerId),
    createdAt: iso(data.createdAt),
    items,
    totalWeight,
  };
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
  const snapshotsById = new Map<string, { snapshot: DatasetSnapshot; storedAt: string; key: string }>();
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
      const snapshot = parseSnapshot(data);
      if (!snapshot) continue;
      // A frozen snapshot never changes, so the FIRST document stored under an
      // id is the snapshot. Ordered by the store's own creation time and key,
      // never by the writer's `createdAt`: a later document under a published
      // id cannot replace the split every ledger event is credited against.
      const storedAt = iso(entry.createdAt);
      const prev = snapshotsById.get(snapshot.snapshotId);
      if (!prev || storedAt < prev.storedAt || (storedAt === prev.storedAt && entry.key < prev.key)) {
        snapshotsById.set(snapshot.snapshotId, { snapshot, storedAt, key: entry.key });
      }
    } else if (entry.collection === 'loras') {
      const loraId = str(data.loraId);
      const trainerId = num(data.trainerId);
      if (!loraId || trainerId == null) continue;
      const modelId = num(data.modelId);
      const modelVersionId = num(data.modelVersionId);
      const dataSource = parseDataSource(data.dataSource);
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
        ...(dataSource ? { dataSource } : {}),
        createdAt: iso(data.createdAt) || iso(entry.createdAt),
        updatedAt: iso(data.updatedAt) || at,
      });
    } else if (entry.collection === 'ledger') {
      const eventId = str(data.eventId);
      const sourceRef = str(data.sourceRef);
      const loraId = str(data.loraId);
      const snapshotId = str(data.snapshotId);
      const grossBuzz = num(data.grossBuzz);
      const eventType = data.eventType;
      if (!eventId || !sourceRef || !loraId || !snapshotId || grossBuzz == null || grossBuzz < 0) continue;
      if (eventType !== 'training' && eventType !== 'generation_in_app' && eventType !== 'generation_onsite') {
        continue;
      }
      // An unknown stored dataSource is dropped; a missing one reads as 'snapshot'.
      const dataSource = parseDataSource(data.dataSource);
      ledgerEvents.push({
        eventId,
        loraId,
        snapshotId,
        eventType,
        grossBuzz,
        sourceRef,
        createdAt: iso(data.createdAt) || at,
        ...(dataSource ? { dataSource } : {}),
      });
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
    snapshots: [...snapshotsById.values()].map((v) => v.snapshot),
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
  lora: Pick<LoraRecord, 'loraId' | 'snapshotId' | 'dataSource'>;
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
    // The LoRA's images are as attested as its training run was.
    ...(args.lora.dataSource ? { dataSource: args.lora.dataSource } : {}),
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

const NOT_A_CIVITAI_REFERENCE = 'Use a Civitai image or post URL, or an image ID — v1 stores Civitai references only.';

/**
 * Parse a contributed Civitai image reference: a bare Image id, an image-page
 * URL carrying the id (`https://civitai.com/images/<id>`), a post URL
 * (`https://civitai.com/posts/<id>`), or a Civitai media URL (see
 * ./civitai-url.ts for the exact hosts). Anything else is refused rather than
 * stored as an unusable reference.
 */
export function parseImageReference(raw: string): Validation<ParsedImageReference> {
  const input = raw.trim();
  if (!input) return { ok: false, error: 'Add a Civitai image URL or image ID.' };
  if (/^\d+$/.test(input)) {
    const imageId = Number(input);
    if (imageId > 0 && Number.isSafeInteger(imageId)) return { ok: true, value: { imageId, imageRef: input } };
  }
  const post = safeCivitaiPostUrl(input);
  if (post) return { ok: true, value: { postId: post.postId, imageRef: post.href } };
  if (isCivitaiSiteUrl(input)) {
    const url = new URL(input);
    const idMatch = url.pathname.match(/^\/images\/(\d+)\/?$/) ?? url.search.match(/[?&]imageId=(\d+)/);
    const imageId = idMatch ? Number(idMatch[1]) : 0;
    if (imageId > 0 && Number.isSafeInteger(imageId)) return { ok: true, value: { imageId, imageRef: url.href } };
    return { ok: false, error: NOT_A_CIVITAI_REFERENCE };
  }
  const media = safeCivitaiMediaUrl(input);
  if (media) return { ok: true, value: { imageRef: media } };
  return { ok: false, error: NOT_A_CIVITAI_REFERENCE };
}

/** True when a stored reference is a Civitai post link (parsed host + `/posts/<digits>`), not a single image. */
export function isPostReference(imageRef: string): boolean {
  return safeCivitaiPostUrl(imageRef) != null;
}

/**
 * Whether `imageRef` may be WRITTEN to shared storage. With an `imageId` the
 * item is shown through the host's gated read, so the ref is only a label: a
 * bare id, a Civitai page URL or a Civitai media URL. Without one the ref is
 * what viewers see, so it must render as a Civitai image or post link
 * (./civitai-url.ts `imageRefDisplay`) or be a bare id (shown as text).
 */
function isStorableImageRef(imageRef: string, imageId: number | undefined): boolean {
  if (imageRef === '' && imageId != null) return true;
  if (/^\d+$/.test(imageRef)) return true;
  if (imageId != null) return isCivitaiSiteUrl(imageRef) || safeCivitaiMediaUrl(imageRef) != null;
  return imageRefDisplay(imageRef).kind !== 'unavailable';
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
  if (input.imageId != null && !(Number.isSafeInteger(input.imageId) && input.imageId > 0)) {
    return { ok: false, error: NOT_A_CIVITAI_REFERENCE };
  }
  if (!isStorableImageRef(input.imageRef.trim(), input.imageId)) {
    return { ok: false, error: NOT_A_CIVITAI_REFERENCE };
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

/** Same frozen record: the id AND what it froze (dataset, trainer, time, items, weights). */
function sameFrozenSnapshot(a: DatasetSnapshot, b: DatasetSnapshot): boolean {
  if (
    a.snapshotId !== b.snapshotId ||
    a.datasetId !== b.datasetId ||
    a.trainerId !== b.trainerId ||
    a.createdAt !== b.createdAt ||
    a.totalWeight !== b.totalWeight ||
    a.items.length !== b.items.length
  ) {
    return false;
  }
  return a.items.every((item, i) => {
    const other = b.items[i]!;
    return (
      item.itemId === other.itemId &&
      item.contributorId === other.contributorId &&
      item.weight === other.weight &&
      item.included === other.included
    );
  });
}

/**
 * Whether persisting `snapshot` must create it, may skip it (this exact frozen
 * snapshot is already stored — a re-click), or must refuse: a stored snapshot
 * with the same id that froze something else would otherwise be silently
 * adopted, and this run's fee split across ITS contributors.
 */
export function snapshotPersistAction(
  stored: readonly DatasetSnapshot[],
  snapshot: DatasetSnapshot,
): 'create' | 'already-stored' | 'conflict' {
  const sameId = stored.filter((s) => s.snapshotId === snapshot.snapshotId);
  if (sameId.length === 0) return 'create';
  return sameId.every((s) => sameFrozenSnapshot(s, snapshot)) ? 'already-stored' : 'conflict';
}

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
      imageRef: 'https://orchestration.civitai.com/v2/consumer/blobs/archive-ink-a',
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
      imageRef: 'https://orchestration.civitai.com/v2/consumer/blobs/archive-ink-b',
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
      imageRef: 'https://orchestration.civitai.com/v2/consumer/blobs/archive-ink-c',
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
