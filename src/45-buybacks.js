/*
  Bountiful Yield (buyback add-all) — on a buyback order's "Add buyback parts" popout
  (Buybacks tab), adds bulk-add buttons:

    Add all Apple devices (TLC)          destination "Asurion Reverse Logistics"
    Add all Samsung/Google parts (UROC)  destination mentions UROC

  Each clicks the row's own add button one at a time, keyed by serial number
  (the table re-renders after every add), waiting for the row to leave the
  list and the list to refill before the next. Safety limits stop a run from
  ever spinning: per-row retry cap, stall detection with a bounded tab-bounce
  recovery, a click cap and a wall-clock cap. A Stop button halts it.

  Crystallized Sep 26 2026 from the standalone "Select All - Buybacks" v1.1.1
  (Tampermonkey on Zen). Its buttons often didn't appear because its @match
  was only /boh/inventory/buyback-order/* — Tampermonkey injects on a real
  page load and Portal is a single-page app, so arriving from any other
  portal page meant the script never ran (removing + re-adding it forced a
  reinject). As a crystal it runs portal-wide and gates on the path itself.
*/
AE.crystal({
  id: 'buybacks',
  name: 'Bountiful Yield',
  sites: ['portal.ubreakifix.net'],
  run() {
    const { h } = AE;
    const PATH_RE = /^\/boh\/inventory\/buyback-order\//;
    const TOOLBAR_ID = 'sg-buyback-toolbar';

    // Safety limits — these are what stop a run from ever spinning forever.
    const SETTLE_MS = 8000;           // max wait for a clicked row to leave the list
    const REFRESH_MS = 8000;          // max wait for the list to repopulate after an add
    const GAP_MS = 300;               // pause between adds
    const MAX_STALLS = 3;             // consecutive no-effect clicks -> abort
    const MAX_TRIES = 2;              // attempts allowed per individual row
    const MAX_RECOVER = 2;            // tab-bounce recovery attempts per run
    const HARD_CAP = 500;             // absolute click ceiling per run
    const WALL_MS = 10 * 60 * 1000;   // absolute time ceiling per run

    const GROUPS = {
      apple: { label: 'Apple devices', hint: 'TLC', variant: 'sg-primary', test: (d) => /asurion\s+reverse\s+logistics/i.test(d) },
      samsungGoogle: { label: 'Samsung/Google parts', hint: 'UROC', variant: 'sg-outline', test: (d) => /\buroc\b/i.test(d) },
    };

    document.head.append(h('style', null, `
      #${TOOLBAR_ID} { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin:8px 0 12px; }
      #${TOOLBAR_ID} .sg-outline { border-color:var(--aui-primary,#8223d2); color:var(--aui-primary,#8223d2); }
      #${TOOLBAR_ID} .sg-outline:hover { background:var(--aui-primary-soft,#faecff); }
      #${TOOLBAR_ID} .sg-btn:disabled { opacity:.45; cursor:not-allowed; }
      #${TOOLBAR_ID} .count { font-weight:700; }
      #${TOOLBAR_ID} .status { display:inline-flex; align-items:center; gap:6px; font-size:13px; color:var(--aui-on-surface-soft,#5d5e61); }
      #${TOOLBAR_ID} .sg-spin { width:14px; height:14px; }
    `));

    const state = { running: false, cancel: false, status: '' };
    const sleep = AE.sleep;
    function waitUntil(fn, timeout) {
      return new Promise((resolve) => {
        const t0 = Date.now();
        const iv = setInterval(() => {
          let ok = false;
          try { ok = !!fn(); } catch (_) { ok = false; }
          if (ok) { clearInterval(iv); resolve(true); }
          else if (state.cancel || Date.now() - t0 > timeout) { clearInterval(iv); resolve(false); }
        }, 100);
      });
    }

    // ---------- page structure ----------
    // Dialog libraries sometimes keep a closed popout mounted (hidden); a
    // leftover from a previous buyback still matches the heading, so only
    // visible matches count, and the most recently mounted (last) wins.
    function isVisible(el) {
      if (!el) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (el.offsetParent === null && style.position !== 'fixed') return false;
      return true;
    }
    function getModal() {
      const heads = [...document.querySelectorAll('h1,h2,h3')]
        .filter((e) => /^\s*add\s+buyback\s+parts\s*$/i.test(e.textContent || ''))
        .filter(isVisible);
      const hd = heads[heads.length - 1];
      let n = hd;
      for (let i = 0; i < 12 && n; i++) { n = n.parentElement; if (n && n.querySelector('table')) return n; }
      return null;
    }
    const tabButtons = (modal, re) => [...modal.querySelectorAll('button,[role="tab"]')].filter((b) => re.test((b.innerText || '').trim()));
    // The Damaged tab has identical columns; the active tab is the only reliable tell.
    function buybacksTabActive(modal) {
      const tabs = tabButtons(modal, /^buybacks\s*\(\d+\)$/i);
      return tabs.length > 0 && tabs.some((b) => b.getAttribute('aria-selected') === 'true');
    }
    function getTable(modal) {
      if (!modal) return null;
      return [...modal.querySelectorAll('table')].find((t) => {
        const hs = [...t.querySelectorAll('thead th')].map((x) => (x.innerText || '').trim().toLowerCase());
        return hs.includes('serial number') && hs.includes('destination');
      }) || null;
    }
    const colIdx = (table, re) => [...table.querySelectorAll('thead th')].findIndex((th) => re.test((th.innerText || '').trim()));
    function getRows(table) {
      if (!table) return [];
      const si = colIdx(table, /serial\s*number/i), di = colIdx(table, /destination/i);
      if (si < 0 || di < 0) return [];
      return [...table.querySelectorAll('tbody tr')].map((tr) => {
        const c = tr.children;
        return { tr, serial: c[si] ? (c[si].innerText || '').trim() : '', dest: c[di] ? (c[di].innerText || '').trim() : '', btn: tr.querySelector('td:last-child button') };
      }).filter((r) => r.serial && r.btn && !r.btn.disabled);
    }
    const groupRows = (table, key) => getRows(table).filter((r) => GROUPS[key].test(r.dest));
    // The list empties for a moment while it refetches after every add —
    // never treat that as "finished" without giving it time to come back.
    const listRepopulated = (key) => waitUntil(() => { const t = getTable(getModal()); return t && groupRows(t, key).length > 0; }, REFRESH_MS);
    // If clicks stop registering, bouncing tabs re-renders the rows with fresh handlers. Read-only, bounded.
    async function recover(key) {
      const modal = getModal();
      if (!modal) return false;
      const bb = tabButtons(modal, /^buybacks\s*\(\d+\)$/i)[0];
      const dmg = tabButtons(modal, /^damaged\s*\(\d+\)$/i)[0];
      if (!bb) return false;
      if (dmg) { try { dmg.click(); } catch (_) {} await sleep(600); }
      try { bb.click(); } catch (_) {}
      await sleep(600);
      return listRepopulated(key);
    }

    // ---------- UI ----------
    function buildToolbar() {
      const mk = (key) => h('button', { type: 'button', class: 'sg sg-btn ' + GROUPS[key].variant, onclick: () => addAll(key) });
      const bar = h('div', { id: TOOLBAR_ID, class: 'sg' });
      bar._apple = mk('apple');
      bar._sg = mk('samsungGoogle');
      bar._stop = h('button', { type: 'button', class: 'sg sg-btn sg-danger', onclick: () => { state.cancel = true; setStatus('Stopping…'); } }, '■ Stop');
      bar._status = h('span', { class: 'status' });
      bar.append(bar._apple, bar._sg, bar._stop, bar._status);
      return bar;
    }
    function refreshToolbar() {
      const bar = document.getElementById(TOOLBAR_ID);
      if (!bar) return;
      const table = getTable(getModal());
      const a = table ? groupRows(table, 'apple').length : 0;
      const s = table ? groupRows(table, 'samsungGoogle').length : 0;
      const label = (key, n) => 'Add all ' + GROUPS[key].label + ' (' + GROUPS[key].hint + ') · <span class="count">' + n + '</span>';
      const setHtml = (el, html) => { if (el.innerHTML !== html) el.innerHTML = html; };
      setHtml(bar._apple, label('apple', a));
      setHtml(bar._sg, label('samsungGoogle', s));
      bar._apple.disabled = state.running || a === 0;
      bar._sg.disabled = state.running || s === 0;
      bar._stop.style.display = state.running ? '' : 'none';
      setHtml(bar._status, (state.running ? '<span class="sg-spin"></span>' : '') + AE.esc(state.status || ''));
    }
    const setStatus = (t) => { state.status = t; refreshToolbar(); };

    function anchorFor(modal, table) {
      const p = [...modal.querySelectorAll('p,div,span,h4')]
        .find((e) => e.children.length <= 2 && /^salvages\s*\(\d+\)/i.test((e.innerText || '').trim()));
      if (p && p.parentElement) return { parent: p.parentElement, next: p.nextSibling };
      let n = table;
      while (n.parentElement && n.parentElement !== modal) n = n.parentElement;
      return { parent: n.parentElement || modal, next: n };
    }

    function sync() {
      const existing = document.getElementById(TOOLBAR_ID);
      if (!PATH_RE.test(location.pathname)) { if (existing && !state.running) existing.remove(); return; }
      const modal = getModal();
      const table = modal ? getTable(modal) : null;
      if (!modal || !table || !buybacksTabActive(modal)) { if (existing && !state.running) existing.remove(); return; }
      if (!existing || !modal.contains(existing)) {
        if (existing) existing.remove();
        const { parent, next } = anchorFor(modal, table);
        parent.insertBefore(buildToolbar(), next);
      }
      refreshToolbar();
    }

    // ---------- the run ----------
    async function addAll(key) {
      if (AE.status.blocked('buybacks')) return;
      if (state.running) return;
      const g = GROUPS[key];
      state.running = true; state.cancel = false;
      const tries = new Map();
      const t0 = Date.now();
      let clicks = 0, added = 0, stalls = 0, recoveries = 0;
      setStatus('Starting…');
      try {
        while (true) {
          if (state.cancel) { setStatus('Stopped — ' + added + ' added.'); break; }
          if (Date.now() - t0 > WALL_MS) { setStatus('Time limit reached — ' + added + ' added.'); break; }
          if (clicks >= HARD_CAP) { setStatus('Safety cap (' + HARD_CAP + ') reached — ' + added + ' added.'); break; }
          const modal = getModal();
          if (!modal) { setStatus('Popout closed — ' + added + ' added.'); break; }
          if (!buybacksTabActive(modal)) { setStatus('Left the Buybacks tab — ' + added + ' added.'); break; }
          const table = getTable(modal);
          if (!table) { setStatus('List not found — ' + added + ' added.'); break; }
          const rows = groupRows(table, key);
          if (!rows.length) {
            // Could be the post-add refresh rather than a finished list.
            setStatus('Waiting for the list to refresh… (' + added + ' added)');
            if (!(await listRepopulated(key))) { setStatus('Done — added ' + added + ' ' + g.label + '.'); break; }
            continue;
          }
          // Keyed by serial, never index; a per-serial attempt cap makes retry loops impossible.
          const next = rows.find((r) => (tries.get(r.serial) || 0) < MAX_TRIES);
          if (!next) { setStatus('Stopped — ' + added + ' added, ' + rows.length + ' would not add.'); break; }
          const serial = next.serial;
          tries.set(serial, (tries.get(serial) || 0) + 1);
          setStatus('Adding ' + g.label + ' — ' + added + ' done, ' + rows.length + ' left…');
          try { next.btn.click(); } catch (_) {}
          clicks++;
          const gone = await waitUntil(() => { const t = getTable(getModal()); return !t || !getRows(t).some((r) => r.serial === serial); }, SETTLE_MS);
          if (gone) { added++; stalls = 0; }
          else {
            stalls++;
            if (stalls >= MAX_STALLS) {
              if (recoveries < MAX_RECOVER) {
                recoveries++;
                setStatus('No response — refreshing the list (attempt ' + recoveries + '/' + MAX_RECOVER + ')…');
                const ok = await recover(key);
                stalls = 0;
                if (ok) continue;
              }
              setStatus('Stopped: adds stopped registering — ' + added + ' added. Check whether the order needs its parts scanned first.');
              break;
            }
          }
          await listRepopulated(key); // let the list come back before the next click
          await sleep(GAP_MS);
        }
      } finally {
        state.running = false; state.cancel = false;
        refreshToolbar();
      }
    }

    let tid = null;
    new MutationObserver(() => {
      if (tid) return;
      tid = setTimeout(() => { tid = null; try { sync(); } catch (_) {} }, 200);
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected'] });
    sync();
  },
});
