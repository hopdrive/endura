/**
 * Unit tests for the worker execution boundary itself: the message
 * protocol, the dispatcher, and the activity host. The rest of the
 * suite exercises this machinery implicitly (every engine test runs
 * through a loopback dispatcher); these tests pin the boundary-specific
 * contracts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowEngine } from '../../../src/core/engine/WorkflowEngine';
import { InMemoryStorage } from '../../../src/storage/memory';
import { MockClock, MockScheduler, MockEnvironment } from '../../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../../src/core/definitions';
import { Logger, NonRetryableError, isNonRetryableError } from '../../../src/core/types';
import {
  serializeActivityError,
  deserializeActivityError,
} from '../../../src/workers/protocol';
import { WorkerDispatcher, WorkerCrashedError } from '../../../src/workers/WorkerDispatcher';
import { createActivityHost } from '../../../src/workers/host';
import { createLoopbackChannel, createLoopbackDispatcher } from '../../../src/workers/loopback';
import { sleep } from '../../utils/testHelpers';

describe('error marshaling', () => {
  it('round-trips name, message, and stack', () => {
    const original = new Error('disk full');
    original.name = 'StorageError';

    const revived = deserializeActivityError(serializeActivityError(original));

    expect(revived).toBeInstanceOf(Error);
    expect(revived.name).toBe('StorageError');
    expect(revived.message).toBe('disk full');
    expect(revived.stack).toBe(original.stack);
  });

  it('preserves nonRetryable across the boundary', () => {
    const revived = deserializeActivityError(
      serializeActivityError(new NonRetryableError('validation rejected'))
    );

    expect(isNonRetryableError(revived)).toBe(true);
  });

  it('flattens non-Error throws', () => {
    const revived = deserializeActivityError(serializeActivityError('just a string'));

    expect(revived.message).toBe('just a string');
    expect(isNonRetryableError(revived)).toBe(false);
  });
});

describe('WorkerDispatcher', () => {
  it('rejects every in-flight attempt when the worker errors', async () => {
    const channel = createLoopbackChannel();
    // No host on the other end — attempts stay in flight.
    const dispatcher = new WorkerDispatcher(channel.worker);
    // Skip the ready gate so the run is actually in flight.
    channel.worker.onmessage?.({ data: { endura: 'ready', activityNames: [] } });

    const request = {
      taskId: 't1',
      runId: 'r1',
      activityName: 'anything',
      attempt: 1,
      input: {},
      runtime: { isConnected: true },
    };
    const pending = dispatcher.execute(request, new AbortController().signal);
    const outcome = pending.catch((err: Error) => err);

    channel.worker.onerror?.({ message: 'worker exploded' });

    const err = await outcome;
    expect(err).toBeInstanceOf(WorkerCrashedError);
    expect(String(err)).toContain('worker exploded');
    // Retryable by design: the engine puts the task back through the
    // normal retry budget.
    expect(isNonRetryableError(err)).toBe(false);
  });

  it('buffers runs sent before the host announces ready', async () => {
    const channel = createLoopbackChannel();
    const dispatcher = new WorkerDispatcher(channel.worker);

    const echo = defineActivity({
      name: 'echo',
      execute: async ctx => ({ echoed: ctx.input['value'] }),
    });

    const pending = dispatcher.execute(
      {
        taskId: 't1',
        runId: 'r1',
        activityName: 'echo',
        attempt: 1,
        input: { value: 42 },
        runtime: { isConnected: true },
      },
      new AbortController().signal
    );

    // Host comes up late — its 'ready' must flush the buffered run.
    createActivityHost({ activities: [echo], scope: channel.scope });

    await expect(pending).resolves.toEqual({ echoed: 42 });
  });
});

describe('engine + worker boundary', () => {
  let storage: InMemoryStorage;
  let clock: MockClock;
  let scheduler: MockScheduler;
  let environment: MockEnvironment;
  let logLines: Array<{ msg: string; meta?: Record<string, unknown> }>;
  let logger: Logger;

  beforeEach(() => {
    storage = new InMemoryStorage();
    clock = new MockClock(1000000);
    scheduler = new MockScheduler(clock);
    environment = new MockEnvironment();
    logLines = [];
    const capture = (msg: string, meta?: Record<string, unknown>) => logLines.push({ msg, meta });
    logger = { debug: capture, info: capture, warn: capture, error: capture };
  });

  async function tickUntilSettled(engine: WorkflowEngine, runId: string): Promise<string> {
    for (let i = 0; i < 50; i++) {
      await engine.tick();
      scheduler.advanceAndTick(1000);
      const current = await storage.getExecution(runId);
      if (current && current.status !== 'running') return current.status;
    }
    throw new Error('never settled');
  }

  it('dead-letters immediately when the worker bundle is missing the activity', async () => {
    const channel = createLoopbackChannel();
    // Host registered with NOTHING — simulates a worker entry file that
    // forgot this workflow while the main bundle registers it.
    createActivityHost({ scope: channel.scope });
    const dispatcher = new WorkerDispatcher(channel.worker);

    const engine = await WorkflowEngine.create({
      dispatcher,
      storage,
      clock,
      scheduler,
      environment,
      logger,
    });
    const workflow = defineWorkflow({
      name: 'missing',
      activities: [
        defineActivity({
          name: 'notInBundle',
          retry: { maximumAttempts: 5 },
          execute: async () => ({}),
        }),
      ],
    });
    engine.registerWorkflow(workflow);
    const execution = await engine.start(workflow, { input: {} });

    expect(await tickUntilSettled(engine, execution.runId)).toBe('failed');

    // Non-retryable: one attempt, straight to the dead letter queue.
    const deadLetters = await storage.getDeadLetters();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]?.nonRetryable).toBe(true);
    expect(deadLetters[0]?.error).toContain('notInBundle');
    expect(deadLetters[0]?.error).toContain('createActivityHost');
  });

  it('relays ctx.log from the worker into the engine logger', async () => {
    const engine = await WorkflowEngine.create({
      dispatcher: createLoopbackDispatcher(),
      storage,
      clock,
      scheduler,
      environment,
      logger,
    });
    const workflow = defineWorkflow({
      name: 'chatty',
      activities: [
        defineActivity({
          name: 'talks',
          execute: async ctx => {
            ctx.log('uploading', { step: 1 });
            return {};
          },
        }),
      ],
    });
    engine.registerWorkflow(workflow);
    const execution = await engine.start(workflow, { input: {} });

    expect(await tickUntilSettled(engine, execution.runId)).toBe('completed');
    // Give the relayed log message its microtask hop.
    await sleep(5);

    const relayed = logLines.find(line => line.msg.includes('[Activity:talks]'));
    expect(relayed).toBeDefined();
    expect(relayed?.meta?.['args']).toEqual(['uploading', { step: 1 }]);
  });

  it('gives the worker a clone — mutating ctx.input cannot corrupt engine state', async () => {
    const engine = await WorkflowEngine.create({
      dispatcher: createLoopbackDispatcher(),
      storage,
      clock,
      scheduler,
      environment,
    });
    const workflow = defineWorkflow({
      name: 'mutator',
      activities: [
        defineActivity({
          name: 'mutates',
          execute: async ctx => {
            // Hostile activity scribbling on its input in the worker.
            (ctx.input as Record<string, unknown>)['original'] = 'CLOBBERED';
            return { added: true };
          },
        }),
      ],
    });
    engine.registerWorkflow(workflow);
    const execution = await engine.start(workflow, { input: { original: 'pristine' } });

    expect(await tickUntilSettled(engine, execution.runId)).toBe('completed');

    const final = await storage.getExecution(execution.runId);
    // The clobber stayed on the worker's copy; only the returned result
    // merged into state.
    expect(final?.state['original']).toBe('pristine');
    expect(final?.state['added']).toBe(true);
  });

  it('fails the attempt with a clear error when the result cannot cross the boundary', async () => {
    const engine = await WorkflowEngine.create({
      dispatcher: createLoopbackDispatcher(),
      storage,
      clock,
      scheduler,
      environment,
    });
    const workflow = defineWorkflow({
      name: 'untransferable',
      activities: [
        defineActivity({
          name: 'returnsFunction',
          retry: { maximumAttempts: 1 },
          execute: async () => ({ callback: () => 'nope' }) as unknown as Record<string, unknown>,
        }),
      ],
    });
    engine.registerWorkflow(workflow);
    const execution = await engine.start(workflow, { input: {} });

    expect(await tickUntilSettled(engine, execution.runId)).toBe('failed');

    const deadLetters = await storage.getDeadLetters();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]?.error).toContain('cannot cross the thread boundary');
  });
});
