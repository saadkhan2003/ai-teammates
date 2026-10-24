-- Additive reply quote. The schema_migrations id is the name, not a number, so it can be renumbered later.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to uuid REFERENCES messages(id) ON DELETE SET NULL;
