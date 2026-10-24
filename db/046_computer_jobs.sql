-- Background jobs started by a bot on its computer (detached process group).
CREATE TABLE IF NOT EXISTS computer_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
    conversation_id uuid,
    computer_id uuid NOT NULL,
    name text NOT NULL,
    kind text NOT NULL DEFAULT 'script' CHECK (kind IN ('script','python','analysis','download')),
    command_hash text NOT NULL,
    pid integer,
    status text NOT NULL DEFAULT 'starting' CHECK (status IN ('starting','running','done','failed','timed_out','cancelled','blocked_cap')),
    exit_code integer,
    reason text,
    max_seconds integer NOT NULL CHECK (max_seconds BETWEEN 30 AND 86400),
    job_dir text NOT NULL,
    log_path text NOT NULL,
    result_path text NOT NULL,
    log_bytes bigint NOT NULL DEFAULT 0,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    notified_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS computer_jobs_active ON computer_jobs (computer_id) WHERE status IN ('starting','running');
CREATE INDEX IF NOT EXISTS computer_jobs_owner ON computer_jobs (owner_id, started_at DESC);
CREATE INDEX IF NOT EXISTS computer_jobs_bot ON computer_jobs (bot_id, started_at DESC);
