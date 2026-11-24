/*
  Item source (Nov 24, 2026): every Mobility and Reportable Consumables item is Distro, MS (MobileSentrix) or Other, so order
  recommendations and reorder levels can split their lists. One answer per item number, shared by every store: an item number only
  ever comes from one source, so evidence that disagrees is a Conflict, never a mix.

  The rules, first match wins (decide):
    1. manual: set by hand on the admin site (inv_item_source.manual). Never overwritten by the rules.
    2. vendor: Portal's Vendor on the item's labels, any store (inv_labels.vendor). "1" Distro, "6920" MS, any other account Other.
       Captured live at 914, Nov 24, 2026 (label details of 688939-0000000663 and 771985-0010000003). Only account numbers count:
       a vendor that isn't one (a name) says nothing.
    3. po: the POs the item was on, any store (inv_docs type 'po': info.distro = Portal's IsDistro, info.vendor = OrderVendorAccountNumber).
       IsDistro true is Distro; false is "not Distro", made MS / Other by the PO's vendor account when it is one.
    4. name: "MS" as a whole word in the item name (MobileSentrix parts are named so) is MS.
    5. nothing: Not set.
  Every source the evidence names is collected; two different ones (or "not Distro" next to Distro) = Conflict.

  Pause: a store whose in-scope items aren't all marked (Not set or Conflict, unless set by hand) has its ordering paused
  (inv_source_pause). The first time it pauses, the store's Linkpearl phones get one push; it clears when the last item is marked.
*/
import { sendPush } from './push.js';
import { IGNORED_ITEMS } from './retrace.js';

export const SOURCES = ['distro', 'ms', 'other'];
export const VENDOR_SOURCE = { 1: 'distro', 6920: 'ms' };
export const IN_SCOPE = /^\s*(mobility|reportable consumables?)\s*$/i;
const MS_WORD = /(^|[^A-Za-z0-9])MS([^A-Za-z0-9]|$)/; // "MS" in capitals, alone: "iPhone 16 Pro Max Glass/LCD MS", "(MS)"; never "MSRP"
const ACCOUNT = /^\d{1,10}$/;
export const REFRESH_MS = 10 * 60000;   // a sweep refreshes a store's sources at most this often
export const VENDOR_ASK_CAP = 300;

export const vendorSource = (v) => {
  const s = v == null ? '' : String(v).trim();
  if (!ACCOUNT.test(s)) return null;
  return VENDOR_SOURCE[Number(s)] || 'other';
};
export const msName = (name) => MS_WORD.test(String(name || ''));

/*
  One item's evidence → { auto: distro|ms|other|null, basis: vendor|po|name|null, conflict, evidence }.
  vendors: [{ vendor, n }] (its labels' Vendor, any store) · pos: [{ id, distro: true|false|null, vendor }] · name: the item's name.
*/
export function decide({ name, vendors = [], pos = [] }) {
  const fromVendor = new Set(), fromPo = new Set();
  let notDistro = false;
  for (const v of vendors) { const s = vendorSource(v.vendor); if (s) fromVendor.add(s); }
  for (const p of pos) {
    const d = p.distro === true || p.distro === 1 || p.distro === 'true' ? true : p.distro === false || p.distro === 0 || p.distro === 'false' ? false : null;
    if (d === true) fromPo.add('distro');
    else if (d === false) { const s = vendorSource(p.vendor); if (s && s !== 'distro') fromPo.add(s); else notDistro = true; }
  }
  const ms = msName(name);
  const all = new Set([...fromVendor, ...fromPo, ...(ms ? ['ms'] : [])]);
  const conflict = all.size > 1 || (notDistro && all.has('distro'));
  const evidence = { vendors: vendors.filter((v) => v.vendor != null).slice(0, 10).map((v) => ({ vendor: String(v.vendor), n: v.n })),
    pos: pos.slice(0, 10).map((p) => ({ id: p.id, distro: p.distro == null ? null : !!(p.distro === true || p.distro === 1 || p.distro === 'true'), vendor: p.vendor == null ? null : String(p.vendor) })), ms };
  if (conflict || !all.size) return { auto: null, basis: null, conflict, evidence };
  const auto = [...all][0];
  const basis = fromVendor.size ? 'vendor' : fromPo.size ? 'po' : 'name';
  return { auto, basis, conflict: false, evidence };
}

// The source an item shows: by hand, else the rules; 'conflict' / 'unset' when neither gives one.
export const effective = (row) => (row && row.manual) || (row && row.conflict ? 'conflict' : (row && row.auto) || 'unset');

const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch (_) { return null; } };
const inJson = (list) => JSON.stringify([...new Set(list)]);

// The store's in-scope items: its stock lookup items (inv_items) in Mobility or Reportable Consumables, never BB0001.
async function scopeItems(T, store) {
  const r = await T.prepare('SELECT item, name, category FROM inv_items WHERE store = ? AND category IS NOT NULL').bind(store).all();
  return r.results.filter((x) => IN_SCOPE.test(x.category) && !IGNORED_ITEMS.includes(String(x.item).toLowerCase()));
}

/*
  Works out the rules for the store's in-scope items (or `only` those items), writes what changed, then the store's pause.
  → { scope, unmarked, paused, newlyPaused }
*/
export async function refreshSources(T, env, store, at, { only = null, push = true } = {}) {
  const scope = await scopeItems(T, store);
  const items = only ? scope.filter((x) => only.includes(String(x.item))) : scope;
  if (items.length) {
    const list = items.map((x) => String(x.item)), changes = [];
    for (let i = 0; i < list.length; i += 400) {
      const part = list.slice(i, i + 400), j = inJson(part);
      const [vend, pos, rows] = await T.batch([
        T.prepare('SELECT item, vendor, COUNT(*) AS n FROM inv_labels WHERE vendor IS NOT NULL AND item IN (SELECT value FROM json_each(?)) GROUP BY item, vendor').bind(j),
        T.prepare(`SELECT DISTINCT json_extract(l.value, '$.item') AS item, d.id, json_extract(d.data, '$.info.distro') AS distro, json_extract(d.data, '$.info.vendor') AS vendor
            FROM inv_docs d, json_each(d.data, '$.lines') l WHERE d.type = 'po' AND json_extract(l.value, '$.item') IN (SELECT value FROM json_each(?))`).bind(j),
        T.prepare('SELECT item, auto, auto_basis, conflict, evidence FROM inv_item_source WHERE item IN (SELECT value FROM json_each(?))').bind(j),
      ]);
      const by = (rs) => { const m = new Map(); for (const r of rs) { const k = String(r.item); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
      const V = by(vend.results), P = by(pos.results), K = new Map(rows.results.map((r) => [String(r.item), r]));
      for (const x of items.filter((y) => part.includes(String(y.item)))) {
        const k = String(x.item), d = decide({ name: x.name, vendors: V.get(k) || [], pos: P.get(k) || [] }), was = K.get(k), ev = JSON.stringify(d.evidence);
        if (was && was.auto === d.auto && was.auto_basis === d.basis && !!was.conflict === d.conflict && was.evidence === ev) continue;
        changes.push(T.prepare(`INSERT INTO inv_item_source (item, auto, auto_basis, conflict, evidence, auto_at) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (item) DO UPDATE SET auto = excluded.auto, auto_basis = excluded.auto_basis, conflict = excluded.conflict, evidence = excluded.evidence, auto_at = excluded.auto_at`)
          .bind(k, d.auto, d.basis, d.conflict ? 1 : 0, ev, at));
      }
    }
    for (let i = 0; i < changes.length; i += 100) await T.batch(changes.slice(i, i + 100));
  }
  return pauseCheck(T, env, store, at, scope, push);
}

// The store's pause, from its in-scope items' sources now. Pushes once per pause.
async function pauseCheck(T, env, store, at, scope, push) {
  const list = scope.map((x) => String(x.item));
  let unmarked = 0;
  for (let i = 0; i < list.length; i += 400) {
    const part = list.slice(i, i + 400);
    const rows = new Map((await T.prepare('SELECT item, manual, auto, conflict FROM inv_item_source WHERE item IN (SELECT value FROM json_each(?))').bind(inJson(part)).all()).results.map((r) => [String(r.item), r]));
    for (const k of part) { const e = effective(rows.get(k)); if (e === 'unset' || e === 'conflict') unmarked++; }
  }
  const was = await T.prepare('SELECT paused_at, pushed_at FROM inv_source_pause WHERE store = ?').bind(store).first();
  const paused = unmarked > 0, newlyPaused = paused && !(was && was.paused_at);
  await T.prepare(`INSERT INTO inv_source_pause (store, unmarked, paused_at, pushed_at, checked_at) VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT (store) DO UPDATE SET unmarked = excluded.unmarked, paused_at = excluded.paused_at, pushed_at = excluded.pushed_at, checked_at = excluded.checked_at`)
    .bind(store, unmarked, paused ? (was && was.paused_at) || at : null, paused ? (was && was.pushed_at) || null : null, at).run();
  if (newlyPaused && push && env) {
    const sent = await pushPause(env, store, unmarked, at);
    if (sent) await T.prepare('UPDATE inv_source_pause SET pushed_at = ? WHERE store = ?').bind(at, store).run();
  }
  return { scope: scope.length, unmarked, paused, newlyPaused };
}

/*
  The pause push: to every approved Linkpearl phone with the store (agents.stores), one each. Data only on Android (Linkpearl's
  PushCenter shows "Ordering paused" / "<store> · <n> items not marked"); the alert is iOS's. → how many were sent.
*/
export async function pushPause(env, store, n, at, send = sendPush) {
  let agents = [];
  try {
    agents = (await env.TR.prepare("SELECT a.id FROM agents a WHERE a.status = 'active' AND EXISTS (SELECT 1 FROM json_each(a.stores) s WHERE CAST(s.value AS INTEGER) = ?)").bind(store).all()).results;
  } catch (_) { return 0; }
  const id = 'rs' + store + '-' + Date.parse(at).toString(36);
  const text = store + ' · ' + n + (n === 1 ? ' item' : ' items') + ' not marked';
  let sent = 0;
  for (const a of agents) if ((await send(env, a.id, { t: 'retrace', kind: 'source.paused', id, store: String(store), n: String(n) }, { title: 'Ordering paused', body: text })) === 'sent') sent++;
  return sent;
}

// After the sweep: at most every REFRESH_MS per store (inv_cursors 'source_refresh'). Never fails the sweep.
export async function sweepRefresh(T, env, store, at) {
  try {
    const c = await T.prepare("SELECT updated_at FROM inv_cursors WHERE store = ? AND sweep = 'source_refresh'").bind(store).first();
    if (c && Date.parse(at) - Date.parse(c.updated_at) < REFRESH_MS) return null;
    await T.prepare("INSERT INTO inv_cursors (store, sweep, value, updated_at) VALUES (?, 'source_refresh', '{}', ?) ON CONFLICT (store, sweep) DO UPDATE SET updated_at = excluded.updated_at").bind(store, at).run();
    return await refreshSources(T, env, store, at);
  } catch (e) { console.error('retrace source refresh:', e && e.message); return null; }
}

/*
  The vendor catch-up: the store's in-scope items with labels stored here and none carrying a vendor yet (labels stored before the
  vendor was kept). The browser reads their label lists. Most-labelled first. → [item]
*/
export async function vendorNeed(T, store, want) {
  if (!want) return [];
  const scope = await scopeItems(T, store);
  if (!scope.length) return [];
  const r = await T.prepare(`SELECT item FROM inv_labels WHERE store = ?1 AND item IN (SELECT value FROM json_each(?2))
      GROUP BY item HAVING COUNT(vendor) = 0 ORDER BY COUNT(*) DESC, item LIMIT ?3`).bind(store, inJson(scope.map((x) => String(x.item))), Math.min(want, VENDOR_ASK_CAP)).all();
  return r.results.map((x) => String(x.item));
}

/*
  The admin page's view: { store, counts: { all, distro, ms, other, unset, conflict }, pause: { paused, unmarked, paused_at },
  items: [{ item, name, category, on_hand, source, basis, manual, evidence }] } · source filter: all | distro | ms | other | unset | conflict
  (unmarked = unset and conflict together). Sorted: unmarked first, then by name.
*/
export async function sourcesView(T, store, filter = 'all', { limit = 500, offset = 0 } = {}) {
  const scope = await scopeItems(T, store);
  const list = scope.map((x) => String(x.item)), rows = new Map(), qty = new Map();
  for (let i = 0; i < list.length; i += 400) {
    const j = inJson(list.slice(i, i + 400));
    const [s, q] = await T.batch([
      T.prepare('SELECT item, manual, manual_by, manual_at, auto, auto_basis, conflict, evidence FROM inv_item_source WHERE item IN (SELECT value FROM json_each(?))').bind(j),
      T.prepare('SELECT item, qty FROM inv_items WHERE store = ? AND item IN (SELECT value FROM json_each(?))').bind(store, j),
    ]);
    for (const r of s.results) rows.set(String(r.item), r);
    for (const r of q.results) { const o = parse(r.qty) || {}; qty.set(String(r.item), Object.values(o).reduce((a, w) => a + (Number(w && w.onHand) || 0), 0)); }
  }
  const counts = { all: 0, distro: 0, ms: 0, other: 0, unset: 0, conflict: 0 };
  const all = scope.map((x) => {
    const k = String(x.item), r = rows.get(k), source = effective(r);
    counts.all++; counts[source]++;
    return { item: k, name: x.name || null, category: x.category, on_hand: qty.has(k) ? qty.get(k) : null, source, basis: r && r.manual ? 'manual' : (r && r.auto_basis) || null,
      manual: (r && r.manual) || null, manual_by: (r && r.manual_by) || null, auto: (r && r.auto) || null, conflict: !!(r && r.conflict), evidence: r ? parse(r.evidence) : null };
  });
  const rank = (s) => (s === 'conflict' ? 0 : s === 'unset' ? 1 : 2);
  const shown = (filter === 'all' ? all : filter === 'unmarked' ? all.filter((x) => rank(x.source) < 2) : all.filter((x) => x.source === filter))
    .sort((a, b) => rank(a.source) - rank(b.source) || String(a.name || a.item).localeCompare(String(b.name || b.item)));
  const p = await T.prepare('SELECT unmarked, paused_at FROM inv_source_pause WHERE store = ?').bind(store).first();
  const unmarked = counts.unset + counts.conflict;
  return { store, counts, total: shown.length, pause: { paused: unmarked > 0, unmarked, paused_at: (p && p.paused_at) || null }, items: shown.slice(offset, offset + limit) };
}

// One item's source for the item view: { source, basis, manual, auto, conflict, evidence } (source 'unset' when nothing is stored).
export async function itemSource(T, item) {
  const r = await T.prepare('SELECT manual, manual_by, manual_at, auto, auto_basis, conflict, evidence FROM inv_item_source WHERE item = ?').bind(String(item)).first();
  return { source: effective(r), basis: r && r.manual ? 'manual' : (r && r.auto_basis) || null, manual: (r && r.manual) || null, manual_by: (r && r.manual_by) || null,
    auto: (r && r.auto) || null, conflict: !!(r && r.conflict), evidence: r ? parse(r.evidence) : null };
}

/*
  Set (source distro|ms|other) or reset (source null) items by hand. Then every store holding them re-checks its pause (no push: a person
  just changed it). → { changed, stores: [{ store, unmarked, paused }] }
*/
export async function setSources(T, env, items, source, by, at) {
  const list = [...new Set(items.map(String))];
  const stmts = list.map((k) => (source
    ? T.prepare(`INSERT INTO inv_item_source (item, manual, manual_by, manual_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (item) DO UPDATE SET manual = excluded.manual, manual_by = excluded.manual_by, manual_at = excluded.manual_at`).bind(k, source, by, at)
    : T.prepare('UPDATE inv_item_source SET manual = NULL, manual_by = NULL, manual_at = NULL WHERE item = ?').bind(k)));
  for (let i = 0; i < stmts.length; i += 100) await T.batch(stmts.slice(i, i + 100));
  const stores = (await T.prepare('SELECT DISTINCT store FROM inv_items WHERE item IN (SELECT value FROM json_each(?))').bind(inJson(list)).all()).results.map((r) => r.store);
  const out = [];
  for (const st of stores) { const r = await refreshSources(T, env, st, at, { only: list, push: false }); out.push({ store: st, unmarked: r.unmarked, paused: r.paused }); }
  return { changed: list.length, stores: out };
}
