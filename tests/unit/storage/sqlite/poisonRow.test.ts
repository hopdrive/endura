/**
 * Poison-row quarantine tests (review issue H10).
 *
 * Row mappers JSON.parse'd payloads unguarded inside the poll path, so
 * one corrupt/legacy row threw on every getPendingActivityTasks call —
 * with H2's containment that no longer kills the loop, but the whole
 * queue still stalls forever because the poll never returns. A corrupt
 * task row must be quarantined (failed + dead-lettered with a distinct
 * marker) while healthy rows keep flowing; corrupt fields on read-only
 * paths degrade to empty objects instead of throwing.
 */

import { SQLiteStorage } from '../../../../src/storage/sqlite';
import { BetterSqlite3Driver } from '../../../../src/storage/sqlite/internal/BetterSqlite3Driver';

async function createStorage() {
  const driver = await BetterSqlite3Driver.create(':memory:');
  const storage = new SQLiteStorage(driver);
  await storage.initialize();
  return { driver, storage };
}

async function seedExecution(driver: BetterSqlite3Driver, runId: string) {
  await driver.execute(
    `INSERT INTO executions (run_id, workflow_name, current_activity_index, current_activity_name,
      status, input, state, created_at, updated_at)
     VALUES (?, 'wf', 0, 'work', 'running', '{}', '{}', 1000, 1000)`,
    [runId]
  );
}

describe('poison-row quarantine (H10)', () => {
  it('quarantines a corrupt pending task and keeps serving healthy ones', async () => {
    const { driver, storage } = await createStorage();
    await seedExecution(driver, 'run-good');
    await seedExecution(driver, 'run-bad');

    await driver.execute(
      `INSERT INTO activity_tasks (task_id, run_id, activity_name, status, priority, attempts,
        failures, max_attempts, timeout, input, created_at)
       VALUES ('task-good', 'run-good', 'work', 'pending', 0, 0, 0, 3, 25000, '{"ok":true}', 1001)`
    );
    // Hand-corrupted payload (torn write / bad legacy migration)
    await driver.execute(
      `INSERT INTO activity_tasks (task_id, run_id, activity_name, status, priority, attempts,
        failures, max_attempts, timeout, input, created_at)
       VALUES ('task-bad', 'run-bad', 'work', 'pending', 10, 0, 0, 3, 25000, '{not json!', 1000)`
    );

    // The poll must not throw, and must return the healthy task
    const pending = await storage.getPendingActivityTasks({ now: 5000 });
    expect(pending.map(t => t.taskId)).toEqual(['task-good']);

    // The corrupt task is quarantined: failed, out of the queue…
    const rows = await driver.query(`SELECT status FROM activity_tasks WHERE task_id = 'task-bad'`);
    expect(rows[0]?.['status']).toBe('failed');

    // …with a dead letter recording the quarantine
    const deadLetters = await storage.getDeadLetters();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]).toMatchObject({
      taskId: 'task-bad',
      runId: 'run-bad',
      activityName: 'work',
      nonRetryable: true,
    });
    expect(deadLetters[0]?.error).toMatch(/corrupt/i);

    // Subsequent polls stay clean and don't re-quarantine
    const again = await storage.getPendingActivityTasks({ now: 5000 });
    expect(again.map(t => t.taskId)).toEqual(['task-good']);
    expect(await storage.getDeadLetters()).toHaveLength(1);

    await storage.close();
  });

  it('degrades corrupt payloads to empty objects on read paths instead of throwing', async () => {
    const { driver, storage } = await createStorage();

    await driver.execute(
      `INSERT INTO executions (run_id, workflow_name, current_activity_index, current_activity_name,
        status, input, state, created_at, updated_at)
       VALUES ('run-1', 'wf', 0, 'work', 'running', '{broken', '{also broken', 1000, 1000)`
    );

    const execution = await storage.getExecution('run-1');
    expect(execution?.runId).toBe('run-1');
    expect(execution?.input).toEqual({});
    expect(execution?.state).toEqual({});

    await expect(storage.getExecutionsByStatus('running')).resolves.toHaveLength(1);

    await storage.close();
  });
});
