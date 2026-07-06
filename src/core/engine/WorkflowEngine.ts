/**
 * WorkflowEngine - orchestrates workflow execution.
 */

import {
  Storage,
  Clock,
  Scheduler,
  Environment,
  Logger,
  Workflow,
  Activity,
  AnyActivity,
  WorkflowExecution,
  ActivityTask,
  DeadLetterRecord,
  WorkflowExecutionStatus,
  ActivityContext,
  StartWorkflowOptions,
  TickOptions,
  EngineEvent,
  CleanupConfig,
  WorkflowEngineConfig,
  UniqueConstraintError,
  ExecutionNotFoundError,
  ActivityTimeoutError,
  RunConditionFn,
  isNonRetryableError,
} from '../types';
import { generateId, mergeState, calculateBackoffDelay, silentLogger, createAbortController } from '../utils';
import { conditions } from '../conditions';

// Default activity options
const DEFAULT_TIMEOUT = 25000;
// Max FAILURES before dead-lettering. A durable-execution engine must not
// default to at-most-once (the old default of 1 meant a single flaky
// network error permanently failed the workflow).
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_INTERVAL = 1000;
const DEFAULT_BACKOFF_COEFFICIENT = 2;
const DEFAULT_PRIORITY = 0;
const DEFAULT_LEASE_MS = 60000;
// How long to park a task whose activity isn't registered (upgrade skew)
// before re-checking. Long enough to avoid busy-spinning, short enough
// that a hotfixed definition picks the task up promptly.
const HELD_TASK_RECHECK_DELAY = 60000;

/**
 * The WorkflowEngine orchestrates workflow execution.
 */
export class WorkflowEngine {
  private storage: Storage;
  private clock: Clock;
  private scheduler: Scheduler;
  private environment: Environment;
  private logger: Logger;
  private onEvent?: (event: EngineEvent) => void;
  private cleanup?: CleanupConfig;

  private workflows: Map<string, Workflow> = new Map();
  private activities: Map<string, Activity> = new Map();
  private isRunning = false;
  private abortController: AbortController | null = null;
  private hasReconciled = false;
  private nextLeaseRecoveryAt = 0;

  // Identifies this engine instance for task leases; every engine (e.g.
  // foreground app vs background wake) gets its own.
  private ownerId: string = generateId();
  private leaseDurationMs: number;

  // Track active AbortControllers by runId for cancellation propagation
  private activeAbortControllers: Map<string, { abort: (reason?: unknown) => void }> = new Map();

  private constructor(config: WorkflowEngineConfig) {
    this.storage = config.storage;
    this.clock = config.clock;
    this.scheduler = config.scheduler;
    this.environment = config.environment;
    this.logger = config.logger ?? silentLogger;
    this.onEvent = config.onEvent;
    this.cleanup = config.cleanup;
    this.leaseDurationMs = config.leaseDurationMs ?? DEFAULT_LEASE_MS;
  }

  /**
   * Create and initialize a WorkflowEngine instance.
   */
  static async create(config: WorkflowEngineConfig): Promise<WorkflowEngine> {
    const engine = new WorkflowEngine(config);
    await engine.initialize();
    return engine;
  }

  /**
   * Initialize the engine (cleanup, recovery, etc.).
   */
  private async initialize(): Promise<void> {
    // Run startup cleanup if configured
    if (this.cleanup?.onStart) {
      await this.runCleanup();
    }

    // Recover from crashes - reset any 'active' tasks to 'pending'
    await this.recoverActiveTasks();
  }

  /**
   * Recover tasks whose owner crashed. Only tasks with a lapsed (or
   * missing) lease are reclaimed — an unexpired lease means another
   * engine is live and mid-task (e.g. the foreground engine while we are
   * a background wake), and resetting its task would run it twice.
   */
  private async recoverActiveTasks(): Promise<void> {
    const activeTasks = await this.storage.getActivityTasksByStatus('active');
    const now = this.clock.now();

    for (const task of activeTasks) {
      if (task.leaseExpiresAt != null && task.leaseExpiresAt > now) {
        continue;
      }

      this.logger.info('Recovering crashed task', { taskId: task.taskId, activityName: task.activityName });

      // A crash (app kill, OS suspend) is not a failure — only recorded
      // failures count toward exhaustion, so recovery never burns an
      // attempt. Killing the app mid-task is routine on mobile.
      if ((task.failures ?? 0) >= task.maxAttempts) {
        // Already out of failure budget before the crash — finish the job.
        await this.handleTaskPermanentFailure(task, new Error('Crashed during execution'));
      } else {
        // Reset to pending for retry
        const updatedTask: ActivityTask = {
          ...task,
          status: 'pending',
          scheduledFor: now, // Run immediately
          error: 'Recovered from crash',
          ownerId: undefined,
          leaseExpiresAt: undefined,
        };
        await this.storage.saveActivityTask(updatedTask);
      }
    }
  }

  /**
   * Repair 'running' executions that have no pending or active task.
   * A crash between the completed-task write and the advance (or between
   * the execution insert and the first task insert) leaves a workflow
   * 'running' with nothing scheduled — without this pass it would hang
   * forever, since crash recovery only scans 'active' tasks.
   */
  private async reconcileStrandedExecutions(): Promise<void> {
    const now = this.clock.now();
    const running = await this.storage.getExecutionsByStatus('running');

    for (const execution of running) {
      const tasks = await this.storage.getActivityTasksForExecution(execution.runId);
      const hasFrontierTask = tasks.some(t => t.status === 'pending' || t.status === 'active');
      if (hasFrontierTask) continue;

      const workflow = this.workflows.get(execution.workflowName);
      if (!workflow) {
        this.logger.warn('Stranded execution references unregistered workflow', {
          runId: execution.runId,
          workflowName: execution.workflowName,
        });
        continue;
      }

      const currentTask = tasks.find(t => t.activityName === execution.currentActivityName);

      if (currentTask?.status === 'completed') {
        // The activity finished but the advance was lost — replay it.
        this.logger.info('Reconciling stranded execution: replaying advance', {
          runId: execution.runId,
          activityName: currentTask.activityName,
        });
        await this.storage.transaction(async () => {
          await this.advanceWorkflow(currentTask, currentTask.result);
        });
        continue;
      }

      if (currentTask?.status === 'failed') {
        // The task failed but the execution was never marked failed.
        this.logger.info('Reconciling stranded execution: marking failed', {
          runId: execution.runId,
          activityName: currentTask.activityName,
        });
        await this.storage.saveExecution({
          ...execution,
          status: 'failed',
          error: currentTask.error ?? 'Activity failed',
          failedActivityName: currentTask.activityName,
          updatedAt: now,
          completedAt: now,
        });
        continue;
      }

      // No record of the frontier activity at all — schedule it. Resolve
      // by NAME: after an app upgrade the persisted index may point at a
      // different step in the new definition (H7).
      const activity = workflow.activities.find(a => a.name === execution.currentActivityName);
      if (!activity) {
        this.logger.warn('Cannot reconcile stranded execution: activity not in registered definition — holding', {
          runId: execution.runId,
          activityName: execution.currentActivityName,
          workflowName: workflow.name,
        });
        continue;
      }
      this.logger.info('Reconciling stranded execution: scheduling frontier task', {
        runId: execution.runId,
        activityName: activity.name,
      });
      await this.scheduleActivityTask(execution, activity, execution.state);
    }
  }

  // ============================================================================
  // Workflow Registration
  // ============================================================================

  /**
   * Register a workflow definition with the engine.
   */
  registerWorkflow(workflow: Workflow): void {
    if (this.workflows.has(workflow.name)) {
      this.logger.warn('Workflow already registered, overwriting', { name: workflow.name });
    }
    this.workflows.set(workflow.name, workflow);

    // Rebuild the activity map from every registered workflow rather
    // than accumulating: re-registering a changed definition must not
    // leave its previous activities reachable, or an in-flight task
    // could execute stale code after an app upgrade.
    this.activities.clear();
    for (const registered of this.workflows.values()) {
      // The engine erases per-activity input/output generics internally.
      for (const activity of registered.activities) {
        this.activities.set(activity.name, activity as Activity);
      }
    }

    this.logger.debug('Registered workflow', {
      name: workflow.name,
      activityCount: workflow.activities.length,
    });
  }

  /**
   * Get a registered workflow by name.
   */
  getWorkflow(name: string): Workflow | undefined {
    return this.workflows.get(name);
  }

  /**
   * Get a registered activity by name.
   */
  getActivity(name: string): Activity | undefined {
    return this.activities.get(name);
  }

  // ============================================================================
  // Workflow Execution Management
  // ============================================================================

  /**
   * Start a new workflow execution.
   */
  async start<TInput extends Record<string, unknown>>(
    workflow: Workflow<TInput>,
    options: StartWorkflowOptions<TInput>
  ): Promise<WorkflowExecution> {
    // Ensure workflow is registered
    if (!this.workflows.has(workflow.name)) {
      this.registerWorkflow(workflow);
    }

    const now = this.clock.now();
    const runId = generateId();

    const firstActivity = workflow.activities[0];
    if (!firstActivity) {
      throw new Error(`Workflow '${workflow.name}' has no activities`);
    }

    // Create workflow execution
    const execution: WorkflowExecution = {
      runId,
      workflowName: workflow.name,
      workflowVersion: workflow.version,
      uniqueKey: options.uniqueKey,
      currentActivityIndex: 0,
      currentActivityName: firstActivity.name,
      status: 'running',
      input: options.input as Record<string, unknown>,
      state: options.input as Record<string, unknown>,
      createdAt: now,
      updatedAt: now,
    };

    // The uniqueness check, the execution row, and its first task must
    // land together: a crash between writes strands the workflow, and a
    // check outside the transaction races other starters. The partial
    // unique index (one 'running' execution per key) is the final
    // arbiter for races the read cannot see.
    let existingExecution: WorkflowExecution | null = null;
    try {
      await this.storage.transaction(async () => {
        if (options.uniqueKey) {
          const canUse = await this.storage.setUniqueKey(workflow.name, options.uniqueKey, runId);
          if (!canUse) {
            const existingRunId = await this.storage.getUniqueKey(workflow.name, options.uniqueKey);
            if (existingRunId) {
              if (options.onConflict === 'ignore') {
                existingExecution = await this.storage.getExecution(existingRunId);
                if (existingExecution) {
                  return;
                }
              }
              throw new UniqueConstraintError(workflow.name, options.uniqueKey, existingRunId);
            }
          }
        }

        await this.storage.saveExecution(execution);
        await this.scheduleActivityTask(execution, firstActivity, execution.state);
      });
    } catch (err) {
      // Translate a database-level unique violation (a racer that the
      // pre-check couldn't see) into the same error as the checked path.
      if (
        options.uniqueKey &&
        err instanceof Error &&
        /unique constraint/i.test(err.message) &&
        !(err instanceof UniqueConstraintError)
      ) {
        const existingRunId = await this.storage.getUniqueKey(workflow.name, options.uniqueKey);
        throw new UniqueConstraintError(workflow.name, options.uniqueKey, existingRunId ?? 'unknown');
      }
      throw err;
    }

    if (existingExecution) {
      return existingExecution;
    }

    this.emitEvent({
      type: 'execution:started',
      timestamp: now,
      runId,
      workflowName: workflow.name,
    });

    this.logger.info('Started workflow execution', { runId, workflowName: workflow.name });

    return execution;
  }

  /**
   * Schedule an activity task for execution.
   */
  private async scheduleActivityTask(
    execution: WorkflowExecution,
    activity: AnyActivity,
    input: Record<string, unknown>
  ): Promise<ActivityTask> {
    const now = this.clock.now();
    const opts = activity.options ?? {};

    const task: ActivityTask = {
      taskId: generateId(),
      runId: execution.runId,
      activityName: activity.name,
      status: 'pending',
      priority: opts.priority ?? DEFAULT_PRIORITY,
      attempts: 0,
      maxAttempts: opts.retry?.maximumAttempts ?? DEFAULT_MAX_ATTEMPTS,
      timeout: opts.startToCloseTimeout ?? DEFAULT_TIMEOUT,
      input,
      createdAt: now,
    };

    await this.storage.saveActivityTask(task);

    this.logger.debug('Scheduled activity task', {
      taskId: task.taskId,
      runId: execution.runId,
      activityName: activity.name,
    });

    return task;
  }

  /**
   * Get a workflow execution by runId.
   */
  async getExecution(runId: string): Promise<WorkflowExecution | null> {
    return this.storage.getExecution(runId);
  }

  /**
   * Get workflow executions by status.
   */
  async getExecutionsByStatus(status: WorkflowExecutionStatus): Promise<WorkflowExecution[]> {
    return this.storage.getExecutionsByStatus(status);
  }

  /**
   * Cancel a workflow execution.
   */
  async cancelExecution(runId: string): Promise<void> {
    const execution = await this.storage.getExecution(runId);
    if (!execution) {
      throw new ExecutionNotFoundError(runId);
    }

    if (execution.status !== 'running') {
      this.logger.warn('Cannot cancel non-running execution', { runId, status: execution.status });
      return;
    }

    // 1. Abort any in-flight activity
    const controller = this.activeAbortControllers.get(runId);
    if (controller) {
      controller.abort(new Error('Workflow cancelled'));
    }

    const now = this.clock.now();
    const workflow = this.workflows.get(execution.workflowName);

    // 2-4. Update execution status, delete pending tasks, and release the
    // uniqueness constraint atomically.
    const updatedExecution: WorkflowExecution = {
      ...execution,
      status: 'cancelled',
      updatedAt: now,
      completedAt: now,
    };
    await this.storage.transaction(async () => {
      await this.storage.saveExecution(updatedExecution);
      await this.storage.deleteActivityTasksForExecution(runId);
      if (execution.uniqueKey) {
        await this.storage.deleteUniqueKey(execution.workflowName, execution.uniqueKey);
      }
    });

    // 5. Invoke callback
    if (workflow?.onCancelled) {
      try {
        await workflow.onCancelled(runId, execution.state);
      } catch (err) {
        this.logger.error('onCancelled callback error', { runId, error: String(err) });
      }
    }

    this.emitEvent({
      type: 'execution:cancelled',
      timestamp: now,
      runId,
      workflowName: execution.workflowName,
    });

    this.logger.info('Cancelled workflow execution', { runId });
  }

  // ============================================================================
  // Execution Loop
  // ============================================================================

  /**
   * Run the engine, processing tasks until stopped or lifespan exceeded.
   */
  async run(options?: TickOptions): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Engine is already running');
      return;
    }

    this.isRunning = true;
    this.abortController = new AbortController();
    const deadline = options?.lifespan ? this.clock.now() + options.lifespan : null;
    const safetyBuffer = 500;

    this.logger.info('Engine started', { lifespan: options?.lifespan });

    try {
      while (this.isRunning && !this.abortController.signal.aborted) {
        // Check deadline
        if (deadline && this.clock.now() >= deadline - safetyBuffer) {
          this.logger.info('Approaching deadline, stopping gracefully');
          break;
        }

        let processed = 0;
        try {
          processed = await this.tick();
        } catch (err) {
          // tick() contains task-level errors itself; this is the
          // backstop for anything unexpected. Back off so a persistent
          // storage failure doesn't spin a hot error loop.
          this.logger.error('Tick failed', { error: String(err) });
          await this.scheduler.sleep(1000);
          continue;
        }

        // If no work was done, sleep briefly
        if (processed === 0) {
          await this.scheduler.sleep(100);
        }
      }
    } finally {
      this.isRunning = false;
      this.abortController = null;
      this.logger.info('Engine stopped');
    }
  }

  /**
   * Stop the running engine.
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }
    this.isRunning = false;
    this.abortController?.abort();
    this.logger.info('Engine stop requested');
  }

  /**
   * Process one batch of pending tasks. Returns number of tasks processed.
   */
  async tick(): Promise<number> {
    // Runs once per engine instance, on the first tick, so workflows have
    // been registered by the time stranded executions are repaired.
    if (!this.hasReconciled) {
      this.hasReconciled = true;
      try {
        await this.reconcileStrandedExecutions();
      } catch (err) {
        this.logger.error('Reconciliation failed', { error: String(err) });
      }
    }

    const now = this.clock.now();

    // Recovery cannot run only at create(): an engine booted inside
    // another engine's lease window correctly skips the leased task then,
    // but must still reclaim it once the lease lapses. Re-scan on a
    // half-lease cadence.
    if (now >= this.nextLeaseRecoveryAt) {
      this.nextLeaseRecoveryAt = now + Math.max(1000, Math.floor(this.leaseDurationMs / 2));
      try {
        await this.recoverActiveTasks();
      } catch (err) {
        this.logger.error('Lease recovery failed', { error: String(err) });
      }
    }

    let pendingTasks: ActivityTask[];
    try {
      pendingTasks = await this.storage.getPendingActivityTasks({ limit: 10, now });
    } catch (err) {
      this.logger.error('Failed to fetch pending tasks', { error: String(err) });
      return 0;
    }

    let processed = 0;
    for (const task of pendingTasks) {
      // Check if we should stop
      if (!this.isRunning && this.abortController?.signal.aborted) {
        break;
      }

      try {
        const success = await this.processTask(task);
        if (success) {
          processed++;
        }
      } catch (err) {
        // One task's storage failure (SQLITE_BUSY, poison row) must not
        // kill the loop — the task stays claimable/leased and is retried
        // or recovered on a later tick.
        this.logger.error('Task processing failed', { taskId: task.taskId, error: String(err) });
      }
    }

    return processed;
  }

  /**
   * Process a single task. Returns true if the task was processed.
   */
  private async processTask(task: ActivityTask): Promise<boolean> {
    const now = this.clock.now();

    // Try to claim the task
    const claimed = await this.storage.claimActivityTask(task.taskId, now, {
      ownerId: this.ownerId,
      leaseDurationMs: this.leaseDurationMs,
    });
    if (!claimed) {
      return false; // Already claimed or no longer pending
    }

    const activity = this.activities.get(task.activityName);
    if (!activity) {
      // Upgrade skew: the persisted task references an activity this
      // build doesn't register (renamed/removed step). Hold — never
      // dead-letter — so a later release that restores the name resumes
      // the workflow instead of every in-flight execution being nuked.
      await this.handleTaskHeld(claimed);
      return true;
    }

    // Check runWhen condition
    const runWhen: RunConditionFn = activity.options?.runWhen ?? conditions.always;
    const runtimeContext = this.environment.getRuntimeContext();
    const conditionResult = runWhen({ ...runtimeContext, input: claimed.input });

    if (!conditionResult.ready) {
      // Skip task, schedule for later retry
      await this.handleTaskSkipped(claimed, conditionResult.reason ?? 'Condition not met');
      return true;
    }

    // Execute the activity
    await this.executeActivity(claimed, activity);
    return true;
  }

  /**
   * Execute an activity.
   */
  private async executeActivity(task: ActivityTask, activity: Activity): Promise<void> {
    const now = this.clock.now();

    // Call onStart callback
    if (activity.options?.onStart) {
      try {
        await activity.options.onStart(task.taskId, task.input);
      } catch (err) {
        this.logger.error('onStart callback error', { taskId: task.taskId, error: String(err) });
      }
    }

    this.emitEvent({
      type: 'activity:started',
      timestamp: now,
      runId: task.runId,
      taskId: task.taskId,
      activityName: task.activityName,
    });

    // Create abort controller for timeout and cancellation
    const { signal, abort } = createAbortController();
    let timeoutHandle: unknown = null;

    // Register the controller for this execution (for cancellation propagation)
    this.activeAbortControllers.set(task.runId, { abort });

    if (task.timeout > 0) {
      timeoutHandle = this.scheduler.setTimeout(() => {
        abort(new ActivityTimeoutError(task.taskId, task.timeout));
      }, task.timeout);
    }

    // Heartbeat: renew the lease at half its duration for as long as the
    // activity runs, so long tasks aren't reclaimed by another engine.
    let heartbeatStopped = false;
    let heartbeatHandle: unknown = null;
    const scheduleHeartbeat = (): void => {
      heartbeatHandle = this.scheduler.setTimeout(() => {
        void this.storage
          .renewLease(task.taskId, this.ownerId, this.clock.now() + this.leaseDurationMs)
          .then(renewed => {
            if (renewed && !heartbeatStopped) {
              scheduleHeartbeat();
            }
          })
          .catch(err => {
            this.logger.warn('Lease renewal failed', { taskId: task.taskId, error: String(err) });
          });
      }, Math.floor(this.leaseDurationMs / 2));
    };
    scheduleHeartbeat();

    // Create activity context
    const runtimeContext = this.environment.getRuntimeContext();
    const context: ActivityContext = {
      ...runtimeContext,
      runId: task.runId,
      taskId: task.taskId,
      attempt: task.attempts,
      input: task.input,
      signal,
      log: (...args: unknown[]) => {
        this.logger.debug(`[Activity:${task.activityName}]`, { args, taskId: task.taskId });
      },
    };

    try {
      // Race the activity against the abort signal. Awaiting the handler
      // directly would let one hung handler (that ignores ctx.signal)
      // wedge the serial engine forever. Once the abort wins, any late
      // settlement of the handler is dropped — the failure already
      // recorded must not be overwritten (stale-success guard).
      const executePromise = Promise.resolve(activity.execute(context));
      executePromise.catch(() => {
        // Late rejection from a timed-out/abandoned handler: already
        // handled (or superseded) via the race — never let it surface
        // as an unhandled rejection.
      });

      let result: unknown;
      if (task.timeout > 0) {
        const abortPromise = new Promise<never>((_, reject) => {
          const fail = () => {
            const reason: unknown = signal.reason;
            reject(
              reason instanceof Error
                ? reason
                : new Error(typeof reason === 'string' ? reason : 'Activity aborted')
            );
          };
          if (signal.aborted) {
            fail();
          } else {
            signal.addEventListener('abort', fail, { once: true });
          }
        });
        result = await Promise.race([executePromise, abortPromise]);
      } else {
        result = await executePromise;
      }

      // Clear timeout
      if (timeoutHandle) {
        this.scheduler.clearTimeout(timeoutHandle);
      }

      // Handle success
      await this.handleTaskSuccess(task, activity, result as Record<string, unknown> | undefined);
    } catch (err) {
      // Clear timeout
      if (timeoutHandle) {
        this.scheduler.clearTimeout(timeoutHandle);
      }

      const error = err instanceof Error ? err : new Error(String(err));

      // Handle failure
      await this.handleTaskFailure(task, activity, error);
    } finally {
      heartbeatStopped = true;
      if (heartbeatHandle) {
        this.scheduler.clearTimeout(heartbeatHandle);
      }
      // Always clean up the controller reference
      this.activeAbortControllers.delete(task.runId);
    }
  }

  /**
   * Handle successful activity completion.
   */
  private async handleTaskSuccess(
    task: ActivityTask,
    activity: Activity,
    result: Record<string, unknown> | undefined
  ): Promise<void> {
    const now = this.clock.now();

    // Update task to completed
    const completedTask: ActivityTask = {
      ...task,
      status: 'completed',
      result: result ?? {},
      completedAt: now,
      lastAttemptAt: now,
    };

    // The completed-task write and the advance (execution update + next
    // task) must commit atomically — a crash between them strands the
    // workflow 'running' with no frontier task.
    await this.storage.transaction(async () => {
      await this.storage.saveActivityTask(completedTask);

      // Call onSuccess callback
      if (activity.options?.onSuccess) {
        try {
          await activity.options.onSuccess(task.taskId, task.input, result ?? {});
        } catch (err) {
          this.logger.error('onSuccess callback error', { taskId: task.taskId, error: String(err) });
        }
      }

      this.emitEvent({
        type: 'activity:completed',
        timestamp: now,
        runId: task.runId,
        taskId: task.taskId,
        activityName: task.activityName,
      });

      this.logger.debug('Activity completed', { taskId: task.taskId, activityName: task.activityName });

      // Advance the workflow
      await this.advanceWorkflow(task, result);
    });
  }

  /**
   * Advance the workflow to the next activity or completion.
   */
  private async advanceWorkflow(
    completedTask: ActivityTask,
    result: Record<string, unknown> | undefined
  ): Promise<void> {
    const now = this.clock.now();
    const execution = await this.storage.getExecution(completedTask.runId);
    if (!execution) {
      this.logger.error('Execution not found for completed task', { runId: completedTask.runId });
      return;
    }

    const workflow = this.workflows.get(execution.workflowName);
    if (!workflow) {
      this.logger.error('Workflow not found', { workflowName: execution.workflowName });
      return;
    }

    // Surface definition version skew (observability only — name-based
    // matching below keeps mixed-version resumes safe).
    if (
      workflow.version !== undefined &&
      execution.workflowVersion !== undefined &&
      workflow.version !== execution.workflowVersion
    ) {
      this.emitEvent({
        type: 'execution:version-skew',
        timestamp: now,
        runId: execution.runId,
        workflowName: workflow.name,
        persistedVersion: execution.workflowVersion,
        registeredVersion: workflow.version,
      });
      this.logger.warn('Execution resumed under a different workflow definition version', {
        runId: execution.runId,
        persistedVersion: execution.workflowVersion,
        registeredVersion: workflow.version,
      });
    }

    // Merge result into workflow state
    const newState = mergeState(execution.state, result);

    // Locate the completed activity by NAME in the CURRENT definition.
    // The persisted index belongs to the definition that scheduled the
    // task; after an app upgrade that inserted/removed steps, index
    // arithmetic would re-run or skip the wrong activity (H7).
    const completedIndex = workflow.activities.findIndex(a => a.name === completedTask.activityName);
    if (completedIndex === -1) {
      // The completed step no longer exists in this build's definition,
      // so its successor is unknowable. Leave the execution running with
      // no frontier task — reconciliation replays this advance and
      // succeeds once a definition containing the activity is registered.
      this.logger.warn('Completed activity not in registered definition — holding advance', {
        runId: execution.runId,
        activityName: completedTask.activityName,
        workflowName: workflow.name,
      });
      return;
    }

    // Check if this was the last activity
    const nextIndex = completedIndex + 1;
    const isComplete = nextIndex >= workflow.activities.length;

    if (isComplete) {
      // Mark workflow as completed
      const completedExecution: WorkflowExecution = {
        ...execution,
        state: newState,
        status: 'completed',
        updatedAt: now,
        completedAt: now,
      };
      await this.storage.saveExecution(completedExecution);

      // Release uniqueness constraint
      if (execution.uniqueKey) {
        await this.storage.deleteUniqueKey(execution.workflowName, execution.uniqueKey);
      }

      // Invoke completion callback
      if (workflow.onComplete) {
        try {
          await workflow.onComplete(execution.runId, newState);
        } catch (err) {
          this.logger.error('onComplete callback error', { runId: execution.runId, error: String(err) });
        }
      }

      this.emitEvent({
        type: 'execution:completed',
        timestamp: now,
        runId: execution.runId,
        workflowName: workflow.name,
      });

      this.logger.info('Workflow completed', { runId: execution.runId, workflowName: workflow.name });
    } else {
      // Schedule next activity
      const nextActivity = workflow.activities[nextIndex];
      if (!nextActivity) {
        this.logger.error('Next activity not found', { nextIndex });
        return;
      }

      const updatedExecution: WorkflowExecution = {
        ...execution,
        state: newState,
        currentActivityIndex: nextIndex,
        currentActivityName: nextActivity.name,
        updatedAt: now,
      };
      await this.storage.saveExecution(updatedExecution);

      await this.scheduleActivityTask(updatedExecution, nextActivity, newState);

      this.logger.debug('Advanced to next activity', {
        runId: execution.runId,
        activityName: nextActivity.name,
        index: nextIndex,
      });
    }
  }

  /**
   * Handle activity failure (may retry or fail permanently).
   */
  private async handleTaskFailure(task: ActivityTask, activity: Activity, error: Error): Promise<void> {
    const now = this.clock.now();

    // Call onFailure callback
    if (activity.options?.onFailure) {
      try {
        await activity.options.onFailure(task.taskId, task.input, error, task.attempts);
      } catch (err) {
        this.logger.error('onFailure callback error', { taskId: task.taskId, error: String(err) });
      }
    }

    // Only real failures count toward exhaustion — attempts is the claim
    // count and includes claims lost to crashes.
    const failures = (task.failures ?? 0) + 1;

    if (failures < task.maxAttempts && !isNonRetryableError(error)) {
      // Schedule retry with backoff
      const retryOpts = activity.options?.retry ?? {};
      const delay = calculateBackoffDelay(
        failures,
        retryOpts.initialInterval ?? DEFAULT_INITIAL_INTERVAL,
        retryOpts.backoffCoefficient ?? DEFAULT_BACKOFF_COEFFICIENT,
        retryOpts.maximumInterval
      );

      const retriedTask: ActivityTask = {
        ...task,
        status: 'pending',
        failures,
        scheduledFor: now + delay,
        lastAttemptAt: now,
        error: error.message,
        errorStack: error.stack,
        ownerId: undefined,
        leaseExpiresAt: undefined,
      };
      await this.storage.saveActivityTask(retriedTask);

      this.logger.debug('Scheduled retry', {
        taskId: task.taskId,
        failures,
        maxAttempts: task.maxAttempts,
        delay,
      });
    } else {
      // Permanent failure
      await this.handleTaskPermanentFailure({ ...task, failures }, error);
    }
  }

  /**
   * Handle permanent task failure (exhausted retries).
   */
  private async handleTaskPermanentFailure(task: ActivityTask, error: Error): Promise<void> {
    const now = this.clock.now();
    const execution = await this.storage.getExecution(task.runId);
    const workflow = execution ? this.workflows.get(execution.workflowName) : null;
    const activity = this.activities.get(task.activityName);

    // Update task to failed
    const failedTask: ActivityTask = {
      ...task,
      status: 'failed',
      lastAttemptAt: now,
      completedAt: now,
      error: error.message,
      errorStack: error.stack,
    };

    // Failed task, dead letter, and failed execution must commit
    // atomically — a partial write leaves the workflow 'running' with a
    // dead frontier task, or a DLQ entry with a live execution.
    await this.storage.transaction(async () => {
      await this.storage.saveActivityTask(failedTask);

      // Call onFailed callback
      if (activity?.options?.onFailed) {
        try {
          await activity.options.onFailed(task.taskId, task.input, error);
        } catch (err) {
          this.logger.error('onFailed callback error', { taskId: task.taskId, error: String(err) });
        }
      }

      // Move to dead letter queue
      const deadLetter: DeadLetterRecord = {
        id: generateId(),
        runId: task.runId,
        taskId: task.taskId,
        activityName: task.activityName,
        workflowName: execution?.workflowName ?? 'unknown',
        input: task.input,
        error: error.message,
        errorStack: error.stack,
        attempts: task.attempts,
        failedAt: now,
        acknowledged: false,
        nonRetryable: isNonRetryableError(error),
      };
      await this.storage.saveDeadLetter(deadLetter);

      this.emitEvent({
        type: 'activity:failed',
        timestamp: now,
        runId: task.runId,
        taskId: task.taskId,
        activityName: task.activityName,
        error: error.message,
      });

      this.emitEvent({
        type: 'deadletter:added',
        timestamp: now,
        runId: task.runId,
        taskId: task.taskId,
        activityName: task.activityName,
      });

      // Mark workflow as failed
      if (execution) {
        const failedExecution: WorkflowExecution = {
          ...execution,
          status: 'failed',
          error: error.message,
          failedActivityName: task.activityName,
          updatedAt: now,
          completedAt: now,
        };
        await this.storage.saveExecution(failedExecution);

        // Release uniqueness constraint
        if (execution.uniqueKey) {
          await this.storage.deleteUniqueKey(execution.workflowName, execution.uniqueKey);
        }

        // Invoke workflow failure callback
        if (workflow?.onFailed) {
          try {
            await workflow.onFailed(execution.runId, execution.state, error);
          } catch (err) {
            this.logger.error('onFailed callback error', { runId: execution.runId, error: String(err) });
          }
        }

        this.emitEvent({
          type: 'execution:failed',
          timestamp: now,
          runId: execution.runId,
          workflowName: execution.workflowName,
          error: error.message,
        });
      }
    });

    this.logger.error('Activity permanently failed', {
      taskId: task.taskId,
      activityName: task.activityName,
      error: error.message,
    });
  }

  /**
   * Hold a task whose activity isn't registered in this build (upgrade
   * skew). The claim is released without burning an attempt and the task
   * is parked pending with a recheck delay — it self-heals as soon as a
   * definition containing the activity is registered again.
   */
  private async handleTaskHeld(task: ActivityTask): Promise<void> {
    const now = this.clock.now();

    const heldTask: ActivityTask = {
      ...task,
      status: 'pending',
      scheduledFor: now + HELD_TASK_RECHECK_DELAY,
      lastAttemptAt: now,
      ownerId: undefined,
      leaseExpiresAt: undefined,
      // Being held is not a failure and must not burn the claim either
      attempts: Math.max(0, task.attempts - 1),
    };
    await this.storage.saveActivityTask(heldTask);

    this.emitEvent({
      type: 'activity:held',
      timestamp: now,
      runId: task.runId,
      taskId: task.taskId,
      activityName: task.activityName,
    });

    this.logger.warn('Activity not registered in this build — holding task', {
      taskId: task.taskId,
      activityName: task.activityName,
      recheckAt: heldTask.scheduledFor,
    });
  }

  /**
   * Handle task skipped due to runWhen condition.
   */
  private async handleTaskSkipped(task: ActivityTask, reason: string): Promise<void> {
    const now = this.clock.now();
    const activity = this.activities.get(task.activityName);

    // Reschedule for later (default 30 seconds)
    const delay = 30000;
    const skippedTask: ActivityTask = {
      ...task,
      status: 'pending',
      scheduledFor: now + delay,
      lastAttemptAt: now,
      ownerId: undefined,
      leaseExpiresAt: undefined,
    };
    // Decrement attempts since this wasn't a real failure
    skippedTask.attempts = Math.max(0, skippedTask.attempts - 1);
    await this.storage.saveActivityTask(skippedTask);

    // Call onSkipped callback
    if (activity?.options?.onSkipped) {
      try {
        await activity.options.onSkipped(task.taskId, task.input, reason);
      } catch (err) {
        this.logger.error('onSkipped callback error', { taskId: task.taskId, error: String(err) });
      }
    }

    this.emitEvent({
      type: 'activity:skipped',
      timestamp: now,
      runId: task.runId,
      taskId: task.taskId,
      activityName: task.activityName,
    });

    this.logger.debug('Activity skipped', { taskId: task.taskId, reason });
  }

  // ============================================================================
  // Dead Letter Queue
  // ============================================================================

  /**
   * Get all dead letter records.
   */
  async getDeadLetters(): Promise<DeadLetterRecord[]> {
    return this.storage.getDeadLetters();
  }

  /**
   * Get unacknowledged dead letter records.
   */
  async getUnacknowledgedDeadLetters(): Promise<DeadLetterRecord[]> {
    return this.storage.getUnacknowledgedDeadLetters();
  }

  /**
   * Acknowledge a dead letter record.
   */
  async acknowledgeDeadLetter(id: string): Promise<void> {
    await this.storage.acknowledgeDeadLetter(id);
  }

  /**
   * Redrive a dead-lettered task: reset it to pending with a fresh retry
   * budget, re-open its execution at the same activity cursor, and remove
   * the dead letter record. This is the "Force Retry" recovery path.
   *
   * Throws if the dead letter, its execution, or its task no longer
   * exists, or if the execution's uniqueKey has since been claimed by
   * another running execution. On throw, nothing is mutated.
   *
   * @returns the re-opened execution
   */
  async retryFromDeadLetter(deadLetterId: string): Promise<WorkflowExecution> {
    const now = this.clock.now();

    const deadLetters = await this.storage.getDeadLetters();
    const deadLetter = deadLetters.find(dl => dl.id === deadLetterId);
    if (!deadLetter) {
      throw new Error(`Dead letter not found: ${deadLetterId}`);
    }

    const execution = await this.storage.getExecution(deadLetter.runId);
    if (!execution) {
      throw new Error(
        `Cannot redrive dead letter ${deadLetterId}: execution ${deadLetter.runId} no longer exists`
      );
    }

    const task = await this.storage.getActivityTask(deadLetter.taskId);
    if (!task) {
      throw new Error(
        `Cannot redrive dead letter ${deadLetterId}: task ${deadLetter.taskId} no longer exists`
      );
    }

    const revivedExecution: WorkflowExecution = {
      ...execution,
      status: 'running',
      error: undefined,
      failedActivityName: undefined,
      completedAt: undefined,
      updatedAt: now,
    };

    // Fresh retry budget: failures drives exhaustion; attempts stays as
    // the historical claim count.
    const revivedTask: ActivityTask = {
      ...task,
      status: 'pending',
      failures: 0,
      scheduledFor: undefined,
      startedAt: undefined,
      completedAt: undefined,
      error: undefined,
      errorStack: undefined,
      ownerId: undefined,
      leaseExpiresAt: undefined,
    };

    // Key reservation, task reset, execution re-open, and dead-letter
    // removal must commit atomically — a partial write recreates exactly
    // the stranded shapes the C2 fix eliminated.
    await this.storage.transaction(async () => {
      if (execution.uniqueKey) {
        const reserved = await this.storage.setUniqueKey(
          execution.workflowName,
          execution.uniqueKey,
          execution.runId
        );
        if (!reserved) {
          throw new Error(
            `Cannot redrive dead letter ${deadLetterId}: uniqueKey '${execution.uniqueKey}' is held by another running execution`
          );
        }
      }

      await this.storage.saveActivityTask(revivedTask);
      await this.storage.saveExecution(revivedExecution);
      await this.storage.deleteDeadLetter(deadLetterId);
    });

    this.emitEvent({
      type: 'deadletter:redriven',
      timestamp: now,
      runId: deadLetter.runId,
      taskId: deadLetter.taskId,
      activityName: deadLetter.activityName,
      workflowName: deadLetter.workflowName,
    });

    this.logger.info('Redrove dead letter', {
      deadLetterId,
      runId: deadLetter.runId,
      taskId: deadLetter.taskId,
      activityName: deadLetter.activityName,
    });

    return revivedExecution;
  }

  /**
   * Purge dead letter records.
   */
  async purgeDeadLetters(options: { olderThanMs: number; acknowledgedOnly?: boolean }): Promise<number> {
    return this.storage.purgeDeadLetters({
      ...options,
      now: this.clock.now(),
    });
  }

  // ============================================================================
  // Maintenance
  // ============================================================================

  /**
   * Run cleanup operations.
   */
  private async runCleanup(): Promise<void> {
    const now = this.clock.now();

    if (this.cleanup?.completedExecutionRetention) {
      const purged = await this.storage.purgeExecutions({
        olderThanMs: this.cleanup.completedExecutionRetention,
        statuses: ['completed', 'failed', 'cancelled'],
        now,
      });
      if (purged > 0) {
        this.logger.info('Purged completed executions', { count: purged });
      }
    }

    if (this.cleanup?.deadLetterRetention) {
      const purged = await this.storage.purgeDeadLetters({
        olderThanMs: this.cleanup.deadLetterRetention,
        acknowledgedOnly: true,
        now,
      });
      if (purged > 0) {
        this.logger.info('Purged dead letters', { count: purged });
      }
    }
  }

  // ============================================================================
  // Events
  // ============================================================================

  private emitEvent(event: EngineEvent): void {
    if (this.onEvent) {
      try {
        this.onEvent(event);
      } catch {
        // Ignore event handler errors
      }
    }
  }
}
