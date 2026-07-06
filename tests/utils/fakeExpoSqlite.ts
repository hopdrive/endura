/**
 * A faithful double of expo-sqlite's SQLiteDatabase (v14+ async API),
 * backed by better-sqlite3 so SQL really runs.
 *
 * Most importantly, `withTransactionAsync(task): Promise<void>` DISCARDS
 * the callback's return value, exactly like the published expo-sqlite
 * typings and implementation — the shape that caused review issue C1.
 */

import type { Database as BetterSqlite3Db } from 'better-sqlite3';

export class FakeExpoSQLiteDatabase {
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
