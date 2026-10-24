/*
  Dev tools — only in dev builds ("Aethernet (dev)"); build.py leaves src/dev/
  out of public builds.

  Every popup and automatic feature, on demand, instead of waiting for the
  conditions that normally trigger it: update pills, notices, the New sheen,
  the Macrocosmos explainer, Waymark's badge and morning bubble, the
  Auto-Waymark scan (dry run, or for real), a shifted clock for the 7 PM and
  morning rules, and demo panels/toasts.

  Portal cart recorder: while on, Portal's own cart requests (add/remove
  items, repair-code lookups) are saved with their body and Portal's answer,
  to copy exactly what Portal sends (e.g. for the Verizon screen protector).
  Watches window.fetch from inside the page; records only, changes nothing.

  Simulations only change what this browser shows. Two exceptions write to
  Portal and are labelled that way: "Run the scan for real" and the real
  morning check (which only reads).
*/
(function devTools() {
  if (!AE_ON_PORTAL || !AE_DEV) return;
  const { h, icon } = AE;
  const CLOCK_KEY = 'ae_dev_clock_offset';

  // ---------------------------------------------------- Portal cart recorder
  const REC_KEY = 'ae_dev_record_cart', REC_LOG = 'ae_dev_cart_log', REC_EVT = 'aethernet:cart-rec';
  function recorderHook() {
    if (document.getElementById('ae-cart-rec-hook')) return;
    const code = [
      '(function (evt) {',
      '  var WATCH = /\\/api\\/order\\/(cart\\/|repair-codes)/;',
      '  var orig = window.fetch;',
      '  window.fetch = function (input, init) {',
      '    var url = typeof input === "string" ? input : (input && input.url) || "";',
      '    var p = orig.apply(this, arguments);',
      '    if (!WATCH.test(url)) return p;',
      '    var method = (init && init.method) || (input && input.method) || "GET";',
      '    var bodyP = init && typeof init.body === "string" ? Promise.resolve(init.body) : (input && input.clone ? input.clone().text().catch(function () { return ""; }) : Promise.resolve(""));',
      '    p.then(function (res) {',
      '      Promise.all([bodyP, res.clone().text().catch(function () { return ""; })]).then(function (v) {',
      '        document.dispatchEvent(new CustomEvent(evt, { detail: JSON.stringify({ at: new Date().toISOString(), method: method, url: url, body: v[0], status: res.status, response: v[1].slice(0, 3000) }) }));',
      '      });',
      '    }, function (err) {',
      '      bodyP.then(function (b) { document.dispatchEvent(new CustomEvent(evt, { detail: JSON.stringify({ at: new Date().toISOString(), method: method, url: url, body: b, status: 0, response: String(err) }) })); });',
      '    });',
      '    return p;',
      '  };',
      '})(' + JSON.stringify(REC_EVT) + ');',
    ].join('\n');
    const el = document.createElement('script');
    el.id = 'ae-cart-rec-hook';
    el.textContent = code;
    (document.head || document.documentElement).append(el);
  }
  document.addEventListener(REC_EVT, (e) => {
    let rec; try { rec = JSON.parse(e.detail); } catch (_) { return; }
    GM_setValue(REC_LOG, [rec, ...GM_getValue(REC_LOG, [])].slice(0, 15));
    AE.toast('Recorded Portal cart request', rec.method + ' ' + rec.url.replace(/^https?:\/\/[^/]+/, '') + ' → ' + rec.status + '. Copy it from the dev tools.', rec.status && rec.status < 400 ? 'ok' : 'err', 6000);
  });
  if (GM_getValue(REC_KEY, false)) recorderHook();

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
    t.textContent = (AE_SANDBOX ? 'SANDBOX' : 'DEV') + (s ? ' · CLOCK' : '');
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
      shards: severity === 'warning' ? ['cleaningRate'] : [], pause: [], fixedIn: null, updated: new Date().toISOString() }, extra) });
    const notices = section('Notices (simulated)',
      row(btn('Info', () => S.simulate(sample('info'))), btn('Warning', () => S.simulate(sample('warning'))), btn('Error', () => S.simulate(sample('error'))),
        btn('Warning + Swiftcast paused', () => S.simulate(sample('warning', { pause: ['autoClose'] }))),
        btn('Fixed in a newer version', () => S.simulate(Object.assign(sample('error', { fixedIn: nextVersion(AE_VERSION) }), { latest: { version: nextVersion(AE_VERSION), date: minsAgo(60) } })))),
      row(btn('Back to real status', () => S.refresh(true).then(() => AE.toast('Dev tools', 'Real status.json loaded.', 'ok')))),
      note('A simulated pause blocks the shard\'s actions right away; skipping it at page load needs a real notice and a reload.'));

    // Settings
    const settings = section('Settings',
      row(btn('New-shard sheen on every shard', () => { GM_setValue('ae_seen_crystals', []) /* legacy stored key */; AE.openSettings(); }, { close: true }),
        btn('Updated sheen (as after updating from 2.16)', () => { GM_setValue('ae_updates_seen', '2.16.0'); AE.openSettings(); }, { close: true }),
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

    const scanIn = h('input', { type: 'text', placeholder: '500433215 or 123456-0001234567', style: 'width:220px' });
    const scans = section("Master's Mend",
      row(scanIn, btn('Pretend scan', async () => {
        if (!AE.hooks.scan) throw new Error('Turn on Master\'s Mend → Scan to open first.');
        AE.toast('Scan "' + scanIn.value + '"', await AE.hooks.scan(scanIn.value), 'ok', 6000);
      }, { title: 'Runs the scan-to-open rules on this text as if it were scanned here (focus in this box is ignored).' })));

    const rows = section('Rainbow Drip',
      row(btn('"Another script is also coloring" notice', () => { if (!AE.hooks.rowColorsNotice) throw new Error('Turn Rainbow Drip on first.'); AE.hooks.rowColorsNotice(); }, { close: true })));

    // Swiftcast + general
    const recOut = h('div');
    const drawRec = () => {
      const log = GM_getValue(REC_LOG, []);
      recOut.replaceChildren(...(log.length ? log.map((r) => h('div', { style: 'margin:6px 0;padding:6px 8px;border:1px solid var(--aui-outline-soft,#eeedf1);border-radius:8px' },
        h('div', { style: 'display:flex;gap:8px;align-items:center' }, h('b', { style: 'flex:1;font-size:12px' }, r.method + ' ' + r.url.replace(/^https?:\/\/[^/]+/, '') + ' → ' + r.status),
          btn('Copy', async () => { await navigator.clipboard.writeText(JSON.stringify(r, null, 1)); AE.toast('Copied', 'The request and Portal\'s answer are on the clipboard.', 'ok'); })),
        h('pre', { style: 'white-space:pre-wrap;font:11px ui-monospace,Menlo,monospace;margin:4px 0 0;max-height:120px;overflow:auto' }, r.body || '(no body)'))) : [note('Nothing recorded yet.')]));
    };
    drawRec();
    const recording = GM_getValue(REC_KEY, false);
    const recorder = section('Portal cart recorder',
      row(btn(recording ? 'Stop recording' : 'Record Portal\'s cart requests', () => {
        const on = !GM_getValue(REC_KEY, false);
        GM_setValue(REC_KEY, on);
        if (on) recorderHook();
        AE.toast('Cart recorder ' + (on ? 'on' : 'off'), on ? 'Add the item in Portal\'s cart as usual; the request is saved here. Reload to stop watching completely.' : 'Reload the page to stop watching completely.', 'ok', 6000);
        open(); // redraw with the new state
      }, { title: 'Saves Portal\'s own add/remove-item and repair-code requests (body + answer). Records only.' }),
        btn('Clear', () => { GM_deleteValue(REC_LOG); drawRec(); })),
      note(recording ? 'Recording: add the item in Portal\'s cart by hand, then copy the request below.' : 'Off.'),
      recOut);

    // SharePoint download test: can this browser fetch Provoke's sheets itself (its own
    // Microsoft sign-in, through Tampermonkey), so the sync can move off Garrett's Mac?
    const SP = 'https://ubreakifix-my.sharepoint.com/personal/';
    const SP_FILES = [['Lead texts (914)', 'c_boyd_ubreakifix_com', '02F051BD-D255-4E00-BC98-F621D65F3284'],
      ['Price sheet (regional)', 'b_bauer_ubreakifix_com', '0D091B56-0D5D-4C6E-9C71-CC40C1132F5A']];
    const gmGet = (url, opts = {}) => new Promise((resolve) => {
      if (typeof GM_xmlhttpRequest !== 'function') { resolve({ error: 'GM_xmlhttpRequest not granted' }); return; }
      const t0 = performance.now();
      GM_xmlhttpRequest({ method: 'GET', url, headers: opts.headers || {}, responseType: opts.binary ? 'arraybuffer' : 'text', timeout: 30000,
        onload: (r) => resolve({ status: r.status, finalUrl: r.finalUrl, ms: Math.round(performance.now() - t0), body: r.response }),
        onerror: (r) => resolve({ error: 'network error' + (r && r.error ? ': ' + r.error : '') }),
        ontimeout: () => resolve({ error: 'timed out after 30 s' }) });
    });
    const spOut = h('div', { class: 'out' });
    let spResult = null;
    async function spTest() {
      spOut.replaceChildren(note('Testing…'));
      const res = { version: AE_VERSION, at: new Date().toISOString(), browser: navigator.userAgent, files: [] };
      for (const [label, owner, uid] of SP_FILES) {
        const f = { label };
        const v = await gmGet(SP + owner + "/_api/web/GetFileById('" + uid + "')?$select=ETag,TimeLastModified,Name", { headers: { accept: 'application/json;odata=nometadata' } });
        f.versionCheck = { status: v.status, error: v.error, ms: v.ms, signIn: /login\.microsoftonline|\/_forms\//i.test(v.finalUrl || '') || undefined };
        if (v.status === 200) try { const j = JSON.parse(v.body); Object.assign(f.versionCheck, { name: j.Name, modified: j.TimeLastModified }); } catch (_) { f.versionCheck.note = 'not JSON: ' + String(v.body).slice(0, 80); }
        for (const [k, url] of [['download', SP + owner + '/_layouts/15/download.aspx?UniqueId=' + uid], ['downloadApi', SP + owner + "/_api/web/GetFileById('" + uid + "')/$value"]]) {
          const d = await gmGet(url, { binary: true });
          const b = d.body ? new Uint8Array(d.body) : null;
          f[k] = { status: d.status, error: d.error, ms: d.ms, bytes: b ? b.length : undefined, isFile: b ? b[0] === 0x50 && b[1] === 0x4b : undefined,
            signIn: /login\.microsoftonline|\/_forms\//i.test(d.finalUrl || '') || undefined };
        }
        try { // the page's own fetch, for comparison: expected to be blocked (CORS), which is why the grant is needed
          const r = await fetch(SP + owner + "/_api/web/GetFileById('" + uid + "')?$select=ETag", { credentials: 'include', headers: { accept: 'application/json;odata=nometadata' } });
          f.pageFetch = { status: r.status };
        } catch (e) { f.pageFetch = { error: (e && e.message) || String(e) }; }
        f.ok = f.versionCheck.status === 200 && ((f.download.status === 200 && f.download.isFile) || (f.downloadApi.status === 200 && f.downloadApi.isFile));
        res.files.push(f);
      }
      res.ok = res.files.every((f) => f.ok);
      spResult = res;
      const line = (f) => {
        const st = (x) => x.error ? x.error : 'HTTP ' + x.status + (x.signIn ? ' (sent to sign-in)' : '') + (x.bytes != null ? ' · ' + (x.bytes / 1024).toFixed(0) + ' KB' + (x.isFile ? '' : ' · not the file') : '') + (x.ms != null ? ' · ' + x.ms + ' ms' : '');
        return h('div', { style: 'margin:6px 0' }, h('b', null, (f.ok ? '✓ ' : '✗ ') + f.label),
          h('div', { class: 'note' }, 'Version check: ' + st(f.versionCheck) + (f.versionCheck.modified ? ' · edited ' + new Date(f.versionCheck.modified).toLocaleString() : '')),
          h('div', { class: 'note' }, 'Download: ' + st(f.download) + ' | API download: ' + st(f.downloadApi)),
          h('div', { class: 'note' }, 'Plain page fetch (expected to fail): ' + st(f.pageFetch)));
      };
      spOut.replaceChildren(h('div', { style: 'font-weight:600;color:' + (res.ok ? '#1d7a3a' : '#b42318') }, res.ok ? 'This browser can sync both sheets.' : "This browser can't download everything; send Garrett the results."), ...res.files.map(line));
      AE.track('dev:spTest:' + (res.ok ? 'ok' : 'fail'));
    }
    const sharepoint = section('SharePoint download test',
      row(btn('Test SharePoint access', spTest, { title: 'Checks and downloads the lead texts document and the Price sheet with this browser\'s Microsoft sign-in. Reads only.' }),
        btn('Copy results', async () => {
          if (!spResult) throw new Error('Run the test first.');
          await navigator.clipboard.writeText(JSON.stringify(spResult, null, 1)); AE.toast('Copied', 'The test results are on the clipboard.', 'ok');
        })),
      note("Can this browser download Provoke's sheets by itself? Needed to move the sheet sync off Garrett's Mac. Reads only; nothing is changed or sent anywhere."),
      spOut);

    // Work order tracker: last scan, a scan now, and a dry run that shows what one WO would send.
    const trOut = h('div', { class: 'out' });
    const woInput = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'WO #', style: 'width:110px', value: (location.pathname.match(/\/workorder\/(\d+)/) || [])[1] || '' });
    const trLast = AE.tracker.last();
    const tracker = section('Work order tracker',
      note(AE.tracker.configured() ? 'On (Worker set). Last scan: ' + (trLast ? new Date(trLast.at).toLocaleString() + ' · open ' + (trLast.open ?? '—') + ' · sent ' + trLast.sent + ' · unchanged ' + trLast.same + ' · failed ' + trLast.failed + (trLast.note ? ' · ' + trLast.note : '') + (trLast.errors.length ? ' · ' + trLast.errors.join('; ') : '') : 'none yet')
        : 'Off: no tracker Worker in this build. The dry run still works (it seals with a throwaway key).'),
      row(btn('Scan now', async () => {
        if (!AE.tracker.configured()) throw new Error('No tracker Worker in this build.');
        trOut.replaceChildren(note('Scanning…'));
        const r = await AE.tracker.scan({ force: true });
        trOut.replaceChildren(h('pre', { style: 'white-space:pre-wrap;font:11px ui-monospace,Menlo,monospace' }, JSON.stringify(r, null, 1)));
      }), woInput, btn('Dry run (nothing sent)', async () => {
        const wo = (woInput.value || '').trim();
        if (!/^\d+$/.test(wo)) throw new Error('Type a WO number.');
        trOut.replaceChildren(note('Fetching WO ' + wo + ' from Portal…'));
        const r = await AE.tracker.dryRun(wo);
        const c = r.card;
        trOut.replaceChildren(
          h('div', { class: 'note' }, 'WO ' + r.wo + (r.inList ? '' : ' (not in the open list)') + ' · full detail ' + (r.detailBytes / 1024).toFixed(1) + ' KB → sealed ' + (r.sealedBytes / 1024).toFixed(1) + ' KB · card ' + r.cardBytes + ' B'),
          h('div', { class: 'note' }, 'Sealed search card (readable only on the admin site): name ' + (c.name ? '✓' : '—') + ' · ' + c.phones.length + ' phone(s) · ' + c.emails.length + ' email(s) · IMEI ' + (c.imei ? '✓' : '—') + ' · serial ' + (c.serial ? '✓' : '—') + ' · claim ' + (c.claim ? '✓' : '—')),
          h('div', { class: 'note' }, 'Sealed with it: ' + r.sealedParts.notes + ' note(s) with their full text (' + r.sealedParts.noteChars.toLocaleString() + ' characters) · customer record ' + (r.sealedParts.customerRecord ? '✓' : '—') + ' · ' + r.sealedParts.statusHistory + ' status change(s) · ' + r.sealedParts.cartLines + ' cart line(s)'),
          h('div', { class: 'note', style: 'margin-top:6px;font-weight:600' }, 'Plain part (what the server can read). Check: no customer details.'),
          h('pre', { style: 'white-space:pre-wrap;font:11px ui-monospace,Menlo,monospace;max-height:260px;overflow:auto' }, JSON.stringify(r.plain, null, 1)),
          row(btn('Copy plain part', async () => { await navigator.clipboard.writeText(JSON.stringify(r.plain, null, 1)); AE.toast('Copied', 'The plain part is on the clipboard.', 'ok'); })));
      })),
      note('The dry run reads the WO from Portal exactly as a scan would, then shows what would be sent, without sending anything.'),
      trOut);

    // Retrace: the last collector pass, a pass now, and the Portal call recorder (real write shapes for the watcher).
    const rtOut = h('div', { class: 'out' });
    const rtLast = AE.retrace.last();
    const drawRtRec = () => {
      const log = AE.retrace.recorded();
      rtOut.replaceChildren(...(log.length ? [row(btn('Copy all ' + log.length, async () => { await navigator.clipboard.writeText(JSON.stringify(log, null, 1)); AE.toast('Copied', log.length + ' recorded Portal call(s) are on the clipboard.', 'ok'); }),
        btn('Clear', () => { AE.retrace.clearRecorded(); drawRtRec(); }))].concat(log.slice(0, 10).map((r) => h('div', { class: 'note' }, r.method + ' ' + r.url + ' → ' + r.status + ' · ' + new Date(r.at).toLocaleTimeString())))
        : [note('No Portal calls recorded yet.')]));
    };
    drawRtRec();
    const retrace = section('Retrace',
      note((AE.retrace.enabled() ? 'On' + (AE_SANDBOX ? ' (sandbox stand-in, not the Worker)' : '') : 'Off: no tracker Worker in this build') + '. Last pass: ' + (rtLast ? new Date(rtLast.at).toLocaleString() + ' · ' + rtLast.seconds + ' s · Portal ' + rtLast.calls.portal + ' / Worker ' + rtLast.calls.worker + ' calls · '
        + rtLast.labels + ' labels · ' + rtLast.docs + ' docs · ' + rtLast.pos + ' POs · ' + rtLast.histories + ' histories · ' + rtLast.added + ' added' + (rtLast.note ? ' · ' + rtLast.note : '') + (rtLast.errors.length ? ' · ' + rtLast.errors.join('; ') : '') : 'none yet')
        + ' · watched moves queued: ' + AE.retrace.queued() + ' · state: ' + JSON.stringify(AE.retrace.state())),
      row(btn('Run a pass now', async () => {
        if (!AE.retrace.enabled()) throw new Error('No tracker Worker in this build.');
        rtOut.replaceChildren(note('Running a pass (the stock lookup takes a few minutes when it\'s due)…'));
        const r = await AE.retrace.run();
        rtOut.replaceChildren(h('pre', { style: 'white-space:pre-wrap;font:11px ui-monospace,Menlo,monospace' }, JSON.stringify(r || { didNothing: true, state: AE.retrace.state() }, null, 1)));
      }), btn('Retrace: probe the item lookup', async () => {
        rtOut.replaceChildren(note('Probing the item lookup (each call takes 10-14 s)…'));
        const out = [];
        const tries = [['instore, by available', 'locationType=instore&sortField=availablequantity&sortOrder=desc'], ['0, by available (what the collector sends)', 'locationType=0&sortField=availablequantity&sortOrder=desc'],
          ['instore, by product name', 'locationType=instore&sortField=productname&sortOrder=asc'], ['no locationType, by available', 'sortField=availablequantity&sortOrder=desc']];
        for (const [name, q] of tries) {
          try {
            const j = await AE.api('GET', '/api/boh/inventory-lookup?pageSize=3&page=1&searchTerm=&categoryFilter=&' + q);
            const rows = Array.isArray(j) ? j : j && typeof j === 'object' ? (['value', 'data', 'results', 'items', 'rows'].map((k) => j[k]).find(Array.isArray) || []) : [];
            out.push({ name, query: q, topLevel: Array.isArray(j) ? 'array' : j && typeof j === 'object' ? Object.keys(j) : typeof j, rows: rows.length, first: rows[0] || null, raw: rows.length ? undefined : JSON.stringify(j).slice(0, 400) });
          } catch (e) { out.push({ name, query: q, error: e.message || String(e) }); }
          rtOut.replaceChildren(h('pre', { style: 'white-space:pre-wrap;font:11px ui-monospace,Menlo,monospace' }, JSON.stringify(out, null, 1)));
        }
      }), btn(AE.retrace.recording() ? 'Retrace: stop recording Portal calls' : 'Retrace: record Portal calls', () => {
        const on = !AE.retrace.recording();
        AE.retrace.setRecording(on);
        AE.toast('Retrace recorder ' + (on ? 'on' : 'off'), on ? 'Portal\'s inventory writes (adjust, swap, transfer, count scans, cart parts, RMA / buyback) are saved here, customer details removed.' : 'Stopped.', 'ok', 6000);
        open();
      }, { title: 'Keeps the last 50 Portal inventory write calls (request + answer, scrubbed) so the watcher can be checked against real shapes. Records only.' })),
      rtOut);

    // Assize's rule graphs, shadow mode: how many run, and where they disagree with the code rules.
    const ag = AE.hooks.assizeGraphs ? AE.hooks.assizeGraphs() : null;
    const agLast = ag && ag.log[0];
    const assizeGraphs = section('Assize graphs',
      note(!ag ? 'Assize is off.' : 'Assize graphs: ' + ag.rules.length + ' rules, ' + ag.log.length + ' mismatches' + (agLast ? ' (last: WO ' + agLast.wo + ' ' + agLast.rule + ', ' + new Date(agLast.last).toLocaleString() + ')' : '') +
        (ag.skipped.length ? '. Skipped (invalid): ' + ag.skipped.map((x) => x.rule).join(', ') : '') +
        (ag.last ? '. Last check: ' + ag.last.orders + ' orders, ' + ag.last.compared + ' comparisons, ' + ag.last.mismatches + ' mismatches, ' + ag.last.errors + ' errors' : '')),
      ag ? row(btn('Log mismatches to the console', () => console.log('Assize graphs', ag)), btn('Clear mismatches', () => { ag.clear(); AE.toast('Assize graphs', 'Mismatch log cleared.', 'ok'); }, { close: true })) : null,
      note(!ag || !ag.published ? 'Published rules: none fetched for this store yet.' : 'Published rules (version ' + String(ag.published.version).slice(0, 8) + ', fetched ' + new Date(ag.published.at).toLocaleString() + '): '
        + (ag.published.rules.length ? ag.published.rules.map((x) => x.rule + (x.enabled ? x.graph ? ' graph v' + x.version + ' (' + (x.scope === 'all' ? 'all stores' : 'this store') + ')' : ' code (graph invalid)' : ' off')).join(', ') : 'nothing published')
        + (ag.published.skipped.length ? '. Skipped (invalid): ' + ag.published.skipped.map((x) => x.rule).join(', ') : '')),
      ag ? row(btn('Fetch published rules now', () => ag.reloadRules())) : null,
      note('Built-in graphs run next to the code rules (shadow mode, for rules with nothing published) and never change what Assize shows. A published graph replaces its code rule.'));

    const perf = section('Performance',
      row(btn('Page watcher cost', () => {
        const st = AE.domStats, secs = (performance.now() - st.since) / 1000;
        AE.toast('Page watcher', st.runs + ' runs in ' + secs.toFixed(0) + ' s · ' + st.ms.toFixed(1) + ' ms total · avg ' + (st.runs ? (st.ms / st.runs).toFixed(2) : 0) + ' ms/run · worst frame ' + st.worstFrame.toFixed(1) + ' ms', 'ok', 15000);
      }), btn('Reset', () => AE.domStats.reset())),
      note('What Aethernet spends reacting to page changes. Budget: under 2 ms a frame on average.'));
    const general = section('Panels, toasts, dialogs',
      row(btn('Refresh view in place', async () => {
        const r = await AE.refreshView();
        AE.toast('Refresh view', r.stores ? r.stores + ' store(s), ' + r.apis + ' API cache(s): ' + (r.tags.join(', ') || 'no tags in use') : 'Found no Portal data to refresh' + (r.error ? ': ' + r.error : '.'), r.stores ? 'ok' : 'err', 8000);
      }, { title: 'What Recitation, Waymark and Swiftcast do after a change: refetch what Portal shows, no page reload.' })),
      row(btn('Swiftcast button (1 cleaning)', () => { if (!AE.hooks.dualcastButton) throw new Error('Turn Swiftcast on first.'); AE.hooks.dualcastButton(1); }, { close: true }),
        btn('Dualcast button + explainer', () => { if (!AE.hooks.dualcastButton) throw new Error('Turn Swiftcast on first.'); AE.hooks.dualcastButton(2); }, { close: true }),
        btn('Triplecast button + explainer', () => { if (!AE.hooks.dualcastButton) throw new Error('Turn Swiftcast on first.'); AE.hooks.dualcastButton(3); }, { close: true })),
      row(btn('Fake Dualcast run', () => { if (!AE.hooks.dualcastFake) throw new Error('Turn Swiftcast on first.'); AE.hooks.dualcastFake(); }, { close: true, title: 'The real confirmation and progress panel, simulated steps: nothing is sent to Portal.' }),
        btn('Fake Dualcast, 2nd fails', () => { if (!AE.hooks.dualcastFake) throw new Error('Turn Swiftcast on first.'); AE.hooks.dualcastFake({ fail: true }); }, { close: true })),
      row(btn('Swiftcast progress panel (fake)', demoProgress, { close: true }),
        btn('… with the collapse tip', () => { GM_deleteValue('ae_collapse_tip_seen'); demoProgress(); }, { close: true, title: 'Shows the "This is now collapsible!" bubble again. The fake run also blocks reloading until it ends.' }),
        btn('Toast: done', () => AE.toast('Waymark', 'Tag list saved for everyone at the store.', 'ok')),
        btn('Toast: error', () => AE.toast("Couldn't send", 'HTTP 503 — try again in a minute.', 'err')),
        btn('Toast: busy', () => { const t = AE.toast('Checking for updates…', '', 'busy'); setTimeout(() => t.remove(), 3000); }),
        btn('Confirm dialog', () => AE.confirm({ title: 'Create this cleaning?', message: '<b>Jordan Reyes</b> · AT&T Performance Check', warning: "Are you sure you'd like to create this cleaning? Only use this if you are the one who repaired this device!", confirmLabel: 'Yes, create cleaning' }))),
      row(btn('Recent Aethernet errors', () => { out.replaceChildren(h('pre', { style: 'white-space:pre-wrap;font:11px ui-monospace,Menlo,monospace' }, JSON.stringify(AE.recentErrors, null, 1) || '[]')); waymark.scrollIntoView(); }),
        btn('Log a test error', () => { AE.noteError('dev tools', new Error('Test error from dev tools')); AE.toast('Dev tools', 'Logged; it shows in bug reports\' technical details.', 'ok'); })));

    const card = h('div', { class: 'sg sg-card sg-dev', role: 'dialog', 'aria-modal': 'true', 'aria-label': AE_NAME + ' dev tools' },
      h('div', { class: 'head' }, h('span', { style: 'color:#e0761a;line-height:0', html: icon('aetheryte', 28) }), h('h2', null, 'Dev tools'), h('span', { class: 'tag' }, 'DEV v' + AE_VERSION),
        h('button', { class: 'sg-x', title: 'Close', onclick: () => close() }, '✕')),
      h('div', { class: 'scroll' }, updates, tracker, retrace, assizeGraphs, sharepoint, notices, access, settings, macro, waymark, rows, scans, recorder, perf, general));
    const scrim = h('div', { class: 'sg sg-about-scrim', id: 'sg-dev', onclick: (e) => { if (e.target === scrim) close(); } }, card);
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    function close() { scrim.remove(); document.removeEventListener('keydown', onKey, true); }
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(scrim);
  }

  function demoProgress() {
    const steps = ['IMEI validated', 'Created WO 500000000', 'Checked in', 'Started work', 'Diagnostics done', 'Work done', 'QC done', 'Ready for pickup', 'Sale complete'];
    const panel = AE.progressPanel('Swiftcasting… (test)', { icon: 'autoClose', total: steps.length, hold: true });
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
