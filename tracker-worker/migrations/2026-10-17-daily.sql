-- Oct 17, 2026: daily metrics, plain numbers uploaded by Aethernet (Tactician, Divination, Assize) for the admin Metrics page.
-- One row per store, day and metric (labor_hours, labor_hours_gm, headcount, am_orders, cleanings_linked, assize_fail, assize_flag, assize_note).
-- No customers, no staff names: `by_name` is only the uploader.
CREATE TABLE IF NOT EXISTS daily_metrics (store INTEGER NOT NULL, day TEXT NOT NULL, metric TEXT NOT NULL, value REAL NOT NULL, source TEXT, by_name TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (store, day, metric));
