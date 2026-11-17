// Linkshell (src/linkshell.js): pairing, links, the WebSocket credential check, and the relay's hold/deliver/ack rules.
// The relay runs against a stand-in for the Durable Object's ctx; everything else against the local D1 like the other phone tests.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { setup, C, worker } from './mobile-helpers.mjs';
import { LinkshellRoom, checkCode, LS, linkshellTrim } from '../src/linkshell.js';

const T = await setup('.wrangler-test-linkshell');
const opened = [], closed = [];
T.E.LINKSHELL = {
  idFromName: (n) => n,
  get: (id) => ({ fetch: async (req) => {
    const u = new URL(typeof req === 'string' ? req : req.url);
    if (u.pathname === '/close') { closed.push(id); return new Response('ok'); }
    opened.push({ id, side: u.searchParams.get('side'), upgrade: req.headers.get('upgrade') });
    return new Response('connected ' + u.searchParams.get('side'));
  } }),
};
const pcKey = await C.newKeyPair(), phKey = await C.newKeyPair();
const store = (path, body) => T.call('POST', '/v1/914/linkshell/' + path, body);
const connect = (link, protos) => worker.fetch(new Request('https://t.test/v1/linkshell/connect?link=' + link, { headers: { upgrade: 'websocket', 'sec-websocket-protocol': protos } }), T.E, {});

try {
  const phone = await T.registerPhone('Galaxy Z Fold 8 Ultra');
  await T.approve(phone, [914]);
  const other = await T.registerPhone('Other phone');
  await T.approve(other, [326]);

  // PC starts a pairing
  let r = await store('pair/start', { publicJwk: pcKey.publicJwk, name: 'Chrome · Mac' });
  assert.equal(r.status, 200);
  const { pairId, code } = r.j;
  assert.match(pairId, /^[0-9a-f]{32}$/); assert.match(code, /^[A-Za-z0-9_-]{22}$/);
  assert.equal((await store('pair/status', { pairId, code })).j.state, 'waiting');
  assert.equal((await store('pair/status', { pairId, code: 'A'.repeat(22) })).status, 404, 'wrong code');
  assert.equal((await store('pair/finish', { pairId, code })).status, 409, 'not scanned yet');

  // a phone without the store can't take it; the right phone can
  r = await T.authed(other, '/v1/agents/m/linkshell/pair', { method: 'POST', body: { pairId, code, publicJwk: phKey.publicJwk } });
  assert.equal(r.status, 403);
  r = await T.authed(phone, '/v1/agents/m/linkshell/pair', { method: 'POST', body: { pairId, code, publicJwk: phKey.publicJwk } });
  assert.equal(r.status, 200); assert.equal(r.j.store, 914); assert.equal(r.j.pcName, 'Chrome · Mac'); assert.equal(r.j.pcJwk.x, pcKey.publicJwk.x);
  const linkId = r.j.linkId;
  r = await store('pair/status', { pairId, code });
  assert.equal(r.j.state, 'scanned'); assert.equal(r.j.linkId, linkId); assert.equal(r.j.phoneName, 'Galaxy Z Fold 8 Ultra'); assert.equal(r.j.phoneJwk.x, phKey.publicJwk.x);
  assert.equal(await checkCode(pcKey.publicJwk, r.j.phoneJwk), await checkCode(pcKey.publicJwk, phKey.publicJwk));
  assert.match(await checkCode(pcKey.publicJwk, phKey.publicJwk), /^[A-Z2-9]{3} [A-Z2-9]{3}$/);
  assert.notEqual(await checkCode(pcKey.publicJwk, phKey.publicJwk), await checkCode(phKey.publicJwk, pcKey.publicJwk), 'order matters');

  // the PC confirms: a token once, the pairing is gone
  r = await store('pair/finish', { pairId, code });
  assert.equal(r.status, 200); assert.equal(r.j.linkId, linkId); assert.match(r.j.token, /^[0-9a-f]{64}$/);
  const token = r.j.token;
  assert.equal((await store('pair/status', { pairId, code })).status, 404);
  const row = await T.env.TR.prepare('SELECT * FROM linkshell_links WHERE id = ?').bind(linkId).first();
  assert.notEqual(row.pc_token_hash, token, 'only the hash is kept');
  assert.equal((await store('link', { linkId, token })).j.phoneName, 'Galaxy Z Fold 8 Ultra');
  assert.equal((await store('link', { linkId, token: '0'.repeat(64) })).status, 404);
  assert.equal((await T.call('POST', '/v1/326/linkshell/link', { linkId, token })).status, 404, 'another store');
  r = await T.authed(phone, '/v1/agents/m/linkshell/links');
  assert.deepEqual(r.j.links.map((l) => [l.id, l.store, l.pcName]), [[linkId, 914, 'Chrome · Mac']]);
  assert.deepEqual((await T.authed(other, '/v1/agents/m/linkshell/links')).j.links, []);

  // the socket: each end with its own credential, nothing else
  let c = await connect(linkId, 'linkshell, pc.' + token);
  assert.equal(c.status, 200); assert.equal(await c.text(), 'connected pc');
  c = await connect(linkId, 'linkshell, ph.' + phone.id + '.' + phone.token);
  assert.equal(await c.text(), 'connected phone');
  assert.deepEqual(opened.map((o) => [o.id, o.side, o.upgrade]), [[linkId, 'pc', 'websocket'], [linkId, 'phone', 'websocket']]);
  assert.equal((await connect(linkId, 'linkshell, pc.' + '1'.repeat(64))).status, 401);
  assert.equal((await connect(linkId, 'linkshell, ph.' + other.id + '.' + other.token)).status, 401, 'another phone');
  assert.equal((await connect(linkId, 'pc.' + token)).status, 400, 'protocol name required');
  assert.equal((await connect('f'.repeat(32), 'linkshell, pc.' + token)).status, 404);
  assert.equal((await worker.fetch(new Request('https://t.test/v1/linkshell/connect?link=' + linkId), T.E, {})).status, 426);

  // limits: 3 links per phone
  const pairAndFinish = async (st = 914) => {
    const s = await T.call('POST', `/v1/${st}/linkshell/pair/start`, { publicJwk: pcKey.publicJwk, name: 'PC' });
    await T.authed(phone, '/v1/agents/m/linkshell/pair', { method: 'POST', body: { pairId: s.j.pairId, code: s.j.code, publicJwk: phKey.publicJwk } });
    return T.call('POST', `/v1/${st}/linkshell/pair/finish`, { pairId: s.j.pairId, code: s.j.code });
  };
  assert.equal((await pairAndFinish()).status, 200);
  assert.equal((await pairAndFinish()).status, 200);
  assert.equal((await pairAndFinish()).status, 429, 'fourth link for one phone');

  // unlink from either end closes the relay
  r = await store('unlink', { linkId, token });
  assert.equal(r.status, 200); assert.deepEqual(closed, [linkId]);
  assert.equal((await store('link', { linkId, token })).status, 404);
  assert.equal((await connect(linkId, 'linkshell, pc.' + token)).status, 404);
  const left = (await T.authed(phone, '/v1/agents/m/linkshell/links')).j.links;
  assert.equal(left.length, 2);
  r = await T.authed(phone, '/v1/agents/m/linkshell/unlink', { method: 'POST', body: { linkId: left[0].id } });
  assert.equal(r.status, 200); assert.equal(closed.at(-1), left[0].id);
  assert.equal((await T.authed(other, '/v1/agents/m/linkshell/unlink', { method: 'POST', body: { linkId: left[1].id } })).status, 404, "not that phone's link");

  // the daily job: a link unused for 30 days goes
  await T.env.TR.prepare('UPDATE linkshell_links SET used_at = ? WHERE id = ?').bind(new Date(Date.now() - 31 * 86400000).toISOString(), left[1].id).run();
  assert.equal(await linkshellTrim(T.E), 1);
  assert.equal((await T.authed(phone, '/v1/agents/m/linkshell/links')).j.links.length, 0);
  console.log('linkshell routes: all passed');
} finally {
  await T.dispose();
}

// ------------------------------------------------------------------ the relay
class FakeSocket {
  constructor() { this.sent = []; this.readyState = 1; this.closedWith = null; }
  send(s) { this.sent.push(s); }
  close(code) { this.readyState = 3; this.closedWith = code; }
  frames() { return this.sent.filter((s) => s !== 'pong').map((s) => JSON.parse(s)); }
}
function fakeCtx() {
  const db = new DatabaseSync(':memory:'), kv = new Map(), sockets = [];
  let alarm = null;
  return {
    sockets, get alarmAt() { return alarm; },
    storage: {
      sql: { exec: (q, ...a) => { const st = db.prepare(q); const rows = /^\s*select/i.test(q) ? st.all(...a) : (st.run(...a), []); return { toArray: () => rows }; } },
      get: async (k) => kv.get(k), put: async (k, v) => { kv.set(k, v); }, deleteAll: async () => { kv.clear(); db.exec('DELETE FROM held'); },
      getAlarm: async () => alarm, setAlarm: async (t) => { alarm = t; },
    },
    acceptWebSocket: (ws, tags) => { ws.tags = tags; sockets.push(ws); },
    getWebSockets: (tag) => sockets.filter((w) => w.readyState === 1 && (!tag || w.tags.includes(tag))),
    getTags: (ws) => ws.tags,
  };
}
{
  const ctx = fakeCtx(), room = new LinkshellRoom(ctx, {});
  const msg = (id, kind = 'pullbacks.scan') => JSON.stringify({ t: 'msg', id, kind, iv: 'AAAAAAAAAAAAAAAA', ct: 'c2VhbGVk' });

  // phone connects alone; its message is held for the PC
  const ph = new FakeSocket();
  await room.accept(ph, 'phone');
  assert.deepEqual(ph.frames()[0], { t: 'hello', peer: false, seen: null });
  await room.webSocketMessage(ph, msg('m0000001'));
  assert.equal(ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM held').toArray()[0].n, 1);
  assert.ok(ctx.alarmAt > Date.now() + 23 * 3600000, 'cleanup in 24 h');

  // the PC connects: hello says the phone is there, the held message arrives, the phone hears the PC came
  const pc = new FakeSocket();
  await room.accept(pc, 'pc');
  assert.deepEqual(pc.frames()[0], { t: 'hello', peer: true, seen: null });
  assert.equal(pc.frames()[1].id, 'm0000001');
  assert.deepEqual(ph.frames().at(-1), { t: 'presence', peer: true, seen: null });
  // the PC acknowledges: held copy gone, phone told
  await room.webSocketMessage(pc, JSON.stringify({ t: 'ack', ids: ['m0000001'] }));
  assert.equal(ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM held').toArray()[0].n, 0);
  assert.deepEqual(ph.frames().at(-1), { t: 'ack', ids: ['m0000001'] });

  // both connected: straight through, nothing stored
  await room.webSocketMessage(pc, msg('m0000002', 'pullbacks.result'));
  assert.equal(ph.frames().at(-1).id, 'm0000002');
  assert.equal(ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM held').toArray()[0].n, 0);
  // bad frames are dropped
  for (const bad of [JSON.stringify({ t: 'msg', id: 'x', kind: 'a', iv: 'A', ct: 'A' }), JSON.stringify({ t: 'msg', id: 'm0000003', kind: 'Bad Kind', iv: 'A', ct: 'A' }), 'not json'])
    await room.webSocketMessage(pc, bad);
  assert.equal(ph.frames().at(-1).id, 'm0000002');
  // oversized frame closes the socket
  const big = new FakeSocket(); await room.accept(big, 'pc');
  await room.webSocketMessage(big, 'x'.repeat(LS.MAX_FRAME + 1));
  assert.equal(big.closedWith, 1009);
  assert.equal(pc.closedWith, 4000, 'a second PC socket replaces the first');

  // the phone leaves: the PC hears when; a message for it is held
  ph.readyState = 3;
  await room.webSocketClose(ph, 1000);
  const p = ph; void p;
  // (the PC socket in use now is `big`, which was closed; reconnect one)
  const pc2 = new FakeSocket(); await room.accept(pc2, 'pc');
  assert.equal(pc2.frames()[0].peer, false); assert.equal(typeof pc2.frames()[0].seen, 'number');
  await room.webSocketMessage(pc2, msg('m0000004', 'pullbacks.result'));
  assert.equal(ctx.storage.sql.exec('SELECT side FROM held').toArray()[0].side, 'phone');
  // the phone's next connect gets it
  const ph2 = new FakeSocket(); await room.accept(ph2, 'phone');
  assert.equal(ph2.frames()[1].id, 'm0000004');

  // held for longer than 24 h is dropped by the alarm
  ctx.storage.sql.exec('UPDATE held SET at = ?', Date.now() - 25 * 3600000);
  await room.alarm();
  assert.equal(ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM held').toArray()[0].n, 0);

  // unlink closes everything and forgets
  const res = await room.fetch(new Request('https://linkshell/close', { method: 'POST' }));
  assert.equal(await res.text(), 'ok');
  assert.equal(pc2.closedWith, 4001); assert.equal(ph2.closedWith, 4001);
  console.log('linkshell relay: all passed');
}
