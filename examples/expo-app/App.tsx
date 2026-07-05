/**
 * Endura on-device smoke test.
 *
 * Exercises the review's missing test #13 on real Hermes + expo-sqlite:
 * - 3-step workflow completes end-to-end (C1: transactions return values,
 *   C6: IDs mint on Hermes)
 * - kill the app mid-workflow, relaunch, workflow resumes and completes
 *   with no completed step re-run (C2/C3/C5: atomic advance, leases,
 *   crash recovery without burning attempts)
 * - failing workflow dead-letters (DLQ)
 * - uniqueKey dedup returns the existing run
 *
 * All observable state is rendered as plain text lines so Maestro can
 * assert on it.
 */

import { useEffect, useRef, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { openDatabaseAsync } from 'expo-sqlite';
import { defineActivity, Workflow, ActivityContext } from 'endura';
import { SQLiteStorage, ExpoSqliteDriver } from 'endura/storage/sqlite';
import { ExpoWorkflowClient } from 'endura/environmental/expo';

const STEP_MS = 2500;
const LEASE_MS = 10000;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    });
  });
}

interface Harness {
  client: ExpoWorkflowClient;
  storage: SQLiteStorage;
  driver: ExpoSqliteDriver;
}

async function createHarness(): Promise<Harness> {
  const driver = await ExpoSqliteDriver.create('endura-smoke.db', openDatabaseAsync);
  const storage = new SQLiteStorage(driver);
  await storage.initialize();

  // Side table for duplicate detection: every step execution appends a
  // row. Steps completed before an app kill must show exactly one row.
  await driver.execute(
    `CREATE TABLE IF NOT EXISTS step_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      step TEXT NOT NULL,
      at INTEGER NOT NULL
    );`
  );

  const client = await ExpoWorkflowClient.create({ storage, leaseDurationMs: LEASE_MS });

  const logStep = async (runId: string, step: string) => {
    await driver.execute(`INSERT INTO step_log (run_id, step, at) VALUES (?, ?, ?)`, [
      runId,
      step,
      Date.now(),
    ]);
  };

  const threeStep: Workflow = {
    name: 'threeStep',
    activities: ['step1', 'step2', 'step3'].map(step =>
      defineActivity({
        name: step,
        startToCloseTimeout: 30000,
        retry: { maximumAttempts: 3 },
        execute: async (ctx: ActivityContext) => {
          await delay(STEP_MS, ctx.signal);
          await logStep(ctx.runId, step);
          return { [step]: true };
        },
      })
    ),
  };

  const failing: Workflow = {
    name: 'failing',
    activities: [
      defineActivity({
        name: 'alwaysFails',
        retry: { maximumAttempts: 2, initialInterval: 500 },
        execute: async (): Promise<Record<string, unknown>> => {
          throw new Error('intentional failure');
        },
      }),
    ],
  };

  const keyed: Workflow = {
    name: 'keyed',
    activities: [
      defineActivity({
        name: 'quick',
        retry: { maximumAttempts: 3 },
        execute: async (ctx: ActivityContext) => {
          await delay(4000, ctx.signal);
          return { keyed: true };
        },
      }),
    ],
  };

  client.registerWorkflow(threeStep);
  client.registerWorkflow(failing);
  client.registerWorkflow(keyed);

  // Continuous foreground engine loop; intentionally not awaited.
  void client.start();

  return { client, storage, driver };
}

export default function App() {
  const harnessRef = useRef<Harness | null>(null);
  const startedRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [keyedResult, setKeyedResult] = useState<string>('');

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    createHarness()
      .then(harness => {
        harnessRef.current = harness;
        setReady(true);
      })
      .catch(err => {
        setInitError(String(err));
      });
  }, []);

  // Poll storage into text lines Maestro can assert on.
  useEffect(() => {
    if (!ready) return;
    const interval = setInterval(() => {
      void (async () => {
        const harness = harnessRef.current;
        if (!harness) return;
        try {
          const { storage, driver } = harness;
          const executions = (
            await Promise.all([
              storage.getExecutionsByStatus('running'),
              storage.getExecutionsByStatus('completed'),
              storage.getExecutionsByStatus('failed'),
            ])
          ).flat();

          const counts = (await driver.query(
            `SELECT run_id, step, COUNT(*) AS n FROM step_log GROUP BY run_id, step`
          )) as Array<{ run_id: string; step: string; n: number }>;

          const next = executions
            .sort((a, b) => a.createdAt - b.createdAt)
            .map(e => {
              const byStep = (step: string) =>
                counts.find(c => c.run_id === e.runId && c.step === step)?.n ?? 0;
              const stepInfo =
                e.workflowName === 'threeStep'
                  ? ` s1:${byStep('step1')} s2:${byStep('step2')} s3:${byStep('step3')}`
                  : '';
              return `${e.workflowName} ${e.runId.slice(0, 6)} ${e.status.toUpperCase()} cur:${e.currentActivityName}${stepInfo}`;
            });

          const deadLetters = await storage.getDeadLetters();
          next.push(`DLQ:${deadLetters.length}`);
          setLines(next);
        } catch (err) {
          setLines([`POLL ERROR: ${String(err)}`]);
        }
      })();
    }, 600);
    return () => clearInterval(interval);
  }, [ready]);

  const startThreeStep = () => {
    const harness = harnessRef.current;
    if (!harness) return;
    const workflow = harness.client.engine.getWorkflow('threeStep')!;
    void harness.client.engine.start(workflow, { input: { startedAt: Date.now() } });
  };

  const startFailing = () => {
    const harness = harnessRef.current;
    if (!harness) return;
    const workflow = harness.client.engine.getWorkflow('failing')!;
    void harness.client.engine.start(workflow, { input: {} });
  };

  const startKeyed = () => {
    const harness = harnessRef.current;
    if (!harness) return;
    const workflow = harness.client.engine.getWorkflow('keyed')!;
    void (async () => {
      try {
        const first = await harness.client.engine.start(workflow, {
          input: {},
          uniqueKey: 'K1',
          onConflict: 'ignore',
        });
        const second = await harness.client.engine.start(workflow, {
          input: {},
          uniqueKey: 'K1',
          onConflict: 'ignore',
        });
        setKeyedResult(first.runId === second.runId ? 'KEYED:SAME-RUN' : 'KEYED:DUPLICATE-RUN!');
      } catch (err) {
        setKeyedResult(`KEYED ERROR: ${String(err)}`);
      }
    })();
  };

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>Endura Smoke Test</Text>
      <Text style={styles.status} testID="engine-status">
        {initError ? `INIT ERROR: ${initError}` : ready ? 'ENGINE READY' : 'starting…'}
      </Text>

      <View style={styles.buttons}>
        <Pressable testID="start-three-step" style={styles.button} onPress={startThreeStep}>
          <Text style={styles.buttonText}>START 3-STEP</Text>
        </Pressable>
        <Pressable testID="start-failing" style={styles.button} onPress={startFailing}>
          <Text style={styles.buttonText}>START FAILING</Text>
        </Pressable>
        <Pressable testID="start-keyed" style={styles.button} onPress={startKeyed}>
          <Text style={styles.buttonText}>START KEYED</Text>
        </Pressable>
      </View>

      {keyedResult ? <Text style={styles.line}>{keyedResult}</Text> : null}

      <ScrollView style={styles.list} testID="execution-list">
        {lines.map((line, i) => (
          <Text key={i} style={styles.line}>
            {line}
          </Text>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b1020', paddingTop: 8 },
  title: { color: '#fff', fontSize: 20, fontWeight: '700', textAlign: 'center', marginTop: 8 },
  status: { color: '#7fd67f', fontSize: 14, textAlign: 'center', marginVertical: 8 },
  buttons: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 8 },
  button: { backgroundColor: '#2c4bff', paddingHorizontal: 10, paddingVertical: 10, borderRadius: 8 },
  buttonText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  list: { flex: 1, paddingHorizontal: 12 },
  line: { color: '#e8e8f0', fontFamily: 'Menlo', fontSize: 11, marginVertical: 2 },
});
