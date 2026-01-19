/**
 * Unit Test: WorkflowEngine - Retries and Backoff
 *
 * Tests the retry mechanism for failed activities including
 * exponential backoff and maximum attempt limits.
 *
 * Key scenarios tested:
 * - Automatic retry on activity failure
 * - Exponential backoff between retry attempts
 * - Maximum interval capping
 * - Maximum attempts enforcement
 * - Successful recovery after transient failures
 */

import { WorkflowEngine } from '../../../../src/core/engine/WorkflowEngine';
import { InMemoryStorage } from '../../../../src/storage/memory';
import { MockClock, MockScheduler, MockEnvironment } from '../../../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../../../src/core/definitions';

describe('WorkflowEngine - Retries + Backoff', () => {
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
      autoProcess: false, // Disable auto-processing for manual test control
    });
  }

  describe('retry behavior', () => {
    it('should retry activity on failure', async () => {
      const engine = await createEngine();
      let attemptCount = 0;

      const activity = defineActivity({
        name: 'failingActivity',
        execute: async () => {
          attemptCount++;
          if (attemptCount < 3) {
            throw new Error(`Attempt ${attemptCount} failed`);
          }
          return { success: true };
        },
        retry: { maximumAttempts: 3 },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      const execution = await engine.start(workflow, { input: {} });

      // First attempt - should fail and schedule retry
      await engine.tick();
      expect(attemptCount).toBe(1);

      let tasks = await storage.getActivityTasksForExecution(execution.runId);
      expect(tasks[0]?.status).toBe('pending'); // Retrying
      expect(tasks[0]?.error).toBe('Attempt 1 failed');

      // Advance clock past backoff delay and retry
      clock.advance(2000);
      await engine.tick();
      expect(attemptCount).toBe(2);

      tasks = await storage.getActivityTasksForExecution(execution.runId);
      expect(tasks[0]?.status).toBe('pending'); // Retrying again

      // Third attempt - should succeed
      clock.advance(4000);
      await engine.tick();
      expect(attemptCount).toBe(3);

      tasks = await storage.getActivityTasksForExecution(execution.runId);
      expect(tasks[0]?.status).toBe('completed');
      expect(tasks[0]?.result).toEqual({ success: true });
    });

    it('should fail after max attempts exceeded', async () => {
      const engine = await createEngine();
      let attemptCount = 0;

      const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
        name: 'alwaysFails',
        execute: async (): Promise<{ done: boolean }> => {
          attemptCount++;
          throw new Error(`Attempt ${attemptCount} failed`);
        },
        retry: { maximumAttempts: 2 },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      const execution = await engine.start(workflow, { input: {} });

      // First attempt
      await engine.tick();
      expect(attemptCount).toBe(1);

      // Second attempt after backoff
      clock.advance(2000);
      await engine.tick();
      expect(attemptCount).toBe(2);

      // Should now be failed
      const tasks = await storage.getActivityTasksForExecution(execution.runId);
      expect(tasks[0]?.status).toBe('failed');
      expect(tasks[0]?.attempts).toBe(2);

      // Workflow should be failed
      const updatedExecution = await storage.getExecution(execution.runId);
      expect(updatedExecution?.status).toBe('failed');
      expect(updatedExecution?.failedActivityName).toBe('alwaysFails');
    });

    it('should call onFailure callback for each failed attempt', async () => {
      const engine = await createEngine();
      const failureCalls: { attempt: number; error: string }[] = [];

      const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
        name: 'failingActivity',
        execute: async (): Promise<{ done: boolean }> => {
          throw new Error('Always fails');
        },
        retry: { maximumAttempts: 3 },
        onFailure: async (_taskId, _input, error, attempt) => {
          failureCalls.push({ attempt, error: error.message });
        },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      await engine.start(workflow, { input: {} });

      // Three attempts
      await engine.tick();
      clock.advance(2000);
      await engine.tick();
      clock.advance(4000);
      await engine.tick();

      expect(failureCalls).toEqual([
        { attempt: 1, error: 'Always fails' },
        { attempt: 2, error: 'Always fails' },
        { attempt: 3, error: 'Always fails' },
      ]);
    });

    it('should call onFailed callback when permanently failed', async () => {
      const engine = await createEngine();
      let permanentlyFailedCalled = false;
      let failedError: string | null = null;

      const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
        name: 'failingActivity',
        execute: async (): Promise<{ done: boolean }> => {
          throw new Error('Always fails');
        },
        retry: { maximumAttempts: 1 },
        onFailed: async (_taskId, _input, error) => {
          permanentlyFailedCalled = true;
          failedError = error.message;
        },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      await engine.start(workflow, { input: {} });
      await engine.tick();

      expect(permanentlyFailedCalled).toBe(true);
      expect(failedError).toBe('Always fails');
    });
  });

  describe('backoff timing', () => {
    it('should respect initialInterval for first retry', async () => {
      const engine = await createEngine();
      let attemptCount = 0;

      const activity = defineActivity({
        name: 'failingActivity',
        execute: async () => {
          attemptCount++;
          if (attemptCount < 2) {
            throw new Error('Retry me');
          }
          return { done: true };
        },
        retry: {
          maximumAttempts: 3,
          initialInterval: 5000, // 5 seconds
        },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      await engine.start(workflow, { input: {} });

      // First attempt fails
      await engine.tick();
      expect(attemptCount).toBe(1);

      // Advance just under 5 seconds - should not run yet
      clock.advance(4999);
      await engine.tick();
      expect(attemptCount).toBe(1);

      // Advance past 5 seconds - should run now
      clock.advance(2);
      await engine.tick();
      expect(attemptCount).toBe(2);
    });

    it('should apply backoff coefficient', async () => {
      const engine = await createEngine();
      const attemptTimes: number[] = [];

      const activity = defineActivity({
        name: 'failingActivity',
        execute: async () => {
          attemptTimes.push(clock.now());
          if (attemptTimes.length < 4) {
            throw new Error('Retry me');
          }
          return { done: true };
        },
        retry: {
          maximumAttempts: 4,
          initialInterval: 1000,
          backoffCoefficient: 2,
        },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      await engine.start(workflow, { input: {} });

      // Attempt 1
      await engine.tick();
      const firstAttemptTime = attemptTimes[0];
      expect(firstAttemptTime).toBeDefined();

      // Attempt 2 (after 1000ms initial)
      clock.advance(1001);
      await engine.tick();

      // Attempt 3 (after 2000ms = 1000 * 2)
      clock.advance(2001);
      await engine.tick();

      // Attempt 4 (after 4000ms = 1000 * 2^2)
      clock.advance(4001);
      await engine.tick();

      expect(attemptTimes).toHaveLength(4);

      // Verify delays (with some tolerance)
      const delay1 = attemptTimes[1]! - attemptTimes[0]!;
      const delay2 = attemptTimes[2]! - attemptTimes[1]!;
      const delay3 = attemptTimes[3]! - attemptTimes[2]!;

      expect(delay1).toBeGreaterThanOrEqual(1000);
      expect(delay2).toBeGreaterThanOrEqual(2000);
      expect(delay3).toBeGreaterThanOrEqual(4000);
    });

    it('should respect maximumInterval cap', async () => {
      const engine = await createEngine();
      const attemptTimes: number[] = [];

      const activity = defineActivity({
        name: 'failingActivity',
        execute: async () => {
          attemptTimes.push(clock.now());
          if (attemptTimes.length < 5) {
            throw new Error('Retry me');
          }
          return { done: true };
        },
        retry: {
          maximumAttempts: 5,
          initialInterval: 1000,
          backoffCoefficient: 10, // Would be 1000, 10000, 100000, 1000000...
          maximumInterval: 5000, // Capped at 5 seconds
        },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      await engine.start(workflow, { input: {} });

      // Attempt 1
      await engine.tick();

      // Attempt 2 (after 1000ms initial)
      clock.advance(1001);
      await engine.tick();

      // Attempt 3 (would be 10000ms but capped to 5000ms)
      clock.advance(5001);
      await engine.tick();

      // Attempt 4 (capped to 5000ms)
      clock.advance(5001);
      await engine.tick();

      // Attempt 5 (capped to 5000ms)
      clock.advance(5001);
      await engine.tick();

      expect(attemptTimes).toHaveLength(5);

      // Verify delays are capped
      const delay2 = attemptTimes[2]! - attemptTimes[1]!;
      const delay3 = attemptTimes[3]! - attemptTimes[2]!;
      const delay4 = attemptTimes[4]! - attemptTimes[3]!;

      // Delays after first should be capped to ~5000ms
      expect(delay2).toBeLessThanOrEqual(5100);
      expect(delay3).toBeLessThanOrEqual(5100);
      expect(delay4).toBeLessThanOrEqual(5100);
    });
  });

  describe('retry with state preservation', () => {
    it('should preserve input state across retries', async () => {
      const engine = await createEngine();
      const receivedInputs: Record<string, unknown>[] = [];

      const activity = defineActivity({
        name: 'failingActivity',
        execute: async (ctx) => {
          receivedInputs.push({ ...ctx.input });
          if (receivedInputs.length < 2) {
            throw new Error('Retry me');
          }
          return { done: true };
        },
        retry: { maximumAttempts: 2 },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      await engine.start(workflow, { input: { foo: 'bar', count: 42 } });

      // First attempt
      await engine.tick();

      // Second attempt after backoff
      clock.advance(2000);
      await engine.tick();

      // Both attempts should have received the same input
      expect(receivedInputs).toHaveLength(2);
      expect(receivedInputs[0]).toEqual({ foo: 'bar', count: 42 });
      expect(receivedInputs[1]).toEqual({ foo: 'bar', count: 42 });
    });

    it('should continue workflow after successful retry', async () => {
      const engine = await createEngine();
      const executionOrder: string[] = [];
      let activity1Attempts = 0;

      const activity1 = defineActivity({
        name: 'activity1',
        execute: async () => {
          executionOrder.push(`activity1-attempt-${++activity1Attempts}`);
          if (activity1Attempts < 2) {
            throw new Error('Retry me');
          }
          return { step1: 'done' };
        },
        retry: { maximumAttempts: 3 },
      });

      const activity2 = defineActivity({
        name: 'activity2',
        execute: async () => {
          executionOrder.push('activity2');
          return { step2: 'done' };
        },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity1, activity2],
      });

      const execution = await engine.start(workflow, { input: {} });

      // First attempt of activity1 fails
      await engine.tick();

      // Retry succeeds
      clock.advance(2000);
      await engine.tick();

      // Activity2 runs
      await engine.tick();

      expect(executionOrder).toEqual([
        'activity1-attempt-1',
        'activity1-attempt-2',
        'activity2',
      ]);

      const finalExecution = await storage.getExecution(execution.runId);
      expect(finalExecution?.status).toBe('completed');
      expect(finalExecution?.state).toEqual({ step1: 'done', step2: 'done' });
    });
  });

  describe('edge cases', () => {
    it('should handle no retry policy (default single attempt)', async () => {
      const engine = await createEngine();
      let attemptCount = 0;

      const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
        name: 'failingActivity',
        execute: async (): Promise<{ done: boolean }> => {
          attemptCount++;
          throw new Error('Fails immediately');
        },
        // No retry policy - defaults to 1 attempt
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      const execution = await engine.start(workflow, { input: {} });
      await engine.tick();

      expect(attemptCount).toBe(1);

      const tasks = await storage.getActivityTasksForExecution(execution.runId);
      expect(tasks[0]?.status).toBe('failed');
    });

    it('should handle immediate success (no retries needed)', async () => {
      const engine = await createEngine();
      let attemptCount = 0;

      const activity = defineActivity({
        name: 'successActivity',
        execute: async () => {
          attemptCount++;
          return { success: true };
        },
        retry: { maximumAttempts: 10 },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      await engine.start(workflow, { input: {} });
      await engine.tick();

      expect(attemptCount).toBe(1); // Only one attempt needed

      const tasks = await storage.getActivityTasksByStatus('completed');
      expect(tasks).toHaveLength(1);
    });

    it('should track attempts correctly in task record', async () => {
      const engine = await createEngine();

      const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
        name: 'failingActivity',
        execute: async (): Promise<{ done: boolean }> => {
          throw new Error('Always fails');
        },
        retry: { maximumAttempts: 3 },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      const execution = await engine.start(workflow, { input: {} });

      // Track attempts
      await engine.tick();
      let task = (await storage.getActivityTasksForExecution(execution.runId))[0];
      expect(task?.attempts).toBe(1);

      clock.advance(2000);
      await engine.tick();
      task = (await storage.getActivityTasksForExecution(execution.runId))[0];
      expect(task?.attempts).toBe(2);

      clock.advance(4000);
      await engine.tick();
      task = (await storage.getActivityTasksForExecution(execution.runId))[0];
      expect(task?.attempts).toBe(3);
      expect(task?.status).toBe('failed');
    });

    it('should store error info on failed attempts', async () => {
      const engine = await createEngine();

      const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
        name: 'failingActivity',
        execute: async (): Promise<{ done: boolean }> => {
          const error = new Error('Specific error message');
          error.stack = 'Error stack trace here';
          throw error;
        },
        retry: { maximumAttempts: 1 },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      const execution = await engine.start(workflow, { input: {} });
      await engine.tick();

      const task = (await storage.getActivityTasksForExecution(execution.runId))[0];
      expect(task?.error).toBe('Specific error message');
      expect(task?.errorStack).toContain('Error stack trace here');
    });
  });
});
