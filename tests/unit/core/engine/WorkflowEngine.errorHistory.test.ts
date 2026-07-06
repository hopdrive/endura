/**
 * Unit Test: WorkflowEngine - attempt/error history (M2)
 *
 * RNQ accumulated an errors[] per job; endura only kept the LAST error
 * per task and dropped skip reasons entirely, so Sentry
 * PipelineFailure context and jobs-UI fidelity regressed. Tasks now
 * accumulate a bounded errorHistory of failures and skips.
 *
 * Key scenarios tested:
 * - Failures append entries in order with timestamps and messages
 * - Skip reasons are recorded
 * - History survives permanent failure (visible from the DLQ's task)
 * - History is capped to the most recent entries
 */

import { WorkflowEngine } from '../../../../src/core/engine/WorkflowEngine';
import { InMemoryStorage } from '../../../../src/storage/memory';
import { MockClock, MockScheduler, MockEnvironment } from '../../../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../../../src/core/definitions';

describe('WorkflowEngine - error history (M2)', () => {
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
    return WorkflowEngine.create({ storage, clock, scheduler, environment });
  }

  it('accumulates failure entries in order instead of keeping only the last error', async () => {
    const engine = await createEngine();
    let executeCount = 0;

    const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
      name: 'flaky',
      execute: async (): Promise<{ done: boolean }> => {
        executeCount++;
        if (executeCount <= 2) {
          throw new Error(`boom #${executeCount}`);
        }
        return { done: true };
      },
      retry: { maximumAttempts: 5 },
    });

    const workflow = defineWorkflow({ name: 'wf', activities: [activity] });
    const execution = await engine.start(workflow, { input: {} });

    const t1 = clock.now();
    await engine.tick(); // boom #1
    clock.advance(5000);
    const t2 = clock.now();
    await engine.tick(); // boom #2
    clock.advance(10000);
    await engine.tick(); // success

    const [task] = await storage.getActivityTasksForExecution(execution.runId);
    expect(task?.status).toBe('completed');
    expect(task?.errorHistory).toHaveLength(2);
    expect(task?.errorHistory?.[0]).toMatchObject({ kind: 'failure', message: 'boom #1', at: t1 });
    expect(task?.errorHistory?.[1]).toMatchObject({ kind: 'failure', message: 'boom #2', at: t2 });
  });

  it('records skip reasons', async () => {
    const engine = await createEngine();
    let gateOpen = false;

    const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
      name: 'gated',
      execute: async (): Promise<{ done: boolean }> => ({ done: true }),
      runWhen: () => (gateOpen ? { ready: true } : { ready: false, reason: 'offline: no network' }),
    });

    const workflow = defineWorkflow({ name: 'wf', activities: [activity] });
    const execution = await engine.start(workflow, { input: {} });

    await engine.tick(); // skipped
    clock.advance(30000);
    gateOpen = true;
    await engine.tick(); // runs

    const [task] = await storage.getActivityTasksForExecution(execution.runId);
    expect(task?.status).toBe('completed');
    expect(task?.errorHistory).toHaveLength(1);
    expect(task?.errorHistory?.[0]).toMatchObject({ kind: 'skip', message: 'offline: no network' });
  });

  it('keeps the history on the failed task after permanent failure', async () => {
    const engine = await createEngine();
    let executeCount = 0;

    const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
      name: 'doomed',
      execute: async (): Promise<{ done: boolean }> => {
        executeCount++;
        throw new Error(`fatal #${executeCount}`);
      },
      retry: { maximumAttempts: 2 },
    });

    const workflow = defineWorkflow({ name: 'wf', activities: [activity] });
    const execution = await engine.start(workflow, { input: {} });

    await engine.tick();
    clock.advance(5000);
    await engine.tick();

    const [task] = await storage.getActivityTasksForExecution(execution.runId);
    expect(task?.status).toBe('failed');
    expect(task?.errorHistory?.map(e => e.message)).toEqual(['fatal #1', 'fatal #2']);
  });

  it('caps the history at the most recent entries', async () => {
    const engine = await createEngine();
    let executeCount = 0;

    const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
      name: 'veryFlaky',
      execute: async (): Promise<{ done: boolean }> => {
        executeCount++;
        throw new Error(`e${executeCount}`);
      },
      retry: { maximumAttempts: 30, initialInterval: 1, backoffCoefficient: 1 },
    });

    const workflow = defineWorkflow({ name: 'wf', activities: [activity] });
    const execution = await engine.start(workflow, { input: {} });

    for (let i = 0; i < 30; i++) {
      await engine.tick();
      clock.advance(10);
    }

    const [task] = await storage.getActivityTasksForExecution(execution.runId);
    expect(task?.status).toBe('failed');
    expect(executeCount).toBe(30);
    expect(task?.errorHistory?.length).toBe(20);
    // Oldest entries dropped, latest kept
    expect(task?.errorHistory?.[19]?.message).toBe('e30');
    expect(task?.errorHistory?.[0]?.message).toBe('e11');
  });
});
