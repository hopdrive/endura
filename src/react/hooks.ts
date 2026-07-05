/**
 * React hooks for workflow engine integration.
 *
 * These hooks provide reactive access to workflow state for building UIs.
 * They work with any storage adapter.
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
  Workflow,
  StartWorkflowOptions,
} from '../core/types';
import { WorkflowEngine } from '../core/engine';

/**
 * Hook to subscribe to a workflow execution.
 *
 * @param engine - The workflow engine
 * @param runId - The execution run ID
 * @returns The execution or null if not found/loading
 */
export function useExecution(
  engine: WorkflowEngine,
  runId: string | null | undefined
): WorkflowExecution | null {
  const [execution, setExecution] = useState<WorkflowExecution | null>(null);

  useEffect(() => {
    if (!runId) {
      setExecution(null);
      return;
    }

    // Initial fetch
    void engine.getExecution(runId).then(setExecution);

    // Subscribe to changes
    // Note: This uses polling since the engine doesn't have built-in subscriptions
    // In a production app, you might want to add subscription support to the engine
    const interval = setInterval(async () => {
      const updated = await engine.getExecution(runId);
      setExecution(prev => {
        // Only update if changed
        if (JSON.stringify(prev) !== JSON.stringify(updated)) {
          return updated;
        }
        return prev;
      });
    }, 500);

    return () => clearInterval(interval);
  }, [engine, runId]);

  return execution;
}

/**
 * Hook to get executions by status.
 *
 * @param engine - The workflow engine
 * @param status - The status to filter by
 * @param refreshInterval - How often to refresh in ms (default: 1000)
 * @returns Array of executions with the given status
 */
export function useExecutionsByStatus(
  engine: WorkflowEngine,
  status: WorkflowExecutionStatus,
  refreshInterval: number = 1000
): WorkflowExecution[] {
  const [executions, setExecutions] = useState<WorkflowExecution[]>([]);

  useEffect(() => {
    const refresh = async () => {
      const result = await engine.getExecutionsByStatus(status);
      setExecutions(result);
    };

    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, refreshInterval);

    return () => clearInterval(interval);
  }, [engine, status, refreshInterval]);

  return executions;
}

/**
 * Hook to get dead letters from the engine.
 *
 * @param engine - The workflow engine
 * @param unacknowledgedOnly - Only return unacknowledged dead letters
 * @param refreshInterval - How often to refresh in ms (default: 5000)
 * @returns Array of dead letter records
 */
export function useDeadLetters(
  engine: WorkflowEngine,
  unacknowledgedOnly: boolean = true,
  refreshInterval: number = 5000
): DeadLetterRecord[] {
  const [deadLetters, setDeadLetters] = useState<DeadLetterRecord[]>([]);

  useEffect(() => {
    const refresh = async () => {
      const result = unacknowledgedOnly
        ? await engine.getUnacknowledgedDeadLetters()
        : await engine.getDeadLetters();
      setDeadLetters(result);
    };

    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, refreshInterval);

    return () => clearInterval(interval);
  }, [engine, unacknowledgedOnly, refreshInterval]);

  return deadLetters;
}

/**
 * Hook to track pending activity count.
 *
 * @param storage - The storage adapter
 * @param refreshInterval - How often to refresh in ms (default: 1000)
 * @returns Number of pending activities
 */
export function usePendingActivityCount(
  storage: Storage,
  refreshInterval: number = 1000
): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const refresh = async () => {
      const tasks = await storage.getActivityTasksByStatus('pending');
      setCount(tasks.length);
    };

    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, refreshInterval);

    return () => clearInterval(interval);
  }, [storage, refreshInterval]);

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
 * @param refreshInterval - How often to refresh in ms (default: 2000)
 * @returns Execution statistics
 */
export function useExecutionStats(
  engine: WorkflowEngine,
  refreshInterval: number = 2000
): ExecutionStats {
  const [stats, setStats] = useState<ExecutionStats>({
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    total: 0,
  });

  useEffect(() => {
    const refresh = async () => {
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
    };

    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, refreshInterval);

    return () => clearInterval(interval);
  }, [engine, refreshInterval]);

  return stats;
}

/**
 * Hook to start a workflow and track its execution.
 *
 * @param engine - The workflow engine
 * @returns Object with startWorkflow function and current execution
 */
export function useWorkflowStarter<TInput>(engine: WorkflowEngine) {
  const [execution, setExecution] = useState<WorkflowExecution | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const startWorkflow = useCallback(
    async (
      workflow: { name: string; activities: unknown[] },
      options: { input: TInput; uniqueKey?: string }
    ) => {
      setIsStarting(true);
      setError(null);

      try {
        const exec = await engine.start(
          workflow as unknown as Workflow<Record<string, unknown>>,
          options as unknown as StartWorkflowOptions<Record<string, unknown>>
        );
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
