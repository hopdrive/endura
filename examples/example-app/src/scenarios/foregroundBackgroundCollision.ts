/**
 * Scenario 10 — Foreground and Background Collision (review §Scenario 10).
 *
 * The production case that gates any endura background execution: the
 * foreground engine claims a long-running task, and a background wake
 * (a SECOND engine instance over the same database — the runner's
 * backgroundWake) starts while that task is active.
 *
 * The lease is the contract: the background engine's crash recovery
 * must not reset a task whose lease is unexpired (that engine is alive
 * and mid-task), the task cannot be claimed twice (status CAS), no
 * attempts are falsely burned, and exactly one business effect lands.
 */

import { defineActivity, defineWorkflow, Workflow, ActivityTask } from 'endura';
import { ParityScenario, ParityContext } from '../harness/runner';
import { ParityClient } from '../harness/expoPlatform';
import { execOf } from './util';

/** Per-run mutable state; reset at the top of run(), survives restarts. */
const state = {
  stageRuns: 0,
};

function buildWorkflow(ctx: ParityContext<ParityClient>): Workflow {
  const longSync = defineActivity({
    name: 'longSync',
    startToCloseTimeout: 15000,
    retry: { maximumAttempts: 3, initialInterval: 300 },
    execute: async a => {
      state.stageRuns += 1;
      const jobId = String(a.input.jobId);
      // A deliberately slow server round-trip: long enough for a whole
      // background wake to come and go while this attempt is in flight.
      ctx.server.script('collision/long-sync', { kind: 'slow', delayMs: 2500 });
      await ctx.server.call({
        endpoint: 'collision/long-sync',
        effect: { kind: 'long-synced', key: jobId },
        idempotencyKey: `long-${jobId}`,
      });
      return { synced: true };
    },
  });

  return defineWorkflow({
    name: 'collision.parity',
    activities: [longSync],
  });
}

export const foregroundBackgroundCollision: ParityScenario<ParityClient> = {
  scenarioId: 'fg-bg-collision',
  name: 'Foreground/background collision (lease protects active task)',
  category: 10,
  engineMode: 'manual',

  register(client, ctx) {
    client.registerWorkflow(buildWorkflow(ctx));
  },

  async run(ctx, t) {
    state.stageRuns = 0;

    const workflow = ctx.client.engine.getWorkflow('collision.parity')!;
    const execution = await ctx.client.engine.start(workflow, {
      input: { jobId: 'C1' },
      metadata: { jobId: 'C1' },
    });

    await t.step('background wake during an active foreground task neither resets nor re-claims it', async () => {
      // Foreground claims and starts the 2.5s task — deliberately not
      // awaited so the background wake overlaps it.
      const foregroundTick = ctx.client.tick();
      await ctx.sleep(400);

      const activeDuring = (await ctx.client.storage.getActivityTasksByStatus('active')) as ActivityTask[];
      t.assertEqual('task active under the foreground lease when the wake starts', 1, activeDuring.length);

      // Second engine over the same database, alive for 1.2s while the
      // foreground attempt is still in flight.
      await ctx.backgroundWake(1200);

      const activeAfterWake = (await ctx.client.storage.getActivityTasksByStatus('active')) as ActivityTask[];
      t.assertEqual('background engine did not reset the leased task', 1, activeAfterWake.length);
      t.assertEqual('still the first and only claim (no double-claim, no false attempts)', 1, activeAfterWake[0]?.attempts);

      await foregroundTick;
    });

    await t.step('the workflow completes exactly once with one business effect', async () => {
      const final = await execOf(ctx, execution.runId);
      t.assertEqual('workflow completed', 'completed', final.status);
      t.assertEqual('activity executed exactly once across both engines', 1, state.stageRuns);
      t.assertEqual('exactly one business effect', 1, ctx.server.effectCount('long-synced', 'C1'));
      const tasks = (await ctx.client.storage.getActivityTasksByStatus('completed')) as ActivityTask[];
      t.assertEqual('one completed task with one attempt', { count: 1, attempts: 1 },
        { count: tasks.length, attempts: tasks[0]?.attempts });
      t.assertEqual('no dead letters from the collision', 0, (await ctx.client.engine.getDeadLetters()).length);
    });
  },
};
