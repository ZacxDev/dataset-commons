// Dataset Commons — community data core for the remaining screens (voting
// option (b), decided by Zacx 2026-10-06).
//
// The platform's shared store has a native UP-vote only. The spec needs net
// votes (up − down) on datasets and items, so votes are custom shared records:
// one record per viewer per target, folded client-side. Dataset votes rank
// Explore only; item votes feed inclusion + the vote-weighted split through
// training.ts. Later votes on the live dataset never rewrite a frozen snapshot.
//
// Identity rule (pinned here, not improvised in the UI): shared entries carry a
// numeric `authorUserId`. Community records keep that numeric id as the person
// key, and snapshot contributor ids use the stable string form `user:<id>` so
// training.ts's string-keyed share math stays intact. Display names travel as
// separate name fields and are never used as identity.

import {
  creditLedgerEvent,
  deriveContributorCredits,
  parseDataSource,
  type DatasetItem,
  type DatasetSnapshot,
  type LedgerEvent,
  type TrainingDataSource,
} from './training.js';

export type VoteValue = -1 | 0 | 1;
export type VoteTargetKind = 'dataset' | 'item';

export const ONSITE_EARNINGS_LINE =
  "Onsite generations aren't reported to apps yet — tracked here when the platform exposes them.";

export const COSMETIC_TRUST_LINE =
  'Shared-storage standings are cosmetic-trust, not anti-cheat grade.';

/** The minimal shape of a shared-store entry this core folds. */
export interface SharedEntryLike {
  key: string;
  authorUserId: number;
  value: { title: string; body?: string; data?: unknown };
  createdAt: Date | string;
  updatedAt: Date | string;
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

export interface VoteRecord {
  storageKey?: string;
  voterId: number;
  targetKind: VoteTargetKind;
  targetId: string;
  value: VoteValue;
  updatedAt: string;
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

function voteValue(v: unknown): VoteValue | null {
  return v === 1 || v === -1 || v === 0 ? v : null;
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
    const data = asRecord(entry.value?.data);
    if (!data) continue;
    const kind = str(data.kind);
    const at = entryTime(entry);

    if (kind === 'dataset') {
      const datasetId = str(data.datasetId);
      if (!datasetId) continue;
      datasets.push({
        storageKey: entry.key,
        datasetId,
        ownerId: num(data.ownerId) ?? entry.authorUserId,
        ownerName: str(data.ownerName) || entry.value.title || 'unknown',
        name: str(data.name) || entry.value.title,
        description: str(data.description) || entry.value.body || '',
        targetNote: str(data.targetNote),
        createdAt: iso(data.createdAt) || iso(entry.createdAt),
        updatedAt: iso(data.updatedAt) || at,
      });
    } else if (kind === 'item') {
      const itemId = str(data.itemId);
      const datasetId = str(data.datasetId);
      if (!itemId || !datasetId) continue;
      const imageId = num(data.imageId);
      items.push({
        storageKey: entry.key,
        itemId,
        datasetId,
        contributorId: num(data.contributorId) ?? entry.authorUserId,
        contributorName: str(data.contributorName) || 'unknown',
        ...(imageId != null && imageId > 0 ? { imageId: Math.trunc(imageId) } : {}),
        imageRef: str(data.imageRef) || str(data.imageUrl),
        caption: str(data.caption) || entry.value.title,
        rightsAsserted: data.rightsAsserted === true,
        createdAt: iso(data.createdAt) || iso(entry.createdAt),
        updatedAt: iso(data.updatedAt) || at,
      });
    } else if (kind === 'vote') {
      const targetId = str(data.targetId);
      const targetKind = str(data.targetKind);
      const value = voteValue(data.value);
      if (!targetId || (targetKind !== 'dataset' && targetKind !== 'item') || value === null) continue;
      votes.push({
        storageKey: entry.key,
        voterId: num(data.voterId) ?? entry.authorUserId,
        targetKind,
        targetId,
        value,
        updatedAt: iso(data.updatedAt) || at,
      });
    } else if (kind === 'snapshot') {
      const snap = asRecord(data.snapshot);
      if (!snap || typeof snap.snapshotId !== 'string' || !Array.isArray(snap.items)) continue;
      const snapshot = snap as unknown as DatasetSnapshot;
      snapshots.push(snapshot);
      const prev = snapshotStorageKeys.get(snapshot.snapshotId);
      if (!prev || entry.key > prev) snapshotStorageKeys.set(snapshot.snapshotId, entry.key);
    } else if (kind === 'lora') {
      const loraId = str(data.loraId);
      if (!loraId) continue;
      const modelId = num(data.modelId);
      const modelVersionId = num(data.modelVersionId);
      const dataSource = parseDataSource(data.dataSource);
      loras.push({
        storageKey: entry.key,
        loraId,
        datasetId: str(data.datasetId),
        snapshotId: str(data.snapshotId),
        trainerId: num(data.trainerId) ?? entry.authorUserId,
        trainerName: str(data.trainerName) || 'unknown',
        name: str(data.name) || entry.value.title,
        ...(str(data.workflowId) ? { workflowId: str(data.workflowId) } : {}),
        ...(modelId != null ? { modelId: Math.trunc(modelId) } : {}),
        ...(modelVersionId != null ? { modelVersionId: Math.trunc(modelVersionId) } : {}),
        published: data.published === true,
        ...(dataSource ? { dataSource } : {}),
        createdAt: iso(data.createdAt) || iso(entry.createdAt),
        updatedAt: iso(data.updatedAt) || at,
      });
    } else if (kind === 'ledger') {
      const ev = asRecord(data.event);
      if (!ev || typeof ev.eventId !== 'string' || typeof ev.sourceRef !== 'string') continue;
      const { dataSource: rawSource, ...rest } = ev;
      const dataSource = parseDataSource(rawSource);
      const event = { ...rest, ...(dataSource ? { dataSource } : {}) } as unknown as LedgerEvent;
      if (
        event.eventType !== 'training' &&
        event.eventType !== 'generation_in_app' &&
        event.eventType !== 'generation_onsite'
      ) {
        continue;
      }
      ledgerEvents.push(event);
    } else if (kind === 'item-removal') {
      const itemId = str(data.itemId);
      if (!itemId) continue;
      removals.push({
        storageKey: entry.key,
        itemId,
        datasetId: str(data.datasetId),
        actorId: num(data.actorId) ?? entry.authorUserId,
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
    votes: latestBy(
      votes,
      (v) => `${v.voterId}:${v.targetKind}:${v.targetId}`,
      (v) => v.updatedAt,
      (v) => v.storageKey ?? '',
    ),
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

export function tallyVotes(
  votes: readonly VoteRecord[],
  targetKind: VoteTargetKind,
  targetId: string,
  viewerId?: number | null,
): VoteTally {
  let up = 0;
  let down = 0;
  let viewerVote: VoteValue = 0;
  for (const vote of votes) {
    if (vote.targetKind !== targetKind || vote.targetId !== targetId) continue;
    if (vote.value === 1) up += 1;
    else if (vote.value === -1) down += 1;
    if (viewerId != null && vote.voterId === viewerId) viewerVote = vote.value;
  }
  return { up, down, net: up - down, viewerVote };
}

/** Clicking the viewer's current value clears it; any other click replaces it. */
export function nextVoteValue(current: VoteValue, clicked: 1 | -1): VoteValue {
  return current === clicked ? 0 : clicked;
}

/** Pure vote replacement: one record per viewer per target, latest wins. */
export function applyVote(records: readonly VoteRecord[], vote: VoteRecord): VoteRecord[] {
  const rest = records.filter(
    (v) => !(v.voterId === vote.voterId && v.targetKind === vote.targetKind && v.targetId === vote.targetId),
  );
  return [...rest, vote];
}

/** The viewer's own vote record for a target (carries the storage key to update). */
export function viewerVoteRecord(
  votes: readonly VoteRecord[],
  viewerId: number | null,
  targetKind: VoteTargetKind,
  targetId: string,
): VoteRecord | null {
  if (viewerId == null) return null;
  return votes.find((v) => v.voterId === viewerId && v.targetKind === targetKind && v.targetId === targetId) ?? null;
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

export function buildCommunityView(
  folded: FoldedCommunity,
  viewerId: number | null,
): CommunityView {
  const removedIds = new Set(folded.removals.map((r) => r.itemId));
  const appearances = new Map<string, number>();
  for (const snapshot of folded.snapshots) {
    for (const item of snapshot.items) {
      if (item.included) appearances.set(item.itemId, (appearances.get(item.itemId) ?? 0) + 1);
    }
  }

  const datasets = folded.datasets.map((dataset) => {
    const datasetTally = tallyVotes(folded.votes, 'dataset', dataset.datasetId, viewerId);
    const items = folded.items
      .filter((item) => item.datasetId === dataset.datasetId)
      .map((item) => {
        const tally = tallyVotes(folded.votes, 'item', item.itemId, viewerId);
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
  return { ok: true, value: { ...(imageId ? { imageId } : {}), imageRef: url.toString() } };
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
// Shared-store values — title/body carry the moderated, user-visible text;
// `data` carries the structured record the fold reads back.
// ---------------------------------------------------------------------------

export function datasetSharedValue(record: DatasetRecord): { title: string; body?: string; data: unknown } {
  return {
    title: record.name,
    body: record.description || undefined,
    data: { kind: 'dataset', ...record, storageKey: undefined },
  };
}

export function itemSharedValue(record: DatasetItemRecord): { title: string; body?: string; data: unknown } {
  return {
    title: record.caption,
    body: `Dataset ${record.datasetId}`,
    data: { kind: 'item', ...record, storageKey: undefined },
  };
}

export function voteSharedValue(record: VoteRecord): { title: string; body?: string; data: unknown } {
  return {
    title: `Vote ${record.value} on ${record.targetKind} ${record.targetId}`,
    body: `voter ${record.voterId}`,
    data: { kind: 'vote', ...record, storageKey: undefined },
  };
}

export function snapshotSharedValue(
  snapshot: DatasetSnapshot,
  datasetName: string,
): { title: string; body?: string; data: unknown } {
  return {
    title: `Snapshot for ${datasetName}`,
    body: `${snapshot.items.filter((i) => i.included).length} items included`,
    data: { kind: 'snapshot', snapshot },
  };
}

export function loraSharedValue(record: LoraRecord): { title: string; body?: string; data: unknown } {
  return {
    title: record.name,
    body: record.published ? 'Published LoRA' : 'Trained LoRA (unpublished)',
    data: { kind: 'lora', ...record, storageKey: undefined },
  };
}

export function ledgerSharedValue(event: LedgerEvent): { title: string; body?: string; data: unknown } {
  return {
    title: `Ledger ${event.eventType} ${event.grossBuzz} Buzz`,
    body: `LoRA ${event.loraId} · source ${event.sourceRef}`,
    data: { kind: 'ledger', event },
  };
}

export function removalSharedValue(record: ItemRemovalRecord): { title: string; body?: string; data: unknown } {
  return {
    title: `Remove item ${record.itemId}`,
    body: record.reason,
    data: { kind: 'item-removal', ...record, storageKey: undefined },
  };
}

/** A demo seed for the mock harness only — never shipped as production data. */
export function demoSharedSeed(): Array<{ value: { title: string; body?: string; data: unknown }; authorUserId?: number }> {
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
  const votes: VoteRecord[] = [
    { voterId: 21, targetKind: 'item', targetId: 'item-a', value: 1, updatedAt: '2026-10-05T01:00:00.000Z' },
    { voterId: 22, targetKind: 'item', targetId: 'item-a', value: 1, updatedAt: '2026-10-05T01:00:00.000Z' },
    { voterId: 23, targetKind: 'item', targetId: 'item-a', value: 1, updatedAt: '2026-10-05T01:00:00.000Z' },
    { voterId: 24, targetKind: 'item', targetId: 'item-a', value: 1, updatedAt: '2026-10-05T01:00:00.000Z' },
    { voterId: 25, targetKind: 'item', targetId: 'item-a', value: 1, updatedAt: '2026-10-05T01:00:00.000Z' },
    { voterId: 26, targetKind: 'item', targetId: 'item-b', value: 1, updatedAt: '2026-10-05T01:00:00.000Z' },
    { voterId: 27, targetKind: 'dataset', targetId: dataset.datasetId, value: 1, updatedAt: '2026-10-05T01:00:00.000Z' },
    { voterId: 28, targetKind: 'dataset', targetId: dataset.datasetId, value: 1, updatedAt: '2026-10-05T01:00:00.000Z' },
    { voterId: 29, targetKind: 'dataset', targetId: dataset.datasetId, value: 1, updatedAt: '2026-10-05T01:00:00.000Z' },
  ];
  return [
    { value: datasetSharedValue(dataset), authorUserId: dataset.ownerId },
    ...items.map((item) => ({ value: itemSharedValue(item), authorUserId: item.contributorId })),
    ...votes.map((vote) => ({ value: voteSharedValue(vote), authorUserId: vote.voterId })),
  ];
}
