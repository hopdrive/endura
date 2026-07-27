/**
 * Engine resilience tests (review issues H1, H2).
 *
 * H1: timeouts were advisory — the engine awaited activity.execute()
 * directly, so a handler that ignored the abort signal wedged the serial
 * engine forever. The execute promise is now raced against the abort.
 *
 * H2: any storage throw inside the tick loop killed the whole engine
 * loop. Task-level failures are now contained per task.
 */

import { WorkflowEngine } from '../../../../src/core/engine';
import { MockClock, MockScheduler, MockEnvironment } from '../../../../src/core/mocks';
import { defineActivity } from '../../../../src/core/definitions';
import { Workflow } from '../../../../src/core/types';
import { InMemoryStorage } from '../../../../src/storage/memory';
import { SQLiteStorage } from '../../../../src/storage/sqlite';
import { BetterSqlite3Driver } from '../../../../src/storage/sqlite/internal/BetterSqlite3Driver';
import { SQLiteDriver, SQLiteResult, SQLiteRow } from '../../../../src/storage/sqlite/internal/SQLiteDriver';
import { createLoopbackDispatcher } from '../../../../src/workers/loopback';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

describe('hung handler containment (H1)', () => {
  it('fails a never-settling activity on timeout and keeps processing others', async () => {
    const storage = new InMemoryStorage();
    const clock = new MockClock(1000000);
    const scheduler = new MockScheduler(clock);
    const engine = await WorkflowEngine.create({
      dispatcher: createLoopbackDispatcher(),
      storage,
      clock,
      scheduler,
      environment: new MockEnvironment({ isConnected: true, batteryLevel: 1.0 }),
    });

    const hungWorkflow: Workflow = {
      name: 'hung',
      activities: [
        defineActivity({
          name: 'neverSettles',
          startToCloseTimeout: 100,
          retry: { maximumAttempts: 1 },
          // Ignores ctx.signal entirely — the worst-behaved handler.
          execute: () => new Promise(() => {}),
        }),
      ],
    };
    const quickWorkflow: Workflow = {
      name: 'quick',
      activities: [
        defineActivity({
          name: 'fast',
          execute: async () => ({ ok: true }),
          retry: { maximumAttempts: 3 },
        }),
      ],
    };
    engine.registerWorkflow(hungWorkflow);
    engine.registerWorkflow(quickWorkflow);

    const hung = await engine.start(hungWorkflow, { input: {} });
    const quick = await engine.start(quickWorkflow, { input: {} });

    // Old code: this tick never resolves — the await on the hung handler
    // blocks the serial engine forever.
    const tickPromise = engine.tick();
    await flush();
    scheduler.advanceAndTick(150); // fire the timeout
    await tickPromise;

    const hungFinal = (await storage.getExecution(hung.runId))!;
    expect(hungFinal.status).toBe('failed');
    expect(hungFinal.error?.toLowerCase()).toContain('timed out');

    // The queued quick task was processed in the same tick.
    const quickFinal = (await storage.getExecution(quick.runId))!;
    expect(quickFinal.status).toBe('completed');
  }, 5000);

  it('ignores a late success from a timed-out activity (stale-success guard)', async () => {
    const storage = new InMemoryStorage();
    const clock = new MockClock(1000000);
    const scheduler = new MockScheduler(clock);
    const engine = await WorkflowEngine.create({
      dispatcher: createLoopbackDispatcher(),
      storage,
      clock,
      scheduler,
      environment: new MockEnvironment({ isConnected: true, batteryLevel: 1.0 }),
    });

    let releaseLate!: (v: Record<string, unknown>) => void;
    const workflow: Workflow = {
      name: 'lateSuccess',
      activities: [
        defineActivity({
          name: 'slow',
          startToCloseTimeout: 100,
          retry: { maximumAttempts: 1 },
          execute: () =>
            new Promise<Record<string, unknown>>(resolve => {
              releaseLate = resolve;
            }),
        }),
      ],
    };
    engine.registerWorkflow(workflow);
    const execution = await engine.start(workflow, { input: {} });

    const tickPromise = engine.tick();
    await flush();
    scheduler.advanceAndTick(150);
    await tickPromise;

    const failed = (await storage.getExecution(execution.runId))!;
    expect(failed.status).toBe('failed');

    // The activity "completes" long after the timeout. It must not
    // resurrect the failed execution or overwrite the failure.
    releaseLate({ tooLate: true });
    await flush();

    const after = (await storage.getExecution(execution.runId))!;
    expect(after.status).toBe('failed');
    const tasks = await storage.getActivityTasksForExecution(execution.runId);
    expect(tasks[0]!.status).toBe('failed');
    expect(tasks[0]!.result).toBeUndefined();
  }, 5000);
});

describe('storage-error containment (H2)', () => {
  class FlakyDriver implements SQLiteDriver {
    private remainingFaults = 0;

    constructor(private inner: SQLiteDriver) {}

    failNext(times: number): void {
      this.remainingFaults = times;
    }

    async execute(sql: string, params: unknown[] = []): Promise<SQLiteResult> {
      if (this.remainingFaults > 0 && sql.includes(`SET status = 'active'`)) {
        this.remainingFaults--;
        throw new Error('SQLITE_BUSY: database is locked');
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

  it('a transient storage error fails one tick quietly, not the engine', async () => {
    const driver = new FlakyDriver(await BetterSqlite3Driver.create(':memory:'));
    const storage = new SQLiteStorage(driver);
    await storage.initialize();
    const clock = new MockClock(1000000);
    const engine = await WorkflowEngine.create({
      dispatcher: createLoopbackDispatcher(),
      storage,
      clock,
      scheduler: new MockScheduler(clock),
      environment: new MockEnvironment({ isConnected: true, batteryLevel: 1.0 }),
    });

    const workflow: Workflow = {
      name: 'resilient',
      activities: [
        defineActivity({
          name: 'work',
          execute: async () => ({ done: true }),
          retry: { maximumAttempts: 3 },
        }),
      ],
    };
    engine.registerWorkflow(workflow);
    const execution = await engine.start(workflow, { input: {} });

    // Old code: the SQLITE_BUSY from the claim propagated out of tick()
    // and killed the run loop.
    driver.failNext(1);
    await expect(engine.tick()).resolves.toBe(0);

    // Next tick recovers and completes the workflow.
    await engine.tick();
    expect((await storage.getExecution(execution.runId))!.status).toBe('completed');
  });
});
