import type { DocumentStorage, StorageCollection } from '@civitai/sdk';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App.js';
import { ALL_APP_SCOPES } from './community-storage.js';
import { demoSharedSeed } from './community.js';
import { configureDocumentStorage } from './doc-storage.js';
import { seedCommunity } from './fake-doc-storage.js';
import { installMockMoneyHost } from './mock-buzz.js';
import { testDocStore } from './test-doc-store.js';

/**
 * The store with two switches on its `list` calls: `endless` makes every
 * `items` page claim there is another (so paging stops at the app's page cap),
 * `failDatasets` makes every `datasets` list throw a 503.
 */
function switchableLists(storage: DocumentStorage) {
  const flags = { endless: false, failDatasets: false };
  const wrapped: DocumentStorage = {
    info: (opts) => storage.info(opts),
    collection<T extends object = Record<string, unknown>>(name: string): StorageCollection<T> {
      const real = storage.collection<T>(name);
      return new Proxy(real, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver) as unknown;
          if (prop !== 'list' || typeof value !== 'function') return value;
          return async (...args: unknown[]) => {
            if (name === 'datasets' && flags.failDatasets) {
              throw Object.assign(new Error('SHARED_UNAVAILABLE'), { status: 503 });
            }
            // The fake store would reject the made-up cursor: re-read page one.
            const query = args[0] as { cursor?: string } | undefined;
            const callArgs =
              name === 'items' && flags.endless && query?.cursor === 'more'
                ? [{ ...query, cursor: undefined }, ...args.slice(1)]
                : args;
            const page = (await (value as (...a: unknown[]) => Promise<{ nextCursor: string | null }>).apply(
              target,
              callArgs,
            )) as { nextCursor: string | null };
            return name === 'items' && flags.endless ? { ...page, nextCursor: 'more' } : page;
          };
        },
      });
    },
  };
  return { wrapped, flags };
}

describe('a partial list and a failed refresh', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it('says the list is partial when a collection stops at the page cap', async () => {
    const fake = testDocStore();
    await seedCommunity(fake, demoSharedSeed());
    const { wrapped, flags } = switchableLists(fake.storage);
    flags.endless = true;
    configureDocumentStorage(async () => wrapped);
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      declaredScopes: [...ALL_APP_SCOPES],
    });
    render(<App />);
    await screen.findByTestId('dc-open-dataset-dataset-archive-ink', {}, { timeout: 5000 });
    expect(screen.getByTestId('dc-community-partial')).toHaveTextContent(/more entries than this app reads at once/i);
  }, 20000);

  it('a complete list shows no partial notice', async () => {
    const fake = testDocStore();
    await seedCommunity(fake, demoSharedSeed());
    const { wrapped } = switchableLists(fake.storage);
    configureDocumentStorage(async () => wrapped);
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      declaredScopes: [...ALL_APP_SCOPES],
    });
    render(<App />);
    await screen.findByTestId('dc-open-dataset-dataset-archive-ink', {}, { timeout: 5000 });
    expect(screen.queryByTestId('dc-community-partial')).not.toBeInTheDocument();
  }, 20000);

  it('when the newest refresh fails after a good load, the last good data stays and voting waits for a refresh', async () => {
    const user = userEvent.setup();
    const fake = testDocStore();
    await seedCommunity(fake, demoSharedSeed());
    const { wrapped, flags } = switchableLists(fake.storage);
    configureDocumentStorage(async () => wrapped);
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      declaredScopes: [...ALL_APP_SCOPES],
    });
    render(<App />);
    await user.click(await screen.findByTestId('dc-open-dataset-dataset-archive-ink', {}, { timeout: 5000 }));
    await screen.findByTestId('dc-item-item-c-up', {}, { timeout: 5000 });

    // From now on the shared read fails. A vote lands, then its refresh fails.
    flags.failDatasets = true;
    const before = fake.calls.length;
    await user.click(screen.getByTestId('dc-item-item-c-up'));
    expect(await screen.findByTestId('dc-community-stale', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByTestId('dc-community-failed')).not.toBeInTheDocument();
    expect(screen.getByTestId('dc-item-item-c-up')).toBeInTheDocument();

    const marks = () =>
      fake.calls
        .slice(before)
        .filter((c) => c.path.includes('/marks/'))
        .map((c) => `${c.method} ${c.path.split('/').at(-1)}`);
    expect(marks()).toEqual(['PUT up']);

    // The kept fold predates that vote, so a second vote must not act on it
    // (it would PUT up again): it is refused with a reason, writing nothing.
    await user.click(screen.getByTestId('dc-item-item-c-up'));
    expect(await screen.findByTestId('dc-community-notice-detail', {}, { timeout: 5000 })).toHaveTextContent(
      /could not be refreshed/,
    );
    expect(marks()).toEqual(['PUT up']);

    // Once a refresh succeeds, the fold is current again and the vote toggles off.
    flags.failDatasets = false;
    await user.click(screen.getByTestId('dc-community-stale-retry'));
    await waitFor(() => expect(screen.queryByTestId('dc-community-stale')).not.toBeInTheDocument(), { timeout: 5000 });
    await user.click(screen.getByTestId('dc-item-item-c-up'));
    await waitFor(() => expect(marks()).toEqual(['PUT up', 'DELETE up']), { timeout: 5000 });
  }, 20000);
});
