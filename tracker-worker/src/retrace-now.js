/*
  Retrace: where a label stands NOW, in ONE place. Every reader (serials list and chips, item counts, items list, label drawer,
  PO labels, search, Verify) takes its status from here, so they can't drift.

  The rule (serialNow in retrace.js does the mapping):
    - the movement that counts is the label's latest STATUS-BEARING one: a kind in NOW_KIND. consignment_changed (consigned → owned)
      and status_changed (a raw status we couldn't map) don't change where a label stands, so they never hide an earlier Sold / Used /
      Transferred / Reserved ...
    - Portal's own status on the label (store-products SerialStatus) wins when the label was read after that movement.
    - 'Received' on a label is only the PO receive snapshot, never current: a later status-bearing movement beats it.
  Nothing stored is rewritten: this is all read-time.
*/
import { NOW_KIND, serialNow } from './retrace.js';

export const STATUS_MOVE_KINDS = Object.keys(NOW_KIND);
export const STATUS_MOVE_SQL = "('" + STATUS_MOVE_KINDS.join("', '") + "')"; // constants from this file only: safe to inline

// The label's latest status-bearing movement: col = 'kind' | 'at'. l = the inv_labels alias (store, label).
export const lastStatusSql = (col, l = 'l') => `(SELECT m.${col} FROM inv_movements m WHERE m.store = ${l}.store AND m.label = ${l}.label AND m.kind IN ${STATUS_MOVE_SQL} ORDER BY m.at DESC, m.id DESC LIMIT 1)`;
// Columns to add to a SELECT over inv_labels l (needs l.serial_status, l.wh_type, l.last_seen) so rowNow can work.
export const nowCols = (l = 'l') => `${lastStatusSql('kind', l)} AS now_kind, ${lastStatusSql('at', l)} AS now_at`;

// [text, group] for a row carrying serial_status, wh_type, last_seen, now_kind, now_at.
export const rowNow = (r) => serialNow(r.serial_status, r.wh_type, r.now_kind, !!r.last_seen && !!r.now_at && r.now_at > r.last_seen);

// Labels grouped by what they stand at now: one statement (for T.batch) and its row mapper. items = array of item numbers, or null for the whole store.
export function nowCountsStmt(T, store, items) {
  const sql = `SELECT l.item, l.serial_status, l.wh_type, l.wh_id, l.consignment, ${lastStatusSql('kind')} AS now_kind, (${lastStatusSql('at')} > l.last_seen) AS newer, COUNT(*) AS n
      FROM inv_labels l WHERE l.store = ?1 ${items ? 'AND l.item IN (SELECT value FROM json_each(?2))' : ''}
      GROUP BY l.item, l.serial_status, l.wh_type, l.wh_id, l.consignment, now_kind, newer`;
  return T.prepare(sql).bind(...(items ? [store, JSON.stringify(items)] : [store]));
}
export const nowCountsRows = (results) => results.map((r) => {
  const [now, group] = serialNow(r.serial_status, r.wh_type, r.now_kind, !!r.newer);
  return { item: r.item, serial_status: r.serial_status, wh_type: r.wh_type, wh_id: r.wh_id, consignment: r.consignment, now, group, n: r.n };
});
export async function nowCounts(T, store, items) { return nowCountsRows((await nowCountsStmt(T, store, items).all()).results); }
// Quarantine warehouse: wh_type Quarantine, or the label list's 914Q.
export const isQuar = (r) => String(r.wh_type || '').toLowerCase() === 'quarantine' || /q$/i.test(String(r.wh_id || ''));
// What the lookup calls available / reserved, from derived rows (quarantine left out like the lookup's 914Q).
export function availRes(rows) {
  let av = 0, rs = 0;
  for (const r of rows) if (!isQuar(r)) { if (r.now === 'Available') av += r.n; else if (r.group === 'wo') rs += r.n; }
  return { av, rs };
}
