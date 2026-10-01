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
  const API = '__WAYMARK_API__';
  const KEY = '__WAYMARK_KEY__';
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
