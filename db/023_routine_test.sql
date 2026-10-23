ALTER TABLE routines ADD COLUMN IF NOT EXISTS force_once boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS routines_forced_due_idx ON routines (next_run_at) WHERE force_once;
