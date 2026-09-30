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
  removed_at TEXT,                       -- × removes; the row stays so it isn't re-created
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
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS feedback_by_status ON feedback (status, id);
CREATE TABLE IF NOT EXISTS usage (       -- feature use: one counter per day, store, person, feature
  day TEXT NOT NULL, store INTEGER NOT NULL, store_name TEXT, user_id INTEGER NOT NULL, user_name TEXT,
  feature TEXT NOT NULL, count INTEGER NOT NULL,
  PRIMARY KEY (day, store, user_id, feature)
);
