-- Nov 13, 2026: the phone app's "recently closed" list filters closed work orders by close time.
CREATE INDEX IF NOT EXISTS wo_closed ON workorders (store, is_open, closed_at);
