/**
 * Transaction semantics tests for BetterSqlite3Driver.
 *
 * The whole test suite runs on this driver, so if its transaction() is a
 * no-op, every "atomicity" guarantee the suite appears to prove is fiction.
 * These tests pin down real BEGIN/COMMIT/ROLLBACK behavior.
 */

import { BetterSqlite3Driver } from '../../../../src/storage/sqlite/internal/BetterSqlite3Driver';

describe('BetterSqlite3Driver transactions', () => {
  let driver: BetterSqlite3Driver;

  beforeEach(async () => {
    driver = await BetterSqlite3Driver.create(':memory:');
    await driver.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);');
  });

  afterEach(async () => {
    await driver.close();
  });

  it('returns the callback result', async () => {
    const result = await driver.transaction(async () => 'ok');
    expect(result).toBe('ok');
  });

  it('commits writes on success', async () => {
    await driver.transaction(async () => {
      await driver.execute('INSERT INTO t (v) VALUES (?)', ['a']);
      await driver.execute('INSERT INTO t (v) VALUES (?)', ['b']);
    });
    const rows = await driver.query('SELECT v FROM t ORDER BY id');
    expect(rows).toEqual([{ v: 'a' }, { v: 'b' }]);
  });

  it('rolls back all writes when the callback throws', async () => {
    await expect(
      driver.transaction(async () => {
        await driver.execute('INSERT INTO t (v) VALUES (?)', ['a']);
        await driver.execute('INSERT INTO t (v) VALUES (?)', ['b']);
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    // A no-op "transaction" leaves both rows behind.
    const rows = await driver.query('SELECT v FROM t');
    expect(rows).toEqual([]);
  });

  it('supports nested transaction calls by joining the outer transaction', async () => {
    await expect(
      driver.transaction(async () => {
        await driver.execute('INSERT INTO t (v) VALUES (?)', ['outer']);
        await driver.transaction(async () => {
          await driver.execute('INSERT INTO t (v) VALUES (?)', ['inner']);
        });
        throw new Error('abort everything');
      })
    ).rejects.toThrow('abort everything');

    // The inner write must roll back with the outer transaction.
    const rows = await driver.query('SELECT v FROM t');
    expect(rows).toEqual([]);
  });

  it('recovers after a rollback (connection usable, no dangling transaction)', async () => {
    await expect(
      driver.transaction(async () => {
        await driver.execute('INSERT INTO t (v) VALUES (?)', ['x']);
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    await driver.transaction(async () => {
      await driver.execute('INSERT INTO t (v) VALUES (?)', ['y']);
    });
    const rows = await driver.query('SELECT v FROM t');
    expect(rows).toEqual([{ v: 'y' }]);
  });
});
