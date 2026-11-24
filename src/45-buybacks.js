/*
  Bountiful Yield (buyback add-all) — on a buyback order's "Add buyback parts" popout
  (and, since 2.16, an RMA order's "Add RMA parts" popout: one "Add all RMA
  parts" button; the serial is read from under the part name)
  (Buybacks tab), adds bulk-add buttons:

    Add all Apple devices (TLC)          destination "Asurion Reverse Logistics"
    Add all Samsung/Google parts (UROC)  destination mentions UROC

  Each clicks the row's own add button one at a time, keyed by serial number
  (the table re-renders after every add), waiting for the row to leave the
  list and the list to refill before the next. Safety limits stop a run from
  ever spinning: per-row retry cap, stall detection with a bounded tab-bounce
  recovery, a click cap and a wall-clock cap. A Stop button halts it.

  Attuned Sep 26 2026 from the standalone "Select All - Buybacks" v1.1.1
  (Tampermonkey on Zen). Its buttons often didn't appear because its @match
  was only /boh/inventory/buyback-order/* — Tampermonkey injects on a real
  page load and Portal is a single-page app, so arriving from any other
  portal page meant the script never ran (removing + re-adding it forced a
  reinject). As a shard it runs portal-wide and gates on the path itself.
*/
/*
  Scan with phone (Linkshell): on a buyback order's "Add buyback parts" popout, the phone scans B- labels and the PC adds each one
  in Portal with the two calls Portal's own scan makes (captured Nov 18, 2026, store 914; fixtures in test-client/buybacks.mjs):
    POST /api/boh/buyback-order-lines/{order}              { buybackOrderNumber, serialNumbers: [label] }
         → { BuybackOrderLines: [{ SerialId, DistroLabelId, … }], ErrorMessage, Success, DebugMessage }
    POST /api/boh/buyback-order-lines/{order}/scan-status  { buybackOrderNumber, distroLabels: [DistroLabelId] }
         → { ScanMultipleLabels: [{ ErrorMessage, Success, … }], ErrorMessage, Success, DebugMessage }
  Portal makes no call for a label that isn't eligible, so neither does Aethernet: a label that isn't an enabled row of the popout
  fails here with "Not eligible". Every answer short of Success: true is a failure, with Portal's ErrorMessage when it gives one.
  Messages (Linkshell, sealed; src/67-linkshell.js):
    PC → phone  buybacks.run     { run, order, store, part, parts, items: [[i, label, destination, state], …] }  state: pending | added | failed
                buybacks.result  { run, label, i, state, message? }   i = -1 for a label that isn't in the list
                buybacks.end     { run }
    phone → PC  buybacks.scan    { run, label }
                buybacks.join    { run }   the list again
*/
AE.buybacks = {
  isLabel: (v) => /^B-\S+$/i.test(String(v || '').trim()),
  // call(method, path, body) → { status, json }. → { state: 'added' | 'failed', message? }
  async addAndScan(call, order, label) {
    const fail = (message) => ({ state: 'failed', message });
    const said = (j) => (j && typeof j.ErrorMessage === 'string' && j.ErrorMessage.trim()) || '';
    const base = '/api/boh/buyback-order-lines/' + encodeURIComponent(order);
    const a = await call('POST', base, { buybackOrderNumber: order, serialNumbers: [label] });
    if (!a.status) return fail('No connection to Portal');
    if (a.status < 200 || a.status >= 300) return fail(said(a.json) || 'Portal answered HTTP ' + a.status);
    if (!a.json || a.json.Success !== true) return fail(said(a.json) || "Portal didn't add it");
    const lines = Array.isArray(a.json.BuybackOrderLines) ? a.json.BuybackOrderLines : [];
    const line = lines.find((l) => l && String(l.SerialId || '').toUpperCase() === label.toUpperCase());
    const distro = line && typeof line.DistroLabelId === 'string' && line.DistroLabelId.trim();
    if (!distro) return fail("Portal didn't return its distro label");
    const b = await call('POST', base + '/scan-status', { buybackOrderNumber: order, distroLabels: [distro] });
    if (!b.status) return fail('Added, but no connection to Portal to mark it scanned');
    const each = b.json && Array.isArray(b.json.ScanMultipleLabels) ? b.json.ScanMultipleLabels : [];
    const bad = each.find((x) => !x || x.Success !== true);
    if (b.status < 200 || b.status >= 300 || !b.json || b.json.Success !== true || bad) return fail(said(bad) || said(b.json) || 'Added, but not marked scanned');
    return { state: 'added' };
  },
};

AE.shard({
  id: 'buybacks',
  name: 'Bountiful Yield',
  sites: ['portal.ubreakifix.net'],
  run() {
    const { h } = AE;
    // Two pages, same idea: a buyback order's "Add buyback parts" popout and an
    // RMA order's "Add RMA parts" popout. The mode comes from the page.
    const MODES = {
      buyback: {
        path: /^\/boh\/inventory\/buyback-order\//, heading: /^\s*add\s+buyback\s+parts\s*$/i,
        headers: (hs) => hs.includes('serial number') && hs.includes('destination'), anchor: /^salvages\s*\(\d+\)/i,
      },
      rma: {
        path: /^\/boh\/inventory\/rma-order\//, heading: /^\s*add\s+rma\s+parts\s*$/i,
        headers: (hs) => hs.includes('part') && hs.includes('return value'), anchor: /^rmas\s*\(\d+\)/i,
      },
    };
    const mode = () => Object.keys(MODES).find((k) => MODES[k].path.test(location.pathname)) || null;
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
      rma: { label: 'RMA parts', hint: '', variant: 'sg-primary', test: () => true },
    };
    const groupsFor = (m) => (m === 'rma' ? ['rma'] : ['apple', 'samsungGoogle']);

    document.head.append(h('style', null, `
      #${TOOLBAR_ID} { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin:8px 0 12px; }
      #${TOOLBAR_ID} .sg-outline { border-color:var(--aui-primary,#8223d2); color:var(--aui-primary,#8223d2); }
      #${TOOLBAR_ID} .sg-outline:hover { background:var(--aui-primary-soft,#faecff); }
      #${TOOLBAR_ID} .sg-btn:disabled { opacity:.45; cursor:not-allowed; }
      #${TOOLBAR_ID} .count { font-weight:700; }
      #${TOOLBAR_ID} [data-group] { padding-left:7px; }
      #${TOOLBAR_ID} .status { display:inline-flex; align-items:center; gap:6px; font-size:13px; color:var(--aui-on-surface-soft,#5d5e61); }
      #${TOOLBAR_ID} .sg-spin { width:14px; height:14px; }
      #${TOOLBAR_ID} .sg-tint { border-color:var(--aui-primary-soft,#faecff); background:var(--aui-primary-soft,#faecff); color:var(--aui-primary,#8223d2); }
      #${TOOLBAR_ID} .chip { height:24px; padding:0 10px; border-radius:12px; font-size:12px; font-weight:700; display:inline-flex; align-items:center;
        background:var(--aui-status-success-soft,#c5ffc8); color:var(--aui-status-success,#136d31); }
      #${TOOLBAR_ID} .status b { color:var(--aui-on-surface,#1a1c1e); }
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
      const m = mode();
      if (!m) return null;
      const heads = [...document.querySelectorAll('h1,h2,h3')]
        .filter((e) => MODES[m].heading.test(e.textContent || ''))
        .filter(isVisible);
      const hd = heads[heads.length - 1];
      let n = hd;
      for (let i = 0; i < 12 && n; i++) { n = n.parentElement; if (n && n.querySelector('table')) return n; }
      return null;
    }
    const tabButtons = (modal, re) => [...modal.querySelectorAll('button,[role="tab"]')].filter((b) => re.test((b.innerText || '').trim()));
    // The Damaged tab has identical columns; the active tab is the only reliable tell.
    function buybacksTabActive(modal) {
      if (mode() === 'rma') return true; // the RMA popout has no tabs
      const tabs = tabButtons(modal, /^buybacks\s*\(\d+\)$/i);
      return tabs.length > 0 && tabs.some((b) => b.getAttribute('aria-selected') === 'true');
    }
    function getTable(modal) {
      if (!modal) return null;
      const m = mode();
      return [...modal.querySelectorAll('table')].find((t) => {
        const hs = [...t.querySelectorAll('thead th')].map((x) => (x.innerText || '').trim().toLowerCase());
        return m && MODES[m].headers(hs);
      }) || null;
    }
    const colIdx = (table, re) => [...table.querySelectorAll('thead th')].findIndex((th) => re.test((th.innerText || '').trim()));
    const btnEnabled = (b) => b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
    function getRows(table) {
      if (!table) return [];
      if (mode() === 'rma') {
        // Part cell = name with the serial underneath; the last cell holds "+".
        const pi = colIdx(table, /^part$/i), mi = colIdx(table, /manufacturer/i);
        if (pi < 0) return [];
        return [...table.querySelectorAll('tbody tr')].map((tr) => {
          const c = tr.children, text = c[pi] ? (c[pi].innerText || '').trim() : '';
          const serial = (text.match(/\b\d+-\d{6,}\b/) || [text.split('\n').pop().trim()])[0];
          return { tr, serial, dest: mi >= 0 && c[mi] ? (c[mi].innerText || '').trim() : '', btn: tr.querySelector('td:last-child button') };
        }).filter((r) => r.serial && btnEnabled(r.btn));
      }
      const si = colIdx(table, /serial\s*number/i), di = colIdx(table, /destination/i);
      if (si < 0 || di < 0) return [];
      return [...table.querySelectorAll('tbody tr')].map((tr) => {
        const c = tr.children;
        return { tr, serial: c[si] ? (c[si].innerText || '').trim() : '', dest: c[di] ? (c[di].innerText || '').trim() : '', btn: tr.querySelector('td:last-child button') };
      }).filter((r) => r.serial && btnEnabled(r.btn));
    }
    const groupRows = (table, key) => getRows(table).filter((r) => GROUPS[key].test(r.dest));
    // The list empties for a moment while it refetches after every add —
    // never treat that as "finished" without giving it time to come back.
    const listRepopulated = (key) => waitUntil(() => { const t = getTable(getModal()); return t && groupRows(t, key).length > 0; }, REFRESH_MS);
    // If clicks stop registering, bouncing tabs re-renders the rows with fresh handlers. Read-only, bounded.
    async function recover(key) {
      const modal = getModal();
      if (!modal || mode() === 'rma') return false; // no tabs to bounce on the RMA popout
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
      const mk = (key) => h('button', { type: 'button', class: 'sg sg-btn ' + GROUPS[key].variant, 'data-group': key, onclick: () => addAll(key) });
      const bar = h('div', { id: TOOLBAR_ID, class: 'sg', 'data-mode': mode() });
      bar._groups = groupsFor(mode()).map(mk);
      bar._stop = h('button', { type: 'button', class: 'sg sg-btn sg-danger', onclick: () => { if (phone.run) return phoneEnd(); state.cancel = true; setStatus('Stopping…'); } }, '■ Stop');
      bar._status = h('span', { class: 'status' });
      bar._phone = h('button', { type: 'button', class: 'sg sg-btn sg-tint', onclick: phoneStart }, 'Scan with phone');
      bar._chip = h('span', { class: 'chip' }, 'Phone');
      bar.append(...bar._groups, bar._phone, bar._chip, bar._stop, bar._status);
      return bar;
    }
    function refreshToolbar() {
      const bar = document.getElementById(TOOLBAR_ID);
      if (!bar) return;
      const table = getTable(getModal());
      const label = (key, n) => AE.actionIcon('buybacks', 18) + 'Add all ' + GROUPS[key].label + (GROUPS[key].hint ? ' (' + GROUPS[key].hint + ')' : '') + ' · <span class="count">' + n + '</span>';
      const setHtml = (el, html) => { if (el.innerHTML !== html) el.innerHTML = html; };
      for (const btn of bar._groups) {
        const n = table ? groupRows(table, btn.dataset.group).length : 0;
        setHtml(btn, label(btn.dataset.group, n));
        btn.disabled = state.running || n === 0;
        btn.style.display = phone.run ? 'none' : '';
      }
      const canPhone = mode() === 'buyback' && !!link() && !!orderNo();
      bar._phone.style.display = canPhone && !phone.run ? '' : 'none';
      bar._phone.disabled = state.running || !table || getRows(table).length === 0;
      bar._chip.style.display = phone.run ? '' : 'none';
      bar._stop.style.display = state.running || phone.run ? '' : 'none';
      const ph = phone.run ? '<b>' + phone.added + ' / ' + phone.items.length + '</b>' + (phone.last ? ' · ' + AE.esc(phone.last) + ' added' : '') : '';
      setHtml(bar._status, phone.run ? ph : (state.running ? '<span class="sg-spin"></span>' : '') + AE.esc(state.status || ''));
    }
    const setStatus = (t) => { state.status = t; refreshToolbar(); };

    function anchorFor(modal, table) {
      const p = [...modal.querySelectorAll('p,div,span,h4')]
        .find((e) => e.children.length <= 2 && MODES[mode()].anchor.test((e.innerText || '').trim()));
      if (p && p.parentElement) return { parent: p.parentElement, next: p.nextSibling };
      let n = table;
      while (n.parentElement && n.parentElement !== modal) n = n.parentElement;
      return { parent: n.parentElement || modal, next: n };
    }

    function sync() {
      const existing = document.getElementById(TOOLBAR_ID);
      if (!mode()) { if (existing && !state.running) existing.remove(); return; }
      if (existing && existing.dataset.mode !== mode() && !state.running) existing.remove();
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
      AE.track(mode() === 'rma' ? 'buybacks:addAllRma' : 'buybacks:addAll');
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
            if (!(await listRepopulated(key))) {
              // RMAs have a line limit; Portal disables "+" once it's reached.
              const limited = mode() === 'rma' && /line limit for an rma/i.test((getModal() || {}).innerText || '');
              setStatus(limited ? 'RMA line limit reached — added ' + added + '.' : 'Done — added ' + added + ' ' + g.label + '.');
              break;
            }
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

    // ---------- Scan with phone (Linkshell; the messages are listed above AE.buybacks) ----------
    const link = () => (AE.linkshell && AE.settings.crystals.linkshell !== false && AE.linkshell.linked() ? AE.linkshell : null);
    const orderNo = () => (location.pathname.match(/^\/boh\/inventory\/buyback-order\/([^/?#]+)/) || [])[1] || null;
    const phone = { run: null, order: null, store: '', items: [], added: 0, last: '' };
    let chain = Promise.resolve();
    async function call(method, path, body) {
      const init = { method, credentials: 'include', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) };
      let res, text;
      try { ({ res, text } = await AE.timedFetch(method, path, init, 20000)); }
      catch (_) { return { status: 0 }; }
      let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) {}
      if (res.status === 401) AE.signedOut();
      return { status: res.status, json };
    }
    const RUN_PART = 40;
    function sendRun(wake) {
      const L = link();
      if (!L || !phone.run) return;
      const parts = Math.max(1, Math.ceil(phone.items.length / RUN_PART));
      for (let p = 0; p < parts; p++) L.send('buybacks.run', { run: phone.run, order: phone.order, store: phone.store, part: p, parts, items: phone.items.slice(p * RUN_PART, (p + 1) * RUN_PART) }, { wake: wake && p === 0 });
    }
    function phoneStart() {
      const table = getTable(getModal()), order = orderNo();
      if (!table || !order || !link() || state.running || phone.run) return;
      if (AE.status.blocked('buybacks')) return;
      AE.track('buybacks:phone');
      phone.run = [...crypto.getRandomValues(new Uint8Array(8))].map((x) => x.toString(16).padStart(2, '0')).join('');
      phone.order = order; phone.added = 0; phone.last = '';
      phone.store = String((link().linked() || {}).store || '');
      phone.items = getRows(table).map((r, i) => [i, r.serial, r.dest, 'pending']);
      sendRun(true); refreshToolbar();
    }
    function phoneEnd() {
      if (!phone.run) return;
      const L = link();
      if (L) L.send('buybacks.end', { run: phone.run });
      phone.run = null; refreshToolbar();
    }
    // Bounce the tabs so the list drops what was just added (read-only, as recover()).
    async function refreshList() {
      const modal = getModal();
      const bb = modal && tabButtons(modal, /^buybacks\s*\(\d+\)$/i)[0], dmg = modal && tabButtons(modal, /^damaged\s*\(\d+\)$/i)[0];
      if (!bb || !dmg) return;
      try { dmg.click(); } catch (_) {}
      await sleep(400);
      try { bb.click(); } catch (_) {}
    }
    async function phoneScan(b) {
      if (!phone.run || !b || b.run !== phone.run) return;
      const raw = String(b.label || '').trim();
      const i = phone.items.findIndex((x) => x[1].toUpperCase() === raw.toUpperCase());
      const label = i >= 0 ? phone.items[i][1] : raw;
      const tell = (st, message) => {
        if (i >= 0) phone.items[i][3] = st;
        const L = link();
        if (L) L.send('buybacks.result', Object.assign({ run: phone.run, label, i, state: st }, message ? { message } : {}));
        refreshToolbar();
      };
      if (!AE.buybacks.isLabel(label)) return tell('failed', 'Not a buyback label');
      if (i >= 0 && phone.items[i][3] === 'added') return tell('added');
      const modal = getModal(), table = modal && buybacksTabActive(modal) ? getTable(modal) : null;
      if (!table || orderNo() !== phone.order) return tell('failed', "Add buyback parts isn't open on the PC");
      if (!getRows(table).some((r) => r.serial.toUpperCase() === label.toUpperCase())) return tell('failed', 'Not eligible');
      const r = await AE.buybacks.addAndScan(call, phone.order, label);
      if (r.state === 'added') { phone.added++; phone.last = label; }
      tell(r.state, r.message);
      if (r.state === 'added') refreshList();
    }
    if (AE.linkshell) {
      AE.linkshell.on('buybacks.scan', (b) => { chain = chain.then(() => phoneScan(b)).catch(() => {}); return chain; });
      AE.linkshell.on('buybacks.join', (b) => { if (phone.run && b && b.run === phone.run) sendRun(); });
    }

    let tid = null;
    new MutationObserver(() => {
      if (tid) return;
      tid = setTimeout(() => { tid = null; try { sync(); } catch (_) {} }, 200);
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected'] });
    sync();
  },
});
