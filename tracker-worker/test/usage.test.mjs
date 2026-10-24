// Cloudflare and Portal load (src/usage.js): the counters, the D1 meta wrapper, flush behaviour, the collector's pass route
// and the admin read. Runs the tracker Worker against local D1 (wrangler getPlatformProxy) like worker.test.mjs.
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { getPlatformProxy } from 'wrangler';
import worker from '../src/index.js';
import { areaOf, wrapDb, usageLoad, passStmts, flush, meter, pruneUsage } from '../src/usage.js';

rmSync('.wrangler-test-usage', { recursive: true, force: true });
const { env, dispose } = await getPlatformProxy({ configPath: 'wrangler.toml', persist: { path: '.wrangler-test-usage' } });
const sql = (file) => readFileSync(file, 'utf8').replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean);
for (const s of sql('schema.sql')) await env.TR.prepare(s).run();
await env.AE.prepare('CREATE TABLE IF NOT EXISTS store_access (store INTEGER PRIMARY KEY, name TEXT, added_by TEXT, added_at TEXT)').run();
await env.AE.prepare("INSERT INTO store_access (store, name) VALUES (914, 'Newport News'), (326, 'Lynnhaven')").run();
const T = env.TR;
const E = Object.assign({}, env, { APP_KEY: 'k', TRACKER_OWNERS: 'owner@x.com', LIMITER: null });
const day = new Date().toISOString().slice(0, 10);
const call = async (method, path, body, e = E, ctx = {}) => {
  const r = await worker.fetch(new Request('https://t.test' + path, { method, headers: { 'x-aethernet-key': 'k', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), e, ctx);
  return { status: r.status, j: await r.json() };
};
const rows = async () => Object.fromEntries((await T.prepare('SELECT * FROM usage_load WHERE day = ?').bind(day).all()).results.map((r) => [r.area, r]));

// --- areas, from the route
assert.equal(areaOf('/v1/914/tracker/retrace/sweep'), 'collector');
assert.equal(areaOf('/v1/914/tracker/retrace/pass'), 'collector');
assert.equal(areaOf('/api/tracker/retrace/coverage'), 'retrace_admin');
assert.equal(areaOf('/retrace-ui.js'), 'retrace_admin');
assert.equal(areaOf('/v1/914/tracker/scan'), 'tracker');
assert.equal(areaOf('/v1/tracker/master'), 'tracker');
assert.equal(areaOf('/v1/agents/me'), 'tracker');
assert.equal(areaOf('/api/tracker/wos'), 'tracker');
assert.equal(areaOf('/v1/914/assize/rules'), 'other');
assert.equal(areaOf('/api/usage'), 'other');
assert.equal(areaOf('/'), 'other');

// --- the D1 wrapper adds each result's meta; first() answers like D1's; batch takes wrapped statements
{
  const c = { read: 0, written: 0, size: null }, db = wrapDb(T, c, true);
  await db.prepare('CREATE TABLE IF NOT EXISTS probe (a INTEGER, b TEXT)').run();
  await db.batch([1, 2, 3].map((i) => db.prepare('INSERT INTO probe (a, b) VALUES (?, ?)').bind(i, 'x' + i)));
  assert.ok(c.written >= 3, 'rows written summed over a batch: ' + c.written);
  assert.ok(c.size > 0, 'database size from meta.size_after: ' + c.size);
  const before = c.read;
  assert.deepEqual(await db.prepare('SELECT a, b FROM probe WHERE a = ?').bind(2).first(), { a: 2, b: 'x2' });
  assert.equal(await db.prepare('SELECT b FROM probe WHERE a = ?').bind(3).first('b'), 'x3');
  assert.equal(await db.prepare('SELECT b FROM probe WHERE a = ?').bind(99).first(), null);
  assert.ok(c.read >= before + 3, 'first() counts the rows it read: ' + (c.read - before));
  const r = await db.prepare('SELECT * FROM probe').all();
  assert.equal(r.results.length, 3);
  const nativeCount = (await T.prepare('SELECT COUNT(*) AS n FROM probe').first()).n;
  assert.equal(nativeCount, 3, 'the wrapped statements wrote through');
  await T.prepare('DROP TABLE probe').run();
  // the other binding counts rows too, not size
  const c2 = { read: 0, written: 0, size: null }, ae = wrapDb(env.AE, c2, false);
  await ae.prepare('SELECT * FROM store_access').all();
  assert.ok(c2.read >= 2 && c2.size === null);
}

// --- requests count by area with their rows; first request is awaited when there is no background (ctx = {})
assert.equal((await call('GET', '/v1/tracker/master')).status, 404);                       // tracker
assert.equal((await call('GET', '/v1/914/tracker/retrace/cursor')).status, 200);           // collector
assert.equal((await call('GET', '/v1/914/tracker/retrace/cursor')).status, 200);           // collector
assert.equal((await call('GET', '/v1/914/tracker/rfp')).status, 200);                      // tracker
assert.equal((await call('GET', '/v1/914/nothing')).status, 404);                          // other
assert.equal((await call('GET', '/v1/999/tracker/key')).status, 403);                      // refused (no access) still a request
{
  const r = await rows();
  assert.equal(r.collector.requests, 2);
  assert.equal(r.tracker.requests, 3);
  assert.equal(r.other.requests, 1);
  assert.ok(r.collector.rows_read > 0, 'collector rows read ' + r.collector.rows_read);
  assert.ok(r.tracker.rows_read > 0);
  const sz = await T.prepare('SELECT bytes FROM usage_size WHERE day = ?').bind(day).first();
  assert.ok(sz && sz.bytes > 0, 'size recorded');
}
// A request that writes: rows_written grows
{
  await call('POST', '/v1/914/tracker/daily', { day, metrics: { x: 1 } });                // may be refused; the access lookups still read
  const s = await call('POST', '/v1/914/tracker/retrace/pass', { portalCalls: 10, workerCalls: 2, seconds: 5 });
  assert.equal(s.status, 200);
  assert.ok((await rows()).collector.rows_written > 0, 'a request that wrote shows rows written');
}

// --- a counter failure never fails a request, and nothing is lost: the counts wait for the next flush
{
  await T.prepare('ALTER TABLE usage_load RENAME TO usage_load_off').run();
  const warn = console.warn; let warned = 0; console.warn = () => { warned++; };
  const before = (await T.prepare('SELECT requests FROM usage_load_off WHERE day = ? AND area = ?').bind(day, 'tracker').first()).requests;
  const r = await call('GET', '/v1/tracker/master');
  assert.equal(r.status, 404, 'the request itself answers normally');
  assert.ok(warned >= 1, 'the failure is logged');
  console.warn = warn;
  await T.prepare('ALTER TABLE usage_load_off RENAME TO usage_load').run();
  await call('GET', '/v1/tracker/master');                                                  // next flush carries the missed one too
  assert.equal((await rows()).tracker.requests, before + 2, 'the failed flush was retried, not dropped');
  // no TR binding at all (a misconfigured deploy): the request is still answered
  const m = meter({ APP_KEY: 'k' }, new Request('https://t.test/v1/1/tracker/key'));
  await m.done({}); assert.deepEqual(m.env, { APP_KEY: 'k' });
}

// --- in the background (waitUntil): requests only count in memory; one write per window
{
  const before = await rows(), waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) }, E2 = Object.assign({}, E, { USAGE_FLUSH_MS: '30' });
  for (let i = 0; i < 6; i++) await call('GET', '/v1/tracker/master', null, E2, ctx);
  assert.equal(waits.length, 1, 'one flush scheduled for six requests');
  assert.equal((await rows()).tracker.requests, before.tracker.requests, 'nothing written before the window ends');
  await Promise.all(waits);
  assert.equal((await rows()).tracker.requests, before.tracker.requests + 6);
}

// --- the collector's pass summary: stored per store and day; optional; bad bodies refused
{
  const p = (body) => call('POST', '/v1/914/tracker/retrace/pass', body);
  assert.equal((await p({ portalCalls: 1640, workerCalls: 71, seconds: 372, lookupSeconds: 360, browser: 'a1b2c3d4e5f6' })).status, 200);
  assert.equal((await p({ portalCalls: 100, workerCalls: 20, seconds: 30, browser: 'a1b2c3d4e5f6' })).status, 200);
  assert.equal((await p({ portalCalls: 100, workerCalls: 20, seconds: 30, browser: 'ffffffffffff' })).status, 200);
  assert.equal((await p({ portalCalls: 5, workerCalls: 1, seconds: 2 })).status, 200, 'browser and lookup are optional');
  for (const bad of [{}, { portalCalls: -1, workerCalls: 1, seconds: 1 }, { portalCalls: 'x', workerCalls: 1, seconds: 1 }, { portalCalls: 1.5, workerCalls: 1, seconds: 1 }, { portalCalls: 1, workerCalls: 1, seconds: 999999 }])
    assert.equal((await p(bad)).status, 400, JSON.stringify(bad));
  assert.equal((await call('POST', '/v1/999/tracker/retrace/pass', { portalCalls: 1, workerCalls: 1, seconds: 1 })).status, 403, 'a store without access is refused');
  const u = await T.prepare('SELECT * FROM usage_pass WHERE store = 914 AND day = ?').bind(day).first();
  // the pass from the earlier block (10, 2, 5) plus the four above
  assert.deepEqual([u.passes, u.portal_calls, u.worker_calls, u.seconds, u.lookup_passes, u.lookup_seconds], [5, 1640 + 100 + 100 + 5 + 10, 71 + 20 + 20 + 1 + 2, 372 + 30 + 30 + 2 + 5, 1, 360]);
  assert.equal((await T.prepare('SELECT COUNT(*) AS n FROM usage_browsers WHERE store = 914').first()).n, 2, 'two distinct browsers');
  assert.equal(passStmts(T, 1, { portalCalls: 1 }), null);
}

// --- the admin read: empty first, then a month of (test) rows
const owner = { email: 'owner@x.com', owner: true, scope: 'all', stores: [], canSee: () => true };
const only326 = { email: 'a@x.com', owner: false, scope: 'stores', stores: [326], canSee: (s) => s === 326 };
{
  await T.prepare('DELETE FROM usage_load').run(); await T.prepare('DELETE FROM usage_size').run();
  const u = await usageLoad(env, owner);
  assert.equal(u.firstDay, null, 'nothing counted yet'); assert.equal(u.global.days.length, 30);
  assert.ok(u.global.days.every((d) => d.requests === null), 'days before counting started are unknown, not zero');
  assert.equal(u.global.projection.status, 'early'); assert.equal(u.global.bytes, null);
}
{
  // Test data: 20 days ending yesterday, 1000 requests a day (800 tracker, 200 collector), the database growing 1 MB a day; today partial.
  const d = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const stmts = [];
  for (let n = 1; n <= 20; n++) {
    stmts.push(T.prepare('INSERT INTO usage_load VALUES (?, ?, ?, ?, ?)').bind(d(n), 'tracker', 800, 80000, 800), T.prepare('INSERT INTO usage_load VALUES (?, ?, ?, ?, ?)').bind(d(n), 'collector', 200, 20000, 400),
      T.prepare('INSERT INTO usage_size VALUES (?, ?)').bind(d(n), 100e6 + (20 - n) * 1e6));
  }
  stmts.push(T.prepare('INSERT INTO usage_load VALUES (?, ?, ?, ?, ?)').bind(day, 'tracker', 50, 500, 5));
  await T.batch(stmts);
  const u = await usageLoad(env, owner), g = u.global;
  assert.equal(u.firstDay, d(20)); assert.equal(g.days.length, 30);
  assert.equal(g.days.filter((x) => x.requests === null).length, 9, '30 days minus 20 counted minus today');
  assert.equal(g.days[29].requests, 50); assert.equal(g.days[28].requests, 1000);
  assert.equal(g.areas.find((a) => a.area === 'tracker').requests, 800 * 20 + 50);
  assert.equal(g.areas.find((a) => a.area === 'tracker').today, 50);
  assert.equal(g.areas.find((a) => a.area === 'retrace_admin').requests, 0);
  assert.equal(g.bytes, 119e6);
  // no store has reported a Retrace pass: the request pace is shown, no per-store projection
  const kept = (await T.prepare('SELECT * FROM usage_pass').all()).results;
  await T.prepare('DELETE FROM usage_pass').run();
  const none = (await usageLoad(env, owner)).global.projection;
  assert.equal(none.status, 'nostores'); assert.equal(none.month_requests, 30000); assert.equal(none.per_store, undefined);
  for (const r of kept) await T.prepare('INSERT INTO usage_pass VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(r.day, r.store, r.passes, r.portal_calls, r.worker_calls, r.seconds, r.lookup_passes, r.lookup_seconds).run();
}
{
  // 914 reported passes today (above): one active store → a projection with growth per store
  const u = await usageLoad(env, owner), p = u.global.projection;
  assert.equal(u.stores.map((s) => s.store).join(), '914');
  const s = u.stores[0];
  assert.deepEqual([s.passes, s.portalPerPass, s.workerPerPass, s.browsers, s.lookupPasses, s.lookupSeconds, s.name], [5, 371, 23, 2, 1, 360, 'Newport News']);
  assert.equal(p.status, 'ok'); assert.equal(p.stores, 1);
  assert.equal(p.month_requests, 30000); assert.equal(p.per_store, 30000);
  assert.equal(p.db_growth_per_store_month, 30e6, 'about 1 MB a day for one store');
  // a second store reporting halves the per-store average, and the growth per store
  await T.prepare("INSERT INTO usage_pass (day, store, passes, portal_calls, worker_calls, seconds) VALUES (?, 326, 1, 10, 2, 5)").bind(day).run();
  const q = (await usageLoad(env, owner)).global.projection;
  assert.equal(q.stores, 2); assert.equal(q.per_store, 15000); assert.equal(q.db_growth_per_store_month, 15e6);
  // scoped: only their stores' rows, no worker-wide totals
  const sc = await usageLoad(env, only326);
  assert.equal(sc.global, null); assert.equal(sc.scope, 'stores'); assert.deepEqual(sc.stores.map((x) => x.store), [326]);
  // no access object at all: no stores, no totals (fails closed)
  const nobody = await usageLoad(env, null), undef = await usageLoad(env, undefined);
  for (const x of [nobody, undef]) { assert.equal(x.global, null); assert.equal(x.scope, 'stores'); assert.deepEqual(x.stores, []); }
  assert.equal((await usageLoad(env, { email: 'x', scope: 'stores', stores: [] })).stores.length, 0, 'a person with no stores sees none');
  // growth that isn't there is left out, not invented
  await T.prepare('UPDATE usage_size SET bytes = 100000000').run();
  assert.equal((await usageLoad(env, owner)).global.projection.db_growth_per_store_month, null);
}

// --- retention
{
  await T.prepare("INSERT INTO usage_load VALUES ('2020-01-01', 'tracker', 1, 1, 1)").run();
  await pruneUsage(env);
  assert.equal((await T.prepare("SELECT COUNT(*) AS n FROM usage_load WHERE day = '2020-01-01'").first()).n, 0);
  await flush(T);
}

await dispose();
rmSync('.wrangler-test-usage', { recursive: true, force: true });
console.log('usage: all passed');
