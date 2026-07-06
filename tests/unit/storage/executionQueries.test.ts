/**
 * Scoped execution queries + metadata (review issue M6).
 *
 * Inspection used to be status-only with no pagination and no way to
 * scope executions to an app-domain grouping (the driver app groups
 * recovery items per move). Executions can now carry opaque metadata,
 * and getExecutions supports status/workflowName filters with
 * limit/offset pagination, newest first. Runs against both backends so
 * semantics can't diverge (M4's concern, applied here).
 */

import { Storage, WorkflowExecution } from '../../../src/core/types';
import { InMemoryStorage } from '../../../src/storage/memory';
import { SQLiteStorage } from '../../../src/storage/sqlite';
import { BetterSqlite3Driver } from '../../../src/storage/sqlite/internal/BetterSqlite3Driver';

interface Backend {
  name: string;
  create: () => Promise<Storage>;
}

const backends: Backend[] = [
  { name: 'InMemoryStorage', create: async () => new InMemoryStorage() },
  {
    name: 'SQLiteStorage',
    create: async () => {
      const driver = await BetterSqlite3Driver.create(':memory:');
      const storage = new SQLiteStorage(driver);
      await storage.initialize();
      return storage;
    },
  },
];

function makeExecution(overrides: Partial<WorkflowExecution>): WorkflowExecution {
  return {
    runId: 'run-x',
    workflowName: 'wf',
    currentActivityIndex: 0,
    currentActivityName: 'work',
    status: 'running',
    input: {},
    state: {},
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe.each(backends)('execution queries (M6) on $name', ({ create }) => {
  it('round-trips metadata', async () => {
    const storage = await create();
    await storage.saveExecution(
      makeExecution({ runId: 'run-1', metadata: { moveId: 42, kind: 'photo' } })
    );

    const loaded = await storage.getExecution('run-1');
    expect(loaded?.metadata).toEqual({ moveId: 42, kind: 'photo' });

    const unset = makeExecution({ runId: 'run-2' });
    await storage.saveExecution(unset);
    expect((await storage.getExecution('run-2'))?.metadata).toBeUndefined();
  });

  it('filters by status list and workflowName with pagination, newest first', async () => {
    const storage = await create();

    await storage.saveExecution(makeExecution({ runId: 'a', workflowName: 'photo', status: 'running', createdAt: 1000 }));
    await storage.saveExecution(makeExecution({ runId: 'b', workflowName: 'photo', status: 'failed', createdAt: 2000 }));
    await storage.saveExecution(makeExecution({ runId: 'c', workflowName: 'sync', status: 'failed', createdAt: 3000 }));
    await storage.saveExecution(makeExecution({ runId: 'd', workflowName: 'photo', status: 'completed', createdAt: 4000 }));
    await storage.saveExecution(makeExecution({ runId: 'e', workflowName: 'photo', status: 'failed', createdAt: 5000 }));

    // Status scoping (single)
    const failed = await storage.getExecutions({ status: 'failed' });
    expect(failed.map(x => x.runId)).toEqual(['e', 'c', 'b']);

    // Status list + workflow scoping
    const photoOpen = await storage.getExecutions({
      status: ['running', 'failed'],
      workflowName: 'photo',
    });
    expect(photoOpen.map(x => x.runId)).toEqual(['e', 'b', 'a']);

    // Pagination
    const page1 = await storage.getExecutions({ workflowName: 'photo', limit: 2 });
    expect(page1.map(x => x.runId)).toEqual(['e', 'd']);
    const page2 = await storage.getExecutions({ workflowName: 'photo', limit: 2, offset: 2 });
    expect(page2.map(x => x.runId)).toEqual(['b', 'a']);

    // No filters = everything, newest first
    const all = await storage.getExecutions({});
    expect(all.map(x => x.runId)).toEqual(['e', 'd', 'c', 'b', 'a']);
  });
});
