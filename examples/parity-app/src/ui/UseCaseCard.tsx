/**
 * One page of the deck: a use case explained in plain English, the
 * code that does it, and a button that runs it for real. The card
 * shows a live readout of its own jobs so tapping the button visibly
 * moves something.
 */

import { ReactNode, useCallback, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { DemoEngineSession } from '../harness/demoEngine';
import { JobRecord } from '../harness/engineInspection';
import { UseCase } from '../content/useCases';
import { CodeBlock } from './CodeBlock';
import { Button, Pill } from './primitives';
import { cardShadow, colors, radius, spacing, type } from './theme';

/** Simplified live counts for one card's workflows. */
export interface CardCounts {
  queued: number;
  delivered: number;
  dead: number;
}

export function countsForCard(useCase: UseCase, jobs: JobRecord[]): CardCounts {
  const mine = jobs.filter(job => useCase.workflows.includes(job.workflowName));
  return {
    queued: mine.filter(job => ['active', 'backoff', 'held', 'waiting'].includes(job.phase)).length,
    delivered: mine.filter(job => job.phase === 'completed').length,
    dead: mine.filter(job => job.phase === 'dead' || job.phase === 'failed').length,
  };
}

export function UseCaseCard({
  useCase,
  session,
  counts,
  width,
  children,
}: {
  useCase: UseCase;
  session: DemoEngineSession;
  counts: CardCounts;
  width: number;
  /** Optional extra controls (e.g. the on-duty switch) above the actions. */
  children?: ReactNode;
}) {
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runAction = useCallback(
    (run: (s: DemoEngineSession) => Promise<unknown>) => {
      void (async () => {
        try {
          await run(session);
          setConfirmation('Queued — watch the Engine bar below');
        } catch (err) {
          setConfirmation(String(err));
        }
        if (confirmTimer.current) clearTimeout(confirmTimer.current);
        confirmTimer.current = setTimeout(() => setConfirmation(null), 2500);
      })();
    },
    [session]
  );

  const hasActivity = counts.queued + counts.delivered + counts.dead > 0;

  return (
    <View style={[styles.card, { width }]}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <View style={[styles.iconChip, { backgroundColor: useCase.tintSoft }]}>
            <Text style={styles.iconText}>{useCase.icon}</Text>
          </View>
          <View style={styles.headerText}>
            <Text style={type.title2}>{useCase.title}</Text>
            <Text style={[type.subhead, { marginTop: 1 }]}>{useCase.tagline}</Text>
          </View>
        </View>

        <Text style={[type.body, styles.story]}>{useCase.story}</Text>

        {hasActivity ? (
          <View style={styles.liveRow}>
            {counts.queued > 0 ? (
              <Pill label={`${counts.queued} in queue`} color={colors.orange} softColor={colors.orangeSoft} />
            ) : null}
            {counts.delivered > 0 ? (
              <Pill label={`${counts.delivered} delivered`} color={colors.green} softColor={colors.greenSoft} />
            ) : null}
            {counts.dead > 0 ? (
              <Pill label={`${counts.dead} dead-lettered`} color={colors.red} softColor={colors.redSoft} />
            ) : null}
          </View>
        ) : null}

        {children}

        <View style={styles.actions}>
          {useCase.actions.map(action => (
            <Button
              key={action.id}
              testID={`action-${action.id}`}
              label={action.label}
              variant={action.variant ?? 'filled'}
              onPress={() => runAction(action.run)}
            />
          ))}
          {confirmation ? <Text style={styles.confirmation}>{confirmation}</Text> : null}
        </View>

        <Text style={styles.tryItTitle}>Try it yourself</Text>
        {useCase.tryIt.map((step, i) => (
          <View key={i} style={styles.step}>
            <Text style={styles.stepNumber}>{i + 1}</Text>
            <Text style={[type.subhead, styles.stepText]}>{step}</Text>
          </View>
        ))}

        <Button
          label={showCode ? 'Hide the Code' : 'Show the Code'}
          variant="plain"
          small
          onPress={() => setShowCode(prev => !prev)}
          style={styles.codeToggle}
        />
        {showCode ? <CodeBlock title={useCase.codeTitle} code={useCase.code} /> : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    marginRight: spacing.md,
    ...cardShadow,
  },
  content: { padding: spacing.lg, paddingBottom: spacing.xl },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  iconChip: {
    width: 48,
    height: 48,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  iconText: { fontSize: 24 },
  headerText: { flex: 1 },
  story: { marginTop: spacing.md },
  liveRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.md },
  actions: { marginTop: spacing.lg, gap: spacing.xs },
  confirmation: { ...type.footnote, color: colors.green, textAlign: 'center', marginTop: spacing.xxs },
  tryItTitle: { ...type.headline, marginTop: spacing.xl, marginBottom: spacing.xs },
  step: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs, alignItems: 'flex-start' },
  stepNumber: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.fill,
    textAlign: 'center',
    lineHeight: 22,
    fontSize: 13,
    fontWeight: '600',
    color: colors.secondaryLabel,
    overflow: 'hidden',
  },
  stepText: { flex: 1 },
  codeToggle: { alignSelf: 'flex-start', marginTop: spacing.md },
});
