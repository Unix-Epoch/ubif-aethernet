-- Per-store write budgets (src/budget.js): counters per store, kind and UTC hour or day bucket. Additive and idempotent.
CREATE TABLE IF NOT EXISTS write_budget (
  store INTEGER NOT NULL, kind TEXT NOT NULL, bucket TEXT NOT NULL,   -- bucket: 'YYYY-MM-DDTHH' (hour) or 'YYYY-MM-DD' (day), UTC
  n INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (store, kind, bucket)
);
