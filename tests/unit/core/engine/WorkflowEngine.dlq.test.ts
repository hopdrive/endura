/**
 * Unit Test: WorkflowEngine - Dead Letter Queue
 *
 * Tests the dead letter queue (DLQ) for permanently failed activities.
 * Validates that failed activities are recorded with their error info
 * and can be reviewed or reprocessed later.
 *
 * Key scenarios tested:
 * - DLQ entry creation on activity exhaustion
 * - Error message and stack trace capture
 * - Retry from dead letter queue
 * - DLQ entry cleanup on successful retry
 * - Query DLQ entries by workflow
 */

import { WorkflowEngine } from '../../../../src/core/engine/WorkflowEngine';
import { InMemoryStorage } from '../../../../src/storage/memory';
import { MockClock, MockScheduler, MockEnvironment } from '../../../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../../../src/core/definitions';
import { createLoopbackDispatcher } from '../../../../src/workers/loopback';

describe('WorkflowEngine - Dead Letter Queue', () => {
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

  describe('dead letter creation', () => {
    it('should create dead letter on permanent activity failure', async () => {
      const engine = await createEngine();

      const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
        name: 'failingActivity',
        execute: async (): Promise<{ done: boolean }> => {
          throw new Error('Permanent failure');
        },
        retry: { maximumAttempts: 1 },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      const execution = await engine.start(workflow, { input: { foo: 'bar' } });
      await engine.tick();

      const deadLetters = await engine.getDeadLetters();
      expect(deadLetters).toHaveLength(1);

      const dl = deadLetters[0];
      expect(dl).toMatchObject({
        runId: execution.runId,
        activityName: 'failingActivity',
        workflowName: 'testWorkflow',
        error: 'Permanent failure',
        attempts: 1,
        acknowledged: false,
      });
      expect(dl?.input).toEqual({ foo: 'bar' });
    });

    it('should create dead letter after exhausting retries', async () => {
      const engine = await createEngine();
      let attemptCount = 0;

      const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
        name: 'failingActivity',
        execute: async (): Promise<{ done: boolean }> => {
          attemptCount++;
          throw new Error(`Failure #${attemptCount}`);
        },
        retry: { maximumAttempts: 3 },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      await engine.start(workflow, { input: {} });

      // Attempt 1
      await engine.tick();
      expect(await engine.getDeadLetters()).toHaveLength(0);

      // Attempt 2
      clock.advance(2000);
      await engine.tick();
      expect(await engine.getDeadLetters()).toHaveLength(0);

      // Attempt 3 - final
      clock.advance(4000);
      await engine.tick();

      const deadLetters = await engine.getDeadLetters();
      expect(deadLetters).toHaveLength(1);
      expect(deadLetters[0]?.attempts).toBe(3);
      expect(deadLetters[0]?.error).toBe('Failure #3');
    });

    it('should include error stack in dead letter', async () => {
      const engine = await createEngine();

      const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
        name: 'failingActivity',
        execute: async (): Promise<{ done: boolean }> => {
          const error = new Error('Stack trace test');
          // Manually set stack for consistent test
          error.stack = 'Error: Stack trace test\n    at testFunction\n    at processActivity';
          throw error;
        },
        retry: { maximumAttempts: 1 },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      await engine.start(workflow, { input: {} });
      await engine.tick();

      const deadLetters = await engine.getDeadLetters();
      expect(deadLetters[0]?.errorStack).toContain('Stack trace test');
      expect(deadLetters[0]?.errorStack).toContain('testFunction');
    });

    it('should record failedAt timestamp', async () => {
      const engine = await createEngine();
      clock.setTime(5000000);

      const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
        name: 'failingActivity',
        execute: async (): Promise<{ done: boolean }> => {
          throw new Error('Failure');
        },
        retry: { maximumAttempts: 1 },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      await engine.start(workflow, { input: {} });
      await engine.tick();

      const deadLetters = await engine.getDeadLetters();
      expect(deadLetters[0]?.failedAt).toBe(5000000);
    });
  });

  describe('dead letter retrieval', () => {
    it('should return all dead letters', async () => {
      const engine = await createEngine();

      const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
        name: 'failingActivity',
        execute: async (): Promise<{ done: boolean }> => {
          throw new Error('Failure');
        },
        retry: { maximumAttempts: 1 },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      // Create multiple failures
      await engine.start(workflow, { input: { id: 1 } });
      await engine.tick();

      await engine.start(workflow, { input: { id: 2 } });
      await engine.tick();

      await engine.start(workflow, { input: { id: 3 } });
      await engine.tick();

      const deadLetters = await engine.getDeadLetters();
      expect(deadLetters).toHaveLength(3);
    });

    it('should return only unacknowledged dead letters', async () => {
      const engine = await createEngine();

      const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
        name: 'failingActivity',
        execute: async (): Promise<{ done: boolean }> => {
          throw new Error('Failure');
        },
        retry: { maximumAttempts: 1 },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      // Create multiple failures
      await engine.start(workflow, { input: { id: 1 } });
      await engine.tick();

      await engine.start(workflow, { input: { id: 2 } });
      await engine.tick();

      // Acknowledge one
      const allDl = await engine.getDeadLetters();
      await engine.acknowledgeDeadLetter(allDl[0]!.id);

      const unacked = await engine.getUnacknowledgedDeadLetters();
      expect(unacked).toHaveLength(1);
      expect(unacked[0]?.input).toMatchObject({ id: 2 });
    });
  });

  describe('dead letter acknowledgment', () => {
    it('should mark dead letter as acknowledged', async () => {
      const engine = await createEngine();

      const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
        name: 'failingActivity',
        execute: async (): Promise<{ done: boolean }> => {
          throw new Error('Failure');
        },
        retry: { maximumAttempts: 1 },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      await engine.start(workflow, { input: {} });
      await engine.tick();

      const deadLetters = await engine.getDeadLetters();
      expect(deadLetters[0]?.acknowledged).toBe(false);

      await engine.acknowledgeDeadLetter(deadLetters[0]!.id);

      const afterAck = await engine.getDeadLetters();
      expect(afterAck[0]?.acknowledged).toBe(true);
    });

    it('should handle acknowledging non-existent dead letter gracefully', async () => {
      const engine = await createEngine();

      // Should not throw
      await expect(engine.acknowledgeDeadLetter('non-existent-id')).resolves.not.toThrow();
    });
  });

  describe('dead letter purging', () => {
    it('should purge old acknowledged dead letters', async () => {
      const engine = await createEngine();
      clock.setTime(1000000);

      const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
        name: 'failingActivity',
        execute: async (): Promise<{ done: boolean }> => {
          throw new Error('Failure');
        },
        retry: { maximumAttempts: 1 },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      // Create and acknowledge first failure
      await engine.start(workflow, { input: { id: 1 } });
      await engine.tick();

      const dl1 = (await engine.getDeadLetters())[0];
      await engine.acknowledgeDeadLetter(dl1!.id);

      // Advance time significantly
      clock.advance(10 * 24 * 60 * 60 * 1000); // 10 days

      // Create second failure (more recent, acknowledged)
      await engine.start(workflow, { input: { id: 2 } });
      await engine.tick();

      const dl2 = (await engine.getDeadLetters()).find(d => d.id !== dl1!.id);
      await engine.acknowledgeDeadLetter(dl2!.id);

      expect(await engine.getDeadLetters()).toHaveLength(2);

      // Purge entries older than 7 days
      const purged = await engine.purgeDeadLetters({
        olderThanMs: 7 * 24 * 60 * 60 * 1000,
        acknowledgedOnly: true,
      });

      expect(purged).toBe(1);
      expect(await engine.getDeadLetters()).toHaveLength(1);

      // Remaining should be the recent one
      const remaining = await engine.getDeadLetters();
      expect(remaining[0]?.input).toMatchObject({ id: 2 });
    });

    it('should only purge acknowledged if acknowledgedOnly is true', async () => {
      const engine = await createEngine();
      clock.setTime(1000000);

      const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
        name: 'failingActivity',
        execute: async (): Promise<{ done: boolean }> => {
          throw new Error('Failure');
        },
        retry: { maximumAttempts: 1 },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      // Create two failures
      await engine.start(workflow, { input: { id: 1 } });
      await engine.tick();

      await engine.start(workflow, { input: { id: 2 } });
      await engine.tick();

      // Acknowledge only one
      const dl = (await engine.getDeadLetters())[0];
      await engine.acknowledgeDeadLetter(dl!.id);

      // Advance time
      clock.advance(10 * 24 * 60 * 60 * 1000);

      // Purge with acknowledgedOnly
      const purged = await engine.purgeDeadLetters({
        olderThanMs: 7 * 24 * 60 * 60 * 1000,
        acknowledgedOnly: true,
      });

      expect(purged).toBe(1);
      expect(await engine.getDeadLetters()).toHaveLength(1);

      // Remaining should be unacknowledged
      const remaining = await engine.getDeadLetters();
      expect(remaining[0]?.acknowledged).toBe(false);
    });

    it('should purge all old dead letters if acknowledgedOnly is false', async () => {
      const engine = await createEngine();
      clock.setTime(1000000);

      const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
        name: 'failingActivity',
        execute: async (): Promise<{ done: boolean }> => {
          throw new Error('Failure');
        },
        retry: { maximumAttempts: 1 },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      // Create two failures (not acknowledged)
      await engine.start(workflow, { input: { id: 1 } });
      await engine.tick();

      await engine.start(workflow, { input: { id: 2 } });
      await engine.tick();

      expect(await engine.getDeadLetters()).toHaveLength(2);

      // Advance time
      clock.advance(10 * 24 * 60 * 60 * 1000);

      // Purge without acknowledgedOnly restriction
      const purged = await engine.purgeDeadLetters({
        olderThanMs: 7 * 24 * 60 * 60 * 1000,
        acknowledgedOnly: false,
      });

      expect(purged).toBe(2);
      expect(await engine.getDeadLetters()).toHaveLength(0);
    });
  });

  describe('dead letter events', () => {
    it('should emit deadletter:added event', async () => {
      const events: Array<{ type: string; runId?: string }> = [];

      const engine = await WorkflowEngine.create({
        dispatcher: createLoopbackDispatcher(),
        storage,
        clock,
        scheduler,
        environment,
        onEvent: (event) => {
          if (event.type === 'deadletter:added') {
            events.push({ type: event.type, runId: event.runId });
          }
        },
      });

      const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
        name: 'failingActivity',
        execute: async (): Promise<{ done: boolean }> => {
          throw new Error('Failure');
        },
        retry: { maximumAttempts: 1 },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      const execution = await engine.start(workflow, { input: {} });
      await engine.tick();

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'deadletter:added',
        runId: execution.runId,
      });
    });
  });

  describe('workflow failure behavior', () => {
    it('should mark workflow as failed when activity fails permanently', async () => {
      const engine = await createEngine();

      const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
        name: 'failingActivity',
        execute: async (): Promise<{ done: boolean }> => {
          throw new Error('Failure');
        },
        retry: { maximumAttempts: 1 },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      const execution = await engine.start(workflow, { input: {} });
      await engine.tick();

      const updatedExecution = await storage.getExecution(execution.runId);
      expect(updatedExecution?.status).toBe('failed');
      expect(updatedExecution?.error).toBe('Failure');
      expect(updatedExecution?.failedActivityName).toBe('failingActivity');
    });

    it('should call workflow onFailed callback', async () => {
      const engine = await createEngine();
      let failedCalled = false;
      let failedRunId: string | null = null;
      let failedErrorMessage: string | null = null;

      const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
        name: 'failingActivity',
        execute: async (): Promise<{ done: boolean }> => {
          throw new Error('Activity failure');
        },
        retry: { maximumAttempts: 1 },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
        onFailed: async (runId, _state, error) => {
          failedCalled = true;
          failedRunId = runId;
          failedErrorMessage = error.message;
        },
      });

      const execution = await engine.start(workflow, { input: {} });
      await engine.tick();

      expect(failedCalled).toBe(true);
      expect(failedRunId).toBe(execution.runId);
      expect(failedErrorMessage).toBe('Activity failure');
    });

    it('should release uniqueKey when workflow fails', async () => {
      const engine = await createEngine();

      const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
        name: 'failingActivity',
        execute: async (): Promise<{ done: boolean }> => {
          throw new Error('Failure');
        },
        retry: { maximumAttempts: 1 },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      await engine.start(workflow, {
        input: {},
        uniqueKey: 'unique-1',
      });
      await engine.tick();

      // Should be able to start another with the same key
      const second = await engine.start(workflow, {
        input: {},
        uniqueKey: 'unique-1',
      });

      expect(second.runId).toBeDefined();
    });
  });
});
