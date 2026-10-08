import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { TrainFlow } from './TrainFlow.js';
import { installMockMoneyHost } from './mock-buzz.js';

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
});
