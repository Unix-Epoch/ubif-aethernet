/*
  Retrace (Oct 26, 2026): what a baseline item can still reach. The baseline froze Portal's label count per item (inv_item_counts.labels,
  sold included). A label can leave that list for good (Portal stops listing it) or be one Retrace drops on purpose (a B-<item>-… buyback
  whose history names BB0001: inv_ignored_labels), so the stored count can never reach the frozen one and the progress strip sat at 99%.
  inv_item_listed (migrations/2026-10-26-retrace-listed.sql) keeps the latest FULL label listing per item (retrace-api.js listedWrite):
  Portal's total then and how many of its labels Retrace can hold. A listing taken at or after the freeze lowers the item's target to that
  (never raises it: labels newer than the baseline aren't owed). Used by progress, the short-items list and Verify check 1.
  c = inv_item_counts, d = inv_item_listed (LISTED_JOIN_SQL).
*/
export const TARGET_LISTED = `CASE WHEN d.listed_at IS NOT NULL AND d.listed_at >= (SELECT counted_at FROM inv_baseline WHERE store = c.store) THEN MIN(c.labels, d.storable) ELSE c.labels END`;
export const LISTED_JOIN_SQL = 'LEFT JOIN inv_item_listed d ON d.store = c.store AND d.item = c.item';
