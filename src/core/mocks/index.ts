/**
 * Mock implementations for testing - allows deterministic testing without
 * real timers or system dependencies.
 */

import { Clock, Scheduler, Environment, RuntimeContext } from '../types';

// ============================================================================
// Mock Clock
// ============================================================================

/**
 * A mock clock that allows manual time control for testing.
 */
export class MockClock implements Clock {
  private currentTime: number;

  constructor(initialTime: number = 0) {
    this.currentTime = initialTime;
  }

  now(): number {
    return this.currentTime;
  }

  /**
   * Advance time by the given amount.
   */
  advance(ms: number): void {
    this.currentTime += ms;
  }

  /**
   * Set the current time to a specific value.
   */
  setTime(time: number): void {
    this.currentTime = time;
  }
}

// ============================================================================
// Mock Scheduler
// ============================================================================

interface ScheduledTask {
  id: number;
  callback: () => void;
  executeAt: number;
  cancelled: boolean;
}

/**
 * A mock scheduler that allows deterministic testing of timing-dependent code.
 * Tasks are not executed automatically - call `tick()` or `runAll()` to execute.
 */
export class MockScheduler implements Scheduler {
  private tasks: Map<number, ScheduledTask> = new Map();
  private nextId = 1;
  private clock: MockClock;
  private pendingPromises: Map<number, { resolve: () => void; executeAt: number }> = new Map();

  constructor(clock: MockClock) {
    this.clock = clock;
  }

  setTimeout(callback: () => void, delay: number): number {
    const id = this.nextId++;
    this.tasks.set(id, {
      id,
      callback,
      executeAt: this.clock.now() + delay,
      cancelled: false,
    });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') {
      const task = this.tasks.get(handle);
      if (task) {
        task.cancelled = true;
        this.tasks.delete(handle);
      }
    }
  }

  sleep(delay: number): Promise<void> {
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pendingPromises.set(id, {
        resolve,
        executeAt: this.clock.now() + delay,
      });
    });
  }

  /**
   * Execute all tasks that should run at or before the current clock time.
   * Returns the number of tasks executed.
   */
  tick(): number {
    const now = this.clock.now();
    let executed = 0;

    // Execute scheduled tasks
    for (const task of this.tasks.values()) {
      if (!task.cancelled && task.executeAt <= now) {
        task.callback();
        this.tasks.delete(task.id);
        executed++;
      }
    }

    // Resolve pending sleep promises
    for (const [id, pending] of this.pendingPromises.entries()) {
      if (pending.executeAt <= now) {
        pending.resolve();
        this.pendingPromises.delete(id);
      }
    }

    return executed;
  }

  /**
   * Advance the clock and execute all tasks up to that time.
   */
  advanceAndTick(ms: number): number {
    this.clock.advance(ms);
    return this.tick();
  }

  /**
   * Execute all scheduled tasks regardless of their scheduled time.
   * Advances the clock to the latest scheduled task time.
   */
  runAll(): number {
    let executed = 0;

    // Find latest scheduled time
    let latestTime = this.clock.now();
    for (const task of this.tasks.values()) {
      if (!task.cancelled && task.executeAt > latestTime) {
        latestTime = task.executeAt;
      }
    }
    for (const pending of this.pendingPromises.values()) {
      if (pending.executeAt > latestTime) {
        latestTime = pending.executeAt;
      }
    }

    // Advance clock and execute
    this.clock.setTime(latestTime);

    for (const task of this.tasks.values()) {
      if (!task.cancelled) {
        task.callback();
        executed++;
      }
    }
    this.tasks.clear();

    for (const pending of this.pendingPromises.values()) {
      pending.resolve();
    }
    this.pendingPromises.clear();

    return executed;
  }

  /**
   * Get count of pending tasks.
   */
  getPendingCount(): number {
    return this.tasks.size + this.pendingPromises.size;
  }

  /**
   * Clear all scheduled tasks without executing them.
   */
  clear(): void {
    this.tasks.clear();
    this.pendingPromises.clear();
  }
}

// ============================================================================
// Mock Environment
// ============================================================================

export interface MockEnvironmentState {
  isConnected: boolean;
  batteryLevel: number | undefined;
  isLowPowerMode: boolean;
  appState: 'active' | 'background' | 'inactive';
}

/**
 * A mock environment for testing runWhen conditions.
 */
export class MockEnvironment implements Environment {
  private state: MockEnvironmentState;

  constructor(initialState?: Partial<MockEnvironmentState>) {
    this.state = {
      isConnected: true,
      batteryLevel: 1.0,
      isLowPowerMode: false,
      appState: 'active',
      ...initialState,
    };
  }

  isNetworkAvailable(): boolean {
    return this.state.isConnected;
  }

  getBatteryLevel(): number | undefined {
    return this.state.batteryLevel;
  }

  isLowPowerMode(): boolean {
    return this.state.isLowPowerMode;
  }

  getAppState(): 'active' | 'background' | 'inactive' {
    return this.state.appState;
  }

  getRuntimeContext(): RuntimeContext {
    return {
      isConnected: this.state.isConnected,
      batteryLevel: this.state.batteryLevel,
      appState: this.state.appState,
    };
  }

  // ============================================================================
  // Test Helpers
  // ============================================================================

  /**
   * Set network connectivity state.
   */
  setConnected(isConnected: boolean): void {
    this.state.isConnected = isConnected;
  }

  /**
   * Set battery level (0-1).
   */
  setBatteryLevel(level: number | undefined): void {
    this.state.batteryLevel = level;
  }

  /**
   * Set low power mode state.
   */
  setLowPowerMode(isLowPowerMode: boolean): void {
    this.state.isLowPowerMode = isLowPowerMode;
  }

  /**
   * Set app state.
   */
  setAppState(appState: 'active' | 'background' | 'inactive'): void {
    this.state.appState = appState;
  }

  /**
   * Update multiple state values at once.
   */
  setState(state: Partial<MockEnvironmentState>): void {
    this.state = { ...this.state, ...state };
  }
}

// Real implementations (RealClock, RealScheduler, StubEnvironment) live
// in ../defaults — they are production API, not test doubles.
