-- Per-user appearance. System is the default and follows the OS colour scheme.

CREATE TABLE IF NOT EXISTS user_preferences (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    theme text NOT NULL DEFAULT 'system',
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT user_preferences_theme_chk CHECK (theme IN ('light', 'dark', 'system'))
);
