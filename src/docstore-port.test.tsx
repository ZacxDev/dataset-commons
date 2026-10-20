// 0.2.0 — the community moved from the legacy shared feed (`useSharedStorage`,
// one feed with a `kind` discriminator and its own vote records) to six shared
// document-store collections with `up`/`down` marks, and the per-viewer index
// from `useAppStorage` to the private `kv` collection. These drive the REAL
// <App/> against the mock host for the bridge and the SDK's `createFakeStorage`
// for the document store, and pin:
//   1. documents exactly as the cutover copy lays the legacy rows down (legacy
//      keys, legacy data minus `kind`, legacy votes as the voters' marks) render;
//   2. a vote is a MARK on the item document — no vote document is ever written;
//   3. the per-viewer index lands in `kv` under the legacy key, wrapped;
//   4. an anonymous viewer never reaches the private store;
//   5. in production wiring the requests go to the HOST origin's
//      `/api/v1/blocks/storage/…`, with the block token.
// test-setup's tripwire additionally fails ANY test that reaches a legacy store.

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';
import { ALL_APP_SCOPES } from './community-storage.js';
import { configureDocumentStorage } from './doc-storage.js';
import { installMockMoneyHost } from './mock-buzz.js';
import { testDocStore } from './test-doc-store.js';

const VIEWER = { id: 2, username: 'dev', status: 'active' } as const;

/** A legacy-row-shaped dataset/item, as the copy writes it (data = legacy data minus `kind`). */
const legacyDataset = {
  datasetId: 'dataset_mgo1abc_1_deadbeef',
  ownerId: 77,
  ownerName: 'archivist',
  name: 'Copied Dataset',
  description: 'carried over',
  targetNote: '',
  createdAt: '2026-10-12T00:00:00.000Z',
  updatedAt: '2026-10-19T00:00:00.000Z',
};
const legacyItem = {
  itemId: 'item_mgo1abd_2_cafebabe',
  datasetId: legacyDataset.datasetId,
  contributorId: 77,
  contributorName: 'archivist',
  imageRef: 'https://civitai.com/v2/consumer/blobs/copied',
  caption: 'copied caption',
  rightsAsserted: true,
  createdAt: '2026-10-12T00:01:00.000Z',
  updatedAt: '2026-10-12T00:01:00.000Z',
};

async function seedCopied() {
  const fake = testDocStore();
  const as = (u: string) => fake.as({ viewer: { username: u } }).storage;
  // Legacy keys (ULIDs) verbatim, written by their authors.
  await as('archivist').collection('datasets').put('01M5DSAAAAAAAAAAAAAAAAAAAA', legacyDataset);
  await as('archivist').collection('items').put('01M5ITBBBBBBBBBBBBBBBBBBBB', legacyItem);
  // The legacy vote record (+1 on the item) is the voter's `up` mark.
  await as('archivist').collection('items').mark('01M5ITBBBBBBBBBBBBBBBBBBBB', 'up');
  return fake;
}

describe('Dataset Commons on the document store (0.2.0)', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    vi.unstubAllGlobals();
  });

  it('renders the community exactly as the copy laid it down, legacy vote as a mark', async () => {
    await seedCopied();
    uninstall = installMockMoneyHost({ viewer: { ...VIEWER }, declaredScopes: [...ALL_APP_SCOPES] });
    const user = userEvent.setup();
    render(<App />);
    const card = await screen.findByTestId('dc-dataset-card', {}, { timeout: 5000 });
    expect(card).toHaveTextContent('Copied Dataset');
    await user.click(screen.getByTestId(`dc-open-dataset-${legacyDataset.datasetId}`));
    expect(await screen.findByTestId(`dc-item-${legacyItem.itemId}-net`)).toHaveTextContent('1');
    expect(screen.getByTestId(`dc-item-card-${legacyItem.itemId}`)).toHaveTextContent('in training set');
  });

  it('a vote is the viewer’s MARK on the item document — no document is written for it', async () => {
    const fake = await seedCopied();
    uninstall = installMockMoneyHost({ viewer: { ...VIEWER }, declaredScopes: [...ALL_APP_SCOPES] });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId(`dc-open-dataset-${legacyDataset.datasetId}`, {}, { timeout: 5000 }));
    await user.click(await screen.findByTestId(`dc-item-${legacyItem.itemId}-up`));
    await waitFor(() => expect(screen.getByTestId(`dc-item-${legacyItem.itemId}-net`)).toHaveTextContent('2'));

    const doc = await fake.storage.collection('items').get('01M5ITBBBBBBBBBBBBBBBBBBBB');
    expect([doc?.marks.up, doc?.viewer?.marks]).toEqual([2, ['up']]);
    // No shared document was created or replaced by voting.
    const sharedWrites = fake.calls.filter(
      (c) => (c.method === 'POST' || c.method === 'PUT') && !c.path.includes('/marks/') && !c.path.startsWith('blocks/storage/kv'),
    );
    expect(sharedWrites.filter((c) => c.status < 400).map((c) => c.path)).toEqual([
      'blocks/storage/datasets/01M5DSAAAAAAAAAAAAAAAAAAAA',
      'blocks/storage/items/01M5ITBBBBBBBBBBBBBBBBBBBB',
    ]); // the two seeding PUTs, nothing from the app
  });

  it('the per-viewer index lands in `kv` under the legacy key `dc-my-index:<viewer id>`, wrapped', async () => {
    await seedCopied();
    uninstall = installMockMoneyHost({ viewer: { ...VIEWER }, declaredScopes: [...ALL_APP_SCOPES] });
    render(<App />);
    const kv = testDocStore().storage.collection<{ value: { voteTargets: string[] } }>('kv');
    await waitFor(async () => {
      const doc = await kv.get('dc-my-index:2');
      expect(doc?.data.value).toMatchObject({ itemIds: [], voteTargets: [], snapshotIds: [] });
    });
  });

  it('an anonymous viewer reads the community and never reaches the private store', async () => {
    await seedCopied();
    uninstall = installMockMoneyHost({ viewer: null, declaredScopes: [...ALL_APP_SCOPES] });
    render(<App />);
    expect(await screen.findByTestId('dc-dataset-card', {}, { timeout: 5000 })).toHaveTextContent('Copied Dataset');
    await new Promise((r) => setTimeout(r, 50));
    expect(testDocStore().calls.filter((c) => c.path.startsWith('blocks/storage/kv'))).toEqual([]);
  });

  it('production wiring: the HOST origin’s /api/v1/blocks/storage routes, with the block token', async () => {
    configureDocumentStorage(null);
    const seen: { url: string; auth: string | null }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
        return new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    uninstall = installMockMoneyHost({ viewer: { ...VIEWER }, declaredScopes: [...ALL_APP_SCOPES] });
    render(<App />);
    await waitFor(() =>
      expect(['datasets', 'items', 'snapshots', 'loras', 'ledger', 'removals'].every((c) =>
        seen.some((s) => s.url.includes(`/blocks/storage/${c}?`)),
      )).toBe(true),
    );
    for (const call of seen.filter((s) => s.url.includes('/blocks/storage'))) {
      expect(call.url.startsWith(`${window.location.origin}/api/v1/blocks/storage/`)).toBe(true);
      expect(call.auth).toMatch(/^Bearer \S+/);
    }
  });
});
