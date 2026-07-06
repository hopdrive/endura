/**
 * Scenario 5 — Recovery Age Gate (review §Scenario 5).
 *
 * Driver-app parity: recovery re-arms failed events newer than
 * MAX_RECOVERABLE_EVENT_AGE_MS (7 days); older work is skipped unless
 * the caller passes includeStale (extraction:
 * core-event-queue-recovery.md §recovery). In endura the crash-resume
 * half of recovery is automatic (leases), so the age-gate policy
 * applies to the exhausted-retry dead letters an app-layer sweep
 * (scenarios/util.ts recoverySweep) chooses to redrive.
 *
 * Staleness is simulated by moving the SWEEP's `now` forward 8 days —
 * same code path as an 8-day-old record, no clock mocking needed on a
 * real device.
 */

import { defineActivity, defineWorkflow, Workflow } from 'endura';
import { ParityScenario, ParityContext } from '../harness/runner';
import { ParityClient } from '../harness/expoPlatform';
import { tickUntil, execOf, recoverySweep, SEVEN_DAYS_MS } from './util';

/** Per-run mutable state; reset at the top of run(), survives restarts. */
const state = {
  stageRuns: {} as Record<string, number>,
};

function bump(jobId: string): void {
  state.stageRuns[jobId] = (state.stageRuns[jobId] ?? 0) + 1;
}

function buildWorkflow(ctx: ParityContext<ParityClient>): Workflow {
  const sync = defineActivity({
    name: 'recoverableSync',
    retry: { maximumAttempts: 2, initialInterval: 300 },
    runWhen: rc => (rc.isConnected ? { ready: true } : { ready: false, reason: 'offline' }),
    execute: async a => {
      const jobId = String(a.input.jobId);
      bump(jobId);
      await ctx.server.call({
        endpoint: 'recovery/sync',
        effect: { kind: 'recovery-synced', key: jobId },
        idempotencyKey: `rec-${jobId}`,
      });
      return { synced: true };
    },
  });

  return defineWorkflow({
    name: 'recovery.agegate.parity',
    activities: [sync],
  });
}

export const recoveryAgeGate: ParityScenario<ParityClient> = {
  scenarioId: 'recovery-age-gate',
  name: 'Recovery age gate (7-day window, includeStale bypass)',
  category: 5,
  engineMode: 'manual',

  register(client, ctx) {
    client.registerWorkflow(buildWorkflow(ctx));
  },

  async run(ctx, t) {
    state.stageRuns = {};

    const startJob = (jobId: string) => {
      const workflow = ctx.client.engine.getWorkflow('recovery.agegate.parity')!;
      return ctx.client.engine.start(workflow, { input: { jobId }, metadata: { jobId } });
    };
    const failJob = async (jobId: string) => {
      // Exhaust the 2-attempt budget → recoverable dead letter.
      ctx.server.script('recovery/sync', 'transient-failure', 'transient-failure');
      const execution = await startJob(jobId);
      await tickUntil(ctx, `${jobId} exhausted`, async () => (await execOf(ctx, execution.runId)).status === 'failed');
      return execution.runId;
    };

    let freshRunId = '';
    await t.step('failed work newer than the window is automatically eligible for recovery', async () => {
      freshRunId = await failJob('R1');
      const deadLetters = await ctx.client.engine.getDeadLetters();
      const dl = deadLetters.find(d => d.runId === freshRunId);
      t.assert('exhausted retries produced a recoverable dead letter', dl !== undefined && dl.nonRetryable !== true,
        'deadLetter with nonRetryable !== true', dl && { nonRetryable: dl.nonRetryable, attempts: dl.attempts });

      const sweep = await recoverySweep(ctx.client.engine, { now: Date.now() });
      t.assertEqual('fresh failure redriven by the sweep', 1, sweep.redriven.filter(d => d.runId === freshRunId).length);
      await tickUntil(ctx, 'R1 completion after recovery', async () => (await execOf(ctx, freshRunId)).status === 'completed');
      t.assertEqual('one synced effect after recovery', 1, ctx.server.effectCount('recovery-synced', 'R1'));
      t.assertEqual('R1 ran 3 times total (2 failed + 1 recovered)', 3, state.stageRuns.R1 ?? 0);
    });

    let staleRunId = '';
    await t.step('failed work older than the window is skipped by automatic recovery', async () => {
      staleRunId = await failJob('R2');
      // Sweep as if 8 days have passed since the failure.
      const sweep = await recoverySweep(ctx.client.engine, { now: Date.now() + 8 * 24 * 60 * 60 * 1000 });
      const skip = sweep.skipped.find(s => s.deadLetter.runId === staleRunId);
      t.assert('stale failure skipped, not redriven', skip !== undefined && sweep.redriven.length === 0,
        'skipped with zero redriven', { skipped: sweep.skipped.length, redriven: sweep.redriven.length });
      t.assertEqual('execution stays failed', 'failed', (await execOf(ctx, staleRunId)).status);
      t.assertEqual('no effect from the skipped work', 0, ctx.server.effectCount('recovery-synced', 'R2'));
    });

    await t.step('the skipped reason is visible enough for debugging', async () => {
      const sweep = await recoverySweep(ctx.client.engine, { now: Date.now() + 8 * 24 * 60 * 60 * 1000 });
      const skip = sweep.skipped.find(s => s.deadLetter.runId === staleRunId);
      t.log(`skip reason surfaced: "${skip?.reason}"`);
      t.assert('reason names staleness, the window, and the override', /stale/.test(skip?.reason ?? '') && /7d/.test(skip?.reason ?? '') && /includeStale/.test(skip?.reason ?? ''),
        'reason mentions stale + 7d window + includeStale', skip?.reason);
    });

    await t.step('skipped stale work does not create retry storms', async () => {
      const runsBefore = state.stageRuns.R2 ?? 0;
      for (let i = 0; i < 5; i++) {
        const sweep = await recoverySweep(ctx.client.engine, { now: Date.now() + 8 * 24 * 60 * 60 * 1000 });
        t.assert(`sweep ${i + 1} skipped again without redriving`, sweep.redriven.length === 0, 0, sweep.redriven.length);
        await ctx.client.tick();
      }
      t.assertEqual('stale stage never re-ran across repeated sweeps', runsBefore, state.stageRuns.R2 ?? 0);
    });

    await t.step('manual recovery can opt into stale recovery', async () => {
      const sweep = await recoverySweep(ctx.client.engine, {
        now: Date.now() + 8 * 24 * 60 * 60 * 1000,
        includeStale: true,
      });
      t.assertEqual('includeStale redrives the stale failure', 1, sweep.redriven.filter(d => d.runId === staleRunId).length);
      await tickUntil(ctx, 'R2 completion after stale recovery', async () => (await execOf(ctx, staleRunId)).status === 'completed');
      t.assertEqual('one synced effect after stale recovery', 1, ctx.server.effectCount('recovery-synced', 'R2'));
      t.assert('window constant matches the driver app', SEVEN_DAYS_MS === 7 * 24 * 60 * 60 * 1000, SEVEN_DAYS_MS, SEVEN_DAYS_MS);
    });
  },
};
