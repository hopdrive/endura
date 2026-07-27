/**
 * Unit Test: WorkflowEngine - Stale-result discard logging (P4 scenario 11).
 *
 * A timed-out handler KEEPS RUNNING in the worker (timeouts never
 * cancel the promise — load-bearing RNQ parity). The abort settles the
 * engine-side attempt immediately, so the worker's eventual reply
 * arrives for a task nobody is waiting on. These tests pin the
 * observability half of the contract: that late reply is LOGGED as
 * discarded (now by the WorkerDispatcher), so "the stale result was
 * ignored" is visible in production logs, not just implied by silence.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowEngine } from '../../../../src/core/engine/WorkflowEngine';
import { InMemoryStorage } from '../../../../src/storage/memory';
import { MockClock, MockScheduler, MockEnvironment } from '../../../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../../../src/core/definitions';
import { Logger } from '../../../../src/core/types';
import { sleep } from '../../../utils/testHelpers';
import { createLoopbackDispatcher } from '../../../../src/workers/loopback';

describe('WorkflowEngine - stale result discard logging', () => {
  let storage: InMemoryStorage;
  let clock: MockClock;
  let scheduler: MockScheduler;
  let environment: MockEnvironment;
  let logLines: string[];
  let logger: Logger;

  beforeEach(() => {
    storage = new InMemoryStorage();
    clock = new MockClock(1000000);
    scheduler = new MockScheduler(clock);
    environment = new MockEnvironment();
    logLines = [];
    const capture = (message: string) => logLines.push(message);
    logger = { debug: capture, info: capture, warn: capture, error: capture };
  });

  function hangingWorkflow(hang: { resolve?: () => void; reject?: (err: Error) => void }) {
    let firstAttempt = true;
    const activity = defineActivity({
      name: 'hangs',
      startToCloseTimeout: 100,
      retry: { maximumAttempts: 3, initialInterval: 50 },
      execute: async () => {
        if (firstAttempt) {
          firstAttempt = false;
          // Ignores the abort signal and outlives its timeout.
          await new Promise<void>((resolve, reject) => {
            hang.resolve = resolve;
            hang.reject = reject;
          });
        }
        return { done: true };
      },
    });
    return defineWorkflow({ name: 'staleDiscard', activities: [activity] });
  }

  async function runPastTimeoutThenComplete(hang: { resolve?: () => void; reject?: (err: Error) => void }) {
    const engine = await WorkflowEngine.create({ dispatcher: createLoopbackDispatcher(), storage, clock, scheduler, environment, logger });
    const workflow = hangingWorkflow(hang);
    engine.registerWorkflow(workflow);
    const execution = await engine.start(workflow, { input: {} });

    // Attempt 1 hangs; the timeout aborts it; the retry completes. The
    // tick blocks on the race until the scheduler fires the abort timer,
    // so advance-and-tick while the tick is in flight.
    for (let i = 0; i < 10; i++) {
      const tickPromise = engine.tick();
      await sleep(5);
      scheduler.advanceAndTick(200);
      await tickPromise;
      const current = await storage.getExecution(execution.runId);
      if (current?.status === 'completed') break;
    }
    expect((await storage.getExecution(execution.runId))?.status).toBe('completed');
    return execution;
  }

  it('logs a discard when the timed-out handler later resolves', async () => {
    const hang: { resolve?: () => void; reject?: (err: Error) => void } = {};
    const execution = await runPastTimeoutThenComplete(hang);

    expect(logLines.filter(line => /Discarding late/i.test(line))).toHaveLength(0);
    hang.resolve!();
    await sleep(10);

    expect(logLines.some(line => /Discarding late success/i.test(line))).toBe(true);
    expect((await storage.getExecution(execution.runId))?.status).toBe('completed');
  });

  it('logs a discard when the timed-out handler later throws', async () => {
    const hang: { resolve?: () => void; reject?: (err: Error) => void } = {};
    const execution = await runPastTimeoutThenComplete(hang);

    hang.reject!(new Error('socket finally died'));
    await sleep(10);

    expect(logLines.some(line => /Discarding late failure/i.test(line))).toBe(true);
    const final = await storage.getExecution(execution.runId);
    expect(final?.status).toBe('completed');
    expect(await storage.getDeadLetters()).toHaveLength(0);
  });
});
