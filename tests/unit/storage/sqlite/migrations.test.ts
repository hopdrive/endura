/**
 * Schema migration tests (review issue C8).
 *
 * The old initialize() wrote a version into a schema_meta table and never
 * read it back — there was no migration system at all. These tests open a
 * POPULATED database created with the original v1 schema and prove the
 * runner (PRAGMA user_version, one transaction per migration) carries the
 * data forward intact.
 */

import { SQLiteStorage } from '../../../../src/storage/sqlite';
import { BetterSqlite3Driver } from '../../../../src/storage/sqlite/internal/BetterSqlite3Driver';
import { SCHEMA_VERSION } from '../../../../src/storage/sqlite/internal/schema';
import { SQLiteDriver, SQLiteResult, SQLiteRow } from '../../../../src/storage/sqlite/internal/SQLiteDriver';

/**
 * The ORIGINAL v1 schema, verbatim from the reviewed code (pre-leasing,
 * pre-failures, status-blind unique index). Do not update this when the
 * live schema changes — that is the point of the fixture.
 */
const V1_SCHEMA = [
  `CREATE TABLE executions (
    run_id TEXT PRIMARY KEY NOT NULL,
    workflow_name TEXT NOT NULL,
    unique_key TEXT,
    current_activity_index INTEGER NOT NULL DEFAULT 0,
    current_activity_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
    input TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    error TEXT,
    failed_activity_name TEXT
  );`,
  `CREATE INDEX idx_executions_status ON executions(status);`,
  `CREATE UNIQUE INDEX idx_executions_unique_key
    ON executions(workflow_name, unique_key) WHERE unique_key IS NOT NULL;`,
  `CREATE TABLE activity_tasks (
    task_id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL,
    activity_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'completed', 'failed', 'skipped')),
    priority INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 1,
    timeout INTEGER NOT NULL DEFAULT 25000,
    input TEXT NOT NULL,
    result TEXT,
    created_at INTEGER NOT NULL,
    scheduled_for INTEGER,
    started_at INTEGER,
    last_attempt_at INTEGER,
    completed_at INTEGER,
    error TEXT,
    error_stack TEXT,
    FOREIGN KEY (run_id) REFERENCES executions(run_id) ON DELETE CASCADE
  );`,
  `CREATE TABLE dead_letters (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    activity_name TEXT NOT NULL,
    workflow_name TEXT NOT NULL,
    input TEXT NOT NULL,
    error TEXT NOT NULL,
    error_stack TEXT,
    attempts INTEGER NOT NULL,
    failed_at INTEGER NOT NULL,
    acknowledged INTEGER NOT NULL DEFAULT 0
  );`,
  `CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT);`,
  `INSERT INTO schema_meta (key, value) VALUES ('version', '1');`,
];

/** Build a populated v1 database exactly as the reviewed code left it. */
async function createPopulatedV1Db(): Promise<BetterSqlite3Driver> {
  const driver = await BetterSqlite3Driver.create(':memory:');
  for (const stmt of V1_SCHEMA) {
    await driver.execute(stmt);
  }
  await driver.execute(
    `INSERT INTO executions (run_id, workflow_name, unique_key, current_activity_index,
      current_activity_name, status, input, state, created_at, updated_at)
     VALUES ('run-1', 'photoUpload', 'photo-42', 0, 'upload', 'running', '{"p":1}', '{"p":1}', 1000, 1000)`
  );
  await driver.execute(
    `INSERT INTO activity_tasks (task_id, run_id, activity_name, status, priority, attempts,
      max_attempts, timeout, input, created_at)
     VALUES ('task-1', 'run-1', 'upload', 'pending', 5, 1, 3, 25000, '{"p":1}', 1001)`
  );
  await driver.execute(
    `INSERT INTO dead_letters (id, run_id, task_id, activity_name, workflow_name, input,
      error, attempts, failed_at, acknowledged)
     VALUES ('dl-1', 'run-0', 'task-0', 'sync', 'sync', '{}', 'boom', 3, 900, 0)`
  );
  return driver;
}

class FaultInjectingDriver implements SQLiteDriver {
  private armed = false;
  private matcher: ((sql: string) => boolean) | null = null;

  constructor(private inner: SQLiteDriver) {}

  arm(matcher: (sql: string) => boolean): void {
    this.armed = true;
    this.matcher = matcher;
  }

  async execute(sql: string, params: unknown[] = []): Promise<SQLiteResult> {
    if (this.armed && this.matcher?.(sql)) {
      this.armed = false;
      throw new Error('injected crash');
    }
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

describe('schema migrations (C8)', () => {
  it('stamps a fresh database at the current version', async () => {
    const driver = await BetterSqlite3Driver.create(':memory:');
    const storage = new SQLiteStorage(driver);
    await storage.initialize();

    const rows = await driver.query('PRAGMA user_version');
    expect(Number(rows[0]!['user_version'])).toBe(SCHEMA_VERSION);
    await storage.close();
  });

  it('migrates a populated legacy v1 database with data intact', async () => {
    const driver = await createPopulatedV1Db();
    const storage = new SQLiteStorage(driver);
    await storage.initialize();

    // Version stamped.
    const rows = await driver.query('PRAGMA user_version');
    expect(Number(rows[0]!['user_version'])).toBe(SCHEMA_VERSION);

    // Data intact, new columns defaulted.
    const execution = await storage.getExecution('run-1');
    expect(execution).toMatchObject({ workflowName: 'photoUpload', status: 'running', uniqueKey: 'photo-42' });

    const task = await storage.getActivityTask('task-1');
    expect(task).toMatchObject({ activityName: 'upload', status: 'pending', attempts: 1, failures: 0 });
    expect(task!.ownerId).toBeUndefined();
    expect(task!.leaseExpiresAt).toBeUndefined();

    const deadLetters = await storage.getDeadLetters();
    expect(deadLetters).toHaveLength(1);

    // The migrated schema must actually work: leases and the
    // running-scoped unique index are live.
    const claimed = await storage.claimActivityTask('task-1', 5000, {
      ownerId: 'engine-1',
      leaseDurationMs: 60000,
    });
    expect(claimed?.ownerId).toBe('engine-1');
    expect(claimed?.leaseExpiresAt).toBe(65000);

    // Complete the running execution; the key must then be reusable.
    await storage.saveExecution({ ...(await storage.getExecution('run-1'))!, status: 'completed', completedAt: 6000 });
    await expect(
      storage.saveExecution({
        runId: 'run-2',
        workflowName: 'photoUpload',
        uniqueKey: 'photo-42',
        currentActivityIndex: 0,
        currentActivityName: 'upload',
        status: 'running',
        input: {},
        state: {},
        createdAt: 7000,
        updatedAt: 7000,
      })
    ).resolves.toBeUndefined();

    await storage.close();
  });

  it('is idempotent: re-opening an already-migrated database does nothing', async () => {
    const driver = await createPopulatedV1Db();
    await new SQLiteStorage(driver).initialize();

    const again = new SQLiteStorage(driver);
    await expect(again.initialize()).resolves.toBeUndefined();

    const rows = await driver.query('PRAGMA user_version');
    expect(Number(rows[0]!['user_version'])).toBe(SCHEMA_VERSION);
  });

  it('rolls back a crashed migration and succeeds on retry', async () => {
    const inner = await createPopulatedV1Db();
    const driver = new FaultInjectingDriver(inner);

    // Crash on the index rebuild, midway through the v2 migration.
    driver.arm(sql => sql.includes('idx_executions_unique_key_running'));

    await expect(new SQLiteStorage(driver).initialize()).rejects.toThrow('injected crash');

    // The whole migration must have rolled back: still v1 (reported 0 for
    // legacy), no half-added columns.
    const version = await inner.query('PRAGMA user_version');
    expect(Number(version[0]!['user_version'])).toBe(0);
    const columns = await inner.query(`PRAGMA table_info(activity_tasks)`);
    expect(columns.some(c => c['name'] === 'failures')).toBe(false);

    // Retry (the "next app launch") completes the migration.
    const storage = new SQLiteStorage(driver);
    await storage.initialize();
    expect(Number((await inner.query('PRAGMA user_version'))[0]!['user_version'])).toBe(SCHEMA_VERSION);
    expect((await storage.getActivityTask('task-1'))!.failures).toBe(0);

    await storage.close();
  });

  it('migrates dead_letters to carry the non-retryable flag (v3)', async () => {
    const driver = await createPopulatedV1Db();
    const storage = new SQLiteStorage(driver);
    await storage.initialize();

    // Legacy rows default to retryable.
    const legacy = (await storage.getDeadLetters()).find(d => d.id === 'dl-1');
    expect(legacy?.nonRetryable).toBe(false);

    // New records round-trip the flag.
    await storage.saveDeadLetter({
      id: 'dl-2',
      runId: 'run-1',
      taskId: 'task-1',
      activityName: 'upload',
      workflowName: 'photoUpload',
      input: {},
      error: 'row filter rejected',
      attempts: 1,
      failedAt: 2000,
      acknowledged: false,
      nonRetryable: true,
    });
    const saved = (await storage.getDeadLetters()).find(d => d.id === 'dl-2');
    expect(saved?.nonRetryable).toBe(true);

    await storage.close();
  });

  it('migrates executions to carry the workflow definition version (v4)', async () => {
    const driver = await createPopulatedV1Db();
    const storage = new SQLiteStorage(driver);
    await storage.initialize();

    // Legacy rows have no recorded version.
    const legacy = await storage.getExecution('run-1');
    expect(legacy?.workflowVersion).toBeUndefined();

    // New executions round-trip the version.
    await storage.saveExecution({ ...legacy!, workflowVersion: '7' });
    expect((await storage.getExecution('run-1'))?.workflowVersion).toBe('7');

    await storage.close();
  });

  it('refuses to open a database from a newer package version', async () => {
    const driver = await createPopulatedV1Db();
    await driver.execute(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);

    await expect(new SQLiteStorage(driver).initialize()).rejects.toThrow(/newer than this package supports/);
  });
});
