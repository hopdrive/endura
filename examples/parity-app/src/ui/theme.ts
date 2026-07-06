/**
 * Design tokens for the showcase app — the HopDrive design system's
 * dark-mode surfaces and palette (@hopdrive/design-system/tokens),
 * adapted for React Native (system fonts stand in for Inter; Menlo /
 * monospace stands in for JetBrains Mono).
 *
 * Brand rules honored here: #ff4830 is ACCENT ONLY (primary CTA +
 * status jewelry, never backgrounds); dark panels + elevated cards
 * create hierarchy through elevation, not borders; color is never the
 * only state indicator (pills always carry text).
 */

import { Platform } from 'react-native';

export const colors = {
  // Surfaces (dark mode)
  page: '#0e1015',
  card: '#1a1d26',
  cardElevated: '#22252f',
  codeBg: '#10131a',
  hairline: '#2a2f3e',

  // Text on dark
  textPrimary: '#f2f2f3',
  textSecondary: '#abb0b5',
  textMuted: '#788088',

  // Brand
  primaryAccent: '#ff4830',
  secondaryAccent: '#4068a0',
  secondaryAccentBright: '#72a2db',
  tertiaryAccent: '#40a0b0',
  tertiaryAccentBright: '#72ccd8',

  // Semantic
  success: '#20b020',
  successBright: '#4fd06a',
  error: '#f02020',
  errorBright: '#ff6048',
  warning: '#f4b020',
  info: '#20a0e0',

  // Code syntax (derived from palette families for AA contrast on codeBg)
  codeKeyword: '#a1c1e7',
  codeString: '#7fd88f',
  codeComment: '#60666d',
  codeDefault: '#d0d5e0',
  codeAccent: '#ffb8ad',
};

export const spacing = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  full: 9999,
} as const;

export const mono = Platform.select({ ios: 'Menlo', default: 'monospace' }) as string;

/** elevation.level2 from the token set, expressed for RN. */
export const cardShadow = {
  shadowColor: '#000000',
  shadowOpacity: 0.35,
  shadowRadius: 12,
  shadowOffset: { width: 0, height: 4 },
  elevation: 4,
} as const;

export const type = {
  h1: { fontSize: 26, fontWeight: '700' as const, color: colors.textPrimary },
  h2: { fontSize: 20, fontWeight: '700' as const, color: colors.textPrimary },
  h3: { fontSize: 16, fontWeight: '600' as const, color: colors.textPrimary },
  body: { fontSize: 14, fontWeight: '400' as const, color: colors.textSecondary, lineHeight: 21 },
  bodyStrong: { fontSize: 14, fontWeight: '600' as const, color: colors.textPrimary, lineHeight: 21 },
  caption: { fontSize: 12, fontWeight: '500' as const, color: colors.textMuted },
  overline: {
    fontSize: 11,
    fontWeight: '600' as const,
    color: colors.textMuted,
    letterSpacing: 1.2,
    textTransform: 'uppercase' as const,
  },
  code: { fontSize: 12, fontFamily: mono, color: colors.codeDefault, lineHeight: 18 },
  button: { fontSize: 13, fontWeight: '600' as const, color: colors.textPrimary },
};
