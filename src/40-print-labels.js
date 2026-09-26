/*
  Print all labels — on a PO Receive page, a "Print all labels" button next
  to "Generate Labels" that opens each serial row's ⋮ → Print Label in turn,
  paced (settings → delay) so a DYMO LabelWriter keeps up. Print-only: it
  never receives or changes stock.

  If the portal renames its hooks, update SEL_MENU_BTN / SEL_PRINT_OPT.
*/
AE.tool({
  id: 'printLabels',
  name: 'Print all labels',
  sites: ['portal.ubreakifix.net'],
  run() {
    const { h, icon, sleep } = AE;
    const DELAY_MS = AE.settings.printLabels.delayMs;
    const SEL_MENU_BTN = 'button[data-aui="action"]';
    const SEL_PRINT_OPT = 'button[data-testid="option-printLabel"]';
    const SERIAL_RE = /^\s*\d{5,}[-–—]\d{5,}\s*$/;
    const RECEIVE_PATH_RE = /^\/boh\/inventory\/purchase-orders\/[^/]+\/receive\/?$/;
    const visible = (el) => !!el && el.getClientRects().length > 0;

    // ---- find serial rows, expanding collapsed line items first ----
    const serialCount = () => [...document.querySelectorAll('tr')].filter((tr) => SERIAL_RE.test(tr.textContent || '')).length;
    async function expandLineItems() {
      const targets = [...document.querySelectorAll('tr')]
        .filter((tr) => {
          const t = (tr.textContent || '').trim();
          // a product row shows a price and has an expand chevron
          return !SERIAL_RE.test(t) && /\$\d/.test(t) && tr.firstElementChild && tr.firstElementChild.querySelector('svg');
        })
        .map((tr) => { const svg = tr.firstElementChild.querySelector('svg'); return (svg && svg.parentElement) || svg || tr.firstElementChild; });
      for (const el of targets) {
        for (let attempt = 0; attempt < 3; attempt++) {
          const before = serialCount();
          el.click();
          await sleep(450);
          const after = serialCount();
          if (after > before) break;                                   // expanded
          if (after < before) { el.click(); await sleep(350); break; } // was open — re-open
        }
      }
    }
    const serialRows = () => [...document.querySelectorAll('tr')].filter((tr) => SERIAL_RE.test(tr.textContent || '') && tr.querySelector(SEL_MENU_BTN));
    const serialOf = (tr) => (tr.textContent || '').trim();

    // ---- print one row ----
    const printOptionShowing = () => [...document.querySelectorAll(SEL_PRINT_OPT)].some(visible);
    // A menu left open by the previous row would be the "first visible Print
    // Label" this row finds — printing that row twice. Close it first.
    async function closeOpenMenu() {
      for (let i = 0; i < 10 && printOptionShowing(); i++) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        await sleep(60);
      }
      return !printOptionShowing();
    }
    async function printRow(tr) {
      const menuBtn = tr.querySelector(SEL_MENU_BTN);
      if (!menuBtn || !(await closeOpenMenu())) return false;
      menuBtn.scrollIntoView({ block: 'center' });
      await sleep(80);
      menuBtn.click();
      let opt = null;
      for (let i = 0; i < 15 && !opt; i++) { await sleep(40); opt = [...document.querySelectorAll(SEL_PRINT_OPT)].find(visible); }
      if (!opt) return false;
      opt.click(); // fires the DYMO print for this serial
      return true;
    }

    // ---- run with a progress panel (one at a time) ----
    let active = null;
    const btn = (label, cls, onclick) => h('button', { type: 'button', class: 'sg-btn sg-lg ' + (cls || ''), onclick }, label);

    async function runRows(rows, ui) {
      ui.running = true; ui.stop = false;
      const total = rows.length;
      let done = 0;
      const missed = [];
      const count = h('div', null);
      const bar = h('div', { class: 'sg-bar' }, h('i'));
      ui.panel.body.replaceChildren(count, bar);
      const paint = () => {
        count.textContent = done + ' / ' + total + ' sent' + (missed.length ? ' · ' + missed.length + ' missed' : '');
        bar.firstChild.style.width = Math.round(((done + missed.length) / total) * 100) + '%';
      };
      paint();
      const stop = btn('■ Stop', 'sg-danger', () => { ui.stop = true; stop.disabled = true; stop.textContent = 'Stopping…'; });
      ui.panel.actions(stop);
      for (const tr of rows) {
        if (ui.stop) break;
        if (await printRow(tr)) done++; else missed.push(serialOf(tr));
        paint();
        await sleep(DELAY_MS);
      }
      ui.running = false;
      const summary = done + ' / ' + total + ' labels sent' + (missed.length ? ' — ' + missed.length + ' missed' : '') + '.';
      ui.panel.finish(ui.stop ? 'stop' : missed.length ? 'err' : 'ok', (ui.stop ? 'Stopped: ' : '') + summary);
      const close = btn('Close', '', () => { ui.panel.el.remove(); active = null; });
      if (missed.length) {
        ui.panel.actions(btn('Retry missed', 'sg-primary', () => {
          const want = new Set(missed);
          const retry = serialRows().filter((tr) => want.has(serialOf(tr)));
          active = newUi();
          runRows(retry, active);
        }), close);
      } else ui.panel.actions(close);
    }

    function newUi() { return { panel: AE.progressPanel('Print all labels', { clock: false }), running: false, stop: false }; }

    async function onClickPrintAll() {
      if (active && active.panel.el.isConnected) { active.panel.flash(); return; }
      const ui = active = newUi();
      ui.panel.body.textContent = 'Expanding line items…';
      await expandLineItems();
      await sleep(300);
      const rows = serialRows();
      if (!rows.length) {
        ui.panel.finish('err', 'No serial rows found on this page.');
        ui.panel.body.textContent = '';
        ui.panel.actions(btn('Close', '', () => { ui.panel.el.remove(); active = null; }));
        return;
      }
      ui.panel.body.innerHTML = 'Ready to print <b>' + rows.length + '</b> labels, one every ' + DELAY_MS + ' ms (~' +
        Math.ceil((rows.length * (DELAY_MS + 150)) / 1000) + ' s).<div class="sg-soft" style="margin:6px 0 12px">Make sure the DYMO label printer is on and loaded.</div>';
      ui.panel.actions(
        btn('Cancel', '', () => { ui.panel.el.remove(); active = null; }),
        btn('Print ' + rows.length, 'sg-primary', () => runRows(serialRows(), ui)));
    }

    // ---- button next to "Generate Labels", styled like the portal's ----
    function injectButton() {
      const existing = document.getElementById('sg-print-all-btn');
      if (!RECEIVE_PATH_RE.test(location.pathname)) { existing?.remove(); return; }
      if (existing) return;
      const gen = [...document.querySelectorAll('button')].find((b) => /generate labels/i.test(b.textContent || ''));
      if (!gen || !gen.parentElement) return;
      const b = h('button', { id: 'sg-print-all-btn', type: 'button', class: 'sg sg-btn sg-primary', style: 'margin-right:8px;height:' + (gen.offsetHeight || 32) + 'px', onclick: onClickPrintAll });
      b.innerHTML = icon('printer', 16) + '<span>Print all labels</span>';
      gen.parentElement.insertBefore(b, gen);
    }
    // Coalesced to one check per 250ms — a label run mutates the DOM constantly.
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      setTimeout(() => { queued = false; injectButton(); }, 250);
    }).observe(document.body, { childList: true, subtree: true });
    injectButton();
  },
});
