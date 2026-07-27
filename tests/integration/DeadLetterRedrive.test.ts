/**
 * Dead letter redrive over real SQLite (review issue H5).
 *
 * The unit suite proves the redrive contract against InMemoryStorage;
 * this suite proves the same contract over SQLiteStorage with real
 * BEGIN IMMEDIATE transactions, because the two backends enforce
 * uniqueKey differently: InMemory via its key map, SQLite via the
 * running-scoped partial unique index that saveExecution hits when the
 * revived execution flips back to 'running'.
 */

import { WorkflowEngine } from '../../src/core/engine';
import { MockClock, MockScheduler, MockEnvironment } from '../../src/core/mocks';
import { defineActivity } from '../../src/core/definitions';
import { Workflow } from '../../src/core/types';
import { SQLiteStorage } from '../../src/storage/sqlite';
import { BetterSqlite3Driver } from '../../src/storage/sqlite/internal/BetterSqlite3Driver';
import { createLoopbackDispatcher } from '../../src/workers/loopback';

let shouldFail = true;

const workflow: Workflow = {
  name: 'keyed',
  activities: [
    defineActivity({
      name: 'work',
      execute: async () => {
        if (shouldFail) {
          throw new Error('outage');
        }
        return { done: true };
      },
      retry: { maximumAttempts: 1 },
    }),
  ],
};

async function createHarness() {
  const driver = await BetterSqlite3Driver.create(':memory:');
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
  engine.registerWorkflow(workflow);
  return { storage, clock, engine };
}

describe('dead letter redrive over SQLite (H5)', () => {
  beforeEach(() => {
    shouldFail = true;
  });

  it('redrives a keyed execution and completes it', async () => {
    const h = await createHarness();

    const execution = await h.engine.start(workflow, { input: {}, uniqueKey: 'K' });
    await h.engine.tick();
    expect((await h.storage.getExecution(execution.runId))?.status).toBe('failed');

    const dl = (await h.engine.getDeadLetters())[0]!;
    shouldFail = false;
    const revived = await h.engine.retryFromDeadLetter(dl.id);
    expect(revived.status).toBe('running');
    expect(await h.engine.getDeadLetters()).toHaveLength(0);

    await h.engine.tick();
    expect((await h.storage.getExecution(execution.runId))?.status).toBe('completed');
  });

  it('rolls back the whole redrive when the uniqueKey is held by a live execution', async () => {
    const h = await createHarness();

    // First keyed execution fails permanently, releasing K
    const first = await h.engine.start(workflow, { input: { n: 1 }, uniqueKey: 'K' });
    await h.engine.tick();
    const dl = (await h.engine.getDeadLetters())[0]!;

    // Second keyed execution now owns K and stays running
    shouldFail = false;
    const second = await h.engine.start(workflow, { input: { n: 2 }, uniqueKey: 'K' });
    expect((await h.storage.getExecution(second.runId))?.status).toBe('running');

    await expect(h.engine.retryFromDeadLetter(dl.id)).rejects.toThrow(/unique/i);

    // Rolled back: DLQ record intact, first still failed, task still failed
    expect(await h.engine.getDeadLetters()).toHaveLength(1);
    expect((await h.storage.getExecution(first.runId))?.status).toBe('failed');
    const task = await h.storage.getActivityTask(dl.taskId);
    expect(task?.status).toBe('failed');
  });
});
