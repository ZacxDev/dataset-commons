import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Archive Lab theme contract (spec §8 + Zacx's standing dark-mode rule):
// dark only — the app never follows the browser/OS scheme, and there is no
// light theme anywhere: no toggle, no override selector, no light tokens.

const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const indexCss = readFileSync(new URL('./index.css', import.meta.url), 'utf8');
const trainFlow = readFileSync(new URL('./TrainFlow.tsx', import.meta.url), 'utf8');
const appTsx = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const communityTsx = readFileSync(new URL('./Community.tsx', import.meta.url), 'utf8');

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

  it('there is no light theme anywhere', () => {
    expect(indexCss).not.toContain("[data-dc-archive][data-theme='light']");
    expect(indexCss).not.toContain('color-scheme: light');
    expect(communityTsx).not.toContain('Light override');
    expect(trainFlow).not.toContain('Light override');
    expect(communityTsx).not.toContain('dc-community-theme-toggle');
    expect(trainFlow).not.toContain('dc-theme-toggle');
  });

  it('Archive Lab tokens are scoped overrides, amber reserved for the ledger', () => {
    expect(indexCss).toContain("[data-dc-archive]");
    expect(indexCss).toContain('--civitai-color-primary: #25c2d8');
    expect(indexCss).toContain('--civitai-color-warning: #e8a33d');
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

  it('the layout is full-width on desktop with responsive card/item grids', () => {
    // Shell card no longer caps at 640px; grids take over per-view density.
    expect(appTsx).toContain("maxWidth: 'none'");
    expect(indexCss).toContain('.od-grid-cards');
    expect(indexCss).toContain('.od-grid-items');
    expect(indexCss).toContain('@media (min-width: 1184px)');
    expect(indexCss).toContain('@media (min-width: 1024px)');
    expect(communityTsx).toContain('className="od-grid-cards"');
    expect(communityTsx).toContain('className="od-grid-items"');
    expect(trainFlow).toContain('className="od-grid-items"');
  });

  it('the Train surface roots at data-theme=dark with no toggle', () => {
    expect(trainFlow).toContain('data-theme="dark"');
    expect(trainFlow).toContain('data-testid="dc-theme-root"');
    expect(trainFlow).not.toContain("useState<'dark' | 'light'>");
  });

  it('the Community surface roots at data-theme=dark with no toggle', () => {
    expect(communityTsx).toContain('data-theme="dark"');
    expect(communityTsx).toContain('data-testid="dc-community"');
  });
});
