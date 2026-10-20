// The production document-store source: token-mode `@civitai/sdk` over the
// bridge's block token and the validated host origin. Pinned at the fetch
// seam — the wire, not a stub of the SDK.

import { describe, expect, it } from 'vitest';

import { apiBaseUrl, createBlockDocumentStorage } from './doc-storage.js';
import { createKvStorage } from './community-storage.js';

interface Seen {
  method: string;
  url: string;
  auth: string | null;
  body: unknown;
}

function fakeFetch(respond: (call: Seen, n: number) => { status: number; body: unknown }) {
  const calls: Seen[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const call: Seen = {
      method: init?.method ?? 'GET',
      url,
      auth: new Headers(init?.headers).get('authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const { status, body } = respond(call, calls.length);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, impl };
}

const doc = (key: string, data: object) => ({
  key,
  data,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  author: { kind: 'user', isViewer: true },
  counters: {},
  marks: {},
  viewer: { marks: [] },
});

describe('createBlockDocumentStorage', () => {
  it('derives the API base from the host origin', () => {
    expect(apiBaseUrl('https://civitai.com')).toBe('https://civitai.com/api/v1');
    expect(apiBaseUrl('https://civitai.red/')).toBe('https://civitai.red/api/v1');
  });

  it('GETs and PUTs the private kv collection on the host origin with the block token', async () => {
    const f = fakeFetch((call) =>
      call.method === 'PUT'
        ? { status: 200, body: doc('dc-settings:5', call.body as object) }
        : { status: 200, body: doc('dc-settings:5', { value: { honor: 768 } }) },
    );
    const kv = createKvStorage(
      createBlockDocumentStorage({
        origin: 'https://civitai.green',
        getToken: () => 'tok-1',
        refreshToken: async () => 'tok-2',
        fetch: f.impl,
      }),
    );

    expect(await kv.get('dc-settings:5')).toEqual({ honor: 768 });
    await kv.set('dc-settings:5', { honor: 512 });

    expect(f.calls.map((c) => [c.method, c.url, c.auth])).toEqual([
      ['GET', 'https://civitai.green/api/v1/blocks/storage/kv/dc-settings%3A5', 'Bearer tok-1'],
      ['PUT', 'https://civitai.green/api/v1/blocks/storage/kv/dc-settings%3A5', 'Bearer tok-1'],
    ]);
    expect(f.calls[1]!.body).toEqual({ data: { value: { honor: 512 } } });
    // Nothing reached the legacy store.
    expect(f.calls.some((c) => /blocks\/(app-storage|shared-storage)\//.test(c.url))).toBe(false);
  });

  it('a 401 on the token re-mints through the bridge and retries with the NEW token', async () => {
    let token = 'stale';
    const f = fakeFetch((_call, n) =>
      n === 1
        ? { status: 401, body: { code: 'unauthenticated', message: 'expired' } }
        : { status: 200, body: doc('dc-settings:5', { value: 1 }) },
    );
    const kv = createKvStorage(
      createBlockDocumentStorage({
        origin: 'https://civitai.com',
        getToken: () => token,
        refreshToken: async () => {
          token = 'fresh';
          return token;
        },
        fetch: f.impl,
      }),
    );
    expect(await kv.get('dc-settings:5')).toBe(1);
    expect(f.calls.map((c) => c.auth)).toEqual(['Bearer stale', 'Bearer fresh']);
  });
});
