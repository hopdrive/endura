---
"endura": minor
---

Add `engine.wakeSkipped(filter?)`, which brings runWhen-skipped tasks forward to now. Call it when you know the condition just became true, such as the offline-to-online edge, instead of waiting out `retryInMs` (30 s by default).

It moves pending tasks whose most recent history entry is a skip, optionally only those that skipped for a given `reason`. A retry backoff after a real failure keeps its delay. It also covers a claim already in flight: if the engine read the condition just before it flipped, the skip it saves is due now. An idle `run()` loop wakes at once.

Storages may implement the new optional `rescheduleActivityTask` compare-and-set, which keeps the wake safe against a second engine on the same database. `InMemoryStorage` and `SQLiteStorage` both implement it. Custom storages written for 0.2 keep working without it.
