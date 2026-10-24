CREATE TABLE IF NOT EXISTS ai_providers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE,
 kind text NOT NULL CHECK(kind IN ('openrouter','anthropic','openai','google','openai_compatible','mock')),
 base_url text NOT NULL, enabled boolean NOT NULL DEFAULT true,
 models jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(models)='array'),
 key_ciphertext bytea, key_nonce bytea, key_version int NOT NULL DEFAULT 1,
 key_updated_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((key_ciphertext IS NULL) = (key_nonce IS NULL))
);
CREATE TABLE IF NOT EXISTS ai_config_versions (
 version int PRIMARY KEY, config jsonb NOT NULL, note text NOT NULL DEFAULT '',
 created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), is_active boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_config_one_active ON ai_config_versions(is_active) WHERE is_active;
CREATE TABLE IF NOT EXISTS ai_config_audit (
 id bigserial PRIMARY KEY, actor uuid REFERENCES users(id), action text NOT NULL,
 detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE model_calls ADD COLUMN IF NOT EXISTS provider_id uuid;
ALTER TABLE model_calls ADD COLUMN IF NOT EXISTS config_version int;
ALTER TABLE model_calls ADD COLUMN IF NOT EXISTS credits numeric;
-- The revision includes key and rollout changes, not only new config versions.
CREATE TABLE IF NOT EXISTS ai_config_state (id int PRIMARY KEY CHECK(id=1), revision bigint NOT NULL DEFAULT 0);
INSERT INTO ai_config_state(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION ai_config_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE ai_config_state SET revision=revision+1 WHERE id=1;
 PERFORM pg_notify('ai_config', 'changed');
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS ai_providers_changed ON ai_providers;
CREATE TRIGGER ai_providers_changed AFTER INSERT OR UPDATE OR DELETE ON ai_providers FOR EACH STATEMENT EXECUTE FUNCTION ai_config_changed();
DROP TRIGGER IF EXISTS ai_versions_changed ON ai_config_versions;
CREATE TRIGGER ai_versions_changed AFTER INSERT OR UPDATE OR DELETE ON ai_config_versions FOR EACH STATEMENT EXECUTE FUNCTION ai_config_changed();

CREATE TABLE IF NOT EXISTS ai_task_config_assignments (
 task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 active_version int NOT NULL, resolved_version int NOT NULL,
 PRIMARY KEY(task_id, active_version)
);
