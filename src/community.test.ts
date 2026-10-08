import { describe, expect, it } from 'vitest';

import {
  COSMETIC_TRUST_LINE,
  ONSITE_EARNINGS_LINE,
  applyVote,
  buildCommunityView,
  buildViewerLedger,
  contributorKey,
  datasetSharedValue,
  filterAndSortDatasets,
  foldSharedEntries,
  generationLedgerEvent,
  ingestOnsiteLedgerEvent,
  itemSharedValue,
  ledgerSharedValue,
  loraSharedValue,
  makeRecordId,
  nextVoteValue,
  parseImageReference,
  snapshotShareRows,
  snapshotSharedValue,
  tallyVotes,
  trainingItemsForDataset,
  validateContribution,
  validateDatasetInput,
  voteSharedValue,
  type DatasetItemRecord,
  type DatasetRecord,
  type LoraRecord,
  type SharedEntryLike,
  type VoteRecord,
} from './community.js';
import { freezeSnapshot, trainingFeeEvent, type LedgerEvent } from './training.js';

const entry = (over: Partial<SharedEntryLike> & Pick<SharedEntryLike, 'value'>): SharedEntryLike => ({
  key: 'shared_1',
  authorUserId: 99,
  createdAt: '2026-10-06T00:00:00.000Z',
  updatedAt: '2026-10-06T00:00:00.000Z',
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

function vote(voterId: number, targetKind: 'dataset' | 'item', targetId: string, value: -1 | 0 | 1, updatedAt = '2026-10-02T00:00:00.000Z'): VoteRecord {
  return { voterId, targetKind, targetId, value, updatedAt };
}

describe('custom up/down votes (option b)', () => {
  it('tallies up and down separately and reports the viewer vote', () => {
    const votes = [vote(1, 'item', 'a', 1), vote(2, 'item', 'a', 1), vote(3, 'item', 'a', -1), vote(4, 'item', 'b', 1)];
    expect(tallyVotes(votes, 'item', 'a', 3)).toEqual({ up: 2, down: 1, net: 1, viewerVote: -1 });
    expect(tallyVotes(votes, 'item', 'a', 99).viewerVote).toBe(0);
  });

  it('clicking the current value clears it; clicking the other replaces it', () => {
    expect(nextVoteValue(1, 1)).toBe(0);
    expect(nextVoteValue(-1, -1)).toBe(0);
    expect(nextVoteValue(1, -1)).toBe(-1);
    expect(nextVoteValue(0, 1)).toBe(1);
  });

  it('applyVote keeps exactly one record per viewer per target', () => {
    const start = [vote(1, 'item', 'a', 1), vote(2, 'item', 'a', 1)];
    const changed = applyVote(start, vote(1, 'item', 'a', -1, '2026-10-03T00:00:00.000Z'));
    expect(changed).toHaveLength(2);
    expect(tallyVotes(changed, 'item', 'a', 1)).toEqual({ up: 1, down: 1, net: 0, viewerVote: -1 });
    const cleared = applyVote(changed, vote(1, 'item', 'a', 0, '2026-10-04T00:00:00.000Z'));
    expect(tallyVotes(cleared, 'item', 'a', 1).net).toBe(1);
  });

  it('the fold keeps the latest vote when duplicate records exist for one viewer', () => {
    const folded = foldSharedEntries([
      entry({ key: 'shared_1', authorUserId: 5, value: voteSharedValue(vote(5, 'item', 'a', 1, '2026-10-02T00:00:00.000Z')), updatedAt: '2026-10-02T00:00:00.000Z' }),
      entry({ key: 'shared_2', authorUserId: 5, value: voteSharedValue(vote(5, 'item', 'a', -1, '2026-10-03T00:00:00.000Z')), updatedAt: '2026-10-03T00:00:00.000Z' }),
    ]);
    expect(folded.votes).toHaveLength(1);
    expect(folded.votes[0]).toMatchObject({ value: -1, storageKey: 'shared_2' });
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

  const trainingEvent = trainingFeeEvent({ snapshot, workflowId: 'wf1', grossBuzz: 700, loraId: 'lora_wf1' });

  function foldedCommunity() {
    return foldSharedEntries([
      entry({ key: 'k-ds', authorUserId: 7, value: datasetSharedValue(dataset) }),
      entry({ key: 'k-a', authorUserId: 11, value: itemSharedValue(itemA) }),
      entry({ key: 'k-b', authorUserId: 12, value: itemSharedValue(itemB) }),
      entry({ key: 'k-v1', authorUserId: 21, value: voteSharedValue(vote(21, 'item', 'a', 1)) }),
      entry({ key: 'k-v2', authorUserId: 22, value: voteSharedValue(vote(22, 'item', 'a', 1)) }),
      entry({ key: 'k-v3', authorUserId: 23, value: voteSharedValue(vote(23, 'item', 'a', 1)) }),
      entry({ key: 'k-v4', authorUserId: 24, value: voteSharedValue(vote(24, 'item', 'a', 1)) }),
      entry({ key: 'k-v5', authorUserId: 25, value: voteSharedValue(vote(25, 'item', 'a', 1)) }),
      entry({ key: 'k-v6', authorUserId: 26, value: voteSharedValue(vote(26, 'item', 'b', 1)) }),
      entry({ key: 'k-v7', authorUserId: 27, value: voteSharedValue(vote(27, 'dataset', 'ds1', 1)) }),
      entry({ key: 'k-v8', authorUserId: 28, value: voteSharedValue(vote(28, 'dataset', 'ds1', -1)) }),
      entry({ key: 'k-snap', authorUserId: 7, value: snapshotSharedValue(snapshot, dataset.name) }),
      entry({ key: 'k-lora', authorUserId: 7, value: loraSharedValue(lora) }),
      entry({ key: 'k-led', authorUserId: 7, value: ledgerSharedValue(trainingEvent) }),
      // A duplicate ledger append for the same source event must not double-count.
      entry({ key: 'k-led2', authorUserId: 7, value: ledgerSharedValue(trainingEvent), updatedAt: '2026-10-04T02:00:00.000Z' }),
      entry({ key: 'k-junk', authorUserId: 1, value: { title: 'junk', data: { kind: 'nope' } } }),
      entry({ key: 'k-bad', authorUserId: 1, value: { title: 'bad', data: { kind: 'vote', targetKind: 'item', targetId: 'a', value: 7 } } }),
    ]);
  }

  it('folds datasets/items/votes/snapshots/loras/ledger and ignores junk records', () => {
    const folded = foldedCommunity();
    expect(folded.datasets).toHaveLength(1);
    expect(folded.items).toHaveLength(2);
    expect(folded.votes).toHaveLength(8);
    expect(folded.snapshots).toHaveLength(1);
    expect(folded.loras).toHaveLength(1);
    expect(folded.ledgerEvents).toHaveLength(1);
  });

  it('dataset votes rank only; item votes drive trainable count and training items', () => {
    const view = buildCommunityView(foldedCommunity(), 21);
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
    const view = buildCommunityView(folded, null);
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
      entry({ key: 'k1', authorUserId: 7, value: datasetSharedValue(dataset) }),
      entry({
        key: 'k2',
        authorUserId: 8,
        value: datasetSharedValue({
          ...dataset,
          datasetId: 'ds2',
          ownerId: 8,
          ownerName: 'zoe',
          name: 'Mecha Parts',
          createdAt: '2026-10-03T00:00:00.000Z',
          updatedAt: '2026-10-03T00:00:00.000Z',
        }),
      }),
      entry({ key: 'k3', authorUserId: 30, value: voteSharedValue(vote(30, 'dataset', 'ds2', 1)) }),
      entry({ key: 'k4', authorUserId: 31, value: voteSharedValue(vote(31, 'dataset', 'ds2', 1)) }),
      entry({
        key: 'k5',
        authorUserId: 7,
        value: loraSharedValue({
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
    const view = buildCommunityView(folded, null);
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
    expect(COSMETIC_TRUST_LINE).toMatch(/cosmetic-trust/);
  });
});
