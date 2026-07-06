/**
 * Interactive inspector session — the review's "Required Expo Harness
 * Capabilities" that go beyond scripted scenarios: persisted SQLite
 * state viewer, execution/task/dead-letter viewers, connectivity
 * toggle, background wake + restart simulation, failure injection
 * controls, and a fake server viewer.
 *
 * The session owns a playground database (isolated from every
 * scenario's database) with one representative 3-stage pipeline
 * registered, so the viewers always have real engine state to show and
 * the injection controls exercise the same FakeServer behavior modes
 * the scenarios use.
 */

import {
  defineActivity,
  defineWorkflow,
  Workflow,
  WorkflowExecution,
  WorkflowExecutionStatus,
  ActivityTask,
  ActivityTaskStatus,
  DeadLetterRecord,
} from 'endura';
import { FakeServer, FakeBehaviorKind, BusinessEffect, FakeCall } from './fakeServer';
import { expoPlatform, ParityClient } from './expoPlatform';

const DB_NAME = 'parity-inspector.db';
const UPLOAD_ENDPOINT = 'inspector/upload';
const FINALIZE_ENDPOINT = 'inspector/finalize';

const EXECUTION_STATUSES: WorkflowExecutionStatus[] = ['running', 'completed', 'failed', 'cancelled'];
const TASK_STATUSES: ActivityTaskStatus[] = ['pending', 'active', 'completed', 'failed', 'skipped'];

export interface InspectorSnapshot {
  online: boolean;
  executions: WorkflowExecution[];
  tasks: ActivityTask[];
  deadLetters: DeadLetterRecord[];
  /** Raw persisted SQLite state: every user table with its row count. */
  tables: Array<{ name: string; rows: number }>;
  effects: readonly BusinessEffect[];
  calls: readonly FakeCall[];
  /** Recent engine log lines (newest last). */
  logs: string[];
}

export class InspectorSession {
  readonly server = new FakeServer();

  private client: ParityClient | null = null;
  private online = true;
  private jobCounter = 0;

  private buildWorkflow(): Workflow {
    const prepare = defineActivity({
      name: 'inspector.prepare',
      retry: { maximumAttempts: 3, initialInterval: 500 },
      execute: async () => ({ prepared: true }),
    });
    const upload = defineActivity({
      name: 'inspector.upload',
      startToCloseTimeout: 8000,
      retry: { maximumAttempts: 3, initialInterval: 500 },
      runWhen: rc => (rc.isConnected ? { ready: true } : { ready: false, reason: 'offline', retryInMs: 400 }),
      execute: async a => {
        const jobId = String(a.input.jobId);
        await this.server.call({
          endpoint: UPLOAD_ENDPOINT,
          effect: { kind: 'inspector-upload', key: jobId },
          idempotencyKey: `upload-${jobId}`,
        });
        return { uploaded: true };
      },
    });
    const finalize = defineActivity({
      name: 'inspector.finalize',
      retry: { maximumAttempts: 3, initialInterval: 500 },
      runWhen: rc => (rc.isConnected ? { ready: true } : { ready: false, reason: 'offline', retryInMs: 400 }),
      execute: async a => {
        const jobId = String(a.input.jobId);
        await this.server.call({
          endpoint: FINALIZE_ENDPOINT,
          effect: { kind: 'inspector-finalized', key: jobId },
          idempotencyKey: `finalize-${jobId}`,
        });
        return { finalized: true };
      },
    });
    return defineWorkflow({ name: 'inspector.pipeline', activities: [prepare, upload, finalize] });
  }

  isOpen(): boolean {
    return this.client !== null;
  }

  isOnline(): boolean {
    return this.online;
  }

  async open(): Promise<void> {
    if (this.client) return;
    const client = await expoPlatform.createClient(DB_NAME, () => this.online);
    client.environment?.setNetworkState?.(this.online);
    client.registerWorkflow(this.buildWorkflow());
    this.client = client;
  }

  async close(): Promise<void> {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    client.stop();
    await client.close();
  }

  /** Reset the playground: drop the database and fake-server history. */
  async reset(): Promise<void> {
    await this.close();
    await expoPlatform.deleteDatabase(DB_NAME);
    this.server.reset();
    this.online = true;
    this.jobCounter = 0;
    await this.open();
  }

  private required(): ParityClient {
    if (!this.client) throw new Error('inspector session not open');
    return this.client;
  }

  /** Enqueue one pipeline job. */
  async startJob(): Promise<string> {
    const client = this.required();
    this.jobCounter += 1;
    const jobId = `job-${this.jobCounter}`;
    const workflow = client.engine.getWorkflow('inspector.pipeline')!;
    const execution = await client.engine.start(workflow, { input: { jobId }, metadata: { jobId } });
    return execution.runId;
  }

  /** One engine tick — advances due work exactly one stage. */
  async tick(): Promise<void> {
    await this.required().tick();
  }

  /** Connectivity toggle: fake server + engine environment together. */
  setOnline(online: boolean): void {
    this.online = online;
    this.server.online = online;
    this.client?.environment?.setNetworkState?.(online);
  }

  /** Simulate an app restart: close and reopen over the same database. */
  async restart(): Promise<void> {
    await this.close();
    await this.open();
  }

  /**
   * Simulate a background wake: a second engine instance over the same
   * database runs for lifespanMs, exactly like the scenarios do it.
   */
  async backgroundWake(lifespanMs = 1500): Promise<void> {
    const background = await expoPlatform.createClient(DB_NAME, () => this.online);
    background.environment?.setNetworkState?.(this.online);
    background.registerWorkflow(this.buildWorkflow());
    try {
      await background.start({ lifespan: lifespanMs });
    } finally {
      await background.close();
    }
  }

  /** Failure injection: script the NEXT upload call's behavior. */
  inject(kind: FakeBehaviorKind, delayMs?: number): void {
    this.server.script(UPLOAD_ENDPOINT, delayMs === undefined ? kind : { kind, delayMs });
  }

  releaseHung(): void {
    this.server.releaseHung();
  }

  failHung(): void {
    this.server.failHung();
  }

  async retryDeadLetter(deadLetterId: string): Promise<void> {
    await this.required().engine.retryFromDeadLetter(deadLetterId);
  }

  async snapshot(): Promise<InspectorSnapshot> {
    const client = this.required();
    const executions = (
      await Promise.all(EXECUTION_STATUSES.map(s => client.storage.getExecutionsByStatus(s)))
    ).flat() as WorkflowExecution[];
    const tasks = (
      await Promise.all(TASK_STATUSES.map(s => client.storage.getActivityTasksByStatus(s)))
    ).flat() as ActivityTask[];
    const deadLetters = (await client.storage.getDeadLetters()) as DeadLetterRecord[];

    const tableRows = await client.parityDriver.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    const tables: InspectorSnapshot['tables'] = [];
    for (const row of tableRows) {
      const name = String(row.name);
      const count = await client.parityDriver.query(`SELECT COUNT(*) AS n FROM "${name}"`);
      tables.push({ name, rows: Number(count[0]?.n ?? 0) });
    }

    return {
      online: this.online,
      executions,
      tasks,
      deadLetters,
      tables,
      effects: this.server.getEffects(),
      calls: this.server.getCalls(),
      logs: client.parityLogs.slice(-25),
    };
  }
}
