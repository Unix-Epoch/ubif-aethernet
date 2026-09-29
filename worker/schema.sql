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
