import { describe, expect, it } from 'vitest';

import {
  ALL_APP_SCOPES,
  SHARED_STORAGE_SCOPES,
  classifySharedRead,
  classifyStorageError,
  hasScopes,
  loadSharedEntries,
  loadThemePreference,
  loadViewerIndex,
  safeAppStorageKey,
  saveThemePreference,
  saveViewerIndex,
  upsertOwnSharedEntry,
  type AppStoragePort,
  type SharedListPort,
} from './community-storage.js';
import type { SharedEntryLike } from './community.js';

const entry = (key: string, authorUserId = 5): SharedEntryLike => ({
  key,
  authorUserId,
  value: { title: key, data: { kind: 'vote', targetId: 'a' } },
  createdAt: '2026-10-06T00:00:00.000Z',
  updatedAt: '2026-10-06T00:00:00.000Z',
});

describe('scope contract helpers', () => {
  it('names the four storage scopes plus the budgeted generation scope', () => {
    expect(ALL_APP_SCOPES).toEqual([
      'ai:write:budgeted',
      'apps:storage:read',
      'apps:storage:write',
      'apps:storage:shared:read',
      'apps:storage:shared:write',
    ]);
    expect(hasScopes(ALL_APP_SCOPES, SHARED_STORAGE_SCOPES)).toBe(true);
    expect(hasScopes(['apps:storage:shared:read'], SHARED_STORAGE_SCOPES)).toBe(false);
    expect(hasScopes(undefined, SHARED_STORAGE_SCOPES)).toBe(false);
  });
});

describe('classifyStorageError', () => {
  it('scope-shaped rejections are not-permitted (consent/approval, not retry)', () => {
    expect(classifyStorageError(new Error('shared storage list requires the apps:storage:shared:read scope'))).toBe(
      'not-permitted',
    );
    expect(classifyStorageError(new Error('storage set requires the apps:storage:write scope'))).toBe('not-permitted');
    expect(classifyStorageError('FORBIDDEN')).toBe('not-permitted');
  });

  it('ceilings and transport failures are failed, never permission claims', () => {
    expect(classifyStorageError(new Error('per-user row limit exceeded'))).toBe('failed');
    expect(classifyStorageError(new Error('storage request failed'))).toBe('failed');
    expect(classifyStorageError(new Error('socket closed'))).toBe('failed');
  });
});

describe('classifySharedRead — no fake empty states', () => {
  it('an empty read without the shared read scope is not-permitted, not zero', () => {
    expect(classifySharedRead([], [])).toBe('not-permitted');
    expect(classifySharedRead([], undefined)).toBe('not-permitted');
    expect(classifySharedRead([], ['apps:storage:shared:read'])).toBe('ready');
    expect(classifySharedRead([entry('k')], [])).toBe('ready');
  });
});

describe('loadSharedEntries', () => {
  it('pages until the cursor runs out and reports truncation at the cap', async () => {
    const pages = new Map<string | undefined, { items: SharedEntryLike[]; nextCursor?: string }>([
      [undefined, { items: [entry('a')], nextCursor: 'c1' }],
      ['c1', { items: [entry('b')], nextCursor: 'c2' }],
      ['c2', { items: [entry('c')] }],
    ]);
    const shared: SharedListPort = {
      list: async (opts) => pages.get(opts?.cursor) ?? { items: [] },
      append: async () => ({ key: 'new' }),
      update: async () => undefined,
      withdraw: async () => ({ ok: true, deleted: true }),
    };
    const full = await loadSharedEntries(shared, ['apps:storage:shared:read']);
    expect(full.entries.map((e) => e.key)).toEqual(['a', 'b', 'c']);
    expect(full.access).toBe('ready');
    expect(full.truncated).toBe(false);

    const capped = await loadSharedEntries(shared, ['apps:storage:shared:read'], { maxPages: 1 });
    expect(capped.entries.map((e) => e.key)).toEqual(['a']);
    expect(capped.truncated).toBe(true);
  });

  it('a rejected read classifies instead of throwing or faking empty', async () => {
    const shared: SharedListPort = {
      list: async () => {
        throw new Error('shared storage list requires the apps:storage:shared:read scope');
      },
      append: async () => ({ key: 'new' }),
      update: async () => undefined,
      withdraw: async () => ({ ok: true, deleted: true }),
    };
    const result = await loadSharedEntries(shared, []);
    expect(result).toEqual({ entries: [], access: 'not-permitted', truncated: false });
  });
});

describe('upsertOwnSharedEntry', () => {
  it('updates a known key, adopts an own matching entry, else appends once', async () => {
    const calls: string[] = [];
    const shared: SharedListPort = {
      list: async () => ({ items: [] }),
      append: async () => {
        calls.push('append');
        return { key: 'fresh' };
      },
      update: async (key) => {
        calls.push(`update:${key}`);
      },
      withdraw: async () => ({ ok: true, deleted: true }),
    };
    const value = { title: 'Vote', data: { kind: 'vote', targetId: 'a' } };
    const matches = (d: Record<string, unknown>) => d.kind === 'vote' && d.targetId === 'a';

    expect(await upsertOwnSharedEntry(shared, [], 5, matches, value, 'known')).toEqual({
      key: 'known',
      created: false,
    });
    expect(await upsertOwnSharedEntry(shared, [entry('own-key', 5), entry('other-key', 9)], 5, matches, value)).toEqual({
      key: 'own-key',
      created: false,
    });
    expect(await upsertOwnSharedEntry(shared, [entry('other-key', 9)], 5, matches, value)).toEqual({
      key: 'fresh',
      created: true,
    });
    expect(calls).toEqual(['update:known', 'update:own-key', 'append']);
  });
});

describe('per-viewer app storage', () => {
  function fakeStorage(seed: Record<string, unknown> = {}, failWith?: Error): AppStoragePort & { store: Map<string, unknown> } {
    const store = new Map(Object.entries(seed));
    return {
      store,
      get: async (key) => {
        if (failWith) throw failWith;
        return (store.get(key) as never) ?? null;
      },
      set: async (key, value) => {
        if (failWith) throw failWith;
        store.set(key, value);
        return { ok: true };
      },
      delete: async (key) => ({ ok: true, deleted: store.delete(key) }),
      list: async () => ({ keys: [] }),
      getQuota: async () => ({ usedBytes: 0, rowCount: store.size, limitBytes: 1000, limitRows: 10 }),
    };
  }

  it('round-trips the viewer index and theme; dark is the default theme', async () => {
    const storage = fakeStorage();
    const index = { itemIds: ['a'], voteTargets: ['item:a'], snapshotIds: ['s1'], updatedAt: '2026-10-06T00:00:00.000Z' };
    expect(await saveViewerIndex(storage, 5, index)).toBe('ready');
    expect(await loadViewerIndex(storage, 5)).toEqual({ index, access: 'ready' });
    expect(await loadThemePreference(storage, 5)).toEqual({ theme: 'dark', access: 'ready' });
    expect(await saveThemePreference(storage, 5, 'light')).toBe('ready');
    expect(await loadThemePreference(storage, 5)).toEqual({ theme: 'light', access: 'ready' });
  });

  it('a scope-shaped failure classifies as not-permitted and never fakes a save', async () => {
    const storage = fakeStorage({}, new Error('storage set requires the apps:storage:write scope'));
    expect(await saveViewerIndex(storage, 5, { itemIds: [], voteTargets: [], snapshotIds: [], updatedAt: '' })).toBe(
      'not-permitted',
    );
    expect(await loadViewerIndex(storage, 5)).toEqual({ index: null, access: 'not-permitted' });
  });

  it('caps long keys at 200 chars with a deterministic hash suffix', () => {
    const key = safeAppStorageKey('dc-index', 'x'.repeat(500));
    expect(key.length).toBeLessThanOrEqual(200);
    expect(safeAppStorageKey('dc-index', 'x'.repeat(500))).toBe(key);
    expect(safeAppStorageKey('dc-index', 'y'.repeat(500))).not.toBe(key);
    expect(safeAppStorageKey('dc', 'plain')).toBe('dc:plain');
  });
});
