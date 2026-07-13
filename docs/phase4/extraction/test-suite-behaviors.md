# Driver-App-3 Test Suite: Ground-Truth Behavior Extraction

Scope covered: all of `__tests__/pipelines/**`, `__tests__/workers/**`, the queue/event/recovery engine tests under `__tests__/utils/` (`event.test.ts`, `event.markEventAsFailed.test.ts`, `queue.test.ts`, `recovery.test.ts`, `reapPhotos.test.ts`), plus the two smoke tests that assert engine/pipeline configuration (`smoke/photo-pipeline.test.ts`, `smoke/move-lifecycle.test.ts`, `smoke/offer-flow.test.ts`). A replacement engine must reproduce every assertion below.

---

## The engine's shared worker contract (recurring across all pipelines)

Before the per-file inventory, these are the invariants every worker test re-asserts. A parity engine must honor all of them:

- Each worker calls `EventUtils.setStage(eventId, workerName)` at entry and `EventUtils.completeStage(...)` on success. `setStage` returns `{ start, runInstanceId }`; `completeStage` is called with `(returnValue, eventId, resultObj, start, runInstanceId)` (see driverStatusSync and stage1 tests for the exact positional shape).
- `workerOptions.isJobRunnable({})` returns `{ runnable: true }` when `getNonReactiveState().isConnected` is true, and `{ runnable: false, reason: 'No internet connection' }` when false. This is the universal gate — every network worker has it.
- `workerOptions.onSuccess(jobId, payload)` calls `EventUtils.markEventAsSynced({ realm, eventId })`.
- `workerOptions.onFailed(jobId, payload)` fetches the job via `queue.getJob(jobId)` and calls `EventUtils.markEventAsFailed({ eventId, job })`.
- Throwing from a worker is the retry signal — workers rethrow SDK/network errors so the queue exhausts `jobOptions.attempts` before giving up. Most workers use `attempts: 10, timeout: 30000`; deviations are called out per file.
- `workerOptions`: `concurrency: 1`, `failureBehavior: 'standard'`, `minimumMillisBetweenAttempts: 10000` where present.

---

## Engine core

### `__tests__/utils/event.test.ts`
- **System under test:** `utils/event.ts` pipeline/stage traversal helpers and the pipeline registry.
- **Behavioral assertions:**
  - `getNextStage(pipeline, stage)` returns the next stage in sequence; from the last stage it wraps back to the first stage (circular).
  - `getStageFromSequence(pipeline, name)` resolves a stage by name.
  - `isLastStage(pipeline, stage)` is true only for the final sequence element; false for a non-final stage and false for `undefined`.
  - `register(sequence, pipeline, queue)` records the pipeline in module-level registry state; `getRegisteredPipelines()` exposes it.
  - `isPipelineRecoverable(type)` defaults to **true** for: unregistered types, `null`/`undefined`/`''` input, and pipelines registered without a `recoverable` field. Returns the explicit boolean when `recoverable` is set (`true`/`false`).
  - `getWorkerDisplay(stageName)` returns the registered `{ icon, label }` for a worker; falls back to `{ icon: '📦', label: 'Unknown' }` for unregistered stages, null/undefined input, or workers registered without a `display`.
  - `clearTerminalEventsByType(type)` deletes only events of that type whose status is `synced` or `failed` (terminal), returns the deleted count, and performs exactly one `realm.write`/`realm.delete`. Returns 0 (and does not write) when no terminal events exist or when the realm is closed.
- **Edge cases:** registry is module-state so tests use unique pipeline names to avoid bleed-through; realm-closed guard; non-terminal (`pending`) and different-type events excluded from clearing.
- **Contracts a replacement must reproduce:** recoverable defaults to true (opt-out, not opt-in); stage traversal wraps circularly; terminal = `synced|failed` only; worker display fallback is the literal `📦 Unknown`.

### `__tests__/utils/event.markEventAsFailed.test.ts`
- **System under test:** `EventUtils.markEventAsFailed` stale-failure guard.
- **Behavioral assertions:**
  - **Skips (does not downgrade)** when the existing event row is already `synced` — even at the *same* stage as the failing job (the timed-out original run won the race and completed the pipeline).
  - **Skips** when the event has advanced past the failing job's stage (existing stage `photoUpload`, failing job `photoResize`).
  - **Marks failed** (calls `realm.create('Event', { _id, status: 'failed' }, 'modified')`) only when the event is still `pending` at the exact stage the failing job belongs to (genuine failure).
  - **Marks failed** when there is no existing event row to inspect (`objectForPrimaryKey` returns undefined).
- **Edge cases:** terminal-status race (`synced`/`permanently_failed`); stage-advancement race; missing row. Job carries `payload: JSON.stringify({eventId})` and `data: JSON.stringify({attempts, failedAttempts, errors})`.
- **Contracts:** never downgrade a terminal or stage-advanced event back to `failed`. This is the fix for the move-33055 infinite-recovery loop (5s RNQ timeout fires, original resize promise keeps running to `synced`, retries then fail against a consumed source file). **This is the single most important engine invariant in the suite.**

### `__tests__/utils/queue.test.ts`
- **System under test:** `utils/queue.ts` (`createJob`, `initialize`, `teardown`, `toggleQueueStatus`, `registerWorker`).
- **Behavioral assertions:**
  - `createJob({worker})` is a **no-op that resolves undefined when `queue` is null** (does not throw — the "createJob-of-null Sentry case").
  - When queue exists, `createJob` forwards `(worker.name, payload, jobOptions, autoStart)` — e.g. `('workerA', {x:1}, {}, true)`.
  - `queueAutoStart=false` in store **overrides** a worker's `jobOptions.autoStartQueue=true` — the 4th arg is forced to `false`.
  - `createJob` throws `'Worker definition not provided'` when no worker is passed.
  - `initialize()` is idempotent: returns the existing zustand queue without calling the factory if one exists; otherwise creates a fresh queue, stores it via `setQueue`, and wires exactly one `onQueueStateChanged` + one `onQueueJobChanged` listener.
  - `teardown()` calls `queue.stop()`, invokes both listener unsubscribers, and resets store to `queue=null / queueStatus='inactive' / queueJobs=[]`. Safe to call with no queue.
  - After teardown, the next `initialize()` builds a genuinely fresh queue with fresh listeners (no listener leak).
  - `toggleQueueStatus()` calls `queue.stop()` when status is `active`, `queue.start()` when `inactive`.
  - `registerWorker(queue, worker)` forwards `(name, workerFn, workerOptions)` to `queue.addWorker`, passing `undefined` options when none configured.
- **Edge cases:** null-queue guard, autoStart override precedence, idempotent re-init, teardown-without-queue, listener leak prevention.
- **Contracts:** teardown must make `isAppReady` honest (AuthProvider.logout depends on it) and `loadAppInfra` must be able to re-call initialize safely.

### `__tests__/utils/recovery.test.ts`
- **System under test:** `utils/recovery.ts` (`getFailedEvents`, `runRecovery`).
- **Behavioral assertions:**
  - `getFailedEvents()` **excludes events whose pipeline type is `recoverable=false`** (`photoReaper.pipeline`, `sendAppDump.pipeline`) — returns only `photo` + `moveStatusSync` failures.
  - Returns `[]` (not crash) when only non-recoverable/operational events are failed — critical because the recovery *prompt* (`checkForRecovery`) keys off `getFailedEvents().length`; drivers must not be nagged to resync fire-and-forget events.
  - Returns `[]` when realm is closed.
  - `runRecovery({queue})` — **photo reconciliation:** for a stuck `photo.pipeline` event at stage `photoResize`, it looks up the VehiclePhoto by primary key. If server status is `done`/`Done`/`Uploaded` (case-insensitive) with a URL, it marks the event **synced** and does **not** re-arm (`createNextJob` not called).
  - If the photo has not uploaded (`status:'Pending', url:null`), it re-arms via `createNextJob` and does not mark synced.
  - Non-photo events (e.g. `moveStatusSync`) skip photo reconciliation entirely and always re-arm.
- **Edge cases:** recoverable filter; realm-closed; lowercase `'done'` (81/82 prod rows) vs capital `'Uploaded'`; photo-already-uploaded vs not-yet-uploaded; non-photo bypass.
- **Contracts:** recoverable filter feeds both the recovery screen list and the prompt count; photo reconciliation prevents re-arming already-succeeded photos. Regression for the "Unknown 📦 stuck in Resync Data" bug (2026-05-26).

### `__tests__/utils/reapPhotos.test.ts`
- **System under test:** `utils/reapPhotos.ts` orphan-photo reaper classification (`parseFilename`, `isMoveTerminal`, `classifyAgainstServer`, `findRealmRow`, `processStaleFiles`).
- **Behavioral assertions:**
  - `parseFilename` grammar: `${moveId}.${workflowType}.${stepId}[-${sequence}][.${hash}].${ext}` where `stepId` may span 1–3 dash-separated segments. Validated against a **56-signature corpus scraped from prod S3** (16,172 objects). Returns null for unparseable names, non-numeric moveId, and rejects moveId ≤ 0.
  - `isMoveTerminal(status, cancelStatus)`: true for `delivery successful`/`deliverysuccessful` (case-insensitive), `canceled`/`cancelled` (both spellings, either arg), cancel_status `started`/`delivered`, and `failed`; false for in-progress statuses and empty inputs.
  - `classifyAgainstServer(file, serverRow, hash)` (safe-delete proof): false when no server row, or server row has no URL. True when the server URL contains the same hash **and a HEAD request passes**; true when server URL has a *different* hash (a retake exists); **false when hash matches but HEAD fails**. No-local-hash files return true when HEAD passes.
  - `findRealmRow(realm, moveId, stepId, sequence)` (EC1): matches by `name` (which encodes sequence, e.g. `exterior-1`) first, falls back to `step_id` when sequence is undefined or no name-match exists (legacy rows with null name); undefined when neither matches.
  - `processStaleFiles(files, serverByKey, isOnline)` (EC2): **never deletes without positive proof of server upload.** Refuses to delete when offline (re-buckets to `stale-unverifiable`); refuses when server has no row for the move; deletes only on matching-hash+HEAD-ok or different-hash-retake; refuses when hash matches but HEAD fails. Mixed batches delete safe files and hold unsafe ones. Returns `{filesDeleted, bytesFreed, unverifiableCount, updated[]}`.
- **Edge cases:** 3-segment step ids (wheel/door quadrants), signature/damages with no sequence, offline gate, move-not-in-Realm, HEAD-failure hold-back, legacy null-name rows.
- **Contracts:** deletion requires positive server-upload proof (guards against the Jermaine Stephens 244-photo orphan loss and the 999999 QA data-loss repro). A parity reaper must reproduce the exact bucket-decision matrix.

---

## Photo pipeline

### `__tests__/pipelines/photo.pipeline.test.ts` + `smoke/photo-pipeline.test.ts` + `smoke/move-lifecycle.test.ts` (photo section)
- **System under test:** `pipelines/photo` config and `resolvePhotoAdapter`.
- **Behavioral assertions:**
  - Pipeline name is `photo.pipeline`; the sequence is exactly the **6 stages, in order**: `photoCapture, photoResize, photoBlurHash, photoPending, photoUpload, photoSave`.
  - `resolvePhotoAdapter` routing: `workflowType='mobile_service'` → `service_order` adapter; `pickup`/`delivery` → `move` adapter; falls back to `service_order` when `serviceOrderId` set without `moveId`; falls back to `move` when no discriminator.
  - `adapter.getFilenameSlot(payload)` returns `moveId` for the move adapter, `serviceOrderId` for the service_order adapter.
  - `generatePhotoFileName`/`generateStepName`/`generatePhotoFilePath`/`parsePhotoFilePath` grammar (smoke): filename `12345.pickup.exterior-front-0.abc123.jpg`; hash omitted when absent; custom ext; mobile_service embeds serviceOrderId in the moveId slot (`225.mobile_service.passenger-rear-0.7oCMDPH.jpg`); parse surfaces `serviceOrderId` for mobile_service and keeps `moveId` for back-compat.

### `__tests__/pipelines/photoResize.worker.test.ts`
- **System under test:** `photoResize.worker` missing-source handling.
- **Behavioral assertions:**
  - When the source file exists: resizes normally (`resizePhotoToMaxWidth(uri)`), calls `completeStage`, does not mark synced.
  - When source file is **missing** (`fs.exists` false), it does NOT fail into a recovery loop; it resolves terminally from VehiclePhoto state:
    - status `done`/`Done` (case-insensitive) → `markEventAsSynced`, no `createNextJob`, no resize.
    - status `Uploaded` (uploaded but not saved) → hands off via `createNextJob(eventId, photoUpload, { url })`, does not mark synced.
    - never-uploaded missing photo (`status:'Pending', url:null`) → treated unrecoverable: `Sentry.captureMessage('photoResize: source file missing, unrecoverable', fn)` + `markEventAsSynced`, no re-arm.
- **Edge cases:** timed-out-but-completed prior run consumed the file; lowercase-`done` prod casing; the three VehiclePhoto states.
- **Contracts:** a missing source is never a hard failure — resolve terminally based on server photo state, never re-queue into an infinite loop.

### `__tests__/pipelines/photo.adapters.move.test.ts`
- **System under test:** `MoveAdapter`.
- **Behavioral assertions:** `entityKey='move'`; `resolveContext({moveId})` loads WorkingMove via `getWorkingMoveFromLocal(id)` and throws `'No WorkingMove found with id 99'` when missing; `addPhotoToLocal` delegates to `addPhotoToLocalMove` with **positional args in exact order** `(moveId, workflowId, stage, eventId, stepId, stepName, url, sequence, location)`; `sendPhotoUrlToServer` delegates to `sendLocalPhotoUrlToServer` with a named-arg object (`id, photoId, workingMoveParam, step_id, name, url, workflowId, status, location, createdBy, metadata`); `resyncFromServer` calls `resyncServerMoveFromServer({workingMoveParam})` and returns `true`; `getFilenameSlot` returns `moveId` (0 when missing).

### `__tests__/pipelines/photo.adapters.serviceOrder.test.ts`
- **System under test:** `ServiceOrderAdapter`.
- **Behavioral assertions:** `entityKey='service_order'`; `resolveContext({serviceOrderId})` loads via `realm.objectForPrimaryKey('ServiceOrder', id)`, throws `'No ServiceOrder found with id 225'` when Realm returns null and `'No serviceOrderId on payload for ServiceOrderAdapter'` when the id is absent; `sendPhotoUrlToServer` calls `updateVehiclePhotoOnServiceOrder` with `service_order_id` from context and **throws `'Failed to send photo to server for ServiceOrder 225'` when the mutation returns false**; `resyncFromServer` returns **false** (no-op for service orders — the key asymmetry vs MoveAdapter's true); `getFilenameSlot` returns `serviceOrderId` (0 when missing).
- **Contracts:** realm access is via `getRealmSafely()` (async) here vs synchronous `realm` in MoveAdapter path; resync is a deliberate no-op for service orders.

---

## Outcome submit pipeline (3-stage)

### `__tests__/pipelines/outcomeSubmit/stage1CreateDraft.worker.test.ts`
- **System under test:** stage 1 (offline draft → server-issued outcome id swap).
- **Behavioral assertions:**
  - **No-op when payload already carries a server `outcomeId`** — skips `createDraftOutcome`, still calls `completeStage(undefined, eventId, {outcomeId}, ..., runInstanceId)`.
  - Offline path validates presence: throws `/Missing moveId/`, `/Missing outcomeTypeName/`, `/Missing userEmail/`.
  - On SDK draft success, performs a **delete-then-create dance**: deletes the local negative-id row and creates a new row under the server id (`9001`), inheriting local-only metadata (`local_status:'in_progress'`, `local_pending_submission:true`) and merging server outcomeType fields (`category`, `client_facing`). Server `workflow_data`/`submission_metadata` are **stringified** into the JSONB column.
  - Creates a fresh row (no delete) when no local row is present.
  - `createDraftOutcome` called with `(undefined, {moveId, outcomeTypeName, scenarioId:null, source:'driver_app', createdBy, createdByRole:'driver'})`.
  - Throws `/createDraftOutcome returned no outcome id/` when SDK returns no id; propagates SDK errors so the job retries.
- **Edge cases:** online-vs-offline discriminator (server outcomeId present); negative local id (`-1700000000000`); missing local row.

### `__tests__/pipelines/outcomeSubmit/stage2SyncWorkflowData.worker.test.ts`
- **System under test:** stage 2 (merge workflow data to server).
- **Behavioral assertions:** calls `updateWorkflowData(undefined, {outcomeId, merge, userEmail, userRole:'driver'})`; **skips the SDK call when there is nothing to merge** (`{}` or `undefined` workflowData) but still completes the stage; idempotent — invoking twice sends the identical merge twice; throws `/server-side outcomeId/` when outcomeId is undefined/negative/**0**; throws `/Missing userEmail/`; propagates SDK failures for queue retry.

### `__tests__/pipelines/outcomeSubmit/stage3Submit.worker.test.ts`
- **System under test:** stage 3 (submit draft; the richest error-handling surface in the suite).
- **Behavioral assertions:**
  - Success: calls `submitDraftOutcome(undefined, {outcomeId, workflowData, workflow, submissionMetadata, gpsLat, gpsLng, userEmail, userRole:'driver'})`; writes local row with server status, `local_pending_submission:false`, `local_status:'synced'`, `local_submission_error:undefined`.
  - Propagates the SDK's auto-resolved status (`resolved`) into the local row.
  - Passes through missing GPS without injecting placeholders (stays `undefined`); coerces missing `workflowData`/`submissionMetadata` to `{}`.
  - Validation throws `/server-side outcomeId/` (undefined/negative) and `/Missing userEmail/`.
  - **`InvalidTransitionError` handling is state-dependent:** when the local row is NOT racing a void (localStatus `submitted`), treats it as success-no-op — writes row `submitted`/`synced` so the queue finishes cleanly. When it **races a concurrent void** (localStatus `void`), flags `local_submission_error` matching `/canceled by dispatch/i` (still resolves, no throw).
  - **`ConcurrentClaimError`** → rethrows (queue retry) and flags `local_submission_error` `/claimed by dispatch/i`.
  - **`UnknownAddOnError`** → rethrows and flags `/Unexpected error/i`.
  - **Generic SDK error** racing a concurrent void (localStatus `void`) → flags `/canceled by dispatch/i` and rethrows; generic error at localStatus `submitted` → flags the raw error text (`/graphql 500/`) and rethrows.
- **Edge cases:** the localStatus of the current Realm row (`submitted` vs `void`) changes the branch taken for both InvalidTransitionError and generic errors; typed SDK errors (`InvalidTransitionError`, `ConcurrentClaimError`, `UnknownAddOnError`) each get distinct local-error messaging.
- **Contracts:** InvalidTransitionError is only "success" when not racing a void; the void-race path must flag the row even though it swallows/rethrows. This branching is subtle and tested nowhere else.

### `__tests__/pipelines/outcomeStatusSync/outcomeStatusSync.worker.test.ts`
- **System under test:** `outcomeStatusSync.worker` (pull server outcome → upsert Realm).
- **Behavioral assertions:** `getOutcomeById({outcomeId})`, upserts the full audit-column set (`resolution_type`, `created_by_role`, `reviewed_at/by/by_role`, `resolved_by_role`, etc.); **JSONB columns (`workflow_data`, `submission_metadata`, `resolution_metadata`) are stringified**, but **null JSONB inputs stay null** (never the string `"null"`); passes through terminal `resolved` status without rewriting; throws `/No outcome found on server with id 42/` when server returns null (and does not write); throws `/Realm not available/` when realm null; **throws `/status mismatch/i` when the row read back after write does not match the server status** (so the job retries) — but the write still happened. `jobOptions`: `attempts:10, timeout:30000, priority:50`.
- **Edge cases:** null JSONB vs populated JSONB stringification; post-write read-back verification (mismatch → retry).

---

## Offer pipelines

### `__tests__/pipelines/offerBundleProcess/index.test.ts` + `bundleProcess.worker.test.ts`
- **System under test:** `offerBundleProcess` pipeline + worker.
- **Behavioral assertions:**
  - Pipeline name `offerBundleProcess.pipeline`, single-stage sequence `[BundleProcess]`. `start(payload)` is **async** (awaits a per-offer `hasPendingEventMatching` dedupe guard) and forwards `{pipeline, payload}` unchanged to `pipelineStart`.
  - Worker: `setStage(eventId,'bundleProcess')` → `getFullOfferWithBundle(offerId)` → `writeFullBundle(offer, syncedWithDriver)` → `completeStage`.
  - Throws `'No offerId provided'` when offerId is null (before any fetch); throws `'Failed to fetch bundle data for offer 123'` when `getFullOfferWithBundle` returns null; propagates `writeFullBundle` rejection.
  - `jobOptions`: `{timeout:45000, attempts:10, autoStartQueue:true, priority:9}`. `onSkipped` callback exists and no-ops.
- **Edge cases:** null offerId, null bundle fetch, large bundle (100 scenarios × 10 moves), `syncedWithDriver` true/false pass-through.

### `__tests__/pipelines/offerMissedAssignments/index.test.ts` + `checkMissedAssignments.worker.test.ts`
- **System under test:** `offerMissedAssignments` pipeline + worker (reconcile locally-accepted offers against server assignment state).
- **Behavioral assertions:**
  - Pipeline name `offerMissedAssignments.pipeline`, sequence `[CheckMissedAssignments]`. `start` is async (awaits `hasPendingEventAlready` dedupe), forwards payload unchanged.
  - Worker uses `getRealmSafely()` (async realm access). **Short-circuits to completeStage without calling `getSimplifiedOffers` when there are no locally-accepted offers.** Completes when server returns null offers. For offers whose server status is `assigned`, calls `updateOfferNotificationStatus(id, 'assigned')` and `getFullOfferWithBundle(id)`.
  - **Bundle-fetch failure is handled gracefully:** still calls `updateOfferNotificationStatus`, then `updateBundleConfig(id, false)`, then completeStage (does not throw).
  - Realm errors thrown from `filtered` propagate (worker rethrows).
  - `jobOptions`: `{timeout:60000, attempts:10, autoStartQueue:true, priority:8}`.
- **Edge cases:** no accepted offers (skip server call); null server offers; assigned-offer processing; bundle fetch reject → graceful `updateBundleConfig(id,false)`; realm throw.

### `smoke/offer-flow.test.ts`
- **System under test:** offer status constants + `utils/offer` surface.
- **Behavioral assertions:** `offerStatus` defines `NEW, OFFERED, ACCEPTED, DECLINED, ASSIGNED, RESCINDED, EXPIRED`, all distinct values; `writeOfferNotification` throws `/no offer id/i` on null id and writes to realm on valid data; `updateOfferNotificationStatus`/`deleteOfferNotification` invoke `realm.write`/`realm.delete`; `offerBundleProcess` and `offerStatusSync` pipelines export a name and non-empty sequence.

---

## Certification pipelines

### `__tests__/pipelines/certificationSync/certificationSync.worker.test.ts`
- **System under test:** `certificationSync.worker` (pull all certs + earned + region-recommended into Realm).
- **Behavioral assertions:** **`shouldSync` gate** — skips the whole sync (no `getAllCertifications`) when `shouldSync` is false and not `forceRefresh`; `forceRefresh:true` overrides the gate. Ordered flow: `getAllCertifications` → `getDriverFromLocal(driverId)` for `region_id` → `getCertificationsByRegionId({region_id})` → `writeCertificationsToRealm(realm, allCerts, recommendedKeys)` → `getDriverCertifications({driver_id})` → `writeEarnedCertsToRealm(realm, earned, driverId)` → `markSynced` → `completeStage`. **Region-fetch error is non-fatal:** still writes certs with an **empty recommended-keys array**. Certification-fetch failure rethrows. `jobOptions`: `timeout:30000, attempts:5`.
- **Edge cases:** shouldSync gate + forceRefresh override; region lookup failure degrades to empty recommendations; hard fetch failure rethrows.

### `__tests__/pipelines/certificationComplete/certificationComplete.worker.test.ts`
- **System under test:** `certificationComplete.worker` (POST quiz result to server).
- **Behavioral assertions:** POSTs `{driver_id, certification_key, responses, quiz_result:{passed, score, correct_count, total_questions}}` with `authorization: 'Bearer <token>'`; on success calls `writeEarnedCertToRealm(realm, driverId, key, true)` + completeStage; throws the server `message` on non-200 (`'Invalid certification'`); throws `'No auth token available'` when `getToken` returns undefined; omits `quiz_result` for geographic certs (no `quizResult` in payload). `jobOptions`: `timeout:30000, attempts:10, autoStartQueue:true`.
- **Edge cases:** snake_case field mapping (`correctCount`→`correct_count`); missing token; server rejection; geographic (quizResult undefined).

---

## Event-log / diagnostics pipelines

### `__tests__/pipelines/sendEventLog/index.test.ts` + `sendEventLog.worker.test.ts`
- **System under test:** `sendEventLog` pipeline + worker (generic event logging via `@hopdrive/sdk-events`).
- **Behavioral assertions:**
  - `start(input)` builds a defaulted payload: injects `user_email` (getDriverEmail), `driver_id` **cast to Number** (getDriverId), `move_id` (activeMove.id); **spreads `metadata` into the root payload and deletes the nested `metadata` key**; **always calls `pipelineStart` — no dedupe guard** (unlike sendAppDump).
  - Worker calls `logEvent(event_key, {user, role:'driver', driver_id, move_id, location_id, lane_id, customer_id, metadata, safeWithResponse:true})`; **reconstructs `metadata` by stripping known keys from the payload** (unknown fields like `customField` fall into metadata); **does not throw when `logEvent` returns `{success:false}`** — still completes the stage.
  - `jobOptions`: `{timeout:5000, attempts:10, autoStartQueue:true}` (note the short 5s timeout). `isJobRunnable` gated on connectivity; `onSuccess`→markEventAsSynced, `onFailed`→markEventAsFailed.
- **Edge cases:** metadata flatten + nested-key delete; unknown-key → metadata reconstruction; no-metadata start; `logEvent` failure-response is non-fatal; driver_id numeric coercion.

### `__tests__/pipelines/sendAppDump/index.test.ts` + `sendAppDump.worker.test.ts`
- **System under test:** `sendAppDump` pipeline + worker (upload diagnostic archive, then log the event).
- **Behavioral assertions:**
  - `start` builds defaulted payload (`user_email`, `driver_id` **left as string here**, `move_id`), passes through `origin`, and **is deduped by `hasPendingEventAlready('sendAppDump.pipeline')`** — skips `pipelineStart` when a pending dump already exists.
  - Worker calls `sendAppDumpToServer(null, null, origin, undefined)`; on success `logEvent('driver.app.dump', {..., metadata:{archiveUrl, dumpStatus:'success', dumpError:null, origin, timestamp}})` and completeStage.
  - **On upload failure it still calls `logEvent`** with `archiveUrl:'failed_to_upload', dumpStatus:'partial_failure', dumpError:<message>` — then **rethrows** `'App dump failed: <message>'`.
  - `logEvent` failure-response is non-fatal (completes stage).
  - `jobOptions`: `{timeout:60000, attempts:5, autoStartQueue:true}`.
- **Edge cases:** dedupe guard (this pipeline is `recoverable=false`); upload failure logs partial_failure then throws; timestamp always present.
- **Contract:** `sendAppDump` and `sendEventLog` diverge deliberately — sendAppDump dedupes and casts driver_id as string; sendEventLog never dedupes and casts to Number.

### `__tests__/pipelines/prioritySyncComplete/prioritySyncComplete.worker.test.ts`
- **System under test:** `prioritySyncComplete.worker` (emit a completion event with a failed-event count).
- **Behavioral assertions:** calls `getFailedEventsByMoveId(String(moveId))` (moveId stringified) → `startSendEventLogPipeline({event_key:'priority.sync.complete', metadata:{moveId, type:'prioritySyncComplete', failedEvents:<count>}})`; the count reflects the number of failed events returned; rethrows pipeline errors. `jobOptions`: `{timeout:30000, attempts:5, priority:10}` (lowest priority). `onFailed`→markEventAsFailed.
- **Edge cases:** moveId→string coercion; failedEvents count propagation.

---

## Standalone status-sync workers

### `__tests__/workers/driverStatusSync.worker.test.ts`
- **System under test:** `pipelines/driverStatusSync/driverStatusSync.worker`.
- **Behavioral assertions:** `jobOptions` `timeout:30000, attempts:10`; `workerOptions` `concurrency:1, failureBehavior:'standard', minimumMillisBetweenAttempts:10000`; `isJobRunnable` connectivity gate; `onSuccess`→`markEventAsSynced({realm, eventId})`; `onFailed`→`getJob` then `markEventAsFailed({eventId, job})`. Worker sync flow: `setStage(eventId, 'driverStatusSync')` → `getDriverFromLocal(id)` → `sendLocalDriverStatusToServer({id})` → `refreshDriverFromServer({id})` → `getDriverFromLocal(id)` again → `completeStage(undefined, eventId, {}, start, runInstanceId)`.
- **Edge cases:** a skipped test documents an intended-but-unimplemented "throw when local and server statuses do not match after sync" contract (`.skip`) — **not currently enforced**.

### `__tests__/workers/moveStatusSync.worker.test.ts`
- **System under test:** `pipelines/moveStatusSync/moveStatusSync.worker`.
- **Behavioral assertions:** same `jobOptions`/`workerOptions` shape as driverStatusSync; `onFailed`→`markEventAsFailed({eventId, job})`. The full worker-flow block (get→send→resync, and the "throw when statuses do not match after sync" post-condition) is `describe.skip`'d — the **sync-mismatch throw is documented but not actively tested**.
- **Move-lifecycle status contracts (`smoke/move-lifecycle.test.ts`):** `driveStatus`/`cancelStatus`/`moveTypes` constant maps; `getNextStatus` advances the drive chain and clamps at `delivery successful`; `getMoveProgress` is monotonic across drive statuses and returns `1` at `delivery successful` (with a fixed bug note: it previously matched underscore-normalized status against space-valued constants and always returned 0); ride progress (`in_progress`→5/6, `completed`→1); `isMoveOperationallyDone`/`isMoveCanceled` for drive+ride incl. `cancel_status` rescheduled/started; `translateStatusToColumn`; `cancelMoveStatusSync.pipeline` config.

---

## BEHAVIORS TESTED NOWHERE ELSE

These are assertions that live only in tests — a parity engine will pass implementation review but silently regress unless the parity suite reproduces them:

1. **markEventAsFailed stale-failure guard** (`event.markEventAsFailed.test.ts`). The rule "never downgrade an event that is already `synced`/`permanently_failed`, or that has advanced past the failing job's stage" is the fix for the move-33055 infinite-recovery loop. Same-stage-but-already-synced is the non-obvious case — the original timed-out run won the race. Without this, timeout + eventual-success produces an eternally re-armed "failed" event.

2. **Recoverable filter is opt-out, defaulting to true** (`event.test.ts`, `recovery.test.ts`). `isPipelineRecoverable` returns true for unregistered/null/empty types and pipelines with no `recoverable` field. `getFailedEvents` uses this to exclude `photoReaper`/`sendAppDump` so `checkForRecovery` (which keys off `.length`) doesn't nag drivers about fire-and-forget events. The count must be 0 when only operational events failed.

3. **photoResize missing-source is terminal, never a retry loop** (`photoResize.worker.test.ts` + `recovery.test.ts` photo reconciliation). A missing source file resolves from VehiclePhoto state (`done`/`Uploaded`/never-uploaded) — synced, hand-off, or unrecoverable-synced-with-Sentry — but *never* re-queues. Server status casing is case-insensitive (prod stores lowercase `done`, 81/82 rows).

4. **createJob null-queue guard returns undefined, does not throw** (`queue.test.ts`). Real Sentry incident. Plus `queueAutoStart=false` overrides a worker's `autoStartQueue=true` — precedence not visible from the worker definition.

5. **queue teardown/re-initialize listener hygiene** (`queue.test.ts`). teardown must stop the queue, run both unsub functions, and reset store; the next initialize must build a fresh queue with fresh listeners (no leak). Load-bearing for logout→login without a queue leak, and for `isAppReady` honesty.

6. **stage3Submit error branching is Realm-local-state dependent** (`outcomeSubmit/stage3Submit.worker.test.ts`). `InvalidTransitionError` and generic SDK errors take *different* branches depending on whether the current local row status is `void` (concurrent void race → flag `canceled by dispatch`, may swallow) vs `submitted` (success-no-op or rethrow-with-raw-error). Each typed SDK error (`InvalidTransitionError`/`ConcurrentClaimError`/`UnknownAddOnError`) maps to distinct `local_submission_error` text.

7. **outcomeStatusSync post-write read-back verification** (`outcomeStatusSync.worker.test.ts`). After writing, it re-reads the row and throws `status mismatch` to force a retry if the local status didn't take — even though the write already occurred. Also: null JSONB stays null, never the string `"null"`.

8. **reapPhotos "positive proof" deletion matrix** (`reapPhotos.test.ts`). Delete requires (matching-or-different hash in server URL) AND a passing HEAD; offline, no-server-row, and HEAD-failure all hold the file as `stale-unverifiable`. `findRealmRow` matches by sequence-encoding `name` before `step_id`. This is verified against a 56-signature real prod-S3 corpus. Data-loss guard (Jermaine Stephens 244-photo / 999999 QA repro).

9. **stage1 delete-then-create id swap** (`outcomeSubmit/stage1CreateDraft.worker.test.ts`). Offline outcomes carry a negative local id; on draft creation the negative-id Realm row is deleted and re-created under the server id, preserving local-only metadata (`local_status`, `local_pending_submission`) and merging server outcomeType fields. Not obvious from the worker's happy path.

10. **sendEventLog vs sendAppDump divergence** (both index tests). sendEventLog never dedupes and casts `driver_id` to Number and flattens `metadata` into root; sendAppDump dedupes via `hasPendingEventAlready` and keeps `driver_id` as string. The worker-side `logEvent` `{success:false}` response is non-fatal in both.

11. **certificationSync `shouldSync` gate + non-fatal region fetch** (`certificationSync.worker.test.ts`). The sync is entirely skipped unless `shouldSync` or `forceRefresh`; a region-lookup failure degrades to empty recommended-keys rather than failing the job.

12. **offerMissedAssignments graceful bundle-fetch degradation** (`checkMissedAssignments.worker.test.ts`). A `getFullOfferWithBundle` rejection does not fail the job — it still updates notification status and calls `updateBundleConfig(id, false)`. Also short-circuits (no server call) when no locally-accepted offers exist.

13. **The two status-sync workers document an unenforced contract** (`driverStatusSync`/`moveStatusSync` worker tests). "Throw when local and server statuses do not match after sync" exists only as `.skip`'d tests — a parity engine should decide whether to actually enforce this, because the current app does not.

All file paths referenced are absolute under `/Users/robnewton/github/driver-app-3/`.
