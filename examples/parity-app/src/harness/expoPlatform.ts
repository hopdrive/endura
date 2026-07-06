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
}

export const expoPlatform: HarnessPlatform<ParityClient> = {
  async createClient(dbName: string, online: () => boolean): Promise<ParityClient> {
    const driver = await ExpoSqliteDriver.create(dbName, openDatabaseAsync);
    const storage = new SQLiteStorage(driver);
    await storage.initialize();

    const client = (await ExpoWorkflowClient.create({
      storage,
      leaseDurationMs: 10000,
      environment: {
        getNetworkState: async () => online(),
      },
    })) as ParityClient;
    client.parityDriver = driver;
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
