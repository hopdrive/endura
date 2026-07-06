# Endura Production Readiness Review

**Date:** 2026-07-05
**Reviewed version:** `endura@0.1.0` (unpublished), commit `720e7fb`
**Purpose:** Determine whether Endura is reliable enough to replace `@hopdrive/react-native-queue` + the driver-app-3 pipeline layer as a foundational dependency of the driver app rewrite.

---

## Executive Summary

**Overall rating: `High Risk` — should not be used as a foundation until major issues are resolved.**

Endura's core engine is a clean, well-organized linear workflow runner with genuinely good in-memory test coverage (266 passing tests, honest at-least-once documentation, sensible abstractions). But the properties that actually matter for a field-deployed driver app — durable crash recovery, safe concurrent access from foreground + background engines, and working on-device persistence — are broken by construction, and in one case the package **cannot execute a single task on a real device at all**:

1. **The Expo SQLite driver is fundamentally broken.** `expo-sqlite`'s `withTransactionAsync` returns `Promise<void>` (verified against upstream typings), but `ExpoSqliteDriver.transaction()` relies on it returning the callback's value. On device, `claimActivityTask()` always returns `undefined`, so the engine treats every task as unclaimable — while the claiming `UPDATE` has already marked it `active`. Every queued task becomes a stranded zombie without ever executing. This proves the package has never been run against a real Expo app.
2. **Test-time transactions are a no-op.** `BetterSqlite3Driver.transaction()` literally just calls the function (the comment admits it), so the entire green test suite validates zero atomicity. The production driver has 0% test coverage.
3. **Guaranteed duplicate execution under the intended deployment.** Every `WorkflowEngine.create()` unconditionally resets all `active` tasks to `pending`. A background-fetch wake while the foreground engine is mid-task deterministically re-runs (or falsely permanently fails) the foreground's in-flight work. There is no lease, owner, or heartbeat concept.
4. **Crash-window orphaned workflows.** Step completion → execution advance → next-task scheduling is three separate non-transactional writes. A crash between them leaves a workflow permanently `running` with no task; recovery only scans `active` tasks and never repairs it.
5. **At-most-once by default.** `attempts` increments at claim time and `maxAttempts` defaults to 1, so with default options any app kill mid-task is a *permanent dead-letter*, the exact opposite of what an offline driver queue needs.
6. **No migration system, likely Hermes crash (uuid v9 without a `crypto.getRandomValues` polyfill), no DLQ retry API, timeouts that don't interrupt hung handlers, and an engine loop that dies silently on any storage error.**

The defect list is finite and well understood — this is salvageable with focused work, not a rewrite — but today Endura is a Node-verified prototype of a durable execution engine, not a durable execution engine. The AI-generated polish (clean layering, extensive README, green CI) actively masks the gap between what the abstractions claim and what the persistence layer delivers.

---

## Scope Reviewed

**Repositories inspected:**

- `~/github/endura` — full source (`src/core/**`, `src/storage/**`, `src/environmental/expo/**`, `src/react/**`, `src/testing/**`), all 17 test files (266 tests, executed), `dist/` output format, `package.json`/`tsconfig.json`/`vitest.config.mjs`, `.github/workflows/ci.yml`, `.husky/`, README (2,149 lines), `examples/`, git history (40 commits).
- `~/github/driver-app-3` — the system being replaced: `node_modules/@hopdrive/react-native-queue` v2.5.0-rc2 (Queue.js, Worker.js, Database.js), `pipelines/**` (34 pipelines), `utils/{queue,event,recovery,background,network}.ts`, `models/Event.ts`, `app/recovery.tsx`, `app/(user)/jobs/`, `app/(user)/_layout.tsx`, `docs/platform-modernization-rfc.md`.
- Upstream `expo-sqlite` published typings (via unpkg) to verify the `withTransactionAsync` signature.

**Commands executed:** `vitest run` (266/266 pass, ~1.4s), `vitest run --coverage` (82.8% stmts / 72.7% branch), `tsc --noEmit` (clean), `eslint` (0 errors / 37 warnings).

**Not inspectable / unverified:**

- No on-device or simulator execution was performed (no Expo example app exists — both `examples/` directories are "Coming Soon" stubs). All device-runtime findings are code-level analyses verified against upstream API contracts, not observed crashes.
- `~/hopdrive/driver-app-3` (mentioned in the review request) does not exist; the redesign RFC was found at `~/github/driver-app-3/docs/platform-modernization-rfc.md` and used instead.
- Endura is not consumed anywhere in driver-app-3 yet, so there is no integration surface to test.

---

## Current System Comparison

### How the current system works

The driver app's durability today is split across **two hand-synchronized Realm stores**:

1. **The RNQ job store** (`@hopdrive/react-native-queue`, per-user `rnq.realm`): a job is "the work to do right now" and is deleted on success. Claiming happens inside a single Realm write transaction (`getConcurrentJobs`), filtered by per-worker name, priority-desc/created-asc, with a fork-added re-claim of jobs left `active` by a crash (at-least-once, without burning an attempt). Retry is a fixed per-worker minimum gap (`minimumMillisBetweenAttempts`, 5–30s in use) — no exponential backoff. Timeout is a `Promise.race` that fails the attempt but does **not** cancel the worker promise (source of a whole "stale failure" bug class). Lifecycle callbacks (`onStart/onSuccess/onFailure/onFailed/onComplete/onSkipped`) plus a fork-added `isJobRunnable` gate (universally "is the network connected").
2. **The Event ledger** (`Event` rows in the main app Realm): the durable record of a pipeline execution — `{eventId, moveId, type, stage, status: pending|synced|failed|permanently_failed, payload, error}`. This is what the recovery screen, launch-time recovery prompt, and per-move progress UI read. It *outlives* the job.

The pipeline layer (34 pipelines) chains multi-stage work by hand: each stage's worker calls `setStage(eventId, name)` at start and `completeStage(...)` at end, which merges the stage's output into `Event.payload` and enqueues a brand-new RNQ job for the next stage. Recovery (`runRecovery`) re-arms failed events **at their current stage** with the accumulated payload — stage-resume, not restart. An entire compensating machinery has accreted from production incidents: 7-day age gates (the VDW retry storm, ~14.7k events), `recoverable: false` flags (the 627-zombie-app-dump incident), `permanently_failed` classification for server-refused writes (`RowFilterRejectedError`), stale-failure guards, and per-entity enqueue dedup.

### Behaviors that must be preserved (from code + RFC)

| # | Behavior | Endura today |
|---|----------|--------------|
| 1 | At-least-once, whole-activity re-run after crash, **without burning an attempt** | ✗ At-most-once by default (claim-time `attempts++`, `maxAttempts: 1`) |
| 2 | Per-worker FIFO + cross-worker priority bands (3–50 in use) | ✓ `ORDER BY priority DESC, created_at ASC` |
| 3 | Configurable attempts (1–10) with accumulated per-attempt error history | Partial — only last error persisted |
| 4 | Offline gating that holds (not fails) jobs, with skip trace | Partial — `runWhen`/`onSkipped`; skip reasons not persisted; delay hardcoded 30s |
| 5 | Multi-stage chaining with payload accumulation + **stage-resume** recovery | ✓ semantically (merged `state`, frontier task) — but not crash-atomic |
| 6 | Durable execution history that outlives success (drives recovery/progress UI) | ✓ executions persist until purged (retention configurable) |
| 7 | Terminal-failure taxonomy: retriable-exhausted vs `permanently_failed` (non-retryable) | ✗ no retryable/non-retryable distinction |
| 8 | Driver-facing "Force Retry" (DLQ redrive) | ✗ no redrive API — DLQ is acknowledge/purge only |
| 9 | Type-level and entity-level enqueue dedup | ✗ `uniqueKey` is broken and destructive (see Issue C7) |
| 10 | ~25s background window execution sharing one registry with foreground | ✗ two-engine collision (Issue C3); `expo-background-fetch` (deprecated; app already uses `expo-background-task`) |
| 11 | Per-move / per-mobility-run scoped inspection queries | ✗ status-only queries, no metadata scoping or pagination |
| 12 | Manual pause / autoStart controls, idempotent init | Partial — `stop()` exists on engine, but `ExpoWorkflowClient.start()` is an unstoppable `while(true)` |

### What the RFC expects Endura to fix (and whether it does)

- **Two hand-synced stores → one execution record**: ✓ architecturally, Endura's `WorkflowExecution` is exactly this. This is the strongest argument for the approach.
- **Atomic enqueue with domain writes** (RFC §8: `command()` = domain write + workflow start in one SQLite transaction): ✗ Endura exposes no transaction API; even `start()` alone is two non-atomic writes.
- **Real backoff**: ✓ exponential backoff, persisted `scheduledFor` (no jitter).
- **Timeout that cancels work**: Partial — cooperative `ctx.signal` is the right design, but a handler that ignores it wedges the entire engine (worse than RNQ, which at least kept processing).
- **One registry for foreground + background**: ✗ the two-engine model makes background execution actively dangerous rather than merely incomplete.

---

## Architecture Assessment

**Core abstractions:** `Workflow` (named, ordered `activities[]`, lifecycle callbacks) → `WorkflowExecution` (persisted instance with `currentActivityIndex`, accumulated `state`) → `ActivityTask` (persisted per-step attempt record) → `DeadLetterRecord`. Pluggable `Storage`, `Clock`, `Scheduler`, `Environment` via DI. A workflow is a strictly linear array executed by cursor — no DAG, no branching, no parallelism.

**Strengths:**

- The layering is genuinely clean: engine logic is storage-agnostic, time is injected (testable), the environment abstraction (network/battery for `runWhen` conditions) maps well to the driver app's `isJobRunnable` pattern.
- The linear-workflow model matches the driver app's actual pipelines (all 34 are linear stage sequences) — it is *not* over-abstract relative to the real use case.
- Collapsing RNQ-job + Event-ledger into one execution record is the correct architectural response to the RFC's #1 complaint.
- The README is honest: at-least-once is stated explicitly, idempotency is demanded of activities, no exactly-once claims.

**Weaknesses:**

- **The `Storage` interface hides transactions from the engine.** `transaction()` exists only privately inside `SQLiteStorage` (used once, for claim). The engine's multi-write sequences (`start`, `handleTaskSuccess`→`advanceWorkflow`, permanent failure→DLQ→execution-fail) cannot be atomic through this interface. This is the single most load-bearing design flaw — durability was designed at the object level, not the write-boundary level.
- **The state machine is implicit and unenforced.** Transitions are scattered `status:` field assignments persisted via blind `INSERT OR REPLACE`; `advanceWorkflow` never re-checks execution status, so a cancelled or failed execution can be advanced back to `completed` (verified: `WorkflowEngine.ts:575-644` spreads the stale execution).
- **Nothing identifies which engine owns a running task** — no lease, owner, or heartbeat column. Combined with recovery-on-every-create, multi-instance operation is unsafe by design, yet multi-instance (foreground + background wake) is the advertised deployment.
- **Registration is in-memory and unversioned.** An activity name missing from the registry permanently dead-letters the task (`WorkflowEngine.ts:424-429`); a changed activity list meets a persisted `currentActivityIndex` with no guard. App upgrades with in-flight workflows are unprotected.
- **Two divergent run loops**: `WorkflowEngine.run()` (stoppable, deadline-aware) vs `ExpoWorkflowClient.start()` (a `while(true)` reimplementation with no stop path, using `Date.now()` instead of the injected clock).

**Elegant but fragile:** the whole package pattern-matches Temporal's vocabulary (activities, workflows, `startToCloseTimeout`, backoff coefficients) without the underpinnings (event-sourced history, task leases, deterministic replay) that make Temporal's guarantees real. The vocabulary creates an expectation of durability the implementation doesn't meet.

---

## Persistence Assessment

**Library:** `expo-sqlite` (modern async API: `openDatabaseAsync`/`runAsync`/`getAllAsync`) behind a 3-method `SQLiteDriver` interface; `better-sqlite3` for Node tests; `InMemoryStorage` for unit tests.

**Schema (`schema.ts`):** three tables (`executions`, `activity_tasks`, `dead_letters`) with appropriate indexes — including a partial index exactly matching the pending-task poll query. JSON payloads as TEXT. Reasonable shape, two gaps: no lease/owner columns on tasks (root cause of the concurrency defects), and the unique index on `(workflow_name, unique_key)` is not scoped to running executions (root cause of destructive dedup, Issue C7).

**Fatal driver bug (C1):** `ExpoSqliteDriver` hand-declares `withTransactionAsync<T>(fn: () => Promise<T>): Promise<T>` (`ExpoSqliteDriver.ts:16`) — but the real expo-sqlite API is `withTransactionAsync(task: () => Promise<void>): Promise<void>` (verified against published typings). The self-authored interface hides the mismatch from the compiler. On device, `claimActivityTask` returns `undefined`, `processTask` treats the task as already claimed, and the task — already flipped to `active` inside the transaction — never executes. **The persistence layer cannot process work on the only driver that ships to production.**

**Transactions (C2/C4):** the only transactional operation is claim, and:
- The test driver's `transaction()` is a no-op (`BetterSqlite3Driver.ts:61-66`, comment: *"Real transactions would need proper BEGIN/COMMIT/ROLLBACK"*). Every atomicity property in the test suite is untested.
- The claim itself is SELECT-then-UPDATE with **no `WHERE status='pending'` guard on the UPDATE and no `changes` check** — not a compare-and-set. On device, `withTransactionAsync` opens a DEFERRED transaction, so two connections can both pass the SELECT.
- Everything else — enqueue (execution + first task), success + advance + next-task, retry increment, permanent-fail + DLQ + execution-fail — is a sequence of independent writes with crash windows between each.

**Migrations (C8):** `SCHEMA_VERSION = 1` is written to a `schema_meta` table and **never read back**. No `PRAGMA user_version`, no migration runner, no migration test. Schema evolution is limited to `CREATE ... IF NOT EXISTS` — you cannot add a column, change a CHECK constraint, or backfill. Payloads are raw `JSON.parse` with no versioning; a corrupt or shape-changed row throws inside the poll loop and (because the loop has no error handling) kills the engine — a single poison row halts the entire queue.

**Connection pragmas (H4):** no `journal_mode=WAL`, no `busy_timeout`, no `foreign_keys=ON`. WAL and busy-timeout matter precisely because the design opens two connections to one file; without them the second connection surfaces `SQLITE_BUSY`, which the unprotected engine loop turns into silent engine death. With `foreign_keys` off, the schema's `ON DELETE CASCADE` does nothing — `deleteExecution` orphans task rows.

**What Realm provided that this loses:** the RNQ fork's claim ran inside a single Realm write transaction (genuinely atomic), Realm change listeners powered the reactive jobs UI, and schemaVersion-based migration existed. Endura currently regresses on all three (its `Storage.subscribe` reactivity exists but is unused — hooks poll with `JSON.stringify` diffing).

---

## Job Lifecycle Assessment

**States:** Execution: `running → completed | failed | cancelled`. Task: `pending → active → completed | failed` (+ `skipped` in the enum, though skipped tasks are actually re-saved as `pending`).

**Documented lifecycle (as implemented):**

1. `start()` → execution row (`running`) + first task (`pending`) — two writes, non-atomic; crash between them = orphan execution.
2. `tick()` polls ≤10 pending tasks (priority DESC, created ASC), processes **sequentially**.
3. Claim (increments `attempts`, sets `active`) → `runWhen` gate (skip = re-pend +30s hardcoded, attempts decremented) → execute with `AbortSignal` + in-memory timeout.
4. Success → task `completed` + result → execution `state` merged, cursor +1 → next task scheduled (three writes, non-atomic — the critical crash window).
5. Failure → retry with persisted exponential backoff while `attempts < maxAttempts`, else task `failed` + DLQ insert + execution `failed` (multiple writes, non-atomic).
6. Startup recovery: all `active` tasks → re-pend, or permanent-fail if attempts exhausted.

**Evaluation:**

- Invalid transitions are not prevented anywhere; terminal states are not sticky (`advanceWorkflow` and `handleTaskFailure` both resurrect terminal/cancelled executions in race windows).
- Retryable vs non-retryable failure is not modeled — the driver app's `RowFilterRejectedError → permanently_failed` taxonomy (5 workers depend on it) cannot be expressed.
- Retry delay/backoff **is** durable and deterministic (persisted `scheduledFor`) — genuinely better than RNQ's fixed gap.
- Attempt history: only the last error/stack is kept on the task; RNQ accumulated `errors[]`, and `markEventAsFailed` + Sentry context depend on that today.
- The `attempts`-at-claim + `maxAttempts:1` default makes the *default* lifecycle at-most-once (crash = dead-letter). The recovery path cannot distinguish "crashed while running" from "failed N times."
- Dead letter exists and is queryable, but there is no redrive — terminal means terminal short of manual DB writes.
- Job output is persisted (task `result` + merged execution `state`) and consumable by later steps ✓ — but `state` is an unbounded, rewritten-every-step JSON blob (a base64 photo in an output bloats every subsequent write).

---

## Pipeline Assessment

**What the old pipeline system provides → Endura's answer:**

| Old behavior | Endura | Notes |
|---|---|---|
| Ordered stages with per-stage jobs | ✓ activities array, per-activity tasks | cleaner: no `init(pipeline)` back-pointer dance, no hand-rolled `completeStage` |
| Stage output → accumulated payload → next stage input | ✓ `mergeState` into `execution.state` | flat, last-writer-wins, untyped (matches today's flat-payload convention) |
| Resume from current stage after failure/crash | ✓ in principle (frontier task at `currentActivityIndex`) | ✗ in practice: non-atomic handoff can strand the workflow between stages permanently |
| Retry individual step independently | ✓ per-activity retry config | |
| Retry whole pipeline (Force Retry) | ✗ | no DLQ redrive; execution already `failed` |
| Pipeline inspection/debugging | Partial | `getExecution(s)`, DLQ getters; no scoped queries (per-move), no pagination, hooks poll |
| `pipeline.onComplete`, terminal `onFailed` | ✓ workflow-level callbacks | in-memory only — fire on whichever engine instance happens to advance the workflow |
| Enqueue dedup (`hasPendingEventAlready`, per-entity keys) | ✗ | `uniqueKey` is racy and **destructive** (C7): reusing a completed key silently REPLACEs (deletes) the prior execution row |
| `permanently_failed` vs `failed` | ✗ | needs a NonRetryable error class |
| Event ledger history for UI | ✓ | executions persist until `cleanup` purge — retention must be configured deliberately |
| Enqueue-time payload enrichment | ✓ | caller builds input before `start()` |

**Semantic mismatches to flag explicitly:**

1. **Recovery contract**: driver-app recovery re-arms *at the failed stage with accumulated payload*. Endura's crash recovery re-runs the *in-flight activity* (compatible) — but its permanent-failure path fails the *whole workflow* with no stage-level redrive, which is a regression against `runRecovery`'s per-stage re-arm.
2. **`eventId` as domain key**: photos use the pipeline's eventId as the `VehiclePhoto` primary key for server reconciliation. Endura generates `runId` internally with no way to supply one; workflows would need the domain key carried in input (workable, but the reconciliation code must change).
3. **Skip semantics**: RNQ persists `skippedAttempts`/`skippedReasons` on the job (surfaced in the jobs UI). Endura fires `onSkipped` but persists nothing about the skip.
4. **Attempt error history**: `markEventAsFailed`'s error text and Sentry `PipelineFailure` context are built from RNQ's accumulated `errors[]`; Endura keeps only the last error.

---

## Reliability Assessment

**Execution semantics:** at-least-once *only when* `maxAttempts > 1`; at-most-once by default (C5). No exactly-once claims (correctly). Idempotent activities are assumed and documented — consistent with the driver app's existing contract.

### Production scenario scorecard

| # | Scenario | Verdict | Why |
|---|----------|---------|-----|
| 1 | App killed while a job is running | **✗ (defaults) / Partial (retries configured)** | claim-time `attempts++` + `maxAttempts:1` → permanent DLQ; with retries, re-runs at-least-once |
| 2 | App restarts after crash | Partial | `active` tasks recovered; orphaned frontier (see #5) never repaired |
| 3 | Device goes offline mid-job | Partial | in-flight activity fails/retries with backoff; `runWhen: whenConnected` holds future work (30s poll, hardcoded) |
| 4 | Back online with a large backlog | Partial | drains serially, ≤10/batch; one slow handler stalls everything; no cross-workflow concurrency |
| 5 | Job succeeds locally, crash before success persisted | **✗** | task re-runs (fine, idempotency) — but crash *between* the three success writes strands the workflow `running` with no task, permanently |
| 6 | Retries exhausted | ✓ | DLQ + workflow `failed`; but no redrive path |
| 7 | Handler throws synchronously | ✓ | caught, funneled to failure handling |
| 8 | Handler rejects asynchronously | ✓ | same path |
| 9 | Job hangs / takes too long | **✗** | timeout only aborts a signal the handler may ignore; no `Promise.race`; serial loop → **entire engine wedges** |
| 10 | Multiple processors started accidentally | **✗** | no cross-instance guard; `isRunning` is per-instance memory |
| 11 | Same job claimed twice | **✗** | SELECT-then-unguarded-UPDATE; DEFERRED transactions on device; no-op transactions in tests |
| 12 | Job ordering matters | Partial | priority + FIFO within one engine; no guarantee across two engines |
| 13 | Pipeline step ordering | ✓ | linear cursor, single frontier task |
| 14 | Later step consumes earlier output | ✓ | merged `state` (untyped, non-atomic persist) |
| 15 | Migration on device with existing data | **✗** | no migration system (version written, never read) |
| 16 | SQLite writes fail / interrupted | **✗** | no error handling in loop (engine dies), no rollback of multi-write sequences, no busy_timeout |
| 17 | App upgraded while jobs pending | **✗** | unregistered activity → instant permanent DLQ; changed activity list vs persisted index → silent corruption |
| 18 | Queue data corrupted / partially written | **✗** | raw `JSON.parse` in row mappers; one poison row kills the poll loop |
| 19 | Payload schema changes between versions | **✗** | no payload versioning/validation |
| 20 | Background wake while foreground active | **✗** | second engine's startup recovery resets foreground's in-flight task → deterministic double execution or false permanent failure; on-device claim not atomic |

**Real-world failure narratives:**

- *Driver in a dead zone finishes a move; app backgrounded; OS background-fetch fires.* The background engine boots, "recovers" the foreground's active `moveStatusSync` task to `pending`, both engines run it. Best case: duplicate server write absorbed by idempotency, one attempt burned. Worst case (defaults): recovery dead-letters it and the move status silently never syncs — a "Needs Attention" incident with no needs-attention UI to catch it.
- *App killed between stage 2 and stage 3 of the photo pipeline.* Task 2 is `completed`, execution still points at index 1, no task exists. The workflow shows `running` forever; no recovery pass will ever touch it; the photo never uploads and nothing ever reports failure. This is *worse* than today's system, whose Event ledger + recovery sweep would re-arm the stage.
- *One `SQLITE_BUSY` during a tick* (made likely by the two-connection, no-WAL design): the exception propagates through `tick()` → `run()` and the engine stops. Silent. The queue looks "paused" until the next app restart.

---

## Test Coverage Assessment

**Framework:** Vitest 4 (Node 20), coverage-v8 with enforced thresholds (80/70/80/80), CI on GitHub Actions (typecheck → lint → test:coverage).

**Result:** 266/266 pass in ~1.4s. Coverage 82.8% statements — but the global number hides the operative fact: **`ExpoSqliteDriver.ts` is at 0%**, and every SQLite test runs against better-sqlite3 `:memory:` behind the no-op transaction wrapper.

**What's genuinely good:** these are behavior tests, not mock theater. They drive the real engine over real (in-memory or `:memory:`-SQLite) storage with injected clocks and assert state transitions, retry counts, callback ordering, abort-signal propagation. The lifecycle suite really does plant an `active` task, build a new engine over the same storage, and assert crash-recovery behavior — engine *logic* is well proven.

**What's structurally untested (the exact places the defects live):**

1. **The production driver, at all.** No test imports `ExpoSqliteDriver`. A one-line test double matching expo-sqlite's real `Promise<void>` transaction contract would have caught C1 instantly.
2. **Durability across a process boundary.** "CrashRecovery" integration tests run on `InMemoryStorage` (a variable held in scope). No test writes a SQLite *file*, closes, reopens, recovers.
3. **Atomicity of anything** — impossible by construction with a no-op transaction wrapper.
4. **Two engines / double-claim** — every concurrency test uses one engine; the in-process guard passes because JS is single-threaded across the InMemory check-and-set.
5. **Migrations with existing data, payload shape changes, poison rows, backlog ordering >10, storage-error resilience.**
6. Timing suites use real `setTimeout` sleeps in the harness (`runToCompletion` polls wall-clock) — a flake risk under CI load, and a sign the injected-clock seam isn't followed through.

**Verdict:** the suite would catch regressions in engine logic and would catch essentially none of the eight Critical issues in this review. Green CI here is actively misleading about production readiness.

---

## Code Organization Assessment

**Good:** module boundaries are clear (`core` / `storage` / `environmental` / `react` / `testing`), names are accurate, files are small, no circular dependencies observed, the driver interface is a clean seam, TypeScript is strict (`noUncheckedIndexedAccess` etc.), README/code drift is low for the core API.

**AI-generation risk signals (all verified, not vibes):**

- **Facade-complete, function-absent implementations:** `BetterSqlite3Driver.transaction` (admitted no-op), `deleteUniqueKey` (empty function), `setUniqueKey` (never writes; ignores its `runId` param), `afterDelay` (returns a `retryInMs` the engine never reads — a published API that silently does nothing), `runBackgroundWorkflowTask` (`onComplete?.(0)` with `// TODO: track actual processed count`, always returns `NewData` — which degrades iOS fetch-budget scheduling when idle).
- **Hand-authored typings for a dependency** (`ExpoSqliteDatabase` interface) that contradict the real API — the exact mechanism that hid the fatal C1 bug from the compiler.
- **Test doubles shipped in `src/core/mocks` and re-exported from the package root** (a `testing/` entry point also exists — the mocks are duplicated conceptually).
- **Two run loops** (engine vs Expo client) with divergent semantics; the client one leaks a never-cleared 1Hz `setInterval` per `ExpoEnvironment` construction (one per background wake) and has no stop path.
- **Dead/misfiring branches:** the DDL routing in both drivers checks `startsWith('CREATE')` but schema statements begin with `-- comments`, so the branch never fires and DDL flows through the parameterized path (works by luck).
- Built in essentially **one day** (2026-01-04, phased "Phase 0…Phase 7" commits, single author + Claude committer), no issue-driven bugfix history, no production burn-in.

Maintainability by non-authors is decent *at the file level* — the danger is that the code reads as more finished than it is.

---

## Developer Experience Assessment

**Good:** the public API is small and discoverable (`defineWorkflow`/`defineActivity`/`WorkflowEngine.create`/`start`); the 2,149-line README is well-written, honest about at-least-once semantics, and its import paths all resolve; TypeScript types are helpful at the top level; DI makes downstream testing genuinely easy (the `testing` entry point with mock clock/scheduler is a real DX asset few queue libraries have).

**Gaps:**

- **Both example apps are "Coming Soon" stubs.** For a library whose entire value is a nontrivial RN integration, there is no runnable proof — which is precisely why C1 survived.
- **No DLQ redrive / no manual retry.** The driver app's Force Retry UX cannot be built on the current API.
- **Inspection is status-only**: no `getAllExecutions`, no pagination, no metadata/scoped queries (per-move), no persisted skip reasons — the recovery screen and jobs screen would lose fidelity versus today.
- **Docs drift where it matters most:** the `background.ts` docstring calls `registerBackgroundTask()` with no arguments; the real signature requires `registerTaskAsync` as the first parameter. The one example future integrators will copy-paste doesn't compile.
- Step-to-step typing is `any` (workflows hold `Activity<any,any>[]`); `useWorkflowStarter` double-casts through `as any`; a handler returning a non-object is silently dropped by `mergeState`.
- Reactive `Storage.subscribe` exists in both adapters but hooks poll on intervals with `JSON.stringify` diffing instead.

---

## React Native Readiness

- **`uuid` v9 requires `crypto.getRandomValues`; no polyfill is depended on or documented.** On Hermes, the first `generateId()` (every `start()`) throws. Trivial fix (`expo-crypto` / `react-native-get-random-values`), but as shipped the package likely crashes on first use — masked in Node tests where webcrypto exists.
- **expo-sqlite integration is untested and broken** (C1 above). Peer dep floor `expo-sqlite >=13` is wrong — the async API used requires ~v14 (SDK 51+).
- **Background integration targets `expo-background-fetch`, which Expo deprecated in favor of `expo-background-task`** — driver-app-3 already uses `expo-background-task`, so Endura is behind its own consumer.
- **Packaging mismatch:** `dist/` is CommonJS (`module: "commonjs"`) but the exports map declares only `"import"` + `"types"` conditions — no `"require"`, no `"default"`, no `"react-native"`. Metro with package-exports enabled (default in current Expo) will resolve `"import"` to CJS files and cope, but it's semantically wrong and fragile across toolchain versions; Node ESM/CJS consumers break outright. No `sideEffects` flag.
- **iOS/Android window handling** is designed for (25s lifespan + 500ms buffer, deadline checked between tasks) — reasonable — but the deadline is only checked between tasks, so a 25s-timeout task claimed near the deadline overruns the OS window.
- Foreground/background *transitions* are unhandled: nothing pauses the engine on background, nothing coordinates the two-engine collision (C3).
- Memory: `execution.state` accumulation + `ExpoEnvironment` interval leak per wake are the notable concerns; no other Node builtins leak into core (verified).

**Net:** this package has demonstrably never executed on the runtime it is named for ("Durable execution for React Native").

---

## Issue Catalog

| ID | Severity | Area | Finding | Evidence | Production Risk | Recommendation |
|----|----------|------|---------|----------|-----------------|----------------|
| C1 | Critical | SQLite/Expo | `ExpoSqliteDriver.transaction` assumes `withTransactionAsync` returns the callback's value; real API returns `Promise<void>`. `claimActivityTask` → `undefined` on device while the UPDATE still marks the task `active` | `ExpoSqliteDriver.ts:12-18,77-79`; expo-sqlite published typings (`withTransactionAsync(task: () => Promise<void>): Promise<void>`); `SQLiteStorage.ts:349-388`; `WorkflowEngine.ts:419-421` | **No task ever executes on device; every pending task stranded `active`** | Have `transaction()` capture the callback's result in a closure and return it; add a driver-contract test whose double mirrors expo's real `Promise<void>` signature; stop hand-authoring dependency typings — import them |
| C2 | Critical | Durability | Step success → execution advance → next-task scheduling are 3 separate writes with no transaction; `start()` similarly 2 writes; recovery only scans `active` tasks | `WorkflowEngine.ts:527-652,210-213`; `Storage` interface exposes no transaction | Crash in the window strands workflow `running` with no task, **permanently and silently** (worse than RNQ today) | Add `Storage.transaction(fn)` to the interface; wrap all multi-write sequences; add a reconciliation pass for `running` executions with no pending/active task |
| C3 | Critical | Concurrency | Every `WorkflowEngine.create()` unconditionally resets ALL `active` tasks; background wake creates a second engine over the same DB | `WorkflowEngine.ts:80-115`; `background.ts:124-157`; `ExpoWorkflowClient.ts:100-118`; no owner/lease columns in `schema.ts` | Deterministic duplicate execution, or false permanent failure of the foreground's in-flight task, on every background wake | Add `owner_id` + `lease_expires_at` columns; recovery reclaims only expired leases; heartbeat long tasks. Interim: never run the background engine (foreground-only pilot) |
| C4 | Critical | Concurrency | Claim is SELECT-then-UPDATE with no `status='pending'` guard on the UPDATE and no `changes` check; test driver's transaction is a no-op; device transaction is DEFERRED | `SQLiteStorage.ts:349-388`; `BetterSqlite3Driver.ts:61-66` | Double-claim across connections/instances; all test-suite atomicity claims are vacuous | Single atomic `UPDATE … SET status='active' … WHERE task_id=? AND status='pending'`, treat `changes===0` as lost race; implement real BEGIN IMMEDIATE/COMMIT in both drivers |
| C5 | Critical | Lifecycle | `attempts` incremented at claim; `maxAttempts` defaults to 1 → app kill mid-task = permanent dead-letter with default config | `SQLiteStorage.ts:366-369`; `WorkflowEngine.ts:33,101-103` | Default behavior is at-most-once: crashes permanently fail ordinary offline work | Track claim-count separately from failure-count (crash recovery shouldn't burn an attempt — RNQ's fork got this right); raise default `maxAttempts` |
| C6 | Critical | RN runtime | `uuid` v9 needs `crypto.getRandomValues`; no polyfill dep or docs; called on every `start()`/schedule | `utils.ts:5-12`; `package.json` deps; README (no mention) | Likely hard crash on first workflow start on Hermes | Use `expo-crypto`'s `randomUUID` (or require/document `react-native-get-random-values`) |
| C7 | Critical | Dedup | `setUniqueKey` is a racy read-only check that never writes; `deleteUniqueKey` is empty; unique index isn't scoped to `status='running'`; `saveExecution`'s `INSERT OR REPLACE` on key conflict silently deletes the prior execution row | `SQLiteStorage.ts:197-228,132-152`; `schema.ts:31-32,53` | Reusing a completed key (or racing two starts) **destroys prior execution history**; dedup fails under exactly the concurrent-enqueue conditions it exists for | Partial unique index `WHERE status='running'`; atomic INSERT-based reservation; never `INSERT OR REPLACE` executions (use UPDATE for existing rows) |
| C8 | Critical | Migrations | Schema version written to `schema_meta`, never read; no migration runner; no `PRAGMA user_version`; no migration tests | `SQLiteStorage.ts:34-52`; `schema.ts:103` | First schema change after adoption has no upgrade path for devices holding queued jobs | `PRAGMA user_version`-based versioned, transactional migration runner + tests against populated fixture DBs, before v0.2 |
| H1 | High | Timeouts | Timeout only aborts an `AbortSignal`; `await activity.execute()` is not raced; engine loop is serial | `WorkflowEngine.ts:470-499,392-410` | One handler that ignores `ctx.signal` (any hung native call) wedges the entire queue forever | `Promise.race` execute vs abort; mark timed-out task failed; guard late completion (stale-success check — the driver app already learned this lesson, `utils/event.ts:571-592`) |
| H2 | High | Reliability | No try/catch in `tick()`/`run()` around storage ops; any storage throw (`SQLITE_BUSY`, poison row) kills the loop | `WorkflowEngine.ts:355-410` | Transient DB contention silently stops all processing until next app restart | Catch per-task and per-tick, log, continue; surface engine-health events |
| H3 | High | Cancellation | `advanceWorkflow`/`handleTaskFailure` never re-check execution status; cancelled/failed executions can be advanced or their deleted tasks re-created via `INSERT OR REPLACE` | `WorkflowEngine.ts:575-652,657-700,279-333` | Cancelled workflows resurrect and complete; terminal states not sticky | Re-read status inside the (new) transaction before advancing; make terminal states sticky; guard task re-save on status |
| H4 | High | SQLite | No `journal_mode=WAL`, `busy_timeout`, or `foreign_keys=ON` | `ExpoSqliteDriver.ts:51-83`; `SQLiteStorage.initialize` | `SQLITE_BUSY` under the two-connection design (→ H2); `ON DELETE CASCADE` silently inert → orphaned task rows | Set pragmas on open; keep manual task deletion as belt-and-braces |
| H5 | High | DLQ | No redrive/requeue API (get/acknowledge/purge only); permanent failure also fails the whole workflow | `WorkflowEngine.ts:852-878,705-797` | Driver-app "Force Retry" (recovery screen contract) cannot be built | `retryFromDeadLetter(id)` that re-pends the task at its stage and re-opens the execution (RFC explicitly expects this) |
| H6 | High | Conditions | Engine ignores `retryInMs`; skip reschedule hardcoded 30s; `afterDelay` is a silent no-op | `WorkflowEngine.ts:809-823`; `conditions.ts:37-43` | Published API does nothing; offline-hold cadence untunable | Honor `retryInMs`; implement or delete `afterDelay` |
| H7 | High | Upgrades | Unregistered activity → immediate permanent DLQ; no guard between persisted `currentActivityIndex` and a changed activity list | `WorkflowEngine.ts:424-429,581-592` | App update with renamed/reordered activities nukes or corrupts every in-flight workflow (exact repeat of the driver app's EWZ/W0P/VD4 unmapped-stage incident class) | Persist activity name with cursor and match by name; treat unknown activity as "held", not failed; add workflow definition versioning |
| H8 | High | Expo adapter | `ExpoWorkflowClient.start()` is `while(true)` with no stop path; `ExpoEnvironment` leaks a never-cleared 1Hz `setInterval` per instance (one per background wake); `runBackgroundWorkflowTask` always reports `NewData` | `ExpoWorkflowClient.ts:128-164`; `ExpoEnvironment.ts:87-95`; `background.ts:150-152` | Unstoppable foreground loop; timer leak per wake; degraded iOS fetch scheduling | Delegate to `engine.run()`/`stop()`; add `environment.dispose()` in `close()`; return honest fetch results |
| H9 | High | Packaging | CJS dist behind an `"import"`-only exports map; no `"require"`/`"default"`/`"react-native"` conditions; `expo-background-fetch` (deprecated) targeted; peer floor `expo-sqlite>=13` too low | `package.json:7-40`; `tsconfig.json`; `dist/index.js`; `background.ts` | Resolution breakage across Metro/Node toolchain versions; behind consumer's own background stack (driver-app-3 already uses `expo-background-task`) | Dual build or align conditions with emitted format; add `react-native` condition; migrate to `expo-background-task`; fix peer range |
| H10 | High | Corruption | Row mappers `JSON.parse` unguarded inside the poll query path | `SQLiteStorage.ts:76-77,96-97,333-347` | One corrupt/legacy row = poison pill that (with H2) halts the whole queue permanently | Try/catch per row; quarantine unparseable rows to DLQ |
| M1 | Medium | Lifecycle | No retryable vs non-retryable error modeling | `WorkflowEngine.ts:657-700` | Driver app's `RowFilterRejectedError → permanently_failed` taxonomy inexpressible; retry storms on permanent server refusals | `NonRetryableError` class (or classifier hook) → straight to DLQ with distinct flag |
| M2 | Medium | Observability | Only last error persisted per task (RNQ accumulated `errors[]`); skip reasons not persisted | `WorkflowEngine.ts:680-688`; schema | Sentry `PipelineFailure` context and jobs-UI fidelity regress | Attempt-history table or JSON error log column; persist skip reasons |
| M3 | Medium | Persistence | `execution.state` accumulates all outputs and is rewritten every advance | `utils.ts:49-57`; `WorkflowEngine.ts:588,642` | Large outputs (photo data) bloat every subsequent write; slow ticks | Document "small outputs" contract; consider per-task result references |
| M4 | Medium | Storage parity | InMemory vs SQLite uniqueness semantics diverge (active map vs index-based) | `InMemoryStorage.ts:79-93` vs `SQLiteStorage.ts:197-228` | Tests pass on one backend, behavior differs on device | Shared storage-contract test suite run against all three backends |
| M5 | Medium | API surface | Mocks shipped in `src/core/mocks`, re-exported from package root; `getPendingActivityTasks` defaults to `Date.now()` bypassing injected Clock | `src/core/mocks/`; `SQLiteStorage.ts:334` | Test doubles in prod bundle; determinism seam inconsistent | Move mocks under `testing/`; always pass `now` |
| M6 | Medium | Inspection | Status-only execution queries; no pagination, metadata scoping, or reactive wiring (hooks poll with `JSON.stringify` diff at 500ms–5s) | `react/hooks.ts:58-69`; `SQLiteStorage.ts:171-178` | Recovery screen (per-move grouping) and jobs screen can't be rebuilt at parity; battery cost | Metadata/scope column + indexed queries; wire `Storage.subscribe` into hooks |
| M7 | Medium | Tests | Wall-clock sleeps in test harness; branch coverage 72.7% vs 70% floor; CI never runs `npm run build`; "coverage check" CI step only echoes | `testHelpers.ts:138-166`; `ci.yml` | Flakes under CI load; emit breakage undetected until publish | Fake timers in harness; add build step to CI |
| L1 | Low | Docs | `background.ts` header example calls `registerBackgroundTask()` without the required first arg; examples are empty stubs | `background.ts:19-33`; `examples/*/README.md` | Copy-paste integration fails; no runnable reference | Fix docstring; ship a real Expo example app (this is also the device-smoke vehicle) |
| L2 | Low | Packaging | No `sideEffects` flag; `dist/` gitignored (npm-only distribution) — note for the team's file-link E2E workflow | `package.json`; `.gitignore` | No tree-shaking; git-checkout consumers must build first | Add `sideEffects: false`; document local-link build step |
| L3 | Low | Drivers | DDL routing (`startsWith('CREATE')`) never matches because schema statements begin with `--` comments; works by accident | `ExpoSqliteDriver.ts:62-66`; `schema.ts:9-11`; `BetterSqlite3Driver.ts:47-52` | Latent breakage if a future DDL statement actually needs `execAsync` | Strip comments in `getSchemaStatements()` or route by parsed statement type |
| L4 | Low | Types | Step-to-step typing is `any`; `as any` casts in hooks; non-object handler returns silently dropped | `core/types.ts:242,263`; `hooks.ts:253`; `utils.ts:53` | Type errors surface at runtime as missing state keys | Typed step chaining (even a helper-level solution); warn on dropped returns |

---

## Missing Tests

Prioritized; each would have caught a Critical/High issue above.

1. **Expo driver contract test** — *Scenario:* run `SQLiteStorage` against a driver double whose `withTransactionAsync` matches expo-sqlite's real `Promise<void>` signature; claim a task and assert the claimed task object is returned and the task executes. *Why:* would have caught C1 (total on-device failure) in seconds. *Expected:* claim returns the task; no stranded `active` rows. *Type:* unit/contract.
2. **On-disk crash/restart durability** — *Scenario:* file-backed better-sqlite3 DB; enqueue, run one step, close everything, reopen with a fresh engine + fresh storage over the same file; assert recovery and completion. *Why:* current "CrashRecovery" tests never leave process memory. *Expected:* workflow resumes at the correct stage. *Type:* integration (crash/restart simulation).
3. **Crash-window handoff (fault injection)** — *Scenario:* storage wrapper that throws/halts after (a) task-completed write, (b) execution-advance write; restart engine; assert the workflow is repaired, not stranded. *Why:* C2 — currently strands permanently. *Expected:* reconciliation pass reschedules the frontier task. *Type:* integration.
4. **Two-engine double-claim race** — *Scenario:* two `SQLiteStorage` instances over one WAL-mode file (two connections), both ticking; N tasks. *Why:* C3/C4 — the intended production deployment. *Expected:* each task executes exactly once; second engine's startup must not reset the first's live task. *Type:* integration (real SQLite, real transactions).
5. **Crash-recovery attempt accounting** — *Scenario:* task `active` at "crash" with `maxAttempts: 1` (default); restart. *Why:* C5 — currently dead-letters. *Expected (after fix):* crash recovery re-runs without burning an attempt. *Type:* unit.
6. **uniqueKey reuse and race** — *Scenario:* complete a workflow with key K, start a new one with K; also two concurrent `start()` with K. *Why:* C7 — currently deletes the completed execution's row silently. *Expected:* history preserved; exactly one of the racers wins. *Type:* integration.
7. **Migration with populated DB** — *Scenario:* open a fixture DB created at schema v1 containing pending/active/failed rows with a v2 package. *Why:* C8. *Expected:* versioned migration runs transactionally; data intact. *Type:* migration.
8. **Hung handler** — *Scenario:* activity returning a never-settling promise, `timeout: 100`, plus other queued tasks. *Why:* H1 — currently wedges the engine. *Expected:* task failed on timeout; other tasks proceed; late completion does not overwrite the failure. *Type:* unit (fake timers).
9. **Storage-error resilience** — *Scenario:* driver that throws `SQLITE_BUSY` on the Nth call mid-run. *Why:* H2 — currently kills the loop. *Expected:* engine logs, retries/continues. *Type:* unit.
10. **Poison row** — *Scenario:* hand-write a task row with invalid JSON payload; tick. *Why:* H10. *Expected:* row quarantined to DLQ; queue continues. *Type:* integration.
11. **App-upgrade skew** — *Scenario:* persisted execution mid-workflow; re-register workflow with renamed/removed activity. *Why:* H7. *Expected:* held/flagged, not insta-dead-lettered or misexecuted. *Type:* integration.
12. **Backlog ordering and drain** — *Scenario:* 50 tasks across priorities; assert strict priority-then-FIFO completion order and full drain across ticks. *Why:* untested claim-order contract the driver app's priority bands (3–50) depend on. *Type:* unit.
13. **RN runtime smoke test** — *Scenario:* the (to-be-built) Expo example app runs a 3-step workflow on Hermes: start → kill app → relaunch → completes; background wake with foreground open. *Why:* C1/C6/C3 are all invisible to Node. *Expected:* end-to-end completion, no duplicates. *Type:* React Native runtime test (manual or Maestro).

---

## Recommended Remediation Plan

### Phase 1: Must Fix Before Production (blockers — the package does not function on-device without these)

1. **Fix `ExpoSqliteDriver.transaction`** to return the callback's result (capture in closure), import real expo-sqlite types, and add the driver-contract test (C1, missing test #1).
2. **Make claiming a true CAS**: atomic `UPDATE … WHERE status='pending'` + `changes===1`, with real `BEGIN IMMEDIATE` transactions in both drivers (C4).
3. **Expose `Storage.transaction()` to the engine and wrap all multi-write sequences** (`start`, success/advance/schedule, permanent-failure), plus a reconciliation pass for `running` executions with no frontier task (C2).
4. **Ownership/leasing**: `owner_id` + `lease_expires_at` columns; startup recovery reclaims only expired leases; heartbeat for long tasks (C3). Until this lands, the background engine must not be enabled.
5. **Fix attempt accounting**: crash recovery must not burn an attempt (separate claim-count from failure-count); revisit `maxAttempts` default (C5).
6. **UUID source safe for Hermes** (`expo-crypto`) (C6).
7. **Fix uniqueKey**: partial unique index scoped to `status='running'`, atomic reservation, stop `INSERT OR REPLACE` on executions (C7).
8. **Versioned migration runner** (`PRAGMA user_version`, transactional) with populated-fixture tests (C8).
9. **Engine-loop error containment** (H2) and **enforced timeouts via `Promise.race` + stale-success guard** (H1).
10. **Connection pragmas**: WAL, `busy_timeout`, `foreign_keys=ON` (H4).
11. **Build the Expo example app and run the RN smoke test** (missing test #13) — this is the gate proving Phase 1 worked.

### Phase 2: Should Fix Before Broad Adoption

1. DLQ redrive API (`retryFromDeadLetter`) → enables the Force Retry / recovery-screen contract (H5).
2. `NonRetryableError` classification → `permanently_failed` parity (M1).
3. Upgrade-skew safety: match activities by name not index, hold (don't dead-letter) unknown activities, workflow definition versioning (H7).
4. Cancellation status guards; sticky terminal states (H3).
5. Honor `retryInMs`; fix or remove `afterDelay` (H6).
6. Expo adapter hygiene: delegate the client loop to `engine.run()`, dispose the environment interval, honest fetch results, migrate to `expo-background-task` (H8, part of H9).
7. Packaging: exports-map/format alignment, `react-native` condition, correct peer ranges (H9).
8. Poison-row quarantine (H10); attempt/skip history persistence (M2); scoped + reactive inspection APIs (M6); shared storage-contract test suite across all three backends (M4).
9. Two-engine race test, fault-injection tests, migration tests in CI (missing tests #2–#4, #7).

### Phase 3: Nice to Have

Typed step-to-step chaining; `state`-size guardrails/documented output contract (M3); move mocks out of the root export (M5); fake-timer test harness + CI build step (M7); backoff jitter; docs fixes and a second (web) example; `sideEffects` flag; wire `Storage.subscribe` into React hooks with a battery-friendly cadence.

### Phase 4: Driver App Pipeline Parity and Expo Mobile Scenario Gate

Phase 4 proves that Endura can replace the real `driver-app-3` pipeline and queue behavior, not just pass generic workflow engine tests.

The current driver app does not use `@hopdrive/react-native-queue` as a simple background queue. It layers a durable pipeline system on top of RNQ using Realm-backed `Event` rows, worker sequences, per-stage payload accumulation, recovery by persisted stage name, stale-failure guards, permanent-failure classification, per-entity dedupe, and driver-facing recovery flows.

Endura cannot be considered ready for the driver app rewrite until it can reproduce the important behaviors from that system inside the Expo test app.

This phase is a required production gate.

#### Source Implementation to Use as Ground Truth

Use `hopdrive/driver-app-3` as the source of truth for current production behavior.

The review must inspect at least:

* `utils/event.ts`
* `utils/queue.ts`
* `utils/recovery.ts`
* `pipelines/photo/index.ts`
* `pipelines/outcomeSubmit/index.ts`
* `pipelines/outcomeWorkflowDataSync/index.ts`
* `pipelines/offerBundleProcess/index.ts`
* All worker files under `pipelines/**`
* Any existing tests under `__tests__/pipelines/**` and `__tests__/workers/**`
* The HopDrive fork of `@hopdrive/react-native-queue`

Do not rely on README files or architectural assumptions. Extract the behavior from code.

#### Current Driver App Behaviors That Must Be Preserved

The current system has several production behaviors that Endura must either preserve directly or replace with an intentionally documented alternative.

##### 1. Event-backed pipeline state

A pipeline start creates a durable `Event` row with:

* `eventId`
* pipeline type
* current stage name
* status
* payload
* moveId and/or driverId when available

The first worker is then queued through RNQ unless the pipeline asks to run stage one synchronously.

Endura must prove it can represent the same durable execution record and support inspection by move, run, workflow type, status, and current stage.

##### 2. Worker sequence registration

The current pipeline registry registers each worker in the sequence, calls worker `init(pipeline)` when present, records worker display metadata, and stores the pipeline by name.

Endura must prove that all workflow definitions needed by the driver app can be registered centrally and that missing, renamed, or reordered workflow activities are handled safely during app upgrades.

##### 3. Stage-level resume

The current pipeline system does not simply restart an entire pipeline after failure. Recovery reads the failed `Event.stage`, maps that stage name back to the correct worker, and creates a new job for that stage with the accumulated event payload.

Endura must prove that failed or interrupted workflows resume at the correct current activity with the accumulated prior state.

##### 4. Payload accumulation

`completeStage` snapshots the current event payload, merges in additional payload from the finished stage, and passes that accumulated payload into the next queued worker.

Endura must prove that multi-stage workflows can pass stage outputs forward and that restart or recovery does not lose accumulated state.

##### 5. Stale failure protection

The current app has a guard that prevents a late failure from an old job attempt from downgrading an event that has already synced or advanced to another stage.

Endura must prove that late success or late failure from timed-out work cannot overwrite newer execution state.

##### 6. Permanently failed events

The current app distinguishes ordinary `failed` events from `permanently_failed` events. Permanently failed events represent server-refused writes, such as row-filter rejection when a move has been reassigned or deleted. These are excluded from automatic recovery sweeps but remain inspectable so the UI can support a force retry flow.

Endura must implement and prove equivalent behavior.

##### 7. Manual recovery and force retry

The current recovery system supports scoped recovery by move and mobility run. It can reset permanently failed events back to failed so they can be retried after dispatch fixes the underlying issue.

Endura must support the same driver-facing recovery story.

##### 8. Recovery age gate

The current system avoids retry storms by skipping automatically recovered events older than a seven-day window unless a manual flow opts into stale recovery.

Endura must prove it has an equivalent way to prevent old failed work from being re-armed forever.

##### 9. Non-recoverable fire-and-forget pipelines

Some pipelines are explicitly marked non-recoverable because replaying old failed work has no value or creates operational noise. Examples include app dump style operational flows and photo reaper style cleanup flows.

Endura must support an explicit non-recoverable workflow classification.

##### 10. Reconciliation before re-arm

The current recovery path has special handling for photo events. If a photo pipeline failed locally but the corresponding photo is already uploaded or done on the server, recovery marks the event synced instead of re-arming a stale pre-upload stage.

Endura must support workflow-specific recovery reconciliation hooks.

##### 11. Per-entity dedupe

The current system has both type-level and per-entity dedupe. For example, `offerBundleProcess.pipeline` dedupes by `offerId` so repeated refreshes do not queue the same heavy bundle process thousands of times while an earlier attempt is still pending.

Endura must prove its uniqueness model can match this domain-level dedupe without destroying prior execution history.

##### 12. Intentional no-dedupe workflows

Not every workflow should be deduped. `outcomeWorkflowDataSync.pipeline` intentionally allows concurrent enqueues because stage 1 is idempotent and stage 2 merges workflow data. `outcomeSubmit.pipeline` also intentionally avoids dedupe because dropping a submit intent would lose a user action.

Endura must not force a one-size-fits-all uniqueness model. It must support both deduped and intentionally non-deduped workflows.

##### 13. Background and foreground queue behavior

The current queue uses `expo-background-task`, initializes a single RNQ instance with an idempotency backstop, and exposes queue job/state listeners for app UI.

Endura must prove foreground and background execution do not double-claim, reset, or falsely fail the same work.

#### Required Pipeline Parity Inventory

Create a `Driver App Pipeline Parity Inventory` table before implementing scenarios.

For every pipeline under `driver-app-3/pipelines/**`, document:

| Pipeline | Stages | Purpose | Domain Key | Dedup Behavior | Retry / Timeout Behavior | Connectivity Requirement | Recovery Behavior | Endura Scenario |
| -------- | ------ | ------- | ---------- | -------------- | ------------------------ | ------------------------ | ----------------- | --------------- |

Classify each pipeline as:

* `Must Match`: required before Endura can replace the current driver app pipeline system
* `Pilot Match`: required before the first Endura-backed pilot workflow
* `Should Match`: required before broad rollout
* `Nice to Match`: useful coverage but not a blocker
* `Do Not Carry Forward`: old behavior that should intentionally be retired

At minimum, the inventory must include:

* `photo.pipeline`
* `outcomeSubmit.pipeline`
* `outcomeWorkflowDataSync.pipeline`
* `moveStatusSync.pipeline`
* `moveDriverStatusSync.pipeline`
* `moveWorkflowOutputSync.pipeline`
* `driverInfoSync.pipeline`
* `driverStatusSync.pipeline`
* `moveUpdateSync.pipeline`
* `cancelMoveStatusSync.pipeline`
* `deleteNonMatchingMovesSync.pipeline`
* `sendAppDump.pipeline`
* `sendEventLog.pipeline`
* `prioritySyncComplete.pipeline`
* `fuelAuthorizationSync.pipeline`
* `fuelReimbursementSync.pipeline`
* `offerStatusSync.pipeline`
* `certificationComplete.pipeline`
* `certificationSync.pipeline`
* `gpsEventLogSync.pipeline`
* `photoReaper.pipeline`
* `mobilityRunSync.pipeline`
* `mobilityStopSync.pipeline`
* `mobilityVehicleSync.pipeline`
* `serviceOrderSync.pipeline`
* `offerBundleProcess.pipeline`
* `offerMissedAssignments.pipeline`
* any additional pipeline present in the repo

#### Required Expo Mobile Scenarios

Each scenario must run inside the Expo test app against the real Endura SQLite persistence layer.

Node tests are not sufficient for this phase.

Each scenario must provide:

* One-tap reset
* One-tap run
* Simulated online/offline controls
* Failure injection controls
* Restart or reload simulation where possible
* Background wake simulation where possible
* Current execution state
* Current task state
* Dead-letter state
* Structured pass/fail assertions
* Debug log output

##### Scenario 1: Photo Pipeline Parity

Model `photo.pipeline`.

The current photo pipeline sequence is:

1. `photoCapture`
2. `photoResize`
3. `photoBlurHash`
4. `photoPending`
5. `photoUpload`
6. `photoSave`

The scenario must verify:

* The six-stage order is preserved
* Each stage receives accumulated payload from prior stages
* Metadata produced by capture, resize, and blurhash survives through upload and save
* A crash after resize resumes at blurhash
* A crash after pending resumes at upload
* A failed upload can retry without re-running successful prior stages unless explicitly required
* A late failure from an old stage cannot mark the event failed after the workflow advanced
* A successfully uploaded photo can be reconciled as complete instead of re-arming stale local work
* The completed execution remains inspectable by move or service order context

This is the highest-value pilot scenario because photo handling is a real multi-stage workflow with local files, payload accumulation, idempotency risk, and recovery complexity.

##### Scenario 2: Outcome Draft Sync Parity

Model `outcomeWorkflowDataSync.pipeline`.

The current pipeline has two stages:

1. `stage1CreateDraft`
2. `stage2SyncWorkflowData`

The scenario must verify:

* Stage 1 creates or resolves a server-side draft outcome
* Stage 2 receives the draft identity and merges workflow data
* Multiple enqueues for the same local outcome are allowed
* Concurrent or repeated workflow-data syncs converge safely
* No user edits are dropped because a previous sync is already pending
* Recovery resumes from the failed stage with accumulated payload

This scenario proves Endura can support intentionally non-deduped idempotent sync workflows.

##### Scenario 3: Outcome Submit Parity

Model `outcomeSubmit.pipeline`.

The current pipeline has three stages:

1. `stage1CreateDraft`
2. `stage2SyncWorkflowData`
3. `stage3Submit`

The scenario must verify:

* Submit is only triggered by the submit pipeline, not by mid-fill sync
* Draft creation and workflow-data sync happen before submit
* Concurrent submit attempts do not double-submit
* If the submit stage fails, recovery resumes at submit with the prior draft and workflow data intact
* A duplicate submit is handled through domain idempotency or server guard behavior, not by silently dropping the user’s submit intent

This scenario proves Endura can preserve user intent while still preventing duplicate business effects.

##### Scenario 4: Move Sync Permanent Failure

Model a move-related sync pipeline such as:

* `moveStatusSync.pipeline`
* `moveDriverStatusSync.pipeline`
* `moveWorkflowOutputSync.pipeline`

The scenario must verify:

* A normal transient failure retries
* A server-refused write is classified as permanently failed
* Permanently failed work is excluded from automatic recovery
* The failed state remains inspectable by move
* Force Retry can reset it into a retryable state
* Recovery then re-arms the correct stage
* Retry resumes with the original payload and domain key

This scenario is required before Endura can replace move-related sync work.

##### Scenario 5: Recovery Age Gate

Model a failed recoverable event.

The scenario must verify:

* Failed work newer than the recovery window is automatically eligible for recovery
* Failed work older than the recovery window is skipped by automatic recovery
* Manual recovery can opt into stale recovery
* Skipped stale work does not create retry storms
* The skipped reason is visible enough for debugging

Use the current seven-day recovery window as the default parity target unless the team intentionally changes it.

##### Scenario 6: Non-Recoverable Pipeline

Model a fire-and-forget operational workflow such as an app dump or cleanup pipeline.

The scenario must verify:

* The workflow can fail
* The failure is not surfaced as driver-recoverable work
* Automatic recovery does not re-arm it
* The workflow can be cleaned up or superseded by a future fresh run
* The classification is explicit in the workflow definition

This prevents a repeat of zombie operational events appearing in driver recovery screens.

##### Scenario 7: Offer Bundle Per-Entity Dedupe

Model `offerBundleProcess.pipeline`.

The scenario must verify:

* Two enqueue attempts for the same `offerId` while one is pending result in one active workflow
* Enqueues for different `offerId` values both proceed
* Reusing an `offerId` after completion does not destroy prior execution history
* A racing duplicate enqueue cannot create two active workflows for the same offer
* The dedupe decision is visible in the scenario log

This scenario is required because Endura’s uniqueness behavior must match domain-level dedupe, not just generic workflow-name dedupe.

##### Scenario 8: Offline Hold and Resume

Model any sync pipeline that should not run without network.

The scenario must verify:

* Work can be enqueued offline
* The activity is held rather than failed while the device is offline
* Attempts are not burned while the activity is unrunnable
* The hold reason is recorded or visible
* Work resumes automatically when connectivity returns
* Recovery after app restart preserves the held work

Connectivity must be simulated through Endura’s environment abstraction, not by relying on real simulator network toggles alone.

##### Scenario 9: Offline Mid-Stage Failure

Model a workflow that starts online, loses connectivity during a stage, and later resumes.

The scenario must verify:

* The in-flight stage fails, holds, or retries according to explicit policy
* Prior successful stages are not lost
* The failed stage is retried after connectivity returns
* The workflow does not restart from stage one unless that is the intended behavior
* No duplicate downstream side effects occur

##### Scenario 10: Foreground and Background Collision

Model the production case where foreground app processing and background execution overlap.

The scenario must verify:

* Foreground engine claims a long-running task
* Background wake occurs while the task is active
* The background engine does not reset the active task
* The same task is not claimed twice
* Attempts are not falsely exhausted
* The workflow completes once from the app’s perspective
* No duplicate fake-server side effect occurs

This scenario gates any production use of Endura background execution.

##### Scenario 11: Stale Success and Stale Failure

Model the timeout class already handled in the current driver app.

The scenario must verify:

* A handler times out but continues running
* A retry starts or the workflow advances
* The old handler later resolves successfully or throws
* The late result cannot overwrite newer execution state
* A synced or advanced workflow cannot be downgraded to failed by stale work
* Logs clearly show the stale result was ignored

This is required before Endura can safely run photo-like or native-module-heavy workflows.

##### Scenario 12: App Upgrade With Pending Work

Model an app upgrade while a workflow is pending or failed.

The scenario must verify:

* A persisted workflow references an activity name from version N
* Version N+1 renames, removes, inserts, or reorders activities
* Unknown activity names are held for inspection, not immediately dead-lettered
* Compatible activity changes continue safely
* Incompatible changes produce a visible, recoverable state
* Recovery does not create a job with an undefined worker

This scenario is required because the current recovery code has explicit guards for unmapped stages from renamed or removed workers.

##### Scenario 13: Mobility Run Scoped Recovery

Model mobility-related workflows such as:

* `mobilityRunSync.pipeline`
* `mobilityStopSync.pipeline`
* `mobilityVehicleSync.pipeline`
* `serviceOrderSync.pipeline`
* mobile-service photo workflows

The scenario must verify:

* Failed work can be scoped by mobility run
* Failed work can be scoped by service order where relevant
* Move-based and run-based recovery do not interfere with each other
* Force Retry works for a run-scoped failure
* Inspection APIs can power a per-run recovery UI

This is required before Endura backs mobile-service workflows.

##### Scenario 14: Backlog Drain With Priority

Model a large backlog after offline usage.

The scenario must verify:

* Many workflows are queued while offline
* Different workflows have realistic priorities
* When connectivity returns, work drains in expected priority order
* FIFO order is preserved within a priority
* Lower-priority work is not starved forever
* The app remains responsive enough for mobile use
* The result is inspectable after completion

Priority values should be extracted from current worker `jobOptions`.

#### Scenario Result Contract

Each Expo scenario must return a structured result.

```ts
type ScenarioResult = {
  scenarioId: string;
  name: string;
  status: 'passed' | 'failed';
  startedAt: string;
  completedAt?: string;
  steps: Array<{
    name: string;
    status: 'passed' | 'failed' | 'skipped';
    detail?: string;
  }>;
  assertions: Array<{
    name: string;
    passed: boolean;
    expected?: unknown;
    actual?: unknown;
  }>;
  executionSnapshot?: unknown;
  taskSnapshot?: unknown;
  deadLetterSnapshot?: unknown;
  fakeServerSnapshot?: unknown;
  logs: string[];
};
```

A scenario passes only when all assertions pass.

A workflow reaching `completed` is not enough if it violated ordering, dedupe, recovery, idempotency, or inspection expectations.

#### Required Fake Server

The Expo test app must include a fake server or fake side-effect recorder.

It must support:

* Successful mutation
* Transient failure
* Permanent server refusal
* Slow response
* Hung response
* Duplicate idempotency key
* Late success
* Late failure
* Connectivity unavailable

The fake server should record logical business effects, not just function calls. For example:

* One uploaded photo
* One move status update
* One submitted outcome
* One merged workflow-data update
* One processed offer bundle

This is how the scenario suite proves Endura’s at-least-once execution model does not become duplicate business behavior.

#### Required Expo Harness Capabilities

The Expo test app must provide:

* Scenario list
* Scenario detail screen
* Reset scenario
* Run scenario
* Run all scenarios
* Persisted SQLite state viewer
* Execution viewer
* Task viewer
* Dead-letter viewer
* Connectivity toggle
* Background wake simulation
* App restart or engine restart simulation
* Failure injection controls
* Fake server viewer
* Export scenario report as JSON

#### Success Gates

Phase 4 is complete only when:

1. The pipeline inventory is complete.
2. Every `Must Match` pipeline has a mapped Endura scenario or an explicitly documented replacement decision.
3. All required scenario categories above are implemented.
4. All scenarios pass in the iOS simulator.
5. All scenarios pass in the Android simulator.
6. Photo pipeline parity passes.
7. Outcome draft sync parity passes.
8. Outcome submit parity passes.
9. Move sync permanent failure and force retry parity pass.
10. Offer bundle per-entity dedupe parity passes.
11. Offline hold and offline mid-stage scenarios pass.
12. Foreground/background collision passes before background execution is enabled.
13. App upgrade with pending work passes.
14. Recovery age gate and non-recoverable workflow behavior pass.
15. The fake server shows no unintended duplicate business effects.
16. Failures from this phase are added to the issue catalog with severity.

#### Issue Catalog Additions

Any mismatch discovered in Phase 4 must be added to the issue catalog.

Use this format:

| ID | Severity | Area | Current Driver App Behavior | Endura Behavior | Production Risk | Required Fix | Scenario |
| -- | -------- | ---- | --------------------------- | --------------- | --------------- | ------------ | -------- |

Severity rules:

* `Critical`: Endura cannot safely replace current production behavior
* `High`: Endura can replace it only with a risky workaround
* `Medium`: Acceptable for a narrow pilot but not broad rollout
* `Low`: Cleanup, documentation, or non-blocking parity gap

#### Adoption Rule

Endura may not replace the current driver app pipeline layer until Phase 4 passes.

Phase 1 through Phase 3 prove the Endura engine is internally stronger.

Phase 4 proves Endura is actually fit to replace the behavior HopDrive drivers rely on in production.

The required proof is:

> Production driver-app pipeline behaviors have been extracted from `driver-app-3`, translated into deterministic Expo mobile scenarios, and all required scenarios pass on iOS and Android against the real Endura SQLite persistence layer.

---

## Adoption Recommendation

**Continue hardening before adoption — do not adopt yet, not even behind a feature flag.**

A feature flag doesn't help when the package cannot execute a task on-device (C1): there is nothing to flag on. The safest path to using Endura in the driver app rewrite:

1. **Now:** Land Phase 1 in Endura. It is roughly 2–4 weeks of focused work — the issues are concentrated in ~5 files and are well-specified above. Keep the existing engine-logic test suite (it's good); add the durability/concurrency tests that are missing.
2. **Gate:** the Expo example app running the RN smoke test (kill/relaunch/resume, no duplicates) on a real device. Endura must not be versioned past 0.x or consumed by driver-app code before this gate passes.
3. **Pilot (per the RFC's own plan):** the photo pipeline on its own `workflow.db`, **foreground-engine only** (leave RNQ's background subset in place; Endura's background engine stays off until leasing (Phase 1.4) is proven). This matches the RFC §8.6 drain-then-switch-per-family migration and the team's existing local-link iteration workflow.
4. **Expand** family-by-family behind the `enqueue()` facade only after the pilot has survived real field conditions (dead zones, force-quits, OS background kills) for a full release cycle, and after Phase 2 items H5/M1/H7 land — those are the ones the recovery UX and app-upgrade path depend on.

---

## Final Verdict

**HopDrive should not build the driver app rewrite on Endura today.** In its current state it would be a reliability regression from the system it replaces: the RNQ fork, for all its flaws, has atomic Realm claims, crash re-claims that don't burn attempts, a recovery ledger, and four years of incident-hardening — Endura as shipped executes zero tasks on a real device, double-executes under its own advertised background deployment, and can strand workflows invisibly and permanently.

But the *direction* is right, and the review's conclusion is not "abandon it." The architecture (single execution record, storage-agnostic engine, injected time/environment, honest at-least-once contract) is a genuinely better foundation than the two-store Realm system, the linear workflow model fits all 34 existing pipelines, and the defect list — while severe — is finite, concentrated, and fixable by one engineer in weeks. The real lesson is about process: this is AI-generated code whose polish outran its verification. It has never run on the platform in its tagline, and its green CI proves engine logic while proving nothing about durability. Fix Phase 1, put a real device in the loop as a permanent CI gate, pilot on the photo pipeline foreground-only, and Endura can earn the foundational role. Adopt it before that, and the first dead-zone force-quit in the field will be a data-loss incident with no recovery screen to catch it.
