-- Work order tracker (database "aethernet-tracker"). Every WO row carries its store.
-- Customer data only ever arrives sealed (src/crypto.js) · everything in plain columns is safe to read.

CREATE TABLE IF NOT EXISTS master_key (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  public_jwk TEXT NOT NULL,
  created_by TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS store_keys (
  store INTEGER PRIMARY KEY,
  public_jwk TEXT NOT NULL,
  wrapped_private TEXT NOT NULL,       -- sealed to the master public key
  created_at TEXT
);
-- Who can search (admin site, behind Cloudflare Access). scope 'all' = every store.
CREATE TABLE IF NOT EXISTS people (
  email TEXT PRIMARY KEY,
  name TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('all', 'stores')),
  stores TEXT NOT NULL DEFAULT '[]',   -- JSON [914, ...] when scope = 'stores'
  added_by TEXT, added_at TEXT, last_seen_at TEXT,
  -- Oct 17, 2026: per-person access (admin-worker gate, tracker-worker/src/access.js). Owners (TRACKER_OWNERS) bypass all of it.
  pages TEXT NOT NULL DEFAULT '["wos"]',   -- JSON page ids: wos sales metrics data usage reports auto stores
  details INTEGER NOT NULL DEFAULT 0,      -- 1 = may open sealed customer details (gets key copies) · 0 = sealed fields stripped
  review INTEGER NOT NULL DEFAULT 0,       -- 1 = carried over by the access migration, an owner should trim it
  updated_by TEXT, updated_at TEXT
);
-- A person's copies of keys, locked with their passphrase (or a one-time invite code).
CREATE TABLE IF NOT EXISTS person_keys (
  email TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('master', 'store')),
  store INTEGER NOT NULL DEFAULT 0,
  salt TEXT NOT NULL, rounds INTEGER NOT NULL, wrapped TEXT NOT NULL,
  invite INTEGER NOT NULL DEFAULT 0,   -- 1 = locked with an invite code, not their passphrase yet
  created_by TEXT, created_at TEXT,
  PRIMARY KEY (email, kind, store)
);

CREATE TABLE IF NOT EXISTS workorders (
  store INTEGER NOT NULL,
  wo INTEGER NOT NULL,
  store_name TEXT,
  status_id INTEGER, status_name TEXT,
  program_id INTEGER, program_name TEXT,
  device TEXT,                         -- model only (no IMEI/serial)
  created_at TEXT, api_updated_at TEXT,
  is_open INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT, last_list_seen_at TEXT, missing_since TEXT,   -- last_list_seen_at: last time the list changed it (not every scan)
  last_detail_at TEXT, last_hash TEXT,
  claimed_until TEXT,                  -- a browser is fetching this WO's detail (others skip it)
  closed_at TEXT, closed_reason TEXT,
  cart_total REAL, cart_paid REAL, cart_due REAL,
  cart_value REAL,                     -- cart lines pre-tax, Partner Credit Tax Exempt (PCEXEMPT) ignored
  service_outcome TEXT,                -- Portal's outcome: Completed / Incomplete / Declined / No issue found (RFP complete vs incomplete)
  gone_seen_at TEXT,                   -- Portal's first 404 for it (closed only after a second one)
  last_cart_value REAL, last_cart_tax REAL,  -- last non-empty cart (Portal empties it at sale): value before tax, partner credits ignored · its tax
  sold_at TEXT,                        -- when it reached Sale complete (status history)
  plain TEXT,                          -- latest plain part (JSON)
  card TEXT,                           -- sealed search card: name, phones, emails, IMEI/serial, claim
  PRIMARY KEY (store, wo)
);
CREATE INDEX IF NOT EXISTS wo_open ON workorders (store, is_open, status_id);
CREATE INDEX IF NOT EXISTS wo_updated ON workorders (api_updated_at);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY,
  store INTEGER NOT NULL, wo INTEGER NOT NULL,
  fetched_at TEXT NOT NULL, trigger TEXT, by_name TEXT,
  hash TEXT NOT NULL,
  plain TEXT,                          -- JSON
  sealed TEXT                          -- the whole detail (workorder, audit trail, customer, notes, cart), sealed
);
CREATE INDEX IF NOT EXISTS snap_wo ON snapshots (store, wo, id);
CREATE INDEX IF NOT EXISTS snap_at ON snapshots (fetched_at);

-- Field-level changes in the plain part (sealed parts are compared after unlocking).
CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY,
  store INTEGER NOT NULL, wo INTEGER NOT NULL,
  changed_at TEXT NOT NULL, field TEXT NOT NULL, old TEXT, new TEXT,
  snapshot_id INTEGER
);
CREATE INDEX IF NOT EXISTS chg_wo ON changes (store, wo, id);
CREATE INDEX IF NOT EXISTS chg_at ON changes (changed_at);

CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY,
  store INTEGER NOT NULL, at TEXT NOT NULL, by_name TEXT,
  open_count INTEGER, new_count INTEGER, changed_count INTEGER, need_count INTEGER, note TEXT
);
CREATE INDEX IF NOT EXISTS scans_store ON scans (store, id);

-- Who looked at what on the admin site.
CREATE TABLE IF NOT EXISTS access_log (
  id INTEGER PRIMARY KEY,
  email TEXT, action TEXT, store INTEGER, wo INTEGER, detail TEXT, at TEXT
);
CREATE INDEX IF NOT EXISTS log_at ON access_log (at);

-- Daily sales. Portal's sales history (authoritative) per store · days without it are
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
-- Oct 12, 2026: per-store settings set by managers in Aethernet (first: the store's general managers, for
-- Tactician's sales per labor hour · Store setup will set it too).
CREATE TABLE IF NOT EXISTS store_settings (
  store INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  updated_by TEXT, updated_at TEXT,
  PRIMARY KEY (store, key)
);
-- Oct 12, 2026: when each WO sat on the RFP table (Ready for pickup) and its value then, for
-- Tactician's "if every RFP device were picked up" (the RFP table's value at the end of any day).
CREATE TABLE IF NOT EXISTS rfp_periods (
  store INTEGER NOT NULL, wo INTEGER NOT NULL,
  start_at TEXT NOT NULL,              -- reached Ready for pickup (Portal's rfpWorkorderStatusDate when known)
  end_at TEXT,                         -- left it (picked up / moved back) · NULL = still there
  value REAL,                          -- cart value before tax, partner credits ignored (last seen while in RFP)
  PRIMARY KEY (store, wo, start_at)
);
CREATE INDEX IF NOT EXISTS rfp_open ON rfp_periods (store, end_at);
-- Portal's work order status names (from Portal's own code: ubif-util-store's status enum).
-- Status IDs alone appear in status histories (auditTrail) and change rows · join this table for names.
CREATE TABLE IF NOT EXISTS statuses (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
INSERT OR REPLACE INTO statuses (id, name) VALUES
  (1, 'Initial check-in'), (2, 'Need to order'), (3, 'Awaiting item'), (4, 'Awaiting device'), (5, 'Awaiting diagnostics'),
  (6, 'Awaiting partner approval'), (7, 'Awaiting callback'), (8, 'Ready for work'), (9, 'Diagnostics'), (10, 'Work in progress'),
  (11, 'Quality check'), (12, 'Repair summary'), (13, 'Ready for pickup'), (14, 'Sale complete'), (15, 'Closed'),
  (17, 'Device abandoned'), (22, 'Request buyout/replacement'), (23, 'Transferred to depot'), (24, 'Ready for Diag'),
  (25, 'Cancelled'), (26, 'Send to depot'), (27, 'Shipped by depot');

-- Oct 14, 2026: agents, programs that read the tracker on their own (the Mac's work order audit).
-- An agent has its own key pair · an admin's unlocked browser seals each granted store's key to it.
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,                 -- 32 hex, made by the agent
  name TEXT NOT NULL, public_jwk TEXT NOT NULL,
  token_hash TEXT NOT NULL,            -- sha256 hex of its token
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | active
  stores TEXT NOT NULL DEFAULT '[]',   -- JSON array of granted store ids
  created_at TEXT NOT NULL, approved_by TEXT, approved_at TEXT, last_seen_at TEXT, last_note TEXT,
  settings TEXT NOT NULL DEFAULT '{}',  -- audit settings set on the admin site (JSON · defaults filled when read)
  run_now INTEGER NOT NULL DEFAULT 0,   -- admin asked for a run now · the agent clears it with its report
  last_run TEXT                         -- JSON as last reported by the agent
);
CREATE TABLE IF NOT EXISTS agent_keys (
  agent_id TEXT NOT NULL, store INTEGER NOT NULL,
  wrapped TEXT NOT NULL,               -- the store's private key sealed to the agent's public key
  created_by TEXT, created_at TEXT,
  PRIMARY KEY (agent_id, store)
);

-- Oct 17, 2026: Metrics page. When each WO sat in each (open) status · kept from each WO upload (src/metrics.js).
CREATE TABLE IF NOT EXISTS status_periods (
  store INTEGER NOT NULL, wo INTEGER NOT NULL,
  status_id INTEGER NOT NULL,
  start_at TEXT NOT NULL,              -- entered the status (UTC ISO)
  end_at TEXT,                         -- left it · NULL = still in it
  PRIMARY KEY (store, wo, start_at)
);
CREATE INDEX IF NOT EXISTS sp_end ON status_periods (store, end_at);
CREATE INDEX IF NOT EXISTS wo_created ON workorders (store, created_at);
CREATE INDEX IF NOT EXISTS rfp_start ON rfp_periods (store, start_at);
CREATE INDEX IF NOT EXISTS scans_at ON scans (store, at);
-- Oct 17, 2026: daily metrics, plain numbers uploaded by Aethernet (Tactician, Divination, Assize) for the admin Metrics page.
-- One row per store, day and metric (labor_hours, labor_hours_gm, headcount, am_orders, cleanings_linked, assize_fail, assize_flag, assize_note).
-- No customers, no staff names: `by_name` is only the uploader.
CREATE TABLE IF NOT EXISTS daily_metrics (store INTEGER NOT NULL, day TEXT NOT NULL, metric TEXT NOT NULL, value REAL NOT NULL, source TEXT, by_name TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (store, day, metric));
-- Oct 21, 2026: Assize rules as node graphs, edited and published on the admin site (page 'rules' · src/assize.js).
-- One row per rule and scope: 'all' (every store) or a store number as text ('914', that store's override).
CREATE TABLE IF NOT EXISTS assize_rules (
  rule TEXT NOT NULL,                  -- kebab-case rule id (Assize's code rules, or a graph-only rule made on the admin site)
  scope TEXT NOT NULL,                 -- 'all' or a store number as text
  draft TEXT,                          -- graph JSON being edited · NULL = none
  draft_errors TEXT,                   -- JSON list of the draft's errors (drafts may be invalid · publishing refuses them)
  draft_by TEXT, draft_at TEXT,
  published TEXT,                      -- graph JSON Assize runs · NULL = the code rule (or nothing, for a graph-only rule)
  published_version INTEGER NOT NULL DEFAULT 0,
  published_by TEXT, published_at TEXT,
  enabled INTEGER,                     -- 1 on, 0 off (raises nothing, code or graph), NULL = follow 'all' (for 'all': on)
  note TEXT,
  created_by TEXT, created_at TEXT,
  PRIMARY KEY (rule, scope)
);
-- Every publish (with its graph, so any version can come back) and every other change to a rule.
CREATE TABLE IF NOT EXISTS assize_rule_history (
  id INTEGER PRIMARY KEY,
  rule TEXT NOT NULL, scope TEXT NOT NULL,
  version INTEGER,                     -- publish: the new version · revert: the version copied into the draft
  graph TEXT,                          -- publish: the graph published · NULL for the other actions
  by_email TEXT, at TEXT NOT NULL, note TEXT,
  action TEXT NOT NULL                 -- publish | revert | delete | enable | disable | inherit | create
);
CREATE INDEX IF NOT EXISTS arh_rule ON assize_rule_history (rule, id);
-- Oct 23, 2026: Retrace, the inventory movement ledger (src/retrace.js, src/retrace-api.js).
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
  queued_at TEXT,                      -- last time a sweep / movement queued it (a read claimed before this doesn't clear need_history)
  PRIMARY KEY (store, label)
);
CREATE INDEX IF NOT EXISTS inv_labels_need ON inv_labels (store, need_history, last_seen);
CREATE INDEX IF NOT EXISTS inv_labels_item ON inv_labels (store, item);
-- Labels dropped as not stock (history's current item BB0001): never queued, touched or stored again (migrations/2026-10-24-retrace-ignored-labels.sql).
CREATE TABLE IF NOT EXISTS inv_ignored_labels (
  store INTEGER NOT NULL,
  label TEXT NOT NULL,
  reason TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (store, label)
);
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
-- Oct 24, 2026: Retrace's frozen baseline (migrations/2026-10-24-retrace-baseline.sql): the totals the gathering is measured against.
CREATE TABLE IF NOT EXISTS inv_item_counts (
  store INTEGER NOT NULL, item TEXT NOT NULL,
  labels INTEGER NOT NULL,             -- Portal's label count for the item at the store (sold included), read while counting
  counted_at TEXT NOT NULL,
  PRIMARY KEY (store, item)
);
CREATE TABLE IF NOT EXISTS inv_baseline (
  store INTEGER PRIMARY KEY,
  expected_items INTEGER, expected_labels INTEGER,   -- set together when the baseline freezes (counted_at); never changed after
  expected_pos INTEGER, pos_counted_at TEXT,         -- purchase orders (in transit + past), from Portal's list counts; may arrive before the freeze
  counted_at TEXT,                     -- the baseline froze · NULL = still counting
  backfill_done_at TEXT,               -- every step reached its total, once, for good (the manager popup's signal)
  created_at TEXT NOT NULL
);
-- Oct 24, 2026: Retrace's coverage check (migrations/2026-10-24-retrace-verify.sql): the last result per store and the spot check's ticks.
CREATE TABLE IF NOT EXISTS inv_verify (
  store INTEGER PRIMARY KEY,
  checked_at TEXT NOT NULL,            -- the last run (on demand, or when the baseline froze)
  result TEXT NOT NULL                 -- JSON: checks 1 to 4, the spot sample (labels), items still to hand the collector; capped at 60000 chars
);
-- Spot check: a person compared a sampled label's timeline with Portal's own and ticked it (matches 1; unticked = 0).
CREATE TABLE IF NOT EXISTS inv_verify_ticks (
  store INTEGER NOT NULL, label TEXT NOT NULL,
  checked_by TEXT NOT NULL, checked_at TEXT NOT NULL,
  matches INTEGER NOT NULL,
  PRIMARY KEY (store, label)
);
-- Oct 24, 2026: Cloudflare and Portal load (migrations/2026-10-24-usage-load.sql): daily counters for the admin Usage page (src/usage.js).
CREATE TABLE IF NOT EXISTS usage_load (
  day TEXT NOT NULL,                   -- UTC day (Cloudflare's)
  area TEXT NOT NULL,                  -- collector | retrace_admin | tracker | other (src/usage.js areaOf)
  requests INTEGER NOT NULL DEFAULT 0,
  rows_read INTEGER NOT NULL DEFAULT 0,      -- D1 rows read / written by those requests (meta.rows_read / rows_written of each result)
  rows_written INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, area)
);
CREATE TABLE IF NOT EXISTS usage_size (
  day TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL               -- the tracker database's size, the newest meta.size_after seen that day
);
-- Retrace passes, per store and day: what the collector reports when a pass ends (POST /v1/:store/tracker/retrace/pass).
CREATE TABLE IF NOT EXISTS usage_pass (
  day TEXT NOT NULL, store INTEGER NOT NULL,
  passes INTEGER NOT NULL DEFAULT 0,
  portal_calls INTEGER NOT NULL DEFAULT 0, worker_calls INTEGER NOT NULL DEFAULT 0,
  seconds INTEGER NOT NULL DEFAULT 0,
  lookup_passes INTEGER NOT NULL DEFAULT 0, lookup_seconds INTEGER NOT NULL DEFAULT 0,   -- passes that ran the stock lookup, and its seconds
  PRIMARY KEY (day, store)
);
CREATE TABLE IF NOT EXISTS usage_browsers (
  day TEXT NOT NULL, store INTEGER NOT NULL,
  browser TEXT NOT NULL,               -- a random id each browser makes for itself (no name)
  PRIMARY KEY (day, store, browser)
);
-- Oct 25, 2026: sales-order link backfill (migrations/2026-10-25-retrace-so-need.sql).
CREATE TABLE IF NOT EXISTS inv_so_need (
  store INTEGER NOT NULL, sales_order TEXT NOT NULL,
  claimed_until TEXT,                  -- handed to a browser until then (a failed read comes back after it)
  none_at TEXT,                        -- label details were read for real and carried no WorkOrderId for this sales order
  PRIMARY KEY (store, sales_order)
);
-- Oct 26, 2026: latest full label listing per item (migrations/2026-10-26-retrace-listed.sql, src/retrace-listed.js).
CREATE TABLE IF NOT EXISTS inv_item_listed (
  store INTEGER NOT NULL, item TEXT NOT NULL,
  total INTEGER NOT NULL,              -- the listing's @odata.count (sold included)
  storable INTEGER NOT NULL,           -- labels in that listing Retrace can hold (not in inv_ignored_labels)
  listed_at TEXT NOT NULL,             -- when the listing was delivered (the sweep's time)
  PRIMARY KEY (store, item)
);
