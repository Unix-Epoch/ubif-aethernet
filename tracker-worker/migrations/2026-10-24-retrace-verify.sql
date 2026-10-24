-- Oct 24, 2026: Retrace's coverage check (src/retrace-verify.js): the last result per store and the spot check's ticks.
-- New tables only, safe to apply twice.
-- Apply: npx wrangler d1 execute aethernet-tracker --remote --file migrations/2026-10-24-retrace-verify.sql
CREATE TABLE IF NOT EXISTS inv_verify (
  store INTEGER PRIMARY KEY,
  checked_at TEXT NOT NULL,            -- the last run (on demand, or when the baseline froze)
  result TEXT NOT NULL                 -- JSON: checks 1 to 4, the spot sample (labels), items still to hand the collector; capped at 60000 chars
);
-- Spot check: a person compared a sampled label's timeline with Portal's own and ticked it (matches 1; unticked = 0).
CREATE TABLE IF NOT EXISTS inv_verify_ticks (
  store INTEGER NOT NULL, label TEXT NOT NULL,
  checked_by TEXT NOT NULL, checked_at TEXT NOT NULL,
  matches INTEGER NOT NULL,
  PRIMARY KEY (store, label)
);
