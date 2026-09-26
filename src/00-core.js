/*
  Aethernet core — shared by every tool in this bundle.

  - AE.settings: persisted in Tampermonkey storage (GM_*), so the portal and
    the Sprinklr form (a different site) see the same values.
  - AE.profile(): the logged-in user + current store, from /api/auth/user.
    Anything personal (name, email, store) comes from here, never hardcoded.
  - Styling uses the portal's own design tokens (--aui-*), which switch with
    its light/dark theme; the fallbacks are the light-theme values, used on
    pages without the tokens (the Sprinklr form).
  - AE.tool(): each tool registers here and runs in its own try/catch, only
    if enabled in settings — one tool breaking can't take down the others.
*/

const AE_NAME = 'Aethernet';
const AE_VERSION = '__VERSION__'; // filled in by build.py
const AE_ON_PORTAL = location.hostname === 'portal.ubreakifix.net';

const AE = (() => {
  const SETTINGS_KEY = 'sg_settings';
  const DEFAULTS = {
    tools: { cleaningRate: true, woCleanings: true, textNotes: true, autoClose: true, galaxy: true, printLabels: true },
    cleaningRate: { target: 75 },
    printLabels: { delayMs: 900 },
    // Blank = use the logged-in user / current store automatically.
    galaxy: { technicianName: '', email: '', location: '', storeEmail: '', toolVersion: 'Latest', description: 'ER' },
  };

  // Cleaning programs, from the ubif-workorders audit rules. Shared by the
  // cleaning-rate badge and the auto-close button. 10303 = AT&T Performance
  // Check (its line item is "In-Person Performance Promise").
  const PARENT_PROGRAM_ID = 5062; // Asurion Mobility
  const CLEANING_PROGRAMS = {
    11759: 'VZ Device Refresh',
    9470: 'VZ Sanitization',
    11009: 'AT&T Enhanced Cleaning',
    9901: 'AT&T Device Diagnostic',
    10303: 'AT&T Performance Check',
  };

  const merge = (base, over) => {
    const out = Array.isArray(base) ? [...base] : { ...base };
    for (const [k, v] of Object.entries(over || {})) {
      out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v;
    }
    return out;
  };
  const settings = merge(DEFAULTS, GM_getValue(SETTINGS_KEY, {}));
  const saveSettings = (next) => GM_setValue(SETTINGS_KEY, next);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------------------------------------------------------------- API
  class Stopped extends Error {}
  async function api(method, path, body, opts = {}) {
    if (opts.shouldStop && opts.shouldStop()) throw new Stopped();
    const init = { method, credentials: 'include', headers: { accept: 'application/json' } };
    if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    const res = await fetch(path, init);
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new Error('Your portal session expired — log in again.');
    if (!res.ok) throw new Error(method + ' ' + path + ' → HTTP ' + res.status + ': ' + text.slice(0, 200));
    if (/^\s*<!doctype html/i.test(text)) throw new Error(method + ' ' + path + ' returned the app page, not data (wrong route?)');
    try { return text ? JSON.parse(text) : null; } catch (_) { return text; }
  }
  const unwrap = (j) => (j && j.data && !Array.isArray(j.data) ? j.data : j);

  // ------------------------------------------------------------ profile
  let profilePromise = null;
  function profile() {
    if (!AE_ON_PORTAL) return Promise.resolve(null);
    if (!profilePromise) {
      profilePromise = api('GET', '/api/auth/user').then((a) => {
        // {isAuthenticated, user: {givenName, familyName, email, …}, currentStore: {storeId, storeName, email, …}}
        const u = (a && a.user) || {}, s = (a && a.currentStore) || {};
        return {
          name: [u.givenName, u.familyName].filter(Boolean).join(' ').trim(),
          email: u.email || '',
          storeId: s.storeId,
          storeName: s.storeName || '',
          storeEmail: s.email || '',
        };
      }).catch((e) => { profilePromise = null; throw e; });
    }
    return profilePromise;
  }

  // ------------------------------------------------------------- styles
  const CSS = `
  .sg, .sg * { box-sizing: border-box; }
  .sg { font-family: Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; color: var(--aui-on-surface, #1a1c1e); }
  .sg-btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; height:32px; padding:0 15px; border-radius:10000rem;
    border:1px solid var(--aui-on-surface, #1a1c1e); background:transparent; color:var(--aui-on-surface, #1a1c1e);
    font:400 14px/1 Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; cursor:pointer; white-space:nowrap; }
  .sg-btn:hover { background: var(--aui-neutral-soft, #f1f0f4); }
  .sg-btn:disabled { opacity:.5; cursor:default; }
  .sg-btn.sg-lg { height:48px; padding:0 24px; font-size:16px; }
  .sg-btn.sg-primary { background:var(--aui-primary, #8223d2); border-color:var(--aui-primary, #8223d2); color:var(--aui-on-primary, #fff); }
  .sg-btn.sg-primary:hover { filter: brightness(.92); }
  .sg-btn.sg-danger { background:var(--aui-status-error, #b91a24); border-color:var(--aui-status-error, #b91a24); color:#fff; }
  .sg-btn.sg-danger:hover { filter: brightness(.92); }
  .sg-fab { display:inline-flex; align-items:center; justify-content:center; flex:none; padding:0; border:0; border-radius:50%;
    background:var(--aui-primary, #8223d2); cursor:pointer; }
  .sg-fab:hover { filter: brightness(.92); } .sg-fab:disabled { opacity:.5; cursor:default; }
  .sg-card { background:var(--aui-surface, #fff); border:1px solid var(--aui-outline, #c6c6ca); border-radius:16px;
    box-shadow:0 8px 28px rgba(12,14,17,.18); }
  .sg-panel { position:fixed; right:20px; bottom:20px; z-index:2147483646; width:340px; padding:16px; font-size:14px; line-height:1.4; }
  .sg-panel-head { display:flex; align-items:center; gap:10px; margin-bottom:12px; }
  .sg-panel-title { flex:1; font-size:16px; font-weight:700; }
  .sg-soft { color: var(--aui-on-surface-soft, #5d5e61); font-size:12px; }
  .sg-x { background:none; border:0; padding:4px; cursor:pointer; color:var(--aui-on-surface-soft, #5d5e61); font-size:18px; line-height:1; }
  .sg-steps { list-style:none; margin:0 0 12px; padding:0; max-height:240px; overflow:auto; }
  .sg-steps li { display:flex; gap:8px; align-items:baseline; padding:3px 0; animation: sg-in .2s ease-out; }
  .sg-steps li::before { content:"✓"; color:var(--aui-status-success, #136d31); font-weight:700; flex:none; }
  .sg-msg { border-radius:8px; padding:8px 10px; margin-bottom:12px; font-size:13px; }
  .sg-msg.ok { background:var(--aui-status-success-soft, #c5ffc8); color:var(--aui-status-on-success-soft, #062011); }
  .sg-msg.err { background:var(--aui-status-error-soft, #ffdad7); color:var(--aui-status-on-error-soft, #410004); }
  .sg-msg a { color:inherit; font-weight:700; }
  .sg-actions { display:flex; gap:8px; justify-content:flex-end; }
  .sg-actions .sg-btn { flex:1; }
  .sg-spin { width:16px; height:16px; flex:none; border:2px solid var(--aui-primary-soft, #faecff); border-top-color:var(--aui-primary, #8223d2);
    border-radius:50%; animation: sg-spin .7s linear infinite; }
  .sg-icon-state { width:16px; text-align:center; font-weight:700; flex:none; }
  .sg-clock { font-variant-numeric:tabular-nums; color:var(--aui-on-surface-soft, #5d5e61); font-size:13px; }
  .sg-bar { height:6px; border-radius:3px; background:var(--aui-primary-soft, #faecff); overflow:hidden; margin:8px 0 12px; }
  .sg-bar > i { display:block; height:100%; width:0; background:var(--aui-primary, #8223d2); transition: width .3s; }
  /* cleaning chips — shared by the cleaning-rate list and the WO pill */
  .sg-chip { display:inline-flex; align-items:center; gap:6px; margin:0 0 4px 4px; padding:2px 8px; border-radius:10000rem; font-size:12px; font-weight:400;
    background:var(--aui-primary-soft,#faecff); color:var(--aui-on-primary-soft,#590099) !important; text-decoration:none !important; white-space:nowrap; }
  .sg-chip.pending { background:transparent; border:1px dashed var(--aui-primary,#8223d2); color:var(--aui-primary,#8223d2) !important; padding:1px 3px 1px 7px; }
  .sg-chip .sg-mk { display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px; border:0; padding:0; border-radius:50%;
    background:var(--aui-primary,#8223d2); color:var(--aui-on-primary,#fff); cursor:pointer; }
  .sg-chip .sg-mk:hover { filter:brightness(.9); }
  @keyframes sg-spin { to { transform: rotate(360deg); } }
  @keyframes sg-in { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }
  @keyframes sg-flash { 0%,100% { box-shadow:0 8px 28px rgba(12,14,17,.18); } 50% { box-shadow:0 0 0 3px var(--aui-primary, #8223d2); } }
  `;
  function ensureCss() {
    if (document.getElementById('sg-core-css')) return;
    const s = document.createElement('style');
    s.id = 'sg-core-css';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  // Minimal element builder: h('div', {class:'x', onclick}, child, 'text')
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el[k] = v;
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
    return el;
  }

  const ICONS = {
    bolt: '<path fill="currentColor" d="M13.5 2 4 13.5h6.5L9.5 22 20 9.5h-6.5z"/>',
    clipboard: '<path fill="currentColor" d="M9 2h6a1 1 0 0 1 1 1v1h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2V3a1 1 0 0 1 1-1zm1 2v2h4V4h-4zM8 11v2h8v-2H8zm0 4v2h5v-2H8z"/>',
    printer: '<path fill="currentColor" d="M7 3h10v4H7V3zM5 8h14a2 2 0 0 1 2 2v6h-4v4H7v-4H3v-6a2 2 0 0 1 2-2zm4 7v3h6v-3H9zm8-5a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"/>',
    aetheryte: '<ellipse cx="12" cy="11" rx="10.5" ry="3.2" fill="none" stroke="currentColor" stroke-width="1.4" opacity=".55"/><path fill="currentColor" d="M12 1.5 6 10l6 12.5L18 10z"/><path fill="#fff" opacity=".4" d="M12 1.5 9.2 10l2.8 12.5z"/><path fill="currentColor" d="M3.5 3.5 2 6l1.5 2.5L5 6zM20.5 15.5 19 18l1.5 2.5L22 18z" opacity=".7"/>',
    grip: '<g fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></g>',
  };
  const icon = (name, size = 16) =>
    '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" aria-hidden="true" style="flex:none;display:block">' + ICONS[name] + '</svg>';

  /*
    A progress panel (bottom-right card): spinner → ✓/✕/■, running clock,
    ticked step list, a result message, and whatever action buttons the tool
    sets. Used by auto-close and print-all-labels.
  */
  function progressPanel(title, { clock = true } = {}) {
    ensureCss();
    document.querySelectorAll('.sg-panel[data-sg-title="' + title + '"]').forEach((p) => p.remove());
    const state = h('span', { class: 'sg-spin' });
    const clk = clock ? h('span', { class: 'sg-clock' }, '0.0s') : null;
    const close = h('button', { class: 'sg-x', title: 'Close', style: 'display:none', onclick: () => panel.remove() }, '✕');
    const steps = h('ul', { class: 'sg-steps' });
    const body = h('div');
    const msg = h('div', { class: 'sg-msg', style: 'display:none' });
    const actions = h('div', { class: 'sg-actions' });
    const panel = h('div', { class: 'sg sg-card sg-panel', 'data-sg-title': title },
      h('div', { class: 'sg-panel-head' }, state, h('span', { class: 'sg-panel-title' }, title), clk, close),
      body, steps, msg, actions);
    document.body.appendChild(panel);

    const t0 = performance.now();
    const fmt = (ms) => { const s = ms / 1000; return s < 60 ? s.toFixed(1) + 's' : Math.floor(s / 60) + 'm ' + String(Math.floor(s % 60)).padStart(2, '0') + 's'; };
    const timer = clk ? setInterval(() => { clk.textContent = fmt(performance.now() - t0); }, 100) : null;

    return {
      el: panel,
      body,
      step(text) { steps.append(h('li', null, text)); steps.scrollTop = steps.scrollHeight; },
      actions(...btns) { actions.replaceChildren(...btns); },
      finish(kind, html) { // kind: 'ok' | 'err' | 'stop'
        if (timer) { clearInterval(timer); clk.textContent = fmt(performance.now() - t0); }
        const done = h('span', { class: 'sg-icon-state' }, kind === 'ok' ? '✓' : kind === 'stop' ? '■' : '✕');
        done.style.color = kind === 'ok' ? 'var(--aui-status-success, #136d31)' : 'var(--aui-status-error, #b91a24)';
        state.replaceWith(done);
        if (html) { msg.className = 'sg-msg ' + (kind === 'ok' ? 'ok' : 'err'); msg.innerHTML = html; msg.style.display = 'block'; }
        close.style.display = '';
      },
      flash() { panel.style.animation = 'sg-flash .8s'; setTimeout(() => { panel.style.animation = ''; }, 800); },
    };
  }

  /*
    Confirmation dialog in the portal's style (never window.confirm — native
    dialogs block the page). Resolves true only on the confirm button.
  */
  const CONFIRM_CSS = `
  .sg-confirm-scrim { position:fixed; inset:0; z-index:2147483647; background:var(--aui-scrim-overlay, #0c0e1180);
    display:flex; align-items:center; justify-content:center; padding:16px; animation: sg-in .15s ease-out; }
  .sg-confirm { width:min(460px, 100%); padding:24px; font-size:15px; line-height:1.45; }
  .sg-confirm h2 { margin:0 0 8px; font-size:20px; font-weight:700; }
  .sg-confirm .sg-warn { margin:14px 0 20px; padding:10px 12px; border-radius:8px; font-weight:600;
    background:var(--aui-status-warning-soft, #fff0c0); color:var(--aui-status-on-warning-soft, #3a3000); }
  .sg-confirm .sg-actions .sg-btn { flex:1; }
  `;
  function confirmDialog({ title, message, warning, confirmLabel = 'Confirm', cancelLabel = 'Cancel' }) {
    ensureCss();
    if (!document.getElementById('sg-confirm-css')) document.head.append(h('style', { id: 'sg-confirm-css' }, CONFIRM_CSS));
    return new Promise((resolve) => {
      const done = (v) => { scrim.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
      const ok = h('button', { type: 'button', class: 'sg-btn sg-lg sg-primary', onclick: () => done(true) }, confirmLabel);
      const card = h('div', { class: 'sg sg-card sg-confirm', role: 'alertdialog', 'aria-modal': 'true' },
        h('h2', null, title),
        message ? h('div', { html: message }) : null,
        warning ? h('div', { class: 'sg-warn' }, warning) : null,
        h('div', { class: 'sg-actions' }, h('button', { type: 'button', class: 'sg-btn sg-lg', onclick: () => done(false) }, cancelLabel), ok));
      const scrim = h('div', { class: 'sg sg-confirm-scrim', onclick: (e) => { if (e.target === scrim) done(false); } }, card);
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(scrim);
      ok.focus();
    });
  }

  // Small status card, bottom-left, auto-dismissing. kind: 'ok' | 'err' | 'busy'
  function toast(title, text, kind = 'ok', ms = 6000) {
    ensureCss();
    const mark = kind === 'busy' ? '<span class="sg-spin" style="margin-top:2px"></span>'
      : '<span class="sg-icon-state" style="color:' + (kind === 'ok' ? 'var(--aui-status-success,#136d31)' : 'var(--aui-status-error,#b91a24)') + '">' + (kind === 'ok' ? '✓' : '!') + '</span>';
    const el = h('div', { class: 'sg sg-card sg-toast', role: 'status', style:
      'position:fixed;z-index:2147483647;left:16px;bottom:16px;max-width:420px;padding:12px 16px;display:flex;gap:10px;align-items:flex-start;font-size:14px;line-height:1.4;animation:sg-in .2s ease-out' +
      (kind === 'err' ? ';border-color:var(--aui-status-error,#b91a24)' : ''),
      html: mark + '<div style="flex:1"><b style="display:block;margin-bottom:2px">' + esc(title) + '</b>' + esc(text) + '</div>' });
    document.querySelectorAll('.sg-toast').forEach((t) => t.remove());
    document.body.appendChild(el);
    if (kind !== 'busy') setTimeout(() => el.remove(), ms);
    return el;
  }

  // Tools tell each other when a cleaning changes (e.g. auto-close finished)
  // so the badge and WO pill refresh without waiting for their timers.
  const emit = (name, detail) => document.dispatchEvent(new CustomEvent('aethernet:' + name, { detail }));
  const on = (name, fn) => document.addEventListener('aethernet:' + name, (e) => fn(e.detail));

  /*
    Shared cleaning data. Everything is read-only and scoped by the portal to
    the logged-in user's current store.
  */
  const data = (() => {
    const OPEN_STATUS_IDS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 17, 24, 26, 27]; // the portal's own "Active" set
    const PAGE_SIZE = 100, PAGE_CAP = 10;

    async function listPage(primaryFilter, page) {
      const j = await api('POST', '/api/workorders', {
        page, pageSize: PAGE_SIZE, deviceTypeIds: [], serviceOutcome: [], programIds: [], needsAttention: false, tab: 'All', primaryFilter,
        // Closed only returns rows with empty status/program filters.
        workOrderStatusIds: primaryFilter === 'Active' ? OPEN_STATUS_IDS : [],
        order: primaryFilter === 'Active' ? 'nextUpdate,DESC' : 'createdAt,DESC',
      });
      return (j && j.workOrders) || [];
    }
    // All open WOs, plus closed WOs created since `sinceMs` (newest first,
    // so paging stops once past it). maxClosedPages bounds old lookbacks.
    async function workorders(sinceMs, maxClosedPages = PAGE_CAP) {
      const byId = new Map();
      for (let p = 1; p <= PAGE_CAP; p++) {
        const rows = await listPage('Active', p);
        rows.forEach((r) => byId.set(r.workorderId, r));
        if (rows.length < PAGE_SIZE) break;
      }
      for (let p = 1; p <= maxClosedPages; p++) {
        const rows = await listPage('Closed', p);
        rows.forEach((r) => byId.set(r.workorderId, r));
        const lastRow = rows[rows.length - 1];
        if (rows.length < PAGE_SIZE || !lastRow || Date.parse(lastRow.createdAt) < sinceMs) break;
      }
      return [...byId.values()];
    }
    // Arrivals not yet checked in. pageSize=100 is honored (the UI uses 10).
    async function arrivals() {
      const out = [];
      for (let p = 1; p <= PAGE_CAP; p++) {
        const j = await api('GET', '/api/arrivals/upcoming-arrivals?page=' + p + '&pageSize=' + PAGE_SIZE);
        const rows = (j && j.data) || [];
        out.push(...rows);
        if (rows.length < PAGE_SIZE || out.length >= ((j && j.rowCount) || 0)) break;
      }
      return out;
    }

    const imeiOf = (r) => { const i = String((r.customerDevice && r.customerDevice.imei) || (r.CustomerDevice && r.CustomerDevice.imei) || '').trim(); return /^\d{14,15}$/.test(i) ? i : null; };
    const custOf = (r) => String((r.customer && (r.customer.customerId ?? r.customer.id)) || (r.customerDevice && r.customerDevice.customerId) || '');
    const nameOf = (r) => {
      const c = r.customer || {};
      const n = (c.fullName || [c.givenName || c.firstName, c.familyName || c.lastName].filter(Boolean).join(' ')).trim();
      // Many names are stored ALL CAPS; show those in Title Case, leave mixed case alone.
      return n === n.toUpperCase() ? n.toLowerCase().replace(/(^|[\s'-])\S/g, (m) => m.toUpperCase()) : n;
    };

    /*
      Cleanings as one list: cleaning WOs (done or in progress) plus cleaning
      arrivals not yet checked in ("pending"). An arrival is dropped once a
      cleaning WO with the same IMEI + program exists, so nothing is counted
      twice. `keep` filters which records are considered (e.g. created today).
    */
    function cleanings(wos, arrs, keep = () => true) {
      const woCleanings = wos.filter((r) => CLEANING_PROGRAMS[r.programId] && keep(r))
        .map((r) => Object.assign({}, r, { key: 'wo' + r.workorderId, pending: false }));
      const doneKeys = new Set(woCleanings.map((c) => imeiOf(c) + ':' + c.programId));
      const pending = arrs
        .filter((a) => a.program && CLEANING_PROGRAMS[a.program.programId] && keep(a))
        .map((a) => ({ key: 'ar' + a.arrivalId, pending: true, arrivalId: a.arrivalId, programId: a.program.programId,
          customer: a.customer, customerDevice: a.customerDevice, createdAt: a.createdAt }))
        .filter((a) => !(imeiOf(a) && doneKeys.has(imeiOf(a) + ':' + a.programId)));
      return [...woCleanings, ...pending];
    }
    // Does cleaning `c` belong to parent WO `p`? Same IMEI (AT&T cleanings are
    // often under a different customer record); customer ID only without one.
    function belongs(c, p) {
      const pi = imeiOf(p), ci = imeiOf(c);
      if (pi && ci) return pi === ci;
      const pc = custOf(p);
      return !!pc && custOf(c) === pc;
    }

    return { workorders, arrivals, cleanings, belongs, imeiOf, custOf, nameOf };
  })();

  // ------------------------------------------------------ tool registry
  const tools = [];
  function tool(def) { tools.push(def); }
  function start() {
    ensureCss();
    for (const t of tools) {
      if (!settings.tools[t.id]) continue;
      if (t.sites && !t.sites.includes(location.hostname)) continue;
      try { t.run(); } catch (e) { console.error('[' + AE_NAME + '] ' + t.name + ' failed to start', e); }
    }
  }

  // Poll a route/DOM check — the portal is a single-page app, so pages
  // change without a load and the portal re-renders often.
  function every(ms, fn) {
    // Promise.resolve so async callbacks' rejections are caught too.
    const safe = () => Promise.resolve().then(fn).catch((e) => console.error('[' + AE_NAME + ']', e));
    setInterval(safe, ms);
    safe();
  }

  return {
    settings, saveSettings, DEFAULTS, merge, tools, tool, start, every,
    api, unwrap, Stopped, profile, sleep, esc, h, icon, ensureCss, progressPanel,
    confirm: confirmDialog, toast, emit, on, data,
    PARENT_PROGRAM_ID, CLEANING_PROGRAMS,
    autoClose: null, // set by the auto-close tool when it's enabled
  };
})();
