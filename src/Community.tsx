import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  useAppStorage,
  useBlockContext,
  useBlockToken,
  useBuzzBalance,
  useBuzzWorkflow,
  useCivitaiNavigate,
  useGatedImages,
  useImageUpload,
  useRequestConsent,
  useRequestSignIn,
  useSharedStorage,
} from '@civitai/blocks-react';
import { Alert, Badge, Button, Stack } from '@civitai/blocks-react/ui';
import type { BlockGatedImage } from '@civitai/app-sdk/blocks';

import {
  COSMETIC_TRUST_LINE,
  ONSITE_EARNINGS_LINE,
  buildCommunityView,
  buildViewerLedger,
  contributorKey,
  datasetSharedValue,
  filterAndSortDatasets,
  foldSharedEntries,
  generationLedgerEvent,
  itemSharedValue,
  ledgerSharedValue,
  loraSharedValue,
  makeRecordId,
  nextVoteValue,
  parseImageReference,
  removalSharedValue,
  snapshotSharedValue,
  snapshotShareRows,
  trainingItemsForDataset,
  validateContribution,
  validateDatasetInput,
  viewerVoteRecord,
  voteSharedValue,
  type DatasetItemRecord,
  type DatasetRecord,
  type DatasetView,
  type ExploreSort,
  type FoldedCommunity,
  type LoraRecord,
  type LoraView,
  type SharedEntryLike,
  type VoteValue,
} from './community.js';
import {
  SHARED_STORAGE_SCOPES,
  classifyStorageError,
  hasScopes,
  loadSharedEntries,
  loadThemePreference,
  saveThemePreference,
  saveViewerIndex,
  upsertOwnSharedEntry,
  type DcTheme,
  type StorageAccess,
} from './community-storage.js';
import { buildWorkflowBody, firstImageUrl, formatCost, hasBudgetedScope } from './generation.js';
import { DEFAULT_CHECKPOINT, loraOption } from './models.js';
import type { DatasetSnapshot, LedgerEvent } from './training.js';
import { TrainFlow, type TrainRunLink } from './TrainFlow.js';

/**
 * Dataset Commons community screens (spec §6): Explore, Dataset detail,
 * Create/edit, Train entry, LoRA detail, and My contributions & ledger.
 *
 * Votes are option (b) — custom shared up/down vote records folded by
 * community.ts — because the shared store's native vote is up-only while the
 * spec's split needs net votes. Shared storage is the source of truth; the
 * per-viewer app-storage copy is only a rebuildable index of "mine".
 */

type Route =
  | { name: 'explore' }
  | { name: 'create' }
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

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export function Community() {
  const { viewer } = useBlockContext();
  const token = useBlockToken();
  const shared = useSharedStorage();
  const appStorage = useAppStorage();
  const { requestConsent } = useRequestConsent();
  const { requestSignIn } = useRequestSignIn();

  const [route, setRoute] = useState<Route>({ name: 'explore' });
  const [entries, setEntries] = useState<SharedEntryLike[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ExploreSort>('top-voted');
  const [theme, setTheme] = useState<DcTheme>('dark');
  const [viewerIndexAccess, setViewerIndexAccess] = useState<StorageAccess>('ready');

  const sharedRef = useRef(shared);
  sharedRef.current = shared;
  const scopesRef = useRef(token.scopes);
  scopesRef.current = token.scopes;

  const viewerId = viewer?.id ?? null;
  const viewerName = viewer?.username ?? 'you';

  const refresh = useCallback(async () => {
    const result = await loadSharedEntries(sharedRef.current, scopesRef.current);
    setEntries(result.entries);
    setLoadState(result.access);
    return result;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, token.scopes]);

  const folded: FoldedCommunity = useMemo(() => foldSharedEntries(entries), [entries]);
  const view = useMemo(() => buildCommunityView(folded, viewerId), [folded, viewerId]);
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
        .filter((v) => v.voterId === viewerId && v.value !== 0)
        .map((v) => `${v.targetKind}:${v.targetId}`),
      snapshotIds: viewerLedger.snapshotsIn.map((s) => s.snapshotId),
      updatedAt: new Date().toISOString(),
    };
    const json = JSON.stringify(index);
    if (indexJsonRef.current === json) return;
    indexJsonRef.current = json;
    void saveViewerIndex(appStorage, viewerId, index).then(setViewerIndexAccess);
  }, [appStorage, folded, loadState, viewerId, viewerLedger]);

  useEffect(() => {
    if (viewerId == null) return;
    let alive = true;
    void loadThemePreference(appStorage, viewerId).then((result) => {
      if (alive && result.access === 'ready') setTheme(result.theme);
    });
    return () => {
      alive = false;
    };
  }, [appStorage, viewerId]);

  const toggleTheme = useCallback(() => {
    setTheme((cur) => {
      const next: DcTheme = cur === 'dark' ? 'light' : 'dark';
      if (viewerId != null) void saveThemePreference(appStorage, viewerId, next);
      return next;
    });
  }, [appStorage, viewerId]);

  const requireViewer = useCallback((): boolean => {
    if (viewerId != null) return true;
    requestSignIn();
    return false;
  }, [requestSignIn, viewerId]);

  const writeFailed = useCallback(
    (error: unknown, busy: string | null) => {
      if (busy) setBusyKey((cur) => (cur === busy ? null : cur));
      const access = classifyStorageError(error);
      if (access === 'not-permitted') {
        setNotice('Community storage access is not granted yet. Confirm it in the Civitai dialog, then try again.');
        requestConsent({ scopes: [...SHARED_STORAGE_SCOPES] });
      } else {
        setNotice('That did not save. Nothing was written — try again in a moment.');
      }
    },
    [requestConsent],
  );

  /** Run one shared-storage write with sign-in/consent gates and honest failure copy. */
  const runWrite = useCallback(
    async (busy: string, fn: () => Promise<void>, successNote?: string): Promise<boolean> => {
      if (!requireViewer()) return false;
      if (!hasScopes(scopesRef.current, SHARED_STORAGE_SCOPES)) {
        requestConsent({ scopes: [...SHARED_STORAGE_SCOPES] });
        setNotice('Confirm community storage access in the Civitai dialog, then try again.');
        return false;
      }
      setBusyKey(busy);
      setNotice(null);
      try {
        await fn();
        await refresh();
        setBusyKey((cur) => (cur === busy ? null : cur));
        if (successNote) setNotice(successNote);
        return true;
      } catch (error) {
        writeFailed(error, busy);
        return false;
      }
    },
    [refresh, requestConsent, requireViewer, writeFailed],
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
      const ok = await runWrite('create-dataset', async () => {
        await sharedRef.current.append(datasetSharedValue(record));
      });
      if (!ok) return 'That did not save — community storage may not be granted yet.';
      setRoute({ name: 'dataset', datasetId: record.datasetId });
      return null;
    },
    [requestSignIn, runWrite, viewerId, viewerName],
  );

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
      const ok = await runWrite('edit-dataset', async () => {
        await upsertOwnSharedEntry(
          sharedRef.current,
          entries,
          viewerId,
          (d) => d.kind === 'dataset' && d.datasetId === datasetId,
          datasetSharedValue(record),
          existing.storageKey,
        );
      });
      if (!ok) return 'That did not save — community storage may not be granted yet.';
      setRoute({ name: 'dataset', datasetId });
      return null;
    },
    [entries, folded.datasets, runWrite, viewerId],
  );

  const deleteDataset = useCallback(
    async (datasetId: string): Promise<boolean> => {
      const existing = folded.datasets.find((d) => d.datasetId === datasetId);
      if (!existing || viewerId == null) return false;
      if (existing.ownerId !== viewerId) {
        setNotice('Only the dataset owner can delete it.');
        return false;
      }
      return runWrite(`delete-dataset-${datasetId}`, async () => {
        const datasetItems = folded.items.filter((item) => item.datasetId === datasetId);
        const itemIds = new Set(datasetItems.map((item) => item.itemId));
        // Remove the dataset's visible contents first. The owner's own
        // entries are withdrawn; another contributor's item gets the same
        // removal record the detail screen writes, so the fold hides it.
        for (const item of datasetItems) {
          if (folded.removals.some((r) => r.itemId === item.itemId)) continue;
          if (item.contributorId === viewerId && item.storageKey) {
            const withdrawn = await sharedRef.current.withdraw(item.storageKey);
            if (!withdrawn.deleted) throw new Error('an item record was not withdrawn');
          } else {
            await sharedRef.current.append(
              removalSharedValue({
                itemId: item.itemId,
                datasetId,
                actorId: viewerId,
                reason: 'owner-remove',
                createdAt: new Date().toISOString(),
              }),
            );
          }
        }
        // The viewer can withdraw their own votes on the dataset/items;
        // votes left by other viewers point at records that no longer fold.
        for (const vote of folded.votes) {
          if (
            vote.voterId === viewerId &&
            vote.storageKey &&
            ((vote.targetKind === 'dataset' && vote.targetId === datasetId) ||
              (vote.targetKind === 'item' && itemIds.has(vote.targetId)))
          ) {
            await sharedRef.current.withdraw(vote.storageKey);
          }
        }
        // Frozen snapshots and LoRA links belong to the dataset's training
        // history; withdrawing them keeps a deleted scratch dataset from
        // resurfacing through LoRA detail or the contributor ledger.
        for (const snapshot of folded.snapshots.filter((s) => s.datasetId === datasetId)) {
          const key = folded.snapshotStorageKeys.get(snapshot.snapshotId);
          if (key) {
            const withdrawn = await sharedRef.current.withdraw(key);
            if (!withdrawn.deleted) throw new Error('a snapshot record was not withdrawn');
          }
        }
        for (const lora of folded.loras.filter((l) => l.datasetId === datasetId)) {
          if (lora.storageKey) {
            const withdrawn = await sharedRef.current.withdraw(lora.storageKey);
            if (!withdrawn.deleted) throw new Error('a LoRA record was not withdrawn');
          }
        }
        if (!existing.storageKey) throw new Error('dataset record has no storage key to withdraw');
        const withdrawn = await sharedRef.current.withdraw(existing.storageKey);
        if (!withdrawn.deleted) throw new Error('dataset record was not withdrawn');
        setRoute({ name: 'explore' });
      }, 'Dataset deleted.');
    },
    [folded, runWrite, viewerId],
  );

  const castVote = useCallback(
    async (targetKind: 'dataset' | 'item', targetId: string, clicked: 1 | -1) => {
      if (!requireViewer() || viewerId == null) return;
      const current = viewerVoteRecord(folded.votes, viewerId, targetKind, targetId);
      const record = {
        voterId: viewerId,
        targetKind,
        targetId,
        value: nextVoteValue(current?.value ?? 0, clicked),
        updatedAt: new Date().toISOString(),
      };
      await runWrite(`vote-${targetKind}-${targetId}`, async () => {
        await upsertOwnSharedEntry(
          sharedRef.current,
          entries,
          viewerId,
          (d) =>
            d.kind === 'vote' &&
            d.voterId === viewerId &&
            d.targetKind === targetKind &&
            d.targetId === targetId,
          voteSharedValue(record),
          current?.storageKey,
        );
      });
    },
    [entries, folded.votes, requireViewer, runWrite, viewerId],
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
      const ok = await runWrite('contribute', async () => {
        await sharedRef.current.append(itemSharedValue(record));
      }, 'Item contributed. It joins the training set once its net votes are positive.');
      return ok ? null : 'That did not save — community storage may not be granted yet.';
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
          const res = await sharedRef.current.withdraw(item.storageKey);
          if (res.deleted) return;
        }
        await sharedRef.current.append(
          removalSharedValue({
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
      if (folded.snapshots.some((s) => s.snapshotId === snapshot.snapshotId)) return;
      const dataset = folded.datasets.find((d) => d.datasetId === snapshot.datasetId);
      await sharedRef.current.append(snapshotSharedValue(snapshot, dataset?.name ?? snapshot.datasetId));
      await refresh();
    },
    [folded.datasets, folded.snapshots, refresh],
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
      await sharedRef.current.append(ledgerSharedValue(event));
      await refresh();
    },
    [folded.ledgerEvents, refresh],
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
        ...(link.publishedModel
          ? {
              modelId: link.publishedModel.modelId,
              modelVersionId: link.publishedModel.modelVersionId,
              published: link.publishedModel.published,
            }
          : {}),
        updatedAt: now,
      };
      if (existing?.storageKey) await sharedRef.current.update(existing.storageKey, loraSharedValue(next));
      else if (!existing) await sharedRef.current.append(loraSharedValue(next));
      await refresh();
    },
    [folded.datasets, folded.loras, refresh, viewerId, viewerName],
  );

  // ------------------------------------------------------------- routing

  const selectedDataset =
    route.name === 'dataset' || route.name === 'train' || route.name === 'edit'
      ? view.datasets.find((d) => d.datasetId === route.datasetId)
      : undefined;
  const selectedLora = route.name === 'lora' ? view.loras.find((l) => l.loraId === route.loraId) : undefined;
  const explored = useMemo(
    () => filterAndSortDatasets(view.datasets, { query, sort }),
    [query, sort, view.datasets],
  );

  return (
    <div data-testid="dc-community" data-theme={theme} data-dc-archive="true" style={rootStyle}>
      <Stack gap={16}>
        <div style={headerStyle}>
          <div>
            <div style={titleStyle}>Open Datasets</div>
            <span style={hintStyle}>
              Assemble datasets together, vote items in, train LoRAs, and track contributor shares.
            </span>
          </div>
          <div style={headerActionsStyle}>
            <Button variant="subtle" size="sm" onClick={() => setRoute({ name: 'ledger' })} data-testid="dc-open-ledger">
              My contributions
            </Button>
            <Button
              variant="subtle"
              size="sm"
              onClick={toggleTheme}
              data-testid="dc-community-theme-toggle"
            >
              {theme === 'dark' ? 'Light override' : 'Back to dark (default)'}
            </Button>
          </div>
        </div>

        {notice && (
          <Alert color="info" withCloseButton onClose={() => setNotice(null)} data-testid="dc-community-notice">
            {notice}
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
                onClick={() => requestConsent({ scopes: [...SHARED_STORAGE_SCOPES] })}
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

        {loadState === 'ready' && route.name === 'explore' && (
          <Stack gap={12}>
            <div style={toolbarStyle}>
              <input
                style={inputStyle}
                value={query}
                placeholder="Search datasets…"
                onChange={(e) => setQuery(e.target.value)}
                data-testid="dc-explore-search"
              />
              <select
                style={inputStyle}
                value={sort}
                onChange={(e) => setSort(e.target.value as ExploreSort)}
                data-testid="dc-explore-sort"
              >
                <option value="top-voted">Top voted</option>
                <option value="newest">Newest</option>
                <option value="most-trained">Most trained</option>
              </select>
              <Button
                onClick={() => (viewerId == null ? requestSignIn() : setRoute({ name: 'create' }))}
                data-testid="dc-create-dataset"
              >
                Create dataset
              </Button>
            </div>

            {explored.length === 0 ? (
              <div style={cardStyle} data-testid="dc-explore-empty">
                <span style={cardTitleStyle}>No datasets yet</span>
                <span style={hintStyle}>
                  {view.datasets.length === 0
                    ? 'Be the first: create a dataset, contribute images, and let the community vote the training set in.'
                    : 'Nothing matches that search. Try a different term, or create the dataset yourself.'}
                </span>
                <span>
                  <Button
                    onClick={() => (viewerId == null ? requestSignIn() : setRoute({ name: 'create' }))}
                    data-testid="dc-create-first-dataset"
                  >
                    Create the first dataset
                  </Button>
                </span>
              </div>
            ) : (
              <div className="od-grid-cards">
              {explored.map((dataset) => (
                <div key={dataset.datasetId} style={{ ...cardStyle, cursor: 'pointer' }} data-testid="dc-dataset-card" onClick={() => setRoute({ name: 'dataset', datasetId: dataset.datasetId })}>
                  <div style={itemHeadStyle}>
                    <span style={cardTitleStyle}>{dataset.name}</span>
                    <Badge color="info" variant="light">{dataset.netVotes} net votes</Badge>
                  </div>
                  <span style={hintStyle}>
                    by {dataset.ownerName} · {dataset.items.filter((i) => !i.removed).length} items ·{' '}
                    {dataset.trainableCount} trainable · {dataset.loraCount} trained LoRA
                    {dataset.loraCount === 1 ? '' : 's'}
                  </span>
                  {dataset.description && <span>{dataset.description}</span>}
                  {dataset.targetNote && <span style={hintStyle}>Target: {dataset.targetNote}</span>}
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
              ))}
              </div>
            )}
            <span style={hintStyle}>{COSMETIC_TRUST_LINE}</span>
          </Stack>
        )}

        {loadState === 'ready' && route.name === 'create' && (
          <DatasetForm
            title="Create dataset"
            submitLabel="Create dataset"
            onCancel={() => setRoute({ name: 'explore' })}
            onSubmit={createDataset}
          />
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
            dataset={selectedDataset}
            loras={view.loras.filter((l) => l.datasetId === selectedDataset.datasetId)}
            viewerId={viewerId}
            busyKey={busyKey}
            onBack={() => setRoute({ name: 'explore' })}
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
              hideThemeToggle
              canOwnerOverride={viewerId != null && selectedDataset.ownerId === viewerId}
              allowLocalUploads={false}
              onSnapshotConfirmed={persistSnapshot}
              onLedgerEvent={persistLedgerEvent}
              onRunLinked={persistRunLink}
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
      >
        ↓
      </Button>
    </span>
  );
}

function DatasetForm(props: {
  title: string;
  submitLabel: string;
  initial?: DatasetRecord;
  onCancel: () => void;
  onSubmit: (input: { name: string; description: string; targetNote: string }) => Promise<string | null>;
}) {
  const [name, setName] = useState(props.initial?.name ?? '');
  const [description, setDescription] = useState(props.initial?.description ?? '');
  const [targetNote, setTargetNote] = useState(props.initial?.targetNote ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const checked = validateDatasetInput({ name, description, targetNote });
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
      <span style={cardTitleStyle}>{props.title}</span>
      <label style={labelStyle}>
        Name
        <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} data-testid="dc-dataset-name" />
      </label>
      <label style={labelStyle}>
        Description
        <textarea
          style={textareaStyle}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          data-testid="dc-dataset-description"
        />
      </label>
      <label style={labelStyle}>
        Target note
        <input
          style={inputStyle}
          value={targetNote}
          placeholder="e.g. SDXL character LoRA"
          onChange={(e) => setTargetNote(e.target.value)}
          data-testid="dc-dataset-target"
        />
      </label>
      <span style={hintStyle}>Datasets are public in v1 — there is no private-dataset switch yet.</span>
      {error && (
        <Alert color="error" title="Could not save" data-testid="dc-dataset-form-error">
          {error}
        </Alert>
      )}
      <div style={rowStyle}>
        <Button loading={saving} onClick={() => void submit()} data-testid="dc-dataset-save">
          {props.submitLabel}
        </Button>
        <Button variant="subtle" onClick={props.onCancel} data-testid="dc-dataset-cancel">
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ContributeForm(props: {
  onContribute: (input: { imageRef: string; imageId?: number; caption: string }) => Promise<string | null>;
}) {
  const { open: openUpload } = useImageUpload();
  const [reference, setReference] = useState('');
  const [caption, setCaption] = useState('');
  const [rights, setRights] = useState(false);
  const [uploaded, setUploaded] = useState<{ imageId: number; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const upload = async () => {
    const picked = await openUpload();
    if (!picked) return;
    setUploaded({ imageId: picked.imageId, url: picked.url });
    setReference(picked.url);
    setError(null);
  };

  const submit = async () => {
    let imageRef = reference.trim();
    let imageId: number | undefined = uploaded?.imageId;
    if (!uploaded) {
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
  };

  return (
    <div style={subCardStyle} data-testid="dc-contribute">
      <span style={cardTitleStyle}>Contribute an image</span>
      <label style={labelStyle}>
        Civitai image URL or ID
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
      <span>
        <Button size="sm" variant="light" onClick={() => void upload()} data-testid="dc-contribute-upload">
          Upload an image instead
        </Button>
        {uploaded && (
          <span style={hintStyle} data-testid="dc-contribute-uploaded">
            {' '}
            Uploaded image #{uploaded.imageId} selected.
          </span>
        )}
      </span>
      <label style={labelStyle}>
        Caption (the training text)
        <input
          style={inputStyle}
          value={caption}
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
      {error && (
        <Alert color="error" title="Could not contribute" data-testid="dc-contribute-error">
          {error}
        </Alert>
      )}
      <span>
        <Button loading={saving} onClick={() => void submit()} data-testid="dc-contribute-submit">
          Add to dataset
        </Button>
      </span>
    </div>
  );
}

function DatasetDetail(props: {
  dataset: DatasetView;
  loras: LoraView[];
  viewerId: number | null;
  busyKey: string | null;
  onBack: () => void;
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
  const { getImages } = useGatedImages();
  const [gatedImages, setGatedImages] = useState<ReadonlyMap<number, BlockGatedImage>>(new Map());
  useEffect(() => {
    let alive = true;
    if (imageIds.length === 0) {
      setGatedImages(new Map());
      return () => {
        alive = false;
      };
    }
    void getImages(imageIds)
      .then((images) => {
        if (alive) setGatedImages(new Map(images.map((image) => [image.imageId, image])));
      })
      .catch(() => {
        if (alive) setGatedImages(new Map());
      });
    return () => {
      alive = false;
    };
  }, [getImages, imageIds]);
  const isOwner = viewerId != null && dataset.ownerId === viewerId;
  const liveItems = dataset.items.filter((i) => !i.removed);

  return (
    <Stack gap={12} data-testid="dc-dataset-detail">
      <span>
        <Button variant="subtle" size="sm" onClick={props.onBack} data-testid="dc-back-explore">
          ← Explore
        </Button>
      </span>
      <div style={itemHeadStyle}>
        <span style={titleStyle}>{dataset.name}</span>
        <VoteControl
          net={dataset.netVotes}
          viewerVote={dataset.viewerVote}
          busy={props.busyKey === `vote-dataset-${dataset.datasetId}`}
          testIdPrefix="dc-dataset"
          onVote={(v) => (viewerId == null ? props.onSignIn() : props.onVote('dataset', dataset.datasetId, v))}
        />
      </div>
      <span style={hintStyle}>
        by {dataset.ownerName} · {liveItems.length} items · {dataset.trainableCount} trainable now · public in v1
      </span>
      {dataset.description && <span>{dataset.description}</span>}
      {dataset.targetNote && <span style={hintStyle}>Target: {dataset.targetNote}</span>}

      <div style={rowStyle}>
        {dataset.items.length === 0 ? (
          <Button
            onClick={() =>
              document.getElementById('dc-contribute-anchor')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
            data-testid="dc-add-first-image"
          >
            Add the first image
          </Button>
        ) : (
          <Button onClick={() => (viewerId == null ? props.onSignIn() : props.onTrain())} data-testid="dc-open-train">
            Train a LoRA from this dataset
          </Button>
        )}
        {isOwner && (
          <Button variant="light" onClick={props.onEdit} data-testid="dc-edit-dataset">
            Edit dataset
          </Button>
        )}
        {isOwner && (
          <Button variant="subtle" color="red" onClick={props.onDelete} data-testid="dc-delete-dataset">
            Delete dataset
          </Button>
        )}
      </div>
      {dataset.trainableCount === 0 && (
        <Alert color="warning" title="Nothing trainable yet" data-testid="dc-no-trainable">
          {dataset.items.length === 0
            ? 'This dataset has no items yet. Contribute the first image below.'
            : 'Every live item is net-negative or at zero right now, so a training snapshot would be empty. Upvote the items that belong in the training set.'}
        </Alert>
      )}

      {props.loras.length > 0 && (
        <div style={subCardStyle} data-testid="dc-dataset-loras">
          <span style={cardTitleStyle}>LoRAs trained from this dataset</span>
          {props.loras.map((lora) => (
            <div key={lora.loraId} style={rowStyle}>
              <span>
                {lora.name} · {lora.published ? 'published' : 'not published yet'} · snapshot{' '}
                {lora.snapshot?.items.filter((i) => i.included).length ?? 0} items
              </span>
              <Button size="sm" variant="light" onClick={() => props.onOpenLora(lora.loraId)} data-testid={`dc-open-lora-${lora.loraId}`}>
                Open LoRA
              </Button>
            </div>
          ))}
        </div>
      )}

      <span style={cardTitleStyle}>Items</span>
      {dataset.items.length === 0 ? (
        <span style={hintStyle} data-testid="dc-dataset-no-items">
          No items yet — contribute the first image below.
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
                    Image is still being rated — check back shortly.
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
              ) : /^https?:\/\//.test(item.imageRef) ? (
                <img src={item.imageRef} alt={item.caption} style={imageStyle} data-testid={`dc-item-image-${item.itemId}`} />
              ) : (
                <span style={hintStyle}>Image reference #{item.imageRef}</span>
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
        <ContributeForm onContribute={props.onContribute} />
      )}
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
  const creditedRef = useRef<string | null>(null);

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
    if (!body) return;
    setPhase('estimating');
    setError(null);
    try {
      const est = await estimate(body);
      const cost = est.cost?.total;
      if (cost == null || !Number.isFinite(cost) || cost < 0) {
        setError('The generator returned no usable price, so there is nothing honest to confirm against. No Buzz was charged.');
        setPhase('idle');
        return;
      }
      setQuote(cost);
      setPhase('quoted');
    } catch {
      setError('Could not price that generation just now. No Buzz was charged.');
      setPhase('idle');
    }
  }, [buildBody, estimate]);

  const onEstimateClick = () => {
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

  const onConfirm = async () => {
    const body = buildBody();
    if (!body || quote == null || insufficient) return;
    setPhase('submitting');
    setError(null);
    try {
      let snap = await submit(body);
      setPhase('polling');
      for (let attempt = 0; attempt < 60 && (snap.status === 'pending' || snap.status === 'processing'); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        snap = await poll(snap.workflowId);
      }
      if (snap.status !== 'succeeded') {
        setError(
          snap.status === 'failed' || snap.status === 'expired' || snap.status === 'canceled'
            ? `That generation ${snap.status}. Check the run before assuming any charge.`
            : 'That generation is still running — check again in a moment.',
        );
        setPhase('idle');
        return;
      }
      setImageUrl(firstImageUrl(snap));
      await refetchBalance();
      const gross = snap.cost?.total;
      if (gross != null && gross > 0 && creditedRef.current !== snap.workflowId) {
        creditedRef.current = snap.workflowId;
        try {
          await props.onLedgerEvent(
            generationLedgerEvent({ lora, workflowId: snap.workflowId, grossBuzz: gross }),
          );
        } catch {
          creditedRef.current = null;
          props.onNotice('The generation succeeded, but saving its tracked-credit event failed. Refresh before relying on the ledger.');
        }
      } else if (gross == null) {
        props.onNotice('The generation finished without a reported cost, so no tracked credit was recorded for it.');
      }
      setPhase('idle');
    } catch {
      setError('That generation did not submit cleanly. If no run appears above, no Buzz was charged.');
      setPhase('idle');
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
              onChange={(e) => setPrompt(e.target.value)}
              data-testid="dc-lora-prompt"
            />
            {phase !== 'quoted' ? (
              <Button loading={phase === 'estimating'} onClick={onEstimateClick} data-testid="dc-lora-estimate">
                Price test generation
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
    (v) => viewerId != null && v.voterId === viewerId && v.targetKind === 'dataset' && v.value !== 0,
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
                  {voteRow.value === 1 ? 'up' : 'down'}
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

const rootStyle: React.CSSProperties = {
  background: 'var(--dc-archive-bg, var(--civitai-color-surface-2))',
  color: 'var(--civitai-color-text)',
  borderRadius: 6,
  padding: 12,
};
const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  alignItems: 'flex-start',
  flexWrap: 'wrap',
};
const headerActionsStyle: React.CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap' };
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
