---
"endura": minor
---

Add `expiry` to workflow definitions. An execution still running `expiry.afterMs` after it started is dead-lettered with a non-retryable `WorkflowExpiredError` and marked failed, instead of running late. The engine checks at claim time (ahead of `runWhen`) and sweeps on each engine's first tick; `engine.expireStaleExecutions()` runs the sweep on demand. Workflows without `expiry` are unaffected.
