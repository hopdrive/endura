/**
 * Background task registration for Expo.
 * Integrates with expo-task-manager and expo-background-task (the
 * successor to the deprecated expo-background-fetch — both APIs are
 * supported via the injected register/unregister functions).
 *
 * This module provides helpers for running the workflow engine
 * in the background on iOS and Android.
 *
 * @example
 * ```typescript
 * // In your app's entry point (e.g., index.js or App.tsx)
 * import {
 *   registerBackgroundTask,
 *   WORKFLOW_BACKGROUND_TASK,
 *   runBackgroundWorkflowTask,
 *   toBackgroundTaskResult,
 * } from 'endura/environmental/expo';
 * import { SQLiteStorage, ExpoSqliteDriver } from 'endura/storage/sqlite';
 * import * as TaskManager from 'expo-task-manager';
 * import * as BackgroundTask from 'expo-background-task';
 * import { openDatabaseAsync } from 'expo-sqlite';
 * import { photoWorkflow, syncWorkflow } from './workflows';
 *
 * // Define the background task
 * TaskManager.defineTask(WORKFLOW_BACKGROUND_TASK, async () => {
 *   // Create storage
 *   const driver = await ExpoSqliteDriver.create('workflow.db', openDatabaseAsync);
 *   const storage = new SQLiteStorage(driver);
 *   await storage.initialize();
 *
 *   // Same worker entry file the foreground app uses
 *   const worker = new Worker('./workflows/endura.worker', { nativeModules: true });
 *   const result = await runBackgroundWorkflowTask({
 *     storage,
 *     worker,
 *     workflows: [photoWorkflow, syncWorkflow],
 *     lifespan: 25000, // 25 seconds
 *   });
 *   worker.terminate();
 *   return toBackgroundTaskResult(result);
 * });
 *
 * // Register for periodic execution (expo-background-task takes
 * // minimumInterval in MINUTES)
 * await registerBackgroundTask(BackgroundTask.registerTaskAsync, {
 *   minimumInterval: 15,
 * });
 * ```
 */

import { ActivityDispatcher, Storage, Workflow } from '../../core/types';
import { WorkerLike } from '../../workers/protocol';
import { ExpoWorkflowClient, ExpoWorkflowClientOptions } from './ExpoWorkflowClient';

/**
 * Default task name for the workflow background task.
 */
export const WORKFLOW_BACKGROUND_TASK = 'WORKFLOW_ENGINE_BACKGROUND';

/**
 * Background fetch result enum.
 * Mirrors BackgroundFetch.BackgroundFetchResult from expo-background-fetch.
 */
export enum BackgroundFetchResult {
  NoData = 1,
  NewData = 2,
  Failed = 3,
}

/**
 * Background task result enum.
 * Mirrors BackgroundTask.BackgroundTaskResult from expo-background-task.
 */
export enum BackgroundTaskResult {
  Success = 1,
  Failed = 2,
}

/**
 * Map a BackgroundFetchResult onto expo-background-task's coarser
 * result type (which has no NoData/NewData distinction).
 */
export function toBackgroundTaskResult(result: BackgroundFetchResult): BackgroundTaskResult {
  return result === BackgroundFetchResult.Failed
    ? BackgroundTaskResult.Failed
    : BackgroundTaskResult.Success;
}

/**
 * Options for running the workflow engine in a background task.
 */
export interface BackgroundTaskOptions {
  /**
   * Storage adapter instance.
   */
  storage: Storage;

  /**
   * Workflows to register for background processing.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  workflows: Array<Workflow<any>>;

  /**
   * The worker that executes activities, created fresh inside the
   * background task with react-native-workers (same worker entry file
   * as the foreground app). The task owns its lifecycle — terminate it
   * when the task ends. Exactly one of `worker` or `dispatcher` is
   * required.
   */
  worker?: WorkerLike;

  /** Pre-built dispatcher (tests, unusual runtimes). */
  dispatcher?: ActivityDispatcher;

  /**
   * Maximum time to run in milliseconds.
   * iOS and Android typically allow ~30 seconds for background tasks.
   * @default 25000
   */
  lifespan?: number;

  /**
   * Interval between ticks in milliseconds.
   * @default 100
   */
  tickInterval?: number;

  /**
   * Environment options (network state, battery level providers).
   */
  environment?: ExpoWorkflowClientOptions['environment'];

  /**
   * Callback invoked when background processing starts.
   */
  onStart?: () => void | Promise<void>;

  /**
   * Callback invoked when background processing completes.
   */
  onComplete?: (processedCount: number) => void | Promise<void>;

  /**
   * Callback invoked if background processing fails.
   */
  onError?: (error: Error) => void | Promise<void>;
}

/**
 * Run the workflow engine in a background task.
 *
 * @param options - Configuration for the background task
 * @returns BackgroundFetchResult indicating success or failure
 *
 * @example
 * ```typescript
 * TaskManager.defineTask(WORKFLOW_BACKGROUND_TASK, async () => {
 *   const driver = await ExpoSqliteDriver.create('workflow.db', openDatabaseAsync);
 *   const storage = new SQLiteStorage(driver);
 *   await storage.initialize();
 *
 *   return await runBackgroundWorkflowTask({
 *     storage,
 *     workflows: [photoWorkflow, syncWorkflow],
 *   });
 * });
 * ```
 */
export async function runBackgroundWorkflowTask(
  options: BackgroundTaskOptions
): Promise<BackgroundFetchResult> {
  const lifespan = options.lifespan ?? 25000;
  const tickInterval = options.tickInterval ?? 100;

  try {
    await options.onStart?.();

    // Count real work so the OS gets an honest fetch result — always
    // reporting NewData degrades iOS background scheduling.
    let processedCount = 0;

    // Create the client
    const client = await ExpoWorkflowClient.create({
      storage: options.storage,
      worker: options.worker,
      dispatcher: options.dispatcher,
      environment: options.environment,
      onEvent: event => {
        if (event.type === 'activity:completed') {
          processedCount++;
        }
      },
    });

    // Register all workflows (the engine erases input generics internally)
    for (const workflow of options.workflows) {
      client.registerWorkflow(workflow as Workflow);
    }

    // Process for the allowed time
    await client.start({ lifespan, tickInterval });

    // Clean up
    await client.close();

    await options.onComplete?.(processedCount);

    return processedCount > 0 ? BackgroundFetchResult.NewData : BackgroundFetchResult.NoData;
  } catch (error) {
    await options.onError?.(error instanceof Error ? error : new Error(String(error)));
    return BackgroundFetchResult.Failed;
  }
}

/**
 * Options for registering the background task.
 */
export interface RegisterBackgroundTaskOptions {
  /**
   * Task name.
   * @default WORKFLOW_BACKGROUND_TASK
   */
  taskName?: string;

  /**
   * Minimum interval between background executions, in the unit your
   * background API expects: MINUTES for expo-background-task
   * (recommended), seconds for the deprecated expo-background-fetch.
   * @default 15 (15 minutes with expo-background-task)
   */
  minimumInterval?: number;

  /**
   * Whether to stop when the app is terminated (Android only).
   * @default false
   */
  stopOnTerminate?: boolean;

  /**
   * Whether to start on device boot (Android only).
   * @default true
   */
  startOnBoot?: boolean;
}

/**
 * Register the workflow engine for periodic background execution.
 *
 * You must call this after defining the task with TaskManager.defineTask.
 *
 * @param registerTaskAsync - The registerTaskAsync function from
 *   expo-background-task (or the deprecated expo-background-fetch)
 * @param options - Registration options
 *
 * @example
 * ```typescript
 * import * as BackgroundTask from 'expo-background-task';
 *
 * await registerBackgroundTask(BackgroundTask.registerTaskAsync, {
 *   minimumInterval: 15, // minutes
 * });
 * ```
 */
export async function registerBackgroundTask(
  registerTaskAsync: (
    taskName: string,
    options: {
      minimumInterval?: number;
      stopOnTerminate?: boolean;
      startOnBoot?: boolean;
    }
  ) => Promise<void>,
  options: RegisterBackgroundTaskOptions = {}
): Promise<void> {
  const taskName = options.taskName ?? WORKFLOW_BACKGROUND_TASK;

  await registerTaskAsync(taskName, {
    minimumInterval: options.minimumInterval ?? 15, // minutes (expo-background-task)
    stopOnTerminate: options.stopOnTerminate ?? false,
    startOnBoot: options.startOnBoot ?? true,
  });
}

/**
 * Unregister the workflow background task.
 *
 * @param unregisterTaskAsync - The unregisterTaskAsync function from
 *   expo-background-task (or the deprecated expo-background-fetch)
 * @param taskName - Task name to unregister
 */
export async function unregisterBackgroundTask(
  unregisterTaskAsync: (taskName: string) => Promise<void>,
  taskName: string = WORKFLOW_BACKGROUND_TASK
): Promise<void> {
  await unregisterTaskAsync(taskName);
}
