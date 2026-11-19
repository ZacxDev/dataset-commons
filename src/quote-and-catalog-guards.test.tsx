import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App.js';
import { ALL_APP_SCOPES } from './community-storage.js';
import { datasetDoc, loraDoc, snapshotDoc, type DatasetRecord, type LoraRecord } from './community.js';
import { seedCommunity } from './fake-doc-storage.js';
import { resolveItemImages, type ViewerImageCeiling } from './item-images.js';
import { installMockMoneyHost, type MockMoneyHostHandle } from './mock-buzz.js';
import { testDocStore } from './test-doc-store.js';
import { freezeSnapshot } from './training.js';

describe('LoRA test generation never submits at a stale price', () => {
  let host: MockMoneyHostHandle | undefined;
  afterEach(() => {
    host?.();
    host = undefined;
  });

  it('editing the prompt after pricing drops the quote, and nothing is submitted', async () => {
    const user = userEvent.setup();
    const dataset: DatasetRecord = {
      datasetId: 'ds1',
      ownerId: 2,
      ownerName: 'dev',
      name: 'Ink Portraits',
      description: '',
      targetNote: '',
      createdAt: '2026-11-19T00:00:00.000Z',
      updatedAt: '2026-11-19T00:00:00.000Z',
    };
    const snapshot = freezeSnapshot(
      'ds1',
      'user:2',
      [{ itemId: 'a', contributorId: 'user:11', imageUrl: '', caption: 'front', netVotes: 2 }],
      { snapshotId: 'snap1', now: '2026-11-19T00:00:00.000Z' },
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
      createdAt: '2026-11-19T01:00:00.000Z',
      updatedAt: '2026-11-19T01:00:00.000Z',
    };
    await seedCommunity(testDocStore(), [
      { collection: 'datasets', author: 'dev-viewer', data: datasetDoc(dataset) },
      { collection: 'snapshots', author: 'dev-viewer', data: snapshotDoc(snapshot) },
      { collection: 'loras', author: 'dev-viewer', data: loraDoc(lora) },
    ]);
    const outbound: string[] = [];
    host = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      cost: 8,
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
      declaredScopes: [...ALL_APP_SCOPES],
      onOutbound: (message) => outbound.push(String((message as { type?: string }).type)),
    });
    render(<App />);
    await screen.findByTestId('dc-community');
    await user.click(await screen.findByTestId('dc-open-dataset-ds1', {}, { timeout: 5000 }));
    await user.click(await screen.findByTestId('dc-open-lora-lora_wf1', {}, { timeout: 5000 }));
    await user.click(await screen.findByTestId('dc-lora-estimate', {}, { timeout: 5000 }));
    expect(await screen.findByTestId('dc-lora-confirm-submit', {}, { timeout: 5000 })).toBeInTheDocument();

    // The quote priced THIS prompt; changing it must take the Generate button away.
    await user.type(screen.getByTestId('dc-lora-prompt'), ', much longer and costlier');
    expect(screen.queryByTestId('dc-lora-confirm-submit')).not.toBeInTheDocument();
    expect(screen.getByTestId('dc-lora-estimate')).toBeInTheDocument();
    expect(outbound.filter((t) => t === 'SUBMIT_WORKFLOW')).toEqual([]);
  }, 30000);
});

describe('the catalog image read never hangs on a body its parser throws on', () => {
  const ANY_VIEWER: ViewerImageCeiling = { mask: 0xffff, viewerKnown: true };

  it('a catalog body the parser throws on resolves the read (with the gated answers), not a pending promise', async () => {
    const gated = async (ids: number[]) =>
      ids.map((imageId) => ({ imageId, status: 'hidden' as const }));
    // The parser is defensive against every JSON shape (a null item is skipped),
    // so a throw needs a body whose `items` read itself throws. This pins the
    // guard (an invariant guard: no JSON reply reaches it today).
    const catalog = async () => ({
      get items(): unknown {
        throw new Error('unreadable catalog body');
      },
    });
    const outcome = await Promise.race([
      resolveItemImages([7], { catalog, gated, ceiling: ANY_VIEWER, deadlineMs: 60_000 }).then((m) => [...m.keys()]),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 1500)),
    ]);
    expect(outcome).toEqual([7]);
  });
});
