-- v0.2 private beta: roles, invitations, one computer per user, quotas, notifications.

ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member';
ALTER TABLE users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text NOT NULL DEFAULT '';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_chk;
ALTER TABLE users ADD CONSTRAINT users_role_chk CHECK (role IN ('owner', 'admin', 'member'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_chk;
ALTER TABLE users ADD CONSTRAINT users_status_chk CHECK (status IN ('active', 'disabled', 'pending'));

ALTER TABLE bots ADD COLUMN IF NOT EXISTS section text NOT NULL DEFAULT 'Teammates';
ALTER TABLE bots ADD COLUMN IF NOT EXISTS avatar text NOT NULL DEFAULT '';
ALTER TABLE bots ADD COLUMN IF NOT EXISTS notifications_enabled boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS invitations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL,
    role text NOT NULL DEFAULT 'member',
    token_hash text NOT NULL UNIQUE,
    invited_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    accepted_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT invitations_role_chk CHECK (role IN ('admin', 'member'))
);

CREATE TABLE IF NOT EXISTS user_computers (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    computer_id uuid NOT NULL,
    desktop_bot_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'running',
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_quotas (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    max_bots int NOT NULL DEFAULT 8,
    max_computers int NOT NULL DEFAULT 1,
    memory_bytes bigint NOT NULL DEFAULT 1610612736,
    cpu_millis int NOT NULL DEFAULT 1000,
    disk_bytes bigint NOT NULL DEFAULT 10737418240,
    max_parallel_tasks int NOT NULL DEFAULT 6,
    max_secrets int NOT NULL DEFAULT 40
);

CREATE TABLE IF NOT EXISTS notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind text NOT NULL,
    title text NOT NULL,
    body text NOT NULL DEFAULT '',
    read_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);
