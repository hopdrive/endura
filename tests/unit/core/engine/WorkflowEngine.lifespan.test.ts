/**
 * Unit Test: WorkflowEngine - run() lifespan
 *
 * A background wake gets a fixed OS window, so run({ lifespan }) must stop
 * claiming work once the deadline (less the 500ms safety buffer) has passed.
 *
 * Key scenarios tested:
 * - The deadline is checked before each task inside a tick, not only
 *   between ticks, so one tick of ten tasks cannot overrun the window
 * - A tick() called directly, outside run(), has no deadline
 * - lifespan 0 or negative means the window is already spent: no task runs
 *   and run() returns
 * - No lifespan still means no deadline
 */

import { WorkflowEngine } from '../../../../src/core/engine/WorkflowEngine';
import { InMemoryStorage } from '../../../../src/storage/memory';
import { MockClock, MockScheduler, MockEnvironment } from '../../../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../../../src/core/definitions';

const TASK_MS = 5000;

async function settle(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('WorkflowEngine - run() lifespan', () => {
  let clock: MockClock;
  let scheduler: MockScheduler;
  let engine: WorkflowEngine;
  let runs: number;

  beforeEach(async () => {
    clock = new MockClock(1000000);
    scheduler = new MockScheduler(clock);
    runs = 0;
    engine = await WorkflowEngine.create({
      storage: new InMemoryStorage(),
      clock,
      scheduler,
      environment: new MockEnvironment(),
    });
  });

  // Each task takes TASK_MS of (mock) wall time.
  const slowWorkflow = defineWorkflow({
    name: 'slow',
    activities: [
      defineActivity({
        name: 'slowActivity',
        execute: async () => {
          runs++;
          clock.advance(TASK_MS);
          return {};
        },
      }),
    ],
  });

  async function queue(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await engine.start(slowWorkflow, { input: {} });
    }
  }

  /**
   * Runs the loop and reports whether it ended by itself. An engine that
   * ignores its lifespan idles forever on the mock scheduler, so the test
   * stops it to finish either way.
   */
  async function runAndStop(lifespan?: number): Promise<boolean> {
    let ended = false;
    const loop = engine.run({ lifespan }).then(() => {
      ended = true;
    });
    await settle();
    const endedByItself = ended;
    engine.stop();
    scheduler.runAll();
    await loop;
    return endedByItself;
  }

  it('stops between tasks inside a tick once the deadline has passed', async () => {
    await queue(5);

    // Deadline is 12000 - 500 = 11500ms in. Tasks start at 0, 5000 and
    // 10000; the fourth would start at 15000, past it.
    const endedByItself = await runAndStop(12000);

    expect(runs).toBe(3);
    expect(endedByItself).toBe(true);
  });

  it('leaves the tasks it did not reach pending for the next wake', async () => {
    await queue(5);
    await runAndStop(12000);

    await engine.tick();

    expect(runs).toBe(5);
  });

  it('applies no deadline to a tick() called outside run()', async () => {
    await queue(5);
    await runAndStop(12000);
    await queue(5);

    await engine.tick();

    expect(runs).toBe(10);
  });

  it.each([0, -1000])('runs no task when the lifespan is %i', async (lifespan) => {
    await queue(3);

    const endedByItself = await runAndStop(lifespan);

    expect(runs).toBe(0);
    expect(endedByItself).toBe(true);
  });

  it('keeps running without a deadline when no lifespan is given', async () => {
    await queue(5);

    const endedByItself = await runAndStop();

    expect(runs).toBe(5);
    expect(endedByItself).toBe(false);
  });
});
