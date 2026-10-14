-- Oct 14, 2026: agents, programs that read the tracker on their own (the Mac's work order audit).
-- An agent has its own key pair; an admin's unlocked browser seals each granted store's key to it.
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,                 -- 32 hex, made by the agent
  name TEXT NOT NULL, public_jwk TEXT NOT NULL,
  token_hash TEXT NOT NULL,            -- sha256 hex of its token
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | active
  stores TEXT NOT NULL DEFAULT '[]',   -- JSON array of granted store ids
  created_at TEXT NOT NULL, approved_by TEXT, approved_at TEXT, last_seen_at TEXT, last_note TEXT,
  settings TEXT NOT NULL DEFAULT '{}',  -- audit settings set on the admin site (JSON; defaults filled when read)
  run_now INTEGER NOT NULL DEFAULT 0,   -- admin asked for a run now; the agent clears it with its report
  last_run TEXT                         -- JSON as last reported by the agent
);
CREATE TABLE IF NOT EXISTS agent_keys (
  agent_id TEXT NOT NULL, store INTEGER NOT NULL,
  wrapped TEXT NOT NULL,               -- the store's private key sealed to the agent's public key
  created_by TEXT, created_at TEXT,
  PRIMARY KEY (agent_id, store)
);
