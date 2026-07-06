/**
 * Shared helpers for manual-mode scenarios. One engine.tick() advances a
 * workflow exactly one stage (tick only processes tasks due at fetch
 * time), so ticking until a condition holds gives deterministic
 * crash/restart points.
 */

import { WorkflowExecution } from 'endura';
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
