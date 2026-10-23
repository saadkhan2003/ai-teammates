-- Routines v2: one-off reminders, jitter, expiry, failure streaks, quiet rule, richer run history.
ALTER TABLE routines ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'recurring';
ALTER TABLE routines ADD COLUMN IF NOT EXISTS run_at timestamptz;
ALTER TABLE routines ADD COLUMN IF NOT EXISTS jitter_seconds integer NOT NULL DEFAULT 0;
ALTER TABLE routines ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE routines ADD COLUMN IF NOT EXISTS trigger jsonb;
ALTER TABLE routines ADD COLUMN IF NOT EXISTS failure_streak integer NOT NULL DEFAULT 0;
ALTER TABLE routines ADD COLUMN IF NOT EXISTS paused_reason text;
ALTER TABLE routines ADD COLUMN IF NOT EXISTS quiet_rule text;
ALTER TABLE routines ADD COLUMN IF NOT EXISTS nominal_next_at timestamptz;
ALTER TABLE routine_runs ADD COLUMN IF NOT EXISTS scheduled_for timestamptz;
ALTER TABLE routine_runs ADD COLUMN IF NOT EXISTS error text;
ALTER TABLE routine_runs ADD COLUMN IF NOT EXISTS skip_reason text;
ALTER TABLE routine_runs ADD COLUMN IF NOT EXISTS summary text;
ALTER TABLE routine_runs ADD COLUMN IF NOT EXISTS notified boolean NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS routine_runs_history_idx ON routine_runs (routine_id, triggered_at DESC);
CREATE INDEX IF NOT EXISTS routine_runs_task_idx ON routine_runs (task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS routines_due_idx ON routines (next_run_at) WHERE enabled AND next_run_at IS NOT NULL;
