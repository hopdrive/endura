/**
 * The engine instrument panel — the showcase element of the app. A
 * fixed-height strip pinned to the bottom of every tab that makes
 * Endura's silent background work loudly visible: what engine is
 * live, real connectivity, four KPI counters (queued / running /
 * dead-lettered / delivered), and a ticker narrating the engine's
 * last action.
 *
 * Geometry is deliberately constant: fixed bar height, fixed rows,
 * one line of text each, flex-locked KPI cells — values and colors
 * change, the layout never does.
 */

import { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, mono, spacing } from './theme';

export interface EngineStatus {
  source: 'scenario' | 'playground' | 'field';
  /** Scenario name, 'field test', or 'playground'. */
  label: string;
  online: boolean;
  runningExecutions: number;
  pendingTasks: number;
  activeTasks: number;
  deadLetters: number;
  effects: number;
  /** Raw last engine log line ("level message {json}"), newest. */
  lastEvent: string | null;
}

/** Strip the log level prefix and trailing JSON context for the ticker. */
function tickerText(rawLine: string): string {
  return rawLine
    .replace(/^(debug|info|warn|error)\s+/, '')
    .replace(/\s*\{.*$/, '')
    .trim();
}

const SOURCE_STYLE = {
  scenario: { color: colors.info, label: 'SCENARIO RUNNING' },
  field: { color: colors.successBright, label: 'FIELD TEST LIVE' },
  playground: { color: colors.tertiaryAccentBright, label: 'PLAYGROUND LIVE' },
} as const;

export function EngineStatusBar({ status, onPress }: { status: EngineStatus | null; onPress?: () => void }) {
  const pulse = useRef(new Animated.Value(1)).current;
  const lastEvent = status?.lastEvent ?? null;

  useEffect(() => {
    if (lastEvent === null) return;
    pulse.setValue(0.15);
    Animated.timing(pulse, { toValue: 1, duration: 500, useNativeDriver: true }).start();
  }, [lastEvent, pulse]);

  const source = status ? SOURCE_STYLE[status.source] : { color: colors.textMuted, label: 'ENGINE IDLE' };
  const queued = (status?.pendingTasks ?? 0) + (status?.activeTasks ?? 0);
  const deadLetters = status?.deadLetters ?? 0;

  return (
    <Pressable onPress={onPress} disabled={!status} testID="engine-status-bar">
      <View style={styles.bar}>
        <View style={styles.headerRow}>
          <View style={styles.stateBlock}>
            <Animated.Text style={[styles.dot, { color: source.color, opacity: status ? pulse : 1 }]}>
              ●
            </Animated.Text>
            <Text style={[styles.stateText, { color: source.color }]} numberOfLines={1}>
              {source.label}
            </Text>
          </View>
          <Text
            style={[
              styles.onlineText,
              { color: status ? (status.online ? colors.successBright : colors.warning) : colors.textMuted },
            ]}
            numberOfLines={1}
          >
            {status ? (status.online ? '⇡ ONLINE' : '⇣ OFFLINE') : '—'}
          </Text>
        </View>

        <View style={styles.kpiRow}>
          <Kpi value={queued} label="QUEUED" active={queued > 0} />
          <Kpi value={status?.runningExecutions ?? 0} label="RUNNING" active={(status?.runningExecutions ?? 0) > 0} />
          <Kpi
            value={deadLetters}
            label="DEAD"
            active={deadLetters > 0}
            valueColor={deadLetters > 0 ? colors.warning : undefined}
          />
          <Kpi
            value={status?.effects ?? 0}
            label="DELIVERED"
            active={(status?.effects ?? 0) > 0}
            valueColor={(status?.effects ?? 0) > 0 ? colors.successBright : undefined}
          />
        </View>

        <Text style={styles.ticker} numberOfLines={1}>
          {status
            ? status.lastEvent
              ? tickerText(status.lastEvent)
              : `engine up — ${status.label}`
            : 'run a lab scenario, start a field test, or open the playground'}
        </Text>
      </View>
    </Pressable>
  );
}

function Kpi({
  value,
  label,
  active,
  valueColor,
}: {
  value: number;
  label: string;
  active: boolean;
  valueColor?: string;
}) {
  return (
    <View style={styles.kpiCell}>
      <Text
        style={[styles.kpiValue, { color: valueColor ?? (active ? colors.textPrimary : colors.textMuted) }]}
        numberOfLines={1}
      >
        {value}
      </Text>
      <Text style={styles.kpiLabel} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: 104,
    backgroundColor: colors.cardElevated,
    borderTopWidth: 1,
    borderTopColor: colors.hairline,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
  },
  headerRow: {
    height: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  stateBlock: { flexDirection: 'row', alignItems: 'center' },
  dot: { fontSize: 12, marginRight: 8 },
  stateText: { fontSize: 13, fontWeight: '800', letterSpacing: 1 },
  onlineText: { fontFamily: mono, fontSize: 13, fontWeight: '700' },
  kpiRow: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
  },
  kpiCell: { flex: 1, alignItems: 'center' },
  kpiValue: { fontSize: 24, fontWeight: '800', lineHeight: 28 },
  kpiLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 1.2, color: colors.textMuted, marginTop: 0 },
  ticker: { fontFamily: mono, fontSize: 12, color: colors.textSecondary, marginTop: 4 },
});
