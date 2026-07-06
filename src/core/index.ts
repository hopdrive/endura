/**
 * Core workflow engine module.
 * Platform-agnostic - no React Native or Expo imports.
 */

// Types
export {
  // Status types
  WorkflowExecutionStatus,
  ActivityTaskStatus,

  // Data models
  WorkflowExecution,
  ActivityTask,
  TaskErrorHistoryEntry,
  DeadLetterRecord,

  // Activity types
  RuntimeContext,
  ActivityContext,
  RunConditionResult,
  RunConditionFn,
  RetryPolicy,
  ActivityCallbacks,
  ActivityOptions,
  Activity,
  AnyActivity,

  // Workflow types
  WorkflowCallbacks,
  Workflow,

  // Engine types
  StartWorkflowOptions,
  TickOptions,
  Logger,
  EngineEventType,
  EngineEvent,
  CleanupConfig,
  WorkflowEngineConfig,

  // Interfaces
  Clock,
  Scheduler,
  Environment,
  Storage,
  StorageChange,

  // Errors
  UniqueConstraintError,
  WorkflowNotFoundError,
  ExecutionNotFoundError,
  ActivityTimeoutError,
  NonRetryableError,
  isNonRetryableError,
} from './types';

// Definitions
export { defineActivity, defineWorkflow, DefineActivityOptions, DefineWorkflowOptions } from './definitions';

// Conditions
export { conditions, always, whenConnected, whenDisconnected, afterDelay, all, any, not } from './conditions';

// Engine
export { WorkflowEngine } from './engine';

// Mocks
export {
  MockClock,
  MockScheduler,
  MockEnvironment,
  MockEnvironmentState,
  RealClock,
  RealScheduler,
  StubEnvironment,
} from './mocks';

// Utils
export {
  generateId,
  setIdGenerator,
  calculateBackoffDelay,
  mergeState,
  createAbortController,
  silentLogger,
  consoleLogger,
} from './utils';
