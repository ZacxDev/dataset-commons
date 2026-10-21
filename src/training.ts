// Dataset Commons — in-app LoRA training core (Option A′, 2026-10-06).
//
// Pure logic, no React, no DOM — unit-tested in node (see training.test.ts).
// This is the platform-supported training path documented on
// civitai/civitai-app-starters#541 (status comment 2026-10-06):
//
//   estimate (quote gate) -> consent -> submit `{ kind:'step', $type:'training' }`
//   -> poll -> snapshot.trainedEpochs (after dataset moderation approval)
//   -> navigate viewer to Civitai's model wizard
//      `models/train/from-orchestrator?workflowId=<id>&epoch=<n>` (scope:'site')
//   -> snapshot.publishedModel { modelId, modelVersionId, published }
//
// Hard rules baked in here (never re-derive them in the UI):
//  - The estimate IS the price gate. A quoted step's `cost.total` exceeds
//    `maxBuzz`; an estimate that comes back EQUAL to `maxBuzz` means no quote
//    was obtained, and submitting would run unquoted (stopped after maxBuzz
//    seconds on today's host). classifyTrainingEstimate() refuses that.
//  - The trained checkpoint is NEVER exposed to the app. Nothing here reads a
//    checkpoint url out of `imageUrls` (an older host leaking one there is a
//    host defect, not a contract — SDK README, app-sdk 0.57.0).
//  - Snapshots are immutable. A snapshot freezes included items + their frozen
//    net votes + weights at confirm time; later votes never rewrite it.
//  - Ledger credit is derived from snapshot shares by largest-remainder
//    rounding so per-contributor credits always sum back to the gross amount.
//  - Amounts are tracked credit, never paid/spendable Buzz (locked decision).

import {
  BLOCK_TRAINING_CAPTION_MAX_CHARS,
  BLOCK_TRAINING_DATASET_MAX_ITEMS,
  BLOCK_TRAINING_MAX_BUZZ_PER_RUN,
  type AiToolkitTrainingParams,
  type BlockTrainingDataImage,
  type BlockTrainingDatasetItem,
  type BlockTrainingQuote,
  type BlockWorkflowSnapshot,
  type WorkflowBodyTraining,
} from '@civitai/app-sdk/blocks';

// ---------------------------------------------------------------------------
// Dataset items + uploads
// ---------------------------------------------------------------------------

/** One contributed dataset item as the Train flow sees it. */
export interface DatasetItem {
  itemId: string;
  contributorId: string;
  /** Display name for the contributor (identity stays `contributorId`). */
  contributorName?: string;
  /** Civitai-hosted image url (from `useImageUpload`), or a reference url. */
  imageUrl: string;
  /** Civitai image id when the contribution carries one (own-images training). */
  imageId?: number;
  caption: string;
  /** Live net votes (up − down) at the moment the snapshot is frozen. */
  netVotes: number;
}

/** An uploaded image awaiting its caption / dataset metadata. */
export interface UploadedImage {
  url: string;
  caption: string;
}

/**
 * Extract the blob KEY from a Civitai consumer-blob url — the `air` the
 * training step wants. Mirrors the #541 status comment exactly:
 *   key = url.split('/v2/consumer/blobs/')[1].split('?')[0]
 * Returns null for any url that is not a consumer-blob url, so a caller can
 * refuse it instead of sending the orchestrator a full signed url.
 */
export function blobKeyFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const marker = '/v2/consumer/blobs/';
  const idx = url.indexOf(marker);
  if (idx < 0) return null;
  const rest = url.slice(idx + marker.length);
  const key = rest.split('?')[0]?.split('#')[0] ?? '';
  return key.length > 0 ? key : null;
}

/** The training-step dataset item: a blob key (`air`) + its caption. */
export interface TrainingDataItem {
  air: string;
  caption: string;
}

export interface AssembledDataset {
  items: TrainingDataItem[];
  /** Human-readable reasons an upload was dropped (dup / no blob key / over cap). */
  skipped: string[];
}

/** Server-side dataset cap named on #541 (≤ 1000 items). */
export const MAX_TRAINING_ITEMS = 1000;

/**
 * Assemble the training dataset from uploaded images: blob-key each url,
 * dedupe by key (first caption wins), and cap at MAX_TRAINING_ITEMS.
 * Anything unusable is reported in `skipped`, never silently dropped.
 */
export function assembleTrainingItems(
  uploads: readonly UploadedImage[],
): AssembledDataset {
  const seen = new Set<string>();
  const items: TrainingDataItem[] = [];
  const skipped: string[] = [];
  for (const up of uploads) {
    const key = blobKeyFromUrl(up.url);
    if (!key) {
      skipped.push(`not a Civitai blob url: ${up.url}`);
      continue;
    }
    if (seen.has(key)) {
      skipped.push(`duplicate blob: ${key}`);
      continue;
    }
    if (items.length >= MAX_TRAINING_ITEMS) {
      skipped.push(`over the ${MAX_TRAINING_ITEMS}-item dataset cap: ${key}`);
      continue;
    }
    seen.add(key);
    items.push({ air: key, caption: up.caption ?? '' });
  }
  return { items, skipped };
}

// ---------------------------------------------------------------------------
// Snapshot (spec §7.2) — frozen at confirm time, immutable thereafter
// ---------------------------------------------------------------------------

export interface SnapshotItem {
  itemId: string;
  contributorId: string;
  contributorName?: string;
  imageUrl: string;
  /** Civitai image id when the live item carried one. */
  imageId?: number;
  caption: string;
  /** Net votes frozen at snapshot time. */
  frozenNetVotes: number;
  /** max(frozenNetVotes, 1) for included items; 0 for excluded. */
  weight: number;
  included: boolean;
  /** Why an item is out: 'net-not-positive' | 'manual' — absent when included. */
  exclusionReason?: 'net-not-positive' | 'manual';
  /** Included despite net ≤ 0 by the dataset owner's recorded override. */
  ownerOverride?: boolean;
}

export interface DatasetSnapshot {
  snapshotId: string;
  datasetId: string;
  trainerId: string;
  createdAt: string;
  items: SnapshotItem[];
  /** Sum of included items' weights — the split denominator. */
  totalWeight: number;
}

export interface FreezeOptions {
  /** Item ids the trainer manually excluded on the review screen. */
  manualExclusions?: ReadonlySet<string> | readonly string[];
  /** Item ids the dataset owner overrode IN despite net ≤ 0. */
  ownerOverrides?: ReadonlySet<string> | readonly string[];
  /** Injected for determinism in tests. */
  now?: string;
  /** Injected for determinism in tests. */
  snapshotId?: string;
}

let snapshotSeq = 0;

/**
 * Freeze a snapshot (spec §7.2/§7.3):
 *  - included = net > 0, minus manual exclusions, plus owner overrides.
 *  - weight = max(frozen net votes, 1) for every included item (floor 1, so
 *    every included item earns something); excluded items weigh 0.
 *  - the returned object is the frozen record; later vote changes on the live
 *    dataset never mutate it (the caller stores it as-is).
 */
export function freezeSnapshot(
  datasetId: string,
  trainerId: string,
  items: readonly DatasetItem[],
  options: FreezeOptions = {},
): DatasetSnapshot {
  const manual = new Set(options.manualExclusions ?? []);
  const overrides = new Set(options.ownerOverrides ?? []);
  const snapshotItems: SnapshotItem[] = items.map((item) => {
    const net = Math.trunc(item.netVotes) || 0;
    if (manual.has(item.itemId)) {
      return {
        itemId: item.itemId,
        contributorId: item.contributorId,
        ...(item.contributorName ? { contributorName: item.contributorName } : {}),
        imageUrl: item.imageUrl,
        ...(item.imageId != null ? { imageId: item.imageId } : {}),
        caption: item.caption,
        frozenNetVotes: net,
        weight: 0,
        included: false,
        exclusionReason: 'manual',
      };
    }
    if (net > 0 || overrides.has(item.itemId)) {
      return {
        itemId: item.itemId,
        contributorId: item.contributorId,
        ...(item.contributorName ? { contributorName: item.contributorName } : {}),
        imageUrl: item.imageUrl,
        ...(item.imageId != null ? { imageId: item.imageId } : {}),
        caption: item.caption,
        frozenNetVotes: net,
        weight: Math.max(net, 1),
        included: true,
        ...(net <= 0 ? { ownerOverride: true } : {}),
      };
    }
    return {
      itemId: item.itemId,
      contributorId: item.contributorId,
      ...(item.contributorName ? { contributorName: item.contributorName } : {}),
      imageUrl: item.imageUrl,
      ...(item.imageId != null ? { imageId: item.imageId } : {}),
      caption: item.caption,
      frozenNetVotes: net,
      weight: 0,
      included: false,
      exclusionReason: 'net-not-positive',
    };
  });
  const totalWeight = snapshotItems.reduce((sum, i) => sum + (i.included ? i.weight : 0), 0);
  if (!options.snapshotId) snapshotSeq += 1;
  return {
    snapshotId: options.snapshotId ?? `snap_${snapshotSeq}`,
    datasetId,
    trainerId,
    createdAt: options.now ?? new Date().toISOString(),
    items: snapshotItems,
    totalWeight,
  };
}

/** Included snapshot items only — the ones that go into the training dataset. */
export function includedItems(snapshot: DatasetSnapshot): SnapshotItem[] {
  return snapshot.items.filter((i) => i.included);
}

// ---------------------------------------------------------------------------
// Vote-weighted split (spec §7.3) + ledger derivation (spec §7.4)
// ---------------------------------------------------------------------------

/** contributorId → share of any event (0..1). Sums to 1 when totalWeight > 0. */
export function contributorShares(snapshot: DatasetSnapshot): Map<string, number> {
  const shares = new Map<string, number>();
  if (snapshot.totalWeight <= 0) return shares;
  for (const item of snapshot.items) {
    if (!item.included) continue;
    shares.set(item.contributorId, (shares.get(item.contributorId) ?? 0) + item.weight / snapshot.totalWeight);
  }
  return shares;
}

export type LedgerEventType = 'training' | 'generation_in_app' | 'generation_onsite';

/** One immutable earning event for one LoRA (spec §7.4). */
export interface LedgerEvent {
  eventId: string;
  loraId: string;
  snapshotId: string;
  eventType: LedgerEventType;
  grossBuzz: number;
  /** The platform source id (workflow id / generation id) — the dedupe key. */
  sourceRef: string;
  createdAt: string;
}

/**
 * Build the trainer-fee ledger event for a completed training run.
 * `sourceRef` is the training workflow id, so re-polling / re-deriving the
 * same run can never double-credit (see creditLedgerEvent).
 */
export function trainingFeeEvent(args: {
  snapshot: DatasetSnapshot;
  workflowId: string;
  grossBuzz: number;
  loraId?: string;
  now?: string;
}): LedgerEvent {
  return {
    eventId: `ledger_training_${args.workflowId}`,
    loraId: args.loraId ?? `lora_${args.workflowId}`,
    snapshotId: args.snapshot.snapshotId,
    eventType: 'training',
    grossBuzz: Math.max(0, Math.round(args.grossBuzz)),
    sourceRef: args.workflowId,
    createdAt: args.now ?? new Date().toISOString(),
  };
}

export interface ContributorCredit {
  contributorId: string;
  /** Tracked Buzz credit (integer; largest-remainder, sums to grossBuzz). */
  credit: number;
  share: number;
}

/**
 * Derive per-contributor tracked credit for one event (spec §7.4).
 * Largest-remainder rounding: floor every share × gross, then hand the
 * remaining Buzz to the largest fractional parts, so credits always sum
 * EXACTLY to the gross amount. Ties break by contributor id for determinism.
 */
export function deriveContributorCredits(
  event: Pick<LedgerEvent, 'grossBuzz'>,
  snapshot: DatasetSnapshot,
): ContributorCredit[] {
  const shares = contributorShares(snapshot);
  if (shares.size === 0 || event.grossBuzz <= 0) {
    return [...shares.entries()].map(([contributorId, share]) => ({ contributorId, credit: 0, share }));
  }
  const gross = Math.round(event.grossBuzz);
  const rows = [...shares.entries()].map(([contributorId, share]) => {
    const exact = share * gross;
    return { contributorId, share, credit: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let remainder = gross - rows.reduce((sum, r) => sum + r.credit, 0);
  const byFrac = [...rows].sort((a, b) => b.frac - a.frac || a.contributorId.localeCompare(b.contributorId));
  for (let i = 0; remainder > 0 && byFrac.length > 0; i = (i + 1) % byFrac.length) {
    byFrac[i]!.credit += 1;
    remainder -= 1;
  }
  return rows
    .map(({ contributorId, credit, share }) => ({ contributorId, credit, share }))
    .sort((a, b) => b.credit - a.credit || a.contributorId.localeCompare(b.contributorId));
}

/**
 * Idempotently add an event to a ledger list: an event whose `sourceRef`
 * (per eventType+lora) is already present is NOT added twice. Returns the
 * (possibly unchanged) list plus whether the event was new.
 */
export function creditLedgerEvent(
  events: readonly LedgerEvent[],
  event: LedgerEvent,
): { events: LedgerEvent[]; credited: boolean } {
  const dupe = events.some(
    (e) => e.sourceRef === event.sourceRef && e.eventType === event.eventType && e.loraId === event.loraId,
  );
  if (dupe) return { events: [...events], credited: false };
  return { events: [...events, event], credited: true };
}

/** Total tracked credit per contributor across a set of events + snapshots. */
export function trackedTotals(
  events: readonly LedgerEvent[],
  snapshotsById: ReadonlyMap<string, DatasetSnapshot>,
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const event of events) {
    const snapshot = snapshotsById.get(event.snapshotId);
    if (!snapshot) continue;
    for (const row of deriveContributorCredits(event, snapshot)) {
      totals.set(row.contributorId, (totals.get(row.contributorId) ?? 0) + row.credit);
    }
  }
  return totals;
}

// ---------------------------------------------------------------------------
// Training configuration + workflow body
// ---------------------------------------------------------------------------

/**
 * How one base model runs on Civitai's trainer (`kind: 'training'`): the
 * training-catalog key (`WorkflowBodyTraining.model` — a catalog key, never an
 * AIR) plus the `params.ecosystem` / `params.modelVariant` pair the host checks
 * against that catalog entry, and the training resolution.
 */
type ArmOf<T> = T extends unknown ? Pick<T, Extract<'ecosystem' | 'modelVariant', keyof T>> : never;
export type TrainingKindEcosystem = ArmOf<AiToolkitTrainingParams>;

export interface TrainingKindModel {
  model: string;
  arm: TrainingKindEcosystem;
  resolution: number;
}

export interface TrainingPreset {
  id: string;
  label: string;
  ecosystem: string;
  /**
   * Base checkpoint AIR for the pass-through `training` step (≤ the page's
   * per-call budget), or null when this build has no verified AIR for the
   * preset — the pass-through button is then disabled, never guessed.
   */
  modelAir: string | null;
  /** Indicative Training Studio default price — the ESTIMATE is the real price. */
  approxBuzz: number;
  /** True while the preset's typical price fits the page's 1000-Buzz per-call budget. */
  withinCurrentCap: boolean;
  /** Civitai's trainer (`kind: 'training'`, up to 5000 Buzz), when wired. */
  trainingKind?: TrainingKindModel;
}

/**
 * Base-model presets. Prices are Training Studio defaults quoted on #541; they
 * are display hints only — the estimate is the price. Only SDXL carries a
 * verified AIR for the pass-through step (the one the platform's own #541
 * example submits). Every preset can run on Civitai's trainer
 * (`kind: 'training'`), which is the only path for models priced above the
 * per-call budget (Flux, Qwen, Chroma). The catalog keys mirror Civitai's
 * training catalog; the host refuses an unknown or disabled key at the
 * estimate, and that refusal is shown verbatim.
 */
export const TRAINING_PRESETS: readonly TrainingPreset[] = [
  {
    id: 'sdxl',
    label: 'SDXL',
    ecosystem: 'sdxl',
    modelAir: 'urn:air:sdxl:checkpoint:civitai:101055@128078',
    approxBuzz: 500,
    withinCurrentCap: true,
    trainingKind: { model: 'sdxl', arm: { ecosystem: 'sdxl' }, resolution: 1024 },
  },
  {
    id: 'pony',
    label: 'Pony',
    ecosystem: 'sdxl',
    modelAir: null,
    approxBuzz: 500,
    withinCurrentCap: true,
    trainingKind: { model: 'pony', arm: { ecosystem: 'sdxl' }, resolution: 1024 },
  },
  {
    id: 'illustrious',
    label: 'Illustrious',
    ecosystem: 'sdxl',
    modelAir: null,
    approxBuzz: 500,
    withinCurrentCap: true,
    trainingKind: { model: 'illustrious', arm: { ecosystem: 'sdxl' }, resolution: 1024 },
  },
  {
    id: 'sd15',
    label: 'SD 1.5',
    ecosystem: 'sd1',
    modelAir: null,
    approxBuzz: 500,
    withinCurrentCap: true,
    trainingKind: { model: 'sd_1_5', arm: { ecosystem: 'sd1' }, resolution: 512 },
  },
  {
    id: 'flux',
    label: 'Flux',
    ecosystem: 'flux1',
    modelAir: null,
    approxBuzz: 1160,
    withinCurrentCap: false,
    trainingKind: { model: 'flux_dev', arm: { ecosystem: 'flux1', modelVariant: 'dev' }, resolution: 1024 },
  },
  {
    id: 'qwen',
    label: 'Qwen-Image',
    ecosystem: 'qwen',
    modelAir: null,
    approxBuzz: 1160,
    withinCurrentCap: false,
    trainingKind: { model: 'qwen_image', arm: { ecosystem: 'qwen' }, resolution: 1024 },
  },
  {
    id: 'chroma',
    label: 'Chroma',
    ecosystem: 'chroma',
    modelAir: null,
    approxBuzz: 1160,
    withinCurrentCap: false,
    trainingKind: { model: 'chroma', arm: { ecosystem: 'chroma' }, resolution: 1024 },
  },
];

/** True when the pass-through `training` step can run this preset. */
export function passThroughAvailable(preset: TrainingPreset): boolean {
  return preset.modelAir != null && preset.withinCurrentCap;
}

export const DEFAULT_TRAINING_PRESET: TrainingPreset = TRAINING_PRESETS[0]!;

export interface TrainingConfig {
  preset: TrainingPreset;
  triggerWord: string;
  steps: number;
  epochs: number;
  samplePrompt: string;
}

export const DEFAULT_TRAINING_CONFIG: Omit<TrainingConfig, 'preset'> = {
  triggerWord: '',
  steps: 2000,
  epochs: 10,
  samplePrompt: '',
};

/**
 * Build the pass-through training workflow body the #541 flow submits.
 * `maxBuzz: 1` is deliberate: it is the sentinel floor — a quoted run reserves
 * the real quote (checked against the page's 1000-Buzz per-call budget), and an
 * unquoted run is stopped after 1 second instead of wandering. The quote gate
 * (classifyTrainingEstimate) must pass before this body is submitted.
 */
export function buildTrainingBody(
  dataset: AssembledDataset,
  config: TrainingConfig,
) {
  if (!config.preset.modelAir) {
    throw new Error(`Training preset "${config.preset.id}" has no verified base-model AIR wired in this build.`);
  }
  if (dataset.items.length === 0) {
    throw new Error('Cannot build a training body with an empty dataset.');
  }
  const trigger = config.triggerWord.trim();
  return {
    kind: 'step',
    $type: 'training',
    maxBuzz: 1,
    input: {
      engine: 'ai-toolkit',
      ecosystem: config.preset.ecosystem,
      model: config.preset.modelAir,
      steps: Math.max(1, Math.trunc(config.steps) || 1),
      epochs: Math.max(1, Math.trunc(config.epochs) || 1),
      ...(trigger ? { triggerWord: trigger } : {}),
      trainingData: { type: 'blobs', items: dataset.items },
      samples: {
        prompts: [config.samplePrompt.trim() || (trigger ? `${trigger}, portrait` : 'portrait')],
      },
    },
  } as const;
}

export type TrainingBody = ReturnType<typeof buildTrainingBody>;

// ---------------------------------------------------------------------------
// Civitai's trainer — `kind: 'training'` on images the trainer uploads
// ---------------------------------------------------------------------------
//
// SDK 0.77 contract: the dataset is `items: [{ air, caption }]` (1–50, each
// blob once), and every `air` must be a blob the HOST uploaded for this block
// instance through `useImageUpload({ purpose: 'trainingData' })`. The host
// refuses a quote naming any other blob (`training data not uploaded here`),
// and forgets its uploads on a page reload. Community items live in shared
// storage as images + captions, so the trainer re-uploads the frozen snapshot's
// images and each upload is matched to one snapshot item, whose frozen caption
// it carries.

export const TRAINING_KIND_MAX_ITEMS = BLOCK_TRAINING_DATASET_MAX_ITEMS;
export const TRAINING_KIND_CAPTION_MAX_CHARS = BLOCK_TRAINING_CAPTION_MAX_CHARS;
export const TRAINING_KIND_MAX_BUZZ = BLOCK_TRAINING_MAX_BUZZ_PER_RUN;

/**
 * Why the snapshot's included set cannot go to Civitai's trainer at all, or
 * null when it can (1…50 included items). The app never trains a silent subset.
 */
export function trainingKindBlocker(includedCount: number): string | null {
  if (includedCount <= 0) return 'No items are in the training set.';
  if (includedCount > TRAINING_KIND_MAX_ITEMS) {
    return `The training set has ${includedCount} images; Civitai's trainer takes at most ${TRAINING_KIND_MAX_ITEMS} per run. Exclude some before uploading.`;
  }
  return null;
}

export interface TrainingKindPairing {
  /** The dataset body, in upload order — empty whenever `problems` is non-empty. */
  items: BlockTrainingDatasetItem[];
  /** The snapshot item each upload was matched to, in upload order. */
  itemIds: string[];
  /** Everything that stops pricing, one sentence each. Empty = ready. */
  problems: string[];
}

/**
 * Pair the host's upload result with the frozen snapshot's included items.
 * `assignment[i]` names the snapshot item upload `i` is (default: the same
 * position, so uploading the numbered images in order needs no extra step).
 * Every included item must be matched exactly once and every upload must carry
 * a distinct blob key; the caption is the snapshot item's frozen caption.
 */
export function pairUploadsWithSnapshot(
  uploads: readonly BlockTrainingDataImage[],
  included: readonly Pick<SnapshotItem, 'itemId' | 'caption'>[],
  assignment: readonly (string | undefined)[] = [],
): TrainingKindPairing {
  const problems: string[] = [];
  const blocker = trainingKindBlocker(included.length);
  if (blocker) problems.push(blocker);
  if (uploads.length !== included.length) {
    problems.push(
      `You uploaded ${uploads.length} image${uploads.length === 1 ? '' : 's'}, but the training set has ${included.length}. Upload exactly the ${included.length} images listed.`,
    );
  }
  const byId = new Map(included.map((item, index) => [item.itemId, { item, index }]));
  const seenKeys = new Map<string, number>();
  const seenItems = new Map<string, number>();
  const itemIds: string[] = [];
  const items: BlockTrainingDatasetItem[] = [];
  uploads.forEach((upload, index) => {
    const n = index + 1;
    const air = typeof upload.air === 'string' ? upload.air.trim() : '';
    if (!air) {
      problems.push(`Upload #${n} came back without a blob key — upload again.`);
    } else {
      const key = air.toLowerCase(); // the host compares keys case-insensitively
      const first = seenKeys.get(key);
      if (first != null) problems.push(`Upload #${n} is the same file as upload #${first}.`);
      else seenKeys.set(key, n);
    }
    const itemId = assignment[index] ?? included[index]?.itemId;
    const match = itemId != null ? byId.get(itemId) : undefined;
    if (!match) {
      problems.push(`Upload #${n} is not matched to an image in the training set.`);
      return;
    }
    const firstUpload = seenItems.get(match.item.itemId);
    if (firstUpload != null) {
      problems.push(`Training-set image #${match.index + 1} is matched to both upload #${firstUpload} and upload #${n}.`);
    } else {
      seenItems.set(match.item.itemId, n);
    }
    if (match.item.caption.length > TRAINING_KIND_CAPTION_MAX_CHARS) {
      problems.push(
        `Training-set image #${match.index + 1}'s caption is longer than ${TRAINING_KIND_CAPTION_MAX_CHARS} characters.`,
      );
    }
    itemIds.push(match.item.itemId);
    items.push({ air, caption: match.item.caption });
  });
  return problems.length > 0 ? { items: [], itemIds, problems } : { items, itemIds, problems };
}

/**
 * Build the `kind: 'training'` body. The estimate sends this exact object
 * WITHOUT a quoteId; the run sends `{ ...body, quoteId }` and changes nothing
 * else (the server checks the run body against the quoted one).
 */
export function buildTrainingKindBody(args: {
  items: readonly BlockTrainingDatasetItem[];
  config: TrainingConfig;
}): WorkflowBodyTraining {
  const kind = args.config.preset.trainingKind;
  if (!kind) {
    throw new Error(`Training preset "${args.config.preset.id}" is not wired for Civitai's trainer in this build.`);
  }
  if (args.items.length === 0 || args.items.length > TRAINING_KIND_MAX_ITEMS) {
    throw new Error(`Civitai's trainer needs 1 to ${TRAINING_KIND_MAX_ITEMS} uploaded images (got ${args.items.length}).`);
  }
  const trigger = args.config.triggerWord.trim() || 'dataset';
  const sample = args.config.samplePrompt.trim() || `${trigger}, portrait`;
  const params: AiToolkitTrainingParams = {
    engine: 'ai-toolkit',
    ...kind.arm,
    steps: Math.max(1, Math.trunc(args.config.steps) || 1),
    epochs: Math.max(1, Math.trunc(args.config.epochs) || 1),
    resolution: kind.resolution,
    lr: 0.0001,
    textEncoderLr: null,
    trainTextEncoder: false,
    lrScheduler: 'cosine',
    optimizerType: 'adamw8bit',
    networkDim: 32,
    networkAlpha: 16,
    noiseOffset: null,
    minSnrGamma: null,
    flipAugmentation: false,
    shuffleTokens: false,
    keepTokens: 0,
  };
  return {
    kind: 'training',
    items: args.items.map((item) => ({ air: item.air, caption: item.caption })),
    engine: 'ai-toolkit',
    model: kind.model,
    params,
    triggerWord: trigger,
    samplePrompts: [sample],
  };
}

export type TrainingKindQuoteClass =
  | { kind: 'quoted'; quote: BlockTrainingQuote }
  | { kind: 'missing'; detail: string };

/**
 * Classify a `kind: 'training'` estimate. The usable price is the server-stored
 * `trainingQuote`, not merely a cost number: without its quoteId the app cannot
 * honestly hand the run to Civitai's consent dialog.
 */
export function classifyTrainingKindQuote(
  snapshot: Pick<BlockWorkflowSnapshot, 'trainingQuote' | 'cost'>,
): TrainingKindQuoteClass {
  const quote = snapshot.trainingQuote;
  if (!quote) {
    return {
      kind: 'missing',
      detail: `The estimate returned no training quote (cost total was ${snapshot.cost?.total ?? 'absent'}).`,
    };
  }
  if (
    !quote.quoteId ||
    !Number.isFinite(quote.total) ||
    quote.total <= 0 ||
    quote.total > TRAINING_KIND_MAX_BUZZ ||
    !Number.isInteger(quote.imageCount) ||
    quote.imageCount < 1
  ) {
    return { kind: 'missing', detail: 'The estimate returned a training quote that is not usable.' };
  }
  if (snapshot.cost?.total != null && Math.round(snapshot.cost.total) !== Math.round(quote.total)) {
    return {
      kind: 'missing',
      detail: `The estimate cost (${snapshot.cost.total}) does not match the training quote (${quote.total}).`,
    };
  }
  return { kind: 'quoted', quote: { ...quote, total: Math.round(quote.total) } };
}

export type TrainingKindRunFailureKind =
  | 'declined'
  | 'unconfirmed'
  | 'not-uploaded'
  | 'refused'
  | 'sign-in'
  | 'error';

export interface TrainingKindRunFailure {
  kind: TrainingKindRunFailureKind;
  message: string;
}

/** The host's refusal code for a quote naming a blob it did not upload here. */
export const TRAINING_DATA_NOT_UPLOADED_CODE = 'training data not uploaded here';

/**
 * Translate a `useRunTraining()` failure into copy that is exact about whether
 * a run or charge may exist. The dangerous class is `unconfirmed`: never call
 * it a failure and never invite an automatic retry.
 */
export function trainingKindRunFailure(error: unknown): TrainingKindRunFailure {
  const record = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const detail = describeEstimateFailure(error);
  if (record.declined === true || record.code === 'declined') {
    return {
      kind: 'declined',
      message: "Civitai's training dialog was dismissed, so no run was submitted and no Buzz was charged.",
    };
  }
  if (record.unconfirmed === true || record.timedOut === true || record.code === 'submission-unconfirmed') {
    return {
      kind: 'unconfirmed',
      message:
        'The training submission is unconfirmed — a run may exist and may have been charged. Check your Civitai trainings before trying again; this app will not retry automatically.',
    };
  }
  if (record.trainingDataNotUploaded === true || record.code === TRAINING_DATA_NOT_UPLOADED_CODE) {
    return {
      kind: 'not-uploaded',
      message:
        "Civitai no longer has these uploads for this page (for example after a reload). No run was started and no Buzz was charged. Upload the images again, then price the run again.",
    };
  }
  if (record.signInRequired === true || record.code === 'sign in to train') {
    return { kind: 'sign-in', message: 'Sign in to train, then price the run again.' };
  }
  if (record.refused === true || record.code === 'refused') {
    return {
      kind: 'refused',
      message: `${detail} No run was started and nothing was charged. Price the run again before retrying.`,
    };
  }
  return {
    kind: 'error',
    message: `${detail} No run was confirmed. Price the run again before retrying.`,
  };
}

// ---------------------------------------------------------------------------
// Quote gate — the estimate decides whether a submit may happen at all
// ---------------------------------------------------------------------------

export type QuoteClass =
  | { kind: 'quoted'; cost: number }
  | { kind: 'unquoted' }
  | { kind: 'missing' };

/**
 * Classify a training estimate (the #541 hard rule):
 *  - cost > maxBuzz  -> the orchestrator quoted the step; cost is the real price.
 *  - cost == maxBuzz -> NO quote was obtained. Do NOT submit: on today's host
 *    the run would be stopped after maxBuzz seconds (run lost, no Buzz lost);
 *    the next host refuses it outright. Either way the app must refuse first.
 *  - cost missing / non-finite -> no usable price; also a refusal.
 * A cost BELOW maxBuzz cannot occur for a quoted training step (quotes exceed
 * the 1-Buzz sentinel); treat it as missing rather than a bargain price.
 */
export function classifyTrainingEstimate(
  costTotal: number | null | undefined,
  maxBuzz: number,
): QuoteClass {
  if (costTotal == null || !Number.isFinite(costTotal)) return { kind: 'missing' };
  if (costTotal > maxBuzz) return { kind: 'quoted', cost: Math.round(costTotal) };
  if (costTotal === maxBuzz) return { kind: 'unquoted' };
  return { kind: 'missing' };
}

/**
 * One-line detail for a failed/unusable estimate, safe to show the viewer and
 * precise enough to report upstream (#541 asks for the actual error): the
 * error's message, plus its `code` when the host attached one.
 */
export function describeEstimateFailure(error: unknown): string {
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (typeof error === 'object' && error !== null) {
    const snapshot = (error as { snapshot?: unknown }).snapshot;
    const snapshotError =
      typeof snapshot === 'object' && snapshot !== null
        ? (snapshot as { error?: unknown }).error
        : undefined;
    const code = (error as { code?: unknown }).code;
    if (typeof snapshotError === 'string' && snapshotError.trim()) {
      return typeof code === 'string' && code
        ? `${snapshotError.trim()} (code: ${code})`
        : snapshotError.trim();
    }
  }
  if (error instanceof Error && error.message.trim()) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && code ? `${error.message} (code: ${code})` : error.message;
  }
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    const code = (error as { code?: unknown }).code;
    if (typeof message === 'string' && message.trim()) {
      return typeof code === 'string' && code ? `${message} (code: ${code})` : message;
    }
    if (typeof code === 'string' && code) return `estimate failed (code: ${code})`;
  }
  return 'the estimate returned no usable cost';
}

/** Can the trainer afford the quoted run on their known balance? null = unknown. */
export function canAffordQuote(
  quoteCost: number,
  balanceTotal: number | null | undefined,
): boolean | null {
  if (balanceTotal == null || !Number.isFinite(balanceTotal)) return null;
  return balanceTotal >= quoteCost;
}

// ---------------------------------------------------------------------------
// Run state from snapshots — moderation, epochs, publish linkage
// ---------------------------------------------------------------------------

export type TrainingRunState =
  | 'estimating'
  | 'awaiting-consent'
  | 'submitting'
  | 'running'
  | 'awaiting-moderation'
  | 'ready-to-publish'
  | 'publish-started'
  | 'published'
  | 'failed'
  | 'expired'
  | 'canceled';

/**
 * Reduce a polled training snapshot to the run state the UI renders.
 * The subtle one is a SUCCEEDED run with no `trainedEpochs`: epochs are only
 * listed for moderation-approved runs, so success-without-epochs means the
 * dataset is still held for moderation — it is NOT a finished, publishable
 * run, and the UI must not offer the wizard until epochs appear.
 * `publishedModel` (once present) refines the publish end of the state.
 */
export function trainingStateForSnapshot(
  snapshot: Pick<BlockWorkflowSnapshot, 'status' | 'trainedEpochs' | 'publishedModel'>,
): TrainingRunState {
  if (snapshot.publishedModel) {
    return snapshot.publishedModel.published ? 'published' : 'publish-started';
  }
  switch (snapshot.status) {
    case 'pending':
    case 'processing':
      return 'running';
    case 'succeeded':
      return snapshot.trainedEpochs && snapshot.trainedEpochs.length > 0
        ? 'ready-to-publish'
        : 'awaiting-moderation';
    case 'failed':
      return 'failed';
    case 'expired':
      return 'expired';
    case 'canceled':
      return 'canceled';
  }
}

/** The newest trained epoch number on a snapshot, or null when none are listed. */
export function latestEpoch(snapshot: Pick<BlockWorkflowSnapshot, 'trainedEpochs'>): number | null {
  const epochs = snapshot.trainedEpochs;
  if (!epochs || epochs.length === 0) return null;
  return epochs[epochs.length - 1]!.epochNumber;
}

/**
 * The Civitai model-wizard path that publishes one trained epoch.
 * Navigate with `{ scope: 'site' }` — the default `'app'` scope would resolve
 * this under the app's own route and never reach the wizard.
 */
export function buildPublishWizardPath(workflowId: string, epochNumber: number): string {
  return `models/train/from-orchestrator?workflowId=${encodeURIComponent(workflowId)}&epoch=${epochNumber}`;
}

/**
 * A LoRA record linked from a published snapshot — the join between the frozen
 * snapshot and the published model version (the key #540 will report onsite
 * earnings against, and the resource in-app test generations attach).
 */
export interface LinkedLora {
  loraId: string;
  snapshotId: string;
  workflowId: string;
  modelId: number | null;
  modelVersionId: number | null;
  published: boolean;
}

export function linkedLoraFromSnapshot(
  snapshot: Pick<BlockWorkflowSnapshot, 'workflowId' | 'publishedModel'>,
  snapshotId: string,
): LinkedLora | null {
  if (!snapshot.publishedModel) return null;
  return {
    loraId: `lora_${snapshot.workflowId}`,
    snapshotId,
    workflowId: snapshot.workflowId,
    modelId: snapshot.publishedModel.modelId,
    modelVersionId: snapshot.publishedModel.modelVersionId,
    published: snapshot.publishedModel.published,
  };
}

/** Failure copy must state whether Buzz was charged (spec §7.5). */
export function trainingFailureCopy(state: TrainingRunState, error?: string | null): string | null {
  switch (state) {
    case 'failed':
      return `Training failed${error ? `: ${error}` : ''}. Whether this run charged Buzz depends on how far it got — the cost shown on this run is what the platform reports; if it shows no cost, the run did not complete a charge.`;
    case 'expired':
      return 'This training run expired (a dataset held for moderation expires after 48 hours) and its reservation was refunded. No Buzz was charged for the expired run.';
    case 'canceled':
      return 'This training run was canceled. No further Buzz will be charged for it.';
    default:
      return null;
  }
}
