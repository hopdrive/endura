/**
 * Scenario 1 — Photo Pipeline Parity (review §Scenario 1).
 *
 * Models driver-app-3's photo.pipeline: photoCapture → photoResize →
 * photoBlurHash → photoPending → photoUpload → photoSave, with the
 * accumulated-payload contract, crash-resume at the correct stage,
 * retry-without-rerunning-prior-stages, stale-late-result protection,
 * and already-uploaded reconciliation (extraction: pipelines-batch1.md,
 * test-suite-behaviors.md §3/§8).
 *
 * Engine mode is manual: the scenario ticks explicitly so every
 * crash/restart point is deterministic.
 */

import { defineActivity, defineWorkflow, Workflow, WorkflowExecution } from 'endura';
import { ParityScenario, ParityContext } from '../harness/runner';
import { ParityClient } from '../harness/expoPlatform';

/** Per-run mutable state; reset at the top of run(), survives restarts. */
const state = {
  stageRuns: {} as Record<string, number>,
  files: new Map<string, string>(),
  hangPendingOnce: false,
};

function bump(stage: string): void {
  state.stageRuns[stage] = (state.stageRuns[stage] ?? 0) + 1;
}

async function tickUntil(
  ctx: ParityContext<ParityClient>,
  what: string,
  condition: () => Promise<boolean>,
  timeoutMs = 30000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await ctx.client.tick();
    if (await condition()) return;
    await ctx.sleep(100);
  }
  throw new Error(`timed out ticking until ${what}`);
}

async function execOf(ctx: ParityContext<ParityClient>, runId: string): Promise<WorkflowExecution> {
  const execution = await ctx.client.getExecution(runId);
  if (!execution) throw new Error(`execution ${runId} missing`);
  return execution;
}

function buildWorkflow(ctx: ParityContext<ParityClient>): Workflow {
  const capture = defineActivity({
    name: 'photoCapture',
    retry: { maximumAttempts: 10, initialInterval: 300 },
    execute: async a => {
      bump('capture');
      const photoId = String(a.input.photoId);
      state.files.set(photoId, `file://photos/${photoId}.jpg`);
      return { uri: `file://photos/${photoId}.jpg`, metadata: { original: true, capturedAt: 1 } };
    },
  });

  const resize = defineActivity({
    name: 'photoResize',
    retry: { maximumAttempts: 5, initialInterval: 300 },
    execute: async a => {
      bump('resize');
      const photoId = String(a.input.photoId);
      // Parity with photoResize missing-source reconciliation: a missing
      // local file with the photo already on the server resolves forward,
      // never a retry loop.
      if (!state.files.has(photoId)) {
        if (ctx.server.effectCount('photo-uploaded', photoId) > 0) {
          return { reconciled: 'already-uploaded', metadata: { width: 0, height: 0 } };
        }
        throw new Error('source file missing and never uploaded');
      }
      const metadata = a.input.metadata as Record<string, unknown>;
      return { metadata: { ...metadata, width: 1920, height: 1080 } };
    },
  });

  const blurHash = defineActivity({
    name: 'photoBlurHash',
    retry: { maximumAttempts: 1 },
    execute: async a => {
      bump('blurHash');
      const metadata = a.input.metadata as Record<string, unknown>;
      if (!metadata?.original || !metadata?.width) {
        throw new Error('blurHash did not receive accumulated capture+resize metadata');
      }
      return { blurHash: 'LKO2?U%2Tw=w' };
    },
  });

  const pending = defineActivity({
    name: 'photoPending',
    startToCloseTimeout: 1200,
    retry: { maximumAttempts: 10, initialInterval: 300 },
    runWhen: rc => (rc.isConnected ? { ready: true } : { ready: false, reason: 'offline' }),
    execute: async a => {
      bump('pending');
      const photoId = String(a.input.photoId);
      if (state.hangPendingOnce) {
        state.hangPendingOnce = false;
        ctx.server.script('photo/pending', { kind: 'hung' });
      }
      await ctx.server.call({
        endpoint: 'photo/pending',
        effect: { kind: 'photo-pending', key: photoId },
        idempotencyKey: `pending-${photoId}`,
      });
      return { serverStatus: 'pending' };
    },
  });

  const upload = defineActivity({
    name: 'photoUpload',
    retry: { maximumAttempts: 3, initialInterval: 300 },
    runWhen: rc => (rc.isConnected ? { ready: true } : { ready: false, reason: 'offline' }),
    execute: async a => {
      bump('upload');
      const photoId = String(a.input.photoId);
      // Already-uploaded short-circuit (photoUpload worker parity).
      if (ctx.server.effectCount('photo-uploaded', photoId) > 0) {
        return { url: `https://cdn.fake/${photoId}.jpg`, uploadSkipped: true };
      }
      if (!a.input.blurHash && !a.input.reconciled) {
        throw new Error('upload did not receive accumulated blurHash payload');
      }
      await ctx.server.call({
        endpoint: 'photo/upload',
        effect: { kind: 'photo-uploaded', key: photoId },
        idempotencyKey: `upload-${photoId}`,
      });
      state.files.delete(photoId); // deleteOnSuccess parity
      return { url: `https://cdn.fake/${photoId}.jpg` };
    },
  });

  const save = defineActivity({
    name: 'photoSave',
    retry: { maximumAttempts: 10, initialInterval: 300 },
    runWhen: rc => (rc.isConnected ? { ready: true } : { ready: false, reason: 'offline' }),
    execute: async a => {
      bump('save');
      const photoId = String(a.input.photoId);
      if (typeof a.input.url !== 'string') throw new Error('save did not receive upload url');
      await ctx.server.call({
        endpoint: 'photo/save',
        effect: { kind: 'photo-saved', key: photoId, details: { url: a.input.url } },
        idempotencyKey: `save-${photoId}`,
      });
      return { serverStatus: 'done' };
    },
  });

  return defineWorkflow({
    name: 'photo.parity',
    activities: [capture, resize, blurHash, pending, upload, save],
  });
}

export const photoParity: ParityScenario<ParityClient> = {
  scenarioId: 'photo-parity',
  name: 'Photo pipeline parity (6-stage)',
  category: 1,
  engineMode: 'manual',

  register(client, ctx) {
    client.registerWorkflow(buildWorkflow(ctx));
  },

  async run(ctx, t) {
    state.stageRuns = {};
    state.files.clear();
    state.hangPendingOnce = false;

    const startPhoto = (photoId: string, moveId: number) => {
      const workflow = ctx.client.engine.getWorkflow('photo.parity')!;
      return ctx.client.engine.start(workflow, {
        input: { photoId, moveId },
        metadata: { moveId, photoId },
      });
    };

    let runA = '';
    await t.step('crash after resize resumes at blurHash; full chain completes exactly once', async () => {
      const execution = await startPhoto('P1', 101);
      runA = execution.runId;

      await tickUntil(ctx, 'resize completed', async () => {
        const current = await execOf(ctx, runA);
        return current.currentActivityName === 'photoBlurHash';
      });
      t.assertEqual('capture+resize ran once before crash', { capture: 1, resize: 1 }, {
        capture: state.stageRuns.capture ?? 0,
        resize: state.stageRuns.resize ?? 0,
      });

      await ctx.restart();
      await tickUntil(ctx, 'completion after restart', async () => (await execOf(ctx, runA)).status === 'completed');

      const final = await execOf(ctx, runA);
      t.assertEqual(
        'every stage ran exactly once (resume at blurHash, no re-runs)',
        { capture: 1, resize: 1, blurHash: 1, pending: 1, upload: 1, save: 1 },
        {
          capture: state.stageRuns.capture ?? 0,
          resize: state.stageRuns.resize ?? 0,
          blurHash: state.stageRuns.blurHash ?? 0,
          pending: state.stageRuns.pending ?? 0,
          upload: state.stageRuns.upload ?? 0,
          save: state.stageRuns.save ?? 0,
        }
      );
      t.assert(
        'capture/resize metadata survived to the end',
        (final.state.metadata as Record<string, unknown>)?.original === true &&
          (final.state.metadata as Record<string, unknown>)?.width === 1920 &&
          final.state.blurHash === 'LKO2?U%2Tw=w' &&
          typeof final.state.url === 'string',
        'accumulated metadata + blurHash + url',
        JSON.stringify({ metadata: final.state.metadata, blurHash: final.state.blurHash, url: final.state.url })
      );
      t.assert('exactly one uploaded/saved business effect', ctx.server.effectCount('photo-uploaded', 'P1') === 1 && ctx.server.effectCount('photo-saved', 'P1') === 1, 1, {
        uploaded: ctx.server.effectCount('photo-uploaded', 'P1'),
        saved: ctx.server.effectCount('photo-saved', 'P1'),
      });
    });

    await t.step('crash after pending resumes at upload', async () => {
      state.stageRuns = {};
      const execution = await startPhoto('P2', 102);
      await tickUntil(ctx, 'pending completed', async () => {
        const current = await execOf(ctx, execution.runId);
        return current.currentActivityName === 'photoUpload';
      });
      await ctx.restart();
      await tickUntil(ctx, 'completion', async () => (await execOf(ctx, execution.runId)).status === 'completed');
      t.assertEqual('post-crash stages: upload+save once, pending not re-run', { pending: 1, upload: 1, save: 1 }, {
        pending: state.stageRuns.pending ?? 0,
        upload: state.stageRuns.upload ?? 0,
        save: state.stageRuns.save ?? 0,
      });
    });

    await t.step('failed upload retries without re-running prior stages', async () => {
      state.stageRuns = {};
      ctx.server.script('photo/upload', 'transient-failure');
      const execution = await startPhoto('P3', 103);
      await tickUntil(ctx, 'completion', async () => (await execOf(ctx, execution.runId)).status === 'completed');
      t.assertEqual('upload ran twice, all prior stages once', { capture: 1, resize: 1, blurHash: 1, pending: 1, upload: 2, save: 1 }, {
        capture: state.stageRuns.capture ?? 0,
        resize: state.stageRuns.resize ?? 0,
        blurHash: state.stageRuns.blurHash ?? 0,
        pending: state.stageRuns.pending ?? 0,
        upload: state.stageRuns.upload ?? 0,
        save: state.stageRuns.save ?? 0,
      });
      t.assert('still exactly one uploaded effect for P3', ctx.server.effectCount('photo-uploaded', 'P3') === 1, 1, ctx.server.effectCount('photo-uploaded', 'P3'));
    });

    await t.step('late result from a timed-out stage cannot corrupt an advanced workflow', async () => {
      state.stageRuns = {};
      state.hangPendingOnce = true; // first pending call hangs past its 1200ms timeout
      const execution = await startPhoto('P4', 104);
      await tickUntil(ctx, 'completion despite hung first pending call', async () => {
        const current = await execOf(ctx, execution.runId);
        return current.status === 'completed';
      }, 45000);

      // Now release the stuck original call — the late server effect must
      // be absorbed by idempotency and the execution must stay completed.
      ctx.server.releaseHung();
      await ctx.sleep(300);
      await ctx.client.tick();

      const final = await execOf(ctx, execution.runId);
      t.assertEqual('execution still completed after late result', 'completed', final.status);
      t.assert('pending ran twice (timeout retry), later stages once', (state.stageRuns.pending ?? 0) >= 2 && state.stageRuns.save === 1, { pendingAtLeast: 2, save: 1 }, {
        pending: state.stageRuns.pending,
        save: state.stageRuns.save,
      });
      t.assert('exactly one pending business effect (late duplicate absorbed)', ctx.server.effectCount('photo-pending', 'P4') === 1, 1, ctx.server.effectCount('photo-pending', 'P4'));
    });

    await t.step('already-uploaded photo reconciles to complete instead of re-arming local work', async () => {
      state.stageRuns = {};
      // Server already has the photo; local file was consumed long ago.
      await ctx.server.call({
        endpoint: 'photo/upload',
        effect: { kind: 'photo-uploaded', key: 'P5' },
        idempotencyKey: 'upload-P5',
      });
      const execution = await startPhoto('P5', 105);
      // Sabotage: capture "loses" the file immediately (simulates stale
      // pre-upload work whose source is gone).
      state.files.delete('P5');
      await tickUntil(ctx, 'completion via reconciliation', async () => (await execOf(ctx, execution.runId)).status === 'completed');
      const final = await execOf(ctx, execution.runId);
      t.assert('resize reconciled forward', final.state.reconciled === 'already-uploaded' || final.state.uploadSkipped === true, 'reconciled or skipped', JSON.stringify({ reconciled: final.state.reconciled, uploadSkipped: final.state.uploadSkipped }));
      t.assert('no second upload effect for P5', ctx.server.effectCount('photo-uploaded', 'P5') === 1, 1, ctx.server.effectCount('photo-uploaded', 'P5'));
    });

    await t.step('completed executions are inspectable by move context', async () => {
      const all = await ctx.client.getExecutions({ workflowName: 'photo.parity', status: 'completed' });
      const forMove101 = all.filter(e => (e.metadata as Record<string, unknown>)?.moveId === 101);
      t.assertEqual('one completed photo execution scoped to move 101', 1, forMove101.length);
      t.assertEqual('scoped run is runA', runA, forMove101[0]?.runId);
    });
  },
};
