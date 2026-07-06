/**
 * Generic engine inspection — everything the library persists about
 * every job, read straight from storage, for ANY live engine (a
 * running scenario's client, the field-test engine, or the
 * playground). This is the data layer behind the slide-up engine
 * manager panel.
 */

import {
  ActivityTask,
  ActivityTaskStatus,
  DeadLetterRecord,
  WorkflowExecution,
  WorkflowExecutionStatus,
} from 'endura';
import { ParityClient } from './expoPlatform';

export type JobPhase =
  | 'active'
  | 'backoff'
  | 'held'
  | 'waiting'
  | 'dead'
  | 'failed'
  | 'cancelled'
  | 'completed';

export interface JobRecord {
  runId: string;
  workflowName: string;
  /** metadata.jobId when the app set one, else the workflow name. */
  label: string;
  /** Current/next stage name. */
  stage: string;
  phase: JobPhase;
  attempts: number;
  scheduledFor?: number;
  createdAt: number;
  execution: WorkflowExecution;
  /** All task rows for the run, in creation order — the pipeline trail. */
  tasks: ActivityTask[];
  /** The in-flight or most recent task. */
  currentTask?: ActivityTask;
  deadLetter?: DeadLetterRecord;
}

export interface EngineInspection {
  jobs: JobRecord[];
  counts: Record<JobPhase, number>;
  logs: string[];
}

const EXECUTION_STATUSES: WorkflowExecutionStatus[] = ['running', 'completed', 'failed', 'cancelled'];
const TASK_STATUSES: ActivityTaskStatus[] = ['pending', 'active', 'completed', 'failed', 'skipped'];

/** Live phases sort before terminal ones; within each group see below. */
const PHASE_ORDER: JobPhase[] = [
  'active',
  'backoff',
  'held',
  'waiting',
  'dead',
  'failed',
  'cancelled',
  'completed',
];

export async function inspectEngine(client: ParityClient): Promise<EngineInspection> {
  const [executionLists, taskLists, deadLetters] = await Promise.all([
    Promise.all(EXECUTION_STATUSES.map(s => client.storage.getExecutionsByStatus(s))),
    Promise.all(TASK_STATUSES.map(s => client.storage.getActivityTasksByStatus(s))),
    client.storage.getDeadLetters(),
  ]);
  const executions = executionLists.flat() as WorkflowExecution[];
  const allTasks = taskLists.flat() as ActivityTask[];

  const tasksByRun = new Map<string, ActivityTask[]>();
  for (const task of allTasks) {
    const list = tasksByRun.get(task.runId) ?? [];
    list.push(task);
    tasksByRun.set(task.runId, list);
  }
  const deadLetterByRun = new Map((deadLetters as DeadLetterRecord[]).map(dl => [dl.runId, dl]));

  const jobs: JobRecord[] = executions.map(execution => {
    const tasks = (tasksByRun.get(execution.runId) ?? []).sort((a, b) => a.createdAt - b.createdAt);
    const currentTask = tasks.find(t => t.status === 'pending' || t.status === 'active') ?? tasks[tasks.length - 1];
    const deadLetter = deadLetterByRun.get(execution.runId);
    const lastHistory = currentTask?.errorHistory?.[currentTask.errorHistory.length - 1];

    let phase: JobPhase;
    if (execution.status === 'cancelled') phase = 'cancelled';
    else if (execution.status === 'completed') phase = 'completed';
    else if (deadLetter) phase = 'dead';
    else if (execution.status === 'failed') phase = 'failed';
    else if (currentTask?.status === 'active') phase = 'active';
    else if (currentTask?.status === 'pending') {
      if (lastHistory?.kind === 'skip') phase = 'held';
      else if ((currentTask.attempts ?? 0) > 0) phase = 'backoff';
      else phase = 'waiting';
    } else phase = 'waiting';

    const meta = (execution.metadata ?? {}) as Record<string, unknown>;
    return {
      runId: execution.runId,
      workflowName: execution.workflowName,
      label: meta.jobId !== undefined ? String(meta.jobId) : execution.workflowName,
      stage: execution.currentActivityName,
      phase,
      attempts: deadLetter?.attempts ?? currentTask?.attempts ?? 0,
      scheduledFor: currentTask?.status === 'pending' ? currentTask.scheduledFor : undefined,
      createdAt: execution.createdAt,
      execution,
      tasks,
      currentTask,
      deadLetter,
    };
  });

  jobs.sort((a, b) => {
    const rank = PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase);
    if (rank !== 0) return rank;
    // Live work oldest-first (queue order); terminal work newest-first.
    const terminal = ['dead', 'failed', 'cancelled', 'completed'].includes(a.phase);
    return terminal ? b.createdAt - a.createdAt : a.createdAt - b.createdAt;
  });

  const counts = Object.fromEntries(PHASE_ORDER.map(phase => [phase, 0])) as Record<JobPhase, number>;
  for (const job of jobs) counts[job.phase] += 1;

  return { jobs, counts, logs: client.parityLogs.slice(-40) };
}
