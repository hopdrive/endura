/**
 * WorkerDispatcher - the engine side of the thread boundary.
 *
 * Sends activity attempts into a worker runtime and settles them from
 * the worker's replies. One dispatcher owns one worker; give endura a
 * dedicated worker rather than sharing one with app messaging.
 */

import type { ActivityDispatcher, ActivityDispatchRequest, Logger } from '../core/types';
import { silentLogger } from '../core/utils';
import {
  EngineboundMessage,
  HostboundMessage,
  WorkerLike,
  deserializeActivityError,
  isEnduraMessage,
  sanitizeRuntimeContext,
  serializeActivityError,
} from './protocol';

/**
 * Rejection used when the worker dies (uncaught error surfaced through
 * worker.onerror) while attempts are in flight. Retryable on purpose:
 * the task goes back to pending and gets another attempt.
 */
export class WorkerCrashedError extends Error {
  constructor(detail: string) {
    super(`Activity worker crashed or errored while attempts were in flight: ${detail}`);
    this.name = 'WorkerCrashedError';
  }
}

interface PendingAttempt {
  resolve: (result: Record<string, unknown> | undefined) => void;
  reject: (error: Error) => void;
  activityName: string;
  cleanup: () => void;
}

export class WorkerDispatcher implements ActivityDispatcher {
  private worker: WorkerLike;
  private logger: Logger;
  private pending = new Map<string, PendingAttempt>();
  private ready = false;
  private sendQueue: HostboundMessage[] = [];
  private disposed = false;

  constructor(worker: WorkerLike, options?: { logger?: Logger }) {
    this.worker = worker;
    this.logger = options?.logger ?? silentLogger;

    worker.onmessage = (event: { data: unknown }) => this.handleMessage(event.data);
    worker.onerror = (event: unknown) => this.handleWorkerError(event);

    // The worker bundle may still be loading, or may already be up.
    // 'hello' makes the host re-announce 'ready' so neither ordering
    // strands the queue.
    this.worker.postMessage({ endura: 'hello' } satisfies HostboundMessage);
  }

  setLogger(logger: Logger): void {
    this.logger = logger;
  }

  execute(
    request: ActivityDispatchRequest,
    signal: AbortSignal
  ): Promise<Record<string, unknown> | undefined> {
    if (this.disposed) {
      return Promise.reject(new WorkerCrashedError('dispatcher disposed'));
    }

    return new Promise((resolve, reject) => {
      const abortError = (): Error => {
        const reason: unknown = signal.reason;
        return reason instanceof Error
          ? reason
          : new Error(typeof reason === 'string' ? reason : 'Activity aborted');
      };

      if (signal.aborted) {
        reject(abortError());
        return;
      }

      // On abort: tell the worker (so ctx.signal fires there), then
      // reject here immediately — a worker stuck in synchronous code
      // can't answer until it's done, and the engine must not wait.
      const onAbort = (): void => {
        const error = abortError();
        this.send({
          endura: 'abort',
          taskId: request.taskId,
          reason: serializeActivityError(error),
        });
        this.settle(request.taskId)?.reject(error);
      };
      signal.addEventListener('abort', onAbort, { once: true });

      this.pending.set(request.taskId, {
        resolve,
        reject,
        activityName: request.activityName,
        cleanup: () => signal.removeEventListener('abort', onAbort),
      });

      this.send({
        endura: 'run',
        taskId: request.taskId,
        runId: request.runId,
        activityName: request.activityName,
        attempt: request.attempt,
        input: request.input,
        runtime: sanitizeRuntimeContext(request.runtime),
      });
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const taskId of [...this.pending.keys()]) {
      this.settle(taskId)?.reject(new WorkerCrashedError('dispatcher disposed'));
    }
    this.sendQueue = [];
  }

  /** Remove and return a pending attempt, running its cleanup. */
  private settle(taskId: string): PendingAttempt | undefined {
    const attempt = this.pending.get(taskId);
    if (attempt) {
      this.pending.delete(taskId);
      attempt.cleanup();
    }
    return attempt;
  }

  private send(message: HostboundMessage): void {
    if (!this.ready && message.endura === 'run') {
      this.sendQueue.push(message);
      return;
    }
    try {
      this.worker.postMessage(message);
    } catch (err) {
      // Non-cloneable payload (bad custom runtime-context value, etc.)
      if (message.endura === 'run') {
        this.settle(message.taskId)?.reject(
          err instanceof Error ? err : new Error(String(err))
        );
      } else {
        this.logger.warn('Failed to post message to activity worker', { error: String(err) });
      }
    }
  }

  private handleMessage(data: unknown): void {
    if (!isEnduraMessage(data)) {
      return;
    }
    const message = data as EngineboundMessage;

    switch (message.endura) {
      case 'ready': {
        this.ready = true;
        const queued = this.sendQueue;
        this.sendQueue = [];
        for (const item of queued) {
          this.send(item);
        }
        this.logger.info('Activity worker ready', { activityNames: message.activityNames });
        return;
      }
      case 'result': {
        const attempt = this.settle(message.taskId);
        if (!attempt) {
          // Late reply after abort/timeout — the engine already moved
          // on. Logged loudly (not just dropped): "the stale result was
          // ignored" must be visible in production logs.
          if (message.ok) {
            this.logger.info('Discarding late success from timed-out or aborted attempt', {
              taskId: message.taskId,
            });
          } else {
            this.logger.info('Discarding late failure from timed-out or aborted attempt', {
              taskId: message.taskId,
              error: message.error.message,
            });
          }
          return;
        }
        if (message.ok) {
          attempt.resolve(message.result);
        } else {
          attempt.reject(deserializeActivityError(message.error));
        }
        return;
      }
      case 'log': {
        this.logger.debug(`[Activity:${message.activityName}]`, {
          args: message.args,
          taskId: message.taskId,
        });
        return;
      }
    }
  }

  private handleWorkerError(event: unknown): void {
    const detail =
      typeof event === 'object' && event !== null && 'message' in event
        ? String((event as { message: unknown }).message)
        : String(event);
    this.logger.error('Activity worker error', { detail, inFlight: this.pending.size });

    // Attribution is impossible — fail every in-flight attempt and let
    // the engine's normal retry path bring the tasks back.
    for (const taskId of [...this.pending.keys()]) {
      this.settle(taskId)?.reject(new WorkerCrashedError(detail));
    }
  }
}
