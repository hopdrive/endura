/**
 * Loopback channel - the worker protocol without a worker.
 *
 * Runs the real ActivityHost and the real WorkerDispatcher against an
 * in-process message channel that structured-clones every payload, so
 * tests (and Node consumers) exercise the exact thread-boundary
 * semantics: no shared object identity, no closures crossing, errors
 * arriving flattened.
 */

import type { ActivityDispatcher, ActivityDispatchRequest, Logger, Workflow } from '../core/types';
import { ActivityHost, ActivityHostOptions, createActivityHost } from './host';
import { WorkerLike, WorkerScope } from './protocol';
import { WorkerDispatcher } from './WorkerDispatcher';

/** Clone like the thread boundary would; fall back to JSON on old runtimes. */
function cloneMessage<T>(value: T): T {
  const structured = (globalThis as { structuredClone?: <V>(v: V) => V }).structuredClone;
  if (structured) {
    return structured(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface LoopbackChannel {
  /** Hand this to WorkerDispatcher (the "main thread" end). */
  worker: WorkerLike;
  /** Hand this to createActivityHost (the "worker" end). */
  scope: WorkerScope;
}

/**
 * An in-process pair of endpoints that behave like a worker boundary:
 * async delivery, structured-cloned payloads.
 */
export function createLoopbackChannel(): LoopbackChannel {
  const worker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void {
      const data = cloneMessage(message);
      queueMicrotask(() => {
        scope.onmessage?.({ data });
      });
    },
  };

  const scope: WorkerScope = {
    onmessage: null,
    postMessage(message: unknown): void {
      const data = cloneMessage(message);
      queueMicrotask(() => {
        worker.onmessage?.({ data });
      });
    },
  };

  return { worker, scope };
}

export interface LoopbackDispatcher extends ActivityDispatcher {
  /** The host executing activities (register more, or dispose). */
  host: ActivityHost;
}

/**
 * A dispatcher + host pair over a loopback channel. Workflows the
 * engine registers are mirrored into the host automatically, so an
 * engine configured with this behaves like today's in-process engine —
 * while every attempt still round-trips the real message protocol.
 */
export function createLoopbackDispatcher(
  options: Omit<ActivityHostOptions, 'scope'> & { logger?: Logger } = {}
): LoopbackDispatcher {
  const { logger, ...hostOptions } = options;
  const channel = createLoopbackChannel();
  const host = createActivityHost({ ...hostOptions, scope: channel.scope });
  const inner = new WorkerDispatcher(channel.worker, { logger });

  return {
    host,
    execute: (request: ActivityDispatchRequest, signal: AbortSignal) => inner.execute(request, signal),
    onWorkflowRegistered: (workflow: Workflow) => host.register(workflow),
    setLogger: (nextLogger: Logger) => inner.setLogger(nextLogger),
    dispose: () => {
      inner.dispose();
      host.dispose();
    },
  };
}
