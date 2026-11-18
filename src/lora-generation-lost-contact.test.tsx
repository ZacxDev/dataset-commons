import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App.js';
import { ALL_APP_SCOPES } from './community-storage.js';
import {
  datasetDoc,
  demoSharedSeed,
  loraDoc,
  snapshotDoc,
  type DatasetRecord,
  type LoraRecord,
} from './community.js';
import { seedCommunity } from './fake-doc-storage.js';
import { installMockMoneyHost, type MockMoneyHostHandle } from './mock-buzz.js';
import { testDocStore } from './test-doc-store.js';
import { freezeSnapshot } from './training.js';

// LoRA detail's test generation (Community.tsx LoraDetail). Once the submit has
// returned a run, a poll the host cannot answer is LOST CONTACT, not a verdict
// on the run: the page keeps polling and records the run's tracked credit when
// it succeeds.

describe('LoRA test generation through lost contact', () => {
  let host: MockMoneyHostHandle | undefined;
  afterEach(() => {
    host?.();
    host = undefined;
  });

  it('keeps polling through the host failure placeholder, then shows the image and records the credit', async () => {
    const user = userEvent.setup();
    const dataset: DatasetRecord = {
      datasetId: 'ds1',
      ownerId: 7,
      ownerName: 'owner',
      name: 'Ink Portraits',
      description: '',
      targetNote: '',
      createdAt: '2026-11-18T00:00:00.000Z',
      updatedAt: '2026-11-18T00:00:00.000Z',
    };
    const snapshot = freezeSnapshot(
      'ds1',
      'user:7',
      [{ itemId: 'a', contributorId: 'user:11', imageUrl: '', caption: 'front', netVotes: 2 }],
      { snapshotId: 'snap1', now: '2026-11-18T00:00:00.000Z' },
    );
    const lora: LoraRecord = {
      loraId: 'lora_wf1',
      datasetId: 'ds1',
      snapshotId: 'snap1',
      trainerId: 7,
      trainerName: 'owner',
      name: 'Ink Portraits LoRA',
      workflowId: 'wf1',
      modelId: 42,
      modelVersionId: 84,
      published: true,
      createdAt: '2026-11-18T01:00:00.000Z',
      updatedAt: '2026-11-18T01:00:00.000Z',
    };
    await seedCommunity(testDocStore(), [
      { collection: 'datasets', author: 'owner', data: datasetDoc(dataset) },
      { collection: 'snapshots', author: 'owner', data: snapshotDoc(snapshot) },
      { collection: 'loras', author: 'owner', data: loraDoc(lora) },
    ]);
    host = installMockMoneyHost({
      viewer: { id: 11, username: 'alice', status: 'active' },
      consentGranted: true,
      cost: 8,
      pollsUntilDone: 1,
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
      declaredScopes: [...ALL_APP_SCOPES],
    });
    render(<App />);
    await screen.findByTestId('dc-community');
    await user.click(await screen.findByTestId('dc-open-dataset-ds1', {}, { timeout: 5000 }));
    await user.click(await screen.findByTestId('dc-open-lora-lora_wf1', {}, { timeout: 5000 }));
    await user.click(await screen.findByTestId('dc-lora-estimate', {}, { timeout: 5000 }));
    const confirm = await screen.findByTestId('dc-lora-confirm-submit', {}, { timeout: 5000 });

    // From the first poll on, the host answers with its failure placeholder
    // (`workflowId: 'failed'`), as it does when the block token has lapsed.
    host.setHostPollError('block token expired');
    await user.click(confirm);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(screen.queryByTestId('dc-lora-image')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dc-lora-error')).not.toBeInTheDocument();

    // The host answers again: the run's own snapshot ends the wait.
    host.setHostPollError(null);
    expect(await screen.findByTestId('dc-lora-image', {}, { timeout: 15000 })).toBeInTheDocument();
    expect(screen.queryByTestId('dc-lora-error')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('dc-lora-events')).toHaveTextContent(/In-app generation/), {
      timeout: 5000,
    });
  }, 40000);
});

describe('per-viewer index save guard', () => {
  let host: MockMoneyHostHandle | undefined;
  afterEach(() => {
    host?.();
    host = undefined;
  });

  /** Writes of the viewer's private index (`dc-my-index:<id>`) the store received. */
  const indexWrites = () =>
    testDocStore().calls.filter(
      (c) => c.method !== 'GET' && (c.path.includes('dc-my-index') || JSON.stringify(c.body ?? '').includes('dc-my-index')),
    ).length;

  it('writes the index once, and not again when a fold change leaves its content unchanged', async () => {
    const user = userEvent.setup();
    await seedCommunity(testDocStore(), demoSharedSeed());
    host = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      declaredScopes: [...ALL_APP_SCOPES],
    });
    render(<App />);
    await screen.findByTestId('dc-open-dataset-dataset-archive-ink', {}, { timeout: 5000 });
    // Positive control: the counter sees the first index write.
    await waitFor(() => expect(indexWrites()).toBeGreaterThanOrEqual(1), { timeout: 5000 });
    const before = indexWrites();

    // Creating a dataset refreshes the fold; the index (items, votes, snapshots) does not change.
    await user.click(screen.getByTestId('dc-create-dataset'));
    expect(await screen.findByTestId('dc-dataset-detail', {}, { timeout: 5000 })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(indexWrites()).toBe(before);
  }, 20000);
});
