/**
 * Design tokens for the showcase app — Apple HIG-aligned, light mode.
 *
 * The app is a product demo, not a developer console: system grouped
 * backgrounds, white cards with soft elevation, one tint color used
 * sparingly, generous padding, and the standard iOS type scale.
 * Monospace appears ONLY inside code samples and JSON wells.
 */

import { Platform } from 'react-native';

export const colors = {
  // Surfaces (iOS system grouped)
  page: '#F2F2F7',
  card: '#FFFFFF',
  /** Inset well inside a card (code, JSON, log). */
  well: '#F6F6F8',
  separator: 'rgba(60,60,67,0.12)',
  /** Gray control fill (iOS tertiarySystemFill). */
  fill: '#E9E9EB',

  // Text
  label: '#111114',
  secondaryLabel: 'rgba(60,60,67,0.62)',
  tertiaryLabel: 'rgba(60,60,67,0.34)',

  // Tints (iOS system palette)
  tint: '#007AFF',
  green: '#34C759',
  red: '#FF3B30',
  orange: '#FF9500',
  teal: '#30B0C7',
  indigo: '#5856D6',
  gray: '#8E8E93',

  // Soft backgrounds for pills / icon chips (tint at ~10%)
  tintSoft: '#EAF2FF',
  greenSoft: '#E9F9EE',
  redSoft: '#FFEBEA',
  orangeSoft: '#FFF3E2',
  tealSoft: '#E8F6F9',
  indigoSoft: '#EEEEFB',
  graySoft: '#F0F0F3',

  // Code syntax (Xcode light theme family)
  codeKeyword: '#9B2393',
  codeString: '#C41A16',
  codeComment: '#707F8C',
  codeDefault: '#1F2328',
} as const;

export const spacing = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
  xxxl: 40,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  full: 9999,
} as const;

export const mono = Platform.select({ ios: 'Menlo', default: 'monospace' }) as string;

/** Soft, modern card elevation — visible but never heavy. */
export const cardShadow = {
  shadowColor: '#000000',
  shadowOpacity: 0.07,
  shadowRadius: 16,
  shadowOffset: { width: 0, height: 6 },
  elevation: 3,
} as const;

/** iOS type scale (system font). */
export const type = {
  largeTitle: { fontSize: 34, fontWeight: '700' as const, color: colors.label, letterSpacing: 0.2 },
  title1: { fontSize: 28, fontWeight: '700' as const, color: colors.label },
  title2: { fontSize: 22, fontWeight: '700' as const, color: colors.label },
  title3: { fontSize: 20, fontWeight: '600' as const, color: colors.label },
  headline: { fontSize: 17, fontWeight: '600' as const, color: colors.label },
  body: { fontSize: 17, fontWeight: '400' as const, color: colors.label, lineHeight: 24 },
  bodySecondary: { fontSize: 17, fontWeight: '400' as const, color: colors.secondaryLabel, lineHeight: 24 },
  subhead: { fontSize: 15, fontWeight: '400' as const, color: colors.secondaryLabel, lineHeight: 21 },
  subheadStrong: { fontSize: 15, fontWeight: '600' as const, color: colors.label, lineHeight: 21 },
  footnote: { fontSize: 13, fontWeight: '400' as const, color: colors.secondaryLabel, lineHeight: 18 },
  caption: { fontSize: 12, fontWeight: '400' as const, color: colors.secondaryLabel, lineHeight: 16 },
  /** Uppercase grouped-list section header. */
  sectionHeader: {
    fontSize: 13,
    fontWeight: '400' as const,
    color: colors.secondaryLabel,
    textTransform: 'uppercase' as const,
    letterSpacing: 0.4,
  },
  code: { fontSize: 13, fontFamily: mono, color: colors.codeDefault, lineHeight: 19 },
  button: { fontSize: 17, fontWeight: '600' as const },
  buttonSmall: { fontSize: 15, fontWeight: '600' as const },
};
