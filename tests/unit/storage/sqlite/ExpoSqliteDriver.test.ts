/**
 * Contract tests for ExpoSqliteDriver against the REAL expo-sqlite API shape.
 *
 * The double below mirrors expo-sqlite v14+ exactly — most importantly,
 * `withTransactionAsync(task: () => Promise<void>): Promise<void>` DISCARDS
 * the callback's return value, just like the published expo-sqlite typings
 * and implementation. Any driver code that relies on withTransactionAsync
 * returning the callback's value will get `undefined` on a real device.
 *
 * Backed by better-sqlite3 so all SQL actually executes.
 */

import Database from 'better-sqlite3';
import type { Database as BetterSqlite3Db } from 'better-sqlite3';
import { SQLiteStorage } from '../../../../src/storage/sqlite';
import { ExpoSqliteDriver } from '../../../../src/storage/sqlite/internal/ExpoSqliteDriver';
import { ActivityTask, WorkflowExecution } from '../../../../src/core/types';

/**
 * A faithful double of expo-sqlite's SQLiteDatabase (v14+ async API),
 * backed by better-sqlite3 so SQL really runs.
 */
class FakeExpoSQLiteDatabase {
  private db: BetterSqlite3Db;
  private inTransaction = false;

  constructor(db: BetterSqlite3Db) {
    this.db = db;
  }

  async execAsync(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async runAsync(
    sql: string,
    ...params: unknown[]
  ): Promise<{ changes: number; lastInsertRowId: number }> {
    const result = this.db.prepare(sql).run(...params);
    return { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) };
  }

  async getAllAsync<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }

  /**
   * Mirrors expo-sqlite exactly: the task's return value is DISCARDED and
   * the method resolves to void. Rolls back if the task throws.
   */
  async withTransactionAsync(task: () => Promise<void>): Promise<void> {
    if (this.inTransaction) {
      throw new Error('cannot start a transaction within a transaction');
    }
    this.inTransaction = true;
    this.db.exec('BEGIN');
    try {
      await task();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  async closeAsync(): Promise<void> {
    this.db.close();
  }
}

const createExecution = (overrides: Partial<WorkflowExecution> = {}): WorkflowExecution => ({
  runId: 'run-1',
  workflowName: 'testWorkflow',
  currentActivityIndex: 0,
  currentActivityName: 'activity1',
  status: 'running',
  input: { foo: 'bar' },
  state: {},
  createdAt: 1000000,
  updatedAt: 1000000,
  ...overrides,
});

const createTask = (overrides: Partial<ActivityTask> = {}): ActivityTask => ({
  taskId: 'task-1',
  runId: 'run-1',
  activityName: 'activity1',
  status: 'pending',
  priority: 0,
  attempts: 0,
  maxAttempts: 3,
  timeout: 25000,
  input: { foo: 'bar' },
  createdAt: 1000000,
  ...overrides,
});

describe('ExpoSqliteDriver (expo-sqlite API contract)', () => {
  let fakeDb: FakeExpoSQLiteDatabase;
  let driver: ExpoSqliteDriver;

  beforeEach(() => {
    fakeDb = new FakeExpoSQLiteDatabase(new Database(':memory:'));
    driver = new ExpoSqliteDriver(fakeDb);
  });

  afterEach(async () => {
    await driver.close();
  });

  describe('transaction()', () => {
    it('returns the callback result even though withTransactionAsync resolves void', async () => {
      const result = await driver.transaction(async () => 42);
      expect(result).toBe(42);
    });

    it('returns object results from the callback', async () => {
      const result = await driver.transaction(async () => ({ claimed: true }));
      expect(result).toEqual({ claimed: true });
    });

    it('returns null results from the callback (distinct from undefined)', async () => {
      const result = await driver.transaction(async () => null);
      expect(result).toBeNull();
    });

    it('commits writes made inside the transaction', async () => {
      await driver.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);');
      await driver.transaction(async () => {
        await driver.execute('INSERT INTO t (v) VALUES (?)', ['hello']);
      });
      const rows = await driver.query('SELECT v FROM t');
      expect(rows).toEqual([{ v: 'hello' }]);
    });

    it('rolls back writes and rethrows when the callback throws', async () => {
      await driver.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);');
      await expect(
        driver.transaction(async () => {
          await driver.execute('INSERT INTO t (v) VALUES (?)', ['doomed']);
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');
      const rows = await driver.query('SELECT v FROM t');
      expect(rows).toEqual([]);
    });
  });

  describe('SQLiteStorage over ExpoSqliteDriver', () => {
    let storage: SQLiteStorage;

    beforeEach(async () => {
      storage = new SQLiteStorage(driver);
      await storage.initialize();
    });

    it('initializes the schema through the expo API', async () => {
      const executions = await storage.getExecutionsByStatus('running');
      expect(executions).toEqual([]);
      const tasks = await storage.getActivityTasksByStatus('pending');
      expect(tasks).toEqual([]);
    });

    it('claimActivityTask returns the claimed task, not undefined', async () => {
      await storage.saveExecution(createExecution());
      await storage.saveActivityTask(createTask());

      const claimed = await storage.claimActivityTask('task-1', 2000000);

      // Against the broken driver this is `undefined`: the engine treats it
      // as "claim lost" while the row is already flipped to 'active', so no
      // task can ever execute on-device.
      expect(claimed).not.toBeUndefined();
      expect(claimed).not.toBeNull();
      expect(claimed!.taskId).toBe('task-1');
      expect(claimed!.status).toBe('active');
      expect(claimed!.attempts).toBe(1);
      expect(claimed!.startedAt).toBe(2000000);
    });

    it('claimActivityTask leaves the row claimable state consistent', async () => {
      await storage.saveExecution(createExecution());
      await storage.saveActivityTask(createTask());

      const claimed = await storage.claimActivityTask('task-1', 2000000);
      expect(claimed).toBeTruthy();

      // Claiming again must return null (already active) — and must NOT
      // return undefined-due-to-void-transaction.
      const second = await storage.claimActivityTask('task-1', 2000001);
      expect(second).toBeNull();

      const row = await storage.getActivityTask('task-1');
      expect(row!.status).toBe('active');
      expect(row!.attempts).toBe(1);
    });
  });
});
