CREATE TABLE IF NOT EXISTS approval_rules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action text NOT NULL CHECK (action = 'shell'),
    shape_hash char(64) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (owner_id, action, shape_hash)
);
