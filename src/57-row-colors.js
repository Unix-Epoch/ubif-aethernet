/*
  Rainbow Drip (WO list row colors) — colors each row of a work-order list
  by its status (Garrett's colors, Sep 30, 2026).

  Portal draws the status as a tag in a "Status" column and puts nothing on
  the row itself, so every row with a work-order link gets a class
  `status-<status name>` (e.g. status-ready-for-pickup) and the CSS below
  colors its cells. The Status column is found by its header; without one,
  the first cell whose text is a known status is used. React reuses rows,
  so the class is swapped whenever a row's status text changes.
*/
AE.crystal({
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
        if (row.dataset.aeStatus === status) continue;
        if (row.dataset.aeStatus) row.classList.remove('status-' + row.dataset.aeStatus);
        if (status) row.classList.add('status-' + status);
        row.dataset.aeStatus = status;
      }
    }
    // Lists render and re-render without a page load: repaint on DOM changes (once per frame).
    let queued = false;
    new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; paint(); }); } })
      .observe(document.body, { childList: true, subtree: true, characterData: true });
    paint();
    AE.trackDaily('rowColors:on');
  },
});
