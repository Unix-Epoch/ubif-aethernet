// ==UserScript==
// @name         UBIF Portal — Live cleaning rate
// @namespace    garrett.ubif
// @version      1.0
// @description  Shows today's cleaning rate (cleanings ÷ Asurion Mobility orders created today) as a live badge in the portal header. Read-only.
// @match        https://portal.ubreakifix.net/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
  Rate = cleanings linked to today's Asurion Mobility orders ÷ Asurion
  Mobility orders created today (local time). Each cleaning counts on its
  own, so a carrier pair on every order reads 200%; target is 75%, ideally
  100%. Notes/reasons are deliberately ignored — raw percentage only.

  Linking: same device IMEI (AT&T cleanings are often checked in under a
  different customer record than the parent, so customer ID misses them);
  falls back to customer ID only when a WO has no IMEI.

  Data: two list calls per refresh — open WOs and closed WOs (newest
  created first). Both come back scoped to the logged-in user's current
  store, so nothing here is store-specific. Read-only: it never writes.
*/

const CONFIG = {
  PARENT_PROGRAM_ID: 5062, // Asurion Mobility
  CLEANING_PROGRAM_IDS: {
    11759: 'VZ Device Refresh',
    9470: 'VZ Sanitization',
    11009: 'AT&T Enhanced Cleaning',
    9901: 'AT&T Device Diagnostic',
    10303: 'AT&T Performance Check',
  },
  TARGET: 75, // % — red below, amber up to 99, green at 100+
  REFRESH_MS: 2 * 60 * 1000,
  OPEN_STATUS_IDS: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 17, 24, 26, 27], // the portal's own "Active" set
  PAGE_SIZE: 100,
  PAGE_CAP: 10,
};

(function main() {
  if (location.hostname !== 'portal.ubreakifix.net') return;

  const BADGE_ID = 'cwr-badge';
  const PANEL_ID = 'cwr-panel';
  let last = null;       // last computed result
  let loading = false;
  let lastError = null;

  // ------------------------------------------------------------- data
  async function listPage(primaryFilter, page) {
    const body = {
      page, pageSize: CONFIG.PAGE_SIZE, deviceTypeIds: [], serviceOutcome: [], programIds: [],
      needsAttention: false, tab: 'All', primaryFilter,
      // Closed only returns rows with empty status/program filters.
      workOrderStatusIds: primaryFilter === 'Active' ? CONFIG.OPEN_STATUS_IDS : [],
      order: primaryFilter === 'Active' ? 'nextUpdate,DESC' : 'createdAt,DESC',
    };
    const res = await fetch('/api/workorders', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 401 || res.status === 403) throw new Error('Session expired — log in again');
    if (!res.ok) throw new Error('Work order list failed (HTTP ' + res.status + ')');
    const j = await res.json();
    return (j && j.workOrders) || [];
  }

  async function fetchToday(startMs) {
    const byId = new Map();
    // Open: small list, sorted by nextUpdate — take every page.
    for (let p = 1; p <= CONFIG.PAGE_CAP; p++) {
      const rows = await listPage('Active', p);
      rows.forEach((r) => byId.set(r.workorderId, r));
      if (rows.length < CONFIG.PAGE_SIZE) break;
    }
    // Closed: newest-created first — stop once past the start of today.
    for (let p = 1; p <= CONFIG.PAGE_CAP; p++) {
      const rows = await listPage('Closed', p);
      rows.forEach((r) => byId.set(r.workorderId, r));
      const lastRow = rows[rows.length - 1];
      if (rows.length < CONFIG.PAGE_SIZE || !lastRow || Date.parse(lastRow.createdAt) < startMs) break;
    }
    return [...byId.values()];
  }

  const imeiOf = (r) => {
    const i = String((r.customerDevice && r.customerDevice.imei) || '').trim();
    return /^\d{14,15}$/.test(i) ? i : null;
  };
  const custOf = (r) => String((r.customer && (r.customer.customerId ?? r.customer.id)) || (r.customerDevice && r.customerDevice.customerId) || '');

  async function compute() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const startMs = start.getTime(), endMs = startMs + 86400000;
    const all = await fetchToday(startMs);
    const today = (r) => { const t = Date.parse(r.createdAt); return t >= startMs && t < endMs; };

    const parents = all.filter((r) => r.programId === CONFIG.PARENT_PROGRAM_ID && today(r))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const cleanings = all.filter((r) => CONFIG.CLEANING_PROGRAM_IDS[r.programId] && today(r));

    const used = new Set();
    const rows = parents.map((p) => {
      const pImei = imeiOf(p), pCust = custOf(p);
      const matched = cleanings.filter((c) => {
        if (used.has(c.workorderId)) return false;
        const cImei = imeiOf(c);
        return pImei && cImei ? cImei === pImei : (!!pCust && custOf(c) === pCust);
      });
      matched.forEach((c) => used.add(c.workorderId));
      return { p, matched };
    });
    const linked = rows.reduce((n, r) => n + r.matched.length, 0);
    return {
      parents: parents.length,
      linked,
      unlinked: cleanings.filter((c) => !used.has(c.workorderId)),
      pct: parents.length ? Math.round((linked / parents.length) * 100) : null,
      rows,
      at: new Date(),
    };
  }

  // --------------------------------------------------------------- UI
  const colorFor = (pct) => (pct == null ? '#6e6e78' : pct >= 100 ? '#1b7f3b' : pct >= CONFIG.TARGET ? '#b26a00' : '#c62828');
  const fmtTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function ensureCss() {
    if (document.getElementById(BADGE_ID + '-css')) return;
    const css = document.createElement('style');
    css.id = BADGE_ID + '-css';
    css.textContent =
      '#' + BADGE_ID + '{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;margin:0 8px 0 12px;border-radius:999px;border:0;' +
      'color:#fff;font:600 13px/1 system-ui,sans-serif;cursor:pointer;white-space:nowrap;font-variant-numeric:tabular-nums}' +
      '#' + BADGE_ID + '.floating{position:fixed;left:16px;bottom:16px;z-index:2147483646;box-shadow:0 4px 14px rgba(0,0,0,.25)}' +
      '@keyframes cwr-spin{to{transform:rotate(360deg)}}' +
      '#' + BADGE_ID + ' .cwr-spin{width:10px;height:10px;border:2px solid rgba(255,255,255,.45);border-top-color:#fff;border-radius:50%;animation:cwr-spin .7s linear infinite}' +
      '#' + PANEL_ID + '{position:fixed;z-index:2147483647;width:380px;max-height:70vh;overflow:auto;background:#fff;color:#111;border-radius:12px;' +
      'box-shadow:0 8px 28px rgba(0,0,0,.28);font:13px/1.45 system-ui,sans-serif;padding:14px}' +
      '#' + PANEL_ID + ' table{width:100%;border-collapse:collapse;margin-top:8px}' +
      '#' + PANEL_ID + ' td{padding:5px 4px;border-top:1px solid #eee;vertical-align:top}' +
      '#' + PANEL_ID + ' a{color:#8223D2;text-decoration:none;font-weight:600}' +
      '#' + PANEL_ID + ' .miss{color:#c62828;font-weight:600}' +
      '#' + PANEL_ID + ' .sub{color:#6e6e78;font-size:12px}';
    document.head.appendChild(css);
  }

  function badgeText() {
    if (lastError && !last) return 'Cleanings: error';
    if (!last) return 'Cleanings …';
    if (last.pct == null) return 'Cleanings 0/0 · no AM orders yet';
    return 'Cleanings ' + last.linked + '/' + last.parents + ' · ' + last.pct + '%';
  }

  function renderBadge() {
    ensureCss();
    let b = document.getElementById(BADGE_ID);
    if (!b) {
      b = document.createElement('button');
      b.id = BADGE_ID;
      b.type = 'button';
      b.onclick = togglePanel;
    }
    // Header: sits left of "UBIF support". Falls back to a floating pill.
    const anchor = [...document.querySelectorAll('header button, button')].find((x) => x.offsetParent && x.textContent.trim() === 'UBIF support');
    if (anchor && b.parentElement !== anchor.parentElement) {
      b.classList.remove('floating');
      anchor.parentElement.insertBefore(b, anchor);
    } else if (!anchor && !b.isConnected) {
      b.classList.add('floating');
      document.body.appendChild(b);
    }
    b.style.background = lastError && !last ? '#6e6e78' : colorFor(last && last.pct);
    b.innerHTML = (loading ? '<span class="cwr-spin"></span>' : '') + esc(badgeText());
    b.title = (last ? 'Updated ' + fmtTime(last.at) : 'Loading') +
      (lastError ? ' — last refresh failed: ' + lastError : '') + ' · target ' + CONFIG.TARGET + '%, ideally 100% · click for details';
    if (document.getElementById(PANEL_ID)) renderPanel();
  }

  function renderPanel() {
    let p = document.getElementById(PANEL_ID);
    const b = document.getElementById(BADGE_ID);
    if (!p) {
      p = document.createElement('div');
      p.id = PANEL_ID;
      document.body.appendChild(p);
    }
    const r = b && b.getBoundingClientRect();
    if (r && !b.classList.contains('floating')) { p.style.top = (r.bottom + 8) + 'px'; p.style.left = Math.max(8, Math.min(r.left, innerWidth - 396)) + 'px'; p.style.bottom = ''; }
    else { p.style.left = '16px'; p.style.bottom = '60px'; p.style.top = ''; }

    if (!last) { p.innerHTML = lastError ? '<span class="miss">' + esc(lastError) + '</span>' : 'Loading…'; return; }
    const head = '<div style="display:flex;justify-content:space-between;align-items:baseline">' +
      '<b style="font-size:15px">Today\'s cleaning rate: <span style="color:' + colorFor(last.pct) + '">' + (last.pct == null ? '—' : last.pct + '%') + '</span></b>' +
      '<a href="#" data-refresh>Refresh</a></div>' +
      '<div class="sub">' + last.linked + ' cleanings ÷ ' + last.parents + ' Asurion Mobility orders created today · target ' + CONFIG.TARGET + '%, ideally 100% · updated ' + fmtTime(last.at) +
      (lastError ? '<br><span class="miss">Last refresh failed: ' + esc(lastError) + '</span>' : '') + '</div>';
    const body = last.rows.length
      ? '<table>' + last.rows.map(({ p: wo, matched }) => {
        const dev = (wo.customerDevice && wo.customerDevice.name) || (wo.deviceCatalog && wo.deviceCatalog.name) || '';
        return '<tr><td><a href="/repair/workorder/' + wo.workorderId + '">' + wo.workorderId + '</a><div class="sub">' + fmtTime(new Date(wo.createdAt)) + ' · ' + esc(dev) + '</div></td>' +
          '<td>' + (matched.length
            ? matched.map((c) => esc(CONFIG.CLEANING_PROGRAM_IDS[c.programId])).join('<br>')
            : '<span class="miss">No cleanings</span>') + '</td></tr>';
      }).join('') + '</table>'
      : '<p class="sub">No Asurion Mobility orders created today yet.</p>';
    const extra = last.unlinked.length
      ? '<p class="sub" style="margin-top:8px">' + last.unlinked.length + ' cleaning(s) today not linked to any of today\'s orders (not counted): ' +
        last.unlinked.map((c) => '<a href="/repair/workorder/' + c.workorderId + '">' + c.workorderId + '</a>').join(', ') + '</p>'
      : '';
    p.innerHTML = head + body + extra;
    p.querySelector('[data-refresh]').onclick = (e) => { e.preventDefault(); refresh(); };
  }

  function togglePanel(e) {
    e.stopPropagation();
    const p = document.getElementById(PANEL_ID);
    if (p) p.remove(); else renderPanel();
  }
  document.addEventListener('click', (e) => {
    const p = document.getElementById(PANEL_ID);
    if (p && !p.contains(e.target) && e.target.id !== BADGE_ID) p.remove();
  });

  async function refresh() {
    if (loading) return;
    loading = true;
    renderBadge();
    try {
      last = await compute();
      lastError = null;
    } catch (e) {
      lastError = e.message || String(e);
    } finally {
      loading = false;
      renderBadge();
    }
  }

  // Skip the login page; pause while the tab is hidden, catch up on return.
  const onPortal = () => !/^\/login/.test(location.pathname);
  setInterval(() => { if (onPortal()) renderBadge(); }, 1500); // SPA re-renders can drop the badge
  setInterval(() => { if (onPortal() && !document.hidden) refresh(); }, CONFIG.REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && onPortal() && (!last || Date.now() - last.at > CONFIG.REFRESH_MS)) refresh();
  });
  if (onPortal()) refresh();
})();
