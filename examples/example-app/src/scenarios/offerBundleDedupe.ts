/**
 * Scenario 7 — Offer Bundle Per-Entity Dedupe (review §Scenario 7).
 *
 * Models offerBundleProcess.pipeline: start() awaits a per-offer
 * hasPendingEventMatching(offerId) guard — a NEW enqueue for an offer
 * with one already pending is DROPPED and the pending one keeps its
 * place; different offers proceed independently; completion frees the
 * key without destroying history (extraction: pipelines-batch1.md
 * §offerBundleProcess, test-suite-behaviors.md §Offer pipelines).
 *
 * Endura mapping: uniqueKey `offer-<id>` with onConflict:'ignore' —
 * the duplicate start returns the EXISTING running execution (same
 * drop-the-new-keep-the-old semantics), the status-aware unique index
 * is the race arbiter, and a completed key is reusable with prior
 * history preserved.
 */

import { defineActivity, defineWorkflow, Workflow, UniqueConstraintError } from 'endura';
import { ParityScenario, ParityContext } from '../harness/runner';
import { ParityClient } from '../harness/expoPlatform';
import { tickUntil, execOf } from './util';

/** Per-run mutable state; reset at the top of run(), survives restarts. */
const state = {
  stageRuns: {} as Record<string, number>,
};

function buildWorkflow(ctx: ParityContext<ParityClient>): Workflow {
  const bundleProcess = defineActivity({
    name: 'bundleProcess',
    retry: { maximumAttempts: 10, initialInterval: 300 },
    runWhen: rc => (rc.isConnected ? { ready: true } : { ready: false, reason: 'offline' }),
    execute: async a => {
      const offerId = String(a.input.offerId);
      state.stageRuns[offerId] = (state.stageRuns[offerId] ?? 0) + 1;
      await ctx.server.call({
        endpoint: 'offer/bundle',
        effect: { kind: 'offer-bundle-processed', key: offerId },
      });
      return { processed: true };
    },
  });

  return defineWorkflow({
    name: 'offer.bundleprocess.parity',
    activities: [bundleProcess],
  });
}

export const offerBundleDedupe: ParityScenario<ParityClient> = {
  scenarioId: 'offer-bundle-dedupe',
  name: 'Offer bundle per-entity dedupe (uniqueKey by offerId)',
  category: 7,
  engineMode: 'manual',

  register(client, ctx) {
    client.registerWorkflow(buildWorkflow(ctx));
  },

  async run(ctx, t) {
    state.stageRuns = {};

    const enqueueOffer = (offerId: number, onConflict?: 'throw' | 'ignore') => {
      const workflow = ctx.client.engine.getWorkflow('offer.bundleprocess.parity')!;
      return ctx.client.engine.start(workflow, {
        input: { offerId },
        uniqueKey: `offer-${offerId}`,
        onConflict,
        metadata: { offerId },
      });
    };
    const runningForOffer = async (offerId: number) => {
      const running = await ctx.client.getExecutions({ workflowName: 'offer.bundleprocess.parity', status: 'running' });
      return running.filter(e => (e.metadata as Record<string, unknown>)?.offerId === offerId);
    };

    let firstRunId = '';
    await t.step('two enqueues for the same offerId while one is pending → one active workflow', async () => {
      const first = await enqueueOffer(901);
      firstRunId = first.runId;
      const second = await enqueueOffer(901, 'ignore');
      t.log(`dedupe decision: enqueue #2 for offer 901 joined pending run ${second.runId} (new enqueue dropped, pending kept)`);
      t.assertEqual('duplicate enqueue returned the pending execution', firstRunId, second.runId);
      t.assertEqual('one active workflow for offer 901', 1, (await runningForOffer(901)).length);

      // The default (throw) surfaces the conflict explicitly for callers
      // that want the signal rather than the join.
      let threw = false;
      try {
        await enqueueOffer(901);
      } catch (err) {
        threw = err instanceof UniqueConstraintError;
      }
      t.assertEqual('onConflict:throw signals the duplicate', true, threw);
    });

    await t.step('enqueues for different offerId values both proceed', async () => {
      const other = await enqueueOffer(902);
      t.assertEqual('offer 902 got its own execution', 1, (await runningForOffer(902)).length);
      await tickUntil(ctx, 'both offers processed', async () => {
        const a = await execOf(ctx, firstRunId);
        const b = await execOf(ctx, other.runId);
        return a.status === 'completed' && b.status === 'completed';
      });
      t.assertEqual('each offer processed exactly once', { p901: 1, p902: 1 }, {
        p901: ctx.server.effectCount('offer-bundle-processed', '901'),
        p902: ctx.server.effectCount('offer-bundle-processed', '902'),
      });
    });

    await t.step('reusing an offerId after completion does not destroy prior history', async () => {
      const rerun = await enqueueOffer(901);
      t.assert('fresh execution under the reused key', rerun.runId !== firstRunId, 'new runId', { rerun: rerun.runId, first: firstRunId });
      await tickUntil(ctx, 'rerun completion', async () => (await execOf(ctx, rerun.runId)).status === 'completed');
      const completed = await ctx.client.getExecutions({ workflowName: 'offer.bundleprocess.parity', status: 'completed' });
      const for901 = completed.filter(e => (e.metadata as Record<string, unknown>)?.offerId === 901);
      t.assertEqual('both offer-901 executions preserved in history', 2, for901.length);
      t.assertEqual('re-process after completion is a new business event (no pending to dedupe against)', 2,
        ctx.server.effectCount('offer-bundle-processed', '901'));
    });

    await t.step('a racing duplicate enqueue cannot create two active workflows', async () => {
      const [a, b] = await Promise.all([enqueueOffer(903, 'ignore'), enqueueOffer(903, 'ignore')]);
      t.assertEqual('racing starts converged on one execution', a.runId, b.runId);
      t.assertEqual('exactly one active workflow for offer 903', 1, (await runningForOffer(903)).length);
      await tickUntil(ctx, 'offer 903 completion', async () => (await execOf(ctx, a.runId)).status === 'completed');
      t.assertEqual('offer 903 processed exactly once', 1, ctx.server.effectCount('offer-bundle-processed', '903'));
      t.assertEqual('bundle stage ran once for 903', 1, state.stageRuns['903'] ?? 0);
    });
  },
};
