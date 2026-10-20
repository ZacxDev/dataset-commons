/**
 * Dataset Commons — the two storage handles `<Community/>` uses, as hooks:
 * `useCommunityStore()` (the shared collections, replacing `useSharedStorage()`)
 * and `useKvStorage()` (the private `kv`, replacing `useAppStorage()`), both on
 * the document store client from `./doc-storage.ts`.
 *
 * Both handles are STABLE for the life of the component and read the current
 * client at CALL time. The client appears once the host origin and the block
 * token are known; an operation called before that rejects (classified
 * 'failed', never a fake empty).
 */

import { useMemo, useRef } from 'react';

import type { DocumentStorage } from '@civitai/sdk';

import { createCommunityStore, createKvStorage, type CommunityStore, type KvPort } from './community-storage.js';
import { useDocumentStorage, type DocumentStorageSource } from './doc-storage.js';

function useCurrentDocs(): () => Promise<DocumentStorage> {
  const source = useDocumentStorage();
  const ref = useRef<DocumentStorageSource | null>(source);
  ref.current = source;
  return useMemo(
    () => async () => {
      const current = ref.current;
      if (current === null) throw new Error('storage is not available yet');
      return current();
    },
    [],
  );
}

export function useCommunityStore(): CommunityStore {
  const docs = useCurrentDocs();
  return useMemo(() => createCommunityStore(docs), [docs]);
}

export function useKvStorage(): KvPort {
  const docs = useCurrentDocs();
  return useMemo(() => createKvStorage(docs), [docs]);
}

/** True once the client can exist (host origin + token known) — gates the first read. */
export function useStorageReady(): boolean {
  return useDocumentStorage() !== null;
}
