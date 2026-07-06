/**
 * Tests for SQLiteStorage adapter.
 * Uses better-sqlite3 for Node.js testing.
 */

import { SQLiteStorage } from '../../../../src/storage/sqlite';
import { BetterSqlite3Driver } from '../../../../src/testing';
import {
  WorkflowExecution,
  ActivityTask,
  DeadLetterRecord,
  StorageChange,
} from '../../../../src/core/types';

describe('SQLiteStorage', () => {
  let storage: SQLiteStorage;
  let driver: BetterSqlite3Driver;

  beforeEach(async () => {
    driver = await BetterSqlite3Driver.create(':memory:');
    storage = new SQLiteStorage(driver);
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
  });

  // ============================================================================
  // Initialization
  // ============================================================================

  describe('initialization', () => {
    it('should create database schema', async () => {
      // Schema should already be created in beforeEach
      // Verify tables exist by attempting to query them
      const executions = await storage.getExecutionsByStatus('running');
      expect(executions).toEqual([]);

      const tasks = await storage.getActivityTasksByStatus('pending');
      expect(tasks).toEqual([]);

      const deadLetters = await storage.getDeadLetters();
      expect(deadLetters).toEqual([]);
    });

    it('should only initialize once', async () => {
      // Multiple calls should not throw
      await storage.initialize();
      await storage.initialize();

      // Should still work
      const executions = await storage.getExecutionsByStatus('running');
      expect(executions).toEqual([]);
    });
  });

  // ============================================================================
  // Workflow Executions
  // ============================================================================

  describe('workflow executions', () => {
    const createExecution = (overrides: Partial<WorkflowExecution> = {}): WorkflowExecution => ({
      runId: 'run-1',
      workflowName: 'testWorkflow',
      currentActivityIndex: 0,
      currentActivityName: 'activity1',
      status: 'running',
      input: { foo: 'bar' },
      state: {},
      createdAt: 1000000,
      updatedAt: 1000000,
      ...overrides,
    });

    it('should save and retrieve an execution', async () => {
      const execution = createExecution();
      await storage.saveExecution(execution);

      const retrieved = await storage.getExecution('run-1');
      expect(retrieved).toEqual(execution);
    });

    it('should return null for non-existent execution', async () => {
      const retrieved = await storage.getExecution('non-existent');
      expect(retrieved).toBeNull();
    });

    it('should update an existing execution', async () => {
      const execution = createExecution();
      await storage.saveExecution(execution);

      const updated = { ...execution, status: 'completed' as const, completedAt: 2000000 };
      await storage.saveExecution(updated);

      const retrieved = await storage.getExecution('run-1');
      expect(retrieved?.status).toBe('completed');
      expect(retrieved?.completedAt).toBe(2000000);
    });

    it('should get executions by status', async () => {
      await storage.saveExecution(createExecution({ runId: 'run-1', status: 'running' }));
      await storage.saveExecution(createExecution({ runId: 'run-2', status: 'running' }));
      await storage.saveExecution(createExecution({ runId: 'run-3', status: 'completed' }));

      const running = await storage.getExecutionsByStatus('running');
      expect(running).toHaveLength(2);
      expect(running.map(e => e.runId).sort()).toEqual(['run-1', 'run-2']);

      const completed = await storage.getExecutionsByStatus('completed');
      expect(completed).toHaveLength(1);
      expect(completed[0]?.runId).toBe('run-3');
    });

    it('should delete an execution', async () => {
      const execution = createExecution();
      await storage.saveExecution(execution);

      await storage.deleteExecution('run-1');

      const retrieved = await storage.getExecution('run-1');
      expect(retrieved).toBeNull();
    });

    it('should preserve uniqueKey field', async () => {
      const execution = createExecution({ uniqueKey: 'unique-key-1' });
      await storage.saveExecution(execution);

      const retrieved = await storage.getExecution('run-1');
      expect(retrieved?.uniqueKey).toBe('unique-key-1');
    });

    it('should preserve error and failedActivityName fields', async () => {
      const execution = createExecution({
        status: 'failed',
        error: 'Something went wrong',
        failedActivityName: 'failingActivity',
      });
      await storage.saveExecution(execution);

      const retrieved = await storage.getExecution('run-1');
      expect(retrieved?.error).toBe('Something went wrong');
      expect(retrieved?.failedActivityName).toBe('failingActivity');
    });

    it('should serialize complex input and state', async () => {
      const execution = createExecution({
        input: { nested: { data: [1, 2, 3] }, nullable: null },
        state: { results: [{ id: 1, value: 'test' }] },
      });
      await storage.saveExecution(execution);

      const retrieved = await storage.getExecution('run-1');
      expect(retrieved?.input).toEqual({ nested: { data: [1, 2, 3] }, nullable: null });
      expect(retrieved?.state).toEqual({ results: [{ id: 1, value: 'test' }] });
    });
  });

  // ============================================================================
  // Uniqueness
  // ============================================================================

  describe('uniqueness', () => {
    const createExecution = (runId: string, uniqueKey?: string): WorkflowExecution => ({
      runId,
      workflowName: 'testWorkflow',
      uniqueKey,
      currentActivityIndex: 0,
      currentActivityName: 'activity1',
      status: 'running',
      input: {},
      state: {},
      createdAt: 1000000,
      updatedAt: 1000000,
    });

    it('should allow setting unique key when no conflict', async () => {
      const result = await storage.setUniqueKey('testWorkflow', 'key-1', 'run-1');
      expect(result).toBe(true);
    });

    it('should return false when unique key conflicts with running execution', async () => {
      const execution = createExecution('run-1', 'key-1');
      await storage.saveExecution(execution);

      const result = await storage.setUniqueKey('testWorkflow', 'key-1', 'run-2');
      expect(result).toBe(false);
    });

    it('should allow reuse of unique key after execution completes', async () => {
      const execution = createExecution('run-1', 'key-1');
      await storage.saveExecution(execution);

      // Complete the execution
      await storage.saveExecution({ ...execution, status: 'completed', completedAt: 2000000 });

      // Should now allow new execution with same key
      const result = await storage.setUniqueKey('testWorkflow', 'key-1', 'run-2');
      expect(result).toBe(true);
    });

    it('should get running execution by unique key', async () => {
      const execution = createExecution('run-1', 'key-1');
      await storage.saveExecution(execution);

      const runId = await storage.getUniqueKey('testWorkflow', 'key-1');
      expect(runId).toBe('run-1');
    });

    it('should return null for non-existent unique key', async () => {
      const runId = await storage.getUniqueKey('testWorkflow', 'non-existent');
      expect(runId).toBeNull();
    });

    it('should return null for unique key of completed execution', async () => {
      const execution = createExecution('run-1', 'key-1');
      await storage.saveExecution(execution);
      await storage.saveExecution({ ...execution, status: 'completed', completedAt: 2000000 });

      const runId = await storage.getUniqueKey('testWorkflow', 'key-1');
      expect(runId).toBeNull();
    });
  });

  // ============================================================================
  // Activity Tasks
  // ============================================================================

  describe('activity tasks', () => {
    // Helper to create an execution (required for foreign key constraint)
    const createParentExecution = async (runId: string): Promise<void> => {
      await storage.saveExecution({
        runId,
        workflowName: 'testWorkflow',
        currentActivityIndex: 0,
        currentActivityName: 'activity1',
        status: 'running',
        input: {},
        state: {},
        createdAt: 1000000,
        updatedAt: 1000000,
      });
    };

    const createTask = (overrides: Partial<ActivityTask> = {}): ActivityTask => ({
      taskId: 'task-1',
      runId: 'run-1',
      activityName: 'activity1',
      status: 'pending',
      priority: 0,
      attempts: 0,
      maxAttempts: 3,
      timeout: 25000,
      input: { data: 'test' },
      createdAt: 1000000,
      ...overrides,
    });

    it('should save and retrieve a task', async () => {
      await createParentExecution('run-1');
      const task = createTask();
      await storage.saveActivityTask(task);

      const retrieved = await storage.getActivityTask('task-1');
      expect(retrieved).toEqual({ ...task, failures: 0 });
    });

    it('should return null for non-existent task', async () => {
      const retrieved = await storage.getActivityTask('non-existent');
      expect(retrieved).toBeNull();
    });

    it('should update an existing task', async () => {
      await createParentExecution('run-1');
      const task = createTask();
      await storage.saveActivityTask(task);

      const updated = { ...task, status: 'active' as const, startedAt: 2000000, attempts: 1 };
      await storage.saveActivityTask(updated);

      const retrieved = await storage.getActivityTask('task-1');
      expect(retrieved?.status).toBe('active');
      expect(retrieved?.startedAt).toBe(2000000);
      expect(retrieved?.attempts).toBe(1);
    });

    it('should get tasks for execution', async () => {
      await createParentExecution('run-1');
      await createParentExecution('run-2');
      await storage.saveActivityTask(createTask({ taskId: 'task-1', runId: 'run-1' }));
      await storage.saveActivityTask(createTask({ taskId: 'task-2', runId: 'run-1' }));
      await storage.saveActivityTask(createTask({ taskId: 'task-3', runId: 'run-2' }));

      const tasksForRun1 = await storage.getActivityTasksForExecution('run-1');
      expect(tasksForRun1).toHaveLength(2);

      const tasksForRun2 = await storage.getActivityTasksForExecution('run-2');
      expect(tasksForRun2).toHaveLength(1);
    });

    it('should get tasks by status', async () => {
      await createParentExecution('run-1');
      await storage.saveActivityTask(createTask({ taskId: 'task-1', status: 'pending' }));
      await storage.saveActivityTask(createTask({ taskId: 'task-2', status: 'pending' }));
      await storage.saveActivityTask(createTask({ taskId: 'task-3', status: 'active' }));

      const pending = await storage.getActivityTasksByStatus('pending');
      expect(pending).toHaveLength(2);

      const active = await storage.getActivityTasksByStatus('active');
      expect(active).toHaveLength(1);
    });

    it('should delete a task', async () => {
      await createParentExecution('run-1');
      const task = createTask();
      await storage.saveActivityTask(task);

      await storage.deleteActivityTask('task-1');

      const retrieved = await storage.getActivityTask('task-1');
      expect(retrieved).toBeNull();
    });

    it('should delete all tasks for execution', async () => {
      await createParentExecution('run-1');
      await createParentExecution('run-2');
      await storage.saveActivityTask(createTask({ taskId: 'task-1', runId: 'run-1' }));
      await storage.saveActivityTask(createTask({ taskId: 'task-2', runId: 'run-1' }));
      await storage.saveActivityTask(createTask({ taskId: 'task-3', runId: 'run-2' }));

      await storage.deleteActivityTasksForExecution('run-1');

      const tasksForRun1 = await storage.getActivityTasksForExecution('run-1');
      expect(tasksForRun1).toHaveLength(0);

      // Other execution's tasks should remain
      const tasksForRun2 = await storage.getActivityTasksForExecution('run-2');
      expect(tasksForRun2).toHaveLength(1);
    });

    it('should preserve result and error fields', async () => {
      await createParentExecution('run-1');
      const task = createTask({
        status: 'completed',
        result: { success: true, count: 42 },
        completedAt: 2000000,
      });
      await storage.saveActivityTask(task);

      const retrieved = await storage.getActivityTask('task-1');
      expect(retrieved?.result).toEqual({ success: true, count: 42 });
    });

    it('should preserve error fields on failed task', async () => {
      await createParentExecution('run-1');
      const task = createTask({
        status: 'failed',
        error: 'Something went wrong',
        errorStack: 'Error: Something went wrong\n    at test',
      });
      await storage.saveActivityTask(task);

      const retrieved = await storage.getActivityTask('task-1');
      expect(retrieved?.error).toBe('Something went wrong');
      expect(retrieved?.errorStack).toContain('Something went wrong');
    });
  });

  // ============================================================================
  // Queue Operations
  // ============================================================================

  describe('queue operations', () => {
    // Helper to create an execution (required for foreign key constraint)
    const createParentExecution = async (runId: string): Promise<void> => {
      await storage.saveExecution({
        runId,
        workflowName: 'testWorkflow',
        currentActivityIndex: 0,
        currentActivityName: 'activity1',
        status: 'running',
        input: {},
        state: {},
        createdAt: 1000000,
        updatedAt: 1000000,
      });
    };

    const createTask = (overrides: Partial<ActivityTask> = {}): ActivityTask => ({
      taskId: 'task-1',
      runId: 'run-1',
      activityName: 'activity1',
      status: 'pending',
      priority: 0,
      attempts: 0,
      maxAttempts: 3,
      timeout: 25000,
      input: {},
      createdAt: 1000000,
      ...overrides,
    });

    describe('getPendingActivityTasks', () => {
      it('should return pending tasks', async () => {
        await createParentExecution('run-1');
        await storage.saveActivityTask(createTask({ taskId: 'task-1', status: 'pending' }));
        await storage.saveActivityTask(createTask({ taskId: 'task-2', status: 'active' }));
        await storage.saveActivityTask(createTask({ taskId: 'task-3', status: 'pending' }));

        const pending = await storage.getPendingActivityTasks({ now: 2000000 });
        expect(pending).toHaveLength(2);
      });

      it('should respect scheduled_for time', async () => {
        await createParentExecution('run-1');
        await storage.saveActivityTask(createTask({ taskId: 'task-1', scheduledFor: 1500000 }));
        await storage.saveActivityTask(createTask({ taskId: 'task-2', scheduledFor: 2500000 }));
        await storage.saveActivityTask(createTask({ taskId: 'task-3' })); // No scheduled_for

        const pending = await storage.getPendingActivityTasks({ now: 2000000 });
        expect(pending).toHaveLength(2);
        expect(pending.map(t => t.taskId).sort()).toEqual(['task-1', 'task-3']);
      });

      it('should order by priority (descending) then createdAt (ascending)', async () => {
        await createParentExecution('run-1');
        await storage.saveActivityTask(createTask({ taskId: 'task-1', priority: 0, createdAt: 1000 }));
        await storage.saveActivityTask(createTask({ taskId: 'task-2', priority: 10, createdAt: 2000 }));
        await storage.saveActivityTask(createTask({ taskId: 'task-3', priority: 0, createdAt: 500 }));

        const pending = await storage.getPendingActivityTasks({ now: 3000000 });
        expect(pending[0]?.taskId).toBe('task-2'); // Highest priority
        expect(pending[1]?.taskId).toBe('task-3'); // Same priority, earlier createdAt
        expect(pending[2]?.taskId).toBe('task-1'); // Same priority, later createdAt
      });

      it('should respect limit option', async () => {
        await createParentExecution('run-1');
        await storage.saveActivityTask(createTask({ taskId: 'task-1' }));
        await storage.saveActivityTask(createTask({ taskId: 'task-2' }));
        await storage.saveActivityTask(createTask({ taskId: 'task-3' }));

        const pending = await storage.getPendingActivityTasks({ now: 2000000, limit: 2 });
        expect(pending).toHaveLength(2);
      });
    });

    describe('claimActivityTask', () => {
      it('should claim a pending task', async () => {
        await createParentExecution('run-1');
        await storage.saveActivityTask(createTask({ taskId: 'task-1' }));

        const claimed = await storage.claimActivityTask('task-1', 2000000);

        expect(claimed).not.toBeNull();
        expect(claimed?.status).toBe('active');
        expect(claimed?.startedAt).toBe(2000000);
        expect(claimed?.attempts).toBe(1);
      });

      it('should return null for non-existent task', async () => {
        const claimed = await storage.claimActivityTask('non-existent', 2000000);
        expect(claimed).toBeNull();
      });

      it('should return null for already claimed task', async () => {
        await createParentExecution('run-1');
        await storage.saveActivityTask(createTask({ taskId: 'task-1', status: 'active' }));

        const claimed = await storage.claimActivityTask('task-1', 2000000);
        expect(claimed).toBeNull();
      });

      it('should return null for task not yet scheduled', async () => {
        await createParentExecution('run-1');
        await storage.saveActivityTask(createTask({ taskId: 'task-1', scheduledFor: 3000000 }));

        const claimed = await storage.claimActivityTask('task-1', 2000000);
        expect(claimed).toBeNull();
      });

      it('should persist the claimed state', async () => {
        await createParentExecution('run-1');
        await storage.saveActivityTask(createTask({ taskId: 'task-1' }));

        await storage.claimActivityTask('task-1', 2000000);

        const retrieved = await storage.getActivityTask('task-1');
        expect(retrieved?.status).toBe('active');
        expect(retrieved?.attempts).toBe(1);
      });

      it('should increment attempts on each claim', async () => {
        await createParentExecution('run-1');
        await storage.saveActivityTask(createTask({ taskId: 'task-1', attempts: 2 }));

        const claimed = await storage.claimActivityTask('task-1', 2000000);
        expect(claimed?.attempts).toBe(3);
      });
    });
  });

  // ============================================================================
  // Dead Letter Queue
  // ============================================================================

  describe('dead letter queue', () => {
    const createDeadLetter = (overrides: Partial<DeadLetterRecord> = {}): DeadLetterRecord => ({
      id: 'dl-1',
      runId: 'run-1',
      taskId: 'task-1',
      activityName: 'failingActivity',
      workflowName: 'testWorkflow',
      input: { test: true },
      error: 'Permanent failure',
      attempts: 3,
      failedAt: 1000000,
      acknowledged: false,
      nonRetryable: false,
      ...overrides,
    });

    it('should save and retrieve a dead letter', async () => {
      const dl = createDeadLetter();
      await storage.saveDeadLetter(dl);

      const deadLetters = await storage.getDeadLetters();
      expect(deadLetters).toHaveLength(1);
      expect(deadLetters[0]).toEqual(dl);
    });

    it('should update an existing dead letter', async () => {
      const dl = createDeadLetter();
      await storage.saveDeadLetter(dl);

      const updated = { ...dl, acknowledged: true };
      await storage.saveDeadLetter(updated);

      const deadLetters = await storage.getDeadLetters();
      expect(deadLetters).toHaveLength(1);
      expect(deadLetters[0]?.acknowledged).toBe(true);
    });

    it('should get all dead letters ordered by failedAt descending', async () => {
      await storage.saveDeadLetter(createDeadLetter({ id: 'dl-1', failedAt: 1000000 }));
      await storage.saveDeadLetter(createDeadLetter({ id: 'dl-2', failedAt: 3000000 }));
      await storage.saveDeadLetter(createDeadLetter({ id: 'dl-3', failedAt: 2000000 }));

      const deadLetters = await storage.getDeadLetters();
      expect(deadLetters.map(d => d.id)).toEqual(['dl-2', 'dl-3', 'dl-1']);
    });

    it('should get only unacknowledged dead letters', async () => {
      await storage.saveDeadLetter(createDeadLetter({ id: 'dl-1', acknowledged: false }));
      await storage.saveDeadLetter(createDeadLetter({ id: 'dl-2', acknowledged: true }));
      await storage.saveDeadLetter(createDeadLetter({ id: 'dl-3', acknowledged: false }));

      const unacked = await storage.getUnacknowledgedDeadLetters();
      expect(unacked).toHaveLength(2);
      expect(unacked.map(d => d.id).sort()).toEqual(['dl-1', 'dl-3']);
    });

    it('should acknowledge a dead letter', async () => {
      await storage.saveDeadLetter(createDeadLetter({ id: 'dl-1' }));

      await storage.acknowledgeDeadLetter('dl-1');

      const deadLetters = await storage.getDeadLetters();
      expect(deadLetters[0]?.acknowledged).toBe(true);
    });

    it('should delete a dead letter', async () => {
      await storage.saveDeadLetter(createDeadLetter({ id: 'dl-1' }));

      await storage.deleteDeadLetter('dl-1');

      const deadLetters = await storage.getDeadLetters();
      expect(deadLetters).toHaveLength(0);
    });

    it('should preserve errorStack field', async () => {
      const dl = createDeadLetter({
        errorStack: 'Error: Test\n    at function1\n    at function2',
      });
      await storage.saveDeadLetter(dl);

      const deadLetters = await storage.getDeadLetters();
      expect(deadLetters[0]?.errorStack).toContain('function1');
    });
  });

  // ============================================================================
  // Purge Operations
  // ============================================================================

  describe('purge operations', () => {
    describe('purgeExecutions', () => {
      const createExecution = (runId: string, status: 'completed' | 'failed', updatedAt: number): WorkflowExecution => ({
        runId,
        workflowName: 'testWorkflow',
        currentActivityIndex: 0,
        currentActivityName: 'activity1',
        status,
        input: {},
        state: {},
        createdAt: 1000000,
        updatedAt,
        completedAt: status === 'completed' ? updatedAt : undefined,
      });

      it('should purge old completed executions', async () => {
        // Old execution
        await storage.saveExecution(createExecution('run-1', 'completed', 1000000));
        // Recent execution
        await storage.saveExecution(createExecution('run-2', 'completed', 9000000));

        const now = 10000000;
        const purged = await storage.purgeExecutions({
          olderThanMs: 5000000, // 5 seconds
          statuses: ['completed'],
          now,
        });

        expect(purged).toBe(1);
        expect(await storage.getExecution('run-1')).toBeNull();
        expect(await storage.getExecution('run-2')).not.toBeNull();
      });

      it('should purge executions with specified statuses only', async () => {
        await storage.saveExecution(createExecution('run-1', 'completed', 1000000));
        await storage.saveExecution(createExecution('run-2', 'failed', 1000000));

        const now = 10000000;
        const purged = await storage.purgeExecutions({
          olderThanMs: 5000000,
          statuses: ['completed'],
          now,
        });

        expect(purged).toBe(1);
        expect(await storage.getExecution('run-1')).toBeNull();
        expect(await storage.getExecution('run-2')).not.toBeNull();
      });

      it('should also delete associated tasks', async () => {
        const execution = createExecution('run-1', 'completed', 1000000);
        await storage.saveExecution(execution);
        await storage.saveActivityTask({
          taskId: 'task-1',
          runId: 'run-1',
          activityName: 'activity1',
          status: 'completed',
          priority: 0,
          attempts: 1,
          maxAttempts: 3,
          timeout: 25000,
          input: {},
          createdAt: 1000000,
        });

        const now = 10000000;
        await storage.purgeExecutions({
          olderThanMs: 5000000,
          statuses: ['completed'],
          now,
        });

        expect(await storage.getActivityTask('task-1')).toBeNull();
      });
    });

    describe('purgeDeadLetters', () => {
      const createDeadLetter = (id: string, failedAt: number, acknowledged: boolean): DeadLetterRecord => ({
        id,
        runId: 'run-1',
        taskId: 'task-1',
        activityName: 'activity1',
        workflowName: 'testWorkflow',
        input: {},
        error: 'Error',
        attempts: 1,
        failedAt,
        acknowledged,
      });

      it('should purge old acknowledged dead letters', async () => {
        await storage.saveDeadLetter(createDeadLetter('dl-1', 1000000, true)); // Old, acked
        await storage.saveDeadLetter(createDeadLetter('dl-2', 1000000, false)); // Old, not acked
        await storage.saveDeadLetter(createDeadLetter('dl-3', 9000000, true)); // Recent, acked

        const now = 10000000;
        const purged = await storage.purgeDeadLetters({
          olderThanMs: 5000000,
          acknowledgedOnly: true,
          now,
        });

        expect(purged).toBe(1);

        const remaining = await storage.getDeadLetters();
        expect(remaining).toHaveLength(2);
        expect(remaining.map(d => d.id).sort()).toEqual(['dl-2', 'dl-3']);
      });

      it('should purge all old dead letters when acknowledgedOnly is false', async () => {
        await storage.saveDeadLetter(createDeadLetter('dl-1', 1000000, true));
        await storage.saveDeadLetter(createDeadLetter('dl-2', 1000000, false));
        await storage.saveDeadLetter(createDeadLetter('dl-3', 9000000, false));

        const now = 10000000;
        const purged = await storage.purgeDeadLetters({
          olderThanMs: 5000000,
          acknowledgedOnly: false,
          now,
        });

        expect(purged).toBe(2);

        const remaining = await storage.getDeadLetters();
        expect(remaining).toHaveLength(1);
        expect(remaining[0]?.id).toBe('dl-3');
      });
    });
  });

  // ============================================================================
  // Subscription
  // ============================================================================

  describe('subscription', () => {
    it('should notify subscribers on execution create', async () => {
      const changes: StorageChange[] = [];
      storage.subscribe(change => changes.push(change));

      await storage.saveExecution({
        runId: 'run-1',
        workflowName: 'test',
        currentActivityIndex: 0,
        currentActivityName: 'activity1',
        status: 'running',
        input: {},
        state: {},
        createdAt: 1000000,
        updatedAt: 1000000,
      });

      expect(changes).toHaveLength(1);
      expect(changes[0]).toEqual({ type: 'execution', operation: 'create', id: 'run-1' });
    });

    it('should notify subscribers on execution update', async () => {
      const execution = {
        runId: 'run-1',
        workflowName: 'test',
        currentActivityIndex: 0,
        currentActivityName: 'activity1',
        status: 'running' as const,
        input: {},
        state: {},
        createdAt: 1000000,
        updatedAt: 1000000,
      };
      await storage.saveExecution(execution);

      const changes: StorageChange[] = [];
      storage.subscribe(change => changes.push(change));

      await storage.saveExecution({ ...execution, status: 'completed' });

      expect(changes).toHaveLength(1);
      expect(changes[0]).toEqual({ type: 'execution', operation: 'update', id: 'run-1' });
    });

    it('should notify subscribers on execution delete', async () => {
      await storage.saveExecution({
        runId: 'run-1',
        workflowName: 'test',
        currentActivityIndex: 0,
        currentActivityName: 'activity1',
        status: 'running',
        input: {},
        state: {},
        createdAt: 1000000,
        updatedAt: 1000000,
      });

      const changes: StorageChange[] = [];
      storage.subscribe(change => changes.push(change));

      await storage.deleteExecution('run-1');

      expect(changes).toHaveLength(1);
      expect(changes[0]).toEqual({ type: 'execution', operation: 'delete', id: 'run-1' });
    });

    it('should notify subscribers on task operations', async () => {
      // Create parent execution first (for foreign key constraint)
      await storage.saveExecution({
        runId: 'run-1',
        workflowName: 'test',
        currentActivityIndex: 0,
        currentActivityName: 'activity1',
        status: 'running',
        input: {},
        state: {},
        createdAt: 1000000,
        updatedAt: 1000000,
      });

      const changes: StorageChange[] = [];
      storage.subscribe(change => changes.push(change));

      const task = {
        taskId: 'task-1',
        runId: 'run-1',
        activityName: 'activity1',
        status: 'pending' as const,
        priority: 0,
        attempts: 0,
        maxAttempts: 3,
        timeout: 25000,
        input: {},
        createdAt: 1000000,
      };

      await storage.saveActivityTask(task);
      expect(changes).toContainEqual({ type: 'task', operation: 'create', id: 'task-1' });

      changes.length = 0;
      await storage.saveActivityTask({ ...task, status: 'active' });
      expect(changes).toContainEqual({ type: 'task', operation: 'update', id: 'task-1' });

      changes.length = 0;
      await storage.deleteActivityTask('task-1');
      expect(changes).toContainEqual({ type: 'task', operation: 'delete', id: 'task-1' });
    });

    it('should notify subscribers on dead letter operations', async () => {
      const changes: StorageChange[] = [];
      storage.subscribe(change => changes.push(change));

      const dl = {
        id: 'dl-1',
        runId: 'run-1',
        taskId: 'task-1',
        activityName: 'activity1',
        workflowName: 'test',
        input: {},
        error: 'Error',
        attempts: 1,
        failedAt: 1000000,
        acknowledged: false,
      };

      await storage.saveDeadLetter(dl);
      expect(changes).toContainEqual({ type: 'deadletter', operation: 'create', id: 'dl-1' });

      changes.length = 0;
      await storage.acknowledgeDeadLetter('dl-1');
      expect(changes).toContainEqual({ type: 'deadletter', operation: 'update', id: 'dl-1' });

      changes.length = 0;
      await storage.deleteDeadLetter('dl-1');
      expect(changes).toContainEqual({ type: 'deadletter', operation: 'delete', id: 'dl-1' });
    });

    it('should allow unsubscribing', async () => {
      const changes: StorageChange[] = [];
      const unsubscribe = storage.subscribe(change => changes.push(change));

      await storage.saveExecution({
        runId: 'run-1',
        workflowName: 'test',
        currentActivityIndex: 0,
        currentActivityName: 'activity1',
        status: 'running',
        input: {},
        state: {},
        createdAt: 1000000,
        updatedAt: 1000000,
      });

      expect(changes).toHaveLength(1);

      unsubscribe();

      await storage.saveExecution({
        runId: 'run-2',
        workflowName: 'test',
        currentActivityIndex: 0,
        currentActivityName: 'activity1',
        status: 'running',
        input: {},
        state: {},
        createdAt: 1000000,
        updatedAt: 1000000,
      });

      expect(changes).toHaveLength(1); // Still 1, no new notification
    });

    it('should handle subscriber errors gracefully', async () => {
      const changes: StorageChange[] = [];

      storage.subscribe(() => {
        throw new Error('Subscriber error');
      });
      storage.subscribe(change => changes.push(change));

      // Should not throw
      await storage.saveExecution({
        runId: 'run-1',
        workflowName: 'test',
        currentActivityIndex: 0,
        currentActivityName: 'activity1',
        status: 'running',
        input: {},
        state: {},
        createdAt: 1000000,
        updatedAt: 1000000,
      });

      expect(changes).toHaveLength(1);
    });
  });
});
