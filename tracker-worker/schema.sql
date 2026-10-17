-- Work order tracker (database "aethernet-tracker"). Every WO row carries its store.
-- Customer data only ever arrives sealed (src/crypto.js); everything in plain columns is safe to read.

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
  added_by TEXT, added_at TEXT, last_seen_at TEXT
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
  last_cart_value REAL, last_cart_tax REAL,  -- last non-empty cart (Portal empties it at sale): value before tax, partner credits ignored; its tax
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

-- Daily sales. Portal's sales history (authoritative) per store; days without it are
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
-- Tactician's sales per labor hour; Store setup will set it too).
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
  end_at TEXT,                         -- left it (picked up / moved back); NULL = still there
  value REAL,                          -- cart value before tax, partner credits ignored (last seen while in RFP)
  PRIMARY KEY (store, wo, start_at)
);
CREATE INDEX IF NOT EXISTS rfp_open ON rfp_periods (store, end_at);
-- Portal's work order status names (from Portal's own code: ubif-util-store's status enum).
-- Status IDs alone appear in status histories (auditTrail) and change rows; join this table for names.
CREATE TABLE IF NOT EXISTS statuses (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
INSERT OR REPLACE INTO statuses (id, name) VALUES
  (1, 'Initial check-in'), (2, 'Need to order'), (3, 'Awaiting item'), (4, 'Awaiting device'), (5, 'Awaiting diagnostics'),
  (6, 'Awaiting partner approval'), (7, 'Awaiting callback'), (8, 'Ready for work'), (9, 'Diagnostics'), (10, 'Work in progress'),
  (11, 'Quality check'), (12, 'Repair summary'), (13, 'Ready for pickup'), (14, 'Sale complete'), (15, 'Closed'),
  (17, 'Device abandoned'), (22, 'Request buyout/replacement'), (23, 'Transferred to depot'), (24, 'Ready for Diag'),
  (25, 'Cancelled'), (26, 'Send to depot'), (27, 'Shipped by depot');

-- Oct 14, 2026: agents, programs that read the tracker on their own (the Mac's work order audit).
-- An agent has its own key pair; an admin's unlocked browser seals each granted store's key to it.
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,                 -- 32 hex, made by the agent
  name TEXT NOT NULL, public_jwk TEXT NOT NULL,
  token_hash TEXT NOT NULL,            -- sha256 hex of its token
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | active
  stores TEXT NOT NULL DEFAULT '[]',   -- JSON array of granted store ids
  created_at TEXT NOT NULL, approved_by TEXT, approved_at TEXT, last_seen_at TEXT, last_note TEXT,
  settings TEXT NOT NULL DEFAULT '{}',  -- audit settings set on the admin site (JSON; defaults filled when read)
  run_now INTEGER NOT NULL DEFAULT 0,   -- admin asked for a run now; the agent clears it with its report
  last_run TEXT                         -- JSON as last reported by the agent
);
CREATE TABLE IF NOT EXISTS agent_keys (
  agent_id TEXT NOT NULL, store INTEGER NOT NULL,
  wrapped TEXT NOT NULL,               -- the store's private key sealed to the agent's public key
  created_by TEXT, created_at TEXT,
  PRIMARY KEY (agent_id, store)
);

-- Oct 17, 2026: daily metrics, plain numbers uploaded by Aethernet (Tactician, Divination, Assize) for the admin Metrics page.
-- One row per store, day and metric (labor_hours, labor_hours_gm, headcount, am_orders, cleanings_linked, assize_fail, assize_flag, assize_note).
-- No customers, no staff names: `by_name` is only the uploader.
CREATE TABLE IF NOT EXISTS daily_metrics (store INTEGER NOT NULL, day TEXT NOT NULL, metric TEXT NOT NULL, value REAL NOT NULL, source TEXT, by_name TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (store, day, metric));
