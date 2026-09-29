/*
  Waymark (work-order tags) — shared tags for the whole store, sortable.

  Tags live in the Waymark API (worker/ in this repo: a Cloudflare Worker +
  D1 database), keyed by Portal store ID, with our own history log — no
  Portal notes. Tags on a WO are cleared 7 days after Aethernet sees it
  closed (the Worker's daily job; Aethernet reports closed WOs it notices).

  - On a WO page: tag chips next to the customer name, and "+ Tag" (managed
    tags as toggles, a box for one-off tags, and the WO's tag history).
  - Header button: the board — open WOs grouped by tag, filterable.
  - Settings → Waymark: the store's managed tag list. Only Portal's
    Store Manager / District Manager / Store Owner roles (for the current
    store) can edit it; everyone can tag and add one-offs.

  Trust: the role check happens here, not on the server (it can't see
  Portal logins). Ordinary use is gated; a tampered script isn't. Fine for
  tags. All tag text is shown as plain text.
*/
AE.waymark = (() => {
  const { h } = AE;
  const API = '__WAYMARK_API__';
  const KEY = '__WAYMARK_KEY__';
  const EDITOR_ROLES = ['Store Manager - Corp', 'Store Manager - Franchisee', 'District Manager', 'District Manager - Franchisee', 'Store Owner - Franchisee'];
  const COLORS = { purple: 'var(--aui-primary, #8223d2)', blue: '#4a68f9', teal: '#1592a8', green: '#2f9e5b', lime: '#6f9a12', yellow: '#b38f00', orange: '#d9670f', red: '#d1344b', grey: 'var(--aui-on-surface-soft, #5d5e61)' };
  const TTL = 60 * 1000;
  const configured = () => /^(https:\/\/|http:\/\/localhost[:/])/.test(API); // localhost = a wrangler dev test build

  let cache = null, cacheAt = 0, inflight = null;
  let roleInfo = null;

  async function me() {
    const p = await AE.profile();
    if (!p.storeId) throw new Error('No current store');
    return p;
  }

  async function call(method, path, body) {
    if (!configured()) throw new Error("Waymark isn't set up yet");
    const p = await me();
    const res = await fetch(API + '/v1/' + p.storeId + path, {
      method, credentials: 'omit',
      headers: { 'content-type': 'application/json', 'x-aethernet-key': KEY },
      body: body ? JSON.stringify(Object.assign({ by: p.name, byId: p.userId }, body)) : undefined,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status);
    return j;
  }

  // { list: [{name, color}], tags: { [woId]: [{tag, by, at}] } }, cached for a minute.
  function load(force) {
    if (!force && cache && Date.now() - cacheAt < TTL) return Promise.resolve(cache);
    if (inflight) return inflight;
    inflight = call('GET', '').then((j) => { cache = { list: j.list || [], tags: j.tags || {} }; cacheAt = Date.now(); AE.emit('waymark-changed', cache); return cache; })
      .finally(() => { inflight = null; });
    return inflight;
  }
  const tagsOf = (woId) => (cache && cache.tags[woId]) || [];

  async function setTag(woId, tag, on) {
    if (AE.status.blocked('waymark')) return null;
    const j = await call('POST', '/wo/' + woId + (on ? '/tag' : '/untag'), { tag });
    if (cache) { if (j.tags.length) cache.tags[woId] = j.tags; else delete cache.tags[woId]; }
    AE.emit('waymark-changed', cache);
    return j.tags;
  }
  const history = (woId) => call('GET', '/wo/' + woId + '/history').then((j) => j.history || []);

  async function saveList(list) {
    const j = await call('PUT', '/list', { list });
    if (cache) cache.list = j.list;
    AE.emit('waymark-changed', cache);
    return j.list;
  }

  // Can this user edit the managed list, for the store they're signed into?
  async function canEdit() {
    if (roleInfo) return roleInfo;
    const p = await me();
    let roles = [];
    try {
      const j = await AE.api('GET', '/api/auth/user/stores');
      const stores = Array.isArray(j) ? j : (j && (j.stores || j.data)) || [];
      const here = stores.find((s) => String(s.number ?? s.storeId) === String(p.storeId));
      roles = (here && here.roles) || [];
    } catch (_) { /* no roles = not an editor */ }
    roleInfo = { ok: roles.some((r) => EDITOR_ROLES.includes(r)), roles };
    return roleInfo;
  }

  // Report tagged WOs that are no longer open, so the Worker can clear them 7 days on.
  let lastClosedCheck = 0;
  async function reportClosed() {
    if (Date.now() - lastClosedCheck < 30 * 60 * 1000) return;
    lastClosedCheck = Date.now();
    const c = await load();
    const tagged = Object.keys(c.tags).map(Number);
    if (!tagged.length) return;
    const open = new Set((await AE.data.workorders(Date.now(), 0)).map((r) => Number(r.workorderId)));
    const closed = tagged.filter((id) => !open.has(id));
    if (closed.length) await call('POST', '/closed', { wos: closed });
  }

  // ------------------------------------------------------------ UI bits
  const CSS = `
  .sg-tag { display:inline-flex; align-items:center; gap:4px; height:22px; padding:0 9px; border-radius:10000rem; font:600 12px/1 Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif;
    white-space:nowrap; max-width:220px; overflow:hidden; text-overflow:ellipsis; flex:none;
    color:color-mix(in srgb, var(--c) 78%, var(--aui-on-surface, #1a1c1e)); background:color-mix(in srgb, var(--c) 15%, var(--aui-surface, #fff));
    border:1px solid color-mix(in srgb, var(--c) 45%, transparent); }
  .sg-tag.oneoff { --c:var(--aui-on-surface-soft, #5d5e61); border-style:dashed; background:transparent; font-weight:400; }
  .sg-tag button { border:0; background:none; padding:0 0 0 2px; margin:0; color:inherit; cursor:pointer; font-size:13px; line-height:1; opacity:.7; }
  .sg-tag button:hover { opacity:1; }
  .sg-tag.off { opacity:.55; background:transparent; }
  .sg-tag.toggle { cursor:pointer; }
  #sg-wm-row { display:inline-flex; align-items:center; gap:6px; margin-left:12px; flex-wrap:wrap; align-self:center; }
  #sg-wm-row .add { height:24px; padding:0 10px; font-size:12px; }
  #sg-wm-pop { position:fixed; z-index:2147483646; width:360px; max-height:70vh; overflow:auto; padding:14px 16px; font-size:14px; line-height:1.4; }
  #sg-wm-pop h4 { margin:12px 0 6px; font-size:11px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; color:var(--aui-on-surface-soft, #5d5e61); }
  #sg-wm-pop h4:first-child { margin-top:0; }
  #sg-wm-pop .chips { display:flex; flex-wrap:wrap; gap:6px; }
  #sg-wm-pop input[type=text] { width:100%; height:34px; padding:0 10px; border:1px solid var(--aui-outline, #c6c6ca); border-radius:8px;
    background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e); font:14px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; }
  #sg-wm-pop ol { list-style:none; margin:0; padding:0; font-size:13px; }
  #sg-wm-pop li { padding:4px 0; border-top:1px solid var(--aui-outline-soft, #eeedf1); }
  #sg-wm-pop li:first-child { border-top:0; }
  #sg-wm-pop .when { color:var(--aui-on-surface-soft, #5d5e61); font-size:12px; }
  #sg-wm-btn { display:inline-flex; align-items:center; justify-content:center; width:34px; height:34px; margin-right:8px; padding:0; border:0; border-radius:9px;
    background:none; cursor:pointer; flex:none; }
  #sg-wm-btn:hover { background:var(--aui-neutral-soft, #f1f0f4); }
  #sg-wm-btn .sg-aicon { width:26px; height:26px; }
  #sg-wm-board { position:fixed; z-index:2147483646; right:16px; width:min(560px, calc(100vw - 32px)); max-height:calc(100vh - 100px); display:flex; flex-direction:column;
    padding:16px 16px 10px; font-size:14px; line-height:1.4; }
  #sg-wm-board .head { display:flex; align-items:center; gap:10px; margin-bottom:10px; }
  #sg-wm-board .head b { flex:1; font-size:18px; }
  #sg-wm-board .filters { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px; }
  #sg-wm-board .list { overflow:auto; }
  #sg-wm-board .group { margin-bottom:12px; }
  #sg-wm-board .group > .gh { display:flex; align-items:center; gap:8px; margin:0 0 4px; font-size:12px; color:var(--aui-on-surface-soft, #5d5e61); }
  #sg-wm-board .wo { display:flex; align-items:center; gap:10px; padding:7px 4px; border-top:1px solid var(--aui-outline-soft, #eeedf1); }
  #sg-wm-board .wo > div { flex:1; min-width:0; }
  #sg-wm-board .wo a { color:var(--aui-primary, #8223d2); font-weight:600; text-decoration:none; }
  #sg-wm-board .wo a:hover { text-decoration:underline; }
  #sg-wm-board .wo .meta { font-size:12px; color:var(--aui-on-surface-soft, #5d5e61); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #sg-wm-board .wo .chips { display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-end; max-width:45%; }
  .sg-wm-edit .row { display:flex; align-items:center; gap:6px; margin:6px 0; }
  .sg-wm-edit .row input[type=text] { flex:1; min-width:0; height:32px; padding:0 8px; border:1px solid var(--aui-outline, #c6c6ca); border-radius:8px;
    background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e); font:14px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; }
  .sg-wm-edit select { height:32px; border:1px solid var(--aui-outline, #c6c6ca); border-radius:8px; background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e); }
  .sg-wm-edit .mini { width:28px; height:28px; padding:0; border:1px solid var(--aui-outline-soft, #eeedf1); border-radius:7px; background:none; cursor:pointer; color:var(--aui-on-surface-soft, #5d5e61); }
  .sg-wm-edit .sg-actions { justify-content:flex-start; margin-top:8px; }
  .sg-wm-edit .sg-actions .sg-btn { flex:none; }
  `;
  const ensureCss = () => { AE.ensureCss(); if (!document.getElementById('sg-wm-css')) document.head.append(h('style', { id: 'sg-wm-css' }, CSS)); };

  const colorOf = (name) => { const t = cache && cache.list.find((l) => l.name === name); return t ? t.color : null; };
  // A tag chip. opts.label shows different text (e.g. with a count) but keeps the tag's colour.
  function chip(name, opts = {}) {
    const color = colorOf(name);
    const el = h('span', { class: 'sg-tag' + (color ? '' : ' oneoff') + (opts.cls ? ' ' + opts.cls : ''), style: color ? '--c:' + COLORS[color] : null, title: opts.title || name }, opts.label || name);
    if (opts.onRemove) el.append(h('button', { type: 'button', title: 'Remove ' + name, 'aria-label': 'Remove ' + name, onclick: (e) => { e.stopPropagation(); opts.onRemove(); } }, '×'));
    return el;
  }
  const when = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  const fail = (what, e) => AE.toast('Waymark: ' + what, (e && e.message) || String(e), 'err');

  // ------------------------------------------------------------ Settings → Waymark (managed list)
  function editor() {
    ensureCss();
    const root = h('div', { class: 'sg-wm-edit' }, h('div', { class: 'sg-soft', style: 'margin-top:8px' }, 'Loading tag list…'));
    Promise.all([load(true), canEdit()]).then(([c, role]) => {
      let rows = c.list.map((t) => ({ name: t.name, color: t.color }));
      const draw = () => {
        if (!role.ok) {
          root.replaceChildren(
            h('div', { class: 'sg-soft', style: 'margin-top:8px' }, "Your store's tags. Store managers, district managers and franchise owners can edit this list; anyone can tag work orders and add one-off tags."),
            h('div', { class: 'chips', style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px' }, rows.length ? rows.map((t) => chip(t.name)) : h('span', { class: 'sg-soft' }, 'No tags yet.')));
          return;
        }
        const status = h('span', { class: 'sg-soft' });
        root.replaceChildren(
          h('div', { class: 'sg-soft', style: 'margin-top:8px' }, "Your store's tags, in the order the board shows them. Anyone can still add one-off tags on a work order."),
          ...rows.map((t, i) => h('div', { class: 'row' },
            h('select', { 'aria-label': 'Colour', onchange: (e) => { t.color = e.target.value; draw(); } }, Object.keys(COLORS).map((c) => { const o = h('option', { value: c }, c); o.selected = c === t.color; return o; })),
            chip(t.name || 'Tag'),
            h('input', { type: 'text', value: t.name, maxlength: 32, 'aria-label': 'Tag name', oninput: (e) => { t.name = e.target.value; } , onchange: draw }),
            h('button', { type: 'button', class: 'mini', title: 'Move up', disabled: i === 0, onclick: () => { rows.splice(i - 1, 0, rows.splice(i, 1)[0]); draw(); } }, '↑'),
            h('button', { type: 'button', class: 'mini', title: 'Remove', onclick: () => { rows.splice(i, 1); draw(); } }, '✕'))),
          h('div', { class: 'sg-actions' },
            h('button', { type: 'button', class: 'sg-btn', disabled: rows.length >= 40, onclick: () => { rows.push({ name: '', color: 'purple' }); draw(); root.querySelector('.row:last-of-type input')?.focus(); } }, '+ Add tag'),
            h('button', { type: 'button', class: 'sg-btn sg-primary', onclick: async (e) => {
              e.target.disabled = true; status.textContent = 'Saving…';
              try { rows = (await saveList(rows.filter((t) => t.name.trim()))).map((t) => ({ ...t })); draw(); AE.toast('Waymark', 'Tag list saved for everyone at the store.', 'ok'); }
              catch (err) { status.textContent = ''; e.target.disabled = false; fail("couldn't save the tag list", err); }
            } }, 'Save tag list'),
            status),
          h('div', { class: 'sg-soft', style: 'margin-top:4px' }, 'Saves straight away (not with Save & reload). Removing a tag from the list keeps it on work orders as a one-off.'));
      };
      draw();
    }).catch((e) => root.replaceChildren(h('div', { class: 'sg-soft', style: 'margin-top:8px' }, "Couldn't load the tag list: " + (e.message || e))));
    return root;
  }
  const listSig = () => JSON.stringify(cache && cache.list);
  const summary = () => (cache ? cache.list.length + ' tag' + (cache.list.length === 1 ? '' : 's') : 'Store tags');

  return { API, configured, load, tagsOf, listSig, setTag, history, saveList, canEdit, reportClosed, chip, when, fail, ensureCss, editor, summary, COLORS };
})();

AE.crystal({
  id: 'waymark',
  name: 'Waymark',
  sites: ['portal.ubreakifix.net'],
  run() {
    const { h } = AE;
    const W = AE.waymark;
    if (!W.configured()) return;
    W.ensureCss();
    const ROW_ID = 'sg-wm-row', POP_ID = 'sg-wm-pop', BTN_ID = 'sg-wm-btn', BOARD_ID = 'sg-wm-board';
    const currentWoId = () => { const m = location.pathname.match(/^\/repair\/workorder\/(\d+)/); return m ? m[1] : null; };
    const nameRow = (woId) => {
      const heading = [...document.querySelectorAll('[data-aui="text"]')].find((el) => el.offsetParent && el.textContent.trim().startsWith('Work order #' + woId));
      return heading && heading.parentElement;
    };

    // ---------------------------------------------------- WO page: chips + "+ Tag"
    function renderRow() {
      const woId = currentWoId();
      const anchor = woId && nameRow(woId);
      let row = document.getElementById(ROW_ID);
      if (!anchor) { row?.remove(); return; }
      const key = woId + '|' + JSON.stringify(W.tagsOf(woId)) + '|' + W.listSig(); // redraw when tags or colours change
      if (row && row.dataset.key === key && row.parentElement === anchor) return;
      row?.remove();
      row = h('span', { id: ROW_ID, 'data-key': key },
        W.tagsOf(woId).map((t) => W.chip(t.tag, { title: t.tag + ' · added by ' + (t.by || 'someone') + ', ' + W.when(t.at), onRemove: () => toggle(woId, t.tag, false) })),
        h('button', { type: 'button', class: 'sg-btn add', onclick: (e) => { e.stopPropagation(); togglePop(woId); } }, '+ Tag'));
      anchor.appendChild(row);
    }

    async function toggle(woId, tag, on) {
      try { await W.setTag(woId, tag, on); } catch (e) { W.fail("couldn't update tags", e); }
      renderRow();
      if (document.getElementById(POP_ID)) renderPop(woId);
    }

    function togglePop(woId) {
      if (document.getElementById(POP_ID)) { document.getElementById(POP_ID).remove(); return; }
      renderPop(woId);
    }
    function renderPop(woId) {
      const btn = document.querySelector('#' + ROW_ID + ' .add');
      let pop = document.getElementById(POP_ID);
      if (!pop) { pop = h('div', { id: POP_ID, class: 'sg sg-card', role: 'dialog', 'aria-label': 'Tags for this work order' }); document.body.appendChild(pop); }
      const on = new Set(W.tagsOf(woId).map((t) => t.tag));
      W.load().then((c) => {
        const input = h('input', { type: 'text', placeholder: 'Add a one-off tag, then Enter', maxlength: 32, onkeydown: (e) => {
          if (e.key === 'Enter' && input.value.trim()) { const v = input.value.trim(); input.value = ''; toggle(woId, v, true); }
          if (e.key === 'Escape') pop.remove();
        } });
        const oneoffs = [...on].filter((t) => !c.list.some((l) => l.name === t));
        const hist = h('ol', null, h('li', { class: 'sg-soft' }, 'Loading…'));
        pop.replaceChildren(
          h('h4', null, "Store tags"),
          h('div', { class: 'chips' }, c.list.length ? c.list.map((l) => {
            const el = W.chip(l.name, { cls: 'toggle' + (on.has(l.name) ? '' : ' off'), title: on.has(l.name) ? 'Click to remove' : 'Click to add' });
            el.setAttribute('role', 'button'); el.tabIndex = 0;
            el.onclick = () => toggle(woId, l.name, !on.has(l.name));
            el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.onclick(); } };
            return el;
          }) : h('span', { class: 'sg-soft' }, 'No store tags yet. A manager can add them in Settings → Waymark.')),
          oneoffs.length ? h('h4', null, 'One-off tags') : null,
          oneoffs.length ? h('div', { class: 'chips' }, oneoffs.map((t) => W.chip(t, { onRemove: () => toggle(woId, t, false) }))) : null,
          h('h4', null, 'Add one-off'),
          input,
          h('h4', null, 'History'),
          hist);
        const r = btn && btn.getBoundingClientRect();
        if (r) { pop.style.top = Math.min(r.bottom + 8, innerHeight - pop.offsetHeight - 8) + 'px'; pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)) + 'px'; }
        W.history(woId).then((items) => {
          hist.replaceChildren(...(items.length ? items.map((x) => h('li', null, (x.by || 'Someone') + (x.action === 'add' ? ' added ' : ' removed '), h('b', null, x.tag), ' ', h('span', { class: 'when' }, '· ' + W.when(x.at))))
            : [h('li', { class: 'sg-soft' }, 'No tag changes yet.')]));
        }).catch(() => hist.replaceChildren(h('li', { class: 'sg-soft' }, "Couldn't load history.")));
      }).catch((e) => { pop.replaceChildren(h('div', { class: 'sg-soft' }, "Couldn't load tags: " + (e.message || e))); });
    }
    document.addEventListener('click', (e) => {
      // composedPath: the clicked chip may already be redrawn (detached) by now.
      const pop = document.getElementById(POP_ID), path = e.composedPath();
      if (pop && !path.includes(pop) && !path.includes(document.getElementById(ROW_ID))) pop.remove();
    });

    // ---------------------------------------------------- header button + board
    function renderButton() {
      const anchor = [...document.querySelectorAll('button')].find((x) => x.offsetParent && x.textContent.trim() === 'UBIF support');
      let b = document.getElementById(BTN_ID);
      if (!anchor) { b?.remove(); return; }
      if (!b) b = h('button', { type: 'button', id: BTN_ID, class: 'sg', title: 'Waymark: work orders by tag', 'aria-label': 'Waymark board', html: AE.actionIcon('waymark', 26), onclick: (e) => { e.stopPropagation(); toggleBoard(); } });
      if (b.parentElement !== anchor.parentElement || b.nextSibling !== anchor) anchor.parentElement.insertBefore(b, anchor);
    }

    let boardFilter = null; // tag name, or null = all
    async function toggleBoard() {
      if (document.getElementById(BOARD_ID)) { document.getElementById(BOARD_ID).remove(); return; }
      const header = document.querySelector('.components-header');
      const board = h('div', { id: BOARD_ID, class: 'sg sg-card', role: 'dialog', 'aria-label': 'Waymark board',
        style: 'top:' + Math.round((header ? header.getBoundingClientRect().bottom : 64) + 8) + 'px' },
        h('div', { class: 'head' }, h('span', { html: AE.actionIcon('waymark', 26) }), h('b', null, 'Waymark'),
          h('button', { type: 'button', class: 'sg-x', title: 'Close', onclick: () => board.remove() }, '✕')),
        h('div', { class: 'list' }, h('div', { class: 'sg-soft' }, h('span', { class: 'sg-spin', style: 'display:inline-block;vertical-align:-3px;margin-right:6px' }), 'Loading open work orders…')));
      document.body.appendChild(board);
      try {
        const [c, wos] = await Promise.all([W.load(true), AE.data.workorders(Date.now(), 0)]);
        drawBoard(board, c, wos);
        W.reportClosed().catch(() => {});
      } catch (e) {
        board.querySelector('.list').replaceChildren(h('div', { class: 'sg-soft' }, "Couldn't load: " + (e.message || e)));
      }
    }
    function drawBoard(board, c, wos) {
      const byId = new Map(wos.map((r) => [String(r.workorderId), r]));
      const tagged = Object.entries(c.tags).filter(([id]) => byId.has(String(id)));
      // Groups: managed list order, then one-offs A–Z.
      const names = [...c.list.map((l) => l.name)];
      const oneoffs = new Set();
      tagged.forEach(([, ts]) => ts.forEach((t) => { if (!names.includes(t.tag)) oneoffs.add(t.tag); }));
      names.push(...[...oneoffs].sort((a, b) => a.localeCompare(b)));
      const counts = Object.fromEntries(names.map((n) => [n, tagged.filter(([, ts]) => ts.some((t) => t.tag === n)).length]));
      const shown = names.filter((n) => counts[n] && (!boardFilter || boardFilter === n));
      const woRow = (id, ts) => {
        const r = byId.get(String(id));
        const dev = (r.customerDevice && r.customerDevice.name) || (r.deviceCatalog && r.deviceCatalog.name) || '';
        return h('div', { class: 'wo' },
          h('div', null,
            h('a', { href: '/repair/workorder/' + id }, 'WO ' + id), ' · ', AE.data.nameOf(r) || 'Customer',
            h('div', { class: 'meta' }, [r.workorderStatusName, dev].filter(Boolean).join(' · '))),
          h('div', { class: 'chips' }, ts.map((t) => W.chip(t.tag))));
      };
      const filterChip = (n) => {
        const el = W.chip(n, { label: n + ' (' + counts[n] + ')', cls: 'toggle' + (boardFilter && boardFilter !== n ? ' off' : ''), title: 'Show only ' + n });
        el.onclick = () => { boardFilter = boardFilter === n ? null : n; drawBoard(board, c, wos); };
        return el;
      };
      board.querySelector('.filters')?.remove();
      const filters = h('div', { class: 'filters' }, names.filter((n) => counts[n]).map(filterChip));
      board.querySelector('.head').after(filters);
      board.querySelector('.list').replaceChildren(...(shown.length ? shown.map((n) => {
        const rows = tagged.filter(([, ts]) => ts.some((t) => t.tag === n))
          .sort(([a], [b]) => Date.parse(byId.get(String(a)).createdAt) - Date.parse(byId.get(String(b)).createdAt));
        return h('div', { class: 'group' }, h('div', { class: 'gh' }, W.chip(n), rows.length + ' open'), rows.map(([id, ts]) => woRow(id, ts)));
      }) : [h('div', { class: 'sg-soft', style: 'padding:8px 0' }, c.list.length ? 'No open work orders are tagged yet. Open a work order and use + Tag.' : 'No tags yet. A manager can set up the store list in Settings → Waymark; anyone can add one-off tags from a work order.')]),
        h('div', { class: 'sg-soft', style: 'padding:6px 0 2px' }, ((n) => n + ' open work order' + (n === 1 ? ' has' : 's have') + ' no tags.')(wos.length - tagged.length)));
    }
    document.addEventListener('click', (e) => {
      const b = document.getElementById(BOARD_ID), path = e.composedPath();
      if (b && !path.includes(b) && !path.includes(document.getElementById(BTN_ID))) b.remove();
    });

    AE.on('waymark-changed', () => { renderRow(); });
    W.load().catch(() => {});
    AE.every(1000, () => {
      renderButton();
      if (currentWoId()) { W.load().then(renderRow).catch(() => {}); renderRow(); }
      else { document.getElementById(ROW_ID)?.remove(); document.getElementById(POP_ID)?.remove(); }
    });
    // Clears tags 7 days after close: tell the Worker which tagged WOs have closed.
    setTimeout(() => W.reportClosed().catch(() => {}), 20000);
    setInterval(() => W.reportClosed().catch(() => {}), 30 * 60 * 1000);
  },
});
