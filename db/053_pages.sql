-- Pages are private, owner-scoped documents. Versions are append-only.
CREATE TABLE pages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
    title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
    kind text NOT NULL CHECK (kind IN ('report','dashboard','tracker','plan','other')),
    current_version int NOT NULL DEFAULT 1 CHECK (current_version > 0),
    share_mode text NOT NULL DEFAULT 'private' CHECK (share_mode IN ('private','link')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(id, owner_id)
);
CREATE INDEX pages_owner_updated ON pages(owner_id, updated_at DESC);
CREATE INDEX pages_chat ON pages(bot_id, conversation_id, updated_at DESC);
CREATE TABLE page_versions (
    page_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    version int NOT NULL CHECK (version > 0),
    source text NOT NULL CHECK (octet_length(source) <= 262144),
    author text NOT NULL CHECK (author IN ('bot','user')),
    added_lines int NOT NULL DEFAULT 0 CHECK (added_lines >= 0),
    removed_lines int NOT NULL DEFAULT 0 CHECK (removed_lines >= 0),
    summary text NOT NULL DEFAULT '' CHECK (length(summary) <= 500),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(page_id, version)
);
CREATE TABLE page_share_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    page_id uuid NOT NULL,
    owner_id uuid NOT NULL,
    token_hash text NOT NULL UNIQUE CHECK (length(token_hash)=64),
    created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    FOREIGN KEY(page_id, owner_id) REFERENCES pages(id, owner_id) ON DELETE CASCADE,
    CHECK(created_by=owner_id)
);
