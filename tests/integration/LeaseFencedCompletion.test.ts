/**
 * Lease-fenced completion.
 *
 * Two engines share one database: the foreground app engine and a fresh
 * engine per background wake. If the OS freezes engine A mid-activity
 * (iOS suspends the process, so its heartbeat timer cannot fire), A's
 * lease lapses and engine B re-claims and finishes the task. When A thaws,
 * its attempt settles too. Before the fence, A's late success or failure
 * overwrote B's row (saveActivityTask is INSERT OR REPLACE) and advanced
 * the workflow a second time, so every later step ran twice.
 *
 * The engine now records a result only while it still holds the claim
 * (task_id, owner_id, status 'active'). A stale result is dropped.
 */

import { WorkflowEngine } from '../../src/core/engine';
import { MockClock, MockScheduler, MockEnvironment } from '../../src/core/mocks';
import { defineActivity } from '../../src/core/definitions';
import { EngineEvent, Storage, Workflow } from '../../src/core/types';
import { InMemoryStorage } from '../../src/storage/memory';
import { SQLiteStorage } from '../../src/storage/sqlite';
import { BetterSqlite3Driver } from '../../src/storage/sqlite/internal/BetterSqlite3Driver';

const LEASE_MS = 10_000;

/** Let pending microtasks (claims, saves) settle. */
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

interface Gate {
  promise: Promise<Record<string, unknown>>;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

function gate(): Gate {
  let resolve!: Gate['resolve'];
  let reject!: Gate['reject'];
  const promise = new Promise<Record<string, unknown>>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function createEngine(storage: Storage, clock: MockClock, events: EngineEvent[]) {
  // Each engine gets its own scheduler. Nothing ever ticks A's, which is
  // what a frozen process looks like: its heartbeat never fires.
  return WorkflowEngine.create({
    storage,
    clock,
    scheduler: new MockScheduler(clock),
    environment: new MockEnvironment({ isConnected: true, batteryLevel: 1.0 }),
    leaseDurationMs: LEASE_MS,
    onEvent: e => events.push(e),
  });
}

/**
 * A two-step workflow whose first attempt at step one blocks on a gate the
 * test controls. Every later attempt at step one returns at once.
 */
function twoStep(firstMaxAttempts: number) {
  const runs = { first: 0, second: 0 };
  const onFailure: string[] = [];
  const firstAttempt = gate();
  const workflow: Workflow = {
    name: 'twoStep',
    activities: [
      defineActivity({
        name: 'first',
        startToCloseTimeout: 0,
        retry: { maximumAttempts: firstMaxAttempts },
        onFailure: async (_taskId, _input, error) => {
          onFailure.push(error.message);
        },
        execute: async () => {
          runs.first++;
          if (runs.first === 1) return firstAttempt.promise;
          return { first: 'ran' };
        },
      }),
      defineActivity({
        name: 'second',
        retry: { maximumAttempts: 3 },
        execute: async () => {
          runs.second++;
          return { second: 'ran' };
        },
      }),
    ],
  };
  return { workflow, runs, onFailure, firstAttempt };
}

const storages: Array<[string, () => Promise<Storage>]> = [
  ['InMemoryStorage', async () => new InMemoryStorage()],
  [
    'SQLiteStorage',
    async () => {
      const storage = new SQLiteStorage(await BetterSqlite3Driver.create(':memory:'));
      await storage.initialize();
      return storage;
    },
  ],
];

describe.each(storages)('lease-fenced completion (%s)', (_name, makeStorage) => {
  /**
   * Engine A claims step one and freezes inside it. The clock passes the
   * lease, engine B boots (recovering the lapsed task), claims step one,
   * finishes it and advances to step two. Returns everything the test
   * needs to thaw A and drive B to the end.
   */
  async function freezeAndTakeOver(firstMaxAttempts: number) {
    const storage = await makeStorage();
    const clock = new MockClock(1_000_000);
    const eventsA: EngineEvent[] = [];
    const eventsB: EngineEvent[] = [];
    const wf = twoStep(firstMaxAttempts);

    const a = await createEngine(storage, clock, eventsA);
    a.registerWorkflow(wf.workflow);
    const execution = await a.start(wf.workflow, { input: {} });

    const tickA = a.tick();
    await flush();
    expect(wf.runs.first).toBe(1);

    // A is frozen. Its lease lapses with no heartbeat.
    clock.advance(LEASE_MS * 2);

    const b = await createEngine(storage, clock, eventsB);
    b.registerWorkflow(wf.workflow);
    await b.tick();
    expect(wf.runs.first).toBe(2);

    const [firstTask] = (await storage.getActivityTasksForExecution(execution.runId)).filter(
      t => t.activityName === 'first'
    );
    expect(firstTask?.status).toBe('completed');

    async function driveB() {
      for (let i = 0; i < 6; i++) {
        clock.advance(1000);
        await b.tick();
      }
    }

    return { storage, clock, a, b, tickA, eventsA, eventsB, execution, wf, driveB };
  }

  it('drops the frozen engine\'s late success, so step two runs once', async () => {
    const h = await freezeAndTakeOver(3);

    // A thaws and its stale attempt resolves.
    h.wf.firstAttempt.resolve({ first: 'stale' });
    await h.tickA;
    await h.driveB();

    expect(h.wf.runs.second).toBe(1);

    const final = await h.storage.getExecution(h.execution.runId);
    expect(final?.status).toBe('completed');
    // B's result stands; A's never reached the workflow state.
    expect(final?.state).toMatchObject({ first: 'ran', second: 'ran' });

    const tasks = await h.storage.getActivityTasksForExecution(h.execution.runId);
    expect(tasks.map(t => t.activityName).sort()).toEqual(['first', 'second']);
    expect(tasks.every(t => t.status === 'completed')).toBe(true);
    expect(await h.storage.getActivityTasksByStatus('active')).toEqual([]);
    expect(await h.storage.getActivityTasksByStatus('pending')).toEqual([]);

    const firstTask = tasks.find(t => t.activityName === 'first');
    expect(firstTask?.result).toEqual({ first: 'ran' });

    const dropped = h.eventsA.filter(e => e.type === 'activity:stale-completion-dropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ activityName: 'first', outcome: 'completed' });
    // A recorded no completion of its own.
    expect(h.eventsA.filter(e => e.type === 'activity:completed')).toEqual([]);
  });

  it('drops the frozen engine\'s late failure, so no retry is scheduled', async () => {
    const h = await freezeAndTakeOver(3);

    h.wf.firstAttempt.reject(new Error('network gone'));
    await h.tickA;
    await h.driveB();

    // Without the fence A wrote step one back to pending over B's
    // completed row, so step one and step two both ran again.
    expect(h.wf.runs.first).toBe(2);
    expect(h.wf.runs.second).toBe(1);
    expect(h.wf.onFailure).toEqual([]);

    const final = await h.storage.getExecution(h.execution.runId);
    expect(final?.status).toBe('completed');

    const tasks = await h.storage.getActivityTasksForExecution(h.execution.runId);
    expect(tasks.every(t => t.status === 'completed')).toBe(true);
    expect(tasks.find(t => t.activityName === 'first')?.failures ?? 0).toBe(0);
    expect(await h.storage.getActivityTasksByStatus('active')).toEqual([]);
    expect(await h.storage.getActivityTasksByStatus('pending')).toEqual([]);

    const dropped = h.eventsA.filter(e => e.type === 'activity:stale-completion-dropped');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ activityName: 'first', outcome: 'failed', error: 'network gone' });
  });

  it('drops the frozen engine\'s late permanent failure, so nothing is dead-lettered', async () => {
    // One attempt: A's failure would exhaust the budget and dead-letter.
    const h = await freezeAndTakeOver(1);

    h.wf.firstAttempt.reject(new Error('network gone'));
    await h.tickA;
    await h.driveB();

    expect(h.wf.runs.second).toBe(1);
    expect(await h.storage.getDeadLetters()).toEqual([]);

    const final = await h.storage.getExecution(h.execution.runId);
    expect(final?.status).toBe('completed');
    expect(await h.storage.getActivityTasksByStatus('failed')).toEqual([]);
    expect(await h.storage.getActivityTasksByStatus('active')).toEqual([]);

    expect(h.eventsA.filter(e => e.type === 'deadletter:added')).toEqual([]);
    expect(h.eventsA.filter(e => e.type === 'activity:stale-completion-dropped')).toHaveLength(1);
  });
});
