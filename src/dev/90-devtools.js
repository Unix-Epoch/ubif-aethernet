/*
  Dev tools — only in dev builds ("Aethernet (dev)"); build.py leaves src/dev/
  out of public builds.

  Every popup and automatic feature, on demand, instead of waiting for the
  conditions that normally trigger it: update pills, notices, the New sheen,
  the Macrocosmos explainer, Waymark's badge and morning bubble, the
  Auto-Waymark scan (dry run, or for real), a shifted clock for the 7 PM and
  morning rules, and demo panels/toasts.

  Simulations only change what this browser shows. Two exceptions write to
  Portal and are labelled that way: "Run the scan for real" and the real
  morning check (which only reads).
*/
(function devTools() {
  if (!AE_ON_PORTAL || !AE_DEV) return;
  const { h, icon } = AE;
  const CLOCK_KEY = 'ae_dev_clock_offset';

  const CSS = `
  #sg-dev-tab { position:fixed; z-index:2147483645; left:0; top:45%; padding:10px 5px; border:0; border-radius:0 8px 8px 0; cursor:pointer;
    background:#e0761a; color:#fff; font:800 11px/1 Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; letter-spacing:.12em; writing-mode:vertical-rl;
    box-shadow:0 4px 14px rgba(12,14,17,.25); }
  #sg-dev-tab.shifted { background:#b91a24; }
  .sg-dev { width:min(760px, 100%); max-height:calc(100vh - 32px); display:flex; flex-direction:column; padding:18px 20px 14px; font-size:14px; line-height:1.4; }
  .sg-dev .head { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
  .sg-dev .head h2 { flex:1; margin:0; font-size:20px; font-weight:700; }
  .sg-dev .tag { padding:2px 8px; border-radius:10000rem; background:#e0761a; color:#fff; font-size:11px; font-weight:800; letter-spacing:.08em; }
  .sg-dev .scroll { overflow:auto; padding-right:4px; }
  .sg-dev section { border-top:1px solid var(--aui-outline-soft, #eeedf1); padding:10px 0; }
  .sg-dev h3 { margin:0 0 8px; font-size:12px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--aui-on-surface-soft, #5d5e61); }
  .sg-dev .btns { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
  .sg-dev .btns .sg-btn { height:30px; padding:0 12px; font-size:13px; }
  .sg-dev .btns .sg-btn.write { border-color:var(--aui-status-error, #b91a24); color:var(--aui-status-error, #b91a24); }
  .sg-dev input, .sg-dev select { height:30px; border:1px solid var(--aui-outline, #c6c6ca); border-radius:8px; padding:0 8px;
    background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e); font:13px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; color-scheme:light dark; }
  .sg-dev input[type=number] { width:64px; }
  .sg-dev .note { font-size:12px; color:var(--aui-on-surface-soft, #5d5e61); margin-top:6px; }
  .sg-dev .out { margin-top:8px; font-size:13px; }
  .sg-dev table { width:100%; border-collapse:collapse; margin:4px 0 8px; font-size:12px; }
  .sg-dev th { text-align:left; font-weight:700; color:var(--aui-on-surface-soft, #5d5e61); padding:3px 6px; }
  .sg-dev td { padding:3px 6px; border-top:1px solid var(--aui-outline-soft, #eeedf1); }
  .sg-dev td a { color:var(--aui-primary, #8223d2); }
  `;
  const ensureCss = () => { AE.ensureCss(); if (!document.getElementById('sg-dev-css')) document.head.append(h('style', { id: 'sg-dev-css' }, CSS)); };

  const shifted = () => Number(GM_getValue(CLOCK_KEY, 0)) !== 0;
  const localInput = (d) => { const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()); };
  const nextVersion = (v) => { const x = v.split('.').map(Number); x[x.length - 1] += 1; return x.join('.'); };
  const minsAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

  // ------------------------------------------------------------ the DEV tab + two-copies warning
  function renderTab() {
    ensureCss();
    let t = document.getElementById('sg-dev-tab');
    if (!t) { t = h('button', { id: 'sg-dev-tab', class: 'sg', type: 'button', onclick: open }); document.body.appendChild(t); }
    const s = shifted();
    t.classList.toggle('shifted', s);
    t.textContent = s ? 'DEV · CLOCK' : 'DEV';
    t.title = AE_NAME + ' v' + AE_VERSION + ' — dev tools' + (s ? ' (clock shifted to ' + AE.nowDate().toLocaleString() + ')' : '');
  }
  AE.every(2000, renderTab);
  setTimeout(() => {
    const running = (document.documentElement.dataset.aethernet || '').split(' ');
    if (running.includes('public') && running.includes('dev')) {
      AE.toast('Two copies of Aethernet are running', 'Turn off the public "Aethernet" in Tampermonkey while testing the dev build, or everything shows twice.', 'err', 15000);
    }
  }, 3000);
  if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand(AE_NAME + ' dev tools', open);

  // ------------------------------------------------------------ the panel
  function open() {
    ensureCss();
    document.getElementById('sg-dev')?.remove();
    const btn = (label, fn, opts = {}) => h('button', { type: 'button', class: 'sg-btn' + (opts.write ? ' write' : ''), title: opts.title || null,
      onclick: async () => { try { if (opts.close) close(); await fn(); } catch (e) { AE.toast('Dev tools', (e && e.message) || String(e), 'err'); } } }, label);
    const section = (title, ...kids) => h('section', null, h('h3', null, title), ...kids);
    const row = (...kids) => h('div', { class: 'btns' }, ...kids);
    const note = (t) => h('div', { class: 'note' }, t);
    const out = h('div', { class: 'out' });
    const S = AE.status;

    // Updates
    const versions = (AE.hooks.patchVersions || []);
    const fromSel = h('select', { 'aria-label': 'Updated from' }, versions.slice(1).map((v) => h('option', { value: v }, 'from v' + v)));
    const updates = section('Updates',
      row(btn('"Has updated!" pill', () => AE.hooks.updatedPill(fromSel.value || null)), fromSel,
        btn('Patch notes after that update', () => AE.openPatchNotes(fromSel.value || AE_VERSION), { close: true })),
      row(btn('"Update available" pill', () => { document.getElementById('sg-update-pill')?.remove(); S.simulate({ latest: { version: nextVersion(AE_VERSION), date: minsAgo(60) } }); }),
        btn('Check for updates: newer out', () => { S.simulate({ latest: { version: nextVersion(AE_VERSION), date: minsAgo(60) } }); return S.checkNow({ noFetch: true }); }, { close: true }),
        btn('Check for updates: rolling out', () => { S.simulate({ latest: { version: nextVersion(AE_VERSION), date: minsAgo(1) } }); return S.checkNow({ noFetch: true }); }, { close: true }),
        btn('Check for updates: up to date', () => { S.simulate({ latest: { version: AE_VERSION, date: minsAgo(60) } }); return S.checkNow({ noFetch: true }); }, { close: true })),
      note('Simulated states only change this browser; "Back to real status" (below) or the next 10-minute check restores the real one.'));

    // Notices
    const sample = (severity, extra = {}) => ({ latest: S.get().latest, incident: Object.assign({
      id: 'dev-' + severity + '-' + Date.now(), severity,
      title: { info: 'Heads up: Portal maintenance tonight', warning: 'Divination is showing the wrong rate', error: 'DO NOT RFP OR SALE COMPLETE WOs UNTIL FURTHER NOTICE.' }[severity],
      message: { info: 'Portal may be slow between 9 and 10 PM.', warning: "Pending cleanings are double-counted. We're on it.", error: 'All WOs will remove parts and get stuck in limbo if you attempt to Sale Complete.' }[severity],
      crystals: severity === 'warning' ? ['cleaningRate'] : [], pause: [], fixedIn: null, updated: new Date().toISOString() }, extra) });
    const notices = section('Notices (simulated)',
      row(btn('Info', () => S.simulate(sample('info'))), btn('Warning', () => S.simulate(sample('warning'))), btn('Error', () => S.simulate(sample('error'))),
        btn('Warning + Swiftcast paused', () => S.simulate(sample('warning', { pause: ['autoClose'] }))),
        btn('Fixed in a newer version', () => S.simulate(Object.assign(sample('error', { fixedIn: nextVersion(AE_VERSION) }), { latest: { version: nextVersion(AE_VERSION), date: minsAgo(60) } })))),
      row(btn('Back to real status', () => S.refresh(true).then(() => AE.toast('Dev tools', 'Real status.json loaded.', 'ok')))),
      note('A simulated pause blocks the crystal\'s actions right away; skipping it at page load needs a real notice and a reload.'));

    // Settings
    const settings = section('Settings',
      row(btn('New-crystal sheen on every crystal', () => { GM_setValue('ae_seen_crystals', []); AE.openSettings(); }, { close: true }),
        btn('Open Settings at Waymark', () => AE.openSettings('waymark'), { close: true }),
        btn('Feedback window', () => AE.feedback.openFeedback(), { close: true }),
        btn('Admin panel', () => AE.feedback.openAdmin(), { close: true })));

    // Macrocosmos
    const macro = section('Macrocosmos',
      row(btn('Button + first-time explainer on this WO', () => { if (!AE.hooks.galaxyDemo || !AE.hooks.galaxyDemo()) throw new Error('Open a work order first.'); }, { close: true })),
      note('On a WO without a GSPN ticket the demo button only shows a message when clicked.'));

    // Waymark
    const badgeN = h('input', { type: 'number', min: 0, max: 120, value: 3, 'aria-label': 'Badge count' });
    const bubbleN = h('input', { type: 'number', min: 1, max: 120, value: 3, 'aria-label': 'Bubble count' });
    const clockIn = h('input', { type: 'datetime-local', value: localInput(AE.nowDate()), 'aria-label': 'Pretend time' });
    const wm = AE.waymark;
    const woLink = (id) => h('a', { href: '/repair/workorder/' + id }, id);
    function showPlan(plan, title) {
      const byId = new Map((plan.rows || []).map((r) => [Number(r.workorderId), r]));
      const who = (id) => { const r = byId.get(id); return r ? AE.data.nameOf(r) : ''; };
      const table = (heads, rows) => rows.length ? h('table', null, h('tr', null, heads.map((x) => h('th', null, x))), rows.map((r) => h('tr', null, r.map((c) => h('td', null, c))))) : h('div', { class: 'note' }, 'None.');
      out.replaceChildren(h('b', null, title + ' · clock: ' + AE.nowDate().toLocaleString()),
        h('h3', { style: 'margin-top:8px' }, 'Would mark'), table(['WO', 'Customer', 'Due', 'From', 'Nickname now'], plan.create.map((x) => [woLink(x.wo), who(x.wo), wm.fmtDate(x.due), x.from, x.nick || '—'])),
        h('h3', null, 'Mark follows a later date typed in the nickname'), table(['WO', 'Customer', 'From', 'To'], plan.follow.map((x) => [woLink(x.wo), who(x.wo), wm.fmtDate(x.from), wm.fmtDate(x.to)])),
        h('h3', null, 'Would rename nickname'), table(['WO', 'Customer', 'Now', 'Becomes'], plan.rename.map((x) => [woLink(x.wo), who(x.wo), x.from || '—', x.to])),
        h('h3', null, 'Waiting for 7 PM'), table(['WO', 'Customer', 'Reached RFP', 'Nickname'], plan.waiting.map((x) => [woLink(x.wo), who(x.wo), wm.fmtDate(x.rfp), x.nick || '—'])),
        h('div', { class: 'note' }, 'Marks removed with × stay removed: the server ignores them even if listed under "Would mark".'));
    }
    const waymark = section('Waymark',
      row(btn('Due badge', () => AE.hooks.waymarkBadge(Number(badgeN.value))), badgeN, btn('Real badge', () => AE.hooks.waymarkBadge(null)),
        btn('Manager bubble', () => AE.hooks.waymarkBubble(Number(bubbleN.value)), { close: true }), bubbleN,
        btn('Real morning check now', () => AE.hooks.waymarkMorning(), { close: true, title: 'Clears today\'s "already shown" flag and runs the real check (managers only; reads, no writes).' })),
      row(h('span', null, 'Pretend it is'), clockIn,
        btn('Set clock', () => { GM_setValue(CLOCK_KEY, new Date(clockIn.value).getTime() - Date.now()); renderTab(); AE.toast('Dev tools', 'Clock for Waymark rules: ' + AE.nowDate().toLocaleString(), 'ok'); }),
        btn('Real clock', () => { GM_deleteValue(CLOCK_KEY); clockIn.value = localInput(new Date()); renderTab(); AE.toast('Dev tools', 'Back to the real clock.', 'ok'); })),
      row(btn('Auto-Waymark dry run', async () => { out.textContent = 'Reading the active list…'; showPlan(await wm.scan(null, { dryRun: true, force: true }), 'Dry run (nothing written)'); }),
        btn('Run the scan for real', async () => {
          const ok = await AE.confirm({ title: 'Run the Auto-Waymark scan for real?', message: 'This creates marks and <b>rewrites nicknames on real work orders</b>, using the ' + (shifted() ? '<b>shifted</b> ' : '') + 'clock (' + AE.esc(AE.nowDate().toLocaleString()) + ').', confirmLabel: 'Run it' });
          if (!ok) return;
          out.textContent = 'Running…';
          showPlan(await wm.scan(null, { force: true }), 'Ran for real');
        }, { write: true })),
      note('The clock only shifts Waymark\'s rules (7 PM, today, overdue) in this browser. Dry run first; the real scan writes to Portal.'),
      out);

    // Store access
    const access = section('Store access',
      row(btn('"Not available yet" notice', () => AE.hooks.accessNotice('denied')),
        btn('"Couldn\'t check access" notice', () => AE.hooks.accessNotice('unverified')),
        btn('Reload as a store without access', () => AE.hooks.previewLockedOut(), { title: 'Everything stays off, as for a store not on the list. The notice has an End preview button.' })),
      note('The full preview only changes this browser; "End preview" on the notice switches back.'));

    // Swiftcast + general
    const general = section('Panels, toasts, dialogs',
      row(btn('Swiftcast progress panel (fake)', demoProgress, { close: true }),
        btn('Toast: done', () => AE.toast('Waymark', 'Tag list saved for everyone at the store.', 'ok')),
        btn('Toast: error', () => AE.toast("Couldn't send", 'HTTP 503 — try again in a minute.', 'err')),
        btn('Toast: busy', () => { const t = AE.toast('Checking for updates…', '', 'busy'); setTimeout(() => t.remove(), 3000); }),
        btn('Confirm dialog', () => AE.confirm({ title: 'Create this cleaning?', message: '<b>Jordan Reyes</b> · AT&T Performance Check', warning: "Are you sure you'd like to create this cleaning? Only use this if you are the one who repaired this device!", confirmLabel: 'Yes, create cleaning' }))),
      row(btn('Recent Aethernet errors', () => { out.replaceChildren(h('pre', { style: 'white-space:pre-wrap;font:11px ui-monospace,Menlo,monospace' }, JSON.stringify(AE.recentErrors, null, 1) || '[]')); waymark.scrollIntoView(); }),
        btn('Log a test error', () => { AE.noteError('dev tools', new Error('Test error from dev tools')); AE.toast('Dev tools', 'Logged; it shows in bug reports\' technical details.', 'ok'); })));

    const card = h('div', { class: 'sg sg-card sg-dev', role: 'dialog', 'aria-modal': 'true', 'aria-label': AE_NAME + ' dev tools' },
      h('div', { class: 'head' }, h('span', { style: 'color:#e0761a;line-height:0', html: icon('aetheryte', 28) }), h('h2', null, 'Dev tools'), h('span', { class: 'tag' }, 'DEV v' + AE_VERSION),
        h('button', { class: 'sg-x', title: 'Close', onclick: () => close() }, '✕')),
      h('div', { class: 'scroll' }, updates, notices, access, settings, macro, waymark, general));
    const scrim = h('div', { class: 'sg sg-about-scrim', id: 'sg-dev', onclick: (e) => { if (e.target === scrim) close(); } }, card);
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    function close() { scrim.remove(); document.removeEventListener('keydown', onKey, true); }
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(scrim);
  }

  function demoProgress() {
    const panel = AE.progressPanel('Swiftcast · cleaning auto-close (demo)');
    const steps = ['IMEI validated', 'Created WO 500000000', 'Checked in', 'Started work', 'Diagnostics done', 'Work done', 'QC done', 'Ready for pickup', 'Sale complete'];
    let i = 0, stop = false;
    const stopBtn = h('button', { class: 'sg-btn sg-lg sg-danger', onclick: () => { stop = true; } }, '■ Stop');
    panel.actions(stopBtn);
    const tick = () => {
      if (stop) { panel.finish('stop', 'Stopped. (Demo: nothing was changed.)'); panel.actions(); return; }
      if (i < steps.length) { panel.step(steps[i++]); setTimeout(tick, 400); return; }
      panel.finish('ok', 'Done — demo only, nothing was changed.'); panel.actions();
    };
    setTimeout(tick, 400);
  }
})();
