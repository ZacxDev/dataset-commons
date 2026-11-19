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
 * Two reads, run concurrently:
 *
 * 1. The gated read: this app's own unposted outputs, already clamped by the
 *    host to the VIEWER's browsing level, including the viewer's own
 *    not-yet-rated ones and the `hidden` placeholder state. Its answer wins.
 * 2. The block image CATALOG, `GET /api/v1/blocks/images?ids=…&type=image`:
 *    public posted images. 🔴 The server clamps it to the DOMAIN ceiling only,
 *    not to the viewer's own level, so this module applies the viewer's
 *    ceiling itself ({@link viewerImageCeiling}) before any catalog url reaches
 *    the screen or a save: a viewer with mature content off on a mature domain
 *    must not be shown a mature contribution.
 *
 * Each read fails on its own, and the catalog read has a deadline, so a stalled
 * catalog never holds back the gated answer for long. An id neither read
 * returns stays unresolved. That covers an image that is unposted and not this
 * app's (a bare upload), a private post, or (when the viewer's level is
 * unknown) one above PG13; the reads cannot tell these apart.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { getTransport, useBlockToken, useGatedImages, useHostOrigin } from '@civitai/blocks-react';
import { initialize, type AppClient } from '@civitai/sdk';
import {
  SFW_LEVELS,
  effectiveBrowsingCeiling,
  isLevelAllowed,
  type BlockGatedImage,
} from '@civitai/app-sdk/blocks';

import { safeCivitaiMediaUrl } from './civitai-url.js';
import { apiBaseUrl } from './doc-storage.js';

/** The catalog route's own `ids` ceiling (civitai `IMAGE_IDS_BATCH_MAX`). */
export const CATALOG_IDS_MAX = 100;

/** The gated read's own per-call ceiling (civitai `BLOCK_GATED_IMAGES_MAX_IDS`): it drops ids past it. */
export const GATED_IDS_MAX = 100;

/** `ids` in consecutive chunks of at most `size`. */
function chunked(ids: number[], size: number): number[][] {
  return Array.from({ length: Math.ceil(ids.length / size) }, (_, i) => ids.slice(i * size, (i + 1) * size));
}

/** The block catalog route, relative to `<origin>/api/v1`. */
export const CATALOG_IMAGES_PATH = 'blocks/images';

/** How long the catalog read may take before it counts as having returned nothing. */
export const CATALOG_DEADLINE_MS = 8000;

/** The grid width, the same one the host's gated read sizes its urls to. */
export const GRID_IMAGE_EDGE_WIDTH = 1200;

/** A resolved item image. `saveUrl` is the full-size original, when it differs from the grid `url`. */
export type ItemImage = BlockGatedImage & { saveUrl?: string };

/** Fetch one catalog page for at most {@link CATALOG_IDS_MAX} ids; resolves with the raw JSON body. */
export type CatalogImagesFetch = (imageIds: number[], signal?: AbortSignal) => Promise<unknown>;

/** The gated read (`useGatedImages().getImages`). */
export type GatedImagesFetch = (imageIds: number[]) => Promise<BlockGatedImage[]>;

/**
 * The ceiling a catalog image is checked against. `viewerKnown` is false when
 * the host sent no per-viewer level: the mask is then SFW only (PG, PG13),
 * never the domain ceiling, because the domain alone is wider than some viewers.
 */
export interface ViewerImageCeiling {
  mask: number;
  viewerKnown: boolean;
}

/** From the `BLOCK_INIT` maturity fields: domain ceiling narrowed to the viewer, or SFW when the viewer's level is absent. */
export function viewerImageCeiling(snapshot: {
  maxBrowsingLevel?: number;
  effectiveBrowsingLevel?: number;
}): ViewerImageCeiling {
  if (snapshot.effectiveBrowsingLevel === undefined || snapshot.effectiveBrowsingLevel === null) {
    return { mask: SFW_LEVELS, viewerKnown: false };
  }
  return {
    mask: effectiveBrowsingCeiling(snapshot.maxBrowsingLevel, snapshot.effectiveBrowsingLevel),
    viewerKnown: true,
  };
}

/** Before `BLOCK_INIT`, nothing beyond SFW. */
const UNKNOWN_CEILING: ViewerImageCeiling = { mask: SFW_LEVELS, viewerKnown: false };

const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
const dimension = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/**
 * The grid form of an image-CDN original: `<base>/<key>/original=true/<name>`
 * becomes `<base>/<key>/width=1200/<name>`. Any other url passes through.
 */
export function gridEdgeUrl(original: string): string {
  let url: URL;
  try {
    url = new URL(original);
  } catch {
    return original;
  }
  const segments = url.pathname.split('/');
  if (segments.length < 3 || segments[segments.length - 2] !== 'original=true') return original;
  segments[segments.length - 2] = `width=${GRID_IMAGE_EDGE_WIDTH}`;
  url.pathname = segments.join('/');
  return url.toString();
}

/**
 * The catalog body's `items` checked against the viewer's ceiling. Kept only:
 * an asked-for positive integer `id`, `type` exactly `image`, an `https:` url.
 * A `browsingLevel` within the ceiling makes the image visible; outside it, the
 * image is `hidden` when the viewer's level is known and dropped otherwise. A
 * missing or malformed `browsingLevel` is outside every ceiling.
 */
export function parseCatalogImages(
  body: unknown,
  asked: ReadonlySet<number>,
  ceiling: ViewerImageCeiling,
): ItemImage[] {
  const items = (body as { items?: unknown } | null | undefined)?.items;
  if (!Array.isArray(items)) return [];
  const out: ItemImage[] = [];
  for (const raw of items) {
    const item = raw as {
      id?: unknown;
      url?: unknown;
      type?: unknown;
      browsingLevel?: unknown;
      width?: unknown;
      height?: unknown;
    } | null;
    if (!item || !isPositiveInt(item.id) || !asked.has(item.id)) continue;
    if (item.type !== 'image' || typeof item.url !== 'string') continue;
    let url: URL;
    try {
      url = new URL(item.url);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:') continue;
    if (!isLevelAllowed(item.browsingLevel as number, ceiling.mask)) {
      if (ceiling.viewerKnown) out.push({ imageId: item.id, status: 'hidden' });
      continue;
    }
    out.push({
      imageId: item.id,
      status: 'visible',
      nsfwLevel: item.browsingLevel as number,
      url: gridEdgeUrl(item.url),
      saveUrl: item.url,
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

/** One catalog chunk, or nothing once it fails or passes the deadline (the request is then aborted). */
function catalogChunk(
  catalog: CatalogImagesFetch,
  chunk: number[],
  ceiling: ViewerImageCeiling,
  deadlineMs: number,
): Promise<ItemImage[]> {
  const controller = new AbortController();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      controller.abort();
      resolve([]);
    }, deadlineMs);
    catalog(chunk, controller.signal).then(
      (body) => {
        clearTimeout(timer);
        // A body the parser throws on is a failed read, like a rejected one:
        // resolve [] rather than leave this promise pending forever.
        try {
          resolve(parseCatalogImages(body, new Set(chunk), ceiling));
        } catch {
          resolve([]);
        }
      },
      () => {
        clearTimeout(timer);
        resolve([]);
      },
    );
  });
}

/**
 * Resolve item image ids: the gated read (in chunks of {@link GATED_IDS_MAX})
 * and the catalog (in chunks of {@link CATALOG_IDS_MAX}, each under a deadline)
 * run concurrently. The gated
 * answer for an id wins; the catalog fills the rest. A failed read contributes
 * nothing and never discards the other's.
 */
export async function resolveItemImages(
  imageIds: readonly number[],
  deps: {
    catalog: CatalogImagesFetch | null;
    gated: GatedImagesFetch;
    ceiling: ViewerImageCeiling;
    deadlineMs?: number;
  },
): Promise<Map<number, ItemImage>> {
  const ids = normalizeImageIds(imageIds);
  const resolved = new Map<number, ItemImage>();
  if (ids.length === 0) return resolved;
  const asked = new Set(ids);
  const deadlineMs = deps.deadlineMs ?? CATALOG_DEADLINE_MS;

  // In chunks: the host silently drops ids past its per-call ceiling. A failed chunk loses only its own ids.
  const gatedRead = Promise.all(
    chunked(ids, GATED_IDS_MAX).map((chunk) => deps.gated(chunk).catch(() => [] as BlockGatedImage[])),
  ).then((pages) => pages.flat());
  const catalog = deps.catalog;
  const catalogRead = catalog
    ? Promise.all(
        chunked(ids, CATALOG_IDS_MAX).map((chunk) => catalogChunk(catalog, chunk, deps.ceiling, deadlineMs)),
      ).then((pages) => pages.flat())
    : Promise.resolve([] as ItemImage[]);

  const [gated, fromCatalog] = await Promise.all([gatedRead, catalogRead]);
  for (const image of gated) {
    if (asked.has(image.imageId)) resolved.set(image.imageId, image);
  }
  for (const image of fromCatalog) {
    if (!resolved.has(image.imageId)) resolved.set(image.imageId, image);
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
  return async (imageIds, signal) =>
    (await app()).site.get(CATALOG_IMAGES_PATH, {
      // Comma-joined, the form the route parses; `limit` so one page holds every
      // id asked for; images only, so a video never lands in an <img>.
      query: { ids: imageIds.join(','), limit: imageIds.length, type: 'image' },
      ...(signal ? { signal } : {}),
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
 * The viewer's catalog ceiling, read from the transport snapshot's raw
 * `BLOCK_INIT` maturity fields. Not `useDomainMaturity()`: that falls back to
 * the DOMAIN ceiling when the host sends no per-viewer level, which is wider
 * than this module may show.
 */
export function useViewerImageCeiling(): ViewerImageCeiling {
  const transport = getTransport();
  const max = useSyncExternalStore(
    (cb) => transport.subscribe(cb),
    () => transport.getSnapshot().maxBrowsingLevel,
    () => undefined,
  );
  const effective = useSyncExternalStore(
    (cb) => transport.subscribe(cb),
    () => transport.getSnapshot().effectiveBrowsingLevel,
    () => undefined,
  );
  return useMemo(
    () => (max === undefined ? UNKNOWN_CEILING : viewerImageCeiling({ maxBrowsingLevel: max, effectiveBrowsingLevel: effective })),
    [max, effective],
  );
}

/**
 * The resolved images for `imageIds`, keyed by image id. Empty until the reads
 * settle; an id absent from the map is unresolved (see the module note).
 */
export function useItemImages(imageIds: readonly number[]): ReadonlyMap<number, ItemImage> {
  const { getImages } = useGatedImages();
  const catalog = useCatalogImagesFetch();
  const ceiling = useViewerImageCeiling();
  const key = normalizeImageIds(imageIds).join(',');
  const [images, setImages] = useState<ReadonlyMap<number, ItemImage>>(new Map());
  const resolve = useCallback(
    (ids: number[]) => resolveItemImages(ids, { catalog, gated: getImages, ceiling }),
    [catalog, getImages, ceiling],
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
    resolve(ids).then(
      (found) => {
        if (alive) setImages(found);
      },
      () => {
        // A failed read resolves nothing (each item then says it can't be
        // shown) instead of an unhandled rejection.
        if (alive) setImages(new Map());
      },
    );
    return () => {
      alive = false;
    };
  }, [key, resolve]);
  return images;
}

/** What `useSaveImage().saveImage` is asked for (without the filename). */
export type ItemSaveTarget = { url: string } | { imageId: number };

/**
 * How "Save #N" fetches an item: by the resolved image's full-size url when a
 * read above returned it VISIBLE to this viewer. Saving by `imageId` goes
 * through the host's gated read, which refuses every posted image (see the
 * module note), so a hidden or unresolved image stays unsaveable here.
 * Otherwise by id, and last by the stored url — only when it is a Civitai
 * media URL (./civitai-url.ts): the stored url is contributor-written, so
 * anything else is `null` (no Save offered).
 */
export function saveTargetForItem(
  item: { imageId?: number; imageUrl: string },
  resolved: ReadonlyMap<number, ItemImage>,
): ItemSaveTarget | null {
  if (item.imageId != null) {
    const image = resolved.get(item.imageId);
    if (image?.status === 'visible') return { url: image.saveUrl ?? image.url };
    return { imageId: item.imageId };
  }
  const url = safeCivitaiMediaUrl(item.imageUrl);
  return url ? { url } : null;
}
