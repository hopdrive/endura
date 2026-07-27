/**
 * The demo's workflow definitions — imported by BOTH bundles.
 *
 * The main bundle registers these with the client so the engine knows
 * names, retry policies, and runWhen gates. The worker entry file
 * (endura.worker.ts) hands the same array to createActivityHost so the
 * worker owns the execute() functions. Same modules on both sides =
 * nothing can drift.
 *
 * Two rules keep this file worker-safe:
 *   - execute() uses only its input (plus fetch) — no app state
 *   - runWhen and the duty flag live here but are only ever evaluated
 *     on the engine side; the worker copy of `dutyState` is simply
 *     never read
 */

import { defineActivity, defineWorkflow, Workflow } from 'endura';

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

// --- Engine-side state for runWhen gates -----------------------------------
// Evaluated by the engine on the main runtime. The worker bundle gets
// its own copy of this variable, but nothing in the worker reads it.

let dutyState = true;

export function setOnDutyState(onDuty: boolean): void {
  dutyState = onDuty;
}

export function isOnDutyState(): boolean {
  return dutyState;
}

/** Connectivity gate: hold (attempts frozen) while the radio is off. */
const whenOnline = (rc: { isConnected: boolean }) =>
  rc.isConnected ? { ready: true } : { ready: false, reason: 'offline — waiting for connectivity', retryInMs: 500 };

/** Duty gate: app state first, then connectivity. */
const whenOnDuty = (rc: { isConnected: boolean }) => {
  if (!dutyState) return { ready: false, reason: 'driver is off duty', retryInMs: 1000 };
  return whenOnline(rc);
};

// --- Delivery --------------------------------------------------------------

/** Real HTTP delivery with idempotency; shared by most activities. */
async function deliver(
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

// --- Definitions -----------------------------------------------------------

const statusUpdate = defineWorkflow({
  name: 'demo.statusUpdate',
  activities: [
    defineActivity({
      name: 'demo.status.send',
      priority: 50,
      startToCloseTimeout: 20000,
      retry: { maximumAttempts: 8, initialInterval: 2000 },
      runWhen: whenOnline,
      execute: async a => {
        const input = a.input as { jobId: string; endpoint: string; note?: string };
        return deliver(input.endpoint, { jobId: input.jobId, kind: 'status', note: input.note }, input.jobId, a.attempt, a.signal);
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
      runWhen: whenOnline,
      execute: async a => {
        const input = a.input as { jobId: string };
        return deliver(FLAKY_ENDPOINT, { jobId: input.jobId, kind: 'flaky' }, input.jobId, a.attempt, a.signal);
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
      runWhen: whenOnline,
      execute: async a => {
        const input = a.input as { jobId: string; endpoint: string; checksum?: string };
        const result = await deliver(
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
      runWhen: whenOnline,
      execute: async a => {
        const input = a.input as { jobId: string; endpoint: string; remoteId?: string };
        await deliver(
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
      runWhen: whenOnDuty,
      execute: async a => {
        const input = a.input as { jobId: string; endpoint: string };
        return deliver(input.endpoint, { jobId: input.jobId, kind: 'duty-report' }, input.jobId, a.attempt, a.signal);
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
        runWhen: whenOnline,
        execute: async a => {
          const input = a.input as { jobId: string; endpoint: string; lane: string };
          return deliver(input.endpoint, { jobId: input.jobId, kind: `lane-${input.lane}` }, input.jobId, a.attempt, a.signal);
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
      runWhen: whenOnline,
      execute: async a => {
        const input = a.input as { jobId: string; endpoint: string; window: string };
        return deliver(input.endpoint, { jobId: input.jobId, kind: 'summary', window: input.window }, input.jobId, a.attempt, a.signal);
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
      runWhen: whenOnline,
      execute: async a => {
        const input = a.input as { jobId: string };
        return deliver(DOOMED_ENDPOINT, { jobId: input.jobId, kind: 'doomed' }, input.jobId, a.attempt, a.signal);
      },
    }),
  ],
});

/**
 * The thread-proof card's workflow: pure synchronous math for N
 * seconds, on purpose. On the old single-runtime engine this froze the
 * whole app; on the worker it can't touch the UI.
 */
const heavyCompute = defineWorkflow({
  name: 'demo.heavyCompute',
  activities: [
    defineActivity({
      name: 'demo.heavy.burn',
      startToCloseTimeout: 30000,
      retry: { maximumAttempts: 1 },
      execute: async a => {
        const input = a.input as { jobId: string; seconds?: number };
        const budgetMs = Math.min(input.seconds ?? 5, 20) * 1000;
        const start = Date.now();
        let iterations = 0;
        let x = 0x2545f491;
        // Blocking on purpose: no awaits, no yielding, just math.
        while (Date.now() - start < budgetMs) {
          for (let i = 0; i < 100000; i++) {
            x ^= x << 13;
            x ^= x >>> 17;
            x ^= x << 5;
          }
          iterations += 100000;
        }
        const elapsedMs = Date.now() - start;
        return { iterations, elapsedMs, perSecond: Math.round(iterations / (elapsedMs / 1000)) };
      },
    }),
  ],
});

export const demoWorkflows: RegisteredWorkflow[] = [
  { workflow: statusUpdate, description: 'Single delivery, held while offline, up to 8 attempts.' },
  { workflow: flakyDelivery, description: 'Same shape, pointed at a server that really fails half the time.' },
  { workflow: photoPipeline, description: 'Three stages; each stage’s result feeds the next.' },
  { workflow: dutyReport, description: 'Gated on app state: holds unless the driver is on duty.' },
  { workflow: laneUrgent, description: 'Priority 90 — jumps every queue.' },
  { workflow: laneNormal, description: 'Priority 50 — the default lane.' },
  { workflow: laneBulk, description: 'Priority 10 — heavy work that must never block the rest.' },
  { workflow: exactlyOnce, description: 'Started with a uniqueKey; duplicate starts are ignored.' },
  { workflow: doomed, description: 'Only 3 attempts against a server that always fails — meets the dead-letter queue.' },
  { workflow: heavyCompute, description: 'Seconds of blocking math on the worker thread — the UI never notices.' },
];
