/**
 * Interactive inspector UI — viewers and controls over the
 * InspectorSession playground: SQLite state, executions, tasks, dead
 * letters, fake-server effects/calls, connectivity toggle, background
 * wake, restart, and failure injection.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { FakeBehaviorKind } from './harness/fakeServer';
import { InspectorSession, InspectorSnapshot } from './harness/inspector';

const INJECTIONS: Array<{ label: string; kind: FakeBehaviorKind; delayMs?: number }> = [
  { label: 'FAIL NEXT', kind: 'transient-failure' },
  { label: 'REFUSE NEXT', kind: 'permanent-refusal' },
  { label: 'HANG NEXT', kind: 'hung' },
  { label: 'SLOW NEXT', kind: 'slow', delayMs: 2500 },
  { label: 'LATE OK', kind: 'late-success', delayMs: 10000 },
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
    <View style={styles.panel} testID="inspector-panel">
      <Text style={styles.heading}>
        inspector playground {busy ? '(working…)' : ''} — {online ? 'ONLINE' : 'OFFLINE'}
      </Text>
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

      <Text style={styles.sectionTitle}>failure injection (next upload call)</Text>
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

      {snap ? (
        <>
          <Text style={styles.sectionTitle}>persisted sqlite state ({snap.tables.length} tables)</Text>
          {snap.tables.map(table => (
            <Text key={table.name} style={styles.line}>
              {table.name}: {table.rows} rows
            </Text>
          ))}

          <Text style={styles.sectionTitle}>executions ({snap.executions.length})</Text>
          {snap.executions.map(execution => (
            <Text key={execution.runId} style={styles.line}>
              {execution.status.padEnd(9)} {execution.workflowName} @{execution.currentActivityName ?? '-'} (
              {shortId(execution.runId)})
            </Text>
          ))}

          <Text style={styles.sectionTitle}>tasks ({snap.tasks.length})</Text>
          {snap.tasks.map(task => (
            <Text key={task.taskId} style={styles.line}>
              {task.status.padEnd(9)} {task.activityName} attempts={task.attempts}
              {task.status === 'pending' ? ` due ${dueIn(task.scheduledFor)}` : ''}
            </Text>
          ))}

          <Text style={styles.sectionTitle}>dead letters ({snap.deadLetters.length})</Text>
          {snap.deadLetters.map(deadLetter => (
            <View key={deadLetter.id} style={styles.deadLetterRow}>
              <Text style={[styles.line, styles.deadLetterText]}>
                {deadLetter.activityName}: {deadLetter.error}
              </Text>
              <Pressable
                testID={`inspector-retry-${deadLetter.id}`}
                style={styles.smallButton}
                onPress={act(() => session.retryDeadLetter(deadLetter.id))}
              >
                <Text style={styles.buttonText}>RETRY</Text>
              </Pressable>
            </View>
          ))}

          <Text style={styles.sectionTitle}>
            fake server — effects ({snap.effects.length}) / calls ({snap.calls.length})
          </Text>
          {snap.effects.map((effect, i) => (
            <Text key={`e${i}`} style={styles.line}>
              {effect.kind}:{effect.key}
              {effect.late ? ' (late)' : ''}
            </Text>
          ))}
          {snap.calls.slice(-10).map((call, i) => (
            <Text key={`c${i}`} style={styles.log}>
              {call.endpoint} → {call.outcome}
            </Text>
          ))}

          <Text style={styles.sectionTitle}>engine log (last {snap.logs.length})</Text>
          {snap.logs.map((line, i) => (
            <Text key={`l${i}`} style={styles.log}>
              {line}
            </Text>
          ))}
        </>
      ) : (
        <Text style={styles.line}>opening inspector database…</Text>
      )}
    </View>
  );
}

function Control({ label, onPress, testID }: { label: string; onPress: () => void; testID: string }) {
  return (
    <Pressable testID={testID} style={styles.smallButton} onPress={onPress}>
      <Text style={styles.buttonText}>{label}</Text>
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
  panel: { borderTopWidth: 1, borderTopColor: '#2a3050', marginTop: 12, paddingTop: 8, paddingBottom: 24 },
  heading: { color: '#ffd479', fontFamily: 'Menlo', fontSize: 12, marginBottom: 6 },
  sectionTitle: { color: '#ffd479', fontFamily: 'Menlo', fontSize: 12, marginTop: 10, marginBottom: 4 },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  smallButton: {
    backgroundColor: '#2c4bff',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 6,
  },
  buttonText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  line: { color: '#e8e8f0', fontFamily: 'Menlo', fontSize: 11, marginVertical: 1 },
  log: { color: '#9aa0b4', fontFamily: 'Menlo', fontSize: 10, marginVertical: 1 },
  error: { color: '#ff7b7b', fontFamily: 'Menlo', fontSize: 11, marginVertical: 2 },
  deadLetterRow: { flexDirection: 'row', alignItems: 'center' },
  deadLetterText: { flex: 1 },
});
