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
  TaskErrorHistoryEntry,
} from '../../core/types';
import { SQLiteDriver, SQLiteRow } from './internal/SQLiteDriver';
import { getSchemaStatements, MIGRATIONS, SCHEMA_VERSION } from './internal/schema';
import { generateId } from '../../core/utils';

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
   * Initialize the database schema, migrating older databases forward.
   * Must be called before using the storage.
   *
   * Versioning lives in PRAGMA user_version. A fresh database gets the
   * full current schema; an existing one is migrated one version at a
   * time, each migration + version bump in a single transaction, so a
   * crash mid-migration leaves the database at the previous version.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Connection pragmas, before any other statement:
    // - WAL allows a reader/writer pair across the foreground and
    //   background engine connections (no-op for in-memory databases).
    // - busy_timeout makes a locked database wait instead of throwing
    //   SQLITE_BUSY immediately.
    // - foreign_keys is OFF by default in expo-sqlite, which would leave
    //   the schema's ON DELETE CASCADE inert on-device.
    await this.driver.query('PRAGMA journal_mode = WAL');
    await this.driver.query('PRAGMA busy_timeout = 5000');
    await this.driver.execute('PRAGMA foreign_keys = ON');

    const storedVersion = await this.getUserVersion();
    const hasSchema = await this.hasExistingSchema();

    if (!hasSchema) {
      await this.driver.transaction(async () => {
        for (const stmt of getSchemaStatements()) {
          await this.driver.execute(stmt);
        }
        await this.setUserVersion(SCHEMA_VERSION);
      });
      this.initialized = true;
      return;
    }

    // Databases created before versioning report user_version 0.
    let currentVersion = storedVersion === 0 ? 1 : storedVersion;
    if (currentVersion > SCHEMA_VERSION) {
      throw new Error(
        `Database schema version ${currentVersion} is newer than this package supports (${SCHEMA_VERSION}). ` +
          'Refusing to open — upgrade the endura package.'
      );
    }

    for (const migration of MIGRATIONS) {
      if (migration.toVersion <= currentVersion) continue;
      await this.driver.transaction(async () => {
        for (const stmt of migration.statements) {
          await this.driver.execute(stmt);
        }
        await this.setUserVersion(migration.toVersion);
      });
      currentVersion = migration.toVersion;
    }

    this.initialized = true;
  }

  private async getUserVersion(): Promise<number> {
    const rows = await this.driver.query('PRAGMA user_version');
    return Number(rows[0]?.['user_version'] ?? 0);
  }

  private async setUserVersion(version: number): Promise<void> {
    // PRAGMA does not support bound parameters; version is a trusted
    // integer from our own migration table.
    await this.driver.execute(`PRAGMA user_version = ${Math.floor(version)}`);
  }

  private async hasExistingSchema(): Promise<boolean> {
    const rows = await this.driver.query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'executions'`
    );
    return rows.length > 0;
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

  /**
   * Parse a JSON payload column, degrading to an empty object on
   * corruption. Read paths must never throw on a single bad row (H10) —
   * one poison row would otherwise stall every poll forever. The
   * quarantine in getPendingActivityTasks provides the observable
   * signal; here we just keep reads alive.
   */
  private safeJsonParse(raw: unknown): Record<string, unknown> {
    if (raw == null) return {};
    try {
      return JSON.parse(raw as string) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private isParseable(raw: unknown): boolean {
    if (raw == null) return true;
    try {
      JSON.parse(raw as string);
      return true;
    } catch {
      return false;
    }
  }

  private rowToExecution(row: SQLiteRow): WorkflowExecution {
    return {
      runId: row['run_id'] as string,
      workflowName: row['workflow_name'] as string,
      workflowVersion: row['workflow_version'] != null ? String(row['workflow_version'] as string) : undefined,
      uniqueKey: row['unique_key'] != null ? String(row['unique_key'] as string | number) : undefined,
      currentActivityIndex: row['current_activity_index'] as number,
      currentActivityName: row['current_activity_name'] as string,
      status: row['status'] as WorkflowExecutionStatus,
      input: this.safeJsonParse(row['input']),
      state: this.safeJsonParse(row['state']),
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
      failures: row['failures'] != null ? Number(row['failures']) : 0,
      maxAttempts: row['max_attempts'] as number,
      timeout: row['timeout'] as number,
      input: this.safeJsonParse(row['input']),
      result: row['result'] ? this.safeJsonParse(row['result']) : undefined,
      createdAt: row['created_at'] as number,
      scheduledFor: row['scheduled_for'] != null ? Number(row['scheduled_for']) : undefined,
      startedAt: row['started_at'] != null ? Number(row['started_at']) : undefined,
      lastAttemptAt: row['last_attempt_at'] != null ? Number(row['last_attempt_at']) : undefined,
      completedAt: row['completed_at'] != null ? Number(row['completed_at']) : undefined,
      error: row['error'] != null ? String(row['error'] as string) : undefined,
      errorStack: row['error_stack'] != null ? String(row['error_stack'] as string) : undefined,
      errorHistory: this.parseErrorHistory(row['error_history']),
      ownerId: row['owner_id'] != null ? String(row['owner_id'] as string) : undefined,
      leaseExpiresAt: row['lease_expires_at'] != null ? Number(row['lease_expires_at']) : undefined,
    };
  }

  private parseErrorHistory(raw: unknown): TaskErrorHistoryEntry[] | undefined {
    if (raw == null) return undefined;
    try {
      const parsed = JSON.parse(raw as string) as unknown;
      return Array.isArray(parsed) ? (parsed as TaskErrorHistoryEntry[]) : undefined;
    } catch {
      return undefined;
    }
  }

  private rowToDeadLetter(row: SQLiteRow): DeadLetterRecord {
    return {
      id: row['id'] as string,
      runId: row['run_id'] as string,
      taskId: row['task_id'] as string,
      activityName: row['activity_name'] as string,
      workflowName: row['workflow_name'] as string,
      input: this.safeJsonParse(row['input']),
      error: row['error'] as string,
      errorStack: row['error_stack'] != null ? String(row['error_stack'] as string) : undefined,
      attempts: row['attempts'] as number,
      failedAt: row['failed_at'] as number,
      acknowledged: (row['acknowledged'] as number) === 1,
      nonRetryable: (row['non_retryable'] as number) === 1,
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
        run_id, workflow_name, workflow_version, unique_key, current_activity_index, current_activity_name,
        status, input, state, created_at, updated_at, completed_at, error, failed_activity_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        workflow_name = excluded.workflow_name,
        workflow_version = excluded.workflow_version,
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
        execution.workflowVersion ?? null,
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
    // Intentionally a no-op for SQLite: the unique index is scoped to
    // status='running', so the constraint releases automatically when the
    // execution leaves 'running'.
  }

  // ============================================================================
  // Activity Tasks
  // ============================================================================

  async saveActivityTask(task: ActivityTask): Promise<void> {
    const existing = await this.getActivityTask(task.taskId);
    const isNew = !existing;

    await this.driver.execute(
      `INSERT OR REPLACE INTO activity_tasks (
        task_id, run_id, activity_name, status, priority, attempts, failures, max_attempts, timeout,
        input, result, created_at, scheduled_for, started_at, last_attempt_at, completed_at, error, error_stack,
        error_history, owner_id, lease_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        task.taskId,
        task.runId,
        task.activityName,
        task.status,
        task.priority,
        task.attempts,
        task.failures ?? 0,
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
        task.errorHistory ? JSON.stringify(task.errorHistory) : null,
        task.ownerId ?? null,
        task.leaseExpiresAt ?? null,
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

    // Quarantine poison rows instead of throwing: one corrupt payload
    // must not stall the entire queue (H10).
    const tasks: ActivityTask[] = [];
    for (const row of rows) {
      if (!this.isParseable(row['input'])) {
        await this.quarantineCorruptTaskRow(row, now);
        continue;
      }
      tasks.push(this.rowToTask(row));
    }
    return tasks;
  }

  /**
   * Take a task with an unparseable payload out of the queue: mark it
   * failed and dead-letter it (nonRetryable — the payload is gone, so a
   * redrive could never succeed). Atomic so a crash can't leave a
   * failed task without its dead letter.
   */
  private async quarantineCorruptTaskRow(row: SQLiteRow, now: number): Promise<void> {
    const taskId = row['task_id'] as string;
    const runId = row['run_id'] as string;

    const executionRows = await this.driver.query(
      `SELECT workflow_name FROM executions WHERE run_id = ?`,
      [runId]
    );
    const workflowName = (executionRows[0]?.['workflow_name'] as string) ?? 'unknown';

    await this.transaction(async () => {
      await this.driver.execute(
        `UPDATE activity_tasks SET status = 'failed', error = ?, completed_at = ? WHERE task_id = ?`,
        ['Corrupt task payload quarantined (unparseable JSON)', now, taskId]
      );
      await this.saveDeadLetter({
        id: generateId(),
        runId,
        taskId,
        activityName: row['activity_name'] as string,
        workflowName,
        input: {},
        error: 'Corrupt task payload quarantined (unparseable JSON)',
        attempts: (row['attempts'] as number) ?? 0,
        failedAt: now,
        acknowledged: false,
        nonRetryable: true,
      });
    });

    this.notifySubscribers({ type: 'task', operation: 'update', id: taskId });
  }

  async claimActivityTask(
    taskId: string,
    now: number,
    lease?: { ownerId: string; leaseDurationMs: number }
  ): Promise<ActivityTask | null> {
    return await this.driver.transaction(async () => {
      // Compare-and-set: the status guard in the WHERE clause makes the
      // claim atomic — a competing engine's claim shows up as changes === 0.
      const result = await this.driver.execute(
        `UPDATE activity_tasks
         SET status = 'active', started_at = ?, attempts = attempts + 1,
             owner_id = ?, lease_expires_at = ?
         WHERE task_id = ? AND status = 'pending'
           AND (scheduled_for IS NULL OR scheduled_for <= ?)`,
        [now, lease?.ownerId ?? null, lease ? now + lease.leaseDurationMs : null, taskId, now]
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

  async renewLease(taskId: string, ownerId: string, leaseExpiresAt: number): Promise<boolean> {
    const result = await this.driver.execute(
      `UPDATE activity_tasks
       SET lease_expires_at = ?
       WHERE task_id = ? AND owner_id = ? AND status = 'active'`,
      [leaseExpiresAt, taskId, ownerId]
    );
    return (result.changes ?? 0) > 0;
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
        id, run_id, task_id, activity_name, workflow_name, input, error, error_stack, attempts, failed_at, acknowledged, non_retryable
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        record.nonRetryable ? 1 : 0,
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
