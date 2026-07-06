/**
 * Scenario 13 — Mobility Run Scoped Recovery (review §Scenario 13).
 *
 * Mobile-service work is scoped by mobility run / service order, not by
 * move (extraction: pipelines-batch3.md — mobilityStopSync et al carry
 * runId/stopId in payload; recovery for these pipelines was silently
 * DEAD in the driver app via the jobMapper omission, a
 * Do-Not-Carry-Forward defect this scenario replaces with real
 * scoping).
 *
 * Endura mapping: metadata is the scoping channel ({ mobilityRunId,
 * stopId } vs { moveId }); a per-run recovery UI joins dead letters to
 * executions by runId and force-retries just its own scope.
 */

import { defineActivity, defineWorkflow, Workflow, DeadLetterRecord } from 'endura';
import { ParityScenario, ParityContext } from '../harness/runner';
import { ParityClient } from '../harness/expoPlatform';
import { tickUntil, execOf } from './util';

/** Per-run mutable state; reset at the top of run(), survives restarts. */
const state = {
  stageRuns: {} as Record<string, number>,
};

function buildWorkflows(ctx: ParityContext<ParityClient>): Workflow[] {
  const stopSync = defineActivity({
    name: 'mobilityStopSync',
    retry: { maximumAttempts: 2, initialInterval: 300 },
    runWhen: rc => (rc.isConnected ? { ready: true } : { ready: false, reason: 'offline', retryInMs: 400 }),
    execute: async a => {
      const stopId = String(a.input.stopId);
      state.stageRuns[stopId] = (state.stageRuns[stopId] ?? 0) + 1;
      await ctx.server.call({
        endpoint: 'mobility/stop-sync',
        effect: { kind: 'stop-synced', key: stopId },
        idempotencyKey: `stop-${stopId}`,
      });
      return { synced: true };
    },
  });

  const moveSync = defineActivity({
    name: 'moveStatusSync',
    retry: { maximumAttempts: 2, initialInterval: 300 },
    runWhen: rc => (rc.isConnected ? { ready: true } : { ready: false, reason: 'offline', retryInMs: 400 }),
    execute: async a => {
      const moveId = String(a.input.moveId);
      state.stageRuns[`move-${moveId}`] = (state.stageRuns[`move-${moveId}`] ?? 0) + 1;
      await ctx.server.call({
        endpoint: 'move/status-sync',
        effect: { kind: 'move-synced', key: moveId },
        idempotencyKey: `move-${moveId}`,
      });
      return { synced: true };
    },
  });

  return [
    defineWorkflow({ name: 'mobility.stopsync.parity', activities: [stopSync] }),
    defineWorkflow({ name: 'move.statussync.scoped.parity', activities: [moveSync] }),
  ];
}

export const runScopedRecovery: ParityScenario<ParityClient> = {
  scenarioId: 'run-scoped-recovery',
  name: 'Mobility run scoped recovery (per-run force retry)',
  category: 13,
  engineMode: 'manual',

  register(client, ctx) {
    for (const workflow of buildWorkflows(ctx)) client.registerWorkflow(workflow);
  },

  async run(ctx, t) {
    state.stageRuns = {};

    const startStop = (mobilityRunId: string, stopId: string) => {
      const workflow = ctx.client.engine.getWorkflow('mobility.stopsync.parity')!;
      return ctx.client.engine.start(workflow, {
        input: { mobilityRunId, stopId },
        metadata: { mobilityRunId, stopId },
      });
    };
    const startMove = (moveId: number) => {
      const workflow = ctx.client.engine.getWorkflow('move.statussync.scoped.parity')!;
      return ctx.client.engine.start(workflow, { input: { moveId }, metadata: { moveId } });
    };
    const failNext = (endpoint: string) => ctx.server.script(endpoint, 'transient-failure', 'transient-failure');

    /** What a per-run recovery UI computes: this run's dead letters, via metadata. */
    const deadLettersForRun = async (mobilityRunId: string) => {
      const deadLetters = await ctx.client.engine.getDeadLetters();
      const scoped: DeadLetterRecord[] = [];
      for (const deadLetter of deadLetters) {
        const execution = await execOf(ctx, deadLetter.runId);
        if ((execution.metadata as Record<string, unknown>)?.mobilityRunId === mobilityRunId) scoped.push(deadLetter);
      }
      return scoped;
    };

    const runs: Record<string, string> = {};
    await t.step('failures accumulate across two mobility runs and a move', async () => {
      for (const [runId, stopId] of [['RUN-A', 'ST1'], ['RUN-A', 'ST2'], ['RUN-B', 'ST3']] as const) {
        failNext('mobility/stop-sync');
        const execution = await startStop(runId, stopId);
        runs[stopId] = execution.runId;
        await tickUntil(ctx, `${stopId} exhausted`, async () => (await execOf(ctx, execution.runId)).status === 'failed');
      }
      failNext('move/status-sync');
      const moveExecution = await startMove(9001);
      runs['move'] = moveExecution.runId;
      await tickUntil(ctx, 'move sync exhausted', async () => (await execOf(ctx, moveExecution.runId)).status === 'failed');
      t.assertEqual('four dead letters', 4, (await ctx.client.engine.getDeadLetters()).length);
    });

    await t.step('failed work is scoped by mobility run via inspection APIs', async () => {
      const runA = await deadLettersForRun('RUN-A');
      const runB = await deadLettersForRun('RUN-B');
      t.assertEqual('RUN-A shows exactly its two failures', 2, runA.length);
      t.assertEqual('RUN-B shows exactly its one failure', 1, runB.length);
      t.assert('per-run UI rows carry stage + input for display',
        runA.every(dl => dl.activityName === 'mobilityStopSync' && typeof dl.input.stopId === 'string'),
        'activityName + input.stopId present', runA.map(dl => ({ activity: dl.activityName, stopId: dl.input.stopId })));
    });

    await t.step('force retry for RUN-A recovers only RUN-A', async () => {
      for (const deadLetter of await deadLettersForRun('RUN-A')) {
        await ctx.client.engine.retryFromDeadLetter(deadLetter.id);
      }
      await tickUntil(ctx, 'RUN-A stops recovered', async () => {
        const a = await execOf(ctx, runs.ST1!);
        const b = await execOf(ctx, runs.ST2!);
        return a.status === 'completed' && b.status === 'completed';
      });
      t.assertEqual('RUN-A effects landed once each', { st1: 1, st2: 1 }, {
        st1: ctx.server.effectCount('stop-synced', 'ST1'),
        st2: ctx.server.effectCount('stop-synced', 'ST2'),
      });
      t.assertEqual('RUN-B untouched by RUN-A recovery', 'failed', (await execOf(ctx, runs.ST3!)).status);
      t.assertEqual('move-based failure untouched by run-based recovery', 'failed', (await execOf(ctx, runs.move!)).status);
    });

    await t.step('move-based recovery does not interfere with run-based state', async () => {
      const deadLetters = await ctx.client.engine.getDeadLetters();
      for (const deadLetter of deadLetters) {
        const execution = await execOf(ctx, deadLetter.runId);
        if ((execution.metadata as Record<string, unknown>)?.moveId === 9001) {
          await ctx.client.engine.retryFromDeadLetter(deadLetter.id);
        }
      }
      await tickUntil(ctx, 'move sync recovered', async () => (await execOf(ctx, runs.move!)).status === 'completed');
      t.assertEqual('RUN-B still failed, still inspectable', 'failed', (await execOf(ctx, runs.ST3!)).status);
      t.assertEqual('exactly one dead letter left (RUN-B)', 1, (await ctx.client.engine.getDeadLetters()).length);
      t.assertEqual('no duplicate move effect after recovery', 1, ctx.server.effectCount('move-synced', '9001'));
    });
  },
};
