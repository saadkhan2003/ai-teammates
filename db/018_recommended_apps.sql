-- Recommended apps so a fresh dev or test database is not an empty catalog.
INSERT INTO plugin_catalog (
    id, name, publisher, source_url, version, kind, transport, auth_type,
    category, risk, trust, label, check_status, tools, manifest, dedupe_key
) VALUES
    ('seed-notion', 'Notion', 'Notion', '', '1', 'builtin', '', 'oauth', 'Productivity', 'low', 'official', 'tested', 'passed', '[]'::jsonb, '{"description":"Notes, docs, and project wikis"}'::jsonb, 'seed:notion'),
    ('seed-slack', 'Slack', 'Slack', '', '1', 'builtin', '', 'oauth', 'Communication', 'low', 'official', 'tested', 'passed', '[]'::jsonb, '{"description":"Team messages and channels"}'::jsonb, 'seed:slack'),
    ('seed-gmail', 'Gmail', 'Google', '', '1', 'builtin', '', 'oauth', 'Communication', 'low', 'official', 'tested', 'passed', '[]'::jsonb, '{"description":"Email for this account"}'::jsonb, 'seed:gmail')
ON CONFLICT (id) DO NOTHING;
