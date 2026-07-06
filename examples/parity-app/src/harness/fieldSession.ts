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
const MAX_ATTEMPTS = 8;
// postman-echo answers fast and consistently; httpbin.org hangs or
// 503s often enough to masquerade as engine failures.
export const DEFAULT_ENDPOINT = 'https://postman-echo.com/post';
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

/** Everything the library knows about one job, in one row. */
export interface FieldJobRow {
  jobId: string;
  kind: string;
  priority: number;
  createdAt: number;
  /** Lifecycle phase, derived from execution + task + DLQ state. */
  phase: 'waiting' | 'held' | 'backoff' | 'active' | 'delivered' | 'dead';
  attempts: number;
  maxAttempts: number;
  /** For pending tasks: when the engine will look at it again. */
  nextAttemptAt?: number;
  /** Most recent recorded failure or skip, verbatim from the task. */
  lastError?: { kind: 'failure' | 'skip'; message: string; at: number };
  /** Delivery proof, when phase === 'delivered'. */
  deliveredAt?: number;
  httpStatus?: number;
  /** Set when phase === 'dead' — enables inline force retry. */
  deadLetterId?: string;
}

export interface FieldView {
  online: boolean;
  engineRunning: boolean;
  endpoint: string;
  jobs: FieldJobRow[];
  liveCount: number;
  deliveredTotal: number;
  deadTotal: number;
  /** Recent engine log lines (newest last) — the library, narrating itself. */
  logs: string[];
  lastEvent: string | null;
}

export class FieldTestSession {
  endpoint = DEFAULT_ENDPOINT;

  private client: ParityClient | null = null;
  private networkSub: { remove(): void } | null = null;
  /** What the radio reports. */
  private radioOnline = true;
  /** Software override: test offline flows without airplane mode. */
  private forcedOffline = false;
  /** Effective connectivity the engine sees (radio AND not forced). */
  private online = true;
  private jobCounter = 0;

  isOpen(): boolean {
    return this.client !== null;
  }

  isOnline(): boolean {
    return this.online;
  }

  isRadioOnline(): boolean {
    return this.radioOnline;
  }

  isForcedOffline(): boolean {
    return this.forcedOffline;
  }

  /** The live client, for the engine manager panel. Null when closed. */
  getClient(): ParityClient | null {
    return this.client;
  }

  private applyConnectivity(): void {
    this.online = this.radioOnline && !this.forcedOffline;
    this.client?.environment?.setNetworkState?.(this.online);
  }

  /** Toggle the software offline override (radio state is untouched). */
  toggleForceOffline(): void {
    this.forcedOffline = !this.forcedOffline;
    this.applyConnectivity();
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
        retry: { maximumAttempts: MAX_ATTEMPTS, initialInterval: 2000 },
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

    // Real connectivity, both pull and push (composed with the
    // software force-offline override).
    this.client = client;
    try {
      const state = await Network.getNetworkStateAsync();
      this.radioOnline = state.isInternetReachable ?? state.isConnected ?? true;
    } catch {
      this.radioOnline = true;
    }
    this.applyConnectivity();
    this.networkSub = Network.addNetworkStateListener(state => {
      this.radioOnline = state.isInternetReachable ?? state.isConnected ?? false;
      this.applyConnectivity();
    });

    for (const workflow of this.buildWorkflows()) client.registerWorkflow(workflow);
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
   * Explicit, destructive reset — the ONLY way field state is wiped.
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
    const [pending, active, completedTasks, failedTasks, deadLetters] = await Promise.all([
      client.storage.getActivityTasksByStatus('pending'),
      client.storage.getActivityTasksByStatus('active'),
      client.storage.getActivityTasksByStatus('completed'),
      client.storage.getActivityTasksByStatus('failed'),
      client.storage.getDeadLetters(),
    ]);

    const statuses: WorkflowExecutionStatus[] = ['running', 'completed', 'failed'];
    const executions = (await Promise.all(
      statuses.map(s => client.storage.getExecutionsByStatus(s))
    )).flat() as WorkflowExecution[];

    const taskByRun = new Map<string, ActivityTask>();
    for (const task of [...pending, ...active, ...completedTasks, ...failedTasks] as ActivityTask[]) {
      taskByRun.set(task.runId, task);
    }
    const deadLetterByRun = new Map(
      (deadLetters as DeadLetterRecord[]).map(deadLetter => [deadLetter.runId, deadLetter])
    );

    const jobs: FieldJobRow[] = executions.map(execution => {
      const meta = (execution.metadata ?? {}) as Record<string, unknown>;
      const task = taskByRun.get(execution.runId);
      const deadLetter = deadLetterByRun.get(execution.runId);
      const lastHistory = task?.errorHistory?.[task.errorHistory.length - 1];

      let phase: FieldJobRow['phase'] = 'waiting';
      if (deadLetter) phase = 'dead';
      else if (task?.status === 'completed') phase = 'delivered';
      else if (task?.status === 'active') phase = 'active';
      else if (task?.status === 'pending') {
        if (lastHistory?.kind === 'skip') phase = 'held';
        else if ((task.attempts ?? 0) > 0) phase = 'backoff';
        else phase = 'waiting';
      }

      return {
        jobId: String(meta.jobId ?? execution.runId.slice(0, 8)),
        kind: String(meta.kind ?? 'standard'),
        priority: Number(meta.priority ?? 0),
        createdAt: execution.createdAt,
        phase,
        attempts: deadLetter?.attempts ?? task?.attempts ?? 0,
        maxAttempts: MAX_ATTEMPTS,
        nextAttemptAt: task?.status === 'pending' ? task.scheduledFor : undefined,
        lastError: deadLetter
          ? { kind: 'failure', message: deadLetter.error, at: deadLetter.failedAt }
          : lastHistory
            ? { kind: lastHistory.kind, message: lastHistory.message, at: lastHistory.at }
            : undefined,
        deliveredAt:
          task?.result && typeof task.result.deliveredAt === 'number' ? Number(task.result.deliveredAt) : undefined,
        httpStatus:
          task?.result && task.result.httpStatus !== undefined ? Number(task.result.httpStatus) : undefined,
        deadLetterId: deadLetter?.id,
      };
    });

    // Live work first (priority desc, oldest first); finished work after,
    // newest first — so the top of the list is always "what's happening".
    const phaseRank = (job: FieldJobRow) => (job.phase === 'delivered' || job.phase === 'dead' ? 1 : 0);
    jobs.sort((a, b) => {
      const rank = phaseRank(a) - phaseRank(b);
      if (rank !== 0) return rank;
      if (phaseRank(a) === 0) return b.priority - a.priority || a.createdAt - b.createdAt;
      return (b.deliveredAt ?? b.createdAt) - (a.deliveredAt ?? a.createdAt);
    });

    const lastLine = client.parityLogs[client.parityLogs.length - 1];
    return {
      online: this.online,
      engineRunning: true,
      endpoint: this.endpoint,
      jobs,
      liveCount: jobs.filter(job => phaseRank(job) === 0).length,
      deliveredTotal: jobs.filter(job => job.phase === 'delivered').length,
      deadTotal: jobs.filter(job => job.phase === 'dead').length,
      logs: client.parityLogs.slice(-15),
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
