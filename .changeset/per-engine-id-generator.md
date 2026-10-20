---
"endura": minor
---

`WorkflowEngineConfig` takes an optional `generateId: () => string`. The engine uses it for its lease owner id, run ids, task ids and dead-letter ids, ahead of the module-level `setIdGenerator()` override, so two engines (or two copies of endura in one bundle) no longer share one global id source. `SQLiteStorage` takes the same option as a second constructor argument for the dead letter it writes when it quarantines a corrupt task row, and `ExpoWorkflowClient` accepts `generateId` and passes its expo-crypto generator to the engine explicitly.

`WorkflowEngine.create` now checks for a random source before it reads storage. With no `generateId`, no `setIdGenerator()` and no `globalThis.crypto` (Hermes without expo-crypto), it throws the exported `NoRandomSourceError`, whose message names both remedies, instead of a generic `Error` from inside the constructor. `generateId()` throws the same error, and `hasRandomSource()` reports whether it can mint an id.
