-- Nov 16, 2026: Linkpearl alerts, the `unlinked` type (src/mobile-alerts.js). Additive and idempotent: one new table, nothing existing is touched.
-- Apply BEFORE deploying the tracker Worker build that has the digest / unlinked / coverage alerts (without it the unlinked rule logs and skips;
-- the other rules are unaffected):
--   cd tracker-worker && npx wrangler d1 execute aethernet-tracker --remote --file=migrations/2026-11-16-mobile-alerts-items.sql
-- Needs 2026-11-13-mobile-alerts.sql applied first.

-- The things a grouped alert was about, one row per thing, so the same thing never alerts twice at a level (an `unlinked` alert lists several
-- sales orders; each sales order is remembered here). Kept past the alerts' 60-day retention (an old sales order still without a work order
-- must not alert again); the hourly housekeeping drops a row once its sales order has a work order or has left Retrace's list (inv_so_need).
CREATE TABLE IF NOT EXISTS alert_items (
  store INTEGER NOT NULL,
  type TEXT NOT NULL,                  -- unlinked
  level INTEGER NOT NULL,              -- the threshold it was alerted at (hours)
  item TEXT NOT NULL,                  -- the sales order number
  alert_id INTEGER NOT NULL,           -- the alert that listed it
  PRIMARY KEY (store, type, level, item)
) WITHOUT ROWID;
