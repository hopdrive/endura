/**
 * Scenario 9 — Offline Mid-Stage Failure (review §Scenario 9).
 *
 * A workflow starts online, the connection drops WHILE a stage's
 * request is in flight (modeled by the fake server rejecting with a
 * network error while the environment still reports online — a dropped
 * socket), and the device then goes fully offline before the retry.
 *
 * Explicit policy under test: the in-flight failure consumes one retry
 * attempt (it was a real attempt), subsequent attempts are HELD by
 * runWhen without burning budget, prior completed stages are never
 * re-run, and reconnecting resumes at the failed stage with no
 * duplicate downstream effects.
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
  const prepare = defineActivity({
    name: 'prepare',
    retry: { maximumAttempts: 3, initialInterval: 300 },
    execute: async a => {
      bump('prepare');
      return { prepared: true, payloadId: `payload-${String(a.input.jobId)}` };
    },
  });

  const push = defineActivity({
    name: 'push',
    retry: { maximumAttempts: 5, initialInterval: 300 },
    runWhen: rc => (rc.isConnected ? { ready: true } : { ready: false, reason: 'offline', retryInMs: 400 }),
    execute: async a => {
      bump('push');
      const jobId = String(a.input.jobId);
      if (typeof a.input.payloadId !== 'string') throw new Error('push did not receive prepared payload');
      await ctx.server.call({
        endpoint: 'sync/push',
        effect: { kind: 'midstage-pushed', key: jobId },
        idempotencyKey: `push-${jobId}`,
      });
      return { pushed: true };
    },
  });

  const confirm = defineActivity({
    name: 'confirm',
    retry: { maximumAttempts: 5, initialInterval: 300 },
    runWhen: rc => (rc.isConnected ? { ready: true } : { ready: false, reason: 'offline', retryInMs: 400 }),
    execute: async a => {
      bump('confirm');
      const jobId = String(a.input.jobId);
      await ctx.server.call({
        endpoint: 'sync/confirm',
        effect: { kind: 'midstage-confirmed', key: jobId },
        idempotencyKey: `confirm-${jobId}`,
      });
      return { confirmed: true };
    },
  });

  return defineWorkflow({
    name: 'offline.midstage.parity',
    activities: [prepare, push, confirm],
  });
}

export const offlineMidStage: ParityScenario<ParityClient> = {
  scenarioId: 'offline-mid-stage',
  name: 'Offline mid-stage failure (drop during push, resume at push)',
  category: 9,
  engineMode: 'manual',

  register(client, ctx) {
    client.registerWorkflow(buildWorkflow(ctx));
  },

  async run(ctx, t) {
    state.stageRuns = {};

    const workflow = ctx.client.engine.getWorkflow('offline.midstage.parity')!;
    const execution = await ctx.client.engine.start(workflow, {
      input: { jobId: 'M1' },
      metadata: { jobId: 'M1' },
    });

    await t.step('the connection drops mid-request: the in-flight push fails per explicit retry policy', async () => {
      // The socket dies while the request is in flight — the server
      // rejects with a network error even though the device still
      // believes it is online.
      ctx.server.script('sync/push', 'offline');
      await tickUntil(ctx, 'first push attempt failed', async () => (state.stageRuns.push ?? 0) >= 1);
      // Now the device notices it is offline.
      ctx.setOnline(false);

      t.assertEqual('prepare completed before the drop', 1, state.stageRuns.prepare ?? 0);
      t.assertEqual('push attempted once (a real attempt, one retry consumed)', 1, state.stageRuns.push ?? 0);
      t.assertEqual('workflow still running', 'running', (await execOf(ctx, execution.runId)).status);
      t.assertEqual('no pushed effect from the dropped request', 0, ctx.server.effectCount('midstage-pushed', 'M1'));
    });

    await t.step('while offline the retry is held and prior stages are not lost', async () => {
      for (let i = 0; i < 4; i++) {
        await ctx.client.tick();
        await ctx.sleep(450);
      }
      t.assertEqual('push not re-attempted while offline (held, no burn)', 1, state.stageRuns.push ?? 0);
      t.assertEqual('prepare never re-ran', 1, state.stageRuns.prepare ?? 0);
      t.assertEqual('confirm never ran early', 0, state.stageRuns.confirm ?? 0);
      t.assertEqual('workflow still running through the outage', 'running', (await execOf(ctx, execution.runId)).status);
    });

    await t.step('reconnect resumes at the failed stage with no duplicate downstream effects', async () => {
      ctx.setOnline(true);
      await tickUntil(ctx, 'completion after reconnect', async () => (await execOf(ctx, execution.runId)).status === 'completed');

      t.assertEqual('resumed at push, not stage one', { prepare: 1, push: 2, confirm: 1 }, {
        prepare: state.stageRuns.prepare ?? 0,
        push: state.stageRuns.push ?? 0,
        confirm: state.stageRuns.confirm ?? 0,
      });
      t.assertEqual('exactly one pushed effect', 1, ctx.server.effectCount('midstage-pushed', 'M1'));
      t.assertEqual('exactly one confirmed effect', 1, ctx.server.effectCount('midstage-confirmed', 'M1'));
      const final = await execOf(ctx, execution.runId);
      t.assert('accumulated payload survived the outage', final.state.prepared === true && final.state.pushed === true && final.state.confirmed === true,
        'prepared+pushed+confirmed all true', { prepared: final.state.prepared, pushed: final.state.pushed, confirmed: final.state.confirmed });
    });
  },
};
