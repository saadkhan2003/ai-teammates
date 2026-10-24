-- Admin console: staff roles, plans, audit surfaces, and operator records.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_chk;
ALTER TABLE users ADD CONSTRAINT users_role_chk CHECK (role IN ('owner', 'admin', 'support', 'readonly', 'member'));

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_chk;
ALTER TABLE users ADD CONSTRAINT users_status_chk CHECK (status IN ('active', 'disabled', 'pending', 'banned'));

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip text NOT NULL DEFAULT '';

ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open';
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS staff_note text NOT NULL DEFAULT '';

ALTER TABLE plugin_catalog ADD COLUMN IF NOT EXISTS featured boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS organizations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organization_members (
    org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL DEFAULT 'member',
    PRIMARY KEY (org_id, user_id),
    CONSTRAINT organization_members_role_chk CHECK (role IN ('owner', 'admin', 'member'))
);

CREATE TABLE IF NOT EXISTS admin_notes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    author_id uuid NOT NULL REFERENCES users(id),
    body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT admin_notes_body_chk CHECK (length(body) BETWEEN 1 AND 4000)
);

CREATE TABLE IF NOT EXISTS admin_impersonations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    started_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz
);
CREATE INDEX IF NOT EXISTS admin_impersonations_actor_idx ON admin_impersonations (actor_id, started_at DESC);

CREATE TABLE IF NOT EXISTS plan_limits (
    plan_id text PRIMARY KEY,
    price_cents integer NOT NULL,
    weekly_credits integer NOT NULL,
    storage_mb integer NOT NULL,
    ram_mb integer NOT NULL,
    cpu_millis integer NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO plan_limits (plan_id, price_cents, weekly_credits, storage_mb, ram_mb, cpu_millis) VALUES
    ('free', 0, 125, 1024, 1024, 500),
    ('pro', 2000, 1250, 10240, 4096, 2000),
    ('team', 8000, 5000, 51200, 8192, 4000)
ON CONFLICT (plan_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS user_limit_overrides (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    storage_mb integer,
    ram_mb integer,
    cpu_millis integer,
    weekly_credits integer,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS topup_rules (
    id text PRIMARY KEY,
    enabled boolean NOT NULL DEFAULT false,
    pack_credits integer NOT NULL,
    pack_cents integer NOT NULL,
    max_packs_per_week integer NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO topup_rules (id, enabled, pack_credits, pack_cents, max_packs_per_week)
VALUES ('default', false, 1000, 500, 4)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS credit_ledger (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind text NOT NULL,
    credits integer NOT NULL DEFAULT 0,
    amount_cents integer NOT NULL DEFAULT 0,
    note text NOT NULL DEFAULT '',
    actor_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT credit_ledger_kind_chk CHECK (kind IN ('ai', 'computer', 'storage', 'grant', 'refund', 'topup'))
);
CREATE INDEX IF NOT EXISTS credit_ledger_user_idx ON credit_ledger (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS refunds (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount_cents integer NOT NULL,
    reason text NOT NULL DEFAULT '',
    actor_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Merge point: speed-v1 owns the 12 request-time safety checks.
-- This registry is the admin contract those checks should read.
CREATE TABLE IF NOT EXISTS model_registry (
    id text PRIMARY KEY,
    label text NOT NULL,
    provider text NOT NULL DEFAULT '',
    enabled boolean NOT NULL DEFAULT true,
    is_default boolean NOT NULL DEFAULT false,
    is_fallback boolean NOT NULL DEFAULT false,
    daily_spend_cap_cents integer NOT NULL DEFAULT 0,
    killed boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO model_registry (id, label, provider, enabled, is_default, is_fallback)
VALUES ('anthropic/claude-haiku-5.5', 'Claude Haiku 5.5', 'anthropic', true, true, true)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS feature_flags (
    key text PRIMARY KEY,
    enabled boolean NOT NULL DEFAULT false,
    description text NOT NULL DEFAULT '',
    kind text NOT NULL DEFAULT 'flag',
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT feature_flags_kind_chk CHECK (kind IN ('flag', 'kill', 'maintenance'))
);

INSERT INTO feature_flags (key, enabled, description, kind) VALUES
    ('signups_open', true, 'Invitation accept can create accounts.', 'flag'),
    ('plugins_install', true, 'People can install catalog apps.', 'flag'),
    ('topups_open', false, 'On-demand credit packs can be recorded.', 'flag'),
    ('model_kill', false, 'Stop model calls. speed-v1 enforces this at request time.', 'kill'),
    ('computers_kill', false, 'Refuse wake and start for computers.', 'kill'),
    ('bots_kill', false, 'Refuse bot restart.', 'kill'),
    ('maintenance_mode', false, 'Show the maintenance banner.', 'maintenance')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS announcements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title text NOT NULL,
    body text NOT NULL DEFAULT '',
    kind text NOT NULL DEFAULT 'banner',
    published boolean NOT NULL DEFAULT false,
    starts_at timestamptz,
    ends_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT announcements_kind_chk CHECK (kind IN ('banner', 'changelog'))
);

CREATE TABLE IF NOT EXISTS email_templates (
    id text PRIMARY KEY,
    subject text NOT NULL,
    body text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO email_templates (id, subject, body) VALUES
    ('welcome', 'Welcome to AI Teammates', 'Your account is ready.'),
    ('password_reset', 'Password reset', 'A staff member set a new password. Sign in and change it.'),
    ('invoice', 'Your invoice', 'An invoice is ready in billing.')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS admin_api_keys (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    prefix text NOT NULL,
    secret_hash text NOT NULL,
    created_by uuid NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS admin_ip_allowlist (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cidr text NOT NULL UNIQUE,
    note text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_totp (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret text NOT NULL,
    enabled boolean NOT NULL DEFAULT false,
    confirmed_at timestamptz
);

CREATE TABLE IF NOT EXISTS host_capacity (
    host_id text PRIMARY KEY,
    max_computers integer NOT NULL,
    note text NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cleanup_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    status text NOT NULL,
    bytes_freed bigint NOT NULL DEFAULT 0,
    note text NOT NULL DEFAULT '',
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS backups (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    label text NOT NULL,
    status text NOT NULL,
    bytes bigint NOT NULL DEFAULT 0,
    note text NOT NULL DEFAULT '',
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS alert_rules (
    id text PRIMARY KEY,
    enabled boolean NOT NULL DEFAULT false,
    threshold text NOT NULL DEFAULT '',
    channel text NOT NULL DEFAULT 'audit',
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO alert_rules (id, enabled, threshold, channel) VALUES
    ('error_spike', false, '20 failed tasks in an hour', 'audit'),
    ('spend_cap', true, 'Daily model cap on the registry', 'audit'),
    ('disk_pressure', false, '80 percent of the storage quota', 'audit')
ON CONFLICT (id) DO NOTHING;
