/*
  Retrace on the tracker Worker: what the store side (retrace-ingest.js), the admin side (retrace-admin.js) and the sold-WO routes
  (retrace-wo-parts.js) share: limits, the shared writes, progress and the baseline, item names, and the WO hook. The routes and what each
  answers are listed at the top of retrace-api.js.
*/
import { parse, cleanText, cleanKeep } from './http.js';
import { TARGET_LISTED, LISTED_JOIN_SQL } from './retrace-listed.js';
import { verifyRun } from './retrace-verify.js';
import { cleanLabel, woMovements, woNames, isoAt, ignoredItem } from './retrace.js';

export const NEED_MAX = 60;
export const NEED_CAP = 200, COUNT_CAP = 300, SHORT_CAP = 300, CLAIM_MIN = 10, WATCH_MAX = 50;
// Per-request caps. Most rows become a statement and D1 counts queries per Worker invocation (1000 on paid plans,
// batched or not), so a pass bigger than this goes up in several sweeps (only new / changed rows are written, so a
// second pass over the same data is mostly reads).
export const PO_DATA_MAX = 200000, PO_NEED_CAP = 100, NAMES_MAX = 200, UNNAMED_CAP = 50, SO_NEED_CAP = 50, SO_NONE_MAX = 200, SO_NONE_MS = 7 * 24 * 3600000; // a week: both live label-details samples (Oct 26) had WorkOrderId ""
export const LIMIT = { items: 2400, labels: 800, docs: 200, movements: 500, touched: 500, rows: 500, cursors: 20, pos: 600, names: NAMES_MAX, labelTotals: 800, listed: 150 };
const LISTED_LABELS_MAX = 4000; // one item's full label list (store-products: 20 pages of 200 at most)
export const MAX = { sweep: 4000000, history: 1000000, watch: 150000 };
export const SWEEP_SOURCES = ['sweep', 'transfer', 'count', 'rma', 'buyback', 'po', 'snapshot'];
export const CURSOR_RE = /^[a-z][a-z0-9_-]{0,30}$/, LAST_SWEEP = 'last_sweep';
export const NEED = { backfill: 1, touched: 2, changed: 3 };
// A label whose serial history Portal answered 404 for, repeatedly (POST /retrace/history { none: 404 }): its history_hash, and how long until it's tried again.
export const NONE_404 = 'none:404';
export const NONE_RETRY_MS = 7 * 86400000;
// The order the sweep hands labels out to read (and the Collection queue panel lists them in): changed > touched > backfill, most recently seen first.
export const QUEUE_ORDER = 'need_history DESC, last_seen DESC, label';

// Statements left out (an ignored item's insert / touch is null) are dropped here.
export const chunks = async (T, list) => { const out = [], stmts = list.filter(Boolean); for (let i = 0; i < stmts.length; i += 100) out.push(...(await T.batch(stmts.slice(i, i + 100)))); return out; };
export const lc = (v) => (v == null ? null : String(v).toLowerCase());
// decodeURIComponent throws on a malformed % in the path: null instead (the routes answer 400, not 500).
export const unesc = (v) => { try { return decodeURIComponent(v); } catch (_) { return null; } };
// Leading store number in Portal's Store text ("914", "914 - Newport News"); null when it has none.
export const storeNo = (v) => { const m = /^\s*(\d{1,6})\b/.exec(v == null ? '' : String(v)); return m ? Number(m[1]) : null; };

// ------------------------------------------------------------------ shared writes
// Both give null for an ignored item (retrace.js IGNORED_ITEMS: BB0001, buyback devices), which chunks() drops.
export const insertMv = (T, store, m, at) => ignoredItem(m.item) ? null : T.prepare(`INSERT OR IGNORE INTO inv_movements (store, label, item, at, kind, raw_status, raw_event, ref_type, ref_id, ref_line, from_wh, to_wh, user_name, source, detail, key, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .bind(store, m.label, m.item, m.at, m.kind, m.raw_status, m.raw_event, m.ref_type, m.ref_id, m.ref_line, m.from_wh, m.to_wh, m.user, m.source, m.detail, m.key, at);
export const soWo = (T, store, so, wo, source, at) => T.prepare(`INSERT INTO inv_so_wo (store, sales_order, wo, source, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (store, sales_order) DO UPDATE SET wo = excluded.wo, source = excluded.source, updated_at = excluded.updated_at WHERE wo IS NOT excluded.wo`).bind(store, so, String(wo), source, at);
// A label a movement names: known from now on, and queued for a history read at `need` (never lowered here).
// queued_at: when the label was last queued (any touch): a history read that began before it doesn't clear the queue (see /retrace/history).
export const touchLabel = (T, store, label, item, need, at, wo = null) => ignoredItem(item) ? null : T.prepare(`INSERT INTO inv_labels (store, label, item, wo, first_seen, last_seen, need_history, queued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (store, label) DO UPDATE SET item = COALESCE(item, excluded.item), wo = COALESCE(excluded.wo, wo), need_history = MAX(need_history, excluded.need_history), queued_at = excluded.queued_at`)
  .bind(store, label, item, wo, at, at, need, at);

// Labels remembered as not stock (inv_ignored_labels: their history named BB0001 as the current item). Never queued, touched or stored again.
export async function tombs(T, store, labels) {
  const list = [...new Set(labels.filter(Boolean))], dead = new Set();
  for (let i = 0; i < list.length; i += 500) {
    const r = await T.prepare('SELECT label FROM inv_ignored_labels WHERE store = ? AND label IN (SELECT value FROM json_each(?))').bind(store, JSON.stringify(list.slice(i, i + 500))).all();
    for (const x of r.results) dead.add(x.label);
  }
  return dead;
}
// A label's item now: the ItemId of its newest history row (by DateTime; the later one in the list on a tie; rows with no date only count when none has one).
export function currentItem(rows) {
  let best = null, when = '';
  for (const r of rows) {
    const id = r && r.ItemId != null ? String(r.ItemId).trim().slice(0, 40) : '';
    if (!id) continue;
    const t = isoAt(r.DateTime) || '';
    if (best == null || t >= when) { best = id; when = t; }
  }
  return best;
}
// Buyback labels (B-<n>-<digits>) filed before their number stopped counting as an item (Oct 24, 2026) sit under that number with nothing
// from Portal: no status, product, location, PO, WO, change, history, and no movements. Those, and only those, go: the next touch or
// sweep that names the label puts it back with no item, its history decides (BB0001: dropped for good). Anything Portal ever said about a label keeps it.
export const PRUNE_BUYBACK = `DELETE FROM inv_labels WHERE store = ?1 AND label >= 'B-' AND label < 'B.' AND item IS NOT NULL
    AND lower(item) = lower(substr(label, 3, instr(substr(label, 3), '-') - 1))
    AND serial_status IS NULL AND product IS NULL AND wh_type IS NULL AND po IS NULL AND wo IS NULL AND sales_order IS NULL AND last_history_at IS NULL AND last_change_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM inv_movements m WHERE m.store = inv_labels.store AND m.label = inv_labels.label)`;

/*
  listed (sweep request): [{ item, total, labels: [label | { label, store }] }], one per item whose label list (store-products/{item}/inventory, warehouseType=All) the
  browser read IN FULL this pass: total = the list's @odata.count, labels = every label it returned (with the row's Store). Stored per item (inv_item_listed):
  total, and storable = the listed labels Retrace can hold (cleanLabel, this store's or no store named, not in inv_ignored_labels). Latest listing wins.
*/
export async function listedWrite(T, store, listed, at) {
  const rows = [];
  for (const x of Array.isArray(listed) ? listed : []) {
    const item = cleanKeep(x && x.item != null ? String(x.item) : '', 40), total = nInt(x && x.total);
    if (!item || total == null || ignoredItem(item) || !Array.isArray(x.labels) || x.labels.length > LISTED_LABELS_MAX) continue;
    // An entry is a label, or { label, store } (store = the row's Store text, as sent): a row naming another store is never stored here
    // (the label snapshot write skips it the same way: its leading number), so it can't count toward what the item can reach.
    const all = x.labels.map((e) => (e && typeof e === 'object' ? { label: cleanLabel(e.label), own: storeNo(e.store) } : { label: cleanLabel(e), own: null })).filter((e) => e.label);
    if (new Set(all.map((e) => e.label)).size > total) continue; // more rows than Portal's own count: not a coherent listing
    const labels = [...new Set(all.filter((e) => e.own == null || e.own === store).map((e) => e.label))];
    rows.push({ item, total, labels });
  }
  if (!rows.length) return 0;
  const dead = await tombs(T, store, rows.flatMap((r) => r.labels));
  await chunks(T, rows.map((r) => T.prepare(`INSERT INTO inv_item_listed (store, item, total, storable, listed_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (store, item) DO UPDATE SET total = excluded.total, storable = excluded.storable, listed_at = excluded.listed_at`)
    .bind(store, r.item, r.total, r.labels.filter((l) => !dead.has(l)).length, at)));
  return rows.length;
}
// Per baseline item, the labels it can still reach: Portal's frozen count, lowered to what the latest full listing since the freeze can be
// stored as (a label Portal stopped listing, or one Retrace drops: a BB0001 buyback). Never raised (labels newer than the baseline aren't owed).
// (TARGET_LISTED / LISTED_JOIN_SQL: retrace-listed.js; before its migration the table is missing and progress reads the frozen counts as they are)

// ------------------------------------------------------------------ progress (the baseline and the done signal)
// What a unit of each step costs (about Portal calls: a history is one, a PO two, a name one, a label's listing a small share of a page),
// so the one bar moves with the time left, not with the biggest count. And what the collector gets through in a pass of 10 minutes
// (src/28-retrace-collect.js: NEED 60 histories, PO_BUDGET 15, NAME_BUDGET 10).
export const PROGRESS_WEIGHT = { labels: 0.05, histories: 1, pos: 2, names: 1 };
export const PER_PASS = { histories: 60, pos: 15, names: 10 };
export const PASS_MIN = 10;
// Histories still queued when everything else is at its total: a few are new labels (POs, items since the baseline); more than this
// share of the baseline (or this many, whichever is larger) means the gathering isn't finished, whatever the steps say.
const QUEUE_SLACK = 50, QUEUE_SHARE = 0.1;
export const nInt = (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1e7 ? v : null);

/*
  One store's progress, read only. → { out, b, ready, complete }
    bogus     a frozen row with expected_items = 0: not a baseline, treated as not frozen (state 'counting', no done_at); settle() clears it
    out       what the routes hand out: { store, state, pct, done_at, counted_at, eta_min, steps: { stock, labels, histories, pos, names }
              each { x, y } (frozen only), counting: { items_done, items_total, pos_known }, new_labels, last_sweep_at }
    ready     counting is finished (a lookup has run and gave items, every lookup item has a count, at least one label counted when
              labels are known, the PO total is known): settle() freezes
    complete  frozen and every step has reached its total and the PO list has been read through: settle() records done
*/
export async function progress(T, store) {
  try { return await progressRead(T, store, true); } catch (e) {
    if (!/inv_item_listed/.test(String(e && e.message))) throw e;
    return progressRead(T, store, false); // no table yet: the frozen counts as they are
  }
}
async function progressRead(T, store, withListed) {
  const TARGET_SQL = withListed ? TARGET_LISTED : 'c.labels', LISTED_JOIN = withListed ? LISTED_JOIN_SQL : '';
  const [bq, itq, lbq, goneq, poq, curq] = await T.batch([
    T.prepare('SELECT * FROM inv_baseline WHERE store = ?').bind(store),
    T.prepare(`SELECT COUNT(*) AS lookup, COALESCE(SUM(c.item IS NOT NULL), 0) AS counted, COALESCE(SUM(c.item IS NOT NULL AND i.name IS NOT NULL), 0) AS named, COALESCE(SUM(c.labels), 0) AS labels
        FROM inv_items i LEFT JOIN inv_item_counts c ON c.store = i.store AND c.item = i.item WHERE i.store = ? AND i.qty_hash IS NOT NULL`).bind(store),
    // One pass over the store's labels (grouped per item), the baseline's counts joined on. Per baseline item, at most its count: a label stored
    // for an item beyond what Portal said it has is "new since", not found. every / queued: all the store's labels, baseline item or not.
    T.prepare(`SELECT COALESCE(SUM(MIN(${TARGET_SQL}, l.n)), 0) AS found, COALESCE(SUM(MIN(${TARGET_SQL}, l.h)), 0) AS read, COALESCE(SUM(l.n), 0) AS every, COALESCE(SUM(l.q), 0) AS queued
        FROM (SELECT item, COUNT(*) AS n, SUM(last_history_at IS NOT NULL) AS h, SUM(need_history > 0) AS q FROM inv_labels WHERE store = ?1 GROUP BY item) l
        LEFT JOIN inv_item_counts c ON c.store = ?1 AND c.item = l.item ${LISTED_JOIN}`).bind(store),
    // labels the frozen total counted that the latest full listings say can't be reached (TARGET_SQL)
    T.prepare(`SELECT COALESCE(SUM(c.labels - ${TARGET_SQL}), 0) AS gone FROM inv_item_counts c ${LISTED_JOIN} WHERE c.store = ?1`).bind(store),
    T.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(json_extract(data, '$.detailAt') IS NOT NULL), 0) AS read FROM inv_docs WHERE store = ? AND type = 'po' AND lower(COALESCE(status, '')) <> 'draft'`).bind(store),
    T.prepare("SELECT sweep, value, updated_at FROM inv_cursors WHERE store = ? AND sweep IN ('lookup', 'po_backfill', ?)").bind(store, LAST_SWEEP),
  ]);
  const b = bq.results[0] || null, it = itq.results[0], lb = lbq.results[0], po = poq.results[0], gone = (goneq.results[0] || {}).gone || 0;
  const cur = Object.fromEntries(curq.results.map((r) => [r.sweep, r]));
  const listed = !!(cur.po_backfill && (parse(cur.po_backfill.value) || {}).done === true);
  const bogus = !!(b && b.counted_at && !b.expected_items), frozen = !!(b && b.counted_at) && !bogus;
  const posKnown = !!(b && b.expected_pos != null) || listed;
  // a lookup with no items (it.lookup 0) or no counted items is not "every item counted"; labels known but none counted is a failed count
  const ready = !frozen && !!cur.lookup && it.lookup > 0 && it.counted === it.lookup && posKnown && !(it.labels === 0 && lb.every > 0);
  const out = { store, state: frozen && b.backfill_done_at ? 'done' : frozen ? 'gathering' : 'counting', pct: null, done_at: (frozen && b.backfill_done_at) || null, counted_at: (frozen && b.counted_at) || null,
    eta_min: null, steps: null, counting: { items_done: it.counted, items_total: it.lookup, pos_known: posKnown }, new_labels: null, last_sweep_at: (cur[LAST_SWEEP] && cur[LAST_SWEEP].updated_at) || null };
  let complete = false;
  if (frozen) {
    const eI = b.expected_items || 0, eP = b.expected_pos || 0;
    // expected_labels stays as frozen; the steps owe it less the labels Portal no longer lists / Retrace drops (gone_labels)
    const eL = Math.max(0, (b.expected_labels || 0) - gone);
    const steps = { stock: { x: Math.min(it.counted, eI), y: eI }, labels: { x: Math.min(lb.found, eL), y: eL }, histories: { x: Math.min(lb.read, eL), y: eL },
      pos: { x: Math.min(po.read, eP), y: eP }, names: { x: Math.min(it.named, eI), y: eI } };
    const w = (k) => PROGRESS_WEIGHT[k], done = Object.values(steps).every((v) => v.x >= v.y);
    const den = Object.keys(PROGRESS_WEIGHT).reduce((n, k) => n + w(k) * steps[k].y, 0), num = Object.keys(PROGRESS_WEIGHT).reduce((n, k) => n + w(k) * steps[k].x, 0);
    complete = done && listed && eI > 0 && lb.queued <= Math.max(QUEUE_SLACK, Math.ceil(eL * QUEUE_SHARE));
    out.steps = steps;
    out.pct = complete || (done && !den) ? 100 : Math.min(99, Math.floor(den ? (num / den) * 100 : 100));
    out.eta_min = complete ? 0 : Math.max(1, ...Object.keys(PER_PASS).map((k) => Math.ceil((steps[k].y - steps[k].x) / PER_PASS[k])), steps.labels.x < steps.labels.y ? 1 : 0) * PASS_MIN;
    out.new_labels = Math.max(0, lb.every - steps.labels.x);
    out.gone_labels = gone;
  }
  return { out, b, ready, complete, bogus, items: it, pos: po };
}

// A frozen baseline with no items is no baseline (see "Progress"): cleared so the store counts again from scratch, with the done time
// it set (which can't be true). expected_pos and its date stay (the PO count doesn't depend on the lookup). → whether it cleared one.
export async function healBaseline(T, store) {
  const r = await T.prepare(`UPDATE inv_baseline SET counted_at = NULL, expected_items = NULL, expected_labels = NULL, backfill_done_at = NULL
      WHERE store = ? AND counted_at IS NOT NULL AND COALESCE(expected_items, 0) = 0`).bind(store).run();
  if (!(r.meta && r.meta.changes)) return false;
  await T.prepare('DELETE FROM inv_item_counts WHERE store = ?').bind(store).run();
  return true;
}

// Freezes the baseline once counting is finished, records the done time once; → the store's progress after that.
// Called by the sweep and the history read, i.e. whenever something that moves a step has been written.
export async function settle(T, store, at) {
  await healBaseline(T, store);
  let p = await progress(T, store);
  if (p.ready) {
    await T.batch([
      T.prepare(`INSERT INTO inv_baseline (store, expected_items, expected_labels, expected_pos, pos_counted_at, counted_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?5)
          ON CONFLICT (store) DO UPDATE SET expected_items = excluded.expected_items, expected_labels = excluded.expected_labels, expected_pos = COALESCE(expected_pos, excluded.expected_pos),
            pos_counted_at = COALESCE(pos_counted_at, excluded.pos_counted_at), counted_at = excluded.counted_at WHERE counted_at IS NULL`)
        .bind(store, p.items.counted, p.items.labels, p.pos.n, at),
      // counts of items the lookup doesn't have (an item that left the lookup before it was counted) aren't part of the baseline
      T.prepare('DELETE FROM inv_item_counts WHERE store = ? AND item NOT IN (SELECT item FROM inv_items WHERE store = ? AND qty_hash IS NOT NULL)').bind(store, store),
    ]);
    p = await progress(T, store);
    // the coverage check runs once as the baseline freezes, so the panel opens with a result (never fails the sweep)
    try { await verifyRun(T, store, at, 'auto'); } catch (_) {}
  }
  if (p.complete && !p.out.done_at) {
    await T.prepare('UPDATE inv_baseline SET backfill_done_at = ? WHERE store = ? AND backfill_done_at IS NULL').bind(at, store).run();
    p = await progress(T, store);
  }
  return p.out;
}

/*
  A history read can be the last thing a store's gathering was waiting for, and nothing else: it moves neither the counting nor the freeze.
  settle() costs ~11k rows read at a store of 900 items (measured Oct 24), so it isn't run on every read (60 an hour-pass, never stopping until done):
    - a store with no baseline, one still counting or one already done: nothing to settle (an empty baseline to clear is settled, it's rare)
    - more labels still queued than the done test allows (QUEUE_SLACK / QUEUE_SHARE): this read can't finish it (one cheap indexed count)
    - otherwise at most once a minute per store per Worker instance, except when the queue just emptied: the last read settles at once, so the
      done signal and the freeze (the coverage check) are prompt. The sweep settles on its own either way.
*/
const SETTLE_EVERY_MS = 60000, settledAt = new Map(), PROGRESS_TTL_MS = 30000, progressAt = new Map();
export async function settleAfterHistory(T, store, at) {
  const b = await T.prepare('SELECT backfill_done_at, counted_at, expected_items, expected_labels FROM inv_baseline WHERE store = ?').bind(store).first();
  if (!b) return;
  if (!(b.counted_at && !b.expected_items)) {
    if (b.backfill_done_at || !b.counted_at) return;
    const queued = (await T.prepare('SELECT COUNT(*) AS n FROM inv_labels WHERE store = ? AND need_history > 0').bind(store).first()).n;
    if (queued > Math.max(QUEUE_SLACK, Math.ceil((b.expected_labels || 0) * QUEUE_SHARE))) return;
    if (queued > 0 && Date.now() - (settledAt.get(store) || 0) < SETTLE_EVERY_MS) return;
  }
  settledAt.set(store, Date.now());
  await settle(T, store, at);
}
// The admin page's strip: a store's progress at most every PROGRESS_TTL_MS per Worker instance (progress() reads the store's labels; the page polls).
export async function cachedProgress(T, store) {
  const c = progressAt.get(store);
  if (c && Date.now() - c.at < PROGRESS_TTL_MS) return c.out;
  const out = (await progress(T, store)).out;
  progressAt.set(store, { at: Date.now(), out });
  return out;
}
// Tests: forget what the throttles and caches remember (per Worker instance, in memory).
export function resetCaches() { settledAt.clear(); progressAt.clear(); }

// ------------------------------------------------------------------ item names
/*
  inv_items.name is an item's one name, whatever source gave it. Authoritative sources (the item lookup's and label
  details' ProductName, Portal's item record read for the unnamed list) may change a stored name, so a rename in Portal
  shows up; descriptive ones (cart line text, PO line descriptions, receive details' ItemName, RMA lines' item_name,
  outstanding parts' PartName, transfer lines) only fill a missing one. Category: filled when missing, never changed
  here (the item lookup's RetailCategory keeps that; the WO hook's 'Labor / service' marks non-stock items). A row made here has no quantities (qty / qty_hash NULL), which
  the item lookup's diff reads as a new item, never a change. Ignored items get no row.
*/
// Numbers (an item id sent as one) read as their text: cleanText, not clean.
// Names gathered over one request, one per item: the first authoritative one wins, else the first one.
export function nameBook() {
  const map = new Map();
  return {
    map,
    add(item, name, auth, category) {
      const i = cleanText(item, 40), n = cleanText(name, 120);
      if (!i || !n || ignoredItem(i)) return false;
      const x = map.get(i), c = cleanText(category, 60) || null;
      if (!x || (auth && !x.auth)) map.set(i, { name: n, auth: !!auth, category: c || (x && x.category) || null });
      else if (c && !x.category) x.category = c;
      return true;
    },
  };
}
// Statements for the names that change something (one read): a missing name, an authoritative rename, a missing category.
export async function nameStmts(T, store, book, at) {
  const list = [...book.map.keys()], known = new Map();
  for (let i = 0; i < list.length; i += 500) {
    const r = await T.prepare('SELECT item, name, category FROM inv_items WHERE store = ? AND item IN (SELECT value FROM json_each(?))').bind(store, JSON.stringify(list.slice(i, i + 500))).all();
    for (const x of r.results) known.set(x.item, x);
  }
  const stmts = [];
  for (const [item, x] of book.map) {
    const k = known.get(item);
    if (k && k.name && !(x.auth && k.name !== x.name) && !(x.category && !k.category)) continue;
    stmts.push(T.prepare(`INSERT INTO inv_items (store, item, name, category, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (store, item) DO UPDATE SET name = CASE WHEN inv_items.name IS NULL OR ? THEN excluded.name ELSE inv_items.name END, category = COALESCE(inv_items.category, excluded.category)
        WHERE inv_items.name IS NULL OR (? AND inv_items.name IS NOT excluded.name) OR (inv_items.category IS NULL AND excluded.category IS NOT NULL)`)
      .bind(store, item, x.name, x.category, at, at, x.auth ? 1 : 0, x.auth ? 1 : 0));
  }
  return stmts;
}

/*
  Only movements not already stored (one read, by key): the same record coming back (a re-sent cart, a history read
  twice, the WO's events on every upload) writes nothing and doesn't queue its label again. Duplicates within the
  batch go too. INSERT OR IGNORE stays the guard against two browsers racing.
*/
export async function newOnly(T, store, moves) {
  const seen = new Set(), list = moves.filter((m) => m && !ignoredItem(m.item) && !seen.has(m.key) && seen.add(m.key));
  if (!list.length) return [];
  const have = new Set();
  for (let i = 0; i < list.length; i += 500) {
    const r = await T.prepare('SELECT key FROM inv_movements WHERE store = ? AND key IN (SELECT value FROM json_each(?))').bind(store, JSON.stringify(list.slice(i, i + 500).map((m) => m.key))).all();
    for (const x of r.results) have.add(x.key);
  }
  return list.filter((m) => !have.has(m.key));
}
// Statements for new movements plus their labels' queue entries. → { stmts, added }
export async function movementStmts(T, store, moves, at, need, wo = null) {
  const dead = await tombs(T, store, moves.map((m) => m && m.label));
  const fresh = (await newOnly(T, store, moves)).filter((m) => !m.label || !dead.has(m.label)), stmts = [], labels = new Map();
  for (const m of fresh) { stmts.push(insertMv(T, store, m, at)); if (m.label && !labels.has(m.label)) labels.set(m.label, m.item); }
  for (const [label, item] of labels) stmts.push(touchLabel(T, store, label, item, need, at, wo));
  return { stmts: stmts.filter(Boolean), added: fresh.length };
}

// ------------------------------------------------------------------ WO hook
/*
  POST /wo/:wo: the cart lines' labels and the WO's parts events, before and after (src/retrace.js woMovements:
  reserved / unreserved / used, swapped_out + swapped_in), as statements for the WO upload's own batch. The labels
  get the WO linked and a history read queued. Items named on the WO (retrace.js woNames: cart line text, parts events'
  item names) get inv_items.name when they have none: a line with a label, an event's item, or a line whose item
  Retrace already knows (a label or a movement at the store); service and labor lines stay out unless a parts event names
  them (it's a movement already), and then they are marked category 'Labor / service' (cart line itemTypeId 5, retrace.js
  NON_STOCK) so the coverage check doesn't expect labels for them. Never fails the
  upload: any error here gives no statements.
*/
export async function woRetraceStmts(T, store, wo, prevPlain, plain, at) {
  try {
    const stmts = [];
    // The WO's sales order(s), for history rows that name only the FSO: written when they first show up.
    const sos = (p) => new Set([p && p.workorder && p.workorder.csuSalesOrderId, p && p.cart && p.cart.salesId].map((v) => (v == null ? '' : String(v).trim().slice(0, 40))).filter(Boolean));
    const had = sos(prevPlain);
    for (const so of sos(plain)) if (!had.has(so)) stmts.push(soWo(T, store, so, wo, 'wo', at));
    const moves = woMovements(prevPlain, plain, { wo, at });
    if (moves.length) stmts.push(...(await movementStmts(T, store, moves, at, NEED.touched, String(wo))).stmts);
    const named = woNames(plain), book = nameBook(), ask = [...new Set(named.filter((x) => !x.label && !x.event).map((x) => x.item))];
    const known = new Set(ask.length ? (await T.prepare(`SELECT item FROM inv_labels WHERE store = ?1 AND item IN (SELECT value FROM json_each(?2))
        UNION SELECT item FROM inv_movements WHERE store = ?1 AND item IN (SELECT value FROM json_each(?2))`)
      .bind(store, JSON.stringify(ask)).all()).results.map((r) => r.item) : []);
    for (const x of named) if (x.label || x.event || known.has(x.item)) book.add(x.item, x.name, false, x.category);
    if (book.map.size) stmts.push(...(await nameStmts(T, store, book, at)));
    return stmts;
  } catch (_) { return []; }
}
