-- Global plugin catalog. Rows only: nothing in this migration starts a process.
-- User installs stay in plugins. A person installs a catalog row; that is a separate action.

CREATE TABLE IF NOT EXISTS plugin_catalog (
    id text PRIMARY KEY,
    name text NOT NULL,
    publisher text NOT NULL DEFAULT '',
    source_url text NOT NULL DEFAULT '',
    version text NOT NULL DEFAULT '',
    kind text NOT NULL,
    transport text NOT NULL DEFAULT '',
    auth_type text NOT NULL DEFAULT 'none',
    category text NOT NULL DEFAULT '',
    risk text NOT NULL DEFAULT 'unknown',
    trust text NOT NULL DEFAULT 'community',
    label text NOT NULL DEFAULT 'listed',
    check_status text NOT NULL DEFAULT 'pending',
    check_detail text NOT NULL DEFAULT '',
    tools jsonb NOT NULL DEFAULT '[]'::jsonb,
    manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
    dedupe_key text NOT NULL,
    blocked boolean NOT NULL DEFAULT false,
    blocked_reason text NOT NULL DEFAULT '',
    imported_at timestamptz NOT NULL DEFAULT now(),
    checked_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT plugin_catalog_auth_chk CHECK (auth_type IN ('none','api_key','oauth')),
    CONSTRAINT plugin_catalog_label_chk CHECK (label IN ('listed','auto-checked','tested','failed','needs-auth')),
    CONSTRAINT plugin_catalog_trust_chk CHECK (trust IN ('community','official','verified')),
    CONSTRAINT plugin_catalog_risk_chk CHECK (risk IN ('unknown','low','medium','high')),
    CONSTRAINT plugin_catalog_kind_chk CHECK (kind IN ('mcp','openapi','builtin')),
    CONSTRAINT plugin_catalog_check_chk CHECK (check_status IN ('pending','passed','failed','needs-auth','skipped'))
);

CREATE UNIQUE INDEX IF NOT EXISTS plugin_catalog_dedupe_idx ON plugin_catalog (dedupe_key);
CREATE INDEX IF NOT EXISTS plugin_catalog_label_idx ON plugin_catalog (label);
CREATE INDEX IF NOT EXISTS plugin_catalog_category_idx ON plugin_catalog (category);
CREATE INDEX IF NOT EXISTS plugin_catalog_name_idx ON plugin_catalog (lower(name));

CREATE TABLE IF NOT EXISTS plugin_import_state (
    source text PRIMARY KEY,
    cursor text NOT NULL DEFAULT '',
    pages int NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plugin_jobs (
    id bigserial PRIMARY KEY,
    kind text NOT NULL,
    status text NOT NULL DEFAULT 'queued',
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    CONSTRAINT plugin_jobs_kind_chk CHECK (kind IN ('import','check')),
    CONSTRAINT plugin_jobs_status_chk CHECK (status IN ('queued','running','done','failed'))
);

ALTER TABLE plugins ADD COLUMN IF NOT EXISTS catalog_id text;
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS publisher text NOT NULL DEFAULT '';
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS source_url text NOT NULL DEFAULT '';
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS version text NOT NULL DEFAULT '';
ALTER TABLE plugins DROP CONSTRAINT IF EXISTS plugins_label_chk;
ALTER TABLE plugins ADD CONSTRAINT plugins_label_chk CHECK (label IN ('listed','auto-checked','tested','failed','needs-auth'));

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'plugins_catalog_fk'
    ) THEN
        ALTER TABLE plugins
            ADD CONSTRAINT plugins_catalog_fk
            FOREIGN KEY (catalog_id) REFERENCES plugin_catalog(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS plugins_owner_catalog_idx ON plugins (owner_user_id, catalog_id) WHERE catalog_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS plugin_bot_enable (
    plugin_id uuid NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT true,
    PRIMARY KEY (plugin_id, bot_id)
);

CREATE TABLE IF NOT EXISTS plugin_oauth_states (
    state text PRIMARY KEY,
    owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plugin_id uuid NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
