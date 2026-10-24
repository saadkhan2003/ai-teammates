ALTER TABLE tasks ADD COLUMN IF NOT EXISTS budget_steps integer;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS budget_seconds integer;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS require_tests boolean;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS tests_passed_at timestamptz;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS tests_override boolean NOT NULL DEFAULT false;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS last_progress_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS nudge_pending boolean NOT NULL DEFAULT false;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS stall_nudges integer NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS blocked_reason text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS worktree_path text;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS default_budget_steps integer;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS default_budget_seconds integer;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS require_tests boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS task_plan_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    position integer NOT NULL,
    title text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','done','blocked')),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(task_id, position)
);
CREATE INDEX IF NOT EXISTS task_plan_task_idx ON task_plan_items(task_id, position);
