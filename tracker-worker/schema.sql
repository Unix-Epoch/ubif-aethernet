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
