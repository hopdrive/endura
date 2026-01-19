/**
 * Expo/React Native environment implementation.
 * Provides runtime context like network connectivity and battery level.
 *
 * This is an event-driven implementation - no polling loops.
 * State should be updated by the app via setNetworkState(), setAppState(), etc.
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
 * Callback for network state changes.
 */
export type NetworkChangeCallback = (isConnected: boolean) => void;

/**
 * Options for configuring the Expo environment.
 */
export interface ExpoEnvironmentOptions {
  /**
   * Initial network state.
   * @default true (assume connected)
   */
  initialNetworkState?: boolean;

  /**
   * Function to get the current network connectivity state.
   * Called on refresh() to fetch current state.
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
   * Called on refresh() to fetch current state.
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
 *
 * This implementation is event-driven with NO polling loops.
 * Update state by calling setNetworkState(), setAppState(), etc.
 * Or call refresh() to fetch current state from providers.
 */
export class ExpoEnvironment implements Environment {
  private options: ExpoEnvironmentOptions;
  private cachedIsConnected: boolean;
  private cachedBatteryLevel: number | undefined;
  private cachedAppState: 'active' | 'background' | 'inactive' = 'active';
  private cachedLowPowerMode: boolean = false;

  // Network change subscribers
  private networkChangeCallbacks: Set<NetworkChangeCallback> = new Set();

  constructor(options: ExpoEnvironmentOptions = {}) {
    this.options = options;
    this.cachedIsConnected = options.initialNetworkState ?? true;

    // Do one initial refresh (async, fire-and-forget)
    this.refresh().catch(() => {});
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

  /**
   * Force refresh of cached values from providers.
   * Call this when app comes to foreground or before processing.
   */
  async refresh(): Promise<void> {
    // Get network state
    if (this.options.getNetworkState) {
      try {
        const newState = await this.options.getNetworkState();
        this.setNetworkState(newState);
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
   * Update the network state.
   * Call this from your app's NetInfo listener.
   *
   * @example
   * ```typescript
   * NetInfo.addEventListener((state) => {
   *   environment.setNetworkState(state.isConnected ?? false);
   * });
   * ```
   */
  setNetworkState(isConnected: boolean): void {
    const changed = this.cachedIsConnected !== isConnected;
    this.cachedIsConnected = isConnected;

    // Notify subscribers if state changed
    if (changed) {
      for (const callback of this.networkChangeCallbacks) {
        try {
          callback(isConnected);
        } catch {
          // Ignore callback errors
        }
      }
    }
  }

  /**
   * Subscribe to network state changes.
   * Returns an unsubscribe function.
   *
   * @example
   * ```typescript
   * const unsubscribe = environment.onNetworkChange((isConnected) => {
   *   if (isConnected) {
   *     client.processNow();
   *   }
   * });
   * ```
   */
  onNetworkChange(callback: NetworkChangeCallback): () => void {
    this.networkChangeCallbacks.add(callback);
    return () => {
      this.networkChangeCallbacks.delete(callback);
    };
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
