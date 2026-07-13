/**
 * Scenario runner: owns the per-scenario lifecycle (isolated database,
 * client construction, restart / background-wake simulation,
 * connectivity control, fake server) and produces the structured
 * ScenarioResult the review's contract requires.
 *
 * Platform specifics (expo-sqlite database creation/deletion, client
 * construction) are injected via HarnessPlatform so this module has no
 * React Native imports and the framework logic stays portable.
 */

import { FakeServer } from './fakeServer';
import { ScenarioDefinition, ScenarioController, ScenarioResult } from './types';

/** Minimal structural view of ExpoWorkflowClient the runner relies on. */
export interface HarnessClient {
  engine: unknown;
  storage: HarnessStorage;
  /** Present on ExpoWorkflowClient — used to push connectivity changes instantly (NetInfo-listener pattern). */
  environment?: { setNetworkState?: (connected: boolean) => void };
  stop(): void;
  close(): Promise<void> | void;
  start(options?: { lifespan?: number; tickInterval?: number }): Promise<void>;
}

export interface HarnessStorage {
  getExecutionsByStatus(status: string): Promise<unknown[]>;
  getActivityTasksByStatus(status: string): Promise<unknown[]>;
  getDeadLetters(): Promise<unknown[]>;
}

export interface HarnessPlatform<TClient extends HarnessClient> {
  /**
   * Create a client over the named database. `online` is a live getter
   * the platform must wire into the engine's Environment (e.g.
   * ExpoEnvironmentOptions.getNetworkState).
   */
  createClient(dbName: string, online: () => boolean): Promise<TClient>;
  /** Delete the named database (scenario reset). */
  deleteDatabase(dbName: string): Promise<void>;
  now(): number;
}

export interface ParityContext<TClient extends HarnessClient = HarnessClient> {
  client: TClient;
  server: FakeServer;
  /** Flip simulated connectivity for BOTH the fake server and the engine environment. */
  setOnline(online: boolean): void;
  isOnline(): boolean;
  /** Simulate an app restart: close everything, recreate over the same database, re-register workflows. */
  restart(): Promise<void>;
  /**
   * Simulate a background wake: a SECOND engine instance over the same
   * database runs for lifespanMs alongside whatever else is happening.
   */
  backgroundWake(lifespanMs: number): Promise<void>;
  sleep(ms: number): Promise<void>;
  dbName: string;
}

export interface ParityScenario<TClient extends HarnessClient = HarnessClient>
  extends ScenarioDefinition<ParityContext<TClient>> {
  /** Register workflows on a (re)created client; called at start and after every restart(). */
  register(client: TClient, ctx: ParityContext<TClient>): void;
  /** Foreground engine behavior: 'run' (default) starts the tick loop; 'manual' leaves ticking to the scenario. */
  engineMode?: 'run' | 'manual';
}

class Controller implements ScenarioController {
  readonly steps: ScenarioResult['steps'] = [];
  readonly assertions: ScenarioResult['assertions'] = [];
  readonly logs: string[] = [];
  private failed = false;

  constructor(private readonly now: () => number) {}

  get hasFailed(): boolean {
    return this.failed || this.assertions.some(a => !a.passed) || this.steps.some(s => s.status === 'failed');
  }

  log(message: string): void {
    this.logs.push(`[${new Date(this.now()).toISOString()}] ${message}`);
  }

  async step(name: string, fn: () => Promise<void>): Promise<void> {
    if (this.failed) {
      this.steps.push({ name, status: 'skipped', detail: 'earlier step failed' });
      return;
    }
    try {
      await fn();
      this.steps.push({ name, status: 'passed' });
    } catch (err) {
      this.failed = true;
      this.steps.push({ name, status: 'failed', detail: String(err) });
      this.log(`STEP FAILED ${name}: ${String(err)}`);
    }
  }

  assert(name: string, passed: boolean, expected?: unknown, actual?: unknown): void {
    this.assertions.push({ name, passed, expected, actual });
    if (!passed) this.log(`ASSERT FAILED ${name} expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
  }

  assertEqual(name: string, expected: unknown, actual: unknown): void {
    this.assert(name, JSON.stringify(expected) === JSON.stringify(actual), expected, actual);
  }
}

export async function runScenario<TClient extends HarnessClient>(
  scenario: ParityScenario<TClient>,
  platform: HarnessPlatform<TClient>,
  onLog?: (line: string) => void,
  /**
   * Live-state hook for status UIs: fires with the current client +
   * fake server whenever they (re)materialize — at start and after
   * every simulated restart — and with null once the run tears down.
   */
  onLive?: (live: { client: TClient; server: FakeServer } | null) => void
): Promise<ScenarioResult> {
  const controller = new Controller(platform.now);
  const originalLog = controller.log.bind(controller);
  controller.log = (message: string) => {
    originalLog(message);
    onLog?.(message);
  };

  const dbName = `parity-${scenario.scenarioId}.db`;
  const server = new FakeServer();
  const connectivity = { online: true };
  const startedAt = new Date(platform.now()).toISOString();

  // Fresh database every run — reset IS the isolation model.
  await platform.deleteDatabase(dbName);

  let client = await platform.createClient(dbName, () => connectivity.online);
  client.environment?.setNetworkState?.(connectivity.online);
  onLive?.({ client, server });
  let foregroundLoop: Promise<void> | null = null;

  const startForeground = () => {
    if (scenario.engineMode !== 'manual') {
      foregroundLoop = client.start().catch(() => undefined);
    }
  };

  const ctx: ParityContext<TClient> = {
    get client() {
      return client;
    },
    server,
    dbName,
    setOnline(online: boolean) {
      connectivity.online = online;
      server.online = online;
      // Push into the engine environment immediately (the NetInfo-
      // listener pattern) — the polled provider alone leaves runWhen
      // gates up to a poll interval stale (P4-005).
      client.environment?.setNetworkState?.(online);
      controller.log(`connectivity → ${online ? 'ONLINE' : 'OFFLINE'}`);
    },
    isOnline: () => connectivity.online,
    async restart() {
      controller.log('simulating app restart (close + reopen over same database)');
      await client.close();
      client = await platform.createClient(dbName, () => connectivity.online);
      client.environment?.setNetworkState?.(connectivity.online);
      onLive?.({ client, server });
      scenario.register(client, ctx);
      startForeground();
    },
    async backgroundWake(lifespanMs: number) {
      controller.log(`simulating background wake (second engine, lifespan ${lifespanMs}ms)`);
      const background = await platform.createClient(dbName, () => connectivity.online);
      background.environment?.setNetworkState?.(connectivity.online);
      scenario.register(background, ctx);
      try {
        await background.start({ lifespan: lifespanMs });
      } finally {
        await background.close();
      }
    },
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  };

  try {
    scenario.register(client, ctx);
    startForeground();
    await scenario.run(ctx, controller);
  } catch (err) {
    controller.assert('scenario ran without unexpected errors', false, 'no thrown error', String(err));
  }

  // Snapshots for the result contract
  const snapshot = async () => {
    const statuses = ['running', 'completed', 'failed', 'cancelled'];
    const executions = (await Promise.all(statuses.map(s => client.storage.getExecutionsByStatus(s)))).flat();
    const taskStatuses = ['pending', 'active', 'completed', 'failed', 'skipped'];
    const tasks = (await Promise.all(taskStatuses.map(s => client.storage.getActivityTasksByStatus(s)))).flat();
    const deadLetters = await client.storage.getDeadLetters();
    return { executions, tasks, deadLetters };
  };

  let executionSnapshot: unknown;
  let taskSnapshot: unknown;
  let deadLetterSnapshot: unknown;
  try {
    const snap = await snapshot();
    executionSnapshot = snap.executions;
    taskSnapshot = snap.tasks;
    deadLetterSnapshot = snap.deadLetters;
  } catch (err) {
    controller.log(`snapshot failed: ${String(err)}`);
  }

  try {
    client.stop();
    await client.close();
  } catch (err) {
    controller.log(`teardown failed: ${String(err)}`);
  }
  onLive?.(null);
  void foregroundLoop;

  return {
    scenarioId: scenario.scenarioId,
    name: scenario.name,
    status: controller.hasFailed ? 'failed' : 'passed',
    startedAt,
    completedAt: new Date(platform.now()).toISOString(),
    steps: controller.steps,
    assertions: controller.assertions,
    executionSnapshot,
    taskSnapshot,
    deadLetterSnapshot,
    fakeServerSnapshot: server.snapshot(),
    logs: controller.logs,
  };
}
