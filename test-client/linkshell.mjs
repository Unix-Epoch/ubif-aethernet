// Linkshell (src/67-linkshell.js): the sealing and check code against the Worker's, the QR code's layout, and the socket's
// delivery rules (outbox until acked, each message applied once, unlink/replace/idle closes), the frame size limit, lists sent in
// parts, and the paused-page answer. Fake keys and data only.
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
const page = { halted: false, changed: null, same: true }; // what AE.halted / storeChanged / sameStore answer
const AE = {
  shard() {}, track() {},
  halted: () => page.halted, storeChanged: () => page.changed, sameStore: async (fresh) => { page.asked = fresh; if (page.same instanceof Error) throw page.same; return page.same; },
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

await test('wake: true rides on the frame (live and on resend) so the relay pushes the phone; plain sends carry no flag', async () => {
  ws.sent.length = 0;
  const a = L.send('pullbacks.run', { part: 0 }, { wake: true }), b = L.send('pullbacks.run', { part: 1 });
  await settle();
  assert.deepEqual(ws.frames().map((f) => [f.id, f.wake]), [[a, true], [b, undefined]]);
  ws.push({ t: 'hello', peer: false, seen: null }); await settle();
  assert.deepEqual(ws.frames().slice(2).map((f) => [f.id, f.wake]), [[a, true], [b, undefined]], 'resent with the flag');
  ws.push({ t: 'ack', ids: [a, b] }); await settle();
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

await test('two copies of a phone message arriving together are applied once', async () => {
  L.wake(true); ws = sockets[3]; ws.open(); await settle();
  let ran = 0;
  L.on('t.twice', async () => { ran++; await new Promise((r) => setTimeout(r, 5)); });
  const f = await fromPhone('twice-0000001', 't.twice', { a: 1 });
  ws.push(f); ws.push(f); // the phone flushes on open and again on hello
  await settle(); await settle();
  assert.equal(ran, 1);
  ws.push(f); await settle();
  assert.equal(ran, 1);
  assert.ok(ws.frames().filter((x) => x.t === 'ack' && x.ids[0] === 'twice-0000001').length >= 2);
});

await test('hold: a run keeps the socket here (no idle close, taken back after 4000); a run in another tab keeps this tab off it', async () => {
  let lost = 0;
  const release = L.hold(() => { lost++; });
  await advance(6 * 60 * 1000);
  assert.equal(ws.readyState, 1, 'still open past the idle time');
  ws.drop(4000); await settle();
  await advance(1000);
  assert.equal(sockets.length, 5, 'connected again');
  ws = sockets[4]; ws.open(); await settle();
  // another tab starts a run of its own
  gm.set('ae_linkshell_hold', { tab: 'another-tab', at: now });
  await advance(20000);
  assert.equal(lost, 1);
  ws.close(1000, 'idle'); await settle();
  gm.set('ae_linkshell_hold', { tab: 'another-tab', at: now });
  L.wake(true);
  assert.equal(sockets.length, 5, 'the other tab\'s run has the phone');
  await advance(91 * 1000); // that tab is gone: its hold goes stale
  L.wake(true);
  assert.equal(sockets.length, 6);
  ws = sockets[5]; ws.open(); await settle();
  const again = L.hold();
  again();
  assert.equal(gm.has('ae_linkshell_hold'), false);
  ws.close(1000, 'idle'); await settle();
});

await test('unlinked elsewhere (4001): the link, its key and the outbox are forgotten', async () => {
  L.wake(true); ws = sockets[6]; ws.open(); await settle();
  gm.set('ae_linkshell_out', [{ id: 'x-00000001', kind: 'a.b', body: {}, at: now }]);
  ws.drop(4001); await settle();
  assert.equal(L.linked(), null);
  assert.equal(gm.has('ae_linkshell'), false);
  assert.deepEqual(gm.get('ae_linkshell_out'), []);
  L.wake(true);
  assert.equal(sockets.length, 7);
});

// ---- size limit, parts, paused page
const errors = [];
const quiet = async (fn) => { const was = console.error; console.error = (...a) => errors.push(a.join(' ')); try { return await fn(); } finally { console.error = was; } };
const out = () => gm.get('ae_linkshell_out') || [];
const relink = async () => { gm.set('ae_linkshell', linkRec); gm.set('ae_linkshell_out', []); L.wake(true); ws = sockets.at(-1); ws.open(); await settle(); ws.sent.length = 0; };
const MAX = X.MAX_FRAME;

await test('a message whose frame would be over the relay\'s limit is never queued or sent; one just under it is', async () => {
  assert.equal(MAX, 16384);
  await relink();
  const big = await quiet(() => L.send('pullbacks.run', { text: 'x'.repeat(13000) }));
  assert.equal(big, null);
  assert.equal(errors.length, 1); assert.match(errors[0], /pullbacks\.run not sent/);
  const ok = L.send('pullbacks.run', { text: 'x'.repeat(12000) }, { wake: true });
  await settle();
  assert.deepEqual(out().map((m) => m.id), [ok]);
  assert.equal(ws.sent.length, 1);
  assert.equal(ws.sent[0].length, X.frameLen(out()[0]), 'the length worked out before sealing is the frame\'s');
  assert.ok(ws.sent[0].length <= MAX);
  // the edge: the largest body that fits, and one character more
  let fit = 12000; while (X.frameLen({ id: 'A'.repeat(22), kind: 'a.b', body: { t: 'x'.repeat(fit + 1) } }) <= MAX) fit++;
  assert.ok(L.send('a.b', { t: 'x'.repeat(fit) }));
  assert.equal(await quiet(() => L.send('a.b', { t: 'x'.repeat(fit + 1) })), null);
  await settle();
  assert.ok(ws.sent.every((d) => d.length <= MAX)); assert.equal(Math.max(...ws.sent.map((d) => d.length)) > MAX - 4, true);
});

await test('an oversized message already in the outbox is dropped on connect instead of being sent again', async () => {
  ws.close(1000, 'idle'); await settle();
  gm.set('ae_linkshell_out', [{ id: 'old-big-00000001', kind: 'pullbacks.run', body: { text: 'y'.repeat(20000) }, at: now }, { id: 'old-ok-000000001', kind: 'pullbacks.end', body: { run: 'r' }, at: now }]);
  errors.length = 0;
  await quiet(async () => { L.wake(true); ws = sockets.at(-1); ws.open(); await settle(); });
  assert.deepEqual(ws.frames().map((f) => f.id), ['old-ok-000000001']);
  assert.deepEqual(out().map((m) => m.id), ['old-ok-000000001']);
  assert.equal(errors.length, 1);
});

await test('closed for a frame too large (1009): the largest message sent on that socket is dropped, the rest go again', async () => {
  gm.set('ae_linkshell_out', [{ id: 'held-00000000001', kind: 'a.b', body: { t: 'z'.repeat(9000) }, at: now }]); // never sent on this socket: not blamed
  const small = L.send('a.b', { t: 1 }), large = L.send('a.b', { t: 'w'.repeat(5000) });
  await settle();
  const before = sockets.length;
  errors.length = 0;
  await quiet(async () => { ws.drop(1009); await settle(); });
  assert.deepEqual(out().map((m) => m.id), ['held-00000000001', small]);
  assert.ok(!out().some((m) => m.id === large)); assert.match(errors[0], /a\.b dropped/);
  await advance(2000);
  assert.equal(sockets.length, before + 1, 'connects again');
  ws = sockets.at(-1); ws.open(); await settle();
  assert.deepEqual(ws.frames().map((f) => f.id), ['held-00000000001', small]);
  // closed again: the next largest goes, so it cannot go round for ever
  await quiet(async () => { ws.drop(1009); await settle(); });
  assert.deepEqual(out().map((m) => m.id), [small]);
  await advance(4000); ws = sockets.at(-1); ws.open(); await settle();
  ws.push({ t: 'ack', ids: [small] }); await settle();
  assert.deepEqual(out(), []);
});

// What each caller built by hand before sendParts (45-buybacks, 66-pullbacks, 68-morning-check).
const byHand = (base, rows, size, key) => { const parts = Math.max(1, Math.ceil(rows.length / size)); return Array.from({ length: parts }, (_, p) => Object.assign({}, base(p), { part: p, parts, [key]: rows.slice(p * size, (p + 1) * size) })); };
await test('sendParts: the same bodies the callers built by hand, wake on the first part only', async () => {
  const pull = (n) => Array.from({ length: n }, (_, i) => [i, String(100000 + i), 'iPhone ' + i + ' Glass/LCD, Black (Non OEM)', 'SER-' + i, 'pending']);
  for (const n of [0, 1, 39, 40, 41, 95, 400]) {
    gm.set('ae_linkshell_out', []);
    const base = { run: 'r1', file: 'Pullback Serials.xlsx', store: '900' };
    const ids = L.sendParts('pullbacks.run', base, pull(n), { size: 40, wake: true });
    assert.deepEqual(out().map((m) => m.body), byHand(() => base, pull(n), 40, 'items'), n + ' rows');
    assert.deepEqual(out().map((m) => !!m.wake), out().map((_, p) => p === 0));
    assert.deepEqual(ids, out().map((m) => m.id));
    assert.deepEqual(Object.keys(out()[0].body), ['run', 'file', 'store', 'part', 'parts', 'items']);
  }
  gm.set('ae_linkshell_out', []);
  const bb = Array.from({ length: 45 }, (_, i) => [i, 'B-100000-' + String(i).padStart(10, '0'), 'Test Destination (TLC)', 'pending']);
  L.sendParts('buybacks.run', { run: 'b1', order: '0000000001', store: '900' }, bb, { size: 40 });
  assert.deepEqual(out().map((m) => m.body), byHand(() => ({ run: 'b1', order: '0000000001', store: '900' }), bb, 40, 'items'));
  assert.ok(out().every((m) => !m.wake));
  // morning check: its rows under "rows", 15 a part, the statuses on the first part only
  gm.set('ae_linkshell_out', []);
  const statuses = [[8, 'Ready for work', [9]], [9, 'Work in progress', []]];
  const mcBase = (p) => ({ run: 'c1', store: '900', bins: false, statuses: p === 0 ? statuses : [] });
  const wos = Array.from({ length: 31 }, (_, i) => [String(1000 + i), 8, 'B' + i, 'Blue case', 'Phone ' + i, 'Screen', 'Riley Price', 'Retail', 'u' + i]);
  L.sendParts('check.list', mcBase, wos, { size: 15, key: 'rows' });
  assert.deepEqual(out().map((m) => m.body), byHand(mcBase, wos, 15, 'rows'));
  assert.equal(out().length, 3); assert.deepEqual(out()[1].body.statuses, []);
  await settle(); ws.sent.length = 0;
});

await test('sendParts: rows too long for 40 to a frame go out in more, smaller parts, every frame under the limit', async () => {
  gm.set('ae_linkshell_out', []);
  const rows = Array.from({ length: 90 }, (_, i) => [i, String(100000 + i), 'Description ' + i + ' ' + 'é'.repeat(i % 3 ? 300 : 20), 'SER-' + i, 'pending']);
  errors.length = 0;
  const ids = await quiet(() => L.sendParts('pullbacks.run', { run: 'r2', file: 'f.xlsx', store: '900' }, rows, { size: 40, wake: true }));
  await settle();
  const o = out();
  assert.equal(errors.length, 0); assert.ok(ids.every(Boolean));
  assert.ok(o.length > 3, 'more parts than the row count alone gives');
  assert.deepEqual(o.flatMap((m) => m.body.items), rows, 'every row once, in order');
  assert.deepEqual(o.map((m) => [m.body.part, m.body.parts]), o.map((_, p) => [p, o.length]));
  assert.ok(o.every((m) => m.body.items.length <= 40 && m.body.items.length > 0));
  assert.equal(ws.sent.length, o.length);
  assert.ok(ws.sent.every((d) => d.length <= MAX));
  assert.ok(Math.max(...ws.sent.map((d) => d.length)) > MAX * 0.8, 'parts are filled, not cut short');
  ws.push({ t: 'ack', ids: o.map((m) => m.id) }); await settle();
});

await test('paused: a stopped page, a store switch, or a store that can\'t be checked all say why; otherwise empty', async () => {
  assert.equal(await L.paused(), ''); assert.equal(page.asked, true, 'asked fresh');
  page.halted = true; assert.equal(await L.paused(), 'Aethernet is paused on the PC'); page.halted = false;
  page.changed = { from: 'A', to: 'B' }; assert.equal(await L.paused(), 'Aethernet is paused on the PC'); page.changed = null;
  page.same = false; assert.equal(await L.paused(), 'Aethernet is paused on the PC');
  page.same = new Error('offline'); assert.match(await L.paused(), /couldn't check/);
  page.same = true; assert.equal(await L.paused(), '');
});

console.log(n + ' Linkshell tests passed');
