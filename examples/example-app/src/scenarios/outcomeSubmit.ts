/**
 * Scenario 3 — Outcome Submit Parity (review §Scenario 3).
 *
 * Models outcomeSubmit.pipeline: stage1CreateDraft →
 * stage2SyncWorkflowData → stage3Submit, alongside a mid-fill sync chain
 * (byte-for-byte sibling stages, no submit — extraction:
 * pipelines-batch1.md §outcomeSubmit/§outcomeWorkflowDataSync).
 *
 * Key parity behaviors under test (test-suite-behaviors.md §stage3):
 * - Submit only ever fires from the submit chain, never mid-fill sync.
 * - Concurrency safety comes from the server's status:'new' guard, not
 *   from dedupe: concurrent submits converge, duplicates absorb as
 *   success-no-op (InvalidTransitionError-as-success), and the user's
 *   submit intent is never silently dropped.
 * - InvalidTransition while racing a concurrent void flags
 *   local_submission_error instead of retry-looping or dead-lettering.
 */

import { defineActivity, defineWorkflow, Workflow } from 'endura';
import { ParityScenario, ParityContext } from '../harness/runner';
import { ParityClient } from '../harness/expoPlatform';
import { PermanentRefusalError } from '../harness/fakeServer';
import { tickUntil, execOf } from './util';

interface LocalOutcomeRow {
  serverOutcomeId?: number;
  localStatus: 'submitted' | 'void' | 'synced';
  localPendingSubmission: boolean;
  submissionError?: string;
}

/** Per-run mutable state; reset at the top of run(), survives restarts. */
const state = {
  stageRuns: {} as Record<string, number>,
  rows: new Map<string, LocalOutcomeRow>(),
  serverData: new Map<number, Record<string, unknown>>(),
  nextServerId: 9001,
};

function bump(stage: string): void {
  state.stageRuns[stage] = (state.stageRuns[stage] ?? 0) + 1;
}

function rowOf(localId: string): LocalOutcomeRow {
  const row = state.rows.get(localId);
  if (!row) throw new Error(`no local outcome row ${localId}`);
  return row;
}

/**
 * Stage makers — the driver app's workers are byte-for-byte siblings
 * across the two chains; only names differ. The pipeline-prefixed names
 * (`outcomeSubmit.stage1CreateDraft` vs
 * `outcomeWorkflowDataSync.stage1CreateDraft`) are load-bearing parity:
 * both RNQ and endura resolve workers/activities in a global namespace,
 * so same-named stages across chains silently cross-wire (issue P4-001).
 */
function makeStage1(ctx: ParityContext<ParityClient>, tag: string, prefix: string) {
  return defineActivity({
    name: `${prefix}.stage1CreateDraft`,
    retry: { maximumAttempts: 10, initialInterval: 300 },
    runWhen: rc => (rc.isConnected ? { ready: true } : { ready: false, reason: 'offline' }),
    execute: async a => {
      bump(`${tag}.stage1`);
      const localId = String(a.input.localOutcomeId);
      const row = rowOf(localId);
      if (row.serverOutcomeId) return { outcomeId: row.serverOutcomeId };
      await ctx.server.call({
        endpoint: 'outcome/draft-create',
        effect: { kind: 'outcome-draft-created', key: localId },
        idempotencyKey: `draft-${localId}`,
      });
      if (!row.serverOutcomeId) row.serverOutcomeId = state.nextServerId++;
      return { outcomeId: row.serverOutcomeId };
    },
  });
}

function makeStage2(ctx: ParityContext<ParityClient>, tag: string, prefix: string) {
  return defineActivity({
    name: `${prefix}.stage2SyncWorkflowData`,
    retry: { maximumAttempts: 10, initialInterval: 300 },
    runWhen: rc => (rc.isConnected ? { ready: true } : { ready: false, reason: 'offline' }),
    execute: async a => {
      bump(`${tag}.stage2`);
      const outcomeId = Number(a.input.outcomeId);
      if (!(outcomeId > 0)) throw new Error('stage2 requires a server-side outcomeId');
      const merge = a.input.merge as Record<string, unknown> | undefined;
      if (!merge || Object.keys(merge).length === 0) return { merged: false };
      await ctx.server.call({
        endpoint: 'outcome/data-merge',
        effect: { kind: 'outcome-data-merged', key: String(outcomeId), details: merge },
      });
      state.serverData.set(outcomeId, { ...(state.serverData.get(outcomeId) ?? {}), ...merge });
      return { merged: true };
    },
  });
}

function makeStage3(ctx: ParityContext<ParityClient>) {
  return defineActivity({
    name: 'outcomeSubmit.stage3Submit',
    retry: { maximumAttempts: 10, initialInterval: 300 },
    runWhen: rc => (rc.isConnected ? { ready: true } : { ready: false, reason: 'offline' }),
    execute: async a => {
      bump('submit.stage3');
      const localId = String(a.input.localOutcomeId);
      const row = rowOf(localId);
      const outcomeId = Number(a.input.outcomeId);
      if (!(outcomeId > 0)) throw new Error('stage3 requires a server-side outcomeId');
      try {
        const result = await ctx.server.call({
          endpoint: 'outcome/submit',
          effect: { kind: 'outcome-submitted', key: String(outcomeId) },
          idempotencyKey: `submit-${outcomeId}`,
        });
        // A duplicate return is the server's status:'new' guard absorbing
        // a resubmit — success-no-op, markLocalSynced parity either way.
        row.localStatus = 'synced';
        row.localPendingSubmission = false;
        row.submissionError = undefined;
        return { submitted: true, duplicate: result.duplicate === true };
      } catch (err) {
        if (err instanceof PermanentRefusalError) {
          // InvalidTransitionError parity — the branch depends on local state.
          if (row.localStatus === 'void') {
            // Racing a concurrent dispatch void: flag the row, complete the
            // stage (no throw), record that the intent could not land.
            row.submissionError = 'Outcome was canceled by dispatch';
            return { submitted: false, submissionError: row.submissionError };
          }
          // Not racing a void: already submitted server-side → success-no-op.
          row.localStatus = 'synced';
          row.localPendingSubmission = false;
          return { submitted: true, viaInvalidTransition: true };
        }
        throw err; // transient → engine retries this stage only
      }
    },
  });
}

function buildSubmitWorkflow(ctx: ParityContext<ParityClient>): Workflow {
  return defineWorkflow({
    name: 'outcome.submit.parity',
    activities: [makeStage1(ctx, 'submit', 'outcomeSubmit'), makeStage2(ctx, 'submit', 'outcomeSubmit'), makeStage3(ctx)],
  });
}

function buildMidfillWorkflow(ctx: ParityContext<ParityClient>): Workflow {
  return defineWorkflow({
    name: 'outcome.midfill.parity',
    activities: [makeStage1(ctx, 'sync', 'outcomeWorkflowDataSync'), makeStage2(ctx, 'sync', 'outcomeWorkflowDataSync')],
  });
}

export const outcomeSubmit: ParityScenario<ParityClient> = {
  scenarioId: 'outcome-submit',
  name: 'Outcome submit parity (no double-submit)',
  category: 3,
  engineMode: 'manual',

  register(client, ctx) {
    client.registerWorkflow(buildSubmitWorkflow(ctx));
    client.registerWorkflow(buildMidfillWorkflow(ctx));
  },

  async run(ctx, t) {
    state.stageRuns = {};
    state.rows.clear();
    state.serverData.clear();
    state.nextServerId = 9001;

    const seedRow = (localId: string) =>
      state.rows.set(localId, { localStatus: 'submitted', localPendingSubmission: true });
    const start = (workflowName: string, localId: string, moveId: number, merge: Record<string, unknown>) => {
      const workflow = ctx.client.engine.getWorkflow(workflowName)!;
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

    await t.step('mid-fill sync never submits; submit chain runs draft → sync → submit in order', async () => {
      seedRow('O1');
      const midfill = await start('outcome.midfill.parity', 'O1', 301, { q: 'filled' });
      await tickUntil(ctx, 'mid-fill completion', async () => (await execOf(ctx, midfill.runId)).status === 'completed');
      t.assertEqual('mid-fill sync produced no submit effect', 0,
        ctx.server.getEffects().filter(e => e.kind === 'outcome-submitted').length);

      const submit = await start('outcome.submit.parity', 'O1', 301, { final: true });
      await tickUntil(ctx, 'submit completion', async () => (await execOf(ctx, submit.runId)).status === 'completed');

      const serverId = serverIdOf('O1');
      const effects = ctx.server.getEffects();
      const draftIdx = effects.findIndex(e => e.kind === 'outcome-draft-created' && e.key === 'O1');
      const firstMergeIdx = effects.findIndex(e => e.kind === 'outcome-data-merged' && e.key === String(serverId));
      const lastMergeIdx = effects.reduce((acc, e, i) => (e.kind === 'outcome-data-merged' && e.key === String(serverId) ? i : acc), -1);
      const submitIdx = effects.findIndex(e => e.kind === 'outcome-submitted' && e.key === String(serverId));
      t.assert('draft before merges before submit', draftIdx >= 0 && firstMergeIdx > draftIdx && submitIdx > lastMergeIdx,
        'draftIdx < mergeIdx… < submitIdx', { draftIdx, firstMergeIdx, lastMergeIdx, submitIdx });
      t.assertEqual('exactly one submitted effect', 1, ctx.server.effectCount('outcome-submitted', String(serverId)));
      t.assertEqual('submit chain reused the mid-fill draft', 1, ctx.server.effectCount('outcome-draft-created', 'O1'));
      const row = rowOf('O1');
      t.assertEqual('local row marked synced and not pending', { localStatus: 'synced', localPendingSubmission: false },
        { localStatus: row.localStatus, localPendingSubmission: row.localPendingSubmission });
    });

    await t.step('concurrent submit attempts do not double-submit', async () => {
      state.stageRuns = {};
      seedRow('O2');
      const first = await start('outcome.submit.parity', 'O2', 302, { report: 'v1' });
      const second = await start('outcome.submit.parity', 'O2', 302, { report: 'v1' });
      await tickUntil(ctx, 'both submits completed', async () => {
        const a = await execOf(ctx, first.runId);
        const b = await execOf(ctx, second.runId);
        return a.status === 'completed' && b.status === 'completed';
      });
      const serverId = serverIdOf('O2');
      const a = await execOf(ctx, first.runId);
      const b = await execOf(ctx, second.runId);
      t.assertEqual('exactly one submitted business effect', 1, ctx.server.effectCount('outcome-submitted', String(serverId)));
      t.assert('both submit intents completed — neither silently dropped',
        a.status === 'completed' && b.status === 'completed' && a.state.submitted === true && b.state.submitted === true,
        'both completed with submitted:true', { a: a.state.submitted, b: b.state.submitted });
      t.assertEqual('one draft under concurrent submits', 1, ctx.server.effectCount('outcome-draft-created', 'O2'));
    });

    await t.step('failed submit resumes at submit with draft and workflow data intact', async () => {
      state.stageRuns = {};
      seedRow('O3');
      ctx.server.script('outcome/submit', 'transient-failure');
      const execution = await start('outcome.submit.parity', 'O3', 303, { damage: 'scratch' });
      await tickUntil(ctx, 'first submit attempt failed', async () => (state.stageRuns['submit.stage3'] ?? 0) >= 1);
      await ctx.restart();
      await tickUntil(ctx, 'completion after restart', async () => (await execOf(ctx, execution.runId)).status === 'completed');

      const serverId = serverIdOf('O3');
      t.assertEqual('stage1/stage2 not re-run; only submit retried', { stage1: 1, stage2: 1, stage3: 2 }, {
        stage1: state.stageRuns['submit.stage1'] ?? 0,
        stage2: state.stageRuns['submit.stage2'] ?? 0,
        stage3: state.stageRuns['submit.stage3'] ?? 0,
      });
      t.assertEqual('exactly one submitted effect after the retry', 1, ctx.server.effectCount('outcome-submitted', String(serverId)));
      const final = await execOf(ctx, execution.runId);
      t.assert('draft identity and workflow data survived the crash',
        final.state.outcomeId === serverId && state.serverData.get(serverId)?.damage === 'scratch',
        { outcomeId: serverId, damage: 'scratch' },
        { outcomeId: final.state.outcomeId, damage: state.serverData.get(serverId)?.damage });
    });

    await t.step('duplicate submit after completion is absorbed by domain idempotency, not dropped', async () => {
      state.stageRuns = {};
      const serverId = serverIdOf('O1');
      const resubmit = await start('outcome.submit.parity', 'O1', 301, {});
      await tickUntil(ctx, 'resubmit completion', async () => (await execOf(ctx, resubmit.runId)).status === 'completed');
      const final = await execOf(ctx, resubmit.runId);
      t.assertEqual('resubmit completed — intent honored', 'completed', final.status);
      t.assertEqual('server absorbed it as a duplicate', true, final.state.duplicate);
      t.assertEqual('still exactly one submitted effect', 1, ctx.server.effectCount('outcome-submitted', String(serverId)));
    });

    await t.step('submit racing a concurrent void flags the row without a submit effect or dead letter', async () => {
      state.stageRuns = {};
      seedRow('O5');
      ctx.server.script('outcome/submit', 'permanent-refusal');
      const execution = await start('outcome.submit.parity', 'O5', 305, { q: 'late edit' });
      // Dispatch voids the outcome before the submit stage runs.
      rowOf('O5').localStatus = 'void';
      await tickUntil(ctx, 'void-race completion', async () => (await execOf(ctx, execution.runId)).status === 'completed');

      const serverId = serverIdOf('O5');
      const final = await execOf(ctx, execution.runId);
      const row = rowOf('O5');
      t.assertEqual('workflow completed without retry-looping', 'completed', final.status);
      t.assert('local row flagged canceled-by-dispatch', /canceled by dispatch/i.test(row.submissionError ?? ''),
        '/canceled by dispatch/i', row.submissionError);
      t.assertEqual('no submitted effect for the voided outcome', 0, ctx.server.effectCount('outcome-submitted', String(serverId)));
      t.assert('the failed intent is inspectable on the execution',
        final.state.submitted === false && typeof final.state.submissionError === 'string',
        'state.submitted === false with submissionError', { submitted: final.state.submitted, submissionError: final.state.submissionError });
      const deadLetters = await ctx.client.storage.getDeadLetters();
      t.assertEqual('nothing dead-lettered by the void race', 0, deadLetters.length);
    });
  },
};
