/**
 * Phase 4 scenario contracts — from the production-readiness review's
 * "Scenario Result Contract" section. A scenario passes only when all
 * assertions pass; reaching 'completed' is not enough if ordering,
 * dedupe, recovery, idempotency, or inspection expectations were
 * violated.
 */

export type ScenarioResult = {
  scenarioId: string;
  name: string;
  status: 'passed' | 'failed';
  startedAt: string;
  completedAt?: string;
  steps: Array<{
    name: string;
    status: 'passed' | 'failed' | 'skipped';
    detail?: string;
  }>;
  assertions: Array<{
    name: string;
    passed: boolean;
    expected?: unknown;
    actual?: unknown;
  }>;
  executionSnapshot?: unknown;
  taskSnapshot?: unknown;
  deadLetterSnapshot?: unknown;
  fakeServerSnapshot?: unknown;
  logs: string[];
};

/**
 * What a scenario's run() receives. The runner owns the lifecycle:
 * fresh per-scenario database on reset, engine/client construction,
 * restart and background-wake simulation, connectivity control, and
 * the fake server.
 */
export interface ScenarioController {
  /** Log a line into the scenario result. */
  log(message: string): void;
  /** Run a named step; a thrown error fails the step (and scenario) but later steps still report as skipped. */
  step(name: string, fn: () => Promise<void>): Promise<void>;
  /** Record an assertion. */
  assert(name: string, passed: boolean, expected?: unknown, actual?: unknown): void;
  /** Convenience deep-equal assertion. */
  assertEqual(name: string, expected: unknown, actual: unknown): void;
}

export interface ScenarioDefinition<TCtx> {
  scenarioId: string;
  name: string;
  /** Which review scenario category this implements (1-14). */
  category: number;
  run(ctx: TCtx, t: ScenarioController): Promise<void>;
}
