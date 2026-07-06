/**
 * L4 — typed step-to-step chaining.
 *
 * Runtime behavior of the chain() builder. The compile-time guarantees
 * (a step whose input is not satisfied by the accumulated state fails to
 * build) are asserted in tests/types/l4-chaining.types.ts, which runs
 * under `npm run typecheck`.
 */

import { describe, it, expect } from 'vitest';
import { chain } from '../../../src/core/chain';
import { defineActivity, defineWorkflow } from '../../../src/core/definitions';
import { createTestContext, runToCompletion, TestContext } from '../../utils/testHelpers';

const fetchUser = defineActivity<{ userId: string }, { profileName: string }>({
  name: 'fetch-user',
  execute: async ctx => ({ profileName: `user-${ctx.input.userId}` }),
});

const greet = defineActivity<{ profileName: string }, { greeting: string }>({
  name: 'greet',
  execute: async ctx => ({ greeting: `hello ${ctx.input.profileName}` }),
});

describe('chain (L4)', () => {
  it('accumulates activities in step order', () => {
    const built = chain<{ userId: string }>().step(fetchUser).step(greet);

    expect(built.activities.map(a => a.name)).toEqual(['fetch-user', 'greet']);
    expect(built.activities[0]).toBe(fetchUser);
    expect(built.activities[1]).toBe(greet);
  });

  it('is immutable — each step returns a new chain', () => {
    const one = chain<{ userId: string }>().step(fetchUser);
    const two = one.step(greet);

    expect(one.activities).toHaveLength(1);
    expect(two.activities).toHaveLength(2);
  });

  it('produces activities the engine runs end-to-end with accumulated state', async () => {
    const ctx: TestContext = await createTestContext();
    try {
      const workflow = defineWorkflow<{ userId: string }>({
        name: 'chained-greeting',
        activities: chain<{ userId: string }>().step(fetchUser).step(greet).activities,
      });

      const execution = await ctx.engine.start(workflow, { input: { userId: 'u1' } });
      const final = await runToCompletion(ctx, execution.runId);

      expect(final.status).toBe('completed');
      expect(final.state).toEqual({
        userId: 'u1',
        profileName: 'user-u1',
        greeting: 'hello user-u1',
      });
    } finally {
      ctx.engine.stop();
    }
  });
});
