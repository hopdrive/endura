# Pipeline Extraction — Batch 2

Ground-truth behavior extracted from driver-app-3 source (code only, not comments/READMEs).
Repo root: /Users/robnewton/github/driver-app-3

## Shared behavior (all 10 pipelines)

From `utils/event.ts`:
- Each is a **single-stage** pipeline (`sequence = [OneWorker]`). Because `completeStage` checks `isLastStage`, completing the one stage immediately marks the Event `synced` and fires `onComplete` (`utils/event.ts:486-497`).
- The **domain key is stamped on the Event row at creation**: `start()` reads `moveId`/`driverId` off the payload and passes them to `createEvent`, which writes `moveId: moveId || 0` and `driverId: driverId || 0` columns plus a fresh `eventId = uuid.v4()` (`utils/event.ts:159-170, 681-712`). The `eventId` is added to the payload before stage 1 runs.
- **Recovery re-arm**: `recoverable` defaults to true for any pipeline that doesn't set it false (`utils/event.ts:134-139`). None of these 10 set `recoverable:false`, so all are re-armable by recovery sweeps — except events marked `permanently_failed`, which recovery excludes (only `status=='failed'` is re-armed) (`utils/event.ts:51-64`, comment at 646-655).
- **Connectivity gate is identical everywhere**: `workerOptions.isJobRunnable` returns `getNonReactiveState().isConnected`; when offline the job is skipped with reason "No internet connection". Same in every worker.
- **RowFilterRejectedError** = Hasura accepted the request but wrote no rows (`update_X_by_pk === null` or `affected_rows === 0`), meaning the move was reassigned/deleted — a permanent server refusal (`utils/errors.ts:1-27`).

---

### moveStatusSync
- Stages (in registered order): `moveStatusSync`
- Purpose: Push local move.status to server (unless pullOnly), then pull authoritative server move back into local Realm.
- Domain key: moveId. Set on Event via `start()` → `createEvent({moveId})` (`index.ts:38-41`, `event.ts:159-170`).
- Dedupe: none-intentional — `start()` calls `pipelineStart` with no pending-guard (`index.ts:38-41`).
- Retry/timeout: `timeout: 30000`, `attempts: 10`, `priority: 50`; `minimumMillisBetweenAttempts: 10*1000`, `concurrency: 1`, `failureBehavior: 'standard'` (`worker.ts:142-172`).
- Connectivity: yes — `isJobRunnable` requires `isConnected` (`worker.ts:174-179`).
- Recovery: recoverable = true (unset). Not synchronous (plain `pipelineStart`, not awaited — `index.ts:40`). Permanent-failure: `RowFilterRejectedError` → `markEventAsPermanentlyFailed` + one warning Sentry, returns without rethrow (`worker.ts:100-127`).
- Side effects: `MoveUtils.sendLocalMoveStatusToServer` (server move status mutation — skipped when `pullOnly`), then `MoveUtils.resyncServerMoveFromServer` (overwrites local move from server) (`worker.ts:40-53`).
- Notable behaviors: `pullOnly` payload flag skips the push (server-source-of-truth case, e.g. outcome void reverting status) (`index.ts:15-28`, `worker.ts:36-47`). Post-sync divergence (local.status !== server.status) is **no longer thrown** — it fires one warning-level Sentry capture with the local/server status pair and completes the stage (deliberate anti-retry-storm fix, `worker.ts:56-89`). `workingMoveAfterSync` hoisted so the catch's `capturePipelineError` includes status/updatedAt pairs (`worker.ts:23, 129-137`). `onFailed` → `markEventAsFailed`.
- Citations: `index.ts:13,38-41`; `worker.ts:13-90,100-137,142-179,186-190`.

### moveDriverStatusSync
- Stages: `moveDriverStatusSync`
- Purpose: Push local move driver_status to server, pull server move back, assert local/server status match.
- Domain key: moveId, via `start()` → `createEvent({moveId})` (`index.ts:27-29`).
- Dedupe: none-intentional (`index.ts:27-29`).
- Retry/timeout: `timeout: 30000`, `attempts: 10`, `priority: 10`, `autoStartQueue: true`; `minimumMillisBetweenAttempts: 10*1000`, `concurrency: 1`, `failureBehavior: 'standard'` (`worker.ts:83-113`).
- Connectivity: yes — `isJobRunnable` requires `isConnected` (`worker.ts:115-120`).
- Recovery: recoverable = true. Not synchronous. Permanent-failure: `RowFilterRejectedError` → `markEventAsPermanentlyFailed` + warning Sentry, returns (`worker.ts:49-76`).
- Side effects: `MoveUtils.sendLocalMoveDriverStatusToServer` (server driver-status mutation), then `MoveUtils.resyncServerMoveFromServer` (`worker.ts:27-33`).
- Notable behaviors: **still throws** `"Driver statuses do not match after sync."` when `localMove.status !== serverMove.status` post-sync — unlike moveStatusSync, this one was NOT converted to a warning, so a mismatch burns all 10 retries then fails/recovers (`worker.ts:37-42`). A replacement engine must reproduce this hard-throw. `onFailed` → `markEventAsFailed`.
- Citations: `index.ts:13,27-29`; `worker.ts:13-42,49-78,83-120,127-130`.

### moveWorkflowOutputSync
- Stages: `moveWorkflowOutputSync`
- Purpose: Push a move's per-stage workflow output (photos/inspection data) to server, then resync server move to local.
- Domain key: moveId, via `start()` → `createEvent({moveId})`. Payload also carries `stage: string` (`index.ts:15-18,28-30`).
- Dedupe: none-intentional (`index.ts:28-30`).
- Retry/timeout: `timeout: 30000`, `attempts: 10`, `priority: 50`; `minimumMillisBetweenAttempts: 10*1000`, `concurrency: 1`, `failureBehavior: 'standard'` (`worker.ts:116-146`).
- Connectivity: yes (`worker.ts:148-153`).
- Recovery: recoverable = true. Not synchronous. Permanent-failure: `RowFilterRejectedError` → `markEventAsPermanentlyFailed` + warning Sentry (with `stage` in context), returns (`worker.ts:81-109`).
- Side effects: inline `sendLocalMoveWorkflowOutputToServer` builds a `row` {move_id, moveStatus, vin, year, make, model, color, stock, workflow_data} and calls `updateMoveWithWorkflowOutput(row, stage)`; throws if it returns falsy. Then `MoveUtils.resyncServerMoveFromServer` (`worker.ts:27-73`).
- Notable behaviors: reads `move[`${stage}_workflow_data_obj`]` or `move[`${stage}_workflow_data`]`; JSON.parses if string (`worker.ts:39-42`). `stage` payload key is required and threaded into the mutation and all Sentry contexts. `onFailed` → `markEventAsFailed`.
- Citations: `index.ts:13,15-18,28-30`; `worker.ts:15-73,81-111,116-153,160-163`.

### moveUpdateSync
- Stages: `moveUpdateSync`
- Purpose: Pull a full move from server by id and overwrite local Realm copy (server → local only; no push).
- Domain key: moveId, via `start()` → `createEvent({moveId})` (`index.ts:15-17,27-29`).
- Dedupe: none-intentional (`index.ts:27-29`).
- Retry/timeout: `timeout: 30000`, `attempts: 10`, `priority: 10`, `autoStartQueue: true`; `minimumMillisBetweenAttempts: 10*1000`, `concurrency: 1`, `failureBehavior: 'standard'` (`worker.ts:42-72`).
- Connectivity: yes (`worker.ts:74-79`).
- Recovery: recoverable = true. Not synchronous. **No RowFilterRejectedError branch** — any error is captured via `capturePipelineError` and rethrown (retries + eventual fail) (`worker.ts:35-39`).
- Side effects: `getMoveFromServerById({move_id})` (read), then `MoveUtils.writeMoveToLocal(moveFromServer)` (local write). Throws if server returns no move (`worker.ts:27-32`).
- Notable behaviors: Guards `if (!moveId) throw` before try block (`worker.ts:16`). Has an `onSuccess` → `markEventAsSynced` in addition to completeStage's own sync mark (`worker.ts:86-89`). `onFailed` → `markEventAsFailed`.
- Citations: `index.ts:13,15-17,27-29`; `worker.ts:12-39,42-79,86-94`.

### cancelMoveStatusSync
- Stages: `cancelMoveStatusSync`
- Purpose: Resync server move to local and confirm the move's `cancel_status` now matches between local and server.
- Domain key: moveId, via `start()` → `createEvent({moveId})` (`index.ts:20-22,32-36`).
- Dedupe: **type-level** — `start()` awaits `hasPendingEventAlready(name)` where `name = 'cancelMoveStatusSync.pipeline'`; returns early if a pending Event of that type exists (`index.ts:32-35`; `event.ts:296-298` → `getPendingEventsByType` filters `type == $0 && status == "pending" limit(1)`).
- Retry/timeout: `timeout: 30000`, `attempts: 10`, `priority: 10`; `minimumMillisBetweenAttempts: 10*1000`, `concurrency: 1`, `failureBehavior: 'standard'` (`worker.ts:41-71`).
- Connectivity: yes (`worker.ts:73-78`).
- Recovery: recoverable = true. Not synchronous. No RowFilterRejectedError branch — errors are logged and rethrown (`worker.ts:35-38`).
- Side effects: `MoveUtils.resyncServerMoveFromServer` (local overwrite from server) only; no push (`worker.ts:26-28`).
- Notable behaviors: **throws** `'ServerMove and LocalMove cancel_status do not match'` when `localMove.cancel_status !== serverMove.cancel_status` after resync (`worker.ts:30-32`) — a replacement engine must reproduce this assertion. `onFailed` → `markEventAsFailed`.
- Citations: `index.ts:1-9,18,20-22,32-36`; `worker.ts:11-38,41-78,85-88`.

### deleteNonMatchingMovesSync
- Stages: `deleteNonMatchingMovesSync`
- Purpose: Delete local moves that no longer match the driver's server-side assignment set (Realm cleanup).
- Domain key: driverId, via `start()` → `createEvent({driverId})` (`index.ts:21-23,33-41`). driverId is only carried on the Event; the worker does not use it (calls `deleteNonMatchingLocalMoves()` with no arg).
- Dedupe: **type-level + terminal cleanup** — `start()` returns early if `hasPendingEventAlready(name)`; then calls `clearTerminalEventsByType(name)` to delete prior synced/failed rows before queueing (runs on every foreground/launch/refresh, so this prevents ~14k-row accumulation) (`index.ts:33-41`; `event.ts:331-348`).
- Retry/timeout: `timeout: 30000`, `attempts: 10`, `priority: 10`, `autoStartQueue: true`; `minimumMillisBetweenAttempts: 10*1000`, `concurrency: 1`, `failureBehavior: 'standard'` (`worker.ts:24-54`).
- Connectivity: yes (`worker.ts:56-61`). Note: worker does no network I/O itself, but the gate still applies.
- Recovery: recoverable = true. Not synchronous. No RowFilterRejectedError branch (`worker.ts:18-21`).
- Side effects: `MoveUtils.deleteNonMatchingLocalMoves()` — local-only Realm deletion (`worker.ts:15`).
- Notable behaviors: The `clearTerminalEventsByType` drain at enqueue is the key behavior; combined with the pending-guard it keeps at most one live event of this type. `onFailed` → `markEventAsFailed`.
- Citations: `index.ts:1-12,19,21-23,33-41`; `worker.ts:11-21,24-61,68-71`.

### driverInfoSync
- Stages: `driverInfoSync`
- Purpose: Push local driver profile info to server (push-only).
- Domain key: driverId, via `start()` → `createEvent({driverId})` (`index.ts:20-22,32-38`).
- Dedupe: **type-level** — `start()` returns early (with log) if `hasPendingEventAlready(name)` (`index.ts:32-37`).
- Retry/timeout: `timeout: 30000`, `attempts: 10`, `priority: 10`, `autoStartQueue: true`; `minimumMillisBetweenAttempts: 10*1000`, `concurrency: 1`, `failureBehavior: 'standard'` (`worker.ts:31-61`).
- Connectivity: yes (`worker.ts:63-68`).
- Recovery: recoverable = true. Not synchronous. No RowFilterRejectedError branch (`worker.ts:25-28`).
- Side effects: `DriverUtils.sendLocalDriverInfoToServer({ id: driverId })` — server driver-info mutation (`worker.ts:22`).
- Notable behaviors: has `onSuccess` → `markEventAsSynced` in addition to completeStage's sync (`worker.ts:75-78`). `onFailed` → `markEventAsFailed`.
- Citations: `index.ts:1-9,18,20-22,32-38`; `worker.ts:10-28,31-68,75-83`.

### driverStatusSync
- Stages: `driverStatusSync`
- Purpose: Push this device's driver.status to server, refresh driver from server, verify status unchanged.
- Domain key: driverId, via `start()` → `createEvent({driverId})` (`index.ts:20-22,27-36`).
- Dedupe: none-intentional — `start()` calls `pipelineStart` with no pending guard (`index.ts:27-36`).
- Retry/timeout: `timeout: 30000`, `attempts: 10`, `priority: 10`, `autoStartQueue: true`; `minimumMillisBetweenAttempts: 10*1000`, `concurrency: 1`, `failureBehavior: 'standard'` (`worker.ts:112-142`).
- Connectivity: yes (`worker.ts:144-149`).
- Recovery: recoverable = true. **Supports synchronous stage-1**: `start()` accepts `runStageOneSynchronously` and `await`s `pipelineStart(...runStageOneSynchronously)`; when true, stage 1 runs inline and, on throw, the Event is force-marked `failed` before rethrow so dedupe guards don't block future attempts (`index.ts:27-36`; `event.ts:144-206`). This is the **only** pipeline of the 10 that plumbs the synchronous path. No RowFilterRejectedError branch (`worker.ts:106-109`).
- Side effects: snapshot `getDriverFromLocal`, `sendLocalDriverStatusToServer({id})` (server mutation), `refreshDriverFromServer({id})` (local overwrite), re-read local (`worker.ts:70-73`).
- Notable behaviors: **Missing-driverId fallback** — if `payload.driverId` is falsy, falls back to `getNonReactiveState().driverId` (live logged-in driver), tags Sentry warning; if no live driver either, completes stage as a no-op and returns (anti-retry-storm for W0R) (`worker.ts:35-67`). Post-sync divergence (`newDriver.status !== oldDriver.status`) fires a warning Sentry capture and completes — **does not throw** (parallel to moveStatusSync) (`worker.ts:75-103`). `onSuccess` → `markEventAsSynced`; `onFailed` → `markEventAsFailed`.
- Citations: `index.ts:13,20-22,27-36`; `worker.ts:11-67,70-105,112-149,156-164`.

### prioritySyncComplete
- Stages: `prioritySyncComplete`
- Purpose: On completion of a priority sync for a move, count that move's failed events and emit a `priority.sync.complete` event-log (fans out into the sendEventLog pipeline).
- Domain key: moveId, via `start()` → `createEvent({moveId})` (`index.ts:15-17,27-29`).
- Dedupe: none-intentional (`index.ts:27-29`).
- Retry/timeout: `timeout: 30000`, **`attempts: 5`** (lower than the family's 10), `priority: 10`; `minimumMillisBetweenAttempts: 10*1000`, `concurrency: 1`, `failureBehavior: 'standard'`. Note: `autoStartQueue` is not set (`worker.ts:44-71`).
- Connectivity: yes (`worker.ts:73-78`).
- Recovery: recoverable = true. Not synchronous. No RowFilterRejectedError branch (`worker.ts:38-41`).
- Side effects: reads `RecoveryUtils.getFailedEventsByMoveId(moveId.toString())`; **starts a second pipeline** — `startSendEventLogPipeline({event_key:'priority.sync.complete', metadata:{moveId, type:'prioritySyncComplete', failedEvents: failedEvents.length}})` (`worker.ts:26-35`). No direct server mutation of its own; the server write happens inside the spawned sendEventLog pipeline.
- Notable behaviors: cross-pipeline fan-out (imports `start` from `../sendEventLog`). A replacement engine must reproduce this pipeline-spawns-pipeline chaining. `onFailed` → `markEventAsFailed`.
- Citations: `index.ts:13,15-17,27-29`; `worker.ts:1-8,14-41,44-78,85-88`.

### sendEventLog
- Stages: `sendEventLog`
- Purpose: Insert an event-log record on the server via `@hopdrive/sdk-events` `logEvent`.
- Domain key: none required. `start()` does NOT pass moveId/driverId to `createEvent`, so the Event's `moveId`/`driverId` columns default to 0 (`index.ts:40-64`; `event.ts:159` destructures `{moveId,driverId}` from payload — absent here). The log record's `driver_id`/`move_id` are resolved separately (see below).
- Dedupe: none-intentional (`index.ts:40-64`).
- Retry/timeout: **`timeout: 5000`** (shortest of the 10), `attempts: 10`, `autoStartQueue: true`. No `priority` set. `minimumMillisBetweenAttempts: 10*1000`, `concurrency: 1`, `failureBehavior: 'standard'` (`worker.ts:87-115`).
- Connectivity: yes (`worker.ts:117-122`).
- Recovery: recoverable = true. Not synchronous. No RowFilterRejectedError branch — errors logged/rethrown; also, a `logEvent` soft-failure (`eventRes.success === false`) is only logged as `err`, NOT thrown, so the stage still completes/syncs (`worker.ts:64-80`).
- Side effects: `logEvent(event_key, {user, role:'driver', driver_id, move_id, location_id, lane_id, customer_id, metadata, safeWithResponse:true})` — server event-log insert (`worker.ts:64-74`).
- Notable behaviors: **Payload flattening** — because payloads can't nest objects, `start()` spreads `metadata` into the payload root and deletes the `metadata` key, and injects `user_email`/`driver_id`/`move_id` from `Auth.getDriverEmail()`, `Auth.getDriverId()`, and `GlobalStore...activeMove?.id` (`index.ts:42-54`). The worker then **reconstructs** `metadata` by cloning the payload and deleting the known top-level keys (eventId, event_key, user_email, driver_id, move_id, location_id, lane_id, customer_id) (`worker.ts:44-52`). A replacement engine must reproduce this flatten-on-enqueue / rehydrate-on-run round trip exactly, or metadata is lost/corrupted. `onSuccess` → `markEventAsSynced`; `onFailed` → `markEventAsFailed`.
- Citations: `index.ts:21-30,40-65`; `worker.ts:11-80,87-115,129-137`.
