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

  // Dispatch types
  ActivityDispatcher,
  ActivityDispatchRequest,

  // Engine types
  StartWorkflowOptions,
  ExecutionQuery,
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

// Typed step chaining
export { chain, StepChain } from './chain';

// Conditions
export { conditions, always, whenConnected, whenDisconnected, afterDelay, all, any, not } from './conditions';

// Engine
export { WorkflowEngine } from './engine';

// Default runtime implementations for Node/web consumers. Test doubles
// (MockClock, MockScheduler, MockEnvironment) moved to 'endura/testing'.
export { RealClock, RealScheduler, StubEnvironment } from './defaults';

// Utils
export {
  generateId,
  setIdGenerator,
  calculateBackoffDelay,
  JitterMode,
  mergeState,
  approxJsonBytes,
  createAbortController,
  silentLogger,
  consoleLogger,
} from './utils';
