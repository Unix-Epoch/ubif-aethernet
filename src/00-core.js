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
const AE_VERSION = '__VERSION__';            // filled in by build.py
const AE_DEV = __DEV__;                      // true only in the dev channel ("Aethernet (dev)")
// AE_DEMO (used bare, never declared): build.py swaps it for true in the demo
// channel's build (build.py --demo: only a few crystals, nothing else) and
// false everywhere else, so the other side's code is dropped by the minifier.
const AE_BUILD_TIME = '__BUILD_TIME__';       // ISO time of the build
const AE_BUILD_COMMIT = '__BUILD_COMMIT__';   // git commit it was built from ("-dirty" = uncommitted changes)
const AE_INSTALL_URL = '__INSTALL_URL__';
const AE_READABLE_URL = '__READABLE_URL__'; // same build, unminified     // where installs update from
const AE_ON_PORTAL = location.hostname === 'portal.ubreakifix.net';

const AE = (() => {
  const SETTINGS_KEY = 'sg_settings';
  const DEFAULTS = {
    crystals: AE_DEMO ? { cleaningRate: true, autoClose: true, glamour: true }
      : { cleaningRate: true, woCleanings: true, textNotes: true, autoClose: true, galaxy: true, printLabels: true, buybacks: true, glamour: true, waymark: true, countCheck: true, rowColors: true, fixes: true },
    cleaningRate: { target: 75 },
    glamour: { theme: 'portal', custom: [], // custom: [{ id, name, bg, fg, accent, custom: true }]
      login: { image: '', fill: false, mark: true } }, // login page (01b-login.js); image = data URL
    ...(AE_DEMO ? {} : {
      printLabels: { delayMs: 900 },
      fixes: { logoLink: true, scanNav: true, woSort: true, autoNotes: true, notContacted: true, notContactedStatus: 'all' }, // notContactedStatus: 'all' | 'notConfirmed' // Master's Mend: one switch per fix (src/58-fixes.js)
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
  const ACTION_ICONS = __ACTION_ICONS__;
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

  /*
    Usage counts ("who uses what"): AE.track('autoClose:run') adds 1 to today's
    count for this person. Counts are batched in Tampermonkey storage and sent
    by the feedback module (06-feedback.js) every few minutes. Only feature
    names and counts — never page contents or customer details.
  */
  const USAGE_KEY = AE_DEMO ? '' : 'ae_usage_pending';
  const localDay = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  function track(feature) {
    if (AE_DEMO) return; // the demo build sends nothing anywhere
    try {
      const pend = GM_getValue(USAGE_KEY, {});
      const day = (pend[localDay()] = pend[localDay()] || {});
      day[feature] = (day[feature] || 0) + 1;
      GM_setValue(USAGE_KEY, pend);
    } catch (_) { /* never let tracking break a crystal */ }
  }
  // Once a day per person (e.g. "used Aethernet today", "has a Glamour theme on").
  function trackDaily(feature) {
    if (AE_DEMO) return;
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
      if (t.sites && !t.sites.includes(location.hostname)) continue;
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
    api, unwrap, Stopped, portal, refreshView, profile, sleep, esc, h, icon, actionIcon, asset: (name) => ACTION_ICONS[name] || '', wordmark, ensureCss, progressPanel,
    hooks, now, nowDate,
    confirm: confirmDialog, toast, emit, on, data, track, trackDaily, noteError, recentErrors, USAGE_KEY, localDay,
    PARENT_PROGRAM_ID, CLEANING_PROGRAMS,
    autoClose: null, // set by the auto-close crystal when it's enabled
  };
})();
