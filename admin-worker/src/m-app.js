/* Linkpearl Home. Plain script (no build step), served at /m/app.js under a script-src 'self' policy: no inline handlers, no inline styles
   (widths are set through the CSSOM after rendering). Data: GET /api/m/home (tracker-worker/src/mobile.js). Only Home exists in this
   stage, so there is no navigation; the layout (panes, header) leaves room for it. */
(() => {
  'use strict';
  const APP = document.getElementById('app');
  const LANES = [['order', 'Need to order'], ['start', 'Ready to start'], ['work', 'Work started'], ['wait', 'Waiting'], ['rfp', 'Ready for pickup']];
  const IC = {
    store: '<path d="M4 9l1-5h14l1 5M4 9v11h16V9M4 9a3 3 0 0 0 5 0 3 3 0 0 0 6 0 3 3 0 0 0 5 0"/>', down: '<path d="M6 9l6 6 6-6"/>',
    refresh: '<path d="M20 4v6h-6M4 20v-6h6"/><path d="M19 10a8 8 0 0 0-14-3M5 14a8 8 0 0 0 14 3"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', check: '<path d="M5 12.5l5 5L19 7"/>',
    up: '<path d="M4 16l6-6 4 4 6-7"/>', tdown: '<path d="M4 8l6 6 4-4 6 7"/>',
    wifioff: '<path d="M2 9a15 15 0 0 1 5-3M22 9a15 15 0 0 0-6-3.5M5 13a10 10 0 0 1 3-2M19 13a10 10 0 0 0-4-2.6M9 17a5 5 0 0 1 6 0"/><path d="M3 3l18 18"/>',
  };
  const ic = (n, s = 24, cls = '') => `<svg class="ic ${cls}" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${IC[n]}</svg>`;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => Number(n).toLocaleString('en-US');
  const money = (v) => (v == null ? '—' : '$' + num(Math.round(v)));
  const kfmt = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(Math.round(v)));
  const hrs = (v) => (v == null ? '—' : (Math.round(v * 10) / 10).toFixed(1));
  const pct = (r) => (r == null ? '—' : Math.round(r * 100) + '%');
  const LS = { get: (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } } };
  const DAY_LETTER = 'SMTWTFS', DAY_NAME = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dow = (day) => new Date(day + 'T12:00:00Z').getUTCDay();

  const S = { store: LS.get('lp-store') || 'all', data: null, key: null, view: 'loading', offline: false, failed: false, busy: false, seq: 0, at: 0, menu: false };

  // ---- time
  const clock = (iso, tz, today) => {
    if (!iso) return '—';
    const d = new Date(iso), o = { timeZone: tz, hour: 'numeric', minute: '2-digit' };
    let t = new Intl.DateTimeFormat('en-US', o).format(d).replace(/ /g, ' ');
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    if (today && day !== today) t = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d) + ' ' + t;
    return t;
  };
  const ago = (min) => { min = Math.max(0, Math.round(min)); if (min < 60) return min + 'm'; const h = Math.floor(min / 60); return h < 24 ? h + 'h ' + (min % 60) + 'm' : Math.floor(h / 24) + 'd ' + (h % 24) + 'h'; };

  // ---- charts (inline SVG; the numbers are also real text in the cards)
  const lanesAlt = (d) => LANES.map(([k, n]) => n + ' ' + d.lanes[k]).join(', ');
  function bars(vals, days, o) {
    const n = vals.length, gap = (o.w - n * o.bw) / (n - 1), max = Math.max(o.cap || 0, 1, ...vals.filter((v) => v != null));
    let s = '';
    vals.forEach((v, i) => {
      const x = i * (o.bw + gap), last = i === n - 1;
      if (v != null) {
        const h = v > 0 ? Math.max(3, (v / max) * o.h) : 3, y = o.top + o.h - h;
        s += `<rect class="${v > 0 ? 'bar' : 'stub'}${last ? ' now' : ''}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${o.bw}" height="${h.toFixed(1)}" rx="${Math.min(4, h / 2)}"/>`;
        if (o.labels && v > 0) s += `<text class="${last ? 'lv' : ''}" x="${(x + o.bw / 2).toFixed(1)}" y="${(y - 5).toFixed(1)}" text-anchor="middle">${o.fmt(v)}</text>`;
      }
      s += `<text class="${last ? 'lv' : ''}" x="${(x + o.bw / 2).toFixed(1)}" y="${o.top + o.h + o.ly}" text-anchor="middle">${DAY_LETTER[dow(days[i])]}</text>`;
    });
    return `<svg class="chart" viewBox="0 0 ${o.w} ${o.top + o.h + o.ly + 4}" role="img" aria-label="${esc(o.alt)}">${s}</svg>`;
  }
  function line(vals, days, band, o) {
    const n = vals.length, pad = 8, xs = (i) => pad + (i * (o.w - 2 * pad)) / (n - 1), real = vals.filter((v) => v != null);
    const lo = Math.min(band[0], ...real) - 8, hi = Math.max(band[1], ...real) + 8, y = (v) => o.top + (1 - (v - lo) / (hi - lo)) * o.h;
    let s = `<rect class="band" x="0.5" y="${y(band[1]).toFixed(1)}" width="${o.w - 1}" height="${(y(band[0]) - y(band[1])).toFixed(1)}"/>`, path = '';
    vals.forEach((v, i) => { if (v == null) return; path += (i > 0 && vals[i - 1] != null ? 'L' : 'M') + xs(i).toFixed(1) + ' ' + y(v).toFixed(1); });
    s += `<path class="ln" d="${path}"/>`;
    vals.forEach((v, i) => {
      if (v == null) return;
      const last = i === n - 1;
      s += `<circle class="pt${last ? ' now' : ''}" cx="${xs(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${o.r}"/>`;
      if (o.labels) s += `<text class="${last ? 'lv' : ''}" x="${Math.min(o.w - 14, Math.max(14, xs(i))).toFixed(1)}" y="${(y(v) - 10).toFixed(1)}" text-anchor="middle">${money(v)}</text>`;
    });
    vals.forEach((_, i) => { s += `<text class="${i === n - 1 ? 'lv' : ''}" x="${xs(i).toFixed(1)}" y="${o.top + o.h + o.ly}" text-anchor="middle">${DAY_LETTER[dow(days[i])]}</text>`; });
    return `<svg class="chart" viewBox="0 0 ${o.w} ${o.top + o.h + o.ly + 4}" role="img" aria-label="${esc(o.alt)}">${s}</svg>`;
  }
  // $120-$220 track, the target band outlined, a marker above today's value.
  function meter(v, t) {
    const W = 320, MIN = 120, MAX = 220, x = (a) => ((Math.min(MAX, Math.max(MIN, a)) - MIN) / (MAX - MIN)) * W;
    let s = `<rect class="trk" x="0" y="20" width="${W}" height="12" rx="6"/><rect class="tb" x="${x(t[0])}" y="17" width="${x(t[1]) - x(t[0])}" height="18" rx="6"/>`;
    if (v != null) s += `<path class="mk" d="M${x(v) - 8} 1h16l-8 11z"/>`;
    s += `<text class="mlb" x="0" y="54">$${MIN}</text><text class="mlb b" x="${x(t[0])}" y="54" text-anchor="middle">$${t[0]}</text><text class="mlb b" x="${x(t[1])}" y="54" text-anchor="middle">$${t[1]}</text><text class="mlb" x="${W}" y="54" text-anchor="end">$${MAX}</text>`;
    return `<svg class="chart" viewBox="0 0 ${W} 60" role="img" aria-label="Sales per labor hour ${v == null ? 'unknown' : money(v)}, target $${t[0]} to $${t[1]}">${s}</svg>`;
  }

  // ---- cards
  const altWeek = (d, vals, f) => vals.map((v, i) => DAY_NAME[dow(d.days[i])] + ' ' + f(v)).join(', ');
  const salesCard = (d) => `<section class="card c-sales" aria-label="Today's sales"><div class="lbl">Today's sales</div>
    <div class="row sales-row"><div><div class="big">${money(d.sales.today)}</div><div class="yest">Yesterday <b>${money(d.sales.yesterday)}</b></div></div>
    <div class="compact">${bars(d.sales.week, d.days, { w: 130, bw: 14, top: 2, h: 56, ly: 16, alt: 'Sales, last 7 days: ' + altWeek(d, d.sales.week, money) })}</div></div>
    <div class="wide wide-bars">${bars(d.sales.week, d.days, { w: 340, bw: 36, top: 22, h: 130, ly: 22, labels: true, fmt: kfmt, alt: 'Sales, last 7 days: ' + altWeek(d, d.sales.week, money) })}</div></section>`;
  const state = (v, t) => (v == null ? null : v < t[0] ? 'under' : v > t[1] ? 'over' : 'on');
  const splhCard = (d) => {
    const p = d.splh, st = state(p.today, p.target), alt = 'Sales per labor hour, last 7 days: ' + altWeek(d, p.week, money);
    const chip = st === 'under' ? `<span class="chip warn">${ic('tdown', 20)}Under target</span>` : st === 'over' ? `<span class="chip good">${ic('up', 20)}Over target</span>` : st === 'on' ? `<span class="chip good">${ic('check', 20)}On target</span>` : '';
    return `<section class="card c-splh" aria-label="Sales per labor hour"><div class="lbl">Sales per labor hour<span class="r soft">${hrs(p.hours)} labor hours</span></div>
      <div class="row"><div><div class="big">${money(p.today)}</div><div class="tgt">${chip}<span>Target $${p.target[0]}–$${p.target[1]}</span></div></div>
      <div class="compact">${line(p.week, d.days, p.target, { w: 130, top: 4, h: 34, ly: 16, r: 2.5, alt })}</div></div>
      <div class="wide wide-bars">${line(p.week, d.days, p.target, { w: 340, top: 24, h: 120, ly: 22, r: 4, labels: true, alt })}</div>
      <div class="meter">${meter(p.today, p.target)}</div></section>`;
  };
  const rfpCard = (d) => `<section class="card c-rfp" aria-label="RFP total"><div class="lbl">RFP total</div>
    <div class="rfp-row"><div class="big">${money(d.rfp.total)}</div><div class="rfp-r"><div><b>${num(d.rfp.count)}</b> Ready for pickup</div>${d.rfp.count > 0 && d.rfp.oldestDays != null ? `<div class="old">${ic('clock', 20)}<span>Oldest <b>${d.rfp.oldestDays}</b> ${d.rfp.oldestDays === 1 ? 'day' : 'days'}</span></div>` : ''}</div></div></section>`;
  const lanesCard = (d) => {
    const L = d.lanes, max = Math.max(1, ...LANES.map(([k]) => L[k]));
    return `<section class="card c-lanes" aria-label="Open work orders"><div class="lbl">Open work orders<span class="r"><b>${num(L.total)}</b></span></div>
      <div class="seg lanes-seg" role="img" aria-label="${esc(lanesAlt(d))}">${LANES.map(([k]) => (L[k] ? `<i class="f-${k}" data-g="${L[k]}"></i>` : '')).join('')}</div>
      <div class="lanes">${LANES.map(([k, n]) => `<div class="ln-i ${k}"><div class="ln-n"><i class="dot d-${k}"></i>${num(L[k])}</div><div class="ln-t">${n}</div><div class="lb ln-b" aria-hidden="true"><i class="f-${k}" data-w="${(L[k] / max) * 100}"></i></div></div>`).join('')}</div></section>`;
  };
  const cleanCard = (d) => {
    const c = d.cleaning;
    return `<section class="card c-clean" aria-label="Cleaning rate"><div class="cl-row"><div><div class="lbl">Cleaning rate</div><div class="cl-top">${c.am == null ? '—' : c.cln + ' of ' + c.am + ' orders'}</div></div><div class="pct">${pct(c.rate)}</div></div>
      <div class="prog" role="img" aria-label="Cleaning rate ${pct(c.rate)}"><div class="lb"><i class="f-clean" data-w="${c.rate == null ? 0 : Math.min(1, c.rate) * 100}"></i></div></div>
      <div class="wide wide-bars">${bars(c.week, d.days, { w: 340, bw: 36, top: 4, h: 50, ly: 22, cap: 1, alt: 'Cleaning rate, last 7 days: ' + altWeek(d, c.week, pct) })}</div></section>`;
  };
  const extraCard = (d) => {
    if (d.byStore) {
      return `<section class="card c-extra" aria-label="By store"><div class="lbl">By store</div><div class="stores">${d.byStore.map((s) => `<div class="bs"><div><b>${esc(label(s.id, s.name))}</b><div class="t${s.stale ? ' warn' : ''}">${ic('clock', 18)}${clock(s.asOf, d.tz, d.today)}${s.stale ? ' · behind' : ''}</div></div><div class="v">${money(s.sales)}<small>${s.splh == null ? '—' : money(s.splh) + '/hr'}</small></div></div>`).join('')}</div></section>`;
    }
    const max = Math.max(1, ...d.rfp.ages.map((a) => a.n));
    return `<section class="card c-extra" aria-label="Ready for pickup by age"><div class="lbl">Ready for pickup by age<span class="r"><b>${num(d.rfp.count)}</b></span></div><div class="ages">${d.rfp.ages.map((a) => `<div class="ag"><span>${esc(a.label)}</span><div class="lb"><i class="f-rfp" data-w="${(a.n / max) * 100}"></i></div><span class="n">${a.n}</span></div>`).join('')}</div></section>`;
  };
  const skel = () => `<section class="card c-sales"><i class="sk l"></i><i class="sk b"></i><i class="sk m"></i></section><section class="card c-splh"><i class="sk l"></i><i class="sk b"></i><i class="sk m"></i><i class="sk c"></i></section><section class="card c-rfp"><i class="sk l"></i><i class="sk b"></i></section>`;
  const skelB = () => `<section class="card c-lanes"><i class="sk l"></i><i class="sk c"></i></section><section class="card c-clean"><i class="sk l"></i><i class="sk m"></i><i class="sk m"></i></section>`;

  const label = (id, name) => (name ? name + ' #' + id : '#' + id);
  const storeName = () => (S.store === 'all' ? 'All stores' : (() => { const s = S.data && S.data.stores.find((x) => String(x.id) === String(S.store)); return label(S.store, s && s.name); })());

  function render() {
    const d = S.data && S.key === S.store ? S.data : null, v = S.view;
    let notice = '', a = '', b = '', asof = '';
    if (d && v === 'ok') {
      const when = clock(d.asOf, d.tz, d.today), age = d.asOf ? (Date.parse(d.now) - Date.parse(d.asOf)) / 60000 : null;
      if (S.offline) notice = `<div class="notice">${ic('wifioff')}<span>Offline · as of ${when}</span></div>`;
      else if (S.failed) notice = `<div class="notice warn">${ic('clock')}<span>Couldn't refresh · as of ${when}</span><button class="btn tonal" data-act="retry">Retry</button></div>`;
      else if (d.stale && !d.behind && age != null) notice = `<div class="notice warn">${ic('clock')}<span>Updated ${ago(age)} ago · as of ${when}</span></div>`;
      else asof = `<div class="asof${d.behind ? ' warn' : ''}">${ic('clock', 20)}<span>As of ${when}${d.behind ? ' · ' + esc(d.behind.name || '#' + d.behind.id) + ' behind' : ''}</span></div>`;
      if (d.empty) a = '<div class="state">No stores</div>';
      else { a = salesCard(d) + splhCard(d) + rfpCard(d); b = lanesCard(d) + cleanCard(d) + extraCard(d); }
    } else if (v === 'loading') { a = skel(); b = skelB(); asof = '<div class="asof"><i class="sk l"></i></div>'; }
    else if (v === 'signedout') a = `<div class="state"><span>Signed out</span><button class="btn" data-act="signin">Sign in</button></div>`;
    else a = `<div class="state"><span>Couldn't load</span><button class="btn" data-act="retry">Retry</button></div>`;
    APP.innerHTML = `<main class="screen"><div class="panes"><section class="pane a"><button class="sw" data-act="menu" aria-haspopup="dialog" aria-label="Store: ${esc(storeName())}">${ic('store', 22)}<span>${esc(storeName())}</span>${ic('down', 22)}</button>${a}</section>
      <section class="pane b"><div class="bar-b">${notice || asof}<button class="rf" data-act="refresh" aria-label="Refresh">${ic('refresh', 24, S.busy ? 'spin' : '')}</button></div>${b}</section></div></main>${S.menu ? menu() : ''}`;
    for (const e of APP.querySelectorAll('[data-g]')) e.style.flexGrow = e.dataset.g;
    for (const e of APP.querySelectorAll('[data-w]')) e.style.width = e.dataset.w + '%';
    if (S.menu) { const c = APP.querySelector('.menu [aria-checked="true"]'); if (c) c.focus(); }
  }
  const menu = () => {
    const items = [['all', 'All stores']].concat(((S.data && S.data.stores) || []).map((s) => [String(s.id), label(s.id, s.name)]));
    return `<div class="menu-bg" data-act="close"><div class="menu" role="radiogroup" aria-label="Store" data-keep="1">${items.map(([k, n]) => `<button role="radio" aria-checked="${String(S.store) === k}" data-act="pick" data-store="${esc(k)}"><span>${esc(n)}</span>${String(S.store) === k ? ic('check') : ''}</button>`).join('')}</div></div>`;
  };

  // ---- data
  async function load(manual) {
    const key = S.store, seq = ++S.seq;
    S.busy = true; S.failed = false;
    if (!S.data || S.key !== key) { S.view = 'loading'; S.offline = false; }
    render();
    let res = null;
    try { res = await fetch('/api/m/home?store=' + encodeURIComponent(key) + (manual ? '&fresh=1' : ''), { credentials: 'same-origin', redirect: 'manual', headers: { accept: 'application/json' } }); } catch (_) { res = null; }
    if (seq !== S.seq) return;
    S.busy = false;
    // Offline with no service worker answer: keep what is on screen, say so.
    if (!res) { if (S.data && S.key === key) { S.offline = true; S.view = 'ok'; } else S.view = 'error'; return render(); }
    // Access sends a signed-out session to its login page (a redirect, 401 or 403 that isn't ours): show Sign in, which reloads through Access.
    const mine = (res.headers.get('content-type') || '').includes('json');
    if (res.type === 'opaqueredirect' || res.status === 401 || (res.status === 403 && !mine)) { S.view = 'signedout'; return render(); }
    if (res.status === 403 && S.store !== 'all') { S.store = 'all'; LS.set('lp-store', 'all'); return load(false); } // a remembered store that is no longer visible
    if (!res.ok) { if (S.data && S.key === key) { S.failed = true; S.view = 'ok'; } else S.view = 'error'; return render(); }
    let j; try { j = await res.json(); } catch (_) { S.view = 'error'; return render(); }
    S.data = j; S.key = key; S.view = 'ok'; S.offline = res.headers.get('x-lp-cached') === '1'; S.at = Date.now();
    render();
  }

  APP.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    if (act === 'close' && e.target.closest('[data-keep]')) return;
    if (act === 'menu') { S.menu = true; render(); }
    else if (act === 'close') { S.menu = false; render(); }
    else if (act === 'pick') { S.menu = false; if (t.dataset.store !== String(S.store)) { S.store = t.dataset.store; LS.set('lp-store', S.store); } load(false); }
    else if (act === 'refresh' || act === 'retry') load(true);
    else if (act === 'signin') location.href = '/m';
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.menu) { S.menu = false; render(); } });
  setInterval(() => { if (!document.hidden && S.view !== 'signedout') load(false); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - S.at > 60000 && S.view !== 'signedout') load(false); });
  window.addEventListener('online', () => load(false));

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/m/sw.js', { scope: '/m' }).catch(() => {});
  load(false);
})();
