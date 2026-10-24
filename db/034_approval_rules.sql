-- Unified approval-rule schema. Shell command shapes use the same editable matcher
-- lifecycle as host, recipient and path rules; no separate owner-wide allow path.
CREATE TABLE IF NOT EXISTS approval_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id uuid REFERENCES bots(id) ON DELETE CASCADE,
  action_class text NOT NULL,
  tool text NOT NULL,
  matcher jsonb NOT NULL CHECK (jsonb_typeof(matcher) = 'object'),
  action text CHECK (action IS NULL OR action = 'shell'),
  shape_hash char(64),
  effect text NOT NULL DEFAULT 'allow' CHECK (effect = 'allow'),
  created_from_approval_id uuid REFERENCES approvals(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  use_count bigint NOT NULL DEFAULT 0,
  revoked_at timestamptz
);
