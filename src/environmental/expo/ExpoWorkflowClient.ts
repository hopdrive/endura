/**
 * Expo Workflow Client - Main entry point for Expo apps.
 * Provides a convenient way to create and configure the workflow engine
 * with Expo-specific runtime adapters.
 */

import { WorkflowEngine } from '../../core/engine';
import { Storage } from '../../core/types';
import { setIdGenerator } from '../../core/utils';
import { ExpoClock } from './ExpoClock';
import { ExpoScheduler } from './ExpoScheduler';
import { ExpoEnvironment, ExpoEnvironmentOptions } from './ExpoEnvironment';

/**
 * Wire ID generation to expo-crypto when available. Hermes ships neither
 * crypto.randomUUID nor crypto.getRandomValues, so without this the
 * engine cannot mint IDs on-device.
 */
function wireExpoCrypto(): void {
  try {
    // Dynamic require: expo-crypto is an optional peer dependency
    const cryptoModule = require('expo-crypto') as { randomUUID?: () => string };
    if (typeof cryptoModule.randomUUID === 'function') {
      setIdGenerator(() => cryptoModule.randomUUID!());
    }
  } catch {
    // expo-crypto not installed — generateId falls back to global crypto
    // and throws a descriptive error if none exists.
  }
}

/**
 * Configuration options for the Expo workflow client.
 */
export interface ExpoWorkflowClientOptions {
  /**
   * Storage adapter instance.
   *
   * @example SQLite
   * ```typescript
   * import { SQLiteStorage, ExpoSqliteDriver } from 'endura/storage/sqlite';
   * import { openDatabaseAsync } from 'expo-sqlite';
   *
   * const driver = await ExpoSqliteDriver.create('workflow.db', openDatabaseAsync);
   * const storage = new SQLiteStorage(driver);
   * await storage.initialize();
   * ```
   */
  storage: Storage;

  /**
   * Environment options for network state and battery level.
   */
  environment?: ExpoEnvironmentOptions;

  /**
   * Event handler for workflow engine events.
   */
  onEvent?: (event: {
    type: string;
    runId?: string;
    taskId?: string;
    [key: string]: unknown;
  }) => void;

  /**
   * How long a claimed task's lease lasts before other engines may
   * reclaim it. See WorkflowEngineConfig.leaseDurationMs.
   * @default 60000
   */
  leaseDurationMs?: number;
}

/**
 * Expo Workflow Client.
 * Combines the workflow engine with Expo-specific runtime adapters.
 */
export class ExpoWorkflowClient {
  readonly engine: WorkflowEngine;
  readonly storage: Storage;
  readonly environment: ExpoEnvironment;

  private constructor(
    engine: WorkflowEngine,
    storage: Storage,
    environment: ExpoEnvironment
  ) {
    this.engine = engine;
    this.storage = storage;
    this.environment = environment;
  }

  /**
   * Create a new Expo workflow client.
   *
   * @example
   * ```typescript
   * import { SQLiteStorage, ExpoSqliteDriver } from 'endura/storage/sqlite';
   * import { ExpoWorkflowClient } from 'endura/environmental/expo';
   * import { openDatabaseAsync } from 'expo-sqlite';
   * import NetInfo from '@react-native-community/netinfo';
   *
   * // Create storage
   * const driver = await ExpoSqliteDriver.create('workflow.db', openDatabaseAsync);
   * const storage = new SQLiteStorage(driver);
   * await storage.initialize();
   *
   * // Create client
   * const client = await ExpoWorkflowClient.create({
   *   storage,
   *   environment: {
   *     getNetworkState: async () => {
   *       const state = await NetInfo.fetch();
   *       return state.isConnected ?? false;
   *     },
   *   },
   * });
   *
   * // Register workflows
   * client.registerWorkflow(photoWorkflow);
   *
   * // Start the engine
   * await client.start();
   * ```
   */
  static async create(options: ExpoWorkflowClientOptions): Promise<ExpoWorkflowClient> {
    wireExpoCrypto();

    const storage = options.storage;

    // Create runtime adapters
    const clock = new ExpoClock();
    const scheduler = new ExpoScheduler();
    const environment = new ExpoEnvironment(options.environment);

    // Create the engine
    const engine = await WorkflowEngine.create({
      storage,
      clock,
      scheduler,
      environment,
      onEvent: options.onEvent,
      leaseDurationMs: options.leaseDurationMs,
    });

    return new ExpoWorkflowClient(engine, storage, environment);
  }

  /**
   * Start the workflow engine loop. Delegates to engine.run(), so it
   * honors stop(), uses the injected Clock/Scheduler, and contains
   * per-tick errors. Resolves when the lifespan elapses or stop() is
   * called.
   *
   * @param options - Optional configuration for the tick loop
   * @param options.lifespan - Maximum time to run in milliseconds (useful for background tasks)
   * @param options.tickInterval - Idle sleep between ticks in milliseconds (default: 100)
   */
  async start(options?: { lifespan?: number; tickInterval?: number }): Promise<void> {
    await this.engine.run({
      lifespan: options?.lifespan,
      tickInterval: options?.tickInterval,
    });
  }

  /**
   * Stop a running start() loop. Safe to call when not running.
   */
  stop(): void {
    this.engine.stop();
  }

  /**
   * Process a single tick of the workflow engine.
   * Useful for manual control or testing.
   */
  async tick(): Promise<void> {
    await this.engine.tick();
  }

  /**
   * Close the client and release resources: stops the engine loop,
   * disposes the environment's refresh interval, and closes storage.
   */
  async close(): Promise<void> {
    this.engine.stop();
    this.environment.dispose();
    if ('close' in this.storage && typeof this.storage.close === 'function') {
      await (this.storage as { close: () => Promise<void> }).close();
    }
  }

  // Delegate common methods to the engine

  get registerWorkflow() {
    return this.engine.registerWorkflow.bind(this.engine);
  }

  get start_workflow() {
    return this.engine.start.bind(this.engine);
  }

  get getExecution() {
    return this.engine.getExecution.bind(this.engine);
  }

  get getExecutionsByStatus() {
    return this.engine.getExecutionsByStatus.bind(this.engine);
  }

  get getExecutions() {
    return this.engine.getExecutions.bind(this.engine);
  }

  get cancelExecution() {
    return this.engine.cancelExecution.bind(this.engine);
  }

  get getDeadLetters() {
    return this.engine.getDeadLetters.bind(this.engine);
  }

  get getUnacknowledgedDeadLetters() {
    return this.engine.getUnacknowledgedDeadLetters.bind(this.engine);
  }

  get acknowledgeDeadLetter() {
    return this.engine.acknowledgeDeadLetter.bind(this.engine);
  }

  get retryFromDeadLetter() {
    return this.engine.retryFromDeadLetter.bind(this.engine);
  }

  get purgeDeadLetters() {
    return this.engine.purgeDeadLetters.bind(this.engine);
  }

  get subscribeToChanges() {
    return this.engine.subscribeToChanges.bind(this.engine);
  }
}
