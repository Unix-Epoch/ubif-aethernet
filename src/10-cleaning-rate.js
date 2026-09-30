/*
  Divination (live cleaning rate) — header badge.

  Rate = cleanings linked to today's Asurion Mobility orders ÷ Asurion
  Mobility orders created today (local time). Each cleaning counts on its
  own, so it can pass 100%. Raw percentage only: reason notes are ignored.
  Cleanings link to orders by device IMEI (AT&T cleanings are often under a
  different customer record), falling back to customer ID without an IMEI.

  Pending cleanings count too: a cleaning arrival created today that hasn't
  been checked in yet (still in Arrivals) shows as "pending" and counts. Its
  ⚡ runs the cleaning auto-close (after a confirmation) when that crystal is on.
  See AE.data in core for how WOs and arrivals are fetched and matched.
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
    `));

    async function compute() {
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const startMs = start.getTime(), endMs = startMs + 86400000;
      const [wos, arrs] = await Promise.all([AE.data.workorders(startMs), AE.data.arrivals()]);
      const today = (r) => { const t = Date.parse(r.createdAt); return t >= startMs && t < endMs; };
      // Orders closed as incomplete (list rows' serviceOutcome, from the WO's
      // "service_outcome" attribute) don't count: out of the list and the rate.
      const incomplete = (r) => String(r.serviceOutcome || '').toLowerCase() === 'incomplete';
      const todays = wos.filter((r) => r.programId === AE.PARENT_PROGRAM_ID && today(r)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      const parents = todays.filter((r) => !incomplete(r));
      const dropped = todays.filter(incomplete);
      const cleanings = AE.data.cleanings(wos, arrs, today);
      const used = new Set();
      // Their cleanings are set aside too, rather than listed as "not linked".
      dropped.forEach((p) => cleanings.filter((c) => !used.has(c.key) && AE.data.belongs(c, p)).forEach((c) => used.add(c.key)));
      const rows = parents.map((p) => {
        const matched = cleanings.filter((c) => !used.has(c.key) && AE.data.belongs(c, p));
        matched.forEach((c) => used.add(c.key));
        return { p, matched };
      });
      const linked = rows.reduce((n, r) => n + r.matched.length, 0);
      const pending = rows.reduce((n, r) => n + r.matched.filter((c) => c.pending).length, 0);
      return {
        parents: parents.length, linked, pending, rows, dropped, at: new Date(),
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
          '<td style="text-align:right">' + (matched.length ? matched.map((c) => chip(c, wo)).join('') : '<span class="miss">No cleanings</span>') + '</td></tr>'
        ).join('') + '</table>'
        : '<p class="sg-soft">No Asurion Mobility orders created today yet.</p>';
      const extra = last.unlinked.length
        ? '<p class="sg-soft" style="margin:10px 0 0">' + last.unlinked.length + " cleaning(s) today not linked to any of today's orders (not counted): " +
          last.unlinked.map(linkTo).join(', ') + '</p>'
        : '';
      const notCounted = last.dropped && last.dropped.length
        ? '<p class="sg-soft" style="margin:10px 0 0">Not counted: ' + last.dropped.length + ' order' + (last.dropped.length === 1 ? '' : 's') +
          ' closed as incomplete (' + last.dropped.map((wo) => '<a href="/repair/workorder/' + wo.workorderId + '">' + wo.workorderId + '</a>').join(', ') + ').</p>'
        : '';
      const scroll = p.scrollTop;
      p.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px">' + AE.actionIcon('cleaningRate', 26) + '<b style="flex:1;font-size:16px">Today\'s cleaning rate: <span style="color:' + levelColor(last.pct) + '">' +
        (last.pct == null ? '—' : last.pct + '%') + '</span></b><button type="button" class="sg-btn" data-refresh>Refresh</button></div>' +
        '<div class="sg-soft" style="margin-top:4px">' + last.linked + ' cleanings' + (last.pending ? ' (' + last.pending + ' pending in Arrivals)' : '') +
        ' ÷ ' + last.parents + ' Asurion Mobility orders created today · target ' + TARGET +
        '%, ideally 100% · updated ' + fmtTime(last.at) + (lastError ? '<br><span class="miss">Last refresh failed: ' + esc(lastError) + '</span>' : '') + '</div>' +
        table + extra + notCounted;
      p.scrollTop = scroll;
      p.querySelector('[data-refresh]').onclick = (e) => { e.stopPropagation(); refresh(); };
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
      }
    }

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
