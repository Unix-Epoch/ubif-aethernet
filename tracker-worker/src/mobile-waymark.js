/*
  Linkpearl: Waymark marks on work orders. Reads shared by mobile-wo.js (open list rows, the follow-ups filter, the detail); the phone's own
  Waymark routes (/v1/agents/m/waymark…: the tag sheet, tag on / off, push or remove a follow-up) are waymarkApi at the bottom.

  Waymark's own database (env.AE, ../worker/schema.sql). The reads:
    tags       wo_tags (store, wo, tag) joined to the store's managed list (store, name = tag) for the colour; a tag that is not in the list
               (a one-off tag) has color null. wo_tags.by_name / by_id and history.* carry staff and are never selected.
    followUp   auto_marks: due (YYYY-MM-DD, store-local) and kind (rfp | callback; NULL in old rows = rfp), only rows with removed_at IS NULL and
               only for a work order that is not in wo_closed. The same rules as the follow-up alert in mobile-alerts.js (alertsTick).
  Lookups are batched per page: one tags statement and one marks statement per store on the page (primary-key seeks, the work order numbers
  travel as one JSON parameter, so D1's bound-parameter limit never matters). A failed read is logged and answers "no marks" (never an error).
*/
import { local, addDays } from './metrics.js';
import { isDeviceStore } from './mobile-agent.js';

export const DUE_MAX = 2000;  // most due work orders read for the follow-ups filter
const TAGS_MAX = 20;          // tags returned per work order
const DAY = /^\d{4}-\d\d-\d\d$/;

export const tzOf = (env) => env.STORE_TZ || 'America/New_York';
// The store-local date (YYYY-MM-DD), the way the follow-up alert computes it (metrics.js local, one zone for every store).
export const todayOf = (env, ms = Date.now()) => local(ms, tzOf(env)).day;

const kindOf = (k) => (k === 'callback' ? 'callback' : 'rfp');

// rows: [{ store, wo, open }]. → Map "store|wo" → { tags: [{ tag, color }], followUp: { kind, due } | null }. A closed work order never has a follow-up.
export async function marksFor(env, rows) {
  const out = new Map();
  for (const r of rows) out.set(r.store + '|' + r.wo, { tags: [], followUp: null });
  if (!rows.length || !env.AE) return out;
  const by = new Map();
  for (const r of rows) { if (!by.has(r.store)) by.set(r.store, []); by.get(r.store).push(r.wo); }
  try {
    const stmts = [];
    for (const [store, wos] of by) {
      const j = JSON.stringify(wos);
      stmts.push(env.AE.prepare(`SELECT t.store, t.wo, t.tag, l.color FROM wo_tags t LEFT JOIN list l ON l.store = t.store AND l.name = t.tag
      WHERE t.store = ?1 AND t.wo IN (SELECT value FROM json_each(?2)) ORDER BY t.wo, t.at, t.tag`).bind(store, j));
      stmts.push(env.AE.prepare(`SELECT m.store, m.wo, m.due, m.kind FROM auto_marks m WHERE m.store = ?1 AND m.wo IN (SELECT value FROM json_each(?2)) AND m.removed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM wo_closed c WHERE c.store = m.store AND c.wo = m.wo)`).bind(store, j));
    }
    const res = await env.AE.batch(stmts);
    for (let i = 0; i < res.length; i += 2) {
      for (const t of res[i].results) { const e = out.get(t.store + '|' + t.wo); if (e && e.tags.length < TAGS_MAX) e.tags.push({ tag: t.tag, color: t.color || null }); }
      for (const m of res[i + 1].results) { const e = out.get(m.store + '|' + m.wo); if (e && DAY.test(m.due || '')) e.followUp = { kind: kindOf(m.kind), due: m.due }; }
    }
    for (const r of rows) if (!r.open) out.get(r.store + '|' + r.wo).followUp = null;
  } catch (e) { console.error('waymark: marks read failed:', e && e.message); }
  return out;
}

// The follow-ups due today or overdue (due <= today, store-local) in these stores, not closed: { store → [wo] } or null when Waymark could not be read.
// Whether each is still an open work order is the caller's join against the tracker's own table.
export async function dueMarks(env, stores, today) {
  if (!env.AE || !stores.length) return new Map();
  try {
    const r = (await env.AE.prepare(`SELECT m.store, m.wo FROM auto_marks m WHERE m.store IN (SELECT value FROM json_each(?1)) AND m.due <= ?2 AND m.removed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM wo_closed c WHERE c.store = m.store AND c.wo = m.wo) ORDER BY m.store, m.wo LIMIT ?3`).bind(JSON.stringify(stores), today, DUE_MAX).all()).results;
    const by = new Map();
    for (const x of r) { if (!by.has(x.store)) by.set(x.store, []); by.get(x.store).push(x.wo); }
    return by;
  } catch (e) { console.error('waymark: due read failed:', e && e.message); return null; }
}

// SQL over workorders w for "is one of these due marks": { sql, args } (args: store, JSON list of numbers, per store). Empty set = a false condition.
export function dueCond(by) {
  if (!by || !by.size) return { sql: '0 = 1', args: [] };
  const parts = [], args = [];
  for (const [s, wos] of by) { parts.push('(w.store = ? AND w.wo IN (SELECT value FROM json_each(?)))'); args.push(s, JSON.stringify(wos)); }
  return { sql: '(' + parts.join(' OR ') + ')', args };
}

/* ------------------------------------------------------------------------------------------------------------------------------------------
  Linkpearl: the phone's Waymark routes, /v1/agents/m/waymark… (contract in MOBILE-API-waymark.md).

    GET  /waymark/tags?store=<id>                         the store's managed tag list for the tag sheet: [{ name, color }] in list order
    POST /waymark/tag       { store, wo, tag, on }        put a tag on a work order (on: true) or take it off (on: false)
    POST /waymark/followup  { store, wo, due }            move the follow-up later (never earlier)
    POST /waymark/followup  { store, wo, remove: true }   remove it for good (the row stays with removed_at, as the userscript's ×)

  The writes are the Waymark Worker's own (worker/src/index.js routes /wo/:wo/tag, /untag, /push, /unmark): the same statements on the same
  tables, the same history rows (action add | remove | push | unmark; detail null | "old → new" | the old due) and the same limits (tag text
  cleaned and cut to 32 characters, at most 12 tags on a work order, one-off tags allowed as for everyone in Portal, follow-ups only later,
  a removed one stays removed). Differences, all stricter:
    - the author is the phone ("Linkpearl (<device name>)", by_id NULL), never a staff name sent from the phone (a body `by` is ignored);
    - the store must be one of the phone's approved stores AND have Aethernet access (Waymark's store_access, as its Worker checks);
    - the work order must be one the tracker holds (`workorders`); open for adding a tag and for any follow-up change (taking a tag off a
      closed one is allowed, adding one would cancel Waymark's 7-day cleanup of a closed order);
    - a push is a compare-and-set on the old date (409 when it moved meanwhile); a due date more than a year after today is refused;
    - a tag typed with other capitals than a managed tag is that managed tag.
  A phone never CREATES a follow-up: Waymark makes them only from Portal statuses (Auto-Waymark, author "Auto-Waymark") and has no manual
  "add" anywhere, so a work order without an open follow-up answers 404 as the Worker's /push does.
  Every accepted write is also in the tracker's access_log (actor "device:<name>", action waymark:tag | waymark:untag | waymark:push |
  waymark:unmark), which is also the per-phone bound: WRITES_PER_HOUR accepted writes an hour, then 429.
  Portal's device nickname is not touched (this Worker cannot reach Portal): the userscript's 10-minute scan rewrites a marked work order's
  nickname to the mark's date (planScan's rename), so a phone push shows in Portal at the next scan of any open Portal tab.
------------------------------------------------------------------------------------------------------------------------------------------ */
const MAX_TAGS_PER_WO = 12, TAG_LEN = 32;     // worker/src/index.js MAX_TAGS_PER_WO, tagName
const LIST_MAX = 40;                          // worker/src/index.js MAX_LIST
export const WRITES_PER_HOUR = 120;           // accepted Waymark writes per phone per hour
const AHEAD_DAYS = 366;                       // a follow-up at most this far after today (store-local)
const WO_MIN = 10000, WO_MAX = 999999999999;  // the Waymark Worker's /wo/(\d{5,12})

const fail = (status, message) => Object.assign(new Error(message), { status });
// The Waymark Worker's tagName: control characters out, whitespace collapsed, trimmed, cut to 32.
const tagName = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, TAG_LEN) : '');
const author = (device) => ({ name: ('Linkpearl (' + device.name + ')').slice(0, 60), id: null });
const actor = (device) => 'device:' + device.name;
const realDay = (d) => DAY.test(d) && !isNaN(Date.parse(d + 'T12:00:00Z')) && new Date(d + 'T12:00:00Z').toISOString().slice(0, 10) === d;
const nowIso = () => new Date().toISOString();

// The Waymark Worker's logHistory, statement for statement.
const history = (env, store, wo, action, tag, detail, by) => env.AE.prepare('INSERT INTO history (store, wo, action, tag, detail, by_name, by_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  .bind(store, wo, action, tag, detail, by.name, by.id, nowIso()).run();

// store: an approved store of this phone that has Aethernet access. Throws 400 / 403.
async function storeOf(env, device, h, v) {
  const store = h.int(v);
  if (store == null || store < 1 || store > 999999) throw fail(400, 'store required');
  if (!isDeviceStore(device, store)) throw fail(403, 'not your store');
  if (!(await env.AE.prepare('SELECT 1 FROM store_access WHERE store = ?').bind(store).first())) throw fail(403, 'this store does not have access to Aethernet');
  return store;
}
// wo: a work order the tracker holds in that store → { wo, open }. Throws 400 / 404.
async function woOf(env, h, store, v) {
  const wo = h.int(v);
  if (wo == null || wo < WO_MIN || wo > WO_MAX) throw fail(400, 'wo required');
  const r = await env.TR.prepare('SELECT is_open FROM workorders WHERE store = ? AND wo = ?').bind(store, wo).first();
  if (!r) throw fail(404, 'no such work order');
  return { wo, open: r.is_open === 1 };
}
// The per-phone bound, counted from the access_log rows these routes write (log_at index: one hour of the log).
async function bound(env, device) {
  const since = new Date(Date.now() - 3600000).toISOString();
  const { n } = await env.TR.prepare("SELECT COUNT(*) AS n FROM access_log WHERE at >= ? AND email = ? AND action LIKE 'waymark:%'").bind(since, actor(device)).first();
  if (n >= WRITES_PER_HOUR) throw fail(429, 'too many Waymark changes from this phone, try again later');
}
// The work order's tags as the phone's other routes show them: [{ tag, color }] (colour from the managed list; one-off = null). No authors.
async function tagsOf(env, store, wo) {
  const r = await env.AE.prepare('SELECT t.tag, l.color FROM wo_tags t LEFT JOIN list l ON l.store = t.store AND l.name = t.tag WHERE t.store = ? AND t.wo = ? ORDER BY t.at, t.tag').bind(store, wo).all();
  return r.results.map((x) => ({ tag: x.tag, color: x.color || null }));
}
const managed = async (env, store) => (await env.AE.prepare('SELECT name, color FROM list WHERE store = ? ORDER BY pos LIMIT ?').bind(store, LIST_MAX).all()).results;

export async function waymarkApi(req, env, url, device, h) {
  const path = url.pathname.replace(/^\/v1\/agents\/m\/waymark/, '') || '/';
  if (path !== '/tags' && path !== '/tag' && path !== '/followup') return h.fail(404, 'not found');
  if (req.method !== (path === '/tags' ? 'GET' : 'POST')) return h.fail(405, 'method not allowed');
  if (!env.AE) return h.fail(503, 'Waymark is not available');
  try {
    if (path === '/tags') {
      const store = await storeOf(env, device, h, url.searchParams.get('store'));
      const list = await managed(env, store);
      return h.json({ v: 1, store, tags: list.map((t) => ({ name: t.name, color: t.color || null })), oneOff: true, maxTags: MAX_TAGS_PER_WO, maxLength: TAG_LEN });
    }
    const b = await h.readJson(req, 2000);
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw fail(400, 'bad JSON');
    const store = await storeOf(env, device, h, b.store);
    const { wo, open } = await woOf(env, h, store, b.wo);
    await bound(env, device);
    const by = author(device);
    return h.json(path === '/tag' ? await setTag(env, h, device, by, store, wo, open, b) : await followUp(env, h, device, by, store, wo, open, b));
  } catch (e) {
    if (e && e.status && e.status < 500) return h.fail(e.status, e.message);
    throw e;
  }
}

// POST /tag { store, wo, tag, on } → { ok, store, wo, tag, on, changed, tags }
async function setTag(env, h, device, by, store, wo, open, b) {
  if (typeof b.on !== 'boolean') throw fail(400, 'on: true or false');
  let tag = tagName(b.tag);
  if (!tag) throw fail(400, 'tag required');
  let changed;
  if (b.on) {
    if (!open) throw fail(409, 'work order is closed');
    const same = (await managed(env, store)).find((t) => t.name.toLowerCase() === tag.toLowerCase());
    if (same) tag = same.name; // the phone's keyboard capitalises: "priority" is the store's "Priority", not a one-off
    const [{ n }, has] = await Promise.all([
      env.AE.prepare('SELECT COUNT(*) AS n FROM wo_tags WHERE store = ? AND wo = ?').bind(store, wo).first(),
      env.AE.prepare('SELECT 1 FROM wo_tags WHERE store = ? AND wo = ? AND tag = ?').bind(store, wo, tag).first(),
    ]);
    if (!has && n >= MAX_TAGS_PER_WO) throw fail(400, 'too many tags on this work order');
    const r = await env.AE.prepare('INSERT OR IGNORE INTO wo_tags (store, wo, tag, by_name, by_id, at) VALUES (?, ?, ?, ?, ?, ?)').bind(store, wo, tag, by.name, by.id, nowIso()).run();
    changed = !!r.meta.changes;
    if (changed) await history(env, store, wo, 'add', tag, null, by);
    await env.AE.prepare('DELETE FROM wo_closed WHERE store = ? AND wo = ?').bind(store, wo).run(); // tagged again = still in play (as the Worker does)
  } else {
    const r = await env.AE.prepare('DELETE FROM wo_tags WHERE store = ? AND wo = ? AND tag = ?').bind(store, wo, tag).run();
    changed = !!r.meta.changes;
    if (changed) await history(env, store, wo, 'remove', tag, null, by);
  }
  await h.log(env, actor(device), b.on ? 'waymark:tag' : 'waymark:untag', store, wo, tag + (changed ? '' : ' (no change)') + ' ' + device.id.slice(0, 8));
  return { ok: true, store, wo, tag, on: b.on, changed, tags: await tagsOf(env, store, wo) };
}

// POST /followup { store, wo, due } | { store, wo, remove: true } → { ok, store, wo, followUp: { kind, due } | null }
async function followUp(env, h, device, by, store, wo, open, b) {
  if (b.remove != null && typeof b.remove !== 'boolean') throw fail(400, 'remove: true');
  const remove = b.remove === true;
  if (remove === (b.due != null)) throw fail(400, 'due or remove: true (one of them)');
  if (!open) throw fail(409, 'work order is closed');
  const cur = await env.AE.prepare('SELECT due, kind FROM auto_marks WHERE store = ? AND wo = ? AND removed_at IS NULL').bind(store, wo).first();
  if (!cur) throw fail(404, 'no follow-up on this work order');
  if (remove) {
    const r = await env.AE.prepare('UPDATE auto_marks SET removed_at = ? WHERE store = ? AND wo = ? AND removed_at IS NULL').bind(nowIso(), store, wo).run();
    if (!r.meta.changes) throw fail(404, 'no follow-up on this work order');
    await history(env, store, wo, 'unmark', null, cur.due, by);
    await h.log(env, actor(device), 'waymark:unmark', store, wo, cur.due + ' ' + device.id.slice(0, 8));
    return { ok: true, store, wo, followUp: null };
  }
  const due = typeof b.due === 'string' ? b.due : '';
  if (!realDay(due)) throw fail(400, 'due: YYYY-MM-DD');
  if (due <= cur.due) throw fail(400, 'follow-ups can only move later');
  if (due > addDays(todayOf(env), AHEAD_DAYS)) throw fail(400, 'due: at most a year ahead');
  const r = await env.AE.prepare('UPDATE auto_marks SET due = ? WHERE store = ? AND wo = ? AND due = ? AND removed_at IS NULL').bind(due, store, wo, cur.due).run();
  if (!r.meta.changes) throw fail(409, 'the follow-up changed meanwhile, reload it');
  await history(env, store, wo, 'push', null, cur.due + ' → ' + due, by);
  await h.log(env, actor(device), 'waymark:push', store, wo, cur.due + ' -> ' + due + ' ' + device.id.slice(0, 8));
  return { ok: true, store, wo, followUp: { kind: kindOf(cur.kind), due } };
}

