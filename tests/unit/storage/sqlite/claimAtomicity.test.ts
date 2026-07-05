/**
 * Claim atomicity (compare-and-set) tests for SQLiteStorage.
 *
 * claimActivityTask must be a true CAS: if another engine claims the task
 * between our read and our write, we must observe a lost race (null), not
 * silently stomp the competitor's claim and run the task twice.
 */

import { SQLiteStorage } from '../../../../src/storage/sqlite';
import { BetterSqlite3Driver } from '../../../../src/storage/sqlite/internal/BetterSqlite3Driver';
import { SQLiteDriver, SQLiteResult, SQLiteRow } from '../../../../src/storage/sqlite/internal/SQLiteDriver';
import { ActivityTask, WorkflowExecution } from '../../../../src/core/types';

/**
 * Wraps a real driver and lets a test inject work right before a matching
 * statement executes — simulating a second engine interleaving with ours.
 */
class InterceptingDriver implements SQLiteDriver {
  constructor(
    private inner: SQLiteDriver,
    private hooks: {
      beforeExecute?: (sql: string, params: unknown[]) => Promise<void>;
    } = {}
  ) {}

  async execute(sql: string, params: unknown[] = []): Promise<SQLiteResult> {
    await this.hooks.beforeExecute?.(sql, params);
    return this.inner.execute(sql, params);
  }

  async query(sql: string, params: unknown[] = []): Promise<SQLiteRow[]> {
    return this.inner.query(sql, params);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.inner.transaction(fn);
  }

  async close(): Promise<void> {
    return this.inner.close();
  }
}

const execution: WorkflowExecution = {
  runId: 'run-1',
  workflowName: 'testWorkflow',
  currentActivityIndex: 0,
  currentActivityName: 'activity1',
  status: 'running',
  input: {},
  state: {},
  createdAt: 1000000,
  updatedAt: 1000000,
};

const task: ActivityTask = {
  taskId: 'task-1',
  runId: 'run-1',
  activityName: 'activity1',
  status: 'pending',
  priority: 0,
  attempts: 0,
  maxAttempts: 3,
  timeout: 25000,
  input: {},
  createdAt: 1000000,
};

describe('claimActivityTask atomicity', () => {
  it('loses the race when a competitor claims between read and write', async () => {
    const raw = await BetterSqlite3Driver.create(':memory:');

    let injected = false;
    const driver = new InterceptingDriver(raw, {
      beforeExecute: async (sql) => {
        // Right before OUR claim write runs, a "second engine" claims the
        // task directly on the underlying connection.
        if (!injected && sql.includes(`SET status = 'active'`)) {
          injected = true;
          await raw.execute(
            `UPDATE activity_tasks
             SET status = 'active', started_at = 999, attempts = attempts + 1
             WHERE task_id = ? AND status = 'pending'`,
            ['task-1']
          );
        }
      },
    });

    const storage = new SQLiteStorage(driver);
    await storage.initialize();
    await storage.saveExecution(execution);
    await storage.saveActivityTask(task);

    const claimed = await storage.claimActivityTask('task-1', 2000000);

    // Unguarded UPDATE would stomp the competitor and report success here.
    expect(claimed).toBeNull();

    const row = await storage.getActivityTask('task-1');
    expect(row!.status).toBe('active');
    expect(row!.attempts).toBe(1); // exactly one claim counted
    expect(row!.startedAt).toBe(999); // the competitor's claim, untouched

    await storage.close();
  });

  it('claims normally when there is no competition', async () => {
    const raw = await BetterSqlite3Driver.create(':memory:');
    const storage = new SQLiteStorage(raw);
    await storage.initialize();
    await storage.saveExecution(execution);
    await storage.saveActivityTask(task);

    const claimed = await storage.claimActivityTask('task-1', 2000000);
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe('active');
    expect(claimed!.attempts).toBe(1);
    expect(claimed!.startedAt).toBe(2000000);

    await storage.close();
  });

  it('does not claim a task scheduled for the future', async () => {
    const raw = await BetterSqlite3Driver.create(':memory:');
    const storage = new SQLiteStorage(raw);
    await storage.initialize();
    await storage.saveExecution(execution);
    await storage.saveActivityTask({ ...task, scheduledFor: 5000000 });

    const claimed = await storage.claimActivityTask('task-1', 2000000);
    expect(claimed).toBeNull();

    const row = await storage.getActivityTask('task-1');
    expect(row!.status).toBe('pending');
    expect(row!.attempts).toBe(0);

    await storage.close();
  });
});
