/**
 * Dataset Commons — how a dataset item's `imageId` becomes a picture on screen.
 *
 * Items reference images the APP DID NOT MAKE: a contributor links a Civitai
 * image, or picks one of their own posted images. The host's per-viewer gated
 * read (`useGatedImages`, `GET_IMAGES_BY_IDS`) cannot see those by design: it
 * answers only BARE (unposted) images that THIS app's own workflows published.
 * So a dataset built from posted images resolved to nothing at all, every item
 * read as "still being rated" and "Save #N" failed with "image is not
 * available", for every viewer, the owner included.
 *
 * Two reads, each scoped by the server, never by this app:
 *
 * 1. The block image CATALOG, `GET /api/v1/blocks/images?ids=…`: public posted
 *    images, clamped server-side to the block token's maturity ceiling. A posted
 *    item resolves here.
 * 2. The gated read, for whatever the catalog did not return: this app's own
 *    unposted outputs, including the viewer's own not-yet-rated ones and the
 *    `hidden` placeholder state.
 *
 * Each read fails on its own: a catalog outage still leaves the gated read's
 * answer, and the reverse. An id neither read returns stays unresolved. That
 * covers an image that is unposted and not this app's (a bare upload), a
 * private post, or one above the viewer's ceiling; the two reads cannot tell
 * these apart.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useBlockToken, useGatedImages, useHostOrigin } from '@civitai/blocks-react';
import { initialize, type AppClient } from '@civitai/sdk';
import type { BlockGatedImage } from '@civitai/app-sdk/blocks';

import { apiBaseUrl } from './doc-storage.js';

/** The catalog route's own `ids` ceiling (civitai `IMAGE_IDS_BATCH_MAX`). */
export const CATALOG_IDS_MAX = 100;

/** The block catalog route, relative to `<origin>/api/v1`. */
export const CATALOG_IMAGES_PATH = 'blocks/images';

/** Fetch one catalog page for at most {@link CATALOG_IDS_MAX} ids; resolves with the raw JSON body. */
export type CatalogImagesFetch = (imageIds: number[]) => Promise<unknown>;

/** The gated read (`useGatedImages().getImages`). */
export type GatedImagesFetch = (imageIds: number[]) => Promise<BlockGatedImage[]>;

const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
const dimension = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/**
 * The catalog body's `items` as visible images. Only an item with a positive
 * integer `id` and an `https:` `url` is kept, and only when its id was ASKED
 * for, so an unexpected reply cannot add a picture to an item it does not name.
 */
export function parseCatalogImages(body: unknown, asked: ReadonlySet<number>): BlockGatedImage[] {
  const items = (body as { items?: unknown } | null | undefined)?.items;
  if (!Array.isArray(items)) return [];
  const out: BlockGatedImage[] = [];
  for (const raw of items) {
    const item = raw as { id?: unknown; url?: unknown; width?: unknown; height?: unknown } | null;
    if (!item || !isPositiveInt(item.id) || !asked.has(item.id)) continue;
    if (typeof item.url !== 'string') continue;
    let url: URL;
    try {
      url = new URL(item.url);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:') continue;
    out.push({
      imageId: item.id,
      status: 'visible',
      url: item.url,
      width: dimension(item.width),
      height: dimension(item.height),
    });
  }
  return out;
}

/** Deduplicated positive integer ids, in first-seen order. */
export function normalizeImageIds(imageIds: readonly number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const id of imageIds) {
    if (!isPositiveInt(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Resolve item image ids to displayable images: catalog first (in chunks of
 * {@link CATALOG_IDS_MAX}), then the gated read for the ids the catalog did not
 * return. A failed read contributes nothing and never discards the other's.
 */
export async function resolveItemImages(
  imageIds: readonly number[],
  deps: { catalog: CatalogImagesFetch | null; gated: GatedImagesFetch },
): Promise<Map<number, BlockGatedImage>> {
  const ids = normalizeImageIds(imageIds);
  const resolved = new Map<number, BlockGatedImage>();
  if (ids.length === 0) return resolved;

  if (deps.catalog) {
    const catalog = deps.catalog;
    const chunks: number[][] = [];
    for (let i = 0; i < ids.length; i += CATALOG_IDS_MAX) chunks.push(ids.slice(i, i + CATALOG_IDS_MAX));
    const pages = await Promise.all(
      chunks.map((chunk) =>
        catalog(chunk).then(
          (body) => parseCatalogImages(body, new Set(chunk)),
          () => [] as BlockGatedImage[],
        ),
      ),
    );
    for (const page of pages) for (const image of page) resolved.set(image.imageId, image);
  }

  const missing = ids.filter((id) => !resolved.has(id));
  if (missing.length > 0) {
    const asked = new Set(missing);
    const gated = await deps.gated(missing).catch(() => [] as BlockGatedImage[]);
    for (const image of gated) {
      if (asked.has(image.imageId) && !resolved.has(image.imageId)) resolved.set(image.imageId, image);
    }
  }
  return resolved;
}

/** One SDK client per origin, created on first use; a rejection is never cached. */
function createCatalogFetch(deps: {
  origin: string;
  getToken: () => string;
  refreshToken: () => Promise<string>;
}): CatalogImagesFetch {
  let client: Promise<AppClient> | null = null;
  const app = () => {
    if (client === null) {
      const pending = initialize({
        token: () => deps.getToken(),
        refresh: () => deps.refreshToken(),
        siteUrl: apiBaseUrl(deps.origin),
      }).catch((err: unknown) => {
        if (client === pending) client = null;
        throw err;
      });
      client = pending;
    }
    return client;
  };
  return async (imageIds) =>
    (await app()).site.get(CATALOG_IMAGES_PATH, {
      // Comma-joined, the form the route parses; `limit` so one page holds every id asked for.
      query: { ids: imageIds.join(','), limit: imageIds.length },
    });
}

/**
 * The catalog read for this render, or `null` until the host origin and the
 * block token are known. Stable per origin, like `useDocumentStorage`.
 */
export function useCatalogImagesFetch(): CatalogImagesFetch | null {
  const origin = useHostOrigin();
  const token = useBlockToken();
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const hasToken = typeof token.raw === 'string' && token.raw.length > 0;
  return useMemo(() => {
    if (!origin || !hasToken) return null;
    return createCatalogFetch({
      origin,
      getToken: () => tokenRef.current.raw,
      refreshToken: async () => (await tokenRef.current.refresh()).raw,
    });
  }, [origin, hasToken]);
}

/**
 * The resolved images for `imageIds`, keyed by image id. Empty until the reads
 * settle; an id absent from the map is unresolved (see the module note).
 */
export function useItemImages(imageIds: readonly number[]): ReadonlyMap<number, BlockGatedImage> {
  const { getImages } = useGatedImages();
  const catalog = useCatalogImagesFetch();
  const key = normalizeImageIds(imageIds).join(',');
  const [images, setImages] = useState<ReadonlyMap<number, BlockGatedImage>>(new Map());
  const resolve = useCallback(
    (ids: number[]) => resolveItemImages(ids, { catalog, gated: getImages }),
    [catalog, getImages],
  );
  useEffect(() => {
    let alive = true;
    const ids = key === '' ? [] : key.split(',').map(Number);
    if (ids.length === 0) {
      setImages(new Map());
      return () => {
        alive = false;
      };
    }
    void resolve(ids).then((found) => {
      if (alive) setImages(found);
    });
    return () => {
      alive = false;
    };
  }, [key, resolve]);
  return images;
}

/** What `useSaveImage().saveImage` is asked for (without the filename). */
export type ItemSaveTarget = { url: string } | { imageId: number };

/**
 * How "Save #N" fetches an item: by the resolved image's url when one of the
 * reads above returned it visible. Saving by `imageId` goes through the host's
 * gated read, which refuses every posted image (see the module note).
 * Otherwise by id, and last by the stored url.
 */
export function saveTargetForItem(
  item: { imageId?: number; imageUrl: string },
  resolved: ReadonlyMap<number, BlockGatedImage>,
): ItemSaveTarget {
  if (item.imageId != null) {
    const image = resolved.get(item.imageId);
    if (image?.status === 'visible') return { url: image.url };
    return { imageId: item.imageId };
  }
  return { url: item.imageUrl };
}
