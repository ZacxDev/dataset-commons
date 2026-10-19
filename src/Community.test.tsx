import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App.js';
import {
  ALL_APP_SCOPES,
} from './community-storage.js';
import {
  datasetSharedValue,
  demoSharedSeed,
  itemSharedValue,
  ledgerSharedValue,
  loraSharedValue,
  snapshotSharedValue,
  voteSharedValue,
  type DatasetItemRecord,
  type DatasetRecord,
  type LoraRecord,
} from './community.js';
import { freezeSnapshot, trainingFeeEvent } from './training.js';
import { installMockMoneyHost } from './mock-buzz.js';

// Component tests for the Dataset Commons community screens against the real
// SDK transport + mock host. Shared storage is seeded through the mock host's
// own scenario (the same surface the dev harness uses), never by mocking hooks.

async function openCommunity(user: ReturnType<typeof userEvent.setup>) {
  void user;
  render(<App />);
  // Single-view shell: the datasets view is the cold-open, no tab to click.
  return screen.findByTestId('dc-community');
}

describe('Community screens (voting option b)', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it('storage not-permitted is an honest unavailable state, never a fake empty community', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      // Manifest-declared (approved) scopes, but the first token carries none
      // of them yet — the consent-gated state the lazy-consent button resolves.
      declaredScopes: [...ALL_APP_SCOPES],
      shared: { seed: [] },
    });
    await openCommunity(user);

    expect(await screen.findByTestId('dc-community-unavailable')).toBeInTheDocument();
    expect(screen.queryByTestId('dc-explore-empty')).not.toBeInTheDocument();

    // Granting shared storage turns the same empty store into a REAL empty state.
    await user.click(screen.getByTestId('dc-community-enable'));
    expect(await screen.findByTestId('dc-explore-empty', {}, { timeout: 5000 })).toBeInTheDocument();
  }, 15000);

  it('Explore -> dataset detail folds custom up/down votes; a viewer vote replaces and toggles', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      declaredScopes: [...ALL_APP_SCOPES],
      shared: { seed: demoSharedSeed() },
    });
    await openCommunity(user);

    const card = await screen.findByTestId('dc-dataset-card');
    expect(card).toHaveTextContent('Archive Ink Portraits');
    expect(card).toHaveTextContent('3 net votes');
    await user.click(screen.getByTestId('dc-open-dataset-dataset-archive-ink'));

    expect(await screen.findByTestId('dc-dataset-detail')).toBeInTheDocument();
    expect(screen.getByTestId('dc-item-item-a-net')).toHaveTextContent('5');
    expect(screen.getByTestId('dc-item-card-item-a')).toHaveTextContent('in training set');
    expect(screen.getByTestId('dc-item-card-item-c')).toHaveTextContent('not in training set');

    // One click: the consent prompt fires, the grant lands, and the same
    // save retries itself — no second click needed.
    await user.click(screen.getByTestId('dc-item-item-a-up'));
    await waitFor(() => expect(screen.getByTestId('dc-item-item-a-net')).toHaveTextContent('6'));

    // Clicking the same arrow again clears the vote.
    await user.click(screen.getByTestId('dc-item-item-a-up'));
    await waitFor(() => expect(screen.getByTestId('dc-item-item-a-net')).toHaveTextContent('5'));
  });

  it('a save prompts for consent once and then lands without a second click', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      declaredScopes: [...ALL_APP_SCOPES],
      // Token starts consent-gated (no shared scopes): the first vote must
      // prompt, wait for the grant, and retry the same save on its own.
      shared: { seed: demoSharedSeed() },
    });
    await openCommunity(user);
    await user.click(screen.getByTestId('dc-open-dataset-dataset-archive-ink'));
    expect(await screen.findByTestId('dc-dataset-detail')).toBeInTheDocument();
    expect(screen.getByTestId('dc-item-item-a-net')).toHaveTextContent('5');

    // ONE click: consent prompt -> grant -> the vote lands by itself.
    await user.click(screen.getByTestId('dc-item-item-a-up'));
    await waitFor(
      () => expect(screen.getByTestId('dc-item-item-a-net')).toHaveTextContent('6'),
      { timeout: 8000 },
    );
  }, 20000);

  it('a failed vote save shows the host error and a Retry that lands the vote', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      declaredScopes: [...ALL_APP_SCOPES],
      consentGranted: true,
      // The next shared mutation fails once (the live walk-2026-10-08-2157
      // shape: two quick vote saves, banner up, both items stuck at net 0).
      shared: { seed: demoSharedSeed(), failNext: 1 },
    });
    await openCommunity(user);
    await user.click(screen.getByTestId('dc-open-dataset-dataset-archive-ink'));
    expect(await screen.findByTestId('dc-dataset-detail')).toBeInTheDocument();
    expect(screen.getByTestId('dc-item-item-a-net')).toHaveTextContent('5');

    // Consent is prompted and granted en route; the write itself hits the
    // forced shared-mutation failure and surfaces it with a Retry.
    await user.click(screen.getByTestId('dc-item-item-a-up'));
    await waitFor(() =>
      expect(screen.getByTestId('dc-community-notice')).toHaveTextContent(/That did not save/),
    );
    expect(screen.getByTestId('dc-community-notice-detail')).toHaveTextContent('SHARED_UNAVAILABLE');
    expect(screen.getByTestId('dc-item-item-a-net')).toHaveTextContent('5');

    // Visibly retryable: one tap re-runs the same vote and it lands.
    await user.click(screen.getByTestId('dc-community-notice-retry'));
    await waitFor(() => expect(screen.getByTestId('dc-item-item-a-net')).toHaveTextContent('6'));
    expect(screen.queryByTestId('dc-community-notice-retry')).not.toBeInTheDocument();
  });

  it('create -> contribute -> vote -> train review uses the live item, locked metadata, no local upload', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      declaredScopes: [...ALL_APP_SCOPES],
      shared: { seed: [] },
    });
    await openCommunity(user);
    await user.click(await screen.findByTestId('dc-community-enable'));
    await screen.findByTestId('dc-explore-empty', {}, { timeout: 5000 });

    // Create skips the form: one tap makes a dataset with a generated name
    // and lands on its page.
    await user.click(screen.getByTestId('dc-create-dataset'));
    expect(await screen.findByTestId('dc-dataset-detail', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByTestId('dc-dataset-form')).not.toBeInTheDocument();
    // The owner renames via the edit icon next to the name.
    await user.click(screen.getByTestId('dc-dataset-rename'));
    await user.clear(screen.getByTestId('dc-dataset-name'));
    await user.type(screen.getByTestId('dc-dataset-name'), 'Robot Studies');
    await user.click(screen.getByTestId('dc-dataset-save'));

    expect(await screen.findByTestId('dc-dataset-detail', {}, { timeout: 5000 })).toHaveTextContent('Robot Studies');
    // Contributing opens from the large Add-an-image CTA into a modal.
    await user.click(screen.getByTestId('dc-add-image'));
    // The modal defaults to Select from My Images; the Link tab carries the ref input.
    await user.click(screen.getByTestId('dc-contribute-tab-link'));
    await user.type(screen.getByTestId('dc-contribute-ref'), 'https://civitai.com/images/9001');
    await user.type(screen.getByTestId('dc-contribute-caption'), 'robot, front view');
    await user.click(screen.getByTestId('dc-contribute-rights'));
    await user.click(screen.getByTestId('dc-contribute-submit'));

    const itemCard = await screen.findByTestId(/dc-item-card-item_/, {}, { timeout: 5000 });
    expect(itemCard).toHaveTextContent('robot, front view');
    expect(itemCard).toHaveTextContent('not in training set');

    const itemId = itemCard.getAttribute('data-testid')!.replace('dc-item-card-', '');
    await user.click(screen.getByTestId(`dc-item-${itemId}-up`));
    await waitFor(() => expect(screen.getByTestId(`dc-item-${itemId}-net`)).toHaveTextContent('1'));
    expect(itemCard).toHaveTextContent('in training set');

    await user.click(screen.getByTestId('dc-open-train'));
    expect(await screen.findByTestId('dc-train', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByTestId('dc-upload')).not.toBeInTheDocument();
    const trainItems = screen.getAllByTestId('dc-dataset-item');
    expect(trainItems).toHaveLength(1);
    expect(trainItems[0]).toHaveTextContent('in · weight 1');
    expect(screen.getByTestId(`dc-caption-${itemId}`)).toBeDisabled();
    expect(screen.getByTestId(`dc-votes-${itemId}`)).toBeDisabled();
  });

  it('a failed dataset save shows the actual error, not the generic consent line', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      declaredScopes: [...ALL_APP_SCOPES],
      consentGranted: true,
      // The shared write itself fails (not a consent problem): the notice
      // must name the host error instead of blaming consent.
      shared: { seed: [], failNext: 1 },
    });
    await openCommunity(user);
    await user.click(await screen.findByTestId('dc-community-enable'));
    await screen.findByTestId('dc-explore-empty', {}, { timeout: 5000 });

    await user.click(screen.getByTestId('dc-create-dataset'));

    const notice = await screen.findByTestId('dc-community-notice', {}, { timeout: 5000 });
    expect(notice).toHaveTextContent('SHARED_UNAVAILABLE');
    expect(notice).not.toHaveTextContent(/may not be granted yet/i);
  });

  it('owner can delete a dataset so a scratch dataset leaves no Explore record', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      declaredScopes: [...ALL_APP_SCOPES],
      shared: { seed: [] },
    });
    await openCommunity(user);
    await user.click(await screen.findByTestId('dc-community-enable'));
    await screen.findByTestId('dc-explore-empty', {}, { timeout: 5000 });

    await user.click(screen.getByTestId('dc-create-dataset'));
    expect(await screen.findByTestId('dc-dataset-detail', {}, { timeout: 5000 })).toBeInTheDocument();
    await user.click(screen.getByTestId('dc-dataset-rename'));
    await user.clear(screen.getByTestId('dc-dataset-name'));
    await user.type(screen.getByTestId('dc-dataset-name'), 'Scratch Delete');
    await user.click(screen.getByTestId('dc-dataset-save'));
    expect(await screen.findByTestId('dc-dataset-detail', {}, { timeout: 5000 })).toHaveTextContent('Scratch Delete');

    // Delete lives in the three-dots menu now; two-tap confirm still applies.
    await user.click(screen.getByTestId('dc-dataset-menu'));
    // Two-tap confirm: one tap arms but does not delete.
    await user.click(screen.getByTestId('dc-delete-dataset'));
    expect(screen.getByTestId('dc-delete-dataset')).toHaveTextContent('Tap again to confirm delete');
    expect(await screen.findByTestId('dc-dataset-detail')).toHaveTextContent('Scratch Delete');
    // Second tap deletes.
    await user.click(screen.getByTestId('dc-delete-dataset'));
    expect(await screen.findByTestId('dc-explore-empty', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByText('Scratch Delete')).not.toBeInTheDocument();
  });

  it('contributing via the My images picker stores the picked image id', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      declaredScopes: [...ALL_APP_SCOPES],
      consentGranted: true,
      shared: { seed: [] },
    });
    await openCommunity(user);
    await user.click(await screen.findByTestId('dc-community-enable'));
    await screen.findByTestId('dc-explore-empty', {}, { timeout: 5000 });

    await user.click(screen.getByTestId('dc-create-dataset'));
    expect(await screen.findByTestId('dc-dataset-detail', {}, { timeout: 5000 })).toBeInTheDocument();

    // The mock host's default pick is a posted image (#12345801).
    await user.click(screen.getByTestId('dc-add-image'));
    await user.click(screen.getByTestId('dc-contribute-tab-mine'));
    await user.click(screen.getByTestId('dc-contribute-pick'));
    expect(await screen.findByTestId('dc-contribute-picked')).toHaveTextContent('Picked image #12345801');

    await user.type(screen.getByTestId('dc-contribute-caption'), 'a picked portrait');
    await user.click(screen.getByTestId('dc-contribute-rights'));
    await user.click(screen.getByTestId('dc-contribute-submit'));
    expect(await screen.findByText('a picked portrait', {}, { timeout: 5000 })).toBeInTheDocument();
  });

  it('gated images render visible, hidden, and rating-pending states without leaking a hidden url', async () => {
    const user = userEvent.setup();
    const dataset: DatasetRecord = {
      datasetId: 'ds-gated',
      ownerId: 7,
      ownerName: 'archivist',
      name: 'Gated Set',
      description: '',
      targetNote: '',
      createdAt: '2026-10-05T00:00:00.000Z',
      updatedAt: '2026-10-05T00:00:00.000Z',
    };
    const mkItem = (itemId: string, imageId: number, caption: string): DatasetItemRecord => ({
      itemId,
      datasetId: dataset.datasetId,
      contributorId: 11,
      contributorName: 'alice',
      imageId,
      imageRef: `https://civitai.com/images/${imageId}`,
      caption,
      rightsAsserted: true,
      createdAt: '2026-10-05T01:00:00.000Z',
      updatedAt: '2026-10-05T01:00:00.000Z',
    });
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      declaredScopes: [...ALL_APP_SCOPES],
      shared: {
        seed: [
          { value: datasetSharedValue(dataset), authorUserId: 7 },
          { value: itemSharedValue(mkItem('vis', 9001, 'visible one')), authorUserId: 11 },
          { value: itemSharedValue(mkItem('hid', 9002, 'hidden one')), authorUserId: 11 },
          { value: itemSharedValue(mkItem('pen', 9003, 'pending one')), authorUserId: 11 },
        ],
      },
    });
    await openCommunity(user);
    await user.click(await screen.findByTestId('dc-open-dataset-ds-gated'));

    expect(await screen.findByTestId('dc-item-image-vis', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByTestId('dc-item-image-hidden-hid')).toHaveTextContent(/hidden by your content settings/i);
    expect(screen.queryByTestId('dc-item-image-hid')).not.toBeInTheDocument();
    expect(screen.getByTestId('dc-item-image-pen')).toBeInTheDocument();
    expect(screen.getByTestId('dc-item-card-pen')).toHaveTextContent(/rating pending/i);
  });

  it('LoRA detail shows the frozen split + onsite honesty, and the ledger derives tracked credit', async () => {
    const user = userEvent.setup();
    const dataset: DatasetRecord = {
      datasetId: 'ds1',
      ownerId: 7,
      ownerName: 'owner',
      name: 'Ink Portraits',
      description: 'desc',
      targetNote: 'SDXL',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    const snapshot = freezeSnapshot(
      'ds1',
      'trainer',
      [
        { itemId: 'a', contributorId: 'user:11', contributorName: 'alice', imageUrl: 'https://civitai.com/v2/consumer/blobs/a', caption: 'front', netVotes: 5 },
        { itemId: 'b', contributorId: 'user:12', contributorName: 'bob', imageUrl: 'https://civitai.com/v2/consumer/blobs/b', caption: 'profile', netVotes: 1 },
      ],
      { snapshotId: 'snap1', now: '2026-10-04T00:00:00.000Z' },
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
      createdAt: '2026-10-04T01:00:00.000Z',
      updatedAt: '2026-10-04T01:00:00.000Z',
    };
    const event = trainingFeeEvent({ snapshot, workflowId: 'wf1', grossBuzz: 700, loraId: 'lora_wf1' });
    uninstall = installMockMoneyHost({
      viewer: { id: 11, username: 'alice', status: 'active' },
      consentGranted: true,
      declaredScopes: [...ALL_APP_SCOPES],
      shared: {
        seed: [
          { value: datasetSharedValue(dataset), authorUserId: 7 },
          { value: snapshotSharedValue(snapshot, dataset.name), authorUserId: 7 },
          { value: loraSharedValue(lora), authorUserId: 7 },
          { value: ledgerSharedValue(event), authorUserId: 7 },
          { value: voteSharedValue({ voterId: 11, targetKind: 'dataset', targetId: 'ds1', value: 1, updatedAt: '2026-10-02T00:00:00.000Z' }), authorUserId: 11 },
        ],
      },
    });
    await openCommunity(user);
    await user.click(await screen.findByTestId('dc-open-dataset-ds1'));
    await user.click(await screen.findByTestId('dc-open-lora-lora_wf1', {}, { timeout: 5000 }));

    expect(await screen.findByTestId('dc-lora', {}, { timeout: 5000 })).toHaveTextContent('Ink Portraits LoRA');
    expect(screen.getByTestId('dc-lora-share-user:11')).toHaveTextContent('83.3%');
    expect(screen.getByTestId('dc-lora-onsite')).toHaveTextContent(/aren't reported to apps yet/i);
    expect(screen.getByTestId('dc-lora-events')).toHaveTextContent('700');

    await user.click(screen.getByTestId('dc-nav-open'));
    await user.click(await screen.findByTestId('dc-drawer-ledger'));
    expect(await screen.findByTestId('dc-ledger-total', {}, { timeout: 5000 })).toHaveTextContent('583');
    expect(screen.getByTestId('dc-ledger-total')).toHaveTextContent(/no Buzz has moved to you/i);
    expect(screen.getByTestId('dc-ledger-row')).toHaveTextContent('583');
    expect(screen.getByTestId('dc-my-snapshots')).toHaveTextContent('83.3% share');
  });

  it(
    'training from a real dataset persists snapshot + linked LoRA, and a test generation credits the ledger',
    async () => {
      const user = userEvent.setup();
      uninstall = installMockMoneyHost({
        viewer: { id: 2, username: 'dev', status: 'active' },
        consentGranted: true,
        cost: 8,
        pollsUntilDone: 1,
        buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
        declaredScopes: [...ALL_APP_SCOPES],
        shared: { seed: demoSharedSeed() },
        generation: {
          trainedEpochs: 10,
          trainingPublishedModel: { modelId: 42, modelVersionId: 84, published: true },
        },
      });
      await openCommunity(user);
      await user.click(await screen.findByTestId('dc-open-dataset-dataset-archive-ink'));
      await user.click(await screen.findByTestId('dc-open-train'));

      expect(await screen.findByTestId('dc-train', {}, { timeout: 5000 })).toBeInTheDocument();
      await user.click(screen.getByTestId('dc-estimate'));
      await user.click(await screen.findByTestId('dc-confirm-submit', {}, { timeout: 5000 }));
      expect(await screen.findByTestId('dc-published', {}, { timeout: 10000 })).toHaveTextContent('Model version 84');

      await user.click(screen.getByTestId('dc-back-dataset'));
      expect(await screen.findByTestId('dc-dataset-loras', {}, { timeout: 10000 })).toHaveTextContent(
        'Archive Ink Portraits LoRA',
      );
      const loraButton = screen.getByTestId(/dc-open-lora-lora_/);
      await user.click(loraButton);

      expect(await screen.findByTestId('dc-lora', {}, { timeout: 5000 })).toBeInTheDocument();
      await user.click(screen.getByTestId('dc-lora-estimate'));
      await user.click(await screen.findByTestId('dc-lora-confirm-submit', {}, { timeout: 5000 }));
      expect(await screen.findByTestId('dc-lora-image', {}, { timeout: 10000 })).toBeInTheDocument();
      expect(screen.getByTestId('dc-lora-events')).toHaveTextContent(/In-app generation/);
    },
    30000,
  );
});
