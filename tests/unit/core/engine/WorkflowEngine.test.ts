/**
 * Unit Test: WorkflowEngine - Core Operations
 *
 * Tests basic workflow engine functionality including registration,
 * execution, and state management.
 *
 * Key scenarios tested:
 * - Workflow and activity registration
 * - Starting workflow executions
 * - Activity execution and state merging
 * - UniqueKey constraint enforcement
 * - Basic error handling
 */

import { WorkflowEngine } from '../../../../src/core/engine/WorkflowEngine';
import { InMemoryStorage } from '../../../../src/storage/memory';
import { MockClock, MockScheduler, MockEnvironment } from '../../../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../../../src/core/definitions';

describe('WorkflowEngine', () => {
  let storage: InMemoryStorage;
  let clock: MockClock;
  let scheduler: MockScheduler;
  let environment: MockEnvironment;

  beforeEach(() => {
    storage = new InMemoryStorage();
    clock = new MockClock(1000000); // Start at a fixed time
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

  describe('workflow registration', () => {
    it('should register a workflow', async () => {
      const engine = await createEngine();

      const activity = defineActivity({
        name: 'testActivity',
        execute: async () => ({ result: 'done' }),
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      engine.registerWorkflow(workflow);

      expect(engine.getWorkflow('testWorkflow')).toBeDefined();
      expect(engine.getActivity('testActivity')).toBeDefined();
    });

    it('should auto-register workflow when starting', async () => {
      const engine = await createEngine();

      const activity = defineActivity({
        name: 'testActivity',
        execute: async () => ({ result: 'done' }),
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      await engine.start(workflow, { input: {} });

      expect(engine.getWorkflow('testWorkflow')).toBeDefined();
    });
  });

  describe('starting workflows', () => {
    it('should create a workflow execution', async () => {
      const engine = await createEngine();

      const activity = defineActivity({
        name: 'testActivity',
        execute: async () => ({ result: 'done' }),
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      const execution = await engine.start(workflow, {
        input: { foo: 'bar' },
      });

      expect(execution.runId).toBeDefined();
      expect(execution.workflowName).toBe('testWorkflow');
      expect(execution.status).toBe('running');
      expect(execution.input).toEqual({ foo: 'bar' });
      expect(execution.state).toEqual({ foo: 'bar' });
      expect(execution.currentActivityIndex).toBe(0);
      expect(execution.currentActivityName).toBe('testActivity');
    });

    it('should persist execution to storage', async () => {
      const engine = await createEngine();

      const activity = defineActivity({
        name: 'testActivity',
        execute: async () => ({}),
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      const execution = await engine.start(workflow, { input: {} });

      const retrieved = await storage.getExecution(execution.runId);
      expect(retrieved).toMatchObject({
        runId: execution.runId,
        workflowName: 'testWorkflow',
        status: 'running',
      });
    });

    it('should create an activity task for the first activity', async () => {
      const engine = await createEngine();

      const activity = defineActivity({
        name: 'testActivity',
        execute: async () => ({}),
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      const execution = await engine.start(workflow, { input: {} });

      const tasks = await storage.getActivityTasksForExecution(execution.runId);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        runId: execution.runId,
        activityName: 'testActivity',
        status: 'pending',
      });
    });
  });

  describe('tick processing', () => {
    it('should execute a pending activity', async () => {
      const engine = await createEngine();
      let executed = false;

      const activity = defineActivity({
        name: 'testActivity',
        execute: async () => {
          executed = true;
          return { result: 'success' };
        },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      await engine.start(workflow, { input: {} });

      // Process the task
      const processed = await engine.tick();

      expect(processed).toBe(1);
      expect(executed).toBe(true);
    });

    it('should mark activity as completed after execution', async () => {
      const engine = await createEngine();

      const activity = defineActivity({
        name: 'testActivity',
        execute: async () => ({ result: 'success' }),
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      const execution = await engine.start(workflow, { input: {} });
      await engine.tick();

      const tasks = await storage.getActivityTasksForExecution(execution.runId);
      expect(tasks[0]?.status).toBe('completed');
      expect(tasks[0]?.result).toEqual({ result: 'success' });
    });

    it('should mark single-activity workflow as completed', async () => {
      const engine = await createEngine();

      const activity = defineActivity({
        name: 'testActivity',
        execute: async () => ({ result: 'success' }),
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      const execution = await engine.start(workflow, { input: {} });
      await engine.tick();

      const updated = await storage.getExecution(execution.runId);
      expect(updated?.status).toBe('completed');
      expect(updated?.state).toEqual({ result: 'success' });
    });
  });

  describe('multi-activity workflows', () => {
    it('should advance through all activities', async () => {
      const engine = await createEngine();
      const executionOrder: string[] = [];

      const activity1 = defineActivity({
        name: 'activity1',
        execute: async () => {
          executionOrder.push('activity1');
          return { step1: 'done' };
        },
      });

      const activity2 = defineActivity({
        name: 'activity2',
        execute: async () => {
          executionOrder.push('activity2');
          return { step2: 'done' };
        },
      });

      const activity3 = defineActivity({
        name: 'activity3',
        execute: async () => {
          executionOrder.push('activity3');
          return { step3: 'done' };
        },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity1, activity2, activity3],
      });

      const execution = await engine.start(workflow, { input: { initial: 'value' } });

      // Process all activities
      await engine.tick(); // activity1
      await engine.tick(); // activity2
      await engine.tick(); // activity3

      expect(executionOrder).toEqual(['activity1', 'activity2', 'activity3']);

      const updated = await storage.getExecution(execution.runId);
      expect(updated?.status).toBe('completed');
      expect(updated?.state).toEqual({
        initial: 'value',
        step1: 'done',
        step2: 'done',
        step3: 'done',
      });
    });

    it('should pass accumulated state to each activity', async () => {
      const engine = await createEngine();
      const receivedInputs: Record<string, unknown>[] = [];

      const activity1 = defineActivity({
        name: 'activity1',
        execute: async (ctx) => {
          receivedInputs.push({ ...ctx.input });
          return { fromActivity1: 'value1' };
        },
      });

      const activity2 = defineActivity({
        name: 'activity2',
        execute: async (ctx) => {
          receivedInputs.push({ ...ctx.input });
          return { fromActivity2: 'value2' };
        },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity1, activity2],
      });

      await engine.start(workflow, { input: { initial: 'value' } });

      await engine.tick();
      await engine.tick();

      expect(receivedInputs[0]).toEqual({ initial: 'value' });
      expect(receivedInputs[1]).toEqual({
        initial: 'value',
        fromActivity1: 'value1',
      });
    });
  });

  describe('workflow callbacks', () => {
    it('should call onComplete when workflow finishes', async () => {
      const engine = await createEngine();
      let completedRunId: string | null = null;
      let completedState: Record<string, unknown> | null = null;

      const activity = defineActivity({
        name: 'testActivity',
        execute: async () => ({ result: 'success' }),
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
        onComplete: async (runId, finalState) => {
          completedRunId = runId;
          completedState = finalState;
        },
      });

      const execution = await engine.start(workflow, { input: { foo: 'bar' } });
      await engine.tick();

      expect(completedRunId).toBe(execution.runId);
      expect(completedState).toEqual({ foo: 'bar', result: 'success' });
    });
  });

  describe('activity callbacks', () => {
    it('should call onStart before activity execution', async () => {
      const engine = await createEngine();
      let startedTaskId: string | null = null;
      let startedInput: Record<string, unknown> | null = null;

      const activity = defineActivity({
        name: 'testActivity',
        execute: async () => ({ result: 'done' }),
        onStart: async (taskId, input) => {
          startedTaskId = taskId;
          startedInput = input as Record<string, unknown>;
        },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      await engine.start(workflow, { input: { foo: 'bar' } });
      await engine.tick();

      expect(startedTaskId).toBeDefined();
      expect(startedInput).toEqual({ foo: 'bar' });
    });

    it('should call onSuccess after successful execution', async () => {
      const engine = await createEngine();
      let successResult: Record<string, unknown> | null = null;

      const activity = defineActivity({
        name: 'testActivity',
        execute: async () => ({ result: 'done' }),
        onSuccess: async (_taskId, _input, result) => {
          successResult = result;
        },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      await engine.start(workflow, { input: {} });
      await engine.tick();

      expect(successResult).toEqual({ result: 'done' });
    });
  });

  describe('uniqueness constraints', () => {
    it('should enforce uniqueKey constraint', async () => {
      const engine = await createEngine();

      const activity = defineActivity({
        name: 'testActivity',
        execute: async () => ({ result: 'done' }),
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      await engine.start(workflow, {
        input: {},
        uniqueKey: 'unique-1',
      });

      await expect(
        engine.start(workflow, {
          input: {},
          uniqueKey: 'unique-1',
        })
      ).rejects.toThrow('already has active execution');
    });

    it('should allow duplicate uniqueKey with onConflict: ignore', async () => {
      const engine = await createEngine();

      const activity = defineActivity({
        name: 'testActivity',
        execute: async () => ({ result: 'done' }),
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      const first = await engine.start(workflow, {
        input: {},
        uniqueKey: 'unique-1',
      });

      const second = await engine.start(workflow, {
        input: {},
        uniqueKey: 'unique-1',
        onConflict: 'ignore',
      });

      expect(second.runId).toBe(first.runId);
    });

    it('should release uniqueKey when workflow completes', async () => {
      const engine = await createEngine();

      const activity = defineActivity({
        name: 'testActivity',
        execute: async () => ({ result: 'done' }),
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      await engine.start(workflow, {
        input: {},
        uniqueKey: 'unique-1',
      });

      await engine.tick(); // Complete the workflow

      // Should be able to start another with the same key
      const second = await engine.start(workflow, {
        input: {},
        uniqueKey: 'unique-1',
      });

      expect(second.runId).toBeDefined();
    });
  });

  describe('cancellation', () => {
    it('should cancel a running workflow', async () => {
      const engine = await createEngine();
      let cancelledRunId: string | null = null;

      const activity = defineActivity({
        name: 'testActivity',
        execute: async () => ({ result: 'done' }),
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
        onCancelled: async (runId) => {
          cancelledRunId = runId;
        },
      });

      const execution = await engine.start(workflow, { input: {} });
      await engine.cancelExecution(execution.runId);

      const updated = await storage.getExecution(execution.runId);
      expect(updated?.status).toBe('cancelled');
      expect(cancelledRunId).toBe(execution.runId);
    });

    it('should release uniqueKey on cancellation', async () => {
      const engine = await createEngine();

      const activity = defineActivity({
        name: 'testActivity',
        execute: async () => ({ result: 'done' }),
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      const execution = await engine.start(workflow, {
        input: {},
        uniqueKey: 'unique-1',
      });

      await engine.cancelExecution(execution.runId);

      // Should be able to start another with the same key
      const second = await engine.start(workflow, {
        input: {},
        uniqueKey: 'unique-1',
      });

      expect(second.runId).toBeDefined();
      expect(second.runId).not.toBe(execution.runId);
    });
  });

  describe('getExecution', () => {
    it('should retrieve an execution by runId', async () => {
      const engine = await createEngine();

      const activity = defineActivity({
        name: 'testActivity',
        execute: async () => ({}),
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      const execution = await engine.start(workflow, { input: { foo: 'bar' } });

      const retrieved = await engine.getExecution(execution.runId);
      expect(retrieved).toMatchObject({
        runId: execution.runId,
        workflowName: 'testWorkflow',
        input: { foo: 'bar' },
      });
    });

    it('should return null for non-existent execution', async () => {
      const engine = await createEngine();

      const retrieved = await engine.getExecution('non-existent');
      expect(retrieved).toBeNull();
    });
  });
});
