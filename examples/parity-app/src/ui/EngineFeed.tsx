/**
 * The live engine feed: scenario log lines rendered as a narrated
 * timeline. Each line gets a glyph by what happened (connectivity
 * flip, restart, background wake, failure) so a first-time viewer can
 * follow the machinery without reading raw timestamps.
 */

import { StyleSheet, Text, View } from 'react-native';
import { colors, mono, spacing } from './theme';

interface FeedLine {
  glyph: string;
  time: string;
  text: string;
  emphasis: 'normal' | 'bad' | 'good';
}

function classify(raw: string): FeedLine {
  // Lines look like "[2026-07-06T05:53:08.617Z] message".
  const match = /^\[([^\]]+)\]\s*(.*)$/.exec(raw);
  const iso = match?.[1] ?? '';
  const text = match?.[2] ?? raw;
  const time = iso.length >= 19 ? iso.slice(11, 19) : '';

  if (/ASSERT FAILED|STEP FAILED/.test(text)) return { glyph: '✗', time, text, emphasis: 'bad' };
  if (/connectivity → ONLINE/.test(text)) return { glyph: '⇡', time, text, emphasis: 'good' };
  if (/connectivity → OFFLINE/.test(text)) return { glyph: '⇣', time, text, emphasis: 'normal' };
  if (/restart/.test(text)) return { glyph: '↻', time, text, emphasis: 'normal' };
  if (/background wake/.test(text)) return { glyph: '☾', time, text, emphasis: 'normal' };
  if (/drain order|recovered|completed/.test(text)) return { glyph: '✓', time, text, emphasis: 'good' };
  return { glyph: '·', time, text, emphasis: 'normal' };
}

export function EngineFeed({ lines, maxLines = 40 }: { lines: string[]; maxLines?: number }) {
  const shown = lines.slice(-maxLines);
  return (
    <View style={styles.feed}>
      {shown.map((raw, i) => {
        const line = classify(raw);
        return (
          <View key={i} style={styles.row}>
            <Text
              style={[
                styles.glyph,
                line.emphasis === 'bad' && { color: colors.errorBright },
                line.emphasis === 'good' && { color: colors.successBright },
              ]}
            >
              {line.glyph}
            </Text>
            <Text style={styles.time}>{line.time}</Text>
            <Text style={[styles.text, line.emphasis === 'bad' && { color: colors.errorBright }]}>{line.text}</Text>
          </View>
        );
      })}
      {shown.length === 0 ? <Text style={styles.text}>waiting for the engine…</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  feed: {
    backgroundColor: colors.codeBg,
    borderRadius: 8,
    padding: spacing.sm,
    marginTop: spacing.xs,
  },
  row: { flexDirection: 'row', alignItems: 'flex-start', marginVertical: 1 },
  glyph: { width: 16, fontFamily: mono, fontSize: 11, color: colors.textMuted },
  time: { width: 62, fontFamily: mono, fontSize: 10, color: colors.textMuted, paddingTop: 1 },
  text: { flex: 1, fontFamily: mono, fontSize: 11, color: colors.codeDefault, lineHeight: 16 },
});
