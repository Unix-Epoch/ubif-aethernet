-- Nov 13, 2026: Linkpearl, the phone app, registers as an agent (src/mobile-agent.js). This marks which agents are phones.
-- Additive and idempotent: one new table, no ALTER. Apply BEFORE deploying the tracker Worker that registers phones:
--   cd tracker-worker && npx wrangler d1 execute aethernet-tracker --remote --file=migrations/2026-11-13-mobile-devices.sql
-- A row exists only for phones; every other agent (the Mac audit) has none and behaves exactly as before. Removing a device deletes its row.
CREATE TABLE IF NOT EXISTS agent_kind (
  agent_id TEXT PRIMARY KEY,           -- agents.id
  kind TEXT NOT NULL,                  -- 'phone'
  created_at TEXT
);
