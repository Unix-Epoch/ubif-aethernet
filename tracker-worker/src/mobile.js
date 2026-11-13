/*
  Linkpearl (the Aethernet phone app), Home's numbers. One small answer for one store or all of them:

    GET /api/m/home?store=<id>|all[&fresh=1]  (admin site; owners only for now, see access.js ROUTES)
      → { v, now, tz, today, scope, stores: [{ id, name }], days: [7 store-local days, oldest first],
          sales: { today, yesterday, week: [7 × number|null] },
          splh: { today, hours, week: [7 × number|null], target: [lo, hi] },
          rfp: { total, count, oldestDays, ages: [{ label, n }] },
          lanes: { order, start, work, wait, rfp, total },
          cleaning: { cln, am, rate, week: [7 × rate|null] },
          asOf, stale, behind: { id, name } | null,
          byStore?: [{ id, name, asOf, stale, sales, splh }]   (All stores only) }

  Nothing is computed twice: sales, RFP and last-scan times come from buildMetrics (metrics.js, the Metrics page's own
  function) over the last 7 store days; the rest are three small queries (open work orders by status, uploaded daily numbers,
  synced sales days). A day with no data is null (the app shows a dash), never 0. Plain columns only: no customer details, no staff names.
  Cached for a minute (caches.default) so repeat opens and auto-refresh cost no D1 reads.
*/
import { buildMetrics, local, addDays, hoursFor } from './metrics.js';
import { AGENT_DEFAULTS } from './agent-defaults.js';

// Sales per labor hour target band, dollars. Same band as Tactician's TARGET.withoutGm (src/62-tactician.js, Oct 12, 2026):
// the userscript's constant can't be imported by a Worker, so it is repeated here, once. labor_hours excludes general managers.
export const SPLH_TARGET = [160, 180];
// Stale = no store scan for this long during store hours: the audit agent's own staleMinutes default (tracker-worker/src/index.js).
export const STALE_MINUTES = AGENT_DEFAULTS.staleMinutes;
// Open work orders by lane: Spread's columns (src/59-spread.js COLUMNS). Any other open status counts as Waiting, like Spread.
export const LANES = [{ id: 'order', ids: [2] }, { id: 'start', ids: [8, 24] }, { id: 'work', ids: [9, 10, 11, 12] }, { id: 'wait', ids: [3, 4, 7] }, { id: 'rfp', ids: [13] }];
export const laneOf = (status) => (LANES.find((l) => l.ids.includes(status)) || { id: 'wait' }).id;

const DAYS = 7, CACHE_SECONDS = 60;
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, extra) });
const sum = (a) => { const x = a.filter((v) => v != null); return x.length ? x.reduce((s, v) => s + v, 0) : null; };

// The numbers for the chosen stores (ids, all visible to the caller). `names`: Map id → name. Exported for tests.
export async function buildHome(env, ids, names, nowMs = Date.now()) {
  const T = env.TR, tz = env.STORE_TZ || 'America/New_York', today = local(nowMs, tz).day, from = addDays(today, -(DAYS - 1));
  const days = Array.from({ length: DAYS }, (_, i) => addDays(from, i));
  const S = JSON.stringify(ids), IN = 'IN (SELECT value FROM json_each(?))';
  const [m, wos, dm, sd] = await Promise.all([
    buildMetrics(env, { from, to: today, stores: ids, gran: 'day', compare: false, now: nowMs }),
    T.prepare(`SELECT store, status_id AS s, COUNT(*) AS n FROM workorders WHERE store ${IN} AND is_open = 1 GROUP BY store, status_id`).bind(S).all().then((r) => r.results),
    T.prepare(`SELECT store, day, metric, value FROM daily_metrics WHERE store ${IN} AND day BETWEEN ? AND ? AND metric IN ('labor_hours', 'am_orders', 'cleanings_linked')`).bind(S, from, today).all().then((r) => r.results).catch(() => []), // table comes with daily uploads
    T.prepare(`SELECT store, day FROM sales_days WHERE store ${IN} AND day BETWEEN ? AND ?`).bind(S, from, today).all().then((r) => r.results),
  ]);
  const synced = new Set(sd.map((r) => r.store + '|' + r.day));
  const up = new Map(dm.map((r) => [r.store + '|' + r.day + '|' + r.metric, r.value]));
  const upv = (st, day, k) => (up.has(st + '|' + day + '|' + k) ? up.get(st + '|' + day + '|' + k) : null);

  // Per store, per day: sales (null when the day has neither a synced Portal day nor estimated sales), labor hours, cleanings, orders.
  const per = {};
  for (const st of ids) {
    const sales = (m.cur.day.sales || {})[st] || [];
    per[st] = days.map((d, i) => {
      const v = sales[i] || 0, known = synced.has(st + '|' + d) || v !== 0;
      return { sales: known ? v : null, labor: upv(st, d, 'labor_hours'), am: upv(st, d, 'am_orders'), cln: upv(st, d, 'cleanings_linked') };
    });
  }
  const dayOf = (i, f) => ids.map((st) => f(per[st][i]));
  const salesWeek = days.map((_, i) => sum(dayOf(i, (x) => x.sales)));
  // Sales per labor hour = sales of the stores that have hours that day ÷ their hours (the Metrics page's rule: salesLab ÷ labor).
  const splhAt = (i) => {
    let s = 0, h = 0;
    for (const st of ids) { const x = per[st][i]; if (x.sales != null && x.labor > 0) { s += x.sales; h += x.labor; } }
    return h > 0 ? { v: s / h, h } : null;
  };
  const splhWeek = days.map((_, i) => { const x = splhAt(i); return x ? r2(x.v) : null; });
  const rateAt = (i) => {
    let c = 0, a = 0;
    for (const st of ids) { const x = per[st][i]; if (x.am > 0 && x.cln != null) { c += x.cln; a += x.am; } }
    return a > 0 ? { c, a, r: c / a } : null;
  };
  const last = DAYS - 1, spToday = splhAt(last), clToday = rateAt(last);
  const laborToday = sum(dayOf(last, (x) => x.labor));

  // RFP: Ready for pickup devices and their dollars (rfp_periods, the Metrics page's RFP total).
  const ag = ids.map((st) => (m.rfpAging || {})[st]).filter(Boolean);
  const labels = (ag[0] && ag[0].buckets.map((b) => b.label)) || [];
  const rfp = { total: r2(ag.reduce((s, a) => s + a.value, 0)), count: ag.reduce((s, a) => s + a.count, 0), oldestDays: ag.some((a) => a.oldestDays != null) ? Math.max(...ag.map((a) => a.oldestDays || 0)) : null,
    ages: labels.map((label, k) => ({ label, n: ag.reduce((s, a) => s + a.buckets[k].n, 0) })) };

  const lanes = { order: 0, start: 0, work: 0, wait: 0, rfp: 0, total: 0 };
  for (const r of wos) { lanes[laneOf(r.s)] += r.n; lanes.total += r.n; }

  // Freshness: the last scan per store; stale = older than STALE_MINUTES while the store is open.
  const l = local(nowMs, tz), fresh = (st) => {
    const f = (m.freshness || {})[st], at = f && f.last ? f.last : null, h = hoursFor(st);
    const open = !h.closedDays.includes(l.dow) && l.hour >= h.open && l.hour < h.close;
    const age = at ? Math.round((nowMs - Date.parse(at)) / 60000) : null;
    return { at, stale: age != null && open && age > STALE_MINUTES };
  };
  const fr = ids.map((st) => Object.assign({ id: st }, fresh(st)));
  const withScan = fr.filter((f) => f.at).sort((a, b) => (a.at < b.at ? -1 : 1));
  const stale = fr.some((f) => f.stale);
  const behindF = fr.filter((f) => f.stale).sort((a, b) => (a.at < b.at ? -1 : 1))[0];
  const nm = (id) => names.get(id) || null;
  const out = {
    v: 1, now: new Date(nowMs).toISOString(), tz, today, scope: ids.length === 1 ? ids[0] : 'all',
    stores: [...names].map(([id, name]) => ({ id, name })), days,
    sales: { today: salesWeek[last], yesterday: salesWeek[last - 1], week: salesWeek.map(r2) },
    splh: { today: spToday ? r2(spToday.v) : null, hours: laborToday == null ? null : r2(laborToday), week: splhWeek, target: SPLH_TARGET },
    rfp, lanes,
    cleaning: { cln: clToday ? clToday.c : null, am: clToday ? clToday.a : null, rate: clToday ? r2(clToday.r) : null, week: days.map((_, i) => { const x = rateAt(i); return x ? r2(x.r) : null; }) },
    asOf: withScan[0] ? withScan[0].at : null, stale, behind: ids.length > 1 && behindF ? { id: behindF.id, name: nm(behindF.id) } : null,
  };
  out.sales.today = r2(out.sales.today); out.sales.yesterday = r2(out.sales.yesterday);
  if (ids.length > 1) out.byStore = ids.map((st, k) => ({ id: st, name: nm(st), asOf: fr[k].at, stale: fr[k].stale, sales: r2(per[st][last].sales), splh: per[st][last].sales != null && per[st][last].labor > 0 ? r2(per[st][last].sales / per[st][last].labor) : null }));
  return out;
}

// The route. `me` is the person from access.js (the gate has already run); stores are limited to what they may see.
export async function homeApi(req, env, url, me, opts = {}) {
  if (!me) return json({ error: 'not on the tracker list' }, 403);
  if (req.method !== 'GET') return json({ error: 'not found' }, 404);
  const A = env.DB || env.AE, ask = String(url.searchParams.get('store') || 'all');
  const known = A ? (await A.prepare('SELECT store, name FROM store_access ORDER BY store').all().catch(() => ({ results: [] }))).results : [];
  const full = me.owner === true || me.scope === 'all', mine = (me.stores || []).map(Number);
  const visible = known.filter((s) => full || mine.includes(s.store));
  for (const st of full ? [] : mine) if (!visible.some((s) => s.store === st)) visible.push({ store: st, name: null });
  let ids;
  if (ask === 'all') ids = visible.map((s) => s.store);
  else if (/^\d{1,6}$/.test(ask) && visible.some((s) => s.store === Number(ask))) ids = [Number(ask)];
  else return json({ error: /^\d{1,6}$/.test(ask) ? 'not your store' : 'store: all or a store number' }, /^\d{1,6}$/.test(ask) ? 403 : 400);
  const names = new Map(visible.map((s) => [s.store, s.name || null]));
  if (!ids.length) return json({ v: 1, stores: [], empty: true }, 200, { 'cache-control': 'private, max-age=' + CACHE_SECONDS });
  const nowMs = opts.now || Date.now();
  const cache = typeof caches !== 'undefined' && !opts.now ? caches.default : null; // fresh=1 (the refresh button) skips the read, not the write
  const key = 'https://m.cache/home/' + encodeURIComponent(ids.join(',') + '|' + visible.map((s) => s.store).join(','));
  if (cache && url.searchParams.get('fresh') !== '1') { const hit = await cache.match(key).catch(() => null); if (hit) return new Response(hit.body, { headers: { 'content-type': 'application/json', 'cache-control': 'private, max-age=' + CACHE_SECONDS } }); }
  const body = JSON.stringify(await buildHome(env, ids, names, nowMs));
  if (cache) await cache.put(key, new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=' + CACHE_SECONDS } })).catch(() => {});
  return new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': 'private, max-age=' + CACHE_SECONDS } });
}
