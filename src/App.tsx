import { useRef } from 'react';

import { useBlockBreakpoint, useBlockContext, useBlockResize } from '@civitai/blocks-react';
import { Badge, Card, Group, Stack, injectBlocksStyles } from '@civitai/blocks-react/ui';

import { Community } from './Community.js';

// Inject the W6 component pack's stylesheet at module init (before first paint)
// to avoid the documented one-frame FOUC. Idempotent.
injectBlocksStyles();

/**
 * Open Datasets — single-view app shell.
 *
 * The product is ONE view: community datasets with voting, a Train flow reached
 * from each dataset (the snapshot freezes inside that flow), LoRA detail with
 * tracked-share history, and the contributor ledger. The scaffold's Generate /
 * Comfy sample tabs were removed on Zacx's direction (2026-10-06); training is
 * consolidated into the datasets view rather than living behind its own tab.
 *
 * The shell stays deliberately thin: full-width Archive Lab frame, a loading
 * state until the host context is ready, then the Community screens own the
 * rest (brand header included — no double-brand).
 */
export function App() {
  const { ready, theme } = useBlockContext();

  const rootRef = useRef<HTMLDivElement>(null);
  useBlockResize(rootRef);
  const bp = useBlockBreakpoint(rootRef);

  if (!ready) {
    return (
      <div ref={rootRef} data-theme={theme} data-dc-archive="true" data-block-tier={bp.tier} style={shell}>
        <Card padding="lg" style={cardStyle}>
          <Group gap={10}>
            <Badge color="info" variant="light">
              loading
            </Badge>
            <span>Connecting to host…</span>
          </Group>
        </Card>
      </div>
    );
  }

  return (
    <div ref={rootRef} data-theme={theme} data-dc-archive="true" data-block-tier={bp.tier} style={shell}>
      <Card padding="lg" style={cardStyle}>
        <Stack gap={16}>
          <Community />
        </Stack>
      </Card>
    </div>
  );
}

const shell: React.CSSProperties = {
  minHeight: '100%',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  padding: 'clamp(12px, 3vw, 40px)',
  boxSizing: 'border-box',
  background: 'var(--dc-archive-bg, var(--civitai-color-surface-2))',
  color: 'var(--civitai-color-text)',
};

const cardStyle: React.CSSProperties = { width: '100%', maxWidth: 'none' };
