/**
 * Monospace code display with a deliberately tiny syntax highlighter
 * (keywords / strings / comments — enough to make samples readable
 * without a highlighting dependency), plus a file-tree renderer for
 * "where this code lives" structures.
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

/**
 * File tree: lines like "src/workflows/photoUpload.ts  <- the pipeline".
 * Paths render in mono, annotations (after two+ spaces) in muted text.
 */
export function FileTree({ tree }: { tree: string }) {
  const lines = tree.replace(/\n+$/, '').split('\n');
  return (
    <View style={styles.block}>
      {lines.map((line, i) => {
        const match = /^(\s*\S+)(\s{2,})(.*)$/.exec(line);
        return (
          <Text key={i} style={type.code}>
            {match ? (
              <>
                <Text style={{ color: colors.tertiaryAccentBright }}>{match[1]}</Text>
                <Text>{match[2]}</Text>
                <Text style={{ color: colors.codeComment }}>{match[3]}</Text>
              </>
            ) : (
              <Text style={{ color: colors.tertiaryAccentBright }}>{line}</Text>
            )}
          </Text>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    backgroundColor: colors.codeBg,
    borderRadius: radius.md,
    padding: spacing.sm,
    marginVertical: spacing.xs,
  },
  title: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: spacing.xs,
  },
});
