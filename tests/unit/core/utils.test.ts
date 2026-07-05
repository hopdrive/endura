/**
 * generateId tests (review issue C6).
 *
 * The old implementation imported uuid v9, which requires
 * crypto.getRandomValues — absent on Hermes, so the first start() crashed
 * on-device. generateId now resolves: injected generator (expo-crypto) →
 * crypto.randomUUID → crypto.getRandomValues, and throws a descriptive
 * error when no source exists instead of dying inside a dependency.
 */

import { webcrypto } from 'node:crypto';
import { generateId, setIdGenerator } from '../../../src/core/utils';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('generateId (C6)', () => {
  afterEach(() => {
    setIdGenerator(null);
    vi.unstubAllGlobals();
  });

  it('produces v4 UUIDs via the platform crypto', () => {
    const id = generateId();
    expect(id).toMatch(UUID_V4);
    expect(generateId()).not.toBe(id);
  });

  it('prefers an injected generator (the expo-crypto path)', () => {
    setIdGenerator(() => 'injected-id');
    expect(generateId()).toBe('injected-id');
  });

  it('falls back to getRandomValues when randomUUID is missing', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (array: Uint8Array) => webcrypto.getRandomValues(array),
    });

    const id = generateId();
    expect(id).toMatch(UUID_V4);
  });

  it('throws a descriptive error when no random source exists (Hermes without expo-crypto)', () => {
    vi.stubGlobal('crypto', undefined);

    expect(() => generateId()).toThrow(/expo-crypto/);
  });
});
