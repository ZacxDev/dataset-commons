import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useImageUpload } from '@civitai/blocks-react';
import type { BlockSharedUploadImageInfo } from '@civitai/app-sdk/blocks';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

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

  it('the Upload tab says the upload is not posted and stays private unless shared; Share starts off', async () => {
    const user = userEvent.setup();
    const opened = await openDataset({}, {});
    uninstall = opened.uninstall;

    await user.click(await screen.findByTestId('dc-add-image'));
    await user.click(screen.getByTestId('dc-contribute-tab-upload'));
    expect(screen.getByTestId('dc-contribute-upload-note').textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Your upload is not posted on Civitai, and it stays private to you unless you choose to share it.',
    );
    expect(screen.getByTestId('dc-contribute-share')).not.toBeChecked();
  }, 15000);
});

describe('the Upload tab: private by default, shared only when chosen', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  // An image id the mock host's default upload cannot produce, so the copy below
  // can only name it if the tab rendered THIS reply.
  const UPLOADED = {
    imageId: 7701,
    nsfwLevel: 1,
    contentRating: 'pg',
    url: 'https://image.civitai.com/x/original=true/u.jpeg',
  } as const;
  const SHARED_COPY =
    "Uploaded image #7701 selected. It will be shared with this dataset's viewers once Civitai has scanned it and rated it PG or PG-13.";
  const PRIVATE_COPY =
    "Uploaded image #7701 selected. Kept private: Civitai didn't confirm sharing for this upload, so only you can see it.";
  const PRIVATE_BY_CHOICE_COPY = 'Uploaded image #7701 selected. Kept private: only you can see it.';
  const REFUSED_COPY =
    "Civitai couldn't take this upload just now, so nothing was added. Try again, or choose an image from My Images or paste a link.";
  const text = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ').trim();

  async function clickUpload(user: ReturnType<typeof userEvent.setup>, opts: { share: boolean }) {
    await user.click(await screen.findByTestId('dc-add-image'));
    await user.click(screen.getByTestId('dc-contribute-tab-upload'));
    if (opts.share) await user.click(screen.getByTestId('dc-contribute-share'));
    await user.click(screen.getByTestId('dc-contribute-upload'));
  }

  it('with Share left off, asks the host for a plain display upload (no share) and says it is private', async () => {
    const user = userEvent.setup();
    const outbound: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    // The host would echo shared: true if asked: the app must not ask.
    const opened = await openDataset(
      {},
      {
        cannedImageUpload: UPLOADED,
        cannedImageUploadShared: true,
        onOutbound: (message) => outbound.push(message as { type: string; payload?: Record<string, unknown> }),
      },
    );
    uninstall = opened.uninstall;

    await clickUpload(user, { share: false });

    const uploaded = await screen.findByTestId('dc-contribute-uploaded', {}, { timeout: 5000 });
    expect(text(uploaded)).toBe(PRIVATE_BY_CHOICE_COPY);
    const uploads = outbound.filter((m) => m.type === 'OPEN_IMAGE_UPLOAD');
    expect(uploads).toHaveLength(1);
    const { requestId, ...rest } = uploads[0]!.payload ?? {};
    expect(typeof requestId).toBe('string');
    // Not shared: no `share` on the wire at all (the SDK sends it only when true).
    expect(rest).toEqual({});
  }, 15000);

  for (const share of [false, true]) {
    it(`an uploaded contribution (Share ${share ? 'ticked' : 'off'}) is stored by image id only: no image url in the shared item`, async () => {
      const user = userEvent.setup();
      const opened = await openDataset({}, { cannedImageUpload: UPLOADED, cannedImageUploadShared: share });
      uninstall = opened.uninstall;

      await clickUpload(user, { share });
      await screen.findByTestId('dc-contribute-uploaded', {}, { timeout: 5000 });
      await user.type(screen.getByTestId('dc-contribute-caption'), 'uploaded portrait');
      await user.click(screen.getByTestId('dc-contribute-rights'));
      await user.click(screen.getByTestId('dc-contribute-submit'));

      // What every viewer of the dataset can read: the stored item document.
      await waitFor(
        async () => {
          const docs = (await testDocStore().storage.collection('items').list()).items;
          const mine = docs.map((d) => d.data as Record<string, unknown>).filter((d) => d.caption === 'uploaded portrait');
          expect(mine).toHaveLength(1);
          expect(mine[0]!.imageId).toBe(7701);
          expect(mine[0]!.imageRef).toBe('');
          expect(JSON.stringify(mine[0])).not.toContain('image.civitai.com');
        },
        { timeout: 5000 },
      );
    }, 20000);
  }

  it('with Share ticked, asks the host for a display upload with share: true, and says it will be shared when the host echoes shared: true', async () => {
    const user = userEvent.setup();
    const outbound: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const opened = await openDataset(
      {},
      {
        cannedImageUpload: UPLOADED,
        cannedImageUploadShared: true,
        onOutbound: (message) => outbound.push(message as { type: string; payload?: Record<string, unknown> }),
      },
    );
    uninstall = opened.uninstall;

    await clickUpload(user, { share: true });

    const uploaded = await screen.findByTestId('dc-contribute-uploaded', {}, { timeout: 5000 });
    expect(text(uploaded)).toBe(SHARED_COPY);
    const uploads = outbound.filter((m) => m.type === 'OPEN_IMAGE_UPLOAD');
    expect(uploads).toHaveLength(1);
    const { requestId, ...rest } = uploads[0]!.payload ?? {};
    expect(typeof requestId).toBe('string');
    // Shared, and otherwise exactly the default display upload: no purpose, no asyncScan.
    expect(rest).toEqual({ share: true });
  }, 15000);

  it('with Share ticked, says the upload is kept private when the host answers shared: false', async () => {
    const user = userEvent.setup();
    const opened = await openDataset({}, { cannedImageUpload: UPLOADED, cannedImageUploadShared: false });
    uninstall = opened.uninstall;

    await clickUpload(user, { share: true });

    const uploaded = await screen.findByTestId('dc-contribute-uploaded', {}, { timeout: 5000 });
    expect(text(uploaded)).toBe(PRIVATE_COPY);
    expect(uploaded).not.toHaveTextContent(/will be shared/);
  }, 15000);

  it("a no-token refusal shows a calm message, selects nothing, and leaves the Upload tab working", async () => {
    const user = userEvent.setup();
    const opened = await openDataset({}, { cannedImageUpload: UPLOADED, imageUploadShareRefused: true });
    uninstall = opened.uninstall;

    await clickUpload(user, { share: true });

    expect(text(await screen.findByTestId('dc-contribute-error', {}, { timeout: 5000 }))).toContain(REFUSED_COPY);
    expect(screen.getByTestId('dc-contribute-error')).not.toHaveTextContent(/no block token/);
    expect(screen.queryByTestId('dc-contribute-uploaded')).not.toBeInTheDocument();

    // The tab survived the rejection: once the host can share, the same button uploads.
    opened.uninstall.setScenario({ imageUploadShareRefused: false, cannedImageUploadShared: true });
    await user.click(screen.getByTestId('dc-contribute-upload'));
    expect(text(await screen.findByTestId('dc-contribute-uploaded', {}, { timeout: 5000 }))).toBe(SHARED_COPY);
    expect(screen.queryByTestId('dc-contribute-error')).not.toBeInTheDocument();
  }, 15000);

  it('the share hook is typed: open() resolves with `shared` at the call the Upload tab makes, no cast', () => {
    // Compile-time only (never called): `npm run typecheck` fails here on an SDK
    // whose useImageUpload has no `share` option or no typed `shared` echo.
    function uploadTabOpen() {
      return useImageUpload({ share: true }).open();
    }
    expectTypeOf<Awaited<ReturnType<typeof uploadTabOpen>>>().toEqualTypeOf<BlockSharedUploadImageInfo | null>();
    expectTypeOf<BlockSharedUploadImageInfo['shared']>().toEqualTypeOf<boolean>();
  });
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
