-- Chat actions: replies and soft delete (quotes/replies live in messages.metadata.parts)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_message_id uuid REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS messages_reply_idx ON messages (reply_to_message_id) WHERE reply_to_message_id IS NOT NULL;
