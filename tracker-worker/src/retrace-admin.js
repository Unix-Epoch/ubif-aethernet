/*
  Retrace, the admin side: the admin site's reads (and Verify's and Sources' writes). Mounted by trackerAdmin at /api/tracker/retrace/….
  Behind the access gate (page 'retrace'; the store in the path, or ?store=, must be one of the person's stores).
  Paths below are under /api/tracker. Movements come back as stored, user_name as `user`.

  GET /retrace/item/:store/:item?from&to&kinds&user&limit&offset   → { store, item, info: { name, category, qty, last_seen,
        changed_at } | null, counts: [{ serial_status, wh_type, consignment, now, group, n }], labels: [{ label, serial_status, wh_type,
        consignment, wo, po, last_seen, last_history_at, need_history }], movements: [...], total,
        by_kind: [{ kind, n }], users: [{ user, n }], first_at, all_total, sold90, source } · source: retrace-source.js itemSource for a Mobility /
        Reportable Consumables item ({ source, basis, manual, manual_by, auto, conflict, evidence }), else null
        from / to: YYYY-MM-DD (UTC days) or ISO; kinds: comma list of KINDS; user: who made the movement; newest first;
        limit ≤ 1000 (200). by_kind: the date range and user without the kinds filter (the page's filter chips); users:
        the date range and kinds without the user filter (its person picker); first_at / all_total: every movement of the
        item, no filter; sold90: 'sold' movements in the last 90 days.
  GET /retrace/serials/:store/:item?group&days&limit&offset   → { store, item, serials: [{ label, now, group, serial_status, wh_type, wo, po,
        moves, last: { at, kind, user, source, ref_type, ref_id, wo, from_wh, to_wh, detail } | null }], total, groups: { all, in, wo, out, q, bad },
        loose: [movements with no label], loose_total }
        the item list's one row per serial (the page's item view): the labels the item's movements name plus the labels stored for it (one with no
        movement yet has last null, moves 0); last = the newest movement, moves = all of the label's movements,
        now / group = where it stands (retrace-now.js: Portal's status on the label, else the latest STATUS-BEARING movement, which wins when newer than the label's last snapshot; a consignment change never hides a sale). groups: how many
        serials are in each group (days applied, group not); group: in|wo|out|q|bad; days: only serials whose last movement is that
        recent (1-3650); newest last movement first; limit ≤ 500 (200). loose: the item's movements with no label (days applied), 50 newest.
  GET /retrace/items?store=&limit=&offset=   → { items: [{ item, name, category, qty, on_hand, available, moves, last_at, source }], total }
        source (retrace-source.js): distro | ms | other | unset | conflict for Mobility / Reportable Consumables items, else null.
  GET  /retrace/sources/:store?source=  → retrace-source.js sourcesView: { store, counts, total, pause: { paused, unmarked, paused_at }, items }
        source: all | distro | ms | other | unset | conflict | unmarked (unset and conflict).
  POST /retrace/sources/:store/set { items: [item], source: distro|ms|other|null, view? }  → { changed, stores: [{ store, unmarked, paused }] } + the view again.
        Marks items by hand for every store (an item number has one source); null hands them back to the rules.
        items with movements at the store, most recent movement first; name from inv_items, else a label's product;
        on_hand: inv_items qty summed over the store's warehouses (null when the item lookup hasn't seen it);
        available: the page's Available tile (lookup quantity over non-quarantine warehouses, else the available labels; null with neither); limit ≤ 500 (100).
  GET /retrace/label/:store/:label   → { label: inv_labels row | null, now: { status, group } | null (where it stands, retrace-now.js), movements: [...] } oldest first · 404 when neither
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
  GET /retrace/coverage?store=       → { stores: [{ store, labels, histories, backlog, claimed, items, movements,
        last_history_at, last_sweep_at, last_sweep, progress }] } for the stores the person can see; with ?store= only that store's row is
        worked out (the page polls it so; without, every store the person can see: the store switcher's first load). progress is kept for
        PROGRESS_TTL_MS (30 s) per store in memory, so polls in between read nothing. progress: the store's
        baseline progress (see "Progress" at the top: state, pct, done_at, counted_at, eta_min, steps { stock, labels, histories,
        pos, names: { x, y } }, counting { items_done, items_total, pos_known }, new_labels), what the page's strip draws.
*/
import { json, fail, int, clean, readJson, parse } from './http.js';
import { woPartsView } from './retrace-wo-parts.js';
import { verifyRun, verifyView, verifyTick, QUEUE_REASON, QUEUE_SINCE } from './retrace-verify.js';
import { cleanLabel, KINDS, isoAt } from './retrace.js';
import { nowCols, rowNow, nowCountsStmt, nowCountsRows, nowCounts, availRes } from './retrace-now.js';
import { sourcesView, itemSource, setSources, effective, SOURCES, IN_SCOPE } from './retrace-source.js';
import { LAST_SWEEP, PASS_MIN, PER_PASS, QUEUE_ORDER, cachedProgress, unesc } from './retrace-core.js';

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

// Coverage check (src/retrace-verify.js): the only routes here that write (its result and the spot check's ticks).
async function verifyRoute({ req, env, T, email, H, m, store }) {
  const act = m[2] || null;
  const at = new Date().toISOString();
  if (!act) { await H.log(env, email, 'retrace:verify', store); return json(await verifyView(T, store), 200, false); }
  if (act === 'run') {
    if (!(await verifyRun(T, store, at, email))) return fail(409, 'the store\'s baseline is not frozen yet', false);
    await H.log(env, email, 'retrace:verify-run', store);
  } else {
    const b = await readJson(req, 2000), label = cleanLabel(b.label);
    if (!label || typeof b.matches !== 'boolean') return fail(400, 'label and matches (true or false) required', false);
    if (!(await verifyTick(T, store, label, b.matches, email, at))) return fail(400, 'not one of the labels to check', false);
    await H.log(env, email, 'retrace:verify-tick', store, null, label + (b.matches ? ' matches' : ' unticked'));
  }
  return json(await verifyView(T, store), 200, false);
}

// Item sources (retrace-source.js): GET the store's in-scope items with their source; POST /set marks items by hand (source null = back to the rules).
async function sourcesRoute({ req, env, T, q, email, H, m, store }) {
  const set = !!m[2];
  if (!set) {
    const f = q.get('source') || 'all';
    if (!['all', 'unmarked', 'unset', 'conflict', ...SOURCES].includes(f)) return fail(400, 'source: all, distro, ms, other, unset, conflict, unmarked', false);
    return json(await sourcesView(T, store, f, { limit: Math.min(int(q.get('limit')) || 500, 2000), offset: int(q.get('offset')) || 0 }), 200, false);
  }
  const b = await readJson(req, 40000);
  const items = Array.isArray(b.items) ? b.items.map((x) => clean(x == null ? '' : String(x), 40)).filter(Boolean) : [];
  if (!items.length || items.length > 1000) return fail(400, 'items: 1 to 1000 item numbers', false);
  if (!(b.source === null || SOURCES.includes(b.source))) return fail(400, 'source: distro, ms, other or null', false);
  const r = await setSources(T, env, items, b.source, email || null, new Date().toISOString());
  await H.log(env, email, 'retrace:source', store, null, (b.source || 'reset') + ' ' + items.slice(0, 20).join(',') + (items.length > 20 ? ' +' + (items.length - 20) : ''));
  return json(Object.assign(r, await sourcesView(T, store, clean(b.view, 20) || 'all')), 200, false);
}

// One work order's parts and labels (retrace-wo-parts.js woPartsView): a work order view, so page 'wos' too (the gate checked 'retrace').
async function woRoute({ env, T, me, email, H, m, store }) {
  const wo = m[2];
  if (!me.owner && !(me.pages || []).includes('wos')) return fail(403, 'no access to this page', false);
  await H.log(env, email, 'retrace:wo', store, Number(wo));
  return json(await woPartsView(T, store, wo), 200, false);
}

async function queueRoute({ env, T, q, email, H, store }) {
  await H.log(env, email, 'retrace:queue', store);
  return json(await queueView(T, store, { reason: q.get('reason'), item: clean(q.get('item'), 40), limit: q.get('limit'), offset: q.get('offset') }), 200, false);
}

async function itemRoute({ env, T, q, email, H, m, store }) {
  const item = clean(unesc(m[2]), 40);
  if (!item) return fail(400, 'item required', false);
  const where = ['m.store = ?', 'm.item = ?'], args = [store, item];
  const from = q.get('from') ? dayFrom(q.get('from')) : null, to = q.get('to') ? dayTo(q.get('to')) : null;
  if (q.get('from') && !from) return fail(400, 'from: YYYY-MM-DD or ISO', false);
  if (q.get('to') && !to) return fail(400, 'to: YYYY-MM-DD or ISO', false);
  if (from) { where.push('m.at >= ?'); args.push(from); }
  if (to) { where.push('m.at <= ?'); args.push(to); }
  // The date range alone (by_kind adds the user, users adds the kinds; the movement list has all three).
  const base = [...where], baseArgs = [...args], kw = [], kwArgs = [], uw = [], uwArgs = [];
  if (q.get('kinds')) {
    const kinds = q.get('kinds').split(',').map((k) => k.trim()).filter(Boolean);
    if (!kinds.length || kinds.some((k) => !KINDS.includes(k))) return fail(400, 'kinds: ' + KINDS.join(', '), false);
    kw.push('m.kind IN (SELECT value FROM json_each(?))'); kwArgs.push(JSON.stringify(kinds));
  }
  const user = clean(q.get('user'), 80);
  if (user) { uw.push('m.user_name = ?'); uwArgs.push(user); }
  where.push(...kw, ...uw); args.push(...kwArgs, ...uwArgs);
  const limit = Math.min(int(q.get('limit')) || 200, 1000), offset = int(q.get('offset')) || 0;
  const since90 = new Date(Date.now() - 90 * 86400000).toISOString();
  const [info, counts, labels, moves, total, byKind, users, all] = await T.batch([
    T.prepare('SELECT name, category, qty, last_seen, changed_at FROM inv_items WHERE store = ? AND item = ?').bind(store, item),
    nowCountsStmt(T, store, [item]),
    T.prepare('SELECT label, serial_status, wh_type, consignment, wo, po, last_seen, last_history_at, need_history FROM inv_labels WHERE store = ? AND item = ? ORDER BY last_seen DESC LIMIT 1000').bind(store, item),
    T.prepare(`SELECT ${MV_COLS} FROM ${MV_FROM} WHERE ${where.join(' AND ')} ORDER BY m.at DESC, m.id DESC LIMIT ? OFFSET ?`).bind(...args, limit, offset),
    T.prepare(`SELECT COUNT(*) AS n FROM inv_movements m WHERE ${where.join(' AND ')}`).bind(...args),
    T.prepare(`SELECT m.kind, COUNT(*) AS n FROM inv_movements m WHERE ${[...base, ...uw].join(' AND ')} GROUP BY m.kind ORDER BY n DESC`).bind(...baseArgs, ...uwArgs),
    T.prepare(`SELECT m.user_name AS user, COUNT(*) AS n FROM inv_movements m WHERE ${[...base, ...kw].join(' AND ')} AND m.user_name IS NOT NULL GROUP BY m.user_name ORDER BY n DESC LIMIT 100`).bind(...baseArgs, ...kwArgs),
    T.prepare("SELECT MIN(at) AS first_at, COUNT(*) AS n, SUM(CASE WHEN kind = 'sold' AND at >= ? THEN 1 ELSE 0 END) AS sold90 FROM inv_movements WHERE store = ? AND item = ?").bind(since90, store, item),
  ]);
  const i = info.results[0] || null, a = all.results[0] || {};
  await H.log(env, email, 'retrace:item', store, null, item);
  // counts: the labels by Portal's raw status AND by where they stand now (retrace-now.js); the page's tiles use now / group
  const cmap = new Map();
  for (const c of nowCountsRows(counts.results)) { const k = [c.serial_status, c.wh_type, c.consignment, c.now].join('\u0001'); const x = cmap.get(k); if (x) x.n += c.n; else cmap.set(k, { serial_status: c.serial_status, wh_type: c.wh_type, consignment: c.consignment, now: c.now, group: c.group, n: c.n }); }
  // its source (retrace-source.js) when the item is one that has one (Mobility, Reportable Consumables); null before the migration
  let source = null;
  if (i && IN_SCOPE.test(i.category || '')) try { source = await itemSource(T, item); } catch (_) {}
  return json({ store, item, source, info: i && Object.assign(i, { qty: parse(i.qty) }), counts: [...cmap.values()].sort((a, b) => b.n - a.n), labels: labels.results, movements: moves.results, total: total.results[0].n,
    by_kind: byKind.results, users: users.results, first_at: a.first_at || null, all_total: a.n || 0, sold90: a.sold90 || 0 }, 200, false);
}

async function serialsRoute({ env, T, q, email, H, m, store }) {
  const item = clean(unesc(m[2]), 40);
  if (!item) return fail(400, 'item required', false);
  const group = q.get('group') || 'all';
  if (!['all', 'in', 'wo', 'out', 'q', 'bad'].includes(group)) return fail(400, 'group: all, in, wo, out, q, bad', false);
  const days = q.get('days') ? int(q.get('days')) : null;
  if (q.get('days') && (days == null || days < 1 || days > 3650)) return fail(400, 'days: 1 to 3650', false);
  const since = days ? new Date(Date.now() - days * 86400000).toISOString() : null;
  const limit = Math.min(int(q.get('limit')) || 200, 500), offset = int(q.get('offset')) || 0;
  // One row per serial: the labels the item's movements name plus the labels stored for it (a label with no movements yet is a serial too, `last` null),
  // each with its newest movement of this item.
  const [last, loose, looseN] = await T.batch([
    T.prepare(`SELECT k.label AS klabel, r.*, l.serial_status, l.wh_type, l.wo AS label_wo, l.po AS label_po, l.last_seen, ${nowCols('l')} FROM (
        SELECT label FROM inv_movements WHERE store = ?1 AND item = ?2 AND label IS NOT NULL UNION SELECT label FROM inv_labels WHERE store = ?1 AND item = ?2) k
      LEFT JOIN (SELECT * FROM (SELECT ${MV_COLS}, ROW_NUMBER() OVER (PARTITION BY m.label ORDER BY m.at DESC, m.id DESC) AS rn, COUNT(*) OVER (PARTITION BY m.label) AS moves
        FROM ${MV_FROM} WHERE m.store = ?1 AND m.item = ?2 AND m.label IS NOT NULL) WHERE rn = 1) r ON r.label = k.label
      LEFT JOIN inv_labels l ON l.store = ?1 AND l.label = k.label ${since ? 'WHERE r.at >= ?3' : ''} ORDER BY r.at DESC, r.id DESC, k.label LIMIT 5000`).bind(...[store, item, since].filter((v) => v != null)),
    T.prepare(`SELECT ${MV_COLS} FROM ${MV_FROM} WHERE m.store = ? AND m.item = ? AND m.label IS NULL ${since ? 'AND m.at >= ?' : ''} ORDER BY m.at DESC, m.id DESC LIMIT 50`).bind(...[store, item, since].filter((v) => v != null)),
    T.prepare(`SELECT COUNT(*) AS n FROM inv_movements m WHERE m.store = ? AND m.item = ? AND m.label IS NULL ${since ? 'AND m.at >= ?' : ''}`).bind(...[store, item, since].filter((v) => v != null)),
  ]);
  const groups = { all: 0, in: 0, wo: 0, out: 0, q: 0, bad: 0 };
  const rows = last.results.map((r) => {
    const [now, g] = rowNow(r); // from the latest status-bearing movement, which may be older than the `last` shown (a consignment change)
    groups.all++; if (g) groups[g]++;
    return { label: r.klabel, now, group: g, serial_status: r.serial_status || null, wh_type: r.wh_type || null, wo: r.label_wo || null, po: r.label_po || null, moves: r.moves || 0,
      last: r.id == null ? null : { at: r.at, kind: r.kind, user: r.user, source: r.source, ref_type: r.ref_type, ref_id: r.ref_id, wo: r.wo, from_wh: r.from_wh, to_wh: r.to_wh, detail: r.detail } };
  });
  const shown = group === 'all' ? rows : rows.filter((r) => r.group === group);
  await H.log(env, email, 'retrace:serials', store, null, item);
  return json({ store, item, serials: shown.slice(offset, offset + limit), total: shown.length, groups, loose: loose.results, loose_total: looseN.results[0].n }, 200, false);
}

async function labelRoute({ env, T, email, H, m, store }) {
  const label = cleanLabel(unesc(m[2]));
  if (!label) return fail(400, 'not a label', false);
  const [row, moves] = await T.batch([
    T.prepare(`SELECT l.*, ${nowCols('l')} FROM inv_labels l WHERE l.store = ? AND l.label = ?`).bind(store, label),
    T.prepare(`SELECT ${MV_COLS} FROM ${MV_FROM} WHERE m.store = ? AND m.label = ? ORDER BY m.at, m.id LIMIT 2000`).bind(store, label),
  ]);
  if (!row.results.length && !moves.results.length) return fail(404, 'label not seen at this store', false);
  await H.log(env, email, 'retrace:label', store, null, label);
  const lr = row.results[0] || null;
  let now = null;
  if (lr) { const [text, group] = rowNow(lr); now = { status: text, group }; delete lr.now_kind; delete lr.now_at; }
  return json({ label: lr, now, movements: moves.results }, 200, false);
}

// Items with movements at a store, most recent movement first (the page's item list).
async function itemsRoute({ T, q, store }) {
  const limit = Math.min(int(q.get('limit')) || 100, 500), offset = int(q.get('offset')) || 0;
  const [rows, total] = await T.batch([
    T.prepare(`SELECT m.item, m.moves, m.last_at, i.name, i.category, i.qty, lb.n AS label_n,
        (SELECT l.product FROM inv_labels l WHERE l.store = ?1 AND l.item = m.item AND l.product IS NOT NULL LIMIT 1) AS product
        FROM (SELECT item, COUNT(*) AS moves, MAX(at) AS last_at FROM inv_movements WHERE store = ?1 AND item IS NOT NULL GROUP BY item) m
        LEFT JOIN inv_items i ON i.store = ?1 AND i.item = m.item
        LEFT JOIN (SELECT item, COUNT(*) AS n FROM inv_labels WHERE store = ?1 GROUP BY item) lb ON lb.item = m.item
        ORDER BY m.last_at DESC, m.item LIMIT ?2 OFFSET ?3`).bind(store, limit, offset),
    T.prepare('SELECT COUNT(DISTINCT item) AS n FROM inv_movements WHERE store = ? AND item IS NOT NULL').bind(store),
  ]);
  // the available labels (the fallback when there is no lookup quantity) from where each label stands now, for this page's items
  const labelAv = new Map();
  if (rows.results.length) {
    const by = new Map();
    for (const c of await nowCounts(T, store, rows.results.map((r) => r.item))) { const l = by.get(c.item); if (l) l.push(c); else by.set(c.item, [c]); }
    for (const [it, l] of by) labelAv.set(it, availRes(l).av);
  }
  const items = rows.results.map((r) => {
    const qty = parse(r.qty);
    const onHand = qty && typeof qty === 'object' ? Object.values(qty).reduce((n, w) => n + (w && typeof w.onHand === 'number' ? w.onHand : 0), 0) : null;
    // available: what the item page's Available tile shows: Portal's stock-lookup quantity (non-quarantine warehouses), else the available labels; null with neither
    const whs = qty && typeof qty === 'object' ? Object.entries(qty).filter(([, w]) => w && typeof w === 'object') : [];
    const available = whs.length ? whs.filter(([id]) => !/q$/i.test(id)).reduce((n, [, w]) => n + (typeof w.available === 'number' ? w.available : 0), 0) : r.label_n ? labelAv.get(r.item) || 0 : null;
    return { item: r.item, name: r.name || r.product || null, category: r.category || null, qty, on_hand: onHand, available, moves: r.moves, last_at: r.last_at,
      source: IN_SCOPE.test(r.category || '') ? 'unset' : null };
  });
  // sources (retrace-source.js) of the in-scope ones; left 'unset' before the migration
  const scoped = items.filter((x) => x.source);
  if (scoped.length) try {
    const src = new Map((await T.prepare('SELECT item, manual, auto, conflict FROM inv_item_source WHERE item IN (SELECT value FROM json_each(?))').bind(JSON.stringify(scoped.map((x) => x.item))).all()).results.map((r) => [r.item, r]));
    for (const x of scoped) x.source = effective(src.get(x.item));
  } catch (_) {}
  return json({ items, total: total.results[0].n }, 200, false);
}

async function searchRoute({ env, T, q, email, H, s }) {
  const term = clean(q.get('q'), 60);
  if (!term || term.length < 2) return fail(400, 'q (2 characters or more) required', false);
  const like = likeEsc(term) + '%', label = cleanLabel(term) || term;
  const [labels, items, refs, docs] = await T.batch([
    T.prepare(`SELECT store, label, item, product, serial_status, wh_type, consignment, wo, po, last_seen, ${nowCols('inv_labels')} FROM inv_labels
        WHERE ${s.sql} AND (label = ? OR label LIKE ? ESCAPE '\\' OR oem_serial = ? OR imei = ? OR po = ? OR wo = ?) ORDER BY label = ? DESC, last_seen DESC LIMIT 50`).bind(...s.args, label, like, term, term, term, term, label),
    T.prepare(`SELECT store, item, name, category, last_seen FROM inv_items WHERE ${s.sql} AND (item = ? OR name LIKE ? ESCAPE '\\') ORDER BY item = ? DESC, name LIMIT 30`).bind(...s.args, term, '%' + likeEsc(term) + '%', term),
    // A WO number also finds its sales orders' rows (history names only the FSO).
    T.prepare(`SELECT store, ref_type, ref_id, COUNT(*) AS n, MIN(at) AS first_at, MAX(at) AS last_at FROM inv_movements WHERE ${s.sql}
        AND (ref_id = ? OR (ref_type = 'sales_order' AND ref_id IN (SELECT sales_order FROM inv_so_wo WHERE wo = ? AND store = inv_movements.store)))
        GROUP BY store, ref_type, ref_id ORDER BY last_at DESC LIMIT 30`).bind(...s.args, term, term),
    T.prepare(`SELECT store, type, id, status, at, counterpart FROM inv_docs WHERE ${s.sql} AND id = ? LIMIT 30`).bind(...s.args, term),
  ]);
  await H.log(env, email, 'retrace:search', q.get('store') ? int(q.get('store')) : null, null, term);
  for (const x of labels.results) { x.now = rowNow(x)[0]; delete x.now_kind; delete x.now_at; }
  return json({ labels: labels.results, items: items.results, refs: refs.results, docs: docs.results }, 200, false);
}

async function poRoute({ env, T, email, H, m, store }) {
  const po = clean(unesc(m[2]), 40);
  if (!po) return fail(400, 'po required', false);
  const [doc, events, moves] = await T.batch([
    T.prepare("SELECT status, at, counterpart, data, need_detail, first_seen, updated_at FROM inv_docs WHERE store = ? AND type = 'po' AND id = ?").bind(store, po),
    T.prepare("SELECT at, field, old, new, by_source FROM inv_doc_events WHERE store = ? AND type = 'po' AND id = ? ORDER BY at, rowid").bind(store, po),
    T.prepare(`SELECT ${MV_COLS} FROM ${MV_FROM} WHERE m.store = ? AND m.ref_type = 'po' AND m.ref_id = ? ORDER BY m.at, m.id LIMIT 2000`).bind(store, po),
  ]);
  const d = doc.results[0] || null;
  if (!d && !moves.results.length) return fail(404, 'PO not seen at this store', false);
  const data = (d && parse(d.data)) || { id: po };
  const { lines: rawLines, labels: rawLabels, ...header } = data;
  const num = (v) => (typeof v === 'number' ? v : null);
  const lines = (rawLines || []).map((l) => Object.assign({}, l, { remaining: l.remaining != null ? l.remaining
    : num(l.ordered) != null ? Math.max(0, num(l.ordered) - (num(l.received) || 0) - (num(l.cancelled) || 0)) : null }));
  const list = rawLabels || [], now = new Map();
  for (let i = 0; i < list.length; i += 500) {
    const r = await T.prepare(`SELECT label, serial_status, wh_type, consignment, wo, sales_order, last_seen, last_history_at, ${nowCols('inv_labels')} FROM inv_labels WHERE store = ? AND label IN (SELECT value FROM json_each(?))`)
      .bind(store, JSON.stringify(list.slice(i, i + 500).map((l) => l.label))).all();
    for (const x of r.results) { x.now = rowNow(x)[0]; delete x.now_kind; delete x.now_at; now.set(x.label, x); } // now: where it stands (serial_status is Portal's raw word)
  }
  const labels = list.map((l) => Object.assign({}, l, { receive_status: l.status, now: now.get(l.label) || null }));
  await H.log(env, email, 'retrace:po', store, null, po);
  return json({ po, header: Object.assign(header, d ? { status: d.status, at: d.at, counterpart: d.counterpart, need_detail: d.need_detail, first_seen: d.first_seen, updated_at: d.updated_at } : {}),
    lines, labels, events: events.results, movements: moves.results }, 200, false);
}

async function posRoute({ T, q, s }) {
  const where = [s.sql.replace(/\bstore\b/g, 'd.store'), "d.type = 'po'"], args = [...s.args];
  const from = q.get('from') ? dayFrom(q.get('from')) : null, to = q.get('to') ? dayTo(q.get('to')) : null;
  if ((q.get('from') && !from) || (q.get('to') && !to)) return fail(400, 'from / to: YYYY-MM-DD or ISO', false);
  if (from) { where.push('d.at >= ?'); args.push(from); }
  if (to) { where.push('d.at <= ?'); args.push(to); }
  const status = clean(q.get('status'), 40);
  if (status) { where.push('d.status = ?'); args.push(status); }
  const limit = Math.min(int(q.get('limit')) || 100, 500), offset = int(q.get('offset')) || 0;
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
  return json({ pos, total: total.results[0].n }, 200, false);
}

async function coverageRoute({ T, canSee, s }) {
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
  for (const x of list) x.progress = await cachedProgress(T, x.store);
  return json({ stores: list }, 200, false);
}

// Store filter for the cross-store routes: ?store= (gated already), else the person's stores.
function scopeOf(q, me, canSee) {
  if (q.get('store')) { const st = int(q.get('store')); return st != null && canSee(st) ? { sql: 'store = ?', args: [st] } : null; }
  if (me.scope === 'all') return { sql: '1 = 1', args: [] };
  return { sql: 'store IN (SELECT value FROM json_each(?))', args: [JSON.stringify(me.stores)] };
}

/*
  The routes. re: the path. store: where the route's store comes from: 'path' (the first group), 'query' (?store=, required), or 'scope'
  for a cross-store route (scopeOf: ?store= or the person's stores, handed to the route as `s`). method(m): the method it answers to (GET
  when not given). retraceAdmin checks the method and the store before a route runs, so no route checks them again.
*/
const ROUTES = [
  { re: /^\/retrace\/verify\/(\d{1,6})(?:\/(run|tick))?$/, store: 'path', method: (m) => (m[2] ? 'POST' : 'GET'), run: verifyRoute },
  { re: /^\/retrace\/sources\/(\d{1,6})(\/set)?$/, store: 'path', method: (m) => (m[2] ? 'POST' : 'GET'), run: sourcesRoute },
  { re: /^\/retrace\/wo\/(\d{1,6})\/(\d{1,12})$/, store: 'path', run: woRoute },
  { re: /^\/retrace\/queue\/(\d{1,6})$/, store: 'path', run: queueRoute },
  { re: /^\/retrace\/item\/(\d{1,6})\/([^/]{1,80})$/, store: 'path', run: itemRoute },
  { re: /^\/retrace\/serials\/(\d{1,6})\/([^/]{1,80})$/, store: 'path', run: serialsRoute },
  { re: /^\/retrace\/label\/(\d{1,6})\/([^/]{1,80})$/, store: 'path', run: labelRoute },
  { re: /^\/retrace\/items$/, store: 'query', run: itemsRoute },
  { re: /^\/retrace\/search$/, store: 'scope', run: searchRoute },
  { re: /^\/retrace\/po\/(\d{1,6})\/([^/]{1,80})$/, store: 'path', run: poRoute },
  { re: /^\/retrace\/pos$/, store: 'scope', run: posRoute },
  { re: /^\/retrace\/coverage$/, store: 'scope', run: coverageRoute },
];

export async function retraceAdmin(req, env, url, path, me, email, H) {
  const T = env.TR, q = url.searchParams;
  const canSee = (st) => !!me && me.canSee(st);
  for (const r of ROUTES) {
    const m = path.match(r.re);
    if (!m) continue;
    if (req.method !== (r.method ? r.method(m) : 'GET')) return fail(404, 'not found', false);
    const c = { req, env, T, q, me, email, H, canSee, m };
    if (r.store === 'scope') {
      c.s = scopeOf(q, me, canSee);
      if (!c.s) return fail(403, 'not your store', false);
    } else {
      c.store = r.store === 'query' ? int(q.get('store')) : Number(m[1]);
      if (c.store == null) return fail(400, 'store required', false);
      if (!canSee(c.store)) return fail(403, 'not your store', false);
    }
    return r.run(c);
  }
  return fail(404, 'not found', false);
}
