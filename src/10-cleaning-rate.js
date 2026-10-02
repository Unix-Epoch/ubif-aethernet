/*
  Divination (live cleaning rate) — header badge.

  Rate = cleanings linked to today's Asurion Mobility orders ÷ Asurion
  Mobility orders created today (local time). Each cleaning counts on its
  own, so it can pass 100%. Raw percentage only: reason notes are ignored.
  Cleanings link to orders by device IMEI (AT&T cleanings are often under a
  different customer record), falling back to customer ID without an IMEI.
  Dual-SIM phones have two IMEIs: a different IMEI of the same model (first
  8 digits) for a customer of the same name links too (AE.data.sameDevice).

  Pending cleanings count too: a cleaning arrival created today that hasn't
  been checked in yet (still in Arrivals) shows as "pending" and counts. Its
  ⚡ runs the cleaning auto-close (after a confirmation) when that crystal is on.
  See AE.data in core for how WOs and arrivals are fetched and matched.

  History (Reports page, /reporting/metrics): a "Cleaning rate history" card
  under Portal's KPIs — last 7 / 30 / 90 days, this month, last month — with
  the overall rate (all cleanings ÷ all AM orders in the range), days at
  target, a bar per day and a table. Each past day is worked out the same
  way as today (that day's AM orders, cleaning WOs created that day; pending
  arrivals only count for today) from Portal's own work-order lists, and
  cached in this browser per store (ae_rate_history): a finished day doesn't
  change, so only missing days and the last two are ever reloaded.
*/
AE.crystal({
  id: 'cleaningRate',
  name: 'Divination',
  sites: ['portal.ubreakifix.net'],
  run() {
    const { h, esc } = AE;
    const { nameOf } = AE.data;
    const TARGET = AE.settings.cleaningRate.target;
    const REFRESH_MS = 2 * 60 * 1000;
    const BADGE_ID = 'sg-rate-badge', PANEL_ID = 'sg-rate-panel';
    let last = null, loading = false, lastError = null;

    document.head.append(h('style', null, `
      #${BADGE_ID} { display:inline-flex; align-items:center; gap:8px; height:32px; padding:0 14px; margin:0 8px 0 12px; border-radius:10000rem;
        border:1px solid transparent; font:400 14px/1 Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; cursor:pointer; white-space:nowrap;
        font-variant-numeric:tabular-nums; }
      #${BADGE_ID} b { font-weight:700; }
      #${BADGE_ID} .dot { width:8px; height:8px; border-radius:50%; background:currentColor; flex:none; }
      #${BADGE_ID}.floating { position:fixed; left:16px; bottom:16px; z-index:2147483645; box-shadow:0 4px 14px rgba(12,14,17,.2); }
      #${BADGE_ID}.good { background:var(--aui-status-success-soft,#c5ffc8); color:var(--aui-status-on-success-soft,#062011); }
      #${BADGE_ID}.ok   { background:var(--aui-status-warning-soft,#fff0c0); color:var(--aui-status-on-warning-soft,#3a3000); }
      #${BADGE_ID}.bad  { background:var(--aui-status-error-soft,#ffdad7);  color:var(--aui-status-on-error-soft,#410004); }
      #${BADGE_ID}.none { background:transparent; border-color:var(--aui-outline,#c6c6ca); color:var(--aui-on-surface-soft,#5d5e61); }
      #${BADGE_ID} .sg-spin { width:12px; height:12px; }
      #${PANEL_ID} { position:fixed; z-index:2147483646; width:460px; max-height:70vh; overflow:auto; padding:16px; font-size:14px; line-height:1.4; }
      #${PANEL_ID} table { width:100%; border-collapse:collapse; margin-top:10px; }
      #${PANEL_ID} td { padding:8px 4px; border-top:1px solid var(--aui-outline-soft,#eeedf1); vertical-align:top; }
      #${PANEL_ID} td:first-child { width:44%; }
      #${PANEL_ID} .who { font-weight:600; }
      #${PANEL_ID} a { color:var(--aui-primary,#8223d2); text-decoration:none; font-weight:600; }
      #${PANEL_ID} a:hover { text-decoration:underline; }
      #${PANEL_ID} .sg-soft a { font-weight:400; }
      #${PANEL_ID} .miss { color:var(--aui-status-error,#b91a24); font-weight:600; }
      #${PANEL_ID} .sg-cast-group { display:inline-flex; flex-wrap:wrap; justify-content:flex-end; align-items:center; gap:0; margin:0 0 4px 4px; padding:4px 4px 0 4px;
        border:1.5px dashed var(--aui-primary, #8223d2); border-radius:14px; }
      #${PANEL_ID} .sg-cast-group .sg-chip { margin:0 0 4px 4px; }
      #${PANEL_ID} .sg-cast-go { display:inline-flex; align-items:center; gap:5px; height:22px; margin:0 auto 4px 0; padding:0 9px 0 3px; border:0; border-radius:10000rem; cursor:pointer;
        background:var(--aui-primary, #8223d2); color:var(--aui-on-primary, #fff); font:700 12px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; }
      #${PANEL_ID} .sg-cast-go .b { display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px; border-radius:50%; background:rgba(255,255,255,.22); }
      #${PANEL_ID} .sg-cast-go:hover { filter:brightness(1.1); }
    `));

    async function compute() {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const startMs = start.getTime(), endMs = startMs + 86400000;
      const [wos, arrs] = await Promise.all([AE.data.workorders(startMs), AE.data.arrivals()]);
      const today = (r) => { const t = Date.parse(r.createdAt); return t >= startMs && t < endMs; };
      const parents = wos.filter((r) => r.programId === AE.PARENT_PROGRAM_ID && today(r)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      const cleanings = AE.data.cleanings(wos, arrs, today);
      const used = new Set();
      const rows = parents.map((p) => {
        const matched = cleanings.filter((c) => !used.has(c.key) && AE.data.belongs(c, p));
        matched.forEach((c) => used.add(c.key));
        return { p, matched };
      });
      const linked = rows.reduce((n, r) => n + r.matched.length, 0);
      const pending = rows.reduce((n, r) => n + r.matched.filter((c) => c.pending).length, 0);
      return {
        parents: parents.length, linked, pending, rows, at: new Date(),
        unlinked: cleanings.filter((c) => !used.has(c.key)),
        pct: parents.length ? Math.round((linked / parents.length) * 100) : null,
      };
    }

    const level = (pct) => (pct == null ? 'none' : pct >= 100 ? 'good' : pct >= TARGET ? 'ok' : 'bad');
    const levelColor = (pct) => ({ good: 'var(--aui-status-success,#136d31)', ok: 'var(--aui-on-surface,#1a1c1e)', bad: 'var(--aui-status-error,#b91a24)', none: 'inherit' }[level(pct)]);
    const fmtTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    function renderBadge() {
      let b = document.getElementById(BADGE_ID);
      if (!b) b = h('button', { id: BADGE_ID, type: 'button', class: 'sg', onclick: togglePanel });
      // Sits left of "UBIF support" in the header; floats bottom-left if that's missing.
      const anchor = [...document.querySelectorAll('button')].find((x) => x.offsetParent && x.textContent.trim() === 'UBIF support');
      if (anchor && b.parentElement !== anchor.parentElement) { b.classList.remove('floating'); anchor.parentElement.insertBefore(b, anchor); }
      else if (!anchor && !b.isConnected) { b.classList.add('floating'); document.body.appendChild(b); }
      b.classList.remove('good', 'ok', 'bad', 'none');
      b.classList.add(lastError && !last ? 'none' : level(last && last.pct));
      const text = lastError && !last ? 'Cleanings: error'
        : !last ? 'Cleanings'
        : last.pct == null ? 'Cleanings · no AM orders yet'
        : null;
      const lead = loading ? '<span class="sg-spin"></span>' : '<span class="dot"></span>';
      b.innerHTML = lead + (text ? esc(text) : 'Cleanings ' + last.linked + '/' + last.parents + ' · <b>' + last.pct + '%</b>');
      // Narrow windows: if the full badge makes the header overflow (pushing
      // the avatar off-screen), fall back to just the dot and percentage.
      // Measured synchronously each render, so it adapts both ways without flicker.
      const hdr = b.closest('header');
      if (hdr && hdr.scrollWidth > hdr.clientWidth) b.innerHTML = lead + (text ? '' : '<b>' + last.pct + '%</b>');
      b.title = (last && last.pct != null ? 'Cleanings ' + last.linked + '/' + last.parents + ' · ' + last.pct + '%' +
        (last.pending ? ' (' + last.pending + ' pending)' : '') + ' — ' : '') +
        (last ? 'updated ' + fmtTime(last.at) : 'Loading') + (lastError ? ' — last refresh failed: ' + lastError : '') +
        ' · target ' + TARGET + '%, ideally 100% · click for details';
    }

    // Chip for one cleaning. Pending ones link to the arrival and, with
    // auto-close on, carry a ⚡ that closes it out after a confirmation.
    function chip(c, parent) {
      const label = esc(AE.CLEANING_PROGRAMS[c.programId]);
      if (!c.pending) return '<a class="sg-chip" href="/repair/workorder/' + c.workorderId + '">' + label + '</a>';
      const mk = AE.autoClose
        ? '<button type="button" class="sg-mk" title="Create this cleaning (check in → complete $0 sale)" data-arrival="' + c.arrivalId +
          '" data-program="' + c.programId + '" data-name="' + esc(nameOf(parent)) + '">' + AE.icon('bolt', 12) + '</button>'
        : '';
      return '<span class="sg-chip pending"><a href="/check-in/arrivals/' + c.arrivalId + '" title="In Arrivals — not checked in yet" style="color:inherit;font-weight:400">' +
        label + ' · pending</a>' + mk + '</span>';
    }

    // An order's cleanings. With 2+ pending (and Dualcast on), the pending chips sit in one
    // dashed purple outline, led by a ⚡ that runs them all (Dualcast, or Triplecast for 3+);
    // each chip keeps its own ⚡ for just that one.
    const chips = (matched, wo) => {
      const waiting = matched.filter((c) => c.pending);
      if (!AE.autoClose || !AE.autoClose.dualcastOn() || waiting.length < 2) return matched.map((c) => chip(c, wo)).join('');
      const name = waiting.length >= 3 ? 'Triplecast' : 'Dualcast';
      const go = '<button type="button" class="sg-cast-go" title="' + name + ': create all ' + waiting.length + ' pending cleanings for this order, one after the other" data-dual="' +
        esc(JSON.stringify(waiting.map((c) => ({ arrivalId: c.arrivalId, programId: c.programId })))) + '" data-name="' + esc(nameOf(wo)) + '">' +
        '<span class="b">' + AE.icon('bolt', 12) + '</span>' + name + '</button>';
      return matched.filter((c) => !c.pending).map((c) => chip(c, wo)).join('') +
        '<span class="sg-cast-group">' + go + waiting.map((c) => chip(c, wo)).join('') + '</span>';
    };
    function renderPanel() {
      let p = document.getElementById(PANEL_ID);
      if (!p) { p = h('div', { id: PANEL_ID, class: 'sg sg-card' }); document.body.appendChild(p); }
      const b = document.getElementById(BADGE_ID);
      const r = b && b.getBoundingClientRect();
      if (r && !b.classList.contains('floating')) { p.style.top = (r.bottom + 8) + 'px'; p.style.left = Math.max(8, Math.min(r.left, innerWidth - 476)) + 'px'; p.style.bottom = ''; }
      else { p.style.left = '16px'; p.style.bottom = '60px'; p.style.top = ''; }
      if (!last) { p.innerHTML = lastError ? '<span class="miss">' + esc(lastError) + '</span>' : '<span class="sg-soft">Loading…</span>'; return; }

      const linkTo = (c) => c.pending
        ? '<a href="/check-in/arrivals/' + c.arrivalId + '">arrival ' + c.arrivalId + '</a>'
        : '<a href="/repair/workorder/' + c.workorderId + '">' + c.workorderId + '</a>';
      const table = last.rows.length
        ? '<table>' + last.rows.map(({ p: wo, matched }) =>
          '<tr><td><div class="who">' + esc(nameOf(wo) || 'Unknown customer') + '</div>' +
          '<div class="sg-soft"><a href="/repair/workorder/' + wo.workorderId + '">' + wo.workorderId + '</a> · ' + fmtTime(new Date(wo.createdAt)) + '</div></td>' +
          '<td style="text-align:right">' + (matched.length ? chips(matched, wo) : '<span class="miss">No cleanings</span>') + '</td></tr>'
        ).join('') + '</table>'
        : '<p class="sg-soft">No Asurion Mobility orders created today yet.</p>';
      const extra = last.unlinked.length
        ? '<p class="sg-soft" style="margin:10px 0 0">' + last.unlinked.length + " cleaning(s) today not linked to any of today's orders (not counted): " +
          last.unlinked.map(linkTo).join(', ') + '</p>'
        : '';
      const scroll = p.scrollTop;
      p.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px">' + AE.actionIcon('cleaningRate', 26) + '<b style="flex:1;font-size:16px">Today\'s cleaning rate: <span style="color:' + levelColor(last.pct) + '">' +
        (last.pct == null ? '—' : last.pct + '%') + '</span></b><button type="button" class="sg-btn" data-refresh>Refresh</button></div>' +
        '<div class="sg-soft" style="margin-top:4px">' + last.linked + ' cleanings' + (last.pending ? ' (' + last.pending + ' pending in Arrivals)' : '') +
        ' ÷ ' + last.parents + ' Asurion Mobility orders created today · target ' + TARGET +
        '%, ideally 100% · updated ' + fmtTime(last.at) + (lastError ? '<br><span class="miss">Last refresh failed: ' + esc(lastError) + '</span>' : '') + '</div>' +
        table + extra +
        '<p class="sg-soft" style="margin:10px 0 0"><a href="/reporting/metrics">Past days: Reports → Cleaning rate history</a></p>';
      p.scrollTop = scroll;
      p.querySelector('[data-refresh]').onclick = (e) => { e.stopPropagation(); refresh(); };
      p.querySelectorAll('.sg-cast-go').forEach((btn) => {
        btn.onclick = (e) => {
          e.preventDefault(); e.stopPropagation();
          p.remove();
          AE.autoClose.dualcast({ items: JSON.parse(btn.dataset.dual), customerName: btn.dataset.name });
        };
      });
      p.querySelectorAll('.sg-mk').forEach((btn) => {
        btn.onclick = (e) => {
          e.preventDefault(); e.stopPropagation();
          p.remove(); // get out of the way of the confirmation and progress panel
          AE.autoClose.confirmAndRun({ arrivalId: Number(btn.dataset.arrival), programId: Number(btn.dataset.program), customerName: btn.dataset.name });
        };
      });
    }

    function togglePanel(e) {
      e.stopPropagation();
      const p = document.getElementById(PANEL_ID);
      if (p) p.remove(); else { renderPanel(); AE.track('cleaningRate:open'); }
    }
    document.addEventListener('click', (e) => {
      const p = document.getElementById(PANEL_ID), b = document.getElementById(BADGE_ID);
      if (p && !p.contains(e.target) && !(b && b.contains(e.target))) p.remove();
    });

    async function refresh() {
      if (loading) return;
      loading = true; renderBadge();
      try { last = await compute(); lastError = null; }
      catch (e) { lastError = e.message || String(e); }
      finally {
        loading = false; renderBadge();
        if (document.getElementById(PANEL_ID)) renderPanel();
        if (document.getElementById(HIST_ID) && !histBusy) showHistory();
      }
    }

    // ------------------------------------------------------------ history (Reports page)
    const HIST_KEY = 'ae_rate_history', HIST_ID = 'sg-rate-history', DAY = 86400000;
    const dayStart = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
    const keyOf = (d) => { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
    const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
    const RANGES = [
      ['7', 'Last 7 days', () => [addDays(dayStart(new Date()), -6), dayStart(new Date())]],
      ['30', 'Last 30 days', () => [addDays(dayStart(new Date()), -29), dayStart(new Date())]],
      ['month', 'This month', () => { const t = dayStart(new Date()); return [new Date(t.getFullYear(), t.getMonth(), 1), t]; }],
      ['lastMonth', 'Last month', () => { const t = new Date(); return [new Date(t.getFullYear(), t.getMonth() - 1, 1), new Date(t.getFullYear(), t.getMonth(), 0)]; }],
      ['90', 'Last 90 days', () => [addDays(dayStart(new Date()), -89), dayStart(new Date())]],
    ];
    let histRange = '7', histBusy = null, histErr = null, store = null;
    const histLoadedAt = {}; // range → when its days were last brought up to date (redone every 10 minutes at most)

    // One past day, exactly like compute() but without pending arrivals.
    function tallyDays(wos, keys) {
      const out = {};
      for (const k of keys) {
        const start = new Date(k + 'T00:00:00').getTime(), end = start + DAY;
        const inDay = (r) => { const t = Date.parse(r.createdAt); return t >= start && t < end; };
        const parents = wos.filter((r) => r.programId === AE.PARENT_PROGRAM_ID && inDay(r)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
        const cleanings = AE.data.cleanings(wos, [], inDay);
        const used = new Set();
        let linked = 0;
        for (const p of parents) {
          const m = cleanings.filter((c) => !used.has(c.key) && AE.data.belongs(c, p));
          m.forEach((c) => used.add(c.key));
          linked += m.length;
        }
        out[k] = [parents.length, linked];
      }
      return out;
    }
    const histCache = () => { const all = GM_getValue(HIST_KEY, {}); return (store && all[store]) || {}; };
    function saveHist(days) {
      const all = GM_getValue(HIST_KEY, {});
      const mine = Object.assign({}, all[store] || {}, days);
      const cutoff = keyOf(addDays(new Date(), -400)); // a little over a year
      for (const k of Object.keys(mine)) if (k < cutoff) delete mine[k];
      all[store] = mine;
      GM_setValue(HIST_KEY, all);
    }
    // Make sure every day in [from, to) before today is known; the last two are always redone.
    async function loadHistory(from) {
      if (!store) store = AE_SANDBOX ? 'sandbox' : String((await AE.profile()).storeId || ''); // sandbox numbers never mix with a real store's
      const today = dayStart(new Date());
      const cache = histCache(), need = [];
      for (let d = new Date(from); d < today; d = addDays(d, 1)) {
        const k = keyOf(d);
        if (!cache[k] || d >= addDays(today, -2)) need.push(k);
      }
      if (!need.length) return;
      const since = new Date(need[0] + 'T00:00:00').getTime();
      const wos = await AE.data.workorders(since, 40); // closed lists newest first; stops past `since`
      saveHist(tallyDays(wos, need));
    }

    const pctOf = (parents, linked) => (parents ? Math.round((linked / parents) * 100) : null);
    const dayLabel = (k, opts) => new Date(k + 'T00:00:00').toLocaleDateString([], opts || { weekday: 'short', month: 'short', day: 'numeric' });
    function historyCard() {
      const [from, to] = RANGES.find((r) => r[0] === histRange)[2]();
      const cache = histCache(), todayKey = keyOf(new Date());
      const days = [];
      for (let d = new Date(from); d <= to; d = addDays(d, 1)) {
        const k = keyOf(d);
        if (k === todayKey) days.push({ k, today: true, parents: last ? last.parents : null, linked: last ? last.linked : null });
        else days.push({ k, parents: cache[k] ? cache[k][0] : null, linked: cache[k] ? cache[k][1] : null });
      }
      const known = days.filter((d) => d.parents != null);
      const P = known.reduce((n, d) => n + d.parents, 0), L = known.reduce((n, d) => n + d.linked, 0);
      const withOrders = known.filter((d) => d.parents);
      const atTarget = withOrders.filter((d) => pctOf(d.parents, d.linked) >= TARGET).length;
      const overall = pctOf(P, L);
      const top = Math.max(150, ...withOrders.map((d) => pctOf(d.parents, d.linked)));
      const bar = (d) => {
        const pct = d.parents ? pctOf(d.parents, d.linked) : null;
        const tip = dayLabel(d.k) + (d.today ? ' (so far)' : '') + ': ' + (d.parents == null ? 'loading' : d.parents ? d.linked + '/' + d.parents + ' · ' + pct + '%' : 'no AM orders');
        return h('div', { class: 'col', title: tip },
          h('div', { class: 'bar ' + (pct == null ? 'none' : level(pct)) + (d.today ? ' today' : ''), style: 'height:' + (pct == null ? 3 : Math.max(3, Math.min(100, (pct / top) * 100))) + '%' }));
      };
      const busy = !!histBusy;
      return h('div', { id: HIST_ID, class: 'sg sg-card' },
        h('div', { class: 'hd' }, h('span', { html: AE.actionIcon('cleaningRate', 28) }), h('b', null, 'Cleaning rate history'),
          h('span', { class: 'sg-soft' }, 'Divination · ' + AE_NAME)),
        h('div', { class: 'ranges' }, RANGES.map(([id, label]) => h('button', { type: 'button', class: 'sg-btn' + (id === histRange ? ' sg-primary' : ''), 'aria-pressed': String(id === histRange),
          onclick: () => { histRange = id; AE.track('cleaningRate:history'); showHistory(); } }, label))),
        histErr ? h('div', { class: 'miss', style: 'margin:8px 0' }, "Couldn't load the history: " + histErr) : null,
        h('div', { class: 'sum' },
          h('div', null, h('div', { class: 'big', style: 'color:' + levelColor(overall) }, overall == null ? '—' : overall + '%'), h('div', { class: 'sg-soft' }, 'overall')),
          h('div', null, h('div', { class: 'big' }, L + ' / ' + P), h('div', { class: 'sg-soft' }, 'cleanings / AM orders')),
          h('div', null, h('div', { class: 'big' }, atTarget + ' of ' + withOrders.length), h('div', { class: 'sg-soft' }, 'days at ' + TARGET + '%+')),
          busy ? h('div', { class: 'sg-soft', style: 'align-self:center' }, h('span', { class: 'sg-spin', style: 'display:inline-block;vertical-align:-3px;margin-right:6px' }), 'Loading work orders…') : null),
        h('div', { class: 'chart', style: '--target:' + Math.min(100, (TARGET / top) * 100) + '%;--full:' + Math.min(100, (100 / top) * 100) + '%' },
          h('div', { class: 'line target', title: 'Target ' + TARGET + '%' }), h('div', { class: 'line full', title: '100%' }),
          h('div', { class: 'cols' }, days.map(bar))),
        h('div', { class: 'axis sg-soft' }, h('span', null, dayLabel(days[0].k, { month: 'short', day: 'numeric' })), h('span', null, dayLabel(days[days.length - 1].k, { month: 'short', day: 'numeric' }))),
        h('details', { class: 'days' }, h('summary', null, 'Day by day'),
          h('table', null, h('thead', null, h('tr', null, h('th', null, 'Day'), h('th', null, 'AM orders'), h('th', null, 'Cleanings'), h('th', null, 'Rate'))),
            h('tbody', null, days.slice().reverse().map((d) => {
              const pct = d.parents ? pctOf(d.parents, d.linked) : null;
              return h('tr', null, h('td', null, dayLabel(d.k) + (d.today ? ' (so far)' : '')), h('td', null, d.parents == null ? '…' : d.parents),
                h('td', null, d.linked == null ? '…' : d.linked), h('td', { style: 'font-weight:700;color:' + levelColor(pct) }, pct == null ? '—' : pct + '%'));
            })))));
    }
    const HIST_CSS = `
      #${HIST_ID} { margin:1.5rem 0 0; padding:16px 20px; font-size:14px; line-height:1.4; }
      #${HIST_ID} .hd { display:flex; align-items:center; gap:10px; margin-bottom:12px; }
      #${HIST_ID} .hd b { font-size:18px; }
      #${HIST_ID} .hd .sg-soft { margin-left:auto; font-size:12px; }
      #${HIST_ID} .ranges { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:14px; }
      #${HIST_ID} .ranges .sg-btn { height:30px; font-size:13px; padding:0 12px; flex:none; }
      #${HIST_ID} .sum { display:flex; flex-wrap:wrap; gap:28px; margin-bottom:14px; }
      #${HIST_ID} .big { font-size:24px; font-weight:700; font-variant-numeric:tabular-nums; }
      #${HIST_ID} .chart { position:relative; height:140px; border-bottom:1px solid var(--aui-outline, #c6c6ca); }
      #${HIST_ID} .cols { position:absolute; inset:0; display:flex; align-items:flex-end; gap:2px; }
      #${HIST_ID} .col { flex:1; height:100%; display:flex; align-items:flex-end; min-width:2px; }
      #${HIST_ID} .bar { width:100%; border-radius:3px 3px 0 0; }
      #${HIST_ID} .bar.good { background:var(--aui-status-success, #136d31); }
      #${HIST_ID} .bar.ok { background:#d6a000; }
      #${HIST_ID} .bar.bad { background:var(--aui-status-error, #b91a24); }
      #${HIST_ID} .bar.none { background:var(--aui-outline, #c6c6ca); }
      #${HIST_ID} .bar.today { opacity:.55; }
      #${HIST_ID} .col:hover .bar { filter:brightness(1.15); }
      #${HIST_ID} .line { position:absolute; left:0; right:0; border-top:1px dashed var(--aui-on-surface-soft, #5d5e61); pointer-events:none; }
      #${HIST_ID} .line.target { bottom:var(--target); }
      #${HIST_ID} .line.full { bottom:var(--full); border-top-style:dotted; opacity:.6; }
      #${HIST_ID} .axis { display:flex; justify-content:space-between; font-size:12px; margin-top:4px; }
      #${HIST_ID} .days { margin-top:12px; }
      #${HIST_ID} .days summary { cursor:pointer; color:var(--aui-primary, #8223d2); font-weight:600; }
      #${HIST_ID} .days table { width:100%; border-collapse:collapse; margin-top:8px; font-variant-numeric:tabular-nums; }
      #${HIST_ID} .days th { text-align:left; font-size:12px; color:var(--aui-on-surface-soft, #5d5e61); padding:6px 8px; border-bottom:1px solid var(--aui-outline-soft, #eeedf1); }
      #${HIST_ID} .days td { padding:6px 8px; border-bottom:1px solid var(--aui-outline-soft, #eeedf1); }
      #${HIST_ID} .miss { color:var(--aui-status-error, #b91a24); font-weight:600; }
      .sg-reports-scroll { overflow-y:auto !important; }
    `;
    /*
      Portal's Reports page is short, so Portal never made it scroll: a
      container above it clips anything taller than the window. With the
      history card the page is taller, so the nearest clipping container is
      made to scroll (only while on Reports; the class comes off elsewhere).
    */
    const SCROLL_CLASS = 'sg-reports-scroll';
    function letReportsScroll(from) {
      for (let x = from && from.parentElement; x; x = x.parentElement) {
        const oy = getComputedStyle(x).overflowY;
        const over = x.scrollHeight > x.clientHeight + 1;
        if (over && (oy === 'auto' || oy === 'scroll')) return; // already scrolls
        if (over && (oy === 'hidden' || oy === 'clip')) { x.classList.add(SCROLL_CLASS); return; }
      }
    }
    const unscroll = () => document.querySelectorAll('.' + SCROLL_CLASS).forEach((x) => x.classList.remove(SCROLL_CLASS));
    function showHistory() {
      const reports = document.querySelector('.reports-card');
      const home = reports && reports.parentElement;
      const old = document.getElementById(HIST_ID);
      if (!home) { old?.remove(); return; }
      if (!document.getElementById('sg-rate-history-css')) document.head.append(h('style', { id: 'sg-rate-history-css' }, HIST_CSS));
      const open = old && old.querySelector('details.days') && old.querySelector('details.days').open;
      const card = historyCard();
      if (open) card.querySelector('details.days').open = true;
      if (old && old.parentElement === home) old.replaceWith(card); else { old?.remove(); home.append(card); }
      const [from] = RANGES.find((r) => r[0] === histRange)[2]();
      if (!histBusy && !(Date.now() - (histLoadedAt[histRange] || 0) < 10 * 60000)) {
        const range = histRange;
        histBusy = loadHistory(from)
          .then(() => { histErr = null; histLoadedAt[range] = Date.now(); }, (e) => { histErr = e.message || String(e); histLoadedAt[range] = Date.now(); })
          .finally(() => { const changed = histBusy; histBusy = null; if (changed && document.getElementById(HIST_ID)) showHistory(); });
      }
    }
    // Portal's Reports page renders late and re-renders; keep the card there.
    let histShownFor = null;
    AE.every(1000, () => {
      if (!/^\/reporting\/metrics/.test(location.pathname)) { histShownFor = null; unscroll(); return; }
      const reports = document.querySelector('.reports-card');
      if (reports && (!document.getElementById(HIST_ID) || histShownFor !== reports)) { histShownFor = reports; showHistory(); }
      const card = document.getElementById(HIST_ID);
      if (card) letReportsScroll(card);
    });

    const onPortal = () => !/^\/login/.test(location.pathname);
    AE.every(1500, () => { if (onPortal()) renderBadge(); }); // SPA re-renders can drop the badge
    setInterval(() => { if (onPortal() && !document.hidden) refresh(); }, REFRESH_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && onPortal() && (!last || Date.now() - last.at > REFRESH_MS)) refresh();
    });
    AE.on('cleaning-changed', () => refresh());
    if (onPortal()) refresh();
  },
});
