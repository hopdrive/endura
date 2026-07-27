/**
 * ExpoWorkflowClient must pass observability/guardrail config through
 * to the engine — without logger passthrough the M3 state-size
 * warnings (and everything else the engine logs) are silently dropped
 * on device.
 */

import { describe, it, expect, vi } from 'vitest';
import { ExpoWorkflowClient } from '../../../src/environmental/expo/ExpoWorkflowClient';
import { InMemoryStorage } from '../../../src/storage/memory';
import { defineActivity, defineWorkflow } from '../../../src/core/definitions';
import { createLoopbackDispatcher } from '../../../src/workers/loopback';

describe('ExpoWorkflowClient config passthrough', () => {
  it('forwards logger and stateSizeWarnBytes to the engine', async () => {
    const warn = vi.fn();
    const client = await ExpoWorkflowClient.create({
      storage: new InMemoryStorage(),
      dispatcher: createLoopbackDispatcher(),
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
      stateSizeWarnBytes: 64,
    });

    try {
      const chunky = defineWorkflow({
        name: 'chunky',
        activities: [
          defineActivity({
            name: 'big-output',
            execute: async () => ({ blob: 'x'.repeat(1024) }),
          }),
        ],
      });
      client.registerWorkflow(chunky);

      const execution = await client.engine.start(chunky, { input: {} });
      for (let i = 0; i < 10; i++) {
        await client.tick();
        const current = await client.getExecution(execution.runId);
        if (current && current.status !== 'running') break;
      }

      const final = await client.getExecution(execution.runId);
      expect(final?.status).toBe('completed');
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/large activity result/i),
        expect.objectContaining({ activityName: 'big-output', thresholdBytes: 64 })
      );
    } finally {
      await client.close();
    }
  });
});
