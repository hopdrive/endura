/**
 * SQLite driver implementation using better-sqlite3 for Node.js testing.
 * This is only used for testing - the actual Expo app uses expo-sqlite.
 */

import { SQLiteDriver, SQLiteRow, SQLiteResult } from './SQLiteDriver';

// Type definitions for better-sqlite3 (to avoid requiring the dependency at compile time)
interface BetterSqlite3Database {
  prepare(sql: string): BetterSqlite3Statement;
  exec(sql: string): void;
  close(): void;
  transaction<T>(fn: () => T): () => T;
}

interface BetterSqlite3Statement {
  run(...params: unknown[]): { changes: number };
  all(...params: unknown[]): SQLiteRow[];
}

/**
 * Create a better-sqlite3 driver for Node.js testing.
 */
export class BetterSqlite3Driver implements SQLiteDriver {
  private db: BetterSqlite3Database;
  private transactionDepth = 0;

  constructor(db: BetterSqlite3Database) {
    this.db = db;
  }

  /**
   * Create a new driver instance with a database file or in-memory database.
   */
  static async create(databasePath: string = ':memory:'): Promise<BetterSqlite3Driver> {
    // Dynamic import to avoid requiring better-sqlite3 at compile time
    const Database = require('better-sqlite3');
    const db = new Database(databasePath);
    return new BetterSqlite3Driver(db);
  }

  async execute(sql: string, params: unknown[] = []): Promise<SQLiteResult> {
    try {
      const stmt = this.db.prepare(sql);
      const result = stmt.run(...params);
      return { rows: [], changes: result.changes };
    } catch (error) {
      // For CREATE TABLE statements, use exec
      if (sql.trim().toUpperCase().startsWith('CREATE')) {
        this.db.exec(sql);
        return { rows: [], changes: 0 };
      }
      throw error;
    }
  }

  async query(sql: string, params: unknown[] = []): Promise<SQLiteRow[]> {
    const stmt = this.db.prepare(sql);
    return stmt.all(...params);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // Nested calls join the outer transaction — SQLite cannot BEGIN inside
    // an open transaction, and callers compose (e.g. storage.transaction()
    // wrapping a claim that itself uses a transaction).
    if (this.transactionDepth > 0) {
      return await fn();
    }

    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth++;
    try {
      const result = await fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/**
 * Factory function to create a better-sqlite3 driver.
 */
export async function createBetterSqlite3Driver(databasePath?: string): Promise<SQLiteDriver> {
  return BetterSqlite3Driver.create(databasePath);
}
