CREATE TABLE IF NOT EXISTS task_transcript_archive (
    id bigserial PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    compaction_id text NOT NULL,
    seq integer NOT NULL,
    role text NOT NULL,
    content text,
    tool_calls jsonb,
    tool_call_id text,
    name text,
    archived_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(task_id, compaction_id, seq)
);
CREATE INDEX IF NOT EXISTS task_transcript_archive_history_idx
    ON task_transcript_archive(task_id, archived_at, compaction_id, seq);
