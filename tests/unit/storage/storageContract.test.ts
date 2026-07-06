/**
 * Shared storage-contract suite (review issue M4).
 *
 * InMemory vs SQLite semantics diverged in the reviewed code (active-map
 * vs index-based uniqueness), so tests could pass on one backend while
 * behavior differed on device. Every behavior the ENGINE depends on runs
 * here against all three backends:
 *   - InMemoryStorage
 *   - SQLiteStorage over BetterSqlite3Driver (Node tests)
 *   - SQLiteStorage over ExpoSqliteDriver + a faithful expo-sqlite v14+
 *     double (the on-device shape, incl. void withTransactionAsync)
 *
 * Sequences mirror how the engine actually calls storage (e.g. the
 * uniqueKey reservation happens inside a transaction followed by
 * saveExecution), not idealized API usage.
 */

import Database from 'better-sqlite3';
import { Storage, WorkflowExecution, ActivityTask, DeadLetterRecord } from '../../../src/core/types';
import { InMemoryStorage } from '../../../src/storage/memory';
import { SQLiteStorage } from '../../../src/storage/sqlite';
import { BetterSqlite3Driver } from '../../../src/storage/sqlite/internal/BetterSqlite3Driver';
import { ExpoSqliteDriver } from '../../../src/storage/sqlite/internal/ExpoSqliteDriver';
import { FakeExpoSQLiteDatabase } from '../../utils/fakeExpoSqlite';

interface Backend {
  name: string;
  create: () => Promise<Storage>;
}

const backends: Backend[] = [
  { name: 'InMemoryStorage', create: async () => new InMemoryStorage() },
  {
    name: 'SQLiteStorage(better-sqlite3)',
    create: async () => {
      const storage = new SQLiteStorage(await BetterSqlite3Driver.create(':memory:'));
      await storage.initialize();
      return storage;
    },
  },
  {
    name: 'SQLiteStorage(expo-sqlite double)',
    create: async () => {
      const fake = new FakeExpoSQLiteDatabase(new Database(':memory:'));
      const driver = await ExpoSqliteDriver.create('contract.db', async () => fake);
      const storage = new SQLiteStorage(driver);
      await storage.initialize();
      return storage;
    },
  },
];

const execution = (overrides: Partial<WorkflowExecution> = {}): WorkflowExecution => ({
  runId: 'run-1',
  workflowName: 'wf',
  currentActivityIndex: 0,
  currentActivityName: 'work',
  status: 'running',
  input: { a: 1 },
  state: { a: 1 },
  createdAt: 1000,
  updatedAt: 1000,
  ...overrides,
});

const task = (overrides: Partial<ActivityTask> = {}): ActivityTask => ({
  taskId: 'task-1',
  runId: 'run-1',
  activityName: 'work',
  status: 'pending',
  priority: 0,
  attempts: 0,
  failures: 0,
  maxAttempts: 3,
  timeout: 25000,
  input: { a: 1 },
  createdAt: 1001,
  ...overrides,
});

const deadLetter = (overrides: Partial<DeadLetterRecord> = {}): DeadLetterRecord => ({
  id: 'dl-1',
  runId: 'run-1',
  taskId: 'task-1',
  activityName: 'work',
  workflowName: 'wf',
  input: { a: 1 },
  error: 'boom',
  attempts: 3,
  failedAt: 2000,
  acknowledged: false,
  nonRetryable: false,
  ...overrides,
});

describe.each(backends)('storage contract (M4) — $name', ({ create }) => {
  let storage: Storage;

  beforeEach(async () => {
    storage = await create();
  });

  describe('executions', () => {
    it('round-trips every field including the Phase 2 additions', async () => {
      const full = execution({
        workflowVersion: '3',
        uniqueKey: 'K',
        metadata: { moveId: 7 },
        error: 'e',
        failedActivityName: 'work',
        completedAt: 5000,
        status: 'failed',
      });
      await storage.saveExecution(full);

      expect(await storage.getExecution('run-1')).toEqual(full);
      expect(await storage.getExecution('missing')).toBeNull();
    });

    it('updates in place without duplicating', async () => {
      await storage.saveExecution(execution());
      await storage.saveExecution(execution({ status: 'completed', completedAt: 2000 }));

      expect(await storage.getExecutions({})).toHaveLength(1);
      expect((await storage.getExecution('run-1'))?.status).toBe('completed');
    });

    it('updating an execution does not destroy its tasks (no REPLACE cascade)', async () => {
      await storage.saveExecution(execution());
      await storage.saveActivityTask(task());

      await storage.saveExecution(execution({ updatedAt: 2000 }));
      expect(await storage.getActivityTask('task-1')).not.toBeNull();
    });
  });

  describe('claiming', () => {
    beforeEach(async () => {
      await storage.saveExecution(execution());
      await storage.saveActivityTask(task());
    });

    it('claims a pending task exactly once', async () => {
      const lease = { ownerId: 'engine-A', leaseDurationMs: 60000 };
      const claimed = await storage.claimActivityTask('task-1', 5000, lease);
      expect(claimed).toMatchObject({
        status: 'active',
        attempts: 1,
        ownerId: 'engine-A',
        leaseExpiresAt: 65000,
        startedAt: 5000,
      });

      // Second claim loses the race
      expect(await storage.claimActivityTask('task-1', 5001, { ...lease, ownerId: 'engine-B' })).toBeNull();
    });

    it('refuses to claim before scheduledFor', async () => {
      await storage.saveActivityTask(task({ taskId: 'task-2', scheduledFor: 9000 }));
      expect(await storage.claimActivityTask('task-2', 5000, { ownerId: 'x', leaseDurationMs: 1000 })).toBeNull();
      expect(await storage.claimActivityTask('task-2', 9000, { ownerId: 'x', leaseDurationMs: 1000 })).not.toBeNull();
    });

    it('renews only the owner’s active lease', async () => {
      await storage.claimActivityTask('task-1', 5000, { ownerId: 'engine-A', leaseDurationMs: 1000 });

      expect(await storage.renewLease('task-1', 'engine-A', 7000)).toBe(true);
      expect((await storage.getActivityTask('task-1'))?.leaseExpiresAt).toBe(7000);

      expect(await storage.renewLease('task-1', 'engine-B', 9000)).toBe(false);
      expect(await storage.renewLease('missing', 'engine-A', 9000)).toBe(false);
    });
  });

  describe('pending queue', () => {
    it('orders by priority DESC then createdAt ASC, respecting scheduledFor and limit', async () => {
      await storage.saveExecution(execution());
      await storage.saveActivityTask(task({ taskId: 'low-old', priority: 1, createdAt: 1000 }));
      await storage.saveActivityTask(task({ taskId: 'high', priority: 10, createdAt: 3000 }));
      await storage.saveActivityTask(task({ taskId: 'low-new', priority: 1, createdAt: 2000 }));
      await storage.saveActivityTask(task({ taskId: 'future', priority: 50, createdAt: 500, scheduledFor: 99000 }));
      await storage.saveActivityTask(task({ taskId: 'done', priority: 50, createdAt: 400, status: 'completed' }));

      const pending = await storage.getPendingActivityTasks({ now: 5000 });
      expect(pending.map(t => t.taskId)).toEqual(['high', 'low-old', 'low-new']);

      const limited = await storage.getPendingActivityTasks({ now: 5000, limit: 2 });
      expect(limited.map(t => t.taskId)).toEqual(['high', 'low-old']);
    });
  });

  describe('uniqueKey (engine sequence)', () => {
    /** Reserve + persist exactly the way engine.start does. */
    async function startWithKey(runId: string, key: string): Promise<boolean> {
      try {
        await storage.transaction(async () => {
          const ok = await storage.setUniqueKey('wf', key, runId);
          if (!ok) throw new Error('conflict');
          await storage.saveExecution(execution({ runId, uniqueKey: key }));
        });
        return true;
      } catch {
        return false;
      }
    }

    it('allows one running execution per key, releasing on completion', async () => {
      expect(await startWithKey('run-1', 'K')).toBe(true);
      expect(await startWithKey('run-2', 'K')).toBe(false);

      // Loser's write rolled back
      expect(await storage.getExecution('run-2')).toBeNull();

      // Completing the holder releases the key…
      await storage.saveExecution(execution({ runId: 'run-1', uniqueKey: 'K', status: 'completed', completedAt: 2000 }));
      await storage.deleteUniqueKey('wf', 'K');
      expect(await startWithKey('run-3', 'K')).toBe(true);

      // …and the completed history survives
      expect((await storage.getExecution('run-1'))?.status).toBe('completed');
    });

    it('getUniqueKey resolves only the running holder', async () => {
      await startWithKey('run-1', 'K');
      expect(await storage.getUniqueKey('wf', 'K')).toBe('run-1');

      await storage.saveExecution(execution({ runId: 'run-1', uniqueKey: 'K', status: 'failed', completedAt: 2000 }));
      await storage.deleteUniqueKey('wf', 'K');
      expect(await storage.getUniqueKey('wf', 'K')).toBeNull();
    });
  });

  describe('transactions', () => {
    it('rolls back all writes when the callback throws', async () => {
      await storage.saveExecution(execution());

      await expect(
        storage.transaction(async () => {
          await storage.saveActivityTask(task());
          await storage.saveExecution(execution({ status: 'completed' }));
          throw new Error('injected');
        })
      ).rejects.toThrow('injected');

      expect(await storage.getActivityTask('task-1')).toBeNull();
      expect((await storage.getExecution('run-1'))?.status).toBe('running');
    });

    it('joins nested transactions instead of failing', async () => {
      await storage.transaction(async () => {
        await storage.saveExecution(execution());
        await storage.transaction(async () => {
          await storage.saveActivityTask(task());
        });
      });

      expect(await storage.getActivityTask('task-1')).not.toBeNull();
    });
  });

  describe('dead letters', () => {
    it('round-trips, acknowledges, and purges', async () => {
      await storage.saveDeadLetter(deadLetter());
      await storage.saveDeadLetter(deadLetter({ id: 'dl-2', failedAt: 9000, nonRetryable: true }));

      expect(await storage.getDeadLetters()).toHaveLength(2);
      const nonRetryable = (await storage.getDeadLetters()).find(d => d.id === 'dl-2');
      expect(nonRetryable?.nonRetryable).toBe(true);

      await storage.acknowledgeDeadLetter('dl-1');
      expect((await storage.getUnacknowledgedDeadLetters()).map(d => d.id)).toEqual(['dl-2']);

      const purged = await storage.purgeDeadLetters({ olderThanMs: 1000, acknowledgedOnly: true, now: 10000 });
      expect(purged).toBe(1);
      expect((await storage.getDeadLetters()).map(d => d.id)).toEqual(['dl-2']);
    });
  });

  describe('maintenance', () => {
    it('purges old terminal executions together with their tasks', async () => {
      await storage.saveExecution(execution({ runId: 'old', status: 'completed', completedAt: 1000, updatedAt: 1000 }));
      await storage.saveActivityTask(task({ taskId: 'old-task', runId: 'old' }));
      await storage.saveExecution(execution({ runId: 'fresh', status: 'completed', completedAt: 9500, updatedAt: 9500 }));
      await storage.saveExecution(execution({ runId: 'live', status: 'running', updatedAt: 1000 }));

      const purged = await storage.purgeExecutions({ olderThanMs: 5000, statuses: ['completed', 'failed', 'cancelled'], now: 10000 });
      expect(purged).toBe(1);
      expect(await storage.getExecution('old')).toBeNull();
      expect(await storage.getActivityTask('old-task')).toBeNull();
      expect(await storage.getExecution('fresh')).not.toBeNull();
      expect(await storage.getExecution('live')).not.toBeNull();
    });
  });
});
