/**
 * uniqueKey semantics tests (review issue C7).
 *
 * The unique index used to cover (workflow_name, unique_key) regardless
 * of status, and saveExecution used INSERT OR REPLACE — so reusing a key
 * after completion silently DELETED the completed execution's history
 * (and its tasks, via cascade). The index is now scoped to
 * status='running': one live execution per key, full history preserved,
 * and the database — not a read-then-write check — is the final arbiter.
 */

import { WorkflowEngine } from '../../src/core/engine';
import { MockClock, MockScheduler, MockEnvironment } from '../../src/core/mocks';
import { defineActivity } from '../../src/core/definitions';
import { Workflow, WorkflowExecution, UniqueConstraintError } from '../../src/core/types';
import { SQLiteStorage } from '../../src/storage/sqlite';
import { BetterSqlite3Driver } from '../../src/storage/sqlite/internal/BetterSqlite3Driver';

const workflow: Workflow = {
  name: 'keyed',
  activities: [
    defineActivity({
      name: 'work',
      execute: async () => ({ done: true }),
      retry: { maximumAttempts: 3 },
    }),
  ],
};

async function createHarness() {
  const driver = await BetterSqlite3Driver.create(':memory:');
  const storage = new SQLiteStorage(driver);
  await storage.initialize();
  const clock = new MockClock(1000000);
  const engine = await WorkflowEngine.create({
    storage,
    clock,
    scheduler: new MockScheduler(clock),
    environment: new MockEnvironment({ isConnected: true, batteryLevel: 1.0 }),
  });
  engine.registerWorkflow(workflow);
  return { storage, clock, engine };
}

async function runToCompletion(h: Awaited<ReturnType<typeof createHarness>>, runId: string) {
  for (let i = 0; i < 10; i++) {
    await h.engine.tick();
    h.clock.advance(2000);
    const execution = await h.storage.getExecution(runId);
    if (execution && execution.status !== 'running') return execution;
  }
  throw new Error('did not settle');
}

describe('uniqueKey semantics (C7)', () => {
  it('allows key reuse after completion and preserves the completed history', async () => {
    const h = await createHarness();

    const first = await h.engine.start(workflow, { input: { n: 1 }, uniqueKey: 'K' });
    await runToCompletion(h, first.runId);

    // Old behavior: this either REPLACE-deleted the completed execution
    // (original code) or died on the status-blind unique index.
    const second = await h.engine.start(workflow, { input: { n: 2 }, uniqueKey: 'K' });
    expect(second.runId).not.toBe(first.runId);
    await runToCompletion(h, second.runId);

    const completed = await h.storage.getExecutionsByStatus('completed');
    expect(completed).toHaveLength(2);
    const firstAgain = await h.storage.getExecution(first.runId);
    expect(firstAgain?.status).toBe('completed');
  });

  it('rejects a duplicate key while the first execution is running', async () => {
    const h = await createHarness();

    const first = await h.engine.start(workflow, { input: { n: 1 }, uniqueKey: 'K' });

    await expect(
      h.engine.start(workflow, { input: { n: 2 }, uniqueKey: 'K' })
    ).rejects.toThrow(UniqueConstraintError);

    // The loser must not have left a partial execution behind.
    const running = await h.storage.getExecutionsByStatus('running');
    expect(running).toHaveLength(1);
    expect(running[0]!.runId).toBe(first.runId);
  });

  it("onConflict: 'ignore' returns the existing running execution", async () => {
    const h = await createHarness();

    const first = await h.engine.start(workflow, { input: { n: 1 }, uniqueKey: 'K' });
    const second = await h.engine.start(workflow, {
      input: { n: 2 },
      uniqueKey: 'K',
      onConflict: 'ignore',
    });

    expect(second.runId).toBe(first.runId);
  });

  it('the database itself rejects two running executions with one key', async () => {
    // Bypass the engine entirely: the index, not the engine's read-then-
    // write check, must be the final arbiter (cross-connection races).
    const h = await createHarness();

    const base: WorkflowExecution = {
      runId: 'r1',
      workflowName: 'keyed',
      uniqueKey: 'K',
      currentActivityIndex: 0,
      currentActivityName: 'work',
      status: 'running',
      input: {},
      state: {},
      createdAt: 1,
      updatedAt: 1,
    };

    await h.storage.saveExecution(base);
    await expect(h.storage.saveExecution({ ...base, runId: 'r2' })).rejects.toThrow();

    // But a completed row plus a running row is fine.
    await h.storage.saveExecution({ ...base, status: 'completed', completedAt: 2 });
    await expect(h.storage.saveExecution({ ...base, runId: 'r2' })).resolves.toBeUndefined();
  });

  // Racing starts (parity issue P4-003): two concurrent start() calls on
  // ONE engine interleave on the event loop. Before the operation lock,
  // the second start's transaction() saw transactionDepth > 0 and JOINED
  // the first start's open transaction — the loser's unique violation
  // then rolled back the winner's rows too, and the "winner" returned a
  // ghost execution that no longer existed in the database.
  it("racing duplicate starts with onConflict:'ignore' converge on one real execution", async () => {
    const h = await createHarness();

    const [a, b] = await Promise.all([
      h.engine.start(workflow, { input: { n: 1 }, uniqueKey: 'K', onConflict: 'ignore' }),
      h.engine.start(workflow, { input: { n: 2 }, uniqueKey: 'K', onConflict: 'ignore' }),
    ]);

    expect(b.runId).toBe(a.runId);

    // No ghosts: the surviving execution must actually exist, alone.
    const running = await h.storage.getExecutionsByStatus('running');
    expect(running).toHaveLength(1);
    expect(running[0]!.runId).toBe(a.runId);
    const tasks = await h.storage.getActivityTasksByStatus('pending');
    expect(tasks).toHaveLength(1);
  });

  it('a racing duplicate with the default throw names the real winner', async () => {
    const h = await createHarness();

    const results = await Promise.allSettled([
      h.engine.start(workflow, { input: { n: 1 }, uniqueKey: 'K' }),
      h.engine.start(workflow, { input: { n: 2 }, uniqueKey: 'K' }),
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const winner = (fulfilled[0] as PromiseFulfilledResult<WorkflowExecution>).value;
    const error = (rejected[0] as PromiseRejectedResult).reason as UniqueConstraintError;
    expect(error).toBeInstanceOf(UniqueConstraintError);
    expect(error.existingRunId).toBe(winner.runId);

    // The winner's rows survived the loser's failure.
    const running = await h.storage.getExecutionsByStatus('running');
    expect(running).toHaveLength(1);
    expect(running[0]!.runId).toBe(winner.runId);
  });
});
