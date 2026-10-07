import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App.js';
import { ALL_APP_SCOPES } from './community-storage.js';
import { demoSharedSeed } from './community.js';
import { installMockMoneyHost } from './mock-buzz.js';

// Shell contract after the 2026-10-06 consolidation: Open Datasets is a SINGLE
// view. The scaffold Generate/Comfy tabs and the standalone Train tab are gone;
// training is reached from a dataset inside the community view. These tests pin
// the shell so the sample tabs cannot creep back.
describe('App shell (single view)', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it('cold-opens on the datasets view with no mode tabs', async () => {
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      declaredScopes: [...ALL_APP_SCOPES],
      shared: { seed: demoSharedSeed() },
    });
    render(<App />);

    expect(await screen.findByTestId('dc-community')).toBeInTheDocument();
    expect(screen.getByText('Open Datasets', { selector: 'div' })).toBeInTheDocument();
    // No segmented mode switch, no scaffold generation surface.
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pm-generate')).not.toBeInTheDocument();
    expect(screen.queryByText('Train a LoRA', { selector: '[role="tab"]' })).not.toBeInTheDocument();
  });

  it('the shell root carries the Archive Lab theme scope', async () => {
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      declaredScopes: [...ALL_APP_SCOPES],
      shared: { seed: [] },
    });
    render(<App />);

    await screen.findByTestId('dc-community');
    const root = document.querySelector('[data-dc-archive="true"]');
    expect(root).not.toBeNull();
    expect(root).toHaveAttribute('data-theme', 'dark');
  });
});
