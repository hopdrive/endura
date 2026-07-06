/**
 * L4 — compile-time assertions for typed step-to-step chaining and the
 * typed useWorkflowStarter hook.
 *
 * This file is type-checked by `npm run typecheck` (tsconfig.typecheck.json)
 * and never executed. Each `@ts-expect-error` line asserts that the
 * adjacent misuse fails to compile — if the constraint regresses, tsc
 * reports the directive as unused and the typecheck gate fails.
 */

import { chain } from '../../src/core/chain';
import { defineActivity, defineWorkflow } from '../../src/core/definitions';
import { useWorkflowStarter } from '../../src/react/hooks';
import { WorkflowEngine } from '../../src/core/engine';

const fetchUser = defineActivity<{ userId: string }, { profileName: string }>({
  name: 'fetch-user',
  execute: async ctx => ({ profileName: ctx.input.userId }),
});

const greet = defineActivity<{ profileName: string }, { greeting: string }>({
  name: 'greet',
  execute: async ctx => ({ greeting: ctx.input.profileName }),
});

const needsCount = defineActivity<{ count: number }, { doubled: number }>({
  name: 'needs-count',
  execute: async ctx => ({ doubled: ctx.input.count * 2 }),
});

const untyped = defineActivity({
  name: 'untyped',
  execute: async () => ({ anything: true }),
});

// A valid chain compiles: each step's input is satisfied by the
// workflow input merged with all prior outputs.
export const validChain = chain<{ userId: string }>().step(fetchUser).step(greet);

// Untyped activities (Record<string, unknown> input) always chain.
export const mixedChain = chain<{ userId: string }>().step(untyped).step(fetchUser);

export const validWorkflow = defineWorkflow<{ userId: string }>({
  name: 'valid',
  activities: validChain.activities,
});

// @ts-expect-error — greet requires profileName, which the workflow input alone does not provide
export const missingUpstream = chain<{ userId: string }>().step(greet);

// @ts-expect-error — count is never produced by the workflow input or any prior step
export const neverProduced = chain<{ userId: string }>().step(fetchUser).step(needsCount);

// useWorkflowStarter is typed end-to-end: the workflow and the input
// must agree with the hook's type parameter.
declare const engine: WorkflowEngine;

export function TypedStarter(): null {
  const starter = useWorkflowStarter<{ userId: string }>(engine);

  void starter.startWorkflow(validWorkflow, { input: { userId: 'u1' } });

  const otherWorkflow = defineWorkflow<{ orderId: number }>({
    name: 'other',
    activities: [untyped],
  });

  // @ts-expect-error — workflow expects { orderId: number }, hook is typed for { userId: string }
  void starter.startWorkflow(otherWorkflow, { input: { userId: 'u1' } });

  // @ts-expect-error — input does not match the hook's type parameter
  void starter.startWorkflow(validWorkflow, { input: { wrong: true } });

  return null;
}
