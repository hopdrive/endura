/**
 * Unit Test: WorkflowEngine - Activity Gating (runWhen)
 *
 * Tests the conditional execution system where activities can
 * specify runtime conditions that must be met before execution.
 *
 * Key scenarios tested:
 * - Network connectivity conditions (whenConnected)
 * - Custom runWhen predicates
 * - Scheduled retry when conditions not met
 * - Context available in runWhen (battery level, app state)
 * - Dynamic condition evaluation
 */

import { WorkflowEngine } from '../../../../src/core/engine/WorkflowEngine';
import { InMemoryStorage } from '../../../../src/storage/memory';
import { MockClock, MockScheduler, MockEnvironment } from '../../../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../../../src/core/definitions';
import { conditions } from '../../../../src/core/conditions';
import { createLoopbackDispatcher } from '../../../../src/workers/loopback';

describe('WorkflowEngine - runWhen Gating', () => {
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

  describe('basic gating', () => {
    it('should skip activity when runWhen returns false', async () => {
      const engine = await createEngine();
      let executionCount = 0;
      let skippedReason: string | null = null;

      // Set environment to disconnected
      environment.setConnected(false);

      const activity = defineActivity({
        name: 'networkActivity',
        execute: async () => {
          executionCount++;
          return { done: true };
        },
        runWhen: conditions.whenConnected,
        onSkipped: async (_taskId, _input, reason) => {
          skippedReason = reason;
        },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      await engine.start(workflow, { input: {} });

      // Activity should be skipped due to no network
      await engine.tick();

      expect(executionCount).toBe(0);
      expect(skippedReason).toBe('No network connection');
    });

    it('should execute activity when runWhen returns true', async () => {
      const engine = await createEngine();
      let executionCount = 0;

      // Set environment to connected
      environment.setConnected(true);

      const activity = defineActivity({
        name: 'networkActivity',
        execute: async () => {
          executionCount++;
          return { done: true };
        },
        runWhen: conditions.whenConnected,
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      await engine.start(workflow, { input: {} });
      await engine.tick();

      expect(executionCount).toBe(1);
    });

    it('should retry skipped activity after delay', async () => {
      const engine = await createEngine();
      let executionCount = 0;

      // Start disconnected
      environment.setConnected(false);

      const activity = defineActivity({
        name: 'networkActivity',
        execute: async () => {
          executionCount++;
          return { done: true };
        },
        runWhen: conditions.whenConnected,
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      const execution = await engine.start(workflow, { input: {} });

      // First tick - skipped
      await engine.tick();
      expect(executionCount).toBe(0);

      // Task should still be pending, but scheduled for later
      let tasks = await storage.getActivityTasksForExecution(execution.runId);
      expect(tasks[0]?.status).toBe('pending');
      expect(tasks[0]?.scheduledFor).toBeGreaterThan(clock.now());

      // Connect and advance time past scheduledFor
      environment.setConnected(true);
      clock.advance(35000); // Default retry delay is 30s

      // Should execute now
      await engine.tick();
      expect(executionCount).toBe(1);

      tasks = await storage.getActivityTasksForExecution(execution.runId);
      expect(tasks[0]?.status).toBe('completed');
    });
  });

  describe('built-in conditions', () => {
    describe('whenConnected', () => {
      it('should block when disconnected', async () => {
        environment.setConnected(false);
        const result = conditions.whenConnected({ isConnected: false, input: {} });
        expect(result.ready).toBe(false);
        expect(result.reason).toBe('No network connection');
      });

      it('should pass when connected', async () => {
        environment.setConnected(true);
        const result = conditions.whenConnected({ isConnected: true, input: {} });
        expect(result.ready).toBe(true);
      });
    });

    describe('whenDisconnected', () => {
      it('should pass when disconnected', async () => {
        const result = conditions.whenDisconnected({ isConnected: false, input: {} });
        expect(result.ready).toBe(true);
      });

      it('should block when connected', async () => {
        const result = conditions.whenDisconnected({ isConnected: true, input: {} });
        expect(result.ready).toBe(false);
        expect(result.reason).toBe('Network is connected');
      });
    });

    describe('always', () => {
      it('should always return ready', async () => {
        const result = conditions.always({ isConnected: false, input: {} });
        expect(result.ready).toBe(true);
      });
    });
  });

  describe('condition combinators', () => {
    describe('all', () => {
      it('should require all conditions to be true', async () => {
        const cond1 = () => ({ ready: true });
        const cond2 = () => ({ ready: true });
        const combined = conditions.all(cond1, cond2);

        const result = combined({ isConnected: true, input: {} });
        expect(result.ready).toBe(true);
      });

      it('should fail if any condition is false', async () => {
        const cond1 = () => ({ ready: true });
        const cond2 = () => ({ ready: false, reason: 'Condition 2 failed' });
        const combined = conditions.all(cond1, cond2);

        const result = combined({ isConnected: true, input: {} });
        expect(result.ready).toBe(false);
        expect(result.reason).toContain('Condition 2 failed');
      });

      it('should combine multiple failure reasons', async () => {
        const cond1 = () => ({ ready: false, reason: 'Reason 1' });
        const cond2 = () => ({ ready: false, reason: 'Reason 2' });
        const combined = conditions.all(cond1, cond2);

        const result = combined({ isConnected: true, input: {} });
        expect(result.ready).toBe(false);
        expect(result.reason).toContain('Reason 1');
        expect(result.reason).toContain('Reason 2');
      });
    });

    describe('any', () => {
      it('should pass if any condition is true', async () => {
        const cond1 = () => ({ ready: false });
        const cond2 = () => ({ ready: true });
        const combined = conditions.any(cond1, cond2);

        const result = combined({ isConnected: true, input: {} });
        expect(result.ready).toBe(true);
      });

      it('should fail if all conditions are false', async () => {
        const cond1 = () => ({ ready: false, reason: 'Reason 1' });
        const cond2 = () => ({ ready: false, reason: 'Reason 2' });
        const combined = conditions.any(cond1, cond2);

        const result = combined({ isConnected: true, input: {} });
        expect(result.ready).toBe(false);
        expect(result.reason).toContain('Reason 1');
        expect(result.reason).toContain('OR');
        expect(result.reason).toContain('Reason 2');
      });
    });

    describe('not', () => {
      it('should invert true to false', async () => {
        const cond = () => ({ ready: true });
        const inverted = conditions.not(cond);

        const result = inverted({ isConnected: true, input: {} });
        expect(result.ready).toBe(false);
      });

      it('should invert false to true', async () => {
        const cond = () => ({ ready: false });
        const inverted = conditions.not(cond);

        const result = inverted({ isConnected: true, input: {} });
        expect(result.ready).toBe(true);
      });
    });
  });

  describe('custom conditions', () => {
    it('should support custom condition functions', async () => {
      const engine = await createEngine();
      let executionCount = 0;

      const activity = defineActivity({
        name: 'customConditionActivity',
        execute: async () => {
          executionCount++;
          return { done: true };
        },
        runWhen: (ctx) => {
          // Only run if input has specific value
          if (ctx.input.priority && (ctx.input.priority as number) >= 5) {
            return { ready: true };
          }
          return { ready: false, reason: 'Priority too low' };
        },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      // Low priority - should skip
      await engine.start(workflow, { input: { priority: 3 } });
      await engine.tick();
      expect(executionCount).toBe(0);

      // High priority - should execute
      await engine.start(workflow, { input: { priority: 5 } });
      await engine.tick();
      expect(executionCount).toBe(1);
    });

    it('should receive runtime context in condition', async () => {
      const engine = await createEngine();
      let receivedContext: Record<string, unknown> | null = null;

      environment.setState({
        isConnected: true,
        batteryLevel: 0.75,
        appState: 'active',
        isLowPowerMode: false,
      });

      const activity = defineActivity({
        name: 'contextAwareActivity',
        execute: async () => ({ done: true }),
        runWhen: (ctx) => {
          receivedContext = { ...ctx };
          return { ready: true };
        },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      await engine.start(workflow, { input: { foo: 'bar' } });
      await engine.tick();

      expect(receivedContext).toMatchObject({
        isConnected: true,
        batteryLevel: 0.75,
        appState: 'active',
        input: { foo: 'bar' },
      });
    });

    it('should support battery-aware condition', async () => {
      const engine = await createEngine();
      let executionCount = 0;

      const activity = defineActivity({
        name: 'batteryAwareActivity',
        execute: async () => {
          executionCount++;
          return { done: true };
        },
        runWhen: (ctx) => {
          const batteryLevel = ctx.batteryLevel as number | undefined;
          if (batteryLevel !== undefined && batteryLevel < 0.2) {
            return { ready: false, reason: 'Battery too low' };
          }
          return { ready: true };
        },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      // Low battery - should skip
      environment.setBatteryLevel(0.1);
      await engine.start(workflow, { input: {} });
      await engine.tick();
      expect(executionCount).toBe(0);

      // Good battery - should execute
      environment.setBatteryLevel(0.5);
      clock.advance(35000);
      await engine.tick();
      expect(executionCount).toBe(1);
    });
  });

  describe('gating with workflows', () => {
    it('should not count skipped attempts as failures', async () => {
      const engine = await createEngine();
      environment.setConnected(false);

      const activity = defineActivity({
        name: 'networkActivity',
        execute: async () => ({ done: true }),
        runWhen: conditions.whenConnected,
        retry: { maximumAttempts: 3 },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity],
      });

      const execution = await engine.start(workflow, { input: {} });

      // Multiple skips should not exhaust retry attempts
      await engine.tick();
      clock.advance(35000);
      await engine.tick();
      clock.advance(35000);
      await engine.tick();

      // Should still be pending, not failed
      const task = (await storage.getActivityTasksForExecution(execution.runId))[0];
      expect(task?.status).toBe('pending');
      expect(task?.attempts).toBe(0); // Skips decrement attempts
    });

    it('should continue workflow when condition becomes true', async () => {
      const engine = await createEngine();
      const executionOrder: string[] = [];

      environment.setConnected(false);

      const activity1 = defineActivity({
        name: 'networkActivity',
        execute: async () => {
          executionOrder.push('networkActivity');
          return { step1: 'done' };
        },
        runWhen: conditions.whenConnected,
      });

      const activity2 = defineActivity({
        name: 'localActivity',
        execute: async () => {
          executionOrder.push('localActivity');
          return { step2: 'done' };
        },
        // No runWhen - always runs
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [activity1, activity2],
      });

      const execution = await engine.start(workflow, { input: {} });

      // Activity 1 skipped
      await engine.tick();
      expect(executionOrder).toHaveLength(0);

      // Connect and advance time
      environment.setConnected(true);
      clock.advance(35000);

      // Activity 1 runs
      await engine.tick();
      expect(executionOrder).toEqual(['networkActivity']);

      // Activity 2 runs
      await engine.tick();
      expect(executionOrder).toEqual(['networkActivity', 'localActivity']);

      const finalExecution = await storage.getExecution(execution.runId);
      expect(finalExecution?.status).toBe('completed');
    });

    it('should handle mixed gated and non-gated activities', async () => {
      const engine = await createEngine();
      const executionOrder: string[] = [];

      environment.setConnected(false);

      const offlineActivity = defineActivity({
        name: 'offlineActivity',
        execute: async () => {
          executionOrder.push('offline');
          return { offline: 'done' };
        },
        // No runWhen - always runs
      });

      const onlineActivity = defineActivity({
        name: 'onlineActivity',
        execute: async () => {
          executionOrder.push('online');
          return { online: 'done' };
        },
        runWhen: conditions.whenConnected,
      });

      const finalActivity = defineActivity({
        name: 'finalActivity',
        execute: async () => {
          executionOrder.push('final');
          return { final: 'done' };
        },
      });

      const workflow = defineWorkflow({
        name: 'testWorkflow',
        activities: [offlineActivity, onlineActivity, finalActivity],
      });

      const execution = await engine.start(workflow, { input: {} });

      // Offline activity runs
      await engine.tick();
      expect(executionOrder).toEqual(['offline']);

      // Online activity skipped
      await engine.tick();
      expect(executionOrder).toEqual(['offline']);

      // Connect
      environment.setConnected(true);
      clock.advance(35000);

      // Online activity runs
      await engine.tick();
      expect(executionOrder).toEqual(['offline', 'online']);

      // Final activity runs
      await engine.tick();
      expect(executionOrder).toEqual(['offline', 'online', 'final']);

      const finalExecution = await storage.getExecution(execution.runId);
      expect(finalExecution?.status).toBe('completed');
      expect(finalExecution?.state).toEqual({
        offline: 'done',
        online: 'done',
        final: 'done',
      });
    });
  });
});
