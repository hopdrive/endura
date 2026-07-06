/**
 * Unit Test: Expo adapter hygiene (H8)
 *
 * The Expo layer had three lifecycle bugs:
 * - ExpoWorkflowClient.start() was a hand-rolled while(true) with no
 *   stop path (and wall-clock Date.now instead of the injected Clock)
 * - ExpoEnvironment leaked a never-cleared 1Hz setInterval per instance
 *   — one per background wake, forever
 * - runBackgroundWorkflowTask always reported NewData, degrading iOS
 *   background-fetch scheduling, and onComplete always got 0
 *
 * Key scenarios tested:
 * - environment.dispose() stops the refresh interval; close() disposes
 * - client.stop() ends a start() with no lifespan
 * - background run reports NoData when idle, NewData with real counts
 *   when work was processed, Failed on error
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExpoWorkflowClient } from '../../../src/environmental/expo/ExpoWorkflowClient';
import { ExpoEnvironment } from '../../../src/environmental/expo/ExpoEnvironment';
import {
  runBackgroundWorkflowTask,
  BackgroundFetchResult,
  BackgroundTaskResult,
  toBackgroundTaskResult,
} from '../../../src/environmental/expo/background';
import { InMemoryStorage } from '../../../src/storage/memory';
import { defineActivity, defineWorkflow } from '../../../src/core/definitions';
import { Workflow } from '../../../src/core/types';

function quickWorkflow(executed: string[]): Workflow {
  return defineWorkflow({
    name: 'bg',
    activities: [
      defineActivity({
        name: 'one',
        execute: async () => {
          executed.push('one');
          return { one: true };
        },
      }),
      defineActivity({
        name: 'two',
        execute: async () => {
          executed.push('two');
          return { two: true };
        },
      }),
    ],
  });
}

describe('ExpoEnvironment lifecycle (H8)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('dispose() stops the background refresh interval', () => {
    vi.useFakeTimers();
    const getNetworkState = vi.fn(() => true);
    const environment = new ExpoEnvironment({ getNetworkState });

    const initialCalls = getNetworkState.mock.calls.length;
    vi.advanceTimersByTime(3000);
    expect(getNetworkState.mock.calls.length).toBeGreaterThan(initialCalls);

    environment.dispose();
    const callsAtDispose = getNetworkState.mock.calls.length;
    vi.advanceTimersByTime(10000);
    expect(getNetworkState.mock.calls.length).toBe(callsAtDispose);
  });
});

describe('ExpoWorkflowClient lifecycle (H8)', () => {
  it('stop() ends a start() that has no lifespan', async () => {
    const storage = new InMemoryStorage();
    const client = await ExpoWorkflowClient.create({ storage });

    const startPromise = client.start({ tickInterval: 10 });
    await new Promise(resolve => setTimeout(resolve, 50));

    client.stop();
    // Without a stop path this await never resolves (test times out)
    await startPromise;

    await client.close();
  });

  it('close() disposes the environment refresh interval', async () => {
    vi.useFakeTimers();
    const getNetworkState = vi.fn(() => true);
    const storage = new InMemoryStorage();
    const client = await ExpoWorkflowClient.create({
      storage,
      environment: { getNetworkState },
    });

    vi.advanceTimersByTime(2000);
    const callsBefore = getNetworkState.mock.calls.length;
    expect(callsBefore).toBeGreaterThan(0);

    vi.useRealTimers();
    await client.close();

    vi.useFakeTimers();
    vi.advanceTimersByTime(10000);
    expect(getNetworkState.mock.calls.length).toBe(callsBefore);
    vi.useRealTimers();
  });
});

describe('runBackgroundWorkflowTask honest results (H8)', () => {
  it('reports NoData when there was nothing to process', async () => {
    const storage = new InMemoryStorage();
    let completedCount = -1;

    const result = await runBackgroundWorkflowTask({
      storage,
      workflows: [quickWorkflow([])],
      lifespan: 700,
      onComplete: count => {
        completedCount = count;
      },
    });

    expect(result).toBe(BackgroundFetchResult.NoData);
    expect(completedCount).toBe(0);
  });

  it('reports NewData with the real processed count when work ran', async () => {
    const storage = new InMemoryStorage();
    const executed: string[] = [];
    const workflow = quickWorkflow(executed);

    // Seed work: a foreground client enqueues, then "the app dies"
    const seeder = await ExpoWorkflowClient.create({ storage });
    const execution = await seeder.start_workflow(workflow, { input: {} });

    let completedCount = -1;
    const result = await runBackgroundWorkflowTask({
      storage,
      workflows: [workflow],
      lifespan: 1500,
      onComplete: count => {
        completedCount = count;
      },
    });

    expect(result).toBe(BackgroundFetchResult.NewData);
    expect(executed).toEqual(['one', 'two']);
    expect(completedCount).toBeGreaterThan(0);
    expect((await storage.getExecution(execution.runId))?.status).toBe('completed');
  });

  it('reports Failed when the engine cannot even start', async () => {
    const storage = new InMemoryStorage();
    // Catastrophic storage failure at startup recovery — engine creation
    // rejects. (Transient errors DURING the run are contained by design
    // per H2 and do not fail the fetch.)
    storage.getActivityTasksByStatus = () => {
      throw new Error('storage exploded');
    };

    let seenError: Error | null = null;
    const result = await runBackgroundWorkflowTask({
      storage,
      workflows: [quickWorkflow([])],
      lifespan: 400,
      onError: error => {
        seenError = error;
      },
    });

    expect(result).toBe(BackgroundFetchResult.Failed);
    expect(seenError).not.toBeNull();
  });

  it('maps fetch results onto expo-background-task results', () => {
    expect(toBackgroundTaskResult(BackgroundFetchResult.NewData)).toBe(BackgroundTaskResult.Success);
    expect(toBackgroundTaskResult(BackgroundFetchResult.NoData)).toBe(BackgroundTaskResult.Success);
    expect(toBackgroundTaskResult(BackgroundFetchResult.Failed)).toBe(BackgroundTaskResult.Failed);
  });
});
