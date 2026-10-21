import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { PAGE_BUZZ_BUDGET } from './generation.js';
import { TrainFlow, type TrainFlowProps, type TrainRunLink } from './TrainFlow.js';
import { installMockMoneyHost } from './mock-buzz.js';
import type { DatasetItem, LedgerEvent } from './training.js';

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

/** Contributed by OTHER people — the trainer re-uploads them for Civitai's trainer. */
const communityItems: DatasetItem[] = [
  {
    itemId: 'a',
    contributorId: 'alice',
    imageUrl: 'https://civitai.com/images/101',
    imageId: 101,
    caption: 'front',
    netVotes: 3,
  },
  {
    itemId: 'b',
    contributorId: 'bob',
    imageUrl: 'https://civitai.com/images/102',
    imageId: 102,
    caption: 'profile',
    netVotes: 1,
  },
];

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
      // The page's per-call budget (manifest buzzBudgetPerGen). Since SDK 0.67 the mock
      // refuses an over-budget training $type estimate as the real host does.
      buzzBudget: PAGE_BUZZ_BUDGET,
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
      // The page's per-call budget (manifest buzzBudgetPerGen). Since SDK 0.67 the mock
      // refuses an over-budget training $type estimate as the real host does.
      buzzBudget: PAGE_BUZZ_BUDGET,
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
      // The page's per-call budget (manifest buzzBudgetPerGen). Since SDK 0.67 the mock
      // refuses an over-budget training $type estimate as the real host does.
      buzzBudget: PAGE_BUZZ_BUDGET,
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

  it("a pass-through quote above the per-call budget points the trainer at Civitai's trainer", async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      cost: 512,
      buzzBudget: 200, // below the quote: the host refuses a training $type as a confirmed step
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
    });
    await openTrain(user);
    await user.click(screen.getByTestId('dc-estimate'));

    expect(await screen.findByTestId('dc-unquoted-detail')).toHaveTextContent(
      "use Civitai's trainer below",
    );
    expect(screen.queryByTestId('dc-confirm-submit')).not.toBeInTheDocument();
  });

  it('insufficient balance disables the train confirm and charges nothing', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      cost: 512,
      // The page's per-call budget (manifest buzzBudgetPerGen). Since SDK 0.67 the mock
      // refuses an over-budget training $type estimate as the real host does.
      buzzBudget: PAGE_BUZZ_BUDGET,
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

  // --- Civitai's trainer (kind: 'training', SDK 0.77): the trainer uploads the
  // frozen snapshot's images through the host modal; captions carry over. ---

  const upload = (n: number) => ({
    url: `https://blobs.mock.invalid/v2/consumer/blobs/up${n}.png`,
    air: `up${n}.png`,
  });
  type Outbound = { type: string; payload?: unknown };
  const trainingBodies = (outbound: Outbound[], type: string) =>
    outbound
      .filter(
        (m) => m.type === type && (m.payload as { body?: { kind?: string } }).body?.kind === 'training',
      )
      .map((m) => (m.payload as { body: Record<string, unknown> }).body);

  async function uploadAndPrice(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByTestId('dc-kind-upload'));
    await screen.findByTestId('dc-kind-pairs');
    await user.click(screen.getByTestId('dc-kind-attest'));
    await user.click(screen.getByTestId('dc-kind-estimate'));
  }

  it("Civitai's trainer: upload -> captions carried over -> quote -> Civitai run -> epochs and vote-weighted ledger", async () => {
    const user = userEvent.setup();
    const outbound: Outbound[] = [];
    const confirmedSnapshots: unknown[] = [];
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      trainingQuoteTotal: 725,
      pollsUntilDone: 1,
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
      generation: { trainedEpochs: 10 },
      cannedTrainingDataUpload: [upload(1), upload(2)],
      onOutbound: (message) => outbound.push(message as Outbound),
    });
    await renderTrainFlow({
      initialItems: communityItems,
      onSnapshotConfirmed: (snapshot) => {
        confirmedSnapshots.push(snapshot);
      },
    });

    // Contributors are other people — this path no longer needs own images.
    expect(screen.getByTestId('dc-kind-training')).toHaveTextContent('2 images to upload');
    expect(screen.getByTestId('dc-kind-list')).toHaveTextContent('#1front');
    expect(screen.getByTestId('dc-kind-upload')).toHaveTextContent('Upload these 2 images');

    await uploadAndPrice(user);
    expect(await screen.findByTestId('dc-kind-quote')).toHaveTextContent('725');

    const uploadRequests = outbound.filter((m) => m.type === 'OPEN_IMAGE_UPLOAD');
    expect(uploadRequests.map((m) => (m.payload as { purpose?: string }).purpose)).toEqual(['trainingData']);
    const [estimateBody] = trainingBodies(outbound, 'ESTIMATE_WORKFLOW');
    expect(estimateBody).toMatchObject({
      kind: 'training',
      model: 'sdxl',
      items: [
        { air: 'up1.png', caption: 'front' },
        { air: 'up2.png', caption: 'profile' },
      ],
    });
    expect(estimateBody).not.toHaveProperty('datasetId');
    expect(estimateBody).not.toHaveProperty('quoteId');
    expect(outbound.some((m) => m.type === 'PREPARE_TRAINING_DATASET')).toBe(false);

    await user.click(screen.getByTestId('dc-kind-run'));
    expect(await screen.findByTestId('dc-publish', {}, { timeout: 5000 })).toHaveTextContent('Publish epoch 10');

    const [runBody] = trainingBodies(outbound, 'RUN_TRAINING');
    const { quoteId, ...runRest } = runBody!;
    expect(quoteId).toMatch(/^tq_/);
    expect(runRest).toEqual(estimateBody); // the run changes nothing but the quoteId
    expect(confirmedSnapshots).toHaveLength(1);
    expect(confirmedSnapshots[0]).toMatchObject({ datasetId: 'ds-own', trainerId: 'dev' });
    // 725 split 3:1 by frozen votes -> alice 544, bob 181 (largest remainder).
    expect(screen.getByTestId('dc-credit-alice')).toHaveTextContent('544');
    expect(screen.getByTestId('dc-credit-bob')).toHaveTextContent('181');
  });

  it("re-matching an upload moves the snapshot caption with it into the priced body", async () => {
    const user = userEvent.setup();
    const outbound: Outbound[] = [];
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      trainingQuoteTotal: 725,
      cannedTrainingDataUpload: [upload(1), upload(2)],
      onOutbound: (message) => outbound.push(message as Outbound),
    });
    await renderTrainFlow({ initialItems: communityItems });
    await user.click(screen.getByTestId('dc-kind-upload'));
    await user.selectOptions(await screen.findByTestId('dc-kind-match-0'), 'b');
    expect(screen.getByTestId('dc-kind-problems')).toHaveTextContent(
      'Training-set image #2 is matched to both upload #1 and upload #2.',
    );
    expect(screen.getByTestId('dc-kind-estimate')).toBeDisabled();
    await user.selectOptions(screen.getByTestId('dc-kind-match-1'), 'a');
    expect(screen.queryByTestId('dc-kind-problems')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('dc-kind-attest'));
    await user.click(screen.getByTestId('dc-kind-estimate'));
    await screen.findByTestId('dc-kind-quote');

    expect(trainingBodies(outbound, 'ESTIMATE_WORKFLOW')[0]!.items).toEqual([
      { air: 'up1.png', caption: 'profile' },
      { air: 'up2.png', caption: 'front' },
    ]);
  });

  it('uploading the wrong number of images blocks pricing and sends no estimate', async () => {
    const user = userEvent.setup();
    const outbound: Outbound[] = [];
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      cannedTrainingDataUpload: [upload(1), upload(2), upload(3)],
      onOutbound: (message) => outbound.push(message as Outbound),
    });
    await renderTrainFlow({ initialItems: communityItems });
    await user.click(screen.getByTestId('dc-kind-upload'));

    expect(await screen.findByTestId('dc-kind-problems')).toHaveTextContent(
      'You uploaded 3 images, but the training set has 2.',
    );
    expect(screen.getByTestId('dc-kind-estimate')).toBeDisabled();
    expect(trainingBodies(outbound, 'ESTIMATE_WORKFLOW')).toHaveLength(0);
    expect(screen.getByTestId('dc-kind-upload')).toHaveTextContent('Upload again');
  });

  it('a cancelled upload changes nothing', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      cannedTrainingDataUpload: null,
    });
    await renderTrainFlow({ initialItems: communityItems });
    await user.click(screen.getByTestId('dc-kind-upload'));
    await waitFor(() => expect(screen.getByTestId('dc-kind-upload')).toBeEnabled());
    expect(screen.queryByTestId('dc-kind-pairs')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dc-kind-error')).not.toBeInTheDocument();
  });

  it('training data not uploaded here: nothing ran, uploads are dropped, the viewer is asked to upload again', async () => {
    const user = userEvent.setup();
    const outbound: Outbound[] = [];
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      trainingQuoteTotal: 725,
      trainingDataNotUploadedHere: true,
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
      cannedTrainingDataUpload: [upload(1), upload(2)],
      onOutbound: (message) => outbound.push(message as Outbound),
    });
    await renderTrainFlow({ initialItems: communityItems });
    await uploadAndPrice(user);
    await user.click(await screen.findByTestId('dc-kind-run'));

    expect(await screen.findByTestId('dc-kind-error')).toHaveTextContent(
      'Civitai no longer has these uploads for this page (for example after a reload). No run was started and no Buzz was charged. Upload the images again, then price the run again.',
    );
    expect(screen.queryByTestId('dc-kind-pairs')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dc-kind-run')).not.toBeInTheDocument();
    expect(screen.getByTestId('dc-kind-upload')).toHaveTextContent('Upload these 2 images');
    expect(screen.queryByTestId('dc-run')).not.toBeInTheDocument();
    expect(trainingBodies(outbound, 'RUN_TRAINING')).toHaveLength(1);
  });

  it("an estimate above the 5000-Buzz ceiling produces no run button", async () => {
    const user = userEvent.setup();
    const outbound: Outbound[] = [];
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      trainingQuoteTotal: 5001,
      cannedTrainingDataUpload: [upload(1), upload(2)],
      onOutbound: (message) => outbound.push(message as Outbound),
    });
    await renderTrainFlow({ initialItems: communityItems });
    await uploadAndPrice(user);

    expect(await screen.findByTestId('dc-kind-error')).toHaveTextContent(/No price quote/);
    expect(screen.getByTestId('dc-kind-error')).toHaveTextContent(/above the per-run limit/);
    expect(screen.getByTestId('dc-kind-error')).toHaveTextContent(/No Buzz was charged/);
    expect(screen.queryByTestId('dc-kind-run')).not.toBeInTheDocument();
    expect(trainingBodies(outbound, 'RUN_TRAINING')).toHaveLength(0);
  });

  it('insufficient balance shows the quote but no run action', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      trainingQuoteTotal: 725,
      buzzBalance: { blue: 10, green: 0, yellow: 0 },
      cannedTrainingDataUpload: [upload(1), upload(2)],
    });
    await renderTrainFlow({ initialItems: communityItems });
    await uploadAndPrice(user);

    expect(await screen.findByTestId('dc-kind-insufficient')).toBeInTheDocument();
    expect(screen.queryByTestId('dc-kind-run')).not.toBeInTheDocument();
  });

  it('if the frozen snapshot cannot be recorded, the Civitai dialog never opens', async () => {
    const user = userEvent.setup();
    const outbound: Outbound[] = [];
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      trainingQuoteTotal: 725,
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
      cannedTrainingDataUpload: [upload(1), upload(2)],
      onOutbound: (message) => outbound.push(message as Outbound),
    });
    await renderTrainFlow({
      initialItems: communityItems,
      onSnapshotConfirmed: () => {
        throw new Error('storage refused');
      },
    });
    await uploadAndPrice(user);
    await user.click(await screen.findByTestId('dc-kind-run'));

    expect(await screen.findByTestId('dc-kind-error')).toHaveTextContent(/training dialog was not opened/);
    expect(trainingBodies(outbound, 'RUN_TRAINING')).toHaveLength(0);
  });

  it("dismissing Civitai's dialog keeps the quote and sends only one run request", async () => {
    const user = userEvent.setup();
    const outbound: Outbound[] = [];
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      trainingQuoteTotal: 725,
      runTrainingError: 'declined',
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
      cannedTrainingDataUpload: [upload(1), upload(2)],
      onOutbound: (message) => outbound.push(message as Outbound),
    });
    await renderTrainFlow({ initialItems: communityItems });
    await uploadAndPrice(user);
    await user.click(await screen.findByTestId('dc-kind-run'));

    expect(await screen.findByTestId('dc-kind-run')).toBeEnabled();
    expect(screen.queryByTestId('dc-kind-error')).not.toBeInTheDocument();
    expect(trainingBodies(outbound, 'RUN_TRAINING')).toHaveLength(1);
  });

  it('an unconfirmed submission is never offered an automatic retry', async () => {
    const user = userEvent.setup();
    const outbound: Outbound[] = [];
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      trainingQuoteTotal: 725,
      runTrainingError: 'submission-unconfirmed',
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
      cannedTrainingDataUpload: [upload(1), upload(2)],
      onOutbound: (message) => outbound.push(message as Outbound),
    });
    await renderTrainFlow({ initialItems: communityItems });
    await uploadAndPrice(user);
    await user.click(await screen.findByTestId('dc-kind-run'));

    expect(await screen.findByTestId('dc-kind-unconfirmed')).toHaveTextContent(/may have been charged/);
    expect(screen.getByTestId('dc-kind-unconfirmed')).toHaveTextContent(/will not retry automatically/);
    expect(screen.queryByTestId('dc-kind-run')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dc-kind-estimate')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dc-kind-upload')).not.toBeInTheDocument();
    expect(trainingBodies(outbound, 'RUN_TRAINING')).toHaveLength(1);
  });

  it('a cap-refused run is explicit that nothing was charged', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      trainingQuoteTotal: 725,
      runTrainingCapRefusal: 'daily Buzz cap reached for this viewer',
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
      cannedTrainingDataUpload: [upload(1), upload(2)],
    });
    await renderTrainFlow({ initialItems: communityItems });
    await uploadAndPrice(user);
    await user.click(await screen.findByTestId('dc-kind-run'));

    expect(await screen.findByTestId('dc-kind-error')).toHaveTextContent(/daily Buzz cap reached/);
    expect(screen.getByTestId('dc-kind-error')).toHaveTextContent(/nothing was charged/);
    expect(screen.getByTestId('dc-kind-estimate')).toBeInTheDocument();
  });

  it('a training set over 50 images is named as a blocker, with no upload offered', async () => {
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
    });
    await renderTrainFlow({
      initialItems: Array.from({ length: 51 }, (_, i) => ({
        itemId: `i${i}`,
        contributorId: 'alice',
        imageUrl: `https://civitai.com/images/${i + 1}`,
        caption: `c${i}`,
        netVotes: 1,
      })),
    });
    expect(screen.getByTestId('dc-kind-blocked')).toHaveTextContent(/at most 50/);
    expect(screen.queryByTestId('dc-kind-upload')).not.toBeInTheDocument();
  });

  it('a Civitai-trainer-only base model disables the pass-through price button with the reason', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
    });
    await renderTrainFlow({ initialItems: communityItems });
    await user.selectOptions(screen.getByTestId('dc-preset'), 'flux');
    expect(screen.getByTestId('dc-estimate')).toBeDisabled();
    expect(screen.getByTestId('dc-train-disabled-reason')).toHaveTextContent(
      "Flux trains only on Civitai's trainer below",
    );
    expect(screen.getByTestId('dc-kind-upload')).toBeEnabled();
  });

  // --- Trainer attestation (kind: 'training' only): the app sees `{ url, air }`
  // and cannot prove the uploads are the snapshot's images. ---

  it('the attestation is unchecked by default and gates pricing — no estimate is sent without it', async () => {
    const user = userEvent.setup();
    const outbound: Outbound[] = [];
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      trainingQuoteTotal: 725,
      cannedTrainingDataUpload: [upload(1), upload(2)],
      onOutbound: (message) => outbound.push(message as Outbound),
    });
    await renderTrainFlow({ initialItems: communityItems });
    await user.click(screen.getByTestId('dc-kind-upload'));
    await screen.findByTestId('dc-kind-pairs');

    const attest = screen.getByTestId('dc-kind-attest');
    expect(attest).not.toBeChecked();
    expect(screen.queryByTestId('dc-kind-problems')).not.toBeInTheDocument(); // the pairing itself is fine
    expect(screen.getByTestId('dc-kind-estimate')).toBeDisabled();
    await user.click(screen.getByTestId('dc-kind-estimate'));
    expect(trainingBodies(outbound, 'ESTIMATE_WORKFLOW')).toHaveLength(0);

    await user.click(attest);
    expect(screen.getByTestId('dc-kind-estimate')).toBeEnabled();
    await user.click(screen.getByTestId('dc-kind-estimate'));
    expect(await screen.findByTestId('dc-kind-quote')).toHaveTextContent('725');
    expect(trainingBodies(outbound, 'ESTIMATE_WORKFLOW')).toHaveLength(1);
  });

  it('a new upload or a re-match clears the attestation', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      cannedTrainingDataUpload: [upload(1), upload(2)],
    });
    await renderTrainFlow({ initialItems: communityItems });
    await user.click(screen.getByTestId('dc-kind-upload'));
    await screen.findByTestId('dc-kind-pairs');

    await user.click(screen.getByTestId('dc-kind-attest'));
    expect(screen.getByTestId('dc-kind-attest')).toBeChecked();
    await user.selectOptions(screen.getByTestId('dc-kind-match-0'), 'b');
    expect(screen.getByTestId('dc-kind-attest')).not.toBeChecked();

    await user.selectOptions(screen.getByTestId('dc-kind-match-0'), 'a');
    await user.click(screen.getByTestId('dc-kind-attest'));
    expect(screen.getByTestId('dc-kind-attest')).toBeChecked();
    expect(screen.getByTestId('dc-kind-estimate')).toBeEnabled();
    await user.click(screen.getByTestId('dc-kind-upload')); // "Upload again"
    await waitFor(() => expect(screen.getByTestId('dc-kind-attest')).not.toBeChecked());
    expect(screen.getByTestId('dc-kind-estimate')).toBeDisabled();
  });

  it("a Civitai-trainer run is recorded as trainer-attested in the ledger event and the LoRA link", async () => {
    const user = userEvent.setup();
    const ledgerEvents: LedgerEvent[] = [];
    const links: TrainRunLink[] = [];
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      trainingQuoteTotal: 725,
      pollsUntilDone: 1,
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
      generation: { trainedEpochs: 10 },
      cannedTrainingDataUpload: [upload(1), upload(2)],
    });
    await renderTrainFlow({
      initialItems: communityItems,
      onLedgerEvent: (event) => {
        ledgerEvents.push(event);
      },
      onRunLinked: (link) => {
        links.push(link);
      },
    });
    await uploadAndPrice(user);
    await user.click(await screen.findByTestId('dc-kind-run'));
    await screen.findByTestId('dc-publish', {}, { timeout: 5000 });

    await waitFor(() => expect(ledgerEvents).toHaveLength(1));
    expect(ledgerEvents[0]).toMatchObject({ eventType: 'training', grossBuzz: 725, dataSource: 'trainer-attested' });
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((l) => l.dataSource === 'trainer-attested')).toBe(true);
    expect(screen.getByTestId('dc-ledger-source')).toHaveTextContent('Trainer-attested uploads');
  });

  it('a pass-through run is recorded with the snapshot source and shows no attested label', async () => {
    const user = userEvent.setup();
    const ledgerEvents: LedgerEvent[] = [];
    const links: TrainRunLink[] = [];
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      cost: 512,
      buzzBudget: PAGE_BUZZ_BUDGET,
      pollsUntilDone: 1,
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
      generation: { trainedEpochs: 10 },
    });
    render(
      <TrainFlow
        hideThemeToggle
        onLedgerEvent={(event) => {
          ledgerEvents.push(event);
        }}
        onRunLinked={(link) => {
          links.push(link);
        }}
      />,
    );
    await user.click(await screen.findByTestId('dc-estimate'));
    await user.click(await screen.findByTestId('dc-confirm-submit'));
    await screen.findByTestId('dc-publish', {}, { timeout: 5000 });

    await waitFor(() => expect(ledgerEvents).toHaveLength(1));
    expect(ledgerEvents[0]).toMatchObject({ eventType: 'training', grossBuzz: 512, dataSource: 'snapshot' });
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((l) => l.dataSource === 'snapshot')).toBe(true);
    expect(screen.getByTestId('dc-ledger')).toBeInTheDocument();
    expect(screen.queryByTestId('dc-ledger-source')).not.toBeInTheDocument();
  });

  it("choosing a base model loads Training Studio's step and epoch defaults for it", async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
    });
    await renderTrainFlow({ initialItems: communityItems });
    expect(screen.getByTestId('dc-steps')).toHaveValue(2000);
    expect(screen.getByTestId('dc-epochs')).toHaveValue(10);
    await user.selectOptions(screen.getByTestId('dc-preset'), 'anima');
    expect(screen.getByTestId('dc-steps')).toHaveValue(1500);
    expect(screen.getByTestId('dc-epochs')).toHaveValue(5);
    await user.selectOptions(screen.getByTestId('dc-preset'), 'boogu');
    expect(screen.getByTestId('dc-steps')).toHaveValue(3000);
    expect(screen.getByTestId('dc-epochs')).toHaveValue(5);
    await user.selectOptions(screen.getByTestId('dc-preset'), 'sdxl');
    expect(screen.getByTestId('dc-steps')).toHaveValue(2000);
    expect(screen.getByTestId('dc-epochs')).toHaveValue(10);
  });
});
