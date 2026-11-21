// Linkpearl alerts (src/mobile-alerts.js): the 10-minute tick's rules (stuck, pickup, follow-up, quiet, digest, unlinked, coverage), the feed / poll / read / settings routes, per-phone thresholds and read state,
// store isolation, privacy, cost and retention. Local D1, everything invented. Routes are called through the Worker for auth, and directly
// (alertsApi with a fixed clock) for everything that depends on "now".
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup, worker, Z, TZ } from './mobile-helpers.mjs';
import { alertsApi, alertsTick, openMsBetween, normalize, mergeSettings, CAP_PER_TICK, RETENTION_DAYS, SQL } from '../src/mobile-alerts.js';

const T = await setup('.wrangler-test-mobile-alerts');
const { env, E, call, admin, registerPhone, approve, authed, scheduled } = T;
const TR = env.TR, AE = env.AE, D = 86400000, HR = 3600000, MIN = 60000;
const iso = (ms) => new Date(ms).toISOString();
const sqlStatements = (file) => readFileSync(file, 'utf8').replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean);

// The alerts tables come from the migration file (schema.sql is a shared file this stream does not edit); the migration must be idempotent.
for (let pass = 0; pass < 2; pass++) for (const f of ['2026-11-13-mobile-alerts.sql', '2026-11-16-mobile-alerts-items.sql']) for (const s of sqlStatements('migrations/' + f)) await TR.prepare(s).run();
await AE.prepare('CREATE TABLE IF NOT EXISTS auto_marks (store INTEGER NOT NULL, wo INTEGER NOT NULL, due TEXT NOT NULL, created_at TEXT NOT NULL, removed_at TEXT, kind TEXT, PRIMARY KEY (store, wo))').run();
await AE.prepare('CREATE TABLE IF NOT EXISTS wo_closed (store INTEGER NOT NULL, wo INTEGER NOT NULL, closed_at TEXT NOT NULL, PRIMARY KEY (store, wo))').run();

// ---- phones: A (914 + 326), B (914), C (326), a pending one, a Mac agent
const A = await registerPhone('Pixel A'), B = await registerPhone('Pixel B'), C = await registerPhone('Pixel C');
for (const [p, st] of [[A, [914, 326]], [B, [914]], [C, [326]]]) { assert.equal((await approve(p, st)).status, 200); p.stores = st; }
const BASE = '/v1/agents/m/alerts';

// Direct calls with a fixed clock (the same dispatch inputs index.js gives alertsApi).
const hFor = (nowMs) => ({
  json: (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } }),
  fail: (status, error) => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } }),
  readJson: async (req, max) => { const t = await req.text(); if (t.length > max) throw Object.assign(new Error('too large'), { status: 413 }); try { return t ? JSON.parse(t) : {}; } catch (_) { throw Object.assign(new Error('bad JSON'), { status: 400 }); } },
  int: (v) => (Number.isInteger(v) ? v : (typeof v === 'string' && /^\d{1,12}$/.test(v) ? Number(v) : null)), clean: (v) => String(v), iso: (v) => v, now: () => iso(nowMs), log: async () => {},
});
const NOW = Date.parse(Z('2026-10-15', 16));
const seen = []; // every response body, for the privacy check at the end
const api = async (p, path, { method = 'GET', body, now = NOW } = {}) => {
  const url = new URL('https://t.test/v1/agents/m' + path), req = new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    const r = await alertsApi(req, E, url, { id: p.id, name: p.name, kind: 'phone', stores: p.stores, active: true, publicJwk: p.publicJwk }, hFor(now));
    const j = await r.json(); seen.push(JSON.stringify(j));
    return { status: r.status, j };
  } catch (e) { if (e.status && e.status < 500) return { status: e.status, j: { error: e.message } }; throw e; }
};
const tick = (now, env2 = E) => alertsTick(env2, now);
const rows = async (sql, ...b) => (await TR.prepare(sql).bind(...b).all()).results;
const alertRows = (where = '1', ...b) => rows(`SELECT * FROM alerts WHERE ${where} ORDER BY id`, ...b);
const exec = (...stmts) => TR.batch(stmts);

const woRow = (store, n, status, open = 1) => TR.prepare("INSERT OR REPLACE INTO workorders (store, wo, status_id, program_name, device, created_at, is_open, plain, card) VALUES (?, ?, ?, 'Retail', 'iPhone 13', ?, ?, ?, ?)")
  .bind(store, n, status, Z('2026-10-01', 10), open, JSON.stringify({ customer: { name: 'Jane Q Customer', phone: '757-555-0142' } }), 'v1.sealedJaneQCustomer');
const period = (store, n, status, start, end = null) => TR.prepare('INSERT INTO status_periods (store, wo, status_id, start_at, end_at) VALUES (?, ?, ?, ?, ?)').bind(store, n, status, start, end);
const rfp = (store, n, start) => TR.prepare('INSERT INTO rfp_periods (store, wo, start_at, value) VALUES (?, ?, ?, 100)').bind(store, n, start);
const scan = (store, at) => TR.prepare("INSERT INTO scans (store, at, by_name, open_count) VALUES (?, ?, 'Tracker', 10)").bind(store, at);
const mark = (store, n, due, kind = 'rfp', removed = null) => AE.prepare('INSERT OR REPLACE INTO auto_marks (store, wo, due, created_at, removed_at, kind) VALUES (?, ?, ?, ?, ?, ?)').bind(store, n, due, Z('2026-10-01', 10), removed, kind);

// Clean slate between sections; each phone's state row is created at once (a new phone starts with everything so far read).
// The sections written before the digest existed switch it off (a digest is made from 8:00 every day for phones that want one).
const more = []; // phones added later in the file
async function reset({ digest = false } = {}) {
  for (const t of ['alerts', 'status_periods', 'rfp_periods', 'scans', 'alert_reads', 'alert_device', 'alert_items', 'inv_so_need', 'inv_so_wo', 'inv_movements', 'inv_verify', 'sales', 'sales_days', 'daily_metrics']) await TR.prepare('DELETE FROM ' + t).run();
  await TR.prepare('DELETE FROM workorders WHERE wo >= 100').run();
  await AE.prepare('DELETE FROM auto_marks').run(); await AE.prepare('DELETE FROM wo_closed').run();
  for (const p of [A, B, C, ...more]) { await api(p, '/alerts/settings'); if (!digest) await api(p, '/alerts/settings', { method: 'PUT', body: { types: { digest: { on: false } } } }); }
}
const section = (s) => console.log('  ' + s);
const THU = (h, m = 0) => Date.parse(Z('2026-10-15', h, m));       // Thursday, store open 10–19
const FRI = (h, m = 0) => Date.parse(Z('2026-10-16', h, m));
const SAT = (h, m = 0) => Date.parse(Z('2026-10-17', h, m));
const SUN = (h, m = 0) => Date.parse(Z('2026-10-18', h, m));       // 914 is closed Sundays
const MON = (h, m = 0) => Date.parse(Z('2026-10-19', h, m));
const put = (p, body, o = {}) => api(p, '/alerts/settings', Object.assign({ method: 'PUT', body }, o));
assert.equal(TZ, 'America/New_York');

// ================================================================ routes are phone-only and device-authenticated
section('auth');
const pending = await registerPhone('Waiting');
assert.equal((await authed(pending, BASE)).status, 403, 'pending phone');
assert.equal((await authed(null, BASE)).status, 401, 'no token');
assert.equal((await authed({ id: A.id, token: 'ab'.repeat(32) }, BASE)).status, 401, 'wrong token');
const mac = await call('POST', '/v1/agents/register', { id: 'c'.repeat(32), name: 'Mac audit', publicJwk: A.publicJwk, token: 'd'.repeat(64) });
assert.equal(mac.status, 200); assert.equal(mac.j.kind, 'agent');
assert.equal((await approve({ id: 'c'.repeat(32), publicJwk: A.publicJwk }, [914])).status, 200);
for (const path of [BASE, BASE + '/new', BASE + '/settings']) { const r = await authed({ id: 'c'.repeat(32), token: 'd'.repeat(64) }, path); assert.equal(r.status, 403); assert.equal(r.j.error, 'not a phone'); }
const revoked = await registerPhone('Revoked'); await approve(revoked, [914]);
assert.equal((await authed(revoked, BASE)).status, 200, 'works before revocation');
assert.equal((await admin('owner@x.com', 'POST', `/agents/${revoked.id}/remove`)).status, 200);
assert.equal((await authed(revoked, BASE)).status, 401, 'revoked phone');
assert.equal((await call('GET', BASE, null, { authorization: 'Bearer ' + A.id + '.' + A.token, 'x-aethernet-key': 'wrong' })).status, 403, 'app key needed');
for (const [m, path, body] of [['GET', BASE], ['GET', BASE + '/new'], ['GET', BASE + '/settings'], ['POST', BASE + '/read', { all: true }]]) {
  const r = await authed(A, path, { method: m, body }); assert.equal(r.status, 200, path + ' ' + JSON.stringify(r.j)); assert.equal(r.h.get('cache-control'), 'no-store');
}
assert.equal((await authed(A, '/v1/agents/m/push/register', { method: 'POST', body: {} })).status, 404, 'no push service');
assert.equal((await authed(A, BASE + '/nope')).status, 404);
assert.equal((await authed(A, BASE, { method: 'POST', body: {} })).status, 405);
assert.equal((await authed(A, BASE + '/read')).status, 405);
await scheduled('*/10 * * * *'); // the Worker's cron entry runs the tick (real clock) without throwing

// ================================================================ settings: shape, defaults, ranges, validation
section('settings');
await reset();
const s0 = await api(A, '/alerts/settings');
assert.equal(s0.status, 200); assert.deepEqual(s0.j.stores, [914, 326]);
assert.deepEqual(s0.j.settings, { types: { stuck: { on: true, days: 3 }, pickup: { on: true, days: 7 }, followup: { on: true, hour: 9 }, quiet: { on: true, hours: 2 },
  digest: { on: false, hour: 8 }, unlinked: { on: true, hours: 1 }, coverage: { on: true } },
  quietHours: { on: true, from: '22:00', to: '07:00' }, stores: { 914: true, 326: true } }, 'reset() switched the digest off');
assert.deepEqual(normalize({}, [914]).types, { stuck: { on: true, days: 3 }, pickup: { on: true, days: 7 }, followup: { on: true, hour: 9 }, quiet: { on: true, hours: 2 },
  digest: { on: true, hour: 8 }, unlinked: { on: true, hours: 1 }, coverage: { on: true } }, 'defaults');
assert.deepEqual(s0.j.ranges, { stuckDays: [1, 30], pickupDays: [1, 30], quietHours: [1, 12], followupHour: [0, 23], digestHour: [0, 23], unlinkedHours: [1, 48] });
assert.deepEqual(s0.j.defaults.types.digest, { on: true, hour: 8 });
let r = await put(A, { types: { stuck: { days: 5 }, quiet: { on: false, hours: 4 } }, quietHours: { from: '21:30', to: '06:00' }, stores: { 326: false } });
assert.equal(r.status, 200); assert.equal(r.j.settings.types.stuck.days, 5); assert.equal(r.j.settings.types.stuck.on, true, 'untouched keys keep their value');
assert.deepEqual(r.j.settings.types.quiet, { on: false, hours: 4 }); assert.deepEqual(r.j.settings.quietHours, { on: true, from: '21:30', to: '06:00' }); assert.deepEqual(r.j.settings.stores, { 914: true, 326: false });
assert.deepEqual((await api(A, '/alerts/settings')).j.settings, r.j.settings, 'persisted');
assert.equal((await api(B, '/alerts/settings')).j.settings.types.stuck.days, 3, 'another phone is unaffected');
for (const [body, status, msg] of [
  [{ types: { stuck: { days: 0 } } }, 400, 'types.stuck.days: days must be a whole number from 1 to 30'],
  [{ types: { stuck: { days: 31 } } }, 400, /from 1 to 30/], [{ types: { stuck: { days: 2.5 } } }, 400, /whole number/], [{ types: { stuck: { days: '3' } } }, 400, /whole number/],
  [{ types: { pickup: { days: 99 } } }, 400, /types\.pickup\.days/], [{ types: { quiet: { hours: 13 } } }, 400, 'types.quiet.hours: hours of silence must be a whole number from 1 to 12'],
  [{ types: { quiet: { hours: 0 } } }, 400, /from 1 to 12/], [{ types: { followup: { hour: 24 } } }, 400, /from 0 to 23/], [{ types: { stuck: { on: 'yes' } } }, 400, 'types.stuck.on must be true or false'],
  [{ types: { nope: {} } }, 400, 'unknown setting "types.nope"'], [{ types: { stuck: { day: 3 } } }, 400, 'unknown setting "types.stuck.day"'], [{ wat: 1 }, 400, 'unknown setting "wat"'],
  [{ types: { digest: { hour: 24 } } }, 400, 'types.digest.hour: hour of the day must be a whole number from 0 to 23'], [{ types: { digest: { hour: -1 } } }, 400, /from 0 to 23/],
  [{ types: { unlinked: { hours: 0 } } }, 400, 'types.unlinked.hours: hours without a work order must be a whole number from 1 to 48'], [{ types: { unlinked: { hours: 49 } } }, 400, /from 1 to 48/],
  [{ types: { coverage: { hours: 1 } } }, 400, 'unknown setting "types.coverage.hours"'], [{ types: { coverage: { on: 'no' } } }, 400, 'types.coverage.on must be true or false'],
  [{ quietHours: { from: '25:00' } }, 400, /quietHours\.from must be a time/], [{ quietHours: { to: '7am' } }, 400, /quietHours\.to must be a time/], [{ quietHours: { from: '06:00', to: '06:00' } }, 400, /must differ/],
  [{ quietHours: { on: 1 } }, 400, 'quietHours.on must be true or false'], [{ stores: { abc: true } }, 400, /not a store number/], [{ stores: { 914: 'no' } }, 400, 'stores.914 must be true or false'],
  [{ stores: { 536: false } }, 403, 'not your store'], [[], 400, 'body must be a JSON object'], ['x', 400, 'body must be a JSON object'],
]) { const x = await put(A, body); assert.equal(x.status, status, JSON.stringify(body) + ' ' + JSON.stringify(x.j)); typeof msg === 'string' ? assert.equal(x.j.error, msg) : assert.match(x.j.error, msg); }
assert.deepEqual((await api(A, '/alerts/settings')).j.settings, r.j.settings, 'bad bodies change nothing');
assert.equal((await put(A, {})).status, 200, 'an empty change is a no-op');
assert.equal((await put(A, { stores: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [i + 1000, true])) })).status, 413, 'size cap');
assert.equal((await worker.fetch(new Request('https://t.test' + BASE + '/settings', { method: 'PUT', body: '{nope', headers: { 'x-aethernet-key': 'k', authorization: 'Bearer ' + A.id + '.' + A.token } }), E, {})).status, 400, 'bad JSON through the Worker');
const ps = await authed(A, BASE + '/settings', { method: 'PUT', body: { types: { stuck: { days: 4 } } } });
assert.equal(ps.status, 200); assert.equal(ps.j.settings.types.stuck.days, 4, 'PUT through the Worker');
assert.deepEqual(normalize({ types: { stuck: { days: 99 } }, quietHours: { from: 'x' } }, [914]).types.stuck, { on: true, days: 3 }, 'junk in storage falls back to defaults');
assert.throws(() => mergeSettings(normalize({}, [914]), { types: { stuck: { days: 0 } } }, [914]), /1 to 30/);
r = await put(C, { types: { digest: { on: true, hour: 6 }, unlinked: { hours: 48 }, coverage: { on: false } } });
assert.equal(r.status, 200); assert.deepEqual([r.j.settings.types.digest, r.j.settings.types.unlinked, r.j.settings.types.coverage], [{ on: true, hour: 6 }, { on: true, hours: 48 }, { on: false }]);
assert.deepEqual(normalize({ types: { digest: { hour: 30 }, unlinked: { hours: 0 } } }, [914]).types.digest, { on: true, hour: 8 }, 'junk digest hour falls back');

// ================================================================ rule: stuck work order
section('stuck');
await reset();
await exec(woRow(914, 101, 9), period(914, 101, 9, iso(NOW - 3 * D)),
  woRow(914, 103, 9),                                                                  // no status_periods row: start unknown
  woRow(914, 104, 13), period(914, 104, 13, iso(NOW - 10 * D)),                         // Ready for pickup: the pickup rule covers it
  woRow(914, 105, 9, 0), period(914, 105, 9, iso(NOW - 10 * D)),                        // closed work order
  woRow(914, 106, 9), period(914, 106, 9, iso(NOW - 10 * D), iso(NOW - 9 * D)),          // an old, ended period only
  woRow(536, 107, 9), period(536, 107, 9, iso(NOW - 10 * D)));                          // a store no phone is approved for
await tick(NOW);
assert.equal((await alertRows()).length, 0, 'exactly 3 days is not longer than 3 days');
const st = await tick(NOW + 1000);
let al = await alertRows(); assert.equal(al.length, 1, JSON.stringify(al)); assert.equal(st.created, 1); assert.ok(!st.error);
assert.deepEqual([al[0].store, al[0].type, al[0].wo, al[0].level, al[0].backfill, al[0].created_at], [914, 'stuck', 101, 3, 0, iso(NOW + 1000)]);
assert.deepEqual(JSON.parse(al[0].data), { statusId: 9, status: 'Diagnostics', days: 3, since: iso(NOW - 3 * D) });
for (let i = 1; i <= 40; i++) await tick(NOW + 1000 + i * 10 * MIN);                    // every 10 minutes for almost 7 hours
assert.deepEqual((await alertRows()).map((x) => x.wo), [101], 'one alert per status period however many ticks; unknown start, Ready for pickup, closed, ended and unapproved-store ones are skipped');
await exec(woRow(914, 102, 10), period(914, 102, 10, iso(NOW - 10 * D)));                // first seen late (already 10 days in): feed only
await tick(NOW + 8 * HR);
al = await alertRows('wo = 102'); assert.equal(al.length, 1); assert.equal(al[0].backfill, 1); assert.equal(JSON.parse(al[0].data).days, 10);
const t1 = NOW + 9 * HR;                                                                 // leaves the status and gets stuck again
await exec(TR.prepare('UPDATE status_periods SET end_at = ? WHERE wo = 101').bind(iso(t1)), period(914, 101, 10, iso(t1)), TR.prepare('UPDATE workorders SET status_id = 10 WHERE wo = 101'));
await tick(t1 + 3 * D - 2000); assert.equal((await alertRows('wo = 101')).length, 1, 'not yet stuck in the new status');
await tick(t1 + 3 * D + 1000); al = await alertRows('wo = 101'); assert.equal(al.length, 2); assert.equal(JSON.parse(al[1].data).statusId, 10); assert.equal(JSON.parse(al[1].data).status, 'Work in progress');
const t2 = t1 + 4 * D;
await exec(TR.prepare('UPDATE status_periods SET end_at = ? WHERE wo = 101 AND end_at IS NULL').bind(iso(t2)), period(914, 101, 9, iso(t2)), TR.prepare('UPDATE workorders SET status_id = 9 WHERE wo = 101'));
await tick(t2 + 3 * D + 1000); assert.equal((await alertRows('wo = 101')).length, 3, 'back in Diagnostics: stuck again, alerts again');
await TR.prepare('UPDATE status_periods SET start_at = ? WHERE wo = 101 AND start_at = ?').bind(iso(t2 - HR), iso(t2)).run(); // the status history moved the start
for (let i = 0; i < 5; i++) await tick(t2 + 3 * D + 20 * MIN + i * 10 * MIN);
assert.equal((await alertRows('wo = 101')).length, 3, 'a shifted start inside the same period is not a new alert');

// ================================================================ rule: waiting for pickup (one summary per store per day)
section('pickup');
await reset();
const nine = THU(9);
await exec(rfp(914, 201, iso(nine - 12 * D)), rfp(914, 202, iso(nine - 9 * D)), rfp(914, 203, iso(nine - 7 * D - 5 * MIN)), rfp(914, 204, iso(nine - 5 * D)), rfp(914, 205, iso(nine - 8 * D)),
  TR.prepare('UPDATE rfp_periods SET end_at = ? WHERE wo = 205').bind(iso(nine - D)), rfp(326, 206, iso(nine - 3 * D)), rfp(536, 207, iso(nine - 30 * D)));
await tick(nine - 5 * MIN); assert.equal((await alertRows()).length, 0, 'before 9:00 local');
await tick(nine); al = await alertRows(); assert.equal(al.length, 1, JSON.stringify(al));
assert.deepEqual([al[0].store, al[0].type, al[0].wo, al[0].level, al[0].subject], [914, 'pickup', null, 7, '2026-10-15']);
assert.deepEqual(JSON.parse(al[0].data), { count: 3, days: 7, oldestDays: 12 }, 'three devices past 7 days; the 5-day one, the picked-up one and other stores do not count');
for (let i = 1; i < 60; i++) await tick(nine + i * 10 * MIN); assert.equal((await alertRows()).length, 1, 'once per store per day');
await tick(nine + D); al = await alertRows(); assert.equal(al.length, 2, 'the next day alerts again'); assert.equal(al[1].subject, '2026-10-16');
await tick(SUN(12)); assert.equal((await alertRows()).length, 2, 'not on a day the store is closed (Sunday)');
await exec(TR.prepare('UPDATE rfp_periods SET start_at = ? WHERE wo = 203').bind(iso(MON(9) - 7 * D)), TR.prepare('UPDATE rfp_periods SET end_at = ? WHERE wo != 203 AND end_at IS NULL').bind(iso(SUN(9))));
await tick(MON(9)); assert.equal((await alertRows()).length, 2, 'exactly 7 days is not over 7 days');
await tick(MON(9) + 1000); al = await alertRows(); assert.equal(al.length, 3); assert.equal(JSON.parse(al[2].data).count, 1);
assert.deepEqual([...new Set(al.map((x) => x.store))], [914], 'Lexington has no approved phone; Lynnhaven is under the threshold');

// ================================================================ rule: follow-up due (Waymark's database)
section('follow-up');
await reset();
await AE.batch([mark(914, 301, '2026-10-15'), mark(914, 302, '2026-10-15', 'callback'), mark(914, 303, '2026-10-15', 'rfp', iso(NOW - D)), mark(914, 304, '2026-10-16'), mark(914, 305, '2026-10-14'), mark(914, 306, '2026-10-15'), mark(536, 307, '2026-10-15'),
  AE.prepare('INSERT INTO wo_closed (store, wo, closed_at) VALUES (914, 306, ?)').bind(iso(NOW))]);
await tick(THU(8, 50)); assert.equal((await alertRows()).length, 0, 'before the follow-up hour');
await tick(THU(9)); al = await alertRows('type = ?', 'followup');
assert.deepEqual(al.map((x) => [x.store, x.wo, x.level, x.subject]), [[914, 301, 9, '301@2026-10-15'], [914, 302, 9, '302@2026-10-15']], 'due today only; not removed, not closed, not another day or store');
assert.deepEqual(JSON.parse(al[1].data), { due: '2026-10-15', kind: 'callback' });
for (let i = 1; i < 30; i++) await tick(THU(9) + i * 10 * MIN); assert.equal((await alertRows('type = ?', 'followup')).length, 2, 'one alert per work order per due date');
await tick(FRI(9)); assert.deepEqual((await alertRows('type = ?', 'followup')).slice(2).map((x) => x.wo), [304], 'the next day: the mark due that day');
await AE.prepare('UPDATE auto_marks SET due = ? WHERE wo = 301').bind('2026-10-17').run();   // the date moved: a new due date alerts again
await tick(SAT(9)); assert.deepEqual((await alertRows('type = ?', 'followup')).slice(3).map((x) => x.wo), [301]);

// ================================================================ rule: store gone quiet
section('gone quiet');
await reset();
await exec(scan(914, iso(THU(13, 40))));
await tick(THU(15, 40)); assert.equal((await alertRows('type = ?', 'quiet')).length, 0, 'exactly 2 hours of silence is not longer than 2 hours');
await tick(THU(15, 41)); al = await alertRows('type = ?', 'quiet'); assert.equal(al.length, 1);
assert.deepEqual([al[0].store, al[0].level, al[0].subject, al[0].cleared_at], [914, 2, iso(THU(13, 40)), null]); assert.deepEqual(JSON.parse(al[0].data), { since: iso(THU(13, 40)), hours: 2 });
for (let i = 2; i < 40; i++) await tick(THU(15, 40) + i * 10 * MIN); assert.equal((await alertRows('type = ?', 'quiet')).length, 1, 'once per quiet spell');
assert.equal((await alertRows('store = 326')).length, 0, 'Lynnhaven has no scans at all: nothing to compare');
await exec(scan(914, iso(THU(18, 30))));
await tick(THU(18, 40)); al = await alertRows(); const q = al.find((x) => x.type === 'quiet'), back = al.find((x) => x.type === 'back');
assert.equal(q.cleared_at, iso(THU(18, 40)), 'cleared when scans resume'); assert.ok(back, 'a low-key back entry'); assert.deepEqual(JSON.parse(back.data), { since: iso(THU(13, 40)), resumedAt: iso(THU(18, 30)) });
await tick(THU(18, 50)); assert.equal((await alertRows('type = ?', 'back')).length, 1, 'one back entry per spell');
await tick(THU(18, 59)); assert.equal((await alertRows('type = ?', 'quiet')).length, 1, 'no new spell yet');
await reset();                                                                            // open hours only
await exec(scan(914, iso(THU(18, 30))));
await tick(THU(19, 30)); await tick(THU(23)); await tick(FRI(9)); assert.equal((await alertRows()).length, 0, 'closed hours do not count and do not alert');
await tick(FRI(10, 30)); assert.equal((await alertRows()).length, 0, 'Friday 10:30: 30 min before closing + 30 min open');
await tick(FRI(11, 30)); assert.equal((await alertRows()).length, 0, '30 + 90 = exactly 2 hours');
await tick(FRI(11, 31)); assert.equal((await alertRows('type = ?', 'quiet')).length, 1, 'fires once 2 open hours have passed');
await reset();
await exec(scan(914, iso(SAT(18, 30))));
await tick(SUN(12)); await tick(SUN(18)); assert.equal((await alertRows()).length, 0, 'not on a closed day');
await tick(MON(11, 30)); assert.equal((await alertRows()).length, 0); await tick(MON(11, 31)); assert.equal((await alertRows('type = ?', 'quiet')).length, 1, 'Monday: Saturday evening + Monday morning');
assert.equal(openMsBetween(914, SAT(18, 30), MON(11, 30), TZ), 2 * HR); assert.equal(openMsBetween(536, SAT(18, 30), SUN(12), TZ), 30 * MIN + 2 * HR, 'Lexington is open Sundays');

// ================================================================ the feed and the poll
section('feed and poll');
await reset();
const crossing = THU(11, 0);                                                              // three stuck alerts, raised during the store day
await exec(woRow(914, 401, 9), period(914, 401, 9, iso(crossing - 3 * D - 5 * MIN)), woRow(914, 402, 3), period(914, 402, 3, iso(crossing - 3 * D - 6 * MIN)), woRow(326, 403, 10), period(326, 403, 10, iso(crossing - 3 * D - 7 * MIN)));
const first = await api(A, '/alerts/new', { now: crossing });
assert.deepEqual(first.j, { v: 1, cursor: 0, alerts: [] }, 'first run, no cursor: "from now on"');
await tick(crossing);
const now1 = crossing + 5 * MIN;
let fa = (await api(A, '/alerts', { now: now1 })).j, fb = (await api(B, '/alerts', { now: now1 })).j, fc = (await api(C, '/alerts', { now: now1 })).j;
assert.equal(fa.alerts.length, 3); assert.equal(fa.unread, 3); assert.equal(fa.more, false); assert.equal(fa.next, null); assert.equal(fa.cursor, Math.max(...fa.alerts.map((x) => x.id)));
assert.deepEqual(fa.alerts.map((x) => x.id), fa.alerts.map((x) => x.id).sort((a, b) => b - a), 'newest first');
assert.deepEqual(Object.keys(fa.alerts[0]).sort(), ['at', 'days', 'id', 'notify', 'read', 'since', 'status', 'statusId', 'store', 'type', 'wo']);
assert.ok(fa.alerts.every((x) => x.read === false && x.notify === true));
assert.deepEqual(fb.alerts.map((x) => x.wo).sort(), [401, 402], 'phone B: Newport News only'); assert.deepEqual(fc.alerts.map((x) => x.wo), [403], 'phone C: Lynnhaven only');
assert.equal(fb.unread, 2); assert.equal(fc.unread, 1);
assert.deepEqual((await api(A, '/alerts?store=326', { now: now1 })).j.alerts.map((x) => x.wo), [403], 'store filter');
assert.equal((await api(C, '/alerts?store=914', { now: now1 })).status, 403, 'a store that is not yours is refused, never ignored'); assert.equal((await api(C, '/alerts?store=abc')).status, 400);
assert.equal((await api(A, '/alerts?after=x')).status, 400); assert.equal((await api(A, '/alerts/new?since=x')).status, 400);
// the background poll
const poll0 = (await api(A, '/alerts/new?since=0', { now: now1 })).j;
assert.deepEqual(Object.keys(poll0).sort(), ['alerts', 'cursor', 'v']); assert.equal(poll0.alerts.length, 3); assert.equal(poll0.cursor, fa.cursor); assert.ok(poll0.alerts.every((x) => !('read' in x) && !('notify' in x)));
assert.deepEqual(poll0.alerts.map((x) => x.id), poll0.alerts.map((x) => x.id).sort((a, b) => a - b), 'oldest first, so the cursor can follow');
assert.deepEqual((await api(A, '/alerts/new?since=0', { now: now1 })).j, poll0, 'polling twice with the same cursor gives the same answer (nothing is consumed)');
assert.deepEqual((await api(A, '/alerts/new?since=' + poll0.cursor, { now: now1 })).j, { v: 1, cursor: poll0.cursor, alerts: [] }, 'with the new cursor: nothing again, no duplicates');
assert.equal((await api(A, '/alerts/new?since=999999', { now: now1 })).j.cursor, 999999, 'a cursor ahead of the table is kept');
// a later alert arrives after the cursor
await exec(woRow(914, 404, 9), period(914, 404, 9, iso(now1 - 3 * D)));
await tick(now1 + 10 * MIN);
const poll1 = (await api(A, '/alerts/new?since=' + poll0.cursor, { now: now1 + 11 * MIN })).j;
assert.deepEqual(poll1.alerts.map((x) => x.wo), [404]); assert.ok(poll1.cursor > poll0.cursor);
assert.equal((await api(C, '/alerts/new?since=0', { now: now1 + 11 * MIN })).j.alerts.length, 1, 'Lynnhaven phone never receives Newport News alerts');
// paging: 60 more alerts for 914
await exec(...Array.from({ length: 60 }, (_, i) => TR.prepare("INSERT INTO alerts (store, type, subject, level, wo, created_at, data) VALUES (914, 'stuck', ?, 3, ?, ?, '{\"statusId\":9,\"status\":\"Diagnostics\",\"days\":3}')").bind('x' + i, 9000 + i, iso(now1 + 12 * MIN))));
const nowP = now1 + 13 * MIN;
const p1 = (await api(A, '/alerts?limit=25', { now: nowP })).j, p2 = (await api(A, '/alerts?limit=25&before=' + p1.next, { now: nowP })).j, p3 = (await api(A, '/alerts?limit=100&before=' + p2.next, { now: nowP })).j;
assert.equal(p1.alerts.length, 25); assert.equal(p1.more, true); assert.equal(p2.alerts.length, 25); assert.equal(p2.more, true); assert.equal(p3.more, false); assert.equal(p1.alerts.length + p2.alerts.length + p3.alerts.length, 4 + 60 );
assert.equal(new Set([...p1.alerts, ...p2.alerts, ...p3.alerts].map((x) => x.id)).size, 64, 'pages do not overlap');
assert.equal((await api(A, '/alerts?limit=500', { now: nowP })).j.alerts.length, 64, 'limit is capped at 100');
assert.deepEqual((await api(A, '/alerts?after=' + p1.alerts[24].id, { now: nowP })).j.alerts.length, 24, 'after=cursor: newer entries only');
let pc = poll1.cursor, got = [], laps = 0;
for (;;) { const x = (await api(A, '/alerts/new?since=' + pc, { now: nowP })).j; got.push(...x.alerts); pc = x.cursor; laps++; if (!x.more) break; }
assert.equal(got.length, 60); assert.equal(new Set(got.map((x) => x.id)).size, 60); assert.equal(laps, 2, 'a poll returns at most 50 entries and says "more"'); assert.equal(got.length, 60);

// ================================================================ read state is per phone
section('read state');
await reset();
await exec(woRow(914, 411, 9), period(914, 411, 9, iso(crossing - 3 * D - 1000)), woRow(914, 412, 9), period(914, 412, 9, iso(crossing - 3 * D - 2000)), woRow(326, 413, 9), period(326, 413, 9, iso(crossing - 3 * D - 3000)));
await tick(crossing);
const ids = (await alertRows()).map((x) => x.id);
assert.equal((await api(A, '/alerts', { now: now1 })).j.unread, 3); assert.equal((await api(B, '/alerts', { now: now1 })).j.unread, 2);
r = await api(A, '/alerts/read', { method: 'POST', body: { ids: [ids[0]] }, now: now1 }); assert.deepEqual(r.j, { ok: true, unread: 2 });
assert.equal((await api(B, '/alerts', { now: now1 })).j.unread, 2, 'phone B has not read it');
fa = (await api(A, '/alerts', { now: now1 })).j; assert.equal(fa.alerts.find((x) => x.id === ids[0]).read, true); assert.equal(fa.alerts.find((x) => x.id === ids[0]).notify, false);
assert.deepEqual((await api(A, '/alerts/new?since=0', { now: now1 })).j.alerts.map((x) => x.id), ids.slice(1), 'read alerts do not notify');
assert.deepEqual((await api(A, '/alerts/read', { method: 'POST', body: { ids: [ids[0]] }, now: now1 })).j, { ok: true, unread: 2 }, 'idempotent');
// a phone cannot mark another store's alerts
const c0 = (await api(C, '/alerts', { now: now1 })).j.unread; r = await api(C, '/alerts/read', { method: 'POST', body: { ids }, now: now1 });
assert.equal(r.j.unread, 0, 'C read its own Lynnhaven alert'); assert.equal((await api(B, '/alerts', { now: now1 })).j.unread, 2, 'and nothing of Newport News'); assert.equal(c0, 1);
assert.equal((await api(A, '/alerts/read', { method: 'POST', body: { ids: [] }, now: now1 })).status, 400); assert.equal((await api(A, '/alerts/read', { method: 'POST', body: { ids: [0] }, now: now1 })).status, 400);
assert.equal((await api(A, '/alerts/read', { method: 'POST', body: { ids: Array.from({ length: 101 }, (_, i) => i + 1) }, now: now1 })).status, 400); assert.equal((await api(A, '/alerts/read', { method: 'POST', body: {}, now: now1 })).status, 400);
assert.equal((await api(A, '/alerts/read', { method: 'POST', body: { all: true, store: 536 }, now: now1 })).status, 403);
r = await api(A, '/alerts/read', { method: 'POST', body: { all: true, store: 326 }, now: now1 }); assert.equal(r.j.unread, 1, 'mark one store read');
r = await api(A, '/alerts/read', { method: 'POST', body: { all: true }, now: now1 }); assert.deepEqual(r.j, { ok: true, unread: 0 });
assert.equal((await api(B, '/alerts', { now: now1 })).j.unread, 2, 'mark all on A leaves B alone'); assert.equal((await rows('SELECT COUNT(*) AS n FROM alert_reads WHERE device_id = ?', A.id))[0].n, 0, 'mark all collapses into the read cursor');
await exec(woRow(914, 414, 9), period(914, 414, 9, iso(now1 - 3 * D - 1000))); await tick(now1 + 10 * MIN);
assert.equal((await api(A, '/alerts', { now: now1 + 11 * MIN })).j.unread, 1, 'a new alert after mark-all is unread');
// a phone that first looks later starts with the history read (the first-run cursor handles notifications)
const Dp = await registerPhone('Pixel D'); await approve(Dp, [914]); Dp.stores = [914]; more.push(Dp);
fa = (await api(Dp, '/alerts', { now: now1 + 11 * MIN })).j; assert.equal(fa.unread, 0); assert.ok(fa.alerts.length === 3 && fa.alerts.every((x) => x.read && !x.notify));

// ================================================================ switches and quiet hours are applied on read; the feed stays complete
section('switches and quiet hours');
await reset();
const n0 = THU(11), cr2 = THU(18, 50);
await exec(woRow(914, 421, 9), period(914, 421, 9, iso(n0 - 3 * D - 1000)), woRow(326, 422, 9), period(326, 422, 9, iso(n0 - 3 * D - 2000)));
await tick(n0);
const nowS = n0 + 5 * MIN, feedIds = async (p, now = nowS) => (await api(p, '/alerts', { now })).j.alerts;
await put(A, { types: { stuck: { on: false } } }, { now: nowS });
fa = (await api(A, '/alerts', { now: nowS })).j; assert.equal(fa.alerts.length, 2, 'a switched-off type stays in the feed'); assert.ok(fa.alerts.every((x) => x.notify === false)); assert.equal(fa.unread, 0, 'and adds no badge');
r = (await api(A, '/alerts/new?since=0', { now: nowS })).j; assert.deepEqual(r.alerts, []); assert.ok(r.cursor > 0, 'the cursor still moves, so it is not retried forever');
await put(A, { types: { stuck: { on: true } } }, { now: nowS }); assert.ok((await feedIds(A)).every((x) => x.notify === true), 'switching back on loses nothing'); assert.equal((await api(A, '/alerts/new?since=0', { now: nowS })).j.alerts.length, 2);
await put(A, { stores: { 326: false } }, { now: nowS });
fa = await feedIds(A); assert.deepEqual(fa.map((x) => [x.wo, x.notify]).sort(), [[421, true], [422, false]], 'per-store switch'); assert.equal((await api(A, '/alerts', { now: nowS })).j.unread, 1);
assert.deepEqual((await api(A, '/alerts/new?since=0', { now: nowS })).j.alerts.map((x) => x.wo), [421]);
await put(A, { stores: { 326: true } }, { now: nowS });
// quiet hours (default 22:00–07:00, store local time): held, then delivered while the alert is still fresh; the feed is unaffected
await exec(woRow(914, 423, 9), period(914, 423, 9, iso(cr2 - 3 * D - 1000)), woRow(914, 424, 9), period(914, 424, 9, iso(THU(20) - 3 * D - 1000)));
await tick(cr2); await tick(THU(20));
await TR.prepare('DELETE FROM alerts WHERE wo IN (421, 422)').run();
const held = (await api(A, '/alerts/new?since=0', { now: THU(23) })).j; assert.deepEqual(held, { v: 1, cursor: 0, alerts: [], held: true }, 'in quiet hours nothing is returned and the cursor stays');
assert.equal((await api(A, '/alerts', { now: THU(23) })).j.alerts.length, 2, 'the feed still has both'); assert.ok((await feedIds(A, THU(23))).every((x) => x.notify));
assert.equal((await api(A, '/alerts/new?since=0', { now: FRI(6, 59) })).j.held, true);
r = (await api(A, '/alerts/new?since=0', { now: FRI(7, 0) })).j; assert.ok(!r.held); assert.deepEqual(r.alerts.map((x) => x.wo), [424], 'released when quiet hours end; the one that is more than 12 hours old is feed-only'); assert.equal(r.cursor, (await alertRows()).pop().id);
await put(A, { quietHours: { on: false } }, { now: THU(23) });
assert.deepEqual((await api(A, '/alerts/new?since=0', { now: THU(23) })).j.alerts.map((x) => x.wo), [423, 424], 'quiet hours off');
await put(A, { quietHours: { on: true, from: '13:00', to: '15:00' } }, { now: THU(23) });
assert.equal((await api(A, '/alerts/new?since=0', { now: THU(14) })).j.held, true); assert.ok(!(await api(A, '/alerts/new?since=0', { now: THU(15) })).j.held); assert.ok(!(await api(A, '/alerts/new?since=0', { now: THU(12, 59) })).j.held);
assert.equal((await api(B, '/alerts/new?since=0', { now: THU(23) })).j.held, true, 'quiet hours are per phone: B has the defaults');

// ================================================================ thresholds are per phone (levels)
section('per-phone thresholds');
await reset();
await put(B, { types: { stuck: { days: 5 }, quiet: { hours: 4 }, followup: { hour: 11 }, pickup: { days: 10 } } });
const X = THU(11) - 3 * D - 1000;
await exec(woRow(914, 501, 9), period(914, 501, 9, iso(X)), scan(914, iso(THU(12))), rfp(914, 502, iso(THU(11) - 8 * D)));
await AE.batch([mark(914, 503, '2026-10-15')]);
await tick(THU(11)); await tick(THU(14, 1));
const lv = async (p, now) => (await api(p, '/alerts', { now })).j.alerts.map((x) => x.type + ':' + (x.days ?? x.hours ?? x.due ?? '') + ':' + x.wo).sort();
assert.deepEqual(await lv(A, THU(15)), ['followup:2026-10-15:503', 'pickup:7:null', 'quiet:2:null', 'stuck:3:501'], 'phone A: its own levels (3 days, 7 days, 9:00, 2 hours)');
assert.deepEqual(await lv(B, THU(15)), ['followup:2026-10-15:503'], 'phone B has higher thresholds: no stuck, pickup or quiet alert yet (its 11:00 follow-up has come); each is raised when its own level is reached');
await tick(THU(16, 1));                                                                   // 4h silence
assert.deepEqual(await lv(B, THU(17)), ['followup:2026-10-15:503', 'quiet:4:null']); assert.deepEqual((await api(A, '/alerts/new?since=0', { now: THU(17) })).j.alerts.filter((x) => x.type === 'quiet').map((x) => x.hours), [2]);
await tick(X + 5 * D + 1000); assert.deepEqual((await lv(B, X + 5 * D + 2000)).filter((x) => x.startsWith('stuck')), ['stuck:5:501'], 'B: stuck at 5 days');
assert.deepEqual((await lv(A, X + 5 * D + 2000)).filter((x) => x.startsWith('stuck')), ['stuck:3:501'], 'A keeps its own, not B\'s');
await tick(FRI(11)); assert.ok((await lv(B, FRI(12))).some((x) => x.startsWith('pickup:10')) === false, 'B pickup at 10 days is not reached by a 8-day-old device');
await put(B, { types: { stuck: { days: 3 } } }); assert.deepEqual((await lv(B, FRI(12))).filter((x) => x.startsWith('stuck')), ['stuck:3:501'], 'a phone that lowers its threshold sees that level\'s history');
// followup at 11:00 for B (a mark due on the day, raised from the phone's hour)
await reset(); await put(B, { types: { followup: { hour: 11 } } }); await AE.batch([mark(914, 504, '2026-10-15')]);
await tick(THU(9)); assert.equal((await api(A, '/alerts', { now: THU(10) })).j.alerts.filter((x) => x.type === 'followup').length, 1); assert.equal((await api(B, '/alerts', { now: THU(10) })).j.alerts.filter((x) => x.type === 'followup').length, 0, 'B asked for 11:00');
await tick(THU(11)); assert.equal((await api(B, '/alerts', { now: THU(12) })).j.alerts.filter((x) => x.type === 'followup').length, 1); assert.equal((await alertRows('type = ?', 'followup')).length, 2, 'one per level');


// ================================================================ rule: the morning digest (one per phone scope per day)
section('digest');
await reset({ digest: true });                                                            // A (914 + 326), B (914), C (326), D (914): digest on at 8:00
const D8 = THU(8);
await exec(TR.prepare("INSERT INTO sales (store, sale_id, wo, sale_day, sale_at, type, total, card, completed_by, source) VALUES (914, 'S1', NULL, '2026-10-14', ?, 'Sale', 2000, 'v1.sealedJaneQCustomer', 'Tech', 'portal'), (914, 'S2', NULL, '2026-10-14', ?, 'Sale', 1400, 'v1.sealedJaneQCustomer', 'Tech', 'portal')").bind(Z('2026-10-14', 12), Z('2026-10-14', 15)),
  TR.prepare("INSERT INTO sales_days (store, day, source, synced_at) VALUES (914, '2026-10-14', 'portal', ?)").bind(Z('2026-10-15', 7)),
  TR.prepare("INSERT INTO daily_metrics (store, day, metric, value, source, updated_at) VALUES (914, '2026-10-14', 'labor_hours', 20, 't', 'x')"),
  rfp(914, 201, iso(D8 - 12 * D)), rfp(914, 202, iso(D8 - 2 * D)), rfp(326, 203, iso(D8 - 5 * D)),
  woRow(914, 301, 13), woRow(914, 302, 9),
  woRow(914, 101, 9), period(914, 101, 9, iso(D8 - 5 * D - HR)), woRow(326, 102, 10), period(326, 102, 10, iso(D8 - 4 * D - HR)), woRow(914, 103, 9), period(914, 103, 9, iso(D8 - D)));
await AE.batch([mark(914, 301, '2026-10-15'), mark(914, 302, '2026-10-15', 'callback'), mark(326, 303, '2026-10-15'), mark(914, 304, '2026-10-16'), mark(914, 305, '2026-10-15'),
  AE.prepare('INSERT INTO wo_closed (store, wo, closed_at) VALUES (914, 305, ?)').bind(iso(D8 - D))]);
const digests = (where = '1', ...b) => alertRows(`type = 'digest' AND ${where}`, ...b);
await tick(THU(7, 50)); assert.equal((await digests()).length, 0, 'before the digest hour');
await tick(D8); al = await digests();
assert.deepEqual(al.map((x) => [x.store, x.subject, x.level, x.wo, x.backfill]).sort(), [[326, '326,914|3@2026-10-15', 8, null, 0], [326, '326|3@2026-10-15', 8, null, 0], [914, '914|3@2026-10-15', 8, null, 0]],
  'one per scope: A (both stores), C (Lynnhaven), and B and D share Newport News');
const dA = JSON.parse(al.find((x) => x.subject.startsWith('326,914')).data);
assert.deepEqual(dA, { day: '2026-10-15', yesterday: '2026-10-14', stores: [326, 914], sales: 3400, splh: 170, hours: 20, target: [160, 180],
  rfp: { total: 300, count: 3, oldestDays: 12 },
  followups: { count: 3, wos: [{ store: 326, wo: 303, status: null }, { store: 914, wo: 301, status: 'Ready for pickup' }, { store: 914, wo: 302, status: 'Diagnostics' }] },
  stuck: { days: 3, count: 2, wos: [{ store: 914, wo: 101, status: 'Diagnostics', days: 5 }, { store: 326, wo: 102, status: 'Work in progress', days: 4 }] } });
const dB = JSON.parse(al.find((x) => x.subject.startsWith('914|')).data);
assert.deepEqual([dB.stores, dB.sales, dB.rfp.count, dB.followups.count, dB.stuck.count], [[914], 3400, 2, 2, 1], 'a one-store scope counts that store only');
assert.equal(JSON.parse(al.find((x) => x.subject.startsWith('326|')).data).sales, null, 'no synced day and no sales: a dash, not 0');
for (let i = 1; i < 30; i++) await tick(D8 + i * 10 * MIN); assert.equal((await digests()).length, 3, 'once a day however many ticks');
const dg = async (p, q = '', now = THU(8, 5)) => (await api(p, '/alerts' + q, { now })).j.alerts.filter((x) => x.type === 'digest');
let fd = await dg(A); assert.equal(fd.length, 1); assert.deepEqual(fd[0].stores, [326, 914], 'phone A: one combined digest, not the single-store ones'); assert.equal(fd[0].notify, true); assert.equal(fd[0].wo, null);
assert.deepEqual((await dg(B))[0].stores, [914]); assert.equal((await dg(B))[0].id, (await dg(Dp))[0].id, 'B and D share one'); assert.deepEqual((await dg(C)).map((x) => x.stores), [[326]]);
assert.equal((await dg(A, '?store=914')).length + (await dg(A, '?store=326')).length, 0, 'a feed filtered to one store leaves the digest out');
assert.equal((await dg(C, '?store=326')).length, 1, 'a one-store phone filtered to its store still has it');
assert.deepEqual((await api(A, '/alerts/new?since=0', { now: THU(8, 5) })).j.alerts.filter((x) => x.type === 'digest').map((x) => x.stores), [[326, 914]], 'digest at 8:00, quiet hours to 7:00: notifies normally');
await put(A, { stores: { 326: false } }, { now: THU(8, 5) });
assert.deepEqual((await dg(A)).map((x) => x.stores), [[914]], 'a store switched off leaves the digest scope: A now matches the 914-only digest');
assert.deepEqual((await api(A, '/alerts/new?since=0', { now: THU(8, 5) })).j.alerts.filter((x) => x.type === 'digest').map((x) => x.stores), [[914]]);
await put(A, { stores: { 914: false } }, { now: THU(8, 5) });
assert.equal((await dg(A)).length, 0, 'every store off: no digest');
await tick(THU(8, 30)); assert.equal((await digests()).length, 3, 'and none is made for an empty scope');
await put(A, { stores: { 914: true } }, { now: THU(8, 5) });
await put(A, { stores: { 326: true }, quietHours: { from: '22:00', to: '09:00' } }, { now: THU(8, 5) });
assert.equal((await api(A, '/alerts/new?since=0', { now: THU(8, 5) })).j.held, true, 'digest hour inside quiet hours: held');
assert.equal((await api(A, '/alerts/new?since=0', { now: THU(9) })).j.alerts.filter((x) => x.type === 'digest').length, 1, 'and delivered when they end');
await put(A, { quietHours: { from: '22:00', to: '07:00' } }, { now: THU(9) });
// per-phone threshold: B wants 10:00 and stuck after 5 days (its scope changes with its stuck threshold)
await put(B, { types: { digest: { hour: 10 }, stuck: { days: 5 } } });
await tick(FRI(8));
assert.deepEqual((await digests("subject LIKE '%2026-10-16'")).map((x) => x.subject).sort(), ['326,914|3@2026-10-16', '326|3@2026-10-16', '914|3@2026-10-16'], 'B not yet; D still has 914|3 at 8:00');
assert.equal((await dg(B, '', FRI(9))).length, 0, 'B sees only its own level and scope');
await tick(FRI(9, 50)); assert.equal((await digests("subject = '914|5@2026-10-16'")).length, 0);
await tick(FRI(10)); al = await digests("subject = '914|5@2026-10-16'"); assert.equal(al.length, 1); assert.equal(al[0].level, 10);
assert.deepEqual(JSON.parse(al[0].data).stuck, { days: 5, count: 1, wos: [{ store: 914, wo: 101, status: 'Diagnostics', days: 6 }] }, 'stuck at the phone\'s own threshold');
assert.deepEqual((await dg(B, '', FRI(10, 5))).map((x) => x.id), [al[0].id]); assert.ok(!(await dg(Dp, '', FRI(10, 5))).some((x) => x.id === al[0].id));
// switched off: no digest is made for that scope; switched on after the hour: made at the next tick, feed only
await put(C, { types: { digest: { on: false } } });
await tick(SAT(8)); assert.equal((await digests("subject = '326|3@2026-10-17'")).length, 0, 'C switched it off');
assert.equal((await digests("subject = '326,914|3@2026-10-17'")).length, 1);
await put(C, { types: { digest: { on: true } } });
await tick(SAT(14)); al = await digests("subject = '326|3@2026-10-17'"); assert.equal(al.length, 1); assert.equal(al[0].backfill, 1, 'over an hour late: feed only');
assert.equal((await dg(C, '', SAT(14, 5)))[0].notify, false); assert.equal((await api(C, '/alerts/new?since=0', { now: SAT(14, 5) })).j.alerts.filter((x) => x.type === 'digest' && x.day === '2026-10-17').length, 0);
// a digest hour inside quiet hours (6:00, quiet to 7:00): held, then delivered
await put(C, { types: { digest: { hour: 6 } } });
await tick(SUN(5, 50)); await tick(SUN(6)); al = await digests("subject = '326|3@2026-10-18'"); assert.deepEqual(al.map((x) => [x.level, x.backfill]), [[6, 0]]);
assert.equal((await api(C, '/alerts/new?since=' + (al[0].id - 1), { now: SUN(6, 5) })).j.held, true);
assert.deepEqual((await api(C, '/alerts/new?since=' + (al[0].id - 1), { now: SUN(7) })).j.alerts.map((x) => x.type), ['digest']);

// ================================================================ rule: Retrace sales orders with no work order
section('unlinked');
await reset();
const U0 = THU(12);
let mvN = 0;
const mv = (store, so, at) => TR.prepare("INSERT INTO inv_movements (store, label, item, at, kind, ref_type, ref_id, source, key, recorded_at) VALUES (?, ?, 'P100', ?, 'sold', 'sales_order', ?, 'history', ?, ?)").bind(store, 'L' + (++mvN), at, so, 'k' + mvN, at);
const need = (store, so) => TR.prepare('INSERT INTO inv_so_need (store, sales_order, none_at) VALUES (?, ?, ?)').bind(store, so, iso(U0 - 10 * MIN));
const link = (store, so) => TR.prepare("INSERT INTO inv_so_wo (store, sales_order, wo, source, updated_at) VALUES (?, ?, '700000099', 'label', ?)").bind(store, so, iso(U0));
await exec(mv(914, 'FSO1001', iso(U0 - 3 * HR)), need(914, 'FSO1001'),
  mv(914, 'FSO1002', iso(U0 - 2 * HR)), mv(914, 'FSO1002', iso(U0 - 30 * MIN)), need(914, 'FSO1002'),     // its age is from the first movement
  mv(914, 'FSO1003', iso(U0 - 30 * MIN)), need(914, 'FSO1003'),
  mv(914, 'FSO1004', iso(U0 - 5 * HR)), need(914, 'FSO1004'), link(914, 'FSO1004'),                       // linked: not unlinked
  need(914, 'FSO1006'),                                                                                    // no movement: no age
  mv(914, 'FSO1007', iso(U0 - 5 * HR)),                                                                    // not on Retrace's list
  mv(536, 'FSO1005', iso(U0 - 5 * HR)), need(536, 'FSO1005'));                                             // no approved phone
await put(B, { types: { unlinked: { hours: 4 } } });
const unl = (where = '1', ...b) => alertRows(`type = 'unlinked' AND ${where}`, ...b);
await tick(U0); al = await unl();
assert.deepEqual(al.map((x) => [x.store, x.level, x.subject, x.wo, x.backfill]), [[914, 1, 'FSO1001', null, 0]], 'one alert per store per tick');
assert.deepEqual(JSON.parse(al[0].data), { count: 2, hours: 1, oldestHours: 3, salesOrders: ['FSO1001', 'FSO1002'] });
for (let i = 1; i <= 2; i++) await tick(U0 + i * 10 * MIN); assert.equal((await unl()).length, 1, 'no repeat');
await tick(U0 + 30 * MIN); assert.equal((await unl()).length, 1, 'exactly 1 hour is not over 1 hour');
await tick(U0 + 31 * MIN); al = await unl(); assert.equal(al.length, 2); assert.deepEqual(JSON.parse(al[1].data).salesOrders, ['FSO1003'], 'a minute later it is');
await tick(U0 + 61 * MIN); al = await unl('level = 4'); assert.deepEqual(al.map((x) => JSON.parse(x.data).salesOrders), [['FSO1001']], 'B (4 hours) gets its own alert at its level');
const fu = async (p, now = U0 + 62 * MIN) => (await api(p, '/alerts', { now })).j.alerts.filter((x) => x.type === 'unlinked');
assert.deepEqual((await fu(A)).map((x) => [x.hours, x.salesOrders.join()]), [[1, 'FSO1003'], [1, 'FSO1001,FSO1002']]); assert.ok((await fu(A)).every((x) => x.notify && x.wo === null));
assert.deepEqual((await fu(B)).map((x) => x.salesOrders), [['FSO1001']]); assert.equal((await fu(C)).length, 0, 'Lynnhaven phone: nothing of Newport News');
assert.equal((await api(A, '/alerts/new?since=0', { now: U0 + 62 * MIN })).j.alerts.filter((x) => x.type === 'unlinked').length, 2);
await put(A, { types: { unlinked: { on: false } } }, { now: U0 + 62 * MIN });
assert.ok((await fu(A)).every((x) => !x.notify), 'switched off: in the feed, no notification'); assert.equal((await api(A, '/alerts/new?since=0', { now: U0 + 62 * MIN })).j.alerts.filter((x) => x.type === 'unlinked').length, 0);
fa = (await api(A, '/alerts', { now: U0 + 62 * MIN })).j; assert.equal(fa.unread, fa.alerts.filter((x) => x.notify).length, 'and no badge');
await put(A, { types: { unlinked: { on: true } } }, { now: U0 + 62 * MIN });
assert.equal((await rows("SELECT COUNT(*) AS n FROM alert_items WHERE type = 'unlinked'"))[0].n, 4);
await TR.prepare("DELETE FROM alerts WHERE type = 'unlinked'").run();                                    // as retention would
for (let i = 0; i < 3; i++) await tick(U0 + (70 + i * 10) * MIN); assert.equal((await unl()).length, 0, 'a sales order never alerts twice, even after its alert is gone');
await exec(link(914, 'FSO1002'));
await tick(THU(15, 0)); assert.deepEqual((await rows('SELECT item, level FROM alert_items ORDER BY level, item')).map((x) => x.item + '@' + x.level), ['FSO1001@1', 'FSO1003@1', 'FSO1001@4'], 'housekeeping forgets a sales order once it has a work order');
assert.equal((await unl()).length, 0);
await exec(mv(914, 'FSO1008', iso(THU(15) - 30 * HR)), need(914, 'FSO1008'));                           // first seen long past both thresholds
await tick(THU(15, 10)); al = await unl(); assert.deepEqual(al.map((x) => [x.level, x.backfill, x.subject]), [[1, 1, 'FSO1008'], [4, 1, 'FSO1008']], 'late: feed only');
assert.ok(!(await rows('SELECT * FROM alerts WHERE store = 536')).length, 'store with no approved phone: nothing');

// ================================================================ rule: Retrace coverage check with failures
section('coverage');
await reset();
const V0 = THU(12);
const vres = (cn, mn, qn = 0, sn = 0) => JSON.stringify({ v: 1, by: null, counts: { status: cn ? 'fail' : 'pass', total: 40, ok: 40 - cn, n: cn, rows: [{ item: 'P100', name: 'Screen assembly', portal: 3, have: 1 }] },
  qty: { status: qn ? 'fail' : 'pass', n: qn, rows: [] }, stale: { status: sn ? 'fail' : 'pass', n: sn, rows: [] }, missed: { status: mn ? 'fail' : 'pass', n: mn, rows: [] }, spot: [], ask: [], asked: {} });
const verify = (store, at, res) => TR.prepare('INSERT OR REPLACE INTO inv_verify (store, checked_at, result) VALUES (?, ?, ?)').bind(store, at, res);
await exec(verify(914, iso(V0 - 5 * MIN), vres(3, 2, 1, 4)), verify(326, iso(V0 - 5 * MIN), vres(0, 0, 2, 5)), verify(536, iso(V0 - 5 * MIN), vres(9, 9)));
const cov = (where = '1', ...b) => alertRows(`type = 'coverage' AND ${where}`, ...b);
await tick(V0); al = await cov();
assert.deepEqual(al.map((x) => [x.store, x.subject, x.level, x.wo, x.backfill]), [[914, iso(V0 - 5 * MIN), 0, null, 0]], 'failures at 914 only (326 passes the count and missed checks; 536 has no phone)');
assert.deepEqual(JSON.parse(al[0].data), { checkedAt: iso(V0 - 5 * MIN), countMisses: 3, countItems: 40, missedItems: 2, qtyMisses: 1, staleLabels: 4 });
for (let i = 1; i < 10; i++) await tick(V0 + i * 10 * MIN); assert.equal((await cov()).length, 1, 'one alert per result, not per tick');
await exec(verify(914, iso(V0 + 2 * HR), vres(0, 1)));
await tick(V0 + 2 * HR + 5 * MIN); al = await cov(); assert.equal(al.length, 2, 'a new result alerts again'); assert.deepEqual([JSON.parse(al[1].data).countMisses, JSON.parse(al[1].data).missedItems], [0, 1]);
await exec(verify(914, iso(V0 + 3 * HR), vres(0, 0, 3, 3)));
await tick(V0 + 3 * HR + 5 * MIN); assert.equal((await cov()).length, 2, 'a result without count misses or missed items does not alert');
await exec(verify(326, iso(V0), vres(1, 0)));
await tick(V0 + 3 * HR + 15 * MIN); al = await cov('store = 326'); assert.deepEqual(al.map((x) => x.backfill), [1], 'first seen over an hour after its run: feed only');
await exec(verify(326, iso(V0 - 61 * D), vres(5, 5)));
await tick(V0 + 3 * HR + 25 * MIN); assert.equal((await cov('store = 326')).length, 1, 'a result older than the retention is left alone');
const fcv = async (p, now = V0 + 4 * HR) => (await api(p, '/alerts', { now })).j.alerts.filter((x) => x.type === 'coverage');
assert.deepEqual((await fcv(B)).map((x) => [x.missedItems, x.notify]), [[1, true], [2, true]]); assert.deepEqual((await fcv(C)).map((x) => [x.countMisses, x.notify]), [[1, false]]);
assert.equal((await api(B, '/alerts/new?since=0', { now: V0 + 4 * HR })).j.alerts.filter((x) => x.type === 'coverage').length, 2);
await put(B, { types: { coverage: { on: false } } }, { now: V0 + 4 * HR });
assert.ok((await fcv(B)).every((x) => !x.notify)); assert.equal((await api(B, '/alerts/new?since=0', { now: V0 + 4 * HR })).j.alerts.length, 0); assert.equal((await api(B, '/alerts', { now: V0 + 4 * HR })).j.unread, 0);

// ================================================================ privacy: no names, phones or other details in anything returned
section('privacy');
assert.ok(seen.length > 100);
const allowedKeys = new Set(['id', 'store', 'type', 'wo', 'at', 'read', 'notify', 'cleared', 'statusId', 'status', 'days', 'since', 'count', 'oldestDays', 'due', 'kind', 'hours', 'resumedAt',
  'day', 'yesterday', 'stores', 'sales', 'splh', 'target', 'rfp', 'followups', 'stuck', 'oldestHours', 'salesOrders', 'checkedAt', 'countMisses', 'countItems', 'missedItems', 'qtyMisses', 'staleLabels']);
for (const body of seen) {
  for (const bad of ['Jane', 'Customer', '757-555', 'sealedJane', 'iPhone', 'Pixel', 'Retail']) assert.ok(!body.includes(bad), `${bad} leaked: ${body.slice(0, 200)}`);
  const check = (v) => { if (Array.isArray(v)) v.forEach(check); else if (v && typeof v === 'object' && 'type' in v && 'store' in v && 'at' in v) for (const k of Object.keys(v)) assert.ok(allowedKeys.has(k), 'unexpected alert field ' + k); else if (v && typeof v === 'object') Object.values(v).forEach(check); };
  check(JSON.parse(body));
}
for (const x of await alertRows()) for (const bad of ['Jane', '757', 'Customer', 'sealed']) assert.ok(!(x.subject + x.data).includes(bad), 'stored alert text is name-free');

// ================================================================ cost: statements per tick, rows, the cap, retention, failures
section('cost');
await reset();
const seed = [];
for (let i = 0; i < 80; i++) { seed.push(woRow(914, 600 + i, [2, 9, 10, 3][i % 4]), period(914, 600 + i, [2, 9, 10, 3][i % 4], iso(THU(12) - (1 + (i % 2)) * D - i * MIN))); }
for (let i = 0; i < 20; i++) seed.push(rfp(914, 700 + i, iso(THU(12) - 4 * D - i * MIN)));
seed.push(scan(914, iso(THU(11, 55))), scan(326, iso(THU(11, 55))));
await exec(...seed);
const counted = () => { const c = { prepare: 0, batch: 0 }; const p = new Proxy(TR, { get(t, k) { if (k === 'prepare') return (...a) => { c.prepare++; return t.prepare(...a); }; if (k === 'batch') return (s) => { c.batch++; return t.batch(s); }; const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; } }); return [Object.assign({}, E, { TR: p }), c]; };
let [E1, c1] = counted(); await alertsTick(E1, THU(12, 20));
console.log(`    steady-state tick, 2 stores (80 open WOs in one), 4 phones: ${c1.prepare} statements (${c1.batch} batches), no writes`);
assert.ok(c1.prepare <= 11, 'statements per quiet tick: ' + c1.prepare);
assert.equal((await alertRows()).length, 0);
[E1, c1] = counted(); await alertsTick(E1, THU(13, 0));
assert.ok(c1.prepare <= 16, 'with the hourly housekeeping: ' + c1.prepare); console.log(`    with the hourly housekeeping: ${c1.prepare} statements`);
const meta = async (sql, binds) => (await TR.prepare(sql).bind(...binds).run()).meta;
const ms = await meta(SQL.STUCK_SQL, [iso(THU(12, 20)), '[3]', 914, 25]), mp = await meta(SQL.PICKUP_SQL, [iso(THU(12, 20)), '[7]', 914, '2026-10-15']);
console.log(`    stuck rule, store with 80 open WOs: rows_read ${ms.rows_read}, rows_written ${ms.rows_written}; pickup rule (20 devices at RFP): rows_read ${mp.rows_read}, rows_written ${mp.rows_written}`);
if (ms.rows_read != null) { assert.ok(ms.rows_read <= 600, 'stuck rows read ' + ms.rows_read); assert.equal(ms.rows_written, 0); }
// unlinked and coverage in the steady state: 200 sales orders on Retrace's list (100 linked since, 100 already alerted), a coverage result already alerted
const so = [];
for (let i = 0; i < 200; i++) {
  so.push(TR.prepare('INSERT INTO inv_so_need (store, sales_order, none_at) VALUES (914, ?, ?)').bind('FSO' + (5000 + i), iso(THU(10))),
    TR.prepare("INSERT INTO inv_movements (store, label, item, at, kind, ref_type, ref_id, source, key, recorded_at) VALUES (914, ?, 'P1', ?, 'sold', 'sales_order', ?, 'history', ?, ?)").bind('C' + i, iso(THU(9)), 'FSO' + (5000 + i), 'c' + i, iso(THU(9))),
    i % 2 ? TR.prepare("INSERT INTO inv_so_wo (store, sales_order, wo, source, updated_at) VALUES (914, ?, '1', 'label', ?)").bind('FSO' + (5000 + i), iso(THU(10)))
      : TR.prepare("INSERT INTO alert_items (store, type, level, item, alert_id) VALUES (914, 'unlinked', 1, ?, 1)").bind('FSO' + (5000 + i)));
}
so.push(TR.prepare('INSERT INTO inv_verify (store, checked_at, result) VALUES (914, ?, ?)').bind(iso(THU(12)), JSON.stringify({ counts: { n: 1, total: 5 }, missed: { n: 0 } })),
  TR.prepare("INSERT INTO alerts (store, type, subject, level, wo, created_at, data) VALUES (914, 'coverage', ?, 0, NULL, ?, '{}')").bind(iso(THU(12)), iso(THU(12, 10))));
await exec(...so);
const mu = await meta(SQL.UNLINKED_SQL, [iso(THU(12, 20)), '[914,326]', JSON.stringify({ s914: [1], s326: [1] })]), mc = await meta(SQL.COVERAGE_SQL, [iso(THU(12, 20)), '[914,326]', iso(THU(12) - RETENTION_DAYS * D)]);
console.log(`    unlinked rule, 200 sales orders on Retrace's list: rows_read ${mu.rows_read}; coverage rule: rows_read ${mc.rows_read}, rows_written ${mc.rows_written}`);
if (mu.rows_read != null) { assert.ok(mu.rows_read <= 800, 'unlinked rows read ' + mu.rows_read); assert.equal(mc.rows_written, 0); }
[E1, c1] = counted(); const sx = await alertsTick(E1, THU(12, 30)); assert.equal(sx.created, 0, 'nothing new'); assert.ok(c1.prepare <= 11, 'still ' + c1.prepare);
// with the digest on: one look-up per tick once today's is made (the facts are worked out once a day)
await put(A, { types: { digest: { on: true } } });
let s0d = await tick(THU(12, 40)); assert.equal(s0d.created, 1, 'today\'s digest, made late (feed only)');
[E1, c1] = counted(); await alertsTick(E1, THU(12, 50)); assert.ok(c1.prepare <= 12, 'digest steady state: ' + c1.prepare); console.log(`    steady-state tick with a digest on: ${c1.prepare} statements`);
[E1, c1] = counted(); await TR.prepare("DELETE FROM alerts WHERE type = 'digest'").run(); await alertsTick(E1, THU(12, 55)); console.log(`    the tick that makes a digest: ${c1.prepare} statements`); assert.ok(c1.prepare <= 40);
await put(A, { types: { digest: { on: false } } });
// the cap: 60 stuck work orders in each store, 25 per store per tick
await reset();
const many = [];
for (let i = 0; i < 60; i++) many.push(woRow(914, 800 + i, 9), period(914, 800 + i, 9, iso(THU(12) - 3 * D - HR + i * 1000)), woRow(326, 900 + i, 9), period(326, 900 + i, 9, iso(THU(12) - 3 * D - HR + i * 1000)));
await exec(...many);
let s1 = await tick(THU(12, 20)); assert.equal(s1.created, 2 * CAP_PER_TICK); assert.equal(s1.capped, 2);
assert.equal((await alertRows('store = 914')).length, 25); assert.equal((await alertRows('store = 326')).length, 25);
assert.deepEqual((await alertRows('store = 914')).map((x) => x.wo), Array.from({ length: 25 }, (_, i) => 800 + i), 'oldest first');
await tick(THU(12, 30)); assert.equal((await alertRows('store = 914')).length, 50); await tick(THU(12, 40)); assert.equal((await alertRows('store = 914')).length, 60);
s1 = await tick(THU(12, 50)); assert.equal(s1.created, 0); assert.equal((await alertRows()).length, 120);
// retention: 60 days, in the hourly housekeeping tick only
await reset();
const old = (days, subj) => TR.prepare("INSERT INTO alerts (store, type, subject, level, wo, created_at, data) VALUES (914, 'stuck', ?, 3, 1, ?, '{}')").bind(subj, iso(THU(12, 0) - days * D));
await exec(old(61, 'old'), old(RETENTION_DAYS - 1, 'keep'), old(1, 'new'));
const oldId = (await alertRows("subject = 'old'"))[0].id;
await exec(TR.prepare('INSERT INTO alert_reads (device_id, alert_id) VALUES (?, ?)').bind(A.id, oldId), TR.prepare("INSERT INTO alert_device (device_id, settings, read_upto) VALUES (?, '{}', 0)").bind('f'.repeat(32)));
await tick(THU(12, 20)); assert.equal((await alertRows()).length, 3, 'not in a non-housekeeping tick');
await tick(THU(13, 0)); assert.deepEqual((await alertRows()).map((x) => x.subject), ['keep', 'new'], 'older than 60 days deleted, the rest kept');
assert.equal((await rows('SELECT COUNT(*) AS n FROM alert_reads'))[0].n, 0, 'reads of deleted alerts are trimmed'); assert.equal((await rows("SELECT COUNT(*) AS n FROM alert_device WHERE device_id = ?", 'f'.repeat(32)))[0].n, 0, 'state of removed phones is trimmed');
assert.equal((await rows('SELECT COUNT(*) AS n FROM alert_device WHERE device_id = ?', A.id))[0].n, 1, 'live phones are kept');
// a failing database never throws out of the tick
const log = console.error; console.error = () => {};
const bad = await alertsTick({ TR: { prepare() { throw new Error('boom'); } } }, THU(12)); console.error = log;
assert.equal(bad.error, true);
// no approved phone, no work: the only statement is the device list
await TR.prepare('UPDATE agents SET status = ?').bind('pending').run();
[E1, c1] = counted(); s1 = await alertsTick(E1, THU(12, 20)); assert.equal(s1.stores, 0); assert.equal(c1.prepare, 1, 'no approved phone: one statement');

console.log('mobile-alerts: all passed');
await T.dispose();
