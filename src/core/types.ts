/**
 * Core type definitions for the workflow engine.
 * These types are platform-agnostic and contain no React Native or Expo imports.
 */

// ============================================================================
// Workflow Execution Status Types
// ============================================================================

export type WorkflowExecutionStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export type ActivityTaskStatus = 'pending' | 'active' | 'completed' | 'failed' | 'skipped';

// ============================================================================
// Workflow Execution
// ============================================================================

/**
 * A WorkflowExecution is an instance of a workflow - a specific execution that
 * tracks progress through the activity sequence.
 */
export interface WorkflowExecution {
  /** UUID, primary key */
  runId: string;
  /** References workflow definition name */
  workflowName: string;
  /** Optional deduplication key */
  uniqueKey?: string;

  /** Position in activity sequence (0-based) */
  currentActivityIndex: number;
  /** Name of current/next activity */
  currentActivityName: string;
  /** Execution status */
  status: WorkflowExecutionStatus;

  /** Original input when workflow started */
  input: Record<string, unknown>;
  /** Accumulated state (input + activity returns merged) */
  state: Record<string, unknown>;

  /** Unix timestamp ms - when created */
  createdAt: number;
  /** Unix timestamp ms - last modification */
  updatedAt: number;
  /** Unix timestamp ms - when workflow finished */
  completedAt?: number;

  /** Error message if failed */
  error?: string;
  /** Which activity caused failure */
  failedActivityName?: string;
}

// ============================================================================
// Activity Task
// ============================================================================

/**
 * An ActivityTask is a persisted record representing a scheduled activity execution.
 * Users don't interact with these directly - they're internal to the engine.
 */
export interface ActivityTask {
  /** UUID, primary key */
  taskId: string;
  /** Foreign key to WorkflowExecution */
  runId: string;
  /** Matches Activity name */
  activityName: string;

  /** Execution state */
  status: ActivityTaskStatus;
  /** Higher = processed first */
  priority: number;

  /** Current attempt count */
  attempts: number;
  /** Max before marking failed */
  maxAttempts: number;
  /** Ms before task times out (0 = no timeout) */
  timeout: number;

  /** Input for this activity execution */
  input: Record<string, unknown>;
  /** Output from activity (merged into workflow state) */
  result?: Record<string, unknown>;

  /** Unix timestamp ms */
  createdAt: number;
  /** Don't run before this time (for backoff) */
  scheduledFor?: number;
  /** When current attempt began */
  startedAt?: number;
  /** When last attempt finished */
  lastAttemptAt?: number;
  /** When completed */
  completedAt?: number;

  /** Last error message */
  error?: string;
  /** Last error stack trace */
  errorStack?: string;
}

// ============================================================================
// Dead Letter Record
// ============================================================================

/**
 * When an activity permanently fails, it's moved to the dead letter queue.
 */
export interface DeadLetterRecord {
  /** UUID */
  id: string;
  /** Original workflow execution */
  runId: string;
  /** Failed activity task */
  taskId: string;
  activityName: string;
  workflowName: string;
  /** Activity input at time of failure */
  input: Record<string, unknown>;
  /** Final error message */
  error: string;
  errorStack?: string;
  /** How many attempts were made */
  attempts: number;
  /** Timestamp of final failure */
  failedAt: number;
  /** Has this been reviewed/handled? */
  acknowledged: boolean;
}

// ============================================================================
// Activity Definition Types
// ============================================================================

/**
 * Runtime context available to activities during execution.
 */
export interface RuntimeContext {
  /** Is network available */
  isConnected: boolean;
  /** Battery level 0-1 if available */
  batteryLevel?: number;
  /** App state */
  appState?: 'active' | 'background' | 'inactive';
  /** Allow for custom context values */
  [key: string]: unknown;
}

/**
 * Context passed to activity execute functions.
 */
export interface ActivityContext<TInput = Record<string, unknown>> extends RuntimeContext {
  /** Workflow execution ID */
  runId: string;
  /** This activity task's ID */
  taskId: string;
  /** Current attempt number (1-based) */
  attempt: number;
  /** Accumulated workflow state */
  input: TInput;
  /** Fires on cancel or timeout */
  signal: AbortSignal;
  /** Contextual logging */
  log: (...args: unknown[]) => void;
}

/**
 * Result of a runWhen condition check.
 */
export interface RunConditionResult {
  /** Whether the activity is ready to run */
  ready: boolean;
  /** Reason passed to onSkipped if not ready */
  reason?: string;
  /** Hint for when to check again */
  retryInMs?: number;
}

/**
 * A function that evaluates whether an activity should run.
 */
export type RunConditionFn = (ctx: RuntimeContext & { input: Record<string, unknown> }) => RunConditionResult;

/**
 * Retry policy configuration.
 */
export interface RetryPolicy {
  /** Max attempts before failing (default: 1) */
  maximumAttempts?: number;
  /** First retry delay in ms (default: 1000) */
  initialInterval?: number;
  /** Multiplier for each retry (default: 2) */
  backoffCoefficient?: number;
  /** Cap on retry delay (default: none) */
  maximumInterval?: number;
}

/**
 * Activity lifecycle callbacks.
 */
export interface ActivityCallbacks<TInput = Record<string, unknown>, TOutput = Record<string, unknown>> {
  onStart?: (taskId: string, input: TInput) => Promise<void>;
  onSuccess?: (taskId: string, input: TInput, result: TOutput) => Promise<void>;
  onFailure?: (taskId: string, input: TInput, error: Error, attempt: number) => Promise<void>;
  /** Called when activity permanently fails (exhausts retries) */
  onFailed?: (taskId: string, input: TInput, error: Error) => Promise<void>;
  onSkipped?: (taskId: string, input: TInput, reason: string) => Promise<void>;
}

/**
 * Configuration options for an activity.
 */
export interface ActivityOptions<TInput = Record<string, unknown>, TOutput = Record<string, unknown>>
  extends ActivityCallbacks<TInput, TOutput> {
  /** Ms before activity times out (default: 25000) */
  startToCloseTimeout?: number;
  /** Retry policy */
  retry?: RetryPolicy;
  /** Higher = processed first (default: 0) */
  priority?: number;
  /** Conditional execution */
  runWhen?: RunConditionFn;
}

/**
 * An activity definition - a unit of work.
 */
export interface Activity<TInput = Record<string, unknown>, TOutput = Record<string, unknown>> {
  name: string;
  execute: (ctx: ActivityContext<TInput>) => Promise<TOutput>;
  options?: ActivityOptions<TInput, TOutput>;
}

/**
 * Type alias for Activity with any generic parameters.
 * Used when storing activities in arrays where the specific types don't matter.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyActivity = Activity<any, any>;

// ============================================================================
// Workflow Definition Types
// ============================================================================

/**
 * Workflow lifecycle callbacks.
 */
export interface WorkflowCallbacks {
  onComplete?: (runId: string, finalState: Record<string, unknown>) => Promise<void>;
  onFailed?: (runId: string, state: Record<string, unknown>, error: Error) => Promise<void>;
  onCancelled?: (runId: string, state: Record<string, unknown>) => Promise<void>;
}

/**
 * A workflow definition - a blueprint for a business process.
 * TInput is used for type-checking workflow input at start time.
 */
export interface Workflow<TInput = Record<string, unknown>> extends WorkflowCallbacks {
  name: string;
  activities: AnyActivity[];
  /** @internal Type brand for input type inference */
  readonly _inputType?: TInput;
}

// ============================================================================
// Engine Configuration Types
// ============================================================================

/**
 * Options for starting a workflow execution.
 */
export interface StartWorkflowOptions<TInput = Record<string, unknown>> {
  input: TInput;
  /** Optional deduplication key */
  uniqueKey?: string;
  /** How to handle uniqueness conflicts */
  onConflict?: 'throw' | 'ignore';
}

/**
 * Options for running the engine tick loop.
 */
export interface TickOptions {
  /** Max time to run in ms (for background mode) */
  lifespan?: number;
}

/**
 * Logger interface for engine observability.
 */
export interface Logger {
  debug: (msg: string, meta?: Record<string, unknown>) => void;
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * Engine event types for observability.
 */
export type EngineEventType =
  | 'execution:started'
  | 'execution:completed'
  | 'execution:failed'
  | 'execution:cancelled'
  | 'activity:started'
  | 'activity:completed'
  | 'activity:failed'
  | 'activity:skipped'
  | 'deadletter:added';

export interface EngineEvent {
  type: EngineEventType;
  timestamp: number;
  runId?: string;
  taskId?: string;
  workflowName?: string;
  activityName?: string;
  error?: string;
  [key: string]: unknown;
}

/**
 * Cleanup configuration.
 */
export interface CleanupConfig {
  /** Run cleanup on engine start */
  onStart?: boolean;
  /** Purge completed executions older than this (ms) */
  completedExecutionRetention?: number;
  /** Purge acknowledged dead letters older than this (ms) */
  deadLetterRetention?: number;
  /** Callbacks */
  onExecutionPurged?: (execution: WorkflowExecution) => Promise<void>;
  onDeadLetterPurged?: (record: DeadLetterRecord) => Promise<void>;
}

/**
 * Engine configuration.
 */
export interface WorkflowEngineConfig {
  /** Storage adapter */
  storage: Storage;
  /** Clock for time operations */
  clock: Clock;
  /** Scheduler for tick timing */
  scheduler: Scheduler;
  /** Environment for runtime context */
  environment: Environment;
  /** Logger for observability */
  logger?: Logger;
  /** Event handler for observability */
  onEvent?: (event: EngineEvent) => void;
  /** Cleanup configuration */
  cleanup?: CleanupConfig;
}

// ============================================================================
// Abstract Interfaces (to be implemented by adapters)
// ============================================================================

/**
 * Clock interface - abstracts time for testability.
 */
export interface Clock {
  /** Get current time in ms */
  now(): number;
}

/**
 * Scheduler interface - abstracts timing/ticks for testability.
 */
export interface Scheduler {
  /** Schedule a callback to run after delay ms */
  setTimeout(callback: () => void, delay: number): unknown;
  /** Cancel a scheduled callback */
  clearTimeout(handle: unknown): void;
  /** Sleep for delay ms */
  sleep(delay: number): Promise<void>;
}

/**
 * Environment interface - provides runtime context for runWhen conditions.
 */
export interface Environment {
  /** Check if network is available */
  isNetworkAvailable(): boolean;
  /** Get battery state */
  getBatteryLevel(): number | undefined;
  /** Check if low power mode is enabled */
  isLowPowerMode(): boolean;
  /** Get app state */
  getAppState(): 'active' | 'background' | 'inactive';
  /** Get full runtime context */
  getRuntimeContext(): RuntimeContext;
}

/**
 * Storage change event for reactivity.
 */
export interface StorageChange {
  type: 'execution' | 'task' | 'deadletter';
  operation: 'create' | 'update' | 'delete';
  id: string;
}

/**
 * Storage adapter interface.
 */
export interface Storage {
  // Workflow Executions
  saveExecution(execution: WorkflowExecution): Promise<void>;
  getExecution(runId: string): Promise<WorkflowExecution | null>;
  getExecutionsByStatus(status: WorkflowExecutionStatus): Promise<WorkflowExecution[]>;
  deleteExecution(runId: string): Promise<void>;

  // Uniqueness
  setUniqueKey(workflowName: string, key: string, runId: string): Promise<boolean>;
  getUniqueKey(workflowName: string, key: string): Promise<string | null>;
  deleteUniqueKey(workflowName: string, key: string): Promise<void>;

  // Activity Tasks
  saveActivityTask(task: ActivityTask): Promise<void>;
  getActivityTask(taskId: string): Promise<ActivityTask | null>;
  getActivityTasksForExecution(runId: string): Promise<ActivityTask[]>;
  getActivityTasksByStatus(status: ActivityTaskStatus): Promise<ActivityTask[]>;
  deleteActivityTask(taskId: string): Promise<void>;
  deleteActivityTasksForExecution(runId: string): Promise<void>;

  // Queue Operations
  getPendingActivityTasks(options?: { limit?: number; now?: number }): Promise<ActivityTask[]>;
  claimActivityTask(taskId: string, now: number): Promise<ActivityTask | null>;

  // Dead Letter Queue
  saveDeadLetter(record: DeadLetterRecord): Promise<void>;
  getDeadLetters(): Promise<DeadLetterRecord[]>;
  getUnacknowledgedDeadLetters(): Promise<DeadLetterRecord[]>;
  acknowledgeDeadLetter(id: string): Promise<void>;
  deleteDeadLetter(id: string): Promise<void>;

  // Atomicity
  /**
   * Run multiple storage operations atomically: either every write inside
   * fn commits, or none do. Implementations must support nested calls by
   * joining the outer transaction.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;

  // Maintenance
  purgeExecutions(options: { olderThanMs: number; statuses: WorkflowExecutionStatus[]; now: number }): Promise<number>;
  purgeDeadLetters(options: { olderThanMs: number; acknowledgedOnly?: boolean; now: number }): Promise<number>;

  // Reactivity (optional)
  subscribe?(callback: (change: StorageChange) => void): () => void;
}

// ============================================================================
// Errors
// ============================================================================

/**
 * Error thrown when attempting to start a workflow with a uniqueKey
 * that already has an active execution.
 */
export class UniqueConstraintError extends Error {
  constructor(
    public workflowName: string,
    public uniqueKey: string,
    public existingRunId: string
  ) {
    super(`Workflow '${workflowName}' with uniqueKey '${uniqueKey}' already has active execution: ${existingRunId}`);
    this.name = 'UniqueConstraintError';
  }
}

/**
 * Error thrown when a workflow is not registered.
 */
export class WorkflowNotFoundError extends Error {
  constructor(public workflowName: string) {
    super(`Workflow '${workflowName}' is not registered`);
    this.name = 'WorkflowNotFoundError';
  }
}

/**
 * Error thrown when an execution is not found.
 */
export class ExecutionNotFoundError extends Error {
  constructor(public runId: string) {
    super(`Execution '${runId}' not found`);
    this.name = 'ExecutionNotFoundError';
  }
}

/**
 * Error thrown when an activity times out.
 */
export class ActivityTimeoutError extends Error {
  constructor(public taskId: string, public timeout: number) {
    super(`Activity '${taskId}' timed out after ${timeout}ms`);
    this.name = 'ActivityTimeoutError';
  }
}
