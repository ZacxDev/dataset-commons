import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App.js';
import { ALL_APP_SCOPES } from './community-storage.js';
import { demoSharedSeed } from './community.js';
import { seedCommunity } from './fake-doc-storage.js';
import { installMockMoneyHost } from './mock-buzz.js';
import { testDocStore } from './test-doc-store.js';

// Votes are serialized writes. A second click queued behind an in-flight vote
// must compute its `from` vote from what the first one landed — never from a
// render that has not happened yet — or it re-marks the document.

describe('two quick votes on one item', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it('up then up again toggles the mark on and off: PUT up, DELETE up, nothing else', async () => {
    const user = userEvent.setup();
    const fake = testDocStore();
    await seedCommunity(fake, demoSharedSeed());
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      declaredScopes: [...ALL_APP_SCOPES],
    });
    render(<App />);
    await user.click(await screen.findByTestId('dc-open-dataset-dataset-archive-ink', {}, { timeout: 5000 }));
    const up = await screen.findByTestId('dc-item-item-c-up', {}, { timeout: 5000 });
    const before = fake.calls.length;

    // Two clicks without waiting: the second is queued behind the first write.
    await Promise.all([user.click(up), user.click(up)]);

    const marks = () =>
      fake.calls
        .slice(before)
        .filter((c) => c.path.includes('/marks/'))
        .map((c) => `${c.method} ${c.path.split('/').at(-1)}`);
    await waitFor(() => expect(marks()).toHaveLength(2), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(marks()).toEqual(['PUT up', 'DELETE up']);
  }, 20000);
});
