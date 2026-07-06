# Endura Showcase / Parity Harness

An Expo app that is both **documentation and evidence** for Endura. It runs the
real engine against real SQLite files on your device and proves — with
assertions you can rerun — that durable workflows survive the failure modes
that break hand-rolled queues.

## Tabs

- **Learn** — what Endura is, why the evidence here is trustworthy, and a
  concept glossary (workflows, ticks, runWhen holds, leases, uniqueKey, DLQ,
  priorities, upgrade skew…). Every concept shows the minimal code and links to
  the scenario where you can watch it happen.
- **Lab (Scenarios)** — the 15 Phase-4 parity scenarios as teaching cards,
  deliberately SIMULATED so they are deterministic and automatable. Each card
  leads with the skeptic's question it answers ("What happens to a six-stage
  photo upload when the app is killed at stage three?"), narrates the engine
  live while it runs, then shows steps, assertions, the business-effect ledger
  (the anti-duplicate proof), and a CODE view with the sample code + file
  structure you would use in a real app.
- **Field Test** — the UN-simulated counterpart, built for a physical phone:
  a production-style engine (real tick loop) over a database that is never
  reset between launches, real connectivity from the radio (expo-network),
  and real HTTP deliveries to the real internet (postman-echo.com by default, or
  paste a webhook.site URL and watch jobs land on your laptop). Guided
  missions: baseline delivery → airplane-mode hold & priority flush →
  backgrounding → force quit & relaunch → real server 500s driving real
  retries into the DLQ and back out via force retry.
- **Playground** — a live simulated engine driven by hand: start jobs, tick,
  toggle connectivity, restart, background-wake a second engine, inject
  failures (transient / refusal / hung / slow / late), and rescue dead
  letters — with viewers over every table the engine persists.

A fixed-geometry **engine instrument panel** is pinned to the bottom of every
tab: which engine is live, real online/offline state, four KPI counters
(queued / running / dead-lettered / delivered), and a ticker narrating the
engine's last action.

## Running it

```bash
# from the repo root: build + pack endura, install into the app
npm run build && npm pack --pack-destination /tmp
cp /tmp/endura-0.1.0.tgz ./endura-0.1.0.tgz
cd examples/parity-app
npm install
npx expo start
```

Open in Expo Go (iOS or Android). Each scenario owns an isolated database
file, so runs are deterministic; RESET deletes the file.

## Why the fake server matters

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
