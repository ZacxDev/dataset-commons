import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { PAGE_BUZZ_BUDGET } from './generation.js';

// Manifest & platform contract for the Train flow (spec §9). These fail the
// build if the platform prerequisites for in-app training drift: the budgeted
// scope, its justification, the 1000-Buzz per-call budget a training quote is
// checked against (the scaffold default of 10/300 refuses training runs), and
// the SDK pair that types trainedEpochs / publishedModel.

interface Manifest {
  blockId: string;
  scopes: string[];
  scopeJustifications: Record<string, string>;
  page: { buzzBudgetPerGen: number };
  storage?: unknown;
  iframe?: Record<string, unknown>;
}

const manifest = JSON.parse(
  readFileSync(new URL('../block.manifest.json', import.meta.url), 'utf8'),
) as Manifest;

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { dependencies: Record<string, string> };

describe('block.manifest.json — training contract', () => {
  it('declares the budgeted scope with an honest justification', () => {
    expect(manifest.blockId).toBe('dataset-commons');
    expect(manifest.scopes).toContain('ai:write:budgeted');
    for (const scope of manifest.scopes) {
      expect(manifest.scopeJustifications[scope], `justification for ${scope}`).toBeTruthy();
    }
  });

  it('declares the document-store scopes and the community collections (the copy contract)', () => {
    // Since 0.2.0 the community lives in the document store. The declaration is
    // a contract with the cutover copy script (copy-dataset-commons-to-appdata.sql
    // and copy-kv-to-appdata.sql): these collection names, the `up`/`down`
    // marks, `write: "own"`, and NO indexes. A missing collection or scope is the
    // Prompt Lab bug class — storage silently dead in production.
    expect([...manifest.scopes].sort()).toEqual(['ai:write:budgeted', 'apps:storage', 'apps:storage:publish']);
    for (const legacy of ['apps:storage:read', 'apps:storage:write', 'apps:storage:shared:read', 'apps:storage:shared:write']) {
      expect(manifest.scopeJustifications).not.toHaveProperty(legacy);
    }
    const voted = { visibility: 'shared', write: 'own', marks: ['up', 'down'] };
    const plain = { visibility: 'shared', write: 'own' };
    expect(manifest.storage).toEqual({
      collections: {
        kv: { visibility: 'private' },
        datasets: voted,
        items: voted,
        snapshots: plain,
        loras: plain,
        ledger: plain,
        removals: plain,
      },
    });
    // `iframe.src` is server-owned; `civitai app validate` refuses it.
    expect(manifest.iframe ?? {}).not.toHaveProperty('src');
  });

  it('page.buzzBudgetPerGen is 1000 — a training quote must fit the per-call budget', () => {
    expect(manifest.page.buzzBudgetPerGen).toBe(1000);
    // The in-code mirror the scaffold keeps in generation.ts must agree.
    expect(PAGE_BUZZ_BUDGET).toBe(manifest.page.buzzBudgetPerGen);
  });

  it('pins the SDK pair that types the training hooks + trainedEpochs / publishedModel', () => {
    // Bumped 2026-10-15 for useImagePicker (blocks-react 0.73 / app-sdk 0.70).
    expect(pkg.dependencies['@civitai/app-sdk']).toBe('^0.70.1');
    expect(pkg.dependencies['@civitai/blocks-react']).toBe('^0.73.2');
  });
});
