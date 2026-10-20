// The document-store layer for Dataset Commons, pinned with LITERALS against
// the SDK's contract fake over the COMMITTED manifest. The collection names, the
// `up`/`down` marks and the document shapes are a contract with the cutover copy
// (copy-dataset-commons-to-appdata.sql) — a drift fails here.

import { describe, expect, it } from 'vitest';

import { StorageError } from '@civitai/sdk';

import {
  ALL_APP_SCOPES,
  KV_COLLECTION,
  PUBLISH_SCOPE,
  classifyStorageError,
  createCommunityStore,
  createKvStorage,
  createSerialWriteQueue,
  describeStorageError,
  isConsentRefusal,
  loadSharedEntries,
  loadViewerIndex,
  safeAppStorageKey,
  saveViewerIndex,
  settingsKey,
  viewerIndexKey,
} from './community-storage.js';
import {
  COMMUNITY_COLLECTIONS,
  datasetDoc,
  foldSharedEntries,
  itemDoc,
  type DatasetItemRecord,
  type DatasetRecord,
} from './community.js';
import { createAppFakeStorage, seedCommunity, seedKv } from './fake-doc-storage.js';

const refusal = (status: number, code: string, message = code) =>
  new StorageError(status, code, message, { code, message });

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
const item: DatasetItemRecord = {
  itemId: 'a',
  datasetId: 'ds1',
  contributorId: 11,
  contributorName: 'alice',
  imageRef: 'https://civitai.com/images/101',
  caption: 'front',
  rightsAsserted: true,
  createdAt: '2026-10-01T01:00:00.000Z',
  updatedAt: '2026-10-01T01:00:00.000Z',
};

describe('the copy contract', () => {
  it('names the scopes, collections and private collection literally', () => {
    expect([...ALL_APP_SCOPES]).toEqual(['ai:write:budgeted', 'apps:storage', 'apps:storage:publish']);
    expect(PUBLISH_SCOPE).toBe('apps:storage:publish');
    expect([...COMMUNITY_COLLECTIONS]).toEqual(['datasets', 'items', 'snapshots', 'loras', 'ledger', 'removals']);
    expect(KV_COLLECTION).toBe('kv');
    // The legacy private keys the copied rows sit under.
    expect(viewerIndexKey(42)).toBe('dc-my-index:42');
    expect(settingsKey(42)).toBe('dc-settings:42');
  });

  it('a record document is the record minus `storageKey` — never a `kind`, never title/body', () => {
    expect(datasetDoc({ ...dataset, storageKey: 'k' })).toEqual(dataset);
    expect(Object.keys(itemDoc(item))).not.toContain('kind');
  });

  it('reads a document exactly as the copy lays a legacy row down (legacy data minus `kind`)', async () => {
    const fake = createAppFakeStorage();
    // What the copy writes for a legacy `{title, body, data:{kind:'dataset', …}}` row.
    await fake.storage.collection('datasets').put('01M5LEGACYKEY0000000000000', { ...dataset });
    const store = createCommunityStore(() => fake.storage);
    const { entries } = await loadSharedEntries(store);
    const folded = foldSharedEntries(entries);
    expect(folded.datasets).toEqual([{ ...dataset, storageKey: '01M5LEGACYKEY0000000000000' }]);
  });
});

describe('createCommunityStore over the document store', () => {
  it('creates, lists every collection, and folds — votes are the up/down marks on the target', async () => {
    const fake = createAppFakeStorage();
    const [dsKey, itemKey] = await seedCommunity(fake, [
      { collection: 'datasets', author: 'owner', data: datasetDoc(dataset), up: ['u1', 'u2'], down: ['u3'] },
      { collection: 'items', author: 'alice', data: itemDoc(item), up: ['u1'] },
    ]);
    const store = createCommunityStore(() => fake.storage);
    // The viewer votes the item DOWN: a `down` mark on the item document.
    await store.setVote('items', itemKey!, 0, -1);

    const { entries, access, truncated } = await loadSharedEntries(store);
    expect([access, truncated]).toEqual(['ready', false]);
    const folded = foldSharedEntries(entries);
    expect(folded.votes).toEqual([
      { storageKey: dsKey, targetKind: 'dataset', targetId: 'ds1', up: 2, down: 1, viewerVote: 0 },
      { storageKey: itemKey, targetKind: 'item', targetId: 'a', up: 1, down: 1, viewerVote: -1 },
    ]);
    // Every collection is read (and nothing else).
    const listed = fake.calls.filter((c) => c.method === 'GET').map((c) => c.path.replace('blocks/storage/', ''));
    expect([...new Set(listed)].sort()).toEqual([...COMMUNITY_COLLECTIONS].sort());
  });

  it('switching a vote unmarks the old mark before marking the new; clearing unmarks only', async () => {
    const fake = createAppFakeStorage();
    const [key] = await seedCommunity(fake, [{ collection: 'items', author: 'alice', data: itemDoc(item) }]);
    const store = createCommunityStore(() => fake.storage);
    const marks = () =>
      fake.calls
        .filter((c) => c.path.includes('/marks/'))
        .map((c) => `${c.method} ${c.path.split('/').at(-1)}`);
    await store.setVote('items', key!, 0, 1);
    await store.setVote('items', key!, 1, -1);
    await store.setVote('items', key!, -1, 0);
    await store.setVote('items', key!, 0, 0); // no-op
    expect(marks()).toEqual(['PUT up', 'DELETE up', 'PUT down', 'DELETE down']);
    const doc = await fake.storage.collection('items').get(key!);
    expect([doc?.marks, doc?.viewer?.marks]).toEqual([{ up: 0, down: 0 }, []]);
    await expect(store.setVote('ledger', key!, 0, 1)).rejects.toThrow(/carries no votes/);
  });

  it('`own`: only the author edits or deletes; another viewer is refused', async () => {
    const fake = createAppFakeStorage();
    const store = createCommunityStore(() => fake.storage);
    const { key } = await store.create('datasets', datasetDoc(dataset));
    await store.put('datasets', key, datasetDoc({ ...dataset, name: 'Renamed' }));
    expect((await fake.storage.collection('datasets').get(key))?.data).toMatchObject({ name: 'Renamed' });

    const other = createCommunityStore(() => fake.as({ viewer: { username: 'mallory' } }).storage);
    await expect(other.put('datasets', key, datasetDoc(dataset))).rejects.toMatchObject({ code: 'not_author' });
    await expect(other.remove('datasets', key)).rejects.toMatchObject({ code: 'not_author' });
    expect(await store.remove('datasets', key)).toEqual({ deleted: true });
  });

  it('creating needs the consent-gated publish scope; voting and deleting one’s own do not', async () => {
    const fake = createAppFakeStorage();
    const owner = createCommunityStore(() => fake.storage);
    const { key } = await owner.create('items', itemDoc(item));
    const unconsented = createCommunityStore(() => fake.as({ scopes: ['apps:storage'] }).storage);
    const err = await unconsented.create('datasets', datasetDoc(dataset)).then(() => null, (e: unknown) => e);
    expect(isConsentRefusal(err)).toBe(true);
    expect(classifyStorageError(err)).toBe('not-permitted');
    await unconsented.setVote('items', key, 0, 1);
    const ownerNoPublish = createCommunityStore(() => fake.as({ scopes: ['apps:storage'] }).storage);
    expect(await ownerNoPublish.remove('items', key)).toEqual({ deleted: true });
  });

  it('an anonymous viewer reads the community (no viewer votes)', async () => {
    const fake = createAppFakeStorage();
    await seedCommunity(fake, [{ collection: 'datasets', author: 'owner', data: datasetDoc(dataset), up: ['u1'] }]);
    const anon = createCommunityStore(() => fake.as({ viewer: null }).storage);
    const { entries, access } = await loadSharedEntries(anon);
    expect(access).toBe('ready');
    expect(entries.map((e) => [e.collection, e.up, e.viewerVote])).toEqual([['datasets', 1, 0]]);
  });

  it('pages each collection until the cursor runs out and reports truncation at the cap', async () => {
    const fake = createAppFakeStorage();
    const store = createCommunityStore(() => fake.storage);
    for (let i = 0; i < 5; i++) await store.create('ledger', { eventId: `e${i}`, sourceRef: `s${i}` });
    const all = await loadSharedEntries(store, { pageSize: 2, maxPages: 5 });
    expect(all.entries.filter((e) => e.collection === 'ledger')).toHaveLength(5);
    expect(all.truncated).toBe(false);
    const capped = await loadSharedEntries(store, { pageSize: 2, maxPages: 2 });
    expect(capped.entries.filter((e) => e.collection === 'ledger')).toHaveLength(4);
    expect(capped.truncated).toBe(true);
  });

  it('a refused read classifies instead of throwing or faking empty', async () => {
    const disabled = createCommunityStore(() => createAppFakeStorage({ disabled: true }).storage);
    expect(await loadSharedEntries(disabled)).toEqual({ entries: [], access: 'failed', truncated: false });
    const undeclared = createCommunityStore(
      () => createAppFakeStorage({ appStatus: 'pending' }).storage,
    );
    expect((await loadSharedEntries(undeclared)).access).toBe('not-permitted');
  });
});

describe('classifyStorageError / describeStorageError branch on the store code', () => {
  it('scope / consent / eligibility refusals are not-permitted; everything else failed', () => {
    for (const code of ['insufficient_scope', 'consent_required', 'collection_not_declared', 'not_eligible']) {
      expect(classifyStorageError(refusal(403, code))).toBe('not-permitted');
    }
    for (const code of ['service_unavailable', 'rate_limited', 'too_large', 'quota_exceeded', 'not_author']) {
      expect(classifyStorageError(refusal(503, code))).toBe('failed');
    }
    // The legacy prose heuristic is gone: words alone decide nothing.
    expect(classifyStorageError(new Error('storage set requires the apps:storage:write scope'))).toBe('failed');
    expect(isConsentRefusal(refusal(403, 'insufficient_scope'))).toBe(false);
  });

  it('surfaces the store code and message, capped, with a fallback for empty errors', () => {
    expect(describeStorageError(refusal(503, 'service_unavailable', 'try later'))).toBe('service_unavailable: try later');
    expect(describeStorageError(refusal(503, 'service_unavailable', 'SHARED_UNAVAILABLE: service_unavailable'))).toBe(
      'SHARED_UNAVAILABLE: service_unavailable',
    );
    expect(describeStorageError('host busy')).toBe('host busy');
    expect(describeStorageError(null)).toBe('shared storage write failed');
    expect(describeStorageError(new Error('x'.repeat(300)))).toHaveLength(240);
  });
});

describe('createSerialWriteQueue (no overlapping shared writes)', () => {
  it('runs queued writes one at a time, in order, even after a failure', async () => {
    const queue = createSerialWriteQueue();
    const order: string[] = [];
    const task = (name: string, fail = false) =>
      queue.run(async () => {
        order.push(`start:${name}`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`end:${name}`);
        if (fail) throw new Error('boom');
        return name;
      });
    const results = await Promise.allSettled([task('a'), task('b', true), task('c')]);
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });
});

describe('per-viewer private kv (copy-kv-to-appdata.sql shape)', () => {
  it('reads the index exactly as the copy lays it down, and round-trips it wrapped in { value }', async () => {
    const fake = createAppFakeStorage();
    const index = { itemIds: ['a'], voteTargets: ['item:a'], snapshotIds: ['s1'], updatedAt: '2026-10-06T00:00:00.000Z' };
    await seedKv(fake, { 'dc-my-index:5': index });
    const kv = createKvStorage(() => fake.storage);
    expect(await loadViewerIndex(kv, 5)).toEqual({ index, access: 'ready' });

    const next = { ...index, itemIds: ['a', 'b'] };
    expect(await saveViewerIndex(kv, 5, next)).toBe('ready');
    expect((await fake.storage.collection('kv').get('dc-my-index:5'))?.data).toEqual({ value: next });
  });

  it('an anonymous viewer is refused, never a fake save', async () => {
    const kv = createKvStorage(() => createAppFakeStorage({ viewer: null }).storage);
    expect(await saveViewerIndex(kv, 5, { itemIds: [], voteTargets: [], snapshotIds: [], updatedAt: '' })).toBe('failed');
    expect(await loadViewerIndex(kv, 5)).toEqual({ index: null, access: 'failed' });
  });

  it('caps long keys at the store’s 128-char rule with a deterministic hash suffix', () => {
    const key = safeAppStorageKey('dc-index', 'x'.repeat(500));
    expect(key.length).toBeLessThanOrEqual(128);
    expect(key).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    expect(safeAppStorageKey('dc-index', 'x'.repeat(500))).toBe(key);
    expect(safeAppStorageKey('dc-index', 'y'.repeat(500))).not.toBe(key);
    expect(safeAppStorageKey('dc', 'plain')).toBe('dc:plain');
  });
});
