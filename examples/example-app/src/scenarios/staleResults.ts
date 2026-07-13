/**
 * Scenario 11 — Stale Success and Stale Failure (review §Scenario 11).
 *
 * The timeout class the driver app guards with markEventAsFailed's
 * stale-failure check ("never downgrade a synced or stage-advanced
 * event" — THE core invariant, move-33055): a handler times out but
 * KEEPS RUNNING (timeouts never cancel the worker promise — load-
 * bearing RNQ parity), a retry advances the workflow, and the old
 * handler later resolves or throws.
 *
 * Endura mapping: the engine stamps attempts and discards late results
 * for non-current attempts / non-running executions ("Discarding late
 * success/failure..." debug logs, asserted via the harness log capture);
 * the fake server's commit-time idempotency absorbs the late server
 * write so no duplicate business effect lands either.
 */

import { defineActivity, defineWorkflow, Workflow } from 'endura';
import { ParityScenario, ParityContext } from '../harness/runner';
import { ParityClient } from '../harness/expoPlatform';
import { tickUntil, execOf } from './util';

/** Per-run mutable state; reset at the top of run(), survives restarts. */
const state = {
  stageRuns: {} as Record<string, number>,
  hangOnce: {} as Record<string, boolean>,
};

function buildWorkflow(ctx: ParityContext<ParityClient>): Workflow {
  const flakySync = defineActivity({
    name: 'flakySync',
    startToCloseTimeout: 800,
    retry: { maximumAttempts: 3, initialInterval: 300 },
    execute: async a => {
      const jobId = String(a.input.jobId);
      state.stageRuns[jobId] = (state.stageRuns[jobId] ?? 0) + 1;
      if (state.hangOnce[jobId]) {
        state.hangOnce[jobId] = false;
        // This attempt will outlive its 800ms timeout: the server call
        // hangs until the scenario releases or fails it.
        ctx.server.script('stale/sync', { kind: 'hung' });
      }
      await ctx.server.call({
        endpoint: 'stale/sync',
        effect: { kind: 'stale-synced', key: jobId },
        idempotencyKey: `stale-${jobId}`,
      });
      return { synced: true };
    },
  });

  return defineWorkflow({
    name: 'stale.results.parity',
    activities: [flakySync],
  });
}

export const staleResults: ParityScenario<ParityClient> = {
  scenarioId: 'stale-results',
  name: 'Stale success and stale failure (late results cannot corrupt)',
  category: 11,
  engineMode: 'manual',

  register(client, ctx) {
    client.registerWorkflow(buildWorkflow(ctx));
  },

  async run(ctx, t) {
    state.stageRuns = {};
    state.hangOnce = {};

    const startJob = (jobId: string) => {
      state.hangOnce[jobId] = true;
      const workflow = ctx.client.engine.getWorkflow('stale.results.parity')!;
      return ctx.client.engine.start(workflow, { input: { jobId }, metadata: { jobId } });
    };

    await t.step('a timed-out handler that later SUCCEEDS cannot overwrite newer execution state', async () => {
      const execution = await startJob('S1');
      // Attempt 1 hangs past its 800ms timeout; the engine schedules a
      // retry; attempt 2 succeeds and completes the workflow.
      await tickUntil(ctx, 'completion despite hung first attempt', async () => (await execOf(ctx, execution.runId)).status === 'completed', 45000);
      t.assert('workflow advanced via the retry', (state.stageRuns.S1 ?? 0) >= 2, '>= 2 attempts', state.stageRuns.S1);

      const updatedAtBefore = (await execOf(ctx, execution.runId)).updatedAt;
      ctx.server.releaseHung(); // the old handler finally resolves
      await ctx.sleep(400);
      await ctx.client.tick();

      const final = await execOf(ctx, execution.runId);
      t.assertEqual('execution still completed after the stale success', 'completed', final.status);
      t.assertEqual('execution row not rewritten by the stale result', updatedAtBefore, final.updatedAt);
      t.assertEqual('one business effect — late server write absorbed', 1, ctx.server.effectCount('stale-synced', 'S1'));
    });

    await t.step('a timed-out handler that later THROWS cannot downgrade a completed workflow', async () => {
      const execution = await startJob('S2');
      await tickUntil(ctx, 'completion despite hung first attempt', async () => (await execOf(ctx, execution.runId)).status === 'completed', 45000);

      ctx.server.failHung('socket finally died'); // the old handler now rejects
      await ctx.sleep(400);
      await ctx.client.tick();

      const final = await execOf(ctx, execution.runId);
      t.assertEqual('execution still completed after the stale failure', 'completed', final.status);
      t.assertEqual('stale failure did not dead-letter anything', 0, (await ctx.client.engine.getDeadLetters()).length);
      t.assertEqual('one business effect for S2', 1, ctx.server.effectCount('stale-synced', 'S2'));
    });

    await t.step('the discard is visible in engine logs', async () => {
      const discards = ctx.client.parityLogs.filter(line => /Discarding late/i.test(line));
      t.log(`discard log lines: ${JSON.stringify(discards.slice(-4))}`);
      t.assert('engine logged the ignored stale results', discards.length >= 1, '>= 1 discard log line', discards.length);
    });
  },
};
