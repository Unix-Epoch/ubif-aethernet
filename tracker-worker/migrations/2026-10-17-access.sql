-- Oct 17, 2026: per-person access on the admin site (tracker-worker/src/access.js). Run in the same deploy as the gate.
-- Owners (TRACKER_OWNERS) need no change: they bypass every check.
ALTER TABLE people ADD COLUMN pages TEXT NOT NULL DEFAULT '["wos"]';
ALTER TABLE people ADD COLUMN details INTEGER NOT NULL DEFAULT 0;
ALTER TABLE people ADD COLUMN review INTEGER NOT NULL DEFAULT 0;
ALTER TABLE people ADD COLUMN updated_by TEXT;
ALTER TABLE people ADD COLUMN updated_at TEXT;
-- Everyone keeps what they can open today: every admin page was open to every Access user (plus Metrics, new),
-- and whoever holds key copies keeps customer details. Flagged for review; People itself is owners only from now on.
UPDATE people SET pages = '["wos","sales","metrics","data","usage","reports","auto","stores"]', review = 1, updated_by = 'system', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
UPDATE people SET details = 1 WHERE EXISTS (SELECT 1 FROM person_keys k WHERE k.email = people.email);
INSERT INTO access_log (email, action, detail, at)
  SELECT 'system', 'access:migrate', COUNT(*) || ' people kept what they could open before (every page they reached, People editing now owners only) · review flagged', strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM people;
