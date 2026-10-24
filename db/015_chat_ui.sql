-- Additive chat UI columns. The id is 015 so a later branch can renumber it.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id uuid REFERENCES messages(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS coding_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
    title text NOT NULL,
    status text NOT NULL DEFAULT 'queued',
    step text NOT NULL DEFAULT '',
    pr_number int,
    pr_url text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT coding_jobs_status_chk CHECK (status IN ('queued', 'running', 'tests', 'finished', 'merged', 'failed'))
);

CREATE INDEX IF NOT EXISTS coding_jobs_bot_idx ON coding_jobs (bot_id, updated_at DESC);
