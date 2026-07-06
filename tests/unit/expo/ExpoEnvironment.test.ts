/**
 * ExpoEnvironment connectivity push API (parity issue P4-005).
 *
 * The polled getNetworkState cache defaults to true and refreshes on a
 * 1s interval, so after a real network drop runWhen gates saw a stale
 * "online" for up to a second and burned retry attempts on
 * guaranteed-fail requests. The push setter is the NetInfo-listener
 * pattern: the app tells the environment the moment connectivity
 * changes, like setAppState.
 */

import { ExpoEnvironment } from '../../../src/environmental/expo/ExpoEnvironment';

describe('ExpoEnvironment.setNetworkState', () => {
  it('flips connectivity immediately, without waiting for a poll', () => {
    const environment = new ExpoEnvironment();
    expect(environment.isNetworkAvailable()).toBe(true);

    environment.setNetworkState(false);
    expect(environment.isNetworkAvailable()).toBe(false);
    expect(environment.getRuntimeContext().isConnected).toBe(false);

    environment.setNetworkState(true);
    expect(environment.isNetworkAvailable()).toBe(true);
    expect(environment.getRuntimeContext().isConnected).toBe(true);

    environment.dispose();
  });

  it('is authoritative when no polled provider is configured', async () => {
    const environment = new ExpoEnvironment();
    environment.setNetworkState(false);

    // No getNetworkState provider: the refresh cycle must not overwrite
    // the pushed value.
    await environment.refresh();
    expect(environment.isNetworkAvailable()).toBe(false);

    environment.dispose();
  });
});
