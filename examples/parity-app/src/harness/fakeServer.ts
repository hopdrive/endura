/**
 * Fake server / side-effect recorder — from the review's "Required Fake
 * Server" section.
 *
 * Records LOGICAL BUSINESS EFFECTS (one uploaded photo, one submitted
 * outcome, one processed offer bundle), not just function calls. The
 * parity suite's central proof is that endura's at-least-once execution
 * never becomes duplicate business behavior — asserted here as
 * effect-count-by-key, never as "the workflow completed".
 *
 * Behavior modes (scriptable per endpoint, consumed in FIFO order):
 * - success                  resolve, record effect
 * - transient-failure        reject with a retryable error, no effect
 * - permanent-refusal        reject with a NonRetryableError-shaped error
 *                            (server refused the write: row filter,
 *                            reassigned/deleted move), no effect
 * - slow                     resolve after delayMs, record effect
 * - hung                     never settles until release() is called
 * - late-success             resolve after delayMs (intended to be past
 *                            the activity timeout), effect recorded LATE
 * - late-failure             reject after delayMs, no effect
 * - offline                  reject with a network-unavailable error, no
 *                            effect (also automatic while online=false)
 *
 * Duplicate idempotency key: a call carrying an idempotencyKey already
 * seen for that endpoint returns the recorded prior result WITHOUT a
 * second business effect — how a real server guard absorbs at-least-once
 * delivery.
 */

export type FakeBehaviorKind =
  | 'success'
  | 'transient-failure'
  | 'permanent-refusal'
  | 'slow'
  | 'hung'
  | 'late-success'
  | 'late-failure'
  | 'offline';

export interface FakeBehavior {
  kind: FakeBehaviorKind;
  /** For slow / late-success / late-failure. */
  delayMs?: number;
}

export interface BusinessEffect {
  /** Logical effect, e.g. 'photo-uploaded', 'outcome-submitted'. */
  kind: string;
  /** Domain key, e.g. the photoId / moveId / offerId. */
  key: string;
  at: number;
  endpoint: string;
  late?: boolean;
  details?: Record<string, unknown>;
}

export interface FakeCall {
  endpoint: string;
  /** Business effect recorded if the mutation logically succeeds. */
  effect: { kind: string; key: string; details?: Record<string, unknown> };
  idempotencyKey?: string;
  at: number;
  outcome: 'success' | 'rejected-transient' | 'rejected-permanent' | 'rejected-offline' | 'pending' | 'duplicate-absorbed';
}

export class PermanentRefusalError extends Error {
  readonly nonRetryable = true;
  constructor(message: string) {
    super(message);
    this.name = 'PermanentRefusalError';
  }
}

export class NetworkUnavailableError extends Error {
  constructor(message = 'network unavailable') {
    super(message);
    this.name = 'NetworkUnavailableError';
  }
}

interface PendingHang {
  resolve: () => void;
  reject: (err: Error) => void;
}

export class FakeServer {
  /** Connectivity switch — false makes every call reject offline. */
  online = true;

  private scripts = new Map<string, FakeBehavior[]>();
  private effects: BusinessEffect[] = [];
  private calls: FakeCall[] = [];
  private idempotency = new Map<string, unknown>();
  private hangs: PendingHang[] = [];

  /** Queue behaviors for an endpoint; consumed FIFO, default 'success' after the queue drains. */
  script(endpoint: string, ...behaviors: (FakeBehaviorKind | FakeBehavior)[]): void {
    const queue = this.scripts.get(endpoint) ?? [];
    for (const b of behaviors) queue.push(typeof b === 'string' ? { kind: b } : b);
    this.scripts.set(endpoint, queue);
  }

  /** Release every hung call as a success (records effects late). */
  releaseHung(): void {
    for (const hang of this.hangs) hang.resolve();
    this.hangs = [];
  }

  /** Release every hung call as a failure. */
  failHung(message = 'hung call failed'): void {
    for (const hang of this.hangs) hang.reject(new Error(message));
    this.hangs = [];
  }

  async call(request: {
    endpoint: string;
    effect: { kind: string; key: string; details?: Record<string, unknown> };
    idempotencyKey?: string;
    payload?: unknown;
  }): Promise<{ ok: true; duplicate?: boolean }> {
    const record = (outcome: FakeCall['outcome']) =>
      this.calls.push({
        endpoint: request.endpoint,
        effect: request.effect,
        idempotencyKey: request.idempotencyKey,
        at: Date.now(),
        outcome,
      });

    if (!this.online) {
      record('rejected-offline');
      throw new NetworkUnavailableError();
    }

    // Server-side idempotency guard: duplicate key → prior result, no new effect.
    if (request.idempotencyKey !== undefined) {
      const idemKey = `${request.endpoint}::${request.idempotencyKey}`;
      if (this.idempotency.has(idemKey)) {
        record('duplicate-absorbed');
        return { ok: true, duplicate: true };
      }
    }

    const behavior = this.scripts.get(request.endpoint)?.shift() ?? { kind: 'success' as const };

    const succeed = (late: boolean) => {
      this.effects.push({
        kind: request.effect.kind,
        key: request.effect.key,
        at: Date.now(),
        endpoint: request.endpoint,
        late: late || undefined,
        details: request.effect.details,
      });
      if (request.idempotencyKey !== undefined) {
        this.idempotency.set(`${request.endpoint}::${request.idempotencyKey}`, { ok: true });
      }
    };

    switch (behavior.kind) {
      case 'success':
        record('success');
        succeed(false);
        return { ok: true };
      case 'transient-failure':
        record('rejected-transient');
        throw new Error(`transient failure from ${request.endpoint}`);
      case 'permanent-refusal':
        record('rejected-permanent');
        throw new PermanentRefusalError(`server refused write to ${request.endpoint}`);
      case 'offline':
        record('rejected-offline');
        throw new NetworkUnavailableError();
      case 'slow':
        await sleep(behavior.delayMs ?? 1000);
        record('success');
        succeed(false);
        return { ok: true };
      case 'hung': {
        record('pending');
        await new Promise<void>((resolve, reject) => this.hangs.push({ resolve, reject }));
        succeed(true);
        return { ok: true };
      }
      case 'late-success':
        await sleep(behavior.delayMs ?? 5000);
        record('success');
        succeed(true);
        return { ok: true };
      case 'late-failure':
        await sleep(behavior.delayMs ?? 5000);
        record('rejected-transient');
        throw new Error(`late failure from ${request.endpoint}`);
    }
  }

  // --- Inspection ----------------------------------------------------------

  getEffects(): readonly BusinessEffect[] {
    return this.effects;
  }

  getCalls(): readonly FakeCall[] {
    return this.calls;
  }

  /** Count of logical effects for a (kind, key) — the duplicate-business-effect assertion. */
  effectCount(kind: string, key: string): number {
    return this.effects.filter(e => e.kind === kind && e.key === key).length;
  }

  snapshot(): { effects: BusinessEffect[]; calls: FakeCall[] } {
    return { effects: [...this.effects], calls: [...this.calls] };
  }

  reset(): void {
    this.scripts.clear();
    this.effects = [];
    this.calls = [];
    this.idempotency.clear();
    this.failHung('reset');
    this.online = true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
