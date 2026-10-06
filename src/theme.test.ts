import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Archive Lab theme contract (spec §8 + Zacx's standing dark-mode rule):
// dark is the default, nothing follows the browser/OS scheme, and light
// exists only under the explicit in-app override.

const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const indexCss = readFileSync(new URL('./index.css', import.meta.url), 'utf8');
const trainFlow = readFileSync(new URL('./TrainFlow.tsx', import.meta.url), 'utf8');
const appTsx = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

describe('Archive Lab theme', () => {
  it('the boot document never follows the OS scheme', () => {
    expect(indexHtml).not.toContain('@media (prefers-color-scheme');
    expect(indexHtml).toContain('content="dark"');
    expect(indexHtml).toContain('data-theme="dark"');
  });

  it('the stylesheet defaults to dark with no scheme media query', () => {
    expect(indexCss).not.toContain('@media (prefers-color-scheme');
    expect(indexCss).toContain('color-scheme: dark;');
  });

  it('Archive Lab tokens are scoped overrides, amber reserved for the ledger', () => {
    expect(indexCss).toContain("[data-dc-archive]");
    expect(indexCss).toContain('--civitai-color-primary: #25c2d8');
    expect(indexCss).toContain('--civitai-color-warning: #e8a33d');
    // Light exists ONLY under the explicit override selector.
    expect(indexCss).toContain("[data-dc-archive][data-theme='light']");
  });

  it('Sharpened palette deepens the base and unifies shell + archive surfaces', () => {
    expect(indexCss).toContain('--dc-archive-bg: #0b1116');
    expect(indexCss).toContain('--civitai-color-surface: #121c24');
    expect(indexCss).toContain('--civitai-color-surface-2: #1a2833');
    expect(indexCss).toContain('--civitai-color-text: #eef3f5');
    expect(indexCss).toContain('--civitai-color-text-dimmed: #9aa7b1');
    // The app shell roots carry the archive scope too, so the mode switch and
    // generation sample use the same cyan/surface family as Community/Train.
    expect(appTsx).toContain('data-dc-archive="true"');
    expect(appTsx).toContain("background: 'var(--dc-archive-bg, var(--civitai-color-surface-2))'");
    // Boot skeleton paints the same deepened base before the bundle lands.
    expect(indexHtml).toContain('background: #0b1116;');
    expect(indexHtml).toContain('background: #121c24;');
  });

  it('the Train surface roots at data-theme=dark and toggles light explicitly', () => {
    expect(trainFlow).toContain("useState<'dark' | 'light'>('dark')");
    expect(trainFlow).toContain('data-testid="dc-theme-root"');
    expect(trainFlow).toContain('data-testid="dc-theme-toggle"');
  });
});
