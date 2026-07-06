/**
 * Endura showcase app (Phase 4 parity harness, presented as a guided
 * tour). Three tabs:
 *
 *   LEARN      — what Endura is, why this evidence is trustworthy, and
 *                a concept glossary with code, cross-linked to scenarios.
 *   SCENARIOS  — the 15 parity scenarios as teaching cards: the
 *                skeptic's question, a live engine feed while running,
 *                results with the business-effect ledger, and the code
 *                + file structure to build the same thing for real.
 *   PLAYGROUND — a live engine driven by hand, with viewers over
 *                everything it persists and failure-injection controls.
 *
 * Every scenario runs against real endura SQLite persistence in its
 * own database file; reset deletes the file. JSON export via Share.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, SafeAreaView, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { ScenarioResult } from './src/harness/types';
import { runScenario, ParityScenario } from './src/harness/runner';
import { FakeServer } from './src/harness/fakeServer';
import { expoPlatform, ParityClient } from './src/harness/expoPlatform';
import { InspectorSession } from './src/harness/inspector';
import { FieldTestSession } from './src/harness/fieldSession';
import { InspectorPanel } from './src/InspectorPanel';
import { FieldTestScreen } from './src/ui/FieldTestScreen';
import { scenarios } from './src/scenarios';
import { guides } from './src/content/guides';
import { LearnScreen } from './src/ui/LearnScreen';
import { ScenarioCard } from './src/ui/ScenarioCard';
import { EnginePanel, EngineStatus, ConnectivityControl } from './src/ui/EnginePanel';
import { Btn, SegmentedTabs, PillState } from './src/ui/primitives';
import { colors, spacing, type } from './src/ui/theme';

type MainTab = 'learn' | 'scenarios' | 'field' | 'playground';

export default function App() {
  const [tab, setTab] = useState<MainTab>('learn');
  const [results, setResults] = useState<Record<string, ScenarioResult>>({});
  const [runStates, setRunStates] = useState<Record<string, PillState>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [focusConcept, setFocusConcept] = useState<string | null>(null);
  const [liveLog, setLiveLog] = useState<string[]>([]);
  const [runAllProgress, setRunAllProgress] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const inspectorRef = useRef<InspectorSession | null>(null);
  if (!inspectorRef.current) inspectorRef.current = new InspectorSession();
  const fieldRef = useRef<FieldTestSession | null>(null);
  if (!fieldRef.current) fieldRef.current = new FieldTestSession();

  // --- Engine status bar: live handles + a cheap poll -----------------------
  const liveRef = useRef<{ client: ParityClient; server: FakeServer } | null>(null);
  const [liveScenario, setLiveScenario] = useState<{ id: string; name: string } | null>(null);
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const live = liveRef.current;
        if (liveScenario && live) {
          const { client, server } = live;
          const [running, pending, active, deadLetters] = await Promise.all([
            client.storage.getExecutionsByStatus('running'),
            client.storage.getActivityTasksByStatus('pending'),
            client.storage.getActivityTasksByStatus('active'),
            client.storage.getDeadLetters(),
          ]);
          const lastLine = client.parityLogs[client.parityLogs.length - 1];
          if (!cancelled) {
            setEngineStatus({
              source: 'scenario',
              label: liveScenario.name,
              online: server.online,
              runningExecutions: running.length,
              pendingTasks: pending.length,
              activeTasks: active.length,
              deadLetters: deadLetters.length,
              effects: server.getEffects().length,
              lastEvent: lastLine ?? null,
            });
          }
          return;
        }
        // Tab-aware priority: on the Playground tab its engine wins (so
        // its GO OFFLINE toggle is reflected here); everywhere else the
        // always-on field engine shows when it exists.
        if (tab === 'playground' && inspectorRef.current?.isOpen()) {
          const stats = await inspectorRef.current.stats();
          if (!cancelled) setEngineStatus({ source: 'playground', label: 'playground', ...stats });
          return;
        }
        if (fieldRef.current?.isOpen()) {
          const stats = await fieldRef.current.stats();
          if (!cancelled) setEngineStatus({ source: 'field', label: 'field test', ...stats });
          return;
        }
        if (!cancelled) setEngineStatus(null);
      } catch {
        // A client mid-teardown or a closed database is a normal race
        // for a poller; the next tick will read consistent state.
      }
    };
    void poll();
    const interval = setInterval(() => void poll(), 700);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [tab, liveScenario]);

  /** y-offsets of scenario cards / concept cards inside the scroll content. */
  const offsetsRef = useRef<Record<string, number>>({});
  const registerOffset = useCallback((key: string, y: number) => {
    offsetsRef.current[key] = y;
  }, []);
  const scrollToKey = useCallback((key: string) => {
    // Wait a frame so the target tab's content has laid out.
    setTimeout(() => {
      const y = offsetsRef.current[key];
      scrollRef.current?.scrollTo({ y: y === undefined ? 0 : Math.max(0, y - 8), animated: true });
    }, 80);
  }, []);

  const switchTab = useCallback((next: MainTab) => {
    setTab(prev => {
      if (prev === 'playground' && next !== 'playground') void inspectorRef.current?.close();
      return next;
    });
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, []);

  const run = useCallback(async (scenario: ParityScenario<ParityClient>) => {
    setRunStates(prev => ({ ...prev, [scenario.scenarioId]: 'running' }));
    setExpanded(scenario.scenarioId);
    setLiveLog([]);
    setLiveScenario({ id: scenario.scenarioId, name: scenario.name });
    const result = await runScenario(
      scenario,
      expoPlatform,
      line => setLiveLog(prev => [...prev.slice(-30), line]),
      live => {
        liveRef.current = live;
      }
    );
    setLiveScenario(null);
    setResults(prev => ({ ...prev, [scenario.scenarioId]: result }));
    setRunStates(prev => ({ ...prev, [scenario.scenarioId]: result.status }));
  }, []);

  const runAll = useCallback(async () => {
    let index = 0;
    for (const scenario of scenarios) {
      index += 1;
      setRunAllProgress(`Running ${index} of ${scenarios.length}: ${scenario.name}`);
      // Serial on purpose: scenarios own their databases but share the device.
      // eslint-disable-next-line no-await-in-loop
      await run(scenario);
    }
    setRunAllProgress(null);
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

  const jumpToScenario = useCallback(
    (scenarioId: string) => {
      setExpanded(scenarioId);
      switchTab('scenarios');
      scrollToKey(`scenario:${scenarioId}`);
    },
    [switchTab, scrollToKey]
  );

  const jumpToConcept = useCallback(
    (conceptId: string) => {
      setFocusConcept(conceptId);
      switchTab('learn');
      scrollToKey(`concept:${conceptId}`);
    },
    [switchTab, scrollToKey]
  );

  const passed = Object.values(runStates).filter(s => s === 'passed').length;

  /** The live engine's client, for the manager panel's deep inspection. */
  const getPanelClient = useCallback((): ParityClient | null => {
    if (liveScenario && liveRef.current) return liveRef.current.client;
    if (tab === 'playground' && inspectorRef.current?.isOpen()) return inspectorRef.current.getClient();
    if (fieldRef.current?.isOpen()) return fieldRef.current.getClient();
    return null;
  }, [liveScenario, tab]);

  /** Connectivity toggle for the panel, per source. */
  const panelConnectivity: ConnectivityControl | undefined = (() => {
    if (!engineStatus) return undefined;
    if (engineStatus.source === 'playground') {
      const inspector = inspectorRef.current!;
      return {
        toggleLabel: engineStatus.online ? 'GO OFFLINE' : 'GO ONLINE',
        onToggle: () => inspector.setOnline(!inspector.isOnline()),
        note: 'simulated connectivity — this engine only',
      };
    }
    if (engineStatus.source === 'field') {
      const field = fieldRef.current!;
      return {
        toggleLabel: field.isForcedOffline() ? 'RESUME ONLINE' : 'FORCE OFFLINE',
        onToggle: () => field.toggleForceOffline(),
        note: `radio: ${field.isRadioOnline() ? 'online' : 'offline'}${field.isForcedOffline() ? ' · software override: FORCED OFFLINE' : ''} — or use real airplane mode`,
      };
    }
    return undefined; // scenario: the harness scripts connectivity
  })();

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.masthead}>
        <View style={styles.mastheadText}>
          <Text style={styles.brand}>ENDURA</Text>
          <Text style={type.caption}>Durable workflows for React Native — live on this device</Text>
        </View>
        {passed > 0 ? (
          <View style={styles.scoreChip}>
            <Text style={styles.scoreText}>
              {passed}/{scenarios.length} proven
            </Text>
          </View>
        ) : null}
      </View>

      <View style={styles.tabsWrap}>
        <SegmentedTabs<MainTab>
          tabs={[
            { key: 'learn', label: 'Learn' },
            { key: 'scenarios', label: 'Lab' },
            { key: 'field', label: 'Field Test' },
            { key: 'playground', label: 'Playground' },
          ]}
          active={tab}
          onChange={switchTab}
          testIDPrefix="tab"
        />
      </View>

      <ScrollView ref={scrollRef} style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {tab === 'learn' ? (
          <LearnScreen focusConceptId={focusConcept} onSeeItLive={jumpToScenario} onConceptLayout={registerOffset} />
        ) : null}

        {tab === 'scenarios' ? (
          <View>
            <View style={styles.toolbar}>
              <Btn testID="run-all" label="RUN ALL 15" tone="primary" onPress={() => void runAll()} />
              <Btn testID="export-report" label="EXPORT JSON" tone="secondary" onPress={() => void exportReport()} />
            </View>
            {runAllProgress ? <Text style={styles.progress}>{runAllProgress}</Text> : null}
            <Text style={[type.body, styles.lede]}>
              This is the lab: each card is one way durable queues break in production, reproduced as a
              deterministic, automated simulation — crashes, connectivity, and the server are all scripted so
              every claim is repeatable. Tap a card for the story, the live result, and the code you’d write.
              For the un-simulated version on real hardware, open FIELD TEST.
            </Text>
            {scenarios.map(scenario => (
              <View
                key={scenario.scenarioId}
                onLayout={e => registerOffset(`scenario:${scenario.scenarioId}`, e.nativeEvent.layout.y)}
              >
              <ScenarioCard
                scenarioId={scenario.scenarioId}
                category={scenario.category}
                name={scenario.name}
                guide={guides[scenario.scenarioId]}
                state={runStates[scenario.scenarioId] ?? 'idle'}
                result={results[scenario.scenarioId]}
                liveLog={liveLog}
                expanded={expanded === scenario.scenarioId}
                onToggle={() => setExpanded(prev => (prev === scenario.scenarioId ? null : scenario.scenarioId))}
                onRun={() => void run(scenario)}
                onReset={() => void reset(scenario)}
                onConceptPress={jumpToConcept}
              />
              </View>
            ))}
            <Pressable onPress={() => switchTab('playground')} style={styles.footerLink}>
              <Text style={styles.footerLinkText}>
                Want to break it yourself? Open the Playground and drive the engine by hand →
              </Text>
            </Pressable>
          </View>
        ) : null}

        {tab === 'field' ? <FieldTestScreen session={fieldRef.current} /> : null}

        {tab === 'playground' ? <InspectorPanel session={inspectorRef.current} /> : null}
      </ScrollView>

      <EnginePanel
        status={engineStatus}
        getClient={getPanelClient}
        connectivity={panelConnectivity}
        onJumpToSource={() => {
          if (engineStatus?.source === 'scenario' && liveScenario) jumpToScenario(liveScenario.id);
          else if (engineStatus?.source === 'field') switchTab('field');
          else if (engineStatus?.source === 'playground') switchTab('playground');
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.page },
  masthead: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  mastheadText: { flex: 1 },
  brand: { fontSize: 22, fontWeight: '800', letterSpacing: 3, color: colors.textPrimary },
  scoreChip: {
    backgroundColor: '#1f752f',
    borderRadius: 9999,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxs,
  },
  scoreText: { color: '#eafbea', fontSize: 12, fontWeight: '700' },
  tabsWrap: { paddingHorizontal: spacing.md, paddingBottom: spacing.xs },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: spacing.md, paddingBottom: spacing.xxl },
  toolbar: { flexDirection: 'row', gap: spacing.xs, marginTop: spacing.xs },
  progress: { ...type.caption, color: colors.secondaryAccentBright, marginTop: spacing.xs },
  lede: { marginVertical: spacing.sm },
  footerLink: { paddingVertical: spacing.lg, minHeight: 44, justifyContent: 'center' },
  footerLinkText: { ...type.body, color: colors.secondaryAccentBright },
});
