// Admin site: the Metrics page. Served at /metrics-ui.js and loaded by page.js when the Metrics tab opens.
// One request (/api/tracker/metrics) returns every panel's numbers per store; this file sums for "All stores",
// splits by store on request, and draws the charts as inline SVG (no chart library; the page's CSP stays tight).
// Range, store and view live in the URL hash (#metrics?store=326&range=30&split=1&cmp=1) so links can be shared.

const CSS = `
.mx{--grid:#efeef2;--axis:#cfcdd4;--hd:#faf9fb;--muted:#7c7b80;--all:#8223d2;--s914:#2a78d6;--s326:#eb6834;--s536:#1baf7a;--s1276:#eda100;--ghost:#a3a2a8;
  --b1:#e34948;--b2:#6250d6;--b3:#008300;--b4:#e87ba4;--b5:#c4c3c9;--good:#0ca30c;--warning:#fab219;--critical:#d03b3b;--up:#006300;--down:#b3261e}
@media (prefers-color-scheme:dark){.mx{--grid:#26252a;--axis:#3d3c42;--hd:#211f26;--muted:#8b8a90;--all:#a66cf0;--s914:#3987e5;--s326:#d95926;--s536:#199e70;--s1276:#c98500;--ghost:#6c6b71;
  --b1:#e66767;--b2:#9085e9;--b3:#008300;--b4:#d55181;--b5:#55545a;--up:#0ca30c;--down:#e66767}}
.mx .ctl{position:sticky;top:60px;z-index:4;display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 12px;margin:0 0 14px;background:var(--card);border:1px solid var(--line);border-radius:12px}
.mx select{height:34px}
.mx .seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;height:34px} .mx .seg button{border:0;border-right:1px solid var(--line);background:var(--card);color:var(--soft);font:inherit;font-size:13px;padding:0 10px;cursor:pointer} .mx .seg button:last-child{border-right:0} .mx .seg button.on{background:var(--ps);color:var(--p);font-weight:700} .mx .seg button:disabled{opacity:.4;cursor:default}
.mx .rbtn{display:inline-flex;align-items:center;gap:8px;height:34px;padding:0 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font:inherit;font-size:13px;cursor:pointer} .mx .rbtn b{font-weight:700}
.mx .tg{display:inline-flex;align-items:center;gap:7px;font-size:13px;color:var(--fg);cursor:pointer;user-select:none;padding:0 4px} .mx .tg input{display:none} .mx .tg i{width:30px;height:18px;border-radius:9px;background:var(--axis);position:relative;transition:.15s} .mx .tg i:after{content:'';position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:.15s} .mx .tg input:checked+i{background:var(--p)} .mx .tg input:checked+i:after{left:14px} .mx .tg.dis{opacity:.4;cursor:default}
.mx .fresh{margin-left:auto;font-size:12px;color:var(--soft);display:flex;align-items:center;gap:6px}
.mx-pop{position:absolute;z-index:30;width:300px;background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.18);padding:6px;font-size:13px}
.mx-pop .row{display:flex;align-items:center;gap:8px;height:34px;padding:0 10px;border-radius:8px;cursor:pointer} .mx-pop .row:hover{background:var(--ps)} .mx-pop .row .ck{width:16px;font-weight:700;color:var(--p)} .mx-pop .row .soft{margin-left:auto}
.mx-pop .foot{border-top:1px solid var(--line);margin-top:6px;padding:10px 8px 6px;display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;color:var(--soft)} .mx-pop .foot input{width:100%;height:32px;font-size:13px} .mx-pop .foot .go{grid-column:1/-1;display:flex;justify-content:flex-end;gap:6px} .mx-pop .btn{height:32px;font-size:13px}
.mx .sec{display:flex;align-items:baseline;gap:10px;margin:22px 2px 8px;flex-wrap:wrap} .mx .sec h2{margin:0;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--soft)} .mx .sec .soft{font-size:12px}
.mx .sec:first-of-type{margin-top:4px}
.mx .g{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:10px}
.mx .s3{grid-column:span 3}.mx .s4{grid-column:span 4}.mx .s6{grid-column:span 6}.mx .s8{grid-column:span 8}.mx .s12{grid-column:span 12}
@media (max-width:1100px){.mx .s3{grid-column:span 6}.mx .s4{grid-column:span 6}.mx .s8{grid-column:span 12}}
@media (max-width:700px){.mx .g{grid-template-columns:1fr 1fr;gap:8px}.mx .s3{grid-column:span 1}.mx .s4,.mx .s6,.mx .s8,.mx .s12{grid-column:span 2} .mx .tile .big{font-size:22px} .mx .tile .sub .dlt+span{display:none} .mx .tile header .pill.need,.mx .tile header .pill.prev{display:none} .mx .ctl{top:0;position:relative} .mx .fresh{margin-left:0;width:100%} .mx .tile .split-row{display:none} .mx .tile header .u .u{display:none} body:has(.mx) .top{position:relative}}
.mx .pn{background:var(--card);border:1px solid var(--line);border-radius:10px;min-width:0;display:flex;flex-direction:column;overflow:hidden}
.mx .pn>header{display:flex;align-items:center;gap:8px;padding:7px 10px 7px 12px;background:var(--hd);border-bottom:1px solid var(--line);min-height:36px}
.mx .pn>header h4{margin:0;font-size:12.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mx .pn>header .v{margin-left:auto;font-weight:700;font-size:13px;white-space:nowrap} .mx .pn>header .u{color:var(--soft);font-size:11.5px;white-space:nowrap}
.mx .pn>header .ic{border:0;background:none;color:var(--muted);cursor:pointer;width:24px;height:24px;border-radius:6px;font-size:13px;line-height:24px;padding:0;flex:none} .mx .pn>header .ic:hover,.mx .pn>header .ic.on{background:var(--ps);color:var(--p)}
.mx .pn .body{padding:8px 10px;flex:1;min-height:0;position:relative}
.mx .lg{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11.5px;color:var(--soft);padding:0 2px 4px} .mx .lg span{display:inline-flex;align-items:center;gap:5px} .mx .lg i{width:10px;height:10px;border-radius:3px;display:inline-block} .mx .lg i.ln{height:3px;border-radius:2px;width:14px} .mx .lg i.cmp{height:2px;width:14px;opacity:.45}
.mx .note{font-size:11.5px;color:var(--soft);padding:2px 2px 0}
.mx svg text{font:11px Apercu,"Helvetica Neue",Helvetica,Arial,sans-serif;fill:var(--muted);font-variant-numeric:tabular-nums} .mx svg .dl{fill:var(--soft);font-weight:700}
.mx .tile .body{display:flex;flex-direction:column;justify-content:space-between;gap:2px;padding:10px 12px 8px}
.mx .big{font-size:27px;font-weight:700;line-height:1.1;letter-spacing:-.01em} .mx .big small{font-size:14px;color:var(--soft);font-weight:400;margin-left:4px}
.mx .tile .sub{font-size:12px;color:var(--soft);display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.mx .dlt{font-weight:700;font-size:12px} .mx .dlt.up{color:var(--up)} .mx .dlt.down{color:var(--down)} .mx .dlt.flat{color:var(--soft)}
.mx .split-row{display:flex;gap:10px;flex-wrap:wrap;font-size:11.5px;color:var(--soft);margin-top:2px} .mx .split-row span{display:inline-flex;align-items:center;gap:4px} .mx .split-row i{width:8px;height:8px;border-radius:2px}
.mx .empty{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:6px;min-height:120px;color:var(--soft);font-size:12.5px;padding:10px 16px;border-radius:8px;background:color-mix(in srgb,var(--grid) 45%,transparent)}
.mx .empty b{color:var(--fg);font-size:13px} .mx .empty .btn{margin-top:4px}
.mx .pill{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:11px;font-weight:700;white-space:nowrap}
.mx .pill.need{background:var(--warn);color:var(--warnf)} .mx .pill.soon{background:var(--ps);color:var(--all)} .mx .pill.now{background:var(--line);color:var(--soft)}
.mx table{font-size:12.5px} .mx th{font-size:11.5px;padding:5px 6px} .mx td{padding:6px;font-variant-numeric:tabular-nums} .mx tr:last-child td{border-bottom:0}
.mx .tv{max-height:220px;overflow:auto}
.mx .stt{display:inline-flex;align-items:center;gap:5px;font-weight:700;font-size:12px} .mx .stt svg{flex:none}
.mx .wm{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:6px 0 8px} .mx .wm .big{font-size:24px}
#mx-tt{position:fixed;z-index:50;pointer-events:none;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.18);padding:7px 10px;font-size:12px;min-width:140px;display:none}
#mx-tt .h{font-weight:700;margin-bottom:4px} #mx-tt .r{display:flex;align-items:center;gap:6px;line-height:1.6} #mx-tt .r i{width:9px;height:9px;border-radius:2px;flex:none} #mx-tt .r b{margin-left:auto;padding-left:14px;font-variant-numeric:tabular-nums} #mx-tt .r.c{color:var(--soft)}
`;

const TZ = 'America/New_York';
const STORE_ORDER = [914, 326, 536, 1276]; // fixed color order (blue, orange, aqua, yellow); color follows the store everywhere
const CRYSTALS = { cleaningRate: 'Divination', woCleanings: 'Esuna', textNotes: 'Recitation', autoClose: 'Swiftcast', checkinDrafts: 'Return', leadReplies: 'Provoke', galaxy: 'Macrocosmos', glamour: 'Glamour',
  buybacks: 'Bountiful Yield', countCheck: 'Lay of the Land', waymark: 'Waymark', fixes: "Master's Mend", timeSheet: 'Tactician', assize: 'Assize', decipher: 'Decipher', printLabels: 'Quick Synthesis', rowColors: 'Rainbow Drip', reassemble: 'Reassemble' };
const PRESETS = [['today', 'Today'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['month', 'This month'], ['lastmonth', 'Last month'], ['year', 'Year to date']];

// ------------------------------------------------------------------ formatting
const FMT = {
  money: (v) => v == null ? '—' : '$' + Math.round(v).toLocaleString('en-US'),
  moneyS: (v) => v == null ? '—' : Math.abs(v) >= 10000 ? '$' + (v / 1000).toFixed(Math.abs(v) >= 100000 ? 0 : 1) + 'k' : '$' + Math.round(v).toLocaleString('en-US'),
  money2: (v) => v == null ? '—' : '$' + v.toFixed(2), int: (v) => v == null ? '—' : Math.round(v).toLocaleString('en-US'),
  pct: (v) => v == null ? '—' : Math.round(v * 100) + '%', days: (v) => v == null ? '—' : v.toFixed(1) + ' d', hours: (v) => v == null ? '—' : (Math.round(v * 10) / 10).toLocaleString('en-US') + ' h',
};
const axisFmt = (fmt) => fmt === 'money' || fmt === 'money2' ? FMT.moneyS : fmt === 'pct' ? FMT.pct : fmt === 'days' ? (v) => v.toFixed(0) + 'd' : fmt === 'hours' ? (v) => Math.round(v) + 'h' : FMT.int;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const D = (day) => new Date(day + 'T12:00:00Z');
const fmtD = (day) => D(day).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const fmtLong = (day) => D(day).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const hourLabel = (h) => (h % 12 || 12) + (h < 12 ? ' AM' : ' PM');
const timeOf = (iso) => iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ }) : '';
const ago = (min) => min == null ? 'never' : min < 60 ? min + ' min' : min < 48 * 60 ? Math.round(min / 60) + ' h' : Math.round(min / 1440) + ' d';
const addDays = (day, n) => { const d = D(day); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const span = (a, b) => Math.round((D(b) - D(a)) / 864e5) + 1;
const todayET = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const ICON = {
  good: '<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="6" fill="var(--good)"/><path d="M3.4 6.2l1.8 1.8 3.4-3.6" stroke="#fff" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>',
  warning: '<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="6" fill="var(--warning)"/><path d="M6 3v3l2 1.4" stroke="#3a3000" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>',
  critical: '<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="6" fill="var(--critical)"/><path d="M6 3v3.5M6 8.6v.1" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>',
  closed: '<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5.25" fill="none" stroke="var(--soft)" stroke-width="1.5"/><path d="M3.8 6h4.4" stroke="var(--soft)" stroke-width="1.5" stroke-linecap="round"/></svg>',
};
const STATE_LABEL = { good: 'Live', warning: 'Stale', critical: 'Stopped', closed: 'Store closed' };

// ------------------------------------------------------------------ state (URL hash)
const S = { store: 'all', range: '30', from: null, to: null, gran: 'auto', split: false, compare: false };
function readHash() {
  const q = new URLSearchParams((location.hash.split('?')[1]) || '');
  if (q.get('store')) S.store = q.get('store');
  if (q.get('range') && (PRESETS.some((p) => p[0] === q.get('range')) || q.get('range') === 'custom')) S.range = q.get('range');
  if (/^\d{4}-\d\d-\d\d$/.test(q.get('from') || '') && /^\d{4}-\d\d-\d\d$/.test(q.get('to') || '')) { S.from = q.get('from'); S.to = q.get('to'); }
  else if (S.range === 'custom') S.range = '30';
  if (['auto', 'hour', 'day', 'week'].includes(q.get('gran'))) S.gran = q.get('gran');
  S.split = q.get('split') === '1'; S.compare = q.get('cmp') === '1';
}
function writeHash() {
  const q = new URLSearchParams({ store: S.store, range: S.range });
  if (S.range === 'custom') { q.set('from', S.from); q.set('to', S.to); }
  if (S.gran !== 'auto') q.set('gran', S.gran);
  if (S.split) q.set('split', '1');
  if (S.compare) q.set('cmp', '1');
  history.replaceState(null, '', '#metrics?' + q.toString());
}
function rangeOf(key = S.range) { // → [from, to] (store-local days)
  const t = todayET(), [y, m] = t.split('-').map(Number);
  switch (key) {
    case 'today': return [t, t];
    case '7': return [addDays(t, -6), t]; case '30': return [addDays(t, -29), t]; case '90': return [addDays(t, -89), t];
    case 'month': return [t.slice(0, 8) + '01', t];
    case 'lastmonth': { const first = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10); return [first, addDays(t.slice(0, 8) + '01', -1)]; }
    case 'year': return [y + '-01-01', t];
    case 'custom': return [S.from, S.to];
  }
  return [addDays(t, -29), t];
}
const splitting = () => S.split && S.store === 'all';
// Auto: ≤ 2 days → hour, ≤ 92 → day (split by store: ≤ 31, four daily lines get noisy), longer → week. Hour only up to 7 days; week from 14.
function granOf(n) { if (S.gran === 'hour' && n <= 7) return 'hour'; if (S.gran === 'week' && n >= 14) return 'week'; if (S.gran === 'day') return 'day'; return n <= 2 ? 'hour' : n <= (splitting() ? 31 : 92) ? 'day' : 'week'; }

// ------------------------------------------------------------------ data access
let R = null, H = null, root = null;
const ids = () => (S.store === 'all' ? R.selected : [Number(S.store)]);
const storeName = (id) => (R.stores.find((s) => s.id === id) || {}).name || 'Store';
const colorOf = (id) => STORE_ORDER.includes(id) ? 'var(--s' + id + ')' : 'var(--ghost)';
const scopeColor = () => (S.store === 'all' ? 'var(--all)' : colorOf(Number(S.store)));
const scopeName = () => (S.store === 'all' ? 'All stores' : S.store + ' ' + storeName(Number(S.store)));
// flow: summed; level: point in time (summed across stores); ratio: pooled numerator ÷ denominator (never an average of rates)
const M = {
  sales: { t: 'flow', g: 'main', fmt: 'money' }, count: { t: 'flow', g: 'main', fmt: 'int' }, ticket: { t: 'ratio', g: 'main', n: 'saleTotal', d: 'count', fmt: 'money2' },
  splh: { t: 'ratio', g: 'day', n: 'salesLab', d: 'labor', fmt: 'money' }, labor: { t: 'flow', g: 'day', fmt: 'hours' },
  created: { t: 'flow', g: 'main', fmt: 'int' }, completed: { t: 'flow', g: 'main', fmt: 'int' },
  ck: { t: 'ratio', g: 'main', n: 'ckSum', d: 'ckN', fmt: 'days' }, rp: { t: 'ratio', g: 'main', n: 'rpSum', d: 'rpN', fmt: 'days' },
  open: { t: 'level', g: 'main', fmt: 'int' }, bench: { t: 'level', g: 'main', fmt: 'int' }, parts: { t: 'level', g: 'main', fmt: 'int' }, wait: { t: 'level', g: 'main', fmt: 'int' }, rfp: { t: 'level', g: 'main', fmt: 'int' }, other: { t: 'level', g: 'main', fmt: 'int' },
  nto: { t: 'level', g: 'day', fmt: 'int' }, assizeFail: { t: 'flow', g: 'day', fmt: 'int' }, assizeFlag: { t: 'flow', g: 'day', fmt: 'int' },
  am: { t: 'flow', g: 'day', fmt: 'int' }, cln: { t: 'flow', g: 'day', fmt: 'int' }, rate: { t: 'ratio', g: 'day', n: 'cln', d: 'am', fmt: 'pct' },
  uses: { t: 'flow', g: 'day', fmt: 'int' }, active: { t: 'level', g: 'day', fmt: 'int' },
};
const raw = (p, g, k, st) => { const P = R[p]; return P && P[g] && P[g][k] ? P[g][k][st] : null; };
function sumAt(p, g, k, list, i) { let s = 0, any = false; for (const st of list) { const a = raw(p, g, k, st); const v = a ? a[i] : null; if (v != null) { s += v; any = true; } } return any ? s : null; }
function val(key, list, i, p = 'cur') { // one bucket
  const m = M[key];
  if (key === 'active' && list.length > 1) return sumAt(p, 'day', 'active', ['all'], i); // distinct people across the stores
  if (m.t === 'ratio') { const n = sumAt(p, m.g, m.n, list, i), d = sumAt(p, m.g, m.d, list, i); return d ? n / d : null; }
  return sumAt(p, m.g, key, list, i);
}
function totK(p, k, list) { const o = (R.tot[p] || {})[k] || {}; let s = 0, any = false; for (const st of list) if (o[st] != null) { s += o[st]; any = true; } return any ? s : null; }
function tot(key, list, p = 'cur') { // whole period (flows), latest (levels)
  const m = M[key];
  if (key === 'active' && list.length > 1) return totK(p, 'active', ['all']);
  if (m.t === 'ratio') { const n = totK(p, m.n, list), d = totK(p, m.d, list); return d ? n / d : null; }
  return totK(p, key, list);
}
const gridOf = (key) => R.grid[M[key].g];
function seriesFor(key, opts = {}) { // one series (scope) or one per store when split
  const grid = gridOf(key);
  if (splitting() && !opts.noSplit) return R.selected.map((st) => ({ name: st + ' ' + storeName(st), short: st + ' ' + storeName(st).split(' ')[0], color: colorOf(st), values: grid.map((_, i) => val(key, [st], i)) }));
  return [{ name: opts.name || scopeName(), color: opts.color || scopeColor(), values: grid.map((_, i) => val(key, ids(), i)), cmp: S.compare && R.prev && !opts.noCmp ? grid.map((_, i) => val(key, ids(), i, 'prev')) : null }];
}
function labels(grid, g) {
  return grid.map((b) => {
    if (b.hour != null) return { label: hourLabel(b.hour), long: (R.days > 1 ? fmtD(b.from) + ' ' : '') + hourLabel(b.hour), future: b.future, partial: b.partial };
    if (g === 'week') return { label: fmtD(b.from), long: 'Week of ' + fmtD(b.from) + (span(b.from, b.to) < 7 ? ' (partial)' : ''), partial: b.partial };
    return { label: fmtD(b.from), long: fmtLong(b.from) + (b.partial ? ' (so far)' : ''), partial: b.partial };
  });
}
const xOf = (key) => labels(gridOf(key), M[key].g === 'day' && R.gran === 'hour' ? 'day' : R.gran);

// ------------------------------------------------------------------ chart primitives (inline SVG)
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.append(e); return e; };
function nice(max) { if (!(max > 0)) return [0, 1, 0.25]; const raw = max / 4, p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p, step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p; return [0, Math.ceil(max / step) * step, step]; }
let tt = null;
function showTT(ev, html) { tt.innerHTML = html; tt.style.display = 'block'; const w = tt.offsetWidth, h = tt.offsetHeight; let x = ev.clientX + 14, y = ev.clientY + 14; if (x + w > innerWidth - 8) x = ev.clientX - w - 14; if (y + h > innerHeight - 8) y = ev.clientY - h - 14; tt.style.left = Math.max(8, x) + 'px'; tt.style.top = Math.max(8, y) + 'px'; }
const hideTT = () => { if (tt) tt.style.display = 'none'; };
function xTicks(n, w) { const want = Math.max(2, Math.floor(w / 80)), step = Math.max(1, Math.ceil(n / want)); const out = []; for (let i = 0; i < n; i += step) out.push(i); return out; }
const ttRow = (color, name, v, cls) => `<div class="r${cls ? ' ' + cls : ''}"><i style="background:${color}${cls ? ';opacity:.35' : ''}"></i>${esc(name)}<b>${v}</b></div>`;

// line / area. series: [{name, color, values, cmp?}]
function lineChart(box, o) {
  const W = box.clientWidth, H0 = o.h || 170, dl = o.direct && W > 500 && o.series.length > 1 && o.series.length <= 4; // phones: legend only
  const m = { l: 42, r: dl ? 92 : 10, t: 8, b: 22 }, iw = Math.max(10, W - m.l - m.r), ih = H0 - m.t - m.b;
  const all = o.series.flatMap((s) => [...s.values, ...(s.cmp || [])]).filter((v) => v != null);
  const [y0, y1, step] = nice(Math.max(...all, o.target || 0, 0) * 1.05);
  const svg = el('svg', { width: W, height: H0, viewBox: `0 0 ${W} ${H0}`, role: 'img', 'aria-label': o.label || '' }, box);
  const n = o.x.length, X = (i) => m.l + (n === 1 ? iw / 2 : (i / (n - 1)) * iw), Y = (v) => m.t + ih - (v - y0) / (y1 - y0) * ih, af = axisFmt(o.fmt);
  for (let v = y0; v <= y1 + 1e-9; v += step) { el('line', { x1: m.l, x2: m.l + iw, y1: Y(v), y2: Y(v), stroke: v === 0 ? 'var(--axis)' : 'var(--grid)', 'stroke-width': 1 }, svg); el('text', { x: m.l - 6, y: Y(v) + 4, 'text-anchor': 'end' }, svg).textContent = af(v); }
  for (const i of xTicks(n, iw)) el('text', { x: X(i), y: H0 - 6, 'text-anchor': i === 0 && n > 1 ? 'start' : X(i) > m.l + iw - 24 ? 'end' : 'middle' }, svg).textContent = o.x[i].label;
  if (o.target != null) el('line', { x1: m.l, x2: m.l + iw, y1: Y(o.target), y2: Y(o.target), stroke: 'var(--soft)', 'stroke-width': 1, opacity: .7 }, svg);
  const path = (vals) => { let d = '', pen = false; vals.forEach((v, i) => { if (v == null) { pen = false; return; } d += (pen ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); pen = true; }); return d; };
  for (const s of o.series) if (s.cmp) el('path', { d: path(s.cmp), fill: 'none', stroke: s.color, 'stroke-width': 1.5, opacity: .32, 'stroke-linejoin': 'round' }, svg);
  if (o.area && o.series.length === 1) { const s = o.series[0], idx = s.values.map((v, i) => v == null ? -1 : i).filter((i) => i >= 0); if (idx.length > 1) el('path', { d: path(s.values) + `L${X(idx[idx.length - 1])} ${Y(0)}L${X(idx[0])} ${Y(0)}Z`, fill: s.color, opacity: .12 }, svg); }
  for (const s of o.series) {
    el('path', { d: path(s.values), fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
    // single points (isolated by gaps) and the partial last point (today so far: hollow)
    s.values.forEach((v, i) => { if (v == null) return; const lone = (i === 0 || s.values[i - 1] == null) && (i === n - 1 || s.values[i + 1] == null), part = o.x[i].partial && i === n - 1 && n > 1;
      if (lone || part) el('circle', { cx: X(i), cy: Y(v), r: part ? 3.5 : 3, fill: part ? 'var(--card)' : s.color, stroke: s.color, 'stroke-width': 2 }, svg); });
  }
  if (dl) { // direct labels at line ends, pushed apart
    const ends = o.series.map((s) => { let i = s.values.length - 1; while (i >= 0 && s.values[i] == null) i--; return { s, y: i >= 0 ? Y(s.values[i]) : m.t }; }).sort((a, b) => a.y - b.y);
    for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 13) ends[k].y = ends[k - 1].y + 13;
    for (const e of ends) el('text', { x: m.l + iw + 6, y: e.y + 4, class: 'dl' }, svg).textContent = e.s.short || e.s.name;
  }
  const g = el('g', { style: 'pointer-events:none' }, svg), hit = el('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' }, svg);
  hit.addEventListener('mousemove', (ev) => {
    const r = svg.getBoundingClientRect(), i = Math.max(0, Math.min(n - 1, Math.round((ev.clientX - r.left - m.l) / iw * (n - 1))));
    g.replaceChildren(); el('line', { x1: X(i), x2: X(i), y1: m.t, y2: m.t + ih, stroke: 'var(--soft)', 'stroke-width': 1, opacity: .6 }, g);
    let html = '<div class="h">' + esc(o.x[i].long) + '</div>';
    for (const s of o.series) { const v = s.values[i]; if (v != null) el('circle', { cx: X(i), cy: Y(v), r: 4, fill: s.color, stroke: 'var(--card)', 'stroke-width': 2 }, g); html += ttRow(s.color, s.name, FMT[o.fmt](v)); if (s.cmp) html += ttRow(s.color, 'Previous period', FMT[o.fmt](s.cmp[i]), 'c'); }
    if (o.note) { const t = o.note(i); if (t) html += `<div class="r c">${esc(t)}</div>`; }
    showTT(ev, html);
  });
  hit.addEventListener('mouseleave', () => { g.replaceChildren(); hideTT(); });
}
// vertical bars; series stacked (split by store) or grouped (2 measures)
function barChart(box, o) {
  const W = box.clientWidth, H0 = o.h || 170, m = { l: 42, r: 10, t: 8, b: 22 }, iw = Math.max(10, W - m.l - m.r), ih = H0 - m.t - m.b, n = o.x.length;
  const tot = o.x.map((_, i) => o.stack ? o.series.reduce((a, s) => a + (s.values[i] || 0), 0) : Math.max(...o.series.map((s) => s.values[i] || 0)));
  const [y0, y1, step] = nice(Math.max(...tot, ...(o.series[0].cmp || []).filter((v) => v != null), 0) * 1.05), af = axisFmt(o.fmt);
  const svg = el('svg', { width: W, height: H0, viewBox: `0 0 ${W} ${H0}`, role: 'img' }, box), Y = (v) => m.t + ih - v / (y1 - y0) * ih;
  for (let v = y0; v <= y1 + 1e-9; v += step) { el('line', { x1: m.l, x2: m.l + iw, y1: Y(v), y2: Y(v), stroke: v === 0 ? 'var(--axis)' : 'var(--grid)' }, svg); el('text', { x: m.l - 6, y: Y(v) + 4, 'text-anchor': 'end' }, svg).textContent = af(v); }
  const bw = iw / n, gap = Math.min(2, bw * .25), groups = o.stack ? 1 : o.series.length, inner = Math.max(1, Math.min(48, (bw - gap) / groups - (groups > 1 ? 1 : 0)));
  const off = (bw - gap - (inner + (groups > 1 ? 1 : 0)) * groups) / 2; // center narrow bars in their slot
  const Rp = (x, y, w, h, r) => { r = Math.min(r, w / 2, h); return h <= 0 ? '' : `M${x} ${y + h}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h}Z`; };
  for (let i = 0; i < n; i++) {
    let base = 0;
    const topK = o.series.map((t, j) => (t.values[i] > 0 ? j : -1)).reduce((a, b) => Math.max(a, b), -1);
    o.series.forEach((s, k) => { const v = s.values[i]; if (v == null || v <= 0) return; const x = m.l + i * bw + gap / 2 + Math.max(0, off) + (o.stack ? 0 : k * (inner + 1)), top = o.stack ? Y(base + v) : Y(v), bot = o.stack ? Y(base) : Y(0);
      const isTop = !o.stack || k === topK, hgt = bot - top - (o.stack && base > 0 ? 2 : 0);
      el('path', { d: isTop ? Rp(x, top, inner, hgt, 3) : `M${x} ${top}H${x + inner}V${top + Math.max(0, hgt)}H${x}Z`, fill: s.color, opacity: o.x[i].partial && n > 1 ? .55 : 1 }, svg);
      if (o.stack) base += v; });
    if (o.series[0].cmp && o.series[0].cmp[i] != null) { const y = Y(o.series[0].cmp[i]); el('line', { x1: m.l + i * bw + gap / 2, x2: m.l + (i + 1) * bw - gap / 2, y1: y, y2: y, stroke: 'var(--fg)', 'stroke-width': 1.5, opacity: .35 }, svg); }
  }
  for (const i of xTicks(n, iw)) el('text', { x: m.l + i * bw + bw / 2, y: H0 - 6, 'text-anchor': i === 0 && n > 1 ? 'start' : 'middle' }, svg).textContent = o.x[i].label;
  const hl = el('rect', { y: m.t, height: ih, fill: 'var(--fg)', opacity: 0, style: 'pointer-events:none' }, svg), hit = el('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' }, svg);
  hit.addEventListener('mousemove', (ev) => { const r = svg.getBoundingClientRect(), i = Math.max(0, Math.min(n - 1, Math.floor((ev.clientX - r.left - m.l) / bw)));
    hl.setAttribute('x', m.l + i * bw); hl.setAttribute('width', bw); hl.setAttribute('opacity', .05);
    let html = '<div class="h">' + esc(o.x[i].long) + '</div>' + o.series.map((s) => ttRow(s.color, s.name, FMT[o.fmt](s.values[i]))).join('');
    if (o.stack && o.series.length > 1) html += `<div class="r"><i></i>Total<b>${FMT[o.fmt](tot[i])}</b></div>`;
    if (o.series[0].cmp) html += ttRow('var(--fg)', 'Previous period', FMT[o.fmt](o.series[0].cmp[i]), 'c');
    if (o.note) { const t = o.note(i); if (t) html += `<div class="r c">${esc(t)}</div>`; }
    showTT(ev, html); });
  hit.addEventListener('mouseleave', () => { hl.setAttribute('opacity', 0); hideTT(); });
}
// stacked area (bottom → top)
function stackChart(box, o) {
  const W = box.clientWidth, H0 = o.h || 170, m = { l: 42, r: 10, t: 8, b: 22 }, iw = Math.max(10, W - m.l - m.r), ih = H0 - m.t - m.b, n = o.x.length;
  const tot = o.x.map((_, i) => o.series.some((s) => s.values[i] != null) ? o.series.reduce((a, s) => a + (s.values[i] || 0), 0) : null), [y0, y1, step] = nice(Math.max(0, ...tot.filter((v) => v != null)) * 1.05);
  const svg = el('svg', { width: W, height: H0, viewBox: `0 0 ${W} ${H0}`, role: 'img' }, box), X = (i) => m.l + (n === 1 ? iw / 2 : i / (n - 1) * iw), Y = (v) => m.t + ih - v / (y1 - y0) * ih;
  for (let v = y0; v <= y1 + 1e-9; v += step) { el('line', { x1: m.l, x2: m.l + iw, y1: Y(v), y2: Y(v), stroke: v === 0 ? 'var(--axis)' : 'var(--grid)' }, svg); el('text', { x: m.l - 6, y: Y(v) + 4, 'text-anchor': 'end' }, svg).textContent = FMT.int(v); }
  // runs of buckets with data (gaps before tracking / future hours)
  const runs = []; let cur = null; tot.forEach((v, i) => { if (v == null) { cur = null; return; } if (!cur) runs.push((cur = [])); cur.push(i); });
  const base = o.x.map(() => 0);
  for (const s of o.series) {
    const top = base.map((b, i) => b + (s.values[i] || 0));
    for (const run of runs) {
      const pts = run.length === 1 ? [[X(run[0]) - 3, run[0]], [X(run[0]) + 3, run[0]]] : run.map((i) => [X(i), i]);
      const d = 'M' + pts.map(([x, i]) => x.toFixed(1) + ' ' + Y(top[i]).toFixed(1)).join('L') + 'L' + pts.slice().reverse().map(([x, i]) => x.toFixed(1) + ' ' + Y(base[i]).toFixed(1)).join('L') + 'Z';
      el('path', { d, fill: s.color, opacity: .85 }, svg);
      el('path', { d: 'M' + pts.map(([x, i]) => x.toFixed(1) + ' ' + Y(top[i]).toFixed(1)).join('L'), fill: 'none', stroke: 'var(--card)', 'stroke-width': 1.5 }, svg);
    }
    top.forEach((v, i) => (base[i] = v));
  }
  for (const i of xTicks(n, iw)) el('text', { x: X(i), y: H0 - 6, 'text-anchor': i === 0 && n > 1 ? 'start' : X(i) > m.l + iw - 24 ? 'end' : 'middle' }, svg).textContent = o.x[i].label;
  const g = el('g', { style: 'pointer-events:none' }, svg), hit = el('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' }, svg);
  hit.addEventListener('mousemove', (ev) => { const r = svg.getBoundingClientRect(), i = Math.max(0, Math.min(n - 1, Math.round((ev.clientX - r.left - m.l) / iw * (n - 1))));
    g.replaceChildren(); el('line', { x1: X(i), x2: X(i), y1: m.t, y2: m.t + ih, stroke: 'var(--fg)', 'stroke-width': 1, opacity: .5 }, g);
    showTT(ev, '<div class="h">' + esc(o.x[i].long) + '</div>' + [...o.series].reverse().map((s) => ttRow(s.color, s.name, FMT.int(s.values[i]))).join('') + `<div class="r"><i></i>Open<b>${FMT.int(tot[i])}</b></div>`); });
  hit.addEventListener('mouseleave', () => { g.replaceChildren(); hideTT(); });
}
// horizontal bars: rows [{label, value, color?, note?}]
function hbar(outer, o) {
  const box = document.createElement('div'); outer.append(box);
  if (!o.rows.length) { box.innerHTML = '<div class="empty" style="min-height:90px"><b>Nothing in this range</b></div>'; return; }
  const W = box.clientWidth, rowH = 24, H0 = o.rows.length * rowH + 4, lw = Math.min(130, W * .38), vw = 64, iw = Math.max(10, W - lw - vw - 8), mx = Math.max(...o.rows.map((r) => r.value || 0), o.target || 0) || 1;
  const svg = el('svg', { width: W, height: H0, viewBox: `0 0 ${W} ${H0}`, role: 'img' }, box);
  o.rows.forEach((r, i) => { const y = i * rowH + 4, w = Math.max(2, (r.value || 0) / mx * iw);
    const lab = el('text', { x: 0, y: y + 13, style: 'fill:var(--soft)' }, svg); lab.textContent = r.label.length > 20 ? r.label.slice(0, 19) + '…' : r.label;
    el('rect', { x: lw, y: y + 3, width: iw, height: 12, rx: 4, fill: 'var(--grid)' }, svg);
    if (r.value != null) el('path', { d: `M${lw} ${y + 3}H${lw + w - 4}Q${lw + w} ${y + 3} ${lw + w} ${y + 7}V${y + 11}Q${lw + w} ${y + 15} ${lw + w - 4} ${y + 15}H${lw}Z`, fill: r.color || o.color }, svg);
    el('text', { x: W, y: y + 13, 'text-anchor': 'end', style: 'fill:var(--fg);font-weight:700' }, svg).textContent = FMT[o.fmt](r.value);
    const hit = el('rect', { x: 0, y, width: W, height: rowH, fill: 'transparent' }, svg);
    hit.addEventListener('mousemove', (ev) => showTT(ev, `<div class="h">${esc(r.label)}</div>` + ttRow(r.color || o.color, o.name, FMT[o.fmt](r.value)) + (r.note ? `<div class="r c">${esc(r.note)}</div>` : '')));
    hit.addEventListener('mouseleave', hideTT); });
  if (o.target != null) { const x = lw + o.target / mx * iw; el('line', { x1: x, x2: x, y1: 0, y2: H0, stroke: 'var(--soft)', 'stroke-width': 1, opacity: .7 }, svg); }
}
function spark(box, vals, color) {
  const W = box.clientWidth, H0 = 30, v = vals.filter((x) => x != null); if (v.length < 2) return;
  const mx = Math.max(...v), mn = Math.min(...v, 0), X = (i) => i / (vals.length - 1) * (W - 6) + 3, Y = (x) => H0 - 4 - (x - mn) / ((mx - mn) || 1) * (H0 - 8);
  const svg = el('svg', { width: W, height: H0, viewBox: `0 0 ${W} ${H0}`, 'aria-hidden': 'true' }, box);
  let d = ''; vals.forEach((x, i) => { if (x != null) d += (d ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(x).toFixed(1); });
  const idx = vals.map((x, i) => x == null ? -1 : i).filter((i) => i >= 0), first = idx[0], last = idx[idx.length - 1];
  el('path', { d: d + `L${X(last)} ${H0}L${X(first)} ${H0}Z`, fill: color, opacity: .12 }, svg);
  el('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-linejoin': 'round' }, svg);
  el('circle', { cx: X(last), cy: Y(vals[last]), r: 3, fill: color }, svg);
}

// ------------------------------------------------------------------ panels
const node = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };
let renders = [];
function panel(grid, cls, title, value, unit, draw, table) {
  const p = node(`<section class="pn ${cls}"><header><h4>${esc(title)}</h4>${value != null ? `<span class="v">${value}</span>` : ''}${unit ? `<span class="u">${unit}</span>` : ''}${table ? '<button class="ic" title="View as table" aria-label="View as table">▦</button>' : ''}</header><div class="body"></div></section>`);
  grid.append(p);
  const body = p.querySelector('.body'), btn = p.querySelector('.ic');
  let asTable = false;
  const run = () => { body.replaceChildren(); if (asTable) { const t = table(); body.append(node(`<div class="tv"><table><tr>${t.cols.map((c) => '<th>' + esc(c) + '</th>').join('')}</tr>${t.rows.map((r) => '<tr>' + r.map((c) => '<td>' + esc(c) + '</td>').join('') + '</tr>').join('')}</table></div>`)); } else draw(body); };
  if (btn) btn.onclick = () => { asTable = !asTable; btn.classList.toggle('on', asTable); run(); };
  renders.push(run); run();
  return p;
}
function legend(body, items, cmp, target) { body.append(node(`<div class="lg">${items.map((s) => `<span><i class="${s.line ? 'ln' : ''}" style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}${cmp ? `<span><i class="ln cmp" style="background:${cmp}"></i>Previous period</span>` : ''}${target ? `<span><i class="ln" style="background:var(--soft);height:1px"></i>${esc(target)}</span>` : ''}</div>`)); }
function empty(body, title, text, pill, extra) { body.append(node(`<div class="empty">${pill ? `<span class="pill ${pill[0]}">${pill[1]}</span>` : ''}<b>${esc(title)}</b><div>${text}</div></div>`)); if (extra) body.firstChild.append(extra); }
const plotBox = (body, h) => { const d = node(`<div style="height:${h}px"></div>`); body.append(d); return d; };
const tableOf = (x, series, fmt) => () => ({ cols: ['Period', ...series.map((s) => s.name)], rows: x.map((b, i) => [b.long, ...series.map((s) => FMT[fmt](s.values[i]))]) });
const rl = () => (R.days === 1 ? (R.to === R.today ? 'today' : fmtD(R.to)) : R.days + ' days') + (R.gran !== 'day' && R.gran !== 'hour' ? ' · by week' : R.gran === 'hour' ? ' · by hour' : '');
const rlShort = () => (R.days === 1 ? (R.to === R.today ? 'today' : fmtD(R.to)) : R.days + ' days');
function delta(key) {
  const list = ids(), cur = tot(key, list), prev = tot(key, list, 'prev');
  if (['open', 'rfp', 'ck', 'rp', 'created', 'completed', 'nto'].includes(key) && list.some((st) => !R.since[st] || R.since[st] > R.prevFrom)) return '<span>previous period is before tracking</span>';
  if (cur == null || !prev) return '';
  const pc = (cur - prev) / Math.abs(prev), up = pc > 0.005, down = pc < -0.005;
  return `<span class="dlt ${up ? 'up' : down ? 'down' : 'flat'}">${up ? '▲' : down ? '▼' : '■'} ${Math.abs(pc * 100).toFixed(1)}%</span><span>vs previous ${R.days === 1 ? 'day' : 'period'}</span>`;
}
function tile(grid, title, key, o = {}) {
  const m = M[key], v = tot(key, ids());
  return panel(grid, 's3 tile', title, null, o.badge || (m.t === 'level' ? '<span class="pill now">Now</span>' : ''), (body) => {
    body.append(node(`<div><div class="big">${FMT[m.fmt === 'hours' ? 'int' : m.fmt](v)}${o.small ? '<small>' + o.small + '</small>' : ''}</div><div class="sub">${o.sub != null ? o.sub : delta(key)}</div></div>`));
    if (splitting()) body.append(node(`<div class="split-row">${R.selected.map((st) => `<span><i style="background:${colorOf(st)}"></i>${st} ${FMT[m.fmt === 'money' ? 'moneyS' : m.fmt === 'hours' ? 'int' : m.fmt](tot(key, [st]))}</span>`).join('')}</div>`));
    const sp = node('<div style="height:30px;margin-top:4px"></div>'); body.append(sp);
    const grid2 = gridOf(key), vals = grid2.map((_, i) => val(key, ids(), i)).slice(-30);
    spark(sp, vals, scopeColor());
  });
}
const sec = (title, note) => { root.dash.append(node(`<div class="sec"><h2>${esc(title)}</h2>${note ? `<span class="soft">${note}</span>` : ''}</div>`)); const g = node('<div class="g"></div>'); root.dash.append(g); return g; };
const splitTot = (fmt, key) => FMT[fmt](tot(key, ids()));
const has = (k) => R.dailyKeys.includes(k);
const sumMap = (obj, list) => { const out = {}; for (const st of list) for (const [k, v] of Object.entries((obj || {})[st] || {})) out[k] = (out[k] || 0) + v; return out; };

function drawAll() {
  root.dash.replaceChildren(); renders = []; hideTT();
  if (!R.selected.length) { root.dash.append(node('<div class="empty"><b>No stores to show</b><div>Your access doesn’t include any store yet. Ask an owner to add one.</div></div>')); return; }
  const list = ids(), cmpColor = S.compare && R.prev && !splitting() ? scopeColor() : null, split = splitting(), target = R.cleaningTarget / 100;
  const late = list.filter((st) => R.since[st] && R.since[st] > R.from);
  const sameStart = new Set(late.map((st) => R.since[st])).size === 1 && late.length === list.length;
  const trackNote = !late.length ? '' : ' · tracking began ' + (sameStart ? fmtD(R.since[late[0]]) : late.map((st) => fmtD(R.since[st]) + (list.length > 1 ? ' (' + st + ')' : '')).join(', '));
  // ---------------- Sales
  const est = list.flatMap((st) => (R.estDays[st] || []).map((d) => [st, d]));
  const estIn = (b) => est.filter(([, d]) => d >= b.from && d <= b.to);
  let g = sec('Sales', 'Portal sales history where synced; other days estimated from work orders at Sale complete');
  tile(g, 'Sales', 'sales');
  tile(g, 'Transactions', 'count');
  tile(g, 'Average ticket', 'ticket');
  if (has('labor_hours')) tile(g, 'Sales per labor hour', 'splh', { badge: '<span class="u">days with hours</span>' });
  else panel(g, 's3 tile', 'Sales per labor hour', null, '<span class="pill need">Needs labor hours</span>', (b) => empty(b, 'No labor hours yet', 'Tactician uploads each store’s daily hours from the Store time sheet. Target $160–180/h.', ['now', 'No data yet']));
  const sS = seriesFor('sales'), xs = xOf('sales');
  const estNote = (i) => { const e = estIn(R.grid.main[i]); return e.length ? 'Includes ' + e.length + ' estimated store-day' + (e.length > 1 ? 's' : '') : ''; };
  panel(g, 's8', 'Sales over time', splitTot('money', 'sales'), rl(), (b) => {
    if (sS.length > 1 || cmpColor) legend(b, sS.map((s) => ({ ...s, line: 1 })), cmpColor);
    lineChart(plotBox(b, 200), { x: xs, series: sS, fmt: 'money', area: true, direct: true, h: 200, note: estNote });
    if (est.length) { const by = {}; for (const [st, d] of est) (by[st] = by[st] || []).push(d); b.append(node(`<div class="note">Estimated from work orders at Sale complete (sales not synced yet): ${Object.entries(by).map(([st, ds]) => esc(st + ' ' + storeName(Number(st))) + ' ' + (ds.length > 1 ? fmtD(ds[0]) + '–' + fmtD(ds[ds.length - 1]) : fmtD(ds[0]))).join(' · ')}.</div>`)); }
  }, tableOf(xs, sS, 'money'));
  const progAll = Object.entries(sumMap(R.programs, list)).sort((a, b) => b[1] - a[1]);
  const progRows = progAll.slice(0, 5).map(([label, value]) => ({ label, value })).concat(progAll.length > 5 ? [{ label: 'Other programs', value: progAll.slice(5).reduce((s, x) => s + x[1], 0) }] : []);
  panel(g, 's4', 'Sales by program', null, split ? 'all selected stores' : rlShort(), (b) => { hbar(b, { rows: progRows, fmt: 'moneyS', color: scopeColor(), name: 'Sales' }); b.append(node('<div class="note">Top 5 programs + Other. Sales without a work order count as Retail / quick sale.</div>')); }, () => ({ cols: ['Program', 'Sales'], rows: progAll.map(([l, v]) => [l, FMT.money(v)]) }));
  const cS = seriesFor('count');
  panel(g, 's4', 'Transactions', splitTot('int', 'count'), rl(), (b) => { if (cS.length > 1) legend(b, cS); barChart(plotBox(b, 150), { x: xs, series: cS, fmt: 'int', stack: cS.length > 1, h: 150, note: estNote }); }, tableOf(xs, cS, 'int'));
  const lS = seriesFor('labor'), xd = xOf('labor');
  if (has('labor_hours')) panel(g, 's4', 'Labor hours', splitTot('hours', 'labor'), rlShort(), (b) => { if (lS.length > 1) legend(b, lS); barChart(plotBox(b, 150), { x: xd, series: lS, fmt: 'hours', stack: lS.length > 1, h: 150 }); b.append(node(`<div class="note">From Tactician’s Store time sheet uploads. GM hours: ${FMT.hours(totK('cur', 'laborGm', list))}.</div>`)); }, tableOf(xd, lS, 'hours'));
  else panel(g, 's4', 'Labor hours', null, '<span class="pill need">Needs collection</span>', (b) => empty(b, 'Not collected yet', 'Daily hours per store (regular + GM) arrive from Tactician’s Store time sheet read. One manager’s browser covers every store.', ['now', 'No data yet']));
  panel(g, 's4', 'Accessory attach rate', null, '<span class="pill soon">Coming soon</span>', (b) => empty(b, 'Coming soon', 'Repairs with an accessory on the same sale ÷ repair sales. Sale line items are already stored; needs the accessory category list.', ['soon', 'Coming soon']));

  // ---------------- Operations
  g = sec('Operations', 'From the work order tracker (plain fields only)' + trackNote);
  const noHist = !R.statusHistory;
  const histEmpty = (b) => {
    let btn = null;
    if (R.canBackfill) btn = Object.assign(document.createElement('button'), { className: 'btn p', textContent: 'Build status history', onclick: async () => {
      btn.disabled = true; let after = 0, n = 0;
      try { for (;;) { const r = await H.api('POST', '/tracker/metrics/backfill?after=' + after); n += r.processed; after = r.next; btn.textContent = 'Building… ' + n + ' work orders'; if (r.done) break; } H.toast('Status history built (' + n + ' work orders)'); load(true); }
      catch (e) { H.toast("Couldn't build: " + e.message); btn.disabled = false; btn.textContent = 'Build status history'; }
    } });
    empty(b, 'Status history not built yet', 'Built once from the status histories already stored, then kept with every upload.' + (R.canBackfill ? '' : ' Someone with full access can build it here.'), ['now', 'No data yet'], btn);
  };
  tile(g, 'Open work orders', 'open', noHist ? { sub: '<span>needs status history</span>' } : {});
  const rfpNow = list.reduce((a, st) => { const x = R.rfpAging[st]; if (x) { a.v += x.value; a.n += x.count; x.buckets.forEach((bk, i) => (a.b[i] = { label: bk.label, n: ((a.b[i] || {}).n || 0) + bk.n })); if (x.oldestWo && (a.od == null || x.oldestDays > a.od)) { a.od = x.oldestDays; a.ow = x.oldestWo; a.os = st; } } return a; }, { v: 0, n: 0, b: [], od: null, ow: null });
  if (!rfpNow.b.length) rfpNow.b = ['0–2 days', '3–6 days', '7–13 days', '14–29 days', '30+ days'].map((label) => ({ label, n: 0 }));
  tile(g, 'Ready for pickup', 'rfp', { sub: '<span>' + FMT.money(rfpNow.v) + ' on the table</span>' });
  tile(g, 'Check-in → completed', 'ck', { small: 'avg' });
  tile(g, 'Ready for pickup → picked up', 'rp', { small: 'avg' });
  const xm = xOf('created');
  const created = seriesFor('created', { noSplit: true, name: 'Created', color: 'var(--ghost)', noCmp: true }), done = seriesFor('completed', { name: 'Completed' });
  const cvc = split ? done.map((s) => ({ ...s, name: s.name + ' completed' })) : [created[0], done[0]];
  panel(g, 's6', split ? 'Work orders completed' : 'Work orders created vs completed', splitTot('int', 'completed'), 'completed · ' + rlShort(), (b) => { legend(b, cvc.map((s) => ({ ...s, line: 1 })), cmpColor); lineChart(plotBox(b, 170), { x: xm, series: cvc, fmt: 'int', direct: true }); if (split) b.append(node('<div class="note">Split by store shows completed only (created is in the table view).</div>')); }, tableOf(xm, [created[0], ...done], 'int'));
  const bk = [['bench', 'On the bench', 'var(--b1)'], ['parts', 'Parts (need to order / awaiting item)', 'var(--b2)'], ['wait', 'Waiting on customer', 'var(--b3)'], ['rfp', 'Ready for pickup', 'var(--b4)'], ['other', 'Other (depot, partner)', 'var(--b5)']];
  const stS = bk.map(([k, n, c]) => ({ name: n, color: c, values: R.grid.main.map((_, i) => val(k, list, i)) }));
  panel(g, 's6', 'Open work orders by status', noHist ? null : FMT.int(tot('open', list)), noHist ? '' : 'open now' + (split ? ' · all selected stores' : ''), (b) => { if (noHist) return histEmpty(b); legend(b, stS); stackChart(plotBox(b, 170), { x: xm, series: stS }); }, noHist ? null : tableOf(xm, stS, 'int'));
  const rS = seriesFor('rfp');
  panel(g, 's4', 'Ready for pickup count', splitTot('int', 'rfp'), 'now', (b) => { if (noHist) return histEmpty(b); if (rS.length > 1 || cmpColor) legend(b, rS.map((s) => ({ ...s, line: 1 })), cmpColor); lineChart(plotBox(b, 150), { x: xm, series: rS, fmt: 'int', h: 150, direct: true }); }, noHist ? null : tableOf(xm, rS, 'int'));
  panel(g, 's4', 'Ready for pickup aging', FMT.int(rfpNow.n), 'devices now', (b) => { hbar(b, { rows: rfpNow.b.map((x) => ({ label: x.label, value: x.n })), fmt: 'int', color: scopeColor(), name: 'Devices' }); b.append(node(`<div class="note">${rfpNow.ow ? 'Oldest: WO ' + rfpNow.ow + (list.length > 1 ? ' (' + rfpNow.os + ')' : '') + ' · ' + rfpNow.od + ' days. ' : ''}Devices on the RFP table now, by days there.</div>`)); }, () => ({ cols: ['Age', 'Devices'], rows: rfpNow.b.map((r) => [r.label, r.n]) }));
  const nS = seriesFor('nto'), xn = xOf('nto');
  panel(g, 's4', 'Need to order overnight', splitTot('int', 'nto'), R.to === R.today ? 'at close today' : 'at close ' + fmtD(R.to), (b) => { if (noHist) return histEmpty(b); if (nS.length > 1) legend(b, nS); barChart(plotBox(b, 150), { x: xn, series: nS, fmt: 'int', stack: nS.length > 1, h: 150 }); b.append(node('<div class="note">Work orders still in Need to order at store close (7 PM; closed Thursday and Sunday).</div>')); }, noHist ? null : tableOf(xn, nS, 'int'));
  const devRows = Object.entries(sumMap(R.devices, list)).sort((a, b) => (a[0] === 'Other') - (b[0] === 'Other') || b[1] - a[1]).map(([label, value]) => ({ label, value }));
  panel(g, 's4', 'Repairs by device type', FMT.int(devRows.reduce((a, r) => a + r.value, 0)), 'completed · ' + rlShort(), (b) => hbar(b, { rows: devRows, fmt: 'int', color: scopeColor(), name: 'Repairs' }), () => ({ cols: ['Device', 'Repairs'], rows: devRows.map((r) => [r.label, r.value]) }));
  const wm = list.reduce((a, st) => { const x = R.waymarks[st] || {}; a.over += x.over || 0; a.due += x.due || 0; a.up += x.up || 0; return a; }, { over: 0, due: 0, up: 0 });
  panel(g, 's4', 'Auto-Waymarks', null, '<span class="pill now">Now</span>', (b) => { b.append(node(`<div class="wm">
      <div><div class="big">${wm.over}</div><div class="stt">${ICON.critical}Overdue</div></div>
      <div><div class="big">${wm.due}</div><div class="stt">${ICON.warning}Due today</div></div>
      <div><div class="big">${wm.up}</div><div class="stt" style="color:var(--soft)">Upcoming</div></div></div>`));
    b.append(node('<div class="note">Current marks only (Waymark database); marks are removed when a work order leaves the status, so there is no history yet.</div>')); });
  if (has('assize_fail') || has('assize_flag')) {
    const aS = [{ name: 'Fails', color: scopeColor(), values: R.grid.day.map((_, i) => val('assizeFail', list, i)) }, { name: 'Flags', color: 'var(--ghost)', values: R.grid.day.map((_, i) => val('assizeFlag', list, i)) }];
    panel(g, 's4', 'Assize findings', FMT.int(tot('assizeFail', list)) + ' / ' + FMT.int(tot('assizeFlag', list)), 'fails / flags · ' + rlShort(), (b) => { legend(b, aS); barChart(plotBox(b, 130), { x: xd, series: aS, fmt: 'int', h: 130 }); }, tableOf(xd, aS, 'int'));
  } else panel(g, 's4', 'Assize findings', null, '<span class="pill need">Not collected yet</span>', (b) => empty(b, 'No findings uploaded yet', 'Assize runs in the browser; its daily count of fails and flags per store charts here once uploaded.', ['now', 'No data yet']));

  // ---------------- Cleanings
  g = sec('Cleanings', 'Divination’s rule: cleanings linked to the day’s Asurion Mobility orders ÷ those orders');
  const noCl = !has('am_orders');
  const clEmpty = (b) => empty(b, 'No cleaning counts yet', 'Divination uploads each day’s Asurion Mobility orders and linked cleanings per store.', ['now', 'No data yet']);
  if (noCl) { for (const t of ['Cleaning rate', 'Asurion Mobility orders', 'Cleanings linked', 'Days at target']) panel(g, 's3 tile', t, null, '<span class="pill need">Needs Divination upload</span>', clEmpty); }
  else {
    tile(g, 'Cleaning rate', 'rate');
    tile(g, 'Asurion Mobility orders', 'am');
    tile(g, 'Cleanings linked', 'cln');
    const atT = []; for (let i = 0; i < R.days; i++) { let a = 0, c = 0, any = false; for (const st of list) { const x = (R.perDay.am[st] || [])[i], y = (R.perDay.cln[st] || [])[i]; if (x != null) { a += x; c += y || 0; any = true; } } atT.push(any && a > 0 ? c / a >= target : null); }
    const counted = atT.filter((x) => x != null);
    panel(g, 's3 tile', 'Days at target', null, Math.round(target * 100) + '% target', (b) => { b.append(node(`<div><div class="big">${counted.filter(Boolean).length}<small>of ${counted.length}</small></div><div class="sub">days the rate reached ${Math.round(target * 100)}%</div></div>`)); const strip = node('<div style="display:flex;gap:2px;height:14px;margin-top:10px"></div>'); atT.slice(-60).forEach((ok) => strip.append(node(`<i style="flex:1;border-radius:2px;background:${ok ? scopeColor() : 'var(--grid)'};${ok == null ? 'opacity:.4' : ''}"></i>`))); b.append(strip); });
  }
  const rtS = seriesFor('rate'), xr = xOf('rate');
  panel(g, 's8', 'Cleaning rate over time', noCl ? null : splitTot('pct', 'rate'), noCl ? '' : rlShort(), (b) => { if (noCl) return clEmpty(b); legend(b, rtS.map((s) => ({ ...s, line: 1 })), cmpColor, 'Target ' + Math.round(target * 100) + '%'); lineChart(plotBox(b, 190), { x: xr, series: rtS, fmt: 'pct', target, direct: true, h: 190 }); }, noCl ? null : tableOf(xr, rtS, 'pct'));
  const byStore = R.selected.filter((st) => S.store === 'all' || String(st) === S.store || true).map((st) => ({ label: st + ' ' + storeName(st), value: tot('rate', [st]), color: S.store === 'all' || String(st) === S.store ? colorOf(st) : 'var(--ghost)', note: FMT.int(tot('cln', [st])) + ' cleanings ÷ ' + FMT.int(tot('am', [st])) + ' orders' }));
  panel(g, 's4', 'Cleaning rate by store', null, noCl ? '' : rlShort(), (b) => { if (noCl) return clEmpty(b); hbar(b, { rows: byStore, fmt: 'pct', name: 'Cleaning rate', target }); b.append(node(`<div class="note">Line = ${Math.round(target * 100)}% target (admin config cleaningTarget). Only stores you can see.</div>`)); }, noCl ? null : () => ({ cols: ['Store', 'Rate', 'Cleanings ÷ orders'], rows: byStore.map((r) => [r.label, FMT.pct(r.value), r.note]) }));
  const amS = [{ name: 'Asurion Mobility orders', color: 'var(--ghost)', values: R.grid.day.map((_, i) => val('am', list, i)) }, { name: 'Cleanings linked', color: scopeColor(), values: R.grid.day.map((_, i) => val('cln', list, i)) }];
  panel(g, 's12', 'Asurion Mobility orders vs cleanings', noCl ? null : FMT.int(tot('cln', list)) + ' / ' + FMT.int(tot('am', list)), noCl ? '' : rlShort(), (b) => { if (noCl) return clEmpty(b); legend(b, amS); barChart(plotBox(b, 150), { x: xr, series: amS, fmt: 'int', h: 150 }); }, noCl ? null : tableOf(xr, amS, 'int'));

  // ---------------- Aethernet
  g = sec('Aethernet', 'Usage counters (Waymark database) and tracker health');
  tile(g, 'Crystal uses', 'uses');
  tile(g, 'Active people', 'active', { badge: '<span class="pill now">Latest day</span>' });
  const crAll = sumMap(R.crystals, list), inUse = Object.keys(CRYSTALS).filter((k) => crAll[k] > 0).length;
  panel(g, 's3 tile', 'Crystals in use', null, rlShort(), (b) => b.append(node(`<div><div class="big">${inUse}<small>of ${Object.keys(CRYSTALS).length}</small></div><div class="sub">crystals used at least once</div></div>`)));
  const fr = list.map((st) => Object.assign({ store: st }, R.freshness[st] || { state: 'critical', ageMin: null, today: 0, open: 0 }));
  const newest = fr.reduce((m, f) => (f.ageMin != null && (m == null || f.ageMin < m) ? f.ageMin : m), null), worst = fr.filter((f) => f.state === 'critical' || f.state === 'warning').sort((a, b) => (b.ageMin || 1e9) - (a.ageMin || 1e9));
  panel(g, 's3 tile', 'Tracker freshness', null, '<span class="pill now">Now</span>', (b) => b.append(node(`<div><div class="big">${ago(newest)}<small>newest scan</small></div><div class="sub">${worst.length ? worst.slice(0, 2).map((f) => `<span class="stt">${ICON[f.state]}${f.store} ${STATE_LABEL[f.state].toLowerCase()} ${ago(f.ageMin)}</span>`).join(' ') : `<span class="stt">${ICON.good}All live</span>`}</div></div>`)));
  const uS = seriesFor('uses'), xu = xOf('uses');
  panel(g, 's6', 'Uses', splitTot('int', 'uses'), rlShort(), (b) => { if (uS.length > 1 || cmpColor) legend(b, uS, cmpColor); barChart(plotBox(b, 160), { x: xu, series: uS, fmt: 'int', stack: uS.length > 1, h: 160 }); }, tableOf(xu, uS, 'int'));
  const aS = seriesFor('active');
  panel(g, 's6', 'Active people', splitTot('int', 'active'), 'latest day', (b) => { if (aS.length > 1 || cmpColor) legend(b, aS.map((s) => ({ ...s, line: 1 })), cmpColor); lineChart(plotBox(b, 160), { x: xu, series: aS, fmt: 'int', h: 160, direct: true }); if (R.gran === 'week') b.append(node('<div class="note">Weekly points are the average people per day.</div>')); }, tableOf(xu, aS, 'int'));
  const crEntries = Object.entries(crAll).filter(([k]) => CRYSTALS[k]).sort((a, b) => b[1] - a[1]), crRows = crEntries.slice(0, 8).map(([k, v]) => ({ label: CRYSTALS[k], value: v })).concat(crEntries.length > 8 ? [{ label: 'Other crystals', value: crEntries.slice(8).reduce((s, x) => s + x[1], 0) }] : []);
  panel(g, 's6', 'Uses by crystal', null, rlShort(), (b) => hbar(b, { rows: crRows, fmt: 'int', color: scopeColor(), name: 'Uses' }), () => ({ cols: ['Crystal', 'Uses'], rows: crEntries.map(([k, v]) => [CRYSTALS[k], v]) }));
  panel(g, 's6', 'Tracker freshness by store', null, 'scans table', (b) => b.append(node(`<table><tr><th>Store</th><th>Last scan</th><th>Open WOs</th><th>Scans today</th><th>State</th></tr>${fr.map((f) => `<tr><td><b>${f.store}</b> <span class="soft">${esc(storeName(f.store))}</span></td><td>${f.ageMin == null ? 'never' : ago(f.ageMin) + ' ago'}</td><td>${FMT.int(f.open)}</td><td>${FMT.int(f.today)}</td><td><span class="stt" title="${esc(f.note || '')}">${ICON[f.state]}${STATE_LABEL[f.state]}</span></td></tr>`).join('')}</table>`)));
}

// ------------------------------------------------------------------ controls
function drawCtl() {
  const [a, b] = rangeOf(), n = span(a, b), g = granOf(n), label = (PRESETS.find((p) => p[0] === S.range) || [0, 'Custom'])[1];
  const when = n === 1 ? fmtD(a) : fmtD(a) + ' – ' + fmtD(b), stores = R ? R.stores : [];
  const fresh = R && R.dataAsOf ? `<span class="fresh">${ICON.good}Data as of ${timeOf(R.dataAsOf)}${R.salesSyncedAt ? ' · sales synced ' + timeOf(R.salesSyncedAt) : ''}</span>` : '<span class="fresh"></span>';
  root.ctl.innerHTML = `<select id="mx-store" aria-label="Store"><option value="all">All stores (${stores.length})</option>${stores.map((s) => `<option value="${s.id}">${s.id} ${esc(s.name || '')}</option>`).join('')}</select>
    <button class="rbtn" id="mx-rb" aria-haspopup="dialog"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/></svg><b>${label}</b><span class="soft">${when}</span>▾</button>
    <span class="seg" id="mx-gran" title="Granularity">${[['auto', 'Auto · ' + g], ['hour', 'Hour'], ['day', 'Day'], ['week', 'Week']].map(([k, l]) => `<button data-g="${k}" class="${S.gran === k ? 'on' : ''}" ${k === 'hour' && n > 7 || k === 'week' && n < 14 ? 'disabled' : ''}>${l}</button>`).join('')}</span>
    <label class="tg ${S.store !== 'all' ? 'dis' : ''}" title="${S.store !== 'all' ? 'Pick All stores to split' : 'One line per store instead of the total'}"><input type="checkbox" id="mx-split" ${splitting() ? 'checked' : ''} ${S.store !== 'all' ? 'disabled' : ''}><i></i>Split by store</label>
    <label class="tg ${splitting() ? 'dis' : ''}" title="${splitting() ? 'Off while split by store' : 'Faint line for the period right before'}"><input type="checkbox" id="mx-cmp" ${S.compare && !splitting() ? 'checked' : ''} ${splitting() ? 'disabled' : ''}><i></i>Compare to previous period</label>${fresh}`;
  const sel = root.ctl.querySelector('#mx-store'); sel.value = stores.some((s) => String(s.id) === S.store) ? S.store : 'all';
  sel.onchange = (e) => { S.store = e.target.value; go(); };
  root.ctl.querySelector('#mx-split').onchange = (e) => { S.split = e.target.checked; go(); };
  root.ctl.querySelector('#mx-cmp').onchange = (e) => { S.compare = e.target.checked; go(); };
  root.ctl.querySelectorAll('#mx-gran button').forEach((x) => (x.onclick = () => { S.gran = x.dataset.g; go(); }));
  root.ctl.querySelector('#mx-rb').onclick = (e) => { e.stopPropagation(); togglePop(); };
}
let pop = null;
function togglePop(force) {
  if (pop && !force) { pop.remove(); pop = null; return; }
  if (pop) pop.remove();
  const [a, b] = rangeOf(), r = root.ctl.querySelector('#mx-rb').getBoundingClientRect(), t = todayET();
  pop = node(`<div class="mx-pop" role="dialog" aria-label="Date range">${PRESETS.map(([k, l]) => { const [x, y] = rangeOf(k); return `<div class="row" data-k="${k}"><span class="ck">${S.range === k ? '✓' : ''}</span>${S.range === k ? '<b>' + l + '</b>' : l}<span class="soft">${x === y ? fmtD(x) : fmtD(x) + ' – ' + fmtD(y)}</span></div>`; }).join('')}
    <div class="foot"><label>From<input type="date" id="mx-cf" value="${a}" max="${t}"></label><label>To<input type="date" id="mx-ct" value="${b}" max="${t}"></label><div class="go"><button class="btn" id="mx-cx">Cancel</button><button class="btn p" id="mx-ca">Apply</button></div></div></div>`);
  document.body.append(pop);
  pop.style.left = Math.max(8, Math.min(r.left + scrollX, innerWidth - 310)) + 'px'; pop.style.top = (r.bottom + scrollY + 6) + 'px';
  pop.onclick = (e) => e.stopPropagation();
  pop.querySelectorAll('.row').forEach((x) => (x.onclick = () => { S.range = x.dataset.k; S.gran = 'auto'; togglePop(); go(); }));
  pop.querySelector('#mx-cx').onclick = () => togglePop();
  pop.querySelector('#mx-ca').onclick = () => {
    let f = pop.querySelector('#mx-cf').value, to = pop.querySelector('#mx-ct').value;
    if (!f || !to) return; if (to > t) to = t; if (f > to) [f, to] = [to, f]; if (span(f, to) > 400) f = addDays(to, -399);
    S.from = f; S.to = to; S.range = 'custom'; S.gran = 'auto'; togglePop(); go();
  };
}

// ------------------------------------------------------------------ load + draw
let reqId = 0, lastKey = '';
async function load(fresh) {
  const [a, b] = rangeOf(), g = granOf(span(a, b));
  const key = [a, b, S.store === 'all' ? 'all' : S.store, g, S.compare && !splitting() ? 1 : 0].join('|');
  if (!fresh && R && key === lastKey) { drawCtl(); drawAll(); return; }
  const id = ++reqId;
  root.dash.style.opacity = R ? '.55' : '';
  if (!R) root.dash.replaceChildren(node('<div class="soft">Loading…</div>'));
  try {
    const q = new URLSearchParams({ from: a, to: b, stores: S.store === 'all' ? 'all' : S.store, granularity: g, compare: S.compare && !splitting() ? '1' : '0' });
    if (fresh) q.set('fresh', '1');
    const j = await H.api('GET', '/tracker/metrics?' + q);
    if (id !== reqId) return;
    if (S.store !== 'all' && !j.stores.some((s) => String(s.id) === S.store)) { S.store = 'all'; writeHash(); return load(); }
    if (S.store === 'all' && j.stores.length === 1) { S.store = String(j.stores[0].id); writeHash(); return load(); } // one store: show it as that store (its own color)
    const ord = (x) => { const i = STORE_ORDER.indexOf(x); return i < 0 ? 100 + x / 1e7 : i; }; // fixed store order everywhere
    j.stores.sort((x, y) => ord(x.id) - ord(y.id)); if (j.selected) j.selected.sort((x, y) => ord(x) - ord(y));
    R = j; lastKey = key;
    drawCtl(); drawAll();
  } catch (e) {
    if (id !== reqId) return;
    root.dash.replaceChildren(node(`<div class="err">Couldn't load metrics: ${esc(e.message)}</div>`));
  } finally { if (id === reqId) root.dash.style.opacity = ''; }
}
function go() { writeHash(); drawCtl(); load(); }

let wired = false;
export async function draw(m, helpers) {
  H = helpers;
  if (!document.getElementById('mx-css')) document.head.append(Object.assign(document.createElement('style'), { id: 'mx-css', textContent: CSS }));
  if (!document.getElementById('mx-tt')) document.body.append(Object.assign(document.createElement('div'), { id: 'mx-tt' }));
  tt = document.getElementById('mx-tt');
  readHash();
  const wrap = node('<div class="mx"><div class="ctl" id="mx-ctl"></div><div id="mx-dash"></div></div>');
  m.replaceChildren(wrap);
  root = { ctl: wrap.querySelector('#mx-ctl'), dash: wrap.querySelector('#mx-dash') };
  writeHash(); drawCtl(); await load();
  if (!wired) {
    wired = true;
    document.addEventListener('click', () => { if (pop) { pop.remove(); pop = null; } });
    let rw = innerWidth;
    addEventListener('resize', () => { if (Math.abs(innerWidth - rw) > 4 && root && document.contains(root.dash)) { rw = innerWidth; renders.forEach((f) => f()); } });
    addEventListener('hashchange', () => { if (/^#metrics\?/.test(location.hash) && root && document.contains(root.dash)) { readHash(); drawCtl(); load(); } });
  }
}
