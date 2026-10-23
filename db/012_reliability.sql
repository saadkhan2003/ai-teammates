-- v0.4: task-scoped browser consent, safe task errors, durable run events.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS error_code text;
CREATE TABLE IF NOT EXISTS task_browser_origins (
    task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    origin text NOT NULL,
    PRIMARY KEY (task_id, origin)
);
CREATE TABLE IF NOT EXISTS task_run_events (
    id bigserial PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    type text NOT NULL,
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_run_events_task_idx ON task_run_events(task_id, id);
-- Initial attempt plus at most three retries, including worker restarts.
ALTER TABLE outbound_actions ADD COLUMN IF NOT EXISTS retry_attempts integer NOT NULL DEFAULT 1;
