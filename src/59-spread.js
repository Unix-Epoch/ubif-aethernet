/*
  Spread (`spread`) — a read-only Kanban board of Portal's Workorders page (/repair/workorders). Dev-only for now.

  A `Spread [List | Board]` switch sits at the right end of Portal's filter row, left of the "N per page" select. List = Portal's page,
  untouched. Board = Portal's table wrapper hidden (its rows stay in the DOM, so Waymark, Assize, Rainbow Drip and Master's Mend's
  sorting keep working on them) and a board shown in its place, under Portal's tabs and filters. The choice is remembered per browser.
  Leaving the page (or turning the shard off / pausing it by a notice) removes the switch and the board and un-hides the table.

  Data: every OPEN work order, not the page of rows on screen. It reuses AE.data.workorders (the list call Waymark and the tracker
  read: POST /api/workorders, primaryFilter Active, pageSize 100, paged by Portal's own rowCount, with AE.shape guarding the list).
  Portal's own filters (tabs, Needs Attention, Program, Device type) are NOT applied: their state isn't read from anywhere proven, so
  the board always shows all open work orders. Refreshed when the board opens and every REFRESH_MS while it stays open; never while
  the tab is hidden or Portal is down (AE.health.down()). A refresh updates the cards in place (the deal-in plays when the board opens).

  Columns (fixed, by workorderStatusId): Need to order 2 · Ready to start 8,24 · Work started 9,10,11,12 · Waiting 3,4,7 ·
  Ready for pickup 13. An open status with no column (5, 6, 17, 26, 27, anything unknown) goes in Waiting with its real status name.

  A card reads only: workorderId, workorderStatusId/Name, programName, locationBin, attentionState/Reasons, updatedAt,
  rfpWorkorderStatusDate, deviceIssues, customer (AE.data.nameOf), deviceCatalog.name, customerDevice.name. Never phone, email, serial or IMEI.

  Time on a card: "in status" is only claimed where a status date is proven: Ready for pickup with Portal's rfpWorkorderStatusDate
  (the tracker uses it as the start of an RFP period). Every other card shows "Updated 2d 4h ago" from updatedAt. Oldest first.

  RFP total (Ready for pickup header): AE.tracker.rfp(), the same figure Master's Mend puts on Today's sales. Left out when the tracker
  isn't reachable.
*/
AE.spread = (() => {
  // Fixed columns. `ids` are Portal's workorderStatusId values; `rfp` marks the one that carries the RFP total.
  const COLUMNS = [
    { name: 'Need to order', ids: [2] }, // Portal's own tab counts (Nov 11, 2026): Awaiting item (3) is counted under Waiting
    { name: 'Ready to start', ids: [8, 24] },
    { name: 'Work started', ids: [9, 10, 11, 12] },
    { name: 'Waiting', ids: [3, 4, 7] },
    { name: 'Ready for pickup', ids: [13], rfp: true },
  ];
  const WAITING = 3; // where an open status with no column of its own goes (shown with its real status name)
  const RFP_STATUS = 13;
  // PLACEHOLDER threshold: how long without a status change / update before a card is marked old (amber). Not a store rule yet.
  const OLD_HOURS = 48;
  const REFRESH_MS = 60 * 1000;     // background refresh while the board is open
  const OPEN_REFRESH_MS = 10 * 1000; // opening the board reuses a list newer than this
  const HOUR = 3600 * 1000;

  // The status as a number, or null when the row has none (null, '', text): such a row still lands in Waiting.
  const statusOf = (r) => { const v = r && r.workorderStatusId; return v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v); };
  const columnIndex = (statusId) => { const i = COLUMNS.findIndex((c) => c.ids.includes(statusId)); return i < 0 ? WAITING : i; };

  const parse = (iso) => { const t = typeof iso === 'string' ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };
  // When the card's time starts, and what that time means: { ms, kind: 'status' | 'updated' } or null.
  function sinceOf(r, now) {
    const clamp = (t) => Math.min(t, now);
    if (statusOf(r) === RFP_STATUS) { const t = parse(r.rfpWorkorderStatusDate); if (t !== null) return { ms: clamp(t), kind: 'status' }; }
    const u = parse(r && r.updatedAt);
    return u === null ? null : { ms: clamp(u), kind: 'updated' };
  }
  const hoursOf = (since, now) => (since ? Math.max(0, Math.floor((now - since.ms) / HOUR)) : null);
  const ageText = (h) => (h < 1 ? '<1h' : h >= 24 ? Math.floor(h / 24) + 'd ' + (h % 24) + 'h' : h + 'h');
  const timeText = (since, now) => { if (!since) return ''; const a = ageText(hoursOf(since, now)); return since.kind === 'status' ? a + ' in status' : 'Updated ' + a + ' ago'; };
  const isOld = (since, now) => !!since && hoursOf(since, now) >= OLD_HOURS;

  const txt = (v) => (typeof v === 'string' ? v.trim() : '');
  // What a card shows, from one list row. Strings only; nothing personal beyond the customer's name.
  function cardOf(r, now) {
    const status = statusOf(r), ci = columnIndex(status), since = sinceOf(r, now);
    const issues = Array.isArray(r.deviceIssues) ? r.deviceIssues.map(txt).filter(Boolean) : [];
    const att = r.attentionState === 'warning' || r.attentionState === 'urgent' ? r.attentionState : null; // "", "none" = nothing
    const reasons = att && Array.isArray(r.attentionReasons) ? r.attentionReasons.filter((x) => typeof x === 'string' && x.trim()) : [];
    const id = Number(r.workorderId);
    return {
      id, href: '/repair/workorder/' + id, col: ci, status, statusName: txt(r.workorderStatusName),
      device: txt(r.deviceCatalog && r.deviceCatalog.name) || txt(r.customerDevice && r.customerDevice.name),
      customer: AE.data.nameOf(r), issue: issues.join(', '), program: txt(r.programName), bin: txt(r.locationBin),
      attention: att, reasons, since, time: timeText(since, now), old: isOld(since, now),
      showStatus: COLUMNS[ci].ids.length > 1 || !COLUMNS[ci].ids.includes(status), // the column header already says it when it holds one status
    };
  }
  // Oldest first, by the time each card shows; cards with no time last; WO number breaks ties.
  const byAge = (a, b) => (a.since ? a.since.ms : Infinity) - (b.since ? b.since.ms : Infinity) || a.id - b.id;
  // Rows → the five columns with their cards.
  function layout(rows, now) {
    const cols = COLUMNS.map((c) => ({ name: c.name, ids: c.ids, rfp: !!c.rfp, cards: [] }));
    for (const r of rows) { const c = cardOf(r, now); cols[c.col].cards.push(c); }
    for (const c of cols) c.cards.sort(byAge);
    return cols;
  }
  const money = (n) => '$' + Math.round(n).toLocaleString('en-US'); // same rounding as Master's Mend's RFP total
  // A column's header: name, count, and (Ready for pickup only, when the tracker gave a figure) the RFP total.
  function header(col, cards, rfp) {
    // no figure above an empty column: the tracker's number and this board would contradict each other
    return { name: col.name, count: cards.length, rfp: col.rfp && cards.length && rfp && Number.isFinite(rfp.value) ? 'RFP total ' + money(rfp.value) : null };
  }
  // Motion (ms): cards deal in column × 40 + row × 30 (rows past the sixth don't wait longer); counts and the RFP total follow.
  const dealDelay = (ci, ri) => ci * 40 + Math.min(ri, 6) * 30;
  const headDelay = (ci) => ci * 40 + 60;

  // Background refresh only while the board is shown, the tab is visible, nothing is loading, Portal is not down, and the list is stale.
  function refreshDue(st, now) {
    if (!st.shown || st.busy || st.hidden || AE.health.down()) return false;
    return now - st.last >= st.every;
  }
  // Every open work order (AE.data.workorders pages by Portal's rowCount); rows with no work order number are skipped and noted.
  async function read() {
    const all = await AE.data.workorders(Date.now(), 0);
    const rows = all.filter((r) => r && typeof r === 'object' && Number.isFinite(Number(r.workorderId)) && r.workorderId !== '' && r.workorderId !== null);
    if (rows.length !== all.length) AE.noteError('spread', new Error((all.length - rows.length) + ' list row(s) without a numeric workorderId were left off the board'));
    return rows;
  }
  return { COLUMNS, WAITING, OLD_HOURS, REFRESH_MS, OPEN_REFRESH_MS, statusOf, columnIndex, sinceOf, hoursOf, ageText, timeText, isOld, cardOf, layout, header, money, dealDelay, headDelay, refreshDue, read };
})();

AE.shard({
  id: 'spread',
  name: 'Spread',
  sites: ['portal.ubreakifix.net'],
  run() {
    const S = AE.spread, { h } = AE;
    const VIEW_KEY = 'ae_spread_view'; // 'list' | 'board', per browser
    const onPage = () => /^\/repair\/workorders\/?$/.test(location.pathname);
    const live = () => AE.settings.crystals.spread !== false && !AE.status.paused('spread');

    // ------------------------------------------------------------ CSS
    const CSS = `
    [data-ae-spread="hidden"] { display:none !important; }
    /* grows to fill the row so it sits against the per-page menu (Portal gives that menu an auto left margin too, which would split the space) */
    .sp-switch { display:flex; flex:1 1 auto; justify-content:flex-end; align-items:center; gap:8px; margin:0 14px 0 0; font-family:Apercu,"Helvetica Neue",Helvetica,Arial,sans-serif; }
    .sp-switch .sp-name { font-size:13px; font-weight:700; color:var(--aui-primary,#8223d2); letter-spacing:.2px; }
    .sp-seg { position:relative; display:inline-flex; height:32px; border:1px solid var(--aui-primary,#8223d2); border-radius:8px; }
    .sp-seg .ae, .sp-note .ae { position:absolute; left:-8px; top:-9px; width:18px; height:18px; border-radius:50%; background:var(--aui-primary,#8223d2); color:#fff; font:700 8px/18px Apercu,Arial,sans-serif; text-align:center; box-shadow:0 0 0 2px var(--aui-surface,#fff); z-index:1; }
    .sp-seg button { border:0; margin:0; background:transparent; color:var(--aui-primary,#8223d2); font:400 15px Apercu,"Helvetica Neue",Arial,sans-serif; padding:0 14px; cursor:pointer; display:inline-flex; align-items:center; gap:6px; }
    .sp-seg button:first-of-type { border-radius:7px 0 0 7px; padding-left:16px; } .sp-seg button:last-of-type { border-radius:0 7px 7px 0; }
    .sp-seg button.on { background:var(--aui-primary,#8223d2); color:#fff; }
    .sp-seg svg { width:15px; height:15px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
    #sp-board { display:none; font-family:Apercu,"Helvetica Neue",Helvetica,Arial,sans-serif; color:#1a1c1e; margin-top:14px; flex-direction:column; }
    #sp-board.sp-on { display:flex; }
    .sp-note { display:flex; align-items:center; gap:8px; font-size:13px; color:var(--aui-on-surface-soft,#5d5e61); margin:0 0 10px; }
    .sp-note .ae { position:static; flex:none; box-shadow:none; }
    .sp-state { font-size:13px; color:var(--aui-on-surface-soft,#5d5e61); margin:-4px 0 10px 26px; }
    .sp-state:empty { display:none; }
    .sp-cols { display:grid; grid-template-columns:repeat(5, minmax(0,1fr)); gap:12px; flex:1; min-height:0; }
    .sp-col { display:flex; flex-direction:column; min-height:0; min-width:0; background:#f3f3f5; border-radius:10px; }
    .sp-head { padding:12px 12px 6px; flex:none; }
    .sp-head .t { display:flex; align-items:center; justify-content:space-between; gap:8px; }
    .sp-head h3 { margin:0; font:700 16px/1.2 Apercu,"Helvetica Neue",Arial,sans-serif; }
    .sp-count { min-width:24px; height:22px; padding:0 8px; box-sizing:border-box; border-radius:11px; background:#fff; border:1px solid #d9d9de; font:700 13px/20px Apercu,Arial,sans-serif; text-align:center; }
    .sp-rfp { margin-top:6px; font-size:13px; color:var(--aui-on-surface-soft,#5d5e61); } .sp-rfp b { color:#1a1c1e; font-weight:700; }
    .sp-list { flex:1; min-height:0; overflow-y:auto; padding:4px 8px 10px; display:flex; flex-direction:column; gap:8px; }
    .sp-list::-webkit-scrollbar { width:8px; } .sp-list::-webkit-scrollbar-thumb { background:#b9b9c2; border-radius:4px; } .sp-list::-webkit-scrollbar-track { background:transparent; margin:2px 0; }
    .sp-empty { margin:8px 0; padding:22px 8px; text-align:center; font-size:14px; color:var(--aui-on-surface-soft,#5d5e61); border:1px dashed #c9c9d0; border-radius:8px; }
    .sp-card { position:relative; display:block; color:inherit; text-decoration:none; background:#fff; border:1px solid #e3e3e8; border-left:6px solid var(--edge); background-image:linear-gradient(90deg, color-mix(in srgb, var(--edge) 35%, transparent), transparent 40px); border-radius:8px; padding:9px 10px 8px 10px; cursor:pointer; flex:none; box-shadow:0 1px 1px rgba(0,0,0,.04); transition:transform 120ms ease-out, box-shadow 120ms ease-out; }
    .sp-card:hover { transform:translateY(-2px); box-shadow:0 4px 10px rgba(0,0,0,.14); }
    .sp-card:focus-visible { outline:2px solid var(--aui-primary,#8223d2); outline-offset:2px; }
    /* Deal-in: transform + opacity only. Cards rise 8px (fits the list's 10px bottom padding, so no scrollbar flash). */
    @keyframes sp-deal { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
    @keyframes sp-fade { from { opacity:0; } to { opacity:1; } }
    @keyframes sp-leave { from { opacity:1; } to { opacity:0; } }
    .sp-deal .sp-card { animation:sp-deal 240ms cubic-bezier(.22,.61,.36,1) var(--d,0ms) backwards; }
    .sp-deal .sp-count, .sp-deal .sp-rfp { animation:sp-fade 220ms ease-out var(--hd,0ms) backwards; }
    .sp-card.sp-new { animation:sp-fade 240ms ease-out backwards; }
    #sp-board.sp-leaving { animation:sp-leave 120ms ease-out forwards; pointer-events:none; }
    @media (prefers-reduced-motion: reduce) {
      .sp-card { transition:box-shadow 120ms ease-out; }
      .sp-card:hover { transform:none; }
      .sp-deal .sp-card, .sp-card.sp-new { animation:sp-fade 120ms ease-out backwards; }
      .sp-deal .sp-count, .sp-deal .sp-rfp { animation:none; }
      #sp-board.sp-leaving { animation-duration:60ms; }
    }
    .sp-r1 { display:flex; align-items:center; gap:6px; min-height:20px; }
    .sp-wo { font-size:14px; font-weight:700; color:var(--aui-primary,#8223d2); text-decoration:underline; text-underline-offset:2px; }
    .sp-spacer { flex:1; }
    .sp-att { display:inline-flex; align-items:center; gap:3px; height:18px; padding:0 6px 0 4px; border-radius:9px; font:700 11px/1 Apercu,Arial,sans-serif; }
    .sp-att svg { width:13px; height:13px; fill:currentColor; }
    .sp-att.warning { color:#7a5200; background:#ffecb8; } .sp-att.urgent { color:#fff; background:#d1344b; }
    .sp-dev { margin-top:3px; font-size:15px; font-weight:700; line-height:1.25; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .sp-cust { display:flex; align-items:center; gap:5px; margin-top:1px; font-size:14px; min-width:0; }
    .sp-cust span.n { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
    .sp-cust .ae-as-mk { flex:none; }
    .sp-issue { margin-top:3px; font-size:13px; color:var(--aui-on-surface-soft,#5d5e61); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .sp-meta { display:flex; flex-wrap:wrap; align-items:center; gap:4px; margin-top:6px; }
    .sp-meta:empty { display:none; }
    .sp-prog { display:inline-block; max-width:100%; box-sizing:border-box; height:18px; line-height:16px; padding:0 7px; border-radius:4px; background:#ececf0; border:1px solid #dcdce2; font-size:11px; color:#3b3d40; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .sp-bin { display:inline-flex; align-items:center; gap:3px; height:18px; padding:0 6px; border-radius:4px; background:#fff; border:1px solid #bdbdc6; font-size:11px; font-weight:700; color:#3b3d40; }
    .sp-bin svg { width:11px; height:11px; fill:none; stroke:currentColor; stroke-width:2; }
    .sp-foot { display:flex; align-items:center; justify-content:space-between; gap:6px; margin-top:7px; padding-top:6px; border-top:1px solid #efeff2; font-size:12px; color:var(--aui-on-surface-soft,#5d5e61); }
    .sp-st { font-weight:700; color:#3b3d40; font-size:12px; margin-top:2px; }
    .sp-age { display:inline-flex; align-items:center; gap:4px; white-space:nowrap; }
    .sp-age svg { width:12px; height:12px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; }
    .sp-age.old { color:#8a5a00; font-weight:700; } .sp-age.old::after { content:''; width:6px; height:6px; border-radius:50%; background:#e39a00; }
    `;
    const ensureCss = () => { if (!document.getElementById('sp-css')) document.head.append(h('style', { id: 'sp-css' }, CSS)); }; // present only while the switch and board are

    // ------------------------------------------------------------ icons (static markup)
    const ICON = {
      list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>',
      board: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="10" rx="1"/><rect x="17" y="4" width="4" height="13" rx="1"/></svg>',
      bin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/></svg>',
      clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
      warn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5L22.5 21h-21zM11 9h2v6h-2zM11 16.5h2v2h-2z" fill-rule="evenodd"/></svg>',
    };

    // ------------------------------------------------------------ state
    let view = (() => { try { return GM_getValue(VIEW_KEY, 'list') === 'board' ? 'board' : 'list'; } catch (_) { return 'list'; } })();
    let ui = null;          // the mounted pieces: { pt, tableWrap, filterRow, sw, board, cols, note, state }
    let data = null;        // the last good list: { rows, at }
    let err = null;         // the last failed read (kept until a read works)
    let rfp = null;         // the last RFP total from the tracker: { value, updatedAt }
    let busy = false, lastTry = 0, dealPending = false, dealTimer = 0, leaveTimer = 0, wasOnPage = false;
    const shown = () => !!ui && view === 'board';

    // ------------------------------------------------------------ Portal anchors (test ids and ids, never the hashed sc- classes)
    const childOf = (parent, el) => { while (el && el.parentElement && el.parentElement !== parent) el = el.parentElement; return el && el.parentElement === parent ? el : null; };
    function anchors() {
      const pt = document.querySelector('[data-testid="partner-tabs"]');
      const table = pt && pt.querySelector('[data-testid="table"]'), pcc = pt && pt.querySelector('#pageCount-container');
      const tableWrap = table && childOf(pt, table), filterRow = pcc && childOf(pt, pcc), perPage = filterRow && childOf(filterRow, pcc);
      return tableWrap && filterRow && perPage ? { pt, tableWrap, filterRow, perPage } : null;
    }

    // ------------------------------------------------------------ the page pieces
    function buildSwitch() {
      // Pointing at Board starts the read, so the cards are usually there by the time it is clicked.
      const warm = () => { if (view !== 'board' && S.refreshDue({ shown: true, busy, hidden: document.hidden, last: lastTry, every: S.OPEN_REFRESH_MS }, Date.now())) load(); };
      const btn = (v, label) => h('button', { type: 'button', 'data-v': v, 'aria-pressed': 'false', html: ICON[v] + label, onclick: () => choose(v), onmouseenter: v === 'board' ? warm : null, onfocus: v === 'board' ? warm : null });
      return h('div', { class: 'sp-switch', id: 'sp-switch', role: 'group', 'aria-label': 'Spread: List or Board' },
        h('span', { class: 'sp-name' }, 'Spread'),
        h('div', { class: 'sp-seg' }, h('span', { class: 'ae', 'aria-hidden': 'true' }, 'Ae'), btn('list', 'List'), btn('board', 'Board')));
    }
    function buildBoard() {
      const cols = S.COLUMNS.map((c, ci) => {
        const count = h('span', { class: 'sp-count' }), rfpEl = c.rfp ? h('div', { class: 'sp-rfp' }) : null, list = h('div', { class: 'sp-list' });
        const el = h('section', { class: 'sp-col', 'aria-label': c.name, style: '--hd:' + S.headDelay(ci) + 'ms' },
          h('div', { class: 'sp-head' }, h('div', { class: 't' }, h('h3', null, c.name), count), rfpEl), list);
        return { el, count, rfpEl, list, cards: new Map(), empty: null };
      });
      const note = h('div', { class: 'sp-note' }, h('span', { class: 'ae', 'aria-hidden': 'true' }, 'Ae'),
        h('span', null, h('b', null, 'Spread'), " · Board view is read-only. Click a card to open its work order. Cards can't be dragged yet."));
      const state = h('div', { class: 'sp-state', role: 'status', 'aria-live': 'polite' });
      const board = h('div', { id: 'sp-board' }, note, state, h('div', { class: 'sp-cols' }, cols.map((c) => c.el)));
      return { board, cols, note, state };
    }
    function mount() {
      const a = anchors();
      if (!a) return false;
      ensureCss();
      const sw = buildSwitch(), b = buildBoard();
      a.perPage.before(sw);
      a.tableWrap.after(b.board);
      ui = Object.assign({ sw }, a, b);
      paintSwitch();
      return true;
    }
    function teardown() {
      if (!ui) return;
      clearTimeout(dealTimer); clearTimeout(leaveTimer);
      ui.sw.remove(); ui.board.remove(); document.getElementById('sp-css')?.remove();
      if (ui.tableWrap.getAttribute('data-ae-spread')) ui.tableWrap.removeAttribute('data-ae-spread');
      ui = null; dealPending = false;
    }
    const intact = () => ui && ui.pt.isConnected && ui.sw.parentElement === ui.filterRow && ui.board.parentElement === ui.pt && ui.tableWrap.isConnected;

    // ------------------------------------------------------------ switching
    function paintSwitch() {
      ui.sw.querySelectorAll('button').forEach((b) => { const on = b.dataset.v === view; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    }
    function size() {
      if (!shown()) return;
      const top = ui.board.getBoundingClientRect().top, hh = Math.max(380, innerHeight - top - 24) + 'px';
      if (ui.board.style.height !== hh) ui.board.style.height = hh;
    }
    function choose(v) {
      if (v === view) return;
      const was = view; view = v;
      try { GM_setValue(VIEW_KEY, v); } catch (_) {}
      paintSwitch();
      if (v === 'board') AE.track('spread:board');
      apply(was !== 'board');
    }
    // Make the page match `view`. `deal`: Board is opening now (play the deal-in).
    function apply(deal) {
      if (!ui) return;
      const board = ui.board;
      if (view === 'board') {
        clearTimeout(leaveTimer); board.classList.remove('sp-leaving');
        ui.tableWrap.setAttribute('data-ae-spread', 'hidden');
        board.classList.add('sp-on');
        size();
        if (deal) dealPending = true;
        if (data) paint(); else renderState();
        if (S.refreshDue({ shown: true, busy, hidden: document.hidden, last: lastTry, every: S.OPEN_REFRESH_MS }, Date.now())) load();
      } else if (board.classList.contains('sp-on') && !board.classList.contains('sp-leaving')) {
        // Fade the board out (120 ms), then show Portal's table with no animation. Clicking Board meanwhile cancels this.
        board.classList.add('sp-leaving');
        const fin = () => {
          clearTimeout(leaveTimer); board.removeEventListener('animationend', onEnd);
          if (!board.classList.contains('sp-leaving')) return; // Board was clicked again meanwhile
          board.classList.remove('sp-leaving', 'sp-on', 'sp-deal');
          if (ui) ui.tableWrap.removeAttribute('data-ae-spread');
        };
        const onEnd = (e) => { if (e.target === board) fin(); }; // the cards' own animations bubble up here too
        board.addEventListener('animationend', onEnd);
        leaveTimer = setTimeout(fin, 400); // if the animation never reports back (hidden tab)
      } else if (!board.classList.contains('sp-leaving')) {
        board.classList.remove('sp-on'); ui.tableWrap.removeAttribute('data-ae-spread');
      }
    }

    // ------------------------------------------------------------ cards
    const cardEl = (c) => {
      const el = h('a', { class: 'sp-card', href: c.href, 'data-wo': String(c.id) });
      el.addEventListener('click', (e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // new tab / window keep normal link behavior
        e.preventDefault();
        // Same-page route change, as Portal's own links do (its router follows popstate); Back returns to this page and view.
        const idx = ((history.state && history.state.idx) || 0) + 1;
        history.pushState({ usr: null, key: Math.random().toString(36).slice(2, 10), idx }, '', c.href);
        dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
      });
      return el;
    };
    const edgeOf = (name) => (AE.rowColors && AE.rowColors.edge(name)) || '#c9c9d0'; // Rainbow Drip's colour for the status; neutral when it's off
    function fillCard(el, c) {
      const sig = [c.href, c.device, c.customer, c.issue, c.program, c.bin, c.statusName, c.showStatus, c.attention, c.reasons.join('|'), c.time, c.old, c.since && c.since.kind, edgeOf(c.statusName)].join('\u0001');
      if (el.dataset.sig === sig) return;
      el.dataset.sig = sig;
      el.style.setProperty('--edge', edgeOf(c.statusName));
      el.setAttribute('aria-label', 'Work order ' + c.id + (c.device ? ', ' + c.device : '') + (c.customer ? ', ' + c.customer : '') + (c.statusName ? ', ' + c.statusName : ''));
      el.replaceChildren(...[
        h('div', { class: 'sp-r1' }, h('span', { class: 'sp-wo' }, String(c.id)), h('span', { class: 'sp-spacer' }),
          c.attention ? h('span', { class: 'sp-att ' + c.attention, title: c.reasons.length ? c.reasons.join(', ') : 'Needs attention', html: ICON.warn + (c.attention === 'urgent' ? 'Urgent' : 'Attention') }) : null),
        c.device ? h('div', { class: 'sp-dev', title: c.device }, c.device) : null,
        h('div', { class: 'sp-cust' }, h('span', { class: 'n' }, c.customer), h('span', { class: 'sp-as' })),
        c.issue ? h('div', { class: 'sp-issue', title: c.issue }, c.issue) : null,
        c.showStatus && c.statusName ? h('div', { class: 'sp-st' }, c.statusName) : null,
        h('div', { class: 'sp-meta' }, c.program ? h('span', { class: 'sp-prog', title: c.program }, c.program) : null,
          c.bin ? h('span', { class: 'sp-bin', html: ICON.bin }, 'Bin ' + c.bin) : null, h('span', { class: 'sp-wm', style: 'display:contents' })),
        c.time ? h('div', { class: 'sp-foot' }, h('span', { class: 'sp-age' + (c.old ? ' old' : ''), title: c.old ? (c.since.kind === 'status' ? 'Over ' + S.OLD_HOURS + ' hours in this status' : 'Not updated for over ' + S.OLD_HOURS + ' hours') : null, html: ICON.clock }, c.time)) : null].filter(Boolean));
    }
    // Waymark's tag chips and Assize's mark, from those shards when they're on (nothing is re-implemented here).
    function decorate(el, id) {
      const as = el.querySelector('.sp-as');
      if (as) {
        const mk = AE.assize && AE.assize.mark ? AE.assize.mark(id) : null, key = mk ? mk.className + mk.title + mk.textContent : '';
        if (as.dataset.k !== key) { as.dataset.k = key; as.replaceChildren(...(mk ? [mk] : [])); }
      }
      const wm = el.querySelector('.sp-wm'), W = AE.waymark;
      if (wm) {
        const on = AE.settings.crystals.waymark !== false && (AE.settings.waymarkList || {}).chips !== false && W && W.configured();
        const tags = on ? W.tagsOf(id) : [], key = tags.map((t) => t.tag).join('\u0001');
        if (wm.dataset.k !== key) {
          wm.dataset.k = key;
          if (tags.length) W.ensureCss();
          wm.replaceChildren(...tags.map((t) => W.chip(t.tag, { cls: 'ae-chip mini', title: t.tag })));
        }
      }
    }

    // ------------------------------------------------------------ painting
    function paint() {
      if (!ui || !data) return;
      const now = AE.now(), lay = S.layout(data.rows, now), deal = dealPending;
      dealPending = false;
      if (deal) { ui.board.classList.remove('sp-deal'); void ui.board.offsetWidth; ui.board.classList.add('sp-deal'); clearTimeout(dealTimer); dealTimer = setTimeout(() => ui && ui.board.classList.remove('sp-deal'), 900); }
      lay.forEach((col, ci) => {
        const u = ui.cols[ci], hd = S.header(col, col.cards, rfp);
        if (u.count.textContent !== String(hd.count)) u.count.textContent = hd.count;
        if (u.rfpEl) {
          u.rfpEl.hidden = !hd.rfp;
          if (hd.rfp && u.rfpEl.dataset.k !== hd.rfp) { u.rfpEl.dataset.k = hd.rfp; u.rfpEl.replaceChildren('RFP total ', h('b', null, hd.rfp.slice('RFP total '.length))); }
          u.rfpEl.title = hd.rfp && rfp && rfp.updatedAt ? 'From the work order tracker, updated ' + new Date(rfp.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
        }
        const keep = new Set();
        col.cards.forEach((c, ri) => {
          keep.add(c.id);
          let el = u.cards.get(c.id), fresh = false;
          if (!el) { el = cardEl(c); u.cards.set(c.id, el); fresh = true; }
          fillCard(el, c);
          el.style.setProperty('--d', S.dealDelay(ci, ri) + 'ms');
          const at = u.list.children[ri + (u.empty ? 1 : 0)];
          if (at !== el) u.list.insertBefore(el, at || null);
          if (fresh && !deal) { el.classList.add('sp-new'); el.addEventListener('animationend', () => el.classList.remove('sp-new'), { once: true }); }
          decorate(el, c.id);
        });
        for (const [id, el] of u.cards) if (!keep.has(id)) { el.remove(); u.cards.delete(id); }
        if (!col.cards.length && !u.empty) { u.empty = h('div', { class: 'sp-empty' }, 'Nothing here'); u.list.prepend(u.empty); }
        else if (col.cards.length && u.empty) { u.empty.remove(); u.empty = null; }
      });
      renderState();
    }
    // The line under the caption: loading, Portal down, a failed refresh (the last good board stays), or no open work orders.
    let stateKey = '';
    function renderState() {
      if (!ui) return;
      const at = data && new Date(data.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      let key, kids = null;
      if (AE.health.down()) { key = 'down' + (data ? at : ''); kids = [data ? "Portal isn't answering right now, so this may be out of date (last updated " + at + '). Spread will try again on its own.' : "Portal isn't answering right now. Spread will load the board when it's back."]; }
      else if (err) {
        key = 'err' + (data ? at : '');
        kids = [data ? "Couldn't refresh the board just now (showing the list from " + at + '). If you keep seeing this, ' : "Couldn't read the work order list. If you keep seeing this, ",
          AE.bugLinkEl('report a bug', { where: 'Spread', error: 'list: ' + String((err && err.message) || err).slice(0, 300) }), '!'];
      }
      else if (!data) { key = 'load'; kids = ['Loading work orders…']; }
      else if (!data.rows.length) { key = 'zero'; kids = ['There are no open work orders right now.']; }
      else key = '';
      if (key === stateKey) return;
      stateKey = key;
      ui.state.replaceChildren(...(kids || []));
    }

    // ------------------------------------------------------------ loading
    async function load() {
      if (busy) return;
      busy = true; lastTry = Date.now();
      try {
        const rows = await S.read();
        data = { rows, at: Date.now() }; err = null;
        loadRfp();
      } catch (e) {
        if (e instanceof AE.Stopped) return; // Portal switched store under this page: nothing to show or report
        err = e; AE.noteError('spread', e);
      } finally { busy = false; if (ui) { if (shown()) paint(); else renderState(); } }
    }
    function loadRfp() {
      if (!AE.tracker || !AE.tracker.configured()) return;
      AE.tracker.rfp().then((d) => { if (d && Number.isFinite(d.value)) { rfp = { value: d.value, updatedAt: d.updatedAt || null }; if (shown()) paint(); } })
        .catch((e) => console.warn('[' + AE_NAME + '] Spread RFP total:', (e && e.message) || e));
    }

    // ------------------------------------------------------------ keeping the page in step
    function sync() {
      const here = live() && onPage();
      if (!here) { if (ui) teardown(); wasOnPage = false; return; }
      if (ui && !intact()) { if (ui.pt.isConnected && !anchors()) return; teardown(); } // Portal is mid-redraw: wait for its anchors
      if (!ui) {
        if (!mount()) return;
        if (!wasOnPage) { wasOnPage = true; if (view === 'board') dealPending = true; } // entering the page opens the board with the deal-in
        apply(false);
      }
    }
    AE.onDom(sync);
    AE.every(1000, () => {
      sync();
      if (!ui) return;
      if (shown()) {
        size();
        if (S.refreshDue({ shown: true, busy, hidden: document.hidden, last: lastTry, every: S.REFRESH_MS }, Date.now())) load();
        else renderState();
        if (data) for (const u of ui.cols) for (const [id, el] of u.cards) decorate(el, id);
      }
    });
    addEventListener('resize', size);
    AE.trackDaily('spread:on');
  },
});
