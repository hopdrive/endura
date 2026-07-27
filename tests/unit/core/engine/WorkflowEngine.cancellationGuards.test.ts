/**
 * Unit Test: WorkflowEngine - Cancellation guards / sticky terminal states (H3)
 *
 * cancelExecution marks the execution cancelled and deletes its tasks —
 * but an activity already in flight still settles afterwards, and its
 * completion/failure handlers used to write back unconditionally:
 * recreating deleted task rows, scheduling retries for a cancelled
 * workflow, advancing (even completing!) it, or flipping cancelled to
 * failed with a dead letter. Terminal states must be sticky: once an
 * execution leaves 'running', late task settlements are discarded.
 *
 * In-flight interleavings are made deterministic with a second engine
 * over the same storage: engine A executes a deferred activity while
 * engine B cancels (B cannot abort A's in-process controller, exactly
 * like a second JS context / background wake).
 */

import { WorkflowEngine } from '../../../../src/core/engine/WorkflowEngine';
import { InMemoryStorage } from '../../../../src/storage/memory';
import { MockClock, MockScheduler, MockEnvironment } from '../../../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../../../src/core/definitions';
import { Workflow } from '../../../../src/core/types';
import { createLoopbackDispatcher } from '../../../../src/workers/loopback';

interface Deferred {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

describe('WorkflowEngine - Cancellation guards (H3)', () => {
  let storage: InMemoryStorage;
  let clock: MockClock;
  let scheduler: MockScheduler;
  let environment: MockEnvironment;
  let deferred: Deferred | null;

  beforeEach(() => {
    storage = new InMemoryStorage();
    clock = new MockClock(1000000);
    scheduler = new MockScheduler(clock);
    environment = new MockEnvironment();
    deferred = null;
  });

  async function createEngine(): Promise<WorkflowEngine> {
    return WorkflowEngine.create({ dispatcher: createLoopbackDispatcher(), storage, clock, scheduler, environment });
  }

  function deferredWorkflow(maxAttempts: number): { workflow: Workflow; executed: string[] } {
    const executed: string[] = [];
    const blocking = defineActivity<Record<string, unknown>, Record<string, unknown>>({
      name: 'blocking',
      execute: (): Promise<Record<string, unknown>> => {
        executed.push('blocking');
        return new Promise<Record<string, unknown>>((resolve, reject) => {
          deferred = { resolve, reject };
        });
      },
      retry: { maximumAttempts: maxAttempts },
    });
    const after = defineActivity<Record<string, unknown>, Record<string, unknown>>({
      name: 'after',
      execute: async (): Promise<Record<string, unknown>> => {
        executed.push('after');
        return { after: true };
      },
    });
    return { workflow: defineWorkflow({ name: 'wf', activities: [blocking, after] }), executed };
  }

  /** Let the started tick reach the point where the activity is in flight. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 20 && !deferred; i++) {
      await Promise.resolve();
    }
    expect(deferred).not.toBeNull();
  }

  it('discards a late SUCCESS after cancellation instead of advancing', async () => {
    const { workflow, executed } = deferredWorkflow(3);
    const engineA = await createEngine();
    const engineB = await createEngine();
    engineB.registerWorkflow(workflow);

    const execution = await engineA.start(workflow, { input: {} });
    const tickPromise = engineA.tick();
    await settle();

    await engineB.cancelExecution(execution.runId);
    expect((await storage.getExecution(execution.runId))?.status).toBe('cancelled');

    // The in-flight activity now resolves successfully on engine A
    deferred!.resolve({ blocked: false });
    await tickPromise;

    // Sticky: still cancelled, not advanced, no task rows resurrected
    const after = await storage.getExecution(execution.runId);
    expect(after?.status).toBe('cancelled');
    expect(await storage.getActivityTasksForExecution(execution.runId)).toHaveLength(0);

    // And nothing runs later
    clock.advance(120000);
    await engineA.tick();
    await engineB.tick();
    expect(executed).toEqual(['blocking']);
    expect((await storage.getExecution(execution.runId))?.status).toBe('cancelled');
  });

  it('does not schedule a retry when a task fails after cancellation', async () => {
    const { workflow, executed } = deferredWorkflow(3);
    const engineA = await createEngine();
    const engineB = await createEngine();
    engineB.registerWorkflow(workflow);

    const execution = await engineA.start(workflow, { input: {} });
    const tickPromise = engineA.tick();
    await settle();

    await engineB.cancelExecution(execution.runId);

    deferred!.reject(new Error('failed after cancel'));
    await tickPromise;

    // No retry task resurrected for the cancelled execution
    expect(await storage.getActivityTasksForExecution(execution.runId)).toHaveLength(0);
    expect((await storage.getExecution(execution.runId))?.status).toBe('cancelled');

    clock.advance(120000);
    await engineA.tick();
    expect(executed).toEqual(['blocking']);
  });

  it('does not flip cancelled to failed or dead-letter on late permanent failure', async () => {
    const { workflow } = deferredWorkflow(1); // budget of 1: failure is permanent
    const engineA = await createEngine();
    const engineB = await createEngine();
    engineB.registerWorkflow(workflow);

    const execution = await engineA.start(workflow, { input: {} });
    const tickPromise = engineA.tick();
    await settle();

    await engineB.cancelExecution(execution.runId);

    deferred!.reject(new Error('permanent failure after cancel'));
    await tickPromise;

    const after = await storage.getExecution(execution.runId);
    expect(after?.status).toBe('cancelled');
    expect(after?.error).toBeUndefined();
    expect(await engineA.getDeadLetters()).toHaveLength(0);
  });

  it('discards the abort-triggered failure when cancelling on the executing engine', async () => {
    const { workflow, executed } = deferredWorkflow(3);
    const engine = await createEngine();

    const execution = await engine.start(workflow, { input: {} });
    const tickPromise = engine.tick();
    await settle();

    // Same-engine cancel aborts the in-flight activity; the resulting
    // rejection must not schedule a retry or resurrect task rows.
    await engine.cancelExecution(execution.runId);
    await tickPromise;

    expect((await storage.getExecution(execution.runId))?.status).toBe('cancelled');
    expect(await storage.getActivityTasksForExecution(execution.runId)).toHaveLength(0);
    expect(await engine.getDeadLetters()).toHaveLength(0);

    clock.advance(120000);
    await engine.tick();
    expect(executed).toEqual(['blocking']);
  });
});
