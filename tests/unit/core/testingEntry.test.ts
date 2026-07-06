/**
 * M5 — test doubles do not ship in the production API surface.
 *
 * Mocks live behind the 'endura/testing' entry; the root and core
 * entries keep only the real implementations (RealClock/RealScheduler/
 * StubEnvironment are production defaults for Node/web consumers).
 */

import { describe, it, expect } from 'vitest';
import * as root from '../../../src';
import * as core from '../../../src/core';
import * as testing from '../../../src/testing';

describe('testing entry (M5)', () => {
  it('does not export mocks from the root or core entries', () => {
    for (const name of ['MockClock', 'MockScheduler', 'MockEnvironment']) {
      expect(name in root, `root exports ${name}`).toBe(false);
      expect(name in core, `core exports ${name}`).toBe(false);
    }
  });

  it('exports mocks and the test driver from endura/testing', () => {
    expect(testing.MockClock).toBeTypeOf('function');
    expect(testing.MockScheduler).toBeTypeOf('function');
    expect(testing.MockEnvironment).toBeTypeOf('function');
    expect(testing.BetterSqlite3Driver).toBeTypeOf('function');
  });

  it('keeps the real implementations in core', () => {
    expect(core.RealClock).toBeTypeOf('function');
    expect(core.RealScheduler).toBeTypeOf('function');
    expect(core.StubEnvironment).toBeTypeOf('function');
  });
});
