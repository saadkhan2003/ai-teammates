-- Routines fire in the owner's timezone, not UTC. Default for this deployment's user: Asia/Karachi.
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Asia/Karachi';
ALTER TABLE routines ALTER COLUMN timezone SET DEFAULT 'Asia/Karachi';
-- Existing rows were all stamped with the old UTC default but were written with a local clock in mind.
UPDATE routines SET timezone = 'Asia/Karachi' WHERE timezone = 'UTC';
UPDATE routines SET next_run_at = NULL WHERE enabled AND next_run_at IS NOT NULL AND next_run_at > now();
