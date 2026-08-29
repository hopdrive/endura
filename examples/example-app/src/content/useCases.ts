/**
 * The card deck's content: one entry per use case. Each card explains
 * one thing Endura does, shows the code that does it, and offers a
 * button that runs it for real on this device.
 */

import { DemoEngineSession } from '../harness/demoEngine';

export interface UseCaseAction {
  id: string;
  label: string;
  run: (session: DemoEngineSession) => Promise<unknown>;
  variant?: 'filled' | 'gray';
}

export interface UseCase {
  id: string;
  /** Emoji icon shown in the card header chip. */
  icon: string;
  /** Soft background + text tint for the icon chip. */
  tint: string;
  tintSoft: string;
  title: string;
  tagline: string;
  /** Plain-English story — why this matters in a real app. */
  story: string;
  /** Numbered "try it yourself" steps. */
  tryIt: string[];
  codeTitle: string;
  code: string;
  /** Workflow names whose jobs count as "this card's" work. */
  workflows: string[];
  actions: UseCaseAction[];
}

export const useCases: UseCase[] = [
  {
    id: 'welcome',
    icon: '⚡️',
    tint: '#007AFF',
    tintSoft: '#EAF2FF',
    title: 'Meet Endura',
    tagline: 'Durable workflows for React Native',
    story:
      'Every job you create in this app is written to SQLite before anything else happens — the database is the queue. A tiny engine loop then drives each job to completion: it survives offline stretches, app restarts, even force quits. Swipe through these cards to see each guarantee working for real, and pull up the Engine bar below at any time to look inside.',
    tryIt: [
      'Tap the button to queue your first delivery — a real HTTP POST from your phone.',
      'Tap the Engine bar at the bottom and open Jobs to watch it move through the queue.',
      'Check the Setup tab to see every workflow this app registered.',
    ],
    codeTitle: 'the whole idea',
    code: `const sendStatus = defineActivity({
  name: 'status.send',
  retry: { maximumAttempts: 8, initialInterval: 2000 },
  runWhen: rc => rc.isConnected
    ? { ready: true }
    : { ready: false, reason: 'offline', retryInMs: 500 },
  execute: async a => post('/status', a.input),
});

const statusUpdate = defineWorkflow({
  name: 'statusUpdate',
  activities: [sendStatus],
});

client.registerWorkflow(statusUpdate);
await client.start({ tickInterval: 1000 }); // that's it`,
    workflows: ['demo.statusUpdate'],
    actions: [
      { id: 'welcome-send', label: 'Queue a Delivery', run: s => s.queueStatusUpdate(), variant: 'filled' },
    ],
  },
  {
    id: 'thread',
    icon: '🧵',
    tint: '#AF52DE',
    tintSoft: '#F6ECFC',
    title: 'Never Blocks the UI',
    tagline: 'Every activity runs on a worker thread',
    story:
      'Activities execute in a separate JavaScript runtime on their own OS thread. That means activity code can do ANYTHING — hash a file, resize an image, or just burn the CPU with raw math for five straight seconds — and this screen keeps scrolling at full frame rate. To feel what the old single-threaded world was like, the second button runs the exact same math directly on the UI thread: the whole app freezes until it finishes.',
    tryIt: [
      'Tap "Burn 5s on the Worker", then immediately scroll the deck and drag the Engine bar — everything stays smooth.',
      'Open Jobs while it runs to watch the activity working in the background.',
      'Now tap "Burn 3s on the UI Thread" and try to scroll. That freeze is what this branch removes.',
    ],
    codeTitle: 'blocking on purpose',
    code: `const burnCpu = defineActivity({
  name: 'demo.heavy.burn',
  execute: async (a) => {
    const start = Date.now();
    let iterations = 0;
    // No awaits. No yielding. Just math.
    while (Date.now() - start < 5000) {
      spinXorShift(100_000);
      iterations += 100_000;
    }
    return { iterations };
  },
});

// No config needed — ALL activities run
// on the worker. The UI cannot be blocked.`,
    workflows: ['demo.heavyCompute'],
    actions: [
      { id: 'thread-worker', label: 'Burn 5s on the Worker', run: s => s.queueHeavyCompute(5), variant: 'filled' },
      {
        id: 'thread-ui',
        label: 'Burn 3s on the UI Thread',
        run: async () => {
          // The counter-demo: the same loop, run right here on the UI
          // runtime. The app freezes — by design, to show the contrast.
          const start = Date.now();
          let x = 0x2545f491;
          while (Date.now() - start < 3000) {
            x ^= x << 13;
            x ^= x >>> 17;
            x ^= x << 5;
          }
          return x;
        },
        variant: 'gray',
      },
    ],
  },
  {
    id: 'offline',
    icon: '✈️',
    tint: '#FF9500',
    tintSoft: '#FFF3E2',
    title: 'Survives Offline',
    tagline: 'Airplane mode is not an error',
    story:
      'A gated job doesn’t fail while you’re offline — it holds, with zero attempts burned, because runWhen tells the engine the world isn’t ready yet. The moment connectivity returns, everything flushes in order. This demo uses your phone’s real radio: there is no “simulate offline” switch, because your Settings app already has the real one.',
    tryIt: [
      'Turn on Airplane Mode.',
      'Queue a few updates — the Engine bar shows them Held, attempts frozen at 0.',
      'Force-quit the app and reopen it. Still there. The database is the queue.',
      'Turn Airplane Mode off and watch every one of them deliver.',
    ],
    codeTitle: 'the gate',
    code: `runWhen: rc => rc.isConnected
  ? { ready: true }
  : { ready: false,          // hold, don't fail:
      reason: 'offline',     // attempts stay at 0
      retryInMs: 500 }       // check again shortly`,
    workflows: ['demo.statusUpdate'],
    actions: [
      { id: 'offline-send', label: 'Queue an Update', run: s => s.queueStatusUpdate(), variant: 'filled' },
    ],
  },
  {
    id: 'retries',
    icon: '🔁',
    tint: '#30B0C7',
    tintSoft: '#E8F6F9',
    title: 'Retries, Automatically',
    tagline: 'A real server that really fails',
    story:
      'This card sends to httpbin.org/status/500,200 — an endpoint that genuinely returns a server error about half the time. No script, no mock. Watch the engine absorb each failure, back off a little longer each attempt, and keep going until the server behaves. Every attempt is recorded on the job, so you can read the whole struggle afterwards.',
    tryIt: [
      'Send a few — some land first try, some need two, three, five attempts.',
      'Open Jobs in the Engine bar and tap one mid-retry: the attempt history lists every HTTP 500, verbatim.',
      'Backoff doubles per attempt (with jitter), so a struggling server gets breathing room.',
    ],
    codeTitle: 'the policy',
    code: `retry: {
  maximumAttempts: 8,
  initialInterval: 2000,   // 2s, 4s, 8s, ...
  // backoffCoefficient: 2 and 'equal' jitter
  // are the defaults
}`,
    workflows: ['demo.flakyDelivery'],
    actions: [
      { id: 'retries-send', label: 'Send to the Flaky Server', run: s => s.queueFlaky(), variant: 'filled' },
    ],
  },
  {
    id: 'pipeline',
    icon: '🖼️',
    tint: '#5856D6',
    tintSoft: '#EEEEFB',
    title: 'Multi-Step Pipelines',
    tagline: 'Each stage feeds the next',
    story:
      'Real work is rarely one step. This pipeline prepares a photo locally, uploads it, then finalizes it with the server — three activities in one workflow. Each stage’s return value merges into the workflow’s state, so the upload sees the checksum that prepare computed, and finalize sees the remote id the upload got back. If the app dies between stages, it resumes exactly where it left off.',
    tryIt: [
      'Run the pipeline, then quickly open Jobs in the Engine bar.',
      'Tap the job: the pipeline trail shows all three stages ticking off in order.',
      'Look at “accumulated state” — you can see each stage’s contribution merged in.',
    ],
    codeTitle: 'three stages, one workflow',
    code: `defineWorkflow({
  name: 'photoPipeline',
  activities: [prepare, upload, finalize],
});
// prepare returns { checksum, bytes, ... }
// upload reads a.input.checksum,
//   returns { remoteId }
// finalize reads a.input.remoteId`,
    workflows: ['demo.photoPipeline'],
    actions: [
      { id: 'pipeline-run', label: 'Run the Pipeline', run: s => s.runPhotoPipeline(), variant: 'filled' },
    ],
  },
  {
    id: 'app-state',
    icon: '🕗',
    tint: '#34C759',
    tintSoft: '#E9F9EE',
    title: 'Gated by App State',
    tagline: 'runWhen can check anything',
    story:
      'Connectivity is just one gate. runWhen is plain code, so a job can wait on anything your app knows — here, whether the driver is on duty. Off-duty reports hold quietly (no attempts, no errors) and release the instant the state flips. The engine keeps asking the question; your app owns the answer.',
    tryIt: [
      'Go off duty with the switch below, then queue a couple of reports.',
      'Open Jobs — they sit in Held with “driver is off duty” as the reason.',
      'Flip back on duty and watch them all release at once.',
    ],
    codeTitle: 'a business-state gate',
    code: `runWhen: rc => {
  if (!session.isOnDuty())
    return { ready: false,
             reason: 'driver is off duty',
             retryInMs: 1000 };
  return rc.isConnected
    ? { ready: true }
    : { ready: false, reason: 'offline',
        retryInMs: 500 };
}`,
    workflows: ['demo.dutyReport'],
    actions: [
      { id: 'duty-send', label: 'Queue a Duty Report', run: s => s.queueDutyReport(), variant: 'filled' },
    ],
  },
  {
    id: 'priority',
    icon: '🚦',
    tint: '#FF9500',
    tintSoft: '#FFF3E2',
    title: 'Priority Lanes',
    tagline: 'Urgent work jumps the queue',
    story:
      'One tap queues three jobs backwards: a bulk job first, a normal one second, an urgent one last. The engine doesn’t care about arrival order — it always picks the highest-priority due work first, so the urgent job delivers first even though it was queued last. Heavy background work can never starve the important stuff.',
    tryIt: [
      'For the clearest view, turn on Airplane Mode first so the three jobs pile up.',
      'Queue the batch, then open Jobs — all three Held, priorities visible.',
      'Go back online: delivery order is urgent → normal → bulk. Arrival order didn’t matter.',
    ],
    codeTitle: 'a number on the activity',
    code: `defineActivity({
  name: 'lane.urgent.send',
  priority: 90,   // higher runs first
  // ...
});
// bulk uses priority: 10 — it waits
// its turn behind everything else`,
    workflows: ['demo.lane.urgent', 'demo.lane.normal', 'demo.lane.bulk'],
    actions: [
      { id: 'priority-batch', label: 'Queue the Batch (3 jobs)', run: s => s.queuePriorityBatch(), variant: 'filled' },
    ],
  },
  {
    id: 'exactly-once',
    icon: '☝️',
    tint: '#007AFF',
    tintSoft: '#EAF2FF',
    title: 'Exactly Once',
    tagline: 'Mash the button. Go ahead.',
    story:
      'Double-taps, retry buttons, and impatient users create duplicate work. Start a workflow with a uniqueKey and the engine deduplicates at the database: the first start wins, the rest are ignored. This card keys on the current minute — tap as fast as you like and exactly one summary per minute exists.',
    tryIt: [
      'Tap the button five times fast.',
      'Open Jobs — one job. Not five.',
      'Wait for the next minute and tap again: now there’s a second one.',
    ],
    codeTitle: 'dedupe at the source',
    code: `await engine.start(summary, {
  input: { window },
  uniqueKey: \`summary-\${window}\`,
  onConflict: 'ignore',  // duplicate starts
});                      // return the winner`,
    workflows: ['demo.exactlyOnce'],
    actions: [
      { id: 'once-send', label: 'Queue the Summary', run: s => s.queueExactlyOnce(), variant: 'filled' },
    ],
  },
  {
    id: 'dead-letters',
    icon: '📮',
    tint: '#FF3B30',
    tintSoft: '#FFEBEA',
    title: 'When All Else Fails',
    tagline: 'Nothing is ever silently dropped',
    story:
      'This job is doomed on purpose: it posts to an endpoint that always returns HTTP 500, with only three attempts allowed. When the last attempt fails, the job doesn’t vanish — it moves to the dead-letter queue with its full history: every attempt, every error message, the original payload. A human (you) can inspect it and send it back for another try.',
    tryIt: [
      'Send the doomed job and watch it burn through 3 attempts in the Engine bar.',
      'Open Jobs → Dead letters, tap it, and read the three recorded failures.',
      'Tap Retry — it goes back into the queue. (It’s still doomed. That’s the point.)',
    ],
    codeTitle: 'the safety net',
    code: `retry: { maximumAttempts: 3,
         initialInterval: 1500 }
// after the 3rd failure:
//   job -> dead-letter queue
// later, from your admin UI:
await engine.retryFromDeadLetter(id);`,
    workflows: ['demo.doomed'],
    actions: [
      { id: 'doomed-send', label: 'Send the Doomed Job', run: s => s.queueDoomed(), variant: 'filled' },
    ],
  },
];
