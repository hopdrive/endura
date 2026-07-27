/**
 * Activity host - the worker side of the thread boundary.
 *
 * This runs inside the worker bundle. It holds the real activity
 * definitions (the same modules the main bundle imports for
 * registration) and executes attempts the engine sends over.
 *
 * Typical worker entry file:
 *
 * ```typescript
 * // workflows/endura.worker.ts — bundled separately by react-native-workers
 * import { createActivityHost } from 'endura/workers';
 * import { photoWorkflow } from './photo';
 *
 * createActivityHost({ workflows: [photoWorkflow] });
 * ```
 */

import type { Activity, ActivityContext, AnyActivity, Workflow } from '../core/types';
import { createAbortController } from '../core/utils';
import {
  EngineboundMessage,
  HostboundMessage,
  WorkerScope,
  deserializeActivityError,
  isEnduraMessage,
  serializeActivityError,
} from './protocol';

export interface ActivityHostOptions {
  /** Workflows whose activities this host can execute. */
  workflows?: Workflow[];
  /** Extra activities not reachable through a workflow. */
  activities?: AnyActivity[];
  /**
   * The worker global scope. Defaults to the worker's own `self`;
   * injected explicitly by the loopback channel in tests.
   */
  scope?: WorkerScope;
}

/**
 * Thrown (in serialized form) when the engine dispatches an activity
 * this worker bundle never registered. Non-retryable: retrying the same
 * bundle can never succeed — the fix is adding the activity to
 * createActivityHost() in the worker entry file.
 */
export class ActivityNotInWorkerBundleError extends Error {
  readonly nonRetryable = true;

  constructor(activityName: string) {
    super(
      `Activity '${activityName}' is not registered in the worker bundle. ` +
        `Add its workflow to createActivityHost({ workflows: [...] }) in the worker entry file.`
    );
    this.name = 'ActivityNotInWorkerBundleError';
  }
}

export class ActivityHost {
  private workflows = new Map<string, Workflow>();
  private extraActivities = new Map<string, Activity>();
  private activities = new Map<string, Activity>();
  private running = new Map<string, { abort: (reason?: unknown) => void }>();
  private scope: WorkerScope;

  constructor(options: ActivityHostOptions = {}) {
    const scope = options.scope ?? (globalThis as unknown as WorkerScope);
    if (typeof scope.postMessage !== 'function') {
      throw new Error(
        'createActivityHost() found no worker scope. Call it inside a worker bundle, ' +
          'or pass { scope } explicitly.'
      );
    }
    this.scope = scope;

    for (const workflow of options.workflows ?? []) {
      this.register(workflow);
    }
    for (const activity of options.activities ?? []) {
      this.registerActivity(activity);
    }

    this.scope.onmessage = (event: { data: unknown }) => {
      void this.handleMessage(event.data);
    };

    this.announceReady();
  }

  /** Register a workflow's activities (mirrors engine.registerWorkflow). */
  register(workflow: Workflow): void {
    this.workflows.set(workflow.name, workflow);
    this.rebuildActivityMap();
  }

  /** Register a standalone activity. */
  registerActivity(activity: AnyActivity): void {
    this.extraActivities.set(activity.name, activity as Activity);
    this.rebuildActivityMap();
  }

  dispose(): void {
    this.scope.onmessage = null;
    for (const controller of this.running.values()) {
      controller.abort(new Error('Activity host disposed'));
    }
    this.running.clear();
  }

  /**
   * Rebuilt from scratch on every registration, matching the engine:
   * re-registering a changed definition must not leave its previous
   * activities reachable.
   */
  private rebuildActivityMap(): void {
    this.activities.clear();
    for (const workflow of this.workflows.values()) {
      for (const activity of workflow.activities) {
        this.activities.set(activity.name, activity as Activity);
      }
    }
    for (const [name, activity] of this.extraActivities) {
      this.activities.set(name, activity);
    }
  }

  private post(message: EngineboundMessage): void {
    this.scope.postMessage(message);
  }

  private announceReady(): void {
    this.post({ endura: 'ready', activityNames: [...this.activities.keys()] });
  }

  private async handleMessage(data: unknown): Promise<void> {
    if (!isEnduraMessage(data)) {
      return;
    }
    const message = data as HostboundMessage;

    switch (message.endura) {
      case 'hello':
        this.announceReady();
        return;
      case 'abort': {
        const controller = this.running.get(message.taskId);
        if (controller) {
          controller.abort(
            message.reason ? deserializeActivityError(message.reason) : new Error('Activity aborted')
          );
        }
        return;
      }
      case 'run':
        await this.runActivity(message);
        return;
    }
  }

  private async runActivity(message: Extract<HostboundMessage, { endura: 'run' }>): Promise<void> {
    const activity = this.activities.get(message.activityName);
    if (!activity) {
      this.post({
        endura: 'result',
        taskId: message.taskId,
        ok: false,
        error: serializeActivityError(new ActivityNotInWorkerBundleError(message.activityName)),
      });
      return;
    }

    const { signal, abort } = createAbortController();
    this.running.set(message.taskId, { abort });

    const context: ActivityContext = {
      ...message.runtime,
      runId: message.runId,
      taskId: message.taskId,
      attempt: message.attempt,
      input: message.input,
      signal,
      log: (...args: unknown[]) => {
        this.post({
          endura: 'log',
          taskId: message.taskId,
          activityName: message.activityName,
          args,
        });
      },
    };

    try {
      // Async wrapper so a synchronous throw takes the same path.
      const result = await (async () => activity.execute(context))();
      try {
        this.post({
          endura: 'result',
          taskId: message.taskId,
          ok: true,
          result: result as Record<string, unknown> | undefined,
        });
      } catch (postErr) {
        // Result didn't survive structured clone (function, native
        // handle, ...). Surface it as the activity's failure — silence
        // here would strand the attempt until its timeout.
        this.post({
          endura: 'result',
          taskId: message.taskId,
          ok: false,
          error: serializeActivityError(
            new Error(
              `Activity '${message.activityName}' returned a value that cannot cross the ` +
                `thread boundary: ${String(postErr)}. Return plain data (and store big or ` +
                `native things yourself, passing a reference).`
            )
          ),
        });
      }
    } catch (err) {
      this.post({
        endura: 'result',
        taskId: message.taskId,
        ok: false,
        error: serializeActivityError(err),
      });
    } finally {
      this.running.delete(message.taskId);
    }
  }
}

/**
 * Create and start the activity host inside a worker bundle.
 */
export function createActivityHost(options: ActivityHostOptions = {}): ActivityHost {
  return new ActivityHost(options);
}
