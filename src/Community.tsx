import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  useBlockContext,
  useBlockToken,
  useBuzzBalance,
  useBuzzWorkflow,
  useCivitaiNavigate,
  useImagePicker,
  useImageUpload,
  useRequestConsent,
  useRequestSignIn,
} from '@civitai/blocks-react';
import { Alert, Badge, Button, Modal, Stack } from '@civitai/blocks-react/ui';
import '@civitai/components/civitai-nav-item/define';
import '@civitai/components/civitai-nav-list/define';
import '@civitai/components/civitai-avatar/define';

import {
  COSMETIC_TRUST_LINE,
  ONSITE_EARNINGS_LINE,
  buildCommunityView,
  buildViewerLedger,
  contributorKey,
  datasetDoc,
  filterAndSortDatasets,
  foldSharedEntries,
  generationLedgerEvent,
  itemDoc,
  ledgerDoc,
  loraDoc,
  makeRecordId,
  nextVoteValue,
  parseImageReference,
  removalDoc,
  snapshotDoc,
  snapshotPersistAction,
  snapshotShareRows,
  trainingItemsForDataset,
  validateContribution,
  validateDatasetInput,
  voteTarget,
  type DatasetItemRecord,
  type DatasetRecord,
  type DatasetView,
  type ExploreSort,
  type FoldedCommunity,
  type LoraRecord,
  type LoraView,
  type VoteValue,
} from './community.js';
import { useCommunityStore, useKvStorage, useStorageReady } from './app-storage.js';
import {
  PUBLISH_SCOPE,
  classifyStorageError,
  createSerialWriteQueue,
  describeStorageError,
  isConsentRefusal,
  loadSharedEntries,
  saveViewerIndex,
  type StorageAccess,
} from './community-storage.js';
import {
  buildWorkflowBody,
  firstImageUrl,
  formatCost,
  hasBudgetedScope,
  pollGenerationToEnd,
  runGenerationToEnd,
  type GenerationPollDeps,
  type GenerationRunOutcome,
} from './generation.js';
import { useItemImages } from './item-images.js';
import { imageRefDisplay } from './civitai-url.js';
import { DEFAULT_CHECKPOINT, loraOption } from './models.js';
import { dataSourceLabel, type DatasetSnapshot, type LedgerEvent } from './training.js';
import { TrainFlow, type TrainRunLink } from './TrainFlow.js';

/**
 * Dataset Commons community screens (spec §6): Explore, Dataset detail,
 * Create/edit, Train entry, LoRA detail, and My contributions & ledger.
 *
 * Votes are option (b) — up/down — carried since 0.2.0 by the document store's
 * per-viewer `up` / `down` MARKS on each dataset and item document (see
 * community.ts). The shared collections are the source of truth; the per-viewer
 * private `kv` copy is only a rebuildable index of "mine".
 */

/**
 * A shared-storage write outcome. `reason` carries the honest failure text
 * (consent never granted, or the host's actual error) so callers with a
 * form-level error line show the real cause instead of a generic fallback.
 */
export type WriteResult = { ok: boolean; reason: string | null };

type Route =
  | { name: 'explore' }
  | { name: 'mine' }
  | { name: 'edit'; datasetId: string }
  | { name: 'dataset'; datasetId: string }
  | { name: 'train'; datasetId: string }
  | { name: 'lora'; loraId: string }
  | { name: 'ledger' };

type LoadState = 'loading' | StorageAccess;

const EVENT_LABEL: Record<LedgerEvent['eventType'], string> = {
  training: 'Trainer fee',
  generation_in_app: 'In-app generation',
  generation_onsite: 'Onsite generation',
};

/** A ledger row reads as trainer-attested when its event says so, or its LoRA does. */
function ledgerRowSourceLabel(event: LedgerEvent, lora?: LoraRecord): string | null {
  return dataSourceLabel(event) ?? (lora ? dataSourceLabel(lora) : null);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export function Community() {
  const { viewer } = useBlockContext();
  const token = useBlockToken();
  const store = useCommunityStore();
  const appStorage = useKvStorage();
  const storageReady = useStorageReady();
  const { requestConsent } = useRequestConsent();
  const { requestSignIn } = useRequestSignIn();

  const [route, setRoute] = useState<Route>({ name: 'explore' });
  // The folded community, computed ONCE per load inside refresh() (never
  // re-folded on render).
  const [folded, setFolded] = useState<FoldedCommunity>(() => foldSharedEntries([]));
  const [loadState, setLoadState] = useState<LoadState>('loading');
  // The last applied load stopped at the page cap in some collection: what is
  // shown is a partial list, and the screen says so.
  const [truncated, setTruncated] = useState(false);
  // The newest refresh failed after an earlier load succeeded: the last good
  // data stays on screen (and in foldedRef, so queued votes still work), with
  // a notice and a Retry instead of the failure view.
  const [staleAfterFailure, setStaleAfterFailure] = useState(false);
  // The same, readable at write time. The kept fold may predate a write that
  // just landed, so a vote computed from it could re-mark a document: votes
  // refuse until a refresh succeeds again.
  const staleAfterFailureRef = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeDetail, setNoticeDetail] = useState<string | null>(null);
  const [failedRetry, setFailedRetry] = useState<{ run: () => Promise<WriteResult> } | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ExploreSort>('top-voted');
  const [sortOpen, setSortOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [trainableOnly, setTrainableOnly] = useState(false);
  const [viewerIndexAccess, setViewerIndexAccess] = useState<StorageAccess>('ready');

  const storeRef = useRef(store);
  storeRef.current = store;
  // The block token as held NOW: a consent grant re-mints it (see ensurePublishConsent).
  const tokenRawRef = useRef(token.raw);
  tokenRawRef.current = token.raw;
  // The fold as of the newest APPLIED refresh, written by refresh() itself
  // (its only writer) the moment the entries load — before React re-renders —
  // so a write queued behind another (castVote) reads what that write landed.
  const foldedRef = useRef<FoldedCommunity | null>(null);
  // refresh() calls are not serialized (the token effect and the Retry /
  // Enable buttons call it outside the write queue), so they can resolve out
  // of order. Each takes a sequence number when it STARTS. A successful read
  // is applied unless a later-started SUCCESS already was; a failed read is
  // applied only if nothing later-started has been applied at all. So an
  // older read never overwrites a newer one, and a newer failure never hides
  // a good read that arrives after it.
  const refreshStartedRef = useRef(0);
  const refreshAppliedRef = useRef(0);
  const refreshSucceededRef = useRef(0);
  // One shared-storage write at a time (see createSerialWriteQueue): the
  // walker's contribute -> vote -> vote cadence must not overlap mutations.
  const writeQueueRef = useRef(createSerialWriteQueue());

  const viewerId = viewer?.id ?? null;
  const viewerName = viewer?.username ?? 'you';

  const refresh = useCallback(async (): Promise<void> => {
    const seq = ++refreshStartedRef.current;
    const result = await loadSharedEntries(storeRef.current);
    if (result.access === 'ready') {
      // A later-started read already landed good data: this one is older.
      if (seq < refreshSucceededRef.current) return;
      refreshSucceededRef.current = seq;
    } else if (seq < refreshAppliedRef.current || seq < refreshSucceededRef.current) {
      // An older failure never replaces a newer result.
      return;
    }
    refreshAppliedRef.current = Math.max(refreshAppliedRef.current, seq);
    if (result.access === 'failed' && refreshSucceededRef.current > 0) {
      // A transient read failure after a good load keeps the last good data.
      // (A 'not-permitted' answer is not transient: it still switches views.)
      staleAfterFailureRef.current = true;
      setStaleAfterFailure(true);
      return;
    }
    staleAfterFailureRef.current = false;
    setStaleAfterFailure(false);
    setTruncated(result.access === 'ready' && result.truncated);
    // Update the fold ref NOW, not on the next render: the serial write queue
    // starts the next queued write as soon as this refresh resolves, before
    // React re-renders, and castVote computes its `from` vote from this ref.
    // A stale ref there double-marked a document on a second quick vote.
    const next = foldSharedEntries(result.entries);
    foldedRef.current = next;
    setFolded(next);
    setLoadState(result.access);
  }, []);

  useEffect(() => {
    // Nothing can reach the store before the host has sent its origin + token.
    if (!storageReady) return;
    void refresh();
  }, [refresh, storageReady, token.scopes]);

  const view = useMemo(() => buildCommunityView(folded), [folded]);
  const viewerLedger = useMemo(
    () => buildViewerLedger(folded, viewerId, viewerName),
    [folded, viewerId, viewerName],
  );

  // Per-viewer index is a cache of the shared fold, never the source of truth.
  const indexJsonRef = useRef('');
  useEffect(() => {
    if (viewerId == null || loadState !== 'ready') return;
    const index = {
      itemIds: folded.items
        .filter((i) => i.contributorId === viewerId && !folded.removals.some((r) => r.itemId === i.itemId))
        .map((i) => i.itemId),
      voteTargets: folded.votes
        .filter((v) => v.viewerVote !== 0)
        .map((v) => `${v.targetKind}:${v.targetId}`),
      snapshotIds: viewerLedger.snapshotsIn.map((s) => s.snapshotId),
    };
    // Compare the CONTENT (and whose index it is) only: a timestamp inside the
    // compared string would differ on every run, so the guard would never skip
    // an unchanged write.
    const json = JSON.stringify({ viewerId, ...index });
    if (indexJsonRef.current === json) return;
    indexJsonRef.current = json;
    void saveViewerIndex(appStorage, viewerId, { ...index, updatedAt: new Date().toISOString() }).then(
      setViewerIndexAccess,
    );
  }, [appStorage, folded, loadState, viewerId, viewerLedger]);

  const requireViewer = useCallback((): boolean => {
    if (viewerId != null) return true;
    requestSignIn();
    return false;
  }, [requestSignIn, viewerId]);

  const writeFailed = useCallback(
    (error: unknown, busy: string | null, partial = false) => {
      if (busy) setBusyKey((cur) => (cur === busy ? null : cur));
      const access = classifyStorageError(error);
      if (access === 'not-permitted') {
        setNoticeDetail(null);
        setFailedRetry(null);
        setNotice(
          partial
            ? 'That stopped partway: some of it was saved, and community storage access is not granted for the rest. Confirm it in the Civitai dialog, then try again to finish.'
            : 'Community storage access is not granted yet. Confirm it in the Civitai dialog, then try again.',
        );
        if (isConsentRefusal(error)) requestConsent({ scopes: [PUBLISH_SCOPE] });
      } else {
        // Surface the store's actual error (walks report it verbatim) and
        // keep the failed write one tap away — never a silent dead banner.
        setNoticeDetail(describeStorageError(error));
        setNotice(
          partial
            ? 'That stopped partway: some of it was saved before the error. Try again to finish it — the steps already done are skipped.'
            : 'That did not save. Nothing was written — try again in a moment.',
        );
      }
    },
    [requestConsent],
  );

  /**
   * Ask the host for `apps:storage:publish` (creating or editing a shared
   * document needs it; it is consent-gated), then wait for the grant to land.
   *
   * 🔴 IT WAITS FOR THE TOKEN TO BE RE-MINTED, NOT FOR A SCOPE NAME TO APPEAR.
   * The host answers a grant with a fresh token (TOKEN_REFRESH); whether the
   * grant covered publishing is the STORE's answer, so the caller retries the
   * write once and a second `consent_required` is a real refusal. (The bridge
   * SDK this app pins predates the document-store scope names, so a check on
   * `token.scopes` could never see the grant.) Resolves false after the
   * timeout (dialog dismissed or refused — the save stays unwritten).
   */
  const ensurePublishConsent = useCallback(async (): Promise<boolean> => {
    const before = tokenRawRef.current;
    requestConsent({ scopes: [PUBLISH_SCOPE] });
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (tokenRawRef.current !== before) return true;
    }
    return tokenRawRef.current !== before;
  }, [requestConsent]);

  /** Run a shared write; a `consent_required` refusal asks, waits for the grant, and retries ONCE. */
  const withPublishConsent = useCallback(
    async (fn: () => Promise<void>, onAsk?: () => void): Promise<void> => {
      try {
        await fn();
      } catch (error) {
        if (!isConsentRefusal(error)) throw error;
        onAsk?.();
        if (!(await ensurePublishConsent())) throw error;
        await fn();
      }
    },
    [ensurePublishConsent],
  );

  /**
   * Run one shared-storage write with sign-in/consent gates and honest failure
   * copy. A multi-step write passes `landed`, which says whether any of its
   * steps reached the store, so a failure partway is never reported as
   * "nothing was written".
   */
  const runWrite = useCallback(
    async (
      busy: string,
      fn: () => Promise<void>,
      successNote?: string,
      landed?: () => boolean,
    ): Promise<WriteResult> => {
      if (!requireViewer()) return { ok: false, reason: 'Sign in to save.' };
      // Serialized: this write (and its refresh) finishes before the next
      // one starts, so rapid contribute/vote sequences can't overlap store
      // mutations or fold a read taken before the previous write landed.
      return writeQueueRef.current.run(async (): Promise<WriteResult> => {
        setBusyKey(busy);
        setNotice(null);
        setNoticeDetail(null);
        setFailedRetry(null);
        try {
          // A refused publish prompts, waits for the grant and retries the SAME
          // write once — the viewer never has to click Save twice.
          await withPublishConsent(fn, () =>
            setNotice('Confirm community publishing in the Civitai dialog — this save will continue automatically.'),
          );
          await refresh();
          setBusyKey((cur) => (cur === busy ? null : cur));
          if (successNote) setNotice(successNote);
          return { ok: true, reason: null };
        } catch (error) {
          writeFailed(error, busy, landed?.() ?? false);
          // The retry re-runs this same write (a multi-step write's steps are
          // idempotent across re-runs; see deleteDataset).
          setFailedRetry({ run: () => runWrite(busy, fn, successNote, landed) });
          return { ok: false, reason: describeStorageError(error) };
        }
      });
    },
    [refresh, requireViewer, withPublishConsent, writeFailed],
  );

  // ------------------------------------------------------------- writes

  const createDataset = useCallback(
    async (input: { name: string; description: string; targetNote: string }): Promise<string | null> => {
      const checked = validateDatasetInput(input);
      if (!checked.ok) return checked.error;
      if (viewerId == null) {
        requestSignIn();
        return 'Sign in to create a dataset.';
      }
      const now = new Date().toISOString();
      const record: DatasetRecord = {
        datasetId: makeRecordId('dataset'),
        ownerId: viewerId,
        ownerName: viewerName,
        name: checked.value.name,
        description: checked.value.description,
        targetNote: checked.value.targetNote,
        createdAt: now,
        updatedAt: now,
      };
      const result = await runWrite('create-dataset', async () => {
        await storeRef.current.create('datasets', datasetDoc(record));
      });
      if (!result.ok) return result.reason ?? 'That did not save — try again in a moment.';
      setRoute({ name: 'dataset', datasetId: record.datasetId });
      return null;
    },
    [requestSignIn, runWrite, viewerId, viewerName],
  );

  // Creating skips the form entirely: one tap makes a dataset with a
  // generated name and lands on its page, where the owner renames it via
  // the edit icon next to the name. A failed save surfaces as a notice.
  const createDatasetNow = useCallback(() => {
    if (viewerId == null) {
      requestSignIn();
      return;
    }
    void createDataset({ name: generateDatasetName(), description: '', targetNote: '' }).then(
      (error) => {
        if (error) setNotice(error);
      },
    );
  }, [createDataset, requestSignIn, viewerId]);

  const updateDataset = useCallback(
    async (
      datasetId: string,
      input: { name: string; description: string; targetNote: string },
    ): Promise<string | null> => {
      const checked = validateDatasetInput(input);
      if (!checked.ok) return checked.error;
      const existing = folded.datasets.find((d) => d.datasetId === datasetId);
      if (!existing || viewerId == null) return 'That dataset is no longer available.';
      if (existing.ownerId !== viewerId) return 'Only the dataset owner can edit it.';
      const record: DatasetRecord = {
        ...existing,
        name: checked.value.name,
        description: checked.value.description,
        targetNote: checked.value.targetNote,
        updatedAt: new Date().toISOString(),
      };
      const result = await runWrite('edit-dataset', async () => {
        // In place, at the dataset's own document (`own`: only its author may).
        if (!existing.storageKey) throw new Error('dataset record has no storage key to update');
        await storeRef.current.put('datasets', existing.storageKey, datasetDoc(record));
      });
      if (!result.ok) return result.reason ?? 'That did not save — try again in a moment.';
      setRoute({ name: 'dataset', datasetId });
      return null;
    },
    [folded.datasets, runWrite, viewerId],
  );

  const deleteDataset = useCallback(
    async (datasetId: string): Promise<boolean> => {
      const existing = folded.datasets.find((d) => d.datasetId === datasetId);
      if (!existing || viewerId == null) return false;
      if (existing.ownerId !== viewerId) {
        setNotice('Only the dataset owner can delete it.');
        return false;
      }
      // Each run re-reads the current shared state (below), and a remove the
      // store answers `deleted: false` ("nothing was there") is the goal
      // reached, so a delete that stopped partway can be finished, not wedged.
      // `done` additionally remembers this delete's own landed steps: the
      // `landed` probe for honest failure copy, and a skip for a retry that
      // runs before a landed write is visible in the read.
      const done = new Set<string>();
      const step = async (key: string, write: () => Promise<void>) => {
        if (done.has(key)) return;
        await write();
        done.add(key);
      };
      const removeOwn = async (collection: 'items' | 'loras' | 'datasets', storageKey: string) => {
        // `deleted: false` means the document is already gone, which is the goal.
        await storeRef.current.remove(collection, storageKey);
      };
      const result = await runWrite(
        `delete-dataset-${datasetId}`,
        async () => {
          // Read the CURRENT shared state on every run — the first attempt, the
          // consent retry, the banner's Retry, or a fresh Delete after a delete
          // that stopped partway — so what already landed is seen and skipped.
          const loaded = await loadSharedEntries(storeRef.current);
          if (loaded.access !== 'ready') throw new Error('the shared dataset list could not be read');
          const current = foldSharedEntries(loaded.entries);
          const datasetItems = current.items.filter((item) => item.datasetId === datasetId);
          // Remove the dataset's visible contents first. The owner's own
          // entries are withdrawn; another contributor's item gets the same
          // removal record the detail screen writes, so the fold hides it.
          for (const item of datasetItems) {
            if (current.removals.some((r) => r.itemId === item.itemId)) continue;
            if (item.contributorId === viewerId && item.storageKey) {
              const storageKey = item.storageKey;
              await step(`item:${item.itemId}`, () => removeOwn('items', storageKey));
            } else {
              await step(`removal:${item.itemId}`, async () => {
                await storeRef.current.create(
                  'removals',
                  removalDoc({
                    itemId: item.itemId,
                    datasetId,
                    actorId: viewerId,
                    reason: 'owner-remove',
                    createdAt: new Date().toISOString(),
                  }),
                );
              });
            }
          }
          // Votes are marks ON the documents: a deleted document takes them with
          // it, and a removed item no longer folds, so there is nothing to withdraw.
          // Frozen snapshots are KEPT: they are every credited contributor's
          // record ("Snapshots I'm in", tracked credit), and deleting the dataset
          // must not rewrite other accounts' history. Only the viewer's OWN LoRA
          // links are withdrawn — the store refuses anyone else's (`write: own`).
          for (const lora of current.loras.filter((l) => l.datasetId === datasetId && l.trainerId === viewerId)) {
            const storageKey = lora.storageKey;
            if (storageKey) await step(`lora:${lora.loraId}`, () => removeOwn('loras', storageKey));
          }
          const record = current.datasets.find((d) => d.datasetId === datasetId);
          // Gone already (an earlier attempt removed it): the delete is done.
          if (record?.storageKey) {
            const datasetKey = record.storageKey;
            await step('dataset', () => removeOwn('datasets', datasetKey));
          }
          setRoute({ name: 'explore' });
        },
        'Dataset deleted.',
        () => done.size > 0,
      );
      return result.ok;
    },
    [folded, runWrite, viewerId],
  );

  const castVote = useCallback(
    async (targetKind: 'dataset' | 'item', targetId: string, clicked: 1 | -1) => {
      if (!requireViewer() || viewerId == null) return;
      await runWrite(`vote-${targetKind}-${targetId}`, async () => {
        // Computed at execution time (writes are serialized): the current vote
        // is whatever the previous write landed, never the render that
        // scheduled this one. A vote is the viewer's `up`/`down` MARK on the
        // target's own document — marks need no publish consent.
        if (staleAfterFailureRef.current) {
          throw new Error('the community list could not be refreshed, so your current vote is unknown — use Retry, then vote again');
        }
        const target = voteTarget(foldedRef.current?.votes ?? [], targetKind, targetId);
        if (!target) throw new Error(`that ${targetKind} is no longer available`);
        await storeRef.current.setVote(
          targetKind === 'dataset' ? 'datasets' : 'items',
          target.storageKey,
          target.viewerVote,
          nextVoteValue(target.viewerVote, clicked),
        );
      });
    },
    [requireViewer, runWrite, viewerId],
  );

  const contributeItem = useCallback(
    async (
      datasetId: string,
      input: { imageRef: string; imageId?: number; caption: string },
    ): Promise<string | null> => {
      if (viewerId == null) {
        requestSignIn();
        return 'Sign in to contribute.';
      }
      const checked = validateContribution({ ...input, rightsAsserted: true });
      if (!checked.ok) return checked.error;
      const now = new Date().toISOString();
      const record: DatasetItemRecord = {
        itemId: makeRecordId('item'),
        datasetId,
        contributorId: viewerId,
        contributorName: viewerName,
        ...(checked.value.imageId != null ? { imageId: checked.value.imageId } : {}),
        imageRef: checked.value.imageRef,
        caption: checked.value.caption,
        rightsAsserted: true,
        createdAt: now,
        updatedAt: now,
      };
      const result = await runWrite('contribute', async () => {
        await storeRef.current.create('items', itemDoc(record));
      }, 'Item contributed. It joins the training set once its net votes are positive.');
      return result.ok ? null : (result.reason ?? 'That did not save — try again in a moment.');
    },
    [requestSignIn, runWrite, viewerId, viewerName],
  );

  const removeItem = useCallback(
    async (dataset: DatasetView, item: DatasetView['items'][number]) => {
      if (viewerId == null) {
        requestSignIn();
        return;
      }
      const isOwner = dataset.ownerId === viewerId;
      const isContributor = item.contributorId === viewerId;
      if (!isOwner && !isContributor) return;
      if (isContributor && !isOwner && item.snapshotAppearances > 0) {
        setNotice('This item is already frozen into a snapshot, so it can no longer be withdrawn.');
        return;
      }
      await runWrite(`remove-${item.itemId}`, async () => {
        // A contributor can withdraw their own shared entry outright; an owner
        // removing someone else's item records a removal the fold applies.
        if (isContributor && item.storageKey) {
          const res = await storeRef.current.remove('items', item.storageKey);
          if (res.deleted) return;
        }
        await storeRef.current.create(
          'removals',
          removalDoc({
            itemId: item.itemId,
            datasetId: dataset.datasetId,
            actorId: viewerId,
            reason: isOwner && !isContributor ? 'owner-remove' : 'contributor-withdraw',
            createdAt: new Date().toISOString(),
          }),
        );
      }, isOwner && !isContributor ? 'Item removed from the dataset.' : 'Item withdrawn.');
    },
    [requestSignIn, runWrite, viewerId],
  );

  // ------------------------------------------- Train / LoRA persistence

  const persistSnapshot = useCallback(
    async (snapshot: DatasetSnapshot) => {
      // A re-click on the same frozen snapshot is idempotent; a stored snapshot
      // that merely shares the id is never adopted (its contributors would be
      // credited this run's fee), so the run is refused before any Buzz moves.
      const action = snapshotPersistAction(folded.snapshots, snapshot);
      if (action === 'already-stored') return;
      if (action === 'conflict') throw new Error('a different snapshot is already stored under this id');
      // Persisted BEFORE the run is charged (TrainFlow): a refusal here means no
      // Buzz moves. The first shared write a trainer makes may need the publish
      // grant, so it asks, waits and retries once like every other save.
      await withPublishConsent(async () => {
        await storeRef.current.create('snapshots', snapshotDoc(snapshot));
      });
      await refresh();
    },
    [folded.snapshots, refresh, withPublishConsent],
  );

  const persistLedgerEvent = useCallback(
    async (event: LedgerEvent) => {
      if (
        folded.ledgerEvents.some(
          (e) => e.sourceRef === event.sourceRef && e.eventType === event.eventType && e.loraId === event.loraId,
        )
      ) {
        return;
      }
      await withPublishConsent(async () => {
        await storeRef.current.create('ledger', ledgerDoc(event));
      });
      await refresh();
    },
    [folded.ledgerEvents, refresh, withPublishConsent],
  );

  const persistRunLink = useCallback(
    async (link: TrainRunLink) => {
      const snapshot = link.snapshot;
      if (!snapshot || viewerId == null) return;
      const existing = folded.loras.find((l) => l.workflowId === link.workflowId);
      const now = new Date().toISOString();
      const record: LoraRecord = existing ?? {
        loraId: `lora_${link.workflowId}`,
        datasetId: snapshot.datasetId,
        snapshotId: snapshot.snapshotId,
        trainerId: viewerId,
        trainerName: viewerName,
        name: `${folded.datasets.find((d) => d.datasetId === snapshot.datasetId)?.name ?? 'Dataset'} LoRA`,
        workflowId: link.workflowId,
        published: false,
        createdAt: now,
        updatedAt: now,
      };
      const next: LoraRecord = {
        ...record,
        snapshotId: snapshot.snapshotId,
        // One workflow is one run on one path, so the link's source is the record's.
        dataSource: link.dataSource,
        ...(link.publishedModel
          ? {
              modelId: link.publishedModel.modelId,
              modelVersionId: link.publishedModel.modelVersionId,
              published: link.publishedModel.published,
            }
          : {}),
        updatedAt: now,
      };
      await withPublishConsent(async () => {
        if (existing?.storageKey) await storeRef.current.put('loras', existing.storageKey, loraDoc(next));
        else if (!existing) await storeRef.current.create('loras', loraDoc(next));
      });
      await refresh();
    },
    [folded.datasets, folded.loras, refresh, viewerId, viewerName, withPublishConsent],
  );

  /** Workflows already recorded as some LoRA: "Find my run" must never re-link one. */
  const linkedWorkflowIds = useMemo(
    () => new Set(folded.loras.flatMap((l) => (l.workflowId ? [l.workflowId] : []))),
    [folded.loras],
  );

  // ------------------------------------------------------------- routing

  const selectedDataset =
    route.name === 'dataset' || route.name === 'train' || route.name === 'edit'
      ? view.datasets.find((d) => d.datasetId === route.datasetId)
      : undefined;
  const selectedLora = route.name === 'lora' ? view.loras.find((l) => l.loraId === route.loraId) : undefined;
  const explored = useMemo(() => {
    const pool =
      route.name === 'mine' && viewerId != null
        ? view.datasets.filter((d) => d.ownerId === viewerId)
        : view.datasets;
    const filtered = trainableOnly ? pool.filter((d) => d.trainableCount > 0) : pool;
    return filterAndSortDatasets(filtered, { query, sort });
  }, [query, sort, trainableOnly, view.datasets, route.name, viewerId]);

  return (
    <div data-testid="dc-community" data-theme="dark" data-dc-archive="true" style={rootStyle}>
      <div className="od-layout">
        <aside className="od-sidebar" data-testid="dc-sidebar">
          {route.name === 'explore' && <div style={titleStyle}>Open Datasets</div>}
          <input
            style={inputStyle}
            value={query}
            placeholder="Search datasets…"
            onChange={(e) => {
              setQuery(e.target.value);
              if (route.name !== 'explore' && route.name !== 'mine') setRoute({ name: 'explore' });
            }}
            data-testid="dc-sidebar-search"
          />
          <civitai-nav-list label="Open Datasets sections">
            <civitai-nav-item
              label="Explore"
              href="#/explore"
              current={route.name === 'explore'}
              onClick={(e) => {
                e.preventDefault();
                setRoute({ name: 'explore' });
              }}
              data-testid="dc-nav-explore"
            />
            <civitai-nav-item
              label="My datasets"
              href="#/mine"
              current={route.name === 'mine'}
              onClick={(e) => {
                e.preventDefault();
                if (viewerId == null) requestSignIn();
                else setRoute({ name: 'mine' });
              }}
              data-testid="dc-nav-mine"
            />
            <civitai-nav-item
              label="Create dataset"
              href="#/create"
              onClick={(e) => {
                e.preventDefault();
                createDatasetNow();
              }}
              data-testid="dc-nav-create"
            />
            <civitai-nav-item
              label="My contributions"
              href="#/contributions"
              current={route.name === 'ledger'}
              onClick={(e) => {
                e.preventDefault();
                setRoute({ name: 'ledger' });
              }}
              data-testid="dc-nav-ledger"
            />
          </civitai-nav-list>
        </aside>
        <div className="od-main">
      <Stack gap={16}>
        <div style={headerStyle} className="od-narrow-header">
          <Button
            variant="subtle"
            size="sm"
            onClick={() => setDrawerOpen(true)}
            data-testid="dc-nav-open"
            aria-label="Open navigation"
            style={{ minWidth: 44, minHeight: 44, fontSize: 18 }}
          >
            ☰
          </Button>
          {route.name === 'explore' && (
            <div>
              <div style={titleStyle}>Open Datasets</div>
              <span style={hintStyle}>
                Assemble datasets together, vote items in, train LoRAs, and track contributor shares.
              </span>
            </div>
          )}
        </div>

        {notice && (
          <Alert
            color="info"
            withCloseButton
            onClose={() => {
              setNotice(null);
              setNoticeDetail(null);
              setFailedRetry(null);
            }}
            data-testid="dc-community-notice"
          >
            {notice}
            {noticeDetail && (
              <span style={monoStyle} data-testid="dc-community-notice-detail">
                {' '}
                Details: {noticeDetail}
              </span>
            )}
            {failedRetry && (
              <>
                {' '}
                <Button
                  size="sm"
                  variant="light"
                  onClick={() => void failedRetry.run()}
                  data-testid="dc-community-notice-retry"
                >
                  Retry save
                </Button>
              </>
            )}
          </Alert>
        )}

        {loadState === 'ready' && staleAfterFailure && (
          <Alert color="warning" title="Couldn't refresh the community" data-testid="dc-community-stale">
            The latest read of the shared dataset list failed, so this shows the last list that loaded. Voting
            waits until it refreshes.{' '}
            <Button size="sm" variant="light" onClick={() => void refresh()} data-testid="dc-community-stale-retry">
              Retry
            </Button>
          </Alert>
        )}
        {loadState === 'ready' && truncated && (
          <Alert color="warning" title="Partial list" data-testid="dc-community-partial">
            The community has more entries than this app reads at once, so some datasets, items or votes may be
            missing from what is shown.
          </Alert>
        )}

        {loadState === 'loading' && (
          <span style={hintStyle} data-testid="dc-community-loading">
            Loading community datasets…
          </span>
        )}

        {loadState === 'not-permitted' && (
          <Alert color="warning" title="Community storage isn't available yet" data-testid="dc-community-unavailable">
            Open Datasets reads datasets, votes, and tracked credit from shared community storage, and this
            session doesn't have that access yet — so instead of showing an empty community, it shows this.{' '}
            {viewerId == null ? (
              <Button size="sm" onClick={() => requestSignIn()} data-testid="dc-community-signin">
                Sign in
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => {
                  requestConsent({ scopes: [PUBLISH_SCOPE] });
                  void refresh();
                }}
                data-testid="dc-community-enable"
              >
                Enable community storage
              </Button>
            )}
          </Alert>
        )}

        {loadState === 'failed' && (
          <Alert color="error" title="Community data didn't load" data-testid="dc-community-failed">
            The shared dataset list couldn't be read just now. Nothing was written.{' '}
            <Button size="sm" variant="light" onClick={() => void refresh()} data-testid="dc-community-retry">
              Retry
            </Button>
          </Alert>
        )}

        {loadState === 'ready' && (route.name === 'explore' || route.name === 'mine') && (
          <Stack gap={12}>
            <div style={toolbarStyle}>
              <span className="od-hide-desktop">
                <input
                  style={inputStyle}
                  value={query}
                  placeholder="Search datasets…"
                  onChange={(e) => setQuery(e.target.value)}
                  data-testid="dc-explore-search"
                />
              </span>
              <span style={{ position: 'relative', display: 'inline-flex' }}>
                <Button
                  size="sm"
                  variant="light"
                  onClick={() => setSortOpen((o) => !o)}
                  data-testid="dc-explore-sort"
                  aria-label="Sort and filter datasets"
                  aria-haspopup="menu"
                  aria-expanded={sortOpen}
                  style={{ minWidth: 44, minHeight: 44, fontSize: 17 }}
                >
                  ⇅
                </Button>
                {sortOpen && (
                  <>
                    <div
                      className="od-menu-backdrop"
                      onClick={() => setSortOpen(false)}
                      data-testid="dc-sort-backdrop"
                    />
                    <div style={{ ...menuStyle, left: 0, right: 'auto' }} role="menu" data-testid="dc-sort-menu">
                      <span style={menuLabelStyle}>Sort by</span>
                      {(
                        [
                          ['top-voted', 'Top voted'],
                          ['newest', 'Newest'],
                          ['most-trained', 'Most trained'],
                        ] as Array<[ExploreSort, string]>
                      ).map(([value, label]) => (
                        <Button
                          key={value}
                          variant="subtle"
                          style={menuItemStyle}
                          onClick={() => {
                            setSort(value);
                            setSortOpen(false);
                          }}
                          data-testid={`dc-sort-${value}`}
                        >
                          {sort === value ? '✓ ' : ''}
                          {label}
                        </Button>
                      ))}
                      <span style={menuLabelStyle}>Filter</span>
                      <Button
                        variant="subtle"
                        style={menuItemStyle}
                        onClick={() => setTrainableOnly((t) => !t)}
                        data-testid="dc-filter-trainable"
                      >
                        {trainableOnly ? '✓ ' : ''}Trainable only
                      </Button>
                    </div>
                  </>
                )}
              </span>
              <span className="od-hide-desktop">
                <Button
                  onClick={() => createDatasetNow()}
                  data-testid="dc-create-dataset"
                >
                  Create dataset
                </Button>
              </span>
            </div>

            {explored.length === 0 ? (
              <div style={cardStyle} data-testid="dc-explore-empty">
                <span style={cardTitleStyle}>{route.name === 'mine' ? 'No datasets of yours yet' : 'No datasets yet'}</span>
                <span style={hintStyle}>
                  {route.name === 'mine'
                    ? 'You have not created a dataset yet — tap Create dataset to start one.'
                    : view.datasets.length === 0
                      ? 'Be the first: tap Create dataset, contribute images, and let the community vote the training set in.'
                      : 'Nothing matches that search. Try a different term, or create the dataset yourself.'}
                </span>
              </div>
            ) : (
              <div className="od-grid-cards">
              {explored.map((dataset) => {
                const liveCount = dataset.items.filter((i) => !i.removed).length;
                const cardMeta = [
                  ...(liveCount > 0 ? [`${liveCount} item${liveCount === 1 ? '' : 's'}`] : []),
                  ...(dataset.trainableCount > 0 ? [`${dataset.trainableCount} trainable`] : []),
                  ...(dataset.loraCount > 0
                    ? [`${dataset.loraCount} trained LoRA${dataset.loraCount === 1 ? '' : 's'}`]
                    : []),
                ];
                return (
                <div key={dataset.datasetId} style={{ ...cardStyle, cursor: 'pointer' }} data-testid="dc-dataset-card" onClick={() => setRoute({ name: 'dataset', datasetId: dataset.datasetId })}>
                  <div style={itemHeadStyle}>
                    <span style={cardTitleStyle}>{dataset.name}</span>
                    {dataset.netVotes !== 0 && (
                      <Badge color="info" variant="light">{dataset.netVotes} net votes</Badge>
                    )}
                  </div>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <AuthorByline name={dataset.ownerName} />
                    {cardMeta.length > 0 && <span style={hintStyle}>{cardMeta.join(' · ')}</span>}
                  </span>
                  {dataset.description && <span>{dataset.description}</span>}
                  <span>
                    <Button
                      size="sm"
                      onClick={() => setRoute({ name: 'dataset', datasetId: dataset.datasetId })}
                      data-testid={`dc-open-dataset-${dataset.datasetId}`}
                    >
                      Open dataset
                    </Button>
                  </span>
                </div>
                );
              })}
              </div>
            )}
            <span style={hintStyle}>{COSMETIC_TRUST_LINE}</span>
          </Stack>
        )}

        {loadState === 'ready' && route.name === 'edit' && selectedDataset && (
          <DatasetForm
            key={selectedDataset.datasetId}
            title={`Edit ${selectedDataset.name}`}
            submitLabel="Save changes"
            initial={selectedDataset}
            onCancel={() => setRoute({ name: 'dataset', datasetId: selectedDataset.datasetId })}
            onSubmit={(input) => updateDataset(selectedDataset.datasetId, input)}
          />
        )}

        {loadState === 'ready' && (route.name === 'dataset' || route.name === 'edit') && !selectedDataset && (
          <Alert color="warning" title="Dataset not found" data-testid="dc-dataset-missing">
            That dataset isn't in the community records anymore.{' '}
            <Button size="sm" variant="light" onClick={() => setRoute({ name: 'explore' })}>
              Back to Explore
            </Button>
          </Alert>
        )}

        {loadState === 'ready' && route.name === 'dataset' && selectedDataset && (
          <DatasetDetail
            key={selectedDataset.datasetId}
            dataset={selectedDataset}
            loras={view.loras.filter((l) => l.datasetId === selectedDataset.datasetId)}
            viewerId={viewerId}
            busyKey={busyKey}
            onEdit={() => setRoute({ name: 'edit', datasetId: selectedDataset.datasetId })}
            onDelete={() => void deleteDataset(selectedDataset.datasetId)}
            onTrain={() => setRoute({ name: 'train', datasetId: selectedDataset.datasetId })}
            onOpenLora={(loraId) => setRoute({ name: 'lora', loraId })}
            onVote={(kind, id, value) => void castVote(kind, id, value)}
            onSignIn={() => requestSignIn()}
            onContribute={(input) => contributeItem(selectedDataset.datasetId, input)}
            onRemove={(item) => void removeItem(selectedDataset, item)}
          />
        )}

        {loadState === 'ready' && route.name === 'train' && selectedDataset && (
          <Stack gap={12}>
            <span>
              <Button
                variant="subtle"
                size="sm"
                onClick={() => setRoute({ name: 'dataset', datasetId: selectedDataset.datasetId })}
                data-testid="dc-back-dataset"
              >
                ← Back to {selectedDataset.name}
              </Button>
            </span>
            <TrainFlow
              key={selectedDataset.datasetId}
              initialItems={trainingItemsForDataset(selectedDataset)}
              datasetId={selectedDataset.datasetId}
              trainerId={viewerId != null ? contributorKey(viewerId) : viewerName}
              lockItemMetadata
              canOwnerOverride={viewerId != null && selectedDataset.ownerId === viewerId}
              allowLocalUploads={false}
              onSnapshotConfirmed={persistSnapshot}
              onLedgerEvent={persistLedgerEvent}
              onRunLinked={persistRunLink}
              linkedWorkflowIds={linkedWorkflowIds}
            />
          </Stack>
        )}

        {loadState === 'ready' && route.name === 'lora' && selectedLora && (
          <LoraDetail
            lora={selectedLora}
            onBack={() =>
              setRoute(
                selectedLora.dataset
                  ? { name: 'dataset', datasetId: selectedLora.dataset.datasetId }
                  : { name: 'explore' },
              )
            }
            onLedgerEvent={persistLedgerEvent}
            onNotice={setNotice}
          />
        )}

        {loadState === 'ready' && route.name === 'lora' && !selectedLora && (
          <Alert color="warning" title="LoRA not found" data-testid="dc-lora-missing">
            That LoRA isn't in the community records anymore.{' '}
            <Button size="sm" variant="light" onClick={() => setRoute({ name: 'explore' })}>
              Back to Explore
            </Button>
          </Alert>
        )}

        {loadState === 'ready' && route.name === 'ledger' && (
          <LedgerView
            folded={folded}
            view={view}
            viewerId={viewerId}
            viewerLedger={viewerLedger}
            viewerIndexAccess={viewerIndexAccess}
            onBack={() => setRoute({ name: 'explore' })}
            onOpenDataset={(datasetId) => setRoute({ name: 'dataset', datasetId })}
            onSignIn={() => requestSignIn()}
          />
        )}
      </Stack>
        </div>
      </div>
      <Modal
        opened={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title="Open Datasets"
        className="od-drawer-panel"
      >
        <civitai-nav-list label="Open Datasets sections">
          <civitai-nav-item
            label="Explore"
            href="#/explore"
            current={route.name === 'explore'}
            onClick={(e) => {
              e.preventDefault();
              setDrawerOpen(false);
              setRoute({ name: 'explore' });
            }}
            data-testid="dc-drawer-explore"
          />
          <civitai-nav-item
            label="My datasets"
            href="#/mine"
            current={route.name === 'mine'}
            onClick={(e) => {
              e.preventDefault();
              setDrawerOpen(false);
              if (viewerId == null) requestSignIn();
              else setRoute({ name: 'mine' });
            }}
            data-testid="dc-drawer-mine"
          />
          <civitai-nav-item
            label="Create dataset"
            href="#/create"
            onClick={(e) => {
              e.preventDefault();
              setDrawerOpen(false);
              createDatasetNow();
            }}
            data-testid="dc-drawer-create"
          />
          <civitai-nav-item
            label="My contributions"
            href="#/contributions"
            current={route.name === 'ledger'}
            onClick={(e) => {
              e.preventDefault();
              setDrawerOpen(false);
              setRoute({ name: 'ledger' });
            }}
            data-testid="dc-drawer-ledger"
          />
        </civitai-nav-list>
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-screens
// ---------------------------------------------------------------------------

function VoteControl(props: {
  net: number;
  viewerVote: VoteValue;
  busy?: boolean;
  testIdPrefix: string;
  onVote: (value: 1 | -1) => void;
}) {
  return (
    <span style={voteStyle} data-testid={`${props.testIdPrefix}-votes`}>
      <Button
        size="sm"
        variant={props.viewerVote === 1 ? 'filled' : 'light'}
        loading={props.busy}
        onClick={() => props.onVote(1)}
        data-testid={`${props.testIdPrefix}-up`}
        aria-label="Upvote"
        style={{ minWidth: 44, minHeight: 44, fontSize: 18 }}
      >
        ↑
      </Button>
      <span style={monoStyle} data-testid={`${props.testIdPrefix}-net`}>
        {props.net}
      </span>
      <Button
        size="sm"
        variant={props.viewerVote === -1 ? 'filled' : 'light'}
        loading={props.busy}
        onClick={() => props.onVote(-1)}
        data-testid={`${props.testIdPrefix}-down`}
        aria-label="Downvote"
        style={{ minWidth: 44, minHeight: 44, fontSize: 18 }}
      >
        ↓
      </Button>
    </span>
  );
}

const NAME_ADJECTIVES = ['Amber', 'Velvet', 'Cobalt', 'Scarlet', 'Quiet', 'Golden', 'Ivory', 'Onyx'];
const NAME_SUBJECTS = ['Portrait', 'Landscape', 'Character', 'Texture', 'Motion', 'Light', 'Form', 'Muse'];

/** A friendly starter name so creating a dataset never starts from a blank box. */
export function generateDatasetName(): string {
  const pick = (list: string[]) => list[Math.floor(Math.random() * list.length)];
  return `${pick(NAME_ADJECTIVES)} ${pick(NAME_SUBJECTS)} Dataset`;
}

function DatasetForm(props: {
  title: string;
  submitLabel: string;
  initial?: DatasetRecord;
  onCancel: () => void;
  onSubmit: (input: { name: string; description: string; targetNote: string }) => Promise<string | null>;
}) {
  const [name, setName] = useState(() => props.initial?.name ?? generateDatasetName());
  const [description, setDescription] = useState(props.initial?.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const checked = validateDatasetInput({ name, description, targetNote: '' });
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setSaving(true);
    setError(null);
    const result = await props.onSubmit(checked.value);
    setSaving(false);
    if (result) setError(result);
  };

  return (
    <div style={{ ...cardStyle, maxWidth: 760 }} data-testid="dc-dataset-form">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Button variant="subtle" size="sm" onClick={props.onCancel} data-testid="dc-dataset-back" aria-label="Back">
          ←
        </Button>
        <span style={cardTitleStyle}>{props.title}</span>
      </div>
      <label style={labelStyle}>
        Name
        <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} data-testid="dc-dataset-name" />
      </label>
      <label style={labelStyle}>
        Description <span style={hintStyle}>(optional)</span>
        <textarea
          style={textareaStyle}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          data-testid="dc-dataset-description"
        />
      </label>
      {error && (
        <Alert color="error" title="Could not save" data-testid="dc-dataset-form-error">
          {error}
        </Alert>
      )}
      <Button
        size="lg"
        loading={saving}
        onClick={() => void submit()}
        data-testid="dc-dataset-save"
        style={{ width: '100%', minHeight: 52, marginTop: 8 }}
      >
        {props.submitLabel}
      </Button>
    </div>
  );
}

function ContributeForm(props: {
  onContribute: (input: { imageRef: string; imageId?: number; caption: string }) => Promise<string | null>;
  onSuccess?: () => void;
}) {
  // An upload is PRIVATE unless the contributor ticks "Share" (default off).
  // A shared one is shown to this dataset's viewers once Civitai has scanned it
  // (PG / PG13 only), read back through the gated image read (./item-images.ts):
  // `open()` resolves `shared: true` only when the server recorded the share.
  // Both resolve `null` on a dismiss (and on the host's review-mode /
  // pre-handshake refusals), and REJECT on the host's no-token refusal.
  const { open: openSharedUpload } = useImageUpload({ share: true });
  const { open: openPrivateUpload } = useImageUpload();
  const [shareUpload, setShareUpload] = useState(false);
  const { open: openPicker } = useImagePicker();
  const [tab, setTab] = useState<'mine' | 'upload' | 'link'>('mine');
  const [reference, setReference] = useState('');
  const [caption, setCaption] = useState('');
  const [rights, setRights] = useState(false);
  const [uploaded, setUploaded] = useState<{
    imageId: number;
    url: string;
    shared: boolean;
    /** Whether the contributor asked for it to be shared. */
    shareRequested: boolean;
  } | null>(null);
  const [picked, setPicked] = useState<{ imageId?: number; url: string; source: 'posted' | 'generated' } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Progressive reveal: caption + rights + submit appear only once an image
  // is actually selected (picked, uploaded, or a link typed).
  const hasSelection = picked != null || uploaded != null || reference.trim().length > 0;

  const upload = async () => {
    const shareRequested = shareUpload;
    let pickedImage: { imageId: number; url: string; shared: boolean } | null;
    try {
      if (shareRequested) {
        pickedImage = await openSharedUpload();
      } else {
        const privateImage = await openPrivateUpload();
        pickedImage = privateImage ? { imageId: privateImage.imageId, url: privateImage.url, shared: false } : null;
      }
    } catch {
      // The host's no-token refusal (or a lost host) rejects: nothing was selected.
      setError(
        "Civitai couldn't take this upload just now, so nothing was added. Try again, or choose an image from My Images or paste a link.",
      );
      return;
    }
    if (!pickedImage) return;
    setUploaded({ imageId: pickedImage.imageId, url: pickedImage.url, shared: pickedImage.shared, shareRequested });
    setPicked(null);
    // Never copy an upload's raw edge url into the Link box: from there an
    // edit would detach it from the upload and store it as a plain link,
    // around the id-only rule and the shared-upload refusal.
    setReference('');
    setError(null);
  };

  const pick = async () => {
    try {
      const image = await openPicker();
      if (!image) return;
      setPicked({ imageId: image.imageId, url: image.url, source: image.source });
      setUploaded(null);
      setError(null);
    } catch {
      setError("The image picker isn't available here yet — use Upload or Link instead.");
    }
  };

  const submit = async () => {
    let imageRef = reference.trim();
    let imageId: number | undefined = uploaded?.imageId;
    // An upload is stored by its image id ONLY. Its raw edge url is unsigned,
    // and the shared `items` document (and any snapshot frozen from it) is read
    // by every viewer, so writing it would hand out an image the contributor
    // kept private — or one Civitai later rates above a viewer's settings.
    // Viewers see an uploaded item only through the host's gated read, by id.
    if (uploaded && !picked) imageRef = '';
    // Operator decision 2026-11-19: an upload joins a SHARED dataset only when
    // it is shared — nobody votes on an item they can't see. A private upload
    // (Share off, or a share Civitai didn't confirm) is refused here.
    if (uploaded && !picked && !uploaded.shared) {
      setError(uploaded.shareRequested ? UNCONFIRMED_SHARE_REFUSED : UNSHARED_UPLOAD_REFUSED);
      return;
    }
    if (picked) {
      imageRef = picked.url;
      imageId = picked.imageId;
    } else if (!uploaded) {
      const parsed = parseImageReference(reference);
      if (!parsed.ok) {
        setError(parsed.error);
        return;
      }
      imageRef = parsed.value.imageRef;
      imageId = parsed.value.imageId;
    }
    const checked = validateContribution({ imageRef, imageId, caption, rightsAsserted: rights });
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setSaving(true);
    setError(null);
    const result = await props.onContribute(checked.value);
    setSaving(false);
    if (result) {
      setError(result);
      return;
    }
    setReference('');
    setCaption('');
    setRights(false);
    setUploaded(null);
    setPicked(null);
    props.onSuccess?.();
  };

  return (
    <div style={subCardStyle} data-testid="dc-contribute">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }} role="tablist" aria-label="Choose an image source">
        <Button
          size="sm"
          variant={tab === 'mine' ? 'filled' : 'light'}
          onClick={() => setTab('mine')}
          data-testid="dc-contribute-tab-mine"
          role="tab"
          aria-selected={tab === 'mine'}
        >
          Select from My Images
        </Button>
        <Button
          size="sm"
          variant={tab === 'upload' ? 'filled' : 'light'}
          onClick={() => setTab('upload')}
          data-testid="dc-contribute-tab-upload"
          role="tab"
          aria-selected={tab === 'upload'}
        >
          Upload
        </Button>
        <Button
          size="sm"
          variant={tab === 'link' ? 'filled' : 'light'}
          onClick={() => setTab('link')}
          data-testid="dc-contribute-tab-link"
          role="tab"
          aria-selected={tab === 'link'}
        >
          Link
        </Button>
      </div>
      {tab === 'mine' && (
        <span>
          <Button size="sm" variant="light" onClick={() => void pick()} data-testid="dc-contribute-pick">
            Pick from my images
          </Button>
          {picked && (
            <span style={hintStyle} data-testid="dc-contribute-picked">
              {' '}
              {picked.source === 'posted'
                ? `Picked image #${picked.imageId} selected.`
                : 'Picked a generator image — its link can expire over time, so a posted image makes a more permanent reference.'}
            </span>
          )}
        </span>
      )}
      {tab === 'upload' && (
        <span>
          <Button size="sm" variant="light" onClick={() => void upload()} data-testid="dc-contribute-upload">
            Upload an image
          </Button>
          <span style={hintStyle} data-testid="dc-contribute-upload-note">
            {' '}
            Your upload is not posted on Civitai, and it stays private to you unless you choose to share it. Only a
            shared upload can be added to this dataset.
          </span>
          <label style={checkStyle}>
            <input
              type="checkbox"
              checked={shareUpload}
              onChange={(e) => setShareUpload(e.target.checked)}
              data-testid="dc-contribute-share"
            />
            Share with this dataset&apos;s viewers once Civitai has scanned it and rated it PG or PG-13.
          </label>
          {uploaded && (
            <span style={hintStyle} data-testid="dc-contribute-uploaded">
              {' '}
              Uploaded image #{uploaded.imageId} selected.{' '}
              {uploaded.shared
                ? "It will be shared with this dataset's viewers once Civitai has scanned it and rated it PG or PG-13."
                : uploaded.shareRequested
                  ? "Kept private: Civitai didn't confirm sharing for this upload, so only you can see it, and it can't be added to this dataset."
                  : "Kept private: only you can see it, so it can't be added to this dataset. To contribute it, tick Share and upload it again."}
            </span>
          )}
        </span>
      )}
      {tab === 'link' && (
        <label style={labelStyle}>
          Civitai image or post URL, or an image ID
          <input
            style={inputStyle}
            value={reference}
            placeholder="https://civitai.com/images/… or an image ID"
            onChange={(e) => {
              setReference(e.target.value);
              setUploaded(null);
            }}
            data-testid="dc-contribute-ref"
          />
        </label>
      )}
      {error && (
        <Alert color="error" title="Could not contribute" data-testid="dc-contribute-error">
          {error}
        </Alert>
      )}
      {hasSelection && (
        <>
          <label style={labelStyle}>
            Caption
            <span style={hintStyle}>
              Describe the image in a short phrase — the caption is the training text the LoRA
              learns from, e.g. “ink portrait, front view”.
            </span>
            <input
              style={inputStyle}
              value={caption}
              placeholder="e.g. ink portrait, front view"
              onChange={(e) => setCaption(e.target.value)}
              data-testid="dc-contribute-caption"
            />
          </label>
          <label style={checkStyle}>
            <input
              type="checkbox"
              checked={rights}
              onChange={(e) => setRights(e.target.checked)}
              data-testid="dc-contribute-rights"
            />
            I have the right to contribute this image for dataset training.
          </label>
          <span>
            <Button loading={saving} onClick={() => void submit()} data-testid="dc-contribute-submit">
              Add to dataset
            </Button>
          </span>
        </>
      )}
    </div>
  );
}

/**
 * An item with no `imageId`, shown from its stored `imageRef`. The ref came out
 * of shared storage, which any contributor can write directly, so it reaches
 * `src` / `href` only through ./civitai-url.ts `imageRefDisplay` (exact Civitai
 * host, `https:`); anything else is plain text, never a link or an image.
 */
function StoredImageRef(props: { itemId: string; imageRef: string; caption: string }) {
  const display = imageRefDisplay(props.imageRef);
  if (display.kind === 'post') {
    return (
      <span style={hintStyle} data-testid={`dc-item-post-${props.itemId}`}>
        Linked from a Civitai post —{' '}
        <a href={display.href} target="_blank" rel="noreferrer">
          view the post
        </a>
      </span>
    );
  }
  if (display.kind === 'image') {
    return <img src={display.src} alt={props.caption} style={imageStyle} data-testid={`dc-item-image-${props.itemId}`} />;
  }
  if (/^\d+$/.test(props.imageRef)) {
    return <span style={hintStyle}>Image reference #{props.imageRef}</span>;
  }
  return (
    <span style={hintStyle} data-testid={`dc-item-image-unavailable-${props.itemId}`}>
      Image unavailable
    </span>
  );
}

/** Why a private upload can't be added to a shared dataset (operator decision 2026-11-19). */
const UNSHARED_UPLOAD_REFUSED =
  "This upload is private, so it can't be added to this dataset: other viewers couldn't see it to vote on it. Tick Share and upload it again to contribute it.";
/** The same refusal when Share WAS ticked but Civitai didn't confirm the share. */
const UNCONFIRMED_SHARE_REFUSED =
  "Civitai didn't confirm sharing this upload, so it can't be added to this dataset: other viewers couldn't see it to vote on it. Try the upload again in a moment.";

/** Author display on the upstream civitai-avatar element (initials + name). */
function AuthorByline(props: { name: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <civitai-avatar name={props.name} size="sm" />
      <span>{props.name}</span>
    </span>
  );
}

function DatasetDetail(props: {
  dataset: DatasetView;
  loras: LoraView[];
  viewerId: number | null;
  busyKey: string | null;
  onEdit: () => void;
  onDelete: () => void;
  onTrain: () => void;
  onOpenLora: (loraId: string) => void;
  onVote: (kind: 'dataset' | 'item', id: string, value: 1 | -1) => void;
  onSignIn: () => void;
  onContribute: (input: { imageRef: string; imageId?: number; caption: string }) => Promise<string | null>;
  onRemove: (item: DatasetView['items'][number]) => void;
}) {
  const { dataset, viewerId } = props;
  const imageIds = useMemo(
    () => dataset.items.map((i) => i.imageId).filter((id): id is number => id != null),
    [dataset.items],
  );
  // Posted images come from the block catalog, this app's own outputs from the
  // gated read (./item-images.ts): the gated read alone never sees a posted image.
  const gatedImages = useItemImages(imageIds);
  const isOwner = viewerId != null && dataset.ownerId === viewerId;
  const liveItems = dataset.items.filter((i) => !i.removed);
  // Contributing happens in a modal opened from the large Add-an-image CTA.
  const [contributeModalOpen, setContributeModalOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Two-tap delete confirm: first tap arms, second tap fires. The key on the
  // parent resets this when the dataset changes; the timer disarms a stray tap.
  const [deleteArmed, setDeleteArmed] = useState(false);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
    };
  }, []);
  const armOrDelete = useCallback(() => {
    if (deleteArmed) {
      if (disarmTimer.current) clearTimeout(disarmTimer.current);
      // Fired: disarm, so a further tap (a slow delete, or one that stopped
      // partway) arms again rather than starting a second delete at once.
      setDeleteArmed(false);
      props.onDelete();
      return;
    }
    setDeleteArmed(true);
    disarmTimer.current = setTimeout(() => setDeleteArmed(false), 6000);
  }, [deleteArmed, props]);

  const detailMeta = [
    ...(liveItems.length > 0 ? [`${liveItems.length} item${liveItems.length === 1 ? '' : 's'}`] : []),
    ...(dataset.trainableCount > 0 ? [`${dataset.trainableCount} trainable now`] : []),
  ];

  return (
    <Stack gap={12} data-testid="dc-dataset-detail">
      <div style={cardStyle} data-testid="dc-dataset-header">
      <div style={itemHeadStyle}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={titleStyle}>{dataset.name}</span>
          {isOwner && (
            <Button
              variant="subtle"
              size="sm"
              onClick={props.onEdit}
              data-testid="dc-dataset-rename"
              aria-label="Rename dataset"
              style={{ minWidth: 36, minHeight: 36 }}
            >
              ✎
            </Button>
          )}
        </span>
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          {!isOwner && (
            <VoteControl
              net={dataset.netVotes}
              viewerVote={dataset.viewerVote}
              busy={props.busyKey === `vote-dataset-${dataset.datasetId}`}
              testIdPrefix="dc-dataset"
              onVote={(v) => (viewerId == null ? props.onSignIn() : props.onVote('dataset', dataset.datasetId, v))}
            />
          )}
          {isOwner && (
            <span style={{ position: 'relative', display: 'inline-flex' }}>
              <Button
                variant="subtle"
                size="sm"
                onClick={() => setMenuOpen((o) => !o)}
                data-testid="dc-dataset-menu"
                aria-label="Dataset actions"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                style={{ minWidth: 44, minHeight: 44, fontSize: 20 }}
              >
                ⋯
              </Button>
              {menuOpen && (
                <>
                <div
                  className="od-menu-backdrop"
                  onClick={() => {
                    setMenuOpen(false);
                    setDeleteArmed(false);
                    if (disarmTimer.current) clearTimeout(disarmTimer.current);
                  }}
                  data-testid="dc-dataset-menu-backdrop"
                />
                <div style={menuStyle} role="menu" data-testid="dc-dataset-menu-list">
                  <Button
                    variant="subtle"
                    style={menuItemStyle}
                    onClick={() => {
                      setMenuOpen(false);
                      props.onEdit();
                    }}
                    data-testid="dc-edit-dataset"
                  >
                    Edit dataset
                  </Button>
                  <Button
                    variant="subtle"
                    color="red"
                    style={menuItemStyle}
                    onClick={armOrDelete}
                    data-testid="dc-delete-dataset"
                  >
                    {deleteArmed ? 'Tap again to confirm delete' : 'Delete dataset'}
                  </Button>
                </div>
                </>
              )}
            </span>
          )}
        </span>
      </div>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <AuthorByline name={dataset.ownerName} />
        {detailMeta.length > 0 && <span style={hintStyle}>{detailMeta.join(' · ')}</span>}
      </span>
      {dataset.description && <span>{dataset.description}</span>}
      </div>

      {dataset.items.length > 0 && (
        <div style={cardStyle} data-testid="dc-dataset-train">
          <span style={cardTitleStyle}>Train</span>
          <span>
            <Button onClick={() => (viewerId == null ? props.onSignIn() : props.onTrain())} data-testid="dc-open-train">
              Train a LoRA from this dataset
            </Button>
          </span>
        </div>
      )}
      {props.loras.length > 0 && (
        <div style={subCardStyle} data-testid="dc-dataset-loras">
          <span style={cardTitleStyle}>LoRAs trained from this dataset</span>
          {props.loras.map((lora) => (
            <div key={lora.loraId} style={rowStyle}>
              <span>
                {lora.name} · {lora.published ? 'published' : 'not published yet'} · snapshot{' '}
                {lora.snapshot?.items.filter((i) => i.included).length ?? 0} items
                {dataSourceLabel(lora) && (
                  <span data-testid={`dc-dataset-lora-source-${lora.loraId}`}> · {dataSourceLabel(lora)}</span>
                )}
              </span>
              <Button size="sm" variant="light" onClick={() => props.onOpenLora(lora.loraId)} data-testid={`dc-open-lora-${lora.loraId}`}>
                Open LoRA
              </Button>
            </div>
          ))}
        </div>
      )}

      <div style={cardStyle} data-testid="dc-dataset-items">
      <span style={cardTitleStyle}>Items</span>
      {dataset.items.length === 0 ? (
        <span style={hintStyle} data-testid="dc-dataset-no-items">
          No items yet — add the first image.
        </span>
      ) : (
        <div className="od-grid-items">
        {dataset.items.map((item) => {
          const gatedImage = item.imageId != null ? gatedImages.get(item.imageId) : undefined;
          const isContributor = viewerId != null && item.contributorId === viewerId;
          return (
            <div key={item.itemId} style={cardStyle} data-testid={`dc-item-card-${item.itemId}`}>
              {item.imageId != null ? (
                gatedImage == null ? (
                  <span style={hintStyle} data-testid={`dc-item-image-pending-${item.itemId}`}>
                    Image can't be shown here — it may still be being rated, or it isn't public on Civitai.
                  </span>
                ) : gatedImage.status === 'visible' ? (
                  <Stack gap={4}>
                    <img
                      src={gatedImage.url}
                      alt={item.caption}
                      style={imageStyle}
                      data-testid={`dc-item-image-${item.itemId}`}
                    />
                    {gatedImage.ratingPending && (
                      <span style={hintStyle}>Rating pending — visible to you while Civitai rates it.</span>
                    )}
                  </Stack>
                ) : (
                  <span style={hintStyle} data-testid={`dc-item-image-hidden-${item.itemId}`}>
                    Image hidden by your content settings.
                  </span>
                )
              ) : (
                <StoredImageRef itemId={item.itemId} imageRef={item.imageRef} caption={item.caption} />
              )}
              <div style={itemHeadStyle}>
                <span style={cardTitleStyle}>{item.caption || '(no caption)'}</span>
                <Badge color={item.removed ? 'gray' : item.includedNow ? 'primary' : 'gray'} variant="light">
                  {item.removed ? 'removed' : item.includedNow ? 'in training set' : 'not in training set'}
                </Badge>
              </div>
              <span style={hintStyle}>
                by {item.contributorName} · {item.snapshotAppearances} snapshot
                {item.snapshotAppearances === 1 ? '' : 's'}
              </span>
              <VoteControl
                net={item.netVotes}
                viewerVote={item.viewerVote}
                busy={props.busyKey === `vote-item-${item.itemId}`}
                testIdPrefix={`dc-item-${item.itemId}`}
                onVote={(v) => (viewerId == null ? props.onSignIn() : props.onVote('item', item.itemId, v))}
              />
              {(isOwner || isContributor) && !item.removed && (
                <span>
                  <Button
                    size="sm"
                    variant="subtle"
                    onClick={() => props.onRemove(item)}
                    data-testid={isContributor && !isOwner ? `dc-withdraw-item-${item.itemId}` : `dc-remove-item-${item.itemId}`}
                  >
                    {isContributor && !isOwner ? 'Withdraw my item' : 'Remove item'}
                  </Button>
                  {isContributor && !isOwner && item.snapshotAppearances > 0 && (
                    <span style={hintStyle}> Already frozen into a snapshot — it stays in that snapshot.</span>
                  )}
                </span>
              )}
            </div>
          );
        })}
        </div>
      )}

      <div id="dc-contribute-anchor">
      {viewerId == null ? (
        <Alert color="info" title="Sign in to contribute" data-testid="dc-contribute-guest">
          You can read everything here. Contributing, voting, and training need a Civitai sign-in.{' '}
          <Button size="sm" onClick={props.onSignIn} data-testid="dc-contribute-signin">
            Sign in
          </Button>
        </Alert>
      ) : (
        <>
          <Button
            size="lg"
            onClick={() => setContributeModalOpen(true)}
            data-testid="dc-add-image"
            style={{ width: '100%', minHeight: 52 }}
          >
            Add an image
          </Button>
          <Modal opened={contributeModalOpen} onClose={() => setContributeModalOpen(false)} title="Add an image">
            <ContributeForm
              onContribute={props.onContribute}
              onSuccess={() => setContributeModalOpen(false)}
            />
          </Modal>
        </>
      )}
      </div>
      </div>
    </Stack>
  );
}

function LoraDetail(props: {
  lora: LoraView;
  onBack: () => void;
  onLedgerEvent: (event: LedgerEvent) => Promise<void>;
  onNotice: (message: string | null) => void;
}) {
  const { lora } = props;
  const { viewer } = useBlockContext();
  const token = useBlockToken();
  const { estimate, submit, poll } = useBuzzWorkflow();
  const { requestConsent } = useRequestConsent();
  const { requestSignIn } = useRequestSignIn();
  const { navigate } = useCivitaiNavigate();
  const { balance, refetch: refetchBalance } = useBuzzBalance();

  const [prompt, setPrompt] = useState(`a portrait with ${lora.name} style`);
  const [phase, setPhase] = useState<'idle' | 'estimating' | 'quoted' | 'submitting' | 'polling'>('idle');
  const [quote, setQuote] = useState<number | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Every run this screen has credited: a resumed run and a new run can both
  // succeed, and each must be credited exactly once.
  const creditedRef = useRef<Set<string>>(new Set());
  // The exact body the standing quote priced. Generate submits only THAT body:
  // an edit after pricing drops the quote (the prompt's onChange), and a body
  // that no longer matches is refused rather than charged at a stale price.
  const quotedBodyRef = useRef<string | null>(null);
  // Set by a prompt edit made while a price is being fetched: that price is
  // for the OLD prompt, so it is dropped when it arrives.
  const promptEditedWhilePricingRef = useRef(false);
  // One run at a time: set synchronously when a submit or a resume starts, so
  // a second click (Price again, Generate, Check again) cannot start a run
  // alongside it — the phase state alone updates too late to stop a double tap.
  const runningRef = useRef(false);
  /**
   * Runs a wait gave up on (lost contact / still running), resumable by id.
   * A list, not one id: starting a new run must not orphan an earlier one.
   */
  const [pendingRunIds, setPendingRunIds] = useState<string[]>([]);
  const addPendingRun = (id: string) => setPendingRunIds((cur) => (cur.includes(id) ? cur : [...cur, id]));
  const dropPendingRun = (id: string) => setPendingRunIds((cur) => cur.filter((x) => x !== id));
  const inFlight = phase === 'submitting' || phase === 'polling';
  // Leaving the LoRA screen mid-poll: the run is still polled to the end and its
  // tracked-credit event still written (it was charged), but no state write
  // reaches this unmounted screen. See onConfirm.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const snapshot = lora.snapshot;
  const shares = snapshot ? snapshotShareRows(snapshot) : [];
  const balanceTotal =
    balance == null ? null : (balance.blue ?? 0) + (balance.green ?? 0) + (balance.yellow ?? 0);
  const insufficient = quote != null && balanceTotal != null && balanceTotal < quote;
  const canGenerate = lora.modelVersionId != null;

  const buildBody = useCallback(() => {
    if (lora.modelVersionId == null || lora.modelId == null) return null;
    return buildWorkflowBody(prompt, DEFAULT_CHECKPOINT, [
      loraOption({ versionId: lora.modelVersionId, modelId: lora.modelId, label: lora.name, baseModel: 'SDXL 1.0' }),
    ]);
  }, [lora.modelId, lora.modelVersionId, lora.name, prompt]);

  const doEstimate = useCallback(async () => {
    const body = buildBody();
    if (!body || runningRef.current) return;
    // Held while pricing too, so Check again cannot run alongside an estimate.
    runningRef.current = true;
    setPhase('estimating');
    setError(null);
    quotedBodyRef.current = null;
    promptEditedWhilePricingRef.current = false;
    try {
      const est = await estimate(body);
      const cost = est.cost?.total;
      if (cost == null || !Number.isFinite(cost) || cost < 0) {
        setError('The generator returned no usable price, so there is nothing honest to confirm against. No Buzz was charged.');
        setPhase('idle');
        return;
      }
      if (promptEditedWhilePricingRef.current) {
        setError('The prompt changed while it was being priced, so that price was dropped. Price it again.');
        setPhase('idle');
        return;
      }
      setQuote(cost);
      quotedBodyRef.current = JSON.stringify(body);
      setPhase('quoted');
    } catch {
      setError('Could not price that generation just now. No Buzz was charged.');
      setPhase('idle');
    } finally {
      runningRef.current = false;
    }
  }, [buildBody, estimate]);

  const onEstimateClick = () => {
    if (runningRef.current) return;
    if (!viewer) {
      requestSignIn();
      return;
    }
    if (!hasBudgetedScope(token.scopes)) {
      requestConsent({ scopes: ['ai:write:budgeted'] });
      setError('Confirm generation access in the Civitai dialog, then price the generation again.');
      return;
    }
    void doEstimate();
  };

  const pollDeps: GenerationPollDeps = {
    poll,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    visible: () => typeof document === 'undefined' || !document.hidden,
  };

  /**
   * Show a run's outcome and record its tracked credit. After the screen
   * unmounts the run is still polled to the end and credited (it was charged,
   * and the ledger belongs to Community, still mounted), but nothing writes
   * THIS screen's state any more.
   */
  const finishRun = async (outcome: GenerationRunOutcome, settle = true) => {
    const live = () => mountedRef.current;
    if (outcome.kind !== 'succeeded') {
      if (!live()) return;
      // Copy is chosen by outcome only; the host's own error text is
      // server-authored and unsanitised, so it is never shown to the viewer.
      if (outcome.kind === 'refused') {
        setError('Civitai turned that generation down before it ran (a budget or spend limit), so no Buzz was charged.');
      } else if (outcome.kind === 'unconfirmed') {
        setError(
          "Civitai couldn't confirm whether that generation started, so its charge status is unknown. Check your Buzz history before trying again.",
        );
      } else if (outcome.kind === 'lost-contact') {
        addPendingRun(outcome.workflowId);
        setError(
          'Lost contact with Civitai while the generation ran, so its charge status is unknown. Check again to pick the run back up, or check your Buzz history before trying again.',
        );
      } else if (outcome.kind === 'still-running') {
        addPendingRun(outcome.workflowId);
        setError('That generation is still running — check again in a moment.');
      } else {
        dropPendingRun(outcome.snapshot.workflowId);
        setError(`That generation ${outcome.snapshot.status}. Check the run before assuming any charge.`);
      }
      if (settle) setPhase('idle');
      return;
    }
    const snap = outcome.snapshot;
    if (live()) {
      dropPendingRun(snap.workflowId);
      setImageUrl(firstImageUrl(snap));
      try {
        await refetchBalance();
      } catch {
        // A stale balance is not a reason to skip the run's tracked credit below.
      }
    }
    const gross = snap.cost?.total;
    if (gross != null && gross > 0 && !creditedRef.current.has(snap.workflowId)) {
      creditedRef.current.add(snap.workflowId);
      try {
        await props.onLedgerEvent(generationLedgerEvent({ lora, workflowId: snap.workflowId, grossBuzz: gross }));
      } catch {
        creditedRef.current.delete(snap.workflowId);
        props.onNotice('The generation succeeded, but saving its tracked-credit event failed. Refresh before relying on the ledger.');
      }
    } else if (gross == null) {
      props.onNotice('The generation finished without a reported cost, so no tracked credit was recorded for it.');
    }
    if (live() && settle) setPhase('idle');
  };

  const onConfirm = async () => {
    const body = buildBody();
    if (!body || quote == null || insufficient || phase !== 'quoted' || runningRef.current) return;
    if (JSON.stringify(body) !== quotedBodyRef.current) {
      // The prompt changed after pricing: never submit at the old price.
      setQuote(null);
      quotedBodyRef.current = null;
      setPhase('idle');
      setError('The prompt changed after it was priced, so nothing was submitted. Price it again.');
      return;
    }
    runningRef.current = true;
    try {
      setPhase('submitting');
      setError(null);
      // A submit outcome and a lost poll are different outcomes: see runGenerationToEnd.
      const outcome = await runGenerationToEnd(body, {
        submit,
        ...pollDeps,
        onSubmitted: () => {
          if (mountedRef.current) setPhase('polling');
        },
      });
      await finishRun(outcome);
    } finally {
      runningRef.current = false;
    }
  };

  /** Pick up the runs earlier waits gave up on, by id — they may have finished (and been charged) since. */
  const onCheckAgain = async () => {
    if (pendingRunIds.length === 0 || runningRef.current || phase !== 'idle') return;
    runningRef.current = true;
    try {
      setPhase('polling');
      setError(null);
      // The screen stays "polling" until the LAST pending run is settled.
      for (const [i, id] of pendingRunIds.entries()) {
        await finishRun(await pollGenerationToEnd(id, null, pollDeps), i === pendingRunIds.length - 1);
      }
    } finally {
      runningRef.current = false;
    }
  };

  return (
    <Stack gap={12} data-testid="dc-lora">
      <span>
        <Button variant="subtle" size="sm" onClick={props.onBack} data-testid="dc-back-dataset-from-lora">
          ← Back to dataset
        </Button>
      </span>
      <span style={titleStyle}>{lora.name}</span>
      <span style={hintStyle}>
        from {lora.dataset?.name ?? lora.datasetId} · trained by {lora.trainerName} · {formatDate(lora.createdAt)} ·{' '}
        {lora.published ? 'published' : 'not published yet'}
        {lora.modelVersionId != null ? ` · model version ${lora.modelVersionId}` : ''}
      </span>
      {dataSourceLabel(lora) && (
        <Alert color="warning" title={dataSourceLabel(lora)!} data-testid="dc-lora-source">
          Trained on Civitai's trainer from images the trainer uploaded and attested were this snapshot's,
          in the matched order. This app could not check the files, so the snapshot contributors' credit
          below rests on that attestation.
        </Alert>
      )}

      {lora.modelId != null && (
        <span>
          <Button
            size="sm"
            variant="light"
            onClick={() => navigate(`models/${lora.modelId}`, { scope: 'site' })}
            data-testid="dc-lora-view-civitai"
          >
            View on Civitai
          </Button>
        </span>
      )}
      {lora.modelVersionId == null && (
        <Alert color="info" title="Publish to link this LoRA" data-testid="dc-lora-unlinked">
          This training run has no published model version linked yet. Finish publishing from the Train screen —
          the published version links back to the frozen snapshot below.
        </Alert>
      )}

      <div style={subCardStyle} data-testid="dc-lora-test">
        <span style={cardTitleStyle}>Test generate with this LoRA</span>
        {!canGenerate ? (
          <span style={hintStyle}>Test generation unlocks once a published model version is linked.</span>
        ) : (
          <Stack gap={8}>
            <input
              style={inputStyle}
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                // A standing (or in-flight) quote priced the OLD prompt.
                if (phase === 'estimating') promptEditedWhilePricingRef.current = true;
                if (phase === 'quoted') {
                  setQuote(null);
                  quotedBodyRef.current = null;
                  setPhase('idle');
                }
              }}
              data-testid="dc-lora-prompt"
            />
            {phase !== 'quoted' ? (
              <Button
                loading={phase === 'estimating' || inFlight}
                disabled={inFlight}
                onClick={onEstimateClick}
                data-testid="dc-lora-estimate"
              >
                {inFlight ? 'Generating…' : 'Price test generation'}
              </Button>
            ) : (
              <div style={subCardStyle} data-testid="dc-lora-confirm">
                <span style={monoStyle} data-testid="dc-lora-quote">
                  {formatCost(quote ?? 0)} Buzz
                </span>
                {insufficient ? (
                  <Alert color="warning" title="Not enough Buzz" data-testid="dc-lora-insufficient">
                    This generation is quoted at {formatCost(quote ?? 0)} Buzz and your balance is{' '}
                    {formatCost(balanceTotal)}. Nothing was charged.
                  </Alert>
                ) : (
                  <Button loading={phase !== 'quoted'} onClick={() => void onConfirm()} data-testid="dc-lora-confirm-submit">
                    Generate · {formatCost(quote ?? 0)} Buzz
                  </Button>
                )}
              </div>
            )}
            {pendingRunIds.length > 0 && phase === 'idle' && (
              <span>
                <Button size="sm" variant="light" onClick={() => void onCheckAgain()} data-testid="dc-lora-check-again">
                  Check again
                </Button>
              </span>
            )}
            {imageUrl && <img src={imageUrl} alt="Test generation" style={imageStyle} data-testid="dc-lora-image" />}
          </Stack>
        )}
        {error && (
          <Alert color="error" title="Generation problem" data-testid="dc-lora-error">
            {error}
          </Alert>
        )}
      </div>

      {snapshot && (
        <div style={subCardStyle} data-testid="dc-lora-snapshot">
          <span style={cardTitleStyle}>Frozen snapshot & shares</span>
          <span style={hintStyle}>
            {snapshot.items.filter((i) => i.included).length} items included · total weight {snapshot.totalWeight} ·
            frozen {formatDate(snapshot.createdAt)}. Later votes never rewrite this split.
          </span>
          {shares.map((row) => (
            <div key={row.contributorId} style={rowStyle} data-testid={`dc-lora-share-${row.contributorId}`}>
              <span>{row.contributorName}</span>
              <span style={monoStyle}>
                weight {row.weight} · {(row.share * 100).toFixed(1)}%
              </span>
            </div>
          ))}
          {snapshot.items
            .filter((i) => !i.included)
            .map((item) => (
              <span key={item.itemId} style={hintStyle}>
                Excluded: {item.caption} ({item.exclusionReason ?? 'not included'})
              </span>
            ))}
        </div>
      )}

      <div style={subCardStyle} data-testid="dc-lora-events">
        <span style={cardTitleStyle}>Tracked events for this LoRA</span>
        {lora.events.length === 0 ? (
          <span style={hintStyle}>No earning events tracked yet.</span>
        ) : (
          lora.events.map((event) => (
            <div key={event.eventId} style={rowStyle}>
              <span>
                {EVENT_LABEL[event.eventType]} · {formatDate(event.createdAt)}
              </span>
              <span style={monoStyle}>{formatCost(event.grossBuzz)} Buzz tracked</span>
            </div>
          ))
        )}
        <span style={hintStyle} data-testid="dc-lora-onsite">
          {ONSITE_EARNINGS_LINE}
        </span>
      </div>
    </Stack>
  );
}

function LedgerView(props: {
  folded: FoldedCommunity;
  view: ReturnType<typeof buildCommunityView>;
  viewerId: number | null;
  viewerLedger: ReturnType<typeof buildViewerLedger>;
  viewerIndexAccess: StorageAccess;
  onBack: () => void;
  onOpenDataset: (datasetId: string) => void;
  onSignIn: () => void;
}) {
  const { viewerId, viewerLedger } = props;
  const myItems = props.view.datasets.flatMap((dataset) =>
    dataset.items
      .filter((item) => viewerId != null && item.contributorId === viewerId)
      .map((item) => ({ dataset, item })),
  );
  const myDatasetVotes = props.folded.votes.filter(
    (v) => viewerId != null && v.targetKind === 'dataset' && v.viewerVote !== 0,
  );

  return (
    <Stack gap={12} data-testid="dc-ledger-view">
      <span>
        <Button variant="subtle" size="sm" onClick={props.onBack} data-testid="dc-back-explore-from-ledger">
          ← Explore
        </Button>
      </span>
      <span style={titleStyle}>My contributions & ledger</span>

      {viewerId == null ? (
        <Alert color="info" title="Sign in to see your ledger" data-testid="dc-ledger-guest">
          Your items, votes, snapshots, and tracked credit are tied to your Civitai account.{' '}
          <Button size="sm" onClick={props.onSignIn} data-testid="dc-ledger-signin">
            Sign in
          </Button>
        </Alert>
      ) : (
        <Stack gap={12}>
          {props.viewerIndexAccess === 'not-permitted' && (
            <Alert color="warning" title="Your private index isn't saving" data-testid="dc-ledger-index-off">
              This ledger is rebuilt from the community records, so the numbers below still stand — but your
              per-viewer index could not be saved this session.
            </Alert>
          )}

          <div style={ledgerTotalStyle} data-testid="dc-ledger-total">
            <span style={cardTitleStyle}>Tracked credit</span>
            <span style={ledgerAmountStyle}>{formatCost(viewerLedger.totalTracked)} Buzz tracked</span>
            <span style={hintStyle}>
              Tracked credit only — an in-app share ledger. No Buzz has moved to you; contributors get paid only
              when the platform ships a payout rail.
            </span>
          </div>

          {myItems.length === 0 && viewerLedger.snapshotsIn.length === 0 ? (
            <span style={hintStyle} data-testid="dc-ledger-empty">
              Nothing contributed yet. Add an image to a dataset and it will show up here with its live votes.
            </span>
          ) : viewerLedger.snapshotsIn.length > 0 && viewerLedger.rows.length === 0 ? (
            <span style={hintStyle} data-testid="dc-ledger-no-events">
              You're in {viewerLedger.snapshotsIn.length} snapshot{viewerLedger.snapshotsIn.length === 1 ? '' : 's'},
              but no earning events have been tracked against them yet.
            </span>
          ) : null}

          {myItems.length > 0 && (
            <div style={subCardStyle} data-testid="dc-my-items">
              <span style={cardTitleStyle}>My items</span>
              {myItems.map(({ dataset, item }) => (
                <div key={item.itemId} style={rowStyle}>
                  <span>
                    {item.caption} · {dataset.name} · net {item.netVotes} · {item.snapshotAppearances} snapshot
                    {item.snapshotAppearances === 1 ? '' : 's'}
                    {item.removed ? ' · removed' : ''}
                  </span>
                  <Button size="sm" variant="subtle" onClick={() => props.onOpenDataset(dataset.datasetId)}>
                    Open
                  </Button>
                </div>
              ))}
            </div>
          )}

          {myDatasetVotes.length > 0 && (
            <div style={subCardStyle} data-testid="dc-my-votes">
              <span style={cardTitleStyle}>Dataset votes I've given</span>
              {myDatasetVotes.map((voteRow) => (
                <span key={`${voteRow.targetKind}:${voteRow.targetId}`} style={hintStyle}>
                  {props.view.datasets.find((d) => d.datasetId === voteRow.targetId)?.name ?? voteRow.targetId}:{' '}
                  {voteRow.viewerVote === 1 ? 'up' : 'down'}
                </span>
              ))}
            </div>
          )}

          {viewerLedger.snapshotsIn.length > 0 && (
            <div style={subCardStyle} data-testid="dc-my-snapshots">
              <span style={cardTitleStyle}>Snapshots I'm in</span>
              {viewerLedger.snapshotsIn.map((snapshot) => {
                const dataset = props.view.datasets.find((d) => d.datasetId === snapshot.datasetId);
                const myShare = snapshotShareRows(snapshot).find(
                  (r) => viewerId != null && (r.contributorId === contributorKey(viewerId) || r.contributorId === String(viewerId)),
                );
                return (
                  <div key={snapshot.snapshotId} style={rowStyle}>
                    <span>
                      {dataset?.name ?? snapshot.datasetId} · frozen {formatDate(snapshot.createdAt)}
                    </span>
                    <span style={monoStyle}>{myShare ? `${(myShare.share * 100).toFixed(1)}% share` : ''}</span>
                  </div>
                );
              })}
            </div>
          )}

          {viewerLedger.rows.length > 0 && (
            <div style={subCardStyle} data-testid="dc-my-ledger-rows">
              <span style={cardTitleStyle}>Tracked credit events</span>
              {viewerLedger.rows.map((row) => (
                <div key={row.event.eventId} style={rowStyle} data-testid="dc-ledger-row">
                  <span>
                    {formatDate(row.event.createdAt)} · {row.lora?.name ?? row.event.loraId} ·{' '}
                    {EVENT_LABEL[row.event.eventType]}
                    {ledgerRowSourceLabel(row.event, row.lora) && (
                      <span data-testid="dc-ledger-row-source"> · {ledgerRowSourceLabel(row.event, row.lora)}</span>
                    )}
                  </span>
                  <span style={monoStyle}>
                    gross {formatCost(row.event.grossBuzz)} · mine {formatCost(row.credit)} Buzz tracked
                  </span>
                </div>
              ))}
            </div>
          )}
          <span style={hintStyle} data-testid="dc-ledger-onsite">
            {ONSITE_EARNINGS_LINE}
          </span>
        </Stack>
      )}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Archive Lab styles (spec §8): dark blue-charcoal, cyan-teal primary, amber
// only for ledger amounts, serif display headings, mono for money/weights.
// ---------------------------------------------------------------------------

// Content-only root: the App shell owns the page background and padding, so
// views never nest a second framed card inside it (the "double card").
const rootStyle: React.CSSProperties = {
  color: 'var(--civitai-color-text)',
  width: '100%',
};
const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  alignItems: 'flex-start',
  flexWrap: 'wrap',
};
const titleStyle: React.CSSProperties = {
  fontFamily: 'Georgia, "Times New Roman", serif',
  fontSize: 22,
  fontWeight: 700,
};
const cardTitleStyle: React.CSSProperties = { fontSize: 15, fontWeight: 650 };
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
const cardStyle: React.CSSProperties = {
  display: 'grid',
  gap: 8,
  border: '1px solid var(--civitai-color-border, transparent)',
  borderRadius: 6,
  padding: 12,
  background: 'var(--civitai-color-surface, transparent)',
};
const subCardStyle: React.CSSProperties = { ...cardStyle, background: 'var(--civitai-color-surface, transparent)' };
const menuStyle: React.CSSProperties = {
  position: 'absolute',
  right: 0,
  top: 'calc(100% + 4px)',
  zIndex: 30,
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 200,
  padding: 6,
  borderRadius: 8,
  border: '1px solid var(--civitai-color-border, #243746)',
  background: 'var(--civitai-color-surface-2, #1a2833)',
  boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
};
const menuItemStyle: React.CSSProperties = { width: '100%', justifyContent: 'flex-start' };
const menuLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
  color: 'var(--civitai-color-text-dimmed, #9aa7b1)',
  padding: '4px 10px 2px',
};
const toolbarStyle: React.CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' };
const rowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'space-between',
};
const itemHeadStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'space-between',
};
const inputStyle: React.CSSProperties = {
  padding: '6px 8px',
  borderRadius: 6,
  border: '1px solid var(--civitai-color-border, #243746)',
  background: 'var(--civitai-color-surface, transparent)',
  color: 'var(--civitai-color-text)',
  minWidth: 160,
};
const textareaStyle: React.CSSProperties = { ...inputStyle, minHeight: 64, width: '100%' };
const labelStyle: React.CSSProperties = { display: 'grid', gap: 4, fontSize: 13, fontWeight: 600 };
const checkStyle: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 };
const voteStyle: React.CSSProperties = { display: 'inline-flex', gap: 6, alignItems: 'center' };
const imageStyle: React.CSSProperties = { width: '100%', maxHeight: 280, objectFit: 'cover', borderRadius: 6 };
const ledgerTotalStyle: React.CSSProperties = {
  ...cardStyle,
  borderColor: 'var(--dc-archive-ledger, #e8a33d)',
};
const ledgerAmountStyle: React.CSSProperties = {
  ...monoStyle,
  color: 'var(--dc-archive-ledger, #e8a33d)',
  fontSize: 18,
  fontWeight: 700,
};
