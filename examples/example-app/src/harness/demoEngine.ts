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
import { defineActivity, defineWorkflow, Workflow } from 'endura';
import { expoPlatform, ParityClient } from './expoPlatform';

const DB_NAME = 'endura-demo.db';
export const DEFAULT_ENDPOINT = 'https://postman-echo.com/post';
/** Genuinely returns HTTP 500 about half the time. */
const FLAKY_ENDPOINT = 'https://httpbin.org/status/500,200';
/** Always returns HTTP 500 — the road to the dead-letter queue. */
const DOOMED_ENDPOINT = 'https://httpbin.org/status/500';

/** A registered workflow plus the copy the Setup tab shows for it. */
export interface RegisteredWorkflow {
  workflow: Workflow;
  description: string;
}

export class DemoEngineSession {
  endpoint = DEFAULT_ENDPOINT;

  /** Registered definitions, for the panel's Setup tab. */
  registered: RegisteredWorkflow[] = [];

  private client: ParityClient | null = null;
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
  }

  /** The live client, for inspection. Null when closed. */
  getClient(): ParityClient | null {
    return this.client;
  }

  setEndpoint(url: string): void {
    const trimmed = url.trim();
    this.endpoint = /^https?:\/\//.test(trimmed) ? trimmed : DEFAULT_ENDPOINT;
  }

  // --- Workflow definitions -------------------------------------------------

  /** Real HTTP delivery with idempotency; shared by most activities. */
  private async deliver(
    endpoint: string,
    payload: Record<string, unknown>,
    jobId: string,
    attempt: number,
    signal: AbortSignal
  ): Promise<{ deliveredAt: number; httpStatus: number }> {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': jobId },
      body: JSON.stringify({ source: 'endura-demo', ...payload, attempt, sentAt: new Date().toISOString() }),
      signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${endpoint}`);
    }
    return { deliveredAt: Date.now(), httpStatus: response.status };
  }

  /** Connectivity gate: hold (attempts frozen) while the radio is off. */
  private whenOnline = (rc: { isConnected: boolean }) =>
    rc.isConnected ? { ready: true } : { ready: false, reason: 'offline — waiting for connectivity', retryInMs: 500 };

  /** Duty gate: app state first, then connectivity. */
  private whenOnDuty = (rc: { isConnected: boolean }) => {
    if (!this.onDuty) return { ready: false, reason: 'driver is off duty', retryInMs: 1000 };
    return this.whenOnline(rc);
  };

  private buildRegistry(): RegisteredWorkflow[] {
    const statusUpdate = defineWorkflow({
      name: 'demo.statusUpdate',
      activities: [
        defineActivity({
          name: 'demo.status.send',
          priority: 50,
          startToCloseTimeout: 20000,
          retry: { maximumAttempts: 8, initialInterval: 2000 },
          runWhen: this.whenOnline,
          execute: async a => {
            const input = a.input as { jobId: string; endpoint: string; note?: string };
            return this.deliver(input.endpoint, { jobId: input.jobId, kind: 'status', note: input.note }, input.jobId, a.attempt, a.signal);
          },
        }),
      ],
    });

    const flakyDelivery = defineWorkflow({
      name: 'demo.flakyDelivery',
      activities: [
        defineActivity({
          name: 'demo.flaky.send',
          priority: 40,
          startToCloseTimeout: 20000,
          retry: { maximumAttempts: 8, initialInterval: 2000 },
          runWhen: this.whenOnline,
          execute: async a => {
            const input = a.input as { jobId: string };
            return this.deliver(FLAKY_ENDPOINT, { jobId: input.jobId, kind: 'flaky' }, input.jobId, a.attempt, a.signal);
          },
        }),
      ],
    });

    const photoPipeline = defineWorkflow({
      name: 'demo.photoPipeline',
      activities: [
        defineActivity({
          name: 'demo.photo.prepare',
          retry: { maximumAttempts: 3, initialInterval: 1000 },
          execute: async a => {
            const input = a.input as { jobId: string };
            // Local work: pretend to resize/compress before upload.
            await new Promise(resolve => setTimeout(resolve, 400));
            return { prepared: true, width: 1280, height: 960, bytes: 182304, checksum: `sha1-${input.jobId}` };
          },
        }),
        defineActivity({
          name: 'demo.photo.upload',
          priority: 5,
          startToCloseTimeout: 25000,
          retry: { maximumAttempts: 8, initialInterval: 2000 },
          runWhen: this.whenOnline,
          execute: async a => {
            const input = a.input as { jobId: string; endpoint: string; checksum?: string };
            const result = await this.deliver(
              input.endpoint,
              { jobId: input.jobId, kind: 'photo-upload', checksum: input.checksum },
              input.jobId,
              a.attempt,
              a.signal
            );
            return { ...result, remoteId: `photo-${input.jobId}` };
          },
        }),
        defineActivity({
          name: 'demo.photo.finalize',
          retry: { maximumAttempts: 8, initialInterval: 2000 },
          runWhen: this.whenOnline,
          execute: async a => {
            const input = a.input as { jobId: string; endpoint: string; remoteId?: string };
            await this.deliver(
              input.endpoint,
              { jobId: input.jobId, kind: 'photo-finalize', remoteId: input.remoteId },
              `${input.jobId}-finalize`,
              a.attempt,
              a.signal
            );
            return { finalized: true };
          },
        }),
      ],
    });

    const dutyReport = defineWorkflow({
      name: 'demo.dutyReport',
      activities: [
        defineActivity({
          name: 'demo.duty.send',
          priority: 45,
          startToCloseTimeout: 20000,
          retry: { maximumAttempts: 8, initialInterval: 2000 },
          runWhen: this.whenOnDuty,
          execute: async a => {
            const input = a.input as { jobId: string; endpoint: string };
            return this.deliver(input.endpoint, { jobId: input.jobId, kind: 'duty-report' }, input.jobId, a.attempt, a.signal);
          },
        }),
      ],
    });

    const lane = (name: string, activity: string, priority: number) =>
      defineWorkflow({
        name,
        activities: [
          defineActivity({
            name: activity,
            priority,
            startToCloseTimeout: 20000,
            retry: { maximumAttempts: 8, initialInterval: 2000 },
            runWhen: this.whenOnline,
            execute: async a => {
              const input = a.input as { jobId: string; endpoint: string; lane: string };
              return this.deliver(input.endpoint, { jobId: input.jobId, kind: `lane-${input.lane}` }, input.jobId, a.attempt, a.signal);
            },
          }),
        ],
      });
    const laneUrgent = lane('demo.lane.urgent', 'demo.lane.urgent.send', 90);
    const laneNormal = lane('demo.lane.normal', 'demo.lane.normal.send', 50);
    const laneBulk = lane('demo.lane.bulk', 'demo.lane.bulk.send', 10);

    const exactlyOnce = defineWorkflow({
      name: 'demo.exactlyOnce',
      activities: [
        defineActivity({
          name: 'demo.once.send',
          priority: 40,
          startToCloseTimeout: 20000,
          retry: { maximumAttempts: 8, initialInterval: 2000 },
          runWhen: this.whenOnline,
          execute: async a => {
            const input = a.input as { jobId: string; endpoint: string; window: string };
            return this.deliver(input.endpoint, { jobId: input.jobId, kind: 'summary', window: input.window }, input.jobId, a.attempt, a.signal);
          },
        }),
      ],
    });

    const doomed = defineWorkflow({
      name: 'demo.doomed',
      activities: [
        defineActivity({
          name: 'demo.doomed.send',
          priority: 40,
          startToCloseTimeout: 20000,
          retry: { maximumAttempts: 3, initialInterval: 1500 },
          runWhen: this.whenOnline,
          execute: async a => {
            const input = a.input as { jobId: string };
            return this.deliver(DOOMED_ENDPOINT, { jobId: input.jobId, kind: 'doomed' }, input.jobId, a.attempt, a.signal);
          },
        }),
      ],
    });

    return [
      { workflow: statusUpdate, description: 'Single delivery, held while offline, up to 8 attempts.' },
      { workflow: flakyDelivery, description: 'Same shape, pointed at a server that really fails half the time.' },
      { workflow: photoPipeline, description: 'Three stages; each stage’s result feeds the next.' },
      { workflow: dutyReport, description: 'Gated on app state: holds unless the driver is on duty.' },
      { workflow: laneUrgent, description: 'Priority 90 — jumps every queue.' },
      { workflow: laneNormal, description: 'Priority 50 — the default lane.' },
      { workflow: laneBulk, description: 'Priority 10 — heavy work that must never block the rest.' },
      { workflow: exactlyOnce, description: 'Started with a uniqueKey; duplicate starts are ignored.' },
      { workflow: doomed, description: 'Only 3 attempts against a server that always fails — meets the dead-letter queue.' },
    ];
  }

  // --- Lifecycle ------------------------------------------------------------

  /**
   * Open (or reopen after a force quit). Deliberately NO reset —
   * whatever the last launch left behind is reconciled and resumed.
   */
  async open(): Promise<void> {
    if (this.client) return;
    const client = await expoPlatform.createClient(DB_NAME, () => this.radioOnline);
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

    this.registered = this.buildRegistry();
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

  async retryDeadLetter(deadLetterId: string): Promise<void> {
    await this.required().engine.retryFromDeadLetter(deadLetterId);
  }

  async cancelExecution(runId: string): Promise<void> {
    await this.required().engine.cancelExecution(runId);
  }
}
