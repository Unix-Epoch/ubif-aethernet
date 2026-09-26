// ==UserScript==
// @name         Select All - Buybacks
// @namespace    ubif.buyback.bulkadd
// @version      1.1.1
// @description  Adds "Apple devices (TLC)" and "Samsung/Google parts (UROC)" bulk-add buttons to the Add Buyback parts popout.
// @match        https://portal.ubreakifix.net/boh/inventory/buyback-order/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const TOOLBAR_ID = 'ubif-bulk-add-toolbar';

  // Safety limits — these are what stop a run from ever spinning forever.
  const SETTLE_MS    = 8000;            // max wait for a clicked row to leave the list
  const REFRESH_MS   = 8000;            // max wait for the list to repopulate after an add
  const GAP_MS       = 300;             // pause between adds
  const MAX_STALLS   = 3;               // consecutive no-effect clicks -> abort
  const MAX_TRIES    = 2;               // attempts allowed per individual row
  const MAX_RECOVER  = 2;               // tab-bounce recovery attempts per run
  const HARD_CAP     = 500;             // absolute click ceiling per run
  const WALL_MS      = 10 * 60 * 1000;  // absolute time ceiling per run

  const GROUPS = {
    apple: {
      label: 'Apple devices',
      hint: 'TLC',
      variant: 'filled',
      test: d => /asurion\s+reverse\s+logistics/i.test(d)
    },
    samsungGoogle: {
      label: 'Samsung/Google parts',
      hint: 'UROC',
      variant: 'outline',
      test: d => /\buroc\b/i.test(d)
    }
  };

  const state = { running: false, cancel: false, status: '' };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function waitUntil(fn, timeout) {
    return new Promise(resolve => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        let ok = false;
        try { ok = !!fn(); } catch (e) { ok = false; }
        if (ok) { clearInterval(iv); resolve(true); }
        else if (state.cancel || Date.now() - t0 > timeout) { clearInterval(iv); resolve(false); }
      }, 100);
    });
  }

  // ---------- page structure ----------

  // Some dialog libraries keep a closed popout mounted (hidden) in the DOM
  // instead of removing it, e.g. to animate the close or to reopen fast.
  // A hidden leftover from a *previous* buyback still matches the heading
  // text, so we can't just take the first match — we need the visible one.
  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (el.offsetParent === null && style.position !== 'fixed') return false;
    return true;
  }

  function getModal() {
    const heads = [...document.querySelectorAll('h1,h2,h3')]
      .filter(e => /^\s*add\s+buyback\s+parts\s*$/i.test(e.textContent || ''))
      .filter(isVisible);
    // If a stale hidden copy and the live one both match, the live one is
    // the most recently mounted, i.e. last in this list.
    const h = heads[heads.length - 1];
    if (!h) return null;
    let n = h;
    for (let i = 0; i < 12 && n; i++) {
      n = n.parentElement;
      if (n && n.querySelector('table')) return n;
    }
    return null;
  }

  function tabButtons(modal, re) {
    return [...modal.querySelectorAll('button,[role="tab"]')]
      .filter(b => re.test((b.innerText || '').trim()));
  }

  // The Damaged tab has identical column headers, so the active tab is the
  // only reliable way to tell the two lists apart.
  function buybacksTabActive(modal) {
    const tabs = tabButtons(modal, /^buybacks\s*\(\d+\)$/i);
    return tabs.length > 0 && tabs.some(b => b.getAttribute('aria-selected') === 'true');
  }

  function getTable(modal) {
    if (!modal) return null;
    return [...modal.querySelectorAll('table')].find(t => {
      const hs = [...t.querySelectorAll('thead th')].map(x => (x.innerText || '').trim().toLowerCase());
      return hs.includes('serial number') && hs.includes('destination');
    }) || null;
  }

  function colIdx(table, re) {
    return [...table.querySelectorAll('thead th')]
      .findIndex(th => re.test((th.innerText || '').trim()));
  }

  function getRows(table) {
    if (!table) return [];
    const si = colIdx(table, /serial\s*number/i);
    const di = colIdx(table, /destination/i);
    if (si < 0 || di < 0) return [];
    return [...table.querySelectorAll('tbody tr')].map(tr => {
      const c = tr.children;
      return {
        tr,
        serial: c[si] ? (c[si].innerText || '').trim() : '',
        dest:   c[di] ? (c[di].innerText || '').trim() : '',
        btn:    tr.querySelector('td:last-child button')
      };
    }).filter(r => r.serial && r.btn && !r.btn.disabled);
  }

  const groupRows = (table, key) => getRows(table).filter(r => GROUPS[key].test(r.dest));

  // The list empties itself for a moment while it refetches after every add.
  // Never treat that as "finished" without giving it time to come back.
  const listRepopulated = key => waitUntil(() => {
    const t = getTable(getModal());
    return t && groupRows(t, key).length > 0;
  }, REFRESH_MS);

  // If clicks stop registering, bouncing tabs forces the rows to re-render
  // with fresh handlers. Read-only and bounded.
  async function recover(key) {
    const modal = getModal();
    if (!modal) return false;
    const bb = tabButtons(modal, /^buybacks\s*\(\d+\)$/i)[0];
    const dmg = tabButtons(modal, /^damaged\s*\(\d+\)$/i)[0];
    if (!bb) return false;
    if (dmg) { try { dmg.click(); } catch (e) {} await sleep(600); }
    try { bb.click(); } catch (e) {}
    await sleep(600);
    return listRepopulated(key);
  }

  // ---------- UI ----------
  const FONT = '400 14px/16px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif';

  function styleButton(btn, variant) {
    const purple = 'var(--aui-primary, #8223d2)';
    const onPurple = 'var(--aui-on-primary, #ffffff)';
    Object.assign(btn.style, {
      font: FONT, padding: '8px 16px', borderRadius: '9999px', cursor: 'pointer',
      display: 'inline-flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap'
    });
    if (variant === 'filled') {
      Object.assign(btn.style, { background: purple, color: onPurple, border: '1px solid ' + purple });
    } else if (variant === 'outline') {
      Object.assign(btn.style, { background: 'transparent', color: purple, border: '1px solid ' + purple });
    } else {
      Object.assign(btn.style, {
        background: 'transparent', color: 'var(--aui-on-surface, #1a1c1e)',
        border: '1px solid transparent', textDecoration: 'underline'
      });
    }
  }

  const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };

  function buildToolbar() {
    const bar = document.createElement('div');
    bar.id = TOOLBAR_ID;
    Object.assign(bar.style, {
      display: 'flex', alignItems: 'center', gap: '8px',
      flexWrap: 'wrap', margin: '8px 0 12px'
    });

    const mk = key => {
      const b = document.createElement('button');
      b.type = 'button';
      styleButton(b, GROUPS[key].variant);
      b.addEventListener('click', () => addAll(key));
      return b;
    };
    bar._apple = mk('apple');
    bar._sg = mk('samsungGoogle');

    bar._stop = document.createElement('button');
    bar._stop.type = 'button';
    bar._stop.textContent = 'Stop';
    styleButton(bar._stop, 'flat');
    bar._stop.addEventListener('click', () => { state.cancel = true; setStatus('Stopping…'); });

    bar._status = document.createElement('span');
    Object.assign(bar._status.style, {
      font: '400 13px/16px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif',
      color: 'var(--aui-on-surface-soft, #5d5e61)'
    });

    bar.append(bar._apple, bar._sg, bar._stop, bar._status);
    return bar;
  }

  function refreshToolbar() {
    const bar = document.getElementById(TOOLBAR_ID);
    if (!bar) return;
    const table = getTable(getModal());
    const a = table ? groupRows(table, 'apple').length : 0;
    const s = table ? groupRows(table, 'samsungGoogle').length : 0;

    setText(bar._apple, `Add all Apple devices (${GROUPS.apple.hint}) · ${a}`);
    setText(bar._sg, `Add all Samsung/Google parts (${GROUPS.samsungGoogle.hint}) · ${s}`);

    [[bar._apple, a], [bar._sg, s]].forEach(([b, n]) => {
      const off = state.running || n === 0;
      b.disabled = off;
      b.style.opacity = off ? '0.45' : '1';
      b.style.cursor = off ? 'not-allowed' : 'pointer';
    });

    bar._stop.style.display = state.running ? 'inline-flex' : 'none';
    setText(bar._status, state.status || '');
  }

  const setStatus = t => { state.status = t; refreshToolbar(); };

  function anchorFor(modal, table) {
    const p = [...modal.querySelectorAll('p,div,span,h4')]
      .find(e => e.children.length <= 2 && /^salvages\s*\(\d+\)/i.test((e.innerText || '').trim()));
    if (p && p.parentElement) return { parent: p.parentElement, next: p.nextSibling };
    let n = table;
    while (n.parentElement && n.parentElement !== modal) n = n.parentElement;
    return { parent: n.parentElement || modal, next: n };
  }

  function sync() {
    const modal = getModal();
    const existing = document.getElementById(TOOLBAR_ID);
    const table = modal ? getTable(modal) : null;

    if (!modal || !table || !buybacksTabActive(modal)) {
      if (existing && !state.running) existing.remove();
      return;
    }
    if (!existing || !modal.contains(existing)) {
      if (existing) existing.remove();
      const bar = buildToolbar();
      const { parent, next } = anchorFor(modal, table);
      parent.insertBefore(bar, next);
    }
    refreshToolbar();
  }

  // ---------- the run ----------
  async function addAll(key) {
    if (state.running) return;
    const g = GROUPS[key];
    state.running = true;
    state.cancel = false;
    const tries = new Map();
    const t0 = Date.now();
    let clicks = 0, added = 0, stalls = 0, recoveries = 0;
    setStatus('Starting…');

    try {
      while (true) {
        if (state.cancel)              { setStatus(`Stopped — ${added} added.`); break; }
        if (Date.now() - t0 > WALL_MS) { setStatus(`Time limit reached — ${added} added.`); break; }
        if (clicks >= HARD_CAP)        { setStatus(`Safety cap (${HARD_CAP}) reached — ${added} added.`); break; }

        const modal = getModal();
        if (!modal)                    { setStatus(`Popout closed — ${added} added.`); break; }
        if (!buybacksTabActive(modal)) { setStatus(`Left the Buybacks tab — ${added} added.`); break; }
        const table = getTable(modal);
        if (!table)                    { setStatus(`List not found — ${added} added.`); break; }

        const rows = groupRows(table, key);

        if (!rows.length) {
          // Could be the post-add refresh rather than a finished list.
          setStatus(`Waiting for the list to refresh… (${added} added)`);
          if (!(await listRepopulated(key))) {
            setStatus(`Done — added ${added} ${g.label}.`);
            break;
          }
          continue;
        }

        // Rows are keyed by serial, never by index, because the table re-renders
        // after every add. A per-serial attempt cap makes retry loops impossible.
        const next = rows.find(r => (tries.get(r.serial) || 0) < MAX_TRIES);
        if (!next) { setStatus(`Stopped — ${added} added, ${rows.length} would not add.`); break; }

        const serial = next.serial;
        tries.set(serial, (tries.get(serial) || 0) + 1);
        setStatus(`Adding ${g.label} — ${added} done, ${rows.length} left…`);

        try { next.btn.click(); } catch (e) {}
        clicks++;

        const gone = await waitUntil(() => {
          const t = getTable(getModal());
          return !t || !getRows(t).some(r => r.serial === serial);
        }, SETTLE_MS);

        if (gone) {
          added++;
          stalls = 0;
        } else {
          stalls++;
          if (stalls >= MAX_STALLS) {
            if (recoveries < MAX_RECOVER) {
              recoveries++;
              setStatus(`No response — refreshing the list (attempt ${recoveries}/${MAX_RECOVER})…`);
              const ok = await recover(key);
              stalls = 0;
              if (ok) continue;
            }
            setStatus(`Stopped: adds stopped registering — ${added} added. ` +
                      `Check whether the order needs its parts scanned first.`);
            break;
          }
        }

        // Let the list come back before the next click.
        await listRepopulated(key);
        await sleep(GAP_MS);
      }
    } finally {
      state.running = false;
      state.cancel = false;
      refreshToolbar();
    }
  }

  let tid = null;
  new MutationObserver(() => {
    if (tid) return;
    tid = setTimeout(() => { tid = null; try { sync(); } catch (e) {} }, 200);
  }).observe(document.body, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected']
  });

  sync();
})();
