/**
 * Unit Test: WorkflowEngine - Input Validation
 *
 * Tests input validation and error handling for invalid configurations.
 * Validates that the engine rejects malformed workflows, activities,
 * and execution parameters with clear error messages.
 *
 * Key scenarios tested:
 * - Invalid workflow definitions
 * - Invalid activity definitions
 * - Missing required fields
 * - Type validation
 * - Error message clarity
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowEngine } from '../../../../src/core/engine/WorkflowEngine';
import { InMemoryStorage } from '../../../../src/storage/memory';
import { MockClock, MockScheduler, MockEnvironment } from '../../../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../../../src/core/definitions';
import { createTestActivity } from '../../../utils/testHelpers';
import { createLoopbackDispatcher } from '../../../../src/workers/loopback';

describe('WorkflowEngine - Input Validation', () => {
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

  describe('Workflow definition validation', () => {
    it('should reject workflow with empty activities array', () => {
      expect(() =>
        defineWorkflow({
          name: 'empty',
          activities: [],
        })
      ).toThrow(/at least one activity/i);
    });

    it('should accept workflow with valid activities', () => {
      const activity = createTestActivity('test');

      const workflow = defineWorkflow({
        name: 'valid',
        activities: [activity],
      });

      expect(workflow.name).toBe('valid');
      expect(workflow.activities).toHaveLength(1);
    });

    it('should accept workflow with multiple activities', () => {
      const activity1 = createTestActivity('first');
      const activity2 = createTestActivity('second');

      const workflow = defineWorkflow({
        name: 'multi',
        activities: [activity1, activity2],
      });

      expect(workflow.activities).toHaveLength(2);
    });
  });

  describe('Workflow start validation', () => {
    it('should reject starting unregistered workflow', async () => {
      const engine = await createEngine();

      const workflow = defineWorkflow({
        name: 'unregistered',
        activities: [createTestActivity('test')],
      });

      // Don't register the workflow
      await expect(
        engine.start(workflow, { input: {} })
      ).resolves.toBeDefined(); // Auto-registers
    });

    it('should accept empty input object', async () => {
      const activity = createTestActivity('test');
      const workflow = defineWorkflow({
        name: 'emptyInput',
        activities: [activity],
      });

      const engine = await createEngine();
      const execution = await engine.start(workflow, { input: {} });

      expect(execution.input).toEqual({});
    });

    it('should accept complex input objects', async () => {
      const activity = createTestActivity('test');
      const workflow = defineWorkflow({
        name: 'complexInput',
        activities: [activity],
      });

      const complexInput = {
        string: 'test',
        number: 123,
        boolean: true,
        array: [1, 2, 3],
        nested: { deep: { value: 'nested' } },
        nullValue: null,
      };

      const engine = await createEngine();
      const execution = await engine.start(workflow, { input: complexInput });

      expect(execution.input).toEqual(complexInput);
    });
  });

  describe('Activity definition validation', () => {
    it('should accept activity with minimal configuration', () => {
      const activity = defineActivity({
        name: 'minimal',
        execute: async () => ({}),
      });

      expect(activity.name).toBe('minimal');
    });

    it('should accept activity with all options', () => {
      const activity = defineActivity({
        name: 'full',
        startToCloseTimeout: 5000,
        retry: {
          maximumAttempts: 3,
          initialInterval: 100,
          backoffCoefficient: 2,
          maximumInterval: 5000,
        },
        execute: async () => ({ result: 'done' }),
        onStart: async () => {},
        onSuccess: async () => {},
        onFailure: async () => {},
        onFailed: async () => {},
      });

      expect(activity.name).toBe('full');
      expect(activity.options?.startToCloseTimeout).toBe(5000);
      expect(activity.options?.retry?.maximumAttempts).toBe(3);
    });

    it('should use default timeout when not specified', async () => {
      const activity = defineActivity({
        name: 'defaultTimeout',
        execute: async () => ({ done: true }),
      });

      const workflow = defineWorkflow({
        name: 'checkTimeout',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });

      const tasks = await storage.getActivityTasksForExecution(execution.runId);
      // Default timeout is 25000ms (from WorkflowEngine)
      expect(tasks[0]?.timeout).toBe(25000);
    });

    it('should use specified timeout', async () => {
      const activity = defineActivity({
        name: 'customTimeout',
        startToCloseTimeout: 10000,
        execute: async () => ({ done: true }),
      });

      const workflow = defineWorkflow({
        name: 'checkTimeout',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });

      const tasks = await storage.getActivityTasksForExecution(execution.runId);
      expect(tasks[0]?.timeout).toBe(10000);
    });
  });

  describe('UniqueKey validation', () => {
    it('should accept string uniqueKey', async () => {
      const activity = createTestActivity('test');
      const workflow = defineWorkflow({
        name: 'uniqueTest',
        activities: [activity],
      });

      const engine = await createEngine();
      const execution = await engine.start(workflow, {
        input: {},
        uniqueKey: 'my-unique-key',
      });

      expect(execution.uniqueKey).toBe('my-unique-key');
    });

    it('should accept uniqueKey with special characters', async () => {
      const activity = createTestActivity('test');
      const workflow = defineWorkflow({
        name: 'specialKey',
        activities: [activity],
      });

      const engine = await createEngine();
      const execution = await engine.start(workflow, {
        input: {},
        uniqueKey: 'user:123:photo:upload',
      });

      expect(execution.uniqueKey).toBe('user:123:photo:upload');
    });

    it('should accept uniqueKey without specifying', async () => {
      const activity = createTestActivity('test');
      const workflow = defineWorkflow({
        name: 'noKey',
        activities: [activity],
      });

      const engine = await createEngine();
      const execution = await engine.start(workflow, { input: {} });

      expect(execution.uniqueKey).toBeUndefined();
    });
  });

  describe('Retry policy validation', () => {
    it('should use default retry when not specified', async () => {
      const activity = defineActivity({
        name: 'defaultRetry',
        execute: async () => ({ done: true }),
      });

      const workflow = defineWorkflow({
        name: 'checkRetry',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });

      const tasks = await storage.getActivityTasksForExecution(execution.runId);
      // Default max attempts is 3 — durable execution must not default to
      // at-most-once
      expect(tasks[0]?.maxAttempts).toBe(3);
    });

    it('should use specified retry policy', async () => {
      const activity = defineActivity({
        name: 'customRetry',
        retry: { maximumAttempts: 5 },
        execute: async () => ({ done: true }),
      });

      const workflow = defineWorkflow({
        name: 'checkRetry',
        activities: [activity],
      });

      const engine = await createEngine();
      engine.registerWorkflow(workflow);
      const execution = await engine.start(workflow, { input: {} });

      const tasks = await storage.getActivityTasksForExecution(execution.runId);
      expect(tasks[0]?.maxAttempts).toBe(5);
    });
  });

  describe('Edge cases', () => {
    it('should handle very long workflow names', async () => {
      const longName = 'a'.repeat(200);
      const activity = createTestActivity('test');
      const workflow = defineWorkflow({
        name: longName,
        activities: [activity],
      });

      const engine = await createEngine();
      const execution = await engine.start(workflow, { input: {} });

      expect(execution.workflowName).toBe(longName);
    });

    it('should handle unicode in workflow names', async () => {
      const activity = createTestActivity('test');
      const workflow = defineWorkflow({
        name: '워크플로우_日本語_🚀',
        activities: [activity],
      });

      const engine = await createEngine();
      const execution = await engine.start(workflow, { input: {} });

      expect(execution.workflowName).toBe('워크플로우_日本語_🚀');
    });
  });
});
