/**
 * Field Test session — the UN-simulated counterpart to the scenarios
 * and the playground. Everything here is real:
 *
 *   - real connectivity (expo-network events; airplane mode holds the
 *     queue because the radio is actually off)
 *   - real HTTP delivery to the real internet (httpbin.org by default,
 *     or any endpoint the user pastes — e.g. a webhook.site URL they
 *     watch on a laptop)
 *   - real persistence: the database is NEVER reset on open. Force
 *     quit the app, reboot the phone — the queue is still here,
 *     because the database IS the queue.
 *   - a real production-style tick loop (client.start), not manual
 *     ticks.
 *
 * The 'flaky' job kind targets an endpoint that genuinely returns
 * HTTP 500 about half the time, so retries and backoff are driven by
 * a real server misbehaving, not a script.
 */

import * as Network from 'expo-network';
import {
  defineActivity,
  defineWorkflow,
  Workflow,
  ActivityTask,
  DeadLetterRecord,
  WorkflowExecution,
  WorkflowExecutionStatus,
} from 'endura';
import { expoPlatform, ParityClient } from './expoPlatform';

const DB_NAME = 'parity-field-test.db';
export const DEFAULT_ENDPOINT = 'https://httpbin.org/post';
const FLAKY_ENDPOINT = 'https://httpbin.org/status/500,200';

export type FieldJobKind = 'status' | 'standard' | 'photo' | 'flaky';

/** kind → (workflow name, activity name, priority). Distinct activity
 * names across workflows are load-bearing (P4-001). */
const KINDS: Record<FieldJobKind, { workflow: string; activity: string; priority: number; label: string }> = {
  status: { workflow: 'field.statusSync', activity: 'field.status.send', priority: 50, label: 'status sync (50)' },
  standard: { workflow: 'field.deliver', activity: 'field.standard.send', priority: 40, label: 'delivery (40)' },
  photo: { workflow: 'field.photoUpload', activity: 'field.photo.send', priority: 5, label: 'photo upload (5)' },
  flaky: { workflow: 'field.flaky', activity: 'field.flaky.send', priority: 40, label: 'flaky delivery (40)' },
};

export interface FieldQueueRow {
  taskId: string;
  activityName: string;
  status: string;
  attempts: number;
  scheduledFor?: number;
  priority: number;
  jobId: string;
}

export interface FieldDelivery {
  jobId: string;
  kind: string;
  httpStatus: number;
  attempts: number;
  deliveredAt: number;
}

export interface FieldView {
  online: boolean;
  engineRunning: boolean;
  endpoint: string;
  queue: FieldQueueRow[];
  delivered: FieldDelivery[];
  deliveredTotal: number;
  deadLetters: DeadLetterRecord[];
  lastEvent: string | null;
}

export class FieldTestSession {
  endpoint = DEFAULT_ENDPOINT;

  private client: ParityClient | null = null;
  private networkSub: { remove(): void } | null = null;
  private online = true;
  private jobCounter = 0;

  isOpen(): boolean {
    return this.client !== null;
  }

  isOnline(): boolean {
    return this.online;
  }

  setEndpoint(url: string): void {
    const trimmed = url.trim();
    this.endpoint = /^https?:\/\//.test(trimmed) ? trimmed : DEFAULT_ENDPOINT;
  }

  private buildWorkflows(): Workflow[] {
    return (Object.keys(KINDS) as FieldJobKind[]).map(kind => {
      const spec = KINDS[kind];
      const send = defineActivity({
        name: spec.activity,
        priority: spec.priority,
        startToCloseTimeout: 20000,
        retry: { maximumAttempts: 8, initialInterval: 2000 },
        // REAL connectivity gate: while the radio is off this holds —
        // attempts stay at 0. That is the hold-vs-fail distinction.
        runWhen: rc => (rc.isConnected ? { ready: true } : { ready: false, reason: 'offline (real)', retryInMs: 500 }),
        execute: async a => {
          const input = a.input as { jobId: string; kind: string; note?: string; endpoint: string; createdAt: string };
          const response = await fetch(input.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': input.jobId },
            body: JSON.stringify({
              source: 'endura-field-test',
              jobId: input.jobId,
              kind: input.kind,
              note: input.note,
              createdAt: input.createdAt,
              attempt: a.attempt,
              sentAt: new Date().toISOString(),
            }),
            signal: a.signal,
          });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status} from ${input.endpoint}`);
          }
          return { deliveredAt: Date.now(), httpStatus: response.status };
        },
      });
      return defineWorkflow({ name: spec.workflow, activities: [send] });
    });
  }

  /**
   * Open (or reopen after force quit) the field engine. Deliberately
   * NO database reset — whatever the last launch left behind is
   * reconciled and resumed, which is the entire demonstration.
   */
  async open(): Promise<void> {
    if (this.client) return;
    const client = await expoPlatform.createClient(DB_NAME, () => this.online);

    // Real connectivity, both pull and push.
    try {
      const state = await Network.getNetworkStateAsync();
      this.online = state.isInternetReachable ?? state.isConnected ?? true;
    } catch {
      this.online = true;
    }
    client.environment?.setNetworkState?.(this.online);
    this.networkSub = Network.addNetworkStateListener(state => {
      this.online = state.isInternetReachable ?? state.isConnected ?? false;
      client.environment?.setNetworkState?.(this.online);
    });

    for (const workflow of this.buildWorkflows()) client.registerWorkflow(workflow);
    this.client = client;
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

  /** Explicit, destructive reset — the ONLY way field state is wiped. */
  async reset(): Promise<void> {
    await this.close();
    await expoPlatform.deleteDatabase(DB_NAME);
    await this.open();
  }

  private required(): ParityClient {
    if (!this.client) throw new Error('field session not open');
    return this.client;
  }

  async addJob(kind: FieldJobKind, note?: string): Promise<string> {
    const client = this.required();
    const spec = KINDS[kind];
    this.jobCounter += 1;
    const jobId = `${kind}-${Date.now().toString(36)}-${this.jobCounter}`;
    const endpoint = kind === 'flaky' ? FLAKY_ENDPOINT : this.endpoint;
    const workflow = client.engine.getWorkflow(spec.workflow)!;
    await client.engine.start(workflow, {
      input: { jobId, kind, note, endpoint, createdAt: new Date().toISOString() },
      metadata: { jobId, kind, priority: spec.priority },
    });
    return jobId;
  }

  /** One of each priority class, in one tap — so a flush shows ordering. */
  async addPriorityMix(): Promise<void> {
    await this.addJob('photo', 'queued FIRST, should deliver LAST');
    await this.addJob('standard', 'queued second, delivers second');
    await this.addJob('status', 'queued LAST, should deliver FIRST');
  }

  async retryDeadLetter(deadLetterId: string): Promise<void> {
    await this.required().engine.retryFromDeadLetter(deadLetterId);
  }

  async view(): Promise<FieldView> {
    const client = this.required();
    const [pending, active, completedTasks, deadLetters] = await Promise.all([
      client.storage.getActivityTasksByStatus('pending'),
      client.storage.getActivityTasksByStatus('active'),
      client.storage.getActivityTasksByStatus('completed'),
      client.storage.getDeadLetters(),
    ]);

    const statuses: WorkflowExecutionStatus[] = ['running', 'completed', 'failed'];
    const executions = (await Promise.all(
      statuses.map(s => client.storage.getExecutionsByStatus(s))
    )).flat() as WorkflowExecution[];
    const metaByRun = new Map(executions.map(e => [e.runId, (e.metadata ?? {}) as Record<string, unknown>]));

    const toRow = (task: ActivityTask): FieldQueueRow => ({
      taskId: task.taskId,
      activityName: task.activityName,
      status: task.status,
      attempts: task.attempts,
      scheduledFor: task.scheduledFor,
      priority: KINDS[String(metaByRun.get(task.runId)?.kind) as FieldJobKind]?.priority ?? 0,
      jobId: String(metaByRun.get(task.runId)?.jobId ?? task.runId.slice(0, 8)),
    });

    const queue = [...(pending as ActivityTask[]), ...(active as ActivityTask[])]
      .map(toRow)
      .sort((a, b) => b.priority - a.priority || (a.scheduledFor ?? 0) - (b.scheduledFor ?? 0));

    const deliveredAll = (completedTasks as ActivityTask[])
      .filter(task => task.result && typeof task.result.deliveredAt === 'number')
      .map(task => ({
        jobId: String(metaByRun.get(task.runId)?.jobId ?? task.runId.slice(0, 8)),
        kind: String(metaByRun.get(task.runId)?.kind ?? 'standard'),
        httpStatus: Number(task.result!.httpStatus ?? 0),
        attempts: task.attempts,
        deliveredAt: Number(task.result!.deliveredAt),
      }))
      .sort((a, b) => b.deliveredAt - a.deliveredAt);

    const lastLine = client.parityLogs[client.parityLogs.length - 1];
    return {
      online: this.online,
      engineRunning: true,
      endpoint: this.endpoint,
      queue,
      delivered: deliveredAll.slice(0, 12),
      deliveredTotal: deliveredAll.length,
      deadLetters: deadLetters as DeadLetterRecord[],
      lastEvent: lastLine ?? null,
    };
  }

  /** Light stats for the status bar. */
  async stats(): Promise<{
    online: boolean;
    runningExecutions: number;
    pendingTasks: number;
    activeTasks: number;
    deadLetters: number;
    effects: number;
    lastEvent: string | null;
  }> {
    const client = this.required();
    const [running, pending, active, completed, deadLetters] = await Promise.all([
      client.storage.getExecutionsByStatus('running'),
      client.storage.getActivityTasksByStatus('pending'),
      client.storage.getActivityTasksByStatus('active'),
      client.storage.getActivityTasksByStatus('completed'),
      client.storage.getDeadLetters(),
    ]);
    const lastLine = client.parityLogs[client.parityLogs.length - 1];
    return {
      online: this.online,
      runningExecutions: running.length,
      pendingTasks: pending.length,
      activeTasks: active.length,
      deadLetters: deadLetters.length,
      // In the field the "business effect" is a real HTTP delivery.
      effects: (completed as ActivityTask[]).filter(t => t.result && t.result.httpStatus !== undefined).length,
      lastEvent: lastLine ?? null,
    };
  }
}
