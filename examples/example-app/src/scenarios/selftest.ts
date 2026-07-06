/**
 * Scenario 0 — harness self-test.
 *
 * Not a parity scenario: proves the framework itself works on-device
 * before any pipeline scenario runs. Exercises the fake server's
 * idempotency guard, a two-stage workflow with payload accumulation,
 * connectivity flip via the Environment abstraction, and restart
 * simulation.
 */

import { defineActivity, defineWorkflow, WorkflowExecution } from 'endura';
import { ParityScenario, ParityContext } from '../harness/runner';
import { ParityClient } from '../harness/expoPlatform';

async function waitFor(
  ctx: ParityContext<ParityClient>,
  what: string,
  condition: () => Promise<boolean>,
  timeoutMs = 20000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await ctx.sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export const selfTest: ParityScenario<ParityClient> = {
  scenarioId: 'selftest',
  name: 'Harness self-test',
  category: 0,

  register(client, ctx) {
    const stage1 = defineActivity({
      name: 'stage1',
      retry: { maximumAttempts: 3, initialInterval: 500 },
      execute: async ctxA => {
        await ctx.server.call({
          endpoint: 'selftest/stage1',
          effect: { kind: 'stage1-done', key: String(ctxA.input.entityId) },
          idempotencyKey: `stage1-${String(ctxA.input.entityId)}`,
        });
        return { stage1Payload: 'accumulated' };
      },
    });
    const stage2 = defineActivity({
      name: 'stage2',
      retry: { maximumAttempts: 3, initialInterval: 500 },
      execute: async ctxA => {
        if (ctxA.input.stage1Payload !== 'accumulated') {
          throw new Error('stage2 did not receive stage1 payload');
        }
        await ctx.server.call({
          endpoint: 'selftest/stage2',
          effect: { kind: 'stage2-done', key: String(ctxA.input.entityId) },
          idempotencyKey: `stage2-${String(ctxA.input.entityId)}`,
        });
        return { stage2Payload: true };
      },
    });
    client.registerWorkflow(
      defineWorkflow({ name: 'selftest-two-stage', activities: [stage1, stage2] })
    );
  },

  async run(ctx, t) {
    let runId = '';

    await t.step('start workflow while ONLINE and complete both stages', async () => {
      const workflow = ctx.client.engine.getWorkflow('selftest-two-stage')!;
      const execution = await ctx.client.engine.start(workflow, { input: { entityId: 'E1' } });
      runId = execution.runId;
      await waitFor(ctx, 'completion', async () => {
        const current = await ctx.client.getExecution(runId);
        return current?.status === 'completed';
      });
    });

    await t.step('verify payload accumulation and single business effects', async () => {
      const final = (await ctx.client.getExecution(runId)) as WorkflowExecution;
      t.assertEqual('final state carries both stage payloads', true, final.state.stage2Payload === true);
      t.assert('exactly one stage1 effect', ctx.server.effectCount('stage1-done', 'E1') === 1, 1, ctx.server.effectCount('stage1-done', 'E1'));
      t.assert('exactly one stage2 effect', ctx.server.effectCount('stage2-done', 'E1') === 1, 1, ctx.server.effectCount('stage2-done', 'E1'));
    });

    await t.step('duplicate idempotency key absorbs without second effect', async () => {
      const result = await ctx.server.call({
        endpoint: 'selftest/stage1',
        effect: { kind: 'stage1-done', key: 'E1' },
        idempotencyKey: 'stage1-E1',
      });
      t.assert('duplicate flagged', result.duplicate === true, true, result.duplicate);
      t.assert('still exactly one stage1 effect', ctx.server.effectCount('stage1-done', 'E1') === 1, 1, ctx.server.effectCount('stage1-done', 'E1'));
    });

    await t.step('offline call rejects; online restores', async () => {
      ctx.setOnline(false);
      let rejected = false;
      try {
        await ctx.server.call({ endpoint: 'selftest/offline-probe', effect: { kind: 'probe', key: 'x' } });
      } catch {
        rejected = true;
      }
      t.assert('offline call rejected', rejected, true, rejected);
      ctx.setOnline(true);
    });

    await t.step('execution survives simulated app restart', async () => {
      await ctx.restart();
      const persisted = await ctx.client.getExecution(runId);
      t.assertEqual('run still completed after restart', 'completed', persisted?.status);
    });
  },
};
