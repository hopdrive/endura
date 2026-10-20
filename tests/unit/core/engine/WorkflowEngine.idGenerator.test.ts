/**
 * Unit Test: WorkflowEngine - per-engine id generator
 *
 * Hermes has no globalThis.crypto. Before this option an engine could only
 * get a random source from the module-level setIdGenerator, and an engine
 * built without one failed inside a field initializer with a generic Error.
 * These tests run with globalThis.crypto removed, the way a Hermes app sees
 * the world.
 */

import { WorkflowEngine } from '../../../../src/core/engine/WorkflowEngine';
import { InMemoryStorage } from '../../../../src/storage/memory';
import { SQLiteStorage } from '../../../../src/storage/sqlite';
import { BetterSqlite3Driver } from '../../../../src/storage/sqlite/internal/BetterSqlite3Driver';
import { MockClock, MockScheduler, MockEnvironment } from '../../../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../../../src/core/definitions';
import { NoRandomSourceError, generateId, setIdGenerator } from '../../../../src/core';
import * as rootExports from '../../../../src';

function counterGenerator(prefix: string) {
  const minted: string[] = [];
  const fn = () => {
    const id = `${prefix}-${minted.length + 1}`;
    minted.push(id);
    return id;
  };
  return { fn, minted };
}

const failing = defineActivity<Record<string, unknown>, { done: boolean }>({
  name: 'failing',
  execute: async (): Promise<{ done: boolean }> => {
    throw new Error('permanent');
  },
  retry: { maximumAttempts: 1 },
});

const workflow = defineWorkflow({ name: 'idWorkflow', activities: [failing] });

describe('WorkflowEngine - per-engine id generator', () => {
  let storage: InMemoryStorage;
  let clock: MockClock;

  beforeEach(() => {
    vi.stubGlobal('crypto', undefined);
    storage = new InMemoryStorage();
    clock = new MockClock(1000000);
  });

  afterEach(() => {
    setIdGenerator(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function baseConfig() {
    return {
      storage,
      clock,
      scheduler: new MockScheduler(clock),
      environment: new MockEnvironment(),
    };
  }

  it('mints owner, run, task and dead-letter ids from the injected generator', async () => {
    // Sanity: the module-level path has no source in this test.
    expect(() => generateId()).toThrow(NoRandomSourceError);

    const gen = counterGenerator('eng');
    const claimOwners: string[] = [];
    const claim = storage.claimActivityTask.bind(storage);
    vi.spyOn(storage, 'claimActivityTask').mockImplementation(async (taskId, now, lease) => {
      if (lease) claimOwners.push(lease.ownerId);
      return claim(taskId, now, lease);
    });

    const engine = await WorkflowEngine.create({ ...baseConfig(), generateId: gen.fn });
    engine.registerWorkflow(workflow);

    const execution = await engine.start(workflow, { input: {} });
    await engine.tick();

    const tasks = await storage.getActivityTasksForExecution(execution.runId);
    const deadLetters = await storage.getDeadLetters();

    expect(deadLetters).toHaveLength(1);
    expect(claimOwners).toHaveLength(1);

    const seen = [execution.runId, ...tasks.map(t => t.taskId), deadLetters[0]!.id, claimOwners[0]!];
    for (const id of seen) {
      expect(gen.minted).toContain(id);
    }
    // Owner, run, task and dead letter: four distinct ids, all from the generator.
    expect(new Set(seen).size).toBe(4);
  });

  it('keeps two engines with different generators apart', async () => {
    const a = counterGenerator('a');
    const b = counterGenerator('b');

    const engineA = await WorkflowEngine.create({ ...baseConfig(), generateId: a.fn });
    const engineB = await WorkflowEngine.create({
      ...baseConfig(),
      storage: new InMemoryStorage(),
      generateId: b.fn,
    });

    const runA = await engineA.start(workflow, { input: {} });
    const runB = await engineB.start(workflow, { input: {} });

    expect(runA.runId).toMatch(/^a-/);
    expect(runB.runId).toMatch(/^b-/);
  });

  it('prefers the per-engine generator over setIdGenerator', async () => {
    setIdGenerator(() => 'global-id');
    const gen = counterGenerator('local');

    const engine = await WorkflowEngine.create({ ...baseConfig(), generateId: gen.fn });
    const execution = await engine.start(workflow, { input: {} });

    expect(execution.runId).toMatch(/^local-/);
  });

  it('still falls back to setIdGenerator when no per-engine generator is given', async () => {
    setIdGenerator(() => 'global-id');

    const engine = await WorkflowEngine.create(baseConfig());
    const execution = await engine.start(workflow, { input: {} });

    expect(execution.runId).toBe('global-id');
  });

  it('throws NoRandomSourceError from create, before touching storage, when no source exists', async () => {
    const reads = vi.spyOn(storage, 'getActivityTasksByStatus');

    const attempt = WorkflowEngine.create(baseConfig());

    await expect(attempt).rejects.toBeInstanceOf(NoRandomSourceError);
    await expect(attempt).rejects.toThrow(/generateId/);
    await expect(attempt).rejects.toThrow(/setIdGenerator/);
    expect(reads).not.toHaveBeenCalled();
  });

  it('exports NoRandomSourceError from the package root', () => {
    expect(rootExports.NoRandomSourceError).toBe(NoRandomSourceError);
    const err = new NoRandomSourceError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('NoRandomSourceError');
  });
});

describe('SQLiteStorage - injected id generator', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('mints the quarantine dead-letter id from the generator it was given', async () => {
    vi.stubGlobal('crypto', undefined);
    const gen = counterGenerator('store');

    const driver = await BetterSqlite3Driver.create(':memory:');
    const storage = new SQLiteStorage(driver, { generateId: gen.fn });
    await storage.initialize();

    await driver.execute(
      `INSERT INTO executions (run_id, workflow_name, current_activity_index, current_activity_name,
        status, input, state, created_at, updated_at)
       VALUES ('run-bad', 'wf', 0, 'work', 'running', '{}', '{}', 1000, 1000)`
    );
    await driver.execute(
      `INSERT INTO activity_tasks (task_id, run_id, activity_name, status, priority, attempts,
        failures, max_attempts, timeout, input, created_at)
       VALUES ('task-bad', 'run-bad', 'work', 'pending', 0, 0, 0, 3, 25000, '{not json!', 1000)`
    );

    await storage.getPendingActivityTasks({ now: 5000 });

    const deadLetters = await storage.getDeadLetters();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]!.id).toBe('store-1');
  });
});
