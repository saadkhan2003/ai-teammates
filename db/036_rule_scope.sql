ALTER TABLE memories ADD COLUMN IF NOT EXISTS rule_scope text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='memories_rule_scope_check' AND conrelid='memories'::regclass) THEN
    ALTER TABLE memories ADD CONSTRAINT memories_rule_scope_check
  CHECK (rule_scope IS NULL OR (kind = 'rule' AND (rule_scope = 'channel:email' OR rule_scope = 'channel:slack' OR rule_scope = 'channel:chat' OR rule_scope ~ '^connector:[a-zA-Z0-9_.:-]{1,120}$')));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS memories_scoped_rules ON memories(bot_id, rule_scope, created_at DESC)
  WHERE kind = 'rule' AND status = 'active' AND deleted_at IS NULL;
