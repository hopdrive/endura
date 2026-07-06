/**
 * Scenario 8 — Offline Hold and Resume (review §Scenario 8).
 *
 * Driver-app parity: connectivity is a HOLD, not a failure —
 * isJobRunnable returning false skips the poll without consuming an
 * attempt, and the job simply waits for the network (extraction:
 * core-event-queue-recovery.md §isJobRunnable, "skip-not-fail").
 *
 * Endura mapping: runWhen gates the activity; a not-ready result
 * reschedules the task (attempts decremented back), records the reason
 * in the task's errorHistory as a 'skip' entry, and the engine retries
 * at the condition's retryInMs hint. Connectivity is simulated through
 * the Environment abstraction (ExpoEnvironmentOptions.getNetworkState),
 * per the review's requirement — not simulator network toggles.
 */

import { defineActivity, defineWorkflow, Workflow, ActivityTask } from 'endura';
import { ParityScenario, ParityContext } from '../harness/runner';
import { ParityClient } from '../harness/expoPlatform';
import { tickUntil, execOf } from './util';

/** Per-run mutable state; reset at the top of run(), survives restarts. */
const state = {
  stageRuns: {} as Record<string, number>,
};

function buildWorkflow(ctx: ParityContext<ParityClient>): Workflow {
  const heldSync = defineActivity({
    name: 'heldSync',
    retry: { maximumAttempts: 3, initialInterval: 300 },
    runWhen: rc => (rc.isConnected ? { ready: true } : { ready: false, reason: 'offline', retryInMs: 400 }),
    execute: async a => {
      const jobId = String(a.input.jobId);
      state.stageRuns[jobId] = (state.stageRuns[jobId] ?? 0) + 1;
      await ctx.server.call({
        endpoint: 'held/sync',
        effect: { kind: 'held-synced', key: jobId },
        idempotencyKey: `held-${jobId}`,
      });
      return { synced: true };
    },
  });

  return defineWorkflow({
    name: 'offline.hold.parity',
    activities: [heldSync],
  });
}

export const offlineHoldResume: ParityScenario<ParityClient> = {
  scenarioId: 'offline-hold-resume',
  name: 'Offline hold and resume (held, not failed; attempts not burned)',
  category: 8,
  engineMode: 'manual',

  register(client, ctx) {
    client.registerWorkflow(buildWorkflow(ctx));
  },

  async run(ctx, t) {
    state.stageRuns = {};

    const startJob = (jobId: string) => {
      const workflow = ctx.client.engine.getWorkflow('offline.hold.parity')!;
      return ctx.client.engine.start(workflow, { input: { jobId }, metadata: { jobId } });
    };
    const pendingTasks = async () =>
      (await ctx.client.storage.getActivityTasksByStatus('pending')) as ActivityTask[];
    const holdTicks = async (count: number) => {
      for (let i = 0; i < count; i++) {
        await ctx.client.tick();
        await ctx.sleep(450); // past the 400ms retryInMs so each tick re-evaluates the hold
      }
    };

    let heldRunId = '';
    await t.step('work can be enqueued offline', async () => {
      ctx.setOnline(false);
      const execution = await startJob('H1');
      heldRunId = execution.runId;
      t.assertEqual('execution accepted while offline', 'running', (await execOf(ctx, heldRunId)).status);
      t.assertEqual('one task waiting', 1, (await pendingTasks()).length);
    });

    await t.step('the activity is held rather than failed; attempts are not burned', async () => {
      await holdTicks(5);
      const execution = await execOf(ctx, heldRunId);
      const task = (await pendingTasks())[0];
      t.assertEqual('activity never executed while offline', 0, state.stageRuns.H1 ?? 0);
      t.assertEqual('execution still running after 5 held ticks', 'running', execution.status);
      t.assert('task still pending with a zero attempt/failure budget spent',
        task !== undefined && (task.failures ?? 0) === 0 && task.attempts === 0,
        { failures: 0, attempts: 0 }, task && { failures: task.failures, attempts: task.attempts });
      t.assertEqual('nothing dead-lettered by the hold', 0, (await ctx.client.engine.getDeadLetters()).length);
      t.assertEqual('no business effect while offline', 0, ctx.server.effectCount('held-synced', 'H1'));
    });

    await t.step('the hold reason is recorded for debugging', async () => {
      const task = (await pendingTasks())[0]!;
      const skips = (task.errorHistory ?? []).filter(e => e.kind === 'skip');
      t.log(`latest hold entry: ${JSON.stringify(skips[skips.length - 1])}`);
      t.assert('errorHistory carries skip entries naming the offline reason',
        skips.length >= 1 && skips.every(e => /offline/.test(e.message)),
        'skip entries with message "offline"', skips[skips.length - 1]);
    });

    await t.step('work resumes automatically when connectivity returns', async () => {
      ctx.setOnline(true);
      await tickUntil(ctx, 'held work completion', async () => (await execOf(ctx, heldRunId)).status === 'completed');
      t.assertEqual('activity ran exactly once after reconnect', 1, state.stageRuns.H1 ?? 0);
      t.assertEqual('exactly one synced effect', 1, ctx.server.effectCount('held-synced', 'H1'));
    });

    await t.step('an app restart preserves held offline work', async () => {
      ctx.setOnline(false);
      const execution = await startJob('H2');
      await holdTicks(2);
      await ctx.restart();
      await holdTicks(2);
      t.assertEqual('still held (not failed, not run) after restart', 0, state.stageRuns.H2 ?? 0);
      t.assertEqual('execution still running after restart', 'running', (await execOf(ctx, execution.runId)).status);

      ctx.setOnline(true);
      await tickUntil(ctx, 'post-restart completion', async () => (await execOf(ctx, execution.runId)).status === 'completed');
      t.assertEqual('ran once after reconnect', 1, state.stageRuns.H2 ?? 0);
      t.assertEqual('one effect for the restarted job', 1, ctx.server.effectCount('held-synced', 'H2'));
    });
  },
};
