/**
 * The demo engine — ONE real Endura engine behind the whole app.
 *
 * Nothing here is simulated:
 *   - connectivity is the device's actual radio (expo-network events;
 *     airplane mode holds gated work because the radio is really off)
 *   - delivery is real HTTP to the real internet
 *   - persistence is real SQLite that is NEVER reset on launch — force
 *     quit the app and the queue is still here, because the database
 *     IS the queue
 *   - a production-style tick loop (client.start), not manual ticks
 *
 * The only extra control the app adds is state the DEVICE cannot
 * change by itself: the "on duty" flag that duty-gated workflows check
 * through runWhen. Everything else (offline, force quit, backgrounding)
 * you exercise with the phone itself.
 */

import * as Network from 'expo-network';
import { Worker } from '@ammarahmed/react-native-workers';
import { expoPlatform, ParityClient } from './expoPlatform';
import {
  DEFAULT_ENDPOINT,
  RegisteredWorkflow,
  demoWorkflows,
  setOnDutyState,
} from '../workflows/demoWorkflows';

export { DEFAULT_ENDPOINT } from '../workflows/demoWorkflows';
export type { RegisteredWorkflow } from '../workflows/demoWorkflows';

const DB_NAME = 'endura-demo.db';

export class DemoEngineSession {
  endpoint = DEFAULT_ENDPOINT;

  /** Registered definitions, for the panel's Setup tab. */
  registered: RegisteredWorkflow[] = [];

  private client: ParityClient | null = null;
  private worker: Worker | null = null;
  private networkSub: { remove(): void } | null = null;
  private radioOnline = true;
  private onDuty = true;
  private jobCounter = 0;

  isOpen(): boolean {
    return this.client !== null;
  }

  /** What the device's radio reports right now. */
  isOnline(): boolean {
    return this.radioOnline;
  }

  isOnDuty(): boolean {
    return this.onDuty;
  }

  /** App state the duty-gated workflows check through runWhen. */
  setOnDuty(onDuty: boolean): void {
    this.onDuty = onDuty;
    // runWhen gates read module state in the shared workflows module
    // (evaluated engine-side, so this main-bundle copy is the live one).
    setOnDutyState(onDuty);
  }

  /** The live client, for inspection. Null when closed. */
  getClient(): ParityClient | null {
    return this.client;
  }

  setEndpoint(url: string): void {
    const trimmed = url.trim();
    this.endpoint = /^https?:\/\//.test(trimmed) ? trimmed : DEFAULT_ENDPOINT;
  }

  // --- Lifecycle ------------------------------------------------------------

  /**
   * Open (or reopen after a force quit). Deliberately NO reset —
   * whatever the last launch left behind is reconciled and resumed.
   */
  async open(): Promise<void> {
    if (this.client) return;
    // The activity worker: a separate Hermes runtime on its own OS
    // thread. Every activity in this app executes there — the path is
    // relative to THIS file (the babel plugin resolves it at build time).
    const worker = new Worker('../workflows/endura.worker', { nativeModules: true });
    this.worker = worker;
    const client = await expoPlatform.createClient(DB_NAME, () => this.radioOnline, { worker });
    this.client = client;

    try {
      const state = await Network.getNetworkStateAsync();
      this.radioOnline = state.isInternetReachable ?? state.isConnected ?? true;
    } catch {
      this.radioOnline = true;
    }
    client.environment?.setNetworkState?.(this.radioOnline);
    this.networkSub = Network.addNetworkStateListener(state => {
      this.radioOnline = state.isInternetReachable ?? state.isConnected ?? false;
      this.client?.environment?.setNetworkState?.(this.radioOnline);
    });

    // Same definitions the worker entry file registered on its side.
    this.registered = demoWorkflows;
    for (const { workflow } of this.registered) client.registerWorkflow(workflow);
    // Production-style loop: the engine ticks itself from here on.
    void client.start({ tickInterval: 1000 }).catch(() => undefined);
  }

  async close(): Promise<void> {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    this.networkSub?.remove();
    this.networkSub = null;
    client.stop();
    await client.close();
    this.worker?.terminate();
    this.worker = null;
  }

  /**
   * Explicit, destructive reset — the ONLY way demo state is wiped.
   * Wipes tables through the open connection (a file delete can
   * silently fail while a recently-ticking client still holds the
   * handle), then closes and deletes the file as best-effort cleanup.
   */
  async reset(): Promise<void> {
    await this.open();
    const client = this.required();
    client.stop(); // no tick mid-flight while we wipe
    const tables = await client.parityDriver.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%migration%' AND name NOT LIKE '%schema%'"
    );
    for (const row of tables) {
      await client.parityDriver.execute(`DELETE FROM "${String(row.name)}"`);
    }
    await this.close();
    await expoPlatform.deleteDatabase(DB_NAME);
    this.jobCounter = 0;
    await this.open();
  }

  private required(): ParityClient {
    if (!this.client) throw new Error('demo engine not open');
    return this.client;
  }

  // --- Job creation (one method per use-case card) ---------------------------

  private async start(
    workflowName: string,
    label: string,
    input: Record<string, unknown>,
    options?: { uniqueKey?: string }
  ): Promise<string> {
    const client = this.required();
    this.jobCounter += 1;
    const jobId = `${label}-${Date.now().toString(36)}-${this.jobCounter}`;
    const workflow = client.engine.getWorkflow(workflowName)!;
    await client.engine.start(workflow, {
      input: { jobId, endpoint: this.endpoint, createdAt: new Date().toISOString(), ...input },
      metadata: { jobId },
      ...(options?.uniqueKey ? { uniqueKey: options.uniqueKey, onConflict: 'ignore' as const } : {}),
    });
    return jobId;
  }

  queueStatusUpdate(): Promise<string> {
    return this.start('demo.statusUpdate', 'status', {});
  }

  queueFlaky(): Promise<string> {
    return this.start('demo.flakyDelivery', 'flaky', {});
  }

  runPhotoPipeline(): Promise<string> {
    return this.start('demo.photoPipeline', 'photo', {});
  }

  queueDutyReport(): Promise<string> {
    return this.start('demo.dutyReport', 'duty', {});
  }

  /** Queued deliberately backwards: bulk first, urgent last. */
  async queuePriorityBatch(): Promise<void> {
    await this.start('demo.lane.bulk', 'bulk', { lane: 'bulk', note: 'queued FIRST, delivers LAST' });
    await this.start('demo.lane.normal', 'normal', { lane: 'normal' });
    await this.start('demo.lane.urgent', 'urgent', { lane: 'urgent', note: 'queued LAST, delivers FIRST' });
  }

  /** uniqueKey per minute: mash the button, get one job a minute. */
  queueExactlyOnce(): Promise<string> {
    const window = new Date().toISOString().slice(0, 16); // yyyy-mm-ddThh:mm
    return this.start('demo.exactlyOnce', 'summary', { window }, { uniqueKey: `summary-${window}` });
  }

  queueDoomed(): Promise<string> {
    return this.start('demo.doomed', 'doomed', {});
  }

  /** N seconds of blocking math — on the worker thread. */
  queueHeavyCompute(seconds = 5): Promise<string> {
    return this.start('demo.heavyCompute', 'heavy', { seconds });
  }

  async retryDeadLetter(deadLetterId: string): Promise<void> {
    await this.required().engine.retryFromDeadLetter(deadLetterId);
  }

  async cancelExecution(runId: string): Promise<void> {
    await this.required().engine.cancelExecution(runId);
  }
}
