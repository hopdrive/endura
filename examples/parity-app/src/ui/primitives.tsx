/**
 * Shared UI primitives, iOS-flavored: white cards with soft elevation,
 * 50pt filled/gray/plain buttons, a segmented control, soft-tinted
 * pills, and inset grouped list rows. 44pt minimum touch targets;
 * state is always carried by text, never color alone.
 */

import { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { cardShadow, colors, radius, spacing, type } from './theme';

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

type ButtonVariant = 'filled' | 'gray' | 'tinted' | 'destructive' | 'plain';

export function Button({
  label,
  onPress,
  variant = 'gray',
  small,
  testID,
  disabled,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  small?: boolean;
  testID?: string;
  disabled?: boolean;
  style?: ViewStyle;
}) {
  const textColor =
    variant === 'filled'
      ? '#FFFFFF'
      : variant === 'destructive'
        ? colors.red
        : colors.tint;
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        variant === 'filled' && styles.buttonFilled,
        variant === 'gray' && styles.buttonGray,
        variant === 'tinted' && styles.buttonTinted,
        variant === 'destructive' && styles.buttonDestructive,
        variant === 'plain' && styles.buttonPlain,
        (pressed || disabled) && styles.buttonPressed,
        style,
      ]}
    >
      <Text style={[small ? type.buttonSmall : type.button, { color: textColor }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Soft-tinted status pill: colored text on a matching soft background. */
export function Pill({ label, color, softColor }: { label: string; color: string; softColor: string }) {
  return (
    <View style={[styles.pill, { backgroundColor: softColor }]}>
      <Text style={[styles.pillText, { color }]} numberOfLines={1}>
        {label}
      </Text>
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
          <Text style={[styles.tabText, active === tab.key && styles.tabTextActive]} numberOfLines={1}>
            {tab.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/** Uppercase grouped-list section header, iOS-style. */
export function SectionHeader({ children }: { children: ReactNode }) {
  return <Text style={styles.sectionHeader}>{children}</Text>;
}

/**
 * Inset grouped list row. Parent wraps a run of rows in <Card> (or a
 * plain white group) and separators appear between rows automatically
 * via `first`.
 */
export function ListRow({
  title,
  subtitle,
  value,
  right,
  onPress,
  first,
  testID,
}: {
  title: string;
  subtitle?: string;
  value?: string;
  right?: ReactNode;
  onPress?: () => void;
  first?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [styles.row, !first && styles.rowSeparated, pressed && onPress && styles.rowPressed]}
    >
      <View style={styles.rowMain}>
        <Text style={type.body} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[type.footnote, styles.rowSubtitle]} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text style={styles.rowValue} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
      {right}
      {onPress ? <Text style={styles.chevron}>›</Text> : null}
    </Pressable>
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
  button: {
    minHeight: 50,
    minWidth: 44,
    paddingHorizontal: spacing.lg,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radius.md,
  },
  buttonSmall: { minHeight: 38, paddingHorizontal: spacing.md, borderRadius: 10 },
  buttonFilled: { backgroundColor: colors.tint },
  buttonGray: { backgroundColor: colors.fill },
  buttonTinted: { backgroundColor: colors.tintSoft },
  buttonDestructive: { backgroundColor: colors.redSoft },
  buttonPlain: { backgroundColor: 'transparent', paddingHorizontal: spacing.xs },
  buttonPressed: { opacity: 0.55 },
  pill: {
    borderRadius: radius.full,
    paddingHorizontal: 10,
    paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  pillText: { fontSize: 13, fontWeight: '600' },
  tabs: {
    flexDirection: 'row',
    backgroundColor: colors.fill,
    borderRadius: 9,
    padding: 2,
  },
  tab: {
    flex: 1,
    minHeight: 32,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 7,
  },
  tabActive: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#000000',
    shadowOpacity: 0.08,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  tabText: { fontSize: 13, fontWeight: '500', color: colors.secondaryLabel },
  tabTextActive: { color: colors.label, fontWeight: '600' },
  sectionHeader: {
    ...type.sectionHeader,
    marginTop: spacing.lg,
    marginBottom: spacing.xs,
    marginLeft: spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 46,
    paddingVertical: spacing.xs,
    gap: spacing.xs,
  },
  rowSeparated: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator },
  rowPressed: { opacity: 0.55 },
  rowMain: { flex: 1 },
  rowSubtitle: { marginTop: 2 },
  rowValue: { ...type.body, color: colors.secondaryLabel, flexShrink: 1 },
  chevron: { fontSize: 20, color: colors.tertiaryLabel, marginLeft: 2 },
});
