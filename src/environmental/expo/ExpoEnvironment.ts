/**
 * Expo/React Native environment implementation.
 * Provides runtime context like network connectivity and battery level.
 */

import { Environment, RuntimeContext } from '../../core/types';

/**
 * Network state provider function type.
 * Can be provided by the user to integrate with @react-native-community/netinfo.
 */
export type NetworkStateProvider = () => Promise<boolean> | boolean;

/**
 * Battery level provider function type.
 * Can be provided by the user to integrate with expo-battery.
 */
export type BatteryLevelProvider = () => Promise<number | undefined> | number | undefined;

/**
 * Options for configuring the Expo environment.
 */
export interface ExpoEnvironmentOptions {
  /**
   * Function to get the current network connectivity state.
   * If not provided, defaults to assuming connected.
   *
   * Example with @react-native-community/netinfo:
   * ```typescript
   * import NetInfo from '@react-native-community/netinfo';
   *
   * const environment = new ExpoEnvironment({
   *   getNetworkState: async () => {
   *     const state = await NetInfo.fetch();
   *     return state.isConnected ?? false;
   *   },
   * });
   * ```
   */
  getNetworkState?: NetworkStateProvider;

  /**
   * Function to get the current battery level (0-1).
   * If not provided, battery level will be undefined.
   *
   * Example with expo-battery:
   * ```typescript
   * import * as Battery from 'expo-battery';
   *
   * const environment = new ExpoEnvironment({
   *   getBatteryLevel: async () => {
   *     return await Battery.getBatteryLevelAsync();
   *   },
   * });
   * ```
   */
  getBatteryLevel?: BatteryLevelProvider;

  /**
   * Additional custom context values.
   * These will be merged into the runtime context.
   */
  customContext?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
}

/**
 * Expo environment implementation.
 * Provides runtime context for activities including network state and battery level.
 */
export class ExpoEnvironment implements Environment {
  private options: ExpoEnvironmentOptions;
  private cachedIsConnected: boolean = true;
  private cachedBatteryLevel: number | undefined;
  private cachedAppState: 'active' | 'background' | 'inactive' = 'active';
  private cachedLowPowerMode: boolean = false;
  private refreshHandle: ReturnType<typeof setInterval> | null = null;

  constructor(options: ExpoEnvironmentOptions = {}) {
    this.options = options;

    // Start background refresh
    this.startBackgroundRefresh();
  }

  /**
   * Start a background refresh loop to keep cached values up to date.
   */
  private startBackgroundRefresh(): void {
    // Refresh immediately
    this.refreshCachedValues();

    // Then refresh every second
    this.refreshHandle = setInterval(() => {
      this.refreshCachedValues();
    }, 1000);
  }

  /**
   * Stop the background refresh loop. Must be called when the
   * environment is discarded — every background wake creates a fresh
   * instance, and an uncleared interval leaks forever.
   * ExpoWorkflowClient.close() calls this automatically.
   */
  dispose(): void {
    if (this.refreshHandle !== null) {
      clearInterval(this.refreshHandle);
      this.refreshHandle = null;
    }
  }

  isNetworkAvailable(): boolean {
    return this.cachedIsConnected;
  }

  getBatteryLevel(): number | undefined {
    return this.cachedBatteryLevel;
  }

  isLowPowerMode(): boolean {
    return this.cachedLowPowerMode;
  }

  getAppState(): 'active' | 'background' | 'inactive' {
    return this.cachedAppState;
  }

  getRuntimeContext(): RuntimeContext {
    return {
      isConnected: this.cachedIsConnected,
      batteryLevel: this.cachedBatteryLevel,
      appState: this.cachedAppState,
    };
  }

  private refreshCachedValues(): void {
    // Get network state
    if (this.options.getNetworkState) {
      try {
        const result = this.options.getNetworkState();
        if (result instanceof Promise) {
          result.then(val => { this.cachedIsConnected = val; }).catch(() => {});
        } else {
          this.cachedIsConnected = result;
        }
      } catch {
        // Keep previous value on error
      }
    }

    // Get battery level
    if (this.options.getBatteryLevel) {
      try {
        const result = this.options.getBatteryLevel();
        if (result instanceof Promise) {
          result.then(val => { this.cachedBatteryLevel = val; }).catch(() => {});
        } else {
          this.cachedBatteryLevel = result;
        }
      } catch {
        // Keep previous value on error
      }
    }
  }

  /**
   * Force refresh of cached values asynchronously.
   * Useful when you know network state has changed.
   */
  async refresh(): Promise<void> {
    // Get network state
    if (this.options.getNetworkState) {
      try {
        this.cachedIsConnected = await this.options.getNetworkState();
      } catch {
        // Keep previous value on error
      }
    }

    // Get battery level
    if (this.options.getBatteryLevel) {
      try {
        this.cachedBatteryLevel = await this.options.getBatteryLevel();
      } catch {
        // Keep previous value on error
      }
    }
  }

  /**
   * Update the app state manually.
   * Call this from your app's AppState listener.
   */
  setAppState(state: 'active' | 'background' | 'inactive'): void {
    this.cachedAppState = state;
  }

  /**
   * Update the low power mode state manually.
   */
  setLowPowerMode(enabled: boolean): void {
    this.cachedLowPowerMode = enabled;
  }
}
