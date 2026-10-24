-- Upgrade either historical approval_rules layout to the unified schema.
-- Also works when the unified CREATE migration has already run.
ALTER TABLE approval_rules ADD COLUMN IF NOT EXISTS bot_id uuid REFERENCES bots(id) ON DELETE CASCADE;
ALTER TABLE approval_rules ADD COLUMN IF NOT EXISTS action_class text;
ALTER TABLE approval_rules ADD COLUMN IF NOT EXISTS tool text;
ALTER TABLE approval_rules ADD COLUMN IF NOT EXISTS matcher jsonb;
ALTER TABLE approval_rules ADD COLUMN IF NOT EXISTS action text CHECK (action IS NULL OR action = 'shell');
ALTER TABLE approval_rules ADD COLUMN IF NOT EXISTS shape_hash char(64);
ALTER TABLE approval_rules ADD COLUMN IF NOT EXISTS effect text NOT NULL DEFAULT 'allow' CHECK (effect = 'allow');
ALTER TABLE approval_rules ADD COLUMN IF NOT EXISTS created_from_approval_id uuid REFERENCES approvals(id) ON DELETE SET NULL;
ALTER TABLE approval_rules ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE approval_rules ADD COLUMN IF NOT EXISTS last_used_at timestamptz;
ALTER TABLE approval_rules ADD COLUMN IF NOT EXISTS use_count bigint NOT NULL DEFAULT 0;
ALTER TABLE approval_rules ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE approval_rules ALTER COLUMN action DROP NOT NULL;
ALTER TABLE approval_rules ALTER COLUMN shape_hash DROP NOT NULL;
-- Preserve c4 shell grants in the editable/audited lifecycle. Matching still
-- rechecks class, shell syntax, DLP, personal policy and peer provenance.
UPDATE approval_rules SET action_class='write', tool='shell',
  matcher=jsonb_build_object('kind','command','sha256',trim(shape_hash))
WHERE action='shell' AND shape_hash IS NOT NULL AND matcher IS NULL;
ALTER TABLE approval_rules ALTER COLUMN action_class SET NOT NULL;
ALTER TABLE approval_rules ALTER COLUMN tool SET NOT NULL;
ALTER TABLE approval_rules ALTER COLUMN matcher SET NOT NULL;
CREATE INDEX IF NOT EXISTS approval_rules_owner_active ON approval_rules(owner_id, bot_id) WHERE revoked_at IS NULL;
