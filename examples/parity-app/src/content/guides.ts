/**
 * Per-scenario educational content: the skeptic's question each
 * scenario answers, what it proves, the driver-app behavior it
 * mirrors, the concepts it demonstrates, a focused code sample, and
 * the file structure you would use to build the same thing in a real
 * app.
 *
 * Keyed by scenarioId. The Scenarios tab renders this as the Story and
 * Code views of each card.
 */

export interface ScenarioGuide {
  /** The skeptic's question this scenario answers, verbatim. */
  question: string;
  /** What you will watch happen, and what it proves. */
  story: string;
  /** The production driver-app behavior this mirrors. */
  parity: string;
  /** Concept ids from concepts.ts shown as chips. */
  concepts: string[];
  /** Focused, annotated code sample. */
  code: string;
  /** File structure for building this feature in a real app. */
  files: string;
}

export const guides: Record<string, ScenarioGuide> = {
  selftest: {
    question: 'Is any of this real, or is the demo rigged?',
    story:
      'Before proving anything hard, the harness proves itself. A two-stage workflow runs against a real ' +
      'SQLite file on this device: it completes online, accumulates payloads between stages, absorbs a ' +
      'duplicate idempotency key without a second business effect, rejects while offline, and survives a ' +
      'simulated app restart. If this passes, every mechanism the other scenarios rely on — the fake server, ' +
      'the effect ledger, restarts, connectivity control — is working, visibly, on your hardware.',
    parity:
      'No production counterpart — this is the harness clearing its own throat. Reset any scenario and rerun ' +
      'it whenever you want; each one owns an isolated database file, so runs are deterministic.',
    concepts: ['workflow-activity', 'tick', 'idempotency', 'durability'],
    code: `// Every scenario runs against REAL persistence:
const driver = await ExpoSqliteDriver.create(
  'parity-selftest.db', openDatabaseAsync);
const storage = new SQLiteStorage(driver);
await storage.initialize();

const client = await ExpoWorkflowClient.create({ storage });
client.registerWorkflow(twoStagePipeline);

const run = await client.engine.start(twoStagePipeline, {
  input: { jobId: 'demo-1' },
});
await client.tick(); // stage 1
await client.tick(); // stage 2 -> completed`,
    files: `examples/parity-app/
  src/harness/
    expoPlatform.ts   opens the per-scenario SQLite database
    fakeServer.ts     scriptable server + business-effect ledger
    runner.ts         restart / background-wake / offline simulation
  src/scenarios/
    selftest.ts       this scenario`,
  },

  'photo-parity': {
    question: 'What happens to a six-stage photo upload when the app is killed at stage three?',
    story:
      'A photo pipeline (hash → resize → blurhash → mark-pending → upload → finalize) runs with the app ' +
      '"crashing" at two different points — the client is torn down and rebuilt over the same database, which ' +
      'is exactly what a real relaunch does. Watch the effect ledger: every stage runs exactly once across the ' +
      'crashes. Then a hung upload times out, retries, completes — and when the original hung call finally ' +
      'lands, the server absorbs it with zero duplicate uploads.',
    parity:
      'The driver app’s photoUpload worker sequence with per-stage payload accumulation. Its core invariant — ' +
      'never re-run a stage that already advanced — is asserted here as effect counts, not just completion.',
    concepts: ['workflow-activity', 'durability', 'retry', 'idempotency', 'timeout'],
    code: `const pipeline = defineWorkflow({
  name: 'photo.pipeline',
  activities: [hash, resize, blurhash, markPending, upload, finalize],
});

// Each stage returns a fragment; later stages see all of it:
const resize = defineActivity({
  name: 'photo.resize',
  execute: async ctx => {
    // ctx.input: { photoId, uri, hash }  <- prior results merged
    return { resizedUri: await shrink(ctx.input.uri) };
  },
});

// "Crash": close the client, reopen the same DB, re-register.
// The engine reconciles and resumes AT the in-flight stage.
await client.close();
client = await ExpoWorkflowClient.create({ storage });
client.registerWorkflow(pipeline);`,
    files: `src/
  workflows/photoPipeline.ts   defineWorkflow + 6 stages
  activities/photo/
    hash.ts resize.ts …        one defineActivity per stage
  services/api.ts              idempotency-keyed uploads
  client.ts                    create + register on every launch`,
  },

  'outcome-draft-sync': {
    question: 'Two screens enqueue the same draft sync at once. Do we get two drafts?',
    story:
      'Outcome draft syncing is deliberately NOT deduplicated (that is the production contract), so two ' +
      'concurrent enqueues both run — and the scenario proves that is safe: one draft is created (the server ' +
      'create is idempotency-keyed), both merges land, and repeated or empty merges converge instead of ' +
      'corrupting. A crash after stage one resumes cleanly; a transient failure in stage two retries.',
    parity:
      'The outcomeWorkflowDataSync pipeline: create-or-resolve draft, then merge workflow data. Convergence ' +
      'under concurrent non-deduped enqueues is the property production quietly relies on.',
    concepts: ['workflow-activity', 'idempotency', 'retry', 'durability'],
    code: `// No uniqueKey here — concurrency is ALLOWED by contract.
// Safety comes from server-side idempotency + merge semantics:
const createDraft = defineActivity({
  name: 'outcomeSync.createDraft',
  execute: async ctx => {
    await api.post('/outcomes/draft', {
      idempotencyKey: 'draft-' + ctx.input.moveId, // one draft
    });
    return { draftReady: true };
  },
});
const mergeData = defineActivity({
  name: 'outcomeSync.mergeData',
  execute: async ctx => {
    await api.patch('/outcomes/draft/merge', ctx.input.fields);
    return { merged: true }; // merges commute; both land safely
  },
});`,
    files: `src/
  workflows/outcomeDraftSync.ts   2-stage pipeline
  services/outcomes.ts            idempotent create + merge calls`,
  },

  'outcome-submit': {
    question: 'Can a retry ever double-submit a vehicle outcome?',
    story:
      'The scariest failure in the fleet: a submit that lands twice. This scenario drives the full draft → ' +
      'sync → submit chain through a crash, a transient failure, a deliberate resubmit after completion, and ' +
      'a void race — and the ledger shows exactly ONE submit effect. Note the stage names: they are prefixed ' +
      'per pipeline (outcomeSubmit.stage1… vs outcomeWorkflowDataSync.stage1…) because distinct names are ' +
      'load-bearing, which this harness discovered the hard way (issue P4-001).',
    parity:
      'The outcomeSubmit worker sequence and its server-side status guard. Mid-fill sync must never trigger a ' +
      'submit; a completed submit must absorb any late duplicate.',
    concepts: ['workflow-activity', 'idempotency', 'timeout', 'dlq'],
    code: `const submit = defineActivity({
  name: 'outcomeSubmit.submit', // pipeline-prefixed: load-bearing
  startToCloseTimeout: 10000,
  retry: { maximumAttempts: 3, initialInterval: 1000 },
  execute: async ctx => {
    await api.post('/outcomes/submit', {
      // The server's status:'new' guard, expressed as a key —
      // any second submit for this outcome is absorbed:
      idempotencyKey: 'submit-' + ctx.input.outcomeId,
    });
    return { submitted: true };
  },
});`,
    files: `src/
  workflows/outcomeSubmit.ts      draft -> sync -> submit chain
  workflows/outcomeDraftSync.ts   sibling pipeline, distinct names
  services/outcomes.ts            submit with idempotency key`,
  },

  'move-sync-permfail': {
    question: 'The server says "no, permanently." Does the app retry forever — or lose the work?',
    story:
      'Neither. A move-status sync hits a permanent refusal (a row filter, a reassigned move). The error is ' +
      'duck-typed nonRetryable, so the engine spends ONE attempt, parks the task in the dead-letter queue with ' +
      'its full context, and excludes it from automatic recovery. Then a force retry — the driver tapping the ' +
      'button — re-arms it and it completes with exactly one final business effect.',
    parity:
      'RowFilterRejectedError → permanently_failed → Force Retry in the driver app, minus the three divergent ' +
      'hand-maintained lists that made that flow fragile.',
    concepts: ['dlq', 'retry', 'recovery'],
    code: `class PermanentRefusalError extends Error {
  readonly nonRetryable = true; // endura checks this shape
}

const statusSync = defineActivity({
  name: 'move.statusSync',
  retry: { maximumAttempts: 5, initialInterval: 1000 },
  execute: async ctx => {
    const res = await api.syncStatus(ctx.input.moveId);
    if (res.status === 403) {
      throw new PermanentRefusalError('server refused write');
    } // nonRetryable: 1 attempt spent, straight to the DLQ
    return { synced: true };
  },
});

// Recovery screen "Force Retry":
await engine.retryFromDeadLetter(deadLetter.id);`,
    files: `src/
  workflows/moveStatusSync.ts   the pipeline
  errors.ts                     PermanentRefusalError et al
  screens/RecoveryScreen.tsx    DLQ list + force-retry button`,
  },

  'recovery-age-gate': {
    question: 'Should a two-week-old failed sync silently fire when the driver reopens the app?',
    story:
      'No — and that policy belongs to your app, not the engine. This scenario builds the driver app’s ' +
      'recovery sweep in ~40 lines: dead letters younger than 7 days re-arm automatically; older ones are ' +
      'skipped with a reason string until a human passes includeStale. Watch the sweep return exactly which ' +
      'work it redrove and which it refused, and why.',
    parity:
      'recovery.ts MAX_RECOVERABLE_EVENT_AGE_MS and the includeStale override — reproduced as an app-layer ' +
      'sweep over engine inspection APIs, where business policy belongs.',
    concepts: ['recovery', 'dlq'],
    code: `async function recoverySweep(engine, { now, includeStale }) {
  const redriven = [], skipped = [];
  for (const dl of await engine.getDeadLetters()) {
    const ageMs = now - dl.failedAt;
    if (ageMs > SEVEN_DAYS_MS && !includeStale) {
      skipped.push({ dl, reason: 'stale: outside 7d window' });
      continue;
    }
    await engine.retryFromDeadLetter(dl.id);
    redriven.push(dl);
  }
  return { redriven, skipped }; // show this to the driver
}`,
    files: `src/
  recovery/sweep.ts             the age-gated sweep (app layer)
  screens/RecoveryScreen.tsx    "Recover" + "Include stale" toggle`,
  },

  'non-recoverable': {
    question: 'Some pipelines must fire once and never rise from the dead. Can we guarantee that?',
    story:
      'Fire-and-forget work (a diagnostic dump, a reaper job) must not be resurrected by the recovery screen ' +
      'weeks later. The scenario classifies a workflow as non-recoverable, fails it once, runs the sweep — ' +
      'and the sweep refuses it with an explicit reason, forever. Cleanup (acknowledge + purge) is shown too, ' +
      'so the DLQ stays a worklist rather than a landfill.',
    parity:
      'recoverable: false on photoReaper and sendAppDump. Endura keeps the classification NEXT to the ' +
      'definitions (a set the sweep consults); a definition-level field is a cataloged follow-up (P4-002).',
    concepts: ['recovery', 'dlq'],
    code: `// Beside your workflow definitions:
export const NON_RECOVERABLE = new Set([
  'diagnostics.appDump',
  'photo.reaper',
]);

// In the sweep:
if (NON_RECOVERABLE.has(dl.workflowName)) {
  skipped.push({ dl, reason: 'non-recoverable pipeline' });
  continue;
}

// Housekeeping when triage is done:
await engine.acknowledgeDeadLetter(dl.id);`,
    files: `src/
  workflows/registry.ts         definitions + NON_RECOVERABLE set
  recovery/sweep.ts             consults the set, never re-arms`,
  },

  'offer-bundle-dedupe': {
    question: 'The driver double-taps "accept offer". How many bundle jobs run?',
    story:
      'One. The workflow starts with uniqueKey offer-<id> and onConflict ignore: the second start returns the ' +
      'FIRST run instead of creating a sibling. The scenario then races two starts in the same tick — both ' +
      'resolve to the same runId, one execution exists, one set of effects lands. This exact race found a real ' +
      'engine bug during Phase 4 (P4-003, fixed): concurrent transactions used to cross-join.',
    parity:
      'The pending-event predicate dedupe on offerId (drop the NEW enqueue, keep the old). Endura also offers ' +
      'onConflict throw when the caller needs to KNOW it collided.',
    concepts: ['uniquekey', 'idempotency'],
    code: `const startBundle = (offerId: string) =>
  client.engine.start(offerBundle, {
    input: { offerId },
    uniqueKey: 'offer-' + offerId,
    onConflict: 'ignore', // second caller gets the first run
  });

// The double-tap, faithfully:
const [a, b] = await Promise.all([
  startBundle('OF-100'),
  startBundle('OF-100'),
]);
// a.runId === b.runId  -> one execution, one effect set`,
    files: `src/
  workflows/offerBundle.ts    the bundle pipeline
  services/offers.ts          accept + process calls`,
  },

  'offline-hold-resume': {
    question: 'Work is queued in a parking garage. What state is it in when the driver surfaces?',
    story:
      'Intact — with its FULL retry budget. Jobs enqueued offline are held by runWhen: each poll notes the ' +
      'skip in the task’s history and reschedules, decrementing nothing. Watch the task viewer: attempts stays ' +
      'at 0 the whole time. Connectivity returns, the very next tick runs the work, and a restart while ' +
      'offline changes none of it — held state is durable too.',
    parity:
      'isJobRunnable connectivity gating: offline is a skip, never a failure. The driver app never burned ' +
      'attempts against a dead radio; neither does this.',
    concepts: ['runwhen', 'durability', 'tick'],
    code: `runWhen: rc =>
  rc.isConnected
    ? { ready: true }
    : { ready: false, reason: 'offline', retryInMs: 400 },

// While offline, every poll:
//   task.status:   pending  (never 'failed')
//   task.attempts: 0        (budget untouched)
//   errorHistory:  { kind: 'skip', message: 'offline' }
// Back online -> next tick executes it, attempt #1.`,
    files: `src/
  activities/gates.ts     shared runWhen helpers (online, foreground)
  client.ts               NetInfo -> environment.setNetworkState`,
  },

  'offline-mid-stage': {
    question: 'The network dies WHILE a request is in flight. Now what?',
    story:
      'Two different failures, two different treatments — and the distinction matters. The socket drop mid-call ' +
      'is a real attempt: it burns one retry and schedules backoff. But once the app KNOWS it is offline, the ' +
      'gate holds the retry without burning anything. Connectivity returns; the stage completes; the ledger ' +
      'shows each business effect exactly once. This scenario also exposed a real engine gap (P4-005, fixed): ' +
      'connectivity must be PUSHED into the engine, not polled a second late.',
    parity:
      'The driver app mid-flight drop behavior: fail the in-flight attempt honestly, then hold — do not ' +
      'grind the budget against a network that is known to be gone.',
    concepts: ['runwhen', 'retry', 'idempotency'],
    code: `// Wire connectivity as a PUSH, not a poll (P4-005):
import NetInfo from '@react-native-community/netinfo';

const client = await ExpoWorkflowClient.create({ storage });
NetInfo.addEventListener(state => {
  client.environment.setNetworkState(!!state.isConnected);
});
// The very next runWhen evaluation sees the truth —
// no 1-second stale window burning retry budgets.`,
    files: `src/
  client.ts               NetInfo listener -> setNetworkState
  activities/gates.ts     runWhen: hold when offline`,
  },

  'fg-bg-collision': {
    question: 'iOS wakes the app in the background while the foreground engine is mid-upload. Double execution?',
    story:
      'The nightmare that keeps queue authors up at night, reproduced deliberately: a slow (2.5s) upload is ' +
      'mid-flight on the foreground engine when a SECOND engine starts over the same database — a real ' +
      'background wake. The second engine sees the active lease and claims nothing. One execution, one effect. ' +
      'Kill the leaseholder instead, and the lease expires so work is never stranded either.',
    parity:
      'The gate the review demanded before background execution can be enabled at all. RNQ solved this with a ' +
      'global JS lock; Endura solves it in storage, so it holds across PROCESSES, not just one JS thread.',
    concepts: ['lease', 'durability', 'tick'],
    code: `// This is the whole background-fetch handler:
TaskManager.defineTask('bg-fetch', async () => {
  const bg = await ExpoWorkflowClient.create({ storage });
  bg.registerWorkflow(pipelines);
  await bg.start({ lifespan: 20000 });
  await bg.close();
  return BackgroundFetch.Result.NewData;
});
// No locks, no flags, no "is the app foregrounded" checks.
// Tasks are claimed under a lease; collisions are impossible
// by construction, and expired leases self-heal.`,
    files: `src/
  background/fetchTask.ts   the second-engine handler above
  client.ts                 the foreground engine (same storage)`,
  },

  'stale-results': {
    question: 'A request hangs, times out, retries… then the ORIGINAL response arrives. Does it corrupt anything?',
    story:
      'JavaScript cannot cancel a promise — a timed-out handler keeps running and may settle minutes later. ' +
      'This scenario hangs a call, lets the timeout fire and the retry complete the workflow, THEN releases ' +
      'the hung call as a success (and again as a failure). The execution’s updatedAt does not move; the ' +
      'server absorbs the late landing via its idempotency key; and the engine logs the discard so production ' +
      'traces show "ignored stale result", not silence (P4-006, added by this scenario).',
    parity:
      'The stale-failure guard — "never downgrade a synced or stage-advanced event" — the single most ' +
      'load-bearing invariant in the driver app’s pipeline layer.',
    concepts: ['timeout', 'idempotency'],
    code: `// The guarantee, as the test asserts it:
const before = execution.updatedAt;

server.releaseHung();      // stale SUCCESS finally lands
await sleep(50);
expect(execution.updatedAt).toBe(before); // untouched

server.failHung();         // stale FAILURE finally lands
expect(execution.status).toBe('completed'); // still done

// And in the engine log:
// "Discarding late success from timed-out or aborted attempt"`,
    files: `endura/src/core/engine/
  WorkflowEngine.ts    the race + discard logging (engine-side —
                       your app writes nothing to get this)`,
  },

  'upgrade-pending-work': {
    question: 'An app update renames a pipeline stage while jobs are queued. Do they explode?',
    story:
      'They wait. Version 2 renames an activity out from under a persisted task; the engine holds the unknown ' +
      'task — pending, rechecked every minute, zero attempts burned, never dead-lettered, with an ' +
      'activity:held log you can alert on. Version 3 restores the name: the held task simply runs. Then a ' +
      'compatible upgrade inserts a new stage, and the in-flight run continues at its stage BY NAME while new ' +
      'runs pick up the inserted stage.',
    parity:
      'The upgrade-skew guard the driver app needed but only approximated — its hand-maintained jobMapper ' +
      'produced jobs with undefined workers (a defect this suite retires rather than reproduces).',
    concepts: ['upgrade', 'durability', 'recovery'],
    code: `// The whole feature is: register what THIS build knows.
client.registerWorkflow(currentPipeline);

// Tasks referencing activities this build lacks:
//   -> held (pending, recheck ~60s, attempts unchanged)
//   -> logger.warn('Activity not registered … holding task')
//   -> event: 'activity:held'   <- alert on this in prod
//
// In-flight runs match stages by NAME on resume, so
// inserting a stage never re-runs or skips existing work.`,
    files: `src/
  workflows/registry.ts   one registration list per build —
                          the three divergent driver-app lists
                          collapse into this single file`,
  },

  'run-scoped-recovery': {
    question: 'A mobility run has three failed stops. Can the driver retry JUST that run?',
    story:
      'Metadata is the scoping channel: every execution carries { mobilityRunId, stopId } (or { moveId }). ' +
      'The recovery UI joins dead letters to executions and force-retries only RUN-A — RUN-B’s failure and a ' +
      'move-scoped failure sit untouched, visibly. In the driver app this recovery path was silently DEAD for ' +
      'all ten mobility pipelines; here it is a working, provable feature.',
    parity:
      'Replaces the jobMapper omission (Do Not Carry Forward) and the camelCase-only payload-key lifting that ' +
      'made mobility events invisible to recovery queries.',
    concepts: ['recovery', 'dlq'],
    code: `// Scope at enqueue time:
await engine.start(stopSync, {
  input: { runId, stopId },
  metadata: { mobilityRunId: runId, stopId }, // queryable
});

// The per-run recovery screen:
async function deadLettersForRun(runId) {
  const scoped = [];
  for (const dl of await engine.getDeadLetters()) {
    const ex = await engine.getExecution(dl.runId);
    if (ex?.metadata.mobilityRunId === runId) scoped.push(dl);
  }
  return scoped; // retry these; other runs untouched
}`,
    files: `src/
  workflows/mobility/stopSync.ts   metadata-scoped pipelines
  screens/RunRecoverySheet.tsx     per-run failed-work list`,
  },

  'backlog-priority': {
    question: 'After an hour offline there are 12 queued jobs. What order do they drain in?',
    story:
      'Exactly the order the business needs: move-status syncs (50), then outcome syncs (40), then event logs ' +
      '(10), then photos (5) — FIFO inside each class. The scenario enqueues the twelve jobs INTERLEAVED so ' +
      'the drain order cannot accidentally mirror insertion, reconnects, and reads the order straight off the ' +
      'business-effect ledger. Nothing starves; the photos all land, just last.',
    parity:
      'The driver app’s jobOptions priorities, preserved: dispatch-critical state beats bulk media out of ' +
      'every backlog.',
    concepts: ['priority', 'runwhen', 'tick'],
    code: `// Priority is one line per activity:
defineActivity({ name: 'move.statusSync', priority: 50, … });
defineActivity({ name: 'outcome.sync',    priority: 40, … });
defineActivity({ name: 'log.sendEvent',   priority: 10, … });
defineActivity({ name: 'photo.upload',    priority: 5,  … });

// The frontier query does the rest:
//   ORDER BY priority DESC, created_at ASC
// -> strict priority order, FIFO within each class.`,
    files: `src/
  workflows/priorities.ts   the 50/40/10/5 constants, one place`,
  },
};
