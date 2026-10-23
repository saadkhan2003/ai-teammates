CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE schema_migrations (
    id text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE bots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    role text NOT NULL DEFAULT '',
    instructions text NOT NULL DEFAULT '',
    model text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'idle',
    token_hash text NOT NULL,
    display_num int,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    title text NOT NULL DEFAULT 'New conversation',
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE skills (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    version int NOT NULL DEFAULT 1,
    definition jsonb NOT NULL,
    deterministic boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE routines (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    name text NOT NULL,
    cron text NOT NULL,
    timezone text NOT NULL DEFAULT 'UTC',
    instruction text NOT NULL,
    enabled boolean NOT NULL DEFAULT true,
    overlap_policy text NOT NULL DEFAULT 'skip',
    next_run_at timestamptz,
    last_run_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
    title text NOT NULL,
    instruction text NOT NULL,
    kind text NOT NULL DEFAULT 'work',
    status text NOT NULL DEFAULT 'queued',
    priority int NOT NULL DEFAULT 0,
    lease_owner text,
    lease_epoch int NOT NULL DEFAULT 0,
    lease_until timestamptz,
    attempt int NOT NULL DEFAULT 0,
    checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb,
    result jsonb,
    error text,
    skill_id uuid REFERENCES skills(id) ON DELETE SET NULL,
    routine_id uuid REFERENCES routines(id) ON DELETE SET NULL,
    model_calls int NOT NULL DEFAULT 0,
    waiting_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    CONSTRAINT tasks_status_chk CHECK (status IN (
        'queued','planning','running','waiting_resource','waiting_approval',
        'waiting_human','paused','recovering','completed','failed','cancelled'
    ))
);

CREATE INDEX tasks_lease_idx ON tasks (status, priority DESC, created_at);
CREATE INDEX tasks_bot_idx ON tasks (bot_id, created_at DESC);

CREATE TABLE routine_runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    routine_id uuid NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
    status text NOT NULL,
    triggered_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);

CREATE TABLE messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role text NOT NULL,
    kind text NOT NULL DEFAULT 'text',
    content text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conv_idx ON messages (conversation_id, created_at);

CREATE TABLE task_transcript (
    id bigserial PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    seq int NOT NULL,
    role text NOT NULL,
    content text,
    tool_calls jsonb,
    tool_call_id text,
    name text,
    UNIQUE (task_id, seq)
);

CREATE TABLE task_steps (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    seq int NOT NULL,
    tool text NOT NULL,
    args jsonb NOT NULL DEFAULT '{}'::jsonb,
    result jsonb,
    policy text,
    ok boolean,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);

CREATE TABLE browser_pages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
    target_id text NOT NULL,
    url text NOT NULL DEFAULT '',
    title text NOT NULL DEFAULT '',
    is_foreground boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (bot_id, target_id)
);

CREATE TABLE control_locks (
    bot_id uuid PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
    holder text NOT NULL DEFAULT 'agent',
    epoch int NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE approvals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
    action text NOT NULL,
    target text NOT NULL DEFAULT '',
    proposed jsonb NOT NULL DEFAULT '{}'::jsonb,
    reason text NOT NULL DEFAULT '',
    evidence text NOT NULL DEFAULT '',
    current_value text,
    status text NOT NULL DEFAULT 'pending',
    decision_note text,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    decided_at timestamptz
);

CREATE TABLE memories (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    scope text NOT NULL DEFAULT 'bot',
    content text NOT NULL,
    source text NOT NULL DEFAULT 'user',
    importance real NOT NULL DEFAULT 0.5,
    provenance text,
    embedding vector(64),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memories_fts ON memories USING gin (to_tsvector('english', content));

CREATE TABLE artifacts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
    name text NOT NULL,
    mime text NOT NULL DEFAULT 'application/octet-stream',
    size_bytes bigint NOT NULL DEFAULT 0,
    sha256 text NOT NULL,
    object_key text NOT NULL,
    source_url text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE model_calls (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id uuid,
    task_id uuid,
    owner_id uuid,
    role text NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    latency_ms int NOT NULL,
    prompt_tokens int NOT NULL DEFAULT 0,
    completion_tokens int NOT NULL DEFAULT 0,
    cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
    ok boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE model_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid,
    bot_id uuid,
    task_id uuid,
    provider text NOT NULL,
    model text NOT NULL,
    prompt_json jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
    id bigserial PRIMARY KEY,
    at timestamptz NOT NULL DEFAULT now(),
    actor text NOT NULL,
    action text NOT NULL,
    bot_id uuid,
    task_id uuid,
    detail jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE vnc_tokens (
    token_hash text PRIMARY KEY,
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    mode text NOT NULL,
    epoch int NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE seen_domains (
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    domain text NOT NULL,
    PRIMARY KEY (bot_id, domain)
);

CREATE TABLE secrets (
    id uuid PRIMARY KEY,
    owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    provider text NOT NULL DEFAULT '',
    description text NOT NULL DEFAULT '',
    type text NOT NULL,
    scope text NOT NULL DEFAULT 'USER',
    ciphertext bytea NOT NULL,
    nonce bytea NOT NULL,
    key_version int NOT NULL,
    masked_suffix text,
    allowed_tools text[] NOT NULL DEFAULT '{}',
    allowed_domains text[] NOT NULL DEFAULT '{}',
    allowed_bot_ids uuid[],
    validation_status text NOT NULL DEFAULT 'unknown',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    rotated_at timestamptz,
    expires_at timestamptz,
    revoked_at timestamptz,
    CONSTRAINT secrets_type_chk CHECK (type IN (
        'API_KEY','PASSWORD','TOKEN','OAUTH_REFRESH_TOKEN','SSH_PRIVATE_KEY',
        'WEBHOOK_SECRET','DATABASE_CREDENTIAL','GENERIC'
    )),
    CONSTRAINT secrets_scope_chk CHECK (scope IN ('USER','PROJECT','ORGANIZATION','SYSTEM')),
    CONSTRAINT secrets_validation_chk CHECK (validation_status IN ('unknown','valid','invalid','expired')),
    UNIQUE (owner_user_id, scope, provider, name)
);

CREATE TABLE secret_usage_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    secret_id uuid,
    event text NOT NULL,
    actor text NOT NULL,
    bot_id uuid,
    task_id uuid,
    tool text,
    destination text,
    decision text NOT NULL,
    reason_code text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX secret_usage_secret_idx ON secret_usage_events (secret_id, created_at);

CREATE TABLE secret_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
    suggested_ref text NOT NULL,
    type text NOT NULL,
    reason text NOT NULL DEFAULT '',
    allowed_tools text[] NOT NULL DEFAULT '{}',
    allowed_domains text[] NOT NULL DEFAULT '{}',
    status text NOT NULL DEFAULT 'pending',
    secret_id uuid,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE connectors (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    kind text NOT NULL DEFAULT 'http',
    secret_id uuid,
    base_url text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE share_nonces (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    site text NOT NULL,
    expires_at timestamptz NOT NULL,
    used_at timestamptz
);

CREATE TABLE site_grants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    site text NOT NULL,
    UNIQUE (bot_id, site)
);

CREATE TABLE login_bundles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    site text NOT NULL,
    ciphertext bytea NOT NULL,
    nonce bytea NOT NULL,
    key_version int NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
