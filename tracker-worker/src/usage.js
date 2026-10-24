/*
  Cloudflare and Portal load (Oct 24, 2026): what Aethernet's own Workers cost, counted by the Workers themselves,
  for the top of the admin site's Usage page. Cloudflare's dashboard stays the billing source; this is for spotting growth early.

  Counted: every request to the tracker Worker (src/index.js) and the admin site (admin-worker/), by area, with the D1
  rows each one read and wrote and the tracker database's size. NOT counted: the Waymark Worker (worker/, its own
  Worker and database: tags, sheets and the Waymark/usage routes stores call), and the counter's own few writes.

  How: meter() wraps the D1 bindings (TR, AE, DB) for one request. Each D1 result carries meta.rows_read / rows_written /
  size_after; the wrapper adds them to a request-scoped counter. first() has no meta in D1, so the wrapper runs the same
  statement through all() and takes the first row (every first() in the code reads one row or an aggregate). At the end of
  the request the counter goes into an in-memory total for the isolate; the total is written with ONE batch of upserts every
  FLUSH_MS (ctx.waitUntil), so the overhead is a couple of D1 writes per window however many requests came, not one per
  request. A flush that fails puts its counts back and tries next time; counting never fails or slows a request (the
  isolate can be evicted with up to a window of counts unwritten: a small undercount, never an overcount).
  Days are UTC, like Cloudflare's.

  Tables (migrations/2026-10-24-usage-load.sql): usage_load (day, area), usage_size (day), usage_pass (day, store: Retrace
  pass stats the collector posts at the end of a pass), usage_browsers (day, store, browser).
*/
export const AREAS = ['collector', 'retrace_admin', 'tracker', 'other'];
export const AREA_NAMES = { collector: 'Retrace collector (store browsers)', retrace_admin: 'Retrace admin pages (coverage, verify, queue)', tracker: 'Work order tracker', other: 'Other tracker and admin routes' };
const FLUSH_MS = 20000;   // under waitUntil's 30 s
const KEEP_DAYS = 400;
const NATIVE = Symbol('native statement');
const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

// The area of a request, from its path as the Worker sees it (store browsers → /v1/…; the admin site → /api/… and its scripts).
export function areaOf(pathname) {
  if (/^\/v1\/\d{1,6}\/tracker\/retrace\//.test(pathname)) return 'collector';
  if (/^\/api\/tracker\/retrace\//.test(pathname) || pathname === '/retrace-ui.js') return 'retrace_admin';
  if (/^\/v1\/(\d{1,6}\/tracker|tracker|agents)\//.test(pathname) || /^\/api\/tracker\//.test(pathname)) return 'tracker';
  return 'other';
}
// Reading the numbers shouldn't move them.
const skips = (pathname) => pathname === '/api/tracker/usage-load';

// A D1 binding that adds each result's meta to `c`. Same surface the code uses: prepare().bind().first/all/run, batch.
export function wrapDb(db, c, main) {
  const add = (r) => {
    const m = r && r.meta;
    if (m) { c.read += Number(m.rows_read) || 0; c.written += Number(m.rows_written) || 0; if (main && m.size_after != null) c.size = Number(m.size_after) || c.size; }
    return r;
  };
  const stmt = (st) => ({
    [NATIVE]: st,
    bind: (...a) => stmt(st.bind(...a)),
    all: async () => add(await st.all()),
    run: async () => add(await st.run()),
    first: async (col) => { const row = (add(await st.all()).results || [])[0]; return row == null ? null : col === undefined ? row : row[col]; },
    raw: (...a) => st.raw(...a),
  });
  return {
    prepare: (sql) => stmt(db.prepare(sql)),
    batch: async (list) => (await db.batch(list.map((s) => s[NATIVE] || s))).map((r) => add(r)),
    exec: (...a) => db.exec(...a),
  };
}

// In-memory totals for this isolate: 'day|area' → { requests, read, written }, the newest database size, the flush timer.
const total = new Map();
let size = null, scheduledAt = 0;

function merge(into, from) {
  for (const [k, v] of from) {
    const e = into.get(k) || into.set(k, { requests: 0, read: 0, written: 0 }).get(k);
    e.requests += v.requests; e.read += v.read; e.written += v.written;
  }
}

export async function flush(db) {
  if (!total.size && !size) return;
  const take = new Map(total), sz = size;
  total.clear(); size = null;
  try {
    const stmts = [];
    for (const [k, v] of take) {
      const [day, area] = k.split('|');
      stmts.push(db.prepare(`INSERT INTO usage_load (day, area, requests, rows_read, rows_written) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (day, area) DO UPDATE SET requests = requests + excluded.requests, rows_read = rows_read + excluded.rows_read, rows_written = rows_written + excluded.rows_written`)
        .bind(day, area, v.requests, v.read, v.written));
    }
    if (sz) stmts.push(db.prepare('INSERT INTO usage_size (day, bytes) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET bytes = excluded.bytes').bind(sz.day, sz.bytes));
    await db.batch(stmts);
  } catch (e) {
    merge(total, take); if (sz && !size) size = sz;     // try again with the next window
    console.warn('usage counter flush failed: ' + ((e && e.message) || e));
  }
}

/*
  One request: `const m = meter(env, req); … handler(m.env) … await m.done(ctx)`. m.env has the D1 bindings wrapped.
  Without a TR binding there's nothing to count into and env comes back as it was.
*/
export function meter(env, req) {
  try {
    const path = new URL(req.url).pathname;
    if (!env || !env.TR || skips(path)) return { env, done: async () => {} };
    const c = { read: 0, written: 0, size: null }, wrapped = Object.assign({}, env);
    for (const k of ['TR', 'AE', 'DB']) if (env[k] && typeof env[k].prepare === 'function') wrapped[k] = wrapDb(env[k], c, k === 'TR');
    const area = areaOf(path), raw = env.TR;
    return {
      env: wrapped,
      async done(ctx) {
        try {
          const day = utcDay(), k = day + '|' + area;
          merge(total, new Map([[k, { requests: 1, read: c.read, written: c.written }]]));
          if (c.size != null) size = { day, bytes: c.size };
          const ms = env.USAGE_FLUSH_MS == null ? FLUSH_MS : Number(env.USAGE_FLUSH_MS);
          if (!ms || !ctx || typeof ctx.waitUntil !== 'function') return await flush(raw);   // no background: write now (tests, scripts)
          if (Date.now() - scheduledAt < ms + 15000) return;                                  // a flush is already due (a stale mark, from a cancelled one, expires)
          scheduledAt = Date.now();
          ctx.waitUntil(new Promise((r) => setTimeout(r, ms)).then(() => flush(raw)).catch(() => {}).finally(() => { scheduledAt = 0; }));
        } catch (_) { /* counting never fails a request */ }
      },
    };
  } catch (_) { return { env, done: async () => {} }; }
}

// Daily cron: the counters older than KEEP_DAYS go.
export async function pruneUsage(env) {
  const cut = utcDay(Date.now() - KEEP_DAYS * 86400000);
  await env.TR.batch(['usage_load', 'usage_size', 'usage_pass', 'usage_browsers'].map((t) => env.TR.prepare(`DELETE FROM ${t} WHERE day < ?`).bind(cut)));
}

// ------------------------------------------------------------------ Retrace pass stats (POST …/retrace/pass)
const nat = (v, max) => (Number.isInteger(v) && v >= 0 && v <= max ? v : null);
// The collector's summary of one finished pass: { by, browser, portalCalls, workerCalls, seconds, lookupSeconds? }. → statements, or null when it isn't one.
export function passStmts(T, store, b, day = utcDay()) {
  const portal = nat(b.portalCalls, 200000), worker = nat(b.workerCalls, 200000), seconds = nat(b.seconds, 86400);
  if (portal == null || worker == null || seconds == null) return null;
  const lookup = b.lookupSeconds == null ? null : nat(b.lookupSeconds, 86400);
  const stmts = [T.prepare(`INSERT INTO usage_pass (day, store, passes, portal_calls, worker_calls, seconds, lookup_passes, lookup_seconds) VALUES (?, ?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT (day, store) DO UPDATE SET passes = passes + 1, portal_calls = portal_calls + excluded.portal_calls, worker_calls = worker_calls + excluded.worker_calls, seconds = seconds + excluded.seconds,
        lookup_passes = lookup_passes + excluded.lookup_passes, lookup_seconds = lookup_seconds + excluded.lookup_seconds`)
    .bind(day, store, portal, worker, seconds, lookup == null ? 0 : 1, lookup || 0)];
  const browser = typeof b.browser === 'string' && /^[A-Za-z0-9-]{4,36}$/.test(b.browser) ? b.browser : null;
  if (browser) stmts.push(T.prepare('INSERT OR IGNORE INTO usage_browsers (day, store, browser) VALUES (?, ?, ?)').bind(day, store, browser));
  return stmts;
}

// ------------------------------------------------------------------ the admin read (GET /api/tracker/usage-load)
const addDays = (day, n) => utcDay(Date.parse(day + 'T00:00:00Z') + n * 86400000);
const MONTH = 30;

/*
  The section's data. `me` = the caller's access: everyone with page 'usage' gets the Retrace stores they can see; only
  all-stores access gets the Worker-wide totals (global, null otherwise).
  { today, since, firstDay (first day counted, null = nothing yet), scope,
    global: { days: [{ day, requests, rows_read, rows_written, bytes }] (30 days, null before firstDay), month: { requests, rows_read, rows_written },
              areas: [{ area, name, today, requests, rows_read, rows_written }], bytes, projection } | null,
    stores: [{ store, name, labels, passes, portalPerPass, workerPerPass, avgSeconds, lookupPasses, lookupSeconds, browsers }] }  (passes: last 7 days)
*/
export async function usageLoad(env, me, now = Date.now()) {
  const T = env.TR, today = utcDay(now), since = addDays(today, -(MONTH - 1)), monthStart = today.slice(0, 8) + '01', from = monthStart < since ? monthStart : since;
  const wide = !me || me.scope === 'all' || me.owner, passFrom = addDays(today, -6);
  const [load, sizes, pass, browsers, labels] = await T.batch([
    T.prepare('SELECT day, area, requests, rows_read, rows_written FROM usage_load WHERE day >= ? ORDER BY day').bind(from),
    T.prepare('SELECT day, bytes FROM usage_size WHERE day >= ? ORDER BY day').bind(since),
    T.prepare('SELECT store, SUM(passes) AS passes, SUM(portal_calls) AS portal, SUM(worker_calls) AS worker, SUM(seconds) AS seconds, SUM(lookup_passes) AS lookup_passes, SUM(lookup_seconds) AS lookup_seconds FROM usage_pass WHERE day >= ? GROUP BY store').bind(passFrom),
    T.prepare('SELECT store, COUNT(DISTINCT browser) AS n FROM usage_browsers WHERE day >= ? GROUP BY store').bind(passFrom),
    T.prepare('SELECT store, COUNT(*) AS n FROM inv_labels GROUP BY store'),
  ]);
  const first = (await T.prepare('SELECT MIN(day) AS d FROM usage_load').first()).d || null;
  let names = new Map();
  try { names = new Map(((await (env.AE || env.DB).prepare('SELECT store, name FROM store_access').all()).results || []).map((r) => [r.store, r.name])); } catch (_) {}
  const seen = (s) => !me || me.scope === 'all' || me.owner || (me.canSee ? me.canSee(s) : (me.stores || []).includes(s));
  const bro = new Map(browsers.results.map((r) => [r.store, r.n])), lab = new Map(labels.results.map((r) => [r.store, r.n]));
  const ids = [...new Set([...pass.results.map((r) => r.store), ...lab.keys()])].filter(seen).sort((a, b) => a - b);
  const pr = new Map(pass.results.map((r) => [r.store, r]));
  const stores = ids.map((s) => {
    const p = pr.get(s), n = p ? p.passes : 0;
    return { store: s, name: names.get(s) || null, labels: lab.get(s) || 0, passes: n,
      portalPerPass: n ? Math.round(p.portal / n) : null, workerPerPass: n ? Math.round(p.worker / n) : null, avgSeconds: n ? Math.round(p.seconds / n) : null,
      lookupPasses: n ? p.lookup_passes : 0, lookupSeconds: p && p.lookup_passes ? Math.round(p.lookup_seconds / p.lookup_passes) : null, browsers: bro.get(s) || 0 };
  });
  const out = { today, since, firstDay: first, scope: wide ? 'all' : 'stores', global: null, stores };
  if (!wide) return out;

  const byDay = new Map(), area = new Map(AREAS.map((a) => [a, { area: a, name: AREA_NAMES[a], today: 0, requests: 0, rows_read: 0, rows_written: 0 }]));
  const month = { requests: 0, rows_read: 0, rows_written: 0 };
  for (const r of load.results) {
    if (r.day >= monthStart) { month.requests += r.requests; month.rows_read += r.rows_read; month.rows_written += r.rows_written; }
    if (r.day < since) continue;
    const d = byDay.get(r.day) || byDay.set(r.day, { requests: 0, rows_read: 0, rows_written: 0 }).get(r.day);
    d.requests += r.requests; d.rows_read += r.rows_read; d.rows_written += r.rows_written;
    const a = area.get(r.area);
    if (a) { a.requests += r.requests; a.rows_read += r.rows_read; a.rows_written += r.rows_written; if (r.day === today) a.today += r.requests; }
  }
  const sz = new Map(sizes.results.map((r) => [r.day, r.bytes]));
  const days = [];
  for (let d = since; d <= today; d = addDays(d, 1)) {
    const known = first != null && d >= first, x = byDay.get(d) || { requests: 0, rows_read: 0, rows_written: 0 };
    days.push(known ? { day: d, ...x, bytes: sz.get(d) ?? null } : { day: d, requests: null, rows_read: null, rows_written: null, bytes: null });
  }
  const sizeRows = sizes.results, active = stores.filter((s) => s.passes > 0).length;
  out.global = { days, month, areas: [...area.values()], bytes: sizeRows.length ? sizeRows[sizeRows.length - 1].bytes : null, projection: projection({ first, today, days, sizeRows, active }) };
  return out;
}

// A month at today's pace for the stores reporting Retrace passes, and what one more store adds (the average per active store).
// Complete days only (today is partial) and at least a week of them; the database's growth only with a week of size readings that actually grew.
function projection({ first, today, days, sizeRows, active }) {
  if (first == null || first >= today) return { status: 'early', stores: active };
  const done = days.filter((d) => d.requests != null && d.day < today);
  if (done.length < 7) return { status: 'early', stores: active, days: done.length };
  const perMonth = done.reduce((n, d) => n + d.requests, 0) / done.length * MONTH;
  if (!active) return { status: 'nostores', month_requests: Math.round(perMonth), days: done.length };
  let growth = null;
  if (sizeRows.length >= 7) {
    const a = sizeRows[0], b = sizeRows[sizeRows.length - 1], span = (Date.parse(b.day) - Date.parse(a.day)) / 86400000;
    if (span >= 6 && b.bytes > a.bytes) growth = Math.round((b.bytes - a.bytes) / span * MONTH / active);
  }
  return { status: 'ok', stores: active, days: done.length, month_requests: Math.round(perMonth), per_store: Math.round(perMonth / active), db_growth_per_store_month: growth };
}
