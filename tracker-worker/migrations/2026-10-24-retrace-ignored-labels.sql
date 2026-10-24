-- Oct 24, 2026: Retrace remembers the labels it dropped as not stock (src/retrace-api.js POST /retrace/history, tombstones).
-- A buyback label (B-<number>-<digits>) whose serial history names BB0001 as its current item is deleted with its rows; before this table
-- nothing remembered that, so the next sweep (a document that names the label) queued it again and read its history again, every pass.
-- New table only, safe to apply twice.
-- Apply: npx wrangler d1 execute aethernet-tracker --remote --file migrations/2026-10-24-retrace-ignored-labels.sql
CREATE TABLE IF NOT EXISTS inv_ignored_labels (
  store INTEGER NOT NULL,
  label TEXT NOT NULL,
  reason TEXT,                         -- 'item BB0001' (the item the newest history row named)
  at TEXT NOT NULL,                    -- when it was dropped
  PRIMARY KEY (store, label)
);
