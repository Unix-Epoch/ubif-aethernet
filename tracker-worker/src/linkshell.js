/*
  Linkshell: a paired link between one Aethernet browser (the PC) and one Linkpearl phone, relayed live by a Durable Object.

  The Worker never sees what goes over a link. The two ends agree a key with ECDH (each keeps its private half) and seal every
  message body with AES-256-GCM before sending it; the relay sees only the envelope: an id, a kind (a fixed word such as
  "pullbacks.scan"), and the sealed bytes. A message is held only while the other end isn't connected, and for 24 hours at most.

  Pairing (the PC shows a QR code, the phone scans it):
    PC     POST /v1/:store/linkshell/pair/start   { publicJwk, name }          → { pairId, code, expiresAt }   (5 minutes)
    phone  POST /v1/agents/m/linkshell/pair       { pairId, code, publicJwk }  → { linkId, store, pcName, pcJwk }
    PC     POST /v1/:store/linkshell/pair/status  { pairId, code }             → { state: 'waiting' } | { state: 'scanned', linkId, phoneName, phoneJwk }
    PC     POST /v1/:store/linkshell/pair/finish  { pairId, code }             → { linkId, token }  (the PC's link token, shown once; only its hash is kept)
    PC     POST /v1/:store/linkshell/pair/cancel  { pairId, code }
  Both ends show a check code made from the two public keys, so a key swapped on the way would show as a different code.

  The link afterwards:
    PC     POST /v1/:store/linkshell/link    { linkId, token }  → { linkId, phoneName, usedAt }   (404 once unlinked)
    PC     POST /v1/:store/linkshell/unlink  { linkId, token }
    phone  GET  /v1/agents/m/linkshell/links                   → { links: [{ id, store, pcName, createdAt, usedAt }] }
    phone  POST /v1/agents/m/linkshell/unlink { linkId }
    either GET  /v1/linkshell/connect?link=<id>  (WebSocket upgrade)
      Browsers can't set headers on a WebSocket, so the credential rides in Sec-WebSocket-Protocol:
        'linkshell, pc.<link token>'            the PC
        'linkshell, ph.<agent id>.<agent token>' the phone (its device token, as on every other phone route)
      The answer picks 'linkshell'. No app key on this route: the credential is stronger than the public key.

  Frames over the socket (JSON text):
    → { t: 'msg', id, kind, iv, ct }   a sealed message for the other end; delivered at once, or held if it isn't connected
    → { t: 'ack', ids: [...] }         received and applied; held copies are dropped and the sender is told
    ← { t: 'hello', peer, seen }       on connect: whether the other end is connected, and when it was last seen
    ← { t: 'presence', peer, seen }    the other end connected or left
    'ping' → 'pong'                    keep-alive, answered by Cloudflare without waking the relay (not billed)
  Idle sockets hibernate, so a connected but quiet link costs nothing.

  Limits: 3 links per phone, 5 per store; a link unused for 30 days is removed by the daily job, as is any link whose phone is removed.
*/

export const LS = { PAIR_MIN: 5, IDLE_DAYS: 30, PER_PHONE: 3, PER_STORE: 5, PAIRS_PER_STORE: 10, HOLD_HOURS: 24, MAX_FRAME: 16384, MAX_HELD: 500 };
const HEX32 = /^[0-9a-f]{32}$/, HEX64 = /^[0-9a-f]{64}$/, CODE = /^[A-Za-z0-9_-]{22}$/, B64U = /^[A-Za-z0-9_-]+$/;
const KIND = /^[a-z][a-z0-9-]{0,30}(\.[a-z0-9-]{1,30}){0,3}$/, MID = /^[A-Za-z0-9_-]{8,40}$/, B64 = /^[A-Za-z0-9+/_-]+=*$/;

const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((x) => x.toString(16).padStart(2, '0')).join('');
const b64u = (n) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const sha256hex = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map((x) => x.toString(16).padStart(2, '0')).join('');
const isJwk = (k) => k && k.kty === 'EC' && k.crv === 'P-256' && typeof k.x === 'string' && typeof k.y === 'string' && k.x.length === 43 && k.y.length === 43 && B64U.test(k.x) && B64U.test(k.y) && !('d' in k);
const pubJwk = (k) => ({ kty: 'EC', crv: 'P-256', x: k.x, y: k.y });
const nowIso = () => new Date().toISOString();
const plus = (min) => new Date(Date.now() + min * 60000).toISOString();

// The check code both ends show: 6 characters from sha256 of the PC's and the phone's public keys (x and y, in that order).
const CHECK_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export async function checkCode(pcJwk, phoneJwk) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pcJwk.x + '.' + pcJwk.y + '|' + phoneJwk.x + '.' + phoneJwk.y)));
  let s = '';
  for (let i = 0; i < 6; i++) s += CHECK_ABC[d[i] & 31];
  return s.slice(0, 3) + ' ' + s.slice(3);
}

async function pairRow(T, store, b) {
  if (!HEX32.test(b.pairId) || !CODE.test(b.code)) return null;
  await T.prepare('DELETE FROM linkshell_pairs WHERE expires_at < ?').bind(nowIso()).run();
  const p = await T.prepare('SELECT * FROM linkshell_pairs WHERE id = ?').bind(b.pairId).first();
  if (!p || (store != null && p.store !== store) || (await sha256hex(b.code)) !== p.code_hash) return null;
  return p;
}
async function pcLink(T, store, b) {
  if (!HEX32.test(b.linkId) || !HEX64.test(b.token)) return null;
  const l = await T.prepare('SELECT * FROM linkshell_links WHERE id = ? AND store = ?').bind(b.linkId, store).first();
  return l && (await sha256hex(b.token)) === l.pc_token_hash ? l : null;
}
const closeRoom = (env, linkId) => (env.LINKSHELL ? env.LINKSHELL.get(env.LINKSHELL.idFromName(linkId)).fetch('https://linkshell/close', { method: 'POST' }).catch(() => {}) : null);

// /v1/:store/linkshell/… (the store side: app key checked and the store allowed, as on every store route)
export async function linkshellStore(req, env, url, store, h) {
  const T = env.TR, what = url.pathname.replace(/^\/v1\/\d+\/linkshell\//, '');
  if (req.method !== 'POST') return h.fail(405, 'method not allowed');
  const b = await h.readJson(req, 4000);
  if (what === 'pair/start') {
    if (!isJwk(b.publicJwk)) return h.fail(400, 'publicJwk required');
    await T.prepare('DELETE FROM linkshell_pairs WHERE expires_at < ?').bind(nowIso()).run();
    if ((await T.prepare('SELECT COUNT(*) AS n FROM linkshell_pairs WHERE store = ?').bind(store).first()).n >= LS.PAIRS_PER_STORE) return h.fail(429, 'too many pairings open');
    const pairId = hex(16), code = b64u(16), expiresAt = plus(LS.PAIR_MIN);
    await T.prepare('INSERT INTO linkshell_pairs (id, store, code_hash, pc_jwk, pc_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(pairId, store, await sha256hex(code), JSON.stringify(pubJwk(b.publicJwk)), h.clean(b.name, 60) || 'PC', nowIso(), expiresAt).run();
    return h.json({ pairId, code, expiresAt });
  }
  if (what.startsWith('pair/')) {
    const p = await pairRow(T, store, b);
    if (!p) return h.fail(404, 'pairing expired');
    if (what === 'pair/cancel') { await T.prepare('DELETE FROM linkshell_pairs WHERE id = ?').bind(p.id).run(); return h.json({ ok: true }); }
    const phone = p.agent_id && await T.prepare('SELECT name FROM agents WHERE id = ?').bind(p.agent_id).first();
    if (what === 'pair/status') {
      if (!p.agent_id) return h.json({ state: 'waiting', expiresAt: p.expires_at });
      return h.json({ state: 'scanned', linkId: p.link_id, phoneName: phone ? phone.name : 'Phone', phoneJwk: JSON.parse(p.phone_jwk), expiresAt: p.expires_at });
    }
    if (what === 'pair/finish') {
      if (!p.agent_id || !phone) return h.fail(409, 'not scanned yet');
      const nPhone = (await T.prepare('SELECT COUNT(*) AS n FROM linkshell_links WHERE agent_id = ?').bind(p.agent_id).first()).n;
      const nStore = (await T.prepare('SELECT COUNT(*) AS n FROM linkshell_links WHERE store = ?').bind(store).first()).n;
      if (nPhone >= LS.PER_PHONE) return h.fail(429, 'this phone has too many links');
      if (nStore >= LS.PER_STORE) return h.fail(429, 'this store has too many links');
      const token = hex(32), t = nowIso();
      await T.batch([
        T.prepare('INSERT INTO linkshell_links (id, store, agent_id, pc_token_hash, pc_name, pc_jwk, phone_jwk, created_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(p.link_id, store, p.agent_id, await sha256hex(token), p.pc_name, p.pc_jwk, p.phone_jwk, t, t),
        T.prepare('DELETE FROM linkshell_pairs WHERE id = ?').bind(p.id),
      ]);
      await h.log(env, 'linkshell', 'linkshell:link', store, null, p.link_id + ' ' + phone.name);
      return h.json({ linkId: p.link_id, token, phoneName: phone.name });
    }
    return h.fail(404, 'not found');
  }
  const l = await pcLink(T, store, b);
  if (!l) return h.fail(404, 'no such link');
  if (what === 'link') {
    const phone = await T.prepare('SELECT name FROM agents WHERE id = ?').bind(l.agent_id).first();
    return h.json({ linkId: l.id, phoneName: phone ? phone.name : 'Phone', usedAt: l.used_at });
  }
  if (what === 'unlink') {
    await T.prepare('DELETE FROM linkshell_links WHERE id = ?').bind(l.id).run();
    await closeRoom(env, l.id);
    await h.log(env, 'linkshell', 'linkshell:unlink', store, null, l.id + ' pc');
    return h.json({ ok: true });
  }
  return h.fail(404, 'not found');
}

// /v1/agents/m/linkshell/… (the phone side: device token checked, phone approved; `device.stores` are its stores)
export async function linkshellPhone(req, env, url, device, h) {
  const T = env.TR, what = url.pathname.replace(/^\/v1\/agents\/m\/linkshell\/?/, '');
  if (what === 'links' && req.method === 'GET') {
    const r = await T.prepare('SELECT id, store, pc_name, created_at, used_at FROM linkshell_links WHERE agent_id = ? ORDER BY created_at').bind(device.id).all();
    return h.json({ links: r.results.map((l) => ({ id: l.id, store: l.store, pcName: l.pc_name, createdAt: l.created_at, usedAt: l.used_at })) });
  }
  if (req.method !== 'POST') return h.fail(405, 'method not allowed');
  const b = await h.readJson(req, 4000);
  if (what === 'pair') {
    if (!isJwk(b.publicJwk)) return h.fail(400, 'publicJwk required');
    const p = await pairRow(T, null, b);
    if (!p) return h.fail(404, 'pairing expired');
    if (!device.stores.includes(p.store)) return h.fail(403, 'this phone has no access to that store');
    if (p.agent_id && p.agent_id !== device.id) return h.fail(409, 'already scanned by another phone');
    const linkId = p.link_id || hex(16);
    await T.prepare('UPDATE linkshell_pairs SET agent_id = ?, phone_jwk = ?, link_id = ? WHERE id = ?').bind(device.id, JSON.stringify(pubJwk(b.publicJwk)), linkId, p.id).run();
    return h.json({ linkId, store: p.store, pcName: p.pc_name, pcJwk: JSON.parse(p.pc_jwk), expiresAt: p.expires_at });
  }
  if (what === 'unlink') {
    if (!HEX32.test(b.linkId)) return h.fail(400, 'linkId required');
    const r = await T.prepare('DELETE FROM linkshell_links WHERE id = ? AND agent_id = ?').bind(b.linkId, device.id).run();
    if (!(r.meta && r.meta.changes)) return h.fail(404, 'no such link');
    await closeRoom(env, b.linkId);
    await h.log(env, 'device:' + device.id, 'linkshell:unlink', null, null, b.linkId + ' phone');
    return h.json({ ok: true });
  }
  return h.fail(404, 'not found');
}

// GET /v1/linkshell/connect?link=<id> — checked here, then handed to the link's relay.
export async function linkshellConnect(req, env, url, h) {
  if ((req.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return h.fail(426, 'websocket expected');
  const linkId = url.searchParams.get('link') || '';
  if (!HEX32.test(linkId)) return h.fail(400, 'link required');
  const protos = (req.headers.get('sec-websocket-protocol') || '').split(',').map((s) => s.trim());
  if (!protos.includes('linkshell')) return h.fail(400, 'linkshell protocol required');
  const T = env.TR, l = await T.prepare('SELECT * FROM linkshell_links WHERE id = ?').bind(linkId).first();
  if (!l) return h.fail(404, 'no such link');
  let side = null;
  for (const p of protos) {
    let m;
    if ((m = /^pc\.([0-9a-f]{64})$/.exec(p)) && (await sha256hex(m[1])) === l.pc_token_hash && (await h.allowed(env, l.store))) side = 'pc';
    else if ((m = /^ph\.([0-9a-f]{32})\.([0-9a-f]{64})$/.exec(p)) && m[1] === l.agent_id) {
      const a = await T.prepare('SELECT a.token_hash, a.status, a.stores, k.kind FROM agents a LEFT JOIN agent_kind k ON k.agent_id = a.id WHERE a.id = ?').bind(m[1]).first();
      if (a && a.status === 'active' && a.kind === 'phone' && (await sha256hex(m[2])) === a.token_hash && JSON.parse(a.stores || '[]').includes(l.store)) side = 'phone';
    }
  }
  if (!side) return h.fail(401, 'wrong credential');
  if (!env.LINKSHELL) return h.fail(503, 'linkshell not set up');
  await T.prepare('UPDATE linkshell_links SET used_at = ? WHERE id = ?').bind(nowIso(), l.id).run();
  const stub = env.LINKSHELL.get(env.LINKSHELL.idFromName(l.id));
  return stub.fetch(new Request('https://linkshell/connect?side=' + side, { headers: { upgrade: 'websocket' } }));
}

// Daily: links unused for 30 days, links whose phone is gone, and expired pairings.
export async function linkshellTrim(env) {
  const T = env.TR, cutoff = new Date(Date.now() - LS.IDLE_DAYS * 86400000).toISOString();
  const gone = await T.prepare('SELECT id FROM linkshell_links WHERE used_at < ? OR agent_id NOT IN (SELECT id FROM agents)').bind(cutoff).all();
  for (const r of gone.results) { await T.prepare('DELETE FROM linkshell_links WHERE id = ?').bind(r.id).run(); await closeRoom(env, r.id); }
  await T.prepare('DELETE FROM linkshell_pairs WHERE expires_at < ?').bind(nowIso()).run();
  return gone.results.length;
}

/*
  The relay for one link (Durable Object, SQLite storage, WebSocket hibernation). Sockets are tagged 'pc' or 'phone'; one of each
  at a time (a new one replaces the old). `held` keeps messages for an end that isn't connected, until it acknowledges them.
  The handlers are written against ctx's surface only (getWebSockets, getTags, acceptWebSocket, storage.sql/get/put/setAlarm),
  so the tests drive them with a stand-in.
*/
const other = (s) => (s === 'pc' ? 'phone' : 'pc');
export class LinkshellRoom {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS held (id TEXT PRIMARY KEY, side TEXT NOT NULL, frame TEXT NOT NULL, at INTEGER NOT NULL)');
    if (typeof WebSocketRequestResponsePair !== 'undefined' && ctx.setWebSocketAutoResponse) ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  peers(side) { return this.ctx.getWebSockets(side).filter((ws) => ws.readyState === undefined || ws.readyState === 1); }
  send(side, obj) { const s = JSON.stringify(obj); for (const ws of this.peers(side)) { try { ws.send(s); } catch (_) {} } }
  async seen(side) { return (await this.ctx.storage.get('seen:' + side)) || null; }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/close') {
      for (const ws of this.ctx.getWebSockets()) { try { ws.close(4001, 'unlinked'); } catch (_) {} }
      await this.ctx.storage.deleteAll();
      return new Response('ok');
    }
    const side = url.searchParams.get('side');
    if (url.pathname !== '/connect' || (side !== 'pc' && side !== 'phone')) return new Response('not found', { status: 404 });
    const pair = new WebSocketPair(), client = pair[0], server = pair[1];
    await this.accept(server, side);
    return new Response(null, { status: 101, webSocket: client, headers: { 'sec-websocket-protocol': 'linkshell' } });
  }
  async accept(server, side) {
    for (const ws of this.ctx.getWebSockets(side)) { try { ws.close(4000, 'replaced'); } catch (_) {} }
    this.ctx.acceptWebSocket(server, [side]);
    server.send(JSON.stringify({ t: 'hello', peer: this.peers(other(side)).length > 0, seen: await this.seen(other(side)) }));
    for (const r of this.ctx.storage.sql.exec('SELECT frame FROM held WHERE side = ? ORDER BY at', side).toArray()) server.send(r.frame);
    this.send(other(side), { t: 'presence', peer: true, seen: null });
  }
  async webSocketMessage(ws, data) {
    const side = this.ctx.getTags(ws)[0], to = other(side);
    if (typeof data !== 'string' || data.length > LS.MAX_FRAME) { ws.close(1009, 'frame too large'); return; }
    let f;
    try { f = JSON.parse(data); } catch (_) { return; }
    if (!f || typeof f !== 'object') return;
    if (f.t === 'msg') {
      if (!MID.test(f.id) || !KIND.test(f.kind) || typeof f.iv !== 'string' || f.iv.length > 32 || !B64.test(f.iv) || typeof f.ct !== 'string' || !B64.test(f.ct)) return;
      const frame = JSON.stringify({ t: 'msg', id: f.id, kind: f.kind, iv: f.iv, ct: f.ct });
      if (this.peers(to).length) { this.send(to, JSON.parse(frame)); return; }
      const n = this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM held').toArray()[0].n;
      if (n >= LS.MAX_HELD) return;
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO held (id, side, frame, at) VALUES (?, ?, ?, ?)', f.id, to, frame, Date.now());
      if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + LS.HOLD_HOURS * 3600000);
      return;
    }
    if (f.t === 'ack' && Array.isArray(f.ids)) {
      const ids = f.ids.filter((x) => typeof x === 'string' && MID.test(x)).slice(0, 200);
      if (!ids.length) return;
      this.ctx.storage.sql.exec(`DELETE FROM held WHERE side = ? AND id IN (${ids.map(() => '?').join(',')})`, side, ...ids);
      this.send(to, { t: 'ack', ids });
    }
  }
  async webSocketClose(ws, code) {
    const side = this.ctx.getTags(ws)[0];
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch (_) {}
    if (this.ctx.getWebSockets(side).some((x) => x !== ws && (x.readyState === undefined || x.readyState === 1))) return;
    const at = Date.now();
    await this.ctx.storage.put('seen:' + side, at);
    this.send(other(side), { t: 'presence', peer: false, seen: at });
  }
  async webSocketError(ws) { return this.webSocketClose(ws, 1011); }
  async alarm() {
    this.ctx.storage.sql.exec('DELETE FROM held WHERE at < ?', Date.now() - LS.HOLD_HOURS * 3600000);
    const left = this.ctx.storage.sql.exec('SELECT MIN(at) AS a FROM held').toArray()[0].a;
    if (left != null) await this.ctx.storage.setAlarm(left + LS.HOLD_HOURS * 3600000);
  }
}
