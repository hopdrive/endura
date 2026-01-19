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
  WorkflowExecution,
  ActivityTask,
  DeadLetterRecord,
  WorkflowExecutionStatus,
  ActivityContext,
  StartWorkflowOptions,
  ProcessOptions,
  ProcessResult,
  EngineEvent,
  CleanupConfig,
  WorkflowEngineConfig,
  UniqueConstraintError,
  ExecutionNotFoundError,
  ActivityTimeoutError,
  RunConditionFn,
} from '../types';
import { generateId, mergeState, calculateBackoffDelay, silentLogger, createAbortController } from '../utils';
import { conditions } from '../conditions';

// Default activity options
const DEFAULT_TIMEOUT = 25000;
const DEFAULT_MAX_ATTEMPTS = 1;
const DEFAULT_INITIAL_INTERVAL = 1000;
const DEFAULT_BACKOFF_COEFFICIENT = 2;
const DEFAULT_PRIORITY = 0;

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
  private processingPromise: Promise<ProcessResult> | null = null;
  private autoProcess: boolean;

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
    // Auto-process is enabled by default for production use, but can be disabled for testing
    this.autoProcess = config.autoProcess ?? true;
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
   * Recover tasks that were active when the engine crashed.
   */
  private async recoverActiveTasks(): Promise<void> {
    const activeTasks = await this.storage.getActivityTasksByStatus('active');
    const now = this.clock.now();

    for (const task of activeTasks) {
      this.logger.info('Recovering crashed task', { taskId: task.taskId, activityName: task.activityName });

      // Check if max attempts exceeded
      if (task.attempts >= task.maxAttempts) {
        // Move to failed state
        await this.handleTaskPermanentFailure(task, new Error('Crashed during execution'));
      } else {
        // Reset to pending for retry
        const updatedTask: ActivityTask = {
          ...task,
          status: 'pending',
          scheduledFor: now, // Run immediately
          error: 'Recovered from crash',
        };
        await this.storage.saveActivityTask(updatedTask);
      }
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

    // Also register all activities from this workflow
    for (const activity of workflow.activities) {
      this.activities.set(activity.name, activity);
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

    // Handle uniqueness constraint
    if (options.uniqueKey) {
      const canUse = await this.storage.setUniqueKey(workflow.name, options.uniqueKey, runId);
      if (!canUse) {
        const existingRunId = await this.storage.getUniqueKey(workflow.name, options.uniqueKey);
        if (existingRunId) {
          if (options.onConflict === 'ignore') {
            const existing = await this.storage.getExecution(existingRunId);
            if (existing) {
              return existing;
            }
          }
          throw new UniqueConstraintError(workflow.name, options.uniqueKey, existingRunId);
        }
      }
    }

    const firstActivity = workflow.activities[0];
    if (!firstActivity) {
      throw new Error(`Workflow '${workflow.name}' has no activities`);
    }

    // Create workflow execution
    const execution: WorkflowExecution = {
      runId,
      workflowName: workflow.name,
      uniqueKey: options.uniqueKey,
      currentActivityIndex: 0,
      currentActivityName: firstActivity.name,
      status: 'running',
      input: options.input as Record<string, unknown>,
      state: options.input as Record<string, unknown>,
      createdAt: now,
      updatedAt: now,
    };

    await this.storage.saveExecution(execution);

    // Create first activity task
    await this.scheduleActivityTask(execution, firstActivity, execution.state);

    this.emitEvent({
      type: 'execution:started',
      timestamp: now,
      runId,
      workflowName: workflow.name,
    });

    this.logger.info('Started workflow execution', { runId, workflowName: workflow.name });

    // Auto-trigger processing for the new task
    this.scheduleImmediateProcess();

    return execution;
  }

  /**
   * Schedule an activity task for execution.
   */
  private async scheduleActivityTask(
    execution: WorkflowExecution,
    activity: Activity,
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

    // 2. Update execution status
    const updatedExecution: WorkflowExecution = {
      ...execution,
      status: 'cancelled',
      updatedAt: now,
      completedAt: now,
    };
    await this.storage.saveExecution(updatedExecution);

    // 3. Delete pending tasks for this execution
    await this.storage.deleteActivityTasksForExecution(runId);

    // 4. Release uniqueness constraint
    if (execution.uniqueKey) {
      await this.storage.deleteUniqueKey(execution.workflowName, execution.uniqueKey);
    }

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
  // Processing
  // ============================================================================

  /**
   * Process pending tasks until the queue is empty or timeout is reached.
   * This is the primary way to trigger task execution.
   *
   * Returns when:
   * - No more tasks ready to process (queue empty or all tasks have future scheduledFor)
   * - Timeout reached (if lifespan specified)
   * - stop() called
   *
   * @returns ProcessResult with count and reason for stopping
   */
  async process(options?: ProcessOptions): Promise<ProcessResult> {
    // Handle concurrent calls - return early if already processing
    if (this.processingPromise) {
      this.logger.debug('Already processing, skipping');
      return { processed: 0, reason: 'already-processing' };
    }

    this.isRunning = true;
    this.abortController = new AbortController();
    const deadline = options?.lifespan ? this.clock.now() + options.lifespan : null;
    const safetyBuffer = 500;

    this.logger.debug('Processing started', { lifespan: options?.lifespan });

    // Create the processing promise
    this.processingPromise = this.processInternal(deadline, safetyBuffer);

    try {
      const result = await this.processingPromise;
      return result;
    } finally {
      this.processingPromise = null;
      this.isRunning = false;
      this.abortController = null;
      this.logger.debug('Processing stopped');
    }
  }

  /**
   * Internal processing loop.
   */
  private async processInternal(deadline: number | null, safetyBuffer: number): Promise<ProcessResult> {
    let totalProcessed = 0;

    while (this.isRunning && !this.abortController?.signal.aborted) {
      // Check deadline
      if (deadline && this.clock.now() >= deadline - safetyBuffer) {
        this.logger.debug('Approaching deadline, stopping gracefully');
        return { processed: totalProcessed, reason: 'deadline' };
      }

      // Get pending tasks
      const now = this.clock.now();
      const pendingTasks = await this.storage.getPendingActivityTasks({ limit: 10, now });

      // If no tasks ready, we're done
      if (pendingTasks.length === 0) {
        return { processed: totalProcessed, reason: 'queue-empty' };
      }

      // Process tasks
      for (const task of pendingTasks) {
        if (!this.isRunning || this.abortController?.signal.aborted) {
          return { processed: totalProcessed, reason: 'stopped' };
        }

        // Check deadline before each task
        if (deadline && this.clock.now() >= deadline - safetyBuffer) {
          return { processed: totalProcessed, reason: 'deadline' };
        }

        const success = await this.processTask(task);
        if (success) {
          totalProcessed++;
        }
      }
    }

    return { processed: totalProcessed, reason: 'stopped' };
  }

  /**
   * Stop the running processing.
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }
    this.isRunning = false;
    this.abortController?.abort();
    this.logger.debug('Processing stop requested');
  }

  /**
   * Schedule immediate processing via microtask to avoid deep recursion.
   * This is used internally to auto-trigger processing after workflow starts
   * or activity completions. Can be disabled via autoProcess config option.
   */
  private scheduleImmediateProcess(): void {
    if (!this.autoProcess) {
      return;
    }
    queueMicrotask(() => {
      if (!this.processingPromise) {
        this.process().catch(err => {
          this.logger.error('Auto-process failed', { error: String(err) });
        });
      }
    });
  }

  /**
   * Check if there are any pending tasks ready to process.
   */
  async hasPendingWork(): Promise<boolean> {
    const now = this.clock.now();
    const tasks = await this.storage.getPendingActivityTasks({ limit: 1, now });
    return tasks.length > 0;
  }

  /**
   * Process one batch of pending tasks (up to 10).
   * Unlike process(), this does NOT loop - it processes once and returns.
   * Useful for testing and manual step-by-step control.
   *
   * @returns Number of tasks processed in this batch
   */
  async tick(): Promise<number> {
    const now = this.clock.now();
    const pendingTasks = await this.storage.getPendingActivityTasks({ limit: 10, now });

    let processed = 0;
    for (const task of pendingTasks) {
      const success = await this.processTask(task);
      if (success) {
        processed++;
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
    const claimed = await this.storage.claimActivityTask(task.taskId, now);
    if (!claimed) {
      return false; // Already claimed or no longer pending
    }

    const activity = this.activities.get(task.activityName);
    if (!activity) {
      this.logger.error('Activity not found', { activityName: task.activityName });
      await this.handleTaskPermanentFailure(claimed, new Error(`Activity '${task.activityName}' not registered`));
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
      // Execute the activity
      const result = await activity.execute(context);

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

    // Merge result into workflow state
    const newState = mergeState(execution.state, result);

    // Check if this was the last activity
    const nextIndex = execution.currentActivityIndex + 1;
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

      // Auto-trigger processing for the next task
      this.scheduleImmediateProcess();
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

    // Check if we should retry
    if (task.attempts < task.maxAttempts) {
      // Schedule retry with backoff
      const retryOpts = activity.options?.retry ?? {};
      const delay = calculateBackoffDelay(
        task.attempts,
        retryOpts.initialInterval ?? DEFAULT_INITIAL_INTERVAL,
        retryOpts.backoffCoefficient ?? DEFAULT_BACKOFF_COEFFICIENT,
        retryOpts.maximumInterval
      );

      const retriedTask: ActivityTask = {
        ...task,
        status: 'pending',
        scheduledFor: now + delay,
        lastAttemptAt: now,
        error: error.message,
        errorStack: error.stack,
      };
      await this.storage.saveActivityTask(retriedTask);

      this.logger.debug('Scheduled retry', {
        taskId: task.taskId,
        attempt: task.attempts,
        maxAttempts: task.maxAttempts,
        delay,
      });
    } else {
      // Permanent failure
      await this.handleTaskPermanentFailure(task, error);
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

    this.logger.error('Activity permanently failed', {
      taskId: task.taskId,
      activityName: task.activityName,
      error: error.message,
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
