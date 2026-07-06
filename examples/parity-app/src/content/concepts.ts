/**
 * The concept glossary for the Learn tab. Each entry teaches one Endura
 * idea in plain English, shows the minimal code for it, and points at
 * the scenario where you can watch it happen on your own device.
 */

export interface Concept {
  id: string;
  title: string;
  tagline: string;
  body: string;
  code: string;
  seeItLive?: { scenarioId: string; label: string };
}

export const concepts: Concept[] = [
  {
    id: 'workflow-activity',
    title: 'Workflows & Activities',
    tagline: 'A pipeline is a named sequence of durable steps.',
    body:
      'An Activity is one unit of work — upload a photo, sync a status — with its own retry policy and timeout. ' +
      'A Workflow chains Activities in order. Each Activity receives the accumulated results of the ones before ' +
      'it, so a six-stage photo pipeline builds its payload step by step, exactly like the driver app’s ' +
      'worker sequences. If the app dies between stages, the chain resumes at the stage it was on — not from the top.',
    code: `import { defineActivity, defineWorkflow } from 'endura';

const resize = defineActivity({
  name: 'photo.resize',
  retry: { maximumAttempts: 3, initialInterval: 500 },
  execute: async ctx => {
    const smaller = await shrink(ctx.input.uri);
    return { resizedUri: smaller }; // flows into the next stage
  },
});

const upload = defineActivity({
  name: 'photo.upload',
  execute: async ctx => {
    // ctx.input carries the ORIGINAL input + every prior result
    await api.upload(ctx.input.resizedUri);
    return { uploaded: true };
  },
});

export const photoPipeline = defineWorkflow({
  name: 'photo.pipeline',
  activities: [resize, upload],
});`,
    seeItLive: { scenarioId: 'photo-parity', label: 'Scenario 1 — six stages survive a crash mid-pipeline' },
  },
  {
    id: 'durability',
    title: 'Durability (SQLite)',
    tagline: 'Kill the app whenever you like. The work is on disk.',
    body:
      'Every execution and every task lives in SQLite the moment it is created — not in memory, not in a JS ' +
      'queue. Reopen the database with a fresh engine and it reconciles: whatever was mid-flight is picked up ' +
      'where it stopped. The scenarios in this app simulate a full app restart (close the client, reopen the ' +
      'same database file) and then assert that no stage ran twice and none were skipped.',
    code: `// App start (every launch — cold or after a crash)
const driver = await ExpoSqliteDriver.create('app.db', openDatabaseAsync);
const storage = new SQLiteStorage(driver);
await storage.initialize();

const client = await ExpoWorkflowClient.create({ storage });
client.registerWorkflow(photoPipeline);

// That's it. Anything unfinished from the last launch
// is already back in the frontier, at the right stage.
await client.start();`,
    seeItLive: { scenarioId: 'photo-parity', label: 'Scenario 1 — crash after stage 2, resume at stage 3' },
  },
  {
    id: 'tick',
    title: 'The tick loop',
    tagline: 'One tick = advance every due task one step.',
    body:
      'The engine does nothing in the background by itself — it advances when ticked. A tick claims the tasks ' +
      'that are due, runs them, and schedules what comes next. In production the client runs a tick loop for ' +
      'you; in these scenarios we tick manually so every state change is deliberate and inspectable. That is ' +
      'why you can watch a pipeline move exactly one stage at a time in the Playground.',
    code: `// Production: the client owns the loop
await client.start({ tickInterval: 1000 });

// Tests / background fetch / this app: tick explicitly
await client.tick(); // one pass over due work

// A task that isn't due yet (backoff, runWhen hold)
// is simply skipped until its scheduledFor arrives.`,
    seeItLive: { scenarioId: 'selftest', label: 'Scenario 0 — watch ticks drive a two-stage workflow' },
  },
  {
    id: 'retry',
    title: 'Retries & backoff',
    tagline: 'Transient failures are absorbed, not surfaced.',
    body:
      'Each Activity declares how many attempts it gets and how the wait grows between them. A thrown error ' +
      'consumes one attempt and schedules the retry; the rest of the pipeline simply waits. Only when the ' +
      'budget is exhausted does the workflow fail — and even then it lands in the dead-letter queue instead of ' +
      'vanishing. Attempt counts are visible per task in the Playground.',
    code: `const sync = defineActivity({
  name: 'move.statusSync',
  retry: {
    maximumAttempts: 5,
    initialInterval: 1000, // 1s, then grows per attempt
  },
  execute: async ctx => {
    await api.syncStatus(ctx.input.moveId); // throws -> retry
    return { synced: true };
  },
});`,
    seeItLive: { scenarioId: 'selftest', label: 'Scenario 0 — a transient failure retries and completes' },
  },
  {
    id: 'runwhen',
    title: 'runWhen gating',
    tagline: 'Offline is a hold, never a failure.',
    body:
      'The driver app’s core offline rule: work that needs the network should WAIT for the network, not burn ' +
      'retry attempts failing against a dead socket. An Activity’s runWhen callback inspects the runtime ' +
      'context (connectivity, battery, app state) and says "not now, check again in 400ms". A held task keeps ' +
      'its full retry budget — flip the connectivity toggle in the Playground and watch tasks hold, then flow.',
    code: `const upload = defineActivity({
  name: 'photo.upload',
  retry: { maximumAttempts: 3, initialInterval: 500 },
  runWhen: rc =>
    rc.isConnected
      ? { ready: true }
      : { ready: false, reason: 'offline', retryInMs: 400 },
  execute: async ctx => {
    await api.upload(ctx.input.uri);
    return { uploaded: true };
  },
});
// Held, not failed: attempts stay at 0 while offline.`,
    seeItLive: { scenarioId: 'offline-hold-resume', label: 'Scenario 8 — enqueue offline, attempts not burned' },
  },
  {
    id: 'idempotency',
    title: 'At-least-once + idempotency',
    tagline: 'Retries must never become duplicate business effects.',
    body:
      'A durable queue guarantees at-least-once execution — which means your server can see the same request ' +
      'twice (a retry after a timeout whose first attempt actually landed). The contract: handlers send an ' +
      'idempotency key, the server absorbs duplicates. Every scenario in this app asserts on the fake server’s ' +
      'BUSINESS EFFECT ledger — one photo uploaded, one outcome submitted — never on "the workflow completed".',
    code: `execute: async ctx => {
  await api.post('/photos', {
    body: photo,
    // Same key on every retry of this task:
    idempotencyKey: 'photo-' + ctx.input.photoId,
  });
  return { uploaded: true };
}
// Server sees the key twice -> returns the prior result,
// records ONE business effect. Retries become no-ops.`,
    seeItLive: { scenarioId: 'stale-results', label: 'Scenario 11 — a hung call lands late, absorbed cleanly' },
  },
  {
    id: 'timeout',
    title: 'Timeouts & stale results',
    tagline: 'A hung handler cannot wedge the engine — or corrupt it later.',
    body:
      'startToCloseTimeout bounds each attempt. When it fires, the engine abandons the attempt and moves on — ' +
      'but JavaScript cannot kill a promise, so the abandoned handler may STILL finish minutes later. Endura ' +
      'guarantees that late settlement cannot overwrite newer state, and logs it as discarded so production ' +
      'debugging can tell "finished late, correctly ignored" from "never finished".',
    code: `const submit = defineActivity({
  name: 'outcome.submit',
  startToCloseTimeout: 10000, // 10s per attempt
  retry: { maximumAttempts: 3, initialInterval: 2000 },
  execute: async ctx => {
    ctx.signal; // AbortSignal — honor it if you can
    await api.submit(ctx.input, { signal: ctx.signal });
    return { submitted: true };
  },
});
// Attempt 1 hangs -> timeout -> attempt 2 completes.
// If attempt 1 settles later: state untouched, and the
// engine logs 'Discarding late success…' for the audit trail.`,
    seeItLive: { scenarioId: 'stale-results', label: 'Scenario 11 — late success and late failure both bounce' },
  },
  {
    id: 'dlq',
    title: 'Dead-letter queue',
    tagline: 'Exhausted work parks for a human, it does not disappear.',
    body:
      'When an Activity spends its whole retry budget — or throws a non-retryable error like "server refused ' +
      'this write" — the task moves to the dead-letter queue with its input, error, and attempt history intact. ' +
      'From there a recovery UI (or the Playground’s RETRY button) can force-retry it, which re-arms the ' +
      'workflow exactly where it stopped. This is the driver app’s permanently_failed + Force Retry flow.',
    code: `// A server REFUSAL should not retry — mark it non-retryable:
class RefusedError extends Error {
  nonRetryable = true; // duck-typed; endura checks this
}

// Later, from your recovery screen:
const deadLetters = await client.engine.getDeadLetters();
for (const dl of deadLetters) {
  // dl.input, dl.error, dl.attempts — everything for triage
  await client.engine.retryFromDeadLetter(dl.id);
}`,
    seeItLive: { scenarioId: 'move-sync-permfail', label: 'Scenario 4 — refusal → DLQ → force retry → done' },
  },
  {
    id: 'uniquekey',
    title: 'uniqueKey dedupe',
    tagline: 'Two enqueues of the same entity collapse into one.',
    body:
      'The driver app drops a NEW offer-bundle job if one is already pending for the same offerId. Endura makes ' +
      'that a start() option: give the workflow a uniqueKey and choose what a conflict means — ignore (return ' +
      'the existing run) or throw. Two racing starts are safe: exactly one wins, and both callers get the ' +
      'winner. Completed keys are reusable; history is preserved.',
    code: `await client.engine.start(offerBundle, {
  input: { offerId },
  uniqueKey: 'offer-' + offerId,
  onConflict: 'ignore', // return the already-pending run
});

// Racing double-tap? Both calls resolve to the SAME runId.
// Once that run completes, the key frees up for reuse.`,
    seeItLive: { scenarioId: 'offer-bundle-dedupe', label: 'Scenario 7 — racing duplicate starts collapse' },
  },
  {
    id: 'lease',
    title: 'Leases (foreground vs background)',
    tagline: 'Two engines, one database, zero double-execution.',
    body:
      'iOS background fetch wakes your app while the foreground engine may already be mid-task. Both engines ' +
      'point at the same SQLite file — so every task is claimed under a short lease before it runs. The second ' +
      'engine sees the lease and moves on. If the leaseholder dies, the lease expires and the task is claimable ' +
      'again. No coordination code in your app; it is the storage contract.',
    code: `// Foreground, at launch:
const fg = await ExpoWorkflowClient.create({ storage });
await fg.start();

// Background fetch handler — SECOND engine, same database:
const bg = await ExpoWorkflowClient.create({ storage });
await bg.start({ lifespan: 20000 }); // run 20s, then stop
await bg.close();
// Active leases protect in-flight tasks from double-claim.`,
    seeItLive: { scenarioId: 'fg-bg-collision', label: 'Scenario 10 — background wake during a slow task' },
  },
  {
    id: 'priority',
    title: 'Priority & FIFO',
    tagline: 'Status syncs beat photo uploads out of a backlog.',
    body:
      'After a long offline stretch the queue holds dozens of jobs. The driver app drains move-status syncs ' +
      '(priority 50) before outcome syncs (40) before event logs (10) before photos (5) — and within one ' +
      'priority, oldest first. Endura: priority is an Activity option, and the storage frontier orders by ' +
      'priority DESC, created_at ASC. Nothing starves; low priority just waits its turn.',
    code: `const statusSync = defineActivity({
  name: 'move.statusSync',
  priority: 50, // claimed before anything lower
  execute: async ctx => { /* … */ },
});

const photoUpload = defineActivity({
  name: 'photo.upload',
  priority: 5, // drains last, FIFO within its class
  execute: async ctx => { /* … */ },
});`,
    seeItLive: { scenarioId: 'backlog-priority', label: 'Scenario 14 — a 12-job backlog drains in strict order' },
  },
  {
    id: 'upgrade',
    title: 'App upgrades & held tasks',
    tagline: 'Yesterday’s queue meets today’s code — safely.',
    body:
      'A user updates the app while work is still queued. If the new build renamed or removed an Activity, ' +
      'those persisted tasks reference a name that no longer exists. Endura HOLDS them: pending, rechecked ' +
      'every minute, zero attempts burned, never dead-lettered, with an activity:held event for observability. ' +
      'Ship a hotfix that restores the name and the held work simply resumes. Compatible changes (inserting a ' +
      'stage) continue in-flight runs by stage NAME, not index.',
    code: `// v2 renamed 'process' -> 'processV2'. Old tasks for
// 'process' are now unknown. Endura does NOT fail them:
//   task.status = 'pending', recheck in ~60s,
//   attempts unchanged, event: 'activity:held'
//
// v3 restores the definition:
client.registerWorkflow(v3Pipeline);
// …next tick, the held task runs as if nothing happened.`,
    seeItLive: { scenarioId: 'upgrade-pending-work', label: 'Scenario 12 — rename, hold, hotfix, resume' },
  },
  {
    id: 'recovery',
    title: 'Recovery policy (app layer)',
    tagline: 'The engine resumes crashes; YOUR code decides what re-arms.',
    body:
      'Crash-resume is automatic. But "should this week-old failed sync be retried when the driver opens the ' +
      'recovery screen?" is business policy, so it lives in your app: sweep the dead letters, apply an age ' +
      'gate (the driver app uses 7 days, with an includeStale override), skip non-recoverable pipelines, and ' +
      'force-retry the rest — optionally scoped to one mobility run via metadata.',
    code: `for (const dl of await engine.getDeadLetters()) {
  if (NON_RECOVERABLE.has(dl.workflowName)) continue;
  const age = now - dl.failedAt;
  if (age > SEVEN_DAYS && !includeStale) continue;
  await engine.retryFromDeadLetter(dl.id);
}
// Scope it to one run? Join dead letters to executions
// and filter on execution.metadata.mobilityRunId.`,
    seeItLive: { scenarioId: 'recovery-age-gate', label: 'Scenarios 5, 6, 13 — age gate, classification, scoping' },
  },
];
