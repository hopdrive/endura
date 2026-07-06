/**
 * RealClock / RealScheduler / StubEnvironment — the runtime defaults
 * for Node/web consumers (M5 moved them out of the mocks module).
 */

import { describe, it, expect, vi } from 'vitest';
import { RealClock, RealScheduler, StubEnvironment } from '../../../src/core/defaults';

describe('runtime defaults', () => {
  it('RealClock tracks system time', () => {
    const before = Date.now();
    const reading = new RealClock().now();
    const after = Date.now();
    expect(reading).toBeGreaterThanOrEqual(before);
    expect(reading).toBeLessThanOrEqual(after);
  });

  it('RealScheduler schedules, cancels, and sleeps with system timers', async () => {
    const scheduler = new RealScheduler();

    const fired = vi.fn();
    const handle = scheduler.setTimeout(fired, 5);
    const cancelled = vi.fn();
    scheduler.clearTimeout(scheduler.setTimeout(cancelled, 5));
    scheduler.clearTimeout(null); // no-op on empty handles
    void handle;

    await scheduler.sleep(15);
    expect(fired).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('StubEnvironment reports safe defaults', () => {
    const environment = new StubEnvironment();
    expect(environment.isNetworkAvailable()).toBe(true);
    expect(environment.getBatteryLevel()).toBeUndefined();
    expect(environment.isLowPowerMode()).toBe(false);
    expect(environment.getAppState()).toBe('active');
    expect(environment.getRuntimeContext()).toEqual({
      isConnected: true,
      batteryLevel: undefined,
      appState: 'active',
    });
  });
});
