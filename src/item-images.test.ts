import { describe, expect, it, vi } from 'vitest';

import type { BlockGatedImage } from '@civitai/app-sdk/blocks';

import {
  GRID_IMAGE_EDGE_WIDTH,
  gridEdgeUrl,
  parseCatalogImages,
  resolveItemImages,
  saveTargetForItem,
  viewerImageCeiling,
  type ItemImage,
  type ViewerImageCeiling,
} from './item-images.js';

// Browsing-level bits (civitai): PG 1, PG13 2, R 4, X 8, XXX 16.
const PG = 1;
const PG13 = 2;
const R = 4;
const X = 8;
const ALL_RATED = PG | PG13 | R | X | 16;

const original = (id: number) => `https://image.civitai.com/k${id}/guid-${id}/original=true/img-${id}.jpeg`;
const grid = (id: number) => `https://image.civitai.com/k${id}/guid-${id}/width=1200/img-${id}.jpeg`;
const catalogItem = (id: number, browsingLevel = PG, type = 'image') => ({
  id,
  url: original(id),
  type,
  browsingLevel,
  width: 512,
  height: 640,
});
const catalogBody = (ids: number[], browsingLevel = PG) => ({ items: ids.map((id) => catalogItem(id, browsingLevel)) });
const gatedVisible = (id: number): BlockGatedImage => ({
  imageId: id,
  status: 'visible',
  url: `https://image.civitai.com/gated/${id}/width=1200/g.jpeg`,
  width: null,
  height: null,
  ratingPending: true,
});

/** A viewer whose own level is PG only, on a domain that allows everything. */
const PG_VIEWER: ViewerImageCeiling = { mask: PG, viewerKnown: true };
const ANY_VIEWER: ViewerImageCeiling = { mask: ALL_RATED, viewerKnown: true };
const UNKNOWN_VIEWER: ViewerImageCeiling = { mask: PG | PG13, viewerKnown: false };

describe('viewerImageCeiling', () => {
  it('narrows the domain ceiling to the viewer level when the host sends one', () => {
    expect(viewerImageCeiling({ maxBrowsingLevel: ALL_RATED, effectiveBrowsingLevel: PG | PG13 })).toEqual({
      mask: PG | PG13,
      viewerKnown: true,
    });
    // A viewer level wider than the domain never widens it.
    expect(viewerImageCeiling({ maxBrowsingLevel: PG | PG13, effectiveBrowsingLevel: ALL_RATED })).toEqual({
      mask: PG | PG13,
      viewerKnown: true,
    });
  });

  it('is PG and PG13 only when the host sends no viewer level, whatever the domain allows', () => {
    expect(viewerImageCeiling({ maxBrowsingLevel: ALL_RATED })).toEqual({ mask: PG | PG13, viewerKnown: false });
  });
});

describe('gridEdgeUrl', () => {
  it('turns an original into the width-limited grid form', () => {
    expect(GRID_IMAGE_EDGE_WIDTH).toBe(1200);
    expect(gridEdgeUrl(original(3))).toBe(grid(3));
  });

  it('passes through a url without an original segment', () => {
    expect(gridEdgeUrl('https://image.civitai.com/k/guid/width=450/a.jpeg')).toBe(
      'https://image.civitai.com/k/guid/width=450/a.jpeg',
    );
    expect(gridEdgeUrl('not a url')).toBe('not a url');
  });
});

describe('parseCatalogImages', () => {
  it('keeps asked-for images with an https url: grid url for display, original for saving', () => {
    const body = {
      items: [
        catalogItem(11, PG13),
        catalogItem(12), // not asked for
        { ...catalogItem(13), url: 'http://image.civitai.com/x.jpeg' }, // not https
        { ...catalogItem(14), url: 'not a url' },
        { ...catalogItem(15), id: '15' }, // id not a number
        catalogItem(16, PG, 'video'), // a video never lands in <img>
        { id: 17, type: 'image', browsingLevel: PG }, // no url
      ],
    };
    expect(parseCatalogImages(body, new Set([11, 13, 14, 15, 16, 17]), ANY_VIEWER)).toEqual([
      { imageId: 11, status: 'visible', nsfwLevel: PG13, url: grid(11), saveUrl: original(11), width: 512, height: 640 },
    ]);
  });

  it('hides an image above a known viewer level, and drops it when the viewer level is unknown', () => {
    const body = { items: [catalogItem(21, X), catalogItem(22, PG), catalogItem(23, R)] };
    const asked = new Set([21, 22, 23]);
    expect(parseCatalogImages(body, asked, PG_VIEWER)).toEqual([
      { imageId: 21, status: 'hidden' },
      expect.objectContaining({ imageId: 22, status: 'visible' }),
      { imageId: 23, status: 'hidden' },
    ]);
    expect(parseCatalogImages(body, asked, UNKNOWN_VIEWER).map((i) => [i.imageId, i.status])).toEqual([[22, 'visible']]);
  });

  it('treats a missing or malformed browsingLevel as outside every ceiling', () => {
    const body = { items: [{ ...catalogItem(31), browsingLevel: undefined }, { ...catalogItem(32), browsingLevel: 'None' }] };
    expect(parseCatalogImages(body, new Set([31, 32]), ANY_VIEWER)).toEqual([
      { imageId: 31, status: 'hidden' },
      { imageId: 32, status: 'hidden' },
    ]);
  });

  it('reads a body without items as nothing', () => {
    expect(parseCatalogImages({ error: 'x' }, new Set([1]), ANY_VIEWER)).toEqual([]);
    expect(parseCatalogImages(null, new Set([1]), ANY_VIEWER)).toEqual([]);
  });
});

describe('resolveItemImages', () => {
  it('runs both reads on every id; the gated answer wins, the catalog fills the rest', async () => {
    const catalog = vi.fn(async (ids: number[]) => catalogBody(ids));
    const gated = vi.fn(async (ids: number[]) => ids.filter((id) => id === 3).map(gatedVisible));
    const found = await resolveItemImages([1, 2, 3, 2], { catalog, gated, ceiling: ANY_VIEWER });
    expect(catalog).toHaveBeenCalledWith([1, 2, 3], expect.any(AbortSignal));
    expect(gated).toHaveBeenCalledWith([1, 2, 3]);
    expect(found.get(1)).toMatchObject({ status: 'visible', url: grid(1) });
    expect(found.get(3)).toMatchObject({ status: 'visible', url: 'https://image.civitai.com/gated/3/width=1200/g.jpeg' });
    expect([...found.keys()].sort()).toEqual([1, 2, 3]);
  });

  it('starts the gated read without waiting for the catalog', async () => {
    let releaseCatalog: (body: unknown) => void = () => {};
    const catalog = vi.fn(() => new Promise<unknown>((resolve) => (releaseCatalog = resolve)));
    const gated = vi.fn(async (ids: number[]) => ids.map(gatedVisible));
    const pending = resolveItemImages([4], { catalog, gated, ceiling: ANY_VIEWER });
    expect(gated).toHaveBeenCalledWith([4]);
    releaseCatalog(catalogBody([]));
    expect((await pending).get(4)).toMatchObject({ status: 'visible' });
  });

  it('gives up on a stalled catalog at the deadline, aborts it, and keeps the gated answer', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const catalog = vi.fn((_ids: number[], s?: AbortSignal) => {
        signal = s;
        return new Promise<unknown>(() => {});
      });
      const pending = resolveItemImages([5, 6], {
        catalog,
        gated: async (ids) => ids.filter((id) => id === 5).map(gatedVisible),
        ceiling: ANY_VIEWER,
        deadlineMs: 2500,
      });
      await vi.advanceTimersByTimeAsync(2499);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const found = await pending;
      expect(signal?.aborted).toBe(true);
      expect([...found.keys()]).toEqual([5]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the gated answer when the catalog fails, and the catalog answer when the gated read fails', async () => {
    const down = async () => {
      throw new Error('down');
    };
    const onlyGated = await resolveItemImages([7], {
      catalog: down,
      gated: async (ids) => ids.map(gatedVisible),
      ceiling: ANY_VIEWER,
    });
    expect(onlyGated.get(7)).toMatchObject({ status: 'visible' });

    const onlyCatalog = await resolveItemImages([7, 8], {
      catalog: async () => catalogBody([7]),
      gated: down,
      ceiling: ANY_VIEWER,
    });
    expect([...onlyCatalog.keys()]).toEqual([7]);
  });

  it('ignores a gated image for an id it was not asked for', async () => {
    const found = await resolveItemImages([5], {
      catalog: async () => catalogBody([5]),
      gated: async () => [gatedVisible(6)],
      ceiling: ANY_VIEWER,
    });
    expect(found.get(5)).toMatchObject({ url: grid(5) });
    expect(found.has(6)).toBe(false);
  });

  it('applies the viewer ceiling to catalog images', async () => {
    const found = await resolveItemImages([9], {
      catalog: async () => catalogBody([9], X),
      gated: async () => [],
      ceiling: PG_VIEWER,
    });
    expect(found.get(9)).toEqual({ imageId: 9, status: 'hidden' });
  });

  it('splits the catalog read at the route ceiling of 100 ids', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => i + 1);
    const catalog = vi.fn(async (chunk: number[]) => catalogBody(chunk));
    const found = await resolveItemImages(ids, { catalog, gated: async () => [], ceiling: ANY_VIEWER });
    expect(catalog.mock.calls.map(([chunk]) => chunk.length)).toEqual([100, 50]);
    expect(found.size).toBe(150);
  });

  it('splits the gated read at its 100-id ceiling, and every chunk answer reaches the result', async () => {
    const ids = Array.from({ length: 230 }, (_, i) => i + 1);
    // Models the host: it answers at most the first 100 ids of a call and drops the rest.
    const gated = vi.fn(async (chunk: number[]) => chunk.slice(0, 100).map(gatedVisible));
    const found = await resolveItemImages(ids, { catalog: null, gated, ceiling: ANY_VIEWER });
    expect(gated.mock.calls.map(([chunk]) => chunk.length)).toEqual([100, 100, 30]);
    expect(found.size).toBe(230);
    expect(found.get(230)).toMatchObject({ status: 'visible', url: 'https://image.civitai.com/gated/230/width=1200/g.jpeg' });
  });

  it('a failed gated chunk loses only its own ids', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => i + 1);
    const gated = vi.fn(async (chunk: number[]) => {
      if (chunk[0] === 1) throw new Error('down');
      return chunk.map(gatedVisible);
    });
    const found = await resolveItemImages(ids, { catalog: null, gated, ceiling: ANY_VIEWER });
    expect(found.size).toBe(50);
    expect(found.has(100)).toBe(false);
    expect(found.has(101)).toBe(true);
  });

  it('with no catalog yet, uses the gated read alone', async () => {
    const found = await resolveItemImages([9], {
      catalog: null,
      gated: async (ids) => ids.map(gatedVisible),
      ceiling: ANY_VIEWER,
    });
    expect(found.get(9)).toMatchObject({ status: 'visible' });
  });
});

describe('saveTargetForItem', () => {
  const resolved = new Map<number, ItemImage>([
    [21, { imageId: 21, status: 'visible', url: grid(21), saveUrl: original(21), width: 1, height: 1 }],
    [22, { imageId: 22, status: 'hidden' }],
    [24, gatedVisible(24)],
  ]);

  it('saves a visible catalog image by its full-size original, a gated one by its url', () => {
    expect(saveTargetForItem({ imageId: 21, imageUrl: 'https://civitai.com/images/21' }, resolved)).toEqual({
      url: original(21),
    });
    expect(saveTargetForItem({ imageId: 24, imageUrl: 'https://civitai.com/images/24' }, resolved)).toEqual({
      url: 'https://image.civitai.com/gated/24/width=1200/g.jpeg',
    });
  });

  it('falls back to the id for a hidden or unresolved image, and to the stored url without an id', () => {
    expect(saveTargetForItem({ imageId: 22, imageUrl: 'https://civitai.com/images/22' }, resolved)).toEqual({ imageId: 22 });
    expect(saveTargetForItem({ imageId: 23, imageUrl: 'https://civitai.com/images/23' }, resolved)).toEqual({ imageId: 23 });
    expect(saveTargetForItem({ imageUrl: 'https://image.civitai.com/k/x.jpeg' }, resolved)).toEqual({
      url: 'https://image.civitai.com/k/x.jpeg',
    });
  });
});
