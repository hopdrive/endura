# Endura Expo Smoke Test

On-device smoke test for endura on real Hermes + expo-sqlite — the
"RN runtime smoke test" gate from
`docs/reviews/production-readiness-review-2026-07-05.md` (missing test #13).
Node tests cannot see C1 (expo transaction semantics), C3 (multi-engine
leases), or C6 (Hermes ID minting); this app can.

## What it exercises

| Scenario | Proves | Pass criteria |
| --- | --- | --- |
| START 3-STEP → completes | C1, C6, end-to-end engine on device | `COMPLETED s1:1 s2:1 s3:1` |
| Kill app mid-step → relaunch | C2, C3, C5 (atomic advance, lease recovery, no burned attempt) | run resumes and completes; steps finished before the kill stay at count 1 |
| START FAILING | retry + DLQ path | `FAILED`, DLQ count +1 after 2 attempts |
| START KEYED (starts twice with one key) | C7 uniqueKey dedup | `KEYED:SAME-RUN`, single execution |
| FORCE RETRY on a dead letter | H5 redrive (Force Retry parity) | `RETRY:REDRIVEN`, run flips to `COMPLETED redriven:1`, DLQ count −1 |
| START NONRETRY | M1 NonRetryableError classification | `FAILED nr:1` (one attempt despite budget 5), `NR:` count +1; FORCE RETRY then says `RETRY:NO-TARGET` |
| CANCEL 3-STEP mid-step | H3 sticky terminal states | `CANCELLED` with step counts frozen; stays cancelled through recovery scans and app relaunch |
| Reopen a Phase 1 database | C8 migration runner (v2 → current) | all legacy runs/history/DLQ render intact; legacy dead letters read as retryable (`NR:0`) |
| REACTIVE line (always visible) | M6 Storage.subscribe-driven hooks (useExecutionStats/useDeadLetters, zero polling) | counts track the polled list below through every scenario |
| START BIGSTATE | M3 state-size guardrails; 120 KB output round-trips sqlite | `COMPLETED size:120011`, `SIZE-WARN:result` and `SIZE-WARN:state` lines appear |
| (implicit) 3-step definition | L4 `chain()` typed step chaining compiles and runs on Hermes | all 3-step scenarios behave identically to Phases 1-2 |

Every step execution appends a row to a `step_log` side table in the same
database, so duplicate executions are visible as `sN:2+` counts in the UI.

## Running it

```bash
# From the repo root: build and pack endura, then install it here
npm run build && npm pack
cd examples/expo-app
npm install ../../endura-<version>.tgz
npm install

# Start on the iOS simulator (Expo Go)
npx expo start --ios
```

Kill test: start a 3-step run, then

```bash
xcrun simctl terminate booted host.exp.Exponent
xcrun simctl openurl booted "exp://<your-lan-ip>:8081"
```

The app uses `leaseDurationMs: 10000`, so the relaunched engine reclaims
the orphaned task within ~10–15s (startup recovery skips it while the
lease is live; the periodic half-lease re-scan picks it up after expiry).

## Last verified

**Phase 3 (PR #11 build), 2026-07-05** — same rig (iPhone 16 simulator,
iOS 18.3, Expo Go SDK 57, RN 0.86/Hermes, Maestro). All Phase 1+2
scenarios re-passed as regression plus the Phase 3 additions:

- The Phase 2 database (schema v6, 16 historical runs) opened directly
  under Phase 3 code with all history, step counts, and DLQ intact.
- REACTIVE (subscription-driven hooks, no polling) matched the polled
  list at every checkpoint: `done:11→15`, `fail:3→4`, `cancel:1→2`,
  `dlq:3→4` moved in lockstep as scenarios ran.
- BIGSTATE completed with `size:120011`; `SIZE-WARN:result` and
  `SIZE-WARN:state` surfaced through the new client logger passthrough,
  and the 120 KB state survived an app relaunch.
- The 3-step workflow is now defined via `chain()` (L4) — kill
  mid-step-2 → relaunch resumed with every step count exactly 1.
- FAILING dead-lettered after 2 jittered retries; FORCE RETRY redrove
  it to `COMPLETED redriven:1`; NONRETRY failed after exactly one
  attempt (`nr:1`, `NR:2`) ; CANCEL mid-step-1 froze at
  `s1:0 s2:0 s3:0` through 35s of lease expiries and recovery scans;
  KEYED returned `KEYED:SAME-RUN`.

**Phase 2 (PR #10 build), 2026-07-05** — iPhone 16 simulator, iOS 18.3,
Expo Go SDK 57, RN 0.86 (Hermes), expo-sqlite 16.x, driven by Maestro.
All scenarios passed, including the Phase 1 set as regression:

- Opening the Phase 1 database migrated schema v2 → v6 in place: all
  prior runs, step counts, and the legacy dead letter rendered intact.
- FORCE RETRY redrove the dead letter that Phase 1 code had written:
  `RETRY:REDRIVEN`, the failed run completed with `redriven:1`, DLQ
  dropped to 0.
- NONRETRY dead-lettered after exactly one attempt (`nr:1`, `NR:1`);
  FORCE RETRY refused it (`RETRY:NO-TARGET`).
- CANCEL mid-step-1 stuck: `CANCELLED s1:0 s2:0 s3:0`, unchanged
  through lease expiry, periodic recovery scans, and a full app
  kill/relaunch.
- Kill mid-step-2 → relaunch: the run resumed and completed with every
  step count exactly 1; a concurrent duplicate run (double-tap
  artifact) completed independently without cross-contamination.
- FAILING dead-lettered after 2 attempts (retryable, `NR` unchanged);
  KEYED double-start returned `KEYED:SAME-RUN`.

**Phase 1, 2026-07-05** — same rig, Phase 1 build: four 3-step runs
completed with every step count exactly 1 (one killed mid-step2 via
`simctl terminate` and resumed after relaunch), failing workflow
dead-lettered after 2 attempts, keyed double-start returned the same
run.

Not covered here: standalone (non-Expo Go) builds, physical devices, and
the background wake path (expo-background-task) — those remain for the
pilot per RFC §8.6.
