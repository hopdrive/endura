/**
 * Unit Test: WorkflowEngine - wakeSkipped
 *
 * A runWhen skip parks a task `retryInMs ?? 30s` ahead. When the app knows
 * the condition just turned true (the device came back online), waiting out
 * that delay is pure latency. wakeSkipped brings those tasks forward to now.
 *
 * The hard part is the claim in flight: the engine may have claimed the task
 * and evaluated runWhen against the old state just before the wake. Its skip
 * save then lands after the wake and would park the task 30s out again. A
 * wake done from outside the engine (an UPDATE on the row) cannot close that
 * window; the engine can.
 *
 * Key scenarios tested:
 * - Parked skips move to now and run on the next tick
 * - The reason filter selects by the last skip's reason
 * - Failure backoff and due tasks are left alone
 * - Claim, flip the condition, wake, then finish the skip: due now, not 30s
 * - A wake that lands while the skip is being saved still wins
 * - run()'s idle sleep is cut short so the loop claims at once
 */

import { WorkflowEngine } from '../../../../src/core/engine/WorkflowEngine';
import { InMemoryStorage } from '../../../../src/storage/memory';
import { SQLiteStorage } from '../../../../src/storage/sqlite';
import { BetterSqlite3Driver } from '../../../../src/storage/sqlite/internal/BetterSqlite3Driver';
import { MockClock, MockScheduler, MockEnvironment } from '../../../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../../../src/core/definitions';
import type { ActivityTask, RunConditionFn, Storage } from '../../../../src/core/types';

const SKIP_DELAY = 30000;

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

async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe.each(backends)('WorkflowEngine - wakeSkipped ($name)', ({ create }) => {
  let storage: Storage;
  let clock: MockClock;
  let scheduler: MockScheduler;
  let environment: MockEnvironment;
  let engine: WorkflowEngine;
  let online: boolean;
  let runs: string[];

  beforeEach(async () => {
    storage = await create();
    clock = new MockClock(1000000);
    scheduler = new MockScheduler(clock);
    environment = new MockEnvironment();
    online = false;
    runs = [];
  });

  afterEach(() => {
    engine?.stop();
  });

  async function createEngine(s: Storage = storage): Promise<WorkflowEngine> {
    engine = await WorkflowEngine.create({ storage: s, clock, scheduler, environment, random: () => 1 });
    return engine;
  }

  function gated(name: string, runWhen: RunConditionFn) {
    return defineWorkflow({
      name: `wf-${name}`,
      activities: [
        defineActivity<Record<string, unknown>, { ok: boolean }>({
          name,
          execute: async () => {
            runs.push(name);
            return { ok: true };
          },
          runWhen,
        }),
      ],
    });
  }

  const offlineGate: RunConditionFn = () => (online ? { ready: true } : { ready: false, reason: 'offline' });

  async function onlyTask(runId: string): Promise<ActivityTask> {
    const [task] = await storage.getActivityTasksForExecution(runId);
    return task!;
  }

  it('brings a parked skip forward to now, and the next tick runs it', async () => {
    await createEngine();
    const execution = await engine.start(gated('upload', offlineGate), { input: {} });

    await engine.tick();
    expect((await onlyTask(execution.runId)).scheduledFor).toBe(clock.now() + SKIP_DELAY);

    clock.advance(2000);
    online = true;
    expect(await engine.wakeSkipped({ reason: 'offline' })).toBe(1);

    const woken = await onlyTask(execution.runId);
    expect(woken.status).toBe('pending');
    expect(woken.scheduledFor).toBe(clock.now());
    // History is the engine's record of what happened; a wake adds nothing.
    expect(woken.errorHistory).toEqual([{ at: 1000000, kind: 'skip', message: 'offline' }]);

    await engine.tick();
    expect(runs).toEqual(['upload']);
  });

  it('selects by the reason of the last skip, and wakes every skip with no filter', async () => {
    await createEngine();
    const a = await engine.start(gated('upload', offlineGate), { input: {} });
    const b = await engine.start(gated('charge', () => ({ ready: false, reason: 'battery low' })), { input: {} });

    await engine.tick();
    const parkedAt = clock.now() + SKIP_DELAY;

    expect(await engine.wakeSkipped({ reason: 'offline' })).toBe(1);
    expect((await onlyTask(a.runId)).scheduledFor).toBe(clock.now());
    expect((await onlyTask(b.runId)).scheduledFor).toBe(parkedAt);

    // Re-park the first, then wake without a filter.
    await engine.tick();
    expect(await engine.wakeSkipped()).toBe(2);
    expect((await onlyTask(a.runId)).scheduledFor).toBe(clock.now());
    expect((await onlyTask(b.runId)).scheduledFor).toBe(clock.now());
  });

  it('leaves a failure backoff alone, so a flapping signal is not a retry storm', async () => {
    await createEngine();
    let calls = 0;
    const workflow = defineWorkflow({
      name: 'wf-flaky',
      activities: [
        defineActivity<Record<string, unknown>, { ok: boolean }>({
          name: 'flaky',
          execute: async () => {
            calls++;
            throw new Error('503');
          },
          retry: { maximumAttempts: 5, initialInterval: 10000 },
        }),
      ],
    });
    const execution = await engine.start(workflow, { input: {} });

    await engine.tick();
    const backoff = await onlyTask(execution.runId);
    expect(backoff.status).toBe('pending');
    expect(backoff.scheduledFor).toBeGreaterThan(clock.now());

    expect(await engine.wakeSkipped()).toBe(0);
    expect((await onlyTask(execution.runId)).scheduledFor).toBe(backoff.scheduledFor);
    expect(calls).toBe(1);
  });

  it('returns 0 and writes nothing when nothing is parked', async () => {
    await createEngine();
    const execution = await engine.start(gated('upload', offlineGate), { input: {} });
    const before = await onlyTask(execution.runId);

    expect(await engine.wakeSkipped({ reason: 'offline' })).toBe(0);
    expect(await onlyTask(execution.runId)).toEqual(before);
  });

  it('claim, flip the condition, wake, then finish the skip: the task is due now, not 30s out', async () => {
    await createEngine();
    let wake: Promise<number> | undefined;
    // runWhen runs between the claim and the skip save. Evaluate against the
    // old (offline) state, then let the online edge land and wake, exactly
    // the window the app-side UPDATE could not close.
    const racing: RunConditionFn = () => {
      if (online) return { ready: true };
      if (!wake) {
        online = true;
        wake = engine.wakeSkipped({ reason: 'offline' });
      }
      return { ready: false, reason: 'offline' };
    };
    const execution = await engine.start(gated('upload', racing), { input: {} });

    await engine.tick();
    await wake;

    const task = await onlyTask(execution.runId);
    expect(task.status).toBe('pending');
    expect(task.scheduledFor).toBe(clock.now());

    await engine.tick();
    expect(runs).toEqual(['upload']);
  });

  it('a wake for a different reason does not shorten an in-flight skip', async () => {
    await createEngine();
    let wake: Promise<number> | undefined;
    const racing: RunConditionFn = () => {
      wake ??= engine.wakeSkipped({ reason: 'battery low' });
      return { ready: false, reason: 'offline' };
    };
    const execution = await engine.start(gated('upload', racing), { input: {} });

    await engine.tick();
    await wake;

    expect((await onlyTask(execution.runId)).scheduledFor).toBe(clock.now() + SKIP_DELAY);
  });

  it('a wake that lands while the skip row is being written still wins', async () => {
    // Fire the wake from inside the skip's own save, after the engine has
    // decided the delay. The wake has to wait for that save, then move it.
    let wake: Promise<number> | undefined;
    const inner = storage;
    const intercepting: Storage = Object.create(inner) as Storage;
    intercepting.saveActivityTask = async (t: ActivityTask) => {
      if (!wake && t.status === 'pending' && (t.scheduledFor ?? 0) > clock.now()) {
        online = true;
        wake = engine.wakeSkipped({ reason: 'offline' });
      }
      return inner.saveActivityTask(t);
    };
    await createEngine(intercepting);
    const execution = await engine.start(gated('upload', offlineGate), { input: {} });

    await engine.tick();
    expect(wake).toBeDefined();
    expect(await wake).toBe(1);

    expect((await onlyTask(execution.runId)).scheduledFor).toBe(clock.now());
    await engine.tick();
    expect(runs).toEqual(['upload']);
  });

  it('cuts run()’s idle sleep short so the loop claims the woken task at once', async () => {
    await createEngine();
    await engine.start(gated('upload', offlineGate), { input: {} });

    const loop = engine.run({ tickInterval: 60000 });
    await flush();
    expect(runs).toEqual([]);

    // The loop is asleep for a minute. Nothing advances the clock.
    online = true;
    await engine.wakeSkipped({ reason: 'offline' });
    await flush(200);
    expect(runs).toEqual(['upload']);

    engine.stop();
    scheduler.runAll();
    await loop;
  });
});
