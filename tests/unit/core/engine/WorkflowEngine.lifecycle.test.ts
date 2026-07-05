/**
 * Unit Test: WorkflowEngine - Task Lifecycle
 *
 * Tests task state transitions and restart/recovery scenarios.
 * Validates that tasks move through correct states and can
 * be recovered after engine restarts.
 *
 * Key scenarios tested:
 * - Task state transitions (pending → active → completed)
 * - Engine restart with tasks in various states
 * - Recovery of running workflows after restart
 * - Pending task processing after recovery
 */

import { WorkflowEngine } from '../../../../src/core/engine/WorkflowEngine';
import { InMemoryStorage } from '../../../../src/storage/memory';
import { MockClock, MockScheduler, MockEnvironment } from '../../../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../../../src/core/definitions';
import { ActivityTask } from '../../../../src/core/types';

describe('WorkflowEngine - Task Lifecycle', () => {
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

  describe('task state transitions', () => {
    it('should transition task from pending to active to completed', async () => {
      const engine = await createEngine();
      const stateLog: string[] = [];

      const activity = defineActivity({
        name: 'testActivity',
        execute: async () => {
          // Record state during execution
          const task = await storage.getActivityTask(
            (await storage.getActivityTasksByStatus('active'))[0]?.taskId ?? ''
          );
          if (task) stateLog.push(`during:${task.status}`);
          return { done: true };
        },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      const execution = await engine.start(workflow, { input: {} });

      // Check initial state
      const initialTasks = await storage.getActivityTasksForExecution(execution.runId);
      expect(initialTasks[0]?.status).toBe('pending');
      stateLog.push(`before:${initialTasks[0]?.status}`);

      // Process the task
      await engine.tick();

      // Check final state
      const finalTasks = await storage.getActivityTasksForExecution(execution.runId);
      stateLog.push(`after:${finalTasks[0]?.status}`);

      expect(stateLog).toEqual(['before:pending', 'during:active', 'after:completed']);
    });

    it('should increment attempts when claiming a task', async () => {
      const engine = await createEngine();

      const activity = defineActivity({
        name: 'testActivity',
        execute: async () => ({ done: true }),
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      const execution = await engine.start(workflow, { input: {} });

      // Check initial attempts
      const initialTasks = await storage.getActivityTasksForExecution(execution.runId);
      expect(initialTasks[0]?.attempts).toBe(0);

      // Process the task
      await engine.tick();

      // Check attempts after execution
      const finalTasks = await storage.getActivityTasksForExecution(execution.runId);
      expect(finalTasks[0]?.attempts).toBe(1);
    });

    it('should set startedAt when task is claimed', async () => {
      const engine = await createEngine();
      clock.setTime(5000000);

      const activity = defineActivity({
        name: 'testActivity',
        execute: async () => ({ done: true }),
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      await engine.start(workflow, { input: {} });
      await engine.tick();

      const tasks = await storage.getActivityTasksByStatus('completed');
      expect(tasks[0]?.startedAt).toBe(5000000);
    });

    it('should set completedAt when task completes', async () => {
      const engine = await createEngine();
      clock.setTime(5000000);

      const activity = defineActivity({
        name: 'testActivity',
        execute: async () => {
          clock.advance(1000); // Simulate work taking 1 second
          return { done: true };
        },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      await engine.start(workflow, { input: {} });
      await engine.tick();

      const tasks = await storage.getActivityTasksByStatus('completed');
      expect(tasks[0]?.completedAt).toBe(5001000);
    });
  });

  describe('crash recovery simulation', () => {
    it('should recover tasks that were active when engine crashed', async () => {
      // Create first engine and start a workflow
      const engine1 = await createEngine();

      const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
        name: 'testActivity',
        execute: async (): Promise<{ done: boolean }> => {
          throw new Error('Simulated crash');
        },
        retry: { maximumAttempts: 3 },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      const execution = await engine1.start(workflow, { input: {} });

      // Manually set a task to 'active' to simulate a crash during execution
      const tasks = await storage.getActivityTasksForExecution(execution.runId);
      const task = tasks[0];
      if (task) {
        const activeTask: ActivityTask = {
          ...task,
          status: 'active',
          attempts: 1,
          startedAt: clock.now(),
        };
        await storage.saveActivityTask(activeTask);
      }

      // Verify task is active
      const activeTasks = await storage.getActivityTasksByStatus('active');
      expect(activeTasks).toHaveLength(1);

      // Create a new engine (simulating app restart)
      clock.advance(1000);
      const engine2 = await createEngine();
      engine2.registerWorkflow(workflow);

      // Verify task was reset to pending
      const pendingTasks = await storage.getActivityTasksByStatus('pending');
      expect(pendingTasks).toHaveLength(1);
      expect(pendingTasks[0]?.error).toBe('Recovered from crash');

      // The new engine should be able to process the recovered task
      await engine2.tick();

      // Task should have been processed (and failed due to our error)
      const finalTasks = await storage.getActivityTasksForExecution(execution.runId);
      expect(finalTasks[0]?.attempts).toBe(2); // Original attempt + retry
    });

    it('should fail task if max attempts exceeded during crash recovery', async () => {
      const engine1 = await createEngine();

      const activity = defineActivity({
        name: 'testActivity',
        execute: async () => ({ done: true }),
        retry: { maximumAttempts: 2 },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      const execution = await engine1.start(workflow, { input: {} });

      // Simulate a crash with attempts already at max
      const tasks = await storage.getActivityTasksForExecution(execution.runId);
      const task = tasks[0];
      if (task) {
        const activeTask: ActivityTask = {
          ...task,
          status: 'active',
          attempts: 2,
          failures: 2, // Failure budget already exhausted before the crash
          startedAt: clock.now(),
        };
        await storage.saveActivityTask(activeTask);
      }

      // Create new engine (simulating restart)
      const engine2 = await createEngine();
      engine2.registerWorkflow(workflow);

      // Task should have been moved to failed
      const failedTasks = await storage.getActivityTasksByStatus('failed');
      expect(failedTasks).toHaveLength(1);

      // Workflow should be failed
      const updatedExecution = await storage.getExecution(execution.runId);
      expect(updatedExecution?.status).toBe('failed');

      // Dead letter should have been created
      const deadLetters = await storage.getDeadLetters();
      expect(deadLetters).toHaveLength(1);
    });

    it('should preserve workflow state across restart', async () => {
      const engine1 = await createEngine();

      const activity1 = defineActivity({
        name: 'activity1',
        execute: async () => ({ step1: 'done' }),
      });

      const activity2 = defineActivity({
        name: 'activity2',
        execute: async () => ({ step2: 'done' }),
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity1, activity2],
      });

      const execution = await engine1.start(workflow, { input: { initial: 'value' } });

      // Complete first activity
      await engine1.tick();

      // Check state after first activity
      const midExecution = await storage.getExecution(execution.runId);
      expect(midExecution?.state).toEqual({ initial: 'value', step1: 'done' });
      expect(midExecution?.currentActivityIndex).toBe(1);
      expect(midExecution?.currentActivityName).toBe('activity2');

      // Create new engine (simulating restart)
      const engine2 = await createEngine();
      engine2.registerWorkflow(workflow);

      // Complete second activity with new engine
      await engine2.tick();

      // Verify final state
      const finalExecution = await storage.getExecution(execution.runId);
      expect(finalExecution?.status).toBe('completed');
      expect(finalExecution?.state).toEqual({
        initial: 'value',
        step1: 'done',
        step2: 'done',
      });
    });

    it('should resume multiple in-flight workflows after restart', async () => {
      const engine1 = await createEngine();

      // Use a two-activity workflow to have workflows in different states
      const activity1 = defineActivity({
        name: 'activity1',
        execute: async () => ({ step1: 'done' }),
      });

      const activity2 = defineActivity({
        name: 'activity2',
        execute: async () => ({ step2: 'done' }),
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity1, activity2],
      });

      // Start multiple workflows
      const execution1 = await engine1.start(workflow, { input: { id: 1 } });
      const execution2 = await engine1.start(workflow, { input: { id: 2 } });

      // tick() processes all pending tasks (3 tasks from workflow starts)
      // All will move to activity2
      await engine1.tick();

      // Verify all are running (at activity2)
      expect((await storage.getExecution(execution1.runId))?.status).toBe('running');
      expect((await storage.getExecution(execution1.runId))?.currentActivityName).toBe('activity2');
      expect((await storage.getExecution(execution2.runId))?.status).toBe('running');
      expect((await storage.getExecution(execution2.runId))?.currentActivityName).toBe('activity2');

      // Create new engine (simulating restart)
      const engine2 = await createEngine();
      engine2.registerWorkflow(workflow);

      // Process remaining activities with new engine
      await engine2.tick();

      // All should be completed now
      expect((await storage.getExecution(execution1.runId))?.status).toBe('completed');
      expect((await storage.getExecution(execution2.runId))?.status).toBe('completed');

      // Verify final states preserved
      expect((await storage.getExecution(execution1.runId))?.state).toEqual({
        id: 1,
        step1: 'done',
        step2: 'done',
      });
    });
  });

  describe('concurrent execution safety', () => {
    it('should not process already claimed task', async () => {
      const engine = await createEngine();
      let executeCount = 0;

      const activity = defineActivity({
        name: 'testActivity',
        execute: async () => {
          executeCount++;
          return { done: true };
        },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      await engine.start(workflow, { input: {} });

      // Simulate two concurrent tick attempts
      const tick1 = engine.tick();
      const tick2 = engine.tick();

      await Promise.all([tick1, tick2]);

      // Activity should only execute once
      expect(executeCount).toBe(1);
    });

    it('should handle claim contention gracefully', async () => {
      // Simulate a scenario where a task is claimed between getPending and claim
      const engine = await createEngine();
      let executeCount = 0;

      const activity = defineActivity({
        name: 'testActivity',
        execute: async () => {
          executeCount++;
          return { done: true };
        },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      const execution = await engine.start(workflow, { input: {} });

      // Get the task ID
      const tasks = await storage.getActivityTasksForExecution(execution.runId);
      const taskId = tasks[0]?.taskId;

      // Another engine claims the task (with a live lease) before tick.
      // A leaseless active task would rightly be treated as abandoned
      // and reclaimed by periodic lease recovery.
      if (taskId) {
        await storage.claimActivityTask(taskId, clock.now(), {
          ownerId: 'other-engine',
          leaseDurationMs: 60000,
        });
      }

      // Tick should not process the already-claimed task
      const processed = await engine.tick();
      expect(processed).toBe(0);
      expect(executeCount).toBe(0);
    });
  });

  describe('execution status tracking', () => {
    it('should correctly report running executions', async () => {
      const engine = await createEngine();

      const activity1 = defineActivity({
        name: 'activity1',
        execute: async () => ({ done: true }),
      });

      const activity2 = defineActivity({
        name: 'activity2',
        execute: async () => ({ done: true }),
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity1, activity2],
      });

      await engine.start(workflow, { input: {} });

      // Should have one running execution
      const running = await engine.getExecutionsByStatus('running');
      expect(running).toHaveLength(1);

      // Complete first activity
      await engine.tick();

      // Still running (second activity pending)
      expect(await engine.getExecutionsByStatus('running')).toHaveLength(1);

      // Complete second activity
      await engine.tick();

      // Should be completed
      expect(await engine.getExecutionsByStatus('running')).toHaveLength(0);
      expect(await engine.getExecutionsByStatus('completed')).toHaveLength(1);
    });
  });
});
