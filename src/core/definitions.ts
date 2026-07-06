/**
 * Helper functions for defining workflows and activities.
 */

import { Activity, AnyActivity, ActivityOptions, Workflow, WorkflowCallbacks, ActivityContext } from './types';

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
  /** @internal Type brand for input type inference */
  readonly _inputType?: TInput;
}

/**
 * Define a workflow with type safety.
 */
export function defineWorkflow<TInput = Record<string, unknown>>(
  options: DefineWorkflowOptions<TInput>
): Workflow<TInput> {
  const { name, activities, version, onComplete, onFailed, onCancelled } = options;

  if (activities.length === 0) {
    throw new Error(`Workflow '${name}' must have at least one activity`);
  }

  return {
    name,
    activities,
    version,
    onComplete,
    onFailed,
    onCancelled,
  };
}
