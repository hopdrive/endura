/**
 * Unit Test: WorkflowEngine - Cancellation
 *
 * Tests workflow cancellation and its propagation through the system.
 * Validates that cancelled workflows stop processing and that
 * in-progress activities handle cancellation gracefully.
 *
 * Key scenarios tested:
 * - Cancel running workflow execution
 * - Cancel waiting/gated workflow
 * - Prevent cancelled tasks from running
 * - Cancellation during activity execution
 * - onCancel callback invocation
 */

import { WorkflowEngine } from '../../../../src/core/engine/WorkflowEngine';
import { InMemoryStorage } from '../../../../src/storage/memory';
import { MockClock, MockScheduler, MockEnvironment } from '../../../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../../../src/core/definitions';
import { createLoopbackDispatcher } from '../../../../src/workers/loopback';

describe('WorkflowEngine - Cancellation Propagation', () => {
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
      dispatcher: createLoopbackDispatcher(),
      storage,
      clock,
      scheduler,
      environment,
    });
  }

  function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  describe('abort signal propagation', () => {
    it('should abort in-flight activity when cancelExecution called', async () => {
      let signalAborted = false;
      let abortReason: unknown;

      const slowActivity = defineActivity({
        name: 'slow',
        startToCloseTimeout: 30000,
        execute: async (ctx) => {
          ctx.signal.addEventListener('abort', () => {
            signalAborted = true;
            abortReason = ctx.signal.reason;
          });

          // Simulate long-running work that respects abort signal
          await new Promise<{ done: boolean }>((resolve, reject) => {
            const timeout = setTimeout(() => resolve({ done: true }), 10000);
            ctx.signal.addEventListener('abort', () => {
              clearTimeout(timeout);
              reject(ctx.signal.reason);
            });
          });

          return { done: true };
        },
      });

      const workflow = defineWorkflow({
        name: 'cancellable',
        activities: [slowActivity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });

      // Start activity execution (don't await)
      const tickPromise = engine.tick();

      // Give activity time to start
      await sleep(50);

      // Cancel while activity is running
      await engine.cancelExecution(execution.runId);

      // Wait for tick to complete (should be aborted)
      await tickPromise;

      expect(signalAborted).toBe(true);
      expect(abortReason).toBeDefined();
      expect((abortReason as Error).message).toContain('cancelled');
    });

    it('should set signal.aborted to true when cancelled', async () => {
      const signalState = { aborted: false };

      const slowActivity = defineActivity({
        name: 'checkSignal',
        startToCloseTimeout: 30000,
        execute: async (ctx) => {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(resolve, 10000);
            ctx.signal.addEventListener('abort', () => {
              signalState.aborted = ctx.signal.aborted;
              clearTimeout(timeout);
              reject(ctx.signal.reason);
            });
          });
          return { done: true };
        },
      });

      const workflow = defineWorkflow({
        name: 'signalTest',
        activities: [slowActivity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });

      const tickPromise = engine.tick();
      await sleep(50);

      await engine.cancelExecution(execution.runId);
      await tickPromise;

      expect(signalState.aborted).toBe(true);
    });

    it('should release uniqueKey on cancellation', async () => {
      const slowActivity = defineActivity({
        name: 'slow',
        startToCloseTimeout: 30000,
        execute: async (ctx) => {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(resolve, 10000);
            ctx.signal.addEventListener('abort', () => {
              clearTimeout(timeout);
              reject(ctx.signal.reason);
            });
          });
          return { done: true };
        },
      });

      const workflow = defineWorkflow({
        name: 'unique',
        activities: [slowActivity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);

      const execution = await engine.start(workflow, {
        input: {},
        uniqueKey: 'test-key',
      });

      // Start activity
      const tickPromise = engine.tick();
      await sleep(50);

      // Cancel
      await engine.cancelExecution(execution.runId);
      await tickPromise;

      // Should be able to start new workflow with same key
      const execution2 = await engine.start(workflow, {
        input: {},
        uniqueKey: 'test-key',
      });

      expect(execution2.runId).not.toBe(execution.runId);
    });

    it('should call onCancelled callback', async () => {
      let callbackCalled = false;
      let callbackRunId: string | null = null;

      const slowActivity = defineActivity({
        name: 'slow',
        startToCloseTimeout: 30000,
        execute: async (ctx) => {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(resolve, 10000);
            ctx.signal.addEventListener('abort', () => {
              clearTimeout(timeout);
              reject(ctx.signal.reason);
            });
          });
          return { done: true };
        },
      });

      const workflow = defineWorkflow({
        name: 'withCallback',
        activities: [slowActivity],
        onCancelled: async (runId) => {
          callbackCalled = true;
          callbackRunId = runId;
        },
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);

      const execution = await engine.start(workflow, { input: {} });
      const tickPromise = engine.tick();
      await sleep(50);

      await engine.cancelExecution(execution.runId);
      await tickPromise;

      expect(callbackCalled).toBe(true);
      expect(callbackRunId).toBe(execution.runId);
    });
  });

  describe('pending workflow cancellation', () => {
    it('should handle cancellation of pending (not yet started) workflow', async () => {
      const activity = defineActivity({
        name: 'first',
        execute: async () => ({ result: 'done' }),
      });

      const workflow = defineWorkflow({
        name: 'pending',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });

      // Cancel before tick
      await engine.cancelExecution(execution.runId);

      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('cancelled');

      // Pending tasks should be deleted
      const tasks = await storage.getActivityTasksForExecution(execution.runId);
      expect(tasks).toHaveLength(0);
    });

    it('should delete all pending tasks on cancellation', async () => {
      const activity1 = defineActivity({
        name: 'first',
        execute: async () => ({ result: 'one' }),
      });
      const activity2 = defineActivity({
        name: 'second',
        execute: async () => ({ result: 'two' }),
      });

      const workflow = defineWorkflow({
        name: 'multiActivity',
        activities: [activity1, activity2],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });

      // Complete first activity
      await engine.tick();
      clock.advance(100);

      // Second activity should now be pending
      const tasksBefore = await storage.getActivityTasksForExecution(execution.runId);
      const pendingTasks = tasksBefore.filter(t => t.status === 'pending');
      expect(pendingTasks.length).toBeGreaterThan(0);

      // Cancel
      await engine.cancelExecution(execution.runId);

      // All pending tasks should be deleted
      const tasksAfter = await storage.getActivityTasksForExecution(execution.runId);
      const stillPending = tasksAfter.filter(t => t.status === 'pending');
      expect(stillPending).toHaveLength(0);
    });
  });

  describe('edge cases', () => {
    it('should handle cancellation of already completed workflow gracefully', async () => {
      const activity = defineActivity({
        name: 'instant',
        execute: async () => ({ result: 'done' }),
      });

      const workflow = defineWorkflow({
        name: 'quick',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });
      await engine.tick(); // Complete immediately

      // Cancel after completion - should not error
      await engine.cancelExecution(execution.runId);

      // Status should still be completed (not cancelled)
      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('completed');
    });

    it('should handle cancellation of non-existent workflow', async () => {
      const engine = await createEngine();

      await expect(engine.cancelExecution('non-existent-run-id')).rejects.toThrow();
    });

    it('should clean up abort controller after cancellation', async () => {
      const slowActivity = defineActivity({
        name: 'slow',
        execute: async (ctx) => {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(resolve, 10000);
            ctx.signal.addEventListener('abort', () => {
              clearTimeout(timeout);
              reject(ctx.signal.reason);
            });
          });
          return { done: true };
        },
      });

      const workflow = defineWorkflow({
        name: 'cleanup',
        activities: [slowActivity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });

      const tickPromise = engine.tick();
      await sleep(50);

      await engine.cancelExecution(execution.runId);
      await tickPromise;

      // Start a new workflow with same runId pattern - should work fine
      // (internally the abort controller map should be cleaned up)
      const execution2 = await engine.start(workflow, { input: {} });
      expect(execution2).toBeDefined();
    });
  });
});
