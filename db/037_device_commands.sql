CREATE TABLE IF NOT EXISTS device_commands (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    command text NOT NULL CHECK (length(command) <= 4000),
    cwd text NULL,
    timeout_sec int NOT NULL DEFAULT 60 CHECK (timeout_sec BETWEEN 1 AND 600),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','approved','denied','running','completed','failed','expired','cancelled')),
    decision_reason text,
    exit_code int,
    stdout text,
    stderr text,
    truncated boolean NOT NULL DEFAULT false,
    timed_out boolean NOT NULL DEFAULT false,
    duration_ms int,
    requested_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    sent_at timestamptz,
    decided_at timestamptz,
    finished_at timestamptz,
    expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS device_commands_device_created_idx ON device_commands(device_id, created_at DESC);
CREATE INDEX IF NOT EXISTS device_commands_owner_status_idx ON device_commands(owner_id, status);
