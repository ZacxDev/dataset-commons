/**
 * Dataset Commons — where the document store client comes from.
 *
 * The store is `app.storage` of an `@civitai/sdk` client. This app's runtime
 * is the `@civitai/blocks-react` bridge, which already holds the block token and
 * the allowlist-validated host origin, so the client is built in TOKEN mode —
 * `initialize({ token, refresh, siteUrl })` — over those two values:
 *
 * - NOT a bare `initialize()`: that stands up the SDK's OWN postMessage
 *   transport beside the bridge's (two `message` listeners, two BLOCK_HELLO /
 *   BLOCK_READY senders, two token copies). Token mode sends no postMessage at
 *   all; it only makes the REST calls under `/api/v1/blocks/storage/*`, which the
 *   storage guide documents as "called with the block token".
 * - `siteUrl` is the HOST origin (`useHostOrigin()`), never the block's own
 *   subdomain: the block runs cross-origin, and a same-origin `/api` answers the
 *   SPA's `index.html`. `undefined` until BLOCK_INIT, so no client exists (and
 *   nothing is fetched) until both the origin and the token are present.
 * - `refresh` re-mints through the bridge (`useBlockToken().refresh`), so a
 *   401 retried by the SDK carries the NEW token, not the one captured here.
 *
 * Tests and the mock-host harness replace the whole source with
 * {@link configureDocumentStorage} (an SDK `createFakeStorage`), because the
 * mock host answers the bridge only — it has no document store.
 */

import { useMemo, useRef } from 'react';

import { useBlockToken, useHostOrigin } from '@civitai/blocks-react';
import { initialize, type DocumentStorage } from '@civitai/sdk';

/** Hands out the document store; called per operation. */
export type DocumentStorageSource = () => Promise<DocumentStorage>;

export interface BlockDocumentStorageDeps {
  /** The validated host origin, e.g. `https://civitai.com`. */
  origin: string;
  /** The block token as held NOW (read per request — the host rotates it). */
  getToken: () => string;
  /** Force a fresh mint; resolves with the new raw token. */
  refreshToken: () => Promise<string>;
  /** Test seam; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** The REST base the document store routes hang off: `<origin>/api/v1`. */
export function apiBaseUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/api/v1`;
}

/** Build the production source. One client per source, created on first use. */
export function createBlockDocumentStorage(deps: BlockDocumentStorageDeps): DocumentStorageSource {
  let client: Promise<DocumentStorage> | null = null;
  return () => {
    if (client === null) {
      const pending = initialize({
        token: () => deps.getToken(),
        refresh: () => deps.refreshToken(),
        siteUrl: apiBaseUrl(deps.origin),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      })
        .then((app) => app.storage as DocumentStorage)
        .catch((err: unknown) => {
          // Never cache a rejection: the next call tries again.
          if (client === pending) client = null;
          throw err;
        });
      client = pending;
    }
    return client;
  };
}

let override: DocumentStorageSource | null = null;

/**
 * Replace the production source — the mock-host harness and the test setup
 * install an in-memory `createFakeStorage` here. `null` restores production.
 */
export function configureDocumentStorage(source: DocumentStorageSource | null): void {
  override = source;
}

/**
 * The document store source for this render, or `null` while the host origin
 * or the token is not known yet. Stable per origin (it goes into effect deps).
 */
export function useDocumentStorage(): DocumentStorageSource | null {
  const origin = useHostOrigin();
  const token = useBlockToken();
  // The token object is a fresh identity every render; read it through a ref so
  // the source stays stable while the token rotates underneath it.
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const hasToken = typeof token.raw === 'string' && token.raw.length > 0;
  const configured = override;

  return useMemo(() => {
    if (configured) return configured;
    if (!origin || !hasToken) return null;
    return createBlockDocumentStorage({
      origin,
      getToken: () => tokenRef.current.raw,
      refreshToken: async () => (await tokenRef.current.refresh()).raw,
    });
  }, [configured, origin, hasToken]);
}
