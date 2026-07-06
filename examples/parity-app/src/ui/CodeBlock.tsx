/**
 * Code display with a deliberately tiny syntax highlighter (keywords /
 * strings / comments — enough to make samples readable without a
 * highlighting dependency). Light well styling to match the app's
 * iOS design language.
 */

import { ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing, type } from './theme';

const KEYWORDS = new Set([
  'import',
  'from',
  'export',
  'const',
  'let',
  'return',
  'await',
  'async',
  'function',
  'new',
  'if',
  'else',
  'true',
  'false',
  'throw',
  'for',
  'of',
  'default',
]);

/** Tokenize one line into colored spans: comment > string > keyword. */
function renderLine(line: string, key: number): ReactNode {
  const commentAt = line.indexOf('//');
  const code = commentAt >= 0 ? line.slice(0, commentAt) : line;
  const comment = commentAt >= 0 ? line.slice(commentAt) : null;

  const spans: ReactNode[] = [];
  // Split on string literals first so keywords inside strings stay plain.
  const parts = code.split(/('[^']*'|`[^`]*`)/g);
  parts.forEach((part, i) => {
    if (part.startsWith("'") || part.startsWith('`')) {
      spans.push(
        <Text key={i} style={{ color: colors.codeString }}>
          {part}
        </Text>
      );
      return;
    }
    const words = part.split(/(\w+)/g);
    spans.push(
      <Text key={i}>
        {words.map((word, j) =>
          KEYWORDS.has(word) ? (
            <Text key={j} style={{ color: colors.codeKeyword }}>
              {word}
            </Text>
          ) : (
            word
          )
        )}
      </Text>
    );
  });

  return (
    <Text key={key} style={type.code}>
      {spans}
      {comment ? <Text style={{ color: colors.codeComment }}>{comment}</Text> : null}
    </Text>
  );
}

export function CodeBlock({ code, title }: { code: string; title?: string }) {
  const lines = code.replace(/\n+$/, '').split('\n');
  return (
    <View style={styles.block}>
      {title ? <Text style={styles.title}>{title}</Text> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>{lines.map((line, i) => renderLine(line, i))}</View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    backgroundColor: colors.well,
    borderRadius: radius.md,
    padding: spacing.sm,
    marginVertical: spacing.xs,
  },
  title: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.secondaryLabel,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    marginBottom: spacing.xs,
  },
});
