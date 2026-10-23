-- Action policy, append-only audit chain, and login prompts.
-- Login values are not stored here. A ticked "save to vault" goes through secrets.

ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS prev_hash text NOT NULL DEFAULT '';
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS row_hash text NOT NULL DEFAULT '';
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS detail_canonical text NOT NULL DEFAULT '';
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS chain_canonical text NOT NULL DEFAULT '';

UPDATE audit_events
SET detail_canonical = detail::text
WHERE detail_canonical = '';

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
DECLARE
  rec record;
  prev text := 'genesis';
  canon text;
  hashed text;
BEGIN
  FOR rec IN SELECT id, at, actor, action, bot_id, task_id, detail_canonical FROM audit_events ORDER BY id LOOP
    canon := rec.id::text || '|' ||
      to_char(rec.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' ||
      rec.actor || '|' || rec.action || '|' ||
      coalesce(rec.bot_id::text, '') || '|' || coalesce(rec.task_id::text, '') || '|' ||
      rec.detail_canonical || '|' || prev;
    hashed := encode(digest(canon, 'sha256'), 'hex');
    UPDATE audit_events SET prev_hash = prev, row_hash = hashed, chain_canonical = canon WHERE id = rec.id;
    prev := hashed;
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS audit_chain_head (
    id int PRIMARY KEY CHECK (id = 1),
    row_hash text NOT NULL
);

INSERT INTO audit_chain_head (id, row_hash)
VALUES (1, coalesce((SELECT row_hash FROM audit_events ORDER BY id DESC LIMIT 1), 'genesis'))
ON CONFLICT (id) DO UPDATE SET row_hash = EXCLUDED.row_hash;

CREATE OR REPLACE FUNCTION audit_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS audit_events_no_mutate ON audit_events;
CREATE TRIGGER audit_events_no_mutate
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();

CREATE OR REPLACE FUNCTION secret_usage_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'secret_usage_events is append-only';
END;
$$;

DROP TRIGGER IF EXISTS secret_usage_no_mutate ON secret_usage_events;
CREATE TRIGGER secret_usage_no_mutate
  BEFORE UPDATE OR DELETE ON secret_usage_events
  FOR EACH ROW EXECUTE FUNCTION secret_usage_append_only();

ALTER TABLE approvals ADD COLUMN IF NOT EXISTS risk_class text NOT NULL DEFAULT '';
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS summary text NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS user_policies (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    settings jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS policy_deny_rules (
    code text PRIMARY KEY,
    description text NOT NULL,
    pattern text NOT NULL,
    builtin boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT policy_deny_code_chk CHECK (code ~ '^[a-z][a-z0-9_]{2,40}$'),
    CONSTRAINT policy_deny_pattern_chk CHECK (char_length(pattern) BETWEEN 3 AND 120)
);

CREATE TABLE IF NOT EXISTS login_prompts (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
    domain text NOT NULL,
    url text NOT NULL DEFAULT '',
    fields jsonb NOT NULL DEFAULT '[]'::jsonb,
    submit_selector text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'pending',
    vault_refs jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    filled_at timestamptz,
    CONSTRAINT login_prompts_status_chk CHECK (status IN ('pending', 'submitted', 'filled', 'expired', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS login_prompts_bot_idx ON login_prompts (bot_id, status, created_at);
