/*
  Retrace on the tracker Worker (Oct 23, 2026): the inventory movement ledger's routes. Tables inv_labels,
  inv_movements, inv_items, inv_docs, inv_cursors (migrations/2026-10-23-retrace.sql); what a movement is and how
  each source becomes one: src/retrace.js (shared with Aethernet, pure). Movements are kept forever (small rows).

  Store side (x-aethernet-key + the store's Aethernet access, same as /scan; mounted by storeApi at /v1/:store/tracker/retrace/…).
  Everything is written under the store in the URL and nothing else: a label snapshot naming another store is skipped.
    POST /retrace/sweep { items, labels, docs, movements, touched, cursors, need, by }   one collector pass →
         { need: [label], more, changedItems: [{ item, why: new|changed }], added, rejected, skipped, written }
           items      inventory-lookup rows ({ ItemNumber, ProductName, RetailCategory, WarehouseId, OnHandQuantity,
                      AvailableQuantity, ReservedQuantity, InTransitQuantity, SalesOnOrder, VanNickName }): per item and
                      warehouse; quantities differing from the stored ones (or a new item) come back in changedItems so
                      the browser reads that item's labels. Which items to look up is the collector's call (the lookup
                      returns Portal's whole catalog, 100 a page): the server only diffs what it's sent.
           labels     label snapshots (labelSnapshot: label details or store-products rows): diffed against the stored
                      one; a status / location / consignment change is a movement and queues the label's history.
           docs       document headers (normalize.doc shape or Portal's row + type) → inv_docs
           movements  movements the browser built with retrace.js (sweeps of transfers, counts, RMA, buyback, POs),
                      checked like the watcher's (normalize.watch), keys rebuilt here
           touched    labels a sweep saw on a document: queued for a history read
           cursors    { sweepName: value } where each sweep got to (JSON, 4000 chars max each) → GET /retrace/cursor
           need       how many labels to hand out for history reads (default NEED_MAX 60, at most NEED_CAP)
         need: labels whose serial history should be (re)read, changed > touched > backfill, claimed CLAIM_MIN minutes
         so a second browser skips them (the /scan pattern).
    POST /retrace/history { label, rows, by }   the label's serial-history rows (boh/serial-history/{label}: the rows,
         or Portal's { value: [rows] } as is) → { ok, added, same, skipped } · rows normalized here (normalize.historyRows),
         duplicates ignored, rows naming another store or label skipped, the label leaves the queue.
    POST /retrace/watch { movements, by }   up to WATCH_MAX movements the in-page watcher saw Portal write → { ok, added, rejected }
    GET  /retrace/cursor                   → { cursors: { sweepName: { value, at } } }
  WO hook: woRetraceStmts() below, called by POST /v1/:store/tracker/wo/:wo into the same batch as status / RFP periods.

  Admin side: retraceAdmin() below, mounted by trackerRoutes at /api/tracker/retrace/… (page 'retrace'; route list there).
*/
import { normalize, labelSnapshot, cleanLabel, KINDS, woMovements, hash53, isoAt } from './retrace.js';

export const NEED_MAX = 60;
const NEED_CAP = 200, CLAIM_MIN = 10, WATCH_MAX = 50;
// Per-request caps. Most rows become a statement and D1 counts queries per Worker invocation (1000 on paid plans,
// batched or not), so a pass bigger than this goes up in several sweeps (only new / changed rows are written, so a
// second pass over the same data is mostly reads).
const LIMIT = { items: 2400, labels: 800, docs: 200, movements: 500, touched: 500, rows: 500, cursors: 20 };
const MAX = { sweep: 4000000, history: 1000000, watch: 150000 };
const SWEEP_SOURCES = ['sweep', 'transfer', 'count', 'rma', 'buyback', 'po', 'snapshot'];
const CURSOR_RE = /^[a-z][a-z0-9_-]{0,30}$/, LAST_SWEEP = 'last_sweep';
const NEED = { backfill: 1, touched: 2, changed: 3 };

const later = (min) => new Date(Date.now() + min * 60000).toISOString();
const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch (_) { return null; } };
const chunks = async (T, stmts) => { const out = []; for (let i = 0; i < stmts.length; i += 100) out.push(...(await T.batch(stmts.slice(i, i + 100)))); return out; };
const lc = (v) => (v == null ? null : String(v).toLowerCase());
// Leading store number in Portal's Store text ("914", "914 - Newport News"); null when it has none.
const storeNo = (v) => { const m = /^\s*(\d{1,6})\b/.exec(v == null ? '' : String(v)); return m ? Number(m[1]) : null; };

// ------------------------------------------------------------------ shared writes
const insertMv = (T, store, m, at) => T.prepare(`INSERT OR IGNORE INTO inv_movements (store, label, item, at, kind, raw_status, raw_event, ref_type, ref_id, ref_line, from_wh, to_wh, user_name, source, detail, key, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .bind(store, m.label, m.item, m.at, m.kind, m.raw_status, m.raw_event, m.ref_type, m.ref_id, m.ref_line, m.from_wh, m.to_wh, m.user, m.source, m.detail, m.key, at);
const soWo = (T, store, so, wo, source, at) => T.prepare(`INSERT INTO inv_so_wo (store, sales_order, wo, source, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (store, sales_order) DO UPDATE SET wo = excluded.wo, source = excluded.source, updated_at = excluded.updated_at WHERE wo IS NOT excluded.wo`).bind(store, so, String(wo), source, at);
// A label a movement names: known from now on, and queued for a history read at `need` (never lowered here).
const touchLabel = (T, store, label, item, need, at, wo = null) => T.prepare(`INSERT INTO inv_labels (store, label, item, wo, first_seen, last_seen, need_history) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (store, label) DO UPDATE SET item = COALESCE(item, excluded.item), wo = COALESCE(excluded.wo, wo), need_history = MAX(need_history, excluded.need_history)`)
  .bind(store, label, item, wo, at, at, need);

/*
  Only movements not already stored (one read, by key): the same record coming back (a re-sent cart, a history read
  twice, the WO's events on every upload) writes nothing and doesn't queue its label again. Duplicates within the
  batch go too. INSERT OR IGNORE stays the guard against two browsers racing.
*/
async function newOnly(T, store, moves) {
  const seen = new Set(), list = moves.filter((m) => m && !seen.has(m.key) && seen.add(m.key));
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
  return { stmts, added: fresh.length };
}

// ------------------------------------------------------------------ WO hook
/*
  POST /wo/:wo: the cart lines' labels and the WO's parts events, before and after (src/retrace.js woMovements:
  reserved / unreserved / used, swapped_out + swapped_in), as statements for the WO upload's own batch. The labels
  get the WO linked and a history read queued. Never fails the upload: any error here gives no statements.
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
    return H.json({ cursors });
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
    const at = H.now(), hash = hash53(JSON.stringify(rows.map(({ ['@odata.etag']: _e, ...r }) => r)));
    const row = await T.prepare('SELECT history_hash FROM inv_labels WHERE store = ? AND label = ?').bind(store, label).first();
    const done = (latest) => T.prepare(`INSERT INTO inv_labels (store, label, item, serial_status, first_seen, last_seen, last_history_at, history_hash, need_history) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT (store, label) DO UPDATE SET last_history_at = excluded.last_history_at, history_hash = excluded.history_hash, need_history = 0, claimed_until = NULL,
          item = COALESCE(item, excluded.item), serial_status = COALESCE(serial_status, excluded.serial_status)`)
      .bind(store, label, labelSnapshot({ label }).item || null, latest, at, at, at, hash);
    if (row && row.history_hash === hash) { await done(null).run(); return H.json({ ok: true, added: 0, same: true, skipped }); }
    const moves = normalize.historyRows(label, rows);
    const fresh = await newOnly(T, store, moves);
    const latest = moves.length ? moves[moves.length - 1].raw_status : null;
    await chunks(T, [...fresh.map((m) => insertMv(T, store, m, at)), done(latest)]);
    return H.json({ ok: true, added: fresh.length, same: false, skipped });
  }

  if (path === '/retrace/sweep' && req.method === 'POST') {
    const b = await H.readJson(req, MAX.sweep);
    for (const k of ['items', 'labels', 'docs', 'movements', 'touched']) if (b[k] != null && (!Array.isArray(b[k]) || b[k].length > LIMIT[k])) return H.fail(400, k + ': a list of at most ' + LIMIT[k]);
    if (b.cursors != null && (typeof b.cursors !== 'object' || Array.isArray(b.cursors) || Object.keys(b.cursors).length > LIMIT.cursors)) return H.fail(400, 'cursors: { sweep: value }');
    const at = H.now(), by = H.clean(b.by, 60) || null, stmts = [];
    let written = 0, skipped = 0;

    /*
      Items: inventory-lookup rows folded per item ({ warehouseId: { available, reserved, inTransit, van } }). A row is
      written when it's new, its quantities or name changed, or it wasn't seen today (last_seen stays useful without
      rewriting every item on every pass).
    */
    const items = new Map();
    for (const r of b.items || []) {
      const item = H.clean(r && (r.ItemNumber ?? r.itemNumber ?? r.item) != null ? String(r.ItemNumber ?? r.itemNumber ?? r.item) : '', 40);
      if (!item) continue;
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
        const changed = k && k.qty_hash !== qh;
        if (!k) changedItems.push({ item, why: 'new' }); else if (changed) changedItems.push({ item, why: 'changed' });
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
      if (!s) continue;
      const own = storeNo(s.store);
      if (own != null && own !== store) { skipped++; continue; } // another store's label: never written here
      snaps.set(s.label, Object.assign(snaps.get(s.label) || {}, s));
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

    // Documents: written only when something about the header changed.
    for (const d of b.docs || []) {
      const doc = normalize.doc(d && d.type, d);
      if (!doc) continue;
      const data = JSON.stringify(doc.data || {});
      if (data.length > 4000) continue;
      stmts.push(T.prepare(`INSERT INTO inv_docs (store, type, id, status, at, counterpart, data, first_seen, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (store, type, id) DO UPDATE SET status = excluded.status, at = COALESCE(excluded.at, at), counterpart = COALESCE(excluded.counterpart, counterpart), data = excluded.data, updated_at = excluded.updated_at
          WHERE status IS NOT excluded.status OR data IS NOT excluded.data OR (excluded.at IS NOT NULL AND at IS NOT excluded.at) OR (excluded.counterpart IS NOT NULL AND counterpart IS NOT excluded.counterpart)`)
        .bind(store, doc.type, doc.id, doc.status, doc.at, doc.counterpart, data, at, at));
    }
    for (const [name, value] of Object.entries(b.cursors || {})) {
      const v = JSON.stringify(value === undefined ? null : value);
      if (!CURSOR_RE.test(name) || name === LAST_SWEEP || v.length > 4000) return H.fail(400, 'bad cursor ' + String(name).slice(0, 40));
      stmts.push(T.prepare('INSERT INTO inv_cursors (store, sweep, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (store, sweep) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').bind(store, name, v, at));
    }
    const added = diffs.length + fromSweep.added;
    stmts.push(T.prepare('INSERT INTO inv_cursors (store, sweep, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (store, sweep) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .bind(store, LAST_SWEEP, JSON.stringify({ by, items: items.size, labels: snaps.size, movements: added, changedItems: changedItems.length }), at));
    await chunks(T, stmts);

    // The history queue: changed > touched > backfill, most recently seen first; claimed so other browsers skip them.
    const want = Math.min(Math.max(Number.isInteger(b.need) ? b.need : NEED_MAX, 0), NEED_CAP);
    const q = want ? (await T.prepare('SELECT label FROM inv_labels WHERE store = ? AND need_history > 0 AND (claimed_until IS NULL OR claimed_until < ?) ORDER BY need_history DESC, last_seen DESC LIMIT ?')
      .bind(store, at, want + 1).all()).results.map((r) => r.label) : [];
    const need = q.slice(0, want);
    if (need.length) await T.prepare('UPDATE inv_labels SET claimed_until = ? WHERE store = ? AND label IN (SELECT value FROM json_each(?))').bind(later(CLAIM_MIN), store, JSON.stringify(need)).run();
    return H.json({ need, more: q.length > need.length, changedItems, added, rejected, skipped, written });
  }
  return H.fail(404, 'not found');
}

// ------------------------------------------------------------------ admin side
/*
  Behind the access gate (page 'retrace'; the store in the path, or ?store=, must be one of the person's stores).
  Paths below are under /api/tracker. Movements come back as stored, user_name as `user`.

  GET /retrace/item/:store/:item?from&to&kinds&limit&offset   → { store, item, info: { name, category, qty, last_seen,
        changed_at } | null, counts: [{ serial_status, wh_type, consignment, n }], labels: [{ label, serial_status, wh_type,
        consignment, wo, po, last_seen, last_history_at, need_history }], movements: [...], total }
        from / to: YYYY-MM-DD (UTC days) or ISO; kinds: comma list of KINDS; newest first; limit ≤ 1000 (200).
  GET /retrace/label/:store/:label   → { label: inv_labels row | null, movements: [...] } oldest first · 404 when neither
  GET /retrace/search?store=&q=      → { labels: [...], items: [...], refs: [{ store, ref_type, ref_id, n, first_at, last_at }],
        docs: [...] } · q (2+ chars): a label (or its start), OEM serial / IMEI, an item number or name, a PO / WO /
        transfer / RMA / buyback / count id. Without store: every store the person can see.
  GET /retrace/coverage              → { stores: [{ store, labels, histories, backlog, claimed, items, movements,
        last_history_at, last_sweep_at, last_sweep }] } for the stores the person can see.
*/
// Movements with the WO behind a sales order (inv_so_wo) as `wo`: serial history leaves the WO number blank.
const MV_COLS = `m.id, m.store, m.label, m.item, m.at, m.kind, m.raw_status, m.raw_event, m.ref_type, m.ref_id, m.ref_line, m.from_wh, m.to_wh, m.user_name AS user, m.source, m.detail, m.recorded_at,
  CASE WHEN m.ref_type = 'wo' THEN m.ref_id ELSE sw.wo END AS wo`;
const MV_FROM = "inv_movements m LEFT JOIN inv_so_wo sw ON m.ref_type = 'sales_order' AND sw.store = m.store AND sw.sales_order = m.ref_id";
const dayFrom = (v) => (/^\d{4}-\d\d-\d\d$/.test(v || '') ? v + 'T00:00:00.000Z' : isoAt(v));
const dayTo = (v) => (/^\d{4}-\d\d-\d\d$/.test(v || '') ? v + 'T23:59:59.999Z' : isoAt(v));
const likeEsc = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

export async function retraceAdmin(req, env, url, path, me, email, H) {
  const T = env.TR, q = url.searchParams;
  if (req.method !== 'GET') return H.fail(404, 'not found', false);
  const canSee = (st) => !!me && me.canSee(st);

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
    if (q.get('kinds')) {
      const kinds = q.get('kinds').split(',').map((k) => k.trim()).filter(Boolean);
      if (!kinds.length || kinds.some((k) => !KINDS.includes(k))) return H.fail(400, 'kinds: ' + KINDS.join(', '), false);
      where.push('m.kind IN (SELECT value FROM json_each(?))'); args.push(JSON.stringify(kinds));
    }
    const limit = Math.min(H.int(q.get('limit')) || 200, 1000), offset = H.int(q.get('offset')) || 0;
    const [info, counts, labels, moves, total] = await T.batch([
      T.prepare('SELECT name, category, qty, last_seen, changed_at FROM inv_items WHERE store = ? AND item = ?').bind(store, item),
      T.prepare('SELECT serial_status, wh_type, consignment, COUNT(*) AS n FROM inv_labels WHERE store = ? AND item = ? GROUP BY serial_status, wh_type, consignment ORDER BY n DESC').bind(store, item),
      T.prepare('SELECT label, serial_status, wh_type, consignment, wo, po, last_seen, last_history_at, need_history FROM inv_labels WHERE store = ? AND item = ? ORDER BY last_seen DESC LIMIT 1000').bind(store, item),
      T.prepare(`SELECT ${MV_COLS} FROM ${MV_FROM} WHERE ${where.join(' AND ')} ORDER BY m.at DESC, m.id DESC LIMIT ? OFFSET ?`).bind(...args, limit, offset),
      T.prepare(`SELECT COUNT(*) AS n FROM inv_movements m WHERE ${where.join(' AND ')}`).bind(...args),
    ]);
    const i = info.results[0] || null;
    await H.log(env, email, 'retrace:item', store, null, item);
    return H.json({ store, item, info: i && Object.assign(i, { qty: parse(i.qty) }), counts: counts.results, labels: labels.results, movements: moves.results, total: total.results[0].n }, 200, false);
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

  if (path === '/retrace/coverage') {
    const s = scope();
    if (!s) return H.fail(403, 'not your store', false);
    const at = new Date().toISOString();
    const [labels, items, moves, sweeps] = await T.batch([
      T.prepare(`SELECT store, COUNT(*) AS labels, SUM(CASE WHEN last_history_at IS NOT NULL THEN 1 ELSE 0 END) AS histories, SUM(CASE WHEN need_history > 0 THEN 1 ELSE 0 END) AS backlog,
          SUM(CASE WHEN claimed_until > ? THEN 1 ELSE 0 END) AS claimed, MAX(last_history_at) AS last_history_at FROM inv_labels WHERE ${s.sql} GROUP BY store`).bind(at, ...s.args),
      T.prepare(`SELECT store, COUNT(*) AS items FROM inv_items WHERE ${s.sql} GROUP BY store`).bind(...s.args),
      T.prepare(`SELECT store, COUNT(*) AS movements FROM inv_movements WHERE ${s.sql} GROUP BY store`).bind(...s.args),
      T.prepare(`SELECT store, value, updated_at FROM inv_cursors WHERE ${s.sql} AND sweep = ?`).bind(...s.args, LAST_SWEEP),
    ]);
    const by = new Map();
    const row = (st) => by.get(st) || by.set(st, { store: st, labels: 0, histories: 0, backlog: 0, claimed: 0, items: 0, movements: 0, last_history_at: null, last_sweep_at: null, last_sweep: null }).get(st);
    for (const r of labels.results) Object.assign(row(r.store), r);
    for (const r of items.results) row(r.store).items = r.items;
    for (const r of moves.results) row(r.store).movements = r.movements;
    for (const r of sweeps.results) Object.assign(row(r.store), { last_sweep_at: r.updated_at, last_sweep: parse(r.value) });
    return H.json({ stores: [...by.values()].filter((x) => canSee(x.store)).sort((a, b) => a.store - b.store) }, 200, false);
  }
  return H.fail(404, 'not found', false);
}
