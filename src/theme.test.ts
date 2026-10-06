import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Archive Lab theme contract (spec §8 + Zacx's standing dark-mode rule):
// dark is the default, nothing follows the browser/OS scheme, and light
// exists only under the explicit in-app override.

const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const indexCss = readFileSync(new URL('./index.css', import.meta.url), 'utf8');
const trainFlow = readFileSync(new URL('./TrainFlow.tsx', import.meta.url), 'utf8');

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
    expect(indexCss).toContain('--civitai-color-primary: #22b8cf');
    expect(indexCss).toContain('--civitai-color-warning: #e8a33d');
    // Light exists ONLY under the explicit override selector.
    expect(indexCss).toContain("[data-dc-archive][data-theme='light']");
  });

  it('the Train surface roots at data-theme=dark and toggles light explicitly', () => {
    expect(trainFlow).toContain("useState<'dark' | 'light'>('dark')");
    expect(trainFlow).toContain('data-testid="dc-theme-root"');
    expect(trainFlow).toContain('data-testid="dc-theme-toggle"');
  });
});
