/**
 * Unit Test: WorkflowEngine - Dead Letter Redrive (H5)
 *
 * Tests retryFromDeadLetter(): the API behind the driver app's
 * "Force Retry" recovery-screen contract. A redrive atomically:
 * - resets the failed task back to pending with a fresh retry budget
 * - re-opens the failed execution to running at the same activity cursor
 * - re-reserves the uniqueKey (failing if another running execution holds it)
 * - removes the dead letter record
 *
 * Key scenarios tested:
 * - Full recovery: fail permanently -> redrive -> tick -> completes
 * - Retry budget resets (a redriven task gets maxAttempts again)
 * - Mid-workflow redrive preserves accumulated state and finishes remaining steps
 * - Unknown dead letter id throws
 * - uniqueKey conflict with a live execution aborts the redrive (DLQ intact)
 * - deadletter:redriven event emitted
 */

import { WorkflowEngine } from '../../../../src/core/engine/WorkflowEngine';
import { InMemoryStorage } from '../../../../src/storage/memory';
import { MockClock, MockScheduler, MockEnvironment } from '../../../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../../../src/core/definitions';
import { createLoopbackDispatcher } from '../../../../src/workers/loopback';

describe('WorkflowEngine - Dead Letter Redrive', () => {
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

  async function createEngine(onEvent?: (event: { type: string; [key: string]: unknown }) => void): Promise<WorkflowEngine> {
    return WorkflowEngine.create({
      dispatcher: createLoopbackDispatcher(),
      storage,
      clock,
      scheduler,
      environment,
      onEvent,
    });
  }

  it('should redrive a dead-lettered task back to pending and re-open the execution', async () => {
    const engine = await createEngine();
    let shouldFail = true;

    const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
      name: 'flakyActivity',
      execute: async (): Promise<{ done: boolean }> => {
        if (shouldFail) {
          throw new Error('Transient outage');
        }
        return { done: true };
      },
      retry: { maximumAttempts: 1 },
    });

    const workflow = defineWorkflow({
      name: 'testWorkflow',
      activities: [activity],
    });

    const execution = await engine.start(workflow, { input: {} });
    await engine.tick();

    // Sanity: permanently failed and dead-lettered
    expect((await storage.getExecution(execution.runId))?.status).toBe('failed');
    const deadLetters = await engine.getDeadLetters();
    expect(deadLetters).toHaveLength(1);

    // Redrive
    shouldFail = false;
    const revived = await engine.retryFromDeadLetter(deadLetters[0]!.id);

    expect(revived.runId).toBe(execution.runId);
    expect(revived.status).toBe('running');
    expect(revived.error).toBeUndefined();
    expect(revived.failedActivityName).toBeUndefined();
    expect(revived.completedAt).toBeUndefined();

    // Dead letter removed
    expect(await engine.getDeadLetters()).toHaveLength(0);

    // Task back to pending with cleared failure bookkeeping
    const tasks = await storage.getActivityTasksForExecution(execution.runId);
    const task = tasks.find(t => t.taskId === deadLetters[0]!.taskId);
    expect(task?.status).toBe('pending');
    expect(task?.failures ?? 0).toBe(0);
    expect(task?.error).toBeUndefined();
    expect(task?.completedAt).toBeUndefined();
    expect(task?.ownerId).toBeUndefined();

    // Next tick completes the workflow
    await engine.tick();
    expect((await storage.getExecution(execution.runId))?.status).toBe('completed');
  });

  it('should give a redriven task a fresh retry budget', async () => {
    const engine = await createEngine();
    let executeCount = 0;

    const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
      name: 'alwaysFailing',
      execute: async (): Promise<{ done: boolean }> => {
        executeCount++;
        throw new Error(`Failure #${executeCount}`);
      },
      retry: { maximumAttempts: 2 },
    });

    const workflow = defineWorkflow({
      name: 'testWorkflow',
      activities: [activity],
    });

    await engine.start(workflow, { input: {} });

    // Exhaust the original budget: 2 real failures
    await engine.tick();
    clock.advance(5000);
    await engine.tick();
    expect(executeCount).toBe(2);
    expect(await engine.getDeadLetters()).toHaveLength(1);

    // Redrive and exhaust again — proves failures was reset, not resumed at max
    const dl = (await engine.getDeadLetters())[0]!;
    await engine.retryFromDeadLetter(dl.id);

    await engine.tick();
    clock.advance(5000);
    await engine.tick();

    expect(executeCount).toBe(4);
    const deadLetters = await engine.getDeadLetters();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]?.error).toBe('Failure #4');
  });

  it('should redrive a mid-workflow failure and finish the remaining activities', async () => {
    const engine = await createEngine();
    let step2Fails = true;
    const executed: string[] = [];

    const step1 = defineActivity<Record<string, unknown>, { one: boolean }>({
      name: 'step1',
      execute: async (): Promise<{ one: boolean }> => {
        executed.push('step1');
        return { one: true };
      },
    });
    const step2 = defineActivity<Record<string, unknown>, { two: boolean }>({
      name: 'step2',
      execute: async (): Promise<{ two: boolean }> => {
        if (step2Fails) {
          throw new Error('step2 down');
        }
        executed.push('step2');
        return { two: true };
      },
      retry: { maximumAttempts: 1 },
    });
    const step3 = defineActivity<Record<string, unknown>, { three: boolean }>({
      name: 'step3',
      execute: async (): Promise<{ three: boolean }> => {
        executed.push('step3');
        return { three: true };
      },
    });

    const workflow = defineWorkflow({
      name: 'threeStep',
      activities: [step1, step2, step3],
    });

    const execution = await engine.start(workflow, { input: {} });
    await engine.tick(); // step1 ok
    await engine.tick(); // step2 permanent failure

    expect((await storage.getExecution(execution.runId))?.status).toBe('failed');
    const dl = (await engine.getDeadLetters())[0]!;
    expect(dl.activityName).toBe('step2');

    step2Fails = false;
    await engine.retryFromDeadLetter(dl.id);

    await engine.tick(); // step2 ok
    await engine.tick(); // step3 ok

    const final = await storage.getExecution(execution.runId);
    expect(final?.status).toBe('completed');
    // step1 did NOT re-run; its output survived the failure/redrive round trip
    expect(executed).toEqual(['step1', 'step2', 'step3']);
    expect(final?.state).toMatchObject({ one: true, two: true, three: true });
  });

  it('should throw for an unknown dead letter id', async () => {
    const engine = await createEngine();

    await expect(engine.retryFromDeadLetter('nope')).rejects.toThrow(/not found/i);
  });

  it('should abort the redrive when another running execution holds the uniqueKey', async () => {
    const engine = await createEngine();
    let firstRun = true;

    const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
      name: 'keyedActivity',
      execute: async (): Promise<{ done: boolean }> => {
        if (firstRun) {
          firstRun = false;
          throw new Error('first run fails');
        }
        return { done: true };
      },
      retry: { maximumAttempts: 1 },
    });

    const workflow = defineWorkflow({
      name: 'keyedWorkflow',
      activities: [activity],
    });

    // First execution with key K fails permanently (releases the key)
    await engine.start(workflow, { input: { n: 1 }, uniqueKey: 'K' });
    await engine.tick();
    const dl = (await engine.getDeadLetters())[0]!;

    // Second execution reserves K and stays running (not ticked)
    const second = await engine.start(workflow, { input: { n: 2 }, uniqueKey: 'K' });
    expect((await storage.getExecution(second.runId))?.status).toBe('running');

    // Redrive of the first must refuse — K is held by a live execution
    await expect(engine.retryFromDeadLetter(dl.id)).rejects.toThrow(/unique/i);

    // Nothing was mutated: DLQ intact, first execution still failed
    expect(await engine.getDeadLetters()).toHaveLength(1);
    expect((await storage.getExecution(dl.runId))?.status).toBe('failed');
  });

  it('should emit a deadletter:redriven event', async () => {
    const events: Array<{ type: string; runId?: unknown; taskId?: unknown }> = [];
    const engine = await createEngine(event => {
      if (event.type === 'deadletter:redriven') {
        events.push(event as { type: string; runId?: unknown; taskId?: unknown });
      }
    });

    const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
      name: 'failingActivity',
      execute: async (): Promise<{ done: boolean }> => {
        throw new Error('Failure');
      },
      retry: { maximumAttempts: 1 },
    });

    const workflow = defineWorkflow({
      name: 'testWorkflow',
      activities: [activity],
    });

    const execution = await engine.start(workflow, { input: {} });
    await engine.tick();

    const dl = (await engine.getDeadLetters())[0]!;
    await engine.retryFromDeadLetter(dl.id);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'deadletter:redriven',
      runId: execution.runId,
      taskId: dl.taskId,
    });
  });
});
