/*
  Retrace, the store side: what the collector in a store browser sends (src/28-retrace-collect.js). Mounted by storeApi at
  /v1/:store/tracker/retrace/…; the routes and what each answers are listed at the top of retrace-api.js.
*/
import { json, fail, clean, readJson, now, parse } from './http.js';
import { spend } from './budget.js';
import { passStmts } from './usage.js';
import { TARGET_LISTED, LISTED_JOIN_SQL } from './retrace-listed.js';
import { woSoldRoute } from './retrace-wo-parts.js';
import { verifyAsk } from './retrace-verify.js';
import { normalize, labelSnapshot, cleanLabel, hash53, isoAt, poState, mergePo, poSig, poEvents, poMovements, ignoredItem, IGNORED_ITEMS } from './retrace.js';
import { sweepRefresh, vendorNeed } from './retrace-source.js';
import { CLAIM_MIN, COUNT_CAP, CURSOR_RE, LAST_SWEEP, LIMIT, MAX, NEED, NEED_CAP, NEED_MAX, NONE_404, NONE_RETRY_MS, PO_DATA_MAX, PO_NEED_CAP, PRUNE_BUYBACK, QUEUE_ORDER, SHORT_CAP, SO_NEED_CAP, SO_NONE_MAX, SO_NONE_MS, SWEEP_SOURCES, UNNAMED_CAP, WATCH_MAX, chunks, currentItem, healBaseline, insertMv, lc, listedWrite, movementStmts, nInt, nameBook, nameStmts, newOnly, progress, settle, settleAfterHistory, soWo, storeNo, tombs, touchLabel } from './retrace-core.js';

// ------------------------------------------------------------------ store side
// One function per route; the sweep (the collector's pass) is one function per kind of list it carries, further down.
const STORE_ROUTES = {
  'GET /retrace/cursor': cursorRoute, 'GET /retrace/progress': progressRoute, 'POST /retrace/pass': passRoute,
  'POST /retrace/watch': watchRoute, 'POST /retrace/history': historyRoute, 'POST /retrace/sweep': sweepRoute,
};
export async function retraceStore(req, env, url, store, path) {
  const T = env.TR;
  if (path.startsWith('/retrace/wo-sold')) { const r = await woSoldRoute(req, T, store, path); if (r) return r; } // sold WOs' parts (retrace-wo-parts.js)
  const run = STORE_ROUTES[req.method + ' ' + path];
  return run ? run({ req, env, url, T, store }) : fail(404, 'not found');
}

async function cursorRoute({ T, store }) {
  const r = await T.prepare('SELECT sweep, value, updated_at FROM inv_cursors WHERE store = ?').bind(store).all();
  const cursors = {};
  for (const x of r.results) cursors[x.sweep] = { value: parse(x.value), at: x.updated_at };
  const b = await T.prepare('SELECT counted_at, expected_items, expected_pos FROM inv_baseline WHERE store = ?').bind(store).first();
  return json({ cursors, baseline: { frozen: !!(b && b.counted_at && b.expected_items > 0), posKnown: !!(b && b.expected_pos != null) } });
}

async function progressRoute({ url, T, store }) {
  const p = (await progress(T, store)).out, seen = clean(url.searchParams.get('seen'), 40);
  return json({ store, state: p.state, pct: p.pct, done_at: p.done_at, announce: !!p.done_at && p.done_at !== seen }, 200);
}

// The collector's summary of a finished pass (src/usage.js passStmts): the Usage page's Retrace and Portal load. Optional: older collectors never send it.
async function passRoute({ req, T, store }) {
  const stmts = passStmts(T, store, await readJson(req, 2000));
  if (!stmts) return fail(400, 'portalCalls, workerCalls and seconds (whole numbers) required');
  await T.batch(stmts);
  return json({ ok: true });
}

async function watchRoute({ req, T, store }) {
  const over = await spend(T, store, [['rt_watch', 1]]); // per-store request budget (src/budget.js)
  if (over) return fail(429, over);
  const b = await readJson(req, MAX.watch);
  if (!Array.isArray(b.movements) || !b.movements.length || b.movements.length > WATCH_MAX) return fail(400, 'movements required (1 to ' + WATCH_MAX + ')');
  const at = now(), moves = b.movements.map((m) => normalize.watch(m, { sources: ['watch'] })).filter(Boolean);
  const rejected = b.movements.length - moves.length;
  if (!moves.length) return fail(400, 'no valid movement (' + rejected + ' refused)');
  const { stmts, added } = await movementStmts(T, store, moves, at, NEED.touched);
  await chunks(T, stmts);
  return json({ ok: true, added, rejected });
}

async function historyRoute({ req, T, store }) {
  const over = await spend(T, store, [['rt_history', 1]]); // per-store request budget (src/budget.js)
  if (over) return fail(429, over);
  const b = await readJson(req, MAX.history), label = cleanLabel(b.label);
  const all = Array.isArray(b.rows) ? b.rows : b.rows && Array.isArray(b.rows.value) ? b.rows.value : null;
  if (!label || !all || all.length > LIMIT.rows) return fail(400, 'label and rows required');
  // Each row names its store and label (Store "914", InventSerialId): another store's or label's rows are never written here.
  const rows = all.filter((r) => r && typeof r === 'object' && (storeNo(r.Store) == null || storeNo(r.Store) === store) && (r.InventSerialId == null || cleanLabel(r.InventSerialId) === label));
  const skipped = all.length - rows.length;
  // A label whose CURRENT item (the newest history row's ItemId) is an ignored one (Portal's BB0001: a buyback device) isn't stock: dropped with
  // what was stored for it, and remembered (inv_ignored_labels) so no sweep queues it again. A device that later became a stock SKU stays (its
  // BB0001 rows are skipped on insert), and its tombstone, if it had one, goes.
  const current = currentItem(rows);
  if (ignoredItem(current)) {
    const at = now(), r = await T.batch([
      T.prepare('DELETE FROM inv_labels WHERE store = ? AND label = ?').bind(store, label),
      T.prepare('DELETE FROM inv_movements WHERE store = ? AND label = ?').bind(store, label),
      T.prepare(`INSERT INTO inv_ignored_labels (store, label, reason, at) VALUES (?, ?, ?, ?)
          ON CONFLICT (store, label) DO UPDATE SET reason = excluded.reason, at = excluded.at`).bind(store, label, 'item ' + current, at),
    ]);
    return json({ ok: true, added: 0, ignored: true, deletedLabels: (r[0].meta && r[0].meta.changes) || 0, skipped });
  }
  // none: 404 with no rows = Portal answered 404 for this label's history several times in a row (the collector counts them; the status only,
  // never a 404 body). Recorded as read with the NONE_404 marker, so it leaves the queue and stops holding up progress / Verify check 3;
  // the sweep queues it again after NONE_RETRY_MS in case Portal has it by then.
  const none = b.none === 404 && !all.length;
  const at = now(), hash = none ? NONE_404 : hash53(JSON.stringify(rows.map(({ ['@odata.etag']: _e, ...r }) => r)));
  const row = await T.prepare('SELECT history_hash FROM inv_labels WHERE store = ? AND label = ?').bind(store, label).first();
  // Clears the queue only when nothing queued the label after this read's claim began (queued_at newer than claimed_until - CLAIM_MIN: a sweep
  // or a movement named it meanwhile); then it stays queued, unclaimed, for another read. No claim (a read nobody handed out) always clears.
  const done = (latest) => T.prepare(`INSERT INTO inv_labels (store, label, item, serial_status, first_seen, last_seen, last_history_at, history_hash, need_history) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT (store, label) DO UPDATE SET last_history_at = excluded.last_history_at, history_hash = excluded.history_hash, claimed_until = NULL,
        need_history = CASE WHEN claimed_until IS NOT NULL AND queued_at IS NOT NULL AND queued_at > strftime('%Y-%m-%dT%H:%M:%fZ', claimed_until, '-${CLAIM_MIN} minutes') THEN need_history ELSE 0 END,
        item = COALESCE(item, excluded.item), serial_status = COALESCE(serial_status, excluded.serial_status)`)
    .bind(store, label, current || labelSnapshot({ label }).item || null, latest, at, at, at, hash);
  if (row && row.history_hash === hash) { await done(null).run(); await settleAfterHistory(T, store, at); return json({ ok: true, added: 0, same: true, skipped }); }
  const moves = normalize.historyRows(label, rows);
  const fresh = await newOnly(T, store, moves);
  const latest = moves.length ? moves[moves.length - 1].raw_status : null;
  await chunks(T, [...fresh.map((m) => insertMv(T, store, m, at)), done(latest), T.prepare('DELETE FROM inv_ignored_labels WHERE store = ? AND label = ?').bind(store, label)]);
  await settleAfterHistory(T, store, at);
  return json({ ok: true, added: fresh.length, same: false, skipped });
}

// ------------------------------------------------------------------ the sweep
async function sweepRoute({ req, env, T, store }) {
  const over = await spend(T, store, [['rt_sweep', 1]]); // per-store request budget (src/budget.js)
  if (over) return fail(429, over);
  const b = await readJson(req, MAX.sweep);
  for (const k of ['items', 'labels', 'docs', 'movements', 'touched', 'pos', 'names', 'labelTotals', 'listed']) if (b[k] != null && (!Array.isArray(b[k]) || b[k].length > LIMIT[k])) return fail(400, k + ': a list of at most ' + LIMIT[k]);
  if (b.cursors != null && (typeof b.cursors !== 'object' || Array.isArray(b.cursors) || Object.keys(b.cursors).length > LIMIT.cursors)) return fail(400, 'cursors: { sweep: value }');
  const at = now(), by = clean(b.by, 60) || null;
  // What the parts below share: they add to stmts (written in one go, in this order) and to the name book, and count written / skipped.
  const c = { T, env, store, b, at, stmts: [], book: nameBook(), written: 0, skipped: 0 }, { stmts, book } = c;

  const { items, changedItems } = await sweepItems(c);
  const { snaps, touchedIn, dead, diffMoves } = await sweepLabels(c);
  const { diffs, fromSweep, rejected } = await sweepMovements(c, { touchedIn, dead, diffMoves });
  sweepDocs(c);
  // Names the browser read (see "item names"): only `authoritative: true` may rename.
  for (const x of b.names || []) if (x && typeof x === 'object') book.add(x.item, x.name, x.authoritative === true, x.category);
  const poOut = await sweepPos(c);
  const frozen = await sweepBaseline(c);
  const refused = sweepCursors(c);
  if (refused) return refused;
  // An item the lookup named in this sweep keeps the lookup's name (written with its quantities above).
  for (const [item, x] of items) if (x.name) book.map.delete(item);
  const nameW = book.map.size ? await nameStmts(T, store, book, at) : [];
  stmts.push(...nameW);
  const added = diffs.length + fromSweep.added + poOut.received;
  stmts.push(T.prepare('INSERT INTO inv_cursors (store, sweep, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (store, sweep) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .bind(store, LAST_SWEEP, JSON.stringify({ by, items: items.size, labels: snaps.size, movements: added, changedItems: changedItems.length, named: nameW.length }), at));
  await chunks(T, stmts);
  // Full label lists read this pass (listed): what Portal lists for the item now and how many of those Retrace can hold (not tombstoned).
  // Lets progress and Verify take labels Portal stopped listing, or that Retrace drops on purpose (BB0001 buybacks), off the frozen totals.
  // Its own statements, never failing the sweep (before migrations/2026-10-26-retrace-listed.sql the table is missing).
  try { await listedWrite(T, store, b.listed, at); } catch (_) {}
  // Buyback junk from before their number stopped counting as an item (PRUNE_BUYBACK): only labels Portal never said anything about.
  const prunedLabels = ((await T.prepare(PRUNE_BUYBACK).bind(store).run()).meta || {}).changes || 0;
  const prog = await settle(T, store, at);

  const { need, more, unnamed, countNeed, missedItems, shortItems, soNeed, vendorItems } = await sweepNext(c, { prog, frozen, poOut });
  return json({ need, more, changedItems, added, rejected, skipped: c.skipped, written: c.written, prunedLabels, named: nameW.length, unnamed, countNeed, missedItems, shortItems, soNeed, vendorItems, pos: poOut });
}

/*
  Items: inventory-lookup rows folded per item ({ warehouseId: { available, reserved, inTransit, van } }). A row is
  written when it's new or its quantities / name changed; one not seen today only gets last_seen (a single UPDATE for all of them, so
  last_seen stays useful without rewriting every item on every pass).
*/
async function sweepItems(c) {
  const { T, store, b, at, stmts } = c;
  const items = new Map();
  for (const r of b.items || []) {
    const item = clean(r && (r.ItemNumber ?? r.itemNumber ?? r.item) != null ? String(r.ItemNumber ?? r.itemNumber ?? r.item) : '', 40);
    if (!item || ignoredItem(item)) continue;
    const x = items.get(item) || { name: null, category: null, qty: {} };
    x.name = x.name || clean(r.ProductName ?? r.name, 120) || null;
    x.category = x.category || clean(r.RetailCategory ?? r.category, 60) || null;
    const wh = clean(r.WarehouseId != null ? String(r.WarehouseId) : '', 40) || '-';
    const n = (v) => (typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : 0);
    x.qty[wh] = { onHand: n(r.OnHandQuantity), available: n(r.AvailableQuantity), reserved: n(r.ReservedQuantity), inTransit: n(r.InTransitQuantity), salesOnOrder: n(r.SalesOnOrder),
      van: clean(r.VanNickName, 40) || null };
    items.set(item, x);
  }
  const changedItems = [], seenToday = [];
  if (items.size) {
    const known = new Map((await T.prepare('SELECT item, name, category, qty_hash, last_seen FROM inv_items WHERE store = ? AND item IN (SELECT value FROM json_each(?))')
      .bind(store, JSON.stringify([...items.keys()])).all()).results.map((r) => [r.item, r]));
    for (const [item, x] of items) {
      const qty = JSON.stringify(Object.fromEntries(Object.entries(x.qty).sort(([a], [c]) => (a < c ? -1 : 1)))), qh = hash53(qty), k = known.get(item);
      // A row with no quantities was made by a name (see "item names"): the lookup sees the item for the first time.
      const changed = k && k.qty_hash !== qh;
      if (!k || k.qty_hash == null) changedItems.push({ item, why: 'new' }); else if (changed) changedItems.push({ item, why: 'changed' });
      if (k && !changed && k.name === x.name && k.category === x.category) {
        // nothing about it moved: seen today = no write; seen on an earlier day = last_seen only, all of them in one statement below
        if (String(k.last_seen).slice(0, 10) !== at.slice(0, 10)) { c.written++; seenToday.push(item); }
        continue;
      }
      c.written++;
      stmts.push(T.prepare(`INSERT INTO inv_items (store, item, name, category, qty, qty_hash, first_seen, last_seen, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (store, item) DO UPDATE SET name = COALESCE(excluded.name, name), category = COALESCE(excluded.category, category), qty = excluded.qty, qty_hash = excluded.qty_hash,
            last_seen = excluded.last_seen, changed_at = CASE WHEN qty_hash IS NOT excluded.qty_hash THEN excluded.last_seen ELSE changed_at END`)
        .bind(store, item, x.name, x.category, qty, qh, at, at, at));
    }
    // The first sweep of a UTC day: one UPDATE for every unchanged item (a store of 900+ items used to be 900+ upserts, against D1's ~1000 queries per invocation).
    if (seenToday.length) stmts.push(T.prepare('UPDATE inv_items SET last_seen = ? WHERE store = ? AND item IN (SELECT value FROM json_each(?))').bind(at, store, JSON.stringify(seenToday)));
  }
  return { items, changedItems };
}

/*
  Labels: each snapshot against the stored row. New = known from now on and queued for its history (backfill);
  a status / location / consignment change = a movement (normalize.labelDiff) and its history queued first
  (changed). Fields a snapshot doesn't carry keep their stored value. Unchanged and already seen today = no write.
*/
async function sweepLabels(c) {
  const { T, store, b, at, stmts, book } = c;
  const snaps = new Map();
  for (const r of b.labels || []) {
    const s = labelSnapshot(r);
    if (!s || ignoredItem(s.item)) continue;
    const own = storeNo(s.store);
    if (own != null && own !== store) { c.skipped++; continue; } // another store's label: never written here
    snaps.set(s.label, Object.assign(snaps.get(s.label) || {}, s));
    if (s.product) book.add(s.item, s.product, r.list == null);
  }
  // Labels whose history named BB0001 (inv_ignored_labels) are never stored or queued again, whoever names them.
  const touchedIn = [...new Set((b.touched || []).map(cleanLabel).filter(Boolean))];
  const dead = await tombs(T, store, [...snaps.keys(), ...touchedIn]);
  for (const l of dead) snaps.delete(l);
  const diffMoves = [];
  if (snaps.size) {
    const known = new Map((await T.prepare(`SELECT label, item, product, serial_status, consignment, wh_type, wh_id, cost, po, wo, sales_order, arrival, oem_serial, imei, serial_modified, vendor, last_seen, last_history_at
        FROM inv_labels WHERE store = ? AND label IN (SELECT value FROM json_each(?))`).bind(store, JSON.stringify([...snaps.keys()])).all()).results.map((r) => [r.label, r]));
    const COLS = [['item', 'item'], ['product', 'product'], ['serial_status', 'status'], ['consignment', 'consignment'], ['wh_type', 'location'], ['wh_id', 'warehouse'], ['cost', 'cost'],
      ['po', 'po'], ['wo', 'wo'], ['sales_order', 'sales_order'], ['arrival', 'arrival'], ['oem_serial', 'oem_serial'], ['imei', 'imei'], ['serial_modified', 'modified'], ['vendor', 'vendor']];
    for (const [label, s] of snaps) {
      const k = known.get(label);
      const before = k && { label, item: k.item, status: k.serial_status, location: k.wh_type, consignment: k.consignment };
      const moves = k ? normalize.labelDiff(before, s, at) : [];
      diffMoves.push(...moves);
      const differs = !k || COLS.some(([col, f]) => s[f] !== undefined && lc(s[f]) !== lc(k[col]));
      if (!differs && String(k.last_seen).slice(0, 10) === at.slice(0, 10)) continue;
      c.written++;
      // Portal's SerialModified moving on (or newer than the last history read) means its history has news even when
      // nothing this snapshot carries changed.
      const touched = k && s.modified && ((k.serial_modified && s.modified !== k.serial_modified) || (k.last_history_at && s.modified > k.last_history_at));
      const need = !k ? NEED.backfill : moves.length || touched ? NEED.changed : 0;
      if (s.sales_order && s.wo && (!k || k.sales_order !== s.sales_order || k.wo !== s.wo)) stmts.push(soWo(T, store, s.sales_order, s.wo, 'label', at));
      stmts.push(T.prepare(`INSERT INTO inv_labels (store, label, ${COLS.map(([c]) => c).join(', ')}, first_seen, last_seen, last_change_at, need_history, queued_at)
          VALUES (?, ?, ${COLS.map(() => '?').join(', ')}, ?, ?, ?, ?, ?)
          ON CONFLICT (store, label) DO UPDATE SET ${COLS.map(([c]) => c + ' = COALESCE(excluded.' + c + ', ' + c + ')').join(', ')}, last_seen = excluded.last_seen,
            last_change_at = COALESCE(excluded.last_change_at, last_change_at), need_history = MAX(need_history, excluded.need_history),
            queued_at = CASE WHEN excluded.need_history > 0 THEN excluded.queued_at ELSE queued_at END`)
        .bind(store, label, ...COLS.map(([, f]) => (s[f] === undefined ? null : s[f])), at, at, differs && k ? at : null, need, need ? at : null));
    }
  }
  return { snaps, touchedIn, dead, diffMoves };
}

// Movements the browser built (sweeps), checked and re-keyed; their labels are "touched". Plus the snapshot diff's.
async function sweepMovements(c, { touchedIn, dead, diffMoves }) {
  const { T, store, b, at, stmts } = c;
  const sent = (b.movements || []).map((m) => normalize.watch(m, { sources: SWEEP_SOURCES })).filter(Boolean);
  const rejected = (b.movements || []).length - sent.length;
  const diffs = await newOnly(T, store, diffMoves);
  for (const m of diffs) stmts.push(insertMv(T, store, m, at));
  const fromSweep = await movementStmts(T, store, sent.filter((m) => !diffs.some((d) => d.key === m.key)), at, NEED.touched);
  stmts.push(...fromSweep.stmts);
  for (const t of touchedIn) if (!dead.has(t)) stmts.push(touchLabel(T, store, t, labelSnapshot({ label: t }).item || null, NEED.touched, at));
  return { diffs, fromSweep, rejected };
}

// Documents: written only when something about the header changed. POs have their own path below (status history).
function sweepDocs(c) {
  const { T, store, b, at, stmts } = c;
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
}

/*
  Purchase orders: { header, receive } (or a bare list row) → the stored PO (retrace.js poState / mergePo, in inv_docs
  type 'po'), its status history (inv_doc_events: poEvents) and a 'received' movement per label going In Transit →
  Received (poMovements; skipped when serial history already gave that label a received row on this PO). A reading
  with receive details clears need_detail (lines alone don't, nor a null / missing `receive`); a list row that's new, or whose tracked fields moved, sets it.
  Labels on the receive details: known from now on with the PO linked, and queued for a history read when new or
  when their receive status changed. POs sent through `docs` (type 'po') come here as list rows.
*/
async function sweepPos(c) {
  const { T, store, b, at, stmts, book } = c;
  const poIn = [...(b.pos || []), ...(b.docs || []).filter((d) => d && d.type === 'po')];
  const poOut = { seen: 0, written: 0, events: 0, received: 0 };
  if (poIn.length) {
    const readings = new Map();
    for (const x of poIn) {
      // Read in full = the receive details came (a header with lines alone isn't: the labels are on the receive details); a null / missing one keeps need_detail
      const detail = !!(x && x.receive);
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
      const poDead = await tombs(T, store, next.labels && st.labels ? next.labels.filter((l) => !(old.get(l.label) && old.get(l.label).status === l.status)).map((l) => l.label) : []);
      for (const l of next.labels && st.labels ? next.labels : []) {
        const o = old.get(l.label);
        if ((o && o.status === l.status) || ignoredItem(l.item)) continue;
        if (poDead.has(l.label)) continue;
        stmts.push(T.prepare(`INSERT INTO inv_labels (store, label, item, po, oem_serial, imei, first_seen, last_seen, need_history, queued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (store, label) DO UPDATE SET item = COALESCE(item, excluded.item), po = COALESCE(po, excluded.po), oem_serial = COALESCE(oem_serial, excluded.oem_serial),
              imei = COALESCE(imei, excluded.imei), need_history = MAX(need_history, excluded.need_history), queued_at = excluded.queued_at`)
          .bind(store, l.label, l.item || null, id, l.oem || null, l.imei || null, at, at, NEED.touched, at));
      }
      const data = JSON.stringify(next);
      if (k && k.data === data && need === k.need_detail) continue; // nothing new (a list row repeating the stored values)
      if (data.length > PO_DATA_MAX) continue;
      poOut.written++; c.written++;
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
  return poOut;
}

/*
  The baseline's inputs: label counts per item (only while counting: a frozen baseline never changes) and the PO total
  (taken once, before the freeze). settle() below decides when counting is finished.
*/
async function sweepBaseline(c) {
  const { T, store, b, at, stmts } = c;
  await healBaseline(T, store);
  const base = await T.prepare('SELECT counted_at, expected_pos FROM inv_baseline WHERE store = ?').bind(store).first(), frozen = !!(base && base.counted_at);
  if (!frozen) {
    for (const x of b.labelTotals || []) {
      const item = clean(x && x.item != null ? String(x.item) : '', 40), total = nInt(x && x.total);
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
  return frozen;
}

// The collector's cursors. A bad one refuses the whole sweep (nothing has been written yet): the answer to give, else null.
function sweepCursors(c) {
  const { T, store, b, at, stmts } = c;
  for (const [name, value] of Object.entries(b.cursors || {})) {
    const v = JSON.stringify(value === undefined ? null : value);
    if (!CURSOR_RE.test(name) || name === LAST_SWEEP || v.length > 4000) return fail(400, 'bad cursor ' + String(name).slice(0, 40));
    if (name === 'lookup' && value && value.rows === 0) continue; // an empty lookup is a failed one: not recorded
    stmts.push(T.prepare('INSERT INTO inv_cursors (store, sweep, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (store, sweep) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').bind(store, name, v, at));
  }
  return null;
}

// What the browser should read next: each list is claimed or picked here, after everything above is written.
async function sweepNext(c, { prog, frozen, poOut }) {
  const { T, env, store, b, at } = c;
  // The history queue: changed > touched > backfill, most recently seen first; claimed in the same statement that picks them (RETURNING), so two
  // browsers sweeping at once never get the same label. The claim runs CLAIM_MIN minutes from this request's `at`, which is when the claim began
  // (POST /history compares queued_at with it). RETURNING has no order: put them back in QUEUE_ORDER here.
  const want = Math.min(Math.max(Number.isInteger(b.need) ? b.need : NEED_MAX, 0), NEED_CAP);
  // labels Portal had no history for (NONE_404) come back, as backfill, once a week
  if (want) await T.prepare(`UPDATE inv_labels SET need_history = ${NEED.backfill}, queued_at = ?1 WHERE store = ?2 AND history_hash = '${NONE_404}' AND need_history = 0 AND last_history_at < ?3`)
    .bind(at, store, new Date(Date.parse(at) - NONE_RETRY_MS).toISOString()).run();
  const need = want ? (await T.prepare(`UPDATE inv_labels SET claimed_until = ?1 WHERE store = ?2 AND (claimed_until IS NULL OR claimed_until < ?3) AND label IN
      (SELECT label FROM inv_labels WHERE store = ?2 AND need_history > 0 AND (claimed_until IS NULL OR claimed_until < ?3) ORDER BY ${QUEUE_ORDER} LIMIT ?4) RETURNING label, need_history, last_seen`)
    .bind(new Date(Date.parse(at) + CLAIM_MIN * 60000).toISOString(), store, at, want).all()).results
    .sort((x, y) => y.need_history - x.need_history || (x.last_seen < y.last_seen ? 1 : x.last_seen > y.last_seen ? -1 : 0) || (x.label < y.label ? -1 : x.label > y.label ? 1 : 0)).map((r) => r.label) : [];
  const more = want ? !!(await T.prepare('SELECT 1 AS n FROM inv_labels WHERE store = ? AND need_history > 0 AND (claimed_until IS NULL OR claimed_until < ?) LIMIT 1').bind(store, at).first()) : false;
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
  // Baseline items whose stored labels fall short of Portal's count (the item's label list was never read, or its read was lost with the
  // browser's queue): the browser reads them (shortNeed: how many, default none; biggest gap first). The browser remembers which it tried.
  const shortWant = Math.min(Math.max(Number.isInteger(b.shortNeed) ? b.shortNeed : 0, 0), SHORT_CAP);
  // short = below what the item can still reach (TARGET_LISTED: a full listing since the freeze that can't reach Portal's count ends it)
  const shortSql = (tgt, join) => `SELECT c.item FROM inv_item_counts c LEFT JOIN (SELECT item, COUNT(*) AS n FROM inv_labels WHERE store = ?1 GROUP BY item) l ON l.item = c.item ${join}
      WHERE c.store = ?1 AND ${tgt} > COALESCE(l.n, 0) AND lower(c.item) NOT IN (SELECT value FROM json_each(?2)) ORDER BY ${tgt} - COALESCE(l.n, 0) DESC, c.item LIMIT ?3`;
  const shortRead = (tgt, join) => T.prepare(shortSql(tgt, join)).bind(store, JSON.stringify(IGNORED_ITEMS), shortWant).all();
  const shortItems = shortWant && frozen ? (await shortRead(TARGET_LISTED, LISTED_JOIN_SQL).catch((e) => {
    if (!/inv_item_listed/.test(String(e && e.message))) throw e;
    return shortRead('c.labels', ''); // before the migration
  })).results.map((r) => r.item) : [];
  // Sales orders with no WO link (inv_so_wo), newest first: the browser reads label details of the one label given (a label whose NEWEST sales
  // order this is: details name only the label's current one). Claimed CLAIM_MIN minutes; a real read with no WorkOrderId (soNone) rests a day.
  // Never fails the sweep (before the migration the table is missing).
  const soWant = Math.min(Math.max(Number.isInteger(b.soNeed) ? b.soNeed : 0, 0), SO_NEED_CAP);
  let soNeed = [];
  try { await soLink(T, store, at); } catch (_) {} // first: the tracker already knows most of the links, soNeed lists what is left
  try { soNeed = await soNeedList(T, store, at, soWant, Array.isArray(b.soNone) ? b.soNone : []); } catch (_) {}
  // Item sources (retrace-source.js): the rules again at most every 10 minutes (and the store's pause, with its one push), and the
  // in-scope items whose labels carry no vendor yet (vendorNeed: how many, default none), for the browser to read their label lists.
  const vendorWant = Math.min(Math.max(Number.isInteger(b.vendorNeed) ? b.vendorNeed : 0, 0), 300);
  await sweepRefresh(T, env, store, at);
  let vendorItems = [];
  try { vendorItems = await vendorNeed(T, store, vendorWant); } catch (_) {}
  return { need, more, unnamed, countNeed, missedItems, shortItems, soNeed, vendorItems };
}

/*
  Sales order → work order links the tracker already has, without asking Portal (Oct 25, 2026): `sales` (sale_id = the FSO, wo) and the plain part of
  workorders (plain.workorder.csuSalesOrderId, plain.cart.salesId → the row's wo; the sealed card and snapshots are never touched). INSERT OR IGNORE
  into inv_so_wo, so a link a label-details read or a WO upload wrote stays as it is (sales first, then csuSalesOrderId, then salesId). Then labels
  with no wo (and/or sales order) take them from their NEWEST sales-order movement, when that sales order is linked. At most once a day per store
  (inv_cursors 'so_link'; `force` for tests / a manual run). → { linked, labels } | null when it isn't due.
*/
export async function soLink(T, store, at, force = false) {
  const cur = await T.prepare("SELECT updated_at FROM inv_cursors WHERE store = ? AND sweep = 'so_link'").bind(store).first();
  if (!force && cur && Date.parse(cur.updated_at) > Date.parse(at) - 24 * 3600000) return null;
  const [ins] = await T.batch([T.prepare(`INSERT OR IGNORE INTO inv_so_wo (store, sales_order, wo, source, updated_at)
      SELECT ?1, so, wo, 'tracker', ?2 FROM (
        SELECT sale_id AS so, CAST(wo AS TEXT) AS wo, 1 AS pri FROM sales WHERE store = ?1 AND wo IS NOT NULL
        UNION ALL SELECT json_extract(plain, '$.workorder.csuSalesOrderId'), CAST(wo AS TEXT), 2 FROM workorders WHERE store = ?1 AND plain IS NOT NULL AND json_valid(plain)
        UNION ALL SELECT json_extract(plain, '$.cart.salesId'), CAST(wo AS TEXT), 3 FROM workorders WHERE store = ?1 AND plain IS NOT NULL AND json_valid(plain))
      WHERE typeof(so) = 'text' AND so <> '' ORDER BY pri`).bind(store, at)]);
  const newest = "(SELECT m.ref_id FROM inv_movements m WHERE m.store = inv_labels.store AND m.label = inv_labels.label AND m.ref_type = 'sales_order' AND m.ref_id IS NOT NULL ORDER BY m.at DESC, m.id DESC LIMIT 1)";
  const upd = await T.prepare(`UPDATE inv_labels SET
        wo = COALESCE(wo, (SELECT w.wo FROM inv_so_wo w WHERE w.store = inv_labels.store AND w.sales_order = ${newest})),
        sales_order = COALESCE(sales_order, ${newest})
      WHERE store = ?1 AND (wo IS NULL OR sales_order IS NULL)
        AND EXISTS (SELECT 1 FROM inv_so_wo w WHERE w.store = inv_labels.store AND w.sales_order = ${newest})`).bind(store).run();
  const out = { linked: (ins.meta && ins.meta.changes) || 0, labels: (upd.meta && upd.meta.changes) || 0 };
  await T.prepare("INSERT INTO inv_cursors (store, sweep, value, updated_at) VALUES (?, 'so_link', ?, ?) ON CONFLICT (store, sweep) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(store, JSON.stringify(out), at).run();
  return out;
}

// Sales orders the movements name that have no inv_so_wo row: [{ sales_order, label }], newest first (soNone: sales orders the browser just read
// for real with no WorkOrderId, recorded first so they aren't handed out again for SO_NONE_MS).
async function soNeedList(T, store, at, want, none) {
  const nones = [...new Set(none.map((v) => (v == null || typeof v === 'object' ? '' : String(v).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40))).filter(Boolean))].slice(0, SO_NONE_MAX);
  if (nones.length) await T.batch(nones.map((so) => T.prepare(`INSERT INTO inv_so_need (store, sales_order, none_at) VALUES (?, ?, ?)
      ON CONFLICT (store, sales_order) DO UPDATE SET none_at = excluded.none_at, claimed_until = NULL`).bind(store, so, at)));
  if (!want) return [];
  const rows = (await T.prepare(`SELECT ref_id AS sales_order, MIN(label) AS label, MAX(at) AS at FROM (
        SELECT label, ref_id, MAX(at) AS at FROM inv_movements WHERE store = ?1 AND ref_type = 'sales_order' AND label IS NOT NULL AND ref_id IS NOT NULL GROUP BY label) last
      WHERE NOT EXISTS (SELECT 1 FROM inv_so_wo w WHERE w.store = ?1 AND w.sales_order = last.ref_id)
        AND NOT EXISTS (SELECT 1 FROM inv_so_need n WHERE n.store = ?1 AND n.sales_order = last.ref_id AND (n.claimed_until > ?2 OR n.none_at > ?3))
      GROUP BY ref_id ORDER BY at DESC, ref_id LIMIT ?4`).bind(store, at, new Date(Date.parse(at) - SO_NONE_MS).toISOString(), want).all()).results;
  if (rows.length) {
    const until = new Date(Date.parse(at) + CLAIM_MIN * 60000).toISOString();
    await T.batch(rows.map((r) => T.prepare(`INSERT INTO inv_so_need (store, sales_order, claimed_until) VALUES (?, ?, ?)
        ON CONFLICT (store, sales_order) DO UPDATE SET claimed_until = excluded.claimed_until`).bind(store, r.sales_order, until)));
  }
  return rows.map((r) => ({ sales_order: r.sales_order, label: r.label }));
}
