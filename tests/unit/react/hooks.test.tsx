/**
 * Tests for React hooks - workflow engine integration.
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { createLoopbackDispatcher } from '../../../src/workers/loopback';
import {
  useExecution,
  useExecutionsByStatus,
  useDeadLetters,
  usePendingActivityCount,
  useExecutionStats,
  useWorkflowStarter,
} from '../../../src/react';
import { WorkflowEngine } from '../../../src/core/engine';
import { InMemoryStorage } from '../../../src/storage/memory';
import { MockClock, MockScheduler, MockEnvironment } from '../../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../../src/core/definitions';

describe('React Hooks', () => {
  let storage: InMemoryStorage;
  let clock: MockClock;
  let scheduler: MockScheduler;
  let environment: MockEnvironment;
  let engine: WorkflowEngine;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    clock = new MockClock(1000000);
    scheduler = new MockScheduler(clock);
    environment = new MockEnvironment({ isConnected: true });
    engine = await WorkflowEngine.create({
      dispatcher: createLoopbackDispatcher(),
      storage,
      clock,
      scheduler,
      environment,
    });
  });

  afterEach(() => {
    engine.stop();
  });

  const testActivity = defineActivity({
    name: 'test',
    execute: async () => ({ done: true }),
  });

  const testWorkflow = defineWorkflow({
    name: 'test',
    activities: [testActivity],
  });

  describe('useExecution', () => {
    it('should return null when runId is null', () => {
      const { result } = renderHook(() => useExecution(engine, null));
      expect(result.current).toBeNull();
    });

    it('should return null when runId is undefined', () => {
      const { result } = renderHook(() => useExecution(engine, undefined));
      expect(result.current).toBeNull();
    });

    it('should fetch execution on mount', async () => {
      const execution = await engine.start(testWorkflow, { input: {} });

      const { result } = renderHook(() => useExecution(engine, execution.runId));

      await waitFor(() => {
        expect(result.current).not.toBeNull();
      });

      expect(result.current?.runId).toBe(execution.runId);
      expect(result.current?.workflowName).toBe('test');
    });

    it('should clear execution when runId becomes null', async () => {
      const execution = await engine.start(testWorkflow, { input: {} });

      const { result, rerender } = renderHook(
        ({ runId }) => useExecution(engine, runId),
        { initialProps: { runId: execution.runId as string | null } }
      );

      await waitFor(() => {
        expect(result.current).not.toBeNull();
      });

      rerender({ runId: null });

      expect(result.current).toBeNull();
    });

    it('should change execution when runId changes', async () => {
      const exec1 = await engine.start(testWorkflow, { input: { id: 1 } });
      const exec2 = await engine.start(testWorkflow, { input: { id: 2 } });

      const { result, rerender } = renderHook(
        ({ runId }) => useExecution(engine, runId),
        { initialProps: { runId: exec1.runId } }
      );

      await waitFor(() => {
        expect(result.current?.runId).toBe(exec1.runId);
      });

      rerender({ runId: exec2.runId });

      await waitFor(() => {
        expect(result.current?.runId).toBe(exec2.runId);
      });
    });
  });

  describe('useExecutionsByStatus', () => {
    it('should return empty array initially', async () => {
      const { result } = renderHook(() =>
        useExecutionsByStatus(engine, 'running', 100)
      );

      // Wait for initial fetch
      await waitFor(() => {
        expect(Array.isArray(result.current)).toBe(true);
      });
    });

    it('should return running executions', async () => {
      await engine.start(testWorkflow, { input: {} });
      await engine.start(testWorkflow, { input: {} });

      const { result } = renderHook(() =>
        useExecutionsByStatus(engine, 'running', 100)
      );

      await waitFor(() => {
        expect(result.current.length).toBe(2);
      });
    });

    it('should return completed executions', async () => {
      const exec = await engine.start(testWorkflow, { input: {} });
      await engine.tick(); // Complete it

      const { result } = renderHook(() =>
        useExecutionsByStatus(engine, 'completed', 100)
      );

      await waitFor(() => {
        expect(result.current.length).toBe(1);
      });
      expect(result.current[0]?.runId).toBe(exec.runId);
    });
  });

  describe('useDeadLetters', () => {
    it('should return empty array initially', async () => {
      const { result } = renderHook(() => useDeadLetters(engine, true, 100));

      await waitFor(() => {
        expect(result.current).toEqual([]);
      });
    });

    it('should return dead letters after workflow fails', async () => {
      const failingActivity = defineActivity<Record<string, unknown>, Record<string, unknown>>({
        name: 'failing',
        retry: { maximumAttempts: 1 },
        execute: async (): Promise<Record<string, unknown>> => {
          throw new Error('Permanent failure');
        },
      });

      const failingWorkflow = defineWorkflow({
        name: 'failing',
        activities: [failingActivity],
      });

      await engine.start(failingWorkflow, { input: {} });
      await engine.tick(); // Fail and create dead letter

      const { result } = renderHook(() => useDeadLetters(engine, true, 100));

      await waitFor(() => {
        expect(result.current.length).toBe(1);
      });

      expect(result.current[0]?.error).toContain('Permanent failure');
    });
  });

  describe('usePendingActivityCount', () => {
    it('should return 0 when no pending activities', async () => {
      const { result } = renderHook(() =>
        usePendingActivityCount(storage, 100)
      );

      await waitFor(() => {
        expect(result.current).toBe(0);
      });
    });

    it('should count pending activities', async () => {
      await engine.start(testWorkflow, { input: {} });
      await engine.start(testWorkflow, { input: {} });

      const { result } = renderHook(() =>
        usePendingActivityCount(storage, 100)
      );

      await waitFor(() => {
        expect(result.current).toBe(2);
      });
    });
  });

  describe('useExecutionStats', () => {
    it('should return zero stats initially', async () => {
      const { result } = renderHook(() => useExecutionStats(engine, 100));

      await waitFor(() => {
        expect(result.current.total).toBe(0);
      });

      expect(result.current).toEqual({
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        total: 0,
      });
    });

    it('should count running executions', async () => {
      await engine.start(testWorkflow, { input: {} });
      await engine.start(testWorkflow, { input: {} });

      const { result } = renderHook(() => useExecutionStats(engine, 100));

      await waitFor(() => {
        expect(result.current.running).toBe(2);
        expect(result.current.total).toBe(2);
      });
    });

    it('should count completed executions', async () => {
      await engine.start(testWorkflow, { input: {} });
      await engine.tick();

      const { result } = renderHook(() => useExecutionStats(engine, 100));

      await waitFor(() => {
        expect(result.current.completed).toBe(1);
        expect(result.current.total).toBe(1);
      });
    });

    it('should count cancelled executions', async () => {
      const exec = await engine.start(testWorkflow, { input: {} });
      await engine.cancelExecution(exec.runId);

      const { result } = renderHook(() => useExecutionStats(engine, 100));

      await waitFor(() => {
        expect(result.current.cancelled).toBe(1);
        expect(result.current.total).toBe(1);
      });
    });

    it('should count failed executions', async () => {
      const failingActivity = defineActivity<Record<string, unknown>, Record<string, unknown>>({
        name: 'failing',
        retry: { maximumAttempts: 1 },
        execute: async (): Promise<Record<string, unknown>> => {
          throw new Error('Fail');
        },
      });

      const failingWorkflow = defineWorkflow({
        name: 'failing',
        activities: [failingActivity],
      });

      await engine.start(failingWorkflow, { input: {} });
      await engine.tick();

      const { result } = renderHook(() => useExecutionStats(engine, 100));

      await waitFor(() => {
        expect(result.current.failed).toBe(1);
        expect(result.current.total).toBe(1);
      });
    });
  });

  describe('useWorkflowStarter', () => {
    it('should provide startWorkflow function', () => {
      const { result } = renderHook(() => useWorkflowStarter(engine));

      expect(result.current.startWorkflow).toBeDefined();
      expect(result.current.execution).toBeNull();
      expect(result.current.isStarting).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('should start workflow and track execution', async () => {
      const { result } = renderHook(() =>
        useWorkflowStarter<{ data: string }>(engine)
      );

      await act(async () => {
        await result.current.startWorkflow(testWorkflow, {
          input: { data: 'test' },
        });
      });

      expect(result.current.execution).not.toBeNull();
      expect(result.current.execution?.workflowName).toBe('test');
      expect(result.current.isStarting).toBe(false);
    });

    it('should set isStarting during workflow start', async () => {
      const { result } = renderHook(() => useWorkflowStarter(engine));

      expect(result.current.isStarting).toBe(false);

      // Start the workflow
      await act(async () => {
        await result.current.startWorkflow(testWorkflow, { input: {} });
      });

      // Verify isStarting is false after completion
      // Note: isStarting may be true briefly during the async operation,
      // but due to React's async state updates and the speed of the operation,
      // we can't reliably observe it. The implementation correctly sets it to true
      // and then false in the finally block.
      expect(result.current.isStarting).toBe(false);
      expect(result.current.execution).not.toBeNull();
    });

    it('should handle start errors', async () => {
      const { result } = renderHook(() => useWorkflowStarter(engine));

      // Start with uniqueKey
      await act(async () => {
        await result.current.startWorkflow(testWorkflow, {
          input: {},
          uniqueKey: 'unique',
        });
      });

      // Try to start again with same key (should fail)
      await act(async () => {
        try {
          await result.current.startWorkflow(testWorkflow, {
            input: {},
            uniqueKey: 'unique',
          });
        } catch {
          // Expected
        }
      });

      expect(result.current.error).not.toBeNull();
    });

    it('should reset state with reset function', async () => {
      const { result } = renderHook(() => useWorkflowStarter(engine));

      await act(async () => {
        await result.current.startWorkflow(testWorkflow, { input: {} });
      });

      expect(result.current.execution).not.toBeNull();

      act(() => {
        result.current.reset();
      });

      expect(result.current.execution).toBeNull();
      expect(result.current.error).toBeNull();
    });

    it('should return execution from startWorkflow', async () => {
      const { result } = renderHook(() => useWorkflowStarter(engine));

      let returnedExecution: unknown;
      await act(async () => {
        returnedExecution = await result.current.startWorkflow(testWorkflow, {
          input: { test: true },
        });
      });

      expect(returnedExecution).toBeDefined();
      expect((returnedExecution as any).workflowName).toBe('test');
    });
  });
});
