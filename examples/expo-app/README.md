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
| START FAILING | retry + DLQ path | `FAILED`, `DLQ:1` after 2 attempts |
| START KEYED (starts twice with one key) | C7 uniqueKey dedup | `KEYED:SAME-RUN`, single execution |

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

2026-07-05 — iPhone 16 simulator, iOS 18.3, Expo Go SDK 57, RN 0.86
(Hermes), expo-sqlite 16.x, driven by Maestro. All four scenarios passed:
four 3-step runs completed with every step count exactly 1 (one run
killed mid-step2 via `simctl terminate` and resumed after relaunch),
failing workflow dead-lettered after 2 attempts, keyed double-start
returned the same run.

Not covered here: standalone (non-Expo Go) builds, physical devices, and
the background wake path (expo-background-task) — those remain for the
pilot per RFC §8.6.
