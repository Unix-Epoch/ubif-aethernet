/*
  Retrace on the tracker Worker (Oct 23, 2026): the inventory movement ledger's routes. Tables inv_labels,
  inv_movements, inv_items, inv_docs, inv_cursors (migrations/2026-10-23-retrace.sql), inv_item_counts and inv_baseline
  (migrations/2026-10-24-retrace-baseline.sql); what a movement is and how
  each source becomes one: src/retrace.js (shared with Aethernet, pure). Movements are kept forever (small rows).

  Store side (x-aethernet-key + the store's Aethernet access, same as /scan; mounted by storeApi at /v1/:store/tracker/retrace/…).
  Everything is written under the store in the URL and nothing else: a label snapshot naming another store is skipped.
    POST /retrace/sweep { items, labels, docs, movements, touched, cursors, need, names, nameNeed, labelTotals, countNeed, poTotal, by }   one collector pass →
         { need: [label], more, changedItems: [{ item, why: new|changed }], added, rejected, skipped, written, named, unnamed, countNeed: [item], missedItems: [item] }
           items      inventory-lookup rows ({ ItemNumber, ProductName, RetailCategory, WarehouseId, OnHandQuantity,
                      AvailableQuantity, ReservedQuantity, InTransitQuantity, SalesOnOrder, VanNickName }): per item and
                      warehouse; quantities differing from the stored ones (or a new item) come back in changedItems so
                      the browser reads that item's labels. Which items to look up is the collector's call (the lookup
                      returns Portal's whole catalog, 100 a page): the server only diffs what it's sent.
           labels     label snapshots (labelSnapshot: label details or store-products rows): diffed against the stored
                      one; a status / location / consignment change is a movement and queues the label's history.
                      A snapshot's product names its item (authoritative: label details' ProductName), except one with
                      `list` set (outstanding parts, retrace.js normalize.outstanding: PartName, descriptive).
           docs       document headers (normalize.doc shape or Portal's row + type) → inv_docs
           movements  movements the browser built with retrace.js (sweeps of transfers, counts, RMA, buyback, POs),
                      checked like the watcher's (normalize.watch), keys rebuilt here
           touched    labels a sweep saw on a document: queued for a history read
           cursors    { sweepName: value } where each sweep got to (JSON, 4000 chars max each) → GET /retrace/cursor
           need       how many labels to hand out for history reads (default NEED_MAX 60, at most NEED_CAP)
           pos        purchase orders: [{ header, receive }] (header = a list row or GET boh/purchase-orders/{po};
                      receive = …/receive-details) or bare list rows; at most 600. Kept in inv_docs (type 'po') with a status
                      history (inv_doc_events), see the PO block in the route below.
           poNeed     how many POs whose lines / receive details should be read next to hand out (default 0, at most 100)
           names      [{ item, name, authoritative?, category? }] item names the browser read (RMA lines' item_name,
                      transfer lines: descriptive; Portal's item record for an unnamed item: authoritative); at most
                      NAMES_MAX, entries without an item or a name skipped. See "item names" above.
           nameNeed   how many items with no name to hand out (default 0, at most UNNAMED_CAP)
         pos: { seen, written, events, received, need: [po] }   need: POs to read in full (new, or tracked fields moved)
         named: items whose name this sweep set or changed (any source above, the PO lines' too)
         unnamed: items with a movement or a label at the store and no name, newest first (nameNeed of them; ignored items never)
         need: labels whose serial history should be (re)read, changed > touched > backfill, claimed CLAIM_MIN minutes
         so a second browser skips them (the /scan pattern).
         The baseline (see "progress" below): labelTotals [{ item, total }] are Portal's label counts per item (the browser reads
         each lookup item's label list with pageSize=1 and takes its @odata.count), kept until the baseline freezes; countNeed
         is how many lookup items still without a count to hand out (default 0, at most COUNT_CAP; none once frozen);
         missedItems: items the coverage check (src/retrace-verify.js) found referenced at the store with no labels stored, up to 20 a
         sweep, each handed out once: the browser reads their label lists like a changed item's.
         poTotal is the number of purchase orders (in transit + past) Portal lists, taken once. A lookup cursor with rows 0 is not
         recorded (an empty lookup is a failed one, not "every item counted").
    POST /retrace/history { label, rows, by }   the label's serial-history rows (boh/serial-history/{label}: the rows,
         or Portal's { value: [rows] } as is) → { ok, added, same, skipped } · rows normalized here (normalize.historyRows),
         duplicates ignored, rows naming another store or label skipped, the label leaves the queue.
    POST /retrace/watch { movements, by }   up to WATCH_MAX movements the in-page watcher saw Portal write → { ok, added, rejected }
    GET  /retrace/cursor                   → { cursors: { sweepName: { value, at } }, baseline: { frozen, posKnown } }
    GET  /retrace/progress?seen=<done_at>  → { store, state: 'counting'|'gathering'|'done', pct, done_at, announce }   the client's read-only
         signal for a future manager popup (same key + store access as the rest). pct: 0–100 once the baseline is frozen, null
         while counting (Portal's totals aren't all in yet). done_at: when the store's initial gathering completed (the
         baseline's backfill_done_at), null before. announce: done_at is set and isn't the `seen` the client sent, i.e. show the
         popup. The client keeps the done_at it last announced (browser storage, per store) and sends it as `seen`; nothing is
         stored on the server for it, so every browser at the store announces once. If a popup must show once per store across
         browsers, add an announced_at column and an ack route then (not needed yet).
  Progress (src/retrace-api.js progress / settle; the admin page's strip and the popup signal): the gathering is measured against a
  baseline that is set early and then frozen, so the denominators don't move while the browser discovers things:
    counting    the browser asks Portal each lookup item's label count (one call per item, pageSize=1, location All = sold included)
                and the PO list counts; nothing is shown as a percentage yet.
    gathering   all items counted (and PO count known): expected_labels = the sum of the counts, expected_items = items counted,
                expected_pos = in-transit + past POs. Frozen then (counted_at), and never empty: at least one lookup item counted, and
                labels counted when labels are already known (a lookup that came back with no rows, or counts of 0 for every item,
                keeps it counting). A frozen row with expected_items = 0 is not a baseline (the Oct 24 store 914 bug: a lookup of 0 rows
                counted as "every item counted"): the next sweep clears it (counts, counted_at, expected_*, and its backfill_done_at,
                which can't be true) and counts again. Steps, each X of Y against that baseline:
                  stock lookup  items counted of expected_items · labels found  labels stored for the baseline's items (per item at most its count)
                  histories read  of those labels, serial history read · purchase orders  read in full (not drafts) of expected_pos
                  item names  baseline items with a name of expected_items
                Labels that show up later (new POs, new items) are "new since": they never change the baseline.
    done        every step at 100%, the PO list read through and no more histories queued than a few new labels explain (QUEUE_SLACK):
                backfill_done_at is set once and never cleared or moved (but for the empty baseline above). Ordinary
                later changes (new labels, a PO to read) don't un-done it. There is no re-count route. By hand: deleting a store's
                inv_item_counts rows and clearing counted_at / expected_* in its inv_baseline row makes it count again and freeze a
                new baseline; backfill_done_at stays, so the signal doesn't fire a second time (state stays 'done', pct follows the
                new baseline). To announce again on purpose: set backfill_done_at to NULL.
    pct is weighted by the work each unit costs (PROGRESS_WEIGHT); eta_min = the longest step at its per-pass rate (PER_PASS) × 10 minutes,
    which only passes while a store browser has Portal open with Aethernet on.
  WO hook: woRetraceStmts() below, called by POST /v1/:store/tracker/wo/:wo into the same batch as status / RFP periods.

  Admin side: retraceAdmin() below, mounted by trackerRoutes at /api/tracker/retrace/… (page 'retrace'; route list there).
*/
import { verifyRun, verifyAsk, verifyView, verifyTick, QUEUE_REASON, QUEUE_SINCE } from './retrace-verify.js';
import { normalize, labelSnapshot, cleanLabel, KINDS, woMovements, woNames, hash53, isoAt, poState, mergePo, poSig, poEvents, poMovements, ignoredItem, IGNORED_ITEMS, serialNow } from './retrace.js';

export const NEED_MAX = 60;
const NEED_CAP = 200, COUNT_CAP = 300, CLAIM_MIN = 10, WATCH_MAX = 50;
// Per-request caps. Most rows become a statement and D1 counts queries per Worker invocation (1000 on paid plans,
// batched or not), so a pass bigger than this goes up in several sweeps (only new / changed rows are written, so a
// second pass over the same data is mostly reads).
const PO_DATA_MAX = 200000, PO_NEED_CAP = 100, NAMES_MAX = 200, UNNAMED_CAP = 50;
const LIMIT = { items: 2400, labels: 800, docs: 200, movements: 500, touched: 500, rows: 500, cursors: 20, pos: 600, names: NAMES_MAX, labelTotals: 800 };
const MAX = { sweep: 4000000, history: 1000000, watch: 150000 };
const SWEEP_SOURCES = ['sweep', 'transfer', 'count', 'rma', 'buyback', 'po', 'snapshot'];
const CURSOR_RE = /^[a-z][a-z0-9_-]{0,30}$/, LAST_SWEEP = 'last_sweep';
const NEED = { backfill: 1, touched: 2, changed: 3 };
// The order the sweep hands labels out to read (and the Collection queue panel lists them in): changed > touched > backfill, most recently seen first.
const QUEUE_ORDER = 'need_history DESC, last_seen DESC, label';

const later = (min) => new Date(Date.now() + min * 60000).toISOString();
const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch (_) { return null; } };
// Statements left out (an ignored item's insert / touch is null) are dropped here.
const chunks = async (T, list) => { const out = [], stmts = list.filter(Boolean); for (let i = 0; i < stmts.length; i += 100) out.push(...(await T.batch(stmts.slice(i, i + 100)))); return out; };
const lc = (v) => (v == null ? null : String(v).toLowerCase());
// Leading store number in Portal's Store text ("914", "914 - Newport News"); null when it has none.
const storeNo = (v) => { const m = /^\s*(\d{1,6})\b/.exec(v == null ? '' : String(v)); return m ? Number(m[1]) : null; };

// ------------------------------------------------------------------ shared writes
// Both give null for an ignored item (retrace.js IGNORED_ITEMS: BB0001, buyback devices), which chunks() drops.
const insertMv = (T, store, m, at) => ignoredItem(m.item) ? null : T.prepare(`INSERT OR IGNORE INTO inv_movements (store, label, item, at, kind, raw_status, raw_event, ref_type, ref_id, ref_line, from_wh, to_wh, user_name, source, detail, key, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .bind(store, m.label, m.item, m.at, m.kind, m.raw_status, m.raw_event, m.ref_type, m.ref_id, m.ref_line, m.from_wh, m.to_wh, m.user, m.source, m.detail, m.key, at);
const soWo = (T, store, so, wo, source, at) => T.prepare(`INSERT INTO inv_so_wo (store, sales_order, wo, source, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (store, sales_order) DO UPDATE SET wo = excluded.wo, source = excluded.source, updated_at = excluded.updated_at WHERE wo IS NOT excluded.wo`).bind(store, so, String(wo), source, at);
// A label a movement names: known from now on, and queued for a history read at `need` (never lowered here).
const touchLabel = (T, store, label, item, need, at, wo = null) => ignoredItem(item) ? null : T.prepare(`INSERT INTO inv_labels (store, label, item, wo, first_seen, last_seen, need_history) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (store, label) DO UPDATE SET item = COALESCE(item, excluded.item), wo = COALESCE(excluded.wo, wo), need_history = MAX(need_history, excluded.need_history)`)
  .bind(store, label, item, wo, at, at, need);

// ------------------------------------------------------------------ progress (the baseline and the done signal)
// What a unit of each step costs (about Portal calls: a history is one, a PO two, a name one, a label's listing a small share of a page),
// so the one bar moves with the time left, not with the biggest count. And what the collector gets through in a pass of 10 minutes
// (src/28-retrace-collect.js: NEED 60 histories, PO_BUDGET 15, NAME_BUDGET 10).
export const PROGRESS_WEIGHT = { labels: 0.05, histories: 1, pos: 2, names: 1 };
export const PER_PASS = { histories: 60, pos: 15, names: 10 };
const PASS_MIN = 10;
// Histories still queued when everything else is at its total: a few are new labels (POs, items since the baseline); more than this
// share of the baseline (or this many, whichever is larger) means the gathering isn't finished, whatever the steps say.
const QUEUE_SLACK = 50, QUEUE_SHARE = 0.1;
const nInt = (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1e7 ? v : null);

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
  const [bq, itq, lbq, poq, curq] = await T.batch([
    T.prepare('SELECT * FROM inv_baseline WHERE store = ?').bind(store),
    T.prepare(`SELECT COUNT(*) AS lookup, COALESCE(SUM(c.item IS NOT NULL), 0) AS counted, COALESCE(SUM(c.item IS NOT NULL AND i.name IS NOT NULL), 0) AS named, COALESCE(SUM(c.labels), 0) AS labels
        FROM inv_items i LEFT JOIN inv_item_counts c ON c.store = i.store AND c.item = i.item WHERE i.store = ? AND i.qty_hash IS NOT NULL`).bind(store),
    // Per baseline item, at most its count: a label stored for an item beyond what Portal said it has is "new since", not found.
    T.prepare(`SELECT COALESCE(SUM(MIN(c.labels, COALESCE(l.n, 0))), 0) AS found, COALESCE(SUM(MIN(c.labels, COALESCE(l.h, 0))), 0) AS read,
          (SELECT COUNT(*) FROM inv_labels WHERE store = ?1) AS every, (SELECT COUNT(*) FROM inv_labels WHERE store = ?1 AND need_history > 0) AS queued
        FROM inv_item_counts c LEFT JOIN (SELECT item, COUNT(*) AS n, SUM(last_history_at IS NOT NULL) AS h FROM inv_labels WHERE store = ?1 GROUP BY item) l ON l.item = c.item
        WHERE c.store = ?1`).bind(store),
    T.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(json_extract(data, '$.detailAt') IS NOT NULL), 0) AS read FROM inv_docs WHERE store = ? AND type = 'po' AND lower(COALESCE(status, '')) <> 'draft'`).bind(store),
    T.prepare("SELECT sweep, value, updated_at FROM inv_cursors WHERE store = ? AND sweep IN ('lookup', 'po_backfill', ?)").bind(store, LAST_SWEEP),
  ]);
  const b = bq.results[0] || null, it = itq.results[0], lb = lbq.results[0], po = poq.results[0];
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
    const eI = b.expected_items || 0, eL = b.expected_labels || 0, eP = b.expected_pos || 0;
    const steps = { stock: { x: Math.min(it.counted, eI), y: eI }, labels: { x: Math.min(lb.found, eL), y: eL }, histories: { x: Math.min(lb.read, eL), y: eL },
      pos: { x: Math.min(po.read, eP), y: eP }, names: { x: Math.min(it.named, eI), y: eI } };
    const w = (k) => PROGRESS_WEIGHT[k], done = Object.values(steps).every((v) => v.x >= v.y);
    const den = Object.keys(PROGRESS_WEIGHT).reduce((n, k) => n + w(k) * steps[k].y, 0), num = Object.keys(PROGRESS_WEIGHT).reduce((n, k) => n + w(k) * steps[k].x, 0);
    complete = done && listed && eI > 0 && lb.queued <= Math.max(QUEUE_SLACK, Math.ceil(eL * QUEUE_SHARE));
    out.steps = steps;
    out.pct = complete || (done && !den) ? 100 : Math.min(99, Math.floor(den ? (num / den) * 100 : 100));
    out.eta_min = complete ? 0 : Math.max(1, ...Object.keys(PER_PASS).map((k) => Math.ceil((steps[k].y - steps[k].x) / PER_PASS[k])), steps.labels.x < steps.labels.y ? 1 : 0) * PASS_MIN;
    out.new_labels = Math.max(0, lb.every - steps.labels.x);
  }
  return { out, b, ready, complete, bogus, items: it, pos: po };
}

// A frozen baseline with no items is no baseline (see "Progress"): cleared so the store counts again from scratch, with the done time
// it set (which can't be true). expected_pos and its date stay (the PO count doesn't depend on the lookup). → whether it cleared one.
async function healBaseline(T, store) {
  const r = await T.prepare(`UPDATE inv_baseline SET counted_at = NULL, expected_items = NULL, expected_labels = NULL, backfill_done_at = NULL
      WHERE store = ? AND counted_at IS NOT NULL AND COALESCE(expected_items, 0) = 0`).bind(store).run();
  if (!(r.meta && r.meta.changes)) return false;
  await T.prepare('DELETE FROM inv_item_counts WHERE store = ?').bind(store).run();
  return true;
}

// Freezes the baseline once counting is finished, records the done time once; → the store's progress after that.
// Called by the sweep and the history read, i.e. whenever something that moves a step has been written.
async function settle(T, store, at) {
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

// A history read can be the last thing a store's gathering was waiting for. Settled only while the store has a baseline that isn't done yet (or an empty one to clear).
async function settleAfterHistory(T, store, at) {
  const b = await T.prepare('SELECT backfill_done_at, counted_at, expected_items FROM inv_baseline WHERE store = ?').bind(store).first();
  if (b && (!b.backfill_done_at || (b.counted_at && !b.expected_items))) await settle(T, store, at);
}

// ------------------------------------------------------------------ item names
/*
  inv_items.name is an item's one name, whatever source gave it. Authoritative sources (the item lookup's and label
  details' ProductName, Portal's item record read for the unnamed list) may change a stored name, so a rename in Portal
  shows up; descriptive ones (cart line text, PO line descriptions, receive details' ItemName, RMA lines' item_name,
  outstanding parts' PartName, transfer lines) only fill a missing one. Category: filled when missing, never changed
  here (the item lookup's RetailCategory keeps that; the WO hook's 'Labor / service' marks non-stock items). A row made here has no quantities (qty / qty_hash NULL), which
  the item lookup's diff reads as a new item, never a change. Ignored items get no row.
*/
// index.js clean(): the WO hook has no H. Numbers (an item id sent as one) read as their text.
const cleanText = (v, max) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');
// Names gathered over one request, one per item: the first authoritative one wins, else the first one.
function nameBook() {
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
async function nameStmts(T, store, book, at) {
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
async function newOnly(T, store, moves) {
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
async function movementStmts(T, store, moves, at, need, wo = null) {
  const fresh = await newOnly(T, store, moves), stmts = [], labels = new Map();
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

// ------------------------------------------------------------------ store side
export async function retraceStore(req, env, url, store, path, H) {
  const T = env.TR;

  if (path === '/retrace/cursor' && req.method === 'GET') {
    const r = await T.prepare('SELECT sweep, value, updated_at FROM inv_cursors WHERE store = ?').bind(store).all();
    const cursors = {};
    for (const x of r.results) cursors[x.sweep] = { value: parse(x.value), at: x.updated_at };
    const b = await T.prepare('SELECT counted_at, expected_items, expected_pos FROM inv_baseline WHERE store = ?').bind(store).first();
    return H.json({ cursors, baseline: { frozen: !!(b && b.counted_at && b.expected_items > 0), posKnown: !!(b && b.expected_pos != null) } });
  }

  if (path === '/retrace/progress' && req.method === 'GET') {
    const p = (await progress(T, store)).out, seen = H.clean(url.searchParams.get('seen'), 40);
    return H.json({ store, state: p.state, pct: p.pct, done_at: p.done_at, announce: !!p.done_at && p.done_at !== seen }, 200);
  }

  if (path === '/retrace/watch' && req.method === 'POST') {
    const b = await H.readJson(req, MAX.watch);
    if (!Array.isArray(b.movements) || !b.movements.length || b.movements.length > WATCH_MAX) return H.fail(400, 'movements required (1 to ' + WATCH_MAX + ')');
    const at = H.now(), moves = b.movements.map((m) => normalize.watch(m, { sources: ['watch'] })).filter(Boolean);
    const rejected = b.movements.length - moves.length;
    if (!moves.length) return H.fail(400, 'no valid movement (' + rejected + ' refused)');
    const { stmts, added } = await movementStmts(T, store, moves, at, NEED.touched);
    await chunks(T, stmts);
    return H.json({ ok: true, added, rejected });
  }

  if (path === '/retrace/history' && req.method === 'POST') {
    const b = await H.readJson(req, MAX.history), label = cleanLabel(b.label);
    const all = Array.isArray(b.rows) ? b.rows : b.rows && Array.isArray(b.rows.value) ? b.rows.value : null;
    if (!label || !all || all.length > LIMIT.rows) return H.fail(400, 'label and rows required');
    // Each row names its store and label (Store "914", InventSerialId): another store's or label's rows are never written here.
    const rows = all.filter((r) => r && typeof r === 'object' && (storeNo(r.Store) == null || storeNo(r.Store) === store) && (r.InventSerialId == null || cleanLabel(r.InventSerialId) === label));
    const skipped = all.length - rows.length;
    // A label whose history names an ignored item (Portal's ItemId BB0001: a buyback device) isn't stock: dropped.
    if (rows.some((r) => ignoredItem(r.ItemId))) {
      await T.prepare('DELETE FROM inv_labels WHERE store = ? AND label = ?').bind(store, label).run();
      return H.json({ ok: true, added: 0, ignored: true, skipped });
    }
    const at = H.now(), hash =hash53(JSON.stringify(rows.map(({ ['@odata.etag']: _e, ...r }) => r)));
    const row = await T.prepare('SELECT history_hash FROM inv_labels WHERE store = ? AND label = ?').bind(store, label).first();
    const done = (latest) => T.prepare(`INSERT INTO inv_labels (store, label, item, serial_status, first_seen, last_seen, last_history_at, history_hash, need_history) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT (store, label) DO UPDATE SET last_history_at = excluded.last_history_at, history_hash = excluded.history_hash, need_history = 0, claimed_until = NULL,
          item = COALESCE(item, excluded.item), serial_status = COALESCE(serial_status, excluded.serial_status)`)
      .bind(store, label, labelSnapshot({ label }).item || null, latest, at, at, at, hash);
    if (row && row.history_hash === hash) { await done(null).run(); await settleAfterHistory(T, store, at); return H.json({ ok: true, added: 0, same: true, skipped }); }
    const moves = normalize.historyRows(label, rows);
    const fresh = await newOnly(T, store, moves);
    const latest = moves.length ? moves[moves.length - 1].raw_status : null;
    await chunks(T, [...fresh.map((m) => insertMv(T, store, m, at)), done(latest)]);
    await settleAfterHistory(T, store, at);
    return H.json({ ok: true, added: fresh.length, same: false, skipped });
  }

  if (path === '/retrace/sweep' && req.method === 'POST') {
    const b = await H.readJson(req, MAX.sweep);
    for (const k of ['items', 'labels', 'docs', 'movements', 'touched', 'pos', 'names', 'labelTotals']) if (b[k] != null && (!Array.isArray(b[k]) || b[k].length > LIMIT[k])) return H.fail(400, k + ': a list of at most ' + LIMIT[k]);
    if (b.cursors != null && (typeof b.cursors !== 'object' || Array.isArray(b.cursors) || Object.keys(b.cursors).length > LIMIT.cursors)) return H.fail(400, 'cursors: { sweep: value }');
    const at = H.now(), by = H.clean(b.by, 60) || null, stmts = [], book = nameBook();
    let written = 0, skipped = 0;

    /*
      Items: inventory-lookup rows folded per item ({ warehouseId: { available, reserved, inTransit, van } }). A row is
      written when it's new, its quantities or name changed, or it wasn't seen today (last_seen stays useful without
      rewriting every item on every pass).
    */
    const items = new Map();
    for (const r of b.items || []) {
      const item = H.clean(r && (r.ItemNumber ?? r.itemNumber ?? r.item) != null ? String(r.ItemNumber ?? r.itemNumber ?? r.item) : '', 40);
      if (!item || ignoredItem(item)) continue;
      const x = items.get(item) || { name: null, category: null, qty: {} };
      x.name = x.name || H.clean(r.ProductName ?? r.name, 120) || null;
      x.category = x.category || H.clean(r.RetailCategory ?? r.category, 60) || null;
      const wh = H.clean(r.WarehouseId != null ? String(r.WarehouseId) : '', 40) || '-';
      const n = (v) => (typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : 0);
      x.qty[wh] = { onHand: n(r.OnHandQuantity), available: n(r.AvailableQuantity), reserved: n(r.ReservedQuantity), inTransit: n(r.InTransitQuantity), salesOnOrder: n(r.SalesOnOrder),
        van: H.clean(r.VanNickName, 40) || null };
      items.set(item, x);
    }
    const changedItems = [];
    if (items.size) {
      const known = new Map((await T.prepare('SELECT item, name, category, qty_hash, last_seen FROM inv_items WHERE store = ? AND item IN (SELECT value FROM json_each(?))')
        .bind(store, JSON.stringify([...items.keys()])).all()).results.map((r) => [r.item, r]));
      for (const [item, x] of items) {
        const qty = JSON.stringify(Object.fromEntries(Object.entries(x.qty).sort(([a], [c]) => (a < c ? -1 : 1)))), qh = hash53(qty), k = known.get(item);
        // A row with no quantities was made by a name (see "item names"): the lookup sees the item for the first time.
        const changed = k && k.qty_hash !== qh;
        if (!k || k.qty_hash == null) changedItems.push({ item, why: 'new' }); else if (changed) changedItems.push({ item, why: 'changed' });
        if (k && !changed && k.name === x.name && k.category === x.category && String(k.last_seen).slice(0, 10) === at.slice(0, 10)) continue;
        written++;
        stmts.push(T.prepare(`INSERT INTO inv_items (store, item, name, category, qty, qty_hash, first_seen, last_seen, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (store, item) DO UPDATE SET name = COALESCE(excluded.name, name), category = COALESCE(excluded.category, category), qty = excluded.qty, qty_hash = excluded.qty_hash,
              last_seen = excluded.last_seen, changed_at = CASE WHEN qty_hash IS NOT excluded.qty_hash THEN excluded.last_seen ELSE changed_at END`)
          .bind(store, item, x.name, x.category, qty, qh, at, at, at));
      }
    }

    /*
      Labels: each snapshot against the stored row. New = known from now on and queued for its history (backfill);
      a status / location / consignment change = a movement (normalize.labelDiff) and its history queued first
      (changed). Fields a snapshot doesn't carry keep their stored value. Unchanged and already seen today = no write.
    */
    const snaps = new Map();
    for (const r of b.labels || []) {
      const s = labelSnapshot(r);
      if (!s || ignoredItem(s.item)) continue;
      const own = storeNo(s.store);
      if (own != null && own !== store) { skipped++; continue; } // another store's label: never written here
      snaps.set(s.label, Object.assign(snaps.get(s.label) || {}, s));
      if (s.product) book.add(s.item, s.product, r.list == null);
    }
    const diffMoves = [];
    if (snaps.size) {
      const known = new Map((await T.prepare(`SELECT label, item, product, serial_status, consignment, wh_type, wh_id, cost, po, wo, sales_order, arrival, oem_serial, imei, serial_modified, last_seen, last_history_at
          FROM inv_labels WHERE store = ? AND label IN (SELECT value FROM json_each(?))`).bind(store, JSON.stringify([...snaps.keys()])).all()).results.map((r) => [r.label, r]));
      const COLS = [['item', 'item'], ['product', 'product'], ['serial_status', 'status'], ['consignment', 'consignment'], ['wh_type', 'location'], ['wh_id', 'warehouse'], ['cost', 'cost'],
        ['po', 'po'], ['wo', 'wo'], ['sales_order', 'sales_order'], ['arrival', 'arrival'], ['oem_serial', 'oem_serial'], ['imei', 'imei'], ['serial_modified', 'modified']];
      for (const [label, s] of snaps) {
        const k = known.get(label);
        const before = k && { label, item: k.item, status: k.serial_status, location: k.wh_type, consignment: k.consignment };
        const moves = k ? normalize.labelDiff(before, s, at) : [];
        diffMoves.push(...moves);
        const differs = !k || COLS.some(([col, f]) => s[f] !== undefined && lc(s[f]) !== lc(k[col]));
        if (!differs && String(k.last_seen).slice(0, 10) === at.slice(0, 10)) continue;
        written++;
        // Portal's SerialModified moving on (or newer than the last history read) means its history has news even when
        // nothing this snapshot carries changed.
        const touched = k && s.modified && ((k.serial_modified && s.modified !== k.serial_modified) || (k.last_history_at && s.modified > k.last_history_at));
        const need = !k ? NEED.backfill : moves.length || touched ? NEED.changed : 0;
        if (s.sales_order && s.wo && (!k || k.sales_order !== s.sales_order || k.wo !== s.wo)) stmts.push(soWo(T, store, s.sales_order, s.wo, 'label', at));
        stmts.push(T.prepare(`INSERT INTO inv_labels (store, label, ${COLS.map(([c]) => c).join(', ')}, first_seen, last_seen, last_change_at, need_history)
            VALUES (?, ?, ${COLS.map(() => '?').join(', ')}, ?, ?, ?, ?)
            ON CONFLICT (store, label) DO UPDATE SET ${COLS.map(([c]) => c + ' = COALESCE(excluded.' + c + ', ' + c + ')').join(', ')}, last_seen = excluded.last_seen,
              last_change_at = COALESCE(excluded.last_change_at, last_change_at), need_history = MAX(need_history, excluded.need_history)`)
          .bind(store, label, ...COLS.map(([, f]) => (s[f] === undefined ? null : s[f])), at, at, differs && k ? at : null, need));
      }
    }

    // Movements the browser built (sweeps), checked and re-keyed; their labels are "touched". Plus the snapshot diff's.
    const sent = (b.movements || []).map((m) => normalize.watch(m, { sources: SWEEP_SOURCES })).filter(Boolean);
    const rejected = (b.movements || []).length - sent.length;
    const diffs = await newOnly(T, store, diffMoves);
    for (const m of diffs) stmts.push(insertMv(T, store, m, at));
    const fromSweep = await movementStmts(T, store, sent.filter((m) => !diffs.some((d) => d.key === m.key)), at, NEED.touched);
    stmts.push(...fromSweep.stmts);
    for (const t of new Set((b.touched || []).map(cleanLabel).filter(Boolean))) stmts.push(touchLabel(T, store, t, labelSnapshot({ label: t }).item || null, NEED.touched, at));

    // Documents: written only when something about the header changed. POs have their own path below (status history).
    for (const d of b.docs || []) {
      if (d && d.type === 'po') continue;
      const doc = normalize.doc(d && d.type, d);
      if (!doc) continue;
      const data = JSON.stringify(doc.data || {});
      if (data.length > 4000) continue;
      stmts.push(T.prepare(`INSERT INTO inv_docs (store, type, id, status, at, counterpart, data, first_seen, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (store, type, id) DO UPDATE SET status = excluded.status, at = COALESCE(excluded.at, at), counterpart = COALESCE(excluded.counterpart, counterpart), data = excluded.data, updated_at = excluded.updated_at
          WHERE status IS NOT excluded.status OR data IS NOT excluded.data OR (excluded.at IS NOT NULL AND at IS NOT excluded.at) OR (excluded.counterpart IS NOT NULL AND counterpart IS NOT excluded.counterpart)`)
        .bind(store, doc.type, doc.id, doc.status, doc.at, doc.counterpart, data, at, at));
    }
    /*
      Purchase orders: { header, receive } (or a bare list row) → the stored PO (retrace.js poState / mergePo, in inv_docs
      type 'po'), its status history (inv_doc_events: poEvents) and a 'received' movement per label going In Transit →
      Received (poMovements; skipped when serial history already gave that label a received row on this PO). A reading
      with lines or receive details clears need_detail; a list row that's new, or whose tracked fields moved, sets it.
      Labels on the receive details: known from now on with the PO linked, and queued for a history read when new or
      when their receive status changed. POs sent through `docs` (type 'po') come here as list rows.
    */
    // Names the browser read (see "item names"): only `authoritative: true` may rename.
    for (const x of b.names || []) if (x && typeof x === 'object') book.add(x.item, x.name, x.authoritative === true, x.category);

    const poIn = [...(b.pos || []), ...(b.docs || []).filter((d) => d && d.type === 'po')];
    const poOut = { seen: 0, written: 0, events: 0, received: 0 };
    if (poIn.length) {
      const readings = new Map();
      for (const x of poIn) {
        const detail = !!(x && (x.receive || (x.header && Array.isArray(x.header.PurchaseOrderLinesV2))));
        const st = x && poState(x.header || x, x.receive);
        if (!st) continue;
        for (const l of st.lines || []) book.add(l.item, l.desc, false); // LineDescription / receive ItemName: descriptive
        const r = readings.get(st.id);
        readings.set(st.id, r ? { st: mergePo(r.st, st), detail: r.detail || detail } : { st, detail });
      }
      poOut.seen = readings.size;
      const known = new Map(readings.size ? (await T.prepare("SELECT id, data, need_detail FROM inv_docs WHERE store = ? AND type = 'po' AND id IN (SELECT value FROM json_each(?))")
        .bind(store, JSON.stringify([...readings.keys()])).all()).results.map((r) => [r.id, r]) : []);
      const poMoves = [];
      for (const [id, { st, detail }] of readings) {
        const k = known.get(id), prev = k ? parse(k.data) : null;
        const next = mergePo(prev, st);
        if (detail) next.detailAt = at;
        const need = detail ? 0 : !prev || !prev.detailAt || poSig(prev) !== poSig(next) ? 1 : k.need_detail;
        const evs = poEvents(prev, next);
        for (const e of evs) stmts.push(T.prepare('INSERT OR IGNORE INTO inv_doc_events (store, type, id, at, field, old, new, by_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(store, 'po', id, at, e.field.slice(0, 80), e.old == null ? null : String(e.old).slice(0, 120), e.new == null ? null : String(e.new).slice(0, 120), detail ? 'detail' : 'list'));
        poOut.events += evs.length;
        poMoves.push(...poMovements(prev, next, at));
        // Labels new to this PO or whose receive status changed: linked to the PO and queued.
        const old = new Map(((prev && prev.labels) || []).map((l) => [l.label, l]));
        for (const l of next.labels && st.labels ? next.labels : []) {
          const o = old.get(l.label);
          if ((o && o.status === l.status) || ignoredItem(l.item)) continue;
          stmts.push(T.prepare(`INSERT INTO inv_labels (store, label, item, po, oem_serial, imei, first_seen, last_seen, need_history) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (store, label) DO UPDATE SET item = COALESCE(item, excluded.item), po = COALESCE(po, excluded.po), oem_serial = COALESCE(oem_serial, excluded.oem_serial),
                imei = COALESCE(imei, excluded.imei), need_history = MAX(need_history, excluded.need_history)`)
            .bind(store, l.label, l.item || null, id, l.oem || null, l.imei || null, at, at, NEED.touched));
        }
        const data = JSON.stringify(next);
        if (k && k.data === data && need === k.need_detail) continue; // nothing new (a list row repeating the stored values)
        if (data.length > PO_DATA_MAX) continue;
        poOut.written++; written++;
        const info = next.info || {};
        stmts.push(T.prepare(`INSERT INTO inv_docs (store, type, id, status, at, counterpart, data, need_detail, first_seen, updated_at) VALUES (?, 'po', ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (store, type, id) DO UPDATE SET status = excluded.status, at = COALESCE(excluded.at, at), counterpart = COALESCE(excluded.counterpart, counterpart), data = excluded.data,
              need_detail = excluded.need_detail, updated_at = excluded.updated_at`)
          .bind(store, id, next.status || null, isoAt(info.accountingDate) || null, info.vendor || info.storeName || null, data, need, at, at));
      }
      if (poMoves.length) {
        const have = new Set((await T.prepare(`SELECT ref_id || '|' || label AS k FROM inv_movements WHERE store = ? AND kind = 'received' AND ref_type = 'po'
            AND label IN (SELECT value FROM json_each(?))`).bind(store, JSON.stringify(poMoves.map((m) => m.label))).all()).results.map((r) => r.k));
        const fresh = await movementStmts(T, store, poMoves.filter((m) => !have.has(m.ref_id + '|' + m.label)), at, NEED.touched, null);
        stmts.push(...fresh.stmts);
        poOut.received = fresh.added;
      }
    }

    /*
      The baseline's inputs: label counts per item (only while counting: a frozen baseline never changes) and the PO total
      (taken once, before the freeze). settle() below decides when counting is finished.
    */
    await healBaseline(T, store);
    const base = await T.prepare('SELECT counted_at, expected_pos FROM inv_baseline WHERE store = ?').bind(store).first(), frozen = !!(base && base.counted_at);
    if (!frozen) {
      for (const x of b.labelTotals || []) {
        const item = H.clean(x && x.item != null ? String(x.item) : '', 40), total = nInt(x && x.total);
        if (!item || total == null || ignoredItem(item)) continue;
        stmts.push(T.prepare(`INSERT INTO inv_item_counts (store, item, labels, counted_at) VALUES (?, ?, ?, ?)
            ON CONFLICT (store, item) DO UPDATE SET labels = excluded.labels, counted_at = excluded.counted_at`).bind(store, item, total, at));
      }
      const pt = nInt(b.poTotal);
      if (pt != null && !(base && base.expected_pos != null)) {
        stmts.push(T.prepare(`INSERT INTO inv_baseline (store, expected_pos, pos_counted_at, created_at) VALUES (?1, ?2, ?3, ?3)
            ON CONFLICT (store) DO UPDATE SET expected_pos = COALESCE(expected_pos, excluded.expected_pos), pos_counted_at = COALESCE(pos_counted_at, excluded.pos_counted_at)`).bind(store, pt, at));
      }
    }
    for (const [name, value] of Object.entries(b.cursors || {})) {
      const v = JSON.stringify(value === undefined ? null : value);
      if (!CURSOR_RE.test(name) || name === LAST_SWEEP || v.length > 4000) return H.fail(400, 'bad cursor ' + String(name).slice(0, 40));
      if (name === 'lookup' && value && value.rows === 0) continue; // an empty lookup is a failed one: not recorded
      stmts.push(T.prepare('INSERT INTO inv_cursors (store, sweep, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (store, sweep) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').bind(store, name, v, at));
    }
    // An item the lookup named in this sweep keeps the lookup's name (written with its quantities above).
    for (const [item, x] of items) if (x.name) book.map.delete(item);
    const nameW = book.map.size ? await nameStmts(T, store, book, at) : [];
    stmts.push(...nameW);
    const added = diffs.length + fromSweep.added + poOut.received;
    stmts.push(T.prepare('INSERT INTO inv_cursors (store, sweep, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (store, sweep) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .bind(store, LAST_SWEEP, JSON.stringify({ by, items: items.size, labels: snaps.size, movements: added, changedItems: changedItems.length, named: nameW.length }), at));
    await chunks(T, stmts);
    const prog = await settle(T, store, at);

    // The history queue: changed > touched > backfill, most recently seen first; claimed so other browsers skip them.
    const want = Math.min(Math.max(Number.isInteger(b.need) ? b.need : NEED_MAX, 0), NEED_CAP);
    const q = want ? (await T.prepare('SELECT label FROM inv_labels WHERE store = ? AND need_history > 0 AND (claimed_until IS NULL OR claimed_until < ?) ORDER BY ' + QUEUE_ORDER + ' LIMIT ?')
      .bind(store, at, want + 1).all()).results.map((r) => r.label) : [];
    const need = q.slice(0, want);
    if (need.length) await T.prepare('UPDATE inv_labels SET claimed_until = ? WHERE store = ? AND label IN (SELECT value FROM json_each(?))').bind(later(CLAIM_MIN), store, JSON.stringify(need)).run();
    // POs whose lines / receive details to read next (poNeed: how many, default none), newest first.
    const poWant = Math.min(Math.max(Number.isInteger(b.poNeed) ? b.poNeed : 0, 0), PO_NEED_CAP);
    poOut.need = poWant ? (await T.prepare("SELECT id FROM inv_docs WHERE store = ? AND type = 'po' AND need_detail = 1 ORDER BY at DESC, id DESC LIMIT ?").bind(store, poWant).all()).results.map((r) => r.id) : [];
    // Items with movements or labels and no name yet (nameNeed: how many, default none), newest first: the browser reads their item record.
    const nameWant = Math.min(Math.max(Number.isInteger(b.nameNeed) ? b.nameNeed : 0, 0), UNNAMED_CAP);
    const unnamed = nameWant ? (await T.prepare(`SELECT item, MAX(at) AS last FROM (SELECT item, at FROM inv_movements WHERE store = ?1 AND item IS NOT NULL
        UNION ALL SELECT item, last_seen AS at FROM inv_labels WHERE store = ?1 AND item IS NOT NULL)
        WHERE item NOT IN (SELECT item FROM inv_items WHERE store = ?1 AND name IS NOT NULL) AND lower(item) NOT IN (SELECT value FROM json_each(?2))
        GROUP BY item ORDER BY last DESC, item LIMIT ?3`).bind(store, JSON.stringify(IGNORED_ITEMS), nameWant).all()).results.map((r) => r.item) : [];
    // Lookup items whose label count Portal hasn't been asked for (countNeed: how many, default none), until the baseline is frozen.
    const countWant = Math.min(Math.max(Number.isInteger(b.countNeed) ? b.countNeed : 0, 0), COUNT_CAP);
    const countNeed = countWant && prog.state === 'counting' ? (await T.prepare(`SELECT i.item FROM inv_items i LEFT JOIN inv_item_counts c ON c.store = i.store AND c.item = i.item
        WHERE i.store = ?1 AND i.qty_hash IS NOT NULL AND c.item IS NULL AND lower(i.item) NOT IN (SELECT value FROM json_each(?2)) ORDER BY i.item LIMIT ?3`)
      .bind(store, JSON.stringify(IGNORED_ITEMS), countWant).all()).results.map((r) => r.item) : [];
    // Items the coverage check found missed (referenced at the store, no labels stored): handed out once each, the browser reads their labels.
    let missedItems = [];
    try { missedItems = await verifyAsk(T, store, at); } catch (_) {}
    return H.json({ need, more: q.length > need.length, changedItems, added, rejected, skipped, written, named: nameW.length, unnamed, countNeed, missedItems, pos: poOut });
  }
  return H.fail(404, 'not found');
}

// ------------------------------------------------------------------ admin side
/*
  Behind the access gate (page 'retrace'; the store in the path, or ?store=, must be one of the person's stores).
  Paths below are under /api/tracker. Movements come back as stored, user_name as `user`.

  GET /retrace/item/:store/:item?from&to&kinds&user&limit&offset   → { store, item, info: { name, category, qty, last_seen,
        changed_at } | null, counts: [{ serial_status, wh_type, consignment, n }], labels: [{ label, serial_status, wh_type,
        consignment, wo, po, last_seen, last_history_at, need_history }], movements: [...], total,
        by_kind: [{ kind, n }], users: [{ user, n }], first_at, all_total, sold90 }
        from / to: YYYY-MM-DD (UTC days) or ISO; kinds: comma list of KINDS; user: who made the movement; newest first;
        limit ≤ 1000 (200). by_kind: the date range and user without the kinds filter (the page's filter chips); users:
        the date range and kinds without the user filter (its person picker); first_at / all_total: every movement of the
        item, no filter; sold90: 'sold' movements in the last 90 days.
  GET /retrace/serials/:store/:item?group&days&limit&offset   → { store, item, serials: [{ label, now, group, serial_status, wh_type, wo, po,
        moves, last: { at, kind, user, source, ref_type, ref_id, wo, from_wh, to_wh, detail } }], total, groups: { all, in, wo, out, q, bad },
        loose: [movements with no label], loose_total }
        the item list's one row per serial (the page's item view): last = the newest movement, moves = all of the label's movements,
        now / group = where it stands (retrace.js serialNow: Portal's status on the label, else the last movement, which wins when newer than the label's last snapshot). groups: how many
        serials are in each group (days applied, group not); group: in|wo|out|q|bad; days: only serials whose last movement is that
        recent (1-3650); newest last movement first; limit ≤ 500 (200). loose: the item's movements with no label (days applied), 50 newest.
  GET /retrace/items?store=&limit=&offset=   → { items: [{ item, name, category, qty, on_hand, available, moves, last_at }], total }
        items with movements at the store, most recent movement first; name from inv_items, else a label's product;
        on_hand: inv_items qty summed over the store's warehouses (null when the item lookup hasn't seen it);
        available: the page's Available tile (lookup quantity over non-quarantine warehouses, else the available labels; null with neither); limit ≤ 500 (100).
  GET /retrace/label/:store/:label   → { label: inv_labels row | null, movements: [...] } oldest first · 404 when neither
  GET /retrace/search?store=&q=      → { labels: [...], items: [...], refs: [{ store, ref_type, ref_id, n, first_at, last_at }],
        docs: [...] } · q (2+ chars): a label (or its start), OEM serial / IMEI, an item number or name, a PO / WO /
        transfer / RMA / buyback / count id. Without store: every store the person can see.
  GET /retrace/po/:store/:po         → { po, header, lines, labels, events, movements } · 404 when neither the PO nor a movement
        naming it is known. header: the PO's tracked fields + info (retrace.js poState); lines: { line, item, desc, ordered,
        shipped, received, cancelled, remaining, price, … } (remaining worked out when Portal gave none); labels: each label's
        receive status on the PO plus its inv_labels row now (serial_status, wh_type, consignment, wo, sales_order, last_seen);
        events: status history oldest first; movements: inv_movements naming the PO (ref_type 'po'), oldest first.
  GET /retrace/pos?store=&status=&from=&to=&limit=&offset=   → { pos: [{ store, po, status, approval, at, counterpart, pool, type,
        total, remaining, registered, tracking, lines, labels, received, need_detail, updated_at, last_change }], total }
        newest (accounting date) first; from / to on the accounting date; limit ≤ 500 (100). Without store: their stores.
  GET  /retrace/verify/:store        → the store's last coverage check (src/retrace-verify.js): { store, checked_at: null } before the first, else
        { store, checked_at, by: 'auto' | email, pass, total: 5, checks: [{ n, key: counts|qty|stale|missed|spot, status: pass|fail|todo, result, … }] }.
        counts / qty / missed carry `rows` of exact discrepancies (capped 50), stale its first 5 labels and `n`, spot the 10 sampled labels with
        status, moves and who ticked them. Check 5 and `pass` are worked out from the ticks when read.
  POST /retrace/verify/:store/run    → the same, after running the checks again (new spot sample); 409 while the store's baseline isn't frozen
  POST /retrace/verify/:store/tick { label, matches }   → the same: a person's tick on one of the sample's labels (400 for any other), recorded with their email
  GET /retrace/queue/:store?reason=&item=&limit=&offset=   → the store's history queue (the Collection queue panel): { store, total, counts: { all, never,
        changed, recheck }, waiting, being_read, read_10min, per_pass, eta_min, items: [{ item, name, n }], rows: [{ pos, label, item, name, reason, since }],
        recent: [{ label, item, name, at }] }. rows: labels waiting (need_history > 0, not claimed by a browser), in exactly the order the sweep
        hands them out (QUEUE_ORDER); pos is the place in the whole queue, filters or not. reason: never (history not read yet) | changed (read, then
        the label changed or a diff saw it change) | recheck (queued again); the same tests as the Stale histories check (retrace-verify.js
        QUEUE_REASON). counts / items follow the item filter, not the reason; total follows both. being_read: labels with an unexpired claim;
        read_10min: histories read in the last 10 minutes; eta_min: the queue at PER_PASS.histories a pass, in whole passes. limit ≤ 200 (50). Read only.
  GET /retrace/coverage              → { stores: [{ store, labels, histories, backlog, claimed, items, movements,
        last_history_at, last_sweep_at, last_sweep, progress }] } for the stores the person can see. progress: the store's
        baseline progress (see "Progress" at the top: state, pct, done_at, counted_at, eta_min, steps { stock, labels, histories,
        pos, names: { x, y } }, counting { items_done, items_total, pos_known }, new_labels), what the page's strip draws.
*/
// Movements with the WO behind a sales order (inv_so_wo) as `wo`: serial history leaves the WO number blank.
const MV_COLS = `m.id, m.store, m.label, m.item, m.at, m.kind, m.raw_status, m.raw_event, m.ref_type, m.ref_id, m.ref_line, m.from_wh, m.to_wh, m.user_name AS user, m.source, m.detail, m.recorded_at,
  CASE WHEN m.ref_type = 'wo' THEN m.ref_id ELSE sw.wo END AS wo`;
const MV_FROM = "inv_movements m LEFT JOIN inv_so_wo sw ON m.ref_type = 'sales_order' AND sw.store = m.store AND sw.sales_order = m.ref_id";
const dayFrom = (v) => (/^\d{4}-\d\d-\d\d$/.test(v || '') ? v + 'T00:00:00.000Z' : isoAt(v));
const dayTo = (v) => (/^\d{4}-\d\d-\d\d$/.test(v || '') ? v + 'T23:59:59.999Z' : isoAt(v));
const likeEsc = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

// The history queue as the sweep sees it, for the admin page's Collection queue panel (see GET /retrace/queue above).
async function queueView(T, store, o) {
  const now = new Date().toISOString(), tenAgo = new Date(Date.now() - 10 * 60000).toISOString();
  const reason = ['never', 'changed', 'recheck'].includes(o.reason) ? o.reason : null, item = o.item || null;
  const limit = Math.min(Math.max(parseInt(o.limit, 10) || 50, 1), 200), offset = Math.min(Math.max(parseInt(o.offset, 10) || 0, 0), 1e6);
  // position in the whole waiting queue first (a window over the unclaimed rows, in the sweep's order), then the filters
  const [rows, counts, claimed, read, items, recent] = await T.batch([
    T.prepare(`SELECT * FROM (SELECT ROW_NUMBER() OVER (ORDER BY ${QUEUE_ORDER}) AS pos, label, item, ${QUEUE_REASON} AS reason, ${QUEUE_SINCE} AS since
          FROM inv_labels WHERE store = ?1 AND need_history > 0 AND (claimed_until IS NULL OR claimed_until < ?2)) q
        WHERE (?3 IS NULL OR reason = ?3) AND (?4 IS NULL OR item = ?4) ORDER BY pos LIMIT ?5 OFFSET ?6`).bind(store, now, reason, item, limit, offset),
    T.prepare(`SELECT reason, COUNT(*) AS n FROM (SELECT ${QUEUE_REASON} AS reason, item FROM inv_labels WHERE store = ?1 AND need_history > 0 AND (claimed_until IS NULL OR claimed_until < ?2)) q
        WHERE (?3 IS NULL OR item = ?3) GROUP BY reason`).bind(store, now, item),
    T.prepare('SELECT COUNT(*) AS n FROM inv_labels WHERE store = ? AND need_history > 0 AND claimed_until > ?').bind(store, now),
    T.prepare('SELECT COUNT(*) AS n FROM inv_labels WHERE store = ? AND last_history_at >= ?').bind(store, tenAgo),
    T.prepare(`SELECT l.item, i.name, COUNT(*) AS n FROM inv_labels l LEFT JOIN inv_items i ON i.store = l.store AND i.item = l.item
        WHERE l.store = ? AND l.need_history > 0 AND (l.claimed_until IS NULL OR l.claimed_until < ?) AND l.item IS NOT NULL GROUP BY l.item ORDER BY n DESC, l.item LIMIT 50`).bind(store, now),
    T.prepare(`SELECT l.label, l.item, i.name, l.last_history_at AS at FROM inv_labels l LEFT JOIN inv_items i ON i.store = l.store AND i.item = l.item
        WHERE l.store = ? AND l.last_history_at IS NOT NULL ORDER BY l.last_history_at DESC, l.label LIMIT 10`).bind(store),
  ]);
  const by = { never: 0, changed: 0, recheck: 0 };
  for (const r of counts.results) by[r.reason] = r.n;
  const waiting = by.never + by.changed + by.recheck, names = new Map();
  if (rows.results.length) for (const r of (await T.prepare('SELECT item, name FROM inv_items WHERE store = ? AND item IN (SELECT value FROM json_each(?))').bind(store, JSON.stringify(rows.results.map((r) => r.item))).all()).results) names.set(r.item, r.name);
  // the estimate is for the whole queue (claimed ones are being read now and leave it within a pass), whatever the filters
  const all = (await T.prepare('SELECT COUNT(*) AS n FROM inv_labels WHERE store = ? AND need_history > 0 AND (claimed_until IS NULL OR claimed_until < ?)').bind(store, now).first()).n;
  return { store, total: reason ? by[reason] : waiting, counts: { all: waiting, never: by.never, changed: by.changed, recheck: by.recheck }, waiting: all, being_read: claimed.results[0].n, read_10min: read.results[0].n,
    per_pass: PER_PASS.histories, eta_min: all ? Math.ceil(all / PER_PASS.histories) * PASS_MIN : 0, items: items.results,
    rows: rows.results.map((r) => ({ pos: r.pos, label: r.label, item: r.item, name: names.get(r.item) || null, reason: r.reason, since: r.since })), recent: recent.results };
}

export async function retraceAdmin(req, env, url, path, me, email, H) {
  const T = env.TR, q = url.searchParams;
  const canSee = (st) => !!me && me.canSee(st);

  // Coverage check (src/retrace-verify.js): the only routes here that write (its result and the spot check's ticks).
  const vm = path.match(/^\/retrace\/verify\/(\d{1,6})(?:\/(run|tick))?$/);
  if (vm) {
    const store = Number(vm[1]), act = vm[2] || null;
    if (req.method !== (act ? 'POST' : 'GET')) return H.fail(404, 'not found', false);
    if (!canSee(store)) return H.fail(403, 'not your store', false);
    const at = new Date().toISOString();
    if (!act) { await H.log(env, email, 'retrace:verify', store); return H.json(await verifyView(T, store), 200, false); }
    if (act === 'run') {
      if (!(await verifyRun(T, store, at, email))) return H.fail(409, 'the store\'s baseline is not frozen yet', false);
      await H.log(env, email, 'retrace:verify-run', store);
    } else {
      const b = await H.readJson(req, 2000), label = cleanLabel(b.label);
      if (!label || typeof b.matches !== 'boolean') return H.fail(400, 'label and matches (true or false) required', false);
      if (!(await verifyTick(T, store, label, b.matches, email, at))) return H.fail(400, 'not one of the labels to check', false);
      await H.log(env, email, 'retrace:verify-tick', store, null, label + (b.matches ? ' matches' : ' unticked'));
    }
    return H.json(await verifyView(T, store), 200, false);
  }
  if (req.method !== 'GET') return H.fail(404, 'not found', false);

  const qm = path.match(/^\/retrace\/queue\/(\d{1,6})$/);
  if (qm) {
    const store = Number(qm[1]);
    if (!canSee(store)) return H.fail(403, 'not your store', false);
    await H.log(env, email, 'retrace:queue', store);
    return H.json(await queueView(T, store, { reason: q.get('reason'), item: H.clean(q.get('item'), 40), limit: q.get('limit'), offset: q.get('offset') }), 200, false);
  }

  const im = path.match(/^\/retrace\/item\/(\d{1,6})\/([^/]{1,80})$/);
  if (im) {
    const store = Number(im[1]), item = H.clean(decodeURIComponent(im[2]), 40);
    if (!canSee(store)) return H.fail(403, 'not your store', false);
    if (!item) return H.fail(400, 'item required', false);
    const where = ['m.store = ?', 'm.item = ?'], args = [store, item];
    const from = q.get('from') ? dayFrom(q.get('from')) : null, to = q.get('to') ? dayTo(q.get('to')) : null;
    if (q.get('from') && !from) return H.fail(400, 'from: YYYY-MM-DD or ISO', false);
    if (q.get('to') && !to) return H.fail(400, 'to: YYYY-MM-DD or ISO', false);
    if (from) { where.push('m.at >= ?'); args.push(from); }
    if (to) { where.push('m.at <= ?'); args.push(to); }
    // The date range alone (by_kind adds the user, users adds the kinds; the movement list has all three).
    const base = [...where], baseArgs = [...args], kw = [], kwArgs = [], uw = [], uwArgs = [];
    if (q.get('kinds')) {
      const kinds = q.get('kinds').split(',').map((k) => k.trim()).filter(Boolean);
      if (!kinds.length || kinds.some((k) => !KINDS.includes(k))) return H.fail(400, 'kinds: ' + KINDS.join(', '), false);
      kw.push('m.kind IN (SELECT value FROM json_each(?))'); kwArgs.push(JSON.stringify(kinds));
    }
    const user = H.clean(q.get('user'), 80);
    if (user) { uw.push('m.user_name = ?'); uwArgs.push(user); }
    where.push(...kw, ...uw); args.push(...kwArgs, ...uwArgs);
    const limit = Math.min(H.int(q.get('limit')) || 200, 1000), offset = H.int(q.get('offset')) || 0;
    const since90 = new Date(Date.now() - 90 * 86400000).toISOString();
    const [info, counts, labels, moves, total, byKind, users, all] = await T.batch([
      T.prepare('SELECT name, category, qty, last_seen, changed_at FROM inv_items WHERE store = ? AND item = ?').bind(store, item),
      T.prepare('SELECT serial_status, wh_type, consignment, COUNT(*) AS n FROM inv_labels WHERE store = ? AND item = ? GROUP BY serial_status, wh_type, consignment ORDER BY n DESC').bind(store, item),
      T.prepare('SELECT label, serial_status, wh_type, consignment, wo, po, last_seen, last_history_at, need_history FROM inv_labels WHERE store = ? AND item = ? ORDER BY last_seen DESC LIMIT 1000').bind(store, item),
      T.prepare(`SELECT ${MV_COLS} FROM ${MV_FROM} WHERE ${where.join(' AND ')} ORDER BY m.at DESC, m.id DESC LIMIT ? OFFSET ?`).bind(...args, limit, offset),
      T.prepare(`SELECT COUNT(*) AS n FROM inv_movements m WHERE ${where.join(' AND ')}`).bind(...args),
      T.prepare(`SELECT m.kind, COUNT(*) AS n FROM inv_movements m WHERE ${[...base, ...uw].join(' AND ')} GROUP BY m.kind ORDER BY n DESC`).bind(...baseArgs, ...uwArgs),
      T.prepare(`SELECT m.user_name AS user, COUNT(*) AS n FROM inv_movements m WHERE ${[...base, ...kw].join(' AND ')} AND m.user_name IS NOT NULL GROUP BY m.user_name ORDER BY n DESC LIMIT 100`).bind(...baseArgs, ...kwArgs),
      T.prepare("SELECT MIN(at) AS first_at, COUNT(*) AS n, SUM(CASE WHEN kind = 'sold' AND at >= ? THEN 1 ELSE 0 END) AS sold90 FROM inv_movements WHERE store = ? AND item = ?").bind(since90, store, item),
    ]);
    const i = info.results[0] || null, a = all.results[0] || {};
    await H.log(env, email, 'retrace:item', store, null, item);
    return H.json({ store, item, info: i && Object.assign(i, { qty: parse(i.qty) }), counts: counts.results, labels: labels.results, movements: moves.results, total: total.results[0].n,
      by_kind: byKind.results, users: users.results, first_at: a.first_at || null, all_total: a.n || 0, sold90: a.sold90 || 0 }, 200, false);
  }

  const sm = path.match(/^\/retrace\/serials\/(\d{1,6})\/([^/]{1,80})$/);
  if (sm) {
    const store = Number(sm[1]), item = H.clean(decodeURIComponent(sm[2]), 40);
    if (!canSee(store)) return H.fail(403, 'not your store', false);
    if (!item) return H.fail(400, 'item required', false);
    const group = q.get('group') || 'all';
    if (!['all', 'in', 'wo', 'out', 'q', 'bad'].includes(group)) return H.fail(400, 'group: all, in, wo, out, q, bad', false);
    const days = q.get('days') ? H.int(q.get('days')) : null;
    if (q.get('days') && (days == null || days < 1 || days > 3650)) return H.fail(400, 'days: 1 to 3650', false);
    const since = days ? new Date(Date.now() - days * 86400000).toISOString() : null;
    const limit = Math.min(H.int(q.get('limit')) || 200, 500), offset = H.int(q.get('offset')) || 0;
    const [last, loose, looseN] = await T.batch([
      T.prepare(`SELECT r.*, l.serial_status, l.wh_type, l.wo AS label_wo, l.po AS label_po, l.last_seen AS label_seen FROM (
          SELECT ${MV_COLS}, ROW_NUMBER() OVER (PARTITION BY m.label ORDER BY m.at DESC, m.id DESC) AS rn, COUNT(*) OVER (PARTITION BY m.label) AS moves
          FROM ${MV_FROM} WHERE m.store = ? AND m.item = ? AND m.label IS NOT NULL) r
        LEFT JOIN inv_labels l ON l.store = r.store AND l.label = r.label WHERE r.rn = 1 ${since ? 'AND r.at >= ?' : ''} ORDER BY r.at DESC, r.id DESC LIMIT 5000`).bind(...[store, item, since].filter((v) => v != null)),
      T.prepare(`SELECT ${MV_COLS} FROM ${MV_FROM} WHERE m.store = ? AND m.item = ? AND m.label IS NULL ${since ? 'AND m.at >= ?' : ''} ORDER BY m.at DESC, m.id DESC LIMIT 50`).bind(...[store, item, since].filter((v) => v != null)),
      T.prepare(`SELECT COUNT(*) AS n FROM inv_movements m WHERE m.store = ? AND m.item = ? AND m.label IS NULL ${since ? 'AND m.at >= ?' : ''}`).bind(...[store, item, since].filter((v) => v != null)),
    ]);
    const groups = { all: 0, in: 0, wo: 0, out: 0, q: 0, bad: 0 };
    const rows = last.results.map((r) => {
      const [now, g] = serialNow(r.serial_status, r.wh_type, r.kind, !!r.label_seen && r.at > r.label_seen);
      groups.all++; if (g) groups[g]++;
      return { label: r.label, now, group: g, serial_status: r.serial_status || null, wh_type: r.wh_type || null, wo: r.label_wo || null, po: r.label_po || null, moves: r.moves,
        last: { at: r.at, kind: r.kind, user: r.user, source: r.source, ref_type: r.ref_type, ref_id: r.ref_id, wo: r.wo, from_wh: r.from_wh, to_wh: r.to_wh, detail: r.detail } };
    });
    const shown = group === 'all' ? rows : rows.filter((r) => r.group === group);
    await H.log(env, email, 'retrace:serials', store, null, item);
    return H.json({ store, item, serials: shown.slice(offset, offset + limit), total: shown.length, groups, loose: loose.results, loose_total: looseN.results[0].n }, 200, false);
  }

  const lm = path.match(/^\/retrace\/label\/(\d{1,6})\/([^/]{1,80})$/);
  if (lm) {
    const store = Number(lm[1]), label = cleanLabel(decodeURIComponent(lm[2]));
    if (!canSee(store)) return H.fail(403, 'not your store', false);
    if (!label) return H.fail(400, 'not a label', false);
    const [row, moves] = await T.batch([
      T.prepare('SELECT * FROM inv_labels WHERE store = ? AND label = ?').bind(store, label),
      T.prepare(`SELECT ${MV_COLS} FROM ${MV_FROM} WHERE m.store = ? AND m.label = ? ORDER BY m.at, m.id LIMIT 2000`).bind(store, label),
    ]);
    if (!row.results.length && !moves.results.length) return H.fail(404, 'label not seen at this store', false);
    await H.log(env, email, 'retrace:label', store, null, label);
    return H.json({ label: row.results[0] || null, movements: moves.results }, 200, false);
  }

  // Store filter for the cross-store routes: ?store= (gated already), else the person's stores.
  const scope = () => {
    if (q.get('store')) { const st = H.int(q.get('store')); return st != null && canSee(st) ? { sql: 'store = ?', args: [st] } : null; }
    if (me.scope === 'all') return { sql: '1 = 1', args: [] };
    return { sql: 'store IN (SELECT value FROM json_each(?))', args: [JSON.stringify(me.stores)] };
  };

  // Items with movements at a store, most recent movement first (the page's item list).
  if (path === '/retrace/items') {
    const store = H.int(q.get('store'));
    if (store == null) return H.fail(400, 'store required', false);
    if (!canSee(store)) return H.fail(403, 'not your store', false);
    const limit = Math.min(H.int(q.get('limit')) || 100, 500), offset = H.int(q.get('offset')) || 0;
    const [rows, total] = await T.batch([
      T.prepare(`SELECT m.item, m.moves, m.last_at, i.name, i.category, i.qty, lb.n AS label_n, lb.av AS label_av,
          (SELECT l.product FROM inv_labels l WHERE l.store = ?1 AND l.item = m.item AND l.product IS NOT NULL LIMIT 1) AS product
          FROM (SELECT item, COUNT(*) AS moves, MAX(at) AS last_at FROM inv_movements WHERE store = ?1 AND item IS NOT NULL GROUP BY item) m
          LEFT JOIN inv_items i ON i.store = ?1 AND i.item = m.item
          LEFT JOIN (SELECT item, COUNT(*) AS n, SUM(lower(COALESCE(serial_status, '')) = 'available' AND lower(COALESCE(wh_type, '')) <> 'quarantine') AS av FROM inv_labels WHERE store = ?1 GROUP BY item) lb ON lb.item = m.item
          ORDER BY m.last_at DESC, m.item LIMIT ?2 OFFSET ?3`).bind(store, limit, offset),
      T.prepare('SELECT COUNT(DISTINCT item) AS n FROM inv_movements WHERE store = ? AND item IS NOT NULL').bind(store),
    ]);
    const items = rows.results.map((r) => {
      const qty = parse(r.qty);
      const onHand = qty && typeof qty === 'object' ? Object.values(qty).reduce((n, w) => n + (w && typeof w.onHand === 'number' ? w.onHand : 0), 0) : null;
      // available: what the item page's Available tile shows: Portal's stock-lookup quantity (non-quarantine warehouses), else the available labels; null with neither
      const whs = qty && typeof qty === 'object' ? Object.entries(qty).filter(([, w]) => w && typeof w === 'object') : [];
      const available = whs.length ? whs.filter(([id]) => !/q$/i.test(id)).reduce((n, [, w]) => n + (typeof w.available === 'number' ? w.available : 0), 0) : r.label_n ? r.label_av || 0 : null;
      return { item: r.item, name: r.name || r.product || null, category: r.category || null, qty, on_hand: onHand, available, moves: r.moves, last_at: r.last_at };
    });
    return H.json({ items, total: total.results[0].n }, 200, false);
  }

  if (path === '/retrace/search') {
    const s = scope(), term = H.clean(q.get('q'), 60);
    if (!s) return H.fail(403, 'not your store', false);
    if (!term || term.length < 2) return H.fail(400, 'q (2 characters or more) required', false);
    const like = likeEsc(term) + '%', label = cleanLabel(term) || term;
    const [labels, items, refs, docs] = await T.batch([
      T.prepare(`SELECT store, label, item, product, serial_status, wh_type, consignment, wo, po, last_seen FROM inv_labels
          WHERE ${s.sql} AND (label = ? OR label LIKE ? ESCAPE '\\' OR oem_serial = ? OR imei = ? OR po = ? OR wo = ?) ORDER BY label = ? DESC, last_seen DESC LIMIT 50`).bind(...s.args, label, like, term, term, term, term, label),
      T.prepare(`SELECT store, item, name, category, last_seen FROM inv_items WHERE ${s.sql} AND (item = ? OR name LIKE ? ESCAPE '\\') ORDER BY item = ? DESC, name LIMIT 30`).bind(...s.args, term, '%' + likeEsc(term) + '%', term),
      // A WO number also finds its sales orders' rows (history names only the FSO).
      T.prepare(`SELECT store, ref_type, ref_id, COUNT(*) AS n, MIN(at) AS first_at, MAX(at) AS last_at FROM inv_movements WHERE ${s.sql}
          AND (ref_id = ? OR (ref_type = 'sales_order' AND ref_id IN (SELECT sales_order FROM inv_so_wo WHERE wo = ? AND store = inv_movements.store)))
          GROUP BY store, ref_type, ref_id ORDER BY last_at DESC LIMIT 30`).bind(...s.args, term, term),
      T.prepare(`SELECT store, type, id, status, at, counterpart FROM inv_docs WHERE ${s.sql} AND id = ? LIMIT 30`).bind(...s.args, term),
    ]);
    await H.log(env, email, 'retrace:search', q.get('store') ? H.int(q.get('store')) : null, null, term);
    return H.json({ labels: labels.results, items: items.results, refs: refs.results, docs: docs.results }, 200, false);
  }

  const pm = path.match(/^\/retrace\/po\/(\d{1,6})\/([^/]{1,80})$/);
  if (pm) {
    const store = Number(pm[1]), po = H.clean(decodeURIComponent(pm[2]), 40);
    if (!canSee(store)) return H.fail(403, 'not your store', false);
    if (!po) return H.fail(400, 'po required', false);
    const [doc, events, moves] = await T.batch([
      T.prepare("SELECT status, at, counterpart, data, need_detail, first_seen, updated_at FROM inv_docs WHERE store = ? AND type = 'po' AND id = ?").bind(store, po),
      T.prepare("SELECT at, field, old, new, by_source FROM inv_doc_events WHERE store = ? AND type = 'po' AND id = ? ORDER BY at, rowid").bind(store, po),
      T.prepare(`SELECT ${MV_COLS} FROM ${MV_FROM} WHERE m.store = ? AND m.ref_type = 'po' AND m.ref_id = ? ORDER BY m.at, m.id LIMIT 2000`).bind(store, po),
    ]);
    const d = doc.results[0] || null;
    if (!d && !moves.results.length) return H.fail(404, 'PO not seen at this store', false);
    const data = (d && parse(d.data)) || { id: po };
    const { lines: rawLines, labels: rawLabels, ...header } = data;
    const num = (v) => (typeof v === 'number' ? v : null);
    const lines = (rawLines || []).map((l) => Object.assign({}, l, { remaining: l.remaining != null ? l.remaining
      : num(l.ordered) != null ? Math.max(0, num(l.ordered) - (num(l.received) || 0) - (num(l.cancelled) || 0)) : null }));
    const list = rawLabels || [], now = new Map();
    for (let i = 0; i < list.length; i += 500) {
      const r = await T.prepare('SELECT label, serial_status, wh_type, consignment, wo, sales_order, last_seen, last_history_at FROM inv_labels WHERE store = ? AND label IN (SELECT value FROM json_each(?))')
        .bind(store, JSON.stringify(list.slice(i, i + 500).map((l) => l.label))).all();
      for (const x of r.results) now.set(x.label, x);
    }
    const labels = list.map((l) => Object.assign({}, l, { receive_status: l.status, now: now.get(l.label) || null }));
    await H.log(env, email, 'retrace:po', store, null, po);
    return H.json({ po, header: Object.assign(header, d ? { status: d.status, at: d.at, counterpart: d.counterpart, need_detail: d.need_detail, first_seen: d.first_seen, updated_at: d.updated_at } : {}),
      lines, labels, events: events.results, movements: moves.results }, 200, false);
  }

  if (path === '/retrace/pos') {
    const s = scope();
    if (!s) return H.fail(403, 'not your store', false);
    const where = [s.sql.replace(/\bstore\b/g, 'd.store'), "d.type = 'po'"], args = [...s.args];
    const from = q.get('from') ? dayFrom(q.get('from')) : null, to = q.get('to') ? dayTo(q.get('to')) : null;
    if ((q.get('from') && !from) || (q.get('to') && !to)) return H.fail(400, 'from / to: YYYY-MM-DD or ISO', false);
    if (from) { where.push('d.at >= ?'); args.push(from); }
    if (to) { where.push('d.at <= ?'); args.push(to); }
    const status = H.clean(q.get('status'), 40);
    if (status) { where.push('d.status = ?'); args.push(status); }
    const limit = Math.min(H.int(q.get('limit')) || 100, 500), offset = H.int(q.get('offset')) || 0;
    const [rows, total] = await T.batch([
      T.prepare(`SELECT d.store, d.id, d.status, d.at, d.counterpart, d.data, d.need_detail, d.updated_at,
          (SELECT MAX(e.at) FROM inv_doc_events e WHERE e.store = d.store AND e.type = 'po' AND e.id = d.id) AS last_change
          FROM inv_docs d WHERE ${where.join(' AND ')} ORDER BY d.at DESC, d.id DESC LIMIT ? OFFSET ?`).bind(...args, limit, offset),
      T.prepare(`SELECT COUNT(*) AS n FROM inv_docs d WHERE ${where.join(' AND ')}`).bind(...args),
    ]);
    const pos = rows.results.map((r) => {
      const x = parse(r.data) || {}, info = x.info || {};
      return { store: r.store, po: r.id, status: r.status, approval: x.approval ?? null, at: r.at, counterpart: r.counterpart, pool: info.pool ?? null, type: info.type ?? null,
        total: info.total ?? null, remaining: x.remaining ?? null, registered: x.registered ?? null, tracking: x.tracking ?? null, lines: x.lines ? x.lines.length : null,
        labels: x.labels ? x.labels.length : null, received: x.labels ? x.labels.filter((l) => /^received$/i.test(l.status || '')).length : null,
        need_detail: r.need_detail, updated_at: r.updated_at, last_change: r.last_change || null };
    });
    return H.json({ pos, total: total.results[0].n }, 200, false);
  }

  if (path === '/retrace/coverage') {
    const s = scope();
    if (!s) return H.fail(403, 'not your store', false);
    const at = new Date().toISOString();
    const [labels, items, moves, sweeps] = await T.batch([
      T.prepare(`SELECT store, COUNT(*) AS labels, SUM(CASE WHEN last_history_at IS NOT NULL THEN 1 ELSE 0 END) AS histories, SUM(CASE WHEN need_history > 0 THEN 1 ELSE 0 END) AS backlog,
          SUM(CASE WHEN claimed_until > ? THEN 1 ELSE 0 END) AS claimed, MAX(last_history_at) AS last_history_at FROM inv_labels WHERE ${s.sql} GROUP BY store`).bind(at, ...s.args),
      // items: the ones the item lookup has quantities for (rows made by a name alone aren't counted)
      T.prepare(`SELECT store, COUNT(qty_hash) AS items FROM inv_items WHERE ${s.sql} GROUP BY store`).bind(...s.args),
      T.prepare(`SELECT store, COUNT(*) AS movements FROM inv_movements WHERE ${s.sql} GROUP BY store`).bind(...s.args),
      T.prepare(`SELECT store, value, updated_at FROM inv_cursors WHERE ${s.sql} AND sweep = ?`).bind(...s.args, LAST_SWEEP),
    ]);
    const by = new Map();
    const row = (st) => by.get(st) || by.set(st, { store: st, labels: 0, histories: 0, backlog: 0, claimed: 0, items: 0, movements: 0, last_history_at: null, last_sweep_at: null, last_sweep: null }).get(st);
    for (const r of labels.results) Object.assign(row(r.store), r);
    for (const r of items.results) row(r.store).items = r.items;
    for (const r of moves.results) row(r.store).movements = r.movements;
    for (const r of sweeps.results) Object.assign(row(r.store), { last_sweep_at: r.updated_at, last_sweep: parse(r.value) });
    const list = [...by.values()].filter((x) => canSee(x.store)).sort((a, b) => a.store - b.store);
    for (const x of list) x.progress = (await progress(T, x.store)).out;
    return H.json({ stores: list }, 200, false);
  }
  return H.fail(404, 'not found', false);
}
