/*
  Linkpearl: Retrace (inventory) lookup, under /v1/agents/m/retrace… (phone API; dispatch in mobile-agent.js, reference in MOBILE-API-retrace.md).
  Read only, plain data only, one store per request. Mirrors the admin site's retraceAdmin (retrace-api.js) minus everything that names a person.

    GET /v1/agents/m/retrace/items?store=<id>&q=&after=&limit=       items, most recent movement first; q = item number (start) or name (part)
    GET /v1/agents/m/retrace/item/<store>/<item>[?group=in|wo|out|q|bad]   one item: info, counts by "now" group, labels, recent movements
    GET /v1/agents/m/retrace/label/<store>/<label>                   one label: row and movement timeline
    GET /v1/agents/m/retrace/pos?store=<id>&after=&limit=            purchase orders, newest first

  Access: store must be one of device.stores (403 "not your store"; a missing or malformed store is 400). Plain reads are not logged (no sealed data here).
  Never in a response: inv_movements.user_name, inv_labels.imei / oem_serial (neither column is ever selected), inv_verify_ticks.checked_by, movement detail /
  raw text, PO lines and PO label lists (a PO's own fields only). Where a label stands now comes from retrace-now.js, the same function the admin site uses.
  Indexes used: inv_mv_item (store, item, at), inv_mv_label (store, label, at), inv_labels PK (store, label) and inv_labels_item (store, item), inv_items PK,
  inv_docs PK (store, type, id), inv_cursors PK. No migration needed.
*/
import { cleanLabel, parseLabel } from './retrace.js';
import { nowCols, rowNow, nowCountsRows, nowCountsStmt, availRes } from './retrace-now.js';

const DEFAULT_LIMIT = 25, MAX_LIMIT = 100;
const ITEM_LABELS = 100, ITEM_LABELS_READ = 1000, ITEM_MOVES = 50, LABEL_MOVES = 300, LABEL_HITS = 10;

const err = (status, message) => Object.assign(new Error(message), { status });
const b64 = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => { try { return JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4))); } catch (_) { return null; } };
const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch (_) { return null; } };
const unesc = (v) => { try { return decodeURIComponent(v); } catch (_) { return null; } };
const likeEsc = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const GROUPS = ['in', 'wo', 'out', 'q', 'bad'];

// The one store this request is about. Throws 400 / 403.
function storeOf(device, v) {
  if (v == null || !/^\d{1,6}$/.test(v)) throw err(400, 'store: a store number');
  if (!device.stores.map(Number).includes(Number(v))) throw err(403, 'not your store');
  return Number(v);
}
const limitOf = (h, v) => Math.min(Math.max(h.int(v) || DEFAULT_LIMIT, 1), MAX_LIMIT);
const movement = (m) => ({ at: m.at, kind: m.kind, refType: m.ref_type || null, refId: m.ref_id || null, label: m.label || null });

// Quantities of an inv_items row as the admin items list reads them: onHand = sum over warehouses, available = non-quarantine warehouses; null without a lookup.
function qtyOf(qtyText, labelAvail) {
  const qty = parse(qtyText), whs = qty && typeof qty === 'object' ? Object.entries(qty).filter(([, w]) => w && typeof w === 'object') : [];
  const onHand = qty && typeof qty === 'object' ? Object.values(qty).reduce((n, w) => n + (w && typeof w.onHand === 'number' ? w.onHand : 0), 0) : null;
  const available = whs.length ? whs.filter(([id]) => !/q$/i.test(id)).reduce((n, [, w]) => n + (typeof w.available === 'number' ? w.available : 0), 0) : labelAvail;
  return { onHand, available };
}

// ---------------------------------------------------------------- GET /retrace/items
async function items(env, url, device, h) {
  const q = url.searchParams, T = env.TR, store = storeOf(device, q.get('store')), limit = limitOf(h, q.get('limit'));
  const term = clean(q.get('q'), 60);
  const out = { v: 1, now: h.now(), store, q: term || null, asOf: null, items: [], next: null };
  let cur = null;
  if (q.get('after')) {
    cur = unb64(q.get('after'));
    if (!cur || typeof cur.at !== 'string' || cur.at.length > 40 || typeof cur.item !== 'string' || cur.item.length > 40 || (cur.t || '') !== term) throw err(400, 'after: not a cursor from this list');
  }
  const args = [store], cond = [];
  if (term) { // item number starts with q, or the name contains it (names from inv_items; an item with no name row is found by number via its labels)
    args.push(likeEsc(term) + '%', '%' + likeEsc(term) + '%');
    cond.push(`m.item IN (SELECT item FROM inv_items WHERE store = ?1 AND (item LIKE ?2 ESCAPE '\\' OR name LIKE ?3 ESCAPE '\\')
      UNION SELECT item FROM inv_labels WHERE store = ?1 AND item LIKE ?2 ESCAPE '\\')`);
  }
  const having = [];
  if (cur) { args.push(cur.at, cur.item); having.push(`(MAX(m.at) < ?${args.length - 1} OR (MAX(m.at) = ?${args.length - 1} AND m.item > ?${args.length}))`); }
  args.push(limit + 1);
  const [rows, sweep] = await T.batch([
    T.prepare(`SELECT m.item, m.last_at, i.name, i.category, i.qty, (SELECT COUNT(*) FROM inv_labels l WHERE l.store = ?1 AND l.item = m.item) AS label_n,
        (SELECT l.product FROM inv_labels l WHERE l.store = ?1 AND l.item = m.item AND l.product IS NOT NULL LIMIT 1) AS product
      FROM (SELECT m.item AS item, MAX(m.at) AS last_at FROM inv_movements m WHERE m.store = ?1 AND m.item IS NOT NULL ${cond.length ? 'AND ' + cond.join(' AND ') : ''}
            GROUP BY m.item ${having.length ? 'HAVING ' + having.join(' AND ') : ''}) m
      LEFT JOIN inv_items i ON i.store = ?1 AND i.item = m.item ORDER BY m.last_at DESC, m.item LIMIT ?${args.length}`).bind(...args),
    T.prepare("SELECT updated_at FROM inv_cursors WHERE store = ? AND sweep = 'last_sweep'").bind(store),
  ]);
  out.asOf = (sweep.results[0] && sweep.results[0].updated_at) || null;
  let list = rows.results;
  const more = list.length > limit;
  if (more) list = list.slice(0, limit);
  const avail = new Map();
  if (list.length) {
    const by = new Map();
    for (const c of await nowCountsStmt(T, store, list.map((r) => r.item)).all().then((r) => nowCountsRows(r.results))) { const l = by.get(c.item); if (l) l.push(c); else by.set(c.item, [c]); }
    for (const [it, l] of by) avail.set(it, availRes(l).av);
  }
  out.items = list.map((r) => {
    const { onHand, available } = qtyOf(r.qty, r.label_n ? avail.get(r.item) || 0 : null);
    return { item: r.item, name: r.name || r.product || null, category: r.category || null, available, onHand, lastAt: r.last_at };
  });
  if (more) { const last = list[list.length - 1]; out.next = b64({ at: last.last_at, item: last.item, t: term }); }
  // q that looks like a label (item-digits, or a buyback B-item-digits): the matching labels, to jump straight to a label
  if (term && !cur && /^(B-)?[A-Za-z0-9]{2,20}-\d{1,14}$/i.test(term)) {
    const lab = (await T.prepare(`SELECT l.label, l.item, COALESCE(i.name, l.product) AS name, l.serial_status, l.wh_type, l.last_seen, ${nowCols('l')} FROM inv_labels l
        LEFT JOIN inv_items i ON i.store = l.store AND i.item = l.item WHERE l.store = ?1 AND (l.label = ?2 OR l.label LIKE ?3 ESCAPE '\\') ORDER BY l.label = ?2 DESC, l.label LIMIT ?4`)
      .bind(store, (parseLabel(term) || { label: term }).label, likeEsc(term) + '%', LABEL_HITS).all()).results;
    out.labels = lab.map((l) => { const [now, group] = rowNow(l); return { label: l.label, item: l.item || null, name: l.name || null, now, group }; });
  }
  return h.json(out);
}

// ---------------------------------------------------------------- GET /retrace/item/<store>/<item>
async function item(env, url, device, h, store, itemNo) {
  const q = url.searchParams, T = env.TR;
  storeOf(device, String(store));
  const group = q.get('group');
  if (group != null && group !== '' && !GROUPS.includes(group)) throw err(400, 'group: ' + GROUPS.join(', '));
  const [info, counts, labels, moves, first] = await T.batch([
    T.prepare('SELECT name, category, qty, last_seen FROM inv_items WHERE store = ? AND item = ?').bind(store, itemNo),
    nowCountsStmt(T, store, [itemNo]),
    T.prepare(`SELECT l.label, l.serial_status, l.wh_type, l.wo, l.po, l.last_seen, ${nowCols('l')},
        (SELECT m.kind FROM inv_movements m WHERE m.store = l.store AND m.label = l.label ORDER BY m.at DESC, m.id DESC LIMIT 1) AS last_kind,
        (SELECT MAX(m.at) FROM inv_movements m WHERE m.store = l.store AND m.label = l.label) AS last_at
      FROM inv_labels l WHERE l.store = ? AND l.item = ? ORDER BY last_at IS NULL, last_at DESC, l.label LIMIT ?`).bind(store, itemNo, ITEM_LABELS_READ),
    T.prepare('SELECT label, at, kind, ref_type, ref_id FROM inv_movements WHERE store = ? AND item = ? ORDER BY at DESC, id DESC LIMIT ?').bind(store, itemNo, ITEM_MOVES),
    T.prepare('SELECT product FROM inv_labels WHERE store = ? AND item = ? AND product IS NOT NULL LIMIT 1').bind(store, itemNo),
  ]);
  const i = info.results[0] || null;
  if (!i && !labels.results.length && !moves.results.length) throw err(404, 'item not seen at this store');
  const cmap = new Map(), derived = nowCountsRows(counts.results);
  for (const c of derived) { const k = c.now + '\u0001' + c.group, x = cmap.get(k); if (x) x.n += c.n; else cmap.set(k, { now: c.now, group: c.group, n: c.n }); }
  const { onHand, available } = qtyOf(i && i.qty, labels.results.length ? availRes(derived).av : null);
  const rows = labels.results.map((l) => {
    const [now, g] = rowNow(l);
    return { label: l.label, now, group: g, wo: l.wo || null, po: l.po || null, lastKind: l.last_kind || null, lastAt: l.last_at || null };
  });
  const shown = group ? rows.filter((r) => r.group === group) : rows;
  return h.json({ v: 1, now: h.now(), store, item: itemNo,
    info: { name: (i && i.name) || (first.results[0] && first.results[0].product) || null, category: (i && i.category) || null, onHand, available, lastSeen: (i && i.last_seen) || null },
    counts: [...cmap.values()].sort((a, b) => b.n - a.n || (a.now < b.now ? -1 : 1)),
    labels: shown.slice(0, ITEM_LABELS), labelsTotal: shown.length, movements: moves.results.map(movement) });
}

// ---------------------------------------------------------------- GET /retrace/label/<store>/<label>
async function label(env, url, device, h, store, labelNo) {
  const T = env.TR;
  const [row, moves, total] = await T.batch([
    T.prepare(`SELECT l.label, l.item, l.wo, l.po, l.sales_order, l.serial_status, l.wh_type, l.last_seen, ${nowCols('l')}, COALESCE(i.name, l.product) AS name
      FROM inv_labels l LEFT JOIN inv_items i ON i.store = l.store AND i.item = l.item WHERE l.store = ? AND l.label = ?`).bind(store, labelNo),
    T.prepare('SELECT label, at, kind, ref_type, ref_id FROM inv_movements WHERE store = ? AND label = ? ORDER BY at DESC, id DESC LIMIT ?').bind(store, labelNo, LABEL_MOVES),
    T.prepare('SELECT COUNT(*) AS n FROM inv_movements WHERE store = ? AND label = ?').bind(store, labelNo),
  ]);
  const l = row.results[0] || null;
  if (!l && !moves.results.length) throw err(404, 'label not seen at this store');
  let now = null, group = null;
  if (l) [now, group] = rowNow(l);
  const list = moves.results.map(movement).reverse(); // oldest to newest; when capped, the newest LABEL_MOVES
  return h.json({ v: 1, now: h.now(), store, label: labelNo,
    row: l && { label: l.label, item: l.item || null, name: l.name || null, now, group, wo: l.wo || null, po: l.po || null, salesOrder: l.sales_order || null },
    movements: list, movementsTotal: total.results[0].n });
}

// ---------------------------------------------------------------- GET /retrace/pos
async function pos(env, url, device, h) {
  const q = url.searchParams, T = env.TR, store = storeOf(device, q.get('store')), limit = limitOf(h, q.get('limit'));
  const out = { v: 1, now: h.now(), store, pos: [], next: null };
  let cur = null;
  if (q.get('after')) {
    cur = unb64(q.get('after'));
    if (!cur || typeof cur.at !== 'string' || cur.at.length > 40 || typeof cur.id !== 'string' || cur.id.length > 80) throw err(400, 'after: not a cursor from this list');
  }
  // keys first (id, at), then the page's own JSON; newest document date first, a PO without a date last
  const keyArgs = [store], cond = ["d.store = ?1", "d.type = 'po'"];
  if (cur) { keyArgs.push(cur.at, cur.id); cond.push('(COALESCE(d.at, \'\') < ?2 OR (COALESCE(d.at, \'\') = ?2 AND d.id < ?3))'); }
  keyArgs.push(limit + 1);
  const keys = (await T.prepare(`SELECT d.id, COALESCE(d.at, '') AS e FROM inv_docs d WHERE ${cond.join(' AND ')} ORDER BY COALESCE(d.at, '') DESC, d.id DESC LIMIT ?${keyArgs.length}`).bind(...keyArgs).all()).results;
  const more = keys.length > limit, page = keys.slice(0, limit);
  if (page.length) {
    const rows = (await T.prepare("SELECT d.id, d.status, d.at, d.counterpart, d.data FROM inv_docs d WHERE d.store = ? AND d.type = 'po' AND d.id IN (SELECT value FROM json_each(?))").bind(store, JSON.stringify(page.map((k) => k.id))).all()).results;
    const by = new Map(rows.map((r) => [r.id, r]));
    for (const k of page) {
      const r = by.get(k.id); if (!r) continue;
      const x = parse(r.data) || {}, info = x.info || {};
      out.pos.push({ po: r.id, status: r.status || null, counterpart: r.counterpart || null, date: r.at || null,
        labels: x.labels ? x.labels.length : null, received: x.labels ? x.labels.filter((l) => /^received$/i.test(l.status || '')).length : null,
        total: typeof info.total === 'number' ? info.total : null });
    }
  }
  if (more) { const last = page[page.length - 1]; out.next = b64({ at: last.e, id: last.id }); }
  return h.json(out);
}

// ---------------------------------------------------------------- dispatch
export async function retraceApi(req, env, url, device, h) {
  if (req.method !== 'GET') return h.fail(404, 'not found');
  const path = url.pathname.replace(/^\/v1\/agents\/m\/retrace/, '') || '/';
  try {
    if (path === '/items') return await items(env, url, device, h);
    if (path === '/pos') return await pos(env, url, device, h);
    let m = path.match(/^\/item\/(\d{1,6})\/([^/]{1,80})$/);
    if (m) { const it = clean(unesc(m[2]), 40); if (!it) throw err(400, 'item required'); return await item(env, url, device, h, storeOf(device, m[1]), it); }
    m = path.match(/^\/label\/(\d{1,6})\/([^/]{1,80})$/);
    if (m) { const store = storeOf(device, m[1]), lb = cleanLabel(unesc(m[2])); if (!lb) throw err(400, 'not a label'); return await label(env, url, device, h, store, lb); }
  } catch (e) {
    if (e && e.status && e.status < 500) return h.fail(e.status, e.message);
    throw e;
  }
  return h.fail(404, 'not found');
}
