/**
 * React hooks for workflow engine integration.
 *
 * These hooks provide reactive access to workflow state for building UIs.
 * They work with any storage adapter.
 *
 * Reactivity: hooks subscribe to storage change events (Storage.subscribe)
 * and refresh only when a relevant record changes, coalescing bursts.
 * Interval polling is used ONLY as a fallback when the storage adapter
 * doesn't implement subscribe — the `refreshInterval` parameters control
 * that fallback cadence and are otherwise unused.
 *
 * @example
 * ```tsx
 * import { useExecution, useDeadLetters } from 'endura/react';
 *
 * function WorkflowProgress({ runId }: { runId: string }) {
 *   const execution = useExecution(engine, runId);
 *
 *   if (!execution) return <Text>Loading...</Text>;
 *
 *   return (
 *     <View>
 *       <Text>Status: {execution.status}</Text>
 *       <Text>Current: {execution.currentActivityName}</Text>
 *     </View>
 *   );
 * }
 * ```
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import {
  WorkflowExecution,
  WorkflowExecutionStatus,
  DeadLetterRecord,
  Storage,
  StorageChange,
  Workflow,
  StartWorkflowOptions,
} from '../core/types';
import { WorkflowEngine } from '../core/engine';

// Trailing debounce for change bursts: one engine advance emits several
// storage events back-to-back; a single refresh shortly after the last
// write is imperceptible in the UI and much cheaper.
const COALESCE_MS = 50;

/**
 * Shared wiring: refresh once on mount, then on relevant storage
 * changes (coalesced). Falls back to interval polling only when the
 * storage has no subscribe capability.
 */
function useStorageDrivenRefresh(
  subscribe: ((callback: (change: StorageChange) => void) => (() => void) | undefined) | undefined,
  refresh: () => Promise<void>,
  isRelevant: (change: StorageChange) => boolean,
  fallbackIntervalMs: number,
  deps: readonly unknown[]
): void {
  useEffect(() => {
    let disposed = false;
    let coalesceTimer: ReturnType<typeof setTimeout> | null = null;

    const safeRefresh = () => {
      if (!disposed) void refresh();
    };

    safeRefresh();

    const scheduleRefresh = () => {
      if (coalesceTimer !== null) return;
      coalesceTimer = setTimeout(() => {
        coalesceTimer = null;
        safeRefresh();
      }, COALESCE_MS);
    };

    const unsubscribe = subscribe?.(change => {
      if (isRelevant(change)) scheduleRefresh();
    });

    let pollInterval: ReturnType<typeof setInterval> | null = null;
    if (!unsubscribe) {
      pollInterval = setInterval(safeRefresh, fallbackIntervalMs);
    }

    return () => {
      disposed = true;
      if (coalesceTimer !== null) clearTimeout(coalesceTimer);
      if (unsubscribe) unsubscribe();
      if (pollInterval !== null) clearInterval(pollInterval);
    };
  }, deps);
}

/**
 * Hook to subscribe to a workflow execution.
 *
 * @param engine - The workflow engine
 * @param runId - The execution run ID
 * @param refreshInterval - Fallback polling cadence in ms, used only when the storage lacks subscribe (default: 1000)
 * @returns The execution or null if not found/loading
 */
export function useExecution(
  engine: WorkflowEngine,
  runId: string | null | undefined,
  refreshInterval: number = 1000
): WorkflowExecution | null {
  const [execution, setExecution] = useState<WorkflowExecution | null>(null);

  useEffect(() => {
    if (!runId) setExecution(null);
  }, [runId]);

  useStorageDrivenRefresh(
    // With no runId there is nothing to watch: a dummy subscription
    // keeps the fallback poller off.
    runId ? callback => engine.subscribeToChanges(callback) : () => () => {},
    async () => {
      if (!runId) return;
      setExecution(await engine.getExecution(runId));
    },
    change => change.type === 'execution' && change.id === runId,
    refreshInterval,
    [engine, runId, refreshInterval]
  );

  return execution;
}

/**
 * Hook to get executions by status.
 *
 * @param engine - The workflow engine
 * @param status - The status to filter by
 * @param refreshInterval - Fallback polling cadence in ms, used only when the storage lacks subscribe (default: 1000)
 * @returns Array of executions with the given status
 */
export function useExecutionsByStatus(
  engine: WorkflowEngine,
  status: WorkflowExecutionStatus,
  refreshInterval: number = 1000
): WorkflowExecution[] {
  const [executions, setExecutions] = useState<WorkflowExecution[]>([]);

  useStorageDrivenRefresh(
    callback => engine.subscribeToChanges(callback),
    async () => {
      setExecutions(await engine.getExecutionsByStatus(status));
    },
    change => change.type === 'execution',
    refreshInterval,
    [engine, status, refreshInterval]
  );

  return executions;
}

/**
 * Hook to get dead letters from the engine.
 *
 * @param engine - The workflow engine
 * @param unacknowledgedOnly - Only return unacknowledged dead letters
 * @param refreshInterval - Fallback polling cadence in ms, used only when the storage lacks subscribe (default: 5000)
 * @returns Array of dead letter records
 */
export function useDeadLetters(
  engine: WorkflowEngine,
  unacknowledgedOnly: boolean = true,
  refreshInterval: number = 5000
): DeadLetterRecord[] {
  const [deadLetters, setDeadLetters] = useState<DeadLetterRecord[]>([]);

  useStorageDrivenRefresh(
    callback => engine.subscribeToChanges(callback),
    async () => {
      setDeadLetters(
        unacknowledgedOnly ? await engine.getUnacknowledgedDeadLetters() : await engine.getDeadLetters()
      );
    },
    change => change.type === 'deadletter',
    refreshInterval,
    [engine, unacknowledgedOnly, refreshInterval]
  );

  return deadLetters;
}

/**
 * Hook to track pending activity count.
 *
 * @param storage - The storage adapter
 * @param refreshInterval - Fallback polling cadence in ms, used only when the storage lacks subscribe (default: 1000)
 * @returns Number of pending activities
 */
export function usePendingActivityCount(storage: Storage, refreshInterval: number = 1000): number {
  const [count, setCount] = useState(0);

  useStorageDrivenRefresh(
    callback => storage.subscribe?.(callback),
    async () => {
      const tasks = await storage.getActivityTasksByStatus('pending');
      setCount(tasks.length);
    },
    change => change.type === 'task',
    refreshInterval,
    [storage, refreshInterval]
  );

  return count;
}

/**
 * Aggregate statistics about workflow executions.
 */
export interface ExecutionStats {
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  total: number;
}

/**
 * Hook to get aggregate execution statistics.
 *
 * @param engine - The workflow engine
 * @param refreshInterval - Fallback polling cadence in ms, used only when the storage lacks subscribe (default: 2000)
 * @returns Execution statistics
 */
export function useExecutionStats(engine: WorkflowEngine, refreshInterval: number = 2000): ExecutionStats {
  const [stats, setStats] = useState<ExecutionStats>({
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    total: 0,
  });

  useStorageDrivenRefresh(
    callback => engine.subscribeToChanges(callback),
    async () => {
      const [running, completed, failed, cancelled] = await Promise.all([
        engine.getExecutionsByStatus('running'),
        engine.getExecutionsByStatus('completed'),
        engine.getExecutionsByStatus('failed'),
        engine.getExecutionsByStatus('cancelled'),
      ]);

      setStats({
        running: running.length,
        completed: completed.length,
        failed: failed.length,
        cancelled: cancelled.length,
        total: running.length + completed.length + failed.length + cancelled.length,
      });
    },
    change => change.type === 'execution',
    refreshInterval,
    [engine, refreshInterval]
  );

  return stats;
}

/**
 * Hook to start a workflow and track its execution.
 *
 * @param engine - The workflow engine
 * @returns Object with startWorkflow function and current execution
 */
export function useWorkflowStarter<TInput extends Record<string, unknown> = Record<string, unknown>>(
  engine: WorkflowEngine
) {
  const [execution, setExecution] = useState<WorkflowExecution | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const startWorkflow = useCallback(
    async (workflow: Workflow<TInput>, options: StartWorkflowOptions<TInput>) => {
      setIsStarting(true);
      setError(null);

      try {
        const exec = await engine.start(workflow, options);
        setExecution(exec);
        return exec;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        throw error;
      } finally {
        setIsStarting(false);
      }
    },
    [engine]
  );

  const reset = useCallback(() => {
    setExecution(null);
    setError(null);
  }, []);

  return {
    startWorkflow,
    execution,
    isStarting,
    error,
    reset,
  };
}

/**
 * Hook to run the engine tick loop.
 * Useful for foreground processing when the app is active.
 *
 * @param engine - The workflow engine
 * @param enabled - Whether to run the tick loop
 * @param tickInterval - Interval between ticks in ms (default: 100)
 */
export function useEngineRunner(
  engine: WorkflowEngine,
  enabled: boolean = true,
  tickInterval: number = 100
): void {
  const isRunningRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    isRunningRef.current = true;

    const runLoop = async () => {
      while (isRunningRef.current) {
        await engine.tick();
        await new Promise(resolve => setTimeout(resolve, tickInterval));
      }
    };

    void runLoop();

    return () => {
      isRunningRef.current = false;
    };
  }, [engine, enabled, tickInterval]);
}
