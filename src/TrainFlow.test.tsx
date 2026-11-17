import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PAGE_BUZZ_BUDGET } from './generation.js';
import { TrainFlow, type TrainFlowProps, type TrainRunLink } from './TrainFlow.js';
import { installMockMoneyHost } from './mock-buzz.js';
import type { DatasetItem, DatasetSnapshot, LedgerEvent } from './training.js';

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

/** One `purpose: 'trainingData'` upload result, as the host returns it (SDK 0.90: an AIR key, no url). */
const trainingUpload = (n: number) => ({ air: `up${n}.png` });

/** The shared step both paths need first: upload the training set, then attest the match. */
async function uploadAndAttest(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByTestId('dc-train-upload'));
  await screen.findByTestId('dc-train-pairs');
  await user.click(screen.getByTestId('dc-train-attest'));
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
      {...props}
    />,
  );
  return screen.findByTestId('dc-train');
}

// Page visibility for the lost-contact tests: jsdom's document is always visible,
// so `hidden` / `visibilityState` are overridden on the document instance (the
// prototype getters stay untouched) and removed again after each test.
let pageHiddenNow = false;
function setPageHidden(hidden: boolean) {
  pageHiddenNow = hidden;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => pageHiddenNow });
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (pageHiddenNow ? 'hidden' : 'visible'),
  });
}
/** Switch the tab out of / back into view, firing the event the page listens for. */
function switchTab(hidden: boolean) {
  setPageHidden(hidden);
  document.dispatchEvent(new Event('visibilitychange'));
}
function restoreVisibility() {
  pageHiddenNow = false;
  delete (document as { hidden?: boolean }).hidden;
  delete (document as { visibilityState?: string }).visibilityState;
}

describe('TrainFlow (Option A′)', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    vi.useRealTimers();
    restoreVisibility();
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

  it('Archive Lab roots dark with no theme toggle', async () => {
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
    });
    await openTrain(userEvent.setup());
    const root = screen.getByTestId('dc-theme-root');
    expect(root).toHaveAttribute('data-theme', 'dark');
    expect(screen.queryByTestId('dc-theme-toggle')).not.toBeInTheDocument();
  });

  it('estimate -> quote -> confirm -> submit -> trainedEpochs -> ready to publish, ledger credits vote-weighted', async () => {
    const user = userEvent.setup();
    const submittedBodies: Array<Record<string, unknown>> = [];
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      cannedTrainingDataUpload: [trainingUpload(1), trainingUpload(2)],
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

    await uploadAndAttest(user);
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
    const input = body.input as { trainingData: { type: string; items: unknown[] }; triggerWord?: string };
    // It trains on the host's `trainingData` upload keys, each with its snapshot
    // item's frozen caption — never on the items' stored image urls.
    expect(input.trainingData).toEqual({
      type: 'blobs',
      items: [
        { air: 'up1.png', caption: 'ink portrait, front view' },
        { air: 'up2.png', caption: 'ink portrait, profile view' },
      ],
    });
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
      cannedTrainingDataUpload: [trainingUpload(1), trainingUpload(2)],
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
    await uploadAndAttest(user);
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
      cannedTrainingDataUpload: [trainingUpload(1), trainingUpload(2)],
      cost: 512,
      // The page's per-call budget (manifest buzzBudgetPerGen). Since SDK 0.67 the mock
      // refuses an over-budget training $type estimate as the real host does.
      buzzBudget: PAGE_BUZZ_BUDGET,
      pollsUntilDone: 1,
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
      generation: { trainedEpochs: 0 },
    });
    await openTrain(user);
    await uploadAndAttest(user);
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
      cannedTrainingDataUpload: [trainingUpload(1), trainingUpload(2)],
      cost: 1, // the mock "quotes" exactly the maxBuzz sentinel -> no real quote
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
    });
    await openTrain(user);
    await uploadAndAttest(user);
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
      cannedTrainingDataUpload: [trainingUpload(1), trainingUpload(2)],
      cost: 0, // below the 1-Buzz sentinel -> no usable cost came back
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
    });
    await openTrain(user);
    await uploadAndAttest(user);
    await user.click(screen.getByTestId('dc-estimate'));

    expect(await screen.findByTestId('dc-unquoted')).toHaveTextContent(/no usable price/i);
    expect(screen.getByTestId('dc-unquoted-detail')).toHaveTextContent(/no usable cost \(cost total was 0\)/);
    expect(screen.getByTestId('dc-unquoted')).toHaveTextContent(/No Buzz was charged/);
    expect(screen.queryByTestId('dc-confirm-submit')).not.toBeInTheDocument();
  });

  it("a pass-through quote above the per-call budget points the trainer at Civitai's trainer", async () => {
    // (Carries the 0.2.0 refusal tests' assertions: the host's own message, an
    // honest no-charge line, nothing submitted, no post-run surface left behind.)
    const user = userEvent.setup();
    const submittedBodies: Array<Record<string, unknown>> = [];
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      cannedTrainingDataUpload: [trainingUpload(1), trainingUpload(2)],
      cost: 512,
      buzzBudget: 200, // below the quote: the host refuses a training $type as a confirmed step
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
      // Same collector as the happy-path test above, which sees its submit.
      onOutbound: (m) => {
        if (m.type === 'SUBMIT_WORKFLOW') {
          submittedBodies.push((m.payload as { body: Record<string, unknown> }).body);
        }
      },
    });
    await openTrain(user);
    await uploadAndAttest(user);
    await user.click(screen.getByTestId('dc-estimate'));

    expect(await screen.findByTestId('dc-unquoted-detail')).toHaveTextContent(
      "use Civitai's trainer below",
    );
    expect(screen.getByTestId('dc-unquoted-detail')).toHaveTextContent(
      /a training step type cannot run as a confirmed step/i,
    );
    expect(screen.getByTestId('dc-unquoted')).toHaveTextContent(/No Buzz was charged/);
    expect(screen.queryByTestId('dc-quote')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dc-confirm-submit')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dc-insufficient')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dc-publish')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dc-published')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dc-moderation')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dc-ledger')).not.toBeInTheDocument();
    expect(submittedBodies).toHaveLength(0);
  });

  it('insufficient balance disables the train confirm and charges nothing', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      cannedTrainingDataUpload: [trainingUpload(1), trainingUpload(2)],
      cost: 512,
      // The page's per-call budget (manifest buzzBudgetPerGen). Since SDK 0.67 the mock
      // refuses an over-budget training $type estimate as the real host does.
      buzzBudget: PAGE_BUZZ_BUDGET,
      buzzBalance: { blue: 10, green: 0, yellow: 0 },
    });
    await openTrain(user);
    await uploadAndAttest(user);
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

  type Outbound = { type: string; payload?: unknown };
  const trainingBodies = (outbound: Outbound[], type: string) =>
    outbound
      .filter(
        (m) => m.type === type && (m.payload as { body?: { kind?: string } }).body?.kind === 'training',
      )
      .map((m) => (m.payload as { body: Record<string, unknown> }).body);

  async function uploadAndPrice(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByTestId('dc-train-upload'));
    await screen.findByTestId('dc-train-pairs');
    await user.click(screen.getByTestId('dc-train-attest'));
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
      cannedTrainingDataUpload: [trainingUpload(1), trainingUpload(2)],
      onOutbound: (message) => outbound.push(message as Outbound),
    });
    await renderTrainFlow({
      initialItems: communityItems,
      onSnapshotConfirmed: (snapshot) => {
        confirmedSnapshots.push(snapshot);
      },
    });

    // Contributors are other people — this path no longer needs own images.
    expect(screen.getByTestId('dc-train-uploads')).toHaveTextContent('2 images to upload');
    expect(screen.getByTestId('dc-train-list')).toHaveTextContent('#1front');
    expect(screen.getByTestId('dc-train-upload')).toHaveTextContent('Upload these 2 images');

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
      cannedTrainingDataUpload: [trainingUpload(1), trainingUpload(2)],
      onOutbound: (message) => outbound.push(message as Outbound),
    });
    await renderTrainFlow({ initialItems: communityItems });
    await user.click(screen.getByTestId('dc-train-upload'));
    await user.selectOptions(await screen.findByTestId('dc-train-match-0'), 'b');
    expect(screen.getByTestId('dc-train-problems')).toHaveTextContent(
      'Training-set image #2 is matched to both upload #1 and upload #2.',
    );
    expect(screen.getByTestId('dc-kind-estimate')).toBeDisabled();
    await user.selectOptions(screen.getByTestId('dc-train-match-1'), 'a');
    expect(screen.queryByTestId('dc-train-problems')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('dc-train-attest'));
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
      cannedTrainingDataUpload: [trainingUpload(1), trainingUpload(2), trainingUpload(3)],
      onOutbound: (message) => outbound.push(message as Outbound),
    });
    await renderTrainFlow({ initialItems: communityItems });
    await user.click(screen.getByTestId('dc-train-upload'));

    expect(await screen.findByTestId('dc-train-problems')).toHaveTextContent(
      'You uploaded 3 images, but the training set has 2.',
    );
    expect(screen.getByTestId('dc-kind-estimate')).toBeDisabled();
    expect(trainingBodies(outbound, 'ESTIMATE_WORKFLOW')).toHaveLength(0);
    expect(screen.getByTestId('dc-train-upload')).toHaveTextContent('Upload again');
  });

  it('a cancelled upload changes nothing', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      cannedTrainingDataUpload: null,
    });
    await renderTrainFlow({ initialItems: communityItems });
    await user.click(screen.getByTestId('dc-train-upload'));
    await waitFor(() => expect(screen.getByTestId('dc-train-upload')).toBeEnabled());
    expect(screen.queryByTestId('dc-train-pairs')).not.toBeInTheDocument();
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
      cannedTrainingDataUpload: [trainingUpload(1), trainingUpload(2)],
      onOutbound: (message) => outbound.push(message as Outbound),
    });
    await renderTrainFlow({ initialItems: communityItems });
    await uploadAndPrice(user);
    await user.click(await screen.findByTestId('dc-kind-run'));

    expect(await screen.findByTestId('dc-kind-error')).toHaveTextContent(
      'Civitai no longer has these uploads for this page (for example after a reload). No run was started and no Buzz was charged. Upload the images again, then price the run again.',
    );
    expect(screen.queryByTestId('dc-train-pairs')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dc-kind-run')).not.toBeInTheDocument();
    expect(screen.getByTestId('dc-train-upload')).toHaveTextContent('Upload these 2 images');
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
      cannedTrainingDataUpload: [trainingUpload(1), trainingUpload(2)],
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
      cannedTrainingDataUpload: [trainingUpload(1), trainingUpload(2)],
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
      cannedTrainingDataUpload: [trainingUpload(1), trainingUpload(2)],
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
      cannedTrainingDataUpload: [trainingUpload(1), trainingUpload(2)],
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
      cannedTrainingDataUpload: [trainingUpload(1), trainingUpload(2)],
      onOutbound: (message) => outbound.push(message as Outbound),
    });
    await renderTrainFlow({ initialItems: communityItems });
    await uploadAndPrice(user);
    await user.click(await screen.findByTestId('dc-kind-run'));

    expect(await screen.findByTestId('dc-kind-unconfirmed')).toHaveTextContent(/may have been charged/);
    expect(screen.getByTestId('dc-kind-unconfirmed')).toHaveTextContent(/will not retry automatically/);
    expect(screen.queryByTestId('dc-kind-run')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dc-kind-estimate')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dc-train-upload')).not.toBeInTheDocument();
    expect(trainingBodies(outbound, 'RUN_TRAINING')).toHaveLength(1);
  });

  it('after an unconfirmed run, BOTH paths stop pricing until the trainer says they checked', async () => {
    const user = userEvent.setup();
    const outbound: Outbound[] = [];
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      trainingQuoteTotal: 725,
      runTrainingError: 'submission-unconfirmed',
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
      cannedTrainingDataUpload: [trainingUpload(1), trainingUpload(2)],
      onOutbound: (message) => outbound.push(message as Outbound),
    });
    await renderTrainFlow({ initialItems: communityItems });
    await uploadAndPrice(user);
    await user.click(await screen.findByTestId('dc-kind-run'));
    await screen.findByTestId('dc-kind-unconfirmed');

    // The pass-through price button stays on screen but cannot price a second,
    // separately charged run on the same uploads; Civitai's trainer offers none.
    expect(screen.getByTestId('dc-estimate')).toBeDisabled();
    expect(screen.queryByTestId('dc-kind-estimate')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('dc-estimate'));
    expect(outbound.filter((m) => m.type === 'ESTIMATE_WORKFLOW' && (m.payload as { body?: { kind?: string } }).body?.kind === 'step')).toHaveLength(0);

    // Only the trainer's explicit acknowledgement re-opens pricing.
    await user.click(screen.getByTestId('dc-kind-ack'));
    expect(screen.queryByTestId('dc-kind-unconfirmed')).not.toBeInTheDocument();
    expect(screen.getByTestId('dc-estimate')).toBeEnabled();
    expect(screen.getByTestId('dc-kind-estimate')).toBeEnabled();
    expect(trainingBodies(outbound, 'RUN_TRAINING')).toHaveLength(1);
  });

  it('Find my run links the one new app workflow to the persisted snapshot, so its credit is recorded', async () => {
    const user = userEvent.setup();
    const confirmed: DatasetSnapshot[] = [];
    const ledgerEvents: LedgerEvent[] = [];
    const links: TrainRunLink[] = [];
    const old = { workflowId: 'wf_old', status: 'succeeded' as const, images: [], cost: 725, createdAt: '2026-10-20T10:00:00.000Z' };
    const handle = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      trainingQuoteTotal: 725,
      runTrainingError: 'submission-unconfirmed',
      // What the mock reports for the found run when it is polled: its cost and
      // (the SDK mock gives a run it did not submit no epochs) its trained epochs.
      cost: 725,
      pollsUntilDone: 1,
      trainedEpochsFor: { wf_lost_run: 10 },
      appWorkflows: { workflows: [old] },
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
      cannedTrainingDataUpload: [trainingUpload(1), trainingUpload(2)],
    });
    uninstall = handle;
    await renderTrainFlow({
      initialItems: communityItems,
      onSnapshotConfirmed: (s) => void confirmed.push(s),
      onLedgerEvent: (e) => void ledgerEvents.push(e),
      onRunLinked: (l) => void links.push(l),
    });
    await uploadAndPrice(user);
    await user.click(await screen.findByTestId('dc-kind-run'));
    await screen.findByTestId('dc-kind-unconfirmed');
    expect(confirmed).toHaveLength(1);
    expect(screen.getByTestId('dc-kind-unconfirmed')).toHaveTextContent(confirmed[0]!.snapshotId);

    // The run did start: it is the one workflow new in this app's queue since
    // just before Civitai's dialog opened.
    handle.setScenario({
      appWorkflows: {
        workflows: [
          { workflowId: 'wf_lost_run', status: 'processing', images: [], cost: 725, createdAt: '2026-10-20T10:05:00.000Z' },
          old,
        ],
      },
    });
    await user.click(screen.getByTestId('dc-kind-find-run'));

    await waitFor(() => expect(ledgerEvents.map((e) => e.sourceRef)).toEqual(['wf_lost_run']), { timeout: 5000 });
    expect(ledgerEvents[0]!.snapshotId).toBe(confirmed[0]!.snapshotId);
    expect(links.at(-1)?.workflowId).toBe('wf_lost_run');
    expect(links.at(-1)?.snapshot?.snapshotId).toBe(confirmed[0]!.snapshotId);
    expect(screen.queryByTestId('dc-kind-unconfirmed')).not.toBeInTheDocument();
  });

  it('Find my run links nothing when the new workflows are not exactly one price-compatible match', async () => {
    const user = userEvent.setup();
    const links: TrainRunLink[] = [];
    const old = { workflowId: 'wf_old', status: 'succeeded' as const, images: [], cost: 725, createdAt: '2026-10-20T10:00:00.000Z' };
    const handle = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      trainingQuoteTotal: 725,
      runTrainingError: 'submission-unconfirmed',
      appWorkflows: { workflows: [old] },
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
      cannedTrainingDataUpload: [trainingUpload(1), trainingUpload(2)],
    });
    uninstall = handle;
    await renderTrainFlow({ initialItems: communityItems, onRunLinked: (l) => void links.push(l) });
    await uploadAndPrice(user);
    await user.click(await screen.findByTestId('dc-kind-run'));
    await screen.findByTestId('dc-kind-unconfirmed');

    // Nothing new: the submission most likely never started.
    await user.click(screen.getByTestId('dc-kind-find-run'));
    expect(await screen.findByTestId('dc-kind-find-result')).toHaveTextContent(/no new run/i);

    // Two new candidates: refuse to guess.
    handle.setScenario({
      appWorkflows: {
        workflows: [
          { workflowId: 'wf_new_a', status: 'processing', images: [], cost: 700, createdAt: '2026-10-20T10:06:00.000Z' },
          { workflowId: 'wf_new_b', status: 'processing', images: [], cost: null, createdAt: '2026-10-20T10:05:00.000Z' },
          old,
        ],
      },
    });
    await user.click(screen.getByTestId('dc-kind-find-run'));
    await waitFor(() => expect(screen.getByTestId('dc-kind-find-result')).toHaveTextContent(/2 new runs/i));

    // One new workflow, but priced ABOVE the quote: not this run.
    handle.setScenario({
      appWorkflows: {
        workflows: [
          { workflowId: 'wf_pricier', status: 'processing', images: [], cost: 900, createdAt: '2026-10-20T10:06:00.000Z' },
          old,
        ],
      },
    });
    await user.click(screen.getByTestId('dc-kind-find-run'));
    await waitFor(() => expect(screen.getByTestId('dc-kind-find-result')).toHaveTextContent(/no new run/i));

    expect(links).toHaveLength(0);
    expect(screen.getByTestId('dc-kind-unconfirmed')).toBeInTheDocument();
    expect(screen.getByTestId('dc-estimate')).toBeDisabled();
  });

  it('a cap-refused run is explicit that nothing was charged', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      trainingQuoteTotal: 725,
      runTrainingCapRefusal: 'daily Buzz cap reached for this viewer',
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
      cannedTrainingDataUpload: [trainingUpload(1), trainingUpload(2)],
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
    expect(screen.getByTestId('dc-train-blocked')).toHaveTextContent(/at most 50/);
    expect(screen.queryByTestId('dc-train-upload')).not.toBeInTheDocument();
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
    expect(screen.getByTestId('dc-train-upload')).toBeEnabled();
  });

  // --- Trainer attestation (kind: 'training' only): the app sees `{ air }` keys
  // and cannot prove the uploads are the snapshot's images. ---

  it('the attestation is unchecked by default and gates pricing — no estimate is sent without it', async () => {
    const user = userEvent.setup();
    const outbound: Outbound[] = [];
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      trainingQuoteTotal: 725,
      cannedTrainingDataUpload: [trainingUpload(1), trainingUpload(2)],
      onOutbound: (message) => outbound.push(message as Outbound),
    });
    await renderTrainFlow({ initialItems: communityItems });
    await user.click(screen.getByTestId('dc-train-upload'));
    await screen.findByTestId('dc-train-pairs');

    const attest = screen.getByTestId('dc-train-attest');
    expect(attest).not.toBeChecked();
    expect(screen.queryByTestId('dc-train-problems')).not.toBeInTheDocument(); // the pairing itself is fine
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
      cannedTrainingDataUpload: [trainingUpload(1), trainingUpload(2)],
    });
    await renderTrainFlow({ initialItems: communityItems });
    await user.click(screen.getByTestId('dc-train-upload'));
    await screen.findByTestId('dc-train-pairs');

    await user.click(screen.getByTestId('dc-train-attest'));
    expect(screen.getByTestId('dc-train-attest')).toBeChecked();
    await user.selectOptions(screen.getByTestId('dc-train-match-0'), 'b');
    expect(screen.getByTestId('dc-train-attest')).not.toBeChecked();

    await user.selectOptions(screen.getByTestId('dc-train-match-0'), 'a');
    await user.click(screen.getByTestId('dc-train-attest'));
    expect(screen.getByTestId('dc-train-attest')).toBeChecked();
    expect(screen.getByTestId('dc-kind-estimate')).toBeEnabled();
    await user.click(screen.getByTestId('dc-train-upload')); // "Upload again"
    await waitFor(() => expect(screen.getByTestId('dc-train-attest')).not.toBeChecked());
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
      cannedTrainingDataUpload: [trainingUpload(1), trainingUpload(2)],
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

  it('a pass-through run on a real app dataset (stored image urls, not blobs) trains on the uploads and is recorded trainer-attested', async () => {
    const user = userEvent.setup();
    const ledgerEvents: LedgerEvent[] = [];
    const links: TrainRunLink[] = [];
    const submitted: Array<Record<string, unknown>> = [];
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      cost: 512,
      buzzBudget: PAGE_BUZZ_BUDGET,
      pollsUntilDone: 1,
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
      generation: { trainedEpochs: 10 },
      cannedTrainingDataUpload: [trainingUpload(1), trainingUpload(2)],
      onOutbound: (m) => {
        if (m.type === 'SUBMIT_WORKFLOW') submitted.push((m.payload as { body: Record<string, unknown> }).body);
      },
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
    await uploadAndAttest(user);
    expect(screen.getByTestId('dc-estimate')).toBeEnabled();
    await user.click(screen.getByTestId('dc-estimate'));
    await user.click(await screen.findByTestId('dc-confirm-submit'));
    await screen.findByTestId('dc-publish', {}, { timeout: 5000 });

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      kind: 'step',
      $type: 'training',
      input: {
        trainingData: {
          type: 'blobs',
          items: [
            { air: 'up1.png', caption: 'front' },
            { air: 'up2.png', caption: 'profile' },
          ],
        },
      },
    });
    await waitFor(() => expect(ledgerEvents).toHaveLength(1));
    expect(ledgerEvents[0]).toMatchObject({ eventType: 'training', grossBuzz: 512, dataSource: 'trainer-attested' });
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((l) => l.dataSource === 'trainer-attested')).toBe(true);
    expect(screen.getByTestId('dc-ledger-source')).toHaveTextContent('Trainer-attested uploads');
  });

  it('the pass-through price button waits for the upload and the attestation — no estimate is sent before', async () => {
    const user = userEvent.setup();
    const outbound: Outbound[] = [];
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      cost: 512,
      buzzBudget: PAGE_BUZZ_BUDGET,
      cannedTrainingDataUpload: [trainingUpload(1), trainingUpload(2)],
      onOutbound: (message) => outbound.push(message as Outbound),
    });
    await renderTrainFlow({ initialItems: communityItems });
    const estimates = () => outbound.filter((m) => m.type === 'ESTIMATE_WORKFLOW');

    expect(screen.getByTestId('dc-estimate')).toBeDisabled();
    expect(screen.getByTestId('dc-train-disabled-reason')).toHaveTextContent(/Upload the training set's images above first/);
    await user.click(screen.getByTestId('dc-train-upload'));
    await screen.findByTestId('dc-train-pairs');
    expect(screen.getByTestId('dc-estimate')).toBeDisabled();
    expect(screen.getByTestId('dc-train-disabled-reason')).toHaveTextContent(/Confirm above that the uploads/);
    await user.click(screen.getByTestId('dc-estimate'));
    expect(estimates()).toHaveLength(0);

    await user.click(screen.getByTestId('dc-train-attest'));
    expect(screen.getByTestId('dc-estimate')).toBeEnabled();
    await user.click(screen.getByTestId('dc-estimate'));
    expect(await screen.findByTestId('dc-quote')).toHaveTextContent('512');
    expect(estimates()).toHaveLength(1);
  });

  it('changing which items are in the training set clears the attestation', async () => {
    // [INVARIANT GUARD] — the includedKey reset already existed before this change;
    // this pins it now that both paths depend on the one attestation.
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      cannedTrainingDataUpload: [trainingUpload(1), trainingUpload(2)],
    });
    await renderTrainFlow({ initialItems: [...communityItems, { ...communityItems[0]!, itemId: 'c', caption: 'back', netVotes: 2 }] });
    await user.click(screen.getByTestId('dc-train-upload'));
    await screen.findByTestId('dc-train-pairs');
    await user.click(screen.getByTestId('dc-train-attest'));
    expect(screen.getByTestId('dc-train-attest')).toBeChecked();

    // Excluding one item changes the included set (3 -> 2); the uploads and matches stay as they were.
    await user.click(screen.getByTestId('dc-exclude-c'));
    await waitFor(() => expect(screen.getByTestId('dc-train-attest')).not.toBeChecked());
    expect(screen.getByTestId('dc-estimate')).toBeDisabled();
    expect(screen.getByTestId('dc-kind-estimate')).toBeDisabled();
  });

  // --- A run's ledger and LoRA records use the snapshot THAT run was submitted
  // with, never whatever the form is pricing now. ---

  async function passThroughRunInModeration(
    user: ReturnType<typeof userEvent.setup>,
    extra: Partial<TrainFlowProps> = {},
  ) {
    const ledgerEvents: LedgerEvent[] = [];
    const links: TrainRunLink[] = [];
    const confirmed: string[] = [];
    const host = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      cost: 512,
      buzzBudget: PAGE_BUZZ_BUDGET,
      trainingQuoteTotal: 725,
      pollsUntilDone: 1,
      buzzBalance: { blue: 5000, green: 0, yellow: 5000 },
      generation: { trainedEpochs: 0 },
      cannedTrainingDataUpload: [trainingUpload(1), trainingUpload(2)],
    });
    uninstall = host;
    await renderTrainFlow({
      initialItems: communityItems,
      onSnapshotConfirmed: (snapshot) => {
        confirmed.push(snapshot.snapshotId);
      },
      onLedgerEvent: (event) => {
        ledgerEvents.push(event);
      },
      onRunLinked: (link) => {
        links.push(link);
      },
      ...extra,
    });
    await uploadAndAttest(user);
    await user.click(screen.getByTestId('dc-estimate'));
    await user.click(await screen.findByTestId('dc-confirm-submit'));
    await screen.findByTestId('dc-moderation', {}, { timeout: 5000 });
    expect(confirmed).toHaveLength(1);
    return { host, ledgerEvents, links, runSnapshotId: confirmed[0]! };
  }

  it("Check again after pricing a Civitai-trainer run still credits the first run's own snapshot", async () => {
    const user = userEvent.setup();
    const { host, ledgerEvents, links, runSnapshotId } = await passThroughRunInModeration(user);

    // Price a Civitai-trainer run on the same uploads: a NEW, unpersisted snapshot.
    await user.click(screen.getByTestId('dc-kind-estimate'));
    expect(await screen.findByTestId('dc-kind-quote')).toHaveTextContent('725');

    // Moderation releases the first run's epochs; the trainer checks again.
    host.setScenario({ generation: { trainedEpochs: 10 } });
    await user.click(screen.getByTestId('dc-check-again'));
    await screen.findByTestId('dc-publish', {}, { timeout: 5000 });

    await waitFor(() => expect(ledgerEvents).toHaveLength(1));
    expect(ledgerEvents[0]!.snapshotId).toBe(runSnapshotId);
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((l) => l.snapshot?.snapshotId === runSnapshotId)).toBe(true);
    // 512 split 3:1 by the first run's frozen votes -> alice 384, bob 128.
    expect(screen.getByTestId('dc-credit-alice')).toHaveTextContent('384');
    expect(screen.getByTestId('dc-credit-bob')).toHaveTextContent('128');
  });

  it('Check again after a config edit still records the run against its own snapshot', async () => {
    const user = userEvent.setup();
    const { host, ledgerEvents, runSnapshotId } = await passThroughRunInModeration(user);

    // A standing Civitai-trainer quote, then an edit that invalidates it: clearing
    // a quote must not clear (or redirect) the started run's snapshot.
    await user.click(screen.getByTestId('dc-kind-estimate'));
    await screen.findByTestId('dc-kind-quote');
    await user.clear(screen.getByTestId('dc-trigger'));
    await user.type(screen.getByTestId('dc-trigger'), 'othertok');

    host.setScenario({ generation: { trainedEpochs: 10 } });
    await user.click(screen.getByTestId('dc-check-again'));
    await screen.findByTestId('dc-publish', {}, { timeout: 5000 });

    await waitFor(() => expect(ledgerEvents).toHaveLength(1));
    expect(ledgerEvents[0]!.snapshotId).toBe(runSnapshotId);
    expect(screen.getByTestId('dc-ledger')).toBeInTheDocument();
  });

  it("steps and epochs are bounded like Training Studio's (1–10000 steps, 1–20 epochs)", async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
    });
    await renderTrainFlow({ initialItems: communityItems });
    const stepsInput = screen.getByTestId('dc-steps');
    const epochsInput = screen.getByTestId('dc-epochs');
    expect(stepsInput).toHaveAttribute('min', '1');
    expect(stepsInput).toHaveAttribute('max', '10000');
    expect(epochsInput).toHaveAttribute('min', '1');
    expect(epochsInput).toHaveAttribute('max', '20');

    await user.clear(stepsInput);
    await user.type(stepsInput, '25000');
    await user.clear(epochsInput); // blurs steps
    await user.type(epochsInput, '37');
    await user.click(screen.getByTestId('dc-trigger')); // blurs epochs
    expect(stepsInput).toHaveValue(10000);
    expect(epochsInput).toHaveValue(20);
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
  // --- 0.3.1: a host/token error while following a run is never the run failing.
  // Live 2026-10-21: a pass-through run followed from a background tab outlived
  // the page's 15-minute block token; the host answered the next poll with its
  // failure-shape reply `{ workflowId: 'failed', status: 'failed', error: 'invalid
  // block token' }` and the app showed the run as FAILED and stopped tracking it.

  const TOKEN_ERROR = 'invalid block token';

  function trackingHost(
    extra: Parameters<typeof installMockMoneyHost>[0] = {},
  ) {
    const polls: string[] = [];
    const ledgerEvents: LedgerEvent[] = [];
    const links: TrainRunLink[] = [];
    const host = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      cost: 512,
      buzzBudget: PAGE_BUZZ_BUDGET,
      trainingQuoteTotal: 725,
      // Still training until the test releases it.
      pollsUntilDone: 1000,
      buzzBalance: { blue: 5000, green: 0, yellow: 5000 },
      generation: { trainedEpochs: 10 },
      cannedTrainingDataUpload: [trainingUpload(1), trainingUpload(2)],
      onOutbound: (m) => {
        if (m.type === 'POLL_WORKFLOW') polls.push((m.payload as { workflowId: string }).workflowId);
      },
      ...extra,
    });
    uninstall = host;
    const props: Partial<TrainFlowProps> = {
      initialItems: communityItems,
      onLedgerEvent: (event) => {
        ledgerEvents.push(event);
      },
      onRunLinked: (link) => {
        links.push(link);
      },
    };
    return { host, polls, ledgerEvents, links, props };
  }

  /** The token lapses mid-run; resolves once the app has re-polled after the error (≥ `n` error polls). */
  async function tokenLapsesMidRun(
    host: ReturnType<typeof installMockMoneyHost>,
    polls: string[],
    n = 2,
  ) {
    await waitFor(() => expect(polls.length).toBeGreaterThan(0), { timeout: 5000 });
    expect(screen.getByTestId('dc-run-state')).toHaveTextContent(/training/i);
    host.setHostPollError(TOKEN_ERROR);
    const before = polls.length;
    await waitFor(() => expect(polls.length - before).toBeGreaterThanOrEqual(n), { timeout: 10000 });
  }

  it('pass-through: a token error mid-run keeps the run tracked, then records its ledger and LoRA when it succeeds', async () => {
    const user = userEvent.setup();
    const { host, polls, ledgerEvents, links, props } = trackingHost();
    await renderTrainFlow(props);
    await uploadAndAttest(user);
    await user.click(screen.getByTestId('dc-estimate'));
    await user.click(await screen.findByTestId('dc-confirm-submit'));

    await tokenLapsesMidRun(host, polls);
    // Not a failed run: still training, with a non-terminal notice.
    expect(screen.queryByTestId('dc-run-failed')).not.toBeInTheDocument();
    expect(screen.getByTestId('dc-run-state')).toHaveTextContent(/training/i);
    expect(screen.getByTestId('dc-lost-contact')).toHaveTextContent('Lost contact with Civitai — still checking…');
    expect(screen.getByTestId('dc-lost-contact-detail')).toHaveTextContent(TOKEN_ERROR);
    expect(screen.getByTestId('dc-check-again')).toBeInTheDocument();

    // The host can answer again and the run has finished.
    host.setScenario({ pollsUntilDone: 1 });
    host.setHostPollError(null);
    await screen.findByTestId('dc-publish', {}, { timeout: 10000 });
    await waitFor(() => expect(ledgerEvents).toHaveLength(1));
    expect(ledgerEvents[0]).toMatchObject({ eventType: 'training', grossBuzz: 512 });
    expect(ledgerEvents[0]!.sourceRef).toBe(polls[0]);
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((l) => l.workflowId === polls[0])).toBe(true);
    expect(screen.queryByTestId('dc-lost-contact')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dc-run-failed')).not.toBeInTheDocument();
    expect(screen.getByTestId('dc-ledger')).toBeInTheDocument();
  }, 30000);

  it("Civitai's trainer: a token error mid-watch keeps the run tracked, then records its ledger and LoRA when it succeeds", async () => {
    const user = userEvent.setup();
    const { host, polls, ledgerEvents, links, props } = trackingHost();
    await renderTrainFlow(props);
    await uploadAndPrice(user);
    await user.click(await screen.findByTestId('dc-kind-run'));

    await tokenLapsesMidRun(host, polls);
    expect(screen.queryByTestId('dc-run-failed')).not.toBeInTheDocument();
    expect(screen.getByTestId('dc-run-state')).toHaveTextContent(/training/i);
    expect(screen.getByTestId('dc-lost-contact')).toHaveTextContent('still checking…');

    host.setScenario({ pollsUntilDone: 1 });
    host.setHostPollError(null);
    await screen.findByTestId('dc-publish', {}, { timeout: 10000 });
    await waitFor(() => expect(ledgerEvents).toHaveLength(1));
    expect(ledgerEvents[0]).toMatchObject({ eventType: 'training', grossBuzz: 725 });
    expect(ledgerEvents[0]!.sourceRef).toBe(polls[0]);
    expect(links.length).toBeGreaterThan(0);
    expect(screen.queryByTestId('dc-lost-contact')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dc-run-failed')).not.toBeInTheDocument();
  }, 30000);

  it('a manual Check again that meets the token error leaves the run as it was', async () => {
    const user = userEvent.setup();
    const { host, polls, ledgerEvents, props } = trackingHost({ pollsUntilDone: 1, generation: { trainedEpochs: 0 } });
    await renderTrainFlow(props);
    await uploadAndAttest(user);
    await user.click(screen.getByTestId('dc-estimate'));
    await user.click(await screen.findByTestId('dc-confirm-submit'));
    await screen.findByTestId('dc-moderation', {}, { timeout: 5000 });

    host.setHostPollError(TOKEN_ERROR);
    const before = polls.length;
    await user.click(screen.getByTestId('dc-check-again'));
    await waitFor(() => expect(polls.length).toBe(before + 1));
    // Whichever the reply produced, it must not be a failed run.
    await waitFor(() =>
      expect(screen.queryByTestId('dc-lost-contact') ?? screen.queryByTestId('dc-run-failed')).not.toBeNull(),
    );
    expect(screen.queryByTestId('dc-run-failed')).not.toBeInTheDocument();
    expect(screen.getByTestId('dc-lost-contact')).toHaveTextContent("couldn't be checked just now");
    expect(screen.getByTestId('dc-moderation')).toBeInTheDocument();

    host.setHostPollError(null);
    host.setScenario({ generation: { trainedEpochs: 10 } });
    await user.click(screen.getByTestId('dc-check-again'));
    await screen.findByTestId('dc-publish', {}, { timeout: 5000 });
    await waitFor(() => expect(ledgerEvents).toHaveLength(1));
    expect(screen.queryByTestId('dc-lost-contact')).not.toBeInTheDocument();
  });

  // --- Fake-timer tests: real time still flows (`shouldAdvanceTime`), so the SDK
  // transport and testing-library behave as usual, and `advance` jumps the clock
  // (Date included) to cover minutes of backoff in milliseconds.

  function useFakeClock() {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  }

  const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

  async function startPassThroughRun(
    user: ReturnType<typeof userEvent.setup>,
    extra: Parameters<typeof installMockMoneyHost>[0] = {},
  ) {
    const t = trackingHost(extra);
    await renderTrainFlow(t.props);
    await uploadAndAttest(user);
    await user.click(screen.getByTestId('dc-estimate'));
    await user.click(await screen.findByTestId('dc-confirm-submit'));
    await waitFor(() => expect(t.polls.length).toBeGreaterThan(0), { timeout: 5000 });
    return t;
  }

  async function startKindRun(
    user: ReturnType<typeof userEvent.setup>,
    extra: Parameters<typeof installMockMoneyHost>[0] = {},
  ) {
    const t = trackingHost(extra);
    await renderTrainFlow(t.props);
    await uploadAndPrice(user);
    await user.click(await screen.findByTestId('dc-kind-run'));
    await waitFor(() => expect(t.polls.length).toBeGreaterThan(0), { timeout: 5000 });
    return t;
  }

  const STOPPED = /stopped checking this run on its own/;

  it('coming back into view while the token is still stale recovers within seconds, not after the 60s backoff', async () => {
    const user = useFakeClock();
    const { host, polls } = await startPassThroughRun(user);

    // Two minutes unanswered: the backoff is at its 60s cap.
    host.setHostPollError(TOKEN_ERROR);
    await advance(125_000);
    expect(screen.getByTestId('dc-lost-contact')).toHaveTextContent('still checking…');

    // Back in view — the host has NOT re-minted yet, so the immediate poll fails.
    const before = polls.length;
    document.dispatchEvent(new Event('visibilitychange'));
    await advance(200);
    expect(polls.length).toBe(before + 1);

    // The fresh token lands shortly after; the run has finished meanwhile.
    host.setScenario({ pollsUntilDone: 1 });
    host.setHostPollError(null);
    await advance(3000);
    expect(screen.getByTestId('dc-publish')).toBeInTheDocument();
    expect(screen.queryByTestId('dc-lost-contact')).not.toBeInTheDocument();
  }, 30000);

  it('[INVARIANT GUARD] lost contact for under 5 minutes keeps checking and keeps pricing locked', async () => {
    const user = useFakeClock();
    const { host, polls } = await startPassThroughRun(user);
    host.setHostPollError(TOKEN_ERROR);
    await advance(4 * 60_000);
    const at4 = polls.length;
    await advance(60_000 + 500); // 4.5 → 5.0 min: still inside the window, one more 60s re-poll
    expect(polls.length).toBeGreaterThan(at4);
    expect(screen.getByTestId('dc-lost-contact')).toHaveTextContent('still checking…');
    expect(screen.getByTestId('dc-lost-contact')).not.toHaveTextContent(STOPPED);
    expect(screen.getByTestId('dc-estimate')).toBeDisabled();
  }, 30000);

  it('pass-through: after 5 minutes without an answer it stops checking, unlocks pricing, and Check again resumes the run', async () => {
    const user = useFakeClock();
    const { host, polls, ledgerEvents } = await startPassThroughRun(user);
    host.setHostPollError(TOKEN_ERROR);
    await advance(6 * 60_000);

    expect(screen.getByTestId('dc-lost-contact')).toHaveTextContent(STOPPED);
    expect(screen.getByTestId('dc-lost-contact-detail')).toHaveTextContent(TOKEN_ERROR);
    expect(screen.getByTestId('dc-estimate')).toBeEnabled();
    expect(screen.getByTestId('dc-check-again')).toBeInTheDocument();
    expect(screen.queryByTestId('dc-run-failed')).not.toBeInTheDocument();
    // Stopped means stopped: no re-poll in the next 3 minutes.
    const settled = polls.length;
    await advance(3 * 60_000);
    expect(polls.length).toBe(settled);

    // The run is still tracked: Check again picks it back up.
    host.setScenario({ pollsUntilDone: 1 });
    host.setHostPollError(null);
    await user.click(screen.getByTestId('dc-check-again'));
    await advance(2000);
    expect(screen.getByTestId('dc-publish')).toBeInTheDocument();
    await waitFor(() => expect(ledgerEvents).toHaveLength(1));
    expect(ledgerEvents[0]!.sourceRef).toBe(polls[0]);
    expect(screen.queryByTestId('dc-lost-contact')).not.toBeInTheDocument();
  }, 30000);

  it("Civitai's trainer: after 5 minutes without an answer it stops checking, unlocks pricing, and Check again resumes the run", async () => {
    const user = useFakeClock();
    const { host, polls, ledgerEvents } = await startKindRun(user);
    host.setHostPollError(TOKEN_ERROR);
    await advance(6 * 60_000);

    expect(screen.getByTestId('dc-lost-contact')).toHaveTextContent(STOPPED);
    expect(screen.getByTestId('dc-lost-contact-detail')).toHaveTextContent(TOKEN_ERROR);
    expect(screen.getByTestId('dc-kind-estimate')).toBeEnabled();
    expect(screen.getByTestId('dc-check-again')).toBeInTheDocument();
    const settled = polls.length;
    await advance(3 * 60_000);
    expect(polls.length).toBe(settled);

    host.setScenario({ pollsUntilDone: 1 });
    host.setHostPollError(null);
    await user.click(screen.getByTestId('dc-check-again'));
    await advance(5000);
    expect(screen.getByTestId('dc-publish')).toBeInTheDocument();
    await waitFor(() => expect(ledgerEvents).toHaveLength(1));
    expect(ledgerEvents[0]).toMatchObject({ eventType: 'training', grossBuzz: 725 });
  }, 30000);

  it('[INVARIANT GUARD] an answer inside the 5 minutes starts a new streak, so it does not stop at 5 minutes from the first failure', async () => {
    const user = useFakeClock();
    const { host, polls } = await startPassThroughRun(user);
    host.setHostPollError(TOKEN_ERROR);
    await advance(4 * 60_000);
    // The host answers once (the next re-poll is at most 60s away).
    host.setHostPollError(null);
    await advance(65_000);
    expect(screen.queryByTestId('dc-lost-contact')).not.toBeInTheDocument();
    // Then stops again — 9+ minutes after the FIRST streak began, 4 into this one.
    host.setHostPollError(TOKEN_ERROR);
    await advance(4 * 60_000);
    const at4 = polls.length;
    await advance(60_000 + 500);
    expect(polls.length).toBeGreaterThan(at4);
    expect(screen.getByTestId('dc-lost-contact')).not.toHaveTextContent(STOPPED);
    expect(screen.getByTestId('dc-estimate')).toBeDisabled();
  }, 30000);

  it("Civitai's trainer: a real answer resets the backoff, so the next lost contact re-polls after 1s, not 60s", async () => {
    const user = useFakeClock();
    const { host, polls } = await startKindRun(user);
    host.setHostPollError(TOKEN_ERROR);
    await advance(125_000); // backoff at its 60s cap
    host.setHostPollError(null);
    await advance(65_000); // the capped re-poll lands and the watch gets real snapshots
    expect(screen.queryByTestId('dc-lost-contact')).not.toBeInTheDocument();
    expect(screen.getByTestId('dc-run-state')).toHaveTextContent(/training/i);

    host.setHostPollError(TOKEN_ERROR);
    await waitFor(() => expect(screen.getByTestId('dc-lost-contact')).toBeInTheDocument(), { timeout: 10000 });
    const atFailure = polls.length;
    await advance(3500); // fresh streak: re-polls at +1s and +3s
    expect(polls.length - atFailure).toBeGreaterThanOrEqual(2);
  }, 30000);

  it('a Check again still in flight when Train unmounts starts no tracking afterwards', async () => {
    const user = userEvent.setup();
    let unmountOnPoll = false;
    let unmount: () => void = () => {};
    const polled: string[] = [];
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      cost: 512,
      buzzBudget: PAGE_BUZZ_BUDGET,
      pollsUntilDone: 1000,
      buzzBalance: { blue: 5000, green: 0, yellow: 5000 },
      cannedTrainingDataUpload: [trainingUpload(1), trainingUpload(2)],
      onOutbound: (m) => {
        if (m.type !== 'POLL_WORKFLOW') return;
        polled.push((m.payload as { workflowId: string }).workflowId);
        // Unmount while this Check again poll is in flight (before its reply).
        if (unmountOnPoll) {
          unmountOnPoll = false;
          unmount();
        }
      },
    });
    const view = render(
      <TrainFlow initialItems={communityItems} datasetId="ds-own" trainerId="dev" allowLocalUploads={false} />,
    );
    unmount = view.unmount;
    await screen.findByTestId('dc-train');
    await uploadAndAttest(user);
    await user.click(screen.getByTestId('dc-estimate'));
    await user.click(await screen.findByTestId('dc-confirm-submit'));
    await waitFor(() => expect(polled.length).toBeGreaterThan(0), { timeout: 5000 });

    unmountOnPoll = true;
    await user.click(screen.getByTestId('dc-check-again'));
    expect(unmountOnPoll).toBe(false);
    const atUnmount = polled.length;
    await new Promise((r) => setTimeout(r, 4000));
    expect(polled.length).toBe(atUnmount);
  }, 15000);

  it("a cap-refused pass-through submit keeps its refusal and price, polls nothing and offers no Check again", async () => {
    const user = userEvent.setup();
    const CAP = 'daily Buzz cap reached for this viewer';
    const { host, polls, props } = trackingHost({ generation: { trainedEpochs: 10, submitCapRefusal: CAP } });
    await renderTrainFlow(props);
    await uploadAndAttest(user);
    await user.click(screen.getByTestId('dc-estimate'));
    await user.click(await screen.findByTestId('dc-confirm-submit'));

    expect(await screen.findByTestId('dc-run-failed')).toHaveTextContent(CAP);
    expect(screen.getByTestId('dc-run-cost')).toHaveTextContent('512');
    // A refusal is not a run: nothing to check again, and 'failed' is never polled.
    expect(screen.queryByTestId('dc-check-again')).not.toBeInTheDocument();
    host.setHostPollError(TOKEN_ERROR);
    await new Promise((r) => setTimeout(r, 1500));
    expect(polls).toEqual([]);
    expect(screen.getByTestId('dc-run-failed')).toHaveTextContent(CAP);
    expect(screen.getByTestId('dc-run-failed')).not.toHaveTextContent(TOKEN_ERROR);
    expect(screen.getByTestId('dc-run-cost')).toHaveTextContent('512');
    expect(screen.queryByTestId('dc-lost-contact')).not.toBeInTheDocument();
    expect(screen.getByTestId('dc-estimate')).toBeEnabled();
  }, 15000);

  it("a run that really failed ends tracking, and Check again stays available", async () => {
    const user = userEvent.setup();
    const { polls, props } = trackingHost({
      pollsUntilDone: 1,
      generation: { trainedEpochs: 10, workflowOutcome: () => 'failed' },
    });
    await renderTrainFlow(props);
    await uploadAndAttest(user);
    await user.click(screen.getByTestId('dc-estimate'));
    await user.click(await screen.findByTestId('dc-confirm-submit'));

    expect(await screen.findByTestId('dc-run-failed', {}, { timeout: 5000 })).toHaveTextContent('mock: workflow failed');
    expect(screen.getByTestId('dc-run-state')).toHaveTextContent('failed');
    expect(screen.queryByTestId('dc-lost-contact')).not.toBeInTheDocument();
    expect(screen.getByTestId('dc-check-again')).toBeInTheDocument();
    // [INVARIANT GUARD] the run's own failed status still ends the loop.
    const settled = polls.length;
    await new Promise((r) => setTimeout(r, 3000));
    expect(polls.length).toBe(settled);
  }, 15000);

  // --- 0.3.1 audit round 2: only VISIBLE lost-contact time counts toward the
  // 5-minute give-up. The host pauses its block-token refresh while the tab is
  // hidden, so a hidden tab's polls all fail until it is shown again.

  it('pass-through: 20 minutes of failures in a hidden tab never give up, and coming back recovers on its own', async () => {
    const user = useFakeClock();
    const { host, polls, ledgerEvents } = await startPassThroughRun(user);
    switchTab(true);
    host.setHostPollError(TOKEN_ERROR);
    await advance(20 * 60_000);

    expect(screen.getByTestId('dc-lost-contact')).toHaveTextContent('still checking…');
    expect(screen.getByTestId('dc-lost-contact')).not.toHaveTextContent(STOPPED);
    expect(screen.getByTestId('dc-estimate')).toBeDisabled();
    expect(screen.queryByTestId('dc-run-failed')).not.toBeInTheDocument();

    // Back in view; the host re-mints about a second later and the run has finished.
    const before = polls.length;
    switchTab(false);
    await advance(200);
    expect(polls.length).toBe(before + 1); // the immediate poll (still the stale token)
    host.setScenario({ pollsUntilDone: 1 });
    host.setHostPollError(null);
    await advance(3000); // the 1.5s retry lands with the fresh token
    expect(screen.getByTestId('dc-publish')).toBeInTheDocument();
    await waitFor(() => expect(ledgerEvents).toHaveLength(1));
    expect(ledgerEvents[0]!.sourceRef).toBe(polls[0]);
    expect(screen.queryByTestId('dc-lost-contact')).not.toBeInTheDocument();
  }, 30000);

  it("Civitai's trainer: 20 minutes of failures in a hidden tab never give up, and coming back recovers on its own", async () => {
    const user = useFakeClock();
    const { host, ledgerEvents } = await startKindRun(user);
    switchTab(true);
    host.setHostPollError(TOKEN_ERROR);
    await advance(20 * 60_000);

    expect(screen.getByTestId('dc-lost-contact')).toHaveTextContent('still checking…');
    expect(screen.getByTestId('dc-lost-contact')).not.toHaveTextContent(STOPPED);
    expect(screen.getByTestId('dc-kind-estimate')).toBeDisabled();

    switchTab(false);
    await advance(200);
    host.setScenario({ pollsUntilDone: 1 });
    host.setHostPollError(null);
    await advance(5000);
    expect(screen.getByTestId('dc-publish')).toBeInTheDocument();
    await waitFor(() => expect(ledgerEvents).toHaveLength(1));
    expect(ledgerEvents[0]).toMatchObject({ eventType: 'training', grossBuzz: 725 });
  }, 30000);

  it('after a long hidden stretch, the give-up clock restarts on return: 5 VISIBLE minutes, not immediately', async () => {
    const user = useFakeClock();
    const { host, polls } = await startPassThroughRun(user);
    switchTab(true);
    host.setHostPollError(TOKEN_ERROR);
    await advance(20 * 60_000);

    // Back in view, but the host keeps refusing (a permanent refusal).
    const before = polls.length;
    switchTab(false);
    await advance(2000);
    // The immediate poll AND the 1.5s retry both ran — no instant give-up.
    expect(polls.length).toBeGreaterThanOrEqual(before + 2);
    expect(screen.getByTestId('dc-lost-contact')).not.toHaveTextContent(STOPPED);
    await advance(4 * 60_000 - 2000); // 4 visible minutes in
    expect(screen.getByTestId('dc-lost-contact')).not.toHaveTextContent(STOPPED);
    expect(screen.getByTestId('dc-estimate')).toBeDisabled();

    await advance(2 * 60_000); // past 5 visible minutes
    expect(screen.getByTestId('dc-lost-contact')).toHaveTextContent(STOPPED);
    expect(screen.getByTestId('dc-estimate')).toBeEnabled();
    expect(screen.getByTestId('dc-check-again')).toBeInTheDocument();
  }, 30000);

  it('a page that stopped checking resumes tracking once when the tab comes back into view', async () => {
    const user = useFakeClock();
    const { host, polls, ledgerEvents } = await startPassThroughRun(user);
    host.setHostPollError(TOKEN_ERROR);
    await advance(6 * 60_000); // visible the whole time: gives up
    expect(screen.getByTestId('dc-lost-contact')).toHaveTextContent(STOPPED);

    switchTab(true);
    await advance(60_000);
    const stopped = polls.length;
    // Back in view (twice in a row): exactly ONE tracker resumes — one immediate poll.
    switchTab(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await advance(200);
    expect(polls.length).toBe(stopped + 1);
    expect(screen.getByTestId('dc-lost-contact')).not.toHaveTextContent(STOPPED);
    expect(screen.getByTestId('dc-estimate')).toBeDisabled();

    // The fresh token lands; the resumed tracking finds the finished run.
    host.setScenario({ pollsUntilDone: 1 });
    host.setHostPollError(null);
    await advance(3000);
    expect(screen.getByTestId('dc-publish')).toBeInTheDocument();
    await waitFor(() => expect(ledgerEvents).toHaveLength(1));
    expect(ledgerEvents[0]!.sourceRef).toBe(polls[0]);
  }, 30000);

  // --- A submit accepted under a host sentinel id ('whatif'): a run may exist and
  // be charged, but nothing behind the sentinel can be followed.

  it("pass-through: a submit accepted as 'whatif' is unconfirmed — pricing locked on both paths, the snapshot named, nothing polled", async () => {
    const user = userEvent.setup();
    const confirmed: DatasetSnapshot[] = [];
    const { polls, props } = trackingHost({ acceptWithSentinelId: 'whatif' });
    await renderTrainFlow({ ...props, onSnapshotConfirmed: (s) => void confirmed.push(s) });
    await uploadAndAttest(user);
    await user.click(screen.getByTestId('dc-estimate'));
    await user.click(await screen.findByTestId('dc-confirm-submit'));

    const alert = await screen.findByTestId('dc-kind-unconfirmed');
    expect(alert).toHaveTextContent(/Buzz may have been spent/);
    expect(confirmed).toHaveLength(1);
    expect(screen.getByTestId('dc-kind-unconfirmed-snapshot')).toHaveTextContent(`Snapshot ${confirmed[0]!.snapshotId}`);
    expect(screen.queryByTestId('dc-check-again')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dc-run')).not.toBeInTheDocument();
    expect(screen.getByTestId('dc-estimate')).toBeDisabled();
    expect(screen.queryByTestId('dc-kind-estimate')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dc-train-upload')).not.toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 1500));
    expect(polls).toEqual([]);

    // Only the acknowledgement re-opens pricing.
    await user.click(screen.getByTestId('dc-kind-ack'));
    expect(screen.queryByTestId('dc-kind-unconfirmed')).not.toBeInTheDocument();
    expect(screen.getByTestId('dc-estimate')).toBeEnabled();
    expect(polls).toEqual([]);
  }, 15000);

  it("Civitai's trainer: a run accepted as 'whatif' is unconfirmed and never tracked", async () => {
    const user = userEvent.setup();
    const { polls, props } = trackingHost({ acceptWithSentinelId: 'whatif' });
    await renderTrainFlow(props);
    await uploadAndPrice(user);
    await user.click(await screen.findByTestId('dc-kind-run'));

    expect(await screen.findByTestId('dc-kind-unconfirmed')).toHaveTextContent(/Buzz may have been spent/);
    expect(screen.getByTestId('dc-kind-unconfirmed-snapshot')).toHaveTextContent(/Snapshot /);
    expect(screen.queryByTestId('dc-check-again')).not.toBeInTheDocument();
    expect(screen.getByTestId('dc-estimate')).toBeDisabled();
    expect(screen.queryByTestId('dc-kind-run')).not.toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 1500));
    expect(polls).toEqual([]);
  }, 15000);
});
