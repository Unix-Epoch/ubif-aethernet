/*
  Tactician — Portal's Store time sheet (/admin/my-store/store-time-sheet), one store at a time.

  Portal's page lists every store's punches together: Punch Detail has a Store column, and
  Weekly Summary merges a person's hours across stores with no store at all. Tactician adds,
  above Portal's tabs:
    · Store chips (each store with its headcount, plus All stores; starts on the store you're
      signed into). Portal's own tables are filtered to that store: Punch Detail by its Store
      column, Weekly Summary to the people who worked there (its Totals row is hidden while
      filtered, since Portal adds up every store).
    · Weekly breakdown (collapsed to the chip row's summary unless opened; remembered per browser):
      each person's hours per day Mon–Sun, worked here, breaks,
      overtime and hours left before overtime. Overtime = hours over 40 in the week, counting
      every store the person worked at (Garrett, Oct 12, 2026: weekly only; managers only need
      overtime flagged). Floaters show their hours at the other stores.
  Portal's main area clips overflow (its table box is sized to the window), so while Tactician is on the
  page the main area scrolls (class ae-ts-scroll); Portal's table keeps its own scrolling.
  Same data and rules as Portal's page: GET /api/store-time-sheet?fromDate&toDate (the week on
  screen, Monday to Sunday) → rows of punches { userId, username, storeId, storeName,
  clockTypeId (2 = break), timeIn, timeOut }; a punch still open counts up to now. Read only.
*/
/*
  Tactician's store-wide parts, outside the crystal so Settings can use them:
    · General manager(s) of this location: a store setting on the tracker (GET/PUT …/settings/gm), picked by
      anyone with Store time sheet access (Portal's own manager gate for that page). Portal's roles aren't used:
      Garrett, Oct 12, 2026: "Portal roles are often not set up properly". Store setup will set it too.
    · Punches and sales for a date range, shared by the Store time sheet page and the Reports card.
*/
AE.tactician = (() => {
  const { h } = AE;
  const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const monday = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
  let access = null, settings = null, settingsAt = 0;
  async function canManage() {
    if (access) return access;
    try { const j = await AE.api('GET', '/api/store-time-sheet/access'); access = { ok: !!(j && j.allowed) }; } catch (_) { access = { ok: false }; }
    return access;
  }
  async function storeId() { const p = await AE.profile(); return p.storeId; }
  async function loadSettings(force) {
    if (!AE.tracker || !AE.tracker.configured()) return {};
    if (!force && settings && Date.now() - settingsAt < 5 * 60000) return settings;
    settings = await AE.tracker.call('GET', '/v1/' + (await storeId()) + '/tracker/settings');
    settingsAt = Date.now();
    return settings;
  }
  const gmIds = async () => new Set(((await loadSettings().catch(() => ({}))).gm || {}).userIds || []);
  async function saveGm(userIds, names) {
    const p = await AE.profile();
    const j = await AE.tracker.call('PUT', '/v1/' + p.storeId + '/tracker/settings/gm', { userIds, names, by: p.name });
    settings = Object.assign({}, settings, { gm: Object.assign(j.gm, { by: p.name, at: new Date().toISOString() }) }); settingsAt = Date.now();
    AE.emit('tactician-gm', settings.gm);
    return j.gm;
  }

  // Punches for [from, to] (YYYY-MM-DD), a week at a time; finished weeks are cached in this browser per store.
  const WEEK_KEY = 'ae_ts_weeks';
  async function punches(from, to, fresh) {
    const store = await storeId(), cache = GM_getValue(WEEK_KEY, {}), today = ymd(new Date()), out = [];
    const mine = cache[store] || (cache[store] = {});
    for (let w = monday(new Date(from + 'T12:00:00')); ymd(w) <= to; w.setDate(w.getDate() + 7)) {
      const start = ymd(w), endD = new Date(w); endD.setDate(endD.getDate() + 6); const end = ymd(endD);
      const done = end < today, hit = mine[start];
      let rows;
      // Reuse: this week and weeks that ended in the last 14 days (when punches get fixed) for 10 minutes,
      // older weeks for a day. fresh = re-read everything (the card's Refresh).
      const recent = !done || Date.now() - Date.parse(end + 'T23:59:59') < 14 * 86400000;
      if (!fresh && hit && Date.now() - hit.at < (recent || !hit.done ? 10 * 60000 : 24 * 3600000)) rows = hit.rows;
      else {
        const j = await AE.api('GET', '/api/store-time-sheet?fromDate=' + start + '&toDate=' + end);
        rows = ((j && j.rows) || []).map((r) => ({ u: r.userId, n: r.username, s: r.storeId, c: r.clockTypeId, i: r.timeIn, o: r.timeOut })); // only what's needed
        mine[start] = { at: Date.now(), done, rows };
      }
      out.push(...rows);
    }
    const keep = Object.keys(mine).sort().slice(-30); for (const k of Object.keys(mine)) if (!keep.includes(k)) delete mine[k]; // ~7 months
    GM_setValue(WEEK_KEY, cache);
    return out;
  }
  async function people(weeks = 6) {
    const store = await storeId(), to = new Date(), from = new Date(); from.setDate(from.getDate() - weeks * 7);
    const m = new Map();
    for (const p of await punches(ymd(from), ymd(to))) if (p.s === store && !m.has(p.u)) m.set(p.u, p.n || 'User ' + p.u);
    return [...m].map(([id, name]) => ({ id, name })).sort((a, b) => (a.name > b.name ? 1 : -1));
  }

  // Settings → Tactician: "General manager of this location".
  function gmEditor() {
    const root = h('div', { class: 'sg-ts-gm' }, h('div', { class: 'sg-soft', style: 'margin-top:8px' }, 'Loading…'));
    if (!AE.tracker || !AE.tracker.configured()) { root.replaceChildren(h('div', { class: 'sg-soft', style: 'margin-top:8px' }, 'Needs the work order tracker (not in this build).')); return root; }
    Promise.all([loadSettings(true), canManage()]).then(async ([st, can]) => [st, can, can.ok ? await people() : []]).then(([st, can, list]) => { // the time sheet is managers-only
      const cur = new Set(((st.gm || {}).userIds) || []), names = Object.assign({}, (st.gm || {}).names);
      for (const id of cur) if (!list.some((p) => p.id === id)) list.push({ id, name: names[id] || 'User ' + id });
      const sel = new Set(cur), status = h('span', { class: 'sg-soft' });
      const draw = () => root.replaceChildren(...[
        h('div', { style: 'margin:8px 0 4px' }, h('b', null, 'General manager of this location'),
          h('span', { class: 'sg-soft', style: 'display:block' }, 'Left out of sales per labor hour when "Leave out general managers" is on (Reports page). Set for everyone at the store.')),
        can.ok ? h('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin:6px 0' }, list.length ? list.map((p) => h('button', { type: 'button', class: 'sg-btn' + (sel.has(p.id) ? ' sg-primary' : ''), style: 'height:30px;font-size:13px',
          'aria-pressed': String(sel.has(p.id)), onclick: () => { if (sel.has(p.id)) sel.delete(p.id); else sel.add(p.id); names[p.id] = p.name; draw(); } }, p.name)) : h('span', { class: 'sg-soft' }, 'Nobody has clocked in here in the last 6 weeks.'))
          : h('div', { class: 'sg-soft' }, cur.size ? [...cur].map((id) => names[id] || 'User ' + id).join(', ') : 'Not set. A manager (someone with Store time sheet access) can set it.'),
        can.ok ? h('div', { class: 'sg-actions', style: 'margin-top:4px' }, h('button', { type: 'button', class: 'sg-btn sg-primary', onclick: async (e) => {
          e.target.disabled = true; status.textContent = 'Saving…';
          try { const g = await saveGm([...sel], Object.fromEntries([...sel].map((id) => [id, names[id] || (list.find((p) => p.id === id) || {}).name || null]))); st.gm = settings.gm; cur.clear(); g.userIds.forEach((id) => cur.add(id)); status.textContent = ''; draw(); AE.toast('Tactician', 'General manager saved for everyone at the store.', 'ok'); }
          catch (err) { status.textContent = ''; AE.toast("Couldn't save", err.message || String(err), 'err'); }
          e.target.disabled = false;
        } }, 'Save general manager'), status) : null,
        st.gm && st.gm.by ? h('div', { class: 'sg-soft', style: 'margin-top:4px;font-size:12px' }, 'Last set by ' + st.gm.by + (st.gm.at ? ' · ' + new Date(st.gm.at).toLocaleDateString() : '')) : null].filter(Boolean));
      draw();
    }).catch((e) => root.replaceChildren(h('div', { class: 'sg-soft', style: 'margin-top:8px' }, "Couldn't load: " + (e.message || e))));
    return root;
  }
  const summary = () => { const g = settings && settings.gm; return g && g.userIds && g.userIds.length ? 'General manager: ' + g.userIds.map((id) => (g.names || {})[id] || id).join(', ') : 'General manager not set'; };

  return { ymd, monday, canManage, loadSettings, gmIds, saveGm, punches, people, gmEditor, summary };
})();

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
      .${ROW} .sum { margin-left:auto; color:var(--aui-on-surface-soft, #5d5e61); font-size:13px; }
      .${ROW} button.tog { border-color:transparent; padding:0 10px; color:var(--aui-primary, #8223d2); font-weight:600; }
      .${ROW} button.tog svg { transition:transform .15s; } .${ROW} button.tog[aria-expanded="true"] svg { transform:rotate(180deg); }
      .${BOX} { border:1px solid var(--aui-outline-soft, #e4e2e8); border-radius:12px; margin:0 0 16px; background:var(--aui-surface, #fff); }
      .${BOX}[hidden] { display:none; }
      .${BOX} .hd { padding:12px 18px; font-size:15px; }
      /* Portal's main area clips overflow (its table box is sized to the window): let the page scroll while Tactician adds to it */
      main.ae-ts-scroll { overflow-y:auto !important; }
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
      if (!box) box = h('div', { id: BOX, class: BOX });
      const open = !!GM_getValue(OPEN_KEY, false); // collapsed unless you opened it (keeps room for Portal's table)
      box.hidden = !open;
      const main = strip.closest('main'); if (main && !main.classList.contains('ae-ts-scroll')) main.classList.add('ae-ts-scroll');
      if (row.nextElementSibling !== box || box.nextElementSibling !== strip) { strip.before(row); strip.before(box); }

      if (failed) { row.replaceChildren(h('span', { class: 'lbl' }, "Tactician couldn't load this week's punches: " + failed)); box.replaceChildren(); filter(); return; }
      if (!rows) { row.replaceChildren(h('span', { class: 'lbl' }, 'Loading stores…')); box.replaceChildren(); return; }
      const list = stores();
      if (store != null && !list.some((s) => s.id === store)) store = list.length === 1 ? list[0].id : store;
      const label = (s) => s.name + ' (#' + s.id + ')';
      const chip = (id, text, n) => h('button', { type: 'button', 'aria-pressed': String(store === id), onclick: () => { store = id; AE.track('timeSheet:store'); draw(); } }, text, n != null ? h('small', null, n + (n === 1 ? ' person' : ' people')) : null);
      const people = breakdown(), cur = list.find((s) => s.id === store);
      const where = cur ? label(cur) : 'All stores', tot = { day: Array(7).fill(0), here: 0, breaks: 0, ot: 0 };
      for (const u of people) { u.day.forEach((x, i) => { tot.day[i] += x; }); tot.here += u.here; tot.breaks += u.breaks; tot.ot += u.ot; }
      const start = new Date(weekKey + 'T00:00:00'), end = new Date(start); end.setDate(end.getDate() + 6);
      const span = MONTHS[start.getMonth()] + ' ' + start.getDate() + '–' + (end.getMonth() !== start.getMonth() ? MONTHS[end.getMonth()] + ' ' : '') + end.getDate();
      const otPeople = people.filter((u) => u.ot > 0).length;
      const toggle = h('button', { type: 'button', class: 'tog', 'aria-expanded': String(open), 'aria-controls': BOX,
        onclick: () => { GM_setValue(OPEN_KEY, !open); AE.track('timeSheet:' + (open ? 'hide' : 'show')); draw(); } },
        open ? 'Hide weekly breakdown' : 'Show weekly breakdown', h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', html: '<path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2"/>' }));
      row.replaceChildren(h('span', { style: 'line-height:0', title: 'Tactician (Aethernet)', html: AE.actionIcon('timeSheet', 20) }), h('span', { class: 'lbl' }, 'Store'),
        ...list.map((s) => chip(s.id, label(s), s.people.size)), list.length > 1 ? chip(null, 'All stores') : null,
        h('span', { class: 'sum' }, fmt(tot.here) + ' worked · ' + (tot.ot ? fmt(tot.ot) + ' overtime (' + otPeople + (otPeople === 1 ? ' person' : ' people') + ')' : 'no overtime')), toggle);
      box.replaceChildren(
        h('div', { class: 'hd' }, h('b', null, 'Weekly breakdown'), ' · ' + where + ' · week of ' + span),
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

    /*
      Reports page (/reporting/metrics): "Sales per labor hour" under Portal's KPIs (after Divination's
      cleaning history when that's there). Per day: the tracker's daily sales (Portal's figures; estimated
      days are marked) ÷ hours clocked in at this store (regular punches; breaks not counted). A punch still
      open counts up to now only today; an open punch on a past day (a forgotten clock-out) is left out and
      noted. "Leave out general managers" drops the store's general managers' hours (Settings → Tactician);
      remembered in this browser. Needs Store time sheet access and the work order tracker.
    */
    const RP = 'ae-splh', GM_KEY = 'ae_splh_gm', RANGE_KEY = 'ae_splh_range';
    // Target ranges (Garrett, Oct 12, 2026): ~$160–180 per labor hour leaving out general managers, ~$145–165 counting them.
    const TARGET = { withoutGm: [160, 180], withGm: [145, 165] };
    const RANGES = [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['month', 'This month'], ['lastmonth', 'Last month'], ['90', 'Last 90 days']];
    const rangeDates = (r) => {
      const t = new Date(); t.setHours(0, 0, 0, 0);
      if (r === 'month') return [new Date(t.getFullYear(), t.getMonth(), 1), t];
      if (r === 'lastmonth') return [new Date(t.getFullYear(), t.getMonth() - 1, 1), new Date(t.getFullYear(), t.getMonth(), 0)];
      const f = new Date(t); f.setDate(f.getDate() - Number(r) + 1); return [f, t];
    };
    document.head.append(h('style', null, `
      #${RP} { margin-top:24px; padding:20px 24px; border:1px solid var(--aui-outline, #c6c6ca); border-radius:16px; background:var(--aui-surface, #fff); }
      #${RP} .hd { display:flex; align-items:center; gap:10px; margin-bottom:12px; }
      #${RP} .hd b { font-size:20px; } #${RP} .hd .who { margin-left:auto; font-size:13px; }
      #${RP} .ranges { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      #${RP} .ranges .sg-btn { height:30px; font-size:13px; padding:0 12px; }
      #${RP} .gm { margin-left:auto; display:inline-flex; align-items:center; gap:8px; font-size:14px; cursor:pointer; }
      #${RP} .sw { appearance:none; -webkit-appearance:none; width:38px; height:22px; margin:0; border-radius:999px; background:var(--aui-outline, #c6c6ca); position:relative; cursor:pointer; transition:background .15s; }
      #${RP} .sw::after { content:''; position:absolute; top:3px; left:3px; width:16px; height:16px; border-radius:50%; background:#fff; transition:left .15s; }
      #${RP} .sw:checked { background:var(--aui-primary, #8223d2); } #${RP} .sw:checked::after { left:19px; }
      #${RP} .sw:focus-visible { outline:2px solid var(--aui-primary, #8223d2); outline-offset:2px; }
      #${RP} .sum { display:flex; flex-wrap:wrap; gap:28px; margin:16px 0 14px; }
      #${RP} .big { font-size:24px; font-weight:700; font-variant-numeric:tabular-nums; }
      #${RP} .chart { position:relative; height:140px; border-bottom:1px solid var(--aui-outline, #c6c6ca); display:flex; align-items:flex-end; gap:2px; }
      #${RP} .band { position:absolute; left:0; right:0; background:color-mix(in srgb, var(--aui-status-success, #136d31) 12%, transparent);
        border-top:1px dashed var(--aui-status-success, #136d31); border-bottom:1px dashed var(--aui-status-success, #136d31); pointer-events:none; z-index:1; }
      #${RP} .axis .tgt { display:inline-flex; align-items:center; gap:6px; color:var(--aui-status-success, #136d31); font-weight:600; }
      #${RP} .axis .tgt i { width:18px; height:9px; border:1px dashed currentColor; border-width:1px 0; background:color-mix(in srgb, currentColor 12%, transparent); }
      #${RP} .col { flex:1; height:100%; display:flex; align-items:flex-end; min-width:2px; position:relative; }
      #${RP} .ghost { position:absolute; left:0; right:0; bottom:0; border-radius:3px 3px 0 0; border:1.5px dashed var(--aui-primary, #8223d2); border-bottom:0;
        background:color-mix(in srgb, var(--aui-primary, #8223d2) 14%, transparent); pointer-events:none; }
      #${RP} .bar { position:relative; }
      #${RP} .ghoststat .big { color:color-mix(in srgb, var(--aui-primary, #8223d2) 70%, var(--aui-on-surface, #1a1c1e)); }
      #${RP} .bar { width:100%; border-radius:3px 3px 0 0; color:var(--aui-primary, #8223d2); background:currentColor; }
      /* At or over the target: green. Just below it (within 10%) or would have made it with the RFP table picked up: yellow. Otherwise red. */
      #${RP} .bar.good { color:var(--aui-status-success, #136d31); } #${RP} .bar.near { color:#d6a000; } #${RP} .bar.miss { color:var(--aui-status-error, #b91a24); }
      #${RP} .bar.est { background:repeating-linear-gradient(-45deg, currentColor 0 5px, transparent 5px 9px); opacity:.75; }
      #${RP}-tip { position:fixed; z-index:2147483646; transform:translate(-50%, calc(-100% - 12px)); min-width:220px; max-width:340px; padding:10px 12px; border-radius:12px;
        background:#1a1c1e; color:#fff; font:13px/1.45 Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; box-shadow:0 6px 18px #0005; pointer-events:none; }
      #${RP}-tip::after { content:''; position:absolute; left:50%; bottom:-7px; margin-left:-7px; border:7px solid transparent; border-bottom:0; border-top-color:#1a1c1e; } /* the bubble's tail, down to the bar */
      #${RP}-tip .t { font-weight:700; margin-bottom:2px; } #${RP}-tip .s { opacity:.75; font-size:12px; margin-bottom:6px; }
      #${RP}-tip table { width:100%; border-collapse:collapse; margin:0; } #${RP}-tip td { padding:2px 0; border:0; font-variant-numeric:tabular-nums; } #${RP}-tip td + td { text-align:right; padding-left:12px; white-space:nowrap; }
      #${RP}-tip .otb { display:inline-block; background:#b91a24; color:#fff; border-radius:4px; padding:0 5px; font-size:11px; font-weight:700; margin-left:6px; }
      #${RP}-tip .gmt { opacity:.6; font-size:11px; margin-left:4px; } #${RP}-tip .n { opacity:.7; font-size:12px; margin-top:6px; }
      #${RP} .bar.none { background:var(--aui-outline, #c6c6ca); }
      #${RP} .col:hover .bar { filter:brightness(1.15); }
      #${RP} .axis { display:flex; justify-content:space-between; font-size:12px; margin-top:4px; }
      #${RP} details { margin-top:12px; } #${RP} summary { cursor:pointer; color:var(--aui-primary, #8223d2); font-weight:600; }
      #${RP} table { width:100%; border-collapse:collapse; margin-top:8px; font-variant-numeric:tabular-nums; }
      #${RP} th { text-align:left; font-size:12px; color:var(--aui-on-surface-soft, #5d5e61); padding:6px 8px; border-bottom:1px solid var(--aui-outline-soft, #eeedf1); font-weight:400; }
      #${RP} td { padding:6px 8px; border-bottom:1px solid var(--aui-outline-soft, #eeedf1); }
      #${RP} tr.tot td { font-weight:700; }
      .ae-splh-scroll { overflow-y:auto !important; }
    `));
    const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    let range = GM_getValue(RANGE_KEY, '7'), dataFor = null, data = null, busy = null, err = null, shownFor = null, loadedAt = 0, fresh = false;
    const STALE_MS = 10 * 60000; // the card's numbers are refreshed when older than this (on the page or coming back to it)
    async function loadSplh(fresh) {
      const [f, t] = rangeDates(range), from = T.ymd(f), to = T.ymd(t);
      const p = await AE.profile(), store = Number(p.storeId);
      const [sd, ps, gm, rd] = await Promise.all([AE.tracker.call('GET', '/v1/' + store + '/tracker/sales/days?from=' + from + '&to=' + to), T.punches(from, to, fresh), T.gmIds(),
        AE.tracker.call('GET', '/v1/' + store + '/tracker/rfp/days?from=' + from + '&to=' + to).catch(() => ({ days: [] }))]);
      const today = T.ymd(new Date()), days = new Map();
      for (let d = new Date(f); T.ymd(d) <= to; d.setDate(d.getDate() + 1)) days.set(T.ymd(d), { day: T.ymd(d), sales: null, source: null, hours: 0, gmHours: 0, open: 0, rfp: 0, rfpCount: 0, people: new Map() });
      for (const x of sd.days) if (days.has(x.day)) Object.assign(days.get(x.day), { sales: x.total, source: x.source });
      for (const x of rd.days || []) if (days.has(x.day)) Object.assign(days.get(x.day), { rfp: x.value || 0, rfpCount: x.count || 0 }); // the RFP table at the end of the day
      // Each person's hours in order through the week (every store; punches come in whole Mon–Sun weeks), so the
      // overtime in a day's hours is the part past 40 for the week so far.
      const cum = new Map();
      for (const pu of ps.filter((x) => x.c !== 2 && x.i).sort((a, b) => Date.parse(a.i) - Date.parse(b.i))) {
        const day = T.ymd(new Date(pu.i)), d = days.get(day);
        if (!pu.o && day !== today) { if (d && pu.s === store) d.open++; continue; } // a forgotten clock-out on a past day
        const hrs = Math.max(0, ((pu.o ? Date.parse(pu.o) : Date.now()) - Date.parse(pu.i)) / 3600000);
        const wk = pu.u + '|' + T.ymd(T.monday(new Date(pu.i))), before = cum.get(wk) || 0, after = before + hrs;
        cum.set(wk, after);
        if (!d || pu.s !== store) continue;
        const ot = Math.max(0, after - 40) - Math.max(0, before - 40);
        if (gm.has(pu.u)) d.gmHours += hrs; else d.hours += hrs;
        const who = d.people.get(pu.u) || d.people.set(pu.u, { name: pu.n || 'User ' + pu.u, hrs: 0, ot: 0, gm: gm.has(pu.u), open: !pu.o }).get(pu.u);
        who.hrs += hrs; who.ot += ot; if (!pu.o) who.open = true;
      }
      return { from, to, rows: [...days.values()], gmSet: gm.size > 0 };
    }
    // Bar color: at/over the target's low end = good; within 10% below, or over it with the RFP table picked up = near; else miss.
    const grade = (r, lo) => (r.splh >= lo ? 'good' : r.splh >= lo * 0.9 || (r.ghost && r.ghost >= lo) ? 'near' : 'miss');
    // Hover a day: a speech bubble with who worked it (this store), their hours, and overtime in that day's hours.
    function bubble(col, r, leaveOut) {
      document.getElementById(RP + '-tip')?.remove();
      const fmtD = new Date(r.day + 'T12:00:00').toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
      const people = [...r.people.values()].sort((a, b) => b.hrs - a.hrs);
      const tip = h('div', { id: RP + '-tip', role: 'tooltip' },
        h('div', { class: 't' }, fmtD),
        h('div', { class: 's' }, [r.sales != null ? money(r.sales) + ' sales' + (r.source === 'estimated' ? ' (estimated)' : '') : 'No sales data', r.hrs ? r.hrs.toFixed(2) + 'h' : null,
          r.splh != null ? money(r.splh) + '/h' : null, r.ghost ? money(r.ghost) + '/h with the RFP table (' + r.rfpCount + ')' : null].filter(Boolean).join(' · ')),
        people.length ? h('table', null, ...people.map((p) => h('tr', null,
          h('td', null, p.name, p.gm ? h('span', { class: 'gmt' }, leaveOut ? 'GM, left out' : 'GM') : null, p.open ? h('span', { class: 'gmt' }, 'still clocked in') : null),
          h('td', null, p.hrs.toFixed(2) + 'h', p.ot > 0.004 ? h('span', { class: 'otb' }, fmtOt(p.ot) + ' OT') : null))))
          : h('div', { class: 'n' }, 'Nobody clocked in here.'),
        r.open ? h('div', { class: 'n' }, r.open + ' punch' + (r.open === 1 ? '' : 'es') + ' without a clock-out not counted') : null);
      document.body.append(tip);
      const rc = col.getBoundingClientRect(), top = Math.min(...[col.querySelector('.ghost'), col.querySelector('.bar')].filter(Boolean).map((x) => x.getBoundingClientRect().top));
      const left = Math.min(Math.max(rc.left + rc.width / 2, tip.offsetWidth / 2 + 8), innerWidth - tip.offsetWidth / 2 - 8);
      tip.style.left = left + 'px'; tip.style.top = Math.max(top, tip.offsetHeight + 20) + 'px'; // above the taller of the bar and its ghost
    }
    const fmtOt = (x) => { const hh = Math.floor(x), mm = Math.round((x - hh) * 60); return (hh ? hh + 'h ' : '') + (mm || !hh ? mm + 'm' : ''); };
    function splhCard() {
      const leaveOut = !!GM_getValue(GM_KEY, false);
      const card = h('div', { id: RP, class: 'sg' });
      const refresh = h('button', { type: 'button', class: 'sg-btn', style: 'height:28px;font-size:12px;padding:0 10px;margin-left:auto', title: 'Read sales and the time sheet again (after fixing a punch)', disabled: !!busy || null,
        onclick: () => { fresh = true; dataFor = null; data = null; AE.track('timeSheet:splhRefresh'); showSplh(); } }, busy ? 'Refreshing…' : 'Refresh');
      const head = h('div', { class: 'hd' }, h('span', { style: 'line-height:0', html: AE.actionIcon('timeSheet', 32) }), h('b', null, 'Sales per labor hour'), refresh, h('span', { class: 'sg-soft', style: 'font-size:13px' }, 'Tactician · ' + AE_NAME));
      const gmToggle = h('label', { class: 'gm' }, h('input', { type: 'checkbox', class: 'sw', role: 'switch', checked: leaveOut || null, onchange: (e) => { GM_setValue(GM_KEY, e.target.checked); AE.track('timeSheet:splhGm'); showSplh(); } }), 'Leave out general managers');
      const ranges = h('div', { class: 'ranges' }, ...RANGES.map(([k, l]) => h('button', { type: 'button', class: 'sg-btn' + (k === range ? ' sg-primary' : ''), onclick: () => { range = k; GM_setValue(RANGE_KEY, k); dataFor = null; data = null; showSplh(); } }, l)), gmToggle); // no old numbers under a new range
      card.append(head, ranges);
      if (err) { card.append(h('p', { class: 'sg-soft' }, err)); return card; }
      if (!data) { card.append(h('p', { class: 'sg-soft' }, 'Loading sales and hours…')); return card; }
      const rows = data.rows.map((r) => { const hrs = r.hours + (leaveOut ? 0 : r.gmHours); return Object.assign({}, r, { hrs, splh: r.sales != null && hrs > 0 ? r.sales / hrs : null, ghost: r.sales != null && hrs > 0 && r.rfp ? (r.sales + r.rfp) / hrs : null }); });
      const withBoth = rows.filter((r) => r.splh != null), tS = withBoth.reduce((n, r) => n + r.sales, 0), tH = withBoth.reduce((n, r) => n + r.hrs, 0);
      const gmOut = leaveOut ? rows.reduce((n, r) => n + r.gmHours, 0) : 0, best = withBoth.slice().sort((a, b) => b.splh - a.splh)[0];
      const [tLo, tHi] = leaveOut ? TARGET.withoutGm : TARGET.withGm, max = Math.max(best ? best.splh : 0, ...withBoth.map((r) => r.ghost || 0), tHi * 1.1); // room for the target band and ghosts
      const lastRfp = rows.slice().reverse().find((r) => r.rfp || r.rfpCount) || null; // the RFP table at the end of the range
      const ghostAll = lastRfp && tH ? (tS + lastRfp.rfp) / tH : null;
      const atTarget = withBoth.filter((r) => r.splh >= tLo).length;
      const fmtDay = (d) => new Date(d + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
      card.append(
        h('div', { class: 'sum' },
          h('div', null, h('div', { class: 'big' }, tH ? money(tS / tH) : '—'), h('div', { class: 'sg-soft' }, 'per labor hour')),
          h('div', null, h('div', { class: 'big' }, money(tS)), h('div', { class: 'sg-soft' }, 'sales')),
          h('div', null, h('div', { class: 'big' }, tH.toFixed(1) + 'h'), h('div', { class: 'sg-soft' }, 'labor' + (leaveOut ? (data.gmSet ? ' (general managers left out: ' + gmOut.toFixed(1) + 'h)' : ' (no general manager set: Settings → Tactician)') : ''))),
          best ? h('div', null, h('div', { class: 'big' }, money(best.splh)), h('div', { class: 'sg-soft' }, 'best day · ' + fmtDay(best.day))) : null,
          ghostAll ? h('div', { class: 'ghoststat' }, h('div', { class: 'big' }, money(ghostAll)), h('div', { class: 'sg-soft' }, 'if the RFP table were picked up (' + lastRfp.rfpCount + ' devices, ' + money(lastRfp.rfp) + ')')) : null,
          h('div', null, h('div', { class: 'big' }, atTarget + ' of ' + withBoth.length), h('div', { class: 'sg-soft' }, 'days at target ($' + tLo + '–$' + tHi + (leaveOut ? ', without GM' : ', with GM') + ')'))),
        h('div', { class: 'chart' }, h('div', { class: 'band', style: 'bottom:' + (tLo / max * 100) + '%;height:' + ((tHi - tLo) / max * 100) + '%', title: 'Target: $' + tLo + '–$' + tHi + ' per labor hour' }), ...rows.map((r) => h('div', { class: 'col', onmouseenter: (e) => bubble(e.currentTarget, r, leaveOut), onmouseleave: () => document.getElementById(RP + '-tip')?.remove() },
          r.ghost ? h('div', { class: 'ghost', style: 'height:' + Math.round(r.ghost / max * 100) + '%' }) : null,
          h('div', { class: 'bar' + (r.splh == null ? ' none' : ' ' + grade(r, tLo)) + (r.splh != null && r.source === 'estimated' ? ' est' : ''), style: 'height:' + (r.splh != null ? Math.max(2, Math.round(r.splh / max * 100)) : 2) + '%' })))),
        h('div', { class: 'axis sg-soft' }, h('span', null, fmtDay(data.from)), h('span', { class: 'tgt' }, h('i'), 'Target $' + tLo + '–$' + tHi + (leaveOut ? ' without GM' : ' with GM')), h('span', null, fmtDay(data.to))),
        h('details', { class: 'days' }, h('summary', null, 'Days'),
          h('table', null, h('tr', null, ['Day', 'Sales', 'Labor hours', 'Per labor hour', 'If RFP picked up', ''].map((x) => h('th', null, x))),
            ...rows.slice().reverse().map((r) => h('tr', null, h('td', null, fmtDay(r.day)), h('td', null, r.sales != null ? money(r.sales) : '—'), h('td', null, r.hrs ? r.hrs.toFixed(2) + 'h' : '—'),
              h('td', null, h('b', null, r.splh != null ? money(r.splh) : '—')),
              h('td', { class: 'sg-soft', title: r.rfpCount ? r.rfpCount + ' devices on the RFP table at the end of the day, ' + money(r.rfp) : null }, r.ghost ? money(r.ghost) : '—'),
              h('td', { class: 'sg-soft' }, [r.source === 'estimated' ? 'Sales estimated from work orders' : null, leaveOut && r.gmHours ? 'GM ' + r.gmHours.toFixed(2) + 'h left out' : null,
                r.open ? r.open + ' punch' + (r.open === 1 ? '' : 'es') + ' without a clock-out not counted' : null, r.sales == null && !r.hrs ? 'Closed or no data' : null].filter(Boolean).join(' · ')))),
            h('tr', { class: 'tot' }, h('td', null, 'Total'), h('td', null, money(tS)), h('td', null, tH.toFixed(2) + 'h'), h('td', null, tH ? money(tS / tH) : '—'), h('td', null, ghostAll ? money(ghostAll) : '—'), h('td'))),
          h('p', { class: 'sg-soft', style: 'font-size:12px;margin:8px 0 0' }, 'Sales = Portal\'s daily sales (partner credits included; striped days are estimated from work orders). Labor = hours clocked in at this store, breaks not counted, from the Store time sheet. Days without both aren\'t in the totals. Ghost bars = that day\'s sales plus everything on the RFP table at the end of the day (value before tax, partner credits ignored), as if it had all been picked up; for the range, the RFP table at its end.')));
      return card;
    }
    function showSplh() {
      const reports = document.querySelector('.reports-card'), home = reports && reports.parentElement;
      const old = document.getElementById(RP);
      if (!home) { old?.remove(); return; }
      const open = old && old.querySelector('details.days') && old.querySelector('details.days').open;
      const card = splhCard(); if (open && card.querySelector('details.days')) card.querySelector('details.days').open = true;
      const after = document.getElementById('sg-rate-history');
      if (old) old.replaceWith(card); else if (after && after.parentElement === home) after.after(card); else home.append(card);
      const key = range;
      if (!busy && (dataFor !== key || Date.now() - loadedAt > STALE_MS)) {
        const f = fresh; fresh = false;
        busy = loadSplh(f).then((d) => { if (range === key) { data = d; err = null; } dataFor = key; loadedAt = Date.now(); }, (e) => { err = /session expired/i.test(e.message || '') ? 'Sales per labor hour needs Store time sheet access.' : "Couldn't load: " + (e.message || e); dataFor = key; loadedAt = Date.now(); })
          .finally(() => { busy = null; if (document.getElementById(RP)) showSplh(); }); // (a range picked meanwhile loads next)
      }
    }
    const T = AE.tactician;
    AE.on('tactician-gm', () => { dataFor = null; if (document.getElementById(RP)) showSplh(); });
    T.canManage().then((a) => {
      if (!a.ok || !AE.tracker || !AE.tracker.configured()) return; // managers only (time sheet access), and needs the tracker
      AE.every(1000, () => {
        if (!/^\/reporting\/metrics/.test(location.pathname)) { shownFor = null; document.querySelectorAll('.ae-splh-scroll').forEach((x) => x.classList.remove('ae-splh-scroll')); return; }
        const reports = document.querySelector('.reports-card');
        if (reports && (!document.getElementById(RP) || shownFor !== reports || (!busy && Date.now() - loadedAt > STALE_MS))) { shownFor = reports; showSplh(); }
        const card = document.getElementById(RP); // Portal's Reports page clips anything taller than the window: let it scroll
        for (let x = card && card.parentElement; x; x = x.parentElement) {
          const oy = getComputedStyle(x).overflowY, over = x.scrollHeight > x.clientHeight + 1;
          if (over && (oy === 'auto' || oy === 'scroll')) break;
          if (over && (oy === 'hidden' || oy === 'clip')) { x.classList.add('ae-splh-scroll'); break; }
        }
      });
    });

    let lastPath = '';
    AE.onDom(() => {
      if (!PATH.test(location.pathname)) {
        if (lastPath) { document.getElementById(ROW)?.remove(); document.getElementById(BOX)?.remove(); document.querySelectorAll('main.ae-ts-scroll').forEach((m) => m.classList.remove('ae-ts-scroll')); document.querySelectorAll('tr[' + HIDE + ']').forEach((t) => t.removeAttribute(HIDE)); lastPath = ''; }
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
