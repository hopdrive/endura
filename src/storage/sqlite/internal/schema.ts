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

-- Index for unique key constraint
CREATE UNIQUE INDEX IF NOT EXISTS idx_executions_unique_key
  ON executions(workflow_name, unique_key) WHERE unique_key IS NOT NULL;

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
  acknowledged INTEGER NOT NULL DEFAULT 0
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
 * Current schema version for migrations.
 */
export const SCHEMA_VERSION = 1;
