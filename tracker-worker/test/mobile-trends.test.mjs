// Linkpearl Trends (/v1/agents/m/trends, src/mobile-trends.js): calendar periods (week Sunday–Saturday, month, year in months), the
// previous period up to the same point, null days (never 0), sales per labor hour, cleaning, RFP at the end of a period (null before
// its history exists), All stores' breakdown, store scoping and query refusals, nothing private. Local D1; everything invented.
import assert from 'node:assert/strict';
import { setup, Z } from './mobile-helpers.mjs';
import { buildTrends, periodBounds, samePoint, RFP_SINCE } from '../src/mobile-trends.js';

const T = await setup('.wrangler-test-mobile-trends');
const { env, E, authed, registerPhone, approve } = T;
const TR = env.TR;
const NOW = Date.parse(Z('2026-10-15', 16)); // Thursday 4 PM Eastern
const NOW2 = Date.parse(Z('2026-11-10', 16)); // Tuesday 4 PM Eastern
const names = new Map([[914, 'Newport News'], [326, 'Lynnhaven'], [536, 'Lexington']]);
const trends = (ids, period, at, now = NOW) => buildTrends(E, ids, names, { period, at }, now);
const near = (a, b, why) => assert.ok(Math.abs(a - b) < 0.006, why + ': ' + a + ' vs ' + b);

// ------------------------------------------------------------------ periods
assert.deepEqual(periodBounds('week', '2026-10-15'), { from: '2026-10-11', to: '2026-10-17', prevFrom: '2026-10-04', prevTo: '2026-10-10' }, 'Sunday to Saturday');
assert.deepEqual(periodBounds('week', '2026-10-11'), periodBounds('week', '2026-10-17'), 'any day of the week picks the same week');
assert.deepEqual(periodBounds('month', '2026-03-31'), { from: '2026-03-01', to: '2026-03-31', prevFrom: '2026-02-01', prevTo: '2026-02-28' });
assert.deepEqual(periodBounds('month', '2026-01-09'), { from: '2026-01-01', to: '2026-01-31', prevFrom: '2025-12-01', prevTo: '2025-12-31' }, 'across the year');
assert.deepEqual(periodBounds('year', '2026-06-01'), { from: '2026-01-01', to: '2026-12-31', prevFrom: '2025-01-01', prevTo: '2025-12-31' });
assert.equal(samePoint('month', '2026-03-31', periodBounds('month', '2026-03-31')), '2026-02-28', 'clamped to the shorter month');
assert.equal(samePoint('month', '2026-11-15', periodBounds('month', '2026-11-15')), '2026-10-15', 'Nov 15 → Oct 15');
assert.equal(samePoint('year', '2028-02-29', periodBounds('year', '2028-02-29')), '2027-02-28');
assert.equal(samePoint('week', '2026-10-15', periodBounds('week', '2026-10-15')), '2026-10-08');

// ------------------------------------------------------------------ fixture (store time; sales a staff name that must never leak)
const sale = (store, id, day, hour, type, total) => TR.prepare("INSERT INTO sales (store, sale_id, wo, sale_day, sale_at, type, total, card, completed_by, source) VALUES (?, ?, NULL, ?, ?, ?, ?, 'v1.ZZSEALEDSALE', 'ZZSTAFF Person', 'portal')").bind(store, id, day, Z(day, hour), type, total);
const synced = (store, day) => TR.prepare("INSERT INTO sales_days (store, day, source, synced_at) VALUES (?, ?, 'portal', ?)").bind(store, day, Z(day, 21));
const soldWo = (store, n, at, value) => TR.prepare("INSERT INTO workorders (store, wo, status_id, program_name, device, created_at, is_open, closed_at, sold_at, last_cart_value, last_cart_tax, card, plain) VALUES (?, ?, 14, 'Retail', 'iPhone 13', ?, 0, ?, ?, ?, 0, 'v1.ZZSEALEDCARD', ?)")
  .bind(store, n, at, at, at, value, JSON.stringify({ workorder: { customerName: 'ZZCUSTOMER Smith' } }));
const dm = (store, day, metric, value) => TR.prepare("INSERT INTO daily_metrics (store, day, metric, value, source, by_name, updated_at) VALUES (?, ?, ?, ?, 't', 'ZZSTAFF Uploader', 'x')").bind(store, day, metric, value);
const scan = (store, at) => TR.prepare("INSERT INTO scans (store, at, by_name) VALUES (?, ?, 'ZZSTAFF Scanner')").bind(store, at);
const rfp = (store, wo, a, e, value) => TR.prepare('INSERT INTO rfp_periods (store, wo, start_at, end_at, value) VALUES (?, ?, ?, ?, ?)').bind(store, wo, a, e, value);
await TR.batch([
  // 914, previous week (Oct 4–10): synced Oct 5 (100), 6 (50), 8 (30), 9 (999, after the same point Thu Oct 8); last year Oct 3 (1000); Sep 15 (70), Sep 20 (500)
  ...[['2026-10-05', 100], ['2026-10-06', 50], ['2026-10-08', 30], ['2026-10-09', 999], ['2025-10-03', 1000], ['2026-09-15', 70], ['2026-09-20', 500]].flatMap(([d, v], i) => [synced(914, d), sale(914, 'p' + i, d, 12, 'Sale', v)]),
  // 914, this week (Oct 11–17): Oct 12 (200), Oct 13 (100 − 20 return), Oct 14 nothing, Oct 15 estimated from a work order at Sale complete (60)
  synced(914, '2026-10-12'), sale(914, 'c1', '2026-10-12', 11, 'Sale', 200), synced(914, '2026-10-13'), sale(914, 'c2', '2026-10-13', 11, 'Sale', 100), sale(914, 'c3', '2026-10-13', 13, 'Return', 20),
  soldWo(914, 900, Z('2026-10-15', 11), 60),
  // 326: Oct 13 estimated (40), nothing the week before
  soldWo(326, 901, Z('2026-10-13', 15), 40),
  // labor hours: 914 Oct 12 (10), Oct 15 (4), Oct 14 (8, a day without sales: left out), Oct 5 (2); 326 Oct 13 (5)
  dm(914, '2026-10-12', 'labor_hours', 10), dm(914, '2026-10-15', 'labor_hours', 4), dm(914, '2026-10-14', 'labor_hours', 8), dm(914, '2026-10-05', 'labor_hours', 2), dm(326, '2026-10-13', 'labor_hours', 5),
  // cleanings: 914 Oct 12 (6 of 10), Oct 13 (0 orders: left out), Oct 6 (4 of 4), Oct 9 (0 of 10, after the same point)
  dm(914, '2026-10-12', 'am_orders', 10), dm(914, '2026-10-12', 'cleanings_linked', 6), dm(914, '2026-10-13', 'am_orders', 0), dm(914, '2026-10-13', 'cleanings_linked', 0),
  dm(914, '2026-10-06', 'am_orders', 4), dm(914, '2026-10-06', 'cleanings_linked', 4), dm(914, '2026-10-09', 'am_orders', 10), dm(914, '2026-10-09', 'cleanings_linked', 0),
  // first scans: 914 Oct 1, 326 Oct 14, 536 Nov 9 (latest scans give asOf)
  scan(914, Z('2026-10-01', 11)), scan(914, Z('2026-10-15', 15, 50)), scan(326, Z('2026-10-14', 11)), scan(326, Z('2026-10-15', 15, 10)), scan(536, Z('2026-11-09', 11)),
  // Ready for pickup: 914 #500 Oct 20 → Nov 9 noon ($100), #501 since Nov 3 ($50); 326 #600 since Oct 1 ($30)
  rfp(914, 500, Z('2026-10-20', 10), Z('2026-11-09', 12), 100), rfp(914, 501, Z('2026-11-03', 10), null, 50), rfp(326, 600, Z('2026-10-01', 10), null, 30),
]);

// ------------------------------------------------------------------ one store, this week
{
  const t = await trends([914], 'week', undefined);
  assert.equal(t.period, 'week'); assert.equal(t.scope, 914); assert.equal(t.today, '2026-10-15');
  assert.deepEqual([t.from, t.to, t.prevFrom, t.prevTo, t.prevThrough], ['2026-10-11', '2026-10-17', '2026-10-04', '2026-10-10', '2026-10-08']);
  assert.deepEqual(t.sales.days.map((d) => d.day), ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17']);
  assert.deepEqual(t.sales.days.map((d) => d.value), [null, 200, 80, null, 60, null, null], 'no data and future days are null, never 0');
  assert.equal(t.sales.total, 340);
  assert.equal(t.sales.prevTotal, 180, 'previous week through Thursday: 100 + 50 + 30 (not Friday\'s 999)');
  near(t.sales.changePct, 88.9, 'change %');
  assert.deepEqual(t.sales.prevDays.map((d) => d.value), [null, 100, 50, null, 30, 999, null], 'the previous period is shown whole');
  near(t.splh.value, 260 / 14, 'sales of days with hours ÷ their hours (Oct 14 has hours but no sales: left out)'); assert.equal(t.splh.hours, 14); assert.equal(t.splh.prev, 50);
  assert.deepEqual(t.splh.target, { lo: 160, hi: 180 });
  assert.deepEqual(t.splh.days.map((d) => d.value), [null, 20, null, null, 15, null, null]);
  assert.deepEqual(t.cleaning, { linked: 6, orders: 10, pct: 60, prevPct: 100 }, 'Home\'s rule: days with orders; Oct 9 is after the same point');
  assert.deepEqual(t.rfp, { total: 0, count: 0, prevTotal: null }, 'now: Home\'s total; end of Oct 10 is before RFP history (' + RFP_SINCE + ')');
  assert.equal(t.asOf, Z('2026-10-15', 15, 50)); assert.equal(t.stores, undefined);
}

// ------------------------------------------------------------------ All stores
{
  const t = await trends([914, 326], 'week');
  assert.equal(t.scope, 'all'); assert.equal(t.sales.total, 380); assert.equal(t.sales.prevTotal, 180);
  assert.deepEqual(t.sales.days.map((d) => d.value), [null, 200, 120, null, 60, null, null], 'summed per day');
  near(t.splh.value, 300 / 19, 'total sales of store-days with hours ÷ their total hours'); assert.equal(t.splh.hours, 19);
  assert.deepEqual(t.rfp, { total: 30, count: 1, prevTotal: null });
  assert.equal(t.asOf, Z('2026-10-15', 15, 10), 'the oldest last scan across the stores');
  assert.deepEqual(t.stores.map((s) => Object.keys(s).sort()), [0, 1].map(() => ['changePct', 'hours', 'id', 'name', 'prevSales', 'sales', 'splh']));
  const [a, b] = t.stores;
  assert.deepEqual([a.id, a.name, a.sales, a.prevSales, a.hours], [914, 'Newport News', 340, 180, 14]); near(a.changePct, 88.9, '914 change');
  assert.deepEqual([b.id, b.name, b.sales, b.prevSales, b.changePct, b.splh, b.hours], [326, 'Lynnhaven', 40, null, null, 8, 5], 'no previous data: null change, not -100% or Infinity');
}

// ------------------------------------------------------------------ month and year
{
  const m = await trends([914], 'month', '2026-10-02');
  assert.deepEqual([m.from, m.to, m.prevFrom, m.prevTo, m.prevThrough], ['2026-10-01', '2026-10-31', '2026-09-01', '2026-09-30', '2026-09-15']);
  assert.equal(m.sales.days.length, 31); assert.equal(m.sales.prevDays.length, 30);
  assert.equal(m.sales.total, 100 + 50 + 30 + 999 + 340); assert.equal(m.sales.prevTotal, 70, 'Sep 1–15 only');
  assert.equal(m.sales.prevDays[19].value, 500); assert.equal(m.sales.days[20].value, null, 'Oct 21 is in the future');
  assert.deepEqual(m.cleaning, { linked: 10, orders: 24, pct: 41.7, prevPct: null });

  const y = await trends([914], 'year', '2026-02-01');
  assert.deepEqual([y.from, y.to, y.prevFrom, y.prevTo, y.prevThrough], ['2026-01-01', '2026-12-31', '2025-01-01', '2025-12-31', '2025-10-15']);
  assert.deepEqual(y.sales.days.map((d) => d.day), Array.from({ length: 12 }, (_, i) => '2026-' + String(i + 1).padStart(2, '0')), 'monthly buckets');
  assert.deepEqual(y.sales.days.map((d) => d.value), [null, null, null, null, null, null, null, null, 570, 1519, null, null]);
  assert.equal(y.sales.prevDays[9].value, 1000); assert.equal(y.sales.prevTotal, 1000); assert.equal(y.sales.total, 2089); near(y.sales.changePct, 108.9, 'year change');
  assert.equal(y.splh.days[9].value, r(360 / 16), 'October: (200 + 60 + 100) ÷ (10 + 4 + 2); Oct 14 has hours but no sales');
}
function r(v) { return Math.round(v * 100) / 100; }

// ------------------------------------------------------------------ RFP at the end of a period, when its history reaches back
{
  const cur = await trends([914, 326], 'week', undefined, NOW2); // Nov 8–14, previous Nov 1–7
  assert.deepEqual(cur.rfp, { total: 80, count: 2, prevTotal: 180 }, 'now: $50 + $30; end of Nov 7: $100 + $50 + $30');
  const past = await trends([914, 326], 'week', '2026-10-28', NOW2); // Oct 25–31, over: compared with the whole week before
  assert.equal(past.prevThrough, past.prevTo);
  assert.deepEqual(past.rfp, { total: 130, count: 2, prevTotal: 130 }, 'end of Oct 31 and end of Oct 24');
  const untracked = await trends([914, 536], 'week', undefined, NOW2);
  assert.equal(untracked.rfp.prevTotal, null, 'Lexington was not scanned before Nov 9: no honest total for Nov 7');
  assert.deepEqual([untracked.rfp.total, untracked.rfp.count], [50, 1], 'but now is now (Home\'s number)');
  const before = await trends([914], 'month', '2026-10-01', NOW2);
  assert.equal(before.rfp.total, 100, 'end of October'); assert.equal(before.rfp.prevTotal, null, 'end of September: before RFP history');
  assert.doesNotMatch(JSON.stringify([cur, past, untracked, before]), /Infinity|NaN/);
}

// ------------------------------------------------------------------ the route
const P = '/v1/agents/m/trends';
const A = await registerPhone('Pixel A'); assert.equal((await approve(A, [914, 326])).status, 200);
const pending = await registerPhone('Pixel P');
const mac = await registerPhone('Mac audit', { kind: undefined }); await approve(mac, [914]);
{
  const r = await authed(A, P + '?store=all&period=week&at=2026-10-14');
  assert.equal(r.status, 200); assert.match(r.h.get('cache-control'), /private, max-age=60/);
  assert.deepEqual(Object.keys(r.j).sort(), ['asOf', 'cleaning', 'from', 'period', 'prevFrom', 'prevThrough', 'prevTo', 'rfp', 'sales', 'scope', 'splh', 'stores', 'today', 'to', 'tz', 'v'].sort());
  assert.equal(r.j.from, '2026-10-11'); assert.equal(r.j.sales.total, 380, 'a past week: the same numbers'); assert.equal(r.j.sales.prevTotal, 1179, 'and the whole week before');
  assert.deepEqual(r.j.stores.map((s) => s.id), [914, 326], 'approved stores only');
  const text = JSON.stringify(r.j);
  assert.doesNotMatch(text, /ZZ|customer|sealed|card|completed_by|by_name|v1\./i, 'no customer details, no staff names, nothing sealed');
  assert.ok(text.length < 3000, 'phone-sized: ' + text.length);
  const d = await authed(A, P); assert.equal(d.status, 200); assert.equal(d.j.period, 'week'); assert.equal(d.j.scope, 'all'); assert.equal(d.j.sales.days.length, 7);
  assert.equal(new Date(d.j.from + 'T12:00:00Z').getUTCDay(), 0, 'default: this week, from Sunday');
  const one = await authed(A, P + '?store=326&period=year&at=2026-10-14'); assert.equal(one.status, 200); assert.equal(one.j.scope, 326); assert.equal(one.j.stores, undefined); assert.equal(one.j.sales.days.length, 12);
  const y = await authed(A, P + '?store=914&period=month&at=2026-10-14&fresh=1'); assert.equal(y.status, 200); assert.equal(y.j.sales.prevTotal, 570, 'a past month: the whole month before');
  for (const [q, st, msg] of [['store=536', 403, 'not your store'], ['store=abc', 400], ['period=day', 400], ['at=2026-13-01', 400], ['at=2026-02-30', 400], ['at=15/10/2026', 400], ['at=2099-01-01', 400, 'at: a day up to today']]) {
    const x = await authed(A, P + '?' + q); assert.equal(x.status, st, q); if (msg) assert.equal(x.j.error, msg);
  }
  assert.equal((await authed(A, P + '/extra')).status, 404);
  assert.equal((await authed(A, P, { method: 'POST', body: {} })).status, 404);
  assert.equal((await authed(pending, P)).status, 403); assert.equal((await authed(mac, P)).j.error, 'not a phone'); assert.equal((await authed(null, P)).status, 401);
}

await T.dispose();
console.log('mobile-trends: all passed');
