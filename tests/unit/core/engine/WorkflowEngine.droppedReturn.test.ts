/**
 * L4 — non-object handler returns are dropped from workflow state by
 * mergeState. That is the documented contract, but it must not be
 * silent: the engine warns so the author learns their output vanished
 * before it surfaces as a missing state key three steps later.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkflowEngine } from '../../../../src/core/engine';
import { InMemoryStorage } from '../../../../src/storage/memory';
import { MockClock, MockScheduler, MockEnvironment } from '../../../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../../../src/core/definitions';
import { createLoopbackDispatcher } from '../../../../src/workers/loopback';

describe('dropped non-object activity returns (L4)', () => {
  let engine: WorkflowEngine;
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    warn = vi.fn();
    const clock = new MockClock(1000000);
    engine = await WorkflowEngine.create({
      dispatcher: createLoopbackDispatcher(),
      storage: new InMemoryStorage(),
      clock,
      scheduler: new MockScheduler(clock),
      environment: new MockEnvironment({ isConnected: true, batteryLevel: 1 }),
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });
  });

  afterEach(() => {
    engine.stop();
  });

  async function tickUntilSettled(runId: string): Promise<string> {
    for (let i = 0; i < 20; i++) {
      await engine.tick();
      const execution = await engine.getExecution(runId);
      if (execution && execution.status !== 'running') return execution.status;
    }
    throw new Error('did not settle');
  }

  it('warns when a handler returns a primitive and drops it from state', async () => {
    const bad = defineActivity({
      name: 'returns-string',
      execute: async () => 'not-an-object' as unknown as Record<string, unknown>,
    });
    const workflow = defineWorkflow({ name: 'dropped-return', activities: [bad] });

    const execution = await engine.start(workflow, { input: { seed: 1 } });
    const status = await tickUntilSettled(execution.runId);

    expect(status).toBe('completed');
    const final = await engine.getExecution(execution.runId);
    expect(final?.state).toEqual({ seed: 1 });

    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/non-object/i),
      expect.objectContaining({
        runId: execution.runId,
        activityName: 'returns-string',
        resultType: 'string',
      })
    );
  });

  it('does not warn for object or undefined returns', async () => {
    const objectStep = defineActivity({
      name: 'returns-object',
      execute: async () => ({ ok: true }),
    });
    const voidStep = defineActivity({
      name: 'returns-undefined',
      execute: async () => undefined as unknown as Record<string, unknown>,
    });
    const workflow = defineWorkflow({ name: 'clean-returns', activities: [objectStep, voidStep] });

    const execution = await engine.start(workflow, { input: {} });
    const status = await tickUntilSettled(execution.runId);

    expect(status).toBe('completed');
    const droppedWarnings = warn.mock.calls.filter(
      ([message]) => typeof message === 'string' && /non-object/i.test(message)
    );
    expect(droppedWarnings).toHaveLength(0);
  });
});
