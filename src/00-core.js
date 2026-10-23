/*
  Aethernet core — shared by every shard (tool) in this bundle.

  - AE.settings: persisted in Tampermonkey storage (GM_*), so Portal and
    the Sprinklr form (a different site) see the same values.
  - AE.profile(): the logged-in user + current store, from /api/auth/user.
    Anything personal (name, email, store) comes from here, never hardcoded.
  - Styling uses Portal's own design tokens (--aui-*), which switch with
    its light/dark theme; the fallbacks are the light-theme values, used on
    pages without the tokens (the Sprinklr form).
  - AE.shard(): each shard (our name for a tool) registers here and runs
    in its own try/catch, only if enabled in settings — one shard breaking
    can't take down the others. Adding a new one = "attuning" it.
*/

const AE_NAME = 'Aethernet';
const AE_VERSION = '__VERSION__';            // filled in by build.py
const AE_DEV = __DEV__;                      // true only in the dev channel ("Aethernet (dev)")
// AE_DEMO (used bare, never declared): build.py swaps it for true in the demo
// channel's build (build.py --demo: only a few shards, nothing else) and
// false everywhere else, so the other side's code is dropped by the minifier.
const AE_BUILD_TIME = '__BUILD_TIME__';       // ISO time of the build
const AE_BUILD_COMMIT = '__BUILD_COMMIT__';   // git commit it was built from ("-dirty" = uncommitted changes)
const AE_INSTALL_URL = '__INSTALL_URL__';     // where installs update from
// The Portal sandbox (sandbox/server.py: Portal's real app on fake data) — dev builds only.
const AE_SANDBOX = AE_DEV && location.host === 'localhost:8790';
const AE_ON_PORTAL = location.hostname === 'portal.ubreakifix.net' || AE_SANDBOX;
// Swiftcast's Verizon screen protector (SKU 101516; setting key refreshLabor): on by default since 2.22.0
// (verified on live VZ Refreshes, Oct 3, 2026). Everyone who never chose follows this. Anyone who switched it
// off while it was Experimental is switched back on once (ae_refresh_labor_on); after that, their choice sticks.
const AE_REFRESH_LABOR_DEFAULT = true;

const AE = (() => {
  const SETTINGS_KEY = 'sg_settings';
  const DEFAULTS = {
    // Stored key stays `crystals` (the old name for shards): renaming it would drop saved on/off switches.
    crystals: AE_DEMO ? { cleaningRate: true, autoClose: true, glamour: true }
      : { cleaningRate: true, woCleanings: true, textNotes: true, autoClose: true, checkinDrafts: true, leadReplies: true, galaxy: true, printLabels: true, buybacks: true, glamour: true, waymark: true, countCheck: true, rowColors: true, timeSheet: true, reassemble: true, decipher: true, assize: true, fixes: true },
    // Swiftcast: offer Dualcast (all of a device's cleanings at once); refreshLabor: null = follow
    // AE.REFRESH_LABOR_DEFAULT (only a user's own choice is stored, so the default can change in a release).
    autoClose: { dualcast: true, refreshLabor: null },
    glamour: { theme: 'portal', custom: [], // custom: [{ id, name, bg, fg, accent, custom: true }]
      login: { image: '', blank: false, fill: false, mark: true } }, // login page (01b-login.js); image = data URL; blank = no picture
    ...(AE_DEMO ? {} : {
      printLabels: { delayMs: 900 },
      // Waymark on Portal's Work orders list: one chip + N per order, clickable, optional tag filter (src/55-waymark.js)
      waymarkList: { chips: true, edit: true, filter: false },
      fixes: { logoLink: true, appcuesButtons: true, appcuesBoxes: true, scanNav: true, scanDebug: false, woSort: true, autoNotes: true, notContacted: true, notContactedStatus: 'all', reportsRetry: true, rfpTotal: true }, // notContactedStatus: 'all' | 'notConfirmed' // Master's Mend: one switch per fix (src/58-fixes.js)
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
  // (`tools` -> `crystals` is the stored key, kept as-is after the shard rename.)
  if (stored.tools && !stored.crystals) { stored.crystals = stored.tools; delete stored.tools; }
  // 2.22.0: the screen protector is on for everyone, once, including anyone who switched it off while it was Experimental.
  if (!GM_getValue('ae_refresh_labor_on', false)) {
    if (stored.autoClose && stored.autoClose.refreshLabor === false) { stored.autoClose.refreshLabor = null; GM_setValue(SETTINGS_KEY, stored); }
    GM_setValue('ae_refresh_labor_on', true);
  }
  const settings = merge(DEFAULTS, stored);
  // Aethernet-wide settings from the admin panel (Settings tab), sent with the store access check
  // (01-access.js) and kept here, so they apply right away on the next load.
  const CONFIG_KEY = 'ae_config', CONFIG_DEFAULTS = { cleaningTarget: 75 };
  const config = () => Object.assign({}, CONFIG_DEFAULTS, GM_getValue(CONFIG_KEY, {}));
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
    if (res.status === 401 || res.status === 403) throw new Error('Your Portal session expired. Log in again.');
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
      '      var v = st ? (a.key == null ? st[a.slice] : st[a.slice][a.key]) : null;', // no key: the whole slice
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
      // fresh: look the stores up again now (a page that just opened has a new one; the list is otherwise kept 5 s)
      '    try { var req = JSON.parse(e.detail); if (req.args && req.args.fresh) cache = null; out = ops[req.op](req.args || {}); }',
      '    catch (err) { out = { error: String(err && err.message || err) }; }',
      '    document.dispatchEvent(new CustomEvent(evt + ":done", { detail: JSON.stringify(out) }));',
      '  });',
      '})(' + JSON.stringify(BRIDGE_EVENT) + ');',
    ].join('\n');
    const s = document.createElement('script');
    s.id = 'ae-portal-hook';
    s.textContent = code;
    addEarly(s);
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

  // Refresh what's on screen without reloading, after a shard changes
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

  // --------------------------------------------------------- store check
  /*
    Portal answers list calls (work orders, arrivals) for the session's *current* store, and any tab
    can switch that, while profile() is this page's store from when it loaded. Oct 16, 2026: tabs still
    on Newport News and Erie read Glen Allen's list after a switch in another tab, and Auto-Waymarked
    (and renamed) Glen Allen's work orders under their own stores. So lists, and writes to our own
    servers, are only used while the session's store is still this page's store. Once it isn't,
    Aethernet's background work stops in this tab until it's reloaded.
  */
  let storeChanged = null, storeCheck = null, storeCheckAt = 0;
  function sessionStore(fresh) {
    if (fresh || !storeCheck || Date.now() - storeCheckAt > 5000) {
      storeCheckAt = Date.now();
      storeCheck = api('GET', '/api/auth/user').then((a) => (a && a.currentStore) || {}).catch((e) => { storeCheck = null; throw e; });
    }
    return storeCheck;
  }
  async function sameStore(fresh) {
    if (storeChanged) return false;
    if (!AE_ON_PORTAL) return true;
    const [p, cur] = await Promise.all([profile(), sessionStore(fresh)]);
    if (!p || p.storeId == null || cur.storeId == null || Number(cur.storeId) === Number(p.storeId)) return true;
    storeChanged = { from: p.storeName || String(p.storeId), to: cur.storeName || String(cur.storeId) };
    toast('Aethernet paused on this page', 'Portal switched to ' + storeChanged.to + ', in this tab or another one. Reload this page to keep using Aethernet.', 'err', 60000);
    emit('store-changed', storeChanged);
    return false;
  }
  class StoreChanged extends Error {
    constructor() { super("Portal's store changed in another tab: reload this page"); this.storeChanged = true; }
  }
  async function assertSameStore(fresh) { if (!(await sameStore(fresh))) throw new StoreChanged(); }

  // ------------------------------------------------------------- styles
  const CSS = `
  .sg, .sg * { box-sizing: border-box; }
  .sg { font-family: Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; color: var(--aui-on-surface, #1a1c1e); }
  /*
    Chips next to the customer name (WO heading) and in Work orders rows: one size, one font, one icon size, one gap.
    #ae-wo-chips is the single flex row every shard drops its chip into (AE.woChip); each chip carries its own
    order (CSS), so they line up the same whichever shard draws first: 10 Esuna, 20 Assize, 30 Waymark tags,
    40 + Tag, 50 Auto-Waymark. Variants: .ae-chip (status pill: shard icon + text, colors set by the shard),
    .sg-tag.ae-chip / .sg-auto.ae-chip (Waymark's own colors), .ghost (+ Tag), .round (icon only), .mini (list rows).
  */
  :root { --ae-chip-h:26px; --ae-chip-fs:13px; --ae-chip-icon:18px; --ae-chip-gap:8px; }
  #ae-wo-chips { display:flex; flex-wrap:nowrap; align-items:center; gap:var(--ae-chip-gap); flex:0 1000 auto; min-width:0; align-self:center; }
  /* Fit levels (AE.fitChips sets data-fit on the row from measurements; the name always gets room first, no animated widths):
     0 full; 1 tag chips capped at 90px; 2 every chip icon-only (labels hidden, counts/dates kept, full text in title + aria-label);
     3 row on its own line under the heading (full labels, wraps if it must). */
  #ae-wo-chips[data-fit="1"] .ae-tl, #ae-wo-chips[data-fit="2"] .ae-tl { max-width:90px; }
  #ae-wo-chips[data-fit="3"] { flex:1 1 100%; flex-wrap:wrap; row-gap:6px; margin:2px 0 6px; }
  #ae-wo-chips[data-fit="2"] { --ae-chip-h:22px; --ae-chip-icon:16px; --ae-chip-gap:6px; }
  #ae-wo-chips[data-fit="2"] .ae-lbl, #ae-wo-chips[data-fit="2"] .ae-tl { display:none; }
  #ae-wo-chips[data-fit="2"] .ae-dot { display:inline-block; }
  #ae-wo-chips[data-fit="2"] .ae-chip { padding:0 7px; gap:4px; }
  #ae-wo-chips[data-fit="2"] .ae-chip.has-icon { padding-left:3px; }
  #ae-wo-chips[data-fit="2"] .ae-chip.round { width:var(--ae-chip-h); padding:0; }
  .ae-dot { display:none; width:8px; height:8px; border-radius:50%; background:currentColor; flex:none; }
  .ae-tl { min-width:0; max-width:190px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #ae-wo-chips:empty { display:none; }
  #sg-wm-row { display:contents; }
  .ae-chip { display:inline-flex; align-items:center; justify-content:center; gap:6px; box-sizing:border-box; height:var(--ae-chip-h); margin:0; padding:0 10px; border-radius:10000rem;
    border:1px solid transparent; font:600 var(--ae-chip-fs)/1 Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; white-space:nowrap; flex:none; align-self:center; cursor:pointer; }
  .ae-chip.has-icon { padding-left:4px; }
  .ae-chip .sg-aicon { width:var(--ae-chip-icon); height:var(--ae-chip-icon); border-radius:50%; box-shadow:0 0 0 1px rgba(0,0,0,.3); }
  .ae-chip .sg-spin { width:12px; height:12px; }
  .ae-chip.round { width:var(--ae-chip-h); padding:0; }
  .ae-chip.ghost { background:transparent; border:1px dashed var(--aui-primary, #8223d2); color:var(--aui-primary, #8223d2); }
  .ae-chip.ghost:hover { background:var(--aui-primary-soft, #faecff); }
  .ae-chip:focus-visible { outline:2px solid var(--aui-primary, #8223d2); outline-offset:1px; }
  .ae-chip.mini { --ae-chip-h:18px; --ae-chip-fs:11px; --ae-chip-icon:14px; gap:3px; padding:0 7px; font-weight:700; }
  .ae-chip.mini.has-icon { padding-left:2px; }
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
  // Put a <style>/<script> in the page, even at page start, when <html> may not exist yet.
  function addEarly(node) {
    const at = document.head || document.documentElement;
    if (at) return at.appendChild(node);
    new MutationObserver((_, o) => { if (document.documentElement) { o.disconnect(); (document.head || document.documentElement).appendChild(node); } })
      .observe(document, { childList: true });
  }

  function ensureCss() {
    if (document.getElementById('sg-core-css')) return;
    const s = document.createElement('style');
    s.id = 'sg-core-css';
    s.textContent = CSS;
    addEarly(s);
  }

  // Minimal element builder: h('div', {class:'x', onclick}, child, 'text')
  // Each shard's FFXIV action icon, plus a few FFXIV UI pieces under "ui/<name>"
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
    ticked step list, a result message, and whatever action buttons the shard
    sets. Used by auto-close and print-all-labels.
  */
  /*
    Progress box for a shard's run (Swiftcast, Dualcast, Quick Synthesis…),
    styled after FFXIV casting:
      - the shard's action icon in the header, with a cooldown sweep: a grey
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
  // icon: a shard/spell id shown left of the title. cancelLabel: null = no Cancel button (a notice with just OK).
  function confirmDialog({ title, message, warning, icon: iconId, confirmLabel = 'Confirm', cancelLabel = 'Cancel' }) {
    ensureCss();
    if (!document.getElementById('sg-confirm-css')) document.head.append(h('style', { id: 'sg-confirm-css' }, CONFIRM_CSS));
    return new Promise((resolve) => {
      const done = (v) => { scrim.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
      const ok = h('button', { type: 'button', class: 'sg-btn sg-lg sg-primary', onclick: () => done(true) }, confirmLabel);
      const card = h('div', { class: 'sg sg-card sg-confirm', role: 'alertdialog', 'aria-modal': 'true' },
        iconId ? h('h2', { style: 'display:flex;align-items:center;gap:10px' }, h('span', { html: actionIcon(iconId, 28), style: 'line-height:0;flex:none' }), title) : h('h2', null, title),
        message ? h('div', { html: message }) : null,
        warning ? h('div', { class: 'sg-warn' }, warning) : null,
        h('div', { class: 'sg-actions' }, cancelLabel === null ? null : h('button', { type: 'button', class: 'sg-btn sg-lg', onclick: () => done(false) }, cancelLabel), ok));
      const scrim = h('div', { class: 'sg sg-confirm-scrim', onclick: (e) => { if (e.target === scrim) done(false); } }, card);
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(scrim);
      ok.focus();
    });
  }

  // Small status card, bottom-left, auto-dismissing. kind: 'ok' | 'err' | 'busy'
  // text: plain text, or { html } for markup Aethernet built itself (e.g. an AE.bugLink).
  function toast(title, text, kind = 'ok', ms = 6000) {
    ensureCss();
    const mark = kind === 'busy' ? '<span class="sg-spin" style="margin-top:2px"></span>'
      : '<span class="sg-icon-state" style="color:' + (kind === 'ok' ? 'var(--aui-status-success,#136d31)' : 'var(--aui-status-error,#b91a24)') + '">' + (kind === 'ok' ? '✓' : '!') + '</span>';
    const el = h('div', { class: 'sg sg-card sg-toast', role: 'status', style:
      'position:fixed;z-index:2147483647;left:16px;bottom:16px;max-width:420px;padding:12px 16px;display:flex;gap:10px;align-items:flex-start;font-size:14px;line-height:1.4;animation:sg-in .2s ease-out' +
      (kind === 'err' ? ';border-color:var(--aui-status-error,#b91a24)' : ''),
      html: mark + '<div style="flex:1"><b style="display:block;margin-bottom:2px">' + esc(title) + '</b>' + (text && typeof text === 'object' ? text.html : esc(text)) + '</div>' });
    document.querySelectorAll('.sg-toast').forEach((t) => t.remove());
    document.body.appendChild(el);
    if (kind !== 'busy') setTimeout(() => el.remove(), ms);
    return el;
  }

  // Shards tell each other when a cleaning changes (e.g. auto-close finished)
  // so the badge and WO pill refresh without waiting for their timers.
  // Events: cleaning-changed, text-sent { woId }, waymark-changed, wo-changed { woId, why } (Aethernet itself changed a work order's notes
  // or nickname: Assize re-reads it now, since Portal's updatedAt doesn't move for either).
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
      const rows = (j && j.workOrders) || [];
      rows.count = j && Number.isInteger(j.rowCount) ? j.rowCount : null; // Portal's total for this filter
      return rows;
    }
    // All open WOs, plus closed WOs created since `sinceMs` (newest first,
    // so paging stops once past it). maxClosedPages bounds old lookbacks.
    async function workorders(sinceMs, maxClosedPages = PAGE_CAP) {
      await afterLoad(); // never during Portal's own first load
      await assertSameStore();
      const byId = new Map();
      // Page by Portal's own total (rowCount), not by a short page: a server that sends fewer rows
      // per page than asked would otherwise end the list early (and open WOs would look closed).
      for (let p = 1; p <= PAGE_CAP; p++) {
        const rows = await listPage('Active', p);
        rows.forEach((r) => byId.set(r.workorderId, r));
        if (!rows.length || (rows.count != null ? byId.size >= rows.count : rows.length < PAGE_SIZE)) break;
      }
      for (let p = 1; p <= maxClosedPages; p++) {
        const rows = await listPage('Closed', p);
        rows.forEach((r) => byId.set(r.workorderId, r));
        const lastRow = rows[rows.length - 1];
        if (rows.length < PAGE_SIZE || !lastRow || Date.parse(lastRow.createdAt) < sinceMs) break;
      }
      await assertSameStore(true); // still this page's store after loading: the list is ours
      return [...byId.values()];
    }
    // Arrivals not yet checked in. pageSize=100 is honored (the UI uses 10).
    async function arrivals() {
      await afterLoad();
      await assertSameStore();
      const out = [];
      for (let p = 1; p <= PAGE_CAP; p++) {
        const j = await api('GET', '/api/arrivals/upcoming-arrivals?page=' + p + '&pageSize=' + PAGE_SIZE);
        const rows = (j && j.data) || [];
        out.push(...rows);
        if (rows.length < PAGE_SIZE || out.length >= ((j && j.rowCount) || 0)) break;
      }
      await assertSameStore(true);
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
    /*
      Same phone? Same IMEI, or, since dual-SIM phones (recent iPhones,
      Samsungs) have two IMEIs and a carrier may send the other one, the same
      model (TAC: an IMEI's first 8 digits) for a customer of the same name
      (first + last). Seen Oct 2, 2026: an iPhone 15 Pro Max on a WO with one
      IMEI, its AT&T cleanings with the other, under AT&T's own customer record.
    */
    const nameKey = (r) => { const w = nameOf(r).toLowerCase().replace(/[^a-z'\s-]/g, ' ').split(/\s+/).filter(Boolean); return w.length >= 2 ? w[0] + ' ' + w[w.length - 1] : null; };
    function sameDevice(a, b) {
      const ai = imeiOf(a), bi = imeiOf(b);
      if (!ai || !bi) return false;
      if (ai === bi) return true;
      const an = nameKey(a);
      return ai.slice(0, 8) === bi.slice(0, 8) && !!an && an === nameKey(b);
    }
    // Does cleaning `c` belong to parent WO `p`? The same phone (AT&T cleanings
    // are often under a different customer record); customer ID only without an IMEI.
    function belongs(c, p) {
      const pi = imeiOf(p), ci = imeiOf(c);
      if (pi && ci) return sameDevice(c, p);
      const pc = custOf(p);
      return !!pc && custOf(c) === pc;
    }

    return { workorders, arrivals, cleanings, belongs, sameDevice, imeiOf, custOf, nameOf };
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
  const USAGE_KEY = AE_DEMO ? '' : 'ae_usage_pending';
  const localDay = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  function track(feature) {
    if (AE_DEMO) return; // the demo build sends nothing anywhere
    try {
      const pend = GM_getValue(USAGE_KEY, {});
      const day = (pend[localDay()] = pend[localDay()] || {});
      day[feature] = (day[feature] || 0) + 1;
      GM_setValue(USAGE_KEY, pend);
    } catch (_) { /* never let tracking break a shard */ }
  }
  // Once a day per person (e.g. "used Aethernet today", "has a Glamour theme on").
  function trackDaily(feature) {
    if (AE_DEMO) return;
    const k = 'ae_usage_daily', seen = GM_getValue(k, {});
    if (seen[feature] === localDay()) return;
    seen[feature] = localDay(); GM_setValue(k, seen);
    track(feature);
  }

  // --------------------------------------------------- shard registry
  const shards = [];
  function shard(def) { shards.push(def); }
  /*
    "A text went to a customer from this WO": event text-sent { woId } for
    any shard (Recitation logs it, Auto-Waymark follows up), so each works
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
    for (const t of shards) {
      if (!settings.crystals[t.id]) continue;
      if (t.sites && !t.sites.includes(AE_SANDBOX ? 'portal.ubreakifix.net' : location.hostname)) continue;
      // Paused remotely by an Aethernet notice (status.json); last-known copy.
      if (AE.status && AE.status.paused(t.id)) { console.info('[' + AE_NAME + '] ' + t.name + ' is paused by an Aethernet notice'); continue; }
      try { t.run(); } catch (e) { noteError(t.name + ' start', e); console.error('[' + AE_NAME + '] ' + t.name + ' failed to start', e); }
    }
  }

  /*
    Run fn whenever Portal adds or removes elements, in the same frame,
    before the browser draws it (MutationObserver callbacks run before
    paint), so a change can land before anything is seen: a box collapsed as
    it's inserted, Portal's login photo swapped before it shows. Since 2.23.
    One observer for every caller; fns must be idempotent (our own changes
    come back as another batch). At most 8 runs a frame: a page that never
    settles falls back to once a frame. Shadow roots and frame documents
    aren't seen from the page: watchDom(root) adds one (Appcues draws in both).
    AE.every stays alongside as the safety net.
  */
  const domFns = [];
  let domObs = null, domRuns = 0, domFrame = 0, domBusy = false;
  // How much the watcher costs (dev tools → Performance): runs, total ms, and the worst single frame.
  const domStats = { runs: 0, ms: 0, worstFrame: 0, frame: 0, byFn: {}, since: performance.now(), reset() { Object.assign(this, { runs: 0, ms: 0, worstFrame: 0, frame: 0, byFn: {}, since: performance.now() }); } };
  if (AE_DEV) try { window.__aeDomStats = domStats; } catch (_) {} // dev builds: readable by the sandbox tests
  function runDom() {
    if (domBusy) return;
    if (++domRuns > 8) { if (!domFrame) domFrame = requestAnimationFrame(() => { domFrame = 0; domRuns = 0; runDom(); }); return; }
    if (!domFrame) domFrame = requestAnimationFrame(() => { domFrame = 0; domRuns = 0; domStats.frame = 0; });
    domBusy = true;
    const t0 = performance.now();
    for (const fn of domFns) {
      const f0 = AE_DEV ? performance.now() : 0;
      try { const r = fn(); if (r && r.catch) r.catch((e) => noteError('dom', e)); } catch (e) { noteError('dom', e); }
      if (AE_DEV) { const k = fn.__aeWho || (fn.__aeWho = String(fn).replace(/\s+/g, ' ').slice(0, 70)), d = performance.now() - f0; const b = domStats.byFn[k] || (domStats.byFn[k] = { ms: 0, max: 0 }); b.ms += d; if (d > b.max) b.max = d; }
    }
    const dt = performance.now() - t0;
    domStats.runs++; domStats.ms += dt; domStats.frame += dt; if (domStats.frame > domStats.worstFrame) domStats.worstFrame = domStats.frame;
    domBusy = false;
  }
  function watchDom(root) {
    if (!domObs) domObs = new MutationObserver(runDom);
    if (root && !(root.__aeWatched)) { root.__aeWatched = true; domObs.observe(root, { childList: true, subtree: true }); }
  }
  function onDom(fn) { domFns.push(fn); watchDom(document); try { fn(); } catch (e) { noteError('dom', e); } }

  /*
    Resolves once Portal's first load has settled: the page's load event, then
    no new Portal API request for 600 ms (at most 8 s after load). Background
    fetches (Divination's count, Esuna, Waymark's scan) wait on it so they never
    compete with Portal's own first requests (Garrett, Oct 6, 2026). Later
    calls resolve at once.
  */
  let settledP = null;
  function afterLoad() {
    if (settledP) return settledP;
    settledP = new Promise((resolve) => {
      const quiet = () => {
        let last = performance.now(), obs = null;
        try {
          obs = new PerformanceObserver((list) => { if (list.getEntries().some((e) => /\/api\//.test(e.name))) last = performance.now(); });
          obs.observe({ type: 'resource', buffered: false });
        } catch (_) { /* no observer: the time limits below still apply */ }
        const t0 = performance.now();
        const check = () => {
          const now = performance.now();
          if (now - last >= 600 || now - t0 >= 8000) { obs?.disconnect(); resolve(); } else setTimeout(check, 150);
        };
        setTimeout(check, 150);
      };
      if (document.readyState === 'complete') quiet(); else addEventListener('load', quiet, { once: true });
    });
    return settledP;
  }

  // Portal's "UBIF support" header button: Divination's badge and Waymark's button sit left of it.
  // Kept while it's in the page, so the page watcher doesn't scan every button on each change.
  let supportBtn = null;
  function headerAnchor() {
    if (supportBtn && supportBtn.isConnected) return supportBtn;
    // Inside Portal's header only, by text: no layout check (offsetParent forced a layout on every page change).
    const hdr = document.querySelector('.components-header');
    supportBtn = hdr ? [...hdr.querySelectorAll('button')].find((x) => x.textContent.trim() === 'UBIF support') || null : null;
    return supportBtn;
  }

  /*
    Header icons. Every Aethernet item in Portal's top bar is one 34 px shard icon with a small
    count badge, registered here so the bar stays tidy as shards are added:

      const wm = AE.headerIcon({ id: 'waymark', icon: 'waymark', label: '3 Auto-Waymarks due',
                                 badge: 3, count: 3, severity: 'amber', onClick: (e) => openBoard() });
      wm.update({ badge: 0, count: 0, severity: 'grey' });   // later; a no-op when nothing changed

      id        unique name; elId (optional) = the button's DOM id.
      icon      a shard's action icon id (AE.actionIcon); falls back to the Aethernet mark.
      label     full text: the hover/focus pill, aria-label and the AeN menu row.
      detail    optional second line in the hover pill.
      badge     text on the corner badge ('' = none, e.g. 3 or '62%'); count = the actionable number
                that adds up in the combined AeN badge (default 0: a color only).
      severity  'red' (needs action) | 'amber' (due / below target) | 'green' | 'grey' | 'purple' (update).
      busy      true while loading (the icon pulses).  headerOnly: not shown when Portal's header is missing.
      order     left-to-right position (default 100).
    Hover or keyboard focus shows the label as a floating pill (it never changes the bar's width). When the
    bar has no room, measured rather than by breakpoint, the icons fold into one AeN icon with a menu:
    always if the header overflows, and while Portal's Search is focused if the Search field would crowd them.
    Returns { update(patch), remove(), el }.
  */
  const HDR_RANK = { red: 4, amber: 3, purple: 2, green: 1, grey: 0 };
  const headerIcons = new Map();
  let hdrBox = null, hdrAen = null, hdrMenu = null, hdrTip = null, hdrTipFor = null;
  let hdrHold = false, hdrCollapsed = false, hdrSearchOn = false, hdrQueued = false, hdrInit = false, hdrRO = null, hdrROEl = null;
  const HDR_CSS = `
  #ae-hdr-icons { display:inline-flex; align-items:center; gap:4px; margin:0 8px 0 12px; flex:none; }
  #ae-hdr-icons.floating { position:fixed; left:16px; bottom:16px; z-index:2147483645; margin:0; padding:4px; border-radius:10000rem;
    background:var(--aui-surface, #fff); border:1px solid var(--aui-outline, #c6c6ca); box-shadow:0 4px 14px rgba(12,14,17,.2); }
  .ae-hi { position:relative; display:inline-flex; align-items:center; justify-content:center; width:34px; height:34px; padding:0; border:0; border-radius:10000rem;
    background:none; cursor:pointer; flex:none; color:var(--aui-on-surface, #1a1c1e); }
  .ae-hi:hover, .ae-hi.open { background:var(--aui-neutral-soft, #f1f0f4); }
  .ae-hi:focus-visible { outline:2px solid var(--aui-primary, #8223d2); outline-offset:1px; }
  .ae-hi .sg-aicon { width:26px; height:26px; border-radius:6px; }
  .ae-hi.busy .sg-aicon { animation:ae-hi-pulse 1.1s ease-in-out infinite; }
  @keyframes ae-hi-pulse { 50% { opacity:.45; } }
  .ae-hi .n { position:absolute; top:-3px; right:-6px; min-width:18px; height:18px; padding:0 5px; border-radius:10000rem; box-sizing:border-box;
    border:2px solid var(--aui-elevated-level-01, var(--aui-surface, #fff)); font:700 11px/14px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif;
    text-align:center; white-space:nowrap; font-variant-numeric:tabular-nums; pointer-events:none; background:#6b6c70; color:#fff; }
  .ae-hi .n:empty { display:none; }
  .ae-hi .n.dot { min-width:0; width:12px; height:12px; padding:0; top:-1px; right:-2px; display:block; }
  .ae-hi.sev-red .n { background:var(--aui-status-error, #d1344b); color:#fff; }
  .ae-hi.sev-amber .n { background:var(--aui-status-warning, #e0a23a); color:#2a2000; }
  .ae-hi.sev-green .n { background:var(--aui-status-success, #136d31); color:#fff; }
  .ae-hi.sev-purple .n { background:var(--aui-primary, #8223d2); color:var(--aui-on-primary, #fff); }
  .ae-hi.sev-grey .n { background:var(--aui-on-surface-soft, #6b6c70); color:var(--aui-surface, #fff); }
  .ae-aen { color:var(--aui-primary, #8223d2); }
  #ae-hdr-icons.collapsed > .ae-hi:not(.ae-aen) { display:none; }
  #ae-hdr-icons:not(.collapsed) > .ae-aen { display:none; }
  #ae-hdr-tip { position:fixed; z-index:2147483647; display:none; max-width:min(320px, calc(100vw - 16px)); padding:7px 14px; border-radius:10000rem; pointer-events:none;
    font:400 14px/1.25 Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; white-space:nowrap; box-shadow:0 4px 14px rgba(12,14,17,.22);
    background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e); border:1px solid var(--aui-outline, #c6c6ca); }
  #ae-hdr-tip.sev-red { background:var(--aui-status-error-soft, #ffdad7); color:var(--aui-status-on-error-soft, #410004); border-color:transparent; }
  #ae-hdr-tip.sev-amber { background:var(--aui-status-warning-soft, #fff0c0); color:var(--aui-status-on-warning-soft, #3a3000); border-color:transparent; }
  #ae-hdr-tip.sev-green { background:var(--aui-status-success-soft, #c5ffc8); color:var(--aui-status-on-success-soft, #062011); border-color:transparent; }
  #ae-hdr-tip.sev-purple { background:var(--aui-primary-soft, #faecff); color:var(--aui-on-surface, #1a1c1e); border-color:var(--aui-primary, #8223d2); }
  #ae-hdr-tip small { display:block; font-size:12px; opacity:.8; margin-top:1px; }
  @media (prefers-reduced-motion: no-preference) { #ae-hdr-tip.on { animation:sg-in .12s ease-out; } }
  #ae-hdr-menu { position:fixed; z-index:2147483646; display:none; min-width:240px; max-width:calc(100vw - 16px); padding:6px; }
  #ae-hdr-menu.on { display:block; }
  #ae-hdr-menu button { display:flex; align-items:center; gap:10px; width:100%; min-height:44px; padding:5px 8px; border:0; border-radius:10px; background:none;
    color:inherit; font:400 14px/1.25 Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; text-align:left; cursor:pointer; }
  #ae-hdr-menu button:hover, #ae-hdr-menu button:focus-visible { background:var(--aui-neutral-soft, #f1f0f4); outline:none; }
  #ae-hdr-menu .sg-aicon { width:26px; height:26px; border-radius:6px; flex:none; }
  #ae-hdr-menu .t { flex:1; }
  #ae-hdr-menu .b { flex:none; min-width:22px; padding:2px 8px; border-radius:10000rem; font:700 12px/16px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; text-align:center; }
  #ae-hdr-menu .b.sev-red { background:var(--aui-status-error-soft, #ffdad7); color:var(--aui-status-on-error-soft, #410004); }
  #ae-hdr-menu .b.sev-amber { background:var(--aui-status-warning-soft, #fff0c0); color:var(--aui-status-on-warning-soft, #3a3000); }
  #ae-hdr-menu .b.sev-green { background:var(--aui-status-success-soft, #c5ffc8); color:var(--aui-status-on-success-soft, #062011); }
  #ae-hdr-menu .b.sev-purple { background:var(--aui-primary-soft, #faecff); color:var(--aui-primary, #8223d2); }
  #ae-hdr-menu .b.sev-grey { background:var(--aui-neutral-soft, #f1f0f4); color:var(--aui-on-surface-soft, #5d5e61); }
  `;
  const HDR_SEARCH_OPEN = 320; // px Search is given to open up in when measuring whether the icons fit
  const hdrSearchBox = () => document.querySelector('.components-header-searchbox');
  const hdrVisible = () => [...headerIcons.values()].filter((d) => headerAnchor() || !d.headerOnly).sort((a, b) => a.order - b.order);

  function hdrPaintIcon(d) {
    const sev = HDR_RANK[d.severity] != null ? d.severity : 'grey';
    const sig = [sev, d.badge, d.label, d.busy ? 1 : 0].join('\u0001');
    if (d.sig === sig) return;
    d.sig = sig;
    d.el.className = 'sg ae-hi sev-' + sev + (d.busy ? ' busy' : '') + (d.el.classList.contains('open') ? ' open' : '');
    d.el.setAttribute('aria-label', d.label);
    d.el.querySelector('.n').textContent = d.badge == null ? '' : String(d.badge);
    if (hdrTipFor === d && hdrTip && hdrTip.style.display === 'block') hdrShowTip(d, d.el);
  }
  function hdrSummary(list) {
    let worst = 'grey', sum = 0;
    for (const d of list) { if ((HDR_RANK[d.severity] || 0) > HDR_RANK[worst]) worst = d.severity; sum += Number(d.count) || 0; }
    return { worst, sum };
  }
  function hdrPaintAen(list) {
    const { worst, sum } = hdrSummary(list);
    const dot = !sum && HDR_RANK[worst] >= 2; // amber/red/purple with no number: just a colored dot
    const label = 'Aethernet' + (sum ? ': ' + sum + ' to look at' : worst === 'amber' || worst === 'red' ? ': needs a look' : '');
    const n = hdrAen.querySelector('.n');
    hdrAen.className = 'sg ae-hi ae-aen sev-' + worst + (hdrAen.classList.contains('open') ? ' open' : '');
    n.className = 'n' + (dot ? ' dot' : '');
    n.textContent = sum ? (sum > 99 ? '99+' : String(sum)) : '';
    hdrAen.setAttribute('aria-label', label);
    hdrAen.dataset.label = label; hdrAen.dataset.sev = worst;
  }

  function hdrShowTip(d, el) {
    if (!hdrTip) { hdrTip = document.createElement('div'); hdrTip.id = 'ae-hdr-tip'; hdrTip.className = 'sg'; hdrTip.setAttribute('role', 'tooltip'); document.body.append(hdrTip); }
    hdrTipFor = d;
    const label = d.label, detail = d.detail;
    hdrTip.className = 'sg on sev-' + (d.severity || 'grey');
    hdrTip.replaceChildren(label, ...(detail ? [Object.assign(document.createElement('small'), { textContent: detail })] : []));
    hdrTip.style.display = 'block';
    const r = el.getBoundingClientRect(), tw = hdrTip.offsetWidth, th = hdrTip.offsetHeight;
    const above = r.top > innerHeight / 2;
    hdrTip.style.top = Math.round(above ? r.top - th - 8 : r.bottom + 8) + 'px';
    hdrTip.style.left = Math.round(Math.max(8, Math.min(r.left + r.width / 2 - tw / 2, innerWidth - tw - 8))) + 'px';
  }
  function hdrHideTip() { hdrTipFor = null; if (hdrTip) hdrTip.style.display = 'none'; }
  function hdrWire(el, get) {
    el.onmouseenter = () => hdrShowTip(get(), el);
    el.onmouseleave = hdrHideTip;
    el.onfocus = () => { try { if (!el.matches(':focus-visible')) return; } catch (_) { /* old engine: show anyway */ } hdrShowTip(get(), el); };
    el.onblur = hdrHideTip;
  }

  function hdrCloseMenu() { hdrHold = false; hdrQueue(); if (hdrMenu) hdrMenu.classList.remove('on'); hdrAen?.classList.remove('open'); hdrAen?.setAttribute('aria-expanded', 'false'); }
  function hdrOpenMenu() {
    if (!hdrMenu) {
      hdrMenu = document.createElement('div'); hdrMenu.id = 'ae-hdr-menu'; hdrMenu.className = 'sg sg-card'; hdrMenu.setAttribute('role', 'menu');
      document.body.append(hdrMenu);
    }
    hdrHideTip();
    const rows = hdrVisible().map((d) => {
      const b = h('button', { type: 'button', role: 'menuitem', onclick: (e) => { hdrCloseMenu(); try { d.onClick(e); } catch (err) { noteError('header-icon', err); } } },
        h('span', { html: d.icon && ACTION_ICONS[d.icon] ? actionIcon(d.icon, 26) : icon('aetheryte', 26), style: 'line-height:0;flex:none' }),
        h('span', { class: 't' }, d.label));
      if (d.badge !== '' && d.badge != null) b.append(h('span', { class: 'b sev-' + d.severity }, String(d.badge)));
      return b;
    });
    hdrMenu.replaceChildren(...rows);
    hdrMenu.classList.add('on'); hdrAen.classList.add('open'); hdrAen.setAttribute('aria-expanded', 'true');
    const r = hdrAen.getBoundingClientRect();
    hdrMenu.style.top = Math.round(r.bottom + 8) + 'px';
    hdrMenu.style.left = Math.round(Math.max(8, Math.min(r.left, innerWidth - hdrMenu.offsetWidth - 8))) + 'px';
    rows[0]?.focus();
  }

  function hdrRender() {
    hdrQueued = false;
    if (!document.body) return;
    const list = hdrVisible();
    if (!list.length) { hdrBox?.remove(); hdrCollapsed = false; return; }
    ensureCss();
    if (!document.getElementById('ae-hdr-css')) { const s = document.createElement('style'); s.id = 'ae-hdr-css'; s.textContent = HDR_CSS; addEarly(s); }
    if (!hdrBox) {
      hdrBox = h('div', { id: 'ae-hdr-icons', class: 'sg', role: 'group', 'aria-label': 'Aethernet' });
      hdrAen = h('button', { type: 'button', class: 'sg ae-hi ae-aen', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
        html: icon('aetheryte', 26) + '<span class="n"></span>', onclick: (e) => { e.stopPropagation(); if (hdrMenu && hdrMenu.classList.contains('on')) hdrCloseMenu(); else { hdrHold = true; hdrOpenMenu(); } } });
      hdrAen.onmousedown = () => { hdrHold = true; };
      hdrWire(hdrAen, () => ({ label: hdrAen.dataset.label || 'Aethernet', severity: hdrAen.dataset.sev || 'grey' }));
      hdrBox.append(hdrAen);
    }
    const anchor = headerAnchor();
    if (anchor) {
      hdrBox.classList.remove('floating');
      if (hdrBox.parentElement !== anchor.parentElement || hdrBox.nextSibling !== anchor) anchor.parentElement.insertBefore(hdrBox, anchor);
    } else { hdrBox.classList.add('floating'); if (hdrBox.parentElement !== document.body) document.body.append(hdrBox); }
    list.forEach((d, i) => { hdrPaintIcon(d); if (hdrBox.children[i] !== d.el) hdrBox.insertBefore(d.el, hdrBox.children[i] || hdrAen); });
    for (const el of [...hdrBox.children]) if (el !== hdrAen && !list.some((d) => d.el === el)) el.remove();
    hdrPaintAen(list);

    // Room: measured, not a breakpoint. Lay the icons out, then check the header row.
    hdrBox.classList.remove('collapsed');
    let collapse = false;
    const hdr = anchor && anchor.closest('.components-header');
    if (hdrHold && hdrCollapsed) collapse = true; // being clicked or open: stay put even though Search just lost focus
    else if (hdr && list.length > 1) {
      collapse = hdr.scrollWidth > hdr.clientWidth + 1; // the row overflows, with or without Search
      if (!collapse && hdrSearchOn) { // Search is open: is there room for it to open up (about HDR_SEARCH_OPEN px) beside the icons?
        const sb = hdrSearchBox(), field = sb && (sb.querySelector('.search-field') || sb);
        if (field) {
          collapse = field.getBoundingClientRect().right + 4 > hdrBox.getBoundingClientRect().left; // it already reaches them
          if (!collapse) { // would the row overflow if Search grew to its open width?
            const grow = Math.max(0, HDR_SEARCH_OPEN - sb.getBoundingClientRect().width);
            hdrBox.style.marginRight = (8 + grow) + 'px';
            collapse = hdr.scrollWidth > hdr.clientWidth + 1;
            hdrBox.style.marginRight = '';
          }
        }
      }
    }
    hdrBox.classList.toggle('collapsed', collapse);
    if (collapse !== hdrCollapsed) { hdrCollapsed = collapse; hdrHideTip(); if (!collapse) hdrCloseMenu(); emit('header-icons-changed'); }
    if (hdr && hdr !== hdrROEl && typeof ResizeObserver !== 'undefined') { hdrRO?.disconnect(); hdrROEl = hdr; hdrRO = new ResizeObserver(hdrQueue); hdrRO.observe(hdr); }
  }
  function hdrQueue() { if (!hdrQueued) { hdrQueued = true; queueMicrotask(hdrRender); } }
  function hdrSetup() {
    if (hdrInit) return;
    hdrInit = true;
    onDom(() => { const a = headerAnchor(); if (hdrBox && (a ? hdrBox.nextSibling !== a : !hdrBox.isConnected)) hdrQueue(); }); // Portal redrew its header
    addEventListener('resize', hdrQueue);
    const search = () => { const on = !!(hdrSearchBox() && hdrSearchBox().contains(document.activeElement)); if (on !== hdrSearchOn) { hdrSearchOn = on; hdrQueue(); } };
    document.addEventListener('focusin', search);
    document.addEventListener('focusout', () => setTimeout(search, 0));
    document.addEventListener('click', (e) => { if (hdrMenu && hdrMenu.classList.contains('on') && !e.composedPath().includes(hdrMenu) && !e.composedPath().includes(hdrAen)) hdrCloseMenu(); });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      hdrHideTip();
      if (hdrMenu && hdrMenu.classList.contains('on')) { hdrCloseMenu(); hdrAen.focus(); }
    });
    document.addEventListener('mouseup', () => setTimeout(() => { if (hdrHold && !(hdrMenu && hdrMenu.classList.contains('on'))) { hdrHold = false; hdrQueue(); } }, 0));
    addEventListener('scroll', hdrHideTip, true);
  }
  function headerIcon(opts) {
    hdrSetup();
    let d = headerIcons.get(opts.id);
    if (!d) {
      d = { id: opts.id, order: 100, severity: 'grey', badge: '', count: 0, label: opts.id, detail: '', busy: false, headerOnly: false, onClick() {}, sig: null };
      d.el = h('button', { type: 'button', id: opts.elId || 'ae-hi-' + opts.id, class: 'sg ae-hi',
        html: (opts.icon && ACTION_ICONS[opts.icon] ? actionIcon(opts.icon, 26) : icon('aetheryte', 26)) + '<span class="n"></span>',
        onclick: (e) => { hdrHideTip(); try { d.onClick(e); } catch (err) { noteError('header-icon', err); } } });
      d.icon = opts.icon;
      hdrWire(d.el, () => d);
      headerIcons.set(opts.id, d);
    }
    const handle = {
      update(patch) {
        let changed = false;
        for (const k of ['label', 'detail', 'badge', 'count', 'severity', 'busy', 'order', 'headerOnly', 'onClick']) {
          if (k in patch && d[k] !== patch[k]) { d[k] = patch[k]; changed = true; }
        }
        if (changed) hdrQueue();
        return handle;
      },
      remove() { headerIcons.delete(opts.id); d.el.remove(); hdrQueue(); },
      get el() { return d.el; },
    };
    handle.update(opts);
    hdrQueue();
    return handle;
  }
  // Where an icon is on screen right now (the AeN icon while the icons are folded), for panels that hang off it.
  function headerIconBox(id) {
    const d = headerIcons.get(id);
    const el = d && (hdrCollapsed ? hdrAen : d.el);
    if (!el || !el.isConnected || !el.offsetParent && getComputedStyle(el).position !== 'fixed') return null;
    return { rect: el.getBoundingClientRect(), floating: !!hdrBox && hdrBox.classList.contains('floating') };
  }

  // The "Work order #123" heading on a WO page (Esuna's pill and Waymark's tags go in its row).
  // Kept while it's in the page; the scan matches text first and checks visibility only on matches.
  let woHead = null;
  function woHeading(woId) {
    const want = 'Work order #' + woId;
    if (woHead && woHead.isConnected && woHead.textContent.trim().startsWith(want)) return woHead;
    woHead = [...document.querySelectorAll('[data-aui="text"]')].find((el) => el.textContent.trim().startsWith(want) && el.offsetParent) || null;
    return woHead;
  }

  // The one flex row beside the heading where every shard's chip goes (see the chip notes in the CSS). Null off a WO page.
  function woHeadingRow(woId) {
    const heading = woHeading(woId), parent = heading && heading.parentElement;
    if (!parent) return null;
    let box = document.getElementById('ae-wo-chips');
    if (!box) { box = document.createElement('div'); box.id = 'ae-wo-chips'; box.className = 'sg'; }
    if (box.parentElement !== parent) { parent.appendChild(box); watchFit(box, parent); }
    return box;
  }
  // Fit the chip row to the heading, as little compaction as possible (levels in the CSS above): the customer's name must not be
  // cut unless nothing else helps. Measured, not guessed: each level is tried in one synchronous pass (no paint between), the
  // first where the name is whole and the row isn't squeezed wins. Re-runs (debounced) when the heading's row resizes (window,
  // Portal's sidebar) and when chips come or go.
  let fitBox = null, fitRO = null, fitMO = null, fitTimer = 0, fitW = -1;
  function fitChips() {
    fitTimer = 0;
    const box = fitBox, parent = box && box.parentElement, head = woHead;
    if (!box || !parent || !head || !head.isConnected || !box.isConnected || !box.firstElementChild) return;
    fitW = parent.clientWidth;
    let lvl = 0;
    for (; lvl <= 3; lvl++) {
      box.dataset.fit = String(lvl);
      parent.style.flexWrap = lvl === 3 ? 'wrap' : '';
      if (lvl === 3 || (head.scrollWidth <= head.clientWidth + 1 && box.scrollWidth <= box.clientWidth + 1)) break; // own line: the row wraps, so it always fits
    }
    // at level 3 a name still too long for its own line gets Portal's ellipsis, as it always did
    fitW = parent.clientWidth;
  }
  const fitSoon = () => { if (!fitTimer) fitTimer = setTimeout(fitChips, 40); };
  function watchFit(box, parent) {
    fitBox = box;
    if (!fitRO && window.ResizeObserver) fitRO = new ResizeObserver(() => { if (fitBox && fitBox.parentElement && fitBox.parentElement.clientWidth !== fitW) fitSoon(); });
    if (!fitMO) fitMO = new MutationObserver(fitSoon);
    fitRO && (fitRO.disconnect(), fitRO.observe(parent));
    fitMO.disconnect(); fitMO.observe(box, { childList: true, subtree: true, characterData: true });
    fitSoon();
  }

  // Put a chip in that row at `order` (10 Esuna, 20 Assize, 30 tags, 40 + Tag, 50 Auto-Waymark). Returns false off a WO page.
  function woChip(woId, el, order) {
    const box = woHeadingRow(woId);
    if (!box) return false;
    if (order != null && el.style.order !== String(order)) el.style.order = String(order);
    if (el.parentElement !== box && !(el.parentElement && el.parentElement.parentElement === box)) box.appendChild(el);
    return true;
  }

  // The element whose own text is exactly `text` (e.g. the arrival drawer's "Preferred contact method"),
  // kept while it's in the page. Walks text nodes, not every element: cheap enough for the page watcher.
  const textEls = new Map();
  function textEl(text) {
    const c = textEls.get(text);
    if (c && c.isConnected && c.textContent.trim() === text) return c;
    if (!document.body) return null;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.nodeValue.trim() === text ? 1 : 3) });
    let el = null;
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.parentElement && n.parentElement.children.length === 0) { el = n.parentElement; break; }
    textEls.set(text, el);
    return el;
  }
  // A visible button whose text passes `test`: text first, visibility (a layout read) only on matches.
  function findButton(test, skip) {
    for (const b of document.querySelectorAll('button')) {
      const t = b.textContent.trim();
      if (test(t) && !(skip && skip(b)) && b.offsetParent) return b;
    }
    return null;
  }

  // When the page has a <body> (the script starts before Portal's HTML is parsed, @run-at document-start).
  function whenReady(fn) {
    if (document.body) return fn();
    document.addEventListener('DOMContentLoaded', () => fn(), { once: true });
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
    settings, saveSettings, DEFAULTS, merge, config, CONFIG_KEY, shards, shard, start, every, onDom, watchDom, whenReady, addEarly, domStats, afterLoad, headerAnchor, headerIcon, headerIconBox, woHeading, woHeadingRow, woChip, textEl, findButton,
    api, unwrap, Stopped, portal, refreshView, profile, spellIcon, spellDone, holdPage, sleep, esc, h, icon, actionIcon, asset: (name) => ACTION_ICONS[name] || '', wordmark, ensureCss, progressPanel,
    settings, saveSettings, DEFAULTS, merge, config, CONFIG_KEY, shards, shard, start, every,
    api, unwrap, Stopped, portal, sameStore, assertSameStore, storeChanged: () => storeChanged, refreshView, profile, spellIcon, spellDone, holdPage, sleep, esc, h, icon, actionIcon, asset: (name) => ACTION_ICONS[name] || '', wordmark, ensureCss, progressPanel,
    hooks, now, nowDate,
    confirm: confirmDialog, toast, emit, on, data, track, trackDaily, noteError, recentErrors, pageErrors, USAGE_KEY, localDay,
    PARENT_PROGRAM_ID, CLEANING_PROGRAMS,
    autoClose: null, // set by the auto-close shard when it's enabled
    // Bug report links (06-feedback.js replaces these; without it, e.g. the demo build, just the words).
    bugLink: (label) => esc(label), bugLinkEl: (label) => h('span', null, label),
  };
})();
