/**
 * Shared helpers for manual-mode scenarios. One engine.tick() advances a
 * workflow exactly one stage (tick only processes tasks due at fetch
 * time), so ticking until a condition holds gives deterministic
 * crash/restart points.
 */

import { WorkflowExecution, DeadLetterRecord } from 'endura';
import { ParityContext } from '../harness/runner';
import { ParityClient } from '../harness/expoPlatform';

export async function tickUntil(
  ctx: ParityContext<ParityClient>,
  what: string,
  condition: () => Promise<boolean>,
  timeoutMs = 30000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await ctx.client.tick();
    if (await condition()) return;
    await ctx.sleep(100);
  }
  throw new Error(`timed out ticking until ${what}`);
}

export async function execOf(ctx: ParityContext<ParityClient>, runId: string): Promise<WorkflowExecution> {
  const execution = await ctx.client.getExecution(runId);
  if (!execution) throw new Error(`execution ${runId} missing`);
  return execution;
}

// ---------------------------------------------------------------------------
// App-layer recovery sweep — the endura equivalent of driver-app-3's
// recovery.ts. The engine deliberately owns crash-resume (leases) but NOT
// the business policy of which exhausted failures get re-armed; that
// policy lives here, exactly where recovery.ts lives in the driver app.
// Mirrored rules: 7-day age gate with includeStale bypass
// (MAX_RECOVERABLE_EVENT_AGE_MS), recoverable:false classification, and
// permanently-failed work excluded (needs an explicit Force Retry).
// ---------------------------------------------------------------------------

export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface RecoverySweepResult {
  redriven: DeadLetterRecord[];
  skipped: Array<{ deadLetter: DeadLetterRecord; reason: string }>;
}

export interface RecoverySweepOptions {
  now: number;
  maxAgeMs?: number;
  /** Manual recovery opting into stale work (driver-app includeStale). */
  includeStale?: boolean;
  /** Workflow names classified non-recoverable (driver-app recoverable:false). */
  nonRecoverableWorkflows?: ReadonlySet<string>;
}

export async function recoverySweep(
  engine: {
    getDeadLetters(): Promise<DeadLetterRecord[]>;
    retryFromDeadLetter(id: string): Promise<unknown>;
  },
  options: RecoverySweepOptions
): Promise<RecoverySweepResult> {
  const { now, maxAgeMs = SEVEN_DAYS_MS, includeStale = false, nonRecoverableWorkflows } = options;
  const result: RecoverySweepResult = { redriven: [], skipped: [] };

  for (const deadLetter of await engine.getDeadLetters()) {
    if (nonRecoverableWorkflows?.has(deadLetter.workflowName)) {
      result.skipped.push({ deadLetter, reason: `workflow '${deadLetter.workflowName}' is classified non-recoverable` });
      continue;
    }
    if (deadLetter.nonRetryable) {
      result.skipped.push({ deadLetter, reason: 'permanently failed (server refusal) — requires explicit Force Retry' });
      continue;
    }
    const ageMs = now - deadLetter.failedAt;
    if (ageMs > maxAgeMs && !includeStale) {
      const days = Math.round(ageMs / (24 * 60 * 60 * 1000));
      result.skipped.push({ deadLetter, reason: `stale: failed ~${days}d ago, recovery window is 7d (includeStale to override)` });
      continue;
    }
    await engine.retryFromDeadLetter(deadLetter.id);
    result.redriven.push(deadLetter);
  }
  return result;
}
