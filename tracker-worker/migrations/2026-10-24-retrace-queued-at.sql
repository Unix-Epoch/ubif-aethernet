-- Oct 24, 2026: when a label was last queued for a history read (src/retrace-api.js touchLabel / the sweep / POST /retrace/history).
-- A history read that began before it (the label was claimed, then a sweep or a movement named it again) no longer clears the queue.
-- NOT idempotent (ALTER TABLE): apply once. The column is NULL for every label already stored, which reads as "never re-queued".
-- Apply BEFORE deploying the tracker Worker (it writes the column): npx wrangler d1 execute aethernet-tracker --remote --file migrations/2026-10-24-retrace-queued-at.sql
ALTER TABLE inv_labels ADD COLUMN queued_at TEXT;
