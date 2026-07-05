/**
 * SQLite driver implementation for expo-sqlite.
 * This wraps expo-sqlite to implement the SQLiteDriver interface.
 */

import { SQLiteDriver, SQLiteRow, SQLiteResult } from './SQLiteDriver';

/**
 * Type definitions for expo-sqlite.
 * We use these types to avoid requiring expo-sqlite at compile time.
 */
interface ExpoSQLiteDatabase {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: unknown[]): Promise<{ changes: number; lastInsertRowId: number }>;
  getAllAsync<T = SQLiteRow>(sql: string, ...params: unknown[]): Promise<T[]>;
  // Matches the real expo-sqlite v14+ API: the task's return value is
  // discarded — withTransactionAsync always resolves to void.
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
  closeAsync(): Promise<void>;
}

/**
 * Factory function type for opening an expo-sqlite database.
 * This is the openDatabaseAsync function from expo-sqlite.
 */
export type ExpoSQLiteFactory = (databaseName: string) => Promise<ExpoSQLiteDatabase>;

/**
 * SQLite driver implementation using expo-sqlite.
 */
export class ExpoSqliteDriver implements SQLiteDriver {
  private db: ExpoSQLiteDatabase;
  private transactionDepth = 0;

  constructor(db: ExpoSQLiteDatabase) {
    this.db = db;
  }

  /**
   * Create a new driver instance.
   *
   * @param databaseName - Name of the database file (e.g., 'workflow.db')
   * @param openDatabase - The openDatabaseAsync function from expo-sqlite
   *
   * @example
   * ```typescript
   * import { openDatabaseAsync } from 'expo-sqlite';
   *
   * const driver = await ExpoSqliteDriver.create('workflow.db', openDatabaseAsync);
   * const storage = new SQLiteStorage(driver);
   * await storage.initialize();
   * ```
   */
  static async create(
    databaseName: string,
    openDatabase: ExpoSQLiteFactory
  ): Promise<ExpoSqliteDriver> {
    const db = await openDatabase(databaseName);
    return new ExpoSqliteDriver(db);
  }

  async execute(sql: string, params: unknown[] = []): Promise<SQLiteResult> {
    // expo-sqlite v14+ uses runAsync for statements with parameters
    // For CREATE TABLE and other DDL, use execAsync
    if (sql.trim().toUpperCase().startsWith('CREATE') ||
        sql.trim().toUpperCase().startsWith('DROP') ||
        sql.trim().toUpperCase().startsWith('ALTER')) {
      await this.db.execAsync(sql);
      return { rows: [], changes: 0 };
    }

    const result = await this.db.runAsync(sql, ...params);
    return { rows: [], changes: result.changes };
  }

  async query(sql: string, params: unknown[] = []): Promise<SQLiteRow[]> {
    return await this.db.getAllAsync(sql, ...params);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // Nested calls join the outer transaction — expo-sqlite throws on a
    // nested withTransactionAsync.
    if (this.transactionDepth > 0) {
      return await fn();
    }

    // expo-sqlite's withTransactionAsync resolves to void, so the callback's
    // result must be captured in a closure.
    let result: T | undefined;
    let completed = false;
    this.transactionDepth++;
    try {
      await this.db.withTransactionAsync(async () => {
        result = await fn();
        completed = true;
      });
    } finally {
      this.transactionDepth--;
    }
    if (!completed) {
      throw new Error('Transaction callback did not run to completion');
    }
    return result as T;
  }

  async close(): Promise<void> {
    await this.db.closeAsync();
  }
}
