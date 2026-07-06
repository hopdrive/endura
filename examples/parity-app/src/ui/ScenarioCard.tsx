/**
 * One scenario as a teaching card. Collapsed: the number, the name,
 * the skeptic's question it answers, and its run state. Expanded:
 * three views — STORY (what it proves and the production behavior it
 * mirrors), RESULT (live engine feed while running; steps, assertions
 * and the business-effect ledger after), and CODE (what you would
 * write in a real app, plus where the files live).
 */

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ScenarioResult } from '../harness/types';
import { ScenarioGuide } from '../content/guides';
import { concepts } from '../content/concepts';
import { CodeBlock, FileTree } from './CodeBlock';
import { EngineFeed } from './EngineFeed';
import { Btn, Card, Chip, Overline, SegmentedTabs, StatusPill, PillState } from './primitives';
import { colors, mono, radius, spacing, type } from './theme';

type DetailTab = 'story' | 'result' | 'code';

export interface ScenarioCardProps {
  scenarioId: string;
  category: number;
  name: string;
  guide?: ScenarioGuide;
  state: PillState;
  result?: ScenarioResult;
  liveLog: string[];
  expanded: boolean;
  onToggle: () => void;
  onRun: () => void;
  onReset: () => void;
  onConceptPress: (conceptId: string) => void;
}

export function ScenarioCard(props: ScenarioCardProps) {
  const [tab, setTab] = useState<DetailTab>('story');
  // Auto-jump to the live RESULT view the moment a run starts.
  const [lastState, setLastState] = useState(props.state);
  if (props.state !== lastState) {
    setLastState(props.state);
    if (props.state === 'running') setTab('result');
  }

  return (
    <Card style={props.expanded ? styles.openCard : undefined}>
      <Pressable onPress={props.onToggle} style={styles.header} testID={`card-${props.scenarioId}`}>
        <View style={styles.number}>
          <Text style={styles.numberText}>{props.category}</Text>
        </View>
        <View style={styles.titleBlock}>
          <Text style={type.h3}>{props.name}</Text>
          {props.guide ? <Text style={[styles.question]}>“{props.guide.question}”</Text> : null}
        </View>
        <StatusPill state={props.state} />
      </Pressable>

      <View style={styles.actions}>
        <Btn testID={`run-${props.scenarioId}`} label={props.state === 'running' ? 'RUNNING…' : 'RUN'} tone="secondary" onPress={props.onRun} disabled={props.state === 'running'} />
        <Btn testID={`reset-${props.scenarioId}`} label="RESET" tone="ghost" onPress={props.onReset} />
        <View style={styles.actionsSpacer} />
        <Btn label={props.expanded ? 'CLOSE' : 'EXPLORE'} tone="ghost" onPress={props.onToggle} />
      </View>

      {props.expanded ? (
        <View style={styles.detail}>
          <SegmentedTabs<DetailTab>
            tabs={[
              { key: 'story', label: 'Story' },
              { key: 'result', label: 'Result' },
              { key: 'code', label: 'Code' },
            ]}
            active={tab}
            onChange={setTab}
          />
          {tab === 'story' ? <StoryView guide={props.guide} onConceptPress={props.onConceptPress} /> : null}
          {tab === 'result' ? (
            <ResultView state={props.state} result={props.result} liveLog={props.liveLog} name={props.name} />
          ) : null}
          {tab === 'code' ? <CodeView guide={props.guide} /> : null}
        </View>
      ) : null}
    </Card>
  );
}

function StoryView({ guide, onConceptPress }: { guide?: ScenarioGuide; onConceptPress: (id: string) => void }) {
  if (!guide) return <Text style={[type.body, styles.section]}>No guide written for this scenario yet.</Text>;
  return (
    <View style={styles.section}>
      <Overline>What you are watching</Overline>
      <Text style={type.body}>{guide.story}</Text>
      <View style={styles.sectionGap} />
      <Overline>In the driver app today</Overline>
      <Text style={type.body}>{guide.parity}</Text>
      <View style={styles.sectionGap} />
      <Overline>Concepts in play — tap to learn</Overline>
      <View style={styles.chips}>
        {guide.concepts.map(id => {
          const concept = concepts.find(c => c.id === id);
          return <Chip key={id} label={concept?.title ?? id} onPress={() => onConceptPress(id)} />;
        })}
      </View>
    </View>
  );
}

function ResultView({
  state,
  result,
  liveLog,
  name,
}: {
  state: PillState;
  result?: ScenarioResult;
  liveLog: string[];
  name: string;
}) {
  if (state === 'running') {
    return (
      <View style={styles.section}>
        <Overline>Live engine feed</Overline>
        <EngineFeed lines={liveLog} />
      </View>
    );
  }
  if (!result) {
    return (
      <Text style={[type.body, styles.section]}>
        Not run yet on this device. Tap RUN and this view narrates the engine live, then shows every step,
        assertion, and business effect.
      </Text>
    );
  }
  const failedAssertions = result.assertions.filter(a => !a.passed);
  const effects =
    (result.fakeServerSnapshot as { effects?: Array<{ kind: string; key: string; late?: boolean }> } | undefined)
      ?.effects ?? [];
  return (
    <View style={styles.section} testID="result-detail">
      <Text style={result.status === 'passed' ? styles.passHeading : styles.failHeading}>
        {result.status === 'passed' ? 'PASSED' : 'FAILED'} — {name}
      </Text>

      <Overline>Steps</Overline>
      {result.steps.map((step, i) => (
        <Text key={i} style={styles.stepLine}>
          <Text style={{ color: step.status === 'passed' ? colors.successBright : step.status === 'failed' ? colors.errorBright : colors.textMuted }}>
            {step.status === 'passed' ? '✓' : step.status === 'failed' ? '✗' : '⊘'}
          </Text>
          {'  '}
          {step.name}
          {step.detail ? ` — ${step.detail}` : ''}
        </Text>
      ))}

      <View style={styles.sectionGap} />
      <Overline>
        Assertions — {result.assertions.length - failedAssertions.length}/{result.assertions.length} passed
      </Overline>
      {failedAssertions.length === 0 ? (
        <Text style={type.body}>Every claim this scenario makes held on your device.</Text>
      ) : (
        failedAssertions.map((assertion, i) => (
          <Text key={i} style={[styles.stepLine, { color: colors.errorBright }]}>
            ✗ {assertion.name} (expected {JSON.stringify(assertion.expected)}, got {JSON.stringify(assertion.actual)})
          </Text>
        ))
      )}

      <View style={styles.sectionGap} />
      <Overline>Business-effect ledger ({effects.length}) — the anti-duplicate proof</Overline>
      {effects.map((effect, i) => (
        <Text key={i} style={styles.stepLine}>
          {effect.kind}:{effect.key}
          {effect.late ? '  (landed late — absorbed)' : ''}
        </Text>
      ))}

      <View style={styles.sectionGap} />
      <Overline>Engine feed</Overline>
      <EngineFeed lines={result.logs} />
    </View>
  );
}

function CodeView({ guide }: { guide?: ScenarioGuide }) {
  if (!guide) return <Text style={[type.body, styles.section]}>No code sample for this scenario yet.</Text>;
  return (
    <View style={styles.section}>
      <Overline>What you would write</Overline>
      <CodeBlock code={guide.code} />
      <View style={styles.sectionGap} />
      <Overline>Where it lives in a real app</Overline>
      <FileTree tree={guide.files} />
      <Text style={[type.caption, styles.sectionGap]}>
        Full working source: examples/parity-app/src/scenarios/ in the endura repo.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  openCard: { backgroundColor: colors.cardElevated },
  header: { flexDirection: 'row', alignItems: 'flex-start' },
  number: {
    width: 28,
    height: 28,
    borderRadius: radius.md,
    backgroundColor: colors.codeBg,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
    marginTop: 2,
  },
  numberText: { fontFamily: mono, fontSize: 12, fontWeight: '700', color: colors.tertiaryAccentBright },
  titleBlock: { flex: 1, marginRight: spacing.sm },
  question: { ...type.body, color: colors.textSecondary, fontStyle: 'italic', marginTop: 2 },
  actions: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.sm, gap: spacing.xs },
  actionsSpacer: { flex: 1 },
  detail: { marginTop: spacing.md },
  section: { marginTop: spacing.md },
  sectionGap: { marginTop: spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', marginTop: spacing.xs },
  stepLine: { ...type.body, color: colors.textPrimary, marginVertical: 2 },
  passHeading: { fontSize: 15, fontWeight: '700', color: colors.successBright, marginBottom: spacing.sm },
  failHeading: { fontSize: 15, fontWeight: '700', color: colors.errorBright, marginBottom: spacing.sm },
});
