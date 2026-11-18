import type { BlockWorkflowSnapshot } from '@civitai/app-sdk/blocks';
import { describe, expect, it } from 'vitest';

import { runGenerationToEnd, type GenerationRunDeps } from './generation.js';

// runGenerationToEnd: a submit failure and a lost poll are different outcomes.
// Every script below is literal; the clock is virtual (sleep advances it).

const snap = (workflowId: string, status: string, extra: Partial<BlockWorkflowSnapshot> = {}) =>
  ({ workflowId, status, ...extra }) as BlockWorkflowSnapshot;

/** Deps whose polls answer from `script` in order (a function throws). */
function deps(
  submitReply: BlockWorkflowSnapshot | Error,
  script: Array<BlockWorkflowSnapshot | Error>,
  visible = true,
): GenerationRunDeps<string> & { sleeps: number[]; polls: number } {
  let clock = 0;
  const state = {
    sleeps: [] as number[],
    polls: 0,
    submit: async () => {
      if (submitReply instanceof Error) throw submitReply;
      return submitReply;
    },
    poll: async () => {
      const next = script[Math.min(state.polls, script.length - 1)]!;
      state.polls += 1;
      if (next instanceof Error) throw next;
      return next;
    },
    sleep: async (ms: number) => {
      state.sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    visible: () => visible,
  };
  return state;
}

const FAILURE_PLACEHOLDER = snap('failed', 'failed', { error: 'block token expired' });

describe('runGenerationToEnd', () => {
  it('a thrown submit is submit-failed', async () => {
    expect(await runGenerationToEnd('body', deps(new Error('network'), []))).toEqual({
      kind: 'submit-failed',
      detail: 'network',
    });
  });

  it("a submit the host refused (its 'failed' sentinel) is submit-failed with the host's reason", async () => {
    const d = deps(snap('failed', 'failed', { error: 'over the spend cap' }), []);
    expect(await runGenerationToEnd('body', d)).toEqual({ kind: 'submit-failed', detail: 'over the spend cap' });
    expect(d.polls).toBe(0);
  });

  it('a thrown poll after submit is lost contact, re-polled, and the run still succeeds', async () => {
    const done = snap('wf1', 'succeeded', { imageUrls: ['https://image.civitai.com/x.jpeg'] });
    const d = deps(snap('wf1', 'processing'), [new Error('transport closed'), new Error('transport closed'), done]);
    expect(await runGenerationToEnd('body', d)).toEqual({ kind: 'succeeded', snapshot: done });
    // 1s first poll, then the lost-contact backoff 1s, 2s.
    expect(d.sleeps).toEqual([1000, 1000, 2000]);
  });

  it("the host's failure placeholder is lost contact, never the run's verdict", async () => {
    const done = snap('wf1', 'succeeded');
    const d = deps(snap('wf1', 'pending'), [FAILURE_PLACEHOLDER, done]);
    expect(await runGenerationToEnd('body', d)).toEqual({ kind: 'succeeded', snapshot: done });
  });

  it('gives up as lost contact after five minutes of visible unanswered polls', async () => {
    const d = deps(snap('wf1', 'processing'), [new Error('down')]);
    const outcome = await runGenerationToEnd('body', d);
    expect(outcome).toEqual({ kind: 'lost-contact', workflowId: 'wf1', detail: 'down' });
    // Backoff 1,2,4,8,16,32,60,60,60,60,60 s: the 5-minute clock (started at the
    // first failure) runs out at the 11th failure.
    expect(d.polls).toBe(11);
  });

  it('a hidden tab never runs the give-up clock but still stops after 30 unanswered polls', async () => {
    const d = deps(snap('wf1', 'processing'), [FAILURE_PLACEHOLDER], false);
    expect(await runGenerationToEnd('body', d)).toEqual({
      kind: 'lost-contact',
      workflowId: 'wf1',
      detail: 'block token expired',
    });
    expect(d.polls).toBe(30);
  });

  it('a terminal non-success is ended; a run still going after 60 answered polls is still-running', async () => {
    const failed = snap('wf1', 'failed');
    expect(await runGenerationToEnd('body', deps(snap('wf1', 'processing'), [failed]))).toEqual({
      kind: 'ended',
      snapshot: failed,
    });
    const d = deps(snap('wf1', 'processing'), [snap('wf1', 'processing')]);
    expect(await runGenerationToEnd('body', d)).toEqual({ kind: 'still-running', workflowId: 'wf1' });
    expect(d.polls).toBe(60);
  });
});
