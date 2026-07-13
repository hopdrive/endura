/**
 * Scenario 4 — Move Sync Permanent Failure (review §Scenario 4).
 *
 * Models moveStatusSync.pipeline: single stage, attempts 10, priority
 * 50, no dedupe (extraction: pipelines-batch2.md §moveStatusSync). The
 * behavior under test is the RowFilterRejectedError contract: Hasura
 * accepting the request but writing zero rows means the move was
 * reassigned/deleted — a PERMANENT server refusal that must stop
 * burning retries immediately (driver app: markEventAsPermanentlyFailed
 * + return without rethrow, worker.ts:100-127).
 *
 * Endura mapping: the fake server's PermanentRefusalError carries
 * `nonRetryable: true`, endura's duck-typed isNonRetryableError skips
 * the remaining retry budget, the execution fails, and a dead letter
 * flagged nonRetryable is written. Force Retry = retryFromDeadLetter,
 * the driver app's "reset permanently_failed back to failed" recovery
 * affordance.
 */

import { defineActivity, defineWorkflow, Workflow } from 'endura';
import { ParityScenario, ParityContext } from '../harness/runner';
import { ParityClient } from '../harness/expoPlatform';
import { tickUntil, execOf } from './util';

/** Per-run mutable state; reset at the top of run(), survives restarts. */
const state = {
  stageRuns: {} as Record<string, number>,
};

function bump(stage: string): void {
  state.stageRuns[stage] = (state.stageRuns[stage] ?? 0) + 1;
}

function buildWorkflow(ctx: ParityContext<ParityClient>): Workflow {
  const sync = defineActivity({
    name: 'moveStatusSync',
    retry: { maximumAttempts: 10, initialInterval: 300 },
    runWhen: rc => (rc.isConnected ? { ready: true } : { ready: false, reason: 'offline' }),
    execute: async a => {
      bump('sync');
      const moveId = Number(a.input.moveId);
      const status = String(a.input.status);
      // A refused write (RowFilterRejectedError parity) propagates as
      // PermanentRefusalError{nonRetryable:true} — the engine, not the
      // activity, owns the permanent-failure classification.
      await ctx.server.call({
        endpoint: 'move/status-sync',
        effect: { kind: 'move-status-synced', key: `${moveId}:${status}`, details: { moveId, status } },
        idempotencyKey: `status-${moveId}-${status}`,
      });
      return { serverStatus: status };
    },
  });

  return defineWorkflow({
    name: 'move.statussync.parity',
    activities: [sync],
  });
}

export const moveSyncPermanentFailure: ParityScenario<ParityClient> = {
  scenarioId: 'move-sync-permfail',
  name: 'Move sync permanent failure (refusal → DLQ → force retry)',
  category: 4,
  engineMode: 'manual',

  register(client, ctx) {
    client.registerWorkflow(buildWorkflow(ctx));
  },

  async run(ctx, t) {
    state.stageRuns = {};

    const startSync = (moveId: number, status: string) => {
      const workflow = ctx.client.engine.getWorkflow('move.statussync.parity')!;
      return ctx.client.engine.start(workflow, {
        input: { moveId, status },
        metadata: { moveId },
      });
    };

    await t.step('a normal transient failure retries and completes', async () => {
      ctx.server.script('move/status-sync', 'transient-failure');
      const execution = await startSync(31001, 'pickup arrived');
      await tickUntil(ctx, 'transient sync completion', async () => (await execOf(ctx, execution.runId)).status === 'completed');
      t.assertEqual('sync ran twice (one retry)', 2, state.stageRuns.sync ?? 0);
      t.assertEqual('exactly one synced effect', 1, ctx.server.effectCount('move-status-synced', '31001:pickup arrived'));
    });

    let refusedRunId = '';
    await t.step('a server-refused write is classified permanently failed without burning retries', async () => {
      state.stageRuns = {};
      ctx.server.script('move/status-sync', 'permanent-refusal');
      const execution = await startSync(31002, 'delivery started');
      refusedRunId = execution.runId;
      await tickUntil(ctx, 'refused sync failed', async () => (await execOf(ctx, execution.runId)).status === 'failed');

      t.assertEqual('exactly one attempt — remaining retry budget not burned', 1, state.stageRuns.sync ?? 0);
      const deadLetters = await ctx.client.engine.getDeadLetters();
      const dl = deadLetters.find(d => d.runId === refusedRunId);
      t.assert('dead letter written and flagged nonRetryable', dl !== undefined && dl.nonRetryable === true,
        'deadLetter.nonRetryable === true', dl && { nonRetryable: dl.nonRetryable, attempts: dl.attempts });
      t.assertEqual('no business effect from the refused write', 0, ctx.server.effectCount('move-status-synced', '31002:delivery started'));
    });

    await t.step('permanently failed work is excluded from automatic recovery', async () => {
      await ctx.restart();
      // Give recovery every chance: several ticks over the reopened database.
      for (let i = 0; i < 5; i++) {
        await ctx.client.tick();
        await ctx.sleep(100);
      }
      const execution = await execOf(ctx, refusedRunId);
      t.assertEqual('execution still failed after restart + ticks', 'failed', execution.status);
      t.assertEqual('refused stage never re-ran automatically', 1, state.stageRuns.sync ?? 0);
      const deadLetters = await ctx.client.engine.getDeadLetters();
      t.assertEqual('dead letter still present', 1, deadLetters.filter(d => d.runId === refusedRunId).length);
      t.assertEqual('still no business effect', 0, ctx.server.effectCount('move-status-synced', '31002:delivery started'));
    });

    await t.step('the failed state remains inspectable by move', async () => {
      const failed = await ctx.client.getExecutions({ workflowName: 'move.statussync.parity', status: 'failed' });
      const forMove = failed.filter(e => (e.metadata as Record<string, unknown>)?.moveId === 31002);
      t.assertEqual('one failed execution scoped to move 31002', 1, forMove.length);
      t.assertEqual('failed at the sync stage', 'moveStatusSync', forMove[0]?.failedActivityName);
      const deadLetters = await ctx.client.engine.getDeadLetters();
      const dl = deadLetters.find(d => d.runId === refusedRunId);
      t.assert('dead letter carries the refusal error and move input', dl !== undefined && /refused/i.test(dl.error) && dl.input.moveId === 31002,
        'error mentions refusal, input.moveId === 31002', dl && { error: dl.error, moveId: dl.input.moveId });
    });

    await t.step('Force Retry resets it into a retryable state and it completes', async () => {
      const deadLetters = await ctx.client.engine.getDeadLetters();
      const dl = deadLetters.find(d => d.runId === refusedRunId)!;
      const revived = await ctx.client.engine.retryFromDeadLetter(dl.id);
      t.assertEqual('redrive re-opened the execution', 'running', revived.status);

      await tickUntil(ctx, 'redriven sync completion', async () => (await execOf(ctx, refusedRunId)).status === 'completed');
      t.assertEqual('sync ran exactly once more after force retry', 2, state.stageRuns.sync ?? 0);
      t.assertEqual('exactly one synced effect after force retry', 1, ctx.server.effectCount('move-status-synced', '31002:delivery started'));
      const remaining = await ctx.client.engine.getDeadLetters();
      t.assertEqual('dead letter consumed by the redrive', 0, remaining.filter(d => d.runId === refusedRunId).length);
      const final = await execOf(ctx, refusedRunId);
      t.assertEqual('failedActivityName cleared on completion', undefined, final.failedActivityName);
    });
  },
};
