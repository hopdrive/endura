/**
 * Test utilities for endura.
 * Import these in your test files only.
 */

// Deterministic test doubles for the engine's injected seams
export { MockClock, MockScheduler, MockEnvironment, MockEnvironmentState } from '../core/mocks';

// In-process worker boundary: real dispatcher + real host over a
// structured-cloning loopback channel. This is the dispatcher to hand
// the engine in Node tests.
export {
  LoopbackChannel,
  LoopbackDispatcher,
  createLoopbackChannel,
  createLoopbackDispatcher,
} from '../workers/loopback';

// SQLite test driver
export { BetterSqlite3Driver, createBetterSqlite3Driver } from '../storage/sqlite/internal/BetterSqlite3Driver';
