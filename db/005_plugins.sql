-- One plugin registry. MCP servers, OpenAPI APIs, built-ins, and OAuth apps are rows here.
-- The connectors view keeps old reads of the previous table working. There is no second subsystem.

ALTER TABLE connectors RENAME TO plugins;
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS bot_id uuid REFERENCES bots(id) ON DELETE CASCADE;
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS transport text NOT NULL DEFAULT '';
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS manifest jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS auth_type text NOT NULL DEFAULT 'none';
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT '';
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS risk text NOT NULL DEFAULT 'unknown';
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS trust text NOT NULL DEFAULT 'community';
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS label text NOT NULL DEFAULT 'listed';
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'installed';
ALTER TABLE plugins DROP CONSTRAINT IF EXISTS plugins_auth_chk;
ALTER TABLE plugins DROP CONSTRAINT IF EXISTS plugins_label_chk;
ALTER TABLE plugins DROP CONSTRAINT IF EXISTS plugins_trust_chk;
ALTER TABLE plugins DROP CONSTRAINT IF EXISTS plugins_risk_chk;
ALTER TABLE plugins ADD CONSTRAINT plugins_auth_chk CHECK (auth_type IN ('none','api_key','oauth'));
ALTER TABLE plugins ADD CONSTRAINT plugins_label_chk CHECK (label IN ('listed','auto-checked','tested'));
ALTER TABLE plugins ADD CONSTRAINT plugins_trust_chk CHECK (trust IN ('community','official','verified'));
ALTER TABLE plugins ADD CONSTRAINT plugins_risk_chk CHECK (risk IN ('unknown','low','medium','high'));

CREATE VIEW connectors AS
SELECT id, owner_user_id, name, kind, secret_id, base_url, created_at
FROM plugins;

ALTER TABLE secrets DROP CONSTRAINT IF EXISTS secrets_type_chk;
ALTER TABLE secrets ADD CONSTRAINT secrets_type_chk CHECK (type IN (
    'API_KEY','PASSWORD','TOKEN','OAUTH_REFRESH_TOKEN','SSH_PRIVATE_KEY',
    'WEBHOOK_SECRET','DATABASE_CREDENTIAL','GENERIC','PLUGIN_CREDENTIAL'
));
