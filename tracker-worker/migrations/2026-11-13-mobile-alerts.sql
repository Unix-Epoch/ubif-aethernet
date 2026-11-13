-- Nov 13, 2026: Linkpearl alerts (src/mobile-alerts.js). Additive and idempotent: new tables and indexes only, no ALTER, nothing existing is touched.
-- Apply BEFORE deploying the tracker Worker build that has the alerts tick (the tick catches a missing table and does nothing, the routes answer 500 until it exists):
--   cd tracker-worker && npx wrangler d1 execute aethernet-tracker --remote --file=migrations/2026-11-13-mobile-alerts.sql
-- Needs 2026-11-13-mobile-devices.sql (agent_kind) applied first; the tick reads agents + agent_kind.

-- The alert feed, one row per condition per store. AUTOINCREMENT: ids are the poll cursor and are never reused after retention deletes.
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store INTEGER NOT NULL,
  type TEXT NOT NULL,                  -- stuck | pickup | followup | quiet | back (a quiet spell ended)
  subject TEXT NOT NULL,               -- the condition's key (de-duplication), see src/mobile-alerts.js
  level INTEGER NOT NULL DEFAULT 0,    -- the threshold this alert was raised for (days / hours / hour of day); a device sees its own level only
  wo INTEGER,                          -- work order number when there is one
  created_at TEXT NOT NULL,            -- ISO UTC
  data TEXT NOT NULL DEFAULT '{}',     -- JSON facts for the sentence (status, days, count, since, due): never a name, phone or e-mail
  backfill INTEGER NOT NULL DEFAULT 0, -- 1 = the condition was already old when first seen: feed only, never a notification
  cleared_at TEXT                      -- a quiet alert: scans resumed at this time
);
CREATE UNIQUE INDEX IF NOT EXISTS alerts_key ON alerts (store, type, subject, level);
CREATE INDEX IF NOT EXISTS alerts_feed ON alerts (store, id);
CREATE INDEX IF NOT EXISTS alerts_wo ON alerts (store, wo, type) WHERE wo IS NOT NULL;
CREATE INDEX IF NOT EXISTS alerts_at ON alerts (created_at);
CREATE INDEX IF NOT EXISTS alerts_open_quiet ON alerts (store) WHERE type = 'quiet' AND cleared_at IS NULL;

-- Per phone: its settings (JSON overrides of the defaults) and a read cursor: everything at or below read_upto is read.
CREATE TABLE IF NOT EXISTS alert_device (
  device_id TEXT PRIMARY KEY,          -- agents.id of the phone
  settings TEXT NOT NULL DEFAULT '{}',
  read_upto INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);

-- Individual reads above the cursor (a tap on one alert). "Mark all read" moves read_upto and clears these. Trimmed with the alerts they point at.
CREATE TABLE IF NOT EXISTS alert_reads (
  device_id TEXT NOT NULL,
  alert_id INTEGER NOT NULL,
  PRIMARY KEY (device_id, alert_id)
) WITHOUT ROWID;
