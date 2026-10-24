CREATE TABLE IF NOT EXISTS video_analyses (
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    source_item_id uuid REFERENCES library_items(id) ON DELETE CASCADE,
    source_ref text NOT NULL,
    content_sha256 text NOT NULL,
    settings_version text NOT NULL,
    analysis jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, bot_id, source_ref, content_sha256, settings_version)
);
CREATE INDEX IF NOT EXISTS video_analyses_owner_sha_idx ON video_analyses(owner_id, content_sha256, settings_version);

-- A bridge call must originate from a policy-authorized tool invocation in this lease.
CREATE TABLE IF NOT EXISTS video_tool_sessions (
    id uuid PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    lease_epoch int NOT NULL,
    tool text NOT NULL CHECK (tool IN ('watch_video', 'ask_video')),
    args jsonb NOT NULL,
    approved_class text,
    analysis jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS video_tool_sessions_task_idx ON video_tool_sessions(task_id);
