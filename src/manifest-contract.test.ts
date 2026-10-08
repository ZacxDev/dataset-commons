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

  it('declares both storage directions plus the shared scopes (community data contract)', () => {
    // The remaining screens live in shared storage: datasets/items/votes are
    // cross-viewer, so the manifest needs shared read AND write; the viewer's
    // own settings/index need per-viewer read AND write. A missing scope here
    // is the Prompt Lab bug class — storage silently dead in production.
    expect(manifest.scopes).toEqual(
      expect.arrayContaining([
        'apps:storage:read',
        'apps:storage:write',
        'apps:storage:shared:read',
        'apps:storage:shared:write',
      ]),
    );
    for (const scope of [
      'apps:storage:read',
      'apps:storage:write',
      'apps:storage:shared:read',
      'apps:storage:shared:write',
    ]) {
      expect(manifest.scopeJustifications[scope], `justification for ${scope}`).toBeTruthy();
    }
    // No scope creep: exactly the money scope + the four storage scopes.
    expect(manifest.scopes).toHaveLength(5);
  });

  it('page.buzzBudgetPerGen is 1000 — a training quote must fit the per-call budget', () => {
    expect(manifest.page.buzzBudgetPerGen).toBe(1000);
    // The in-code mirror the scaffold keeps in generation.ts must agree.
    expect(PAGE_BUZZ_BUDGET).toBe(manifest.page.buzzBudgetPerGen);
  });

  it('pins the SDK pair that types trainedEpochs / publishedModel', () => {
    expect(pkg.dependencies['@civitai/app-sdk']).toBe('^0.57.0');
    expect(pkg.dependencies['@civitai/blocks-react']).toBe('^0.64.0');
  });
});
