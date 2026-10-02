// ==UserScript==
// @name         Aethernet — crystals for NextGen Portal
// @namespace    garrett.ubif
// @version      2.18.0
// @description  Crystals (add-on tools) for NextGen Portal: live cleaning rate, one-click cleaning close-out, Galaxy Diagnostics exception filing, print-all-labels and buyback add-all for portal.ubreakifix.net. Settings: avatar menu → Aethernet settings.
// @match        https://portal.ubreakifix.net/*
// @match        https://forms-prod.sprinklr.com/guided-workflows/6544db26d4b8393a0b65ebb7*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @updateURL    https://gist.githubusercontent.com/Unix-Epoch/0cf4560c4f26d8ff9091a10068fd3464/raw/aethernet.meta.js
// @downloadURL  https://gist.githubusercontent.com/Unix-Epoch/0cf4560c4f26d8ff9091a10068fd3464/raw/aethernet.user.js
// ==/UserScript==

/* Built by build.py from src/ — edit those files, not this one. */
(function aethernet() {
'use strict';

// ===== 00-core.js =====
/*
  Aethernet core — shared by every crystal (tool) in this bundle.

  - AE.settings: persisted in Tampermonkey storage (GM_*), so Portal and
    the Sprinklr form (a different site) see the same values.
  - AE.profile(): the logged-in user + current store, from /api/auth/user.
    Anything personal (name, email, store) comes from here, never hardcoded.
  - Styling uses Portal's own design tokens (--aui-*), which switch with
    its light/dark theme; the fallbacks are the light-theme values, used on
    pages without the tokens (the Sprinklr form).
  - AE.crystal(): each crystal (our name for a tool) registers here and runs
    in its own try/catch, only if enabled in settings — one crystal breaking
    can't take down the others. Adding a new one = "crystallizing" it.
*/

const AE_NAME = 'Aethernet';
const AE_VERSION = '2.18.0';            // filled in by build.py
const AE_DEV = false;                      // true only in the dev channel ("Aethernet (dev)")
// false (used bare, never declared): build.py swaps it for true in the demo
// channel's build (build.py --demo: only a few crystals, nothing else) and
// false everywhere else, so the other side's code is dropped by the minifier.
const AE_BUILD_TIME = '2026-10-01T20:06:27-04:00';       // ISO time of the build
const AE_BUILD_COMMIT = '48b7949-dirty';   // git commit it was built from ("-dirty" = uncommitted changes)
const AE_INSTALL_URL = 'https://gist.githubusercontent.com/Unix-Epoch/0cf4560c4f26d8ff9091a10068fd3464/raw/aethernet.user.js';
const AE_READABLE_URL = 'https://gist.githubusercontent.com/Unix-Epoch/0cf4560c4f26d8ff9091a10068fd3464/raw/aethernet.readable.js'; // same build, unminified     // where installs update from
// The Portal sandbox (sandbox/server.py: Portal's real app on fake data) — dev builds only.
const AE_SANDBOX = AE_DEV && location.host === 'localhost:8790';
const AE_ON_PORTAL = location.hostname === 'portal.ubreakifix.net' || AE_SANDBOX;
// Swiftcast's refresh labor (SKU 10156) is EXPERIMENTAL: off unless switched on. Flip to true
// (with a notice) once it's verified; everyone who never chose follows it.
const AE_REFRESH_LABOR_DEFAULT = false;

const AE = (() => {
  const SETTINGS_KEY = 'sg_settings';
  const DEFAULTS = {
    crystals: false ? { cleaningRate: true, autoClose: true, glamour: true }
      : { cleaningRate: true, woCleanings: true, textNotes: true, autoClose: true, galaxy: true, printLabels: true, buybacks: true, glamour: true, waymark: true, countCheck: true, rowColors: true, fixes: true },
    cleaningRate: { target: 75 },
    // Swiftcast: offer Dualcast (all of a device's cleanings at once); refreshLabor: null = follow
    // AE.REFRESH_LABOR_DEFAULT (only a user's own choice is stored, so the default can change in a release).
    autoClose: { dualcast: true, refreshLabor: null },
    glamour: { theme: 'portal', custom: [], // custom: [{ id, name, bg, fg, accent, custom: true }]
      login: { image: '', fill: false, mark: true } }, // login page (01b-login.js); image = data URL
    ...(false ? {} : {
      printLabels: { delayMs: 900 },
      fixes: { logoLink: true, scanNav: true, woSort: true, autoNotes: true, notContacted: true, notContactedStatus: 'all', reportsRetry: true }, // notContactedStatus: 'all' | 'notConfirmed' // Master's Mend: one switch per fix (src/58-fixes.js)
      // Blank = use the logged-in user / current store automatically.
      galaxy: { technicianName: '', email: '', location: '', storeEmail: '', toolVersion: 'Latest', description: 'ER' },
    }),
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
  const stored = GM_getValue(SETTINGS_KEY, {});
  // Pre-2.4 installs saved the on/off switches as `tools`; carry them over.
  if (stored.tools && !stored.crystals) { stored.crystals = stored.tools; delete stored.tools; }
  const settings = merge(DEFAULTS, stored);
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

  /*
    Portal's state, from inside the page. Portal is several React apps
    (single-spa), each with its own Redux store; a userscript can't reach
    React or Redux, so a small script in the page finds the stores through
    React's fiber trees (cached a few seconds) and answers AE.portal(op, args)
    synchronously over DOM events (JSON in, JSON out):
      - refresh { tags? }       → invalidate Portal's RTK Query tags in use
                                  (or just `tags`): what's on screen refetches,
                                  as after Portal's own edits. { stores, apis, tags }
      - select { slice, key, pick? } → state[slice][key] from the store that has
                                  it (pick: for a list, just those fields of each item)
      - query { endpoint, list, field } → the newest loaded result of an RTK
                                  Query endpoint: `field` of each item in data[list],
                                  plus the arguments it was loaded with (args)
      - patch { endpoint, patches } → change the newest loaded result of an RTK
                                  Query endpoint in place (immer patches on its data),
                                  as Portal's own patchQueryData does; the screen follows
      - status { endpoint }     → how the newest request of an endpoint went
                                  (status, error, hasData), or found: false
      - dispatch { slice, action } → the action, to the stores that have `slice`
  */
  const BRIDGE_EVENT = 'aethernet:portal';
  function bridgeHook() {
    if (document.getElementById('ae-portal-hook')) return;
    // A plain string: it runs in the page, outside Aethernet (see Glamour).
    const code = [
      '(function (evt) {',
      '  var key = function (n, p) { return Object.keys(n).find(function (k) { return k.indexOf(p) === 0; }); };',
      '  var cache = null, cachedAt = 0;',
      '  function stores() {',
      '    if (cache && Date.now() - cachedAt < 5000) return cache;',
      '    var found = [];',
      '    document.querySelectorAll("*").forEach(function (el) {',
      '      var k = key(el, "__reactContainer$"); if (!k) return;',
      // The container keeps the root fiber from creation; the live tree hangs off its FiberRoot.current.
      '      var root = el[k], stack = [root && root.stateNode && root.stateNode.current || root], seen = 0;',
      '      while (stack.length && seen++ < 20000) {',
      '        var f = stack.pop(); if (!f) continue;',
      '        var p = f.memoizedProps, s = p && (p.store || (p.value && p.value.store));',
      '        if (s && typeof s.dispatch === "function" && typeof s.getState === "function" && found.indexOf(s) < 0) found.push(s);',
      '        if (f.sibling) stack.push(f.sibling);',
      '        if (f.child) stack.push(f.child);',
      '      }',
      '    });',
      '    cache = found; cachedAt = Date.now();',
      '    return found;',
      '  }',
      '  var ops = {',
      '    refresh: function (a) {',
      '      var want = a.tags || null, out = { stores: 0, apis: 0, tags: [] };',
      '      stores().forEach(function (store) {',
      '        out.stores++;',
      '        var state = store.getState() || {};',
      '        Object.keys(state).forEach(function (path) {',
      '          var v = state[path];',
      '          if (!v || typeof v !== "object" || !v.queries || !v.config || !v.provided) return;',
      '          var provided = v.provided.tags || v.provided;',
      '          var types = Object.keys(provided).filter(function (t) { return t !== "keys" && (!want || want.indexOf(t) >= 0); });',
      '          if (!types.length) return;',
      '          store.dispatch({ type: path + "/invalidateTags", payload: types });',
      '          out.apis++;',
      '          types.forEach(function (t) { if (out.tags.indexOf(t) < 0) out.tags.push(t); });',
      '        });',
      '      });',
      '      return out;',
      '    },',
      '    select: function (a) {',
      '      var st = stores().map(function (s) { return s.getState() || {}; }).find(function (st) { return st[a.slice]; });',
      '      var v = st ? st[a.slice][a.key] : null;',
      // pick: for a list, only these fields of each item (keeps the answer small)
      '      if (a.pick && Array.isArray(v)) v = v.map(function (x) { var o = {}; a.pick.forEach(function (k) { o[k] = x && x[k]; }); return o; });',
      '      return { found: !!st, value: v };',
      '    },',
      '    query: function (a) {',
      // The newest loaded result of an RTK Query endpoint: one field from each item of a list in it.
      '      var best = null;',
      '      stores().forEach(function (s) {',
      '        var st = s.getState() || {};',
      '        Object.keys(st).forEach(function (k) {',
      '          var q = st[k] && st[k].queries; if (!q || typeof q !== "object") return;',
      '          Object.keys(q).forEach(function (id) {',
      '            var e = q[id];',
      '            if (e && e.endpointName === a.endpoint && e.status === "fulfilled" && e.data && (!best || e.fulfilledTimeStamp > best.fulfilledTimeStamp)) best = e;',
      '          });',
      '        });',
      '      });',
      '      var list = best && best.data && best.data[a.list];',
      '      return { found: !!best, at: best ? best.fulfilledTimeStamp : 0, args: best ? best.originalArgs : null, items: Array.isArray(list) ? list.map(function (x) { return x && x[a.field]; }) : null };',
      '    },',
      '    patch: function (a) {',
      // Patch the newest loaded result of an endpoint in place (RTK's own patchQueryData action).
      '      var best = null;',
      '      stores().forEach(function (s) {',
      '        var st = s.getState() || {};',
      '        Object.keys(st).forEach(function (k) {',
      '          var q = st[k] && st[k].queries; if (!q || typeof q !== "object") return;',
      '          Object.keys(q).forEach(function (id) {',
      '            var e = q[id];',
      '            if (e && e.endpointName === a.endpoint && e.status === "fulfilled" && (!best || e.fulfilledTimeStamp > best.e.fulfilledTimeStamp)) best = { s: s, k: k, id: id, e: e };',
      '          });',
      '        });',
      '      });',
      '      if (!best) return { ok: false };',
      '      best.s.dispatch({ type: best.k + "/queries/queryResultPatched", payload: { queryCacheKey: best.id, patches: a.patches } });',
      '      return { ok: true };',
      '    },',
      '    status: function (a) {',
      // How the newest request of an endpoint went, whatever happened to it.
      '      var best = null;',
      '      stores().forEach(function (s) {',
      '        var st = s.getState() || {};',
      '        Object.keys(st).forEach(function (k) {',
      '          var q = st[k] && st[k].queries; if (!q || typeof q !== "object") return;',
      '          Object.keys(q).forEach(function (id) {',
      '            var e = q[id];',
      '            if (e && e.endpointName === a.endpoint && (!best || (e.startedTimeStamp || 0) > (best.startedTimeStamp || 0))) best = e;',
      '          });',
      '        });',
      '      });',
      '      if (!best) return { found: false, stores: stores().length };',
      '      var err = best.error ? JSON.stringify(best.error).slice(0, 300) : null;',
      '      return { found: true, status: best.status, error: err, hasData: best.data !== undefined, started: best.startedTimeStamp || null, done: best.fulfilledTimeStamp || null };',
      '    },',
      '    dispatch: function (a) {',
      '      var n = 0;',
      '      stores().forEach(function (s) { if ((s.getState() || {})[a.slice]) { s.dispatch(a.action); n++; } });',
      '      return { stores: n };',
      '    },',
      '  };',
      '  document.addEventListener(evt, function (e) {',
      '    var out;',
      '    try { var req = JSON.parse(e.detail); out = ops[req.op](req.args || {}); }',
      '    catch (err) { out = { error: String(err && err.message || err) }; }',
      '    document.dispatchEvent(new CustomEvent(evt + ":done", { detail: JSON.stringify(out) }));',
      '  });',
      '})(' + JSON.stringify(BRIDGE_EVENT) + ');',
    ].join('\n');
    const s = document.createElement('script');
    s.id = 'ae-portal-hook';
    s.textContent = code;
    (document.head || document.documentElement).append(s);
  }
  function portal(op, args) {
    let result = { error: 'no answer' };
    const done = (e) => { try { result = JSON.parse(e.detail); } catch (_) {} };
    try {
      bridgeHook();
      document.addEventListener(BRIDGE_EVENT + ':done', done, { once: true });
      document.dispatchEvent(new CustomEvent(BRIDGE_EVENT, { detail: JSON.stringify({ op, args }) })); // handled synchronously
    } catch (e) { result = { error: e.message }; }
    document.removeEventListener(BRIDGE_EVENT + ':done', done);
    return result;
  }

  // Refresh what's on screen without reloading, after a crystal changes
  // Portal data behind its back (a note, a nickname, a new WO).
  let refreshing = null;
  function refreshView(tags) {
    if (refreshing) return refreshing; // several changes in a row → one refresh
    refreshing = new Promise((resolve) => {
      setTimeout(() => {
        refreshing = null;
        const result = portal('refresh', { tags: tags || null });
        if (!result.stores || result.error) console.warn('[' + AE_NAME + '] in-place refresh found nothing to refresh', result);
        resolve(result);
      }, 250);
    });
    return refreshing;
  }

  // ------------------------------------------------------------ profile
  let profilePromise = null;
  function profile() {
    if (!AE_ON_PORTAL) return Promise.resolve(null);
    if (!profilePromise) {
      profilePromise = api('GET', '/api/auth/user').then((a) => {
        // {isAuthenticated, user: {givenName, familyName, email, …}, currentStore: {storeId, storeName, email, …}}
        const u = (a && a.user) || {}, s = (a && a.currentStore) || {};
        return {
          userId: u.userId,
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
  /* FFXIV-style spell icon: action icon + cooldown sweep (grey clears clockwise) + "ready" glint */
  .sg-spell { position:relative; flex:none; display:inline-block; border-radius:22%; overflow:hidden; line-height:0;
    box-shadow:0 0 0 1px #2b2a2f, 0 0 0 2px #c9a75a55; --a:0deg; }
  .sg-spell .img, .sg-spell .img > * { display:block; width:100%; height:100%; }
  .sg-spell .img > svg { width:60%; height:60%; margin:20%; color:var(--aui-primary, #8223d2); }
  .sg-spell .cd { position:absolute; inset:0; background:conic-gradient(transparent 0 var(--a), rgba(10,10,16,.66) var(--a) 360deg); pointer-events:none; }
  .sg-spell .glint { position:absolute; inset:-40%; pointer-events:none; opacity:0;
    background:linear-gradient(115deg, transparent 38%, rgba(255,255,255,.95) 50%, transparent 62%); }
  .sg-spell.ready { animation:sg-ready 1.1s ease-out 2; }
  .sg-spell.ready .glint { animation:sg-glint 1.1s ease-out 2; }
  .sg-orb .sg-spell .mark { min-width:20px; height:20px; font-size:12px; line-height:20px; right:3px; bottom:3px; }
  .sg-spell .mark { position:absolute; right:1px; bottom:1px; min-width:14px; height:14px; border-radius:50%; font:800 9px/14px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif;
    text-align:center; color:#fff; background:var(--aui-status-success, #136d31); box-shadow:0 0 0 1px #fff; }
  .sg-spell.err .mark, .sg-spell.stop .mark { background:var(--aui-status-error, #b91a24); }
  /* Finished OK: XIV's "marching ants", an orange dashed border crawling around the icon */
  .sg-spell .ants { position:absolute; inset:0; pointer-events:none; overflow:visible; }
  .sg-spell .ants rect { fill:none; }
  .sg-spell .ants .under { stroke:rgba(40,16,0,.75); }
  .sg-spell .ants .run { stroke:#ffa31a; stroke-dasharray:.55 .45; animation:sg-ants .6s linear infinite; filter:drop-shadow(0 0 2px rgba(255,170,40,.9)); }
  @keyframes sg-ants { to { stroke-dashoffset:-1; } }
  @keyframes sg-ready { 0% { filter:brightness(1); box-shadow:0 0 0 1px #2b2a2f, 0 0 0 2px #c9a75a55; }
    25% { filter:brightness(1.9); box-shadow:0 0 0 2px #fff, 0 0 18px 4px rgba(255,226,140,.95); }
    100% { filter:brightness(1); box-shadow:0 0 0 1px #2b2a2f, 0 0 0 2px #c9a75a55; } }
  @keyframes sg-glint { 0% { opacity:0; transform:translateX(-60%); } 15% { opacity:1; } 70% { opacity:1; transform:translateX(60%); } 100% { opacity:0; transform:translateX(60%); } }
  .sg-min { font-size:20px; font-weight:700; }
  .sg-orb { position:fixed; bottom:20px; z-index:2147483646; width:56px; height:56px; cursor:pointer; border-radius:14px;
    box-shadow:0 6px 20px rgba(12,14,17,.35); animation:sg-in .2s ease-out; }
  .sg-orb .sg-spell { box-shadow:0 0 0 2px #1a1a1f, 0 0 0 3.5px #c9a75a; }
  .sg-orb .dismiss { display:none; position:absolute; top:-8px; right:-8px; width:20px; height:20px; padding:0; border-radius:50%; border:0; cursor:pointer;
    background:#1a1c1e; color:#fff; font-size:11px; line-height:20px; box-shadow:0 0 0 2px #fff; }
  .sg-orb.done:hover .dismiss { display:block; }
  @media (prefers-reduced-motion: reduce) { .sg-spell.ready, .sg-spell.ready .glint, .sg-spell .ants .run { animation:none; } }
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
  .sg-aicon { display:inline-block; flex:none; border-radius:22%; vertical-align:middle; box-shadow:0 0 0 1px rgba(0,0,0,.35), 0 1px 3px rgba(0,0,0,.25); }
  @keyframes sg-spin { to { transform: rotate(360deg); } }
  @keyframes sg-in { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }
  .sg-hold { display:flex; gap:6px; align-items:flex-start; margin:0 0 10px; padding:6px 9px; border-radius:8px; font-size:12px;
    background:var(--aui-status-warning-soft, #fff4cc); color:var(--aui-status-on-warning-soft, #3d2e00); }
  .sg-hold.nudge { animation:sg-nudge .45s ease-in-out 2; }
  @keyframes sg-nudge { 0%,100% { transform:none; } 25% { transform:translateX(-4px); } 75% { transform:translateX(4px); } }
  .sg-min-wrap { position:relative; display:inline-flex; }
  .sg-collapse-tip { position:absolute; right:-12px; bottom:calc(100% + 12px); z-index:1; white-space:nowrap; padding:8px 12px; font-size:13px; font-weight:700;
    cursor:pointer; animation:sg-in .25s ease-out; }
  .sg-collapse-tip::after { content:''; position:absolute; bottom:-8px; right:20px; width:16px; height:16px; transform:rotate(45deg);
    background:var(--aui-surface, #fff); box-shadow:2px 2px 3px rgba(12,14,17,.08); }
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
  // Each crystal's FFXIV action icon, plus a few FFXIV UI pieces under "ui/<name>"
  // (embedded by build.py from assets/icons/ and assets/ui/).
  const ACTION_ICONS = {"autoClose": "data:image/jpeg;base64,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", "buybacks": "data:image/jpeg;base64,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", "cleaningRate": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAMKADAAQAAAABAAAAMAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAMAAwAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwQDAwMEBQQEBAQFBwUFBQUFBwgHBwcHBwcICAgICAgICAoKCgoKCgsLCwsLDQ0NDQ0NDQ0NDf/bAEMBAgICAwMDBgMDBg0JBwkNDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDf/dAAQAA//aAAwDAQACEQMRAD8A/H74xfGLx98d/Ht78RviLf8A2/WL4KmUXZFBCpJSGFMnZEm47VycZrf+DPgvT9YuL7xX4jgluNI0YIWt4v8AWXVxKdsUCnBxuP3j/CoJ7VznhzwZPqmoQwCPO/A6V+i3wI+HfiO5/Z/1VPAf2eLXo9YdrlnCC48n7NII/IaT5Ffdu54bH3Tmvm+IeIaWHw/s6crNtK97WT316drn0+W4BzqqUlpqebfFm9+Nl/8AETUfCOo+Hrq58CrHaR2ul6fB9mjtrZ4I2SW3dArPKAckyl95yDjgjyy5+HXxy+EniOwa1sb7WfC988dzBFdI9xY3Vu5z80bZMb44JUq6sD6V9a/FD4KfEXx3a6N4s1S31g6hZWltpmqpN55LbU/cT8nBB5jYjuF9aT4Y/Bz4j6r4XvfC9hHrMF1p8MWr6TNCZ4ysm79/AGGBhxhwD0Kt618vh80p0cHFx5LWSlG2j6c2+/W9tU79j2KuDcq7k297p3+dvQ/Ov4teELHTl03xfoFvLbaXraSN9mm/1lpcxuVlgY8Z2N0P8SkHvisf4O/GLx78CPHlj8Rvhxf/AGDV7EFMsu+GeFyC8MyZG+J9o3LkZxX3/wDGr4f+JbX9nuwi8e+RNrra67WxTY1wIPKXzBO0XyM+7b3LY+8c1+eer+D7iyCsUIyiN/30K+q4e4gpYjD8k3rFtb3ultr19TxMywLjUvFbpM//0Pnj4Q/CcS6nHeXEax20ADTTSkRwxg93diFXPbJGa+n/AINa/wDCrwtZ+IPCt/qrX0ep2vlv9giJWKUH5HSSTYGYE8bVII4zzXx9qN98UfiBolz440bS7mXwnoN2sFxBp0bGCzDYYnZnJYoCTI5LHHLdMb/jr4mfA3wj4p0TV/gTZasupWttHJf2+tojWi3SYdJEjLyF2DffR2KH+XxHDXAFTNKrnj5uTdtFolbX1/L0Pv3j6OHiuZaK/wCJ+iWkeP8AxR8N/FVpoFt4e1fVrO5gW1lENy0yOHGFDRJDvikIIIDYIPr1rv8Aw9qWtwa8t1qlrqOnaTbwRC5l1S98me2JDeZE9vJEryyYOB5W7dkfdr46+Dfi747fHP4veHfH13dta3K3Wnx391ZW6WqGHzdpOwABgdhUsST79q4v4+fFf4z/AA7+Nur69c39xqraTqs8VhLqVuJbfZDKWSPaVHygAYwQcDg1+hy8I8uqJ0VCPP11lf1/p/I8JcYU3V5eTR6f1+PQ9F+Muo/C7xRYaN4X0jUn02LT45PLi1aIwtLLI5LO8g3KjMf7+wAYGa+XfiL8I2tNOjnEQZGtYGSRMOkgwRlHUlWHuCRU+n/FX4dfHH4rRa9+0Ff3ehx3Vt5l3J4ftCzXF0BjPkqGKDAAJGSeprmdM+IGr+C768sYYrzVfBdxdGO3GoQPbJPDlvLcBt3kTlR1U54+YMvB/N+JOAa+V1FLATaa15Xqnr0e570cdQr3a6pH/9HhPgZ8O/2oo/gVf+Ivhx4t0zQtEke4uVhnSGOeaIJiQrclCy8HaEd1yRxwM18TWXiP4k+EdbufEmlas4Esn768sNrxCVs5R32ld/HIya9L+Jnww+K3wq8X/wDCpvH2pX+n6bbzoz2i3UrWLxyEqsyLkKyNg4OMGvrH4tfDn9mD4TfB618SeEtfg1fxg1nDNZ2DXBudPkvJUIkZrFSVLRt9zfhAQOGAIr0+F80+rVPcfvP5fie/j6HtKVuhZ/Z2/be+Is3ibwv4G8T6rHHYzahaW012YYhK0TyBSHbYc5z2wfTFJ+1L+174i1bxXr2g+A/EN/BFZX81rEESNUIhkZGK/KSRxgZGa+e/2Yfhff8Axp8X6VJZaPZ28egX0OoareTzSwC4X7Qg2Ky5SMqcKvABZup6V598cNG1r4VfEbUvD2q6XbW2s2eoS3bXCubiK6inIJYEna8e4nsMgnNfcwxVH23PFWq/L89z5h4C3vN6GFt+KfirXdO8T+KL2d7beZI5r2NMyCLBYRKyqHIzyFJKg5IxX038eNc/aes/gvY+H/H+gaK3hdLm3Md5bxrNf2uQxgZymxYVdeBJ5Sbs7STzXqfjD9nTwT40/Zj0/wAVaH4whsJ7WyGqWNnLcoNOju/me4tEQsZ45SFLRkcEnHbn5r+FUv7TPx9TT/gjpviDVNX0poVVbG4l/wBHitY9ozM+3PlR8YLZ29q/PuJc0+tVHUm05LS3XfT5n1eBoKnS5Vtvc//Z", "countCheck": "data:image/jpeg;base64,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", "dualcast": "data:image/jpeg;base64,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", "fixes": "data:image/jpeg;base64,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", "galaxy": "data:image/jpeg;base64,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", "glamour": "data:image/jpeg;base64,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", "printLabels": "data:image/jpeg;base64,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", "rowColors": "data:image/jpeg;base64,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", "textNotes": "data:image/jpeg;base64,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", "triplecast": "data:image/jpeg;base64,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", "waymark": "data:image/jpeg;base64,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", "woCleanings": "data:image/jpeg;base64,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", "ui/macro-gear": "data:image/png;base64,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"};
  const actionIcon = (id, size = 24, extra = '') => ACTION_ICONS[id]
    ? '<img class="sg-aicon" src="' + ACTION_ICONS[id] + '" width="' + size + '" height="' + size + '" alt="" draggable="false"' + (extra ? ' ' + extra : '') + '>'
    : '';

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
  /*
    The "Aethernet" wordmark, drawn in Runic MT Std Condensed. Stored as
    vector outlines of just this one word (a logo), so it renders the same
    everywhere without installing or shipping the font. Regenerate with
    fontTools from the .otf if the name ever changes.
  */
  const WORDMARK = { viewBox: '10 -807 1968 817', d: 'M157 -803H91L29 -15C20 -9 17 -9 14 -9V0H98V-9C90 -11 85 -14 82 -19L89 -178H142L148 -15C144 -13 137 -9 132 -9V0H235V-9C228 -9 223 -11 217 -15ZM139 -230H91L114 -750L116 -749ZM455 -176 378 -243 374 -238C392 -206 392 -197 392 -109C392 -58 388 -34 363 -34C339 -34 336 -66 336 -81V-309H455V-488C455 -553 431 -611 364 -611C288 -611 273 -542 273 -496V-95C273 -43 298 6 362 6C431 6 455 -53 455 -99ZM336 -350V-509C336 -539 338 -569 364 -569C389 -569 394 -546 394 -514V-350ZM510 -560V-45C510 -16 536 6 562 6C573 6 602 -2 619 -16L610 -61C604 -57 597 -51 587 -51C579 -51 573 -57 573 -67V-560H619V-605H573V-710L510 -668V-605H487V-560ZM842 -519C842 -544 838 -613 790 -613C754 -613 738 -573 726 -534H724V-798H637V-790C640 -789 652 -785 661 -779V-20C653 -14 645 -11 637 -9V0H748V-9C733 -13 728 -17 724 -20V-439C724 -500 738 -557 765 -557C778 -557 780 -546 780 -534V-20C775 -16 769 -13 756 -9V0H867V-9C852 -13 847 -16 842 -20ZM1091 -176 1014 -243 1010 -238C1028 -206 1028 -197 1028 -109C1028 -58 1024 -34 999 -34C975 -34 972 -66 972 -81V-309H1091V-488C1091 -553 1067 -611 1000 -611C924 -611 909 -542 909 -496V-95C909 -43 934 6 998 6C1067 6 1091 -53 1091 -99ZM972 -350V-509C972 -539 974 -569 1000 -569C1025 -569 1030 -546 1030 -514V-350ZM1151 -21C1143 -15 1134 -11 1126 -9V0H1237V-9C1223 -13 1216 -18 1213 -21V-433C1213 -487 1230 -561 1253 -561C1265 -561 1271 -561 1271 -473C1271 -446 1271 -400 1260 -378L1263 -371L1333 -436V-509C1333 -542 1324 -610 1278 -611C1246 -610 1233 -575 1215 -515H1213V-605H1126V-597C1141 -593 1147 -589 1151 -586ZM1561 -530C1561 -578 1541 -613 1509 -613C1470 -613 1453 -564 1442 -526H1440V-605H1354V-597C1357 -596 1369 -593 1378 -586V-20C1369 -13 1358 -10 1354 -9V0H1465V-9C1455 -12 1449 -14 1440 -20V-418C1440 -471 1453 -557 1483 -557C1495 -557 1498 -547 1498 -526V-20C1489 -13 1478 -10 1474 -9V0H1585V-9C1572 -13 1566 -16 1561 -20ZM1810 -176 1733 -243 1729 -238C1747 -206 1747 -197 1747 -109C1747 -58 1743 -34 1718 -34C1694 -34 1691 -66 1691 -81V-309H1810V-488C1810 -553 1786 -611 1719 -611C1643 -611 1628 -542 1628 -496V-95C1628 -43 1653 6 1717 6C1786 6 1810 -53 1810 -99ZM1691 -350V-509C1691 -539 1693 -569 1719 -569C1744 -569 1749 -546 1749 -514V-350ZM1865 -560V-45C1865 -16 1891 6 1917 6C1928 6 1957 -2 1974 -16L1965 -61C1959 -57 1952 -51 1942 -51C1934 -51 1928 -57 1928 -67V-560H1974V-605H1928V-710L1865 -668V-605H1842V-560Z' };
  const wordmark = (height = 28) => {
    const [, , w, h2] = WORDMARK.viewBox.split(' ').map(Number);
    return '<svg role="img" aria-label="' + AE_NAME + '" viewBox="' + WORDMARK.viewBox + '" height="' + height + '" width="' +
      Math.round(height * w / h2) + '" style="display:block;overflow:visible"><title>' + AE_NAME + '</title><path fill="currentColor" d="' + WORDMARK.d + '"/></svg>';
  };

  const icon = (name, size = 16) =>
    '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" aria-hidden="true" style="flex:none;display:block">' + ICONS[name] + '</svg>';

  /*
    A progress panel (bottom-right card): spinner → ✓/✕/■, running clock,
    ticked step list, a result message, and whatever action buttons the crystal
    sets. Used by auto-close and print-all-labels.
  */
  /*
    Progress box for a crystal's run (Swiftcast, Dualcast, Quick Synthesis…),
    styled after FFXIV casting:
      - the crystal's action icon in the header, with a cooldown sweep: a grey
        infill that clears clockwise as each step completes (total known up
        front: opts.total, panel.plan(n), or panel.progress(done, total));
      - "–" collapses it into a floating spell icon with the same sweep; when the
        run ends the icon flashes like a skill coming off cooldown, then shows marching ants (OK) or ✕/■.
        Click the icon to expand the box; once finished, hover shows a ✕ to
        dismiss. The box and icon live on <body>, outside Portal's own page, so
        they stay put as Portal changes pages.
  */
  function spellIcon(iconId, size) {
    const el = h('span', { class: 'sg-spell', style: 'width:' + size + 'px;height:' + size + 'px' },
      h('span', { html: actionIcon(iconId, size) || icon('bolt', Math.round(size * 0.6)), class: 'img' }), h('span', { class: 'cd' }), h('span', { class: 'glint' }));
    return el;
  }
  // A finished spell icon: flash like a skill coming off cooldown, then marching
  // ants (OK) or a ✕/■ badge (failed/stopped).
  function spellDone(sp, kind) {
    sp.querySelector('.mark, .ants')?.remove();
    sp.classList.remove('ready', 'ok', 'err', 'stop'); void sp.offsetWidth; sp.classList.add('ready', kind);
    if (kind !== 'ok') return sp.append(h('span', { class: 'mark' }, kind === 'stop' ? '■' : '✕'));
    const z = parseFloat(sp.style.width) || sp.offsetWidth || 56, w = Math.max(1.5, z / 22), i = w / 2 + 0.5, side = z - 2 * i;
    const r = Math.max(0, z * 0.22 - i), per = 4 * (side - 2 * r) + 2 * Math.PI * r;
    const n = Math.max(8, Math.round(per / Math.max(5, z / 8))); // whole dashes, so the loop has no seam
    const rect = (cls) => '<rect class="' + cls + '" x="' + i + '" y="' + i + '" width="' + side + '" height="' + side + '" rx="' + r + '" pathLength="' + n + '" stroke-width="' + w + '"/>';
    sp.append(h('span', { class: 'ants', html: '<svg width="' + z + '" height="' + z + '" viewBox="0 0 ' + z + ' ' + z + '">' + rect('under') + rect('run') + '</svg>' }));
  }
  /*
    Holding the page while a run must not be cut off (Swiftcast & co.): F5 /
    Ctrl+R / Cmd+R (with or without Shift) are swallowed and onBlocked() is
    called; anything else that would unload the page (the browser's reload
    button, closing the tab, a full navigation) gets the browser's own
    "Leave site?" prompt. Browsers don't let a page refuse that outright, so
    the run's box also says not to reload. Returns release().
  */
  const holds = new Set();
  function onUnload(e) { if (!holds.size) return; e.preventDefault(); e.returnValue = ''; return ''; }
  function onKey(e) {
    if (!holds.size) return;
    const k = (e.key || '').toLowerCase();
    if (k === 'f5' || ((e.ctrlKey || e.metaKey) && k === 'r')) { e.preventDefault(); e.stopImmediatePropagation(); [...holds].forEach((x) => x.onBlocked && x.onBlocked()); }
  }
  function holdPage(onBlocked) {
    const x = { onBlocked };
    if (!holds.size) { window.addEventListener('beforeunload', onUnload, true); window.addEventListener('keydown', onKey, true); }
    holds.add(x);
    return () => {
      if (!holds.delete(x) || holds.size) return;
      window.removeEventListener('beforeunload', onUnload, true); window.removeEventListener('keydown', onKey, true);
    };
  }
  const COLLAPSE_TIP_KEY = 'ae_collapse_tip_seen';

  // hold: keep the page from being reloaded until finish() (see holdPage).
  function progressPanel(title, { clock = true, icon: iconId = null, total = 0, hold = false } = {}) {
    ensureCss();
    document.querySelectorAll('.sg-panel[data-sg-title="' + title + '"]').forEach((p) => { p._orb?.remove(); p.remove(); });
    const head = iconId ? spellIcon(iconId, 30) : h('span', { class: 'sg-spin' });
    const titleEl = h('span', { class: 'sg-panel-title' }, title);
    const clk = clock ? h('span', { class: 'sg-clock' }, '0.0s') : null;
    const shrink = iconId ? h('button', { class: 'sg-x sg-min', title: 'Collapse to the spell icon', onclick: () => { tipSeen(); api.collapse(); } }, '–') : null;
    // First collapsible box this user sees: a speech bubble over the – button.
    let tip = null;
    const tipSeen = () => { if (tip) { tip.remove(); tip = null; GM_setValue(COLLAPSE_TIP_KEY, true); } };
    if (shrink && !GM_getValue(COLLAPSE_TIP_KEY, false) && !document.querySelector('.sg-collapse-tip')) {
      tip = h('div', { class: 'sg-card sg-collapse-tip', role: 'note', title: 'Click to dismiss', onclick: tipSeen }, 'This is now collapsible!');
    }
    const holdNote = hold ? h('div', { class: 'sg-hold' }, h('span', null, '🔒'),
      h('span', null, h('b', null, 'Don\'t reload or close this tab'), ' until this finishes, or work orders can be left half-done. Reloading is blocked here; your browser will ask before leaving.')) : null;
    const close = h('button', { class: 'sg-x', title: 'Close', style: 'display:none', onclick: () => { orb?.remove(); panel.remove(); } }, '✕');
    const steps = h('ul', { class: 'sg-steps' });
    const body = h('div');
    const msg = h('div', { class: 'sg-msg', style: 'display:none' });
    const actions = h('div', { class: 'sg-actions' });
    const panel = h('div', { class: 'sg sg-card sg-panel' + (iconId ? ' sg-spellbox' : ''), 'data-sg-title': title },
      h('div', { class: 'sg-panel-head' }, head, titleEl, clk, shrink && (tip ? h('span', { class: 'sg-min-wrap' }, shrink, tip) : shrink), close),
      holdNote, body, steps, msg, actions);
    document.body.appendChild(panel);
    const release = hold ? holdPage(() => {
      api.flash();
      holdNote.classList.remove('nudge'); void holdNote.offsetWidth; holdNote.classList.add('nudge');
    }) : () => {};

    let done = 0, planned = total, shown = 0, target = 0, anim = null, finished = null, orb = null;
    const icons = () => [head, orb && orb.querySelector('.sg-spell')].filter((x) => x && x.classList && x.classList.contains('sg-spell'));
    const paintSweep = () => icons().forEach((el) => el.style.setProperty('--a', Math.round(shown * 360) + 'deg'));
    function setTarget(p) {
      target = Math.max(0, Math.min(1, p));
      if (anim) return;
      const tick = () => { shown += (target - shown) * 0.18; if (Math.abs(target - shown) < 0.002) shown = target; paintSweep(); anim = shown === target ? null : requestAnimationFrame(tick); };
      anim = requestAnimationFrame(tick);
    }
    // Steps beyond the plan (rare extras) never complete the circle early; finishing does.
    const fromSteps = () => (planned ? Math.min(done / planned, 0.97) : 0);
    const ready = spellDone;
    paintSweep();

    const t0 = performance.now();
    const fmt = (ms) => { const s = ms / 1000; return s < 60 ? s.toFixed(1) + 's' : Math.floor(s / 60) + 'm ' + String(Math.floor(s % 60)).padStart(2, '0') + 's'; };
    const timer = clk ? setInterval(() => { clk.textContent = fmt(performance.now() - t0); }, 100) : null;

    function makeOrb() {
      const others = document.querySelectorAll('.sg-orb').length;
      const o = h('div', { class: 'sg sg-orb', role: 'button', tabindex: '0', title: titleEl.textContent + ' — click to expand', style: 'right:' + (20 + others * 72) + 'px' },
        spellIcon(iconId, 56), h('span', { class: 'badge' }),
        h('button', { type: 'button', class: 'dismiss', title: 'Dismiss', onclick: (e) => { e.stopPropagation(); o.remove(); panel.remove(); } }, '✕'));
      o.addEventListener('click', () => api.expand());
      o.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); api.expand(); } });
      return o;
    }
    const api = {
      el: panel,
      body,
      title(t) { titleEl.textContent = t; if (orb) orb.title = t + ' — click to expand'; },
      plan(n) { planned = n; setTarget(fromSteps()); },
      progress(n, of) { if (of) planned = of; done = n; setTarget(fromSteps()); },
      step(text) { steps.append(h('li', null, text)); steps.scrollTop = steps.scrollHeight; done++; setTarget(fromSteps()); },
      actions(...btns) { actions.replaceChildren(...btns); },
      collapse() {
        if (!iconId) return;
        if (!orb) { orb = makeOrb(); panel._orb = orb; }
        if (finished) { orb.classList.add('done', finished); const sp = orb.querySelector('.sg-spell'); if (!sp.querySelector('.mark, .ants')) spellDone(sp, finished); }
        document.body.appendChild(orb);
        panel.style.display = 'none';
        paintSweep();
      },
      expand() { if (orb) orb.remove(); panel.style.display = ''; },
      finish(kind, html) { // kind: 'ok' | 'err' | 'stop'
        finished = kind;
        release(); holdNote?.remove(); tipSeen();
        if (timer) { clearInterval(timer); clk.textContent = fmt(performance.now() - t0); }
        if (iconId) {
          if (kind === 'ok') setTarget(1);
          ready(head, kind);
          if (orb) { orb.classList.add('done', kind); ready(orb.querySelector('.sg-spell'), kind); }
        } else {
          const st = h('span', { class: 'sg-icon-state' }, kind === 'ok' ? '✓' : kind === 'stop' ? '■' : '✕');
          st.style.color = kind === 'ok' ? 'var(--aui-status-success, #136d31)' : 'var(--aui-status-error, #b91a24)';
          head.replaceWith(st);
        }
        if (html) { msg.className = 'sg-msg ' + (kind === 'ok' ? 'ok' : 'err'); msg.innerHTML = html; msg.style.display = 'block'; }
        close.style.display = '';
      },
      flash() { if (orb && orb.isConnected) { api.expand(); } panel.style.animation = 'sg-flash .8s'; setTimeout(() => { panel.style.animation = ''; }, 800); },
    };
    return api;
  }

  /*
    Confirmation dialog in Portal's style (never window.confirm — native
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

  // Crystals tell each other when a cleaning changes (e.g. auto-close finished)
  // so the badge and WO pill refresh without waiting for their timers.
  const emit = (name, detail) => document.dispatchEvent(new CustomEvent('aethernet:' + name, { detail }));
  const on = (name, fn) => document.addEventListener('aethernet:' + name, (e) => fn(e.detail));

  /*
    Shared cleaning data. Everything is read-only and scoped by Portal to
    the logged-in user's current store.
  */
  const data = (() => {
    const OPEN_STATUS_IDS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 17, 24, 26, 27]; // Portal's own "Active" set
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

  // --------------------------------------------------- dev hooks + clock
  // Modules register things the dev tools (src/dev/, dev builds only) can
  // trigger on demand: popups, notices, dry runs. Harmless in public builds.
  const hooks = {};
  // "Now", which the dev tools can shift to test time-based rules (Waymark's
  // 7 PM and morning rules). Always the real time in public builds.
  const now = () => Date.now() + (AE_DEV ? Number(GM_getValue('ae_dev_clock_offset', 0)) || 0 : 0);
  const nowDate = () => new Date(now());

  // --------------------------------------------------- errors + usage
  // The last few Aethernet errors, attached to bug reports ("Send feedback").
  const recentErrors = [];
  function noteError(where, e) {
    recentErrors.push({ at: new Date().toISOString(), where, message: String((e && e.message) || e).slice(0, 300) });
    if (recentErrors.length > 10) recentErrors.shift();
  }
  // Portal's own script errors (not Aethernet's), for bug reports: e.g. a page that
  // never finishes loading usually threw one of these.
  const pageErrors = [];
  const notePageError = (message, where) => {
    pageErrors.push({ at: new Date().toISOString(), where: String(where || '').slice(0, 160), message: String(message || '').slice(0, 300) });
    if (pageErrors.length > 10) pageErrors.shift();
  };
  addEventListener('error', (e) => notePageError(e.message || (e.error && e.error.message), (e.filename || '').replace(/^https?:\/\/[^/]+/, '') + ':' + (e.lineno || '')));
  addEventListener('unhandledrejection', (e) => notePageError('Unhandled: ' + ((e.reason && (e.reason.message || e.reason.status)) || e.reason), ''));

  /*
    Usage counts ("who uses what"): AE.track('autoClose:run') adds 1 to today's
    count for this person. Counts are batched in Tampermonkey storage and sent
    by the feedback module (06-feedback.js) every few minutes. Only feature
    names and counts — never page contents or customer details.
  */
  const USAGE_KEY = false ? '' : 'ae_usage_pending';
  const localDay = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  function track(feature) {
    if (false) return; // the demo build sends nothing anywhere
    try {
      const pend = GM_getValue(USAGE_KEY, {});
      const day = (pend[localDay()] = pend[localDay()] || {});
      day[feature] = (day[feature] || 0) + 1;
      GM_setValue(USAGE_KEY, pend);
    } catch (_) { /* never let tracking break a crystal */ }
  }
  // Once a day per person (e.g. "used Aethernet today", "has a Glamour theme on").
  function trackDaily(feature) {
    if (false) return;
    const k = 'ae_usage_daily', seen = GM_getValue(k, {});
    if (seen[feature] === localDay()) return;
    seen[feature] = localDay(); GM_setValue(k, seen);
    track(feature);
  }

  // --------------------------------------------------- crystal registry
  const crystals = [];
  function crystal(def) { crystals.push(def); }
  /*
    "A text went to a customer from this WO": event text-sent { woId } for
    any crystal (Recitation logs it, Auto-Waymark follows up), so each works
    with the other switched off. Portal keeps its own fetch, so the send is
    seen in the browser's network log (POST …/messages/v1/send), not by
    wrapping fetch. Sends that failed (status 4xx/5xx, where the browser
    reports it) are skipped; texts sent outside a WO page carry woId null.
  */
  const TEXT_SEND_RE = /\/messages\/v1\/send(?:[?#]|$)/;
  function watchTexts() {
    if (typeof PerformanceObserver === 'undefined') return;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!TEXT_SEND_RE.test(e.name) || (e.responseStatus && e.responseStatus >= 400)) continue;
        const m = location.pathname.match(/^\/repair\/workorder\/(\d+)/);
        emit('text-sent', { woId: m ? m[1] : null });
        break;
      }
    }).observe({ type: 'resource', buffered: false });
  }

  function start() {
    ensureCss();
    if (AE_ON_PORTAL) watchTexts();
    // Which Aethernet builds are running on this page (the dev build warns if both are).
    const root = document.documentElement;
    root.dataset.aethernet = ((root.dataset.aethernet || '') + ' ' + (AE_DEV ? 'dev' : 'public')).trim();
    for (const t of crystals) {
      if (!settings.crystals[t.id]) continue;
      if (t.sites && !t.sites.includes(AE_SANDBOX ? 'portal.ubreakifix.net' : location.hostname)) continue;
      // Paused remotely by an Aethernet notice (status.json); last-known copy.
      if (AE.status && AE.status.paused(t.id)) { console.info('[' + AE_NAME + '] ' + t.name + ' is paused by an Aethernet notice'); continue; }
      try { t.run(); } catch (e) { noteError(t.name + ' start', e); console.error('[' + AE_NAME + '] ' + t.name + ' failed to start', e); }
    }
  }

  // Poll a route/DOM check — Portal is a single-page app, so pages
  // change without a load and Portal re-renders often.
  function every(ms, fn) {
    // Promise.resolve so async callbacks' rejections are caught too.
    const safe = () => Promise.resolve().then(fn).catch((e) => { noteError('timer', e); console.error('[' + AE_NAME + ']', e); });
    setInterval(safe, ms);
    safe();
  }

  return {
    settings, saveSettings, DEFAULTS, merge, crystals, crystal, start, every,
    api, unwrap, Stopped, portal, refreshView, profile, spellIcon, spellDone, holdPage, sleep, esc, h, icon, actionIcon, asset: (name) => ACTION_ICONS[name] || '', wordmark, ensureCss, progressPanel,
    hooks, now, nowDate,
    confirm: confirmDialog, toast, emit, on, data, track, trackDaily, noteError, recentErrors, pageErrors, USAGE_KEY, localDay,
    PARENT_PROGRAM_ID, CLEANING_PROGRAMS,
    autoClose: null, // set by the auto-close crystal when it's enabled
  };
})();

// ===== 01-access.js =====
/*
  Store access. Aethernet only runs for stores on the list kept in the admin
  panel (Stores tab). build.py puts every module after this one inside
  AE.boot(); AE.gate() calls it once the signed-in store is allowed.

  - Asks the Aethernet API (GET /v1/<store>/access, which also records the
    store as "seen", so it shows up in the admin panel's Waiting list).
  - The answer is remembered per store, so a store that has access keeps
    working if the API can't be reached; a store never verified waits.
  - Not allowed: one notice, and nothing else loads (no crystals, Settings,
    notices, feedback or Waymark). The Worker also refuses its services to
    stores without access.
  - The Sprinklr form (Macrocosmos' second half) isn't a Portal page; it
    only acts on a handoff made from Portal, so it isn't gated here.
*/
AE.gate = (() => {
  const API = 'https://aethernet-waymark.ubifaethernet.workers.dev';
  const KEY = 'ae_QFa2DKDy0DrlBd_A3bfZL3BtgM51idh6';
  const CACHE_KEY = 'ae_access';
  const PREVIEW_KEY = 'ae_dev_preview_locked'; // dev tools: load as a store without access
  let booted = false;

  function boot() {
    if (booted) return;
    booted = true;
    try { AE.boot(); } catch (e) { console.error('[' + AE_NAME + '] failed to start', e); }
  }

  async function check(p) {
    const q = '?name=' + encodeURIComponent(p.storeName || '') + '&user=' + encodeURIComponent(p.name || '');
    const res = await fetch(API + '/v1/' + p.storeId + '/access' + q, { headers: { 'x-aethernet-key': KEY }, credentials: 'omit', cache: 'no-store' });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status);
    return !!j.allowed;
  }

  // The one thing a store without access sees (dismissable for this tab).
  function notice(p, kind, opts = {}) {
    const id = 'sg-access-notice', dismissKey = 'ae_access_dismissed_' + p.storeId + '_' + kind;
    document.getElementById(id)?.remove();
    try { if (!opts.force && sessionStorage.getItem(dismissKey)) return; } catch (_) {}
    AE.ensureCss();
    const { h, icon } = AE;
    const store = (p.storeName || 'This store') + (p.storeId ? ' (#' + p.storeId + ')' : '');
    const card = h('div', { id, class: 'sg sg-card', role: 'status', style:
      'position:fixed;z-index:2147483645;left:16px;bottom:16px;max-width:420px;padding:12px 14px;display:flex;gap:10px;align-items:flex-start;font-size:14px;line-height:1.45;animation:sg-in .2s ease-out' },
      h('span', { style: 'color:var(--aui-primary,#8223d2);line-height:0;flex:none', html: icon('aetheryte', 26) }),
      h('div', { style: 'flex:1' },
        h('b', { style: 'display:block;margin-bottom:2px' }, kind === 'denied' ? AE_NAME + " isn't available for " + store + ' yet' : AE_NAME + " couldn't check this store's access"),
        h('span', { class: 'sg-soft', style: 'font-size:13px' }, kind === 'denied'
          ? AE_NAME + ' access is enabled on a store-by-store basis. Reach out to your manager or higher up and ask them to inquire.'
          : AE_NAME + " will continue checking. If this is a backend issue - we're on it.")),
      h('button', { type: 'button', class: 'sg-x', title: 'Dismiss', onclick: () => { try { if (!opts.force) sessionStorage.setItem(dismissKey, '1'); } catch (_) {} card.remove(); } }, '✕'));
    if (opts.preview) { // dev: the way back out of a locked-out preview
      card.lastChild.before(h('button', { type: 'button', class: 'sg-btn', style: 'flex:none;align-self:center;height:28px;font-size:12px;border-color:#e0761a;color:#e0761a',
        onclick: () => { GM_deleteValue(PREVIEW_KEY); location.reload(); } }, 'End preview'));
    }
    (document.body || document.documentElement).appendChild(card);
  }

  // Dev tools: show a notice on demand, or reload as a store without access.
  AE.hooks.accessNotice = async (kind) => notice(await AE.profile(), kind, { force: true });
  AE.hooks.previewLockedOut = () => { GM_setValue(PREVIEW_KEY, true); location.reload(); };

  return async function gate() {
    if (!AE_ON_PORTAL || AE_SANDBOX) return boot(); // the sandbox has no real store to check (and never calls the Worker)
    let p;
    try { p = await AE.profile(); } catch (_) { p = null; }
    if (!p || !p.storeId) { setTimeout(gate, 30000); return; } // signed out (login page): check again later
    if (AE_DEV && GM_getValue(PREVIEW_KEY, false)) { notice(p, 'denied', { force: true, preview: true }); return; } // dev preview: act locked out
    const cached = GM_getValue(CACHE_KEY, null);
    const known = cached && cached.store === p.storeId ? cached : null;
    if (known && known.allowed) boot(); // fast start; confirmed just below
    try {
      const ok = await check(p);
      GM_setValue(CACHE_KEY, { store: p.storeId, allowed: ok, at: Date.now() });
      if (ok) { document.getElementById('sg-access-notice')?.remove(); boot(); }
      else if (!booted) notice(p, 'denied');
      else console.warn('[' + AE_NAME + '] this store no longer has access; ' + AE_NAME + ' stops on the next page load');
    } catch (e) {
      console.warn('[' + AE_NAME + '] access check failed:', e.message || e);
      if (known && !known.allowed) notice(p, 'denied');
      else if (!known) { notice(p, 'unverified'); setTimeout(gate, 60000); }
    }
  };
})();

// ===== 01b-login.js =====
/*
  Glamour on the login page: your own picture in place of Portal's (the photo
  on the purple panel, or filling the whole panel), and the Aethernet mark in
  the bottom-left corner. Settings: Glamour → Login page
  (settings.glamour.login = { image: data URL or '', fill, mark }).

  Runs before the store check (01-access.js): nobody is signed in on the
  login page, so there's no store to check. It applies only if this browser
  last loaded Portal at a store with access (the cached answer), and only
  while Glamour is on.

  Portal's login page (main-layout app, /login): a left column with the logo
  image and the SSO button, and a right panel (a purple gradient over a
  doodle pattern) holding a headline and a photo. Class names are generated,
  so the panel is found as the element with a gradient background that holds
  an image. React's nodes are hidden, never removed or changed; ours sit
  beside them and go away when the page leaves /login.
*/
AE.loginPage = (() => {
  if (!AE_ON_PORTAL) return null;
  const CSS = `
    .ae-login-hidden { display: none !important; }
    #ae-login-img { object-fit: contain !important; object-position: center bottom; max-width: 100%; } /* any shape shows whole, standing on the bottom like Portal's photo */
    .ae-login-fill { background: var(--ae-login-image) center / cover no-repeat !important; }
    .ae-login-fill > :not(#ae-login-img) { visibility: hidden; }
    #ae-login-mark { position: fixed; left: 16px; bottom: 14px; z-index: 10; display: flex; align-items: center; gap: 6px; color: #8223d2; opacity: .85; }
  `;
  const allowed = () => false || (GM_getValue('ae_access', null) || {}).allowed === true;
  const cfg = () => (AE.settings.crystals.glamour && AE.settings.glamour && AE.settings.glamour.login) || {};

  function findPanel() {
    for (const img of document.querySelectorAll('img')) {
      const p = img.parentElement;
      if (p && p.id !== 'ae-login-img' && /linear-gradient/.test(getComputedStyle(p).backgroundImage)) return { panel: p, photo: img };
    }
    return null;
  }

  let painted = false;
  function clear() {
    if (!painted) return;
    painted = false;
    document.getElementById('ae-login-img')?.remove();
    document.getElementById('ae-login-mark')?.remove();
    document.querySelectorAll('.ae-login-hidden').forEach((e) => e.classList.remove('ae-login-hidden'));
    document.querySelectorAll('.ae-login-fill').forEach((e) => { e.classList.remove('ae-login-fill'); e.style.removeProperty('--ae-login-image'); });
  }

  function paint() {
    if (location.pathname !== '/login' || !allowed()) return clear();
    const c = cfg();
    const found = findPanel();
    if (!found) return;
    if (!document.getElementById('ae-login-css')) document.head.append(AE.h('style', { id: 'ae-login-css' }, CSS));
    painted = true;
    const { panel, photo } = found;

    // The picture
    let mine = document.getElementById('ae-login-img');
    if (!c.image) {
      mine?.remove(); photo.classList.remove('ae-login-hidden');
      panel.classList.remove('ae-login-fill'); panel.style.removeProperty('--ae-login-image');
    } else if (c.fill) {
      mine?.remove(); photo.classList.remove('ae-login-hidden');
      panel.style.setProperty('--ae-login-image', 'url("' + c.image + '")');
      panel.classList.add('ae-login-fill');
    } else {
      panel.classList.remove('ae-login-fill'); panel.style.removeProperty('--ae-login-image');
      if (!mine) {
        mine = AE.h('img', { id: 'ae-login-img', alt: '', class: photo.className, style: photo.getAttribute('style') || '' }); // same size and place as Portal's
        photo.after(mine);
      }
      if (mine.getAttribute('src') !== c.image) mine.src = c.image;
      photo.classList.add('ae-login-hidden');
    }

    // The Aethernet mark, in the bottom-left corner of the page (clear of the sign-in content)
    const mark = document.getElementById('ae-login-mark');
    if (!c.mark) { mark?.remove(); return; }
    if (mark) return;
    document.body.append(AE.h('div', { id: 'ae-login-mark', title: AE_NAME },
      AE.h('span', { style: 'line-height:0', html: AE.icon('aetheryte', 28) }),
      AE.h('span', { style: 'line-height:0', html: AE.wordmark(20) })));
  }

  // Portal is a single-page app: /login comes and goes without a page load.
  let timer = null;
  function watch() {
    if (timer) return;
    timer = setInterval(() => { try { paint(); } catch (e) { console.warn('[' + AE_NAME + '] login page:', e); } }, 500);
    paint();
  }
  watch();
  return { paint, findPanel };
})();

AE.boot = function aethernetBoot() {

// ===== 02-status.js =====
/*
  Status — live word from the Aethernet team, without waiting for a release.

  Reads status.json from the same Gist as the script (plain fetch: the Gist
  sends Access-Control-Allow-Origin: *, so no new Tampermonkey permission):

    {
      "latest":   { "version": "2.11.0", "date": "…" },        // set by build.py --release
      "incident": {                                          // set by build.py --status …
        "id", "severity": "info|warning|error", "title", "message",
        "crystals": ["cleaningRate"],   // which crystals it's about (badges in Settings)
        "pause": ["autoClose"],         // kill switch: these crystals stop acting
        "fixedIn": "2.10.1",            // installs at/after this version stop showing it
        "posted", "updated"
      }
    }

  - Checked on load and every 10 minutes; the last good copy is kept, so a
    GitHub outage never shows anything new (and never an error).
  - Everything in the file is untrusted data: plain text only (no HTML, no
    links), length-capped, crystal ids validated. At worst a bad file shows a
    message or pauses crystals; it can't run anything or turn anything on.
  - `latest` drives the "update available" pill and Check for updates. An
    update is one click: the install link opens Tampermonkey's own Update page.
*/
AE.status = (() => {
  const { h, icon } = AE;
  const STATUS_URL = AE_INSTALL_URL.replace(/[^/]+$/, 'status.json');
  const CACHE_KEY = 'ae_status', DISMISS_KEY = 'ae_status_dismissed', UPDATE_DISMISS_KEY = 'ae_update_dismissed';
  const POLL_MS = 10 * 60 * 1000;
  const SEVERITIES = ['info', 'warning', 'error'];
  const VER_RE = /^\d+(\.\d+){0,3}$/; // dev builds have a 4th part (2.16.0.3)

  const verTuple = (v) => String(v || '0').split('.').map(Number);
  const newer = (a, b) => { const x = verTuple(a), y = verTuple(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
  const text = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const ids = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && /^[A-Za-z]{1,30}$/.test(x)).slice(0, 12) : []);

  function clean(raw) {
    const out = { latest: null, incident: null };
    if (!raw || typeof raw !== 'object') return out;
    const l = raw.latest;
    if (l && VER_RE.test(l.version || '')) out.latest = { version: l.version, date: text(l.date, 40) };
    const i = raw.incident;
    if (i && typeof i === 'object' && text(i.title, 140)) {
      out.incident = {
        id: text(i.id, 80) || text(i.title, 80),
        severity: SEVERITIES.includes(i.severity) ? i.severity : 'warning',
        title: text(i.title, 140),
        message: text(i.message, 700),
        crystals: ids(i.crystals),
        pause: ids(i.pause),
        fixedIn: VER_RE.test(i.fixedIn || '') ? i.fixedIn : null,
        updated: text(i.updated || i.posted, 40),
      };
    }
    return out;
  }

  let state = clean(GM_getValue(CACHE_KEY, null));

  // An incident stops applying to installs at or past its fixedIn version.
  const incident = () => {
    const i = state.incident;
    return i && !(i.fixedIn && !newer(i.fixedIn, AE_VERSION)) ? i : null;
  };
  const paused = (id) => !!incident() && incident().pause.includes(id);
  const crystalName = (id) => (AE.crystals.find((c) => c.id === id) || {}).name || id;

  // For a crystal's action: true (and says why) when it's paused remotely.
  function blocked(id) {
    if (!paused(id)) return false;
    AE.toast(crystalName(id) + ' is paused', incident().title + ' — the Aethernet team has paused it until it\'s fixed.', 'err', 9000);
    return true;
  }

  async function refresh(fresh) {
    // Cache-bust per minute normally, per call when asked (Check for updates).
    const bust = fresh ? Date.now() : Math.floor(Date.now() / 60000);
    const res = await fetch(STATUS_URL + '?t=' + bust, { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const next = clean(await res.json());
    GM_setValue(CACHE_KEY, next);
    state = next;
    render();
    return state;
  }

  // ------------------------------------------------------------ updates
  // GitHub caches the script for 5 minutes, so a brand-new release isn't
  // offered until it's been out for 6 — otherwise Update could fetch the old copy.
  const ROLLOUT_MS = 6 * 60 * 1000;
  const released = () => { const t = Date.parse(state.latest && state.latest.date); return isNaN(t) ? 0 : t; };
  const newerExists = () => !!state.latest && newer(state.latest.version, AE_VERSION);
  const rollingOut = () => newerExists() && Date.now() - released() < ROLLOUT_MS;
  const updateAvailable = () => (newerExists() && !rollingOut() ? state.latest.version : null);

  function startUpdate(version) {
    // Tampermonkey (and Violentmonkey) catch a .user.js link and show their own Update page.
    window.open(AE_INSTALL_URL, '_blank');
    AE.toast('Updating ' + AE_NAME, 'In the tab that just opened, click Update' + (version ? ' (v' + version + ')' : '') + ', then reload Portal.', 'ok', 20000);
  }

  // Settings → Check for updates.
  async function checkNow(opts = {}) {
    const busy = AE.toast('Checking for updates…', '', 'busy');
    try { if (!opts.noFetch) await refresh(true); } catch (e) { // noFetch: dev tools, against simulated data
      busy.remove();
      AE.toast("Couldn't check for updates", 'GitHub didn\'t answer (' + (e.message || e) + '). Try again in a minute.', 'err');
      return;
    }
    busy.remove();
    if (rollingOut()) {
      const mins = Math.max(1, Math.ceil((ROLLOUT_MS - (Date.now() - released())) / 60000));
      AE.toast('v' + state.latest.version + ' is rolling out', 'It was just released. Check again in about ' + mins + ' minute' + (mins === 1 ? '' : 's') + '.', 'ok', 9000);
      return;
    }
    const v = updateAvailable();
    if (!v) { AE.toast("You're up to date", AE_NAME + ' v' + AE_VERSION + ' is the latest.', 'ok'); return; }
    const ok = await AE.confirm({
      title: 'Update available',
      message: AE_NAME + ' <b>v' + AE.esc(v) + '</b> is out (you have v' + AE.esc(AE_VERSION) + ').'
        + '<div class="sg-soft" style="margin-top:6px">Tampermonkey opens in a new tab: click <b>Update</b> there, then reload Portal.</div>',
      confirmLabel: 'Update now',
      cancelLabel: 'Later',
    });
    if (ok) startUpdate(v);
  }

  // ------------------------------------------------------------ UI
  const CSS = `
  #sg-status-banner { position:fixed; z-index:2147483644; left:50%; transform:translateX(-50%); width:min(760px, calc(100vw - 32px));
    display:flex; gap:12px; align-items:flex-start; padding:12px 12px 12px 14px; border-radius:12px; font-size:14px; line-height:1.45;
    border:1px solid var(--st-edge); border-left:5px solid var(--st-edge); background:var(--st-bg); color:var(--st-fg);
    box-shadow:0 8px 28px rgba(12,14,17,.18); animation:sg-in .2s ease-out; }
  #sg-status-banner.info { --st-bg:var(--aui-primary-soft, #faecff); --st-fg:var(--aui-on-primary-soft, #590099); --st-edge:var(--aui-primary, #8223d2); }
  #sg-status-banner.warning { --st-bg:var(--aui-status-warning-soft, #fff0c0); --st-fg:var(--aui-status-on-warning-soft, #3a3000); --st-edge:var(--aui-status-warning, #e7c500); }
  #sg-status-banner.error { --st-bg:var(--aui-status-error-soft, #ffdad7); --st-fg:var(--aui-status-on-error-soft, #410004); --st-edge:var(--aui-status-error, #b91a24); }
  #sg-status-banner .mark { flex:none; line-height:0; color:var(--st-edge); margin-top:1px; }
  #sg-status-banner .body { flex:1; min-width:0; }
  #sg-status-banner .title { display:flex; flex-wrap:wrap; align-items:center; gap:6px; font-weight:700; }
  #sg-status-banner .title .sg-aicon { width:18px; height:18px; }
  #sg-status-banner .who { font-size:11px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; opacity:.75; }
  #sg-status-banner .msg { margin-top:2px; overflow-wrap:anywhere; }
  #sg-status-banner .extra { margin-top:6px; font-size:13px; font-weight:600; }
  #sg-status-banner .acts { display:flex; gap:6px; margin-top:8px; flex-wrap:wrap; }
  #sg-status-banner .acts .sg-btn { height:28px; padding:0 12px; font-size:13px; border-color:currentColor; color:inherit; }
  #sg-status-banner .sg-x { color:inherit; opacity:.7; }
  #sg-status-banner .sg-x:hover { opacity:1; }
  .sg-avail-pill { position:fixed; z-index:2147483645; left:50%; bottom:20px; transform:translateX(-50%); display:inline-flex; align-items:center; gap:10px;
    height:40px; padding:0 6px 0 14px; border-radius:10000rem; background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e);
    border:1px solid var(--aui-outline, #c6c6ca); box-shadow:0 8px 28px rgba(12,14,17,.22); font:600 14px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif;
    white-space:nowrap; animation:sg-in .25s ease-out; }
  .sg-avail-pill .mark { line-height:0; color:var(--aui-primary, #8223d2); }
  .sg-avail-pill .sg-btn { height:28px; padding:0 12px; font-size:13px; }
  .sg-avail-pill .sg-x { font-size:16px; }
  `;
  const ensureCss = () => { AE.ensureCss(); if (!document.getElementById('sg-status-css')) document.head.append(h('style', { id: 'sg-status-css' }, CSS)); };

  // Just under Portal's header, wherever it ends.
  function placeBanner() {
    const el = document.getElementById('sg-status-banner');
    if (!el) return;
    const header = document.querySelector('.components-header');
    const top = header ? Math.max(0, header.getBoundingClientRect().bottom) : 0;
    el.style.top = Math.round(top + 10) + 'px';
  }

  function renderBanner() {
    const inc = incident();
    const key = inc && inc.id + '|' + inc.updated;
    let el = document.getElementById('sg-status-banner');
    if (!inc || GM_getValue(DISMISS_KEY, '') === key) { el?.remove(); return; }
    if (el && el.dataset.key === key) return;
    el?.remove();
    ensureCss();
    const pausedNames = inc.pause.map(crystalName);
    const upd = updateAvailable();
    el = h('div', { id: 'sg-status-banner', class: 'sg ' + inc.severity, role: inc.severity === 'error' ? 'alert' : 'status', 'data-key': key },
      h('span', { class: 'mark', title: AE_NAME, html: icon('aetheryte', 26) }),
      h('div', { class: 'body' },
        h('div', { class: 'title' }, h('span', { class: 'who' }, AE_NAME + ' notice'),
          inc.crystals.map((id) => h('span', { title: crystalName(id), html: AE.actionIcon(id, 18) })), h('span', null, inc.title)),
        inc.message ? h('div', { class: 'msg' }, inc.message) : null,
        pausedNames.length ? h('div', { class: 'extra' }, 'Paused until it\'s fixed: ' + pausedNames.join(', ') + '.') : null,
        inc.fixedIn ? h('div', { class: 'extra' }, 'Fixed in v' + inc.fixedIn + '. You have v' + AE_VERSION + '.') : null,
        h('div', { class: 'acts' },
          inc.fixedIn && upd ? h('button', { type: 'button', class: 'sg-btn', onclick: () => startUpdate(upd) }, 'Update now') : null,
          inc.crystals.length ? h('button', { type: 'button', class: 'sg-btn', onclick: () => AE.openSettings(inc.crystals[0]) }, 'Open in Settings') : null)),
      h('button', { type: 'button', class: 'sg-x', title: 'Dismiss (it comes back if the notice is updated)', onclick: () => { GM_setValue(DISMISS_KEY, key); el.remove(); } }, '✕'));
    document.body.appendChild(el);
    placeBanner();
  }

  function renderUpdatePill() {
    const v = updateAvailable();
    let el = document.getElementById('sg-avail-pill');
    const hide = !v || GM_getValue(UPDATE_DISMISS_KEY, '') === v || document.getElementById('sg-update-pill');
    if (hide) { el?.remove(); return; }
    if (el && el.dataset.v === v) return;
    el?.remove();
    ensureCss();
    el = h('div', { id: 'sg-avail-pill', class: 'sg sg-avail-pill', role: 'status', 'data-v': v },
      h('span', { class: 'mark', html: icon('aetheryte', 20) }), AE_NAME + ' v' + v + ' is available',
      h('button', { type: 'button', class: 'sg-btn sg-primary', onclick: () => { el.remove(); startUpdate(v); } }, 'Update'),
      h('button', { type: 'button', class: 'sg-x', title: 'Not now', onclick: () => { GM_setValue(UPDATE_DISMISS_KEY, v); el.remove(); } }, '✕'));
    document.body.appendChild(el);
  }

  function render() {
    if (!AE_ON_PORTAL || !document.body) return;
    renderBanner();
    renderUpdatePill();
    AE.emit('status-changed', state);
  }

  if (AE_ON_PORTAL) {
    // After every module has loaded (crystal names, Settings), paint the cached
    // copy right away, then fetch a fresh one and keep polling.
    setTimeout(() => {
      render();
      const poll = () => refresh(false).catch((e) => console.warn('[' + AE_NAME + '] status check failed:', e.message || e));
      poll();
      setInterval(poll, POLL_MS);
      setInterval(render, 60 * 1000); // lets a rolling-out release appear once it's ready
      AE.every(1500, placeBanner); // Portal's header can change height
    }, 0);
  }

  // Dev tools: show a pretend status.json (not saved; the next real check replaces it).
  function simulate(raw) { state = clean(raw); GM_deleteValue(DISMISS_KEY); GM_deleteValue(UPDATE_DISMISS_KEY); render(); }

  return { get: () => state, incident, paused, blocked, refresh, checkNow, startUpdate, updateAvailable, newer, simulate, url: STATUS_URL };
})();

// ===== 05-settings.js =====
/*
  Settings: a "Aethernet settings" item in Portal's avatar menu (cloned
  from Portal's own "View my account" item so it matches exactly), which
  opens a pop-out settings card. Also reachable from the Tampermonkey menu.
  Crystal on/off changes need a reload, so Save reloads the page.
*/
(function settingsUi() {
  if (!AE_ON_PORTAL) return;
  const { h, esc, icon } = AE;

  // Crystals are named after FFXIV actions; the description says what each does.
  const CRYSTAL_INFO = [
    ['cleaningRate', 'Divination', "Live cleaning rate: header badge with today's cleaning percentage."],
    // The demo build (false) ships only Divination, Swiftcast and Glamour; the
    // rest sit in false ? [] : […] so their text isn't in that file at all.
    ...(false ? [] : [
    ['woCleanings', 'Esuna', 'WO cleanings pill: shows whether a work order\'s device has cleanings, with Create for available ones.'],
    ['textNotes', 'Recitation', 'Text → WO note: when you text a customer from a WO, the text is added to the WO notes.'],
    ]),
    ['autoClose', 'Swiftcast', 'Cleaning auto-close: one-click check-in → complete sale on cleaning arrivals.'],
    ...(false ? [] : [
    ['galaxy', 'Macrocosmos', 'Galaxy Diagnostics exception: pre-fills the Sprinklr exception form from a Samsung WO.'],
    ['buybacks', 'Bountiful Yield', 'Buyback add-all: bulk-adds Apple (TLC) or Samsung/Google (UROC) parts in the Add buyback parts popout.'],
    ['printLabels', 'Quick Synthesis', 'Print all labels: prints every serial label on a PO Receive page.'],
    ]),
    ['glamour', 'Glamour', 'Page theming: recolour Portal with a preset theme or one you make.'],
    ...(false ? [] : [
    ['waymark', 'Waymark', 'Work-order tags: tag WOs for the whole store and see them grouped on a board.'],
    ['countCheck', 'Lay of the Land', 'Inventory count check: on a count, shows which expected serials haven\'t been scanned yet, and any unexpected scans.'],
    ['rowColors', 'Rainbow Drip', 'WO list colors: colors each row of the work-order list by its status.'],
    ['fixes', "Master's Mend", 'Small fixes to Portal, each with its own switch.'],
    ]),
  ];

  /*
    What's new. A crystal is "new" until Settings has been opened and closed
    once with it listed; new ones get a yellow sheen. The first run of a build
    after an update shows an "Aethernet has updated!" pill (once) that opens
    Settings. A fresh install sees neither.

    What's updated. A patch-notes entry can list the existing crystals it
    changed ("updated": [ids]); after an update those get an "Updated" tag and
    a purple sheen (New wins if both), until Settings is closed once.
    ae_updates_seen is the version whose updates were last seen; the first
    run that tracks it starts from the version you updated from.
  */
  const SEEN_KEY = 'ae_seen_crystals', VERSION_KEY = 'ae_last_version';
  const allIds = () => CRYSTAL_INFO.map(([id]) => id);
  const existingInstall = () => ['sg_settings', 'ae_settings_sections', 'ae_text_notes_logged', 'gde_btn_pos']
    .some((k) => GM_getValue(k) !== undefined);
  const lastVersion = GM_getValue(VERSION_KEY);
  const updated = lastVersion ? lastVersion !== AE_VERSION : existingInstall();
  // Before 2.7 nothing was tracked: count every crystal as already seen.
  if (GM_getValue(SEEN_KEY) === undefined) GM_setValue(SEEN_KEY, allIds());
  const isNew = (id) => !GM_getValue(SEEN_KEY, []).includes(id);
  const UPD_KEY = 'ae_updates_seen';
  if (GM_getValue(UPD_KEY) === undefined) GM_setValue(UPD_KEY, lastVersion || AE_VERSION);
  const isUpdated = (id) => {
    const seen = GM_getValue(UPD_KEY, AE_VERSION);
    return PATCH_NOTES.some((n) => newer(n.version, seen) && !newer(n.version, AE_VERSION) && (n.updated || []).includes(id));
  };
  const markAllSeen = () => {
    GM_setValue(SEEN_KEY, [...new Set([...GM_getValue(SEEN_KEY, []), ...allIds()])]);
    GM_setValue(UPD_KEY, AE_VERSION);
  };
  if (lastVersion !== AE_VERSION) GM_setValue(VERSION_KEY, AE_VERSION);

  const MODAL_CSS = `
  .sg-scrim { position:fixed; inset:0; z-index:2147483646; background:var(--aui-scrim-overlay, #0c0e1180); display:flex; justify-content:flex-end; }
  .sg-sheet { display:flex; flex-direction:column; width:min(440px, 100vw); height:100%; overflow:auto; border-radius:16px 0 0 16px; border-right:0; padding:24px; animation: sg-slide .22s ease-out; }
  .sg-sheet > * { flex-shrink:0; }
  /* "Aethernet" titles use AE.wordmark() — Runic MT outlines, no font file shipped */
  .sg-wordmark { margin:0 0 4px; color:var(--aui-on-surface, #1a1c1e); line-height:0; }
  .sg-about .hero h2.sg-wordmark { margin-top:8px; }
  .sg-about-link { display:block; margin:20px auto 4px; padding:6px 10px; border:0; background:none; cursor:pointer;
    color:var(--aui-on-surface-soft, #5d5e61); font:400 13px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; text-decoration:underline; }
  .sg-about-link:hover { color:var(--aui-primary, #8223d2); }
  .sg-foot-links { display:flex; justify-content:center; gap:4px; margin:20px auto 4px; }
  .sg-foot-links .sg-about-link { margin:0; }
  /* Patch notes */
  .sg-notes { width:min(520px, 100%); max-height:calc(100vh - 32px); display:flex; flex-direction:column; padding:22px 20px 16px; font-size:14px; line-height:1.45; }
  .sg-notes .head { display:flex; align-items:center; gap:10px; margin-bottom:14px; }
  .sg-notes .head h2 { flex:1; margin:0; font-size:20px; font-weight:700; }
  .sg-notes .list { overflow:auto; margin:0 -4px; padding:0 4px; }
  .sg-patch { border:1px solid var(--aui-outline-soft, #eeedf1); border-radius:12px; margin-bottom:8px; background:var(--aui-surface, #fff); }
  .sg-patch > summary { display:flex; align-items:center; gap:10px; padding:10px 12px; cursor:pointer; list-style:none; border-radius:12px; }
  .sg-patch > summary::-webkit-details-marker { display:none; }
  .sg-patch > summary:focus-visible { outline:2px solid var(--aui-primary, #8223d2); outline-offset:1px; }
  .sg-patch > summary .chev { width:16px; height:16px; flex:none; color:var(--aui-on-surface-soft, #5d5e61); transform:rotate(-90deg); transition:transform .2s; }
  .sg-patch[open] > summary .chev { transform:none; }
  .sg-patch .ver { font-weight:700; }
  .sg-patch .when { flex:1; text-align:right; font-size:12px; color:var(--aui-on-surface-soft, #5d5e61); }
  .sg-patch .tag { padding:1px 7px; border-radius:10000rem; font-size:11px; font-weight:700; letter-spacing:.03em; text-transform:uppercase;
    background:var(--aui-primary-soft, #faecff); color:var(--aui-on-primary-soft, #590099); }
  .sg-patch .tag.new { background:#ffcc00; color:#3d2e00; }
  .sg-patch ul { margin:0; padding:0 14px 12px 40px; }
  .sg-patch li { margin:4px 0; }
  /* Thank-yous and attributions: a flair so they stand out (gold-to-purple border that shimmers) */
  .sg-flair { display:flex; align-items:flex-start; gap:9px; margin:2px 14px 12px 40px; padding:8px 12px; border-radius:10px; font-size:13px; line-height:1.4;
    border:1.5px solid transparent; color:var(--aui-on-surface, #1a1c1e);
    background:linear-gradient(var(--aui-surface, #fff), var(--aui-surface, #fff)) padding-box,
      linear-gradient(105deg, #ffcc00 0%, #e8a6ff 35%, #8223d2 50%, #e8a6ff 65%, #ffcc00 100%) border-box;
    background-size:100% 100%, 250% 100%; animation:sg-flair 4s ease-in-out infinite; }
  .sg-flair + .sg-flair { margin-top:-6px; }
  .sg-flair .ic { flex:none; width:18px; height:18px; margin-top:1px; color:#d6a000; line-height:0; }
  .sg-flair b { color:var(--aui-primary, #8223d2); }
  @keyframes sg-flair { 0%, 100% { background-position:0 0, 100% 0; } 50% { background-position:0 0, 0% 0; } }
  .sg-patch .tag.thanks { background:linear-gradient(105deg, #ffcc00, #b36cf0); color:#2b0a47; }
  @media (prefers-reduced-motion: reduce) { .sg-flair { animation:none; } }
  .sg-about-scrim { position:fixed; inset:0; z-index:2147483647; background:var(--aui-scrim-overlay, #0c0e1180);
    display:flex; align-items:center; justify-content:center; padding:16px; animation: sg-in .15s ease-out; }
  .sg-about { width:min(460px, 100%); max-height:calc(100vh - 32px); overflow:auto; padding:28px 24px 20px; font-size:14px; line-height:1.45; }
  .sg-about .hero { display:flex; flex-direction:column; align-items:center; text-align:center; gap:4px; margin-bottom:18px; }
  .sg-about .hero h2 { margin:6px 0 0; font-size:24px; font-weight:700; }
  .sg-about h4 { margin:18px 0 6px; font-size:12px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; color:var(--aui-on-surface-soft, #5d5e61); }
  .sg-about .sg-kv { grid-template-columns:110px 1fr; }
  .sg-about code { font:12px ui-monospace, SFMono-Regular, Menlo, monospace; background:var(--aui-neutral-soft, #f1f0f4); padding:1px 5px; border-radius:4px; }
  .sg-about .chips { display:flex; flex-wrap:wrap; gap:6px; }
  .sg-about .chip-off { opacity:.5; text-decoration:line-through; }
  .sg-about .link-row { display:flex; gap:8px; align-items:center; }
  .sg-about .link-row input { flex:1; min-width:0; height:36px; padding:0 10px; border:1px solid var(--aui-outline, #c6c6ca); border-radius:8px;
    background:var(--aui-surface-variant, #faf9fc); color:var(--aui-on-surface, #1a1c1e); font:12px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .sg-about .fine { margin-top:18px; text-align:center; font-size:12px; color:var(--aui-on-surface-soft, #5d5e61); }
  /* "flow" in the subtitle: a purple→blue gradient that keeps flowing through the word */
  .sg-flow { font-style:italic; font-weight:700; padding-right:1px;
    background:linear-gradient(90deg, var(--aui-primary, #8223d2), var(--aui-brand-asurion-blue, #4a68f9), var(--aui-primary, #8223d2));
    background-size:200% 100%; background-repeat:repeat; -webkit-background-clip:text; background-clip:text; color:transparent;
    animation: sg-flow 3.5s linear infinite; }
  @keyframes sg-flow { from { background-position:0% 50%; } to { background-position:200% 50%; } }
  @media (prefers-reduced-motion: reduce) { .sg-flow { animation:none; } }
  @keyframes sg-slide { from { transform: translateX(40px); opacity:0; } to { transform:none; opacity:1; } }
  .sg-sheet h2 { font-size:22px; font-weight:700; margin:0; }
  .sg-sec { border-top:1px solid var(--aui-outline-soft, #eeedf1); margin-top:16px; }
  .sg-sec-head { display:flex; align-items:center; gap:8px; width:100%; padding:14px 0 10px; border:0; background:none; cursor:pointer;
    color:var(--aui-on-surface, #1a1c1e); font:700 14px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; text-align:left; }
  .sg-sec-head .sum { flex:1; font-weight:400; font-size:12px; color:var(--aui-on-surface-soft, #5d5e61); text-align:right; }
  .sg-sec-head .chev { display:block; width:18px; height:18px; flex:none; color:var(--aui-on-surface-soft, #5d5e61); transition:transform .2s; }
  .sg-sec.closed .sg-sec-head .chev { transform:rotate(-90deg); }
  .sg-sec-head:focus-visible { outline:2px solid var(--aui-primary, #8223d2); outline-offset:2px; border-radius:4px; }
  .sg-sec-body { display:grid; grid-template-rows:1fr; transition:grid-template-rows .2s ease; }
  .sg-sec.closed .sg-sec-body { grid-template-rows:0fr; }
  .sg-sec-body > div { overflow:hidden; min-height:0; }
  .sg-sec-body > div > :last-child { margin-bottom:8px; }
  .sg-row { display:flex; align-items:center; gap:12px; padding:10px 0; border-top:1px solid var(--aui-outline-soft, #eeedf1); }
  .sg-row:first-of-type { border-top:0; }
  .sg-row > div { flex:1; min-width:0; }
  .sg-row b { font-weight:600; font-size:14px; display:block; }
  .sg-row b.sg-cname { display:flex; align-items:center; gap:8px; margin-bottom:3px; }
  .sg-cicon { display:inline-flex; line-height:0; }
  .sg-about .sg-chip { padding-left:3px; }
  .sg-about .chip-off .sg-aicon { filter:grayscale(1); }
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
  .sg-sheet-foot { position:sticky; bottom:-24px; margin:auto -24px -24px; padding-top:16px; flex:none; padding:16px 24px; display:flex; gap:8px;
    background:var(--aui-surface, #fff); border-top:1px solid var(--aui-outline-soft, #eeedf1); }
  .sg-sheet-foot .sg-btn { flex:1; }
  /* nested crystal settings */
  .sg-crystal { border-top:1px solid var(--aui-outline-soft, #eeedf1); }
  .sg-crystal:first-child { border-top:0; }
  .sg-crystal > .sg-row { border-top:0; }
  .sg-opt-toggle { display:inline-flex; align-items:center; gap:4px; margin-top:4px; padding:2px 0; border:0; background:none; cursor:pointer;
    color:var(--aui-primary, #8223d2); font:400 12px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; }
  .sg-opt-toggle .chev { width:14px; height:14px; transition:transform .2s; }
  .sg-opt-toggle[aria-expanded="false"] .chev { transform:rotate(-90deg); }
  .sg-opt-toggle .sum { color:var(--aui-on-surface-soft, #5d5e61); }
  .sg-opt-toggle:focus-visible { outline:2px solid var(--aui-primary, #8223d2); outline-offset:2px; border-radius:4px; }
  .sg-opts { display:grid; grid-template-rows:1fr; transition:grid-template-rows .2s ease; }
  .sg-opts.closed { grid-template-rows:0fr; }
  .sg-opts > div { overflow:hidden; min-height:0; }
  .sg-opts > div > div { margin:0 0 12px 2px; padding:2px 0 2px 14px; border-left:2px solid var(--aui-primary-soft, #faecff); }
  /* new crystals: a yellow sheen until Settings is closed once */
  .sg-crystal.sg-new { position:relative; margin:0 -10px; padding:0 10px; border-radius:10px; border-top-color:transparent;
    background:linear-gradient(105deg, rgba(255,204,0,.14) 0%, rgba(255,204,0,.14) 38%, rgba(255,236,140,.55) 50%, rgba(255,204,0,.14) 62%, rgba(255,204,0,.14) 100%);
    background-size:250% 100%; box-shadow:inset 0 0 0 1px rgba(214,160,0,.55); animation:sg-sheen 2.6s ease-in-out infinite; }
  .sg-crystal.sg-new + .sg-crystal { border-top-color:transparent; }
  @keyframes sg-sheen { 0% { background-position:100% 0; } 60%,100% { background-position:0% 0; } }
  .sg-issue-tag { display:inline-block; margin-left:6px; padding:1px 7px; border-radius:10000rem; vertical-align:2px; font-size:11px; font-weight:700;
    letter-spacing:.03em; text-transform:uppercase; background:var(--aui-status-warning-soft, #fff0c0); color:var(--aui-status-on-warning-soft, #3a3000); }
  .sg-issue-tag.paused, .sg-issue-tag.error { background:var(--aui-status-error-soft, #ffdad7); color:var(--aui-status-on-error-soft, #410004); }
  .sg-new-tag { display:inline-block; margin-left:8px; padding:1px 7px; border-radius:10000rem; vertical-align:2px;
    background:#ffcc00; color:#3d2e00; font-size:11px; font-weight:700; letter-spacing:.03em; text-transform:uppercase; }
  /* updated crystals: the same sheen in Aethernet purple, until Settings is closed once */
  .sg-crystal.sg-upd { position:relative; margin:0 -10px; padding:0 10px; border-radius:10px; border-top-color:transparent;
    background:linear-gradient(105deg, rgba(130,35,210,.08) 0%, rgba(130,35,210,.08) 38%, rgba(196,140,255,.38) 50%, rgba(130,35,210,.08) 62%, rgba(130,35,210,.08) 100%);
    background-size:250% 100%; box-shadow:inset 0 0 0 1px rgba(130,35,210,.45); animation:sg-sheen 2.6s ease-in-out infinite; }
  .sg-crystal.sg-upd + .sg-crystal { border-top-color:transparent; }
  .sg-new-tag.upd { background:#8223d2; color:#fff; }
  .sg-exp-tag { display:inline-block; padding:1px 7px; border-radius:10000rem; font-size:10px; font-weight:800; letter-spacing:.06em; text-transform:uppercase;
    background:repeating-linear-gradient(135deg, #fff0c0 0 6px, #ffe28a 6px 12px); color:#5a4300; border:1px solid #d6a000; }
  /* "Aethernet has updated!" pill */
  .sg-update-pill { position:fixed; z-index:2147483645; left:50%; bottom:20px; transform:translateX(-50%);
    display:inline-flex; align-items:center; gap:8px; height:40px; padding:0 8px 0 14px; border:0; border-radius:10000rem; cursor:pointer;
    color:var(--aui-on-primary, #fff); font:700 14px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; white-space:nowrap;
    background:linear-gradient(105deg, var(--aui-primary, #8223d2) 0%, var(--aui-primary, #8223d2) 40%, #b36cf0 50%, var(--aui-primary, #8223d2) 60%, var(--aui-primary, #8223d2) 100%);
    background-size:250% 100%; box-shadow:0 8px 28px rgba(12,14,17,.28); animation:sg-pill-in .3s ease-out, sg-sheen 3s ease-in-out .3s infinite; }
  .sg-update-pill:hover { filter:brightness(1.08); }
  .sg-update-pill .ver { font-weight:400; opacity:.8; }
  .sg-update-pill .x { display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; border-radius:50%; font-weight:400; opacity:.8; }
  .sg-update-pill .x:hover { opacity:1; background:rgba(255,255,255,.18); }
  /* it dismisses itself after 10 s: a ring around the ✕ runs down (paused while hovered) */
  .sg-update-pill .x { position:relative; width:26px; height:26px; opacity:.9; }
  .sg-update-pill .x .ring { position:absolute; inset:0; width:26px; height:26px; transform:rotate(-90deg); pointer-events:none; }
  .sg-update-pill .x .ring circle { fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-dasharray:69.1; stroke-dashoffset:0;
    animation:sg-countdown 10s linear forwards; }
  .sg-update-pill:hover .x .ring circle { animation-play-state:paused; }
  @keyframes sg-countdown { to { stroke-dashoffset:69.1; } }
  /* Save & reload, while there are changes to save */
  .sg-btn.sg-primary.sg-pending { background:linear-gradient(105deg, var(--aui-primary, #8223d2) 0%, var(--aui-primary, #8223d2) 40%, #b36cf0 50%, var(--aui-primary, #8223d2) 60%, var(--aui-primary, #8223d2) 100%);
    background-size:250% 100%; animation:sg-sheen 2.4s ease-in-out infinite, sg-save-pulse 1.6s ease-out infinite; }
  @keyframes sg-save-pulse { 0% { box-shadow:0 0 0 0 rgba(130,35,210,.5); } 100% { box-shadow:0 0 0 10px rgba(130,35,210,0); } }
  @keyframes sg-pill-in { from { opacity:0; transform:translate(-50%, 10px); } to { opacity:1; transform:translate(-50%, 0); } }
  @media (prefers-reduced-motion: reduce) { .sg-crystal.sg-new, .sg-crystal.sg-upd, .sg-update-pill, .sg-btn.sg-pending { animation:none; } .sg-update-pill .x .ring { display:none; } }
  `;

  // About — its own modal, above the settings panel.
  function openAbout() {
    document.getElementById('sg-about')?.remove();
    const built = new Date(AE_BUILD_TIME);
    const builtText = isNaN(built) ? AE_BUILD_TIME
      : built.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    let manager = 'Unknown';
    try { if (typeof GM_info !== 'undefined') manager = GM_info.scriptHandler + ' ' + GM_info.version; } catch (_) {}
    const ua = navigator.userAgent;
    const browser = /Zen\//.test(ua) ? 'Zen' : /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox (or a Firefox-based browser)'
      : /Chrome\//.test(ua) ? 'Chrome (or a Chromium-based browser)' : /Safari\//.test(ua) ? 'Safari' : 'Unknown';
    const on = AE.settings.crystals;
    const kv = (...pairs) => h('dl', { class: 'sg-kv' }, pairs.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
    const linkInput = h('input', { type: 'text', value: AE_INSTALL_URL, readonly: true, onfocus: (e) => e.target.select() });
    const copyBtn = h('button', { type: 'button', class: 'sg-btn', onclick: async () => {
      try { await navigator.clipboard.writeText(AE_INSTALL_URL); copyBtn.textContent = 'Copied'; }
      catch (_) { linkInput.select(); copyBtn.textContent = 'Press ⌘C'; }
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
    } }, 'Copy');
    const whoBox = h('span', null, '…');
    AE.profile().then((p) => { whoBox.textContent = (p.name || '—') + (p.storeId ? ' · ' + p.storeId + ' ' + p.storeName : ''); }).catch(() => { whoBox.textContent = '—'; });

    // The demo build's About is the bare minimum: name, version, author, icon credit.
    const card = false ? h('div', { class: 'sg sg-card sg-about', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'About ' + AE_NAME },
      h('div', { class: 'hero' },
        h('span', { style: 'color:var(--aui-primary,#8223d2)', html: icon('aetheryte', 56) }),
        h('h2', { class: 'sg-wordmark', html: AE.wordmark(40) }),
        h('div', { class: 'sg-soft' }, 'v' + AE_VERSION)),
      h('h4', null, 'Authored by'),
      kv(['Author', 'Garrett Green'], ['Store', 'uBreakiFix Newport News #914'], ['With', 'Claude (Anthropic)']),
      h('div', { class: 'fine' }, 'Crystal icons are FINAL FANTASY XIV action icons. © SQUARE ENIX.'),
      h('div', { class: 'sg-actions', style: 'margin-top:16px' }, h('button', { type: 'button', class: 'sg-btn sg-lg', onclick: () => close() }, 'Close')))
    : h('div', { class: 'sg sg-card sg-about', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'About ' + AE_NAME },
      h('div', { class: 'hero' },
        h('span', { style: 'color:var(--aui-primary,#8223d2)', html: icon('aetheryte', 56) }),
        h('h2', { class: 'sg-wordmark', html: AE.wordmark(40) }),
        h('div', { class: 'sg-soft', html: 'Restoring the <span class="sg-flow">flow</span> of NextGen' })),
      h('h4', null, 'This build'),
      kv(['Version', 'v' + AE_VERSION], ['Built', builtText], ['Commit', h('code', null, AE_BUILD_COMMIT)]),
      h('h4', null, 'Authored by'),
      kv(['Author', 'Garrett Green'], ['Store', 'uBreakiFix Newport News #914'], ['With', 'Claude (Anthropic)']),
      h('h4', null, 'Crystals'),
      h('div', { class: 'chips' }, CRYSTAL_INFO.map(([id, name]) =>
        h('span', { class: 'sg-chip' + (on[id] ? '' : ' chip-off'), title: on[id] ? 'On' : 'Off' }, h('span', { class: 'sg-cicon', html: AE.actionIcon(id, 16) }), name))),
      h('h4', null, 'Your setup'),
      kv(['Signed in', whoBox], ['Browser', browser], ['Script manager', manager]),
      h('h4', null, 'Usage data'),
      h('div', { class: 'sg-soft' }, AE_NAME + ' records which features each person uses (a count per feature per day, with name and store) to decide what to improve. It never records customer details or page contents. Bug reports and suggestions sent from Send feedback include your name and store.'),
      h('h4', null, 'Share with another store'),
      h('div', { class: 'link-row' }, linkInput, copyBtn),
      h('div', { class: 'sg-soft', style: 'margin-top:6px' }, 'Open the link with Tampermonkey installed to add ' + AE_NAME + '. Installs update themselves.'),
      h('div', { class: 'sg-soft', style: 'margin-top:6px' }, 'The installed file is minified to keep it small. ',
        h('a', { href: AE_READABLE_URL, target: '_blank', rel: 'noopener', style: 'color:var(--aui-primary,#8223d2)' }, 'Read the source'), ' (the same build, unminified).'),
      h('div', { class: 'fine' }, 'A personal project. Not affiliated with or supported by Asurion or uBreakiFix.'),
      h('div', { class: 'fine', style: 'margin-top:4px' }, 'Crystal icons are FINAL FANTASY XIV action icons. © SQUARE ENIX. Not affiliated with Square Enix.'),
      h('div', { class: 'sg-actions', style: 'margin-top:16px' }, h('button', { type: 'button', class: 'sg-btn sg-lg', onclick: () => close() }, 'Close')));
    const scrim = h('div', { class: 'sg sg-about-scrim', id: 'sg-about', onclick: (e) => { if (e.target === scrim) close(); } }, card);
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    function close() { scrim.remove(); document.removeEventListener('keydown', onKey, true); }
    document.addEventListener('keydown', onKey, true); // capture: Esc closes About, not Settings
    document.body.appendChild(scrim);
  }

  // Patch notes — its own modal, above Settings. Every release is a panel,
  // newest first. `since` (the version you updated from) expands everything
  // newer than it; otherwise just the latest is open.
  const PATCH_NOTES = [{"version": "2.18.0", "notes": ["**Divination**: a **Cleaning rate history** card on the Reports page shows your cleaning percentage over the last 7, 30 or 90 days, this month or last month: the overall rate, how many days hit the target, a bar for each day and a day-by-day table.", "**Master's Mend**: if Portal's Reports page is stuck loading, a warning explains the usual cause: an ad blocker like uBlock Origin blocks Portal's reports. Turn it off for Portal and reload.", "**Swiftcast**: new **experimental** option to add the refresh labor SKU (10156) to Verizon Device Refresh cleanings, for commission. It's still being tested, so it's off by default (Settings \u2192 Swiftcast \u2192 Refresh labor). If the labor can't be added, the cleaning is still completed at $0.", "**Swiftcast**: the old lightning bolt button has been replaced by one button named for what's waiting. With one cleaning it's **Swiftcast** (now with its real icon); with two it becomes **Dualcast** and creates both, one after the other; with three or more, **Triplecast**. Right-click Dualcast or Triplecast to close only this cleaning. A short explainer shows the first time. Dualcast is also in Esuna's list and Divination's panel, and can be turned off in Settings under Swiftcast.", "**Swiftcast**, **Quick Synthesis** and **Macrocosmos**: some visual changes to enhance the feel of these crystals.", "**Swiftcast**, **Dualcast** and **Triplecast** now keep you from reloading the page mid-cast, so no work order gets left half-done: F5 / Ctrl+R / Cmd+R do nothing until the cast ends, and closing the tab or using the browser's reload button asks first. The box reminds you while it runs."], "thanks": ["**C.Boyd** at Lexington, for the idea for **Divination**'s cleaning rate history!", "**C.Pritchard** at Lynnhaven, for the idea for **Swiftcast**'s refresh labor option!"], "updated": ["cleaningRate", "autoClose", "woCleanings", "printLabels", "galaxy", "fixes"], "date": "2026-10-02T00:06:27Z"}, {"version": "2.17.1", "notes": ["Patch notes: thank-yous and credits now get their own highlight, so the people who help build Aethernet stand out."], "date": "2026-10-01T05:32:00Z"}, {"version": "2.17.0", "notes": ["New crystal: **Rainbow Drip**. Work-order lists color each row by its status: red for Ready for work; blue for Diagnostics, Work in progress and Quality check; green for Ready for pickup; purple for Need to order, Ready for diag and Repair summary; yellow for Awaiting callback, Awaiting item and Awaiting device. It replaces the **UBIF Status Row Classes** script: if that's still running, you'll see how to turn it off.", "New crystal: **Master's Mend**, small fixes to Portal, each with its own switch in Settings. First fix: the ubreakifix logo in the top left is now a real link to the dashboard, so you can middle-click or right-click it to open a new tab.", "No more reloading to see changes: a text logged by **Recitation** shows in the WO notes right away, and so do Auto-Waymark nickname changes and cleanings closed out by **Swiftcast**. The page refreshes its data in place.", "**Master's Mend**: scan to open. Scan a WO label to open that work order, or an item label to open the item, from the dashboard, the work-order list or a customer. On a WO, scanned items are still added to it, and scanning does nothing on inventory, check-in or check-out pages or while you're typing in a field. Scanners that were a little too slow for Portal's own scan features now work with them too.", "**Glamour**: make the login page yours. In Glamour's settings, under **Login page**, choose a picture to replace Portal's photo (best fit: 768 \u00d7 871 px, shown in the setting), or fill the whole purple panel with it, and show the Aethernet mark in the bottom-left corner.", "**Master's Mend**: sort the Work orders list by any column. Click the arrows beside a column name. Most columns sort across every page; Customer, Device/Issue, Location, Service Outcome, Completed and Created/Cancelled By sort the page you're on (their arrows are underlined).", "**Auto-Waymark**: texting the customer from a work order at Ready for pickup restarts its follow-up: the Auto-Waymark (and nickname) moves to 3 days from that day. It only ever moves later, and works whether or not Recitation is on.", "**Waymark**: managers can clear a tag straight from the board with the \u00d7 on it. Everyone else removes tags from the work order as before.", "**Master's Mend**: a **Hide auto notes** switch at the top of a work order's notes hides the automatic notes (status changes, check-in logs and the like), and loads every note on the work order, so you see the whole history of what people wrote, not just the first page. Flip it back any time; nothing is deleted.", "**Master's Mend**: a **Not contacted** chip on the Arrivals page, next to Portal's own (look for the Aethernet mark on its corner), lists every arrival that hasn't been contacted yet, from every page at once. Click an arrival to open it as usual; any other chip goes back to Portal's list. In Settings (Master's Mend), choose whether it lists all statuses or only arrivals that are still Not confirmed.", "Crystals that changed in an update now get a purple **Updated** sheen in Settings, like the yellow one on new crystals.", "Settings: **Save & reload** glows while you have changes to save. The **Aethernet has updated!** pill now goes away by itself after 10 seconds (the ring around its \u2715 counts down; hovering pauses it)."], "updated": ["textNotes", "autoClose", "glamour", "waymark"], "date": "2026-10-01T05:28:46Z", "thanks": ["**B.Young** at Lexington, for letting us crystallize **Rainbow Drip** from their script!"]}, {"version": "2.16.0", "notes": ["New crystal: **Lay of the Land** (inventory count check). On an inventory count, a **Missing serials** button shows which expected serials haven't been scanned yet, plus any unexpected scans (not in stock, not a serial, or scanned twice). Filter by category, sort, expand or collapse each item, search, copy the list, or download it as a spreadsheet. It updates as each item is scanned, without losing your place in the list.", "**Divination**: its icon now shows in its panel.", "Aethernet is now available store by store. If your store doesn't have access yet, you'll see a notice instead, and nothing else loads until it's added.", "**Swiftcast** won't create cleanings while the store is closed (after **Close store** in Portal). Open the store first.", "**Bountiful Yield** now works on RMA orders too: **Add all RMA parts** in the Add RMA parts popout. It stops if the RMA's line limit is reached."], "date": "2026-09-30T22:37:40Z"}, {"version": "2.15.0", "notes": ["New: **Send feedback**. Report a bug or suggest something straight from Portal: avatar menu \u2192 **Send Aethernet feedback**, or the link at the bottom of Settings. Bug reports can include technical details to help track the problem down (never customer details).", "Suggestions that get built are credited here in the patch notes."], "date": "2026-09-30T05:45:13Z"}, {"version": "2.14.1", "notes": ["Auto-Waymark: if a work order's nickname already has a date in it (like \"PS5 SLIM (10/01)\"), that date becomes its Auto-Waymark date. Otherwise it's 3 days after it reached Ready for pickup, as before.", "Fixed: work orders already at Ready for pickup when 2.14.0 arrived were dated from their last update instead of the date in their nickname. Their Auto-Waymarks have been corrected."], "date": "2026-09-30T00:47:16Z"}, {"version": "2.14.0", "notes": ["New in Waymark: **Auto-Waymark**. When a work order reaches Ready for pickup, it gets a follow-up date 3 days out, added after end of day (7 PM), next to the customer's name.", "While a work order is at Ready for pickup, its **device nickname is just the Auto-Waymark date** (e.g. 10/02) and stays in step with it: pushing the date rewrites the nickname, and typing a later date into the nickname moves the Auto-Waymark to match.", "Auto-Waymarks turn amber on the day and red once overdue. **Right-click** one to push it later (+1 day, +3 days, +1 week or a date you pick); **\u00d7** removes it for good.", "The Waymark icon shows a count of Auto-Waymarks due today (or overdue). Managers get a heads-up from the icon on their first Portal load of the day when any were left open past their due date.", "The Waymark board has a new **Auto-Waymark** tab listing them as Overdue, Due today and Upcoming."], "date": "2026-09-30T00:37:49Z"}, {"version": "2.13.0", "notes": ["New crystal: **Waymark** (work-order tags). Tag work orders for the whole store from **+ Tag** next to the customer's name, and see open work orders grouped by tag from the Waymark button in the header.", "Each store has its own tag list with colours, set in Settings \u2192 Waymark by store managers, district managers and franchise owners. Anyone can add one-off tags.", "Every tag change is logged on the work order (not as a Portal note). Tags and their history clear 7 days after a work order closes."], "date": "2026-09-29T23:53:08Z"}, {"version": "2.12.0", "notes": ["Aethernet is now about 40% smaller, and its daily update check downloads about 1 KB instead of the whole script.", "The installed file is minified. **About** links to the readable source (the same build, unminified).", "Fixed: in the first few minutes after a release, **Update** could open the previous version. New versions are now offered once they're fully out."], "date": "2026-09-29T23:28:58Z"}, {"version": "2.11.0", "notes": ["New: **Check for updates** at the bottom of Settings. If there's a newer version, one click opens Tampermonkey's Update page.", "When a new version is out, an **update available** pill appears within about 15 minutes, with an **Update** button.", "New: **Aethernet notices**. When the team knows about a problem, a banner under Portal's header says what's wrong and that it's being worked on. Affected crystals are marked in Settings.", "If a crystal is misbehaving, the team can pause it everywhere until it's fixed; the banner says which ones are paused."], "date": "2026-09-29T19:10:53Z"}, {"version": "2.10.0", "notes": ["New: **Patch notes**. Open them from the bottom of Settings; every release gets its own panel with the date and time it went out.", "The **Aethernet has updated!** pill now opens these patch notes (Settings stays open underneath)."], "date": "2026-09-29T16:18:34Z"}, {"version": "2.9.1", "date": "2026-09-29T15:38:03Z", "notes": ["**Macrocosmos**: the button wears the hotbar macro gear and shows its macro name, **GD Exception**, on hover.", "The first time the Macrocosmos button appears, a short explainer points at it, with a link straight to its settings.", "Settings can now open straight to one crystal with its settings expanded."]}, {"version": "2.9.0", "date": "2026-09-29T15:26:27Z", "notes": ["Every crystal now shows its FINAL FANTASY XIV action icon in Settings and About.", "The Galaxy Diagnostics pill is now the **Macrocosmos** icon itself, like a hotbar slot: click to file, drag to move."]}, {"version": "2.8.2", "date": "2026-09-28T15:42:48Z", "notes": ["**Glamour** now switches Portal's own light/dark theme, so theme-specific images (Inventory icons, the Reports banner) match your theme."]}, {"version": "2.8.1", "date": "2026-09-28T15:35:53Z", "notes": ["**Glamour**: dark themes put Portal in dark mode, so the ubreakifix logo turns white. Your own Portal mode comes back when you pick the Portal theme.", "Portal is now written as a proper noun everywhere."]}, {"version": "2.8.0", "date": "2026-09-28T15:28:00Z", "notes": ["New crystal: **Glamour** (page theming). Pick a preset (Limsa Lominsa, Gridania, Crystarium, Ul'dah, Ishgard, The Void) or make your own from a background, text and accent colour. Previews live; Cancel puts yours back."]}, {"version": "2.7.0", "date": "2026-09-28T14:41:31Z", "notes": ["Crystals are now named after FFXIV actions: Divination, Esuna, Recitation, Swiftcast, Macrocosmos, Bountiful Yield and Quick Synthesis.", "An **Aethernet has updated!** pill appears once after each update.", "New crystals get a yellow sheen in Settings until you've seen them.", "Each crystal's settings now sit under it in the Crystals list."]}, {"version": "2.6.0", "date": "2026-09-26T22:11:30Z", "notes": ["Settings sections collapse, and remember which ones you left open.", "New subtitle: Restoring the *flow* of NextGen.", "New **About** window: version, build time, author, your setup, and the install link to share with another store.", "The Aethernet name in titles uses its own wordmark."]}, {"version": "2.5.0", "date": "2026-09-26T21:35:43Z", "notes": ["New crystal: **Buyback add-all** (now Bountiful Yield). Adds every Apple (TLC) or Samsung/Google (UROC) part in a buyback order's Add buyback parts popout.", "Fixed: its buttons no longer need the script removed and re-added before each buyback."]}, {"version": "2.4.0", "date": "2026-09-26T21:30:09Z", "notes": ["Aethernet's tools are now called **crystals**. Your on/off switches carry over."]}, {"version": "2.3.2", "date": "2026-09-26T21:07:05Z", "notes": ["**Text \u2192 WO note** now works in every browser, including Firefox and Zen: it spots sent texts from the browser's own network log."]}, {"version": "2.3.1", "date": "2026-09-26T20:56:36Z", "notes": ["Attempted fix for **Text \u2192 WO note** on Firefox and Zen (finished in 2.3.2)."]}, {"version": "2.3.0", "date": "2026-09-26T20:52:51Z", "notes": ["New crystal: **Text \u2192 WO note** (now Recitation). Texting a customer from a WO adds a note: \"<you> sent a text message to <customer>.\" followed by the message."]}, {"version": "2.2.0", "date": "2026-09-26T20:42:10Z", "notes": ["New crystal: **WO cleanings pill** (now Esuna). On a work order, shows whether the device has cleanings available or done, with Create for available ones.", "Pending cleanings in the cleaning-rate list get a \u26a1 to create them, behind a confirmation."]}, {"version": "2.1.1", "date": "2026-09-26T20:30:12Z", "notes": ["Aethernet now installs from a link and updates itself."]}, {"version": "2.1.0", "date": "2026-09-26T20:29:50Z", "notes": ["The cleaning rate counts cleanings still waiting in Arrivals, shown as dashed chips.", "The cleaning list shows each customer's name instead of the device nickname."]}, {"version": "2.0.0", "date": "2026-09-26T19:37:00Z", "notes": ["First Aethernet release: one install bundling the cleaning auto-close \u26a1, the live cleaning rate badge, the Galaxy Diagnostics exception button and Print all labels, with a Settings menu in Portal's avatar menu."]}];
  const verTuple = (v) => String(v || '0').split('.').map(Number);
  const newer = (a, b) => { const x = verTuple(a), y = verTuple(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
  const noteHtml = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>');
  const HEART = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.8 4.5c2.1 0 3.6 1.2 4.4 2.5.8-1.3 2.3-2.5 4.4-2.5 3.8 0 5.9 3.9 4.4 7.3C19.5 16.4 12 21 12 21z"/></svg>';
  const flair = (text) => h('div', { class: 'sg-flair' }, h('span', { class: 'ic', html: HEART }), h('span', { html: noteHtml(text) }));
  function openPatchNotes(since) {
    if (false) return; // no patch notes in the demo build
    AE.ensureCss();
    if (!document.getElementById('sg-settings-css')) document.head.append(h('style', { id: 'sg-settings-css' }, MODAL_CSS));
    document.getElementById('sg-notes')?.remove();
    const CHEV_SVG = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>';
    const panels = PATCH_NOTES.map((n, i) => {
      const d = n.date ? new Date(n.date) : null;
      const when = d && !isNaN(d) ? d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Not released yet';
      const isNew = since && newer(n.version, since);
      const panel = h('details', { class: 'sg-patch' },
        h('summary', null, h('span', { html: CHEV_SVG }), h('span', { class: 'ver' }, 'v' + n.version),
          n.version === AE_VERSION ? h('span', { class: 'tag' }, 'Installed') : null,
          isNew ? h('span', { class: 'tag new' }, 'New') : null,
          (n.thanks || []).length || (n.credits || []).length ? h('span', { class: 'tag thanks', title: 'This version thanks someone' }, '♥ Thanks') : null,
          h('span', { class: 'when' }, when)),
        h('ul', null, n.notes.map((t) => h('li', { html: noteHtml(t) }))),
        // Attributions get a flair: "thanks" (free text, **bold** works) and "credits" (who suggested what shipped).
        (n.thanks || []).map((t) => flair('Thank you to ' + t)),
        n.credits && n.credits.length ? flair('Suggested by ' + n.credits.map((c) => '**' + c + '**').join(', ') + '. Thank you!') : null);
      panel.open = since ? isNew : i === 0;
      return panel;
    });
    const card = h('div', { class: 'sg sg-card sg-notes', role: 'dialog', 'aria-modal': 'true', 'aria-label': AE_NAME + ' patch notes' },
      h('div', { class: 'head' },
        h('span', { style: 'color:var(--aui-primary,#8223d2);line-height:0', html: icon('aetheryte', 28) }),
        h('h2', null, 'Patch notes'),
        h('button', { class: 'sg-x', title: 'Close', onclick: () => close() }, '✕')),
      h('div', { class: 'list' }, panels));
    const scrim = h('div', { class: 'sg sg-about-scrim', id: 'sg-notes', onclick: (e) => { if (e.target === scrim) close(); } }, card);
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    function close() { scrim.remove(); document.removeEventListener('keydown', onKey, true); }
    document.addEventListener('keydown', onKey, true); // capture: Esc closes the notes, not Settings
    document.body.appendChild(scrim);
  }

  // open('galaxy') opens straight to that crystal, with its settings expanded.
  function open(focus) {
    if (typeof focus !== 'string') focus = null; // menu commands pass an event
    AE.ensureCss();
    if (!document.getElementById('sg-settings-css')) document.head.append(h('style', { id: 'sg-settings-css' }, MODAL_CSS));
    document.getElementById('sg-settings')?.remove();
    AE.track('settings:open');
    const s = AE.merge(AE.DEFAULTS, AE.settings); // working copy
    let saveBtn = null;

    const input = (label, value, placeholder, onInput, type = 'text') =>
      h('label', { class: 'sg-field' }, h('span', null, label),
        h('input', { type, value: value ?? '', placeholder: placeholder || '', oninput: (e) => onInput(e.target.value) }));
    const toggle = (checked, onChange) => h('label', { class: 'sg-switch' },
      h('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) }), h('i'));

    // Collapsible section. Open/closed is remembered per browser (a viewer
    // preference, not a setting — it isn't part of Save).
    const SECTIONS_KEY = 'ae_settings_sections';
    const openState = GM_getValue(SECTIONS_KEY, {});
    if (focus) { openState.crystals = true; openState['opt_' + focus] = true; }
    const sums = [];
    const section = (id, title, defaultOpen, summary, ...kids) => {
      const isOpen = id in openState ? openState[id] : defaultOpen;
      const sum = h('span', { class: 'sum' });
      const head = h('button', { type: 'button', class: 'sg-sec-head', 'aria-expanded': String(isOpen) },
        h('span', { html: '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>' }), title, sum);
      const wrap = h('div', { class: 'sg-sec' + (isOpen ? '' : ' closed') }, head, h('div', { class: 'sg-sec-body' }, h('div', null, ...kids)));
      const paintSum = () => { sum.textContent = summary && wrap.classList.contains('closed') ? summary() : ''; };
      head.onclick = () => {
        const nowOpen = wrap.classList.toggle('closed') === false;
        head.setAttribute('aria-expanded', String(nowOpen));
        openState[id] = nowOpen;
        GM_setValue(SECTIONS_KEY, openState);
        paintSum();
      };
      sums.push(paintSum);
      paintSum();
      return wrap;
    };
    const repaintSums = () => sums.forEach((f) => f());

    const who = h('dl', { class: 'sg-kv' }, h('dt', null, 'Loading…'));
    const galaxyAuto = { technicianName: '', email: '', location: '' };
    const galaxyInputs = {};

    // Each crystal's own settings, shown nested under it.
    const OPTIONS = {
      cleaningRate: [() => 'Target ' + s.cleaningRate.target + '%',
        input('Target %', s.cleaningRate.target, '75', (v) => { s.cleaningRate.target = Number(v) || AE.DEFAULTS.cleaningRate.target; repaintSums(); }, 'number')],
      glamour: [() => AE.glamour.summary(s.glamour), AE.glamour.editor(s, () => repaintSums())],
      autoClose: [() => (s.autoClose.dualcast !== false ? 'Dualcast on' : 'Dualcast off') + ((s.autoClose.refreshLabor ?? AE_REFRESH_LABOR_DEFAULT) ? ' · refresh labor on' : ''),
        h('div', { class: 'sg-row', style: 'margin:8px 0' },
          h('div', null, h('b', { style: 'display:inline-flex;align-items:center;gap:6px' }, h('span', { html: AE.actionIcon('dualcast', 20), style: 'line-height:0' }), 'Dualcast'),
            h('span', { class: 'sg-soft', style: 'display:block' }, 'When a device has two or more cleanings waiting, one button creates them all, one after the other. Shown in the arrival' +
              (false ? ' and in Divination\'s panel.' : ', in Esuna\'s list and in Divination\'s panel.'))),
          toggle(s.autoClose.dualcast !== false, (v) => { s.autoClose.dualcast = v; repaintSums(); })),
        h('div', { class: 'sg-row', style: 'margin:8px 0' },
          h('div', null, h('b', { style: 'display:inline-flex;align-items:center;gap:6px' }, 'Refresh labor (10156)', h('span', { class: 'sg-exp-tag' }, 'Experimental')),
            h('span', { class: 'sg-soft', style: 'display:block' }, 'Adds the refresh labor SKU 10156 to VZ Device Refresh cleanings, for commission. Still being tested and may not work yet: if it can\'t be added, the cleaning is completed without it. Off until it\'s verified.')),
          toggle(!!(s.autoClose.refreshLabor ?? AE_REFRESH_LABOR_DEFAULT), (v) => { s.autoClose.refreshLabor = v; repaintSums(); }))],
      ...(false ? {} : { // not in the demo build
        galaxy: [() => ['technicianName', 'email', 'location'].some((k) => s.galaxy[k]) ? 'Overrides set' : 'Using your login',
          h('div', { class: 'sg-soft', style: 'margin-top:8px' }, 'Leave blank to use your login. Only fill in to override.'),
          (galaxyInputs.technicianName = input('Technician name', s.galaxy.technicianName, '', (v) => { s.galaxy.technicianName = v.trim(); repaintSums(); })),
          (galaxyInputs.email = input('Your email', s.galaxy.email, '', (v) => { s.galaxy.email = v.trim(); repaintSums(); })),
          (galaxyInputs.location = input('UBIF location (as shown in the form)', s.galaxy.location, '', (v) => { s.galaxy.location = v.trim(); repaintSums(); })),
          input('Store email (optional)', s.galaxy.storeEmail, 'Left blank', (v) => { s.galaxy.storeEmail = v.trim(); }),
          input('Tool version', s.galaxy.toolVersion, 'Latest', (v) => { s.galaxy.toolVersion = v.trim() || 'Latest'; }),
          input('Description', s.galaxy.description, 'ER', (v) => { s.galaxy.description = v; }),
          h('button', { class: 'sg-btn', style: 'margin:4px 0', onclick: (e) => { GM_deleteValue('gde_btn_pos'); e.target.textContent = 'Button position reset'; } }, 'Reset button position')],
        waymark: [() => AE.waymark.summary(), AE.waymark.editor()],
        fixes: [() => AE.fixesInfo.filter(([id]) => s.fixes[id] !== false).length + ' of ' + AE.fixesInfo.length + ' on',
          ...AE.fixesInfo.flatMap(([id, name, desc, extra]) => [h('div', { class: 'sg-row', style: 'margin:8px 0' },
            h('div', null, h('b', null, name), h('span', { class: 'sg-soft', style: 'display:block' }, desc)),
            toggle(s.fixes[id] !== false, (v) => { s.fixes[id] = v; repaintSums(); })),
            extra ? extra(s, h) : null])],
        printLabels: [() => s.printLabels.delayMs + ' ms between labels',
          input('Delay between labels (ms)', s.printLabels.delayMs, '900', (v) => { s.printLabels.delayMs = Math.max(200, Number(v) || 900); repaintSums(); }, 'number')],
      }),
    };
    // A live Aethernet notice about this crystal (status.json): say so on its row.
    const issueTag = (id) => {
      const inc = AE.status.incident();
      if (!inc) return null;
      if (inc.pause.includes(id)) return h('span', { class: 'sg-issue-tag paused', title: inc.title }, 'Paused');
      if (inc.crystals.includes(id)) return h('span', { class: 'sg-issue-tag ' + inc.severity, title: inc.title }, 'Known issue');
      return null;
    };
    const CHEV = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>';
    const crystalRow = (id, name, desc) => {
      const fresh = isNew(id), upd = !fresh && isUpdated(id);
      let optToggle = null, optBody = null;
      if (OPTIONS[id]) {
        const [summary, ...kids] = OPTIONS[id];
        const key = 'opt_' + id;
        let isOpen = !!openState[key];
        const sum = h('span', { class: 'sum' });
        optToggle = h('button', { type: 'button', class: 'sg-opt-toggle', 'aria-expanded': String(isOpen), html: CHEV }, 'Settings', sum);
        optBody = h('div', { class: 'sg-opts' + (isOpen ? '' : ' closed') }, h('div', null, h('div', null, ...kids)));
        const paintSum = () => { sum.textContent = isOpen ? '' : '· ' + summary(); };
        optToggle.onclick = () => {
          isOpen = !isOpen;
          optBody.classList.toggle('closed', !isOpen);
          optToggle.setAttribute('aria-expanded', String(isOpen));
          openState[key] = isOpen;
          GM_setValue(SECTIONS_KEY, openState);
          paintSum();
        };
        sums.push(paintSum);
        paintSum();
      }
      return h('div', { class: 'sg-crystal' + (fresh ? ' sg-new' : upd ? ' sg-upd' : ''), 'data-crystal': id },
        h('div', { class: 'sg-row' },
          h('div', null, h('b', { class: 'sg-cname' }, h('span', { class: 'sg-cicon', html: AE.actionIcon(id, 24) }), name, fresh ? h('span', { class: 'sg-new-tag' }, 'New') : upd ? h('span', { class: 'sg-new-tag upd' }, 'Updated') : null,
              issueTag(id)),
            h('span', { class: 'sg-soft' }, desc), optToggle ? h('div', null, optToggle) : null),
          toggle(!!s.crystals[id], (v) => { s.crystals[id] = v; repaintSums(); })),
        optBody);
    };

    const sheet = h('div', { class: 'sg sg-card sg-sheet', role: 'dialog', 'aria-label': AE_NAME + ' settings' },
      h('div', { style: 'display:flex;align-items:center;gap:12px' },
        // Hidden way in: ten quick clicks on the crystal open the admin panel (key entry first time).
        h('span', { style: 'color:var(--aui-primary,#8223d2);cursor:default;user-select:none', html: icon('aetheryte', 36), onclick: false ? null : (() => {
          let n = 0, last = 0;
          return () => { const t = Date.now(); n = t - last < 1500 ? n + 1 : 1; last = t; if (n >= 10) { n = 0; AE.feedback && AE.feedback.openAdmin(); } };
        })() }),
        h('div', { style: 'flex:1' }, h('h2', { class: 'sg-wordmark', html: AE.wordmark(26) }), h('div', { class: 'sg-soft', html: 'Restoring the <span class="sg-flow">flow</span> of NextGen · v' + AE_VERSION })),
        h('button', { class: 'sg-x', title: 'Close', onclick: () => close() }, '✕')),

      section('who', 'Signed in as', true, () => who.querySelector('dd') ? who.querySelector('dd').textContent : '',
        who,
        h('div', { class: 'sg-soft', style: 'margin-top:6px' }, 'Pulled from your portal login. Crystals use these automatically.'),
        false ? null : h('div', { class: 'sg-soft', style: 'margin-top:6px' }, AE_NAME + ' records which features you use (a count per feature per day, with your name and store) to decide what to improve. It never records customer details or what\'s on the page.')),

      section('crystals', 'Crystals', true,
        () => CRYSTAL_INFO.filter(([id]) => s.crystals[id]).length + ' of ' + CRYSTAL_INFO.length + ' on',
        h('div', null, CRYSTAL_INFO.map(([id, name, desc]) => crystalRow(id, name, desc)))),

      h('div', { class: 'sg-foot-links' },
        false ? null : h('button', { type: 'button', class: 'sg-about-link', onclick: () => AE.feedback.openFeedback() }, 'Send feedback'),
        false ? null : h('button', { type: 'button', class: 'sg-about-link', onclick: () => AE.status.checkNow() }, 'Check for updates'),
        false ? null : h('button', { type: 'button', class: 'sg-about-link', onclick: () => openPatchNotes() }, 'Patch notes'),
        h('button', { type: 'button', class: 'sg-about-link', onclick: openAbout }, 'About ' + AE_NAME + '…')),

      h('div', { class: 'sg-sheet-foot' },
        h('button', { class: 'sg-btn sg-lg', onclick: () => close() }, 'Cancel'),
        (saveBtn = h('button', { class: 'sg-btn sg-lg sg-primary', onclick: () => { AE.saveSettings(s); close(true); location.reload(); } }, 'Save & reload'))));

    const scrim = h('div', { class: 'sg sg-scrim', id: 'sg-settings', onclick: (e) => { if (e.target === scrim) close(); } }, sheet);
    // Every way out ends the "new" sheen: the crystals have now been seen.
    // Save & reload animates while the working copy differs from what's saved (checked after
    // anything in the sheet changes; editors that fill in defaults do so before the baseline).
    const baseline = JSON.stringify(s);
    const checkPending = () => {
      const pending = JSON.stringify(s) !== baseline;
      saveBtn.classList.toggle('sg-pending', pending);
      saveBtn.title = pending ? 'You have changes to save' : '';
    };
    ['input', 'change', 'click'].forEach((t) => sheet.addEventListener(t, () => setTimeout(checkPending, 0)));
    const pendingTimer = setInterval(checkPending, 1000); // async edits (e.g. a login picture being prepared)
    function close(saving) {
      clearInterval(pendingTimer);
      scrim.remove(); document.removeEventListener('keydown', onKey); markAllSeen();
      // Glamour previews live; closing without saving puts the saved theme back.
      if (!saving) AE.glamour.apply(AE.settings.crystals.glamour ? AE.settings.glamour : null);
    }
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.body.appendChild(scrim);
    document.addEventListener('keydown', onKey);
    document.getElementById('sg-update-pill')?.remove();
    if (focus) requestAnimationFrame(() => sheet.querySelector('[data-crystal="' + focus + '"]')?.scrollIntoView({ block: 'start', behavior: 'smooth' }));

    AE.profile().then((p) => {
      const loc = p.storeId ? p.storeId + ' ' + p.storeName : '';
      who.replaceChildren(
        h('dt', null, 'Name'), h('dd', null, p.name || '—'),
        h('dt', null, 'Email'), h('dd', null, p.email || '—'),
        h('dt', null, 'Store'), h('dd', null, loc || '—'));
      galaxyAuto.technicianName = p.name; galaxyAuto.email = p.email; galaxyAuto.location = loc;
      for (const k of Object.keys(galaxyAuto)) if (galaxyInputs[k]) galaxyInputs[k].querySelector('input').placeholder = 'Auto: ' + (galaxyAuto[k] || '—');
      repaintSums();
    }).catch((e) => { who.replaceChildren(h('dt', null, 'Error'), h('dd', null, esc(e.message))); });
  }

  // Add our item to the avatar menu whenever Portal renders it.
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
      // close Portal's menu the way a user would, then open ours
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      open();
    });
    logout.parentElement.insertBefore(item, logout);
  });

  function showUpdatedPill(fromVersion) {
    document.getElementById('sg-update-pill')?.remove();
    AE.ensureCss();
    if (!document.getElementById('sg-settings-css')) document.head.append(h('style', { id: 'sg-settings-css' }, MODAL_CSS));
    const x = h('span', { class: 'x', role: 'button', 'aria-label': 'Dismiss', title: 'Dismiss' }, '✕',
      h('span', { html: '<svg class="ring" viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="11"/></svg>', style: 'display:contents' }));
    const pill = h('button', { type: 'button', class: 'sg sg-update-pill', id: 'sg-update-pill', title: "See what's new" },
      h('span', { html: icon('aetheryte', 20) }), AE_NAME + ' has updated!', h('span', { class: 'ver' }, 'v' + AE_VERSION), x);
    // Settings opens underneath (that's where new crystals are marked), with the patch notes on top.
    pill.onclick = (e) => { pill.remove(); if (!x.contains(e.target)) { open(); openPatchNotes(fromVersion || AE_VERSION); } };
    // Gone by itself after 10 s, in step with the ring; hovering pauses both.
    let left = 10000, since = Date.now(), timer = setTimeout(() => pill.remove(), left);
    pill.addEventListener('mouseenter', () => { clearTimeout(timer); left -= Date.now() - since; });
    pill.addEventListener('mouseleave', () => { since = Date.now(); timer = setTimeout(() => pill.remove(), Math.max(0, left)); });
    document.body.appendChild(pill);
  }
  if (updated && !false) showUpdatedPill(lastVersion); // it opens the patch notes, which the demo build doesn't have
  AE.hooks.updatedPill = showUpdatedPill; // dev tools
  AE.hooks.patchVersions = PATCH_NOTES.map((n) => n.version);

  if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand(AE_NAME + ' settings', open);
  AE.openSettings = open;
  AE.openPatchNotes = openPatchNotes;
})();

// ===== 06-feedback.js =====
/*
  Feedback + usage + admin.

  - "Send feedback" (avatar menu, Settings, Tampermonkey menu): a bug report
    or a suggestion, sent to the Aethernet API (same Worker as Waymark). Bug
    reports can include technical details: version, browser, the page's path,
    which crystals are on, and the last few Aethernet errors. Never customer
    details. Submit-and-done; suggestions that get built are credited in the
    patch notes.
  - Usage: AE.track() counts (core) are sent here every 5 minutes, named per
    person, per store, per feature, per day. Disclosed in Settings and About.
  - Admin (Garrett): an inbox of reports with his own status/notes, and
    usage by feature, person and store. No visible way in: ten quick clicks
    on the crystal in the Settings header open it (asking for the key the
    first time). Reading needs the ADMIN_KEY secret, kept in this browser
    only; it never ships in the script, so other users can't read any of it
    even with the public app key.
  - Patch notes mention the feedback button and credits, never the admin
    panel or usage analytics (Garrett's call).
*/
AE.feedback = (() => {
  if (!AE_ON_PORTAL) return null;
  const { h, icon } = AE;
  const API = 'https://aethernet-waymark.ubifaethernet.workers.dev';
  const KEY = 'ae_QFa2DKDy0DrlBd_A3bfZL3BtgM51idh6';
  const ADMIN_KEY_GM = 'ae_admin_key';
  const configured = () => !AE_SANDBOX && /^(https:\/\/|http:\/\/localhost[:/])/.test(API); // off in the sandbox: fake data stays local

  async function call(method, path, body, adminKey) {
    if (!configured()) throw new Error('The Aethernet service isn\'t set up');
    const headers = { 'content-type': 'application/json', 'x-aethernet-key': KEY };
    if (adminKey) headers['x-aethernet-admin'] = adminKey;
    const res = await fetch(API + path, { method, headers, credentials: 'omit', keepalive: !!body && JSON.stringify(body).length < 60000, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status);
    return j;
  }
  const me = async () => { const p = await AE.profile(); if (!p.storeId) throw new Error('No current store'); return p; };
  const browserName = () => { const ua = navigator.userAgent; return /Zen\//.test(ua) ? 'Zen' : /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : 'Other'; };

  // ------------------------------------------------------------ usage upload
  async function flushUsage() {
    const pend = GM_getValue(AE.USAGE_KEY, {});
    const days = Object.keys(pend);
    if (!days.length || !configured()) return;
    const p = await me();
    for (const day of days) {
      await call('POST', '/v1/' + p.storeId + '/usage', { day, counts: pend[day], by: p.name, byId: p.userId, storeName: p.storeName });
      // Re-read before deleting: counts added while sending stay for next time.
      const now = GM_getValue(AE.USAGE_KEY, {});
      for (const [f, n] of Object.entries(pend[day])) { if (now[day]) { now[day][f] -= n; if (now[day][f] <= 0) delete now[day][f]; } }
      if (now[day] && !Object.keys(now[day]).length) delete now[day];
      GM_setValue(AE.USAGE_KEY, now);
    }
  }
  setTimeout(() => {
    const go = () => flushUsage().catch((e) => console.warn('[' + AE_NAME + '] usage upload:', e.message || e));
    go();
    setInterval(go, 5 * 60 * 1000);
  }, 30000);

  // ------------------------------------------------------------ CSS
  const CSS = `
  .sg-fb { width:min(520px, 100%); max-height:calc(100vh - 32px); overflow:auto; padding:22px 20px 16px; font-size:14px; line-height:1.45; }
  .sg-fb .head { display:flex; align-items:center; gap:10px; margin-bottom:12px; }
  .sg-fb .head h2 { flex:1; margin:0; font-size:20px; font-weight:700; }
  .sg-fb .kinds { display:flex; gap:8px; margin-bottom:12px; }
  .sg-fb .kinds button { flex:1; height:40px; border:1px solid var(--aui-outline, #c6c6ca); border-radius:10px; background:none; cursor:pointer;
    color:var(--aui-on-surface, #1a1c1e); font:600 14px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; }
  .sg-fb .kinds button.on { border:2px solid var(--aui-primary, #8223d2); background:var(--aui-primary-soft, #faecff); color:var(--aui-on-primary-soft, #590099); }
  .sg-fb textarea { width:100%; min-height:130px; padding:10px 12px; border:1px solid var(--aui-outline, #c6c6ca); border-radius:10px; resize:vertical; box-sizing:border-box;
    background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e); font:14px/1.45 Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; }
  .sg-fb textarea:focus { outline:2px solid var(--aui-primary, #8223d2); outline-offset:-1px; border-color:transparent; }
  .sg-fb label.chk { display:flex; gap:8px; align-items:flex-start; margin:10px 0 4px; font-size:13px; cursor:pointer; }
  .sg-fb details { font-size:12px; color:var(--aui-on-surface-soft, #5d5e61); }
  .sg-fb pre { white-space:pre-wrap; overflow-wrap:anywhere; background:var(--aui-surface-variant, #faf9fc); border:1px solid var(--aui-outline-soft, #eeedf1); border-radius:8px; padding:8px; font:11px ui-monospace, Menlo, monospace; }
  .sg-fb .sg-actions { margin-top:14px; }
  .sg-adm { width:min(980px, 100%); height:min(760px, calc(100vh - 32px)); display:flex; flex-direction:column; padding:18px 20px 14px; font-size:14px; line-height:1.4; }
  .sg-adm .head { display:flex; align-items:center; gap:10px; margin-bottom:8px; }
  .sg-adm .head h2 { flex:1; margin:0; font-size:20px; font-weight:700; }
  .sg-adm .tabs { display:flex; gap:2px; border-bottom:1px solid var(--aui-outline-soft, #eeedf1); margin-bottom:10px; }
  .sg-adm .tab { padding:7px 12px 8px; border:0; border-bottom:2px solid transparent; margin-bottom:-1px; background:none; cursor:pointer; color:var(--aui-on-surface-soft, #5d5e61); font:600 14px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; }
  .sg-adm .tab.on { color:var(--aui-primary, #8223d2); border-bottom-color:var(--aui-primary, #8223d2); }
  .sg-adm .body { flex:1; overflow:auto; }
  .sg-adm .bar { display:flex; gap:6px; align-items:center; flex-wrap:wrap; margin-bottom:10px; }
  .sg-adm .bar select { height:32px; border:1px solid var(--aui-outline, #c6c6ca); border-radius:8px; background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e); }
  .sg-adm .rep { border:1px solid var(--aui-outline-soft, #eeedf1); border-radius:12px; padding:10px 12px; margin-bottom:8px; }
  .sg-adm .rep .top { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .sg-adm .rep .who { font-weight:600; }
  .sg-adm .rep .meta { flex:1; text-align:right; font-size:12px; color:var(--aui-on-surface-soft, #5d5e61); }
  .sg-adm .rep .txt { margin:6px 0; white-space:pre-wrap; overflow-wrap:anywhere; }
  .sg-adm .rep .ctl { display:flex; gap:6px; align-items:center; }
  .sg-adm .rep .ctl input { flex:1; min-width:0; height:30px; padding:0 8px; border:1px solid var(--aui-outline, #c6c6ca); border-radius:8px; background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e); }
  .sg-adm .kind { padding:1px 8px; border-radius:10000rem; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.03em; }
  .sg-adm .kind.bug { background:var(--aui-status-error-soft, #ffdad7); color:var(--aui-status-on-error-soft, #410004); }
  .sg-adm .kind.idea { background:var(--aui-primary-soft, #faecff); color:var(--aui-on-primary-soft, #590099); }
  .sg-adm .st { font-size:11px; font-weight:700; text-transform:uppercase; color:var(--aui-on-surface-soft, #5d5e61); }
  .sg-adm .grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(290px, 1fr)); gap:14px; }
  .sg-adm .card { border:1px solid var(--aui-outline-soft, #eeedf1); border-radius:12px; padding:10px 12px; }
  .sg-adm .card h3 { margin:0 0 8px; font-size:13px; font-weight:700; letter-spacing:.03em; text-transform:uppercase; color:var(--aui-on-surface-soft, #5d5e61); }
  .sg-adm .row { display:grid; grid-template-columns:minmax(0, 1.3fr) minmax(0, 1fr) auto; gap:8px; align-items:center; padding:3px 0; font-size:13px; }
  .sg-adm .row .name { display:flex; gap:6px; align-items:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .sg-adm .row .track { height:8px; border-radius:4px; background:var(--aui-neutral-soft, #f1f0f4); overflow:hidden; }
  .sg-adm .row .track i { display:block; height:100%; background:var(--aui-primary, #8223d2); border-radius:4px; }
  .sg-adm .row .n { font-variant-numeric:tabular-nums; color:var(--aui-on-surface-soft, #5d5e61); min-width:36px; text-align:right; }
  .sg-adm .sub { font-size:12px; color:var(--aui-on-surface-soft, #5d5e61); }
  .sg-adm .unlock { max-width:420px; margin:30px auto; }
  .sg-adm .unlock input { width:100%; height:38px; padding:0 10px; margin:8px 0; border:1px solid var(--aui-outline, #c6c6ca); border-radius:8px; box-sizing:border-box;
    background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e); font:13px ui-monospace, Menlo, monospace; }
  `;
  const ensureCss = () => { AE.ensureCss(); if (!document.getElementById('sg-fb-css')) document.head.append(h('style', { id: 'sg-fb-css' }, CSS)); };

  function modal(id, card, onClose) {
    document.getElementById(id)?.remove();
    const scrim = h('div', { class: 'sg sg-about-scrim', id, onclick: (e) => { if (e.target === scrim) close(); } }, card);
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    function close() { scrim.remove(); document.removeEventListener('keydown', onKey, true); onClose && onClose(); }
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(scrim);
    return close;
  }

  // ------------------------------------------------------------ Send feedback
  function diagnostics() {
    return {
      crystals: Object.entries(AE.settings.crystals).filter(([, on]) => on).map(([id]) => id),
      errors: AE.recentErrors.slice(-5),
      pageErrors: AE.pageErrors.slice(-5), // Portal's own script errors
      screen: innerWidth + 'x' + innerHeight,
      theme: document.body.classList.contains('asurion-dark') ? 'dark' : 'light',
    };
  }
  function openFeedback() {
    ensureCss();
    let kind = 'bug';
    const text = h('textarea', { maxlength: 4000, placeholder: 'What happened, and what did you expect? (Which work order or page, if it matters.)' });
    const include = h('input', { type: 'checkbox', checked: true });
    const setKind = (k) => {
      kind = k;
      card.querySelectorAll('.kinds button').forEach((b) => b.classList.toggle('on', b.dataset.k === k));
      text.placeholder = k === 'bug' ? 'What happened, and what did you expect? (Which work order or page, if it matters.)' : 'What would make Portal or Aethernet better for you?';
      detailsRow.style.display = k === 'bug' ? '' : 'none';
    };
    const preview = () => JSON.stringify({ version: AE_VERSION, browser: browserName(), page: location.pathname, ...diagnostics() }, null, 1);
    const pre = h('pre', null, preview());
    const detailsRow = h('div', null,
      h('label', { class: 'chk' }, include, h('span', null, 'Include technical details (version, browser, this page\'s address, which crystals are on, recent Aethernet errors). No customer details.')),
      h('details', null, h('summary', null, 'What gets sent'), pre));
    const send = h('button', { type: 'button', class: 'sg-btn sg-lg sg-primary', onclick: async () => {
      const t = text.value.trim();
      if (t.length < 3) { text.focus(); return; }
      send.disabled = true; send.textContent = 'Sending…';
      try {
        const p = await me();
        await call('POST', '/v1/' + p.storeId + '/feedback', {
          kind, text: t, version: AE_VERSION, browser: browserName(), page: location.pathname,
          diag: kind === 'bug' && include.checked ? diagnostics() : null, by: p.name, byId: p.userId, storeName: p.storeName,
        });
        AE.track('feedback:' + kind);
        close();
        AE.toast('Thanks!', kind === 'bug' ? 'Your bug report went to the Aethernet team.' : 'Your suggestion went to the Aethernet team. If it gets built, you\'ll be credited in the patch notes.', 'ok', 8000);
      } catch (e) {
        send.disabled = false; send.textContent = 'Send';
        AE.toast("Couldn't send", (e.message || e) + ' — try again in a minute.', 'err');
      }
    } }, 'Send');
    const card = h('div', { class: 'sg sg-card sg-fb', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Send feedback' },
      h('div', { class: 'head' }, h('span', { style: 'color:var(--aui-primary,#8223d2);line-height:0', html: icon('aetheryte', 28) }), h('h2', null, 'Send feedback'),
        h('button', { class: 'sg-x', title: 'Close', onclick: () => close() }, '✕')),
      h('div', { class: 'kinds' },
        h('button', { type: 'button', 'data-k': 'bug', class: 'on', onclick: () => setKind('bug') }, '🐞 Report a bug'),
        h('button', { type: 'button', 'data-k': 'idea', onclick: () => setKind('idea') }, '💡 Suggest something')),
      text, detailsRow,
      h('div', { class: 'sg-soft', style: 'margin-top:8px' }, 'Sent with your name and store so the team can follow up in person.'),
      h('div', { class: 'sg-actions' }, h('button', { type: 'button', class: 'sg-btn sg-lg', onclick: () => close() }, 'Cancel'), send));
    const close = modal('sg-feedback', card);
    text.focus();
  }

  // ------------------------------------------------------------ Admin
  const FEATURE_NAMES = () => Object.fromEntries(AE.crystals.map((c) => [c.id, c.name]));
  const featureLabel = (f) => {
    const [id, act] = f.split(':');
    const base = { active: 'Used Aethernet', feedback: 'Feedback', settings: 'Settings' }[id] || FEATURE_NAMES()[id] || id;
    return act ? base + ' · ' + act : base;
  };

  async function openAdmin() {
    ensureCss();
    let tab = 'reports', statusFilter = 'new', days = 30;
    const body = h('div', { class: 'body' });
    const tabs = h('div', { class: 'tabs', role: 'tablist' });
    const card = h('div', { class: 'sg sg-card sg-adm', role: 'dialog', 'aria-modal': 'true', 'aria-label': AE_NAME + ' admin' },
      h('div', { class: 'head' }, h('span', { style: 'color:var(--aui-primary,#8223d2);line-height:0', html: icon('aetheryte', 28) }), h('h2', null, AE_NAME + ' admin'),
        h('button', { class: 'sg-x', title: 'Close', onclick: () => close() }, '✕')),
      tabs, body);
    const close = modal('sg-admin', card);

    const key = () => GM_getValue(ADMIN_KEY_GM, '');
    function unlock(msg) {
      tabs.replaceChildren();
      const input = h('input', { type: 'password', placeholder: 'Admin key', autocomplete: 'off' });
      const go = h('button', { type: 'button', class: 'sg-btn sg-primary', onclick: async () => {
        go.disabled = true;
        try { await call('GET', '/v1/admin/ping', null, input.value.trim()); GM_setValue(ADMIN_KEY_GM, input.value.trim()); draw(); }
        catch (e) { go.disabled = false; unlock('That key didn\'t work (' + (e.message || e) + ').'); }
      } }, 'Unlock');
      body.replaceChildren(h('div', { class: 'unlock' },
        h('b', null, 'Admin key'),
        h('div', { class: 'sg-soft' }, 'Kept in this browser only. It is not part of the script, so nobody else can read reports or usage.'),
        input, go, msg ? h('div', { style: 'color:var(--aui-status-error,#b91a24);margin-top:8px' }, msg) : null));
      input.focus();
    }

    async function draw() {
      if (!key()) return unlock();
      tabs.replaceChildren(
        h('button', { type: 'button', class: 'tab' + (tab === 'reports' ? ' on' : ''), onclick: () => { tab = 'reports'; draw(); } }, 'Reports'),
        h('button', { type: 'button', class: 'tab' + (tab === 'usage' ? ' on' : ''), onclick: () => { tab = 'usage'; draw(); } }, 'Usage'),
        h('button', { type: 'button', class: 'tab' + (tab === 'stores' ? ' on' : ''), onclick: () => { tab = 'stores'; draw(); } }, 'Stores'));
      body.replaceChildren(h('div', { class: 'sg-soft' }, 'Loading…'));
      try { tab === 'reports' ? await drawReports() : tab === 'usage' ? await drawUsage() : await drawStores(); }
      catch (e) { if (/admin key/.test(e.message)) { GM_deleteValue(ADMIN_KEY_GM); unlock('The saved key was refused.'); } else body.replaceChildren(h('div', { class: 'sg-soft' }, "Couldn't load: " + (e.message || e))); }
    }

    async function drawReports() {
      const j = await call('GET', '/v1/admin/feedback?status=' + statusFilter, null, key());
      const c = j.counts || {};
      const sel = h('select', { onchange: (e) => { statusFilter = e.target.value; draw(); } },
        [['new', 'New'], ['planned', 'Planned'], ['fixed', 'Fixed'], ['wontfix', "Won't fix"], ['all', 'All']].map(([v, l]) => {
          const o = h('option', { value: v }, l + (v !== 'all' ? ' (' + (c[v] || 0) + ')' : '')); o.selected = v === statusFilter; return o;
        }));
      const when = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const rep = (r) => {
        const st = h('select', null, STATUS_OPTS.map(([v, l]) => { const o = h('option', { value: v }, l); o.selected = v === r.status; return o; }));
        const note = h('input', { type: 'text', value: r.note || '', placeholder: 'Your note (only you see this)' });
        const save = h('button', { type: 'button', class: 'sg-btn', onclick: async () => {
          save.disabled = true;
          try { await call('POST', '/v1/admin/feedback/' + r.id, { status: st.value, note: note.value }, key()); save.textContent = 'Saved'; setTimeout(() => { save.textContent = 'Save'; save.disabled = false; }, 1200); }
          catch (e) { save.disabled = false; AE.toast("Couldn't save", e.message || String(e), 'err'); }
        } }, 'Save');
        let diag = null;
        try { diag = r.diag ? JSON.parse(r.diag) : null; } catch (_) {}
        return h('div', { class: 'rep' },
          h('div', { class: 'top' }, h('span', { class: 'kind ' + r.kind }, r.kind === 'bug' ? 'Bug' : 'Idea'),
            h('span', { class: 'who' }, r.user_name || 'Someone'), h('span', { class: 'sub' }, (r.store_name || 'Store') + ' #' + r.store),
            h('span', { class: 'meta' }, when(r.created_at) + ' · v' + (r.version || '?') + ' · ' + (r.browser || '') + (r.page ? ' · ' + r.page : ''))),
          h('div', { class: 'txt' }, r.text),
          diag ? h('details', { class: 'sub' }, h('summary', null, 'Technical details' + (diag.errors && diag.errors.length ? ' · ' + diag.errors.length + ' recent error' + (diag.errors.length === 1 ? '' : 's') : '')),
            h('pre', { style: 'white-space:pre-wrap;font:11px ui-monospace,Menlo,monospace' }, JSON.stringify(diag, null, 1))) : null,
          h('div', { class: 'ctl' }, st, note, save));
      };
      body.replaceChildren(h('div', { class: 'bar' }, sel, h('span', { class: 'sub' }, 'Reporters don\'t see statuses or notes. Credit suggestions that ship in the patch notes.')),
        ...(j.feedback.length ? j.feedback.map(rep) : [h('div', { class: 'sub', style: 'padding:12px 0' }, 'Nothing here.')]));
    }
    const STATUS_OPTS = [['new', 'New'], ['planned', 'Planned'], ['fixed', 'Fixed'], ['wontfix', "Won't fix"]];

    /*
      Stores: which stores may use Aethernet. Add by number (looked up in
      Portal to confirm the name) or by name (matched against stores that
      have opened Portal with Aethernet: the Waiting list). Removing a store
      stops Aethernet there on its next page load; the Worker refuses its
      services to it within a minute.
    */
    async function drawStores() {
      const j = await call('GET', '/v1/admin/stores', null, key());
      const me = await AE.profile().catch(() => ({}));
      const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
      const out = h('div', { class: 'sub', style: 'margin:6px 0 0' });
      const grant = async (store, name) => {
        await call('POST', '/v1/admin/stores', { store: Number(store), name, by: me.name }, key());
        AE.toast('Store added', (name || 'Store') + ' (#' + store + ') can use ' + AE_NAME + ' from its next page load.', 'ok');
        draw();
      };
      const input = h('input', { type: 'text', placeholder: 'Store number or name', style: 'flex:1;min-width:0;height:32px;padding:0 10px;border:1px solid var(--aui-outline,#c6c6ca);border-radius:8px;background:var(--aui-surface,#fff);color:var(--aui-on-surface,#1a1c1e)' });
      async function add() {
        const v = input.value.trim();
        if (!v) return;
        out.textContent = 'Looking up…';
        try {
          if (/^\d{1,6}$/.test(v)) {
            // A number: confirm the store's name with Portal first.
            let st = null;
            try { st = await AE.api('GET', '/api/stores/' + v); } catch (_) { st = null; }
            if (!st || !st.storeId) { out.textContent = 'Portal has no store #' + v + '.'; return; }
            const label = st.storeName + ' (#' + st.storeId + (st.city ? ', ' + st.city + (st.state ? ', ' + st.state : '') : '') + ')';
            const ok = await AE.confirm({ title: 'Give this store access?', message: '<b>' + AE.esc(label) + '</b> will be able to use ' + AE.esc(AE_NAME) + '.', confirmLabel: 'Give access' });
            out.textContent = '';
            if (ok) await grant(st.storeId, st.storeName);
            return;
          }
          // A name: stores that have opened Portal with Aethernet, and ones already on the list.
          const q = v.toLowerCase();
          const matches = [...j.waiting, ...j.allowed.map((a) => Object.assign({ onList: true }, a))].filter((x) => (x.name || '').toLowerCase().includes(q));
          if (!matches.length) { out.textContent = 'No store named "' + v + '" has opened Portal with ' + AE_NAME + ' yet. Enter its store number instead, or wait for it to show under Waiting for access.'; return; }
          out.replaceChildren(...matches.map((x) => h('div', { style: 'display:flex;gap:8px;align-items:center;margin:4px 0' },
            h('span', { style: 'flex:1' }, (x.name || 'Store') + ' (#' + x.store + ')'),
            x.onList ? h('span', null, 'already has access') : h('button', { type: 'button', class: 'sg-btn sg-primary', onclick: () => grant(x.store, x.name) }, 'Give access'))));
        } catch (e) { out.textContent = "Couldn't add: " + (e.message || e); }
      }
      input.onkeydown = (e) => { if (e.key === 'Enter') add(); };
      const row = (cells, actions) => h('div', { class: 'rep', style: 'display:flex;gap:10px;align-items:center;padding:8px 12px' }, h('div', { style: 'flex:1;min-width:0' }, ...cells), actions);
      const allowed = j.allowed.map((a) => row([
        h('div', null, h('b', null, (a.name || 'Store') + ' (#' + a.store + ')'), a.store === me.storeId ? h('span', { class: 'sub' }, ' · this store') : null),
        h('div', { class: 'sub' }, 'Added ' + when(a.added_at) + (a.added_by ? ' by ' + a.added_by : '') + ' · last opened ' + when(a.last_at) + (a.loads ? ' · ' + a.loads + ' page load' + (a.loads === 1 ? '' : 's') : ''))],
        h('button', { type: 'button', class: 'sg-btn', onclick: async () => {
          const ok = await AE.confirm({ title: 'Remove access?', message: '<b>' + AE.esc((a.name || 'Store') + ' (#' + a.store + ')') + '</b> will lose ' + AE.esc(AE_NAME) + ' on its next page load.',
            warning: a.store === me.storeId ? 'This is the store you\'re signed into: ' + AE_NAME + ' (and this admin panel) will stop here too.' : null, confirmLabel: 'Remove' });
          if (!ok) return;
          await call('POST', '/v1/admin/stores/' + a.store + '/remove', {}, key());
          draw();
        } }, 'Remove')));
      const waiting = j.waiting.map((w) => row([
        h('div', null, h('b', null, (w.name || 'Store') + ' (#' + w.store + ')')),
        h('div', { class: 'sub' }, 'Tried ' + when(w.last_at) + (w.last_user ? ' (' + w.last_user + ')' : '') + ' · ' + w.loads + ' page load' + (w.loads === 1 ? '' : 's') + ' since ' + when(w.first_at))],
        h('button', { type: 'button', class: 'sg-btn sg-primary', onclick: () => grant(w.store, w.name) }, 'Give access')));
      body.replaceChildren(
        h('div', { class: 'bar' }, input, h('button', { type: 'button', class: 'sg-btn sg-primary', onclick: add }, 'Add store')), out,
        h('h3', { style: 'margin:14px 0 6px;font-size:13px;letter-spacing:.03em;text-transform:uppercase;color:var(--aui-on-surface-soft,#5d5e61)' }, 'Have access (' + j.allowed.length + ')'),
        ...(allowed.length ? allowed : [h('div', { class: 'sub' }, 'No stores yet.')]),
        h('h3', { style: 'margin:14px 0 6px;font-size:13px;letter-spacing:.03em;text-transform:uppercase;color:var(--aui-on-surface-soft,#5d5e61)' }, 'Waiting for access (' + j.waiting.length + ')'),
        ...(waiting.length ? waiting : [h('div', { class: 'sub' }, 'No other stores have opened Portal with ' + AE_NAME + '.')]));
    }

    async function drawUsage() {
      const j = await call('GET', '/v1/admin/usage?days=' + days, null, key());
      const rows = j.rows.filter((r) => !r.feature.startsWith('active')); // "active" is its own card
      const sum = (arr, keyFn) => { const m = new Map(); for (const r of arr) { const k = keyFn(r); m.set(k, (m.get(k) || 0) + r.count); } return [...m.entries()].sort((a, b) => b[1] - a[1]); };
      const people = new Map(j.rows.map((r) => [r.user_id, r.user_name + ' · ' + (r.store_name || r.store)]));
      const bars = (entries, label, limit = 12) => {
        const max = Math.max(1, ...entries.map((e) => e[1]));
        return entries.slice(0, limit).map(([k, n]) => h('div', { class: 'row' },
          h('div', { class: 'name', title: label(k) }, label(k)), h('div', { class: 'track' }, h('i', { style: 'width:' + Math.round((n / max) * 100) + '%' })), h('div', { class: 'n' }, n)));
      };
      const byCrystal = sum(rows, (r) => r.feature.split(':')[0]);
      const users = (f) => new Set(rows.filter((r) => r.feature.split(':')[0] === f).map((r) => r.user_id)).size;
      const activeDays = sum(j.rows.filter((r) => r.feature === 'active'), (r) => r.user_id);
      const stores = sum(rows, (r) => (r.store_name || '') + ' #' + r.store);
      const sel = h('select', { onchange: (e) => { days = Number(e.target.value); draw(); } }, [7, 30, 90, 180].map((d) => { const o = h('option', { value: d }, 'Last ' + d + ' days'); o.selected = d === days; return o; }));
      const cardEl = (title, ...kids) => h('div', { class: 'card' }, h('h3', null, title), ...kids);
      const empty = (x) => (x.length ? x : [h('div', { class: 'sub' }, 'No data yet.')]);
      body.replaceChildren(
        h('div', { class: 'bar' }, sel, h('span', { class: 'sub' }, activeDays.length + (activeDays.length === 1 ? ' person' : ' people') + ' used ' + AE_NAME + ' since ' + j.since + '. Counts are uses of each feature.')),
        h('div', { class: 'grid' },
          cardEl('By crystal', ...empty(byCrystal.map(([f, n]) => h('div', { class: 'row' },
            h('div', { class: 'name' }, h('span', { html: AE.actionIcon(f, 18) }), featureLabel(f)),
            h('div', { class: 'track' }, h('i', { style: 'width:' + Math.round((n / Math.max(1, byCrystal[0][1])) * 100) + '%' })),
            h('div', { class: 'n', title: users(f) + ' people' }, n))))),
          cardEl('By action', ...empty(bars(sum(rows, (r) => r.feature), featureLabel, 20))),
          cardEl('By person', ...empty(bars(sum(rows, (r) => r.user_id), (k) => people.get(k) || String(k))), h('div', { class: 'sub', style: 'margin-top:6px' }, 'All feature uses, per person.')),
          cardEl('Days active', ...empty(bars(activeDays, (k) => people.get(k) || String(k))), h('div', { class: 'sub', style: 'margin-top:6px' }, 'Days each person had Portal open with ' + AE_NAME + '.')),
          cardEl('By store', ...empty(bars(stores, (k) => k)))));
    }
    draw();
  }

  // ------------------------------------------------------------ entry points
  // Avatar menu: "Send Aethernet feedback", cloned like the Settings item.
  AE.every(400, () => {
    const settingsItem = document.querySelector('[data-testid="option-aethernet"]');
    if (!settingsItem || document.querySelector('[data-testid="option-aethernet-feedback"]')) return;
    const item = settingsItem.cloneNode(true);
    item.setAttribute('data-testid', 'option-aethernet-feedback');
    const label = item.querySelector('[data-aui="text"]') || item;
    label.textContent = 'Send ' + AE_NAME + ' feedback';
    item.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      openFeedback();
    });
    settingsItem.after(item);
  });
  if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('Send ' + AE_NAME + ' feedback', openFeedback);
  AE.trackDaily('active');

  return { openFeedback, openAdmin, flushUsage };
})();

// ===== 10-cleaning-rate.js =====
/*
  Divination (live cleaning rate) — header badge.

  Rate = cleanings linked to today's Asurion Mobility orders ÷ Asurion
  Mobility orders created today (local time). Each cleaning counts on its
  own, so it can pass 100%. Raw percentage only: reason notes are ignored.
  Cleanings link to orders by device IMEI (AT&T cleanings are often under a
  different customer record), falling back to customer ID without an IMEI.

  Pending cleanings count too: a cleaning arrival created today that hasn't
  been checked in yet (still in Arrivals) shows as "pending" and counts. Its
  ⚡ runs the cleaning auto-close (after a confirmation) when that crystal is on.
  See AE.data in core for how WOs and arrivals are fetched and matched.

  History (Reports page, /reporting/metrics): a "Cleaning rate history" card
  under Portal's KPIs — last 7 / 30 / 90 days, this month, last month — with
  the overall rate (all cleanings ÷ all AM orders in the range), days at
  target, a bar per day and a table. Each past day is worked out the same
  way as today (that day's AM orders, cleaning WOs created that day; pending
  arrivals only count for today) from Portal's own work-order lists, and
  cached in this browser per store (ae_rate_history): a finished day doesn't
  change, so only missing days and the last two are ever reloaded.
*/
AE.crystal({
  id: 'cleaningRate',
  name: 'Divination',
  sites: ['portal.ubreakifix.net'],
  run() {
    const { h, esc } = AE;
    const { nameOf } = AE.data;
    const TARGET = AE.settings.cleaningRate.target;
    const REFRESH_MS = 2 * 60 * 1000;
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
      #${PANEL_ID} { position:fixed; z-index:2147483646; width:460px; max-height:70vh; overflow:auto; padding:16px; font-size:14px; line-height:1.4; }
      #${PANEL_ID} table { width:100%; border-collapse:collapse; margin-top:10px; }
      #${PANEL_ID} td { padding:8px 4px; border-top:1px solid var(--aui-outline-soft,#eeedf1); vertical-align:top; }
      #${PANEL_ID} td:first-child { width:44%; }
      #${PANEL_ID} .who { font-weight:600; }
      #${PANEL_ID} a { color:var(--aui-primary,#8223d2); text-decoration:none; font-weight:600; }
      #${PANEL_ID} a:hover { text-decoration:underline; }
      #${PANEL_ID} .sg-soft a { font-weight:400; }
      #${PANEL_ID} .miss { color:var(--aui-status-error,#b91a24); font-weight:600; }
      #${PANEL_ID} .sg-cast-group { display:inline-flex; flex-wrap:wrap; justify-content:flex-end; align-items:center; gap:0; margin:0 0 4px 4px; padding:4px 4px 0 4px;
        border:1.5px dashed var(--aui-primary, #8223d2); border-radius:14px; }
      #${PANEL_ID} .sg-cast-group .sg-chip { margin:0 0 4px 4px; }
      #${PANEL_ID} .sg-cast-go { display:inline-flex; align-items:center; gap:5px; height:22px; margin:0 auto 4px 0; padding:0 9px 0 3px; border:0; border-radius:10000rem; cursor:pointer;
        background:var(--aui-primary, #8223d2); color:var(--aui-on-primary, #fff); font:700 12px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; }
      #${PANEL_ID} .sg-cast-go .b { display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px; border-radius:50%; background:rgba(255,255,255,.22); }
      #${PANEL_ID} .sg-cast-go:hover { filter:brightness(1.1); }
    `));

    async function compute() {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const startMs = start.getTime(), endMs = startMs + 86400000;
      const [wos, arrs] = await Promise.all([AE.data.workorders(startMs), AE.data.arrivals()]);
      const today = (r) => { const t = Date.parse(r.createdAt); return t >= startMs && t < endMs; };
      const parents = wos.filter((r) => r.programId === AE.PARENT_PROGRAM_ID && today(r)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      const cleanings = AE.data.cleanings(wos, arrs, today);
      const used = new Set();
      const rows = parents.map((p) => {
        const matched = cleanings.filter((c) => !used.has(c.key) && AE.data.belongs(c, p));
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
      if (hdr && hdr.scrollWidth > hdr.clientWidth) b.innerHTML = lead + (text ? '' : '<b>' + last.pct + '%</b>');
      b.title = (last && last.pct != null ? 'Cleanings ' + last.linked + '/' + last.parents + ' · ' + last.pct + '%' +
        (last.pending ? ' (' + last.pending + ' pending)' : '') + ' — ' : '') +
        (last ? 'updated ' + fmtTime(last.at) : 'Loading') + (lastError ? ' — last refresh failed: ' + lastError : '') +
        ' · target ' + TARGET + '%, ideally 100% · click for details';
    }

    // Chip for one cleaning. Pending ones link to the arrival and, with
    // auto-close on, carry a ⚡ that closes it out after a confirmation.
    function chip(c, parent) {
      const label = esc(AE.CLEANING_PROGRAMS[c.programId]);
      if (!c.pending) return '<a class="sg-chip" href="/repair/workorder/' + c.workorderId + '">' + label + '</a>';
      const mk = AE.autoClose
        ? '<button type="button" class="sg-mk" title="Create this cleaning (check in → complete $0 sale)" data-arrival="' + c.arrivalId +
          '" data-program="' + c.programId + '" data-name="' + esc(nameOf(parent)) + '">' + AE.icon('bolt', 12) + '</button>'
        : '';
      return '<span class="sg-chip pending"><a href="/check-in/arrivals/' + c.arrivalId + '" title="In Arrivals — not checked in yet" style="color:inherit;font-weight:400">' +
        label + ' · pending</a>' + mk + '</span>';
    }

    // An order's cleanings. With 2+ pending (and Dualcast on), the pending chips sit in one
    // dashed purple outline, led by a ⚡ that runs them all (Dualcast, or Triplecast for 3+);
    // each chip keeps its own ⚡ for just that one.
    const chips = (matched, wo) => {
      const waiting = matched.filter((c) => c.pending);
      if (!AE.autoClose || !AE.autoClose.dualcastOn() || waiting.length < 2) return matched.map((c) => chip(c, wo)).join('');
      const name = waiting.length >= 3 ? 'Triplecast' : 'Dualcast';
      const go = '<button type="button" class="sg-cast-go" title="' + name + ': create all ' + waiting.length + ' pending cleanings for this order, one after the other" data-dual="' +
        esc(JSON.stringify(waiting.map((c) => ({ arrivalId: c.arrivalId, programId: c.programId })))) + '" data-name="' + esc(nameOf(wo)) + '">' +
        '<span class="b">' + AE.icon('bolt', 12) + '</span>' + name + '</button>';
      return matched.filter((c) => !c.pending).map((c) => chip(c, wo)).join('') +
        '<span class="sg-cast-group">' + go + waiting.map((c) => chip(c, wo)).join('') + '</span>';
    };
    function renderPanel() {
      let p = document.getElementById(PANEL_ID);
      if (!p) { p = h('div', { id: PANEL_ID, class: 'sg sg-card' }); document.body.appendChild(p); }
      const b = document.getElementById(BADGE_ID);
      const r = b && b.getBoundingClientRect();
      if (r && !b.classList.contains('floating')) { p.style.top = (r.bottom + 8) + 'px'; p.style.left = Math.max(8, Math.min(r.left, innerWidth - 476)) + 'px'; p.style.bottom = ''; }
      else { p.style.left = '16px'; p.style.bottom = '60px'; p.style.top = ''; }
      if (!last) { p.innerHTML = lastError ? '<span class="miss">' + esc(lastError) + '</span>' : '<span class="sg-soft">Loading…</span>'; return; }

      const linkTo = (c) => c.pending
        ? '<a href="/check-in/arrivals/' + c.arrivalId + '">arrival ' + c.arrivalId + '</a>'
        : '<a href="/repair/workorder/' + c.workorderId + '">' + c.workorderId + '</a>';
      const table = last.rows.length
        ? '<table>' + last.rows.map(({ p: wo, matched }) =>
          '<tr><td><div class="who">' + esc(nameOf(wo) || 'Unknown customer') + '</div>' +
          '<div class="sg-soft"><a href="/repair/workorder/' + wo.workorderId + '">' + wo.workorderId + '</a> · ' + fmtTime(new Date(wo.createdAt)) + '</div></td>' +
          '<td style="text-align:right">' + (matched.length ? chips(matched, wo) : '<span class="miss">No cleanings</span>') + '</td></tr>'
        ).join('') + '</table>'
        : '<p class="sg-soft">No Asurion Mobility orders created today yet.</p>';
      const extra = last.unlinked.length
        ? '<p class="sg-soft" style="margin:10px 0 0">' + last.unlinked.length + " cleaning(s) today not linked to any of today's orders (not counted): " +
          last.unlinked.map(linkTo).join(', ') + '</p>'
        : '';
      const scroll = p.scrollTop;
      p.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px">' + AE.actionIcon('cleaningRate', 26) + '<b style="flex:1;font-size:16px">Today\'s cleaning rate: <span style="color:' + levelColor(last.pct) + '">' +
        (last.pct == null ? '—' : last.pct + '%') + '</span></b><button type="button" class="sg-btn" data-refresh>Refresh</button></div>' +
        '<div class="sg-soft" style="margin-top:4px">' + last.linked + ' cleanings' + (last.pending ? ' (' + last.pending + ' pending in Arrivals)' : '') +
        ' ÷ ' + last.parents + ' Asurion Mobility orders created today · target ' + TARGET +
        '%, ideally 100% · updated ' + fmtTime(last.at) + (lastError ? '<br><span class="miss">Last refresh failed: ' + esc(lastError) + '</span>' : '') + '</div>' +
        table + extra +
        '<p class="sg-soft" style="margin:10px 0 0"><a href="/reporting/metrics">Past days: Reports → Cleaning rate history</a></p>';
      p.scrollTop = scroll;
      p.querySelector('[data-refresh]').onclick = (e) => { e.stopPropagation(); refresh(); };
      p.querySelectorAll('.sg-cast-go').forEach((btn) => {
        btn.onclick = (e) => {
          e.preventDefault(); e.stopPropagation();
          p.remove();
          AE.autoClose.dualcast({ items: JSON.parse(btn.dataset.dual), customerName: btn.dataset.name });
        };
      });
      p.querySelectorAll('.sg-mk').forEach((btn) => {
        btn.onclick = (e) => {
          e.preventDefault(); e.stopPropagation();
          p.remove(); // get out of the way of the confirmation and progress panel
          AE.autoClose.confirmAndRun({ arrivalId: Number(btn.dataset.arrival), programId: Number(btn.dataset.program), customerName: btn.dataset.name });
        };
      });
    }

    function togglePanel(e) {
      e.stopPropagation();
      const p = document.getElementById(PANEL_ID);
      if (p) p.remove(); else { renderPanel(); AE.track('cleaningRate:open'); }
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
      finally {
        loading = false; renderBadge();
        if (document.getElementById(PANEL_ID)) renderPanel();
        if (document.getElementById(HIST_ID) && !histBusy) showHistory();
      }
    }

    // ------------------------------------------------------------ history (Reports page)
    const HIST_KEY = 'ae_rate_history', HIST_ID = 'sg-rate-history', DAY = 86400000;
    const dayStart = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
    const keyOf = (d) => { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
    const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
    const RANGES = [
      ['7', 'Last 7 days', () => [addDays(dayStart(new Date()), -6), dayStart(new Date())]],
      ['30', 'Last 30 days', () => [addDays(dayStart(new Date()), -29), dayStart(new Date())]],
      ['month', 'This month', () => { const t = dayStart(new Date()); return [new Date(t.getFullYear(), t.getMonth(), 1), t]; }],
      ['lastMonth', 'Last month', () => { const t = new Date(); return [new Date(t.getFullYear(), t.getMonth() - 1, 1), new Date(t.getFullYear(), t.getMonth(), 0)]; }],
      ['90', 'Last 90 days', () => [addDays(dayStart(new Date()), -89), dayStart(new Date())]],
    ];
    let histRange = '7', histBusy = null, histErr = null, store = null;
    const histLoadedAt = {}; // range → when its days were last brought up to date (redone every 10 minutes at most)

    // One past day, exactly like compute() but without pending arrivals.
    function tallyDays(wos, keys) {
      const out = {};
      for (const k of keys) {
        const start = new Date(k + 'T00:00:00').getTime(), end = start + DAY;
        const inDay = (r) => { const t = Date.parse(r.createdAt); return t >= start && t < end; };
        const parents = wos.filter((r) => r.programId === AE.PARENT_PROGRAM_ID && inDay(r)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
        const cleanings = AE.data.cleanings(wos, [], inDay);
        const used = new Set();
        let linked = 0;
        for (const p of parents) {
          const m = cleanings.filter((c) => !used.has(c.key) && AE.data.belongs(c, p));
          m.forEach((c) => used.add(c.key));
          linked += m.length;
        }
        out[k] = [parents.length, linked];
      }
      return out;
    }
    const histCache = () => { const all = GM_getValue(HIST_KEY, {}); return (store && all[store]) || {}; };
    function saveHist(days) {
      const all = GM_getValue(HIST_KEY, {});
      const mine = Object.assign({}, all[store] || {}, days);
      const cutoff = keyOf(addDays(new Date(), -400)); // a little over a year
      for (const k of Object.keys(mine)) if (k < cutoff) delete mine[k];
      all[store] = mine;
      GM_setValue(HIST_KEY, all);
    }
    // Make sure every day in [from, to) before today is known; the last two are always redone.
    async function loadHistory(from) {
      if (!store) store = AE_SANDBOX ? 'sandbox' : String((await AE.profile()).storeId || ''); // sandbox numbers never mix with a real store's
      const today = dayStart(new Date());
      const cache = histCache(), need = [];
      for (let d = new Date(from); d < today; d = addDays(d, 1)) {
        const k = keyOf(d);
        if (!cache[k] || d >= addDays(today, -2)) need.push(k);
      }
      if (!need.length) return;
      const since = new Date(need[0] + 'T00:00:00').getTime();
      const wos = await AE.data.workorders(since, 40); // closed lists newest first; stops past `since`
      saveHist(tallyDays(wos, need));
    }

    const pctOf = (parents, linked) => (parents ? Math.round((linked / parents) * 100) : null);
    const dayLabel = (k, opts) => new Date(k + 'T00:00:00').toLocaleDateString([], opts || { weekday: 'short', month: 'short', day: 'numeric' });
    function historyCard() {
      const [from, to] = RANGES.find((r) => r[0] === histRange)[2]();
      const cache = histCache(), todayKey = keyOf(new Date());
      const days = [];
      for (let d = new Date(from); d <= to; d = addDays(d, 1)) {
        const k = keyOf(d);
        if (k === todayKey) days.push({ k, today: true, parents: last ? last.parents : null, linked: last ? last.linked : null });
        else days.push({ k, parents: cache[k] ? cache[k][0] : null, linked: cache[k] ? cache[k][1] : null });
      }
      const known = days.filter((d) => d.parents != null);
      const P = known.reduce((n, d) => n + d.parents, 0), L = known.reduce((n, d) => n + d.linked, 0);
      const withOrders = known.filter((d) => d.parents);
      const atTarget = withOrders.filter((d) => pctOf(d.parents, d.linked) >= TARGET).length;
      const overall = pctOf(P, L);
      const top = Math.max(150, ...withOrders.map((d) => pctOf(d.parents, d.linked)));
      const bar = (d) => {
        const pct = d.parents ? pctOf(d.parents, d.linked) : null;
        const tip = dayLabel(d.k) + (d.today ? ' (so far)' : '') + ': ' + (d.parents == null ? 'loading' : d.parents ? d.linked + '/' + d.parents + ' · ' + pct + '%' : 'no AM orders');
        return h('div', { class: 'col', title: tip },
          h('div', { class: 'bar ' + (pct == null ? 'none' : level(pct)) + (d.today ? ' today' : ''), style: 'height:' + (pct == null ? 3 : Math.max(3, Math.min(100, (pct / top) * 100))) + '%' }));
      };
      const busy = !!histBusy;
      return h('div', { id: HIST_ID, class: 'sg sg-card' },
        h('div', { class: 'hd' }, h('span', { html: AE.actionIcon('cleaningRate', 28) }), h('b', null, 'Cleaning rate history'),
          h('span', { class: 'sg-soft' }, 'Divination · ' + AE_NAME)),
        h('div', { class: 'ranges' }, RANGES.map(([id, label]) => h('button', { type: 'button', class: 'sg-btn' + (id === histRange ? ' sg-primary' : ''), 'aria-pressed': String(id === histRange),
          onclick: () => { histRange = id; AE.track('cleaningRate:history'); showHistory(); } }, label))),
        histErr ? h('div', { class: 'miss', style: 'margin:8px 0' }, "Couldn't load the history: " + histErr) : null,
        h('div', { class: 'sum' },
          h('div', null, h('div', { class: 'big', style: 'color:' + levelColor(overall) }, overall == null ? '—' : overall + '%'), h('div', { class: 'sg-soft' }, 'overall')),
          h('div', null, h('div', { class: 'big' }, L + ' / ' + P), h('div', { class: 'sg-soft' }, 'cleanings / AM orders')),
          h('div', null, h('div', { class: 'big' }, atTarget + ' of ' + withOrders.length), h('div', { class: 'sg-soft' }, 'days at ' + TARGET + '%+')),
          busy ? h('div', { class: 'sg-soft', style: 'align-self:center' }, h('span', { class: 'sg-spin', style: 'display:inline-block;vertical-align:-3px;margin-right:6px' }), 'Loading work orders…') : null),
        h('div', { class: 'chart', style: '--target:' + Math.min(100, (TARGET / top) * 100) + '%;--full:' + Math.min(100, (100 / top) * 100) + '%' },
          h('div', { class: 'line target', title: 'Target ' + TARGET + '%' }), h('div', { class: 'line full', title: '100%' }),
          h('div', { class: 'cols' }, days.map(bar))),
        h('div', { class: 'axis sg-soft' }, h('span', null, dayLabel(days[0].k, { month: 'short', day: 'numeric' })), h('span', null, dayLabel(days[days.length - 1].k, { month: 'short', day: 'numeric' }))),
        h('details', { class: 'days' }, h('summary', null, 'Day by day'),
          h('table', null, h('thead', null, h('tr', null, h('th', null, 'Day'), h('th', null, 'AM orders'), h('th', null, 'Cleanings'), h('th', null, 'Rate'))),
            h('tbody', null, days.slice().reverse().map((d) => {
              const pct = d.parents ? pctOf(d.parents, d.linked) : null;
              return h('tr', null, h('td', null, dayLabel(d.k) + (d.today ? ' (so far)' : '')), h('td', null, d.parents == null ? '…' : d.parents),
                h('td', null, d.linked == null ? '…' : d.linked), h('td', { style: 'font-weight:700;color:' + levelColor(pct) }, pct == null ? '—' : pct + '%'));
            })))));
    }
    const HIST_CSS = `
      #${HIST_ID} { margin:1.5rem 0 0; padding:16px 20px; font-size:14px; line-height:1.4; }
      #${HIST_ID} .hd { display:flex; align-items:center; gap:10px; margin-bottom:12px; }
      #${HIST_ID} .hd b { font-size:18px; }
      #${HIST_ID} .hd .sg-soft { margin-left:auto; font-size:12px; }
      #${HIST_ID} .ranges { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:14px; }
      #${HIST_ID} .ranges .sg-btn { height:30px; font-size:13px; padding:0 12px; flex:none; }
      #${HIST_ID} .sum { display:flex; flex-wrap:wrap; gap:28px; margin-bottom:14px; }
      #${HIST_ID} .big { font-size:24px; font-weight:700; font-variant-numeric:tabular-nums; }
      #${HIST_ID} .chart { position:relative; height:140px; border-bottom:1px solid var(--aui-outline, #c6c6ca); }
      #${HIST_ID} .cols { position:absolute; inset:0; display:flex; align-items:flex-end; gap:2px; }
      #${HIST_ID} .col { flex:1; height:100%; display:flex; align-items:flex-end; min-width:2px; }
      #${HIST_ID} .bar { width:100%; border-radius:3px 3px 0 0; }
      #${HIST_ID} .bar.good { background:var(--aui-status-success, #136d31); }
      #${HIST_ID} .bar.ok { background:#d6a000; }
      #${HIST_ID} .bar.bad { background:var(--aui-status-error, #b91a24); }
      #${HIST_ID} .bar.none { background:var(--aui-outline, #c6c6ca); }
      #${HIST_ID} .bar.today { opacity:.55; }
      #${HIST_ID} .col:hover .bar { filter:brightness(1.15); }
      #${HIST_ID} .line { position:absolute; left:0; right:0; border-top:1px dashed var(--aui-on-surface-soft, #5d5e61); pointer-events:none; }
      #${HIST_ID} .line.target { bottom:var(--target); }
      #${HIST_ID} .line.full { bottom:var(--full); border-top-style:dotted; opacity:.6; }
      #${HIST_ID} .axis { display:flex; justify-content:space-between; font-size:12px; margin-top:4px; }
      #${HIST_ID} .days { margin-top:12px; }
      #${HIST_ID} .days summary { cursor:pointer; color:var(--aui-primary, #8223d2); font-weight:600; }
      #${HIST_ID} .days table { width:100%; border-collapse:collapse; margin-top:8px; font-variant-numeric:tabular-nums; }
      #${HIST_ID} .days th { text-align:left; font-size:12px; color:var(--aui-on-surface-soft, #5d5e61); padding:6px 8px; border-bottom:1px solid var(--aui-outline-soft, #eeedf1); }
      #${HIST_ID} .days td { padding:6px 8px; border-bottom:1px solid var(--aui-outline-soft, #eeedf1); }
      #${HIST_ID} .miss { color:var(--aui-status-error, #b91a24); font-weight:600; }
    `;
    function showHistory() {
      const reports = document.querySelector('.reports-card');
      const home = reports && reports.parentElement;
      const old = document.getElementById(HIST_ID);
      if (!home) { old?.remove(); return; }
      if (!document.getElementById('sg-rate-history-css')) document.head.append(h('style', { id: 'sg-rate-history-css' }, HIST_CSS));
      const open = old && old.querySelector('details.days') && old.querySelector('details.days').open;
      const card = historyCard();
      if (open) card.querySelector('details.days').open = true;
      if (old && old.parentElement === home) old.replaceWith(card); else { old?.remove(); home.append(card); }
      const [from] = RANGES.find((r) => r[0] === histRange)[2]();
      if (!histBusy && !(Date.now() - (histLoadedAt[histRange] || 0) < 10 * 60000)) {
        const range = histRange;
        histBusy = loadHistory(from)
          .then(() => { histErr = null; histLoadedAt[range] = Date.now(); }, (e) => { histErr = e.message || String(e); histLoadedAt[range] = Date.now(); })
          .finally(() => { const changed = histBusy; histBusy = null; if (changed && document.getElementById(HIST_ID)) showHistory(); });
      }
    }
    // Portal's Reports page renders late and re-renders; keep the card there.
    let histShownFor = null;
    AE.every(1000, () => {
      if (!/^\/reporting\/metrics/.test(location.pathname)) { histShownFor = null; return; }
      const reports = document.querySelector('.reports-card');
      if (reports && (!document.getElementById(HIST_ID) || histShownFor !== reports)) { histShownFor = reports; showHistory(); }
    });

    const onPortal = () => !/^\/login/.test(location.pathname);
    AE.every(1500, () => { if (onPortal()) renderBadge(); }); // SPA re-renders can drop the badge
    setInterval(() => { if (onPortal() && !document.hidden) refresh(); }, REFRESH_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && onPortal() && (!last || Date.now() - last.at > REFRESH_MS)) refresh();
    });
    AE.on('cleaning-changed', () => refresh());
    if (onPortal()) refresh();
  },
});

// ===== 15-wo-cleanings.js =====
/*
  Esuna (WO cleanings pill) — on a work order page, a pill right after the
  customer's name saying whether this device has cleanings:

    Cleanings available (2)   cleaning arrivals waiting in Arrivals
    Cleanings done (2)        cleaning WOs exist (in progress or sold)
    No cleanings              an Asurion Mobility WO with none found

  Click it for the list. Available ones have a Create button (cleaning
  auto-close, after a confirmation) when that crystal is on. Not shown on a
  cleaning WO itself, or on non-Asurion-Mobility WOs with no cleanings.

  Cleanings match this WO by device IMEI (customer ID only if there's no
  IMEI), created within 2 days of the WO. Read-only lookups.
*/
AE.crystal({
  id: 'woCleanings',
  name: 'Esuna',
  sites: ['portal.ubreakifix.net'],
  run() {
    const { h, esc } = AE;
    const PILL_ID = 'sg-wo-clean-pill', POP_ID = 'sg-wo-clean-pop';
    const WINDOW_MS = 2 * 86400000;
    const REFRESH_MS = 2 * 60 * 1000;
    let state = null;        // { woId, status: 'loading'|'ready'|'error', wo, matched, error, at }
    let loadingFor = null;

    document.head.append(h('style', null, `
      #${PILL_ID} { display:inline-flex; align-items:center; gap:6px; height:28px; margin-left:14px; padding:0 12px; border-radius:10000rem;
        border:1px solid transparent; font:600 14px/1 Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; cursor:pointer; white-space:nowrap; flex:none;
        align-self:center; }
      #${PILL_ID}.avail { background:var(--aui-primary,#8223d2); color:var(--aui-on-primary,#fff); }
      #${PILL_ID}.done  { background:var(--aui-status-success-soft,#c5ffc8); color:var(--aui-status-on-success-soft,#062011); }
      #${PILL_ID}.none  { background:transparent; border-color:var(--aui-outline,#c6c6ca); color:var(--aui-on-surface-soft,#5d5e61); font-weight:400; }
      #${PILL_ID}.load  { background:transparent; border-color:var(--aui-outline-soft,#eeedf1); color:var(--aui-on-surface-soft,#5d5e61); font-weight:400; }
      #${PILL_ID} .sg-spin { width:12px; height:12px; }
      #${POP_ID} { position:fixed; z-index:2147483646; width:380px; padding:16px; font-size:14px; line-height:1.4; }
      #${POP_ID} .row { display:flex; align-items:center; gap:10px; padding:10px 0; border-top:1px solid var(--aui-outline-soft,#eeedf1); }
      #${POP_ID} .row:first-of-type { border-top:0; }
      #${POP_ID} .row > div { flex:1; min-width:0; }
      #${POP_ID} a { color:var(--aui-primary,#8223d2); text-decoration:none; }
      #${POP_ID} a:hover { text-decoration:underline; }
    `));

    const currentWoId = () => { const m = location.pathname.match(/^\/repair\/workorder\/(\d+)/); return m ? m[1] : null; };

    // quiet = background refresh: keep showing the current result meanwhile.
    async function load(woId, quiet = false) {
      loadingFor = woId;
      if (!quiet || !state || state.woId !== woId) { state = { woId, status: 'loading' }; render(); }
      try {
        const j = await AE.api('GET', '/api/workorder/' + woId);
        const wo = (j && j.workorder) || AE.unwrap(j);
        const created = Date.parse(wo.createdAt) || Date.now();
        const dev = wo.CustomerDevice || {};
        // Shaped like a list row so AE.data.belongs() can compare it.
        const self = { customerDevice: { imei: dev.imei, customerId: dev.customerId }, customer: { customerId: dev.customerId } };
        let matched = [];
        if (!AE.CLEANING_PROGRAMS[wo.programId]) {
          const [wos, arrs] = await Promise.all([AE.data.workorders(created - WINDOW_MS, 5), AE.data.arrivals()]);
          const near = (r) => Math.abs(Date.parse(r.createdAt) - created) < WINDOW_MS;
          matched = AE.data.cleanings(wos, arrs, near).filter((c) => String(c.workorderId) !== String(woId) && AE.data.belongs(c, self));
        }
        if (loadingFor !== woId) return; // navigated away meanwhile
        state = { woId, status: 'ready', wo, matched, at: Date.now() };
      } catch (e) {
        if (loadingFor !== woId) return;
        state = { woId, status: 'error', error: e.message || String(e), at: Date.now() };
      }
      render();
      if (document.getElementById(POP_ID)) renderPop();
    }

    // Anchor: the flex row holding the "Work order #… | NAME" heading.
    function nameRow(woId) {
      const heading = [...document.querySelectorAll('[data-aui="text"]')].find((el) => el.offsetParent && el.textContent.trim().startsWith('Work order #' + woId));
      return heading && heading.parentElement;
    }

    function pillFor(s) {
      if (!s || s.status === 'loading') return { cls: 'load', html: '<span class="sg-spin"></span>Checking cleanings…' };
      if (s.status === 'error') return { cls: 'none', html: 'Cleanings: couldn\'t check', title: s.error };
      if (AE.CLEANING_PROGRAMS[s.wo.programId]) return null; // this is a cleaning
      const avail = s.matched.filter((c) => c.pending).length, done = s.matched.length - avail;
      if (!s.matched.length) return s.wo.programId === AE.PARENT_PROGRAM_ID ? { cls: 'none', html: 'No cleanings' } : null;
      if (avail && done) return { cls: 'avail', html: AE.icon('bolt', 14) + 'Cleanings: ' + avail + ' available, ' + done + ' done' };
      if (avail) return { cls: 'avail', html: AE.icon('bolt', 14) + 'Cleanings available (' + avail + ')' };
      return { cls: 'done', html: '✓ Cleanings done (' + done + ')' };
    }

    function render() {
      const woId = currentWoId();
      const existing = document.getElementById(PILL_ID);
      const spec = state && state.woId === woId ? pillFor(state) : null;
      const row = woId && nameRow(woId);
      if (!spec || !row) { existing?.remove(); return; }
      const pill = existing || h('button', { id: PILL_ID, type: 'button', class: 'sg', onclick: togglePop });
      pill.className = 'sg ' + spec.cls;
      pill.innerHTML = spec.html;
      pill.title = spec.title || 'Cleanings for this device — click for details';
      if (pill.parentElement !== row) row.appendChild(pill);
    }

    function renderPop() {
      const pill = document.getElementById(PILL_ID);
      if (!pill || !state || state.status !== 'ready') { document.getElementById(POP_ID)?.remove(); return; }
      let pop = document.getElementById(POP_ID);
      if (!pop) { pop = h('div', { id: POP_ID, class: 'sg sg-card' }); document.body.appendChild(pop); }
      const r = pill.getBoundingClientRect();
      pop.style.top = (r.bottom + 8) + 'px';
      pop.style.left = Math.max(8, Math.min(r.left, innerWidth - 396)) + 'px';
      const rows = state.matched.map((c) => {
        const label = esc(AE.CLEANING_PROGRAMS[c.programId]);
        if (c.pending) {
          const act = AE.autoClose
            ? '<button type="button" class="sg-btn sg-primary" data-arrival="' + c.arrivalId + '" data-program="' + c.programId + '" data-name="' + esc(AE.data.nameOf(c)) + '">' + AE.icon('bolt', 14) + 'Create</button>'
            : '';
          return '<div class="row"><div><b>' + label + '</b><div class="sg-soft">Available — <a href="/check-in/arrivals/' + c.arrivalId + '">arrival ' + c.arrivalId + '</a></div></div>' + act + '</div>';
        }
        return '<div class="row"><div><b>' + label + '</b><div class="sg-soft"><a href="/repair/workorder/' + c.workorderId + '">WO ' + c.workorderId + '</a> · ' +
          esc(c.workorderStatusName || '') + '</div></div><span style="color:var(--aui-status-success,#136d31);font-weight:700">✓</span></div>';
      }).join('');
      const waiting = state.matched.filter((c) => c.pending);
      const dual = AE.autoClose && AE.autoClose.dualcastOn() && waiting.length >= 2
        ? '<button type="button" class="sg-btn sg-primary" data-dualcast style="width:100%;justify-content:center;margin:0 0 8px">' + AE.actionIcon('dualcast', 18) +
          'Dualcast · create all ' + waiting.length + '</button>'
        : '';
      pop.innerHTML = '<b style="font-size:16px">Cleanings for this device</b>' +
        '<div class="sg-soft" style="margin:2px 0 8px">Matched to this WO by device IMEI</div>' + dual +
        (rows || '<p class="sg-soft">No cleanings found for this device (open, recently closed, or waiting in Arrivals).</p>');
      const db = pop.querySelector('[data-dualcast]');
      if (db) db.onclick = (e) => {
        e.stopPropagation();
        pop.remove();
        AE.autoClose.dualcast({ items: waiting.map((c) => ({ arrivalId: c.arrivalId, programId: c.programId })), customerName: AE.data.nameOf(state.matched[0]) });
      };
      pop.querySelectorAll('button[data-arrival]').forEach((b) => {
        b.onclick = (e) => {
          e.stopPropagation();
          pop.remove();
          AE.autoClose.confirmAndRun({ arrivalId: Number(b.dataset.arrival), programId: Number(b.dataset.program), customerName: b.dataset.name });
        };
      });
    }

    function togglePop(e) {
      e.stopPropagation();
      const pop = document.getElementById(POP_ID);
      if (pop) pop.remove(); else { renderPop(); AE.track('woCleanings:open'); }
    }
    document.addEventListener('click', (e) => {
      const pop = document.getElementById(POP_ID), pill = document.getElementById(PILL_ID);
      if (pop && !pop.contains(e.target) && !(pill && pill.contains(e.target))) pop.remove();
    });

    AE.every(1000, () => {
      const woId = currentWoId();
      if (!woId) { document.getElementById(PILL_ID)?.remove(); document.getElementById(POP_ID)?.remove(); state = null; loadingFor = null; return; }
      const stale = state && state.status !== 'loading' && Date.now() - state.at > REFRESH_MS && !document.hidden;
      if (!state || state.woId !== woId) { if (loadingFor !== woId) load(woId); }
      else if (stale) { state.at = Date.now(); load(woId, true); }
      render(); // Portal re-renders the header; put the pill back
    });
    AE.on('cleaning-changed', () => { const woId = currentWoId(); if (woId) load(woId, true); });
  },
});

// ===== 17-text-notes.js =====
/*
  Recitation (text → WO note). When a text is sent to a customer from inside a work
  order, post it as a note on that WO:

    Garrett Green sent a text message to Tina Liddy.

    <the message>

  How (v2.3.2): the browser's own network log (PerformanceObserver) reports
  every request the page makes, however Portal's code issues it. When a
  POST …/messages/v1/send shows up while a WO page is open (core's
  text-sent event, shared with Auto-Waymark since 2.17), read that WO
  customer's message history (GET /api/messages/v1/customers/{id}, the same
  call the chat panel makes right after sending) and log each of *your*
  outbound messages from the last few minutes that isn't logged yet. Finding
  it in the history also confirms it actually went out. Never sends texts.

  Why not wrap fetch (v2.3.0/2.3.1): Portal's messaging code keeps its
  own reference to fetch from load time, before any userscript runs, so a
  wrapper never saw the send (confirmed on Zen with a HAR, Sep 26 2026).

  The note is a regular (noteType 2) note tagged with the WO's current
  status, using Portal's own status → tag map. Afterwards the WO view is
  refreshed in place (AE.refreshView), so the note shows without a reload.
*/
AE.crystal({
  id: 'textNotes',
  name: 'Recitation',
  sites: ['portal.ubreakifix.net'],
  run() {
    // Portal's status id → note tag map (from its ubif-util-store bundle).
    const STATUS_TAG = {
      1: 'initial_checkin', 2: 'need_to_order', 3: 'awaiting_item', 4: 'awaiting_device', 5: 'awaiting_diagnostics',
      6: 'awaiting_partner_approval', 7: 'awaiting_callback', 8: 'ready_for_work', 9: 'diagnostics', 10: 'work_in_progress',
      11: 'quality_check', 12: 'repair_summary', 13: 'ready_for_pickup', 14: 'sale_complete', 15: 'closed', 17: 'device_abandoned',
      22: 'request_buyout_replacement', 23: 'transferred_to_depot', 24: 'ready_for_diag', 25: 'cancelled', 26: 'send_to_depot', 27: 'shipped_by_depot',
    };
    const WINDOW_MS = 3 * 60 * 1000;        // how recent a sent message must be
    const LOGGED_KEY = 'ae_text_notes_logged'; // messageId → time logged (shared across tabs)
    const loadLogged = () => {
      const all = GM_getValue(LOGGED_KEY, {}), cutoff = Date.now() - 2 * 86400000;
      for (const [k, t] of Object.entries(all)) if (t < cutoff) delete all[k];
      return all;
    };
    let busy = null;

    async function logRecentTexts(woId) {
      if (AE.status.blocked('textNotes')) return; // paused: the text went out, but no note is added
      const [prof, woRes, cust] = await Promise.all([
        AE.profile(),
        AE.api('GET', '/api/workorder/' + woId),
        AE.api('GET', '/api/v1/workorder/' + woId + '/demographic/customer-data'),
      ]);
      const wo = (woRes && woRes.workorder) || AE.unwrap(woRes) || {};
      const customerId = cust && cust.customerId;
      if (!customerId) return 0;
      const hist = await AE.api('GET', '/api/messages/v1/customers/' + customerId + '?page=1&pageSize=10&sortOrder=DESC&storeId=' + (prof.storeId || ''));
      const logged = loadLogged();
      const fresh = ((hist && hist.messages) || []).filter((m) =>
        String(m.direction).toUpperCase() === 'OUTBOUND' &&
        String(m.senderId) === String(prof.userId) &&
        Date.now() - Date.parse(m.contactDate) < WINDOW_MS &&
        !logged[m.messageId]);
      const tech = prof.name || 'A technician';
      for (const m of fresh.reverse()) { // oldest first
        const to = AE.data.nameOf({ customer: { fullName: m.customerName } }) ||
          AE.data.nameOf({ customer: (cust && cust.CustomerDatum) || {} }) || 'the customer';
        await AE.api('POST', '/api/note', {
          noteText: tech + ' sent a text message to ' + to + '.\n\n' + String(m.content || '').trim(),
          customerId: String(customerId),
          workorderId: Number(woId),
          noteTag: STATUS_TAG[wo.workorderStatusId] || null,
          noteType: 2,
        });
        logged[m.messageId] = Date.now();
        GM_setValue(LOGGED_KEY, logged);
        AE.track('textNotes:note');
      }
      return fresh.length;
    }

    async function onSend() {
      const m = location.pathname.match(/^\/repair\/workorder\/(\d+)/);
      if (!m) return; // texts sent outside a WO aren't logged
      if (busy) return busy; // several sends in a burst → one lookup
      busy = (async () => {
        await AE.sleep(1200); // let Portal's own write land first
        try {
          let n = await logRecentTexts(m[1]);
          if (!n) { await AE.sleep(2500); n = await logRecentTexts(m[1]); } // history can lag a moment
          if (n) AE.refreshView();
          if (n) AE.toast('Text logged', (n > 1 ? n + ' texts' : 'Text') + ' added to WO ' + m[1] + "'s notes.", 'ok', 4000);
        } catch (e) {
          AE.toast('Text sent, but not logged', "Couldn't add the WO note: " + (e.message || e) + ' — add it by hand.', 'err', 12000);
        } finally { busy = null; }
      })();
      return busy;
    }

    AE.on('text-sent', () => onSend());
    AE.textNotesDebug = { onSend, logRecentTexts }; // for testing
  },
});

// ===== 20-auto-close.js =====
/*
  Swiftcast (cleaning auto-close) — round purple ⚡ button in a cleaning arrival's
  "Customer arrival" drawer. One click replays Portal's own API sequence
  (see the vault note "Cleaning WO Flow"):

    check-in    validate-imei → checkin/workorder → calculate-sla →
                update-service-job-status → PUT checkin/workorder   (status 8)
    status walk PATCH status 9, then PUT workorder 10 → 11 → 12 → 13,
                each followed by the same auto-note the UI posts
    labor       EXPERIMENTAL, off unless switched on (Settings → Swiftcast; default
                AE_REFRESH_LABOR_DEFAULT). VZ Device Refresh (program 11759) only: labor SKU 10156 into the
                cart (Portal's own POST order/cart/item/add, LineType labor),
                which earns the tech commission. If it ever leaves anything to
                pay, it's taken back out before checkout (order/cart/item/remove)
                and the run finishes at $0 as before, with a warning.
    checkout    verify cart total is $0 → checkout/complete-order

  Dualcast (Settings → Swiftcast, on by default): when a device has two or
  more cleaning arrivals waiting (e.g. VZ Device Refresh + VZ Sanitization),
  one button runs them all back to back — one confirmation, one progress
  panel, stops at the first problem. Offered in the arrival drawer (next to
  ⚡, when the same IMEI has another cleaning waiting), in Esuna's list and
  in Divination's panel.

  Deliberately NOT replayed: PUT checkin/customers (re-saves the customer)
  and PUT customer-devices (would blank the shared device's nickname and
  passcode on the parent WO). A Stop button halts before the next call.
*/
AE.crystal({
  id: 'autoClose',
  name: 'Swiftcast',
  sites: ['portal.ubreakifix.net'],
  run() {
    const { h, icon } = AE;
    const DEVICE_ISSUES = ['Cleaning'];
    const BIN = ''; // cleanings aren't physical — no bin
    const STEP_DELAY_MS = 400;
    const BTN_ID = 'sg-autoclose-btn', MENU_ID = 'sg-cast-menu', INTRO_ID = 'sg-cast-intro';
    document.head.append(h('style', null, `
      .sg-cast { position:relative; padding:0; overflow:visible; background:#1a1c1e; }
      .sg-cast .sg-aicon { border-radius:50%; display:block; width:100%; height:100%; }
      .sg-cast .n { position:absolute; right:-4px; top:-4px; min-width:18px; height:18px; padding:0 4px; border-radius:10000rem; background:#d1344b; color:#fff;
        font:700 11px/18px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; text-align:center; box-shadow:0 0 0 2px var(--aui-surface, #fff); }
      #${MENU_ID} { position:fixed; z-index:2147483646; width:280px; padding:6px; }
      #${MENU_ID} .opt { display:flex; flex-direction:column; align-items:flex-start; gap:1px; width:100%; padding:8px 10px; border:0; border-radius:8px; background:none; cursor:pointer;
        text-align:left; font:inherit; color:inherit; }
      #${MENU_ID} .opt:hover { background:var(--aui-neutral-soft, #f1f0f4); }
      #${MENU_ID} .opt .sg-soft { font-size:12px; }
      #${INTRO_ID} { position:fixed; z-index:2147483646; width:300px; padding:12px 14px; font-size:13px; line-height:1.45; }
      #${INTRO_ID}::after { content:''; position:absolute; bottom:-8px; left:var(--tail, 20px); width:16px; height:16px; transform:rotate(45deg);
        background:var(--aui-surface, #fff); box-shadow:2px 2px 3px rgba(12,14,17,.08); }
      #${INTRO_ID} .hd { display:flex; align-items:center; gap:8px; font-size:15px; margin-bottom:6px; }
      #${INTRO_ID} .hd .sg-aicon { border-radius:6px; }
      #${INTRO_ID} p { margin:0 0 6px; }
      #${INTRO_ID} .sg-actions { margin-top:8px; justify-content:flex-end; }
    `));
    const REFRESH_PROGRAM = 11759, REFRESH_LABOR_SKU = '10156'; // VZ Device Refresh → its labor SKU (commission)
    const LABOR_LINE = { '@odata.type': '#Microsoft.Dynamics.Commerce.Runtime.DataModel.AttributeTextValue', Name: 'LineType', TextValue: 'labor' };
    const cartOf = (r) => { const c = unwrap(r); return (c && (c.cartItems ? c : c.cart)) || c || {}; };
    const skuOf = (i) => String(i.sku || i.itemNumber || i.ItemId || '');
    let laborNote = null; // a warning to show when the run finishes
    let checkedArrivalId = null, isCleaning = false, running = false, stopRequested = false;
    let siblings = [], thisArrival = null; // Dualcast: other cleaning arrivals waiting for the same device

    async function api(method, path, body) {
      const r = await AE.api(method, path, body, { shouldStop: () => stopRequested });
      await AE.sleep(STEP_DELAY_MS);
      return r;
    }
    const unwrap = AE.unwrap;

    async function run(arrivalId, log) {
      const arrival = unwrap(await api('GET', '/api/arrivals/' + arrivalId));
      const programId = arrival.program && arrival.program.programId;
      if (log.plan) log.plan(stepsFor(programId)); // the spell icon's cooldown sweep
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

      // VZ Device Refresh: add the refresh labor SKU (commission). Never stops the run.
      laborNote = null;
      let laborAdded = false;
      const laborOn = !!((AE.settings.autoClose || {}).refreshLabor ?? AE_REFRESH_LABOR_DEFAULT); // EXPERIMENTAL, off by default
      if (Number(programId) === REFRESH_PROGRAM && laborOn) {
        try {
          const w = await getWoForCart(woId);
          const cart = cartOf(await api('GET', '/api/get-cart/' + encodeURIComponent(w.csuCartId) + '?includePartStatus=true'));
          if ((cart.cartItems || []).some((i) => skuOf(i) === REFRESH_LABOR_SKU)) log('Refresh labor ' + REFRESH_LABOR_SKU + ' already in the cart');
          else {
            await api('POST', '/api/order/cart/item/add', {
              cartId: w.csuCartId, programId: REFRESH_PROGRAM, workorderId: woId, saveCartToSalesOrder: true,
              cartLines: [{ ItemId: REFRESH_LABOR_SKU, Quantity: 1, AttributeValues: [LABOR_LINE] }],
            });
            laborAdded = true;
            AE.track('autoClose:refreshLabor');
            log('Added refresh labor ' + REFRESH_LABOR_SKU);
          }
        } catch (e) {
          if (e instanceof AE.Stopped) throw e;
          laborNote = "Couldn't add refresh labor " + REFRESH_LABOR_SKU + ' (' + (e.message || e) + '), so this cleaning was completed without it.';
          log('Refresh labor not added');
        }
      }

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
      const readCart = async () => unwrap(await api('GET', '/api/get-cart/' + encodeURIComponent(wo.csuCartId) + '?includePartStatus=true'));
      const payOf = (c) => (c && (c.payment || (c.cart && c.cart.payment))) || null;
      let cart = await readCart();
      let pay = payOf(cart);
      // The refresh labor is meant to be free to the customer; if it isn't, take it back out.
      if (laborAdded && pay && Number(pay.total) !== 0) {
        const line = (cartOf(cart).cartItems || []).find((i) => skuOf(i) === REFRESH_LABOR_SKU);
        if (line) {
          await api('POST', '/api/order/cart/item/remove', { cartId: wo.csuCartId, cartLines: [line.lineId], itemNumbers: [REFRESH_LABOR_SKU], workorderId: woId });
          laborNote = 'Refresh labor ' + REFRESH_LABOR_SKU + ' would have charged $' + pay.total + ', so it was taken back out and the sale stayed $0.';
          log('Refresh labor removed (it added a charge)');
          cart = await readCart(); pay = payOf(cart);
        }
      }
      const total = pay ? Number(pay.total) : NaN;
      if (total !== 0) throw new Error('Cart total is ' + (pay ? '$' + pay.total : 'unknown') + ', not $0 — stopped before checkout. Finish at Ready for pickup by hand.');
      await api('POST', '/api/workorder/demographic/customer-data', { customerId, clientId });
      const done = await api('POST', '/api/checkout/complete-order', { workorderId: woId, sendComms: false });
      log('Sale complete' + (done && done.salesOrder && done.salesOrder.salesId ? ' (' + done.salesOrder.salesId + ')' : ''));
      return woId;
    }

    async function getWoForCart(woId) {
      const r = await api('GET', '/api/workorder/' + woId);
      return (r && r.workorder) || unwrap(r) || {};
    }
    const woLink = (id) => '<a href="/repair/workorder/' + id + '">WO ' + id + '</a>';

    /*
      Never act while the store is closed (Portal's Close store button). Asked
      fresh each time (/api/auth/user → isStoreOpen, the flag behind Portal's
      own Open/Close store button); if Portal can't be asked, don't act either.
    */
    async function storeClosed() {
      let open;
      try { open = (await AE.api('GET', '/api/auth/user')).isStoreOpen; } catch (e) {
        AE.toast('Swiftcast', "Couldn't check whether the store is open (" + (e.message || e) + '). Nothing was created.', 'err', 9000);
        return true;
      }
      if (open === false) {
        AE.toast('Swiftcast is off while the store is closed', 'Open the store in Portal, then try again. Nothing was created.', 'err', 9000);
        return true;
      }
      return false;
    }

    // Dualcast: several cleanings in one go, one after another, in one panel.
    // The progress panel's heading: Swiftcasting… / Dualcasting… / Triplecasting… (n).
    // Steps a run logs (IMEI, created, checked in, started, diagnostics, work, QC, RFP, sale = 9,
    // + the labor line when it applies): the spell icon's cooldown sweep fills one step at a time.
    const laborOnNow = () => !!((AE.settings.autoClose || {}).refreshLabor ?? AE_REFRESH_LABOR_DEFAULT);
    const stepsFor = (programId) => 9 + (Number(programId) === REFRESH_PROGRAM && laborOnNow() ? 1 : 0);
    const castingTitle = (n) => (n >= 3 ? 'Triplecasting… (' + n + ')' : n === 2 ? 'Dualcasting…' : 'Swiftcasting…');
    // fake (dev tools only): the same confirmation and panel, with simulated steps and no API calls.
    async function runMany(items, customerName, fake) {
      if (running || (!fake && AE.status.blocked('autoClose'))) return;
      if (!fake && await storeClosed()) return;
      if (!fake) AE.track('autoClose:dualcast');
      running = true; stopRequested = false;
      const runner = fake ? (it, log) => fakeRun(it, log, fake) : (it, log) => run(it.arrivalId, log);
      const panel = AE.progressPanel(castingTitle(items.length) + (fake ? ' (test)' : ''),
        { icon: castOf(items.length)[0], total: items.reduce((n, it) => n + stepsFor(it.programId) + 1, 0), hold: true }); // +1: each cleaning's "1 of 2" line
      const stop = h('button', { class: 'sg-btn sg-lg sg-danger', onclick: () => { stopRequested = true; stop.disabled = true; stop.textContent = 'Stopping after current call…'; } }, '■ Stop');
      panel.actions(stop);
      const done = [], notes = [];
      let woId = null;
      try {
        for (const [i, it] of items.entries()) {
          panel.step((i + 1) + ' of ' + items.length + ': ' + (AE.CLEANING_PROGRAMS[it.programId] || 'Cleaning'));
          woId = null;
          const id = await runner(it, (t, wid) => { if (wid) woId = wid; panel.step(t); });
          done.push(id);
          if (laborNote) notes.push(laborNote);
          if (!fake) AE.emit('cleaning-changed', { arrivalId: it.arrivalId, woId: id });
        }
        panel.finish('ok', 'Done — ' + done.map(woLink).join(' and ') + ' checked in, completed, and sold at $0.' + notes.map((n) => '<br><b>Note:</b> ' + AE.esc(n)).join(''));
      } catch (e) {
        const stopped = e instanceof AE.Stopped;
        const left = woId ? ' ' + woLink(woId) + ' was left at the last step listed above.' : '';
        panel.finish(stopped ? 'stop' : 'err', (stopped ? 'Stopped.' : AE.esc(e.message)) + left +
          (done.length ? ' Already finished: ' + done.map(woLink).join(', ') + '.' : '') + ' The rest were not started.');
      } finally {
        panel.actions();
        running = false;
        if (!fake) { AE.emit('cleaning-changed', {}); if (done.length) AE.refreshView(); }
      }
    }
    // Dev tools: Swiftcast's steps, timed like the real thing, nothing sent. fake.fail = fail the 2nd cleaning at QC.
    let fakeWo = 599000000;
    async function fakeRun(it, log, fake) {
      laborNote = null;
      const pause = async () => { await AE.sleep(450); if (stopRequested) throw new AE.Stopped(); };
      const woId = ++fakeWo;
      const steps = ['IMEI validated', ['Created WO ' + woId, woId], 'Checked in'];
      if (Number(it.programId) === REFRESH_PROGRAM && ((AE.settings.autoClose || {}).refreshLabor ?? AE_REFRESH_LABOR_DEFAULT)) steps.push('Added refresh labor ' + REFRESH_LABOR_SKU);
      steps.push('Started work', 'Diagnostics done', 'Work done', 'QC done', 'Ready for pickup', 'Sale complete (SO-TEST)');
      for (const st of steps) {
        await pause();
        if (fake.fail && fakeWo % 2 === 0 && st === 'QC done') throw new Error('PUT /api/workorder/' + woId + ' → HTTP 500 (test failure, nothing was sent)');
        Array.isArray(st) ? log(st[0], st[1]) : log(st);
      }
      return woId;
    }

    async function onClick(arrivalId, checked) {
      if (running || AE.status.blocked('autoClose')) return;
      if (!checked && await storeClosed()) return;
      AE.track('autoClose:run');
      running = true; stopRequested = false;
      const panel = AE.progressPanel(castingTitle(1), { icon: 'autoClose', total: 9, hold: true });
      const stop = h('button', { class: 'sg-btn sg-lg sg-danger', onclick: () => { stopRequested = true; stop.disabled = true; stop.textContent = 'Stopping after current call…'; } }, '■ Stop');
      panel.actions(stop);
      let woId = null;
      const log = (t, id) => { if (id) woId = id; panel.step(t); };
      log.plan = (n) => panel.plan(n);
      const btn = document.getElementById(BTN_ID);
      if (btn) btn.disabled = true;
      try {
        const id = await run(arrivalId, log);
        panel.finish('ok', 'Done — ' + woLink(id) + ' checked in, completed, and sold at $0.' + (laborNote ? '<br><b>Note:</b> ' + AE.esc(laborNote) : ''));
      } catch (e) {
        const where = woId ? ' ' + woLink(woId) + ' was left at the last step listed above.' : ' No work order was created.';
        const stopped = e instanceof AE.Stopped;
        panel.finish(stopped ? 'stop' : 'err', (stopped ? 'Stopped.' : AE.esc(e.message)) + where);
      } finally {
        panel.actions();
        running = false;
        if (btn) btn.disabled = false;
        AE.emit('cleaning-changed', { arrivalId, woId }); // badge + WO pill refresh
        if (woId) AE.refreshView(); // Portal's own lists (arrivals, WOs) show the change without a reload
      }
    }

    // Also callable from the cleaning-rate list and the WO cleanings pill.
    // Those are one step removed from the arrival itself, so they always ask
    // first; the drawer button (you're looking at the arrival) doesn't.
    /*
      One round button, named for how many cleanings are waiting for the device:
      1 → Swiftcast (this cleaning), 2 → Dualcast, 3+ → Triplecast (all of them,
      after one confirmation). Right-click Dualcast/Triplecast: close only this cleaning.
      The first time a Dualcast/Triplecast shows, a speech bubble explains it.
    */
    const castOf = (n) => (n >= 3 ? ['triplecast', 'Triplecast'] : n === 2 ? ['dualcast', 'Dualcast'] : ['autoClose', 'Swiftcast']);
    function castButton({ size, items, customerName, single, fake }) {
      const n = items.length, [iconId, name] = castOf(n);
      const names = items.map((it) => AE.CLEANING_PROGRAMS[it.programId] || 'Cleaning');
      const b = h('button', {
        type: 'button', class: 'sg-fab sg-cast' + (n > 1 ? ' multi' : ''), 'aria-label': name,
        title: n > 1
          ? name + ': create all ' + n + ' cleanings waiting for this device (' + names.join(' + ') + '), one after the other. Right-click to close only this one.'
          : 'Swiftcast: check in, walk to Ready for pickup, and complete the $0 sale',
        style: 'align-self:center;width:' + size + 'px;height:' + size + 'px',
        html: AE.actionIcon(iconId, size) + (n > 1 ? '<span class="n">' + n + '</span>' : ''),
        onclick: () => (n > 1 ? AE.autoClose.dualcast({ items, customerName, fake }) : single()),
      });
      if (n > 1) b.addEventListener('contextmenu', (e) => { e.preventDefault(); castMenu(e.clientX, e.clientY, items, single, () => AE.autoClose.dualcast({ items, customerName, fake })); });
      return b;
    }
    function castMenu(x, y, items, single, all) {
      document.getElementById(MENU_ID)?.remove();
      const [, name] = castOf(items.length);
      const opt = (label, sub, fn) => h('button', { type: 'button', class: 'opt', role: 'menuitem', onclick: () => { menu.remove(); fn(); } }, h('b', null, label), h('span', { class: 'sg-soft' }, sub));
      const menu = h('div', { id: MENU_ID, class: 'sg sg-card', role: 'menu', style: 'left:' + Math.min(x, innerWidth - 300) + 'px;top:' + Math.max(8, y - 120) + 'px' },
        opt('Close only this cleaning', AE.CLEANING_PROGRAMS[items[0].programId] || 'This arrival', single),
        opt(name + ': close all ' + items.length, items.map((it) => AE.CLEANING_PROGRAMS[it.programId]).join(' + '), all));
      document.body.appendChild(menu);
      const off = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', off, true); } };
      setTimeout(() => document.addEventListener('mousedown', off, true), 0);
      return menu;
    }
    const INTRO_KEY = 'ae_dualcast_intro_seen';
    function castIntro(btn, items, force) {
      if (!force && GM_getValue(INTRO_KEY, false)) return;
      document.getElementById(INTRO_ID)?.remove();
      const [iconId, name] = castOf(items.length);
      const names = items.map((it) => AE.CLEANING_PROGRAMS[it.programId] || 'Cleaning');
      const bubble = h('div', { id: INTRO_ID, class: 'sg sg-card', role: 'dialog', 'aria-label': name },
        h('div', { class: 'hd' }, h('span', { html: AE.actionIcon(iconId, 28), style: 'line-height:0' }), h('b', null, name)),
        h('p', null, 'This device has ' + items.length + ' cleanings waiting (' + names.join(' + ') + '). Click to create them all, one after the other, after one confirmation.'),
        h('p', null, h('b', null, 'Right-click'), ' to close ', h('b', null, 'only this cleaning'), ' instead.'),
        h('p', { class: 'sg-soft' }, 'With one cleaning waiting, this button is Swiftcast; with three or more, Triplecast.'),
        h('div', { class: 'sg-actions' }, h('button', { type: 'button', class: 'sg-btn sg-primary', onclick: () => { GM_setValue(INTRO_KEY, true); bubble.remove(); } }, 'Got it')));
      document.body.appendChild(bubble);
      const place = () => {
        if (!btn.isConnected || !bubble.isConnected) { bubble.remove(); return; }
        const r = btn.getBoundingClientRect();
        bubble.style.left = Math.max(8, Math.min(r.left - 14, innerWidth - bubble.offsetWidth - 8)) + 'px';
        bubble.style.top = Math.max(8, r.top - bubble.offsetHeight - 14) + 'px';
        bubble.style.setProperty('--tail', Math.max(14, r.left - parseFloat(bubble.style.left) + r.width / 2 - 8) + 'px');
        requestAnimationFrame(place);
      };
      place();
    }

    // Dev tools: a fake Dualcast (confirmation + progress, no API calls), and the drawer's two buttons on a test card.
    const FAKE_ITEMS = [{ arrivalId: 900001, programId: REFRESH_PROGRAM }, { arrivalId: 900002, programId: 9470 }];
    AE.hooks.dualcastFake = (opts = {}) => AE.autoClose.dualcast({ items: FAKE_ITEMS, customerName: 'Jordan Reyes', fake: { fail: !!opts.fail } });
    // n: how many cleanings the test device has waiting (1 Swiftcast, 2 Dualcast, 3 Triplecast); the explainer always shows.
    AE.hooks.dualcastButton = (n = 2) => {
      document.getElementById('sg-dual-test')?.remove();
      const items = [{ arrivalId: 900001, programId: REFRESH_PROGRAM }, { arrivalId: 900002, programId: 9470 }, { arrivalId: 900003, programId: 11009 }].slice(0, n);
      const card = h('div', { id: 'sg-dual-test', class: 'sg sg-card', style: 'position:fixed;z-index:2147483645;right:24px;bottom:24px;width:380px;padding:14px 16px' },
        h('div', { style: 'display:flex;align-items:center;margin-bottom:12px' }, h('b', { style: 'flex:1' }, 'Customer arrival (test)'),
          h('button', { type: 'button', class: 'sg-x', onclick: () => { card.remove(); document.getElementById(INTRO_ID)?.remove(); } }, '✕')),
        h('div', { class: 'sg-soft', style: 'font-size:13px;margin-bottom:12px' }, n + ' cleaning' + (n > 1 ? 's' : '') + ' waiting for Jordan Reyes\'s device. Nothing here is sent to Portal.'));
      const fake = { fail: false };
      const btn = castButton({ size: 48, items, customerName: 'Jordan Reyes', fake,
        single: () => runMany(items.slice(0, 1), 'Jordan Reyes', fake) });
      btn.style.marginRight = 'auto';
      const row = h('div', { style: 'display:flex;align-items:center;justify-content:flex-end;gap:8px' }, btn,
        h('button', { type: 'button', class: 'sg-btn', style: 'height:48px' }, 'Cancel'), h('button', { type: 'button', class: 'sg-btn sg-primary', style: 'height:48px' }, 'Check-in'));
      card.append(row);
      document.body.appendChild(card);
      if (n > 1) castIntro(btn, items, true);
    };
    const dualcastOn = () => !AE.settings.autoClose || AE.settings.autoClose.dualcast !== false;
    AE.autoClose = {
      isRunning: () => running,
      dualcastOn,
      // items: [{ arrivalId, programId }] — every cleaning waiting for one device.
      async dualcast({ items, customerName, fake }) {
        if (!items || items.length < 2 || (!fake && AE.status.blocked('autoClose'))) return;
        if (!fake && await storeClosed()) return;
        if (running) { AE.confirm({ title: 'Already running', message: 'Another cleaning is being closed out — wait for it to finish.', confirmLabel: 'OK' }); return; }
        const ok = await AE.confirm({
          title: 'Create all ' + items.length + ' cleanings?',
          message: '<b>' + AE.esc(customerName || 'Customer') + '</b><ul style="margin:6px 0 0;padding-left:20px">' +
            items.map((it) => '<li>' + AE.esc(AE.CLEANING_PROGRAMS[it.programId] || 'Cleaning') + ' <span class="sg-soft">· arrival ' + it.arrivalId + '</span></li>').join('') + '</ul>' +
            '<div class="sg-soft" style="margin-top:6px">Each one is checked in, walked to Ready for pickup, and completed as a $0 sale, one after the other.</div>' +
            (fake ? '<div style="margin-top:6px;color:#e0761a;font-weight:600">Test run from the dev tools: nothing is sent to Portal.</div>' : ''),
          warning: "Are you sure you'd like to create these cleanings? Only use this if you are the one who repaired this device!",
          confirmLabel: 'Yes, create ' + items.length + ' cleanings',
        });
        if (ok) await runMany(items, customerName, fake);
      },
      async confirmAndRun({ arrivalId, programId, customerName }) {
        if (AE.status.blocked('autoClose')) return;
        if (await storeClosed()) return; // before asking, so nobody confirms for nothing
        if (running) { AE.confirm({ title: 'Already running', message: 'Another cleaning is being closed out — wait for it to finish.', confirmLabel: 'OK' }); return; }
        const ok = await AE.confirm({
          title: 'Create this cleaning?',
          message: '<b>' + AE.esc(customerName || 'Customer') + '</b> · ' + AE.esc(AE.CLEANING_PROGRAMS[programId] || 'Cleaning') +
            '<div class="sg-soft" style="margin-top:6px">Checks in arrival ' + arrivalId + ', walks it to Ready for pickup, and completes the $0 sale.</div>',
          warning: "Are you sure you'd like to create this cleaning? Only use this if you are the one who repaired this device!",
          confirmLabel: 'Yes, create cleaning',
        });
        if (ok) await onClick(arrivalId, true);
      },
    };

    const portalCheckinButton = () => [...document.querySelectorAll('button')].find((b) => b.offsetParent && b.textContent.trim() === 'Check-in');

    async function tick() {
      const m = location.pathname.match(/^\/check-in\/arrivals\/(\d+)$/);
      const existing = document.getElementById(BTN_ID);
      if (!m) { existing?.remove(); document.getElementById(INTRO_ID)?.remove(); checkedArrivalId = null; return; }
      const arrivalId = Number(m[1]);
      if (checkedArrivalId !== arrivalId) {
        checkedArrivalId = arrivalId; isCleaning = false; siblings = []; thisArrival = null;
        existing?.remove();
        try {
          const a = unwrap(await AE.api('GET', '/api/arrivals/' + arrivalId));
          isCleaning = !!AE.CLEANING_PROGRAMS[a && a.program && a.program.programId];
          thisArrival = a;
          if (isCleaning && dualcastOn()) {
            const imei = AE.data.imeiOf(a);
            siblings = imei ? (await AE.data.arrivals()).filter((x) => x.arrivalId !== arrivalId && x.program && AE.CLEANING_PROGRAMS[x.program.programId] && AE.data.imeiOf(x) === imei) : [];
            if (siblings.length) document.getElementById(BTN_ID)?.remove(); // redraw with Dualcast beside it
          }
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
      const items = [thisArrival, ...(dualcastOn() ? siblings : [])].map((x) => ({ arrivalId: x.arrivalId, programId: x.program.programId }));
      const b = castButton({ size, items, customerName: AE.data.nameOf(thisArrival), single: () => onClick(arrivalId) });
      b.id = BTN_ID;
      b.style.marginRight = 'auto';
      footer.insertBefore(b, footer.firstChild);
      if (items.length > 1) castIntro(b, items);
    }
    AE.every(1000, tick);
  },
});

// ===== 30-galaxy.js =====
/*
  Macrocosmos (Galaxy Diagnostics exception) — two halves sharing data through
  Tampermonkey storage (GM_*, scoped per script, not per site):

  A. Portal WO page: once a "GSPN No. ######" badge exists, shows a
     draggable, collapsible button. Click → gathers IMEI / device name /
     GSPN ticket / WO number from Portal API, plus the technician,
     email and store from the logged-in user (overridable in settings),
     and opens the Sprinklr form in a new tab.
  B. Sprinklr form: picks up that handoff and fills every field, including
     the Issue → Exception → Reason cascade. It does NOT submit. No status
     card: the Macrocosmos macro icon (gear and all) sits where the button was
     on Portal (gde_btn_pos), its cooldown sweep filling field by field; done →
     it flashes like a skill coming off cooldown, then fades away with a
     drop downwards (no wipe). If fields couldn't be
     filled, it stays with a ✕ and a note listing them; click to dismiss.

  Filling needs real interactions: element.click() for the custom
  dropdowns, and the native value setter + input event for text fields
  (plain .value = doesn't register with React).
*/
AE.crystal({
  id: 'galaxy',
  name: 'Macrocosmos',
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
      let demoWo = null; // dev tools: show the button on this WO even without a GSPN ticket
      // Position persists across reloads and SPA route changes — tick()
      // rebuilds the button often, so this can't be a local variable.
      const POS_KEY = 'gde_btn_pos';
      const loadPos = () => GM_getValue(POS_KEY, { right: 16, bottom: 16 });
      const savePos = (pos) => GM_setValue(POS_KEY, pos);

      // Window listeners added once; the button's mousedown points dragState
      // at whichever button currently exists.
      let dragState = null, suppressNextClick = false;
      window.addEventListener('mousemove', (e) => {
        if (!dragState) return;
        // A few pixels of wobble is still a click, not a drag.
        if (!dragState.moved && Math.hypot(e.clientX - dragState.startX, e.clientY - dragState.startY) < 4) return;
        dragState.wrap.style.right = Math.max(0, dragState.startRight - (e.clientX - dragState.startX)) + 'px';
        dragState.wrap.style.bottom = Math.max(0, dragState.startBottom - (e.clientY - dragState.startY)) + 'px';
        dragState.moved = true;
        dragState.wrap.classList.add('dragging');
        placeIntro();
      });
      window.addEventListener('mouseup', () => {
        if (!dragState) return;
        savePos(clampToViewport(dragState.wrap));
        // Only the click belonging to this mouseup is swallowed.
        dragState.wrap.classList.remove('dragging');
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
        if (!json || !json.workorder) throw new Error('Portal returned no work order data');
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

      // The button is the Macrocosmos action icon, like a hotbar slot: click
      // to file, drag it to move (Settings → Macrocosmos resets the spot).
      const BTN_CSS = `
      #sg-galaxy-btn { position:fixed; z-index:2147483645; width:56px; height:56px; padding:0; border:0; border-radius:14px; cursor:pointer;
        background:#000; box-shadow:0 6px 20px rgba(12,14,17,.35), 0 0 0 2px rgba(255,255,255,.9), 0 0 0 3px rgba(0,0,0,.35); transition:transform .12s, box-shadow .12s; }
      #sg-galaxy-btn img { display:block; width:56px; height:56px; border-radius:14px; box-shadow:none; pointer-events:none; }
      #sg-galaxy-btn:hover { transform:translateY(-1px); box-shadow:0 8px 24px rgba(12,14,17,.4), 0 0 0 2px #ffd97a, 0 0 14px 3px rgba(255,217,122,.55); }
      #sg-galaxy-btn:active { transform:scale(.96); }
      #sg-galaxy-btn:focus-visible { outline:3px solid var(--aui-primary, #8223d2); outline-offset:3px; }
      #sg-galaxy-btn:disabled { cursor:progress; }
      #sg-galaxy-btn:disabled img { filter:brightness(.45) saturate(.6); }
      #sg-galaxy-btn .sg-spin { position:absolute; left:50%; top:50%; width:22px; height:22px; margin:-11px 0 0 -11px; border-width:3px; display:none; }
      #sg-galaxy-btn:disabled .sg-spin { display:block; }
      /* It's a macro, so it wears the hotbar's macro gear and shows its "macro name" on hover. */
      #sg-galaxy-btn .gear { position:absolute; left:-4px; top:-4px; width:16px; height:16px; pointer-events:none;
        filter:drop-shadow(0 1px 1px rgba(0,0,0,.8)); }
      #sg-galaxy-btn .mname { position:absolute; left:50%; bottom:calc(100% + 10px); transform:translate(-50%, 4px); opacity:0; pointer-events:none;
        padding:5px 10px 4px; border-radius:6px; white-space:nowrap; transition:opacity .12s, transform .12s;
        background:linear-gradient(#3b3b3b, #1e1e1e); border:1px solid #6b6154; box-shadow:0 0 0 1px #000, 0 4px 12px rgba(0,0,0,.45);
        color:#f2ecdf; text-shadow:0 1px 1px #000; font:400 15px/1.2 "Myriad Pro", Myriad, "Meiryo UI", Meiryo, "Segoe UI", sans-serif; letter-spacing:.01em; }
      #sg-galaxy-btn:hover .mname, #sg-galaxy-btn:focus-visible .mname { opacity:1; transform:translate(-50%, 0); }
      #sg-galaxy-btn.dragging .mname, #sg-galaxy-btn.intro .mname { opacity:0; } /* the explainer sits where the name would */
      /* First-time explainer, pointing at the button */
      #sg-galaxy-intro { position:fixed; z-index:2147483646; width:300px; padding:16px 16px 14px; font-size:14px; line-height:1.45; animation:sg-in .2s ease-out; }
      #sg-galaxy-intro .ae { position:absolute; top:10px; right:10px; color:var(--aui-primary, #8223d2); line-height:0; }
      #sg-galaxy-intro b { display:block; margin:0 28px 6px 0; font-size:15px; }
      #sg-galaxy-intro a { color:var(--aui-primary, #8223d2); font-weight:700; cursor:pointer; text-decoration:underline; }
      #sg-galaxy-intro .sg-actions { margin-top:12px; justify-content:flex-end; }
      #sg-galaxy-intro .sg-actions .sg-btn { flex:none; }
      #sg-galaxy-intro .tail { position:absolute; width:14px; height:14px; background:inherit; border:inherit; border-width:0 1px 1px 0; transform:rotate(45deg); }
      `;
      const INTRO_KEY = 'ae_galaxy_intro_seen';
      // Place the explainer beside the button (above it if there's room, else below), tail pointing at it.
      function placeIntro() {
        const pop = document.getElementById('sg-galaxy-intro'), btn = document.getElementById('sg-galaxy-btn');
        if (!pop || !btn) return;
        const b = btn.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight, gap = 14;
        const above = b.top - ph - gap >= 8;
        const left = Math.min(Math.max(8, b.left + b.width / 2 - pw + 40), innerWidth - pw - 8);
        pop.style.left = left + 'px';
        pop.style.top = (above ? b.top - ph - gap : b.bottom + gap) + 'px';
        const tail = pop.querySelector('.tail');
        tail.style.left = Math.min(Math.max(12, b.left + b.width / 2 - left - 7), pw - 26) + 'px';
        tail.style.top = above ? (ph - 8) + 'px' : '-8px';
        tail.style.transform = above ? 'rotate(45deg)' : 'rotate(225deg)';
      }
      function dismissIntro() { GM_setValue(INTRO_KEY, true); document.getElementById('sg-galaxy-intro')?.remove(); document.getElementById('sg-galaxy-btn')?.classList.remove('intro'); }
      function showIntro() {
        if (GM_getValue(INTRO_KEY, false) || document.getElementById('sg-galaxy-intro')) return;
        const link = h('a', { role: 'button', tabindex: '0', onclick: () => { dismissIntro(); AE.openSettings('galaxy'); } }, 'click here');
        const pop = h('div', { id: 'sg-galaxy-intro', class: 'sg sg-card', role: 'dialog', 'aria-label': 'About the Macrocosmos button' },
          h('span', { class: 'ae', title: AE_NAME, html: icon('aetheryte', 22) }),
          h('b', null, 'Macrocosmos'),
          h('div', null, 'Click this button to automatically file the Galaxy Diagnostics exception for this device. If you need to change the values used in the form, ', link, ' to change them.'),
          h('div', { class: 'sg-actions' }, h('button', { type: 'button', class: 'sg-btn sg-primary', onclick: dismissIntro }, 'Got it')),
          h('span', { class: 'tail' }));
        document.body.appendChild(pop);
        document.getElementById('sg-galaxy-btn')?.classList.add('intro');
        placeIntro();
      }
      window.addEventListener('resize', placeIntro);
      function makeButton() {
        if (!document.getElementById('sg-galaxy-css')) document.head.append(h('style', { id: 'sg-galaxy-css' }, BTN_CSS));
        const pos = loadPos();
        const main = h('button', { type: 'button', id: 'sg-galaxy-btn', class: 'sg',
          'aria-label': 'GD Exception: file the Galaxy Diagnostics exception for this WO',
          style: 'right:' + pos.right + 'px;bottom:' + pos.bottom + 'px',
          html: AE.actionIcon('galaxy', 56) + '<img class="gear" src="' + AE.asset('ui/macro-gear') + '" alt="">'
            + '<span class="mname">GD Exception</span><span class="sg-spin"></span>' });
        const wrap = main; // drag + clamp act on the button itself
        main.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          const r = wrap.getBoundingClientRect();
          dragState = { wrap, startX: e.clientX, startY: e.clientY, startRight: innerWidth - r.right, startBottom: innerHeight - r.bottom, moved: false };
          e.preventDefault(); // no text selection / image drag while moving
        });
        main.onclick = async () => {
          if (suppressNextClick) { suppressNextClick = false; return; }
          dismissIntro(); // using it counts as having read it
          if (AE.status.blocked('galaxy')) return;
          if (demoWo && !gspnTicketOnPage()) { toast('Demo button (dev tools): on a real Samsung WO with a GSPN ticket this files the exception.', 'ok', 'bottom'); return; }
          AE.track('galaxy:file');
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
        document.body.appendChild(wrap);
        savePos(clampToViewport(wrap));
        showIntro();
      }

      // Dev tools: the button + first-time explainer on the current WO, whatever it is.
      AE.hooks.galaxyDemo = () => {
        const woId = currentWoId();
        if (!woId) return false;
        demoWo = woId; GM_deleteValue(INTRO_KEY);
        document.getElementById('sg-galaxy-btn')?.remove(); document.getElementById('sg-galaxy-intro')?.remove();
        injectedForWoId = null;
        return true;
      };

      AE.every(1000, () => {
        const woId = currentWoId();
        const existing = document.getElementById('sg-galaxy-btn');
        if (!woId) { existing?.remove(); document.getElementById('sg-galaxy-intro')?.remove(); injectedForWoId = null; return; }
        const ticket = gspnTicketOnPage() || (demoWo === woId ? 'demo' : null);
        if (ticket && (injectedForWoId !== woId || !existing)) { existing?.remove(); makeButton(); injectedForWoId = woId; }
        else if (!ticket && existing) { existing.remove(); document.getElementById('sg-galaxy-intro')?.remove(); injectedForWoId = null; }
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

      // The macro icon, cast-style, where the Portal button was.
      const CAST_CSS = `
        #sg-galaxy-cast { position:fixed; z-index:2147483646; width:56px; height:56px; border-radius:14px; cursor:default; box-shadow:0 6px 20px rgba(12,14,17,.35);
          animation:sg-in .2s ease-out; }
        #sg-galaxy-cast .sg-spell { box-shadow:0 0 0 2px #1a1a1f, 0 0 0 3.5px #c9a75a; }
        #sg-galaxy-cast .sg-spell .mark { min-width:20px; height:20px; font-size:12px; line-height:20px; right:3px; bottom:3px; }
        #sg-galaxy-cast .gear { position:absolute; left:-4px; top:-4px; width:16px; height:16px; pointer-events:none; z-index:2; }
        #sg-galaxy-cast .mname { position:absolute; left:50%; bottom:calc(100% + 8px); transform:translateX(-50%); white-space:nowrap; padding:2px 7px; border-radius:6px;
          background:rgba(12,12,18,.85); color:#fff; font:600 12px "Myriad Pro", Myriad, Meiryo, "Helvetica Neue", Arial, sans-serif; }
        #sg-galaxy-cast.leave { animation:sg-cast-leave .7s ease-in forwards; }
        #sg-galaxy-cast.failed { cursor:pointer; }
        @keyframes sg-cast-leave { from { opacity:1; transform:none; } to { opacity:0; transform:translateY(24px); } }
        @media (prefers-reduced-motion: reduce) { #sg-galaxy-cast.leave { animation:sg-fade-out .3s forwards; } @keyframes sg-fade-out { to { opacity:0; } } }
      `;
      function castIcon(total) {
        AE.ensureCss();
        if (!document.getElementById('sg-galaxy-cast-css')) document.head.append(h('style', { id: 'sg-galaxy-cast-css' }, CAST_CSS));
        document.getElementById('sg-galaxy-cast')?.remove();
        const pos = GM_getValue('gde_btn_pos', { right: 16, bottom: 16 });
        const spell = AE.spellIcon('galaxy', 56);
        const el = h('div', { id: 'sg-galaxy-cast', class: 'sg', title: 'GD Exception: filling the form…',
          style: 'right:' + Math.min(pos.right, Math.max(0, innerWidth - 60)) + 'px;bottom:' + Math.min(pos.bottom, Math.max(0, innerHeight - 60)) + 'px' },
          spell, h('img', { class: 'gear', src: AE.asset('ui/macro-gear'), alt: '' }), h('span', { class: 'mname' }, 'GD Exception'));
        document.body.appendChild(el);
        let done = 0, shown = 0, target = 0, anim = null;
        const paint = () => spell.style.setProperty('--a', Math.round(shown * 360) + 'deg');
        const to = (p) => {
          target = Math.min(1, p);
          if (anim) return;
          const tick = () => { shown += (target - shown) * 0.2; if (Math.abs(target - shown) < 0.002) shown = target; paint(); anim = shown === target ? null : requestAnimationFrame(tick); };
          anim = requestAnimationFrame(tick);
        };
        paint();
        return {
          step() { done++; to(Math.min(done / total, 0.97)); },
          finish(ok, note) {
            to(1);
            AE.spellDone(spell, ok ? 'ok' : 'err');
            if (ok) {
              el.title = 'GD Exception: filled — check it over, then hit Submit yourself.';
              setTimeout(() => { el.classList.add('leave'); setTimeout(() => el.remove(), 750); }, 2400); // after the flash
            } else {
              el.classList.add('failed');
              el.title = note + ' Click to dismiss.';
              toast(note, 'err');
              el.onclick = () => { el.remove(); document.getElementById('sg-galaxy-toast')?.remove(); };
            }
          },
        };
      }

      async function fill() {
        const data = takeHandoff();
        if (!data) return; // not opened from the WO button, or stale
        const total = 13 + (data.storeEmail ? 1 : 0); // email + the 12 fields below (+ store email)
        const cast = castIcon(total);
        const email = await waitForField('Your email address', 8000);
        if (!email) { cast.finish(false, 'Form did not load in time — fill it in by hand.'); return; }

        const failed = [];
        const step = async (label, ok) => { if (!(await ok)) failed.push(label); cast.step(); };
        setNativeValue(email, data.email);
        cast.step();
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

        if (failed.length) cast.finish(false, 'WO ' + data.woId + ': could NOT fill ' + failed.join(', ') + ' — fill those in by hand before submitting.');
        else cast.finish(true);
      }
      setTimeout(fill, 800); // the form renders client-side
    }
  },
});

// ===== 40-print-labels.js =====
/*
  Quick Synthesis (print all labels) — on a PO Receive page, a "Print all labels" button next
  to "Generate Labels" that opens each serial row's ⋮ → Print Label in turn,
  paced (settings → delay) so a DYMO LabelWriter keeps up. Print-only: it
  never receives or changes stock.

  If Portal renames its hooks, update SEL_MENU_BTN / SEL_PRINT_OPT.
*/
AE.crystal({
  id: 'printLabels',
  name: 'Quick Synthesis',
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
      ui.panel.title('Synthesizing… (' + total + ')');
      const paint = () => {
        count.textContent = done + ' / ' + total + ' sent' + (missed.length ? ' · ' + missed.length + ' missed' : '');
        bar.firstChild.style.width = Math.round(((done + missed.length) / total) * 100) + '%';
        ui.panel.progress(done + missed.length, total); // the spell icon's cooldown sweep
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

    function newUi() { return { panel: AE.progressPanel('Quick Synthesis', { clock: false, icon: 'printLabels' }), running: false, stop: false }; }

    async function onClickPrintAll() {
      if (AE.status.blocked('printLabels')) return;
      AE.track('printLabels:run');
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
      ui.panel.title('Quick Synthesis · ' + rows.length + ' labels');
      ui.panel.body.innerHTML = 'Ready to print <b>' + rows.length + '</b> labels, one every ' + DELAY_MS + ' ms (~' +
        Math.ceil((rows.length * (DELAY_MS + 150)) / 1000) + ' s).<div class="sg-soft" style="margin:6px 0 12px">Make sure the DYMO label printer is on and loaded.</div>';
      ui.panel.actions(
        btn('Cancel', '', () => { ui.panel.el.remove(); active = null; }),
        btn('Print ' + rows.length, 'sg-primary', () => runRows(serialRows(), ui)));
    }

    // ---- button next to "Generate Labels", styled like Portal's ----
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

// ===== 45-buybacks.js =====
/*
  Bountiful Yield (buyback add-all) — on a buyback order's "Add buyback parts" popout
  (and, since 2.16, an RMA order's "Add RMA parts" popout: one "Add all RMA
  parts" button; the serial is read from under the part name)
  (Buybacks tab), adds bulk-add buttons:

    Add all Apple devices (TLC)          destination "Asurion Reverse Logistics"
    Add all Samsung/Google parts (UROC)  destination mentions UROC

  Each clicks the row's own add button one at a time, keyed by serial number
  (the table re-renders after every add), waiting for the row to leave the
  list and the list to refill before the next. Safety limits stop a run from
  ever spinning: per-row retry cap, stall detection with a bounded tab-bounce
  recovery, a click cap and a wall-clock cap. A Stop button halts it.

  Crystallized Sep 26 2026 from the standalone "Select All - Buybacks" v1.1.1
  (Tampermonkey on Zen). Its buttons often didn't appear because its @match
  was only /boh/inventory/buyback-order/* — Tampermonkey injects on a real
  page load and Portal is a single-page app, so arriving from any other
  portal page meant the script never ran (removing + re-adding it forced a
  reinject). As a crystal it runs portal-wide and gates on the path itself.
*/
AE.crystal({
  id: 'buybacks',
  name: 'Bountiful Yield',
  sites: ['portal.ubreakifix.net'],
  run() {
    const { h } = AE;
    // Two pages, same idea: a buyback order's "Add buyback parts" popout and an
    // RMA order's "Add RMA parts" popout. The mode comes from the page.
    const MODES = {
      buyback: {
        path: /^\/boh\/inventory\/buyback-order\//, heading: /^\s*add\s+buyback\s+parts\s*$/i,
        headers: (hs) => hs.includes('serial number') && hs.includes('destination'), anchor: /^salvages\s*\(\d+\)/i,
      },
      rma: {
        path: /^\/boh\/inventory\/rma-order\//, heading: /^\s*add\s+rma\s+parts\s*$/i,
        headers: (hs) => hs.includes('part') && hs.includes('return value'), anchor: /^rmas\s*\(\d+\)/i,
      },
    };
    const mode = () => Object.keys(MODES).find((k) => MODES[k].path.test(location.pathname)) || null;
    const TOOLBAR_ID = 'sg-buyback-toolbar';

    // Safety limits — these are what stop a run from ever spinning forever.
    const SETTLE_MS = 8000;           // max wait for a clicked row to leave the list
    const REFRESH_MS = 8000;          // max wait for the list to repopulate after an add
    const GAP_MS = 300;               // pause between adds
    const MAX_STALLS = 3;             // consecutive no-effect clicks -> abort
    const MAX_TRIES = 2;              // attempts allowed per individual row
    const MAX_RECOVER = 2;            // tab-bounce recovery attempts per run
    const HARD_CAP = 500;             // absolute click ceiling per run
    const WALL_MS = 10 * 60 * 1000;   // absolute time ceiling per run

    const GROUPS = {
      apple: { label: 'Apple devices', hint: 'TLC', variant: 'sg-primary', test: (d) => /asurion\s+reverse\s+logistics/i.test(d) },
      samsungGoogle: { label: 'Samsung/Google parts', hint: 'UROC', variant: 'sg-outline', test: (d) => /\buroc\b/i.test(d) },
      rma: { label: 'RMA parts', hint: '', variant: 'sg-primary', test: () => true },
    };
    const groupsFor = (m) => (m === 'rma' ? ['rma'] : ['apple', 'samsungGoogle']);

    document.head.append(h('style', null, `
      #${TOOLBAR_ID} { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin:8px 0 12px; }
      #${TOOLBAR_ID} .sg-outline { border-color:var(--aui-primary,#8223d2); color:var(--aui-primary,#8223d2); }
      #${TOOLBAR_ID} .sg-outline:hover { background:var(--aui-primary-soft,#faecff); }
      #${TOOLBAR_ID} .sg-btn:disabled { opacity:.45; cursor:not-allowed; }
      #${TOOLBAR_ID} .count { font-weight:700; }
      #${TOOLBAR_ID} .status { display:inline-flex; align-items:center; gap:6px; font-size:13px; color:var(--aui-on-surface-soft,#5d5e61); }
      #${TOOLBAR_ID} .sg-spin { width:14px; height:14px; }
    `));

    const state = { running: false, cancel: false, status: '' };
    const sleep = AE.sleep;
    function waitUntil(fn, timeout) {
      return new Promise((resolve) => {
        const t0 = Date.now();
        const iv = setInterval(() => {
          let ok = false;
          try { ok = !!fn(); } catch (_) { ok = false; }
          if (ok) { clearInterval(iv); resolve(true); }
          else if (state.cancel || Date.now() - t0 > timeout) { clearInterval(iv); resolve(false); }
        }, 100);
      });
    }

    // ---------- page structure ----------
    // Dialog libraries sometimes keep a closed popout mounted (hidden); a
    // leftover from a previous buyback still matches the heading, so only
    // visible matches count, and the most recently mounted (last) wins.
    function isVisible(el) {
      if (!el) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (el.offsetParent === null && style.position !== 'fixed') return false;
      return true;
    }
    function getModal() {
      const m = mode();
      if (!m) return null;
      const heads = [...document.querySelectorAll('h1,h2,h3')]
        .filter((e) => MODES[m].heading.test(e.textContent || ''))
        .filter(isVisible);
      const hd = heads[heads.length - 1];
      let n = hd;
      for (let i = 0; i < 12 && n; i++) { n = n.parentElement; if (n && n.querySelector('table')) return n; }
      return null;
    }
    const tabButtons = (modal, re) => [...modal.querySelectorAll('button,[role="tab"]')].filter((b) => re.test((b.innerText || '').trim()));
    // The Damaged tab has identical columns; the active tab is the only reliable tell.
    function buybacksTabActive(modal) {
      if (mode() === 'rma') return true; // the RMA popout has no tabs
      const tabs = tabButtons(modal, /^buybacks\s*\(\d+\)$/i);
      return tabs.length > 0 && tabs.some((b) => b.getAttribute('aria-selected') === 'true');
    }
    function getTable(modal) {
      if (!modal) return null;
      const m = mode();
      return [...modal.querySelectorAll('table')].find((t) => {
        const hs = [...t.querySelectorAll('thead th')].map((x) => (x.innerText || '').trim().toLowerCase());
        return m && MODES[m].headers(hs);
      }) || null;
    }
    const colIdx = (table, re) => [...table.querySelectorAll('thead th')].findIndex((th) => re.test((th.innerText || '').trim()));
    const btnEnabled = (b) => b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
    function getRows(table) {
      if (!table) return [];
      if (mode() === 'rma') {
        // Part cell = name with the serial underneath; the last cell holds "+".
        const pi = colIdx(table, /^part$/i), mi = colIdx(table, /manufacturer/i);
        if (pi < 0) return [];
        return [...table.querySelectorAll('tbody tr')].map((tr) => {
          const c = tr.children, text = c[pi] ? (c[pi].innerText || '').trim() : '';
          const serial = (text.match(/\b\d+-\d{6,}\b/) || [text.split('\n').pop().trim()])[0];
          return { tr, serial, dest: mi >= 0 && c[mi] ? (c[mi].innerText || '').trim() : '', btn: tr.querySelector('td:last-child button') };
        }).filter((r) => r.serial && btnEnabled(r.btn));
      }
      const si = colIdx(table, /serial\s*number/i), di = colIdx(table, /destination/i);
      if (si < 0 || di < 0) return [];
      return [...table.querySelectorAll('tbody tr')].map((tr) => {
        const c = tr.children;
        return { tr, serial: c[si] ? (c[si].innerText || '').trim() : '', dest: c[di] ? (c[di].innerText || '').trim() : '', btn: tr.querySelector('td:last-child button') };
      }).filter((r) => r.serial && btnEnabled(r.btn));
    }
    const groupRows = (table, key) => getRows(table).filter((r) => GROUPS[key].test(r.dest));
    // The list empties for a moment while it refetches after every add —
    // never treat that as "finished" without giving it time to come back.
    const listRepopulated = (key) => waitUntil(() => { const t = getTable(getModal()); return t && groupRows(t, key).length > 0; }, REFRESH_MS);
    // If clicks stop registering, bouncing tabs re-renders the rows with fresh handlers. Read-only, bounded.
    async function recover(key) {
      const modal = getModal();
      if (!modal || mode() === 'rma') return false; // no tabs to bounce on the RMA popout
      const bb = tabButtons(modal, /^buybacks\s*\(\d+\)$/i)[0];
      const dmg = tabButtons(modal, /^damaged\s*\(\d+\)$/i)[0];
      if (!bb) return false;
      if (dmg) { try { dmg.click(); } catch (_) {} await sleep(600); }
      try { bb.click(); } catch (_) {}
      await sleep(600);
      return listRepopulated(key);
    }

    // ---------- UI ----------
    function buildToolbar() {
      const mk = (key) => h('button', { type: 'button', class: 'sg sg-btn ' + GROUPS[key].variant, 'data-group': key, onclick: () => addAll(key) });
      const bar = h('div', { id: TOOLBAR_ID, class: 'sg', 'data-mode': mode() });
      bar._groups = groupsFor(mode()).map(mk);
      bar._stop = h('button', { type: 'button', class: 'sg sg-btn sg-danger', onclick: () => { state.cancel = true; setStatus('Stopping…'); } }, '■ Stop');
      bar._status = h('span', { class: 'status' });
      bar.append(...bar._groups, bar._stop, bar._status);
      return bar;
    }
    function refreshToolbar() {
      const bar = document.getElementById(TOOLBAR_ID);
      if (!bar) return;
      const table = getTable(getModal());
      const label = (key, n) => 'Add all ' + GROUPS[key].label + (GROUPS[key].hint ? ' (' + GROUPS[key].hint + ')' : '') + ' · <span class="count">' + n + '</span>';
      const setHtml = (el, html) => { if (el.innerHTML !== html) el.innerHTML = html; };
      for (const btn of bar._groups) {
        const n = table ? groupRows(table, btn.dataset.group).length : 0;
        setHtml(btn, label(btn.dataset.group, n));
        btn.disabled = state.running || n === 0;
      }
      bar._stop.style.display = state.running ? '' : 'none';
      setHtml(bar._status, (state.running ? '<span class="sg-spin"></span>' : '') + AE.esc(state.status || ''));
    }
    const setStatus = (t) => { state.status = t; refreshToolbar(); };

    function anchorFor(modal, table) {
      const p = [...modal.querySelectorAll('p,div,span,h4')]
        .find((e) => e.children.length <= 2 && MODES[mode()].anchor.test((e.innerText || '').trim()));
      if (p && p.parentElement) return { parent: p.parentElement, next: p.nextSibling };
      let n = table;
      while (n.parentElement && n.parentElement !== modal) n = n.parentElement;
      return { parent: n.parentElement || modal, next: n };
    }

    function sync() {
      const existing = document.getElementById(TOOLBAR_ID);
      if (!mode()) { if (existing && !state.running) existing.remove(); return; }
      if (existing && existing.dataset.mode !== mode() && !state.running) existing.remove();
      const modal = getModal();
      const table = modal ? getTable(modal) : null;
      if (!modal || !table || !buybacksTabActive(modal)) { if (existing && !state.running) existing.remove(); return; }
      if (!existing || !modal.contains(existing)) {
        if (existing) existing.remove();
        const { parent, next } = anchorFor(modal, table);
        parent.insertBefore(buildToolbar(), next);
      }
      refreshToolbar();
    }

    // ---------- the run ----------
    async function addAll(key) {
      if (AE.status.blocked('buybacks')) return;
      AE.track(mode() === 'rma' ? 'buybacks:addAllRma' : 'buybacks:addAll');
      if (state.running) return;
      const g = GROUPS[key];
      state.running = true; state.cancel = false;
      const tries = new Map();
      const t0 = Date.now();
      let clicks = 0, added = 0, stalls = 0, recoveries = 0;
      setStatus('Starting…');
      try {
        while (true) {
          if (state.cancel) { setStatus('Stopped — ' + added + ' added.'); break; }
          if (Date.now() - t0 > WALL_MS) { setStatus('Time limit reached — ' + added + ' added.'); break; }
          if (clicks >= HARD_CAP) { setStatus('Safety cap (' + HARD_CAP + ') reached — ' + added + ' added.'); break; }
          const modal = getModal();
          if (!modal) { setStatus('Popout closed — ' + added + ' added.'); break; }
          if (!buybacksTabActive(modal)) { setStatus('Left the Buybacks tab — ' + added + ' added.'); break; }
          const table = getTable(modal);
          if (!table) { setStatus('List not found — ' + added + ' added.'); break; }
          const rows = groupRows(table, key);
          if (!rows.length) {
            // Could be the post-add refresh rather than a finished list.
            setStatus('Waiting for the list to refresh… (' + added + ' added)');
            if (!(await listRepopulated(key))) {
              // RMAs have a line limit; Portal disables "+" once it's reached.
              const limited = mode() === 'rma' && /line limit for an rma/i.test((getModal() || {}).innerText || '');
              setStatus(limited ? 'RMA line limit reached — added ' + added + '.' : 'Done — added ' + added + ' ' + g.label + '.');
              break;
            }
            continue;
          }
          // Keyed by serial, never index; a per-serial attempt cap makes retry loops impossible.
          const next = rows.find((r) => (tries.get(r.serial) || 0) < MAX_TRIES);
          if (!next) { setStatus('Stopped — ' + added + ' added, ' + rows.length + ' would not add.'); break; }
          const serial = next.serial;
          tries.set(serial, (tries.get(serial) || 0) + 1);
          setStatus('Adding ' + g.label + ' — ' + added + ' done, ' + rows.length + ' left…');
          try { next.btn.click(); } catch (_) {}
          clicks++;
          const gone = await waitUntil(() => { const t = getTable(getModal()); return !t || !getRows(t).some((r) => r.serial === serial); }, SETTLE_MS);
          if (gone) { added++; stalls = 0; }
          else {
            stalls++;
            if (stalls >= MAX_STALLS) {
              if (recoveries < MAX_RECOVER) {
                recoveries++;
                setStatus('No response — refreshing the list (attempt ' + recoveries + '/' + MAX_RECOVER + ')…');
                const ok = await recover(key);
                stalls = 0;
                if (ok) continue;
              }
              setStatus('Stopped: adds stopped registering — ' + added + ' added. Check whether the order needs its parts scanned first.');
              break;
            }
          }
          await listRepopulated(key); // let the list come back before the next click
          await sleep(GAP_MS);
        }
      } finally {
        state.running = false; state.cancel = false;
        refreshToolbar();
      }
    }

    let tid = null;
    new MutationObserver(() => {
      if (tid) return;
      tid = setTimeout(() => { tid = null; try { sync(); } catch (_) {} }, 200);
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected'] });
    sync();
  },
});

// ===== 50-glamour.js =====
/*
  Glamour (page theming) — recolours the whole portal by overriding its own
  design tokens (--aui-*), so every portal screen and every crystal follows.

  A theme is just three colours: background, text and accent. The rest of
  the palette (surfaces, outlines, soft text, the primary's soft/on shades)
  is derived from those, for light or dark depending on the background.
  Status colours (success/error/warning) and the brand accents are left
  alone so their meaning doesn't change.

  Presets are FFXIV-flavoured; users can also make their own. "Portal" means
  no override at all. The engine is set up at load (not in run()) so the
  Settings editor can preview live even while the crystal is switched off.
*/
AE.glamour = (() => {
  const { h } = AE;
  const STYLE_ID = 'sg-glamour';

  const PRESETS = [
    { id: 'portal', name: 'Portal', note: 'Portal as it ships' },
    { id: 'limsa', name: 'Limsa Lominsa', bg: '#f2f6fa', fg: '#122232', accent: '#1f6aa8' },
    { id: 'gridania', name: 'Gridania', bg: '#f3f6ef', fg: '#1a2618', accent: '#2f7a3b' },
    { id: 'crystarium', name: 'Crystarium', bg: '#f4f5fb', fg: '#1b1e30', accent: '#5b4fd6' },
    { id: 'uldah', name: "Ul'dah", bg: '#19140d', fg: '#f4ead8', accent: '#e2b04c' },
    { id: 'ishgard', name: 'Ishgard', bg: '#0f141b', fg: '#e5edf6', accent: '#8cc2ff' },
    { id: 'void', name: 'The Void', bg: '#0e0a12', fg: '#eee4f2', accent: '#e0567a' },
  ];

  // --- colour maths (sRGB hex) ---
  const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
  const hex = (c) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
  const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
  const lum = (c) => { const [r, g, b] = rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const validHex = (v) => /^#[0-9a-f]{6}$/i.test(v || '');

  // Three colours -> Portal's surface/text/primary tokens.
  function tokens({ bg, fg, accent }) {
    const dark = lum(bg) < 0.18;
    const onAccent = contrast(accent, '#ffffff') >= contrast(accent, '#0c0e11') ? '#ffffff' : '#0c0e11';
    return {
      'sub-surface': dark ? mix(bg, '#000000', 0.45) : mix(bg, fg, 0.05),
      'surface': bg,
      'surface-variant': mix(bg, fg, dark ? 0.05 : 0.025),
      'on-surface': fg,
      'on-surface-soft': mix(fg, bg, 0.32),
      'outline': mix(fg, bg, 0.58),
      'outline-soft': mix(fg, bg, dark ? 0.78 : 0.88),
      'elevated-level-01': dark ? mix(bg, fg, 0.06) : bg,
      'elevated-level-02': dark ? mix(bg, fg, 0.09) : bg,
      'elevated-level-03': dark ? mix(bg, fg, 0.11) : bg,
      'elevated-dynamic-card': dark ? mix(bg, fg, 0.04) : bg,
      'primary': accent,
      'on-primary': onAccent,
      'primary-soft': mix(bg, accent, dark ? 0.28 : 0.12),
      'on-primary-soft': dark ? mix(accent, '#ffffff', 0.35) : mix(accent, '#000000', 0.35),
      'inverse-primary': mix(accent, dark ? '#000000' : '#ffffff', 0.35),
      'secondary': mix(bg, accent, dark ? 0.22 : 0.14),
      'on-secondary': fg,
      'neutral': fg,
      'on-neutral': bg,
      'neutral-soft': mix(bg, fg, dark ? 0.16 : 0.07),
      'on-neutral-soft': mix(fg, bg, 0.12),
      'inverse-surface': fg,
      'inverse-on-surface': bg,
    };
  }

  const find = (cfg, id) => PRESETS.find((p) => p.id === id) || (cfg.custom || []).find((c) => c.id === id);

  /*
    Portal's light/dark mode is a class on <body> (asurion-light/asurion-dark),
    and some of its styles hang off it rather than the tokens — e.g. the
    ubreakifix logo is one dark PNG that dark mode turns white with a CSS
    filter. So a dark theme also puts Portal in dark mode (and a light theme
    in light mode), held with an observer in case Portal flips it back.
    Portal's own choice is remembered and restored when Glamour lets go.
  */
  const MODES = ['asurion-dark', 'asurion-light'];
  let observer = null, portalMode = null, want = null;
  const modeOf = () => MODES.find((m) => document.body.classList.contains(m)) || null;
  const setMode = (m) => { document.body.classList.remove(...MODES); if (m) document.body.classList.add(m); };
  const watch = () => observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  function holdMode(next) {
    if (!document.body) return;
    if (!next) {
      observer?.disconnect(); observer = null;
      if (want) { want = null; setMode(portalMode); }
      return;
    }
    if (!want) portalMode = modeOf();
    want = next;
    if (modeOf() !== want) setMode(want);
    if (!observer) {
      observer = new MutationObserver(() => {
        const cur = modeOf();
        if (!want || cur === want) return;
        portalMode = cur; // Portal changed its mode (e.g. its own theme toggle):
        try { sessionStorage.setItem(SAVED_KEY, sessionStorage.getItem('theme') ?? NONE); } catch (_) {} // restore that one later
        observer.disconnect(); setMode(want); watch();
        portalTheme(want === 'asurion-dark' ? 'dark' : 'light');
      });
      watch();
    }
  }

  /*
    Portal's React theme. Some images are picked in code, not CSS, from
    Portal's theme state (useIsDarkThemeActive) — the Inventory icons and the
    Reports banner, for example. That state comes from sessionStorage.theme
    ('light' | 'dark' | 'system'), read when each part of the app mounts, and
    changes through the theme provider's setTheme. So Glamour:
      - sets sessionStorage.theme (anything mounted later picks it up), and
      - calls setTheme on the providers already on screen, from a small script
        run in the page (a userscript can't reach React's internals).
    Your own Portal theme is kept in ae_portal_theme and put back on release.
  */
  const SAVED_KEY = 'ae_portal_theme', NONE = '__none__';
  const PAGE_EVENT = 'aethernet:portal-theme';
  const pageHook = () => {
    if (document.getElementById('sg-glamour-hook')) return;
    // Runs in the page, so it's kept as a plain string: the minifier would
    // otherwise rewrite a function's source to lean on helpers that only
    // exist inside Aethernet. Finds every theme provider on screen by walking
    // up React's fiber tree from a node in each app, and calls its setTheme.
    const code = [
      '(function (evt) {',
      '  var fiberKey = function (n) { return Object.keys(n).find(function (k) { return k.indexOf("__reactFiber$") === 0; }); };',
      '  var providers = function () {',
      '    var found = [];',
      '    document.querySelectorAll("[id^=\\"single-spa-application\\"], .components-header, #root, body > div").forEach(function (box) {',
      '      var nodes = [box].concat(Array.prototype.slice.call(box.querySelectorAll("*"), 0, 80));',
      '      var el = nodes.find(function (n) { return fiberKey(n); });',
      '      if (!el) return;',
      '      for (var f = el[fiberKey(el)]; f; f = f.return) {',
      '        var v = f.memoizedProps && f.memoizedProps.value;',
      '        if (v && typeof v.setTheme === "function" && "selected" in v) { if (found.indexOf(v.setTheme) < 0) found.push(v.setTheme); break; }',
      '      }',
      '    });',
      '    return found;',
      '  };',
      '  document.addEventListener(evt, function (e) {',
      '    providers().forEach(function (set) { try { set(e.detail); } catch (_) {} });',
      '  });',
      '})(' + JSON.stringify(PAGE_EVENT) + ');',
    ].join('\n');
    const s = document.createElement('script');
    s.id = 'sg-glamour-hook';
    s.textContent = code;
    (document.head || document.documentElement).append(s);
  };
  function portalTheme(next) {
    try {
      const saved = sessionStorage.getItem(SAVED_KEY);
      let value;
      if (next) {
        if (saved === null) sessionStorage.setItem(SAVED_KEY, sessionStorage.getItem('theme') ?? NONE);
        value = next;
      } else {
        if (saved === null) return; // Glamour never changed it
        sessionStorage.removeItem(SAVED_KEY);
        value = saved === NONE ? 'light' : saved; // Portal's default is light
      }
      sessionStorage.setItem('theme', value);
      pageHook();
      document.dispatchEvent(new CustomEvent(PAGE_EVENT, { detail: value })); // runs setTheme synchronously
      if (!next && saved === NONE) sessionStorage.removeItem('theme'); // leave Portal as it was found
    } catch (e) { console.warn('[' + AE_NAME + '] Glamour: could not set Portal theme', e); }
  }

  // Apply a Glamour settings object ({ theme, custom }); unknown or 'portal' clears.
  function apply(cfg) {
    const t = cfg && find(cfg, cfg.theme);
    const el = document.getElementById(STYLE_ID);
    if (!t || !t.bg || ![t.bg, t.fg, t.accent].every(validHex)) { el?.remove(); holdMode(null); portalTheme(null); return; }
    const dark = lum(t.bg) < 0.18;
    portalTheme(dark ? 'dark' : 'light');
    holdMode(dark ? 'asurion-dark' : 'asurion-light');
    const vars = Object.entries(tokens(t)).map(([k, v]) => '--aui-' + k + ':' + v + ' !important;').join('');
    // Portal sets its tokens on :root and on .asurion-light/.asurion-dark
    // (the <body> class), so override on all three.
    const css = ':root, .asurion-light, .asurion-dark, .partner-light, .partner-dark {' + vars + '}'
      + 'body { background:var(--aui-sub-surface) !important; color-scheme:' + (lum(t.bg) < 0.18 ? 'dark' : 'light') + '; }';
    const style = el || h('style', { id: STYLE_ID });
    style.textContent = css;
    document.head.append(style); // (re)append so it stays after Portal's own sheets
  }

  // The Settings editor (nested under the crystal). `s` is Settings' working copy.
  const EDITOR_CSS = `
  .sg-glam-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(96px, 1fr)); gap:8px; margin:10px 0 6px; }
  .sg-glam-card { position:relative; display:flex; flex-direction:column; gap:6px; height:66px; padding:8px 9px; border-radius:10px; cursor:pointer; text-align:left;
    border:1px solid var(--aui-outline, #c6c6ca); font:600 12px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; overflow:hidden; }
  .sg-glam-card .aa { font-size:18px; font-weight:700; line-height:1; }
  .sg-glam-card .nm { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .sg-glam-card .dot { position:absolute; right:8px; top:8px; width:12px; height:12px; border-radius:50%; }
  .sg-glam-card.on { outline:2px solid var(--aui-primary, #8223d2); outline-offset:2px; }
  .sg-glam-card.portal { background:linear-gradient(135deg, #ffffff 50%, #130f17 50%); color:#1a1c1e; }
  .sg-glam-card.portal .nm { color:#1a1c1e; background:#ffffffcc; border-radius:4px; padding:0 3px; align-self:flex-start; }
  .sg-glam-card.add { align-items:center; justify-content:center; border-style:dashed; background:none; color:var(--aui-primary, #8223d2); }
  .sg-glam-edit { margin:8px 0 4px; padding:10px 12px; border-radius:10px; background:var(--aui-surface-variant, #faf9fc); border:1px solid var(--aui-outline-soft, #eeedf1); }
  .sg-glam-colors { display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; }
  .sg-glam-colors label { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--aui-on-surface-soft, #5d5e61); }
  .sg-glam-colors input[type=color] { width:100%; height:36px; padding:2px; border:1px solid var(--aui-outline, #c6c6ca); border-radius:8px; background:var(--aui-surface, #fff); cursor:pointer; }
  .sg-glam-warn { margin-top:6px; font-size:12px; color:var(--aui-status-error, #b91a24); }
  .sg-glam-edit .sg-actions { margin-top:10px; justify-content:flex-start; }
  .sg-glam-edit .sg-actions .sg-btn { flex:none; }
  .sg-glam-login { margin-top:14px; padding-top:10px; border-top:1px solid var(--aui-outline-soft, #eeedf1); }
  .sg-glam-login .row { display:flex; gap:12px; align-items:center; margin-top:8px; }
  .sg-glam-login .thumb { flex:none; width:72px; height:90px; border-radius:8px; border:1px solid var(--aui-outline, #c6c6ca);
    background:linear-gradient(45deg, #8223d2, #ae4fd2) center / cover no-repeat; display:flex; align-items:flex-end; justify-content:center;
    color:#fff; font-size:10px; padding-bottom:4px; text-align:center; }
  .sg-glam-login .btns { display:flex; flex-wrap:wrap; gap:6px; }
  .sg-glam-login .btns .sg-btn { flex:none; height:30px; font-size:13px; }
  .sg-glam-login label.chk { display:flex; gap:8px; align-items:center; margin-top:8px; font-size:13px; cursor:pointer; }
  `;

  /*
    Login page picture: shrunk in the browser to at most 1400 px on the long
    side and saved inside your settings as a data URL (WebP keeps
    transparency, like Portal's cut-out photo; JPEG if WebP isn't available),
    kept under ~1.2 MB.
  */
  function shrinkImage(file) {
    return new Promise((resolve, reject) => {
      if (!/^image\//.test(file.type)) return reject(new Error('That file isn\'t an image.'));
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Couldn\'t read that image.')); };
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, 1400 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const webp = c.toDataURL('image/webp', 0.85).startsWith('data:image/webp');
        for (const q of [0.85, 0.7, 0.55, 0.4]) {
          const d = c.toDataURL(webp ? 'image/webp' : 'image/jpeg', q);
          if (d.length < 1.2e6) return resolve(d);
        }
        reject(new Error('That image is too detailed to store; try a smaller one.'));
      };
      img.src = url;
    });
  }

  function loginEditor(s, repaint) {
    s.glamour.login = Object.assign({ image: '', fill: false, mark: true }, s.glamour.login);
    const L = s.glamour.login;
    const thumb = h('div', { class: 'thumb' });
    const status = h('div', { class: 'sg-soft', style: 'font-size:12px;margin-top:4px' });
    const file = h('input', { type: 'file', accept: 'image/*', style: 'display:none', onchange: async () => {
      const f = file.files[0]; file.value = '';
      if (!f) return;
      status.textContent = 'Preparing…';
      try { L.image = await shrinkImage(f); status.textContent = 'Picked. Save to use it.'; } catch (e) { status.textContent = e.message; }
      paint(); repaint();
    } });
    const fill = h('input', { type: 'checkbox', checked: !!L.fill, onchange: (e) => { L.fill = e.target.checked; paint(); repaint(); } });
    const mark = h('input', { type: 'checkbox', checked: L.mark !== false, onchange: (e) => { L.mark = e.target.checked; repaint(); } });
    const reset = h('button', { type: 'button', class: 'sg-btn', onclick: () => { L.image = ''; status.textContent = "Back to Portal's picture once you save."; paint(); repaint(); } }, "Portal's picture");
    // Recommended sizes: Portal's own photo is a 768 × 871 cut-out PNG; the panel
    // is the right 60% of the window, full height (about square: 1152 × 1080 on 1080p).
    const tip = h('div', { class: 'sg-soft', style: 'font-size:12px;margin-top:6px' });
    function paint() {
      tip.textContent = L.fill
        ? 'Best fit: about 1400 × 1300 px. The panel\'s shape changes with the window, so the edges may be trimmed; keep the subject in the middle.'
        : 'Best fit: 768 × 871 px (portrait), a PNG with a transparent background, like Portal\'s own photo. It stands at the bottom of the purple panel.';
      thumb.style.backgroundImage = L.image ? 'url("' + L.image + '")' + (L.fill ? '' : ', linear-gradient(45deg, #8223d2, #ae4fd2)') : '';
      thumb.style.backgroundSize = L.image && !L.fill ? 'contain, cover' : 'cover';
      thumb.style.backgroundPosition = L.image && !L.fill ? 'center bottom, center' : 'center';
      thumb.textContent = L.image ? '' : "Portal's";
      reset.disabled = !L.image;
      fill.disabled = !L.image;
    }
    paint();
    return h('div', { class: 'sg-glam-login' },
      h('b', null, 'Login page'),
      h('div', { class: 'sg-soft', style: 'font-size:12px' }, 'Shown on Portal\'s sign-in page in this browser.'),
      h('div', { class: 'row' }, thumb,
        h('div', null,
          h('div', { class: 'btns' }, h('button', { type: 'button', class: 'sg-btn', onclick: () => file.click() }, 'Choose picture…'), reset, file),
          status,
          h('label', { class: 'chk' }, fill, 'Fill the whole purple panel'),
          tip,
          h('label', { class: 'chk' }, mark, 'Aethernet mark in the bottom-left corner'))));
  }

  function editor(s, repaint) {
    if (!document.getElementById('sg-glamour-css')) document.head.append(h('style', { id: 'sg-glamour-css' }, EDITOR_CSS));
    // Own copy: AE.merge shares arrays, and Cancel must leave saved themes untouched.
    s.glamour.custom = JSON.parse(JSON.stringify(s.glamour.custom || []));
    const root = h('div');
    let editing = null; // id of the custom theme open in the editor

    const select = (id) => { s.glamour.theme = id; apply(s.glamour); render(); repaint(); };

    const card = (t) => {
      const on = s.glamour.theme === t.id;
      if (t.id === 'portal') {
        return h('button', { type: 'button', class: 'sg-glam-card portal' + (on ? ' on' : ''), title: t.note, onclick: () => { editing = null; select(t.id); } },
          h('span', { class: 'aa' }, 'Aa'), h('span', { class: 'nm' }, t.name));
      }
      return h('button', { type: 'button', class: 'sg-glam-card' + (on ? ' on' : ''), style: 'background:' + t.bg + ';color:' + t.fg + ';border-color:' + mix(t.fg, t.bg, 0.7),
        title: t.custom ? 'Your theme — click again to edit' : t.name,
        onclick: () => { editing = t.custom && on ? t.id : null; select(t.id); } },
        h('span', { class: 'dot', style: 'background:' + t.accent }),
        h('span', { class: 'aa' }, 'Aa'), h('span', { class: 'nm' }, t.name));
    };

    const edit = (t) => {
      const warn = h('div', { class: 'sg-glam-warn' });
      const check = () => {
        const c = contrast(t.bg, t.fg);
        warn.textContent = c < 4.5 ? 'Text may be hard to read on this background (contrast ' + c.toFixed(1) + ':1, aim for 4.5+).' : '';
      };
      const color = (label, key) => h('label', null, label,
        h('input', { type: 'color', value: t[key], oninput: (e) => { t[key] = e.target.value; apply(s.glamour); check(); root.querySelector('.sg-glam-card.on')?.replaceWith(card(t)); } }));
      check();
      return h('div', { class: 'sg-glam-edit' },
        h('label', { class: 'sg-field', style: 'margin-top:0' }, h('span', null, 'Theme name'),
          h('input', { type: 'text', value: t.name, maxlength: 24, oninput: (e) => { t.name = e.target.value || 'My theme'; repaint(); } })),
        h('div', { class: 'sg-glam-colors' }, color('Background', 'bg'), color('Text', 'fg'), color('Accent', 'accent')),
        warn,
        h('div', { class: 'sg-actions' },
          h('button', { type: 'button', class: 'sg-btn', onclick: () => { editing = null; render(); } }, 'Done'),
          h('button', { type: 'button', class: 'sg-btn', onclick: () => {
            s.glamour.custom = s.glamour.custom.filter((c) => c.id !== t.id);
            editing = null; select('portal');
          } }, 'Delete theme')));
    };

    function render() {
      const cur = find(s.glamour, s.glamour.theme);
      const add = h('button', { type: 'button', class: 'sg-glam-card add', onclick: () => {
        // Start from whatever is showing now, so tweaking a preset is easy.
        const base = cur && cur.bg ? cur : { bg: '#ffffff', fg: '#1a1c1e', accent: '#8223d2' };
        const t = { id: 'custom-' + Date.now().toString(36), name: 'My theme', bg: base.bg, fg: base.fg, accent: base.accent, custom: true };
        s.glamour.custom.push(t);
        editing = t.id; select(t.id);
      } }, '+ New theme');
      const editingTheme = editing && s.glamour.custom.find((c) => c.id === editing);
      root.replaceChildren(
        h('div', { class: 'sg-soft', style: 'margin-top:8px' }, 'Pick a theme to preview it. Save keeps it; Cancel puts yours back.'),
        h('div', { class: 'sg-glam-grid' }, PRESETS.map(card), s.glamour.custom.map(card), add),
        ...(editingTheme ? [edit(editingTheme)] : []));
    }
    render();
    return h('div', null, root, loginEditor(s, repaint));
  }

  const summary = (cfg) => (find(cfg, cfg.theme) || PRESETS[0]).name;

  return { PRESETS, apply, editor, summary, tokens, contrast };
})();

AE.crystal({
  id: 'glamour',
  name: 'Glamour',
  sites: ['portal.ubreakifix.net'],
  run() {
    AE.glamour.apply(AE.settings.glamour);
    if (AE.settings.glamour && AE.settings.glamour.theme && AE.settings.glamour.theme !== 'portal') AE.trackDaily('glamour:themed');
  },
});

// ===== 55-waymark.js =====
/*
  Waymark (work-order tags) — shared tags for the whole store, sortable.

  Tags live in the Waymark API (worker/ in this repo: a Cloudflare Worker +
  D1 database), keyed by Portal store ID, with our own history log — no
  Portal notes. Tags on a WO are cleared 7 days after Aethernet sees it
  closed (the Worker's daily job; Aethernet reports closed WOs it notices).

  - On a WO page: tag chips next to the customer name, and "+ Tag" (managed
    tags as toggles, a box for one-off tags, and the WO's tag history).
  - Header button: the board — open WOs grouped by tag, filterable.
    Managers (the roles below) get × on each tag there to clear it;
    everyone else removes tags from the WO itself.
  - Auto-Waymark: a WO that reaches Ready for pickup gets a follow-up date
    3 days after that day (its own kind of mark, not a tag), added after end
    of day (7 PM local) — or on the first Portal load after that if nobody
    had Portal open then. Right-click pushes it
    later (never earlier); × removes it for good. The board's second tab
    lists them by due date. Found by a scan of Portal's active list every 10
    minutes (one tab per browser does it; the server ignores repeats), and
    when a tech sets the WO they're on to Ready for pickup after 7 PM.
  - The header icon shows how many open Auto-Waymarks are due (today or
    overdue). On their first Portal load of the day, managers get a speech
    bubble from the icon if any were left open past their due day.
  - If the nickname already has a date in it when the mark is made
    ("PS5 SLIM (10/01)"), that date is the mark's date instead.
  - While a WO is at Ready for pickup, its device nickname is just the
    Auto-Waymark date ("10/02", the store's usual M/DD) and is kept that way:
    pushes rewrite it, and the scan puts it back if it drifts. A later date
    typed into the nickname by hand moves the mark to match instead.
  - Texting the customer from a WO at Ready for pickup moves its
    Auto-Waymark to 3 days from that day (only ever later), credited
    "<name> (texted the customer)". Uses core's text-sent event, so it works
    with Recitation off.
  - Settings → Waymark: the store's managed tag list. Only Portal's
    Store Manager / District Manager / Store Owner roles (for the current
    store) can edit it; everyone can tag and add one-offs.

  Trust: the role check happens here, not on the server (it can't see
  Portal logins). Ordinary use is gated; a tampered script isn't. Fine for
  tags. All tag text is shown as plain text.
*/
AE.waymark = (() => {
  const { h } = AE;
  const API = 'https://aethernet-waymark.ubifaethernet.workers.dev';
  const KEY = 'ae_QFa2DKDy0DrlBd_A3bfZL3BtgM51idh6';
  const EDITOR_ROLES = ['Store Manager - Corp', 'Store Manager - Franchisee', 'District Manager', 'District Manager - Franchisee', 'Store Owner - Franchisee'];
  const COLORS = { purple: 'var(--aui-primary, #8223d2)', blue: '#4a68f9', teal: '#1592a8', green: '#2f9e5b', lime: '#6f9a12', yellow: '#b38f00', orange: '#d9670f', red: '#d1344b', grey: 'var(--aui-on-surface-soft, #5d5e61)' };
  const TTL = 60 * 1000;
  const configured = () => !AE_SANDBOX && /^(https:\/\/|http:\/\/localhost[:/])/.test(API); // localhost = a wrangler dev test build; off in the Portal sandbox

  let cache = null, cacheAt = 0, inflight = null;
  let roleInfo = null;

  async function me() {
    const p = await AE.profile();
    if (!p.storeId) throw new Error('No current store');
    return p;
  }

  async function call(method, path, body) {
    if (!configured()) throw new Error("Waymark isn't set up yet");
    const p = await me();
    const res = await fetch(API + '/v1/' + p.storeId + path, {
      method, credentials: 'omit',
      headers: { 'content-type': 'application/json', 'x-aethernet-key': KEY },
      body: body ? JSON.stringify(Object.assign({ by: p.name, byId: p.userId }, body)) : undefined,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status);
    return j;
  }

  // { list: [{name, color}], tags: { [woId]: [{tag, by, at}] } }, cached for a minute.
  function load(force) {
    if (!force && cache && Date.now() - cacheAt < TTL) return Promise.resolve(cache);
    if (inflight) return inflight;
    inflight = call('GET', '').then((j) => { cache = { list: j.list || [], tags: j.tags || {}, auto: j.auto || {} }; cacheAt = Date.now(); AE.emit('waymark-changed', cache); return cache; })
      .finally(() => { inflight = null; });
    return inflight;
  }
  const tagsOf = (woId) => (cache && cache.tags[woId]) || [];

  async function setTag(woId, tag, on) {
    if (AE.status.blocked('waymark')) return null;
    AE.track(on ? 'waymark:tag' : 'waymark:untag');
    const j = await call('POST', '/wo/' + woId + (on ? '/tag' : '/untag'), { tag });
    if (cache) { if (j.tags.length) cache.tags[woId] = j.tags; else delete cache.tags[woId]; }
    AE.emit('waymark-changed', cache);
    return j.tags;
  }
  const history = (woId) => call('GET', '/wo/' + woId + '/history').then((j) => j.history || []);

  async function saveList(list) {
    const j = await call('PUT', '/list', { list });
    if (cache) cache.list = j.list;
    AE.emit('waymark-changed', cache);
    return j.list;
  }

  // Can this user edit the managed list, for the store they're signed into?
  async function canEdit() {
    if (roleInfo) return roleInfo;
    const p = await me();
    let roles = [];
    try {
      const j = await AE.api('GET', '/api/auth/user/stores');
      const stores = Array.isArray(j) ? j : (j && (j.stores || j.data)) || [];
      const here = stores.find((s) => String(s.number ?? s.storeId) === String(p.storeId));
      roles = (here && here.roles) || [];
    } catch (_) { /* no roles = not an editor */ }
    roleInfo = { ok: roles.some((r) => EDITOR_ROLES.includes(r)), roles };
    return roleInfo;
  }

  // ------------------------------------------------------------ Auto-Waymark
  const AUTO_DAYS = 3, RFP_STATUS = 13; // 13 = Ready for pickup
  const EOD_HOUR = 19;                    // marks go on after end of day, 7 PM local
  const afterEod = () => AE.nowDate().getHours() >= EOD_HOUR; // AE.nowDate: the dev tools can shift it
  const pad = (n) => String(n).padStart(2, '0');
  const isoDate = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); // store-local date
  const parseDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (iso, n) => { const d = parseDate(iso); d.setDate(d.getDate() + n); return isoDate(d); };
  const today = () => isoDate(AE.nowDate());
  const fmtDate = (iso) => parseDate(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const dueState = (iso) => (iso < today() ? 'overdue' : iso === today() ? 'today' : 'upcoming');
  const autoOf = (woId) => (cache && cache.auto && cache.auto[woId]) || null;
  // When did it reach Ready for pickup? The list row's updatedAt is the best
  // hint (a WO sitting at RFP rarely changes); never later than now.
  const rfpSince = (r) => { const t = Date.parse(r.updatedAt); return isoDate(new Date(isNaN(t) ? AE.now() : Math.min(t, AE.now()))); };

  // ---- the WO's device nickname mirrors its Auto-Waymark (M/DD, as the store writes it)
  const nickDate = (iso) => { const d = parseDate(iso); return (d.getMonth() + 1) + '/' + pad(d.getDate()); };
  // The date written in a nickname, anywhere in it ("10/02", "PS5 SLIM (10/01)",
  // "HDMI REPLACEMENT 9/29"; the last one wins) → YYYY-MM-DD in the nearest year, else null.
  function parseNick(name) {
    const found = [...String(name || '').matchAll(/(?:^|[^\d/])(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?(?![\d/])/g)];
    for (const m of found.reverse()) {
      const mo = Number(m[1]) - 1, day = Number(m[2]), now = AE.nowDate();
      const best = [-1, 0, 1].map((dy) => new Date(now.getFullYear() + dy, mo, day))
        .filter((d) => d.getMonth() === mo && d.getDate() === day)
        .sort((a, b) => Math.abs(a - now) - Math.abs(b - now))[0];
      if (best) return isoDate(best);
    }
    return null;
  }
  const woDetail = async (woId) => { const j = await AE.api('GET', '/api/workorder/' + woId); return (j && j.workorder) || AE.unwrap(j); };
  // Set the nickname to the mark's date, only while the WO is at Ready for pickup.
  // Sends the device record back unchanged apart from `name`, as Portal's own edit does.
  async function syncNickname(woId, due, wo) {
    wo = wo || await woDetail(woId);
    const dev = wo && wo.CustomerDevice;
    if (!dev || !dev.customerDeviceId || Number(wo.workorderStatusId) !== RFP_STATUS) return false;
    const name = nickDate(due);
    if ((dev.name || '').trim() === name) return false;
    await AE.api('PUT', '/api/customer-devices/' + dev.customerDeviceId, {
      customerDeviceId: dev.customerDeviceId, customerId: dev.customerId, passcode: dev.passcode, serial: dev.serial,
      imei: dev.imei, deviceCatalogId: dev.deviceCatalogId, name,
    });
    if (location.pathname.indexOf('/repair/workorder/' + woId) === 0) AE.refreshView(); // show the new nickname
    return true;
  }

  // opts.by: who it's credited to in the history; opts.why: start of the toast (e.g. "Customer texted").
  async function pushMark(woId, due, opts = {}) {
    if (AE.status.blocked('waymark')) return;
    const j = await call('POST', '/wo/' + woId + '/push', opts.by ? { due, by: opts.by } : { due });
    AE.track(opts.track || 'waymark:push');
    if (cache) cache.auto[woId] = Object.assign({}, cache.auto[woId], { due: j.auto.due });
    AE.emit('waymark-changed', cache);
    const lead = opts.why ? opts.why + ': Auto-Waymark moved to ' : 'Moved to ';
    try {
      if (await syncNickname(woId, j.auto.due)) AE.toast('Auto-Waymark', lead + fmtDate(j.auto.due) + '; nickname is now ' + nickDate(j.auto.due) + '.', 'ok');
      else if (opts.why) AE.toast('Auto-Waymark', lead + fmtDate(j.auto.due) + '.', 'ok');
    } catch (e) { fail('mark moved, but the nickname couldn\'t be updated', e); }
  }

  // A text to the customer from a WO at Ready for pickup restarts its follow-up:
  // the mark moves to 3 days from today, never earlier than it already is.
  async function customerTexted(woId) {
    if (!configured() || AE.status.blocked('waymark')) return;
    const c = await load(true);
    const m = c.auto && c.auto[woId];
    if (!m) return;
    const due = addDays(today(), AUTO_DAYS);
    if (due <= m.due) return;
    const wo = await woDetail(woId);
    if (!wo || Number(wo.workorderStatusId) !== RFP_STATUS) return;
    const p = await me();
    await pushMark(woId, due, { by: (p.name || 'Someone') + ' (texted the customer)', why: 'Customer texted', track: 'waymark:pushTexted' });
  }

  // Right after a tech sets this WO to Ready for pickup (seen from the WO page).
  async function checkWo(woId) {
    if (!configured() || AE.status.paused('waymark')) return;
    const [c, wo] = await Promise.all([load(), woDetail(woId)]);
    if (!wo || Number(wo.workorderStatusId) !== RFP_STATUS) return;
    let m = c.auto[woId];
    if (!m) {
      if (!afterEod()) return; // the evening scan (or tomorrow's first load) marks it
      const due = parseNick(wo.CustomerDevice && wo.CustomerDevice.name) || addDays(today(), AUTO_DAYS);
      const r = await call('POST', '/auto', { marks: [{ wo: Number(woId), due }] });
      if (!(r.created && r.created.length)) return; // removed earlier with ×: stays removed
      await load(true);
      m = autoOf(woId);
    }
    if (m && await syncNickname(woId, m.due, wo)) AE.toast('Auto-Waymark', 'Follow up by ' + fmtDate(m.due) + '; nickname set to ' + nickDate(m.due) + '.', 'ok');
  }
  async function unmark(woId) {
    if (AE.status.blocked('waymark')) return;
    await call('POST', '/wo/' + woId + '/unmark', {});
    AE.track('waymark:unmark');
    if (cache) delete cache.auto[woId];
    AE.emit('waymark-changed', cache);
  }

  /*
    One pass over Portal's active list: Auto-Waymark WOs at Ready for pickup,
    and report tagged/marked WOs that have closed (cleared 7 days later).
    Every 10 minutes; tabs share a timestamp so only one does it. The board
    passes the list it just loaded.
  */
  const SCAN_KEY = 'ae_wm_scan_at', SCAN_MS = 10 * 60 * 1000;
  const OPEN_KEY = 'ae_wm_open'; // last active-list WO ids (shared across tabs), so counts skip closed WOs

  // Open Auto-Waymarks due today or earlier (for the header badge).
  function dueMarks() {
    if (!cache) return [];
    const o = GM_getValue(OPEN_KEY, null);
    const open = o && Date.now() - o.at < 30 * 60 * 1000 ? new Set(o.ids) : null;
    return Object.entries(cache.auto).filter(([id, m]) => m.due <= today() && (!open || open.has(Number(id))));
  }
  /*
    What a scan would do, as a plan: marks to create, marks that follow a later
    date typed into the nickname, nicknames to rewrite, and WOs waiting for 7 PM.
    The real scan carries it out; the dev tools' dry run just shows it.
    noCreate: plan against existing marks only (after creating, when the
    server may have ignored marks that were removed with ×).
  */
  function planScan(rows, c, noCreate) {
    const plan = { create: [], follow: [], rename: [], waiting: [] };
    for (const r of rows) {
      if (Number(r.workorderStatusId) !== RFP_STATUS) continue;
      const wo = Number(r.workorderId), nick = ((r.customerDevice && r.customerDevice.name) || '').trim();
      let due = c.auto[wo] && c.auto[wo].due;
      if (!due) {
        if (noCreate) continue;
        if (!(afterEod() || rfpSince(r) < today())) { plan.waiting.push({ wo, rfp: rfpSince(r), nick }); continue; } // today's RFPs wait for 7 PM
        due = parseNick(nick) || addDays(rfpSince(r), AUTO_DAYS); // the nickname's date wins
        plan.create.push({ wo, due, nick, from: parseNick(nick) ? 'nickname' : 'RFP day + ' + AUTO_DAYS });
      }
      if (nick === nickDate(due)) continue;
      const typed = parseNick(nick);
      if (typed && typed > due) { plan.follow.push({ wo, from: due, to: typed }); due = typed; } // a later date typed by hand: the mark follows
      if (nick !== nickDate(due)) plan.rename.push({ wo, from: nick, to: nickDate(due), due });
    }
    return plan;
  }

  async function scan(rows, opts = {}) {
    if (!rows) {
      if (!opts.force && Date.now() - GM_getValue(SCAN_KEY, 0) < SCAN_MS - 30000) return null;
      GM_setValue(SCAN_KEY, Date.now());
      rows = await AE.data.workorders(Date.now(), 0);
    }
    GM_setValue(OPEN_KEY, { at: Date.now(), ids: rows.map((r) => Number(r.workorderId)) });
    let c = await load(true);
    let plan = planScan(rows, c);
    if (opts.dryRun) return Object.assign(plan, { rows });
    if (!AE.status.paused('waymark')) {
      if (plan.create.length) {
        const j = await call('POST', '/auto', { marks: plan.create.map(({ wo, due }) => ({ wo, due })) }); // removed ones are ignored
        if (j.created && j.created.length) c = await load(true);
        plan = planScan(rows, c, true);
      }
      for (const f of plan.follow) {
        try { await call('POST', '/wo/' + f.wo + '/push', { due: f.to, by: 'Nickname edit' }); } catch (e) { console.warn('[' + AE_NAME + '] Waymark follow, WO ' + f.wo + ':', e.message || e); }
      }
      for (const r of plan.rename) {
        try { await syncNickname(r.wo, r.due); } catch (e) { console.warn('[' + AE_NAME + '] Waymark nickname sync, WO ' + r.wo + ':', e.message || e); }
      }
    }
    const open = new Set(rows.map((r) => Number(r.workorderId)));
    const known = [...new Set([...Object.keys(c.tags), ...Object.keys(c.auto)].map(Number))];
    const closed = known.filter((id) => !open.has(id));
    if (closed.length) await call('POST', '/closed', { wos: closed });
    return plan;
  }


  // ------------------------------------------------------------ UI bits
  const CSS = `
  .sg-tag { display:inline-flex; align-items:center; gap:4px; height:22px; padding:0 9px; border-radius:10000rem; font:600 12px/1 Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif;
    white-space:nowrap; max-width:220px; overflow:hidden; text-overflow:ellipsis; flex:none;
    color:color-mix(in srgb, var(--c) 78%, var(--aui-on-surface, #1a1c1e)); background:color-mix(in srgb, var(--c) 15%, var(--aui-surface, #fff));
    border:1px solid color-mix(in srgb, var(--c) 45%, transparent); }
  .sg-tag.oneoff { --c:var(--aui-on-surface-soft, #5d5e61); border-style:dashed; background:transparent; font-weight:400; }
  .sg-tag button { border:0; background:none; padding:0 0 0 2px; margin:0; color:inherit; cursor:pointer; font-size:13px; line-height:1; opacity:.7; }
  .sg-tag button:hover { opacity:1; }
  .sg-tag.off { opacity:.55; background:transparent; }
  .sg-tag.toggle { cursor:pointer; }
  #sg-wm-row { display:inline-flex; align-items:center; gap:6px; margin-left:12px; flex-wrap:wrap; align-self:center; }
  #sg-wm-row .add { height:24px; padding:0 10px; font-size:12px; }
  #sg-wm-pop { position:fixed; z-index:2147483646; width:360px; max-height:70vh; overflow:auto; padding:14px 16px; font-size:14px; line-height:1.4; }
  #sg-wm-pop h4 { margin:12px 0 6px; font-size:11px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; color:var(--aui-on-surface-soft, #5d5e61); }
  #sg-wm-pop h4:first-child { margin-top:0; }
  #sg-wm-pop .chips { display:flex; flex-wrap:wrap; gap:6px; }
  #sg-wm-pop input[type=text] { width:100%; height:34px; padding:0 10px; border:1px solid var(--aui-outline, #c6c6ca); border-radius:8px;
    background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e); font:14px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; }
  #sg-wm-pop ol { list-style:none; margin:0; padding:0; font-size:13px; }
  #sg-wm-pop li { padding:4px 0; border-top:1px solid var(--aui-outline-soft, #eeedf1); }
  #sg-wm-pop li:first-child { border-top:0; }
  #sg-wm-pop .when { color:var(--aui-on-surface-soft, #5d5e61); font-size:12px; }
  #sg-wm-btn { display:inline-flex; align-items:center; justify-content:center; width:34px; height:34px; margin-right:8px; padding:0; border:0; border-radius:9px;
    background:none; cursor:pointer; flex:none; }
  #sg-wm-btn:hover { background:var(--aui-neutral-soft, #f1f0f4); }
  #sg-wm-btn .sg-aicon { width:26px; height:26px; }
  #sg-wm-btn { position:relative; }
  #sg-wm-btn .badge { position:absolute; top:-3px; right:-4px; min-width:18px; height:18px; padding:0 5px; border-radius:10000rem; box-sizing:border-box;
    background:#d1344b; color:#fff; border:2px solid var(--aui-elevated-level-01, #fff); font:700 11px/14px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; text-align:center; }
  #sg-wm-bubble { position:fixed; z-index:2147483646; width:300px; padding:14px 14px 12px; font-size:14px; line-height:1.45; animation:sg-in .25s ease-out;
    border-color:#d1344b; box-shadow:0 10px 30px rgba(12,14,17,.25); }
  #sg-wm-bubble .top { display:flex; gap:10px; align-items:flex-start; }
  #sg-wm-bubble .top .n { flex:none; min-width:26px; height:26px; padding:0 7px; border-radius:10000rem; background:#d1344b; color:#fff; font:700 14px/26px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; text-align:center; box-sizing:border-box; }
  #sg-wm-bubble .sg-actions { margin-top:10px; justify-content:flex-end; }
  #sg-wm-bubble .sg-actions .sg-btn { flex:none; }
  #sg-wm-bubble .tail { position:absolute; top:-8px; width:14px; height:14px; background:inherit; border:1px solid #d1344b; border-width:1px 0 0 1px; transform:rotate(45deg); }
  #sg-wm-board { position:fixed; z-index:2147483646; right:16px; width:min(560px, calc(100vw - 32px)); max-height:calc(100vh - 100px); display:flex; flex-direction:column;
    padding:16px 16px 10px; font-size:14px; line-height:1.4; }
  #sg-wm-board .head { display:flex; align-items:center; gap:10px; margin-bottom:10px; }
  #sg-wm-board .head b { flex:1; font-size:18px; }
  #sg-wm-board .filters { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px; }
  #sg-wm-board .list { overflow:auto; }
  #sg-wm-board .group { margin-bottom:12px; }
  #sg-wm-board .group > .gh { display:flex; align-items:center; gap:8px; margin:0 0 4px; font-size:12px; color:var(--aui-on-surface-soft, #5d5e61); }
  #sg-wm-board .wo { display:flex; align-items:center; gap:10px; padding:7px 4px; border-top:1px solid var(--aui-outline-soft, #eeedf1); }
  #sg-wm-board .wo > div { flex:1; min-width:0; }
  #sg-wm-board .wo a { color:var(--aui-primary, #8223d2); font-weight:600; text-decoration:none; }
  #sg-wm-board .wo a:hover { text-decoration:underline; }
  #sg-wm-board .wo .meta { font-size:12px; color:var(--aui-on-surface-soft, #5d5e61); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #sg-wm-board .wo .chips { display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-end; max-width:45%; }
  .sg-auto { display:inline-flex; align-items:center; gap:4px; height:22px; padding:0 3px 0 6px; border-radius:6px; flex:none; cursor:context-menu;
    font:700 12px/1 Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; white-space:nowrap;
    color:color-mix(in srgb, var(--c) 80%, var(--aui-on-surface, #1a1c1e)); background:color-mix(in srgb, var(--c) 14%, var(--aui-surface, #fff));
    border:1px solid color-mix(in srgb, var(--c) 55%, transparent); }
  .sg-auto svg { width:13px; height:13px; flex:none; }
  .sg-auto.upcoming { --c:#4a68f9; }
  .sg-auto.today { --c:#b38f00; background:color-mix(in srgb, var(--c) 28%, var(--aui-surface, #fff)); }
  .sg-auto.overdue { --c:#d1344b; background:#d1344b; color:#fff; border-color:#d1344b; }
  .sg-auto button { border:0; background:none; padding:0 2px; margin:0; color:inherit; cursor:pointer; font-size:13px; line-height:1; opacity:.75; }
  .sg-auto button:hover { opacity:1; }
  #sg-wm-push { position:fixed; z-index:2147483647; width:230px; padding:8px; font-size:13px; }
  #sg-wm-push .ttl { padding:4px 8px 6px; font-size:11px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; color:var(--aui-on-surface-soft, #5d5e61); }
  #sg-wm-push .opt { display:flex; justify-content:space-between; width:100%; padding:7px 8px; border:0; border-radius:6px; background:none; cursor:pointer;
    color:var(--aui-on-surface, #1a1c1e); font:400 13px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; text-align:left; }
  #sg-wm-push .opt:hover, #sg-wm-push .opt:focus-visible { background:var(--aui-neutral-soft, #f1f0f4); outline:0; }
  #sg-wm-push .pick { display:flex; gap:6px; padding:6px 8px 2px; border-top:1px solid var(--aui-outline-soft, #eeedf1); margin-top:4px; }
  #sg-wm-push .pick input { flex:1; min-width:0; height:30px; border:1px solid var(--aui-outline, #c6c6ca); border-radius:6px; background:var(--aui-surface, #fff);
    color:var(--aui-on-surface, #1a1c1e); font:13px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; color-scheme:light dark; }
  #sg-wm-push .pick .sg-btn { height:30px; padding:0 10px; font-size:13px; }
  #sg-wm-board .tabs { display:flex; gap:2px; margin:0 0 10px; border-bottom:1px solid var(--aui-outline-soft, #eeedf1); }
  #sg-wm-board .tab { padding:6px 10px 7px; border:0; border-bottom:2px solid transparent; margin-bottom:-1px; background:none; cursor:pointer;
    color:var(--aui-on-surface-soft, #5d5e61); font:600 13px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; }
  #sg-wm-board .tab.on { color:var(--aui-primary, #8223d2); border-bottom-color:var(--aui-primary, #8223d2); }
  #sg-wm-board .tab .n { margin-left:4px; font-weight:400; }
  #sg-wm-board .tab .late { margin-left:4px; padding:0 5px; border-radius:10000rem; background:#d1344b; color:#fff; font-size:11px; }
  .sg-wm-edit .row { display:flex; align-items:center; gap:6px; margin:6px 0; }
  .sg-wm-edit .row input[type=text] { flex:1; min-width:0; height:32px; padding:0 8px; border:1px solid var(--aui-outline, #c6c6ca); border-radius:8px;
    background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e); font:14px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; }
  .sg-wm-edit select { height:32px; border:1px solid var(--aui-outline, #c6c6ca); border-radius:8px; background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e); }
  .sg-wm-edit .mini { width:28px; height:28px; padding:0; border:1px solid var(--aui-outline-soft, #eeedf1); border-radius:7px; background:none; cursor:pointer; color:var(--aui-on-surface-soft, #5d5e61); }
  .sg-wm-edit .sg-actions { justify-content:flex-start; margin-top:8px; }
  .sg-wm-edit .sg-actions .sg-btn { flex:none; }
  `;
  const ensureCss = () => { AE.ensureCss(); if (!document.getElementById('sg-wm-css')) document.head.append(h('style', { id: 'sg-wm-css' }, CSS)); };

  const colorOf = (name) => { const t = cache && cache.list.find((l) => l.name === name); return t ? t.color : null; };
  // A tag chip. opts.label shows different text (e.g. with a count) but keeps the tag's colour.
  function chip(name, opts = {}) {
    const color = colorOf(name);
    const el = h('span', { class: 'sg-tag' + (color ? '' : ' oneoff') + (opts.cls ? ' ' + opts.cls : ''), style: color ? '--c:' + COLORS[color] : null, title: opts.title || name }, opts.label || name);
    if (opts.onRemove) el.append(h('button', { type: 'button', title: 'Remove ' + name, 'aria-label': 'Remove ' + name, onclick: (e) => { e.stopPropagation(); opts.onRemove(); } }, '×'));
    return el;
  }
  const when = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  const fail = (what, e) => AE.toast('Waymark: ' + what, (e && e.message) || String(e), 'err');

  const CAL_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 2h2v2h6V2h2v2h2a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2V2zM5 9v10h14V9H5z"/></svg>';

  // The Auto-Waymark chip: blue ahead of time, amber on the day, red once overdue.
  function autoChip(woId, mark, onChange) {
    const st = dueState(mark.due);
    const label = (st === 'today' ? 'Today · ' : st === 'overdue' ? 'Overdue · ' : '') + fmtDate(mark.due);
    const el = h('span', { class: 'sg-auto ' + st, role: 'note',
      title: 'Auto-Waymark: follow up by ' + fmtDate(mark.due) + ' (set when it reached Ready for pickup). Right-click to push it later; × removes it.' },
      h('span', { html: CAL_SVG, style: 'line-height:0' }), label,
      h('button', { type: 'button', title: 'Remove this Auto-Waymark', 'aria-label': 'Remove Auto-Waymark', onclick: async (e) => {
        e.stopPropagation();
        try { await unmark(woId); } catch (err) { fail("couldn't remove the Auto-Waymark", err); }
        onChange && onChange();
      } }, '×'));
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); pushMenu(e.clientX, e.clientY, woId, mark.due, onChange); });
    return el;
  }

  // Right-click menu: only ever later.
  function pushMenu(x, y, woId, due, onChange) {
    document.getElementById('sg-wm-push')?.remove();
    ensureCss();
    const go = async (next) => {
      menu.remove();
      try { await pushMark(woId, next); } catch (e) { fail("couldn't move the Auto-Waymark", e); }
      onChange && onChange();
    };
    const opt = (label, days) => { const d = addDays(due, days); return h('button', { type: 'button', class: 'opt', role: 'menuitem', onclick: () => go(d) }, label, h('span', { class: 'sg-soft' }, fmtDate(d))); };
    const pick = h('input', { type: 'date', min: addDays(due, 1), value: addDays(due, 1), 'aria-label': 'Pick a later date' });
    const menu = h('div', { id: 'sg-wm-push', class: 'sg sg-card', role: 'menu', 'aria-label': 'Push Auto-Waymark later' },
      h('div', { class: 'ttl' }, 'Push later · now ' + fmtDate(due)),
      opt('+1 day', 1), opt('+3 days', 3), opt('+1 week', 7),
      h('div', { class: 'pick' }, pick, h('button', { type: 'button', class: 'sg-btn', onclick: () => { if (pick.value && pick.value > due) go(pick.value); } }, 'Set')));
    document.body.appendChild(menu);
    menu.style.left = Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8)) + 'px';
    menu.querySelector('.opt').focus();
    const close = (e) => {
      if (e.type === 'keydown' ? e.key !== 'Escape' : e.composedPath().includes(menu)) return;
      menu.remove(); document.removeEventListener('mousedown', close, true); document.removeEventListener('keydown', close, true);
    };
    setTimeout(() => { document.addEventListener('mousedown', close, true); document.addEventListener('keydown', close, true); }, 0);
  }

  // History line for any Waymark event.
  function historyLine(x) {
    const who = x.by || 'Someone';
    const dates = (d) => String(d || '').split(' → ').map((v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? fmtDate(v) : v)).join(' → ');
    const parts = {
      add: [who + ' added ', x.tag], remove: [who + ' removed ', x.tag],
      auto: ['Auto-Waymark set for ', dates(x.detail)],
      push: [who + ' pushed the Auto-Waymark ', dates(x.detail)],
      unmark: [who + ' removed the Auto-Waymark ', dates(x.detail)],
    }[x.action] || [who + ' ' + x.action + ' ', x.tag || x.detail || ''];
    return h('li', null, parts[0], h('b', null, parts[1]), ' ', h('span', { class: 'when' }, '· ' + when(x.at)));
  }

  // ------------------------------------------------------------ Settings → Waymark (managed list)
  function editor() {
    ensureCss();
    const root = h('div', { class: 'sg-wm-edit' }, h('div', { class: 'sg-soft', style: 'margin-top:8px' }, 'Loading tag list…'));
    Promise.all([load(true), canEdit()]).then(([c, role]) => {
      let rows = c.list.map((t) => ({ name: t.name, color: t.color }));
      const draw = () => {
        if (!role.ok) {
          root.replaceChildren(
            h('div', { class: 'sg-soft', style: 'margin-top:8px' }, "Your store's tags. Store managers, district managers and franchise owners can edit this list; anyone can tag work orders and add one-off tags."),
            h('div', { class: 'chips', style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px' }, rows.length ? rows.map((t) => chip(t.name)) : h('span', { class: 'sg-soft' }, 'No tags yet.')));
          return;
        }
        const status = h('span', { class: 'sg-soft' });
        root.replaceChildren(
          h('div', { class: 'sg-soft', style: 'margin-top:8px' }, "Your store's tags, in the order the board shows them. Anyone can still add one-off tags on a work order."),
          ...rows.map((t, i) => h('div', { class: 'row' },
            h('select', { 'aria-label': 'Colour', onchange: (e) => { t.color = e.target.value; draw(); } }, Object.keys(COLORS).map((c) => { const o = h('option', { value: c }, c); o.selected = c === t.color; return o; })),
            chip(t.name || 'Tag'),
            h('input', { type: 'text', value: t.name, maxlength: 32, 'aria-label': 'Tag name', oninput: (e) => { t.name = e.target.value; } , onchange: draw }),
            h('button', { type: 'button', class: 'mini', title: 'Move up', disabled: i === 0, onclick: () => { rows.splice(i - 1, 0, rows.splice(i, 1)[0]); draw(); } }, '↑'),
            h('button', { type: 'button', class: 'mini', title: 'Remove', onclick: () => { rows.splice(i, 1); draw(); } }, '✕'))),
          h('div', { class: 'sg-actions' },
            h('button', { type: 'button', class: 'sg-btn', disabled: rows.length >= 40, onclick: () => { rows.push({ name: '', color: 'purple' }); draw(); root.querySelector('.row:last-of-type input')?.focus(); } }, '+ Add tag'),
            h('button', { type: 'button', class: 'sg-btn sg-primary', onclick: async (e) => {
              e.target.disabled = true; status.textContent = 'Saving…';
              try { rows = (await saveList(rows.filter((t) => t.name.trim()))).map((t) => ({ ...t })); draw(); AE.toast('Waymark', 'Tag list saved for everyone at the store.', 'ok'); }
              catch (err) { status.textContent = ''; e.target.disabled = false; fail("couldn't save the tag list", err); }
            } }, 'Save tag list'),
            status),
          h('div', { class: 'sg-soft', style: 'margin-top:4px' }, 'Saves straight away (not with Save & reload). Removing a tag from the list keeps it on work orders as a one-off.'));
      };
      draw();
    }).catch((e) => root.replaceChildren(h('div', { class: 'sg-soft', style: 'margin-top:8px' }, "Couldn't load the tag list: " + (e.message || e))));
    return root;
  }
  const listSig = () => JSON.stringify(cache && cache.list);
  const summary = () => (cache ? cache.list.length + ' tag' + (cache.list.length === 1 ? '' : 's') : 'Store tags');

  return { API, configured, load, tagsOf, autoOf, checkWo, customerTexted, dueMarks, today, OPEN_KEY, planScan, fmtDate, nickDate, parseNick, listSig, setTag, history, saveList, canEdit, scan, chip, autoChip, historyLine, dueState, when, fail, ensureCss, editor, summary, COLORS };
})();

AE.crystal({
  id: 'waymark',
  name: 'Waymark',
  sites: ['portal.ubreakifix.net'],
  run() {
    const { h } = AE;
    const W = AE.waymark;
    if (!W.configured()) return;
    W.ensureCss();
    AE.on('text-sent', ({ woId }) => {
      if (!woId) return;
      AE.sleep(1500).then(() => W.customerTexted(woId)) // let Portal's send land first
        .catch((e) => W.fail("the text went out, but the Auto-Waymark couldn't be moved", e));
    });
    const ROW_ID = 'sg-wm-row', POP_ID = 'sg-wm-pop', BTN_ID = 'sg-wm-btn', BOARD_ID = 'sg-wm-board';
    const currentWoId = () => { const m = location.pathname.match(/^\/repair\/workorder\/(\d+)/); return m ? m[1] : null; };
    const nameRow = (woId) => {
      const heading = [...document.querySelectorAll('[data-aui="text"]')].find((el) => el.offsetParent && el.textContent.trim().startsWith('Work order #' + woId));
      return heading && heading.parentElement;
    };

    // ---------------------------------------------------- WO page: chips + "+ Tag"
    function renderRow() {
      const woId = currentWoId();
      const anchor = woId && nameRow(woId);
      let row = document.getElementById(ROW_ID);
      if (!anchor) { row?.remove(); return; }
      const key = woId + '|' + JSON.stringify(W.tagsOf(woId)) + '|' + JSON.stringify(W.autoOf(woId)) + '|' + W.listSig(); // redraw on any change
      if (row && row.dataset.key === key && row.parentElement === anchor) return;
      row?.remove();
      row = h('span', { id: ROW_ID, 'data-key': key },
        W.autoOf(woId) ? W.autoChip(woId, W.autoOf(woId), renderRow) : null,
        W.tagsOf(woId).map((t) => W.chip(t.tag, { title: t.tag + ' · added by ' + (t.by || 'someone') + ', ' + W.when(t.at), onRemove: () => toggle(woId, t.tag, false) })),
        h('button', { type: 'button', class: 'sg-btn add', onclick: (e) => { e.stopPropagation(); togglePop(woId); } }, '+ Tag'));
      anchor.appendChild(row);
    }

    async function toggle(woId, tag, on) {
      try { await W.setTag(woId, tag, on); } catch (e) { W.fail("couldn't update tags", e); }
      renderRow();
      if (document.getElementById(POP_ID)) renderPop(woId);
    }

    function togglePop(woId) {
      if (document.getElementById(POP_ID)) { document.getElementById(POP_ID).remove(); return; }
      renderPop(woId);
    }
    function renderPop(woId) {
      const btn = document.querySelector('#' + ROW_ID + ' .add');
      let pop = document.getElementById(POP_ID);
      if (!pop) { pop = h('div', { id: POP_ID, class: 'sg sg-card', role: 'dialog', 'aria-label': 'Tags for this work order' }); document.body.appendChild(pop); }
      const on = new Set(W.tagsOf(woId).map((t) => t.tag));
      W.load().then((c) => {
        const input = h('input', { type: 'text', placeholder: 'Add a one-off tag, then Enter', maxlength: 32, onkeydown: (e) => {
          if (e.key === 'Enter' && input.value.trim()) { const v = input.value.trim(); input.value = ''; toggle(woId, v, true); }
          if (e.key === 'Escape') pop.remove();
        } });
        const oneoffs = [...on].filter((t) => !c.list.some((l) => l.name === t));
        const hist = h('ol', null, h('li', { class: 'sg-soft' }, 'Loading…'));
        pop.replaceChildren(
          h('h4', null, "Store tags"),
          h('div', { class: 'chips' }, c.list.length ? c.list.map((l) => {
            const el = W.chip(l.name, { cls: 'toggle' + (on.has(l.name) ? '' : ' off'), title: on.has(l.name) ? 'Click to remove' : 'Click to add' });
            el.setAttribute('role', 'button'); el.tabIndex = 0;
            el.onclick = () => toggle(woId, l.name, !on.has(l.name));
            el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.onclick(); } };
            return el;
          }) : h('span', { class: 'sg-soft' }, 'No store tags yet. A manager can add them in Settings → Waymark.')),
          oneoffs.length ? h('h4', null, 'One-off tags') : null,
          oneoffs.length ? h('div', { class: 'chips' }, oneoffs.map((t) => W.chip(t, { onRemove: () => toggle(woId, t, false) }))) : null,
          h('h4', null, 'Add one-off'),
          input,
          h('h4', null, 'History'),
          hist);
        const r = btn && btn.getBoundingClientRect();
        if (r) { pop.style.top = Math.min(r.bottom + 8, innerHeight - pop.offsetHeight - 8) + 'px'; pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)) + 'px'; }
        W.history(woId).then((items) => {
          hist.replaceChildren(...(items.length ? items.map(W.historyLine)
            : [h('li', { class: 'sg-soft' }, 'No tag changes yet.')]));
        }).catch(() => hist.replaceChildren(h('li', { class: 'sg-soft' }, "Couldn't load history.")));
      }).catch((e) => { pop.replaceChildren(h('div', { class: 'sg-soft' }, "Couldn't load tags: " + (e.message || e))); });
    }
    document.addEventListener('click', (e) => {
      // composedPath: the clicked chip may already be redrawn (detached) by now.
      const pop = document.getElementById(POP_ID), path = e.composedPath();
      if (pop && !path.includes(pop) && !path.includes(document.getElementById(ROW_ID)) && !path.some((n) => n.id === 'sg-wm-push')) pop.remove();
    });

    // ---------------------------------------------------- header button + board
    function renderButton() {
      const anchor = [...document.querySelectorAll('button')].find((x) => x.offsetParent && x.textContent.trim() === 'UBIF support');
      let b = document.getElementById(BTN_ID);
      if (!anchor) { b?.remove(); return; }
      if (!b) b = h('button', { type: 'button', id: BTN_ID, class: 'sg', title: 'Waymark: work orders by tag', 'aria-label': 'Waymark board', html: AE.actionIcon('waymark', 26), onclick: (e) => { e.stopPropagation(); toggleBoard(); } });
      if (b.parentElement !== anchor.parentElement || b.nextSibling !== anchor) anchor.parentElement.insertBefore(b, anchor);
      // Badge: open Auto-Waymarks due today (or overdue).
      const n = demoBadge != null ? demoBadge : W.dueMarks().length; // demoBadge: dev tools
      let badge = b.querySelector('.badge');
      if (!n) { badge?.remove(); b.title = 'Waymark: work orders by tag'; }
      else {
        if (!badge) { badge = h('span', { class: 'badge' }); b.append(badge); }
        if (badge.textContent !== String(n)) badge.textContent = n > 99 ? '99+' : String(n);
        b.title = 'Waymark: ' + n + ' Auto-Waymark' + (n === 1 ? '' : 's') + ' due';
      }
      placeBubble();
    }

    // ---------------------------------------------------- morning notice (managers)
    // First Portal load of the day: if any Auto-Waymarks were left open past
    // their due day (so open past 9 PM that night), a speech bubble from the icon.
    const MORNING_KEY = 'ae_wm_morning_shown';
    let demoBadge = null;
    function placeBubble() {
      const bub = document.getElementById('sg-wm-bubble'), b = document.getElementById(BTN_ID);
      if (!bub || !b) return;
      const r = b.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left + r.width / 2 - bub.offsetWidth + 40, innerWidth - bub.offsetWidth - 8));
      bub.style.left = left + 'px'; bub.style.top = (r.bottom + 12) + 'px';
      bub.querySelector('.tail').style.left = (r.left + r.width / 2 - left - 7) + 'px';
    }
    async function morningNotice() {
      if (GM_getValue(MORNING_KEY, '') === W.today()) return;
      const role = await W.canEdit();
      if (!role.ok) return;
      const rows = await AE.data.workorders(Date.now(), 0);
      GM_setValue(W.OPEN_KEY, { at: Date.now(), ids: rows.map((r) => Number(r.workorderId)) });
      const c = await W.load(true);
      const open = new Set(rows.map((r) => String(r.workorderId)));
      const late = Object.entries(c.auto).filter(([id, m]) => open.has(String(id)) && m.due < W.today()).length;
      GM_setValue(MORNING_KEY, W.today()); // once a day, whether or not there's anything to say
      if (late) showBubble(late);
    }
    function showBubble(late) {
      if (document.getElementById('sg-wm-bubble')) return;
      const bub = h('div', { id: 'sg-wm-bubble', class: 'sg sg-card', role: 'alert' },
        h('span', { class: 'tail' }),
        h('div', { class: 'top' }, h('span', { class: 'n' }, String(late)),
          h('div', null, late === 1 ? 'There is 1 Auto-Waymark sitting open. Please take a look at it ASAP.'
            : 'There are ' + late + ' Auto-Waymarks sitting open. Please take a look at these ASAP.')),
        h('div', { class: 'sg-actions' },
          h('button', { type: 'button', class: 'sg-btn', onclick: () => bub.remove() }, 'Later'),
          h('button', { type: 'button', class: 'sg-btn sg-primary', onclick: () => {
            bub.remove(); boardTab = 'auto';
            // After this click finishes, or the board's click-outside handler would close it at once.
            setTimeout(() => { if (!document.getElementById(BOARD_ID)) toggleBoard(); }, 0);
          } }, 'Show them')));
      document.body.appendChild(bub);
      placeBubble();
    }

    let boardFilter = null; // tag name, or null = all
    let boardTab = 'tags';  // 'tags' | 'auto'
    let boardManager = false; // managers clear tags right from the board
    async function toggleBoard() {
      if (document.getElementById(BOARD_ID)) { document.getElementById(BOARD_ID).remove(); return; }
      const header = document.querySelector('.components-header');
      const board = h('div', { id: BOARD_ID, class: 'sg sg-card', role: 'dialog', 'aria-label': 'Waymark board',
        style: 'top:' + Math.round((header ? header.getBoundingClientRect().bottom : 64) + 8) + 'px' },
        h('div', { class: 'head' }, h('span', { html: AE.actionIcon('waymark', 26) }), h('b', null, 'Waymark'),
          h('button', { type: 'button', class: 'sg-x', title: 'Close', onclick: () => board.remove() }, '✕')),
        h('div', { class: 'list' }, h('div', { class: 'sg-soft' }, h('span', { class: 'sg-spin', style: 'display:inline-block;vertical-align:-3px;margin-right:6px' }), 'Loading open work orders…')));
      document.body.appendChild(board);
      AE.track('waymark:board');
      try {
        const [c, wos, role] = await Promise.all([W.load(true), AE.data.workorders(Date.now(), 0), W.canEdit().catch(() => ({ ok: false }))]);
        boardManager = !!role.ok;
        drawBoard(board, c, wos);
        W.scan(wos).then(() => W.load()).then((c2) => { if (board.isConnected) drawBoard(board, c2, wos); }).catch(() => {});
      } catch (e) {
        board.querySelector('.list').replaceChildren(h('div', { class: 'sg-soft' }, "Couldn't load: " + (e.message || e)));
      }
    }
    function drawBoard(board, c, wos) {
      const byId = new Map(wos.map((r) => [String(r.workorderId), r]));
      const marked = Object.entries(c.auto || {}).filter(([id]) => byId.has(String(id)));
      const late = marked.filter(([, m]) => W.dueState(m.due) === 'overdue').length;
      const tabBtn = (id, label, n, extra) => h('button', { type: 'button', class: 'tab' + (boardTab === id ? ' on' : ''), role: 'tab', 'aria-selected': String(boardTab === id),
        onclick: () => { boardTab = id; drawBoard(board, c, wos); } }, label, h('span', { class: 'n' }, n), extra);
      board.querySelector('.tabs')?.remove();
      board.querySelector('.head').after(h('div', { class: 'tabs', role: 'tablist' },
        tabBtn('tags', 'Tags', Object.keys(c.tags).filter((id) => byId.has(String(id))).length),
        tabBtn('auto', 'Auto-Waymark', marked.length, late ? h('span', { class: 'late', title: late + ' overdue' }, late) : null)));
      const woLine = (id) => {
        const r = byId.get(String(id));
        const dev = (r.customerDevice && r.customerDevice.name) || (r.deviceCatalog && r.deviceCatalog.name) || '';
        return h('div', null,
          h('a', { href: '/repair/workorder/' + id }, 'WO ' + id), ' · ', AE.data.nameOf(r) || 'Customer',
          h('div', { class: 'meta' }, [r.workorderStatusName, dev].filter(Boolean).join(' · ')));
      };
      if (boardTab === 'auto') {
        board.querySelector('.filters')?.remove();
        const redraw = () => W.load().then((c2) => drawBoard(board, c2, wos)).catch(() => {});
        const sections = [['overdue', 'Overdue'], ['today', 'Due today'], ['upcoming', 'Upcoming']];
        const sorted = marked.sort(([, a], [, b]) => a.due.localeCompare(b.due));
        board.querySelector('.list').replaceChildren(...(sorted.length ? sections.map(([st, title]) => {
          const rows = sorted.filter(([, m]) => W.dueState(m.due) === st);
          return rows.length ? h('div', { class: 'group' }, h('div', { class: 'gh' }, title + ' · ' + rows.length),
            rows.map(([id, m]) => h('div', { class: 'wo' }, woLine(id), h('div', { class: 'chips' }, W.autoChip(id, m, redraw))))) : null;
        }).filter(Boolean) : [h('div', { class: 'sg-soft', style: 'padding:8px 0' }, 'No Auto-Waymarks. A work order gets one, 3 days out, when it reaches Ready for pickup.')]),
          h('div', { class: 'sg-soft', style: 'padding:6px 0 2px' }, 'Right-click a date to push it later; × removes it.'));
        return;
      }
      const tagged = Object.entries(c.tags).filter(([id]) => byId.has(String(id)));
      // Groups: managed list order, then one-offs A–Z.
      const names = [...c.list.map((l) => l.name)];
      const oneoffs = new Set();
      tagged.forEach(([, ts]) => ts.forEach((t) => { if (!names.includes(t.tag)) oneoffs.add(t.tag); }));
      names.push(...[...oneoffs].sort((a, b) => a.localeCompare(b)));
      const counts = Object.fromEntries(names.map((n) => [n, tagged.filter(([, ts]) => ts.some((t) => t.tag === n)).length]));
      const shown = names.filter((n) => counts[n] && (!boardFilter || boardFilter === n));
      const woRow = (id, ts) => {
        const r = byId.get(String(id));
        const dev = (r.customerDevice && r.customerDevice.name) || (r.deviceCatalog && r.deviceCatalog.name) || '';
        return h('div', { class: 'wo' },
          h('div', null,
            h('a', { href: '/repair/workorder/' + id }, 'WO ' + id), ' · ', AE.data.nameOf(r) || 'Customer',
            h('div', { class: 'meta' }, [r.workorderStatusName, dev].filter(Boolean).join(' · '))),
          h('div', { class: 'chips' }, ts.map((t) => W.chip(t.tag, !boardManager ? {} : {
            title: t.tag + ' · added by ' + (t.by || 'someone') + ', ' + W.when(t.at),
            onRemove: async () => {
              try { await W.setTag(id, t.tag, false); } catch (e) { return W.fail("couldn't remove " + t.tag, e); }
              AE.track('waymark:boardUntag');
              drawBoard(board, await W.load(), wos);
            },
          }))));
      };
      const filterChip = (n) => {
        const el = W.chip(n, { label: n + ' (' + counts[n] + ')', cls: 'toggle' + (boardFilter && boardFilter !== n ? ' off' : ''), title: 'Show only ' + n });
        el.onclick = () => { boardFilter = boardFilter === n ? null : n; drawBoard(board, c, wos); };
        return el;
      };
      board.querySelector('.filters')?.remove();
      const filters = h('div', { class: 'filters' }, names.filter((n) => counts[n]).map(filterChip));
      board.querySelector('.tabs').after(filters);
      board.querySelector('.list').replaceChildren(...(shown.length ? shown.map((n) => {
        const rows = tagged.filter(([, ts]) => ts.some((t) => t.tag === n))
          .sort(([a], [b]) => Date.parse(byId.get(String(a)).createdAt) - Date.parse(byId.get(String(b)).createdAt));
        return h('div', { class: 'group' }, h('div', { class: 'gh' }, W.chip(n), rows.length + ' open'), rows.map(([id, ts]) => woRow(id, ts)));
      }) : [h('div', { class: 'sg-soft', style: 'padding:8px 0' }, c.list.length ? 'No open work orders are tagged yet. Open a work order and use + Tag.' : 'No tags yet. A manager can set up the store list in Settings → Waymark; anyone can add one-off tags from a work order.')]),
        h('div', { class: 'sg-soft', style: 'padding:6px 0 2px' }, ((n) => n + ' open work order' + (n === 1 ? ' has' : 's have') + ' no tags.')(wos.length - tagged.length)));
    }
    document.addEventListener('click', (e) => {
      const b = document.getElementById(BOARD_ID), path = e.composedPath();
      if (b && !path.includes(b) && !path.includes(document.getElementById(BTN_ID)) && !path.some((n) => n.id === 'sg-wm-push')) b.remove();
    });

    // A tech setting this WO to Ready for pickup saves it with PUT /api/workorder/{id}
    // (or its /status). The page keeps its own fetch, so watch the network log,
    // then re-read the WO. Our own re-read lands inside the 5 s window and is ignored.
    let lastCheck = 0;
    try {
      new PerformanceObserver((list) => {
        const woId = currentWoId();
        if (!woId || Date.now() - lastCheck < 5000) return;
        const re = new RegExp('/api/workorder/' + woId + '(/status)?(?:[?#]|$)');
        if (!list.getEntries().some((e) => re.test(e.name))) return;
        lastCheck = Date.now();
        setTimeout(() => W.checkWo(woId).catch((e) => console.warn('[' + AE_NAME + '] Auto-Waymark check:', e.message || e)), 1500);
      }).observe({ type: 'resource', buffered: false });
    } catch (_) { /* no PerformanceObserver: the 10-minute scan still covers it */ }

    // Dev tools (dev builds only) drive these.
    Object.assign(AE.hooks, {
      waymarkBubble: (n) => { document.getElementById('sg-wm-bubble')?.remove(); showBubble(n); },
      waymarkBadge: (n) => { demoBadge = n; renderButton(); },
      waymarkMorning: () => { GM_deleteValue(MORNING_KEY); return morningNotice(); },
    });

    AE.on('waymark-changed', () => { renderRow(); });
    W.load().catch(() => {});
    AE.every(1000, () => {
      renderButton();
      if (currentWoId()) { W.load().then(renderRow).catch(() => {}); renderRow(); }
      else { document.getElementById(ROW_ID)?.remove(); document.getElementById(POP_ID)?.remove(); }
    });
    // Every 10 minutes (shared across tabs): Auto-Waymark new Ready for pickup
    // WOs, and report closed ones so their tags/marks clear 7 days later.
    const tick = () => W.scan().catch((e) => console.warn('[' + AE_NAME + '] Waymark scan:', e.message || e));
    setTimeout(tick, 15000);
    // Managers' morning notice, once the header is up.
    setTimeout(() => morningNotice().catch((e) => console.warn('[' + AE_NAME + '] Waymark morning notice:', e.message || e)), 4000);
    setInterval(tick, 60 * 1000); // scan() itself waits out the 10 minutes
  },
});

// ===== 57-row-colors.js =====
/*
  Rainbow Drip (WO list row colors) — colors each row of a work-order list
  by its status (Garrett's colors, Sep 30, 2026).

  Portal draws the status as a tag in a "Status" column and puts nothing on
  the row itself, so every row with a work-order link gets a class
  `status-<status name>` (e.g. status-ready-for-pickup) and the CSS below
  colors its cells. The Status column is found by its header; without one,
  the first cell whose text is a known status is used. React reuses rows,
  so the class is swapped whenever a row's status text changes.

  It replaces another dev's userscript, "UBIF Status Row Classes", which does
  the same thing the same way. If that (or a Stylus style) is still running,
  a notice explains how to turn it off. Signs of it: a stylesheet that isn't
  ours styling `tr.status-…`, or a row that already has a status- class we
  didn't put there.
*/
AE.crystal({
  id: 'rowColors',
  name: 'Rainbow Drip',
  sites: ['portal.ubreakifix.net'],
  run() {
    const RED = '#ff00007a', BLUE = '#24b0ff73', GREEN = '#2bff3875', PURPLE = '#a900ff6e', YELLOW = '#fffe0073';
    const COLORS = {
      'ready-for-work': RED,
      'diagnostics': BLUE,
      'work-in-progress': BLUE,
      'quality-check': BLUE,
      'ready-for-pickup': GREEN,
      'need-to-order': PURPLE,
      'awaiting-callback': YELLOW,
      'awaiting-item': YELLOW,
      'awaiting-device': YELLOW,
      'ready-for-diag': PURPLE,
      'repair-summary': PURPLE,
    };
    const slug = (t) => t.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    document.head.append(AE.h('style', { id: 'ae-row-colors' }, Object.entries(COLORS).map(([s, c]) =>
      `tr.status-${s} td, [role="row"].status-${s} > [role="cell"], [role="row"].status-${s} > [role="gridcell"] { background: ${c} !important; }`).join('\n')));

    const cellsOf = (row) => [...row.children].filter((c) => /^(TD|TH)$/.test(c.tagName) || /^(cell|gridcell|columnheader)$/.test(c.getAttribute('role') || ''));
    // Index of the "Status" column, from the table's header row.
    function statusIndex(table) {
      const head = table.querySelector('thead tr, [role="row"]:has(> [role="columnheader"])');
      return head ? cellsOf(head).findIndex((c) => c.textContent.trim().toLowerCase() === 'status') : -1;
    }

    function paint() {
      const rows = document.querySelectorAll('tbody tr, [role="row"]');
      const idx = new Map();
      for (const row of rows) {
        if (!row.querySelector('a[href*="/repair/workorder/"]')) continue;
        const table = row.closest('table, [role="table"], [role="grid"]');
        if (table && !idx.has(table)) idx.set(table, statusIndex(table));
        const cells = cellsOf(row), i = table ? idx.get(table) : -1;
        let status = i >= 0 && cells[i] ? slug(cells[i].textContent) : '';
        if (!status) status = cells.map((c) => slug(c.textContent)).find((s) => s in COLORS) || '';
        // A status- class on a row we haven't touched yet, or one that isn't ours.
        const mine = row.dataset.aeStatus === undefined ? null : 'status-' + row.dataset.aeStatus;
        if (!foreign && [...row.classList].some((c) => c.startsWith('status-') && c !== mine)) foundOther('row class');
        if (row.dataset.aeStatus === status) continue;
        if (row.dataset.aeStatus) row.classList.remove('status-' + row.dataset.aeStatus);
        if (status) row.classList.add('status-' + status);
        row.dataset.aeStatus = status;
      }
    }
    // ------------------------------------------------ the old script, still on?
    let foreign = null;
    const OTHER_CSS = /tr\.status-[a-z]/;
    function otherStylesheet() {
      for (const el of document.querySelectorAll('style')) if (el.id !== 'ae-row-colors' && OTHER_CSS.test(el.textContent)) return true;
      for (const sh of [...(document.adoptedStyleSheets || [])]) {
        try { if ([...sh.cssRules].some((r) => OTHER_CSS.test(r.cssText))) return true; } catch (_) {}
      }
      return false;
    }
    function foundOther(how) {
      foreign = how;
      console.info('[' + AE_NAME + '] Rainbow Drip: another script is also coloring WO rows (' + how + ')');
      notice();
    }
    // Checked every few seconds for the first two minutes of a page (the other
    // script may start after us).
    const started = Date.now();
    const styleCheck = setInterval(() => {
      if (foreign || Date.now() - started > 120000) return clearInterval(styleCheck);
      if (otherStylesheet()) foundOther('stylesheet');
    }, 3000);

    const DISMISS_KEY = 'ae_row_colors_other_dismissed';
    function notice(opts = {}) {
      const id = 'sg-rowcolors-notice';
      document.getElementById(id)?.remove();
      try { if (!opts.force && sessionStorage.getItem(DISMISS_KEY)) return; } catch (_) {}
      const { h } = AE;
      const close = () => card.remove();
      const card = h('div', { id, class: 'sg sg-card', role: 'status', style:
        'position:fixed;z-index:2147483645;left:16px;bottom:16px;max-width:440px;padding:12px 14px;display:flex;gap:10px;align-items:flex-start;font-size:14px;line-height:1.45;animation:sg-in .2s ease-out' },
        h('span', { style: 'line-height:0;flex:none', html: AE.actionIcon('rowColors', 28) }),
        h('div', { style: 'flex:1' },
          h('b', { style: 'display:block;margin-bottom:2px' }, 'Another script is also coloring these rows'),
          h('div', { class: 'sg-soft', style: 'font-size:13px' },
            'Rainbow Drip in ' + AE_NAME + ' now colors work orders by status, so ', h('b', null, 'UBIF Status Row Classes'), " isn't needed. Turn it off so the two don't clash:"),
          h('ol', { class: 'sg-soft', style: 'font-size:13px;margin:6px 0;padding-left:20px' },
            h('li', null, 'Click the ', h('b', null, 'Tampermonkey'), " icon in your browser's toolbar (it may be under the puzzle-piece Extensions menu)."),
            h('li', null, 'Find ', h('b', null, 'UBIF Status Row Classes'), ' in the list and click its switch so it turns off.'),
            h('li', null, 'Reload this page.')),
          h('div', { class: 'sg-soft', style: 'font-size:12px' }, "If it's a style in Stylus instead, click the Stylus icon and untick it."),
          h('div', { style: 'display:flex;gap:8px;margin-top:10px' },
            h('button', { type: 'button', class: 'sg-btn sg-primary', style: 'height:30px;font-size:13px', onclick: () => location.reload() }, 'Reload page'),
            h('button', { type: 'button', class: 'sg-btn', style: 'height:30px;font-size:13px', onclick: () => { try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch (_) {} close(); } }, 'Later'))),
        h('button', { type: 'button', class: 'sg-x', title: 'Dismiss', onclick: close }, '✕'));
      (document.body || document.documentElement).appendChild(card);
    }
    AE.hooks.rowColorsNotice = () => notice({ force: true }); // dev tools

    // Lists render and re-render without a page load: repaint on DOM changes (once per frame).
    let queued = false;
    new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; paint(); }); } })
      .observe(document.body, { childList: true, subtree: true, characterData: true });
    paint();
    AE.trackDaily('rowColors:on');
  },
});

// ===== 58-fixes.js =====
/*
  Master's Mend — small fixes to Portal, each with its own switch under the
  crystal in Settings (settings.fixes[id]). New fixes go in FIXES below.

  - logoLink: the ubreakifix logo (top left) is a <button> that routes to the
    dashboard ("/") on click, so it can't be middle-clicked or right-clicked
    into a new tab. A real link to "/" sits over it: middle click, Ctrl/⌘
    click and the right-click menu act on the link; a plain click still goes
    through Portal's own button (no page reload). React owns the button and
    image, so they're never moved; the link is an extra child of the logo
    wrapper, put back if Portal re-renders the header.

  - scanNav: scan to open. Portal already detects barcode scans (its root
    layout: keys under features.scan_delay_ms = 40 ms apart, ending in Enter →
    window event "scanDetected" {scan}) and uses them in a few places: an
    item label on a WO adds it to the cart, an "SO…/WO…" receipt opens a
    "Navigate to work order" dialog, the open global search looks up a
    12-character scan. Nothing handled a WO label (the bare WO number), so
    scanning one did nothing. This fix:
      · WO label (a 9-digit WO number, or WO<number>) → opens that WO,
        anywhere except inventory (/boh), check-in and check-out, where
        scans are data entry. Checked against Portal first.
      · item label (<item number>-<10+ digit serial>) → opens the item's
        page, but only from the dashboard, WO lists, customers and the
        store-products pages. On a WO, Portal adds it to the WO instead.
      · never while you're typing in a field or a dialog/drawer is open
        (the scan is meant for that field), and never acts on scans
        Portal's own pages consume.
    Scanners slower than Portal's 40 ms window were missed entirely; when
    Aethernet sees a scan (keys up to 60 ms apart) that Portal didn't, it
    sends Portal the same scanDetected event, so Portal's own scan features
    work with those scanners too.

  - autoNotes: a "Hide auto notes" switch at the top of a WO's notes.
    Portal's notes are noteType Auto (1: status changes, "X started
    check-in", estimate/contact logs…) or Manual (2: what people write; also
    Recitation's text notes). The notes tab (data-testid "notes-tab") draws
    each as a card with id "note-<noteId>" from the Redux "notes" slice, so
    the auto ones' ids come from there (AE.portal select) and a stylesheet
    hides them; nothing is changed or deleted, and Portal's cards aren't
    touched. The switch is remembered in this browser; flip it back any time.
    While it's on, all of the WO's notes are loaded straight away (Portal's
    own "Show more", data-testid "show-more-link", clicked until it's gone),
    so what's left is the full history of what people wrote, not just page 1.

  - notContacted: a "Not contacted" chip on the Arrivals page
    (/check-in/arrivals), in Portal's chip row (ManualSelectionChips:
    data-aui "chips.manual-selection", each chip a .chipElement with
    role=checkbox/aria-checked; ours is cloned from Portal's chip, and the
    Aethernet mark floats over its corner, since the row clips anything that
    sticks out). Contacted arrivals carry arrival attribute 53
    (ArrivalAttributeType.Contacted, Portal's ubif-types bundle) with a value;
    that's what draws the Contacted tag. Portal's list is paged (10 a page)
    and the server only filters *contacted* (contacted=false acts like true),
    so the chip selects Portal's "All" underneath, Aethernet loads every page
    itself (GET /api/arrivals/upcoming-arrivals with the args Portal's
    getUpcomingArrivals query was loaded with), and Portal's own table is
    handed the not-contacted ones: the loaded result is patched in place
    (AE.portal patch = RTK's patchQueryData), so it looks and behaves like
    every other Arrivals page. Settings can limit it to arrivals still Not
    confirmed (status 20). It follows Portal's day, reloads every minute
    (and re-patches if Portal refetches), and any of Portal's chips reloads
    Portal's own list. Like Portal's chips, it isn't remembered once you
    leave the page.

  - reportsRetry: Portal's Reports page (/reporting/metrics) shows its spinner
    until GET /api/reporting/metrics (RTK getMetricsConfig) has data, and has
    no error state, so one blocked request spins forever. Cause confirmed by
    Garrett (Oct 2026, Firefox): uBlock Origin blocks it (Firefox reports
    "NetworkError when attempting to fetch resource"); turning it off for the
    page brings Reports back. Retrying can't beat a blocker, so after 8 s
    without the Reports card a warning says to turn off the ad blocker for
    portal.ubreakifix.net and reload; the details (RTK status/error, whether
    the browser sent the request, Portal's script errors) go where bug
    reports pick them up.

  - woSort: sort the Work orders list by any column. Portal's table only
    offers ▲▼ on one or two columns per tab (repair.js FA[…].sortableColumns),
    though the server sorts by more. The list's sort is Redux state
    (repair.workorderlistFilterSelection[<primary filter>], `order` =
    "<column id>,ASC|DESC", per tab under tabs[<tab>].order), and the list
    refetches when it changes, so a header click here sets it exactly as
    Portal's own icons do (AE.portal dispatch of
    repair/setWorkorderlistFilterSelection, back to page 1).
      · Sorted by the server, across every page (checked Oct 1, 2026): WO #,
        Created, Program, Status, Next update, Last update, Closed, Cancelled,
        Total.
      · The server ignores or fails on Customer, Device/Issue, Location,
        Service Outcome, Completed, Created By, Cancelled By: those sort the
        rows on the page you're looking at (pick 100 per page for more), and
        say so in their tooltip.
    Portal's own ▲▼ columns are left as they are. Rows moved for a page sort
    are React's, and React re-renders assuming its own order, so the list's
    real order is read from Portal's loaded data (getAllWorkOrders) and the
    rows are put back in it whenever no page sort is on.
*/
AE.fixesInfo = [
  ['logoLink', 'Logo link', 'The ubreakifix logo is a real link to the dashboard: middle-click or right-click it to open a new tab.'],
  ['autoNotes', 'Hide auto notes switch', 'A switch at the top of a work order\'s notes hides the automatic ones (status changes, check-in logs…) and loads every note, so you see everything people wrote. Flip it back any time; nothing is deleted.'],
  ['notContacted', 'Not contacted (Arrivals)', 'A "Not contacted" chip on the Arrivals page, next to Portal\'s own, lists every arrival that hasn\'t been contacted yet (no Contacted tag), from every page.',
    // Which statuses the chip lists: everything not contacted, or only the ones still Not confirmed.
    (s, h) => {
      const pick = (v) => { s.fixes.notContactedStatus = v; paint(); };
      const btn = (v, label) => h('button', { type: 'button', class: 'sg-btn', 'data-v': v, style: 'height:28px;font-size:12px;padding:0 10px', onclick: () => pick(v) }, label);
      const box = h('div', { style: 'display:flex;align-items:center;gap:6px;margin:-2px 0 10px 14px;font-size:12px', class: 'sg-soft' },
        'Statuses:', btn('all', 'All'), btn('notConfirmed', 'Not confirmed only'));
      function paint() {
        const cur = s.fixes.notContactedStatus === 'notConfirmed' ? 'notConfirmed' : 'all';
        box.querySelectorAll('button').forEach((b) => { const on = b.dataset.v === cur; b.classList.toggle('sg-primary', on); b.setAttribute('aria-pressed', String(on)); });
      }
      paint();
      return box;
    }],
  ['reportsRetry', 'Reports page help', 'If Portal\'s Reports page is stuck loading, a warning explains the usual cause (an ad blocker like uBlock Origin) and how to fix it. The details are included if you send a bug report.'],
  ['woSort', 'Sort by any column', 'Every column of the Work orders list can be sorted. Most sort across all pages; a few that Portal can\'t sort (like Customer) sort the page you\'re on.'],
  ['scanNav', 'Scan to open', 'Scan a WO label to open the WO, or an item label to open the item (on a WO, items are added to it as usual). Never on inventory, check-in or check-out pages, or while typing in a field.'],
];

AE.crystal({
  id: 'fixes',
  name: "Master's Mend",
  sites: ['portal.ubreakifix.net'],
  run() {
    const on = AE.settings.fixes || {};
    const FIXES = {
      logoLink() {
        const ID = 'ae-logo-link';
        document.head.append(AE.h('style', null, `
          .components-header-logo { position: relative; }
          #${ID} { position: absolute; inset: 0; z-index: 1; }
        `));
        AE.every(1000, () => {
          const wrap = document.querySelector('.components-header-logo');
          if (!wrap || wrap.querySelector('#' + ID)) return;
          const btn = wrap.querySelector('button');
          const link = AE.h('a', { id: ID, href: '/', 'aria-label': 'Dashboard', title: 'Dashboard', tabindex: '-1' });
          link.addEventListener('click', (e) => {
            if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; // new tab / window: the browser's
            e.preventDefault();
            (btn && btn.isConnected ? btn : wrap.querySelector('button'))?.click(); // Portal's own route change
          });
          wrap.append(link);
        });
      },
      autoNotes() {
        const KEY = 'ae_hide_auto_notes', AUTO = 1; // Portal's NoteType.Auto
        const BAR = 'ae-notes-bar', STYLE = 'ae-notes-hide';
        document.head.append(AE.h('style', null, `
          #${BAR} { display:flex; align-items:center; justify-content:flex-end; gap:8px; margin:-4px 0 -6px; font-size:13px; color:var(--aui-on-surface-soft, #5d5e61); }
          #${BAR} label { display:inline-flex; align-items:center; gap:8px; padding:4px 10px 4px 6px; border-radius:10000rem; cursor:pointer; user-select:none;
            border:1px solid var(--aui-outline, #c6c6ca); background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e); font-weight:600; }
          #${BAR} label:hover { border-color:var(--aui-primary, #8223d2); }
          #${BAR} input { position:absolute; opacity:0; pointer-events:none; }
          #${BAR} .knob { position:relative; width:30px; height:18px; border-radius:10000rem; background:var(--aui-outline, #c6c6ca); transition:background .15s; flex:none; }
          #${BAR} .knob::after { content:''; position:absolute; top:2px; left:2px; width:14px; height:14px; border-radius:50%; background:#fff; transition:left .15s; }
          #${BAR} input:checked + .knob { background:var(--aui-primary, #8223d2); }
          #${BAR} input:checked + .knob::after { left:14px; }
          #${BAR} input:focus-visible + .knob { outline:2px solid var(--aui-primary, #8223d2); outline-offset:2px; }
          #${BAR} .n { font-weight:400; }
        `));
        let hide = !!GM_getValue(KEY, false);
        const style = AE.h('style', { id: STYLE });
        document.head.append(style);

        function autoIds() {
          const r = AE.portal('select', { slice: 'notes', key: 'notes', pick: ['noteId', 'noteType'] });
          return r && Array.isArray(r.value) ? r.value.filter((n) => Number(n.noteType) === AUTO || /^auto$/i.test(n.noteType)).map((n) => String(n.noteId)) : null;
        }
        // Load every page of notes: click Portal's own Show more until it goes away.
        let loading = null, loadedFor = null;
        const more = (tab) => { const b = tab.querySelector('[data-testid="show-more-link"]'); return b && b.offsetParent !== null && b.getAttribute('aria-disabled') !== 'true' ? b : null; };
        async function loadAll(tab) {
          const wo = location.pathname;
          if (loading || loadedFor === wo) return;
          loading = (async () => {
            for (let i = 0; i < 60; i++) {           // 60 pages is far more than any WO has
              const b = more(tab);
              if (!b || !tab.isConnected || location.pathname !== wo) break;
              const before = tab.querySelectorAll('[id^="note-"]').length;
              b.click();
              for (let t = 0; t < 50; t++) {        // up to 10 s for the page to land
                await AE.sleep(200);
                const busy = tab.querySelector('[data-testid="loading-more"]');
                if (tab.querySelectorAll('[id^="note-"]').length > before && !(busy && busy.offsetParent)) break;
              }
            }
            if (location.pathname === wo) loadedFor = wo;
          })().finally(() => { loading = null; paint(); });
        }

        function paint() {
          const tab = document.querySelector('[data-testid="notes-tab"]');
          if (!tab) { if (style.textContent) style.textContent = ''; return; }
          const cards = [...tab.querySelectorAll('[id^="note-"]')].filter((c) => /^note-\d+$/.test(c.id));
          const ids = autoIds();
          const shownAuto = ids ? cards.filter((c) => ids.includes(c.id.slice(5))) : [];
          const css = hide && shownAuto.length ? shownAuto.map((c) => '#' + CSS.escape(c.id)).join(',') + ' { display:none !important; }' : '';
          if (style.textContent !== css) style.textContent = css;

          let bar = document.getElementById(BAR);
          const list = cards[0] && cards[0].parentElement;
          if (!list) { bar?.remove(); return; }
          if (!bar || bar.nextElementSibling !== list) {
            bar?.remove();
            const input = AE.h('input', { type: 'checkbox', checked: hide, onchange: (e) => { hide = e.target.checked; GM_setValue(KEY, hide); AE.track(hide ? 'fixes:hideAutoNotes' : 'fixes:showAutoNotes'); paint(); } });
            bar = AE.h('div', { id: BAR },
              AE.h('span', { class: 'n' }),
              AE.h('label', { title: 'Hide the automatic notes (status changes, check-in logs…). Nothing is deleted; flip it back any time.' },
                input, AE.h('span', { class: 'knob' }), 'Hide auto notes'));
            list.before(bar); // Portal's list is a flex column; we sit just above it
          }
          bar.querySelector('input').checked = hide;
          if (hide && more(tab) && loadedFor !== location.pathname) loadAll(tab);
          bar.querySelector('.n').textContent = loading ? 'Loading all notes…' : ids === null ? "Can't tell note types apart here"
            : hide ? (shownAuto.length ? shownAuto.length + ' auto note' + (shownAuto.length === 1 ? '' : 's') + ' hidden' : 'No auto notes')
            : shownAuto.length + ' auto note' + (shownAuto.length === 1 ? '' : 's');
        }
        let queued = false;
        new MutationObserver(() => { if (!queued) { queued = true; setTimeout(() => { queued = false; try { paint(); } catch (e) { AE.noteError('autoNotes', e); } }, 150); } })
          .observe(document.body, { childList: true, subtree: true });
        paint();
      },
      notContacted() {
        const CONTACTED = 53, NOT_CONFIRMED = 20, ENDPOINT = 'getUpcomingArrivals'; // Portal's ArrivalAttributeType.Contacted, ArrivalStatusEnum.NotConfirmed; the list's query
        const onlyUnconfirmed = AE.settings.fixes.notContactedStatus === 'notConfirmed'; // Settings: Statuses
        const CHIP = 'ae-nc-chip', BADGE = 'ae-nc-badge', BUSY = 'ae-nc-busy', MUTED = 'ae-nc-muted';
        document.head.append(AE.h('style', null, `
          #${BADGE} { position:fixed; z-index:20; width:18px; height:18px; border-radius:50%; display:flex; align-items:center; justify-content:center;
            background:var(--aui-surface, #fff); color:var(--aui-primary, #8223d2); box-shadow:0 0 0 1px var(--aui-outline, #c6c6ca), 0 1px 3px rgba(12,14,17,.2); line-height:0; pointer-events:none; }
          .${MUTED} > [data-aui="icon"]:first-of-type { display:none !important; } /* Portal's ✓ on the chip we've taken over from */
          .${BUSY} { opacity:.45; pointer-events:none; transition:opacity .15s; }
        `));
        // on: our page is showing. Like Portal's own chips it resets when you leave the page.
        let on = false, rows = null, loading = null, loadedKey = null, loadedAt = 0, muted = null; // muted: { el, cls }
        const contacted = (a) => (a.arrivalAttributes || []).some((x) => Number(x.arrivalAttributeTypeId) === CONTACTED && x.value !== '' && x.value != null);
        const shown = () => AE.portal('query', { endpoint: ENDPOINT, list: 'data', field: 'arrivalId' }) || {};
        const keyOf = (args) => JSON.stringify(args && Object.assign({}, args, { page: 0, pageSize: 0 }));
        const chipsBox = () => document.querySelector('[data-aui="chips.manual-selection"]');
        const portalChips = (box) => [...box.querySelectorAll('.chipElement')].filter((c) => c.id !== CHIP);
        const labelOf = (c) => (c.querySelector('.textElement') || c).textContent.trim();

        async function loadAll(args) {
          const base = Object.assign({}, args); delete base.page; delete base.pageSize;
          const all = [];
          for (let page = 1; page <= 20; page++) {
            const q = new URLSearchParams();
            for (const [k, v] of Object.entries(Object.assign({}, base, { page, pageSize: 100 }))) if (v !== undefined && v !== null && v !== '') q.set(k, v);
            const j = await AE.api('GET', '/api/arrivals/upcoming-arrivals?' + q);
            const data = (j && j.data) || [];
            all.push(...data);
            if (!data.length || all.length >= ((j && j.rowCount) || 0)) break;
          }
          return all;
        }
        // One load at a time; if Portal's day/filters changed meanwhile, paint() starts the next one.
        function refresh(args, key) {
          loading = loadAll(args || {})
            .then((all) => {
              rows = all.filter((a) => !contacted(a) && (!onlyUnconfirmed || Number(a.arrivalStatus && a.arrivalStatus.arrivalStatusId) === NOT_CONFIRMED));
              loadedKey = key; loadedAt = Date.now();
            })
            .catch((e) => { AE.toast('Not contacted', "Couldn't load the arrivals: " + (e.message || e), 'err'); turnOff(); })
            .finally(() => { loading = null; paint(); });
        }
        // Portal's own table shows them: its loaded page becomes the not-contacted list (all of it, one page).
        function showInPortal() {
          const ids = rows.map((a) => a.arrivalId);
          if ((shown().items || []).join() === ids.join()) return;
          AE.portal('patch', { endpoint: ENDPOINT, patches: [{ op: 'replace', path: ['data'], value: rows }, { op: 'replace', path: ['rowCount'], value: Math.min(rows.length, 1) }] });
        }

        // Our chip, built from Portal's own: an unselected chip when off, the selected one when on.
        function makeChip(box) {
          const chips = portalChips(box);
          const tpl = on ? chips.find((c) => c.getAttribute('aria-checked') === 'true') : chips.find((c) => c.getAttribute('aria-checked') !== 'true');
          if (!tpl) return null;
          const c = tpl.cloneNode(true);
          c.id = CHIP; c.dataset.on = String(on);
          c.setAttribute('aria-checked', String(on));
          c.title = 'Arrivals nobody has contacted yet (no Contacted tag)' + (onlyUnconfirmed ? ', still Not confirmed' : '') + ', from every page. Added by ' + AE_NAME + ' (Settings → Master\'s Mend).';
          (c.querySelector('.textElement') || c).textContent = 'Not contacted';
          c.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (!on) turnOn(box); });
          c.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !on) { e.preventDefault(); turnOn(box); } });
          return c;
        }
        // The Aethernet mark on the chip's corner. Portal's chip row clips what sticks out,
        // so it floats above the page, pinned to the chip, over whatever is above it.
        function placeBadge() {
          const chip = document.getElementById(CHIP);
          let b = document.getElementById(BADGE);
          const r = chip && chip.getBoundingClientRect();
          if (!r || !r.width) { b?.remove(); return; }
          if (!b) { b = AE.h('span', { id: BADGE, html: AE.icon('aetheryte', 14) }); document.body.append(b); }
          b.style.left = Math.round(r.left - 7) + 'px';
          b.style.top = Math.round(r.top - 7) + 'px';
        }
        addEventListener('scroll', () => requestAnimationFrame(placeBadge), true);
        addEventListener('resize', () => requestAnimationFrame(placeBadge));

        function unmute() { if (muted) { if (muted.el.isConnected && muted.el.classList.contains(MUTED)) { muted.el.className = muted.cls; muted.el.setAttribute('aria-checked', 'true'); } muted = null; } }
        function turnOn(box) {
          const all = portalChips(box)[0]; // "All": our page is every arrival, not contacted
          if (all && all.getAttribute('aria-checked') !== 'true') all.click();
          on = true; AE.track('fixes:notContacted');
          paint();
        }
        function turnOff() {
          if (!on) return;
          on = false; unmute();
          AE.portal('refresh', { tags: ['Arrivals'] }); // Portal reloads its own page of arrivals
          paint();
        }

        function paint() {
          const box = chipsBox();
          const list = document.querySelector('[data-testid="arrivals-container"]');
          const here = /^\/check-in\/arrivals(\/\d+)?\/?$/.test(location.pathname) && box && list;
          let chip = document.getElementById(CHIP);
          if (!here || !on) document.querySelectorAll('.' + BUSY).forEach((el) => el.classList.remove(BUSY));
          if (!here) {
            chip?.remove(); placeBadge();
            if (on) { on = false; unmute(); }
            return;
          }
          if (!chip || chip.dataset.on !== String(on) || chip.parentElement !== box) {
            chip?.remove();
            chip = makeChip(box);
            if (chip) {
              const after = portalChips(box).find((c) => /^contacted$/i.test(labelOf(c)));
              if (after) after.after(chip); else box.append(chip);
            }
          }
          placeBadge();
          if (!on) return;
          // Portal's selected chip ("All") stays selected underneath; show it as unselected while ours is.
          const sel = portalChips(box).find((c) => c.getAttribute('aria-checked') === 'true');
          const plain = portalChips(box).find((c) => c.getAttribute('aria-checked') !== 'true');
          if (sel && plain && (!muted || muted.el !== sel)) {
            unmute();
            muted = { el: sel, cls: sel.className };
            sel.className = plain.className + ' ' + MUTED;
            sel.setAttribute('aria-checked', 'false');
          }
          const args = shown().args, key = keyOf(args);
          const fresh = loadedKey === key && rows;
          if (!loading && (!fresh || Date.now() - loadedAt > 60000)) refresh(args, key); // new day/filters, or a minute old
          if (fresh) showInPortal();
          list.classList.toggle(BUSY, !fresh); // Portal's unfiltered page, dimmed, until the full list is in
          const label = chip && chip.querySelector('.textElement');
          if (label) label.textContent = fresh ? 'Not contacted · ' + rows.length : 'Not contacted · …';
        }
        // Any of Portal's own chips hands the list back to Portal.
        document.addEventListener('click', (e) => {
          const c = e.target.closest && e.target.closest('[data-aui="chips.manual-selection"] .chipElement');
          if (c && c.id !== CHIP && on) turnOff();
        }, true);
        let queued = false;
        new MutationObserver((ms) => {
          if (ms.every((m) => m.target.closest && m.target.closest('#' + CHIP + ', #' + BADGE))) return; // our own redraws
          if (!queued) { queued = true; setTimeout(() => { queued = false; try { paint(); } catch (e) { AE.noteError('notContacted', e); } }, 150); }
        }).observe(document.body, { childList: true, subtree: true });
        setInterval(() => { if (on) paint(); }, 30000);
        paint();
      },
      reportsRetry() {
        const PATH = /^\/reporting\/metrics\/?$/, WAIT = 8000, CARD = 'ae-reports-warn';
        let timer = null, lastPath = '';
        const loaded = () => !!document.querySelector('.reports-card');
        function diagnose() {
          const st = AE.portal('status', { endpoint: 'getMetricsConfig' }) || {};
          const seen = performance.getEntriesByType('resource').filter((e) => /\/api\/reporting\/metrics(\?|$)/.test(e.name));
          const net = seen.length ? seen[seen.length - 1] : null;
          const blocked = !!(st.error && /FETCH_ERROR|NetworkError|Failed to fetch/i.test(st.error));
          const detail = { rtk: st, blocked, browserSawRequest: !!net,
            request: net ? { status: net.responseStatus || null, ms: Math.round(net.duration), bytes: net.transferSize } : null,
            pageErrors: AE.pageErrors.slice(-3), ua: navigator.userAgent.slice(0, 160) };
          AE.noteError('Reports page stuck', JSON.stringify(detail));
          console.warn('[' + AE_NAME + '] Reports page stuck:', detail);
          return { blocked, st };
        }
        // A warning card on the page (stays until dismissed or the page loads).
        function warn() {
          const { blocked, st } = diagnose();
          document.getElementById(CARD)?.remove();
          const close = () => card.remove();
          const card = AE.h('div', { id: CARD, class: 'sg sg-card', role: 'alert', style:
            'position:fixed;z-index:2147483645;left:16px;bottom:16px;max-width:460px;padding:12px 14px;display:flex;gap:10px;align-items:flex-start;font-size:14px;line-height:1.45;border-left:4px solid #d6a000' },
            AE.h('span', { style: 'line-height:0;flex:none;color:#d6a000', html: AE.icon('aetheryte', 26) }),
            AE.h('div', { style: 'flex:1' },
              AE.h('b', { style: 'display:block;margin-bottom:2px' }, 'Reports isn\'t loading? Turn off your ad blocker on this page'),
              AE.h('div', { class: 'sg-soft', style: 'font-size:13px' },
                (blocked ? 'Your browser stopped Portal\'s reports request before it went out. ' : '') +
                'Ad blockers like uBlock Origin block Portal\'s reports. Turn yours off for portal.ubreakifix.net (click its icon in the toolbar and switch it off for this site), then reload.'),
              !blocked && st && st.status ? AE.h('div', { class: 'sg-soft', style: 'font-size:12px;margin-top:4px' }, 'Still stuck without one? Use Send feedback → Bug; the details are included.') : null,
              AE.h('div', { style: 'display:flex;gap:8px;margin-top:10px' },
                AE.h('button', { type: 'button', class: 'sg-btn sg-primary', style: 'height:30px;font-size:13px', onclick: () => location.reload() }, 'Reload page'))),
            AE.h('button', { type: 'button', class: 'sg-x', title: 'Dismiss', onclick: close }, '✕'));
          document.body.appendChild(card);
          AE.track('fixes:reportsWarn');
        }
        AE.every(500, () => {
          const p = location.pathname;
          if (loaded()) document.getElementById(CARD)?.remove();
          if (p === lastPath) return;
          lastPath = p;
          clearTimeout(timer);
          if (!PATH.test(p)) { document.getElementById(CARD)?.remove(); return; }
          timer = setTimeout(() => { if (PATH.test(location.pathname) && !loaded()) warn(); }, WAIT);
        });
        AE.hooks.reportsDiagnose = diagnose; // dev tools
        AE.hooks.reportsWarn = warn;
      },
      woSort() {
        // Header text → Portal's column id (repair.js WA), and whether the server sorts it.
        const COLS = {
          'WO #': ['woId', 1], 'Created': ['createdDate', 1], 'Customer': ['customerName', 0], 'Device/Issue': ['deviceCatalogName', 0],
          'Program': ['woProgram', 1], 'Next update': ['nextUpdate', 1], 'Location': ['location', 0], 'Status': ['woStatus', 1],
          'Closed': ['closed', 1], 'Cancelled': ['cancelled', 1], 'Created By': ['createdBy', 0], 'Cancelled By': ['cancelledBy', 0],
          'Last update': ['lastUpdate', 1], 'Service Outcome': ['serviceOutcome', 0], 'Completed': ['completed', 0], 'Total': ['workorderTotal', 1],
        };
        const TEXT_FIRST_ASC = ['customerName', 'deviceCatalogName', 'woProgram', 'location', 'woStatus', 'createdBy', 'cancelledBy', 'serviceOutcome'];
        const BTN = 'ae-wosort';
        document.head.append(AE.h('style', null, `
          .${BTN} { display:inline-flex; flex-direction:column; vertical-align:middle; margin-left:4px; padding:0 2px; border:0; background:none; cursor:pointer;
            color:var(--aui-on-surface-soft, #5d5e61); line-height:0; border-radius:4px; }
          .${BTN}:hover { background:var(--aui-neutral-soft, #f1f0f4); color:var(--aui-on-surface, #1a1c1e); }
          .${BTN} svg { width:10px; height:7px; opacity:.45; }
          .${BTN}[data-dir="ASC"] .up, .${BTN}[data-dir="DESC"] .down { opacity:1; color:var(--aui-primary, #8223d2); }
          .${BTN}.page { border-bottom:1px dashed currentColor; border-radius:0; }
        `));
        const ARROWS = '<svg class="up" viewBox="0 0 10 7"><path fill="currentColor" d="M5 0l5 7H0z"/></svg><svg class="down" viewBox="0 0 10 7"><path fill="currentColor" d="M5 7L0 0h10z"/></svg>';

        const getSel = () => { const r = AE.portal('select', { slice: 'repair', key: 'workorderlistFilterSelection' }); return r && r.found ? r.value : null; };
        function current(sel) {
          const pf = sel && Object.keys(sel).find((k) => sel[k] && sel[k].selected);
          if (!pf) return { pf: null, order: '' };
          const g = sel[pf], tab = g.activeTab, t = tab && g.tabs && g.tabs[tab];
          return { pf, g, tab, order: (t && t.order !== undefined ? t.order : g.order) || '' };
        }
        function serverSort(id, dir) {
          const sel = getSel(), c = current(sel);
          if (!c.pf) return AE.toast('Sort', "Couldn't find the list's settings in Portal.", 'err');
          const order = id + ',' + dir;
          const entry = Object.assign({}, c.g, { order, page: 1 });
          if (c.tab) entry.tabs = Object.assign({}, c.g.tabs, { [c.tab]: Object.assign({}, (c.g.tabs || {})[c.tab], { order }) });
          const r = AE.portal('dispatch', { slice: 'repair', action: { type: 'repair/setWorkorderlistFilterSelection', payload: { [c.pf]: entry } } });
          if (!r.stores) AE.toast('Sort', "Couldn't reach Portal's list.", 'err');
          pageSort = null;
          AE.track('fixes:woSort');
        }

        // Page-only sort: reorder the rows on screen (kept through re-renders).
        let pageSort = null, moved = false; // { header, dir }; moved: rows aren't in React's order any more
        const woOf = (row) => { const a = row.querySelector('a[href*="/repair/workorder/"]'); const m = a && a.getAttribute('href').match(/workorder\/(\d+)/); return m ? Number(m[1]) : null; };
        // Portal's own order for the rows on screen (the list query's data), as WO id → position.
        function portalOrder() {
          const r = AE.portal('query', { endpoint: 'getAllWorkOrders', list: 'workOrders', field: 'workorderId' });
          return r && r.items ? new Map(r.items.map((id, i) => [Number(id), i])) : null;
        }
        const cellsOf = (row) => [...row.children].filter((c) => /^(TD|TH)$/.test(c.tagName) || /^(cell|gridcell)$/.test(c.getAttribute('role') || ''));
        const keyOf = (text) => { const t = text.trim(); const d = Date.parse(t.replace(/\s+/g, ' ')); return { t, d: /\d/.test(t) && !isNaN(d) ? d : null }; };
        function applyPageSort(table, headers) {
          const body = table.tBodies ? table.tBodies[0] : null;
          if (!body || (!pageSort && !moved)) return;
          const rows = [...body.rows];
          const base = portalOrder();
          const pos = (row) => { const id = woOf(row); return base && base.has(id) ? base.get(id) : rows.indexOf(row); };
          const i = pageSort ? headers.findIndex((h) => h.label === pageSort.header) : -1;
          const sorted = rows.slice().sort((a, b) => {
            if (i >= 0) {
              const x = keyOf((cellsOf(a)[i] || {}).innerText || ''), y = keyOf((cellsOf(b)[i] || {}).innerText || '');
              const r = x.d !== null && y.d !== null ? x.d - y.d : x.t.localeCompare(y.t, undefined, { numeric: true, sensitivity: 'base' });
              if (r) return pageSort.dir === 'ASC' ? r : -r;
            }
            return pos(a) - pos(b); // ties, and no page sort: Portal's order
          });
          if (!pageSort && base) moved = false; // back in Portal's order
          if (sorted.every((r, k) => r === rows[k])) return;
          body.append(...sorted);
          if (pageSort) moved = true;
        }

        function paint() {
          if (!/^\/repair\/workorders\/?$/.test(location.pathname)) { pageSort = null; moved = false; return; }
          const link = document.querySelector('tbody a[href*="/repair/workorder/"], tbody tr');
          const table = link && link.closest('table');
          const head = table && table.tHead && table.tHead.rows[0];
          if (!head) return;
          const order = current(getSel()).order;
          const headers = [...head.cells].map((th) => ({ th, label: (th.innerText || '').trim().split('\n')[0].trim() }));
          for (const { th, label } of headers) {
            const col = COLS[label];
            if (!col || th.querySelector('[data-testid^="sort-icon"]')) continue; // Portal's own ▲▼
            const [id, server] = col;
            let b = th.querySelector('.' + BTN);
            if (!b) {
              b = AE.h('button', { type: 'button', class: BTN + (server ? '' : ' page'), html: ARROWS,
                title: server ? 'Sort by ' + label : 'Sort this page by ' + label + " (Portal can't sort this column across pages)" });
              b.addEventListener('click', (e) => {
                e.preventDefault(); e.stopPropagation();
                const was = b.dataset.dir, first = TEXT_FIRST_ASC.includes(id) ? 'ASC' : 'DESC';
                const dir = was ? (was === 'ASC' ? 'DESC' : 'ASC') : first;
                if (server) serverSort(id, dir);
                else { pageSort = { header: label, dir }; moved = true; AE.track('fixes:woSortPage'); paint(); }
              });
              (th.querySelector('span, div') || th).append(b);
            }
            const dir = server ? (order.split(',')[0] === id ? order.split(',')[1] : '') : (pageSort && pageSort.header === label ? pageSort.dir : '');
            if ((b.dataset.dir || '') !== (dir || '')) { if (dir) b.dataset.dir = dir; else delete b.dataset.dir; }
          }
          applyPageSort(table, headers);
        }
        let queued = false;
        new MutationObserver(() => { if (!queued) { queued = true; setTimeout(() => { queued = false; try { paint(); } catch (e) { AE.noteError('woSort', e); } }, 120); } })
          .observe(document.body, { childList: true, subtree: true });
        paint();
      },
      scanNav() {
        const GAP_MS = 60; // longest pause between a scanner's keys (Portal uses 40)
        const PORTAL_EVENT = 'scanDetected', RESEND_EVENT = 'aethernet:scan';
        // Portal's scan event has to come from the page itself (the scan is in
        // its `detail`), so a tiny page script sends it for us. Plain string: see Glamour.
        const hook = () => {
          if (document.getElementById('ae-scan-hook')) return;
          const s = document.createElement('script');
          s.id = 'ae-scan-hook';
          s.textContent = '(function (a, p) { document.addEventListener(a, function (e) { dispatchEvent(new CustomEvent(p, { detail: { scan: String(e.detail) } })); }); })(' +
            JSON.stringify(RESEND_EVENT) + ',' + JSON.stringify(PORTAL_EVENT) + ');';
          (document.head || document.documentElement).append(s);
        };
        let portalSaw = 0;
        window.addEventListener(PORTAL_EVENT, () => { portalSaw = performance.now(); });

        const WO_RE = /^(?:WO)?(\d{9})$/i, ITEM_RE = /^([A-Za-z0-9]{2,})-(\d{10,})$/;
        const path = () => location.pathname;
        const busyTyping = () => {
          const a = document.activeElement;
          return !!a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
        };
        const dialogOpen = () => [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
          .some((d) => d.offsetParent !== null && !d.closest('.sg')); // Aethernet's own cards don't count
        const scanPage = () => /^\/(boh|check-in|check-out)(\/|$)/.test(path());
        const itemPage = () => path() === '/' || /^\/repair\/workorders\/?$/.test(path()) || /^\/customer(s)?(\/|$)/.test(path()) ||
          /^\/boh\/inventory\/store-products(\/|$)/.test(path());
        // Same-tab route change without a reload: Portal's router (and single-spa) follow popstate.
        const go = (url) => { history.pushState(null, '', url); dispatchEvent(new PopStateEvent('popstate', { state: null })); };

        async function act(scan, why, devTools) {
          const wo = scan.match(WO_RE), item = scan.match(ITEM_RE);
          if (!wo && !item) return 'not a WO or item label';
          if (busyTyping() && !devTools) return 'typing in a field';
          if (dialogOpen()) return 'a dialog is open';
          if (wo) {
            if (scanPage()) return 'scans are data entry on this page';
            const id = wo[1];
            if (path().startsWith('/repair/workorder/' + id)) return 'already on WO ' + id;
            try { await AE.api('GET', '/api/workorder/' + id); } catch (e) {
              AE.toast('Scan', "Couldn't open WO " + id + ': ' + (/HTTP 404/.test(e.message) ? 'no such work order.' : e.message), 'err', 6000);
              return 'WO lookup failed';
            }
            go('/repair/workorder/' + id);
            AE.track('fixes:scanWo');
            return 'opened WO ' + id + (why ? ' (' + why + ')' : '');
          }
          if (!itemPage()) return 'item scans belong to this page';
          go('/boh/inventory/store-products/' + encodeURIComponent(item[1]));
          AE.track('fixes:scanItem');
          return 'opened item ' + item[1];
        }

        // Scanner = keys arriving faster than any person types, ending in Enter.
        let buf = '', last = 0;
        window.addEventListener('keydown', (e) => {
          if (e.isComposing || /^(Shift|Control|Alt|Meta|CapsLock)$/.test(e.key)) return;
          const t = e.timeStamp, quick = t - last <= GAP_MS;
          last = t;
          if (e.key === 'Enter') {
            const scan = quick ? buf : '';
            buf = '';
            if (scan.length < 4) return;
            const before = portalSaw;
            setTimeout(() => {  // Portal handles the Enter (keypress) after this keydown
              if (portalSaw === before) { hook(); document.dispatchEvent(new CustomEvent(RESEND_EVENT, { detail: scan })); }
              act(scan).then((r) => console.debug('[' + AE_NAME + '] scan "' + scan + '": ' + r));
            }, 60);
            return;
          }
          if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) { buf = ''; return; }
          buf = quick ? buf + e.key : e.key;
        }, true);
        AE.hooks.scan = (text) => act(String(text).trim(), 'dev tools', true); // dev tools: act on a pretend scan
      },
    };
    for (const [id] of AE.fixesInfo) {
      if (on[id] === false || !FIXES[id]) continue;
      try { FIXES[id](); } catch (e) { AE.noteError("Master's Mend: " + id, e); console.error('[' + AE_NAME + "] Master's Mend: " + id + ' failed', e); }
    }
  },
});

// ===== 60-count-check.js =====
/*
  Lay of the Land (inventory count check) — on an inventory count's edit or
  review page (/boh/inventory/counts/<journalId>/edit|review), shows which
  expected serials haven't been scanned yet, and what was scanned that
  wasn't expected. Named for the Miner action that reveals what's hidden.

  Data (all GETs Portal's own count page uses):
    boh/counts/expectedSerials?journalId=…   every serial the count expects, by item
    boh/counts/<id>/item                     scanned quantity per item
    boh/counts/<id>/<itemId>/serial          the serials scanned for one item
  Portal files every scan that isn't an expected serial under three made-up
  items — "unknownitem", "invalidformat" and "duplicate" — so a real item's
  scans are always its own expected serials. That means only partially
  scanned items need their serial lists: an item with no scans is missing
  everything, and a fully scanned one is missing nothing. (Checked against a
  full serial-by-serial comparison on UBF-013049: identical, 408 missing.)
*/
AE.crystal({
  id: 'countCheck',
  name: 'Lay of the Land',
  sites: ['portal.ubreakifix.net'],
  run() {
    const { h } = AE;
    const PATH_RE = /^\/boh\/inventory\/counts\/([^/]+)\/(edit|review)\b/;
    const PILL_ID = 'sg-lol-pill', PANEL_ID = 'sg-lol';
    const FULL_MS = 10 * 60 * 1000;   // full re-read (expected list + every serial list); scans update in between
    const BUCKETS = {
      unknownitem: 'Not in stock for this store',
      invalidformat: 'Not a serial (barcode, item number, date…)',
      duplicate: 'Scanned twice',
    };
    let state = null;   // { id, status: 'loading'|'ready'|'error', data, error, at }
    let loadingFor = null, tab = 'missing', query = '';
    let cat = 'all', sortBy = 'missing';         // category filter + sort (Missing tab)
    const open = new Set();                      // expanded entries ("item:<id>" / "bucket:<id>"); collapsed by default

    document.head.append(h('style', null, `
      #${PILL_ID} { position:fixed; z-index:2147483644; right:16px; bottom:88px; display:inline-flex; align-items:center; gap:8px; height:40px; padding:0 14px 0 6px;
        border:1px solid var(--aui-outline, #c6c6ca); border-radius:10000rem; cursor:pointer; background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e);
        box-shadow:0 8px 24px rgba(12,14,17,.2); font:600 14px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; }
      #${PILL_ID}:hover { border-color:var(--aui-primary, #8223d2); }
      #${PILL_ID} .n { min-width:22px; height:22px; padding:0 7px; border-radius:10000rem; box-sizing:border-box; background:#d1344b; color:#fff; font:700 12px/22px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; text-align:center; }
      #${PILL_ID} .n.zero { background:var(--aui-status-success, #136d31); }
      #${PILL_ID} .sg-aicon { width:28px; height:28px; }
      #${PANEL_ID} { position:fixed; z-index:2147483646; right:16px; bottom:140px; width:min(620px, calc(100vw - 32px)); max-height:calc(100vh - 200px); display:flex; flex-direction:column;
        padding:16px 16px 10px; font-size:14px; line-height:1.4; }
      #${PANEL_ID} .head { display:flex; align-items:center; gap:10px; margin-bottom:10px; }
      #${PANEL_ID} .head b { flex:1; font-size:17px; }
      #${PANEL_ID} .head .sub { font-weight:400; font-size:12px; color:var(--aui-on-surface-soft, #5d5e61); }
      #${PANEL_ID} .stats { display:grid; grid-template-columns:repeat(4, 1fr); gap:8px; margin-bottom:10px; }
      #${PANEL_ID} .stat { border:1px solid var(--aui-outline-soft, #eeedf1); border-radius:10px; padding:6px 10px; }
      #${PANEL_ID} .stat .v { font-size:20px; font-weight:700; font-variant-numeric:tabular-nums; }
      #${PANEL_ID} .stat .k { font-size:11px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; color:var(--aui-on-surface-soft, #5d5e61); }
      #${PANEL_ID} .stat.bad .v { color:#d1344b; }
      #${PANEL_ID} .tabs { display:flex; gap:2px; border-bottom:1px solid var(--aui-outline-soft, #eeedf1); margin-bottom:8px; }
      #${PANEL_ID} .tab { padding:6px 10px 7px; border:0; border-bottom:2px solid transparent; margin-bottom:-1px; background:none; cursor:pointer;
        color:var(--aui-on-surface-soft, #5d5e61); font:600 13px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; }
      #${PANEL_ID} .tab.on { color:var(--aui-primary, #8223d2); border-bottom-color:var(--aui-primary, #8223d2); }
      #${PANEL_ID} .tools { display:flex; gap:6px; margin-bottom:8px; }
      #${PANEL_ID} .tools input { flex:1; min-width:0; height:32px; padding:0 10px; border:1px solid var(--aui-outline, #c6c6ca); border-radius:8px;
        background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e); font:13px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; }
      #${PANEL_ID} .tools .sg-btn { height:32px; font-size:13px; }
      #${PANEL_ID} .list { overflow:auto; }
      #${PANEL_ID} .cats { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-bottom:8px; }
      #${PANEL_ID} .cat { height:26px; padding:0 10px; border:1px solid var(--aui-outline, #c6c6ca); border-radius:10000rem; background:none; cursor:pointer;
        color:var(--aui-on-surface, #1a1c1e); font:600 12px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; }
      #${PANEL_ID} .cat.on { background:var(--aui-primary, #8223d2); border-color:var(--aui-primary, #8223d2); color:var(--aui-on-primary, #fff); }
      #${PANEL_ID} .cats select { height:26px; margin-left:auto; border:1px solid var(--aui-outline, #c6c6ca); border-radius:8px; background:var(--aui-surface, #fff);
        color:var(--aui-on-surface, #1a1c1e); font:12px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; }
      #${PANEL_ID} .cats .sg-btn { height:26px; padding:0 10px; font-size:12px; }
      #${PANEL_ID} .section { margin:10px 0 2px; font-size:11px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--aui-on-surface-soft, #5d5e61); }
      #${PANEL_ID} .item .t { cursor:pointer; user-select:none; }
      #${PANEL_ID} .item .t .chev { width:14px; height:14px; flex:none; align-self:center; color:var(--aui-on-surface-soft, #5d5e61); transition:transform .15s; transform:rotate(-90deg); }
      #${PANEL_ID} .item.open .t .chev { transform:none; }
      #${PANEL_ID} .item:not(.open) .serials { display:none; }
      #${PANEL_ID} .item.flash { animation:sg-lol-flash 1.6s ease-out; }
      @keyframes sg-lol-flash { 0%, 30% { background:color-mix(in srgb, #ffcc00 35%, transparent); } 100% { background:transparent; } }
      #${PANEL_ID} .item { padding:8px 2px; border-top:1px solid var(--aui-outline-soft, #eeedf1); }
      #${PANEL_ID} .item .t { display:flex; gap:8px; align-items:baseline; }
      #${PANEL_ID} .item .t b { flex:1; font-weight:600; }
      #${PANEL_ID} .item .t .q { font-size:12px; color:var(--aui-on-surface-soft, #5d5e61); white-space:nowrap; }
      #${PANEL_ID} .grp { font-size:11px; padding:0 6px; border-radius:10000rem; background:var(--aui-neutral-soft, #f1f0f4); color:var(--aui-on-neutral-soft, #2f3033); }
      #${PANEL_ID} .serials { display:flex; flex-wrap:wrap; gap:4px; margin-top:5px; }
      #${PANEL_ID} .serials button { border:1px solid var(--aui-outline-soft, #eeedf1); border-radius:6px; padding:2px 6px; background:var(--aui-surface-variant, #faf9fc);
        color:var(--aui-on-surface, #1a1c1e); font:12px ui-monospace, SFMono-Regular, Menlo, monospace; cursor:copy; }
      #${PANEL_ID} .serials button:hover { border-color:var(--aui-primary, #8223d2); }
      #${PANEL_ID} .foot { font-size:12px; color:var(--aui-on-surface-soft, #5d5e61); padding-top:6px; }
    `));

    const countId = () => { const m = location.pathname.match(PATH_RE); return m ? decodeURIComponent(m[1]) : null; };
    const base = (id) => '/api/boh/counts/' + encodeURIComponent(id);

    // Fetch a few at a time: gentle on Portal.
    async function pool(items, n, fn) {
      const out = new Array(items.length);
      let i = 0;
      await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
      return out;
    }

    /*
      cache (per count): the expected list and each fetched serial list with
      the scanned quantity it was fetched at. An update after a scan re-reads
      only the scanned quantities, then refetches serial lists whose quantity
      changed — about 2 requests per scan. full = start over.
    */
    let cache = null;
    async function compute(id, full) {
      if (full || !cache || cache.id !== id) cache = { id, exp: null, serials: new Map(), fullAt: Date.now() };
      const [exp, it] = await Promise.all([
        cache.exp ? cache.exp : AE.api('GET', '/api/boh/counts/expectedSerials?journalId=' + encodeURIComponent(id)),
        AE.api('GET', base(id) + '/item'),
      ]);
      cache.exp = exp;
      const lines = (exp && exp.Lines) || [];
      const rows = (it && it.ScannedItemInformation) || [];
      const qty = new Map(rows.map((r) => [String(r.ItemId), Number(r.ScannedQuantity) || 0]));
      const partial = lines.filter((l) => { const n = qty.get(String(l.ItemId)) || 0; return n > 0 && n < l.SerialNumbers.length; });
      const buckets = rows.filter((r) => BUCKETS[r.ItemId] && r.ScannedQuantity > 0);
      const need = [...partial.map((l) => String(l.ItemId)), ...buckets.map((r) => r.ItemId)];
      const stale = need.filter((itemId) => { const c = cache.serials.get(itemId); return !c || c.qty !== qty.get(itemId); });
      const serialsOf = async (itemId) => { const j = await AE.api('GET', base(id) + '/' + encodeURIComponent(itemId) + '/serial'); return (j && j.ScannedSerialNumbers) || []; };
      await pool(stale, 4, async (itemId) => { cache.serials.set(itemId, { qty: qty.get(itemId), list: await serialsOf(itemId) }); });
      const listOf = (itemId) => (cache.serials.get(itemId) || { list: [] }).list;
      const missing = [];
      for (const l of lines) {
        const n = qty.get(String(l.ItemId)) || 0;
        let miss;
        if (n === 0) miss = l.SerialNumbers.slice();
        else if (n >= l.SerialNumbers.length) miss = [];
        else { const got = new Set(listOf(String(l.ItemId)).map((x) => x.SerialNumber)); miss = l.SerialNumbers.filter((x) => !got.has(x)); }
        if (miss.length) missing.push({ itemId: String(l.ItemId), name: l.ItemName, group: l.ItemGroup, expected: l.SerialNumbers.length, missing: miss.sort() });
      }
      missing.sort((a, b) => b.missing.length - a.missing.length || a.name.localeCompare(b.name));
      const unexpected = [];
      for (const r of buckets) for (const x of listOf(r.ItemId)) unexpected.push({ serial: x.SerialNumber, bucket: r.ItemId, by: x.ScannedBy, at: x.ScannedDateTime });
      unexpected.sort((a, b) => a.bucket.localeCompare(b.bucket) || a.serial.localeCompare(b.serial));
      return {
        expected: Number(exp && exp.TotalExpected) || lines.reduce((n, l) => n + l.SerialNumbers.length, 0),
        scanned: rows.reduce((n, r) => n + (Number(r.ScannedQuantity) || 0), 0),
        missingCount: missing.reduce((n, m) => n + m.missing.length, 0),
        missing, unexpected, requests: 1 + (cache.exp === exp && !full ? 0 : 1) + stale.length,
      };
    }

    // quiet: keep showing the current numbers while updating; full: re-read everything.
    let running = null, again = false;
    async function load(id, quiet, full) {
      if (running) { again = true; return running; } // a scan burst: one update now, one after
      loadingFor = id;
      if (!quiet || !state || state.id !== id) { state = { id, status: 'loading' }; render(); }
      running = (async () => {
        const before = state && state.data;
        try {
          const data = await compute(id, full || !quiet);
          if (loadingFor !== id) return;
          // Which items just changed (to flash them in the list).
          const was = new Map((before ? before.missing : []).map((m) => [m.itemId, m.missing.length]));
          data.changed = before ? new Set(data.missing.filter((m) => was.get(m.itemId) !== m.missing.length).map((m) => m.itemId).concat([...was.keys()].filter((k) => !data.missing.some((m) => m.itemId === k)))) : new Set();
          state = { id, status: 'ready', data, at: Date.now(), fullAt: cache.fullAt };
        } catch (e) {
          if (loadingFor !== id) return;
          if (!quiet) state = { id, status: 'error', error: e.message || String(e), at: Date.now() };
        }
        render();
      })();
      try { await running; } finally { running = null; }
      if (again) { again = false; return load(id, true); }
    }

    // Every scan saves through POST boh/counts/<id>/itemSerial. Portal keeps its
    // own fetch, so watch the browser's network log, and update shortly after
    // (scans come in bursts).
    let scanTimer = null;
    try {
      new PerformanceObserver((list) => {
        const id = countId();
        if (!id || !state || state.status === 'loading') return;
        const re = new RegExp('/api/boh/counts/' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/itemSerial(?:[?#]|$)');
        if (!list.getEntries().some((e) => re.test(e.name))) return;
        clearTimeout(scanTimer);
        scanTimer = setTimeout(() => load(id, true), 700);
      }).observe({ type: 'resource', buffered: false });
    } catch (_) { /* no PerformanceObserver: the 2-minute refresh still runs */ }

    function render() {
      const id = countId();
      let pill = document.getElementById(PILL_ID);
      if (!id || !state) { pill?.remove(); document.getElementById(PANEL_ID)?.remove(); return; }
      if (!pill) { pill = h('button', { type: 'button', id: PILL_ID, class: 'sg', onclick: togglePanel }); document.body.appendChild(pill); }
      const s = state;
      const key = s.status + (s.data ? s.data.missingCount + '/' + s.data.unexpected.length : '');
      if (pill.dataset.key !== key) {
        pill.dataset.key = key;
        pill.replaceChildren(h('span', { html: AE.actionIcon('countCheck', 28) }), 'Missing serials',
          s.status === 'loading' ? h('span', { class: 'sg-spin' })
            : s.status === 'error' ? h('span', { class: 'n', title: s.error }, '!')
              : h('span', { class: 'n' + (s.data.missingCount ? '' : ' zero') }, s.data.missingCount ? s.data.missingCount.toLocaleString() : '✓'));
        pill.title = 'Lay of the Land: expected serials not scanned yet' + (s.status === 'ready' ? ' (' + s.data.missingCount + ' missing, ' + s.data.unexpected.length + ' unexpected)' : '');
      }
      const panel = document.getElementById(PANEL_ID);
      const dataKey = s.status + '|' + (s.at || '');
      if (panel && panel.dataset.dataKey !== dataKey) renderPanel(); // not every second: that reset the scroll
    }

    function togglePanel(e) {
      e && e.stopPropagation();
      const p = document.getElementById(PANEL_ID);
      if (p) { p.remove(); return; }
      AE.track('countCheck:open');
      renderPanel();
    }

    const copy = async (text, what) => {
      try { await navigator.clipboard.writeText(text); AE.toast('Copied', what, 'ok', 2500); }
      catch (_) { AE.toast("Couldn't copy", 'Your browser blocked the clipboard.', 'err'); }
    };
    function download(d, id) {
      const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
      const lines = [['Status', 'Serial', 'Item ID', 'Item', 'Group', 'Scanned by', 'Scanned at'].join(',')];
      for (const m of d.missing) for (const s of m.missing) lines.push(['Missing', s, m.itemId, m.name, m.group, '', ''].map(q).join(','));
      for (const u of d.unexpected) lines.push(['Unexpected: ' + BUCKETS[u.bucket], u.serial, '', '', '', u.by, u.at].map(q).join(','));
      const a = h('a', { href: URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })), download: id + '-variance.csv' });
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }

    const CHEV = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>';
    // A collapsible entry: click the header to show/hide its serials (toggled in place, no redraw).
    let flash = new Set(); // entries changed by the last scan
    function entry(key, title, meta, serials) {
      const el = h('div', { class: 'item' + (open.has(key) ? ' open' : '') + (flash.has(key) ? ' flash' : ''), 'data-key': key },
        h('div', { class: 't', role: 'button', tabindex: '0', 'aria-expanded': String(open.has(key)) }, h('span', { html: CHEV, style: 'line-height:0' }), ...title, meta),
        h('div', { class: 'serials' }, serials));
      const head = el.firstChild;
      const flip = () => { const on = el.classList.toggle('open'); head.setAttribute('aria-expanded', String(on)); on ? open.add(key) : open.delete(key); };
      head.onclick = flip;
      head.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } };
      return el;
    }

    function renderPanel() {
      const id = countId();
      let p = document.getElementById(PANEL_ID);
      if (!p) { p = h('div', { id: PANEL_ID, class: 'sg sg-card', role: 'dialog', 'aria-label': 'Missing serials' }); document.body.appendChild(p); }
      const s = state;
      p.dataset.dataKey = s.status + '|' + (s.at || '');
      // Keep your place: remember the entry at the top of the view (and the ones after it,
      // in case it just finished and drops out), then scroll back to it after redrawing.
      const oldList = p.querySelector('.list');
      let anchor = null;
      if (oldList) {
        const top = oldList.getBoundingClientRect().top;
        const entries = [...oldList.querySelectorAll('[data-key]')];
        const k = entries.findIndex((el) => el.getBoundingClientRect().bottom > top + 1);
        if (k >= 0) anchor = { keys: entries.slice(k).map((el) => el.dataset.key), offset: entries[k].getBoundingClientRect().top - top, scroll: oldList.scrollTop };
      }
      const focused = document.activeElement && p.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
      const head = h('div', { class: 'head' }, h('span', { html: AE.actionIcon('countCheck', 26) }),
        h('b', null, 'Lay of the Land ', h('span', { class: 'sub' }, id + (s.at ? ' · updated ' + new Date(s.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''))),
        h('button', { type: 'button', class: 'sg-btn', style: 'height:30px;font-size:13px', onclick: () => load(id, false, true) }, 'Refresh'),
        h('button', { type: 'button', class: 'sg-x', title: 'Close', onclick: () => { giveBackFocus(); p.remove(); } }, '✕'));
      if (s.status !== 'ready') {
        p.replaceChildren(head, h('div', { class: 'sg-soft', style: 'padding:10px 0' }, s.status === 'loading' ? 'Comparing expected and scanned serials…' : "Couldn't load this count: " + s.error));
        return;
      }
      const d = s.data;
      flash = new Set([...(d.changed || [])].map((k) => 'item:' + k)); d.changed = new Set(); // flash once
      const stat = (k, v, bad) => h('div', { class: 'stat' + (bad ? ' bad' : '') }, h('div', { class: 'v' }, v.toLocaleString()), h('div', { class: 'k' }, k));
      const q = query.trim().toLowerCase();
      const hit = (...xs) => !q || xs.some((x) => String(x || '').toLowerCase().includes(q));
      const search = h('input', { type: 'search', placeholder: 'Search serial or item', value: query,
        oninput: (e) => { query = e.target.value; renderPanel(); clearTimeout(searchIdle); searchIdle = setTimeout(giveBackFocus, 4000); },
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); giveBackFocus(); } } });
      const tabBtn = (t, label, n) => h('button', { type: 'button', class: 'tab' + (tab === t ? ' on' : ''), onclick: () => { tab = t; renderPanel(); p.querySelector('.list').scrollTop = 0; } }, label + ' (' + n.toLocaleString() + ')');
      const serialBtn = (x, title) => h('button', { type: 'button', title: title || 'Copy', onclick: () => copy(x, x) }, x);
      const setAll = (keys, on) => { keys.forEach((k) => (on ? open.add(k) : open.delete(k))); renderPanel(); };

      let controls = null, list, shownMissing = [];
      if (tab === 'missing') {
        // Categories (Portal's item groups), with how many serials each is missing.
        const byCat = new Map();
        for (const m of d.missing) byCat.set(m.group || 'Other', (byCat.get(m.group || 'Other') || 0) + m.missing.length);
        const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
        if (cat !== 'all' && !byCat.has(cat)) cat = 'all';
        const items = d.missing
          .filter((m) => cat === 'all' || (m.group || 'Other') === cat)
          .map((m) => ({ ...m, shown: hit(m.name, m.itemId, m.group) ? m.missing : m.missing.filter((x) => hit(x)) }))
          .filter((m) => m.shown.length)
          .sort(sortBy === 'name' ? (a, b) => a.name.localeCompare(b.name)
            : sortBy === 'category' ? (a, b) => (a.group || '').localeCompare(b.group || '') || b.missing.length - a.missing.length || a.name.localeCompare(b.name)
              : (a, b) => b.missing.length - a.missing.length || a.name.localeCompare(b.name));
        shownMissing = items.flatMap((m) => m.shown);
        const keys = items.map((m) => 'item:' + m.itemId);
        const anyClosed = keys.some((k) => !open.has(k));
        const sortSel = h('select', { 'aria-label': 'Sort', onchange: (e) => { sortBy = e.target.value; renderPanel(); giveBackFocus(); } },
          [['missing', 'Most missing first'], ['name', 'Item name A–Z'], ['category', 'By category']].map(([v, l]) => { const o = h('option', { value: v }, l); o.selected = v === sortBy; return o; }));
        controls = h('div', { class: 'cats' },
          h('button', { type: 'button', class: 'cat' + (cat === 'all' ? ' on' : ''), onclick: () => { cat = 'all'; renderPanel(); } }, 'All ' + d.missingCount.toLocaleString()),
          cats.map(([c, n]) => h('button', { type: 'button', class: 'cat' + (cat === c ? ' on' : ''), onclick: () => { cat = cat === c ? 'all' : c; renderPanel(); p.querySelector('.list').scrollTop = 0; } }, c + ' ' + n.toLocaleString())),
          sortSel,
          h('button', { type: 'button', class: 'sg-btn', onclick: () => setAll(keys, anyClosed) }, anyClosed ? 'Expand all' : 'Collapse all'));
        const rows = [];
        let lastGroup = null;
        for (const m of items) {
          if (sortBy === 'category' && m.group !== lastGroup) { lastGroup = m.group; rows.push(h('div', { class: 'section' }, (m.group || 'Other') + ' · ' + (byCat.get(m.group || 'Other') || 0) + ' missing')); }
          rows.push(entry('item:' + m.itemId, [h('b', null, m.name), h('span', { class: 'grp' }, m.group)],
            h('span', { class: 'q' }, (m.missing.length === m.expected ? 'all ' + m.expected : m.missing.length + ' of ' + m.expected) + ' missing'),
            m.shown.map((x) => serialBtn(x))));
        }
        list = rows.length ? rows : [h('div', { class: 'sg-soft', style: 'padding:10px 0' }, d.missing.length ? 'Nothing matches.' : 'Every expected serial has been scanned.')];
      } else {
        const rows = d.unexpected.filter((u) => hit(u.serial, BUCKETS[u.bucket], u.by));
        const groups = Object.keys(BUCKETS).map((b) => [b, rows.filter((u) => u.bucket === b)]).filter(([, r]) => r.length);
        const keys = groups.map(([b]) => 'bucket:' + b);
        const anyClosed = keys.some((k) => !open.has(k));
        controls = groups.length ? h('div', { class: 'cats' }, h('span', { class: 'sg-soft', style: 'flex:1' }, 'Scans Portal didn\'t match to an expected serial.'),
          h('button', { type: 'button', class: 'sg-btn', onclick: () => setAll(keys, anyClosed) }, anyClosed ? 'Expand all' : 'Collapse all')) : null;
        list = groups.length ? groups.map(([b, r]) => entry('bucket:' + b, [h('b', null, BUCKETS[b])], h('span', { class: 'q' }, r.length + ' scan' + (r.length === 1 ? '' : 's')),
          r.map((u) => serialBtn(u.serial, 'Scanned by ' + (u.by || '?') + (u.at ? ', ' + new Date(u.at).toLocaleString() : '') + ' — click to copy'))))
          : [h('div', { class: 'sg-soft', style: 'padding:10px 0' }, d.unexpected.length ? 'Nothing matches.' : 'No unexpected scans.')];
      }
      const listEl = h('div', { class: 'list' }, list);
      p.replaceChildren(head,
        h('div', { class: 'stats' }, stat('Expected', d.expected), stat('Scanned', d.scanned), stat('Missing', d.missingCount, d.missingCount > 0), stat('Unexpected', d.unexpected.length, d.unexpected.length > 0)),
        h('div', { class: 'tabs' }, tabBtn('missing', 'Missing', d.missingCount), tabBtn('unexpected', 'Unexpected', d.unexpected.length)),
        h('div', { class: 'tools' }, search,
          h('button', { type: 'button', class: 'sg-btn', onclick: () => copy(shownMissing.join('\n'), shownMissing.length + ' missing serials, one per line' + (cat !== 'all' || q ? ' (the ones shown)' : '')) }, 'Copy missing'),
          h('button', { type: 'button', class: 'sg-btn', onclick: () => download(d, id) }, 'Download CSV')),
        controls, listEl,
        h('div', { class: 'foot' }, 'Updates as items are scanned. Click an item to show its serials; click a serial to copy it.'));
      if (anchor) {
        const el = anchor.keys.map((k) => listEl.querySelector('[data-key="' + CSS.escape(k) + '"]')).find(Boolean);
        listEl.scrollTop = el ? el.getBoundingClientRect().top - listEl.getBoundingClientRect().top - anchor.offset : anchor.scroll;
      }
      if (focused) { const inp = p.querySelector('.tools input'); inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    }
    /*
      Scanners type into Portal's scan box (ending with Enter), so our UI must
      never keep keyboard focus: a scan would land in it — or its Enter would
      press one of our buttons. Buttons don't take focus when clicked; the sort
      menu and the search box hand it back to the page field used last.
    */
    const OURS = '#' + PANEL_ID + ', #' + PILL_ID;
    let lastPageField = null, searchIdle = null;
    document.addEventListener('focusin', (e) => {
      const t = e.target;
      if (t.closest && !t.closest(OURS) && t.matches('input, textarea, select, [contenteditable="true"]')) lastPageField = t;
    }, true);
    function giveBackFocus() {
      clearTimeout(searchIdle);
      const a = document.activeElement;
      // Leave it alone if it's already on something of the page's; otherwise (ours,
      // or dropped to <body> when a redraw removed the focused control) put it back.
      if (a && a !== document.body && a.closest && !a.closest(OURS)) return;
      if (lastPageField && lastPageField.isConnected && !lastPageField.disabled) lastPageField.focus({ preventScroll: true });
      else a.blur();
    }
    document.addEventListener('mousedown', (e) => {
      const t = e.target.closest && e.target.closest(OURS);
      if (t && !e.target.closest('input, select')) e.preventDefault(); // click without taking focus
    }, true);

    document.addEventListener('click', (e) => {
      const p = document.getElementById(PANEL_ID), path = e.composedPath();
      if (p && !path.includes(p) && !path.includes(document.getElementById(PILL_ID))) p.remove();
    });

    AE.every(1000, () => {
      const id = countId();
      if (!id) { if (state) { state = null; loadingFor = null; render(); } return; }
      if (!state || state.id !== id) { if (loadingFor !== id) load(id); }
      else if (state.status === 'ready' && Date.now() - (state.fullAt || state.at) > FULL_MS && !document.hidden) { state.fullAt = Date.now(); load(id, true, true); }
      render();
    });
  },
});

AE.start();
};
AE.gate();
})();
