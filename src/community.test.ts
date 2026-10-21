import { describe, expect, it } from 'vitest';

import {
  COSMETIC_TRUST_LINE,
  ONSITE_EARNINGS_LINE,
  buildCommunityView,
  buildViewerLedger,
  contributorKey,
  datasetDoc,
  filterAndSortDatasets,
  foldSharedEntries,
  generationLedgerEvent,
  ingestOnsiteLedgerEvent,
  itemDoc,
  ledgerDoc,
  loraDoc,
  makeRecordId,
  markForVote,
  nextVoteValue,
  isPostReference,
  parseImageReference,
  snapshotDoc,
  snapshotShareRows,
  tallyVotes,
  trainingItemsForDataset,
  validateContribution,
  validateDatasetInput,
  voteTarget,
  type DatasetItemRecord,
  type DatasetRecord,
  type LoraRecord,
  type SharedEntryLike,
  type VoteRecord,
  type VoteValue,
} from './community.js';
import { freezeSnapshot, trainingFeeEvent, type LedgerEvent } from './training.js';

const entry = (over: Partial<SharedEntryLike> & Pick<SharedEntryLike, 'collection' | 'data'>): SharedEntryLike => ({
  key: 'shared_1',
  createdAt: '2026-10-06T00:00:00.000Z',
  updatedAt: '2026-10-06T00:00:00.000Z',
  up: 0,
  down: 0,
  viewerVote: 0,
  ...over,
});

const dataset: DatasetRecord = {
  datasetId: 'ds1',
  ownerId: 7,
  ownerName: 'owner',
  name: 'Ink Portraits',
  description: 'desc',
  targetNote: 'SDXL',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

const itemA: DatasetItemRecord = {
  itemId: 'a',
  datasetId: 'ds1',
  contributorId: 11,
  contributorName: 'alice',
  imageId: 101,
  imageRef: 'https://civitai.com/images/101',
  caption: 'front',
  rightsAsserted: true,
  createdAt: '2026-10-01T01:00:00.000Z',
  updatedAt: '2026-10-01T01:00:00.000Z',
};

const itemB: DatasetItemRecord = {
  itemId: 'b',
  datasetId: 'ds1',
  contributorId: 12,
  contributorName: 'bob',
  imageRef: 'https://civitai.com/v2/consumer/blobs/b',
  caption: 'profile',
  rightsAsserted: true,
  createdAt: '2026-10-01T02:00:00.000Z',
  updatedAt: '2026-10-01T02:00:00.000Z',
};

function tally(targetKind: 'dataset' | 'item', targetId: string, up: number, down: number, viewerVote: VoteValue = 0, storageKey = `k-${targetId}`): VoteRecord {
  return { storageKey, targetKind, targetId, up, down, viewerVote };
}

describe('up/down votes as marks (option b)', () => {
  it('tallies the up and down marks and reports the viewer’s own mark', () => {
    const votes = [tally('item', 'a', 2, 1, -1), tally('item', 'b', 1, 0)];
    expect(tallyVotes(votes, 'item', 'a')).toEqual({ up: 2, down: 1, net: 1, viewerVote: -1 });
    expect(tallyVotes(votes, 'item', 'b').viewerVote).toBe(0);
    expect(tallyVotes(votes, 'item', 'zzz')).toEqual({ up: 0, down: 0, net: 0, viewerVote: 0 });
  });

  it('sums the marks of duplicate documents for one target, and votes on the one carrying my mark', () => {
    const votes = [tally('item', 'a', 2, 0, 0, 'k1'), tally('item', 'a', 1, 1, 1, 'k0')];
    expect(tallyVotes(votes, 'item', 'a')).toEqual({ up: 3, down: 1, net: 2, viewerVote: 1 });
    expect(voteTarget(votes, 'item', 'a')?.storageKey).toBe('k0');
    // No mark yet: the newest-keyed document.
    expect(voteTarget([tally('item', 'a', 0, 0, 0, 'k0'), tally('item', 'a', 0, 0, 0, 'k1')], 'item', 'a')?.storageKey).toBe('k1');
    expect(voteTarget(votes, 'item', 'missing')).toBeNull();
  });

  it('clicking the current value clears it; clicking the other replaces it', () => {
    expect(nextVoteValue(1, 1)).toBe(0);
    expect(nextVoteValue(-1, -1)).toBe(0);
    expect(nextVoteValue(1, -1)).toBe(-1);
    expect(nextVoteValue(0, 1)).toBe(1);
  });

  it('a vote value maps to exactly one mark name (the manifest declares `up` and `down`)', () => {
    expect(markForVote(1)).toBe('up');
    expect(markForVote(-1)).toBe('down');
    expect(markForVote(0)).toBeNull();
  });

  it('the fold reads the marks off the dataset/item document itself', () => {
    const folded = foldSharedEntries([
      entry({ key: 'k-a', collection: 'items', data: itemDoc(itemA), up: 4, down: 1, viewerVote: 1 }),
    ]);
    expect(folded.votes).toEqual([tally('item', 'a', 4, 1, 1, 'k-a')]);
  });
});

describe('foldSharedEntries + buildCommunityView', () => {
  const snapshot = freezeSnapshot('ds1', 'trainer', [
    { itemId: 'a', contributorId: contributorKey(11), contributorName: 'alice', imageUrl: itemA.imageRef, caption: 'front', netVotes: 5 },
    { itemId: 'b', contributorId: contributorKey(12), contributorName: 'bob', imageUrl: itemB.imageRef, caption: 'profile', netVotes: 1 },
  ], { snapshotId: 'snap1', now: '2026-10-04T00:00:00.000Z' });

  const lora: LoraRecord = {
    loraId: 'lora_wf1',
    datasetId: 'ds1',
    snapshotId: 'snap1',
    trainerId: 7,
    trainerName: 'owner',
    name: 'Ink Portraits LoRA',
    workflowId: 'wf1',
    modelId: 42,
    modelVersionId: 84,
    published: true,
    createdAt: '2026-10-04T01:00:00.000Z',
    updatedAt: '2026-10-04T01:00:00.000Z',
  };

  const trainingEvent = trainingFeeEvent({ snapshot, workflowId: 'wf1', grossBuzz: 700, loraId: 'lora_wf1', dataSource: 'snapshot' });

  function foldedCommunity() {
    return foldSharedEntries([
      // ds1: one up, one down → net 0. item a: 5 up; item b: 1 up.
      entry({ key: 'k-ds', collection: 'datasets', data: datasetDoc(dataset), up: 1, down: 1 }),
      entry({ key: 'k-a', collection: 'items', data: itemDoc(itemA), up: 5 }),
      entry({ key: 'k-b', collection: 'items', data: itemDoc(itemB), up: 1 }),
      entry({ key: 'k-snap', collection: 'snapshots', data: snapshotDoc(snapshot) }),
      entry({ key: 'k-lora', collection: 'loras', data: loraDoc(lora) }),
      entry({ key: 'k-led', collection: 'ledger', data: ledgerDoc(trainingEvent) }),
      // A duplicate ledger append for the same source event must not double-count.
      entry({ key: 'k-led2', collection: 'ledger', data: ledgerDoc(trainingEvent), updatedAt: '2026-10-04T02:00:00.000Z' }),
      // Junk in each collection is dropped, never thrown.
      entry({ key: 'k-junk1', collection: 'datasets', data: { name: 'no id' } }),
      entry({ key: 'k-junk2', collection: 'items', data: { itemId: 'x' } }),
      entry({ key: 'k-junk3', collection: 'ledger', data: { eventId: 'e', sourceRef: 's', eventType: 'bogus' } }),
      entry({ key: 'k-junk4', collection: 'snapshots', data: 'not an object' }),
    ]);
  }

  it('folds datasets/items/votes/snapshots/loras/ledger and ignores junk records', () => {
    const folded = foldedCommunity();
    expect(folded.datasets).toHaveLength(1);
    expect(folded.items).toHaveLength(2);
    expect(folded.votes).toHaveLength(3); // one tally per dataset/item document
    expect(folded.snapshots).toHaveLength(1);
    expect(folded.loras).toHaveLength(1);
    expect(folded.ledgerEvents).toHaveLength(1);
  });

  it('old LoRA and ledger records without a data source fold unchanged (no field invented)', () => {
    const folded = foldedCommunity();
    expect(folded.loras[0]).not.toHaveProperty('dataSource');
    // trainingEvent above was built with 'snapshot'; an OLD stored event has no field at all.
    const { dataSource: _drop, ...oldEvent } = trainingEvent;
    void _drop;
    const old = foldSharedEntries([entry({ key: 'k-old', collection: 'ledger', data: ledgerDoc(oldEvent as LedgerEvent) })]);
    expect(old.ledgerEvents[0]).not.toHaveProperty('dataSource');
    expect(old.ledgerEvents[0]).toMatchObject({ eventId: trainingEvent.eventId, grossBuzz: 700 });
  });

  it('a trainer-attested LoRA and ledger event keep their source through the fold; an unknown value is dropped', () => {
    const attestedEvent = trainingFeeEvent({ snapshot, workflowId: 'wf2', grossBuzz: 725, loraId: 'lora_wf2', dataSource: 'trainer-attested' });
    const folded = foldSharedEntries([
      entry({ key: 'k-l2', collection: 'loras', data: loraDoc({ ...lora, loraId: 'lora_wf2', workflowId: 'wf2', dataSource: 'trainer-attested' }) }),
      entry({ key: 'k-e2', collection: 'ledger', data: ledgerDoc(attestedEvent) }),
      entry({
        key: 'k-l3',
        collection: 'loras',
        data: { ...loraDoc(lora), loraId: 'lora_wf3', workflowId: 'wf3', dataSource: 'verified-by-me' },
      }),
      entry({
        key: 'k-e3',
        collection: 'ledger',
        data: { ...ledgerDoc(attestedEvent), eventId: 'e3', sourceRef: 'wf3', dataSource: 'verified-by-me' },
      }),
    ]);
    expect(folded.loras.find((l) => l.loraId === 'lora_wf2')).toMatchObject({ dataSource: 'trainer-attested' });
    const unknownLora = folded.loras.find((l) => l.loraId === 'lora_wf3');
    expect(unknownLora).toBeDefined();
    expect(unknownLora).not.toHaveProperty('dataSource');
    expect(folded.ledgerEvents.find((e) => e.eventId === attestedEvent.eventId)).toMatchObject({ dataSource: 'trainer-attested' });
    const unknownEvent = folded.ledgerEvents.find((e) => e.eventId === 'e3');
    expect(unknownEvent).toBeDefined();
    expect(unknownEvent).not.toHaveProperty('dataSource');
  });

  it("an in-app generation event inherits its LoRA's attested source", () => {
    expect(
      generationLedgerEvent({ lora: { loraId: 'l', snapshotId: 's', dataSource: 'trainer-attested' }, workflowId: 'g1', grossBuzz: 8 })
        .dataSource,
    ).toBe('trainer-attested');
    expect(generationLedgerEvent({ lora: { loraId: 'l', snapshotId: 's' }, workflowId: 'g2', grossBuzz: 8 })).not.toHaveProperty(
      'dataSource',
    );
  });

  it('dataset votes rank only; item votes drive trainable count and training items', () => {
    const view = buildCommunityView(foldedCommunity());
    const ds = view.datasets[0]!;
    expect(ds.netVotes).toBe(0); // +1 and -1 dataset votes cancel; never in the split
    expect(ds.viewerVote).toBe(0);
    expect(ds.trainableCount).toBe(2);
    expect(ds.loraCount).toBe(1);
    const trainingItems = trainingItemsForDataset(ds);
    expect(trainingItems.map((i) => [i.itemId, i.contributorId, i.netVotes])).toEqual([
      ['a', 'user:11', 5],
      ['b', 'user:12', 1],
    ]);
    expect(trainingItems[0]).toMatchObject({ imageId: 101 });
    expect(trainingItems[1]).not.toHaveProperty('imageId');
  });

  it('snapshot share rows use frozen weights, not live votes', () => {
    const rows = snapshotShareRows(snapshot);
    expect(rows.map((r) => [r.contributorName, r.weight])).toEqual([['alice', 5], ['bob', 1]]);
    expect(rows[0]!.share).toBeCloseTo(5 / 6);
  });

  it('viewer ledger derives tracked credit from the frozen snapshot only', () => {
    const ledger = buildViewerLedger(foldedCommunity(), 11, 'alice');
    expect(ledger.snapshotsIn).toHaveLength(1);
    expect(ledger.rows).toHaveLength(1);
    // 700 split 5:1 -> alice 583, bob 117 (largest remainder); alice sees only hers.
    expect(ledger.rows[0]).toMatchObject({ credit: 583 });
    expect(ledger.totalTracked).toBe(583);
    const bob = buildViewerLedger(foldedCommunity(), 12, 'bob');
    expect(bob.totalTracked).toBe(117);
  });

  it('removed items leave the live training set but stay in frozen snapshots', () => {
    const folded = foldedCommunity();
    folded.removals.push({
      itemId: 'b',
      datasetId: 'ds1',
      actorId: 7,
      reason: 'owner-remove',
      createdAt: '2026-10-05T00:00:00.000Z',
    });
    const view = buildCommunityView(folded);
    const ds = view.datasets[0]!;
    expect(ds.items.find((i) => i.itemId === 'b')?.removed).toBe(true);
    expect(ds.trainableCount).toBe(1);
    expect(trainingItemsForDataset(ds).map((i) => i.itemId)).toEqual(['a']);
    expect(folded.snapshots[0]!.items.find((i) => i.itemId === 'b')?.included).toBe(true);
  });
});

describe('Explore filtering and sorting', () => {
  it('searches name/description/owner/target and sorts by the three modes', () => {
    const folded = foldSharedEntries([
      entry({ key: 'k1', collection: 'datasets', data: datasetDoc(dataset) }),
      entry({
        key: 'k2',
        collection: 'datasets',
        up: 2,
        data: datasetDoc({
          ...dataset,
          datasetId: 'ds2',
          ownerId: 8,
          ownerName: 'zoe',
          name: 'Mecha Parts',
          createdAt: '2026-10-03T00:00:00.000Z',
          updatedAt: '2026-10-03T00:00:00.000Z',
        }),
      }),
      entry({
        key: 'k5',
        collection: 'loras',
        data: loraDoc({
          loraId: 'lora_ds1',
          datasetId: 'ds1',
          snapshotId: 'snap-x',
          trainerId: 7,
          trainerName: 'owner',
          name: 'Ink LoRA',
          published: true,
          createdAt: '2026-10-03T01:00:00.000Z',
          updatedAt: '2026-10-03T01:00:00.000Z',
        }),
      }),
    ]);
    const view = buildCommunityView(folded);
    expect(filterAndSortDatasets(view.datasets, { query: 'mecha' }).map((d) => d.datasetId)).toEqual(['ds2']);
    expect(filterAndSortDatasets(view.datasets, { sort: 'top-voted' }).map((d) => d.datasetId)).toEqual(['ds2', 'ds1']);
    expect(filterAndSortDatasets(view.datasets, { sort: 'newest' }).map((d) => d.datasetId)).toEqual(['ds2', 'ds1']);
    expect(filterAndSortDatasets(view.datasets, { sort: 'most-trained' }).map((d) => d.datasetId)).toEqual(['ds1', 'ds2']);
  });
});

describe('image references and validation', () => {
  it('parses bare ids, image urls, and blob urls; refuses non-Civitai input', () => {
    expect(parseImageReference('101')).toEqual({ ok: true, value: { imageId: 101, imageRef: '101' } });
    expect(parseImageReference('https://civitai.com/images/202')).toMatchObject({ ok: true, value: { imageId: 202 } });
    expect(parseImageReference('https://civitai.com/posts/303')).toMatchObject({ ok: true, value: { postId: 303 } });
    expect(isPostReference('https://civitai.com/posts/303')).toBe(true);
    expect(isPostReference('https://civitai.com/images/202')).toBe(false);
    expect(parseImageReference('https://civitai.com/v2/consumer/blobs/abc')).toEqual({
      ok: true,
      value: { imageRef: 'https://civitai.com/v2/consumer/blobs/abc' },
    });
    expect(parseImageReference('https://example.com/x.jpg').ok).toBe(false);
    expect(parseImageReference('not a url').ok).toBe(false);
    expect(parseImageReference('').ok).toBe(false);
  });

  it('dataset validation requires a name; contribution requires caption + rights', () => {
    expect(validateDatasetInput({ name: ' ', description: '', targetNote: '' }).ok).toBe(false);
    expect(validateDatasetInput({ name: ' X ', description: ' d ', targetNote: ' t ' })).toEqual({
      ok: true,
      value: { name: 'X', description: 'd', targetNote: 't' },
    });
    expect(validateContribution({ imageRef: '101', caption: '', rightsAsserted: true }).ok).toBe(false);
    expect(validateContribution({ imageRef: '101', caption: 'c', rightsAsserted: false }).ok).toBe(false);
    expect(validateContribution({ imageRef: '101', caption: ' c ', rightsAsserted: true })).toEqual({
      ok: true,
      value: { imageRef: '101', caption: 'c' },
    });
  });

  it('record ids are prefixed and unique', () => {
    const a = makeRecordId('dataset');
    const b = makeRecordId('dataset');
    expect(a).toMatch(/^dataset_/);
    expect(a).not.toBe(b);
  });
});

describe('ledger event builders', () => {
  it('generation events are keyed to the workflow id and onsite ingestion is idempotent', () => {
    const gen = generationLedgerEvent({ lora: { loraId: 'l1', snapshotId: 's1' }, workflowId: 'wf9', grossBuzz: 25 });
    expect(gen).toMatchObject({ eventType: 'generation_in_app', sourceRef: 'wf9', grossBuzz: 25 });
    const onsite: LedgerEvent = { ...gen, eventId: 'onsite1', eventType: 'generation_onsite', sourceRef: 'site1' };
    const first = ingestOnsiteLedgerEvent([], onsite);
    expect(first.credited).toBe(true);
    expect(ingestOnsiteLedgerEvent(first.events, onsite).credited).toBe(false);
    // A non-onsite candidate is refused by the onsite ingester.
    expect(ingestOnsiteLedgerEvent([], gen).credited).toBe(false);
  });

  it('keeps the honesty copy exact', () => {
    expect(ONSITE_EARNINGS_LINE).toMatch(/aren't reported to apps yet/);
    expect(COSMETIC_TRUST_LINE).toMatch(/signal, not proof/);
  });
});
