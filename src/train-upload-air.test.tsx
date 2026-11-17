import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BlockTrainingDataImage } from '@civitai/blocks-react';
import { afterEach, describe, expect, it } from 'vitest';

import { installMockMoneyHost } from './mock-buzz.js';
import { TrainFlow } from './TrainFlow.js';
import type { DatasetItem, DatasetSnapshot } from './training.js';

// AIR-only training uploads (SDK 0.90, civitai-app-starters#844):
// `useImageUpload({ purpose: 'trainingData' }).open()` resolves `[{ air }]` with
// no url. Driven against the REAL SDK transport + mock host, no hook mocking.

type Outbound = { type: string; payload?: unknown };

const items: DatasetItem[] = [
  {
    itemId: 'a',
    contributorId: 'alice',
    imageUrl: 'https://civitai.com/images/9101',
    imageId: 9101,
    caption: 'front',
    netVotes: 3,
  },
  {
    itemId: 'b',
    contributorId: 'bob',
    imageUrl: 'https://civitai.com/images/9102',
    imageId: 9102,
    caption: 'profile',
    netVotes: 1,
  },
];

/** What an older host replied before 0.90: `{ url, air }`. */
const LEGACY_URL_MARK = 'legacy-host.invalid';
const legacyUpload = (n: number) =>
  ({ url: `https://${LEGACY_URL_MARK}/blobs/k${n}.png`, air: `k${n}.png` }) as unknown as BlockTrainingDataImage;

const trainingBodies = (outbound: Outbound[], type: string) =>
  outbound
    .filter((m) => m.type === type && (m.payload as { body?: { kind?: string } }).body?.kind === 'training')
    .map((m) => (m.payload as { body: Record<string, unknown> }).body);

function renderTrainFlow(onSnapshotConfirmed?: (s: DatasetSnapshot) => void) {
  render(
    <TrainFlow
      initialItems={items}
      datasetId="ds-air"
      trainerId="dev"
      allowLocalUploads={false}
      onSnapshotConfirmed={onSnapshotConfirmed}
    />,
  );
  return screen.findByTestId('dc-train');
}

describe('training uploads are AIR-only', () => {
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it('each upload row shows a numbered placeholder and never an <img> (there is no url to show)', async () => {
    const user = userEvent.setup();
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      cannedTrainingDataUpload: [{ air: 'k1.png' }, { air: 'k2.png' }],
    });
    await renderTrainFlow();

    await user.click(screen.getByTestId('dc-train-upload'));
    const pairs = await screen.findByTestId('dc-train-pairs');

    expect(pairs.querySelectorAll('img')).toHaveLength(0);
    expect(within(pairs).getByTestId('dc-train-pair-thumb-0')).toHaveTextContent('#1');
    expect(within(pairs).getByTestId('dc-train-pair-thumb-1')).toHaveTextContent('#2');
    expect(within(pairs).getAllByTestId('dc-train-pair')).toHaveLength(2);
  });

  it("an older host's { url, air } reply: the air is trained on, the url is never shown or stored", async () => {
    const user = userEvent.setup();
    const outbound: Outbound[] = [];
    const confirmed: DatasetSnapshot[] = [];
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      trainingQuoteTotal: 725,
      pollsUntilDone: 1,
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
      generation: { trainedEpochs: 10 },
      cannedTrainingDataUpload: [legacyUpload(1), legacyUpload(2)],
      onOutbound: (message) => outbound.push(message as Outbound),
    });
    await renderTrainFlow((s) => {
      confirmed.push(s);
    });

    await user.click(screen.getByTestId('dc-train-upload'));
    const pairs = await screen.findByTestId('dc-train-pairs');
    expect(pairs.querySelectorAll('img')).toHaveLength(0);
    expect(within(pairs).getByTestId('dc-train-pair-thumb-0')).toHaveTextContent('#1');

    await user.click(screen.getByTestId('dc-train-attest'));
    await user.click(screen.getByTestId('dc-kind-estimate'));
    expect(await screen.findByTestId('dc-kind-quote')).toHaveTextContent('725');
    await user.click(screen.getByTestId('dc-kind-run'));
    await screen.findByTestId('dc-publish', {}, { timeout: 5000 });

    // Both the quote and the run carry the AIR keys with the frozen captions.
    const expectedItems = [
      { air: 'k1.png', caption: 'front' },
      { air: 'k2.png', caption: 'profile' },
    ];
    const [estimateBody] = trainingBodies(outbound, 'ESTIMATE_WORKFLOW');
    const [runBody] = trainingBodies(outbound, 'RUN_TRAINING');
    expect(estimateBody?.items).toEqual(expectedItems);
    expect(runBody?.items).toEqual(expectedItems);

    // The snapshot (a shared document) keeps the contributions' own image urls;
    // nothing from the training upload is written into it.
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]!.items.map((i) => i.imageUrl)).toEqual([
      'https://civitai.com/images/9101',
      'https://civitai.com/images/9102',
    ]);
    expect(JSON.stringify(confirmed[0])).not.toContain(LEGACY_URL_MARK);
    expect(JSON.stringify(outbound)).not.toContain(LEGACY_URL_MARK);
    expect(document.body.innerHTML).not.toContain(LEGACY_URL_MARK);
  });
});
