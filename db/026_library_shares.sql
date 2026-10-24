CREATE TABLE IF NOT EXISTS library_shares (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    item_id uuid NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
    revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS library_shares_item_idx ON library_shares(item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS library_shares_live_idx ON library_shares(expires_at) WHERE revoked_at IS NULL;
