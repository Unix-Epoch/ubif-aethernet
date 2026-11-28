-- Nov 24, 2026: each item's source (Distro, MS or Other) for order recommendations and reorder levels (src/retrace-source.js). Additive only.
-- NOT idempotent (ALTER TABLE): apply once, BEFORE deploying the tracker Worker (it writes the column).
-- Apply: npx wrangler d1 execute aethernet-tracker --remote --file migrations/2026-11-24-retrace-source.sql
-- The vendor account on the label (Portal's Vendor: "1" Distro, "6920" MobileSentrix).
ALTER TABLE inv_labels ADD COLUMN vendor TEXT;
-- One row per item number, shared by every store (an item number only ever comes from one source).
-- manual: set by hand on the admin site, wins over the rules. auto: what the rules decided (NULL = they couldn't); conflict: the evidence disagrees.
CREATE TABLE IF NOT EXISTS inv_item_source (
  item TEXT PRIMARY KEY,
  manual TEXT, manual_by TEXT, manual_at TEXT,      -- distro | ms | other
  auto TEXT, auto_basis TEXT,                       -- distro | ms | other · vendor | po | name
  conflict INTEGER NOT NULL DEFAULT 0,
  evidence TEXT,                                    -- JSON { vendors: [{ vendor, n }], pos: [{ id, distro, vendor }], ms }
  auto_at TEXT
);
-- Per store: ordering is paused while any in-scope item has no source (or a conflict). pushed_at: the Linkpearl push for this pause went out.
CREATE TABLE IF NOT EXISTS inv_source_pause (
  store INTEGER PRIMARY KEY,
  unmarked INTEGER NOT NULL DEFAULT 0,
  paused_at TEXT, pushed_at TEXT, checked_at TEXT
);
