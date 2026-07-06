/**
 * endura on the web: the same core engine the React Native adapter
 * drives, running in the browser over InMemoryStorage with the Node/web
 * runtime defaults (RealClock, RealScheduler, StubEnvironment).
 *
 * Demonstrates:
 * - typed step-to-step chaining with chain()
 * - reactive hooks driven by Storage.subscribe (no polling)
 * - retries with jittered backoff, NonRetryableError, and DLQ redrive
 */

import { useEffect, useMemo, useState } from 'react';
import {
  WorkflowEngine,
  RealClock,
  RealScheduler,
  StubEnvironment,
  defineActivity,
  defineWorkflow,
  chain,
  NonRetryableError,
} from 'endura';
import { InMemoryStorage } from 'endura/storage/memory';
import {
  useEngineRunner,
  useExecution,
  useExecutionStats,
  useDeadLetters,
  useWorkflowStarter,
} from 'endura/react';

// --- Workflow definitions -------------------------------------------------

const fetchQuote = defineActivity<{ topic: string }, { quote: string }>({
  name: 'fetch-quote',
  execute: async ctx => {
    await new Promise(resolve => setTimeout(resolve, 400));
    return { quote: `“Persistence beats ${ctx.input.topic}.”` };
  },
});

const decorate = defineActivity<{ quote: string }, { decorated: string }>({
  name: 'decorate',
  execute: async ctx => ({ decorated: `✨ ${ctx.input.quote} ✨` }),
});

// chain() type-checks that each step's input is satisfied by the
// workflow input plus all prior outputs.
const quoteWorkflow = defineWorkflow<{ topic: string }>({
  name: 'quote',
  activities: chain<{ topic: string }>().step(fetchQuote).step(decorate).activities,
});

let flakyAttempts = 0;
const flakyWorkflow = defineWorkflow({
  name: 'flaky',
  activities: [
    defineActivity({
      name: 'flaky-step',
      retry: { maximumAttempts: 3, initialInterval: 500 },
      execute: async () => {
        flakyAttempts += 1;
        if (flakyAttempts % 3 !== 0) throw new Error(`transient failure #${flakyAttempts}`);
        return { succeededOnAttempt: flakyAttempts };
      },
    }),
  ],
});

const doomedWorkflow = defineWorkflow({
  name: 'doomed',
  activities: [
    defineActivity({
      name: 'doomed-step',
      retry: { maximumAttempts: 5 },
      execute: async (): Promise<Record<string, unknown>> => {
        // Classified as permanent: dead-letters on the FIRST failure
        // despite the 5-attempt budget.
        throw new NonRetryableError('validation failed — retrying cannot help');
      },
    }),
  ],
});

// --- UI --------------------------------------------------------------------

export function App() {
  const [engine, setEngine] = useState<WorkflowEngine | null>(null);

  useEffect(() => {
    let cancelled = false;
    void WorkflowEngine.create({
      storage: new InMemoryStorage(),
      clock: new RealClock(),
      scheduler: new RealScheduler(),
      environment: new StubEnvironment(),
    }).then(created => {
      if (cancelled) return;
      created.registerWorkflow(quoteWorkflow);
      created.registerWorkflow(flakyWorkflow);
      created.registerWorkflow(doomedWorkflow);
      setEngine(created);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!engine) return <p>starting engine…</p>;
  return <Dashboard engine={engine} />;
}

function Dashboard({ engine }: { engine: WorkflowEngine }) {
  useEngineRunner(engine, true, 100);

  const stats = useExecutionStats(engine);
  const deadLetters = useDeadLetters(engine, true);
  const { startWorkflow, execution: started } = useWorkflowStarter<{ topic: string }>(engine);
  const live = useExecution(engine, started?.runId);
  const [message, setMessage] = useState('');

  const styles = useMemo(
    () => ({
      page: { fontFamily: 'system-ui, sans-serif', maxWidth: 640, margin: '2rem auto', lineHeight: 1.5 },
      row: { display: 'flex', gap: 8, flexWrap: 'wrap' as const, margin: '1rem 0' },
      card: { border: '1px solid #ccc', borderRadius: 8, padding: '0.75rem 1rem', margin: '0.5rem 0' },
    }),
    []
  );

  return (
    <main style={styles.page}>
      <h1>endura web example</h1>
      <p>
        running · {stats.running} — completed · {stats.completed} — failed · {stats.failed} — dead letters ·{' '}
        {deadLetters.length}
      </p>

      <div style={styles.row}>
        <button onClick={() => void startWorkflow(quoteWorkflow, { input: { topic: 'entropy' } })}>
          Start typed chain
        </button>
        <button onClick={() => void engine.start(flakyWorkflow, { input: {} })}>
          Start flaky (retries + jitter)
        </button>
        <button onClick={() => void engine.start(doomedWorkflow, { input: {} })}>
          Start doomed (NonRetryableError)
        </button>
        <button
          disabled={deadLetters.length === 0}
          onClick={() => {
            const target = deadLetters.find(d => !d.nonRetryable);
            setMessage(target ? `redriving ${target.id}` : 'only non-retryable dead letters — redrive refused');
            if (target) void engine.retryFromDeadLetter(target.id);
          }}
        >
          Redrive first retryable dead letter
        </button>
      </div>

      {live && (
        <div style={styles.card}>
          <strong>{live.workflowName}</strong> — {live.status}
          <pre>{JSON.stringify(live.state, null, 2)}</pre>
        </div>
      )}

      {deadLetters.map(letter => (
        <div key={letter.id} style={styles.card}>
          ☠️ <strong>{letter.workflowName}</strong> / {letter.activityName} — {letter.error}
          {letter.nonRetryable ? ' (non-retryable)' : ''}
        </div>
      ))}

      {message && <p>{message}</p>}
    </main>
  );
}
