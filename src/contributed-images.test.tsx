import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';
import { ALL_APP_SCOPES } from './community-storage.js';
import { datasetDoc, itemDoc, type DatasetItemRecord, type DatasetRecord } from './community.js';
import { seedCommunity } from './fake-doc-storage.js';
import { installMockMoneyHost, type MockMoneyHostOptions } from './mock-buzz.js';
import { testDocStore } from './test-doc-store.js';
import { TrainFlow } from './TrainFlow.js';
import type { DatasetItem } from './training.js';

// Regression: a dataset whose items are POSTED Civitai images (contributed by
// link or picked from the contributor's posts). The real host's gated read
// (`GET_IMAGES_BY_IDS`) answers only this app's own unposted outputs, so for
// these ids it returns NO images; the mock host is told to do the same
// (`gatedImages: []`). The block image catalog (`/api/v1/blocks/images?ids=`)
// is what returns posted images; it is served here from a stubbed `fetch`.
//
// The catalog is clamped server-side to the DOMAIN ceiling only, so the stub
// returns every image whatever its rating, as the real route does on a mature
// domain; keeping a mature image off a PG viewer's screen is the app's job.

// Browsing-level bits (civitai): PG 1, PG13 2, R 4, X 8, XXX 16.
const PG = 1;
const R = 4;
const X = 8;
const ALL_RATED = 31;

const POSTED_A = 501;
const POSTED_B = 502;
const MATURE_X = 503;
const MATURE_R = 504;
const LEVEL: Record<number, number> = { [POSTED_A]: PG, [POSTED_B]: PG, [MATURE_X]: X, [MATURE_R]: R };
const originalUrl = (id: number) => `https://image.civitai.com/catalog/guid-${id}/original=true/posted-${id}.jpeg`;
const gridUrl = (id: number) => `https://image.civitai.com/catalog/guid-${id}/width=1200/posted-${id}.jpeg`;

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
        .filter((id) => LEVEL[id] != null)
        .map((id) => ({ id, url: originalUrl(id), type: 'image', browsingLevel: LEVEL[id], width: 768, height: 1024 }));
      return new Response(JSON.stringify({ items, metadata: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return requested;
}

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

/** Seed the dataset with `items` (itemId → imageId), open it, and return the catalog requests. */
async function openDataset(items: Record<string, number>, host: MockMoneyHostOptions) {
  const user = userEvent.setup();
  const requested = stubCatalog();
  await seedCommunity(testDocStore(), [
    { collection: 'datasets', author: 'archivist', data: datasetDoc(dataset) },
    ...Object.entries(items).map(([itemId, imageId]) => ({
      collection: 'items' as const,
      author: 'archivist',
      data: itemDoc(mkItem(itemId, imageId)),
    })),
  ]);
  const uninstall = installMockMoneyHost({
    viewer: { id: 7, username: 'archivist', status: 'active' },
    declaredScopes: [...ALL_APP_SCOPES],
    gatedImages: [],
    ...host,
  });
  render(<App />);
  await screen.findByTestId('dc-community');
  await user.click(await screen.findByTestId('dc-open-dataset-ds-posted'));
  return { requested, uninstall };
}

describe('posted images contributed to a dataset', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it('render from the block catalog when the gated read returns nothing for them', async () => {
    const opened = await openDataset({ pa: POSTED_A, pb: POSTED_B }, {});
    uninstall = opened.uninstall;

    const a = await screen.findByTestId('dc-item-image-pa', {}, { timeout: 5000 });
    // The grid shows the width-limited rendition, never the full-size original.
    expect(a).toHaveAttribute('src', gridUrl(POSTED_A));
    expect(screen.getByTestId('dc-item-image-pb')).toHaveAttribute('src', gridUrl(POSTED_B));
    expect(screen.queryByTestId('dc-item-image-pending-pa')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dc-item-image-pending-pb')).not.toBeInTheDocument();
    // One catalog request naming exactly the two item ids, images only.
    expect(opened.requested).toHaveLength(1);
    const query = new URL(opened.requested[0]!).searchParams;
    expect(query.get('ids')).toBe(`${POSTED_A},${POSTED_B}`);
    expect(query.get('type')).toBe('image');
  }, 15000);

  it('an X-rated catalog image is hidden from a PG viewer on a mature domain', async () => {
    const opened = await openDataset(
      { pa: POSTED_A, mx: MATURE_X },
      { maxBrowsingLevel: ALL_RATED, viewerBrowsingLevel: PG },
    );
    uninstall = opened.uninstall;

    await screen.findByTestId('dc-item-image-pa', {}, { timeout: 5000 });
    expect(await screen.findByTestId('dc-item-image-hidden-mx')).toHaveTextContent(/hidden by your content settings/i);
    expect(screen.queryByTestId('dc-item-image-mx')).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(`posted-${MATURE_X}`);
  }, 15000);

  it('without a viewer level from the host, only PG and PG13 catalog images render', async () => {
    const opened = await openDataset({ pa: POSTED_A, mr: MATURE_R }, { maxBrowsingLevel: ALL_RATED });
    uninstall = opened.uninstall;

    await screen.findByTestId('dc-item-image-pa', {}, { timeout: 5000 });
    expect(screen.getByTestId('dc-item-image-pending-mr')).toBeInTheDocument();
    expect(screen.queryByTestId('dc-item-image-mr')).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(`posted-${MATURE_R}`);
  }, 15000);

  it('a mature viewer on a mature domain sees the X-rated image', async () => {
    const opened = await openDataset({ mx: MATURE_X }, { maxBrowsingLevel: ALL_RATED, viewerBrowsingLevel: ALL_RATED });
    uninstall = opened.uninstall;

    expect(await screen.findByTestId('dc-item-image-mx', {}, { timeout: 5000 })).toHaveAttribute('src', gridUrl(MATURE_X));
  }, 15000);

  it('the Upload tab says the upload is shared with the dataset viewers once scanned, and not posted', async () => {
    const user = userEvent.setup();
    const opened = await openDataset({}, {});
    uninstall = opened.uninstall;

    await user.click(await screen.findByTestId('dc-add-image'));
    await user.click(screen.getByTestId('dc-contribute-tab-upload'));
    expect(screen.getByTestId('dc-contribute-upload-note').textContent?.replace(/\s+/g, ' ').trim()).toBe(
      "Your upload is not posted on Civitai. It is shared with this dataset's viewers once Civitai has scanned it and rated it PG or PG-13.",
    );
  }, 15000);
});

describe('the Upload tab shares the upload', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it('asks the host for a display upload with share: true, and uses the image it returns', async () => {
    const user = userEvent.setup();
    const outbound: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const opened = await openDataset(
      {},
      { onOutbound: (message) => outbound.push(message as { type: string; payload?: Record<string, unknown> }) },
    );
    uninstall = opened.uninstall;

    await user.click(await screen.findByTestId('dc-add-image'));
    await user.click(screen.getByTestId('dc-contribute-tab-upload'));
    await user.click(screen.getByTestId('dc-contribute-upload'));

    // The mock host predates the `shared` echo, as today's civitai does: the upload is
    // kept private, and the tab says so rather than claiming it is shared.
    const uploaded = await screen.findByTestId('dc-contribute-uploaded', {}, { timeout: 5000 });
    expect(uploaded).toHaveTextContent(/Uploaded image #\d+ selected/);
    expect(uploaded).toHaveTextContent("Kept private (this Civitai version doesn't support sharing yet).");
    expect(uploaded).not.toHaveTextContent(/will be shared/);
    const uploads = outbound.filter((m) => m.type === 'OPEN_IMAGE_UPLOAD');
    expect(uploads).toHaveLength(1);
    const { requestId, ...rest } = uploads[0]!.payload ?? {};
    expect(typeof requestId).toBe('string');
    // Shared, and otherwise exactly the default display upload: no purpose, no asyncScan.
    expect(rest).toEqual({ share: true });
  }, 15000);

  it('says the upload will be shared only when the host echoes shared: true', async () => {
    const user = userEvent.setup();
    const opened = await openDataset(
      {},
      {
        // A host that recorded the share. Replied synchronously, so it settles the
        // request before the mock host's own canned image.
        onOutbound: (message) => {
          const m = message as { type: string; payload?: { requestId?: string } };
          if (m.type !== 'OPEN_IMAGE_UPLOAD') return;
          window.dispatchEvent(
            new MessageEvent('message', {
              data: {
                type: 'IMAGE_UPLOAD_RESULT',
                payload: {
                  requestId: m.payload?.requestId,
                  selected: {
                    imageId: 7701,
                    nsfwLevel: 1,
                    contentRating: 'pg',
                    url: 'https://image.civitai.com/x/original=true/u.jpeg',
                  },
                  shared: true,
                },
              },
              origin: window.location.origin,
            }),
          );
        },
      },
    );
    uninstall = opened.uninstall;

    await user.click(await screen.findByTestId('dc-add-image'));
    await user.click(screen.getByTestId('dc-contribute-tab-upload'));
    await user.click(screen.getByTestId('dc-contribute-upload'));

    const uploaded = await screen.findByTestId('dc-contribute-uploaded', {}, { timeout: 5000 });
    expect(uploaded.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      "Uploaded image #7701 selected. It will be shared with this dataset's viewers once Civitai has scanned it and rated it PG or PG-13.",
    );
  }, 15000);

  it('shows the host refusal of a shared upload, never treating it as a dismissed picker', async () => {
    const user = userEvent.setup();
    const opened = await openDataset(
      {},
      {
        // The host refuses a shared upload it cannot attribute. Replied synchronously,
        // so it settles the request before the mock host's own canned image.
        onOutbound: (message) => {
          const m = message as { type: string; payload?: { requestId?: string } };
          if (m.type !== 'OPEN_IMAGE_UPLOAD') return;
          window.dispatchEvent(
            new MessageEvent('message', {
              data: { type: 'IMAGE_UPLOAD_RESULT', payload: { requestId: m.payload?.requestId, error: 'no block token' } },
              origin: window.location.origin,
            }),
          );
        },
      },
    );
    uninstall = opened.uninstall;

    await user.click(await screen.findByTestId('dc-add-image'));
    await user.click(screen.getByTestId('dc-contribute-tab-upload'));
    await user.click(screen.getByTestId('dc-contribute-upload'));

    expect(await screen.findByTestId('dc-contribute-error', {}, { timeout: 5000 })).toHaveTextContent(
      'Civitai could not take this upload: no block token',
    );
    expect(screen.queryByTestId('dc-contribute-uploaded')).not.toBeInTheDocument();
  }, 15000);
});

describe('"Save #N" on posted images', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  const items: DatasetItem[] = [
    { itemId: 'a', contributorId: 'alice', imageUrl: `https://civitai.com/images/${POSTED_A}`, imageId: POSTED_A, caption: 'front', netVotes: 3 },
    { itemId: 'x', contributorId: 'bob', imageUrl: `https://civitai.com/images/${MATURE_X}`, imageId: MATURE_X, caption: 'profile', netVotes: 1 },
  ];

  function renderTrain(host: MockMoneyHostOptions) {
    stubCatalog();
    const outbound: Array<{ type: string; payload?: unknown }> = [];
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      gatedImages: [],
      onOutbound: (message) => outbound.push(message as { type: string; payload?: unknown }),
      ...host,
    });
    render(<TrainFlow initialItems={items} datasetId="ds-posted" trainerId="dev" allowLocalUploads={false} />);
    return outbound;
  }

  it('saves a posted image by its full-size catalog original, not by id through the gated read', async () => {
    const user = userEvent.setup();
    const outbound = renderTrain({});
    await screen.findByTestId('dc-train');

    // The catalog read settles before the click, or the save could only go by id.
    const button = await screen.findByTestId('dc-train-save-a');
    await waitFor(() => expect(button).toHaveAttribute('data-save-by', 'url'), { timeout: 5000 });
    await user.click(button);

    await waitFor(() => expect(outbound.some((m) => m.type === 'SAVE_IMAGE')).toBe(true));
    const save = outbound.find((m) => m.type === 'SAVE_IMAGE')!.payload as Record<string, unknown>;
    expect(save.url).toBe(originalUrl(POSTED_A));
    expect(save).not.toHaveProperty('imageId');
    expect(save.filename).toBe('open-datasets-01');
  }, 15000);

  it('never saves an image hidden from this viewer by its catalog url', async () => {
    const user = userEvent.setup();
    const outbound = renderTrain({ maxBrowsingLevel: ALL_RATED, viewerBrowsingLevel: PG });
    await screen.findByTestId('dc-train');

    // The PG image resolving proves the catalog read has settled for both.
    await waitFor(() => expect(screen.getByTestId('dc-train-save-a')).toHaveAttribute('data-save-by', 'url'), {
      timeout: 5000,
    });
    const hidden = screen.getByTestId('dc-train-save-x');
    expect(hidden).toHaveAttribute('data-save-by', 'id');
    await user.click(hidden);

    await waitFor(() => expect(outbound.some((m) => m.type === 'SAVE_IMAGE')).toBe(true));
    const save = outbound.find((m) => m.type === 'SAVE_IMAGE')!.payload as Record<string, unknown>;
    expect(save).not.toHaveProperty('url');
    expect(save.imageId).toBe(MATURE_X);
  }, 15000);
});
