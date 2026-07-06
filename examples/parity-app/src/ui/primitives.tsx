/**
 * Shared UI primitives for the showcase app: cards, buttons, chips,
 * status pills, and segmented tabs. Elevation over borders; 44pt touch
 * targets; state always carried by text, never color alone.
 */

import { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { cardShadow, colors, radius, spacing, type } from './theme';

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Overline({ children }: { children: ReactNode }) {
  return <Text style={[type.overline, styles.overline]}>{children}</Text>;
}

type ButtonTone = 'primary' | 'secondary' | 'ghost';

export function Btn({
  label,
  onPress,
  tone = 'secondary',
  testID,
  disabled,
}: {
  label: string;
  onPress: () => void;
  tone?: ButtonTone;
  testID?: string;
  disabled?: boolean;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.btn,
        tone === 'primary' && styles.btnPrimary,
        tone === 'secondary' && styles.btnSecondary,
        tone === 'ghost' && styles.btnGhost,
        (pressed || disabled) && styles.btnPressed,
      ]}
    >
      <Text style={[type.button, tone === 'ghost' && { color: colors.secondaryAccentBright }]}>{label}</Text>
    </Pressable>
  );
}

export function Chip({ label, active, onPress }: { label: string; active?: boolean; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

export type PillState = 'idle' | 'running' | 'passed' | 'failed';

const PILL: Record<PillState, { label: string; bg: string; fg: string }> = {
  idle: { label: 'NOT RUN', bg: '#2a2f3e', fg: colors.textSecondary },
  running: { label: 'RUNNING…', bg: '#1f3354', fg: '#a1c1e7' },
  passed: { label: 'PASS', bg: '#1f752f', fg: '#eafbea' },
  failed: { label: 'FAIL', bg: '#a6152a', fg: '#ffe8ec' },
};

export function StatusPill({ state }: { state: PillState }) {
  const pill = PILL[state];
  return (
    <View style={[styles.pill, { backgroundColor: pill.bg }]}>
      <Text style={[styles.pillText, { color: pill.fg }]}>{pill.label}</Text>
    </View>
  );
}

export function SegmentedTabs<T extends string>({
  tabs,
  active,
  onChange,
  testIDPrefix,
}: {
  tabs: Array<{ key: T; label: string }>;
  active: T;
  onChange: (key: T) => void;
  testIDPrefix?: string;
}) {
  return (
    <View style={styles.tabs}>
      {tabs.map(tab => (
        <Pressable
          key={tab.key}
          testID={testIDPrefix ? `${testIDPrefix}-${tab.key}` : undefined}
          onPress={() => onChange(tab.key)}
          style={[styles.tab, active === tab.key && styles.tabActive]}
        >
          <Text style={[styles.tabText, active === tab.key && styles.tabTextActive]}>{tab.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginVertical: spacing.xs,
    ...cardShadow,
  },
  overline: { marginBottom: spacing.xxs },
  btn: {
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radius.md,
  },
  btnPrimary: { backgroundColor: colors.primaryAccent },
  btnSecondary: { backgroundColor: colors.secondaryAccent },
  btnGhost: { backgroundColor: 'transparent' },
  btnPressed: { opacity: 0.6 },
  chip: {
    backgroundColor: '#2a2f3e',
    borderRadius: radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxs,
    marginRight: spacing.xs,
    marginBottom: spacing.xs,
  },
  chipActive: { backgroundColor: colors.secondaryAccent },
  chipText: { fontSize: 12, fontWeight: '500', color: colors.textSecondary },
  chipTextActive: { color: colors.textPrimary },
  pill: {
    borderRadius: radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xxs,
    alignSelf: 'flex-start',
  },
  pillText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  tabs: {
    flexDirection: 'row',
    backgroundColor: colors.codeBg,
    borderRadius: radius.md,
    padding: spacing.xxs,
  },
  tab: {
    flex: 1,
    minHeight: 40,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radius.sm,
  },
  tabActive: { backgroundColor: colors.cardElevated },
  tabText: { fontSize: 13, fontWeight: '500', color: colors.textMuted },
  tabTextActive: { color: colors.textPrimary, fontWeight: '600' },
});
