/**
 * Crash-window atomicity and reconciliation tests (review issue C2).
 *
 * The success → advance → schedule-next sequence used to be three separate
 * writes. A crash between any two of them stranded the workflow 'running'
 * with no pending/active task — permanently, since crash recovery only
 * scans 'active' tasks. These tests inject faults mid-sequence over real
 * SQLite and assert (a) nothing partial commits, and (b) a fresh engine
 * repairs whatever state a crash could leave behind.
 */

import { WorkflowEngine } from '../../src/core/engine';
import { MockClock, MockScheduler, MockEnvironment } from '../../src/core/mocks';
import { defineActivity } from '../../src/core/definitions';
import { Workflow, WorkflowExecution, ActivityTask } from '../../src/core/types';
import { SQLiteStorage } from '../../src/storage/sqlite';
import { BetterSqlite3Driver } from '../../src/storage/sqlite/internal/BetterSqlite3Driver';
import { SQLiteDriver, SQLiteResult, SQLiteRow } from '../../src/storage/sqlite/internal/SQLiteDriver';
import { createLoopbackDispatcher } from '../../src/workers/loopback';

/**
 * Driver wrapper that throws on a matching statement — once — to simulate
 * a crash mid-sequence.
 */
class FaultInjectingDriver implements SQLiteDriver {
  private armed = false;
  private matcher: ((sql: string, params: unknown[]) => boolean) | null = null;

  constructor(private inner: SQLiteDriver) {}

  arm(matcher: (sql: string, params: unknown[]) => boolean): void {
    this.armed = true;
    this.matcher = matcher;
  }

  async execute(sql: string, params: unknown[] = []): Promise<SQLiteResult> {
    if (this.armed && this.matcher?.(sql, params)) {
      this.armed = false;
      throw new Error('injected crash');
    }
    return this.inner.execute(sql, params);
  }

  async query(sql: string, params: unknown[] = []): Promise<SQLiteRow[]> {
    return this.inner.query(sql, params);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.inner.transaction(fn);
  }

  async close(): Promise<void> {
    return this.inner.close();
  }
}

const isPendingTaskInsert = (sql: string, params: unknown[]): boolean =>
  sql.includes('INSERT OR REPLACE INTO activity_tasks') && params.includes('pending');

interface Harness {
  driver: FaultInjectingDriver;
  storage: SQLiteStorage;
  clock: MockClock;
  engine: WorkflowEngine;
  workflow: Workflow;
}

const buildWorkflow = (): Workflow => ({
  name: 'twoStep',
  activities: [
    defineActivity({
      name: 'step1',
      execute: async () => ({ s1: true }),
      retry: { maximumAttempts: 3 },
    }),
    defineActivity({
      name: 'step2',
      execute: async () => ({ s2: true }),
      retry: { maximumAttempts: 3 },
    }),
  ],
});

async function createHarness(existing?: { driver: FaultInjectingDriver; storage: SQLiteStorage }): Promise<Harness> {
  const driver = existing?.driver ?? new FaultInjectingDriver(await BetterSqlite3Driver.create(':memory:'));
  const storage = existing?.storage ?? new SQLiteStorage(driver);
  if (!existing) {
    await storage.initialize();
  }

  const clock = new MockClock(1000000);
  const engine = await WorkflowEngine.create({
    dispatcher: createLoopbackDispatcher(),
    storage,
    clock,
    scheduler: new MockScheduler(clock),
    environment: new MockEnvironment({ isConnected: true, batteryLevel: 1.0 }),
  });
  const workflow = buildWorkflow();
  engine.registerWorkflow(workflow);

  return { driver, storage, clock, engine, workflow };
}

async function tickUntilSettled(h: Harness, runId: string, maxTicks = 20): Promise<WorkflowExecution> {
  for (let i = 0; i < maxTicks; i++) {
    await h.engine.tick();
    // Large advance so retry backoff windows elapse between ticks.
    h.clock.advance(2000);
    const execution = await h.storage.getExecution(runId);
    if (execution && execution.status !== 'running') {
      return execution;
    }
  }
  return (await h.storage.getExecution(runId))!;
}

describe('atomic multi-write sequences (C2)', () => {
  it('start() commits nothing when the first task insert fails', async () => {
    const h = await createHarness();
    h.driver.arm(isPendingTaskInsert);

    await expect(h.engine.start(h.workflow, { input: { x: 1 } })).rejects.toThrow('injected crash');

    // Old behavior: execution row committed 'running' with zero tasks.
    const running = await h.storage.getExecutionsByStatus('running');
    expect(running).toEqual([]);
    const pending = await h.storage.getActivityTasksByStatus('pending');
    expect(pending).toEqual([]);
  });

  it('advance rolls back atomically when scheduling the next task fails', async () => {
    const h = await createHarness();
    const execution = await h.engine.start(h.workflow, { input: { x: 1 } });

    // Crash on the NEXT pending-task insert — i.e. scheduling step2 after
    // step1 succeeded. The engine's catch-all absorbs the error into the
    // retry path, so tick() resolves; what matters is the DB state.
    h.driver.arm(isPendingTaskInsert);
    await h.engine.tick();

    // The whole advance must roll back together: step1 must NOT be
    // recorded 'completed' while the cursor stayed at step1, and the
    // cursor must NOT have moved without a step2 task existing.
    // (The old non-atomic code committed the completion AND advanced the
    // cursor, then lost the step2 insert — the workflow later resumed
    // from the moved cursor and silently skipped step2.)
    const after = (await h.storage.getExecution(execution.runId))!;
    expect(after.status).toBe('running');
    expect(after.currentActivityIndex).toBe(0);
    expect(after.currentActivityName).toBe('step1');

    const tasks = await h.storage.getActivityTasksForExecution(execution.runId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).not.toBe('completed');
  });

  it('completes the workflow after a crashed advance without skipping steps', async () => {
    const h = await createHarness();
    const execution = await h.engine.start(h.workflow, { input: { x: 1 } });

    h.driver.arm(isPendingTaskInsert);
    await h.engine.tick();

    // "Relaunch": new engine over the same storage, then run to
    // completion. Both steps must have contributed to the final state —
    // the old code's half-committed advance skipped step2 entirely.
    const h2 = await createHarness({ driver: h.driver, storage: h.storage });
    const final = await tickUntilSettled(h2, execution.runId);

    expect(final.status).toBe('completed');
    expect(final.state).toMatchObject({ s1: true, s2: true });
  });
});

describe('stranded-execution reconciliation (C2)', () => {
  const baseExecution: WorkflowExecution = {
    runId: 'stranded-run',
    workflowName: 'twoStep',
    currentActivityIndex: 0,
    currentActivityName: 'step1',
    status: 'running',
    input: { x: 1 },
    state: { x: 1 },
    createdAt: 900000,
    updatedAt: 900000,
  };

  it('replays a lost advance when the frontier task completed', async () => {
    const h = await createHarness();

    // Pre-transactional crash artifact: step1 completed, execution never
    // advanced, nothing pending.
    await h.storage.saveExecution(baseExecution);
    const completedTask: ActivityTask = {
      taskId: 'stranded-task',
      runId: 'stranded-run',
      activityName: 'step1',
      status: 'completed',
      priority: 0,
      attempts: 1,
      maxAttempts: 3,
      timeout: 25000,
      input: { x: 1 },
      result: { s1: true },
      createdAt: 900000,
      startedAt: 900001,
      completedAt: 900002,
    };
    await h.storage.saveActivityTask(completedTask);

    const final = await tickUntilSettled(h, 'stranded-run');

    expect(final.status).toBe('completed');
    expect(final.state).toMatchObject({ x: 1, s1: true, s2: true });
  });

  it('schedules the frontier task when no task record exists', async () => {
    const h = await createHarness();

    // Crash artifact from a non-atomic start(): execution row exists,
    // first task was never written.
    await h.storage.saveExecution(baseExecution);

    const final = await tickUntilSettled(h, 'stranded-run');

    expect(final.status).toBe('completed');
    expect(final.state).toMatchObject({ x: 1, s1: true, s2: true });
  });

  it('marks the execution failed when the frontier task failed', async () => {
    const h = await createHarness();

    await h.storage.saveExecution(baseExecution);
    await h.storage.saveActivityTask({
      taskId: 'stranded-task',
      runId: 'stranded-run',
      activityName: 'step1',
      status: 'failed',
      priority: 0,
      attempts: 3,
      maxAttempts: 3,
      timeout: 25000,
      input: { x: 1 },
      createdAt: 900000,
      error: 'it broke',
    });

    await h.engine.tick();

    const final = (await h.storage.getExecution('stranded-run'))!;
    expect(final.status).toBe('failed');
    expect(final.error).toBe('it broke');
    expect(final.failedActivityName).toBe('step1');
  });

  it('leaves healthy running executions alone', async () => {
    const h = await createHarness();
    const execution = await h.engine.start(h.workflow, { input: { x: 1 } });

    const final = await tickUntilSettled(h, execution.runId);
    expect(final.status).toBe('completed');

    const tasks = await h.storage.getActivityTasksForExecution(execution.runId);
    expect(tasks).toHaveLength(2);
    expect(tasks.every(t => t.status === 'completed')).toBe(true);
  });
});
