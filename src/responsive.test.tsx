import { describe, expect, it } from 'vitest';

import { resolveBlockTier } from '@civitai/blocks-react';

// The block breakpoint scale, pinned. The width-adaptive Model-row tests that
// used to live here covered the scaffold generation sample, removed in the
// 2026-10-06 single-view consolidation; the responsive layout itself is now
// CSS-grid driven (see src/index.css `.od-*` classes and theme.test.ts).
//
// 🔴 Civitai's block scale is CSS px — xs 480 · sm 768 · md 1024 · lg 1184 ·
// xl 1440 — and it is NOT Mantine's stock em scale (576 / 768 / 992 / 1200 /
// 1408). The two agree on `sm` (768) and NOWHERE else, so a test that pins
// `sm` alone passes against the entirely wrong scale. Every case below is one
// of the four values that DISCRIMINATE, plus the pixel underneath it.
//
// Why assert a scale you do not own: your layout's thresholds are chosen
// against these numbers, and they are also what you must write out by hand in
// CSS (a query prelude cannot read `--civitai-bp-*` — see index.css). If the
// pack ever moves them, this is the line that says so.
describe('the block breakpoint scale', () => {
  it.each([
    [1, 'base'],
    [479, 'base'],
    [480, 'xs'],
    [767, 'xs'],
    [768, 'sm'],
    [1023, 'sm'],
    [1024, 'md'],
    [1183, 'md'],
    [1184, 'lg'],
    [1439, 'lg'],
    [1440, 'xl'],
  ])('%ipx resolves to %s', (width, tier) => {
    expect(resolveBlockTier(width as number)).toBe(tier);
  });

  it('an unmeasured width resolves to the conservative tier', () => {
    // 0 / NaN mean "not measured yet", not "very narrow" — but `base` is the
    // right answer for both, and it is why the App does not need to gate on
    // `measured`.
    expect(resolveBlockTier(0)).toBe('base');
    expect(resolveBlockTier(Number.NaN)).toBe('base');
  });
});
