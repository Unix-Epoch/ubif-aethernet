// Admin site: the work order tracker tabs (Work orders, People). A proof of concept UI.
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
  + '@media (max-width:900px){.split{grid-template-columns:1fr}.drawer{position:static;max-height:none}}';

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
  b.textContent = '🔓 Unlocked · ' + (me.person.scope === 'all' ? 'all stores' : me.person.stores.join(', ')) + ' · click to lock';
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
  if (!me.person) return m.replaceChildren(me.canInit ? await setupCard() : ui.h('div', { class: 'card lockcard' }, ui.h('h3', null, 'Work orders'),
    ui.h('div', null, me.master ? "You're not on the work order list yet. Ask an admin to add you; they'll send you an invite code." : "The work order tracker hasn't been set up yet.")));
  if (me.keys.some((k) => k.invite) && !me.keys.some((k) => !k.invite)) return m.replaceChildren(await redeemCard());
  if (!unlocked()) return m.replaceChildren(unlockCard(() => draw(which, m, helpers)));
  touch();
  if (which === 'people') return drawPeople(m);
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
    try { await unlockWith(p.value); after(); }
    catch (e) { lock(); go.disabled = false; go.textContent = 'Unlock'; ui.toast(/Wrong passphrase/.test(e.message) ? 'Wrong passphrase.' : "Couldn't unlock: " + e.message); }
  } }, 'Unlock');
  setTimeout(() => p.focus(), 50);
  return ui.h('div', { class: 'card lockcard', style: 'text-align:center' }, ui.h('div', { style: 'font-size:40px' }, '🔒'), ui.h('h2', { style: 'margin:6px 0' }, 'Work orders are locked'),
    ui.h('div', { class: 'soft', style: 'font-size:13px;margin-bottom:8px' }, 'Customer details, notes and history open only in this browser, with your passphrase. You can see ',
      ui.h('b', null, me.person.scope === 'all' ? 'all stores' : 'stores ' + me.person.stores.join(', ')), '.'),
    p, go, ui.h('div', { class: 'soft', style: 'margin-top:10px' }, 'Locks again after 30 minutes without use, or when you close the tab. Forgot it? Ask an admin for a new invite code.'));
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
  const totals = h('div', { class: 'sum' },
    h('div', { class: 'card k' }, h('div', { class: 'n' }, String(sum('open'))), h('div', { class: 'l' }, 'Open work orders · ' + st.length + ' store' + (st.length === 1 ? '' : 's'))),
    h('div', { class: 'card k' }, h('div', { class: 'n' }, String(sum('rfp'))), h('div', { class: 'l' }, 'Ready for pickup · ' + sum('rfp_complete') + ' complete · ' + sum('rfp_other') + ' incomplete' + (sum('rfp_unknown') ? ' · ' + sum('rfp_unknown') + ' not known yet' : ''))),
    h('div', { class: 'card k', title: 'Cart lines before tax, with Partner Credit Tax Exempt (PCEXEMPT) lines ignored, so partner repairs count at their value' },
      h('div', { class: 'n' }, money(sum('rfp_value'))), h('div', { class: 'l' }, 'Value on the RFP table · complete ' + money(sum('rfp_complete_value')) + ' · incomplete ' + money(sum('rfp_other_value')) + ' · ' + money(sum('rfp_due')) + ' due from customers')),
    h('div', { class: 'card k' }, h('div', { class: 'n' }, !newest ? '—' : Date.now() - Date.parse(newest) < 60000 ? 'Just now' : ago(newest) + ' ago'), h('div', { class: 'l' }, 'Last update · ' + st.map((s) => s.store + ' ' + ago(s.last_scan_at)).join(' · '))));

  const q = h('input', { class: 'qq', value: F.q, placeholder: 'Search name, phone, email, IMEI/serial, claim, WO #' + (F.notes ? ', or note text' : ''), oninput: (e) => { F.q = e.target.value; clearTimeout(q.t); q.t = setTimeout(run, 200); } });
  const sel1 = (val, opts, set) => { const s = h('select', { onchange: (e) => { set(e.target.value); run(true); } }, opts.map(([v, l]) => { const o = h('option', { value: v }, l); o.selected = String(v) === String(val); return o; })); return s; };
  const storeSel = sel1(F.store, [['', 'All stores']].concat(st.map((s) => [s.store, s.store + (s.name ? ' ' + s.name : '')])), (v) => { F.store = v; });
  const statSel = sel1(F.status, [['', 'Any status'], ['13', 'Ready for pickup'], ['13c', 'RFP complete'], ['13i', 'RFP incomplete'], ['8', 'Ready for work'], ['9', 'Diagnostics'], ['10', 'Work in progress'], ['2', 'Need to order'], ['3', 'Awaiting item'], ['4', 'Awaiting device'], ['7', 'Awaiting callback'], ['14', 'Sale complete'], ['25', 'Cancelled']], (v) => { F.status = v; });
  const openSel = sel1(F.open, [['', 'Open and closed'], ['1', 'Open only'], ['0', 'Closed only']], (v) => { F.open = v; });
  const monSel = sel1(F.months, [['1', 'Last month'], ['3', 'Last 3 months'], ['6', 'Last 6 months']], (v) => { F.months = v; });
  const notesBox = h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: F.notes || null, onchange: (e) => { F.notes = e.target.checked; run(true); } }), 'Search note text');
  const info = h('div', { class: 'soft', style: 'margin-top:8px' });
  const tbl = h('div', { class: 'card res' }), drawer = h('div', { class: 'card drawer' }, h('div', { class: 'soft' }, 'Pick a work order to see its details.'));
  m.replaceChildren(totals, h('div', { class: 'card' }, h('div', { class: 'srch' }, q, storeSel, statSel, openSel, monSel, notesBox), info), h('div', { class: 'split' }, tbl, drawer));

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
      if (digits.length >= 4) {
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
  const notes = notesOf(d);
  const tabs = [['notes', 'Notes (' + notes.length + ')'], ['history', 'Status history (' + (plain.auditTrail || []).length + ')'], ['cart', 'Cart (' + ((plain.cart && plain.cart.items) || []).length + ')'], ['changes', 'Changes (' + j.changes.length + ')'], ['snaps', 'Snapshots (' + snaps.length + ')']];
  let cur = 'notes';
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
    h('dl', { class: 'kv' }, h('dt', null, 'Customer'), h('dd', null, h('b', null, c.name || '—')),
      h('dt', null, 'Phone'), h('dd', null, (c.phones || []).map(fmtPhone).join(', ') || '—'), h('dt', null, 'Email'), h('dd', null, (c.emails || []).join(', ') || '—'),
      h('dt', null, 'IMEI / serial'), h('dd', null, [c.imei, c.serial].filter(Boolean).join(' · ') || '—'), c.claim ? [h('dt', null, 'Claim'), h('dd', null, c.claim)] : null,
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
    for (const w of j.estimated.filter((x) => x.store === d.store)) { const c = await who(w, C.aad.card(w.store, w.wo)); rows.push(h('tr', null, h('td', null, ui.woLink(w.wo)), h('td', null, (c && c.name) || '—'), h('td', null, w.program_name || ''), h('td', null, w.device || ''), h('td', null, money(w.estimate)))); }
    return box.replaceChildren(head, h('table', { class: 'tl' }, h('tr', null, ['WO', 'Customer', 'Program', 'Device', 'Estimate'].map((x) => h('th', null, x))), rows));
  }
  const rows = [];
  for (const x of j.sales.filter((y) => y.store === d.store)) {
    const c = await who(x, C.aad.sale(x.store, x.sale_id));
    rows.push(h('tr', null, h('td', { class: 'soft' }, x.sale_at ? new Date(x.sale_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''), h('td', null, x.wo ? ui.woLink(x.wo) : h('span', { class: 'soft' }, 'Quick sale')),
      h('td', null, (c && c.customerName) || '—', x.type === 'Return' ? h('span', { class: 'st rfpi', style: 'margin-left:6px' }, 'Return') : null), h('td', null, x.program || ''),
      h('td', null, money(x.total)), h('td', null, x.partner_credits ? money(x.partner_credits) : '—'), h('td', null, money(x.paid)), h('td', { class: 'soft' }, x.completed_by || ''),
      h('td', { class: 'soft', title: (x.items || []).map((i) => i.name).join('\n') }, (x.items || []).filter((i) => String(i.sku || '').toUpperCase() !== 'PCEXEMPT').length + ' item(s)')));
  }
  box.replaceChildren(head, h('table', { class: 'tl' }, h('tr', null, ['Time', 'WO', 'Customer', 'Program', 'Total', 'Partner', 'Paid', 'By', 'Items'].map((x) => h('th', null, x))), rows));
}

// ------------------------------------------------------------------ People
async function drawPeople(m) {
  const { h } = ui;
  if (me.person.scope !== 'all') return m.replaceChildren(h('div', { class: 'card' }, 'Only people with access to every store can manage people.'));
  const [pp, lg] = await Promise.all([ui.api('GET', '/tracker/people'), ui.api('GET', '/tracker/log?limit=50')]);
  const form = { email: h('input', { type: 'email', placeholder: 'Email (as they sign in to Cloudflare Access)' }), name: h('input', { type: 'text', placeholder: 'Name' }),
    scope: h('select', null, h('option', { value: 'stores' }, 'Some stores'), h('option', { value: 'all' }, 'All stores (owner, district manager, dev)')),
    stores: h('input', { type: 'text', placeholder: 'Store numbers, e.g. 914, 326' }) };
  const out = h('div');
  const create = h('button', { class: 'btn p', style: 'margin-top:10px', onclick: async () => {
    const email = form.email.value.trim().toLowerCase(), scope = form.scope.value;
    const stores = scope === 'stores' ? [...new Set(form.stores.value.split(/[^\d]+/).filter(Boolean).map(Number))] : [];
    if (!email) return ui.toast('Enter their email.');
    if (scope === 'stores' && !stores.length) return ui.toast('Enter at least one store number.');
    const missing = stores.filter((s) => !keys.wrapped.has(s));
    if (missing.length) return ui.toast('No key yet for store ' + missing.join(', ') + ": Aethernet hasn't sent anything from there.");
    create.disabled = true;
    try {
      const code = await suggest(4), copies = [];
      if (scope === 'all') copies.push(Object.assign({ kind: 'master', store: 0 }, await C.lockWithPhrase(keys.masterPkcs8, code, C.aad.person(email, 'master', 0))));
      for (const s of stores) copies.push(Object.assign({ kind: 'store', store: s }, await C.lockWithPhrase(await C.openStoreKeyBytes(s, keys.wrapped.get(s), keys.master), code, C.aad.person(email, 'store', s))));
      await ui.api('POST', '/tracker/people', { email, name: form.name.value.trim(), scope, stores, keys: copies });
      out.replaceChildren(h('div', { class: 'inv' }, h('div', { class: 'soft' }, 'Invite code for ' + (form.name.value.trim() || email) + ' (shown once; send it to them yourself):'), h('code', null, code),
        h('div', { class: 'soft', style: 'margin-top:6px' }, 'They sign in, enter this code, then choose their own passphrase. It unlocks ' + (scope === 'all' ? 'every store' : stores.join(', ') + ' only') + '. Add their email to the Cloudflare Access list too.')));
      create.disabled = false;
      drawList((await ui.api('GET', '/tracker/people')).people);
    } catch (e) { create.disabled = false; ui.toast("Couldn't add: " + e.message); }
  } }, 'Create invite');
  const list = h('div', { class: 'card' });
  function drawList(people) {
    list.replaceChildren(h('h3', null, 'People who can search work orders'), h('table', null, h('tr', null, ['Person', 'Can see', 'Last used', ''].map((x) => h('th', null, x))),
      people.map((p) => h('tr', null, h('td', null, h('b', null, p.name || p.email), h('div', { class: 'soft' }, p.email)),
        h('td', null, h('span', { class: 'scope ' + (p.scope === 'all' ? 'all' : 'some') }, p.scope === 'all' ? 'All stores' : 'Some stores'), p.scope === 'all' ? null : h('div', { class: 'soft' }, p.stores.join(', '))),
        h('td', null, p.keys.some((k) => k.invite) && !p.keys.some((k) => !k.invite) ? 'Invite not used yet' : p.last_seen_at ? ui.fmt(p.last_seen_at) : '—'),
        h('td', null, h('button', { class: 'btn', style: 'height:28px', onclick: () => { form.email.value = p.email; form.name.value = p.name || ''; form.scope.value = p.scope; form.stores.value = p.stores.join(', '); ui.toast('Change what they can see, then Create invite: they get a new code.'); } }, 'Edit'), ' ',
          p.email === me.email ? null : h('button', { class: 'btn', style: 'height:28px', onclick: async () => { if (!confirm('Remove ' + p.email + '? Their key copies are deleted.')) return; try { await ui.api('POST', '/tracker/people/' + encodeURIComponent(p.email) + '/remove'); drawList((await ui.api('GET', '/tracker/people')).people); } catch (e) { ui.toast(e.message); } } }, 'Remove'))))),
      h('div', { class: 'soft', style: 'margin-top:10px' }, "Each person also needs their email on the admin site's Cloudflare Access list."));
  }
  drawList(pp.people);
  const progs = h('div', { class: 'card' });
  drawAgents(progs);
  m.replaceChildren(h('div', { class: 'grid', style: 'grid-template-columns:minmax(0,1.4fr) minmax(0,1fr)' }, list,
    h('div', { class: 'card' }, h('h3', null, 'Add a person'), h('div', { style: 'display:grid;gap:8px' }, form.email, form.name, form.scope, form.stores), create, out)),
    progs,
    h('div', { class: 'card' }, h('h3', null, 'Recent activity'), h('table', null, h('tr', null, h('th', null, 'When'), h('th', null, 'Who'), h('th', null, 'What')),
      lg.log.map((x) => h('tr', null, h('td', null, ui.fmt(x.at)), h('td', null, x.email), h('td', null, [x.action, x.store, x.wo, x.detail].filter((v) => v != null && v !== '').join(' · ')))))));
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
