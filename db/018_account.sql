ALTER TABLE users ADD COLUMN IF NOT EXISTS email text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS product_updates boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS user_identities (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider text NOT NULL,
    label text NOT NULL DEFAULT '',
    email text NOT NULL DEFAULT '',
    connected_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, provider)
);

CREATE TABLE IF NOT EXISTS billing_accounts (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    plan_id text NOT NULL DEFAULT 'free',
    credit_balance integer NOT NULL DEFAULT 500,
    credit_allowance integer NOT NULL DEFAULT 500,
    period_start timestamptz NOT NULL DEFAULT date_trunc('month', now()),
    provider text NOT NULL DEFAULT 'mock',
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoices (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    number text NOT NULL,
    plan_id text NOT NULL,
    amount_cents integer NOT NULL,
    currency text NOT NULL DEFAULT 'usd',
    status text NOT NULL DEFAULT 'paid',
    provider text NOT NULL DEFAULT 'mock',
    issued_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    email text NOT NULL,
    topic text NOT NULL,
    body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_settings (
    key text PRIMARY KEY,
    value text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform_settings (key, value) VALUES
    ('model_id', 'anthropic/claude-haiku-5.5'),
    ('model_label', 'Claude Haiku 5.5'),
    ('credit_allowances', '{"free":500,"pro":5000,"team":20000}')
ON CONFLICT (key) DO NOTHING;
