/**
 * Connection pragma tests (review issue H4).
 *
 * The storage never configured the connection: no WAL (needed for the
 * two-connection foreground/background deployment), no busy_timeout
 * (SQLITE_BUSY surfaced instantly), and foreign_keys was left at the
 * driver's default (OFF in expo-sqlite — the ON DELETE CASCADE in the
 * schema was inert on-device).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteStorage } from '../../../../src/storage/sqlite';
import { BetterSqlite3Driver } from '../../../../src/storage/sqlite/internal/BetterSqlite3Driver';

describe('connection pragmas (H4)', () => {
  it('sets busy_timeout and foreign_keys on initialize', async () => {
    const driver = await BetterSqlite3Driver.create(':memory:');
    const storage = new SQLiteStorage(driver);
    await storage.initialize();

    const busy = await driver.query('PRAGMA busy_timeout');
    expect(Number(busy[0]!['timeout'] ?? busy[0]!['busy_timeout'])).toBe(5000);

    const fk = await driver.query('PRAGMA foreign_keys');
    expect(Number(fk[0]!['foreign_keys'])).toBe(1);

    await storage.close();
  });

  it('enables WAL journal mode on file-backed databases', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'endura-wal-'));
    const driver = await BetterSqlite3Driver.create(join(dir, 'workflow.db'));
    const storage = new SQLiteStorage(driver);
    await storage.initialize();

    const mode = await driver.query('PRAGMA journal_mode');
    expect(String(mode[0]!['journal_mode']).toLowerCase()).toBe('wal');

    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('foreign keys actually cascade: deleting an execution removes its tasks', async () => {
    const driver = await BetterSqlite3Driver.create(':memory:');
    const storage = new SQLiteStorage(driver);
    await storage.initialize();

    await storage.saveExecution({
      runId: 'r1',
      workflowName: 'wf',
      currentActivityIndex: 0,
      currentActivityName: 'a',
      status: 'running',
      input: {},
      state: {},
      createdAt: 1,
      updatedAt: 1,
    });
    await storage.saveActivityTask({
      taskId: 't1',
      runId: 'r1',
      activityName: 'a',
      status: 'pending',
      priority: 0,
      attempts: 0,
      maxAttempts: 3,
      timeout: 25000,
      input: {},
      createdAt: 1,
    });

    await storage.deleteExecution('r1');
    expect(await storage.getActivityTask('t1')).toBeNull();

    await storage.close();
  });
});
