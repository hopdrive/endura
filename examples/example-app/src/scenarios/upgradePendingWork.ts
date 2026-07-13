/**
 * Scenario 12 — App Upgrade With Pending Work (review §Scenario 12).
 *
 * The driver app's recovery code guards unmapped stages from renamed or
 * removed workers (the hand-maintained jobMapper produced jobs with
 * undefined workers — a Do-Not-Carry-Forward defect). Endura's
 * contract: a persisted task whose activity name no longer exists is
 * HELD for inspection (activity:held, rescheduled ~60s, no attempt
 * burned, never dead-lettered), a restored definition resumes it, and
 * compatible changes (inserting a stage) continue safely via name-based
 * matching with index repair.
 *
 * The version to register is module state so ctx.restart() simulates
 * the upgrade: close, reopen same database, register the NEW definition.
 */

import { defineActivity, defineWorkflow, Workflow, ActivityTask } from 'endura';
import { ParityScenario, ParityContext } from '../harness/runner';
import { ParityClient } from '../harness/expoPlatform';
import { tickUntil, execOf } from './util';

/** Per-run mutable state; reset at the top of run(), survives restarts. */
const state = {
  stageRuns: {} as Record<string, number>,
  version: 1,
};

function bump(stage: string): void {
  state.stageRuns[stage] = (state.stageRuns[stage] ?? 0) + 1;
}

function makeStage(ctx: ParityContext<ParityClient>, name: string, effectKind?: string) {
  return defineActivity({
    name,
    retry: { maximumAttempts: 3, initialInterval: 300 },
    execute: async a => {
      bump(name);
      if (effectKind) {
        await ctx.server.call({
          endpoint: `upgrade/${name}`,
          effect: { kind: effectKind, key: String(a.input.jobId) },
          idempotencyKey: `${effectKind}-${String(a.input.jobId)}`,
        });
      }
      return { [`${name}Done`]: true };
    },
  });
}

function buildWorkflow(ctx: ParityContext<ParityClient>): Workflow {
  const intake = () => makeStage(ctx, 'intake');
  const process = () => makeStage(ctx, 'process');
  const finalize = () => makeStage(ctx, 'finalize', 'upgrade-finalized');

  switch (state.version) {
    case 2:
      // The upgrade renamed 'process' — persisted tasks now reference an
      // unknown activity.
      return defineWorkflow({ name: 'upgrade.parity', version: 'v2', activities: [intake(), makeStage(ctx, 'processV2'), finalize()] });
    case 4:
      // Compatible change: 'audit' inserted before finalize.
      return defineWorkflow({ name: 'upgrade.parity', version: 'v4', activities: [intake(), process(), makeStage(ctx, 'audit'), finalize()] });
    default:
      return defineWorkflow({ name: 'upgrade.parity', version: `v${state.version}`, activities: [intake(), process(), finalize()] });
  }
}

export const upgradePendingWork: ParityScenario<ParityClient> = {
  scenarioId: 'upgrade-pending-work',
  name: 'App upgrade with pending work (held, not dead-lettered)',
  category: 12,
  engineMode: 'manual',

  register(client, ctx) {
    client.registerWorkflow(buildWorkflow(ctx));
  },

  async run(ctx, t) {
    state.stageRuns = {};
    state.version = 1;
    await ctx.restart(); // ensure the v1 definition is what's registered

    const startJob = (jobId: string) => {
      const workflow = ctx.client.engine.getWorkflow('upgrade.parity')!;
      return ctx.client.engine.start(workflow, { input: { jobId }, metadata: { jobId } });
    };
    const taskFor = async (runId: string) => {
      const tasks = (await ctx.client.storage.getActivityTasksForExecution(runId)) as ActivityTask[];
      return tasks.find(task => task.status === 'pending' || task.status === 'active');
    };
    /** The recovery-UI affordance: requeue a held task for an immediate recheck. */
    const nudge = async (runId: string) => {
      const task = await taskFor(runId);
      if (task) await ctx.client.storage.saveActivityTask({ ...task, scheduledFor: Date.now() });
    };

    let w1 = '';
    await t.step('an upgrade that renames an activity holds the pending task for inspection', async () => {
      const execution = await startJob('U1');
      w1 = execution.runId;
      await tickUntil(ctx, 'intake completed', async () => (await execOf(ctx, w1)).currentActivityName === 'process');

      state.version = 2;
      await ctx.restart(); // the upgrade
      await ctx.client.tick();
      await ctx.sleep(200);

      const task = await taskFor(w1);
      t.assertEqual('execution still running (not failed by the rename)', 'running', (await execOf(ctx, w1)).status);
      t.assert('task held: pending again with a future recheck, no attempt burned',
        task !== undefined && task.status === 'pending' && (task.scheduledFor ?? 0) > Date.now() + 30000 && task.attempts === 0,
        'pending, recheck ~60s out, attempts 0',
        task && { status: task.status, recheckInMs: (task.scheduledFor ?? 0) - Date.now(), attempts: task.attempts });
      t.assertEqual('NOT dead-lettered', 0, (await ctx.client.engine.getDeadLetters()).length);
      const heldLogs = ctx.client.parityLogs.filter(line => /holding task|activity:held/i.test(line));
      t.assert('hold is visible in engine logs/events', heldLogs.length >= 1, '>= 1 held log', heldLogs.slice(-2));
    });

    await t.step('repeated rechecks stay safe while the definition is missing', async () => {
      for (let i = 0; i < 3; i++) {
        await nudge(w1);
        await ctx.client.tick();
        await ctx.sleep(150);
      }
      const task = await taskFor(w1);
      t.assert('still held, still zero attempts, still no dead letter',
        task !== undefined && task.attempts === 0 && (await ctx.client.engine.getDeadLetters()).length === 0,
        'attempts 0, DLQ empty', task && { attempts: task.attempts });
      t.assertEqual('the renamed activity never executed for the held run', 0, state.stageRuns.processV2 ?? 0);
    });

    await t.step('restoring the activity (hotfix) resumes the held work', async () => {
      state.version = 3; // v3 re-adds the original chain
      await ctx.restart();
      await nudge(w1);
      await tickUntil(ctx, 'completion after hotfix', async () => (await execOf(ctx, w1)).status === 'completed');
      t.assertEqual('every stage ran exactly once', { intake: 1, process: 1, finalize: 1 }, {
        intake: state.stageRuns.intake ?? 0,
        process: state.stageRuns.process ?? 0,
        finalize: state.stageRuns.finalize ?? 0,
      });
      t.assertEqual('one finalize effect', 1, ctx.server.effectCount('upgrade-finalized', 'U1'));
    });

    await t.step('a compatible upgrade (inserted stage) continues in-flight work safely', async () => {
      state.stageRuns = {};
      const execution = await startJob('U2');
      await tickUntil(ctx, 'U2 at finalize', async () => (await execOf(ctx, execution.runId)).currentActivityName === 'finalize');

      state.version = 4; // inserts 'audit' before finalize
      await ctx.restart();
      await nudge(execution.runId);
      await tickUntil(ctx, 'U2 completion on the new definition', async () => (await execOf(ctx, execution.runId)).status === 'completed');
      t.assertEqual('in-flight run resumed at finalize by name (audit not retrofitted)', { finalize: 1, audit: 0 }, {
        finalize: state.stageRuns.finalize ?? 0,
        audit: state.stageRuns.audit ?? 0,
      });

      const fresh = await startJob('U3');
      await tickUntil(ctx, 'U3 completion', async () => (await execOf(ctx, fresh.runId)).status === 'completed');
      t.assertEqual('new runs execute the inserted stage', 1, state.stageRuns.audit ?? 0);
    });
  },
};
