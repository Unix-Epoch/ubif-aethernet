/*
  UBIF Portal — "Print all labels" BOOKMARKLET (readable source)
  -------------------------------------------------------------
  Same engine as print-all-labels.user.js, but as a one-click bookmarklet
  instead of a userscript button. Use this if you don't want to install
  Tampermonkey.

  SETUP (once):
    1. Chrome → bookmark this page (⌘D), or right-click the bookmarks bar → Add page.
    2. Name it:  Print all labels
    3. URL: paste the ONE-LINER from print-all-labels.bookmarklet.txt
       (it starts with  javascript:  — Chrome keeps that prefix).

  USE:
    1. Open the Purchase Order → Receive page.
    2. Click the "Print all labels" bookmark.
    3. A panel appears bottom-right: it shows the count, you click "Print N",
       it works through every serial row. "Stop" halts it; "Retry missed"
       re-runs only the ones that didn't fire.

  Make sure the DYMO label printer is on and loaded before you start.
  Tune the speed with the DELAY_MS value (milliseconds between labels).
*/
(function () {
  var DELAY_MS = 900;
  var SEL_MENU = 'button[data-aui="action"]';
  var SEL_OPT = 'button[data-testid="option-printLabel"]';
  var SER = /^\s*\d{5,}[-–—]\d{5,}\s*$/;
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var vis = function (el) { return !!el && el.getClientRects().length > 0; };
  var $$ = function (s) { return [].slice.call(document.querySelectorAll(s)); };

  var existingBox = document.getElementById('ubif-pa-box');
  if (existingBox) { existingBox.animate([{ outline: '3px solid #f59e0b' }, { outline: 'none' }], 800); return; }

  function serialCount() { return $$('tr').filter(function (t) { return SER.test(t.textContent || ''); }).length; }
  function serialRows() {
    return $$('tr').filter(function (t) {
      return SER.test(t.textContent || '') && t.querySelector(SEL_MENU);
    });
  }
  function serialOf(tr) { return (tr.textContent || '').trim(); }

  async function expand() {
    var targets = $$('tr').filter(function (tr) {
      var x = (tr.textContent || '').trim();
      return !SER.test(x) && /\$\d/.test(x) && tr.firstElementChild && tr.firstElementChild.querySelector('svg');
    }).map(function (tr) {
      var td = tr.firstElementChild, svg = td.querySelector('svg');
      return (svg && svg.parentElement) || svg || td;
    });
    for (var i = 0; i < targets.length; i++) {
      for (var a = 0; a < 3; a++) {
        var b = serialCount();
        targets[i].click();
        await sleep(450);
        var c = serialCount();
        if (c > b) break;
        if (c < b) { targets[i].click(); await sleep(350); break; }
      }
    }
  }

  function optShowing() { return $$(SEL_OPT).some(vis); }
  async function closeOpenMenu() {
    for (var i = 0; i < 10 && optShowing(); i++) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await sleep(60);
    }
    return !optShowing();
  }

  async function printRow(tr) {
    var m = tr.querySelector(SEL_MENU);
    if (!m) return false;
    if (!(await closeOpenMenu())) return false;
    m.scrollIntoView({ block: 'center' });
    await sleep(80);
    m.click();
    var opt = null;
    for (var i = 0; i < 15 && !opt; i++) { await sleep(40); opt = $$(SEL_OPT).find(vis); }
    if (!opt) return false;
    opt.click();
    return true;
  }

  var box = document.createElement('div');
  box.id = 'ubif-pa-box';
  box.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;background:#111;color:#fff;font:13px/1.45 system-ui,sans-serif;padding:14px 16px;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.4);min-width:250px';
  box.innerHTML = '<div style="font-weight:600;margin-bottom:8px">Print all labels</div><div id="pam" style="margin-bottom:10px">Expanding…</div><div id="paa"></div>';
  document.body.appendChild(box);
  var msg = box.querySelector('#pam'), act = box.querySelector('#paa');
  var mkBtn = function (label, bg) {
    var b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'margin-right:8px;background:' + bg + ';color:#fff;border:0;border-radius:6px;padding:7px 12px;cursor:pointer;font:inherit';
    return b;
  };
  var state = { running: false, stop: false, total: 0, done: 0, missed: [] };

  async function runOver(rows) {
    if (state.running) return;
    state.running = true; state.stop = false; state.total = rows.length; state.done = 0; state.missed = [];
    var stop = mkBtn('Stop', '#c0392b');
    stop.onclick = function () { state.stop = true; stop.textContent = 'stopping…'; };
    act.replaceChildren(stop);
    for (var i = 0; i < rows.length; i++) {
      if (state.stop) break;
      var ok = await printRow(rows[i]);
      if (ok) state.done++; else state.missed.push(serialOf(rows[i]));
      msg.textContent = state.done + ' / ' + state.total + ' sent' + (state.missed.length ? ' (' + state.missed.length + ' missed)' : '');
      await sleep(DELAY_MS);
    }
    state.running = false;
    msg.textContent = (state.stop ? 'Stopped: ' : 'Done: ') + state.done + ' / ' + state.total + (state.missed.length ? ' — ' + state.missed.length + ' missed' : '');
    var close = mkBtn('Close', '#333'); close.onclick = function () { box.remove(); };
    if (state.missed.length) {
      var retry = mkBtn('Retry missed', '#b7791f');
      retry.onclick = function () {
        var want = new Set(state.missed);
        runOver(serialRows().filter(function (tr) { return want.has(serialOf(tr)); }));
      };
      act.replaceChildren(retry, close);
    } else {
      act.replaceChildren(close);
    }
  }

  (async function () {
    await expand();
    await sleep(300);
    var rows = serialRows();
    if (!rows.length) { msg.textContent = 'No serial rows found on this page.'; var c = mkBtn('Close', '#333'); c.onclick = function () { box.remove(); }; act.replaceChildren(c); return; }
    msg.innerHTML = 'Ready to print <b>' + rows.length + '</b> labels, one every ' + DELAY_MS + ' ms (~' + Math.ceil((rows.length * (DELAY_MS + 150)) / 1000) + ' s total).<br>Make sure the DYMO printer is on and loaded.';
    var start = mkBtn('Print ' + rows.length, '#2e7d32');
    var cancel = mkBtn('Cancel', '#333');
    cancel.onclick = function () { box.remove(); };
    start.onclick = function () { start.disabled = true; runOver(serialRows()); };
    act.replaceChildren(start, cancel);
  })();
})();
