/**
 * M6 remainder — hooks are driven by Storage.subscribe, not polling.
 *
 * The old hooks polled on 500ms–5s intervals with JSON.stringify
 * diffing (battery cost, stale UI). They now subscribe to storage
 * change events, coalesce bursts, and fall back to interval polling
 * only when a storage adapter doesn't implement subscribe.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useExecution, usePendingActivityCount, useDeadLetters } from '../../../src/react';
import { WorkflowEngine } from '../../../src/core/engine';
import { InMemoryStorage } from '../../../src/storage/memory';
import { MockClock, MockScheduler, MockEnvironment } from '../../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../../src/core/definitions';

describe('reactive hooks (M6)', () => {
  let storage: InMemoryStorage;
  let engine: WorkflowEngine;

  const testWorkflow = defineWorkflow({
    name: 'reactive',
    activities: [defineActivity({ name: 'step', execute: async () => ({ done: true }) })],
  });

  beforeEach(async () => {
    storage = new InMemoryStorage();
    const clock = new MockClock(1000000);
    engine = await WorkflowEngine.create({
      storage,
      clock,
      scheduler: new MockScheduler(clock),
      environment: new MockEnvironment({ isConnected: true }),
    });
  });

  afterEach(() => {
    engine.stop();
    vi.restoreAllMocks();
  });

  it('subscribes to storage changes and does not poll', async () => {
    const execution = await engine.start(testWorkflow, { input: {} });
    const subscribeSpy = vi.spyOn(storage, 'subscribe');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    const { unmount } = renderHook(() => useExecution(engine, execution.runId));

    await waitFor(() => {
      expect(subscribeSpy).toHaveBeenCalled();
    });
    // testing-library's waitFor uses setInterval internally; only OUR
    // fallback poller (the hook's refreshInterval) must be absent.
    const hookPolls = setIntervalSpy.mock.calls.filter(([, delay]) => delay === 1000);
    expect(hookPolls).toHaveLength(0);
    unmount();
  });

  it('propagates changes through the subscription', async () => {
    const execution = await engine.start(testWorkflow, { input: {} });
    const { result, unmount } = renderHook(() => useExecution(engine, execution.runId));

    await waitFor(() => {
      expect(result.current?.status).toBe('running');
    });

    await engine.tick();

    await waitFor(() => {
      expect(result.current?.status).toBe('completed');
    });
    unmount();
  });

  it('unsubscribes on unmount', async () => {
    const execution = await engine.start(testWorkflow, { input: {} });
    const unsubscribeSpy = vi.fn();
    const realSubscribe = storage.subscribe.bind(storage);
    vi.spyOn(storage, 'subscribe').mockImplementation(callback => {
      const unsubscribe = realSubscribe(callback);
      return () => {
        unsubscribeSpy();
        unsubscribe();
      };
    });

    const { unmount } = renderHook(() => useExecution(engine, execution.runId));
    await waitFor(() => {
      expect(storage.subscribe).toHaveBeenCalled();
    });

    unmount();
    expect(unsubscribeSpy).toHaveBeenCalled();
  });

  it('coalesces a burst of change events into one refresh', async () => {
    const execution = await engine.start(testWorkflow, { input: {} });
    const getExecutionSpy = vi.spyOn(engine, 'getExecution');

    const { result, unmount } = renderHook(() => useExecution(engine, execution.runId));
    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });

    const callsAfterMount = getExecutionSpy.mock.calls.length;

    // Five synchronous writes → five change events in one burst
    const current = (await storage.getExecution(execution.runId))!;
    for (let i = 0; i < 5; i++) {
      await storage.saveExecution({ ...current, state: { ...current.state, i } });
    }

    await waitFor(() => {
      expect(result.current?.state).toMatchObject({ i: 4 });
    });

    expect(getExecutionSpy.mock.calls.length - callsAfterMount).toBeLessThanOrEqual(2);
    unmount();
  });

  it('ignores changes for other executions and other record types', async () => {
    const execution = await engine.start(testWorkflow, { input: {} });
    const other = await engine.start(testWorkflow, { input: {} });
    const getExecutionSpy = vi.spyOn(engine, 'getExecution');

    const { result, unmount } = renderHook(() => useExecution(engine, execution.runId));
    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });
    const callsAfterMount = getExecutionSpy.mock.calls.length;

    const otherRecord = (await storage.getExecution(other.runId))!;
    await storage.saveExecution({ ...otherRecord, state: { touched: true } });

    // Give any (incorrect) refresh a chance to fire
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(getExecutionSpy.mock.calls.length).toBe(callsAfterMount);
    unmount();
  });

  it('falls back to interval polling when the storage lacks subscribe', async () => {
    const bareStorage = new InMemoryStorage();
    // Simulate a storage adapter without the optional subscribe capability
    Object.defineProperty(bareStorage, 'subscribe', { value: undefined });
    const clock = new MockClock(1000000);
    const bareEngine = await WorkflowEngine.create({
      storage: bareStorage,
      clock,
      scheduler: new MockScheduler(clock),
      environment: new MockEnvironment({ isConnected: true }),
    });
    const execution = await bareEngine.start(testWorkflow, { input: {} });

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const { result, unmount } = renderHook(() => useExecution(bareEngine, execution.runId));

    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });
    expect(setIntervalSpy).toHaveBeenCalled();

    unmount();
    bareEngine.stop();
  });

  it('other hooks subscribe too (dead letters, pending count)', async () => {
    const subscribeSpy = vi.spyOn(storage, 'subscribe');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    const deadLetters = renderHook(() => useDeadLetters(engine, true));
    const pending = renderHook(() => usePendingActivityCount(storage));

    await waitFor(() => {
      expect(subscribeSpy).toHaveBeenCalledTimes(2);
    });
    // No fallback pollers at the hooks' default cadences (1000/5000ms)
    const hookPolls = setIntervalSpy.mock.calls.filter(([, delay]) => delay === 1000 || delay === 5000);
    expect(hookPolls).toHaveLength(0);

    deadLetters.unmount();
    pending.unmount();
  });
});
