/**
 * On-disk crash/restart durability + crash-window fault injection
 * (review "Missing Tests" #2 and #3).
 *
 * The original CrashRecovery tests never left process memory. These
 * tests use a FILE-backed better-sqlite3 database and rebuild the whole
 * stack (driver, storage, engine) between phases, so recovery must work
 * from what actually hit disk — exactly what an app relaunch gets.
 *
 * Fault injection covers the crash WINDOWS inside the success path: a
 * storage throw during (a) the completed-task write and (b) the
 * execution-advance write. Both must leave a state a fresh engine can
 * repair (at-least-once, never stranded).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowEngine } from '../../src/core/engine';
import { MockClock, MockScheduler, MockEnvironment } from '../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../src/core/definitions';
import { Workflow } from '../../src/core/types';
import { SQLiteStorage } from '../../src/storage/sqlite';
import { BetterSqlite3Driver } from '../../src/storage/sqlite/internal/BetterSqlite3Driver';
import { createLoopbackDispatcher } from '../../src/workers/loopback';

let tempDir: string;
let dbPath: string;
let executed: string[];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'endura-durability-'));
  dbPath = join(tempDir, 'workflow.db');
  executed = [];
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function threeStep(): Workflow {
  return defineWorkflow({
    name: 'threeStep',
    activities: ['one', 'two', 'three'].map(name =>
      defineActivity({
        name,
        execute: async () => {
          executed.push(name);
          return { [name]: true };
        },
        retry: { maximumAttempts: 3 },
      })
    ),
  });
}

/** Boot the full stack over the db file, as an app launch would. */
async function boot(startTime: number) {
  const driver = await BetterSqlite3Driver.create(dbPath);
  const storage = new SQLiteStorage(driver);
  await storage.initialize();
  const clock = new MockClock(startTime);
  const engine = await WorkflowEngine.create({
    dispatcher: createLoopbackDispatcher(),
    storage,
    clock,
    scheduler: new MockScheduler(clock),
    environment: new MockEnvironment({ isConnected: true, batteryLevel: 1.0 }),
  });
  engine.registerWorkflow(threeStep());
  return { storage, clock, engine };
}

async function runUntilSettled(h: Awaited<ReturnType<typeof boot>>, runId: string) {
  for (let i = 0; i < 15; i++) {
    await h.engine.tick();
    h.clock.advance(2000);
    const execution = await h.storage.getExecution(runId);
    if (execution && execution.status !== 'running') return execution;
  }
  return h.storage.getExecution(runId);
}

describe('on-disk crash/restart durability (missing test #2)', () => {
  it('resumes from disk after a mid-workflow shutdown with a pending frontier task', async () => {
    // Phase 1: run step one, then the "app dies" (stack abandoned, db closed)
    const first = await boot(1_000_000);
    const execution = await first.engine.start(threeStep(), { input: { seed: true } });
    await first.engine.tick();
    expect(executed).toEqual(['one']);
    await first.storage.close();

    // Phase 2: fresh app launch over the same file
    const second = await boot(2_000_000);
    const resumed = await second.storage.getExecution(execution.runId);
    expect(resumed?.status).toBe('running');
    expect(resumed?.currentActivityName).toBe('two');

    const final = await runUntilSettled(second, execution.runId);
    expect(final?.status).toBe('completed');
    expect(executed).toEqual(['one', 'two', 'three']);
    expect(final?.state).toMatchObject({ seed: true, one: true, two: true, three: true });
    await second.storage.close();
  });

  it('reclaims a task left ACTIVE by a killed engine once its lease lapses', async () => {
    // Phase 1: claim step one but "die" before executing it
    const first = await boot(1_000_000);
    const execution = await first.engine.start(threeStep(), { input: {} });
    const claimed = await first.storage.claimActivityTask(
      (await first.storage.getActivityTasksForExecution(execution.runId))[0]!.taskId,
      first.clock.now(),
      { ownerId: 'dead-engine', leaseDurationMs: 60_000 }
    );
    expect(claimed?.status).toBe('active');
    await first.storage.close();

    // Phase 2: relaunch AFTER the lease lapsed — recovery must reclaim
    // without burning a failure (the crash wasn't a real failure)
    const second = await boot(1_000_000 + 120_000);
    const final = await runUntilSettled(second, execution.runId);
    expect(final?.status).toBe('completed');
    expect(executed).toEqual(['one', 'two', 'three']);

    const tasks = await second.storage.getActivityTasksForExecution(execution.runId);
    expect(tasks.find(t => t.activityName === 'one')?.failures ?? 0).toBe(0);
    await second.storage.close();
  });
});

describe('crash-window fault injection (missing test #3)', () => {
  /**
   * Wrap the real storage and blow up on the Nth write matching a
   * predicate — simulating a crash inside the success path's
   * transaction. Everything else passes through.
   */
  function faultying<T extends object>(target: T, method: keyof T, when: (...args: never[]) => boolean) {
    let armed = true;
    const original = (target[method] as unknown as (...args: unknown[]) => Promise<unknown>).bind(target);
    (target as Record<string, unknown>)[method as string] = async (...args: unknown[]) => {
      if (armed && when(...(args as never[]))) {
        armed = false;
        throw new Error('injected crash');
      }
      return original(...args);
    };
  }

  it('repairs a crash during the completed-task write (window a)', async () => {
    const first = await boot(1_000_000);
    const execution = await first.engine.start(threeStep(), { input: {} });

    // Crash when step one's completion is being persisted
    faultying(first.storage, 'saveActivityTask', (task: { status?: string; activityName?: string }) =>
      task.status === 'completed' && task.activityName === 'one');

    await first.engine.tick(); // contained: transaction rolled back
    expect(executed).toEqual(['one']);

    // Nothing committed: the workflow must not be stranded after relaunch
    await first.storage.close();
    const second = await boot(1_000_000 + 120_000);
    const final = await runUntilSettled(second, execution.runId);
    expect(final?.status).toBe('completed');
    // At-least-once: step one re-ran because its completion was lost
    expect(executed).toEqual(['one', 'one', 'two', 'three']);
    await second.storage.close();
  });

  it('repairs a crash during the execution-advance write (window b)', async () => {
    const first = await boot(1_000_000);
    const execution = await first.engine.start(threeStep(), { input: {} });

    // Crash when the cursor advances to step two
    faultying(first.storage, 'saveExecution', (e: { currentActivityName?: string }) =>
      e.currentActivityName === 'two');

    await first.engine.tick(); // contained: whole success transaction rolled back
    expect(executed).toEqual(['one']);

    await first.storage.close();
    const second = await boot(1_000_000 + 120_000);
    const final = await runUntilSettled(second, execution.runId);
    expect(final?.status).toBe('completed');
    expect(executed).toEqual(['one', 'one', 'two', 'three']);
    await second.storage.close();
  });
});
