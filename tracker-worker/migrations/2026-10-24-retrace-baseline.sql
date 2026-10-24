-- Oct 24, 2026: Retrace's frozen baseline, the denominators for its progress bar and the "initial gathering done" signal
-- (src/retrace-api.js progress / settle). New tables only, safe to apply twice.
-- Apply: npx wrangler d1 execute aethernet-tracker --remote --file migrations/2026-10-24-retrace-baseline.sql
-- Per item: how many labels Portal says it has at the store (store-products/{item}/inventory?pageSize=1&warehouseType=All: its
-- @odata.count, sold labels included). Written only until the store's baseline is frozen; the rows left then are the baseline's items.
CREATE TABLE IF NOT EXISTS inv_item_counts (
  store INTEGER NOT NULL, item TEXT NOT NULL,
  labels INTEGER NOT NULL,
  counted_at TEXT NOT NULL,
  PRIMARY KEY (store, item)
);
-- Per store: the totals every step of the gathering is measured against, set once.
CREATE TABLE IF NOT EXISTS inv_baseline (
  store INTEGER PRIMARY KEY,
  expected_items INTEGER, expected_labels INTEGER,   -- set together when the baseline freezes (counted_at); never changed after
  expected_pos INTEGER, pos_counted_at TEXT,         -- purchase orders (in transit + past), from Portal's list counts; may arrive before the freeze
  counted_at TEXT,                                   -- the baseline froze · NULL = still counting
  backfill_done_at TEXT,                             -- every step reached its total, once, for good (the manager popup's signal)
  created_at TEXT NOT NULL
);
