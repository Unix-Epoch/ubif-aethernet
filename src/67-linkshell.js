/*
  Linkshell — a link between this browser and one Linkpearl phone.

  Pairing: Linkshell in the avatar menu shows a QR code ("LS1.<store>.<pairId>.<code>", 5 minutes). Linkpearl scans it and sends its
  public key; both ends show the same check code (from the two public keys), and Link here finishes it. The tracker Worker keeps
  only a hash of this browser's link token (tracker-worker/src/linkshell.js).
  This browser also makes a pairing secret that is never in the QR code; the Worker asks for it on every later pairing call from
  here, so a copy of the QR code alone can't finish or cancel the pairing.
  The link is kept in Tampermonkey's storage (ae_linkshell), not a Portal cookie, so script updates, Portal sign-outs and clearing
  Portal's site data don't undo it. Unlink here, Unlink on the phone, removing the phone on the admin site, or 30 days unused ends it.

  Messages are sealed end to end: ECDH (P-256) between this browser's key and the phone's, HKDF-SHA256 (salt "linkshell|<linkId>",
  info "linkshell v1") to an AES-256-GCM key; additional data "<linkId>|<from>|<id>|<kind>" (from = pc or phone). The relay sees
  the kind and the sealed bytes only. Body = JSON.

  Connection: a WebSocket to the link's relay (/v1/linkshell/connect, credential in Sec-WebSocket-Protocol). The tab in use holds
  it: a tab connects when someone is using it, and a newer tab's socket replaces an older one's. It closes after 5 minutes without
  messages and opens again on the next keypress, click or return to the tab, so the phone can reach this browser while it is in
  use. Messages for a closed end wait on the relay (24 hours).
  Hold: a shard whose run lives in this tab's memory (a morning check, a buyback or pullback scan) holds the connection for as
  long as the run lasts (AE.linkshell.hold). Other tabs then leave the socket alone, however much they are used, and this tab's
  stays open past the idle time. One tab holds at a time: a newer hold takes over and the older run is told (onLost). A hold whose
  tab is gone goes stale after 90 seconds (ae_linkshell_hold).
  Delivery: every send goes to an outbox (ae_linkshell_out) and stays there until the phone acknowledges it; it is sent again on
  every connect. Received ids are remembered (ae_linkshell_seen), so a resend is never applied twice.
  Size: the relay closes a socket that sends a frame over 16,384 characters (code 1009). A message that would be larger is never
  queued or sent (console.error instead), and a list goes out in parts that each fit (sendParts).

  For other shards:
    AE.linkshell.linked()             → { linkId, store, phoneName } | null
    AE.linkshell.state()              → { linked, online, peer, seen }  (online: this browser is connected; peer: the phone is)
    AE.linkshell.on(kind, fn)         fn(body, { id, kind }) for each new message of that kind; one handler per kind
    AE.linkshell.send(kind, body, { wake })  queue a sealed message for the phone (returns its id); wake: true also pushes a
                                      notification to the phone, for a message that asks it to start something
    AE.linkshell.sendParts(kind, base, rows, { size, key, wake })  a list in parts: each body is base + { part, parts, [key]: rows }
                                      (key: 'items' unless given), at most `size` rows a part and fewer when a part would not fit
                                      a frame; base may be a function of the part's number; wake goes on the first part only
    AE.linkshell.paused()             → Promise of '' or why this page must not act on a phone's message now (Aethernet stopped on
                                      the page, or Portal switched stores); a shard checks it before every write a phone asks for
    AE.linkshell.onState(fn)          fn(state) on every change; returns an unsubscribe function
    AE.linkshell.wake()               connect now if linked (a shard that is about to need the phone)
    AE.linkshell.hold(onLost)         keep the connection in this tab for a run; returns the release function. onLost() runs if
                                      another tab starts a run of its own
    AE.linkshell.open()               the Linkshell dialog (link a phone, or the linked phone)
*/
AE.linkshell = (() => {
  const API = '__TRACKER_API__', KEY = '__WAYMARK_KEY__';
  const LINK_KEY = 'ae_linkshell', OUT_KEY = 'ae_linkshell_out', SEEN_KEY = 'ae_linkshell_seen', HOLD_KEY = 'ae_linkshell_hold';
  const IDLE_MS = 5 * 60 * 1000, HOLD_MS = 24 * 3600 * 1000, SEEN_MAX = 400;
  const MAX_FRAME = 16384; // the relay's limit for one frame (LS.MAX_FRAME in tracker-worker/src/linkshell.js)
  const BEAT_MS = 20000, STALE_MS = 90000; // a hold is written again every 20 s; 90 s allows for a background tab's slowed timers
  const configured = () => /^(https:\/\/|http:\/\/localhost[:/])/.test(API);

  // ---------------------------------------------------------------- crypto
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = (u8) => btoa(String.fromCharCode(...new Uint8Array(u8)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const b64u = (u8) => b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const newId = () => b64u(crypto.getRandomValues(new Uint8Array(16)));
  const pub = (j) => ({ kty: 'EC', crv: 'P-256', x: j.x, y: j.y });
  async function newKeys() {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const priv = await crypto.subtle.exportKey('jwk', kp.privateKey);
    return { priv: { kty: priv.kty, crv: priv.crv, x: priv.x, y: priv.y, d: priv.d }, pub: pub(priv) };
  }
  async function linkKey(privJwk, peerJwk, linkId) {
    const priv = await crypto.subtle.importKey('jwk', privJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const peer = await crypto.subtle.importKey('jwk', pub(peerJwk), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, priv, 256);
    const ikm = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('linkshell|' + linkId), info: enc.encode('linkshell v1') }, ikm,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  const aad = (linkId, from, id, kind) => enc.encode(linkId + '|' + from + '|' + id + '|' + kind);
  async function seal(key, linkId, from, id, kind, body) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(linkId, from, id, kind) }, key, enc.encode(JSON.stringify(body == null ? {} : body)));
    return { iv: b64(iv), ct: b64(ct) };
  }
  async function unseal(key, linkId, from, id, kind, iv, ct) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: aad(linkId, from, id, kind) }, key, unb64(ct));
    return JSON.parse(dec.decode(pt));
  }
  // The check code both ends show (same rule as the Worker's checkCode and Linkpearl's).
  const CHECK_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  async function checkCode(pcJwk, phoneJwk) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(pcJwk.x + '.' + pcJwk.y + '|' + phoneJwk.x + '.' + phoneJwk.y)));
    let s = '';
    for (let i = 0; i < 6; i++) s += CHECK_ABC[d[i] & 31];
    return s.slice(0, 3) + ' ' + s.slice(3);
  }

  // ---------------------------------------------------------------- the link (Tampermonkey storage)
  const getLink = () => { try { const l = GM_getValue(LINK_KEY, null); return l && l.linkId && l.token && l.priv && l.phonePub ? l : null; } catch (_) { return null; } };
  const setLink = (l) => { try { if (l) GM_setValue(LINK_KEY, l); else GM_deleteValue(LINK_KEY); } catch (_) {} };
  const outbox = () => { try { const o = GM_getValue(OUT_KEY, []); return Array.isArray(o) ? o.filter((m) => Date.now() - m.at < HOLD_MS) : []; } catch (_) { return []; } };
  const setOutbox = (o) => { try { GM_setValue(OUT_KEY, o); } catch (_) {} };
  const seenIds = () => { try { const s = GM_getValue(SEEN_KEY, []); return Array.isArray(s) ? s : []; } catch (_) { return []; } };
  const remember = (id) => { const s = seenIds(); s.push(id); try { GM_setValue(SEEN_KEY, s.slice(-SEEN_MAX)); } catch (_) {} };

  let keyCache = null; // { linkId, key }
  async function keyOf(l) {
    if (!keyCache || keyCache.linkId !== l.linkId) keyCache = { linkId: l.linkId, key: await linkKey(l.priv, l.phonePub, l.linkId) };
    return keyCache.key;
  }

  async function call(path, body) {
    return AE.workerCall('POST', API + path, { credentials: 'omit', headers: { 'content-type': 'application/json', 'x-aethernet-key': KEY }, body: JSON.stringify(body || {}) });
  }

  // ---------------------------------------------------------------- state
  const st = { online: false, peer: false, seen: null };
  const stateListeners = new Set(), handlers = new Map();
  const state = () => ({ linked: !!getLink(), online: st.online, peer: st.peer, seen: st.seen });
  const changed = () => { const s = state(); for (const fn of [...stateListeners]) { try { fn(s); } catch (e) { console.error('[Linkshell]', e); } } };
  const onState = (fn) => { stateListeners.add(fn); return () => stateListeners.delete(fn); };
  const on = (kind, fn) => { handlers.set(kind, fn); };

  // ---------------------------------------------------------------- the socket
  let ws = null, idleTimer = null, retryTimer = null, retryMs = 2000, lastWake = 0;
  let sentIds = new Set(); // outbox messages sent on the socket that is open now
  const idle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { if (holding) return idle(); if (ws) ws.close(1000, 'idle'); }, IDLE_MS); };

  // ---------------------------------------------------------------- the hold (see top)
  const TAB = newId();
  let holding = null; // { timer, onLost } while a run in this tab holds the connection
  const heldElsewhere = () => { try { const h = GM_getValue(HOLD_KEY, null); return !!(h && h.tab && h.tab !== TAB && Date.now() - h.at < STALE_MS); } catch (_) { return false; } };
  const beat = () => { try { GM_setValue(HOLD_KEY, { tab: TAB, at: Date.now() }); } catch (_) {} };
  function release() {
    if (!holding) return;
    clearInterval(holding.timer); holding = null;
    try { const h = GM_getValue(HOLD_KEY, null); if (h && h.tab === TAB) GM_deleteValue(HOLD_KEY); } catch (_) {}
    if (ws) idle();
  }
  function hold(onLost) {
    release();
    beat();
    const timer = setInterval(() => {
      if (!holding || holding.timer !== timer) return;
      if (!heldElsewhere()) return beat();
      clearInterval(timer); holding = null; // another tab started a run: it has the phone now
      if (ws) idle();
      if (typeof onLost === 'function') { try { onLost(); } catch (e) { console.error('[Linkshell]', e); } }
    }, BEAT_MS);
    holding = { timer, onLost };
    if (!ws) { lastWake = Date.now(); connect(); }
    return release;
  }
  function connect() {
    const l = getLink();
    if (!l || ws || !configured() || typeof WebSocket === 'undefined') return;
    clearTimeout(retryTimer);
    const url = API.replace(/^http/, 'ws') + '/v1/linkshell/connect?link=' + l.linkId;
    let sock;
    try { sock = new WebSocket(url, ['linkshell', 'pc.' + l.token]); } catch (_) { return; }
    ws = sock; sentIds = new Set();
    let ping = null;
    sock.onopen = () => {
      retryMs = 2000; st.online = true; changed(); idle(); flush();
      ping = setInterval(() => { if (sock.readyState === 1) sock.send('ping'); }, 50000); // keeps networks from dropping a quiet socket; answered without waking the relay
    };
    sock.onmessage = (e) => { if (e.data === 'pong') return; idle(); receive(String(e.data)).catch((err) => console.error('[Linkshell]', err)); };
    sock.onclose = (e) => {
      clearInterval(ping);
      if (ws !== sock) return; // an old socket (already forgotten or replaced here)
      ws = null;
      clearTimeout(idleTimer);
      st.online = false; st.peer = false; changed();
      if (e.code === 4001) { forget(); return; }        // unlinked on the phone or the admin site
      if (e.code === 4000 && holding) { beat(); retryTimer = setTimeout(connect, 1000); return; } // taken from a run: taken back
      if (e.code === 4000) return;                       // another tab took over; this one waits until it's used again
      if (e.code === 1000) return;                       // idle: waits for the next wake
      if (e.code === 1009) dropLargest();                // the relay refused a frame as too large: that message is never sent again
      if (getLink()) { retryTimer = setTimeout(connect, retryMs); retryMs = Math.min(retryMs * 2, 60000); }
    };
  }
  // Someone is using this tab: (re)connect, at most every few seconds.
  function wake(force) {
    if (!getLink() || ws) return;
    if (heldElsewhere()) return; // another tab's run has the phone
    if (!force && (document.visibilityState === 'hidden' || Date.now() - lastWake < 3000)) return;
    lastWake = Date.now();
    connect();
  }
  function forget() {
    setLink(null); setOutbox([]); keyCache = null;
    release();
    if (ws) { const s = ws; ws = null; try { s.close(1000, 'unlinked'); } catch (_) {} }
    st.online = false; st.peer = false; changed();
  }

  // A frame's length, known before sealing: the envelope plus the sealed body in base64 (AES-GCM adds a 16-byte tag).
  const frame = (m, s) => Object.assign({ t: 'msg', id: m.id, kind: m.kind, iv: s.iv, ct: s.ct }, m.wake ? { wake: true } : {});
  const frameLen = (m) => JSON.stringify(frame(m, { iv: 'A'.repeat(16), ct: '' })).length
    + 4 * Math.ceil((enc.encode(JSON.stringify(m.body == null ? {} : m.body)).length + 16) / 3);
  function tooBig(m) {
    const n = frameLen(m);
    if (n <= MAX_FRAME) return false;
    console.error('[Linkshell] ' + m.kind + ' not sent: its frame would be ' + n + ' characters, over the relay\'s ' + MAX_FRAME);
    return true;
  }
  const post = (m, s) => { if (ws && ws.readyState === 1) { sentIds.add(m.id); ws.send(JSON.stringify(frame(m, s))); } };
  // After a 1009 close: the largest message sent on that socket goes, so the next connect can't be closed for it again.
  function dropLargest() {
    const o = outbox(), sent = o.filter((m) => sentIds.has(m.id));
    if (!sent.length) return;
    const worst = sent.reduce((a, b) => (frameLen(b) > frameLen(a) ? b : a));
    console.error('[Linkshell] ' + worst.kind + ' dropped: the relay closed the connection for a frame that was too large');
    setOutbox(o.filter((m) => m.id !== worst.id));
  }
  async function flush() {
    const l = getLink();
    if (!l || !ws || ws.readyState !== 1) return;
    const key = await keyOf(l);
    const all = outbox(), fits = all.filter((m) => !tooBig(m)); // one queued before this limit was checked would close the socket on every connect
    if (fits.length !== all.length) setOutbox(fits);
    for (const m of fits) {
      if (!ws || ws.readyState !== 1) return;
      post(m, await seal(key, l.linkId, 'pc', m.id, m.kind, m.body));
    }
  }
  // → the message's id, or null when it is too large to send (logged, not queued).
  function send(kind, body, opts) {
    const id = newId(), m = { id, kind, body, at: Date.now() };
    if (opts && opts.wake) m.wake = true;
    if (tooBig(m)) return null;
    const o = outbox(); o.push(m); setOutbox(o);
    if (ws && ws.readyState === 1) {
      idle();
      const l = getLink();
      if (l) keyOf(l).then((key) => seal(key, l.linkId, 'pc', id, kind, body)).then((s) => post(m, s))
        .catch((e) => console.error('[Linkshell]', e));
    } else wake(true);
    return id;
  }
  // A list in numbered parts (see top). The parts are cut by row count first, as each caller always did, and shorter where a part
  // would not fit a frame; a single row too large for a frame is left to send(), which drops it.
  function sendParts(kind, base, rows, opts) {
    const o = opts || {}, key = o.key || 'items', size = o.size || 40;
    const body = (p, parts, chunk) => Object.assign({}, typeof base === 'function' ? base(p) : base, { part: p, parts, [key]: chunk });
    const fits = (p, chunk) => frameLen({ id: 'A'.repeat(22), kind, wake: true, body: body(p, rows.length, chunk) }) <= MAX_FRAME;
    const chunks = [[]];
    for (const row of rows) {
      let cur = chunks[chunks.length - 1];
      if (cur.length && (cur.length >= size || !fits(chunks.length - 1, cur.concat([row])))) chunks.push(cur = []);
      cur.push(row);
    }
    return chunks.map((chunk, p) => send(kind, body(p, chunks.length, chunk), { wake: !!o.wake && p === 0 }));
  }
  // '' when this page may act on a phone's message, else why not (see top). Asked fresh each time: the store can change in any tab.
  async function paused() {
    try { if (AE.halted() || AE.storeChanged() || !(await AE.sameStore(true))) return 'Aethernet is paused on the PC'; }
    catch (_) { return 'The PC couldn\'t check its store in Portal'; }
    return '';
  }
  const busy = new Set(); // ids being opened or handled right now
  async function receive(text) {
    let f;
    try { f = JSON.parse(text); } catch (_) { return; }
    if (f.t === 'hello' || f.t === 'presence') { st.peer = !!f.peer; st.seen = f.seen || st.seen; changed(); if (f.t === 'hello') flush(); return; }
    if (f.t === 'ack' && Array.isArray(f.ids)) { const gone = new Set(f.ids); setOutbox(outbox().filter((m) => !gone.has(m.id))); return; }
    if (f.t !== 'msg') return;
    const l = getLink();
    if (!l) return;
    const ack = () => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'ack', ids: [f.id] })); };
    if (seenIds().includes(f.id)) return ack();
    if (busy.has(f.id)) return; // a second copy while the first is still being opened or handled: acked when that one is done
    busy.add(f.id);
    try {
      let body;
      try { body = await unseal(await keyOf(l), l.linkId, 'phone', f.id, f.kind, f.iv, f.ct); } catch (_) { return ack(); } // not ours to read: dropped
      remember(f.id);
      const fn = handlers.get(f.kind);
      if (fn) { try { await fn(body, { id: f.id, kind: f.kind }); } catch (e) { console.error('[Linkshell]', e); } }
      ack();
    } finally { busy.delete(f.id); }
  }

  // ---------------------------------------------------------------- QR code (byte mode, error correction M, versions 1–10)
  const qr = (() => {
    // [data codewords per block…] and EC codewords per block, for level M
    const BLOCKS = [null, [[16], 10], [[28], 16], [[44], 26], [[32, 32], 18], [[43, 43], 24], [[27, 27, 27, 27], 16], [[31, 31, 31, 31], 18],
      [[38, 38, 39, 39], 22], [[36, 36, 36, 37, 37], 22], [[43, 43, 43, 43, 44], 26]];
    const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
    const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
    for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
    const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
    function rs(data, n) {
      let gen = [1];
      for (let i = 0; i < n; i++) { const next = new Array(gen.length + 1).fill(0); gen.forEach((g, j) => { next[j] ^= g; next[j + 1] ^= mul(g, EXP[i]); }); gen = next; }
      const out = new Array(n).fill(0);
      for (const b of data) { const f = b ^ out.shift(); out.push(0); for (let i = 0; i < n; i++) out[i] ^= mul(gen[i + 1], f); }
      return out;
    }
    function make(text) {
      const bytes = [...enc.encode(text)];
      let v = 1;
      while (v <= 10 && BLOCKS[v][0].reduce((a, b) => a + b, 0) < bytes.length + 2 + (v >= 10 ? 1 : 0)) v++;
      if (v > 10) throw new Error('too long for a QR code');
      const [blocks, ecn] = BLOCKS[v], cap = blocks.reduce((a, b) => a + b, 0);
      const bits = [];
      const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
      put(4, 4); put(bytes.length, v >= 10 ? 16 : 8); bytes.forEach((b) => put(b, 8));
      put(0, Math.min(4, cap * 8 - bits.length));
      while (bits.length % 8) bits.push(0);
      const data = [];
      for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
      for (let p = 0; data.length < cap; p++) data.push(p % 2 ? 0x11 : 0xec);
      const dBlocks = [], eBlocks = [];
      let k = 0;
      for (const n of blocks) { const d = data.slice(k, k + n); k += n; dBlocks.push(d); eBlocks.push(rs(d, ecn)); }
      const seq = [];
      for (let i = 0; i < Math.max(...blocks); i++) for (const d of dBlocks) if (i < d.length) seq.push(d[i]);
      for (let i = 0; i < ecn; i++) for (const e of eBlocks) seq.push(e[i]);

      const size = 17 + 4 * v;
      const grid = () => Array.from({ length: size }, () => new Array(size).fill(false));
      const mod = grid(), fn = grid();
      const set = (x, y, d) => { mod[y][x] = d; fn[y][x] = true; };
      for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
      const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const x = cx + dx, y = cy + dy; if (x < 0 || y < 0 || x >= size || y >= size) continue; const d = Math.max(Math.abs(dx), Math.abs(dy)); set(x, y, d !== 2 && d !== 4); } };
      finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
      const al = ALIGN[v];
      for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
      const format = (mask) => {
        const d = (0 << 3) | mask; let r = d;
        for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
        const b = ((d << 10) | r) ^ 0x5412, bit = (i) => ((b >>> i) & 1) === 1;
        for (let i = 0; i <= 5; i++) set(8, i, bit(i));
        set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
        for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
        for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
        for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
        set(8, size - 8, true);
      };
      format(0);
      if (v >= 7) {
        let r = v;
        for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
        const b = (v << 12) | r;
        for (let i = 0; i < 18; i++) { const d = ((b >>> i) & 1) === 1, a = size - 11 + (i % 3), c = Math.floor(i / 3); set(a, c, d); set(c, a, d); }
      }
      let i = 0;
      for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
          const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
          if (!fn[y][x] && i < seq.length * 8) { mod[y][x] = ((seq[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
        }
      }
      const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
        (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
        (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];
      const apply = (m) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[m](x, y)) mod[y][x] = !mod[y][x]; };
      const penalty = () => {
        let p = 0, dark = 0;
        const line = (get) => {
          for (let a = 0; a < size; a++) {
            let run = 1;
            for (let b = 1; b <= size; b++) {
              if (b < size && get(a, b) === get(a, b - 1)) { run++; continue; }
              if (run >= 5) p += run - 2;
              run = 1;
            }
            for (let b = 0; b + 10 < size; b++) {
              const s = Array.from({ length: 11 }, (_, k) => get(a, b + k)).map((d) => (d ? 1 : 0)).join('');
              if (s === '10111010000' || s === '00001011101') p += 40;
            }
          }
        };
        line((a, b) => mod[a][b]); line((a, b) => mod[b][a]);
        for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const c = mod[y][x]; if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) p += 3; }
        for (const row of mod) for (const d of row) if (d) dark++;
        return p + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
      };
      let best = 0, bestP = Infinity;
      for (let m = 0; m < 8; m++) { apply(m); format(m); const p = penalty(); if (p < bestP) { bestP = p; best = m; } apply(m); }
      apply(best); format(best);
      return mod;
    }
    // An SVG of the code with a 4-module quiet zone.
    function svg(text, px) {
      const m = make(text), n = m.length, q = 4, all = n + 2 * q;
      let d = '';
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) d += 'M' + (x + q) + ' ' + (y + q) + 'h1v1h-1z';
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + all + ' ' + all + '" width="' + px + '" height="' + px + '" shape-rendering="crispEdges" role="img" aria-label="QR code">'
        + '<rect width="' + all + '" height="' + all + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
    }
    return { make, svg };
  })();

  // ---------------------------------------------------------------- the dialog
  const DLG = 'ae-linkshell';
  const pcName = () => {
    const ua = navigator.userAgent || '';
    const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    const o = /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : '';
    return o ? b + ' · ' + o : b;
  };
  const seenText = (t) => (t ? 'Seen ' + new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');

  function open() {
    if (document.getElementById(DLG)) return;
    AE.track('linkshell');
    AE.confirm.css();
    document.head.append(AE.h('style', { id: DLG + '-css' }, `
      #${DLG} .sg-confirm { width:min(400px, 100%); }
      #${DLG} .qr { width:184px; height:184px; margin:4px auto 10px; line-height:0; }
      #${DLG} .qr svg { width:100%; height:100%; border-radius:8px; }
      #${DLG} .ctr { text-align:center; margin-bottom:16px; }
      #${DLG} .dev { display:flex; align-items:center; gap:12px; margin:4px 0 16px; }
      #${DLG} .dev .pic { width:36px; height:36px; flex:none; border-radius:22%; display:grid; place-items:center; font-weight:700; font-size:13px;
        background:var(--aui-primary-soft, #faecff); color:var(--aui-on-primary-soft, #590099); box-shadow:var(--ae-icon-ring); }
      #${DLG} .dev .g { flex:1; min-width:0; } #${DLG} .dev .g b { display:block; }
      #${DLG} .st { height:24px; padding:0 10px; border-radius:12px; font-size:12px; font-weight:700; display:inline-flex; align-items:center;
        background:var(--aui-neutral-soft, #f1f0f4); color:var(--aui-on-surface-soft, #5d5e61); }
      #${DLG} .st.ok { background:var(--aui-status-success-soft, #c5ffc8); color:var(--aui-status-success, #136d31); }
      #${DLG} .code { font:700 28px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing:4px; text-align:center; color:var(--aui-primary, #8223d2); margin:0 0 18px; }
      #${DLG} .err { color:var(--aui-status-error, #b91a24); font-weight:700; margin:0 0 14px; text-align:center; }
    `));
    const { h } = AE;
    const body = h('div'), acts = h('div', { class: 'sg-actions' });
    const card = h('div', { class: 'sg sg-card sg-confirm', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Linkshell' }, h('h2', { class: 'ae-head' }, 'Linkshell'), body, acts);
    const scrim = h('div', { class: 'sg sg-confirm-scrim', id: DLG, onclick: (e) => { if (e.target === scrim) close(); } }, card);
    let pair = null, timer = null, stopState = null, gone = false;
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    function close() {
      gone = true; clearInterval(timer); if (stopState) stopState();
      if (pair && !pair.done) call('/v1/' + pair.store + '/linkshell/pair/cancel', { pairId: pair.pairId, code: pair.code, secret: pair.secret }).catch(() => {});
      scrim.remove(); document.removeEventListener('keydown', onKey, true);
    }
    const btn = (label, onclick, primary) => h('button', { type: 'button', class: 'sg-btn sg-lg' + (primary ? ' sg-primary' : ''), onclick }, label);
    const paint = (kids, buttons) => { body.replaceChildren(...kids); acts.replaceChildren(...buttons); };
    const device = (sub, chip) => h('div', { class: 'dev' }, h('span', { class: 'pic' }, 'LP'), h('div', { class: 'g' }, h('b', null, sub.name), sub.line ? h('div', { class: 'sg-soft' }, sub.line) : null), chip || null);

    function showLinked() {
      const l = getLink();
      if (!l) return showPair();
      const draw = (s) => {
        if (gone) return;
        const chip = s.peer ? h('span', { class: 'st ok' }, 'Connected') : h('span', { class: 'st' }, 'Away');
        paint([device({ name: l.phoneName, line: s.peer ? '' : seenText(s.seen) }, chip)],
          [btn('Unlink', () => unlink()), btn('Done', () => close(), true)]);
      };
      if (stopState) stopState();
      stopState = onState(draw);
      draw(state());
      wake(true);
    }
    async function unlink() {
      const l = getLink();
      if (l) { try { await call('/v1/' + l.store + '/linkshell/unlink', { linkId: l.linkId, token: l.token }); } catch (_) {} }
      forget();
      close();
    }
    async function showPair(error) {
      clearInterval(timer);
      paint([h('div', { class: 'qr' }), h('div', { class: 'ctr sg-clock' }, '')], [btn('Cancel', () => close())]);
      let me = null;
      try { me = await AE.profile(); } catch (_) {}
      const store = me && me.storeId != null ? Number(me.storeId) : null;
      if (gone) return;
      if (!store || !configured()) return paint([h('div', { class: 'err' }, 'Couldn\'t start linking')], [btn('Close', () => close())]);
      try {
        const keys = await newKeys(), secret = newId(); // the secret stays here: it is what shows a later call is from this browser
        const r = await call('/v1/' + store + '/linkshell/pair/start', { publicJwk: keys.pub, name: pcName(), secret });
        pair = { store, keys, secret, pairId: r.pairId, code: r.code, expires: Date.parse(r.expiresAt), done: false };
      } catch (e) {
        return paint([h('div', { class: 'err' }, 'Couldn\'t start linking'), AE.bugLinkEl('Report a bug', 'Linkshell pairing: ' + ((e && e.message) || e))], [btn('Close', () => close())]);
      }
      if (gone) return;
      const clock = h('div', { class: 'ctr sg-clock' });
      paint([h('div', { class: 'qr', html: qr.svg('LS1.' + store + '.' + pair.pairId + '.' + pair.code, 184) }), clock, error ? h('div', { class: 'err' }, error) : null].filter(Boolean),
        [btn('Cancel', () => close())]);
      let polling = false;
      const tick = async () => {
        const left = pair.expires - Date.now();
        if (left <= 0) { clearInterval(timer); pair.done = true; return showPair(); }
        clock.textContent = Math.floor(left / 60000) + ':' + String(Math.floor(left / 1000) % 60).padStart(2, '0');
        if (polling) return;
        polling = true;
        try {
          const s = await call('/v1/' + store + '/linkshell/pair/status', { pairId: pair.pairId, code: pair.code, secret: pair.secret });
          if (!gone && s.state === 'scanned') { clearInterval(timer); showCheck(s); }
        } catch (_) {} finally { polling = false; }
      };
      timer = setInterval(tick, 1000); tick();
    }
    async function showCheck(s) {
      const code = await checkCode(pair.keys.pub, s.phoneJwk);
      if (gone) return;
      paint([device({ name: s.phoneName }), h('div', { class: 'code' }, code)], [btn('Cancel', () => close()), btn('Link', async (e) => {
        e.target.disabled = true;
        try {
          const r = await call('/v1/' + pair.store + '/linkshell/pair/finish', { pairId: pair.pairId, code: pair.code, secret: pair.secret });
          pair.done = true;
          setLink({ linkId: r.linkId, token: r.token, store: pair.store, priv: pair.keys.priv, pub: pair.keys.pub, phonePub: pub(s.phoneJwk), phoneName: r.phoneName || s.phoneName, at: Date.now() });
          setOutbox([]); keyCache = null;
          showLinked();
        } catch (err) {
          pair.done = true;
          showPair(err && err.status === 429 ? 'Too many links' : 'Couldn\'t link');
        }
      }, true)]);
    }

    document.addEventListener('keydown', onKey, true);
    document.body.append(scrim);
    if (getLink()) showLinked(); else showPair();
  }

  // Is the link still there? (checked once per page; unlinked elsewhere → forgotten here)
  async function verify() {
    const l = getLink();
    if (!l || !configured()) return;
    try {
      const r = await call('/v1/' + l.store + '/linkshell/link', { linkId: l.linkId, token: l.token });
      if (r.phoneName && r.phoneName !== l.phoneName) setLink(Object.assign(l, { phoneName: r.phoneName }));
    } catch (e) { if (e && e.status === 404) forget(); }
  }

  return { linked: () => { const l = getLink(); return l ? { linkId: l.linkId, store: l.store, phoneName: l.phoneName } : null; },
    state, onState, on, send, sendParts, paused, wake, hold, open, verify,
    _test: { seal, unseal, linkKey, newKeys, checkCode, qr, receive, flush, frameLen, MAX_FRAME } };
})();

AE.shard({
  id: 'linkshell',
  name: 'Linkshell',
  sites: ['portal.ubreakifix.net'],
  run() {
    const L = AE.linkshell;
    const MENU = 'option-aethernet-linkshell';
    const menuItem = () => AE.avatarItem({ testid: MENU, label: 'Linkshell', order: 35, icon: (s) => AE.actionIcon('linkshell', s) || AE.icon('aetheryte', s), onClick: () => L.open() });
    AE.every(400, menuItem);
    AE.onDom(menuItem);
    L.verify();
    // The tab in use holds the connection: wake on use, and when the tab comes back into view.
    const use = () => L.wake();
    for (const ev of ['keydown', 'pointerdown', 'focus']) window.addEventListener(ev, use, { capture: true, passive: true });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') L.wake(); });
    if (document.visibilityState === 'visible') L.wake(true);
  },
});
