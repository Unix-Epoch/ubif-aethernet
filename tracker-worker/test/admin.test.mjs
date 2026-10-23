// Per-person access on the admin site (Oct 17, 2026): runs the real admin-worker (admin-worker/src/index.js)
// against local D1 databases (wrangler getPlatformProxy), signed in through its LOCAL_TEST `?as=` switch.
// Covers the gate (tracker-worker/src/access.js) for every kind of route: Waymark's adminApi, the tracker's
// trackerAdmin, unknown routes; store scope; sealed fields stripped; developers (TRACKER_OWNERS) only for access; roles; the migration.
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { register } from 'node:module';
import { getPlatformProxy } from 'wrangler';

// admin-worker imports a few files as text (wrangler [[rules]] type Text); give Node the same.
register('data:text/javascript,' + encodeURIComponent(`
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function load(url, ctx, next) {
  const asText = url.endsWith('.txt') || url.endsWith('?as-text') || (ctx.importAttributes && ctx.importAttributes.type === 'text')
    || ((url.endsWith('/admin-worker/src/tracker-ui.js') || url.endsWith('/admin-worker/src/metrics-ui.js') || url.endsWith('/admin-worker/src/rules-ui.js') || url.endsWith('/tracker-worker/src/crypto.js')) && ctx.parentURL && ctx.parentURL.endsWith('/admin-worker/src/index.js'));
  if (!asText) return next(url, ctx);
  return { format: 'module', source: 'export default ' + JSON.stringify(readFileSync(fileURLToPath(url), 'utf8')), shortCircuit: true };
}
export async function resolve(spec, ctx, next) {
  const r = await next(spec, ctx);
  // Same file imported as text by admin-worker and as code elsewhere: keep them apart.
  if (ctx.parentURL && ctx.parentURL.endsWith('/admin-worker/src/index.js') && /(tracker-ui|metrics-ui|rules-ui|crypto)\\.js$/.test(r.url)) return Object.assign({}, r, { url: r.url + '?as-text' });
  if (ctx.importAttributes && ctx.importAttributes.type === 'text') return Object.assign({}, r, { url: r.url + '?as-text', importAttributes: {} });
  return r;
}`));
const { default: site } = await import('../../admin-worker/src/index.js');
const { trackerAdmin } = await import('../src/index.js');
const { accessOf, gate } = await import('../src/access.js');

rmSync('.wrangler-test-admin', { recursive: true, force: true });
const { env, dispose } = await getPlatformProxy({ configPath: 'wrangler.toml', persist: { path: '.wrangler-test-admin' } });
const sql = (file) => readFileSync(file, 'utf8').replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean);
for (const s of sql('schema.sql')) await env.TR.prepare(s).run();
for (const s of sql('../worker/schema.sql')) await env.AE.prepare(s).run();
const T = env.TR, W = env.AE;
const E = { DB: W, TR: T, LOCAL_TEST: '1', TRACKER_OWNERS: 'owner@x.com' };

// Fake stores, people, work orders (nothing real).
await W.prepare("INSERT INTO store_access (store, name, added_at) VALUES (914, 'Newport News', '2026-10-01'), (326, 'Lynnhaven', '2026-10-01')").run();
await W.prepare("INSERT INTO store_seen (store, name, first_at, last_at, loads) VALUES (777, 'Waiting Store', '2026-10-01', '2026-10-16', 3)").run();
const day = new Date().toISOString().slice(0, 10);
await W.prepare("INSERT INTO usage (day, store, store_name, user_id, user_name, feature, count) VALUES (?, 914, 'Newport News', 1, 'Tech A', 'waymark', 5), (?, 326, 'Lynnhaven', 2, 'Tech B', 'waymark', 7)").bind(day, day).run();
await W.prepare("INSERT INTO feedback (store, store_name, kind, text, status, created_at, updated_at) VALUES (914, 'Newport News', 'bug', 'x', 'new', '2026-10-16', '2026-10-16')").run();
for (const [store, wo, st] of [[914, 5001, 13], [914, 5002, 2], [326, 6001, 10]]) {
  await T.prepare("INSERT INTO workorders (store, wo, store_name, status_id, status_name, is_open, first_seen_at, card, plain) VALUES (?, ?, 'S', ?, 'x', 1, '2026-10-16T00:00:00Z', 'v1.SEALEDCARD', '{}')").bind(store, wo, st).run();
  await T.prepare("INSERT INTO snapshots (store, wo, fetched_at, hash, plain, sealed) VALUES (?, ?, '2026-10-16T00:00:00Z', 'h', '{}', 'v1.SEALEDSNAP')").bind(store, wo).run();
}
await T.prepare("INSERT INTO sales (store, sale_id, sale_day, total, card, source) VALUES (914, 's1', '2026-10-16', 10, 'v1.SEALEDSALE', 'portal'), (326, 's2', '2026-10-16', 20, 'v1.SEALEDSALE2', 'portal')").run();
await T.prepare("INSERT INTO sales_days (store, day, source, count, total) VALUES (914, '2026-10-16', 'portal', 1, 10), (326, '2026-10-16', 'portal', 1, 20)").run();
const person = (email, scope, stores, pages, details) => T.prepare('INSERT INTO people (email, scope, stores, pages, details) VALUES (?, ?, ?, ?, ?)').bind(email, scope, JSON.stringify(stores), JSON.stringify(pages), details).run();
await person('viewer@x.com', 'stores', [914], ['wos'], 0);                                         // Store viewer
await person('mgr@x.com', 'stores', [914], ['wos', 'sales', 'metrics', 'data'], 1);                // Manager
await person('ol@x.com', 'all', [], ['wos', 'sales', 'metrics', 'data', 'usage', 'reports', 'auto', 'stores'], 1); // Owner (was Owner-level)
await person('rep@x.com', 'stores', [326], ['reports', 'usage'], 0);

const call = async (as, method, path, body) => {
  const u = new URL('http://localhost' + path); u.searchParams.set('as', as);
  const r = await site.fetch(new Request(u, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }), E);
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (_) {}
  return { status: r.status, j, text };
};
const denies = async () => (await T.prepare("SELECT * FROM access_log WHERE action = 'denied' ORDER BY id").all()).results;

// --- the Access check is still first: no LOCAL_TEST, no token → 403 before any database work
assert.equal((await site.fetch(new Request('http://localhost/api/usage'), { TR: T, DB: W })).status, 403, 'Access check still applies');
assert.equal((await site.fetch(new Request('https://admin.example/api/usage?as=owner@x.com'), E)).status, 403, 'as= only on localhost');

// --- owner bypass: every page, every store, changes allowed
for (const p of ['/api/usage', '/api/stores', '/api/feedback', '/api/auto-rules', '/api/store/326', '/api/tracker/wos', '/api/tracker/people', '/api/tracker/log']) assert.equal((await call('owner@x.com', 'GET', p)).status, 200, 'owner ' + p);
assert.equal((await call('owner@x.com', 'GET', '/api/usage')).j.rows.length, 2);
assert.equal((await call('owner@x.com', 'GET', '/api/stores')).j.waiting.length, 1);
assert.equal((await call('owner@x.com', 'POST', '/api/auto-rules', { rule: 'callback', state: 'staged' })).status, 200, 'owner pushes rules');
const ow = (await call('owner@x.com', 'GET', '/api/tracker/wos')).j.wos;
assert.equal(ow.length, 3); assert.ok(ow.every((w) => w.card), 'owner gets sealed cards');
const om = (await call('owner@x.com', 'GET', '/api/tracker/me')).j.access;
assert.equal(om.owner, true); assert.ok(om.pages.includes('people') && om.pages.includes('metrics'));

// --- the Assize rules editor's engine, served to the page as modules (page 'rules'); the same code the Worker runs
// The Assize rules editor's page script, the same way (and only with page 'rules').
{
  const r = await call('owner@x.com', 'GET', '/rules-ui.js');
  assert.equal(r.status, 200); assert.match(r.text, /export async function draw\(/); assert.match(r.text, /from '\/rulegraph\.js'/);
  assert.equal((await call('viewer@x.com', 'GET', '/rules-ui.js')).status, 403, 'no rules page: /rules-ui.js');
  assert.match((await call('owner@x.com', 'GET', '/')).text, /import\('\/rules-ui\.js'\)/, 'page.js loads the editor');
  assert.doesNotMatch((await call('owner@x.com', 'GET', '/')).text, /editor is coming/, 'the placeholder is gone');
}
for (const [path, name] of [['/rulegraph.js', 'run'], ['/assize-rules.js', 'makeRules']]) {
  const r = await call('owner@x.com', 'GET', path);
  assert.equal(r.status, 200, path);
  const mod = await import('data:text/javascript,' + encodeURIComponent(r.text));
  assert.equal(typeof mod[name], 'function', path + ' works as a browser module');
  assert.equal((await call('viewer@x.com', 'GET', path)).status, 403, 'no rules page: ' + path);
}
assert.equal((await call('owner@x.com', 'GET', '/api/tracker/assize/rules')).status, 200);
for (const [m, p, b] of [['GET', '/api/tracker/assize/rules'], ['PUT', '/api/tracker/assize/rules/no-bin/draft', { scope: 914, graph: {} }], ['GET', '/api/tracker/assize/orders?store=914'], ['GET', '/api/tracker/assize/stores']]) assert.equal((await call('mgr@x.com', m, p, b)).status, 403, 'manager without the rules page: ' + p);

// --- store viewer: only their store's work orders, nothing sealed, nothing else
const vw = await call('viewer@x.com', 'GET', '/api/tracker/wos');
assert.equal(vw.status, 200); assert.deepEqual([...new Set(vw.j.wos.map((w) => w.store))], [914], 'All stores list cut to their stores');
assert.ok(!/SEALED/.test(vw.text) && vw.j.wos.every((w) => !('card' in w)), 'no sealed card with details off');
assert.ok(!/SEALED/.test((await call('viewer@x.com', 'GET', '/api/tracker/wos?detail=1')).text), 'detail=1 adds nothing sealed');
const vo = await call('viewer@x.com', 'GET', '/api/tracker/wo/914/5001');
assert.equal(vo.status, 200); assert.ok(!/SEALED/.test(vo.text) && !('card' in vo.j.wo) && !('sealed' in vo.j.snapshots[0]), 'one WO without sealed fields');
assert.equal((await call('viewer@x.com', 'GET', '/api/tracker/wos?store=326')).status, 403, 'other store refused');
assert.equal((await call('viewer@x.com', 'GET', '/api/tracker/wo/326/6001')).status, 403);
const vs = (await call('viewer@x.com', 'GET', '/api/tracker/stores')).j.stores;
assert.deepEqual(vs.map((s) => s.store), [914]);
assert.equal((await call('viewer@x.com', 'GET', '/api/tracker/store-keys')).status, 403);
assert.equal((await call('viewer@x.com', 'PUT', '/api/tracker/me/keys', { keys: [{ kind: 'store', store: 914 }] })).status, 403, 'no key copies with details off');
const vme = (await call('viewer@x.com', 'GET', '/api/tracker/me')).j;
assert.deepEqual(vme.access.pages, ['wos']); assert.equal(vme.access.details, false); assert.equal(vme.access.owner, false);

// --- forbidden page → 403 + a 'denied' row (one per person/route/hour)
const before = (await denies()).length;
const fu = await call('viewer@x.com', 'GET', '/api/usage');
assert.equal(fu.status, 403); assert.equal(fu.j.page, 'usage');
await call('viewer@x.com', 'GET', '/api/usage');
let dn = await denies();
assert.equal(dn.length, before + 1, 'denied logged once per hour');
assert.equal(dn[dn.length - 1].email, 'viewer@x.com'); assert.match(dn[dn.length - 1].detail, /GET \/api\/usage · page usage not allowed/);
for (const [m, p, b] of [['GET', '/api/tracker/sales/days?from=2026-10-16&to=2026-10-16'], ['GET', '/api/feedback'], ['GET', '/api/store/914'], ['GET', '/api/auto-rules'], ['POST', '/api/auto-rules', { rule: 'callback', state: 'live' }],
  ['GET', '/api/stores'], ['POST', '/api/stores', { store: 555 }], ['POST', '/api/stores/914/remove', {}], ['GET', '/api/config'], ['GET', '/api/tracker/people'], ['GET', '/api/tracker/log'], ['GET', '/api/tracker/metrics'], ['GET', '/metrics-ui.js'], ['GET', '/api/next-version']]) {
  assert.equal((await call('viewer@x.com', m, p, b)).status, 403, 'viewer ' + m + ' ' + p);
}
assert.equal((await W.prepare('SELECT COUNT(*) AS n FROM store_access').first()).n, 2, 'viewer changed no store access');
assert.equal((await W.prepare("SELECT state FROM auto_rules WHERE rule = 'callback'").first()).state, 'staged', 'viewer pushed no rule');

// --- unknown routes are refused (deny by default), for everyone but owners' real routes
for (const p of ['/api/ping', '/api/tracker/whatever', '/api/whatever', '/api/tracker/agents-x']) assert.equal((await call('ol@x.com', 'GET', p)).status, 403, 'unknown ' + p);
assert.equal((await call('owner@x.com', 'GET', '/api/whatever')).status, 403, 'unknown route even for an owner');
assert.ok((await denies()).some((d) => /unknown route/.test(d.detail)));
// not on the list at all: only /me answers (so the page can say who to ask)
assert.equal((await call('nobody@x.com', 'GET', '/api/tracker/me')).j.access, null);
for (const p of ['/api/usage', '/api/stores', '/api/tracker/wos', '/api/feedback']) assert.equal((await call('nobody@x.com', 'GET', p)).status, 403, 'not listed ' + p);

// --- manager: their store's Store data, sales; All stores pages need explicit permission
assert.equal((await call('mgr@x.com', 'GET', '/api/store/914')).status, 200);
assert.equal((await call('mgr@x.com', 'GET', '/api/store/326')).status, 403, 'Store data for another store');
const ms = (await call('mgr@x.com', 'GET', '/api/stores')).j;
assert.deepEqual(ms.allowed.map((s) => s.store), [914], 'store picker cut to their stores'); assert.equal(ms.waiting.length, 0);
for (const [m, p, b] of [['POST', '/api/stores', { store: 555 }], ['GET', '/api/feedback'], ['GET', '/api/auto-rules'], ['GET', '/api/usage']]) assert.equal((await call('mgr@x.com', m, p, b)).status, 403, 'manager ' + p);
const md = (await call('mgr@x.com', 'GET', '/api/tracker/sales/days?from=2026-10-16&to=2026-10-16')).j.days;
assert.deepEqual(md.map((d) => d.store), [914], 'sales cut to their stores');
assert.ok(/SEALEDSALE"/.test((await call('mgr@x.com', 'GET', '/api/tracker/sales/day?store=914&day=2026-10-16')).text), 'details on: sealed card still sent');
assert.equal((await call('mgr@x.com', 'GET', '/api/tracker/sales/day?store=326&day=2026-10-16')).status, 403);
// reports/usage person on 326: Reports is Aethernet-wide, Usage is cut to their store
assert.equal((await call('rep@x.com', 'GET', '/api/feedback')).status, 200);
assert.deepEqual((await call('rep@x.com', 'GET', '/api/usage')).j.rows.map((r) => r.store), [326]);
// Owner: every page but People and Assize rules
for (const p of ['/api/usage', '/api/stores', '/api/feedback', '/api/auto-rules', '/api/store/326', '/api/tracker/wos']) assert.equal((await call('ol@x.com', 'GET', p)).status, 200, 'owner ' + p);
assert.equal((await call('ol@x.com', 'GET', '/api/tracker/assize/rules')).status, 403, 'Owner has no Assize rules page');
assert.equal((await call('ol@x.com', 'GET', '/api/stores')).j.waiting.length, 1);

// --- only owners change access
assert.equal((await call('ol@x.com', 'POST', '/api/tracker/people', { email: 'new@x.com', scope: 'stores', stores: [914] })).status, 403, 'owner cannot add people');
assert.equal((await call('ol@x.com', 'GET', '/api/tracker/people')).j.error, 'developers only');
assert.equal((await call('ol@x.com', 'POST', '/api/tracker/people/viewer%40x.com/remove')).status, 403);
assert.equal((await call('mgr@x.com', 'POST', '/api/tracker/people', { email: 'mgr@x.com', scope: 'all', pages: ['stores'] })).status, 403, 'no raising your own access');
assert.equal((await call('ol@x.com', 'GET', '/api/tracker/agents')).status, 403);
// new person: Store viewer by default
assert.equal((await call('owner@x.com', 'POST', '/api/tracker/people', { email: 'New@x.com', name: 'New Person', scope: 'stores', stores: [326] })).status, 200);
const np = await accessOf(E, 'new@x.com');
assert.deepEqual(np.pages, ['wos']); assert.equal(np.details, false); assert.deepEqual(np.stores, [326]);
// change: pages + stores, logged as a diff; 'people' can't be granted; details off refuses key copies
assert.equal((await call('owner@x.com', 'POST', '/api/tracker/people', { email: 'new@x.com', scope: 'stores', stores: [326, 914], pages: ['wos', 'metrics', 'people', 'bogus'], details: false })).status, 200);
assert.deepEqual((await accessOf(E, 'new@x.com')).pages, ['wos', 'metrics'], 'people / unknown pages dropped');
const copy = { kind: 'store', store: 914, salt: 'c2FsdHNhbHRzYWx0', rounds: 200000, wrapped: 'p1.' + 'A'.repeat(200) };
assert.equal((await call('owner@x.com', 'POST', '/api/tracker/people', { email: 'new@x.com', scope: 'stores', stores: [914], details: false, keys: [copy] })).status, 400);
const acc = (await call('owner@x.com', 'GET', '/api/tracker/log?kind=access')).j.log;
assert.ok(acc.some((l) => l.action === 'access:add' && /new@x.com · store viewer · stores 326 · details off/.test(l.detail)), 'access:add');
assert.ok(acc.some((l) => l.action === 'access:change' && /pages \+metrics · stores \+914/.test(l.detail)), 'access:change diff');
assert.ok(acc.some((l) => l.action === 'denied'), 'denied rows in the access log');
assert.ok(!(await call('owner@x.com', 'GET', '/api/tracker/log')).j.log.some((l) => l.action === 'denied' || l.action.startsWith('access:')), 'recent activity keeps views only');
// details on with an invite, then off: copies deleted
await T.prepare("INSERT INTO store_keys (store, public_jwk, wrapped_private) VALUES (914, '{}', 'x')").run();
assert.equal((await call('owner@x.com', 'POST', '/api/tracker/people', { email: 'new@x.com', scope: 'stores', stores: [914], pages: ['wos'], details: true, keys: [copy] })).status, 200);
assert.equal((await T.prepare("SELECT COUNT(*) AS n FROM person_keys WHERE email = 'new@x.com'").first()).n, 1);
assert.ok((await call('owner@x.com', 'GET', '/api/tracker/log?kind=access')).j.log.some((l) => l.action === 'access:keys' && /invite for 914/.test(l.detail)));
assert.equal((await call('owner@x.com', 'POST', '/api/tracker/people', { email: 'new@x.com', scope: 'stores', stores: [914], pages: ['wos'], details: false })).status, 200);
assert.equal((await T.prepare("SELECT COUNT(*) AS n FROM person_keys WHERE email = 'new@x.com'").first()).n, 0, 'details off deletes copies');
assert.equal((await call('owner@x.com', 'POST', '/api/tracker/people/new%40x.com/remove')).status, 200);
assert.equal(await accessOf(E, 'new@x.com'), null);
assert.ok((await call('owner@x.com', 'GET', '/api/tracker/log?kind=access')).j.log.some((l) => l.action === 'access:remove'));

// --- roles: the four presets as before (Owner-level is now Owner, same pages); Assize rules adds to any of them
{
  const { presetOf } = await import('../src/access.js');
  const P8 = ['wos', 'sales', 'metrics', 'data', 'usage', 'reports', 'auto', 'stores'];
  assert.equal(presetOf({ scope: 'all', details: true, pages: P8 }), 'owner', 'existing Owner-level people show as Owner, no change');
  assert.equal(presetOf({ scope: 'all', details: true, pages: [...P8, 'rules'] }), 'owner + assize rules');
  assert.equal(presetOf({ scope: 'stores', details: true, pages: ['wos', 'sales', 'metrics', 'data', 'rules'] }), 'manager + assize rules');
  assert.equal(presetOf({ scope: 'stores', details: false, pages: ['wos'] }), 'store viewer');
  assert.equal(presetOf({ scope: 'stores', details: false, pages: ['rules'] }), 'custom');
  assert.equal((await call('owner@x.com', 'POST', '/api/tracker/people', { email: 'ol@x.com', scope: 'all', pages: [...P8, 'rules'], details: true })).status, 200);
  assert.deepEqual((await accessOf(E, 'ol@x.com')).pages, [...P8, 'rules']);
  assert.ok((await call('owner@x.com', 'GET', '/api/tracker/log?kind=access')).j.log.some((l) => l.action === 'access:change' && l.detail === 'ol@x.com · pages +rules · role owner → owner + assize rules'), 'access change log names the page and the role');
  assert.equal((await call('ol@x.com', 'GET', '/api/tracker/assize/rules')).status, 200, 'now they have it');
  assert.equal((await call('owner@x.com', 'POST', '/api/tracker/people', { email: 'ol@x.com', scope: 'all', pages: P8, details: true })).status, 200);
  assert.deepEqual((await call('owner@x.com', 'GET', '/api/tracker/people')).j.pages, [...P8, 'rules', 'retrace'], 'the People page lists Assize rules and Retrace');
  // Retrace (Oct 23, 2026) joins the Manager and Owner roles; people given those roles before still show as them
  assert.equal(presetOf({ scope: 'all', details: true, pages: [...P8, 'retrace'] }), 'owner');
  assert.equal(presetOf({ scope: 'stores', details: true, pages: ['wos', 'sales', 'metrics', 'data', 'retrace'] }), 'manager');
  assert.equal(presetOf({ scope: 'stores', details: false, pages: ['wos', 'retrace'] }), 'custom');
}

// --- Retrace (page 'retrace', store-scoped): through the site's gate, like every tracker route
await T.prepare("UPDATE people SET pages = ? WHERE email = 'mgr@x.com'").bind(JSON.stringify(['wos', 'sales', 'metrics', 'data', 'retrace'])).run();
assert.equal((await call('mgr@x.com', 'GET', '/api/tracker/retrace/item/914/180001')).status, 200, 'manager: their store');
assert.equal((await call('mgr@x.com', 'GET', '/api/tracker/retrace/item/326/180001')).status, 403, 'manager: another store');
assert.equal((await call('mgr@x.com', 'GET', '/api/tracker/retrace/label/326/180001-0000600001')).status, 403);
assert.equal((await call('mgr@x.com', 'GET', '/api/tracker/retrace/search?store=326&q=180001')).status, 403);
assert.equal((await call('mgr@x.com', 'GET', '/api/tracker/retrace/coverage')).status, 200);
assert.equal((await call('viewer@x.com', 'GET', '/api/tracker/retrace/coverage')).status, 403, 'no Retrace page');
assert.equal((await call('ol@x.com', 'GET', '/api/tracker/retrace/item/326/180001')).status, 403, 'an Owner from before Retrace needs the page added');
assert.equal((await call('owner@x.com', 'GET', '/api/tracker/retrace/item/326/180001')).status, 200, 'developers: everything');
assert.equal((await call('mgr@x.com', 'POST', '/api/tracker/retrace/coverage')).status, 403, 'read only: unknown route');

// --- trackerAdmin gates on its own too (called directly, without the site's gate)
const direct = async (email, path) => (await trackerAdmin(new Request('https://a.test/api/tracker' + path), E, new URL('https://a.test/api/tracker' + path), path.split('?')[0], email)).status;
assert.equal(await direct('viewer@x.com', '/sales/days?from=2026-10-16&to=2026-10-16'), 403);
assert.equal(await direct('viewer@x.com', '/nope'), 403);
assert.equal(gate(null, 'GET', '/api/usage', '').status, 403, 'not listed'); assert.equal(gate(null, 'GET', '/api/tracker/me', ''), null, '/me answers anyone signed in');

// --- migration: everyone keeps what they could open before; owners unchanged; review flagged
for (const s of ['DROP TABLE IF EXISTS people', 'DROP TABLE IF EXISTS person_keys', 'DROP TABLE IF EXISTS access_log',
  "CREATE TABLE people (email TEXT PRIMARY KEY, name TEXT, scope TEXT NOT NULL CHECK (scope IN ('all', 'stores')), stores TEXT NOT NULL DEFAULT '[]', added_by TEXT, added_at TEXT, last_seen_at TEXT)",
  "CREATE TABLE person_keys (email TEXT NOT NULL, kind TEXT NOT NULL, store INTEGER NOT NULL DEFAULT 0, salt TEXT NOT NULL, rounds INTEGER NOT NULL, wrapped TEXT NOT NULL, invite INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at TEXT, PRIMARY KEY (email, kind, store))",
  'CREATE TABLE access_log (id INTEGER PRIMARY KEY, email TEXT, action TEXT, store INTEGER, wo INTEGER, detail TEXT, at TEXT)',
  "INSERT INTO people (email, scope, stores) VALUES ('owner@x.com', 'all', '[]'), ('dm@x.com', 'all', '[]'), ('gm@x.com', 'stores', '[914]'), ('tech@x.com', 'stores', '[326]')",
  "INSERT INTO person_keys (email, kind, store, salt, rounds, wrapped) VALUES ('owner@x.com', 'master', 0, 's', 1, 'w'), ('dm@x.com', 'master', 0, 's', 1, 'w'), ('gm@x.com', 'store', 914, 's', 1, 'w')"]) await W.prepare(s).run();
for (const s of sql('migrations/2026-10-17-access.sql')) await W.prepare(s).run();
const M = { TR: W, DB: W, TRACKER_OWNERS: 'owner@x.com' };
// Before: every Access user reached every adminApi route; scope limited the tracker routes. All of it must still pass.
const reach = [['GET', '/api/usage'], ['GET', '/api/stores'], ['POST', '/api/stores'], ['POST', '/api/stores/914/remove'], ['GET', '/api/config'], ['GET', '/api/feedback'], ['POST', '/api/feedback/1'], ['GET', '/api/next-version'],
  ['GET', '/api/auto-rules'], ['POST', '/api/auto-rules'], ['GET', '/api/tracker/me'], ['GET', '/api/tracker/stores'], ['GET', '/api/tracker/wos'], ['GET', '/api/tracker/sales/days']];
for (const email of ['owner@x.com', 'dm@x.com', 'gm@x.com', 'tech@x.com']) {
  const who = await accessOf(M, email);
  for (const [m, p] of reach) assert.equal(gate(who, m, p, ''), null, 'migrated ' + email + ' still reaches ' + m + ' ' + p);
  const mine = email === 'gm@x.com' ? 914 : email === 'tech@x.com' ? 326 : null;
  // Store data: their own stores (the one deliberate narrowing: store-scoped pages now follow their store list).
  for (const st of mine ? [mine] : [914, 326]) assert.equal(gate(who, 'GET', '/api/store/' + st, ''), null, email + ' Store data ' + st);
  if (mine) { assert.equal(gate(who, 'GET', '/api/tracker/wo/' + mine + '/1', ''), null); assert.ok(gate(who, 'GET', '/api/tracker/wos', '?store=' + (mine === 914 ? 326 : 914)), 'store scope kept'); }
}
assert.equal((await accessOf(M, 'gm@x.com')).details, true, 'key holders keep customer details');
assert.equal((await accessOf(M, 'tech@x.com')).details, false, 'no copies, no details (they had nothing to open)');
assert.equal((await accessOf(M, 'dm@x.com')).review, true);
assert.equal((await accessOf(M, 'owner@x.com')).owner, true);
assert.ok(gate(await accessOf(M, 'dm@x.com'), 'GET', '/api/tracker/people', ''), 'People editing is developers only now');
assert.match((await W.prepare("SELECT detail FROM access_log WHERE action = 'access:migrate'").first()).detail, /^4 people kept/);
for (const s of ['DROP TABLE people', 'DROP TABLE person_keys', 'DROP TABLE access_log']) await W.prepare(s).run();

await dispose();
rmSync('.wrangler-test-admin', { recursive: true, force: true });
console.log('admin access: all passed');
