import { describe, expect, it, vi } from 'vitest';

import type { BlockGatedImage } from '@civitai/app-sdk/blocks';

import { parseCatalogImages, resolveItemImages, saveTargetForItem } from './item-images.js';

const url = (id: number) => `https://image.civitai.com/k/original=true/${id}.jpeg`;
const catalogBody = (ids: number[]) => ({ items: ids.map((id) => ({ id, url: url(id), width: 512, height: 640 })) });
const gatedVisible = (id: number): BlockGatedImage => ({
  imageId: id,
  status: 'visible',
  url: `https://image.civitai.com/k/gated/${id}.jpeg`,
  width: null,
  height: null,
  ratingPending: true,
});

describe('parseCatalogImages', () => {
  it('keeps only asked-for ids with an https url, as visible images', () => {
    const body = {
      items: [
        { id: 11, url: url(11), width: 512, height: 640 },
        { id: 12, url: url(12) }, // not asked for
        { id: 13, url: 'http://image.civitai.com/x.jpeg' }, // not https
        { id: 14, url: 'not a url' },
        { id: '15', url: url(15) }, // id not a number
        { id: 16 }, // no url
      ],
    };
    expect(parseCatalogImages(body, new Set([11, 13, 14, 15, 16]))).toEqual([
      { imageId: 11, status: 'visible', url: url(11), width: 512, height: 640 },
    ]);
  });

  it('reads a body without items as nothing', () => {
    expect(parseCatalogImages({ error: 'x' }, new Set([1]))).toEqual([]);
    expect(parseCatalogImages(null, new Set([1]))).toEqual([]);
  });
});

describe('resolveItemImages', () => {
  it('asks the gated read only for the ids the catalog did not return', async () => {
    const catalog = vi.fn(async (ids: number[]) => catalogBody(ids.filter((id) => id !== 3)));
    const gated = vi.fn(async (ids: number[]) => ids.map(gatedVisible));
    const found = await resolveItemImages([1, 2, 3, 2], { catalog, gated });
    expect(catalog).toHaveBeenCalledWith([1, 2, 3]);
    expect(gated).toHaveBeenCalledWith([3]);
    expect(found.get(1)).toMatchObject({ status: 'visible', url: url(1) });
    expect(found.get(3)).toMatchObject({ status: 'visible', url: 'https://image.civitai.com/k/gated/3.jpeg' });
    expect([...found.keys()].sort()).toEqual([1, 2, 3]);
  });

  it('keeps the gated answer when the catalog fails, and the catalog answer when the gated read fails', async () => {
    const down = async () => {
      throw new Error('down');
    };
    const onlyGated = await resolveItemImages([7], { catalog: down, gated: async (ids) => ids.map(gatedVisible) });
    expect(onlyGated.get(7)).toMatchObject({ status: 'visible' });

    const onlyCatalog = await resolveItemImages([7, 8], { catalog: async () => catalogBody([7]), gated: down });
    expect([...onlyCatalog.keys()]).toEqual([7]);
  });

  it('ignores a gated image for an id it was not asked for', async () => {
    const found = await resolveItemImages([5], {
      catalog: async () => catalogBody([5]),
      gated: async () => [gatedVisible(5), gatedVisible(6)],
    });
    expect(found.get(5)).toMatchObject({ url: url(5) });
    expect(found.has(6)).toBe(false);
  });

  it('splits the catalog read at the route ceiling of 100 ids', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => i + 1);
    const catalog = vi.fn(async (chunk: number[]) => catalogBody(chunk));
    const found = await resolveItemImages(ids, { catalog, gated: async () => [] });
    expect(catalog.mock.calls.map(([chunk]) => chunk.length)).toEqual([100, 50]);
    expect(found.size).toBe(150);
  });

  it('with no catalog yet, uses the gated read alone', async () => {
    const found = await resolveItemImages([9], { catalog: null, gated: async (ids) => ids.map(gatedVisible) });
    expect(found.get(9)).toMatchObject({ status: 'visible' });
  });
});

describe('saveTargetForItem', () => {
  const resolved = new Map<number, BlockGatedImage>([
    [21, { imageId: 21, status: 'visible', url: url(21), width: 1, height: 1 }],
    [22, { imageId: 22, status: 'hidden' }],
  ]);

  it('saves a visible image by its resolved url', () => {
    expect(saveTargetForItem({ imageId: 21, imageUrl: 'https://civitai.com/images/21' }, resolved)).toEqual({ url: url(21) });
  });

  it('falls back to the id for a hidden or unresolved image, and to the stored url without an id', () => {
    expect(saveTargetForItem({ imageId: 22, imageUrl: 'https://civitai.com/images/22' }, resolved)).toEqual({ imageId: 22 });
    expect(saveTargetForItem({ imageId: 23, imageUrl: 'https://civitai.com/images/23' }, resolved)).toEqual({ imageId: 23 });
    expect(saveTargetForItem({ imageUrl: 'https://image.civitai.com/k/x.jpeg' }, resolved)).toEqual({
      url: 'https://image.civitai.com/k/x.jpeg',
    });
  });
});
