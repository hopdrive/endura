# endura

## 0.6.0

### Minor Changes

- fb409ff: Add `expiry` to workflow definitions. An execution still running `expiry.afterMs` after it started is dead-lettered with a non-retryable `WorkflowExpiredError` and marked failed, instead of running late. The engine checks at claim time (ahead of `runWhen`) and sweeps on each engine's first tick; `engine.expireStaleExecutions()` runs the sweep on demand. Workflows without `expiry` are unaffected.

## 0.5.0

### Minor Changes

- 63fe87b: `run({ lifespan })` now checks its deadline before each task inside a tick, not only between ticks. Before, one tick claimed up to ten pending tasks and ran them all, so a tick that started just inside the deadline could run far past a background wake's OS window. A task already running still finishes; the tasks after it stay pending for the next wake. A `tick()` called directly, outside `run()`, has no deadline, as before.
  
  A lifespan of 0 or less now means the time is already spent, so `run()` claims no task and returns. Before, 0 meant "no limit", which gave a caller that passed its remaining budget an unbounded loop. Omit `lifespan` (or pass `undefined`) for no limit. `startBackgroundProcessing` from `endura/environmental/expo` passes 0 through unchanged.

## 0.4.0

### Minor Changes

- e3d6585: `WorkflowEngineConfig` takes an optional `generateId: () => string`. The engine uses it for its lease owner id, run ids, task ids and dead-letter ids, ahead of the module-level `setIdGenerator()` override, so two engines (or two copies of endura in one bundle) no longer share one global id source. `SQLiteStorage` takes the same option as a second constructor argument for the dead letter it writes when it quarantines a corrupt task row, and `ExpoWorkflowClient` accepts `generateId` and passes its expo-crypto generator to the engine explicitly.
  
  `WorkflowEngine.create` now checks for a random source before it reads storage. With no `generateId`, no `setIdGenerator()` and no `globalThis.crypto` (Hermes without expo-crypto), it throws the exported `NoRandomSourceError`, whose message names both remedies, instead of a generic `Error` from inside the constructor. `generateId()` throws the same error, and `hasRandomSource()` reports whether it can mint an id.

## 0.3.0

### Minor Changes

- e1f8364: Add `engine.wakeSkipped(filter?)`, which brings runWhen-skipped tasks forward to now. Call it when you know the condition just became true, such as the offline-to-online edge, instead of waiting out `retryInMs` (30 s by default).
  
  It moves pending tasks whose most recent history entry is a skip, optionally only those that skipped for a given `reason`. A retry backoff after a real failure keeps its delay. It also covers a claim already in flight: if the engine read the condition just before it flipped, the skip it saves is due now. An idle `run()` loop wakes at once.
  
  Storages may implement the new optional `rescheduleActivityTask` compare-and-set, which keeps the wake safe against a second engine on the same database. `InMemoryStorage` and `SQLiteStorage` both implement it. Custom storages written for 0.2 keep working without it.

## 0.2.0

### Minor Changes

- da95f16: First release cut from master through the automated pipeline.
  
  0.1.0 was published by hand off an experimental branch and contains a
  `endura/workers` entry point that does not exist on master. This release drops
  back to what master actually is. Anyone who installed 0.1.0 and imported
  `endura/workers` should stay on 0.1.0 until the workers rewrite lands.
