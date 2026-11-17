// Linkshell (src/67-linkshell.js): the sealing and check code against the Worker's, the QR code's layout, and the socket's
// delivery rules (outbox until acked, each message applied once, unlink/replace/idle closes). Fake keys and data only.
// node test-client/linkshell.mjs
import fs from 'fs';
import vm from 'vm';
import strict from 'assert/strict';
import { checkCode as workerCheckCode } from '../tracker-worker/src/linkshell.js';

const plain = (x) => JSON.parse(JSON.stringify(x));
const assert = Object.assign((...a) => strict(...a), strict, { deepEqual: (a, b, m) => strict.deepEqual(plain(a), plain(b), m) });

// ---- the browser, stubbed: GM storage, a fake WebSocket, a manual clock for timers
const gm = new Map();
const timers = new Map(); let tid = 0, now = 0;
const setT = (fn, ms) => { const id = ++tid; timers.set(id, { fn, at: now + (ms || 0), every: 0 }); return id; };
const setI = (fn, ms) => { const id = ++tid; timers.set(id, { fn, at: now + ms, every: ms }); return id; };
const clr = (id) => timers.delete(id);
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 2)); }; // WebCrypto runs off the main thread: give it real time
async function advance(ms) {
  const end = now + ms;
  for (;;) {
    const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) break;
    const [id, t] = next; now = t.at;
    if (t.every) t.at += t.every; else timers.delete(id);
    t.fn(); await settle();
  }
  now = end; await settle();
}
const sockets = [];
class FakeWS {
  constructor(url, protocols) { this.url = url; this.protocols = protocols; this.readyState = 0; this.sent = []; sockets.push(this); }
  send(d) { this.sent.push(d); }
  close(code, reason) { if (this.readyState === 3) return; this.readyState = 3; this.closedWith = code; this.onclose && this.onclose({ code, reason }); }
  // the relay's side
  open() { this.readyState = 1; this.onopen && this.onopen(); }
  push(frame) { this.onmessage && this.onmessage({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) }); }
  drop(code) { this.readyState = 3; this.onclose && this.onclose({ code }); }
  frames() { return this.sent.filter((d) => d !== 'ping').map((d) => JSON.parse(d)); }
}
const calls = [];
const AE = {
  shard() {}, track() {},
  async workerCall(method, url, init) { calls.push([method, url, JSON.parse(init.body)]); return {}; },
};
const ctx = vm.createContext({
  AE, TextEncoder, TextDecoder, crypto, btoa, atob, console, JSON, Date: class extends Date { static now() { return now; } },
  setTimeout: setT, clearTimeout: clr, setInterval: setI, clearInterval: clr, WebSocket: FakeWS,
  GM_getValue: (k, d) => (gm.has(k) ? plain(gm.get(k)) : d), GM_setValue: (k, v) => gm.set(k, plain(v)), GM_deleteValue: (k) => gm.delete(k),
  document: { visibilityState: 'visible' }, navigator: { userAgent: 'node-test' },
});
let src = fs.readFileSync(new URL('../src/67-linkshell.js', import.meta.url), 'utf8').replace("'__TRACKER_API__'", "'https://tracker.example.test'");
vm.runInContext(src, ctx);
const L = AE.linkshell, X = L._test;

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok', name); };

// ---- keys for a fake link
const pc = await X.newKeys(), phone = await X.newKeys();
const LINK = '0123456789abcdef0123456789abcdef';
const phoneKey = await X.linkKey(phone.priv, pc.pub, LINK);   // what Linkpearl derives
const pcKey = await X.linkKey(pc.priv, phone.pub, LINK);
const linkRec = { linkId: LINK, token: 'tok-test', store: 900, priv: pc.priv, pub: pc.pub, phonePub: phone.pub, phoneName: 'Test phone', at: 0 };
const fromPhone = async (id, kind, body) => ({ t: 'msg', id, kind, ...(await X.seal(phoneKey, LINK, 'phone', id, kind, body)) });

await test('check code is the Worker\'s, and both ends get the same code', async () => {
  const code = await X.checkCode(pc.pub, phone.pub);
  assert.match(code, /^[A-HJ-NP-Z2-9]{3} [A-HJ-NP-Z2-9]{3}$/);
  assert.equal(code, await workerCheckCode(pc.pub, phone.pub));
  assert.notEqual(code, await X.checkCode(phone.pub, pc.pub)); // order matters: PC first
});

await test('sealed on one end opens on the other; the envelope is bound to the message', async () => {
  const s = await X.seal(pcKey, LINK, 'pc', 'id-00000001', 'pullbacks.run', { a: 1 });
  assert.deepEqual(await X.unseal(phoneKey, LINK, 'pc', 'id-00000001', 'pullbacks.run', s.iv, s.ct), { a: 1 });
  for (const [from, id, kind] of [['phone', 'id-00000001', 'pullbacks.run'], ['pc', 'id-00000002', 'pullbacks.run'], ['pc', 'id-00000001', 'pullbacks.scan']])
    await assert.rejects(X.unseal(phoneKey, LINK, from, id, kind, s.iv, s.ct));
  const other = await X.newKeys();
  await assert.rejects(X.unseal(await X.linkKey(other.priv, pc.pub, LINK), LINK, 'pc', 'id-00000001', 'pullbacks.run', s.iv, s.ct));
  assert.ok(!('d' in pc.pub) && pc.priv.d);
});

await test('QR code: the pairing payload fits version 5 (37 modules) with finders and timing in place', async () => {
  const m = X.qr.make('LS1.900.' + LINK + '.' + 'A'.repeat(22));
  assert.equal(m.length, 37);
  const finder = (x0, y0) => { for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) { const d = Math.max(Math.abs(x - 3), Math.abs(y - 3)); assert.equal(m[y0 + y][x0 + x], d !== 2, 'finder ' + x0 + ',' + y0); } };
  finder(0, 0); finder(30, 0); finder(0, 30);
  for (let i = 8; i < 29; i++) { assert.equal(m[6][i], i % 2 === 0); assert.equal(m[i][6], i % 2 === 0); }
  assert.equal(m[29][8], true); // the dark module
  assert.throws(() => X.qr.make('x'.repeat(300)));
  assert.match(X.qr.svg('LS1.900.x', 100), /^<svg [^>]*viewBox="0 0 29 29"/);
});

await test('not linked: no socket', async () => {
  L.wake(true);
  assert.equal(sockets.length, 0);
  assert.equal(L.linked(), null);
});

gm.set('ae_linkshell', linkRec);
let ws;
await test('linked: connects with the link token in the protocol, sends what waited in the outbox', async () => {
  const id = L.send('pullbacks.run', { items: 2 });
  assert.equal(sockets.length, 1);
  ws = sockets[0];
  assert.equal(ws.url, 'wss://tracker.example.test/v1/linkshell/connect?link=' + LINK);
  assert.deepEqual(ws.protocols, ['linkshell', 'pc.tok-test']);
  ws.open(); await settle();
  assert.equal(L.state().online, true);
  const f = ws.frames();
  assert.equal(f.length, 1);
  assert.equal(f[0].id, id);
  assert.equal(f[0].kind, 'pullbacks.run');
  assert.deepEqual(await X.unseal(phoneKey, LINK, 'pc', f[0].id, f[0].kind, f[0].iv, f[0].ct), { items: 2 });
  ws.push({ t: 'hello', peer: true, seen: null }); await settle();
  assert.equal(L.state().peer, true);
  assert.equal(ws.frames().length, 2, 'hello resends what is not acked yet');
  ws.push({ t: 'ack', ids: [id] }); await settle();
  assert.deepEqual(gm.get('ae_linkshell_out'), []);
});

await test('a phone message is applied once and acked every time; one that does not open is dropped (and acked)', async () => {
  const got = [];
  L.on('pullbacks.scan', (body, meta) => { got.push([body, meta.id]); });
  ws.sent.length = 0;
  const m = await fromPhone('scan-0000001', 'pullbacks.scan', { serial: 'S-1' });
  ws.push(m); await settle();
  ws.push(m); await settle();
  assert.deepEqual(got, [[{ serial: 'S-1' }, 'scan-0000001']]);
  const bad = { ...(await fromPhone('scan-0000002', 'pullbacks.scan', { serial: 'S-2' })), kind: 'pullbacks.skip' };
  ws.push(bad); await settle();
  assert.equal(got.length, 1);
  assert.deepEqual(ws.frames().map((f) => f.ids), [['scan-0000001'], ['scan-0000001'], ['scan-0000002']]);
  ws.push('pong'); ws.push('not json'); await settle();
});

await test('ping every 50 s without counting as use; closes after 5 minutes idle and waits for the next use', async () => {
  ws.sent.length = 0;
  await advance(4 * 60 * 1000);
  assert.ok(ws.sent.includes('ping'));
  ws.push('pong'); await settle();
  await advance(61 * 1000);
  assert.equal(ws.closedWith, 1000);
  assert.equal(L.state().online, false);
  await advance(10 * 60 * 1000);
  assert.equal(sockets.length, 1, 'no reconnect without use');
  L.wake();
  assert.equal(sockets.length, 2);
  ws = sockets[1]; ws.open(); await settle();
});

await test('dropped connection retries with backoff; replaced (4000) does not', async () => {
  ws.drop(1006); await settle();
  await advance(2000);
  assert.equal(sockets.length, 3);
  ws = sockets[2]; ws.open(); await settle();
  ws.drop(4000); await settle();
  await advance(120 * 1000);
  assert.equal(sockets.length, 3);
  assert.ok(L.linked());
});

await test('unlinked elsewhere (4001): the link, its key and the outbox are forgotten', async () => {
  L.wake(true); ws = sockets[3]; ws.open(); await settle();
  gm.set('ae_linkshell_out', [{ id: 'x-00000001', kind: 'a.b', body: {}, at: now }]);
  ws.drop(4001); await settle();
  assert.equal(L.linked(), null);
  assert.equal(gm.has('ae_linkshell'), false);
  assert.deepEqual(gm.get('ae_linkshell_out'), []);
  L.wake(true);
  assert.equal(sockets.length, 4);
});

console.log(n + ' Linkshell tests passed');
