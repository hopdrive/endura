/**
 * Expo implementation of HarnessPlatform: real SQLite persistence
 * (per-scenario database files), real ExpoWorkflowClient, connectivity
 * wired through the engine's Environment abstraction — not simulator
 * network toggles.
 */

import { openDatabaseAsync, deleteDatabaseAsync } from 'expo-sqlite';
import { SQLiteStorage, ExpoSqliteDriver } from 'endura/storage/sqlite';
import { ExpoWorkflowClient } from 'endura/environmental/expo';
import { HarnessPlatform } from './runner';

export interface ParityClient extends ExpoWorkflowClient {
  /** Raw driver for side tables / direct inspection queries. */
  parityDriver: ExpoSqliteDriver;
  /**
   * Captured engine log lines ("level message json-context"), newest
   * last — lets scenarios assert observability contracts like "the
   * stale result was logged as discarded".
   */
  parityLogs: string[];
}

export const expoPlatform: HarnessPlatform<ParityClient> = {
  async createClient(dbName: string, online: () => boolean): Promise<ParityClient> {
    const driver = await ExpoSqliteDriver.create(dbName, openDatabaseAsync);
    const storage = new SQLiteStorage(driver);
    await storage.initialize();

    const logs: string[] = [];
    const capture = (level: string) => (message: string, context?: Record<string, unknown>) => {
      logs.push(`${level} ${message} ${context ? JSON.stringify(context) : ''}`);
      if (logs.length > 500) logs.shift();
    };

    const client = (await ExpoWorkflowClient.create({
      storage,
      leaseDurationMs: 10000,
      logger: {
        debug: capture('debug'),
        info: capture('info'),
        warn: capture('warn'),
        error: capture('error'),
      },
      environment: {
        getNetworkState: async () => online(),
      },
    })) as ParityClient;
    client.parityDriver = driver;
    client.parityLogs = logs;
    return client;
  },

  async deleteDatabase(dbName: string): Promise<void> {
    try {
      await deleteDatabaseAsync(dbName);
    } catch {
      // Database may not exist yet — reset is idempotent.
    }
  },

  now: () => Date.now(),
};
