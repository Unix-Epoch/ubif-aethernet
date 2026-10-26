-- Oct 26, 2026: the parts sold on each work order (src/retrace-wo-parts.js). The tracker collector reads Portal's
-- GET /api/workorder/{wo}/salesorder/{csuCartId} for each sold WO (new ones as they sell, and a paced backfill of every stored one)
-- and the Worker keeps the part lines (inv_wo_parts) and which WOs are done (inv_wo_sold), so the backfill resumes and ends.
-- New tables only, safe to apply twice. Apply BEFORE deploying the Worker:
--   npx wrangler d1 execute aethernet-tracker --remote --file migrations/2026-10-26-retrace-wo-parts.sql
CREATE TABLE IF NOT EXISTS inv_wo_sold (
  store INTEGER NOT NULL, wo TEXT NOT NULL,
  cart_id TEXT,                        -- the WO's csuCartId (from the tracker's plain part)
  sales_order TEXT,                    -- the answer's salesId (FSO…)
  state TEXT NOT NULL,                 -- pending (handed out) | done | empty (no part lines) | failed (tried again) | gave_up (TRIES_MAX failures)
  lines INTEGER, labels INTEGER,       -- sales lines in the answer; part lines kept
  tries INTEGER NOT NULL DEFAULT 0,    -- failed reads in a row
  claimed_until TEXT, last_error TEXT,
  updated_at TEXT NOT NULL, done_at TEXT,
  PRIMARY KEY (store, wo)
);
CREATE TABLE IF NOT EXISTS inv_wo_parts (
  store INTEGER NOT NULL, wo TEXT NOT NULL,
  line TEXT NOT NULL,                  -- the sales line's lineId (else n<lineNumber>)
  label TEXT, item TEXT, sku TEXT, name TEXT,
  quantity REAL, price REAL, serial_status TEXT, line_type TEXT,
  sales_order TEXT, sold_at TEXT,      -- the answer's salesId and salesDate (else the WO's sold_at)
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (store, wo, line)
);
CREATE INDEX IF NOT EXISTS inv_wo_parts_label ON inv_wo_parts (store, label);
