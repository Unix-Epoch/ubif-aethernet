-- Oct 12, 2026: when each WO sat on the RFP table (Ready for pickup) and its value then, for
-- Tactician's "if every RFP device were picked up" (the RFP table's value at the end of any day).
CREATE TABLE IF NOT EXISTS rfp_periods (
  store INTEGER NOT NULL, wo INTEGER NOT NULL,
  start_at TEXT NOT NULL,              -- reached Ready for pickup (Portal's rfpWorkorderStatusDate when known)
  end_at TEXT,                         -- left it (picked up / moved back); NULL = still there
  value REAL,                          -- cart value before tax, partner credits ignored (last seen while in RFP)
  PRIMARY KEY (store, wo, start_at)
);
CREATE INDEX IF NOT EXISTS rfp_open ON rfp_periods (store, end_at);
