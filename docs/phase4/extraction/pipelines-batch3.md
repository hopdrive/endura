# Pipeline Extraction — Batch 3 of 3

Ground-truth behavior extracted by reading code only (no comments/READMEs relied on) from the HopDrive driver app. Repo root: `/Users/robnewton/github/driver-app-3`.

Pipelines covered: mobilityRunSync, mobilityStopSync, mobilityVehicleSync, serviceOrderSync, fuelAuthorizationSync, fuelReimbursementSync, certificationComplete, certificationSync, gpsEventLogSync, geofenceEventSync.

---

## Shared framework facts (apply to all 10 unless overridden)

- **Engine:** each pipeline is a single-stage sequence registered via `pipelineRegister` → `QueueUtils.registerWorker`; `start()` calls `EventUtils.start` which mints an `eventId` (uuid), calls `createEvent`, then enqueues stage-1 job (`createJob`) unless `runStageOneSynchronously`. `utils/event.ts:144-206`.
- **Stage lifecycle:** worker calls `setStage(eventId, name)` → writes Realm `Event{status:'pending', stage:name}` (`event.ts:208-244`); on success `completeStage` → single-stage so `isLastStage` true → `markEventAsSynced` + `onComplete` (`event.ts:429-518`).
- **Connectivity:** every worker's `workerOptions.isJobRunnable` returns `getNonReactiveState().isConnected`; offline jobs are skipped (not failed) and logged via `onSkipped`. No stage does its own reachability probe. Local Realm reads (`getMobilityRunFromLocal` etc.) do not touch network (`utils/mobilityRun.ts:439-459`).
- **`onFailed` (attempts exhausted):** `markEventAsFailed` writes `Event{status:'failed'}` + Sentry `PipelineFailure`. Has a **stale-failure guard**: ignores the failure if the event is already `synced` or has advanced to a different `stage` (`event.ts:561-644`).
- **Domain key on the Event ROW:** `createEvent` sets `moveId = payload.moveId || 0` and `driverId = payload.driverId || 0` — **only camelCase `moveId`/`driverId` are lifted onto the row** (`event.ts:159,681-712`). All other scoping IDs (runId, stopId, orderId, tempVehicleId) live only inside `payload` (Realm.Mixed) and are not queryable via `.filtered()`.
- **Recovery re-arm reality (critical):** `runRecovery` re-arms a failed event only if `jobMapper[event.stage]` exists (`utils/recovery.ts:441-449`). **None of these 10 worker names are in `jobMapper`** (it lists only photo*/driver*/move*/cancel/delete/sendAppDump/sendEventLog/prioritySyncComplete — `recovery.ts:265-283`). So although all 10 default `recoverable=true` (none set the flag), a recovery sweep that collects them logs "unmapped stage" and skips — **none of these pipelines actually re-arm on recovery.** A replacement engine must decide whether that omission is intended.
- **Recovery collection scope:** only `mobilityStopSync.pipeline` and `serviceOrderSync.pipeline` are in `MOBILITY_EVENT_TYPES` (`mobilityEventScope.ts:14-18`), so run-scoped recovery (`getFailedEventsForRun`) collects them by `payload.stopId`/`payload.orderId` — but per above they still can't be re-armed. The other 8 are collected only by the global `getFailedEvents()` sweep, also un-re-armable.

---

### mobilityRunSync
- **Stages (registered order):** `['mobilityRunSync']` (`index.ts:12`)
- **Purpose:** push a locally-modified MobilityRun's status + departed_at/completed_at timestamps to the server.
- **Domain key:** `runId` (payload only); `moveId`/`driverId` on Event row are 0 because payload carries neither (`index.ts:14-16`, `event.ts:159`).
- **Dedupe:** none-intentional — `start` does no pending-event check (`index.ts:26-29`).
- **Retry/timeout:** `jobOptions{ timeout:30000, attempts:10, priority:50 }`; `workerOptions{ concurrency:1, failureBehavior:'standard', minimumMillisBetweenAttempts:10000 }` (`worker.ts:63-72`).
- **Connectivity:** requires network via `isJobRunnable` (`worker.ts:74-78`).
- **Recovery:** `recoverable` unset → default true, but not in `jobMapper` → never re-armed. No synchronous stage-1 (`start` doesn't accept the flag). Not in `MOBILITY_EVENT_TYPES`, so excluded from run-scoped recovery collection.
- **Side effects:** `update_mobility_runs_by_pk` sets status + optional departed_at/completed_at (`mobilityRunMutations.ts:17-27`). **Note: this mutation does NOT null-check the result and does NOT throw `RowFilterRejectedError`** — unlike stop/order sync, a reassigned run silently "succeeds."
- **Notable:** builds timestamps only for fields present on the local row; after write, re-reads local and warns (non-fatal) if status changed mid-sync (`worker.ts:32-54`). No idempotency guard.
- **Citations:** `pipelines/mobilityRunSync/index.ts:12,14-16,26-29`; `pipelines/mobilityRunSync/mobilityRunSync.worker.ts:25-56,63-90`; `queries/mobilityRunMutations.ts:7-28`.

### mobilityStopSync
- **Stages:** `['mobilityStopSync']` (`index.ts:12`)
- **Purpose:** sync a MobilityStop's status + geofence/confirm timestamps to `mobility_stops`, and service/skip fields to the `service_stop_details` 1:1 extension.
- **Domain key:** `stopId` (payload only); Event row `moveId`/`driverId`=0. Run-scoped recovery matches via `payload.stopId ∈ scope.stopIds` (`mobilityEventScope.ts:124-129`).
- **Dedupe:** none-intentional in `start` (`index.ts:26-29`).
- **Retry/timeout:** `{ timeout:30000, attempts:10, priority:50 }`; worker `concurrency:1, standard, 10000ms` (`worker.ts:126-135`).
- **Connectivity:** requires network via `isJobRunnable` (`worker.ts:137-141`).
- **Recovery:** default recoverable; collected by run-scoped sweep but not re-armable (jobMapper miss). No sync stage-1.
- **Side effects:** (1) `update_mobility_stops_by_pk` — status + geofence_arrived_at/geofence_departed_at/driver_confirmed_at; (2) conditionally `update_service_stop_details_by_pk` (PK=stop_id) — service_started_at/service_completed_at/skip_reason_code/skip_notes (`worker.ts:37-73`).
- **Notable:** **`RowFilterRejectedError` handling** — on that error (Hasura `update_X_by_pk === null`) it calls `markEventAsPermanentlyFailed` (status `permanently_failed`), fires a warning-level Sentry message, and **returns without rethrow** (stops burning retries) (`worker.ts:88-120`). Splits fields across two tables because service/skip columns live on the extension table. Re-reads local and warns on concurrent status change.
- **Citations:** `pipelines/mobilityStopSync/mobilityStopSync.worker.ts:28-124,126-135`; `queries/mobilityRunMutations.ts:35-70,118-140`; `utils/errors.ts:14-29`.

### mobilityVehicleSync
- **Stages:** `['mobilityVehicleSync']` (`index.ts:12`)
- **Purpose:** insert a locally-created MobilityVehicle (temp id) to the server, then reconcile the local Realm row to the server-assigned id.
- **Domain key:** `tempVehicleId` (payload only); Event row `moveId`/`driverId`=0 (`index.ts:14-16`).
- **Dedupe:** none-intentional (`index.ts:26-29`).
- **Retry/timeout:** `{ timeout:30000, attempts:10, priority:50 }`; `concurrency:1, standard, 10000ms` (`worker.ts:93-102`).
- **Connectivity:** network via `isJobRunnable` (`worker.ts:104-108`).
- **Recovery:** default recoverable; not in jobMapper → not re-armed. Not mobility-scoped for recovery.
- **Side effects:** `insert_mobility_vehicles_one` with created_by = firebase email or `driver:{id}` fallback; on success Realm write: if server id ≠ temp id, create real-id row (`UpdateMode.Modified`) and **delete the temp record**; else update status in place (`worker.ts:35-82`).
- **Notable:** **NOT idempotent on retry** — a retry after a successful insert whose Realm reconcile failed would insert a second vehicle (insert mutation throws only on duplicate VIN, `mobilityVehicleMutations.ts:90`). No RowFilterRejected path. `insertMobilityVehicle` throws user-friendly errors on GraphQL failure / no data.
- **Citations:** `pipelines/mobilityVehicleSync/mobilityVehicleSync.worker.ts:26-86,93-102`; `queries/mobilityVehicleMutations.ts:38-98`.

### serviceOrderSync
- **Stages:** `['serviceOrderSync']` (`index.ts:12`)
- **Purpose:** sync a ServiceOrder's status + workflow_data + vehicle-ID/technician fields to the server.
- **Domain key:** `orderId` (payload only); Event row `moveId`/`driverId`=0. Run-scoped recovery matches via `payload.orderId ∈ scope.orderIds` (`mobilityEventScope.ts:116-122`).
- **Dedupe:** none-intentional (`index.ts:26-29`).
- **Retry/timeout:** `{ timeout:30000, attempts:10, priority:50 }`; `concurrency:1, standard, 10000ms` (`worker.ts:135-144`).
- **Connectivity:** network via `isJobRunnable` (`worker.ts:146-150`).
- **Recovery:** default recoverable; collected by run-scoped sweep, not re-armable. No sync stage-1.
- **Side effects:** `update_service_orders_by_pk` — status, workflow_data (JSONB; parsed from string if needed), started_at/completed_at, vehicle_vin/make/model/year/color, recommended_followup (`worker.ts:49-82`; `mobilityRunMutations.ts:76-109`).
- **Notable:** same **`RowFilterRejectedError` → `markEventAsPermanentlyFailed` + warning Sentry + no rethrow** branch as mobilityStopSync (`worker.ts:97-129`). Only sends fields that are present. `workflow_data` parse failure is warned but non-fatal. Re-read/concurrent-change warning.
- **Citations:** `pipelines/serviceOrderSync/serviceOrderSync.worker.ts:17-133,135-144`; `queries/mobilityRunMutations.ts:76-109`.

### fuelAuthorizationSync
- **Stages:** `['fuelAuthorizationSync']` (`index.ts:13`)
- **Purpose:** POST a fuel-authorization request (moveId, fuelLevel) to the fuel-auth HTTP API.
- **Domain key:** `moveId` — **lifted onto the Event row** (payload camelCase `moveId`); driverId row = 0 (`index.ts:15-18`, `event.ts:159`).
- **Dedupe:** none-intentional (`index.ts:28-31`).
- **Retry/timeout:** `jobOptions{ timeout:30000, attempts:10, autoStartQueue:true, priority:10 }` (high); `concurrency:1, standard, 10000ms` (`worker.ts:59-89`).
- **Connectivity:** network via `isJobRunnable`; also **hard-requires an auth token before the try block** (`throw` if `Auth.getToken()` empty) (`worker.ts:20-21,91-96`).
- **Recovery:** default recoverable; not in jobMapper → not re-armed. Not mobility-scoped.
- **Side effects:** `axios.post(FUEL_AUTHORIZATION_API_URL, {moveId, fuelLevel}, Bearer token)`. **Lite-driver skip:** if `isLite(driver)` (driver.tax_class==='lite'), it logs, completes the stage, and returns without calling the API (`worker.ts:23-33`; `identity.ts:68`).
- **Notable:** on failure calls `capturePipelineError` with httpStatus before rethrow (`worker.ts:47-57`). Not idempotent — a retry after a server-side-success-but-client-timeout would re-authorize (comment at `worker.ts:103` acknowledges the concern).
- **Citations:** `pipelines/fuelAuthorizationSync/fuelAuthorizationSync.worker.ts:15-57,59-74`; `pipelines/fuelAuthorizationSync/index.ts:15-18`; `utils/identity.ts:68`.

### fuelReimbursementSync
- **Stages:** `['fuelReimbursementSync']` (`index.ts:13`)
- **Purpose:** POST a fuel-reimbursement request (moveId, fuelCost) to the reimbursement HTTP API.
- **Domain key:** `moveId` — lifted onto Event row; driverId row = 0 (`index.ts:15-18`).
- **Dedupe:** none-intentional (`index.ts:28-31`).
- **Retry/timeout:** `{ timeout:30000, attempts:10, autoStartQueue:true, priority:10 }`; `concurrency:1, standard, 10000ms` (`worker.ts:60-90`).
- **Connectivity:** network via `isJobRunnable`; hard-requires auth token before try (`worker.ts:21-22,92-97`).
- **Recovery:** default recoverable; not in jobMapper → not re-armed.
- **Side effects:** `axios.post(FUEL_REIMBURSEMENT_API_URL, {moveId, fuelCost}, Bearer)`. Same **lite-driver skip** as fuel auth (`worker.ts:24-34`).
- **Notable:** identical shape to fuelAuthorizationSync (same jobOptions, capturePipelineError, non-idempotent POST). Distinct API URL and payload key (`fuelCost` vs `fuelLevel`).
- **Citations:** `pipelines/fuelReimbursementSync/fuelReimbursementSync.worker.ts:15-58,60-75`; `pipelines/fuelReimbursementSync/index.ts:15-18`.

### certificationComplete
- **Stages:** `['certificationComplete']` (`index.ts:12`)
- **Purpose:** submit a driver's certification completion (responses + optional quizResult) to the server, then mark the earned cert synced in Realm.
- **Domain key:** `driverId` — lifted onto Event row; moveId row = 0 (`index.ts:14-24`, payload also carries certificationKey/responses/quizResult).
- **Dedupe:** **per-entity by certificationKey** — `start` is async and skips if `hasPendingEventForCertKey(payload.certificationKey)` finds any pending/active CERTIFICATION_COMPLETE event with that key (`index.ts:34-49`; `event.ts:350-364`).
- **Retry/timeout:** `{ timeout:30000, attempts:10, autoStartQueue:true, priority:5 }`; `concurrency:1, standard, 10000ms` (`worker.ts:94-104`).
- **Connectivity:** network via `isJobRunnable`; token fetched inside try (throws if missing) (`worker.ts:45-46,106-110`).
- **Recovery:** default recoverable; not in jobMapper → not re-armed. **Supports `runStageOneSynchronously`** (accepted by `start`, defaults false) (`index.ts:34-48`).
- **Side effects:** `axios.post(SUBMIT_CERTIFICATION_COMPLETION_URL, {driver_id, certification_key, responses, quiz_result?}, Bearer)`; on 2xx (and not `success===false`) `writeEarnedCertToRealm(...true)` (`worker.ts:48-83`). Has an **`onSuccess` hook** that also calls `markEventAsSynced` (`worker.ts:117-120`).
- **Notable:** **existence guard** — bails early (return, no error) if the Event was deleted from Realm before the job ran (`worker.ts:35-39`). Accepts HTTP 2xx as success even without a `success` field; treats status≥400 or `success===false` as failure (`worker.ts:74-76`).
- **Citations:** `pipelines/certificationComplete/certificationComplete.worker.ts:13-92,94-127`; `pipelines/certificationComplete/index.ts:34-49`; `utils/event.ts:350-364`.

### certificationSync
- **Stages:** `['certificationSync']` (`index.ts:17`)
- **Purpose:** pull the certification catalog + driver's earned certs from the server into Realm (a refresh, not a push).
- **Domain key:** `driverId` — lifted onto Event row; moveId row = 0. Payload also `forceRefresh?` (`index.ts:19-22`).
- **Dedupe:** **type-level** — `start` skips if `hasPendingEventAlready('certificationSync.pipeline')` (any pending event of this type) (`index.ts:40-43`; `event.ts:296-298`). Plus an in-worker **24h sync limiter** (`shouldSync()`) bypassed by `forceRefresh` (`worker.ts:37-44`).
- **Retry/timeout:** `{ timeout:30000, attempts:5, autoStartQueue:true, priority:3 }` — **fewer attempts (5), lowest priority, 30s between attempts** (`worker.ts:83-93`).
- **Connectivity:** network via `isJobRunnable` (`worker.ts:95-99`).
- **Recovery:** default recoverable; not in jobMapper → not re-armed. Supports `runStageOneSynchronously` (`index.ts:32-46`).
- **Side effects:** reads `getAllCertifications`, `getCertificationsByRegionId` (driver's region), `getDriverCertifications`; writes catalog + earned certs to Realm via `writeCertificationsToRealm`/`writeEarnedCertsToRealm`; then `markSynced()` timestamp. Has `onSuccess` → `markEventAsSynced` (`worker.ts:45-76,106-109`).
- **Notable:** region-cert fetch failure is caught and warned (non-fatal, empty recommendedKeys). Early-completes the stage when the 24h limiter says skip.
- **Citations:** `pipelines/certificationSync/certificationSync.worker.ts:21-81,83-93`; `pipelines/certificationSync/index.ts:32-47`; `utils/event.ts:296-298`.

### gpsEventLogSync
- **Stages:** `['gpsEventLogSync']` (`index.ts:12`)
- **Purpose:** insert a GPS/telemetry event-log row to the server via the `@hopdrive/sdk-events` `logEvent`.
- **Domain key:** payload uses **snake_case `driver_id`/`move_id`** (`index.ts:14-19`). **Because `createEvent` only reads camelCase `moveId`/`driverId`, the Event row's `moveId`/`driverId` stay 0** — this is an inconsistency vs geofenceEventSync. IDs are available in payload only.
- **Dedupe:** none-intentional (`index.ts:29-32`).
- **Retry/timeout:** `{ timeout:30000, attempts:10, priority:30 }`; `concurrency:1, standard, 10000ms` (`worker.ts:53-62`).
- **Connectivity:** network via `isJobRunnable` (`worker.ts:64-68`).
- **Recovery:** default recoverable; not in jobMapper and not mobility-scoped → not re-armed.
- **Side effects:** `logEvent(event_key, {user: driverEmail, role:'driver', driver_id, move_id, metadata, safeWithResponse:true})` (`worker.ts:32-39`).
- **Notable:** if `eventRes.success === false` it only **logs an error but still completes the stage successfully** (does not throw) — a server-rejected log is treated as done (`worker.ts:41-46`).
- **Citations:** `pipelines/gpsEventLogSync/gpsEventLogSync.worker.ts:11-51,53-62`; `pipelines/gpsEventLogSync/index.ts:14-19`.

### geofenceEventSync
- **Stages:** `['geofenceEventSync']` (`index.ts:12`)
- **Purpose:** insert a geofence enter/exit event to the server; for stop-based (mobile-service) events also stamp the stop's geofence timestamp.
- **Domain key:** payload uses **camelCase `moveId`/`driverId`** → both **lifted onto the Event row** (`index.ts:14-25`, `event.ts:159`). Optional `stopId` in payload (not on row).
- **Dedupe:** none-intentional (`index.ts:35-38`).
- **Retry/timeout:** `{ timeout:30000, attempts:10, priority:30 }`; `concurrency:1, standard, 10000ms` (`worker.ts:69-78`).
- **Connectivity:** network via `isJobRunnable` (`worker.ts:80-84`).
- **Recovery:** default recoverable; not in jobMapper → not re-armed. Explicitly noted as "background telemetry" excluded from mobility scope (`mobilityEventScope.ts:90`).
- **Side effects:** (1) `insertGeofenceEvent({timestamp, driver_id, move_id, event_type, location_id, driver_locations_id, metadata})`; (2) **if `stopId` present**, also `updateMobilityStopStatus(stopId, undefined, {geofence_arrived_at|geofence_departed_at: timestamp})` — field chosen by `eventType === 'geofence_entered' ? arrived : departed` (`worker.ts:38-60`).
- **Notable:** the second (stop) write goes through the status mutation with `status=undefined` (timestamp-only path), which **can throw `RowFilterRejectedError`** (`mobilityRunMutations.ts:66-69`) — but this worker has **no RowFilterRejected branch**, so a reassigned run makes it a plain failure that retries all 10 attempts. Not idempotent (duplicate geofence-event insert on retry).
- **Citations:** `pipelines/geofenceEventSync/geofenceEventSync.worker.ts:11-66,69-78`; `pipelines/geofenceEventSync/index.ts:14-25`; `queries/mobilityRunMutations.ts:35-70`.

---

## Cross-cutting flags a replacement engine must reproduce or fix

1. **Recovery is effectively dead for all 10** — `recoverable=true` by default but zero of these worker stages are in `recovery.ts:jobMapper` (265-283), so sweeps skip them as "unmapped stage."
2. **RowFilterRejected handling is inconsistent:** mobilityStopSync + serviceOrderSync mark `permanently_failed` and stop; but `updateMobilityRunStatus` never null-checks (mobilityRunSync can't detect reassignment), and geofenceEventSync's stop write *can* throw RowFilterRejected but has no handler.
3. **Event-row domain key only captures camelCase `moveId`/`driverId`:** fuel* and geofenceEventSync populate `moveId`; certification* populate `driverId`; but gpsEventLogSync (snake_case) and all mobility/vehicle/order pipelines leave the row at `moveId=0/driverId=0`, so `getFailedEventsByMoveId` won't find them.
4. **Non-idempotent writers on retry:** mobilityVehicleSync (double insert), fuel* (double authorize/reimburse), geofenceEventSync (double geofence row). gpsEventLogSync swallows server rejection as success.
5. Only certification* support synchronous stage-1 and add an `onSuccess`→`markEventAsSynced` hook; certificationSync alone uses attempts:5 / 30s spacing / priority:3.
