/*
  Lay of the Land (inventory count check) — on an inventory count's edit or
  review page (/boh/inventory/counts/<journalId>/edit|review), shows which
  expected serials haven't been scanned yet, and what was scanned that
  wasn't expected. Named for the Miner action that reveals what's hidden.

  Data (all GETs Portal's own count page uses):
    boh/counts/expectedSerials?journalId=…   every serial the count expects, by item
    boh/counts/<id>/item                     scanned quantity per item
    boh/counts/<id>/<itemId>/serial          the serials scanned for one item
  Portal files every scan that isn't an expected serial under three made-up
  items — "unknownitem", "invalidformat" and "duplicate" — so a real item's
  scans are always its own expected serials. That means only partially
  scanned items need their serial lists: an item with no scans is missing
  everything, and a fully scanned one is missing nothing. (Checked against a
  full serial-by-serial comparison on UBF-013049: identical, 408 missing.)
*/
AE.crystal({
  id: 'countCheck',
  name: 'Lay of the Land',
  sites: ['portal.ubreakifix.net'],
  run() {
    const { h } = AE;
    const PATH_RE = /^\/boh\/inventory\/counts\/([^/]+)\/(edit|review)\b/;
    const PILL_ID = 'sg-lol-pill', PANEL_ID = 'sg-lol';
    const REFRESH_MS = 2 * 60 * 1000;
    const BUCKETS = {
      unknownitem: 'Not in stock for this store',
      invalidformat: 'Not a serial (barcode, item number, date…)',
      duplicate: 'Scanned twice',
    };
    let state = null;   // { id, status: 'loading'|'ready'|'error', data, error, at }
    let loadingFor = null, tab = 'missing', query = '';
    let cat = 'all', sortBy = 'missing';         // category filter + sort (Missing tab)
    const open = new Set();                      // expanded entries ("item:<id>" / "bucket:<id>"); collapsed by default

    document.head.append(h('style', null, `
      #${PILL_ID} { position:fixed; z-index:2147483644; right:16px; bottom:88px; display:inline-flex; align-items:center; gap:8px; height:40px; padding:0 14px 0 6px;
        border:1px solid var(--aui-outline, #c6c6ca); border-radius:10000rem; cursor:pointer; background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e);
        box-shadow:0 8px 24px rgba(12,14,17,.2); font:600 14px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; }
      #${PILL_ID}:hover { border-color:var(--aui-primary, #8223d2); }
      #${PILL_ID} .n { min-width:22px; height:22px; padding:0 7px; border-radius:10000rem; box-sizing:border-box; background:#d1344b; color:#fff; font:700 12px/22px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; text-align:center; }
      #${PILL_ID} .n.zero { background:var(--aui-status-success, #136d31); }
      #${PILL_ID} .sg-aicon { width:28px; height:28px; }
      #${PANEL_ID} { position:fixed; z-index:2147483646; right:16px; bottom:140px; width:min(620px, calc(100vw - 32px)); max-height:calc(100vh - 200px); display:flex; flex-direction:column;
        padding:16px 16px 10px; font-size:14px; line-height:1.4; }
      #${PANEL_ID} .head { display:flex; align-items:center; gap:10px; margin-bottom:10px; }
      #${PANEL_ID} .head b { flex:1; font-size:17px; }
      #${PANEL_ID} .head .sub { font-weight:400; font-size:12px; color:var(--aui-on-surface-soft, #5d5e61); }
      #${PANEL_ID} .stats { display:grid; grid-template-columns:repeat(4, 1fr); gap:8px; margin-bottom:10px; }
      #${PANEL_ID} .stat { border:1px solid var(--aui-outline-soft, #eeedf1); border-radius:10px; padding:6px 10px; }
      #${PANEL_ID} .stat .v { font-size:20px; font-weight:700; font-variant-numeric:tabular-nums; }
      #${PANEL_ID} .stat .k { font-size:11px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; color:var(--aui-on-surface-soft, #5d5e61); }
      #${PANEL_ID} .stat.bad .v { color:#d1344b; }
      #${PANEL_ID} .tabs { display:flex; gap:2px; border-bottom:1px solid var(--aui-outline-soft, #eeedf1); margin-bottom:8px; }
      #${PANEL_ID} .tab { padding:6px 10px 7px; border:0; border-bottom:2px solid transparent; margin-bottom:-1px; background:none; cursor:pointer;
        color:var(--aui-on-surface-soft, #5d5e61); font:600 13px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; }
      #${PANEL_ID} .tab.on { color:var(--aui-primary, #8223d2); border-bottom-color:var(--aui-primary, #8223d2); }
      #${PANEL_ID} .tools { display:flex; gap:6px; margin-bottom:8px; }
      #${PANEL_ID} .tools input { flex:1; min-width:0; height:32px; padding:0 10px; border:1px solid var(--aui-outline, #c6c6ca); border-radius:8px;
        background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e); font:13px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; }
      #${PANEL_ID} .tools .sg-btn { height:32px; font-size:13px; }
      #${PANEL_ID} .list { overflow:auto; }
      #${PANEL_ID} .cats { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-bottom:8px; }
      #${PANEL_ID} .cat { height:26px; padding:0 10px; border:1px solid var(--aui-outline, #c6c6ca); border-radius:10000rem; background:none; cursor:pointer;
        color:var(--aui-on-surface, #1a1c1e); font:600 12px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; }
      #${PANEL_ID} .cat.on { background:var(--aui-primary, #8223d2); border-color:var(--aui-primary, #8223d2); color:var(--aui-on-primary, #fff); }
      #${PANEL_ID} .cats select { height:26px; margin-left:auto; border:1px solid var(--aui-outline, #c6c6ca); border-radius:8px; background:var(--aui-surface, #fff);
        color:var(--aui-on-surface, #1a1c1e); font:12px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; }
      #${PANEL_ID} .cats .sg-btn { height:26px; padding:0 10px; font-size:12px; }
      #${PANEL_ID} .section { margin:10px 0 2px; font-size:11px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--aui-on-surface-soft, #5d5e61); }
      #${PANEL_ID} .item .t { cursor:pointer; user-select:none; }
      #${PANEL_ID} .item .t .chev { width:14px; height:14px; flex:none; align-self:center; color:var(--aui-on-surface-soft, #5d5e61); transition:transform .15s; transform:rotate(-90deg); }
      #${PANEL_ID} .item.open .t .chev { transform:none; }
      #${PANEL_ID} .item:not(.open) .serials { display:none; }
      #${PANEL_ID} .item { padding:8px 2px; border-top:1px solid var(--aui-outline-soft, #eeedf1); }
      #${PANEL_ID} .item .t { display:flex; gap:8px; align-items:baseline; }
      #${PANEL_ID} .item .t b { flex:1; font-weight:600; }
      #${PANEL_ID} .item .t .q { font-size:12px; color:var(--aui-on-surface-soft, #5d5e61); white-space:nowrap; }
      #${PANEL_ID} .grp { font-size:11px; padding:0 6px; border-radius:10000rem; background:var(--aui-neutral-soft, #f1f0f4); color:var(--aui-on-neutral-soft, #2f3033); }
      #${PANEL_ID} .serials { display:flex; flex-wrap:wrap; gap:4px; margin-top:5px; }
      #${PANEL_ID} .serials button { border:1px solid var(--aui-outline-soft, #eeedf1); border-radius:6px; padding:2px 6px; background:var(--aui-surface-variant, #faf9fc);
        color:var(--aui-on-surface, #1a1c1e); font:12px ui-monospace, SFMono-Regular, Menlo, monospace; cursor:copy; }
      #${PANEL_ID} .serials button:hover { border-color:var(--aui-primary, #8223d2); }
      #${PANEL_ID} .foot { font-size:12px; color:var(--aui-on-surface-soft, #5d5e61); padding-top:6px; }
    `));

    const countId = () => { const m = location.pathname.match(PATH_RE); return m ? decodeURIComponent(m[1]) : null; };
    const base = (id) => '/api/boh/counts/' + encodeURIComponent(id);

    // Fetch a few at a time: gentle on Portal.
    async function pool(items, n, fn) {
      const out = new Array(items.length);
      let i = 0;
      await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
      return out;
    }

    async function compute(id) {
      const [exp, it] = await Promise.all([
        AE.api('GET', '/api/boh/counts/expectedSerials?journalId=' + encodeURIComponent(id)),
        AE.api('GET', base(id) + '/item'),
      ]);
      const lines = (exp && exp.Lines) || [];
      const rows = (it && it.ScannedItemInformation) || [];
      const qty = new Map(rows.map((r) => [String(r.ItemId), Number(r.ScannedQuantity) || 0]));
      const partial = lines.filter((l) => { const n = qty.get(String(l.ItemId)) || 0; return n > 0 && n < l.SerialNumbers.length; });
      const buckets = rows.filter((r) => BUCKETS[r.ItemId] && r.ScannedQuantity > 0);
      const serialsOf = async (itemId) => { const j = await AE.api('GET', base(id) + '/' + encodeURIComponent(itemId) + '/serial'); return (j && j.ScannedSerialNumbers) || []; };
      const fetched = new Map(await pool([...partial.map((l) => String(l.ItemId)), ...buckets.map((r) => r.ItemId)], 4, async (itemId) => [itemId, await serialsOf(itemId)]));
      const missing = [];
      for (const l of lines) {
        const n = qty.get(String(l.ItemId)) || 0;
        let miss;
        if (n === 0) miss = l.SerialNumbers.slice();
        else if (n >= l.SerialNumbers.length) miss = [];
        else { const got = new Set(fetched.get(String(l.ItemId)).map((s) => s.SerialNumber)); miss = l.SerialNumbers.filter((s) => !got.has(s)); }
        if (miss.length) missing.push({ itemId: String(l.ItemId), name: l.ItemName, group: l.ItemGroup, expected: l.SerialNumbers.length, missing: miss.sort() });
      }
      missing.sort((a, b) => b.missing.length - a.missing.length || a.name.localeCompare(b.name));
      const unexpected = [];
      for (const r of buckets) for (const s of fetched.get(r.ItemId) || []) unexpected.push({ serial: s.SerialNumber, bucket: r.ItemId, by: s.ScannedBy, at: s.ScannedDateTime });
      unexpected.sort((a, b) => a.bucket.localeCompare(b.bucket) || a.serial.localeCompare(b.serial));
      return {
        expected: Number(exp && exp.TotalExpected) || lines.reduce((n, l) => n + l.SerialNumbers.length, 0),
        scanned: rows.reduce((n, r) => n + (Number(r.ScannedQuantity) || 0), 0),
        missingCount: missing.reduce((n, m) => n + m.missing.length, 0),
        missing, unexpected,
      };
    }

    async function load(id, quiet) {
      loadingFor = id;
      if (!quiet || !state || state.id !== id) { state = { id, status: 'loading' }; render(); }
      try {
        const data = await compute(id);
        if (loadingFor !== id) return;
        state = { id, status: 'ready', data, at: Date.now() };
      } catch (e) {
        if (loadingFor !== id) return;
        state = { id, status: 'error', error: e.message || String(e), at: Date.now() };
      }
      render();
    }

    function render() {
      const id = countId();
      let pill = document.getElementById(PILL_ID);
      if (!id || !state) { pill?.remove(); document.getElementById(PANEL_ID)?.remove(); return; }
      if (!pill) { pill = h('button', { type: 'button', id: PILL_ID, class: 'sg', onclick: togglePanel }); document.body.appendChild(pill); }
      const s = state;
      const key = s.status + (s.data ? s.data.missingCount + '/' + s.data.unexpected.length : '');
      if (pill.dataset.key !== key) {
        pill.dataset.key = key;
        pill.replaceChildren(h('span', { html: AE.actionIcon('countCheck', 28) }), 'Missing serials',
          s.status === 'loading' ? h('span', { class: 'sg-spin' })
            : s.status === 'error' ? h('span', { class: 'n', title: s.error }, '!')
              : h('span', { class: 'n' + (s.data.missingCount ? '' : ' zero') }, s.data.missingCount ? s.data.missingCount.toLocaleString() : '✓'));
        pill.title = 'Lay of the Land: expected serials not scanned yet' + (s.status === 'ready' ? ' (' + s.data.missingCount + ' missing, ' + s.data.unexpected.length + ' unexpected)' : '');
      }
      const panel = document.getElementById(PANEL_ID);
      const dataKey = s.status + '|' + (s.at || '');
      if (panel && panel.dataset.dataKey !== dataKey) renderPanel(); // not every second: that reset the scroll
    }

    function togglePanel(e) {
      e && e.stopPropagation();
      const p = document.getElementById(PANEL_ID);
      if (p) { p.remove(); return; }
      AE.track('countCheck:open');
      renderPanel();
    }

    const copy = async (text, what) => {
      try { await navigator.clipboard.writeText(text); AE.toast('Copied', what, 'ok', 2500); }
      catch (_) { AE.toast("Couldn't copy", 'Your browser blocked the clipboard.', 'err'); }
    };
    function download(d, id) {
      const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
      const lines = [['Status', 'Serial', 'Item ID', 'Item', 'Group', 'Scanned by', 'Scanned at'].join(',')];
      for (const m of d.missing) for (const s of m.missing) lines.push(['Missing', s, m.itemId, m.name, m.group, '', ''].map(q).join(','));
      for (const u of d.unexpected) lines.push(['Unexpected: ' + BUCKETS[u.bucket], u.serial, '', '', '', u.by, u.at].map(q).join(','));
      const a = h('a', { href: URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })), download: id + '-variance.csv' });
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }

    const CHEV = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6"/></svg>';
    // A collapsible entry: click the header to show/hide its serials (toggled in place, no redraw).
    function entry(key, title, meta, serials) {
      const el = h('div', { class: 'item' + (open.has(key) ? ' open' : '') },
        h('div', { class: 't', role: 'button', tabindex: '0', 'aria-expanded': String(open.has(key)) }, h('span', { html: CHEV, style: 'line-height:0' }), ...title, meta),
        h('div', { class: 'serials' }, serials));
      const head = el.firstChild;
      const flip = () => { const on = el.classList.toggle('open'); head.setAttribute('aria-expanded', String(on)); on ? open.add(key) : open.delete(key); };
      head.onclick = flip;
      head.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } };
      return el;
    }

    function renderPanel() {
      const id = countId();
      let p = document.getElementById(PANEL_ID);
      if (!p) { p = h('div', { id: PANEL_ID, class: 'sg sg-card', role: 'dialog', 'aria-label': 'Missing serials' }); document.body.appendChild(p); }
      const s = state;
      p.dataset.dataKey = s.status + '|' + (s.at || '');
      const scroll = p.querySelector('.list') ? p.querySelector('.list').scrollTop : 0; // keep your place across redraws
      const focused = document.activeElement && p.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
      const head = h('div', { class: 'head' }, h('span', { html: AE.actionIcon('countCheck', 26) }),
        h('b', null, 'Lay of the Land ', h('span', { class: 'sub' }, id + (s.at ? ' · updated ' + new Date(s.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''))),
        h('button', { type: 'button', class: 'sg-btn', style: 'height:30px;font-size:13px', onclick: () => load(id) }, 'Refresh'),
        h('button', { type: 'button', class: 'sg-x', title: 'Close', onclick: () => p.remove() }, '✕'));
      if (s.status !== 'ready') {
        p.replaceChildren(head, h('div', { class: 'sg-soft', style: 'padding:10px 0' }, s.status === 'loading' ? 'Comparing expected and scanned serials…' : "Couldn't load this count: " + s.error));
        return;
      }
      const d = s.data;
      const stat = (k, v, bad) => h('div', { class: 'stat' + (bad ? ' bad' : '') }, h('div', { class: 'v' }, v.toLocaleString()), h('div', { class: 'k' }, k));
      const q = query.trim().toLowerCase();
      const hit = (...xs) => !q || xs.some((x) => String(x || '').toLowerCase().includes(q));
      const search = h('input', { type: 'search', placeholder: 'Search serial or item', value: query, oninput: (e) => { query = e.target.value; renderPanel(); } });
      const tabBtn = (t, label, n) => h('button', { type: 'button', class: 'tab' + (tab === t ? ' on' : ''), onclick: () => { tab = t; renderPanel(); p.querySelector('.list').scrollTop = 0; } }, label + ' (' + n.toLocaleString() + ')');
      const serialBtn = (x, title) => h('button', { type: 'button', title: title || 'Copy', onclick: () => copy(x, x) }, x);
      const setAll = (keys, on) => { keys.forEach((k) => (on ? open.add(k) : open.delete(k))); renderPanel(); };

      let controls = null, list, shownMissing = [];
      if (tab === 'missing') {
        // Categories (Portal's item groups), with how many serials each is missing.
        const byCat = new Map();
        for (const m of d.missing) byCat.set(m.group || 'Other', (byCat.get(m.group || 'Other') || 0) + m.missing.length);
        const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
        if (cat !== 'all' && !byCat.has(cat)) cat = 'all';
        const items = d.missing
          .filter((m) => cat === 'all' || (m.group || 'Other') === cat)
          .map((m) => ({ ...m, shown: hit(m.name, m.itemId, m.group) ? m.missing : m.missing.filter((x) => hit(x)) }))
          .filter((m) => m.shown.length)
          .sort(sortBy === 'name' ? (a, b) => a.name.localeCompare(b.name)
            : sortBy === 'category' ? (a, b) => (a.group || '').localeCompare(b.group || '') || b.missing.length - a.missing.length || a.name.localeCompare(b.name)
              : (a, b) => b.missing.length - a.missing.length || a.name.localeCompare(b.name));
        shownMissing = items.flatMap((m) => m.shown);
        const keys = items.map((m) => 'item:' + m.itemId);
        const anyClosed = keys.some((k) => !open.has(k));
        const sortSel = h('select', { 'aria-label': 'Sort', onchange: (e) => { sortBy = e.target.value; renderPanel(); } },
          [['missing', 'Most missing first'], ['name', 'Item name A–Z'], ['category', 'By category']].map(([v, l]) => { const o = h('option', { value: v }, l); o.selected = v === sortBy; return o; }));
        controls = h('div', { class: 'cats' },
          h('button', { type: 'button', class: 'cat' + (cat === 'all' ? ' on' : ''), onclick: () => { cat = 'all'; renderPanel(); } }, 'All ' + d.missingCount.toLocaleString()),
          cats.map(([c, n]) => h('button', { type: 'button', class: 'cat' + (cat === c ? ' on' : ''), onclick: () => { cat = cat === c ? 'all' : c; renderPanel(); p.querySelector('.list').scrollTop = 0; } }, c + ' ' + n.toLocaleString())),
          sortSel,
          h('button', { type: 'button', class: 'sg-btn', onclick: () => setAll(keys, anyClosed) }, anyClosed ? 'Expand all' : 'Collapse all'));
        const rows = [];
        let lastGroup = null;
        for (const m of items) {
          if (sortBy === 'category' && m.group !== lastGroup) { lastGroup = m.group; rows.push(h('div', { class: 'section' }, (m.group || 'Other') + ' · ' + (byCat.get(m.group || 'Other') || 0) + ' missing')); }
          rows.push(entry('item:' + m.itemId, [h('b', null, m.name), h('span', { class: 'grp' }, m.group)],
            h('span', { class: 'q' }, (m.missing.length === m.expected ? 'all ' + m.expected : m.missing.length + ' of ' + m.expected) + ' missing'),
            m.shown.map((x) => serialBtn(x))));
        }
        list = rows.length ? rows : [h('div', { class: 'sg-soft', style: 'padding:10px 0' }, d.missing.length ? 'Nothing matches.' : 'Every expected serial has been scanned.')];
      } else {
        const rows = d.unexpected.filter((u) => hit(u.serial, BUCKETS[u.bucket], u.by));
        const groups = Object.keys(BUCKETS).map((b) => [b, rows.filter((u) => u.bucket === b)]).filter(([, r]) => r.length);
        const keys = groups.map(([b]) => 'bucket:' + b);
        const anyClosed = keys.some((k) => !open.has(k));
        controls = groups.length ? h('div', { class: 'cats' }, h('span', { class: 'sg-soft', style: 'flex:1' }, 'Scans Portal didn\'t match to an expected serial.'),
          h('button', { type: 'button', class: 'sg-btn', onclick: () => setAll(keys, anyClosed) }, anyClosed ? 'Expand all' : 'Collapse all')) : null;
        list = groups.length ? groups.map(([b, r]) => entry('bucket:' + b, [h('b', null, BUCKETS[b])], h('span', { class: 'q' }, r.length + ' scan' + (r.length === 1 ? '' : 's')),
          r.map((u) => serialBtn(u.serial, 'Scanned by ' + (u.by || '?') + (u.at ? ', ' + new Date(u.at).toLocaleString() : '') + ' — click to copy'))))
          : [h('div', { class: 'sg-soft', style: 'padding:10px 0' }, d.unexpected.length ? 'Nothing matches.' : 'No unexpected scans.')];
      }
      const listEl = h('div', { class: 'list' }, list);
      p.replaceChildren(head,
        h('div', { class: 'stats' }, stat('Expected', d.expected), stat('Scanned', d.scanned), stat('Missing', d.missingCount, d.missingCount > 0), stat('Unexpected', d.unexpected.length, d.unexpected.length > 0)),
        h('div', { class: 'tabs' }, tabBtn('missing', 'Missing', d.missingCount), tabBtn('unexpected', 'Unexpected', d.unexpected.length)),
        h('div', { class: 'tools' }, search,
          h('button', { type: 'button', class: 'sg-btn', onclick: () => copy(shownMissing.join('\n'), shownMissing.length + ' missing serials, one per line' + (cat !== 'all' || q ? ' (the ones shown)' : '')) }, 'Copy missing'),
          h('button', { type: 'button', class: 'sg-btn', onclick: () => download(d, id) }, 'Download CSV')),
        controls, listEl,
        h('div', { class: 'foot' }, 'Updates every 2 minutes while this page is open. Click an item to show its serials; click a serial to copy it.'));
      listEl.scrollTop = scroll;
      if (focused) { const inp = p.querySelector('.tools input'); inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    }
    document.addEventListener('click', (e) => {
      const p = document.getElementById(PANEL_ID), path = e.composedPath();
      if (p && !path.includes(p) && !path.includes(document.getElementById(PILL_ID))) p.remove();
    });

    AE.every(1000, () => {
      const id = countId();
      if (!id) { if (state) { state = null; loadingFor = null; render(); } return; }
      if (!state || state.id !== id) { if (loadingFor !== id) load(id); }
      else if (state.status !== 'loading' && Date.now() - state.at > REFRESH_MS && !document.hidden) { state.at = Date.now(); load(id, true); }
      render();
    });
  },
});
