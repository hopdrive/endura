/**
 * Unit Test: WorkflowEngine - Concurrency Safety
 *
 * Tests engine behavior under concurrent operations to ensure
 * thread-safety and prevent race conditions.
 *
 * Key scenarios tested:
 * - Concurrent workflow starts
 * - Parallel tick() calls
 * - Concurrent activity executions
 * - Race condition prevention
 * - Atomic state updates
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowEngine } from '../../../../src/core/engine/WorkflowEngine';
import { InMemoryStorage } from '../../../../src/storage/memory';
import { MockClock, MockScheduler, MockEnvironment } from '../../../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../../../src/core/definitions';
import { createTestActivity, sleep } from '../../../utils/testHelpers';

describe('WorkflowEngine - Concurrency Safety', () => {
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

  describe('Workflow creation', () => {
    it('should handle rapid sequential workflow starts', async () => {
      const activity = createTestActivity('quick');
      const workflow = defineWorkflow({
        name: 'rapid',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);

      const executions = [];
      for (let i = 0; i < 100; i++) {
        executions.push(engine.start(workflow, { input: { index: i } }));
      }

      const results = await Promise.all(executions);

      // All should succeed with unique runIds
      const runIds = results.map((e) => e.runId);
      const uniqueIds = new Set(runIds);
      expect(uniqueIds.size).toBe(100);
    });

    it('should handle sequential starts with same uniqueKey', async () => {
      const activity = createTestActivity('quick');
      const workflow = defineWorkflow({
        name: 'unique',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);

      // First start should succeed
      const first = await engine.start(workflow, { input: {}, uniqueKey: 'same-key' });
      expect(first.runId).toBeDefined();

      // Second start with same key should fail
      await expect(
        engine.start(workflow, { input: {}, uniqueKey: 'same-key' })
      ).rejects.toThrow();

      // After completing, the key should be released
      await engine.tick();
      const result = await engine.getExecution(first.runId);
      expect(result?.status).toBe('completed');

      // Now we can start again with the same key
      const third = await engine.start(workflow, { input: {}, uniqueKey: 'same-key' });
      expect(third.runId).toBeDefined();
      expect(third.runId).not.toBe(first.runId);
    });

    it('should handle multiple workflows with different unique keys concurrently', async () => {
      const activity = createTestActivity('quick');
      const workflow = defineWorkflow({
        name: 'multiKey',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);

      // Start workflows with different keys concurrently
      const promises = Array.from({ length: 10 }, (_, i) =>
        engine.start(workflow, { input: { i }, uniqueKey: `key-${i}` })
      );

      const results = await Promise.all(promises);

      // All should succeed
      expect(results).toHaveLength(10);
      const runIds = new Set(results.map((e) => e.runId));
      expect(runIds.size).toBe(10);
    });
  });

  describe('Task processing', () => {
    it('should not double-process same task with concurrent ticks', async () => {
      let executeCount = 0;

      const activity = defineActivity({
        name: 'countExecution',
        execute: async () => {
          executeCount++;
          await sleep(50);
          return { count: executeCount };
        },
      });

      const workflow = defineWorkflow({
        name: 'countTest',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      await engine.start(workflow, { input: {} });

      // Run multiple ticks concurrently
      await Promise.all([engine.tick(), engine.tick(), engine.tick()]);

      expect(executeCount).toBe(1);
    });

    it('should handle concurrent tick and cancelExecution', async () => {
      let activityAborted = false;

      const slowActivity = defineActivity({
        name: 'slow',
        startToCloseTimeout: 30000,
        execute: async (ctx) => {
          return new Promise<{ completed: boolean }>((resolve, reject) => {
            const t = setTimeout(() => {
              resolve({ completed: true });
            }, 10000);
            ctx.signal.addEventListener('abort', () => {
              clearTimeout(t);
              activityAborted = true;
              reject(ctx.signal.reason);
            });
          });
        },
      });

      const workflow = defineWorkflow({
        name: 'cancelRace',
        activities: [slowActivity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });

      // Start tick (don't await)
      const tickPromise = engine.tick();

      // Give time for activity to start
      await sleep(50);

      // Cancel while activity running
      await engine.cancelExecution(execution.runId);

      // Wait for tick to complete
      await tickPromise;

      const result = await engine.getExecution(execution.runId);
      // The abort signal should have been triggered
      expect(activityAborted).toBe(true);
      // Status could be 'cancelled' (if cancel processed first) or 'failed' (if error processed first)
      // Both are acceptable outcomes in this race condition
      expect(['cancelled', 'failed']).toContain(result?.status);
    });

    it('should process multiple independent workflows concurrently', async () => {
      const activity = createTestActivity('quick');
      const workflow = defineWorkflow({
        name: 'concurrent',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);

      // Start multiple workflows
      const executions = await Promise.all([
        engine.start(workflow, { input: { id: 1 } }),
        engine.start(workflow, { input: { id: 2 } }),
        engine.start(workflow, { input: { id: 3 } }),
      ]);

      // Process them
      for (let i = 0; i < 5; i++) {
        await engine.tick();
      }

      // All should complete
      for (const exec of executions) {
        const result = await engine.getExecution(exec.runId);
        expect(result?.status).toBe('completed');
      }
    });
  });

  describe('Engine lifecycle', () => {
    it('should handle stop() when already stopped', async () => {
      const engine = await createEngine();

      // Should be idempotent - no error should be thrown
      engine.stop();
      engine.stop();
      engine.stop();
    });

    it('should handle getExecution for non-existent runId', async () => {
      const engine = await createEngine();

      const result = await engine.getExecution('non-existent-id');
      expect(result).toBeNull();
    });

    it('should handle cancelExecution for non-existent runId', async () => {
      const engine = await createEngine();

      await expect(engine.cancelExecution('non-existent-id')).rejects.toThrow();
    });
  });

  describe('Storage consistency', () => {
    it('should maintain consistency under concurrent operations', async () => {
      const activity = createTestActivity('quick');
      const workflow = defineWorkflow({
        name: 'consistency',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);

      // Perform many concurrent operations
      const operations = [];
      for (let i = 0; i < 50; i++) {
        operations.push(engine.start(workflow, { input: { i } }));
      }

      const executions = await Promise.all(operations);

      // All should have been created
      expect(executions).toHaveLength(50);

      // Verify storage consistency
      const allExecutions = await engine.getExecutionsByStatus('running');
      expect(allExecutions.length).toBe(50);

      // Process all
      for (let i = 0; i < 100; i++) {
        await engine.tick();
      }

      const completed = await engine.getExecutionsByStatus('completed');
      expect(completed.length).toBe(50);
    });
  });
});
