// The one gate between a URL that came out of shared storage (or that a
// contributor typed) and an `<img src>` / `<a href>` / a save-by-url.
//
// Shared `items` documents are written by any contributor, and a client can
// write one directly, bypassing this app's form. So nothing read back from
// storage is trusted as a URL: every render path and the save-by-url path
// asks this module, and anything it refuses is shown as plain text.
//
// The rule is a parsed-host check, never a substring test: `new URL()`, scheme
// exactly `https:`, no userinfo, and `host` (which carries a non-default port)
// EXACTLY equal to one of the hosts below.

/**
 * Hosts the Civitai host hands this app image URLs on — the only hosts an
 * `<img src>` may point at.
 *
 * - `image.civitai.com`: the image edge. civitai's `getEdgeUrl`
 *   (`src/client-utils/edge-url.ts`) prefixes every stored key with
 *   `NEXT_PUBLIC_IMAGE_LOCATION`, `https://image.civitai.com/<account>`; the
 *   gated read (`block-gated-images.service.ts`), the image picker's posted
 *   images (`block-image-picker.logic.ts`) and the upload
 *   (`block-image-upload.service.ts`) all return urls built by it.
 * - the orchestrator blob hosts: the image picker's GENERATED images are the
 *   output's own consumer-blob url. Same set as civitai's
 *   `KNOWN_ORCHESTRATOR_HOSTS` (`src/server/services/orchestrator/trusted-blob-url.ts`),
 *   plus `orchestration-proxy.civitai.com`: for a proxied region civitai
 *   rewrites those urls onto that Cloudflare-fronted route to the same service
 *   (`ORCHESTRATOR_PROXY_HOST`, `src/server/orchestrator/region-proxy.ts`), so a
 *   generated image picked there arrives on it.
 *
 * A host check is not a content-rating check: an item with no `imageId` is
 * shown without the host's gated read, so this module bounds WHERE the browser
 * fetches from, not WHICH Civitai image it shows.
 */
export const CIVITAI_MEDIA_HOSTS: readonly string[] = [
  'image.civitai.com',
  'orchestration.civitai.com',
  'orchestration-new.civitai.com',
  'orchestration-next.civitai.com',
  'orchestration-proxy.civitai.com',
];

/** Hosts a Civitai post page lives on — the only hosts a post link may point at. */
export const CIVITAI_SITE_HOSTS: readonly string[] = ['civitai.com', 'www.civitai.com'];

/** A post page path: `/posts/<digits>`, an optional trailing slash, nothing else. */
const POST_PATH = /^\/posts\/(\d+)\/?$/;

function parseHttpsOn(raw: unknown, hosts: readonly string[]): URL | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let url: URL;
  try {
    // No base: a relative or protocol-relative string (`//evil.com`) throws.
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (!hosts.includes(url.host)) return null;
  return url;
}

/**
 * The URL to put in an `<img src>` for `raw`, or `null` when `raw` is not an
 * `https:` URL on a {@link CIVITAI_MEDIA_HOSTS} host. Returns the parsed,
 * normalised `href`, never the raw string.
 */
export function safeCivitaiMediaUrl(raw: unknown): string | null {
  return parseHttpsOn(raw, CIVITAI_MEDIA_HOSTS)?.href ?? null;
}

/**
 * The post link for `raw`, or `null` unless `raw` is an `https:` URL on a
 * {@link CIVITAI_SITE_HOSTS} host whose path is exactly `/posts/<digits>`.
 */
export function safeCivitaiPostUrl(raw: unknown): { href: string; postId: number } | null {
  const url = parseHttpsOn(raw, CIVITAI_SITE_HOSTS);
  if (!url) return null;
  const match = POST_PATH.exec(url.pathname);
  if (!match) return null;
  const postId = Number(match[1]);
  if (!Number.isSafeInteger(postId) || postId <= 0) return null;
  return { href: url.href, postId };
}

/** True when `raw` is an `https:` URL on a Civitai site host (an image page, a post…). */
export function isCivitaiSiteUrl(raw: unknown): boolean {
  return parseHttpsOn(raw, CIVITAI_SITE_HOSTS) != null;
}

/** How a stored image reference may be shown. */
export type ImageRefDisplay =
  | { kind: 'image'; src: string }
  | { kind: 'post'; href: string }
  | { kind: 'unavailable' };

/**
 * Classify a stored `imageRef` (one with no `imageId`; an item with an id is
 * shown through the host's gated read instead). Everything that is not a
 * Civitai media URL or a Civitai post link is `unavailable`.
 */
export function imageRefDisplay(imageRef: unknown): ImageRefDisplay {
  const post = safeCivitaiPostUrl(imageRef);
  if (post) return { kind: 'post', href: post.href };
  const src = safeCivitaiMediaUrl(imageRef);
  if (src) return { kind: 'image', src };
  return { kind: 'unavailable' };
}
