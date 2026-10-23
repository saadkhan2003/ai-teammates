CREATE TABLE IF NOT EXISTS feedback (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category text NOT NULL DEFAULT 'general',
    message text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT feedback_message_length CHECK (length(message) BETWEEN 1 AND 5000)
);
CREATE INDEX IF NOT EXISTS feedback_owner_created_idx ON feedback(owner_user_id, created_at DESC);
