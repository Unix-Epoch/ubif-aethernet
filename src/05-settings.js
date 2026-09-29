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
  const PATCH_NOTES = __PATCH_NOTES__;
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
