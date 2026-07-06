/**
 * Unit Test: WorkflowEngine - NonRetryableError classification (M1)
 *
 * The driver app's failure taxonomy distinguishes transient failures
 * (retry with backoff) from permanent server refusals
 * (RowFilterRejectedError -> permanently_failed, no retries). Endura
 * expresses the latter with NonRetryableError: throwing it (or any error
 * carrying `nonRetryable: true`) skips the remaining retry budget and
 * dead-letters immediately, with the dead letter flagged nonRetryable.
 *
 * Key scenarios tested:
 * - NonRetryableError dead-letters on the first attempt despite budget
 * - Works mid-budget (transient failures first, then a permanent refusal)
 * - Duck-typed errors (nonRetryable: true property) classify the same
 * - Ordinary errors still retry (control)
 * - Dead letters from exhausted budgets are flagged retryable
 */

import { WorkflowEngine } from '../../../../src/core/engine/WorkflowEngine';
import { InMemoryStorage } from '../../../../src/storage/memory';
import { MockClock, MockScheduler, MockEnvironment } from '../../../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../../../src/core/definitions';
import { NonRetryableError } from '../../../../src/core/types';

describe('WorkflowEngine - NonRetryableError (M1)', () => {
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

  it('should dead-letter immediately on NonRetryableError despite remaining budget', async () => {
    const engine = await createEngine();
    let executeCount = 0;

    const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
      name: 'rejectedActivity',
      execute: async (): Promise<{ done: boolean }> => {
        executeCount++;
        throw new NonRetryableError('Server refused: row filter rejected');
      },
      retry: { maximumAttempts: 5 },
    });

    const workflow = defineWorkflow({
      name: 'testWorkflow',
      activities: [activity],
    });

    const execution = await engine.start(workflow, { input: {} });
    await engine.tick();

    // No retries burned: one execution, straight to the DLQ
    expect(executeCount).toBe(1);

    const deadLetters = await engine.getDeadLetters();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]).toMatchObject({
      activityName: 'rejectedActivity',
      error: 'Server refused: row filter rejected',
      nonRetryable: true,
    });

    expect((await storage.getExecution(execution.runId))?.status).toBe('failed');

    // Advancing the clock must not resurrect it
    clock.advance(60000);
    await engine.tick();
    expect(executeCount).toBe(1);
  });

  it('should classify mid-budget: transient failures retry, then a refusal stops', async () => {
    const engine = await createEngine();
    let executeCount = 0;

    const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
      name: 'mixedActivity',
      execute: async (): Promise<{ done: boolean }> => {
        executeCount++;
        if (executeCount === 1) {
          throw new Error('transient network blip');
        }
        throw new NonRetryableError('permanent refusal');
      },
      retry: { maximumAttempts: 5 },
    });

    const workflow = defineWorkflow({
      name: 'testWorkflow',
      activities: [activity],
    });

    await engine.start(workflow, { input: {} });

    await engine.tick(); // transient -> retry scheduled
    expect(await engine.getDeadLetters()).toHaveLength(0);

    clock.advance(5000);
    await engine.tick(); // refusal -> dead-letter with 3 attempts left

    expect(executeCount).toBe(2);
    const deadLetters = await engine.getDeadLetters();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]?.nonRetryable).toBe(true);
    expect(deadLetters[0]?.error).toBe('permanent refusal');
  });

  it('should honor duck-typed errors carrying nonRetryable: true', async () => {
    const engine = await createEngine();
    let executeCount = 0;

    const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
      name: 'duckTypedActivity',
      execute: async (): Promise<{ done: boolean }> => {
        executeCount++;
        // Simulates an error from another bundle copy of endura (or a
        // consumer-defined error class) that can't be instanceof-matched.
        const error = new Error('foreign permanent failure') as Error & { nonRetryable: boolean };
        error.nonRetryable = true;
        throw error;
      },
      retry: { maximumAttempts: 5 },
    });

    const workflow = defineWorkflow({
      name: 'testWorkflow',
      activities: [activity],
    });

    await engine.start(workflow, { input: {} });
    await engine.tick();

    expect(executeCount).toBe(1);
    const deadLetters = await engine.getDeadLetters();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]?.nonRetryable).toBe(true);
  });

  it('should keep retrying ordinary errors (control)', async () => {
    const engine = await createEngine();
    let executeCount = 0;

    const activity = defineActivity<Record<string, unknown>, { done: boolean }>({
      name: 'transientActivity',
      execute: async (): Promise<{ done: boolean }> => {
        executeCount++;
        throw new Error('transient');
      },
      retry: { maximumAttempts: 3 },
    });

    const workflow = defineWorkflow({
      name: 'testWorkflow',
      activities: [activity],
    });

    await engine.start(workflow, { input: {} });

    await engine.tick();
    clock.advance(5000);
    await engine.tick();
    clock.advance(10000);
    await engine.tick();

    expect(executeCount).toBe(3);
    const deadLetters = await engine.getDeadLetters();
    expect(deadLetters).toHaveLength(1);
    // Exhausted budget, not a refusal — flagged retryable for the
    // recovery screen's Force Retry affordance.
    expect(deadLetters[0]?.nonRetryable).toBe(false);
  });

  it('should expose name and message like a normal Error', () => {
    const error = new NonRetryableError('nope');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('NonRetryableError');
    expect(error.message).toBe('nope');
    expect(error.nonRetryable).toBe(true);
  });
});
