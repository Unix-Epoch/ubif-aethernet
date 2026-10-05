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
      #${PILL_ID}.icon { width:30px; height:30px; padding:0; justify-content:center; border:2px solid var(--aui-status-success,#136d31); background:var(--aui-surface,#fff); }
      #${PILL_ID}.avail .sg-aicon { width:18px; height:18px; border-radius:50%; }
      #${PILL_ID}.icon .sg-aicon { width:22px; height:22px; border-radius:50%; }
      #${POP_ID} .hd { display:flex; align-items:center; gap:8px; font-size:16px; font-weight:700; }
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
        // Shaped like a list row so AE.data.belongs() can compare it; the list's own
        // row is used when it's there (it has the customer's name, for dual-IMEI phones).
        let self = { customerDevice: { imei: dev.imei, customerId: dev.customerId }, customer: { customerId: dev.customerId } };
        let matched = [];
        if (!AE.CLEANING_PROGRAMS[wo.programId]) {
          const [wos, arrs] = await Promise.all([AE.data.workorders(created - WINDOW_MS, 5), AE.data.arrivals()]);
          const row = wos.find((r) => String(r.workorderId) === String(woId));
          if (row && AE.data.imeiOf(row)) self = row;
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
      if (!s || s.status === 'loading') return { cls: 'load', html: '<span class="sg-spin"></span>Divining…' };
      if (s.status === 'error') return { cls: 'none', html: 'Divination failed', bug: true,
        title: 'Esuna and Divination seem to have hit a roadblock somewhere. Click to report a bug.' };
      if (AE.CLEANING_PROGRAMS[s.wo.programId]) return null; // this is a cleaning
      const avail = s.matched.filter((c) => c.pending).length, done = s.matched.length - avail;
      if (!s.matched.length) return s.wo.programId === AE.PARENT_PROGRAM_ID ? { cls: 'none', html: 'No cleanings' } : null;
      if (avail && done) return { cls: 'avail', html: AE.actionIcon('woCleanings', 18) + 'Swiftcast available (' + avail + ' / ' + done + ')', title: avail + ' available, ' + done + ' done' };
      if (avail) return { cls: 'avail', html: AE.actionIcon('woCleanings', 18) + 'Swiftcast available (' + avail + ')' };
      return { cls: 'done icon', html: AE.actionIcon('woCleanings', 22), title: (done === 1 ? '1 cleaning' : done + ' cleanings') + ' done — click for details' };
    }

    function render() {
      const woId = currentWoId();
      const existing = document.getElementById(PILL_ID);
      const spec = state && state.woId === woId ? pillFor(state) : null;
      const row = woId && nameRow(woId);
      if (!spec || !row) { existing?.remove(); return; }
      const pill = existing || h('button', { id: PILL_ID, type: 'button', class: 'sg', onclick: (e) => pillClick(e) });
      pill.className = 'sg ' + spec.cls;
      // A failed lookup: the pill is a bug report link carrying the error (AE.bugLink) instead of opening the list.
      if (spec.bug) pill.dataset.aeBug = JSON.stringify({ where: 'Esuna', error: 'Cleaning lookup for WO ' + woId + ' failed: ' + state.error });
      else delete pill.dataset.aeBug;
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
            ? '<button type="button" class="sg-btn sg-primary" data-arrival="' + c.arrivalId + '" data-program="' + c.programId + '" data-name="' + esc(AE.data.nameOf(c)) + '">' + AE.actionIcon('autoClose', 18) + 'Swiftcast this</button>'
            : '';
          return '<div class="row"><div><b>' + label + '</b><div class="sg-soft">Available — <a href="/check-in/arrivals/' + c.arrivalId + '">arrival ' + c.arrivalId + '</a></div></div>' + act + '</div>';
        }
        return '<div class="row"><div><b>' + label + '</b><div class="sg-soft"><a href="/repair/workorder/' + c.workorderId + '">WO ' + c.workorderId + '</a> · ' +
          esc(c.workorderStatusName || '') + '</div></div><span style="color:var(--aui-status-success,#136d31);font-weight:700">✓</span></div>';
      }).join('');
      const waiting = state.matched.filter((c) => c.pending);
      const dual = AE.autoClose && AE.autoClose.dualcastOn() && waiting.length >= 2
        ? '<button type="button" class="sg-btn sg-primary" data-dualcast style="width:100%;justify-content:center;margin:0 0 8px">' + AE.actionIcon(waiting.length >= 3 ? 'triplecast' : 'dualcast', 18) +
          (waiting.length >= 3 ? 'Triplecast' : 'Dualcast') + ' this</button>'
        : '';
      pop.innerHTML = '<div class="hd">' + AE.actionIcon('woCleanings', 24) + 'Esuna</div>' +
        '<div class="sg-soft" style="margin:2px 0 8px">Quickly clear out this WO\'s cleanings</div>' + dual +
        (rows || '<p class="sg-soft">There\'s nothing here! Check Divination at the top to see if there are unlinked cleanings!</p>');
      const db = pop.querySelector('[data-dualcast]');
      if (db) db.onclick = (e) => {
        e.stopPropagation();
        pop.remove();
        AE.autoClose.dualcast({ items: waiting.map((c) => ({ arrivalId: c.arrivalId, programId: c.programId })), customerName: AE.data.nameOf(state.matched[0]) });
      };
      pop.querySelectorAll('button[data-arrival]').forEach((b) => {
        b.onclick = (e) => {
          e.stopPropagation();
          pop.remove();
          AE.autoClose.confirmAndRun({ arrivalId: Number(b.dataset.arrival), programId: Number(b.dataset.program), customerName: b.dataset.name });
        };
      });
    }

    function pillClick(e) {
      if (e.currentTarget.dataset.aeBug) return; // the bug report link handler (06-feedback.js) takes it
      togglePop(e);
    }
    function togglePop(e) {
      e.stopPropagation();
      const pop = document.getElementById(POP_ID);
      if (pop) pop.remove(); else { renderPop(); AE.track('woCleanings:open'); }
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
