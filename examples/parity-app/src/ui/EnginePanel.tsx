/**
 * The Endura engine manager — a bottom panel available on every tab.
 *
 * Collapsed, it is the fixed-geometry instrument strip: live source,
 * connectivity, four KPI counters, and a ticker narrating the last
 * engine event. Swipe up (or tap) and it expands into the full
 * manager, in the spirit of driver-app-3's debug queue screens:
 * every job the engine persists, grouped by stage, with a tap-through
 * detail view (payload, accumulated pipeline state, metadata, task
 * lease, full error history) and actions — force retry, cancel, and a
 * connectivity toggle for the live engine.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { ActivityTask } from 'endura';
import { ParityClient } from '../harness/expoPlatform';
import { EngineInspection, inspectEngine, JobPhase, JobRecord } from '../harness/engineInspection';
import { colors, mono, radius, spacing } from './theme';

export interface EngineStatus {
  source: 'scenario' | 'playground' | 'field';
  label: string;
  online: boolean;
  runningExecutions: number;
  pendingTasks: number;
  activeTasks: number;
  deadLetters: number;
  effects: number;
  lastEvent: string | null;
}

/** Connectivity control for the live engine, provided per source. */
export interface ConnectivityControl {
  /** e.g. "GO OFFLINE", "FORCE OFFLINE (SOFTWARE)". */
  toggleLabel: string;
  onToggle: () => void;
  /** Extra context, e.g. "radio: online". */
  note?: string;
}

const COLLAPSED_HEIGHT = 104;
const EXPANDED_HEIGHT = Math.round(Dimensions.get('window').height * 0.82);

const SOURCE_STYLE = {
  scenario: { color: colors.info, label: 'SCENARIO RUNNING' },
  field: { color: colors.successBright, label: 'FIELD TEST LIVE' },
  playground: { color: colors.tertiaryAccentBright, label: 'PLAYGROUND LIVE' },
} as const;

const PHASE_META: Record<JobPhase, { title: string; glyph: string; color: string }> = {
  active: { title: 'Active — in flight now', glyph: '▶', color: colors.info },
  backoff: { title: 'Retry backoff', glyph: '↻', color: colors.info },
  held: { title: 'Held (offline)', glyph: '‖', color: colors.warning },
  waiting: { title: 'Waiting', glyph: '·', color: colors.textSecondary },
  dead: { title: 'Dead letters', glyph: '✗', color: colors.errorBright },
  failed: { title: 'Failed', glyph: '✗', color: colors.errorBright },
  cancelled: { title: 'Cancelled', glyph: '⊘', color: colors.textMuted },
  completed: { title: 'Completed', glyph: '✓', color: colors.successBright },
};

const PHASE_SECTIONS: JobPhase[] = ['active', 'backoff', 'held', 'waiting', 'dead', 'failed', 'cancelled', 'completed'];

function tickerText(rawLine: string): string {
  return rawLine
    .replace(/^(debug|info|warn|error)\s+/, '')
    .replace(/\s*\{.*$/, '')
    .trim();
}

function timeOf(timestamp: number | undefined): string {
  return timestamp === undefined ? '—' : new Date(timestamp).toTimeString().slice(0, 8);
}

function dueIn(scheduledFor: number | undefined): string {
  if (scheduledFor === undefined) return 'now';
  const delta = scheduledFor - Date.now();
  return delta <= 0 ? 'now' : `in ${(delta / 1000).toFixed(0)}s`;
}

export function EnginePanel({
  status,
  getClient,
  connectivity,
  onJumpToSource,
}: {
  status: EngineStatus | null;
  getClient: () => ParityClient | null;
  connectivity?: ConnectivityControl;
  onJumpToSource?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [inspection, setInspection] = useState<EngineInspection | null>(null);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const heightAnim = useRef(new Animated.Value(COLLAPSED_HEIGHT)).current;
  const expandedRef = useRef(false);
  const pulse = useRef(new Animated.Value(1)).current;
  const lastEvent = status?.lastEvent ?? null;

  useEffect(() => {
    if (lastEvent === null) return;
    pulse.setValue(0.15);
    Animated.timing(pulse, { toValue: 1, duration: 500, useNativeDriver: false }).start();
  }, [lastEvent, pulse]);

  const setPanel = useCallback(
    (open: boolean) => {
      expandedRef.current = open;
      setExpanded(open);
      if (!open) setSelectedRun(null);
      Animated.timing(heightAnim, {
        toValue: open ? EXPANDED_HEIGHT : COLLAPSED_HEIGHT,
        duration: 260,
        useNativeDriver: false,
      }).start();
    },
    [heightAnim]
  );

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) => Math.abs(gesture.dy) > 14,
      onPanResponderRelease: (_event, gesture) => {
        if (gesture.dy < -14 && !expandedRef.current) setPanel(true);
        else if (gesture.dy > 14 && expandedRef.current) setPanel(false);
      },
    })
  ).current;

  // Deep inspection poll, only while the manager is open.
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const client = getClient();
        if (!client) {
          if (!cancelled) setInspection(null);
          return;
        }
        const next = await inspectEngine(client);
        if (!cancelled) setInspection(next);
      } catch {
        // Client mid-teardown — next poll reads consistent state.
      }
    };
    void poll();
    const interval = setInterval(() => void poll(), 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [expanded, getClient, status?.source]);

  const runAction = useCallback(
    (fn: (client: ParityClient) => Promise<unknown>) => () => {
      void (async () => {
        setActionError(null);
        try {
          const client = getClient();
          if (client) await fn(client);
        } catch (err) {
          setActionError(String(err));
        }
      })();
    },
    [getClient]
  );

  const source = status ? SOURCE_STYLE[status.source] : { color: colors.textMuted, label: 'ENGINE IDLE' };
  const queued = (status?.pendingTasks ?? 0) + (status?.activeTasks ?? 0);
  const deadLetters = status?.deadLetters ?? 0;
  const selectedJob = selectedRun ? inspection?.jobs.find(job => job.runId === selectedRun) : undefined;

  return (
    <Animated.View style={[styles.panel, { height: heightAnim }]} {...panResponder.panHandlers}>
      <Pressable onPress={() => setPanel(!expanded)} testID="engine-status-bar">
        <View style={styles.handle} />
        <View style={styles.headerRow}>
          <View style={styles.stateBlock}>
            <Animated.Text style={[styles.dot, { color: source.color, opacity: status ? pulse : 1 }]}>●</Animated.Text>
            <Text style={[styles.stateText, { color: source.color }]} numberOfLines={1}>
              {source.label}
            </Text>
          </View>
          <Text
            style={[
              styles.onlineText,
              { color: status ? (status.online ? colors.successBright : colors.warning) : colors.textMuted },
            ]}
            numberOfLines={1}
          >
            {status ? (status.online ? '⇡ ONLINE' : '⇣ OFFLINE') : '—'}
            {'  '}
            <Text style={{ color: colors.textMuted }}>{expanded ? '▼' : '▲'}</Text>
          </Text>
        </View>

        <View style={styles.kpiRow}>
          <Kpi value={queued} label="QUEUED" active={queued > 0} />
          <Kpi value={status?.runningExecutions ?? 0} label="RUNNING" active={(status?.runningExecutions ?? 0) > 0} />
          <Kpi value={deadLetters} label="DEAD" active={deadLetters > 0} valueColor={deadLetters > 0 ? colors.warning : undefined} />
          <Kpi
            value={status?.effects ?? 0}
            label="DELIVERED"
            active={(status?.effects ?? 0) > 0}
            valueColor={(status?.effects ?? 0) > 0 ? colors.successBright : undefined}
          />
        </View>

        {!expanded ? (
          <Text style={styles.ticker} numberOfLines={1}>
            {status
              ? status.lastEvent
                ? tickerText(status.lastEvent)
                : `engine up — ${status.label}`
              : 'run a lab scenario, start a field test, or open the playground — swipe up to manage'}
          </Text>
        ) : null}
      </Pressable>

      {expanded ? (
        <View style={styles.managerBody}>
          <View style={styles.controlsRow}>
            {connectivity ? (
              <Pressable testID="panel-toggle-online" style={styles.controlButton} onPress={connectivity.onToggle}>
                <Text style={styles.controlButtonText}>{connectivity.toggleLabel}</Text>
              </Pressable>
            ) : (
              <Text style={styles.controlNote}>
                {status ? 'connectivity is scripted by the running scenario' : 'no live engine'}
              </Text>
            )}
            {onJumpToSource && status ? (
              <Pressable testID="panel-jump-source" style={styles.controlGhost} onPress={onJumpToSource}>
                <Text style={styles.controlGhostText}>OPEN TAB →</Text>
              </Pressable>
            ) : null}
          </View>
          {connectivity?.note ? <Text style={styles.controlNoteSmall}>{connectivity.note}</Text> : null}
          {actionError ? <Text style={styles.actionError}>{actionError}</Text> : null}

          <ScrollView style={styles.managerScroll} contentContainerStyle={styles.managerContent}>
            {selectedJob ? (
              <JobDetail
                job={selectedJob}
                onBack={() => setSelectedRun(null)}
                onRetry={
                  selectedJob.deadLetter
                    ? runAction(client => client.engine.retryFromDeadLetter(selectedJob.deadLetter!.id))
                    : undefined
                }
                onCancel={
                  selectedJob.execution.status === 'running'
                    ? runAction(client => client.engine.cancelExecution(selectedJob.runId))
                    : undefined
                }
              />
            ) : (
              <JobList inspection={inspection} onSelect={setSelectedRun} />
            )}
          </ScrollView>
        </View>
      ) : null}
    </Animated.View>
  );
}

function JobList({
  inspection,
  onSelect,
}: {
  inspection: EngineInspection | null;
  onSelect: (runId: string) => void;
}) {
  if (!inspection) {
    return <Text style={styles.emptyText}>no live engine — run a scenario, open the playground, or start a field test</Text>;
  }
  if (inspection.jobs.length === 0) {
    return <Text style={styles.emptyText}>engine is up, queue is empty — add some work</Text>;
  }
  return (
    <View>
      {PHASE_SECTIONS.map(phase => {
        const jobs = inspection.jobs.filter(job => job.phase === phase);
        if (jobs.length === 0) return null;
        const meta = PHASE_META[phase];
        return (
          <View key={phase} style={styles.section}>
            <Text style={[styles.sectionTitle, { color: meta.color }]}>
              {meta.glyph} {meta.title} ({jobs.length})
            </Text>
            {jobs.map(job => (
              <Pressable
                key={job.runId}
                testID={`panel-job-${job.runId}`}
                style={styles.jobRow}
                onPress={() => onSelect(job.runId)}
              >
                <View style={styles.jobRowMain}>
                  <Text style={styles.jobLabel} numberOfLines={1}>
                    {job.label} <Text style={{ color: colors.textMuted }}>· {job.workflowName}</Text>
                  </Text>
                  <Text style={styles.jobSub} numberOfLines={1}>
                    stage {job.stage} · attempts {job.attempts}
                    {job.phase === 'backoff' || job.phase === 'waiting' || job.phase === 'held'
                      ? ` · next ${dueIn(job.scheduledFor)}`
                      : ''}
                    {job.phase === 'completed' ? ` · done ${timeOf(job.currentTask?.completedAt)}` : ''}
                  </Text>
                </View>
                <Text style={styles.jobChevron}>›</Text>
              </Pressable>
            ))}
          </View>
        );
      })}

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>engine log</Text>
        {inspection.logs.map((line, i) => (
          <Text key={i} style={styles.logLine} numberOfLines={2}>
            {line}
          </Text>
        ))}
      </View>
    </View>
  );
}

function JobDetail({
  job,
  onBack,
  onRetry,
  onCancel,
}: {
  job: JobRecord;
  onBack: () => void;
  onRetry?: () => void;
  onCancel?: () => void;
}) {
  const task = job.currentTask;
  const meta = PHASE_META[job.phase];
  return (
    <View>
      <View style={styles.detailHeader}>
        <Pressable testID="panel-job-back" style={styles.controlGhost} onPress={onBack}>
          <Text style={styles.controlGhostText}>← ALL JOBS</Text>
        </Pressable>
        {onRetry ? (
          <Pressable testID="panel-job-retry" style={styles.controlButton} onPress={onRetry}>
            <Text style={styles.controlButtonText}>FORCE RETRY</Text>
          </Pressable>
        ) : null}
        {onCancel ? (
          <Pressable testID="panel-job-cancel" style={styles.controlDanger} onPress={onCancel}>
            <Text style={styles.controlButtonText}>CANCEL</Text>
          </Pressable>
        ) : null}
      </View>

      <Text style={styles.detailTitle}>
        {job.label} <Text style={{ color: meta.color }}>({meta.glyph} {job.phase})</Text>
      </Text>

      <DetailSection title="execution">
        <Mono>
          runId       {job.runId}
          {'\n'}workflow    {job.workflowName}
          {job.execution.workflowVersion ? ` (${job.execution.workflowVersion})` : ''}
          {'\n'}status      {job.execution.status}
          {'\n'}stage       {job.execution.currentActivityName} (index {job.execution.currentActivityIndex})
          {'\n'}created     {timeOf(job.createdAt)}
          {job.execution.uniqueKey ? `\nuniqueKey   ${job.execution.uniqueKey}` : ''}
        </Mono>
      </DetailSection>

      <DetailSection title={`pipeline trail (${job.tasks.length} task${job.tasks.length === 1 ? '' : 's'})`}>
        {job.tasks.map((t, i) => (
          <Text key={t.taskId} style={styles.trailLine}>
            {i + 1}. {taskGlyph(t)} {t.activityName} — {t.status}, attempts {t.attempts}
            {t.completedAt ? `, done ${timeOf(t.completedAt)}` : ''}
          </Text>
        ))}
      </DetailSection>

      <DetailSection title="input payload">
        <Json value={job.execution.input} />
      </DetailSection>

      <DetailSection title="accumulated state (input + every stage's returns)">
        <Json value={job.execution.state} />
      </DetailSection>

      {job.execution.metadata ? (
        <DetailSection title="metadata (app-defined scoping)">
          <Json value={job.execution.metadata} />
        </DetailSection>
      ) : null}

      {task ? (
        <DetailSection title="current task">
          <Mono>
            status      {task.status}
            {'\n'}attempts    {task.attempts}
            {task.scheduledFor ? `\nnext due    ${dueIn(task.scheduledFor)} (${timeOf(task.scheduledFor)})` : ''}
            {task.ownerId ? `\nlease owner ${task.ownerId}` : ''}
            {task.leaseExpiresAt ? `\nlease ends  ${timeOf(task.leaseExpiresAt)}` : ''}
          </Mono>
        </DetailSection>
      ) : null}

      {task?.errorHistory && task.errorHistory.length > 0 ? (
        <DetailSection title={`attempt history (${task.errorHistory.length})`}>
          {task.errorHistory.map((entry, i) => (
            <Text
              key={i}
              style={[styles.trailLine, { color: entry.kind === 'skip' ? colors.textMuted : colors.errorBright }]}
            >
              {timeOf(entry.at)} [{entry.kind}] {entry.message}
            </Text>
          ))}
        </DetailSection>
      ) : null}

      {job.deadLetter ? (
        <DetailSection title="dead letter">
          <Mono>
            error     {job.deadLetter.error}
            {'\n'}attempts  {job.deadLetter.attempts}
            {'\n'}failed at {timeOf(job.deadLetter.failedAt)}
          </Mono>
        </DetailSection>
      ) : null}
    </View>
  );
}

function taskGlyph(task: ActivityTask): string {
  switch (task.status) {
    case 'completed':
      return '✓';
    case 'active':
      return '▶';
    case 'failed':
      return '✗';
    default:
      return '·';
  }
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <Text style={styles.monoBlock}>{children}</Text>;
}

function Json({ value }: { value: unknown }) {
  return <Text style={styles.monoBlock}>{JSON.stringify(value, null, 2)}</Text>;
}

function Kpi({
  value,
  label,
  active,
  valueColor,
}: {
  value: number;
  label: string;
  active: boolean;
  valueColor?: string;
}) {
  return (
    <View style={styles.kpiCell}>
      <Text style={[styles.kpiValue, { color: valueColor ?? (active ? colors.textPrimary : colors.textMuted) }]} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.kpiLabel} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: colors.cardElevated,
    borderTopWidth: 1,
    borderTopColor: colors.hairline,
    paddingHorizontal: spacing.md,
    overflow: 'hidden',
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: radius.full,
    backgroundColor: colors.hairline,
    marginTop: 5,
    marginBottom: 3,
  },
  headerRow: { height: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stateBlock: { flexDirection: 'row', alignItems: 'center' },
  dot: { fontSize: 12, marginRight: 8 },
  stateText: { fontSize: 13, fontWeight: '800', letterSpacing: 1 },
  onlineText: { fontFamily: mono, fontSize: 13, fontWeight: '700' },
  kpiRow: { height: 44, flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  kpiCell: { flex: 1, alignItems: 'center' },
  kpiValue: { fontSize: 24, fontWeight: '800', lineHeight: 28 },
  kpiLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 1.2, color: colors.textMuted },
  ticker: { fontFamily: mono, fontSize: 12, color: colors.textSecondary, marginTop: 4 },

  managerBody: { flex: 1 },
  controlsRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.xs },
  controlButton: {
    backgroundColor: colors.secondaryAccent,
    minHeight: 44,
    paddingHorizontal: spacing.sm,
    justifyContent: 'center',
    borderRadius: radius.md,
  },
  controlDanger: {
    backgroundColor: colors.primaryAccent,
    minHeight: 44,
    paddingHorizontal: spacing.sm,
    justifyContent: 'center',
    borderRadius: radius.md,
  },
  controlButtonText: { color: colors.textPrimary, fontSize: 12, fontWeight: '700' },
  controlGhost: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.xs },
  controlGhostText: { color: colors.secondaryAccentBright, fontSize: 12, fontWeight: '700' },
  controlNote: { color: colors.textMuted, fontSize: 12, flex: 1 },
  controlNoteSmall: { color: colors.textMuted, fontFamily: mono, fontSize: 10, marginTop: 2 },
  actionError: { color: colors.errorBright, fontFamily: mono, fontSize: 11, marginTop: spacing.xxs },

  managerScroll: { flex: 1, marginTop: spacing.xs },
  managerContent: { paddingBottom: spacing.xl },
  emptyText: { color: colors.textMuted, fontFamily: mono, fontSize: 12, marginTop: spacing.md },

  section: { marginTop: spacing.md },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.textMuted,
    marginBottom: spacing.xxs,
  },
  jobRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
    paddingVertical: spacing.xxs,
  },
  jobRowMain: { flex: 1 },
  jobLabel: { color: colors.textPrimary, fontFamily: mono, fontSize: 13, fontWeight: '600' },
  jobSub: { color: colors.textSecondary, fontFamily: mono, fontSize: 11, marginTop: 1 },
  jobChevron: { color: colors.textMuted, fontSize: 20, paddingHorizontal: spacing.xs },
  logLine: { color: colors.textMuted, fontFamily: mono, fontSize: 10, marginVertical: 1 },

  detailHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.xs },
  detailTitle: { color: colors.textPrimary, fontFamily: mono, fontSize: 14, fontWeight: '700', marginTop: spacing.sm },
  trailLine: { color: colors.textSecondary, fontFamily: mono, fontSize: 11, marginVertical: 1 },
  monoBlock: {
    color: colors.codeDefault,
    fontFamily: mono,
    fontSize: 11,
    lineHeight: 16,
    backgroundColor: colors.codeBg,
    borderRadius: radius.md,
    padding: spacing.sm,
  },
});
