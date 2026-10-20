/**
 * Dataset Commons — an in-memory document store for the mock-host harness and
 * the tests. DEV/TEST ONLY: production gets its client from `./doc-storage.ts`.
 *
 * It is the SDK's own `createFakeStorage` (`@civitai/sdk/testing`): the real
 * client over an in-memory server that enforces the server's rules against the
 * COMMITTED manifest — so a collection or mark the manifest stops declaring
 * fails here instead of passing against a phantom store. The blocks-react mock
 * host cannot stand in: it answers the bridge only, and the document store is
 * not on the bridge.
 */

import { StorageError, type DocumentStorage, type StorageCollection } from '@civitai/sdk';
import { createFakeStorage, type FakeStorage, type FakeStorageOptions } from '@civitai/sdk/testing';

import manifestText from '../block.manifest.json?raw';
import type { CommunitySeedDoc } from './community.js';
import { KV_COLLECTION } from './community-storage.js';

interface ManifestStorageView {
  scopes?: string[];
  storage?: unknown;
}

/** The committed manifest's scopes + storage declaration. */
export function committedManifest(): ManifestStorageView {
  const m = JSON.parse(manifestText) as ManifestStorageView;
  return { scopes: m.scopes, storage: m.storage };
}

/** The fake's signed-in viewer (the mock host's default viewer is `dev-viewer`). */
export const FAKE_VIEWER = { username: 'dev-viewer' } as const;

export function createAppFakeStorage(
  options: Partial<Omit<FakeStorageOptions, 'manifest'>> = {},
): FakeStorage {
  return createFakeStorage({ manifest: committedManifest(), viewer: FAKE_VIEWER, ...options });
}

/** Plant private rows exactly as copy-kv-to-appdata.sql lays them down: `kv`, legacy key, `{ value }`. */
export async function seedKv(fake: FakeStorage, rows: Record<string, unknown>): Promise<void> {
  const kv = fake.storage.collection<{ value: unknown }>(KV_COLLECTION);
  for (const [key, value] of Object.entries(rows)) await kv.put(key, { value });
}

/**
 * Plant community documents as their authors would write them (server-minted
 * keys), and their votes as each voter's `up` / `down` mark. Resolves the keys
 * in seed order.
 */
export async function seedCommunity(fake: FakeStorage, docs: readonly CommunitySeedDoc[]): Promise<string[]> {
  const keys: string[] = [];
  for (const doc of docs) {
    const as = (username: string) => fake.as({ viewer: { username } }).storage.collection(doc.collection);
    const { key } = await as(doc.author).create(doc.data as Record<string, unknown>);
    for (const voter of doc.up ?? []) await as(voter).mark(key, 'up');
    for (const voter of doc.down ?? []) await as(voter).mark(key, 'down');
    keys.push(key);
  }
  return keys;
}

/** The error a failing write answers with: the store's own 503 envelope. */
export function unavailableError(): StorageError {
  const message = 'SHARED_UNAVAILABLE: the document store is temporarily unavailable';
  return new StorageError(503, 'service_unavailable', message, { code: 'service_unavailable', message, error: message });
}

const WRITES = new Set(['create', 'put', 'delete', 'mark', 'unmark']);

/**
 * The same store, except that the next `budget.remaining` SHARED writes (create,
 * put, delete, mark, unmark on a community collection — reads, and the private
 * `kv`, pass) reject with {@link unavailableError}, each refusal spending one.
 * For the harness's `?sharedFail=N` and the retry tests.
 */
export function withFailingWrites(
  storage: DocumentStorage,
  budget: { remaining: number },
): DocumentStorage {
  return {
    info: (opts) => storage.info(opts),
    collection<T extends object = Record<string, unknown>>(name: string): StorageCollection<T> {
      const real = storage.collection<T>(name);
      if (name === KV_COLLECTION) return real;
      return new Proxy(real, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver) as unknown;
          if (typeof value !== 'function' || !WRITES.has(String(prop))) return value;
          return (...args: unknown[]) => {
            if (budget.remaining > 0) {
              budget.remaining -= 1;
              return Promise.reject(unavailableError());
            }
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    },
  };
}
