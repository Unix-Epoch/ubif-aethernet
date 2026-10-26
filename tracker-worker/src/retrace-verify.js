/*
  Retrace's coverage check (Oct 24, 2026): "has Retrace seen everything at this store?", for the admin Retrace page's
  Verify coverage panel. Five checks against the store's frozen baseline (inv_baseline / inv_item_counts), read only
  except for the stored result and the spot check's ticks:
    (Quantity-only items, a counted label total of 0 (stock without individual labels, e.g. 900348), are skipped by checks 1 and 2 and
     reported as "N quantity-only items skipped"; they are never in "missed" (they are baseline items) and add nothing to the label totals.)
    1 counts   per baseline item, Portal's label count (sold included; inv_item_counts) against the labels Retrace stored (inv_labels).
               Fewer is a miss; more is labels newer than the baseline (never a failure, counted aside).
    2 qty      per baseline item, Portal's available + reserved quantity from the stock lookup (inv_items.qty, non-quarantine
               warehouses: a second source Retrace didn't write) against the labels in those statuses. No quantity yet = unchecked.
    3 stale    labels never read, or changed (or marked modified by Portal) after their history was last read, or queued again.
    4 missed   items the store's POs, movements (WO, transfer, RMA, buyback, count) and names refer to that aren't in the baseline
               and have no labels stored. Labor and service items (inv_items.category 'Labor / service', from the WO's cart line
               types: retrace.js NON_STOCK) are never expected to have labels and stay out. Each is handed to the collector once (the sweep's missedItems) to read its labels; one
               asked for 30 minutes ago and still without labels is "empty" (Portal has none to read): listed, not a failure.
    5 spot     10 labels sampled at random (sold, quarantined, old ones included), kept until the next run; a person opens each
               in Portal and ticks "Matches" (inv_verify_ticks: who and when).
  The result of 1 to 4 and the sample are stored per store (inv_verify.result, JSON, capped); check 5 and the summary are worked
  out when read, from the ticks. Check 3's labels are the history queue's: the admin page's Collection queue lists them in read order
  (retrace-api.js queueView, reasons from QUEUE_REASON below). A run happens on demand (POST /retrace/verify/:store/run) and once when the baseline freezes
  (retrace-api.js settle). Routes: retraceAdmin in retrace-api.js. migrations/2026-10-24-retrace-verify.sql has the tables.
  Check 4's items are looked at again when the result is read (verifyView): an item whose labels have arrived since the run drops out, and
  queued turns to empty once 30 minutes have passed since it was asked for, so the panel follows the collector without pressing Run.
  Passing all five is strong evidence, not proof: Portal stays the only source of truth.
*/
import { IGNORED_ITEMS, NON_STOCK, NOW_KIND } from './retrace.js';
import { nowCols, rowNow, nowCounts, availRes, lastStatusSql, isQuar } from './retrace-now.js';

export const SPOT = 10;
const ROWS = 50, STALE_SHOW = 5, ASK_MAX = 20, EMPTY_AFTER_MS = 30 * 60000, RESULT_MAX = 60000, SEEN_MAX = 3;
const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch (_) { return null; } };
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');
// The label list's quarantine warehouse reads 914Q (the lookup's too); Retrace stores it as wh_type Quarantine when it can tell.
const QUAR = "(lower(COALESCE(wh_type, '')) = 'quarantine' OR upper(COALESCE(wh_id, '')) LIKE '%Q')";

// ------------------------------------------------------------------ checks 1 and 2: one read of the baseline items
async function perItem(T, store) {
  const rows = (await T.prepare(`SELECT c.item, c.labels AS portal, i.name, i.qty, COALESCE(l.n, 0) AS n, COALESCE(l.unread, 0) AS unread
      FROM inv_item_counts c LEFT JOIN inv_items i ON i.store = c.store AND i.item = c.item
      LEFT JOIN (SELECT item, COUNT(*) AS n, SUM(last_history_at IS NULL) AS unread FROM inv_labels WHERE store = ?1 GROUP BY item) l ON l.item = c.item
      WHERE c.store = ?1 ORDER BY c.item`).bind(store).all()).results;
  // available / reserved from where each label stands NOW (retrace-now.js), not from the raw serial_status ('Received' off a PO says nothing)
  const by = new Map();
  for (const r of await nowCounts(T, store, null)) { const l = by.get(r.item); if (l) l.push(r); else by.set(r.item, [r]); }
  return rows.map((r) => Object.assign(r, availRes(by.get(r.item) || [])));
}

// Quantity-only items: stock with no individual labels (Portal's generic SKUs, e.g. 900348 "Generic - Liquid Glass (Individual)", there so staff can check the
// product out). Recognised by the counted label total (store-products/{item}/inventory @odata.count, or its 404) being 0: nothing to find, nothing to compare.
const qtyOnly = (r) => r.portal === 0;
const qoNote = (n) => n ? ' · ' + plural(n, 'quantity-only item') + ' skipped (no labels to check)' : '';

function countsCheck(all) {
  const short = [], rows = all.filter((r) => !qtyOnly(r)), qo = all.length - rows.length;
  let extra = 0;
  for (const r of rows) {
    if (r.n < r.portal) {
      short.push({ item: r.item, name: r.name || null, portal: r.portal, have: r.n,
        cause: r.n === 0 ? 'none of its labels read yet' : plural(r.portal - r.n, 'label') + ' not found yet' + (r.unread ? ' · ' + plural(r.unread, 'stored label') + ' without a history' : '') });
    } else if (r.n > r.portal) extra += r.n - r.portal;
  }
  short.sort((a, b) => (b.portal - b.have) - (a.portal - a.have) || (a.item < b.item ? -1 : 1));
  const ok = rows.length - short.length;
  return { status: !rows.length ? 'todo' : short.length ? 'fail' : 'pass', total: rows.length, ok, n: short.length, extra, quantity_only: qo, rows: short.slice(0, ROWS),
    result: (!rows.length ? (qo ? 'no items with labels' : 'no baseline items') : ok + ' of ' + rows.length + ' items match' + (!short.length && extra ? ' · ' + plural(extra, 'label') + ' newer than the baseline' : '')) + qoNote(qo) };
}

// Portal's quantities by warehouse (inv_items.qty): available and reserved, quarantine warehouses (914Q) left out. null = no quantity yet.
function portalQty(qtyText) {
  const q = parse(qtyText);
  if (!q || typeof q !== 'object') return null;
  const whs = Object.entries(q).filter(([, w]) => w && typeof w === 'object');
  if (!whs.length) return null;
  const sum = (k) => whs.filter(([id]) => !/q$/i.test(id)).reduce((n, [, w]) => n + (typeof w[k] === 'number' ? w[k] : 0), 0);
  return { available: sum('available'), reserved: sum('reserved') };
}

function qtyCheck(all) {
  const bad = [], rows = all.filter((r) => !qtyOnly(r)), qo = all.length - rows.length;
  let ok = 0, unchecked = 0;
  for (const r of rows) {
    const p = portalQty(r.qty);
    if (!p) { unchecked++; continue; }
    if (p.available === r.av && p.reserved === r.rs) { ok++; continue; }
    const diff = p.available + p.reserved - (r.av + r.rs);
    bad.push({ item: r.item, name: r.name || null, portal: p, have: { available: r.av, reserved: r.rs }, diff,
      cause: diff > 0 ? 'Retrace has ' + plural(diff, 'label') + ' fewer in these statuses: not found yet, or a status change not read'
        : diff < 0 ? 'Retrace has ' + plural(-diff, 'label') + ' more in these statuses: a sale or move not read yet' : 'same total, split differently: a reservation change not read yet' });
  }
  bad.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || (a.item < b.item ? -1 : 1));
  const checked = ok + bad.length;
  return { status: !checked ? 'todo' : bad.length ? 'fail' : 'pass', total: rows.length, ok, unchecked, n: bad.length, quantity_only: qo, rows: bad.slice(0, ROWS),
    result: (!checked ? (qo && !unchecked ? 'only quantity-only items: no labels to check' : 'no quantities from the stock lookup yet') : ok + ' of ' + checked + ' items match' + (unchecked ? ' · ' + unchecked + ' unchecked (no quantity yet)' : '')) + qoNote(qo) };
}

// ------------------------------------------------------------------ check 3: stale histories
// Shared with the collection queue (retrace-api.js queueView): a label is stale when its history was never read, was queued again, or the
// label changed after it was read; the queue says which of those it is (QUEUE_REASON: never / changed / recheck).
const CHANGED_AFTER = '(last_change_at > last_history_at OR serial_modified > last_history_at)';
const STALE_WHERE = `store = ?1 AND (last_history_at IS NULL OR need_history >= 2 OR ${CHANGED_AFTER})`;
// need_history 3 = a diff saw the label change (retrace-api.js NEED.changed); 2 = touched by a movement; 1 = backfill.
export const QUEUE_REASON = `CASE WHEN last_history_at IS NULL THEN 'never' WHEN ${CHANGED_AFTER} OR need_history >= 3 THEN 'changed' ELSE 'recheck' END`;
// since when the reason has held (the label's own timestamps; the queue keeps no queued-at)
export const QUEUE_SINCE = `CASE WHEN last_history_at IS NULL THEN first_seen WHEN ${CHANGED_AFTER} OR need_history >= 3 THEN COALESCE(last_change_at, serial_modified, last_seen) ELSE last_seen END`;
async function staleCheck(T, store) {
  const [rows, n] = await T.batch([
    T.prepare(`SELECT label, item, serial_status, wh_type, last_change_at, serial_modified, last_seen, last_history_at, ${nowCols('inv_labels')} FROM inv_labels WHERE ${STALE_WHERE}
        ORDER BY COALESCE(last_change_at, serial_modified, last_seen) DESC, label LIMIT ${STALE_SHOW}`).bind(store),
    T.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(last_history_at IS NULL), 0) AS unread FROM inv_labels WHERE ${STALE_WHERE}`).bind(store),
  ]);
  const t = n.results[0];
  return { status: t.n ? 'fail' : 'pass', n: t.n, unread: t.unread,
    rows: rows.results.map((r) => ({ label: r.label, item: r.item, now: [rowNow(r)[0], r.wh_type && /^quarantine$/i.test(r.wh_type) ? 'Quarantine' : null].filter(Boolean).join(' · ') || null,
      changed_at: r.last_change_at || r.serial_modified || r.last_seen || null, read_at: r.last_history_at || null })),
    result: t.n ? plural(t.n, 'label') + (t.unread ? ' (' + t.unread + ' never read)' : '') + ', queued for the next pass' : 'none' };
}

// ------------------------------------------------------------------ check 4: items missed
// Items the store's records refer to, not in the baseline, with no labels stored. The last run's `asked` (item → when it was
// handed to the collector) carries over for the ones still missing.
async function missedCheck(T, store, prev, at) {
  const w = (col) => `${col} NOT IN (SELECT item FROM inv_item_counts WHERE store = ?1) AND NOT EXISTS (SELECT 1 FROM inv_labels l WHERE l.store = ?1 AND l.item = ${col}) AND lower(${col}) NOT IN (SELECT value FROM json_each(?2))
    AND NOT EXISTS (SELECT 1 FROM inv_items s WHERE s.store = ?1 AND s.item = ${col} AND s.category = ?3)`;
  const ign = JSON.stringify(IGNORED_ITEMS);
  const [mv, po, named] = await T.batch([
    T.prepare(`SELECT m.item, m.ref_type, m.ref_id, MAX(m.at) AS at FROM inv_movements m WHERE m.store = ?1 AND m.item IS NOT NULL AND m.ref_id IS NOT NULL AND ${w('m.item')}
        GROUP BY m.item, m.ref_type, m.ref_id ORDER BY at DESC LIMIT 800`).bind(store, ign, NON_STOCK),
    // PO lines (inv_docs data.lines[].item)
    T.prepare(`SELECT json_extract(je.value, '$.item') AS item, d.id AS ref_id, d.at AS at FROM inv_docs d, json_each(d.data, '$.lines') je
        WHERE d.store = ?1 AND d.type = 'po' AND json_extract(je.value, '$.item') IS NOT NULL AND ${w("json_extract(je.value, '$.item')")} ORDER BY d.at DESC LIMIT 800`).bind(store, ign, NON_STOCK),
    // items only a name has reached (an order line, an event): no quantities, no labels
    T.prepare(`SELECT i.item FROM inv_items i WHERE i.store = ?1 AND i.qty_hash IS NULL AND ${w('i.item')} LIMIT 400`).bind(store, ign, NON_STOCK),
  ]);
  const by = new Map();
  const see = (item, t, id, when) => {
    const x = by.get(item) || { item, seen: [], seen_n: 0, last: '' };
    if (t && !x.seen.some((s) => s.t === t && s.id === id)) { x.seen_n++; if (x.seen.length < SEEN_MAX) x.seen.push({ t, id }); }
    if (when && when > x.last) x.last = when;
    by.set(item, x);
  };
  for (const r of mv.results) see(String(r.item), r.ref_type || 'ref', r.ref_id, r.at);
  for (const r of po.results) see(String(r.item), 'po', r.ref_id, r.at);
  for (const r of named.results) see(String(r.item), null, null, '');
  const list = [...by.values()].sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : a.item < b.item ? -1 : 1));
  const names = new Map();
  if (list.length) for (const r of (await T.prepare('SELECT item, name FROM inv_items WHERE store = ? AND item IN (SELECT value FROM json_each(?))').bind(store, JSON.stringify(list.slice(0, 400).map((x) => x.item))).all()).results) names.set(r.item, r.name);
  const asked = (prev && prev.asked) || {}, ask = [], keep = {}, cutoff = Date.parse(at) - EMPTY_AFTER_MS;
  const rows = list.map((x) => {
    const a = asked[x.item];
    if (a) keep[x.item] = a; else ask.push(x.item);
    return { item: x.item, name: names.get(x.item) || null, seen: x.seen, seen_n: x.seen_n, state: a && Date.parse(a) <= cutoff ? 'empty' : 'queued', asked_at: a || null };
  });
  const open = rows.filter((r) => r.state === 'queued').length, empty = rows.length - open;
  rows.sort((a, b) => (a.state === b.state ? 0 : a.state === 'queued' ? -1 : 1));
  return { check: { status: open ? 'fail' : 'pass', n: open, empty, rows: rows.slice(0, ROWS),
      result: open ? plural(open, 'item') + ', their labels will be read' : empty ? 'none (' + plural(empty, 'referenced item') + ' without labels at the store)' : 'none' },
    ask, asked: keep };
}

// ------------------------------------------------------------------ check 5: the sample
// Strata first (sold, quarantined, oldest, available, reserved), then anything else; labels with a history read (a timeline to compare) first.
async function sample(T, store) {
  const picked = [];
  // pred: the exact test on where the label stands NOW (rowNow); cond only narrows the pool it is applied to
  const pick = async (n, cond, hist, pred) => {
    const r = await T.prepare(`SELECT label, serial_status, wh_type, wh_id, last_seen, ${nowCols('inv_labels')} FROM inv_labels WHERE store = ?1 AND ${hist ? 'last_history_at IS NOT NULL AND ' : ''}label NOT IN (SELECT value FROM json_each(?2)) AND ${cond} ORDER BY random() LIMIT ${pred ? n * 10 : n}`)
      .bind(store, JSON.stringify(picked)).all();
    picked.push(...r.results.filter((x) => !pred || pred(x, rowNow(x))).slice(0, n).map((x) => x.label));
  };
  const st = "lower(COALESCE(serial_status, ''))";
  // "old": first seen in the oldest quarter of the labels read
  const old = 'first_seen <= COALESCE((SELECT first_seen FROM inv_labels WHERE store = ?1 AND last_history_at IS NOT NULL ORDER BY first_seen LIMIT 1 OFFSET (SELECT COUNT(*) / 4 FROM inv_labels WHERE store = ?1 AND last_history_at IS NOT NULL)), first_seen)';
  const kinds = (g) => "('" + Object.entries(NOW_KIND).filter(([, v]) => v[1] === g).map(([k]) => k).join("', '") + "')";
  const lk = lastStatusSql('kind', 'inv_labels'), isQ = (x) => isQuar(x);
  for (const [n, cond, pred] of [
    [2, `(${st} = 'sold' OR ${lk} IN ${kinds('out')})`, (x, [now]) => now === 'Sold' || now === 'Used on repair'],
    [2, QUAR + ' AND ' + st + " <> 'sold'", (x, [now]) => now !== 'Sold'],
    [2, old, null],
    [2, `(${st} IN ('available', 'received') OR ${lk} IN ${kinds('in')}) AND NOT ${QUAR}`, (x, [now]) => now === 'Available' && !isQ(x)],
    [1, `(${st} = 'reserved' OR ${lk} IN ${kinds('wo')})`, (x, [now, g]) => g === 'wo'],
  ]) await pick(n, cond, true, pred);
  if (picked.length < SPOT) await pick(SPOT - picked.length, '1 = 1', true);
  if (picked.length < SPOT) await pick(SPOT - picked.length, '1 = 1', false);
  return picked.slice(0, SPOT);
}

// ------------------------------------------------------------------ run and store
// → the stored result, or null when the store's baseline isn't frozen (nothing to check against).
export async function verifyRun(T, store, at, by) {
  const b = await T.prepare('SELECT counted_at, expected_items FROM inv_baseline WHERE store = ?').bind(store).first();
  if (!b || !b.counted_at || !b.expected_items) return null; // an empty baseline is none (retrace-api.js healBaseline)
  const prevRow = await T.prepare('SELECT result FROM inv_verify WHERE store = ?').bind(store).first(), prev = prevRow ? parse(prevRow.result) : null;
  const rows = await perItem(T, store), missed = await missedCheck(T, store, prev, at);
  const result = { v: 1, by: by || null, counts: countsCheck(rows), qty: qtyCheck(rows), stale: await staleCheck(T, store), missed: missed.check, spot: await sample(T, store), ask: missed.ask, asked: missed.asked };
  // capped: the lists shrink until it fits (the counts stay)
  let text = JSON.stringify(result);
  while (text.length > RESULT_MAX) {
    const lists = [result.counts.rows, result.qty.rows, result.stale.rows, result.missed.rows].filter((l) => l.length > 5);
    if (!lists.length) { result.ask = result.ask.slice(0, 100); result.asked = {}; text = JSON.stringify(result); break; }
    for (const l of lists) l.length = Math.ceil(l.length / 2);
    text = JSON.stringify(result);
  }
  await T.prepare(`INSERT INTO inv_verify (store, checked_at, result) VALUES (?, ?, ?)
      ON CONFLICT (store) DO UPDATE SET checked_at = excluded.checked_at, result = excluded.result`).bind(store, at, text).run();
  return result;
}

// Items the collector should read the labels of (check 4), handed out once each (the sweep's missedItems). One key read per sweep.
export async function verifyAsk(T, store, at) {
  const row = await T.prepare("SELECT checked_at, json_extract(result, '$.ask') AS ask FROM inv_verify WHERE store = ?").bind(store).first();
  const ask = row ? parse(row.ask) : null;
  if (!Array.isArray(ask) || !ask.length) return [];
  const now = ask.slice(0, ASK_MAX), rest = ask.slice(ASK_MAX);
  // compare-and-set on checked_at: a run in between keeps its own list
  const r = await T.prepare(`UPDATE inv_verify SET result = json_set(result, '$.ask', json(?2), '$.asked', json_patch(COALESCE(json_extract(result, '$.asked'), '{}'), json(?3)))
      WHERE store = ?1 AND checked_at = ?4`).bind(store, JSON.stringify(rest), JSON.stringify(Object.fromEntries(now.map((i) => [i, at]))), row.checked_at).run();
  return r.meta && r.meta.changes ? now : [];
}

// Check 4 as of now: the stored rows (at most ROWS of them; the totals cover the rest, which stay as stored) minus the items that have labels
// stored since the run, each queued / empty by the clock (asked EMPTY_AFTER_MS ago and still no labels = empty). Nothing stored is changed.
async function freshMissed(T, store, m, nowMs) {
  if (!m || !Array.isArray(m.rows)) return m;
  const items = m.rows.map((r) => r.item), have = new Set();
  if (items.length) for (const r of (await T.prepare('SELECT DISTINCT item FROM inv_labels WHERE store = ? AND item IN (SELECT value FROM json_each(?))').bind(store, JSON.stringify(items)).all()).results) have.add(r.item);
  const cutoff = nowMs - EMPTY_AFTER_MS;
  const rows = m.rows.filter((r) => !have.has(r.item)).map((r) => Object.assign({}, r, { state: r.asked_at && Date.parse(r.asked_at) <= cutoff ? 'empty' : 'queued' }));
  const storedOpen = m.rows.filter((r) => r.state === 'queued').length, storedEmpty = m.rows.length - storedOpen;
  const open = Math.max(0, (m.n || 0) - storedOpen) + rows.filter((r) => r.state === 'queued').length, empty = Math.max(0, (m.empty || 0) - storedEmpty) + rows.filter((r) => r.state === 'empty').length;
  rows.sort((a, b) => (a.state === b.state ? 0 : a.state === 'queued' ? -1 : 1));
  return Object.assign({}, m, { status: open ? 'fail' : 'pass', n: open, empty, rows,
    result: open ? plural(open, 'item') + ', their labels will be read' : empty ? 'none (' + plural(empty, 'referenced item') + ' without labels at the store)' : 'none' });
}

// ------------------------------------------------------------------ read: the stored result plus the live spot rows and ticks
export async function verifyView(T, store) {
  const row = await T.prepare('SELECT checked_at, result FROM inv_verify WHERE store = ?').bind(store).first();
  const res = row ? parse(row.result) : null;
  if (!res) return { store, checked_at: null };
  res.missed = await freshMissed(T, store, res.missed, Date.now());
  const labels = Array.isArray(res.spot) ? res.spot : [], json = JSON.stringify(labels);
  const [rows, ticks] = labels.length ? await T.batch([
    T.prepare(`SELECT l.label, l.item, l.serial_status, l.wh_type, l.last_seen, ${nowCols()}, i.name,
        (SELECT COUNT(*) FROM inv_movements m WHERE m.store = l.store AND m.label = l.label) AS moves
        FROM inv_labels l LEFT JOIN inv_items i ON i.store = l.store AND i.item = l.item WHERE l.store = ? AND l.label IN (SELECT value FROM json_each(?))`).bind(store, json),
    T.prepare('SELECT label, checked_by, checked_at, matches FROM inv_verify_ticks WHERE store = ? AND label IN (SELECT value FROM json_each(?))').bind(store, json),
  ]) : [{ results: [] }, { results: [] }];
  const byLabel = new Map(rows.results.map((r) => [r.label, r])), tick = new Map(ticks.results.map((t) => [t.label, t]));
  const spotRows = labels.filter((l) => byLabel.has(l)).map((l) => {
    const r = byLabel.get(l), t = tick.get(l);
    return { label: l, item: r.item, name: r.name || null, now: rowNow(r)[0], moves: r.moves, last_seen: r.last_seen,
      checked: t && t.matches ? { by: t.checked_by, at: t.checked_at } : null };
  });
  const done = spotRows.filter((r) => r.checked), last = done.reduce((m, r) => (r.checked.at > m ? r.checked.at : m), '');
  const spot = { status: spotRows.length && done.length === spotRows.length ? 'pass' : 'todo', checked: done.length, total: spotRows.length, last_checked_at: last || null, rows: spotRows,
    result: spotRows.length ? done.length + ' of ' + spotRows.length + (done.length === spotRows.length ? '' : ' checked') : 'no labels to check yet' };
  const checks = [['counts', res.counts], ['qty', res.qty], ['stale', res.stale], ['missed', res.missed], ['spot', spot]].map(([key, c], i) => Object.assign({}, c, { no: i + 1, key }));
  return { store, checked_at: row.checked_at, by: res.by || null, pass: checks.filter((c) => c.status === 'pass').length, total: checks.length, checks };
}

// A tick on one of the current sample's labels. → false when the label isn't in the sample.
export async function verifyTick(T, store, label, matches, email, at) {
  const row = await T.prepare('SELECT result FROM inv_verify WHERE store = ?').bind(store).first(), res = row ? parse(row.result) : null;
  if (!res || !Array.isArray(res.spot) || !res.spot.includes(label)) return false;
  await T.prepare(`INSERT INTO inv_verify_ticks (store, label, checked_by, checked_at, matches) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (store, label) DO UPDATE SET checked_by = excluded.checked_by, checked_at = excluded.checked_at, matches = excluded.matches`).bind(store, label, email, at, matches ? 1 : 0).run();
  return true;
}
