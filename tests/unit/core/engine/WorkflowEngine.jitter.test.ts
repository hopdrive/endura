/**
 * Backoff jitter (Phase 3) — retry delays are jittered so a burst of
 * failures (connectivity drop, server outage) doesn't reschedule every
 * task onto the same instant. Equal jitter by default: the retry lands
 * uniformly in [delay/2, delay]. The RNG is injectable for determinism.
 */

import { describe, it, expect, vi } from 'vitest';
import { calculateBackoffDelay } from '../../../../src/core/utils';
import { WorkflowEngine } from '../../../../src/core/engine';
import { InMemoryStorage } from '../../../../src/storage/memory';
import { MockClock, MockScheduler, MockEnvironment } from '../../../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../../../src/core/definitions';
import { createLoopbackDispatcher } from '../../../../src/workers/loopback';

describe('calculateBackoffDelay jitter', () => {
  it('defaults to no jitter (pure exponential) for direct callers', () => {
    expect(calculateBackoffDelay(1, 1000, 2)).toBe(1000);
    expect(calculateBackoffDelay(3, 1000, 2)).toBe(4000);
  });

  it('equal jitter spans [delay/2, delay]', () => {
    expect(calculateBackoffDelay(1, 1000, 2, undefined, { jitter: 'equal', random: () => 0 })).toBe(500);
    expect(calculateBackoffDelay(1, 1000, 2, undefined, { jitter: 'equal', random: () => 1 })).toBe(1000);
    expect(calculateBackoffDelay(1, 1000, 2, undefined, { jitter: 'equal', random: () => 0.5 })).toBe(750);
  });

  it('full jitter spans [0, delay]', () => {
    expect(calculateBackoffDelay(1, 1000, 2, undefined, { jitter: 'full', random: () => 0 })).toBe(0);
    expect(calculateBackoffDelay(1, 1000, 2, undefined, { jitter: 'full', random: () => 1 })).toBe(1000);
  });

  it('caps at maximumInterval before jittering', () => {
    expect(calculateBackoffDelay(10, 1000, 2, 8000, { jitter: 'equal', random: () => 1 })).toBe(8000);
    expect(calculateBackoffDelay(10, 1000, 2, 8000, { jitter: 'equal', random: () => 0 })).toBe(4000);
  });
});

describe('engine retry jitter', () => {
  async function createEngine(random: () => number) {
    const clock = new MockClock(1000000);
    const storage = new InMemoryStorage();
    const engine = await WorkflowEngine.create({
      dispatcher: createLoopbackDispatcher(),
      storage,
      clock,
      scheduler: new MockScheduler(clock),
      environment: new MockEnvironment({ isConnected: true, batteryLevel: 1 }),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      random,
    });
    return { engine, storage, clock };
  }

  async function failOnceAndGetRetry(random: () => number) {
    const { engine, storage, clock } = await createEngine(random);
    const flaky = defineActivity({
      name: 'flaky',
      execute: async () => {
        throw new Error('boom');
      },
      retry: { maximumAttempts: 3, initialInterval: 1000, backoffCoefficient: 2 },
    });
    const workflow = defineWorkflow({ name: 'jittered', activities: [flaky] });
    const execution = await engine.start(workflow, { input: {} });

    await engine.tick();

    const tasks = await storage.getActivityTasksForExecution(execution.runId);
    const retried = tasks.find(t => t.status === 'pending');
    engine.stop();
    return { retried, now: clock.now() };
  }

  it('applies equal jitter to retry scheduling by default', async () => {
    // random() => 0 pins equal jitter to its lower bound: half the delay.
    const { retried, now } = await failOnceAndGetRetry(() => 0);
    expect(retried?.scheduledFor).toBe(now + 500);
  });

  it('random() => 1 reproduces the un-jittered upper bound', async () => {
    const { retried, now } = await failOnceAndGetRetry(() => 1);
    expect(retried?.scheduledFor).toBe(now + 1000);
  });
});
