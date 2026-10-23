-- Per-domain grant for saved credentials. A row means the owner chose
-- "always allow for this domain" on a credential_use approval.

CREATE TABLE IF NOT EXISTS credential_domain_grants (
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    domain text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, domain),
    CONSTRAINT credential_domain_chk CHECK (domain ~ '^[a-z0-9.-]{1,253}$')
);
