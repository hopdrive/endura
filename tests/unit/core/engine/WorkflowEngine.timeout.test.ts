/**
 * Unit Test: WorkflowEngine - Timeouts
 *
 * Tests activity timeout enforcement and handling.
 * Validates that long-running activities are properly interrupted
 * and retried or failed based on configuration.
 *
 * Key scenarios tested:
 * - Activity startToCloseTimeout enforcement
 * - Timeout triggers retry (if attempts remaining)
 * - Timeout leads to failure (if no retries left)
 * - Timeout error message capture
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowEngine } from '../../../../src/core/engine/WorkflowEngine';
import { InMemoryStorage } from '../../../../src/storage/memory';
import { MockClock, MockScheduler, MockEnvironment } from '../../../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../../../src/core/definitions';
import { sleep } from '../../../utils/testHelpers';

describe('WorkflowEngine - Activity Timeout Handling', () => {
  let storage: InMemoryStorage;
  let clock: MockClock;
  let scheduler: MockScheduler;
  let environment: MockEnvironment;

  beforeEach(() => {
    storage = new InMemoryStorage();
    clock = new MockClock(1000000);
    scheduler = new MockScheduler(clock);
    environment = new MockEnvironment();
  });

  async function createEngine(): Promise<WorkflowEngine> {
    return WorkflowEngine.create({
      storage,
      clock,
      scheduler,
      environment,
    });
  }

  describe('startToCloseTimeout behavior', () => {
    it('should abort activity when startToCloseTimeout exceeded', async () => {
      const activity = defineActivity({
        name: 'slowActivity',
        startToCloseTimeout: 100,
        retry: { maximumAttempts: 1 },
        execute: async (ctx) => {
          // Simulate long-running work that respects abort signal
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(resolve, 5000);
            ctx.signal.addEventListener('abort', () => {
              clearTimeout(timeout);
              reject(ctx.signal.reason);
            });
          });
          return { done: true };
        },
      });

      const workflow = defineWorkflow({
        name: 'timeoutTest',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });

      // Start the tick (activity will start)
      const tickPromise = engine.tick();

      // Advance time past the timeout
      await sleep(10);
      scheduler.advanceAndTick(150);

      await tickPromise;

      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('failed');
    });

    it('should set signal.aborted to true when timeout fires', async () => {
      const signalState = { aborted: false, reason: null as unknown };

      const activity = defineActivity({
        name: 'checkSignal',
        startToCloseTimeout: 100,
        execute: async (ctx) => {
          return new Promise<{ done: boolean }>((resolve, reject) => {
            const timeout = setTimeout(() => resolve({ done: true }), 5000);
            ctx.signal.addEventListener('abort', () => {
              signalState.aborted = ctx.signal.aborted;
              signalState.reason = ctx.signal.reason;
              clearTimeout(timeout);
              reject(ctx.signal.reason);
            });
          });
        },
      });

      const workflow = defineWorkflow({
        name: 'signalTest',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      await engine.start(workflow, { input: {} });

      const tickPromise = engine.tick();
      await sleep(10);
      scheduler.advanceAndTick(150);
      await tickPromise;

      expect(signalState.aborted).toBe(true);
      expect(signalState.reason).toBeDefined();
    });

    it('should count timeout as failed attempt for retry purposes', async () => {
      let attemptCount = 0;

      const activity = defineActivity({
        name: 'timingOut',
        startToCloseTimeout: 50,
        retry: { maximumAttempts: 3, initialInterval: 10 },
        execute: async (ctx) => {
          attemptCount = ctx.attempt;
          // Will timeout
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(resolve, 5000);
            ctx.signal.addEventListener('abort', () => {
              clearTimeout(timeout);
              reject(ctx.signal.reason);
            });
          });
          return {};
        },
      });

      const workflow = defineWorkflow({
        name: 'retryTimeout',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      await engine.start(workflow, { input: {} });

      // Process multiple ticks to allow retries
      for (let i = 0; i < 5; i++) {
        const tickPromise = engine.tick();
        await sleep(10);
        scheduler.advanceAndTick(100);
        await tickPromise;
      }

      expect(attemptCount).toBeGreaterThan(1);
    });

    it('should fail permanently after max attempts due to timeouts', async () => {
      const activity = defineActivity({
        name: 'alwaysTimesOut',
        startToCloseTimeout: 50,
        retry: { maximumAttempts: 2, initialInterval: 10 },
        execute: async (ctx) => {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(resolve, 5000);
            ctx.signal.addEventListener('abort', () => {
              clearTimeout(timeout);
              reject(ctx.signal.reason);
            });
          });
          return {};
        },
      });

      const workflow = defineWorkflow({
        name: 'maxRetryTimeout',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });

      // Process enough ticks for all retries
      for (let i = 0; i < 10; i++) {
        const tickPromise = engine.tick();
        await sleep(10);
        scheduler.advanceAndTick(100);
        await tickPromise;
      }

      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('failed');

      // Should have dead letter
      const deadLetters = await engine.getDeadLetters();
      expect(deadLetters.length).toBeGreaterThan(0);
    });

    it('should treat timeout of 0 as no timeout (infinite)', async () => {
      let completed = false;

      const activity = defineActivity({
        name: 'noTimeout',
        startToCloseTimeout: 0,
        execute: async () => {
          await sleep(50);
          completed = true;
          return { done: true };
        },
      });

      const workflow = defineWorkflow({
        name: 'infiniteTimeout',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      await engine.start(workflow, { input: {} });
      await engine.tick();

      expect(completed).toBe(true);
    });
  });

  describe('timeout error context', () => {
    it('should include timeout info in error', async () => {
      let capturedError: Error | null = null;

      const activity = defineActivity({
        name: 'namedActivity',
        startToCloseTimeout: 50,
        retry: { maximumAttempts: 1 },
        onFailed: async (_taskId, _input, error) => {
          capturedError = error;
        },
        execute: async (ctx) => {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(resolve, 5000);
            ctx.signal.addEventListener('abort', () => {
              clearTimeout(timeout);
              reject(ctx.signal.reason);
            });
          });
          return {};
        },
      });

      const workflow = defineWorkflow({
        name: 'errorContext',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      await engine.start(workflow, { input: {} });

      const tickPromise = engine.tick();
      await sleep(10);
      scheduler.advanceAndTick(100);
      await tickPromise;

      expect(capturedError).toBeDefined();
      expect(capturedError?.message.toLowerCase()).toContain('timed out');
    });
  });
});
