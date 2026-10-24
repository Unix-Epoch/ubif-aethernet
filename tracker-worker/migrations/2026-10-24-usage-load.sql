-- Oct 24, 2026: Cloudflare and Portal load (src/usage.js): the daily counters behind the top of the admin Usage page.
-- New tables only, safe to apply twice. Apply BEFORE deploying the tracker and admin Workers (until then their counters
-- can't write and log a warning; nothing else is affected).
-- Apply: npx wrangler d1 execute aethernet-tracker --remote --file migrations/2026-10-24-usage-load.sql
CREATE TABLE IF NOT EXISTS usage_load (
  day TEXT NOT NULL,                   -- UTC day (Cloudflare's)
  area TEXT NOT NULL,                  -- collector | retrace_admin | tracker | other (src/usage.js areaOf)
  requests INTEGER NOT NULL DEFAULT 0,
  rows_read INTEGER NOT NULL DEFAULT 0,      -- D1 rows read / written by those requests (meta.rows_read / rows_written of each result)
  rows_written INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, area)
);
CREATE TABLE IF NOT EXISTS usage_size (
  day TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL               -- the tracker database's size, the newest meta.size_after seen that day
);
-- Retrace passes, per store and day: what the collector reports when a pass ends (POST /v1/:store/tracker/retrace/pass).
CREATE TABLE IF NOT EXISTS usage_pass (
  day TEXT NOT NULL, store INTEGER NOT NULL,
  passes INTEGER NOT NULL DEFAULT 0,
  portal_calls INTEGER NOT NULL DEFAULT 0, worker_calls INTEGER NOT NULL DEFAULT 0,
  seconds INTEGER NOT NULL DEFAULT 0,
  lookup_passes INTEGER NOT NULL DEFAULT 0, lookup_seconds INTEGER NOT NULL DEFAULT 0,   -- passes that ran the stock lookup, and its seconds
  PRIMARY KEY (day, store)
);
CREATE TABLE IF NOT EXISTS usage_browsers (
  day TEXT NOT NULL, store INTEGER NOT NULL,
  browser TEXT NOT NULL,               -- a random id each browser makes for itself (no name)
  PRIMARY KEY (day, store, browser)
);
