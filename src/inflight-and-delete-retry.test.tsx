import type { DocumentStorage, StorageCollection } from '@civitai/sdk';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App.js';
import { ALL_APP_SCOPES } from './community-storage.js';
import {
  datasetDoc,
  itemDoc,
  loraDoc,
  snapshotDoc,
  type DatasetItemRecord,
  type DatasetRecord,
  type LoraRecord,
} from './community.js';
import { configureDocumentStorage } from './doc-storage.js';
import { seedCommunity } from './fake-doc-storage.js';
import { installMockMoneyHost, type MockMoneyHostHandle } from './mock-buzz.js';
import { testDocStore } from './test-doc-store.js';
import { freezeSnapshot } from './training.js';

const dataset: DatasetRecord = {
  datasetId: 'ds1',
  ownerId: 2,
  ownerName: 'dev',
  name: 'Ink Portraits',
  description: '',
  targetNote: '',
  createdAt: '2026-11-18T00:00:00.000Z',
  updatedAt: '2026-11-18T00:00:00.000Z',
};

describe('LoRA test generation: one run at a time', () => {
  let host: MockMoneyHostHandle | undefined;
  afterEach(() => {
    host?.();
    host = undefined;
  });

  it('pricing cannot start while a run is polling, and comes back once the run ends', async () => {
    const user = userEvent.setup();
    const snapshot = freezeSnapshot(
      'ds1',
      'user:2',
      [{ itemId: 'a', contributorId: 'user:11', imageUrl: '', caption: 'front', netVotes: 2 }],
      { snapshotId: 'snap1', now: '2026-11-18T00:00:00.000Z' },
    );
    const lora: LoraRecord = {
      loraId: 'lora_wf1',
      datasetId: 'ds1',
      snapshotId: 'snap1',
      trainerId: 2,
      trainerName: 'dev',
      name: 'Ink Portraits LoRA',
      workflowId: 'wf1',
      modelId: 42,
      modelVersionId: 84,
      published: true,
      createdAt: '2026-11-18T01:00:00.000Z',
      updatedAt: '2026-11-18T01:00:00.000Z',
    };
    await seedCommunity(testDocStore(), [
      { collection: 'datasets', author: 'dev-viewer', data: datasetDoc(dataset) },
      { collection: 'snapshots', author: 'dev-viewer', data: snapshotDoc(snapshot) },
      { collection: 'loras', author: 'dev-viewer', data: loraDoc(lora) },
    ]);
    host = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
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

    host.setHostPollError('block token expired');
    await user.click(confirm);
    // While the run is being polled, the price button is back on screen but must not start anything.
    const estimate = await screen.findByTestId('dc-lora-estimate', {}, { timeout: 5000 });
    await waitFor(() => expect(estimate).toBeDisabled(), { timeout: 3000 });
    await user.click(estimate);
    expect(screen.queryByTestId('dc-lora-confirm-submit')).not.toBeInTheDocument();

    host.setHostPollError(null);
    expect(await screen.findByTestId('dc-lora-image', {}, { timeout: 15000 })).toBeInTheDocument();
    expect(screen.getByTestId('dc-lora-estimate')).not.toBeDisabled();
    expect(screen.queryByTestId('dc-lora-check-again')).not.toBeInTheDocument();
  }, 40000);
});

/** The same store, except the FIRST delete of a `datasets` document fails with a 503. */
function failFirstDatasetDelete(storage: DocumentStorage): DocumentStorage {
  let failed = false;
  return {
    info: (opts) => storage.info(opts),
    collection<T extends object = Record<string, unknown>>(name: string): StorageCollection<T> {
      const real = storage.collection<T>(name);
      if (name !== 'datasets') return real;
      return new Proxy(real, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver) as unknown;
          if (prop !== 'delete' || typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            if (!failed) {
              failed = true;
              return Promise.reject(Object.assign(new Error('SHARED_UNAVAILABLE'), { status: 503 }));
            }
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    },
  };
}

describe('deleting a dataset that fails partway', () => {
  let host: MockMoneyHostHandle | undefined;
  afterEach(() => {
    host?.();
    host = undefined;
  });

  /** Seed, open, delete once (it fails at the dataset step); returns the store and the user. */
  async function deleteThatStopsPartway() {
    const user = userEvent.setup();
    const item = (itemId: string, contributorId: number, contributorName: string): DatasetItemRecord => ({
      itemId,
      datasetId: 'ds1',
      contributorId,
      contributorName,
      imageId: 9001,
      imageRef: 'https://civitai.com/images/9001',
      caption: `caption ${itemId}`,
      rightsAsserted: true,
      createdAt: '2026-11-18T01:00:00.000Z',
      updatedAt: '2026-11-18T01:00:00.000Z',
    });
    const fake = testDocStore();
    await seedCommunity(fake, [
      { collection: 'datasets', author: 'dev-viewer', data: datasetDoc(dataset) },
      { collection: 'items', author: 'dev-viewer', data: itemDoc(item('mine', 2, 'dev')) },
      { collection: 'items', author: 'bob', data: itemDoc(item('bobs', 12, 'bob')) },
    ]);
    // ONE wrapper for the whole test: the app re-asks the source on every
    // collection access, so a wrapper per call would fail every delete.
    const failing = failFirstDatasetDelete(fake.storage);
    configureDocumentStorage(async () => failing);
    host = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      declaredScopes: [...ALL_APP_SCOPES],
    });
    render(<App />);
    await user.click(await screen.findByTestId('dc-open-dataset-ds1', {}, { timeout: 5000 }));
    await screen.findByTestId('dc-dataset-detail', {}, { timeout: 5000 });
    await user.click(screen.getByTestId('dc-dataset-menu'));
    await user.click(screen.getByTestId('dc-delete-dataset'));
    await user.click(screen.getByTestId('dc-delete-dataset'));

    // The item removals landed before the dataset delete failed: never "Nothing was written".
    const notice = await screen.findByTestId('dc-community-notice', {}, { timeout: 5000 });
    expect(notice).toHaveTextContent(/stopped partway/i);
    expect(notice).not.toHaveTextContent(/Nothing was written/i);

    return { user, fake };
  }

  const bobsRemovals = async (fake: ReturnType<typeof testDocStore>) =>
    (await fake.storage.collection('removals').list()).items.filter(
      (doc) => (doc.data as { itemId?: string }).itemId === 'bobs',
    );

  it('says some of it was saved, and Retry finishes it without duplicating the removal record', async () => {
    const { user, fake } = await deleteThatStopsPartway();
    await user.click(screen.getByTestId('dc-community-notice-retry'));
    expect(await screen.findByTestId('dc-explore-empty', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(await bobsRemovals(fake)).toHaveLength(1);
  }, 30000);

  it('a fresh Delete after the partial failure also finishes it without a duplicate removal record', async () => {
    const { user, fake } = await deleteThatStopsPartway();
    if (!screen.queryByTestId('dc-delete-dataset')) await user.click(screen.getByTestId('dc-dataset-menu'));
    // Two taps again: the fired button disarmed itself.
    await user.click(screen.getByTestId('dc-delete-dataset'));
    expect(screen.getByTestId('dc-delete-dataset')).toHaveTextContent('Tap again to confirm delete');
    await user.click(screen.getByTestId('dc-delete-dataset'));
    expect(await screen.findByTestId('dc-explore-empty', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(await bobsRemovals(fake)).toHaveLength(1);
  }, 30000);
});
