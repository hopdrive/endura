# endura

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
