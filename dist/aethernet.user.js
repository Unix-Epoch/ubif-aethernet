// ==UserScript==
// @name         Aethernet — add-on tools for NextGen Portal
// @namespace    garrett.ubif
// @version      2.1.0
// @description  Live cleaning rate, one-click cleaning close-out, Galaxy Diagnostics exception filing, and print-all-labels for portal.ubreakifix.net. Settings: avatar menu → Aethernet settings.
// @match        https://portal.ubreakifix.net/*
// @match        https://forms-prod.sprinklr.com/guided-workflows/6544db26d4b8393a0b65ebb7*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

/* Built by build.py from src/ — edit those files, not this one. */
(function aethernet() {
'use strict';

// ===== 00-core.js =====
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
const AE_VERSION = '2.1.0'; // filled in by build.py
const AE_ON_PORTAL = location.hostname === 'portal.ubreakifix.net';

const AE = (() => {
  const SETTINGS_KEY = 'sg_settings';
  const DEFAULTS = {
    tools: { cleaningRate: true, autoClose: true, galaxy: true, printLabels: true },
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
    const safe = () => { try { fn(); } catch (e) { console.error('[' + AE_NAME + ']', e); } };
    setInterval(safe, ms);
    safe();
  }

  return {
    settings, saveSettings, DEFAULTS, merge, tools, tool, start, every,
    api, unwrap, Stopped, profile, sleep, esc, h, icon, ensureCss, progressPanel,
    PARENT_PROGRAM_ID, CLEANING_PROGRAMS,
  };
})();

// ===== 05-settings.js =====
/*
  Settings: a "Aethernet settings" item in the portal's avatar menu (cloned
  from the portal's own "View my account" item so it matches exactly), which
  opens a pop-out settings card. Also reachable from the Tampermonkey menu.
  Tool on/off changes need a reload, so Save reloads the page.
*/
(function settingsUi() {
  if (!AE_ON_PORTAL) return;
  const { h, esc, icon } = AE;

  const TOOL_INFO = [
    ['cleaningRate', 'Live cleaning rate', "Header badge with today's cleaning percentage."],
    ['autoClose', 'Cleaning auto-close', 'One-click check-in → complete sale on cleaning arrivals.'],
    ['galaxy', 'Galaxy Diagnostics exception', 'Pre-fills the Sprinklr exception form from a Samsung WO.'],
    ['printLabels', 'Print all labels', 'Prints every serial label on a PO Receive page.'],
  ];

  const MODAL_CSS = `
  .sg-scrim { position:fixed; inset:0; z-index:2147483646; background:var(--aui-scrim-overlay, #0c0e1180); display:flex; justify-content:flex-end; }
  .sg-sheet { width:min(440px, 100vw); height:100%; overflow:auto; border-radius:16px 0 0 16px; border-right:0; padding:24px; animation: sg-slide .22s ease-out; }
  @keyframes sg-slide { from { transform: translateX(40px); opacity:0; } to { transform:none; opacity:1; } }
  .sg-sheet h2 { font-size:22px; font-weight:700; margin:0; }
  .sg-sheet h3 { font-size:14px; font-weight:700; margin:24px 0 8px; text-transform:none; }
  .sg-row { display:flex; align-items:center; gap:12px; padding:10px 0; border-top:1px solid var(--aui-outline-soft, #eeedf1); }
  .sg-row:first-of-type { border-top:0; }
  .sg-row > div { flex:1; min-width:0; }
  .sg-row b { font-weight:600; font-size:14px; display:block; }
  .sg-field { display:block; margin:10px 0; }
  .sg-field span { display:block; font-size:12px; color:var(--aui-on-surface-soft, #5d5e61); margin-bottom:4px; }
  .sg-field input { width:100%; height:40px; padding:0 12px; border:1px solid var(--aui-outline, #c6c6ca); border-radius:8px;
    background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e); font:14px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; }
  .sg-field input:focus { outline:2px solid var(--aui-primary, #8223d2); outline-offset:-1px; border-color:transparent; }
  .sg-switch { position:relative; width:44px; height:24px; flex:none; }
  .sg-switch input { opacity:0; width:0; height:0; position:absolute; }
  .sg-switch i { position:absolute; inset:0; border-radius:12px; background:var(--aui-outline, #c6c6ca); transition:background .15s; cursor:pointer; }
  .sg-switch i::after { content:""; position:absolute; top:3px; left:3px; width:18px; height:18px; border-radius:50%; background:#fff; transition:transform .15s; }
  .sg-switch input:checked + i { background:var(--aui-primary, #8223d2); }
  .sg-switch input:checked + i::after { transform:translateX(20px); }
  .sg-kv { display:grid; grid-template-columns: 90px 1fr; gap:6px 12px; font-size:14px; }
  .sg-kv dt { color:var(--aui-on-surface-soft, #5d5e61); } .sg-kv dd { margin:0; overflow-wrap:anywhere; }
  .sg-sheet-foot { position:sticky; bottom:-24px; margin:24px -24px -24px; padding:16px 24px; display:flex; gap:8px;
    background:var(--aui-surface, #fff); border-top:1px solid var(--aui-outline-soft, #eeedf1); }
  .sg-sheet-foot .sg-btn { flex:1; }
  `;

  function open() {
    AE.ensureCss();
    if (!document.getElementById('sg-settings-css')) document.head.append(h('style', { id: 'sg-settings-css' }, MODAL_CSS));
    document.getElementById('sg-settings')?.remove();
    const s = AE.merge(AE.DEFAULTS, AE.settings); // working copy

    const input = (label, value, placeholder, onInput, type = 'text') =>
      h('label', { class: 'sg-field' }, h('span', null, label),
        h('input', { type, value: value ?? '', placeholder: placeholder || '', oninput: (e) => onInput(e.target.value) }));
    const toggle = (checked, onChange) => h('label', { class: 'sg-switch' },
      h('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) }), h('i'));

    const who = h('dl', { class: 'sg-kv' }, h('dt', null, 'Loading…'));
    const galaxyAuto = { technicianName: '', email: '', location: '' };
    const galaxyInputs = {};

    const sheet = h('div', { class: 'sg sg-card sg-sheet', role: 'dialog', 'aria-label': AE_NAME + ' settings' },
      h('div', { style: 'display:flex;align-items:center;gap:12px' },
        h('span', { style: 'color:var(--aui-primary,#8223d2)', html: icon('aetheryte', 36) }),
        h('div', { style: 'flex:1' }, h('h2', null, AE_NAME), h('div', { class: 'sg-soft' }, 'Add-on tools for NextGen Portal · v' + AE_VERSION)),
        h('button', { class: 'sg-x', title: 'Close', onclick: () => scrim.remove() }, '✕')),

      h('h3', null, 'Signed in as'), who,
      h('div', { class: 'sg-soft', style: 'margin-top:6px' }, 'Pulled from your portal login. Tools use these automatically.'),

      h('h3', null, 'Tools'),
      h('div', null, TOOL_INFO.map(([id, name, desc]) => h('div', { class: 'sg-row' },
        h('div', null, h('b', null, name), h('span', { class: 'sg-soft' }, desc)),
        toggle(!!s.tools[id], (v) => { s.tools[id] = v; })))),

      h('h3', null, 'Live cleaning rate'),
      input('Target %', s.cleaningRate.target, '75', (v) => { s.cleaningRate.target = Number(v) || AE.DEFAULTS.cleaningRate.target; }, 'number'),

      h('h3', null, 'Galaxy Diagnostics exception'),
      h('div', { class: 'sg-soft' }, 'Leave blank to use your login. Only fill in to override.'),
      (galaxyInputs.technicianName = input('Technician name', s.galaxy.technicianName, '', (v) => { s.galaxy.technicianName = v.trim(); })),
      (galaxyInputs.email = input('Your email', s.galaxy.email, '', (v) => { s.galaxy.email = v.trim(); })),
      (galaxyInputs.location = input('UBIF location (as shown in the form)', s.galaxy.location, '', (v) => { s.galaxy.location = v.trim(); })),
      input('Store email (optional)', s.galaxy.storeEmail, 'Left blank', (v) => { s.galaxy.storeEmail = v.trim(); }),
      input('Tool version', s.galaxy.toolVersion, 'Latest', (v) => { s.galaxy.toolVersion = v.trim() || 'Latest'; }),
      input('Description', s.galaxy.description, 'ER', (v) => { s.galaxy.description = v; }),
      h('button', { class: 'sg-btn', style: 'margin-top:4px', onclick: (e) => { GM_deleteValue('gde_btn_pos'); e.target.textContent = 'Button position reset'; } }, 'Reset button position'),

      h('h3', null, 'Print all labels'),
      input('Delay between labels (ms)', s.printLabels.delayMs, '900', (v) => { s.printLabels.delayMs = Math.max(200, Number(v) || 900); }, 'number'),

      h('div', { class: 'sg-sheet-foot' },
        h('button', { class: 'sg-btn sg-lg', onclick: () => scrim.remove() }, 'Cancel'),
        h('button', { class: 'sg-btn sg-lg sg-primary', onclick: () => { AE.saveSettings(s); location.reload(); } }, 'Save & reload')));

    const scrim = h('div', { class: 'sg sg-scrim', id: 'sg-settings', onclick: (e) => { if (e.target === scrim) scrim.remove(); } }, sheet);
    document.body.appendChild(scrim);
    const onKey = (e) => { if (e.key === 'Escape') { scrim.remove(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);

    AE.profile().then((p) => {
      const loc = p.storeId ? p.storeId + ' ' + p.storeName : '';
      who.replaceChildren(
        h('dt', null, 'Name'), h('dd', null, p.name || '—'),
        h('dt', null, 'Email'), h('dd', null, p.email || '—'),
        h('dt', null, 'Store'), h('dd', null, loc || '—'));
      galaxyAuto.technicianName = p.name; galaxyAuto.email = p.email; galaxyAuto.location = loc;
      for (const k of Object.keys(galaxyAuto)) galaxyInputs[k].querySelector('input').placeholder = 'Auto: ' + (galaxyAuto[k] || '—');
    }).catch((e) => { who.replaceChildren(h('dt', null, 'Error'), h('dd', null, esc(e.message))); });
  }

  // Add our item to the avatar menu whenever the portal renders it.
  AE.every(400, () => {
    const logout = document.querySelector('[data-testid="option-logout"]');
    const model = document.querySelector('[data-testid="option-view-account"]');
    if (!logout || !model || document.querySelector('[data-testid="option-aethernet"]')) return;
    const item = model.cloneNode(true); // same classes → same look, both themes
    item.setAttribute('data-testid', 'option-aethernet');
    const label = item.querySelector('[data-aui="text"]') || item;
    label.textContent = AE_NAME + ' settings';
    item.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // close the portal's menu the way a user would, then open ours
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      open();
    });
    logout.parentElement.insertBefore(item, logout);
  });

  if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand(AE_NAME + ' settings', open);
  AE.openSettings = open;
})();

// ===== 10-cleaning-rate.js =====
/*
  Live cleaning rate — header badge.

  Rate = cleanings linked to today's Asurion Mobility orders ÷ Asurion
  Mobility orders created today (local time). Each cleaning counts on its
  own, so it can pass 100%. Raw percentage only: reason notes are ignored.
  Cleanings link to orders by device IMEI (AT&T cleanings are often under a
  different customer record), falling back to customer ID without an IMEI.

  Pending cleanings count too: a cleaning arrival created today that hasn't
  been checked in yet (still in Arrivals) is a cleaning that's been set up,
  so it counts toward the rate and shows as "pending". Once it's checked in
  it becomes a WO, and the arrival is skipped if a cleaning WO with the same
  IMEI and program already exists, so it's never counted twice.

  Read-only list calls, scoped by the portal to the user's current store:
  open WOs, closed WOs, and upcoming arrivals.
*/
AE.tool({
  id: 'cleaningRate',
  name: 'Live cleaning rate',
  sites: ['portal.ubreakifix.net'],
  run() {
    const { h, esc } = AE;
    const TARGET = AE.settings.cleaningRate.target;
    const REFRESH_MS = 2 * 60 * 1000;
    const OPEN_STATUS_IDS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 17, 24, 26, 27]; // the portal's own "Active" set
    const PAGE_SIZE = 100, PAGE_CAP = 10;
    const BADGE_ID = 'sg-rate-badge', PANEL_ID = 'sg-rate-panel';
    let last = null, loading = false, lastError = null;

    document.head.append(h('style', null, `
      #${BADGE_ID} { display:inline-flex; align-items:center; gap:8px; height:32px; padding:0 14px; margin:0 8px 0 12px; border-radius:10000rem;
        border:1px solid transparent; font:400 14px/1 Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; cursor:pointer; white-space:nowrap;
        font-variant-numeric:tabular-nums; }
      #${BADGE_ID} b { font-weight:700; }
      #${BADGE_ID} .dot { width:8px; height:8px; border-radius:50%; background:currentColor; flex:none; }
      #${BADGE_ID}.floating { position:fixed; left:16px; bottom:16px; z-index:2147483645; box-shadow:0 4px 14px rgba(12,14,17,.2); }
      #${BADGE_ID}.good { background:var(--aui-status-success-soft,#c5ffc8); color:var(--aui-status-on-success-soft,#062011); }
      #${BADGE_ID}.ok   { background:var(--aui-status-warning-soft,#fff0c0); color:var(--aui-status-on-warning-soft,#3a3000); }
      #${BADGE_ID}.bad  { background:var(--aui-status-error-soft,#ffdad7);  color:var(--aui-status-on-error-soft,#410004); }
      #${BADGE_ID}.none { background:transparent; border-color:var(--aui-outline,#c6c6ca); color:var(--aui-on-surface-soft,#5d5e61); }
      #${BADGE_ID} .sg-spin { width:12px; height:12px; }
      #${PANEL_ID} .who { font-weight:600; }
      #${PANEL_ID} td:first-child { width:48%; }
      #${PANEL_ID} .sg-soft a { font-weight:400; }
      #${PANEL_ID} { position:fixed; z-index:2147483646; width:440px; max-height:70vh; overflow:auto; padding:16px; font-size:14px; line-height:1.4; }
      #${PANEL_ID} table { width:100%; border-collapse:collapse; margin-top:10px; }
      #${PANEL_ID} td { padding:8px 4px; border-top:1px solid var(--aui-outline-soft,#eeedf1); vertical-align:top; }
      #${PANEL_ID} a { color:var(--aui-primary,#8223d2); text-decoration:none; font-weight:600; }
      #${PANEL_ID} a:hover { text-decoration:underline; }
      #${PANEL_ID} .miss { color:var(--aui-status-error,#b91a24); font-weight:600; }
      #${PANEL_ID} .chip { display:inline-block; margin:0 4px 4px 0; padding:2px 8px; border-radius:10000rem; font-size:12px;
        background:var(--aui-primary-soft,#faecff); color:var(--aui-on-primary-soft,#590099); font-weight:400; }
      #${PANEL_ID} .chip:hover { text-decoration:none; filter:brightness(.96); }
      #${PANEL_ID} .chip.pending { background:transparent; border:1px dashed var(--aui-primary,#8223d2); color:var(--aui-primary,#8223d2); padding:1px 7px; }
    `));

    async function listPage(primaryFilter, page) {
      const j = await AE.api('POST', '/api/workorders', {
        page, pageSize: PAGE_SIZE, deviceTypeIds: [], serviceOutcome: [], programIds: [], needsAttention: false, tab: 'All', primaryFilter,
        // Closed only returns rows with empty status/program filters.
        workOrderStatusIds: primaryFilter === 'Active' ? OPEN_STATUS_IDS : [],
        order: primaryFilter === 'Active' ? 'nextUpdate,DESC' : 'createdAt,DESC',
      });
      return (j && j.workOrders) || [];
    }
    async function fetchToday(startMs) {
      const byId = new Map();
      for (let p = 1; p <= PAGE_CAP; p++) {
        const rows = await listPage('Active', p);
        rows.forEach((r) => byId.set(r.workorderId, r));
        if (rows.length < PAGE_SIZE) break;
      }
      for (let p = 1; p <= PAGE_CAP; p++) { // newest-created first; stop once past midnight
        const rows = await listPage('Closed', p);
        rows.forEach((r) => byId.set(r.workorderId, r));
        const lastRow = rows[rows.length - 1];
        if (rows.length < PAGE_SIZE || !lastRow || Date.parse(lastRow.createdAt) < startMs) break;
      }
      return [...byId.values()];
    }
    // Arrivals not yet checked in. pageSize=100 is honored (the UI uses 10).
    async function fetchArrivals() {
      const out = [];
      for (let p = 1; p <= PAGE_CAP; p++) {
        const j = await AE.api('GET', '/api/arrivals/upcoming-arrivals?page=' + p + '&pageSize=' + PAGE_SIZE);
        const rows = (j && j.data) || [];
        out.push(...rows);
        if (rows.length < PAGE_SIZE || out.length >= ((j && j.rowCount) || 0)) break;
      }
      return out;
    }
    const imeiOf = (r) => { const i = String((r.customerDevice && r.customerDevice.imei) || '').trim(); return /^\d{14,15}$/.test(i) ? i : null; };
    const nameOf = (r) => {
      const c = r.customer || {};
      const n = (c.fullName || [c.givenName || c.firstName, c.familyName || c.lastName].filter(Boolean).join(' ')).trim();
      // Many names are stored ALL CAPS; show those in Title Case, leave mixed case alone.
      return n === n.toUpperCase() ? n.toLowerCase().replace(/(^|[\s'-])\S/g, (m) => m.toUpperCase()) : n;
    };
    const custOf = (r) => String((r.customer && (r.customer.customerId ?? r.customer.id)) || (r.customerDevice && r.customerDevice.customerId) || '');

    async function compute() {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const startMs = start.getTime(), endMs = startMs + 86400000;
      const [all, arrivals] = await Promise.all([fetchToday(startMs), fetchArrivals()]);
      const today = (r) => { const t = Date.parse(r.createdAt); return t >= startMs && t < endMs; };
      const parents = all.filter((r) => r.programId === AE.PARENT_PROGRAM_ID && today(r)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      const woCleanings = all.filter((r) => AE.CLEANING_PROGRAMS[r.programId] && today(r))
        .map((r) => Object.assign({}, r, { key: 'wo' + r.workorderId, pending: false }));
      const doneKeys = new Set(woCleanings.map((c) => imeiOf(c) + ':' + c.programId));
      const pendingCleanings = arrivals
        .filter((a) => a.program && AE.CLEANING_PROGRAMS[a.program.programId] && today(a))
        .map((a) => ({ key: 'ar' + a.arrivalId, pending: true, arrivalId: a.arrivalId, programId: a.program.programId,
          customer: a.customer, customerDevice: a.customerDevice, createdAt: a.createdAt }))
        .filter((a) => !(imeiOf(a) && doneKeys.has(imeiOf(a) + ':' + a.programId))); // already checked in
      const cleanings = [...woCleanings, ...pendingCleanings];
      const used = new Set();
      const rows = parents.map((p) => {
        const pImei = imeiOf(p), pCust = custOf(p);
        const matched = cleanings.filter((c) => {
          if (used.has(c.key)) return false;
          const cImei = imeiOf(c);
          return pImei && cImei ? cImei === pImei : (!!pCust && custOf(c) === pCust);
        });
        matched.forEach((c) => used.add(c.key));
        return { p, matched };
      });
      const linked = rows.reduce((n, r) => n + r.matched.length, 0);
      const pending = rows.reduce((n, r) => n + r.matched.filter((c) => c.pending).length, 0);
      return {
        parents: parents.length, linked, pending, rows, at: new Date(),
        unlinked: cleanings.filter((c) => !used.has(c.key)),
        pct: parents.length ? Math.round((linked / parents.length) * 100) : null,
      };
    }

    const level = (pct) => (pct == null ? 'none' : pct >= 100 ? 'good' : pct >= TARGET ? 'ok' : 'bad');
    const levelColor = (pct) => ({ good: 'var(--aui-status-success,#136d31)', ok: 'var(--aui-on-surface,#1a1c1e)', bad: 'var(--aui-status-error,#b91a24)', none: 'inherit' }[level(pct)]);
    const fmtTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    function renderBadge() {
      let b = document.getElementById(BADGE_ID);
      if (!b) b = h('button', { id: BADGE_ID, type: 'button', class: 'sg', onclick: togglePanel });
      // Sits left of "UBIF support" in the header; floats bottom-left if that's missing.
      const anchor = [...document.querySelectorAll('button')].find((x) => x.offsetParent && x.textContent.trim() === 'UBIF support');
      if (anchor && b.parentElement !== anchor.parentElement) { b.classList.remove('floating'); anchor.parentElement.insertBefore(b, anchor); }
      else if (!anchor && !b.isConnected) { b.classList.add('floating'); document.body.appendChild(b); }
      b.classList.remove('good', 'ok', 'bad', 'none');
      b.classList.add(lastError && !last ? 'none' : level(last && last.pct));
      const text = lastError && !last ? 'Cleanings: error'
        : !last ? 'Cleanings'
        : last.pct == null ? 'Cleanings · no AM orders yet'
        : null;
      const lead = loading ? '<span class="sg-spin"></span>' : '<span class="dot"></span>';
      b.innerHTML = lead + (text ? esc(text) : 'Cleanings ' + last.linked + '/' + last.parents + ' · <b>' + last.pct + '%</b>');
      // Narrow windows: if the full badge makes the header overflow (pushing
      // the avatar off-screen), fall back to just the dot and percentage.
      // Measured synchronously each render, so it adapts both ways without flicker.
      const hdr = b.closest('header');
      if (hdr && hdr.scrollWidth > hdr.clientWidth) {
        b.innerHTML = lead + (text ? '' : '<b>' + last.pct + '%</b>');
      }
      b.title = (last && last.pct != null ? 'Cleanings ' + last.linked + '/' + last.parents + ' · ' + last.pct + '%' +
        (last.pending ? ' (' + last.pending + ' pending)' : '') + ' — ' : '') +
        (last ? 'updated ' + fmtTime(last.at) : 'Loading') + (lastError ? ' — last refresh failed: ' + lastError : '') +
        ' · target ' + TARGET + '%, ideally 100% · click for details';
      if (document.getElementById(PANEL_ID)) renderPanel();
    }

    function renderPanel() {
      let p = document.getElementById(PANEL_ID);
      if (!p) { p = h('div', { id: PANEL_ID, class: 'sg sg-card' }); document.body.appendChild(p); }
      const b = document.getElementById(BADGE_ID);
      const r = b && b.getBoundingClientRect();
      if (r && !b.classList.contains('floating')) { p.style.top = (r.bottom + 8) + 'px'; p.style.left = Math.max(8, Math.min(r.left, innerWidth - 456)) + 'px'; p.style.bottom = ''; }
      else { p.style.left = '16px'; p.style.bottom = '60px'; p.style.top = ''; }
      if (!last) { p.innerHTML = lastError ? '<span class="miss">' + esc(lastError) + '</span>' : '<span class="sg-soft">Loading…</span>'; return; }

      const linkTo = (c) => c.pending
        ? '<a href="/check-in/arrivals/' + c.arrivalId + '">arrival ' + c.arrivalId + '</a>'
        : '<a href="/repair/workorder/' + c.workorderId + '">' + c.workorderId + '</a>';
      const chip = (c) => c.pending
        ? '<a class="chip pending" href="/check-in/arrivals/' + c.arrivalId + '" title="In Arrivals — not checked in yet">' + esc(AE.CLEANING_PROGRAMS[c.programId]) + ' · pending</a>'
        : '<a class="chip" href="/repair/workorder/' + c.workorderId + '">' + esc(AE.CLEANING_PROGRAMS[c.programId]) + '</a>';
      const table = last.rows.length
        ? '<table>' + last.rows.map(({ p: wo, matched }) => {
          return '<tr><td><div class="who">' + esc(nameOf(wo) || 'Unknown customer') + '</div>' +
            '<div class="sg-soft"><a href="/repair/workorder/' + wo.workorderId + '">' + wo.workorderId + '</a> · ' + fmtTime(new Date(wo.createdAt)) + '</div></td>' +
            '<td style="text-align:right">' +
            (matched.length ? matched.map(chip).join('') : '<span class="miss">No cleanings</span>') +
            '</td></tr>';
        }).join('') + '</table>'
        : '<p class="sg-soft">No Asurion Mobility orders created today yet.</p>';
      const extra = last.unlinked.length
        ? '<p class="sg-soft" style="margin:10px 0 0">' + last.unlinked.length + " cleaning(s) today not linked to any of today's orders (not counted): " +
          last.unlinked.map(linkTo).join(', ') + '</p>'
        : '';
      p.innerHTML =
        '<div style="display:flex;align-items:baseline;gap:8px"><b style="flex:1;font-size:16px">Today\'s cleaning rate: <span style="color:' + levelColor(last.pct) + '">' +
        (last.pct == null ? '—' : last.pct + '%') + '</span></b><button type="button" class="sg-btn" data-refresh>Refresh</button></div>' +
        '<div class="sg-soft" style="margin-top:4px">' + last.linked + ' cleanings' + (last.pending ? ' (' + last.pending + ' pending in Arrivals)' : '') +
        ' ÷ ' + last.parents + ' Asurion Mobility orders created today · target ' + TARGET +
        '%, ideally 100% · updated ' + fmtTime(last.at) + (lastError ? '<br><span class="miss">Last refresh failed: ' + esc(lastError) + '</span>' : '') + '</div>' +
        table + extra;
      p.querySelector('[data-refresh]').onclick = (e) => { e.stopPropagation(); refresh(); };
    }

    function togglePanel(e) {
      e.stopPropagation();
      const p = document.getElementById(PANEL_ID);
      if (p) p.remove(); else renderPanel();
    }
    document.addEventListener('click', (e) => {
      const p = document.getElementById(PANEL_ID), b = document.getElementById(BADGE_ID);
      if (p && !p.contains(e.target) && !(b && b.contains(e.target))) p.remove();
    });

    async function refresh() {
      if (loading) return;
      loading = true; renderBadge();
      try { last = await compute(); lastError = null; }
      catch (e) { lastError = e.message || String(e); }
      finally { loading = false; renderBadge(); }
    }

    const onPortal = () => !/^\/login/.test(location.pathname);
    AE.every(1500, () => { if (onPortal()) renderBadge(); }); // SPA re-renders can drop the badge
    setInterval(() => { if (onPortal() && !document.hidden) refresh(); }, REFRESH_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && onPortal() && (!last || Date.now() - last.at > REFRESH_MS)) refresh();
    });
    if (onPortal()) refresh();
  },
});

// ===== 20-auto-close.js =====
/*
  Cleaning auto-close — round purple ⚡ button in a cleaning arrival's
  "Customer arrival" drawer. One click replays the portal's own API sequence
  (see the vault note "Cleaning WO Flow"):

    check-in    validate-imei → checkin/workorder → calculate-sla →
                update-service-job-status → PUT checkin/workorder   (status 8)
    status walk PATCH status 9, then PUT workorder 10 → 11 → 12 → 13,
                each followed by the same auto-note the UI posts
    checkout    verify cart total is $0 → checkout/complete-order

  Deliberately NOT replayed: PUT checkin/customers (re-saves the customer)
  and PUT customer-devices (would blank the shared device's nickname and
  passcode on the parent WO). A Stop button halts before the next call.
*/
AE.tool({
  id: 'autoClose',
  name: 'Cleaning auto-close',
  sites: ['portal.ubreakifix.net'],
  run() {
    const { h, icon } = AE;
    const DEVICE_ISSUES = ['Cleaning'];
    const BIN = ''; // cleanings aren't physical — no bin
    const STEP_DELAY_MS = 400;
    const BTN_ID = 'sg-autoclose-btn';
    let checkedArrivalId = null, isCleaning = false, running = false, stopRequested = false;

    async function api(method, path, body) {
      const r = await AE.api(method, path, body, { shouldStop: () => stopRequested });
      await AE.sleep(STEP_DELAY_MS);
      return r;
    }
    const unwrap = AE.unwrap;

    async function run(arrivalId, log) {
      const arrival = unwrap(await api('GET', '/api/arrivals/' + arrivalId));
      const programId = arrival.program && arrival.program.programId;
      if (!AE.CLEANING_PROGRAMS[programId]) throw new Error('Not a cleaning program (' + programId + ') — refusing.');
      const dev = arrival.customerDevice || {};
      const customerId = String(arrival.customer.customerId);
      const clientId = arrival.clientId;
      const storeId = arrival.storeId;
      const serviceJobId = arrival.partnerJobDetails && arrival.partnerJobDetails.serviceJobId;

      const tech = (await AE.profile()).name;
      if (!tech) throw new Error("Couldn't read your name from your login — refusing to post nameless notes.");

      // 1. IMEI — the arrival carries all 15 digits (the drawer masks the last).
      //    Try the known last digit first, then the rest of 0–9.
      const imei = String(dev.imei || '');
      if (!/^\d{14,15}$/.test(imei)) throw new Error('No usable IMEI on this arrival — check in by hand.');
      const first14 = imei.slice(0, 14);
      const candidates = imei.length === 15 ? [imei[14], ...'0123456789'.split('').filter((d) => d !== imei[14])] : '0123456789'.split('');
      let validImei = null;
      for (const d of candidates) {
        const r = await api('POST', '/api/arrivals/' + arrivalId + '/validate-imei', { arrivalId, imei: first14 + d, lastDigits: d });
        if (r && r.valid) { validImei = first14 + d; break; }
      }
      if (!validImei) throw new Error('IMEI failed validation for every last digit 0–9.');
      log('IMEI validated');

      // 2. Create the WO.
      const created = await api('POST', '/api/checkin/workorder', {
        itemswithdevice: [], customerDeviceId: String(dev.customerDeviceId), arrivalId, isWarrantyVoided: false, clientId,
      });
      const woId = created && created.workorder && created.workorder.workorderId;
      if (!woId) throw new Error('Check-in returned no work order ID.');
      log('Created WO ' + woId, woId);

      const sla = await api('POST', '/api/calculate-sla/' + woId);
      if (serviceJobId) {
        await api('POST', '/api/checkin/update-service-job-status/' + encodeURIComponent(serviceJobId), { scenario: 'Create work order', arrivalId, programId });
      }
      await api('PUT', '/api/checkin/workorder', {
        workorderId: woId, deviceIssues: DEVICE_ISSUES, deviceDiagNotes: [], additionalDetails: '',
        customerDeviceId: String(dev.customerDeviceId), itemswithdevice: [],
        estimateRepairTime: (sla && sla.estimateEndTime) || new Date(Date.now() + 2 * 3600e3).toISOString(),
        quotedPrice: '0', isWarrantyVoided: false, arrivalId, isImeiUnavailable: false, isSerialUnavailable: false,
        quoteId: null, binLocation: BIN,
      });
      log('Checked in');

      // 3. Status walk. Notes mirror the UI exactly (incl. its double space
      //    in "completed diagnostics" and which steps use the batch endpoint).
      const note = (noteTag, noteText, batch) => {
        const n = { noteText, customerId, workorderId: woId, noteTag, noteType: 1 };
        return batch ? api('POST', '/api/notes', { notes: [n] }) : api('POST', '/api/note', n);
      };
      const getWo = async () => {
        const r = await api('GET', '/api/workorder/' + woId);
        const wo = Object.assign({}, (r && r.workorder) || unwrap(r));
        delete wo.workorderId;
        return wo;
      };

      await api('PATCH', '/api/workorder/' + woId + '/status', { workorderStatusId: 9 });
      await note('ready_for_work', tech + ' started work.');
      log('Started work');

      const steps = [
        { to: 10, extra: { completedWorkorderStatusId: 9, note: '' }, tag: 'diagnostics', text: tech + '  completed diagnostics.', batch: true, label: 'Diagnostics done' },
        { to: 11, extra: {}, tag: 'work_in_progress', text: tech + ' completed work.', label: 'Work done' },
        { to: 12, extra: {}, tag: 'quality_check', text: tech + ' completed quality check.', label: 'QC done' },
        { to: 13, extra: { sendComms: false }, tag: 'ready_for_pickup', text: tech + ' marked the device as "Ready for pickup." - Completed', batch: true, label: 'Ready for pickup', attribute: true },
      ];
      for (const s of steps) {
        const wo = await getWo();
        if (s.attribute) {
          await api('POST', '/api/workorder/attribute', {
            workorderId: woId, workorderStatusId: 13, sendComms: false, workorderBin: BIN, storeId,
            WorkorderAttribute: [{ workorderId: woId, workorderAttributeTypeId: 22, key: 'service_outcome', value: 'Completed' }],
          });
        }
        await api('PUT', '/api/workorder/' + woId, Object.assign(wo, { workorderStatusId: s.to, markCurrentStepCompleted: true }, s.extra));
        await note(s.tag, s.text, s.batch);
        log(s.label);
      }

      // 4. Checkout — only if the cart really nets to $0.
      await api('GET', '/api/checkout/workorder/' + woId);
      const wo = await getWo();
      const cart = unwrap(await api('GET', '/api/get-cart/' + encodeURIComponent(wo.csuCartId) + '?includePartStatus=true'));
      const pay = (cart && (cart.payment || (cart.cart && cart.cart.payment))) || null;
      const total = pay ? Number(pay.total) : NaN;
      if (total !== 0) throw new Error('Cart total is ' + (pay ? '$' + pay.total : 'unknown') + ', not $0 — stopped before checkout. Finish at Ready for pickup by hand.');
      await api('POST', '/api/workorder/demographic/customer-data', { customerId, clientId });
      const done = await api('POST', '/api/checkout/complete-order', { workorderId: woId, sendComms: false });
      log('Sale complete' + (done && done.salesOrder && done.salesOrder.salesId ? ' (' + done.salesOrder.salesId + ')' : ''));
      return woId;
    }

    const woLink = (id) => '<a href="/repair/workorder/' + id + '">WO ' + id + '</a>';

    async function onClick(arrivalId) {
      if (running) return;
      running = true; stopRequested = false;
      const panel = AE.progressPanel('Cleaning auto-close');
      const stop = h('button', { class: 'sg-btn sg-lg sg-danger', onclick: () => { stopRequested = true; stop.disabled = true; stop.textContent = 'Stopping after current call…'; } }, '■ Stop');
      panel.actions(stop);
      let woId = null;
      const log = (t, id) => { if (id) woId = id; panel.step(t); };
      const btn = document.getElementById(BTN_ID);
      if (btn) btn.disabled = true;
      try {
        const id = await run(arrivalId, log);
        panel.finish('ok', 'Done — ' + woLink(id) + ' checked in, completed, and sold at $0.');
      } catch (e) {
        const where = woId ? ' ' + woLink(woId) + ' was left at the last step listed above.' : ' No work order was created.';
        const stopped = e instanceof AE.Stopped;
        panel.finish(stopped ? 'stop' : 'err', (stopped ? 'Stopped.' : AE.esc(e.message)) + where);
      } finally {
        panel.actions();
        running = false;
        if (btn) btn.disabled = false;
      }
    }

    const portalCheckinButton = () => [...document.querySelectorAll('button')].find((b) => b.offsetParent && b.textContent.trim() === 'Check-in');

    async function tick() {
      const m = location.pathname.match(/^\/check-in\/arrivals\/(\d+)$/);
      const existing = document.getElementById(BTN_ID);
      if (!m) { existing?.remove(); checkedArrivalId = null; return; }
      const arrivalId = Number(m[1]);
      if (checkedArrivalId !== arrivalId) {
        checkedArrivalId = arrivalId; isCleaning = false; existing?.remove();
        try {
          const a = unwrap(await AE.api('GET', '/api/arrivals/' + arrivalId));
          isCleaning = !!AE.CLEANING_PROGRAMS[a && a.program && a.program.programId];
        } catch (_) { checkedArrivalId = null; } // retry next tick
      }
      if (!isCleaning) return;
      const checkin = portalCheckinButton();
      if (!checkin || document.getElementById(BTN_ID)) return;
      // The drawer footer is a full-width flex row justified to flex-end; as its
      // first child with margin-right:auto, the button sits alone at the far left.
      let footer = checkin.parentElement;
      for (let el = checkin.parentElement; el && el !== document.body; el = el.parentElement) {
        if (getComputedStyle(el).justifyContent === 'flex-end') { footer = el; break; }
      }
      const size = checkin.offsetHeight || 48;
      const b = h('button', {
        id: BTN_ID, type: 'button', class: 'sg-fab', 'aria-label': 'Auto-close cleaning',
        title: 'Auto-close cleaning: check in, walk to Ready for pickup, and complete the $0 sale',
        style: 'margin-right:auto;align-self:center;color:#fff;width:' + size + 'px;height:' + size + 'px',
        html: icon('bolt', Math.round(size * 0.5)),
        onclick: () => onClick(arrivalId),
      });
      footer.insertBefore(b, footer.firstChild);
    }
    AE.every(1000, tick);
  },
});

// ===== 30-galaxy.js =====
/*
  Galaxy Diagnostics exception — two halves sharing data through
  Tampermonkey storage (GM_*, scoped per script, not per site):

  A. Portal WO page: once a "GSPN No. ######" badge exists, shows a
     draggable, collapsible button. Click → gathers IMEI / device name /
     GSPN ticket / WO number from the portal API, plus the technician,
     email and store from the logged-in user (overridable in settings),
     and opens the Sprinklr form in a new tab.
  B. Sprinklr form: picks up that handoff and fills every field, including
     the Issue → Exception → Reason cascade. It does NOT submit.

  Filling needs real interactions: element.click() for the custom
  dropdowns, and the native value setter + input event for text fields
  (plain .value = doesn't register with React).
*/
AE.tool({
  id: 'galaxy',
  name: 'Galaxy Diagnostics exception',
  sites: ['portal.ubreakifix.net', 'forms-prod.sprinklr.com'],
  run() {
    const { h, icon, sleep } = AE;
    // Handoffs are a map keyed by WO id, so two forms opened close together
    // each get their own WO's data. Each form tab takes the oldest one.
    const HANDOFFS_KEY = 'gde_handoffs';
    const HANDOFF_MAX_AGE_MS = 10 * 60 * 1000;
    const FORM_URL = 'https://forms-prod.sprinklr.com/guided-workflows/6544db26d4b8393a0b65ebb7?gwId=744690&viewType=FULL_PAGE';
    const FIXED = { REPAIR_LOCATION_TYPE: 'Store', ISSUE_TYPE: 'Exception Request', EXCEPTION_TYPE: 'Galaxy Diagnostic Tool', EXCEPTION_REASON: 'Asurion Repair' };

    function setNativeValue(el, value) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Small status card, top-left (form) or bottom-left (portal).
    function toast(text, kind, where = 'top') {
      AE.ensureCss();
      let el = document.getElementById('sg-galaxy-toast');
      if (!el) {
        el = h('div', { id: 'sg-galaxy-toast', class: 'sg sg-card', style: 'position:fixed;z-index:2147483647;left:16px;max-width:440px;padding:12px 16px;display:flex;gap:10px;align-items:flex-start;font-size:14px;line-height:1.4' });
        document.body.appendChild(el);
      }
      el.style.top = where === 'top' ? '16px' : '';
      el.style.bottom = where === 'top' ? '' : '16px';
      const mark = kind === 'busy' ? '<span class="sg-spin" style="margin-top:2px"></span>'
        : '<span class="sg-icon-state" style="color:' + (kind === 'ok' ? 'var(--aui-status-success,#136d31)' : 'var(--aui-status-error,#b91a24)') + '">' + (kind === 'ok' ? '✓' : '!') + '</span>';
      el.innerHTML = mark + '<div style="flex:1"><b style="display:block;margin-bottom:2px">Galaxy Diagnostics exception</b>' + AE.esc(text) + '</div>';
      el.style.borderColor = kind === 'err' ? 'var(--aui-status-error,#b91a24)' : '';
      if (where !== 'top' && kind !== 'busy') setTimeout(() => el.remove(), 8000);
    }

    // ------------------------------------------------------------ PART A
    if (AE_ON_PORTAL) {
      let injectedForWoId = null;
      // Position/collapsed persist across reloads and SPA route changes —
      // tick() rebuilds the button often, so this can't be a local variable.
      const POS_KEY = 'gde_btn_pos', COLLAPSED_KEY = 'gde_btn_collapsed';
      const loadPos = () => GM_getValue(POS_KEY, { right: 16, bottom: 16 });
      const savePos = (pos) => GM_setValue(POS_KEY, pos);

      // Window listeners added once; the grip's mousedown points dragState
      // at whichever button currently exists.
      let dragState = null, suppressNextClick = false;
      window.addEventListener('mousemove', (e) => {
        if (!dragState) return;
        dragState.wrap.style.right = Math.max(0, dragState.startRight - (e.clientX - dragState.startX)) + 'px';
        dragState.wrap.style.bottom = Math.max(0, dragState.startBottom - (e.clientY - dragState.startY)) + 'px';
        dragState.moved = true;
      });
      window.addEventListener('mouseup', () => {
        if (!dragState) return;
        savePos(clampToViewport(dragState.wrap));
        // Only the click belonging to this mouseup is swallowed.
        if (dragState.moved) { suppressNextClick = true; setTimeout(() => { suppressNextClick = false; }, 0); }
        dragState = null;
      });
      function clampToViewport(wrap) {
        const rect = wrap.getBoundingClientRect();
        const right = Math.min(Math.max(0, parseInt(wrap.style.right, 10) || 0), Math.max(0, innerWidth - rect.width));
        const bottom = Math.min(Math.max(0, parseInt(wrap.style.bottom, 10) || 0), Math.max(0, innerHeight - rect.height));
        wrap.style.right = right + 'px'; wrap.style.bottom = bottom + 'px';
        return { right, bottom };
      }
      window.addEventListener('resize', () => { const w = document.getElementById('sg-galaxy-btn'); if (w) savePos(clampToViewport(w)); });

      const currentWoId = () => { const m = location.pathname.match(/\/workorder\/(\d+)/); return m ? m[1] : null; };
      const gspnTicketOnPage = () => { const m = document.body.innerText.match(/GSPN No\.\s*([0-9]+)/); return m ? m[1] : null; };

      async function collectData(woId) {
        const json = await AE.api('GET', '/api/workorder/' + woId);
        if (!json || !json.workorder) throw new Error('the portal returned no work order data');
        const wo = json.workorder;
        const device = wo.CustomerDevice || {};
        const attrs = (wo.PartnerJob || {}).PartnerJobAttributes || [];
        // attribute type 53 = the "GSPN No." ticket (confirmed on two WOs);
        // falls back to the badge text if the API shape changes.
        const gspnAttr = attrs.find((a) => a.partnerJobAttributeTypeId === 53);
        const p = await AE.profile();
        const g = AE.settings.galaxy;
        return {
          woId,
          imei: device.imei || '',
          deviceName: (device.DeviceCatalog || {}).name || '',
          gspn: (gspnAttr && gspnAttr.value) || gspnTicketOnPage() || '',
          technicianName: g.technicianName || p.name,
          email: g.email || p.email,
          location: g.location || (p.storeId ? p.storeId + ' ' + p.storeName : ''),
          locationSearch: g.location || p.storeName, // typed to filter the store picker
          storeEmail: g.storeEmail,
          toolVersion: g.toolVersion || 'Latest',
          description: g.description,
          ts: Date.now(),
        };
      }

      function makeButton() {
        const pos = loadPos();
        const collapsed = GM_getValue(COLLAPSED_KEY, false);
        const wrap = h('div', { id: 'sg-galaxy-btn', class: 'sg', style:
          'position:fixed;z-index:2147483645;right:' + pos.right + 'px;bottom:' + pos.bottom + 'px;display:flex;align-items:center;height:48px;' +
          'border-radius:10000rem;background:var(--aui-primary,#8223d2);color:var(--aui-on-primary,#fff);box-shadow:0 6px 20px rgba(12,14,17,.25);overflow:hidden' });
        const side = 'display:flex;align-items:center;justify-content:center;width:28px;height:100%;color:rgba(255,255,255,.7);user-select:none;';
        const grip = h('div', { title: 'Drag to move · double-click to reset', style: side + 'cursor:move;padding-left:6px', html: AE.icon('grip', 14) });
        grip.addEventListener('dblclick', () => { wrap.style.right = '16px'; wrap.style.bottom = '16px'; savePos({ right: 16, bottom: 16 }); });
        grip.addEventListener('mousedown', (e) => {
          const r = wrap.getBoundingClientRect();
          dragState = { wrap, startX: e.clientX, startY: e.clientY, startRight: innerWidth - r.right, startBottom: innerHeight - r.bottom, moved: false };
          e.preventDefault();
        });
        const main = h('button', { type: 'button', style:
          'display:flex;align-items:center;gap:8px;height:100%;padding:0 ' + (collapsed ? '6px' : '8px') + ';border:0;background:none;color:inherit;cursor:pointer;' +
          'font:600 14px Apercu,"Helvetica Neue",Helvetica,Arial,sans-serif;white-space:nowrap' });
        const label = h('span', null, 'File Galaxy exception');
        const setLabel = (c) => { main.innerHTML = icon('clipboard', 18); if (!c) main.append(label); main.title = c ? 'File Galaxy Diagnostics exception' : ''; };
        setLabel(collapsed);
        const toggle = h('div', { style: side + 'cursor:pointer;padding-right:6px;font-size:16px', title: collapsed ? 'Expand' : 'Collapse' }, collapsed ? '›' : '‹');
        toggle.onclick = (e) => {
          e.stopPropagation();
          const c = !GM_getValue(COLLAPSED_KEY, false);
          GM_setValue(COLLAPSED_KEY, c);
          setLabel(c); toggle.textContent = c ? '›' : '‹'; toggle.title = c ? 'Expand' : 'Collapse';
          savePos(clampToViewport(wrap));
        };
        main.onclick = async () => {
          if (suppressNextClick) { suppressNextClick = false; return; }
          const woId = currentWoId();
          if (!woId) return;
          main.disabled = true;
          toast('Gathering WO data…', 'busy', 'bottom');
          // Open the tab now, while this still counts as a user click — after
          // an await, Chrome treats window.open as an unrequested popup.
          const formTab = window.open('about:blank', '_blank');
          try {
            const data = await collectData(woId);
            if (!data.gspn) { formTab?.close(); toast('No GSPN ticket number on this work order — nothing to file yet.', 'err', 'bottom'); return; }
            const handoffs = GM_getValue(HANDOFFS_KEY, {});
            handoffs[woId] = data;
            GM_setValue(HANDOFFS_KEY, handoffs);
            if (formTab) formTab.location.href = FORM_URL; else window.open(FORM_URL, '_blank');
            toast('Form opened in a new tab for WO ' + woId + '.', 'ok', 'bottom');
          } catch (e) {
            formTab?.close();
            toast('Could not gather WO data: ' + (e && e.message ? e.message : e), 'err', 'bottom');
          } finally {
            main.disabled = false;
          }
        };
        wrap.append(grip, main, toggle);
        document.body.appendChild(wrap);
        savePos(clampToViewport(wrap));
      }

      AE.every(1000, () => {
        const woId = currentWoId();
        const existing = document.getElementById('sg-galaxy-btn');
        if (!woId) { existing?.remove(); injectedForWoId = null; return; }
        const ticket = gspnTicketOnPage();
        if (ticket && (injectedForWoId !== woId || !existing)) { existing?.remove(); makeButton(); injectedForWoId = woId; }
        else if (!ticket && existing) { existing.remove(); injectedForWoId = null; }
      });
    }

    // ------------------------------------------------------------ PART B
    if (location.hostname === 'forms-prod.sprinklr.com') {
      function fieldByLabel(labelText) {
        const lab = [...document.querySelectorAll('label')].find((l) => l.textContent.trim() === labelText);
        let c = lab && lab.parentElement;
        for (let i = 0; i < 5 && c; i++, c = c.parentElement) { const input = c.querySelector('input, textarea'); if (input) return input; }
        return null;
      }
      async function waitForField(labelText, timeoutMs = 4000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) { const f = fieldByLabel(labelText); if (f) return f; await sleep(100); }
        return null;
      }
      async function fillText(labelText, value) {
        const el = await waitForField(labelText);
        if (!el) return false;
        setNativeValue(el, value);
        return true;
      }
      // Cascading dropdowns: click open, optionally type to filter, click the
      // matching option. Re-queried each time — fields remount as the cascade grows.
      async function selectOption(labelText, optionText, typeText) {
        const input = await waitForField(labelText);
        if (!input) return false;
        input.click();
        await sleep(250);
        if (typeText) { setNativeValue(input, typeText); await sleep(400); }
        let opt = null;
        for (let t = 0; t < 15 && !opt; t++) {
          await sleep(100);
          opt = [...document.querySelectorAll('div,li,span')].find((e) => e.children.length === 0 && e.textContent.trim() === optionText && e.getClientRects().length > 0);
        }
        if (!opt) return false;
        opt.click();
        await sleep(200);
        return true;
      }
      function takeHandoff() {
        const handoffs = GM_getValue(HANDOFFS_KEY, {});
        const now = Date.now();
        let oldest = null;
        for (const [id, d] of Object.entries(handoffs)) {
          if (!d || now - d.ts > HANDOFF_MAX_AGE_MS) { delete handoffs[id]; continue; }
          if (!oldest || d.ts < oldest.ts) oldest = d;
        }
        if (oldest) delete handoffs[oldest.woId];
        if (Object.keys(handoffs).length) GM_setValue(HANDOFFS_KEY, handoffs); else GM_deleteValue(HANDOFFS_KEY);
        return oldest;
      }

      async function fill() {
        const data = takeHandoff();
        if (!data) return; // not opened from the WO button, or stale
        toast('Auto-filling from WO ' + data.woId + '…', 'busy');
        const email = await waitForField('Your email address', 8000);
        if (!email) { toast('Form did not load in time — fill it in by hand.', 'err'); return; }

        const failed = [];
        const step = async (label, ok) => { if (!(await ok)) failed.push(label); };
        setNativeValue(email, data.email);
        if (!data.email) failed.push('Your email (none found)');
        await step('UBIF Location', selectOption('UBIF Location', data.location, data.locationSearch));
        await step('Repair Location Type', selectOption('Repair Location Type', FIXED.REPAIR_LOCATION_TYPE));
        await step('Technician Name', fillText('Technician Name', data.technicianName));
        await step('Issue Type', selectOption('Issue Type', FIXED.ISSUE_TYPE));
        await waitForField('Exception Type');
        await step('Exception Type', selectOption('Exception Type', FIXED.EXCEPTION_TYPE));
        await waitForField('Galaxy Diagnostic Exception Reason');
        await step('Exception Reason', selectOption('Galaxy Diagnostic Exception Reason', FIXED.EXCEPTION_REASON));
        await waitForField('IMEI'); // last field in the cascade — once it's there, the rest are too
        await step('Tool Version', fillText('Galaxy Diagnostic Tool Version', data.toolVersion));
        await step('Device Full SKU', fillText('Device Full SKU', data.deviceName));
        await step('GSPN Ticket Number', fillText('GSPN Ticket Number', data.gspn));
        await step('Portal Work Order Number', fillText('Portal Work Order Number', data.woId));
        await step('IMEI', fillText('IMEI', data.imei));
        await step('Description', fillText('Description', data.description));
        if (data.storeEmail) await step('Store email', fillText('Store email address', data.storeEmail));
        if (!data.imei) failed.push('IMEI (none on the WO)');
        if (!data.deviceName) failed.push('Device Full SKU (none on the WO)');

        if (failed.length) toast('WO ' + data.woId + ': could NOT fill ' + failed.join(', ') + ' — fill those in by hand before submitting.', 'err');
        else toast('Filled from WO ' + data.woId + ' — check it over, then hit Submit yourself.', 'ok');
      }
      setTimeout(fill, 800); // the form renders client-side
    }
  },
});

// ===== 40-print-labels.js =====
/*
  Print all labels — on a PO Receive page, a "Print all labels" button next
  to "Generate Labels" that opens each serial row's ⋮ → Print Label in turn,
  paced (settings → delay) so a DYMO LabelWriter keeps up. Print-only: it
  never receives or changes stock.

  If the portal renames its hooks, update SEL_MENU_BTN / SEL_PRINT_OPT.
*/
AE.tool({
  id: 'printLabels',
  name: 'Print all labels',
  sites: ['portal.ubreakifix.net'],
  run() {
    const { h, icon, sleep } = AE;
    const DELAY_MS = AE.settings.printLabels.delayMs;
    const SEL_MENU_BTN = 'button[data-aui="action"]';
    const SEL_PRINT_OPT = 'button[data-testid="option-printLabel"]';
    const SERIAL_RE = /^\s*\d{5,}[-–—]\d{5,}\s*$/;
    const RECEIVE_PATH_RE = /^\/boh\/inventory\/purchase-orders\/[^/]+\/receive\/?$/;
    const visible = (el) => !!el && el.getClientRects().length > 0;

    // ---- find serial rows, expanding collapsed line items first ----
    const serialCount = () => [...document.querySelectorAll('tr')].filter((tr) => SERIAL_RE.test(tr.textContent || '')).length;
    async function expandLineItems() {
      const targets = [...document.querySelectorAll('tr')]
        .filter((tr) => {
          const t = (tr.textContent || '').trim();
          // a product row shows a price and has an expand chevron
          return !SERIAL_RE.test(t) && /\$\d/.test(t) && tr.firstElementChild && tr.firstElementChild.querySelector('svg');
        })
        .map((tr) => { const svg = tr.firstElementChild.querySelector('svg'); return (svg && svg.parentElement) || svg || tr.firstElementChild; });
      for (const el of targets) {
        for (let attempt = 0; attempt < 3; attempt++) {
          const before = serialCount();
          el.click();
          await sleep(450);
          const after = serialCount();
          if (after > before) break;                                   // expanded
          if (after < before) { el.click(); await sleep(350); break; } // was open — re-open
        }
      }
    }
    const serialRows = () => [...document.querySelectorAll('tr')].filter((tr) => SERIAL_RE.test(tr.textContent || '') && tr.querySelector(SEL_MENU_BTN));
    const serialOf = (tr) => (tr.textContent || '').trim();

    // ---- print one row ----
    const printOptionShowing = () => [...document.querySelectorAll(SEL_PRINT_OPT)].some(visible);
    // A menu left open by the previous row would be the "first visible Print
    // Label" this row finds — printing that row twice. Close it first.
    async function closeOpenMenu() {
      for (let i = 0; i < 10 && printOptionShowing(); i++) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        await sleep(60);
      }
      return !printOptionShowing();
    }
    async function printRow(tr) {
      const menuBtn = tr.querySelector(SEL_MENU_BTN);
      if (!menuBtn || !(await closeOpenMenu())) return false;
      menuBtn.scrollIntoView({ block: 'center' });
      await sleep(80);
      menuBtn.click();
      let opt = null;
      for (let i = 0; i < 15 && !opt; i++) { await sleep(40); opt = [...document.querySelectorAll(SEL_PRINT_OPT)].find(visible); }
      if (!opt) return false;
      opt.click(); // fires the DYMO print for this serial
      return true;
    }

    // ---- run with a progress panel (one at a time) ----
    let active = null;
    const btn = (label, cls, onclick) => h('button', { type: 'button', class: 'sg-btn sg-lg ' + (cls || ''), onclick }, label);

    async function runRows(rows, ui) {
      ui.running = true; ui.stop = false;
      const total = rows.length;
      let done = 0;
      const missed = [];
      const count = h('div', null);
      const bar = h('div', { class: 'sg-bar' }, h('i'));
      ui.panel.body.replaceChildren(count, bar);
      const paint = () => {
        count.textContent = done + ' / ' + total + ' sent' + (missed.length ? ' · ' + missed.length + ' missed' : '');
        bar.firstChild.style.width = Math.round(((done + missed.length) / total) * 100) + '%';
      };
      paint();
      const stop = btn('■ Stop', 'sg-danger', () => { ui.stop = true; stop.disabled = true; stop.textContent = 'Stopping…'; });
      ui.panel.actions(stop);
      for (const tr of rows) {
        if (ui.stop) break;
        if (await printRow(tr)) done++; else missed.push(serialOf(tr));
        paint();
        await sleep(DELAY_MS);
      }
      ui.running = false;
      const summary = done + ' / ' + total + ' labels sent' + (missed.length ? ' — ' + missed.length + ' missed' : '') + '.';
      ui.panel.finish(ui.stop ? 'stop' : missed.length ? 'err' : 'ok', (ui.stop ? 'Stopped: ' : '') + summary);
      const close = btn('Close', '', () => { ui.panel.el.remove(); active = null; });
      if (missed.length) {
        ui.panel.actions(btn('Retry missed', 'sg-primary', () => {
          const want = new Set(missed);
          const retry = serialRows().filter((tr) => want.has(serialOf(tr)));
          active = newUi();
          runRows(retry, active);
        }), close);
      } else ui.panel.actions(close);
    }

    function newUi() { return { panel: AE.progressPanel('Print all labels', { clock: false }), running: false, stop: false }; }

    async function onClickPrintAll() {
      if (active && active.panel.el.isConnected) { active.panel.flash(); return; }
      const ui = active = newUi();
      ui.panel.body.textContent = 'Expanding line items…';
      await expandLineItems();
      await sleep(300);
      const rows = serialRows();
      if (!rows.length) {
        ui.panel.finish('err', 'No serial rows found on this page.');
        ui.panel.body.textContent = '';
        ui.panel.actions(btn('Close', '', () => { ui.panel.el.remove(); active = null; }));
        return;
      }
      ui.panel.body.innerHTML = 'Ready to print <b>' + rows.length + '</b> labels, one every ' + DELAY_MS + ' ms (~' +
        Math.ceil((rows.length * (DELAY_MS + 150)) / 1000) + ' s).<div class="sg-soft" style="margin:6px 0 12px">Make sure the DYMO label printer is on and loaded.</div>';
      ui.panel.actions(
        btn('Cancel', '', () => { ui.panel.el.remove(); active = null; }),
        btn('Print ' + rows.length, 'sg-primary', () => runRows(serialRows(), ui)));
    }

    // ---- button next to "Generate Labels", styled like the portal's ----
    function injectButton() {
      const existing = document.getElementById('sg-print-all-btn');
      if (!RECEIVE_PATH_RE.test(location.pathname)) { existing?.remove(); return; }
      if (existing) return;
      const gen = [...document.querySelectorAll('button')].find((b) => /generate labels/i.test(b.textContent || ''));
      if (!gen || !gen.parentElement) return;
      const b = h('button', { id: 'sg-print-all-btn', type: 'button', class: 'sg sg-btn sg-primary', style: 'margin-right:8px;height:' + (gen.offsetHeight || 32) + 'px', onclick: onClickPrintAll });
      b.innerHTML = icon('printer', 16) + '<span>Print all labels</span>';
      gen.parentElement.insertBefore(b, gen);
    }
    // Coalesced to one check per 250ms — a label run mutates the DOM constantly.
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      setTimeout(() => { queued = false; injectButton(); }, 250);
    }).observe(document.body, { childList: true, subtree: true });
    injectButton();
  },
});

AE.start();
})();
