# Driver App Pipeline Parity Inventory

Phase 4 gate artifact required by `docs/reviews/production-readiness-review-2026-07-05.md`
("Required Pipeline Parity Inventory"). Ground truth was extracted from
`hopdrive/driver-app-3` **code** (never READMEs) by a five-way sweep; the full
per-pipeline reports with `file:line` citations live in
[`extraction/`](./extraction/) and are the authority behind every cell below.

Classification legend (from the review):

- **Must Match** — required before Endura can replace the current pipeline system
- **Pilot Match** — required before the first Endura-backed pilot workflow
- **Should Match** — required before broad rollout
- **Nice to Match** — useful coverage, not a blocker
- **Do Not Carry Forward** — old behavior intentionally retired (each has a documented reason)

Scenario numbers refer to the review's "Required Expo Mobile Scenarios" (1–14),
implemented in `examples/parity-app`.

## Inventory

| Pipeline | Stages | Purpose | Domain Key | Dedup Behavior | Retry / Timeout | Connectivity | Recovery | Class | Endura Scenario |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| photo | photoCapture → photoResize → photoBlurHash → photoPending → photoUpload → photoSave | Capture, resize, blurhash, register pending, upload to S3, record URL | moveId (column) or serviceOrderId (payload-only) | None-intentional; idempotency via already-uploaded short-circuits | per-stage: capture 15s/10, resize 60s/5, blurHash 20s/**1**, pending 30s/10, upload 60s/3, save 30s/10; priorities 45→42 | pending/save: online; upload: online **+ app active** (defer w/o burning attempt) | recoverable; resize/upload have server-reconciliation short-circuits (done→synced, uploaded→hand off) | **Pilot Match** | 1 (+8, 9, 11) |
| outcomeWorkflowDataSync | stage1CreateDraft → stage2SyncWorkflowData | Mid-fill draft create + workflow_data JSONB merge, never submits | moveId (column); outcomeId payload-only | **None-intentional** (converging idempotent stages; dedupe would drop edits) | both 30s/10, priority 40, 10s spacing | online | recoverable | **Must Match** | 2 |
| outcomeSubmit | stage1CreateDraft → stage2SyncWorkflowData → stage3Submit | Full submit chain; draft → merge → submit | moveId (column) | **None-intentional**; double-submit absorbed by server `status:'new'` guard; InvalidTransition→treated as success | all 30s/10, priority 40, 10s spacing | online | recoverable | **Must Match** | 3 |
| moveStatusSync | moveStatusSync | Push move.status (unless pullOnly), pull server move back | moveId (column) | none | 30s/10, priority 50, 10s spacing | online | recoverable; **RowFilterRejected → permanently_failed**, post-sync mismatch = warn only | **Must Match** | 4 |
| moveDriverStatusSync | moveDriverStatusSync | Push driver_status, pull back, assert match | moveId (column) | none | 30s/10, priority 10 | online | recoverable; RowFilterRejected → permanently_failed; mismatch **hard-throws** (burns retries) | **Must Match** | 4 |
| moveWorkflowOutputSync | moveWorkflowOutputSync | Push per-stage workflow output, resync move | moveId (column); `stage` in payload | none | 30s/10, priority 50 | online | recoverable; RowFilterRejected → permanently_failed | **Must Match** | 4 |
| offerBundleProcess | bundleProcess | Fetch + persist accepted offer's full bundle graph | driverId (column); **offerId payload-only** | **Per-entity by offerId** (`hasPendingEventMatching`) | 45s/10, priority 9, 10s spacing | online | recoverable | **Must Match** | 7 |
| photoReaper | photoReap | App-launch sweep reconciling disk photos vs server/S3 | none | Type-level + terminal drain before enqueue | 60s/2, priority 10 (lowest), 30s spacing | online **+ app active** | **recoverable:false** (fresh sweep next launch) | Should Match | 6 |
| sendAppDump | sendAppDump | Zip + upload diagnostics, log driver.app.dump | none as columns (snake_case payload) | Type-level | 60s/5 | online | **recoverable:false** (stale dumps worthless; "627 zombie dumps/day" incident) | Should Match | 6 |
| offerStatusSync | offerStatusSync | Push local offer accept/decline, verify it stuck | offerId **payload-only** (columns 0) | none | 30s/10, priority 50 (time-sensitive) | online | recoverable; deleted offer = graceful terminal success | Should Match | 8 |
| offerMissedAssignments | checkMissedAssignments | Reconcile locally-ACCEPTED vs server-ASSIGNED offers | driverId (column) | Type-level + terminal drain (18k-row incident guard) | 60s/10, priority 8 | online | recoverable | Nice to Match | 14 |
| outcomeStatusSync | outcomeStatusSync | Pull outcome server state, upsert full row, assert match | outcomeId **payload-only** (columns 0) | none | 30s/10, priority 50 | online | recoverable; post-write `verifyStatusMatch` throws to force retry | Should Match | 4/8 pattern |
| moveUpdateSync | moveUpdateSync | Pull full move by id, overwrite local | moveId (column) | none | 30s/10, priority 10 | online | recoverable | Should Match | 8 pattern |
| cancelMoveStatusSync | cancelMoveStatusSync | Resync move, assert cancel_status matches | moveId (column) | Type-level | 30s/10, priority 10 | online | recoverable; mismatch hard-throws | Should Match | 8 pattern |
| deleteNonMatchingMovesSync | deleteNonMatchingMovesSync | Delete local moves not in server assignment set | driverId (column) | Type-level + terminal drain (14k-row guard) | 30s/10, priority 10 | online (gate applies despite local-only work) | recoverable | Nice to Match | — (pattern in 7) |
| driverInfoSync | driverInfoSync | Push driver profile info | driverId (column) | Type-level | 30s/10, priority 10 | online | recoverable | Nice to Match | 8 pattern |
| driverStatusSync | driverStatusSync | Push driver.status, refresh, verify | driverId (column) | none | 30s/10, priority 10 | online | recoverable; **only batch-2 pipeline with synchronous stage-1**; missing-driverId no-op fallback; mismatch = warn only | Should Match | 8/12 |
| prioritySyncComplete | prioritySyncComplete | Count failed events for a move, emit priority.sync.complete log | moveId (column) | none | 30s/**5**, priority 10 | online | recoverable; **spawns sendEventLog pipeline** (cross-pipeline fan-out) | Nice to Match | 14 note |
| sendEventLog | sendEventLog | Insert server event-log via sdk-events | none (columns 0) | none | **5s**/10 | online | recoverable; soft-failure (`success:false`) completes anyway | Should Match | 14 |
| promoSync | promoSync | Full-refresh driver promos into Realm | driverId (column) | none | 30s/5, priority 40 | online | recoverable; destructive scoped full-sync (deletes stale local rows) | Nice to Match | 8 pattern |
| mobilityRunSync | mobilityRunSync | Push run status + timestamps | runId **payload-only** (columns 0) | none | 30s/10, priority 50 | online | recoverable-but-dead (jobMapper omission, see Gaps); mutation can't detect reassignment | Should Match | 13 |
| mobilityStopSync | mobilityStopSync | Sync stop status/timestamps + service_stop_details | stopId **payload-only** | none | 30s/10, priority 50 | online | recoverable-but-dead; RowFilterRejected → permanently_failed; in run-scoped collection | Should Match | 13 |
| mobilityVehicleSync | mobilityVehicleSync | Insert temp-id vehicle, reconcile to server id | tempVehicleId payload-only | none | 30s/10, priority 50 | online | recoverable-but-dead; **not idempotent on retry** (double insert) | Should Match | 13 |
| serviceOrderSync | serviceOrderSync | Sync service order status/workflow_data/vehicle fields | orderId **payload-only** | none | 30s/10, priority 50 | online | recoverable-but-dead; RowFilterRejected → permanently_failed; in run-scoped collection | Should Match | 13 |
| fuelAuthorizationSync | fuelAuthorizationSync | POST fuel authorization to HTTP API | moveId (column) | none | 30s/10, priority 10 | online + auth token | recoverable-but-dead; lite-driver skip; **non-idempotent POST** | Should Match | 9/11 pattern |
| fuelReimbursementSync | fuelReimbursementSync | POST fuel reimbursement | moveId (column) | none | 30s/10, priority 10 | online + auth token | recoverable-but-dead; lite-driver skip; non-idempotent POST | Should Match | 9/11 pattern |
| certificationComplete | certificationComplete | Submit certification completion, mark earned cert synced | driverId (column) | **Per-entity by certificationKey** | 30s/10, priority 5 | online + token | recoverable-but-dead; supports synchronous stage-1; deleted-event existence guard | Should Match | 7 variant |
| certificationSync | certificationSync | Pull cert catalog + earned certs | driverId (column) | Type-level + in-worker 24h limiter (forceRefresh bypass) | 30s/**5**, priority **3**, 30s spacing | online | recoverable-but-dead; supports synchronous stage-1 | Nice to Match | 14 |
| gpsEventLogSync | gpsEventLogSync | Insert GPS/telemetry event-log | snake_case ids → **columns 0** | none | 30s/10, priority 30 | online | recoverable-but-dead; server rejection swallowed as success | Nice to Match | 14 |
| geofenceEventSync | geofenceEventSync | Insert geofence event; stop-based also stamps stop timestamp | moveId/driverId (columns); stopId payload | none | 30s/10, priority 30 | online | recoverable-but-dead; stop write can RowFilterReject with **no handler**; non-idempotent insert | Should Match | 9 |

## Cross-cutting behaviors the scenarios must prove

Extracted from `utils/event.ts` / `utils/queue.ts` / `utils/recovery.ts` (full
detail in `extraction/core-event-queue-recovery.md`):

1. **Payload accumulation** — `completeStage` merges each stage's
   `additionalPayload` into `Event.payload`; the next job receives the deep-cloned
   accumulated payload (+ `chainData {callerJobName, step}`). → Scenarios 1–3.
2. **Stale-failure guard** — `markEventAsFailed` ignores a failure when the
   event is already `synced` or `event.stage !== job.name`. → Scenario 11.
3. **Permanent failure** — `RowFilterRejectedError` (Hasura wrote zero rows:
   move reassigned/deleted) → `permanently_failed`, excluded from sweeps,
   force-retry resets to `failed`. → Scenario 4.
4. **Recovery age gate** — seven-day window on automatic recovery; manual flows
   opt into stale recovery. → Scenario 5.
5. **Non-recoverable classification** — `recoverable:false` on photoReaper and
   sendAppDump; failures never re-armed. → Scenario 6.
6. **Photo reconciliation before re-arm** — recovery marks a photo event synced
   when the server already has it uploaded/done instead of re-arming stale
   pre-upload stages. → Scenario 1.
7. **Dedupe spectrum** — per-entity (`offerId`, `certificationKey`),
   type-level (+`clearTerminalEventsByType` drains), and *deliberate* no-dedupe
   (outcome pipelines). → Scenarios 2, 3, 7.
8. **Connectivity as a skip, not a failure** — `isJobRunnable:false` defers
   without consuming an attempt; photoUpload additionally requires foreground.
   → Scenarios 8, 9.
9. **Priorities** — real values: 50 (move/offer/mobility time-sensitive), 45–42
   (photo stages, descending), 40 (outcomes/promos), 30 (telemetry), 10
   (housekeeping), 9/8 (offer bundle machinery), 5/3 (certifications). FIFO
   within priority. → Scenario 14.
10. **Cross-pipeline fan-out** — prioritySyncComplete starts sendEventLog;
    photoResize can hand off directly to photoUpload. → noted in 1/14.
11. **Payload flatten/rehydrate** — sendEventLog spreads `metadata` into the
    payload root on enqueue and reconstructs it in the worker by deleting known
    keys. Endura has no payload-nesting restriction, so this round-trip does
    NOT need to be carried forward — but migration of these pipelines must
    unflatten. → migration note, not a scenario.

Additional core-machinery facts confirmed by `extraction/core-event-queue-recovery.md`:

12. **Age gate** — `MAX_RECOVERABLE_EVENT_AGE_MS = 7 days` (`recovery.ts:299`);
    `includeStale:true` bypasses it (recovery screen force-retry passes it);
    events with no `time` are dropped entirely. → Scenario 5.
13. **Timeout does not cancel work** — RNQ races the worker against a timeout
    but the original promise keeps running; the app *relies* on it finishing
    (photo short-circuits, stale guard). Endura's H1 semantics (Promise.race +
    stale-success guard, no cancellation) match this model. → Scenario 11.
14. **Force retry** — `permanently_failed → failed` reset then
    `runRecovery({includeStale:true})`; maps to endura `retryFromDeadLetter`.
    → Scenario 4.
15. **Pre-init enqueue tolerance** — `createJob` on a null queue drops with a
    warning instead of throwing (real Sentry incident). Harness scenarios must
    not assume enqueue-before-engine is fatal.
16. **Dual scoping linkage** — move-family events are scoped by the `moveId`
    column, mobility events only by payload keys (`stopId`/`orderId`) narrowed
    in JS. Endura's `metadata` + `getExecutions` must serve both. → Scenario 13.
17. **Behaviors tested nowhere else** — thirteen contracts live only in
    `driver-app-3` tests (stale-failure guard nuances, stage3Submit's
    local-state-dependent error branching, reapPhotos' positive-proof deletion
    matrix, …). Full list: `extraction/test-suite-behaviors.md` §BEHAVIORS
    TESTED NOWHERE ELSE — each is a required assertion in its mapped scenario.

## Parity gaps in the CURRENT system (candidates for Do Not Carry Forward)

These are defects or dead code in production behavior, found during
extraction. Endura should intentionally fix rather than reproduce them; each
needs sign-off before being declared retired. Sources:
`extraction/pipelines-batch3.md` §Cross-cutting flags.

| Gap | Current behavior | Proposed Endura stance |
| --- | --- | --- |
| Recovery dead for 10 pipelines | All mobility/serviceOrder/fuel/cert/gps/geofence stages are missing from `recovery.ts jobMapper`, so `recoverable:true` events are collected then skipped as "unmapped stage" — recovery is a silent no-op | Do Not Carry Forward — endura's name-based reconciliation re-arms any registered activity; scenario 13 proves run-scoped recovery actually works |
| Domain-key casing trap | Only camelCase `moveId`/`driverId` are lifted to Event columns; gpsEventLogSync (snake_case) and all mobility pipelines end up with columns = 0, invisible to `getFailedEventsByMoveId` | Do Not Carry Forward — endura `metadata` + `getExecutions` scoping replaces column lifting; scenario 13 proves payload-key scoping |
| Non-idempotent writers | mobilityVehicleSync double-inserts on retry-after-success; fuel* re-POST; geofence double-inserts | Not an engine defect, but scenarios 9/11 must document the risk; fake server records duplicates when handlers lack idempotency keys |
| Inconsistent RowFilterRejected handling | stop/order syncs → permanently_failed; runSync can't detect it; geofence throws with no handler | Scenario 4 proves the classification path; migration should standardize on NonRetryableError |
| Redundant double-sync | single-stage pipelines call markEventAsSynced from both completeStage and onSuccess | Do Not Carry Forward (harmless idempotent duplicate; no scenario needed) |
| Three divergent registration lists | Foreground registration (gated on `!isPendingDriver`), background registration (stale subset — background jobs for unregistered workers throw), and the hand-maintained recovery `jobMapper` must agree but don't | Do Not Carry Forward — endura has ONE registry; H7 holds unknown activities instead of throwing; scenario 12 proves it |
| Vestigial 'active' Event status | queried in one place, never written | Do Not Carry Forward |

## Status

- [x] Inventory complete (30 pipelines — the review's 27 plus geofenceEventSync, outcomeStatusSync, promoSync found in-repo)
- [x] Every Must Match pipeline mapped to a scenario
- [ ] Scenarios implemented (tracked in `examples/parity-app`)
- [ ] iOS + Android simulator passes
- [ ] Issue catalog updated with Phase 4 findings
