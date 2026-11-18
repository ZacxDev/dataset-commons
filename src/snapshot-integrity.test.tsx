import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App.js';
import { ALL_APP_SCOPES } from './community-storage.js';
import {
  datasetDoc,
  foldSharedEntries,
  loraDoc,
  snapshotShareRows,
  type DatasetRecord,
  type LoraRecord,
  type SharedEntryLike,
} from './community.js';
import { seedCommunity } from './fake-doc-storage.js';
import { installMockMoneyHost } from './mock-buzz.js';
import { testDocStore } from './test-doc-store.js';
import { deriveContributorCredits, freezeSnapshot } from './training.js';

// A shared `snapshots` document is written by its author and read by everyone,
// and a client can write one straight to the store. These pin that the fold
// trusts no field of it, and that deleting a dataset keeps the snapshots other
// contributors' credit history rests on. Every input is a literal.

/** A well-formed snapshot, as freezeSnapshot writes it: weights 5 + 1, one item excluded. */
const GOOD = {
  snapshotId: 'snap_good',
  datasetId: 'ds1',
  trainerId: 'user:2',
  createdAt: '2026-11-18T00:00:00.000Z',
  items: [
    { itemId: 'a', contributorId: 'user:11', imageUrl: '', caption: 'front', frozenNetVotes: 5, weight: 5, included: true },
    { itemId: 'b', contributorId: 'user:12', imageUrl: '', caption: 'side', frozenNetVotes: 1, weight: 1, included: true },
    {
      itemId: 'c',
      contributorId: 'user:13',
      imageUrl: '',
      caption: 'back',
      frozenNetVotes: 0,
      weight: 0,
      included: false,
      exclusionReason: 'net-not-positive',
    },
  ],
  totalWeight: 6,
};

const snapshotEntry = (data: unknown): SharedEntryLike => ({
  key: 'k-snap',
  collection: 'snapshots',
  data,
  createdAt: '2026-11-18T00:00:00.000Z',
  updatedAt: '2026-11-18T00:00:00.000Z',
  up: 0,
  down: 0,
  viewerVote: 0,
});

const withItem = (index: number, patch: Record<string, unknown>) => ({
  ...GOOD,
  items: GOOD.items.map((item, i) => (i === index ? { ...item, ...patch } : item)),
});

describe('folding a stored snapshot', () => {
  it('keeps a well-formed snapshot and its 5:1 split', () => {
    const folded = foldSharedEntries([snapshotEntry(GOOD)]);
    expect(folded.snapshots).toHaveLength(1);
    expect(folded.snapshots[0]!.totalWeight).toBe(6);
    const shares = snapshotShareRows(folded.snapshots[0]!).map((r) => [r.contributorId, r.share]);
    expect(shares).toEqual([
      ['user:11', 5 / 6],
      ['user:12', 1 / 6],
    ]);
  });

  it('never reads the stored totalWeight: a forged denominator cannot inflate credit', () => {
    const folded = foldSharedEntries([snapshotEntry({ ...GOOD, totalWeight: 1 })]);
    expect(folded.snapshots).toHaveLength(1);
    expect(folded.snapshots[0]!.totalWeight).toBe(6);
    const credits = deriveContributorCredits({ grossBuzz: 600 }, folded.snapshots[0]!)
      .map((c) => [c.contributorId, c.credit])
      .sort();
    expect(credits).toEqual([
      ['user:11', 500],
      ['user:12', 100],
    ]);
  });

  const MALFORMED: Record<string, unknown> = {
    'weight as a string': withItem(0, { weight: '5' }),
    'negative weight': withItem(1, { weight: -1 }),
    'absurd weight': withItem(0, { weight: 1e12 }),
    'included missing': withItem(0, { included: undefined }),
    'included as a string': withItem(0, { included: 'true' }),
    'included with weight 0': withItem(1, { weight: 0 }),
    'excluded with weight': withItem(2, { weight: 5 }),
    'contributorId missing': withItem(0, { contributorId: undefined }),
    'contributorId a number': withItem(0, { contributorId: 11 }),
    'itemId missing': withItem(1, { itemId: '' }),
    'frozenNetVotes a string': withItem(0, { frozenNetVotes: '5' }),
    'duplicate itemId': withItem(1, { itemId: 'a' }),
    'null item': { ...GOOD, items: [GOOD.items[0], null] },
    'datasetId missing': { ...GOOD, datasetId: undefined },
    'items not an array': { ...GOOD, items: { a: GOOD.items[0] } },
  };

  it('keeps every snapshot freezeSnapshot writes: owner override, manual exclusion, net-negative', () => {
    const frozen = freezeSnapshot(
      'ds1',
      'user:2',
      [
        { itemId: 'up', contributorId: 'user:11', imageUrl: '', caption: 'a', netVotes: 3 },
        { itemId: 'override', contributorId: 'user:12', imageUrl: '', caption: 'b', netVotes: -2 },
        { itemId: 'manual', contributorId: 'user:13', imageUrl: '', caption: 'c', netVotes: 4 },
        { itemId: 'negative', contributorId: 'user:14', imageUrl: '', caption: 'd', netVotes: -1, imageId: 77 },
      ],
      { snapshotId: 'snap_frozen', now: '2026-11-18T00:00:00.000Z', ownerOverrides: ['override'], manualExclusions: ['manual'] },
    );
    const folded = foldSharedEntries([snapshotEntry(JSON.parse(JSON.stringify(frozen)))]);
    expect(folded.snapshots).toEqual([frozen]);
    expect(folded.snapshots[0]!.totalWeight).toBe(4);
  });

  it('a later document under a published snapshot id never replaces the first one', () => {
    const hijack = {
      ...GOOD,
      createdAt: '2027-01-01T00:00:00.000Z',
      items: [{ itemId: 'z', contributorId: 'user:666', imageUrl: '', caption: 'x', frozenNetVotes: 9, weight: 9, included: true }],
    };
    const folded = foldSharedEntries([
      snapshotEntry(GOOD),
      { ...snapshotEntry(hijack), key: 'k-hijack', createdAt: '2026-11-19T00:00:00.000Z' },
    ]);
    expect(folded.snapshots.map((s) => s.items.map((i) => i.contributorId))).toEqual([['user:11', 'user:12', 'user:13']]);
    // Order of arrival does not matter either.
    const reversed = foldSharedEntries([
      { ...snapshotEntry(hijack), key: 'k-hijack', createdAt: '2026-11-19T00:00:00.000Z' },
      snapshotEntry(GOOD),
    ]);
    expect(reversed.snapshots.map((s) => s.items[0]!.contributorId)).toEqual(['user:11']);
  });

  it('ignores a ledger event whose grossBuzz is not a non-negative number, or whose ids are missing', () => {
    const ledgerEntry = (data: unknown, key: string): SharedEntryLike => ({ ...snapshotEntry(data), collection: 'ledger', key });
    const good = {
      eventId: 'e1',
      loraId: 'lora_1',
      snapshotId: GOOD.snapshotId,
      eventType: 'training',
      grossBuzz: 600,
      sourceRef: 'wf1',
      createdAt: '2026-11-18T01:00:00.000Z',
    };
    const folded = foldSharedEntries([
      ledgerEntry(good, 'l1'),
      ledgerEntry({ ...good, eventId: 'e2', sourceRef: 'wf2', grossBuzz: '600' }, 'l2'),
      ledgerEntry({ ...good, eventId: 'e3', sourceRef: 'wf3', grossBuzz: -5 }, 'l3'),
      ledgerEntry({ ...good, eventId: 'e4', sourceRef: 'wf4', snapshotId: 7 }, 'l4'),
      ledgerEntry({ ...good, eventId: 'e5', sourceRef: 'wf5', loraId: undefined }, 'l5'),
      ledgerEntry({ ...good, eventId: 'e6', sourceRef: 'wf6', createdAt: 12345 }, 'l6'),
    ]);
    expect(folded.ledgerEvents.map((e) => e.eventId).sort()).toEqual(['e1', 'e6']);
    // A non-string createdAt falls back to the store's own time instead of breaking the sort.
    expect(folded.ledgerEvents.find((e) => e.eventId === 'e6')!.createdAt).toBe('2026-11-18T00:00:00.000Z');
  });

  for (const [name, data] of Object.entries(MALFORMED)) {
    it(`ignores a snapshot with ${name}`, () => {
      expect(foldSharedEntries([snapshotEntry(data)]).snapshots).toEqual([]);
    });
  }
});

describe("deleting a dataset keeps other contributors' history", () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it('withdraws only the owner’s own LoRA link, keeps the snapshot, and completes', async () => {
    const user = userEvent.setup();
    // The fake store's viewer is `dev-viewer`; the mock host's viewer id 2 owns the dataset.
    const dataset: DatasetRecord = {
      datasetId: 'ds1',
      ownerId: 2,
      ownerName: 'dev',
      name: 'Shared History Set',
      description: '',
      targetNote: '',
      createdAt: '2026-11-18T00:00:00.000Z',
      updatedAt: '2026-11-18T00:00:00.000Z',
    };
    const lora = (loraId: string, trainerId: number): LoraRecord => ({
      loraId,
      datasetId: 'ds1',
      snapshotId: GOOD.snapshotId,
      trainerId,
      trainerName: `trainer-${trainerId}`,
      name: `LoRA ${loraId}`,
      workflowId: `wf-${loraId}`,
      published: false,
      createdAt: '2026-11-18T01:00:00.000Z',
      updatedAt: '2026-11-18T01:00:00.000Z',
    });
    const [datasetKey, snapKey, ownLoraKey, otherLoraKey] = await seedCommunity(testDocStore(), [
      { collection: 'datasets', author: 'dev-viewer', data: datasetDoc(dataset) },
      { collection: 'snapshots', author: 'dev-viewer', data: GOOD },
      { collection: 'loras', author: 'dev-viewer', data: loraDoc(lora('lora_own', 2)) },
      { collection: 'loras', author: 'other-trainer', data: loraDoc(lora('lora_other', 99)) },
    ]);
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      declaredScopes: [...ALL_APP_SCOPES],
    });
    render(<App />);
    await screen.findByTestId('dc-community');
    await user.click(await screen.findByTestId('dc-open-dataset-ds1', {}, { timeout: 5000 }));
    await screen.findByTestId('dc-dataset-detail', {}, { timeout: 5000 });
    await user.click(screen.getByTestId('dc-dataset-menu'));
    await user.click(screen.getByTestId('dc-delete-dataset'));
    await user.click(screen.getByTestId('dc-delete-dataset'));

    expect(await screen.findByTestId('dc-explore-empty', {}, { timeout: 5000 })).toBeInTheDocument();
    const fake = testDocStore().storage;
    expect(await fake.collection('datasets').get(seedKeyOrThrow(datasetKey))).toBeNull();
    expect(await fake.collection('snapshots').get(seedKeyOrThrow(snapKey))).not.toBeNull();
    expect(await fake.collection('loras').get(seedKeyOrThrow(ownLoraKey))).toBeNull();
    expect(await fake.collection('loras').get(seedKeyOrThrow(otherLoraKey))).not.toBeNull();
  }, 20000);
});

function seedKeyOrThrow(key: string | undefined): string {
  if (!key) throw new Error('seedCommunity returned no key');
  return key;
}
