// Runs the tracker Worker against local D1 databases (wrangler getPlatformProxy), the way
// Aethernet (store side) and the admin site (trackerAdmin) would use it.
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { getPlatformProxy } from 'wrangler';
import worker, { trackerAdmin, trim } from '../src/index.js';
import * as C from '../src/crypto.js';

rmSync('.wrangler-test', { recursive: true, force: true });
const { env, dispose } = await getPlatformProxy({ configPath: 'wrangler.toml', persist: { path: '.wrangler-test' } });
for (const stmt of readFileSync('schema.sql', 'utf8').replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean)) await env.TR.prepare(stmt).run();
await env.AE.prepare('CREATE TABLE IF NOT EXISTS store_access (store INTEGER PRIMARY KEY, name TEXT, added_by TEXT, added_at TEXT)').run();
await env.AE.prepare("INSERT INTO store_access (store, name) VALUES (914, 'Newport News'), (326, 'Lynnhaven')").run();
const E = Object.assign({}, env, { APP_KEY: 'k', TRACKER_OWNERS: 'owner@x.com', LIMITER: null });

const call = async (method, path, body, key = 'k') => {
  const r = await worker.fetch(new Request('https://t.test' + path, { method, headers: { 'x-aethernet-key': key, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), E, {});
  return { status: r.status, j: await r.json() };
};
const admin = async (email, method, path, body) => {
  const r = await trackerAdmin(new Request('https://a.test/api/tracker' + path, { method, body: body ? JSON.stringify(body) : undefined }), E, new URL('https://a.test/api/tracker' + path), path.split('?')[0], email);
  return { status: r.status, j: await r.json() };
};
const ok = (r, what) => assert.ok(r.status < 300, what + ': ' + r.status + ' ' + JSON.stringify(r.j));

// --- gates
assert.equal((await call('GET', '/v1/tracker/master', null, 'wrong')).status, 403);
assert.equal((await call('GET', '/v1/tracker/master')).status, 404);
assert.equal((await call('GET', '/v1/999/tracker/key')).status, 403, 'store without access');

// --- setup: only an owner, once
const PHRASE = 'harbor violet tundra pickle anchor ember';
const master = await C.newKeyPair();
const copy = await C.lockWithPhrase(await C.exportPrivate(master.privateKey), PHRASE, C.aad.person('owner@x.com', 'master', 0));
assert.equal((await admin('someone@x.com', 'POST', '/init', { publicJwk: master.publicJwk, copy })).status, 403);
ok(await admin('owner@x.com', 'POST', '/init', { publicJwk: master.publicJwk, copy }), 'init');
assert.equal((await admin('owner@x.com', 'POST', '/init', { publicJwk: master.publicJwk, copy })).status, 409);

// --- store key: first install creates it, a second one gets the same key back
const mp = (await call('GET', '/v1/tracker/master')).j.publicJwk;
assert.equal((await call('GET', '/v1/914/tracker/key')).status, 404);
const k1 = await C.newStoreKey(914, mp), k2 = await C.newStoreKey(914, mp);
const a = (await call('POST', '/v1/914/tracker/key', k1)).j.publicJwk, b = (await call('POST', '/v1/914/tracker/key', k2)).j.publicJwk;
assert.deepEqual(a, b); assert.equal(a.x, k1.publicJwk.x);
assert.equal((await call('POST', '/v1/914/tracker/key', { publicJwk: Object.assign({ d: 'secret' }, k1.publicJwk), wrappedPrivate: k1.wrappedPrivate })).status, 400, 'private JWK refused');
const sk = (await call('GET', '/v1/914/tracker/key')).j.publicJwk;

// --- scan: everything new is needed, and claimed (a second browser gets nothing)
const rows = [1, 2, 3].map((i) => ({ wo: 5000 + i, statusId: i === 3 ? 13 : 2, status: i === 3 ? 'Ready for pickup' : 'Work in progress', programId: 1, program: 'OOW', updatedAt: '2026-10-12T10:00:0' + i + 'Z', createdAt: '2026-10-10T10:00:00Z' }));
let s = await call('POST', '/v1/914/tracker/scan', { rows, storeName: 'Newport News', by: 'Tech A' });
ok(s, 'scan'); assert.deepEqual(s.j.need.map((n) => n.why), ['new', 'new', 'new']);
assert.equal((await call('POST', '/v1/914/tracker/scan', { rows })).j.need.length, 0, 'claimed by the first browser');

// --- detail: sealed with the store key; plain part readable
const detail = (wo, statusId, status, extra = {}) => ({ workorder: { workorder: { workorderId: wo, customer: { name: 'Jordan Reyes', phone: '757-555-0100' } } }, notes: ['Customer said hi'], ...extra });
const plain = (wo, statusId, status, due = 0) => ({ workorder: { workorderId: wo, storeId: 914, statusId, status, programId: 1, program: 'OOW', device: 'iPhone 15', updatedAt: '2026-10-12T10:00:00Z' },
  auditTrail: [{ statusId, createdAt: '2026-10-12T10:00:00Z' }], cart: { items: [{ name: 'Screen', sku: '1', price: 199, quantity: 1 }], payment: { total: due, amountPaid: 0, amountDue: due } } });
const send = async (wo, statusId, status, due, trigger = 'new') => {
  const d = detail(wo, statusId, status), p = plain(wo, statusId, status, due);
  return call('POST', '/v1/914/tracker/wo/' + wo, { hash: await C.hashJson([d, p]), trigger, plain: p, sealed: await C.sealJson(d, sk, C.aad.snapshot(914, wo)),
    card: await C.sealJson({ name: 'Jordan Reyes', phone: '7575550100' }, sk, C.aad.card(914, wo)), by: 'Tech A' });
};
ok(await send(5001, 2, 'Work in progress', 0), 'wo 5001'); ok(await send(5002, 2, 'Work in progress', 0), 'wo 5002'); ok(await send(5003, 13, 'Ready for pickup', 79.5), 'wo 5003');
assert.equal((await send(5003, 13, 'Ready for pickup', 79.5)).j.same, true, 'unchanged detail not stored twice');
const ch = await send(5003, 13, 'Ready for pickup', 99.5);
assert.ok(ch.j.changes >= 2, 'cart change recorded: ' + ch.j.changes);
assert.equal((await call('POST', '/v1/914/tracker/wo/5001', { hash: 'x', plain: plain(5001, 2, 'x'), sealed: 'not sealed' })).status, 400);
// Nothing readable about the customer anywhere in the database
const dump = JSON.stringify((await env.TR.prepare('SELECT * FROM snapshots').all()).results) + JSON.stringify((await env.TR.prepare('SELECT * FROM workorders').all()).results) + JSON.stringify((await env.TR.prepare('SELECT * FROM changes').all()).results);
assert.ok(!/Jordan|555|Customer said/.test(dump), 'customer data leaked into the database');

// --- next scan: 5002 left the list (closed in Portal), 5001 changed
const rows2 = [Object.assign({}, rows[0], { updatedAt: '2026-10-12T11:00:00Z' }), rows[2]];
await env.TR.prepare('UPDATE workorders SET claimed_until = NULL').run();
s = await call('POST', '/v1/914/tracker/scan', { rows: rows2 });
assert.deepEqual(s.j.need.map((n) => n.wo + ':' + n.why).sort(), ['5001:changed', '5002:missing']);
ok(await send(5002, 14, 'Sale complete', 0, 'missing'), 'closing');
assert.equal((await env.TR.prepare('SELECT is_open, closed_reason FROM workorders WHERE wo = 5002').first()).closed_reason, 'Sale complete');
// a short list isn't trusted
await env.TR.prepare('UPDATE workorders SET claimed_until = NULL').run();
s = await call('POST', '/v1/914/tracker/scan', { rows: [] });
assert.ok(s.j.note && /short/.test(s.j.note)); assert.equal(s.j.need.filter((n) => n.why === 'missing').length, 0);

// --- admin: owner unlocks and reads; a 914-only person can't see 326
const me = (await admin('owner@x.com', 'GET', '/me')).j;
const m2 = await C.unlockWithPhrase(me.keys[0], PHRASE, C.aad.person('owner@x.com', 'master', 0), true);
const skeys = (await admin('owner@x.com', 'GET', '/store-keys')).j.keys;
const priv914 = await C.openStoreKey(914, skeys[0].wrappedPrivate, m2);
const wos = (await admin('owner@x.com', 'GET', '/wos?store=914&open=1')).j.wos;
assert.equal(wos.length, 2);
assert.equal((await C.openJson(wos[0].card, priv914, C.aad.card(914, wos[0].wo))).name, 'Jordan Reyes');
const one = (await admin('owner@x.com', 'GET', '/wo/914/5003')).j;
assert.equal((await C.openJson(one.snapshots[0].sealed, priv914, C.aad.snapshot(914, 5003))).notes[0], 'Customer said hi');
const st = (await admin('owner@x.com', 'GET', '/stores')).j.stores;
assert.equal(st[0].rfp, 1); assert.equal(st[0].rfp_due, 99.5);

// invite a store-limited manager with a copy of the 914 key only
const bytes914 = await C.openStoreKeyBytes(914, skeys[0].wrappedPrivate, m2);
const INVITE = 'otter maple crisp lantern';
ok(await admin('owner@x.com', 'POST', '/people', { email: 'Mgr@x.com', name: 'Store Manager', scope: 'stores', stores: [914],
  keys: [Object.assign({ kind: 'store', store: 914 }, await C.lockWithPhrase(bytes914, INVITE, C.aad.person('mgr@x.com', 'store', 914)))] }), 'add manager');
assert.equal((await admin('mgr@x.com', 'POST', '/people', { email: 'x@x.com', scope: 'all' })).status, 403, 'manager cannot add people');
const mk = (await admin('mgr@x.com', 'GET', '/me')).j.keys;
assert.equal(mk.length, 1); assert.equal(mk[0].invite, 1);
const k914 = await C.unlockWithPhrase(mk[0], INVITE, C.aad.person('mgr@x.com', 'store', 914), true);
ok(await admin('mgr@x.com', 'PUT', '/me/keys', { keys: [Object.assign({ kind: 'store', store: 914 }, await C.lockWithPhrase(await C.exportPrivate(k914), 'my own passphrase words here', C.aad.person('mgr@x.com', 'store', 914)))] }), 'redeem');
assert.equal((await admin('mgr@x.com', 'GET', '/me')).j.keys[0].invite, 0);
assert.equal((await admin('mgr@x.com', 'GET', '/wos?store=326')).status, 403);
assert.equal((await admin('mgr@x.com', 'GET', '/wo/326/1')).status, 403);
assert.equal((await admin('mgr@x.com', 'GET', '/store-keys')).status, 403);
assert.equal((await admin('mgr@x.com', 'PUT', '/me/keys', { keys: [Object.assign({ kind: 'master', store: 0 }, copy)] })).status, 400, 'manager cannot store a master copy');
assert.equal((await admin('mgr@x.com', 'GET', '/wos')).j.wos.length, 3, 'all-stores list limited to 914');
assert.equal((await admin('stranger@x.com', 'GET', '/wos')).status, 403);
assert.equal((await admin('owner@x.com', 'POST', '/people/owner%40x.com/remove')).status, 409, 'last full-access person stays');
const lg = (await admin('owner@x.com', 'GET', '/log')).j.log;
assert.ok(lg.some((l) => l.email === 'mgr@x.com' && l.action === 'list'));

// --- safety: another store's WO is refused; "gone" needs two 404s 10+ min apart while missing from the list
const other = plain(5001, 2, 'Work in progress'); other.workorder.storeId = 326;
assert.equal((await call('POST', '/v1/914/tracker/wo/5001', { hash: 'h2', plain: other, sealed: await C.sealJson({}, sk, C.aad.snapshot(914, 5001)) })).status, 409, 'other store refused');
assert.equal((await call('POST', '/v1/914/tracker/wo/5001/gone', {})).j.ignored, 'still in the list');
await env.TR.prepare("UPDATE workorders SET missing_since = '2026-10-12T00:00:00Z' WHERE wo = 5001").run();
assert.equal((await call('POST', '/v1/914/tracker/wo/5001/gone', {})).j.pending, 'confirm later');
assert.equal((await call('POST', '/v1/914/tracker/wo/5001/gone', {})).j.pending, 'confirm later', 'second 404 too soon');
assert.equal((await env.TR.prepare('SELECT is_open FROM workorders WHERE wo = 5001').first()).is_open, 1);
await env.TR.prepare("UPDATE workorders SET gone_seen_at = '2026-10-12T00:00:00Z' WHERE wo = 5001").run();
assert.equal((await call('POST', '/v1/914/tracker/wo/5001/gone', {})).j.closed, true);
// back in the list → reopened by its next detail; gone flag cleared by the scan
await env.TR.prepare('UPDATE workorders SET claimed_until = NULL').run();
s = await call('POST', '/v1/914/tracker/scan', { rows: rows2.concat([Object.assign({}, rows[1], { updatedAt: '2026-10-12T12:00:00Z' })]) });
assert.ok(s.j.need.some((n) => n.wo === 5001 && n.why === 'reopened'));
assert.equal((await env.TR.prepare('SELECT gone_seen_at FROM workorders WHERE wo = 5001').first()).gone_seen_at, null);
// a list with WOs that really closed isn't "short"; one under half of what's open is
await env.TR.prepare('UPDATE workorders SET claimed_until = NULL').run();
for (let i = 0; i < 12; i++) await env.TR.prepare("INSERT INTO workorders (store, wo, is_open, status_id, last_detail_at) VALUES (914, ?, 1, 2, '2026-10-12T00:00:00Z')").bind(6000 + i).run();
s = await call('POST', '/v1/914/tracker/scan', { rows: rows2 });
assert.ok(/short/.test(s.j.note || ''), 'under half → short');
s = await call('POST', '/v1/914/tracker/scan', { rows: rows2.concat(Array.from({ length: 8 }, (_, i) => ({ wo: 6000 + i, statusId: 2, status: 'Work in progress', updatedAt: '2026-10-12T00:00:00Z' }))) });
assert.ok(!s.j.note, 'more than half listed → missing WOs get checked: ' + s.j.note);
assert.ok(s.j.need.filter((n) => n.why === 'missing').length >= 4);

// --- RFP value ignores Partner Credit Tax Exempt lines; outcome splits complete / incomplete
await env.TR.prepare('UPDATE workorders SET claimed_until = NULL').run();
const pp = plain(5003, 13, 'Ready for pickup', 0);
pp.workorder.outcome = 'Incomplete';
pp.cart = { items: [{ name: 'Glass/LCD', sku: '176255', price: 199, netPrice: 199, totalPrice: 211.94, quantity: 1 }, { name: 'Labor', sku: '900003', price: 83, netPrice: 83, totalPrice: 83, quantity: 1 }, { name: 'Buyback', sku: 'BB0001', price: 0, netPrice: 0, totalPrice: 0, quantity: -1 },
  { name: 'Partner Credit Tax Exempt', sku: 'PCEXEMPT', price: -199, netPrice: -199, totalPrice: -199, quantity: -1 }, { name: 'Partner Credit Tax Exempt', sku: 'PCEXEMPT', price: -83, netPrice: -83, totalPrice: -83, quantity: -1 }],
  payment: { total: 0, amountPaid: 0, amountDue: 0 } };
ok(await call('POST', '/v1/914/tracker/wo/5003', { hash: 'pc1', plain: pp, sealed: await C.sealJson({}, sk, C.aad.snapshot(914, 5003)) }), 'partner cart');
const v = await env.TR.prepare('SELECT cart_value, service_outcome FROM workorders WHERE wo = 5003').first();
assert.equal(v.cart_value, 282); assert.equal(v.service_outcome, 'Incomplete');
const st2 = (await admin('owner@x.com', 'GET', '/stores')).j.stores[0];
assert.equal(st2.rfp_value, 282); assert.equal(st2.rfp_other, 1); assert.equal(st2.rfp_complete, 0); assert.equal(st2.rfp_unknown, 0);
assert.equal((await admin('owner@x.com', 'GET', '/wos?store=914&status=13&outcome=other')).j.wos.length, 1);
assert.equal((await admin('owner@x.com', 'GET', '/wos?store=914&status=13&outcome=complete')).j.wos.length, 0);
// the outcome comes from the WO's own attribute; a blank list field doesn't count as incomplete
const S = await import('../src/shape.js');
assert.deepEqual(S.outcomeOf({ WorkorderAttributes: [{ workorderAttributeTypeId: 17, value: '0' }, { workorderAttributeTypeId: 22, value: 'Completed' }] }, { serviceOutcome: '' }), { outcome: 'Completed', outcomeReason: null });
assert.deepEqual(S.outcomeOf({ WorkorderAttributes: [{ workorderAttributeTypeId: 22, value: 'Failed post-repair diagnostics' }, { workorderAttributeTypeId: 22, value: 'Incomplete' }] }, null), { outcome: 'Incomplete', outcomeReason: 'Failed post-repair diagnostics' });
assert.deepEqual(S.outcomeOf({}, { serviceOutcome: '' }), { outcome: null, outcomeReason: null });
// a scan's list value never overwrites the outcome from the WO's detail
await env.TR.prepare('UPDATE workorders SET claimed_until = NULL').run();
await call('POST', '/v1/914/tracker/scan', { rows: [Object.assign({}, rows[2], { outcome: 'Completed' })].concat(rows2.slice(0, 1)) });
assert.equal((await env.TR.prepare('SELECT service_outcome FROM workorders WHERE wo = 5003').first()).service_outcome, 'Incomplete');
// the migration's SQL gives the same value
await env.TR.prepare('UPDATE workorders SET cart_value = NULL WHERE wo = 5003').run();
const mig = readFileSync('migrations/2026-10-12.sql', 'utf8').split(';').map((x) => x.replace(/--[^\n]*/g, '').trim()).filter((x) => x.startsWith('UPDATE'))[0];
await env.TR.prepare(mig).run();
assert.equal((await env.TR.prepare('SELECT cart_value FROM workorders WHERE wo = 5003').first()).cart_value, 282);

// --- retention: nothing trimmed without cold storage; with TRIM_WITHOUT_ARCHIVE the latest snapshot per WO stays
await env.TR.prepare("UPDATE snapshots SET fetched_at = '2026-01-01T00:00:00Z'").run();
await env.TR.prepare("UPDATE changes SET changed_at = '2026-01-01T00:00:00Z'").run();
assert.equal((await trim(E)).skipped, 'no cold storage bound');
const t = await trim(Object.assign({}, E, { TRIM_WITHOUT_ARCHIVE: '1' }));
assert.equal((await env.TR.prepare('SELECT COUNT(*) AS n FROM snapshots').first()).n, 3, 'latest snapshot of each WO kept');
assert.ok(t.snapshots >= 1 && t.changes >= 2);

await dispose();
rmSync('.wrangler-test', { recursive: true, force: true });
console.log('worker: all passed');
