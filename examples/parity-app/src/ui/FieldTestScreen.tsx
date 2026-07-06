/**
 * Field Test tab — real-device torture testing, guided. Nothing on
 * this screen is simulated: connectivity comes from the actual radio,
 * deliveries are actual HTTP to the actual internet, and the queue
 * database is never reset between launches — force quits and reboots
 * are part of the test plan, not a threat to it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { DEFAULT_ENDPOINT, FieldTestSession, FieldView } from '../harness/fieldSession';
import { Btn, Card, Overline } from './primitives';
import { colors, mono, radius, spacing, type } from './theme';

const MISSIONS: Array<{ title: string; steps: string; expect: string }> = [
  {
    title: '1 · Baseline — prove the pipe',
    steps: 'While online, tap ADD JOB.',
    expect: 'It appears in the queue for a heartbeat, then lands in DELIVERED with HTTP 200. If you pasted a webhook.site URL, watch it arrive on your laptop in real time.',
  },
  {
    title: '2 · Airplane mode — the queue holds',
    steps: 'Open Control Center, turn ON airplane mode. Tap ADD PRIORITY MIX twice (6 jobs). Watch the queue.',
    expect: 'Jobs sit pending with attempts staying at 0 — Endura HOLDS work when the radio is off instead of burning retries against a dead socket. Turn airplane mode OFF: the queue flushes in priority order (status 50 → delivery 40 → photo 5), oldest first within each class.',
  },
  {
    title: '3 · Background it',
    steps: 'In airplane mode, add a few jobs. Press home and leave the app for a minute. Come back, then go online.',
    expect: 'The queue is exactly as you left it, then flushes. (Expo Go suspends JS in the background; a dev build adds background fetch — and scenario 10 in the lab proves a background engine can never double-run work.)',
  },
  {
    title: '4 · Force quit — the real test',
    steps: 'In airplane mode, add jobs. Swipe the app away in the app switcher — actually kill it. Relaunch, return to this tab, go online.',
    expect: 'The queue reloaded from SQLite as if nothing happened, then flushes in order. Nothing that mattered ever lived in memory. Reboot the whole phone if you want — same result.',
  },
  {
    title: '5 · Real failures, real retries',
    steps: 'Tap ADD FLAKY. This targets an endpoint that genuinely returns HTTP 500 about half the time.',
    expect: 'Watch attempts climb with backoff between tries until a real 200 lands. If all 8 attempts lose the coin flip, it parks in dead letters — tap RETRY to re-arm it, exactly like a driver would.',
  },
];

export function FieldTestScreen({ session }: { session: FieldTestSession }) {
  const [view, setView] = useState<FieldView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [endpointDraft, setEndpointDraft] = useState<string>(DEFAULT_ENDPOINT);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      if (!session.isOpen()) return;
      const next = await session.view();
      if (mounted.current) {
        setView(next);
        setError(null);
      }
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
    const interval = setInterval(() => void refresh(), 1000);
    return () => {
      mounted.current = false;
      clearInterval(interval);
      // Deliberately do NOT close the session: the field engine keeps
      // delivering while you read other tabs. That's the point.
    };
  }, [session, refresh]);

  const act = useCallback(
    (fn: () => Promise<unknown> | unknown) => () => {
      void (async () => {
        try {
          await fn();
        } catch (err) {
          if (mounted.current) setError(String(err));
        } finally {
          await refresh();
        }
      })();
    },
    [refresh]
  );

  const online = view?.online ?? true;

  return (
    <View>
      <Card>
        <Overline>Field test — nothing simulated</Overline>
        <Text style={type.h3}>Try to lose the work. You won't.</Text>
        <Text style={[type.body, styles.para]}>
          This tab runs a production-style engine: a real tick loop, real connectivity from the radio, real
          HTTP deliveries to the real internet, and a queue database that is never reset between launches.
          Add jobs, then attack it with everything a phone can do — airplane mode, backgrounding, force quit,
          reboot — and watch the queue hold, survive, and flush in order the moment the network returns.
        </Text>
        <Text style={[type.caption, styles.para]}>
          Connectivity right now:{' '}
          <Text style={{ color: online ? colors.successBright : colors.warning, fontWeight: '700' }}>
            {online ? '⇡ ONLINE (radio)' : '⇣ OFFLINE (radio)'}
          </Text>
          {'  ·  engine ticking every 1s'}
        </Text>
      </Card>

      <Card>
        <Overline>Missions</Overline>
        {MISSIONS.map((mission, i) => (
          <View key={i} style={styles.mission}>
            <Text style={type.bodyStrong}>{mission.title}</Text>
            <Text style={type.body}>{mission.steps}</Text>
            <Text style={[type.caption, styles.expect]}>Expect: {mission.expect}</Text>
          </View>
        ))}
      </Card>

      <Card>
        <Overline>Delivery endpoint</Overline>
        <Text style={type.body}>
          Default is httpbin.org (echoes and returns 200). For the full effect, open{' '}
          <Text style={styles.em}>webhook.site</Text> on a laptop, copy your unique URL, paste it here — and
          watch every job physically arrive on another screen.
        </Text>
        <View style={styles.endpointRow}>
          <TextInput
            testID="field-endpoint-input"
            style={styles.input}
            value={endpointDraft}
            onChangeText={setEndpointDraft}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={DEFAULT_ENDPOINT}
            placeholderTextColor={colors.textMuted}
          />
          <Btn
            testID="field-endpoint-set"
            label="SET"
            tone="secondary"
            onPress={act(() => {
              session.setEndpoint(endpointDraft);
              setEndpointDraft(session.endpoint);
            })}
          />
        </View>
        <Text style={type.caption}>sending to: {view?.endpoint ?? DEFAULT_ENDPOINT}</Text>
      </Card>

      <Card>
        <Overline>Add work</Overline>
        <View style={styles.buttonRow}>
          <Btn testID="field-add-job" label="ADD JOB" tone="primary" onPress={act(() => session.addJob('standard'))} />
          <Btn testID="field-add-mix" label="ADD PRIORITY MIX" tone="secondary" onPress={act(() => session.addPriorityMix())} />
          <Btn testID="field-add-flaky" label="ADD FLAKY" tone="secondary" onPress={act(() => session.addJob('flaky'))} />
        </View>
        <Text style={type.caption}>
          PRIORITY MIX queues photo (5) first, delivery (40) second, status (50) last — so an in-order flush
          proves priority beats insertion order.
        </Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </Card>

      <Card>
        <Overline>Queue ({view?.queue.length ?? 0})</Overline>
        <Text style={[type.caption, styles.caption]}>
          Pending + active tasks, straight from SQLite. Offline, attempts stay frozen — that is the hold.
        </Text>
        {view && view.queue.length === 0 ? <Text style={styles.line}>empty — everything delivered</Text> : null}
        {view?.queue.map(row => (
          <Text key={row.taskId} style={styles.line}>
            {row.status === 'active' ? '▶' : '·'} p{String(row.priority).padEnd(3)}{row.jobId}  attempts={row.attempts}
            {row.status === 'pending' && row.scheduledFor ? `  due ${dueIn(row.scheduledFor)}` : ''}
          </Text>
        ))}
      </Card>

      <Card>
        <Overline>Delivered ({view?.deliveredTotal ?? 0} total)</Overline>
        <Text style={[type.caption, styles.caption]}>
          Each line was a real HTTP round-trip. Order here is delivery order — check it against priority after
          a flush.
        </Text>
        {view?.delivered.map(delivery => (
          <Text key={delivery.jobId + String(delivery.deliveredAt)} style={styles.line}>
            ✓ {delivery.jobId}  {delivery.httpStatus}
            {delivery.attempts > 1 ? `  (took ${delivery.attempts} attempts)` : ''}  {timeOf(delivery.deliveredAt)}
          </Text>
        ))}
      </Card>

      <Card>
        <Overline>Dead letters ({view?.deadLetters.length ?? 0})</Overline>
        <Text style={[type.caption, styles.caption]}>
          Work that exhausted all 8 attempts. Parked with full context, waiting for a human — never deleted,
          never auto-fired.
        </Text>
        {view?.deadLetters.map(deadLetter => (
          <View key={deadLetter.id} style={styles.dlqRow}>
            <Text style={[styles.line, styles.dlqText]}>
              {deadLetter.activityName}: {deadLetter.error}
            </Text>
            <Pressable
              testID={`field-retry-${deadLetter.id}`}
              style={styles.retryButton}
              onPress={act(() => session.retryDeadLetter(deadLetter.id))}
            >
              <Text style={styles.retryText}>RETRY</Text>
            </Pressable>
          </View>
        ))}
      </Card>

      <Card>
        <Overline>Danger zone</Overline>
        <Text style={type.caption}>
          The only way field state is ever wiped. Force quits and reboots do NOT count.
        </Text>
        <View style={styles.buttonRow}>
          <Btn testID="field-reset" label="RESET FIELD TEST" tone="ghost" onPress={act(() => session.reset())} />
        </View>
      </Card>
    </View>
  );
}

function dueIn(scheduledFor: number): string {
  const delta = scheduledFor - Date.now();
  return delta <= 0 ? 'now' : `in ${(delta / 1000).toFixed(0)}s`;
}

function timeOf(timestamp: number): string {
  return new Date(timestamp).toTimeString().slice(0, 8);
}

const styles = StyleSheet.create({
  para: { marginTop: spacing.xs },
  em: { color: colors.tertiaryAccentBright, fontWeight: '600' },
  mission: { marginTop: spacing.sm },
  expect: { marginTop: 2 },
  caption: { marginBottom: spacing.xs },
  endpointRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginVertical: spacing.sm },
  input: {
    flex: 1,
    minHeight: 44,
    backgroundColor: colors.codeBg,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
    color: colors.textPrimary,
    fontFamily: mono,
    fontSize: 12,
  },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.sm },
  line: { color: colors.textPrimary, fontFamily: mono, fontSize: 11, marginVertical: 1 },
  error: { color: colors.errorBright, fontFamily: mono, fontSize: 11, marginTop: spacing.xs },
  dlqRow: { flexDirection: 'row', alignItems: 'center', marginVertical: 2 },
  dlqText: { flex: 1 },
  retryButton: {
    backgroundColor: colors.primaryAccent,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    borderRadius: radius.md,
    marginLeft: spacing.xs,
  },
  retryText: { color: colors.textPrimary, fontSize: 12, fontWeight: '700' },
});
