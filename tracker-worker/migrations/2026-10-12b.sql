-- Oct 12, 2026: daily sales. Portal's sales history (authoritative) per store; days without it are
-- estimated from work orders that reached Sale complete (their last cart before checkout).
CREATE TABLE IF NOT EXISTS sales (
  store INTEGER NOT NULL,
  sale_id TEXT NOT NULL,
  wo INTEGER,                          -- NULL for a sale without a work order (quick sale)
  sale_day TEXT NOT NULL,              -- the store's local business day (YYYY-MM-DD)
  sale_at TEXT,                        -- Portal's saleCompleteDateTime (UTC)
  type TEXT,                           -- Sale / Return
  total REAL, partner_credits REAL, paid REAL,
  completed_by TEXT,                   -- staff member (not a customer)
  program TEXT, device TEXT,
  items TEXT,                          -- JSON: the WO's last cart lines before checkout (Portal empties carts at sale)
  card TEXT,                           -- sealed: customer id + name
  source TEXT NOT NULL,                -- portal | mac
  hash TEXT, seen_at TEXT,
  PRIMARY KEY (store, sale_id)
);
CREATE INDEX IF NOT EXISTS sales_day ON sales (store, sale_day);
-- Which days have Portal's own list (so the rest can be estimated).
CREATE TABLE IF NOT EXISTS sales_days (
  store INTEGER NOT NULL, day TEXT NOT NULL,
  source TEXT NOT NULL, synced_at TEXT, count INTEGER, total REAL,
  PRIMARY KEY (store, day)
);
-- For estimates: each WO's last non-empty cart (value before tax, partner credits ignored + its tax) and
-- when it reached Sale complete (from its status history).
ALTER TABLE workorders ADD COLUMN last_cart_value REAL;
ALTER TABLE workorders ADD COLUMN last_cart_tax REAL;
ALTER TABLE workorders ADD COLUMN sold_at TEXT;
