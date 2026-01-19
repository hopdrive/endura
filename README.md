![Endura](./assets/logo.png)

# endura

**Durable execution for React Native.** Inspired by [Temporal](https://temporal.io).

Build offline-first workflows that survive app crashes, network failures, and device restarts. Your tasks will endure.

[![npm version](https://badge.fury.io/js/endura.svg)](https://badge.fury.io/js/endura)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/hopdrive/endura/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/hopdrive/endura/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/badge/coverage-84.63%25-brightgreen)](https://github.com/hopdrive/endura)
[![Tests](https://img.shields.io/badge/tests-266%20passed-success)](https://github.com/hopdrive/endura)

---

## Table of Contents

- [Quick Start](#quick-start)
- [Why This Exists](#why-this-exists)
- [Origin Story](#origin-story)
- [Relationship to Temporal](#relationship-to-temporal)
- [Design Philosophy](#design-philosophy)
- [Core Concepts](#core-concepts)
- [API Reference](#api-reference)
- [Activity Configuration](#activity-configuration)
- [State Threading](#state-threading)
- [Execution Semantics](#execution-semantics)
- [Cancellation](#cancellation)
- [Dead Letter Queue](#dead-letter-queue)
- [Storage Backends](#storage-backends)
- [Background Processing](#background-processing)
- [React Hooks & Observability](#react-hooks--observability)
- [Migration Guide](#migration-guide)
- [File Organization](#file-organization)
- [Testing](#testing)
- [Architecture](#architecture)
- [Open Questions](#open-questions)
- [Future Considerations](#future-considerations)
- [References](#references)

---

## Quick Start

### Installation

```bash
npm install endura expo-sqlite
# or
yarn add endura expo-sqlite
```

### Define an Activity

Activities are the building blocks—small, restartable units of work:

```typescript
// activities/uploadPhoto.ts
import { defineActivity, conditions } from 'endura';

export const uploadPhoto = defineActivity({
  name: 'uploadPhoto',
  runWhen: conditions.whenConnected,  // Only run when online
  retry: { maximumAttempts: 5 },
  startToCloseTimeout: 60000,
  execute: async (ctx) => {
    const { uri } = ctx.input;
    const response = await fetch('https://api.example.com/upload', {
      method: 'POST',
      body: createFormData(uri),
      signal: ctx.signal, // Supports cancellation
    });
    return { s3Key: response.key };
  },
});
```

### Define a Workflow

Workflows compose activities into a sequence:

```typescript
// workflows/photo.ts
import { defineWorkflow } from 'endura';
import { capturePhoto, uploadPhoto, notifyServer } from './activities';

export const photoWorkflow = defineWorkflow({
  name: 'photo',
  activities: [capturePhoto, uploadPhoto, notifyServer],

  onComplete: async (runId, finalState) => {
    console.log('Photo synced!', finalState.s3Key);
  },
});
```

### Start the Engine

```typescript
// App.tsx
import { AppState } from 'react-native';
import { SQLiteStorage, ExpoSqliteDriver } from 'endura/storage/sqlite';
import { ExpoWorkflowClient } from 'endura/environmental/expo';
import { openDatabaseAsync } from 'expo-sqlite';
import NetInfo from '@react-native-community/netinfo';
import { photoWorkflow } from './workflows/photo';

// Create storage
const driver = await ExpoSqliteDriver.create('workflow.db', openDatabaseAsync);
const storage = new SQLiteStorage(driver);
await storage.initialize();

// Create client
const client = await ExpoWorkflowClient.create({
  storage,
  environment: {
    getNetworkState: async () => {
      const state = await NetInfo.fetch();
      return state.isConnected ?? false;
    },
  },
});

client.registerWorkflow(photoWorkflow);

// Start a workflow (auto-triggers processing)
const execution = await client.startWorkflow(photoWorkflow, {
  input: { moveId: 123, uri: 'file://photo.jpg' },
});
console.log('Started workflow:', execution.runId);

// Process pending work on app lifecycle events
AppState.addEventListener('change', (state) => {
  if (state === 'active') client.processNow();
});

// Process when network state changes
NetInfo.addEventListener((state) => {
  client.environment.setNetworkState(state.isConnected ?? false);
  if (state.isConnected) client.processNow();
});
```

That's it! The workflow will:
- Persist across app restarts
- Retry failed activities with backoff
- Wait for network before upload activities
- Track progress through each stage

---

## Why This Exists

Mobile applications operating in unreliable network conditions need a way to:

- **Execute multi-step business processes reliably** — A photo upload isn't just "upload a file"—it's capture, process, upload, notify server, and cleanup. If step 3 fails, you don't want to redo steps 1-2.

- **Persist work across app restarts and crashes** — A driver taking delivery photos shouldn't lose work because the app was killed in the background.

- **Handle retries with configurable backoff strategies** — When a network request fails, retry intelligently rather than hammering the server.

- **Defer execution until preconditions are met** — Don't attempt uploads when offline. Wait for WiFi for large files. Respect rate limits.

- **Track progress through complex workflows** — Know exactly which step you're on and what remains.

- **Process work in the background within OS constraints** — iOS and Android limit background execution to ~30 seconds. Work must be structured accordingly.

### Design Goals

1. **Offline-first**: All state persisted locally; network is optional
2. **Durable execution**: Workflows survive app crashes and device restarts
3. **Simple mental model**: Familiar patterns from industry-standard workflow engines
4. **React-friendly**: First-class hooks for UI integration
5. **Minimal footprint**: Lightweight enough for mobile constraints
6. **Storage-agnostic**: Pluggable persistence layer (SQLite for production, InMemory for testing)

---

## Origin Story

This project evolved from real-world experience building offline-first mobile applications at [HopDrive](https://hopdrive.com), a vehicle logistics platform where drivers need to complete deliveries regardless of network conditions.

### The Original: react-native-queue

We started with [billmalarky/react-native-queue](https://github.com/billmalarky/react-native-queue), an excellent Realm-backed job queue library. However, the original was abandoned in 2018 and lacked features critical for our use case.

### The HopDrive Fork

We created and actively maintain [@hopdrive/react-native-queue](https://github.com/hopdrive/react-native-queue), adding several production-critical features:

| Feature | Purpose |
|---------|---------|
| `isJobRunnable` | Conditional execution—don't run network jobs when offline |
| `minimumMillisBetweenAttempts` | Rate limiting—prevent retry storms during flaky connectivity |
| `onSkipped` callback | Observability—know why jobs aren't running |
| `failureBehavior: 'custom'` | Flexible retry logic beyond simple attempt counts |
| Lifespan-based execution | Background task support within OS time limits |

### The Pipeline Pattern

On top of the queue, we built a "pipeline" pattern for multi-stage workflows:

```typescript
// Old HopDrive pattern
const photoPipeline = {
  name: 'photo.pipeline',
  sequence: [PhotoCapture, PhotoPending, PhotoUpload, PhotoSave],
};

// Starting a pipeline created an "Event" record and enqueued the first job
await startPhotoPipeline({ payload: { moveId, uri } });

// Each worker called completeStage() to advance
export const worker = async (id, payload) => {
  await doWork(payload);
  await EventUtils.completeStage(pipeline, payload.eventId, { result });
};
```

This worked well but had problems:

1. **Confusing terminology** — "Events" weren't events (immutable facts), they were mutable execution records. "Pipelines" suggested data transformation rather than workflows.

2. **Manual stage advancement** — Every worker had to remember to call `completeStage()`. Miss it and your workflow stalled silently.

3. **Tight coupling to Realm** — The Event tracking system was hardcoded to Realm, making migration difficult as Realm's maintenance status became uncertain.

4. **Application-layer complexity** — The pipeline logic lived in our app, not a reusable library. Every new pipeline required boilerplate.

### Why We Built This

We needed to:

1. **Migrate from Realm to SQLite** — Realm's future is uncertain; SQLite is well-supported and provides ACID transactions for crash safety.

2. **Align with industry standards** — Borrowing terminology and patterns from industry-standard workflow engines means developers can transfer knowledge.

3. **Extract the pattern into a library** — What we built was useful. Others face the same challenges.

4. **Simplify the mental model** — Automatic stage advancement, clear terminology, explicit state threading.

### What Changed

| Old (HopDrive App) | New (This Library) | Why |
|--------------------|-------------------|-----|
| Pipeline | Workflow | Industry-standard term for business process |
| Event | WorkflowExecution | Events should be immutable; executions are mutable |
| eventId | runId | Industry-standard terminology |
| Job | ActivityTask (internal) | Users don't interact with internal task records |
| Worker | Activity | Industry-standard terminology; cleaner separation |
| `completeStage()` | *(automatic)* | Less error-prone; activities just return results |

---

## Relationship to Temporal

This system is inspired by [Temporal's](https://temporal.io) conceptual model but simplified for mobile constraints. If you know Temporal, you'll feel at home. If you don't, that's fine—the concepts stand on their own.

### Terminology Mapping

| This System | Temporal Equivalent | Notes |
|-------------|---------------------|-------|
| Workflow | Workflow | Exact match |
| WorkflowExecution | Workflow Execution | Exact match |
| Activity | Activity | Exact match |
| ActivityOptions | Activity Options | Exact match |
| runId | Run ID | Exact match |
| uniqueKey | Workflow ID | Similar deduplication purpose |
| runWhen | *(no equivalent)* | Mobile-specific for offline/conditions |
| WorkflowEngine | Worker + Client | Combined since single-process on mobile |

### Features We Intentionally Omit

Temporal is a powerful distributed system. We're building for mobile, which has different constraints:

- **Signals** — Send data to a running workflow from outside. On mobile, you can just pass data through the next activity.

- **Queries** — Read workflow state without affecting it. Use React hooks to observe state instead.

- **Child Workflows** — Workflows spawning sub-workflows. Keep it simple; compose at the activity level.

- **Continue-As-New** — Long-running workflow pagination. Mobile workflows are typically short-lived.

- **Deterministic Replay** — Temporal's core durability mechanism. We use simpler crash recovery (re-run interrupted activities).

- **Versioning** — Handling workflow definition changes mid-execution. Not implementing in v1.

- **Task Queues** — Routing/load-balancing across workers. Single-process on mobile.

### The Key Insight

We take a simpler approach: **activities are small, idempotent, and restartable**. If an activity crashes, restart it from the beginning. This works because we design activities to be safe to re-run.

---

## Design Philosophy

### Small, Idempotent, Restartable Activities

The fundamental principle is that **activities should be the smallest unit of work that can be safely retried**.

When an activity is interrupted (app crash, device reboot, user force-quit), the system has two choices:
1. Resume from where it left off (requires checkpointing)
2. Restart the activity from the beginning

This system chooses **restart from the beginning**. This is simpler, more predictable, and avoids complex state management. But it only works if activities are designed correctly.

### Activity Design Guidelines

**DO: Break work into small, atomic activities**

```typescript
// Good: Each step is its own activity
const photoWorkflow = defineWorkflow({
  name: 'photo',
  activities: [
    preparePhoto,      // Validate, generate metadata
    uploadPhoto,       // Upload to S3
    notifyServer,      // Tell backend about the upload
    cleanupLocal,      // Delete local file
  ],
});
```

**DON'T: Combine non-idempotent operations**

```typescript
// Bad: If this crashes after charging but before saving receipt,
// restarting will charge the card again!
execute: async (ctx) => {
  await chargeCard(ctx.input.amount);      // Side effect!
  await saveReceipt(ctx.input.orderId);    // If we crash here...
  return { charged: true };
}
```

**DO: Design for idempotency**

```typescript
// Good: Check if already done, use idempotency keys
execute: async (ctx) => {
  const { orderId, idempotencyKey } = ctx.input;

  // Check if already charged
  const existing = await getCharge(orderId);
  if (existing) return { chargeId: existing.id };

  // Charge with idempotency key (Stripe will dedupe)
  const charge = await stripe.charges.create({
    amount: ctx.input.amount,
    idempotency_key: idempotencyKey,
  });

  return { chargeId: charge.id };
}
```

### The Checkpoint Test

Ask yourself: "If this activity crashes at any line and restarts from the beginning, what happens?"

- ✅ **Safe**: Re-uploading the same file to S3 (overwrites with same content)
- ✅ **Safe**: Re-sending an API request with an idempotency key
- ✅ **Safe**: Re-reading data and re-computing a result
- ❌ **Unsafe**: Incrementing a counter without checking current value
- ❌ **Unsafe**: Sending a notification without checking if already sent
- ❌ **Unsafe**: Any mutation without idempotency protection

### When You Need Checkpoints

If you find yourself wanting mid-activity checkpoints, that's a signal to split into multiple activities:

```typescript
// Before: One big activity with implicit checkpoints
execute: async (ctx) => {
  const processed = await processImages(ctx.input.images);  // 30 seconds
  // "checkpoint" - what if we crash here?
  const uploaded = await uploadAll(processed);               // 60 seconds
  // "checkpoint" - what if we crash here?
  await notifyServer(uploaded);                              // 5 seconds
}

// After: Three activities, each restartable
const processImages = defineActivity({ /* ... */ });   // Can restart safely
const uploadImages = defineActivity({ /* ... */ });    // Can restart safely
const notifyServer = defineActivity({ /* ... */ });    // Can restart safely
```

### Crash Recovery Behavior

When the engine starts, it checks for activities left in `active` status (indicating a crash during execution):

```typescript
// On engine startup
const abandonedActivities = await storage.getActivitiesByStatus('active');
for (const activity of abandonedActivities) {
  // Reset to pending - will be picked up and restarted
  activity.status = 'pending';
  activity.attempts += 1;  // Count the crashed attempt
  await storage.saveActivity(activity);
}
```

This is safe **only if activities follow the design guidelines above**.

---

## Core Concepts

### Workflows

A **Workflow** is a definition—a blueprint for a business process. It specifies a unique name, an ordered sequence of activities, and optional lifecycle callbacks.

```typescript
interface Workflow<TInput = any> {
  name: string;
  activities: Activity[];
  onComplete?: (runId: string, finalState: object) => Promise<void>;
  onFailed?: (runId: string, state: object, error: Error) => Promise<void>;
  onCancelled?: (runId: string, state: object) => Promise<void>;
}
```

A workflow definition is **static**—it doesn't change at runtime. Think of it like a class definition.

```typescript
const photoWorkflow = defineWorkflow({
  name: 'photo',
  activities: [capturePhoto, uploadPhoto, notifyServer],

  onComplete: async (runId, finalState) => {
    console.log(`Photo workflow ${runId} completed`);
  },

  onFailed: async (runId, state, error) => {
    await notifyUserOfFailure(state.moveId);
  },
});
```

### WorkflowExecutions

A **WorkflowExecution** is an instance—a specific execution of a workflow. It tracks current position in the activity sequence, accumulated state, status, and timestamps.

```typescript
interface WorkflowExecution {
  runId: string;                     // Unique identifier
  workflowName: string;              // References workflow definition
  uniqueKey?: string;                // Optional deduplication key
  currentActivityIndex: number;      // Position in activity sequence
  currentActivityName: string;       // Name of current/next activity
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  input: object;                     // Original input when started
  state: object;                     // Accumulated state
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  error?: string;
  failedActivityName?: string;
}
```

A workflow execution is **mutable**—it changes as activities complete. Think of it like a class instance.

### Activities

An **Activity** is a function definition that does actual work. Activities are pure async functions that receive input and return output, configured with options for timeout, retry, and conditions, and independently testable with no framework dependencies.

```typescript
interface Activity<TInput = any, TOutput = any> {
  name: string;
  execute: (ctx: ActivityContext<TInput>) => Promise<TOutput>;
  options?: ActivityOptions;
}
```

```typescript
const uploadPhoto = defineActivity({
  name: 'uploadPhoto',

  startToCloseTimeout: 60000,
  retry: { maximumAttempts: 10 },
  runWhen: conditions.whenConnected,
  execute: async (ctx) => {
    const { uri, hash } = ctx.input;
    const response = await uploadToS3(uri, { signal: ctx.signal });
    return { s3Key: response.key, uploadedAt: Date.now() };
  },
});
```

### ActivityTasks (Internal)

An **ActivityTask** is a persisted record representing a scheduled activity execution. Users don't interact with these directly—they're internal to the engine.

```typescript
interface ActivityTask {
  taskId: string;
  runId: string;
  activityName: string;
  status: 'pending' | 'active' | 'completed' | 'failed' | 'skipped';
  input: object;
  result?: object;
  priority: number;
  attempts: number;
  maxAttempts: number;
  timeout: number;
  createdAt: number;
  scheduledFor?: number;      // For backoff delays
  startedAt?: number;
  lastAttemptAt?: number;
  completedAt?: number;
  error?: string;
  errorStack?: string;
}
```

### Terminology Reference

| Term | Description |
|------|-------------|
| **Workflow** | A defined sequence of activities representing a business process |
| **WorkflowExecution** | A single execution instance of a workflow |
| **Activity** | A unit of work—a function that does something (upload, sync, notify) |
| **ActivityTask** | A persisted record of an activity to be executed (internal) |
| **ActivityOptions** | Configuration for an activity (timeout, retry, conditions) |
| **runId** | Unique identifier for a workflow execution |
| **uniqueKey** | Optional deduplication key to prevent concurrent duplicate workflows |

---

## API Reference

### ExpoWorkflowClient (Recommended for Expo Apps)

The main entry point for Expo applications. Combines the workflow engine with Expo-specific runtime adapters:

```typescript
import { SQLiteStorage, ExpoSqliteDriver } from 'endura/storage/sqlite';
import { ExpoWorkflowClient } from 'endura/environmental/expo';
import { openDatabaseAsync } from 'expo-sqlite';
import NetInfo from '@react-native-community/netinfo';

// Create storage (SQLite, Realm, or any Storage implementation)
const driver = await ExpoSqliteDriver.create('workflow.db', openDatabaseAsync);
const storage = new SQLiteStorage(driver);
await storage.initialize();

// Initialize the client
const client = await ExpoWorkflowClient.create({
  storage,

  environment: {
    getNetworkState: async () => {
      const state = await NetInfo.fetch();
      return state.isConnected ?? false;
    },
    // Optional: getBatteryLevel for battery-aware workflows
  },

  // Optional event handlers
  onEvent: (event) => {
    console.log('Workflow event:', event.type);
  },
});
```

### WorkflowEngine (Advanced Usage)

For non-Expo apps or custom configurations, you can use the engine directly:

```typescript
import { WorkflowEngine } from 'endura';
import { SQLiteStorage, ExpoSqliteDriver } from 'endura/storage/sqlite';
import { openDatabaseAsync } from 'expo-sqlite';

// Create SQLite storage
const driver = await ExpoSqliteDriver.create('workflow.db', openDatabaseAsync);
const storage = new SQLiteStorage(driver);
await storage.initialize();

// Initialize the engine
const engine = await WorkflowEngine.create({
  storage,
  // ... other options
});

// Register workflows (typically at app startup)
engine.registerWorkflow(photoWorkflow);
engine.registerWorkflow(driverStatusSyncWorkflow);

// Start a workflow execution
const execution = await engine.start(photoWorkflow, {
  input: { moveId: 123, uri: 'file://photo.jpg' },
});

// Start with uniqueness constraint (deduplication)
const execution = await engine.start(driverStatusSyncWorkflow, {
  input: { driverId: 456 },
  uniqueKey: `driver-sync:${driverId}`,
});

// Handle uniqueness conflicts
try {
  await engine.start(workflow, { input, uniqueKey });
} catch (err) {
  if (err instanceof UniqueConstraintError) {
    console.log('Sync already in progress:', err.existingRunId);
  }
}

// Or ignore conflicts (return existing execution)
const execution = await engine.start(workflow, {
  input,
  uniqueKey,
  onConflict: 'ignore',  // Returns existing execution instead of throwing
});

// Query executions
const execution = await engine.getExecution(runId);
const running = await engine.getExecutionsByStatus('running');

// Control execution
await engine.cancelExecution(runId);

// Event-driven processing (no always-on loops)
await client.processNow();                 // Process until queue is empty
await client.processNow({ timeout: 5000 }); // Process with timeout
await client.processForDuration(25000);    // Process for bounded time (background tasks)
const hasPending = await client.hasPendingWork(); // Check if work exists
engine.stop();                             // Stop any in-progress processing

// Dead letter queue
const deadLetters = await engine.getDeadLetters();
const unacked = await engine.getUnacknowledgedDeadLetters();
await engine.acknowledgeDeadLetter(id);
await engine.purgeDeadLetters({ olderThanMs: 7 * 24 * 60 * 60 * 1000 });
```

### defineWorkflow

Create a workflow definition:

```typescript
import { defineWorkflow } from 'endura';

export const photoWorkflow = defineWorkflow<PhotoWorkflowInput>({
  name: 'photo',

  activities: [capturePhoto, uploadPhoto, notifyServer],

  onComplete: async (runId, finalState) => {
    console.log(`Workflow ${runId} completed with state:`, finalState);
  },

  onFailed: async (runId, state, error) => {
    console.error(`Workflow ${runId} failed:`, error.message);
  },

  onCancelled: async (runId, state) => {
    console.log(`Workflow ${runId} cancelled`);
  },
});

interface PhotoWorkflowInput {
  moveId: number;
  uri: string;
  workflowType?: string;
}
```

### defineActivity

Create an activity definition:

```typescript
import { defineActivity } from 'endura';

export const uploadPhoto = defineActivity<UploadInput, UploadOutput>({
  name: 'uploadPhoto',
  startToCloseTimeout: 60000,
  retry: {
    maximumAttempts: 10,
    initialInterval: 5000,
    backoffCoefficient: 2,
    maximumInterval: 60000,
  },
  priority: 50,
  runWhen: conditions.whenConnected,

  // Lifecycle callbacks
  onStart: async (taskId, input) => { },
  onSuccess: async (taskId, input, result) => { },
  onFailure: async (taskId, input, error, attempt) => { },
  onFailed: async (taskId, input, error) => { },
  onSkipped: async (taskId, input, reason) => { },

  execute: async (ctx) => {
    const { uri, hash } = ctx.input;
    const response = await uploadToS3(uri, { signal: ctx.signal });
    return { s3Key: response.key, uploadedAt: Date.now() };
  },
});

interface UploadInput {
  uri: string;
  hash: string;
}

interface UploadOutput {
  s3Key: string;
  uploadedAt: number;
}
```

### ActivityContext

The context object passed to activity execute functions:

```typescript
interface ActivityContext<TInput = any> {
  // Identity
  runId: string;                    // Workflow execution ID
  taskId: string;                   // This activity task's ID
  attempt: number;                  // Current attempt number (1-based)

  // Data
  input: TInput;                    // Accumulated workflow state

  // Cancellation
  signal: AbortSignal;              // Fires on cancel or timeout

  // Runtime context (from engine configuration)
  isConnected: boolean;
  batteryLevel?: number;
  [key: string]: any;               // App-specific values

  // Utilities
  log: (...args: any[]) => void;    // Contextual logging
}
```

---

## Activity Configuration

### ActivityOptions Reference

```typescript
interface ActivityOptions {
  // === TIMEOUTS ===
  startToCloseTimeout?: number;     // Ms before activity times out (default: 25000)

  // === RETRY POLICY ===
  retry?: {
    maximumAttempts?: number;       // Max attempts before failing (default: 1)
    initialInterval?: number;       // First retry delay in ms (default: 1000)
    backoffCoefficient?: number;    // Multiplier for each retry (default: 2)
    maximumInterval?: number;       // Cap on retry delay (default: none)
  };

  // === PRIORITY ===
  priority?: number;                // Higher = processed first (default: 0)

  // === CONDITIONAL EXECUTION ===
  runWhen?: RunCondition | ((ctx: RuntimeContext) => RunConditionResult);

  // === LIFECYCLE CALLBACKS ===
  onStart?: (taskId: string, input: object) => Promise<void>;
  onSuccess?: (taskId: string, input: object, result: object) => Promise<void>;
  onFailure?: (taskId: string, input: object, error: Error, attempt: number) => Promise<void>;
  onFailed?: (taskId: string, input: object, error: Error) => Promise<void>;
  onSkipped?: (taskId: string, input: object, reason: string) => Promise<void>;
}

interface RunConditionResult {
  ready: boolean;
  reason?: string;                  // Passed to onSkipped if not ready
  retryInMs?: number;               // Hint for when to check again
}
```

### Built-in Conditions

```typescript
import { conditions } from 'endura';

// Simple conditions
conditions.always                   // Always ready (default)
conditions.whenConnected            // Ready when ctx.isConnected === true
conditions.whenDisconnected         // Ready when offline (for offline-only work)

// Time-based
conditions.afterDelay(ms)           // Ready after activity pending for N ms

// Combinators
conditions.all(cond1, cond2)        // Ready when ALL conditions are ready
conditions.any(cond1, cond2)        // Ready when ANY condition is ready
conditions.not(cond)                // Inverts a condition
```

### Configuration Examples

**Network-Dependent Activity:**

```typescript
defineActivity({
  name: 'syncToServer',
  startToCloseTimeout: 30000,
  retry: {
    maximumAttempts: 10,
    initialInterval: 5000,
    backoffCoefficient: 2,
    maximumInterval: 60000,
  },
  runWhen: conditions.whenConnected,
  execute: async (ctx) => { /* ... */ },
});
```

**Time-Delayed Activity:**

```typescript
defineActivity({
  name: 'delayedCleanup',
  runWhen: conditions.afterDelay(30000),  // Wait 30 seconds
  execute: async (ctx) => { /* ... */ },
});
```

**Custom Conditional Logic:**

```typescript
defineActivity({
  name: 'batteryAwareSync',
  runWhen: (ctx) => {
    if (!ctx.isConnected) {
      return { ready: false, reason: 'No network' };
    }
    if (ctx.batteryLevel < 0.2 && !ctx.input.urgent) {
      return { ready: false, reason: 'Battery low, deferring non-urgent work' };
    }
    return { ready: true };
  },
  execute: async (ctx) => { /* ... */ },
});
```

**Combined Conditions:**

```typescript
defineActivity({
  name: 'delayedSync',
  runWhen: conditions.all(
    conditions.whenConnected,
    conditions.afterDelay(5000)
  ),
  execute: async (ctx) => { /* ... */ },
});
```

---

## State Threading

Activities receive accumulated state and return additions to it. This is how data flows through a workflow.

```mermaid
sequenceDiagram
    participant Engine
    participant Act1 as CapturePhoto
    participant Act2 as UploadPhoto
    participant State as Workflow State

    Note over Engine, State: Initial Input: { moveId: 123, uri: 'file://img.jpg' }

    Engine->>Act1: Execute(Input)
    activate Act1
    Act1-->>Engine: Return { hash: 'abc-123' }
    deactivate Act1

    Engine->>State: Shallow Merge Result
    Note over State: State: { moveId: 123, uri: '...', hash: 'abc-123' }

    Engine->>Act2: Execute(State)
    activate Act2
    Act2-->>Engine: Return { s3Key: 'key-xyz' }
    deactivate Act2

    Engine->>State: Shallow Merge Result
    Note over State: Final State: { moveId: 123, ... , s3Key: 'key-xyz' }

    Engine->>Engine: Check for next activity...
```

### How State Flows

```typescript
// Starting workflow
await engine.start(photoWorkflow, {
  input: { moveId: 123, uri: 'file://photo.jpg' },
});

// Initial state = input
// { moveId: 123, uri: 'file://photo.jpg' }
```

```typescript
// Activity 1: capturePhoto
execute: async (ctx) => {
  const { uri } = ctx.input;  // { moveId: 123, uri: '...' }
  const hash = await generateHash(uri);
  return { hash };  // Added to state
}

// State after: { moveId: 123, uri: '...', hash: 'abc123' }
```

```typescript
// Activity 2: uploadPhoto
execute: async (ctx) => {
  const { uri, hash } = ctx.input;  // { moveId: 123, uri: '...', hash: 'abc123' }
  const s3Key = await upload(uri);
  return { s3Key, uploadedAt: Date.now() };  // Added to state
}

// State after: { moveId: 123, uri: '...', hash: 'abc123', s3Key: '...', uploadedAt: ... }
```

```typescript
// Activity 3: notifyServer
execute: async (ctx) => {
  const { moveId, s3Key } = ctx.input;  // Full accumulated state
  await api.post(`/moves/${moveId}/photos`, { s3Key });
  // No return - nothing to add
}

// Final state: { moveId: 123, uri: '...', hash: 'abc123', s3Key: '...', uploadedAt: ... }
```

### State Merge Behavior

- Activity return values are **shallow merged** into state
- Return `undefined` or nothing to add nothing
- Later activities can overwrite earlier values (same key)
- Original input is preserved in `execution.input`
- Accumulated state lives in `execution.state`

---

## Execution Semantics

### Activity Task Lifecycle


```mermaid
stateDiagram-v2
    [*] --> PENDING

    PENDING --> ACTIVE: Engine picks up task
    PENDING --> SKIPPED: runWhen == false
    PENDING --> CANCELLED: Workflow Cancelled

    state ACTIVE {
        [*] --> Executing
        Executing --> Timeout: Limit Exceeded
        Executing --> Error: Exception Thrown
        Executing --> Success: Function Returns
    }

    SKIPPED --> PENDING: Retry Timer Elapsed
    SKIPPED --> FAILED: Max Skips Exceeded

    ACTIVE --> COMPLETED: Success
    ACTIVE --> PENDING: Error/Timeout (Retries > 0)
    ACTIVE --> FAILED: Error/Timeout (Retries == 0)
    ACTIVE --> CANCELLED: Signal Aborted

    FAILED --> [*]: Moved to Dead Letter Queue
    COMPLETED --> [*]: Next Activity Scheduled
    CANCELLED --> [*]
```

### State Transitions

| From | To | Trigger |
|------|-----|---------|
| PENDING | ACTIVE | Activity claimed by executor |
| PENDING | SKIPPED | `runWhen` returned false |
| PENDING | CANCELLED | Workflow cancelled |
| ACTIVE | COMPLETED | `execute()` returned successfully |
| ACTIVE | PENDING | `execute()` threw error, retries remaining |
| ACTIVE | FAILED | `execute()` threw error, no retries remaining |
| ACTIVE | FAILED | Timeout exceeded |
| ACTIVE | CANCELLED | Workflow cancelled (signal aborted) |
| SKIPPED | PENDING | Retry timer elapsed |
| SKIPPED | FAILED | Max skip attempts exceeded |

### Workflow Execution Lifecycle

```mermaid
stateDiagram-v2
    [*] --> RUNNING
    RUNNING --> COMPLETED
    RUNNING --> CANCELLED
    RUNNING --> FAILED
    COMPLETED --> [*]
    CANCELLED --> [*]
    FAILED --> [*]
```

### Automatic Activity Advancement

When an activity completes successfully, the engine automatically advances to the next activity:

```typescript
async function onActivityCompleted(task: ActivityTask, result: object) {
  const execution = await storage.getExecution(task.runId);
  const workflow = workflowRegistry.get(execution.workflowName);

  // Merge activity result into workflow state
  const newState = { ...execution.state, ...result };

  // Check if this was the last activity
  const nextIndex = execution.currentActivityIndex + 1;
  const isComplete = nextIndex >= workflow.activities.length;

  if (isComplete) {
    // Mark workflow as completed
    await storage.saveExecution({
      ...execution,
      state: newState,
      status: 'completed',
      completedAt: Date.now(),
    });

    // Release uniqueness constraint
    if (execution.uniqueKey) {
      await storage.deleteUniqueKey(execution.workflowName, execution.uniqueKey);
    }

    // Invoke completion callback
    await workflow.onComplete?.(execution.runId, newState);
  } else {
    // Schedule next activity
    const nextActivity = workflow.activities[nextIndex];

    await storage.saveExecution({
      ...execution,
      state: newState,
      currentActivityIndex: nextIndex,
      currentActivityName: nextActivity.name,
    });

    await scheduleActivityTask({
      runId: execution.runId,
      activityName: nextActivity.name,
      input: newState,
      options: nextActivity.options,
    });
  }
}
```

---

## Cancellation

### Cancelling a Workflow

```typescript
await engine.cancelExecution(runId);
```

This triggers:

1. **WorkflowExecution** status set to `cancelled`
2. **Active activities** receive abort signal, status set to `cancelled`
3. **Pending activities** for this execution are removed
4. **Uniqueness key** (if any) is released
5. **onCancelled** callback invoked

### Handling Cancellation in Activities

The `signal` in ActivityContext is an `AbortSignal` that fires when the workflow is cancelled or the activity times out:

```typescript
execute: async (ctx) => {
  const { signal, input } = ctx;

  // Option 1: Pass signal to fetch (automatic abort)
  const response = await fetch(url, { signal });

  // Option 2: Check signal manually for long operations
  for (const item of input.items) {
    if (signal.aborted) {
      throw new Error('Activity cancelled');
    }
    await processItem(item);
  }

  // Option 3: Listen for abort event
  signal.addEventListener('abort', () => {
    cleanup();
  });
}
```

### Cancellation Guarantees

- **Best-effort**: If an activity is mid-execution, it may complete before seeing the abort signal
- **No rollback**: Completed activities are not undone; design activities to be idempotent
- **Immediate for pending**: Pending activities are removed without execution

---

## Dead Letter Queue

When an activity permanently fails (exhausts all retries), it's moved to the dead letter queue for inspection and potential manual intervention.

### Dead Letter Record Schema

```typescript
interface DeadLetterRecord {
  id: string;
  runId: string;                    // Original workflow execution
  taskId: string;                   // Failed activity task
  activityName: string;
  workflowName: string;
  input: object;                    // Activity input at time of failure
  error: string;                    // Final error message
  errorStack?: string;
  attempts: number;                 // How many attempts were made
  failedAt: number;                 // Timestamp of final failure
  acknowledged: boolean;            // Has this been reviewed/handled?
}
```

### Dead Letter API

```typescript
// Get all dead letters
const deadLetters = await engine.getDeadLetters();

// Get unacknowledged dead letters (not yet reviewed)
const unacked = await engine.getUnacknowledgedDeadLetters();

// Acknowledge after reviewing/handling
await engine.acknowledgeDeadLetter(id);

// Purge old acknowledged dead letters
await engine.purgeDeadLetters({
  olderThanMs: 7 * 24 * 60 * 60 * 1000,  // 7 days
  acknowledgedOnly: true,
});
```

### Automatic Cleanup

Configure automatic cleanup when creating the engine:

```typescript
// Cleanup is handled automatically via CleanupConfig when creating the engine:
const engine = await WorkflowEngine.create({
  storage,
  clock,
  scheduler,
  environment,
  cleanup: {
    onStart: true,  // Run cleanup on engine start
    completedExecutionRetention: 24 * 60 * 60 * 1000,    // 24 hours
    deadLetterRetention: 7 * 24 * 60 * 60 * 1000,        // 7 days
    onExecutionPurged: async (execution) => {
      console.log(`Purged execution ${execution.runId}`);
    },
    onDeadLetterPurged: async (record) => {
      console.log(`Purged dead letter ${record.id}`);
    },
  },
});

// Or manually purge dead letters:
await engine.purgeDeadLetters({
  olderThanMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  acknowledgedOnly: true,
});
```

---

## Storage Backends

### Storage Adapter Interface

The engine uses a pluggable storage backend. Implement this interface for custom storage:

```typescript
interface StorageAdapter {
  // Workflow Executions
  saveExecution(execution: WorkflowExecution): Promise<void>;
  getExecution(runId: string): Promise<WorkflowExecution | null>;
  getExecutionsByStatus(status: WorkflowExecutionStatus): Promise<WorkflowExecution[]>;
  deleteExecution(runId: string): Promise<void>;

  // Uniqueness
  setUniqueKey(workflowName: string, key: string, runId: string): Promise<boolean>;
  getUniqueKey(workflowName: string, key: string): Promise<string | null>;
  deleteUniqueKey(workflowName: string, key: string): Promise<void>;

  // Activity Tasks
  saveActivityTask(task: ActivityTask): Promise<void>;
  getActivityTask(taskId: string): Promise<ActivityTask | null>;
  getActivityTasksForExecution(runId: string): Promise<ActivityTask[]>;
  getActivityTasksByStatus(status: ActivityTaskStatus): Promise<ActivityTask[]>;
  deleteActivityTask(taskId: string): Promise<void>;

  // Queue Operations
  getPendingActivityTasks(options?: { limit?: number }): Promise<ActivityTask[]>;
  claimActivityTask(taskId: string): Promise<ActivityTask | null>;

  // Dead Letter Queue
  saveDeadLetter(record: DeadLetterRecord): Promise<void>;
  getDeadLetters(): Promise<DeadLetterRecord[]>;
  getUnacknowledgedDeadLetters(): Promise<DeadLetterRecord[]>;
  acknowledgeDeadLetter(id: string): Promise<void>;
  deleteDeadLetter(id: string): Promise<void>;

  // Maintenance
  purgeExecutions(options: { olderThanMs: number; status: WorkflowExecutionStatus[] }): Promise<number>;
  purgeDeadLetters(options: { olderThanMs: number; acknowledgedOnly?: boolean }): Promise<number>;

  // Reactivity (optional)
  subscribe?(callback: (change: StorageChange) => void): () => void;
}
```

### SQLite Storage (Production)

SQLite is the production storage backend, providing ACID transactions and efficient querying:

```typescript
import { SQLiteStorage, ExpoSqliteDriver } from 'endura/storage/sqlite';
import { openDatabaseAsync } from 'expo-sqlite';

const driver = await ExpoSqliteDriver.create('workflow.db', openDatabaseAsync);
const storage = new SQLiteStorage(driver);
await storage.initialize();
```

**Database Schema:**

The SQLite adapter creates tables for:
- `executions` - WorkflowExecution records
- `activity_tasks` - ActivityTask records
- `dead_letters` - DeadLetterRecord records
- `schema_meta` - Schema version tracking

All data is stored relationally with proper indexes for efficient queries.

### InMemory Storage (Testing)

For unit tests and development, use the in-memory storage adapter:

```typescript
import { WorkflowEngine } from 'endura';
import { InMemoryStorage } from 'endura/storage/memory';

const storage = new InMemoryStorage();
const engine = await WorkflowEngine.create({
  storage,
  // ... other options
});
```

### Storage Backend Comparison

| Feature | SQLite (Production) | InMemory (Testing) |
|---------|-------------------|-------------------|
| Setup complexity | Medium | Low |
| Query flexibility | High (SQL) | Low (in-memory) |
| Reactivity | Manual (via hooks) | Manual (via hooks) |
| Atomic transactions | Yes | N/A |
| Performance (simple ops) | Good | Excellent |
| Performance (complex queries) | Excellent | N/A |
| Persistence | Yes | No (in-memory only) |
| Bundle size impact | Medium | Minimal |
| Use case | Production apps | Unit tests |

### Choosing a Backend

**Use SQLite for production:**
- ACID transactions for crash safety
- Efficient queries for large datasets
- Relational structure suits workflow data
- Well-supported and actively maintained

**Use InMemoryStorage for testing:**
- Fast and simple for unit tests
- No persistence (clean slate each test)
- No external dependencies

---

## Background Processing

```mermaid
erDiagram
    WORKFLOW_EXECUTION ||--|{ ACTIVITY_TASK : contains
    WORKFLOW_EXECUTION {
        string runId PK
        string status
        int currentActivityIndex
        json state "Accumulated State"
    }
    ACTIVITY_TASK {
        string taskId PK
        string runId FK
        string status
        int attempts
        string error
    }
    DEAD_LETTER ||--|| ACTIVITY_TASK : records_failure
    DEAD_LETTER {
        string id PK
        string originalRunId
        json finalError
        boolean acknowledged
    }
```

### Integration with OS Background Systems

iOS and Android limit background execution to approximately 30 seconds. The engine supports lifespan-aware execution:

```typescript
// background.ts
import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';
import { SQLiteStorage, ExpoSqliteDriver } from 'endura/storage/sqlite';
import { ExpoWorkflowClient } from 'endura/environmental/expo';
import { openDatabaseAsync } from 'expo-sqlite';
import { photoWorkflow, driverStatusSyncWorkflow } from './workflows';

const BACKGROUND_TASK_NAME = 'WORKFLOW_ENGINE_BACKGROUND';

TaskManager.defineTask(BACKGROUND_TASK_NAME, async () => {
  console.log('Background task starting...');

  try {
    // Create storage
    const driver = await ExpoSqliteDriver.create('workflow.db', openDatabaseAsync);
    const storage = new SQLiteStorage(driver);
    await storage.initialize();

    const client = await ExpoWorkflowClient.create({
      storage,
      environment: {
        getNetworkState: async () => {
          // Get network state in background
          const state = await NetInfo.fetch();
          return state.isConnected ?? false;
        },
      },
    });

    // Re-register all workflows (required in background context)
    client.registerWorkflow(photoWorkflow);
    client.registerWorkflow(driverStatusSyncWorkflow);

    // Process for bounded time (OS limit ~30s, leave buffer)
    const result = await client.processForDuration(25000);

    return result.processed > 0
      ? BackgroundFetch.BackgroundFetchResult.NewData
      : BackgroundFetch.BackgroundFetchResult.NoData;
  } catch (error) {
    console.error('Background task failed:', error);
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

export async function registerBackgroundProcessing() {
  await BackgroundFetch.registerTaskAsync(BACKGROUND_TASK_NAME, {
    minimumInterval: 60 * 15,       // Every 15 minutes
    stopOnTerminate: false,         // Keep running after app termination (Android)
    startOnBoot: true,              // Start on device boot (Android)
  });
}
```

### Event-Driven Processing

The workflow client uses **event-driven processing** with no always-on background loops:

```typescript
// Process until queue is empty
const result = await client.processNow();

// Process with timeout
const result = await client.processNow({ timeout: 5000 });

// Process for bounded duration (for background tasks)
const result = await client.processForDuration(25000);

// Returns: { processed: number, reason: 'queue-empty' | 'deadline' | 'stopped' }
```

Processing is triggered by:
- Starting a workflow (auto-triggers)
- App foreground events
- Network connectivity changes
- Explicit `processNow()` calls

The client will:
- Process continuously until the queue is empty or deadline is reached
- Stop gracefully before the deadline to allow cleanup

---

## React Hooks & Observability

### Built-in Hooks

```typescript
import {
  useExecution,
  useExecutionStats,
  usePendingActivityCount,
  useDeadLetters
} from 'endura/react';

// You need access to the engine/client instance (see ExpoWorkflowClient setup above)

// Subscribe to a specific workflow execution
function MyComponent({ runId, engine }) {
  const execution = useExecution(engine, runId);

  if (!execution) return <Text>Loading...</Text>;

  return (
    <View>
      <Text>Status: {execution.status}</Text>
      <Text>Current: {execution.currentActivityName}</Text>
    </View>
  );
}

// Aggregate statistics
function DashboardStats({ engine }) {
  const stats = useExecutionStats(engine);

  return (
    <View>
      <Text>Running: {stats.running}</Text>
      <Text>Completed: {stats.completed}</Text>
      <Text>Failed: {stats.failed}</Text>
    </View>
  );
}

// Pending activity count (for debugging)
function PendingCount({ storage }) {
  const count = usePendingActivityCount(storage);

  return (
    <View>
      <Text>Pending activities: {count}</Text>
    </View>
  );
}

// Monitor failures
function FailureAlerts({ engine }) {
  const deadLetters = useDeadLetters(engine);

  if (deadLetters.length === 0) return null;

  return (
    <View style={styles.alert}>
      <Text>{deadLetters.length} workflows need attention</Text>
    </View>
  );
}
```

### Workflow Progress Component

```tsx
import { useExecution } from 'endura/react';
import { WorkflowEngine } from 'endura';

function WorkflowProgress({ runId, engine }: { runId: string; engine: WorkflowEngine }) {
  const execution = useExecution(engine, runId);

  if (!execution) return <Text>Loading...</Text>;

  // Get workflow from engine (you'd need to track this in your app)
  const workflow = engine.getWorkflow(execution.workflowName);
  if (!workflow) return <Text>Workflow not found</Text>;

  const totalActivities = workflow.activities.length;
  const currentIndex = execution.currentActivityIndex;

  return (
    <View>
      <Text>{execution.workflowName}</Text>
      <Text>Status: {execution.status}</Text>
      <Text>Progress: {currentIndex + 1} / {totalActivities}</Text>
      <Text>Current: {execution.currentActivityName}</Text>
      <ProgressBar value={(currentIndex + 1) / totalActivities} />

      {execution.status === 'failed' && (
        <Text style={{ color: 'red' }}>
          Failed at: {execution.failedActivityName}
          Error: {execution.error}
        </Text>
      )}
    </View>
  );
}
```

### Logging Configuration

```typescript
const client = await ExpoWorkflowClient.create({
  storage,  // Your storage instance

  onEvent: (event) => {
    // Send to analytics, crash reporting, etc.
    switch (event.type) {
      case 'execution:started':
      case 'execution:completed':
      case 'execution:failed':
      case 'activity:started':
      case 'activity:completed':
      case 'activity:failed':
        analytics.track(event.type, event);
        break;
    }
  },
});
```

---

## Migration Guide

### From HopDrive react-native-queue Fork

If you're migrating from the HopDrive pipeline pattern:

#### Terminology Mapping

| Old (HopDrive) | New (This Library) |
|----------------|-------------------|
| Pipeline | Workflow |
| Event | WorkflowExecution |
| eventId | runId |
| Job | ActivityTask (internal) |
| Worker (function) | Activity |
| Worker options | ActivityOptions |
| `completeStage()` | *(automatic)* |

#### Phase 1: Parallel Implementation

Run both systems side-by-side with a feature flag:

```typescript
if (featureFlags.useNewWorkflowEngine) {
  await engine.start(photoWorkflow, { input: payload });
} else {
  await startPhotoPipeline({ payload });
}
```

#### Phase 2: Migrate Definitions

**Before (Pipeline + Workers):**

```typescript
// pipeline definition
export const name = 'photo.pipeline';
export const sequence = [PhotoCapture, PhotoPending, PhotoUpload, PhotoSave];

// PhotoCapture.worker.ts
export const worker = async (id, payload) => {
  const { eventId, uri } = payload;
  const hash = await generateHash(uri);
  await EventUtils.completeStage(pipeline, eventId, { hash });
};
```

**After (Workflow + Activities):**

```typescript
// workflow definition
export const photoWorkflow = defineWorkflow({
  name: 'photo',
  activities: [capturePhoto, pendingPhoto, uploadPhoto, savePhoto],
});

// capturePhoto.ts
export const capturePhoto = defineActivity({
  name: 'capturePhoto',
  execute: async (ctx) => {
    const { uri } = ctx.input;
    const hash = await generateHash(uri);
    return { hash };  // Automatic advancement, no completeStage()
  },
});
```

#### Phase 3: Data Migration

Migrate in-flight events to workflow executions:

```typescript
async function migrateInFlightEvents() {
  const events = await realm.objects('Event').filtered('syncStatus != "synced"');

  for (const event of events) {
    const execution: WorkflowExecution = {
      runId: event.eventId,
      workflowName: event.type,
      currentActivityIndex: getActivityIndex(event.stage),
      currentActivityName: event.stageName,
      status: mapStatus(event.syncStatus),
      input: event.payload,
      state: event.payload,
      createdAt: event.createdAt.getTime(),
      updatedAt: event.updatedAt.getTime(),
    };

    await newStorage.saveExecution(execution);
  }
}
```

#### Phase 4: Deprecation

1. Remove feature flags
2. Remove old queue library dependency
3. Clean up compatibility layers

---

## File Organization

### Recommended Structure

```
/workflows
  /photo
    capturePhoto.ts       # Activity definition
    uploadPhoto.ts        # Activity definition
    notifyServer.ts       # Activity definition
    activities.ts         # Barrel export of all activities
    workflow.ts           # Workflow definition
    index.ts              # Public export
  /driverStatusSync
    syncStatus.ts
    activities.ts
    workflow.ts
    index.ts
  /moveStatusSync
    ...
```

### Activity Definition

One file per activity, bundling the execute function with its options:

```typescript
// workflows/photo/uploadPhoto.ts
import { defineActivity, conditions } from 'endura';

export const uploadPhoto = defineActivity({
  name: 'uploadPhoto',

  execute: async (ctx) => {
    const { uri, hash } = ctx.input;
    const response = await uploadToS3(uri, { signal: ctx.signal });
    return { s3Key: response.key, uploadedAt: Date.now() };
  },

  startToCloseTimeout: 60000,
  retry: {
    maximumAttempts: 10,
    initialInterval: 5000,
    backoffCoefficient: 2,
    maximumInterval: 60000,
  },
  runWhen: conditions.whenConnected,
});
```

### Activity Barrel Export

```typescript
// workflows/photo/activities.ts
export { capturePhoto } from './capturePhoto';
export { uploadPhoto } from './uploadPhoto';
export { notifyServer } from './notifyServer';
```

### Workflow Definition

```typescript
// workflows/photo/workflow.ts
import { defineWorkflow } from 'endura';
import { capturePhoto, uploadPhoto, notifyServer } from './activities';

export const photoWorkflow = defineWorkflow({
  name: 'photo',
  activities: [capturePhoto, uploadPhoto, notifyServer],

  onComplete: async (runId, finalState) => {
    console.log(`Photo workflow ${runId} completed`);
  },
});
```

### Public Export

```typescript
// workflows/photo/index.ts
export { photoWorkflow } from './workflow';
export * from './activities';  // If activities need to be used elsewhere
```

---

## Testing

### Test Coverage

This project maintains high test coverage to ensure reliability. Coverage thresholds are enforced:

- **Statements**: 80%
- **Branches**: 70%
- **Functions**: 80%
- **Lines**: 80%

Coverage checks run automatically:
- **Pre-commit**: Husky hooks prevent commits that don't meet coverage thresholds
- **CI/CD**: GitHub Actions workflows enforce coverage on all pull requests

To run tests with coverage locally:

```bash
npm run test:coverage
```

### Test Structure

The test suite is organized into:

- **Unit Tests** (`src/**/*.test.ts`): Core engine functionality, storage adapters, and React hooks
- **Integration Tests** (`tests/integration/**/*.test.ts`): End-to-end workflow scenarios

### Unit Tests

The library includes comprehensive unit tests for core functionality. Unit tests manually create engine instances with mocked dependencies:

```typescript
import { WorkflowEngine, MockClock, MockScheduler, MockEnvironment, defineActivity, defineWorkflow } from 'endura';
import { InMemoryStorage } from 'endura/storage/memory';

describe('WorkflowEngine', () => {
  let storage: InMemoryStorage;
  let clock: MockClock;
  let scheduler: MockScheduler;
  let environment: MockEnvironment;

  beforeEach(() => {
    storage = new InMemoryStorage();
    clock = new MockClock(1000000);
    scheduler = new MockScheduler(clock);
    environment = new MockEnvironment();
  });

  async function createEngine(): Promise<WorkflowEngine> {
    return WorkflowEngine.create({
      storage,
      clock,
      scheduler,
      environment,
    });
  }

  it('should execute activities in sequence', async () => {
    const engine = await createEngine();

    const activityA = defineActivity({
      name: 'activityA',
      execute: async () => ({ a: true }),
    });
    const activityB = defineActivity({
      name: 'activityB',
      execute: async () => ({ b: true }),
    });
    const activityC = defineActivity({
      name: 'activityC',
      execute: async () => ({ c: true }),
    });

    const workflow = defineWorkflow({
      name: 'test',
      activities: [activityA, activityB, activityC],
    });

    engine.registerWorkflow(workflow);
    const execution = await engine.start(workflow, { input: { value: 1 } });

    // Process until complete
    while (true) {
      await engine.tick();
      const result = await engine.getExecution(execution.runId);
      if (result?.status !== 'running') {
        expect(result?.status).toBe('completed');
        expect(result?.state).toEqual({ value: 1, a: true, b: true, c: true });
        break;
      }
    }
  });
});
```

### Integration Tests

Integration tests verify complete workflow scenarios including offline handling, crash recovery, and concurrent execution. Integration tests use `createTestContext()` and `runToCompletion()` helpers:

```typescript
import { createTestContext, runToCompletion, TestContext } from '../utils/testHelpers';

describe('Photo Pipeline Integration', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(() => {
    ctx.engine.stop();
  });

  it('should upload photo when connected', async () => {
    const execution = await ctx.engine.start(photoWorkflow, {
      input: { uri: 'file://test.jpg', moveId: 123 },
    });

    const result = await runToCompletion(ctx, execution.runId);
    expect(result.status).toBe('completed');
    expect(result.state.s3Key).toBeDefined();
  });

  it('should defer upload when offline', async () => {
    ctx.environment.setConnected(false);

    const execution = await ctx.engine.start(photoWorkflow, {
      input: { uri: 'file://test.jpg', moveId: 123 },
    });

    await ctx.engine.tick(); // First activity completes
    await ctx.engine.tick(); // Upload skipped (offline)

    const state = await ctx.engine.getExecution(execution.runId);
    expect(state.currentActivityName).toBe('uploadPhoto');
    expect(state.status).toBe('running');

    // Come back online
    ctx.environment.setConnected(true);
    await ctx.engine.tick();

    const result = await runToCompletion(ctx, execution.runId);
    expect(result.status).toBe('completed');
  });
});
```

### Test Utilities

The `tests/utils/testHelpers.ts` module provides utilities for consistent test setup:

- `createTestContext()` - Creates a test engine with mocked dependencies
- `runToCompletion()` - Runs engine until workflow completes
- `createTestActivity()` - Creates configurable test activities
- `sleep()` / `waitFor()` - Async utilities

### React Hooks Tests

React hooks are tested using `@testing-library/react-hooks`:

```typescript
import { renderHook, waitFor } from '@testing-library/react-hooks';
import { useExecution } from 'endura/react';

describe('useExecution', () => {
  it('should return execution data', async () => {
    const execution = await engine.start(workflow, { input: {} });
    const { result } = renderHook(() => useExecution(engine, execution.runId));

    await waitFor(() => {
      expect(result.current?.runId).toBe(execution.runId);
    });
  });
});
```

### Storage Adapter Tests

Each storage adapter should pass the same test suite:

```typescript
import { InMemoryStorage } from 'endura/storage/memory';
import { SQLiteStorage } from 'endura/storage/sqlite';

describe.each([
  ['InMemory', new InMemoryStorage()],
  ['SQLite', new SQLiteStorage(driver)],
])('%s Storage Adapter', (name, adapter) => {
  it('should save and retrieve executions', async () => {
    const execution = createTestExecution();
    await adapter.saveExecution(execution);

    const retrieved = await adapter.getExecution(execution.runId);
    expect(retrieved).toEqual(execution);
  });

  it('should enforce uniqueness constraints', async () => {
    const first = await adapter.setUniqueKey('test', 'key1', 'run1');
    expect(first).toBe(true);

    const second = await adapter.setUniqueKey('test', 'key1', 'run2');
    expect(second).toBe(false);  // Already exists
  });
});
```

---

## Architecture

```mermaid
graph TD
    subgraph "Application Layer"
        UI[React Native UI]
        Def[Workflow Definitions]
        Hooks[React Hooks useExecution]
    end

    subgraph "Workflow Engine"
        Client[Workflow Client]
        Registry[Workflow Registry]
        Poller[Task Poller]
        Executor[Activity Executor]
    end

    subgraph "Storage Layer"
        Adapter[Storage Adapter Interface]
        SQLite[(SQLite DB)]
        Mem[(InMemory DB)]
    end

    %% Interactions
    UI -->|Start/Cancel| Client
    Def -->|Register| Registry
    Hooks -->|Observe| Client
    Client -->|Manage| Poller
    Poller -->|Schedule| Executor
    Executor -->|Run| Def

    %% Persistence
    Client -->|Read/Write| Adapter
    Poller -->|Poll| Adapter
    Executor -->|Persist State| Adapter
    Adapter -.->|Production| SQLite
    Adapter -.->|Testing| Mem

    classDef app fill:#e1f5fe,stroke:#01579b,stroke-width:2px;
    classDef engine fill:#fff3e0,stroke:#e65100,stroke-width:2px;
    classDef storage fill:#e8f5e9,stroke:#1b5e20,stroke-width:2px;

    class UI,Def,Hooks app;
    class Client,Registry,Poller,Executor engine;
    class Adapter,SQLite,Mem storage;
```

### Layer Responsibilities

The architecture consists of four main layers, each with specific responsibilities:

**Application Layer**
- Your app code: UI, business logic
- Workflow definitions and activity implementations
- React hooks for observing execution state
- Example: `engine.start(photoWorkflow, { input: { moveId: 123 } })`

**Workflow Engine**
- Workflow registration and lookup
- WorkflowExecution lifecycle management
- Activity sequencing and state accumulation
- Uniqueness constraint enforcement
- Cancellation coordination

**Activity Executor**
- Priority ordering
- Retry logic and backoff
- Concurrency control (async)
- Precondition checking (runWhen)
- Timeout enforcement

**Storage Layer**
- WorkflowExecution records
- ActivityTask records
- Dead letter records
- Uniqueness index

---

## Open Questions

These are architectural decisions that may evolve:

### Activity Dependencies / Parallel Execution

Current design is strictly sequential. Would parallel activity execution add value?

```typescript
// Possible future API
const workflow = defineWorkflow({
  name: 'multiUpload',
  activities: [
    prepare,
    parallel([uploadPhoto1, uploadPhoto2, uploadPhoto3]),  // Run in parallel
    notifyServer,
  ],
});
```

### Error Boundaries

How should errors in lifecycle callbacks (onComplete, onFailed) be handled? Should callback failures affect execution status?

### Storage Atomicity

SQLite provides ACID transactions, ensuring consistency. For custom storage adapters, consider implementing transaction support for multi-key operations to prevent inconsistent state on crashes.

### Testing Strategy

How to test workflows without actual activity execution? Mock storage adapter? Activity injection?

---

## Future Considerations

### MMKV Storage Adapter

An MMKV storage adapter could be implemented following the same `Storage` interface pattern. MMKV could be useful for:

- Faster key-value operations for smaller datasets
- Synchronous reads (MMKV is sync-first)
- Simpler setup than SQLite for basic use cases

However, SQLite is generally the better choice for workflow persistence because:

- Workflows can have many executions/tasks (relational queries are more efficient)
- Complex queries like "get all pending tasks scheduled before time X"
- ACID transactions for crash safety
- Better suited for the queue-like access patterns in the engine

### Metadata Indexing

Current implementation only retrieves WorkflowExecutions by `runId`. If querying by business entity becomes necessary:

```typescript
// Possible future API
const executions = await engine.getExecutionsByMetadata({ moveId: 123 });
```

### Scheduled / Cron Workflows

```typescript
// Possible future API
await engine.schedule(cleanupWorkflow, {
  cron: '0 3 * * *',  // Daily at 3am
  input: { maxAge: 7 * 24 * 60 * 60 * 1000 },
});
```

**Current recommendation**: Use OS-level schedulers (AlarmManager, BGTaskScheduler) to trigger workflows.

### Saga Pattern / Compensation

For workflows where failed activities need to "undo" previous activities:

```typescript
// Possible future API
const paymentWorkflow = defineWorkflow({
  name: 'payment',
  activities: [
    { activity: reserveInventory, compensate: releaseInventory },
    { activity: chargeCard, compensate: refundCard },
    { activity: sendConfirmation },
  ],
});
```

**Not recommended for v1**—adds significant complexity.

### True Background Threading

React Native's new architecture may enable running activities on separate threads:

```typescript
// Possible future API
defineActivity({
  name: 'processImage',
  execute: async (ctx) => { /* heavy computation */ },
  options: {
    runOnThread: true,
  },
});
```

Current activities are mostly I/O-bound where async concurrency is sufficient.

### Example App & E2E Testing

**Future work**: An example Expo app demonstrating library capabilities is planned. This would include:

- **Example App Structure**: A complete Expo app showcasing:
  - Photo workflow (capture → upload → notify)
  - Multi-workflow scenarios
  - Dead letter queue viewer
  - Network simulation controls
  - Workflow progress visualization

- **E2E Tests**: Maestro-based end-to-end tests for:
  - Complete workflow execution
  - Offline/online transitions
  - Background processing scenarios

- **Manual Testing Guide**: Scenarios for testing:
  - App crash recovery
  - Device reboot persistence
  - Real background fetch behavior (iOS/Android)
  - Memory pressure handling

This would serve as both documentation and a reference implementation for library users.

---

## References

- [Temporal Documentation](https://docs.temporal.io/) — Conceptual model reference
- [Temporal TypeScript SDK](https://docs.temporal.io/develop/typescript) — API patterns
- [AWS Step Functions](https://docs.aws.amazon.com/step-functions/) — State machine patterns
- [Saga Pattern](https://microservices.io/patterns/data/saga.html) — Distributed transaction handling
- [HopDrive react-native-queue fork](https://github.com/hopdrive/react-native-queue) — The original fork this evolved from

---

## License

MIT License — see [LICENSE](./LICENSE) for details.

---

## Contributing

Contributions are welcome! Please read our [Contributing Guide](./CONTRIBUTING.md) for details on our code of conduct and the process for submitting pull requests.

---

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for a history of changes to this project.