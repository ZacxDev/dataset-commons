import type { DocumentStorage, StorageCollection } from '@civitai/sdk';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';
import { ALL_APP_SCOPES } from './community-storage.js';
import * as community from './community.js';
import { datasetDoc, type DatasetRecord } from './community.js';
import { configureDocumentStorage } from './doc-storage.js';
import { seedCommunity } from './fake-doc-storage.js';
import { installMockMoneyHost } from './mock-buzz.js';
import { testDocStore } from './test-doc-store.js';

// refresh() is called outside the serial write queue (Retry, Enable, the
// token effect), so two reads can be in flight at once and resolve out of
// order. The OLDER read must never overwrite the newer one.

vi.mock('./community.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./community.js')>();
  return { ...real, foldSharedEntries: vi.fn(real.foldSharedEntries) };
});

const dataset: DatasetRecord = {
  datasetId: 'ds-late',
  ownerId: 7,
  ownerName: 'archivist',
  name: 'Arrived Between Reads',
  description: '',
  targetNote: '',
  createdAt: '2026-11-19T00:00:00.000Z',
  updatedAt: '2026-11-19T00:00:00.000Z',
};

type Step = 'fail' | 'gate' | 'pass';

/**
 * The store with a scripted `datasets` list (one call per refresh): by default
 * call 1 fails (so the app shows Retry), call 2 reads NOW but returns only when
 * `release()` is called, every later call passes straight through.
 * `gatedReturned()` says whether the held call has actually returned.
 */
function scriptedDatasetsList(storage: DocumentStorage, script: Step[] = ['fail', 'gate']) {
  let calls = 0;
  let returned = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wrapped: DocumentStorage = {
    info: (opts) => storage.info(opts),
    collection<T extends object = Record<string, unknown>>(name: string): StorageCollection<T> {
      const real = storage.collection<T>(name);
      if (name !== 'datasets') return real;
      return new Proxy(real, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver) as unknown;
          if (prop !== 'list' || typeof value !== 'function') return value;
          return async (...args: unknown[]) => {
            calls += 1;
            const step = script[calls - 1] ?? 'pass';
            if (step === 'fail') throw Object.assign(new Error('SHARED_UNAVAILABLE'), { status: 503 });
            const page = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
            if (step === 'gate') {
              await gate;
              returned = true;
            }
            return page;
          };
        },
      });
    },
  };
  return { wrapped, release: () => release(), gatedReturned: () => returned };
}

describe('refreshes that resolve out of order', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it('an older read resolving last does not overwrite the newer one', async () => {
    const user = userEvent.setup();
    const fake = testDocStore();
    const { wrapped, release, gatedReturned } = scriptedDatasetsList(fake.storage);
    configureDocumentStorage(async () => wrapped);
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      declaredScopes: [...ALL_APP_SCOPES],
    });
    render(<App />);

    // Read 1 failed: Retry is on screen.
    await user.click(await screen.findByTestId('dc-community-retry', {}, { timeout: 5000 }));
    // Read 2 has taken its (empty) snapshot and is held. A dataset arrives.
    await seedCommunity(fake, [{ collection: 'datasets', author: 'archivist', data: datasetDoc(dataset) }]);
    // Read 3 starts later, sees the dataset, and lands first.
    await user.click(screen.getByTestId('dc-community-retry'));
    expect(await screen.findByTestId('dc-open-dataset-ds-late', {}, { timeout: 5000 })).toBeInTheDocument();

    // Read 2 now resolves with its older, empty snapshot.
    release();
    await waitFor(() => expect(gatedReturned()).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.getByTestId('dc-open-dataset-ds-late')).toBeInTheDocument();
    expect(screen.queryByTestId('dc-explore-empty')).not.toBeInTheDocument();
  }, 20000);

  it('a newer read that fails does not hide a good read that arrives after it', async () => {
    const user = userEvent.setup();
    const fake = testDocStore();
    await seedCommunity(fake, [{ collection: 'datasets', author: 'archivist', data: datasetDoc(dataset) }]);
    // Read 1 fails (Retry), read 2 is held with the dataset, read 3 fails.
    const { wrapped, release, gatedReturned } = scriptedDatasetsList(fake.storage, ['fail', 'gate', 'fail']);
    configureDocumentStorage(async () => wrapped);
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      declaredScopes: [...ALL_APP_SCOPES],
    });
    render(<App />);

    await user.click(await screen.findByTestId('dc-community-retry', {}, { timeout: 5000 }));
    await user.click(screen.getByTestId('dc-community-retry'));
    // Read 3 (newest) failed: still the failure view.
    expect(await screen.findByTestId('dc-community-failed', {}, { timeout: 5000 })).toBeInTheDocument();

    // Read 2 (older) now returns good data: it is shown, not dropped.
    release();
    await waitFor(() => expect(gatedReturned()).toBe(true));
    expect(await screen.findByTestId('dc-open-dataset-ds-late', {}, { timeout: 5000 })).toBeInTheDocument();
  }, 20000);

  it('a load is folded once, not again on render', async () => {
    const user = userEvent.setup();
    const fake = testDocStore();
    const { wrapped, release } = scriptedDatasetsList(fake.storage);
    release();
    configureDocumentStorage(async () => wrapped);
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      declaredScopes: [...ALL_APP_SCOPES],
    });
    render(<App />);
    await user.click(await screen.findByTestId('dc-community-retry', {}, { timeout: 5000 }));
    await screen.findByTestId('dc-explore-empty', {}, { timeout: 5000 });

    const fold = vi.mocked(community.foldSharedEntries);
    fold.mockClear();
    // One more read (a write's refresh): exactly one fold for it.
    await user.click(screen.getByTestId('dc-create-dataset'));
    await screen.findByTestId('dc-dataset-detail', {}, { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fold).toHaveBeenCalledTimes(1);
  }, 20000);
});
