// Setup for the jsdom (component + e2e) test project. Loaded via setupFiles in
// vite.config.ts's `dom` project.

import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

import { resetHarnessTransport } from './dev-transport.js';
import {
  LEGACY_BRIDGE_TYPE,
  LEGACY_ROUTE,
  installTestDocStore,
  recordLegacyHit,
  takeLegacyHits,
  uninstallTestDocStore,
} from './test-doc-store.js';

// <App/> drives the money path + the host pickers entirely through the SDK
// postMessage transport (no HTTP). jsdom has no network, so stub global `fetch`
// to reject — nothing in the <App/> flows depends on it, but the stub keeps any
// stray fetch (e.g. the dev:live host nav's reads, which never run in <App/>
// tests) from hitting a real network. (Override this stub locally if a test
// needs a fetch response.)
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (LEGACY_ROUTE.test(url)) recordLegacyHit(`fetch ${url}`);
      throw new Error('no network in test');
    }),
  );
});

// The document store: a fresh in-memory `createFakeStorage` per test (see
// ./test-doc-store.ts), and a tripwire on the LEGACY stores — any legacy
// bridge message (APP_STORAGE_* / SHARED_STORAGE_*) or route fails the test
// that sent it.
const onMessage = (event: MessageEvent) => {
  const type = (event.data as { type?: unknown } | null)?.type;
  if (typeof type === 'string' && LEGACY_BRIDGE_TYPE.test(type)) recordLegacyHit(`bridge ${type}`);
};
beforeEach(() => {
  takeLegacyHits();
  installTestDocStore();
  window.addEventListener('message', onMessage);
});
afterEach(() => {
  window.removeEventListener('message', onMessage);
  uninstallTestDocStore();
  const hits = takeLegacyHits();
  if (hits.length > 0) {
    throw new Error(`legacy app storage reached (must be unreachable since 0.2.0): ${hits.join(', ')}`);
  }
});

// The SDK transport is a process-wide singleton — reset it before each test so
// each gets a fresh instance whose allowlist contains the jsdom origin, and so
// no BLOCK_INIT / token state leaks between tests.
beforeEach(() => {
  resetHarnessTransport();
});

// Unmount React trees + clear jsdom between tests.
afterEach(() => {
  cleanup();
});
