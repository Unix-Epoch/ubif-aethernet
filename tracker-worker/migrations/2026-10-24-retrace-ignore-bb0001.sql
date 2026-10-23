-- Retrace: drop what was collected for BB0001 (Portal's generic buyback-device SKU) before it was ignored
-- (retrace.js IGNORED_ITEMS). Rows can be collected again from Portal's serial history if it's ever wanted.
-- Apply: npx wrangler d1 execute aethernet-tracker --remote --file migrations/2026-10-24-retrace-ignore-bb0001.sql
DELETE FROM inv_movements WHERE lower(item) = 'bb0001';
DELETE FROM inv_labels WHERE lower(item) = 'bb0001';
DELETE FROM inv_items WHERE lower(item) = 'bb0001';
