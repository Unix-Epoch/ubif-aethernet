// Linkpearl (the phone app): Home's numbers (src/mobile.js) and who may reach them (the admin site's /m shell and /api/m/home).
// Local D1 databases through getPlatformProxy; the admin Worker is the real one, signed in through LOCAL_TEST's `?as=`. Everything is invented.
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { register } from 'node:module';
import { getPlatformProxy } from 'wrangler';

register('data:text/javascript,' + encodeURIComponent(`
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function load(url, ctx, next) {
  const asText = url.endsWith('.txt') || url.endsWith('?as-text') || (ctx.importAttributes && ctx.importAttributes.type === 'text')
    || ((url.endsWith('/admin-worker/src/tracker-ui.js') || url.endsWith('/admin-worker/src/metrics-ui.js') || url.endsWith('/admin-worker/src/rules-ui.js') || url.endsWith('/admin-worker/src/retrace-ui.js') || url.endsWith('/tracker-worker/src/crypto.js')) && ctx.parentURL && ctx.parentURL.endsWith('/admin-worker/src/index.js'));
  if (!asText) return next(url, ctx);
  return { format: 'module', source: 'export default ' + JSON.stringify(readFileSync(fileURLToPath(url), 'utf8')), shortCircuit: true };
}
export async function resolve(spec, ctx, next) {
  const r = await next(spec, ctx);
  if (ctx.parentURL && ctx.parentURL.endsWith('/admin-worker/src/index.js') && /(tracker-ui|metrics-ui|rules-ui|retrace-ui|crypto)\\.js$/.test(r.url)) return Object.assign({}, r, { url: r.url + '?as-text' });
  if (ctx.importAttributes && ctx.importAttributes.type === 'text') return Object.assign({}, r, { url: r.url + '?as-text', importAttributes: {} });
  return r;
}`));
const { default: site } = await import('../../admin-worker/src/index.js');
const { buildHome, laneOf, SPLH_TARGET, STALE_MINUTES } = await import('../src/mobile.js');
const { localToUtc } = await import('../src/metrics.js');

rmSync('.wrangler-test-mobile', { recursive: true, force: true });
const { env, dispose } = await getPlatformProxy({ configPath: 'wrangler.toml', persist: { path: '.wrangler-test-mobile' } });
const sql = (file) => readFileSync(file, 'utf8').replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean);
for (const s of sql('schema.sql')) await env.TR.prepare(s).run();
for (const s of sql('../worker/schema.sql')) await env.AE.prepare(s).run();
const T = env.TR, W = env.AE, E = { DB: W, TR: T };
const TZ = 'America/New_York';
const Z = (day, hour, min = 0) => new Date(localToUtc(day, hour, TZ) + min * 60000).toISOString();
const NOW = Date.parse(Z('2026-10-15', 16)); // Thursday 4 PM Eastern, store hours
const names = new Map([[914, 'Newport News'], [326, 'Lynnhaven'], [536, 'Lexington']]);

// ------------------------------------------------------------------ fixture
const wo = (store, n, o) => T.prepare(`INSERT INTO workorders (store, wo, status_id, program_name, device, created_at, is_open, closed_at, sold_at, last_cart_value, last_cart_tax, card, plain)
  VALUES (?, ?, ?, 'Retail', 'iPhone 13', ?, ?, ?, ?, ?, ?, 'v1.ZZSEALEDCARD', ?)`).bind(store, n, o.status, o.created || Z('2026-10-01', 10), o.open ?? 1, o.sold || null, o.sold || null, o.value ?? null, o.tax ?? null, JSON.stringify({ workorder: { customerName: 'ZZCUSTOMER Smith' } }));
const open = (store, first, statuses) => statuses.map((s, i) => wo(store, first + i, { status: s }));
await T.batch([
  // 914: Portal's sales synced Oct 12–14 (Oct 14: a sale at 11:30 PM store time); Oct 15 estimated from a WO at Sale complete (80 + 5 tax)
  T.prepare("INSERT INTO sales_days (store, day, source, synced_at) VALUES (914, '2026-10-12', 'portal', ?), (914, '2026-10-13', 'portal', ?), (914, '2026-10-14', 'portal', ?)").bind(Z('2026-10-15', 9), Z('2026-10-15', 9), Z('2026-10-15', 9)),
  ...[['a', '2026-10-12', Z('2026-10-12', 11), 'Sale', 70], ['b', '2026-10-13', Z('2026-10-13', 11), 'Sale', 100], ['c', '2026-10-13', Z('2026-10-13', 12), 'Sale', 50], ['d', '2026-10-13', Z('2026-10-13', 13), 'Return', 20], ['e', '2026-10-14', Z('2026-10-14', 23, 30), 'Sale', 200]]
    .map(([id, day, at, type, total]) => T.prepare("INSERT INTO sales (store, sale_id, wo, sale_day, sale_at, type, total, card, completed_by, source) VALUES (914, ?, NULL, ?, ?, ?, ?, 'v1.ZZSEALEDSALE', 'ZZSTAFF Person', 'portal')").bind(id, day, at, type, total)),
  wo(914, 1, { status: 14, open: 0, sold: Z('2026-10-15', 11), value: 80, tax: 5 }),
  // 326: nothing synced; the day boundary: 11:30 PM Oct 14 is Oct 14 (not UTC's Oct 15), 12:30 AM Oct 15 is Oct 15
  wo(326, 2, { status: 14, open: 0, sold: Z('2026-10-14', 23, 30), value: 100, tax: 0 }),
  wo(326, 3, { status: 14, open: 0, sold: Z('2026-10-15', 0, 30), value: 40, tax: 0 }),
  // 536: sales today, no labor hours uploaded
  wo(536, 4, { status: 14, open: 0, sold: Z('2026-10-15', 12), value: 50, tax: 0 }),
  // open work orders by lane: 914 → order 2, start 2 (8, 24), work 4 (9–12), wait 4 (3, 4, 7 and 5), rfp 2; 326 → rfp 1 and an unknown status (99) → wait; a closed one isn't open
  ...open(914, 100, [2, 2, 8, 24, 9, 10, 11, 12, 3, 4, 7, 5, 13, 13]), ...open(326, 200, [13, 99]), wo(914, 300, { status: 14, open: 0, sold: Z('2026-10-08', 12), value: 1 }),
  // Ready for pickup: 914 two devices ($100 since Oct 3, $50 since Oct 14), 326 one ($30 since Oct 1: the oldest, 14 days)
  T.prepare('INSERT INTO rfp_periods (store, wo, start_at, end_at, value) VALUES (914, 100, ?, NULL, 100), (914, 101, ?, NULL, 50), (326, 200, ?, NULL, 30)').bind(Z('2026-10-03', 10), Z('2026-10-14', 10), Z('2026-10-01', 10)),
  T.prepare("INSERT INTO daily_metrics (store, day, metric, value, source, updated_at) VALUES (914, '2026-10-15', 'labor_hours', 10, 't', 'x'), (326, '2026-10-15', 'labor_hours', 8, 't', 'x'), (914, '2026-10-14', 'labor_hours', 20, 't', 'x'), (914, '2026-10-15', 'am_orders', 18, 't', 'x'), (914, '2026-10-15', 'cleanings_linked', 14, 't', 'x'), (914, '2026-10-14', 'am_orders', 10, 't', 'x'), (914, '2026-10-14', 'cleanings_linked', 5, 't', 'x'), (326, '2026-10-15', 'am_orders', 0, 't', 'x'), (326, '2026-10-15', 'cleanings_linked', 0, 't', 'x')"),
  T.prepare('INSERT INTO scans (store, at, by_name) VALUES (914, ?, ?), (326, ?, ?), (536, ?, ?), (914, ?, ?)').bind(new Date(NOW - 5 * 60000).toISOString(), 'x', new Date(NOW - 50 * 60000).toISOString(), 'x', new Date(NOW - 200 * 60000).toISOString(), 'x', '2026-10-01T15:00:00Z', 'x'),
]);
await W.prepare("INSERT INTO store_access (store, name, added_at) VALUES (914, 'Newport News', 'x'), (326, 'Lynnhaven', 'x'), (536, 'Lexington', 'x')").run();
const home = (ids, now = NOW) => buildHome(E, ids, names, now);
const near = (a, b, why) => assert.ok(Math.abs(a - b) < 0.006, why + ': ' + a + ' vs ' + b);

// ------------------------------------------------------------------ constants
assert.deepEqual(SPLH_TARGET, [160, 180]); assert.equal(STALE_MINUTES, 45);
assert.deepEqual([2, 8, 24, 9, 12, 3, 4, 7, 5, 1, 99, 13].map(laneOf), ['order', 'start', 'start', 'work', 'work', 'wait', 'wait', 'wait', 'wait', 'wait', 'wait', 'rfp'], 'lanes (Spread columns; unknown open statuses → Waiting)');

// ------------------------------------------------------------------ one store
{
  const h = await home([914]);
  assert.equal(h.today, '2026-10-15'); assert.equal(h.days.length, 7); assert.equal(h.days[0], '2026-10-09'); assert.equal(h.days[6], '2026-10-15');
  assert.equal(h.scope, 914);
  assert.deepEqual(h.sales.week, [null, null, null, 70, 130, 200, 85], 'days with no data are null (a dash), never 0; the 11:30 PM sale is Oct 14');
  assert.equal(h.sales.today, 85); assert.equal(h.sales.yesterday, 200);
  near(h.splh.today, 8.5, 'sales per labor hour = sales ÷ hours'); assert.equal(h.splh.hours, 10);
  assert.deepEqual(h.splh.week, [null, null, null, null, null, 10, 8.5], 'only days with sales and hours');
  assert.deepEqual(h.splh.target, [160, 180]);
  assert.deepEqual(h.lanes, { order: 2, start: 2, work: 4, wait: 4, rfp: 2, total: 14 });
  assert.equal(h.rfp.total, 150); assert.equal(h.rfp.count, 2); assert.equal(h.rfp.oldestDays, 12, 'oldest Ready for pickup: Oct 3 10:00 to Oct 15 16:00 is 12 days');
  assert.deepEqual(h.rfp.ages.map((a) => a.n), [1, 0, 1, 0, 0], 'ages: 1 day, 12 days');
  assert.equal(h.cleaning.cln, 14); assert.equal(h.cleaning.am, 18); near(h.cleaning.rate, 0.78, 'cleaning rate = linked cleanings ÷ Asurion Mobility orders');
  assert.deepEqual(h.cleaning.week.slice(0, 5), [null, null, null, null, null]); near(h.cleaning.week[5], 0.5, 'yesterday');
  assert.equal(h.asOf, new Date(NOW - 5 * 60000).toISOString()); assert.equal(h.stale, false); assert.equal(h.behind, null); assert.equal(h.byStore, undefined);
  assert.deepEqual(h.stores.map((s) => s.id), [914, 326, 536]);
}

// ------------------------------------------------------------------ missing labor hours, missing cleaning data
{
  const h = await home([536]);
  assert.equal(h.sales.today, 50); assert.equal(h.splh.today, null, 'no hours: a dash, not 0 or Infinity'); assert.equal(h.splh.hours, null);
  assert.ok(h.splh.week.every((v) => v == null));
  assert.equal(h.cleaning.rate, null); assert.equal(h.cleaning.cln, null);
  assert.equal(h.rfp.total, 0); assert.equal(h.rfp.oldestDays, null); assert.deepEqual(h.lanes, { order: 0, start: 0, work: 0, wait: 0, rfp: 0, total: 0 });
  const z = await home([326]); // orders uploaded as 0: no rate (not 0%, not NaN)
  assert.equal(z.cleaning.rate, null); assert.equal(z.cleaning.am, null);
  assert.doesNotMatch(JSON.stringify(h) + JSON.stringify(z), /Infinity|NaN/);
}

// ------------------------------------------------------------------ all stores
{
  const h = await home([914, 326, 536]);
  assert.equal(h.scope, 'all');
  assert.equal(h.sales.today, 175, 'sales summed: 85 + 40 + 50'); assert.equal(h.sales.yesterday, 300, '200 + 100 (326 estimated)');
  near(h.splh.today, 125 / 18, 'total sales of stores with hours ÷ their total hours (not an average of ratios, and 536 without hours is left out)'); assert.equal(h.splh.hours, 18);
  assert.deepEqual(h.lanes, { order: 2, start: 2, work: 4, wait: 5, rfp: 3, total: 16 }, 'lanes summed, the unknown status 99 is Waiting');
  assert.equal(h.rfp.total, 180); assert.equal(h.rfp.count, 3); assert.equal(h.rfp.oldestDays, 14);
  assert.equal(h.rfp.ages.reduce((s, a) => s + a.n, 0), 3);
  assert.equal(h.cleaning.cln, 14); assert.equal(h.cleaning.am, 18, 'combined');
  // freshness is the oldest store's, naming the store that is behind
  assert.equal(h.asOf, new Date(NOW - 200 * 60000).toISOString()); assert.equal(h.stale, true); assert.deepEqual(h.behind, { id: 536, name: 'Lexington' });
  assert.deepEqual(h.byStore.map((s) => [s.id, s.sales, s.stale]), [[914, 85, false], [326, 40, true], [536, 50, true]]);
  near(h.byStore[0].splh, 8.5, 'by store'); assert.equal(h.byStore[2].splh, null);
}

// ------------------------------------------------------------------ staleness: more than 45 minutes during store hours only
{
  const at = (min) => home([326], NOW + min * 60000); // 326's last scan is 50 minutes before NOW
  assert.equal((await at(-6)).stale, false, '44 minutes: fresh'); assert.equal((await at(-5)).stale, false, 'exactly 45: not yet');
  assert.equal((await at(0)).stale, true, '50 minutes: stale');
  const night = Date.parse(Z('2026-10-15', 20)); assert.equal((await home([326], night)).stale, false, 'after store hours the stopped scan is not "stale"');
  const sunday = Date.parse(Z('2026-10-18', 14)); assert.equal((await home([326], sunday)).stale, false, 'closed Sunday');
  assert.equal((await home([536], sunday)).stale, true, 'Lexington opens every day: stale on a Sunday');
}

// ------------------------------------------------------------------ the day boundary in store time, across the DST change (Nov 1, 2026: 25 hours)
{
  await T.batch([wo(326, 400, { status: 14, open: 0, sold: Z('2026-11-01', 23, 30), value: 70, tax: 0 }), wo(326, 401, { status: 14, open: 0, sold: Z('2026-11-02', 0, 20), value: 9, tax: 0 }),
    wo(326, 402, { status: 14, open: 0, sold: Z('2026-10-31', 23, 30), value: 7, tax: 0 })]);
  const dst = Date.parse(Z('2026-11-02', 16)), h = await home([326], dst);
  assert.deepEqual(h.days, ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  assert.equal(h.sales.week[4], 7, '11:30 PM Oct 31 (EDT) is Oct 31'); assert.equal(h.sales.week[5], 70, '11:30 PM Nov 1 (EST, after the change) is Nov 1'); assert.equal(h.sales.week[6], 9, '12:20 AM Nov 2 is Nov 2');
  assert.equal(h.today, '2026-11-02');
}

// ------------------------------------------------------------------ access: the admin site's /m and /api/m/home (developers only for now)
const SITE = { DB: W, TR: T, LOCAL_TEST: '1', TRACKER_OWNERS: 'owner@x.com' };
const person = (email, scope, stores, pages, details) => T.prepare('INSERT INTO people (email, scope, stores, pages, details) VALUES (?, ?, ?, ?, ?)').bind(email, scope, JSON.stringify(stores), JSON.stringify(pages), details).run();
await person('mgr@x.com', 'stores', [326], ['wos', 'sales', 'metrics', 'data', 'retrace'], 1);
await person('ol@x.com', 'all', [], ['wos', 'sales', 'metrics', 'data', 'usage', 'reports', 'auto', 'stores'], 1); // Owner role, but not a developer
const call = async (as, path, env = SITE) => {
  const u = new URL('http://localhost' + path); if (as) u.searchParams.set('as', as);
  const r = await site.fetch(new Request(u), env, { waitUntil() {} });
  const buf = new Uint8Array(await r.clone().arrayBuffer()); let j = null; try { j = JSON.parse(new TextDecoder().decode(buf)); } catch (_) {}
  return { status: r.status, h: r.headers, j, text: new TextDecoder().decode(buf), buf };
};
const NOWQ = '&now=' + NOW;
{
  const ok = await call('owner@x.com', '/api/m/home?store=all' + NOWQ);
  assert.equal(ok.status, 200); assert.equal(ok.j.scope, 'all'); assert.equal(ok.j.lanes.total, 16);
  assert.match(ok.h.get('cache-control'), /private, max-age=60/, 'cacheable for a minute, by the browser only');
  assert.equal((await call('owner@x.com', '/api/m/home?store=914' + NOWQ)).j.scope, 914);
  assert.equal((await call('owner@x.com', '/api/m/home?store=777' + NOWQ)).status, 403, 'a store that is not on the list'); assert.equal((await call('owner@x.com', '/api/m/home?store=abc')).status, 400);
  for (const who of ['ol@x.com', 'mgr@x.com', 'nobody@x.com', null]) {
    for (const path of ['/api/m/home?store=all', '/m', '/m/', '/m/app.js', '/m/sw.js', '/m/manifest.webmanifest', '/m/icon-192.png']) {
      const r = await call(who, path); assert.equal(r.status, 403, (who || 'local-test (not an owner)') + ' ' + path); assert.ok(!/ZZ|salesDays|"sales"/.test(r.text));
    }
  }
  // signed out on a real host: Access's check comes first
  const real = { TR: T, DB: W, TEAM_DOMAIN: 't.example', POLICY_AUD: 'aud', TRACKER_OWNERS: 'owner@x.com' };
  for (const path of ['/api/m/home', '/m', '/m/sw.js', '/m/manifest.webmanifest']) { const r = await site.fetch(new Request('https://admin.example' + path), real, { waitUntil() {} }); assert.equal(r.status, 403, 'signed out ' + path); }
  const post = await site.fetch(new Request('http://localhost/api/m/home?as=owner@x.com', { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: '{}' }), SITE, { waitUntil() {} });
  assert.equal(post.status, 403, 'read only');
  // a manager scoped to one store reaches it only if a page ever opens it up: the gate and the route both limit stores
  const { homeApi } = await import('../src/mobile.js');
  const mgr = { owner: false, scope: 'stores', stores: [326], email: 'mgr@x.com' };
  const asMgr = async (q) => homeApi(new Request('http://x/api/m/home?' + q), E, new URL('http://x/api/m/home?' + q), mgr, { now: NOW });
  assert.equal((await asMgr('store=914')).status, 403); const own = await (await asMgr('store=all')).json(); assert.deepEqual(own.stores.map((s) => s.id), [326]); assert.equal(own.scope, 326);
}

// ------------------------------------------------------------------ the shell: content types, policy, manifest, service worker, icons
{
  const html = await call('owner@x.com', '/m');
  assert.equal(html.status, 200); assert.match(html.h.get('content-type'), /^text\/html/);
  const csp = html.h.get('content-security-policy'); assert.match(csp, /script-src 'self'(;|$)/); assert.doesNotMatch(csp, /unsafe|https?:/, 'no inline script, no outside hosts');
  assert.match(html.text, /rel="manifest" href="\/m\/manifest\.webmanifest" crossorigin="use-credentials"/, 'the manifest is fetched with the Access cookie');
  assert.doesNotMatch(html.text, /<script>|onclick=|style=/); assert.equal((await call('owner@x.com', '/m/')).status, 200);
  const man = await call('owner@x.com', '/m/manifest.webmanifest'); assert.match(man.h.get('content-type'), /^application\/manifest\+json/);
  assert.equal(man.j.start_url, '/m'); assert.equal(man.j.scope, '/m'); assert.equal(man.j.display, 'standalone'); assert.equal(man.j.short_name, 'Linkpearl');
  for (const ic of man.j.icons) { const r = await call('owner@x.com', ic.src); assert.equal(r.status, 200, ic.src); assert.equal(r.h.get('content-type'), ic.type); if (ic.type === 'image/png') assert.deepEqual([...r.buf.slice(1, 4)], [80, 78, 71], 'PNG bytes'); }
  assert.ok(man.j.icons.some((i) => i.sizes === '192x192') && man.j.icons.some((i) => i.sizes === '512x512') && man.j.icons.some((i) => i.purpose === 'maskable'));
  const sw = await call('owner@x.com', '/m/sw.js'); assert.match(sw.h.get('content-type'), /javascript/); assert.equal(sw.h.get('service-worker-allowed'), '/m'); assert.match(sw.text, /^const V = "/);
  assert.match((await call('owner@x.com', '/m/app.js')).h.get('content-type'), /javascript/); assert.match((await call('owner@x.com', '/m/app.css')).h.get('content-type'), /^text\/css/);
  assert.equal((await call('owner@x.com', '/m/nope')).status, 404);
  // the worker caches nothing but the shell and Home answers, and only plain 200s
  assert.doesNotMatch(sw.text.replace(/\/\*[\s\S]*?\*\//, ''), /\/api\/(?!m\/home)/); assert.match(sw.text, /plain\(r\)/);
}

// ------------------------------------------------------------------ nothing private, and small
{
  const all = await call('owner@x.com', '/api/m/home?store=all' + NOWQ);
  assert.doesNotMatch(all.text, /ZZ|customer|sealed|card|completed_by|by_name|v1\./i, 'no customer details, no staff names, nothing sealed');
  assert.deepEqual(Object.keys(all.j).sort(), ['asOf', 'behind', 'byStore', 'cleaning', 'days', 'lanes', 'now', 'rfp', 'sales', 'scope', 'splh', 'stale', 'stores', 'today', 'tz', 'v'].sort());
  assert.ok(all.text.length < 2500, 'phone-sized: ' + all.text.length + ' bytes');
  for (const s of all.j.stores) assert.deepEqual(Object.keys(s).sort(), ['id', 'name']);
}
console.log('mobile: all passed');
await dispose();
