/*
  Status — live word from the Aethernet team, without waiting for a release.

  Reads status.json from the same Gist as the script (plain fetch: the Gist
  sends Access-Control-Allow-Origin: *, so no new Tampermonkey permission):

    {
      "latest":   { "version": "2.11.0", "date": "…" },        // set by build.py --release
      "incident": {                                          // set by build.py --status …
        "id", "severity": "info|warning|error", "title", "message",
        "crystals": ["cleaningRate"],   // which crystals it's about (badges in Settings; a crystal's name in
                                        // the title becomes its icon + a link to its Settings)
        "tag": "…",                     // (2.21.0) the badge's text on those crystals' rows (default "Known issue")
        "mentions": ["fixes"],          // (2.22.0+) named in the title (icon + link to Settings), no badge
        "chips": [{ "id": "fixes", "text": "Fix in a newer version", "below": "2.22.0" }],
                                        // (2.22.0+) badges on crystals' Settings rows; `below`: only on
                                        // installs older than that version (the fixed one never shows it)
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
        tag: text(i.tag, 40),
        mentions: ids(i.mentions),
        chips: (Array.isArray(i.chips) ? i.chips : []).filter((c) => c && ids([c.id]).length).slice(0, 12)
          .map((c) => ({ id: c.id, text: text(c.text, 40) || 'Known issue', below: VER_RE.test(c.below || '') ? c.below : null })),
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
  // The badge for a crystal's Settings row, if any: paused, a (version-gated) chip, or "Known issue" for a crystal it's about.
  function chipFor(id) {
    const inc = incident();
    if (!inc) return null;
    if (inc.pause.includes(id)) return { text: 'Paused', kind: 'paused', title: inc.title };
    const c = inc.chips.find((x) => x.id === id);
    if (c) return !c.below || newer(c.below, AE_VERSION) ? { text: c.text, kind: inc.severity, title: inc.title } : null;
    if (inc.crystals.includes(id)) return { text: inc.tag || 'Known issue', kind: inc.severity, title: inc.title };
    return null;
  }
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
  #sg-status-banner .crys { display:inline-flex; align-items:center; gap:4px; color:inherit; text-decoration:underline; text-underline-offset:2px; vertical-align:-3px; }
  #sg-status-banner .crys .sg-aicon { width:18px; height:18px; }
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

  // The title, with each named crystal's name turned into its icon + a link to its Settings
  // (built as elements: the notice text stays plain text). Crystals not named get their icon up front.
  function titleParts(inc) {
    let parts = [inc.title];
    const lead = [];
    for (const id of [...new Set([...inc.crystals, ...inc.mentions])]) {
      const name = crystalName(id);
      let hit = false;
      parts = parts.flatMap((p) => {
        if (typeof p !== 'string' || !name || !p.includes(name)) return [p];
        hit = true;
        const i = p.indexOf(name);
        return [p.slice(0, i), h('a', { href: '#', class: 'crys', title: 'Open ' + name + ' in Settings', onclick: (e) => { e.preventDefault(); AE.openSettings(id); } },
          h('span', { html: AE.actionIcon(id, 18) }), name), p.slice(i + name.length)];
      });
      if (!hit && inc.crystals.includes(id)) lead.push(h('span', { title: name, html: AE.actionIcon(id, 18) }));
    }
    return [...lead, h('span', null, ...parts.filter((p) => p !== ''))];
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
        h('div', { class: 'title' }, h('span', { class: 'who' }, AE_NAME + ' notice'), ...titleParts(inc)),
        inc.message ? h('div', { class: 'msg' }, inc.message) : null,
        pausedNames.length ? h('div', { class: 'extra' }, 'Paused until it\'s fixed: ' + pausedNames.join(', ') + '.') : null,
        inc.fixedIn ? h('div', { class: 'extra' }, 'Fixed in v' + inc.fixedIn + '. You have v' + AE_VERSION + '.') : null,
        h('div', { class: 'acts' },
          inc.fixedIn && upd ? h('button', { type: 'button', class: 'sg-btn', onclick: () => startUpdate(upd) }, 'Update now') : null,
          inc.crystals.length || inc.mentions.length ? h('button', { type: 'button', class: 'sg-btn', onclick: () => AE.openSettings(inc.crystals[0] || inc.mentions[0]) }, 'Open in Settings') : null)),
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

  return { get: () => state, incident, paused, chipFor, blocked, refresh, checkNow, startUpdate, updateAvailable, newer, simulate, url: STATUS_URL };
})();
