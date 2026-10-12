/*
  Tactician — Portal's Store time sheet (/admin/my-store/store-time-sheet), one store at a time.

  Portal's page lists every store's punches together: Punch Detail has a Store column, and
  Weekly Summary merges a person's hours across stores with no store at all. Tactician adds,
  above Portal's tabs:
    · Store chips (each store with its headcount, plus All stores; starts on the store you're
      signed into). Portal's own tables are filtered to that store: Punch Detail by its Store
      column, Weekly Summary to the people who worked there (its Totals row is hidden while
      filtered, since Portal adds up every store).
    · Weekly breakdown (collapsible): each person's hours per day Mon–Sun, worked here, breaks,
      overtime and hours left before overtime. Overtime = hours over 40 in the week, counting
      every store the person worked at (Garrett, Oct 12, 2026: weekly only; managers only need
      overtime flagged). Floaters show their hours at the other stores.
  Same data and rules as Portal's page: GET /api/store-time-sheet?fromDate&toDate (the week on
  screen, Monday to Sunday) → rows of punches { userId, username, storeId, storeName,
  clockTypeId (2 = break), timeIn, timeOut }; a punch still open counts up to now. Read only.
*/
AE.crystal({
  id: 'timeSheet',
  name: 'Tactician',
  sites: ['portal.ubreakifix.net'],
  run() {
    const { h } = AE;
    const PATH = /^\/admin\/my-store\/store-time-sheet\/?$/, ROW = 'ae-ts-row', BOX = 'ae-ts-box', HIDE = 'data-ae-ts-hide', OPEN_KEY = 'ae_ts_open';
    const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    document.head.append(h('style', null, `
      .${ROW} { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin:4px 0 14px; }
      .${ROW} .lbl { font-size:14px; color:var(--aui-on-surface-soft, #5d5e61); margin-right:4px; }
      .${ROW} button { display:inline-flex; align-items:center; gap:6px; height:34px; padding:0 14px; border-radius:999px; cursor:pointer;
        border:1px solid var(--aui-on-surface, #1a1c1e); background:transparent; color:var(--aui-on-surface, #1a1c1e); font:inherit; font-size:14px; }
      .${ROW} button[aria-pressed="true"] { background:var(--aui-on-surface, #1a1c1e); color:var(--aui-surface, #fff); }
      .${ROW} button small { opacity:.7; }
      .${BOX} { border:1px solid var(--aui-outline-soft, #e4e2e8); border-radius:12px; margin:0 0 16px; background:var(--aui-surface, #fff); }
      .${BOX} > summary { list-style:none; display:flex; align-items:center; gap:10px; padding:14px 18px; font-size:16px; cursor:pointer; }
      .${BOX} > summary::-webkit-details-marker { display:none; }
      .${BOX} > summary .sub { color:var(--aui-on-surface-soft, #5d5e61); font-size:13px; margin-left:auto; }
      .${BOX} > summary .chev { transition:transform .15s; } .${BOX}[open] > summary .chev { transform:rotate(180deg); }
      .${BOX} .wrap { overflow-x:auto; }
      .${BOX} table { width:100%; border-collapse:collapse; font-size:13.5px; }
      .${BOX} th { font-weight:400; color:var(--aui-on-surface-soft, #5d5e61); text-align:right; padding:8px 10px; border-top:1px solid var(--aui-outline-soft, #eee); white-space:nowrap; }
      .${BOX} td { text-align:right; padding:9px 10px; border-top:1px solid var(--aui-outline-soft, #eee); white-space:nowrap; }
      .${BOX} th:first-child, .${BOX} td:first-child { text-align:left; padding-left:18px; }
      .${BOX} td.none { color:var(--aui-on-surface-soft, #9a9aa0); }
      .${BOX} .ot { display:inline-block; background:var(--aui-status-error, #b91a24); color:#fff; border-radius:4px; padding:1px 6px; font-weight:600; }
      .${BOX} .else { color:var(--aui-on-surface-soft, #5d5e61); font-size:12px; }
      .${BOX} tr.tot td { font-weight:700; background:var(--aui-neutral-soft, #faf9fb); }
      .${BOX} .note { font-size:12px; color:var(--aui-on-surface-soft, #5d5e61); padding:10px 18px 14px; }
      tr[${HIDE}] { display:none !important; }
    `));

    const fmt = (x) => { if (!x) return '—'; let hh = Math.floor(x), mm = Math.round((x - hh) * 60); if (mm === 60) { hh++; mm = 0; } return hh + 'h ' + String(mm).padStart(2, '0') + 'm'; };
    const hoursOf = (p) => Math.max(0, ((p.timeOut ? Date.parse(p.timeOut) : Date.now()) - Date.parse(p.timeIn)) / 3600000); // Portal's own rule (open punch → now)
    const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // The week Portal shows: "Week of Oct 12-18, 2026" or "Week of Sep 28 - Oct 4, 2026" → its Monday.
    function weekShown() {
      const walker = document.createTreeWalker(document.querySelector('main') || document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const m = (n.nodeValue || '').match(/Week of ([A-Z][a-z]{2})[a-z]*\.? (\d{1,2})\s*[–-]\s*(?:([A-Z][a-z]{2})[a-z]*\.? )?(\d{1,2}), (\d{4})/);
        if (!m) continue;
        const sm = MONTHS.indexOf(m[1]), em = m[3] ? MONTHS.indexOf(m[3]) : sm;
        if (sm < 0 || em < 0) continue;
        const year = Number(m[5]) - (em < sm ? 1 : 0); // Dec 29 - Jan 4, 2027 → starts in 2026
        const start = new Date(year, sm, Number(m[2]));
        return isNaN(start) ? null : start;
      }
      return null;
    }
    const tabStrip = () => { const t = [...document.querySelectorAll('[role="tablist"]')].find((x) => /Punch Detail/i.test(x.textContent) && /Weekly Summary/i.test(x.textContent)); return t || null; };

    let store = null, home = null, weekKey = '', rows = null, loading = null, failed = null;
    function load(start) {
      const key = ymd(start);
      if (key === weekKey && (rows || loading)) return;
      weekKey = key; rows = null; failed = null;
      const end = new Date(start); end.setDate(end.getDate() + 6);
      const mine = loading = AE.api('GET', '/api/store-time-sheet?fromDate=' + key + '&toDate=' + ymd(end))
        .then((j) => { if (loading === mine) { rows = (j && j.rows) || []; draw(); } })
        .catch((e) => { if (loading === mine) { failed = e.message || String(e); draw(); } })
        .finally(() => { if (loading === mine) loading = null; });
    }

    function stores() {
      const m = new Map();
      for (const p of rows || []) {
        if (!m.has(p.storeId)) m.set(p.storeId, { id: p.storeId, name: p.storeName || 'Store ' + p.storeId, people: new Set() });
        m.get(p.storeId).people.add(p.userId);
      }
      return [...m.values()].sort((a, b) => (b.id === home) - (a.id === home) || a.id - b.id); // the store you're signed into first
    }

    function breakdown() {
      const people = new Map();
      for (const p of rows || []) {
        if (!p.timeIn) continue;
        const u = people.get(p.userId) || people.set(p.userId, { name: p.username || 'User ' + p.userId, day: Array(7).fill(0), here: 0, all: 0, breaks: 0, elsewhere: new Map(), worked: false }).get(p.userId);
        const hrs = hoursOf(p), here = store == null || p.storeId === store;
        if (p.clockTypeId === 2) { if (here) u.breaks += hrs; continue; }
        u.all += hrs;
        if (here) { u.here += hrs; u.worked = true; u.day[(new Date(p.timeIn).getDay() + 6) % 7] += hrs; }
        else u.elsewhere.set(p.storeName || 'Store ' + p.storeId, (u.elsewhere.get(p.storeName || 'Store ' + p.storeId) || 0) + hrs);
      }
      return [...people.values()].filter((u) => u.worked).sort((a, b) => (a.name > b.name ? 1 : -1))
        .map((u) => Object.assign(u, { ot: Math.max(0, u.all - 40), left: Math.max(0, 40 - u.all) }));
    }

    function draw() {
      const strip = tabStrip();
      if (!strip) return;
      let row = document.getElementById(ROW), box = document.getElementById(BOX);
      if (!row) { row = h('div', { id: ROW, class: ROW }); }
      if (!box) {
        box = h('details', { id: BOX, class: BOX, ontoggle: (e) => GM_setValue(OPEN_KEY, e.currentTarget.open) });
        box.open = GM_getValue(OPEN_KEY, true);
      }
      if (row.nextElementSibling !== box || box.nextElementSibling !== strip) { strip.before(row); strip.before(box); }

      if (failed) { row.replaceChildren(h('span', { class: 'lbl' }, "Tactician couldn't load this week's punches: " + failed)); box.replaceChildren(); filter(); return; }
      if (!rows) { row.replaceChildren(h('span', { class: 'lbl' }, 'Loading stores…')); box.replaceChildren(); return; }
      const list = stores();
      if (store != null && !list.some((s) => s.id === store)) store = list.length === 1 ? list[0].id : store;
      const label = (s) => s.name + ' (#' + s.id + ')';
      const chip = (id, text, n) => h('button', { type: 'button', 'aria-pressed': String(store === id), onclick: () => { store = id; AE.track('timeSheet:store'); draw(); } }, text, n != null ? h('small', null, n + (n === 1 ? ' person' : ' people')) : null);
      row.replaceChildren(h('span', { class: 'lbl' }, 'Store'), ...list.map((s) => chip(s.id, label(s), s.people.size)), list.length > 1 ? chip(null, 'All stores') : null,
        h('span', { style: 'line-height:0;margin-left:2px', title: 'Tactician (Aethernet)', html: AE.actionIcon('timeSheet', 18) }));

      const people = breakdown(), cur = list.find((s) => s.id === store);
      const where = cur ? label(cur) : 'All stores', tot = { day: Array(7).fill(0), here: 0, breaks: 0, ot: 0 };
      for (const u of people) { u.day.forEach((x, i) => { tot.day[i] += x; }); tot.here += u.here; tot.breaks += u.breaks; tot.ot += u.ot; }
      const start = new Date(weekKey + 'T00:00:00'), end = new Date(start); end.setDate(end.getDate() + 6);
      const span = MONTHS[start.getMonth()] + ' ' + start.getDate() + '–' + (end.getMonth() !== start.getMonth() ? MONTHS[end.getMonth()] + ' ' : '') + end.getDate();
      const otPeople = people.filter((u) => u.ot > 0).length;
      box.replaceChildren(
        h('summary', null, h('span', { style: 'line-height:0', html: AE.actionIcon('timeSheet', 20) }), h('b', null, 'Weekly breakdown'), ' · ' + where + ' · week of ' + span,
          h('span', { class: 'sub' }, fmt(tot.here) + ' worked · ' + (tot.ot ? fmt(tot.ot) + ' overtime (' + otPeople + (otPeople === 1 ? ' person' : ' people') + ')' : 'no overtime')),
          h('svg', { class: 'chev', width: 18, height: 18, viewBox: '0 0 24 24', html: '<path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2"/>' })),
        people.length ? h('div', { class: 'wrap' }, h('table', null,
          h('tr', null, h('th', null, 'Employee'), ...DAYS.map((d) => h('th', null, d)), h('th', null, store == null ? 'Worked' : 'Worked here'), h('th', null, 'Breaks'), h('th', null, 'Overtime'), h('th', null, 'Left before OT')),
          ...people.map((u) => h('tr', null,
            h('td', null, h('b', null, u.name), store != null && u.elsewhere.size ? h('div', { class: 'else' }, [...u.elsewhere].map(([n, x]) => '+ ' + fmt(x) + ' at ' + n).join(' · ')) : null),
            ...u.day.map((x) => h('td', { class: x ? null : 'none' }, fmt(x))),
            h('td', null, h('b', null, fmt(u.here))), h('td', null, fmt(u.breaks)),
            h('td', null, u.ot ? h('span', { class: 'ot' }, fmt(u.ot)) : '—'), h('td', null, u.ot ? '—' : fmt(u.left)))),
          h('tr', { class: 'tot' }, h('td', null, (cur ? cur.name : 'All stores') + ' total'), ...tot.day.map((x) => h('td', null, fmt(x))), h('td', null, fmt(tot.here)), h('td', null, fmt(tot.breaks)), h('td', null, tot.ot ? fmt(tot.ot) : '—'), h('td', null))))
          : h('div', { class: 'note' }, 'Nobody clocked in at ' + where + ' this week.'),
        h('div', { class: 'note' }, 'Overtime = hours over 40 in the week, counting every store the person worked at. Same punches as Portal\'s tabs below; nothing is changed.'));
      filter();
    }

    // Portal's tables, filtered to the chosen store (attribute + stylesheet; Portal's rows are never removed).
    function filter() {
      const want = store == null ? null : '(#' + store + ')';
      const here = new Set(store == null ? [] : (rows || []).filter((p) => p.storeId === store).map((p) => String(p.username || 'User ' + p.userId)));
      for (const tr of document.querySelectorAll('main tr, [role="tabpanel"] tr, table tr')) {
        if (tr.closest('#' + BOX)) continue;
        const cells = tr.cells; if (!cells || !cells.length || tr.querySelector('th')) continue;
        const first = (cells[0].textContent || '').trim();
        let hide = false;
        if (want) {
          if (/\(#\d+\)\s*$/.test(first)) hide = !first.endsWith(want); // Punch Detail: Store column
          else if (/^Totals?$/i.test(first)) hide = true; // Weekly Summary's totals add up every store
          else if (rows && first) hide = !here.has(first); // Weekly Summary: people who worked here
        }
        if (hide !== tr.hasAttribute(HIDE)) { if (hide) tr.setAttribute(HIDE, ''); else tr.removeAttribute(HIDE); }
      }
    }

    let lastPath = '';
    AE.onDom(() => {
      if (!PATH.test(location.pathname)) {
        if (lastPath) { document.getElementById(ROW)?.remove(); document.getElementById(BOX)?.remove(); document.querySelectorAll('tr[' + HIDE + ']').forEach((t) => t.removeAttribute(HIDE)); lastPath = ''; }
        return;
      }
      if (!tabStrip()) return;
      if (!lastPath) { lastPath = location.pathname; AE.profile().then((p) => { if (p && p.storeId) { home = Number(p.storeId); if (store == null) store = home; draw(); } }).catch(() => {}); }
      const start = weekShown();
      if (start) load(start);
      if (!document.getElementById(ROW) || tabStrip().previousElementSibling?.id !== BOX) draw(); else filter();
    });
  },
});
