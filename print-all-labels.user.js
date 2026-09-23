// ==UserScript==
// @name         UBIF Portal — Print All Labels (Purchase Order Receiving)
// @namespace    garrett.ubif
// @version      1.1
// @description  Adds a "Print all labels" button on the PO receiving page that clicks every serial row's per-item "Print Label" for you, paced so the DYMO spooler keeps up.
// @match        https://portal.ubreakifix.net/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
  What it automates
  -----------------
  On a PO receiving page, each line item can be expanded to a list of individual
  serial rows. Each serial row has a "⋮" action menu whose only option is
  "Print Label" — which fires the portal's DYMO Connect label print for that one
  serial. With 100 units under a line that's 100 menu-open + click cycles by hand.

  This script does exactly that sequence for every serial row, with a delay
  between each so a DYMO LabelWriter doesn't get flooded. It changes nothing on
  the server — "Print Label" is print-only, it does not receive or modify stock.

  Tuning
  ------
  DELAY_MS  – gap between labels. 900ms is comfortable for a LabelWriter 450/550.
              Raise it if labels come out missing; lower it to go faster.

  If the portal ever renames the button hooks this script looks for
  (data-aui="action" on the menu trigger, data-testid="option-printLabel" on the
  menu item), update SEL_MENU_BTN / SEL_PRINT_OPT below.

  @match covers the whole portal because it's a single-page app: going from
  the PO list to Receive changes the URL without a page load, and
  Tampermonkey only injects on a load — a Receive-only @match meant no
  button until a manual refresh. RECEIVE_PATH_RE gates it instead.
*/

(function () {
  'use strict';

  const DELAY_MS      = 900;
  const SEL_MENU_BTN  = 'button[data-aui="action"]';
  const SEL_PRINT_OPT = 'button[data-testid="option-printLabel"]';
  const SERIAL_RE     = /^\s*\d{5,}[-–—]\d{5,}\s*$/;
  const RECEIVE_PATH_RE = /^\/boh\/inventory\/purchase-orders\/[^/]+\/receive\/?$/;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => !!el && el.getClientRects().length > 0;

  // ---- find serial rows, expanding any collapsed line items first ------------
  const serialCount = () =>
    [...document.querySelectorAll('tr')].filter((tr) => SERIAL_RE.test(tr.textContent || '')).length;

  async function expandLineItems() {
    const targets = [...document.querySelectorAll('tr')]
      .filter((tr) => {
        const t = (tr.textContent || '').trim();
        return (
          !SERIAL_RE.test(t) &&
          /\$\d/.test(t) &&                        // a product row shows a price
          tr.firstElementChild &&
          tr.firstElementChild.querySelector('svg') // …and an expand chevron
        );
      })
      .map((tr) => {
        const td = tr.firstElementChild;
        const svg = td.querySelector('svg');
        // the click has to land on the chevron's wrapper, not the <td>
        return (svg && svg.parentElement) || svg || td;
      });

    for (const el of targets) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = serialCount();
        el.click();
        await sleep(450);
        const after = serialCount();
        if (after > before) break;                 // expanded — done
        if (after < before) { el.click(); await sleep(350); break; } // was open — re-open
        // no change — try again
      }
    }
  }

  function serialRows() {
    return [...document.querySelectorAll('tr')].filter(
      (tr) => SERIAL_RE.test(tr.textContent || '') && tr.querySelector(SEL_MENU_BTN)
    );
  }

  function serialOf(tr) {
    return (tr.textContent || '').trim();
  }

  // ---- print one row --------------------------------------------------------
  const printOptionShowing = () => [...document.querySelectorAll(SEL_PRINT_OPT)].some(visible);

  // A menu left open by the previous row would otherwise be the "first
  // visible Print Label" this row finds — printing that row twice and this
  // one never, while still counting as done. Close any open menu first.
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
    if (!menuBtn) return false;
    if (!(await closeOpenMenu())) return false;
    menuBtn.scrollIntoView({ block: 'center' });
    await sleep(80);
    menuBtn.click();

    let opt = null;
    for (let i = 0; i < 15 && !opt; i++) {
      await sleep(40);
      opt = [...document.querySelectorAll(SEL_PRINT_OPT)].find(visible);
    }
    if (!opt) return false;
    opt.click();               // fires the DYMO print for this serial
    return true;
  }

  // ---- run over a set of rows with a progress panel ------------------------
  async function run(rows, ui) {
    ui.state.total = rows.length;
    ui.state.done = 0;
    ui.state.missed = [];
    for (let i = 0; i < rows.length; i++) {
      if (ui.state.stop) break;
      const ok = await printRow(rows[i]);
      if (ok) ui.state.done++;
      else ui.state.missed.push(serialOf(rows[i]));
      ui.tick();
      await sleep(DELAY_MS);
    }
    ui.state.running = false;
    ui.finish();
  }

  // ---- UI ------------------------------------------------------------------
  function makePanel() {
    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;z-index:2147483647;right:16px;bottom:16px;background:#111;color:#fff;' +
      'font:13px/1.45 system-ui,sans-serif;padding:14px 16px;border-radius:10px;' +
      'box-shadow:0 8px 30px rgba(0,0,0,.4);min-width:250px';
    box.innerHTML =
      '<div style="font-weight:600;margin-bottom:8px">Print all labels</div>' +
      '<div id="pa-msg" style="margin-bottom:10px"></div>' +
      '<div id="pa-actions"></div>';
    document.body.appendChild(box);

    const msg = box.querySelector('#pa-msg');
    const actions = box.querySelector('#pa-actions');
    const btn = (label, bg) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText =
        `margin-right:8px;background:${bg};color:#fff;border:0;border-radius:6px;` +
        'padding:7px 12px;cursor:pointer;font:inherit';
      return b;
    };

    const state = { running: false, stop: false, total: 0, done: 0, missed: [] };
    const ui = {
      state,
      box,
      say: (h) => { msg.innerHTML = h; },
      setActions: (...els) => { actions.replaceChildren(...els); },
      tick: () => {
        msg.textContent =
          `${state.done} / ${state.total} sent` +
          (state.missed.length ? `  (${state.missed.length} missed)` : '');
      },
      finish: () => {
        const tail = state.missed.length ? ` — ${state.missed.length} missed` : '';
        msg.textContent = (state.stop ? 'Stopped: ' : 'Done: ') + `${state.done} / ${state.total}${tail}`;
        const close = btn('Close', '#333');
        close.onclick = () => box.remove();
        if (state.missed.length) {
          const retry = btn('Retry missed', '#b7791f');
          retry.onclick = () => {
            const want = new Set(state.missed);
            state.stop = false;
            const rows = serialRows().filter((tr) => want.has(serialOf(tr)));
            startRun(rows, ui);
          };
          ui.setActions(retry, close);
        } else {
          ui.setActions(close);
        }
      },
    };
    return ui;
  }

  function startRun(rows, ui) {
    if (ui.state.running) return;
    ui.state.running = true;
    ui.state.stop = false;
    const stop = document.createElement('button');
    stop.textContent = 'Stop';
    stop.style.cssText =
      'background:#c0392b;color:#fff;border:0;border-radius:6px;padding:7px 12px;cursor:pointer;font:inherit';
    stop.onclick = () => { ui.state.stop = true; stop.textContent = 'stopping…'; };
    ui.setActions(stop);
    run(rows, ui);
  }

  // One panel, one run at a time — a second click (or a second Start) used
  // to open another panel and print every label twice.
  let activeUi = null;

  async function onClickPrintAll() {
    if (activeUi && activeUi.box.isConnected) {
      activeUi.box.animate([{ outline: '3px solid #f59e0b' }, { outline: 'none' }], 800);
      return;
    }
    const ui = makePanel();
    activeUi = ui;
    ui.say('Expanding line items…');
    await expandLineItems();
    await sleep(300);
    const rows = serialRows();
    if (!rows.length) {
      ui.say('No serial rows found on this page.');
      const close = document.createElement('button');
      close.textContent = 'Close';
      close.style.cssText = 'background:#333;color:#fff;border:0;border-radius:6px;padding:7px 12px;cursor:pointer;font:inherit';
      close.onclick = () => ui.box.remove();
      ui.setActions(close);
      return;
    }
    ui.say(
      `Ready to print <b>${rows.length}</b> labels, one every ${DELAY_MS} ms ` +
      `(~${Math.ceil((rows.length * (DELAY_MS + 150)) / 1000)} s total).<br>` +
      'Make sure the DYMO label printer is on and loaded.'
    );
    const start = document.createElement('button');
    start.textContent = `Print ${rows.length}`;
    start.style.cssText = 'margin-right:8px;background:#2e7d32;color:#fff;border:0;border-radius:6px;padding:7px 12px;cursor:pointer;font:inherit';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'background:#333;color:#fff;border:0;border-radius:6px;padding:7px 12px;cursor:pointer;font:inherit';
    cancel.onclick = () => ui.box.remove();
    start.onclick = () => { start.disabled = true; startRun(serialRows(), ui); };
    ui.setActions(start, cancel);
  }

  // ---- inject the button next to "Generate Labels" ------------------------
  function injectButton() {
    const existing = document.getElementById('pa-print-all-btn');
    if (!RECEIVE_PATH_RE.test(location.pathname)) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    const gen = [...document.querySelectorAll('button')].find((b) => /generate labels/i.test(b.textContent || ''));
    if (!gen || !gen.parentElement) return;

    const b = document.createElement('button');
    b.id = 'pa-print-all-btn';
    b.type = 'button';
    b.textContent = '⎙ Print all labels';
    b.style.cssText =
      'margin-right:8px;background:#6d28d9;color:#fff;border:0;border-radius:8px;' +
      'padding:8px 14px;cursor:pointer;font:600 13px system-ui,sans-serif';
    b.onclick = onClickPrintAll;
    gen.parentElement.insertBefore(b, gen);
  }

  // The portal is a SPA; keep trying to (re)inject. Coalesced to at most
  // one check per 250ms — a 100-label run mutates the DOM constantly, and
  // re-scanning every button on each mutation was wasted work.
  let injectQueued = false;
  const mo = new MutationObserver(() => {
    if (injectQueued) return;
    injectQueued = true;
    setTimeout(() => { injectQueued = false; injectButton(); }, 250);
  });
  mo.observe(document.body, { childList: true, subtree: true });
  injectButton();
})();
