-- Oct 23, 2026: Retrace, the inventory movement ledger (src/retrace.js, src/retrace-api.js). New tables only.
-- Apply: npx wrangler d1 execute aethernet-tracker --remote --file migrations/2026-10-23-retrace.sql
-- Every label Retrace has seen per store: its last snapshot (the diff baseline) and its place in the serial-history queue.
CREATE TABLE IF NOT EXISTS inv_labels (
  store INTEGER NOT NULL,
  label TEXT NOT NULL,                 -- Portal's SerialNumber on the label (176255-0000514371; buyback B-<item>-<digits>)
  item TEXT, product TEXT,             -- item number, product name
  serial_status TEXT,                  -- SerialStatus (Available, Reserved, In Transit, Sold, ...)
  consignment TEXT,                    -- ConsignmentStatus as Portal sends it: 'Yes' (consigned) / 'No' (owned)
  wh_type TEXT,                        -- WarehouseLocationType: Main | Quarantine | Lost | Van
  wh_id TEXT,                          -- warehouse id when Portal gives one
  cost REAL, po TEXT, wo TEXT, sales_order TEXT, arrival TEXT, oem_serial TEXT, imei TEXT,
  serial_modified TEXT,                -- Portal's SerialModified (store-products): newer than the last history read = read it again
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  last_change_at TEXT,                 -- last snapshot that differed from the one before
  last_history_at TEXT,                -- last serial-history read · NULL = never read
  history_hash TEXT,                   -- hash of the rows read then (same rows again = nothing to insert)
  need_history INTEGER NOT NULL DEFAULT 0,  -- 0 no · 1 backfill (never read) · 2 touched by a sweep / the watcher / a WO · 3 changed
  claimed_until TEXT,                  -- a browser is reading its history until then (others skip it)
  PRIMARY KEY (store, label)
);
CREATE INDEX IF NOT EXISTS inv_labels_need ON inv_labels (store, need_history, last_seen);
CREATE INDEX IF NOT EXISTS inv_labels_item ON inv_labels (store, item);
-- One row per movement of a label (or, label NULL, of an item: a WO parts event without a serial). Never trimmed.
-- kind / source / key: tracker-worker/src/retrace.js. key is the dedupe key: the same record read twice adds nothing.
CREATE TABLE IF NOT EXISTS inv_movements (
  id INTEGER PRIMARY KEY,
  store INTEGER NOT NULL,
  label TEXT, item TEXT,
  at TEXT NOT NULL,                    -- when it happened (UTC ISO)
  kind TEXT NOT NULL,                  -- received | reserved | unreserved | used | sold | ... | status_changed (unknown raw values)
  raw_status TEXT, raw_event TEXT,     -- Portal's own values, always kept
  ref_type TEXT, ref_id TEXT, ref_line TEXT,   -- the document: po | sales_order | journal | reason | wo | transfer | rma | ...
  from_wh TEXT, to_wh TEXT,
  user_name TEXT,                      -- who, when the source says (history User, WO event user, the signed-in tech for the watcher)
  source TEXT NOT NULL,                -- history | snapshot | wo | wo_event | transfer | count | rma | buyback | po | watch | sweep
  detail TEXT,                         -- short extra text (history Message, unmapped RefTable, product name, ...)
  key TEXT NOT NULL,
  recorded_at TEXT NOT NULL,           -- when the server got it
  UNIQUE (store, key)
);
CREATE INDEX IF NOT EXISTS inv_mv_item ON inv_movements (store, item, at);
CREATE INDEX IF NOT EXISTS inv_mv_label ON inv_movements (store, label, at);
CREATE INDEX IF NOT EXISTS inv_mv_ref ON inv_movements (store, ref_type, ref_id);
-- Per item: name, category and the last quantities per warehouse from inventory-lookup (the quantity diff's baseline).
CREATE TABLE IF NOT EXISTS inv_items (
  store INTEGER NOT NULL, item TEXT NOT NULL,
  name TEXT, category TEXT,
  qty TEXT,                            -- JSON { warehouseId: { onHand, available, reserved, inTransit, salesOnOrder, van } }
  qty_hash TEXT,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, changed_at TEXT,
  PRIMARY KEY (store, item)
);
-- Small document headers for linking and display: transfers, RMA / buyback orders, counts, POs, vans, arrivals.
CREATE TABLE IF NOT EXISTS inv_docs (
  store INTEGER NOT NULL, type TEXT NOT NULL, id TEXT NOT NULL,
  status TEXT, at TEXT, counterpart TEXT,   -- counterpart: the other store, the vendor, the van
  data TEXT,                           -- JSON of the header's small fields (a PO: retrace.js poState, with its lines and labels' receive status)
  need_detail INTEGER NOT NULL DEFAULT 0,   -- a PO whose lines / receive details should be (re)read (new, or its tracked fields changed)
  first_seen TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (store, type, id)
);
CREATE INDEX IF NOT EXISTS inv_docs_need ON inv_docs (store, type, need_detail, at);
-- A document's status history (POs so far): one row per tracked field that changed (header status, approval, quantities,
-- tracking, auto-receive; 'line <n> received|shipped|cancelled|ordered'; 'label <label>' receive status). retrace.js poEvents.
CREATE TABLE IF NOT EXISTS inv_doc_events (
  store INTEGER NOT NULL, type TEXT NOT NULL, id TEXT NOT NULL,
  at TEXT NOT NULL,                    -- when the change was seen (the server's time: Portal gives none)
  field TEXT NOT NULL, old TEXT, new TEXT,
  by_source TEXT,                      -- list (a PO list row) | detail (header + receive details)
  UNIQUE (store, type, id, at, field)
);
CREATE INDEX IF NOT EXISTS inv_doc_events_doc ON inv_doc_events (store, type, id, at);
-- Per store and sweep: where the browser's last pass got to (JSON: window, last ids, ...). 'last_sweep' is the server's own row.
CREATE TABLE IF NOT EXISTS inv_cursors (
  store INTEGER NOT NULL, sweep TEXT NOT NULL,
  value TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (store, sweep)
);
-- Sales order → WO. Serial history names a WO's sales order (FSO…) but leaves the WO number blank; this ties them,
-- from the tracker's WO uploads (csuSalesOrderId, the cart's salesId) and label details (SalesOrderNumber + WorkOrderId).
CREATE TABLE IF NOT EXISTS inv_so_wo (
  store INTEGER NOT NULL, sales_order TEXT NOT NULL,
  wo TEXT NOT NULL,
  source TEXT,                         -- wo | label
  updated_at TEXT NOT NULL,
  PRIMARY KEY (store, sales_order)
);
CREATE INDEX IF NOT EXISTS inv_so_wo_wo ON inv_so_wo (store, wo);
