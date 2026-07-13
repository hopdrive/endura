/**
 * Scenario 2 — Outcome Draft Sync Parity (review §Scenario 2).
 *
 * Models outcomeWorkflowDataSync.pipeline: stage1CreateDraft →
 * stage2SyncWorkflowData. This chain is intentionally NON-deduped in the
 * driver app: multiple enqueues for the same local outcome are allowed,
 * concurrent syncs must converge on ONE server draft (stage1 resolves
 * instead of re-creating when the local row already carries a server id),
 * and no user edit may be dropped because an earlier sync is pending.
 * Stage2 is an idempotent JSONB merge that skips empty payloads but still
 * completes the stage (extraction: pipelines-batch1.md
 * §outcomeWorkflowDataSync, test-suite-behaviors.md stages 1-2).
 */

import { defineActivity, defineWorkflow, Workflow } from 'endura';
import { ParityScenario, ParityContext } from '../harness/runner';
import { ParityClient } from '../harness/expoPlatform';
import { tickUntil, execOf } from './util';

interface LocalOutcomeRow {
  /** Set by stage1's swapLocalForServerRow parity — local temp row becomes the server-id row. */
  serverOutcomeId?: number;
}

/** Per-run mutable state; reset at the top of run(), survives restarts. */
const state = {
  stageRuns: {} as Record<string, number>,
  rows: new Map<string, LocalOutcomeRow>(),
  /** What the fake server holds per draft after merges — the convergence target. */
  serverData: new Map<number, Record<string, unknown>>(),
  nextServerId: 9001,
};

function bump(stage: string): void {
  state.stageRuns[stage] = (state.stageRuns[stage] ?? 0) + 1;
}

function buildWorkflow(ctx: ParityContext<ParityClient>): Workflow {
  const stage1 = defineActivity({
    name: 'stage1CreateDraft',
    retry: { maximumAttempts: 10, initialInterval: 300 },
    runWhen: rc => (rc.isConnected ? { ready: true } : { ready: false, reason: 'offline' }),
    execute: async a => {
      bump('stage1');
      const localId = String(a.input.localOutcomeId);
      const row = state.rows.get(localId);
      if (!row) throw new Error(`no local outcome row ${localId}`);
      // isDraftAlreadyOnServer parity: resolve the existing draft, never re-create.
      if (row.serverOutcomeId) return { outcomeId: row.serverOutcomeId };
      await ctx.server.call({
        endpoint: 'outcome/draft-create',
        effect: { kind: 'outcome-draft-created', key: localId },
        idempotencyKey: `draft-${localId}`,
      });
      // swapLocalForServerRow parity: the local temp row now carries the server id.
      if (!row.serverOutcomeId) row.serverOutcomeId = state.nextServerId++;
      return { outcomeId: row.serverOutcomeId };
    },
  });

  const stage2 = defineActivity({
    name: 'stage2SyncWorkflowData',
    retry: { maximumAttempts: 10, initialInterval: 300 },
    runWhen: rc => (rc.isConnected ? { ready: true } : { ready: false, reason: 'offline' }),
    execute: async a => {
      bump('stage2');
      const outcomeId = Number(a.input.outcomeId);
      if (!(outcomeId > 0)) throw new Error('stage2 requires a server-side outcomeId');
      const merge = a.input.merge as Record<string, unknown> | undefined;
      // Skip-empty parity: nothing to merge still completes the stage.
      if (!merge || Object.keys(merge).length === 0) return { merged: false };
      await ctx.server.call({
        endpoint: 'outcome/data-merge',
        effect: { kind: 'outcome-data-merged', key: String(outcomeId), details: merge },
      });
      state.serverData.set(outcomeId, { ...(state.serverData.get(outcomeId) ?? {}), ...merge });
      return { merged: true };
    },
  });

  return defineWorkflow({
    name: 'outcome.datasync.parity',
    activities: [stage1, stage2],
  });
}

export const outcomeDraftSync: ParityScenario<ParityClient> = {
  scenarioId: 'outcome-draft-sync',
  name: 'Outcome draft sync parity (non-deduped convergence)',
  category: 2,
  engineMode: 'manual',

  register(client, ctx) {
    client.registerWorkflow(buildWorkflow(ctx));
  },

  async run(ctx, t) {
    state.stageRuns = {};
    state.rows.clear();
    state.serverData.clear();
    state.nextServerId = 9001;

    const seedLocalRow = (localId: string) => state.rows.set(localId, {});
    const startSync = (localId: string, moveId: number, merge: Record<string, unknown>) => {
      const workflow = ctx.client.engine.getWorkflow('outcome.datasync.parity')!;
      return ctx.client.engine.start(workflow, {
        input: { localOutcomeId: localId, moveId, merge },
        metadata: { moveId, localOutcomeId: localId },
      });
    };
    const serverIdOf = (localId: string) => {
      const id = state.rows.get(localId)?.serverOutcomeId;
      if (!id) throw new Error(`no server draft for ${localId}`);
      return id;
    };

    await t.step('stage1 creates the server draft; stage2 merges with the draft identity', async () => {
      seedLocalRow('L1');
      const execution = await startSync('L1', 201, { odometer: 42 });
      await tickUntil(ctx, 'L1 completion', async () => (await execOf(ctx, execution.runId)).status === 'completed');
      const final = await execOf(ctx, execution.runId);
      const serverId = serverIdOf('L1');
      t.assertEqual('stage2 received the draft identity from stage1', serverId, final.state.outcomeId);
      t.assertEqual('exactly one draft created', 1, ctx.server.effectCount('outcome-draft-created', 'L1'));
      t.assertEqual('workflow data merged on the server', { odometer: 42 }, state.serverData.get(serverId));
      t.assertEqual('each stage ran once', { stage1: 1, stage2: 1 }, {
        stage1: state.stageRuns.stage1 ?? 0,
        stage2: state.stageRuns.stage2 ?? 0,
      });
    });

    await t.step('concurrent enqueues for the same outcome are allowed and converge without dropping edits', async () => {
      state.stageRuns = {};
      seedLocalRow('L2');
      const first = await startSync('L2', 202, { q1: 'A' });
      const second = await startSync('L2', 202, { q2: 'B' });
      await tickUntil(ctx, 'both L2 syncs completed', async () => {
        const a = await execOf(ctx, first.runId);
        const b = await execOf(ctx, second.runId);
        return a.status === 'completed' && b.status === 'completed';
      });
      const serverId = serverIdOf('L2');
      const a = await execOf(ctx, first.runId);
      const b = await execOf(ctx, second.runId);
      t.assertEqual('still exactly one server draft under concurrency', 1, ctx.server.effectCount('outcome-draft-created', 'L2'));
      t.assertEqual('both syncs resolved to the same draft', a.state.outcomeId, b.state.outcomeId);
      t.assertEqual('no user edits dropped — both merges landed', { q1: 'A', q2: 'B' }, state.serverData.get(serverId));
    });

    await t.step('repeated and empty syncs converge safely', async () => {
      state.stageRuns = {};
      const repeat = await startSync('L2', 202, { q1: 'A' });
      const empty = await startSync('L2', 202, {});
      await tickUntil(ctx, 'repeat + empty syncs completed', async () => {
        const a = await execOf(ctx, repeat.runId);
        const b = await execOf(ctx, empty.runId);
        return a.status === 'completed' && b.status === 'completed';
      });
      const serverId = serverIdOf('L2');
      t.assertEqual('idempotent re-merge left server data converged', { q1: 'A', q2: 'B' }, state.serverData.get(serverId));
      t.assertEqual('empty merge skipped the server call but completed the stage', false, (await execOf(ctx, empty.runId)).state.merged);
      t.assertEqual('still one draft after repeats', 1, ctx.server.effectCount('outcome-draft-created', 'L2'));
    });

    await t.step('crash after stage1 resumes at stage2 with the accumulated draft identity', async () => {
      state.stageRuns = {};
      seedLocalRow('L3');
      const execution = await startSync('L3', 203, { notes: 'crash test' });
      await tickUntil(ctx, 'stage1 completed', async () => {
        const current = await execOf(ctx, execution.runId);
        return current.currentActivityName === 'stage2SyncWorkflowData';
      });
      t.assertEqual('only stage1 ran before the crash', { stage1: 1, stage2: 0 }, {
        stage1: state.stageRuns.stage1 ?? 0,
        stage2: state.stageRuns.stage2 ?? 0,
      });
      await ctx.restart();
      await tickUntil(ctx, 'completion after restart', async () => (await execOf(ctx, execution.runId)).status === 'completed');
      const serverId = serverIdOf('L3');
      t.assertEqual('stage1 not re-run after restart', 1, state.stageRuns.stage1 ?? 0);
      t.assertEqual('one draft for L3', 1, ctx.server.effectCount('outcome-draft-created', 'L3'));
      t.assertEqual('merge landed after resume', { notes: 'crash test' }, state.serverData.get(serverId));
    });

    await t.step('transient stage2 failure retries without re-running stage1 or double-writing', async () => {
      state.stageRuns = {};
      seedLocalRow('L4');
      ctx.server.script('outcome/data-merge', 'transient-failure');
      const execution = await startSync('L4', 204, { fuel: 'full' });
      await tickUntil(ctx, 'L4 completion', async () => (await execOf(ctx, execution.runId)).status === 'completed');
      const serverId = serverIdOf('L4');
      t.assertEqual('stage1 once, stage2 twice', { stage1: 1, stage2: 2 }, {
        stage1: state.stageRuns.stage1 ?? 0,
        stage2: state.stageRuns.stage2 ?? 0,
      });
      t.assertEqual('failed attempt left no partial server write', 1, ctx.server.effectCount('outcome-data-merged', String(serverId)));
      t.assertEqual('merged data correct after retry', { fuel: 'full' }, state.serverData.get(serverId));
    });
  },
};
