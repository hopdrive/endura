/**
 * Endura showcase — a deck of use-case cards over ONE real engine.
 *
 * Swipe through the cards: each one explains a single guarantee
 * (offline survival, retries, pipelines, gating, priority, dedupe,
 * dead letters), shows the code that provides it, and runs it for
 * real — real SQLite, real HTTP, the device's real radio.
 *
 * The bar docked at the bottom is the engine inspector: tap it for a
 * native sheet with the engine's status, its registered setup, every
 * job it persists, its log, and the on-device parity test suite.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dimensions,
  NativeScrollEvent,
  NativeSyntheticEvent,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { DemoEngineSession } from './src/harness/demoEngine';
import { EngineInspection, inspectEngine } from './src/harness/engineInspection';
import { useCases } from './src/content/useCases';
import { countsForCard, UseCaseCard } from './src/ui/UseCaseCard';
import { EnginePanel, PANEL_COLLAPSED_HEIGHT } from './src/ui/EnginePanel';
import { colors, spacing, type } from './src/ui/theme';

const SCREEN_WIDTH = Dimensions.get('window').width;
const DECK_PADDING = spacing.lg;
const CARD_WIDTH = SCREEN_WIDTH - DECK_PADDING * 2;
const SNAP_INTERVAL = CARD_WIDTH + spacing.md; // card width + its right margin

export default function App() {
  const sessionRef = useRef<DemoEngineSession | null>(null);
  if (!sessionRef.current) sessionRef.current = new DemoEngineSession();
  const session = sessionRef.current;

  const [inspection, setInspection] = useState<EngineInspection | null>(null);
  const [page, setPage] = useState(0);
  const [deckHeight, setDeckHeight] = useState(0);
  const [onDuty, setOnDuty] = useState(session.isOnDuty());

  // One engine for the whole app, opened once and never reset on launch.
  useEffect(() => {
    void session.open();
  }, [session]);

  // One cheap poll drives everything live: the dock KPIs, the sheet,
  // and each card's counts.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const client = session.getClient();
        if (!client) return;
        const next = await inspectEngine(client);
        if (!cancelled) setInspection(next);
      } catch {
        // Client mid-teardown (reset) — the next tick reads consistent state.
      }
    };
    void poll();
    const interval = setInterval(() => void poll(), 1200);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [session]);

  const onDeckScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const index = Math.round(event.nativeEvent.contentOffset.x / SNAP_INTERVAL);
    setPage(Math.max(0, Math.min(useCases.length - 1, index)));
  }, []);

  const toggleDuty = useCallback(
    (value: boolean) => {
      session.setOnDuty(value);
      setOnDuty(value);
    },
    [session]
  );

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaView style={styles.container}>
        <View style={styles.content}>
          <View style={styles.header}>
            <Text style={type.largeTitle}>Endura</Text>
            <Text style={[type.subhead, styles.headerSubtitle]}>
              Durable workflows for React Native — running live on this device
            </Text>
          </View>

      <View style={styles.deck} onLayout={e => setDeckHeight(e.nativeEvent.layout.height)}>
        {deckHeight > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            snapToInterval={SNAP_INTERVAL}
            snapToAlignment="start"
            decelerationRate="fast"
            onMomentumScrollEnd={onDeckScroll}
            contentContainerStyle={styles.deckContent}
          >
            {useCases.map(useCase => (
              <View key={useCase.id} style={{ height: deckHeight }}>
                <UseCaseCard
                  useCase={useCase}
                  session={session}
                  counts={countsForCard(useCase, inspection?.jobs ?? [])}
                  width={CARD_WIDTH}
                >
                  {useCase.id === 'app-state' ? (
                    <View style={styles.dutyRow}>
                      <Text style={type.body}>On duty</Text>
                      <Switch testID="card-duty-switch" value={onDuty} onValueChange={toggleDuty} />
                    </View>
                  ) : null}
                </UseCaseCard>
              </View>
            ))}
          </ScrollView>
        ) : null}
      </View>

          <View style={styles.dots}>
            {useCases.map((useCase, i) => (
              <View key={useCase.id} style={[styles.dot, i === page && styles.dotActive]} />
            ))}
          </View>
        </View>

        <EnginePanel session={session} inspection={inspection} onDutyChanged={() => setOnDuty(session.isOnDuty())} />
      </SafeAreaView>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  container: { flex: 1, backgroundColor: colors.page },
  /** The sheet overlays absolutely — keep the deck and dots clear of it. */
  content: { flex: 1, paddingBottom: PANEL_COLLAPSED_HEIGHT },
  header: { paddingHorizontal: DECK_PADDING, paddingTop: spacing.sm, paddingBottom: spacing.md },
  headerSubtitle: { marginTop: 2 },
  deck: { flex: 1 },
  deckContent: { paddingHorizontal: DECK_PADDING },
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 7,
    paddingVertical: spacing.sm,
  },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.tertiaryLabel },
  dotActive: { width: 20, backgroundColor: colors.tint },
  dutyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.well,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginTop: spacing.md,
  },
});
