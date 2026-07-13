# Pipeline Extraction — Batch 1

Ground-truth behavior extracted from `driver-app-3` production code (code only, no comments/READMEs relied upon for truth). Repo root: `/Users/robnewton/github/driver-app-3`.

---

## Cross-cutting mechanics (apply to every pipeline below)

These come from `utils/event.ts` and govern all records; cited once here rather than repeated per pipeline.

- **Event domain columns**: `createEvent` writes only two indexed scoping columns — `moveId` and `driverId` — read by destructuring the pipeline's *top-level* payload (`const { moveId, driverId } = payload`), each defaulting to `0` when absent (`utils/event.ts:159,681-717`). Any other id (`offerId`, `outcomeId`, `serviceOrderId`) lives only inside the JSON `payload` blob, never as a queryable column.
- **Stage advance / payload accumulation**: `completeStage` merges each stage's `additionalPayload` into `Event.payload` via `setPayload`, then either `markEventAsSynced` + `onComplete` (last stage) or `createNextJob(nextStage, {...additionalPayload, chainData})` (`utils/event.ts:429-518`). `chainData` = `{ callerJobName, step: prevStep+1 }`. Next job's payload is a JSON deep-clone of the accumulated `Event.payload` merged with additions (`createNextJob`, `:405-427`).
- **Stale-failure guard** (`markEventAsFailed`, `:561-644`): ignores a job failure if the Event is already `synced`, or if `event.stage !== job.name` (event advanced past this stage). Prevents a late-timeout retry from downgrading a completed event.
- **Synchronous stage-1**: `start({runStageOneSynchronously})` runs `firstStage.worker(eventId, payload)` inline; on throw it writes `Event.status='failed'` so dedup guards don't permanently block (`:174-196`). Only `photo.pipeline` exposes this flag.
- **Recovery**: `recoverable` defaults true; `isPipelineRecoverable` lets `runRecovery` re-arm only `status=='failed'` events of recoverable types (`:134-139`). `recoverable:false` set on `photoReaper` and `sendAppDump`.
- **Single-stage sync path**: single-worker pipelines also define `onSuccess → markEventAsSynced`; since completeStage on the last stage already syncs, this is a redundant (idempotent) second sync.

---

### photo.pipeline
- **Stages (registered order)**: `photoCapture`, `photoResize`, `photoBlurHash`, `photoPending`, `photoUpload`, `photoSave` (`photo/index.ts:34`). Note `photoResize` was disabled 2023-11-16 then re-enabled 2026-05-05 (`index.ts:23-34`).
- **Purpose**: Capture a workflow/vehicle photo locally, resize/blurhash it, register it pending on the server, upload to S3, and record the final URL server-side.
- **Domain key**: `moveId` (→ Event.moveId column). Alternatively `serviceOrderId` for mobile-service photos, which stays JSON-only (Event.moveId=0). Start requires one of the two (`index.ts:93-95`). Adapter routed by `workflowType==='mobile_service'` or `serviceOrderId && !moveId` (`adapters/registry.ts:25-33`).
- **Dedupe**: None-intentional (no guard in `start`). Idempotency is instead achieved by the "already uploaded" short-circuits in resize/upload workers.
- **Retry/timeout (per stage)**: capture `timeout 15000, attempts 10, autoStart true, priority 45` (`photoCapture:149-164`); resize `timeout 60000, attempts 5, autoStart false`, no priority (`photoResize:122-154`); blurHash `timeout 20000, attempts 1, autoStart true, priority 44` (`photoBlurHash:163-175`); pending `timeout 30000, attempts 10, autoStart false, priority 44` (`photoPending:136-151`); upload `timeout 60000, attempts 3, autoStart false, priority 43` (`photoUpload:398-419`); save `timeout 30000, attempts 10, autoStart false, priority 42` (`photoSave:116-131`). All `concurrency 1`.
- **Connectivity**: `photoPending`/`photoSave` gate `isJobRunnable` on `isConnected` only (`photoPending:168-173`, `photoSave:148-153`). `photoUpload` gates on `isConnected` AND `AppState==='active'` (foreground); returns `runnable:false` to defer WITHOUT consuming an attempt (`photoUpload:438-472`). A prior Android heap-ratio gate was removed (`:454-469`). capture/resize/blurHash have no connectivity gate.
- **Recovery**: recoverable (default true). No synchronous stage-1 unless caller passes `runStageOneSynchronously`.
- **Side effects per stage**:
  - capture: `saveWorkflowPhoto` to disk, `RNFS.stat`, GPS `getCurrentLocation`, adapter `addPhotoToLocal` (Realm write of VehiclePhoto/ServiceOrder), updates active-move Workflow store step value; emits `{uri:savedPath, latitude, longitude, metadata:{original}}` (`photoCapture:44-142`).
  - resize: `resizePhotoToMaxWidth` (in-place file rewrite to 1920w/0.7), `updateLocalPhotoStatus 'Resized'`, adds top-level `metadata.{width,height,file_size_bytes}` (`photoResize:91-115`).
  - blurHash: encodes blurhash from a 200px thumb, mirrors `metadata` JSON onto Realm `VehiclePhoto` row (`photoBlurHash:84-153`).
  - pending: adapter `sendPhotoUrlToServer(status:'pending', metadata)`, adapter `resyncFromServer`, `updateLocalPhotoStatus 'Pending'`, workflow-store extras (`photoPending:86-129`).
  - upload: `uploadPhoto` to S3, **writes url BEFORE status** (`updateLocalPhotoUrl` then `updateLocalPhotoStatus 'Uploaded'`), `Image.prefetch`, `RNFS.unlink` if `deleteOnSuccess`, and for `driver-outcome-*` types calls `updatePhotoUrl` on the outcome (`photoUpload:282-385`).
  - save: adapter `sendPhotoUrlToServer(status:'done')`, resync, `updateLocalPhotoStatus 'Done'` (`photoSave:62-77`).
- **Notable behaviors a replacement must reproduce**:
  - Payload metadata accumulates capture→resize→blurhash and is the source of truth; Realm mirror is only a fallback (`photoPending:62-83`).
  - resize missing-source guard: if source file gone, inspect Realm status (case-insensitive) — `done`→mark synced; `uploaded` w/ http url→hand off to `photoUpload` via `createNextJob`; never-uploaded→captureMessage + mark synced (terminal, not failed) (`photoResize:33-89`).
  - upload has three short-circuits: (a) file exists but Realm already `Uploaded/Done`→skip upload, retry unlink, complete with existing url (`:122-173`); (b) file missing→iOS container-UUID path recovery via current photos dir (`:175-204`); (c) missing+uploaded→complete with existing url, or if `Uploaded` w/o url→throw corruption error; genuinely-missing-never-uploaded→mark VehiclePhoto+Event `Failed` in Realm, captureMessage, return (no retry storm) (`:205-278`). url-before-status ordering is a load-bearing invariant (`:284-295`).
  - blurHash `attempts:1` deliberately (a racing retry duplicates photoPending→photoSave and can overwrite metadata) and its `onFailed` intentionally does NOT advance the pipeline (`:166-189`); its worker always calls completeStage on its own path, even on unexpected throw (`:154-160`).
  - Workflow-store updates are gated on `activeMove.id===moveId && currentStage===stage` (throughout capture/pending/upload/save).

---

### photoReaper.pipeline
- **Stages**: `photoReap` (single) (`photoReaper/index.ts:18`).
- **Purpose**: App-launch sweep that reconciles on-disk photos against server/S3 and cleans up orphans (delegates to `utils/reapPhotos.reapPhotos`).
- **Domain key**: None. Payload is `{}` → Event.moveId=0, driverId=0 (`index.ts:20,54`).
- **Dedupe**: Type-level. `start` returns early if `hasPendingEventAlready('photoReaper.pipeline')` (`index.ts:41-44`), then `clearTerminalEventsByType` drains prior synced/failed rows before enqueue (`:50-51`).
- **Retry/timeout**: `timeout 60000, attempts 2, autoStart false, priority 10` (lowest of all), `concurrency 1`, `minimumMillisBetweenAttempts 30000` (`photoReap:46-74`).
- **Connectivity**: `isJobRunnable` requires `isConnected` AND `AppState==='active'` (`photoReap:76-94`).
- **Recovery**: **`recoverable:false`** (`index.ts:33`) — a failed reap is never re-armed; next launch fires fresh via `(user)/_layout.tsx`. Not synchronous.
- **Side effects**: `reapPhotos()` does disk scan (Phase 1), one batched query + S3 HEADs (Phase 2), bounded re-uploads `REUPLOAD_MAX_PER_SWEEP=5` queued as separate photoUpload jobs, Realm cleanup (Phase 4) (`photoReap:46-52` comment). Worker itself only wraps lifecycle.
- **Notable**: `onSuccess` AND completeStage both mark synced. `start` is idempotent by design to survive `_layout` remounts on logout/login/ErrorBoundary.
- **Citations**: `photoReaper/index.ts:33,41-54`; `photoReap.worker.ts:26-114`.

---

### outcomeSubmit.pipeline
- **Stages**: `outcomeSubmit.stage1CreateDraft`, `outcomeSubmit.stage2SyncWorkflowData`, `outcomeSubmit.stage3Submit` (`outcomeSubmit/index.ts:21`).
- **Purpose**: Full "Submit Report" chain — ensure server draft exists, merge workflow_data, then submit the draft.
- **Domain key**: `moveId` (→ Event.moveId column) (`index.ts:26`). `outcomeId`/`localOutcomeId` JSON-only.
- **Dedupe**: **None-intentional** — deliberately removed; concurrency safety comes from stage 3's SDK `status:'new'` where-clause guard (double-submit fails with concurrent-void guard, surfaced as `local_submission_error`) (`index.ts:44-52`).
- **Retry/timeout**: every stage `timeout 30000, attempts 10, priority 40`, `concurrency 1`, `minimumMillisBetweenAttempts 10000` (`stage1:154-163`, `stage2:60-69`, `stage3:174-183`).
- **Connectivity**: all three gate `isJobRunnable` on `isConnected` (`stage1:165-169`, etc.).
- **Recovery**: recoverable (default). Not synchronous.
- **Side effects**:
  - stage1: `createDraftOutcome` (SDK); if `outcomeId>0` skips create and passes it through (idempotent); on create, `swapLocalForServerRow` deletes local temp Outcome row and creates server-id row in Realm; emits `{outcomeId: serverOutcomeId}` (`stage1:112-141`).
  - stage2: `updateWorkflowData` JSONB merge; validates `outcomeId>0`; skips if empty merge (`stage2:32-52`).
  - stage3: `submitDraftOutcome`; on success `markLocalSynced(status, submitted_at, local_status:'synced', local_pending_submission:false)`; typed-error handling — `InvalidTransitionError`→ if local status `void` flag `local_submission_error`, else treat as success-no-op & mark submitted; `ConcurrentClaimError`/`UnknownAddOnError`/void-race → flag `local_submission_error` + rethrow (`stage3:119-171`).
- **Notable**: stage1 idempotency via `isDraftAlreadyOnServer(outcomeId>0)`; stage3 InvalidTransition-as-success is the key convergence behavior; `capturePipelineError` on all failures.

---

### outcomeWorkflowDataSync.pipeline
- **Stages**: `outcomeWorkflowDataSync.stage1CreateDraft`, `outcomeWorkflowDataSync.stage2SyncWorkflowData` (`outcomeWorkflowDataSync/index.ts:20`). Deliberately omits the submit stage (`:16-19`).
- **Purpose**: Mid-fill sync — create draft if needed and merge captured workflow_data, WITHOUT ever submitting.
- **Domain key**: `moveId` (→ Event.moveId column) (`index.ts:26`). `outcomeId` JSON-only.
- **Dedupe**: None-intentional — stage1 idempotent (skips when `outcomeId>0`), stage2 is a JSONB merge; concurrent enqueues converge. Per-outcome dedup deliberately avoided to not drop in-flight edits (`index.ts:39-43`).
- **Retry/timeout**: both stages `timeout 30000, attempts 10, priority 40`, `concurrency 1`, `min 10000` (`stage1:154-163`, `stage2:63-72`).
- **Connectivity**: both gate on `isConnected` (`stage1:165-169`, `stage2:74-78`).
- **Recovery**: recoverable (default). Not synchronous.
- **Side effects**: stage1 identical to outcomeSubmit stage1 (createDraft, swapLocalForServerRow, emit `{outcomeId}`); stage2 identical `updateWorkflowData` merge (skips empty). Worker files are byte-for-byte siblings of outcomeSubmit's, only `name` and stage2's comment differ (`stage2SyncWorkflowData:11-14`).
- **Notable**: Distinct worker `name` strings exist specifically so the queue treats stage2 as terminal and does NOT auto-advance into a submit stage (`stage2:11-14`).

---

### outcomeStatusSync.pipeline
- **Stages**: `outcomeStatusSync` (single) (`outcomeStatusSync/index.ts:13`).
- **Purpose**: Pull an outcome's current server state and upsert the full row into Realm (status reconciliation).
- **Domain key**: `outcomeId` — **JSON-only**; no moveId/driverId in payload so Event.moveId=0, driverId=0 (`index.ts:15-17`).
- **Dedupe**: None (start just enqueues, `index.ts:27-30`).
- **Retry/timeout**: `timeout 30000, attempts 10, priority 50` (highest tier), `concurrency 1`, `min 10000` (`outcomeStatusSync:102-111`).
- **Connectivity**: gates on `isConnected` (`:113-117`).
- **Recovery**: recoverable (default). Not synchronous.
- **Side effects**: `getOutcomeById`, then `upsertOutcomeRow` writes full Outcome row (all server columns incl. jsonb `workflow_data`/`submission_metadata`/`resolution_metadata` stringified) to Realm with `UpdateMode.Modified`; then `verifyStatusMatch` throws if local status != server status (forces retry); logs terminal `resolved`/`void` (`:68-94`).
- **Notable**: The post-write `verifyStatusMatch` is a hard consistency assertion that will fail (and retry) the stage on any Realm/server mismatch.

---

### offerBundleProcess.pipeline
- **Stages**: `bundleProcess` (single) (`offerBundleProcess/index.ts:17`).
- **Purpose**: Fetch and persist an accepted/assigned offer's full bundle graph (mobility runs, scenarios) into Realm.
- **Domain key**: `driverId` (→ Event.driverId column); `offerId` + `syncedWithDriver` JSON-only (`index.ts:19-23`).
- **Dedupe**: **Per-entity by offerId** via `hasPendingEventMatching(name, p => p.offerId === payload.offerId)` — skips enqueue if a pending event for the same offer exists (guards the "offerBundleProcess storm" from `fetchMissingBundles` re-queuing every refresh) (`index.ts:33-44`; matcher parses JSON payload, `event.ts:305-323`).
- **Retry/timeout**: `timeout 45000, attempts 10, autoStart true, priority 9`, `concurrency 1`, `min 10000` (`bundleProcess:70-80`).
- **Connectivity**: gates on `isConnected` (`:82-86`).
- **Recovery**: recoverable (default). Not synchronous.
- **Side effects**: `getFullOfferWithBundle(offerId)`, `writeFullBundle(offer, syncedWithDriver)` (Realm write incl. mobility_run); if any scenario `scenario_key==='mobile-service-run'` and driverId present, `fetchAndStoreMobilityRunsFromServer(driverId, now-7d)` as non-blocking belt-and-suspenders refresh (`:31-60`).
- **Notable**: `onSuccess` also marks synced. Mobility-run refresh failure is swallowed (warn only). Realm writes idempotent via `UpdateMode.Modified` + don't-regress merge.

---

### offerMissedAssignments.pipeline
- **Stages**: `checkMissedAssignments` (single) (`offerMissedAssignments/index.ts:18`).
- **Purpose**: Detect offers ACCEPTED locally but ASSIGNED on server (missed push), reconcile status and pull the missed bundle.
- **Domain key**: `driverId` (→ Event.driverId column) (`index.ts:20-22`).
- **Dedupe**: **Type-level** — `hasPendingEventAlready` early-return, then `clearTerminalEventsByType` before enqueue (guards the ~18k-row accumulation from firing on every focus/foreground/launch) (`index.ts:32-47`).
- **Retry/timeout**: `timeout 60000, attempts 10, autoStart true, priority 8`, `concurrency 1`, `min 10000` (`checkMissedAssignments:97-107`).
- **Connectivity**: gates on `isConnected` (`:109-113`).
- **Recovery**: recoverable (default). Not synchronous.
- **Side effects**: query local `OfferNotification` where `status==ACCEPTED`; `getSimplifiedOffers(now-7d)`; for each now-ASSIGNED-on-server offer: `updateOfferNotificationStatus(id, ASSIGNED)`, `getFullOfferWithBundle` + `writeFullBundle(offer, true)`; on bundle-fetch failure `updateBundleConfig(id, false)` (`:26-88`).
- **Notable**: server offer matched by `assignedOfferId || offerId` against local accepted ids (`:56-57`). `onSuccess` also marks synced. Early completeStage when no accepted offers / no server offers.

---

### offerStatusSync.pipeline
- **Stages**: `offerStatusSync` (single) (`offerStatusSync/index.ts:20`).
- **Purpose**: Push a locally-changed offer status (accept/decline) up to the server and verify it stuck.
- **Domain key**: `offerId` — **JSON-only**; no driverId/moveId so Event columns=0 (`index.ts:22-24`).
- **Dedupe**: None (start just enqueues, `index.ts:34-37`). Note the index imports `hasPendingEventAlready` but does not use it.
- **Retry/timeout**: `timeout 30000, attempts 10, autoStart true, priority 50` (highest tier — "time-sensitive"), `concurrency 1`, `min 10000` (`offerStatusSync:66-96`).
- **Connectivity**: gates on `isConnected` (`:98-102`).
- **Recovery**: recoverable (default). Not synchronous.
- **Side effects**: `getLocalOfferById`; if offer deleted/absent → completeStage (no-op, treats deletion as success); if local status `OFFERED` → skip sync; else `sendLocalOfferStatusToServer(offerId, status)` and throw if returned status != local status (`:24-59`).
- **Notable**: Missing/deleted offer is a graceful terminal success (offer removed by concurrent refresh), NOT a failure. `onSuccess` also marks synced.

---

### promoSync.pipeline
- **Stages**: `promoSync` (single) (`promoSync/index.ts:18`).
- **Purpose**: Full-refresh the driver's promos (`driverstopromos` + nested `promos`) into Realm.
- **Domain key**: `driverId` (→ Event.driverId column) (`index.ts:20-22`).
- **Dedupe**: None (start just enqueues, `index.ts:32-34`).
- **Retry/timeout**: `timeout 30000, attempts 5, autoStart true, priority 40`, `concurrency 1`, `min 10000` (`promoSync:140-150`).
- **Connectivity**: gates on `isConnected` (`:152-155`).
- **Recovery**: recoverable (default). Not synchronous.
- **Side effects**: `getDriverPromos({driver_id})`; `writeRowsToRealm` upserts each `Promo` and `DriverToPromo` (`UpdateMode.Modified`) THEN **deletes stale** local DriverToPromo rows for that driver not in the incoming id set (full-sync semantics) (`:55-111,131`). Missing driverId → warn + completeStage no-op (`:120-124`).
- **Notable**: Reconciliation deletes local rows absent from server (destructive full-refresh, scoped to `driver_id`). Exposes `__test__` helpers. `onSuccess` also marks synced.

---

### sendAppDump.pipeline
- **Stages**: `sendAppDump` (single) (`sendAppDump/index.ts:21`).
- **Purpose**: Zip + upload device diagnostic dump (Realm DBs, logs, optionally photos) to S3 and log a `driver.app.dump` event.
- **Domain key**: None as columns. Payload uses `user_email`/`driver_id`/`move_id` (underscore names), so `createEvent`'s `{moveId, driverId}` destructure gets undefined → Event.moveId=0, driverId=0. `start` backfills `user_email`/`driver_id`/`move_id` from Auth + active move into the JSON payload only (`index.ts:23-59`).
- **Dedupe**: Type-level — `hasPendingEventAlready` early return before enqueue (`index.ts:57`).
- **Retry/timeout**: `timeout 60000, attempts 5, autoStart true`, no priority set, `concurrency 1`, `min 10000` (`sendAppDump:86-117`).
- **Connectivity**: gates on `isConnected` (`:119-123`).
- **Recovery**: **`recoverable:false`** (`index.ts:44`) — stale dumps have no diagnostic value and re-arming produced the "627 zombie dumps/day" runaway. Not synchronous.
- **Side effects**: `NetworkUtils.sendAppDumpToServer(...exclude)` (build+upload archive); always `logEvent('driver.app.dump', {archiveUrl|'failed_to_upload', dumpStatus, dumpError, origin, timestamp})`; if upload produced no URL, throws to trigger retry (partial-failure still logs the event first) (`:39-79`).
- **Notable**: Upload failure is captured as `partial_failure` and logged before the final throw, so telemetry is emitted even on failure. `onSuccess` also marks synced.

---

Files backing this report: all under `/Users/robnewton/github/driver-app-3/pipelines/` (each pipeline's `index.ts` + worker files), photo adapters under `pipelines/photo/adapters/`, and shared machinery in `/Users/robnewton/github/driver-app-3/utils/event.ts`.
