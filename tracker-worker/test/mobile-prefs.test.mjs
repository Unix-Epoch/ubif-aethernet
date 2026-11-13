// Linkpearl phone API, prefs area (/v1/agents/m/prefs…): the device's own details, approved stores with last scan times, rename validation,
// "forget this phone" (self-revocation), isolation between phones, Mac agent refused, no names leaked. Local D1 in its own scratch dir; everything invented.
import assert from 'node:assert/strict';
import { setup, hex } from './mobile-helpers.mjs';
import { MIN_APP } from '../src/mobile-prefs.js';

const T = await setup('.wrangler-test-mobile-prefs');
const { env, call, admin, authed, registerPhone, approve } = T;
const P = '/v1/agents/m/prefs';

const phone = await registerPhone('Pixel Fold'); await approve(phone, [914, 326]);
const other = await registerPhone('Backup phone'); await approve(other, [536]);

// invented scans: Newport News has two (the newest counts), Lynnhaven none
await env.TR.batch([
  env.TR.prepare("INSERT INTO scans (store, at, by_name, open_count) VALUES (914, '2026-11-13T15:00:00.000Z', 'Staffy McStaff', 3)"),
  env.TR.prepare("INSERT INTO scans (store, at, by_name, open_count) VALUES (914, '2026-11-13T16:12:00.000Z', 'Staffy McStaff', 3)"),
  env.TR.prepare("INSERT INTO scans (store, at, by_name, open_count) VALUES (536, '2026-11-13T12:00:00.000Z', 'Staffy McStaff', 2)"),
]);

// ---- GET: shape
const g = await authed(phone, P);
assert.equal(g.status, 200); assert.equal(g.h.get('cache-control'), 'no-store');
assert.deepEqual(Object.keys(g.j).sort(), ['device', 'minApp', 'now', 'stores', 'v']);
assert.deepEqual(Object.keys(g.j.device).sort(), ['fingerprint', 'id', 'kind', 'name']);
assert.equal(g.j.device.id, phone.id); assert.equal(g.j.device.name, 'Pixel Fold'); assert.equal(g.j.device.kind, 'phone');
assert.equal(g.j.device.fingerprint, phone.reg.j.fingerprint, 'the fingerprint the admin site shows');
assert.deepEqual(g.j.stores, [{ id: 326, name: 'Lynnhaven', lastScanAt: null }, { id: 914, name: 'Newport News', lastScanAt: '2026-11-13T16:12:00.000Z' }], 'approved stores only, newest scan');
assert.deepEqual(g.j.minApp, MIN_APP); assert.equal(typeof g.j.minApp.code, 'number');
assert.ok(Math.abs(Date.parse(g.j.now) - Date.now()) < 60000, 'server time');
assert.equal((await authed(phone, P, { method: 'POST', body: {} })).status, 405);
assert.equal((await authed(phone, P + '/nope')).status, 404);
const o = await authed(other, P);
assert.deepEqual(o.j.stores.map((s) => s.id), [536]); assert.equal(o.j.device.name, 'Backup phone');
console.log('GET', JSON.stringify(g.j));

// ---- no names leaked (staff names from scans, tokens, keys)
for (const bad of ['Staffy', 'McStaff', phone.token, 'wrapped', 'publicJwk', 'token_hash']) assert.ok(!JSON.stringify(g.j).includes(bad), 'leaked ' + bad);

// ---- rename: validation like registration
assert.equal((await authed(phone, P + '/name', { method: 'GET' })).status, 405);
for (const b of [{}, { name: '' }, { name: '   ' }, { name: 5 }, { name: '\u0007\u0000' }]) assert.equal((await authed(phone, P + '/name', { method: 'POST', body: b })).status, 400, JSON.stringify(b));
const rn = await authed(phone, P + '/name', { method: 'POST', body: { name: '  Garrett\u0007 Fold\n  phone ' + 'x'.repeat(100) } });
assert.equal(rn.status, 200); assert.equal(rn.j.ok, true); assert.ok(rn.j.name.startsWith('Garrett Fold phone x') && rn.j.name.length === 60, rn.j.name);
assert.equal((await authed(phone, P)).j.device.name, rn.j.name);
assert.equal((await admin('owner@x.com', 'GET', '/agents')).j.agents.find((a) => a.id === phone.id).name, rn.j.name, 'the admin page shows the new name');
assert.equal((await authed(other, P)).j.device.name, 'Backup phone', 'another phone is untouched');
console.log('rename', JSON.stringify((await authed(phone, P + '/name', { method: 'POST', body: { name: 'Pixel Fold' } })).j));
// a body that names someone else's id changes nothing about it
await authed(phone, P + '/name', { method: 'POST', body: { name: 'Pixel Fold', id: other.id } });
assert.equal((await authed(other, P)).j.device.name, 'Backup phone');
assert.equal((await authed(phone, P + '/name', { method: 'POST', body: { name: 'a'.repeat(5000) } })).status, 413, 'oversized body');

// ---- a pending phone, no token, a wrong token
const pending = await registerPhone('Waiting');
assert.equal((await authed(pending, P)).status, 403); assert.equal((await authed(pending, P + '/forget', { method: 'POST' })).status, 403);
assert.equal((await authed(null, P)).status, 401); assert.equal((await authed({ id: phone.id, token: hex(32) }, P + '/forget', { method: 'POST' })).status, 401, 'wrong token cannot forget');
assert.ok(await env.TR.prepare('SELECT 1 FROM agents WHERE id = ?').bind(phone.id).first(), 'still there');
// the forget route takes no id: a phone cannot name another
assert.equal((await authed(phone, P + '/forget/' + other.id, { method: 'POST' })).status, 404);
assert.equal((await authed(phone, P + '/' + other.id + '/forget', { method: 'POST' })).status, 404);
assert.ok(await env.TR.prepare('SELECT 1 FROM agents WHERE id = ?').bind(other.id).first());

// ---- a Mac agent (registered without kind: 'phone') is refused
const kp = await T.registerPhone('unused'); // only for a key pair
const macId = hex(16), macTok = hex(32);
assert.equal((await call('POST', '/v1/agents/register', { id: macId, name: 'Mac audit', publicJwk: kp.publicJwk, token: macTok })).status, 200);
const macDev = { id: macId, token: macTok };
await admin('owner@x.com', 'POST', `/agents/${macId}/approve`, { stores: [], keys: [] });
for (const [path, method] of [[P, 'GET'], [P + '/name', 'POST'], [P + '/forget', 'POST']]) assert.equal((await authed(macDev, path, { method, body: method === 'POST' ? { name: 'x' } : undefined })).status, 403, 'Mac agent refused ' + path);
assert.ok(await env.TR.prepare('SELECT 1 FROM agents WHERE id = ?').bind(macId).first(), 'the Mac agent is still registered');

// ---- forget: this phone revokes itself, like Remove on the admin site
assert.equal((await env.TR.prepare('SELECT COUNT(*) AS n FROM agent_keys WHERE agent_id = ?').bind(phone.id).first()).n, 2);
const fg = await authed(phone, P + '/forget', { method: 'POST' });
assert.equal(fg.status, 200); assert.deepEqual(fg.j, { ok: true });
for (const path of [P, '/v1/agents/m/home', '/v1/agents/me']) assert.equal((await authed(phone, path)).status, 401, 'after forget: ' + path);
assert.equal((await authed(phone, P + '/forget', { method: 'POST' })).status, 401, 'twice');
assert.equal((await env.TR.prepare('SELECT COUNT(*) AS n FROM agent_keys WHERE agent_id = ?').bind(phone.id).first()).n, 0, 'wrapped keys deleted');
assert.equal(await env.TR.prepare('SELECT 1 FROM agents WHERE id = ?').bind(phone.id).first(), null);
assert.equal(await env.TR.prepare('SELECT 1 FROM agent_kind WHERE agent_id = ?').bind(phone.id).first(), null);
assert.ok(!(await admin('owner@x.com', 'GET', '/agents')).j.agents.some((a) => a.id === phone.id), 'gone from the admin page');
// the other phone, and its keys, are untouched
assert.equal((await authed(other, P)).status, 200); assert.equal((await env.TR.prepare('SELECT COUNT(*) AS n FROM agent_keys WHERE agent_id = ?').bind(other.id).first()).n, 1);
assert.equal((await authed(other, '/v1/agents/me')).j.keys.length, 1);
const log = (await env.TR.prepare("SELECT action FROM access_log WHERE action LIKE 'device:%'").all()).results;
assert.ok(log.some((l) => l.action === 'device:forget') && log.some((l) => l.action === 'device:rename'));
console.log('forget', JSON.stringify(fg.j));

console.log('mobile-prefs: all passed');
await T.dispose();
