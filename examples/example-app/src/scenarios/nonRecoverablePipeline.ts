/**
 * Scenario 6 — Non-Recoverable Pipeline (review §Scenario 6).
 *
 * Models the photoReaper / sendAppDump pattern: fire-and-forget
 * operational work with `recoverable: false` — a failed run must never
 * reappear as driver-recoverable work; the next app launch simply fires
 * a fresh run (extraction: pipelines-batch1.md §photoReaper — "a failed
 * reap is never re-armed; next launch fires fresh").
 *
 * Endura has no definition-level recovery classification field (issue
 * P4-002), so the classification lives beside the workflow definition
 * in app code — a single NON_RECOVERABLE_WORKFLOWS set the recovery
 * sweep consults, the same shape as the driver app's recoverable flag.
 */

import { defineActivity, defineWorkflow, Workflow } from 'endura';
import { ParityScenario, ParityContext } from '../harness/runner';
import { ParityClient } from '../harness/expoPlatform';
import { tickUntil, execOf, recoverySweep } from './util';

/**
 * The classification, declared once next to the definition — the app's
 * single source of truth the recovery sweep consults.
 */
export const NON_RECOVERABLE_WORKFLOWS: ReadonlySet<string> = new Set(['appdump.parity']);

/** Per-run mutable state; reset at the top of run(), survives restarts. */
const state = {
  stageRuns: 0,
};

function buildWorkflow(ctx: ParityContext<ParityClient>): Workflow {
  const sendAppDump = defineActivity({
    name: 'sendAppDump',
    retry: { maximumAttempts: 2, initialInterval: 300 },
    runWhen: rc => (rc.isConnected ? { ready: true } : { ready: false, reason: 'offline' }),
    execute: async a => {
      state.stageRuns += 1;
      const dumpId = String(a.input.dumpId);
      await ctx.server.call({
        endpoint: 'ops/app-dump',
        effect: { kind: 'app-dump-sent', key: dumpId },
        idempotencyKey: `dump-${dumpId}`,
      });
      return { sent: true };
    },
  });

  return defineWorkflow({
    name: 'appdump.parity',
    activities: [sendAppDump],
  });
}

export const nonRecoverablePipeline: ParityScenario<ParityClient> = {
  scenarioId: 'non-recoverable',
  name: 'Non-recoverable pipeline (fail once, never re-armed)',
  category: 6,
  engineMode: 'manual',

  register(client, ctx) {
    client.registerWorkflow(buildWorkflow(ctx));
  },

  async run(ctx, t) {
    state.stageRuns = 0;

    const startDump = (dumpId: string) => {
      const workflow = ctx.client.engine.getWorkflow('appdump.parity')!;
      return ctx.client.engine.start(workflow, { input: { dumpId }, metadata: { dumpId } });
    };

    let failedRunId = '';
    await t.step('the workflow can fail', async () => {
      ctx.server.script('ops/app-dump', 'transient-failure', 'transient-failure');
      const execution = await startDump('D1');
      failedRunId = execution.runId;
      await tickUntil(ctx, 'app dump exhausted', async () => (await execOf(ctx, execution.runId)).status === 'failed');
      t.assertEqual('both attempts burned', 2, state.stageRuns);
      t.assertEqual('no dump effect from the failed run', 0, ctx.server.effectCount('app-dump-sent', 'D1'));
    });

    await t.step('the failure is not surfaced as driver-recoverable work', async () => {
      const sweep = await recoverySweep(ctx.client.engine, {
        now: Date.now(),
        nonRecoverableWorkflows: NON_RECOVERABLE_WORKFLOWS,
      });
      const skip = sweep.skipped.find(s => s.deadLetter.runId === failedRunId);
      t.log(`classification surfaced: "${skip?.reason}"`);
      t.assert('sweep skipped it with the classification as the reason',
        skip !== undefined && /non-recoverable/.test(skip.reason) && sweep.redriven.length === 0,
        'skipped, reason mentions non-recoverable, zero redriven',
        { reason: skip?.reason, redriven: sweep.redriven.length });
      t.assert('classification is explicit and single-sourced next to the definition',
        NON_RECOVERABLE_WORKFLOWS.has('appdump.parity'), true, [...NON_RECOVERABLE_WORKFLOWS]);
    });

    await t.step('automatic recovery does not re-arm it across restarts', async () => {
      await ctx.restart();
      await recoverySweep(ctx.client.engine, { now: Date.now(), nonRecoverableWorkflows: NON_RECOVERABLE_WORKFLOWS });
      for (let i = 0; i < 5; i++) {
        await ctx.client.tick();
        await ctx.sleep(100);
      }
      t.assertEqual('stage never re-ran after restart + sweep + ticks', 2, state.stageRuns);
      t.assertEqual('execution still failed', 'failed', (await execOf(ctx, failedRunId)).status);
    });

    await t.step('a future fresh run supersedes it', async () => {
      const fresh = await startDump('D2');
      await tickUntil(ctx, 'fresh dump completion', async () => (await execOf(ctx, fresh.runId)).status === 'completed');
      t.assertEqual('fresh run completed', 'completed', (await execOf(ctx, fresh.runId)).status);
      t.assertEqual('fresh dump effect recorded', 1, ctx.server.effectCount('app-dump-sent', 'D2'));
      t.assertEqual('old failure still inspectable (history not destroyed)', 'failed', (await execOf(ctx, failedRunId)).status);
    });

    await t.step('the failed run can be cleaned up', async () => {
      const deadLetters = await ctx.client.engine.getDeadLetters();
      const dl = deadLetters.find(d => d.runId === failedRunId)!;
      await ctx.client.engine.acknowledgeDeadLetter(dl.id);
      const purged = await ctx.client.engine.purgeDeadLetters({ olderThanMs: 0, acknowledgedOnly: true });
      t.assertEqual('acknowledged dead letter purged', 1, purged);
      const remaining = await ctx.client.engine.getDeadLetters();
      t.assertEqual('dead-letter queue empty after cleanup', 0, remaining.length);
    });
  },
};
