/*
  Linkpearl: work order lookup and unlock, under /v1/agents/m/wo… (phone API; dispatch in mobile-agent.js, contract in MOBILE-API.md, this
  route's reference in MOBILE-API-wo.md). Plain columns only, except where a route is explicitly a sealed-data route.

    GET /v1/agents/m/wo?store=<id>|all&state=open|recent|closed&lane=order,start,work,wait,rfp&followups=1&sort=status|updated|closed&limit=&after=&closedDays=&cards=1
        the list: open work orders (state=open), ones closed in the last closedDays days (state=recent, the 1.0.x behaviour, unchanged), or EVERY closed
        work order, newest close first (state=closed, paged back as far as the tracker holds, one wo_closed index seek per store), a page at a time.
        Open rows carry Waymark's tags and follow-up (mobile-waymark.js); followups=1 keeps those due today or overdue and the first page says how many.
        cards=1 adds each row's sealed search card (the phone opens it locally with the store key and searches names / phones / IMEI there).
    GET /v1/agents/m/wo/find?q=<3-12 digits>[&store=][&limit=]
        exact or prefix match on the work order number, open AND closed, in the device's stores.
    GET /v1/agents/m/wo/<store>/<wo>[?sealed=1]
        one work order: plain header, status timeline, plain cart; sealed=1 adds the sealed card and the latest sealed snapshot.

  Access: everything is limited to device.stores (a store outside it is 403 "not your store", never silently dropped; unknown work order 404).
  Sealed blobs (card, snapshot) are only returned for a store the device holds a wrapped key for (agent_keys), and every such read is written to
  access_log with the device as the actor, the way the admin site logs 'list' / 'open' (actions 'list' and 'open', actor "device:<name>").
  Never in a response: customer or staff names (plain.workorder.createdBy / updatedBy, auditTrail.createdBy and partEvents carry staff and are not read here).
  Detail also carries: parts sold on the work order (inv_wo_parts, no staff column), status / next-update changes (changes, whitelisted fields only), Waymark
  tags and follow-up. No cart-value change list: the tracker records no single field for it (MOBILE-API-wo.md).
  Indexes used: PK (store, wo) and wo_open (store, is_open, status_id) for the work orders, PK (store, wo, start_at) for status_periods, snap_wo
  (store, wo, id) for the one latest snapshot of a detail, wo_closed (store, is_open, closed_at) for states recent and closed, chg_wo (store, wo, id).
*/
import { laneOf, LANES } from './mobile.js';
import { marksFor, dueMarks, dueCond, todayOf } from './mobile-waymark.js';

const DEFAULT_LIMIT = 25, MAX_LIMIT = 100;      // list page
const FIND_LIMIT = 20, FIND_MAX = 50;           // number lookup
const RECENT_DEFAULT = 7, RECENT_MAX = 14;      // days closed work orders stay in "recent" (the Mac audit route's maximum is the same 14)
const TIMELINE_MAX = 100, LINES_MAX = 60, CHANGES_MAX = 100, PARTS_MAX = 100;
const CLOSED_STATUS = new Set([14, 15, 25]);    // Sale complete, Closed, Cancelled: no status_periods rows of their own
const LANE_IDS = LANES.map((l) => l.id);
const LANE_KNOWN = new Set(LANES.flatMap((l) => l.ids));

const err = (status, message) => Object.assign(new Error(message), { status });
const b64 = (o) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => { try { return JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4))); } catch (_) { return null; } };
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch (_) { return null; } };
const secs = (a, b) => (a && b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000)) : null);

// The stores this request is about: ?store=<id> (must be an approved one) or all of the device's. Throws 400 / 403.
function storesOf(device, ask) {
  const mine = device.stores.map(Number);
  if (ask == null || ask === '' || ask === 'all') return mine;
  if (!/^\d{1,6}$/.test(ask)) throw err(400, 'store: all or a store number');
  if (!mine.includes(Number(ask))) throw err(403, 'not your store');
  return [Number(ask)];
}
// Stores (of those asked) that this device holds a wrapped key for: the only ones whose sealed blobs it may have.
async function keyedStores(env, device, ids) {
  if (!ids.length) return [];
  const r = await env.TR.prepare('SELECT store FROM agent_keys WHERE agent_id = ? AND store IN (SELECT value FROM json_each(?))').bind(device.id, JSON.stringify(ids)).all();
  return r.results.map((x) => x.store);
}
const who = (device) => 'device:' + device.name;

// One list / lookup row from the workorders columns (plain only). `since` = status_periods.start_at of the open interval when it is the current status.
function rowOf(r, since) {
  const open = r.is_open === 1;
  return {
    store: r.store, wo: r.wo, open,
    statusId: r.status_id ?? null, status: r.status_name || null, lane: open ? (r.status_id != null ? laneOf(r.status_id) : 'wait') : null,
    device: r.device || null, program: r.program_name || null, bin: r.bin || null, outcome: r.service_outcome || null,
    cartValue: numOrNull(r.cart_value), cartDue: numOrNull(r.cart_due), lastCartValue: numOrNull(r.last_cart_value),
    statusSince: open ? since || null : null,
    createdAt: r.created_at || null, updatedAt: r.api_updated_at || null, closedAt: r.closed_at || null, closedReason: r.closed_reason || null,
    notes: Number.isInteger(r.notes_total) ? r.notes_total : null,
  };
}
const ROW_COLS = `w.store, w.wo, w.status_id, w.status_name, w.program_name, w.device, w.service_outcome, w.cart_value, w.cart_due, w.created_at, w.api_updated_at, w.is_open, w.closed_at, w.closed_reason, w.last_cart_value,
  json_extract(w.plain, '$.workorder.bin') AS bin, json_extract(w.plain, '$.notes.total') AS notes_total`;

// ---------------------------------------------------------------- GET /wo
async function list(env, url, device, h) {
  const q = url.searchParams, T = env.TR;
  const state = q.get('state') || 'open';
  if (state !== 'open' && state !== 'recent' && state !== 'closed') throw err(400, 'state: open, recent or closed');
  const sort = q.get('sort') || (state === 'open' ? 'status' : 'closed');
  if (!['status', 'updated', 'closed'].includes(sort) || (sort === 'closed' && state === 'open') || (state === 'closed' && sort !== 'closed')) throw err(400, 'sort: status, updated or (recent / closed only) closed');
  const limit = Math.min(Math.max(h.int(q.get('limit')) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const days = Math.min(Math.max(h.int(q.get('closedDays')) ?? RECENT_DEFAULT, 1), RECENT_MAX);
  const ids = storesOf(device, q.get('store'));
  const wantCards = q.get('cards') === '1';
  const fu = q.get('followups');
  if (fu != null && fu !== '' && fu !== '0' && fu !== '1') throw err(400, 'followups: 1 (open work orders only)');
  const followups = fu === '1';
  if (followups && state !== 'open') throw err(400, 'followups: 1 (open work orders only)');
  let lanes = null;
  if (q.get('lane')) {
    lanes = [...new Set(q.get('lane').split(',').map((s) => s.trim()))];
    if (state !== 'open' || lanes.some((l) => !LANE_IDS.includes(l))) throw err(400, 'lane: ' + LANE_IDS.join(', ') + ' (open work orders only)');
  }
  const out = { v: 1, now: h.now(), state, sort, scope: ids.length === 1 ? ids[0] : 'all', stores: ids, rows: [], next: null };
  if (!ids.length) return h.json(Object.assign(out, { empty: true }));

  // the cursor: { s: sort, t: state, e: sort key, st: store, w: wo } of the last row of the previous page
  let cur = null;
  if (q.get('after')) {
    cur = unb64(q.get('after'));
    if (!cur || cur.s !== sort || cur.t !== state || typeof cur.e !== 'string' || cur.e.length > 40 || !Number.isInteger(cur.st) || !Number.isInteger(cur.w)) throw err(400, 'after: not a cursor from this list');
  }
  let rows, more, chipRes = null, keyed = null, due = null;
  const today = todayOf(env);
  if (state === 'closed') {
    // Every closed work order, newest close first. One index-ordered statement per store (wo_closed: store, is_open, closed_at), merged here: a page
    // reads about `limit` index entries per store, however many closed work orders there are. Rows with no closed_at (never) are not listed.
    const stmts = ids.map((st) => {
      const w = ['w.store = ?', 'w.is_open = 0', 'w.closed_at IS NOT NULL'], a = [st];
      if (cur) { w.push('w.closed_at <= ?', '(w.closed_at < ? OR (w.closed_at = ? AND (w.store > ? OR (w.store = ? AND w.wo > ?))))'); a.push(cur.e, cur.e, cur.e, cur.st, cur.st, cur.w); }
      return T.prepare(`SELECT w.store, w.wo, w.closed_at AS e FROM workorders w WHERE ${w.join(' AND ')} ORDER BY w.closed_at DESC, w.wo LIMIT ?`).bind(...a, limit + 1);
    });
    const keys = (await T.batch(stmts)).flatMap((x) => x.results).sort((x, y) => (x.e < y.e ? 1 : x.e > y.e ? -1 : x.store - y.store || x.wo - y.wo));
    more = keys.length > limit;
    const page = keys.slice(0, limit), byStore = new Map();
    for (const k of page) { if (!byStore.has(k.store)) byStore.set(k.store, []); byStore.get(k.store).push(k.wo); }
    const full = new Map();
    if (page.length) {
      const got = await T.batch([...byStore].map(([st, wos]) => T.prepare(`SELECT ${ROW_COLS}, w.closed_at AS e${wantCards ? ', w.card AS card' : ''} FROM workorders w
        WHERE w.store = ? AND w.wo IN (SELECT value FROM json_each(?))`).bind(st, JSON.stringify(wos))));
      for (const r of got.flatMap((x) => x.results)) full.set(r.store + '|' + r.wo, r);
    }
    rows = page.map((k) => full.get(k.store + '|' + k.wo)).filter(Boolean);
    if (wantCards) keyed = new Set(await keyedStores(env, device, ids));
  } else {
    const E = sort === 'status' ? "CASE WHEN sp.start_at IS NULL OR sp.status_id != w.status_id THEN '~' ELSE sp.start_at END"
      : sort === 'updated' ? "COALESCE(w.api_updated_at, '')" : "COALESCE(w.closed_at, '')";
    const dir = sort === 'status' ? 'ASC' : 'DESC';
    const where = ['w.store IN (SELECT value FROM json_each(?))'], args = [JSON.stringify(ids)];
    const chips = state === 'open' && !cur;
    if (state === 'open') {
      where.push('w.is_open = 1');
      if (followups || chips) due = await dueMarks(env, ids, today); // Waymark's due marks (today or overdue); the tracker's own table says which are still open
    } else { where.push('w.is_open = 0', 'w.closed_at >= ?'); args.push(new Date(Date.now() - days * 86400000).toISOString()); }
    const countWhere = where.slice(0, 2).join(' AND '), countArgs = [...args.slice(0, 1)];
    if (lanes && lanes.length) {
      const own = LANES.filter((l) => lanes.includes(l.id)).flatMap((l) => l.ids), parts = [];
      if (own.length) parts.push('w.status_id IN (' + own.join(',') + ')'); // numbers from our own table, never user input
      if (lanes.includes('wait')) parts.push('w.status_id IS NULL OR w.status_id NOT IN (' + [...LANE_KNOWN].join(',') + ')'); // any other open status is Waiting
      where.push('(' + parts.join(' OR ') + ')');
    }
    if (followups) { const c = dueCond(due); where.push(c.sql); args.push(...c.args); }
    if (cur) {
      const op = dir === 'ASC' ? '>' : '<';
      where.push(`(${E} ${op} ? OR (${E} = ? AND (w.store > ? OR (w.store = ? AND w.wo > ?))))`);
      args.push(cur.e, cur.e, cur.st, cur.st, cur.w);
    }
    // A page of keys first (no plain JSON or sealed column read for rows that are not on the page), then that page's own columns.
    const sql = `SELECT ${ROW_COLS}, p.since AS since, p.sp AS sp_status, p.e AS e${wantCards ? ', w.card AS card' : ''}
      FROM (SELECT w.store AS store, w.wo AS wo, sp.start_at AS since, sp.status_id AS sp, ${E} AS e
            FROM workorders w LEFT JOIN status_periods sp ON sp.store = w.store AND sp.wo = w.wo AND sp.end_at IS NULL
            WHERE ${where.join(' AND ')} ORDER BY ${E} ${dir}, w.store, w.wo LIMIT ?) p
      JOIN workorders w ON w.store = p.store AND w.wo = p.wo
      ORDER BY p.e ${dir}, p.store, p.wo`;
    const tasks = [T.prepare(sql).bind(...args, limit + 1)];
    if (chips) {
      tasks.push(T.prepare(`SELECT w.status_id AS s, COUNT(*) AS n FROM workorders w WHERE ${countWhere} GROUP BY w.status_id`).bind(...countArgs)); // lane chips, not narrowed by lane
      if (due) { const c = dueCond(due); tasks.push(T.prepare(`SELECT COUNT(*) AS n FROM workorders w WHERE ${countWhere} AND ${c.sql}`).bind(...countArgs, ...c.args)); }
    }
    if (wantCards) tasks.push(T.prepare('SELECT store FROM agent_keys WHERE agent_id = ? AND store IN (SELECT value FROM json_each(?))').bind(device.id, JSON.stringify(ids)));
    const res = await T.batch(tasks);
    rows = res[0].results; more = rows.length > limit;
    if (more) rows = rows.slice(0, limit);
    if (chips) {
      chipRes = res[1].results;
      const c = { order: 0, start: 0, work: 0, wait: 0, rfp: 0, total: 0 };
      for (const r of chipRes) { c[r.s == null ? 'wait' : laneOf(r.s)] += r.n; c.total += r.n; }
      out.lanes = c;
      out.followUps = { count: due ? res[2].results[0].n : null, today }; // the follow-ups chip: open work orders with a follow-up due today or overdue (null: Waymark not readable)
    }
    if (wantCards) keyed = new Set(res[res.length - 1].results.map((x) => x.store));
  }
  const seen = new Set();
  for (const r of rows) {
    const k = r.store + '|' + r.wo; if (seen.has(k)) continue; seen.add(k);
    const row = rowOf(r, r.sp_status === r.status_id ? r.since : null);
    if (wantCards) row.card = keyed.has(r.store) ? r.card || null : null;
    out.rows.push(row);
  }
  if (state === 'open' && out.rows.length) { // Waymark: tags and follow-up of each row (one batched read per page)
    const marks = await marksFor(env, out.rows);
    for (const row of out.rows) Object.assign(row, marks.get(row.store + '|' + row.wo));
  }
  if (more) { const last = rows[rows.length - 1]; out.next = b64({ s: sort, t: state, e: last.e, st: last.store, w: last.wo }); }
  if (state === 'recent') out.closedDays = days;
  if (wantCards) {
    out.cards = true; out.cardsFor = ids.filter((s) => keyed.has(s)); out.noKey = ids.filter((s) => !keyed.has(s));
    if (q.get('store') && q.get('store') !== 'all' && !out.cardsFor.length) throw err(403, 'no key for this store');
    // one access_log row per store whose cards went out (what a phone downloaded), like the admin site's 'list'
    for (const s of out.cardsFor) await h.log(env, who(device), 'list', s, null, 'phone cards ' + out.rows.filter((r) => r.store === s && r.card).length + ' ' + device.id.slice(0, 8));
  }
  return h.json(out);
}

// ---------------------------------------------------------------- GET /wo/find
async function find(env, url, device, h) {
  const q = url.searchParams, T = env.TR, term = String(q.get('q') || '').trim();
  if (!/^[1-9]\d{2,11}$/.test(term)) throw err(400, 'q: 3 to 12 digits, a work order number or its start');
  const limit = Math.min(Math.max(h.int(q.get('limit')) || FIND_LIMIT, 1), FIND_MAX);
  const ids = storesOf(device, q.get('store'));
  const out = { v: 1, now: h.now(), q: term, rows: [], more: false };
  if (!ids.length) return h.json(out);
  // a prefix of a number of 3-12 digits is one range per possible length: p×10^k … p×10^k + 10^k - 1 (the PK (store, wo) answers each)
  const p = Number(term), ranges = [];
  for (let k = 0; term.length + k <= 12; k++) ranges.push([p * 10 ** k, p * 10 ** k + 10 ** k - 1]);
  // one statement per store and range, so each is a seek on the PK (an OR over ranges scans the whole store); a batch is one round trip
  const stmts = ids.flatMap((s) => ranges.map(([lo, hi]) => T.prepare(`SELECT ${ROW_COLS}, (SELECT start_at FROM status_periods sp WHERE sp.store = w.store AND sp.wo = w.wo AND sp.end_at IS NULL AND sp.status_id = w.status_id ORDER BY start_at DESC LIMIT 1) AS since
      FROM workorders w WHERE w.store = ? AND w.wo BETWEEN ? AND ? ORDER BY w.wo LIMIT ?`).bind(s, lo, hi, limit + 1)));
  const rows = (await T.batch(stmts)).flatMap((r) => r.results);
  rows.sort((a, b) => (b.wo === p) - (a.wo === p) || a.wo - b.wo || a.store - b.store);
  out.more = rows.length > limit;
  out.rows = rows.slice(0, limit).map((r) => rowOf(r, r.since));
  return h.json(out);
}

// ---------------------------------------------------------------- GET /wo/<store>/<wo>
// The status timeline, newest first. status_periods holds open statuses only (Sale complete / Closed / Cancelled get no interval of their own).
async function timelineOf(T, store, wo, nowMs) {
  const sp = (await T.prepare(`SELECT sp.status_id, sp.start_at, sp.end_at, st.name FROM status_periods sp LEFT JOIN statuses st ON st.id = sp.status_id
    WHERE sp.store = ? AND sp.wo = ? ORDER BY sp.start_at DESC LIMIT ?`).bind(store, wo, TIMELINE_MAX).all()).results;
  const entry = (s, name, start, end) => ({ statusId: s, status: name || null, lane: CLOSED_STATUS.has(s) ? null : laneOf(s), start: start || null, end: end || null,
    seconds: secs(start, end || new Date(nowMs).toISOString()), current: !end });
  if (sp.length) return { source: 'periods', rows: sp.map((r) => entry(r.status_id, r.name, r.start_at, r.end_at)) };
  // No status_periods yet (a work order stored before Metrics' backfill): rebuild from the change rows of workorder.statusId, oldest to newest.
  const ch = (await T.prepare(`SELECT c.changed_at, c.old, c.new, st.name FROM changes c LEFT JOIN statuses st ON st.id = CAST(c.new AS INTEGER)
    WHERE c.store = ? AND c.wo = ? AND c.field = 'workorder.statusId' ORDER BY c.id LIMIT ?`).bind(store, wo, TIMELINE_MAX).all()).results;
  if (!ch.length) return { source: null, rows: [] };
  const rows = [], first = ch[0].old == null ? NaN : Number(ch[0].old);
  if (Number.isInteger(first)) rows.push(entry(first, null, null, ch[0].changed_at)); // began before the tracker saw it: start unknown (null)
  ch.forEach((c, i) => rows.push(entry(Number(c.new), c.name, c.changed_at, i + 1 < ch.length ? ch[i + 1].changed_at : null)));
  return { source: 'changes', rows: rows.reverse() };
}

// A change row as the app gets it. Stored values are JSON text (the tracker diffs the plain part flattened): "2026-…Z" for a time, 9 for a status id.
const jsonOf = (t) => { if (t == null) return null; try { return JSON.parse(t); } catch (_) { return t; } };
const isoOrNull = (v) => { if (typeof v !== 'string') return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); };
function changeOf(c) {
  if (c.field === 'workorder.statusId') {
    const nm = (v, name) => { const n = jsonOf(v); return name || (n == null ? null : String(n)); };
    return { at: c.changed_at, field: 'status', old: nm(c.old, c.old_name), new: nm(c.new, c.new_name) };
  }
  return { at: c.changed_at, field: 'nextUpdate', old: isoOrNull(jsonOf(c.old)), new: isoOrNull(jsonOf(c.new)) };
}

async function detail(env, url, device, h, store, wo) {
  const T = env.TR, sealed = url.searchParams.get('sealed') === '1';
  if (!device.stores.map(Number).includes(store)) throw err(403, 'not your store');
  const nowMs = Date.now();
  const [wr, sp, partsR, soldR, chg] = await T.batch([
    T.prepare(`SELECT ${ROW_COLS}, w.plain AS plain_json, w.cart_total, w.cart_paid, w.closed_reason, w.sold_at FROM workorders w WHERE w.store = ? AND w.wo = ?`).bind(store, wo),
    T.prepare('SELECT start_at FROM status_periods sp WHERE sp.store = ? AND sp.wo = ? AND sp.end_at IS NULL AND sp.status_id = (SELECT status_id FROM workorders WHERE store = ? AND wo = ?) ORDER BY start_at DESC LIMIT 1').bind(store, wo, store, wo),
    // parts sold on the work order (retrace-wo-parts.js: the sales order's part lines; labor and credit lines are not here). No staff column is read.
    T.prepare(`SELECT p.line, p.label, p.item, p.sku, COALESCE(p.name, i.name) AS name, p.quantity, p.price, p.serial_status, p.sold_at
      FROM inv_wo_parts p LEFT JOIN inv_items i ON i.store = p.store AND i.item = p.item WHERE p.store = ? AND p.wo = ? ORDER BY p.line LIMIT ?`).bind(store, String(wo), PARTS_MAX),
    T.prepare('SELECT state FROM inv_wo_sold WHERE store = ? AND wo = ?').bind(store, String(wo)),
    // status and next-update changes only, newest first (the whitelist keeps createdBy / updatedBy / audit-trail rows out); chg_wo (store, wo, id)
    T.prepare(`SELECT c.changed_at, c.field, c.old, c.new, so.name AS old_name, sn.name AS new_name FROM changes c
      LEFT JOIN statuses so ON c.field = 'workorder.statusId' AND so.id = CAST(c.old AS INTEGER) LEFT JOIN statuses sn ON c.field = 'workorder.statusId' AND sn.id = CAST(c.new AS INTEGER)
      WHERE c.store = ? AND c.wo = ? AND c.field IN ('workorder.statusId', 'workorder.nextUpdate') ORDER BY c.id DESC LIMIT ?`).bind(store, wo, CHANGES_MAX),
  ]);
  const r = wr.results[0];
  if (!r) throw err(404, 'no such work order');
  if (sealed && !(await keyedStores(env, device, [store])).length) throw err(403, 'no key for this store');
  const plain = parse(r.plain_json) || {}, pw = plain.workorder || {};
  const row = rowOf(r, sp.results[0] ? sp.results[0].start_at : null);
  const tl = await timelineOf(T, store, wo, nowMs);
  const money = (v) => (v == null ? null : numOrNull(Number(v)));
  const mk = (await marksFor(env, [{ store, wo, open: row.open }])).get(store + '|' + wo);
  const items = ((plain.cart && Array.isArray(plain.cart.items)) ? plain.cart.items : []).slice(0, LINES_MAX);
  const out = {
    v: 1, now: new Date(nowMs).toISOString(),
    wo: Object.assign(row, {
      nextUpdate: typeof pw.nextUpdate === 'string' ? pw.nextUpdate : null, slaEnd: typeof pw.slaEndTime === 'string' ? pw.slaEndTime : null,
      rfpAt: typeof pw.rfpAt === 'string' ? pw.rfpAt : null, outcomeReason: typeof pw.outcomeReason === 'string' ? pw.outcomeReason : null,
      soldAt: r.sold_at || null, tags: mk.tags, followUp: mk.followUp,
    }),
    timeline: tl.rows, timelineSource: tl.source,
    parts: { state: soldR.results[0] ? soldR.results[0].state : null, rows: partsR.results.map((x) => ({ line: x.line, label: x.label || null, item: x.item || null, sku: x.sku || null, name: x.name || null,
      quantity: numOrNull(x.quantity), price: numOrNull(x.price), status: x.serial_status || null, soldAt: x.sold_at || null })) },
    changes: chg.results.map(changeOf),
    cart: { value: row.cartValue, total: money(r.cart_total), paid: money(r.cart_paid), due: row.cartDue,
      lines: items.map((i) => ({ name: typeof i.name === 'string' ? i.name : null, sku: typeof i.sku === 'string' || typeof i.sku === 'number' ? String(i.sku) : null, quantity: numOrNull(Number(i.quantity)),
        price: numOrNull(Number(i.price)), totalPrice: numOrNull(Number(i.totalPrice)), partStatus: typeof i.partStatus === 'string' ? i.partStatus : null })) },
  };
  if (sealed) {
    const [card, snap] = await T.batch([
      T.prepare('SELECT card FROM workorders WHERE store = ? AND wo = ?').bind(store, wo),
      T.prepare('SELECT id, fetched_at, sealed FROM snapshots WHERE store = ? AND wo = ? ORDER BY id DESC LIMIT 1').bind(store, wo),
    ]);
    const s = snap.results[0];
    await h.log(env, who(device), 'open', store, wo, 'phone sealed ' + device.id.slice(0, 8)); // logged first: nothing sealed leaves unrecorded
    out.sealed = { card: (card.results[0] && card.results[0].card) || null, snapshot: s ? { id: s.id, fetchedAt: s.fetched_at, sealed: s.sealed } : null };
  }
  return h.json(out);
}

// ---------------------------------------------------------------- dispatch
export async function woApi(req, env, url, device, h) {
  if (req.method !== 'GET') return h.fail(404, 'not found');
  const path = url.pathname.replace(/^\/v1\/agents\/m\/wo/, '') || '/';
  try {
    if (path === '/') return await list(env, url, device, h);
    if (path === '/find') return await find(env, url, device, h);
    const m = path.match(/^\/(\d{1,6})\/(\d{1,12})$/);
    if (m) return await detail(env, url, device, h, Number(m[1]), Number(m[2]));
  } catch (e) {
    if (e && e.status && e.status < 500) return h.fail(e.status, e.message);
    throw e;
  }
  return h.fail(404, 'not found');
}
