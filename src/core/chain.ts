/**
 * Typed step-to-step chaining for workflow activities.
 *
 * `chain<TInput>()` builds an activity list where each step's declared
 * input must be satisfied by the workflow input merged with the outputs
 * of every preceding step — the same shallow accumulation the engine
 * performs at runtime. An incompatible chain fails to compile instead of
 * surfacing on-device as a missing state key.
 *
 * @example
 * ```typescript
 * const activities = chain<{ userId: string }>()
 *   .step(fetchUser)   // Activity<{ userId: string }, { profile: Profile }>
 *   .step(greetUser)   // Activity<{ profile: Profile }, { greeting: string }>
 *   .activities;
 *
 * const workflow = defineWorkflow<{ userId: string }>({ name: 'greet', activities });
 * ```
 */

import { Activity, AnyActivity } from './types';

/**
 * An immutable builder tracking the accumulated workflow state type.
 * TState is the workflow input intersected with every prior step's output.
 */
export interface StepChain<TState extends Record<string, unknown>> {
  /** Activities accumulated so far, in execution order. */
  readonly activities: AnyActivity[];
  /**
   * Append an activity whose declared input is satisfied by the
   * accumulated state. Returns a new chain whose state includes the
   * step's output; the receiver is unchanged.
   */
  step<TOutput extends Record<string, unknown>>(
    activity: Activity<TState, TOutput>
  ): StepChain<TState & TOutput>;
}

/**
 * Start a typed activity chain from the workflow's input type.
 */
export function chain<TInput extends Record<string, unknown> = Record<string, unknown>>(): StepChain<TInput> {
  const make = <TState extends Record<string, unknown>>(activities: AnyActivity[]): StepChain<TState> => ({
    activities,
    step: <TOutput extends Record<string, unknown>>(activity: Activity<TState, TOutput>) =>
      make<TState & TOutput>([...activities, activity as AnyActivity]),
  });

  return make<TInput>([]);
}
