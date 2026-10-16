-- Waymark: shared work-order tags, one set per Portal store.
CREATE TABLE IF NOT EXISTS list (        -- the store's managed tag list
  store INTEGER NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL, pos INTEGER NOT NULL,
  PRIMARY KEY (store, name)
);
CREATE TABLE IF NOT EXISTS wo_tags (     -- tags on work orders (managed or one-off)
  store INTEGER NOT NULL, wo INTEGER NOT NULL, tag TEXT NOT NULL,
  by_name TEXT, by_id INTEGER, at TEXT NOT NULL,
  PRIMARY KEY (store, wo, tag)
);
CREATE TABLE IF NOT EXISTS wo_closed (   -- when Aethernet saw a tagged WO closed; cleanup 7 days later
  store INTEGER NOT NULL, wo INTEGER NOT NULL, closed_at TEXT NOT NULL,
  PRIMARY KEY (store, wo)
);
CREATE TABLE IF NOT EXISTS history (     -- our own log (not Portal notes)
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store INTEGER NOT NULL, wo INTEGER,    -- wo NULL = a change to the managed list
  action TEXT NOT NULL, tag TEXT, detail TEXT,
  by_name TEXT, by_id INTEGER, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS history_by_wo ON history (store, wo, id);
CREATE TABLE IF NOT EXISTS auto_marks (  -- Auto-Waymark: follow-up date set when a WO reaches Ready for pickup
  store INTEGER NOT NULL, wo INTEGER NOT NULL,
  due TEXT NOT NULL,                     -- YYYY-MM-DD, store-local
  created_at TEXT NOT NULL,
  removed_at TEXT,                       -- × removes; the row stays so it isn't re-created (until the WO leaves the status: /end deletes it)
  kind TEXT,                             -- rfp (Ready for pickup, NULL in old rows) | callback (Awaiting callback)
  PRIMARY KEY (store, wo)
);
CREATE TABLE IF NOT EXISTS feedback (    -- bug reports and suggestions from the Feedback button
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store INTEGER NOT NULL, store_name TEXT, user_id INTEGER, user_name TEXT,
  kind TEXT NOT NULL,                    -- 'bug' | 'idea'
  text TEXT NOT NULL,
  version TEXT, page TEXT, browser TEXT, diag TEXT,  -- diag: JSON (enabled crystals, recent Aethernet errors)
  status TEXT NOT NULL DEFAULT 'new',    -- new | planned | fixed | wontfix (admin only)
  note TEXT,                             -- admin's own note
  fixed_in TEXT, quote TEXT, credit TEXT,  -- quoted as fixed in that version's patch notes (credit: e.g. "G.Green")
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS feedback_by_status ON feedback (status, id);
CREATE TABLE IF NOT EXISTS usage (       -- feature use: one counter per day, store, person, feature
  day TEXT NOT NULL, store INTEGER NOT NULL, store_name TEXT, user_id INTEGER NOT NULL, user_name TEXT,
  feature TEXT NOT NULL, count INTEGER NOT NULL,
  PRIMARY KEY (day, store, user_id, feature)
);
CREATE TABLE IF NOT EXISTS store_access (  -- stores allowed to use Aethernet (admin panel → Stores)
  store INTEGER PRIMARY KEY, name TEXT, added_by TEXT, added_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS store_seen (    -- every store that has tried to load Aethernet
  store INTEGER PRIMARY KEY, name TEXT, first_at TEXT NOT NULL, last_at TEXT NOT NULL,
  loads INTEGER NOT NULL DEFAULT 0, last_user TEXT
);
CREATE TABLE IF NOT EXISTS cleaning_links (  -- Divination: a phone's cleanings that day, linked to an order by hand
  store INTEGER NOT NULL, day TEXT NOT NULL,  -- day: YYYY-MM-DD, store-local (the order's day)
  device TEXT NOT NULL,                       -- the cleaning's IMEI (or Aethernet's key for one without)
  parent INTEGER NOT NULL,                    -- the order (WO) they count for
  by_name TEXT, by_id INTEGER, at TEXT NOT NULL,
  PRIMARY KEY (store, day, device)
);
CREATE TABLE IF NOT EXISTS auto_rules (    -- Auto-Waymark rules beyond Ready for pickup: off | staged (new WOs only) | live (backfill too)
  rule TEXT PRIMARY KEY, state TEXT NOT NULL, staged_at TEXT, live_at TEXT
);
CREATE TABLE IF NOT EXISTS config (        -- Aethernet-wide settings from the admin panel (e.g. cleaningTarget), JSON values
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checkin_drafts (  -- Return: incomplete check-ins (customer details + passcode), deleted when finished or after 7 days
  store INTEGER NOT NULL, id TEXT NOT NULL, arrival_id INTEGER, wo_id INTEGER, step INTEGER NOT NULL, label TEXT, data TEXT NOT NULL,
  by_name TEXT, by_id INTEGER, at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (store, id)
);
CREATE INDEX IF NOT EXISTS checkin_drafts_arrival ON checkin_drafts (store, arrival_id);
CREATE TABLE IF NOT EXISTS sheets (          -- Provoke: a store's lead texts and Price sheet, pushed by the sync job (JSON)
  store INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, synced_at TEXT NOT NULL,
  PRIMARY KEY (store, kind)
);
CREATE TABLE IF NOT EXISTS tac_models (      -- Decipher: what a TAC (an IMEI's first 8 digits) is: model-level only, never an IMEI, serial or customer
  tac TEXT NOT NULL, device_model_id INTEGER NOT NULL, color TEXT NOT NULL DEFAULT '',  -- color '' = none recorded
  model_name TEXT NOT NULL, manufacturer TEXT,
  count INTEGER NOT NULL DEFAULT 1,          -- work orders (and confirmations) that say this TAC is this model + color; the most common model wins
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tac, device_model_id, color)
);
CREATE TABLE IF NOT EXISTS tac_stores (      -- which stores have recorded a TAC ("seen at N stores")
  tac TEXT NOT NULL, store INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (tac, store)
);
CREATE TABLE IF NOT EXISTS osmocom_tac (     -- Decipher: the Osmocom TAC database (CC BY-SA 3.0), imported once by import/osmocom.mjs; kept apart from tac_models, never merged into it
  tac TEXT PRIMARY KEY, brand TEXT, model TEXT
);
