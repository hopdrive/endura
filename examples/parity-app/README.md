# Endura Showcase App

An Expo app that is both **documentation and evidence** for Endura. Everything
in it is real: real SQLite persistence, real HTTP deliveries to the real
internet, the device's real radio. Nothing that the phone can do itself is
simulated — you test offline behavior with actual Airplane Mode and durability
with an actual force quit.

<p align="center">
  <img src="../../docs/images/parity-app/01-deck.png" width="250" alt="Use-case card deck" />
  <img src="../../docs/images/parity-app/02-duty-card.png" width="250" alt="Duty-gated card holding jobs" />
  <img src="../../docs/images/parity-app/05-sheet-jobs.png" width="250" alt="Engine inspector jobs tab" />
</p>

## The card deck

The main surface is a horizontally swipeable deck. Each card explains one
guarantee in plain English, shows the code that provides it, and has a button
that runs it for real:

1. **Meet Endura** — the whole idea in one screen; queue your first delivery.
2. **Survives Offline** — gated jobs hold (attempts frozen) in Airplane Mode
   and flush on reconnect. Force-quit mid-queue; nothing is lost.
3. **Retries, Automatically** — sends to an endpoint that genuinely returns
   HTTP 500 half the time; watch backoff absorb a misbehaving server.
4. **Multi-Step Pipelines** — prepare → upload → finalize; each stage's return
   value feeds the next, resumable between stages.
5. **Gated by App State** — `runWhen` is plain code, so jobs can wait on
   anything the app knows; the on-duty switch holds and releases duty reports.
6. **Priority Lanes** — queued backwards, delivered by priority.
7. **Exactly Once** — mash the button; `uniqueKey` dedupes at the database.
8. **When All Else Fails** — a doomed job burns 3 real attempts and lands in
   the dead-letter queue with its full history, ready for manual retry.

## The engine inspector

A status bar with live queue counters is docked at the bottom. Drag it up
(it's a standard bottom sheet — it follows your finger) for the full
inspector, with swipeable tabs:

- **Status** — engine state, the radio as the device reports it, the on-duty
  app-state switch, the delivery endpoint (paste a webhook.site URL to watch
  your phone's deliveries land on a laptop), queue counts, and reset.
- **Setup** — every registered workflow and activity with its priority, retry
  policy, timeout, and gating — read live from the definitions.
- **Jobs** — every job the engine persists, grouped by phase (running,
  retrying, held, waiting, dead, completed), with a drill-in detail view:
  payload, accumulated state, pipeline trail, task lease, and the verbatim
  error/hold history of every attempt. Dead letters can be retried; running
  jobs cancelled.
- **Log** — the engine narrating itself.
- **Tests** — the 15-scenario parity suite (crashes, connectivity loss,
  duplicate background wakes, stale results…), each run live against real
  SQLite on this device.

<p align="center">
  <img src="../../docs/images/parity-app/03-sheet-status.png" width="250" alt="Status tab" />
  <img src="../../docs/images/parity-app/04-sheet-setup.png" width="250" alt="Setup tab" />
  <img src="../../docs/images/parity-app/07-sheet-tests.png" width="250" alt="Tests tab" />
</p>

## Running it

```bash
# from the repo root: build + pack endura, install into the app
npm run build && npm pack --pack-destination /tmp
cp /tmp/endura-0.1.0.tgz ./endura-0.1.0.tgz
cd examples/parity-app
npm install
npx expo start
```

Open in Expo Go (iOS or Android).

### Without a dev server (field testing)

Airplane-mode and force-quit tests can't depend on Metro — a dev bundle can't
be re-fetched while offline. Publish the bundle instead and Expo Go loads it
from the CDN and relaunches it from its cache:

```bash
npx eas-cli update --branch demo --message "field build"
```

Open the update once from the EAS dashboard QR; after that it launches
without the computer.

## Why the parity suite matters

Scenarios never assert "the workflow completed". They assert on a **business
effect ledger** — one uploaded photo, one submitted outcome — recorded by a
scriptable fake server with server-side idempotency. At-least-once delivery is
only safe if retries never become duplicate business effects; the ledger is
where that claim gets tested.

## Provenance

This app is the Phase 4 gate from the production-readiness review
(`docs/reviews/production-readiness-review-2026-07-05.md`): driver-app pipeline
behaviors extracted from production, translated into deterministic scenarios,
passing on iOS and Android. The issue catalog it produced (including two real
engine bugs it caught and fixed) lives in `docs/phase4/issue-catalog.md`.
