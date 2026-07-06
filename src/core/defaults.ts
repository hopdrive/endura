/**
 * Real Clock/Scheduler/Environment implementations for non-mobile
 * consumers (Node services, web). The Expo adapter ships its own
 * platform-aware versions; test doubles live in 'endura/testing'.
 */

import { Clock, Scheduler, Environment, RuntimeContext } from './types';

/**
 * A real clock that uses system time.
 */
export class RealClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/**
 * A real scheduler that uses system timers.
 */
export class RealScheduler implements Scheduler {
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
    return setTimeout(callback, delay);
  }

  clearTimeout(handle: unknown): void {
    if (handle !== null && handle !== undefined) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    }
  }

  sleep(delay: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delay));
  }
}

/**
 * A stub environment for non-mobile contexts.
 * Returns safe defaults.
 */
export class StubEnvironment implements Environment {
  isNetworkAvailable(): boolean {
    return true;
  }

  getBatteryLevel(): number | undefined {
    return undefined;
  }

  isLowPowerMode(): boolean {
    return false;
  }

  getAppState(): 'active' | 'background' | 'inactive' {
    return 'active';
  }

  getRuntimeContext(): RuntimeContext {
    return {
      isConnected: true,
      batteryLevel: undefined,
      appState: 'active',
    };
  }
}
