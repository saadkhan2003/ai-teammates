ALTER TABLE memories ADD COLUMN IF NOT EXISTS scope text;
ALTER TABLE memories ADD CONSTRAINT memories_rule_scope_check
  CHECK (scope IS NULL OR (kind = 'rule' AND (scope = 'channel:email' OR scope = 'channel:slack' OR scope = 'channel:chat' OR scope ~ '^connector:[a-zA-Z0-9_.:-]{1,120}$')));
CREATE INDEX IF NOT EXISTS memories_scoped_rules ON memories(bot_id, scope, created_at DESC)
  WHERE kind = 'rule' AND status = 'active' AND deleted_at IS NULL;
