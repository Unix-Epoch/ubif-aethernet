// Admin site: the Retrace page (page 'retrace'). Served at /retrace-ui.js and loaded by page.js when the tab opens.
// Retrace is the inventory movement ledger (tracker-worker/src/retrace.js, retrace-api.js): every label's moves at a
// store, collected by Aethernet in store browsers. This page reads it: a coverage strip, search, the store's items
// (most recent movement first) or its purchase orders, the selected item's counts and movements with filters, a
// label's whole timeline in a drawer, and a PO's own page. Read only; the server checks page and store on every call.
// Store, item and PO live in the URL hash (#retrace?store=914&item=721276, &po=UBFPO…) so links can be shared.

const CSS = `
.rt{--p:var(--pt);--muted:#7c7b80;--errs:#fde8eb;
  --kin:#dff5e6;--kinf:#0d4a25;--kout:#eceaf0;--koutf:#3b3a40;--kwo:#efe4fb;--kwof:#5a1a99;--kq:#fff0c0;--kqf:#5a4300;--kc:#e2eefb;--kcf:#123d6b;--kbad:#fde8eb;--kbadf:#8f1d2f;
  --shadow:0 1px 2px rgba(20,10,40,.06),0 4px 14px rgba(20,10,40,.07);--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  display:grid;gap:12px}
@media (prefers-color-scheme:dark){.rt{--muted:#8b8a90;--err:#ef6b7e;--errs:#3a1a20;
  --kin:#173a24;--kinf:#bff0cf;--kout:#2a2930;--koutf:#d6d4dc;--kwo:#2f2042;--kwof:#dcc2fa;--kq:#3d3410;--kqf:#ffe9a8;--kc:#18283b;--kcf:#bcd8f7;--kbad:#3a1a20;--kbadf:#ffb3bf;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 6px 18px rgba(0,0,0,.35)}}
.rt [hidden]{display:none!important}
.rt button,.rt input,.rt select{font:inherit;color:inherit}
.rt :focus-visible{outline:2px solid var(--p);outline-offset:2px}
.rt .rcard{background:var(--card);border:1px solid var(--line);border-radius:12px;min-width:0}
.rt .chd{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:12px 14px;border-bottom:1px solid var(--line)}
.rt .chd .r{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.rt .rsoft{color:var(--soft)} .rt .rsm{font-size:12px} .rt .mono{font-family:var(--mono);font-size:12px}
.rt .rbtn{height:32px;padding:0 14px;border-radius:999px;border:1px solid var(--line);background:var(--card);font-weight:700;font-size:13px;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:6px}
.rt .rbtn:hover{border-color:var(--muted)}
.rt .health{display:flex;flex-wrap:wrap;align-items:center;gap:8px 18px;padding:10px 14px;font-size:13px}
.rt .health .r{margin-left:auto}
.rt .dot{width:9px;height:9px;border-radius:50%;background:#1baf7a;flex:none;box-shadow:0 0 0 3px rgba(27,175,122,.18)}
.rt .dot.old{background:#d9a400;box-shadow:0 0 0 3px rgba(217,164,0,.2)} .rt .dot.none{background:var(--muted);box-shadow:0 0 0 3px color-mix(in srgb,var(--muted) 20%,transparent)}
.rt .pbar{width:140px;height:6px;border-radius:3px;background:var(--line);overflow:hidden;display:inline-block;vertical-align:middle} .rt .pbar i{display:block;height:100%;background:var(--p)}
.rt .search{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:10px 12px}
.rt .search input{flex:1 1 320px;min-width:0;height:38px;border:1px solid var(--line);border-radius:10px;padding:0 12px;background:var(--card)}
.rt .search select{height:38px;border:1px solid var(--line);border-radius:10px;padding:0 10px;background:var(--card)}
.rt .rgrid{display:grid;grid-template-columns:300px minmax(0,1fr);gap:12px;align-items:start}
.rt .items .it{display:grid;grid-template-columns:1fr auto;gap:2px 10px;width:100%;border:0;border-bottom:1px solid var(--line);background:none;text-align:left;padding:10px 14px;cursor:pointer}
.rt .items .it:last-child{border-bottom:0;border-radius:0 0 12px 12px} .rt .items .it:hover{background:var(--hd)} .rt .items .it.on{background:var(--ps)}
.rt .items .it b{font-size:13.5px;line-height:1.3} .rt .items .it .n{font-variant-numeric:tabular-nums;color:var(--soft);font-size:12px;white-space:nowrap}
.rt .items .it .s{grid-column:1/-1;font-size:12px;color:var(--soft)}
.rt .items .grp{padding:8px 14px 4px;font-size:11.5px;color:var(--soft);border-bottom:1px solid var(--line);background:var(--hd)}
.rt .items .more{display:flex;justify-content:center;padding:10px}
.rt .ihd{display:grid;gap:10px;padding:14px}
.rt .ihd h2{margin:0;font-size:18px;text-wrap:balance} .rt .ihd .imeta{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12.5px;color:var(--soft)}
.rt .counts{display:flex;flex-wrap:wrap;gap:8px}
.rt .cnt{border:1px solid var(--line);border-radius:10px;padding:8px 12px;min-width:96px;background:var(--hd)} .rt .cnt b{display:block;font-size:20px;font-variant-numeric:tabular-nums;line-height:1.1} .rt .cnt span{font-size:11.5px;color:var(--soft)}
.rt .filters{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:10px 14px;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.rt .fchip{height:28px;padding:0 10px;border:1px solid var(--line);border-radius:999px;background:var(--card);font-size:12.5px;cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.rt .fchip.on{background:var(--ps);border-color:transparent;color:var(--p);font-weight:700} .rt .fchip small{color:var(--muted);font-variant-numeric:tabular-nums}
.rt .filters .r{margin-left:auto;display:flex;gap:6px;flex-wrap:wrap}
.rt .filters select{height:28px;border:1px solid var(--line);border-radius:8px;padding:0 8px;background:var(--card);font-size:12.5px}
.rt .tw{overflow-x:auto}
.rt table{width:100%;border-collapse:collapse;font-size:12.5px}
.rt th{text-align:left;color:var(--soft);font-weight:400;font-size:11.5px;padding:7px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
.rt td{padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top} .rt td.num{font-variant-numeric:tabular-nums;white-space:nowrap}
.rt tbody tr[data-l],.rt tbody tr[data-item]{cursor:pointer} .rt tbody tr:hover td{background:var(--hd)} .rt tbody tr.on td{background:var(--ps)}
.rt .kd{margin:0;display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:6px;font-size:11.5px;font-weight:700;white-space:nowrap}
.rt .kd.in{background:var(--kin);color:var(--kinf)} .rt .kd.out,.rt .kd.other{background:var(--kout);color:var(--koutf)} .rt .kd.wo{background:var(--kwo);color:var(--kwof)} .rt .kd.q{background:var(--kq);color:var(--kqf)} .rt .kd.c{background:var(--kc);color:var(--kcf)} .rt .kd.bad{background:var(--kbad);color:var(--kbadf)}
.rt .src{font-size:11px;color:var(--muted);white-space:nowrap}
.rt a.ref,.rt-drawer a.ref{color:var(--p);text-decoration:none;font-family:var(--mono);font-size:12px;font-weight:400;cursor:pointer} .rt a.ref:hover,.rt-drawer a.ref:hover{text-decoration:underline}
.rt .pref,.rt-drawer .pref{font-family:var(--mono);font-size:12px}
.rt-drawer{--p:var(--pt);--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--shadow:0 1px 2px rgba(20,10,40,.06),0 4px 14px rgba(20,10,40,.07);--muted:#7c7b80;
  --kin:#dff5e6;--kinf:#0d4a25;--kout:#eceaf0;--koutf:#3b3a40;--kwo:#efe4fb;--kwof:#5a1a99;--kq:#fff0c0;--kqf:#5a4300;--kc:#e2eefb;--kcf:#123d6b;--kbad:#fde8eb;--kbadf:#8f1d2f;
  position:fixed;top:0;right:0;bottom:0;width:min(460px,100vw);background:var(--card);border-left:1px solid var(--line);box-shadow:var(--shadow);z-index:50;display:flex;flex-direction:column;font-size:14px}
@media (prefers-color-scheme:dark){.rt-drawer{--muted:#8b8a90;--shadow:0 1px 2px rgba(0,0,0,.4),0 6px 18px rgba(0,0,0,.35);
  --kin:#173a24;--kinf:#bff0cf;--kout:#2a2930;--koutf:#d6d4dc;--kwo:#2f2042;--kwof:#dcc2fa;--kq:#3d3410;--kqf:#ffe9a8;--kc:#18283b;--kcf:#bcd8f7;--kbad:#3a1a20;--kbadf:#ffb3bf}}
.rt-drawer[hidden]{display:none}
.rt-drawer .kd{margin:0;display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:6px;font-size:11.5px;font-weight:700;white-space:nowrap}
.rt-drawer .kd.in{background:var(--kin);color:var(--kinf)} .rt-drawer .kd.out,.rt-drawer .kd.other{background:var(--kout);color:var(--koutf)} .rt-drawer .kd.wo{background:var(--kwo);color:var(--kwof)} .rt-drawer .kd.q{background:var(--kq);color:var(--kqf)} .rt-drawer .kd.c{background:var(--kc);color:var(--kcf)} .rt-drawer .kd.bad{background:var(--kbad);color:var(--kbadf)}
.rt-drawer .dh{display:flex;align-items:flex-start;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line)} .rt-drawer .dh h3{margin:0;font-size:15px} .rt-drawer .x{margin-left:auto;border:0;background:none;font-size:18px;cursor:pointer;color:var(--soft)}
.rt-drawer .db{overflow-y:auto;padding:14px 16px;display:grid;gap:14px;align-content:start}
.rt-drawer .rsoft{color:var(--soft)} .rt-drawer .rsm{font-size:12px}
.rt .kv,.rt-drawer .kv{display:grid;grid-template-columns:auto 1fr;gap:5px 14px;font-size:12.5px;margin:0} .rt-drawer .kv dt{color:var(--soft)} .rt-drawer .kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.rt .tl,.rt-drawer .tl{list-style:none;margin:0;padding:0;position:relative} .rt .tl::before,.rt-drawer .tl::before{content:"";position:absolute;left:5px;top:6px;bottom:6px;width:2px;background:var(--line)}
.rt .tl li,.rt-drawer .tl li{position:relative;padding:0 0 14px 22px} .rt .tl li::before,.rt-drawer .tl li::before{content:"";position:absolute;left:0;top:5px;width:12px;height:12px;border-radius:50%;background:var(--card);border:2px solid var(--p)}
.rt .tl li .w,.rt-drawer .tl li .w{font-size:11.5px;color:var(--soft);font-variant-numeric:tabular-nums} .rt .tl li .t,.rt-drawer .tl li .t{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:2px} .rt .tl li p,.rt-drawer .tl li p{margin:3px 0 0;font-size:12.5px;color:var(--soft)}
.rt .rnote{font-size:12.5px;color:var(--soft);padding:10px 14px}
.rt .legend{display:flex;flex-wrap:wrap;gap:6px 12px;font-size:12px;color:var(--soft);padding:8px 14px 12px}
.rt .seg{display:inline-flex;border:1px solid var(--line);border-radius:999px;padding:2px;gap:2px}
.rt .seg button{height:26px;padding:0 12px;border:0;border-radius:999px;background:none;font-size:12.5px;cursor:pointer;color:var(--soft)} .rt .seg button.on{background:var(--ps);color:var(--p);font-weight:700}
.rt .st{display:inline-flex;align-items:center;height:22px;padding:0 9px;border-radius:999px;font-size:11.5px;font-weight:700;white-space:nowrap}
.rt .st.open{background:var(--warn);color:var(--warnf)} .rt .st.done{background:var(--ok);color:var(--okf)} .rt .st.draft{background:var(--line);color:var(--soft)} .rt .st.bad{background:var(--errs);color:var(--err)}
.rt .pohd{display:grid;gap:10px;padding:14px} .rt .pohd h2{margin:0;font-size:18px;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.rt .facts{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px 18px;font-size:12.5px} .rt .facts div span{display:block;color:var(--soft);font-size:11.5px}
.rt .sec{padding:12px 14px;border-top:1px solid var(--line)} .rt .sec h4{margin:0 0 8px;font-size:13px}
.rt .two{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:0} .rt .two > div{min-width:0} .rt .two > div + div{border-left:1px solid var(--line)}
.rt .back{border:0;background:none;color:var(--p);cursor:pointer;font-size:12.5px;padding:0;justify-self:start}
.rt .qty{font-variant-numeric:tabular-nums;white-space:nowrap}
.rt .linkish{border:0;background:none;padding:0;color:var(--p);cursor:pointer;font-size:12px}
.rt .empty{display:grid;justify-items:center;text-align:center;gap:8px;padding:56px 24px}
.rt .empty .ic{width:56px;height:56px;border-radius:50%;background:var(--ps);color:var(--p);display:inline-flex;align-items:center;justify-content:center}
.rt .empty h2{margin:4px 0 0;font-size:18px} .rt .empty p{margin:0;color:var(--soft);max-width:520px} .rt .empty .steps{display:flex;flex-wrap:wrap;gap:8px 18px;justify-content:center;font-size:12.5px;color:var(--soft);margin-top:6px}
.rt .loading{padding:14px;color:var(--soft);font-size:12.5px}
@media (max-width:880px){.rt .rgrid{grid-template-columns:1fr}.rt .two{grid-template-columns:1fr}.rt .two > div + div{border-left:0;border-top:1px solid var(--line)}.rt .filters .r{margin-left:0}}
@media (prefers-reduced-motion:no-preference){.rt .fchip,.rt .items .it{transition:background .12s}}
`;

// Movement kinds (retrace.js KINDS) → label and colour group. Groups are the filter chips.
const KIND = {
  shipped_to_store: ['In transit to store', 'in'], received: ['Received', 'in'], adjusted_in: ['Adjusted in', 'in'], count_found: ['Counted', 'in'], transfer_in: ['Transfer in', 'in'], van_in: ['Back from van', 'in'], returned: ['Returned', 'in'],
  reserved: ['Reserved', 'wo'], unreserved: ['Unreserved', 'wo'], swapped_in: ['Swapped in', 'wo'], swapped_out: ['Swapped out', 'wo'], used: ['Used on repair', 'out'], sold: ['Sold', 'out'],
  transfer_out: ['Transfer out', 'out'], van_out: ['To van', 'out'], adjusted_out: ['Adjusted out', 'out'],
  defective: ['Defective', 'q'], quarantined: ['Quarantined', 'q'], rma: ['RMA', 'q'], buyback: ['Buyback', 'q'], salvage: ['Salvage', 'q'],
  consignment_changed: ['Consigned → owned', 'c'], lost: ['Lost', 'bad'], count_missing: ['Missing at count', 'bad'],
  status_changed: ['Status changed', 'other'],
};
const kindOf = (k) => KIND[k] || [String(k || 'Unknown').replace(/_/g, ' '), 'other'];
const GROUPS = [['all', 'All'], ['in', 'Into stock'], ['wo', 'Work orders'], ['out', 'Out of stock'], ['q', 'Quarantine & returns'], ['c', 'Consignment'], ['bad', 'Lost & missing']];
const kindsIn = (g) => Object.keys(KIND).filter((k) => KIND[k][1] === g);
// retrace.js SOURCES → the four names the page shows.
const SRC = (s) => (s === 'history' ? 'History' : s === 'wo' || s === 'wo_event' ? 'WO' : s === 'watch' ? 'Live' : 'Sweep');
const RANGES = [['30', 'Last 30 days'], ['90', 'Last 90 days'], ['all', 'Since tracking began']];
const PAGE = 200;
// The collector reads 60 serial histories a pass, a pass every 10 minutes (src/28-retrace-collect.js).
const HISTORIES_PER_MIN = 6;
const EMPTY_SVG = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v4h4"/><path d="M12 7v5l3 2"/></svg>';

let ui = null, S = null, el = {};
const fresh = () => ({ store: null, view: 'items', item: null, po: null, group: 'all', range: '30', user: '', q: '', stores: [], coverage: [], items: null, itemsTotal: 0, pos: null, posTotal: 0, data: null, moves: [], label: null, results: null });

// ------------------------------------------------------------------ formatting
const pad = (n) => String(n).padStart(2, '0');
const ymdUTC = (d) => d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
const when = (iso) => (iso ? ui.fmt(iso) : '—');
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
function shortWhen(iso) {
  const d = new Date(iso); if (!iso || isNaN(d)) return '—';
  const now = new Date(), y = new Date(now); y.setDate(y.getDate() - 1);
  if (sameDay(d, now)) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay(d, y)) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
const dayOnly = (iso) => { const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleDateString([], { month: 'short', day: 'numeric' }); };
function ago(iso) {
  const ms = Date.now() - new Date(iso).getTime(); if (!iso || isNaN(ms)) return null;
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60); if (h < 48) return h + (h === 1 ? ' hour ago' : ' hours ago');
  return Math.round(h / 24) + ' days ago';
}
const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
const money = (v) => (typeof v === 'number' ? v.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : v ? String(v) : '—');
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
const storeName = (st) => { const x = S.stores.find((s) => s.store === st); return st + (x && x.name ? ' ' + x.name : ''); };

// ------------------------------------------------------------------ links: WO → Portal, PO → this page's PO view
function woRef(wo, text) {
  const a = ui.woLink(wo); // page.js: Portal's work order page in a new tab
  a.className = 'ref'; a.textContent = text || 'WO ' + wo;
  return a;
}
const poRef = (po, text) => ui.h('a', { class: 'ref', href: '#', onclick: (e) => { e.preventDefault(); e.stopPropagation(); openPo(po); } }, text || 'PO ' + po);
const plain = (t) => ui.h('span', { class: 'pref' }, t);
const REF_PREFIX = { transfer: 'Transfer ', journal: 'Count ', count: 'Count ', rma: 'RMA ', buyback: 'Buyback ', van: 'Van ', arrival: 'Arrival ' };
function refEl(m) {
  if (!m.ref_id && m.wo) return woRef(m.wo);
  if (!m.ref_id) return ui.h('span', { class: 'rsoft' }, '—');
  if (m.ref_type === 'po') return poRef(m.ref_id);
  if (m.ref_type === 'wo') return woRef(m.ref_id);
  if (m.ref_type === 'sales_order') return m.wo ? woRef(m.wo, m.ref_id) : plain(m.ref_id);
  return plain((REF_PREFIX[m.ref_type] || '') + m.ref_id);
}
function fromTo(m) {
  if (m.from_wh || m.to_wh) return (m.from_wh || '?') + ' → ' + (m.to_wh || '?');
  if (m.wo && m.ref_type !== 'wo') return ui.h('span', null, 'WO ', woRef(m.wo, m.wo));
  if (m.detail) return ui.h('span', { title: m.detail }, m.detail.length > 60 ? m.detail.slice(0, 58) + '…' : m.detail);
  return '';
}
const kindChip = (k) => { const [label, cls] = kindOf(k); return ui.h('span', { class: 'kd ' + cls }, label); };

// ------------------------------------------------------------------ URL state
function saveHash() {
  const p = new URLSearchParams();
  if (S.store != null) p.set('store', S.store);
  if (S.view === 'pos') p.set('view', 'pos');
  if (S.po && el.po && !el.po.hidden) p.set('po', S.po); else if (S.item) p.set('item', S.item);
  if (S.label) p.set('label', S.label);
  try { history.replaceState(null, '', '#retrace?' + p.toString()); } catch (_) {}
}
const live = () => ui && ui.tab() === 'retrace' && el.root && el.root.isConnected;

// ------------------------------------------------------------------ entry
export async function draw(m, helpers) {
  ui = helpers;
  if (!document.getElementById('rt-css')) document.head.append(ui.h('style', { id: 'rt-css' }, CSS));
  if (!S) S = fresh();
  const h = ui.h, params = new URLSearchParams(location.hash.split('?')[1] || '');
  const access = helpers.access || { owner: false, scope: 'stores', stores: [] };
  const [st, cov] = await Promise.all([ui.api('GET', '/tracker/stores').catch(() => ({ stores: [] })), ui.api('GET', '/tracker/retrace/coverage').catch(() => ({ stores: [] }))]);
  // Stores this person can see: their own (a store-scoped person), the tracker's, and any Retrace has data for.
  const names = new Map((st.stores || []).map((s) => [s.store, s.name]));
  const ids = new Set([...(access.scope === 'stores' ? access.stores || [] : []), ...(st.stores || []).map((s) => s.store), ...(cov.stores || []).map((s) => s.store)].map(Number).filter((n) => Number.isInteger(n)));
  S.stores = [...ids].sort((a, b) => a - b).map((s) => ({ store: s, name: names.get(s) || null }));
  S.coverage = cov.stores || [];
  const want = Number(params.get('store'));
  if (want && ids.has(want)) S.store = want;
  if (S.store == null || !ids.has(S.store)) S.store = ids.has(914) ? 914 : S.stores.length ? S.stores[0].store : null;
  if (params.get('view') === 'pos') S.view = 'pos';
  if (S.store == null) {
    return m.replaceChildren(h('div', { class: 'rt' }, emptyCard('No stores to show yet', 'Retrace fills in per store as Aethernet runs in a store browser. Stores you can see will show up here once they have.')));
  }

  el = {};
  el.drawer = drawerEl();
  el.root = h('div', { class: 'rt' },
    el.health = h('div', { class: 'rcard health' }),
    h('div', { class: 'rcard search' },
      el.q = h('input', { type: 'search', placeholder: 'Search an item, label, PO, work order, sales order or transfer', 'aria-label': 'Search Retrace', value: S.q,
        onkeydown: (e) => { if (e.key === 'Enter') search(el.q.value.trim()); }, onsearch: (e) => { if (!e.target.value) search(''); } }),
      el.storeSel = h('select', { 'aria-label': 'Store', onchange: (e) => switchStore(Number(e.target.value)) }, S.stores.map((s) => { const o = h('option', { value: s.store }, storeName(s.store)); o.selected = s.store === S.store; return o; }))),
    el.body = h('div'));
  m.replaceChildren(el.root);
  if (!document.querySelector('.rt-drawer')) document.body.append(el.drawer); else { document.querySelector('.rt-drawer').replaceWith(el.drawer); }
  if (!draw.bound) {
    draw.bound = true;
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && live()) closeDrawer(); });
    // Leaving the tab: the drawer is on <body>, so close it.
    addEventListener('hashchange', () => { if (!location.hash.startsWith('#retrace')) { const d = document.querySelector('.rt-drawer'); if (d) d.hidden = true; } });
  }
  drawHealth();
  await loadStore({ item: params.get('item'), po: params.get('po'), label: params.get('label') });
}

function emptyCard(title, text, steps) {
  const h = ui.h;
  return h('div', { class: 'rcard empty' }, h('div', { class: 'ic', html: EMPTY_SVG }), h('h2', null, title), h('p', null, text),
    steps ? h('div', { class: 'steps' }, steps.map((s) => h('span', null, s))) : null);
}

// ------------------------------------------------------------------ coverage strip
function drawHealth() {
  const h = ui.h, c = S.coverage.find((x) => x.store === S.store) || { labels: 0, histories: 0, backlog: 0, movements: 0, items: 0, last_sweep_at: null };
  const pct = c.labels ? Math.round((c.histories / c.labels) * 100) : 0;
  const age = c.last_sweep_at ? Date.now() - new Date(c.last_sweep_at).getTime() : null;
  const dot = age == null ? 'none' : age > 60 * 60000 ? 'old' : '';
  const mins = Math.round((c.backlog || 0) / HISTORIES_PER_MIN);
  const tabTime = mins < 1 ? 'clear' : mins < 90 ? 'about ' + mins + ' min of an open tab' : 'about ' + Math.round(mins / 60) + ' hours of an open tab';
  el.health.replaceChildren(
    h('span', { class: 'dot ' + dot, 'aria-hidden': 'true' }),
    h('span', null, h('b', null, storeName(S.store)), ' · ', c.last_sweep_at ? 'last pass ' + ago(c.last_sweep_at) : 'no pass yet'),
    h('span', null, 'Labels known ', h('b', null, num(c.labels))),
    h('span', null, 'Histories read ', h('b', null, num(c.histories)), ' ', h('span', { class: 'pbar', title: pct + '% read' }, h('i', { style: 'width:' + pct + '%' }))),
    h('span', null, 'Backlog ', h('b', null, num(c.backlog)), ' ', h('span', { class: 'rsoft rsm' }, '· ' + tabTime)),
    h('span', null, 'Movements ', h('b', null, num(c.movements))),
    h('span', { class: 'r rsoft rsm' }, c.items ? num(c.items) + ' items in stock lookup' : ''));
}

// ------------------------------------------------------------------ store: list + right side
async function switchStore(st) {
  S.store = st; S.item = null; S.po = null; S.data = null; S.label = null; S.results = null; S.q = ''; el.q.value = '';
  closeDrawer(); drawHealth();
  await loadStore({});
}

async function loadStore(want) {
  const h = ui.h;
  el.body.replaceChildren(h('div', { class: 'loading' }, 'Loading…'));
  const [items, pos] = await Promise.all([ui.api('GET', '/tracker/retrace/items?store=' + S.store + '&limit=100'), ui.api('GET', '/tracker/retrace/pos?store=' + S.store + '&limit=100')]);
  S.items = items.items; S.itemsTotal = items.total; S.pos = pos.pos; S.posTotal = pos.total;
  const c = S.coverage.find((x) => x.store === S.store);
  if (!S.items.length && !S.pos.length && !(c && (c.labels || c.movements))) {
    el.body.replaceChildren(emptyCard('Nothing collected yet', "Retrace hasn't collected anything for this store yet. It fills in as Aethernet runs in a store browser.",
      ['Stock and labels: every pass', 'Serial histories: 60 labels a pass', 'Purchase orders: draft, in transit and the last 14 days']));
    saveHash(); return;
  }
  el.body.replaceChildren(h('div', { class: 'rgrid' },
    h('div', { class: 'rcard' },
      h('div', { class: 'chd' }, el.seg = h('span', { class: 'seg' }, h('button', { type: 'button', 'data-v': 'items', onclick: () => setView('items') }, 'Items'), h('button', { type: 'button', 'data-v': 'pos', onclick: () => setView('pos') }, 'Purchase orders')),
        el.segnote = h('span', { class: 'r rsoft rsm' })),
      el.list = h('div', { class: 'items' })),
    h('div', null, el.item = h('div', { class: 'rcard' }), el.po = h('div', { class: 'rcard', hidden: true }))));
  if (want.po) { drawList(); await openPo(want.po); }
  else {
    drawList();
    if (S.view === 'pos' && S.pos.length) await openPo(S.pos[0].po);
    else await openItem(want.item || S.item || (S.items[0] && S.items[0].item) || null);
  }
  if (want.label) openLabel(want.label);
}

function setView(v) {
  S.view = v; S.results = null; S.q = ''; el.q.value = '';
  drawList();
  if (v === 'pos') { if (S.pos.length) openPo(S.po && S.pos.some((p) => p.po === S.po) ? S.po : S.pos[0].po); else showPoEmpty(); }
  else { el.po.hidden = true; el.item.hidden = false; if (!S.data) openItem(S.item || (S.items[0] && S.items[0].item) || null); else drawItemList(); saveHash(); }
}

function drawList() {
  el.seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.view && !S.results));
  if (S.results) return drawResults();
  el.segnote.textContent = S.view === 'pos' ? 'newest first · Store ' + S.store : 'most recent movement first';
  if (S.view === 'pos') drawPoList(); else drawItemList();
}

function itemRow(x) {
  const h = ui.h;
  return h('button', { class: 'it' + (x.item === S.item && el.po.hidden ? ' on' : ''), type: 'button', 'data-id': x.item, onclick: () => { el.po.hidden = true; el.item.hidden = false; openItem(x.item); } },
    h('b', null, x.name || 'Item ' + x.item), h('span', { class: 'n' }, x.on_hand != null ? num(x.on_hand) + ' on hand' : ''),
    h('span', { class: 's mono' }, x.item), h('span', { class: 's' }, num(x.moves) + (x.moves === 1 ? ' movement' : ' movements') + ' · last ' + shortWhen(x.last_at)));
}
function drawItemList() {
  const h = ui.h;
  if (!S.items.length) return el.list.replaceChildren(h('div', { class: 'rnote' }, 'No item movements yet. Items show up here as their labels move.'));
  el.list.replaceChildren(...[...S.items.map(itemRow),
    S.items.length < S.itemsTotal ? h('div', { class: 'more' }, h('button', { class: 'rbtn', type: 'button', onclick: async (e) => {
      e.target.disabled = true;
      const j = await ui.api('GET', '/tracker/retrace/items?store=' + S.store + '&limit=100&offset=' + S.items.length);
      S.items.push(...j.items); S.itemsTotal = j.total; drawItemList();
    } }, 'Show more (' + num(S.itemsTotal - S.items.length) + ')')) : null].filter(Boolean));
}

// PO status → [label, pill class]. Portal's own status is shown next to it on the PO page.
function poLook(p) {
  const s = norm(p.status), got = p.received || 0, all = p.labels || 0;
  if (s === 'received' || s === 'invoiced') return ['Received', 'done'];
  if (s === 'draft') return ['Draft', 'draft'];
  if (/cancel/.test(s)) return ['Cancelled', 'bad'];
  if (got > 0 && got < all) return ['Partly received', 'open'];
  if (p.tracking) return ['In transit', 'open'];
  return [p.status || 'Unknown', 'open'];
}
function drawPoList() {
  const h = ui.h;
  if (!S.pos.length) return el.list.replaceChildren(h('div', { class: 'rnote' }, 'No purchase orders seen yet. Draft, in-transit and recent ones come in on the next pass.'));
  el.list.replaceChildren(...[...S.pos.map((x) => {
    const [label, cls] = poLook(x);
    return h('button', { class: 'it' + (x.po === S.po && !el.po.hidden ? ' on' : ''), type: 'button', 'data-po': x.po, onclick: () => openPo(x.po) },
      h('b', { class: 'mono', style: 'font-size:13px' }, x.po), h('span', { class: 'st ' + cls }, label),
      h('span', { class: 's' }, [x.type, x.at ? dayOnly(x.at) : null].filter(Boolean).join(' · ') || '—'),
      h('span', { class: 's' }, [x.labels ? x.received + ' of ' + x.labels + ' received' : x.labels === 0 ? 'No labels yet' : x.lines != null ? x.lines + ' lines' : 'Lines not read yet', x.total != null ? money(x.total) : null].filter(Boolean).join(' · ')));
  }), S.pos.length < S.posTotal ? h('div', { class: 'more' }, h('button', { class: 'rbtn', type: 'button', onclick: async (e) => {
    e.target.disabled = true;
    const j = await ui.api('GET', '/tracker/retrace/pos?store=' + S.store + '&limit=100&offset=' + S.pos.length);
    S.pos.push(...j.pos); S.posTotal = j.total; drawPoList();
  } }, 'Show more (' + num(S.posTotal - S.pos.length) + ')')) : null].filter(Boolean));
}
function showPoEmpty() {
  el.item.hidden = true; el.po.hidden = false;
  el.po.replaceChildren(ui.h('div', { class: 'rnote' }, 'No purchase orders seen at this store yet.'));
}

// ------------------------------------------------------------------ search
async function search(q) {
  S.q = q;
  if (!q) { S.results = null; drawList(); return; }
  if (q.length < 2) return ui.toast('Type at least 2 characters');
  try { S.results = await ui.api('GET', '/tracker/retrace/search?store=' + S.store + '&q=' + encodeURIComponent(q)); }
  catch (e) { return ui.toast("Couldn't search: " + e.message); }
  drawList();
}
function drawResults() {
  const h = ui.h, r = S.results;
  el.segnote.replaceChildren(h('button', { class: 'linkish', type: 'button', onclick: () => { el.q.value = ''; search(''); } }, 'Clear search'));
  const out = [];
  const grp = (t, n) => h('div', { class: 'grp' }, t + ' · ' + n);
  if (r.items.length) {
    out.push(grp('Items', r.items.length));
    for (const x of r.items) {
      const known = S.items.find((i) => i.item === x.item);
      out.push(known ? itemRow(known) : itemRow({ item: x.item, name: x.name, on_hand: null, moves: 0, last_at: x.last_seen }));
    }
  }
  if (r.labels.length) {
    out.push(grp('Labels', r.labels.length));
    for (const x of r.labels) out.push(h('button', { class: 'it', type: 'button', onclick: () => openLabel(x.label) },
      h('b', { class: 'mono', style: 'font-size:13px' }, x.label), h('span', { class: 'n' }, x.serial_status || ''),
      h('span', { class: 's' }, x.product || ((S.items || []).find((i) => i.item === x.item) || {}).name || 'Item ' + (x.item || '?')), h('span', { class: 's' }, [x.po ? 'PO ' + x.po : null, x.wo ? 'WO ' + x.wo : null, x.last_seen ? 'seen ' + shortWhen(x.last_seen) : null].filter(Boolean).join(' · '))));
  }
  const docs = [...r.docs.map((d) => ({ type: d.type, id: d.id, sub: [d.status, d.at ? dayOnly(d.at) : null, d.counterpart].filter(Boolean).join(' · ') })),
    ...r.refs.filter((x) => !r.docs.some((d) => d.id === x.ref_id)).map((x) => ({ type: x.ref_type, id: x.ref_id, sub: x.n + (x.n === 1 ? ' movement' : ' movements') + ' · last ' + shortWhen(x.last_at), wo: x.ref_type === 'wo' ? x.ref_id : null }))];
  if (docs.length) {
    out.push(grp('Documents', docs.length));
    const NAME = { po: 'Purchase order', wo: 'Work order', sales_order: 'Sales order', transfer: 'Transfer', rma: 'RMA order', buyback: 'Buyback order', count: 'Count', journal: 'Count', reason: 'Reason', van: 'Van', arrival: 'Arrival' };
    for (const d of docs) {
      const go = d.type === 'po' ? () => openPo(d.id) : d.type === 'wo' ? () => window.open(ui.woLink(d.id).href, '_blank', 'noopener') : null;
      out.push(h('button', { class: 'it', type: 'button', style: go ? null : 'cursor:default', onclick: go },
        h('b', { class: 'mono', style: 'font-size:13px' }, d.id + (d.type === 'wo' ? ' ↗' : '')), h('span', { class: 'n' }, NAME[d.type] || d.type), h('span', { class: 's' }, d.sub)));
    }
  }
  if (!out.length) out.push(h('div', { class: 'rnote' }, 'Nothing at this store matches “' + S.q + '”.'));
  el.list.replaceChildren(...out);
}

// ------------------------------------------------------------------ item view
function itemQuery(offset) {
  const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset || 0) });
  if (S.range !== 'all') { const d = new Date(Date.now() - Number(S.range) * 86400000); p.set('from', ymdUTC(d)); }
  if (S.group !== 'all') p.set('kinds', kindsIn(S.group).join(','));
  if (S.user) p.set('user', S.user);
  return '/tracker/retrace/item/' + S.store + '/' + encodeURIComponent(S.item) + '?' + p.toString();
}
async function openItem(item) {
  const h = ui.h;
  if (el.po) el.po.hidden = true;
  el.item.hidden = false;
  if (!item) { el.item.replaceChildren(h('div', { class: 'rnote' }, 'No item movements at this store yet.')); saveHash(); return; }
  if (item !== S.item) { S.group = 'all'; S.user = ''; }
  S.item = item; S.view = S.results ? S.view : 'items';
  if (!S.results) drawList(); else el.list.querySelectorAll('.it[data-id]').forEach((b) => b.classList.toggle('on', b.dataset.id === item));
  el.item.replaceChildren(h('div', { class: 'loading' }, 'Loading…'));
  try { S.data = await ui.api('GET', itemQuery(0)); } catch (e) { el.item.replaceChildren(h('div', { class: 'rnote' }, "Couldn't load this item: " + e.message)); return; }
  S.moves = S.data.movements;
  drawItem(); saveHash();
}
async function refilter() {
  try { S.data = await ui.api('GET', itemQuery(0)); } catch (e) { return ui.toast("Couldn't load: " + e.message); }
  S.moves = S.data.movements; drawItem(); saveHash();
}

// Counts: Portal's quantities from the stock lookup when Retrace has them (store warehouses, not quarantine),
// else the labels Retrace knows; defective and consigned from the labels; sold from the movements (90 days).
function itemCounts(d) {
  const lab = (f) => (d.counts || []).filter(f).reduce((n, c) => n + c.n, 0);
  const st = (c) => norm(c.serial_status), quar = (c) => norm(c.wh_type) === 'quarantine';
  const qty = d.info && d.info.qty && typeof d.info.qty === 'object' ? d.info.qty : null;
  const wh = qty ? Object.entries(qty) : [];
  const sum = (k, q) => wh.filter(([id]) => (q ? /q$/i.test(id) : !/q$/i.test(id))).reduce((n, [, w]) => n + (w && typeof w[k] === 'number' ? w[k] : 0), 0);
  const fromLabels = { available: lab((c) => st(c) === 'available' && !quar(c)), reserved: lab((c) => st(c) === 'reserved'), inTransit: lab((c) => st(c) === 'intransit') };
  const defective = lab((c) => ['defective', 'damaged', 'broken'].includes(st(c)) || (quar(c) && !['sold', 'lost'].includes(st(c))));
  const consigned = lab((c) => norm(c.consignment) === 'yes' && ['available', 'reserved', 'received', 'intransit'].includes(st(c)));
  return [['Available', qty ? sum('available') : fromLabels.available], ['Reserved', qty ? sum('reserved') : fromLabels.reserved], ['In transit', qty ? sum('inTransit') : fromLabels.inTransit],
    ['Defective', defective || (qty ? sum('onHand', true) : 0)], ['Sold, 90 days', d.sold90 || 0], ['Consigned', consigned]];
}

function drawItem() {
  const h = ui.h, d = S.data, x = S.items.find((i) => i.item === d.item) || {};
  const name = (d.info && d.info.name) || x.name || 'Item ' + d.item;
  const byGroup = { all: 0 };
  for (const k of d.by_kind || []) { const g = kindOf(k.kind)[1]; byGroup[g] = (byGroup[g] || 0) + k.n; byGroup.all += k.n; }
  const sel = (opts, val, on, label) => h('select', { 'aria-label': label, onchange: (e) => on(e.target.value) }, opts.map(([v, l]) => { const o = h('option', { value: v }, l); o.selected = v === val; return o; }));
  const users = [['', 'Anyone'], ...(d.users || []).map((u) => [u.user, u.user])];
  if (S.user && !users.some(([v]) => v === S.user)) users.push([S.user, S.user]);
  el.rows = h('tbody');
  el.item.replaceChildren(
    h('div', { class: 'ihd' },
      h('div', null, h('h2', null, name),
        h('div', { class: 'imeta' }, h('span', { class: 'mono' }, d.item), d.info && d.info.category ? h('span', null, d.info.category) : null,
          h('span', null, num(d.all_total) + (d.all_total === 1 ? ' movement' : ' movements') + ' recorded' + (d.first_at ? ' since ' + dayOnly(d.first_at) : '')), h('span', null, 'Store ' + S.store))),
      h('div', { class: 'counts' }, itemCounts(d).map(([k, v]) => h('div', { class: 'cnt' }, h('b', null, num(v)), h('span', null, k))))),
    h('div', { class: 'filters' },
      GROUPS.map(([g, label]) => h('button', { type: 'button', class: 'fchip' + (g === S.group ? ' on' : ''), onclick: () => { S.group = g; refilter(); } }, label, ' ', h('small', null, num(byGroup[g] || 0)))),
      h('span', { class: 'r' }, sel(RANGES, S.range, (v) => { S.range = v; refilter(); }, 'Date range'), sel(users, S.user, (v) => { S.user = v; refilter(); }, 'Person'))),
    h('div', { class: 'tw' }, h('table', null,
      h('thead', null, h('tr', null, ['When', 'Label', 'Movement', 'Reference', 'From → to', 'By', 'Source'].map((t) => h('th', null, t)))), el.rows)),
    el.more = h('div'),
    h('div', { class: 'legend' },
      [['in', 'Into stock'], ['wo', 'On a work order'], ['out', 'Out of stock'], ['q', 'Quarantine, RMA, buyback'], ['c', 'Consignment'], ['bad', 'Lost, missing']].map(([c, t]) => h('span', null, h('span', { class: 'kd ' + c }, t))),
      h('span', { style: 'margin-left:auto' }, "Source: History = Portal's serial history · WO = work order tracker · Live = seen as it happened · Sweep = Retrace's own checks")));
  drawRows();
}
function moveRow(m) {
  const h = ui.h;
  return h('tr', { 'data-l': m.label || null, class: m.label && m.label === S.label ? 'on' : null, onclick: (e) => { if (m.label && !e.target.closest('a')) openLabel(m.label); } },
    h('td', { class: 'num' }, when(m.at)), h('td', { class: 'mono' }, m.label || h('span', { class: 'rsoft' }, 'item only')), h('td', null, kindChip(m.kind)),
    h('td', null, refEl(m)), h('td', null, fromTo(m)), h('td', null, m.user || ''), h('td', { class: 'src', title: m.source }, SRC(m.source)));
}
function drawRows() {
  const h = ui.h, d = S.data;
  el.rows.replaceChildren(...(S.moves.length ? S.moves.map(moveRow) : [h('tr', null, h('td', { colspan: 7, class: 'rsoft', style: 'padding:18px 10px' },
    d.all_total ? 'No movements match these filters.' : 'No movements recorded for this item yet.'))]));
  el.more.replaceChildren(S.moves.length < d.total ? h('div', { class: 'rnote' }, h('button', { class: 'rbtn', type: 'button', onclick: async (e) => {
    e.target.disabled = true;
    const j = await ui.api('GET', itemQuery(S.moves.length)); S.moves.push(...j.movements); drawRows();
  } }, 'Show ' + Math.min(PAGE, d.total - S.moves.length) + ' more'), ' ', h('span', { class: 'rsm' }, 'Showing ' + num(S.moves.length) + ' of ' + num(d.total))) : '');
}

// ------------------------------------------------------------------ label drawer
function drawerEl() {
  const h = ui.h;
  return h('aside', { class: 'rt-drawer', hidden: true, 'aria-label': 'Label timeline' },
    h('div', { class: 'dh' }, h('div', null, el.dl = h('h3'), el.dsub = h('div', { class: 'rsoft rsm' })), h('button', { class: 'x', type: 'button', 'aria-label': 'Close', onclick: closeDrawer }, '✕')),
    el.db = h('div', { class: 'db' }));
}
function closeDrawer() {
  if (!el.drawer) return;
  el.drawer.hidden = true; S.label = null;
  if (el.root) el.root.querySelectorAll('tr.on').forEach((tr) => tr.classList.remove('on'));
  if (live()) saveHash();
}
async function openLabel(label) {
  const h = ui.h;
  S.label = label;
  el.root.querySelectorAll('tr[data-l]').forEach((tr) => tr.classList.toggle('on', tr.dataset.l === label));
  el.dl.textContent = label; el.dsub.textContent = 'Loading…'; el.db.replaceChildren(); el.drawer.hidden = false; saveHash();
  let j;
  try { j = await ui.api('GET', '/tracker/retrace/label/' + S.store + '/' + encodeURIComponent(label)); }
  catch (e) { el.dsub.textContent = /not seen/.test(e.message) ? 'Retrace hasn’t seen this label at store ' + S.store + '.' : "Couldn't load: " + e.message; return; }
  if (S.label !== label) return;
  const l = j.label || {}, mv = j.movements;
  const item = l.item || (mv[0] && mv[0].item);
  const itemName = l.product || ((S.items || []).find((i) => i.item === item) || {}).name || (S.data && S.data.item === item && S.data.info && S.data.info.name) || null;
  const wo = l.wo || ([...mv].reverse().find((m) => m.wo) || {}).wo;
  const po = l.po || ([...mv].reverse().find((m) => m.ref_type === 'po') || {}).ref_id;
  const consWas = mv.some((m) => m.kind === 'consignment_changed');
  const cons = norm(l.consignment) === 'yes' ? 'Consigned' : norm(l.consignment) === 'no' ? (consWas ? 'Owned (consigned at purchase)' : 'Owned') : null;
  const kv = [
    ['Item', item ? h('span', null, h('a', { class: 'ref', href: '#', onclick: (e) => { e.preventDefault(); closeDrawer(); openItem(item); } }, item), itemName ? ' · ' + itemName : '') : null],
    ['Status now', [l.serial_status, l.wh_type && norm(l.wh_type) !== 'main' ? l.wh_type : null].filter(Boolean).join(' · ') || null],
    ['Consignment', cons],
    ['Purchase order', po ? h('span', null, poRef(po, po), typeof l.cost === 'number' ? ' · ' + money(l.cost) : '') : null],
    ['Work order', wo ? woRef(wo, wo + ' ↗') : null],
    ['Sales order', l.sales_order || null],
    ['OEM serial', l.oem_serial || null], ['IMEI', l.imei || null],
    ['History read', l.last_history_at ? when(l.last_history_at) : l.need_history ? 'Queued' : null],
  ].filter(([, v]) => v);
  el.dsub.textContent = mv.length ? 'Full history, oldest first' : 'No movements recorded yet';
  el.db.replaceChildren(
    h('dl', { class: 'kv' }, kv.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
    h('ol', { class: 'tl' }, mv.map((m) => {
      const ft = m.from_wh || m.to_wh ? (m.from_wh || '?') + ' → ' + (m.to_wh || '?') : null;
      const p = [m.detail, ft, m.user ? 'by ' + m.user : null].filter(Boolean).join(' · ');
      return h('li', null, h('div', { class: 'w' }, when(m.at)), h('div', { class: 't' }, kindChip(m.kind), m.ref_id || m.wo ? refEl(m) : null),
        h('p', null, p || '', h('span', { class: 'rsoft', style: 'font-size:11px;margin-left:6px;opacity:.8' }, SRC(m.source))));
    })));
}

// ------------------------------------------------------------------ PO page
const FIELD = { status: 'Status', approval: 'Approval', remaining: 'Remaining', registered: 'Registered', tracking: 'Tracking', autoReceiveAt: 'Auto-receive', autoReceivePaused: 'Auto-receive paused', mergedInto: 'Merged' };
function poEventsView(events) {
  // Label receive-status rows seen at the same time with the same change are one entry ("21 labels In Transit → Received").
  const out = [];
  for (const e of events) {
    const lm = /^label (.+)$/.exec(e.field), ln = /^line (\S+) (\w+)$/.exec(e.field);
    if (lm) {
      const last = out[out.length - 1];
      if (last && last.kind === 'labels' && last.at === e.at && last.old === e.old && last.new === e.new) { last.n++; continue; }
      out.push({ kind: 'labels', at: e.at, old: e.old, new: e.new, n: 1, one: lm[1] });
    } else if (ln) out.push({ at: e.at, title: 'Line ' + ln[1], text: ln[2] + ' ' + (e.old ?? '—') + ' → ' + (e.new ?? '—') });
    else if (e.field === 'status' && e.old == null) out.push({ at: e.at, title: 'First seen', text: 'Status ' + (e.new || '—') });
    else if (e.field === 'autoReceiveAt') out.push({ at: e.at, title: FIELD[e.field], text: e.new ? when(e.new) : 'cleared' });
    else if (e.field === 'tracking') out.push({ at: e.at, title: FIELD[e.field], text: e.new || 'cleared' });
    else if (e.field === 'mergedInto') out.push({ at: e.at, title: FIELD[e.field], text: 'into ' + (e.new || '—'), po: e.new });
    else out.push({ at: e.at, title: FIELD[e.field] || e.field, text: (e.old ?? 'None') + ' → ' + (e.new ?? 'None') });
  }
  return out.map((x) => x.kind === 'labels' ? { at: x.at, title: x.n === 1 ? 'Label' : 'Labels', text: (x.n === 1 ? x.one : x.n + ' labels') + ' ' + (x.old ?? 'new') + ' → ' + (x.new ?? '—') } : x);
}
async function openPo(po) {
  const h = ui.h;
  S.po = po; closeDrawer();
  el.item.hidden = true; el.po.hidden = false;
  el.list.querySelectorAll('.it').forEach((b) => b.classList.toggle('on', b.dataset.po === po));
  el.po.replaceChildren(h('div', { class: 'loading' }, 'Loading…'));
  let j;
  try { j = await ui.api('GET', '/tracker/retrace/po/' + S.store + '/' + encodeURIComponent(po)); }
  catch (e) { el.po.replaceChildren(h('div', { class: 'pohd' }, backBtn(), h('div', { class: 'rnote', style: 'padding:0' }, /not seen/.test(e.message) ? 'Retrace hasn’t seen ' + po + ' at store ' + S.store + ' yet.' : "Couldn't load: " + e.message))); saveHash(); return; }
  if (S.po !== po) return;
  const x = j.header || {}, info = x.info || {}, lines = j.lines || [], labels = j.labels || [];
  const listRow = (S.pos || []).find((p) => p.po === po) || {};
  const [look, cls] = poLook({ status: x.status, tracking: x.tracking, labels: labels.length, received: labels.filter((l) => /^received$/i.test(l.receive_status || '')).length });
  const tot = (k) => lines.reduce((n, l) => n + (typeof l[k] === 'number' ? l[k] : 0), 0);
  const ordered = tot('ordered'), shipped = tot('shipped'), received = tot('received') || labels.filter((l) => /^received$/i.test(l.receive_status || '')).length, cancelled = tot('cancelled');
  const toCome = lines.some((l) => typeof l.remaining === 'number') ? tot('remaining') : typeof x.remaining === 'number' ? x.remaining : Math.max(0, ordered - received - cancelled);
  const recvAt = new Map(); for (const m of j.movements || []) if (m.kind === 'received' && m.label && !recvAt.has(m.label)) recvAt.set(m.label, m.at);
  const yn = (v) => (v == null ? '—' : /^(yes|true|1)$/i.test(String(v)) ? 'Yes' : /^(no|false|0)$/i.test(String(v)) ? 'No' : String(v));
  const LBL = 50;
  let showAll = false;
  const labelRows = () => (showAll ? labels : labels.slice(0, LBL)).map((l) => {
    const now = l.now;
    const nowText = now ? [now.serial_status || '—', now.wo ? 'WO ' + now.wo : null].filter(Boolean).join(' · ') : '—';
    return h('tr', { 'data-l': l.label, onclick: () => openLabel(l.label) }, h('td', { class: 'mono' }, l.label),
      h('td', null, h('span', { class: 'kd ' + (/^received$/i.test(l.receive_status || '') ? 'in' : 'out') }, l.receive_status || '—')),
      h('td', null, nowText), h('td', { class: 'qty' }, recvAt.has(l.label) ? when(recvAt.get(l.label)) : '—'));
  });
  const lblBody = h('tbody', null, labelRows());
  const lblNote = h('div', { class: 'rsoft rsm', style: 'margin-top:6px' });
  const drawLblNote = () => lblNote.replaceChildren(labels.length ? 'Showing ' + Math.min(showAll ? labels.length : LBL, labels.length) + ' of ' + labels.length + ' · click a label for its full history' : 'No labels read for this order yet.',
    !showAll && labels.length > LBL ? h('span', null, ' · ', h('button', { class: 'linkish', type: 'button', onclick: () => { showAll = true; lblBody.replaceChildren(...labelRows()); drawLblNote(); } }, 'Show all')) : '');
  drawLblNote();
  const evs = poEventsView(j.events || []);
  el.po.replaceChildren(
    h('div', { class: 'pohd' },
      backBtn(),
      h('h2', null, h('span', { class: 'mono', style: 'font-size:18px' }, po), h('span', { class: 'st ' + cls }, look), x.status ? h('span', { class: 'rsoft rsm', style: 'font-weight:400' }, 'Portal status: ' + x.status) : null),
      h('div', { class: 'counts' }, [['Ordered', ordered], ['Shipped', shipped], ['Received', received], ['Still to come', toCome], ['Cancelled', cancelled]].map(([k, v]) => h('div', { class: 'cnt' }, h('b', null, lines.length || k === 'Received' || k === 'Still to come' ? num(v) : '—'), h('span', null, k)))),
      h('div', { class: 'facts' },
        [['Order type', info.type || listRow.type], ['Pool', info.pool], ['Vendor reference', info.vendorRef], ['Tracking', x.tracking ? h('span', { class: 'mono', style: 'color:var(--fg);font-size:12px' }, x.tracking) : null],
          ['Shipping', info.delivery], ['Auto-receives', x.autoReceiveAt ? when(x.autoReceiveAt) + (x.autoReceivePaused ? ' (paused)' : '') : null],
          ['Total', info.total != null ? money(info.total) : null], ['Consigned', info.consignedAmount != null ? money(info.consignedAmount) : null], ['Owned', info.ownedAmount != null ? money(info.ownedAmount) : null],
          x.mergedInto ? ['Merged into', poRef(x.mergedInto, x.mergedInto)] : null].filter(Boolean).map(([k, v]) => h('div', null, h('span', null, k), v == null || v === '' ? '—' : v)))),
    h('div', { class: 'two' },
      h('div', null,
        h('div', { class: 'sec' }, h('h4', null, 'Lines'), lines.length ? h('div', { class: 'tw' }, h('table', null,
          h('thead', null, h('tr', null, ['#', 'Item', 'Ordered', 'Shipped', 'Received', 'Cancelled', 'Price', 'Consignment'].map((t) => h('th', null, t)))),
          h('tbody', null, lines.map((l) => h('tr', { 'data-item': l.item || null, onclick: l.item ? () => { S.view = 'items'; S.results = null; drawList(); openItem(l.item); } : null },
            h('td', { class: 'qty' }, l.line), h('td', null, h('b', { class: 'mono' }, l.item || '—'), l.desc ? h('div', { class: 'rsoft rsm' }, l.desc) : null),
            ...['ordered', 'shipped', 'received', 'cancelled'].map((k) => h('td', { class: 'qty' }, l[k] == null ? '—' : num(l[k]))), h('td', { class: 'qty' }, l.price != null ? money(l.price) : '—'), h('td', null, yn(l.consignment)))))))
          : h('div', { class: 'rsoft rsm' }, x.need_detail ? 'Lines come in on the next pass that reads this order in full.' : 'No lines read for this order.')),
        h('div', { class: 'sec' }, h('h4', null, 'Labels on this order'), labels.length ? h('div', { class: 'tw' }, h('table', null,
          h('thead', null, h('tr', null, ['Label', 'On the order', 'Now', 'Received'].map((t) => h('th', null, t)))), lblBody)) : null, lblNote)),
      h('div', null, h('div', { class: 'sec' }, h('h4', null, 'Status history'), evs.length ? h('ol', { class: 'tl' }, evs.map((e) => h('li', null, h('div', { class: 'w' }, when(e.at)),
        h('div', { class: 't' }, h('b', { style: 'font-size:13px' }, e.title)), h('p', null, e.po ? poRef(e.po, e.text) : e.text))))
        : h('div', { class: 'rsoft rsm' }, 'No status changes seen yet.'),
        h('div', { class: 'rsoft rsm', style: 'margin-top:4px' }, 'Times are when Retrace saw the change; Portal gives none.')))));
  saveHash();
}
function backBtn() {
  return ui.h('button', { class: 'back', type: 'button', onclick: () => { S.view = 'items'; S.results = null; el.po.hidden = true; el.item.hidden = false; drawList(); if (!S.data || S.data.item !== S.item) openItem(S.item || (S.items[0] && S.items[0].item) || null); else saveHash(); } }, '← Back to items');
}
