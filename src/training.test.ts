import { RunTrainingError } from '@civitai/blocks-react';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TRAINING_PRESET,
  TRAINING_EPOCHS_BOUNDS,
  TRAINING_KIND_CATALOG,
  TRAINING_PRESETS,
  TRAINING_STEPS_BOUNDS,
  buildPublishWizardPath,
  buildTrainingBody,
  buildTrainingKindBody,
  canAffordQuote,
  clampTrainingEpochs,
  clampTrainingSteps,
  classifyTrainingEstimate,
  classifyTrainingKindQuote,
  contributorShares,
  creditLedgerEvent,
  dataSourceLabel,
  dataSourceOf,
  describeEstimateFailure,
  deriveContributorCredits,
  freezeSnapshot,
  includedItems,
  latestEpoch,
  linkedLoraFromSnapshot,
  trackedTotals,
  trainingFailureCopy,
  trainingFeeEvent,
  pairUploadsWithSnapshot,
  parseDataSource,
  passThroughAvailable,
  TRAINING_KIND_CAPTION_MAX_CHARS,
  TRAINING_KIND_MAX_ITEMS,
  trainingKindBlocker,
  trainingKindParams,
  trainingKindRunFailure,
  trainingStateForSnapshot,
  type DatasetItem,
} from './training.js';

const item = (over: Partial<DatasetItem>): DatasetItem => ({
  itemId: 'i1',
  contributorId: 'alice',
  imageUrl: 'https://image.civitai.com/x/1.jpeg',
  caption: 'a caption',
  netVotes: 3,
  ...over,
});

describe('freezeSnapshot (spec §7.2/§7.3)', () => {
  it('includes net-positive items with weight = net votes, floor 1', () => {
    const snap = freezeSnapshot('ds1', 'trainer', [
      item({ itemId: 'a', netVotes: 5 }),
      item({ itemId: 'b', netVotes: 1, contributorId: 'bob' }),
    ], { snapshotId: 's1', now: '2026-10-06T00:00:00.000Z' });
    expect(snap.totalWeight).toBe(6);
    expect(includedItems(snap).map((i) => i.weight)).toEqual([5, 1]);
    expect(snap.createdAt).toBe('2026-10-06T00:00:00.000Z');
  });

  it('excludes net-zero and net-negative items as net-not-positive', () => {
    const snap = freezeSnapshot('ds1', 'trainer', [
      item({ itemId: 'a', netVotes: 0 }),
      item({ itemId: 'b', netVotes: -3 }),
    ]);
    expect(includedItems(snap)).toHaveLength(0);
    expect(snap.items.map((i) => i.exclusionReason)).toEqual(['net-not-positive', 'net-not-positive']);
    expect(snap.totalWeight).toBe(0);
  });

  it('owner override includes a net-negative item at the floor weight of 1, marked', () => {
    const snap = freezeSnapshot('ds1', 'trainer', [item({ itemId: 'a', netVotes: -2 })], {
      ownerOverrides: ['a'],
    });
    const [only] = includedItems(snap);
    expect(only).toMatchObject({ weight: 1, ownerOverride: true, frozenNetVotes: -2 });
    expect(snap.totalWeight).toBe(1);
  });

  it('manual exclusion wins over net-positive and over an override, recorded as manual', () => {
    const snap = freezeSnapshot('ds1', 'trainer', [item({ itemId: 'a', netVotes: 9 })], {
      manualExclusions: new Set(['a']),
      ownerOverrides: ['a'],
    });
    expect(includedItems(snap)).toHaveLength(0);
    expect(snap.items[0]).toMatchObject({ included: false, exclusionReason: 'manual', weight: 0 });
  });

  it('is frozen: mutating the live items afterwards does not change the snapshot', () => {
    const live = [item({ itemId: 'a', netVotes: 5 })];
    const snap = freezeSnapshot('ds1', 'trainer', live);
    live[0]!.netVotes = -100;
    expect(snap.items[0]!.frozenNetVotes).toBe(5);
    expect(snap.items[0]!.weight).toBe(5);
  });

  it('the spec worked example: A net 5 (X), B net 1 (Y), C floor 1 (X) -> X 6/7, Y 1/7', () => {
    const snap = freezeSnapshot('ds1', 'trainer', [
      item({ itemId: 'A', contributorId: 'X', netVotes: 5 }),
      item({ itemId: 'B', contributorId: 'Y', netVotes: 1 }),
      // C is net 0: included here via owner override so the floor applies, per §7.3.
      item({ itemId: 'C', contributorId: 'X', netVotes: 0 }),
    ], { ownerOverrides: ['C'] });
    expect(snap.totalWeight).toBe(7);
    const shares = contributorShares(snap);
    expect(shares.get('X')).toBeCloseTo(6 / 7);
    expect(shares.get('Y')).toBeCloseTo(1 / 7);
  });
});

describe('deriveContributorCredits (spec §7.4, largest remainder)', () => {
  const snap = freezeSnapshot('ds1', 'trainer', [
    item({ itemId: 'A', contributorId: 'X', netVotes: 5 }),
    item({ itemId: 'B', contributorId: 'Y', netVotes: 1 }),
    item({ itemId: 'C', contributorId: 'X', netVotes: 0 }),
  ], { ownerOverrides: ['C'], snapshotId: 's-worked' });

  it('credits sum EXACTLY to the gross, split vote-weighted', () => {
    const credits = deriveContributorCredits({ grossBuzz: 500 }, snap);
    const total = credits.reduce((s, c) => s + c.credit, 0);
    expect(total).toBe(500);
    const byId = new Map(credits.map((c) => [c.contributorId, c.credit]));
    // X = 6/7·500 = 428.57 -> 429 (largest remainder), Y = 1/7·500 = 71.43 -> 71.
    expect(byId.get('X')).toBe(429);
    expect(byId.get('Y')).toBe(71);
  });

  it('a single-contributor snapshot credits them everything', () => {
    const solo = freezeSnapshot('ds1', 'trainer', [item({ itemId: 'a', contributorId: 'solo', netVotes: 2 })]);
    expect(deriveContributorCredits({ grossBuzz: 725 }, solo)).toEqual([
      { contributorId: 'solo', credit: 725, share: 1 },
    ]);
  });

  it('zero gross credits zero to everyone; empty snapshot credits nobody', () => {
    expect(deriveContributorCredits({ grossBuzz: 0 }, snap).every((c) => c.credit === 0)).toBe(true);
    const empty = freezeSnapshot('ds1', 'trainer', [item({ netVotes: -1 })]);
    expect(deriveContributorCredits({ grossBuzz: 500 }, empty)).toEqual([]);
  });

  it('all-floor weights split evenly-ish and still sum to gross', () => {
    const floors = freezeSnapshot('ds1', 'trainer', [
      item({ itemId: 'a', contributorId: 'p', netVotes: 0 }),
      item({ itemId: 'b', contributorId: 'q', netVotes: 0 }),
      item({ itemId: 'c', contributorId: 'r', netVotes: 0 }),
    ], { ownerOverrides: ['a', 'b', 'c'] });
    const credits = deriveContributorCredits({ grossBuzz: 100 }, floors);
    expect(credits.reduce((s, c) => s + c.credit, 0)).toBe(100);
    expect(credits.map((c) => c.credit).sort()).toEqual([33, 33, 34]);
  });
});

describe('ledger events', () => {
  const snap = freezeSnapshot('ds1', 'trainer', [item({ itemId: 'a', netVotes: 4 })], { snapshotId: 's1' });

  it('trainingFeeEvent keys the event to the workflow id (dedupe source)', () => {
    const ev = trainingFeeEvent({ snapshot: snap, workflowId: 'wf_1', grossBuzz: 512.4, dataSource: 'snapshot', now: '2026-10-06T00:00:00.000Z' });
    expect(ev).toMatchObject({
      eventType: 'training',
      sourceRef: 'wf_1',
      snapshotId: 's1',
      grossBuzz: 512,
      loraId: 'lora_wf_1',
    });
  });

  it('creditLedgerEvent credits the same sourceRef once only (no double-credit)', () => {
    const ev = trainingFeeEvent({ snapshot: snap, workflowId: 'wf_1', grossBuzz: 500, dataSource: 'snapshot' });
    const first = creditLedgerEvent([], ev);
    expect(first.credited).toBe(true);
    const second = creditLedgerEvent(first.events, ev);
    expect(second.credited).toBe(false);
    expect(second.events).toHaveLength(1);
    // A DIFFERENT event type against the same workflow is not a dupe.
    const gen = { ...ev, eventId: 'ledger_generation_wf_1', eventType: 'generation_in_app' as const };
    expect(creditLedgerEvent(first.events, gen).credited).toBe(true);
  });

  it('trackedTotals aggregates derived credits per contributor across events', () => {
    const multi = freezeSnapshot('ds1', 'trainer', [
      item({ itemId: 'A', contributorId: 'X', netVotes: 3 }),
      item({ itemId: 'B', contributorId: 'Y', netVotes: 1 }),
    ], { snapshotId: 's2' });
    const events = [
      trainingFeeEvent({ snapshot: multi, workflowId: 'wf_1', grossBuzz: 400, dataSource: 'snapshot' }),
      { ...trainingFeeEvent({ snapshot: multi, workflowId: 'wf_2', grossBuzz: 400, dataSource: 'snapshot' }), eventType: 'generation_in_app' as const, eventId: 'e2' },
    ];
    const totals = trackedTotals(events, new Map([['s2', multi]]));
    expect(totals.get('X')).toBe(600);
    expect(totals.get('Y')).toBe(200);
    // Events whose snapshot is unknown are skipped, never guessed.
    const orphan = trainingFeeEvent({ snapshot: multi, workflowId: 'wf_9', grossBuzz: 100, dataSource: 'snapshot' });
    expect(trackedTotals([orphan], new Map()).size).toBe(0);
  });
});

describe('training data source (trainer attestation)', () => {
  const snap = freezeSnapshot('ds1', 'trainer', [item({ itemId: 'a', netVotes: 4 })], { snapshotId: 's1' });

  it('trainingFeeEvent records the source it is given', () => {
    expect(trainingFeeEvent({ snapshot: snap, workflowId: 'wf_k', grossBuzz: 725, dataSource: 'trainer-attested' }).dataSource).toBe(
      'trainer-attested',
    );
    expect(trainingFeeEvent({ snapshot: snap, workflowId: 'wf_p', grossBuzz: 512, dataSource: 'snapshot' }).dataSource).toBe('snapshot');
  });

  it('a record without the field (written before it existed) reads as snapshot, with no label', () => {
    expect(dataSourceOf({})).toBe('snapshot');
    expect(dataSourceLabel({})).toBeNull();
    expect(dataSourceOf({ dataSource: 'snapshot' })).toBe('snapshot');
    expect(dataSourceLabel({ dataSource: 'snapshot' })).toBeNull();
    expect(dataSourceOf({ dataSource: 'trainer-attested' })).toBe('trainer-attested');
    expect(dataSourceLabel({ dataSource: 'trainer-attested' })).toBe('Trainer-attested uploads');
  });

  it('parseDataSource keeps only the two known values from unmoderated storage', () => {
    expect(parseDataSource('snapshot')).toBe('snapshot');
    expect(parseDataSource('trainer-attested')).toBe('trainer-attested');
    expect(parseDataSource(undefined)).toBeUndefined();
    expect(parseDataSource('verified')).toBeUndefined();
    expect(parseDataSource(1)).toBeUndefined();
  });
});

describe('buildTrainingBody (the #541 pass-through shape)', () => {
  // The `{ air, caption }` pairs a `trainingData` upload + pairUploadsWithSnapshot produce.
  const dataset = [
    { air: 'k1', caption: 'one' },
    { air: 'k2', caption: 'two' },
  ];

  it('builds kind:step / $type:training with maxBuzz 1 and a blobs dataset', () => {
    const body = buildTrainingBody(dataset, {
      preset: DEFAULT_TRAINING_PRESET,
      triggerWord: 'mytok',
      steps: 2000,
      epochs: 10,
      samplePrompt: '',
    });
    expect(body.kind).toBe('step');
    expect(body.$type).toBe('training');
    expect(body.maxBuzz).toBe(1);
    expect(body.input).toMatchObject({
      engine: 'ai-toolkit',
      ecosystem: 'sdxl',
      model: DEFAULT_TRAINING_PRESET.modelAir,
      steps: 2000,
      epochs: 10,
      triggerWord: 'mytok',
    });
    expect(body.input.trainingData).toEqual({
      type: 'blobs',
      items: [
        { air: 'k1', caption: 'one' },
        { air: 'k2', caption: 'two' },
      ],
    });
    // Empty sample prompt falls back to the trigger word.
    expect(body.input.samples.prompts).toEqual(['mytok, portrait']);
  });

  it('omits an empty trigger word and uses an explicit sample prompt', () => {
    const body = buildTrainingBody(dataset, {
      preset: DEFAULT_TRAINING_PRESET,
      triggerWord: '  ',
      steps: 100,
      epochs: 2,
      samplePrompt: 'a lighthouse',
    });
    expect(body.input).not.toHaveProperty('triggerWord');
    expect(body.input.samples.prompts).toEqual(['a lighthouse']);
  });

  it('refuses an empty dataset and an unwired preset AIR instead of guessing', () => {
    expect(() =>
      buildTrainingBody([], {
        preset: DEFAULT_TRAINING_PRESET,
        triggerWord: '',
        steps: 1,
        epochs: 1,
        samplePrompt: '',
      }),
    ).toThrow(/empty dataset/);
    const unwired = TRAINING_PRESETS.find((p) => p.modelAir === null)!;
    expect(() =>
      buildTrainingBody(dataset, { preset: unwired, triggerWord: '', steps: 1, epochs: 1, samplePrompt: '' }),
    ).toThrow(/no verified base-model AIR/);
  });
});

describe("steps / epochs bounds (Training Studio's AI_TOOLKIT_EPOCHS and TARGET_STEPS)", () => {
  const items = [{ air: 'k1', caption: 'one' }];
  const sdxl = TRAINING_PRESETS.find((p) => p.id === 'sdxl')!;
  const config = (steps: number, epochs: number) => ({ preset: sdxl, triggerWord: 'tok', steps, epochs, samplePrompt: '' });

  it('pins the bounds to the civitai@dd6d276934 literals', () => {
    expect(TRAINING_EPOCHS_BOUNDS).toEqual({ min: 1, max: 20 });
    expect(TRAINING_STEPS_BOUNDS).toEqual({ min: 1, max: 10000 });
  });

  it('clamps both ends, keeps in-range values, and floors junk to the minimum', () => {
    expect(clampTrainingEpochs(37)).toBe(20);
    expect(clampTrainingEpochs(21)).toBe(20);
    expect(clampTrainingEpochs(13)).toBe(13);
    expect(clampTrainingEpochs(0)).toBe(1);
    expect(clampTrainingEpochs(-5)).toBe(1);
    expect(clampTrainingEpochs(Number.NaN)).toBe(1);
    expect(clampTrainingSteps(25000)).toBe(10000);
    expect(clampTrainingSteps(10001)).toBe(10000);
    expect(clampTrainingSteps(7321)).toBe(7321);
    expect(clampTrainingSteps(0)).toBe(1);
  });

  it('both run paths send the clamped values, and in-range values unchanged', () => {
    const pass = buildTrainingBody(items, config(25000, 37));
    expect([pass.input.steps, pass.input.epochs]).toEqual([10000, 20]);
    const kind = buildTrainingKindBody({ items, config: config(25000, 37) });
    expect([kind.params.steps, kind.params.epochs]).toEqual([10000, 20]);
    const passMid = buildTrainingBody(items, config(7321, 13));
    expect([passMid.input.steps, passMid.input.epochs]).toEqual([7321, 13]);
    const kindMid = buildTrainingKindBody({ items, config: config(7321, 13) });
    expect([kindMid.params.steps, kindMid.params.epochs]).toEqual([7321, 13]);
  });
});

describe('freezeSnapshot carries image ids', () => {
  it('freezeSnapshot carries Civitai image ids into the frozen record', () => {
    const snap = freezeSnapshot('ds1', 'trainer', [item({ itemId: 'a', imageId: 101 })], {
      snapshotId: 's-image-id',
    });
    expect(snap.items[0]).toMatchObject({ imageId: 101 });
  });
});

describe("Civitai's trainer (kind: 'training', SDK 0.77 items body)", () => {
  const preset = TRAINING_PRESETS.find((p) => p.id === 'flux')!;
  const config = { preset, triggerWord: ' mytok ', steps: 2000, epochs: 10, samplePrompt: '' };
  const snapshotItems = [
    { itemId: 'a', caption: 'front view' },
    { itemId: 'b', caption: 'profile view' },
    { itemId: 'c', caption: 'back view' },
  ];
  const uploads = [
    { url: 'https://civitai.com/v2/consumer/blobs/up-1.png', air: 'up-1.png' },
    { url: 'https://civitai.com/v2/consumer/blobs/up-2.png', air: 'up-2.png' },
    { url: 'https://civitai.com/v2/consumer/blobs/up-3.png', air: 'up-3.png' },
  ];

  it('pairs uploads with snapshot captions by position by default', () => {
    const pairing = pairUploadsWithSnapshot(uploads, snapshotItems);
    expect(pairing.problems).toEqual([]);
    expect(pairing.itemIds).toEqual(['a', 'b', 'c']);
    expect(pairing.items).toEqual([
      { air: 'up-1.png', caption: 'front view' },
      { air: 'up-2.png', caption: 'profile view' },
      { air: 'up-3.png', caption: 'back view' },
    ]);
  });

  it('an explicit assignment moves each caption to the upload it was matched to', () => {
    const pairing = pairUploadsWithSnapshot(uploads, snapshotItems, ['c', 'a', 'b']);
    expect(pairing.problems).toEqual([]);
    expect(pairing.items).toEqual([
      { air: 'up-1.png', caption: 'back view' },
      { air: 'up-2.png', caption: 'front view' },
      { air: 'up-3.png', caption: 'profile view' },
    ]);
  });

  it('refuses a count mismatch, a double match, a duplicate blob and an unmatched upload — never a subset', () => {
    expect(pairUploadsWithSnapshot(uploads.slice(0, 2), snapshotItems)).toEqual({
      items: [],
      itemIds: ['a', 'b'],
      problems: ['You uploaded 2 images, but the training set has 3. Upload exactly the 3 images listed.'],
    });
    expect(pairUploadsWithSnapshot(uploads, snapshotItems, ['a', 'a', 'c']).problems).toEqual([
      'Training-set image #1 is matched to both upload #1 and upload #2.',
    ]);
    const dupe = [uploads[0]!, { ...uploads[1]!, air: 'UP-1.PNG' }, uploads[2]!];
    expect(pairUploadsWithSnapshot(dupe, snapshotItems).problems).toEqual([
      'Upload #2 is the same file as upload #1.',
    ]);
    expect(pairUploadsWithSnapshot(uploads, snapshotItems, ['a', '', 'c']).problems).toEqual([
      'Upload #2 is not matched to an image in the training set.',
    ]);
  });

  it('caps the set at 50 and captions at 8192 characters (the 0.77 host bounds)', () => {
    expect(TRAINING_KIND_MAX_ITEMS).toBe(50);
    expect(TRAINING_KIND_CAPTION_MAX_CHARS).toBe(8192);
    expect(trainingKindBlocker(0)).toMatch(/No items/);
    expect(trainingKindBlocker(50)).toBeNull();
    expect(trainingKindBlocker(51)).toMatch(/at most 50/);
    const long = [{ itemId: 'a', caption: 'x'.repeat(8193) }];
    expect(pairUploadsWithSnapshot([uploads[0]!], long).problems).toEqual([
      "Training-set image #1's caption is longer than 8192 characters.",
    ]);
    expect(pairUploadsWithSnapshot([uploads[0]!], [{ itemId: 'a', caption: 'x'.repeat(8192) }]).problems).toEqual([]);
  });

  it('builds the items body from the upload result + captions (no datasetId, no quoteId)', () => {
    const { items } = pairUploadsWithSnapshot(uploads, snapshotItems, ['b', 'c', 'a']);
    const body = buildTrainingKindBody({ items, config });
    expect(body).toEqual({
      kind: 'training',
      items: [
        { air: 'up-1.png', caption: 'profile view' },
        { air: 'up-2.png', caption: 'back view' },
        { air: 'up-3.png', caption: 'front view' },
      ],
      engine: 'ai-toolkit',
      model: 'flux_dev',
      // Training Studio's flux_dev defaults (PARAM_DEFAULTS at civitai@dd6d276934);
      // steps/epochs are the trainer's own choice from the config.
      params: {
        engine: 'ai-toolkit',
        ecosystem: 'flux1',
        modelVariant: 'dev',
        steps: 2000,
        epochs: 10,
        batchSize: 1,
        resolution: 512,
        lr: 0.0005,
        textEncoderLr: 0,
        trainTextEncoder: false,
        lrScheduler: 'cosine',
        optimizerType: 'adamw8bit',
        networkDim: 32,
        networkAlpha: 16,
        noiseOffset: 0.1,
        minSnrGamma: null,
        flipAugmentation: false,
        shuffleTokens: false,
        keepTokens: 0,
      },
      triggerWord: 'mytok',
      samplePrompts: ['mytok, portrait'],
    });
  });

  it('SDXL: the items body carries the upload airs + captions verbatim and no datasetId (0.77 contract)', () => {
    const sdxl = TRAINING_PRESETS.find((p) => p.id === 'sdxl')!;
    const body = buildTrainingKindBody({
      items: [
        { air: 'blobA.png', caption: 'one' },
        { air: 'blobB.png', caption: 'two' },
      ],
      config: { ...config, preset: sdxl },
    });
    expect(body.items).toEqual([
      { air: 'blobA.png', caption: 'one' },
      { air: 'blobB.png', caption: 'two' },
    ]);
    expect(body).toMatchObject({ kind: 'training', model: 'sdxl', params: { ecosystem: 'sdxl', resolution: 1024 } });
    expect(body).not.toHaveProperty('datasetId');
  });

  it('the kind:training catalog is exactly the civitai@dd6d276934 accepted set (a drift is a deliberate edit)', () => {
    // Every own key of trainingModelInfo that is enabled, has an aiToolkit
    // config, trains an IMAGE type, and whose ecosystem the wire schema accepts
    // (hidream_o1 is excluded by that last gate) — in source order.
    expect(TRAINING_KIND_CATALOG.map((m) => [m.model, m.arm.ecosystem, m.arm.modelVariant ?? null, m.pretty])).toEqual([
      ['sd_1_5', 'sd1', null, 'SD 1.5'],
      ['anime', 'sd1', null, 'Anime'],
      ['semi', 'sd1', null, 'Semi Real'],
      ['realistic', 'sd1', null, 'Realistic'],
      ['sdxl', 'sdxl', null, 'SDXL'],
      ['pony', 'sdxl', null, 'Pony'],
      ['illustrious', 'sdxl', null, 'Illustrious'],
      ['flux_dev', 'flux1', 'dev', 'Flux'],
      ['chroma', 'chroma', null, 'Chroma'],
      ['qwen_image', 'qwen', null, 'Qwen-Image'],
      ['zimageturbo', 'zimageturbo', null, 'ZImageTurbo'],
      ['zimagebase', 'zimagebase', null, 'ZImageBase'],
      ['ernie', 'ernie', null, 'Ernie'],
      ['anima', 'anima', null, 'Anima Base v1.0'],
      ['boogu', 'boogu', null, 'Boogu Image 0.1 Base'],
      ['krea2', 'krea2', null, 'Krea 2'],
      ['mageflow', 'mageflow', null, 'Mage-Flow 4B Base'],
      ['ideogram4', 'ideogram4', null, 'Ideogram 4.0'],
      ['flux2klein_4b', 'flux2klein', '4b', 'Flux.2 Klein 4B Base'],
      ['flux2klein_9b', 'flux2klein', '9b', 'Flux.2 Klein 9B Base'],
      ['ming', 'ming', null, 'Ming Image Design 0.1'],
      ['qwen21', 'qwen21', null, 'Qwen 2.1'],
    ]);
    // Video, audio, disabled, no-aiToolkit and schema-refused keys stay out.
    const keys = new Set(TRAINING_KIND_CATALOG.map((m) => m.model));
    for (const refused of ['hidream_o1', 'flux2_dev', 'wan_2_1_i2v_14b_720p', 'wan_2_2_t2v_a14b', 'ltx2', 'minimaxh3', 'yue2', 'acestep_15']) {
      expect(keys.has(refused)).toBe(false);
    }
  });

  it('every preset is one catalog model; the old preset ids are kept, and only SDXL runs the pass-through step', () => {
    expect(TRAINING_PRESETS.map((p) => p.trainingKind.model)).toEqual(TRAINING_KIND_CATALOG.map((m) => m.model));
    const byModel = Object.fromEntries(TRAINING_PRESETS.map((p) => [p.trainingKind.model, p.id]));
    expect(byModel).toMatchObject({
      sdxl: 'sdxl',
      pony: 'pony',
      illustrious: 'illustrious',
      sd_1_5: 'sd15',
      flux_dev: 'flux',
      qwen_image: 'qwen',
      chroma: 'chroma',
      anima: 'anima',
    });
    expect(new Set(TRAINING_PRESETS.map((p) => p.id)).size).toBe(TRAINING_PRESETS.length);
    expect(TRAINING_PRESETS.filter(passThroughAvailable).map((p) => p.id)).toEqual(['sdxl']);
    expect(DEFAULT_TRAINING_PRESET.id).toBe('sdxl');
    // Price hints exist only where #541 quoted one; the new models carry none.
    expect(TRAINING_PRESETS.filter((p) => p.approxBuzz != null).map((p) => p.id)).toEqual([
      'sd15', 'sdxl', 'pony', 'illustrious', 'flux', 'chroma', 'qwen',
    ]);
  });

  it("each model's params are Training Studio's defaults (spot values pinned per family)", () => {
    const params = (model: string) =>
      trainingKindParams(TRAINING_KIND_CATALOG.find((m) => m.model === model)!, 7, 3);
    expect(params('sdxl')).toMatchObject({
      ecosystem: 'sdxl', steps: 7, epochs: 3, batchSize: 4, resolution: 1024, lr: 0.0005, textEncoderLr: 0.00005,
      trainTextEncoder: true, optimizerType: 'adafactor', lrScheduler: 'cosine', networkDim: 32, networkAlpha: 32,
      noiseOffset: 0.1, minSnrGamma: 5,
    });
    expect(params('anime')).toMatchObject({ networkDim: 16, textEncoderLr: 0.0001, optimizerType: 'adamw8bit', minSnrGamma: 5 });
    expect(params('realistic')).toMatchObject({ batchSize: 2, resolution: 512 });
    expect(params('zimagebase')).toMatchObject({ lr: 0.000001, optimizerType: 'automagic', lrScheduler: 'cosine', batchSize: 2 });
    expect(params('anima')).toMatchObject({ resolution: 1024, lr: 0.0001, lrScheduler: 'constant', noiseOffset: 0, minSnrGamma: null });
    expect(params('flux2klein_9b')).toMatchObject({ ecosystem: 'flux2klein', modelVariant: '9b', batchSize: 2 });
    expect(params('chroma')).toMatchObject({ networkDim: 2, networkAlpha: 16, trainTextEncoder: false });
    // Studio's step/epoch defaults (versionStepDefault + PARAM_DEFAULTS.epochs).
    const stepEpoch = Object.fromEntries(
      TRAINING_KIND_CATALOG.map((m) => [m.model, [m.defaults.steps, m.defaults.epochs]]),
    );
    expect(stepEpoch).toMatchObject({ sdxl: [2000, 10], flux_dev: [2000, 5], anima: [1500, 5], boogu: [3000, 5], ming: [2000, 5], krea2: [2000, 10] });
  });

  it('invariant: every model satisfies the host rules the SDK type cannot express', () => {
    for (const m of TRAINING_KIND_CATALOG) {
      const p = trainingKindParams(m, 2000, 10);
      // lr must be below 0.1 unless the optimizer is prodigy (none here).
      expect(p.lr, m.model).toBeLessThan(0.1);
      expect(['prodigy', 'prodigy8bit']).not.toContain(p.optimizerType);
      // qwen21 / ming pin batchSize to exactly 1.
      if (m.arm.ecosystem === 'qwen21' || m.arm.ecosystem === 'ming') expect(p.batchSize, m.model).toBe(1);
      expect(p.trainTextEncoder).toBe((p.textEncoderLr ?? 0) > 0);
    }
  });

  it("an empty trigger word is sent as '' (Training Studio's value), never a made-up word", () => {
    const sdxl = TRAINING_PRESETS.find((p) => p.id === 'sdxl')!;
    const body = buildTrainingKindBody({
      items: [{ air: 'k1', caption: 'one' }],
      config: { ...config, preset: sdxl, triggerWord: '   ' },
    });
    expect(body.triggerWord).toBe('');
    expect(body.samplePrompts).toEqual(['portrait']);
  });

  it('refuses to build an empty or over-cap items body instead of sending it', () => {
    expect(() => buildTrainingKindBody({ items: [], config })).toThrow(/1 to 50/);
    const many = Array.from({ length: 51 }, (_, i) => ({ air: `k${i}`, caption: '' }));
    expect(() => buildTrainingKindBody({ items: many, config })).toThrow(/1 to 50/);
  });

  it('classifies a training quote only when the server quote is usable and matches cost', () => {
    const quote = {
      quoteId: `tq_${'a'.repeat(32)}`,
      total: 725,
      imageCount: 2,
      expiresAt: '2026-10-08T20:00:00.000Z',
    };
    expect(classifyTrainingKindQuote({ cost: { total: 725 }, trainingQuote: quote })).toEqual({
      kind: 'quoted',
      quote,
    });
    expect(classifyTrainingKindQuote({ cost: { total: 725 } }).kind).toBe('missing');
    expect(classifyTrainingKindQuote({ cost: { total: 700 }, trainingQuote: quote }).kind).toBe('missing');
    expect(
      classifyTrainingKindQuote({ trainingQuote: { ...quote, total: 5001 } }).kind,
    ).toBe('missing');
  });

  it('run failures keep the money meaning exact: declined, unconfirmed, refused', () => {
    expect(trainingKindRunFailure({ declined: true }).kind).toBe('declined');
    expect(trainingKindRunFailure({ declined: true }).message).toMatch(/no Buzz was charged/);

    const unconfirmed = trainingKindRunFailure({ unconfirmed: true, message: 'submission-unconfirmed' });
    expect(unconfirmed.kind).toBe('unconfirmed');
    expect(unconfirmed.message).toMatch(/may have been charged/);
    expect(unconfirmed.message).toMatch(/will not retry automatically/);

    const refused = trainingKindRunFailure({ refused: true, message: 'daily Buzz cap reached' });
    expect(refused.kind).toBe('refused');
    expect(refused.message).toMatch(/daily Buzz cap reached/);
    expect(refused.message).toMatch(/nothing was charged/);

    expect(trainingKindRunFailure({ signInRequired: true }).kind).toBe('sign-in');
  });

  it('trainingDataNotUploaded (host code) asks for a fresh upload and says nothing was charged', () => {
    const expected = {
      kind: 'not-uploaded',
      message:
        'Civitai no longer has these uploads for this page (for example after a reload). No run was started and no Buzz was charged. Upload the images again, then price the run again.',
    };
    // The SDK's flag, and the bare host code (a RunTrainingError carries both).
    expect(trainingKindRunFailure({ trainingDataNotUploaded: true, message: 'x' })).toEqual(expected);
    expect(trainingKindRunFailure({ code: 'training data not uploaded here' })).toEqual(expected);
    expect(
      trainingKindRunFailure(new RunTrainingError('training data not uploaded here')),
    ).toEqual(expected);
    // ...but unconfirmed still wins: a run that MAY exist is never "re-upload and retry".
    expect(
      trainingKindRunFailure({ trainingDataNotUploaded: true, unconfirmed: true }).kind,
    ).toBe('unconfirmed');
  });
});

describe('buildTrainingBody — pass-through body pinned whole (invariant across the SDK bump)', () => {
  it('SDXL still submits exactly the #541 pass-through body', () => {
    const dataset = [
      { air: 'k1', caption: 'one' },
      { air: 'k2', caption: 'two' },
    ];
    const body = buildTrainingBody(dataset, {
      preset: TRAINING_PRESETS.find((p) => p.id === 'sdxl')!,
      triggerWord: 'mytok',
      steps: 2000,
      epochs: 10,
      samplePrompt: '',
    });
    expect(body).toEqual({
      kind: 'step',
      $type: 'training',
      maxBuzz: 1,
      input: {
        engine: 'ai-toolkit',
        ecosystem: 'sdxl',
        model: 'urn:air:sdxl:checkpoint:civitai:101055@128078',
        steps: 2000,
        epochs: 10,
        triggerWord: 'mytok',
        trainingData: {
          type: 'blobs',
          items: [
            { air: 'k1', caption: 'one' },
            { air: 'k2', caption: 'two' },
          ],
        },
        samples: { prompts: ['mytok, portrait'] },
      },
    });
  });
});

describe('classifyTrainingEstimate (the quote gate)', () => {
  it('cost above maxBuzz is the real quote', () => {
    expect(classifyTrainingEstimate(512, 1)).toEqual({ kind: 'quoted', cost: 512 });
  });

  it('cost EQUAL to maxBuzz means NO quote was obtained — refuse to submit', () => {
    expect(classifyTrainingEstimate(1, 1)).toEqual({ kind: 'unquoted' });
  });

  it('missing / non-finite / below-sentinel costs are missing, never a bargain', () => {
    expect(classifyTrainingEstimate(null, 1)).toEqual({ kind: 'missing' });
    expect(classifyTrainingEstimate(undefined, 1)).toEqual({ kind: 'missing' });
    expect(classifyTrainingEstimate(Number.NaN, 1)).toEqual({ kind: 'missing' });
    expect(classifyTrainingEstimate(0, 1)).toEqual({ kind: 'missing' });
  });

  it('describeEstimateFailure surfaces the message, and the code when present', () => {
    expect(describeEstimateFailure(new Error('orchestrator refused'))).toBe('orchestrator refused');
    const coded = Object.assign(new Error('host refused'), { code: 'TRAINING_UNSUPPORTED' });
    expect(describeEstimateFailure(coded)).toBe('host refused (code: TRAINING_UNSUPPORTED)');
    expect(describeEstimateFailure({ message: 'nope', code: 'X1' })).toBe('nope (code: X1)');
    expect(
      describeEstimateFailure({
        message: 'estimate did not return a usable price (failed) — reason on .snapshot.error',
        code: 'failed',
        snapshot: { error: 'this training run costs 5001 Buzz, above the per-run limit' },
      }),
    ).toBe('this training run costs 5001 Buzz, above the per-run limit (code: failed)');
    expect(describeEstimateFailure({ code: 'ONLY_CODE' })).toBe('estimate failed (code: ONLY_CODE)');
    expect(describeEstimateFailure('plain string failure')).toBe('plain string failure');
    expect(describeEstimateFailure(null)).toBe('the estimate returned no usable cost');
    expect(describeEstimateFailure(undefined)).toBe('the estimate returned no usable cost');
  });
});

describe('canAffordQuote', () => {
  it('compares the quote to the known balance; unknown balance is unknown', () => {
    expect(canAffordQuote(500, 1500)).toBe(true);
    expect(canAffordQuote(500, 499)).toBe(false);
    expect(canAffordQuote(500, null)).toBeNull();
    expect(canAffordQuote(500, undefined)).toBeNull();
  });
});

describe('trainingStateForSnapshot', () => {
  const base = { workflowId: 'wf_1', cost: { total: 500 }, imageUrls: [] as string[] };

  it('pending/processing is running', () => {
    expect(trainingStateForSnapshot({ ...base, status: 'pending' })).toBe('running');
    expect(trainingStateForSnapshot({ ...base, status: 'processing' })).toBe('running');
  });

  it('succeeded WITH epochs is ready-to-publish; WITHOUT epochs is awaiting moderation', () => {
    expect(
      trainingStateForSnapshot({ ...base, status: 'succeeded', trainedEpochs: [{ $type: 'training', epochNumber: 10 }] }),
    ).toBe('ready-to-publish');
    expect(trainingStateForSnapshot({ ...base, status: 'succeeded' })).toBe('awaiting-moderation');
    expect(trainingStateForSnapshot({ ...base, status: 'succeeded', trainedEpochs: [] })).toBe('awaiting-moderation');
  });

  it('publishedModel refines the publish end (draft started vs published)', () => {
    const ready = { ...base, status: 'succeeded' as const, trainedEpochs: [{ $type: 'training' as const, epochNumber: 3 }] };
    expect(
      trainingStateForSnapshot({ ...ready, publishedModel: { modelId: 1, modelVersionId: 2, published: false } }),
    ).toBe('publish-started');
    expect(
      trainingStateForSnapshot({ ...ready, publishedModel: { modelId: 1, modelVersionId: 2, published: true } }),
    ).toBe('published');
  });

  it('terminal failures map to their states', () => {
    expect(trainingStateForSnapshot({ ...base, status: 'failed' })).toBe('failed');
    expect(trainingStateForSnapshot({ ...base, status: 'expired' })).toBe('expired');
    expect(trainingStateForSnapshot({ ...base, status: 'canceled' })).toBe('canceled');
  });
});

describe('publish linkage', () => {
  it('latestEpoch reads the newest epoch or null', () => {
    expect(latestEpoch({ trainedEpochs: [{ $type: 'training', epochNumber: 1 }, { $type: 'training', epochNumber: 10 }] })).toBe(10);
    expect(latestEpoch({})).toBeNull();
    expect(latestEpoch({ trainedEpochs: [] })).toBeNull();
  });

  it('buildPublishWizardPath targets the from-orchestrator wizard route', () => {
    expect(buildPublishWizardPath('wf_1', 10)).toBe('models/train/from-orchestrator?workflowId=wf_1&epoch=10');
    expect(buildPublishWizardPath('wf x', 2)).toContain('workflowId=wf%20x');
  });

  it('linkedLoraFromSnapshot joins the snapshot to the published model version', () => {
    expect(linkedLoraFromSnapshot({ workflowId: 'wf_1' }, 's1')).toBeNull();
    expect(
      linkedLoraFromSnapshot(
        { workflowId: 'wf_1', publishedModel: { modelId: 42, modelVersionId: 84, published: true } },
        's1',
      ),
    ).toEqual({
      loraId: 'lora_wf_1',
      snapshotId: 's1',
      workflowId: 'wf_1',
      modelId: 42,
      modelVersionId: 84,
      published: true,
    });
  });

  it('failure copy states the charge situation; non-failures have no copy', () => {
    expect(trainingFailureCopy('expired')).toMatch(/refunded/);
    expect(trainingFailureCopy('failed', 'boom')).toMatch(/boom/);
    expect(trainingFailureCopy('canceled')).toMatch(/No further Buzz/);
    expect(trainingFailureCopy('running')).toBeNull();
    expect(trainingFailureCopy('published')).toBeNull();
  });
});
