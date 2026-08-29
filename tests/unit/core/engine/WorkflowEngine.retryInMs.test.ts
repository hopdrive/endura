/**
 * Unit Test: WorkflowEngine - retryInMs and afterDelay (H6)
 *
 * runWhen conditions can return retryInMs as a recheck hint, but the
 * engine used to ignore it and reschedule every skip at a hardcoded 30s
 * — making offline-hold cadence untunable. And afterDelay() returned
 * {ready: true}, a silent no-op that ran the activity immediately.
 *
 * Key scenarios tested:
 * - Skip reschedule honors the condition's retryInMs
 * - Default 30s cadence is preserved when no hint is given
 * - afterDelay defers execution, counting from task creation
 * - afterDelay's reschedule lands at the remaining delay, not 30s
 */

import { WorkflowEngine } from '../../../../src/core/engine/WorkflowEngine';
import { InMemoryStorage } from '../../../../src/storage/memory';
import { MockClock, MockScheduler, MockEnvironment } from '../../../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../../../src/core/definitions';
import { afterDelay } from '../../../../src/core/conditions';
import { createLoopbackDispatcher } from '../../../../src/workers/loopback';

describe('WorkflowEngine - retryInMs and afterDelay (H6)', () => {
  let storage: InMemoryStorage;
  let clock: MockClock;
  let scheduler: MockScheduler;
  let environment: MockEnvironment;

  beforeEach(() => {
    storage = new InMemoryStorage();
    clock = new MockClock(1000000);
    scheduler = new MockScheduler(clock);
    environment = new MockEnvironment();
  });

  async function createEngine(): Promise<WorkflowEngine> {
    return WorkflowEngine.create({ dispatcher: createLoopbackDispatcher(), storage, clock, scheduler, environment });
  }

  it('honors the condition retryInMs when rescheduling a skipped task', async () => {
    const engine = await createEngine();
    let executeCount = 0;
    let ready = false;

    const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
      name: 'gated',
      execute: async (): Promise<{ done: boolean }> => {
        executeCount++;
        return { done: true };
      },
      runWhen: () => (ready ? { ready: true } : { ready: false, reason: 'gate closed', retryInMs: 5000 }),
    });

    const workflow = defineWorkflow({ name: 'wf', activities: [activity] });
    const execution = await engine.start(workflow, { input: {} });

    await engine.tick();
    expect(executeCount).toBe(0);

    const [task] = await storage.getActivityTasksForExecution(execution.runId);
    expect(task?.status).toBe('pending');
    expect(task?.scheduledFor).toBe(clock.now() + 5000);

    // Not before the hint...
    clock.advance(4999);
    ready = true;
    await engine.tick();
    expect(executeCount).toBe(0);

    // ...but exactly at it
    clock.advance(1);
    await engine.tick();
    expect(executeCount).toBe(1);
  });

  it('keeps the 30s default cadence when the condition gives no hint', async () => {
    const engine = await createEngine();

    const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
      name: 'gated',
      execute: async (): Promise<{ done: boolean }> => ({ done: true }),
      runWhen: () => ({ ready: false, reason: 'gate closed' }),
    });

    const workflow = defineWorkflow({ name: 'wf', activities: [activity] });
    const execution = await engine.start(workflow, { input: {} });
    await engine.tick();

    const [task] = await storage.getActivityTasksForExecution(execution.runId);
    expect(task?.scheduledFor).toBe(clock.now() + 30000);
  });

  it('afterDelay defers execution, counting from task creation', async () => {
    const engine = await createEngine();
    let executeCount = 0;

    const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
      name: 'delayed',
      execute: async (): Promise<{ done: boolean }> => {
        executeCount++;
        return { done: true };
      },
      runWhen: afterDelay(10000),
    });

    const workflow = defineWorkflow({ name: 'wf', activities: [activity] });
    const execution = await engine.start(workflow, { input: {} });

    // Immediately: must NOT run (the old afterDelay ran it right away)
    await engine.tick();
    expect(executeCount).toBe(0);
    expect((await storage.getExecution(execution.runId))?.status).toBe('running');

    // Still inside the window
    clock.advance(6000);
    await engine.tick();
    expect(executeCount).toBe(0);

    // Window elapsed (measured from task creation, not from last check)
    clock.advance(4000);
    await engine.tick();
    expect(executeCount).toBe(1);
    expect((await storage.getExecution(execution.runId))?.status).toBe('completed');
  });

  it('afterDelay reschedules at the remaining delay, not the 30s default', async () => {
    const engine = await createEngine();

    const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
      name: 'delayed',
      execute: async (): Promise<{ done: boolean }> => ({ done: true }),
      runWhen: afterDelay(10000),
    });

    const workflow = defineWorkflow({ name: 'wf', activities: [activity] });
    const execution = await engine.start(workflow, { input: {} });
    const createdAt = clock.now();

    clock.advance(3000);
    await engine.tick();

    const [task] = await storage.getActivityTasksForExecution(execution.runId);
    // Remaining 7s from creation, not now + 30s
    expect(task?.scheduledFor).toBe(createdAt + 10000);
  });
});
