/**
 * M5 — getPendingActivityTasks must receive `now` from the caller.
 *
 * The old optional parameter fell back to Date.now() inside the storage
 * layer, silently bypassing the injected Clock and making "which tasks
 * are due" non-deterministic under test. The compiler now enforces the
 * seam.
 */

import { Storage } from '../../src/core/types';

declare const storage: Storage;

export const ok = storage.getPendingActivityTasks({ now: 123, limit: 5 });
export const okNoLimit = storage.getPendingActivityTasks({ now: 123 });

// @ts-expect-error — now is required; storage must not fall back to Date.now()
export const missingOptions = storage.getPendingActivityTasks();

// @ts-expect-error — now is required even when limit is given
export const missingNow = storage.getPendingActivityTasks({ limit: 5 });
