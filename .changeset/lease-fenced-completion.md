---
"endura": patch
---

An engine now records a task's outcome only while it still holds the task's claim. Before, if the OS froze an engine mid-activity long enough for its lease to lapse, a second engine on the same database re-claimed and finished the task, and then the first engine's late result overwrote it and advanced the workflow again, so every later step ran twice. The success, retry, dead-letter (including expiry at claim time), held and skipped writes now check `(task_id, owner_id, status 'active')` through `renewLease` inside the transaction that records the outcome. A stale outcome is dropped: the workflow does not advance, no retry is scheduled, `onFailure` does not fire, the logger gets a "Stale completion dropped" warning and `onEvent` gets an `activity:stale-completion-dropped` event. The storage interface is unchanged.
