import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

/** The attestation as the trainer reads it, whitespace-normalised. */
const ATTESTATION =
  "I uploaded the saved training-set files in their numbered order (#1 first), so each upload is the image matched to it above. This app can't see the uploaded files; the run and the contributors' credit are recorded as trainer-attested.";

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

    // With no preview, matching is by upload order — and the trainer attests the
    // one thing they can check: that they selected the files in that order.
    expect(screen.getByTestId('dc-train-order-hint')).toHaveTextContent(/same number/);
    const attest = screen.getByTestId('dc-train-attest').closest('label')!;
    expect(attest.textContent!.replace(/\s+/g, ' ').trim()).toBe(ATTESTATION);
  });

  it("an older host's IMAGE_UPLOAD_RESULT carrying { url, air } reaches the transport; the air is trained on and the url is never shown or stored", async () => {
    const user = userEvent.setup();
    const outbound: Outbound[] = [];
    const confirmed: DatasetSnapshot[] = [];
    const LEGACY_URL_MARK = 'legacy-host.invalid';
    const injected: unknown[] = [];
    uninstall = installMockMoneyHost({
      viewer: { id: 2, username: 'dev', status: 'active' },
      consentGranted: true,
      trainingQuoteTotal: 725,
      pollsUntilDone: 1,
      buzzBalance: { blue: 1000, green: 0, yellow: 1000 },
      generation: { trainedEpochs: 10 },
      // Only so the mock host REMEMBERS these keys for RUN_TRAINING's
      // not-uploaded-here check (it compares keys case-insensitively). Its own
      // reply strips any url, so it is NOT the reply the app consumes — see below.
      cannedTrainingDataUpload: [{ air: 'k1.png' }, { air: 'k2.png' }],
      onOutbound: (message) => {
        outbound.push(message as Outbound);
        const m = message as Outbound;
        const payload = m.payload as { requestId?: string; purpose?: string } | undefined;
        if (m.type !== 'OPEN_IMAGE_UPLOAD' || payload?.purpose !== 'trainingData') return;
        // Answer FIRST, synchronously, as an older host did: `{ url, air }` per
        // image, delivered through the real transport from the allowed origin.
        // The mock host's own (url-less) reply for the same requestId arrives
        // after and is ignored. The airs are UPPER-case so the bodies below prove
        // this reply — not the mock host's lower-case one — is what was consumed.
        const data = {
          type: 'IMAGE_UPLOAD_RESULT',
          payload: {
            requestId: payload.requestId,
            selected: {
              images: [
                { url: `https://${LEGACY_URL_MARK}/v2/consumer/blobs/K1.png`, air: 'K1.png' },
                { url: `https://${LEGACY_URL_MARK}/v2/consumer/blobs/K2.png`, air: 'K2.png' },
              ],
            },
          },
        };
        injected.push(data);
        window.dispatchEvent(new MessageEvent('message', { data, origin: window.location.origin, source: null }));
      },
    });
    await renderTrainFlow((s) => {
      confirmed.push(s);
    });

    await user.click(screen.getByTestId('dc-train-upload'));
    const pairs = await screen.findByTestId('dc-train-pairs');
    // Positive control: the url really was on the wire to the app.
    expect(injected).toHaveLength(1);
    expect(JSON.stringify(injected[0])).toContain(LEGACY_URL_MARK);

    expect(pairs.querySelectorAll('img')).toHaveLength(0);
    expect(within(pairs).getByTestId('dc-train-pair-thumb-0')).toHaveTextContent('#1');
    expect(document.body.innerHTML).not.toContain(LEGACY_URL_MARK);

    await user.click(screen.getByTestId('dc-train-attest'));
    await user.click(screen.getByTestId('dc-kind-estimate'));
    expect(await screen.findByTestId('dc-kind-quote')).toHaveTextContent('725');
    await user.click(screen.getByTestId('dc-kind-run'));
    await screen.findByTestId('dc-publish', {}, { timeout: 5000 });

    // Both the quote and the run carry the injected reply's AIR keys (upper-case)
    // with the frozen captions.
    const expectedItems = [
      { air: 'K1.png', caption: 'front' },
      { air: 'K2.png', caption: 'profile' },
    ];
    const [estimateBody] = trainingBodies(outbound, 'ESTIMATE_WORKFLOW');
    const [runBody] = trainingBodies(outbound, 'RUN_TRAINING');
    expect(estimateBody?.items).toEqual(expectedItems);
    expect(runBody?.items).toEqual(expectedItems);

    // The snapshot (a shared document) keeps the contributions' own image urls;
    // nothing from the training upload is written into it, nor sent anywhere.
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
