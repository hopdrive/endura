/**
 * Field Test tab — real-device torture testing, guided. Nothing on
 * this screen is simulated: connectivity comes from the actual radio,
 * deliveries are actual HTTP to the actual internet, and the queue
 * database is never reset between launches — force quits and reboots
 * are part of the test plan, not a threat to it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { DEFAULT_ENDPOINT, FieldJobRow, FieldTestSession, FieldView } from '../harness/fieldSession';
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
          Default is postman-echo.com (fast, reliable echo that returns 200). For the full effect, open{' '}
          <Text style={styles.em}>webhook.site</Text> on a laptop, copy your unique URL, paste it here — and
          watch every job physically arrive on another screen. (Flaky jobs always target httpbin's
          coin-flip endpoint — unreliability is their job.)
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
        <Overline>
          Jobs ({view?.jobs.length ?? 0}) — {view?.liveCount ?? 0} live · {view?.deliveredTotal ?? 0} delivered ·{' '}
          {view?.deadTotal ?? 0} dead
        </Overline>
        <Text style={[type.caption, styles.caption]}>
          Every job the engine knows about, straight from SQLite: its phase, attempt count, next retry, and
          the exact error behind the last failed attempt. Live work sorts to the top by priority.
        </Text>
        {view && view.jobs.length === 0 ? <Text style={styles.line}>no jobs yet — add some above</Text> : null}
        {view?.jobs.map(job => (
          <View key={job.jobId} style={styles.jobRow}>
            <View style={styles.jobMain}>
              <Text style={styles.line} numberOfLines={1}>
                <Text style={{ color: PHASE_COLOR[job.phase] }}>{PHASE_GLYPH[job.phase]}</Text> {job.jobId}{' '}
                <Text style={{ color: colors.textMuted }}>p{job.priority}</Text>
              </Text>
              <Text style={[styles.jobDetail, { color: PHASE_COLOR[job.phase] }]} numberOfLines={1}>
                {phaseLine(job)}
              </Text>
              {job.lastError && job.phase !== 'delivered' ? (
                <Text
                  style={[
                    styles.jobError,
                    { color: job.lastError.kind === 'skip' ? colors.textMuted : colors.errorBright },
                  ]}
                  numberOfLines={2}
                >
                  last attempt {timeOf(job.lastError.at)} — {job.lastError.message}
                </Text>
              ) : null}
            </View>
            {job.deadLetterId ? (
              <Pressable
                testID={`field-retry-${job.deadLetterId}`}
                style={styles.retryButton}
                onPress={act(() => session.retryDeadLetter(job.deadLetterId!))}
              >
                <Text style={styles.retryText}>RETRY</Text>
              </Pressable>
            ) : null}
          </View>
        ))}
      </Card>

      <Card>
        <Overline>Engine log — the library, narrating itself</Overline>
        <Text style={[type.caption, styles.caption]}>
          The engine's own logger: scheduling, claims, holds, retries, discards. Everything above is derived
          from state; this is the play-by-play.
        </Text>
        {view?.logs.map((line, i) => (
          <Text key={i} style={styles.logLine} numberOfLines={2}>
            {line}
          </Text>
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

const PHASE_GLYPH: Record<FieldJobRow['phase'], string> = {
  waiting: '·',
  held: '‖',
  backoff: '↻',
  active: '▶',
  delivered: '✓',
  dead: '✗',
};

const PHASE_COLOR: Record<FieldJobRow['phase'], string> = {
  waiting: colors.textSecondary,
  held: colors.warning,
  backoff: colors.info,
  active: colors.info,
  delivered: colors.successBright,
  dead: colors.errorBright,
};

function phaseLine(job: FieldJobRow): string {
  switch (job.phase) {
    case 'waiting':
      return `waiting — attempt ${job.attempts}/${job.maxAttempts}${job.nextAttemptAt ? `, due ${dueIn(job.nextAttemptAt)}` : ''}`;
    case 'held':
      return `held (offline) — attempts frozen at ${job.attempts}/${job.maxAttempts}, recheck ${job.nextAttemptAt ? dueIn(job.nextAttemptAt) : 'soon'}`;
    case 'backoff':
      return `retry backoff — attempt ${job.attempts}/${job.maxAttempts} failed, next ${job.nextAttemptAt ? dueIn(job.nextAttemptAt) : 'soon'}`;
    case 'active':
      return `in flight — attempt ${job.attempts + 1}/${job.maxAttempts}`;
    case 'delivered':
      return `delivered ${job.httpStatus ?? ''} at ${job.deliveredAt ? timeOf(job.deliveredAt) : '?'}${job.attempts > 1 ? ` (took ${job.attempts} attempts)` : ''}`;
    case 'dead':
      return `dead after ${job.attempts}/${job.maxAttempts} attempts — waiting for force retry`;
  }
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
  line: { color: colors.textPrimary, fontFamily: mono, fontSize: 12, marginVertical: 1 },
  error: { color: colors.errorBright, fontFamily: mono, fontSize: 11, marginTop: spacing.xs },
  jobRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
  jobMain: { flex: 1 },
  jobDetail: { fontFamily: mono, fontSize: 11, marginTop: 1 },
  jobError: { fontFamily: mono, fontSize: 10, marginTop: 2 },
  logLine: { color: colors.textMuted, fontFamily: mono, fontSize: 10, marginVertical: 1 },
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
