-- Oct 17, 2026: Metrics page (admin site). When each WO sat in each status, for "Open work orders by status"
-- over time and "Need to order overnight" (WOs in Need to order at store close). Open statuses only: Sale
-- complete / Closed / Cancelled end the last interval. Kept from each WO upload (src/metrics.js
-- statusPeriodStmts); filled once for stored WOs by POST /api/tracker/metrics/backfill (the Metrics page's
-- "Build status history" button), which reads the plain status history (auditTrail, else `changes`).
CREATE TABLE IF NOT EXISTS status_periods (
  store INTEGER NOT NULL, wo INTEGER NOT NULL,
  status_id INTEGER NOT NULL,
  start_at TEXT NOT NULL,              -- entered the status (UTC ISO)
  end_at TEXT,                         -- left it; NULL = still in it
  PRIMARY KEY (store, wo, start_at)
);
CREATE INDEX IF NOT EXISTS sp_end ON status_periods (store, end_at);
-- Metrics reads by time per store.
CREATE INDEX IF NOT EXISTS wo_created ON workorders (store, created_at);
CREATE INDEX IF NOT EXISTS rfp_start ON rfp_periods (store, start_at);
CREATE INDEX IF NOT EXISTS scans_at ON scans (store, at);
