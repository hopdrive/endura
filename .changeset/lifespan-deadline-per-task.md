---
"endura": minor
---

`run({ lifespan })` now checks its deadline before each task inside a tick, not only between ticks. Before, one tick claimed up to ten pending tasks and ran them all, so a tick that started just inside the deadline could run far past a background wake's OS window. A task already running still finishes; the tasks after it stay pending for the next wake. A `tick()` called directly, outside `run()`, has no deadline, as before.

A lifespan of 0 or less now means the time is already spent, so `run()` claims no task and returns. Before, 0 meant "no limit", which gave a caller that passed its remaining budget an unbounded loop. Omit `lifespan` (or pass `undefined`) for no limit. `startBackgroundProcessing` from `endura/environmental/expo` passes 0 through unchanged.
