CREATE TABLE IF NOT EXISTS approval_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id uuid REFERENCES bots(id) ON DELETE CASCADE,
  action_class text NOT NULL,
  tool text NOT NULL,
  matcher jsonb NOT NULL,
  effect text NOT NULL DEFAULT 'allow' CHECK (effect = 'allow'),
  created_from_approval_id uuid REFERENCES approvals(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  use_count bigint NOT NULL DEFAULT 0,
  revoked_at timestamptz,
  CHECK (jsonb_typeof(matcher) = 'object')
);
CREATE INDEX IF NOT EXISTS approval_rules_owner_active ON approval_rules(owner_id, bot_id) WHERE revoked_at IS NULL;
