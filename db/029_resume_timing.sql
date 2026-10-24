CREATE TABLE IF NOT EXISTS task_attempt_log (
    id bigserial PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    attempt integer NOT NULL,
    started_at timestamptz NOT NULL,
    ended_at timestamptz NOT NULL,
    wall_seconds integer NOT NULL,
    tool_calls integer NOT NULL,
    end_reason text NOT NULL,
    progress boolean NOT NULL,
    worker text,
    api_uptime_seconds integer NOT NULL
);
CREATE INDEX IF NOT EXISTS task_attempt_log_task_idx ON task_attempt_log(task_id,id);
