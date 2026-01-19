/**
 * Expo Workflow Client - Main entry point for Expo apps.
 * Provides a convenient way to create and configure the workflow engine
 * with Expo-specific runtime adapters.
 *
 * This is an event-driven client - no always-on polling loops.
 * Processing is triggered by calling processNow() or processForDuration().
 */

import { WorkflowEngine } from '../../core/engine';
import { Storage, ProcessResult, Workflow, StartWorkflowOptions } from '../../core/types';
import { ExpoClock } from './ExpoClock';
import { ExpoScheduler } from './ExpoScheduler';
import { ExpoEnvironment, ExpoEnvironmentOptions } from './ExpoEnvironment';

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
}

/**
 * Expo Workflow Client.
 * Combines the workflow engine with Expo-specific runtime adapters.
 *
 * This is an event-driven client. Processing is triggered explicitly:
 * - Call processNow() when app comes to foreground
 * - Call processNow() when network state changes
 * - Call processForDuration() in background fetch handlers
 * - Starting a workflow auto-triggers processing
 *
 * @example
 * ```typescript
 * import { SQLiteStorage, ExpoSqliteDriver } from 'endura/storage/sqlite';
 * import { ExpoWorkflowClient } from 'endura/environmental/expo';
 * import { openDatabaseAsync } from 'expo-sqlite';
 *
 * // Create storage
 * const driver = await ExpoSqliteDriver.create('workflow.db', openDatabaseAsync);
 * const storage = new SQLiteStorage(driver);
 * await storage.initialize();
 *
 * // Create client
 * const client = await ExpoWorkflowClient.create({ storage });
 *
 * // Register workflows
 * client.registerWorkflow(photoWorkflow);
 *
 * // Process pending work
 * await client.processNow();
 *
 * // Starting a workflow auto-triggers processing
 * await client.startWorkflow(photoWorkflow, { input: { moveId: 123 } });
 *
 * // In app lifecycle
 * AppState.addEventListener('change', (state) => {
 *   if (state === 'active') client.processNow();
 * });
 *
 * NetInfo.addEventListener((state) => {
 *   client.environment.setNetworkState(state.isConnected ?? false);
 *   if (state.isConnected) client.processNow();
 * });
 * ```
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
   */
  static async create(options: ExpoWorkflowClientOptions): Promise<ExpoWorkflowClient> {
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
    });

    return new ExpoWorkflowClient(engine, storage, environment);
  }

  /**
   * Process pending work immediately.
   * Returns when queue is empty or timeout is reached.
   *
   * This is the primary way to trigger processing in event-driven mode.
   *
   * @param options.timeout - Maximum time to process in milliseconds
   * @returns ProcessResult with count and reason for stopping
   *
   * @example
   * ```typescript
   * // Process all pending work
   * const result = await client.processNow();
   * console.log(`Processed ${result.processed} tasks`);
   *
   * // Process with timeout
   * const result = await client.processNow({ timeout: 5000 });
   * ```
   */
  async processNow(options?: { timeout?: number }): Promise<ProcessResult> {
    return this.engine.process({ lifespan: options?.timeout });
  }

  /**
   * Process work for a bounded time window.
   * Use this in background fetch handlers where you have a limited time window.
   *
   * @param lifespan - Maximum time to process in milliseconds
   * @returns ProcessResult with count and reason for stopping
   *
   * @example
   * ```typescript
   * // In background fetch handler (typically ~25 seconds allowed)
   * const result = await client.processForDuration(25000);
   * return result.processed > 0
   *   ? BackgroundFetch.BackgroundFetchResult.NewData
   *   : BackgroundFetch.BackgroundFetchResult.NoData;
   * ```
   */
  async processForDuration(lifespan: number): Promise<ProcessResult> {
    return this.engine.process({ lifespan });
  }

  /**
   * Check if there is pending work ready to process.
   *
   * @example
   * ```typescript
   * if (await client.hasPendingWork()) {
   *   await client.processNow();
   * }
   * ```
   */
  async hasPendingWork(): Promise<boolean> {
    return this.engine.hasPendingWork();
  }

  /**
   * Close the client and release resources.
   */
  async close(): Promise<void> {
    this.engine.stop();
    if ('close' in this.storage && typeof this.storage.close === 'function') {
      await (this.storage as { close: () => Promise<void> }).close();
    }
  }

  // ============================================================================
  // Delegated methods
  // ============================================================================

  /**
   * Register a workflow with the engine.
   */
  get registerWorkflow() {
    return this.engine.registerWorkflow.bind(this.engine);
  }

  /**
   * Start a workflow execution.
   * This also auto-triggers processing of the new task.
   */
  async startWorkflow<TInput extends Record<string, unknown>>(
    workflow: Workflow<TInput>,
    options: StartWorkflowOptions<TInput>
  ) {
    return this.engine.start(workflow, options);
  }

  /**
   * Get a workflow execution by runId.
   */
  get getExecution() {
    return this.engine.getExecution.bind(this.engine);
  }

  /**
   * Get workflow executions by status.
   */
  get getExecutionsByStatus() {
    return this.engine.getExecutionsByStatus.bind(this.engine);
  }

  /**
   * Cancel a workflow execution.
   */
  get cancelExecution() {
    return this.engine.cancelExecution.bind(this.engine);
  }

  /**
   * Get all dead letter records.
   */
  get getDeadLetters() {
    return this.engine.getDeadLetters.bind(this.engine);
  }

  /**
   * Get unacknowledged dead letter records.
   */
  get getUnacknowledgedDeadLetters() {
    return this.engine.getUnacknowledgedDeadLetters.bind(this.engine);
  }

  /**
   * Acknowledge a dead letter record.
   */
  get acknowledgeDeadLetter() {
    return this.engine.acknowledgeDeadLetter.bind(this.engine);
  }

  /**
   * Purge dead letter records.
   */
  get purgeDeadLetters() {
    return this.engine.purgeDeadLetters.bind(this.engine);
  }
}
