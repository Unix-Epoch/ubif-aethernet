/*
  Tactician — a weekly breakdown on Portal's Store time sheet (/admin/my-store/store-time-sheet), plus sales per labor hour on Reports.

  Portal's Store time sheet page (rewritten Nov 2026) has its own store menu (only with 2+ stores), period buttons and one card
  per store with each person's hours. Tactician adds one slim bar under Portal's controls, above the first store card:
    · the Tactician icon and name, the store it is showing, "N worked · N overtime (N people)" and Show/Hide weekly breakdown;
    · the breakdown box (collapsed by default; open/closed remembered per browser, key ae_ts_open): per person the hours on each
      day of the window, worked here, breaks, overtime and hours left before overtime, "+ Nh at <store>" for floaters, and the store's
      total. Read only. Portal's own cards are never filtered or changed.
  Overtime = hours over 40 in a 7-day week counting every store the person worked at (weekly only; managers only need overtime
  flagged). This differs on purpose from Portal's OT tag, which counts one store at a time: only floaters show a different figure.
  Which store: Portal's store menu; with "All stores" (or no menu, one store) the store you're signed into, named in the bar.
  Which period: read back from what Portal shows (it keeps the period in React state only): the store's card line ("Mon Nov 9 –
  Sun Nov 15"), else the period button when a store is picked or there is no menu ("Nov 9 – Nov 15"). A 14-day period ("Last 2 Wks")
  shows both weeks, overtime per 7-day week. If neither can be read (Portal draws no card for a store without punches, and with
  "All stores" the button only says "This Work Week"), the bar says so and shows no numbers: it never shows a guessed week.
  Data: GET /api/store-time-sheet?fromDate&toDate, the range Portal itself asks for (a Sunday S through S + 6 + days - 1; a store's
  window starts at S + its payPeriodStartDay) → { stores, rows } of punches { userId, username, storeId, storeName, storeTimeZone,
  clockTypeId (2 = break), timeIn, timeOut }; days are the store's calendar days; a punch still open counts up to now.
  Portal's page container scrolls by itself (measured at 1440x900), so nothing is needed to keep the added box in view.
  After a successful load the daily labor numbers are uploaded for the admin Metrics page (AE.tactician.uploadDaily).
*/
/*
  Tactician's store-wide parts, outside the shard so Settings can use them:
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
          catch (err) { status.textContent = ''; AE.toast('Tactician', { html: "Couldn't save the general manager. If you keep seeing this, " + AE.bugLink('report a bug', { where: 'Tactician', error: 'Saving the general manager: ' + (err.message || err) }) + '!' }, 'err'); }
          e.target.disabled = false;
        } }, 'Save general manager'), status) : null,
        st.gm && st.gm.by ? h('div', { class: 'sg-soft', style: 'margin-top:4px;font-size:12px' }, 'Last set by ' + st.gm.by + (st.gm.at ? ' · ' + new Date(st.gm.at).toLocaleDateString() : '')) : null].filter(Boolean));
      draw();
    }).catch((e) => root.replaceChildren(h('div', { class: 'sg-soft', style: 'margin-top:8px' }, "Couldn't load the general manager setting. If you keep seeing this, ", AE.bugLinkEl('report a bug', { where: 'Tactician', error: 'Loading the general manager setting: ' + (e.message || e) }), '!')));
    return root;
  }
  const summary = () => { const g = settings && settings.gm; return g && g.userIds && g.userIds.length ? 'General manager: ' + g.userIds.map((id) => (g.names || {})[id] || id).join(', ') : 'General manager not set'; };

  // Daily labor for the admin Metrics page: the last 7 days' hours (GM apart) and headcount, same rules as the
  // Sales per labor hour card (this store's punches; a forgotten clock-out on a past day isn't counted; today runs
  // to now and is replaced by later uploads). AE.tracker.daily skips numbers it already sent. Never throws.
  let uploading = null;
  function uploadDaily() {
    if (uploading || !AE.tracker || !AE.tracker.daily) return uploading;
    return (uploading = (async () => {
      try {
        const store = Number((await AE.profile()).storeId);
        if (!store) return;
        const t = new Date(), f = new Date(t); f.setDate(f.getDate() - 6);
        const today = ymd(t), [ps, gm] = await Promise.all([punches(ymd(f), today), gmIds()]);
        const days = new Map();
        for (const pu of ps) {
          if (pu.s !== store || pu.c === 2 || !pu.i) continue;
          const day = ymd(new Date(pu.i));
          if (day < ymd(f) || day > today || (!pu.o && day !== today)) continue;
          const d = days.get(day) || days.set(day, { hrs: 0, gm: 0, who: new Set() }).get(day);
          const hrs = Math.max(0, ((pu.o ? Date.parse(pu.o) : Date.now()) - Date.parse(pu.i)) / 3600000);
          if (gm.has(pu.u)) d.gm += hrs; else d.hrs += hrs;
          d.who.add(pu.u);
        }
        for (const [day, d] of days) await AE.tracker.daily(store, day, { labor_hours: d.hrs, labor_hours_gm: d.gm, headcount: d.who.size }, 'tactician');
      } catch (e) { console.warn('[Aethernet] Tactician daily upload failed', e); AE.noteError('Tactician daily upload', e); }
      finally { uploading = null; }
    })());
  }

  /*
    Period and store-window helpers for the rewritten Store time sheet page (Nov 2026). Pure: dates are YYYY-MM-DD strings,
    "today" and "now" are passed in. Portal keeps its period in React state only, so the period is read back from what the
    page shows (a store card's "Mon Oct 12 – Sun Oct 18" or the period button's "Oct 12 – Oct 18", no year) and/or from
    the page's own request (fromDate = a Sunday S, toDate = S + 6 + span - 1, span 7 or 14).
    Unverified: the resolver's default when payPeriodStartDay is missing (DEFAULT_PPSD is a guess); that storeTimeZone is IANA.
  */
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], DEFAULT_PPSD = 1;
  const utc = (s) => Date.parse(s + 'T00:00:00Z');
  const addDays = (s, n) => new Date(utc(s) + n * 86400000).toISOString().slice(0, 10);
  const daysBetween = (a, b) => Math.round((utc(b) - utc(a)) / 86400000);
  const isYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(utc(s)) && addDays(s, 0) === s;
  const pad2 = (n) => String(n).padStart(2, '0');
  // "Mon Oct 12 – Sun Oct 18" or "Oct 12 – Oct 18" → { start, end, span } (span 7 or 14), else null. The year isn't shown:
  // the start's year is the latest one for which the start is not after today (Dec 28 – Jan 10 seen in January → starts last year).
  function periodFromText(text, today) {
    const m = String(text || '').match(/(?:\b[A-Z][a-z]{2}\s+)?\b([A-Z][a-z]{2})\s+(\d{1,2})\s*[–-]\s*(?:[A-Z][a-z]{2}\s+)?([A-Z][a-z]{2})\s+(\d{1,2})\b/);
    if (!m || !isYmd(today)) return null;
    const sm = MON.indexOf(m[1]), em = MON.indexOf(m[3]), sd = Number(m[2]), ed = Number(m[4]);
    if (sm < 0 || em < 0) return null;
    let y = Number(today.slice(0, 4));
    if (y + '-' + pad2(sm + 1) + '-' + pad2(sd) > today) y--;
    const start = y + '-' + pad2(sm + 1) + '-' + pad2(sd), ey = em < sm || (em === sm && ed < sd) ? y + 1 : y;
    const end = ey + '-' + pad2(em + 1) + '-' + pad2(ed);
    if (!isYmd(start) || !isYmd(end)) return null;
    const span = daysBetween(start, end) + 1;
    return span === 7 || span === 14 ? { start, end, span } : null;
  }
  // The page's own request: fromDate = Sunday S, toDate = S + 6 + span - 1 → { sunday, span }, else null.
  function periodFromRequest(fromDate, toDate) {
    if (!isYmd(fromDate) || !isYmd(toDate)) return null;
    const span = daysBetween(fromDate, toDate) + 1 - 7;
    return span === 7 || span === 14 ? { sunday: fromDate, span } : null;
  }
  // Portal's arithmetic for one store: start = S + payPeriodStartDay (0 = Sunday, 1 = Monday…), end = start + span - 1.
  function storeWindow(sunday, payPeriodStartDay, span) {
    const d = Number.isInteger(payPeriodStartDay) && payPeriodStartDay >= 0 && payPeriodStartDay <= 6 ? payPeriodStartDay : DEFAULT_PPSD;
    const start = addDays(sunday, d);
    return { start, end: addDays(start, span - 1), span, payPeriodStartDay: d };
  }
  // What to request so that a window is covered: Portal's own range (Sunday S through S + 6 + span - 1).
  function requestRange(start, payPeriodStartDay, span) {
    const d = Number.isInteger(payPeriodStartDay) && payPeriodStartDay >= 0 && payPeriodStartDay <= 6 ? payPeriodStartDay : DEFAULT_PPSD, sunday = addDays(start, -d);
    return { fromDate: sunday, toDate: addDays(sunday, 6 + span - 1) };
  }
  // The visible period → { start, end, span, sunday, source }. The card text wins (it is the store's own window); else the request + payPeriodStartDay.
  function period({ text, fromDate, toDate, today, payPeriodStartDay } = {}) {
    const t = periodFromText(text, today), r = periodFromRequest(fromDate, toDate);
    if (t) return { start: t.start, end: t.end, span: t.span, sunday: r ? r.sunday : requestRange(t.start, payPeriodStartDay, t.span).fromDate, source: 'text' };
    if (r) { const w = storeWindow(r.sunday, payPeriodStartDay, r.span); return { start: w.start, end: w.end, span: w.span, sunday: r.sunday, source: 'request' }; }
    return null;
  }
  // The calendar day (YYYY-MM-DD) of an instant in a time zone; a missing or rejected zone falls back to the browser's.
  const dayFmts = new Map();
  function dayIn(iso, zone) {
    const t = Date.parse(iso);
    if (isNaN(t)) return null;
    if (typeof zone === 'string' && zone) {
      if (!dayFmts.has(zone)) { try { dayFmts.set(zone, new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })); } catch (_) { dayFmts.set(zone, null); } }
      const f = dayFmts.get(zone);
      if (f) { const p = {}; for (const x of f.formatToParts(new Date(t))) p[x.type] = x.value; return p.year + '-' + p.month + '-' + p.day; }
    }
    return ymd(new Date(t));
  }
  /*
    Per person over a store's pay-period window. rows = GET /api/store-time-sheet rows; o = { store (id, or null for all stores), start (window start,
    YYYY-MM-DD), span (7 or 14), now (ms) }. Days are bucketed by each punch's own store time zone (row.storeTimeZone); a punch outside the window is
    left out; an open punch counts to now; breaks (clockTypeId 2) are only summed. Overtime = hours over 40 per 7-day week counting every store worked
    (Tactician's rule; Portal's own figure is per store). Returns [{ name, day[span], here, all, breaks, elsewhere: Map(store name → h), worked,
    weeks: [{ here, all, breaks (at this store), elsewhere: Map(store name → h), ot, left }], ot (sum of the weeks), left (hours left before OT in the week containing now, else the last week) }].
    Same as before for 7 days, except: day[] starts at the window start (not always Monday), and weeks/left are new for 14.
  */
  function breakdown(rows, o) {
    const { store = null, start, span = 7, now = Date.now() } = o || {}, weeks = Math.floor(span / 7), people = new Map();
    if (!isYmd(start)) return [];
    for (const p of rows || []) {
      if (!p.timeIn) continue;
      const off = daysBetween(start, dayIn(p.timeIn, p.storeTimeZone)), wk = Math.floor(off / 7);
      if (!(off >= 0 && off < span)) continue;
      const u = people.get(p.userId) || people.set(p.userId, { name: p.username || 'User ' + p.userId, day: Array(span).fill(0), here: 0, all: 0, breaks: 0, elsewhere: new Map(), worked: false, weeks: Array.from({ length: weeks }, () => ({ here: 0, all: 0, breaks: 0, elsewhere: new Map() })) }).get(p.userId);
      const hrs = Math.max(0, ((p.timeOut ? Date.parse(p.timeOut) : now) - Date.parse(p.timeIn)) / 3600000), here = store == null || p.storeId === store;
      if (p.clockTypeId === 2) { if (here) { u.breaks += hrs; u.weeks[wk].breaks += hrs; } continue; }
      u.all += hrs; u.weeks[wk].all += hrs;
      if (here) { u.here += hrs; u.weeks[wk].here += hrs; u.worked = true; u.day[off] += hrs; }
      else { const n = p.storeName || 'Store ' + p.storeId, we = u.weeks[wk].elsewhere; u.elsewhere.set(n, (u.elsewhere.get(n) || 0) + hrs); we.set(n, (we.get(n) || 0) + hrs); }
    }
    const nowOff = daysBetween(start, ymd(new Date(now))), cur = Math.min(weeks - 1, Math.max(0, Math.floor(nowOff / 7)));
    return [...people.values()].filter((u) => u.worked).sort((a, b) => (a.name > b.name ? 1 : -1)).map((u) => {
      for (const w of u.weeks) { w.ot = Math.max(0, w.all - 40); w.left = Math.max(0, 40 - w.all); }
      return Object.assign(u, { ot: u.weeks.reduce((n, w) => n + w.ot, 0), left: u.weeks[cur].left });
    });
  }

  /*
    Which store and which window the page is showing (the Store time sheet page, Nov 2026).
    pickStore: Portal's store menu value ("all" or a store id; the menu only exists with 2+ stores) → the store to break down. A store id picks
    that store; "all", a missing menu or anything else shows the store you're signed into (home). → { store, fromMenu } or null without a home.
    pageWindow: the window Portal shows for that store, from the store card's text lines (e.g. "Mon Nov 9 – Sun Nov 15"), else the period button's text
    ("Nov 9 – Nov 15"), which is only that store's window when a store is picked or there is no menu (with "All stores" it reads "This Work Week"…).
    → { start, end, span, source: 'card' | 'label' } or null (the caller says so; it never guesses a week).
  */
  function pickStore(value, home) {
    if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return { store: Number(value), fromMenu: true };
    const h = Number(home);
    return h > 0 ? { store: h, fromMenu: false } : null;
  }
  function pageWindow({ card, label, value, today } = {}) {
    for (const t of Array.isArray(card) ? card : [card]) { const c = periodFromText(t, today); if (c) return Object.assign(c, { source: 'card' }); }
    if (value !== 'all') { const l = periodFromText(label, today); if (l) return Object.assign(l, { source: 'label' }); }
    return null;
  }
  // The store's name and pay-period start day from a /api/store-time-sheet answer ({ stores: [{ storeId, storeName, payPeriodStartDay }], rows }); the rows are the fallback.
  function storeInfo(j, store) {
    const s = ((j && j.stores) || []).find((x) => x.storeId === store) || ((j && j.rows) || []).find((x) => x.storeId === store) || {};
    return { name: s.storeName || null, payPeriodStartDay: Number.isInteger(s.payPeriodStartDay) ? s.payPeriodStartDay : null };
  }
  // Column totals over breakdown() people for a window of `span` days.
  function totals(people, span) {
    const tot = { day: Array(span).fill(0), here: 0, breaks: 0, ot: 0, otPeople: 0 };
    for (const u of people) { u.day.forEach((x, i) => { tot.day[i] += x; }); tot.here += u.here; tot.breaks += u.breaks; tot.ot += u.ot; if (u.ot > 0) tot.otPeople++; }
    return tot;
  }

  // One 7-day week (wk = 0 or 1) of breakdown() people: only those who worked here that week, and that week's column totals.
  // → { people: [{ u, w: u.weeks[wk], day[7] }], day[7], here, breaks, ot, otPeople }
  function weekView(people, wk) {
    const rows = [], tot = { people: rows, day: Array(7).fill(0), here: 0, breaks: 0, ot: 0, otPeople: 0 };
    for (const u of people) {
      const w = u.weeks[wk], day = u.day.slice(wk * 7, wk * 7 + 7);
      if (!w || !(w.here > 0 || day.some((x) => x > 0))) continue;
      rows.push({ u, w, day });
      day.forEach((x, i) => { tot.day[i] += x; }); tot.here += w.here; tot.breaks += w.breaks; tot.ot += w.ot; if (w.ot > 0) tot.otPeople++;
    }
    return tot;
  }
  // Is week wk (0-based, 7 days from start) over before today (YYYY-MM-DD)? "Left before OT" means nothing for a finished week.
  function weekOver(start, wk, today) { return addDays(start, wk * 7 + 6) < today; }

  return { weekView, weekOver, ymd, monday, periodFromText, periodFromRequest, storeWindow, requestRange, period, dayIn, breakdown, addDays, pickStore, pageWindow, storeInfo, totals, canManage, loadSettings, gmIds, saveGm, punches, people, gmEditor, summary, uploadDaily };
})();

AE.shard({
  id: 'timeSheet',
  name: 'Tactician',
  sites: ['portal.ubreakifix.net'],
  run() {
    const { h } = AE;
    const PATH = /^\/admin\/my-store\/store-time-sheet\/?$/, ROW = 'ae-ts-row', BOX = 'ae-ts-box', OPEN_KEY = 'ae_ts_open';
    // Portal's own elements, all seen in the page's DOM (sandbox render of Portal's bundle, Nov 2026)
    const SEL = { menu: '[data-testid="store-time-sheet-store-filter"]', label: '[data-testid="store-time-sheet-period-label"]', exportBtn: '[data-testid="store-time-sheet-export-csv"]',
      card: (id) => '[data-testid="store-time-sheet-card-' + id + '"]' };
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
      .${BOX} { max-width:100%; box-sizing:border-box; overflow-x:auto; }
      .${BOX} .wrap { overflow-x:auto; }
      .${BOX}.two th, .${BOX}.two td { padding-left:7px; padding-right:7px; }
      .${BOX}.two td:first-child { white-space:normal; min-width:150px; }
      .${BOX}.two td:first-child, .${BOX}.two th:first-child { padding-left:18px; }
      .${BOX} .wkhd { padding:10px 18px 6px; font-size:14px; border-top:1px solid var(--aui-outline-soft, #eee); }
      .${BOX} .both { padding:10px 18px; font-size:14px; border-top:1px solid var(--aui-outline-soft, #eee); background:var(--aui-neutral-soft, #faf9fb); }
      .${BOX} table { width:100%; border-collapse:collapse; font-size:13.5px; }
      .${BOX} th { font-weight:400; color:var(--aui-on-surface-soft, #5d5e61); text-align:right; padding:8px 10px; border-top:1px solid var(--aui-outline-soft, #eee); white-space:nowrap; }
      .${BOX} td { text-align:right; padding:9px 10px; border-top:1px solid var(--aui-outline-soft, #eee); white-space:nowrap; }
      .${BOX} th:first-child, .${BOX} td:first-child { text-align:left; padding-left:18px; }
      .${BOX} td.none { color:var(--aui-on-surface-soft, #9a9aa0); }
      .${BOX} .ot { display:inline-block; background:var(--aui-status-error, #b91a24); color:#fff; border-radius:4px; padding:1px 6px; font-weight:600; }
      .${BOX} .else { color:var(--aui-on-surface-soft, #5d5e61); font-size:12px; }
      .${BOX} tr.tot td { font-weight:700; background:var(--aui-neutral-soft, #faf9fb); }
      .${BOX} .note { font-size:12px; color:var(--aui-on-surface-soft, #5d5e61); padding:10px 18px 14px; }
    `));

    const fmt = (x) => { if (!x) return '—'; let hh = Math.floor(x), mm = Math.round((x - hh) * 60); if (mm === 60) { hh++; mm = 0; } return hh + 'h ' + String(mm).padStart(2, '0') + 'm'; };
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dayHead = (start, i, span) => { const d = AE.tactician.addDays(start, i); return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }) + (span > 7 ? ' ' + Number(d.slice(8)) : ''); };
    const rangeText = (start, end) => { const a = MONTHS[Number(start.slice(5, 7)) - 1], b = MONTHS[Number(end.slice(5, 7)) - 1]; return a + ' ' + Number(start.slice(8)) + '–' + (b !== a ? b + ' ' : '') + Number(end.slice(8)); };

    /*
      One store, one window. Which store: Portal's store menu (a store id), else the store you're signed into. Which window: read back from what Portal
      shows (T.pageWindow); Portal keeps its period in React state only. view = { store, fromMenu, hasMenu, win, status: 'loading' | 'ok' | 'failed' | 'unreadable', rows, info, ... }.
    */
    const T = AE.tactician, STALE = 60000;
    let home = null, homeName = '', view = null, viewKey = '', drawnSig = '', seq = 0;
    const views = new Map(); // store|start|span → view, so Portal redrawing the same week (its cards vanish while it loads) doesn't ask again within a minute
    const GRACE = 2500; // Portal's cards are missing while it loads: an unreadable week is only reported after this long
    const ppsdOf = new Map(); // store → payPeriodStartDay, learned from the answers (the first request for a store assumes the default and is repeated if that was wrong)

    function readPage() {
      const menu = document.querySelector(SEL.menu), value = menu ? menu.value : null, pick = T.pickStore(value, home);
      if (!pick) return null;
      const cardEl = document.querySelector(SEL.card(pick.store)), lab = document.querySelector(SEL.label);
      const card = cardEl ? [...cardEl.querySelectorAll('[data-aui="text"]')].map((x) => x.textContent) : [], label = lab ? lab.textContent.trim() : '';
      return { pick, value, hasMenu: !!menu, card, label, win: T.pageWindow({ card, label, value, today: T.ymd(new Date()) }) };
    }
    async function load(v) {
      const mine = ++seq; v.busy = true;
      try {
        let rng = T.requestRange(v.win.start, ppsdOf.get(v.store), v.win.span), j = null;
        for (let i = 0; i < 2; i++) {
          j = await AE.api('GET', '/api/store-time-sheet?fromDate=' + rng.fromDate + '&toDate=' + rng.toDate);
          const info = T.storeInfo(j, v.store); if (info.payPeriodStartDay != null) ppsdOf.set(v.store, info.payPeriodStartDay);
          const want = T.requestRange(v.win.start, ppsdOf.get(v.store), v.win.span);
          if (want.fromDate === rng.fromDate) break;
          rng = want; // the store's work week starts on another day than assumed: ask for its real range
        }
        if (mine !== seq) return;
        Object.assign(v, { rows: (j && j.rows) || [], info: T.storeInfo(j, v.store), status: 'ok', at: Date.now(), failed: null });
        setTimeout(() => AE.tactician.uploadDaily(), 3000);
      } catch (e) { if (mine === seq) Object.assign(v, { status: 'failed', failed: e.message || String(e), failedAt: Date.now() }); }
      finally { if (mine === seq) { v.busy = false; draw(); } }
    }
    function sync() {
      if (!home || !document.querySelector(SEL.exportBtn)) return; // wait for the profile and for Portal's controls
      const pg = readPage();
      if (!pg) return;
      const key = pg.pick.store + '|' + (pg.win ? pg.win.start + '|' + pg.win.span : 'none');
      if (key !== viewKey) {
        viewKey = key; seq++;
        const old = pg.win && views.get(key);
        if (old && !old.busy && old.status === 'ok' && Date.now() - old.at < STALE) view = Object.assign(old, { fromMenu: pg.pick.fromMenu, hasMenu: pg.hasMenu });
        else {
          view = { store: pg.pick.store, fromMenu: pg.pick.fromMenu, hasMenu: pg.hasMenu, win: pg.win, status: pg.win ? 'loading' : 'unreadable', since: Date.now(), menuAll: pg.value === 'all', label: pg.label, card: pg.card };
          if (pg.win) { views.set(key, view); if (views.size > 20) views.delete(views.keys().next().value); load(view); }
        }
      } else if (view.win && !view.busy && ((view.status === 'ok' && Date.now() - view.at > STALE) || (view.status === 'failed' && Date.now() - view.failedAt > 30000))) load(view); // punches fixed meanwhile / try again
      draw();
    }

    function draw() {
      const anchor = document.querySelector(SEL.exportBtn), v = view;
      if (!anchor || !v) return;
      const bar = anchor.parentElement; // Portal's controls row; Tactician goes right under it, above the first store card
      let row = document.getElementById(ROW), box = document.getElementById(BOX);
      if (!row) row = h('div', { id: ROW, class: ROW });
      if (!box) box = h('div', { id: BOX, class: BOX });
      const open = !!GM_getValue(OPEN_KEY, false); // collapsed unless you opened it (keeps room for Portal's cards)
      const mounted = row.previousElementSibling === bar && box.previousElementSibling === row;
      const waiting = v.status === 'unreadable' && Date.now() - v.since < GRACE;
      if (waiting) setTimeout(() => { if (view === v) draw(); }, GRACE - (Date.now() - v.since) + 50);
      const sig = [viewKey, v.status, waiting, v.at || 0, v.failedAt || 0, open, v.fromMenu, v.info ? v.info.name : ''].join('|');
      if (mounted && sig === drawnSig) return;
      if (!mounted) bar.after(row, box);
      drawnSig = sig;
      box.hidden = !open || v.status !== 'ok';
      const name = ((v.info && v.info.name) || (v.store === home && homeName) || 'Store') + ' #' + v.store;
      const lead = [h('span', { style: 'line-height:0', title: 'Tactician (Aethernet)', html: AE.actionIcon('timeSheet', 20) }), h('span', { class: 'lbl' }, h('b', null, 'Tactician'), ' · ' + name + (!v.fromMenu && v.hasMenu ? ' (the store you\'re signed into)' : ''))];
      if (v.status === 'unreadable' && !waiting) {
        row.replaceChildren(...lead, h('span', { class: 'lbl' }, v.menuAll
          ? "Portal shows no card for this store in this period, so Tactician can't tell which week it is. Pick the store in Portal's store menu to see its breakdown."
          : ["Tactician couldn't read the week Portal is showing. If you keep seeing this, ", AE.bugLinkEl('report a bug', { where: 'Tactician', error: 'Reading the week Portal shows: period "' + v.label + '", card "' + (v.card || []).join(' | ') + '"' }), '!']));
        box.replaceChildren(); return;
      }
      if (v.status === 'failed') {
        row.replaceChildren(...lead, h('span', { class: 'lbl' }, "Tactician couldn't load this week's punches. If you keep seeing this, ", AE.bugLinkEl('report a bug', { where: 'Tactician', error: 'Loading punches for ' + v.win.start + ' to ' + v.win.end + ': ' + v.failed }), '!'));
        box.replaceChildren(); return;
      }
      if (v.status !== 'ok') { row.replaceChildren(...lead, h('span', { class: 'lbl' }, 'Loading…')); box.replaceChildren(); return; }
      const { start, end, span } = v.win, people = T.breakdown(v.rows, { store: v.store, start, span, now: Date.now() }), tot = T.totals(people, span);
      const toggle = h('button', { type: 'button', class: 'tog', 'aria-expanded': String(open), 'aria-controls': BOX,
        onclick: () => { GM_setValue(OPEN_KEY, !open); AE.track('timeSheet:' + (open ? 'hide' : 'show')); draw(); } },
        open ? 'Hide weekly breakdown' : 'Show weekly breakdown', h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', html: '<path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2"/>' }));
      row.replaceChildren(...lead, h('span', { class: 'sum' }, !people.length ? 'Nobody clocked in' : fmt(tot.here) + ' worked · ' + (tot.ot ? fmt(tot.ot) + ' overtime (' + tot.otPeople + (tot.otPeople === 1 ? ' person' : ' people') + ')' : 'no overtime')), toggle);
      const head = (days, st) => h('tr', null, h('th', null, 'Employee'), ...days.map((i) => h('th', null, dayHead(st, i, span))), h('th', null, 'Worked here'), h('th', null, 'Breaks'), h('th', null, 'Overtime'), h('th', null, 'Left before OT'));
      const elseNote = (m) => m.size ? h('div', { class: 'else' }, [...m].map(([n, x]) => '+ ' + fmt(x) + ' at ' + n).join(' · ')) : null;
      const note = h('div', { class: 'note' }, 'Overtime = hours over 40 in a 7-day week, counting every store the person worked at (Portal\'s OT tag counts one store at a time). Same punches as Portal\'s cards above; nothing is changed.');
      box.classList.toggle('two', span > 7);
      const hd = h('div', { class: 'hd' }, h('b', null, 'Weekly breakdown'), ' · ' + name + ' · ' + rangeText(start, end));
      if (!people.length) { box.replaceChildren(hd, h('div', { class: 'note' }, 'Nobody clocked in at ' + name + ' in this period.'), note); return; }
      if (span <= 7) { // one week: unchanged
        box.replaceChildren(hd, h('div', { class: 'wrap' }, h('table', null,
          head(Array.from({ length: span }, (_, i) => i), start),
          ...people.map((u) => h('tr', null,
            h('td', null, h('b', null, u.name), elseNote(u.elsewhere)),
            ...u.day.map((x) => h('td', { class: x ? null : 'none' }, fmt(x))),
            h('td', null, h('b', null, fmt(u.here))), h('td', null, fmt(u.breaks)),
            h('td', null, u.ot ? h('span', { class: 'ot' }, fmt(u.ot)) : '—'), h('td', null, u.ot ? '—' : fmt(u.left)))),
          h('tr', { class: 'tot' }, h('td', null, name + ' total'), ...tot.day.map((x) => h('td', null, fmt(x))), h('td', null, fmt(tot.here)), h('td', null, fmt(tot.breaks)), h('td', null, tot.ot ? fmt(tot.ot) : '—'), h('td', null)))), note);
        return;
      }
      // 14 days: the two weeks stacked, each its own 7-day table, then one line for both
      const today = T.ymd(new Date(Date.now())), secs = [];
      for (let wk = 0; wk < Math.floor(span / 7); wk++) {
        const ws = T.addDays(start, wk * 7), we = T.addDays(ws, 6), wv = T.weekView(people, wk), over = T.weekOver(start, wk, today);
        secs.push(h('div', { class: 'wkhd' }, h('b', null, 'Week ' + (wk + 1)), ' · ' + rangeText(ws, we) + (over ? ' · finished' : '')));
        secs.push(wv.people.length ? h('div', { class: 'wrap' }, h('table', null,
          head([0, 1, 2, 3, 4, 5, 6], ws),
          ...wv.people.map(({ u, w, day }) => h('tr', null,
            h('td', null, h('b', null, u.name), elseNote(w.elsewhere)),
            ...day.map((x) => h('td', { class: x ? null : 'none' }, fmt(x))),
            h('td', null, h('b', null, fmt(w.here))), h('td', null, fmt(w.breaks)),
            h('td', null, w.ot ? h('span', { class: 'ot' }, fmt(w.ot)) : '—'), h('td', null, over || w.ot ? '—' : fmt(w.left)))),
          h('tr', { class: 'tot' }, h('td', null, name + ' total'), ...wv.day.map((x) => h('td', null, fmt(x))), h('td', null, fmt(wv.here)), h('td', null, fmt(wv.breaks)), h('td', null, wv.ot ? fmt(wv.ot) : '—'), h('td', null))))
          : h('div', { class: 'note' }, 'Nobody clocked in at ' + name + ' this week.'));
      }
      secs.push(h('div', { class: 'both' }, h('b', null, 'Both weeks'), ' · ' + fmt(tot.here) + ' worked · ' + fmt(tot.breaks) + ' breaks · ' + (tot.ot ? fmt(tot.ot) + ' overtime' : 'no overtime') + ' · ' + tot.otPeople + (tot.otPeople === 1 ? ' person' : ' people') + ' over'));
      box.replaceChildren(hd, ...secs, note);
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
      /* At or over the target: green. Just below it (within 10%) or would have made it with the RFP total picked up: yellow. Otherwise red. */
      #${RP} .bar.good { color:var(--aui-status-success, #136d31); } #${RP} .bar.near { color:#d6a000; } #${RP} .bar.miss { color:var(--aui-status-error, #b91a24); }
      #${RP} .bar.est { background:repeating-linear-gradient(-45deg, currentColor 0 5px, transparent 5px 9px); opacity:.75; }
      #${RP}-tip { position:fixed; z-index:2147483646; transform:translate(-50%, calc(-100% - 12px)); min-width:220px; max-width:340px; padding:10px 12px; border-radius:12px;
        background:#1a1c1e; color:#fff; font:13px/1.45 Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; box-shadow:0 6px 18px #0005; pointer-events:none; }
      #${RP}-tip::after { content:''; position:absolute; left:50%; bottom:-7px; margin-left:-7px; border:7px solid transparent; border-bottom:0; border-top-color:#1a1c1e; } /* the bubble's tail, down to the bar */
      #${RP}-tip .t { font-weight:700; margin-bottom:2px; } #${RP}-tip .s { opacity:.75; font-size:12px; margin-bottom:6px; }
      #${RP}-tip table { width:100%; border-collapse:collapse; margin:0; } #${RP}-tip td { padding:2px 0; border:0; font-variant-numeric:tabular-nums; } #${RP}-tip td + td { text-align:right; padding-left:12px; white-space:nowrap; }
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
      for (const x of rd.days || []) if (days.has(x.day)) Object.assign(days.get(x.day), { rfp: x.value || 0, rfpCount: x.count || 0 }); // the RFP total at the end of the day
      for (const pu of ps) {
        if (pu.s !== store || pu.c === 2 || !pu.i) continue;
        const day = T.ymd(new Date(pu.i)), d = days.get(day);
        if (!d) continue;
        if (!pu.o && day !== today) { d.open++; continue; } // a forgotten clock-out on a past day
        const hrs = Math.max(0, ((pu.o ? Date.parse(pu.o) : Date.now()) - Date.parse(pu.i)) / 3600000);
        if (gm.has(pu.u)) d.gmHours += hrs; else d.hours += hrs;
        const who = d.people.get(pu.u) || d.people.set(pu.u, { name: pu.n || 'User ' + pu.u, hrs: 0, gm: gm.has(pu.u), open: false }).get(pu.u); // who worked it (hover)
        who.hrs += hrs; if (!pu.o) who.open = true;
      }
      setTimeout(() => T.uploadDaily(), 3000);
      return { from, to, rows: [...days.values()], gmSet: gm.size > 0 };
    }
    // Bar color: at/over the target's low end = good; within 10% below, or over it with the RFP total picked up = near; else miss.
    const grade = (r, lo) => (r.splh >= lo ? 'good' : r.splh >= lo * 0.9 || (r.ghost && r.ghost >= lo) ? 'near' : 'miss');
    // Hover a day: a speech bubble with who worked it (this store) and their hours. (No overtime here: Garrett, Oct 12, 2026.)
    function bubble(col, r, leaveOut) {
      document.getElementById(RP + '-tip')?.remove();
      const fmtD = new Date(r.day + 'T12:00:00').toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
      const people = [...r.people.values()].sort((a, b) => b.hrs - a.hrs);
      const tip = h('div', { id: RP + '-tip', role: 'tooltip' },
        h('div', { class: 't' }, fmtD),
        h('div', { class: 's' }, [r.sales != null ? money(r.sales) + ' sales' + (r.source === 'estimated' ? ' (estimated)' : '') : 'No sales data', r.hrs ? r.hrs.toFixed(2) + 'h' : null,
          r.splh != null ? money(r.splh) + '/h' : null, r.ghost ? money(r.ghost) + '/h with the RFP total (' + r.rfpCount + ' devices)' : null].filter(Boolean).join(' · ')),
        people.length ? h('table', null, ...people.map((p) => h('tr', null,
          h('td', null, p.name, p.gm ? h('span', { class: 'gmt' }, leaveOut ? 'GM, left out' : 'GM') : null, p.open ? h('span', { class: 'gmt' }, 'still clocked in') : null),
          h('td', null, p.hrs.toFixed(2) + 'h'))))
          : h('div', { class: 'n' }, 'Nobody clocked in here.'),
        r.open ? h('div', { class: 'n' }, r.open + ' punch' + (r.open === 1 ? '' : 'es') + ' without a clock-out not counted') : null);
      document.body.append(tip);
      const rc = col.getBoundingClientRect(), top = Math.min(...[col.querySelector('.ghost'), col.querySelector('.bar')].filter(Boolean).map((x) => x.getBoundingClientRect().top));
      const left = Math.min(Math.max(rc.left + rc.width / 2, tip.offsetWidth / 2 + 8), innerWidth - tip.offsetWidth / 2 - 8);
      tip.style.left = left + 'px'; tip.style.top = Math.max(top, tip.offsetHeight + 20) + 'px'; // above the taller of the bar and its ghost
    }
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
      const lastRfp = rows.slice().reverse().find((r) => r.rfp || r.rfpCount) || null; // the RFP total at the end of the range
      const ghostAll = lastRfp && tH ? (tS + lastRfp.rfp) / tH : null;
      const atTarget = withBoth.filter((r) => r.splh >= tLo).length;
      const fmtDay = (d) => new Date(d + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
      card.append(
        h('div', { class: 'sum' },
          h('div', null, h('div', { class: 'big' }, tH ? money(tS / tH) : '—'), h('div', { class: 'sg-soft' }, 'per labor hour')),
          h('div', null, h('div', { class: 'big' }, money(tS)), h('div', { class: 'sg-soft' }, 'sales')),
          h('div', null, h('div', { class: 'big' }, tH.toFixed(1) + 'h'), h('div', { class: 'sg-soft' }, 'labor' + (leaveOut ? (data.gmSet ? ' (general managers left out: ' + gmOut.toFixed(1) + 'h)' : ' (no general manager set: Settings → Tactician)') : ''))),
          best ? h('div', null, h('div', { class: 'big' }, money(best.splh)), h('div', { class: 'sg-soft' }, 'best day · ' + fmtDay(best.day))) : null,
          ghostAll ? h('div', { class: 'ghoststat' }, h('div', { class: 'big' }, money(ghostAll)), h('div', { class: 'sg-soft' }, 'if the RFP total were picked up (' + money(lastRfp.rfp) + ', ' + lastRfp.rfpCount + ' devices)')) : null,
          h('div', null, h('div', { class: 'big' }, atTarget + ' of ' + withBoth.length), h('div', { class: 'sg-soft' }, 'days at target ($' + tLo + '–$' + tHi + (leaveOut ? ', without GM' : ', with GM') + ')'))),
        h('div', { class: 'chart' }, h('div', { class: 'band', style: 'bottom:' + (tLo / max * 100) + '%;height:' + ((tHi - tLo) / max * 100) + '%', title: 'Target: $' + tLo + '–$' + tHi + ' per labor hour' }), ...rows.map((r) => h('div', { class: 'col', onmouseenter: (e) => bubble(e.currentTarget, r, leaveOut), onmouseleave: () => document.getElementById(RP + '-tip')?.remove() },
          r.ghost ? h('div', { class: 'ghost', style: 'height:' + Math.round(r.ghost / max * 100) + '%' }) : null,
          h('div', { class: 'bar' + (r.splh == null ? ' none' : ' ' + grade(r, tLo)) + (r.splh != null && r.source === 'estimated' ? ' est' : ''), style: 'height:' + (r.splh != null ? Math.max(2, Math.round(r.splh / max * 100)) : 2) + '%' })))),
        h('div', { class: 'axis sg-soft' }, h('span', null, fmtDay(data.from)), h('span', { class: 'tgt' }, h('i'), 'Target $' + tLo + '–$' + tHi + (leaveOut ? ' without GM' : ' with GM')), h('span', null, fmtDay(data.to))),
        h('details', { class: 'days' }, h('summary', null, 'Days'),
          h('table', null, h('tr', null, ['Day', 'Sales', 'Labor hours', 'Per labor hour', 'If RFP picked up', ''].map((x) => h('th', null, x))),
            ...rows.slice().reverse().map((r) => h('tr', null, h('td', null, fmtDay(r.day)), h('td', null, r.sales != null ? money(r.sales) : '—'), h('td', null, r.hrs ? r.hrs.toFixed(2) + 'h' : '—'),
              h('td', null, h('b', null, r.splh != null ? money(r.splh) : '—')),
              h('td', { class: 'sg-soft', title: r.rfpCount ? 'RFP total at the end of the day: ' + money(r.rfp) + ' (' + r.rfpCount + ' devices)' : null }, r.ghost ? money(r.ghost) : '—'),
              h('td', { class: 'sg-soft' }, [r.source === 'estimated' ? 'Sales estimated from work orders' : null, leaveOut && r.gmHours ? 'GM ' + r.gmHours.toFixed(2) + 'h left out' : null,
                r.open ? r.open + ' punch' + (r.open === 1 ? '' : 'es') + ' without a clock-out not counted' : null, r.sales == null && !r.hrs ? 'Closed or no data' : null].filter(Boolean).join(' · ')))),
            h('tr', { class: 'tot' }, h('td', null, 'Total'), h('td', null, money(tS)), h('td', null, tH.toFixed(2) + 'h'), h('td', null, tH ? money(tS / tH) : '—'), h('td', null, ghostAll ? money(ghostAll) : '—'), h('td'))),
          h('p', { class: 'sg-soft', style: 'font-size:12px;margin:8px 0 0' }, 'Sales = Portal\'s daily sales (partner credits included; striped days are estimated from work orders). Labor = hours clocked in at this store, breaks not counted, from the Store time sheet. Days without both aren\'t in the totals. Ghost bars = that day\'s sales plus the RFP total at the end of the day (before tax, partner credits ignored), as if it had all been picked up; for the range, the RFP total at its end.')));
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
        busy = loadSplh(f).then((d) => { if (range === key) { data = d; err = null; } dataFor = key; loadedAt = Date.now(); }, (e) => { err = /session expired/i.test(e.message || '') ? 'Sales per labor hour needs Store time sheet access.' : ["Couldn't load sales and hours. If you keep seeing this, ", AE.bugLinkEl('report a bug', { where: 'Tactician', error: 'Sales per labor hour: ' + (e.message || e) }), '!']; dataFor = key; loadedAt = Date.now(); })
          .finally(() => { busy = null; if (document.getElementById(RP)) showSplh(); }); // (a range picked meanwhile loads next)
      }
    }
    AE.on('tactician-gm', () => { dataFor = null; if (document.getElementById(RP)) showSplh(); });
    T.canManage().then((a) => {
      if (!a.ok || !AE.tracker || !AE.tracker.configured()) return; // managers only (time sheet access), and needs the tracker
      AE.every(1000, () => {
        if (!/^\/reporting\/metrics/.test(location.pathname)) { shownFor = null; document.querySelectorAll('.ae-splh-scroll').forEach((x) => x.classList.remove('ae-splh-scroll')); return; }
        const reports = document.querySelector('.reports-card');
        if (reports && (!document.getElementById(RP) || shownFor !== reports || (!busy && Date.now() - loadedAt > STALE_MS && !AE.health.down()))) { shownFor = reports; showSplh(); }
        const card = document.getElementById(RP); // Portal's Reports page clips anything taller than the window: let it scroll
        for (let x = card && card.parentElement; x; x = x.parentElement) {
          const oy = getComputedStyle(x).overflowY, over = x.scrollHeight > x.clientHeight + 1;
          if (over && (oy === 'auto' || oy === 'scroll')) break;
          if (over && (oy === 'hidden' || oy === 'clip')) { x.classList.add('ae-splh-scroll'); break; }
        }
      });
    });

    let lastPath = '';
    // Portal's store menu, period buttons and week arrows change the page without necessarily adding or removing a node: look again shortly after.
    for (const ev of ['change', 'click']) document.addEventListener(ev, () => { if (PATH.test(location.pathname)) setTimeout(sync, 400); }, true);
    AE.onDom(() => {
      if (!PATH.test(location.pathname)) {
        if (lastPath) { document.getElementById(ROW)?.remove(); document.getElementById(BOX)?.remove(); view = null; viewKey = ''; drawnSig = ''; seq++; lastPath = ''; }
        return;
      }
      if (!lastPath) { lastPath = location.pathname; AE.profile().then((p) => { if (p && p.storeId) { home = Number(p.storeId); homeName = p.storeName || ''; sync(); } }).catch(() => {}); }
      sync();
    });
  },
});
