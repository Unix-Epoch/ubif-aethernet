-- Push (src/push.js): one FCM token per phone, so Linkshell can wake it. Additive only.
CREATE TABLE IF NOT EXISTS push_tokens (agent_id TEXT PRIMARY KEY, platform TEXT NOT NULL, token TEXT NOT NULL, updated_at TEXT NOT NULL);
