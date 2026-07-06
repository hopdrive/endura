# GROUND-TRUTH BEHAVIOR REPORT: driver-app-3 queue/event/recovery engine

Sources read in full: `utils/event.ts`, `utils/queue.ts`, `utils/recovery.ts`, `utils/errors.ts`, `utils/background.ts`, `models/Event.ts`, RNQ fork (`node_modules/@hopdrive/react-native-queue/Models/{Queue,Worker}.js`, `config/{Database,config}.js`), plus pipeline registration (`app/(user)/_layout.tsx`), representative workers (`moveStatusSync.worker.ts`, `photoResize.worker.ts`), and pipeline index files (`photo`, `offerBundleProcess`, `offerMissedAssignments`, `photoReaper`, `sendAppDump`).

Two layered abstractions exist: the app's own **Event** row (Realm `Event` model, one per pipeline run, the durable source of truth) and the RNQ **Job** row (Realm `Job` model in a separate realm file, one per stage attempt, ephemeral). A "pipeline" is an app concept; the RNQ queue only knows individual named jobs (= stages).

---

## 1. EVENT LIFECYCLE

**Event row schema** — `models/Event.ts:49-63`:
- `_id: string` (primaryKey, = the `eventId` UUID generated at pipeline start)
- `moveId: int?` (defaults to `0` when absent — `utils/event.ts:702`)
- `driverId: int?` (defaults to `0` — `utils/event.ts:703`)
- `type: string` (required; = `pipeline.name`, e.g. `'photo.pipeline'`)
- `stage: string?` (= current worker's `name`, e.g. `'photoResize'`)
- `status: string` (required)
- `time: date` (required; set once at creation, `utils/event.ts:689,706`)
- `payload: mixed` (Realm.Mixed — arbitrary object; see §3 for the nested-object constraint at `models/Event.ts:3-17`)
- `error: string?`

**Status values** — `utils/event.ts:51-64` (`statuses` frozen object):
- `pending` — set at creation and at every `setStage()` (`event.ts:236`)
- `synced` — terminal success (`event.ts:529`)
- `failed` — terminal-but-recoverable failure (`event.ts:634`)
- `permanently_failed` — server definitively refused (`event.ts:673`)

Note: `'active'` appears only in a Realm query string at `event.ts:354` (`hasPendingEventForCertKey`) but is never written to an Event row — no code path sets `status='active'`. Treat it as vestigial.

**Transitions:**
- (none) → `pending` — `createEvent()` `event.ts:705,710`
- `pending` → `pending` — each `setStage()` at the start of every worker rewrites `status=pending, stage=<name>` via `Realm.UpdateMode.Modified` (`event.ts:231-241`)
- `pending` → `synced` — `markEventAsSynced()` when `completeStage()` detects the last stage (`event.ts:486-490,520-534`)
- `pending`/`failed` → `failed` — `markEventAsFailed()` (`event.ts:634`), guarded (see §4)
- `pending` → `permanently_failed` — `markEventAsPermanentlyFailed()` (`event.ts:673`)
- `permanently_failed` → `failed` — force-retry reset (`recovery.ts:143-147,232-234`)
- `failed`/`pending` → `synced` — recovery photo reconciliation (`recovery.ts:430`) and photoResize missing-source reconciliation (`photoResize.worker.ts`)

**Event creation on pipeline start** — `start()` at `event.ts:144-206`:
1. Generates `eventId = uuid.v4()` (`event.ts:153`)
2. `payloadWithExtras = { ...payload, eventId }` (`event.ts:155`)
3. `firstStage = pipeline.sequence[0]` (`event.ts:154`)
4. `await createEvent({eventId, type: pipeline.name, stageName: firstStage.name, payload, moveId, driverId})` — the row exists with `status=pending, stage=<firstStage.name>` **before** any work runs (`event.ts:163-170`)
5. Then branches on `runStageOneSynchronously`:

**Synchronous stage-one** (`event.ts:174-196`): calls `firstStage.init(pipeline)` then `await firstStage.worker(eventId, payloadWithExtras)` directly — NO RNQ job is created for stage 1. If it throws, the event is marked `status=FAILED` (best-effort, wrapped in try/catch) and the error is re-thrown to the caller (`event.ts:178-195`). Used where the caller must block on stage-1 completion before proceeding. Call sites: `_layout.tsx:403,430` (certificationSync, driverStatusSync at login), `moves/[id]/signature.tsx:70`, and the MoveWorkflow interceptors (`handleSignatureCapture`, `handleDocumentScanCapture`, `handlePhotoCapture`, `handleMultiPhotoCapture`). Subsequent stages of a sync-started pipeline still go through the queue via `completeStage`→`createNextJob`.

**Asynchronous** (default, `event.ts:197-205`): `QueueUtils.createJob({worker: firstStage, payload: payloadWithExtras})` — stage 1 runs as a normal queued job.

---

## 2. WORKER SEQUENCE REGISTRATION

**Worker definition shape** — `WorkerDefinition` interface `queue.ts:18-30`: `{ init?, name, worker, jobOptions?, workerOptions?, display? }`. Default export of each `*.worker.ts` is this object (e.g. `moveStatusSync.worker.ts` last line: `{ init, name, worker, jobOptions, workerOptions, display: { icon: '🚚', label: 'Move Status' } }`).

**Pipeline shape** — `Pipeline` interface `event.ts:13-27`: `{ name, sequence: WorkerDefinition[], onComplete?, moveId?, driverId?, recoverable? }`. Each pipeline's `index.ts` builds `const pipeline = { name, sequence, onComplete }` and exports `register = (queue) => pipelineRegister(sequence, pipeline, queue)` (e.g. `photo/index.ts`, `offerBundleProcess/index.ts`).

**`register()`** — `event.ts:105-118`. For each worker in the sequence:
1. `QueueUtils.registerWorker(queue, worker)` → `queue.addWorker(worker.name, worker.worker, worker.workerOptions)` (`queue.ts:141-143`). This maps the RNQ worker function + options under key `worker.name`.
2. `if (worker.init) worker.init(pipeline)` — hands the pipeline reference to the worker's module-local `pipeline` var (see `moveStatusSync.worker.ts` `init` at bottom; also re-scopes the logger with the pipeline name).
3. `if (worker.name && worker.display) workerDisplayByName[worker.name] = worker.display` — populates the display registry.
4. After the loop: `pipelinesByName[pipeline.name] = pipeline` — the pipeline registry.

**RNQ worker storage** — `Worker.workers` is a **static** map (`Worker.js:12`), i.e. a singleton shared across all Queue instances in the JS process. `addWorker` merges options with defaults (`Worker.js:33-56`): `concurrency:1, isJobRunnable:()=>({runnable:true}), failureBehavior:'standard', minimumMillisBetweenAttempts:0`, plus lifecycle callbacks.

**Stage name → worker mapping** is by string key `worker.name` in `Worker.workers`. `job.name` (RNQ) == `worker.name` == `event.stage`. When a job runs, `Worker.executeJob` looks up `Worker.workers[job.name]` (`Worker.js:177-201`).

**Unmapped/renamed stages:**
- At RNQ execution time: if a job's name has no worker, `executeJob` **throws** `'Job <name> does not have a worker assigned to it.'` (`Worker.js:179-181`). Same throw in `getConcurrency`/`execIsJobRunnable`/`getFailureBehavior` (`Worker.js:103,120,142,161`). `getConcurrentJobs` calls `execIsJobRunnable` inside a realm write, so an unmapped selected job can throw there.
- At recovery time: `runRecovery` guards against this with a **separate hardcoded `jobMapper`** (`recovery.ts:265-283`) — a stage not present in `jobMapper` is skipped with a warning (`recovery.ts:441-449`), never re-armed. This `jobMapper` is maintained by hand and must include every worker that can appear as `event.stage`; the comment (`recovery.ts:257-264`) documents that omitting photo stages previously caused "Worker definition not provided" crashes.
- Display fallback: `getWorkerDisplay()` returns `DEFAULT_WORKER_DISPLAY = { icon: '📦', label: 'Unknown' }` for unregistered/display-less stages (`event.ts:103,123-128`).

**Registration happens in three places** (a replacement must reproduce all three, and their DIVERGENCE — see §9):
1. `app/(user)/_layout.tsx:206-239` — main foreground registration inside `loadAppInfra`, **gated by `isPendingDriver`**: driverInfoSync/certificationComplete/certificationSync always register; all move/photo/offer/mobility/outcome pipelines register only `if (!isPendingDriver)` (`_layout.tsx:210-238`).
2. `utils/background.ts:54-74` — background-task registration, unconditional, a **different (stale) subset** of pipelines.
3. RNQ `Worker.workers` being a process-global static means whichever ran last wins per name.

---

## 3. STAGE RESUME + PAYLOAD ACCUMULATION

**Per-stage entry** — every worker starts with `const { start, runInstanceId } = await EventUtils.setStage(eventId, name)` (`moveStatusSync.worker.ts`, `photoResize.worker.ts`). `setStage` (`event.ts:208-244`) writes `{status: pending, stage: stageName}` to the Event via `UpdateMode.Modified`, and returns a fresh `start` timestamp + `runInstanceId` (a per-run uuid, optionally ANSI-colored) used only for log correlation.

**`setPayload`** — `event.ts:246-261`: overwrites the entire `payload` field with the object given, via `UpdateMode.Modified`. Not a deep merge at the Realm level — callers do the merge in JS.

**`completeStage`** — `event.ts:429-518`, the core accumulation mechanic:
1. `event = await getEvent(eventId)` (`event.ts:439`)
2. `eventPayload = JSON.parse(JSON.stringify(event.payload))` — deep-clones the Realm Mixed to a plain JS object (Realm dictionaries become invalid after write transactions; `event.ts:441`)
3. `currentStage = getStageFromSequence(pipeline, event.stage)` — resolves the worker by the event's persisted `stage` string; **throws** if the stage isn't in this pipeline's sequence (`event.ts:393-403,442`)
4. `isLastStageInSequence = isLastStage(...)` (`event.ts:388-391,443`)
5. **`await setPayload(eventId, { ...eventPayload, ...additionalPayload })`** — the merge. Prior accumulated payload is spread first, then `additionalPayload` (this stage's outputs) overrides. This persisted merged object becomes the durable payload (`event.ts:444`).
6. If last stage: `markEventAsSynced()` + `pipeline.onComplete?.(eventId, eventPayload)` (`event.ts:486-492`).
7. Else: `nextStage = getNextStage(pipeline, currentStage)` (`event.ts:499`), build `chainData = { callerJobName: currentStage.name, step: Number(event.payload.step || 0) + 1 }` (`event.ts:507-510`), then `await createNextJob(eventId, nextStage, { ...additionalPayload, ...chainData })` (`event.ts:514`).

**`createNextJob`** — `event.ts:405-427`: re-reads the Event, **re-clones `event.payload` via JSON round-trip** (`event.ts:412`), then `QueueUtils.createJob({ worker: nextStage, payload: { ...eventPayload, ...additionalPayload } })`. So the **next worker receives**: the full accumulated event payload (already includes what step N wrote via `setPayload`) spread with `additionalPayload` again (`additionalPayload` here is `{ ...thisStageAdditional, ...chainData }` passed from `completeStage`). Net: next worker's payload = persisted-merged-payload ∪ additionalPayload ∪ `{callerJobName, step}`.

Important asymmetry: `completeStage` persists the merged payload to Realm (`setPayload`) AND passes it into the RNQ job payload. If the process dies between `setPayload` and job creation, recovery replays from the Event's persisted payload (see below), so the merge is durable.

**`getNextStage`** — `event.ts:376-386`: index of currentStage +1, **wraps to 0** if past the end (defensive; `isLastStage` normally short-circuits this).

**Recovery stage→worker mapping** — `recovery.ts:376-455`: for each failed Event, it reads `stage = event.stage` and `additionalPayload = event.payload` (the persisted accumulated payload, `recovery.ts:378-379`), looks up `workerDef = jobMapper[stage]` (the hardcoded map, NOT the pipeline sequence), and calls `EventUtils.createNextJob(eventId, workerDef, additionalPayload)` (`recovery.ts:455`). So recovery re-arms the SAME stage the event was failed at, feeding it the persisted payload. (Because `createNextJob` spreads `eventPayload` and `additionalPayload` and here they're the same object, no data is lost.)

---

## 4. STALE FAILURE GUARD

`markEventAsFailed` — `event.ts:561-644`. The guard (`event.ts:578-592`):

```
existing = realm.objectForPrimaryKey('Event', eventId)
if (existing) {
  if (existing.status === 'synced') → return (ignore)          // event.ts:580-585
  if (job.name && existing.stage && existing.stage !== job.name) → return  // event.ts:586-591
}
```

Two conditions ignore a late failure:
1. **Already synced**: event reached terminal success on the original run.
2. **Advanced past this job's stage**: `existing.stage !== job.name` — the event has moved to a later stage than the one this (retry) job belongs to.

Rationale documented at `event.ts:567-577`: a job can hit its RNQ timeout (retry scheduled) while the original promise keeps running to completion, driving the event forward. The scheduled retries then fail against consumed source files and land here; without the guard they'd downgrade an advanced/synced event back to `failed`, and recovery would re-arm it forever (cites move 33055 / Ben Scott dump 2026-05-27).

If NOT guarded: parses `job.payload`/`job.data`, extracts `{errors, failedAttempts, attempts}`, fires a `Sentry.captureException(PipelineFailure(...))` tagged with the last underlying error for grouping (`event.ts:608-627`), then writes `status=FAILED, error=<formatted job data>` (`event.ts:629-643`).

`markEventAsFailed` is invoked from each worker's `workerOptions.onFailed(id, payload)` callback (RNQ fires `onFailed` only after all attempts exhausted — see §8), e.g. `moveStatusSync.worker.ts` onFailed: `const job = await queue.getJob(id); EventUtils.markEventAsFailed({ eventId, job })`.

---

## 5. PERMANENT FAILURE

**Classification** — driven by `RowFilterRejectedError` (`utils/errors.ts:14-29`). Thrown by mutation wrappers (`queries/updateMoveStatusById` etc.) when Hasura accepts the request but writes **zero rows**: `data.update_X_by_pk === null` (pk variant) or `affected_rows === 0` (bulk variant) — see `errors.ts:1-12`. Semantically: the move was reassigned to another driver (per-row `driver_id` filter no longer matches the JWT) or deleted. Carries `mutationName` and `entityId`.

**Handling in workers** — pattern in `moveStatusSync.worker.ts` catch block (`:95-135`), also present in moveDriverStatusSync and moveWorkflowOutputSync (per `event.ts:60-61` comment):
```
if (error instanceof RowFilterRejectedError) {
  markEventAsPermanentlyFailed({ eventId, reason: <user-facing string> })
  Sentry.captureMessage(..., level='warning', tag pipeline.outcome='row_filter_rejected')
  return;   // NO re-throw → RNQ marks job complete, no retry storm
}
```
Critically it `return`s instead of throwing, so RNQ deletes the job as successful and does not burn the remaining (up to 10) attempts.

**`markEventAsPermanentlyFailed`** — `event.ts:656-679`: writes `status='permanently_failed', error=reason` via `UpdateMode.Modified`.

**Exclusion from recovery**: `getFailedEvents` and `getFailedEventsByMoveId` filter `status == "failed"` only (`recovery.ts:58,75`), so `permanently_failed` rows are never in the recovery set. They're surfaced separately via `getPermanentlyFailedEvents` / `...ByMoveId` (`recovery.ts:90-120`) for a "Cannot sync" UI section.

**Force-retry reset**: `resetPermanentlyFailedEventsForMove(moveId)` (`recovery.ts:130-154`) and `resetPermanentlyFailedEventsForRun(run)` (`recovery.ts:222-245`) flip matching rows `permanently_failed → failed` in a realm write, returning the count. The recovery screen (`app/recovery.tsx:528-543`) calls reset then `runRecovery({ moveId, includeStale: true })` so the now-`failed` rows get picked up past the age gate.

---

## 6. RECOVERY

**`runRecovery({ queue, moveId?, runScope?, includeStale=false })`** — `recovery.ts:308-466`.

**Source-set selection** (`recovery.ts:325-351`):
- `runScope.run` present → `getFailedEventsForRun(run)` (mobility scope; also fires a `priority.sync.start` sendEventLog). `runScope` wins over `moveId` if both passed (`recovery.ts:316-322` doc).
- else `moveId` → `getFailedEventsByMoveId(moveId)` (+ sendEventLog).
- else → `getFailedEvents()` (global sweep).

All three filter `status=='failed'` and then `.filter(isRecoverableFailedEvent)` which drops `recoverable===false` pipeline types (`recovery.ts:48-49,58,75`).

**Age gate** — `MAX_RECOVERABLE_EVENT_AGE_MS = 7*24*60*60*1000` (7 days, `recovery.ts:299`). When `!includeStale`, events are filtered by `isEventWithinRecoveryWindow` (`recovery.ts:301-306`): keeps events where `0 <= (now - event.time) < 7 days`. Events with no `time` are dropped (`return false`). Manual flows pass `includeStale:true` to bypass (`recovery.ts:355-362`). Rationale + Sentry incident (DRIVER-APP-3-VDW ~14.7k events) at `recovery.ts:285-298`.

**Sweep body** (`recovery.ts:374-460`):
1. `await queue.deleteAllFailedJobs()` — clears prior failed RNQ jobs so re-armed ones can run (`recovery.ts:374`; RNQ `Queue.js:597-606` deletes all `Job` where `failed != null`).
2. For each failed event:
   - **Non-recoverable skip**: `if (!isPipelineRecoverable(event.type)) continue` (`recovery.ts:391-394`).
   - **Photo reconciliation special case** (`recovery.ts:406-433`): for `type==='photo.pipeline'`, look up `VehiclePhoto` by `eventId` (photo PK == eventId). If `status` (lowercased) is `'uploaded'` or `'done'` AND `url` starts with `'http'`, the photo is already on the server → `markEventAsSynced()` and skip re-arm. Case-insensitive because a later server resync lowercases `'Done'`→`'done'` (`recovery.ts:414-419`).
   - **Unmapped-stage guard**: `workerDef = jobMapper[stage]; if (!workerDef) { warn; continue }` (`recovery.ts:441-449`).
   - **Re-arm**: `await createNextJob(eventId, workerDef, event.payload)` in try/catch (`recovery.ts:454-458`).
3. `await queue.start()` (`recovery.ts:460`).
4. If `moveId`: `await startPrioritySyncCompletePipeline({ moveId })` (`recovery.ts:462-465`).

**Non-recoverable classification mechanism** — `Pipeline.recoverable?: boolean` (`event.ts:26`), defaults true. `isPipelineRecoverable(type)` (`event.ts:134-139`) returns `pipelinesByName[type]?.recoverable !== false`; unknown types → true (covers pending-driver sessions that skipped registration, `event.ts:131-134`). Only two pipelines set `recoverable:false`: `photoReaper` (`photoReaper/index.ts:33`) and `sendAppDump` (`sendAppDump/index.ts:44`).

**Automatic sweep triggers** (all outside recovery.ts):
- `app/(user)/_layout.tsx:444` — `checkForRecovery()` at end of `loadAppInfra`; `_layout.tsx:119-126` calls `getFailedEvents()` and, if any, `sendRecoveryNotice(router)` (navigates to `/recovery`, does NOT auto-run recovery — user opts in on that screen).
- `components/MoveWorkflow/MoveDataProgress.tsx:68-73` — `useEffect` fires `runRecovery({ queue, moveId })` on mount when `failedEventsCount > 0` (auto, per-move).
- `components/mobile-service/UploadProgressBanner.tsx:122,124` — `runRecovery({ queue, runScope: { run } })` or global.
- `app/recovery.tsx:506,517,537,543` — user-triggered buttons (global, global+includeStale, per-move-force-retry+includeStale).

**`sendRecoveryNotice` dedup** — `recovery.ts:506-521`: 2s time-window dedup (`RECOVERY_PUSH_DEDUP_WINDOW_MS=2000`) to prevent double `/recovery` push when the launch init effect runs twice (null→real userId).

---

## 7. DEDUPE MECHANISMS

Enforced at the **pipeline `start()` layer** (each `index.ts`), by querying the Event table for a `pending` event before enqueuing. Two granularities:

**Type-level** — `hasPendingEventAlready(type)` (`event.ts:296-298` → `getPendingEventsByType`, `event.ts:267-273`, query `type == $0 && status == "pending" limit(1)`). Used by: offerMissedAssignments, deleteNonMatchingMovesSync, offerStatusSync, driverInfoSync, certificationSync, sendAppDump, photoReaper, cancelMoveStatusSync (`index.ts` files, e.g. `offerMissedAssignments/index.ts:38`). If a pending event of that type exists, the new `start()` returns early — the new run is dropped entirely, no new Event/Job created.

**Per-entity** — `hasPendingEventMatching(type, predicate)` (`event.ts:305-323`): pulls all `pending` events of `type`, JSON-parses each payload, returns true if any satisfies the predicate. offerBundleProcess dedupes by `offerId`: `hasPendingEventMatching(name, p => p?.offerId === payload.offerId)` (`offerBundleProcess/index.ts:40`). This is because the type-only guard can't distinguish offers, and `fetchMissingBundles` re-queues every accepted offer each refresh (the "offerBundleProcess storm", `index.ts:36-42`). certification uses `hasPendingEventForCertKey(certKey)` which also checks `status == 'active'` (`event.ts:350-364`).

**What happens to prior history**: nothing — dedupe just *drops the new enqueue*. The existing pending event (and its in-flight job/retries) continues untouched. There is no cancellation or supersession. Terminal (synced/failed) events of the same type are NOT considered by these guards (query is `status=="pending"` only), so a new run proceeds once the prior one reaches terminal state.

**Terminal cleanup (separate concern)** — `clearTerminalEventsByType(type)` (`event.ts:331-348`) deletes `synced` OR `failed` events of a type; used by photoReaper to prevent one-row-per-sweep Realm bloat (`photoReaper/index.ts:49`).

---

## 8. QUEUE / RNQ (HopDrive fork @1.x, `node_modules/@hopdrive/react-native-queue`)

**Realm store**: separate realm file from the app's. `JobSchema` (`config/Database.js:7-22`): `{id(pk,uuid), name, payload(JSON string), data(JSON string), priority(int), active(bool default false), timeout(int), created(date), failed(date?), lastFailed(date?)}`. `REALM_SCHEMA_VERSION=1` (`config/config.js:8`). `Database.realmInstance` is a **static singleton** (`Database.js:25-30`) — path defaults to `reactNativeQueue.realm` but the app passes `realmPath: getRNQRealmPath()` (`queue.ts:67`).

**Single-instance init + idempotency backstop** — `QueueUtils.initialize()` (`queue.ts:50-90`): checks `getNonReactiveState().queue`; if already set, logs and returns the existing instance (`queue.ts:62-65`) — prevents a second queue on the same realm from a raced `loadAppInfra`. Otherwise `queueFactory({ realmPath })` (`queue.ts:67`) → `new Queue(); await queue.init()` (`Queue.js:642-647`). Note: RNQ's own `Database.getRealmInstance` singleton (`Database.js:28`) is a second backstop — even a duplicate `queueFactory` reuses the same realm handle.

**Job creation** — `Queue.createJob(name, payload, options, startQueue=true)` (`Queue.js:161-192`): writes a Job with `payload=JSON.stringify(payload)`, `data=JSON.stringify({attempts: options.attempts||1})`, `priority: options.priority||0`, `active:false`, `timeout: options.timeout>=0 ? options.timeout : 25000`, `created:now`, `failed:null, lastFailed:null`. If `startQueue && status==='inactive'`, auto-starts. App wrapper `QueueUtils.createJob` (`queue.ts:155-208`) resolves `autoStartQueue` from override → worker.jobOptions.autoStartQueue → `state.queueAutoStart` global (and the global, if false, always wins — `queue.ts:184-186`); if `state.queue` is null it **drops with a warning** rather than throwing (`queue.ts:194-201`, handles pipelines firing before init).

**Defaults**: `attempts` default `1` (`Queue.js:177`), `timeout` default `25000ms` (`Queue.js:181`), `priority` default `0` (`Queue.js:179`), `concurrency` default `1` (`Worker.js:43`), `minimumMillisBetweenAttempts` default `0` (`Worker.js:46`). **Actual worker values**: timeout mostly `30000`, photos `15000`–`60000`, sendEventLog `5000`; attempts mostly `10`, photos vary (`photoBlurHash:1`, `photoResize:5`, `photoUpload:3`), reaper `2`, appDump/certSync/promo/prioritySync `5`.

**Priority semantics** — `sorted([['priority', true], ['created', false]])` (`Queue.js:381,416`): priority DESC then created ASC (FIFO within a priority). Schema comment says "-5 to 5" but **actual values used span 3–50**: geofence/gps `30`; moveStatusSync/moveWorkflowOutputSync/offerStatusSync/outcomeStatusSync/mobility*/serviceOrderSync `50`; photoCapture `45`, photoResize/blurHash/pending `44`, photoUpload `43`, photoSave `42`; outcome `40`, promo `40`; move-adjacent syncs (driver*, fuel*, cancel, moveUpdate, deleteNonMatching, prioritySyncComplete, photoReap) `10`; offerBundleProcess `9`, offerMissedAssignments `8`; cert `5`/`3`. Full list: see grep of `priority:` across `pipelines/`.

**Job selection** — `getConcurrentJobs(lifespanRemaining)` (`Queue.js:324-474`), inside a realm write:
- Builds per-worker filters: a job is eligible only if `lastFailed == null OR lastFailed <= (now - minimumMillisBetweenAttempts)` — enforces back-off (`Queue.js:339-356`). Date is formatted into Realm's `YYYY-MM-DD@HH:MM:00` string, truncated to minute.
- Base query: `active==FALSE AND failed==null AND (workerFilters)` OR `active==TRUE AND ... failed==null` (`Queue.js:371-377`). **Active jobs are re-selectable** — see restart note.
- With lifespan: additionally `timeout>0 AND timeout < (lifespanRemaining-499)`; **jobs with `timeout:0` are never processed under a lifespan** (`Queue.js:336,358-369`; documented `Queue.js:212`).
- Picks `nextJob = jobs[0]`, then gathers all same-name jobs up to that worker's `concurrency`.
- **`isJobRunnable` gating** (`Queue.js:418-448`): for each candidate, `worker.execIsJobRunnable(name, job)`. If not runnable, the job is **skipped** (not failed): `data.skippedAttempts++`, `data.skippedReasons.push(reason)`, and `onSkipped` callback fires. The sync workers use `isJobRunnable: () => ({ runnable: state.isConnected, reason })` (`moveStatusSync.worker.ts:workerOptions`) — offline jobs are skipped every pass, never consuming an attempt.
- Marks selected jobs `active=true`, then re-selects by id (Realm select-for-update workaround, `Queue.js:450-469`).

**Processing** — `start(lifespan=0)` (`Queue.js:217-259`): guards against concurrent loops (`if status==='active' return false`), sets status `active`, loops `getConcurrentJobs` → `processJob` (all concurrent jobs via `Promise.all(...promiseReflect)`), until no jobs remain, then status `inactive`. `processJob` (`Queue.js:491-569`): fires `onStart`; `await worker.executeJob(job)` which **races the worker against a timeout promise** if `timeout>0` (`Worker.js:190-197`) — a timeout rejects with `'TIMEOUT: Job id ... timed out in Nms'` but **does not cancel the underlying worker promise** (root cause of the stale-failure problem in §4). On success: delete the job, fire `onSuccess`+`onComplete`. On failure (`failureBehavior:'standard'`, `Queue.js:522-564`): `data.failedAttempts++`, `data.errors.push(msg)`, `active=false`, `lastFailed=now`; if `failedAttempts >= attempts` set `failed=now` and fire `onFailed`+`onComplete`; always fire `onFailure`. **`onFailed` (all attempts exhausted) is where the app calls `markEventAsFailed`** (see §4). `failureBehavior:'custom'` hits `default: break` — no retry bookkeeping (not used by app workers; all set `'standard'`).

**expo-background-task wiring** — `utils/background.ts`: `defineTask_queueRunner()` (`:41-89`) registers `TaskManager.defineTask(QUEUE_START_BACKGROUND_TASK, ...)` which creates a fresh `queueFactory()` (no realmPath — uses default), registers a subset of pipeline workers, and calls `queue.start(25000)` — a 25s lifespan (OS caps background at ~30s). Under lifespan, only jobs with `timeout>0 && timeout<(remaining-500)` run. `registerTask_queueRunner()` (`:94-100`): `BackgroundTask.registerTaskAsync(..., { minimumInterval: 900 })` (15 min). Foreground init records `BackgroundTask.getStatusAsync()` and `TaskManager.isTaskRegisteredAsync()` into store (`queue.ts:86-87`).

**Job listeners for UI** — `queue.ts:74-84`: `onQueueStateChanged(status)` → `setQueueStatus` (RNQ `Queue.js:99-102`, single observer, last-wins); `onQueueJobChanged()` → `refreshJobsState` → `setQueueJobs(await queue.getJobs())` (RNQ attaches a Realm `"change"` listener, `Queue.js:123-134`). Unsubscribers held in module-local `queueListenerUnsubs`, cleared in `teardown()` (`queue.ts:48,102-122`).

**App restart / active jobs** — RNQ has **no crash recovery for `active` jobs**: a job left `active=true` when the process died stays `active=true` in Realm. But `getConcurrentJobs`'s base query explicitly **includes `active==TRUE AND failed==null` jobs** (`Queue.js:375-377,409-412`), so on next `start()` orphaned-active jobs are re-selected and re-run. There is no `close`/`destroy` — `teardown()` only calls `stop()` (sets status inactive); the realm handle leaks until JS engine restart (`queue.ts:96-101` documents this known leak).

---

## 9. ANYTHING ELSE a replacement must reproduce

- **Two-realm, two-ID model**: Event (app, durable, PK=`eventId`) vs Job (RNQ, ephemeral, PK=random job uuid). The job uuid is NOT surfaced back to the app — `completeStage`'s abandoned Sentry code (`event.ts:446-479`) documents that the job.id is unavailable at completion time, which is why success-after-retry can't be reported. A replacement that unifies these must still let `onFailed` reach the right Event via `eventId` carried in the job payload.

- **`Worker.workers` is process-global static** (`Worker.js:12`). The foreground queue and the background-task queue share the same worker registry. Re-registration overwrites by name.

- **Registration DIVERGENCE (parity bug to preserve or fix knowingly)**: `background.ts:54-74` registers a **stale subset** — it omits outcomeStatusSync, outcomeSubmit, outcomeWorkflowDataSync, mobilityRunSync, mobilityStopSync, mobilityVehicleSync, serviceOrderSync, photoReaper, promoSync, and offerBundleProcess/offerMissedAssignments handling differs. `_layout.tsx` registers the full set but gated on `!isPendingDriver`. A job whose worker isn't registered in the background context will throw `'Job <name> does not have a worker assigned'` at `executeJob` (`Worker.js:180`) during a background run. Additionally, the recovery `jobMapper` (`recovery.ts:265-283`) is a THIRD hand-maintained list that also omits mobility/outcome/offer/promo/geofence/serviceOrder workers — recovery silently skips those stages (`recovery.ts:441-449`). Three lists that must agree but don't.

- **`isJobRunnable` = connectivity gate, not failure**: offline jobs are skipped indefinitely (accumulating `skippedAttempts`, never `failedAttempts`), so they survive across reconnects without exhausting retries. A replacement must distinguish "not runnable now" (re-queue) from "failed" (count attempt).

- **`minimumMillisBetweenAttempts` back-off** is enforced via a minute-truncated Realm date string comparison in the selection query (`Queue.js:343-353`), not a timer. Sync workers use 10s.

- **Timeout does not cancel work** (`Worker.js:190-197`): the source of the entire stale-failure / photo-reconciliation family of guards (§4, §6 photo case, photoResize/photoUpload missing-source short-circuits). Any replacement with true cancellation would change these behaviors — the app currently *relies* on the original promise finishing after a timeout.

- **Payload cloning discipline**: every read of `event.payload` is `JSON.parse(JSON.stringify(...))` because Realm Mixed/dictionaries invalidate after write transactions (`event.ts:412,441`; `models/Event.ts:3-17` documents that nested objects inside payload dictionaries throw "Only Realm instances are supported" — payloads must be flat-ish / JSON-serializable).

- **`mobilityEventScope`** (`utils/mobilityEventScope.ts`, imported by recovery): mobility pipeline events (`mobilityStopSync`, `serviceOrderSync`, service-order photos) do NOT populate the top-level `moveId` column — linkage is inside `payload` (Realm Mixed, not `.filtered()`-able). `collectFailedMobilityEvents` (`recovery.ts:173-205`) does a typed Realm query by the three `MOBILITY_EVENT_TYPES` then narrows in JS via `classifyMobilityEvent`. A replacement's scoping must support both column-based (moveId) and payload-based (mobility) linkage.

- **`prioritySyncComplete`** fires after any move-scoped recovery (`recovery.ts:462-465`) and drives a sendEventLog `priority.sync.start` telemetry event at recovery start (`recovery.ts:329-348`).

- **`recoverable:false` behavior is dual**: excluded from `getFailedEvents` (never shown to driver, `recovery.ts:48-49`) AND skipped in the sweep loop (`recovery.ts:391-394`). Only photoReaper + sendAppDump.

- **Load-order timing**: pipelines can fire before `QueueUtils.initialize()` (e.g. `useFocusEffect` → offerMissedAssignments); `createJob` drops-with-warning rather than throwing (`queue.ts:194-201`), relying on the caller to re-fire on next focus/tick. A replacement must tolerate pre-init enqueue attempts gracefully.

---

## Key files (absolute)

- `/Users/robnewton/github/driver-app-3/utils/event.ts`
- `/Users/robnewton/github/driver-app-3/utils/queue.ts`
- `/Users/robnewton/github/driver-app-3/utils/recovery.ts`
- `/Users/robnewton/github/driver-app-3/utils/errors.ts`
- `/Users/robnewton/github/driver-app-3/utils/background.ts`
- `/Users/robnewton/github/driver-app-3/models/Event.ts`
- `/Users/robnewton/github/driver-app-3/app/(user)/_layout.tsx`
- `/Users/robnewton/github/driver-app-3/node_modules/@hopdrive/react-native-queue/Models/Queue.js`
- `/Users/robnewton/github/driver-app-3/node_modules/@hopdrive/react-native-queue/Models/Worker.js`
- `/Users/robnewton/github/driver-app-3/node_modules/@hopdrive/react-native-queue/config/Database.js`
