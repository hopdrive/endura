/**
 * Unit Test: WorkflowEngine - Upgrade skew safety (H7)
 *
 * An app update can ship a changed workflow definition while executions
 * persisted by the previous version are still in flight (the driver
 * app's EWZ/W0P/VD4 unmapped-stage incident class). The engine must:
 * - hold (not dead-letter) tasks whose activity is no longer registered,
 *   self-healing when a later release restores the name
 * - advance by activity NAME in the current definition, so inserting or
 *   removing steps around the cursor cannot corrupt or skip work
 * - reconcile stranded executions by name, not by the persisted index
 * - drop stale activity registrations when a workflow is re-registered
 * - surface definition version skew via execution:version-skew
 *
 * Each test simulates an app upgrade as a fresh engine over the same
 * storage with a changed definition.
 */

import { WorkflowEngine } from '../../../../src/core/engine/WorkflowEngine';
import { InMemoryStorage } from '../../../../src/storage/memory';
import { MockClock, MockScheduler, MockEnvironment } from '../../../../src/core/mocks';
import { defineActivity, defineWorkflow } from '../../../../src/core/definitions';
import { Workflow, EngineEvent } from '../../../../src/core/types';
import { createLoopbackDispatcher } from '../../../../src/workers/loopback';

describe('WorkflowEngine - Upgrade skew (H7)', () => {
  let storage: InMemoryStorage;
  let clock: MockClock;
  let scheduler: MockScheduler;
  let environment: MockEnvironment;

  beforeEach(() => {
    storage = new InMemoryStorage();
    clock = new MockClock(1000000);
    scheduler = new MockScheduler(clock);
    environment = new MockEnvironment();
  });

  async function createEngine(onEvent?: (event: EngineEvent) => void): Promise<WorkflowEngine> {
    return WorkflowEngine.create({ dispatcher: createLoopbackDispatcher(), storage, clock, scheduler, environment, onEvent });
  }

  function step(name: string, executed: string[]) {
    return defineActivity<Record<string, unknown>, Record<string, unknown>>({
      name,
      execute: async (): Promise<Record<string, unknown>> => {
        executed.push(name);
        return { [name]: true };
      },
    });
  }

  it('holds a task whose activity is unregistered instead of dead-lettering it', async () => {
    const executed: string[] = [];

    // v1 app: [a, b] — a completes, b is scheduled
    const engine1 = await createEngine();
    const wfV1 = defineWorkflow({ name: 'wf', activities: [step('a', executed), step('b', executed)] });
    const execution = await engine1.start(wfV1, { input: {} });
    await engine1.tick();
    expect(executed).toEqual(['a']);

    // v2 app renames b -> b2 while the b task is still pending
    const engine2 = await createEngine();
    engine2.registerWorkflow(
      defineWorkflow({ name: 'wf', activities: [step('a', executed), step('b2', executed)] })
    );
    await engine2.tick();

    // Held, not dead-lettered: no DLQ entry, execution still running,
    // task back to pending with a future reschedule and no burned claim
    expect(await engine2.getDeadLetters()).toHaveLength(0);
    expect((await storage.getExecution(execution.runId))?.status).toBe('running');

    const tasks = await storage.getActivityTasksForExecution(execution.runId);
    const held = tasks.find(t => t.activityName === 'b');
    expect(held?.status).toBe('pending');
    expect(held?.scheduledFor).toBeGreaterThan(clock.now());
    expect(held?.attempts).toBe(0);
    expect(held?.failures ?? 0).toBe(0);

    // v3 app restores the activity name — the workflow self-heals
    clock.advance(120000);
    const engine3 = await createEngine();
    engine3.registerWorkflow(wfV1);
    await engine3.tick();

    expect(executed).toEqual(['a', 'b']);
    expect((await storage.getExecution(execution.runId))?.status).toBe('completed');
  });

  it('emits activity:held while holding', async () => {
    const executed: string[] = [];
    const engine1 = await createEngine();
    const execution = await engine1.start(
      defineWorkflow({ name: 'wf', activities: [step('gone', executed)] }),
      { input: {} }
    );

    const events: EngineEvent[] = [];
    const engine2 = await createEngine(e => {
      if (e.type === 'activity:held') events.push(e);
    });
    engine2.registerWorkflow(defineWorkflow({ name: 'wf', activities: [step('other', executed)] }));
    await engine2.tick();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'activity:held',
      runId: execution.runId,
      activityName: 'gone',
    });
  });

  it('advances by name when steps are inserted around the cursor', async () => {
    const executed: string[] = [];

    // v1 app: [a, b, c] — run through a, leaving b's task pending
    const engine1 = await createEngine();
    const execution = await engine1.start(
      defineWorkflow({ name: 'wf', activities: [step('a', executed), step('b', executed), step('c', executed)] }),
      { input: {} }
    );
    await engine1.tick();
    expect(executed).toEqual(['a']);

    // v2 app inserts x between a and b: [a, x, b, c]. The persisted
    // cursor (index 1 = 'b') must keep meaning 'b', and after b the next
    // step must be c — index arithmetic on the old list would re-run b
    // or misexecute.
    const engine2 = await createEngine();
    engine2.registerWorkflow(
      defineWorkflow({
        name: 'wf',
        activities: [step('a', executed), step('x', executed), step('b', executed), step('c', executed)],
      })
    );
    await engine2.tick(); // b
    await engine2.tick(); // c

    expect(executed).toEqual(['a', 'b', 'c']);
    const final = await storage.getExecution(execution.runId);
    expect(final?.status).toBe('completed');
    expect(final?.state).toMatchObject({ a: true, b: true, c: true });
    // x sits behind the cursor; it is never retroactively executed
    expect(executed).not.toContain('x');
  });

  it('reconciles a stranded execution by name when the index moved', async () => {
    const executed: string[] = [];

    // A stranded execution persisted by the old app: running, cursor at
    // 'b' which was index 1 in the old definition, no frontier task.
    await storage.saveExecution({
      runId: 'stranded-1',
      workflowName: 'wf',
      currentActivityIndex: 1,
      currentActivityName: 'b',
      status: 'running',
      input: {},
      state: { a: true },
      createdAt: 999000,
      updatedAt: 999000,
    });

    // The new app's definition puts b at index 2: [x, a, b, c]
    const engine = await createEngine();
    engine.registerWorkflow(
      defineWorkflow({
        name: 'wf',
        activities: [step('x', executed), step('a', executed), step('b', executed), step('c', executed)],
      })
    );

    await engine.tick(); // reconcile schedules b; may also run it
    await engine.tick(); // b (if not already) then advance
    await engine.tick(); // c

    expect(executed).toEqual(['b', 'c']);
    expect((await storage.getExecution('stranded-1'))?.status).toBe('completed');
  });

  it('drops stale activity registrations when a workflow is re-registered', async () => {
    const executed: string[] = [];
    const engine = await createEngine();

    engine.registerWorkflow(defineWorkflow({ name: 'wf', activities: [step('old', executed)] }));
    engine.registerWorkflow(defineWorkflow({ name: 'wf', activities: [step('new', executed)] }));

    // The stale 'old' activity must not be reachable — a pending task
    // for it holds instead of executing v1 code in a v2 app.
    expect(engine.getActivity('old')).toBeUndefined();
    expect(engine.getActivity('new')).toBeDefined();
  });

  it('persists the workflow definition version and flags skew on resume', async () => {
    const executed: string[] = [];

    // v1 app stamps its definition version on the execution
    const engine1 = await createEngine();
    const wfV1: Workflow = defineWorkflow({
      name: 'wf',
      version: '1',
      activities: [step('a', executed), step('b', executed)],
    });
    const execution = await engine1.start(wfV1, { input: {} });
    expect((await storage.getExecution(execution.runId))?.workflowVersion).toBe('1');
    await engine1.tick(); // a

    // v2 app resumes it with a different definition version
    const skewEvents: EngineEvent[] = [];
    const engine2 = await createEngine(e => {
      if (e.type === 'execution:version-skew') skewEvents.push(e);
    });
    engine2.registerWorkflow(
      defineWorkflow({ name: 'wf', version: '2', activities: [step('a', executed), step('b', executed)] })
    );
    await engine2.tick(); // b advances under version skew

    expect(skewEvents.length).toBeGreaterThanOrEqual(1);
    expect(skewEvents[0]).toMatchObject({
      type: 'execution:version-skew',
      runId: execution.runId,
      persistedVersion: '1',
      registeredVersion: '2',
    });

    // Skew is observability, not a gate: the workflow still completes
    expect((await storage.getExecution(execution.runId))?.status).toBe('completed');
  });
});
