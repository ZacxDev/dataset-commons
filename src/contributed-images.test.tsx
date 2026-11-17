import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';
import { ALL_APP_SCOPES } from './community-storage.js';
import { datasetDoc, itemDoc, type DatasetItemRecord, type DatasetRecord } from './community.js';
import { seedCommunity } from './fake-doc-storage.js';
import { installMockMoneyHost } from './mock-buzz.js';
import { testDocStore } from './test-doc-store.js';
import { TrainFlow } from './TrainFlow.js';
import type { DatasetItem } from './training.js';

// Regression: a dataset whose items are POSTED Civitai images (contributed by
// link or picked from the contributor's posts). The real host's gated read
// (`GET_IMAGES_BY_IDS`) answers only this app's own unposted outputs, so for
// these ids it returns NO images; the mock host is told to do the same
// (`gatedImages: []`). The block image catalog (`/api/v1/blocks/images?ids=`)
// is what returns posted images; it is served here from a stubbed `fetch`.

const POSTED_A = 501;
const POSTED_B = 502;
const catalogUrl = (id: number) => `https://image.civitai.com/catalog/original=true/posted-${id}.jpeg`;

/** Stub `fetch` as the block catalog route; every other request keeps failing. */
function stubCatalog(): string[] {
  const requested: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (!url.pathname.endsWith('/api/v1/blocks/images')) throw new Error('no network in test');
      requested.push(url.toString());
      const ids = (url.searchParams.get('ids') ?? '').split(',').map(Number);
      const items = ids
        .filter((id) => id === POSTED_A || id === POSTED_B)
        .map((id) => ({ id, url: catalogUrl(id), width: 768, height: 1024 }));
      return new Response(JSON.stringify({ items, metadata: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return requested;
}

describe('posted images contributed to a dataset', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it('render from the block catalog when the gated read returns nothing for them', async () => {
    const user = userEvent.setup();
    const requested = stubCatalog();
    const dataset: DatasetRecord = {
      datasetId: 'ds-posted',
      ownerId: 7,
      ownerName: 'archivist',
      name: 'Posted Set',
      description: '',
      targetNote: '',
      createdAt: '2026-10-21T00:00:00.000Z',
      updatedAt: '2026-10-21T00:00:00.000Z',
    };
    const mkItem = (itemId: string, imageId: number): DatasetItemRecord => ({
      itemId,
      datasetId: dataset.datasetId,
      contributorId: 7,
      contributorName: 'archivist',
      imageId,
      imageRef: `https://civitai.com/images/${imageId}`,
      caption: `caption ${itemId}`,
      rightsAsserted: true,
      createdAt: '2026-10-21T01:00:00.000Z',
      updatedAt: '2026-10-21T01:00:00.000Z',
    });
    await seedCommunity(testDocStore(), [
      { collection: 'datasets', author: 'archivist', data: datasetDoc(dataset) },
      { collection: 'items', author: 'archivist', data: itemDoc(mkItem('pa', POSTED_A)) },
      { collection: 'items', author: 'archivist', data: itemDoc(mkItem('pb', POSTED_B)) },
    ]);
    uninstall = installMockMoneyHost({
      viewer: { id: 7, username: 'archivist', status: 'active' },
      declaredScopes: [...ALL_APP_SCOPES],
      gatedImages: [],
    });
    render(<App />);
    await screen.findByTestId('dc-community');
    await user.click(await screen.findByTestId('dc-open-dataset-ds-posted'));

    const a = await screen.findByTestId('dc-item-image-pa', {}, { timeout: 5000 });
    expect(a).toHaveAttribute('src', catalogUrl(POSTED_A));
    expect(screen.getByTestId('dc-item-image-pb')).toHaveAttribute('src', catalogUrl(POSTED_B));
    expect(screen.queryByTestId('dc-item-image-pending-pa')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dc-item-image-pending-pb')).not.toBeInTheDocument();
    // One catalog request naming exactly the two item ids.
    expect(requested).toHaveLength(1);
    expect(new URL(requested[0]!).searchParams.get('ids')).toBe(`${POSTED_A},${POSTED_B}`);
  }, 15000);

  it('"Save #1" saves a posted image by its catalog url, not by id through the gated read', async () => {
    const user = userEvent.setup();
    stubCatalog();
    const outbound: Array<{ type: string; payload?: unknown }> = [];
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      gatedImages: [],
      onOutbound: (message) => outbound.push(message as { type: string; payload?: unknown }),
    });
    const items: DatasetItem[] = [
      { itemId: 'a', contributorId: 'alice', imageUrl: `https://civitai.com/images/${POSTED_A}`, imageId: POSTED_A, caption: 'front', netVotes: 3 },
      { itemId: 'b', contributorId: 'bob', imageUrl: `https://civitai.com/images/${POSTED_B}`, imageId: POSTED_B, caption: 'profile', netVotes: 1 },
    ];
    render(<TrainFlow initialItems={items} datasetId="ds-posted" trainerId="dev" allowLocalUploads={false} />);
    await screen.findByTestId('dc-train');

    // The catalog read settles before the click, or the save could only go by id.
    const button = await screen.findByTestId('dc-train-save-a');
    await waitFor(() => expect(button).toHaveAttribute('data-save-by', 'url'), { timeout: 5000 });
    await user.click(button);

    await waitFor(() => expect(outbound.some((m) => m.type === 'SAVE_IMAGE')).toBe(true));
    const save = outbound.find((m) => m.type === 'SAVE_IMAGE')!.payload as Record<string, unknown>;
    expect(save.url).toBe(catalogUrl(POSTED_A));
    expect(save).not.toHaveProperty('imageId');
    expect(save.filename).toBe('open-datasets-01');
  }, 15000);
});
