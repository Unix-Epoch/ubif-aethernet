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

// --- writes: a scan of an unchanged list rewrites nothing; a status change rewrites one row and asks for it
await env.TR.prepare('UPDATE workorders SET claimed_until = NULL').run();
const listNow = (await env.TR.prepare("SELECT wo, status_id, status_name, program_id, program_name, api_updated_at FROM workorders WHERE store = 914 AND is_open = 1").all()).results
  .map((r) => ({ wo: r.wo, statusId: r.status_id, status: r.status_name, programId: r.program_id, program: r.program_name, updatedAt: r.api_updated_at }));
await call('POST', '/v1/914/tracker/scan', { rows: listNow }); // clears any missing flags
await env.TR.prepare('UPDATE workorders SET claimed_until = NULL').run();
s = await call('POST', '/v1/914/tracker/scan', { rows: listNow });
assert.equal(s.j.written, 0, 'unchanged list → no row writes');
await env.TR.prepare('UPDATE workorders SET claimed_until = NULL').run(); // the scan above claimed stale WOs for their hourly refresh
const moved = listNow.map((r, i) => (i === 0 ? Object.assign({}, r, { statusId: 13, status: 'Ready for pickup' }) : r));
s = await call('POST', '/v1/914/tracker/scan', { rows: moved });
assert.equal(s.j.written, 1); assert.ok(s.j.need.some((n) => n.wo === moved[0].wo && n.why === 'changed'), 'a status change alone asks for the detail');
await env.TR.prepare('UPDATE workorders SET status_id = 2, status_name = ? WHERE store = 914 AND wo = ?').bind('Work in progress', moved[0].wo).run(); // put it back for the totals below

// --- the store's RFP total (Sales card): one sum, no WO details
const rt = (await call('GET', '/v1/914/tracker/rfp')).j;
assert.equal(rt.count, 1); assert.equal(rt.value, 282); assert.equal(rt.incomplete.count, 1); assert.equal(rt.complete.count, 0); assert.ok(rt.updatedAt);
assert.ok(!JSON.stringify(rt).includes('v1.'), 'no sealed data in the total');
assert.equal((await call('GET', '/v1/326/tracker/rfp')).j.count, 0);

// --- daily sales: Portal's list per day, items from the WO's last cart, estimates for days without it
const card = await C.sealJson({ customerId: 1, customerName: 'Jordan Reyes' }, sk, C.aad.sale(914, 'FSO1'));
const saleRows = [
  { saleId: 'FSO1', wo: 5003, saleAt: '2026-10-12T18:00:00Z', type: 'Sale', total: 282, partnerCredits: 282, paid: 0, completedBy: 'Tech A', card },
  { saleId: 'FSO2', wo: null, saleAt: '2026-10-12T19:00:00Z', type: 'Sale', total: 21.19, partnerCredits: 0, paid: 21.19, completedBy: 'Tech B', card },
  { saleId: 'FSO3', wo: null, saleAt: '2026-10-13T02:30:00Z', type: 'Return', total: -49.99, partnerCredits: 0, paid: -49.99, completedBy: 'Tech B', card }, // 10:30 PM local: still Oct 12
  { saleId: 'FSO4', wo: null, saleAt: '2026-10-13T14:00:00Z', type: 'Sale', total: 10, partnerCredits: 0, paid: 10, completedBy: 'Tech B', card }, // next day: ignored
];
let sr = await call('POST', '/v1/914/tracker/sales', { day: '2026-10-12', rows: saleRows });
ok(sr, 'sales'); assert.equal(sr.j.count, 3); assert.equal(sr.j.written, 3); assert.equal(sr.j.total, 253.2);
const fso1 = await env.TR.prepare("SELECT items, program FROM sales WHERE sale_id = 'FSO1'").first();
assert.ok(JSON.parse(fso1.items).some((i) => i.sku === 'PCEXEMPT'), 'items from the WO cart');
assert.ok(!JSON.stringify(await env.TR.prepare('SELECT * FROM sales').all()).includes('Jordan'), 'customer sealed');
sr = await call('POST', '/v1/914/tracker/sales', { day: '2026-10-12', rows: saleRows });
assert.equal(sr.j.written, 0, 'unchanged day → no sale writes');
sr = await call('POST', '/v1/914/tracker/sales', { day: '2026-10-12', rows: saleRows.slice(0, 2) });
assert.equal(sr.j.removed, 1, 'a sale Portal no longer lists is removed');
sr = await call('POST', '/v1/914/tracker/sales', { day: '2026-10-12', rows: [] });
assert.equal((await env.TR.prepare("SELECT COUNT(*) AS n FROM sales WHERE sale_day = '2026-10-12'").first()).n, 2, 'an empty list never wipes a day');
// an estimate for a day without Portal's list: WO 5002 reached Sale complete on Oct 10
await env.TR.prepare("UPDATE workorders SET status_id = 14, sold_at = '2026-10-10T20:00:00Z', last_cart_value = 100, last_cart_tax = 6 WHERE wo = 5002").run();
const days = (await admin('owner@x.com', 'GET', '/sales/days?store=914&from=2026-10-09&to=2026-10-12')).j.days;
const d12 = days.find((d) => d.day === '2026-10-12'), d10 = days.find((d) => d.day === '2026-10-10');
assert.equal(d12.source, 'portal'); assert.equal(d12.count, 2); assert.equal(d12.total, 303.19);
assert.equal(d10.source, 'estimated'); assert.equal(d10.total, 106);
const dd = (await admin('owner@x.com', 'GET', '/sales/day?store=914&day=2026-10-10')).j;
assert.equal(dd.estimated.length, 1); assert.equal(dd.sales.length, 0);
assert.equal((await admin('mgr@x.com', 'GET', '/sales/days?store=326&from=2026-10-09&to=2026-10-12')).status, 403, 'store-limited person');
// store side: daily totals (no customers) and the general-manager setting
const sd = (await call('GET', '/v1/914/tracker/sales/days?from=2026-10-09&to=2026-10-12')).j.days;
assert.deepEqual(sd.map((d) => d.day + ':' + d.source + ':' + d.total), ['2026-10-12:portal:303.19', '2026-10-10:estimated:106']);
assert.ok(!JSON.stringify(sd).includes('v1.'));
assert.deepEqual((await call('GET', '/v1/914/tracker/settings')).j, {});
ok(await call('PUT', '/v1/914/tracker/settings/gm', { userIds: [33256, '33256', 'x'], names: { 33256: 'casey.mgr' }, by: 'Tech A' }), 'gm');
const gm = (await call('GET', '/v1/914/tracker/settings')).j.gm;
assert.deepEqual(gm.userIds, [33256]); assert.equal(gm.names[33256], 'casey.mgr'); assert.equal(gm.by, 'Tech A');
assert.deepEqual((await call('GET', '/v1/326/tracker/settings')).j, {}, 'per store');
// RFP periods: 5003 has been in RFP since its first upload; a WO leaving RFP closes its period
const { dayEnd } = await import('../src/index.js');
assert.equal(dayEnd('2026-10-12', 'America/New_York'), '2026-10-13T03:59:59.999Z'); // EDT
assert.equal(dayEnd('2026-12-01', 'America/New_York'), '2026-12-02T04:59:59.999Z'); // EST
const per = (await env.TR.prepare('SELECT * FROM rfp_periods WHERE wo = 5003').all()).results;
assert.equal(per.length, 1); assert.equal(per[0].end_at, null); assert.equal(per[0].value, 282, 'value follows the cart while in RFP');
const today = new Date().toISOString().slice(0, 10);
let rd = (await call('GET', '/v1/914/tracker/rfp/days?from=' + today + '&to=' + today)).j.days;
assert.ok(rd.length >= 1);
const picked = plain(5003, 14, 'Sale complete', 0); picked.workorder.updatedAt = '2099-01-01T00:00:00Z';
ok(await call('POST', '/v1/914/tracker/wo/5003', { hash: 'sold', plain: picked, sealed: await C.sealJson({}, sk, C.aad.snapshot(914, 5003)) }), 'picked up');
const per2 = (await env.TR.prepare('SELECT * FROM rfp_periods WHERE wo = 5003').first());
assert.ok(per2.end_at, 'period closed');
await env.TR.prepare("INSERT INTO rfp_periods (store, wo, start_at, end_at, value) VALUES (914, 1, '2026-10-05T15:00:00Z', '2026-10-07T18:00:00Z', 100), (914, 2, '2026-10-06T20:00:00Z', NULL, 50), (914, 3, '2026-10-07T02:00:00Z', '2026-10-07T03:00:00Z', 999)").run();
rd = (await call('GET', '/v1/914/tracker/rfp/days?from=2026-10-05&to=2026-10-08')).j.days;
assert.deepEqual(rd.map((d) => d.day + ':' + d.value), ['2026-10-05:100', '2026-10-06:150', '2026-10-07:50', '2026-10-08:50']); // WO 3 came and went in the evening of Oct 6 (local)
// localDay: evening sales stay on the store's day
const { localDay } = await import('../src/index.js');
assert.equal(localDay('2026-10-13T02:30:00Z'), '2026-10-12'); assert.equal(localDay('2026-12-01T04:30:00Z'), '2026-11-30');

// --- agents: a program with its own key; approved by a full-access admin whose unlocked browser wraps the store key to it
const ag = await C.newKeyPair(), agId = 'a1'.repeat(16), agTok = 'b2'.repeat(32), bearer = (id, tok) => ({ authorization: 'Bearer ' + id + '.' + tok });
const acall = async (path, headers = {}) => { const r = await worker.fetch(new Request('https://t.test' + path, { headers: Object.assign({ 'x-aethernet-key': 'k' }, headers) }), E, {}); return { status: r.status, j: await r.json() }; };
assert.equal((await call('POST', '/v1/agents/register', { id: agId, name: 'Audit', publicJwk: ag.publicJwk, token: 'short' })).status, 400);
const reg = await call('POST', '/v1/agents/register', { id: agId, name: 'Work order audit', publicJwk: ag.publicJwk, token: agTok });
ok(reg, 'register'); assert.equal(reg.j.status, 'pending'); assert.match(reg.j.fingerprint, /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
const fp = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ crv: ag.publicJwk.crv, kty: ag.publicJwk.kty, x: ag.publicJwk.x, y: ag.publicJwk.y }))))].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 16).toUpperCase().match(/.{4}/g).join('-');
assert.equal(reg.j.fingerprint, fp, 'fingerprint follows the contract');
assert.equal((await call('POST', '/v1/agents/register', { id: agId, name: 'x', publicJwk: ag.publicJwk, token: agTok })).status, 409, 'id taken');
assert.equal((await call('POST', '/v1/agents/register', { id: agId, name: 'x', publicJwk: ag.publicJwk, token: agTok }, 'wrong')).status, 403, 'app key needed');
assert.equal((await acall('/v1/agents/me')).status, 401, 'no token');
assert.equal((await acall('/v1/agents/me', bearer(agId, 'c3'.repeat(32)))).status, 401, 'wrong token');
assert.equal((await acall('/v1/agents/me', bearer('d4'.repeat(16), agTok))).status, 401, 'unknown agent');
let am0 = await acall('/v1/agents/me', bearer(agId, agTok));
assert.equal(am0.status, 200); assert.equal(am0.j.status, 'pending'); assert.deepEqual(am0.j.keys, []); assert.equal(am0.j.fingerprint, fp);
assert.equal((await acall('/v1/agents/wos?store=914', bearer(agId, agTok))).status, 403, 'pending agent sees no WOs');
// at most 5 waiting
for (let i = 0; i < 4; i++) ok(await call('POST', '/v1/agents/register', { id: String(i).repeat(32), name: 'p' + i, publicJwk: ag.publicJwk, token: agTok }), 'pending ' + i);
assert.equal((await call('POST', '/v1/agents/register', { id: '9'.repeat(32), name: 'p', publicJwk: ag.publicJwk, token: agTok })).status, 429);
await env.TR.prepare("UPDATE agents SET created_at = '2026-01-01T00:00:00Z' WHERE id != ?").bind(agId).run();
ok(await call('POST', '/v1/agents/register', { id: '9'.repeat(32), name: 'p', publicJwk: ag.publicJwk, token: agTok }), 'old pending ones are cleared first');
await env.TR.prepare("DELETE FROM agents WHERE id != ?").bind(agId).run();
// admin side
assert.equal((await admin('someone@x.com', 'GET', '/agents')).status, 403);
const lst = (await admin('owner@x.com', 'GET', '/agents')).j.agents;
assert.equal(lst.length, 1); assert.equal(lst[0].status, 'pending'); assert.equal(lst[0].fingerprint, fp); assert.ok(!JSON.stringify(lst).includes(agTok) && !('token_hash' in lst[0]));
const skBytes = await C.openStoreKeyBytes(914, k1.wrappedPrivate, master.privateKey);
const wrappedFor = (id, st) => C.sealBytes(skBytes, ag.publicJwk, 'agentkey|' + id + '|' + st);
const ap = '/agents/' + agId + '/approve';
assert.equal((await admin('owner@x.com', 'POST', ap, { stores: [914], keys: [] })).status, 400, 'key needed for each store');
assert.equal((await admin('owner@x.com', 'POST', ap, { stores: [326], keys: [{ store: 326, wrapped: await wrappedFor(agId, 326) }] })).status, 400, 'store without a key');
assert.equal((await admin('owner@x.com', 'POST', ap, { stores: [914], keys: [{ store: 914, wrapped: 'nope' }] })).status, 400);
assert.equal((await admin('owner@x.com', 'POST', '/agents/' + 'e5'.repeat(16) + '/approve', { stores: [], keys: [] })).status, 404);
await env.TR.prepare("INSERT INTO people (email, scope, stores) VALUES ('amgr@x.com', 'stores', '[914]')").run();
assert.equal((await admin('amgr@x.com', 'POST', ap, { stores: [914], keys: [{ store: 914, wrapped: await wrappedFor(agId, 914) }] })).status, 403, 'full access only');
ok(await admin('owner@x.com', 'POST', ap, { stores: [914], keys: [{ store: 914, wrapped: await wrappedFor(agId, 914) }] }), 'approve');
am0 = (await acall('/v1/agents/me', bearer(agId, agTok))).j;
assert.equal(am0.status, 'active'); assert.deepEqual(am0.stores, [914]); assert.equal(am0.keys.length, 1); assert.equal(am0.keys[0].publicJwk.x, k1.publicJwk.x);
// the agent opens its store key, then a sealed snapshot
const myKey = await C.importPrivate(await C.openBytes(am0.keys[0].wrapped, ag.privateKey, 'agentkey|' + agId + '|914'));
let aw = await acall('/v1/agents/wos?store=914&closedDays=3', bearer(agId, agTok));
assert.equal(aw.status, 200); assert.ok(aw.j.last_scan_at);
const w5001 = aw.j.wos.find((x) => x.wo === 5001);
assert.ok(w5001 && w5001.snapshot_id && w5001.snapshot_hash && w5001.snapshot_fetched_at && w5001.plain, 'row carries its latest snapshot');
assert.equal((await C.openJson(w5001.sealed, myKey, C.aad.snapshot(914, 5001))).workorder.workorder.customer.name, 'Jordan Reyes');
assert.ok(!JSON.stringify(aw.j).includes('Jordan'), 'nothing readable');
assert.equal((await acall('/v1/agents/wos?store=326', bearer(agId, agTok))).status, 403, 'store not granted');
assert.equal((await acall('/v1/agents/wos', bearer(agId, agTok))).status, 403);
assert.equal((await acall('/v1/agents/wos?store=914', bearer(agId, 'c3'.repeat(32)))).status, 401);
// closed window: 5002 closed just now is in; closed 5 days ago it is out until closedDays reaches it
assert.ok(aw.j.wos.some((x) => x.wo === 5002 && !x.is_open), 'recently closed WO included');
await env.TR.prepare("UPDATE workorders SET closed_at = ? WHERE store = 914 AND wo = 5002").bind(new Date(Date.now() - 5 * 86400000).toISOString()).run();
const has = async (q, wo) => (await acall('/v1/agents/wos?store=914' + q, bearer(agId, agTok))).j.wos.some((x) => x.wo === wo);
assert.equal(await has('&closedDays=3', 5002), false); assert.equal(await has('&closedDays=7', 5002), true); assert.equal(await has('', 5002), false, 'default 3 days');
await env.TR.prepare("UPDATE workorders SET closed_at = ? WHERE store = 914 AND wo = 5002").bind(new Date(Date.now() - 30 * 86400000).toISOString()).run();
assert.equal(await has('&closedDays=99', 5002), false, 'capped at 14 days'); assert.equal(await has('&closedDays=99', 5001), true, 'open ones always');
const alog = (await admin('owner@x.com', 'GET', '/log?limit=2000')).j.log;
assert.ok(alog.some((x) => x.email === 'agent:Work order audit' && x.action === 'agent:wos' && x.store === 914), 'agent reads are logged');
assert.ok(alog.some((x) => x.action === 'agent:approve'));
// audit settings, report, run now
const { agentSettings } = await import('../src/index.js');
for (const bad of [{ paused: 'yes' }, { days: [7] }, { days: [1.5] }, { times: [] }, { times: ['10:15'] }, { times: ['25:00'] }, { times: ['00:00', '01:00', '02:00', '03:00', '04:00', '05:00', '06:00'] }, { emailTo: [] }, { emailTo: ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com'] }, { emailTo: ['nope'] },
  { closedDays: 0 }, { closedDays: 15 }, { closedDays: 2.5 }, { staleMinutes: 14 }, { staleMinutes: 241 }, { openHours: { from: '19:00', to: '10:00' } }, { openHours: { from: '10:00' } }, { surprise: 1 }, [], null]) assert.equal(agentSettings(bad), null, JSON.stringify(bad));
assert.deepEqual(agentSettings({ days: [6, 1, 1], times: ['18:00', '09:30'], emailTo: ['A@X.com'] }), { days: [1, 6], times: ['09:30', '18:00'], emailTo: ['a@x.com'] });
let st0 = (await acall('/v1/agents/me', bearer(agId, agTok))).j;
assert.deepEqual(st0.settings, { paused: false, days: [1, 2, 3, 5, 6], times: ['10:00', '18:00'], emailTo: ['green.trimar@gmail.com'], closedDays: 3, staleMinutes: 45, openHours: { from: '10:00', to: '19:00' } }, 'defaults');
assert.equal(st0.runNow, false); assert.equal(st0.lastRun, null);
const sp = '/agents/' + agId + '/settings';
assert.equal((await admin('amgr@x.com', 'POST', sp, { settings: { paused: true } })).status, 403, 'full access only');
assert.equal((await admin('owner@x.com', 'POST', sp, { settings: { closedDays: 99 } })).status, 400);
assert.equal((await admin('owner@x.com', 'POST', '/agents/' + 'e5'.repeat(16) + '/settings', { settings: {} })).status, 404);
ok(await admin('owner@x.com', 'POST', sp, { settings: { paused: true, times: ['07:30'], closedDays: 5 } }), 'settings');
st0 = (await acall('/v1/agents/me', bearer(agId, agTok))).j;
assert.equal(st0.settings.paused, true); assert.deepEqual(st0.settings.times, ['07:30']); assert.equal(st0.settings.closedDays, 5); assert.equal(st0.settings.staleMinutes, 45, 'unset ones keep defaults');
ok(await admin('owner@x.com', 'POST', '/agents/' + agId + '/run-now'), 'run now');
assert.equal((await acall('/v1/agents/me', bearer(agId, agTok))).j.runNow, true);
const rep = (body, tok = agTok) => worker.fetch(new Request('https://t.test/v1/agents/report', { method: 'POST', headers: Object.assign({ 'x-aethernet-key': 'k' }, bearer(agId, tok)), body: JSON.stringify(body) }), E, {}).then(async (r) => ({ status: r.status, j: await r.json() }));
assert.equal((await rep({ ranAt: '2026-10-14T14:00:00Z', ok: true, emailSent: true }, 'c3'.repeat(32))).status, 401);
assert.equal((await rep({ ok: true })).status, 400);
ok(await rep({ ranAt: '2026-10-14T14:00:00Z', ok: true, emailSent: false, note: 'scheduled', usedRunNow: false }), 'report');
assert.equal((await acall('/v1/agents/me', bearer(agId, agTok))).j.runNow, true, 'a normal run leaves run now set');
ok(await rep({ ranAt: '2026-10-14T14:30:00Z', ok: false, emailSent: false, note: 'x'.repeat(400), usedRunNow: true }), 'report with run now');
st0 = (await acall('/v1/agents/me', bearer(agId, agTok))).j;
assert.equal(st0.runNow, false, 'cleared'); assert.equal(st0.lastRun.ok, false); assert.equal(st0.lastRun.note.length, 300); assert.equal(st0.lastRun.usedRunNow, true);
const al = (await admin('owner@x.com', 'GET', '/agents')).j.agents[0];
assert.equal(al.runNow, false); assert.equal(al.lastRun.ranAt, '2026-10-14T14:30:00Z'); assert.equal(al.settings.paused, true);
// changing stores replaces the keys; remove deletes everything
ok(await admin('owner@x.com', 'POST', ap, { stores: [], keys: [] }), 'change to no stores');
assert.deepEqual((await acall('/v1/agents/me', bearer(agId, agTok))).j.keys, []);
assert.equal((await acall('/v1/agents/wos?store=914', bearer(agId, agTok))).status, 403);
ok(await admin('owner@x.com', 'POST', '/agents/' + agId + '/remove'), 'remove');
assert.equal((await acall('/v1/agents/me', bearer(agId, agTok))).status, 401, 'removed');
assert.equal((await env.TR.prepare('SELECT COUNT(*) AS n FROM agent_keys').first()).n, 0);

// --- sandbox guard (Oct 16, 2026): the local Portal sandbox's fake identity is refused before any write
const cnt = async () => [(await env.TR.prepare('SELECT COUNT(*) AS n FROM workorders').first()).n, (await env.TR.prepare('SELECT COUNT(*) AS n FROM sales').first()).n, (await env.TR.prepare('SELECT COUNT(*) AS n FROM scans').first()).n];
const before = await cnt();
const sbRows = [{ wo: 700000001, statusId: 2, status: 'Work in progress', programId: 1, program: 'OOW', updatedAt: '2026-10-12T10:00:00Z', createdAt: '2026-10-10T10:00:00Z' }];
for (const [path, b] of [
  ['/v1/914/tracker/scan', { rows: sbRows, storeName: 'Sandbox Store', by: 'Tech A' }],
  ['/v1/914/tracker/scan', { rows: sbRows, storeName: 'Newport News', by: 'Sandbox Tech' }],
  ['/v1/914/tracker/scan', { rows: sbRows, by: 'real', byId: 990001 }],
  ['/v1/914/tracker/sales', { day: '2026-10-16', rows: [{ saleId: 1, wo: 700000001, total: 10, completedBy: 'Sandbox Lead' }] }],
  ['/v1/914/tracker/sales', { day: '2026-10-16', rows: [{ saleId: 1, wo: 5001, total: 10, completed_by: 'sandbox tech' }] }],
  ['/v1/914/tracker/wo/700000001', { plain: { workorder: { storeName: 'Sandbox Store' } }, hash: 'x' }],
  ['/v1/914/tracker/wo/700000001', { plain: { workorder: { customer: { email: 'a.b@example.invalid' } } }, hash: 'x' }],
  ['/v1/999999/tracker/scan', { rows: [], storeName: 'Anything' }],
]) { const r = await call('POST', path, b); assert.equal(r.status, 403, path); assert.equal(r.j.error, 'sandbox data'); }
assert.deepEqual(await cnt(), before, 'nothing written by sandbox requests');
ok(await call('POST', '/v1/914/tracker/scan', { rows, storeName: 'Newport News', by: 'Tech A' }), 'real staff still scan');

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
