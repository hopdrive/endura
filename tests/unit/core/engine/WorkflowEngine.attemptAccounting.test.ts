/**
 * Attempt accounting tests (review issue C5).
 *
 * `attempts` used to be incremented at claim time and compared against
 * maxAttempts everywhere — so with the old default of maxAttempts: 1, an
 * app kill mid-task (routine on mobile) dead-lettered the task without it
 * ever failing. Claim-count and failure-count are now separate: only real
 * failures (exceptions/timeouts) exhaust retries; crash recovery re-runs
 * the task without burning an attempt.
 */

import { WorkflowEngine } from '../../../../src/core/engine';
import { MockClock, MockScheduler, MockEnvironment } from '../../../../src/core/mocks';
import { defineActivity } from '../../../../src/core/definitions';
import { Workflow } from '../../../../src/core/types';
import { InMemoryStorage } from '../../../../src/storage/memory';

async function createEngine(storage: InMemoryStorage, clock: MockClock): Promise<WorkflowEngine> {
  return WorkflowEngine.create({
    storage,
    clock,
    scheduler: new MockScheduler(clock),
    environment: new MockEnvironment({ isConnected: true, batteryLevel: 1.0 }),
    leaseDurationMs: 60000,
    random: () => 1, // pin jitter to its upper bound for exact timing
  });
}

async function tickUntilSettled(
  engine: WorkflowEngine,
  storage: InMemoryStorage,
  clock: MockClock,
  runId: string,
  maxTicks = 20
) {
  for (let i = 0; i < maxTicks; i++) {
    await engine.tick();
    clock.advance(5000);
    const execution = await storage.getExecution(runId);
    if (execution && execution.status !== 'running') return execution;
  }
  return (await storage.getExecution(runId))!;
}

describe('attempt accounting (C5)', () => {
  it('crash recovery does not burn an attempt, even at maxAttempts 1', async () => {
    const storage = new InMemoryStorage();
    const clock = new MockClock(1000000);

    let executions = 0;
    const workflow: Workflow = {
      name: 'fragile',
      activities: [
        defineActivity({
          name: 'work',
          execute: async () => {
            executions++;
            return { done: true };
          },
          retry: { maximumAttempts: 1 },
        }),
      ],
    };

    // Simulate a claim followed by an app kill: claim directly, then never
    // execute — the task stays 'active' with an expired lease.
    const a = await createEngine(storage, clock);
    a.registerWorkflow(workflow);
    const execution = await a.start(workflow, { input: {} });
    const task = (await storage.getActivityTasksForExecution(execution.runId))[0]!;
    await storage.claimActivityTask(task.taskId, clock.now(), {
      ownerId: 'killed-app',
      leaseDurationMs: 1000,
    });
    clock.advance(2000);

    // Relaunch. The old code dead-lettered here (attempts 1 >= maxAttempts 1).
    const b = await createEngine(storage, clock);
    b.registerWorkflow(workflow);

    const recovered = (await storage.getActivityTasksForExecution(execution.runId))[0]!;
    expect(recovered.status).toBe('pending');
    expect(await storage.getDeadLetters()).toEqual([]);

    const final = await tickUntilSettled(b, storage, clock, execution.runId);
    expect(final.status).toBe('completed');
    expect(executions).toBe(1);
  });

  it('a crash between real failures does not count toward exhaustion', async () => {
    const storage = new InMemoryStorage();
    const clock = new MockClock(1000000);

    let calls = 0;
    const workflow: Workflow = {
      name: 'flaky',
      activities: [
        defineActivity({
          name: 'work',
          execute: async () => {
            calls++;
            if (calls === 1) throw new Error('real failure');
            return { done: true };
          },
          retry: { maximumAttempts: 2 },
        }),
      ],
    };

    const a = await createEngine(storage, clock);
    a.registerWorkflow(workflow);
    const execution = await a.start(workflow, { input: {} });

    // Real failure #1 (failures = 1 of 2).
    await a.tick();
    const task = (await storage.getActivityTasksForExecution(execution.runId))[0]!;
    expect(task.status).toBe('pending');

    // Now a crash: claim and abandon with a short lease.
    clock.advance(5000);
    await storage.claimActivityTask(task.taskId, clock.now(), {
      ownerId: 'killed-app',
      leaseDurationMs: 1000,
    });
    clock.advance(2000);

    // Old code: this relaunch counts the crash as strike #2 of 2 → DLQ.
    // New code: the crash is free; the next real run succeeds.
    const b = await createEngine(storage, clock);
    b.registerWorkflow(workflow);

    const final = await tickUntilSettled(b, storage, clock, execution.runId);
    expect(final.status).toBe('completed');
    expect(await storage.getDeadLetters()).toEqual([]);
    expect(calls).toBe(2);
  });

  it('real failures still exhaust retries and dead-letter', async () => {
    const storage = new InMemoryStorage();
    const clock = new MockClock(1000000);

    let calls = 0;
    const workflow: Workflow = {
      name: 'doomed',
      activities: [
        defineActivity({
          name: 'work',
          execute: async () => {
            calls++;
            throw new Error(`failure ${calls}`);
          },
          retry: { maximumAttempts: 2 },
        }),
      ],
    };

    const engine = await createEngine(storage, clock);
    engine.registerWorkflow(workflow);
    const execution = await engine.start(workflow, { input: {} });

    const final = await tickUntilSettled(engine, storage, clock, execution.runId);

    expect(calls).toBe(2);
    expect(final.status).toBe('failed');
    const deadLetters = await storage.getDeadLetters();
    expect(deadLetters).toHaveLength(1);
  });

  it('defaults maxAttempts to 3, not 1', async () => {
    const storage = new InMemoryStorage();
    const clock = new MockClock(1000000);

    const workflow: Workflow = {
      name: 'defaults',
      activities: [
        defineActivity({
          name: 'work',
          execute: async () => ({ done: true }),
        }),
      ],
    };

    const engine = await createEngine(storage, clock);
    engine.registerWorkflow(workflow);
    const execution = await engine.start(workflow, { input: {} });

    const task = (await storage.getActivityTasksForExecution(execution.runId))[0]!;
    // A durable-execution engine must not default to at-most-once.
    expect(task.maxAttempts).toBe(3);
  });
});
