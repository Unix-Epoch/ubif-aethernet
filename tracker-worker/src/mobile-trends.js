/*
  Linkpearl: Trends, under /v1/agents/m/trends (phone API; dispatch in mobile-agent.js, reference in MOBILE-API-trends.md).

    GET /v1/agents/m/trends?store=<id>|all&period=week|month|year&at=YYYY-MM-DD[&fresh=1]
      → { v, period, scope, tz, today, from, to, prevFrom, prevTo, prevThrough, asOf,
          sales: { total, prevTotal, changePct, days: [{ day, value }], prevDays: [{ day, value }] },
          splh: { value, prev, hours, target: { lo, hi }, days: [{ day, value }] },
          cleaning: { linked, orders, pct, prevPct },
          rfp: { total, count, prevTotal },
          stores?: [{ id, name, sales, prevSales, changePct, splh, hours }]   (store=all only) }

  Periods are calendar periods in store time: week = Sunday to Saturday (Portal's own week: its time sheet ranges start on a
  Sunday), month = calendar month, year = calendar year (monthly buckets). `at` picks the period (any day inside it, default today).
  Home's 7-day chart is a rolling window ending today; a rolling window can't be paged back period by period, so Trends doesn't use it.

  Same numbers as Home, over a longer range: sales come from buildMetrics (metrics.js, the Metrics page's own function, Portal's sales
  where the day was synced, else estimated from work orders at Sale complete), labor hours / cleanings / orders from daily_metrics, and a
  day is null when it has no data (Home's rule: a synced day or estimated sales), never 0. Sales per labor hour is sales of the
  store-days that have hours ÷ those hours (the Metrics rule), cleaning is linked cleanings ÷ Asurion Mobility orders.
  The comparison: the previous period up to the same point (day granularity: through the matching day, inclusive), the whole previous
  period when the chosen one is over. RFP: rfp_periods at an instant (Tactician's "RFP table at the end of a day"), null before the
  store's history exists. Plain columns only: no customer details, no staff names. Cached a minute like Home; fresh=1 skips the read.
*/
import { buildMetrics, local, addDays, localToUtc } from './metrics.js';
import { SPLH_TARGET } from './mobile.js';

const CACHE_SECONDS = 60, PERIODS = ['week', 'month', 'year'];
// rfp_periods started recording on Oct 12, 2026 (migrations/2026-10-12e.sql) and was never backfilled: before the first full day,
// and before a store's first scan, the RFP table's value can't be rebuilt honestly.
export const RFP_SINCE = '2026-10-13';

const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const pct = (cur, prev) => (cur != null && prev != null && prev > 0 ? r1(((cur - prev) / prev) * 100) : null);
const err = (status, message) => Object.assign(new Error(message), { status });
const DAY_RE = /^\d{4}-\d\d-\d\d$/;
const validDay = (s) => DAY_RE.test(s) && !isNaN(Date.parse(s + 'T12:00:00Z')) && addDays(s, 0) === s;
const pad = (n) => String(n).padStart(2, '0');
const monthEnd = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const dow = (d) => new Date(d + 'T12:00:00Z').getUTCDay();
const daysIn = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };

// The period holding `at` and the one before it.
export function periodBounds(period, at) {
  if (period === 'week') { const from = addDays(at, -dow(at)); return { from, to: addDays(from, 6), prevFrom: addDays(from, -7), prevTo: addDays(from, -1) }; }
  if (period === 'month') { const from = at.slice(0, 7) + '-01', prevTo = addDays(from, -1); return { from, to: monthEnd(at.slice(0, 7)), prevFrom: prevTo.slice(0, 7) + '-01', prevTo }; }
  const y = Number(at.slice(0, 4));
  return { from: y + '-01-01', to: y + '-12-31', prevFrom: (y - 1) + '-01-01', prevTo: (y - 1) + '-12-31' };
}
// The previous period's day at the same point as `day` (week: same weekday; month: same day of the month; year: same month and day;
// clamped to the shorter month, so Mar 31 → Feb 28).
export function samePoint(period, day, b) {
  if (period === 'week') return addDays(day, -7);
  const ym = period === 'month' ? b.prevFrom.slice(0, 7) : b.prevFrom.slice(0, 4) + day.slice(4, 7);
  return ym + '-' + pad(Math.min(Number(day.slice(8)), Number(monthEnd(ym).slice(8))));
}

// The numbers for the chosen stores (ids, all approved). `names`: Map id → name. Exported for tests.
export async function buildTrends(env, ids, names, q, nowMs = Date.now()) {
  const T = env.TR, tz = env.STORE_TZ || 'America/New_York', today = local(nowMs, tz).day;
  const period = q.period, at = q.at || today, b = periodBounds(period, at);
  if (b.from > today) throw err(400, 'at: a day up to today');
  const cut = b.to < today ? b.to : today, prevThrough = b.to < today ? b.prevTo : samePoint(period, today, b);
  const S = JSON.stringify(ids), IN = 'IN (SELECT value FROM json_each(?))';
  const tEnd = Math.min(localToUtc(addDays(b.to, 1), 0, tz) - 1, nowMs), tPrev = localToUtc(b.from, 0, tz) - 1;
  const [m, dm, sd, rp] = await Promise.all([
    buildMetrics(env, { from: b.prevFrom, to: cut, stores: ids, gran: 'day', compare: false, now: nowMs }),
    T.prepare(`SELECT store, day, metric, value FROM daily_metrics WHERE store ${IN} AND day BETWEEN ? AND ? AND metric IN ('labor_hours', 'am_orders', 'cleanings_linked')`).bind(S, b.prevFrom, cut).all().then((r) => r.results).catch(() => []), // table comes with daily uploads
    T.prepare(`SELECT store, day FROM sales_days WHERE store ${IN} AND day BETWEEN ? AND ?`).bind(S, b.prevFrom, cut).all().then((r) => r.results),
    T.prepare(`SELECT store, start_at AS a, end_at AS e, value FROM rfp_periods WHERE store ${IN} AND start_at <= ? AND (end_at IS NULL OR end_at >= ?)`).bind(S, new Date(tEnd).toISOString(), new Date(tPrev).toISOString()).all().then((r) => r.results),
  ]);
  const synced = new Set(sd.map((r) => r.store + '|' + r.day));
  const up = new Map(dm.map((r) => [r.store + '|' + r.day + '|' + r.metric, r.value]));
  const upv = (st, d, k) => (up.has(st + '|' + d + '|' + k) ? up.get(st + '|' + d + '|' + k) : null);
  const salesOf = (st, d) => { // Home's rule: null unless the day was synced or has estimated sales
    if (d < b.prevFrom || d > cut) return null;
    const v = ((m.cur.day.sales || {})[st] || [])[Math.round((Date.parse(d) - Date.parse(b.prevFrom)) / 86400000)] || 0;
    return synced.has(st + '|' + d) || v !== 0 ? v : null;
  };
  const cell = (st, d) => ({ sales: salesOf(st, d), labor: upv(st, d, 'labor_hours'), am: upv(st, d, 'am_orders'), cln: upv(st, d, 'cleanings_linked') });

  // Sums over a set of days and stores. null = no data at all.
  const agg = (sts, days) => {
    let sales = null, s = 0, h = 0, c = 0, a = 0;
    for (const st of sts) for (const d of days) {
      const x = cell(st, d);
      if (x.sales != null) sales = (sales || 0) + x.sales;
      if (x.sales != null && x.labor > 0) { s += x.sales; h += x.labor; }
      if (x.am > 0 && x.cln != null) { c += x.cln; a += x.am; }
    }
    return { sales: r2(sales), splh: h > 0 ? r2(s / h) : null, hours: h > 0 ? r2(h) : null, linked: a > 0 ? c : null, orders: a > 0 ? a : null, rate: a > 0 ? c / a : null };
  };
  const curDays = daysIn(b.from, cut), prevDays = daysIn(b.prevFrom, prevThrough);
  const cur = agg(ids, curDays), prev = agg(ids, prevDays);
  // Chart buckets: days, or months for a year. The current period's future days are null; the previous period is shown whole.
  const buckets = (from, to) => (period === 'year'
    ? Array.from({ length: 12 }, (_, i) => { const ym = from.slice(0, 4) + '-' + pad(i + 1); return { day: ym, days: daysIn(ym + '-01', monthEnd(ym)) }; })
    : daysIn(from, to).map((d) => ({ day: d, days: [d] })));
  const curB = buckets(b.from, b.to).map((k) => Object.assign(k, { x: agg(ids, k.days.filter((d) => d <= cut)) }));
  const prevB = buckets(b.prevFrom, b.prevTo).map((k) => Object.assign(k, { x: agg(ids, k.days) }));

  // RFP: the devices on the RFP table at an instant and their value then (last seen while in RFP). null when any store's history
  // doesn't reach back that far; the current period's end is now, the same total as Home.
  const since = m.since || {};
  const rfpAt = (t, always) => {
    const day = local(t, tz).day;
    if (!always && (day < RFP_SINCE || ids.some((st) => !since[st] || since[st] > day))) return null;
    const on = rp.filter((p) => Date.parse(p.a) <= t && (!p.e || Date.parse(p.e) > t));
    return { total: r2(on.reduce((s, p) => s + (p.value || 0), 0)), count: on.length };
  };
  const rNow = rfpAt(tEnd, tEnd === nowMs), rPrev = rfpAt(tPrev, false);

  const scans = ids.map((st) => ((m.freshness || {})[st] || {}).last).filter(Boolean).sort();
  const out = {
    v: 1, period, scope: ids.length === 1 ? ids[0] : 'all', tz, today,
    from: b.from, to: b.to, prevFrom: b.prevFrom, prevTo: b.prevTo, prevThrough, asOf: scans[0] || null,
    sales: { total: cur.sales, prevTotal: prev.sales, changePct: pct(cur.sales, prev.sales),
      days: curB.map((k) => ({ day: k.day, value: k.x.sales })), prevDays: prevB.map((k) => ({ day: k.day, value: k.x.sales })) },
    splh: { value: cur.splh, prev: prev.splh, hours: cur.hours, target: { lo: SPLH_TARGET[0], hi: SPLH_TARGET[1] }, days: curB.map((k) => ({ day: k.day, value: k.x.splh })) },
    cleaning: { linked: cur.linked, orders: cur.orders, pct: cur.rate == null ? null : r1(cur.rate * 100), prevPct: prev.rate == null ? null : r1(prev.rate * 100) },
    rfp: { total: rNow ? rNow.total : null, count: rNow ? rNow.count : null, prevTotal: rPrev ? rPrev.total : null },
  };
  if (ids.length > 1) out.stores = ids.map((st) => {
    const c = agg([st], curDays), p = agg([st], prevDays);
    return { id: st, name: names.get(st) || null, sales: c.sales, prevSales: p.sales, changePct: pct(c.sales, p.sales), splh: c.splh, hours: c.hours };
  });
  return out;
}

export async function trendsApi(req, env, url, device, h) {
  if (req.method !== 'GET' || url.pathname !== '/v1/agents/m/trends') return h.fail(404, 'not found');
  const qs = url.searchParams, tz = env.STORE_TZ || 'America/New_York', mine = (device.stores || []).map(Number);
  const ask = String(qs.get('store') || 'all'), period = String(qs.get('period') || 'week'), atQ = qs.get('at');
  let ids;
  if (ask === 'all') ids = mine;
  else if (/^\d{1,6}$/.test(ask)) { if (!mine.includes(Number(ask))) return h.fail(403, 'not your store'); ids = [Number(ask)]; }
  else return h.fail(400, 'store: all or a store number');
  if (!PERIODS.includes(period)) return h.fail(400, 'period: week, month or year');
  const nowMs = Date.now(), today = local(nowMs, tz).day, at = atQ == null || atQ === '' ? today : String(atQ);
  if (!validDay(at) || at < '2000-01-01') return h.fail(400, 'at: a day YYYY-MM-DD');
  if (periodBounds(period, at).from > today) return h.fail(400, 'at: a day up to today');
  const hdr = { 'content-type': 'application/json', 'cache-control': 'private, max-age=' + CACHE_SECONDS };
  if (!ids.length) return new Response(JSON.stringify({ v: 1, stores: [], empty: true }), { headers: hdr });
  const A = env.DB || env.AE;
  const known = A ? (await A.prepare('SELECT store, name FROM store_access ORDER BY store').all().catch(() => ({ results: [] }))).results : [];
  const names = new Map(mine.map((st) => [st, (known.find((k) => k.store === st) || {}).name || null]));
  // Cached per (stores, period, today): the store day is in the key so midnight starts a new entry. fresh=1 skips the read, not the write.
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = 'https://m.cache/trends/' + encodeURIComponent([ids.join(','), mine.join(','), period, periodBounds(period, at).from, today].join('|'));
  if (cache && qs.get('fresh') !== '1') { const hit = await cache.match(key).catch(() => null); if (hit) return new Response(hit.body, { headers: hdr }); }
  const body = JSON.stringify(await buildTrends(env, ids, names, { period, at }, nowMs));
  if (cache) await cache.put(key, new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=' + CACHE_SECONDS } })).catch(() => {});
  return new Response(body, { headers: hdr });
}
