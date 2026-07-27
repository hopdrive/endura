/**
 * Test Utilities for Workflow Engine
 *
 * This module provides shared utilities for testing the workflow engine.
 * All test files should import from here for consistent test setup.
 *
 * ## Quick Start
 *
 * ```typescript
 * import { createTestContext, runToCompletion } from '../../../tests/utils/testHelpers';
 *
 * describe('MyTest', () => {
 *   let ctx: TestContext;
 *
 *   beforeEach(async () => {
 *     ctx = await createTestContext();
 *   });
 *
 *   afterEach(() => {
 *     ctx.engine.stop();
 *   });
 *
 *   it('should work', async () => {
 *     const execution = await ctx.engine.start(myWorkflow, { input: {} });
 *     await runToCompletion(ctx, execution.runId);
 *     // assertions...
 *   });
 * });
 * ```
 */

import { WorkflowEngine } from '../../src/core/engine';
import { WorkflowExecution, ActivityContext } from '../../src/core/types';
import { InMemoryStorage } from '../../src/storage/memory';
import { MockClock, MockScheduler, MockEnvironment } from '../../src/core/mocks';
import { defineActivity } from '../../src/core/definitions';
import { createLoopbackDispatcher } from '../../src/workers/loopback';

// =============================================================================
// Test Context
// =============================================================================

/**
 * A test context containing all dependencies needed for testing.
 * Using a context object avoids repetitive setup and ensures
 * consistent dependency injection across tests.
 */
export interface TestContext {
  /** In-memory storage for test isolation */
  storage: InMemoryStorage;
  /** Mock clock for deterministic time control */
  clock: MockClock;
  /** Mock scheduler for testing scheduled tasks */
  scheduler: MockScheduler;
  /** Mock environment for connectivity/battery simulation */
  environment: MockEnvironment;
  /** The workflow engine instance */
  engine: WorkflowEngine;
}

/**
 * Options for creating a test context.
 */
export interface TestContextOptions {
  /** Initial clock time (default: 1000000) */
  startTime?: number;
  /** Initial connectivity state (default: true) */
  isConnected?: boolean;
  /** Initial battery level 0-1 (default: 1.0) */
  batteryLevel?: number;
  /** Custom event handler for engine events */
  onEvent?: (event: unknown) => void;
}

/**
 * Creates a complete test context with all dependencies.
 *
 * @example
 * ```typescript
 * const ctx = await createTestContext({ isConnected: false });
 * // Engine starts with no network connectivity
 * ```
 */
export async function createTestContext(
  options?: TestContextOptions
): Promise<TestContext> {
  const storage = new InMemoryStorage();
  const clock = new MockClock(options?.startTime ?? 1000000);
  const scheduler = new MockScheduler(clock);
  const environment = new MockEnvironment({
    isConnected: options?.isConnected ?? true,
    batteryLevel: options?.batteryLevel ?? 1.0,
  });

  const engine = await WorkflowEngine.create({
    dispatcher: createLoopbackDispatcher(),
    storage,
    clock,
    scheduler,
    environment,
    onEvent: options?.onEvent,
    // Pin backoff jitter to its upper bound so retry timing stays exact
    // and deterministic in tests.
    random: () => 1,
  });

  return { storage, clock, scheduler, environment, engine };
}

// =============================================================================
// Execution Helpers
// =============================================================================

/**
 * Options for running a workflow to completion.
 */
export interface RunOptions {
  /** Maximum engine ticks before giving up (default: 500) */
  maxTicks?: number;
  /** If true, advances mock clock each tick to handle gated activities */
  advanceClock?: boolean;
  /** Mock-clock advance per tick when advanceClock is set (default: 35000, past the 30s skip-reschedule delay) */
  advanceMs?: number;
}

/**
 * Runs the engine until a workflow completes, fails, or is cancelled.
 *
 * Deterministic: drives the engine with a bounded tick loop and the
 * injected MockClock only — no wall-clock reads, no real timers — so it
 * cannot flake under CI load and works under vitest fake timers.
 *
 * @param ctx - The test context
 * @param runId - The workflow execution ID
 * @param options - Execution options
 * @returns The final execution state
 * @throws If the workflow doesn't settle within the tick budget
 *
 * @example
 * ```typescript
 * const execution = await ctx.engine.start(workflow, { input: {} });
 * const result = await runToCompletion(ctx, execution.runId);
 * expect(result.status).toBe('completed');
 * ```
 */
export async function runToCompletion(
  ctx: TestContext,
  runId: string,
  options?: RunOptions
): Promise<WorkflowExecution> {
  const { maxTicks = 500, advanceClock = false, advanceMs = 35000 } = options ?? {};

  for (let tick = 0; tick < maxTicks; tick++) {
    // Advance mock clock if needed (for gated/backoff-delayed activities)
    if (advanceClock) {
      ctx.clock.advance(advanceMs);
    }

    await ctx.engine.tick();
    const execution = await ctx.engine.getExecution(runId);

    if (!execution) {
      throw new Error(`Execution ${runId} not found`);
    }

    if (execution.status !== 'running') {
      return execution;
    }
  }

  throw new Error(`Workflow ${runId} did not settle within ${maxTicks} ticks`);
}

// =============================================================================
// Activity Factories
// =============================================================================

/**
 * Options for creating a test activity.
 */
export interface TestActivityOptions {
  /** Custom execute function */
  execute?: (ctx: ActivityContext) => Promise<Record<string, unknown>>;
  /** If true, activity always throws */
  shouldFail?: boolean;
  /** Fail until this attempt number (1-indexed), then succeed */
  failUntilAttempt?: number;
  /** Delay execution by this many ms */
  delay?: number;
  /** Activity timeout in ms */
  startToCloseTimeout?: number;
  /** Retry configuration */
  retry?: {
    maximumAttempts?: number;
    initialInterval?: number;
    backoffCoefficient?: number;
    maximumInterval?: number;
  };
}

/**
 * Creates a simple test activity with configurable behavior.
 *
 * @param name - Activity name
 * @param options - Activity options
 * @returns A configured activity definition
 *
 * @example
 * ```typescript
 * // Simple activity
 * const simple = createTestActivity('process');
 *
 * // Activity that fails twice then succeeds
 * const flaky = createTestActivity('upload', {
 *   failUntilAttempt: 3,
 *   retry: { maximumAttempts: 5 }
 * });
 *
 * // Activity with custom logic
 * const custom = createTestActivity('transform', {
 *   execute: async (ctx) => ({ result: ctx.input.value * 2 })
 * });
 * ```
 */
export function createTestActivity(
  name: string,
  options?: TestActivityOptions
) {
  const {
    execute,
    shouldFail = false,
    failUntilAttempt = 0,
    delay = 0,
    startToCloseTimeout,
    retry,
  } = options ?? {};

  return defineActivity({
    name,
    startToCloseTimeout,
    retry,
    execute: async (ctx) => {
      if (delay) await sleep(delay);

      if (shouldFail) {
        throw new Error(`${name} intentionally failed`);
      }

      if (failUntilAttempt > 0 && ctx.attempt < failUntilAttempt) {
        throw new Error(`${name} failed on attempt ${ctx.attempt}`);
      }

      if (execute) {
        return execute(ctx);
      }

      return { [name]: 'done', attempt: ctx.attempt };
    },
  });
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Sleep for a specified duration of REAL time.
 *
 * Not for pacing the harness — runToCompletion is tick-driven. Use this
 * only inside activity bodies that simulate genuinely slow handlers
 * (timeout/cancellation tests race real promises).
 *
 * @param ms - Duration in milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
