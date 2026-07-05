/**
 * SQLite-based storage adapter for the workflow engine.
 * Works with expo-sqlite or any compatible SQLite driver.
 */

import {
  Storage,
  StorageChange,
  WorkflowExecution,
  WorkflowExecutionStatus,
  ActivityTask,
  ActivityTaskStatus,
  DeadLetterRecord,
} from '../../core/types';
import { SQLiteDriver, SQLiteRow } from './internal/SQLiteDriver';
import { getSchemaStatements, SCHEMA_VERSION } from './internal/schema';

/**
 * SQLite-based storage adapter.
 */
export class SQLiteStorage implements Storage {
  private driver: SQLiteDriver;
  private subscribers: Set<(change: StorageChange) => void> = new Set();
  private initialized = false;

  constructor(driver: SQLiteDriver) {
    this.driver = driver;
  }

  /**
   * Initialize the database schema.
   * Must be called before using the storage.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const statements = getSchemaStatements();
    for (const stmt of statements) {
      await this.driver.execute(stmt);
    }

    // Store schema version (for future migrations)
    await this.driver.execute(
      `CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT);`
    );
    await this.driver.execute(
      `INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?);`,
      [String(SCHEMA_VERSION)]
    );

    this.initialized = true;
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
  // Row Mapping Helpers
  // ============================================================================

  private rowToExecution(row: SQLiteRow): WorkflowExecution {
    return {
      runId: row['run_id'] as string,
      workflowName: row['workflow_name'] as string,
      uniqueKey: row['unique_key'] != null ? String(row['unique_key'] as string | number) : undefined,
      currentActivityIndex: row['current_activity_index'] as number,
      currentActivityName: row['current_activity_name'] as string,
      status: row['status'] as WorkflowExecutionStatus,
      input: JSON.parse(row['input'] as string),
      state: JSON.parse(row['state'] as string),
      createdAt: row['created_at'] as number,
      updatedAt: row['updated_at'] as number,
      completedAt: row['completed_at'] != null ? Number(row['completed_at']) : undefined,
      error: row['error'] != null ? String(row['error'] as string) : undefined,
      failedActivityName: row['failed_activity_name'] != null ? String(row['failed_activity_name'] as string) : undefined,
    };
  }

  private rowToTask(row: SQLiteRow): ActivityTask {
    return {
      taskId: row['task_id'] as string,
      runId: row['run_id'] as string,
      activityName: row['activity_name'] as string,
      status: row['status'] as ActivityTaskStatus,
      priority: row['priority'] as number,
      attempts: row['attempts'] as number,
      maxAttempts: row['max_attempts'] as number,
      timeout: row['timeout'] as number,
      input: JSON.parse(row['input'] as string),
      result: row['result'] ? JSON.parse(row['result'] as string) : undefined,
      createdAt: row['created_at'] as number,
      scheduledFor: row['scheduled_for'] != null ? Number(row['scheduled_for']) : undefined,
      startedAt: row['started_at'] != null ? Number(row['started_at']) : undefined,
      lastAttemptAt: row['last_attempt_at'] != null ? Number(row['last_attempt_at']) : undefined,
      completedAt: row['completed_at'] != null ? Number(row['completed_at']) : undefined,
      error: row['error'] != null ? String(row['error'] as string) : undefined,
      errorStack: row['error_stack'] != null ? String(row['error_stack'] as string) : undefined,
    };
  }

  private rowToDeadLetter(row: SQLiteRow): DeadLetterRecord {
    return {
      id: row['id'] as string,
      runId: row['run_id'] as string,
      taskId: row['task_id'] as string,
      activityName: row['activity_name'] as string,
      workflowName: row['workflow_name'] as string,
      input: JSON.parse(row['input'] as string),
      error: row['error'] as string,
      errorStack: row['error_stack'] != null ? String(row['error_stack'] as string) : undefined,
      attempts: row['attempts'] as number,
      failedAt: row['failed_at'] as number,
      acknowledged: (row['acknowledged'] as number) === 1,
    };
  }

  // ============================================================================
  // Workflow Executions
  // ============================================================================

  async saveExecution(execution: WorkflowExecution): Promise<void> {
    const existing = await this.getExecution(execution.runId);
    const isNew = !existing;

    // UPSERT, not INSERT OR REPLACE: REPLACE deletes the existing row,
    // which cascades away every activity task for the run when
    // foreign_keys is on (better-sqlite3 enables it by default).
    await this.driver.execute(
      `INSERT INTO executions (
        run_id, workflow_name, unique_key, current_activity_index, current_activity_name,
        status, input, state, created_at, updated_at, completed_at, error, failed_activity_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        workflow_name = excluded.workflow_name,
        unique_key = excluded.unique_key,
        current_activity_index = excluded.current_activity_index,
        current_activity_name = excluded.current_activity_name,
        status = excluded.status,
        input = excluded.input,
        state = excluded.state,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at,
        error = excluded.error,
        failed_activity_name = excluded.failed_activity_name`,
      [
        execution.runId,
        execution.workflowName,
        execution.uniqueKey ?? null,
        execution.currentActivityIndex,
        execution.currentActivityName,
        execution.status,
        JSON.stringify(execution.input),
        JSON.stringify(execution.state),
        execution.createdAt,
        execution.updatedAt,
        execution.completedAt ?? null,
        execution.error ?? null,
        execution.failedActivityName ?? null,
      ]
    );

    this.notifySubscribers({
      type: 'execution',
      operation: isNew ? 'create' : 'update',
      id: execution.runId,
    });
  }

  async getExecution(runId: string): Promise<WorkflowExecution | null> {
    const rows = await this.driver.query(
      `SELECT * FROM executions WHERE run_id = ?`,
      [runId]
    );

    if (rows.length === 0) return null;
    return this.rowToExecution(rows[0]!);
  }

  async getExecutionsByStatus(status: WorkflowExecutionStatus): Promise<WorkflowExecution[]> {
    const rows = await this.driver.query(
      `SELECT * FROM executions WHERE status = ?`,
      [status]
    );

    return rows.map(row => this.rowToExecution(row));
  }

  async deleteExecution(runId: string): Promise<void> {
    await this.driver.execute(
      `DELETE FROM executions WHERE run_id = ?`,
      [runId]
    );

    this.notifySubscribers({
      type: 'execution',
      operation: 'delete',
      id: runId,
    });
  }

  // ============================================================================
  // Uniqueness
  // ============================================================================

  async setUniqueKey(workflowName: string, key: string, _runId: string): Promise<boolean> {
    // Check if there's an existing running execution with this unique key
    const existing = await this.driver.query(
      `SELECT run_id FROM executions
       WHERE workflow_name = ? AND unique_key = ? AND status = 'running'`,
      [workflowName, key]
    );

    if (existing.length > 0) {
      return false; // Constraint violation
    }

    // The unique constraint on the table will handle the insert/update
    return true;
  }

  async getUniqueKey(workflowName: string, key: string): Promise<string | null> {
    const rows = await this.driver.query(
      `SELECT run_id FROM executions
       WHERE workflow_name = ? AND unique_key = ? AND status = 'running'`,
      [workflowName, key]
    );

    if (rows.length === 0) return null;
    return rows[0]!['run_id'] as string;
  }

  async deleteUniqueKey(_workflowName: string, _key: string): Promise<void> {
    // Uniqueness is managed by the execution's unique_key column
    // When an execution completes/fails, it's no longer "running" so the constraint is released
    // No explicit deletion needed
  }

  // ============================================================================
  // Activity Tasks
  // ============================================================================

  async saveActivityTask(task: ActivityTask): Promise<void> {
    const existing = await this.getActivityTask(task.taskId);
    const isNew = !existing;

    await this.driver.execute(
      `INSERT OR REPLACE INTO activity_tasks (
        task_id, run_id, activity_name, status, priority, attempts, max_attempts, timeout,
        input, result, created_at, scheduled_for, started_at, last_attempt_at, completed_at, error, error_stack
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        task.taskId,
        task.runId,
        task.activityName,
        task.status,
        task.priority,
        task.attempts,
        task.maxAttempts,
        task.timeout,
        JSON.stringify(task.input),
        task.result ? JSON.stringify(task.result) : null,
        task.createdAt,
        task.scheduledFor ?? null,
        task.startedAt ?? null,
        task.lastAttemptAt ?? null,
        task.completedAt ?? null,
        task.error ?? null,
        task.errorStack ?? null,
      ]
    );

    this.notifySubscribers({
      type: 'task',
      operation: isNew ? 'create' : 'update',
      id: task.taskId,
    });
  }

  async getActivityTask(taskId: string): Promise<ActivityTask | null> {
    const rows = await this.driver.query(
      `SELECT * FROM activity_tasks WHERE task_id = ?`,
      [taskId]
    );

    if (rows.length === 0) return null;
    return this.rowToTask(rows[0]!);
  }

  async getActivityTasksForExecution(runId: string): Promise<ActivityTask[]> {
    const rows = await this.driver.query(
      `SELECT * FROM activity_tasks WHERE run_id = ?`,
      [runId]
    );

    return rows.map(row => this.rowToTask(row));
  }

  async getActivityTasksByStatus(status: ActivityTaskStatus): Promise<ActivityTask[]> {
    const rows = await this.driver.query(
      `SELECT * FROM activity_tasks WHERE status = ?`,
      [status]
    );

    return rows.map(row => this.rowToTask(row));
  }

  async deleteActivityTask(taskId: string): Promise<void> {
    await this.driver.execute(
      `DELETE FROM activity_tasks WHERE task_id = ?`,
      [taskId]
    );

    this.notifySubscribers({
      type: 'task',
      operation: 'delete',
      id: taskId,
    });
  }

  async deleteActivityTasksForExecution(runId: string): Promise<void> {
    const tasks = await this.getActivityTasksForExecution(runId);

    await this.driver.execute(
      `DELETE FROM activity_tasks WHERE run_id = ?`,
      [runId]
    );

    for (const task of tasks) {
      this.notifySubscribers({
        type: 'task',
        operation: 'delete',
        id: task.taskId,
      });
    }
  }

  // ============================================================================
  // Atomicity
  // ============================================================================

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return await this.driver.transaction(fn);
  }

  // ============================================================================
  // Queue Operations
  // ============================================================================

  async getPendingActivityTasks(options?: { limit?: number; now?: number }): Promise<ActivityTask[]> {
    const now = options?.now ?? Date.now();
    const limit = options?.limit ?? 100;

    const rows = await this.driver.query(
      `SELECT * FROM activity_tasks
       WHERE status = 'pending'
         AND (scheduled_for IS NULL OR scheduled_for <= ?)
       ORDER BY priority DESC, created_at ASC
       LIMIT ?`,
      [now, limit]
    );

    return rows.map(row => this.rowToTask(row));
  }

  async claimActivityTask(taskId: string, now: number): Promise<ActivityTask | null> {
    return await this.driver.transaction(async () => {
      // Compare-and-set: the status guard in the WHERE clause makes the
      // claim atomic — a competing engine's claim shows up as changes === 0.
      const result = await this.driver.execute(
        `UPDATE activity_tasks
         SET status = 'active', started_at = ?, attempts = attempts + 1
         WHERE task_id = ? AND status = 'pending'
           AND (scheduled_for IS NULL OR scheduled_for <= ?)`,
        [now, taskId, now]
      );

      if ((result.changes ?? 0) === 0) {
        return null; // not claimable, or another engine won the race
      }

      const rows = await this.driver.query(
        `SELECT * FROM activity_tasks WHERE task_id = ?`,
        [taskId]
      );
      const claimed = this.rowToTask(rows[0]!);

      this.notifySubscribers({
        type: 'task',
        operation: 'update',
        id: taskId,
      });

      return claimed;
    });
  }

  // ============================================================================
  // Dead Letter Queue
  // ============================================================================

  async saveDeadLetter(record: DeadLetterRecord): Promise<void> {
    const existing = await this.driver.query(
      `SELECT id FROM dead_letters WHERE id = ?`,
      [record.id]
    );
    const isNew = existing.length === 0;

    await this.driver.execute(
      `INSERT OR REPLACE INTO dead_letters (
        id, run_id, task_id, activity_name, workflow_name, input, error, error_stack, attempts, failed_at, acknowledged
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.runId,
        record.taskId,
        record.activityName,
        record.workflowName,
        JSON.stringify(record.input),
        record.error,
        record.errorStack ?? null,
        record.attempts,
        record.failedAt,
        record.acknowledged ? 1 : 0,
      ]
    );

    this.notifySubscribers({
      type: 'deadletter',
      operation: isNew ? 'create' : 'update',
      id: record.id,
    });
  }

  async getDeadLetters(): Promise<DeadLetterRecord[]> {
    const rows = await this.driver.query(
      `SELECT * FROM dead_letters ORDER BY failed_at DESC`
    );

    return rows.map(row => this.rowToDeadLetter(row));
  }

  async getUnacknowledgedDeadLetters(): Promise<DeadLetterRecord[]> {
    const rows = await this.driver.query(
      `SELECT * FROM dead_letters WHERE acknowledged = 0 ORDER BY failed_at DESC`
    );

    return rows.map(row => this.rowToDeadLetter(row));
  }

  async acknowledgeDeadLetter(id: string): Promise<void> {
    await this.driver.execute(
      `UPDATE dead_letters SET acknowledged = 1 WHERE id = ?`,
      [id]
    );

    this.notifySubscribers({
      type: 'deadletter',
      operation: 'update',
      id,
    });
  }

  async deleteDeadLetter(id: string): Promise<void> {
    await this.driver.execute(
      `DELETE FROM dead_letters WHERE id = ?`,
      [id]
    );

    this.notifySubscribers({
      type: 'deadletter',
      operation: 'delete',
      id,
    });
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
    const placeholders = options.statuses.map(() => '?').join(',');

    // First get the executions that will be deleted (for notifications)
    const toDelete = await this.driver.query(
      `SELECT run_id FROM executions
       WHERE status IN (${placeholders})
         AND COALESCE(completed_at, updated_at) < ?`,
      [...options.statuses, cutoff]
    );

    if (toDelete.length === 0) return 0;

    // Delete associated tasks first (foreign key)
    const runIds = toDelete.map(row => row['run_id']);
    const runIdPlaceholders = runIds.map(() => '?').join(',');

    await this.driver.execute(
      `DELETE FROM activity_tasks WHERE run_id IN (${runIdPlaceholders})`,
      runIds
    );

    // Delete executions
    const result = await this.driver.execute(
      `DELETE FROM executions
       WHERE status IN (${placeholders})
         AND COALESCE(completed_at, updated_at) < ?`,
      [...options.statuses, cutoff]
    );

    // Notify subscribers
    for (const row of toDelete) {
      this.notifySubscribers({
        type: 'execution',
        operation: 'delete',
        id: row['run_id'] as string,
      });
    }

    return result.changes ?? toDelete.length;
  }

  async purgeDeadLetters(options: {
    olderThanMs: number;
    acknowledgedOnly?: boolean;
    now: number;
  }): Promise<number> {
    const cutoff = options.now - options.olderThanMs;

    // Get dead letters to delete (for notifications)
    let toDelete: SQLiteRow[];
    if (options.acknowledgedOnly) {
      toDelete = await this.driver.query(
        `SELECT id FROM dead_letters WHERE failed_at < ? AND acknowledged = 1`,
        [cutoff]
      );
    } else {
      toDelete = await this.driver.query(
        `SELECT id FROM dead_letters WHERE failed_at < ?`,
        [cutoff]
      );
    }

    if (toDelete.length === 0) return 0;

    // Delete
    let result: { changes?: number };
    if (options.acknowledgedOnly) {
      result = await this.driver.execute(
        `DELETE FROM dead_letters WHERE failed_at < ? AND acknowledged = 1`,
        [cutoff]
      );
    } else {
      result = await this.driver.execute(
        `DELETE FROM dead_letters WHERE failed_at < ?`,
        [cutoff]
      );
    }

    // Notify subscribers
    for (const row of toDelete) {
      this.notifySubscribers({
        type: 'deadletter',
        operation: 'delete',
        id: row['id'] as string,
      });
    }

    return result.changes ?? toDelete.length;
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
  // Utilities
  // ============================================================================

  /**
   * Close the database connection.
   */
  async close(): Promise<void> {
    await this.driver.close();
  }
}
