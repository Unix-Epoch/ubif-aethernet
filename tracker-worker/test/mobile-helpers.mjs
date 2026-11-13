// Shared helpers for the phone API's tests (Linkpearl). Everything is invented. Usage:
//   const T = await setup('.wrangler-test-mobile-xyz');           // seeded local D1 + the tracker Worker + an initialised tracker (master key, store keys)
//   const phone = await T.registerPhone('Pixel');                 // POST /v1/agents/register { kind: 'phone' } → { id, token, keys, fingerprint }
//   await T.approve(phone, [914, 326]);                           // the owner approves it through the admin route (wraps the store keys to the phone)
//   const r = await T.authed(phone, '/v1/agents/m/home?store=all');   // → { status, j, h }  (method / body: authed(phone, path, { method, body }))
//   await T.dispose();
// NOW is a fixed "now" (Thursday 4 PM Eastern, store hours) for tests that pass `now`; the Worker's own clock is real.
import { readFileSync, rmSync } from 'node:fs';
import { getPlatformProxy } from 'wrangler';
import worker, { trackerAdmin } from '../src/index.js';
import { localToUtc } from '../src/metrics.js';
import * as C from '../src/crypto.js';

export { C, worker };
export const TZ = 'America/New_York';
export const Z = (day, hour, min = 0) => new Date(localToUtc(day, hour, TZ) + min * 60000).toISOString();
export const NOW = Date.parse(Z('2026-10-15', 16));
export const OWNER = 'owner@x.com', APP_KEY = 'k';
export const STORES = { 914: 'Newport News', 326: 'Lynnhaven', 536: 'Lexington' };
export const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => x.toString(16).padStart(2, '0')).join('');
export const bearer = (p) => ({ authorization: 'Bearer ' + p.id + '.' + p.token });

const sql = (file) => readFileSync(file, 'utf8').replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean);

export async function setup(dir) {
  rmSync(dir, { recursive: true, force: true });
  const { env, dispose } = await getPlatformProxy({ configPath: 'wrangler.toml', persist: { path: dir } });
  for (const s of sql('schema.sql')) await env.TR.prepare(s).run();
  await env.AE.prepare('CREATE TABLE IF NOT EXISTS store_access (store INTEGER PRIMARY KEY, name TEXT, added_by TEXT, added_at TEXT)').run();
  for (const [id, name] of Object.entries(STORES)) await env.AE.prepare('INSERT INTO store_access (store, name) VALUES (?, ?)').bind(Number(id), name).run();
  const E = Object.assign({}, env, { APP_KEY, TRACKER_OWNERS: OWNER, LIMITER: null });

  // the store side (x-aethernet-key) and the agent side
  const call = async (method, path, body, headers = {}) => {
    const r = await worker.fetch(new Request('https://t.test' + path, { method, headers: Object.assign({ 'x-aethernet-key': APP_KEY, 'content-type': 'application/json' }, headers), body: body ? JSON.stringify(body) : undefined }), E, {});
    return { status: r.status, j: await r.json().catch(() => null), h: r.headers };
  };
  // the admin site's tracker routes, as a signed-in person
  const admin = async (email, method, path, body) => {
    const r = await trackerAdmin(new Request('https://a.test/api/tracker' + path, { method, body: body ? JSON.stringify(body) : undefined }), E, new URL('https://a.test/api/tracker' + path), path.split('?')[0], email);
    return { status: r.status, j: await r.json() };
  };

  // initialise the tracker: master key, a key per store
  const master = await C.newKeyPair();
  const copy = await C.lockWithPhrase(await C.exportPrivate(master.privateKey), 'harbor violet tundra pickle anchor ember', C.aad.person(OWNER, 'master', 0), 100000);
  const init = await admin(OWNER, 'POST', '/init', { publicJwk: master.publicJwk, copy });
  if (init.status >= 300) throw new Error('init failed ' + init.status);
  const storeKeys = {};
  for (const id of Object.keys(STORES)) {
    const k = await C.newStoreKey(Number(id), master.publicJwk);
    await call('POST', `/v1/${id}/tracker/key`, k);
    storeKeys[id] = { wrappedPrivate: k.wrappedPrivate, publicJwk: k.publicJwk, bytes: await C.openStoreKeyBytes(Number(id), k.wrappedPrivate, master.privateKey) };
  }

  // a phone registers: its own P-256 key pair, a random id and token (the app keeps the token; the server keeps only its sha256)
  const registerPhone = async (name = 'Test phone', extra = {}) => {
    const kp = await C.newKeyPair(), p = { id: hex(16), token: hex(32), name, kp, publicJwk: kp.publicJwk };
    const r = await call('POST', '/v1/agents/register', Object.assign({ id: p.id, name, publicJwk: kp.publicJwk, token: p.token, kind: 'phone' }, extra));
    return Object.assign(p, { reg: r });
  };
  // the owner approves it: the admin page's "Approve…" does exactly this (unlocked browser wraps each store key to the phone's key)
  const approve = async (p, stores, email = OWNER) => admin(email, 'POST', `/agents/${p.id}/approve`, {
    stores, keys: await Promise.all(stores.map(async (st) => ({ store: st, wrapped: await C.sealBytes(storeKeys[st].bytes, p.publicJwk, 'agentkey|' + p.id + '|' + st) }))) });
  const authed = async (p, path, o = {}) => call(o.method || 'GET', path, o.body, p ? bearer(p) : {});
  const scheduled = async (cron) => { const ps = []; await worker.scheduled({ cron }, E, { waitUntil: (pr) => ps.push(pr) }); await Promise.all(ps); }; // runs the cron and waits for its work

  // a few invented rows so Home has numbers: open work orders (914: 3, 326: 1, 536: 2), one sale per store today
  const wo = (store, n, status) => env.TR.prepare("INSERT INTO workorders (store, wo, status_id, program_name, device, created_at, is_open) VALUES (?, ?, ?, 'Retail', 'iPhone 13', ?, 1)").bind(store, n, status, Z('2026-10-01', 10));
  await env.TR.batch([wo(914, 1, 2), wo(914, 2, 9), wo(914, 3, 13), wo(326, 4, 13), wo(536, 5, 2), wo(536, 6, 3)]);
  return { env, E, call, admin, master, storeKeys, registerPhone, approve, authed, scheduled, bearer, dispose };
}
