-- Oct 12, 2026: per-store settings set by managers in Aethernet (first: the store's general managers, for
-- Tactician's sales per labor hour; Store setup will set it too).
CREATE TABLE IF NOT EXISTS store_settings (
  store INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  updated_by TEXT, updated_at TEXT,
  PRIMARY KEY (store, key)
);
