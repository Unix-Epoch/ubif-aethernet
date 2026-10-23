// Admin site: the work order tracker tabs (Work orders, Sales, People). A proof of concept UI.
// Served at /tracker-ui.js and loaded by page.js when one of those tabs opens. Keys are
// unlocked and customer data is opened only here, in the browser; the server never sees either.
import * as C from '/crypto.js';

const CSS = '.unlocked{padding:3px 10px;border-radius:999px;background:var(--ps);color:var(--p);font-weight:700;font-size:12px;cursor:pointer}'
  + '.srch{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.srch .qq{flex:1;min-width:280px;height:42px;font-size:15px;border-radius:999px;padding:0 18px}'
  + '.chk{display:inline-flex;gap:6px;align-items:center;font-size:13px;color:var(--soft)}.chk input{height:auto}'
  + '.res td{cursor:pointer}.res tr.sel td{background:var(--ps)}.hit{margin-top:3px;font-size:12px;color:var(--soft)}mark{background:#fff0a8;color:#1a1c1e;padding:0 2px;border-radius:3px}'
  + '.st{display:inline-flex;min-height:20px;align-items:center;padding:0 8px;border-radius:999px;font-size:11px;font-weight:700;background:var(--line);color:var(--fg)}'
  + '.st.rfp{background:#c5ffc8;color:#062011}.st.rfpi{background:#ffe1c2;color:#4a2300}.st.done{color:var(--soft)}.st.wait{background:#fff0c0;color:#3a3000}.st.wip{background:#eef1ff;color:#2f47c9}'
  + '.split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,520px);gap:14px;align-items:start}.drawer{position:sticky;top:76px;max-height:calc(100vh - 90px);overflow:auto}'
  + '.drawer h2{margin:0;font-size:20px}.kv{display:grid;grid-template-columns:110px 1fr;gap:4px 10px;font-size:13px;margin:0}.kv dt{color:var(--soft)}.kv dd{margin:0;overflow-wrap:anywhere}'
  + '.tl{width:100%}.nt{border-left:3px solid var(--p);padding:6px 10px;margin:6px 0;background:var(--bg);border-radius:0 8px 8px 0;font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere}.nt .by{font-size:11px;color:var(--soft);white-space:normal}'
  + '.dtabs{display:flex;gap:4px;margin:12px 0 6px;flex-wrap:wrap}.dtabs button{border:0;background:none;padding:6px 12px;border-radius:999px;color:var(--soft);font:inherit;font-size:13px;cursor:pointer}.dtabs button.on{background:var(--ps);color:var(--p);font-weight:700}'
  + '.lockcard{max-width:520px;margin:40px auto}.lockcard input{width:100%;height:42px;margin:6px 0}.lockcard .btn{width:100%;height:40px;margin-top:6px}'
  + '.scope{font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px}.scope.all{background:var(--ps);color:var(--p)}.scope.some{background:var(--line)}'
  + '.inv{border:1px dashed var(--p);border-radius:12px;padding:12px 14px;background:var(--ps);margin-top:10px}.inv code{font-size:18px;font-weight:700;color:var(--p)}'
  + '.rec{font:12px ui-monospace,Menlo,monospace;word-break:break-all;background:var(--bg);padding:8px;border-radius:8px}'
  + '.role{display:inline-flex;align-items:center;height:22px;padding:0 9px;border-radius:999px;font-size:11.5px;font-weight:700;background:var(--line);color:var(--soft);white-space:nowrap}'
  + '.role.owner{background:var(--p);color:#fff}.role.ol{background:var(--ps);color:var(--pt)}.role.mgr{background:#dbe8fb;color:#0d366b}.role.view{background:var(--line);color:var(--fg)}.role.custom{background:var(--warn);color:var(--warnf)}'
  + '@media (prefers-color-scheme:dark){.role.mgr{background:#13294a;color:#b7d3f6}}'
  + '.sc{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:6px;border:1px solid var(--line);font-size:11.5px;margin:0 3px 3px 0;white-space:nowrap}'
  + '.key{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:700}.key.no{color:var(--soft);font-weight:400}'
  + '.ppl td{vertical-align:top;padding:8px}.ppl tr.pick{cursor:pointer}.ppl tr.sel td{background:var(--ps)}'
  + '.seg{display:inline-flex;border:1px solid var(--line);border-radius:10px;overflow:hidden;flex-wrap:wrap}.seg button{border:0;border-right:1px solid var(--line);background:var(--card);color:var(--fg);font:inherit;font-size:13px;padding:8px 12px;cursor:pointer;text-align:left}.seg button:last-child{border-right:0}.seg button.on{background:var(--ps);color:var(--pt);font-weight:700}.seg button small{display:block;font-size:11px;color:var(--soft);font-weight:400}'
  + '.schips{display:flex;flex-wrap:wrap;gap:6px}.schip{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--fg);font:inherit;font-size:13px;cursor:pointer}.schip.on{background:var(--ps);border-color:var(--p);color:var(--pt);font-weight:700}'
  + '.lbl{font-size:12px;font-weight:700;margin:16px 0 6px;display:flex;align-items:center;gap:8px}.lbl .soft{font-weight:400}'
  + '.pages{display:grid;grid-template-columns:1fr 1fr;gap:2px 14px}.pg{display:flex;align-items:flex-start;gap:9px;padding:7px 4px;border-radius:8px;cursor:pointer}.pg:hover{background:var(--hd)}.pg input{margin:2px 0 0;width:16px;height:16px;accent-color:var(--p);flex:none}.pg .t{font-size:13px;font-weight:700}.pg .d{font-size:11.5px;color:var(--soft)}.pg.dis{opacity:.55;cursor:default}'
  + '.tagw{font-size:10.5px;font-weight:700;padding:1px 6px;border-radius:5px;background:var(--warn);color:var(--warnf);margin-left:4px;vertical-align:1px}.tagn{font-size:10.5px;font-weight:700;padding:1px 6px;border-radius:5px;background:var(--ps);color:var(--pt);margin-left:4px;vertical-align:1px}'
  + '.sw{display:flex;gap:12px;align-items:flex-start;padding:12px;border:1px solid var(--line);border-radius:10px;margin-top:6px;cursor:pointer}.sw .t{font-weight:700;font-size:13px}'
  + '.tg{width:34px;height:20px;border-radius:10px;background:var(--p);position:relative;flex:none;margin-top:2px}.tg:after{content:"";position:absolute;right:2px;top:2px;width:16px;height:16px;border-radius:50%;background:#fff}.tg.off{background:var(--line)}.tg.off:after{right:auto;left:2px}'
  + '.diff{margin-top:14px;padding:10px 12px;border-radius:10px;background:var(--hd);border:1px dashed var(--line);font-size:12.5px}.diff .a{color:#136d31;font-weight:700}.diff .r{color:var(--err);font-weight:700}@media (prefers-color-scheme:dark){.diff .a{color:#7fdc8f}}'
  + '.banner{display:flex;gap:10px;align-items:center;padding:10px 14px;border-radius:12px;background:var(--ps);color:var(--fg);margin-bottom:14px;font-size:13px}.banner svg{color:var(--p);flex:none}'
  + '.pgrid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:14px;align-items:start}.pgrid .card{margin:0}'
  + '@media (max-width:900px){.split{grid-template-columns:1fr}.drawer{position:static;max-height:none}.pgrid{grid-template-columns:minmax(0,1fr)}.seg button{flex:1 1 45%;border-bottom:1px solid var(--line)}.pages{grid-template-columns:1fr}}';

const IDLE_MS = 30 * 60 * 1000;
let words = null, me = null;
// What's unlocked: the master (full access) and every store key we can open.
const keys = { master: null, masterPkcs8: null, stores: new Map(), wrapped: new Map(), at: 0 };
const cards = new Map(), details = new Map(); // "store|wo" → opened card / latest opened detail
let idleTimer = null, ui = null;

function lock(reason) {
  keys.master = keys.masterPkcs8 = null; keys.stores.clear(); keys.wrapped.clear(); cards.clear(); details.clear();
  clearTimeout(idleTimer); badge();
  if (reason && ui) ui.toast(reason);
}
const unlocked = () => keys.stores.size > 0 || !!keys.master;
const plainMode = () => !me.access || !me.access.details || !me.keys.length;
function touch() {
  keys.at = Date.now(); clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { lock('Work orders locked after 30 minutes without use.'); if (ui && ['wos', 'people'].includes(ui.tab())) ui.redraw(); }, IDLE_MS);
  badge();
}
function badge() {
  const host = document.querySelector('.me'); if (!host) return;
  let b = document.getElementById('trk-badge');
  if (!unlocked()) { b && b.remove(); return; }
  if (!b) { b = ui.h('span', { id: 'trk-badge', class: 'unlocked', title: 'Click to lock now', onclick: () => { lock('Locked.'); ui.redraw(); } }); host.prepend(b); }
  b.textContent = '🔓 Unlocked · ' + (me.person && me.person.scope === 'all' ? 'all stores' : ((me.person && me.person.stores) || []).join(', ')) + ' · click to lock';
}
async function wordList() { return words || (words = (await (await fetch('/words.txt')).text()).split('\n').map((w) => w.trim()).filter(Boolean)); }
const suggest = async (n) => C.randomWords(await wordList(), n);

// ------------------------------------------------------------------ unlocking
async function unlockWith(phrase) {
  const email = me.email, got = [];
  for (const k of me.keys.filter((x) => !x.invite)) {
    if (k.kind === 'master') {
      const m = await C.unlockWithPhrase(k, phrase, C.aad.person(email, 'master', 0), true);
      keys.master = m; keys.masterPkcs8 = await C.exportPrivate(m); got.push('master');
    } else {
      keys.stores.set(k.store, await C.unlockWithPhrase(k, phrase, C.aad.person(email, 'store', k.store)));
    }
  }
  if (keys.master) {
    const sk = (await ui.api('GET', '/tracker/store-keys')).keys;
    for (const s of sk) { keys.wrapped.set(s.store, s.wrappedPrivate); keys.stores.set(s.store, await C.openStoreKey(s.store, s.wrappedPrivate, keys.master)); }
  }
  touch();
}
async function openCard(r) {
  const id = r.store + '|' + r.wo;
  if (cards.has(id)) return cards.get(id);
  const k = keys.stores.get(r.store);
  let c = null;
  if (k && r.card) try { c = await C.openJson(r.card, k, C.aad.card(r.store, r.wo)); } catch (_) { c = { error: true }; }
  cards.set(id, c);
  return c;
}
async function openDetail(store, wo, sealed) {
  const id = store + '|' + wo;
  if (details.has(id)) return details.get(id);
  const k = keys.stores.get(store);
  let d = null;
  if (k && sealed) try { d = await C.openJson(sealed, k, C.aad.snapshot(store, wo)); } catch (_) { d = null; }
  details.set(id, d);
  return d;
}

// ------------------------------------------------------------------ the Assize rules editor (rules-ui.js)
// It tests graphs on open orders with the same keys as this page: one unlock opens both.
// keyState → { details: customer details on and key copies set up, unlocked, person }.
export async function keyState(helpers) {
  if (!ui) ui = helpers;
  me = await helpers.api('GET', '/tracker/me');
  badge();
  return { details: !plainMode() && !!me.master && !!me.person && me.keys.some((k) => !k.invite), unlocked: unlocked(), person: me.person };
}
export const isUnlocked = () => unlocked();
// The unlock card (passphrase); after() runs once the keys are open.
export const unlockPrompt = (after) => unlockCard(after);
// One snapshot's sealed detail, opened with the store's key (null when that store isn't unlocked).
export async function openSnapshot(store, wo, sealed) {
  const k = keys.stores.get(Number(store));
  if (!k || !sealed) return null;
  touch();
  return C.openJson(sealed, k, C.aad.snapshot(Number(store), Number(wo)));
}

// ------------------------------------------------------------------ helpers
const money = (n) => (n == null ? '—' : (Number(n) < 0 ? '-$' : '$') + Math.abs(Number(n)).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
// Portal's work order statuses (its own status enum; the tracker's statuses table has the same list).
const STATUS = { 1: 'Initial check-in', 2: 'Need to order', 3: 'Awaiting item', 4: 'Awaiting device', 5: 'Awaiting diagnostics', 6: 'Awaiting partner approval',
  7: 'Awaiting callback', 8: 'Ready for work', 9: 'Diagnostics', 10: 'Work in progress', 11: 'Quality check', 12: 'Repair summary', 13: 'Ready for pickup',
  14: 'Sale complete', 15: 'Closed', 17: 'Device abandoned', 22: 'Request buyout/replacement', 23: 'Transferred to depot', 24: 'Ready for Diag', 25: 'Cancelled',
  26: 'Send to depot', 27: 'Shipped by depot' };
const statusName = (id) => STATUS[id] || 'Status ' + id;
const stClass = (r) => (r.status_id === 13 ? (r.service_outcome && r.service_outcome !== 'Completed' ? 'rfpi' : 'rfp') : !r.is_open ? 'done' : [3, 7, 26, 27].includes(r.status_id) || /await/i.test(r.status_name || '') ? 'wait' : 'wip');
// RFP split by Portal's outcome: "Ready for pickup · Complete" / "· Incomplete" (Declined, No issue found shown as is).
const statusText = (r) => (r.status_name || statusName(r.status_id)) + (r.status_id === 13 && r.service_outcome ? ' · ' + (r.service_outcome === 'Completed' ? 'Complete' : r.service_outcome) : '');
const fmtPhone = (p) => (p && p.length === 10 ? '(' + p.slice(0, 3) + ') ' + p.slice(3, 6) + '-' + p.slice(6) : p);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function excerpt(text, q) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return null;
  const a = Math.max(0, i - 40), b = Math.min(text.length, i + q.length + 40);
  return (a ? '…' : '') + esc(text.slice(a, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length, b)) + (b < text.length ? '…' : '');
}
const notesOf = (d) => ((d && d.notes && d.notes.notes) || []);

// ------------------------------------------------------------------ screens
export async function draw(which, m, helpers) {
  ui = helpers;
  if (!document.getElementById('trk-css')) document.head.append(ui.h('style', { id: 'trk-css' }, CSS));
  me = await ui.api('GET', '/tracker/me');
  badge();
  if (me.canInit) return m.replaceChildren(await setupCard());
  if (!me.person || !me.master) return m.replaceChildren(ui.h('div', { class: 'card lockcard' }, ui.h('h3', null, 'Work orders'),
    ui.h('div', null, me.master ? "You're not on the access list yet. Ask whoever manages Aethernet access to add you." : "The work order tracker hasn't been set up yet.")));
  // People needs no unlock to change pages and stores; it asks for the passphrase only when an invite needs key copies.
  if (which === 'people') return drawPeople(m);
  // Customer details off (or no key copies yet): no unlock wall, plain mode (the server sends nothing sealed).
  if (plainMode()) return which === 'sales' ? drawSales(m) : drawWos(m);
  if (me.keys.some((k) => k.invite) && !me.keys.some((k) => !k.invite)) return m.replaceChildren(await redeemCard());
  if (!unlocked()) return m.replaceChildren(unlockCard(() => draw(which, m, helpers)));
  touch();
  if (which === 'sales') return drawSales(m);
  return drawWos(m);
}

async function setupCard() {
  const phrase = ui.h('input', { type: 'text', value: await suggest(6), 'aria-label': 'Passphrase' });
  const again = ui.h('input', { type: 'text', placeholder: 'Type it again', 'aria-label': 'Passphrase again' });
  const out = ui.h('div');
  const go = ui.h('button', { class: 'btn p', onclick: async () => {
    if (C.normalizePhrase(phrase.value).split(' ').length < 5) return ui.toast('Use at least 5 words.');
    if (C.normalizePhrase(phrase.value) !== C.normalizePhrase(again.value)) return ui.toast("The two don't match.");
    go.disabled = true;
    try {
      const mk = await C.newKeyPair(), pk = await C.exportPrivate(mk.privateKey);
      const copy = await C.lockWithPhrase(pk, phrase.value, C.aad.person(me.email, 'master', 0));
      const recovery = C.b64u(pk);
      out.replaceChildren(ui.h('div', { class: 'inv' }, ui.h('b', null, 'Save this recovery key now (shown once).'),
        ui.h('div', { class: 'soft', style: 'margin:4px 0 8px' }, 'If every passphrase is ever forgotten, this is the only way back into the data. Put it in a password manager or print it.'),
        ui.h('div', { class: 'rec' }, recovery),
        ui.h('div', { style: 'display:flex;gap:8px;margin-top:8px' }, ui.h('button', { class: 'btn', onclick: () => navigator.clipboard.writeText(recovery).then(() => ui.toast('Copied')) }, 'Copy'),
          ui.h('button', { class: 'btn p', onclick: async (e) => { e.target.disabled = true; try { await ui.api('POST', '/tracker/init', { publicJwk: mk.publicJwk, copy }); ui.toast('Tracker set up.'); ui.redraw(); } catch (err) { e.target.disabled = false; ui.toast("Couldn't set up: " + err.message); } } }, "I've saved it: finish setup"))));
    } catch (e) { go.disabled = false; ui.toast(e.message); }
  } }, 'Create the master key');
  return ui.h('div', { class: 'card lockcard' }, ui.h('h3', null, 'Set up the work order tracker'),
    ui.h('div', { class: 'soft', style: 'margin-bottom:8px' }, 'This creates the master key that opens every store, locked with your passphrase. The suggested passphrase is 6 random words; you can change it.'),
    phrase, again, go, out);
}

async function redeemCard() {
  const code = ui.h('input', { type: 'text', placeholder: 'Invite code (e.g. otter maple crisp lantern)' });
  const phrase = ui.h('input', { type: 'text', value: await suggest(6) });
  const go = ui.h('button', { class: 'btn p', onclick: async () => {
    if (C.normalizePhrase(phrase.value).split(' ').length < 5) return ui.toast('Use at least 5 words.');
    go.disabled = true;
    try {
      const out = [];
      for (const k of me.keys.filter((x) => x.invite)) {
        const bind = C.aad.person(me.email, k.kind, k.store);
        const key = await C.unlockWithPhrase(k, code.value, bind, true);
        out.push(Object.assign({ kind: k.kind, store: k.store }, await C.lockWithPhrase(await C.exportPrivate(key), phrase.value, bind)));
      }
      await ui.api('PUT', '/tracker/me/keys', { keys: out });
      ui.toast('Passphrase set. Unlock with it from now on.');
      ui.redraw();
    } catch (e) { go.disabled = false; ui.toast(/Wrong passphrase/.test(e.message) ? "That invite code doesn't match." : e.message); }
  } }, 'Set my passphrase');
  return ui.h('div', { class: 'card lockcard' }, ui.h('h3', null, 'Welcome: finish your invite'),
    ui.h('div', { class: 'soft' }, 'Enter the invite code you were sent, then choose your own passphrase (suggested below: 6 random words). You can see ' + (me.person.scope === 'all' ? 'all stores' : 'stores ' + me.person.stores.join(', ')) + '.'),
    code, phrase, go);
}

function unlockCard(after) {
  const p = ui.h('input', { type: 'password', placeholder: 'Passphrase', autocomplete: 'current-password', onkeydown: (e) => { if (e.key === 'Enter') go.click(); } });
  const go = ui.h('button', { class: 'btn p', onclick: async () => {
    go.disabled = true; go.textContent = 'Unlocking…';
    try { await unlockWith(p.value); if (me.keys.some((k) => k.invite)) return card.replaceChildren(...newInvite(p.value, after)); after(); }
    catch (e) { lock(); go.disabled = false; go.textContent = 'Unlock'; ui.toast(/Wrong passphrase/.test(e.message) ? 'Wrong passphrase.' : "Couldn't unlock: " + e.message); }
  } }, 'Unlock');
  setTimeout(() => p.focus(), 50);
  const card = ui.h('div', { class: 'card lockcard', style: 'text-align:center' }, ui.h('div', { style: 'font-size:40px' }, '🔒'), ui.h('h2', { style: 'margin:6px 0' }, 'Work orders are locked'),
    ui.h('div', { class: 'soft', style: 'font-size:13px;margin-bottom:8px' }, 'Customer details, notes and history open only in this browser, with your passphrase. You can see ',
      ui.h('b', null, me.person.scope === 'all' ? 'all stores' : 'stores ' + me.person.stores.join(', ')), '.'),
    p, go, ui.h('div', { class: 'soft', style: 'margin-top:10px' }, 'Locks again after 30 minutes without use, or when you close the tab. Forgot it? Ask whoever manages Aethernet access for a new invite code.'));
  return card;
}
// A developer added stores (or all stores) to someone who already has a passphrase: those copies come locked with a
// new invite code. After unlocking, the code moves them onto the passphrase they just typed.
function newInvite(phrase, after) {
  const code = ui.h('input', { type: 'text', placeholder: 'Invite code (e.g. otter maple crisp lantern)' });
  const inv = me.keys.filter((k) => k.invite);
  const go = ui.h('button', { class: 'btn p', onclick: async () => {
    go.disabled = true;
    try {
      const out = [];
      for (const k of inv) {
        const bind = C.aad.person(me.email, k.kind, k.store), key = await C.unlockWithPhrase(k, code.value, bind, true);
        out.push(Object.assign({ kind: k.kind, store: k.store }, await C.lockWithPhrase(await C.exportPrivate(key), phrase, bind)));
        if (k.kind === 'store') keys.stores.set(k.store, key);
      }
      await ui.api('PUT', '/tracker/me/keys', { keys: out });
      me = await ui.api('GET', '/tracker/me');
      if (inv.some((k) => k.kind === 'master')) { lock(); return ui.toast('All stores added. Unlock again with your passphrase.') || ui.redraw(); }
      ui.toast('New access added to your passphrase.'); after();
    } catch (e) { go.disabled = false; ui.toast(/Wrong passphrase/.test(e.message) ? "That invite code doesn't match." : e.message); }
  } }, 'Add to my passphrase');
  return [ui.h('div', { style: 'font-size:40px' }, '🔑'), ui.h('h2', { style: 'margin:6px 0' }, 'You have new access'),
    ui.h('div', { class: 'soft', style: 'font-size:13px;margin-bottom:8px' }, 'You were given ' + inv.map((k) => (k.kind === 'master' ? 'all stores' : 'store ' + k.store)).join(', ') + '. Enter the invite code they sent you; your passphrase opens it from then on.'),
    code, go, ui.h('button', { class: 'btn', style: 'margin-top:6px;width:100%', onclick: after }, 'Later')];
}

// ------------------------------------------------------------------ Work orders
const F = { q: '', store: '', status: '', open: '', months: '6', notes: false };
let rows = [], loadedKey = '', loadedAt = 0, sel = null;
const LIST_MS = 5 * 60 * 1000; // the list is read again when it's older than this (statuses move all day)

async function drawWos(m) {
  const { h } = ui;
  const st = (await ui.api('GET', '/tracker/stores')).stores;
  const sum = (k) => st.reduce((n, s) => n + (s[k] || 0), 0);
  const ago = (iso) => { if (!iso) return '—'; const mins = Math.round((Date.now() - Date.parse(iso)) / 60000); return mins < 60 ? mins + ' min' : mins < 1440 ? Math.round(mins / 60) + ' h' : Math.round(mins / 1440) + ' d'; };
  const newest = st.map((s) => s.last_scan_at).filter(Boolean).sort().pop();
  const plain = plainMode(), one = st.length === 1 ? st[0].store + (st[0].name ? ' ' + st[0].name : '') : null;
  const totals = plain ? h('div', { class: 'card', style: 'display:flex;gap:16px 32px;flex-wrap:wrap;align-items:center' },
    h('div', null, h('div', { style: 'font-size:28px;font-weight:700' }, String(sum('open'))), h('div', { class: 'soft' }, 'Open work orders' + (one ? ' · ' + one : ' · ' + st.length + ' stores'))),
    h('div', null, h('div', { style: 'font-size:28px;font-weight:700' }, String(sum('rfp'))), h('div', { class: 'soft' }, 'Ready for pickup')),
    h('div', { class: 'soft', style: 'margin-left:auto' }, one ? ['Store: ', h('b', { style: 'color:var(--fg)' }, one), ' (the only store you can see)'] : ['Stores: ', h('b', { style: 'color:var(--fg)' }, st.map((x) => x.store).join(', ')), ' (the stores you can see)']))
  : h('div', { class: 'sum' },
    h('div', { class: 'card k' }, h('div', { class: 'n' }, String(sum('open'))), h('div', { class: 'l' }, 'Open work orders · ' + st.length + ' store' + (st.length === 1 ? '' : 's'))),
    h('div', { class: 'card k' }, h('div', { class: 'n' }, String(sum('rfp'))), h('div', { class: 'l' }, 'Ready for pickup · ' + sum('rfp_complete') + ' complete · ' + sum('rfp_other') + ' incomplete' + (sum('rfp_unknown') ? ' · ' + sum('rfp_unknown') + ' not known yet' : ''))),
    h('div', { class: 'card k', title: 'Cart lines before tax, with Partner Credit Tax Exempt (PCEXEMPT) lines ignored, so partner repairs count at their value' },
      h('div', { class: 'n' }, money(sum('rfp_value'))), h('div', { class: 'l' }, 'RFP total · complete ' + money(sum('rfp_complete_value')) + ' · incomplete ' + money(sum('rfp_other_value')) + ' · ' + money(sum('rfp_due')) + ' due from customers')),
    h('div', { class: 'card k' }, h('div', { class: 'n' }, !newest ? '—' : Date.now() - Date.parse(newest) < 60000 ? 'Just now' : ago(newest) + ' ago'), h('div', { class: 'l' }, 'Last update · ' + st.map((s) => s.store + ' ' + ago(s.last_scan_at)).join(' · '))));

  const q = h('input', { class: 'qq', value: F.q, placeholder: plain ? 'Search WO #, status, program or device' : 'Search name, phone, email, IMEI/serial, claim, WO #' + (F.notes ? ', or note text' : ''), oninput: (e) => { F.q = e.target.value; clearTimeout(q.t); q.t = setTimeout(run, 200); } });
  const sel1 = (val, opts, set) => { const s = h('select', { onchange: (e) => { set(e.target.value); run(true); } }, opts.map(([v, l]) => { const o = h('option', { value: v }, l); o.selected = String(v) === String(val); return o; })); return s; };
  const storeSel = sel1(F.store, [['', 'All stores']].concat(st.map((s) => [s.store, s.store + (s.name ? ' ' + s.name : '')])), (v) => { F.store = v; });
  const statSel = sel1(F.status, [['', 'Any status'], ['13', 'Ready for pickup'], ['13c', 'RFP complete'], ['13i', 'RFP incomplete'], ['8', 'Ready for work'], ['9', 'Diagnostics'], ['10', 'Work in progress'], ['2', 'Need to order'], ['3', 'Awaiting item'], ['4', 'Awaiting device'], ['7', 'Awaiting callback'], ['14', 'Sale complete'], ['25', 'Cancelled']], (v) => { F.status = v; });
  const openSel = sel1(F.open, [['', 'Open and closed'], ['1', 'Open only'], ['0', 'Closed only']], (v) => { F.open = v; });
  const monSel = sel1(F.months, [['1', 'Last month'], ['3', 'Last 3 months'], ['6', 'Last 6 months']], (v) => { F.months = v; });
  const notesBox = h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: F.notes || null, onchange: (e) => { F.notes = e.target.checked; run(true); } }), 'Search note text');
  const info = h('div', { class: 'soft', style: 'margin-top:8px' });
  const tbl = h('div', { class: 'card res' }), drawer = h('div', { class: 'card drawer' }, h('div', { class: 'soft' }, 'Pick a work order to see its details.'));
  if (plain) F.notes = false;
  m.replaceChildren(totals, h('div', { class: 'card' }, plain ? h('h3', null, 'Work orders') : null,
    plain ? h('div', { class: 'soft', style: 'margin:-4px 0 8px' }, 'Customer details are hidden for your account: search by work order number, status, program or device.') : null,
    h('div', { class: 'srch' }, q, st.length > 1 ? storeSel : null, statSel, openSel, monSel, plain ? null : notesBox), info), h('div', { class: 'split' }, tbl, drawer));

  async function run(reload) {
    touch();
    const since = new Date(Date.now() - Number(F.months) * 30 * 86400000).toISOString();
    const key = [F.store, F.status, F.open, F.months, F.notes].join('|');
    const t0 = performance.now();
    if (reload || key !== loadedKey || Date.now() - loadedAt > LIST_MS) {
      info.textContent = 'Loading…';
      const qs = '?limit=5000&since=' + encodeURIComponent(since) + (F.store ? '&store=' + F.store : '') + (F.status ? '&status=' + parseInt(F.status, 10) + (F.status === '13c' ? '&outcome=complete' : F.status === '13i' ? '&outcome=other' : '') : '') + (F.open ? '&open=' + F.open : '') + (F.notes ? '&detail=1' : '');
      rows = (await ui.api('GET', '/tracker/wos' + qs)).wos;
      loadedKey = key; loadedAt = Date.now();
      info.textContent = 'Opening ' + rows.length + ' work orders…';
      for (const r of rows) { r.c = await openCard(r); if (F.notes && r.sealed) r.d = await openDetail(r.store, r.wo, r.sealed); }
    }
    const term = F.q.trim().toLowerCase(), digits = term.replace(/\D/g, '');
    const hits = [];
    for (const r of rows) {
      const c = r.c || {};
      if (!term) { hits.push({ r, why: '' }); continue; }
      const why = [];
      const hay = [c.name, (c.emails || []).join(' '), c.claim, r.device, r.program_name, r.status_name].filter(Boolean).join(' ').toLowerCase();
      if (term.split(/\s+/).every((t) => hay.includes(t))) why.push(c.name && term.split(/\s+/).every((t) => c.name.toLowerCase().includes(t)) ? 'name' : 'details');
      if (digits.length >= (plain ? 2 : 4)) {
        if ((c.phones || []).some((p) => p.includes(digits))) why.push('phone');
        if ((c.imei && c.imei.includes(digits)) || (c.serial && String(c.serial).toLowerCase().includes(term))) why.push('IMEI/serial');
        if (String(r.wo).includes(digits)) why.push('WO #');
      }
      let noteHit = null;
      if (F.notes && r.d && term.length >= 3) for (const n of notesOf(r.d)) { const x = excerpt(String(n.noteText || ''), F.q.trim()); if (x) { noteHit = x; break; } }
      if (why.length || noteHit) hits.push({ r, why: why.join(' · '), noteHit });
    }
    info.textContent = (term ? hits.length + ' match' + (hits.length === 1 ? '' : 'es') + ' · ' : '') + 'searched ' + rows.length + ' work orders in ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s, in this browser'
      + (rows.some((r) => r.c && r.c.error) ? ' · some cards could not be opened' : '');
    const shown = hits.slice(0, 300);
    const pick = (r) => (e) => { sel = r.store + '|' + r.wo; [...tbl.querySelectorAll('tr.sel')].forEach((x) => x.classList.remove('sel')); e.currentTarget.classList.add('sel'); showWo(drawer, r); };
    if (plain) return tbl.replaceChildren(...(shown.length ? [h('table', null, h('tr', null, ['WO #', st.length > 1 ? 'Store' : null, 'Status', 'Device · program', 'Updated', 'Customer'].filter(Boolean).map((x) => h('th', null, x))),
      shown.map(({ r, why }) => h('tr', { class: sel === r.store + '|' + r.wo ? 'sel' : null, onclick: pick(r) },
        h('td', null, ui.woLink(r.wo), why ? h('div', { class: 'hit' }, 'matched ' + why) : null), st.length > 1 ? h('td', null, String(r.store)) : null,
        h('td', null, h('span', { class: 'st ' + stClass(r) }, statusText(r))), h('td', null, [r.device, r.program_name].filter(Boolean).join(' · ')),
        h('td', { class: 'soft' }, ui.fmt(r.api_updated_at || r.first_seen_at)), h('td', { class: 'soft' }, '🔒 Hidden')))),
      hits.length > shown.length ? h('div', { class: 'soft', style: 'margin-top:8px' }, 'Showing the first 300. Narrow the search to see the rest.') : '']
      : [h('div', { class: 'soft' }, term ? 'No matches.' : 'No work orders yet.')]));
    tbl.replaceChildren(...(shown.length ? [h('table', null, h('tr', null, ['WO', 'Store', 'Customer', 'Device', 'Program', 'Status', 'Updated', 'Value'].map((x) => h('th', null, x))),
      shown.map(({ r, why, noteHit }) => h('tr', { class: sel === r.store + '|' + r.wo ? 'sel' : null, onclick: (e) => { sel = r.store + '|' + r.wo; [...tbl.querySelectorAll('tr.sel')].forEach((x) => x.classList.remove('sel')); e.currentTarget.classList.add('sel'); showWo(drawer, r); } },
        h('td', null, h('b', null, String(r.wo))), h('td', null, String(r.store), ' ', h('span', { class: 'soft' }, r.store_name || '')),
        h('td', null, h('b', null, (r.c && r.c.name) || '—'), why || noteHit ? h('div', { class: 'hit', html: 'matched ' + esc(why) + (noteHit ? (why ? ' · ' : '') + 'note: “' + noteHit + '”' : '') }) : null),
        h('td', null, r.device || ''), h('td', null, r.program_name || ''), h('td', null, h('span', { class: 'st ' + stClass(r) }, statusText(r))),
        h('td', null, ui.fmt(r.api_updated_at || r.first_seen_at)), h('td', null, r.cart_value != null ? money(r.cart_value) : '')))),
      hits.length > shown.length ? h('div', { class: 'soft', style: 'margin-top:8px' }, 'Showing the first 300. Narrow the search to see the rest.') : '']
      : [h('div', { class: 'soft' }, term ? 'No matches.' : 'No work orders yet.')]));
  }
  await run(false);
}

async function showWo(drawer, r) {
  const { h } = ui;
  touch();
  drawer.replaceChildren(h('div', { class: 'soft' }, 'Opening…'));
  const j = await ui.api('GET', '/tracker/wo/' + r.store + '/' + r.wo);
  const snaps = j.snapshots || [];
  const d = snaps[0] ? await openDetail(r.store, r.wo, snaps[0].sealed) : null;
  const c = (await openCard(r)) || {};
  const plain = snaps[0] && snaps[0].plain ? JSON.parse(snaps[0].plain) : {};
  const w = plain.workorder || {}, pay = (plain.cart && plain.cart.payment) || {};
  if (w.statusId != null) r = Object.assign({}, r, { status_id: w.statusId, status_name: w.status || null, service_outcome: w.outcome || r.service_outcome }); // newest snapshot beats the list
  const notes = notesOf(d), hide = plainMode();
  const tabs = [hide ? null : ['notes', 'Notes (' + notes.length + ')'], ['history', 'Status history (' + (plain.auditTrail || []).length + ')'], ['cart', 'Cart (' + ((plain.cart && plain.cart.items) || []).length + ')'], ['changes', 'Changes (' + j.changes.length + ')'], ['snaps', 'Snapshots (' + snaps.length + ')']].filter(Boolean);
  let cur = hide ? 'history' : 'notes';
  const body = h('div');
  const nav = h('div', { class: 'dtabs' });
  const drawTab = () => {
    nav.replaceChildren(...tabs.map(([k, l]) => h('button', { class: k === cur ? 'on' : null, onclick: () => { cur = k; drawTab(); } }, l)));
    if (cur === 'notes') body.replaceChildren(...(notes.length ? notes.map((n) => h('div', { class: 'nt' }, String(n.noteText || ''), h('div', { class: 'by' },
      [n.UserDatum ? [n.UserDatum.givenName, n.UserDatum.familyName].filter(Boolean).join(' ') : n.createdBy, ui.fmt(n.createdAt), n.noteTag].filter(Boolean).join(' · ')))) : [h('div', { class: 'soft' }, d ? 'No notes.' : "Couldn't open this work order's detail.")]));
    if (cur === 'history') body.replaceChildren(h('table', { class: 'tl' }, (plain.auditTrail || []).map((a) => h('tr', null, h('td', { class: 'soft' }, ui.fmt(a.createdAt)), h('td', null, statusName(a.statusId)), h('td', { class: 'soft' }, a.createdBy ? 'by ' + a.createdBy : '')))));
    if (cur === 'cart') body.replaceChildren(h('table', { class: 'tl' }, ((plain.cart && plain.cart.items) || []).map((i) => h('tr', null, h('td', null, i.name || ''), h('td', { class: 'soft' }, i.sku || ''), h('td', null, (i.quantity || 1) + ' × ' + money(i.price))))),
      h('div', { style: 'margin-top:8px' }, 'Total ' + money(pay.total) + ' · paid ' + money(pay.amountPaid) + ' · due ' + money(pay.amountDue)));
    if (cur === 'changes') body.replaceChildren(h('table', { class: 'tl' }, j.changes.slice(0, 300).map((x) => h('tr', null, h('td', { class: 'soft' }, ui.fmt(x.changed_at)), h('td', null, x.field), h('td', { class: 'soft' }, (x.old || '∅') + ' → ' + (x.new || '∅'))))));
    if (cur === 'snaps') body.replaceChildren(h('table', { class: 'tl' }, snaps.map((s) => h('tr', null, h('td', null, ui.fmt(s.fetched_at)), h('td', { class: 'soft' }, s.trigger || ''), h('td', { class: 'soft' }, s.by_name || '')))));
  };
  drawTab();
  drawer.replaceChildren(
    h('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap' }, h('h2', null, String(r.wo)), h('span', { class: 'st ' + stClass(r) }, statusText(r)), h('span', { style: 'margin-left:auto' }, ui.woLink(r.wo))),
    h('div', { class: 'soft', style: 'margin:2px 0 10px' }, [r.store + ' ' + (r.store_name || ''), r.program_name, r.device, w.bin ? 'bin ' + w.bin : null, w.createdAt ? 'checked in ' + ui.fmt(w.createdAt) : null].filter(Boolean).join(' · ')),
    h('dl', { class: 'kv' }, hide ? [h('dt', null, 'Customer'), h('dd', { class: 'soft' }, '🔒 Hidden for your account')] : [h('dt', null, 'Customer'), h('dd', null, h('b', null, c.name || '—')),
      h('dt', null, 'Phone'), h('dd', null, (c.phones || []).map(fmtPhone).join(', ') || '—'), h('dt', null, 'Email'), h('dd', null, (c.emails || []).join(', ') || '—'),
      h('dt', null, 'IMEI / serial'), h('dd', null, [c.imei, c.serial].filter(Boolean).join(' · ') || '—'), c.claim ? [h('dt', null, 'Claim'), h('dd', null, c.claim)] : null],
      h('dt', null, 'Value'), h('dd', null, h('b', null, money(r.cart_value)), h('span', { class: 'soft' }, ' cart before tax, partner credits ignored')),
      h('dt', null, r.status_id === 13 ? 'Due at pickup' : 'Customer owes'), h('dd', null, money(pay.amountDue) + ' of ' + money(pay.total) + (pay.amountPaid ? ' · ' + money(pay.amountPaid) + ' paid' : ''))),
    nav, body);
}

// ------------------------------------------------------------------ Sales
const SF = { store: '', days: '30' };
async function drawSales(m) {
  const { h } = ui;
  touch();
  const st = (await ui.api('GET', '/tracker/stores')).stores;
  const ymd = (d) => d.toISOString().slice(0, 10);
  const to = new Date(), from = new Date(); from.setDate(from.getDate() - Number(SF.days) + 1);
  const qs = '?from=' + ymd(from) + '&to=' + ymd(to) + (SF.store ? '&store=' + SF.store : '');
  const days = (await ui.api('GET', '/tracker/sales/days' + qs)).days;
  const sel = (val, opts, set) => h('select', { onchange: (e) => { set(e.target.value); drawSales(m); } }, opts.map(([v, l]) => { const o = h('option', { value: v }, l); o.selected = String(v) === String(val); return o; }));
  const SRC = { portal: ['Portal', 'rfp'], mac: ['Mac history', 'wip'], estimated: ['Estimated', 'rfpi'] };
  const sum = (k) => days.reduce((n, d) => n + (d[k] || 0), 0);
  const detail = h('div', { class: 'card drawer' }, h('div', { class: 'soft' }, 'Pick a day to see its sales.'));
  const fmtDay = (d) => new Date(d + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  m.replaceChildren(
    h('div', { class: 'sum' },
      h('div', { class: 'card k' }, h('div', { class: 'n' }, money(sum('total'))), h('div', { class: 'l' }, 'Sales, last ' + SF.days + ' days' + (days.some((d) => d.source === 'estimated') ? ' (includes estimates)' : ''))),
      h('div', { class: 'card k' }, h('div', { class: 'n' }, String(days.filter((d) => d.source !== 'estimated').reduce((n, d) => n + d.count, 0))), h('div', { class: 'l' }, 'Transactions from Portal')),
      h('div', { class: 'card k' }, h('div', { class: 'n' }, String(days.filter((d) => d.source === 'estimated').length)), h('div', { class: 'l' }, 'Days estimated from work orders'))),
    h('div', { class: 'card' }, h('div', { class: 'srch' }, sel(SF.store, [['', 'All stores']].concat(st.map((x) => [x.store, x.store + (x.name ? ' ' + x.name : '')])), (v) => { SF.store = v; }),
      sel(SF.days, [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['183', 'Last 6 months']], (v) => { SF.days = v; })),
      h('div', { class: 'soft', style: 'margin-top:8px' }, 'Portal\'s sales history where we have it. Days without it are estimated from work orders that reached Sale complete (their last cart before checkout, with tax); quick sales without a work order can\'t be estimated.')),
    h('div', { class: 'split' }, h('div', { class: 'card res' }, days.length ? h('table', null, h('tr', null, ['Day', 'Store', 'Source', 'Sales', 'Total', 'Partner credits', 'Customers paid'].map((x) => h('th', null, x))),
      days.map((d) => h('tr', { onclick: (e) => { [...m.querySelectorAll('.res tr.sel')].forEach((x) => x.classList.remove('sel')); e.currentTarget.classList.add('sel'); showSalesDay(detail, d); } },
        h('td', null, h('b', null, fmtDay(d.day))), h('td', null, String(d.store)), h('td', null, h('span', { class: 'st ' + SRC[d.source][1] }, SRC[d.source][0])),
        h('td', null, String(d.count)), h('td', null, money(d.total)), h('td', null, d.partnerCredits == null ? '—' : money(d.partnerCredits)), h('td', null, d.paid == null ? '—' : money(d.paid))))) : h('div', { class: 'soft' }, 'No sales in this range yet.')),
      detail));
}
async function showSalesDay(box, d) {
  const { h } = ui;
  touch();
  box.replaceChildren(h('div', { class: 'soft' }, 'Opening…'));
  const j = await ui.api('GET', '/tracker/sales/day?store=' + d.store + '&day=' + d.day);
  const k = keys.stores.get(d.store);
  const who = async (x, aad) => { if (!k || !x.card) return null; try { return await C.openJson(x.card, k, aad); } catch (_) { return null; } };
  const head = h('div', null, h('h2', null, new Date(d.day + 'T12:00:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) + ' · ' + d.store),
    h('div', { class: 'soft', style: 'margin:2px 0 10px' }, (d.source === 'estimated' ? 'Estimated from ' + d.count + ' work order(s): ' : d.count + ' sale(s): ') + money(d.total)));
  if (d.source === 'estimated') {
    const rows = [];
    for (const w of j.estimated.filter((x) => x.store === d.store)) { const c = await who(w, C.aad.card(w.store, w.wo)); rows.push(h('tr', null, h('td', null, ui.woLink(w.wo)), h('td', null, plainMode() ? h('span', { class: 'soft' }, '🔒 Hidden') : (c && c.name) || '—'), h('td', null, w.program_name || ''), h('td', null, w.device || ''), h('td', null, money(w.estimate)))); }
    return box.replaceChildren(head, h('table', { class: 'tl' }, h('tr', null, ['WO', 'Customer', 'Program', 'Device', 'Estimate'].map((x) => h('th', null, x))), rows));
  }
  const rows = [];
  for (const x of j.sales.filter((y) => y.store === d.store)) {
    const c = await who(x, C.aad.sale(x.store, x.sale_id));
    rows.push(h('tr', null, h('td', { class: 'soft' }, x.sale_at ? new Date(x.sale_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''), h('td', null, x.wo ? ui.woLink(x.wo) : h('span', { class: 'soft' }, 'Quick sale')),
      h('td', null, plainMode() ? h('span', { class: 'soft' }, '🔒 Hidden') : (c && c.customerName) || '—', x.type === 'Return' ? h('span', { class: 'st rfpi', style: 'margin-left:6px' }, 'Return') : null), h('td', null, x.program || ''),
      h('td', null, money(x.total)), h('td', null, x.partner_credits ? money(x.partner_credits) : '—'), h('td', null, money(x.paid)), h('td', { class: 'soft' }, x.completed_by || ''),
      h('td', { class: 'soft', title: (x.items || []).map((i) => i.name).join('\n') }, (x.items || []).filter((i) => String(i.sku || '').toUpperCase() !== 'PCEXEMPT').length + ' item(s)')));
  }
  box.replaceChildren(head, h('table', { class: 'tl' }, h('tr', null, ['Time', 'WO', 'Customer', 'Program', 'Total', 'Partner', 'Paid', 'By', 'Items'].map((x) => h('th', null, x))), rows));
}

// ------------------------------------------------------------------ People (developers only; the server refuses everyone else)
// Per-person access: stores, pages, customer details. The server checks all of it on every request
// (tracker-worker/src/access.js); this page only edits it. Presets just fill the boxes.
const PAGE_DEFS = [
  ['wos', 'Work orders', 'Search and open work orders in their stores', 'store'],
  ['sales', 'Sales', 'Daily sales and each day’s transactions', 'store'],
  ['metrics', 'Metrics', 'Charts for sales, operations, cleanings', 'store', true],
  ['data', 'Store data', 'Waymark tags, Auto-Waymarks, Divination links', 'store'],
  ['usage', 'Usage', 'Who uses which shard (filtered to their stores)', 'store'],
  ['reports', 'Reports', 'Bug reports and ideas; set status, quote in patch notes', 'wide'],
  ['auto', 'Auto-Waymark', 'Stage and push rules live for every store', 'wide'],
  ['stores', 'Stores', 'Give or remove a store’s Aethernet access', 'wide'],
  ['rules', 'Assize rules', 'Edit and publish Assize’s rules; a change for every store needs All stores', 'store', true],
  ['retrace', 'Retrace', 'Every movement of every item: labels, work orders, receipts, counts (their stores)', 'store'],
  ['people', 'People', 'Developers only', 'owner'],
];
const GRANTABLE = PAGE_DEFS.filter((p) => p[3] !== 'owner').map((p) => p[0]);
// Roles are presets; Assize rules is in none of them and adds to any (shown as "Owner + Assize rules").
// Developers (TRACKER_OWNERS; `owner` in the API) have everything. Owner kept its key 'ol' (it was "Owner-level").
const PRESETS = {
  viewer: ['Store viewer', 'Default for new people', { scope: 'stores', pages: ['wos'], details: false }],
  mgr: ['Manager', 'Their stores, with customer details', { scope: 'stores', pages: ['wos', 'sales', 'metrics', 'data', 'retrace'], details: true }],
  ol: ['Owner', 'Every page but People and Assize rules', { scope: 'all', pages: GRANTABLE.filter((k) => k !== 'rules'), details: true }],
};
const ROLE = { owner: ['Developer', 'owner'], ol: ['Owner', 'ol'], mgr: ['Manager', 'mgr'], viewer: ['Store viewer', 'view'], custom: ['Custom', 'custom'] };
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
// A role from before Retrace (Oct 23, 2026) still reads as that role (same as access.js presetOf).
const roleOf = (a) => { const pages = a.pages.filter((k) => k !== 'rules'); return Object.keys(PRESETS).find((k) => { const p = PRESETS[k][2]; return a.scope === p.scope && a.details === p.details && (sameSet(pages, p.pages) || sameSet(pages, p.pages.filter((x) => x !== 'retrace'))); }) || 'custom'; };
const roleName = (a) => { const r = roleOf(a); return ROLE[r][0] + (r !== 'custom' && a.pages.includes('rules') ? ' + Assize rules' : ''); };
const KEY_SVG = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="5.5" cy="10.5" r="3.5"/><path d="M8 8l6-6M12 4l2 2"/></svg>';
const SHIELD_SVG = '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M8 1.5l5.5 2v4c0 3.5-2.4 6-5.5 7-3.1-1-5.5-3.5-5.5-7v-4z"/><path d="M5.6 8l1.7 1.7 3.2-3.4"/></svg>';

async function drawPeople(m) {
  const { h } = ui;
  if (!me.access || !me.access.owner) return m.replaceChildren(h('div', { class: 'card' }, 'Only developers can change access.'));
  const [pp, ts, as] = await Promise.all([ui.api('GET', '/tracker/people'), ui.api('GET', '/tracker/stores'), ui.api('GET', '/stores').catch(() => ({ allowed: [] }))]);
  const names = new Map();
  for (const x of as.allowed || []) if (x.name) names.set(x.store, x.name);
  for (const x of ts.stores || []) if (x.name && !names.has(x.store)) names.set(x.store, x.name);
  let people = pp.people, owners = pp.owners, selected = null, ed = null, orig = null, invite = null;
  const storeList = () => [...new Set([...names.keys(), ...(ts.stores || []).map((x) => x.store), ...people.flatMap((p) => p.stores)])].sort((a, b) => a - b);
  const storeLabel = (s) => s + (names.get(s) ? ' ' + names.get(s) : '');
  const pageName = (k) => (PAGE_DEFS.find((p) => p[0] === k) || [k, k])[1];
  const listCard = h('div', { class: 'card' }), edCard = h('div', { class: 'card' }), logCard = h('div', { class: 'card', style: 'margin-top:14px' });
  const actCard = h('div', { class: 'card' }), progs = h('div', { class: 'card' });

  // Developers first (from TRACKER_OWNERS, with or without a people row), then everyone else.
  const rows = () => {
    const byEmail = new Map(people.map((p) => [p.email, p]));
    const own = owners.map((e) => Object.assign({ email: e, name: null, scope: 'all', stores: [], pages: GRANTABLE, details: true, keys: [] }, byEmail.get(e) || {}, { owner: true }));
    return own.concat(people.filter((p) => !owners.includes(p.email)).sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email)));
  };
  const lastUsed = (p) => (p.keys.length && p.keys.every((k) => k.invite) ? 'Invite not used yet' : p.email === me.email ? 'Now' : p.last_seen_at ? ui.fmt(p.last_seen_at) : '—');
  const keyCell = (on) => (on ? h('span', { class: 'key', html: KEY_SVG + 'Yes' }) : h('span', { class: 'key no' }, 'No'));
  function drawList() {
    const all = rows();
    listCard.replaceChildren(h('h3', null, 'People (' + all.length + ')'),
      h('div', { style: 'overflow-x:auto' }, h('table', { class: 'ppl', style: 'min-width:640px' }, h('tr', null, ['Person', 'Role', 'Stores', 'Pages', 'Customer details', 'Last used'].map((x) => h('th', null, x))),
        all.map((p) => { const r = p.owner ? 'owner' : roleOf(p); return h('tr', { class: 'pick' + (selected === p.email ? ' sel' : ''), onclick: () => open(p) },
          h('td', null, h('b', null, p.name || p.email.split('@')[0]), h('div', { class: 'soft' }, p.email)),
          h('td', null, h('span', { class: 'role ' + ROLE[r][1] }, p.owner ? ROLE.owner[0] : roleName(p)), p.review && !p.owner ? h('div', { class: 'soft', style: 'margin-top:3px' }, 'Carried over: review') : null),
          h('td', null, p.scope === 'all' ? h('span', { class: 'sc' }, h('b', null, 'All stores')) : p.stores.map((s) => h('span', { class: 'sc' }, String(s)))),
          h('td', { class: 'soft', style: 'max-width:190px' }, p.owner ? 'All pages' : p.pages.map(pageName).join(', ') || 'None'),
          h('td', null, keyCell(p.owner || p.details)), h('td', { class: 'soft' }, lastUsed(p))); }))),
      h('div', { style: 'display:flex;gap:8px;margin-top:12px;align-items:center;flex-wrap:wrap' }, h('button', { class: 'btn p', onclick: () => open(null) }, 'Add a person'),
        h('span', { class: 'soft' }, 'New people start as ', h('b', null, 'Store viewer'), ': Work orders for their stores only, no customer details.')));
  }
  function open(p) {
    selected = p ? p.email : null; invite = null;
    orig = p ? JSON.parse(JSON.stringify(p)) : null;
    ed = p ? { email: p.email, name: p.name || '', scope: p.scope, stores: [...p.stores], pages: [...p.pages], details: !!p.details, owner: !!p.owner }
      : { isNew: true, email: '', name: '', scope: 'stores', stores: [], pages: ['wos'], details: false };
    drawList(); drawEditor();
  }
  // What saving needs: key copies for every store (or all stores) they should open and don't hold a copy for.
  function plan() {
    const copies = orig && orig.details ? orig.keys : [];
    const kept = ed.scope === 'all' ? copies : copies.filter((k) => k.kind === 'store' && ed.stores.includes(k.store));
    const redeemed = kept.filter((k) => !k.invite);
    const missing = ed.scope === 'all' ? (kept.some((k) => k.kind === 'master') ? [] : ['all']) : ed.stores.filter((s) => !kept.some((k) => k.kind === 'store' && k.store === s));
    if (!ed.details || !missing.length) return { invite: false };
    // Already has a passphrase: the new code adds to it (unredeemed copies are re-issued with the same code). Otherwise everything is new.
    if (redeemed.length) return { invite: true, mode: 'add', targets: [...missing, ...kept.filter((k) => k.invite && k.kind === 'store').map((k) => k.store)], keeps: redeemed.map((k) => (k.kind === 'master' ? 'all stores' : k.store)) };
    return { invite: true, mode: 'replace', targets: ed.scope === 'all' ? ['all'] : [...ed.stores] };
  }
  function changes() {
    const out = [], sA = orig ? (orig.scope === 'all' ? ['all'] : orig.stores) : [], sB = ed.scope === 'all' ? ['all'] : ed.stores;
    const lab = (s) => (s === 'all' ? 'All stores' : storeLabel(s));
    for (const s of sB) if (!sA.includes(s)) out.push(['a', '+ ' + lab(s)]);
    for (const s of sA) if (!sB.includes(s)) out.push(['r', '− ' + lab(s)]);
    const pA = orig ? orig.pages : [];
    for (const k of ed.pages) if (!pA.includes(k)) out.push(['a', '+ ' + pageName(k)]);
    for (const k of pA) if (!ed.pages.includes(k)) out.push(['r', '− ' + pageName(k)]);
    if (orig ? !!orig.details !== ed.details : ed.details) out.push([ed.details ? 'a' : 'r', 'Customer details ' + (ed.details ? 'on' : 'off')]);
    return out;
  }
  function drawEditor() {
    if (!ed) return edCard.replaceChildren(h('h3', null, 'Access'), h('div', { class: 'soft' }, 'Pick a person to change what they can open, or add someone.'));
    const set = (f) => () => { f(); invite = null; drawEditor(); };
    const head = [h('h3', null, ed.isNew ? 'Add a person' : 'Access for ' + (ed.name || ed.email)),
      ed.isNew ? h('div', { style: 'display:grid;gap:8px;margin-bottom:4px' },
        h('input', { type: 'email', value: ed.email, placeholder: 'Email (as they sign in to Cloudflare Access)', oninput: (e) => { ed.email = e.target.value.trim().toLowerCase(); } }),
        h('input', { type: 'text', value: ed.name, placeholder: 'Name', oninput: (e) => { ed.name = e.target.value; } }))
        : h('div', { class: 'soft', style: 'margin:-4px 0 10px' }, ed.email + (orig && orig.added_at ? ' · added ' + new Date(orig.added_at).toLocaleDateString([], { month: 'short', day: 'numeric' }) + (orig.added_by ? ' by ' + orig.added_by : '') : ''))];
    if (ed.owner) return edCard.replaceChildren(...head, h('div', { class: 'banner', style: 'margin:6px 0 0' }, h('span', { html: SHIELD_SVG }),
      h('div', null, 'A developer (', h('b', null, 'TRACKER_OWNERS'), ') always has every page, every store and customer details. Developers are set in the admin site’s settings, not here.')));
    const role = roleOf(ed);
    const seg = h('div', { class: 'seg' }, Object.entries(PRESETS).map(([k, [n, d, p]]) => h('button', { class: role === k ? 'on' : null,
      onclick: set(() => { ed.pages = [...p.pages, ...(ed.pages.includes('rules') ? ['rules'] : [])]; ed.details = p.details; ed.scope = p.scope; }) }, n, h('small', null, d))),
      h('button', { class: role === 'custom' ? 'on' : null, onclick: () => {} }, 'Custom', h('small', null, 'Edited by hand')));
    const chips = h('div', { class: 'schips' }, storeList().map((s) => { const on = ed.scope === 'stores' && ed.stores.includes(s);
      return h('button', { class: 'schip' + (on ? ' on' : ''), onclick: set(() => { if (ed.scope === 'all') { ed.scope = 'stores'; ed.stores = [s]; } else ed.stores = on ? ed.stores.filter((x) => x !== s) : [...ed.stores, s].sort((a, b) => a - b); }) },
        on ? h('span', null, '✓') : null, storeLabel(s)); }),
      h('button', { class: 'schip' + (ed.scope === 'all' ? ' on' : ''), onclick: set(() => { ed.scope = ed.scope === 'all' ? 'stores' : 'all'; if (ed.scope === 'all') ed.stores = []; }) },
        ed.scope === 'all' ? h('span', null, '✓') : null, 'All stores, including new ones'));
    const pages = h('div', { class: 'pages' }, PAGE_DEFS.map(([k, n, d, sc, nw]) => { const owner = sc === 'owner';
      const box = h('input', { type: 'checkbox', disabled: owner || null, onchange: set(() => { ed.pages = ed.pages.includes(k) ? ed.pages.filter((x) => x !== k) : GRANTABLE.filter((x) => x === k || ed.pages.includes(x)); }) });
      box.checked = !owner && ed.pages.includes(k);
      return h('label', { class: 'pg' + (owner ? ' dis' : '') }, box, h('span', null, h('span', { class: 't' }, n), nw ? h('span', { class: 'tagn' }, 'New') : null, sc === 'wide' ? h('span', { class: 'tagw' }, 'All stores') : null, h('div', { class: 'd' }, d))); }));
    const sw = h('div', { class: 'sw', onclick: set(() => { ed.details = !ed.details; }) }, h('span', { class: 'tg' + (ed.details ? '' : ' off') }),
      h('div', null, h('div', { class: 't' }, 'Can open sealed customer details'), h('div', { class: 'soft' }, 'Names, phones, emails, IMEI, notes. Gives them key copies for their stores only; turning it on needs a new invite code (shown once). Turning it off deletes their copies.')));
    const ch = changes(), pl = plan(), removed = orig && orig.details && ed.details && orig.scope !== 'all' && orig.stores.some((s) => ed.scope === 'stores' && !ed.stores.includes(s));
    const lab = (t) => (t === 'all' ? 'all stores' : String(t));
    const note = pl.invite ? (pl.mode === 'add' ? 'Adding a store with customer details on: a new invite code covers ' + pl.targets.map(lab).join(', ') + ' (their passphrase keeps working for ' + pl.keeps.join(', ') + ' after they redeem it).'
      : 'Customer details on: a new invite code (shown once) covers ' + pl.targets.map(lab).join(', ') + '. They sign in, enter it, then choose their own passphrase.')
      : orig && orig.details && !ed.details ? 'Turning customer details off deletes their key copies; Work orders opens for them without customer details.'
      : removed ? 'Their key copies for removed stores are deleted.' : orig && orig.review ? 'Carried over from before per-person access. Saving confirms it and clears the review flag.' : '';
    const dirty = ch.length > 0 || ed.isNew || (orig && orig.review);
    const diff = dirty ? h('div', { class: 'diff' }, h('b', null, ed.isNew ? 'New person: ' : 'Unsaved changes: '),
      ch.length ? ch.map(([c, t], i) => [i ? ' · ' : '', h('span', { class: c }, t)]) : h('span', { class: 'soft' }, ed.isNew ? roleOf(ed) === 'viewer' ? 'Store viewer' : '' : 'none'),
      note ? h('div', { class: 'soft', style: 'margin-top:4px' }, note) : null) : null;
    const save = h('button', { class: 'btn p', disabled: !dirty || null, onclick: () => doSave(save) }, pl.invite ? 'Save and create invite' : 'Save');
    const actions = h('div', { style: 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap' }, save, h('button', { class: 'btn', onclick: () => { ed = orig = selected = null; invite = null; drawList(); drawEditor(); } }, 'Cancel'),
      ed.isNew || ed.email === me.email ? null : h('button', { class: 'btn', style: 'margin-left:auto;border-color:var(--err);color:var(--err)', onclick: doRemove }, 'Remove person'));
    edCard.replaceChildren(...head,
      h('div', { class: 'lbl' }, 'Role', h('span', { class: 'soft' }, 'a starting point; any change below makes it Custom (Assize rules adds to any role)')), seg,
      h('div', { class: 'lbl' }, 'Stores', h('span', { class: 'soft' }, 'what every page shows them')), chips,
      h('div', { class: 'lbl' }, 'Pages', h('span', { class: 'soft' }, 'nav shows only these; the server refuses the rest')), pages,
      h('div', { class: 'soft', style: 'margin-top:4px' }, h('span', { class: 'tagw', style: 'margin:0' }, 'All stores'), ' = Aethernet-wide page: not limited by their store list.'),
      h('div', { class: 'lbl' }, 'Customer details'), sw, diff || '', actions,
      !invite ? '' : h('div', { class: 'inv' }, h('div', { class: 'soft' }, 'Invite code for ' + invite.who + ' (shown once; send it to them yourself):'), h('code', null, invite.code),
        h('div', { class: 'soft', style: 'margin-top:6px' }, 'It unlocks ' + invite.what + '. They enter it after signing in' + (invite.mode === 'add' ? ' and unlocking with their passphrase.' : ', then choose their own passphrase.') + ' New people also need their email on the admin site’s Cloudflare Access list.')));
  }
  async function doSave(btn) {
    if (!/^[^\s@]+@[^\s@]+$/.test(ed.email)) return ui.toast('Enter their email.');
    if (ed.scope === 'stores' && !ed.stores.length) return ui.toast('Pick at least one store, or All stores.');
    const pl = plan(), copies = [];
    let code = null;
    if (pl.invite) {
      if (!keys.master) return edCard.replaceChildren(unlockCard(() => drawEditor()));
      const none = pl.targets.filter((t) => t !== 'all' && !keys.wrapped.has(t));
      if (none.length) return ui.toast('No key yet for store ' + none.join(', ') + ": Aethernet hasn't sent anything from there.");
      code = await suggest(4);
      for (const t of pl.targets) {
        if (t === 'all') copies.push(Object.assign({ kind: 'master', store: 0 }, await C.lockWithPhrase(keys.masterPkcs8, code, C.aad.person(ed.email, 'master', 0))));
        else copies.push(Object.assign({ kind: 'store', store: t }, await C.lockWithPhrase(await C.openStoreKeyBytes(t, keys.wrapped.get(t), keys.master), code, C.aad.person(ed.email, 'store', t))));
      }
      touch();
    }
    btn.disabled = true;
    try {
      await ui.api('POST', '/tracker/people', { email: ed.email, name: ed.name.trim(), scope: ed.scope, stores: ed.scope === 'all' ? [] : ed.stores, pages: ed.pages, details: ed.details, keys: copies, keysMode: pl.mode === 'add' ? 'add' : undefined });
      const email = ed.email, inv = code ? { code, who: ed.name.trim() || ed.email, mode: pl.mode, what: pl.targets.map((t) => (t === 'all' ? 'every store' : storeLabel(t))).join(', ') } : null;
      await reload();
      open(rows().find((p) => p.email === email) || null);
      invite = inv; drawEditor();
      ui.toast('Saved.');
    } catch (e) { btn.disabled = false; ui.toast("Couldn't save: " + e.message); }
  }
  async function doRemove() {
    if (!confirm('Remove ' + ed.email + '? They lose every page here and their key copies are deleted.')) return;
    try { await ui.api('POST', '/tracker/people/' + encodeURIComponent(ed.email) + '/remove'); ed = orig = selected = null; await reload(); drawList(); drawEditor(); ui.toast('Removed.'); } catch (e) { ui.toast(e.message); }
  }
  const logRows = (list, bold) => list.map((x) => h('tr', null, h('td', { class: 'soft', style: 'white-space:nowrap' }, ui.fmt(x.at)), h('td', null, x.email),
    h('td', null, bold ? [h('b', null, x.action), ' ', [x.store, x.wo, x.detail].filter((v) => v != null && v !== '').join(' · ')] : [x.action, x.store, x.wo, x.detail].filter((v) => v != null && v !== '').join(' · '))));
  async function reload() {
    const [p2, ac, lg] = await Promise.all([ui.api('GET', '/tracker/people'), ui.api('GET', '/tracker/log?kind=access&limit=50'), ui.api('GET', '/tracker/log?limit=50')]);
    people = p2.people; owners = p2.owners;
    logCard.replaceChildren(h('h3', null, 'Access changes'), h('div', { style: 'overflow-x:auto' }, h('table', { style: 'min-width:560px' }, h('tr', null, ['When', 'Who', 'What'].map((x) => h('th', null, x))),
      ac.log.length ? logRows(ac.log, true) : h('tr', null, h('td', { colspan: 3, class: 'soft' }, 'No access changes yet.')))));
    actCard.replaceChildren(h('h3', null, 'Recent activity'), h('div', { style: 'overflow-x:auto' }, h('table', null, h('tr', null, h('th', null, 'When'), h('th', null, 'Who'), h('th', null, 'What')), logRows(lg.log, false))));
  }
  await reload();
  drawList(); drawEditor(); drawAgents(progs);
  m.replaceChildren(h('div', { class: 'banner' }, h('span', { html: SHIELD_SVG }), h('div', null, 'Only developers (', h('b', null, 'TRACKER_OWNERS'), ') can change access. Developers always see everything. Every change is checked on the server and recorded in the activity log.')),
    h('div', { class: 'pgrid' }, listCard, edCard), logCard, progs, actCard);
}

// ------------------------------------------------------------------ Connected programs
const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
async function drawAgents(box) {
  const { h } = ui;
  let agents, names = new Map();
  try {
    agents = (await ui.api('GET', '/tracker/agents')).agents;
    (await ui.api('GET', '/tracker/stores')).stores.forEach((x) => names.set(x.store, x.name || ''));
  } catch (e) { return box.replaceChildren(h('h3', null, 'Connected programs'), h('div', { class: 'soft' }, "Couldn't load: " + e.message)); }
  const again = () => drawAgents(box);
  const storeName = (n) => n + (names.get(n) ? ' ' + names.get(n) : '');
  // Opens each chosen store key with the master key and seals it to the program's own key.
  const grant = async (a, stores) => {
    const wrapped = [];
    for (const st of stores) wrapped.push({ store: st, wrapped: await C.sealBytes(await C.openStoreKeyBytes(st, keys.wrapped.get(st), keys.master), a.publicJwk, 'agentkey|' + a.id + '|' + st) });
    await ui.api('POST', '/tracker/agents/' + a.id + '/approve', { stores, keys: wrapped });
  };
  const picker = (a, label) => {
    const have = [...keys.wrapped.keys()].sort((x, y) => x - y), boxes = new Map(), msg = h('div', { class: 'soft' });
    const go = h('button', { class: 'btn p', onclick: async () => {
      const stores = have.filter((st) => boxes.get(st).checked);
      if (a.status === 'pending' && !stores.length) return ui.toast('Pick at least one store.');
      go.disabled = true;
      try { await grant(a, stores); ui.toast('Saved.'); again(); } catch (e) { go.disabled = false; msg.textContent = "Couldn't save: " + e.message; }
    } }, label);
    return h('div', { class: 'inv' }, a.status === 'pending' ? h('div', null, 'Check that this code matches the one shown on the program: ', h('code', null, a.fingerprint)) : null,
      h('div', { class: 'soft', style: 'margin:6px 0' }, 'Stores this program may read:'),
      have.length ? have.map((st) => { const c = h('input', { type: 'checkbox' }); c.checked = a.stores.includes(st); boxes.set(st, c); return h('label', { class: 'chk', style: 'display:flex;margin:3px 0' }, c, storeName(st)); }) : h('div', { class: 'soft' }, 'No store has a key yet.'),
      h('div', { style: 'margin-top:8px' }, go), msg);
  };
  const settingsPanel = (a) => {
    const s = a.settings, panel = h('div', { class: 'inv' });
    const paused = h('input', { type: 'checkbox' }); paused.checked = s.paused;
    const days = new Map(DAYS.map(([d]) => { const c = h('input', { type: 'checkbox' }); c.checked = s.days.includes(d); return [d, c]; }));
    let times = [...s.times];
    const timesBox = h('div', { class: 'srch' }), newTime = h('input', { type: 'time', step: '1800', value: '12:00', style: 'height:30px' });
    const ampm = (t) => { const [hh, mm] = t.split(':').map(Number); return (hh % 12 || 12) + ':' + String(mm).padStart(2, '0') + (hh < 12 ? ' AM' : ' PM'); };
    const drawTimes = () => timesBox.replaceChildren(...times.map((t) => h('span', { class: 'st' }, ampm(t) + ' ', h('a', { style: 'cursor:pointer', title: 'Take out', onclick: () => { times = times.filter((x) => x !== t); drawTimes(); } }, '✕'))),
      newTime, h('button', { class: 'btn', style: 'height:28px', onclick: () => {
        const v = newTime.value;
        if (!/^\d\d:(00|30)$/.test(v)) return ui.toast('Times go in 30-minute steps, like 10:00 or 10:30.');
        if (times.length >= 6) return ui.toast('Six times at most.');
        if (!times.includes(v)) times = [...times, v].sort();
        drawTimes();
      } }, 'Add time'));
    drawTimes();
    const mails = h('input', { type: 'text', value: s.emailTo.join(', '), placeholder: 'up to 3 email addresses, separated by commas', style: 'width:100%' });
    const closed = h('input', { type: 'number', min: 1, max: 14, value: s.closedDays, style: 'width:70px' });
    const stale = h('input', { type: 'number', min: 15, max: 240, value: s.staleMinutes, style: 'width:80px' });
    const from = h('input', { type: 'time', value: s.openHours.from }), to = h('input', { type: 'time', value: s.openHours.to });
    const msg = h('div', { class: 'soft' });
    const save = h('button', { class: 'btn p', onclick: async () => {
      const emailTo = mails.value.split(/[,;\s]+/).filter(Boolean);
      if (!times.length) return ui.toast('Add at least one time.');
      if (!emailTo.length || emailTo.length > 3) return ui.toast('Enter one to three email addresses.');
      if (!from.value || !to.value || from.value >= to.value) return ui.toast('Open hours: the opening time must be before the closing time.');
      save.disabled = true;
      try {
        await ui.api('POST', '/tracker/agents/' + a.id + '/settings', { settings: { paused: paused.checked, days: DAYS.map(([d]) => d).filter((d) => days.get(d).checked), times, emailTo,
          closedDays: Number(closed.value), staleMinutes: Number(stale.value), openHours: { from: from.value, to: to.value } } });
        ui.toast('Saved.'); again();
      } catch (e) { save.disabled = false; msg.textContent = "Couldn't save: " + e.message; }
    } }, 'Save');
    const row = (label, ...c) => h('div', { style: 'margin:8px 0' }, h('div', { class: 'soft' }, label), h('div', { class: 'srch' }, ...c));
    panel.replaceChildren(
      h('label', { class: 'chk', style: 'font-weight:700;color:var(--fg)' }, paused, 'Paused (no audits run until you turn this off)'),
      row('Run on', ...DAYS.map(([d, n]) => h('label', { class: 'chk' }, days.get(d), n))),
      row('Run at (Eastern time)', timesBox),
      row('Email the report to', mails),
      row('Include orders closed in the last (days)', closed),
      row('Say the tracker is down after (minutes without a scan)', stale),
      row('Store open hours (only then is the tracker checked)', from, 'to', to),
      h('div', { style: 'margin-top:8px' }, save), msg);
    return panel;
  };
  const lastRun = (a) => !a.lastRun ? h('div', { class: 'soft' }, 'Has not reported a run yet.')
    : h('div', { class: 'soft' }, 'Last run ' + ui.fmt(a.lastRun.ranAt) + ': ', h('b', null, a.lastRun.ok ? 'OK' : 'Failed'), a.lastRun.emailSent ? ', email sent' : ', no email sent', a.lastRun.note ? '. ' + a.lastRun.note : '');
  const fail = (e) => ui.toast(e.message);
  const rows = agents.map((a) => {
    const slot = h('div'), toggle = (make) => () => { slot.firstChild ? slot.replaceChildren() : slot.replaceChildren(make()); };
    const btn = (label, fn) => h('button', { class: 'btn' + (label === 'Approve…' ? ' p' : ''), style: 'height:28px', onclick: fn }, label);
    const needUnlock = (make) => () => { if (!keys.master) return ui.toast('Unlock work orders with your passphrase first.'); toggle(make)(); };
    const buttons = a.status === 'pending'
      ? [btn('Approve…', needUnlock(() => picker(a, 'Approve')))]
      : [btn('Change stores…', needUnlock(() => picker(a, 'Save stores'))), btn('Settings', toggle(() => settingsPanel(a))),
        a.runNow ? h('span', { class: 'soft' }, 'Will run at its next check') : btn('Run now', async () => { try { await ui.api('POST', '/tracker/agents/' + a.id + '/run-now'); ui.toast('It will run within 30 minutes.'); again(); } catch (e) { fail(e); } })];
    buttons.push(btn('Remove', async () => { if (!confirm('Remove ' + a.name + '? It will stop working until it is connected again.')) return; try { await ui.api('POST', '/tracker/agents/' + a.id + '/remove'); again(); } catch (e) { fail(e); } }));
    return h('div', { style: 'padding:10px 0;border-top:1px solid var(--line)' },
      h('div', { class: 'srch' }, h('b', null, a.name), h('span', { class: 'st ' + (a.status === 'active' ? 'rfp' : 'wait') }, a.status === 'active' ? 'Connected' : 'Waiting for approval'),
        a.status === 'active' && a.settings.paused ? h('span', { class: 'st' }, 'Paused') : null),
      h('div', { class: 'soft' }, 'Code ' + a.fingerprint + ' · ' + (a.status === 'active' ? 'Stores: ' + (a.stores.join(', ') || 'none') : 'Asked to connect ' + ui.fmt(a.created_at)) + ' · Last seen ' + (a.last_seen_at ? ui.fmt(a.last_seen_at) : 'never')),
      a.status === 'active' ? lastRun(a) : null,
      h('div', { style: 'margin-top:6px;display:flex;gap:6px;flex-wrap:wrap' }, ...buttons), slot);
  });
  box.replaceChildren(h('h3', null, 'Connected programs'),
    h('div', { class: 'soft' }, 'Programs on your own computers that read work orders for you, like the automated audit. Approving one lets it open the stores you pick.'),
    ...(rows.length ? rows : [h('div', { class: 'soft', style: 'margin-top:8px' }, 'None yet. A program shows up here after it asks to connect.')]));
}

addEventListener('beforeunload', () => lock());
