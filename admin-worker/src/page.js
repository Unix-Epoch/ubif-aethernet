// The admin app: one page, no build step. Talks only to /api/… on this site (behind Cloudflare Access).
export const PAGE = String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aethernet admin</title>
<style>
@font-face{font-family:Apercu;src:url(https://assets.asurion-ui.my.asurion53.com/fonts/Apercu-Regular-Pro.woff2) format('woff2');font-weight:400}
@font-face{font-family:Apercu;src:url(https://assets.asurion-ui.my.asurion53.com/fonts/Apercu-Bold-Pro.woff2) format('woff2');font-weight:700}
:root{--bg:#f6f5f8;--card:#fff;--fg:#1a1c1e;--soft:#5d5e61;--line:#e4e2e8;--p:#8223d2;--pt:#8223d2;--ps:#f3e9fd;--ok:#c5ffc8;--okf:#062011;--warn:#fff0c0;--warnf:#3a3000;--err:#d1344b;--hd:#faf9fb}
@media (prefers-color-scheme:dark){:root{--bg:#131216;--card:#1d1c21;--fg:#ececf0;--soft:#a8a7ad;--line:#2e2d33;--ps:#2c1f3d;--pt:#c39af5;--ok:#163d1c;--okf:#c5ffc8;--warn:#3d3410;--warnf:#fff0c0;--hd:#211f26}}
*{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 Apercu,"Helvetica Neue",Helvetica,Arial,sans-serif}
.top{position:sticky;top:0;z-index:5;min-height:60px;background:var(--card);border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;padding:8px 24px}
.logo{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px} .logo svg{color:var(--p)}
.tabs{display:flex;gap:4px;flex-wrap:wrap} .tabs button{border:0;background:none;padding:8px 14px;border-radius:999px;color:var(--soft);font:inherit;cursor:pointer} .tabs button.on{background:var(--ps);color:var(--p);font-weight:700}
.me{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:13px;color:var(--soft)} .lock{padding:3px 10px;border-radius:999px;background:var(--ok);color:var(--okf);font-weight:700;font-size:12px}
main{padding:20px 24px 60px;max-width:1400px}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:14px}
select,input,textarea{height:36px;padding:0 10px;border:1px solid var(--line);border-radius:8px;font:inherit;background:var(--card);color:var(--fg)} textarea{height:auto;padding:8px 10px;width:100%;resize:vertical}
.btn{height:34px;padding:0 14px;border-radius:999px;border:1px solid var(--fg);background:transparent;color:var(--fg);font:inherit;font-weight:700;cursor:pointer} .btn.p{background:var(--p);border-color:var(--p);color:#fff} .btn:disabled{opacity:.45;cursor:default}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin-bottom:14px} .card h3{margin:0 0 10px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--soft)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:14px} .grid .card{margin:0}
.sum{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:14px} .k .n{font-size:28px;font-weight:700} .k .l{color:var(--soft);font-size:13px}
table{width:100%;border-collapse:collapse;font-size:13px} th{text-align:left;color:var(--soft);font-weight:400;font-size:12px;padding:6px 8px;border-bottom:1px solid var(--line)} td{padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
a{color:var(--p);font-weight:700;text-decoration:none} .soft{color:var(--soft);font-size:12px} .err{color:var(--err);font-weight:700}
.tag{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-weight:700;font-size:11px;margin:0 4px 2px 0;border:1px solid color-mix(in srgb,var(--c) 45%,transparent);color:color-mix(in srgb,var(--c) 78%,var(--fg));background:color-mix(in srgb,var(--c) 15%,var(--card))}
.tag.one{--c:#5d5e61;border-style:dashed;background:transparent;font-weight:400}
.mark{display:inline-flex;height:20px;align-items:center;padding:0 6px;border-radius:5px;font-weight:700;font-size:11px;border:1px solid}
.mark.over{background:#d1344b;border-color:#d1344b;color:#fff} .mark.today{color:#6b5500;background:#f3e7b5;border-color:#d3b64d} .mark.up{color:#2f47c9;background:#eef1ff;border-color:#9fb0f7} .mark.gone{color:var(--soft);border-style:dashed}
.rep{border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin-bottom:8px;background:var(--card)} .rep .top2{display:flex;gap:8px;align-items:center;flex-wrap:wrap} .rep .meta{margin-left:auto;font-size:12px;color:var(--soft)}
.kind{padding:1px 8px;border-radius:999px;font-size:11px;font-weight:700;text-transform:uppercase} .kind.bug{background:#ffdad7;color:#410004} .kind.idea{background:var(--ps);color:var(--p)}
.txt{margin:6px 0;white-space:pre-wrap;overflow-wrap:anywhere} .ctl{display:flex;gap:6px;align-items:center;flex-wrap:wrap} .ctl input{flex:1;min-width:180px}
.q{margin-top:8px;font-size:13px} .q summary{cursor:pointer;color:var(--p);font-weight:700;font-size:12px} .q .row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px} .in{color:#136d31;font-weight:700;font-size:12px}
.row2{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) auto;gap:8px;align-items:center;padding:3px 0;font-size:13px} .row2.pick{cursor:pointer} .row2.pick:hover .nm{color:var(--p);text-decoration:underline}
.nm{white-space:nowrap;overflow:hidden;text-overflow:ellipsis} .track{height:8px;border-radius:4px;background:var(--line);overflow:hidden} .track i{display:block;height:100%;background:var(--p)}
.days{display:flex;align-items:flex-end;gap:2px;height:80px} .days i{flex:1;min-width:2px;background:var(--p);border-radius:2px 2px 0 0}
.chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 6px 0 10px;border-radius:999px;border:0;background:var(--ps);color:var(--p);font:inherit;font-size:12px;font-weight:700;cursor:pointer}
.state{font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px} .state.live{background:var(--ok);color:var(--okf)} .state.staged{background:var(--warn);color:var(--warnf)} .state.off{background:var(--line);color:var(--soft)}
.rule{display:flex;gap:10px;justify-content:space-between;align-items:flex-start}
.ownr{display:inline-flex;align-items:center;height:22px;padding:0 9px;border-radius:999px;font-size:11.5px;font-weight:700;background:var(--p);color:#fff}
.deny{max-width:520px;margin:60px auto;text-align:center} .deny .ic{width:56px;height:56px;border-radius:50%;background:var(--ps);color:var(--p);display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px} .deny h2{margin:0 0 6px;font-size:20px} .deny p{color:var(--soft);margin:0 0 16px}
@media (max-width:900px){.top{position:relative}}
@media (max-width:640px){.top,main{padding-left:16px;padding-right:16px} .me{margin-left:0} .grid{grid-template-columns:1fr}}
</style></head><body>
<div class="top"><span class="logo"><svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="11" rx="10.5" ry="3.2" fill="none" stroke="currentColor" stroke-width="1.4" opacity=".55"/><path fill="currentColor" d="M12 1.5 6 10l6 12.5L18 10z"/></svg>Aethernet admin</span>
<nav class="tabs" id="tabs"></nav><span class="me"><span class="ownr" id="ownr" style="display:none">Owner</span><span class="lock">Cloudflare Access</span><span>__EMAIL__</span></span></div>
<main id="main"><div class="soft">Loading…</div></main>
<script>
const $ = (s) => document.querySelector(s);
function h(tag, attrs) { const el = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (k === 'html') el.innerHTML = v; else el.setAttribute(k, v === true ? '' : v); }
  for (const c of [].slice.call(arguments, 2).flat(9)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c))); return el; }
async function api(method, path, body) {
  const r = await fetch('/api' + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status); return j;
}
const COLORS = { purple: '#8223d2', blue: '#4a68f9', teal: '#1592a8', green: '#2f9e5b', lime: '#6f9a12', yellow: '#b38f00', orange: '#d9670f', red: '#d1344b', grey: '#5d5e61' };
const CRYSTALS = { cleaningRate: 'Divination', woCleanings: 'Esuna', textNotes: 'Recitation', autoClose: 'Swiftcast', galaxy: 'Macrocosmos', buybacks: 'Bountiful Yield', printLabels: 'Quick Synthesis', glamour: 'Glamour', waymark: 'Waymark', countCheck: 'Lay of the Land', rowColors: 'Rainbow Drip', fixes: "Master's Mend", active: 'Used Aethernet', feedback: 'Feedback', settings: 'Settings' };
const featureLabel = (f) => { const [id, act] = f.split(':'); return (CRYSTALS[id] || id) + (act ? ' · ' + act : ''); };
const fmt = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
const fmtDay = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' });
const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const woLink = (id) => h('a', { href: 'https://portal.ubreakifix.net/repair/workorder/' + id, target: '_blank', rel: 'noopener' }, id + ' ↗');
// Every page there is; the nav shows only the ones GET /api/tracker/me says this person has (owners: all).
// The server refuses the rest on its own (tracker-worker/src/access.js); this only keeps the page honest.
const TABS_ALL = [['reports', 'Reports'], ['usage', 'Usage'], ['stores', 'Stores'], ['auto', 'Auto-Waymark'], ['data', 'Store data'], ['wos', 'Work orders'], ['sales', 'Sales'], ['metrics', 'Metrics'], ['people', 'People']];
let TABS = [], ACCESS = null;
let tab = location.hash.slice(1);
function nav() { $('#tabs').replaceChildren(...TABS.map(([k, l]) => h('button', { class: k === tab ? 'on' : null, onclick: () => { tab = k; location.hash = k; draw(); } }, l))); }
const LOCK_SVG = '<svg width="26" height="26" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2"/></svg>';
function noAccess(m) {
  const name = (TABS_ALL.find(([k]) => k === tab) || [])[1], first = TABS[0];
  m.replaceChildren(h('div', { class: 'card deny' }, h('div', { class: 'ic', html: LOCK_SVG }), h('h2', null, 'You don’t have access to this page'),
    h('p', null, name ? '“' + name + '” isn’t part of your access. If you need it, ask an owner to add it on the People page.' : 'There’s no page at this link.'),
    first ? h('button', { class: 'btn p', onclick: () => { tab = first[0]; location.hash = tab; draw(); } }, 'Go to ' + first[1]) : null,
    h('div', { class: 'soft', style: 'margin-top:16px' }, 'Direct link: /#' + tab + (name ? ' · the server refuses its data too' : ''))));
}
async function draw() {
  const m = $('#main');
  if (!ACCESS) {
    try { ACCESS = (await api('GET', '/tracker/me')).access; } catch (e) { return m.replaceChildren(h('div', { class: 'err' }, "Couldn't load: " + e.message)); }
    if (!ACCESS) return m.replaceChildren(h('div', { class: 'card deny' }, h('div', { class: 'ic', html: LOCK_SVG }), h('h2', null, 'You’re not on the access list yet'), h('p', null, 'Ask an owner to add you on the People page.')));
    TABS = TABS_ALL.filter(([k]) => ACCESS.owner || ACCESS.pages.includes(k));
    $('#ownr').style.display = ACCESS.owner ? '' : 'none';
    if (!tab) tab = (TABS[0] || [''])[0];
  }
  nav();
  if (!TABS.some(([k]) => k === tab)) return noAccess(m); // a direct link to a page they don't have: no API call for it
  m.replaceChildren(h('div', { class: 'soft' }, 'Loading…'));
  try { await ({ reports: drawReports, usage: drawUsage, stores: drawStores, auto: drawAuto, data: drawData, metrics: drawMetrics, wos: (x) => drawTracker('wos', x), sales: (x) => drawTracker('sales', x), people: (x) => drawTracker('people', x) }[tab])(m); }
  catch (e) { m.replaceChildren(h('div', { class: 'err' }, "Couldn't load: " + e.message)); } }
// Metrics: the page itself lands with feat/metrics (metrics-ui); until then the tab only holds its place.
async function drawMetrics(m) { m.replaceChildren(h('div', { class: 'card' }, h('h3', null, 'Metrics'), h('div', { class: 'soft' }, 'Metrics is on its way.'))); }
function toast(t) { const el = h('div', { style: 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--fg);color:var(--bg);padding:10px 16px;border-radius:10px;z-index:9' }, t); document.body.append(el); setTimeout(() => el.remove(), 3500); }

// ---------------------------------------------------------------- Reports
let statusFilter = 'new', nextVersion = null;
const STATUS_OPTS = [['new', 'New'], ['planned', 'Planned'], ['fixed', 'Fixed'], ['wontfix', "Won't fix"]];
const title = (x) => (x === x.toUpperCase() ? x.toLowerCase().replace(/(^|[\s'-])\S/g, (c) => c.toUpperCase()) : x);
const shortName = (n) => { const w = title(String(n || '').trim()).split(/\s+/); return w.length > 1 ? w[0][0].toUpperCase() + '.' + w[w.length - 1] : w[0] || ''; };
async function drawReports(m) {
  const [j, nv] = await Promise.all([api('GET', '/feedback?status=' + statusFilter), nextVersion ? Promise.resolve({ next: nextVersion }) : api('GET', '/next-version').catch(() => ({ next: '' }))]);
  nextVersion = nv.next || '';
  const c = j.counts || {};
  const sel = h('select', { onchange: (e) => { statusFilter = e.target.value; draw(); } }, [...STATUS_OPTS, ['all', 'All']].map(([v, l]) => { const o = h('option', { value: v }, l + (v !== 'all' ? ' (' + (c[v] || 0) + ')' : '')); o.selected = v === statusFilter; return o; }));
  const rep = (r) => {
    const st = h('select', null, STATUS_OPTS.map(([v, l]) => { const o = h('option', { value: v }, l); o.selected = v === r.status; return o; }));
    const note = h('input', { type: 'text', value: r.note || '', placeholder: 'Your note (only you see this)' });
    const save = h('button', { class: 'btn', onclick: async () => { save.disabled = true; try { await api('POST', '/feedback/' + r.id, { status: st.value, note: note.value }); toast('Saved'); } catch (e) { toast("Couldn't save: " + e.message); } save.disabled = false; } }, 'Save');
    const inNotes = h('span', { class: 'in' }, r.fixed_in ? '✓ In v' + r.fixed_in + ' patch notes' : '');
    const qt = h('textarea', { rows: 2, maxlength: 400 }, r.quote || String(r.text || '').trim().slice(0, 300));
    const qc = h('input', { type: 'text', maxlength: 60, value: r.credit || shortName(r.user_name), placeholder: 'Credit (e.g. G.Green)' });
    const qv = h('input', { type: 'text', maxlength: 12, value: r.fixed_in || nextVersion, placeholder: '2.22.0', style: 'width:90px' });
    const q = async (out) => { try { const x = await api('POST', '/feedback/' + r.id, out ? { fixedIn: '' } : { fixedIn: qv.value.trim(), quote: qt.value, credit: qc.value }); r.fixed_in = x.fixedIn; st.value = x.status; inNotes.textContent = x.fixedIn ? '✓ In v' + x.fixedIn + ' patch notes' : ''; toast(out ? 'Taken out of the patch notes' : 'Quoted in v' + x.fixedIn + ' and marked fixed'); } catch (e) { toast("Couldn't save: " + e.message); } };
    let diag = null; try { diag = r.diag ? JSON.parse(r.diag) : null; } catch (_) {}
    return h('div', { class: 'rep' },
      h('div', { class: 'top2' }, h('span', { class: 'kind ' + r.kind }, r.kind === 'bug' ? 'Bug' : 'Idea'), h('b', null, r.user_name || 'Someone'), h('span', { class: 'soft' }, (r.store_name || 'Store') + ' #' + r.store),
        h('span', { class: 'meta' }, fmt(r.created_at) + ' · v' + (r.version || '?') + ' · ' + (r.browser || '') + (r.page ? ' · ' + r.page : ''))),
      h('div', { class: 'txt' }, r.text),
      diag ? h('details', { class: 'soft' }, h('summary', null, 'Technical details'), h('pre', { style: 'white-space:pre-wrap;font:11px ui-monospace,Menlo,monospace' }, JSON.stringify(diag, null, 1))) : null,
      h('div', { class: 'ctl' }, st, note, save),
      r.kind === 'bug' ? h('div', { class: 'q' }, inNotes, ' ', h('details', { style: 'display:inline' }, h('summary', null, 'Quote in patch notes…'),
        h('div', { class: 'row' }, qt), h('div', { class: 'row' }, h('span', { class: 'soft' }, '—'), qc, h('span', { class: 'soft' }, 'at ' + (r.store_name || 'Store') + ' · fixed in v'), qv,
          h('button', { class: 'btn p', onclick: () => q(false) }, 'Quote & mark fixed'), h('button', { class: 'btn', onclick: () => q(true) }, 'Take out')))) : null);
  };
  m.replaceChildren(h('div', { class: 'bar' }, sel, h('span', { class: 'soft' }, "Reporters don't see statuses or notes.")), ...(j.feedback.length ? j.feedback.map(rep) : [h('div', { class: 'soft' }, 'Nothing here.')]));
}

// ---------------------------------------------------------------- Usage (same drill-down as the in-Portal panel)
let days = 30, usage = null, uStore = '', uUser = '', uCrystal = '';
async function drawUsage(m) {
  if (!usage || usage.days !== days) usage = Object.assign(await api('GET', '/usage?days=' + days), { days });
  const all = usage.rows, crystalOf = (r) => r.feature.split(':')[0];
  const storeLabel = new Map(all.map((r) => [String(r.store), (r.store_name ? r.store_name + ' ' : '') + '#' + r.store]));
  const personLabel = new Map(all.map((r) => [String(r.user_id), r.user_name || 'User ' + r.user_id]));
  const personStore = new Map(all.map((r) => [String(r.user_id), storeLabel.get(String(r.store))]));
  if (uStore && !storeLabel.has(uStore)) uStore = ''; if (uUser && !personLabel.has(uUser)) uUser = '';
  const scoped = all.filter((r) => (!uStore || String(r.store) === uStore) && (!uUser || String(r.user_id) === uUser));
  const active = scoped.filter((r) => r.feature === 'active'), rows = scoped.filter((r) => !r.feature.startsWith('active') && (!uCrystal || crystalOf(r) === uCrystal));
  const sum = (arr, f) => { const mm = new Map(); for (const r of arr) { const k = String(f(r)); mm.set(k, (mm.get(k) || 0) + r.count); } return [...mm.entries()].sort((a, b) => b[1] - a[1]); };
  const set = (w, v) => () => { if (w === 'store') { uStore = v; uUser = ''; } else if (w === 'user') uUser = v; else uCrystal = v; draw(); };
  const bars = (en, label, pick) => { const mx = Math.max(1, ...en.map((e) => e[1])); return en.slice(0, 20).map(([k, n]) => h('div', { class: 'row2' + (pick ? ' pick' : ''), onclick: pick ? set(pick, k) : null }, h('div', { class: 'nm' }, label(k)), h('div', { class: 'track' }, h('i', { style: 'width:' + Math.round(n / mx * 100) + '%' })), h('div', { class: 'soft' }, n))); };
  const select = (val, on, first, en) => h('select', { onchange: (e) => on(e.target.value) }, h('option', { value: '' }, first), en.map(([v, l]) => { const o = h('option', { value: v }, l); o.selected = v === val; return o; }));
  const chips = [uStore && h('button', { class: 'chip', onclick: set('store', '') }, storeLabel.get(uStore), ' ×'), uUser && h('button', { class: 'chip', onclick: set('user', '') }, personLabel.get(uUser), ' ×'), uCrystal && h('button', { class: 'chip', onclick: set('crystal', '') }, featureLabel(uCrystal), ' ×')].filter(Boolean);
  const perDay = new Map(sum(rows, (r) => r.day)), dk = []; for (let d = new Date(usage.since + 'T00:00:00'); d <= new Date(); d.setDate(d.getDate() + 1)) dk.push(d.toISOString().slice(0, 10));
  const top = Math.max(1, ...dk.map((k) => perDay.get(k) || 0));
  const card = (t, ...k) => h('div', { class: 'card' }, h('h3', null, t), ...k);
  const mx = scoped.filter((r) => !r.feature.startsWith('active')), cols = sum(uCrystal ? mx.filter((r) => crystalOf(r) === uCrystal) : mx, crystalOf).map(([f]) => f);
  const cell = new Map(); for (const r of mx) { const k = r.user_id + '|' + crystalOf(r); cell.set(k, (cell.get(k) || 0) + r.count); }
  const ppl = sum(uCrystal ? mx.filter((r) => crystalOf(r) === uCrystal) : mx, (r) => r.user_id).map(([id]) => id);
  m.replaceChildren(
    h('div', { class: 'bar' }, select(String(days), (v) => { days = Number(v) || 30; draw(); }, 'Range', [7, 30, 90, 180, 365].map((d) => [String(d), 'Last ' + d + ' days'])),
      select(uStore, (v) => set('store', v)(), 'All stores', [...storeLabel]), select(uUser, (v) => set('user', v)(), 'Everyone', [...personLabel].filter(([id]) => !uStore || all.some((r) => String(r.user_id) === id && String(r.store) === uStore)).map(([id, n]) => [id, uStore ? n : n + ' · ' + personStore.get(id)])),
      select(uCrystal, (v) => set('crystal', v)(), 'All crystals', [...new Set(all.filter((r) => !r.feature.startsWith('active')).map(crystalOf))].map((f) => [f, featureLabel(f)])), ...chips),
    h('div', { class: 'soft', style: 'margin:-4px 0 12px' }, new Set(active.map((r) => r.user_id)).size + ' people active, ' + rows.reduce((n, r) => n + r.count, 0) + ' uses since ' + usage.since + '. Click a store, person or crystal to drill in.'),
    card('Uses per day', h('div', { class: 'days' }, dk.map((k) => h('i', { title: k + ': ' + (perDay.get(k) || 0), style: 'height:' + Math.max(2, Math.round((perDay.get(k) || 0) / top * 100)) + '%' + (perDay.get(k) ? '' : ';opacity:.25') })))),
    h('div', { class: 'grid' },
      uCrystal ? null : card('By crystal', ...bars(sum(rows, crystalOf), featureLabel, 'crystal')),
      card('By action', ...bars(sum(rows, (r) => r.feature), featureLabel)),
      uUser ? null : card('By person', ...bars(sum(rows, (r) => r.user_id), (k) => personLabel.get(k) + (uStore ? '' : ' · ' + personStore.get(k)), 'user')),
      uUser ? null : card('Days active', ...bars(sum(active, (r) => r.user_id), (k) => personLabel.get(k), 'user')),
      uStore || uUser ? null : card('By store', ...bars(sum(rows, (r) => r.store), (k) => storeLabel.get(k), 'store'))),
    cols.length ? h('div', { class: 'card', style: 'margin-top:14px;overflow:auto' }, h('h3', null, 'Who uses what'), h('table', null,
      h('tr', null, h('th', null, 'Person'), cols.map((f) => h('th', { style: 'cursor:pointer', onclick: set('crystal', f) }, CRYSTALS[f] || f))),
      ppl.slice(0, 80).map((id) => h('tr', null, h('td', { style: 'cursor:pointer', onclick: set('user', id) }, personLabel.get(id), h('span', { class: 'soft' }, uStore ? '' : ' · ' + personStore.get(id))),
        cols.map((f) => { const n = cell.get(id + '|' + f) || 0; return h('td', { style: 'text-align:center' + (n ? '' : ';color:var(--line)') }, n || '·'); }))))) : null);
}

// ---------------------------------------------------------------- Stores
async function drawStores(m) {
  const j = await api('GET', '/stores');
  const num = h('input', { type: 'number', placeholder: 'Store #', style: 'width:110px' }), name = h('input', { type: 'text', placeholder: 'Name (optional)' });
  const add = async (store, nm) => { try { await api('POST', '/stores', { store: Number(store), name: nm || '', by: 'Admin site' }); toast('Store #' + store + ' has access'); draw(); } catch (e) { toast("Couldn't add: " + e.message); } };
  m.replaceChildren(
    h('div', { class: 'card' }, h('h3', null, 'Give a store access'), h('div', { class: 'bar', style: 'margin:0' }, num, name, h('button', { class: 'btn p', onclick: () => num.value && add(num.value, name.value) }, 'Add'))),
    h('div', { class: 'card' }, h('h3', null, 'Stores with access (' + j.allowed.length + ')'), h('table', null, h('tr', null, h('th', null, 'Store'), h('th', null, 'Added'), h('th', null, 'Last seen'), h('th', null, 'Loads'), h('th', null, '')),
      j.allowed.map((s) => h('tr', null, h('td', null, h('b', null, (s.name || 'Store') + ' #' + s.store)), h('td', { class: 'soft' }, fmt(s.added_at) + (s.added_by ? ' · ' + s.added_by : '')), h('td', { class: 'soft' }, s.last_at ? fmt(s.last_at) : '—'), h('td', null, s.loads || 0),
        h('td', null, h('button', { class: 'btn', onclick: async () => { if (!confirm('Remove access for #' + s.store + '? Aethernet stops there on its next page load.')) return; await api('POST', '/stores/' + s.store + '/remove', {}); draw(); } }, 'Remove')))))),
    h('div', { class: 'card' }, h('h3', null, 'Waiting for access (' + j.waiting.length + ')'), j.waiting.length ? h('table', null, h('tr', null, h('th', null, 'Store'), h('th', null, 'First seen'), h('th', null, 'Last seen'), h('th', null, 'Last user'), h('th', null, '')),
      j.waiting.map((s) => h('tr', null, h('td', null, h('b', null, (s.name || 'Store') + ' #' + s.store)), h('td', { class: 'soft' }, fmt(s.first_at)), h('td', { class: 'soft' }, fmt(s.last_at)), h('td', { class: 'soft' }, s.last_user || ''),
        h('td', null, h('button', { class: 'btn p', onclick: () => add(s.store, s.name) }, 'Give access'))))) : h('div', { class: 'soft' }, 'No other stores have opened Portal with Aethernet.')));
}

// ---------------------------------------------------------------- Auto-Waymark rules
const RULES = [['rfp', 'Ready for pickup', 'Follow up 3 days after · added after 7 PM · nickname mirrors the date · texting the customer → 3 days from then · push options start at +3 days'],
  ['callback', 'Awaiting callback or device', 'Contact every day: Awaiting callback and Awaiting device · added after 7 PM, due the next day · nickname keeps its text, date replaced or added · texting the customer → tomorrow · push options start at +1 day']];
async function drawAuto(m) {
  const j = await api('GET', '/auto-rules'), st = Object.fromEntries(j.rules.map((r) => [r.rule, r]));
  const stateOf = (k) => (k === 'rfp' ? 'live' : (st[k] && st[k].state) || 'off'), L = { live: 'Live', staged: 'Staged', off: 'Off' };
  const later = RULES.map(([k]) => k).filter((k) => k !== 'rfp'), toStage = later.filter((k) => stateOf(k) === 'off'), toPush = later.filter((k) => stateOf(k) === 'staged');
  const set = async (ks, state) => { for (const k of ks) await api('POST', '/auto-rules', { rule: k, state }); draw(); };
  m.replaceChildren(...RULES.map(([k, n, d]) => h('div', { class: 'card rule' }, h('div', null, h('b', null, n), h('div', { class: 'soft' }, d), st[k] && st[k].stagedAt ? h('div', { class: 'soft' }, 'Staged ' + fmt(st[k].stagedAt) + (st[k].liveAt ? ' · live ' + fmt(st[k].liveAt) : '')) : null), h('span', { class: 'state ' + stateOf(k) }, L[stateOf(k)]))),
    h('div', { class: 'bar' }, h('button', { class: 'btn', disabled: !toStage.length, onclick: () => set(toStage, 'staged') }, 'Stage rule changes'),
      h('button', { class: 'btn p', disabled: !toPush.length, onclick: () => confirm('Make the staged rules live for every store? Their next scan adds marks for work orders already waiting.') && set(toPush, 'live') }, 'Push staged changes')),
    h('div', { class: 'soft' }, "Off: no marks. Staged: only work orders that newly enter the status. Live: all of them, everywhere. The preview of what pushing adds is in Portal's admin panel (it needs Portal's work-order list)."));
}

// ---------------------------------------------------------------- Store data
let dataStore = '', dataScope = 'open';
async function drawData(m) {
  const stores = (await api('GET', '/stores')).allowed;
  if (!dataStore && stores.length) dataStore = String((stores.find((s) => s.store === 914) || stores[0]).store);
  const d = await api('GET', '/store/' + dataStore);
  const closed = new Set(d.closed.map((x) => x.wo)), open = (wo) => dataScope === 'all' || !closed.has(wo);
  const colorOf = Object.fromEntries(d.list.map((t) => [t.name, t.color]));
  const tag = (name) => colorOf[name] ? h('span', { class: 'tag', style: '--c:' + COLORS[colorOf[name]] }, name) : h('span', { class: 'tag one' }, name);
  const byWo = new Map(); for (const t of d.tags) if (open(t.wo)) { if (!byWo.has(t.wo)) byWo.set(t.wo, []); byWo.get(t.wo).push(t); }
  const marks = d.marks.filter((x) => open(x.wo) && (dataScope === 'all' || !x.removedAt));
  const live = marks.filter((x) => !x.removedAt), t = today();
  const markChip = (x) => x.removedAt ? h('span', { class: 'mark gone' }, 'Removed · ' + fmtDay(x.due)) : x.due < t ? h('span', { class: 'mark over' }, 'Overdue · ' + fmtDay(x.due)) : x.due === t ? h('span', { class: 'mark today' }, 'Today · ' + fmtDay(x.due)) : h('span', { class: 'mark up' }, fmtDay(x.due));
  const sel = h('select', { onchange: (e) => { dataStore = e.target.value; draw(); } }, stores.map((s) => { const o = h('option', { value: s.store }, (s.name || 'Store') + ' #' + s.store); o.selected = String(s.store) === dataStore; return o; }));
  const scope = h('select', { onchange: (e) => { dataScope = e.target.value; draw(); } }, [['open', 'Open work orders'], ['all', 'Everything kept (closed WOs too, for 7 days)']].map(([v, l]) => { const o = h('option', { value: v }, l); o.selected = v === dataScope; return o; }));
  const k = (n, l) => h('div', { class: 'card k' }, h('div', { class: 'n' }, n), h('div', { class: 'l', html: l }));
  m.replaceChildren(
    h('div', { class: 'bar' }, sel, scope, h('span', { class: 'soft' }, "Aethernet's data only: Portal isn't visible here, so work orders show as numbers that open in Portal.")),
    h('div', { class: 'sum' }, k(byWo.size, 'Tagged work orders'), k(live.length, 'Auto-Waymarks · <b style="color:#d1344b">' + live.filter((x) => x.due < t).length + ' overdue</b>, ' + live.filter((x) => x.due === t).length + ' due today'), k(d.list.length, 'Tags in the store list'), k(d.links.length, 'Manual cleaning links (30 days)')),
    h('div', { class: 'grid' },
      h('div', { class: 'card' }, h('h3', null, 'Tagged work orders'), byWo.size ? h('table', null, h('tr', null, h('th', null, 'WO #'), h('th', null, 'Tags'), h('th', null, 'Added by'), h('th', null, 'When')),
        [...byWo].map(([wo, ts]) => h('tr', null, h('td', null, woLink(wo), closed.has(wo) ? h('div', { class: 'soft' }, 'closed') : null), h('td', null, ts.map((x) => tag(x.tag))), h('td', null, [...new Set(ts.map((x) => x.by || ''))].join(', ')), h('td', { class: 'soft' }, fmt(ts[0].at))))) : h('div', { class: 'soft' }, 'No tagged work orders.')),
      h('div', { class: 'card' }, h('h3', null, 'Auto-Waymarks'), marks.length ? h('table', null, h('tr', null, h('th', null, 'WO #'), h('th', null, 'Rule'), h('th', null, 'Due')),
        marks.map((x) => h('tr', null, h('td', null, woLink(x.wo)), h('td', null, x.kind === 'callback' ? 'Awaiting callback or device' : 'Ready for pickup'), h('td', null, markChip(x))))) : h('div', { class: 'soft' }, 'No Auto-Waymarks.')),
      h('div', { class: 'card' }, h('h3', null, 'Store tag list'), d.list.length ? d.list.map((x) => tag(x.name)) : h('div', { class: 'soft' }, 'No store tags set up.')),
      h('div', { class: 'card' }, h('h3', null, 'Divination: manual cleaning links'), d.links.length ? h('table', null, h('tr', null, h('th', null, 'Day'), h('th', null, 'Phone'), h('th', null, 'Counted for WO'), h('th', null, 'By')),
        d.links.map((x) => h('tr', null, h('td', null, fmtDay(x.day)), h('td', { class: 'soft' }, x.device.length > 12 ? x.device.slice(0, 8) + '…' + x.device.slice(-6) : x.device), h('td', null, woLink(x.parent)), h('td', null, x.by || '')))) : h('div', { class: 'soft' }, 'No manual links in the last 30 days.'))));
}
// Work orders + People: the tracker UI (tracker-ui.js), loaded on first use. Unlocking happens there, in this browser.
async function drawTracker(which, m) {
  const mod = await import('/tracker-ui.js');
  await mod.draw(which, m, { h, api, toast, fmt, woLink, tab: () => tab, redraw: draw });
}
addEventListener('hashchange', () => { const t = location.hash.slice(1); if (t && t !== tab) { tab = t; draw(); } });
draw();
</script></body></html>`;
