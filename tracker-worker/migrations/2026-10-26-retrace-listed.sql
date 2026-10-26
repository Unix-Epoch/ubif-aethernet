-- Oct 26, 2026: Retrace's latest full label listing per item (src/retrace-listed.js). The baseline froze Portal's label count per item; a label
-- Portal stops listing, or one Retrace drops on purpose (a BB0001 buyback), kept the progress strip at 99% and Verify check 1 one short forever.
-- The collector sends each item's full listing (sweep `listed`); this keeps Portal's total then and how many of its labels Retrace can hold.
-- New table only, safe to apply twice. Apply BEFORE deploying the Worker (progress and Verify fall back to the frozen counts without it):
--   npx wrangler d1 execute aethernet-tracker --remote --file migrations/2026-10-26-retrace-listed.sql
CREATE TABLE IF NOT EXISTS inv_item_listed (
  store INTEGER NOT NULL, item TEXT NOT NULL,
  total INTEGER NOT NULL,              -- the listing's @odata.count (sold included)
  storable INTEGER NOT NULL,           -- labels in that listing Retrace can hold (not in inv_ignored_labels)
  listed_at TEXT NOT NULL,             -- when the listing was delivered (the sweep's time)
  PRIMARY KEY (store, item)
);
