/*
  Rainbow Drip (WO list row colors) — colors each row of a work-order list
  by its status (Garrett's colors, Sep 30, 2026).

  Portal draws the status as a tag in a "Status" column and puts nothing on
  the row itself, so every row with a work-order link gets a class
  `status-<status name>` (e.g. status-ready-for-pickup) and the CSS below
  colors its cells. The Status column is found by its header; without one,
  the first cell whose text is a known status is used. React reuses rows,
  so the class is swapped whenever a row's status text changes.

  It replaces another dev's userscript, "UBIF Status Row Classes", which does
  the same thing the same way. If that (or a Stylus style) is still running,
  a notice explains how to turn it off. Signs of it: a stylesheet that isn't
  ours styling `tr.status-…`, or a row that already has a status- class we
  didn't put there.
*/
AE.shard({
  id: 'rowColors',
  name: 'Rainbow Drip',
  sites: ['portal.ubreakifix.net'],
  run() {
    const RED = '#ff00007a', BLUE = '#24b0ff73', GREEN = '#2bff3875', PURPLE = '#a900ff6e', YELLOW = '#fffe0073';
    const COLORS = {
      'ready-for-work': RED,
      'diagnostics': BLUE,
      'work-in-progress': BLUE,
      'quality-check': BLUE,
      'ready-for-pickup': GREEN,
      'need-to-order': PURPLE,
      'awaiting-callback': YELLOW,
      'awaiting-item': YELLOW,
      'awaiting-device': YELLOW,
      'ready-for-diag': PURPLE,
      'repair-summary': PURPLE,
    };
    const slug = (t) => t.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    document.head.append(AE.h('style', { id: 'ae-row-colors' }, Object.entries(COLORS).map(([s, c]) =>
      `tr.status-${s} td, [role="row"].status-${s} > [role="cell"], [role="row"].status-${s} > [role="gridcell"] { background: ${c} !important; }`).join('\n')));

    const cellsOf = (row) => [...row.children].filter((c) => /^(TD|TH)$/.test(c.tagName) || /^(cell|gridcell|columnheader)$/.test(c.getAttribute('role') || ''));
    // Index of the "Status" column, from the table's header row.
    function statusIndex(table) {
      const head = table.querySelector('thead tr, [role="row"]:has(> [role="columnheader"])');
      return head ? cellsOf(head).findIndex((c) => c.textContent.trim().toLowerCase() === 'status') : -1;
    }

    function paint() {
      const rows = document.querySelectorAll('tbody tr, [role="row"]');
      const idx = new Map();
      for (const row of rows) {
        if (!row.querySelector('a[href*="/repair/workorder/"]')) continue;
        const table = row.closest('table, [role="table"], [role="grid"]');
        if (table && !idx.has(table)) idx.set(table, statusIndex(table));
        const cells = cellsOf(row), i = table ? idx.get(table) : -1;
        let status = i >= 0 && cells[i] ? slug(cells[i].textContent) : '';
        if (!status) status = cells.map((c) => slug(c.textContent)).find((s) => s in COLORS) || '';
        // A status- class on a row we haven't touched yet, or one that isn't ours.
        const mine = row.dataset.aeStatus === undefined ? null : 'status-' + row.dataset.aeStatus;
        if (!foreign && [...row.classList].some((c) => c.startsWith('status-') && c !== mine)) foundOther('row class');
        if (row.dataset.aeStatus === status) continue;
        if (row.dataset.aeStatus) row.classList.remove('status-' + row.dataset.aeStatus);
        if (status) row.classList.add('status-' + status);
        row.dataset.aeStatus = status;
      }
    }
    // ------------------------------------------------ the old script, still on?
    let foreign = null;
    const OTHER_CSS = /tr\.status-[a-z]/;
    function otherStylesheet() {
      for (const el of document.querySelectorAll('style')) if (el.id !== 'ae-row-colors' && OTHER_CSS.test(el.textContent)) return true;
      for (const sh of [...(document.adoptedStyleSheets || [])]) {
        try { if ([...sh.cssRules].some((r) => OTHER_CSS.test(r.cssText))) return true; } catch (_) {}
      }
      return false;
    }
    function foundOther(how) {
      foreign = how;
      console.info('[' + AE_NAME + '] Rainbow Drip: another script is also coloring WO rows (' + how + ')');
      notice();
    }
    // Checked every few seconds for the first two minutes of a page (the other
    // script may start after us).
    const started = Date.now();
    const styleCheck = setInterval(() => {
      if (foreign || Date.now() - started > 120000) return clearInterval(styleCheck);
      if (otherStylesheet()) foundOther('stylesheet');
    }, 3000);

    const DISMISS_KEY = 'ae_row_colors_other_dismissed';
    function notice(opts = {}) {
      const id = 'sg-rowcolors-notice';
      document.getElementById(id)?.remove();
      try { if (!opts.force && sessionStorage.getItem(DISMISS_KEY)) return; } catch (_) {}
      const { h } = AE;
      const close = () => card.remove();
      const card = h('div', { id, class: 'sg sg-card', role: 'status', style:
        'position:fixed;z-index:2147483645;left:16px;bottom:16px;max-width:440px;padding:12px 14px;display:flex;gap:10px;align-items:flex-start;font-size:14px;line-height:1.45;animation:sg-in .2s ease-out' },
        h('span', { style: 'line-height:0;flex:none', html: AE.actionIcon('rowColors', 28) }),
        h('div', { style: 'flex:1' },
          h('b', { style: 'display:block;margin-bottom:2px' }, 'Another script is also coloring these rows'),
          h('div', { class: 'sg-soft', style: 'font-size:13px' },
            'Rainbow Drip in ' + AE_NAME + ' now colors work orders by status, so ', h('b', null, 'UBIF Status Row Classes'), " isn't needed. Turn it off so the two don't clash:"),
          h('ol', { class: 'sg-soft', style: 'font-size:13px;margin:6px 0;padding-left:20px' },
            h('li', null, 'Click the ', h('b', null, 'Tampermonkey'), " icon in your browser's toolbar (it may be under the puzzle-piece Extensions menu)."),
            h('li', null, 'Find ', h('b', null, 'UBIF Status Row Classes'), ' in the list and click its switch so it turns off.'),
            h('li', null, 'Reload this page.')),
          h('div', { class: 'sg-soft', style: 'font-size:12px' }, "If it's a style in Stylus instead, click the Stylus icon and untick it."),
          h('div', { style: 'display:flex;gap:8px;margin-top:10px' },
            h('button', { type: 'button', class: 'sg-btn sg-primary', style: 'height:30px;font-size:13px', onclick: () => location.reload() }, 'Reload page'),
            h('button', { type: 'button', class: 'sg-btn', style: 'height:30px;font-size:13px', onclick: () => { try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch (_) {} close(); } }, 'Later'))),
        h('button', { type: 'button', class: 'sg-x', title: 'Dismiss', onclick: close }, '✕'));
      (document.body || document.documentElement).appendChild(card);
    }
    AE.hooks.rowColorsNotice = () => notice({ force: true }); // dev tools

    // Lists render and re-render without a page load: repaint on DOM changes (once per frame).
    let queued = false;
    new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; paint(); }); } })
      .observe(document.body, { childList: true, subtree: true, characterData: true });
    paint();
    AE.trackDaily('rowColors:on');
  },
});
