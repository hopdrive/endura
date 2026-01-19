/**
 * Unit Test: WorkflowEngine - State Threading
 *
 * Tests how state flows through workflow activities.
 * Validates that activity results are properly merged into
 * execution state and available to subsequent activities.
 *
 * Key scenarios tested:
 * - Input preservation through workflow
 * - Activity result merging (shallow merge)
 * - State accumulation across activities
 * - Handling null/undefined/empty returns
 * - Large payload handling
 * - Special characters in state
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowEngine } from '../../../../src/core/engine/WorkflowEngine';
import { InMemoryStorage } from '../../../../src/storage/memory';
import { MockClock, MockScheduler, MockEnvironment } from '../../../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../../../src/core/definitions';

describe('WorkflowEngine - State Threading', () => {
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

  describe('Activity return value handling', () => {
    it('should handle activity returning undefined', async () => {
      const activity = defineActivity({
        name: 'returnsUndefined',
        execute: async () => undefined as unknown as Record<string, unknown>,
      });

      const workflow = defineWorkflow({
        name: 'undefinedReturn',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, {
        input: { original: 'value' },
      });
      await engine.tick();

      const result = await engine.getExecution(execution.runId);
      expect(result?.state).toEqual({ original: 'value' });
    });

    it('should handle activity returning null', async () => {
      const activity = defineActivity({
        name: 'returnsNull',
        execute: async () => null as unknown as Record<string, unknown>,
      });

      const workflow = defineWorkflow({
        name: 'nullReturn',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, {
        input: { original: 'value' },
      });
      await engine.tick();

      const result = await engine.getExecution(execution.runId);
      // null should be treated as "nothing to merge"
      expect(result?.state).toEqual({ original: 'value' });
    });

    it('should handle activity returning empty object', async () => {
      const activity = defineActivity({
        name: 'returnsEmpty',
        execute: async () => ({}),
      });

      const workflow = defineWorkflow({
        name: 'emptyReturn',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, {
        input: { original: 'value' },
      });
      await engine.tick();

      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('completed');
      expect(result?.state).toEqual({ original: 'value' });
    });
  });

  describe('State merge behavior', () => {
    it('should shallow merge activity results (not deep merge)', async () => {
      const activity = defineActivity({
        name: 'nestedReturn',
        execute: async () => ({ nested: { b: 2 } }),
      });

      const workflow = defineWorkflow({
        name: 'shallowMerge',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, {
        input: { nested: { a: 1 } },
      });
      await engine.tick();

      const result = await engine.getExecution(execution.runId);
      // Shallow merge: nested is replaced, not merged
      expect(result?.state.nested).toEqual({ b: 2 });
      expect((result?.state.nested as Record<string, unknown>).a).toBeUndefined();
    });

    it('should allow later activities to overwrite earlier values', async () => {
      const activity1 = defineActivity({
        name: 'first',
        execute: async () => ({ status: 'pending' }),
      });
      const activity2 = defineActivity({
        name: 'second',
        execute: async () => ({ status: 'uploaded' }),
      });

      const workflow = defineWorkflow({
        name: 'overwrite',
        activities: [activity1, activity2],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });

      // Run both activities
      await engine.tick();
      await engine.tick();

      const result = await engine.getExecution(execution.runId);
      expect(result?.state.status).toBe('uploaded');
    });

    it('should preserve original input in execution.input', async () => {
      const activity = defineActivity({
        name: 'mutator',
        execute: async () => ({ moveId: 999, newField: 'added' }),
      });

      const workflow = defineWorkflow({
        name: 'preserveInput',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, {
        input: { moveId: 123, uri: 'original.jpg' },
      });
      await engine.tick();

      const result = await engine.getExecution(execution.runId);
      // Original input preserved
      expect(result?.input).toEqual({ moveId: 123, uri: 'original.jpg' });
      // State has merged values
      expect(result?.state.moveId).toBe(999);
      expect(result?.state.newField).toBe('added');
      expect(result?.state.uri).toBe('original.jpg');
    });

    it('should thread state through entire activity chain', async () => {
      const activity1 = defineActivity({
        name: 'step1',
        execute: async (ctx) => {
          expect(ctx.input.initial).toBe('data');
          return { step1: 'done' };
        },
      });
      const activity2 = defineActivity({
        name: 'step2',
        execute: async (ctx) => {
          expect(ctx.input.step1).toBe('done');
          return { step2: 'done' };
        },
      });
      const activity3 = defineActivity({
        name: 'step3',
        execute: async (ctx) => {
          expect(ctx.input.step1).toBe('done');
          expect(ctx.input.step2).toBe('done');
          return { step3: 'done' };
        },
      });

      const workflow = defineWorkflow({
        name: 'chainState',
        activities: [activity1, activity2, activity3],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, {
        input: { initial: 'data' },
      });

      // Run all three activities
      await engine.tick();
      await engine.tick();
      await engine.tick();

      const result = await engine.getExecution(execution.runId);
      expect(result?.state).toEqual({
        initial: 'data',
        step1: 'done',
        step2: 'done',
        step3: 'done',
      });
    });

    it('should accumulate state across activities even after retries', async () => {
      let attempts = 0;
      const flakyActivity = defineActivity({
        name: 'flaky',
        retry: { maximumAttempts: 3, initialInterval: 10 },
        execute: async () => {
          attempts++;
          if (attempts === 1) throw new Error('First attempt fails');
          return { flakyResult: 'recovered' };
        },
      });

      const nextActivity = defineActivity({
        name: 'next',
        execute: async (ctx) => {
          expect(ctx.input.flakyResult).toBe('recovered');
          return { final: 'done' };
        },
      });

      const workflow = defineWorkflow({
        name: 'retryState',
        activities: [flakyActivity, nextActivity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: { start: 'value' } });

      for (let i = 0; i < 5; i++) {
        await engine.tick();
        clock.advance(50);
      }

      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('completed');
      expect(result?.state).toEqual({
        start: 'value',
        flakyResult: 'recovered',
        final: 'done',
      });
    });
  });

  describe('Edge cases', () => {
    it('should handle very large payloads', async () => {
      const largeData = {
        array: Array.from({ length: 1000 }, (_, i) => ({ index: i, data: 'x'.repeat(50) })),
        nested: {
          deep: {
            structure: {
              with: {
                many: {
                  levels: 'value',
                },
              },
            },
          },
        },
      };

      const activity = defineActivity({
        name: 'largePayload',
        execute: async () => ({ processed: true }),
      });

      const workflow = defineWorkflow({
        name: 'largePayload',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: largeData });
      await engine.tick();

      const result = await engine.getExecution(execution.runId);
      expect(result?.status).toBe('completed');
      expect((result?.input.array as unknown[]).length).toBe(1000);
    });

    it('should handle special characters in payload', async () => {
      const specialData = {
        unicode: '日本語 한국어 中文 العربية',
        emoji: '🚀🎉💡',
        escapes: 'line1\nline2\ttab',
        quotes: `"double" 'single' \`backtick\``,
      };

      const activity = defineActivity({
        name: 'special',
        execute: async () => ({ echoed: true }),
      });

      const workflow = defineWorkflow({
        name: 'specialChars',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: specialData });
      await engine.tick();

      const result = await engine.getExecution(execution.runId);
      expect(result?.input.unicode).toBe(specialData.unicode);
      expect(result?.input.emoji).toBe(specialData.emoji);
    });

    it('should handle numeric keys in state', async () => {
      const activity = defineActivity({
        name: 'numericKeys',
        execute: async () => ({ '123': 'numeric', '456': 'keys' }),
      });

      const workflow = defineWorkflow({
        name: 'numericKeys',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: { '0': 'initial' } });
      await engine.tick();

      const result = await engine.getExecution(execution.runId);
      expect(result?.state['0']).toBe('initial');
      expect(result?.state['123']).toBe('numeric');
      expect(result?.state['456']).toBe('keys');
    });

    it('should handle boolean and number values in state', async () => {
      const activity = defineActivity({
        name: 'primitives',
        execute: async () => ({
          bool: true,
          num: 42.5,
          zero: 0,
          negative: -100,
          falsy: false,
        }),
      });

      const workflow = defineWorkflow({
        name: 'primitiveValues',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });
      await engine.tick();

      const result = await engine.getExecution(execution.runId);
      expect(result?.state.bool).toBe(true);
      expect(result?.state.num).toBe(42.5);
      expect(result?.state.zero).toBe(0);
      expect(result?.state.negative).toBe(-100);
      expect(result?.state.falsy).toBe(false);
    });
  });
});
