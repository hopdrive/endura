/**
 * The Endura engine inspector — a standard draggable bottom sheet
 * (@gorhom/bottom-sheet, the Apple-Maps interaction model).
 *
 * Collapsed, it is a compact status bar with live queue counters.
 * Drag it up (it tracks your finger) or tap it and it expands to the
 * full inspector, with a dimmed backdrop and rounded sheet corners:
 *
 *   Status — engine state, real radio connectivity, the on-duty app
 *            state switch, delivery endpoint, and reset.
 *   Setup  — every registered workflow and its activities (retry
 *            policy, priority, timeout, gating), read from the live
 *            definitions.
 *   Jobs   — every job the engine persists, grouped by phase, with a
 *            drill-in detail view (payload, pipeline trail, attempt
 *            history) and retry / cancel actions.
 *   Log    — the engine narrating itself.
 *   Tests  — the 15-scenario parity suite, runnable on this device.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetBackdropProps,
  BottomSheetScrollView,
  BottomSheetTextInput,
} from '@gorhom/bottom-sheet';
import PagerView from 'react-native-pager-view';
import { ActivityTask } from 'endura';
import { DemoEngineSession, DEFAULT_ENDPOINT } from '../harness/demoEngine';
import { EngineInspection, JobPhase, JobRecord } from '../harness/engineInspection';
import { runScenario } from '../harness/runner';
import { expoPlatform } from '../harness/expoPlatform';
import { scenarios } from '../scenarios';
import { Button, Card, ListRow, Pill, SectionHeader, SegmentedTabs } from './primitives';
import { colors, mono, radius, spacing, type } from './theme';

const PHASE_META: Record<JobPhase, { title: string; color: string; soft: string }> = {
  active: { title: 'Running Now', color: colors.tint, soft: colors.tintSoft },
  backoff: { title: 'Retrying', color: colors.teal, soft: colors.tealSoft },
  held: { title: 'Held by a Gate', color: colors.orange, soft: colors.orangeSoft },
  waiting: { title: 'Waiting', color: colors.gray, soft: colors.graySoft },
  dead: { title: 'Dead Letters', color: colors.red, soft: colors.redSoft },
  failed: { title: 'Failed', color: colors.red, soft: colors.redSoft },
  cancelled: { title: 'Cancelled', color: colors.gray, soft: colors.graySoft },
  completed: { title: 'Completed', color: colors.green, soft: colors.greenSoft },
};

const PHASE_SECTIONS: JobPhase[] = ['active', 'backoff', 'held', 'waiting', 'dead', 'failed', 'cancelled', 'completed'];

function timeOf(timestamp: number | undefined): string {
  return timestamp === undefined ? '—' : new Date(timestamp).toTimeString().slice(0, 8);
}

function dueIn(scheduledFor: number | undefined): string {
  if (scheduledFor === undefined) return 'now';
  const delta = scheduledFor - Date.now();
  return delta <= 0 ? 'now' : `in ${(delta / 1000).toFixed(0)}s`;
}

type PanelTab = 'status' | 'setup' | 'jobs' | 'log' | 'tests';

const PANEL_TABS: Array<{ key: PanelTab; label: string }> = [
  { key: 'status', label: 'Status' },
  { key: 'setup', label: 'Setup' },
  { key: 'jobs', label: 'Jobs' },
  { key: 'log', label: 'Log' },
  { key: 'tests', label: 'Tests' },
];

/** Height of the collapsed sheet — the docked status bar. */
export const PANEL_COLLAPSED_HEIGHT = 132;

export function EnginePanel({
  session,
  inspection,
  onDuty,
  onDutyChanged,
}: {
  session: DemoEngineSession;
  inspection: EngineInspection | null;
  /** Live duty state, owned by the app (single source of truth). */
  onDuty: boolean;
  /** Lets the app re-render anything else showing duty state. */
  onDutyChanged?: () => void;
}) {
  const sheetRef = useRef<BottomSheet>(null);
  const pagerRef = useRef<PagerView>(null);
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<PanelTab>('status');
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const snapPoints = useMemo(() => [PANEL_COLLAPSED_HEIGHT, '88%'], []);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} appearsOnIndex={1} disappearsOnIndex={0} pressBehavior="collapse" />
    ),
    []
  );

  const counts = inspection?.counts;
  const queued = counts ? counts.waiting + counts.held + counts.backoff : 0;
  const running = counts?.active ?? 0;
  const delivered = counts?.completed ?? 0;
  const dead = counts ? counts.dead + counts.failed : 0;
  const online = session.isOnline();
  const selectedJob = selectedRun ? inspection?.jobs.find(job => job.runId === selectedRun) : undefined;

  return (
    <BottomSheet
      ref={sheetRef}
      index={0}
      snapPoints={snapPoints}
      enableDynamicSizing={false}
      enablePanDownToClose={false}
      onChange={index => {
        setExpanded(index >= 1);
        if (index === 0) setSelectedRun(null);
      }}
      backdropComponent={renderBackdrop}
      handleIndicatorStyle={styles.handleIndicator}
      backgroundStyle={styles.sheetBackground}
      style={styles.sheetShadow}
    >
      <Pressable
        testID="engine-status-bar"
        style={styles.dock}
        onPress={() => sheetRef.current?.snapToIndex(expanded ? 0 : 1)}
      >
        <View style={styles.dockHeader}>
          <View style={styles.dockTitleRow}>
            <View style={[styles.dot, { backgroundColor: session.isOpen() ? colors.green : colors.gray }]} />
            <Text style={type.headline}>Endura Engine</Text>
          </View>
          <View style={styles.dockPills}>
            <Pill
              label={online ? 'Online' : 'Offline'}
              color={online ? colors.green : colors.orange}
              softColor={online ? colors.greenSoft : colors.orangeSoft}
            />
            {!onDuty ? <Pill label="Off Duty" color={colors.gray} softColor={colors.graySoft} /> : null}
          </View>
        </View>
        <View style={styles.kpiRow}>
          <Kpi value={queued} label="In Queue" tone={queued > 0 ? colors.orange : undefined} />
          <Kpi value={running} label="Running" tone={running > 0 ? colors.tint : undefined} />
          <Kpi value={delivered} label="Delivered" tone={delivered > 0 ? colors.green : undefined} />
          <Kpi value={dead} label="Dead" tone={dead > 0 ? colors.red : undefined} />
        </View>
      </Pressable>

      <View style={styles.tabsWrap}>
        <SegmentedTabs<PanelTab>
          tabs={PANEL_TABS}
          active={tab}
          onChange={next => {
            setTab(next);
            setSelectedRun(null);
            pagerRef.current?.setPage(PANEL_TABS.findIndex(t => t.key === next));
          }}
          testIDPrefix="panel-tab"
        />
      </View>

      <PagerView
        ref={pagerRef}
        style={styles.pager}
        initialPage={0}
        onPageSelected={e => {
          setTab(PANEL_TABS[e.nativeEvent.position].key);
          setSelectedRun(null);
        }}
      >
        <View key="status" style={styles.page}>
          <BottomSheetScrollView contentContainerStyle={styles.sheetContent}>
            <StatusTab session={session} inspection={inspection} onDuty={onDuty} onDutyChanged={onDutyChanged} />
          </BottomSheetScrollView>
        </View>
        <View key="setup" style={styles.page}>
          <BottomSheetScrollView contentContainerStyle={styles.sheetContent}>
            <SetupTab session={session} />
          </BottomSheetScrollView>
        </View>
        <View key="jobs" style={styles.page}>
          <BottomSheetScrollView contentContainerStyle={styles.sheetContent}>
            {selectedJob ? (
              <JobDetail job={selectedJob} session={session} onBack={() => setSelectedRun(null)} />
            ) : (
              <JobsTab inspection={inspection} onSelect={setSelectedRun} />
            )}
          </BottomSheetScrollView>
        </View>
        <View key="log" style={styles.page}>
          <BottomSheetScrollView contentContainerStyle={styles.sheetContent}>
            <LogTab inspection={inspection} />
          </BottomSheetScrollView>
        </View>
        <View key="tests" style={styles.page}>
          <BottomSheetScrollView contentContainerStyle={styles.sheetContent}>
            <TestsTab />
          </BottomSheetScrollView>
        </View>
      </PagerView>
    </BottomSheet>
  );
}

function Kpi({ value, label, tone }: { value: number; label: string; tone?: string }) {
  return (
    <View style={styles.kpiCell}>
      <Text style={[styles.kpiValue, tone ? { color: tone } : null]} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.kpiLabel} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

// --- Status ------------------------------------------------------------------

function StatusTab({
  session,
  inspection,
  onDuty,
  onDutyChanged,
}: {
  session: DemoEngineSession;
  inspection: EngineInspection | null;
  onDuty: boolean;
  onDutyChanged?: () => void;
}) {
  const [endpointDraft, setEndpointDraft] = useState(session.endpoint);
  const [resetting, setResetting] = useState(false);
  const counts = inspection?.counts;

  const toggleDuty = useCallback(
    (value: boolean) => {
      session.setOnDuty(value);
      onDutyChanged?.();
    },
    [session, onDutyChanged]
  );

  const confirmReset = useCallback(() => {
    Alert.alert('Reset demo data?', 'Every job, delivery record, and dead letter will be deleted.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reset',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            setResetting(true);
            try {
              await session.reset();
            } finally {
              setResetting(false);
            }
          })();
        },
      },
    ]);
  }, [session]);

  return (
    <View>
      <SectionHeader>Engine</SectionHeader>
      <Card style={styles.groupCard}>
        <ListRow first title="Status" value={session.isOpen() ? 'Running' : 'Stopped'} />
        <ListRow title="Database" value="endura-demo.db" />
        <ListRow title="Tick interval" value="1 second" />
      </Card>

      <SectionHeader>Connectivity</SectionHeader>
      <Card style={styles.groupCard}>
        <ListRow first title="Device radio" value={session.isOnline() ? 'Online' : 'Offline'} />
      </Card>
      <Text style={styles.groupFootnote}>
        Read from the device itself. To test offline behavior, use real Airplane Mode — there is nothing to
        simulate.
      </Text>

      <SectionHeader>App State</SectionHeader>
      <Card style={styles.groupCard}>
        <View style={styles.switchRow}>
          <Text style={type.body}>On duty</Text>
          <Switch testID="panel-duty-switch" value={onDuty} onValueChange={toggleDuty} />
        </View>
      </Card>
      <Text style={styles.groupFootnote}>
        State the device can’t change by itself. Duty-gated workflows hold while this is off and release the
        moment it flips back on.
      </Text>

      <SectionHeader>Delivery Endpoint</SectionHeader>
      <Card style={styles.groupCard}>
        <BottomSheetTextInput
          testID="panel-endpoint-input"
          style={styles.endpointInput}
          value={endpointDraft}
          onChangeText={setEndpointDraft}
          onEndEditing={() => {
            session.setEndpoint(endpointDraft);
            setEndpointDraft(session.endpoint);
          }}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder={DEFAULT_ENDPOINT}
        />
      </Card>
      <Text style={styles.groupFootnote}>
        Where most cards deliver to. Paste a webhook.site URL to watch your phone’s deliveries arrive on a
        laptop.
      </Text>

      <SectionHeader>Queue</SectionHeader>
      <Card style={styles.groupCard}>
        <ListRow first title="In queue" value={`${counts ? counts.waiting + counts.held + counts.backoff : 0}`} />
        <ListRow title="Running now" value={`${counts?.active ?? 0}`} />
        <ListRow title="Delivered" value={`${counts?.completed ?? 0}`} />
        <ListRow title="Dead letters" value={`${counts ? counts.dead + counts.failed : 0}`} />
      </Card>

      <Card style={styles.groupCard}>
        <Button
          testID="panel-reset"
          label={resetting ? 'Resetting…' : 'Reset Demo Data'}
          variant="destructive"
          onPress={confirmReset}
          disabled={resetting}
        />
      </Card>
    </View>
  );
}

// --- Setup ---------------------------------------------------------------

function SetupTab({ session }: { session: DemoEngineSession }) {
  const activityCount = session.registered.reduce((sum, entry) => sum + entry.workflow.activities.length, 0);
  return (
    <View>
      <Text style={[type.subhead, styles.tabIntro]}>
        {session.registered.length} workflows and {activityCount} activities are registered with this engine —
        read live from the definitions, exactly as the code declared them.
      </Text>
      {session.registered.map(entry => (
        <View key={entry.workflow.name}>
          <SectionHeader>{entry.workflow.name}</SectionHeader>
          <Card style={styles.groupCard}>
            {entry.workflow.activities.map((activity, i) => {
              const options = activity.options ?? {};
              const details = [
                `priority ${options.priority ?? 0}`,
                `up to ${options.retry?.maximumAttempts ?? 1} attempt${(options.retry?.maximumAttempts ?? 1) === 1 ? '' : 's'}`,
                options.startToCloseTimeout ? `${Math.round(options.startToCloseTimeout / 1000)}s timeout` : null,
                options.runWhen ? 'gated by runWhen' : null,
              ].filter(Boolean);
              return (
                <ListRow
                  key={activity.name}
                  first={i === 0}
                  title={`${i + 1}.  ${activity.name}`}
                  subtitle={details.join(' · ')}
                />
              );
            })}
          </Card>
          <Text style={styles.groupFootnote}>{entry.description}</Text>
        </View>
      ))}
    </View>
  );
}

// --- Jobs ----------------------------------------------------------------

function JobsTab({
  inspection,
  onSelect,
}: {
  inspection: EngineInspection | null;
  onSelect: (runId: string) => void;
}) {
  if (!inspection || inspection.jobs.length === 0) {
    return (
      <Text style={[type.subhead, styles.tabIntro]}>
        The queue is empty. Every job you create from the cards shows up here, grouped by what the engine is
        doing with it right now.
      </Text>
    );
  }
  return (
    <View>
      {PHASE_SECTIONS.map(phase => {
        const jobs = inspection.jobs.filter(job => job.phase === phase);
        if (jobs.length === 0) return null;
        const meta = PHASE_META[phase];
        return (
          <View key={phase}>
            <SectionHeader>
              {meta.title} · {jobs.length}
            </SectionHeader>
            <Card style={styles.groupCard}>
              {jobs.map((job, i) => (
                <ListRow
                  key={job.runId}
                  first={i === 0}
                  testID={`panel-job-${job.runId}`}
                  title={job.label}
                  subtitle={jobSubtitle(job)}
                  right={<Pill label={phaseLabel(job.phase)} color={meta.color} softColor={meta.soft} />}
                  onPress={() => onSelect(job.runId)}
                />
              ))}
            </Card>
          </View>
        );
      })}
    </View>
  );
}

function phaseLabel(phase: JobPhase): string {
  switch (phase) {
    case 'active':
      return 'Running';
    case 'backoff':
      return 'Retrying';
    case 'held':
      return 'Held';
    case 'waiting':
      return 'Waiting';
    case 'dead':
      return 'Dead';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'completed':
      return 'Done';
  }
}

function jobSubtitle(job: JobRecord): string {
  const parts = [`${job.workflowName} · ${job.stage}`];
  if (job.attempts > 0) parts.push(`attempt ${job.attempts}`);
  if (job.phase === 'backoff' || job.phase === 'held' || job.phase === 'waiting') {
    parts.push(`next ${dueIn(job.scheduledFor)}`);
  }
  if (job.phase === 'completed') parts.push(`done ${timeOf(job.currentTask?.completedAt)}`);
  return parts.join(' · ');
}

function JobDetail({
  job,
  session,
  onBack,
}: {
  job: JobRecord;
  session: DemoEngineSession;
  onBack: () => void;
}) {
  const [actionError, setActionError] = useState<string | null>(null);
  const task = job.currentTask;
  const meta = PHASE_META[job.phase];

  const runAction = (fn: () => Promise<void>) => () => {
    void (async () => {
      setActionError(null);
      try {
        await fn();
        onBack();
      } catch (err) {
        setActionError(String(err));
      }
    })();
  };

  return (
    <View>
      <View style={styles.detailHeader}>
        <Button testID="panel-job-back" label="‹ All Jobs" variant="plain" small onPress={onBack} />
        <View style={styles.detailHeaderSpacer} />
        {job.deadLetter ? (
          <Button
            testID="panel-job-retry"
            label="Retry"
            variant="tinted"
            small
            onPress={runAction(() => session.retryDeadLetter(job.deadLetter!.id))}
          />
        ) : null}
        {job.execution.status === 'running' ? (
          <Button
            testID="panel-job-cancel"
            label="Cancel"
            variant="destructive"
            small
            onPress={runAction(() => session.cancelExecution(job.runId))}
          />
        ) : null}
      </View>
      {actionError ? <Text style={styles.actionError}>{actionError}</Text> : null}

      <View style={styles.detailTitleRow}>
        <Text style={type.title3}>{job.label}</Text>
        <Pill label={phaseLabel(job.phase)} color={meta.color} softColor={meta.soft} />
      </View>

      <SectionHeader>Execution</SectionHeader>
      <Card style={styles.groupCard}>
        <ListRow first title="Workflow" value={job.workflowName} />
        <ListRow title="Run ID" value={job.runId.slice(0, 18)} />
        <ListRow title="Status" value={job.execution.status} />
        <ListRow title="Stage" value={`${job.execution.currentActivityName} (#${job.execution.currentActivityIndex + 1})`} />
        <ListRow title="Created" value={timeOf(job.createdAt)} />
        {job.execution.uniqueKey ? <ListRow title="Unique key" value={job.execution.uniqueKey} /> : null}
      </Card>

      <SectionHeader>Pipeline · {job.tasks.length} task{job.tasks.length === 1 ? '' : 's'}</SectionHeader>
      <Card style={styles.groupCard}>
        {job.tasks.map((t, i) => (
          <ListRow
            key={t.taskId}
            first={i === 0}
            title={`${i + 1}.  ${t.activityName}`}
            subtitle={`${t.attempts} attempt${t.attempts === 1 ? '' : 's'}${t.completedAt ? ` · done ${timeOf(t.completedAt)}` : ''}`}
            right={<Pill {...taskPill(t)} />}
          />
        ))}
      </Card>

      {task ? (
        <>
          <SectionHeader>Current Task</SectionHeader>
          <Card style={styles.groupCard}>
            <ListRow first title="Status" value={task.status} />
            <ListRow title="Attempts" value={`${task.attempts}`} />
            {task.scheduledFor ? <ListRow title="Next due" value={`${dueIn(task.scheduledFor)} (${timeOf(task.scheduledFor)})`} /> : null}
            {task.ownerId ? <ListRow title="Lease owner" value={task.ownerId.slice(0, 16)} /> : null}
            {task.leaseExpiresAt ? <ListRow title="Lease ends" value={timeOf(task.leaseExpiresAt)} /> : null}
          </Card>
        </>
      ) : null}

      {task?.errorHistory && task.errorHistory.length > 0 ? (
        <>
          <SectionHeader>Attempt History · {task.errorHistory.length}</SectionHeader>
          <Card style={styles.groupCard}>
            {task.errorHistory.map((entry, i) => (
              <ListRow
                key={i}
                first={i === 0}
                title={entry.kind === 'skip' ? 'Held' : 'Failed'}
                subtitle={`${timeOf(entry.at)} — ${entry.message}`}
                right={
                  <Pill
                    label={entry.kind === 'skip' ? 'gate' : 'error'}
                    color={entry.kind === 'skip' ? colors.orange : colors.red}
                    softColor={entry.kind === 'skip' ? colors.orangeSoft : colors.redSoft}
                  />
                }
              />
            ))}
          </Card>
        </>
      ) : null}

      {job.deadLetter ? (
        <>
          <SectionHeader>Dead Letter</SectionHeader>
          <Card style={styles.groupCard}>
            <ListRow first title="Error" subtitle={job.deadLetter.error} />
            <ListRow title="Attempts" value={`${job.deadLetter.attempts}`} />
            <ListRow title="Failed at" value={timeOf(job.deadLetter.failedAt)} />
          </Card>
        </>
      ) : null}

      <SectionHeader>Input Payload</SectionHeader>
      <JsonWell value={job.execution.input} />

      <SectionHeader>Accumulated State</SectionHeader>
      <JsonWell value={job.execution.state} />
      <Text style={styles.groupFootnote}>
        The input plus every completed stage’s return value — what the next stage receives.
      </Text>
    </View>
  );
}

function taskPill(task: ActivityTask): { label: string; color: string; softColor: string } {
  switch (task.status) {
    case 'completed':
      return { label: 'Done', color: colors.green, softColor: colors.greenSoft };
    case 'active':
      return { label: 'Running', color: colors.tint, softColor: colors.tintSoft };
    case 'failed':
      return { label: 'Failed', color: colors.red, softColor: colors.redSoft };
    case 'skipped':
      return { label: 'Skipped', color: colors.gray, softColor: colors.graySoft };
    default:
      return { label: 'Pending', color: colors.gray, softColor: colors.graySoft };
  }
}

function JsonWell({ value }: { value: unknown }) {
  return (
    <Card style={styles.groupCard}>
      <Text style={styles.json}>{JSON.stringify(value, null, 2)}</Text>
    </Card>
  );
}

// --- Log -------------------------------------------------------------------

function LogTab({ inspection }: { inspection: EngineInspection | null }) {
  return (
    <View>
      <Text style={[type.subhead, styles.tabIntro]}>
        The engine narrating itself — every tick, claim, delivery, hold, and retry, newest last.
      </Text>
      <Card style={styles.groupCard}>
        {(inspection?.logs ?? []).length === 0 ? (
          <Text style={type.footnote}>Nothing yet.</Text>
        ) : (
          inspection!.logs.map((line, i) => (
            <Text key={i} style={styles.logLine} numberOfLines={2}>
              {line}
            </Text>
          ))
        )}
      </Card>
    </View>
  );
}

// --- Tests -------------------------------------------------------------------

type TestState = 'idle' | 'running' | 'passed' | 'failed';

function TestsTab() {
  const [states, setStates] = useState<Record<string, TestState>>({});
  const [progress, setProgress] = useState<string | null>(null);

  const runOne = useCallback(async (scenarioId: string) => {
    const scenario = scenarios.find(s => s.scenarioId === scenarioId)!;
    setStates(prev => ({ ...prev, [scenarioId]: 'running' }));
    const result = await runScenario(scenario, expoPlatform);
    setStates(prev => ({ ...prev, [scenarioId]: result.status }));
  }, []);

  const runAll = useCallback(async () => {
    let index = 0;
    for (const scenario of scenarios) {
      index += 1;
      setProgress(`Running ${index} of ${scenarios.length}: ${scenario.name}`);
      // Serial on purpose: scenarios own their databases but share the device.
      // eslint-disable-next-line no-await-in-loop
      await runOne(scenario.scenarioId);
    }
    setProgress(null);
  }, [runOne]);

  const passed = Object.values(states).filter(s => s === 'passed').length;

  return (
    <View>
      <Text style={[type.subhead, styles.tabIntro]}>
        The engine’s parity suite: {scenarios.length} production failure scenarios — crashes, connectivity
        loss, duplicate wakes, stale results — each run live against real SQLite on this device.
      </Text>
      <Card style={styles.groupCard}>
        <Button
          testID="run-all"
          label={progress ?? (passed > 0 ? `Run All Again (${passed}/${scenarios.length} passed)` : 'Run All Scenarios')}
          variant="filled"
          onPress={() => void runAll()}
          disabled={progress !== null}
        />
      </Card>
      <Card style={styles.groupCard}>
        {scenarios.map((scenario, i) => {
          const state = states[scenario.scenarioId] ?? 'idle';
          const pill =
            state === 'passed'
              ? { label: 'Pass', color: colors.green, softColor: colors.greenSoft }
              : state === 'failed'
                ? { label: 'Fail', color: colors.red, softColor: colors.redSoft }
                : state === 'running'
                  ? { label: 'Running', color: colors.tint, softColor: colors.tintSoft }
                  : { label: 'Run', color: colors.gray, softColor: colors.graySoft };
          return (
            <ListRow
              key={scenario.scenarioId}
              first={i === 0}
              title={scenario.name}
              subtitle={`Scenario ${scenario.category}`}
              right={<Pill {...pill} />}
              onPress={state === 'running' ? undefined : () => void runOne(scenario.scenarioId)}
            />
          );
        })}
      </Card>
    </View>
  );
}

// --- Styles ------------------------------------------------------------------

const styles = StyleSheet.create({
  sheetBackground: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
  },
  sheetShadow: {
    shadowColor: '#000000',
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: -6 },
    elevation: 12,
  },
  handleIndicator: { backgroundColor: colors.tertiaryLabel, width: 40 },
  dock: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs,
  },
  dockHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  dockTitleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  dot: { width: 9, height: 9, borderRadius: 5 },
  dockPills: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  kpiRow: { flexDirection: 'row', marginTop: spacing.sm, marginBottom: spacing.xxs },
  kpiCell: { flex: 1, alignItems: 'center' },
  kpiValue: { fontSize: 22, fontWeight: '700', color: colors.label },
  kpiLabel: { ...type.caption, marginTop: 1 },

  /** Top padding keeps the tabs fully below the collapsed fold. */
  tabsWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.xl, paddingBottom: spacing.xs },
  pager: { flex: 1, backgroundColor: colors.page },
  page: { flex: 1 },
  sheetContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl },

  groupCard: { marginVertical: 0, paddingVertical: spacing.xxs },
  groupFootnote: { ...type.footnote, marginTop: spacing.xs, marginHorizontal: spacing.md },
  tabIntro: { marginTop: spacing.md, marginBottom: spacing.xs, marginHorizontal: spacing.xxs },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 46,
    paddingVertical: spacing.xs,
  },
  endpointInput: {
    ...type.body,
    minHeight: 46,
    paddingVertical: spacing.xs,
  },

  detailHeader: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.sm, gap: spacing.xs },
  detailHeaderSpacer: { flex: 1 },
  detailTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  actionError: { ...type.footnote, color: colors.red, marginTop: spacing.xs },
  json: { fontFamily: mono, fontSize: 12, lineHeight: 17, color: colors.codeDefault },
  logLine: { fontFamily: mono, fontSize: 11, lineHeight: 16, color: colors.secondaryLabel, marginVertical: 1 },
});
