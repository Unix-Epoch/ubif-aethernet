-- Linkshell (src/linkshell.js): pairings in progress and links between one Aethernet browser and one Linkpearl phone.
-- Additive only. Messages are not stored here: the link's Durable Object holds them, and only while the other end is offline.
CREATE TABLE IF NOT EXISTS linkshell_pairs (id TEXT PRIMARY KEY, store INTEGER NOT NULL, code_hash TEXT NOT NULL, pc_jwk TEXT NOT NULL, pc_name TEXT,
  agent_id TEXT, phone_jwk TEXT, link_id TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS linkshell_links (id TEXT PRIMARY KEY, store INTEGER NOT NULL, agent_id TEXT NOT NULL, pc_token_hash TEXT NOT NULL, pc_name TEXT,
  pc_jwk TEXT NOT NULL, phone_jwk TEXT NOT NULL, created_at TEXT NOT NULL, used_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS linkshell_links_agent ON linkshell_links (agent_id);
CREATE INDEX IF NOT EXISTS linkshell_links_store ON linkshell_links (store);
