/**
 * Endura Phase 4 parity harness (review §Phase 4).
 *
 * Scenario list → run/reset → structured results (steps, assertions,
 * snapshots, fake-server effects, logs) with JSON export via Share.
 * Every scenario runs against real endura SQLite persistence in its own
 * database file; reset deletes the file.
 */

import { useCallback, useRef, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { ScenarioResult } from './src/harness/types';
import { runScenario, ParityScenario } from './src/harness/runner';
import { expoPlatform, ParityClient } from './src/harness/expoPlatform';
import { InspectorSession } from './src/harness/inspector';
import { InspectorPanel } from './src/InspectorPanel';
import { scenarios } from './src/scenarios';

type RunState = 'idle' | 'running' | 'passed' | 'failed';

export default function App() {
  const [results, setResults] = useState<Record<string, ScenarioResult>>({});
  const [runStates, setRunStates] = useState<Record<string, RunState>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [liveLog, setLiveLog] = useState<string[]>([]);
  const [inspecting, setInspecting] = useState(false);
  const inspectorRef = useRef<InspectorSession | null>(null);
  if (!inspectorRef.current) inspectorRef.current = new InspectorSession();

  const toggleInspector = useCallback(() => {
    setInspecting(prev => {
      if (prev) void inspectorRef.current?.close();
      return !prev;
    });
  }, []);

  const run = useCallback(async (scenario: ParityScenario<ParityClient>) => {
    setRunStates(prev => ({ ...prev, [scenario.scenarioId]: 'running' }));
    setSelected(scenario.scenarioId);
    setLiveLog([]);
    const result = await runScenario(scenario, expoPlatform, line =>
      setLiveLog(prev => [...prev.slice(-30), line])
    );
    setResults(prev => ({ ...prev, [scenario.scenarioId]: result }));
    setRunStates(prev => ({ ...prev, [scenario.scenarioId]: result.status }));
  }, []);

  const runAll = useCallback(async () => {
    for (const scenario of scenarios) {
      // Serial on purpose: scenarios own their databases but share the device.
      // eslint-disable-next-line no-await-in-loop
      await run(scenario);
    }
  }, [run]);

  const reset = useCallback(async (scenario: ParityScenario<ParityClient>) => {
    await expoPlatform.deleteDatabase(`parity-${scenario.scenarioId}.db`);
    setResults(prev => {
      const next = { ...prev };
      delete next[scenario.scenarioId];
      return next;
    });
    setRunStates(prev => ({ ...prev, [scenario.scenarioId]: 'idle' }));
  }, []);

  const exportReport = useCallback(async () => {
    const report = {
      generatedAt: new Date().toISOString(),
      results: Object.values(results),
    };
    await Share.share({ message: JSON.stringify(report, null, 2) });
  }, [results]);

  const selectedResult = selected ? results[selected] : undefined;

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>Endura Parity Harness</Text>
      <View style={styles.toolbar}>
        <Pressable testID="run-all" style={styles.button} onPress={() => void runAll()}>
          <Text style={styles.buttonText}>RUN ALL</Text>
        </Pressable>
        <Pressable testID="export-report" style={styles.button} onPress={() => void exportReport()}>
          <Text style={styles.buttonText}>EXPORT JSON</Text>
        </Pressable>
        <Pressable testID="toggle-inspector" style={styles.button} onPress={toggleInspector}>
          <Text style={styles.buttonText}>{inspecting ? 'SCENARIOS' : 'INSPECTOR'}</Text>
        </Pressable>
      </View>

      {inspecting ? (
        <ScrollView style={styles.list}>
          <InspectorPanel session={inspectorRef.current} />
        </ScrollView>
      ) : (
      <ScrollView style={styles.list}>
        {scenarios.map(scenario => {
          const state = runStates[scenario.scenarioId] ?? 'idle';
          return (
            <View key={scenario.scenarioId} style={styles.row}>
              <Pressable style={styles.rowMain} onPress={() => setSelected(scenario.scenarioId)}>
                <Text style={styles.line}>
                  {stateGlyph(state)} [{scenario.category}] {scenario.name}
                </Text>
              </Pressable>
              <Pressable
                testID={`run-${scenario.scenarioId}`}
                style={styles.smallButton}
                onPress={() => void run(scenario)}
              >
                <Text style={styles.buttonText}>RUN</Text>
              </Pressable>
              <Pressable
                testID={`reset-${scenario.scenarioId}`}
                style={styles.smallButton}
                onPress={() => void reset(scenario)}
              >
                <Text style={styles.buttonText}>RESET</Text>
              </Pressable>
            </View>
          );
        })}

        {selected && !selectedResult && runStates[selected] === 'running' ? (
          <View style={styles.detail}>
            <Text style={styles.detailTitle}>running {selected}…</Text>
            {liveLog.map((line, i) => (
              <Text key={i} style={styles.log}>
                {line}
              </Text>
            ))}
          </View>
        ) : null}

        {selectedResult ? <ResultDetail result={selectedResult} /> : null}
      </ScrollView>
      )}
    </SafeAreaView>
  );
}

function ResultDetail({ result }: { result: ScenarioResult }) {
  const effects =
    (result.fakeServerSnapshot as { effects?: Array<{ kind: string; key: string; late?: boolean }> } | undefined)
      ?.effects ?? [];
  return (
    <View style={styles.detail} testID="result-detail">
      <Text style={styles.detailTitle}>
        {result.status === 'passed' ? 'PASSED' : 'FAILED'} — {result.name}
      </Text>
      {result.steps.map((step, i) => (
        <Text key={`s${i}`} style={styles.line}>
          {step.status === 'passed' ? '✓' : step.status === 'failed' ? '✗' : '⊘'} step: {step.name}
          {step.detail ? ` — ${step.detail}` : ''}
        </Text>
      ))}
      {result.assertions.map((assertion, i) => (
        <Text key={`a${i}`} style={styles.line}>
          {assertion.passed ? '✓' : '✗'} assert: {assertion.name}
        </Text>
      ))}
      <Text style={styles.detailTitle}>business effects ({effects.length})</Text>
      {effects.map((effect, i) => (
        <Text key={`e${i}`} style={styles.line}>
          {effect.kind}:{effect.key}
          {effect.late ? ' (late)' : ''}
        </Text>
      ))}
      <Text style={styles.detailTitle}>log</Text>
      {result.logs.slice(-40).map((line, i) => (
        <Text key={`l${i}`} style={styles.log}>
          {line}
        </Text>
      ))}
    </View>
  );
}

function stateGlyph(state: RunState): string {
  switch (state) {
    case 'running':
      return '…';
    case 'passed':
      return '✅';
    case 'failed':
      return '❌';
    default:
      return '·';
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0b1020', paddingTop: 8 },
  title: { color: '#fff', fontSize: 18, fontWeight: '700', textAlign: 'center', marginVertical: 8 },
  toolbar: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 8 },
  button: { backgroundColor: '#2c4bff', paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8 },
  smallButton: {
    backgroundColor: '#2c4bff',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
    marginLeft: 6,
  },
  buttonText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  list: { flex: 1, paddingHorizontal: 12 },
  row: { flexDirection: 'row', alignItems: 'center', marginVertical: 4 },
  rowMain: { flex: 1 },
  line: { color: '#e8e8f0', fontFamily: 'Menlo', fontSize: 11, marginVertical: 1 },
  log: { color: '#9aa0b4', fontFamily: 'Menlo', fontSize: 10, marginVertical: 1 },
  detail: { borderTopWidth: 1, borderTopColor: '#2a3050', marginTop: 12, paddingTop: 8 },
  detailTitle: { color: '#ffd479', fontFamily: 'Menlo', fontSize: 12, marginVertical: 4 },
});
