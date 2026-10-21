import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  useBlockContext,
  useBlockToken,
  useBuzzBalance,
  useBuzzWorkflow,
  useCivitaiNavigate,
  useImageUpload,
  useRequestConsent,
  useRequestSignIn,
  useRunTraining,
  useSaveImage,
  RunTrainingError,
} from '@civitai/blocks-react';
import { Alert, Badge, Button, Stack } from '@civitai/blocks-react/ui';
import type {
  BlockTrainingDataImage,
  BlockTrainingQuote,
  BlockWorkflowSnapshot,
  WorkflowBodyTraining,
} from '@civitai/app-sdk/blocks';

import { formatCost, hasBudgetedScope } from './generation.js';
import {
  DEFAULT_TRAINING_PRESET,
  TRAINING_EPOCHS_BOUNDS,
  TRAINING_PRESETS,
  TRAINING_STEPS_BOUNDS,
  buildPublishWizardPath,
  buildTrainingBody,
  buildTrainingKindBody,
  canAffordQuote,
  clampTrainingEpochs,
  clampTrainingSteps,
  classifyTrainingEstimate,
  classifyTrainingKindQuote,
  contributorShares,
  creditLedgerEvent,
  dataSourceLabel,
  describeEstimateFailure,
  deriveContributorCredits,
  freezeSnapshot,
  includedItems,
  latestEpoch,
  linkedLoraFromSnapshot,
  pairUploadsWithSnapshot,
  passThroughAvailable,
  trainingFailureCopy,
  trainingFeeEvent,
  trainingKindBlocker,
  trainingKindRunFailure,
  trainingStateForSnapshot,
  type DatasetItem,
  type DatasetSnapshot,
  type LedgerEvent,
  type TrainingDataSource,
  type TrainingPreset,
  type TrainingRunState,
} from './training.js';

/**
 * The Train flow (spec Screen 4) for Dataset Commons — Option A′.
 *
 * Snapshot review → upload + attest → estimate (quote gate) → confirm with the
 * real quote and a balance check → submit → poll → moderation/epochs → publish
 * wizard (site scope) → publishedModel linkage → trainer-fee ledger credit
 * (tracked, never paid out). Every rule that matters lives in training.ts; this
 * component only drives the hooks and renders state.
 *
 * Contributions are stored as display images, which no training step can read,
 * so the trainer uploads the snapshot's images ONCE through
 * `useImageUpload({ purpose: 'trainingData' })`; each upload is matched to a
 * snapshot item, carries its frozen caption, and the trainer attests the match.
 * That one upload feeds whichever path the preset uses: the pass-through
 * `training` step (SDXL, within the page's per-call budget, `submit`), or
 * Civitai's trainer (`kind: 'training'`, every preset, up to 5000 Buzz, where
 * `useRunTraining()` opens Civitai's own confirmation dialog).
 *
 * Without `initialItems` the dataset is a small MOCK dataset so the whole path
 * is exercisable in the mock harness with no real Buzz; there, "+ Add an
 * image" uploads one generation-source image per call.
 */

type TrainPhase =
  | 'idle'
  | 'needs-consent'
  | 'estimating'
  | 'quoted'
  | 'unquoted'
  | 'submitting'
  | 'running';

/** Civitai's trainer (`kind: 'training'`): price -> Civitai dialog. */
type KindPhase = 'idle' | 'pricing' | 'quoted' | 'running' | 'unconfirmed';

/**
 * A started run, together with the frozen snapshot it was submitted against.
 * The ledger event and LoRA link for a run are always recorded against THIS
 * snapshot — never against whatever the form is currently pricing.
 */
interface ActiveRun {
  workflowId: string;
  snapshot: DatasetSnapshot;
  path: 'pass-through' | 'civitai-trainer';
}

const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();

/**
 * The host's refusal (SDK 0.67+) when a pass-through `training` step is priced
 * above the per-call budget: it cannot run as a confirmed step and must use
 * `kind: 'training'`. Matched on the server's text (there is no errorCode).
 */
const OVER_BUDGET_TRAINING_STEP = /use kind:'training'/;

/**
 * Both run paths train on the trainer's own uploads, so every run this app
 * starts is trainer-attested (see TrainingDataSource). The one place it is named.
 */
const RUN_DATA_SOURCE: TrainingDataSource = 'trainer-attested';

/** A training run the Community shell should record against a real dataset. */
export interface TrainRunLink {
  workflowId: string;
  snapshot: DatasetSnapshot | null;
  /** Always 'trainer-attested' for runs started now; 'snapshot' exists only on legacy records. */
  dataSource: TrainingDataSource;
  publishedModel?: { modelId: number; modelVersionId: number; published: boolean };
  trainedEpochs?: readonly { epochNumber: number }[];
}

export interface TrainFlowProps {
  /** Live dataset items to review; defaults to the built-in mock dataset. */
  initialItems?: DatasetItem[];
  datasetId?: string;
  trainerId?: string;
  /** When false, items are the live dataset: captions/votes are read-only. */
  lockItemMetadata?: boolean;
  /** Hide the built-in light/dark toggle (the host view already renders one). */
  hideThemeToggle?: boolean;
  /** Owner overrides only make sense for the dataset owner. Default true (mock). */
  canOwnerOverride?: boolean;
  /** Local uploads extend the mock dataset only; live datasets contribute elsewhere. */
  allowLocalUploads?: boolean;
  /** Persist the frozen snapshot at confirm time, before any Buzz moves. */
  onSnapshotConfirmed?: (snapshot: DatasetSnapshot) => Promise<void> | void;
  /** Persist each trainer-fee ledger event exactly once per workflow. */
  onLedgerEvent?: (event: LedgerEvent, snapshot: DatasetSnapshot) => Promise<void> | void;
  /** Persist the LoRA record when epochs/publish linkage first appears. */
  onRunLinked?: (link: TrainRunLink) => Promise<void> | void;
}

const MOCK_ITEMS: DatasetItem[] = [
  {
    itemId: 'item-a',
    contributorId: 'alice',
    imageUrl: 'https://civitai.com/v2/consumer/blobs/archive-ink-a',
    caption: 'ink portrait, front view',
    netVotes: 5,
  },
  {
    itemId: 'item-b',
    contributorId: 'bob',
    imageUrl: 'https://civitai.com/v2/consumer/blobs/archive-ink-b',
    caption: 'ink portrait, profile view',
    netVotes: 1,
  },
  {
    itemId: 'item-c',
    contributorId: 'alice',
    imageUrl: 'https://civitai.com/v2/consumer/blobs/archive-ink-c',
    caption: 'ink portrait, back view',
    netVotes: 0,
  },
];

export function TrainFlow(props: TrainFlowProps = {}) {
  const { viewer } = useBlockContext();
  // Archive Lab: dark by default, light ONLY from this explicit in-app toggle.
  const [dcTheme, setDcTheme] = useState<'dark' | 'light'>('dark');
  const token = useBlockToken();
  const { estimate, submit, poll, watch } = useBuzzWorkflow();
  const { runTraining } = useRunTraining();
  const { open: openTrainingUpload } = useImageUpload({ purpose: 'trainingData' });
  const { saveImage } = useSaveImage();
  const { requestConsent } = useRequestConsent();
  const { requestSignIn } = useRequestSignIn();
  const { navigate } = useCivitaiNavigate();
  const { open: openUpload } = useImageUpload({ purpose: 'generationSource' });
  const { balance } = useBuzzBalance();

  const granted = hasBudgetedScope(token.scopes);
  const balanceTotal =
    balance == null ? null : (balance.blue ?? 0) + (balance.green ?? 0) + (balance.yellow ?? 0);

  const [items, setItems] = useState<DatasetItem[]>(props.initialItems ?? MOCK_ITEMS);
  const [manualExclusions, setManualExclusions] = useState<ReadonlySet<string>>(new Set());
  const [ownerOverrides, setOwnerOverrides] = useState<ReadonlySet<string>>(new Set());
  const [preset, setPreset] = useState<TrainingPreset>(DEFAULT_TRAINING_PRESET);
  const [triggerWord, setTriggerWord] = useState('archivetok');
  const [samplePrompt, setSamplePrompt] = useState('');
  const [steps, setSteps] = useState(2000);
  const [epochs, setEpochs] = useState(10);

  const [phase, setPhase] = useState<TrainPhase>('idle');
  const [quote, setQuote] = useState<number | null>(null);
  const [quoteClass, setQuoteClass] = useState<'unquoted' | 'missing' | null>(null);
  /** The actual estimate failure text (message + code) — shown, never swallowed (#541). */
  const [quoteError, setQuoteError] = useState<string | null>(null);
  /** The pass-through body the standing quote priced — submitted exactly as estimated. */
  const [passBody, setPassBody] = useState<ReturnType<typeof buildTrainingBody> | null>(null);
  /** The snapshot the standing pass-through quote was frozen for. */
  const [passSnapshot, setPassSnapshot] = useState<DatasetSnapshot | null>(null);

  /** The host's upload result — the ONLY blobs either run path trains on. */
  const [uploads, setUploads] = useState<BlockTrainingDataImage[] | null>(null);
  /** Snapshot item id per upload (upload order); defaults to the same position. */
  const [uploadAssignment, setUploadAssignment] = useState<string[]>([]);
  /**
   * The trainer's statement that the uploads ARE the snapshot's images, in the
   * matched order. The app cannot check it (it only sees `{ url, air }`), so it
   * is asked for explicitly, unchecked by default, and cleared by any new upload,
   * re-match or change in the training set. Neither path prices until it is given.
   */
  const [attested, setAttested] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [kindPhase, setKindPhase] = useState<KindPhase>('idle');
  const [kindQuote, setKindQuote] = useState<BlockTrainingQuote | null>(null);
  const [kindBody, setKindBody] = useState<WorkflowBodyTraining | null>(null);
  const [kindSnapshot, setKindSnapshot] = useState<DatasetSnapshot | null>(null);
  const [kindError, setKindError] = useState<string | null>(null);

  /** The run on screen and the snapshot it was submitted with (see ActiveRun). */
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const [runState, setRunState] = useState<TrainingRunState | null>(null);
  const [runCost, setRunCost] = useState<number | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [epoch, setEpoch] = useState<number | null>(null);
  const [published, setPublished] = useState<{ modelId: number; modelVersionId: number; published: boolean } | null>(null);
  const [ledger, setLedger] = useState<LedgerEvent[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const consentPendingRef = useRef(false);
  const pollCancelRef = useRef<{ cancelled: boolean } | null>(null);
  const pollRef = useRef(poll);
  pollRef.current = poll;
  const watchRef = useRef(watch);
  watchRef.current = watch;
  const kindPhaseRef = useRef<KindPhase>('idle');
  kindPhaseRef.current = kindPhase;
  const kindRequestRef = useRef(0);
  const kindConsentPendingRef = useRef(false);
  const kindWatchAbortRef = useRef<AbortController | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const persistedSnapshotRef = useRef<string | null>(null);
  const persistedLedgerRef = useRef<string | null>(null);
  const persistedRunLinkRef = useRef<string | null>(null);
  const datasetIdForTraining = props.datasetId ?? 'dataset-archive-ink';
  const effectiveOwnerOverrides = props.canOwnerOverride === false ? EMPTY_ID_SET : ownerOverrides;

  useEffect(() => {
    return () => {
      if (pollCancelRef.current) pollCancelRef.current.cancelled = true;
      kindWatchAbortRef.current?.abort();
    };
  }, []);

  // Any edit to the dataset, config or uploads invalidates a standing
  // pass-through quote — the price was quoted for THAT body, not for whatever
  // the form says now. A started run keeps its own snapshot (activeRun).
  useEffect(() => {
    if (phase === 'quoted' || phase === 'unquoted') {
      setPhase('idle');
      setQuote(null);
      setQuoteClass(null);
      setPassBody(null);
      setPassSnapshot(null);
    }
    // Only the inputs matter, not phase (phase is the thing being reset).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, manualExclusions, effectiveOwnerOverrides, preset, triggerWord, samplePrompt, steps, epochs, uploads, uploadAssignment]);

  // A Civitai-trainer quote is for one exact body (uploads + captions + config).
  // Any edit invalidates it; an in-flight estimate is token-guarded below. The
  // uploads themselves are kept — they stay valid for this page session.
  useEffect(() => {
    if (kindPhaseRef.current === 'pricing' || kindPhaseRef.current === 'quoted') {
      kindRequestRef.current += 1;
      setKindPhase('idle');
      setKindQuote(null);
      setKindBody(null);
      setKindSnapshot(null);
      setKindError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, manualExclusions, effectiveOwnerOverrides, preset, triggerWord, samplePrompt, steps, epochs, uploads, uploadAssignment]);

  const preview = useMemo(
    () =>
      freezeSnapshot(datasetIdForTraining, props.trainerId ?? viewer?.username ?? 'you', items, {
        manualExclusions,
        ownerOverrides: effectiveOwnerOverrides,
        snapshotId: 'preview',
      }),
    [items, manualExclusions, effectiveOwnerOverrides, viewer, datasetIdForTraining, props.trainerId],
  );
  const included = includedItems(preview);
  const includedKey = included.map((i) => i.itemId).join('\u0000');

  // The attestation names THESE uploads in THIS order against THIS training set:
  // a new upload, a re-match, or a change in which items are in voids it.
  useEffect(() => {
    setAttested(false);
  }, [uploads, uploadAssignment, includedKey]);
  const shares = useMemo(() => contributorShares(preview), [preview]);

  const uploadBlocker = trainingKindBlocker(included.length);
  const pairing = useMemo(
    () => (uploads ? pairUploadsWithSnapshot(uploads, included, uploadAssignment) : null),
    [uploads, included, uploadAssignment],
  );
  /** Uploads present, matched cleanly and attested — what BOTH paths need before pricing. */
  const uploadsReady = !!pairing && pairing.problems.length === 0 && attested;
  const busy =
    uploading ||
    phase === 'estimating' ||
    phase === 'submitting' ||
    phase === 'running' ||
    kindPhase === 'pricing' ||
    kindPhase === 'running';
  const afford = quote == null ? null : canAffordQuote(quote, balanceTotal);
  const kindAfford = kindQuote == null ? null : canAffordQuote(kindQuote.total, balanceTotal);
  const trainDisabledReason =
    included.length === 0
      ? 'No items are in the training set — an item needs net-positive votes (or an owner override) and must not be manually excluded.'
      : !passThroughAvailable(preset)
        ? `${preset.label} trains only on Civitai's trainer below — upload the training set above, then price it there.`
        : uploadBlocker
          ? uploadBlocker
          : !pairing
            ? "Upload the training set's images above first — this run trains on those uploads."
            : pairing.problems.length > 0
              ? 'Fix the uploads above before pricing.'
              : !attested
                ? "Confirm above that the uploads are the training set's images before pricing."
                : null;

  const applyTrainingSnapshot = useCallback(
    (snap: BlockWorkflowSnapshot, snapshot: DatasetSnapshot) => {
      setRunCost(snap.cost?.total ?? null);
      if (snap.error) setRunError(snap.error);
      const state = trainingStateForSnapshot(snap);
      setRunState(state);
      setEpoch(latestEpoch(snap));
      if (snap.publishedModel) {
        setPublished(snap.publishedModel);
        const linked = linkedLoraFromSnapshot(snap, snapshot.snapshotId);
        if (linked?.modelVersionId != null) {
          setNotice(
            linked.published
              ? `Published as model version ${linked.modelVersionId} — this snapshot is now linked to that LoRA.`
              : `Publish started — model version ${linked.modelVersionId} is still a draft in the wizard.`,
          );
        }
      }
      const hasEpochs = !!snap.trainedEpochs && snap.trainedEpochs.length > 0;
      const runLinkKey = `${snap.workflowId}:${snap.publishedModel?.modelVersionId ?? 'epochs'}:${snap.publishedModel?.published ? 'published' : 'draft'}`;
      if (
        (hasEpochs || snap.publishedModel) &&
        propsRef.current.onRunLinked &&
        persistedRunLinkRef.current !== runLinkKey
      ) {
        persistedRunLinkRef.current = runLinkKey;
        void Promise.resolve(
          propsRef.current.onRunLinked({
            workflowId: snap.workflowId,
            snapshot,
            dataSource: RUN_DATA_SOURCE,
            ...(snap.publishedModel ? { publishedModel: snap.publishedModel } : {}),
            ...(snap.trainedEpochs ? { trainedEpochs: snap.trainedEpochs } : {}),
          }),
        ).catch(() => {
          persistedRunLinkRef.current = null;
          setNotice('The run finished, but recording its LoRA link in Open Datasets failed. Refresh before publishing.');
        });
      }
      // Trainer-fee ledger credit: once, keyed by the workflow id, once the run
      // has actually produced trained epochs. A succeeded run still held in
      // moderation has NOT produced a LoRA yet (it can expire and refund), so
      // crediting it would overstate the ledger. Re-polls re-derive the same
      // event and creditLedgerEvent refuses the duplicate.
      if (
        snap.cost?.total != null &&
        snap.status === 'succeeded' &&
        snap.trainedEpochs &&
        snap.trainedEpochs.length > 0
      ) {
        const event = trainingFeeEvent({
          snapshot,
          workflowId: snap.workflowId,
          grossBuzz: snap.cost.total,
          dataSource: RUN_DATA_SOURCE,
        });
        setLedger((cur) => creditLedgerEvent(cur, event).events);
        if (propsRef.current.onLedgerEvent && persistedLedgerRef.current !== event.eventId) {
          persistedLedgerRef.current = event.eventId;
          void Promise.resolve(propsRef.current.onLedgerEvent(event, snapshot)).catch(() => {
            persistedLedgerRef.current = null;
            setNotice('Training finished, but saving the tracked trainer-fee event failed. Refresh before relying on the ledger.');
          });
        }
      }
      if (state === 'failed' || state === 'expired' || state === 'canceled') {
        setPhase('idle');
      }
    },
    [],
  );

  const runPollLoop = useCallback(
    (id: string, snapshot: DatasetSnapshot) => {
      if (pollCancelRef.current) pollCancelRef.current.cancelled = true;
      const tok = { cancelled: false };
      pollCancelRef.current = tok;
      let attempt = 0;
      const tick = async () => {
        if (tok.cancelled) return;
        let snap: BlockWorkflowSnapshot;
        try {
          snap = await pollRef.current(id);
        } catch {
          if (tok.cancelled) return;
          setTimeout(tick, 1000);
          return;
        }
        if (tok.cancelled) return;
        applyTrainingSnapshot(snap, snapshot);
        // Stop at terminal, at ready-to-publish (epochs listed), or once the
        // publish outcome is visible — the user drives the wizard from here.
        const state = trainingStateForSnapshot(snap);
        if (
          snap.status === 'succeeded' ||
          snap.status === 'failed' ||
          snap.status === 'expired' ||
          snap.status === 'canceled' ||
          state === 'ready-to-publish' ||
          snap.publishedModel
        ) {
          setPhase('idle');
          return;
        }
        attempt += 1;
        setTimeout(tick, Math.min(1500 + attempt * 500, 5000));
      };
      setTimeout(tick, 0);
    },
    [applyTrainingSnapshot],
  );

  const runKindWatch = useCallback(
    (id: string, snapshot: DatasetSnapshot) => {
      kindWatchAbortRef.current?.abort();
      const controller = new AbortController();
      kindWatchAbortRef.current = controller;
      void watchRef
        .current(id, {
          signal: controller.signal,
          onUpdate: (snap) => applyTrainingSnapshot(snap, snapshot),
        })
        .then((finalSnap) => {
          if (controller.signal.aborted) return;
          applyTrainingSnapshot(finalSnap, snapshot);
          setKindPhase('idle');
          setPhase('idle');
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setKindPhase('idle');
          setPhase('idle');
          setNotice('The training run started, but following its status stopped. Use Check again if it appears below.');
        });
    },
    [applyTrainingSnapshot],
  );

  /**
   * One manual re-poll — for the moderation wait and the post-wizard return.
   * Records against the snapshot the run was SUBMITTED with (activeRun), so a
   * quote priced since, or an edit that cleared it, cannot redirect the credit.
   */
  const refreshRun = useCallback(async () => {
    const run = activeRun;
    if (!run) return;
    try {
      const snap = await pollRef.current(run.workflowId);
      applyTrainingSnapshot(snap, run.snapshot);
      if (trainingStateForSnapshot(snap) === 'running') {
        if (run.path === 'civitai-trainer') runKindWatch(run.workflowId, run.snapshot);
        else runPollLoop(run.workflowId, run.snapshot);
      }
    } catch {
      setNotice('Could not refresh the run just now — try again in a moment.');
    }
  }, [activeRun, applyTrainingSnapshot, runPollLoop, runKindWatch]);

  const clearKindQuote = useCallback(() => {
    kindRequestRef.current += 1;
    setKindQuote(null);
    setKindBody(null);
    setKindSnapshot(null);
  }, []);

  /** Step 1 (both paths): the host's own training upload. Only these blobs can be trained on. */
  const onTrainingUploadClick = useCallback(async () => {
    if (!viewer) {
      requestSignIn();
      return;
    }
    if (kindPhaseRef.current === 'running' || kindPhaseRef.current === 'unconfirmed') return;
    clearKindQuote();
    setKindError(null);
    setUploadError(null);
    setUploading(true);
    try {
      const images = await openTrainingUpload();
      if (!images) return; // cancelled — keep whatever was uploaded before
      setUploads(images);
      setUploadAssignment(images.map((_, index) => included[index]?.itemId ?? ''));
    } catch (err) {
      setUploadError(`The upload did not finish: ${describeEstimateFailure(err)} Nothing was charged.`);
    } finally {
      setUploading(false);
    }
  }, [viewer, requestSignIn, clearKindQuote, openTrainingUpload, included]);

  /** Civitai's trainer: freeze the snapshot, pair uploads with it, and get Civitai's quote. */
  const doKindEstimate = useCallback(async () => {
    if (!uploads || kindPhaseRef.current === 'running' || kindPhaseRef.current === 'unconfirmed') return;
    // No attestation, no price: the app cannot tell the uploads are the snapshot's images.
    if (!attested) return;
    const request = ++kindRequestRef.current;
    setNotice(null);
    setRunError(null);
    setKindError(null);
    setKindQuote(null);
    setKindBody(null);
    setKindSnapshot(null);
    setKindPhase('pricing');

    const snapshot = freezeSnapshot(datasetIdForTraining, props.trainerId ?? viewer?.username ?? 'you', items, {
      manualExclusions,
      ownerOverrides: effectiveOwnerOverrides,
    });
    const paired = pairUploadsWithSnapshot(uploads, includedItems(snapshot), uploadAssignment);
    if (paired.problems.length > 0) {
      setKindPhase('idle');
      setKindError(`${paired.problems.join(' ')} No price was asked for and nothing was charged.`);
      return;
    }
    let body: WorkflowBodyTraining;
    try {
      body = buildTrainingKindBody({
        items: paired.items,
        config: { preset, triggerWord, steps, epochs, samplePrompt },
      });
    } catch (err) {
      setKindPhase('idle');
      setKindError(err instanceof Error ? err.message : 'Could not build the training run.');
      return;
    }
    let est: Awaited<ReturnType<typeof estimate>>;
    try {
      est = await estimate(body);
    } catch (err) {
      if (kindRequestRef.current !== request) return;
      setKindPhase('idle');
      setKindError(`No price quote — run not submitted. Details: ${describeEstimateFailure(err)} No Buzz was charged.`);
      return;
    }
    if (kindRequestRef.current !== request) return;
    const cls = classifyTrainingKindQuote(est);
    if (cls.kind !== 'quoted') {
      setKindPhase('idle');
      setKindError(`No price quote — run not submitted. ${cls.detail} No Buzz was charged.`);
      return;
    }
    setKindBody(body);
    setKindQuote(cls.quote);
    setKindSnapshot(snapshot);
    setKindPhase('quoted');
  }, [
    uploads,
    uploadAssignment,
    attested,
    datasetIdForTraining,
    props.trainerId,
    viewer,
    items,
    manualExclusions,
    effectiveOwnerOverrides,
    preset,
    triggerWord,
    steps,
    epochs,
    samplePrompt,
    estimate,
  ]);

  // Auto-resume a Civitai-trainer estimate after the spend-scope grant lands.
  useEffect(() => {
    if (granted && kindConsentPendingRef.current) {
      kindConsentPendingRef.current = false;
      void doKindEstimate();
    }
  }, [granted, doKindEstimate]);

  const onKindEstimateClick = useCallback(() => {
    if (!viewer) {
      requestSignIn();
      return;
    }
    if (!granted) {
      kindConsentPendingRef.current = true;
      requestConsent({ scopes: ['ai:write:budgeted'] });
      return;
    }
    void doKindEstimate();
  }, [viewer, granted, requestSignIn, requestConsent, doKindEstimate]);

  /** Civitai's trainer: Civitai's own dialog shows the server's price and is the charge. */
  const onKindRunClick = useCallback(async () => {
    if (!kindBody || !kindQuote || !kindSnapshot || kindPhase !== 'quoted') return;
    if (kindAfford === false) return;
    if (Date.parse(kindQuote.expiresAt) <= Date.now()) {
      setKindPhase('idle');
      clearKindQuote();
      setKindError('That quote has expired. Price the run again; no Buzz was charged.');
      return;
    }

    setKindError(null);
    setKindPhase('running');
    // Persist the frozen snapshot before Civitai's dialog can charge the
    // viewer. If storage refuses, the run never opens and nothing is charged.
    if (propsRef.current.onSnapshotConfirmed && persistedSnapshotRef.current !== kindSnapshot.snapshotId) {
      try {
        await propsRef.current.onSnapshotConfirmed(kindSnapshot);
        persistedSnapshotRef.current = kindSnapshot.snapshotId;
      } catch {
        setKindPhase('quoted');
        setKindError("Could not record the frozen snapshot in Open Datasets, so Civitai's training dialog was not opened. No Buzz was charged.");
        return;
      }
    }

    try {
      const started = await runTraining({ ...kindBody, quoteId: kindQuote.quoteId });
      setActiveRun({ workflowId: started.workflowId, snapshot: kindSnapshot, path: 'civitai-trainer' });
      applyTrainingSnapshot(started, kindSnapshot);
      const state = trainingStateForSnapshot(started);
      setKindPhase('idle');
      if (
        started.status === 'succeeded' ||
        started.status === 'failed' ||
        started.status === 'expired' ||
        started.status === 'canceled' ||
        state === 'ready-to-publish' ||
        started.publishedModel
      ) {
        setPhase('idle');
      } else {
        setPhase('running');
        runKindWatch(started.workflowId, kindSnapshot);
      }
    } catch (err) {
      const failure = trainingKindRunFailure(err);
      setPhase('idle');
      if (err instanceof RunTrainingError && err.signInRequired) requestSignIn();
      switch (failure.kind) {
        case 'declined':
          // The viewer dismissed Civitai's dialog: no run. Keep the still-valid
          // quote on screen so the next step stays obvious, without an alarm.
          setKindPhase('quoted');
          return;
        case 'sign-in':
          setKindPhase('quoted');
          setKindError(failure.message);
          return;
        case 'unconfirmed':
          // A run MAY exist and be charged. Never offer a retry from here.
          setKindPhase('unconfirmed');
          setKindError(failure.message);
          return;
        case 'not-uploaded':
          // The host forgot (or never had) these blobs: nothing ran. The
          // uploads are useless now, so drop them and ask for a fresh upload.
          setKindPhase('idle');
          clearKindQuote();
          setUploads(null);
          setUploadAssignment([]);
          setKindError(failure.message);
          return;
        default:
          setKindPhase('idle');
          clearKindQuote();
          setKindError(failure.message);
      }
    }
  }, [kindBody, kindQuote, kindSnapshot, kindPhase, kindAfford, clearKindQuote, runTraining, applyTrainingSnapshot, runKindWatch, requestSignIn]);

  const onSaveItemClick = useCallback(
    async (item: Pick<DatasetItem, 'imageId' | 'imageUrl'>, position: number) => {
      const filename = `open-datasets-${String(position).padStart(2, '0')}`;
      try {
        if (item.imageId != null) await saveImage({ imageId: item.imageId, filename });
        else await saveImage({ url: item.imageUrl, filename });
      } catch (err) {
        setNotice(`Could not save image #${position}: ${describeEstimateFailure(err)}`);
      }
    },
    [saveImage],
  );

  /** Pass-through: freeze the snapshot, pair the uploads with it, and price the step. */
  const doEstimate = useCallback(async () => {
    if (trainDisabledReason || !uploads) return;
    setNotice(null);
    setRunError(null);
    setQuoteError(null);
    setPhase('estimating');
    const snapshot = freezeSnapshot(datasetIdForTraining, props.trainerId ?? viewer?.username ?? 'you', items, {
      manualExclusions,
      ownerOverrides: effectiveOwnerOverrides,
    });
    const paired = pairUploadsWithSnapshot(uploads, includedItems(snapshot), uploadAssignment);
    if (paired.problems.length > 0) {
      setPhase('idle');
      setNotice(`${paired.problems.join(' ')} No price was asked for and nothing was charged.`);
      return;
    }
    let body: ReturnType<typeof buildTrainingBody>;
    try {
      body = buildTrainingBody(paired.items, {
        preset,
        triggerWord,
        steps,
        epochs,
        samplePrompt,
      });
    } catch (err) {
      setPhase('idle');
      setNotice(err instanceof Error ? err.message : 'Could not build the training run.');
      return;
    }
    try {
      const est = await estimate(body);
      const cls = classifyTrainingEstimate(est.cost?.total, body.maxBuzz);
      if (cls.kind === 'quoted') {
        setQuote(cls.cost);
        setQuoteClass(null);
        setQuoteError(null);
        setPassBody(body);
        setPassSnapshot(snapshot);
        setPhase('quoted');
      } else {
        // The hard rule: no quote, no submit. Say which refusal this was, and
        // for the missing class carry the raw cost the host did return.
        setQuote(null);
        setQuoteClass(cls.kind);
        setQuoteError(
          cls.kind === 'missing'
            ? `The estimate returned no usable cost (cost total was ${est.cost?.total ?? 'absent'}).`
            : null,
        );
        setPassBody(null);
        setPassSnapshot(null);
        setPhase('unquoted');
      }
    } catch (err) {
      // Never swallow the estimate error: the viewer (and any upstream
      // report) needs the actual message/code the host failed with.
      const detail = describeEstimateFailure(err);
      setQuote(null);
      setQuoteClass('missing');
      setQuoteError(
        OVER_BUDGET_TRAINING_STEP.test(detail)
          ? `${detail} — this run costs more than the quick path's per-call budget; use Civitai's trainer below.`
          : detail,
      );
      setPassBody(null);
      setPassSnapshot(null);
      setPhase('unquoted');
    }
  }, [trainDisabledReason, uploads, uploadAssignment, items, manualExclusions, effectiveOwnerOverrides, viewer, preset, triggerWord, steps, epochs, samplePrompt, estimate, datasetIdForTraining, props.trainerId]);

  // Auto-resume the estimate after a consent grant lands.
  useEffect(() => {
    if (granted && consentPendingRef.current) {
      consentPendingRef.current = false;
      void doEstimate();
    }
  }, [granted, doEstimate]);

  const onEstimateClick = useCallback(() => {
    if (!viewer) {
      requestSignIn();
      return;
    }
    if (!granted) {
      consentPendingRef.current = true;
      setPhase('needs-consent');
      requestConsent({ scopes: ['ai:write:budgeted'] });
      return;
    }
    void doEstimate();
  }, [viewer, granted, requestSignIn, requestConsent, doEstimate]);

  const onSubmitClick = useCallback(async () => {
    if (!passSnapshot || !passBody || quote == null || phase !== 'quoted') return;
    if (afford === false) return; // the confirm card already says why
    const snapshot = passSnapshot;
    // The frozen snapshot is the contributors' pay-split contract. Persist it
    // BEFORE the run exists: if community storage refuses, no Buzz moves and
    // the trainer sees exactly why.
    if (propsRef.current.onSnapshotConfirmed && persistedSnapshotRef.current !== snapshot.snapshotId) {
      setPhase('submitting');
      try {
        await propsRef.current.onSnapshotConfirmed(snapshot);
        persistedSnapshotRef.current = snapshot.snapshotId;
      } catch {
        setPhase('quoted');
        setNotice('Could not record the frozen snapshot in Open Datasets, so the training run was not submitted. No Buzz was charged.');
        return;
      }
    }
    setPhase('submitting');
    try {
      const snap = await submit(passBody);
      setActiveRun({ workflowId: snap.workflowId, snapshot, path: 'pass-through' });
      applyTrainingSnapshot(snap, snapshot);
      if (snap.status === 'pending' || snap.status === 'processing') {
        setPhase('running');
        runPollLoop(snap.workflowId, snapshot);
      } else {
        setPhase('idle');
      }
    } catch (err) {
      setPhase('idle');
      setRunState('failed');
      setRunError(err instanceof Error ? err.message : 'Submit failed.');
    }
  }, [passSnapshot, passBody, quote, phase, afford, submit, applyTrainingSnapshot, runPollLoop]);

  const onPublishClick = useCallback(() => {
    if (!activeRun || epoch == null) return;
    navigate(buildPublishWizardPath(activeRun.workflowId, epoch), { scope: 'site' });
    setNotice('Finish publishing in Civitai\'s model wizard — come back here and refresh to see the linked LoRA.');
  }, [activeRun, epoch, navigate]);

  const onUploadClick = useCallback(async () => {
    const uploaded = await openUpload();
    if (!uploaded) return;
    setItems((cur) => [
      ...cur,
      {
        itemId: `item-${cur.length + 1}-${uploaded.url}`,
        contributorId: viewer?.username ?? 'you',
        imageUrl: uploaded.url,
        caption: '',
        netVotes: 0,
      },
    ]);
    setNotice(
      'Image added. Give it a caption — it joins the training set once it has net-positive votes (or an owner override). Uploads are one image per call.',
    );
  }, [openUpload, viewer]);

  const toggleIn = (set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> => {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  };

  // The credit shown is THIS run's event, split by THIS run's own snapshot.
  const runEvent = activeRun
    ? ledger.find((e) => e.eventType === 'training' && e.sourceRef === activeRun.workflowId)
    : undefined;
  const credits = useMemo(
    () => (activeRun && runEvent ? deriveContributorCredits(runEvent, activeRun.snapshot) : []),
    [activeRun, runEvent],
  );
  const runSourceLabel = runEvent ? dataSourceLabel(runEvent) : null;

  const failureCopy = runState ? trainingFailureCopy(runState, runError) : null;

  return (
    <div data-testid="dc-theme-root" data-theme={dcTheme} data-dc-archive="true" style={archiveRootStyle}>
    <Stack gap={16} data-testid="dc-train">
      <span style={sectionTitleStyle}>Train a LoRA from this dataset</span>
      <span>
        {props.hideThemeToggle !== true && (
          <Button
            variant="subtle"
            size="sm"
            onClick={() => setDcTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            data-testid="dc-theme-toggle"
          >
            {dcTheme === 'dark' ? 'Light override' : 'Back to dark (default)'}
          </Button>
        )}
      </span>
      <span style={hintStyle}>
        In-app training on Civitai's trainer. The estimate is the real price — if the trainer
        can't quote the run, this app won't submit it. Publishing happens in Civitai's model
        wizard; the published LoRA links back to the frozen snapshot below.
      </span>

      {/* --- Snapshot review (spec Screen 4, first half) --- */}
      <div style={fieldStyle}>
        <span style={fieldLabelStyle}>
          Snapshot review{' '}
          <Badge color="info" variant="light">
            {included.length} in the training set · total weight {preview.totalWeight}
          </Badge>
        </span>
        <span style={hintStyle}>
          Included = net-positive votes. Vote weights freeze when you train — later votes never
          rewrite this snapshot. Shares below are of any Buzz this LoRA tracks.
        </span>
        {props.lockItemMetadata === true && (
          <span style={hintStyle}>Captions and votes are locked from the live dataset record — they freeze exactly as shown.</span>
        )}
        <div className="od-grid-items">
          {items.map((it) => {
            const snapItem = preview.items.find((s) => s.itemId === it.itemId);
            const isIn = snapItem?.included ?? false;
            return (
              <div key={it.itemId} style={itemRowStyle(isIn)} data-testid="dc-dataset-item">
                <div style={itemHeadStyle}>
                  <span style={itemCaptionStyle}>{it.caption || '(no caption yet)'}</span>
                  <Badge color={isIn ? 'primary' : 'gray'} variant="light">
                    {isIn ? `in · weight ${snapItem!.weight}` : 'out'}
                  </Badge>
                </div>
                <span style={hintStyle}>
                  by {it.contributorName ?? it.contributorId}
                  {snapItem?.exclusionReason === 'net-not-positive' && ' · net votes not positive'}
                  {snapItem?.exclusionReason === 'manual' && ' · manually excluded'}
                  {snapItem?.ownerOverride && ' · owner override (floor weight 1)'}
                </span>
                <div style={itemControlsStyle}>
                  <label style={miniLabelStyle}>
                    caption
                    <input
                      style={inputStyle}
                      value={it.caption}
                      disabled={props.lockItemMetadata === true}
                      data-testid={`dc-caption-${it.itemId}`}
                      onChange={(e) =>
                        setItems((cur) => cur.map((c) => (c.itemId === it.itemId ? { ...c, caption: e.target.value } : c)))
                      }
                    />
                  </label>
                  <label style={miniLabelStyle}>
                    net votes
                    <input
                      style={{ ...inputStyle, width: 72 }}
                      type="number"
                      value={it.netVotes}
                      disabled={props.lockItemMetadata === true}
                      data-testid={`dc-votes-${it.itemId}`}
                      onChange={(e) =>
                        setItems((cur) =>
                          cur.map((c) => (c.itemId === it.itemId ? { ...c, netVotes: Number(e.target.value) || 0 } : c)),
                        )
                      }
                    />
                  </label>
                  <label style={checkLabelStyle}>
                    <input
                      type="checkbox"
                      checked={manualExclusions.has(it.itemId)}
                      data-testid={`dc-exclude-${it.itemId}`}
                      onChange={(e) => setManualExclusions((s) => toggleIn(s, it.itemId, e.target.checked))}
                    />
                    exclude
                  </label>
                  {props.canOwnerOverride !== false && (
                    <label style={checkLabelStyle}>
                      <input
                        type="checkbox"
                        checked={ownerOverrides.has(it.itemId)}
                        data-testid={`dc-override-${it.itemId}`}
                        onChange={(e) => setOwnerOverrides((s) => toggleIn(s, it.itemId, e.target.checked))}
                      />
                      owner override in
                    </label>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {props.allowLocalUploads !== false && (
          <span>
            <Button variant="light" size="sm" onClick={() => void onUploadClick()} data-testid="dc-upload">
              + Add an image (host upload)
            </Button>
          </span>
        )}
        {shares.size > 0 && (
          <span style={hintStyle} data-testid="dc-shares">
            {[...shares.entries()]
              .map(([who, share]) => {
                const name = items.find((i) => i.contributorId === who)?.contributorName ?? who;
                return `${name} ${(share * 100).toFixed(1)}%`;
              })
              .join(' · ')}
          </span>
        )}
      </div>

      {/* --- Training configuration (narrowest supported path) --- */}
      <div style={fieldStyle}>
        <span style={fieldLabelStyle}>Training setup</span>
        <div style={itemControlsStyle}>
          <label style={miniLabelStyle}>
            base model
            <select
              style={inputStyle}
              value={preset.id}
              data-testid="dc-preset"
              onChange={(e) => {
                const next = TRAINING_PRESETS.find((p) => p.id === e.target.value);
                if (next) {
                  // Each base model starts from Training Studio's own step/epoch defaults.
                  setPreset(next);
                  setSteps(next.trainingKind.defaults.steps);
                  setEpochs(next.trainingKind.defaults.epochs);
                }
              }}
            >
              {TRAINING_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.approxBuzz != null ? ` · ~${p.approxBuzz} Buzz` : ''}
                  {passThroughAvailable(p) ? '' : " · Civitai's trainer only"}
                </option>
              ))}
            </select>
          </label>
          <label style={miniLabelStyle}>
            trigger word
            <input
              style={inputStyle}
              value={triggerWord}
              data-testid="dc-trigger"
              onChange={(e) => setTriggerWord(e.target.value)}
            />
          </label>
          <label style={miniLabelStyle}>
            steps
            <input
              style={{ ...inputStyle, width: 88 }}
              type="number"
              min={TRAINING_STEPS_BOUNDS.min}
              max={TRAINING_STEPS_BOUNDS.max}
              value={steps}
              data-testid="dc-steps"
              onChange={(e) => setSteps(Number(e.target.value) || 0)}
              onBlur={() => setSteps((s) => clampTrainingSteps(s))}
            />
          </label>
          <label style={miniLabelStyle}>
            epochs
            <input
              style={{ ...inputStyle, width: 72 }}
              type="number"
              min={TRAINING_EPOCHS_BOUNDS.min}
              max={TRAINING_EPOCHS_BOUNDS.max}
              value={epochs}
              data-testid="dc-epochs"
              onChange={(e) => setEpochs(Number(e.target.value) || 0)}
              onBlur={() => setEpochs((n) => clampTrainingEpochs(n))}
            />
          </label>
          <label style={miniLabelStyle}>
            sample prompt
            <input
              style={inputStyle}
              value={samplePrompt}
              placeholder="defaults to your trigger word"
              data-testid="dc-sample"
              onChange={(e) => setSamplePrompt(e.target.value)}
            />
          </label>
        </div>
      </div>

      {/* --- The training upload (both paths): save → upload → match → attest --- */}
      {viewer && (
        <div style={fieldStyle} data-testid="dc-train-uploads">
          <span style={fieldLabelStyle}>
            Upload the training set{' '}
            <Badge color={uploadBlocker ? 'gray' : 'primary'} variant="light">
              {uploadBlocker ? 'not available' : `${included.length} image${included.length === 1 ? '' : 's'} to upload`}
            </Badge>
          </span>
          <span style={hintStyle}>
            Civitai trains only on images uploaded from this page — for both the quick path and
            Civitai's trainer — so you upload the training set yourself: save the numbered images
            below, then upload exactly those files in Civitai's upload window. Each upload is
            matched to one training-set image — in order by default — and carries that image's
            frozen caption. Uploads are forgotten if this page reloads.
          </span>

          {uploadBlocker ? (
            <Alert color="warning" title="This training set can't be uploaded for training" data-testid="dc-train-blocked">
              {uploadBlocker}
            </Alert>
          ) : (
            <ol style={kindListStyle} data-testid="dc-train-list">
              {included.map((item, index) => (
                <li key={item.itemId} style={kindRowStyle}>
                  <span style={monoStyle}>#{index + 1}</span>
                  <span style={itemCaptionStyle}>{item.caption || '(no caption)'}</span>
                  <span style={hintStyle}>by {item.contributorName ?? item.contributorId}</span>
                  {(item.imageId != null || /^https:\/\//.test(item.imageUrl)) && (
                    <Button
                      size="sm"
                      variant="subtle"
                      onClick={() => void onSaveItemClick(item, index + 1)}
                      data-testid={`dc-train-save-${item.itemId}`}
                    >
                      Save #{index + 1}
                    </Button>
                  )}
                </li>
              ))}
            </ol>
          )}

          {!uploadBlocker && kindPhase !== 'quoted' && kindPhase !== 'running' && kindPhase !== 'unconfirmed' && (
            <span>
              <Button
                variant="light"
                size="sm"
                loading={uploading}
                disabled={busy || phase === 'quoted'}
                onClick={() => void onTrainingUploadClick()}
                data-testid="dc-train-upload"
              >
                {uploads ? 'Upload again' : `Upload these ${included.length} image${included.length === 1 ? '' : 's'}`}
              </Button>
            </span>
          )}

          {uploads && kindPhase !== 'unconfirmed' && (
            <div style={fieldStyle} data-testid="dc-train-pairs">
              {uploads.map((upload, index) => (
                <div key={`${upload.air}-${index}`} style={kindRowStyle} data-testid="dc-train-pair">
                  <img src={upload.url} alt={`upload ${index + 1}`} style={kindThumbStyle} />
                  <label style={miniLabelStyle}>
                    upload #{index + 1} is
                    <select
                      style={inputStyle}
                      value={uploadAssignment[index] ?? ''}
                      disabled={busy || phase === 'quoted' || kindPhase === 'quoted'}
                      data-testid={`dc-train-match-${index}`}
                      onChange={(e) =>
                        setUploadAssignment((cur) => {
                          const next = [...cur];
                          next[index] = e.target.value;
                          return next;
                        })
                      }
                    >
                      <option value="">— pick the training-set image —</option>
                      {included.map((item, itemIndex) => (
                        <option key={item.itemId} value={item.itemId}>
                          #{itemIndex + 1} · {item.caption || '(no caption)'}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              ))}
              {pairing && pairing.problems.length > 0 && (
                <Alert color="warning" title="Fix the uploads before pricing" data-testid="dc-train-problems">
                  {pairing.problems.join(' ')}
                </Alert>
              )}
              {kindPhase !== 'quoted' && kindPhase !== 'running' && (
                <label style={checkLabelStyle}>
                  <input
                    type="checkbox"
                    checked={attested}
                    disabled={busy || phase === 'quoted'}
                    data-testid="dc-train-attest"
                    onChange={(e) => setAttested(e.target.checked)}
                  />
                  I confirm these uploads are the training set's images listed above, each matched to the
                  right number. This app can't check the files; the run and the contributors' credit are
                  recorded as trainer-attested.
                </label>
              )}
            </div>
          )}

          {uploadError && (
            <Alert color="error" title="Upload not finished" data-testid="dc-train-upload-error">
              {uploadError}
            </Alert>
          )}
        </div>
      )}

      {/* --- Quick path: pass-through step, estimate → confirm → submit (spec §7.5 honesty rules) --- */}
      {!viewer ? (
        <Button fullWidth onClick={() => requestSignIn()} data-testid="dc-signin">
          Sign in to train
        </Button>
      ) : phase !== 'quoted' && phase !== 'submitting' && kindPhase !== 'quoted' ? (
        <Button
          fullWidth
          loading={phase === 'estimating'}
          disabled={trainDisabledReason != null || busy}
          onClick={onEstimateClick}
          data-testid="dc-estimate"
        >
          {phase === 'estimating' ? 'Pricing the run…' : 'Price this training run'}
        </Button>
      ) : null}

      {trainDisabledReason && phase !== 'quoted' && (
        <span style={hintStyle} data-testid="dc-train-disabled-reason">
          {trainDisabledReason}
        </span>
      )}

      {phase === 'needs-consent' && (
        <Alert color="info" title="Grant access to train" data-testid="dc-consent">
          Confirm in the Civitai dialog. If you dismissed it, price the run again.
        </Alert>
      )}

      {phase === 'unquoted' && (
        <Alert color="error" title="No price quote — run not submitted" data-testid="dc-unquoted">
          {quoteClass === 'unquoted'
            ? 'The trainer returned no quote for this run (the estimate came back at the floor). Submitting anyway would start an unpriced run, so this app refuses. Try again shortly, or adjust steps/epochs.'
            : 'The trainer returned no usable price for this run, so there is nothing honest to confirm against. Try again shortly.'}{' '}
          No Buzz was charged.
          {quoteError && (
            <span style={monoStyle} data-testid="dc-unquoted-detail">
              {' '}
              Details: {quoteError}
            </span>
          )}
        </Alert>
      )}

      {(phase === 'quoted' || phase === 'submitting') && quote != null && (
        <div style={confirmStyle} data-testid="dc-confirm">
          <span style={fieldLabelStyle}>Confirm training</span>
          <span style={monoStyle} data-testid="dc-quote">
            {formatCost(quote)} Buzz
          </span>
          <span style={hintStyle}>
            {passBody?.input.trainingData.items.length ?? included.length} uploaded images · snapshot
            weight {passSnapshot?.totalWeight ?? preview.totalWeight} · {preset.label}. This is the
            trainer fee the snapshot's contributors will be credited from (tracked, not paid out).
          </span>
          {afford === false ? (
            <Alert color="warning" title="Not enough Buzz" data-testid="dc-insufficient">
              This run is quoted at {formatCost(quote)} Buzz and your balance is{' '}
              {formatCost(balanceTotal)}. Top up and price the run again — nothing was charged.
            </Alert>
          ) : (
            <Button
              fullWidth
              loading={phase === 'submitting'}
              onClick={() => void onSubmitClick()}
              data-testid="dc-confirm-submit"
            >
              Train · {formatCost(quote)} Buzz
            </Button>
          )}
        </div>
      )}

      {/* --- Civitai's trainer (kind: 'training'): quote → Civitai dialog, on the same uploads --- */}
      {viewer && (
        <div style={fieldStyle} data-testid="dc-kind-training">
          <span style={fieldLabelStyle}>Train on Civitai's trainer</span>
          <span style={hintStyle}>
            Works for every base model above, including Flux, Qwen and Chroma (up to 5,000 Buzz a
            run), on the uploads above. Civitai shows the final price in its own dialog before
            anything is charged.
          </span>

          {!uploadBlocker && uploads && kindPhase !== 'quoted' && kindPhase !== 'running' && kindPhase !== 'unconfirmed' && (
            <span>
              <Button
                variant="light"
                size="sm"
                loading={kindPhase === 'pricing'}
                disabled={busy || phase === 'quoted' || !uploadsReady}
                onClick={onKindEstimateClick}
                data-testid="dc-kind-estimate"
              >
                {kindPhase === 'pricing' ? 'Pricing…' : `Price this run on Civitai's trainer`}
              </Button>
            </span>
          )}

          {(kindPhase === 'quoted' || kindPhase === 'running') && kindQuote && (
            <div style={confirmStyle} data-testid="dc-kind-confirm">
              <span style={fieldLabelStyle}>Confirm training on Civitai's trainer</span>
              <span style={monoStyle} data-testid="dc-kind-quote">
                {formatCost(kindQuote.total)} Buzz
              </span>
              <span style={hintStyle}>
                {kindQuote.imageCount} uploaded image{kindQuote.imageCount === 1 ? '' : 's'} · snapshot
                weight {kindSnapshot?.totalWeight ?? preview.totalWeight} · {preset.label}. Quote
                expires {new Date(kindQuote.expiresAt).toLocaleString()}. Civitai's dialog is the
                final charge confirmation. This is the trainer fee the snapshot's contributors will
                be credited from (tracked, not paid out).
              </span>
              {kindAfford === false ? (
                <Alert color="warning" title="Not enough Buzz" data-testid="dc-kind-insufficient">
                  This run is quoted at {formatCost(kindQuote.total)} Buzz and your balance is{' '}
                  {formatCost(balanceTotal)}. Top up and price the run again — nothing was charged.
                </Alert>
              ) : (
                <Button
                  fullWidth
                  loading={kindPhase === 'running'}
                  onClick={() => void onKindRunClick()}
                  data-testid="dc-kind-run"
                >
                  Open Civitai confirmation · {formatCost(kindQuote.total)} Buzz
                </Button>
              )}
            </div>
          )}

          {kindPhase === 'unconfirmed' && (
            <Alert color="error" title="Training submission unconfirmed" data-testid="dc-kind-unconfirmed">
              {kindError}
            </Alert>
          )}

          {kindError && kindPhase !== 'unconfirmed' && (
            <Alert color="error" title="Training on Civitai's trainer not started" data-testid="dc-kind-error">
              {kindError}
            </Alert>
          )}
        </div>
      )}

      {/* --- Run state: moderation, epochs, publish, ledger --- */}
      {runState && (
        <div style={fieldStyle} data-testid="dc-run">
          <span style={fieldLabelStyle}>
            Training run{' '}
            <Badge color="info" variant="light" data-testid="dc-run-state">
              {runStateLabel(runState, phase)}
            </Badge>
          </span>
          {runCost != null && (
            <span style={monoStyle} data-testid="dc-run-cost">
              {formatCost(runCost)} Buzz
            </span>
          )}

          {runState === 'awaiting-moderation' && (
            <Alert color="info" title="Dataset in moderation" data-testid="dc-moderation">
              Civitai moderates the training dataset before epochs are released. This can take a
              while; a held dataset expires after 48 hours and is refunded. Nothing more is
              charged while you wait.
              <Button size="sm" variant="light" onClick={() => void refreshRun()} data-testid="dc-check-again">
                Check again
              </Button>
            </Alert>
          )}

          {runState === 'ready-to-publish' && epoch != null && (
            <Stack gap={8}>
              <span style={hintStyle}>
                Training finished — epoch {epoch} is ready. Publishing happens in Civitai's model
                wizard (license, title, moderation); this app never receives the checkpoint file.
              </span>
              <Button onClick={onPublishClick} data-testid="dc-publish">
                Publish epoch {epoch} on Civitai
              </Button>
            </Stack>
          )}

          {(runState === 'publish-started' || runState === 'published') && (
            <Stack gap={8}>
              <Alert
                color={runState === 'published' ? 'success' : 'info'}
                title={runState === 'published' ? 'LoRA published' : 'Publishing in progress'}
                data-testid="dc-published"
              >
                {published
                  ? `Model version ${published.modelVersionId} ${published.published ? 'is live' : 'is still a draft in the wizard'} — linked to this snapshot.`
                  : 'Linked to this snapshot.'}
              </Alert>
              <Button variant="light" size="sm" onClick={() => void refreshRun()} data-testid="dc-refresh-publish">
                Refresh publish status
              </Button>
            </Stack>
          )}

          {failureCopy && (
            <Alert color="error" title="Training run ended" data-testid="dc-run-failed">
              {failureCopy}
            </Alert>
          )}

          {credits.length > 0 && (
            <div style={ledgerStyle} data-testid="dc-ledger">
              <span style={fieldLabelStyle}>
                Tracked credit from this run
                {runSourceLabel && (
                  <>
                    {' '}
                    <Badge color="gray" variant="light" data-testid="dc-ledger-source">
                      {runSourceLabel}
                    </Badge>
                  </>
                )}
              </span>
              {credits.map((c) => (
                <div key={c.contributorId} style={ledgerRowStyle} data-testid={`dc-credit-${c.contributorId}`}>
                  <span>{activeRun?.snapshot.items.find((i) => i.contributorId === c.contributorId)?.contributorName ?? c.contributorId}</span>
                  <span style={monoStyle}>
                    {formatCost(c.credit)} Buzz tracked · {(c.share * 100).toFixed(1)}%
                  </span>
                </div>
              ))}
              <span style={hintStyle}>
                Tracked shares only — no Buzz moves to contributors until the platform ships a
                payout rail.
              </span>
            </div>
          )}
        </div>
      )}

      {notice && (
        <Alert color="info" withCloseButton onClose={() => setNotice(null)} data-testid="dc-notice">
          {notice}
        </Alert>
      )}
    </Stack>
    </div>
  );
}

function runStateLabel(state: TrainingRunState, phase: TrainPhase): string {
  if (phase === 'running' || state === 'running') return 'training…';
  switch (state) {
    case 'awaiting-moderation':
      return 'in moderation';
    case 'ready-to-publish':
      return 'ready to publish';
    case 'publish-started':
      return 'publishing (draft)';
    case 'published':
      return 'published';
    case 'failed':
      return 'failed';
    case 'expired':
      return 'expired';
    case 'canceled':
      return 'canceled';
    default:
      return state;
  }
}

// Archive Lab chrome for the Train surface: squared specimen cards, mono for
// money/weights, amber ONLY on the ledger (the theme rule from the spec §8).
const archiveRootStyle: React.CSSProperties = {
  background: 'var(--dc-archive-bg, var(--civitai-color-surface-2))',
  color: 'var(--civitai-color-text)',
  borderRadius: 6,
  padding: 12,
};
const sectionTitleStyle: React.CSSProperties = {
  fontFamily: 'Georgia, "Times New Roman", serif',
  fontSize: 18,
  fontWeight: 700,
};
const fieldStyle: React.CSSProperties = { display: 'grid', gap: 6 };
const fieldLabelStyle: React.CSSProperties = { fontSize: 14, fontWeight: 600 };
const hintStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--civitai-color-text-dimmed, var(--civitai-color-text))',
  opacity: 0.85,
  lineHeight: 1.45,
};
const monoStyle: React.CSSProperties = {
  fontFamily: 'var(--civitai-font-mono, ui-monospace, monospace)',
  fontVariantNumeric: 'tabular-nums',
  fontSize: 13,
};
const inputStyle: React.CSSProperties = {
  padding: '6px 8px',
  borderRadius: 6,
  border: '1px solid var(--civitai-color-border)',
  background: 'var(--civitai-color-surface)',
  color: 'var(--civitai-color-text)',
  fontSize: 13,
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
};
function itemRowStyle(isIn: boolean): React.CSSProperties {
  return {
    display: 'grid',
    gap: 6,
    padding: '8px 10px',
    borderRadius: 6,
    border: '1px solid ' + (isIn ? 'var(--civitai-color-primary)' : 'var(--civitai-color-border)'),
    background: 'var(--civitai-color-surface)',
  };
}
const itemHeadStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 8,
};
const itemCaptionStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const itemControlsStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 10,
  alignItems: 'flex-end',
};
const miniLabelStyle: React.CSSProperties = {
  display: 'grid',
  gap: 3,
  fontSize: 11,
  opacity: 0.9,
  flex: '1 1 150px',
  minWidth: 0,
};
const checkLabelStyle: React.CSSProperties = {
  display: 'flex',
  gap: 5,
  alignItems: 'center',
  fontSize: 12,
  paddingBottom: 6,
};
const kindListStyle: React.CSSProperties = { display: 'grid', gap: 4, margin: 0, paddingLeft: 0, listStyle: 'none' };
const kindRowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  alignItems: 'center',
  fontSize: 13,
  minWidth: 0,
};
const kindThumbStyle: React.CSSProperties = {
  width: 48,
  height: 48,
  objectFit: 'cover',
  borderRadius: 4,
  border: '1px solid var(--civitai-color-border)',
  flex: '0 0 auto',
};
const confirmStyle: React.CSSProperties = {
  display: 'grid',
  gap: 8,
  padding: '12px 14px',
  borderRadius: 6,
  border: '1px solid var(--civitai-color-primary)',
  background: 'var(--civitai-color-surface)',
};
const ledgerStyle: React.CSSProperties = {
  display: 'grid',
  gap: 6,
  padding: '10px 12px',
  borderRadius: 6,
  border: '1px solid var(--civitai-color-warning, #e8a33d)',
  background: 'var(--civitai-color-surface)',
};
const ledgerRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 8,
  fontSize: 13,
};
