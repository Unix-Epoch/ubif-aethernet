/*
  Master's Mend — small fixes to Portal, each with its own switch under the
  crystal in Settings (settings.fixes[id]). New fixes go in FIXES below.

  - logoLink: the ubreakifix logo (top left) is a <button> that routes to the
    dashboard ("/") on click, so it can't be middle-clicked or right-clicked
    into a new tab. A real link to "/" sits over it: middle click, Ctrl/⌘
    click and the right-click menu act on the link; a plain click still goes
    through Portal's own button (no page reload). React owns the button and
    image, so they're never moved; the link is an extra child of the logo
    wrapper, put back if Portal re-renders the header.

  - scanNav: scan to open. Portal already detects barcode scans (its root
    layout: keys under features.scan_delay_ms = 40 ms apart, ending in Enter →
    window event "scanDetected" {scan}) and uses them in a few places: an
    item label on a WO adds it to the cart, an "SO…/WO…" receipt opens a
    "Navigate to work order" dialog, the open global search looks up a
    12-character scan. Nothing handled a WO label (the bare WO number), so
    scanning one did nothing. This fix:
      · WO label (a 9-digit WO number, or WO<number>) → opens that WO,
        anywhere except inventory (/boh), check-in and check-out, where
        scans are data entry. Checked against Portal first.
      · item label (<item number>-<10+ digit serial>) → opens the item's
        page, but only from the dashboard, WO lists, customers and the
        store-products pages. On a WO, Portal adds it to the WO instead.
      · never while you're typing in a field or a dialog/drawer is open
        (the scan is meant for that field), and never acts on scans
        Portal's own pages consume.
    Scanners slower than Portal's 40 ms window were missed entirely; when
    Aethernet sees a scan (keys up to 60 ms apart) that Portal didn't, it
    sends Portal the same scanDetected event, so Portal's own scan features
    work with those scanners too.

  - autoNotes: a "Hide auto notes" switch at the top of a WO's notes.
    Portal's notes are noteType Auto (1: status changes, "X started
    check-in", estimate/contact logs…) or Manual (2: what people write; also
    Recitation's text notes). The notes tab (data-testid "notes-tab") draws
    each as a card with id "note-<noteId>" from the Redux "notes" slice, so
    the auto ones' ids come from there (AE.portal select) and a stylesheet
    hides them; nothing is changed or deleted, and Portal's cards aren't
    touched. The switch is remembered in this browser; flip it back any time.

  - woSort: sort the Work orders list by any column. Portal's table only
    offers ▲▼ on one or two columns per tab (repair.js FA[…].sortableColumns),
    though the server sorts by more. The list's sort is Redux state
    (repair.workorderlistFilterSelection[<primary filter>], `order` =
    "<column id>,ASC|DESC", per tab under tabs[<tab>].order), and the list
    refetches when it changes, so a header click here sets it exactly as
    Portal's own icons do (AE.portal dispatch of
    repair/setWorkorderlistFilterSelection, back to page 1).
      · Sorted by the server, across every page (checked Oct 1, 2026): WO #,
        Created, Program, Status, Next update, Last update, Closed, Cancelled,
        Total.
      · The server ignores or fails on Customer, Device/Issue, Location,
        Service Outcome, Completed, Created By, Cancelled By: those sort the
        rows on the page you're looking at (pick 100 per page for more), and
        say so in their tooltip.
    Portal's own ▲▼ columns are left as they are. Rows moved for a page sort
    are React's, and React re-renders assuming its own order, so the list's
    real order is read from Portal's loaded data (getAllWorkOrders) and the
    rows are put back in it whenever no page sort is on.
*/
AE.fixesInfo = [
  ['logoLink', 'Logo link', 'The ubreakifix logo is a real link to the dashboard: middle-click or right-click it to open a new tab.'],
  ['autoNotes', 'Hide auto notes switch', 'A switch at the top of a work order\'s notes hides the automatic ones (status changes, check-in logs…) so only what people wrote shows. Flip it back any time; nothing is deleted.'],
  ['woSort', 'Sort by any column', 'Every column of the Work orders list can be sorted. Most sort across all pages; a few that Portal can\'t sort (like Customer) sort the page you\'re on.'],
  ['scanNav', 'Scan to open', 'Scan a WO label to open the WO, or an item label to open the item (on a WO, items are added to it as usual). Never on inventory, check-in or check-out pages, or while typing in a field.'],
];

AE.crystal({
  id: 'fixes',
  name: "Master's Mend",
  sites: ['portal.ubreakifix.net'],
  run() {
    const on = AE.settings.fixes || {};
    const FIXES = {
      logoLink() {
        const ID = 'ae-logo-link';
        document.head.append(AE.h('style', null, `
          .components-header-logo { position: relative; }
          #${ID} { position: absolute; inset: 0; z-index: 1; }
        `));
        AE.every(1000, () => {
          const wrap = document.querySelector('.components-header-logo');
          if (!wrap || wrap.querySelector('#' + ID)) return;
          const btn = wrap.querySelector('button');
          const link = AE.h('a', { id: ID, href: '/', 'aria-label': 'Dashboard', title: 'Dashboard', tabindex: '-1' });
          link.addEventListener('click', (e) => {
            if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; // new tab / window: the browser's
            e.preventDefault();
            (btn && btn.isConnected ? btn : wrap.querySelector('button'))?.click(); // Portal's own route change
          });
          wrap.append(link);
        });
      },
      autoNotes() {
        const KEY = 'ae_hide_auto_notes', AUTO = 1; // Portal's NoteType.Auto
        const BAR = 'ae-notes-bar', STYLE = 'ae-notes-hide';
        document.head.append(AE.h('style', null, `
          #${BAR} { display:flex; align-items:center; justify-content:flex-end; gap:8px; margin:-4px 0 -6px; font-size:13px; color:var(--aui-on-surface-soft, #5d5e61); }
          #${BAR} label { display:inline-flex; align-items:center; gap:8px; padding:4px 10px 4px 6px; border-radius:10000rem; cursor:pointer; user-select:none;
            border:1px solid var(--aui-outline, #c6c6ca); background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e); font-weight:600; }
          #${BAR} label:hover { border-color:var(--aui-primary, #8223d2); }
          #${BAR} input { position:absolute; opacity:0; pointer-events:none; }
          #${BAR} .knob { position:relative; width:30px; height:18px; border-radius:10000rem; background:var(--aui-outline, #c6c6ca); transition:background .15s; flex:none; }
          #${BAR} .knob::after { content:''; position:absolute; top:2px; left:2px; width:14px; height:14px; border-radius:50%; background:#fff; transition:left .15s; }
          #${BAR} input:checked + .knob { background:var(--aui-primary, #8223d2); }
          #${BAR} input:checked + .knob::after { left:14px; }
          #${BAR} input:focus-visible + .knob { outline:2px solid var(--aui-primary, #8223d2); outline-offset:2px; }
          #${BAR} .n { font-weight:400; }
        `));
        let hide = !!GM_getValue(KEY, false);
        const style = AE.h('style', { id: STYLE });
        document.head.append(style);

        function autoIds() {
          const r = AE.portal('select', { slice: 'notes', key: 'notes', pick: ['noteId', 'noteType'] });
          return r && Array.isArray(r.value) ? r.value.filter((n) => Number(n.noteType) === AUTO || /^auto$/i.test(n.noteType)).map((n) => String(n.noteId)) : null;
        }
        function paint() {
          const tab = document.querySelector('[data-testid="notes-tab"]');
          if (!tab) { if (style.textContent) style.textContent = ''; return; }
          const cards = [...tab.querySelectorAll('[id^="note-"]')].filter((c) => /^note-\d+$/.test(c.id));
          const ids = autoIds();
          const shownAuto = ids ? cards.filter((c) => ids.includes(c.id.slice(5))) : [];
          const css = hide && shownAuto.length ? shownAuto.map((c) => '#' + CSS.escape(c.id)).join(',') + ' { display:none !important; }' : '';
          if (style.textContent !== css) style.textContent = css;

          let bar = document.getElementById(BAR);
          const list = cards[0] && cards[0].parentElement;
          if (!list) { bar?.remove(); return; }
          if (!bar || bar.nextElementSibling !== list) {
            bar?.remove();
            const input = AE.h('input', { type: 'checkbox', checked: hide, onchange: (e) => { hide = e.target.checked; GM_setValue(KEY, hide); AE.track(hide ? 'fixes:hideAutoNotes' : 'fixes:showAutoNotes'); paint(); } });
            bar = AE.h('div', { id: BAR },
              AE.h('span', { class: 'n' }),
              AE.h('label', { title: 'Hide the automatic notes (status changes, check-in logs…). Nothing is deleted; flip it back any time.' },
                input, AE.h('span', { class: 'knob' }), 'Hide auto notes'));
            list.before(bar); // Portal's list is a flex column; we sit just above it
          }
          bar.querySelector('input').checked = hide;
          bar.querySelector('.n').textContent = ids === null ? "Can't tell note types apart here"
            : hide ? (shownAuto.length ? shownAuto.length + ' auto note' + (shownAuto.length === 1 ? '' : 's') + ' hidden' : 'No auto notes')
            : shownAuto.length + ' auto note' + (shownAuto.length === 1 ? '' : 's');
        }
        let queued = false;
        new MutationObserver(() => { if (!queued) { queued = true; setTimeout(() => { queued = false; try { paint(); } catch (e) { AE.noteError('autoNotes', e); } }, 150); } })
          .observe(document.body, { childList: true, subtree: true });
        paint();
      },
      woSort() {
        // Header text → Portal's column id (repair.js WA), and whether the server sorts it.
        const COLS = {
          'WO #': ['woId', 1], 'Created': ['createdDate', 1], 'Customer': ['customerName', 0], 'Device/Issue': ['deviceCatalogName', 0],
          'Program': ['woProgram', 1], 'Next update': ['nextUpdate', 1], 'Location': ['location', 0], 'Status': ['woStatus', 1],
          'Closed': ['closed', 1], 'Cancelled': ['cancelled', 1], 'Created By': ['createdBy', 0], 'Cancelled By': ['cancelledBy', 0],
          'Last update': ['lastUpdate', 1], 'Service Outcome': ['serviceOutcome', 0], 'Completed': ['completed', 0], 'Total': ['workorderTotal', 1],
        };
        const TEXT_FIRST_ASC = ['customerName', 'deviceCatalogName', 'woProgram', 'location', 'woStatus', 'createdBy', 'cancelledBy', 'serviceOutcome'];
        const BTN = 'ae-wosort';
        document.head.append(AE.h('style', null, `
          .${BTN} { display:inline-flex; flex-direction:column; vertical-align:middle; margin-left:4px; padding:0 2px; border:0; background:none; cursor:pointer;
            color:var(--aui-on-surface-soft, #5d5e61); line-height:0; border-radius:4px; }
          .${BTN}:hover { background:var(--aui-neutral-soft, #f1f0f4); color:var(--aui-on-surface, #1a1c1e); }
          .${BTN} svg { width:10px; height:7px; opacity:.45; }
          .${BTN}[data-dir="ASC"] .up, .${BTN}[data-dir="DESC"] .down { opacity:1; color:var(--aui-primary, #8223d2); }
          .${BTN}.page { border-bottom:1px dashed currentColor; border-radius:0; }
        `));
        const ARROWS = '<svg class="up" viewBox="0 0 10 7"><path fill="currentColor" d="M5 0l5 7H0z"/></svg><svg class="down" viewBox="0 0 10 7"><path fill="currentColor" d="M5 7L0 0h10z"/></svg>';

        const getSel = () => { const r = AE.portal('select', { slice: 'repair', key: 'workorderlistFilterSelection' }); return r && r.found ? r.value : null; };
        function current(sel) {
          const pf = sel && Object.keys(sel).find((k) => sel[k] && sel[k].selected);
          if (!pf) return { pf: null, order: '' };
          const g = sel[pf], tab = g.activeTab, t = tab && g.tabs && g.tabs[tab];
          return { pf, g, tab, order: (t && t.order !== undefined ? t.order : g.order) || '' };
        }
        function serverSort(id, dir) {
          const sel = getSel(), c = current(sel);
          if (!c.pf) return AE.toast('Sort', "Couldn't find the list's settings in Portal.", 'err');
          const order = id + ',' + dir;
          const entry = Object.assign({}, c.g, { order, page: 1 });
          if (c.tab) entry.tabs = Object.assign({}, c.g.tabs, { [c.tab]: Object.assign({}, (c.g.tabs || {})[c.tab], { order }) });
          const r = AE.portal('dispatch', { slice: 'repair', action: { type: 'repair/setWorkorderlistFilterSelection', payload: { [c.pf]: entry } } });
          if (!r.stores) AE.toast('Sort', "Couldn't reach Portal's list.", 'err');
          pageSort = null;
          AE.track('fixes:woSort');
        }

        // Page-only sort: reorder the rows on screen (kept through re-renders).
        let pageSort = null, moved = false; // { header, dir }; moved: rows aren't in React's order any more
        const woOf = (row) => { const a = row.querySelector('a[href*="/repair/workorder/"]'); const m = a && a.getAttribute('href').match(/workorder\/(\d+)/); return m ? Number(m[1]) : null; };
        // Portal's own order for the rows on screen (the list query's data), as WO id → position.
        function portalOrder() {
          const r = AE.portal('query', { endpoint: 'getAllWorkOrders', list: 'workOrders', field: 'workorderId' });
          return r && r.items ? new Map(r.items.map((id, i) => [Number(id), i])) : null;
        }
        const cellsOf = (row) => [...row.children].filter((c) => /^(TD|TH)$/.test(c.tagName) || /^(cell|gridcell)$/.test(c.getAttribute('role') || ''));
        const keyOf = (text) => { const t = text.trim(); const d = Date.parse(t.replace(/\s+/g, ' ')); return { t, d: /\d/.test(t) && !isNaN(d) ? d : null }; };
        function applyPageSort(table, headers) {
          const body = table.tBodies ? table.tBodies[0] : null;
          if (!body || (!pageSort && !moved)) return;
          const rows = [...body.rows];
          const base = portalOrder();
          const pos = (row) => { const id = woOf(row); return base && base.has(id) ? base.get(id) : rows.indexOf(row); };
          const i = pageSort ? headers.findIndex((h) => h.label === pageSort.header) : -1;
          const sorted = rows.slice().sort((a, b) => {
            if (i >= 0) {
              const x = keyOf((cellsOf(a)[i] || {}).innerText || ''), y = keyOf((cellsOf(b)[i] || {}).innerText || '');
              const r = x.d !== null && y.d !== null ? x.d - y.d : x.t.localeCompare(y.t, undefined, { numeric: true, sensitivity: 'base' });
              if (r) return pageSort.dir === 'ASC' ? r : -r;
            }
            return pos(a) - pos(b); // ties, and no page sort: Portal's order
          });
          if (!pageSort && base) moved = false; // back in Portal's order
          if (sorted.every((r, k) => r === rows[k])) return;
          body.append(...sorted);
          if (pageSort) moved = true;
        }

        function paint() {
          if (!/^\/repair\/workorders\/?$/.test(location.pathname)) { pageSort = null; moved = false; return; }
          const link = document.querySelector('tbody a[href*="/repair/workorder/"], tbody tr');
          const table = link && link.closest('table');
          const head = table && table.tHead && table.tHead.rows[0];
          if (!head) return;
          const order = current(getSel()).order;
          const headers = [...head.cells].map((th) => ({ th, label: (th.innerText || '').trim().split('\n')[0].trim() }));
          for (const { th, label } of headers) {
            const col = COLS[label];
            if (!col || th.querySelector('[data-testid^="sort-icon"]')) continue; // Portal's own ▲▼
            const [id, server] = col;
            let b = th.querySelector('.' + BTN);
            if (!b) {
              b = AE.h('button', { type: 'button', class: BTN + (server ? '' : ' page'), html: ARROWS,
                title: server ? 'Sort by ' + label : 'Sort this page by ' + label + " (Portal can't sort this column across pages)" });
              b.addEventListener('click', (e) => {
                e.preventDefault(); e.stopPropagation();
                const was = b.dataset.dir, first = TEXT_FIRST_ASC.includes(id) ? 'ASC' : 'DESC';
                const dir = was ? (was === 'ASC' ? 'DESC' : 'ASC') : first;
                if (server) serverSort(id, dir);
                else { pageSort = { header: label, dir }; moved = true; AE.track('fixes:woSortPage'); paint(); }
              });
              (th.querySelector('span, div') || th).append(b);
            }
            const dir = server ? (order.split(',')[0] === id ? order.split(',')[1] : '') : (pageSort && pageSort.header === label ? pageSort.dir : '');
            if ((b.dataset.dir || '') !== (dir || '')) { if (dir) b.dataset.dir = dir; else delete b.dataset.dir; }
          }
          applyPageSort(table, headers);
        }
        let queued = false;
        new MutationObserver(() => { if (!queued) { queued = true; setTimeout(() => { queued = false; try { paint(); } catch (e) { AE.noteError('woSort', e); } }, 120); } })
          .observe(document.body, { childList: true, subtree: true });
        paint();
      },
      scanNav() {
        const GAP_MS = 60; // longest pause between a scanner's keys (Portal uses 40)
        const PORTAL_EVENT = 'scanDetected', RESEND_EVENT = 'aethernet:scan';
        // Portal's scan event has to come from the page itself (the scan is in
        // its `detail`), so a tiny page script sends it for us. Plain string: see Glamour.
        const hook = () => {
          if (document.getElementById('ae-scan-hook')) return;
          const s = document.createElement('script');
          s.id = 'ae-scan-hook';
          s.textContent = '(function (a, p) { document.addEventListener(a, function (e) { dispatchEvent(new CustomEvent(p, { detail: { scan: String(e.detail) } })); }); })(' +
            JSON.stringify(RESEND_EVENT) + ',' + JSON.stringify(PORTAL_EVENT) + ');';
          (document.head || document.documentElement).append(s);
        };
        let portalSaw = 0;
        window.addEventListener(PORTAL_EVENT, () => { portalSaw = performance.now(); });

        const WO_RE = /^(?:WO)?(\d{9})$/i, ITEM_RE = /^([A-Za-z0-9]{2,})-(\d{10,})$/;
        const path = () => location.pathname;
        const busyTyping = () => {
          const a = document.activeElement;
          return !!a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
        };
        const dialogOpen = () => [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
          .some((d) => d.offsetParent !== null && !d.closest('.sg')); // Aethernet's own cards don't count
        const scanPage = () => /^\/(boh|check-in|check-out)(\/|$)/.test(path());
        const itemPage = () => path() === '/' || /^\/repair\/workorders\/?$/.test(path()) || /^\/customer(s)?(\/|$)/.test(path()) ||
          /^\/boh\/inventory\/store-products(\/|$)/.test(path());
        // Same-tab route change without a reload: Portal's router (and single-spa) follow popstate.
        const go = (url) => { history.pushState(null, '', url); dispatchEvent(new PopStateEvent('popstate', { state: null })); };

        async function act(scan, why, devTools) {
          const wo = scan.match(WO_RE), item = scan.match(ITEM_RE);
          if (!wo && !item) return 'not a WO or item label';
          if (busyTyping() && !devTools) return 'typing in a field';
          if (dialogOpen()) return 'a dialog is open';
          if (wo) {
            if (scanPage()) return 'scans are data entry on this page';
            const id = wo[1];
            if (path().startsWith('/repair/workorder/' + id)) return 'already on WO ' + id;
            try { await AE.api('GET', '/api/workorder/' + id); } catch (e) {
              AE.toast('Scan', "Couldn't open WO " + id + ': ' + (/HTTP 404/.test(e.message) ? 'no such work order.' : e.message), 'err', 6000);
              return 'WO lookup failed';
            }
            go('/repair/workorder/' + id);
            AE.track('fixes:scanWo');
            return 'opened WO ' + id + (why ? ' (' + why + ')' : '');
          }
          if (!itemPage()) return 'item scans belong to this page';
          go('/boh/inventory/store-products/' + encodeURIComponent(item[1]));
          AE.track('fixes:scanItem');
          return 'opened item ' + item[1];
        }

        // Scanner = keys arriving faster than any person types, ending in Enter.
        let buf = '', last = 0;
        window.addEventListener('keydown', (e) => {
          if (e.isComposing || /^(Shift|Control|Alt|Meta|CapsLock)$/.test(e.key)) return;
          const t = e.timeStamp, quick = t - last <= GAP_MS;
          last = t;
          if (e.key === 'Enter') {
            const scan = quick ? buf : '';
            buf = '';
            if (scan.length < 4) return;
            const before = portalSaw;
            setTimeout(() => {  // Portal handles the Enter (keypress) after this keydown
              if (portalSaw === before) { hook(); document.dispatchEvent(new CustomEvent(RESEND_EVENT, { detail: scan })); }
              act(scan).then((r) => console.debug('[' + AE_NAME + '] scan "' + scan + '": ' + r));
            }, 60);
            return;
          }
          if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) { buf = ''; return; }
          buf = quick ? buf + e.key : e.key;
        }, true);
        AE.hooks.scan = (text) => act(String(text).trim(), 'dev tools', true); // dev tools: act on a pretend scan
      },
    };
    for (const [id] of AE.fixesInfo) {
      if (on[id] === false || !FIXES[id]) continue;
      try { FIXES[id](); } catch (e) { AE.noteError("Master's Mend: " + id, e); console.error('[' + AE_NAME + "] Master's Mend: " + id + ' failed', e); }
    }
  },
});
