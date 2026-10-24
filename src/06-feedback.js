/*
  Feedback + usage + admin.

  - "Send feedback" (avatar menu, Settings, Tampermonkey menu): a bug report
    or a suggestion, sent to the Aethernet API (same Worker as Waymark). Bug
    reports can include technical details: version, browser, the page's path,
    which shards are on, and the last few Aethernet errors. Never customer
    details. Submit-and-done; suggestions that get built are credited in the
    patch notes.
  - Usage: AE.track() counts (core) are sent here every 5 minutes, named per
    person, per store, per feature, per day. Disclosed in Settings and About.
  - Admin (Garrett): an inbox of reports with his own status/notes, and
    usage by feature, person and store, with drill-down (filter by store,
    person and shard; a people × shards table). No visible way in: ten quick clicks
    on the shard in the Settings header open it (asking for the key the
    first time). Reading needs the ADMIN_KEY secret, kept in this browser
    only; it never ships in the script, so other users can't read any of it
    even with the public app key.
  - Patch notes mention the feedback button and credits, never the admin
    panel or usage analytics (Garrett's call).
*/
AE.feedback = (() => {
  if (!AE_ON_PORTAL) return null;
  const { h, icon } = AE;
  const API = '__WAYMARK_API__';
  const KEY = '__WAYMARK_KEY__';
  const ADMIN_KEY_GM = 'ae_admin_key';
  // In the sandbox only a local Worker (wrangler dev): fake data never reaches the real one.
  const configured = () => (AE_SANDBOX ? /^http:\/\/localhost[:/]/.test(API) : /^(https:\/\/|http:\/\/localhost[:/])/.test(API));

  async function call(method, path, body, adminKey) {
    if (!configured()) throw new Error('The Aethernet service isn\'t set up');
    const headers = { 'content-type': 'application/json', 'x-aethernet-key': KEY };
    if (adminKey) headers['x-aethernet-admin'] = adminKey;
    return AE.workerCall(method, API + path, { headers, credentials: 'omit', keepalive: !!body && JSON.stringify(body).length < 60000, body: body ? JSON.stringify(body) : undefined });
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
  .sg-fb .ctx { margin:0 0 10px; padding:8px 10px; border-radius:10px; font-size:13px; overflow-wrap:anywhere;
    background:var(--aui-status-error-soft, #ffdad7); color:var(--aui-status-on-error-soft, #410004); }
  .sg-fb .ctx b { display:block; font-size:11px; letter-spacing:.04em; text-transform:uppercase; opacity:.8; }
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
  .sg-adm .arule { display:flex; gap:10px; align-items:flex-start; justify-content:space-between; border:1px solid var(--aui-outline-soft, #eeedf1); border-radius:12px; padding:10px 12px; margin-bottom:8px; }
  .sg-adm .astate { flex:none; font-size:11px; font-weight:700; padding:2px 8px; border-radius:10000rem; }
  .sg-adm .astate.live { background:var(--aui-status-success-soft, #c5ffc8); color:var(--aui-status-on-success-soft, #062011); }
  .sg-adm .astate.staged { background:var(--aui-status-warning-soft, #fff0c0); color:var(--aui-status-on-warning-soft, #3a3000); }
  .sg-adm .astate.off { background:var(--aui-neutral-soft, #f1f0f4); color:var(--aui-on-surface-soft, #5d5e61); }
  .sg-adm .astaged { border:1px dashed #b38f00; border-radius:12px; padding:10px 12px; margin:10px 0; background:color-mix(in srgb, #fff0c0 40%, transparent); }
  .sg-adm .astaged .r { display:flex; justify-content:space-between; gap:10px; font-size:13px; padding:3px 0; }
  .sg-adm .abtns { display:flex; gap:8px; margin-top:10px; }
  .sg-adm .qwrap { margin-top:6px; font-size:13px; }
  .sg-adm .qwrap .innotes { color:var(--aui-status-success, #136d31); font-weight:700; font-size:12px; margin-right:8px; }
  .sg-adm .quote-box summary { cursor:pointer; color:var(--aui-primary, #8223d2); font-weight:600; font-size:12px; display:inline; }
  .sg-adm .qform { margin-top:6px; display:flex; flex-direction:column; gap:6px; }
  .sg-adm .qform textarea { width:100%; box-sizing:border-box; padding:6px 8px; border:1px solid var(--aui-outline, #c6c6ca); border-radius:8px; font:inherit; font-size:13px;
    background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e); resize:vertical; }
  .sg-adm .qrow { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
  .sg-adm .qrow input { height:30px; padding:0 8px; border:1px solid var(--aui-outline, #c6c6ca); border-radius:8px; background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e); }
  .sg-adm .qrow .sg-btn { height:30px; font-size:13px; }
  .sg-adm .row.pick, .sg-adm .pick { cursor:pointer; }
  .sg-adm .row.pick:hover .name { color:var(--aui-primary, #8223d2); text-decoration:underline; }
  .sg-adm .card.wide { grid-column:1 / -1; }
  .sg-adm .fchip { display:inline-flex; align-items:center; gap:6px; height:28px; padding:0 6px 0 10px; border-radius:10000rem; cursor:pointer; font:inherit; font-size:12px; font-weight:600;
    border:0; background:var(--aui-primary-soft, #faecff); color:var(--aui-on-primary-soft, #590099); }
  .sg-adm .fchip b { display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; border-radius:50%; background:rgba(0,0,0,.08); font-size:12px; }
  .sg-adm .days { display:flex; align-items:flex-end; gap:2px; height:80px; }
  .sg-adm .days i { flex:1; min-width:2px; background:var(--aui-primary, #8223d2); border-radius:2px 2px 0 0; }
  .sg-adm .mx { overflow:auto; max-height:360px; }
  .sg-adm .mx table { border-collapse:collapse; font-size:13px; width:100%; }
  .sg-adm .mx th, .sg-adm .mx td { padding:4px 6px; border-bottom:1px solid var(--aui-outline-soft, #eeedf1); text-align:left; white-space:nowrap; }
  .sg-adm .mx th { position:sticky; top:0; background:var(--aui-surface, #fff); line-height:0; }
  .sg-adm .mx th:first-child { line-height:normal; font-size:12px; color:var(--aui-on-surface-soft, #5d5e61); }
  .sg-adm .mx th:not(:first-child) { text-align:center; width:44px; }
  .sg-adm .mx td.num { text-align:center; font-variant-numeric:tabular-nums; }
  .sg-adm .mx td.zero { color:var(--aui-outline, #c6c6ca); }
  .sg-adm .mx td.pick:hover { color:var(--aui-primary, #8223d2); text-decoration:underline; }
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
      // `crystals`: key kept, it's what saved bug reports store (legacy name for shards)
      crystals: Object.entries(AE.settings.crystals).filter(([, on]) => on).map(([id]) => id),
      errors: AE.recentErrors.slice(-5),
      pageErrors: AE.pageErrors.slice(-5), // Portal's own script errors
      screen: innerWidth + 'x' + innerHeight,
      theme: document.body.classList.contains('asurion-dark') ? 'dark' : 'light',
      scans: (AE.scanLog || []).slice(-10), // Master's Mend scan to open: the last few scans and what happened
      appcues: AE.appcuesSummary ? AE.appcuesSummary() : [], // Appcues boxes on the page (titles only): to write bulletin rules
    };
  }
  /*
    A "report a bug" link anywhere in Aethernet opens this as a bug report with what went wrong
    attached (opts.context: { where, error }), shown at the top and sent with the report
    (diag.context), even with the technical details switched off. Every bug report link should
    use AE.bugLink, so the error always travels with the report.
  */
  function openFeedback(opts = {}) {
    ensureCss();
    let kind = 'bug';
    const ctx = opts.context && (opts.context.error || opts.context.where)
      ? { where: String(opts.context.where || '').slice(0, 120), error: String(opts.context.error || '').slice(0, 600) } : null;
    const text = h('textarea', { maxlength: 4000, placeholder: 'What happened, and what did you expect? (Which work order or page, if it matters.)' });
    const include = h('input', { type: 'checkbox', checked: true });
    const setKind = (k) => {
      kind = k;
      card.querySelectorAll('.kinds button').forEach((b) => b.classList.toggle('on', b.dataset.k === k));
      text.placeholder = k === 'bug' ? 'What happened, and what did you expect? (Which work order or page, if it matters.)' : 'What would make Portal or Aethernet better for you?';
      detailsRow.style.display = k === 'bug' ? '' : 'none';
      if (ctxBox) ctxBox.style.display = k === 'bug' ? '' : 'none';
    };
    const ctxBox = ctx ? h('div', { class: 'ctx' }, h('b', null, 'Included with this report'), (ctx.where ? ctx.where + ': ' : '') + (ctx.error || '')) : null;
    const diag = () => (ctx ? { context: ctx, ...diagnostics() } : diagnostics());
    const preview = () => JSON.stringify({ version: AE_VERSION, browser: browserName(), page: location.pathname, ...diag() }, null, 1);
    const pre = h('pre', null, preview());
    const detailsRow = h('div', null,
      h('label', { class: 'chk' }, include, h('span', null, 'Include technical details (version, browser, this page\'s address, which shards are on, recent Aethernet errors). No customer details.')),
      h('details', null, h('summary', null, 'What gets sent'), pre));
    const send = h('button', { type: 'button', class: 'sg-btn sg-lg sg-primary', onclick: async () => {
      const t = text.value.trim();
      if (t.length < 3) { text.focus(); return; }
      send.disabled = true; send.textContent = 'Sending…';
      try {
        const p = await me();
        await call('POST', '/v1/' + p.storeId + '/feedback', {
          kind, text: t, version: AE_VERSION, browser: browserName(), page: location.pathname,
          diag: kind === 'bug' ? (include.checked ? diag() : ctx ? { context: ctx } : null) : null, by: p.name, byId: p.userId, storeName: p.storeName,
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
      ctxBox, text, detailsRow,
      h('div', { class: 'sg-soft', style: 'margin-top:8px' }, 'Sent with your name and store so the team can follow up in person.'),
      h('div', { class: 'sg-actions' }, h('button', { type: 'button', class: 'sg-btn sg-lg', onclick: () => close() }, 'Cancel'), send));
    const close = modal('sg-feedback', card);
    text.focus();
  }

  // ------------------------------------------------------------ Admin
  const FEATURE_NAMES = () => Object.fromEntries(AE.shards.map((c) => [c.id, c.name]));
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
        h('button', { type: 'button', class: 'tab' + (tab === 'stores' ? ' on' : ''), onclick: () => { tab = 'stores'; draw(); } }, 'Stores'),
        h('button', { type: 'button', class: 'tab' + (tab === 'auto' ? ' on' : ''), onclick: () => { tab = 'auto'; draw(); } }, 'Auto-Waymark'),
        h('button', { type: 'button', class: 'tab' + (tab === 'settings' ? ' on' : ''), onclick: () => { tab = 'settings'; draw(); } }, 'Settings'));
      body.replaceChildren(h('div', { class: 'sg-soft' }, 'Loading…'));
      try { tab === 'reports' ? await drawReports() : tab === 'usage' ? await drawUsage() : tab === 'stores' ? await drawStores() : tab === 'auto' ? await drawAuto() : await drawSettings(); }
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
        // Quote it in a version's patch notes (marks it fixed). The next public version by default.
        const nextVersion = AE_VERSION.split('.').slice(0, 3).join('.');
        // "G.Green"; names Portal stores in ALL CAPS come out in normal case.
        const title = (x) => (x === x.toUpperCase() ? x.toLowerCase().replace(/(^|[\s'-])\S/g, (m) => m.toUpperCase()) : x);
        const shortName = (n) => { const w = title(String(n || '').trim()).split(/\s+/); return w.length > 1 ? w[0][0].toUpperCase() + '.' + w[w.length - 1] : w[0] || ''; };
        const qText = h('textarea', { rows: 2, maxlength: 400, placeholder: 'The quote, as it should read in the patch notes' }, r.quote || String(r.text || '').trim().slice(0, 300));
        const qCredit = h('input', { type: 'text', maxlength: 60, value: r.credit || shortName(r.user_name), placeholder: 'Credit (e.g. G.Green)' });
        const qVer = h('input', { type: 'text', maxlength: 12, value: r.fixed_in || nextVersion, placeholder: '2.22.0', style: 'width:80px' });
        const inNotes = h('span', { class: 'innotes' }, r.fixed_in ? '✓ In v' + r.fixed_in + ' patch notes' : '');
        const quoteSave = async (out) => {
          try {
            const j2 = await call('POST', '/v1/admin/feedback/' + r.id, out ? { fixedIn: '' } : { fixedIn: qVer.value.trim(), quote: qText.value, credit: qCredit.value }, key());
            r.fixed_in = j2.fixedIn; r.status = j2.status; st.value = j2.status;
            inNotes.textContent = j2.fixedIn ? '✓ In v' + j2.fixedIn + ' patch notes' : '';
            AE.toast(out ? 'Taken out of the patch notes' : 'Quoted in v' + j2.fixedIn + ' patch notes', out ? '' : 'Marked fixed. It shows up in the notes with the next build.', 'ok');
          } catch (e) { AE.toast("Couldn't save", e.message || String(e), 'err'); }
        };
        const quoteBox = h('details', { class: 'quote-box' + (r.fixed_in ? ' on' : '') },
          h('summary', null, r.fixed_in ? 'Quoted in the patch notes' : 'Quote in patch notes…'),
          h('div', { class: 'qform' }, qText,
            h('div', { class: 'qrow' }, h('span', { class: 'sub' }, '—'), qCredit, h('span', { class: 'sub' }, 'at ' + (r.store_name || 'Store') + ' · fixed in v'), qVer,
              h('button', { type: 'button', class: 'sg-btn sg-primary', onclick: () => quoteSave(false) }, 'Quote & mark fixed'),
              h('button', { type: 'button', class: 'sg-btn', onclick: () => quoteSave(true) }, 'Take out'))));
        return h('div', { class: 'rep' },
          h('div', { class: 'top' }, h('span', { class: 'kind ' + r.kind }, r.kind === 'bug' ? 'Bug' : 'Idea'),
            h('span', { class: 'who' }, r.user_name || 'Someone'), h('span', { class: 'sub' }, (r.store_name || 'Store') + ' #' + r.store),
            h('span', { class: 'meta' }, when(r.created_at) + ' · v' + (r.version || '?') + ' · ' + (r.browser || '') + (r.page ? ' · ' + r.page : ''))),
          h('div', { class: 'txt' }, r.text),
          diag && diag.context ? h('div', { class: 'sub', style: 'color:var(--aui-status-error,#b91a24);margin:-2px 0 6px;overflow-wrap:anywhere' },
            'Sent from a bug link · ' + (diag.context.where ? diag.context.where + ': ' : '') + (diag.context.error || '')) : null,
          diag ? h('details', { class: 'sub' }, h('summary', null, 'Technical details' + (diag.errors && diag.errors.length ? ' · ' + diag.errors.length + ' recent error' + (diag.errors.length === 1 ? '' : 's') : '')),
            h('pre', { style: 'white-space:pre-wrap;font:11px ui-monospace,Menlo,monospace' }, JSON.stringify(diag, null, 1))) : null,
          h('div', { class: 'ctl' }, st, note, save), r.kind === 'bug' ? h('div', { class: 'qwrap' }, inNotes, quoteBox) : null);
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
    // Aethernet-wide settings: every store, from each install's next page load.
    async function drawSettings() {
      const j = await call('GET', '/v1/admin/config', null, key());
      const me = await AE.profile().catch(() => ({}));
      const target = h('input', { type: 'number', min: 1, max: 200, step: 1, value: j.config.cleaningTarget,
        style: 'width:80px;height:32px;padding:0 8px;border:1px solid var(--aui-outline,#c6c6ca);border-radius:8px;background:var(--aui-surface,#fff);color:var(--aui-on-surface,#1a1c1e)' });
      const save = h('button', { type: 'button', class: 'sg-btn sg-primary', onclick: async () => {
        save.disabled = true;
        try {
          const r = await call('POST', '/v1/admin/config', { cleaningTarget: Number(target.value), by: me.name }, key());
          target.value = r.config.cleaningTarget;
          AE.toast('Saved', 'Divination\'s target is now ' + r.config.cleaningTarget + '% for every store, from their next page load.', 'ok');
        } catch (e) { AE.toast("Couldn't save", e.message || String(e), 'err'); }
        save.disabled = false;
      } }, 'Save');
      body.replaceChildren(h('div', { class: 'card', style: 'max-width:520px' },
        h('h3', null, 'Divination'),
        h('div', { class: 'bar', style: 'margin:0' }, h('span', null, 'Target cleaning rate'), target, h('span', null, '%'), save),
        h('div', { class: 'sub' }, 'Colors the badge (below target: red; target to 99%: yellow; 100% or more: green) and sets the target line and "days at target" in the history. Applies to every store.')),
        AE.reassemble ? reassembleCard(j.config.reassemble, me) : null);
    }
    // Reassemble's pricing and who sees profit: every store, from each install's next page load.
    function reassembleCard(saved, me) {
      const D = AE.reassemble.DEFAULTS, base = saved || D;
      const v = (x, d) => (x == null ? d : x);
      const box = 'width:76px;height:30px;padding:0 6px;border:1px solid var(--aui-outline,#c6c6ca);border-radius:6px;background:var(--aui-surface,#fff);color:var(--aui-on-surface,#1a1c1e)';
      const num = (val, step = 0.01) => h('input', { type: 'number', min: 0, step, value: val, style: box });
      const row = (label, ...els) => h('div', { class: 'bar', style: 'margin:4px 0;gap:8px' }, h('span', { style: 'flex:1' }, label), ...els);
      const GROUPS = [['phone', 'Phone and wearable'], ['tablet', 'Tablet'], ['computer', 'Laptop / PC (non-Mac)'], ['console', 'Game console'], ['other', 'Other']];
      const bases = {}; for (const [g] of GROUPS) bases[g] = [num(v((base.bases || {})[g], D.bases[g])[0]), num(v((base.bases || {})[g], D.bases[g])[1])];
      const mLow = num(v((base.multipliers || {}).low, D.multipliers.low)), mHigh = num(v((base.multipliers || {}).high, D.multipliers.high));
      const macMin = num(v(base.macMin, D.macMin), 1), macMin24 = num(v(base.macMin2024, D.macMin2024), 1);
      const th = num(v((base.scale || {}).threshold, D.scale.threshold), 1), rate = num(Math.round(v((base.scale || {}).rate, D.scale.rate) * 100), 1);
      const addM = num(v((base.macAddons || {}).medium, D.macAddons.medium), 1), addH = num(v((base.macAddons || {}).hard, D.macAddons.hard), 1);
      const roy = num(Math.round(v(base.royalty, D.royalty) * 1000) / 10, 0.1);
      const viewers = h('textarea', { rows: 5, style: 'width:100%;font:inherit;padding:8px;border:1px solid var(--aui-outline,#c6c6ca);border-radius:8px;background:var(--aui-surface,#fff);color:var(--aui-on-surface,#1a1c1e)' },
        (base.profitViewers || D.profitViewers).join('\n'));
      const n = (el) => Number(el.value);
      const collect = () => ({
        bases: Object.fromEntries(GROUPS.map(([g]) => [g, [n(bases[g][0]), n(bases[g][1])]])), multipliers: { low: n(mLow), high: n(mHigh) },
        macMin: n(macMin), macMin2024: n(macMin24), scale: { threshold: n(th), rate: n(rate) / 100 }, macAddons: { medium: n(addM), hard: n(addH) }, royalty: n(roy) / 100,
        profitViewers: viewers.value.split('\n').map((x) => x.trim()).filter(Boolean) });
      const post = async (val, msg) => {
        try {
          const r = await call('POST', '/v1/admin/config', { reassemble: val, by: me.name }, key());
          GM_setValue(AE.CONFIG_KEY, r.config); // this browser at once; other installs on their next page load
          AE.toast('Saved', msg, 'ok'); drawSettings();
        } catch (e) { AE.toast("Couldn't save", e.message || String(e), 'err'); }
      };
      return h('div', { class: 'card', style: 'max-width:520px;margin-top:14px' },
        h('h3', { style: 'display:flex;align-items:center;gap:8px' }, h('span', { html: AE.actionIcon('reassemble', 22), style: 'line-height:0' }), 'Reassemble'),
        h('div', { class: 'sub' }, saved ? 'Custom pricing, saved for every store.' : "The owner's pricing (the defaults). Change a number and save to set it for every store."),
        h('h4', null, 'Everything but MacBooks'),
        h('div', { class: 'sub', style: 'margin-top:0' }, 'Easy = low multiplier × part + low base; Hard = high multiplier × part + high base; Medium is halfway. Rounded up to .99.'),
        row('Multipliers (low / high)', mLow, mHigh),
        ...GROUPS.map(([g, l]) => row(l + ' base (low / high) $', bases[g][0], bases[g][1])),
        h('h4', null, 'MacBooks'),
        row('Minimum profit, 2023 and older $', macMin), row('Minimum profit, 2024 and newer $', macMin24),
        row('Plus this % of the part cost…', rate), row('…above this part cost $', th),
        row('Medium adds $', addM), row('Hard adds $', addH),
        h('h4', null, 'All devices'),
        row('Royalty %', roy),
        h('h4', null, 'Who sees profit'),
        h('div', { class: 'sub', style: 'margin-top:0' }, "One Portal name or email per line. Everyone else sees prices only."),
        viewers,
        h('div', { class: 'bar', style: 'margin-top:10px;gap:8px' },
          h('button', { type: 'button', class: 'sg-btn sg-primary', onclick: () => post(collect(), 'Reassemble\'s pricing is saved for every store, from their next page load.') }, 'Save'),
          saved ? h('button', { type: 'button', class: 'sg-btn', onclick: () => post(null, 'Reassemble is back on the owner\'s pricing.') }, "Back to the owner's pricing") : null));
    }

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

    /*
      Auto-Waymark rules. Ready for pickup is always live. Newer rules ship "off":
      Stage turns them on for work orders that newly enter the status (and shows
      what Push would add here); Push makes them live for every store, whose next
      scan backfills work orders already waiting.
    */
    const RULE_TEXT = {
      rfp: 'Follow up 3 days after · added after 7 PM · nickname mirrors the date · texting the customer → 3 days from then · push options start at +3 days',
      callback: 'Contact every day: Awaiting callback and Awaiting device · added after 7 PM, due the next day · nickname keeps its text, date replaced or added · texting the customer → tomorrow · push options start at +1 day',
    };
    async function drawAuto() {
      const W = AE.waymark;
      if (!W || !W.configured()) { body.replaceChildren(h('div', { class: 'sub' }, 'Waymark isn\'t set up in this build.')); return; }
      const j = await call('GET', '/v1/admin/auto-rules', null, key());
      const st = Object.fromEntries(j.rules.map((r) => [r.rule, r]));
      const stateOf = (k) => (k === 'rfp' ? 'live' : (st[k] && st[k].state) || 'off');
      const LABEL = { live: 'Live', staged: 'Staged', off: 'Off' };
      const rules = Object.entries(W.RULES).map(([k, r]) => h('div', { class: 'arule' },
        h('div', null, h('b', null, r.name), h('div', { class: 'sub' }, RULE_TEXT[k] || '')),
        h('span', { class: 'astate ' + stateOf(k) }, LABEL[stateOf(k)])));
      const later = Object.keys(W.RULES).filter((k) => k !== 'rfp');
      const toStage = later.filter((k) => stateOf(k) === 'off'), toPush = later.filter((k) => stateOf(k) === 'staged');
      const set = async (ks, state) => { for (const k of ks) await call('POST', '/v1/admin/auto-rules', { rule: k, state }, key()); };
      const stageBtn = h('button', { type: 'button', class: 'sg-btn', disabled: !toStage.length, onclick: async () => {
        stageBtn.disabled = true;
        try { await set(toStage, 'staged'); await W.load(true); AE.toast('Auto-Waymark', 'Staged: ' + toStage.map((k) => W.RULES[k].name).join(', ') + '. Work orders that newly enter the status get marks now.', 'ok'); draw(); }
        catch (e) { stageBtn.disabled = false; AE.toast('Auto-Waymark', { html: "Couldn't stage the rules. If you keep seeing this, " + AE.bugLink('report a bug', { where: 'Admin: Auto-Waymark', error: 'Stage: ' + (e.message || e) }) + '!' }, 'err'); }
      } }, 'Stage rule changes');
      const pushBtn = h('button', { type: 'button', class: 'sg-btn sg-primary', disabled: !toPush.length, onclick: async () => {
        pushBtn.disabled = true;
        try {
          await set(toPush, 'live'); await W.load(true);
          const plan = await W.scan(null, { force: true }); // backfill this store now; other stores on their next scan
          AE.toast('Auto-Waymark', 'Live for every store. ' + ((plan && plan.create.length) || 0) + (((plan && plan.create.length) || 0) === 1 ? ' work order' : ' work orders') + ' here got marks.', 'ok');
          draw();
        } catch (e) { pushBtn.disabled = false; AE.toast('Auto-Waymark', { html: "Couldn't push the staged rules. If you keep seeing this, " + AE.bugLink('report a bug', { where: 'Admin: Auto-Waymark', error: 'Push: ' + (e.message || e) }) + '!' }, 'err'); }
      } }, 'Push staged changes');
      let preview = null;
      if (toPush.length || toStage.length) {
        const p = await W.backfillPreview().catch((e) => { throw new Error('preview: ' + (e.message || e)); });
        const store = (await AE.profile()).storeName || 'this store';
        preview = h('div', { class: 'astaged' },
          h('b', null, (toPush.length ? 'Staged' : 'If you stage and push') + ': what pushing adds at ' + store),
          ...(p.length ? p.map((x) => h('div', { class: 'r' }, h('span', null, x.wo + ' · ' + (x.name || 'Customer')),
            h('span', { class: 'sub' }, W.RULES[x.kind].name + ' since ' + x.since + ' → due ' + (x.due === new Date().toISOString().slice(0, 10) ? 'today' : x.due))))
            : [h('div', { class: 'sub' }, 'Nothing here right now.')]),
          h('div', { class: 'sub', style: 'margin-top:6px' }, p.length + ' work order' + (p.length === 1 ? '' : 's') + ' here. Every other store gets the same on its next scan after you push.'));
      }
      body.replaceChildren(...rules, preview, h('div', { class: 'abtns' }, stageBtn, pushBtn),
        h('div', { class: 'sub', style: 'margin-top:8px' }, 'Off: no marks. Staged: only work orders that newly enter the status. Live: all of them, everywhere.'));
    }

    /*
      Usage, with drill-down: filter by store, person and shard (menus at the
      top, or click a store / person / shard in any card; chips show what's
      filtered and clear it). Every card follows the filters. The rows are
      fetched once per date range (the Worker sends them raw: day, store,
      person, feature, count) and filtered here.
    */
    let usage = null, uStore = '', uUser = '', uShard = '';
    async function drawUsage() {
      if (!usage || usage.days !== days) usage = Object.assign(await call('GET', '/v1/admin/usage?days=' + days, null, key()), { days });
      const all = usage.rows;
      const shardOf = (r) => r.feature.split(':')[0];
      const storeLabel = new Map(all.map((r) => [String(r.store), (r.store_name ? r.store_name + ' ' : '') + '#' + r.store]));
      const personLabel = new Map(all.map((r) => [String(r.user_id), r.user_name || 'User ' + r.user_id]));
      const personStore = new Map(all.map((r) => [String(r.user_id), storeLabel.get(String(r.store))]));
      // A filter that no longer has data (e.g. after changing the range) is dropped.
      if (uStore && !storeLabel.has(uStore)) uStore = '';
      if (uUser && !personLabel.has(uUser)) uUser = '';
      const inScope = (r) => (!uStore || String(r.store) === uStore) && (!uUser || String(r.user_id) === uUser);
      const scoped = all.filter(inScope);
      const active = scoped.filter((r) => r.feature === 'active');
      const rows = scoped.filter((r) => !r.feature.startsWith('active') && (!uShard || shardOf(r) === uShard));
      const sum = (arr, keyFn) => { const m = new Map(); for (const r of arr) { const k = String(keyFn(r)); m.set(k, (m.get(k) || 0) + r.count); } return [...m.entries()].sort((x, y) => y[1] - x[1]); };
      const set = (what, v) => () => { if (what === 'store') { uStore = v; uUser = ''; } else if (what === 'user') uUser = v; else uShard = v; draw(); };

      const bars = (entries, label, opts = {}) => {
        const max = Math.max(1, ...entries.map((e) => e[1]));
        return entries.slice(0, opts.limit || 12).map(([k, n]) => h('div', { class: 'row' + (opts.pick ? ' pick' : ''), title: opts.pick ? 'Show only this' : null, onclick: opts.pick ? set(opts.pick, k) : null },
          h('div', { class: 'name' }, opts.icon ? h('span', { html: AE.actionIcon(k, 18) }) : null, label(k)),
          h('div', { class: 'track' }, h('i', { style: 'width:' + Math.round((n / max) * 100) + '%' })), h('div', { class: 'n' }, n)));
      };
      const select = (value, onchange, first, entries) => {
        const el = h('select', { onchange: (e) => onchange(e.target.value) }, h('option', { value: '' }, first),
          ...entries.map(([v, l]) => { const o = h('option', { value: v }, l); o.selected = v === value; return o; }));
        return el;
      };
      const daysSel = select(String(days), (v) => { days = Number(v) || 30; draw(); }, 'Range', [7, 30, 90, 180, 365].map((d) => [String(d), 'Last ' + d + ' days']));
      daysSel.options[0].disabled = true;
      const storeSel = select(uStore, (v) => set('store', v)(), 'All stores', [...storeLabel].sort((x, y) => x[1].localeCompare(y[1])));
      const userSel = select(uUser, (v) => set('user', v)(), 'Everyone', [...personLabel].filter(([id]) => !uStore || all.some((r) => String(r.user_id) === id && String(r.store) === uStore))
        .sort((x, y) => x[1].localeCompare(y[1])).map(([id, n]) => [id, uStore ? n : n + ' · ' + personStore.get(id)]));
      const shardIds = [...new Set(all.filter((r) => !r.feature.startsWith('active')).map(shardOf))];
      const shardSel = select(uShard, (v) => set('shard', v)(), 'All shards', shardIds.map((f) => [f, featureLabel(f)]).sort((x, y) => x[1].localeCompare(y[1])));
      const chip = (label, clear) => h('button', { type: 'button', class: 'fchip', title: 'Clear', onclick: clear }, label, h('b', null, '×'));
      const chips = [uStore && chip(storeLabel.get(uStore), set('store', '')), uUser && chip(personLabel.get(uUser), set('user', '')), uShard && chip(featureLabel(uShard), set('shard', ''))].filter(Boolean);

      const cardEl = (title, wide, ...kids) => h('div', { class: 'card' + (wide ? ' wide' : '') }, h('h3', null, title), ...kids);
      const empty = (x) => (x.length ? x : [h('div', { class: 'sub' }, 'No data for this filter.')]);
      const people = new Set(active.map((r) => String(r.user_id)));
      const scope = [uUser ? personLabel.get(uUser) : uStore ? storeLabel.get(uStore) : 'Everyone', uShard ? featureLabel(uShard) : null].filter(Boolean).join(' · ');

      // Per day: uses (bar) for the current filter.
      const perDay = new Map(sum(rows, (r) => r.day));
      const dayKeys = []; for (let d = new Date(usage.since + 'T00:00:00'); d <= new Date(); d.setDate(d.getDate() + 1)) dayKeys.push(d.toISOString().slice(0, 10));
      const topDay = Math.max(1, ...dayKeys.map((k) => perDay.get(k) || 0));
      const chart = h('div', { class: 'days' }, ...dayKeys.map((k) => h('i', { title: new Date(k + 'T00:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ': ' + (perDay.get(k) || 0),
        style: 'height:' + Math.max(2, Math.round(((perDay.get(k) || 0) / topDay) * 100)) + '%' + (perDay.get(k) ? '' : ';opacity:.25') })));

      // Who uses what: people × shards (counts), for the current store/person filter.
      const matrixRows = scoped.filter((r) => !r.feature.startsWith('active'));
      const cols = sum(uShard ? matrixRows.filter((r) => shardOf(r) === uShard) : matrixRows, shardOf).map(([f]) => f);
      const cell = new Map(); for (const r of matrixRows) { const k = r.user_id + '|' + shardOf(r); cell.set(k, (cell.get(k) || 0) + r.count); }
      const ppl = sum(uShard ? matrixRows.filter((r) => shardOf(r) === uShard) : matrixRows, (r) => r.user_id).map(([id]) => id);
      const matrix = cols.length ? h('div', { class: 'mx' }, h('table', null,
        h('tr', null, h('th', null, 'Person'), ...cols.map((f) => h('th', { title: featureLabel(f) + ' — show only this', onclick: set('shard', f), class: 'pick' }, h('span', { html: AE.actionIcon(f, 18) })))),
        ...ppl.slice(0, 60).map((id) => h('tr', null,
          h('td', { class: 'pick', title: 'Show only this person', onclick: set('user', id) }, personLabel.get(id), h('span', { class: 'sub' }, uStore ? '' : ' · ' + personStore.get(id))),
          ...cols.map((f) => { const n = cell.get(id + '|' + f) || 0; return h('td', { class: 'num' + (n ? '' : ' zero') }, n || '·'); }))))) : null;

      body.replaceChildren(
        h('div', { class: 'bar' }, daysSel, storeSel, userSel, shardSel, ...chips),
        h('div', { class: 'sub', style: 'margin:-4px 0 10px' }, scope + ': ' + people.size + (people.size === 1 ? ' person' : ' people') + ' active, ' +
          rows.reduce((n, r) => n + r.count, 0) + ' uses since ' + usage.since + '. Click a store, person or shard to drill in.'),
        h('div', { class: 'grid' },
          cardEl('Uses per day', true, chart),
          uShard ? null : cardEl('By shard', false, ...empty(bars(sum(rows, shardOf), featureLabel, { pick: 'shard', icon: true, limit: 20 }))),
          cardEl(uShard ? featureLabel(uShard) + ': by action' : 'By action', false, ...empty(bars(sum(rows, (r) => r.feature), featureLabel, { limit: 20 }))),
          uUser ? null : cardEl('By person', false, ...empty(bars(sum(rows, (r) => r.user_id), (k) => personLabel.get(k) + (uStore ? '' : ' · ' + personStore.get(k)), { pick: 'user', limit: 20 }))),
          uUser ? null : cardEl('Days active', false, ...empty(bars(sum(active, (r) => r.user_id), (k) => personLabel.get(k), { pick: 'user', limit: 20 })), h('div', { class: 'sub', style: 'margin-top:6px' }, 'Days each person had Portal open with ' + AE_NAME + '.')),
          uStore || uUser ? null : cardEl('By store', false, ...empty(bars(sum(rows, (r) => r.store), (k) => storeLabel.get(k), { pick: 'store' }))),
          matrix ? cardEl('Who uses what', true, matrix, h('div', { class: 'sub', style: 'margin-top:6px' }, 'Uses per person and shard. Click a name or an icon to drill in.')) : null));
    }
    draw();
  }

  // ------------------------------------------------------------ entry points
  // Avatar menu: "Send Aethernet feedback", cloned like the Settings item.
  function menuItem() {
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
  }
  AE.every(400, menuItem);
  AE.onDom(menuItem); // right after Settings' item, same frame (Settings registers first)
  if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('Send ' + AE_NAME + ' feedback', openFeedback);
  AE.trackDaily('active');

  // Bug report links: a link that opens Send feedback as a bug report with the error attached.
  // AE.bugLink(label, context) gives HTML (for innerHTML); AE.bugLinkEl the same as an element.
  // context: { where: 'Divination', error: 'Manual links couldn't be loaded: HTTP 500' }.
  const bugAttr = (context) => AE.esc(JSON.stringify(context || {}));
  AE.bugLink = (label, context) => '<a href="#" class="sg-bug-link" data-ae-bug="' + bugAttr(context) + '">' + AE.esc(label) + '</a>';
  AE.bugLinkEl = (label, context) => h('a', { href: '#', class: 'sg-bug-link', 'data-ae-bug': JSON.stringify(context || {}) }, label);
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('[data-ae-bug]');
    if (!a) return;
    e.preventDefault(); e.stopPropagation();
    let context = null;
    try { context = JSON.parse(a.dataset.aeBug); } catch (_) {}
    AE.track('feedback:bugLink');
    openFeedback({ context });
  }, true);

  return { openFeedback, openAdmin, flushUsage };
})();
