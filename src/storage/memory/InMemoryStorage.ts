/**
 * In-memory storage adapter for testing and development.
 */

/* eslint-disable @typescript-eslint/require-await --
 * Fully synchronous implementation of the async Storage interface; the
 * async keyword satisfies the contract without awaiting anything. */

import {
  Storage,
  StorageChange,
  WorkflowExecution,
  WorkflowExecutionStatus,
  ActivityTask,
  ActivityTaskStatus,
  DeadLetterRecord,
  ExecutionQuery,
} from '../../core/types';

export class InMemoryStorage implements Storage {
  private executions = new Map<string, WorkflowExecution>();
  private uniqueKeys = new Map<string, string>(); // key -> runId
  private tasks = new Map<string, ActivityTask>();
  private deadLetters = new Map<string, DeadLetterRecord>();
  private subscribers: Set<(change: StorageChange) => void> = new Set();
  private transactionDepth = 0;

  private makeUniqueKeyId(workflowName: string, key: string): string {
    return `${workflowName}:${key}`;
  }

  private notifySubscribers(change: StorageChange): void {
    for (const callback of this.subscribers) {
      try {
        callback(change);
      } catch {
        // Ignore subscriber errors
      }
    }
  }

  // ============================================================================
  // Workflow Executions
  // ============================================================================

  async saveExecution(execution: WorkflowExecution): Promise<void> {
    const isNew = !this.executions.has(execution.runId);
    this.executions.set(execution.runId, { ...execution });
    this.notifySubscribers({
      type: 'execution',
      operation: isNew ? 'create' : 'update',
      id: execution.runId,
    });
  }

  async getExecution(runId: string): Promise<WorkflowExecution | null> {
    const execution = this.executions.get(runId);
    return execution ? { ...execution } : null;
  }

  async getExecutionsByStatus(status: WorkflowExecutionStatus): Promise<WorkflowExecution[]> {
    const results: WorkflowExecution[] = [];
    for (const execution of this.executions.values()) {
      if (execution.status === status) {
        results.push({ ...execution });
      }
    }
    return results;
  }

  async getExecutions(query: ExecutionQuery): Promise<WorkflowExecution[]> {
    const statuses = query.status === undefined ? null : ([] as WorkflowExecutionStatus[]).concat(query.status);
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    const results: WorkflowExecution[] = [];
    for (const execution of this.executions.values()) {
      if (statuses && !statuses.includes(execution.status)) continue;
      if (query.workflowName && execution.workflowName !== query.workflowName) continue;
      results.push({ ...execution });
    }

    // Newest first
    results.sort((a, b) => b.createdAt - a.createdAt);
    return results.slice(offset, offset + limit);
  }

  async deleteExecution(runId: string): Promise<void> {
    if (this.executions.delete(runId)) {
      this.notifySubscribers({
        type: 'execution',
        operation: 'delete',
        id: runId,
      });
    }
  }

  // ============================================================================
  // Uniqueness
  // ============================================================================

  async setUniqueKey(workflowName: string, key: string, runId: string): Promise<boolean> {
    const uniqueKeyId = this.makeUniqueKeyId(workflowName, key);
    const existing = this.uniqueKeys.get(uniqueKeyId);

    if (existing) {
      // Check if the existing execution is still running
      const execution = await this.getExecution(existing);
      if (execution && execution.status === 'running') {
        return false; // Constraint violation
      }
      // Old execution is done, we can reuse the key
    }

    this.uniqueKeys.set(uniqueKeyId, runId);
    return true;
  }

  async getUniqueKey(workflowName: string, key: string): Promise<string | null> {
    const uniqueKeyId = this.makeUniqueKeyId(workflowName, key);
    return this.uniqueKeys.get(uniqueKeyId) ?? null;
  }

  async deleteUniqueKey(workflowName: string, key: string): Promise<void> {
    const uniqueKeyId = this.makeUniqueKeyId(workflowName, key);
    this.uniqueKeys.delete(uniqueKeyId);
  }

  // ============================================================================
  // Activity Tasks
  // ============================================================================

  async saveActivityTask(task: ActivityTask): Promise<void> {
    const isNew = !this.tasks.has(task.taskId);
    this.tasks.set(task.taskId, { ...task });
    this.notifySubscribers({
      type: 'task',
      operation: isNew ? 'create' : 'update',
      id: task.taskId,
    });
  }

  async getActivityTask(taskId: string): Promise<ActivityTask | null> {
    const task = this.tasks.get(taskId);
    return task ? { ...task } : null;
  }

  async getActivityTasksForExecution(runId: string): Promise<ActivityTask[]> {
    const results: ActivityTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.runId === runId) {
        results.push({ ...task });
      }
    }
    return results;
  }

  async getActivityTasksByStatus(status: ActivityTaskStatus): Promise<ActivityTask[]> {
    const results: ActivityTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.status === status) {
        results.push({ ...task });
      }
    }
    return results;
  }

  async deleteActivityTask(taskId: string): Promise<void> {
    if (this.tasks.delete(taskId)) {
      this.notifySubscribers({
        type: 'task',
        operation: 'delete',
        id: taskId,
      });
    }
  }

  async deleteActivityTasksForExecution(runId: string): Promise<void> {
    const toDelete: string[] = [];
    for (const task of this.tasks.values()) {
      if (task.runId === runId) {
        toDelete.push(task.taskId);
      }
    }
    for (const taskId of toDelete) {
      await this.deleteActivityTask(taskId);
    }
  }

  // ============================================================================
  // Atomicity
  // ============================================================================

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // Nested calls join the outer transaction.
    if (this.transactionDepth > 0) {
      return await fn();
    }

    // Records are replaced, never mutated in place, so shallow map
    // snapshots are enough to restore pre-transaction state.
    const snapshot = {
      executions: new Map(this.executions),
      uniqueKeys: new Map(this.uniqueKeys),
      tasks: new Map(this.tasks),
      deadLetters: new Map(this.deadLetters),
    };

    this.transactionDepth++;
    try {
      return await fn();
    } catch (error) {
      this.executions = snapshot.executions;
      this.uniqueKeys = snapshot.uniqueKeys;
      this.tasks = snapshot.tasks;
      this.deadLetters = snapshot.deadLetters;
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }

  // ============================================================================
  // Queue Operations
  // ============================================================================

  async getPendingActivityTasks(options?: { limit?: number; now?: number }): Promise<ActivityTask[]> {
    const now = options?.now ?? Date.now();
    const limit = options?.limit ?? 100;

    const pending: ActivityTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.status !== 'pending') continue;
      // Respect scheduledFor (backoff delay)
      if (task.scheduledFor && task.scheduledFor > now) continue;
      pending.push({ ...task });
    }

    // Sort by priority (higher first), then by createdAt (older first)
    pending.sort((a, b) => {
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }
      return a.createdAt - b.createdAt;
    });

    return pending.slice(0, limit);
  }

  async claimActivityTask(
    taskId: string,
    now: number,
    lease?: { ownerId: string; leaseDurationMs: number }
  ): Promise<ActivityTask | null> {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'pending') return null;

    // Check scheduledFor
    if (task.scheduledFor && task.scheduledFor > now) return null;

    const claimed: ActivityTask = {
      ...task,
      status: 'active',
      startedAt: now,
      attempts: task.attempts + 1,
      ownerId: lease?.ownerId,
      leaseExpiresAt: lease ? now + lease.leaseDurationMs : undefined,
    };
    this.tasks.set(taskId, claimed);
    this.notifySubscribers({
      type: 'task',
      operation: 'update',
      id: taskId,
    });

    return { ...claimed };
  }

  async renewLease(taskId: string, ownerId: string, leaseExpiresAt: number): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'active' || task.ownerId !== ownerId) {
      return false;
    }
    this.tasks.set(taskId, { ...task, leaseExpiresAt });
    return true;
  }

  // ============================================================================
  // Dead Letter Queue
  // ============================================================================

  async saveDeadLetter(record: DeadLetterRecord): Promise<void> {
    const isNew = !this.deadLetters.has(record.id);
    this.deadLetters.set(record.id, { ...record });
    this.notifySubscribers({
      type: 'deadletter',
      operation: isNew ? 'create' : 'update',
      id: record.id,
    });
  }

  async getDeadLetters(): Promise<DeadLetterRecord[]> {
    return Array.from(this.deadLetters.values()).map(r => ({ ...r }));
  }

  async getUnacknowledgedDeadLetters(): Promise<DeadLetterRecord[]> {
    const results: DeadLetterRecord[] = [];
    for (const record of this.deadLetters.values()) {
      if (!record.acknowledged) {
        results.push({ ...record });
      }
    }
    return results;
  }

  async acknowledgeDeadLetter(id: string): Promise<void> {
    const record = this.deadLetters.get(id);
    if (record) {
      record.acknowledged = true;
      this.deadLetters.set(id, record);
      this.notifySubscribers({
        type: 'deadletter',
        operation: 'update',
        id,
      });
    }
  }

  async deleteDeadLetter(id: string): Promise<void> {
    if (this.deadLetters.delete(id)) {
      this.notifySubscribers({
        type: 'deadletter',
        operation: 'delete',
        id,
      });
    }
  }

  // ============================================================================
  // Maintenance
  // ============================================================================

  async purgeExecutions(options: {
    olderThanMs: number;
    statuses: WorkflowExecutionStatus[];
    now: number;
  }): Promise<number> {
    const cutoff = options.now - options.olderThanMs;
    const toDelete: string[] = [];

    for (const execution of this.executions.values()) {
      if (!options.statuses.includes(execution.status)) continue;
      const relevantTime = execution.completedAt ?? execution.updatedAt;
      if (relevantTime < cutoff) {
        toDelete.push(execution.runId);
      }
    }

    for (const runId of toDelete) {
      // Also delete associated tasks
      await this.deleteActivityTasksForExecution(runId);
      await this.deleteExecution(runId);
    }

    return toDelete.length;
  }

  async purgeDeadLetters(options: {
    olderThanMs: number;
    acknowledgedOnly?: boolean;
    now: number;
  }): Promise<number> {
    const cutoff = options.now - options.olderThanMs;
    const toDelete: string[] = [];

    for (const record of this.deadLetters.values()) {
      if (options.acknowledgedOnly && !record.acknowledged) continue;
      if (record.failedAt < cutoff) {
        toDelete.push(record.id);
      }
    }

    for (const id of toDelete) {
      await this.deleteDeadLetter(id);
    }

    return toDelete.length;
  }

  // ============================================================================
  // Reactivity
  // ============================================================================

  subscribe(callback: (change: StorageChange) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  // ============================================================================
  // Test Helpers
  // ============================================================================

  /**
   * Clear all data (for testing).
   */
  clear(): void {
    this.executions.clear();
    this.uniqueKeys.clear();
    this.tasks.clear();
    this.deadLetters.clear();
  }

  /**
   * Get counts for debugging.
   */
  getCounts(): { executions: number; tasks: number; deadLetters: number; uniqueKeys: number } {
    return {
      executions: this.executions.size,
      tasks: this.tasks.size,
      deadLetters: this.deadLetters.size,
      uniqueKeys: this.uniqueKeys.size,
    };
  }
}
