/**
 * Playground (inspector) UI — a live engine you drive by hand, with
 * viewers over everything it persists: SQLite state, executions,
 * tasks, dead letters, fake-server effects/calls, plus connectivity
 * toggle, background wake, restart, and failure injection.
 *
 * Every section carries a caption explaining what you are looking at,
 * so the playground doubles as training: this is the same state a
 * production recovery screen would read via the engine's inspection
 * APIs.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { FakeBehaviorKind } from './harness/fakeServer';
import { InspectorSession, InspectorSnapshot } from './harness/inspector';
import { Card, Overline } from './ui/primitives';
import { colors, mono, radius, spacing, type } from './ui/theme';

const INJECTIONS: Array<{ label: string; kind: FakeBehaviorKind; delayMs?: number; hint: string }> = [
  { label: 'FAIL NEXT', kind: 'transient-failure', hint: 'one retryable error' },
  { label: 'REFUSE NEXT', kind: 'permanent-refusal', hint: 'non-retryable → DLQ' },
  { label: 'HANG NEXT', kind: 'hung', hint: 'never settles until released' },
  { label: 'SLOW NEXT', kind: 'slow', delayMs: 2500, hint: '2.5s response' },
  { label: 'LATE OK', kind: 'late-success', delayMs: 10000, hint: 'lands after 10s' },
];

const TRY_THIS: Array<{ title: string; steps: string }> = [
  {
    title: 'Watch offline hold work',
    steps: 'START JOB → GO OFFLINE → TICK a few times. The upload task stays pending with attempts=0 — held, not failing. GO ONLINE → TICK: it runs.',
  },
  {
    title: 'Send a job to the dead-letter queue and rescue it',
    steps: 'REFUSE NEXT → START JOB → TICK ×3. The refusal is non-retryable: one attempt, straight to dead letters. Tap RETRY on the entry → TICK ×2: recovered, and the ledger shows no duplicate.',
  },
  {
    title: 'Prove a restart loses nothing',
    steps: 'START JOB → TICK once (stage 1 of 3 done) → RESTART → TICK ×2. The pipeline finishes from stage 2 — the database is the queue.',
  },
  {
    title: 'Collide two engines',
    steps: 'SLOW NEXT → START JOB → TICK, then immediately BG WAKE. A second engine runs over the same database while the call is in flight — the lease keeps it off the active task.',
  },
];

export function InspectorPanel({ session }: { session: InspectorSession }) {
  const [snap, setSnap] = useState<InspectorSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await session.snapshot();
      if (mounted.current) setSnap(next);
    } catch (err) {
      if (mounted.current) setError(String(err));
    }
  }, [session]);

  useEffect(() => {
    mounted.current = true;
    void session
      .open()
      .then(refresh)
      .catch(err => setError(String(err)));
    return () => {
      mounted.current = false;
    };
  }, [session, refresh]);

  const act = useCallback(
    (fn: () => Promise<unknown> | unknown) => () => {
      void (async () => {
        setBusy(true);
        setError(null);
        try {
          await fn();
        } catch (err) {
          if (mounted.current) setError(String(err));
        } finally {
          await refresh();
          if (mounted.current) setBusy(false);
        }
      })();
    },
    [refresh]
  );

  const online = snap?.online ?? true;

  return (
    <View testID="inspector-panel">
      <Card>
        <Overline>The playground</Overline>
        <Text style={type.h3}>A live engine you drive by hand</Text>
        <Text style={[type.body, styles.para]}>
          This is a real Endura engine over its own database (isolated from every scenario), running a 3-stage
          pipeline: prepare → upload → finalize. The upload stage calls the fake server, needs connectivity,
          and times out after 8s. Nothing moves until you TICK — so every state change below is one you
          caused, and every viewer shows exactly what is persisted right now.
        </Text>
      </Card>

      <Card>
        <Overline>Try this</Overline>
        {TRY_THIS.map((recipe, i) => (
          <View key={i} style={styles.recipe}>
            <Text style={type.bodyStrong}>{recipe.title}</Text>
            <Text style={type.body}>{recipe.steps}</Text>
          </View>
        ))}
      </Card>

      <Card>
        <View style={styles.statusRow}>
          <Overline>Engine controls</Overline>
          <Text style={[styles.statusText, { color: online ? colors.successBright : colors.warning }]}>
            {busy ? 'WORKING… ' : ''}
            {online ? '⇡ ONLINE' : '⇣ OFFLINE'}
          </Text>
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.buttonRow}>
          <Control testID="inspector-start-job" label="START JOB" onPress={act(() => session.startJob())} />
          <Control testID="inspector-tick" label="TICK" onPress={act(() => session.tick())} />
          <Control
            testID="inspector-online-toggle"
            label={online ? 'GO OFFLINE' : 'GO ONLINE'}
            onPress={act(() => session.setOnline(!online))}
          />
          <Control testID="inspector-restart" label="RESTART" onPress={act(() => session.restart())} />
          <Control testID="inspector-bg-wake" label="BG WAKE" onPress={act(() => session.backgroundWake())} />
          <Control testID="inspector-refresh" label="REFRESH" onPress={act(() => undefined)} />
          <Control testID="inspector-reset" label="RESET DB" onPress={act(() => session.reset())} />
        </View>
        <Text style={type.caption}>
          TICK = one engine pass over due work. RESTART = destroy the client, reopen the same database. BG
          WAKE = a second engine over the same file for 1.5s, like iOS background fetch.
        </Text>
      </Card>

      <Card>
        <Overline>Failure injection — scripts the NEXT upload call</Overline>
        <View style={styles.buttonRow}>
          {INJECTIONS.map(injection => (
            <Control
              key={injection.kind}
              testID={`inspector-inject-${injection.kind}`}
              label={injection.label}
              onPress={act(() => session.inject(injection.kind, injection.delayMs))}
            />
          ))}
          <Control testID="inspector-release-hung" label="RELEASE HUNG" onPress={act(() => session.releaseHung())} />
          <Control testID="inspector-fail-hung" label="FAIL HUNG" onPress={act(() => session.failHung())} />
        </View>
        <Text style={type.caption}>
          {INJECTIONS.map(i => `${i.label}: ${i.hint}`).join(' · ')}
        </Text>
      </Card>

      {snap ? (
        <>
          <Card>
            <Overline>Persisted SQLite state ({snap.tables.length} tables)</Overline>
            <Text style={[type.caption, styles.caption]}>
              The actual tables in the database file. This IS the queue — kill the app and these rows are the
              recovery plan.
            </Text>
            {snap.tables.map(table => (
              <Text key={table.name} style={styles.line}>
                {table.name}: {table.rows} rows
              </Text>
            ))}
          </Card>

          <Card>
            <Overline>Executions ({snap.executions.length})</Overline>
            <Text style={[type.caption, styles.caption]}>
              One row per started workflow: its status and which stage it is on. A recovery screen reads this
              same data via getExecutions().
            </Text>
            {snap.executions.map(execution => (
              <Text key={execution.runId} style={styles.line}>
                {execution.status.padEnd(9)} {execution.workflowName} @{execution.currentActivityName ?? '-'} (
                {shortId(execution.runId)})
              </Text>
            ))}
          </Card>

          <Card>
            <Overline>Tasks ({snap.tasks.length})</Overline>
            <Text style={[type.caption, styles.caption]}>
              One row per stage attempt-slot. Watch attempts while offline (they stay put — that is runWhen
              holding) and scheduledFor during backoff.
            </Text>
            {snap.tasks.map(task => (
              <Text key={task.taskId} style={styles.line}>
                {task.status.padEnd(9)} {task.activityName} attempts={task.attempts}
                {task.status === 'pending' ? ` due ${dueIn(task.scheduledFor)}` : ''}
              </Text>
            ))}
          </Card>

          <Card>
            <Overline>Dead letters ({snap.deadLetters.length})</Overline>
            <Text style={[type.caption, styles.caption]}>
              Exhausted or refused work, parked with full context. RETRY is the same call a production
              recovery button makes: retryFromDeadLetter(id).
            </Text>
            {snap.deadLetters.length === 0 ? <Text style={styles.line}>none — inject a refusal to create one</Text> : null}
            {snap.deadLetters.map(deadLetter => (
              <View key={deadLetter.id} style={styles.deadLetterRow}>
                <Text style={[styles.line, styles.deadLetterText]}>
                  {deadLetter.activityName}: {deadLetter.error}
                </Text>
                <Pressable
                  testID={`inspector-retry-${deadLetter.id}`}
                  style={styles.retryButton}
                  onPress={act(() => session.retryDeadLetter(deadLetter.id))}
                >
                  <Text style={styles.retryButtonText}>RETRY</Text>
                </Pressable>
              </View>
            ))}
          </Card>

          <Card>
            <Overline>
              Fake server — effects ({snap.effects.length}) / calls ({snap.calls.length})
            </Overline>
            <Text style={[type.caption, styles.caption]}>
              Effects are logical business outcomes (one upload = one line). Calls are the raw request log —
              retries appear here, but must never mint a second effect. That gap is the whole point.
            </Text>
            {snap.effects.map((effect, i) => (
              <Text key={`e${i}`} style={styles.line}>
                {effect.kind}:{effect.key}
                {effect.late ? ' (late)' : ''}
              </Text>
            ))}
            {snap.calls.slice(-10).map((call, i) => (
              <Text key={`c${i}`} style={styles.dimLine}>
                {call.endpoint} → {call.outcome}
              </Text>
            ))}
          </Card>

          <Card>
            <Overline>Engine log (last {snap.logs.length})</Overline>
            <Text style={[type.caption, styles.caption]}>
              The engine's own logger — task scheduling, claims, holds, discards. In production you would sink
              this into your logging pipeline.
            </Text>
            {snap.logs.map((line, i) => (
              <Text key={`l${i}`} style={styles.dimLine}>
                {line}
              </Text>
            ))}
          </Card>
        </>
      ) : (
        <Card>
          <Text style={styles.line}>opening inspector database…</Text>
        </Card>
      )}
    </View>
  );
}

function Control({ label, onPress, testID }: { label: string; onPress: () => void; testID: string }) {
  return (
    <Pressable testID={testID} style={styles.controlButton} onPress={onPress}>
      <Text style={styles.controlButtonText}>{label}</Text>
    </Pressable>
  );
}

function shortId(runId: string): string {
  return runId.length > 8 ? runId.slice(0, 8) : runId;
}

function dueIn(scheduledFor: number | undefined): string {
  if (scheduledFor === undefined) return 'now';
  const delta = scheduledFor - Date.now();
  return delta <= 0 ? 'now' : `in ${(delta / 1000).toFixed(1)}s`;
}

const styles = StyleSheet.create({
  para: { marginTop: spacing.xs },
  caption: { marginBottom: spacing.xs },
  recipe: { marginTop: spacing.sm },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  statusText: { fontFamily: mono, fontSize: 12, fontWeight: '700' },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginVertical: spacing.sm },
  controlButton: {
    backgroundColor: colors.secondaryAccent,
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: spacing.sm,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radius.md,
  },
  controlButtonText: { color: colors.textPrimary, fontSize: 12, fontWeight: '700' },
  retryButton: {
    backgroundColor: colors.primaryAccent,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    borderRadius: radius.md,
    marginLeft: spacing.xs,
  },
  retryButtonText: { color: colors.textPrimary, fontSize: 12, fontWeight: '700' },
  line: { color: colors.textPrimary, fontFamily: mono, fontSize: 11, marginVertical: 1 },
  dimLine: { color: colors.textMuted, fontFamily: mono, fontSize: 10, marginVertical: 1 },
  error: { color: colors.errorBright, fontFamily: mono, fontSize: 11, marginVertical: 2 },
  deadLetterRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 2 },
  deadLetterText: { flex: 1 },
});
