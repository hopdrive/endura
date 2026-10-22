/**
 * Helper functions for defining workflows and activities.
 */

import { Activity, AnyActivity, ActivityOptions, Workflow, WorkflowCallbacks, WorkflowExpiry, ActivityContext } from './types';

/**
 * Options for defineActivity.
 */
export interface DefineActivityOptions<TInput = Record<string, unknown>, TOutput = Record<string, unknown>>
  extends ActivityOptions<TInput, TOutput> {
  name: string;
  execute: (ctx: ActivityContext<TInput>) => Promise<TOutput>;
}

/**
 * Define an activity with type safety.
 */
export function defineActivity<
  TInput = Record<string, unknown>,
  TOutput = Record<string, unknown>
>(options: DefineActivityOptions<TInput, TOutput>): Activity<TInput, TOutput> {
  const { name, execute, ...activityOptions } = options;

  return {
    name,
    execute,
    options: Object.keys(activityOptions).length > 0 ? activityOptions : undefined,
  };
}

/**
 * Options for defineWorkflow.
 * TInput is used for type-checking workflow input at start time.
 */
export interface DefineWorkflowOptions<TInput = Record<string, unknown>> extends WorkflowCallbacks {
  name: string;
  activities: AnyActivity[];
  /** Optional definition version (see Workflow.version) */
  version?: string;
  /** Optional expiry for work whose value decays (see Workflow.expiry) */
  expiry?: WorkflowExpiry;
  /** @internal Type brand for input type inference */
  readonly _inputType?: TInput;
}

/**
 * Define a workflow with type safety.
 */
export function defineWorkflow<TInput = Record<string, unknown>>(
  options: DefineWorkflowOptions<TInput>
): Workflow<TInput> {
  const { name, activities, version, expiry, onComplete, onFailed, onCancelled } = options;

  if (activities.length === 0) {
    throw new Error(`Workflow '${name}' must have at least one activity`);
  }
  assertValidExpiry(name, expiry);

  return {
    name,
    activities,
    version,
    ...(expiry ? { expiry } : {}),
    onComplete,
    onFailed,
    onCancelled,
  };
}

/**
 * Reject an expiry that would expire everything at once or nothing ever.
 * Shared by defineWorkflow and registerWorkflow, so a hand-written
 * Workflow literal gets the same check.
 */
export function assertValidExpiry(workflowName: string, expiry: WorkflowExpiry | undefined): void {
  if (expiry === undefined) return;
  if (!Number.isFinite(expiry.afterMs) || expiry.afterMs <= 0) {
    throw new Error(
      `Workflow '${workflowName}' has an invalid expiry.afterMs (${expiry.afterMs}); it must be a positive number of ms`
    );
  }
}
