// Metrics page (src/metrics.js) against local D1 databases: sums, store scoping, the previous period,
// empty states, and status_periods (built from status histories, kept on uploads, backfilled).
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { getPlatformProxy } from 'wrangler';
import { metricsApi, buildMetrics, statusPeriodsOf, statusPeriodStmts, closeStatusPeriod, deviceType, localToUtc } from '../src/metrics.js';
import { WAYMARK_SQL } from './metrics-seed.mjs';

rmSync('.wrangler-test-metrics', { recursive: true, force: true });
const { env, dispose } = await getPlatformProxy({ configPath: 'wrangler.toml', persist: { path: '.wrangler-test-metrics' } });
for (const stmt of readFileSync('schema.sql', 'utf8').replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean)) await env.TR.prepare(stmt).run();
for (const q of WAYMARK_SQL) await env.AE.prepare(q).run();
const T = env.TR, A = env.AE, E = Object.assign({}, env);
const runAll = async (stmts) => { if (stmts.length) await T.batch(stmts); };
const TZ = 'America/New_York';
const Z = (day, hour, min = 0) => new Date(localToUtc(day, hour, TZ) + min * 60000).toISOString(); // store-local time → UTC ISO

// ------------------------------------------------------------------ status periods from a history
{
  const p = statusPeriodsOf({ workorder: { statusId: 14, updatedAt: '2026-10-14T18:00:00Z' }, auditTrail: [
    { statusId: 1, createdAt: '2026-10-13T14:00:00Z' }, { statusId: 2, createdAt: '2026-10-13T15:00:00Z' }, { statusId: 2, createdAt: '2026-10-13T15:30:00Z' }, { statusId: 13, createdAt: '2026-10-14T14:00:00.000Z' }] }, '2026-10-15T00:00:00Z');
  assert.deepEqual(p.map((x) => [x.status_id, x.start_at.slice(0, 16), x.end_at && x.end_at.slice(0, 16)]),
    [[1, '2026-10-13T14:00', '2026-10-13T15:00'], [2, '2026-10-13T15:00', '2026-10-14T14:00'], [13, '2026-10-14T14:00', '2026-10-14T18:00']], 'closed status ends the last interval, repeats collapse');
  const q = statusPeriodsOf({ workorder: { statusId: 10, updatedAt: '2026-10-13T16:00:00Z' }, auditTrail: [{ statusId: 1, createdAt: '2026-10-13T14:00:00Z' }] }, '2026-10-15T00:00:00Z');
  assert.deepEqual(q.map((x) => [x.status_id, x.end_at]), [[1, '2026-10-13T16:00:00.000Z'], [10, null]], 'current status after the history opens an interval');
  assert.equal(deviceType('iPhone 15 Pro'), 'iPhone'); assert.equal(deviceType('Galaxy Tab A8'), 'iPad / tablet'); assert.equal(deviceType('Galaxy S23'), 'Samsung Galaxy'); assert.equal(deviceType(null), 'Other');
}

// ------------------------------------------------------------------ kept on uploads (with and without a history)
{
  const plain = (statusId, updatedAt, trail) => ({ workorder: { workorderId: 7001, storeId: 914, statusId, updatedAt }, auditTrail: trail });
  await runAll(await statusPeriodStmts(T, 914, 7001, plain(1, '2026-10-01T14:00:00Z', [{ statusId: 1, createdAt: '2026-10-01T14:00:00Z' }]), '2026-10-01T14:05:00Z'));
  await runAll(await statusPeriodStmts(T, 914, 7001, plain(2, '2026-10-01T15:00:00Z', [{ statusId: 1, createdAt: '2026-10-01T14:00:00Z' }, { statusId: 2, createdAt: '2026-10-01T15:00:00Z' }]), '2026-10-01T15:05:00Z'));
  let rows = (await T.prepare('SELECT status_id, end_at FROM status_periods WHERE wo = 7001 ORDER BY start_at').all()).results;
  assert.deepEqual(rows.map((r) => [r.status_id, !!r.end_at]), [[1, true], [2, false]]);
  assert.equal((await statusPeriodStmts(T, 914, 7001, plain(2, '2026-10-01T15:00:00Z', [{ statusId: 1, createdAt: '2026-10-01T14:00:00Z' }, { statusId: 2, createdAt: '2026-10-01T15:00:00Z' }]), '2026-10-01T16:00:00Z')).length, 0, 'unchanged history writes nothing');
  // without a history: the open interval closes and a new one opens
  await runAll(await statusPeriodStmts(T, 914, 7001, plain(10, '2026-10-02T15:00:00Z', []), '2026-10-02T15:05:00Z'));
  rows = (await T.prepare('SELECT status_id, end_at FROM status_periods WHERE wo = 7001 ORDER BY start_at').all()).results;
  assert.deepEqual(rows.map((r) => [r.status_id, r.end_at]), [[1, '2026-10-01T15:00:00.000Z'], [2, '2026-10-02T15:00:00.000Z'], [10, null]]);
  await closeStatusPeriod(T, 914, 7001, '2026-10-03T00:00:00Z').run();
  assert.equal((await T.prepare('SELECT COUNT(*) AS n FROM status_periods WHERE wo = 7001 AND end_at IS NULL').first()).n, 0, 'gone closes it');
  await T.prepare('DELETE FROM status_periods').run();
}

// ------------------------------------------------------------------ fixture: stores 914 + 326, Oct 10–15 2026 (now = Thu Oct 15, 4 PM)
const NOW = Date.parse(Z('2026-10-15', 16));
const wo = (store, n, o) => T.prepare(`INSERT INTO workorders (store, wo, status_id, program_name, device, created_at, is_open, closed_at, sold_at, last_cart_value, last_cart_tax, plain)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(store, n, o.status, o.program || 'Retail', o.device || 'iPhone 13', o.created, o.open ?? 1, o.closed || null, o.sold || null, o.value ?? null, o.tax ?? null, o.plain ? JSON.stringify(o.plain) : null);
await T.batch([
  T.prepare("INSERT INTO sales_days (store, day, source, synced_at) VALUES (914, '2026-10-12', 'portal', ?), (914, '2026-10-13', 'portal', ?), (914, '2026-10-14', 'portal', ?), (326, '2026-10-13', 'portal', ?)").bind(Z('2026-10-15', 9), Z('2026-10-15', 9), Z('2026-10-15', 9), Z('2026-10-15', 9)),
  ...[[914, 'a', '2026-10-13', Z('2026-10-13', 11), 'Sale', 100, 'Retail', 1], [914, 'b', '2026-10-13', Z('2026-10-13', 12), 'Sale', 50, null, null], [914, 'c', '2026-10-13', Z('2026-10-13', 13), 'Return', 20, 'Retail', 2],
    [914, 'd', '2026-10-14', Z('2026-10-14', 15), 'Sale', 200, 'Google', 3], [326, 'e', '2026-10-13', Z('2026-10-13', 11), 'Sale', 300, 'Retail', 4],
    [914, 'p1', '2026-10-12', Z('2026-10-12', 11), 'Sale', 70, 'Retail', 5], [914, 'p2', '2026-10-12', Z('2026-10-12', 18), 'Sale', 999, 'Retail', 6]]
    .map(([st, id, day, at, type, total, prog, w]) => T.prepare("INSERT INTO sales (store, sale_id, wo, sale_day, sale_at, type, total, program, card, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'v1.SEALED', 'portal')").bind(st, id, w, day, at, type, total, prog)),
  // Oct 15 isn't synced for 914: estimated from a WO at Sale complete (value + tax)
  wo(914, 9001, { status: 14, open: 0, created: Z('2026-10-14', 10), sold: Z('2026-10-15', 11), closed: Z('2026-10-15', 11), value: 80, tax: 5, program: 'Asurion Mobility' }),
  // WO 9002: Need to order Oct 13 10:00 → Oct 14 10:00, then Ready for pickup (still there)
  wo(914, 9002, { status: 13, created: Z('2026-10-13', 10), device: 'Galaxy S23', plain: { workorder: { workorderId: 9002, statusId: 13, updatedAt: Z('2026-10-14', 10) }, auditTrail: [{ statusId: 2, createdAt: Z('2026-10-13', 10) }, { statusId: 13, createdAt: Z('2026-10-14', 10) }] } }),
  T.prepare('INSERT INTO rfp_periods (store, wo, start_at, end_at, value) VALUES (914, 9002, ?, NULL, 150)').bind(Z('2026-10-14', 10)),
  // WO 9003: no status history in its plain part, only `changes` (Bench → Ready for pickup → sold)
  wo(914, 9003, { status: 14, open: 0, created: Z('2026-10-12', 10), sold: Z('2026-10-14', 12), closed: Z('2026-10-14', 12), value: 0, plain: { workorder: { workorderId: 9003, statusId: 14 } } }),
  T.prepare("INSERT INTO changes (store, wo, changed_at, field, old, new) VALUES (914, 9003, ?, 'workorder.statusId', '10', '13'), (914, 9003, ?, 'workorder.statusId', '13', '14')").bind(Z('2026-10-13', 10), Z('2026-10-14', 12)),
  T.prepare('INSERT INTO rfp_periods (store, wo, start_at, end_at, value) VALUES (914, 9003, ?, ?, 60)').bind(Z('2026-10-13', 10), Z('2026-10-14', 12)),
  T.prepare('INSERT INTO scans (store, at, by_name) VALUES (914, ?, ?), (914, ?, ?)').bind('2026-10-01T15:00:00Z', 'x', new Date(NOW - 5 * 60000).toISOString(), 'x'),
]);
await A.batch([
  A.prepare("INSERT INTO store_access (store, name) VALUES (914, 'Newport News'), (326, 'Lynnhaven'), (536, 'Lexington')"),
  A.prepare("INSERT INTO usage (day, store, user_id, feature, count) VALUES ('2026-10-14', 914, 1, 'active', 1), ('2026-10-14', 914, 2, 'active', 1), ('2026-10-14', 326, 1, 'active', 1), ('2026-10-14', 914, 1, 'waymark:board', 5), ('2026-10-14', 914, 2, 'cleaningRate', 3), ('2026-10-14', 326, 1, 'waymark:board', 4)"),
  A.prepare("INSERT INTO auto_marks (store, wo, due, created_at) VALUES (914, 1, '2026-10-14', 'x'), (914, 2, '2026-10-15', 'x'), (914, 3, '2026-10-20', 'x'), (914, 4, '2026-10-13', 'x')"),
  A.prepare("INSERT INTO wo_closed (store, wo, closed_at) VALUES (914, 4, 'x')"), // a closed WO's mark (kept 7 days) isn't counted
  A.prepare("INSERT INTO config (key, value, updated_at) VALUES ('cleaningTarget', '60', 'x')"),
]);

// ------------------------------------------------------------------ backfill (resumable, idempotent)
const owner = { email: 'o@x', scope: 'all', stores: [] }, mgr = { email: 'm@x', scope: 'stores', stores: [914] };
const api = async (me, path, method = 'GET') => { const u = new URL('https://a.test' + path); const r = await metricsApi(new Request(u, { method }), E, u, u.pathname, me); return { status: r.status, j: await r.json() }; };
assert.equal((await api(mgr, '/metrics/backfill', 'POST')).status, 403, 'backfill: full access only');
const bf = await api(owner, '/metrics/backfill?after=0', 'POST');
assert.equal(bf.j.done, true); assert.equal(bf.j.processed, 3);
const sp = (await T.prepare('SELECT wo, status_id, start_at, end_at FROM status_periods ORDER BY wo, start_at').all()).results;
assert.deepEqual(sp.filter((r) => r.wo === 9002).map((r) => [r.status_id, r.start_at, r.end_at]), [[2, Z('2026-10-13', 10), Z('2026-10-14', 10)], [13, Z('2026-10-14', 10), null]]);
assert.deepEqual(sp.filter((r) => r.wo === 9003).map((r) => [r.status_id, r.start_at, r.end_at]), [[10, Z('2026-10-12', 10), Z('2026-10-13', 10)], [13, Z('2026-10-13', 10), Z('2026-10-14', 12)]], 'from changes when the history is missing');
assert.equal((await api(owner, '/metrics/backfill?after=0', 'POST')).j.written, 0, 'second run writes nothing');

// ------------------------------------------------------------------ sums
const q = (o) => Object.assign({ from: '2026-10-13', to: '2026-10-15', stores: [914, 326], gran: 'day', compare: true, now: NOW }, o);
let m = await buildMetrics(E, q());
assert.deepEqual(m.grid.main.map((b) => b.k), ['2026-10-13', '2026-10-14', '2026-10-15']);
assert.equal(m.tot.cur.sales[914], 130 + 200 + 85, 'net of the return + estimate for the unsynced day');
assert.equal(m.tot.cur.count[914], 4); assert.equal(m.tot.cur.saleTotal[914], 150 + 200 + 85);
assert.equal(m.tot.cur.sales[326], 300);
assert.deepEqual(m.cur.main.sales[914], [130, 200, 85]);
assert.deepEqual(m.estDays, { 914: ['2026-10-15'] });
assert.deepEqual(m.programs[914], { Retail: 80, 'Retail / quick sale': 50, Google: 200, 'Asurion Mobility': 85 });
assert.equal(m.tot.prev.sales[914], 70, 'previous period stops at the same time of day (the 6 PM sale on Oct 12 is after the cut)');
assert.equal(m.tot.cur.completed[914], 2); assert.equal(m.tot.cur.created[914], 2);
assert.equal(m.tot.cur.rpN[914], 1); assert.ok(Math.abs(m.tot.cur.rpSum[914] - (26 / 24)) < 0.01, 'RFP → pickup: 26 hours');
assert.deepEqual(m.devices[914], { 'Samsung Galaxy': 1, iPhone: 1 });
// levels from status periods: end of each day; Need to order at store close (Thursday is closed → none)
assert.deepEqual(m.cur.main.open[914], [2, 1, 1]); assert.deepEqual(m.cur.main.rfp[914], [1, 1, 1]); assert.deepEqual(m.cur.main.parts[914], [1, 0, 0]);
assert.deepEqual(m.cur.day.nto[914], [1, 0, null]); assert.equal(m.tot.cur.open[914], 1); assert.equal(m.tot.cur.nto[914], 0);
// before tracking: 326 has no scans → its tracker numbers are gaps, not zeros
assert.deepEqual(m.cur.main.open[326], [null, null, null]); assert.equal(m.tot.cur.open[326], null);
assert.deepEqual(m.rfpAging[914].buckets.map((b) => b.n), [1, 0, 0, 0, 0]); assert.equal(m.rfpAging[914].value, 150); assert.equal(m.rfpAging[914].oldestWo, 9002);
// usage + Auto-Waymarks + config
assert.equal(m.tot.cur.uses[914], 8); assert.deepEqual(m.crystals[914], { waymark: 5, cleaningRate: 3 });
assert.deepEqual(m.cur.day.active[914], [0, 2, 0]); assert.equal(m.tot.cur.active.all, 2, 'distinct people across stores (user 1 at both counts once)');
assert.deepEqual(m.waymarks[914], { over: 1, due: 1, up: 1 }); assert.equal(m.cleaningTarget, 60);
assert.equal(m.freshness[914].state, 'good'); assert.equal(m.statusHistory, true);
// empty states: no daily_metrics table yet → no uploaded keys, zeros
assert.deepEqual(m.dailyKeys, []); assert.equal(m.tot.cur.labor[914], 0);
// compare off: totals for deltas but no previous series
assert.equal((await buildMetrics(E, q({ compare: false }))).prev, null);
// uploads appear once daily_metrics has rows
await T.prepare('CREATE TABLE IF NOT EXISTS daily_metrics (store INTEGER NOT NULL, day TEXT NOT NULL, metric TEXT NOT NULL, value REAL NOT NULL, source TEXT, by_name TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (store, day, metric))').run();
await T.prepare("INSERT INTO daily_metrics (store, day, metric, value, updated_at) VALUES (914, '2026-10-13', 'am_orders', 10, 'x'), (914, '2026-10-13', 'cleanings_linked', 6, 'x'), (914, '2026-10-14', 'labor_hours', 20, 'x'), (914, '2026-10-14', 'bogus', 1, 'x')").run();
m = await buildMetrics(E, q());
assert.deepEqual(m.dailyKeys.sort(), ['am_orders', 'cleanings_linked', 'labor_hours']);
assert.equal(m.tot.cur.am[914], 10); assert.equal(m.tot.cur.cln[914], 6); assert.deepEqual(m.perDay.am[914], [10, null, null]);
assert.equal(m.tot.cur.labor[914], 20); assert.equal(m.tot.cur.salesLab[914], 200, 'SPLH counts only sales of days with hours');
// hourly
m = await buildMetrics(E, q({ from: '2026-10-15', to: '2026-10-15', gran: 'hour' }));
assert.equal(m.grid.main.length, 13); assert.equal(m.cur.main.sales[914][11 - 8], 85);
assert.ok(m.grid.main[16 - 8].partial && m.grid.main[17 - 8].future); assert.equal(m.cur.main.sales[914][17 - 8], null);
// weekly
m = await buildMetrics(E, q({ from: '2026-10-01', to: '2026-10-15', gran: 'week' }));
assert.deepEqual(m.grid.main.map((b) => [b.from, b.to]), [['2026-10-01', '2026-10-07'], ['2026-10-08', '2026-10-14'], ['2026-10-15', '2026-10-15']]);
assert.equal(m.cur.main.sales[914][1], 130 + 200 + 70 + 999);

// ------------------------------------------------------------------ the route: scope, validation, empty
const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
let r = await api(mgr, '/metrics?from=2026-10-01&to=' + today + '&stores=all');
assert.equal(r.status, 200); assert.deepEqual(r.j.selected, [914], 'a store-limited person sees only their stores'); assert.deepEqual(r.j.stores.map((s) => s.id), [914]);
assert.ok(!('326' in r.j.tot.cur.sales)); assert.equal(r.j.canBackfill, false);
assert.equal((await api(mgr, '/metrics?from=2026-10-01&to=' + today + '&stores=326')).status, 403);
assert.equal((await api(mgr, '/metrics?from=2026-10-01&to=' + today + '&stores=914,326')).status, 403);
r = await api({ email: 'own@x', owner: true, scope: 'stores', stores: [] }, '/metrics?from=2026-10-01&to=' + today + '&stores=all');
assert.deepEqual(r.j.selected, [326, 536, 914], 'owners see every store');
assert.equal((await api(owner, '/metrics?from=bad&to=' + today)).status, 400);
assert.equal((await api(owner, '/metrics?from=2025-01-01&to=' + today)).status, 400, 'at most 400 days');
assert.equal((await api(owner, '/metrics?from=2026-09-01&to=2026-09-30&granularity=hour')).j.gran, 'day', 'hour only up to 7 days');
assert.equal((await api(owner, '/metrics?from=2026-09-28&to=2026-09-30&granularity=week')).j.gran, 'day', 'week from 14 days; auto otherwise');
r = await api(owner, '/metrics?from=2026-09-01&to=2026-09-03&stores=536');
assert.equal(r.status, 200); assert.equal(r.j.tot.cur.sales[536], 0); assert.equal(r.j.tot.cur.open[536], null, 'store with nothing yet: zeros and gaps');
assert.equal((await api({ email: 'z@x', scope: 'stores', stores: [] }, '/metrics?from=2026-09-01&to=2026-09-03')).j.empty, true);
assert.equal((await api(null, '/metrics?from=2026-09-01&to=2026-09-03')).status, 403);
assert.ok(!JSON.stringify(r.j).includes('SEALED'), 'no sealed column in the response');

await dispose();
rmSync('.wrangler-test-metrics', { recursive: true, force: true });
console.log('metrics: all passed');
