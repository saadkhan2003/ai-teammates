CREATE TABLE IF NOT EXISTS tool_execution_dedupe (
    task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    idempotency_key text NOT NULL,
    tool text NOT NULL,
    status text NOT NULL CHECK (status IN ('in_progress', 'completed')),
    result jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    PRIMARY KEY (task_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS tool_execution_dedupe_created_at_idx
    ON tool_execution_dedupe (created_at);
