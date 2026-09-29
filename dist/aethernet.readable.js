// ==UserScript==
// @name         Aethernet — crystals for NextGen Portal
// @namespace    garrett.ubif
// @version      2.13.0
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
const AE_VERSION = '2.13.0';            // filled in by build.py
const AE_BUILD_TIME = '2026-09-29T19:53:08-04:00';       // ISO time of the build
const AE_BUILD_COMMIT = '290de91';   // git commit it was built from ("-dirty" = uncommitted changes)
const AE_INSTALL_URL = 'https://gist.githubusercontent.com/Unix-Epoch/0cf4560c4f26d8ff9091a10068fd3464/raw/aethernet.user.js';
const AE_READABLE_URL = 'https://gist.githubusercontent.com/Unix-Epoch/0cf4560c4f26d8ff9091a10068fd3464/raw/aethernet.readable.js'; // same build, unminified     // where installs update from
const AE_ON_PORTAL = location.hostname === 'portal.ubreakifix.net';

const AE = (() => {
  const SETTINGS_KEY = 'sg_settings';
  const DEFAULTS = {
    crystals: { cleaningRate: true, woCleanings: true, textNotes: true, autoClose: true, galaxy: true, printLabels: true, buybacks: true, glamour: true, waymark: true },
    cleaningRate: { target: 75 },
    printLabels: { delayMs: 900 },
    glamour: { theme: 'portal', custom: [] }, // custom: [{ id, name, bg, fg, accent, custom: true }]
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
  const ACTION_ICONS = {"autoClose": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAMKADAAQAAAABAAAAMAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAMAAwAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwQDAwMEBQQEBAQFBwUFBQUFBwgHBwcHBwcICAgICAgICAoKCgoKCgsLCwsLDQ0NDQ0NDQ0NDf/bAEMBAgICAwMDBgMDBg0JBwkNDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDf/dAAQAA//aAAwDAQACEQMRAD8A/KL9pS9+OfxD8ez/ABQ+N4nl1LVYoZEZ4XtoUs2JMSWyPnEADEpjIwc5NfRH7PH7EPjv4zaWupXB/sLwdeYlgv7hN08oP3hBDwX/AN8kJnOCRiv2A8EfDbwh+2d8NPBXxE+Ititxc6RC+n4GCl/DbFWh8zOWCOAd654fdjAavEPjV+0Z4m03xBP8KPhPZPo+naWRZXOqQwgOdnyGO0XAWOOLGNw5OPlwOvl8NZrVx1GrVULqL0dt1ZXdrvZtxfnFn6PwZgp1MXPDYZRvOyTetk0079015b2PMfF37DX7MPwE8A3PizxUmq+Ib2ILBaR3l55AvL6XiKJUhVcBm5PJwoPNa3g79i/9l/43fDvT/GXhS31PQZr6HbOlteed9lu0AEkZSZWyFbpyMqQc16J8Z7X/AIWi/h+XURdT6X4autOt7RMlVvLyfy1luHzywyCq9+vrVX4Baofh1pF2bq1m07R9Uk1OCeIkskF9YzTQxyoeoWUpj249K5M9wWecS4DE5XwdiJ0Mww0oTjZLkqRu1UpyTTi/d96Cau5R5VpJmPE+TLAxpOpBcqupeTlbkt321XS+p+fHx9/Yi8T/AAotJdV0iUa34ctg0j3US7Z484x58fOB0+YErx1HSvjb4Y/Fr4hfs9fEiz+JXw0vRp2rWO5BuXfDPC5BeGZMjfG+0blyM4r9zPAvxw1HxTqi+A/G9o1zLqBe3gumjBWTfkeXOuMMG6bu/Q5618V/tQ/seaR4R1OfxBo92kFvqXmTR2Kgn7M0YzIhI4CjIxk98V97mUeJsDhnlPFMKft6TX72kvcqxVoxlb7El9qNkru6SW/wkcXGri5YCUPeSbTjdppav0ceq7a7H//Q9+/YVv8AVtA/Ys0yOWcx6nqV1epY72yN8spSGMHqodkKAjoXzXCXfhnxLJq63nhnXrTyrlxM0GpWkc8/lN83lq5wfruyQRwa4r9n74nWl/8Asg6VfaNsu5fDuvpYTCT5WR7hv3UgwThg0ylSTjIr1P4heJ79V07xFp6wCLU4ku42A2kNK7JcRHbjmG6SVD227SeteZhsqpTzn+zqcnCM07OO2t+zs093dPVn7Hw7k+F5G6E/ejJ295JtaWvo736ej+XX6z4c+MviGfw34fgtLFNKt9e0m5udTtSuXtYpon8pkHzK29T1A3AccdcKz0D48Q3OteHr/TNPsdBs9V1aS31e4CFZbZ7h2gjRGyWkBJJIUjs2Otet6H8UND8G6r4SvLkrdarqsUFnNP5zRWiW9xMqD5eGmcEnbn5R1weDWZ4/+Jll420zxdeoP7L1OymNnDcmV57S4t4HkVOASYCcclcqScnHWvv+AKGJwFWonQTjU5Ie1abfuyklLl5r395xbta6vyW1POzbH4mWLpxpwTVLnly2TUne2t77bq219rHx94qsPEOmP9u8T+K7O0SAlhDpEMcFzNjkBpEyUxwNwK/Sq/x/8dXnj/8AZ7T+wUMUiRRTSMWLyy/Z3MLl3I3MT1P514R4l8aSz3Dw3UkRbJGMBgfcMc5H0rd8ZeKdN0D4K266gYx9qtJlVQNuGmuGI4XHO1M/jX7dmHBuVYbD1qmIquc3Ft3eiVnt21eh8M3WzbEQnVhGlGElJqL9U7+6ujt9x//R/LL9mn4t6V4Vl1X4beMrmWLwn4zhFnqLhzttZl5troKO8UmCT12nPav16+HGhrq/w8uPCXiG8ha78OSxXdo5kXy72xvtsFy8LE4cb0t7lQCesnvn8KvjD8HfiJ+z58Q7z4efEWx/s3W9OKyjY2+GaJidk8L4G+J9p2tgZx0r6B+EHx+1/wAM+Hrfw5q07arp+10hUyFbi1DffEMpBKLzyhBXngAV2YDA1sRXTofEreTVu3n/AMD5/f8ABWYNVXh5vTv89v076vufen7Vviy78H6h4W1/QJP3ehWCTWgH3JWt2JcHHUNtx9K6f4ceNLvxJ8K/Ft7rUoae78iSEnCkSOXcx47fKMge9fKfxT8b+HPiJ8JvD9wmrxwNBc3cAbUI3QhSq4VjD5gJUnI7HPSu4bVvBHgv4Vabc6h4l8+DULuSWSLS4nd5mTaEAkmEYQAcZwcehr7Lh/OqTnTwU5r3amrbS0TcuvqtPI9bH5tTlP2FK3Klyptr4r7vXrbX1Z56nhi+8W+JI7e2HlWkZ8y/u8fJBADy7dtx5CjqzYFeQftG/FHSNYceG9CPlWOmbIYVVsgrGAqr6HAHJ7nJ710/xB+N9ldaMfD/AITiGkWMxLKI23SyyY4MsnG4n9OcYGQfmP4Y/CT4lftEfE22+HXw/sTqGu37O7CRtkUESECSad8Hy40LDc2DjPevqPEXPnKk6GE+Co/el3tqo+nV9/z+czqnRwFL2WHfNKdnJrpbaK8urb3dtNNf/9k=", "buybacks": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAMKADAAQAAAABAAAAMAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAMAAwAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwQDAwMEBQQEBAQFBwUFBQUFBwgHBwcHBwcICAgICAgICAoKCgoKCgsLCwsLDQ0NDQ0NDQ0NDf/bAEMBAgICAwMDBgMDBg0JBwkNDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDf/dAAQAA//aAAwDAQACEQMRAD8A/PT4i+N/iL8dPHD/ALTul6o+s6vAY/7T0thmTT4EJxFFHzutAGYLjOASG9T2HhLwjoFt4jtvGOhxZ8E/EC3k0vVLUc/2deTD/VsOwWTDIT2qv8P9F8Nalr8Gt+BJZvAni6L/AFukXwb7Dd5+8iM3QN02tn619teCfhgJ4L28TS10uDUyo1PTmZRaC7HKywMSFBY9AP51/MfGXFzoOVOo5Xa5dfj5XsnbSXK/ep1Itq65ZWbbf7jknDPMlNJWTvp8N+6vtzLScXbuux84eHfhVe2eieFdHvYy114L8VtEGx961mYMrD24B/Gm6/8ACq9vND8VaPZRlbrxp4sWItj7trCzMzH25J/CvrrxD4t8B+BvHtl8NvE4uv7ZvLaG4uZIAj/ZmcEwo8ZIeSQoN5VfmCsu0MWAr0bVfANzbX62dpNa3Ujo8tssU0ZmkSQZLpHnzOnX5cjvX57ieJM6w0KeY16LjTqe/GVvdfve0v6c/vWfTyPoKWT5XVcsNTqpyWjV/Ll+fu6aH5f+LfCPh+58RXXjHXI8eCfh/bx6XpdqeP7RvIR9xR3DSZZyO1cb8OvG/wARfgX45j/ad1TU5NG1ecyf2ZpajD6hA5GYZY+NtoQqhvUABfUff/jX4Zm2WyludGe9TTATpmlyL5dsbluTPOW4bB55/ma+KfiBovhrTdfn1vx3NL478XS/6rSLEN9htMfdR2XqF6bVx9a/QeC+L/rHLCk22lbTWXKui6R5n71SpJpXfLG7Sa8DPOGHC7klvfXa/d9XyrSMUn3e9n//0PKfBFrrOqCK013XvDnjCAEbZHXbdgeofbuz9azv20rzxD4X8O+AoNHlMVjPbXji235xNFKimRkY5OUcKrkdmUHqK27jxhd/Br4fweOLrwRo+lzXV8bK3h2C4nTEDyhyrHaPmUD5sj254+UtV+Pv/CbatJr3xK0RPEdxJ0PmNAFVf9WixxFVWOMZCoqgDJJ5JJ/mngXhzFV86hnacVQp8yS913k046KHuK3VrXp5r+huNMfh6eGeUK/O+Vt9lul3fzOo8DfCTx38W9RsPihpurXPiJjewLq8crl7y0kUJGpk53NGyIoSTn7u1sMBn6E/aC+EnjLw14+8beOFvZ/Dek6HqEk0WpxM0NxNchi8SWzKQ7S55BBAQAsSB1+o/wBiP4jfCWOK58S2XhCLwjYxstpJezXkrieaUcQokh/eO/UrjgcnAxXsf7bnj/4fx+GLs3nhuHxguhzmDULVbqSF7KWQ4DvHGRlZDxv5BIwecZ/fYQXLZWstLdLdvT8D4dUKcbUORuLi3z6aPTz/AFT1Wnf8ov2af2hbq98Yz+AviX4jMnh/Xba4LT6pPJKtvdrGZIpPOYs0Zdl2OejBstyAa9a+Imla1oEklnoXiDw14StZkWVZ4QHuJYpBuVxJjJDKQQR1zXwh8UfHHw+1e8jHgTwbBoM0bbGeOeeRh/tHfIVP/AhX3ZDrlp8Sfhjoms+GPDGn+Iv7C06w0jUo7kgXBuIYAN0bg/vEbYSOhAwCK/FvEXhuhhsbTznDwUYytGatBRuvhk1K0bu6jd+Xz+t4HzB1pVcqrSva8ou7v5xXy10P/9H5n8a6FpWvfCi/0Dwvf3fiTWNIujqmqXJLMq2/kvCTGDn5I2cFz2X5ugr4TvTJouoJYXRDSBzGdoI2sPUHqPev0217w94y+Bvjb/hStjposdQfadRu5lDpeW0mQWUnrA4Bwe4/SbTdC+CGseN9Tu5/D76pZ6fAZtSlurk+TJMOSEMSxygFuf8AWZ469c/hOU8TU8lo1cNmFObteS25rbe8tFFuWkI9u2p/VXGXAWNzjE080yecZRlFXvLstGn1UlZJLW/4fFPhn4na++r+HtKvrkrp2l3Mfk24+VEJYFmwP4mPLE8njnAFd9+0j8X9Yi+Ovi3W9EvJhHfzzRyR78wSxv8AKyunRlI/hORXvWp/Bv4P+M7DStX0hrnwzqWt3MkdpE5+1WijkoSxxOo45JMnHb1+efHH7LnxMudX1HUrOa11u3hn8q4u7O4Ro43YnmTzDG8a45LSKoHrX1mU8aZVim4qpyS6qXu7Pl9Hrpo2fA51wlxBgYezqUHJXsnFcy3t0v1016nyBdXM11KWP8bZ2L0GfavvP4N2mg/8KUey1rU7jQNRu9YEmn3cbEI2yAKyyAdsmtHwj+zz8Nvh7qOkr8Vr/wDte61SAy20WlykWMch+4s9yVDvg/eWIKP9s16z4Z8N+KPjJ4ni+AMWh2/mWxdtLewhWCGygBGZX2jmPkF3OWOckk14PEPEVDNILL8v5pNtPmj2Ts+VNNTs1aUez66H1nAXAuPy6v8A23m1qVOMZaSdnZpq7/lS6p2fkf/Z", "cleaningRate": "data:image/jpeg;base64,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", "galaxy": "data:image/jpeg;base64,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", "glamour": "data:image/jpeg;base64,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", "printLabels": "data:image/jpeg;base64,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", "textNotes": "data:image/jpeg;base64,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", "waymark": "data:image/jpeg;base64,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", "woCleanings": "data:image/jpeg;base64,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", "ui/macro-gear": "data:image/png;base64,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"};
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

  // --------------------------------------------------- crystal registry
  const crystals = [];
  function crystal(def) { crystals.push(def); }
  function start() {
    ensureCss();
    for (const t of crystals) {
      if (!settings.crystals[t.id]) continue;
      if (t.sites && !t.sites.includes(location.hostname)) continue;
      // Paused remotely by an Aethernet notice (status.json); last-known copy.
      if (AE.status && AE.status.paused(t.id)) { console.info('[' + AE_NAME + '] ' + t.name + ' is paused by an Aethernet notice'); continue; }
      try { t.run(); } catch (e) { console.error('[' + AE_NAME + '] ' + t.name + ' failed to start', e); }
    }
  }

  // Poll a route/DOM check — Portal is a single-page app, so pages
  // change without a load and Portal re-renders often.
  function every(ms, fn) {
    // Promise.resolve so async callbacks' rejections are caught too.
    const safe = () => Promise.resolve().then(fn).catch((e) => console.error('[' + AE_NAME + ']', e));
    setInterval(safe, ms);
    safe();
  }

  return {
    settings, saveSettings, DEFAULTS, merge, crystals, crystal, start, every,
    api, unwrap, Stopped, profile, sleep, esc, h, icon, actionIcon, asset: (name) => ACTION_ICONS[name] || '', wordmark, ensureCss, progressPanel,
    confirm: confirmDialog, toast, emit, on, data,
    PARENT_PROGRAM_ID, CLEANING_PROGRAMS,
    autoClose: null, // set by the auto-close crystal when it's enabled
  };
})();

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
  const VER_RE = /^\d+(\.\d+){0,2}$/;

  const verTuple = (v) => String(v || '0').split('.').map(Number);
  const newer = (a, b) => { const x = verTuple(a), y = verTuple(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
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
  async function checkNow() {
    const busy = AE.toast('Checking for updates…', '', 'busy');
    try { await refresh(true); } catch (e) {
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

  return { get: () => state, incident, paused, blocked, refresh, checkNow, startUpdate, updateAvailable, newer, url: STATUS_URL };
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
    ['woCleanings', 'Esuna', 'WO cleanings pill: shows whether a work order\'s device has cleanings, with Create for available ones.'],
    ['textNotes', 'Recitation', 'Text → WO note: when you text a customer from a WO, the text is added to the WO notes.'],
    ['autoClose', 'Swiftcast', 'Cleaning auto-close: one-click check-in → complete sale on cleaning arrivals.'],
    ['galaxy', 'Macrocosmos', 'Galaxy Diagnostics exception: pre-fills the Sprinklr exception form from a Samsung WO.'],
    ['buybacks', 'Bountiful Yield', 'Buyback add-all: bulk-adds Apple (TLC) or Samsung/Google (UROC) parts in the Add buyback parts popout.'],
    ['printLabels', 'Quick Synthesis', 'Print all labels: prints every serial label on a PO Receive page.'],
    ['glamour', 'Glamour', 'Page theming: recolour Portal with a preset theme or one you make.'],
    ['waymark', 'Waymark', 'Work-order tags: tag WOs for the whole store and see them grouped on a board.'],
  ];

  /*
    What's new. A crystal is "new" until Settings has been opened and closed
    once with it listed; new ones get a yellow sheen. The first run of a build
    after an update shows an "Aethernet has updated!" pill (once) that opens
    Settings. A fresh install sees neither.
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
  const markAllSeen = () => GM_setValue(SEEN_KEY, [...new Set([...GM_getValue(SEEN_KEY, []), ...allIds()])]);
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
  @keyframes sg-pill-in { from { opacity:0; transform:translate(-50%, 10px); } to { opacity:1; transform:translate(-50%, 0); } }
  @media (prefers-reduced-motion: reduce) { .sg-crystal.sg-new, .sg-update-pill { animation:none; } }
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

    const card = h('div', { class: 'sg sg-card sg-about', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'About ' + AE_NAME },
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
  const PATCH_NOTES = [{"version": "2.13.0", "notes": ["New crystal: **Waymark** (work-order tags). Tag work orders for the whole store from **+ Tag** next to the customer's name, and see open work orders grouped by tag from the Waymark button in the header.", "Each store has its own tag list with colours, set in Settings \u2192 Waymark by store managers, district managers and franchise owners. Anyone can add one-off tags.", "Every tag change is logged on the work order (not as a Portal note). Tags and their history clear 7 days after a work order closes."], "date": "2026-09-29T23:53:08Z"}, {"version": "2.12.0", "notes": ["Aethernet is now about 40% smaller, and its daily update check downloads about 1 KB instead of the whole script.", "The installed file is minified. **About** links to the readable source (the same build, unminified).", "Fixed: in the first few minutes after a release, **Update** could open the previous version. New versions are now offered once they're fully out."], "date": "2026-09-29T23:28:58Z"}, {"version": "2.11.0", "notes": ["New: **Check for updates** at the bottom of Settings. If there's a newer version, one click opens Tampermonkey's Update page.", "When a new version is out, an **update available** pill appears within about 15 minutes, with an **Update** button.", "New: **Aethernet notices**. When the team knows about a problem, a banner under Portal's header says what's wrong and that it's being worked on. Affected crystals are marked in Settings.", "If a crystal is misbehaving, the team can pause it everywhere until it's fixed; the banner says which ones are paused."], "date": "2026-09-29T19:10:53Z"}, {"version": "2.10.0", "notes": ["New: **Patch notes**. Open them from the bottom of Settings; every release gets its own panel with the date and time it went out.", "The **Aethernet has updated!** pill now opens these patch notes (Settings stays open underneath)."], "date": "2026-09-29T16:18:34Z"}, {"version": "2.9.1", "date": "2026-09-29T15:38:03Z", "notes": ["**Macrocosmos**: the button wears the hotbar macro gear and shows its macro name, **GD Exception**, on hover.", "The first time the Macrocosmos button appears, a short explainer points at it, with a link straight to its settings.", "Settings can now open straight to one crystal with its settings expanded."]}, {"version": "2.9.0", "date": "2026-09-29T15:26:27Z", "notes": ["Every crystal now shows its FINAL FANTASY XIV action icon in Settings and About.", "The Galaxy Diagnostics pill is now the **Macrocosmos** icon itself, like a hotbar slot: click to file, drag to move."]}, {"version": "2.8.2", "date": "2026-09-28T15:42:48Z", "notes": ["**Glamour** now switches Portal's own light/dark theme, so theme-specific images (Inventory icons, the Reports banner) match your theme."]}, {"version": "2.8.1", "date": "2026-09-28T15:35:53Z", "notes": ["**Glamour**: dark themes put Portal in dark mode, so the ubreakifix logo turns white. Your own Portal mode comes back when you pick the Portal theme.", "Portal is now written as a proper noun everywhere."]}, {"version": "2.8.0", "date": "2026-09-28T15:28:00Z", "notes": ["New crystal: **Glamour** (page theming). Pick a preset (Limsa Lominsa, Gridania, Crystarium, Ul'dah, Ishgard, The Void) or make your own from a background, text and accent colour. Previews live; Cancel puts yours back."]}, {"version": "2.7.0", "date": "2026-09-28T14:41:31Z", "notes": ["Crystals are now named after FFXIV actions: Divination, Esuna, Recitation, Swiftcast, Macrocosmos, Bountiful Yield and Quick Synthesis.", "An **Aethernet has updated!** pill appears once after each update.", "New crystals get a yellow sheen in Settings until you've seen them.", "Each crystal's settings now sit under it in the Crystals list."]}, {"version": "2.6.0", "date": "2026-09-26T22:11:30Z", "notes": ["Settings sections collapse, and remember which ones you left open.", "New subtitle: Restoring the *flow* of NextGen.", "New **About** window: version, build time, author, your setup, and the install link to share with another store.", "The Aethernet name in titles uses its own wordmark."]}, {"version": "2.5.0", "date": "2026-09-26T21:35:43Z", "notes": ["New crystal: **Buyback add-all** (now Bountiful Yield). Adds every Apple (TLC) or Samsung/Google (UROC) part in a buyback order's Add buyback parts popout.", "Fixed: its buttons no longer need the script removed and re-added before each buyback."]}, {"version": "2.4.0", "date": "2026-09-26T21:30:09Z", "notes": ["Aethernet's tools are now called **crystals**. Your on/off switches carry over."]}, {"version": "2.3.2", "date": "2026-09-26T21:07:05Z", "notes": ["**Text \u2192 WO note** now works in every browser, including Firefox and Zen: it spots sent texts from the browser's own network log."]}, {"version": "2.3.1", "date": "2026-09-26T20:56:36Z", "notes": ["Attempted fix for **Text \u2192 WO note** on Firefox and Zen (finished in 2.3.2)."]}, {"version": "2.3.0", "date": "2026-09-26T20:52:51Z", "notes": ["New crystal: **Text \u2192 WO note** (now Recitation). Texting a customer from a WO adds a note: \"<you> sent a text message to <customer>.\" followed by the message."]}, {"version": "2.2.0", "date": "2026-09-26T20:42:10Z", "notes": ["New crystal: **WO cleanings pill** (now Esuna). On a work order, shows whether the device has cleanings available or done, with Create for available ones.", "Pending cleanings in the cleaning-rate list get a \u26a1 to create them, behind a confirmation."]}, {"version": "2.1.1", "date": "2026-09-26T20:30:12Z", "notes": ["Aethernet now installs from a link and updates itself."]}, {"version": "2.1.0", "date": "2026-09-26T20:29:50Z", "notes": ["The cleaning rate counts cleanings still waiting in Arrivals, shown as dashed chips.", "The cleaning list shows each customer's name instead of the device nickname."]}, {"version": "2.0.0", "date": "2026-09-26T19:37:00Z", "notes": ["First Aethernet release: one install bundling the cleaning auto-close \u26a1, the live cleaning rate badge, the Galaxy Diagnostics exception button and Print all labels, with a Settings menu in Portal's avatar menu."]}];
  const verTuple = (v) => String(v || '0').split('.').map(Number);
  const newer = (a, b) => { const x = verTuple(a), y = verTuple(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
  const noteHtml = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>');
  function openPatchNotes(since) {
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
          h('span', { class: 'when' }, when)),
        h('ul', null, n.notes.map((t) => h('li', { html: noteHtml(t) }))));
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
    const s = AE.merge(AE.DEFAULTS, AE.settings); // working copy

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
      galaxy: [() => ['technicianName', 'email', 'location'].some((k) => s.galaxy[k]) ? 'Overrides set' : 'Using your login',
        h('div', { class: 'sg-soft', style: 'margin-top:8px' }, 'Leave blank to use your login. Only fill in to override.'),
        (galaxyInputs.technicianName = input('Technician name', s.galaxy.technicianName, '', (v) => { s.galaxy.technicianName = v.trim(); repaintSums(); })),
        (galaxyInputs.email = input('Your email', s.galaxy.email, '', (v) => { s.galaxy.email = v.trim(); repaintSums(); })),
        (galaxyInputs.location = input('UBIF location (as shown in the form)', s.galaxy.location, '', (v) => { s.galaxy.location = v.trim(); repaintSums(); })),
        input('Store email (optional)', s.galaxy.storeEmail, 'Left blank', (v) => { s.galaxy.storeEmail = v.trim(); }),
        input('Tool version', s.galaxy.toolVersion, 'Latest', (v) => { s.galaxy.toolVersion = v.trim() || 'Latest'; }),
        input('Description', s.galaxy.description, 'ER', (v) => { s.galaxy.description = v; }),
        h('button', { class: 'sg-btn', style: 'margin:4px 0', onclick: (e) => { GM_deleteValue('gde_btn_pos'); e.target.textContent = 'Button position reset'; } }, 'Reset button position')],
      glamour: [() => AE.glamour.summary(s.glamour), AE.glamour.editor(s, () => repaintSums())],
      waymark: [() => AE.waymark.summary(), AE.waymark.editor()],
      printLabels: [() => s.printLabels.delayMs + ' ms between labels',
        input('Delay between labels (ms)', s.printLabels.delayMs, '900', (v) => { s.printLabels.delayMs = Math.max(200, Number(v) || 900); repaintSums(); }, 'number')],
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
      const fresh = isNew(id);
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
      return h('div', { class: 'sg-crystal' + (fresh ? ' sg-new' : ''), 'data-crystal': id },
        h('div', { class: 'sg-row' },
          h('div', null, h('b', { class: 'sg-cname' }, h('span', { class: 'sg-cicon', html: AE.actionIcon(id, 24) }), name, fresh ? h('span', { class: 'sg-new-tag' }, 'New') : null,
              issueTag(id)),
            h('span', { class: 'sg-soft' }, desc), optToggle ? h('div', null, optToggle) : null),
          toggle(!!s.crystals[id], (v) => { s.crystals[id] = v; repaintSums(); })),
        optBody);
    };

    const sheet = h('div', { class: 'sg sg-card sg-sheet', role: 'dialog', 'aria-label': AE_NAME + ' settings' },
      h('div', { style: 'display:flex;align-items:center;gap:12px' },
        h('span', { style: 'color:var(--aui-primary,#8223d2)', html: icon('aetheryte', 36) }),
        h('div', { style: 'flex:1' }, h('h2', { class: 'sg-wordmark', html: AE.wordmark(26) }), h('div', { class: 'sg-soft', html: 'Restoring the <span class="sg-flow">flow</span> of NextGen · v' + AE_VERSION })),
        h('button', { class: 'sg-x', title: 'Close', onclick: () => close() }, '✕')),

      section('who', 'Signed in as', true, () => who.querySelector('dd') ? who.querySelector('dd').textContent : '',
        who,
        h('div', { class: 'sg-soft', style: 'margin-top:6px' }, 'Pulled from your portal login. Crystals use these automatically.')),

      section('crystals', 'Crystals', true,
        () => CRYSTAL_INFO.filter(([id]) => s.crystals[id]).length + ' of ' + CRYSTAL_INFO.length + ' on',
        h('div', null, CRYSTAL_INFO.map(([id, name, desc]) => crystalRow(id, name, desc)))),

      h('div', { class: 'sg-foot-links' },
        h('button', { type: 'button', class: 'sg-about-link', onclick: () => AE.status.checkNow() }, 'Check for updates'),
        h('button', { type: 'button', class: 'sg-about-link', onclick: () => openPatchNotes() }, 'Patch notes'),
        h('button', { type: 'button', class: 'sg-about-link', onclick: openAbout }, 'About ' + AE_NAME + '…')),

      h('div', { class: 'sg-sheet-foot' },
        h('button', { class: 'sg-btn sg-lg', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'sg-btn sg-lg sg-primary', onclick: () => { AE.saveSettings(s); close(true); location.reload(); } }, 'Save & reload')));

    const scrim = h('div', { class: 'sg sg-scrim', id: 'sg-settings', onclick: (e) => { if (e.target === scrim) close(); } }, sheet);
    // Every way out ends the "new" sheen: the crystals have now been seen.
    function close(saving) {
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
      for (const k of Object.keys(galaxyAuto)) galaxyInputs[k].querySelector('input').placeholder = 'Auto: ' + (galaxyAuto[k] || '—');
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

  if (updated) {
    AE.ensureCss();
    if (!document.getElementById('sg-settings-css')) document.head.append(h('style', { id: 'sg-settings-css' }, MODAL_CSS));
    const x = h('span', { class: 'x', role: 'button', 'aria-label': 'Dismiss', title: 'Dismiss' }, '✕');
    const pill = h('button', { type: 'button', class: 'sg sg-update-pill', id: 'sg-update-pill', title: "See what's new" },
      h('span', { html: icon('aetheryte', 20) }), AE_NAME + ' has updated!', h('span', { class: 'ver' }, 'v' + AE_VERSION), x);
    // Settings opens underneath (that's where new crystals are marked), with the patch notes on top.
    pill.onclick = (e) => { pill.remove(); if (e.target !== x) { open(); openPatchNotes(lastVersion || AE_VERSION); } };
    document.body.appendChild(pill);
  }

  if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand(AE_NAME + ' settings', open);
  AE.openSettings = open;
  AE.openPatchNotes = openPatchNotes;
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
          '<td style="text-align:right">' + (matched.length ? matched.map((c) => chip(c, wo)).join('') : '<span class="miss">No cleanings</span>') + '</td></tr>'
        ).join('') + '</table>'
        : '<p class="sg-soft">No Asurion Mobility orders created today yet.</p>';
      const extra = last.unlinked.length
        ? '<p class="sg-soft" style="margin:10px 0 0">' + last.unlinked.length + " cleaning(s) today not linked to any of today's orders (not counted): " +
          last.unlinked.map(linkTo).join(', ') + '</p>'
        : '';
      const scroll = p.scrollTop;
      p.innerHTML =
        '<div style="display:flex;align-items:baseline;gap:8px"><b style="flex:1;font-size:16px">Today\'s cleaning rate: <span style="color:' + levelColor(last.pct) + '">' +
        (last.pct == null ? '—' : last.pct + '%') + '</span></b><button type="button" class="sg-btn" data-refresh>Refresh</button></div>' +
        '<div class="sg-soft" style="margin-top:4px">' + last.linked + ' cleanings' + (last.pending ? ' (' + last.pending + ' pending in Arrivals)' : '') +
        ' ÷ ' + last.parents + ' Asurion Mobility orders created today · target ' + TARGET +
        '%, ideally 100% · updated ' + fmtTime(last.at) + (lastError ? '<br><span class="miss">Last refresh failed: ' + esc(lastError) + '</span>' : '') + '</div>' +
        table + extra;
      p.scrollTop = scroll;
      p.querySelector('[data-refresh]').onclick = (e) => { e.stopPropagation(); refresh(); };
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
      finally {
        loading = false; renderBadge();
        if (document.getElementById(PANEL_ID)) renderPanel();
      }
    }

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
      pop.innerHTML = '<b style="font-size:16px">Cleanings for this device</b>' +
        '<div class="sg-soft" style="margin:2px 0 8px">Matched to this WO by device IMEI</div>' +
        (rows || '<p class="sg-soft">No cleanings found for this device (open, recently closed, or waiting in Arrivals).</p>');
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
      if (pop) pop.remove(); else renderPop();
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
  POST …/messages/v1/send shows up while a WO page is open, read that WO
  customer's message history (GET /api/messages/v1/customers/{id}, the same
  call the chat panel makes right after sending) and log each of *your*
  outbound messages from the last few minutes that isn't logged yet. Finding
  it in the history also confirms it actually went out. Never sends texts.

  Why not wrap fetch (v2.3.0/2.3.1): Portal's messaging code keeps its
  own reference to fetch from load time, before any userscript runs, so a
  wrapper never saw the send (confirmed on Zen with a HAR, Sep 26 2026).

  The note is a regular (noteType 2) note tagged with the WO's current
  status, using Portal's own status → tag map.
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
    const SEND_RE = /\/messages\/v1\/send(?:[?#]|$)/;
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
          if (n) AE.toast('Text logged', (n > 1 ? n + ' texts' : 'Text') + ' added to WO ' + m[1] + "'s notes.", 'ok', 4000);
        } catch (e) {
          AE.toast('Text sent, but not logged', "Couldn't add the WO note: " + (e.message || e) + ' — add it by hand.', 'err', 12000);
        } finally { busy = null; }
      })();
      return busy;
    }

    if (typeof PerformanceObserver === 'undefined') return;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (SEND_RE.test(e.name)) { onSend(); break; }
    }).observe({ type: 'resource', buffered: false });
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
    checkout    verify cart total is $0 → checkout/complete-order

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
      if (running || AE.status.blocked('autoClose')) return;
      running = true; stopRequested = false;
      const panel = AE.progressPanel('Swiftcast · cleaning auto-close');
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
        AE.emit('cleaning-changed', { arrivalId, woId }); // badge + WO pill refresh
      }
    }

    // Also callable from the cleaning-rate list and the WO cleanings pill.
    // Those are one step removed from the arrival itself, so they always ask
    // first; the drawer button (you're looking at the arrival) doesn't.
    AE.autoClose = {
      isRunning: () => running,
      async confirmAndRun({ arrivalId, programId, customerName }) {
        if (AE.status.blocked('autoClose')) return;
        if (running) { AE.confirm({ title: 'Already running', message: 'Another cleaning is being closed out — wait for it to finish.', confirmLabel: 'OK' }); return; }
        const ok = await AE.confirm({
          title: 'Create this cleaning?',
          message: '<b>' + AE.esc(customerName || 'Customer') + '</b> · ' + AE.esc(AE.CLEANING_PROGRAMS[programId] || 'Cleaning') +
            '<div class="sg-soft" style="margin-top:6px">Checks in arrival ' + arrivalId + ', walks it to Ready for pickup, and completes the $0 sale.</div>',
          warning: "Are you sure you'd like to create this cleaning? Only use this if you are the one who repaired this device!",
          confirmLabel: 'Yes, create cleaning',
        });
        if (ok) await onClick(arrivalId);
      },
    };

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
  Macrocosmos (Galaxy Diagnostics exception) — two halves sharing data through
  Tampermonkey storage (GM_*, scoped per script, not per site):

  A. Portal WO page: once a "GSPN No. ######" badge exists, shows a
     draggable, collapsible button. Click → gathers IMEI / device name /
     GSPN ticket / WO number from Portal API, plus the technician,
     email and store from the logged-in user (overridable in settings),
     and opens the Sprinklr form in a new tab.
  B. Sprinklr form: picks up that handoff and fills every field, including
     the Issue → Exception → Reason cascade. It does NOT submit.

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

      AE.every(1000, () => {
        const woId = currentWoId();
        const existing = document.getElementById('sg-galaxy-btn');
        if (!woId) { existing?.remove(); document.getElementById('sg-galaxy-intro')?.remove(); injectedForWoId = null; return; }
        const ticket = gspnTicketOnPage();
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

    function newUi() { return { panel: AE.progressPanel('Quick Synthesis · print all labels', { clock: false }), running: false, stop: false }; }

    async function onClickPrintAll() {
      if (AE.status.blocked('printLabels')) return;
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
    const PATH_RE = /^\/boh\/inventory\/buyback-order\//;
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
    };

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
      const heads = [...document.querySelectorAll('h1,h2,h3')]
        .filter((e) => /^\s*add\s+buyback\s+parts\s*$/i.test(e.textContent || ''))
        .filter(isVisible);
      const hd = heads[heads.length - 1];
      let n = hd;
      for (let i = 0; i < 12 && n; i++) { n = n.parentElement; if (n && n.querySelector('table')) return n; }
      return null;
    }
    const tabButtons = (modal, re) => [...modal.querySelectorAll('button,[role="tab"]')].filter((b) => re.test((b.innerText || '').trim()));
    // The Damaged tab has identical columns; the active tab is the only reliable tell.
    function buybacksTabActive(modal) {
      const tabs = tabButtons(modal, /^buybacks\s*\(\d+\)$/i);
      return tabs.length > 0 && tabs.some((b) => b.getAttribute('aria-selected') === 'true');
    }
    function getTable(modal) {
      if (!modal) return null;
      return [...modal.querySelectorAll('table')].find((t) => {
        const hs = [...t.querySelectorAll('thead th')].map((x) => (x.innerText || '').trim().toLowerCase());
        return hs.includes('serial number') && hs.includes('destination');
      }) || null;
    }
    const colIdx = (table, re) => [...table.querySelectorAll('thead th')].findIndex((th) => re.test((th.innerText || '').trim()));
    function getRows(table) {
      if (!table) return [];
      const si = colIdx(table, /serial\s*number/i), di = colIdx(table, /destination/i);
      if (si < 0 || di < 0) return [];
      return [...table.querySelectorAll('tbody tr')].map((tr) => {
        const c = tr.children;
        return { tr, serial: c[si] ? (c[si].innerText || '').trim() : '', dest: c[di] ? (c[di].innerText || '').trim() : '', btn: tr.querySelector('td:last-child button') };
      }).filter((r) => r.serial && r.btn && !r.btn.disabled);
    }
    const groupRows = (table, key) => getRows(table).filter((r) => GROUPS[key].test(r.dest));
    // The list empties for a moment while it refetches after every add —
    // never treat that as "finished" without giving it time to come back.
    const listRepopulated = (key) => waitUntil(() => { const t = getTable(getModal()); return t && groupRows(t, key).length > 0; }, REFRESH_MS);
    // If clicks stop registering, bouncing tabs re-renders the rows with fresh handlers. Read-only, bounded.
    async function recover(key) {
      const modal = getModal();
      if (!modal) return false;
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
      const mk = (key) => h('button', { type: 'button', class: 'sg sg-btn ' + GROUPS[key].variant, onclick: () => addAll(key) });
      const bar = h('div', { id: TOOLBAR_ID, class: 'sg' });
      bar._apple = mk('apple');
      bar._sg = mk('samsungGoogle');
      bar._stop = h('button', { type: 'button', class: 'sg sg-btn sg-danger', onclick: () => { state.cancel = true; setStatus('Stopping…'); } }, '■ Stop');
      bar._status = h('span', { class: 'status' });
      bar.append(bar._apple, bar._sg, bar._stop, bar._status);
      return bar;
    }
    function refreshToolbar() {
      const bar = document.getElementById(TOOLBAR_ID);
      if (!bar) return;
      const table = getTable(getModal());
      const a = table ? groupRows(table, 'apple').length : 0;
      const s = table ? groupRows(table, 'samsungGoogle').length : 0;
      const label = (key, n) => 'Add all ' + GROUPS[key].label + ' (' + GROUPS[key].hint + ') · <span class="count">' + n + '</span>';
      const setHtml = (el, html) => { if (el.innerHTML !== html) el.innerHTML = html; };
      setHtml(bar._apple, label('apple', a));
      setHtml(bar._sg, label('samsungGoogle', s));
      bar._apple.disabled = state.running || a === 0;
      bar._sg.disabled = state.running || s === 0;
      bar._stop.style.display = state.running ? '' : 'none';
      setHtml(bar._status, (state.running ? '<span class="sg-spin"></span>' : '') + AE.esc(state.status || ''));
    }
    const setStatus = (t) => { state.status = t; refreshToolbar(); };

    function anchorFor(modal, table) {
      const p = [...modal.querySelectorAll('p,div,span,h4')]
        .find((e) => e.children.length <= 2 && /^salvages\s*\(\d+\)/i.test((e.innerText || '').trim()));
      if (p && p.parentElement) return { parent: p.parentElement, next: p.nextSibling };
      let n = table;
      while (n.parentElement && n.parentElement !== modal) n = n.parentElement;
      return { parent: n.parentElement || modal, next: n };
    }

    function sync() {
      const existing = document.getElementById(TOOLBAR_ID);
      if (!PATH_RE.test(location.pathname)) { if (existing && !state.running) existing.remove(); return; }
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
            if (!(await listRepopulated(key))) { setStatus('Done — added ' + added + ' ' + g.label + '.'); break; }
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
  `;

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
    return root;
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
  const configured = () => /^(https:\/\/|http:\/\/localhost[:/])/.test(API); // localhost = a wrangler dev test build

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
    inflight = call('GET', '').then((j) => { cache = { list: j.list || [], tags: j.tags || {} }; cacheAt = Date.now(); AE.emit('waymark-changed', cache); return cache; })
      .finally(() => { inflight = null; });
    return inflight;
  }
  const tagsOf = (woId) => (cache && cache.tags[woId]) || [];

  async function setTag(woId, tag, on) {
    if (AE.status.blocked('waymark')) return null;
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

  // Report tagged WOs that are no longer open, so the Worker can clear them 7 days on.
  let lastClosedCheck = 0;
  async function reportClosed() {
    if (Date.now() - lastClosedCheck < 30 * 60 * 1000) return;
    lastClosedCheck = Date.now();
    const c = await load();
    const tagged = Object.keys(c.tags).map(Number);
    if (!tagged.length) return;
    const open = new Set((await AE.data.workorders(Date.now(), 0)).map((r) => Number(r.workorderId)));
    const closed = tagged.filter((id) => !open.has(id));
    if (closed.length) await call('POST', '/closed', { wos: closed });
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

  return { API, configured, load, tagsOf, listSig, setTag, history, saveList, canEdit, reportClosed, chip, when, fail, ensureCss, editor, summary, COLORS };
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
      const key = woId + '|' + JSON.stringify(W.tagsOf(woId)) + '|' + W.listSig(); // redraw when tags or colours change
      if (row && row.dataset.key === key && row.parentElement === anchor) return;
      row?.remove();
      row = h('span', { id: ROW_ID, 'data-key': key },
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
          hist.replaceChildren(...(items.length ? items.map((x) => h('li', null, (x.by || 'Someone') + (x.action === 'add' ? ' added ' : ' removed '), h('b', null, x.tag), ' ', h('span', { class: 'when' }, '· ' + W.when(x.at))))
            : [h('li', { class: 'sg-soft' }, 'No tag changes yet.')]));
        }).catch(() => hist.replaceChildren(h('li', { class: 'sg-soft' }, "Couldn't load history.")));
      }).catch((e) => { pop.replaceChildren(h('div', { class: 'sg-soft' }, "Couldn't load tags: " + (e.message || e))); });
    }
    document.addEventListener('click', (e) => {
      // composedPath: the clicked chip may already be redrawn (detached) by now.
      const pop = document.getElementById(POP_ID), path = e.composedPath();
      if (pop && !path.includes(pop) && !path.includes(document.getElementById(ROW_ID))) pop.remove();
    });

    // ---------------------------------------------------- header button + board
    function renderButton() {
      const anchor = [...document.querySelectorAll('button')].find((x) => x.offsetParent && x.textContent.trim() === 'UBIF support');
      let b = document.getElementById(BTN_ID);
      if (!anchor) { b?.remove(); return; }
      if (!b) b = h('button', { type: 'button', id: BTN_ID, class: 'sg', title: 'Waymark: work orders by tag', 'aria-label': 'Waymark board', html: AE.actionIcon('waymark', 26), onclick: (e) => { e.stopPropagation(); toggleBoard(); } });
      if (b.parentElement !== anchor.parentElement || b.nextSibling !== anchor) anchor.parentElement.insertBefore(b, anchor);
    }

    let boardFilter = null; // tag name, or null = all
    async function toggleBoard() {
      if (document.getElementById(BOARD_ID)) { document.getElementById(BOARD_ID).remove(); return; }
      const header = document.querySelector('.components-header');
      const board = h('div', { id: BOARD_ID, class: 'sg sg-card', role: 'dialog', 'aria-label': 'Waymark board',
        style: 'top:' + Math.round((header ? header.getBoundingClientRect().bottom : 64) + 8) + 'px' },
        h('div', { class: 'head' }, h('span', { html: AE.actionIcon('waymark', 26) }), h('b', null, 'Waymark'),
          h('button', { type: 'button', class: 'sg-x', title: 'Close', onclick: () => board.remove() }, '✕')),
        h('div', { class: 'list' }, h('div', { class: 'sg-soft' }, h('span', { class: 'sg-spin', style: 'display:inline-block;vertical-align:-3px;margin-right:6px' }), 'Loading open work orders…')));
      document.body.appendChild(board);
      try {
        const [c, wos] = await Promise.all([W.load(true), AE.data.workorders(Date.now(), 0)]);
        drawBoard(board, c, wos);
        W.reportClosed().catch(() => {});
      } catch (e) {
        board.querySelector('.list').replaceChildren(h('div', { class: 'sg-soft' }, "Couldn't load: " + (e.message || e)));
      }
    }
    function drawBoard(board, c, wos) {
      const byId = new Map(wos.map((r) => [String(r.workorderId), r]));
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
          h('div', { class: 'chips' }, ts.map((t) => W.chip(t.tag))));
      };
      const filterChip = (n) => {
        const el = W.chip(n, { label: n + ' (' + counts[n] + ')', cls: 'toggle' + (boardFilter && boardFilter !== n ? ' off' : ''), title: 'Show only ' + n });
        el.onclick = () => { boardFilter = boardFilter === n ? null : n; drawBoard(board, c, wos); };
        return el;
      };
      board.querySelector('.filters')?.remove();
      const filters = h('div', { class: 'filters' }, names.filter((n) => counts[n]).map(filterChip));
      board.querySelector('.head').after(filters);
      board.querySelector('.list').replaceChildren(...(shown.length ? shown.map((n) => {
        const rows = tagged.filter(([, ts]) => ts.some((t) => t.tag === n))
          .sort(([a], [b]) => Date.parse(byId.get(String(a)).createdAt) - Date.parse(byId.get(String(b)).createdAt));
        return h('div', { class: 'group' }, h('div', { class: 'gh' }, W.chip(n), rows.length + ' open'), rows.map(([id, ts]) => woRow(id, ts)));
      }) : [h('div', { class: 'sg-soft', style: 'padding:8px 0' }, c.list.length ? 'No open work orders are tagged yet. Open a work order and use + Tag.' : 'No tags yet. A manager can set up the store list in Settings → Waymark; anyone can add one-off tags from a work order.')]),
        h('div', { class: 'sg-soft', style: 'padding:6px 0 2px' }, ((n) => n + ' open work order' + (n === 1 ? ' has' : 's have') + ' no tags.')(wos.length - tagged.length)));
    }
    document.addEventListener('click', (e) => {
      const b = document.getElementById(BOARD_ID), path = e.composedPath();
      if (b && !path.includes(b) && !path.includes(document.getElementById(BTN_ID))) b.remove();
    });

    AE.on('waymark-changed', () => { renderRow(); });
    W.load().catch(() => {});
    AE.every(1000, () => {
      renderButton();
      if (currentWoId()) { W.load().then(renderRow).catch(() => {}); renderRow(); }
      else { document.getElementById(ROW_ID)?.remove(); document.getElementById(POP_ID)?.remove(); }
    });
    // Clears tags 7 days after close: tell the Worker which tagged WOs have closed.
    setTimeout(() => W.reportClosed().catch(() => {}), 20000);
    setInterval(() => W.reportClosed().catch(() => {}), 30 * 60 * 1000);
  },
});

AE.start();
})();
