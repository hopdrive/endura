/**
 * M7 — the test harness must not depend on wall-clock time.
 *
 * runToCompletion previously paced itself with real setTimeout sleeps
 * and a real-time budget, which flakes under CI load. It now drives the
 * engine with a bounded tick loop and the injected MockClock only —
 * proven here by running it under vitest fake timers, where any real
 * timer dependency would hang forever.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestContext, runToCompletion, createTestActivity } from '../../utils/testHelpers';
import { defineWorkflow, defineActivity } from '../../../src/core/definitions';

describe('deterministic test harness (M7)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drives a multi-step workflow to completion without wall-clock timers', async () => {
    vi.useFakeTimers();
    const ctx = await createTestContext();
    try {
      const workflow = defineWorkflow({
        name: 'no-wall-clock',
        activities: [createTestActivity('one'), createTestActivity('two'), createTestActivity('three')],
      });

      const execution = await ctx.engine.start(workflow, { input: {} });
      const final = await runToCompletion(ctx, execution.runId);

      expect(final.status).toBe('completed');
      expect(final.state).toMatchObject({ one: 'done', two: 'done', three: 'done' });
    } finally {
      ctx.engine.stop();
    }
  });

  it('retries through backoff via the mock clock, not real delays', async () => {
    vi.useFakeTimers();
    const ctx = await createTestContext();
    try {
      const workflow = defineWorkflow({
        name: 'backoff-no-wall-clock',
        activities: [
          createTestActivity('flaky', {
            failUntilAttempt: 3,
            retry: { maximumAttempts: 5, initialInterval: 1000 },
          }),
        ],
      });

      const execution = await ctx.engine.start(workflow, { input: {} });
      const final = await runToCompletion(ctx, execution.runId, { advanceClock: true });

      expect(final.status).toBe('completed');
      expect(final.state).toMatchObject({ flaky: 'done', attempt: 3 });
    } finally {
      ctx.engine.stop();
    }
  });

  it('fails fast with a tick budget instead of a wall-clock timeout', async () => {
    vi.useFakeTimers();
    const ctx = await createTestContext();
    try {
      const never = defineActivity({
        name: 'never-ready',
        execute: async () => ({}),
        runWhen: () => ({ ready: false, reason: 'never' }),
      });
      const workflow = defineWorkflow({ name: 'stuck', activities: [never] });

      const execution = await ctx.engine.start(workflow, { input: {} });

      await expect(runToCompletion(ctx, execution.runId, { maxTicks: 5 })).rejects.toThrow(/5 ticks/);
    } finally {
      ctx.engine.stop();
    }
  });
});
