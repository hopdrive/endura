# React Web Example App

The same core engine the React Native adapter drives, running in the
browser: InMemoryStorage, the Node/web runtime defaults (`RealClock`,
`RealScheduler`, `StubEnvironment`), and the reactive React hooks.

## What it shows

| Button | Demonstrates |
| --- | --- |
| Start typed chain | `chain()` compile-time step chaining; `useWorkflowStarter` + `useExecution` live state |
| Start flaky | retries with jittered exponential backoff succeeding on attempt 3 |
| Start doomed | `NonRetryableError` dead-lettering on the first failure despite a 5-attempt budget |
| Redrive first retryable dead letter | `retryFromDeadLetter`; refusal message when only non-retryable letters remain |

The stats line and dead-letter cards update through `Storage.subscribe`
— the hooks do no polling.

Note: InMemoryStorage does not survive a browser refresh. For durable
web storage you would implement the `Storage` interface over IndexedDB
or a WASM SQLite build; the engine itself is storage-agnostic.

## Running it

```bash
# From the repo root: build and pack endura, then install it here
npm run build && npm pack
cd examples/react-web-app
npm install ../../endura-<version>.tgz
npm install

# Start the dev server
npm run dev
```

## Last verified

**Phase 3 (PR build), 2026-07-05** — `npm run build` (tsc + vite)
compiles clean against the packed tarball, and every package entry
(`endura`, `endura/storage/memory`, `endura/react`, `endura/testing`)
resolves from the example's node_modules. Hook behavior is covered by
the repo's jsdom unit suite (tests/unit/react).
