/**
 * SQLite schema for the workflow engine storage.
 * Designed for compatibility with expo-sqlite.
 */

/**
 * SQL statements to create the database schema.
 */
export const SCHEMA_SQL = `
-- Workflow executions table
CREATE TABLE IF NOT EXISTS executions (
  run_id TEXT PRIMARY KEY NOT NULL,
  workflow_name TEXT NOT NULL,
  workflow_version TEXT,
  unique_key TEXT,
  current_activity_index INTEGER NOT NULL DEFAULT 0,
  current_activity_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
  input TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  error TEXT,
  failed_activity_name TEXT
);

-- Index for querying by status
CREATE INDEX IF NOT EXISTS idx_executions_status ON executions(status);

-- Unique key constraint: at most one RUNNING execution per key. Scoped to
-- status='running' so completed/failed history neither blocks key reuse
-- nor gets destroyed by it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_executions_unique_key_running
  ON executions(workflow_name, unique_key) WHERE unique_key IS NOT NULL AND status = 'running';

-- Activity tasks table
CREATE TABLE IF NOT EXISTS activity_tasks (
  task_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  activity_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'active', 'completed', 'failed', 'skipped')),
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  timeout INTEGER NOT NULL DEFAULT 25000,
  input TEXT NOT NULL,
  result TEXT,
  created_at INTEGER NOT NULL,
  scheduled_for INTEGER,
  started_at INTEGER,
  last_attempt_at INTEGER,
  completed_at INTEGER,
  error TEXT,
  error_stack TEXT,
  owner_id TEXT,
  lease_expires_at INTEGER,
  FOREIGN KEY (run_id) REFERENCES executions(run_id) ON DELETE CASCADE
);

-- Index for querying by status (for getPendingActivityTasks)
CREATE INDEX IF NOT EXISTS idx_tasks_status ON activity_tasks(status);

-- Index for pending tasks ordered by priority and created_at
CREATE INDEX IF NOT EXISTS idx_tasks_pending ON activity_tasks(status, priority DESC, created_at ASC)
  WHERE status = 'pending';

-- Index for querying tasks by execution
CREATE INDEX IF NOT EXISTS idx_tasks_run_id ON activity_tasks(run_id);

-- Dead letter queue table
CREATE TABLE IF NOT EXISTS dead_letters (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  activity_name TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  input TEXT NOT NULL,
  error TEXT NOT NULL,
  error_stack TEXT,
  attempts INTEGER NOT NULL,
  failed_at INTEGER NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  non_retryable INTEGER NOT NULL DEFAULT 0
);

-- Index for unacknowledged dead letters
CREATE INDEX IF NOT EXISTS idx_dead_letters_unacked ON dead_letters(acknowledged)
  WHERE acknowledged = 0;

-- Index for purging by age
CREATE INDEX IF NOT EXISTS idx_dead_letters_failed_at ON dead_letters(failed_at);
`;

/**
 * SQL statements split into individual statements for execution.
 */
export function getSchemaStatements(): string[] {
  return SCHEMA_SQL
    .split(';')
    .map(stmt => stmt.trim())
    .filter(stmt => stmt.length > 0)
    .map(stmt => stmt + ';');
}

/**
 * Current schema version, stored in PRAGMA user_version.
 *
 * Version history:
 * - v1: original schema (no failures/lease columns; unique index not
 *   scoped to status='running'). Databases created before versioning
 *   report user_version 0 and are treated as v1.
 * - v2: activity_tasks gains failures, owner_id, lease_expires_at; the
 *   executions unique index is rebuilt scoped to status='running'.
 * - v3: dead_letters gains non_retryable (M1 failure classification).
 * - v4: executions gains workflow_version (H7 upgrade-skew detection).
 */
export const SCHEMA_VERSION = 4;

/**
 * A single schema migration. Statements run in order inside one
 * transaction; user_version is bumped in the same transaction.
 */
export interface Migration {
  toVersion: number;
  statements: string[];
}

/**
 * Ordered migrations from each prior version to the next.
 * Statements must not carry leading comments (drivers route DDL by the
 * statement's first keyword).
 */
export const MIGRATIONS: Migration[] = [
  {
    toVersion: 2,
    statements: [
      `ALTER TABLE activity_tasks ADD COLUMN failures INTEGER NOT NULL DEFAULT 0;`,
      `ALTER TABLE activity_tasks ADD COLUMN owner_id TEXT;`,
      `ALTER TABLE activity_tasks ADD COLUMN lease_expires_at INTEGER;`,
      `DROP INDEX IF EXISTS idx_executions_unique_key;`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_executions_unique_key_running ON executions(workflow_name, unique_key) WHERE unique_key IS NOT NULL AND status = 'running';`,
    ],
  },
  {
    toVersion: 3,
    statements: [
      `ALTER TABLE dead_letters ADD COLUMN non_retryable INTEGER NOT NULL DEFAULT 0;`,
    ],
  },
  {
    toVersion: 4,
    statements: [
      `ALTER TABLE executions ADD COLUMN workflow_version TEXT;`,
    ],
  },
];
