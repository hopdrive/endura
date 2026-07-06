/**
 * M3 — state-size guardrails.
 *
 * execution.state accumulates every activity's output and is rewritten
 * on every advance, so a photo-sized output taxes each subsequent write
 * for the rest of the run. The contract is "small outputs — store
 * references, not blobs"; the engine enforces it with warnings:
 * - every oversized activity result warns, naming the activity
 * - the merged state warns once when it first crosses the threshold
 */

import { describe, it, expect, vi } from 'vitest';
import { WorkflowEngine } from '../../../../src/core/engine';
import { InMemoryStorage } from '../../../../src/storage/memory';
import { MockClock, MockScheduler, MockEnvironment } from '../../../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../../../src/core/definitions';
import { AnyActivity, WorkflowEngineConfig } from '../../../../src/core/types';

async function createEngine(config?: Partial<WorkflowEngineConfig>) {
  const warn = vi.fn();
  const clock = new MockClock(1000000);
  const engine = await WorkflowEngine.create({
    storage: new InMemoryStorage(),
    clock,
    scheduler: new MockScheduler(clock),
    environment: new MockEnvironment({ isConnected: true, batteryLevel: 1 }),
    logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    ...config,
  });
  return { engine, warn };
}

async function runWorkflow(engine: WorkflowEngine, activities: AnyActivity[]) {
  const workflow = defineWorkflow({ name: 'state-size', activities });
  const execution = await engine.start(workflow, { input: {} });
  for (let i = 0; i < 30; i++) {
    await engine.tick();
    const current = await engine.getExecution(execution.runId);
    if (current && current.status !== 'running') return current;
  }
  throw new Error('did not settle');
}

function sizeWarnings(warn: ReturnType<typeof vi.fn>, pattern: RegExp) {
  return warn.mock.calls.filter(([message]) => typeof message === 'string' && pattern.test(message));
}

describe('state-size guardrails (M3)', () => {
  it('warns for each oversized activity result, naming the activity', async () => {
    const { engine, warn } = await createEngine({ stateSizeWarnBytes: 1024 });
    try {
      const blobStep = defineActivity({
        name: 'returns-blob',
        execute: async () => ({ blob: 'x'.repeat(4096) }),
      });
      const final = await runWorkflow(engine, [blobStep]);

      expect(final.status).toBe('completed');
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/result .*exceeds|large activity result/i),
        expect.objectContaining({
          activityName: 'returns-blob',
          thresholdBytes: 1024,
          approxBytes: expect.any(Number),
        })
      );
    } finally {
      engine.stop();
    }
  });

  it('warns once when merged state first crosses the threshold, not on every advance', async () => {
    const { engine, warn } = await createEngine({ stateSizeWarnBytes: 1024 });
    try {
      const big = defineActivity({
        name: 'big',
        execute: async () => ({ blob: 'x'.repeat(4096) }),
      });
      const small1 = defineActivity({ name: 'small1', execute: async () => ({ a: 1 }) });
      const small2 = defineActivity({ name: 'small2', execute: async () => ({ b: 2 }) });

      const final = await runWorkflow(engine, [big, small1, small2]);

      expect(final.status).toBe('completed');
      // State crossed the threshold when 'big' merged; the two later
      // advances rewrite the same oversized state but must not re-warn.
      expect(sizeWarnings(warn, /workflow state/i)).toHaveLength(1);
    } finally {
      engine.stop();
    }
  });

  it('does not warn below the default threshold', async () => {
    const { engine, warn } = await createEngine();
    try {
      const modest = defineActivity({
        name: 'modest',
        execute: async () => ({ note: 'x'.repeat(1000) }),
      });
      const final = await runWorkflow(engine, [modest]);

      expect(final.status).toBe('completed');
      expect(sizeWarnings(warn, /result .*exceeds|large activity result|workflow state/i)).toHaveLength(0);
    } finally {
      engine.stop();
    }
  });
});
