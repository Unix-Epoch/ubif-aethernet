// Linkpearl's phone API on the tracker Worker (/v1/agents/m/…): registration as a phone, owner approval, device-token auth, Home limited to approved stores,
// the three reserved areas, the 10-minute cron dispatch, and the Mac agent's behaviour next to it. Local D1; everything invented.
import assert from 'node:assert/strict';
import { setup, C, bearer, hex, Z } from './mobile-helpers.mjs';
import { homeApi, buildHome } from '../src/mobile.js';

const T = await setup('.wrangler-test-mobile-agent');
const { env, call, admin, authed, registerPhone, approve } = T;
const HOME = '/v1/agents/m/home';

// ---- registration: what the phone sends, what it gets back
const p = await registerPhone('Pixel Fold');
assert.equal(p.reg.status, 200); assert.deepEqual(Object.keys(p.reg.j).sort(), ['fingerprint', 'id', 'kind', 'status']);
assert.equal(p.reg.j.status, 'pending'); assert.equal(p.reg.j.kind, 'phone'); assert.match(p.reg.j.fingerprint, /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
assert.equal((await call('POST', '/v1/agents/register', { id: hex(16), name: 'x', publicJwk: p.publicJwk, token: hex(32), kind: 'phone' }, { 'x-aethernet-key': 'wrong' })).status, 403, 'app key needed to register');
assert.equal((await call('POST', '/v1/agents/register', { id: hex(16), name: 'x', publicJwk: p.publicJwk, token: hex(32), kind: 'tablet' })).status, 400, 'only kind phone');
assert.equal((await call('POST', '/v1/agents/register', { id: hex(16), name: 'x', publicJwk: Object.assign({ d: 'secret' }, p.publicJwk), token: hex(32), kind: 'phone' })).status, 400, 'private JWK refused');
assert.equal((await call('POST', '/v1/agents/register', { id: p.id, name: 'again', publicJwk: p.publicJwk, token: p.token, kind: 'phone' })).status, 409);
// poll for approval without anything but its token: /me
let me = await authed(p, '/v1/agents/me');
assert.equal(me.status, 200); assert.equal(me.j.status, 'pending'); assert.equal(me.j.kind, 'phone'); assert.equal(me.j.name, 'Pixel Fold'); assert.deepEqual(me.j.keys, []); assert.deepEqual(me.j.stores, []);
// a pending phone reads nothing; no token or a wrong one is refused
assert.equal((await authed(p, HOME)).status, 403, 'pending');
assert.equal((await authed(null, HOME)).status, 401, 'no token'); assert.equal((await authed({ id: p.id, token: hex(32) }, HOME)).status, 401, 'wrong token'); assert.equal((await authed({ id: hex(16), token: p.token }, HOME)).status, 401, 'unknown id');
assert.equal((await call('GET', HOME, null, { 'x-aethernet-key': 'wrong', ...bearer(p) })).status, 403, 'app key needed everywhere');
// the admin page lists it as a phone with its name; nothing secret
const list = (await admin('owner@x.com', 'GET', '/agents')).j.agents;
assert.equal(list.length, 1); assert.equal(list[0].kind, 'phone'); assert.equal(list[0].name, 'Pixel Fold'); assert.equal(list[0].status, 'pending');
assert.ok(!JSON.stringify(list).includes(p.token) && !('token_hash' in list[0]));
// only the owner approves (full access)
assert.equal((await approve(p, [914], 'someone@x.com')).status, 403);
const ap = await approve(p, [914, 326]); assert.equal(ap.status, 200, JSON.stringify(ap.j));

// ---- approved: /me delivers the wrapped store keys, which the phone opens with its private key (ECDH P-256 → HKDF-SHA256 → AES-256-GCM)
me = await authed(p, '/v1/agents/me');
assert.equal(me.j.status, 'active'); assert.deepEqual(me.j.stores, [914, 326]); assert.deepEqual(me.j.keys.map((k) => k.store), [326, 914]);
for (const k of me.j.keys) {
  assert.deepEqual(Object.keys(k).sort(), ['publicJwk', 'store', 'wrapped']); assert.match(k.wrapped, /^v1\./);
  const open = await C.openBytes(k.wrapped, p.kp.privateKey, 'agentkey|' + p.id + '|' + k.store);
  assert.deepEqual(open, T.storeKeys[k.store].bytes, 'the phone recovers the store key');
}

// ---- Home: the same answer the admin site gives, limited to the approved stores
const h914 = await authed(p, HOME + '?store=914');
assert.equal(h914.status, 200); assert.equal(h914.j.scope, 914); assert.equal(h914.j.lanes.total, 3);  assert.equal(h914.j.lanes.rfp, 1);
const all = await authed(p, HOME + '?store=all');
assert.equal(all.status, 200); assert.equal(all.j.scope, 'all'); assert.deepEqual(all.j.stores.map((s) => s.id), [326, 914], 'only approved stores');
assert.equal(all.j.lanes.total, 4, 'all = 914 (3) + 326 (1); Lexington (2) is not approved');
assert.equal((await authed(p, HOME + '?store=536')).status, 403, 'a store that was not approved');
assert.equal((await authed(p, HOME + '?store=abc')).status, 400);
assert.equal((await authed(p, HOME + '?store=914', { method: 'POST', body: {} })).status, 404, 'Home is read only');
// identical to the admin handler's answer (same code), at the same "now"
{
  const NOW = Date.parse(Z('2026-10-15', 16)), me914 = { owner: false, scope: 'stores', stores: [914, 326] };
  const direct = await homeApi(new Request('http://x/m'), T.env, new URL('http://x/m?store=all'), me914, { now: NOW });
  const full = await homeApi(new Request('http://x/m'), T.env, new URL('http://x/m?store=all'), { owner: true }, { now: NOW });
  assert.deepEqual(Object.keys(await direct.json()).sort(), Object.keys(await full.json()).sort());
}
assert.doesNotMatch(all.j && JSON.stringify(all.j), /customer|sealed|card|v1\./i, 'no customer details, nothing sealed');
assert.ok(JSON.stringify(all.j).length < 2500, 'phone-sized');

// ---- the three reserved areas: 501 with a device, nothing without one
for (const path of ['/v1/agents/m/prefs']) {
  const r = await authed(p, path); assert.equal(r.status, 501, path); assert.deepEqual(r.j, { error: 'not built' });
  assert.equal((await authed(p, path, { method: 'POST', body: {} })).status, 501, 'POST ' + path);
  assert.equal((await authed(null, path)).status, 401, 'no token ' + path);
}
assert.equal((await authed(p, '/v1/agents/m/nope')).status, 404); assert.equal((await authed(p, '/v1/agents/m')).status, 404);

// ---- a pending second phone, expiry, revoke
const q = await registerPhone('Second'); assert.equal((await authed(q, '/v1/agents/m/prefs')).status, 403, 'pending phone: not even the stubs');
const r3 = await registerPhone('Third'), r4 = await registerPhone('Fourth');
assert.equal((await registerPhone('Fifth')).reg.status, 429, 'at most 3 phones waiting');
await env.TR.prepare("UPDATE agents SET created_at = '2026-01-01T00:00:00Z' WHERE status = 'pending'").run();
const r5 = await registerPhone('Sixth'); assert.equal(r5.reg.status, 200, 'old pending ones are cleared first');
assert.equal((await authed(q, '/v1/agents/me')).status, 401, 'an expired registration no longer authenticates');
// revoked on the admin page: the very next call fails
assert.equal((await admin('owner@x.com', 'POST', `/agents/${p.id}/remove`)).status, 200);
assert.equal((await authed(p, HOME)).status, 401, 'revoked'); assert.equal((await authed(p, '/v1/agents/m/prefs')).status, 401);
assert.equal((await env.TR.prepare('SELECT COUNT(*) AS n FROM agent_kind WHERE agent_id = ?').bind(p.id).first()).n, 0, 'kind row removed with it');

// ---- stores can be changed later; a Mac agent is not a phone
const p2 = await registerPhone('Pixel 2'); await approve(p2, [536]);
assert.deepEqual((await authed(p2, HOME + '?store=all')).j.stores.map((s) => s.id), [536]);
await approve(p2, [914, 536]); assert.equal((await authed(p2, HOME + '?store=914')).status, 200, 'approval replaces the earlier grant');
await approve(p2, []); const none = await authed(p2, HOME + '?store=all'); assert.equal(none.status, 200); assert.equal(none.j.empty, true, 'no stores: empty, not an error');
const mac = { id: hex(16), token: hex(32), kp: await C.newKeyPair() }; mac.publicJwk = mac.kp.publicJwk;
assert.equal((await call('POST', '/v1/agents/register', { id: mac.id, name: 'Work order audit', publicJwk: mac.publicJwk, token: mac.token })).j.kind, 'agent');
await approve(mac, [914]);
assert.equal((await authed(mac, HOME + '?store=914')).status, 403, 'the audit agent cannot use the phone API'); assert.equal((await authed(mac, '/v1/agents/wos?store=914')).status, 200, 'and still reads work orders');
await approve(p2, [914]);
assert.equal((await authed(p2, '/v1/agents/wos?store=914')).status, 200, 'a phone gets the same sealed work orders (for unlock) on its approved stores');
assert.equal((await authed(p2, '/v1/agents/wos?store=326')).status, 403);
assert.equal((await admin('owner@x.com', 'GET', '/agents')).j.agents.find((a) => a.id === mac.id).kind, 'agent');

// ---- the 10-minute cron goes to the alerts tick; the daily one is untouched (it still runs trim)
await T.scheduled('*/10 * * * *'); await T.scheduled('30 9 * * *'); await T.scheduled(undefined);
console.log('mobile-agent: all passed');
await T.dispose();
