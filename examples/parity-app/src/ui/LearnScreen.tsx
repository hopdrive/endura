/**
 * Learn tab: what Endura is, why this app is trustworthy evidence, how
 * to use it, and the tap-through concept glossary. Every concept links
 * to the scenario where you can watch it happen on this device.
 */

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { concepts } from '../content/concepts';
import { CodeBlock } from './CodeBlock';
import { Btn, Card, Overline } from './primitives';
import { colors, radius, spacing, type } from './theme';

export function LearnScreen({
  focusConceptId,
  onSeeItLive,
  onConceptLayout,
}: {
  focusConceptId: string | null;
  onSeeItLive: (scenarioId: string) => void;
  onConceptLayout?: (key: string, y: number) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(focusConceptId);
  // A new jump-in from a scenario chip overrides local state once.
  const [lastFocus, setLastFocus] = useState(focusConceptId);
  if (focusConceptId !== lastFocus) {
    setLastFocus(focusConceptId);
    setExpanded(focusConceptId);
  }

  return (
    <View>
      <Card>
        <Overline>Why Endura exists</Overline>
        <Text style={type.h2}>Work that must survive the real world</Text>
        <Text style={[type.body, styles.para]}>
          A driver parks in a concrete garage, the app gets killed by iOS, the update ships mid-shift — and the
          photo still has to upload, the status still has to sync, and neither may ever happen twice. Endura is
          a durable workflow engine for React Native: multi-step pipelines persisted in SQLite, resumed after
          crashes, held while offline, retried with backoff, and parked for a human when the server says no.
        </Text>
        <Text style={[type.body, styles.para]}>
          It replaces the pattern of a background queue plus hand-rolled pipeline state — the architecture the
          HopDrive driver app has run in production for years — with one engine that makes those behaviors a
          declared contract instead of tribal knowledge.
        </Text>
      </Card>

      <Card>
        <Overline>Why you can trust this app</Overline>
        <Text style={type.h3}>Nothing here is mocked where it matters</Text>
        <Text style={[type.body, styles.para]}>
          Every scenario runs the real engine against a real SQLite database file on the device in your hand.
          “Crash” means the client is destroyed and rebuilt over the same file. “Offline” flows through the
          same environment API your app would wire to NetInfo. And no scenario ever asserts “the workflow
          completed” — they assert on a business-effect ledger: one photo uploaded, one outcome submitted,
          zero duplicates. If Endura cheated, the ledger would say so.
        </Text>
        <Text style={[type.body, styles.para]}>
          Skeptical? Good. Pick the failure mode you would use to break a queue — kill it mid-pipeline, race a
          background wake, let a hung request land late — and run that scenario. Then reset it and run it
          again.
        </Text>
      </Card>

      <Card>
        <Overline>How to use this app</Overline>
        <Step n="1" text="LAB: read a scenario card's question — each one is a way durable queues break in production. Tap RUN and watch the automated, deterministic proof." />
        <Step n="2" text="Open a card's CODE view to see exactly what you would write to get that behavior — usually a few lines." />
        <Step n="3" text="PLAYGROUND: drive a simulated engine by hand — inject failures, toggle connectivity, force retries." />
        <Step n="4" text="FIELD TEST (on a real phone): nothing simulated. Add jobs, flip airplane mode, background it, force-quit it — then watch real deliveries flow to the real internet, in order, when you come back." />
      </Card>

      <Overline>Concepts — tap to expand</Overline>
      {concepts.map(concept => {
        const open = expanded === concept.id;
        return (
          <View
            key={concept.id}
            onLayout={e => onConceptLayout?.(`concept:${concept.id}`, e.nativeEvent.layout.y)}
          >
          <Card style={open ? styles.openCard : undefined}>
            <Pressable
              testID={`concept-${concept.id}`}
              onPress={() => setExpanded(open ? null : concept.id)}
              style={styles.conceptHeader}
            >
              <View style={styles.conceptTitleBlock}>
                <Text style={type.h3}>{concept.title}</Text>
                <Text style={[type.caption, styles.tagline]}>{concept.tagline}</Text>
              </View>
              <Text style={styles.disclosure}>{open ? '−' : '+'}</Text>
            </Pressable>
            {open ? (
              <View>
                <Text style={[type.body, styles.para]}>{concept.body}</Text>
                <CodeBlock code={concept.code} />
                {concept.seeItLive ? (
                  <Btn
                    tone="ghost"
                    label={`See it live → ${concept.seeItLive.label}`}
                    onPress={() => onSeeItLive(concept.seeItLive!.scenarioId)}
                  />
                ) : null}
              </View>
            ) : null}
          </Card>
          </View>
        );
      })}
    </View>
  );
}

function Step({ n, text }: { n: string; text: string }) {
  return (
    <View style={styles.step}>
      <View style={styles.stepBadge}>
        <Text style={styles.stepBadgeText}>{n}</Text>
      </View>
      <Text style={[type.body, styles.stepText]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  para: { marginTop: spacing.xs },
  openCard: { backgroundColor: colors.cardElevated },
  conceptHeader: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  conceptTitleBlock: { flex: 1 },
  tagline: { marginTop: 2 },
  disclosure: { color: colors.textMuted, fontSize: 22, paddingHorizontal: spacing.xs },
  step: { flexDirection: 'row', alignItems: 'flex-start', marginTop: spacing.sm },
  stepBadge: {
    width: 22,
    height: 22,
    borderRadius: radius.full,
    backgroundColor: colors.secondaryAccent,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
    marginTop: 1,
  },
  stepBadgeText: { color: colors.textPrimary, fontSize: 12, fontWeight: '700' },
  stepText: { flex: 1 },
});
