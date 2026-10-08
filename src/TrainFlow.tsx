import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  useBlockContext,
  useBlockToken,
  useBuzzBalance,
  useBuzzWorkflow,
  useCivitaiNavigate,
  useImageUpload,
  usePrepareTrainingDataset,
  useRequestConsent,
  useRequestSignIn,
  useRunTraining,
  PrepareTrainingDatasetError,
  RunTrainingError,
} from '@civitai/blocks-react';
import { Alert, Badge, Button, Stack } from '@civitai/blocks-react/ui';
import type {
  BlockTrainingQuote,
  BlockWorkflowSnapshot,
  WorkflowBodyTraining,
} from '@civitai/app-sdk/blocks';

import { formatCost, hasBudgetedScope } from './generation.js';
import {
  DEFAULT_TRAINING_PRESET,
  TRAINING_PRESETS,
  assembleTrainingItems,
  buildPublishWizardPath,
  buildTrainingBody,
  buildTrainingKindBody,
  canAffordQuote,
  classifyTrainingEstimate,
  classifyTrainingKindQuote,
  contributorShares,
  creditLedgerEvent,
  describeEstimateFailure,
  deriveContributorCredits,
  freezeSnapshot,
  includedItems,
  latestEpoch,
  linkedLoraFromSnapshot,
  trainingFailureCopy,
  trainingFeeEvent,
  trainingKindEligibility,
  trainingKindRunFailure,
  trainingStateForSnapshot,
  type DatasetItem,
  type DatasetSnapshot,
  type LedgerEvent,
  type TrainingPreset,
  type TrainingRunState,
} from './training.js';

/**
 * The Train flow (spec Screen 4) for Dataset Commons — Option A′.
 *
 * Snapshot review → estimate (quote gate) → confirm with the real quote and a
 * balance check → submit → poll → moderation/epochs → publish wizard (site
 * scope) → publishedModel linkage → trainer-fee ledger credit (tracked, never
 * paid out). Every rule that matters lives in training.ts; this component only
 * drives the hooks and renders state.
 *
 * The dataset shown on first paint is a small MOCK dataset (the full
 * shared-storage datasets/voting build is the next slice) — it exists so the
 * whole training path is exercisable in the mock harness with no real Buzz.
 * Uploads come from the host's own modal, one image per call, exactly as the
 * platform supports.
 */

type TrainPhase =
  | 'idle'
  | 'needs-consent'
  | 'estimating'
  | 'quoted'
  | 'unquoted'
  | 'submitting'
  | 'running';

type OwnTrainPhase = 'idle' | 'preparing' | 'quoted' | 'running' | 'unconfirmed';

const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();

/** A training run the Community shell should record against a real dataset. */
export interface TrainRunLink {
  workflowId: string;
  snapshot: DatasetSnapshot | null;
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
  const { prepareDataset } = usePrepareTrainingDataset();
  const { runTraining } = useRunTraining();
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
  const [ownPhase, setOwnPhase] = useState<OwnTrainPhase>('idle');
  const [ownQuote, setOwnQuote] = useState<BlockTrainingQuote | null>(null);
  const [ownBody, setOwnBody] = useState<WorkflowBodyTraining | null>(null);
  const [ownSnapshot, setOwnSnapshot] = useState<DatasetSnapshot | null>(null);
  const [ownPreparedCount, setOwnPreparedCount] = useState<number | null>(null);
  const [ownError, setOwnError] = useState<string | null>(null);
  const [frozen, setFrozen] = useState<DatasetSnapshot | null>(null);
  const [workflowId, setWorkflowId] = useState<string | null>(null);
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
  const ownPhaseRef = useRef<OwnTrainPhase>('idle');
  ownPhaseRef.current = ownPhase;
  const ownRequestRef = useRef(0);
  const ownWatchAbortRef = useRef<AbortController | null>(null);
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
      ownWatchAbortRef.current?.abort();
    };
  }, []);

  // Any edit to the dataset or config invalidates a standing quote — the price
  // was quoted for THAT body, not for whatever the form says now.
  useEffect(() => {
    if (phase === 'quoted' || phase === 'unquoted') {
      setPhase('idle');
      setQuote(null);
      setQuoteClass(null);
      setFrozen(null);
    }
    // Only the inputs matter, not phase (phase is the thing being reset).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, manualExclusions, effectiveOwnerOverrides, preset, triggerWord, samplePrompt, steps, epochs]);

  // The own-images quote is also for one exact dataset/config body. Any edit
  // invalidates it; an in-flight prepare/estimate is token-guarded below.
  useEffect(() => {
    if (ownPhaseRef.current === 'preparing' || ownPhaseRef.current === 'quoted') {
      ownRequestRef.current += 1;
      setOwnPhase('idle');
      setOwnQuote(null);
      setOwnBody(null);
      setOwnSnapshot(null);
      setOwnPreparedCount(null);
      setOwnError(null);
      setFrozen(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, manualExclusions, effectiveOwnerOverrides, preset, triggerWord, samplePrompt, steps, epochs]);

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
  const shares = useMemo(() => contributorShares(preview), [preview]);
  const assembled = useMemo(
    () => assembleTrainingItems(included.map((i) => ({ url: i.imageUrl, caption: i.caption }))),
    [included],
  );

  const ownEligibility = useMemo(() => trainingKindEligibility(preview), [preview]);
  const busy =
    phase === 'estimating' ||
    phase === 'submitting' ||
    phase === 'running' ||
    ownPhase === 'preparing' ||
    ownPhase === 'running';
  const afford = quote == null ? null : canAffordQuote(quote, balanceTotal);
  const ownAfford = ownQuote == null ? null : canAffordQuote(ownQuote.total, balanceTotal);
  const trainDisabledReason =
    included.length === 0
      ? 'No items are in the training set — an item needs net-positive votes (or an owner override) and must not be manually excluded.'
      : assembled.items.length === 0
        ? 'None of the included items resolve to a Civitai blob the trainer can read.'
        : !preset.modelAir || !preset.withinCurrentCap
          ? 'This base model is not available for in-app training yet.'
          : null;

  const applyTrainingSnapshot = useCallback(
    (snap: BlockWorkflowSnapshot, snapshot: DatasetSnapshot | null) => {
      setRunCost(snap.cost?.total ?? null);
      if (snap.error) setRunError(snap.error);
      const state = trainingStateForSnapshot(snap);
      setRunState(state);
      setEpoch(latestEpoch(snap));
      if (snap.publishedModel) {
        setPublished(snap.publishedModel);
        const linked = linkedLoraFromSnapshot(snap, snapshot?.snapshotId ?? 'preview');
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
        snapshot &&
        (hasEpochs || snap.publishedModel) &&
        propsRef.current.onRunLinked &&
        persistedRunLinkRef.current !== runLinkKey
      ) {
        persistedRunLinkRef.current = runLinkKey;
        void Promise.resolve(
          propsRef.current.onRunLinked({
            workflowId: snap.workflowId,
            snapshot,
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
        snapshot &&
        snap.cost?.total != null &&
        snap.status === 'succeeded' &&
        snap.trainedEpochs &&
        snap.trainedEpochs.length > 0
      ) {
        const event = trainingFeeEvent({
          snapshot,
          workflowId: snap.workflowId,
          grossBuzz: snap.cost.total,
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
    (id: string, snapshot: DatasetSnapshot | null) => {
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

  /** One manual re-poll — for the moderation wait and the post-wizard return. */
  const refreshRun = useCallback(async () => {
    if (!workflowId) return;
    try {
      const snap = await pollRef.current(workflowId);
      applyTrainingSnapshot(snap, frozen);
      if (trainingStateForSnapshot(snap) === 'running') runPollLoop(workflowId, frozen);
    } catch {
      setNotice('Could not refresh the run just now — try again in a moment.');
    }
  }, [workflowId, frozen, applyTrainingSnapshot, runPollLoop]);

  const runOwnWatch = useCallback(
    (id: string, snapshot: DatasetSnapshot) => {
      ownWatchAbortRef.current?.abort();
      const controller = new AbortController();
      ownWatchAbortRef.current = controller;
      void watchRef
        .current(id, {
          signal: controller.signal,
          onUpdate: (snap) => applyTrainingSnapshot(snap, snapshot),
        })
        .then((finalSnap) => {
          if (controller.signal.aborted) return;
          applyTrainingSnapshot(finalSnap, snapshot);
          setOwnPhase('idle');
          setPhase('idle');
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setOwnPhase('idle');
          setPhase('idle');
          setNotice('The own-images run started, but following its status stopped. Use Check again if it appears below.');
        });
    },
    [applyTrainingSnapshot],
  );

  const doOwnEstimate = useCallback(async () => {
    if (!ownEligibility.ready || ownPhaseRef.current === 'running' || ownPhaseRef.current === 'unconfirmed') return;
    const request = ++ownRequestRef.current;
    setNotice(null);
    setRunError(null);
    setOwnError(null);
    setOwnQuote(null);
    setOwnBody(null);
    setOwnSnapshot(null);
    setOwnPreparedCount(null);
    setOwnPhase('preparing');

    const snapshot = freezeSnapshot(datasetIdForTraining, props.trainerId ?? viewer?.username ?? 'you', items, {
      manualExclusions,
      ownerOverrides: effectiveOwnerOverrides,
    });
    const eligibility = trainingKindEligibility(snapshot);
    if (!eligibility.ready) {
      setOwnPhase('idle');
      setOwnError('The own-images path is not available for every item in this training set.');
      return;
    }

    try {
      const prepared = await prepareDataset(
        eligibility.candidates.map((candidate) => ({ imageId: candidate.imageId, caption: candidate.caption })),
      );
      if (ownRequestRef.current !== request) return;
      setOwnPreparedCount(prepared.count);
      if (prepared.rejected.length > 0) {
        const rejected = prepared.rejected
          .map((item) => `image #${item.imageId}: ${item.reason}`)
          .join('; ');
        setOwnPhase('idle');
        setOwnError(
          `Civitai left ${prepared.rejected.length} of the trainer's images out of the prepared dataset (${rejected}). No price was quoted and no run was submitted. No Buzz was charged.`,
        );
        return;
      }
      if (prepared.count !== eligibility.candidates.length) {
        setOwnPhase('idle');
        setOwnError(
          `Civitai prepared ${prepared.count} image(s), but this snapshot has ${eligibility.candidates.length}. No price was quoted and no run was submitted. No Buzz was charged.`,
        );
        return;
      }

      const body = buildTrainingKindBody({
        preparedDatasetId: prepared.datasetId,
        config: { preset, triggerWord, steps, epochs, samplePrompt },
      });
      let est: Awaited<ReturnType<typeof estimate>>;
      try {
        est = await estimate(body);
      } catch (err) {
        if (ownRequestRef.current !== request) return;
        setOwnPhase('idle');
        setOwnError(
          `No own-images price quote — run not submitted. Details: ${describeEstimateFailure(err)} No Buzz was charged.`,
        );
        return;
      }
      if (ownRequestRef.current !== request) return;
      const cls = classifyTrainingKindQuote(est);
      if (cls.kind !== 'quoted') {
        setOwnPhase('idle');
        setOwnError(`No own-images price quote — run not submitted. ${cls.detail} No Buzz was charged.`);
        return;
      }
      setOwnBody(body);
      setOwnQuote(cls.quote);
      setOwnSnapshot(snapshot);
      setFrozen(snapshot);
      setOwnPhase('quoted');
    } catch (err) {
      if (ownRequestRef.current !== request) return;
      setOwnPhase('idle');
      if (err instanceof PrepareTrainingDatasetError && err.signInRequired) {
        requestSignIn();
        setOwnError('Sign in to train, then price the own-images run again. No Buzz was charged.');
      } else if (err instanceof PrepareTrainingDatasetError && err.timedOut) {
        setOwnError('Preparing the training dataset timed out. Nothing was charged; price the run again.');
      } else {
        setOwnError(`${describeEstimateFailure(err)} No Buzz was charged.`);
      }
    }
  }, [
    ownEligibility.ready,
    datasetIdForTraining,
    props.trainerId,
    viewer,
    items,
    manualExclusions,
    effectiveOwnerOverrides,
    prepareDataset,
    preset,
    triggerWord,
    steps,
    epochs,
    samplePrompt,
    estimate,
    requestSignIn,
  ]);

  const onOwnEstimateClick = useCallback(() => {
    if (!viewer) {
      requestSignIn();
      return;
    }
    void doOwnEstimate();
  }, [viewer, requestSignIn, doOwnEstimate]);

  const onOwnRunClick = useCallback(async () => {
    if (!ownBody || !ownQuote || !ownSnapshot || ownPhase !== 'quoted') return;
    if (ownAfford === false) return;
    if (Date.parse(ownQuote.expiresAt) <= Date.now()) {
      setOwnPhase('idle');
      setOwnQuote(null);
      setOwnBody(null);
      setOwnSnapshot(null);
      setOwnError('That own-images quote has expired. Price the run again; no Buzz was charged.');
      return;
    }

    setOwnError(null);
    setOwnPhase('running');
    // Persist the frozen snapshot before Civitai's dialog can charge the
    // viewer. If storage refuses, the run never opens and nothing is charged.
    if (propsRef.current.onSnapshotConfirmed && persistedSnapshotRef.current !== ownSnapshot.snapshotId) {
      try {
        await propsRef.current.onSnapshotConfirmed(ownSnapshot);
        persistedSnapshotRef.current = ownSnapshot.snapshotId;
      } catch {
        setOwnPhase('quoted');
        setOwnError('Could not record the frozen snapshot in Open Datasets, so Civitai\'s training dialog was not opened. No Buzz was charged.');
        return;
      }
    }

    try {
      const started = await runTraining({ ...ownBody, quoteId: ownQuote.quoteId });
      setWorkflowId(started.workflowId);
      setFrozen(ownSnapshot);
      applyTrainingSnapshot(started, ownSnapshot);
      const state = trainingStateForSnapshot(started);
      if (
        started.status === 'succeeded' ||
        started.status === 'failed' ||
        started.status === 'expired' ||
        started.status === 'canceled' ||
        state === 'ready-to-publish' ||
        started.publishedModel
      ) {
        setOwnPhase('idle');
        setPhase('idle');
      } else {
        setOwnPhase('idle');
        setPhase('running');
        runOwnWatch(started.workflowId, ownSnapshot);
      }
    } catch (err) {
      const failure = trainingKindRunFailure(err);
      if (err instanceof RunTrainingError && err.signInRequired) requestSignIn();
      if (failure.kind === 'declined') {
        // The viewer dismissed Civitai's dialog. Keep the still-valid quote
        // on screen so the next step remains obvious, without an error alarm.
        setOwnPhase('quoted');
        setPhase('idle');
        return;
      }
      if (failure.kind === 'sign-in') {
        setOwnPhase('quoted');
        setPhase('idle');
        setOwnError(failure.message);
        return;
      }
      if (failure.kind === 'unconfirmed') {
        setOwnPhase('unconfirmed');
        setPhase('idle');
        setOwnError(failure.message);
        return;
      }
      setOwnPhase('idle');
      setPhase('idle');
      setOwnQuote(null);
      setOwnBody(null);
      setOwnError(failure.message);
    }
  }, [ownBody, ownQuote, ownSnapshot, ownPhase, ownAfford, runTraining, applyTrainingSnapshot, runOwnWatch, requestSignIn]);

  const doEstimate = useCallback(async () => {
    if (trainDisabledReason) return;
    setNotice(null);
    setRunError(null);
    setQuoteError(null);
    setPhase('estimating');
    const snapshot = freezeSnapshot(datasetIdForTraining, props.trainerId ?? viewer?.username ?? 'you', items, {
      manualExclusions,
      ownerOverrides: effectiveOwnerOverrides,
    });
    const dataset = assembleTrainingItems(
      includedItems(snapshot).map((i) => ({ url: i.imageUrl, caption: i.caption })),
    );
    let body: ReturnType<typeof buildTrainingBody>;
    try {
      body = buildTrainingBody(dataset, {
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
        setFrozen(snapshot);
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
        setFrozen(null);
        setPhase('unquoted');
      }
    } catch (err) {
      // Never swallow the estimate error: the viewer (and any upstream
      // report) needs the actual message/code the host failed with.
      setQuote(null);
      setQuoteClass('missing');
      setQuoteError(describeEstimateFailure(err));
      setFrozen(null);
      setPhase('unquoted');
    }
  }, [trainDisabledReason, items, manualExclusions, effectiveOwnerOverrides, viewer, preset, triggerWord, steps, epochs, samplePrompt, estimate, datasetIdForTraining, props.trainerId]);

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
    if (!frozen || quote == null || phase !== 'quoted') return;
    if (afford === false) return; // the confirm card already says why
    const dataset = assembleTrainingItems(
      includedItems(frozen).map((i) => ({ url: i.imageUrl, caption: i.caption })),
    );
    let body: ReturnType<typeof buildTrainingBody>;
    try {
      body = buildTrainingBody(dataset, { preset, triggerWord, steps, epochs, samplePrompt });
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not build the training run.');
      return;
    }
    // The frozen snapshot is the contributors' pay-split contract. Persist it
    // BEFORE the run exists: if community storage refuses, no Buzz moves and
    // the trainer sees exactly why.
    if (propsRef.current.onSnapshotConfirmed && persistedSnapshotRef.current !== frozen.snapshotId) {
      setPhase('submitting');
      try {
        await propsRef.current.onSnapshotConfirmed(frozen);
        persistedSnapshotRef.current = frozen.snapshotId;
      } catch {
        setPhase('quoted');
        setNotice('Could not record the frozen snapshot in Open Datasets, so the training run was not submitted. No Buzz was charged.');
        return;
      }
    }
    setPhase('submitting');
    try {
      const snap = await submit(body);
      setWorkflowId(snap.workflowId);
      applyTrainingSnapshot(snap, frozen);
      if (snap.status === 'pending' || snap.status === 'processing') {
        setPhase('running');
        runPollLoop(snap.workflowId, frozen);
      } else {
        setPhase('idle');
      }
    } catch (err) {
      setPhase('idle');
      setRunState('failed');
      setRunError(err instanceof Error ? err.message : 'Submit failed.');
    }
  }, [frozen, quote, phase, afford, preset, triggerWord, steps, epochs, samplePrompt, submit, applyTrainingSnapshot, runPollLoop]);

  const onPublishClick = useCallback(() => {
    if (!workflowId || epoch == null) return;
    navigate(buildPublishWizardPath(workflowId, epoch), { scope: 'site' });
    setNotice('Finish publishing in Civitai\'s model wizard — come back here and refresh to see the linked LoRA.');
  }, [workflowId, epoch, navigate]);

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

  const credits = useMemo(() => {
    if (!frozen || ledger.length === 0) return [];
    return deriveContributorCredits(ledger[ledger.length - 1]!, frozen);
  }, [frozen, ledger]);

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
        {assembled.skipped.length > 0 && (
          <Alert color="warning" title="Some included items can't be trained on" data-testid="dc-skipped">
            {assembled.skipped.join('; ')}
          </Alert>
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
                if (next) setPreset(next);
              }}
            >
              {TRAINING_PRESETS.map((p) => (
                <option key={p.id} value={p.id} disabled={!p.modelAir || !p.withinCurrentCap}>
                  {p.label} · ~{p.approxBuzz} Buzz
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
              value={steps}
              data-testid="dc-steps"
              onChange={(e) => setSteps(Number(e.target.value) || 0)}
            />
          </label>
          <label style={miniLabelStyle}>
            epochs
            <input
              style={{ ...inputStyle, width: 72 }}
              type="number"
              value={epochs}
              data-testid="dc-epochs"
              onChange={(e) => setEpochs(Number(e.target.value) || 0)}
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

      {/* --- Dedicated training kind: prepare → quote → Civitai consent --- */}
      {viewer && (
        <div style={fieldStyle} data-testid="dc-own-training">
          <span style={fieldLabelStyle}>
            Own-images training{' '}
            <Badge color={ownEligibility.ready ? 'primary' : 'gray'} variant="light">
              {ownEligibility.ready
                ? `${ownEligibility.candidates.length} own image${ownEligibility.candidates.length === 1 ? '' : 's'} ready`
                : `${ownEligibility.blockers.length} blocker${ownEligibility.blockers.length === 1 ? '' : 's'}`}
            </Badge>
          </span>
          <span style={hintStyle}>
            Civitai can train directly from the trainer's own Civitai images. It prepares the
            dataset first, quotes that exact run, then shows its own confirmation dialog before
            charging.
          </span>

          {!ownEligibility.ready && ownEligibility.blockers.length > 0 && (
            <Alert color="warning" title="Own-images training can't cover this snapshot yet" data-testid="dc-own-blocked">
              {ownEligibility.blockers
                .slice(0, 3)
                .map((blocker) => {
                  const item = preview.items.find((candidate) => candidate.itemId === blocker.itemId);
                  return `${item?.caption || blocker.itemId}: ${blocker.reason}`;
                })
                .join('; ')}
              {ownEligibility.blockers.length > 3 ? `; +${ownEligibility.blockers.length - 3} more.` : '.'}
            </Alert>
          )}

          {ownEligibility.ready && ownPhase !== 'quoted' && ownPhase !== 'running' && ownPhase !== 'unconfirmed' && (
            <span>
              <Button
                variant="light"
                size="sm"
                loading={ownPhase === 'preparing'}
                disabled={busy || phase === 'quoted' || !preset.trainingKindModel}
                onClick={onOwnEstimateClick}
                data-testid="dc-own-estimate"
              >
                {ownPhase === 'preparing' ? 'Preparing and pricing…' : 'Price own-images run'}
              </Button>
            </span>
          )}

          {(ownPhase === 'quoted' || ownPhase === 'running') && ownQuote && (
            <div style={confirmStyle} data-testid="dc-own-confirm">
              <span style={fieldLabelStyle}>Confirm own-images training</span>
              <span style={monoStyle} data-testid="dc-own-quote">
                {formatCost(ownQuote.total)} Buzz
              </span>
              <span style={hintStyle}>
                {ownPreparedCount ?? ownQuote.imageCount} prepared image{(ownPreparedCount ?? ownQuote.imageCount) === 1 ? '' : 's'} · snapshot
                weight {ownSnapshot?.totalWeight ?? preview.totalWeight} · {preset.label}. Quote
                expires {new Date(ownQuote.expiresAt).toLocaleString()}. Civitai's dialog is the
                final charge confirmation.
              </span>
              {ownAfford === false ? (
                <Alert color="warning" title="Not enough Buzz" data-testid="dc-own-insufficient">
                  This run is quoted at {formatCost(ownQuote.total)} Buzz and your balance is{' '}
                  {formatCost(balanceTotal)}. Top up and price the run again — nothing was charged.
                </Alert>
              ) : (
                <Button
                  fullWidth
                  loading={ownPhase === 'running'}
                  onClick={() => void onOwnRunClick()}
                  data-testid="dc-own-run"
                >
                  Open Civitai confirmation · {formatCost(ownQuote.total)} Buzz
                </Button>
              )}
            </div>
          )}

          {ownPhase === 'unconfirmed' && (
            <Alert color="error" title="Training submission unconfirmed" data-testid="dc-own-unconfirmed">
              {ownError}
            </Alert>
          )}

          {ownError && ownPhase !== 'unconfirmed' && (
            <Alert color="error" title="Own-images training not started" data-testid="dc-own-error">
              {ownError}
            </Alert>
          )}
        </div>
      )}

      {/* --- Estimate → confirm → submit (spec §7.5 honesty rules) --- */}
      {!viewer ? (
        <Button fullWidth onClick={() => requestSignIn()} data-testid="dc-signin">
          Sign in to train
        </Button>
      ) : phase !== 'quoted' && phase !== 'submitting' && ownPhase !== 'quoted' ? (
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
            {included.length} items · snapshot weight {frozen?.totalWeight ?? preview.totalWeight} ·{' '}
            {preset.label}. This is the trainer fee the snapshot's contributors will be credited
            from (tracked, not paid out).
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

          {ledger.length > 0 && credits.length > 0 && (
            <div style={ledgerStyle} data-testid="dc-ledger">
              <span style={fieldLabelStyle}>Tracked credit from this run</span>
              {credits.map((c) => (
                <div key={c.contributorId} style={ledgerRowStyle} data-testid={`dc-credit-${c.contributorId}`}>
                  <span>{frozen?.items.find((i) => i.contributorId === c.contributorId)?.contributorName ?? c.contributorId}</span>
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
