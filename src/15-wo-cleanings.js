/*
  Esuna (WO cleanings pill) — on a work order page, a pill right after the
  customer's name saying whether this device has cleanings:

    Cleanings available (2)   cleaning arrivals waiting in Arrivals
    Cleanings done (2)        cleaning WOs exist (in progress or sold)
    No cleanings              an Asurion Mobility WO with none found

  Click it for the list. Available ones have a Create button (cleaning
  auto-close, after a confirmation) when that crystal is on. Not shown on a
  cleaning WO itself, or on non-Asurion-Mobility WOs with no cleanings.

  Cleanings match this WO by device IMEI (customer ID only if there's no
  IMEI), created within 2 days of the WO. Read-only lookups.
*/
AE.crystal({
  id: 'woCleanings',
  name: 'Esuna',
  sites: ['portal.ubreakifix.net'],
  run() {
    const { h, esc } = AE;
    const PILL_ID = 'sg-wo-clean-pill', POP_ID = 'sg-wo-clean-pop';
    const WINDOW_MS = 2 * 86400000;
    const REFRESH_MS = 2 * 60 * 1000;
    let state = null;        // { woId, status: 'loading'|'ready'|'error', wo, matched, error, at }
    let loadingFor = null;

    document.head.append(h('style', null, `
      #${PILL_ID} { display:inline-flex; align-items:center; gap:6px; height:28px; margin-left:14px; padding:0 12px; border-radius:10000rem;
        border:1px solid transparent; font:600 14px/1 Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; cursor:pointer; white-space:nowrap; flex:none;
        align-self:center; }
      #${PILL_ID}.avail { background:var(--aui-primary,#8223d2); color:var(--aui-on-primary,#fff); }
      #${PILL_ID}.done  { background:var(--aui-status-success-soft,#c5ffc8); color:var(--aui-status-on-success-soft,#062011); }
      #${PILL_ID}.none  { background:transparent; border-color:var(--aui-outline,#c6c6ca); color:var(--aui-on-surface-soft,#5d5e61); font-weight:400; }
      #${PILL_ID}.load  { background:transparent; border-color:var(--aui-outline-soft,#eeedf1); color:var(--aui-on-surface-soft,#5d5e61); font-weight:400; }
      #${PILL_ID} .sg-spin { width:12px; height:12px; }
      #${POP_ID} { position:fixed; z-index:2147483646; width:380px; padding:16px; font-size:14px; line-height:1.4; }
      #${POP_ID} .row { display:flex; align-items:center; gap:10px; padding:10px 0; border-top:1px solid var(--aui-outline-soft,#eeedf1); }
      #${POP_ID} .row:first-of-type { border-top:0; }
      #${POP_ID} .row > div { flex:1; min-width:0; }
      #${POP_ID} a { color:var(--aui-primary,#8223d2); text-decoration:none; }
      #${POP_ID} a:hover { text-decoration:underline; }
    `));

    const currentWoId = () => { const m = location.pathname.match(/^\/repair\/workorder\/(\d+)/); return m ? m[1] : null; };

    // quiet = background refresh: keep showing the current result meanwhile.
    async function load(woId, quiet = false) {
      loadingFor = woId;
      if (!quiet || !state || state.woId !== woId) { state = { woId, status: 'loading' }; render(); }
      try {
        const j = await AE.api('GET', '/api/workorder/' + woId);
        const wo = (j && j.workorder) || AE.unwrap(j);
        const created = Date.parse(wo.createdAt) || Date.now();
        const dev = wo.CustomerDevice || {};
        // Shaped like a list row so AE.data.belongs() can compare it.
        const self = { customerDevice: { imei: dev.imei, customerId: dev.customerId }, customer: { customerId: dev.customerId } };
        let matched = [];
        if (!AE.CLEANING_PROGRAMS[wo.programId]) {
          const [wos, arrs] = await Promise.all([AE.data.workorders(created - WINDOW_MS, 5), AE.data.arrivals()]);
          const near = (r) => Math.abs(Date.parse(r.createdAt) - created) < WINDOW_MS;
          matched = AE.data.cleanings(wos, arrs, near).filter((c) => String(c.workorderId) !== String(woId) && AE.data.belongs(c, self));
        }
        if (loadingFor !== woId) return; // navigated away meanwhile
        state = { woId, status: 'ready', wo, matched, at: Date.now() };
      } catch (e) {
        if (loadingFor !== woId) return;
        state = { woId, status: 'error', error: e.message || String(e), at: Date.now() };
      }
      render();
      if (document.getElementById(POP_ID)) renderPop();
    }

    // Anchor: the flex row holding the "Work order #… | NAME" heading.
    function nameRow(woId) {
      const heading = [...document.querySelectorAll('[data-aui="text"]')].find((el) => el.offsetParent && el.textContent.trim().startsWith('Work order #' + woId));
      return heading && heading.parentElement;
    }

    function pillFor(s) {
      if (!s || s.status === 'loading') return { cls: 'load', html: '<span class="sg-spin"></span>Checking cleanings…' };
      if (s.status === 'error') return { cls: 'none', html: 'Cleanings: couldn\'t check', title: s.error };
      if (AE.CLEANING_PROGRAMS[s.wo.programId]) return null; // this is a cleaning
      const avail = s.matched.filter((c) => c.pending).length, done = s.matched.length - avail;
      if (!s.matched.length) return s.wo.programId === AE.PARENT_PROGRAM_ID ? { cls: 'none', html: 'No cleanings' } : null;
      if (avail && done) return { cls: 'avail', html: AE.icon('bolt', 14) + 'Cleanings: ' + avail + ' available, ' + done + ' done' };
      if (avail) return { cls: 'avail', html: AE.icon('bolt', 14) + 'Cleanings available (' + avail + ')' };
      return { cls: 'done', html: '✓ Cleanings done (' + done + ')' };
    }

    function render() {
      const woId = currentWoId();
      const existing = document.getElementById(PILL_ID);
      const spec = state && state.woId === woId ? pillFor(state) : null;
      const row = woId && nameRow(woId);
      if (!spec || !row) { existing?.remove(); return; }
      const pill = existing || h('button', { id: PILL_ID, type: 'button', class: 'sg', onclick: togglePop });
      pill.className = 'sg ' + spec.cls;
      pill.innerHTML = spec.html;
      pill.title = spec.title || 'Cleanings for this device — click for details';
      if (pill.parentElement !== row) row.appendChild(pill);
    }

    function renderPop() {
      const pill = document.getElementById(PILL_ID);
      if (!pill || !state || state.status !== 'ready') { document.getElementById(POP_ID)?.remove(); return; }
      let pop = document.getElementById(POP_ID);
      if (!pop) { pop = h('div', { id: POP_ID, class: 'sg sg-card' }); document.body.appendChild(pop); }
      const r = pill.getBoundingClientRect();
      pop.style.top = (r.bottom + 8) + 'px';
      pop.style.left = Math.max(8, Math.min(r.left, innerWidth - 396)) + 'px';
      const rows = state.matched.map((c) => {
        const label = esc(AE.CLEANING_PROGRAMS[c.programId]);
        if (c.pending) {
          const act = AE.autoClose
            ? '<button type="button" class="sg-btn sg-primary" data-arrival="' + c.arrivalId + '" data-program="' + c.programId + '" data-name="' + esc(AE.data.nameOf(c)) + '">' + AE.icon('bolt', 14) + 'Create</button>'
            : '';
          return '<div class="row"><div><b>' + label + '</b><div class="sg-soft">Available — <a href="/check-in/arrivals/' + c.arrivalId + '">arrival ' + c.arrivalId + '</a></div></div>' + act + '</div>';
        }
        return '<div class="row"><div><b>' + label + '</b><div class="sg-soft"><a href="/repair/workorder/' + c.workorderId + '">WO ' + c.workorderId + '</a> · ' +
          esc(c.workorderStatusName || '') + '</div></div><span style="color:var(--aui-status-success,#136d31);font-weight:700">✓</span></div>';
      }).join('');
      pop.innerHTML = '<b style="font-size:16px">Cleanings for this device</b>' +
        '<div class="sg-soft" style="margin:2px 0 8px">Matched to this WO by device IMEI</div>' +
        (rows || '<p class="sg-soft">No cleanings found for this device (open, recently closed, or waiting in Arrivals).</p>');
      pop.querySelectorAll('button[data-arrival]').forEach((b) => {
        b.onclick = (e) => {
          e.stopPropagation();
          pop.remove();
          AE.autoClose.confirmAndRun({ arrivalId: Number(b.dataset.arrival), programId: Number(b.dataset.program), customerName: b.dataset.name });
        };
      });
    }

    function togglePop(e) {
      e.stopPropagation();
      const pop = document.getElementById(POP_ID);
      if (pop) pop.remove(); else renderPop();
    }
    document.addEventListener('click', (e) => {
      const pop = document.getElementById(POP_ID), pill = document.getElementById(PILL_ID);
      if (pop && !pop.contains(e.target) && !(pill && pill.contains(e.target))) pop.remove();
    });

    AE.every(1000, () => {
      const woId = currentWoId();
      if (!woId) { document.getElementById(PILL_ID)?.remove(); document.getElementById(POP_ID)?.remove(); state = null; loadingFor = null; return; }
      const stale = state && state.status !== 'loading' && Date.now() - state.at > REFRESH_MS && !document.hidden;
      if (!state || state.woId !== woId) { if (loadingFor !== woId) load(woId); }
      else if (stale) { state.at = Date.now(); load(woId, true); }
      render(); // Portal re-renders the header; put the pill back
    });
    AE.on('cleaning-changed', () => { const woId = currentWoId(); if (woId) load(woId, true); });
  },
});
