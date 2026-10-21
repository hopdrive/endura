/**
 * Unit Test: WorkflowEngine - workflow expiry
 *
 * Some work loses its value with age: an offer lapses in minutes, a
 * diagnostic only helps near the moment it was asked for. A phone that
 * comes back online after three days should not send either. Workflow.expiry
 * gives up on an execution once it is older than afterMs: its waiting task
 * is dead-lettered (nonRetryable) and the execution fails. It never deletes.
 *
 * Key scenarios tested:
 * - Expired at claim time: dead-lettered, never executed, even offline
 * - Inside the limit: runs normally
 * - Workflows with no expiry are never expired at any age
 * - The first tick expires a task parked far in the future by runWhen
 * - A fresh engine over the same storage (a relaunch) expires what aged
 *   while the app was dead
 * - The dead letter carries the configured message
 * - An active task is left alone by the sweep
 * - Invalid afterMs is rejected at definition and registration
 */

import { WorkflowEngine } from '../../../../src/core/engine/WorkflowEngine';
import { InMemoryStorage } from '../../../../src/storage/memory';
import { SQLiteStorage } from '../../../../src/storage/sqlite';
import { BetterSqlite3Driver } from '../../../../src/storage/sqlite/internal/BetterSqlite3Driver';
import { MockClock, MockScheduler, MockEnvironment } from '../../../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../../../src/core/definitions';
import { conditions } from '../../../../src/core/conditions';
import { WorkflowExpiredError, type Storage, type Workflow } from '../../../../src/core/types';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const backends: Array<{ name: string; create: () => Promise<Storage> }> = [
  { name: 'InMemoryStorage', create: async () => new InMemoryStorage() },
  {
    name: 'SQLiteStorage(better-sqlite3)',
    create: async () => {
      const storage = new SQLiteStorage(await BetterSqlite3Driver.create(':memory:'));
      await storage.initialize();
      return storage;
    },
  },
];

describe.each(backends)('WorkflowEngine - expiry ($name)', ({ create }) => {
  let storage: Storage;
  let clock: MockClock;
  let environment: MockEnvironment;
  let sent: string[];
  let decaying: Workflow;
  let durable: Workflow;

  async function launch(): Promise<WorkflowEngine> {
    const engine = await WorkflowEngine.create({
      storage,
      clock,
      scheduler: new MockScheduler(clock),
      environment,
    });
    engine.registerWorkflow(decaying);
    engine.registerWorkflow(durable);
    return engine;
  }

  beforeEach(async () => {
    storage = await create();
    clock = new MockClock(1_000_000);
    environment = new MockEnvironment({ isConnected: false });
    sent = [];
    decaying = defineWorkflow({
      name: 'appDump',
      expiry: { afterMs: DAY, message: 'sync.refusal.expired' },
      activities: [
        defineActivity({
          name: 'uploadDump',
          runWhen: conditions.whenConnected,
          execute: async () => {
            sent.push('dump');
            return {};
          },
        }),
      ],
    });
    durable = defineWorkflow({
      name: 'statusSync',
      activities: [
        defineActivity({
          name: 'pushStatus',
          runWhen: conditions.whenConnected,
          execute: async () => {
            sent.push('status');
            return {};
          },
        }),
      ],
    });
  });

  it('dead-letters an expired execution at claim time without running it, even offline', async () => {
    const engine = await launch();
    const { runId } = await engine.start(decaying, { input: {} });
    await engine.tick(); // offline: skipped, parked 30s out

    clock.advance(DAY + 1);
    await engine.tick();

    expect(sent).toEqual([]);
    const execution = await storage.getExecution(runId);
    expect(execution?.status).toBe('failed');
    expect(execution?.error).toBe('sync.refusal.expired');
    const [letter] = await engine.getDeadLetters();
    expect(letter).toMatchObject({
      runId,
      workflowName: 'appDump',
      activityName: 'uploadDump',
      error: 'sync.refusal.expired',
      nonRetryable: true,
    });
  });

  it('runs an execution that is still inside its limit', async () => {
    const engine = await launch();
    const { runId } = await engine.start(decaying, { input: {} });
    clock.advance(23 * HOUR);
    environment.setConnected(true);
    await engine.tick();

    expect(sent).toEqual(['dump']);
    expect((await storage.getExecution(runId))?.status).toBe('completed');
    expect(await engine.getDeadLetters()).toEqual([]);
  });

  it('treats exactly afterMs as inside the limit', async () => {
    const engine = await launch();
    await engine.start(decaying, { input: {} });
    clock.advance(DAY);
    environment.setConnected(true);
    await engine.tick();
    expect(sent).toEqual(['dump']);
  });

  it('never expires a workflow with no expiry, however old', async () => {
    const engine = await launch();
    const { runId } = await engine.start(durable, { input: {} });
    await engine.tick();
    clock.advance(30 * DAY);
    expect(await engine.expireStaleExecutions()).toBe(0);
    environment.setConnected(true);
    await engine.tick();

    expect(sent).toEqual(['status']);
    expect((await storage.getExecution(runId))?.status).toBe('completed');
    expect(await engine.getDeadLetters()).toEqual([]);
  });

  it('expires a task parked by runWhen on the first tick of a relaunch, not when it comes due', async () => {
    const first = await launch();
    // A long retryInMs parks the task well past the moment we relaunch.
    const parked = defineWorkflow({
      name: 'appDump',
      expiry: { afterMs: DAY },
      activities: [
        defineActivity({
          name: 'uploadDump',
          runWhen: () => ({ ready: false, reason: 'offline', retryInMs: 7 * DAY }),
          execute: async () => {
            sent.push('dump');
            return {};
          },
        }),
      ],
    });
    first.registerWorkflow(parked);
    const { runId } = await first.start(parked, { input: {} });
    await first.tick();
    const [task] = await storage.getActivityTasksForExecution(runId);
    expect(task!.scheduledFor).toBeGreaterThan(clock.now() + DAY);

    // The app is killed and relaunched two days later.
    clock.advance(2 * DAY);
    decaying = parked;
    const relaunched = await launch();
    await relaunched.tick();

    expect(sent).toEqual([]);
    expect((await storage.getExecution(runId))?.status).toBe('failed');
    const [letter] = await relaunched.getDeadLetters();
    expect(letter!.nonRetryable).toBe(true);
    expect(letter!.error).toMatch(/Workflow 'appDump' expired/);
  });

  it('leaves a running execution of an expiring workflow alone while it is young', async () => {
    const engine = await launch();
    const { runId } = await engine.start(decaying, { input: {} });
    await engine.tick();
    clock.advance(DAY - 1);
    expect(await engine.expireStaleExecutions()).toBe(0);
    expect((await storage.getExecution(runId))?.status).toBe('running');
  });

  it('leaves an active task to finish', async () => {
    const engine = await launch();
    const { runId } = await engine.start(decaying, { input: {} });
    const [task] = await storage.getActivityTasksForExecution(runId);
    await storage.claimActivityTask(task!.taskId, clock.now(), {
      ownerId: 'other-engine',
      leaseDurationMs: 60_000,
    });
    clock.advance(DAY + 1);
    expect(await engine.expireStaleExecutions()).toBe(0);
    expect((await storage.getExecution(runId))?.status).toBe('running');
  });

  it('builds a WorkflowExpiredError that reads as a refusal', () => {
    const error = new WorkflowExpiredError('appDump', DAY + 5, DAY);
    expect(error.nonRetryable).toBe(true);
    expect(error.expired).toBe(true);
    expect(error.message).toBe(
      `Workflow 'appDump' expired: still unfinished ${DAY + 5}ms after it started (limit ${DAY}ms)`
    );
  });

  it('rejects a non-positive afterMs at definition and at registration', async () => {
    const activity = defineActivity({ name: 'x', execute: async () => ({}) });
    expect(() => defineWorkflow({ name: 'bad', expiry: { afterMs: 0 }, activities: [activity] })).toThrow(
      /invalid expiry.afterMs/
    );
    const engine = await launch();
    expect(() =>
      engine.registerWorkflow({ name: 'bad', expiry: { afterMs: Number.NaN }, activities: [activity] })
    ).toThrow(/invalid expiry.afterMs/);
  });
});
