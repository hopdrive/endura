/**
 * Utility functions for the workflow engine.
 */

type IdGenerator = () => string;

let idGenerator: IdGenerator | null = null;

/**
 * Override the ID source. The Expo integration wires this to
 * expo-crypto's randomUUID, which is the only reliable source on Hermes
 * (Hermes ships neither crypto.randomUUID nor crypto.getRandomValues).
 */
export function setIdGenerator(fn: IdGenerator | null): void {
  idGenerator = fn;
}

interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

/**
 * Generate a unique identifier (UUID v4).
 *
 * Resolution order: injected generator (expo-crypto on device) →
 * crypto.randomUUID (Node, browsers) → crypto.getRandomValues. Throws a
 * clear error instead of crashing deep inside a dependency when no
 * secure random source exists.
 */
export function generateId(): string {
  if (idGenerator) {
    return idGenerator();
  }

  const cryptoObj = (globalThis as { crypto?: CryptoLike }).crypto;
  if (cryptoObj?.randomUUID) {
    return cryptoObj.randomUUID();
  }
  if (cryptoObj?.getRandomValues) {
    const bytes = cryptoObj.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  throw new Error(
    'No secure random source available. On React Native/Hermes, install expo-crypto ' +
      '(the endura Expo integration wires it automatically) or call setIdGenerator().'
  );
}

/**
 * Calculate backoff delay for a retry attempt.
 */
export function calculateBackoffDelay(
  attempt: number,
  initialInterval: number,
  backoffCoefficient: number,
  maximumInterval?: number
): number {
  // Attempt is 1-based, so for attempt 1, we use initialInterval
  // For attempt 2, we use initialInterval * coefficient
  // For attempt 3, we use initialInterval * coefficient^2
  const delay = initialInterval * Math.pow(backoffCoefficient, attempt - 1);

  if (maximumInterval !== undefined) {
    return Math.min(delay, maximumInterval);
  }
  return delay;
}

/**
 * Create a logger that adds context to all log messages.
 */
export function createContextLogger(
  baseFn: (...args: unknown[]) => void,
  context: Record<string, unknown>
): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    baseFn(...args, context);
  };
}

/**
 * Shallow merge objects, handling undefined return values.
 */
export function mergeState(
  base: Record<string, unknown>,
  additions: Record<string, unknown> | undefined | null | void
): Record<string, unknown> {
  if (!additions || typeof additions !== 'object') {
    return base;
  }
  return { ...base, ...additions };
}

/**
 * Approximate serialized size of a value: the length of its JSON string
 * (exact bytes for ASCII payloads, an underestimate for multi-byte
 * characters). Cheap enough to run per advance; used for the state-size
 * guardrails, not for accounting.
 */
export function approxJsonBytes(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : json.length;
}

/**
 * Create an AbortController-like API that works in Node.
 */
export function createAbortController(): {
  signal: AbortSignal;
  abort: (reason?: unknown) => void;
} {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    abort: (reason?: unknown) => controller.abort(reason),
  };
}

/**
 * Default logger that does nothing (silent).
 */
export const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Console logger for development.
 */
export const consoleLogger = {
  debug: (msg: string, meta?: Record<string, unknown>) => console.debug(`[Workflow] ${msg}`, meta ?? ''),
  info: (msg: string, meta?: Record<string, unknown>) => console.info(`[Workflow] ${msg}`, meta ?? ''),
  warn: (msg: string, meta?: Record<string, unknown>) => console.warn(`[Workflow] ${msg}`, meta ?? ''),
  error: (msg: string, meta?: Record<string, unknown>) => console.error(`[Workflow] ${msg}`, meta ?? ''),
};
