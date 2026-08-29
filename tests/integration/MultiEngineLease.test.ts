/**
 * Multi-engine leasing tests (review issue C3).
 *
 * The intended production deployment runs TWO engines over one database:
 * the foreground app engine and a background-wake engine. Startup recovery
 * used to reset ALL 'active' tasks, so a background engine spawning while
 * the foreground engine was mid-task deterministically re-ran the task.
 * Leases (owner_id + lease_expires_at) make recovery reclaim only tasks
 * whose lease has lapsed.
 */

import { WorkflowEngine } from '../../src/core/engine';
import { MockClock, MockScheduler, MockEnvironment } from '../../src/core/mocks';
import { defineActivity } from '../../src/core/definitions';
import { Workflow } from '../../src/core/types';
import { InMemoryStorage } from '../../src/storage/memory';
import { SQLiteStorage } from '../../src/storage/sqlite';
import { BetterSqlite3Driver } from '../../src/storage/sqlite/internal/BetterSqlite3Driver';
import { createLoopbackDispatcher } from '../../src/workers/loopback';

interface Deferred {
  promise: Promise<Record<string, unknown>>;
  resolve: (value: Record<string, unknown>) => void;
}

function deferred(): Deferred {
  let resolve!: (value: Record<string, unknown>) => void;
  const promise = new Promise<Record<string, unknown>>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let pending microtasks (claims, saves) settle. */
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

async function createEngine(
  storage: InMemoryStorage,
  clock: MockClock,
  options?: { leaseDurationMs?: number }
): Promise<{ engine: WorkflowEngine; scheduler: MockScheduler }> {
  const scheduler = new MockScheduler(clock);
  const engine = await WorkflowEngine.create({
    dispatcher: createLoopbackDispatcher(),
    storage,
    clock,
    scheduler,
    environment: new MockEnvironment({ isConnected: true, batteryLevel: 1.0 }),
    leaseDurationMs: options?.leaseDurationMs,
  });
  return { engine, scheduler };
}

describe('multi-engine leasing (C3)', () => {
  it('a second engine starting up does not reset a live engine\'s active task', async () => {
    const storage = new InMemoryStorage();
    const clock = new MockClock(1000000);

    let executions = 0;
    const gates: Deferred[] = [];
    const workflow: Workflow = {
      name: 'leased',
      activities: [
        defineActivity({
          name: 'blocker',
          execute: async () => {
            executions++;
            const gate = deferred();
            gates.push(gate);
            return gate.promise;
          },
          retry: { maximumAttempts: 3 },
        }),
      ],
    };

    const a = await createEngine(storage, clock);
    a.engine.registerWorkflow(workflow);
    const execution = await a.engine.start(workflow, { input: {} });

    // Engine A claims and blocks inside the activity.
    const tickA = a.engine.tick();
    await flush();
    const claimed = (await storage.getActivityTasksForExecution(execution.runId))[0]!;
    expect(claimed.status).toBe('active');

    // Engine B boots mid-flight (background wake). Its startup recovery
    // must leave A's leased task alone.
    const b = await createEngine(storage, clock);
    b.engine.registerWorkflow(workflow);

    const afterBoot = (await storage.getActivityTasksForExecution(execution.runId))[0]!;
    expect(afterBoot.status).toBe('active');

    // And B's tick must find nothing to run.
    const processedByB = await b.engine.tick();
    expect(processedByB).toBe(0);

    // Release the activity; A finishes; the activity ran exactly once.
    gates.forEach(g => g.resolve({ done: true }));
    await tickA;

    expect(executions).toBe(1);
    const final = (await storage.getExecution(execution.runId))!;
    expect(final.status).toBe('completed');
  });

  it('recovers a task whose lease has expired (crashed owner)', async () => {
    const storage = new InMemoryStorage();
    const clock = new MockClock(1000000);

    let executions = 0;
    const workflow: Workflow = {
      name: 'leased',
      activities: [
        defineActivity({
          name: 'work',
          execute: async () => {
            executions++;
            return { done: true };
          },
          retry: { maximumAttempts: 3 },
        }),
      ],
    };

    // A "crashed" engine claimed the task and never released it.
    const a = await createEngine(storage, clock, { leaseDurationMs: 60000 });
    a.engine.registerWorkflow(workflow);
    const execution = await a.engine.start(workflow, { input: {} });
    const task = (await storage.getActivityTasksForExecution(execution.runId))[0]!;
    const claimed = await storage.claimActivityTask(task.taskId, clock.now(), {
      ownerId: 'dead-engine',
      leaseDurationMs: 60000,
    });
    expect(claimed?.status).toBe('active');

    // Before expiry: a new engine must NOT touch it.
    clock.advance(30000);
    const early = await createEngine(storage, clock);
    early.engine.registerWorkflow(workflow);
    expect((await storage.getActivityTasksForExecution(execution.runId))[0]!.status).toBe('active');

    // After expiry: recovery reclaims it and the workflow completes.
    clock.advance(60001);
    const late = await createEngine(storage, clock);
    late.engine.registerWorkflow(workflow);
    expect((await storage.getActivityTasksForExecution(execution.runId))[0]!.status).toBe('pending');

    await late.engine.tick();
    expect(executions).toBe(1);
    expect((await storage.getExecution(execution.runId))!.status).toBe('completed');
  });

  it('reclaims an expired lease during ticking, without an engine restart', async () => {
    const storage = new InMemoryStorage();
    const clock = new MockClock(1000000);

    let executions = 0;
    const workflow: Workflow = {
      name: 'leased',
      activities: [
        defineActivity({
          name: 'work',
          execute: async () => {
            executions++;
            return { done: true };
          },
          retry: { maximumAttempts: 3 },
        }),
      ],
    };

    // The engine is ALREADY running when another engine's task dies: an
    // app relaunched inside the lease window boots, sees an unexpired
    // lease (correctly skips it), and must still pick the task up once
    // the lease lapses — recovery cannot happen only at create().
    const a = await createEngine(storage, clock, { leaseDurationMs: 5000 });
    a.engine.registerWorkflow(workflow);
    const execution = await a.engine.start(workflow, { input: {} });
    const task = (await storage.getActivityTasksForExecution(execution.runId))[0]!;
    await storage.claimActivityTask(task.taskId, clock.now(), {
      ownerId: 'dead-engine',
      leaseDurationMs: 5000,
    });

    // Lease still live: nothing to do.
    await a.engine.tick();
    expect((await storage.getActivityTasksForExecution(execution.runId))[0]!.status).toBe('active');
    expect(executions).toBe(0);

    // Lease lapses while THIS engine keeps ticking.
    clock.advance(6000);
    await a.engine.tick();

    expect(executions).toBe(1);
    expect((await storage.getExecution(execution.runId))!.status).toBe('completed');
  });

  it('renews the lease via heartbeat while a long activity runs', async () => {
    const storage = new InMemoryStorage();
    const clock = new MockClock(1000000);

    const gate = deferred();
    const workflow: Workflow = {
      name: 'longTask',
      activities: [
        defineActivity({
          name: 'slow',
          execute: async () => gate.promise,
          startToCloseTimeout: 0, // no timeout; lease must carry it
          retry: { maximumAttempts: 3 },
        }),
      ],
    };

    const a = await createEngine(storage, clock, { leaseDurationMs: 10000 });
    a.engine.registerWorkflow(workflow);
    const execution = await a.engine.start(workflow, { input: {} });

    const tick = a.engine.tick();
    await flush();
    const initial = (await storage.getActivityTasksForExecution(execution.runId))[0]!;
    expect(initial.status).toBe('active');
    expect(initial.leaseExpiresAt).toBe(1000000 + 10000);

    // Half a lease later the heartbeat fires and extends the lease.
    a.scheduler.advanceAndTick(5000);
    await flush();
    const renewed = (await storage.getActivityTasksForExecution(execution.runId))[0]!;
    expect(renewed.leaseExpiresAt).toBeGreaterThan(initial.leaseExpiresAt!);

    gate.resolve({ done: true });
    await tick;
    expect((await storage.getExecution(execution.runId))!.status).toBe('completed');
  });
});

describe('renewLease storage contract', () => {
  const task = {
    taskId: 'task-1',
    runId: 'run-1',
    activityName: 'a1',
    status: 'pending' as const,
    priority: 0,
    attempts: 0,
    maxAttempts: 3,
    timeout: 25000,
    input: {},
    createdAt: 1000000,
  };

  const execution = {
    runId: 'run-1',
    workflowName: 'wf',
    currentActivityIndex: 0,
    currentActivityName: 'a1',
    status: 'running' as const,
    input: {},
    state: {},
    createdAt: 1000000,
    updatedAt: 1000000,
  };

  it.each([
    ['InMemoryStorage', async () => new InMemoryStorage()],
    [
      'SQLiteStorage',
      async () => {
        const storage = new SQLiteStorage(await BetterSqlite3Driver.create(':memory:'));
        await storage.initialize();
        return storage;
      },
    ],
  ])('%s: only the owner can renew, and only while active', async (_name, make) => {
    const storage = await make();
    await storage.saveExecution(execution);
    await storage.saveActivityTask(task);

    const claimed = await storage.claimActivityTask('task-1', 2000000, {
      ownerId: 'owner-1',
      leaseDurationMs: 10000,
    });
    expect(claimed?.ownerId).toBe('owner-1');
    expect(claimed?.leaseExpiresAt).toBe(2010000);

    // Wrong owner: refused, lease untouched.
    expect(await storage.renewLease('task-1', 'intruder', 9999999)).toBe(false);
    expect((await storage.getActivityTask('task-1'))!.leaseExpiresAt).toBe(2010000);

    // Right owner: extended.
    expect(await storage.renewLease('task-1', 'owner-1', 2020000)).toBe(true);
    expect((await storage.getActivityTask('task-1'))!.leaseExpiresAt).toBe(2020000);

    // Not active anymore: refused.
    await storage.saveActivityTask({ ...task, status: 'completed', attempts: 1 });
    expect(await storage.renewLease('task-1', 'owner-1', 2030000)).toBe(false);
  });
});
