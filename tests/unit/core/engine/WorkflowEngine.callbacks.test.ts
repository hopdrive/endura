/**
 * Unit Test: WorkflowEngine - Callbacks
 *
 * Tests workflow and activity lifecycle callbacks including
 * onSuccess, onError, onComplete, and onCancel handlers.
 * Validates callback error isolation from workflow execution.
 *
 * Key scenarios tested:
 * - Activity onSuccess/onError callbacks
 * - Workflow onComplete/onCancel callbacks
 * - Callback errors don't fail workflows
 * - Callback execution order
 * - Context available in callbacks
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowEngine } from '../../../../src/core/engine/WorkflowEngine';
import { InMemoryStorage } from '../../../../src/storage/memory';
import { MockClock, MockScheduler, MockEnvironment } from '../../../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../../../src/core/definitions';
import { createTestActivity, sleep } from '../../../utils/testHelpers';
import { createLoopbackDispatcher } from '../../../../src/workers/loopback';

describe('WorkflowEngine - Callback Error Handling', () => {
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

  describe('Activity-level callbacks', () => {
    it('should not fail activity if onStart throws', async () => {
      const activity = defineActivity({
        name: 'test',
        execute: async () => ({ result: true }),
        onStart: async () => {
          throw new Error('onStart failed');
        },
      });

      const workflow = defineWorkflow({
        name: 'onStartThrows',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });
      await engine.tick();

      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('completed');
    });

    it('should not fail activity if onSuccess throws', async () => {
      const activity = defineActivity({
        name: 'test',
        execute: async () => ({ result: true }),
        onSuccess: async () => {
          throw new Error('onSuccess failed');
        },
      });

      const workflow = defineWorkflow({
        name: 'onSuccessThrows',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });
      await engine.tick();

      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('completed');
    });

    it('should continue retry flow if onFailure throws', async () => {
      let attempts = 0;

      const activity = defineActivity({
        name: 'test',
        retry: { maximumAttempts: 5, initialInterval: 10 },
        onFailure: async () => {
          throw new Error('onFailure threw');
        },
        execute: async () => {
          attempts++;
          if (attempts < 3) throw new Error('Activity failed');
          return { done: true };
        },
      });

      const workflow = defineWorkflow({
        name: 'onFailureThrows',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });

      // Process retries
      for (let i = 0; i < 5; i++) {
        await engine.tick();
        clock.advance(50);
      }

      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('completed');
      expect(attempts).toBe(3);
    });

    it('should still create dead letter if onFailed throws', async () => {
      const activity = defineActivity({
        name: 'test',
        retry: { maximumAttempts: 1 },
        onFailed: async () => {
          throw new Error('onFailed threw');
        },
        execute: async () => {
          throw new Error('Always fails');
        },
      });

      const workflow = defineWorkflow({
        name: 'onFailedThrows',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      await engine.start(workflow, { input: {} });
      await engine.tick();

      const deadLetters = await engine.getDeadLetters();
      expect(deadLetters).toHaveLength(1);
    });

    it('should still reschedule if onSkipped throws', async () => {
      const activity = defineActivity({
        name: 'test',
        runWhen: () => ({ ready: false, reason: 'Not ready' }),
        onSkipped: async () => {
          throw new Error('onSkipped threw');
        },
        execute: async () => ({ done: true }),
      });

      const workflow = defineWorkflow({
        name: 'onSkippedThrows',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });
      await engine.tick();

      // Workflow should still be running (activity skipped but rescheduled)
      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('running');
    });

    it('should call onFailure with correct attempt number', async () => {
      const failureAttempts: number[] = [];

      const activity = defineActivity({
        name: 'trackAttempts',
        retry: { maximumAttempts: 3, initialInterval: 10 },
        onFailure: async (_taskId, _input, _error, attempt) => {
          failureAttempts.push(attempt);
        },
        execute: async () => {
          throw new Error('Always fails');
        },
      });

      const workflow = defineWorkflow({
        name: 'trackAttemptsWorkflow',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      await engine.start(workflow, { input: {} });

      for (let i = 0; i < 5; i++) {
        await engine.tick();
        clock.advance(50);
      }

      expect(failureAttempts).toEqual([1, 2, 3]);
    });
  });

  describe('Workflow-level callbacks', () => {
    it('should not change execution status if onComplete throws', async () => {
      const activity = createTestActivity('simple');

      const workflow = defineWorkflow({
        name: 'onCompleteThrows',
        activities: [activity],
        onComplete: async () => {
          throw new Error('onComplete threw');
        },
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });
      await engine.tick();

      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('completed');
    });

    it('should still release uniqueKey if onComplete throws', async () => {
      const activity = createTestActivity('simple');

      const workflow = defineWorkflow({
        name: 'releaseOnThrow',
        activities: [activity],
        onComplete: async () => {
          throw new Error('onComplete threw');
        },
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      await engine.start(workflow, {
        input: {},
        uniqueKey: 'test-key',
      });
      await engine.tick();

      // Should be able to start new workflow with same key
      const execution2 = await engine.start(workflow, {
        input: {},
        uniqueKey: 'test-key',
      });
      expect(execution2).toBeDefined();
    });

    it('should still create dead letter if workflow onFailed throws', async () => {
      const activity = defineActivity({
        name: 'failing',
        retry: { maximumAttempts: 1 },
        execute: async () => {
          throw new Error('Always fails');
        },
      });

      const workflow = defineWorkflow({
        name: 'workflowOnFailedThrows',
        activities: [activity],
        onFailed: async () => {
          throw new Error('onFailed threw');
        },
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      await engine.start(workflow, { input: {} });
      await engine.tick();

      const deadLetters = await engine.getDeadLetters();
      expect(deadLetters).toHaveLength(1);
    });

    it('should still release uniqueKey if onCancelled throws', async () => {
      const slowActivity = defineActivity({
        name: 'slow',
        startToCloseTimeout: 30000,
        execute: async (ctx) => {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, 10000);
            ctx.signal.addEventListener('abort', () => {
              clearTimeout(t);
              reject(ctx.signal.reason);
            });
          });
          return {};
        },
      });

      const workflow = defineWorkflow({
        name: 'onCancelledThrows',
        activities: [slowActivity],
        onCancelled: async () => {
          throw new Error('onCancelled threw');
        },
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, {
        input: {},
        uniqueKey: 'cancel-key',
      });

      const tickPromise = engine.tick();
      await sleep(50);
      await engine.cancelExecution(execution.runId);
      await tickPromise;

      // Should be able to reuse key
      const execution2 = await engine.start(workflow, {
        input: {},
        uniqueKey: 'cancel-key',
      });
      expect(execution2).toBeDefined();
    });

    it('should call onComplete with final state', async () => {
      let capturedState: Record<string, unknown> | null = null;

      const activity = defineActivity({
        name: 'addData',
        execute: async () => ({ data: 'result' }),
      });

      const workflow = defineWorkflow({
        name: 'captureState',
        activities: [activity],
        onComplete: async (_runId, finalState) => {
          capturedState = finalState;
        },
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      await engine.start(workflow, { input: { initial: 'value' } });
      await engine.tick();

      expect(capturedState).toMatchObject({
        initial: 'value',
        data: 'result',
      });
    });

    it('should call onFailed with error and state', async () => {
      let capturedError: Error | null = null;
      let capturedState: Record<string, unknown> | null = null;

      const activity = defineActivity({
        name: 'failing',
        retry: { maximumAttempts: 1 },
        execute: async () => {
          throw new Error('Activity error message');
        },
      });

      const workflow = defineWorkflow({
        name: 'captureError',
        activities: [activity],
        onFailed: async (_runId, state, error) => {
          capturedError = error;
          capturedState = state;
        },
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      await engine.start(workflow, { input: { test: 'data' } });
      await engine.tick();

      expect(capturedError?.message).toBe('Activity error message');
      expect(capturedState).toMatchObject({ test: 'data' });
    });
  });
});
