/**
 * Integration Test: Crash Recovery
 *
 * Tests workflow recovery after simulated app crashes/restarts.
 * Validates that the engine can resume workflows from persistent storage
 * without losing progress or duplicating work.
 *
 * Key scenarios tested:
 * - Resume from last completed activity
 * - State preservation through crash
 * - Recovery with gated activities
 * - Recovery with retries in progress
 * - Multiple workflow recovery
 * - UniqueKey constraint preservation
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkflowEngine } from '../../src/core/engine';
import { InMemoryStorage } from '../../src/storage/memory';
import { MockClock, MockScheduler, MockEnvironment } from '../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../src/core/definitions';
import { conditions } from '../../src/core/conditions';
import { runToCompletion, TestContext } from '../utils/testHelpers';

describe('Crash Recovery Integration', () => {
  // Shared storage persists across "crashes"
  let storage: InMemoryStorage;
  let clock: MockClock;
  let environment: MockEnvironment;
  let ctx: TestContext;

  // Track activity executions across restarts
  let activityExecutions: { name: string; runId: string; attempt: number }[];

  beforeEach(() => {
    storage = new InMemoryStorage();
    clock = new MockClock(1000000);
    environment = new MockEnvironment({ isConnected: true });
    activityExecutions = [];
  });

  afterEach(() => {
    ctx?.engine.stop();
  });

  /**
   * Creates an engine - simulates app start
   */
  async function createEngine(): Promise<WorkflowEngine> {
    const scheduler = new MockScheduler(clock);
    const engine = await WorkflowEngine.create({
      storage,
      clock,
      scheduler,
      environment,
      autoProcess: false, // Disable auto-processing for manual test control
    });
    ctx = { storage, clock, scheduler, environment, engine };
    return engine;
  }

  /**
   * Simulates app restart - creates new engine with same storage
   */
  async function restartEngine(): Promise<WorkflowEngine> {
    const scheduler = new MockScheduler(clock);
    const engine = await WorkflowEngine.create({
      storage,
      clock,
      scheduler,
      environment,
      autoProcess: false, // Disable auto-processing for manual test control
    });
    ctx = { storage, clock, scheduler, environment, engine };
    return engine;
  }

  // ===========================================================================
  // Activity Definitions
  // ===========================================================================

  const step1 = defineActivity({
    name: 'step1',
    execute: async (actCtx) => {
      activityExecutions.push({ name: 'step1', runId: actCtx.runId, attempt: actCtx.attempt });
      return { step1: 'done', timestamp: Date.now() };
    },
  });

  const step2 = defineActivity({
    name: 'step2',
    execute: async (actCtx) => {
      activityExecutions.push({ name: 'step2', runId: actCtx.runId, attempt: actCtx.attempt });
      return { step2: 'done', timestamp: Date.now() };
    },
  });

  const step3 = defineActivity({
    name: 'step3',
    execute: async (actCtx) => {
      activityExecutions.push({ name: 'step3', runId: actCtx.runId, attempt: actCtx.attempt });
      return { step3: 'done', timestamp: Date.now() };
    },
  });

  const workflow = defineWorkflow({
    name: 'recoveryTest',
    activities: [step1, step2, step3],
  });

  // ===========================================================================
  // Test Cases
  // ===========================================================================

  describe('Recovery after crash during activity execution', () => {
    it('should resume workflow from last completed activity', async () => {
      const engine = await createEngine();
      const execution = await engine.start(workflow, { input: { moveId: 123 } });

      // Complete first activity
      await engine.tick();
      expect(activityExecutions).toHaveLength(1);
      expect(activityExecutions[0].name).toBe('step1');

      // Verify first activity completed
      const state = await engine.getExecution(execution.runId);
      expect(state?.state.step1).toBe('done');

      // Simulate crash/restart
      engine.stop();
      const newEngine = await restartEngine();
      newEngine.registerWorkflow(workflow);

      // Resume processing
      await newEngine.tick();

      // Should continue with step2, not re-run step1
      expect(activityExecutions.filter((e) => e.name === 'step1')).toHaveLength(1);
      expect(activityExecutions.filter((e) => e.name === 'step2')).toHaveLength(1);

      // Complete workflow
      await runToCompletion(ctx, execution.runId);

      const finalState = await newEngine.getExecution(execution.runId);
      expect(finalState?.status).toBe('completed');
      expect(finalState?.state).toMatchObject({
        moveId: 123,
        step1: 'done',
        step2: 'done',
        step3: 'done',
      });
    });

    it('should not lose state accumulated before crash', async () => {
      const engine = await createEngine();
      const execution = await engine.start(workflow, { input: { originalData: 'preserved' } });

      // Complete two activities
      await engine.tick(); // step1
      await engine.tick(); // step2

      const stateBeforeCrash = await engine.getExecution(execution.runId);

      // Simulate crash/restart
      engine.stop();
      const newEngine = await restartEngine();
      newEngine.registerWorkflow(workflow);

      // Verify state is intact
      const stateAfterRestart = await newEngine.getExecution(execution.runId);
      expect(stateAfterRestart?.state).toEqual(stateBeforeCrash?.state);
      expect(stateAfterRestart?.state.originalData).toBe('preserved');
      expect(stateAfterRestart?.state.step1).toBe('done');
      expect(stateAfterRestart?.state.step2).toBe('done');
    });

    it('should preserve input through crash/restart', async () => {
      const engine = await createEngine();
      const complexInput = {
        moveId: 456,
        photos: ['a.jpg', 'b.jpg'],
        metadata: { user: 'test' },
      };

      const execution = await engine.start(workflow, { input: complexInput });
      await engine.tick();

      // Crash and restart
      engine.stop();
      const newEngine = await restartEngine();
      newEngine.registerWorkflow(workflow);

      const recovered = await newEngine.getExecution(execution.runId);
      expect(recovered?.input).toEqual(complexInput);
    });
  });

  describe('Recovery with gated activities', () => {
    it('should resume gated activity after crash when condition is met', async () => {
      const gatedStep = defineActivity({
        name: 'gatedStep',
        runWhen: conditions.whenConnected,
        execute: async (actCtx) => {
          activityExecutions.push({ name: 'gatedStep', runId: actCtx.runId, attempt: actCtx.attempt });
          return { gated: 'done' };
        },
      });

      const gatedWorkflow = defineWorkflow({
        name: 'gatedRecovery',
        activities: [step1, gatedStep, step3],
      });

      environment.setConnected(false);
      const engine = await createEngine();
      const execution = await engine.start(gatedWorkflow, { input: {} });

      // First activity completes, second is gated
      await engine.tick(); // step1
      await engine.tick(); // gatedStep skipped

      const state = await engine.getExecution(execution.runId);
      expect(state?.currentActivityName).toBe('gatedStep');

      // Crash while gated
      engine.stop();

      // Restart with connectivity
      environment.setConnected(true);
      const newEngine = await restartEngine();
      newEngine.registerWorkflow(gatedWorkflow);

      // Advance clock past scheduled retry
      clock.advance(35000);

      // Should run gated activity now
      await newEngine.tick();
      expect(activityExecutions.filter((e) => e.name === 'gatedStep')).toHaveLength(1);

      // Complete workflow
      await runToCompletion(ctx, execution.runId);

      const finalState = await newEngine.getExecution(execution.runId);
      expect(finalState?.status).toBe('completed');
    });
  });

  describe('Recovery with retries', () => {
    it('should preserve retry count through crash', async () => {
      let failCount = 0;

      const flakyActivity = defineActivity({
        name: 'flaky',
        retry: { maximumAttempts: 5, initialInterval: 100 },
        execute: async (actCtx) => {
          activityExecutions.push({ name: 'flaky', runId: actCtx.runId, attempt: actCtx.attempt });
          failCount++;
          if (failCount < 3) {
            throw new Error('Transient failure');
          }
          return { recovered: true };
        },
      });

      const flakyWorkflow = defineWorkflow({
        name: 'flakyRecovery',
        activities: [flakyActivity],
      });

      const engine = await createEngine();
      const execution = await engine.start(flakyWorkflow, { input: {} });

      // First attempt fails
      await engine.tick();
      clock.advance(200);

      // Second attempt fails
      await engine.tick();

      // Crash between retries
      engine.stop();
      clock.advance(500);

      const newEngine = await restartEngine();
      newEngine.registerWorkflow(flakyWorkflow);

      // Continue retrying - should eventually succeed
      await newEngine.tick();

      const result = await newEngine.getExecution(execution.runId);
      expect(result?.status).toBe('completed');
      expect(result?.state.recovered).toBe(true);
    });
  });

  describe('Multiple workflows crash recovery', () => {
    it('should recover all running workflows after crash', async () => {
      const engine = await createEngine();

      const exec1 = await engine.start(workflow, { input: { id: 1 } });
      const exec2 = await engine.start(workflow, { input: { id: 2 } });
      const exec3 = await engine.start(workflow, { input: { id: 3 } });

      // Partial progress on each
      await engine.tick(); // exec1 step1
      await engine.tick(); // exec2 step1
      await engine.tick(); // exec3 step1

      // Crash
      engine.stop();

      const newEngine = await restartEngine();
      newEngine.registerWorkflow(workflow);

      // Complete all
      for (let i = 0; i < 20; i++) {
        await newEngine.tick();
      }

      const result1 = await newEngine.getExecution(exec1.runId);
      const result2 = await newEngine.getExecution(exec2.runId);
      const result3 = await newEngine.getExecution(exec3.runId);

      expect(result1?.status).toBe('completed');
      expect(result2?.status).toBe('completed');
      expect(result3?.status).toBe('completed');
    });

    it('should recover workflows at different stages', async () => {
      const engine = await createEngine();

      const exec1 = await engine.start(workflow, { input: { id: 1 } });
      const exec2 = await engine.start(workflow, { input: { id: 2 } });

      // Process just one task
      await engine.tick();

      const state1Before = await engine.getExecution(exec1.runId);
      const state2Before = await engine.getExecution(exec2.runId);

      // At least one should still be running
      const runningCount = [state1Before, state2Before].filter((s) => s?.status === 'running').length;
      expect(runningCount).toBeGreaterThanOrEqual(1);

      // Crash
      engine.stop();

      const newEngine = await restartEngine();
      newEngine.registerWorkflow(workflow);

      // Complete all
      for (let i = 0; i < 10; i++) {
        await newEngine.tick();
      }

      const result1 = await newEngine.getExecution(exec1.runId);
      const result2 = await newEngine.getExecution(exec2.runId);

      expect(result1?.status).toBe('completed');
      expect(result2?.status).toBe('completed');
      expect(result1?.state).toMatchObject({ step1: 'done', step2: 'done', step3: 'done' });
      expect(result2?.state).toMatchObject({ step1: 'done', step2: 'done', step3: 'done' });
    });
  });

  describe('UniqueKey preservation', () => {
    it('should maintain uniqueKey constraint through crash', async () => {
      const engine = await createEngine();

      await engine.start(workflow, { input: {}, uniqueKey: 'preserved-key' });
      await engine.tick();

      // Crash
      engine.stop();

      const newEngine = await restartEngine();
      newEngine.registerWorkflow(workflow);

      // Should still prevent duplicate
      await expect(
        newEngine.start(workflow, { input: {}, uniqueKey: 'preserved-key' })
      ).rejects.toThrow();
    });

    it('should release uniqueKey when workflow completes after recovery', async () => {
      const engine = await createEngine();

      const execution = await engine.start(workflow, {
        input: {},
        uniqueKey: 'release-after-complete',
      });

      await engine.tick();

      // Crash
      engine.stop();

      const newEngine = await restartEngine();
      newEngine.registerWorkflow(workflow);

      // Complete workflow
      await runToCompletion(ctx, execution.runId);

      // Should now allow same key
      const newExec = await newEngine.start(workflow, {
        input: {},
        uniqueKey: 'release-after-complete',
      });

      expect(newExec.runId).not.toBe(execution.runId);
    });
  });

  describe('Completed and failed workflow recovery', () => {
    it('should not re-process completed workflows after restart', async () => {
      const engine = await createEngine();
      const execution = await engine.start(workflow, { input: {} });

      await runToCompletion(ctx, execution.runId);
      const executionsBefore = activityExecutions.length;

      // Crash
      engine.stop();

      const newEngine = await restartEngine();
      newEngine.registerWorkflow(workflow);

      // Tick should not re-process completed workflow
      for (let i = 0; i < 5; i++) {
        await newEngine.tick();
      }

      expect(activityExecutions.length).toBe(executionsBefore);
    });

    it('should preserve failed workflow state after restart', async () => {
      const failingActivity = defineActivity({
        name: 'failing',
        retry: { maximumAttempts: 1 },
        execute: async () => {
          throw new Error('Permanent failure');
        },
      });

      const failingWorkflow = defineWorkflow({
        name: 'failing',
        activities: [failingActivity],
      });

      const engine = await createEngine();
      const execution = await engine.start(failingWorkflow, { input: { preserved: true } });

      await engine.tick();

      const stateBefore = await engine.getExecution(execution.runId);
      expect(stateBefore?.status).toBe('failed');

      // Crash
      engine.stop();

      const newEngine = await restartEngine();
      newEngine.registerWorkflow(failingWorkflow);

      const stateAfter = await newEngine.getExecution(execution.runId);
      expect(stateAfter?.status).toBe('failed');
      expect(stateAfter?.input.preserved).toBe(true);
    });
  });
});
