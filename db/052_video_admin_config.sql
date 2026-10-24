CREATE TABLE IF NOT EXISTS video_admin_config (
    id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    vision_model text NOT NULL,
    transcription_model text NOT NULL,
    transcription_provider text NOT NULL,
    updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
