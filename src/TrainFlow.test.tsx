import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { TrainFlow, type TrainFlowProps } from './TrainFlow.js';
import { installMockMoneyHost } from './mock-buzz.js';
import type { DatasetItem } from './training.js';

// Component/e2e tests for the Train flow (Option A′) against the REAL SDK
// transport + mock host — no hook mocking. The mock host is kind-agnostic, so
// the training body flows through estimate -> consent -> submit -> poll exactly
// as the textToImage body does; `generation.trainedEpochs` makes the succeeded
// snapshot carry the trained-epoch field the publish handoff reads.

async function openTrain(user: ReturnType<typeof userEvent.setup>) {
  void user;
  // The standalone Train tab is gone (consolidated into the datasets view);
  // these tests drive the TrainFlow surface directly, as the dataset Train
  // route renders it.
  render(<TrainFlow />);
  return screen.findByTestId('dc-train');
}

const ownItems: DatasetItem[] = [
  {
    itemId: 'own-a',
    contributorId: 'dev',
    contributorName: 'Dev',
    imageUrl: 'https://civitai.com/images/101',
    imageId: 101,
    caption: 'own one',
    netVotes: 5,
  },
  {
    itemId: 'own-b',
    contributorId: 'dev',
    contributorName: 'Dev',
    imageUrl: 'https://civitai.com/images/102',
    imageId: 102,
    caption: 'own two',
    netVotes: 1,
  },
];

function renderTrainFlow(props: TrainFlowProps = {}) {
  render(
    <TrainFlow
      initialItems={ownItems}
      datasetId="ds-own"
      trainerId="dev"
      allowLocalUploads={false}
      hideThemeToggle
      {...props}
    />,
  );
  return screen.findByTestId('dc-train');
}

describe('TrainFlow (Option A′)', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it('snapshot review: net-positive items in with frozen weights, shares shown', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
    });
    await openTrain(user);

    // A (alice, net 5) + B (bob, net 1) are in; C (alice, net 0) is out.
    expect(screen.getByTestId('dc-shares')).toHaveTextContent('alice 83.3%');
    expect(screen.getByTestId('dc-shares')).toHaveTextContent('bob 16.7%');
    const items = screen.getAllByTestId('dc-dataset-item');
    expect(items).toHaveLength(3);
    expect(items[2]).toHaveTextContent('net votes not positive');

    // Owner override pulls C in at the floor weight: alice 6/7, bob 1/7.
    await user.click(screen.getByTestId('dc-override-item-c'));
    expect(screen.getByTestId('dc-shares')).toHaveTextContent('alice 85.7%');
    expect(screen.getByTestId('dc-shares')).toHaveTextContent('bob 14.3%');

    // Manual exclusion drops A back out (recorded reason renders).
    await user.click(screen.getByTestId('dc-override-item-c')); // undo override
    await user.click(screen.getByTestId('dc-exclude-item-a'));
    expect(screen.getAllByTestId('dc-dataset-item')[0]).toHaveTextContent('manually excluded');
  });

  it('Archive Lab roots dark by default; light only from the explicit toggle', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
    });
    await openTrain(user);
    const root = screen.getByTestId('dc-theme-root');
    expect(root).toHaveAttribute('data-theme', 'dark');
    await user.click(screen.getByTestId('dc-theme-toggle'));
    expect(root).toHaveAttribute('data-theme', 'light');
    await user.click(screen.getByTestId('dc-theme-toggle'));
    expect(root).toHaveAttribute('data-theme', 'dark');
  });

  it('estimate -> quote -> confirm -> submit -> trainedEpochs -> ready to publish, ledger credits vote-weighted', async () => {
    const user = userEvent.setup();
    const submittedBodies: Array<Record<string, unknown>> = [];
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      cost: 512,
      pollsUntilDone: 1,
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
      generation: { trainedEpochs: 10 },
      onOutbound: (m) => {
        if (m.type === 'SUBMIT_WORKFLOW') {
          submittedBodies.push((m.payload as { body: Record<string, unknown> }).body);
        }
      },
    });
    await openTrain(user);

    await user.click(screen.getByTestId('dc-estimate'));

    // The confirm card shows the REAL quote (cost 512 > maxBuzz sentinel 1).
    expect(await screen.findByTestId('dc-quote')).toHaveTextContent('512');
    expect(screen.getByTestId('dc-confirm-submit')).toBeEnabled();

    await user.click(screen.getByTestId('dc-confirm-submit'));

    // Trained epochs arrive -> ready to publish, with the wizard CTA.
    expect(await screen.findByTestId('dc-publish', {}, { timeout: 5000 })).toHaveTextContent('Publish epoch 10');
    expect(screen.getByTestId('dc-run-state')).toHaveTextContent(/ready to publish/i);

    // The submitted body is the #541 pass-through training shape.
    const body = submittedBodies.at(-1)!;
    expect(body.kind).toBe('step');
    expect(body.$type).toBe('training');
    expect(body.maxBuzz).toBe(1);
    const input = body.input as { trainingData: { items: unknown[] }; triggerWord?: string };
    expect(input.trainingData.items).toHaveLength(2);
    expect(input.triggerWord).toBe('archivetok');

    // Trainer-fee ledger: 512 split 5:1 -> alice 427, bob 85 (largest remainder).
    expect(screen.getByTestId('dc-ledger')).toBeInTheDocument();
    expect(screen.getByTestId('dc-credit-alice')).toHaveTextContent('427');
    expect(screen.getByTestId('dc-credit-bob')).toHaveTextContent('85');
    expect(screen.getByTestId('dc-ledger')).toHaveTextContent(/tracked/i);
  });

  it('publishedModel on the snapshot renders the LoRA as linked to this snapshot', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      cost: 512,
      pollsUntilDone: 1,
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
      generation: {
        trainedEpochs: 10,
        trainingPublishedModel: { modelId: 42, modelVersionId: 84, published: true },
      },
    });
    await openTrain(user);
    await user.click(screen.getByTestId('dc-estimate'));
    await screen.findByTestId('dc-confirm-submit');
    await user.click(screen.getByTestId('dc-confirm-submit'));

    expect(await screen.findByTestId('dc-published', {}, { timeout: 5000 })).toHaveTextContent(
      'Model version 84 is live',
    );
    expect(screen.getByTestId('dc-run-state')).toHaveTextContent(/published/i);
  });

  it('succeeded with NO trainedEpochs reads as in-moderation, never as publishable', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      cost: 512,
      pollsUntilDone: 1,
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
      generation: { trainedEpochs: 0 },
    });
    await openTrain(user);
    await user.click(screen.getByTestId('dc-estimate'));
    await screen.findByTestId('dc-confirm-submit');
    await user.click(screen.getByTestId('dc-confirm-submit'));

    expect(await screen.findByTestId('dc-moderation', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.queryByTestId('dc-publish')).not.toBeInTheDocument();
    // No LoRA exists yet, so no trainer-fee credit is shown while moderation holds.
    expect(screen.queryByTestId('dc-ledger')).not.toBeInTheDocument();
  });

  it('an unquoted estimate (cost == maxBuzz) refuses the submit and states no charge', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      cost: 1, // the mock "quotes" exactly the maxBuzz sentinel -> no real quote
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
    });
    await openTrain(user);
    await user.click(screen.getByTestId('dc-estimate'));

    expect(await screen.findByTestId('dc-unquoted')).toHaveTextContent(/no price quote/i);
    expect(screen.getByTestId('dc-unquoted')).toHaveTextContent(/No Buzz was charged/);
    expect(screen.queryByTestId('dc-confirm-submit')).not.toBeInTheDocument();
  });

  it('a missing-cost estimate shows the failure detail, never a silent refusal', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      cost: 0, // below the 1-Buzz sentinel -> no usable cost came back
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
    });
    await openTrain(user);
    await user.click(screen.getByTestId('dc-estimate'));

    expect(await screen.findByTestId('dc-unquoted')).toHaveTextContent(/no usable price/i);
    expect(screen.getByTestId('dc-unquoted-detail')).toHaveTextContent(/no usable cost \(cost total was 0\)/);
    expect(screen.getByTestId('dc-unquoted')).toHaveTextContent(/No Buzz was charged/);
    expect(screen.queryByTestId('dc-confirm-submit')).not.toBeInTheDocument();
  });

  it('insufficient balance disables the train confirm and charges nothing', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      cost: 512,
      buzzBalance: { blue: 10, green: 0, yellow: 0 },
    });
    await openTrain(user);
    await user.click(screen.getByTestId('dc-estimate'));

    expect(await screen.findByTestId('dc-insufficient')).toBeInTheDocument();
    expect(screen.queryByTestId('dc-confirm-submit')).not.toBeInTheDocument();
  });

  it('excluding every item disables pricing with the reason on the surface', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
    });
    await openTrain(user);
    await user.click(screen.getByTestId('dc-exclude-item-a'));
    await user.click(screen.getByTestId('dc-exclude-item-b'));

    expect(screen.getByTestId('dc-estimate')).toBeDisabled();
    expect(screen.getByTestId('dc-train-disabled-reason')).toHaveTextContent(/No items are in the training set/);
    await waitFor(() => expect(screen.queryByTestId('dc-shares')).not.toBeInTheDocument());
  });

  it('anon viewer gets sign-in on the train surface, not a price button', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({ viewer: null });
    void user;
    render(<TrainFlow />);
    expect(await screen.findByTestId('dc-signin')).toBeInTheDocument();
    expect(screen.queryByTestId('dc-estimate')).not.toBeInTheDocument();
  });

  it("own-images kind: prepare -> quote -> Civitai run -> epochs and tracked ledger", async () => {
    const user = userEvent.setup();
    const outbound: Array<{ type: string; payload?: unknown }> = [];
    const confirmedSnapshots: unknown[] = [];
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      trainingQuoteTotal: 725,
      pollsUntilDone: 1,
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
      generation: { trainedEpochs: 10 },
      onOutbound: (message) => outbound.push(message as { type: string; payload?: unknown }),
    });
    await renderTrainFlow({
      onSnapshotConfirmed: (snapshot) => {
        confirmedSnapshots.push(snapshot);
      },
    });

    expect(screen.getByTestId('dc-own-training')).toHaveTextContent('2 own images ready');
    await user.click(screen.getByTestId('dc-own-estimate'));

    expect(await screen.findByTestId('dc-own-quote')).toHaveTextContent('725');
    const prepare = outbound.find((message) => message.type === 'PREPARE_TRAINING_DATASET');
    expect((prepare?.payload as { items?: unknown }).items).toEqual([
      { imageId: 101, caption: 'own one' },
      { imageId: 102, caption: 'own two' },
    ]);
    const estimate = outbound.find(
      (message) =>
        message.type === 'ESTIMATE_WORKFLOW' &&
        (message.payload as { body?: { kind?: string } }).body?.kind === 'training',
    );
    const estimateBody = (estimate?.payload as { body: Record<string, unknown> }).body;
    expect(estimateBody).toMatchObject({ kind: 'training', model: 'sdxl' });
    expect(estimateBody.datasetId).toMatch(/^tds_/);
    expect(estimateBody).not.toHaveProperty('quoteId');

    await user.click(screen.getByTestId('dc-own-run'));

    expect(await screen.findByTestId('dc-publish', {}, { timeout: 5000 })).toHaveTextContent(
      'Publish epoch 10',
    );
    const run = outbound.find((message) => message.type === 'RUN_TRAINING');
    const runBody = (run?.payload as { body: Record<string, unknown> }).body;
    expect(runBody).toMatchObject({ kind: 'training', datasetId: estimateBody.datasetId, model: 'sdxl' });
    expect(runBody.quoteId).toMatch(/^tq_/);
    expect(confirmedSnapshots).toHaveLength(1);
    expect(confirmedSnapshots[0]).toMatchObject({
      datasetId: 'ds-own',
      trainerId: 'dev',
      items: [
        expect.objectContaining({ itemId: 'own-a', imageId: 101, included: true }),
        expect.objectContaining({ itemId: 'own-b', imageId: 102, included: true }),
      ],
    });
    expect(screen.getByTestId('dc-credit-dev')).toHaveTextContent('725');
  });

  it('own-images blockers are named and no subset is offered for pricing', async () => {
    const user = userEvent.setup();
    void user;
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
    });
    await renderTrainFlow({
      initialItems: [
        ...ownItems,
        {
          itemId: 'other',
          contributorId: 'alice',
          imageUrl: 'https://civitai.com/images/103',
          imageId: 103,
          caption: 'not yours',
          netVotes: 2,
        },
        {
          itemId: 'no-id',
          contributorId: 'dev',
          imageUrl: 'https://civitai.com/v2/consumer/blobs/no-id',
          caption: 'no Civitai id',
          netVotes: 2,
        },
      ],
    });

    expect(await screen.findByTestId('dc-own-blocked')).toHaveTextContent(/contributed by someone else/);
    expect(screen.getByTestId('dc-own-blocked')).toHaveTextContent(/no Civitai image ID/);
    expect(screen.queryByTestId('dc-own-estimate')).not.toBeInTheDocument();
  });

  it('a prepared-dataset rejection stops before quote or run and charges nothing', async () => {
    const user = userEvent.setup();
    const outbound: Array<{ type: string }> = [];
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      trainingDatasetRejected: [{ imageId: 101, reason: 'not-eligible' }],
      onOutbound: (message) => outbound.push(message as { type: string }),
    });
    await renderTrainFlow();
    await user.click(screen.getByTestId('dc-own-estimate'));

    expect(await screen.findByTestId('dc-own-error')).toHaveTextContent(/left 1/);
    expect(screen.getByTestId('dc-own-error')).toHaveTextContent(/image #101: not-eligible/);
    expect(screen.getByTestId('dc-own-error')).toHaveTextContent(/No Buzz was charged/);
    expect(outbound.some((message) => message.type === 'RUN_TRAINING')).toBe(false);
  });

  it('an own-images estimate above the 5000-Buzz ceiling produces no run button', async () => {
    const user = userEvent.setup();
    const outbound: Array<{ type: string }> = [];
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      trainingQuoteTotal: 5001,
      onOutbound: (message) => outbound.push(message as { type: string }),
    });
    await renderTrainFlow();
    await user.click(screen.getByTestId('dc-own-estimate'));

    expect(await screen.findByTestId('dc-own-error')).toHaveTextContent(/No own-images price quote/);
    expect(screen.getByTestId('dc-own-error')).toHaveTextContent(/above the per-run limit/);
    expect(screen.getByTestId('dc-own-error')).toHaveTextContent(/No Buzz was charged/);
    expect(screen.queryByTestId('dc-own-run')).not.toBeInTheDocument();
    expect(outbound.some((message) => message.type === 'RUN_TRAINING')).toBe(false);
  });

  it('own-images insufficient balance shows the quote but no run action', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      trainingQuoteTotal: 725,
      buzzBalance: { blue: 10, green: 0, yellow: 0 },
    });
    await renderTrainFlow();
    await user.click(screen.getByTestId('dc-own-estimate'));

    expect(await screen.findByTestId('dc-own-insufficient')).toBeInTheDocument();
    expect(screen.queryByTestId('dc-own-run')).not.toBeInTheDocument();
  });

  it('if the frozen snapshot cannot be recorded, the Civitai dialog never opens', async () => {
    const user = userEvent.setup();
    const outbound: Array<{ type: string }> = [];
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      trainingQuoteTotal: 725,
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
      onOutbound: (message) => outbound.push(message as { type: string }),
    });
    await renderTrainFlow({
      onSnapshotConfirmed: () => {
        throw new Error('storage refused');
      },
    });
    await user.click(screen.getByTestId('dc-own-estimate'));
    await screen.findByTestId('dc-own-run');
    await user.click(screen.getByTestId('dc-own-run'));

    expect(await screen.findByTestId('dc-own-error')).toHaveTextContent(/training dialog was not opened/);
    expect(outbound.some((message) => message.type === 'RUN_TRAINING')).toBe(false);
  });

  it('dismissing Civitai\'s own-images dialog keeps the quote and sends only one run request', async () => {
    const user = userEvent.setup();
    const outbound: Array<{ type: string }> = [];
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      trainingQuoteTotal: 725,
      runTrainingError: 'declined',
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
      onOutbound: (message) => outbound.push(message as { type: string }),
    });
    await renderTrainFlow();
    await user.click(screen.getByTestId('dc-own-estimate'));
    await user.click(await screen.findByTestId('dc-own-run'));

    expect(await screen.findByTestId('dc-own-run')).toBeEnabled();
    expect(screen.queryByTestId('dc-own-error')).not.toBeInTheDocument();
    expect(outbound.filter((message) => message.type === 'RUN_TRAINING')).toHaveLength(1);
  });

  it('an unconfirmed own-images submission is never offered an automatic retry', async () => {
    const user = userEvent.setup();
    const outbound: Array<{ type: string }> = [];
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      trainingQuoteTotal: 725,
      runTrainingError: 'submission-unconfirmed',
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
      onOutbound: (message) => outbound.push(message as { type: string }),
    });
    await renderTrainFlow();
    await user.click(screen.getByTestId('dc-own-estimate'));
    await user.click(await screen.findByTestId('dc-own-run'));

    expect(await screen.findByTestId('dc-own-unconfirmed')).toHaveTextContent(/may have been charged/);
    expect(screen.getByTestId('dc-own-unconfirmed')).toHaveTextContent(/will not retry automatically/);
    expect(screen.queryByTestId('dc-own-run')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dc-own-estimate')).not.toBeInTheDocument();
    expect(outbound.filter((message) => message.type === 'RUN_TRAINING')).toHaveLength(1);
  });

  it('a cap-refused own-images run is explicit that nothing was charged', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      trainingQuoteTotal: 725,
      runTrainingCapRefusal: 'daily Buzz cap reached for this viewer',
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
    });
    await renderTrainFlow();
    await user.click(screen.getByTestId('dc-own-estimate'));
    await user.click(await screen.findByTestId('dc-own-run'));

    expect(await screen.findByTestId('dc-own-error')).toHaveTextContent(/daily Buzz cap reached/);
    expect(screen.getByTestId('dc-own-error')).toHaveTextContent(/nothing was charged/);
    expect(screen.getByTestId('dc-own-estimate')).toBeInTheDocument();
  });
});
