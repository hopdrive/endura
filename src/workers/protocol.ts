/**
 * Message protocol between the engine (main runtime) and the activity
 * host (worker runtime). Every payload must survive structured clone —
 * plain data only, no functions, no class instances.
 */

import type { RuntimeContext } from '../core/types';

/**
 * An error flattened for the trip across the thread boundary.
 * `nonRetryable` survives the trip so the engine's retry classification
 * (isNonRetryableError) works exactly as it does in-process.
 */
export interface SerializedActivityError {
  name: string;
  message: string;
  stack?: string;
  nonRetryable?: boolean;
}

/** Messages the engine side sends into the worker. */
export type HostboundMessage =
  | {
      endura: 'run';
      taskId: string;
      runId: string;
      activityName: string;
      attempt: number;
      input: Record<string, unknown>;
      runtime: RuntimeContext;
    }
  | { endura: 'abort'; taskId: string; reason?: SerializedActivityError }
  | { endura: 'hello' };

/** Messages the worker side sends back to the engine. */
export type EngineboundMessage =
  | { endura: 'ready'; activityNames: string[] }
  | { endura: 'result'; taskId: string; ok: true; result?: Record<string, unknown> }
  | { endura: 'result'; taskId: string; ok: false; error: SerializedActivityError }
  | { endura: 'log'; taskId: string; activityName: string; args: unknown[] };

/** True when a received message belongs to the endura protocol. */
export function isEnduraMessage(data: unknown): data is { endura: string } {
  return typeof data === 'object' && data !== null && typeof (data as { endura?: unknown }).endura === 'string';
}

/** Flatten an error for transport. */
export function serializeActivityError(error: unknown): SerializedActivityError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      nonRetryable: (error as { nonRetryable?: unknown }).nonRetryable === true || undefined,
    };
  }
  return { name: 'Error', message: String(error) };
}

/** Rebuild a throwable Error from its transport shape. */
export function deserializeActivityError(serialized: SerializedActivityError): Error {
  const error = new Error(serialized.message);
  error.name = serialized.name;
  if (serialized.stack) {
    error.stack = serialized.stack;
  }
  if (serialized.nonRetryable) {
    (error as { nonRetryable?: boolean }).nonRetryable = true;
  }
  return error;
}

/**
 * Runtime context arrives from the environment as app-controlled data
 * and may contain values that cannot cross the thread boundary
 * (functions, class instances with methods). Drop what can't travel
 * instead of blowing up the postMessage.
 */
export function sanitizeRuntimeContext(runtime: RuntimeContext): RuntimeContext {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(runtime)) {
    if (typeof value !== 'function' && typeof value !== 'symbol') {
      clean[key] = value;
    }
  }
  return clean as RuntimeContext;
}

/**
 * The slice of a react-native-workers Worker (or anything shaped like
 * one) that the dispatcher needs. Structural on purpose: endura has no
 * import of @ammarahmed/react-native-workers — the app constructs the
 * Worker and hands it over.
 */
export interface WorkerLike {
  postMessage(message: unknown): void;
  onmessage?: ((event: { data: unknown }) => void) | null;
  onerror?: ((event: unknown) => void) | null;
  terminate?(): void;
}

/**
 * The slice of the worker's global scope the activity host needs.
 * Inside a real worker this is `self`; the loopback channel fakes it.
 */
export interface WorkerScope {
  postMessage(message: unknown): void;
  onmessage?: ((event: { data: unknown }) => void) | null;
}
