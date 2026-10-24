-- Immutable snapshots; activation and rollout only change the singleton pointer.
ALTER TABLE ai_config_state ADD COLUMN IF NOT EXISTS activation_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE ai_task_config_assignments ADD COLUMN activation_epoch bigint NOT NULL DEFAULT 0;
ALTER TABLE ai_task_config_assignments DROP CONSTRAINT ai_task_config_assignments_pkey;
ALTER TABLE ai_task_config_assignments ADD PRIMARY KEY(task_id,active_version,activation_epoch);
ALTER TABLE ai_config_state ADD COLUMN IF NOT EXISTS active_version int REFERENCES ai_config_versions(version);
ALTER TABLE ai_config_state ADD COLUMN IF NOT EXISTS candidate_version int REFERENCES ai_config_versions(version);
ALTER TABLE ai_config_state ADD COLUMN IF NOT EXISTS rollout_percent int NOT NULL DEFAULT 0 CHECK(rollout_percent BETWEEN 0 AND 100);
ALTER TABLE ai_config_state ADD COLUMN IF NOT EXISTS kill_switch jsonb NOT NULL DEFAULT '{"mode":"off"}';
UPDATE ai_config_state SET active_version=(SELECT version FROM ai_config_versions WHERE is_active),
 candidate_version=(SELECT (config->'rollout'->>'candidate_version')::int FROM ai_config_versions WHERE is_active),
 rollout_percent=coalesce((SELECT (config->'rollout'->>'percent')::int FROM ai_config_versions WHERE is_active),0) WHERE active_version IS NULL;
CREATE OR REPLACE FUNCTION ai_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'AI configuration versions are immutable'; END $$;
CREATE TRIGGER ai_version_immutable BEFORE UPDATE OR DELETE ON ai_config_versions FOR EACH ROW EXECUTE FUNCTION ai_version_immutable();
CREATE TABLE ai_model_catalog (
 provider_id uuid NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE, model text NOT NULL,
 metadata jsonb NOT NULL, present bool NOT NULL DEFAULT true, synced_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(provider_id,model)
);
CREATE TABLE ai_provider_key_slots (
 provider_id uuid NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
 slot text NOT NULL CHECK(slot IN ('next','previous')), ciphertext bytea NOT NULL, nonce bytea NOT NULL,
 key_version int NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), tested_at timestamptz,
 PRIMARY KEY(provider_id,slot)
);
CREATE TABLE ai_config_activations(version int PRIMARY KEY REFERENCES ai_config_versions(version), activated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO ai_config_activations(version) SELECT version FROM ai_config_versions;
CREATE TABLE ai_eval_runs (
 id bigserial PRIMARY KEY, candidate_version int NOT NULL REFERENCES ai_config_versions(version),
 active_version int REFERENCES ai_config_versions(version), actor uuid REFERENCES users(id),
 candidate_score numeric NOT NULL, active_score numeric NOT NULL, hard_pass bool NOT NULL,
 tolerance numeric NOT NULL DEFAULT 0.05, details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE model_calls ADD COLUMN IF NOT EXISTS served_model text;
ALTER TABLE model_calls ADD COLUMN IF NOT EXISTS fallback_used bool NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS model_calls_ai_spend_owner ON model_calls(owner_id,created_at) INCLUDE(cost_usd);
CREATE INDEX IF NOT EXISTS model_calls_ai_spend_bot ON model_calls(bot_id,created_at) INCLUDE(cost_usd);
-- Pointer, catalog and slot mutations participate in cross-instance invalidation.
CREATE OR REPLACE FUNCTION ai_control_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='ai_config_state' THEN
  IF NEW.active_version IS NOT DISTINCT FROM OLD.active_version AND NEW.candidate_version IS NOT DISTINCT FROM OLD.candidate_version AND NEW.rollout_percent=OLD.rollout_percent AND NEW.kill_switch=OLD.kill_switch AND NEW.activation_epoch=OLD.activation_epoch THEN RETURN NEW; END IF;
  NEW.revision=OLD.revision+1; PERFORM pg_notify('ai_config','changed'); RETURN NEW;
 END IF;
 UPDATE ai_config_state SET revision=revision+1 WHERE id=1;
 PERFORM pg_notify('ai_config','changed'); RETURN NULL;
END $$;
CREATE TRIGGER ai_state_changed BEFORE UPDATE ON ai_config_state FOR EACH ROW EXECUTE FUNCTION ai_control_changed();
CREATE TRIGGER ai_catalog_changed AFTER INSERT OR UPDATE OR DELETE ON ai_model_catalog FOR EACH STATEMENT EXECUTE FUNCTION ai_control_changed();
CREATE TRIGGER ai_slots_changed AFTER INSERT OR UPDATE OR DELETE ON ai_provider_key_slots FOR EACH STATEMENT EXECUTE FUNCTION ai_control_changed();

-- Normalize legacy mutable wait/error identifiers without rewriting the audit trail.
UPDATE tasks SET waiting_reason='model_access_required' WHERE waiting_reason IN ('connect_openrouter','no_openrouter_key');
UPDATE tasks SET error_code='model_access_required' WHERE error_code='no_openrouter_key';
