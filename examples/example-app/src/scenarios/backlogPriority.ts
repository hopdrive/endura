/**
 * Scenario 14 — Backlog Drain With Priority (review §Scenario 14).
 *
 * A large post-offline backlog must drain highest-priority first with
 * FIFO inside each priority — the driver app's jobOptions priorities
 * (extraction: moveStatusSync 50, outcomeSubmit stages 40, sendEventLog
 * 10, photoUpload 5; FIFO within priority via RNQ created-order).
 *
 * Endura mapping: ActivityOptions.priority + the storage frontier query
 * (ORDER BY priority DESC, created_at ASC). The fake server's effect
 * ledger is chronological, so the drain order IS the effects order.
 */

import { defineActivity, defineWorkflow, Workflow } from 'endura';
import { ParityScenario, ParityContext } from '../harness/runner';
import { ParityClient } from '../harness/expoPlatform';
import { tickUntil, execOf } from './util';

const PIPELINES = [
  { name: 'moveStatusSync', priority: 50 },
  { name: 'outcomeSync', priority: 40 },
  { name: 'sendEventLog', priority: 10 },
  { name: 'photoUpload', priority: 5 },
] as const;

function buildWorkflows(ctx: ParityContext<ParityClient>): Workflow[] {
  return PIPELINES.map(pipeline =>
    defineWorkflow({
      name: `backlog.${pipeline.name}.parity`,
      activities: [
        defineActivity({
          name: pipeline.name,
          priority: pipeline.priority,
          retry: { maximumAttempts: 3, initialInterval: 300 },
          runWhen: rc => (rc.isConnected ? { ready: true } : { ready: false, reason: 'offline', retryInMs: 400 }),
          execute: async a => {
            const jobId = String(a.input.jobId);
            await ctx.server.call({
              endpoint: `backlog/${pipeline.name}`,
              effect: { kind: 'drained', key: jobId, details: { priority: pipeline.priority } },
              idempotencyKey: `drain-${jobId}`,
            });
            return { drained: true };
          },
        }),
      ],
    })
  );
}

export const backlogPriority: ParityScenario<ParityClient> = {
  scenarioId: 'backlog-priority',
  name: 'Backlog drain with priority (50/40/10/5, FIFO within)',
  category: 14,
  engineMode: 'manual',

  async run(ctx, t) {
    const runIds: string[] = [];

    await t.step('a realistic backlog queues while offline', async () => {
      ctx.setOnline(false);
      // Interleave enqueue order across priorities — 3 jobs per pipeline,
      // 12 total — so drain order cannot accidentally mirror insert order.
      for (let i = 1; i <= 3; i++) {
        for (const pipeline of [...PIPELINES].reverse()) {
          const workflow = ctx.client.engine.getWorkflow(`backlog.${pipeline.name}.parity`)!;
          const execution = await ctx.client.engine.start(workflow, {
            input: { jobId: `${pipeline.name}-${i}` },
            metadata: { pipeline: pipeline.name, sequence: i },
          });
          runIds.push(execution.runId);
          await ctx.sleep(15); // distinct created_at ordering
        }
      }
      t.assertEqual('twelve workflows queued', 12, runIds.length);
      t.assertEqual('nothing drained while offline', 0, ctx.server.getEffects().length);
    });

    await t.step('reconnecting drains in priority order, FIFO within each priority', async () => {
      ctx.setOnline(true);
      await tickUntil(ctx, 'backlog fully drained', async () => {
        const statuses = await Promise.all(runIds.map(runId => execOf(ctx, runId)));
        return statuses.every(execution => execution.status === 'completed');
      }, 60000);

      const drainOrder = ctx.server.getEffects().filter(e => e.kind === 'drained');
      t.log(`drain order: ${drainOrder.map(e => e.key).join(', ')}`);

      const priorities = drainOrder.map(e => Number(e.details?.priority));
      const sortedDescending = [...priorities].sort((a, b) => b - a);
      t.assertEqual('higher-priority pipelines drained first', sortedDescending, priorities);

      for (const pipeline of PIPELINES) {
        const keys = drainOrder.filter(e => e.key.startsWith(`${pipeline.name}-`)).map(e => e.key);
        t.assertEqual(`FIFO preserved within priority ${pipeline.priority} (${pipeline.name})`,
          [`${pipeline.name}-1`, `${pipeline.name}-2`, `${pipeline.name}-3`], keys);
      }
    });

    await t.step('low-priority work is not starved and the drain is inspectable afterwards', async () => {
      t.assertEqual('all twelve drained (nothing starved)', 12, ctx.server.getEffects().filter(e => e.kind === 'drained').length);
      const completed = await ctx.client.getExecutions({ status: 'completed' });
      t.assertEqual('all twelve executions inspectable as completed', 12, completed.length);
      const photoRuns = completed.filter(e => (e.metadata as Record<string, unknown>)?.pipeline === 'photoUpload');
      t.assertEqual('lowest-priority pipeline fully drained', 3, photoRuns.length);
      t.assertEqual('no dead letters from the drain', 0, (await ctx.client.engine.getDeadLetters()).length);
    });
  },

  register(client, ctx) {
    for (const workflow of buildWorkflows(ctx)) client.registerWorkflow(workflow);
  },
};
