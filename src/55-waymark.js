/*
  Waymark (work-order tags) — shared tags for the whole store, sortable.

  Tags live in the Waymark API (worker/ in this repo: a Cloudflare Worker +
  D1 database), keyed by Portal store ID, with our own history log — no
  Portal notes. Tags on a WO are cleared 7 days after Aethernet sees it
  closed (the Worker's daily job; Aethernet reports closed WOs it notices).

  - On a WO page: tag chips next to the customer name, and "+ Tag" (managed
    tags as toggles, a box for one-off tags, and the WO's tag history).
  - Header button: the board — open WOs grouped by tag, filterable.
    Managers (the roles below) get × on each tag there to clear it;
    everyone else removes tags from the WO itself.
  - Auto-Waymark: a follow-up date (its own kind of mark, not a tag; one look
    for both kinds, only the date differs):
      · Ready for pickup (rfp): 3 days after that day, added after end of day
        (7 PM local), or on the first Portal load after that if nobody had
        Portal open then.
      · Awaiting callback and Awaiting device (callback; contact every day):
        added after end of day too, due the next day (a WO the evening scan
        missed is due the same day on the next load). A new rule ships "off" and is
        switched on from the admin panel → Auto-Waymark: Stage (new WOs only)
        then Push (live: the scan backfills WOs already waiting).
    When a WO leaves the status its mark belongs to, the mark is deleted and
    the nickname's date cleared; returning to a marked status starts fresh.
    Moving between Awaiting callback and Awaiting device keeps the mark.
    Right-click pushes it
    later (never earlier); × removes it for good. The board's second tab
    lists them by due date. Found by a scan of Portal's active list every 10
    minutes (one tab per browser does it; the server ignores repeats), and
    when a tech sets the WO they're on to a marked status after 7 PM.
  - The header icon shows how many open Auto-Waymarks are due (today or
    overdue). On their first Portal load of the day, managers get a speech
    bubble from the icon if any were left open past their due day.
  - If the nickname already has a date in it when the mark is made
    ("PS5 SLIM (10/01)"), that date is the mark's date instead.
  - While a WO is in a marked status, its device nickname is just the
    Auto-Waymark date ("10/02", the store's usual M/DD) and is kept that way:
    pushes rewrite it, and the scan puts it back if it drifts. A later date
    typed into the nickname by hand moves the mark to match instead.
  - Texting the customer (calls go with a text) moves the mark to 3 days from
    that day at Ready for pickup, 1 day (tomorrow) at Awaiting callback or device (only
    ever later), credited
    "<name> (texted the customer)". Uses core's text-sent event, so it works
    with Recitation off.
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
  // localhost = a wrangler dev test build (a local Worker + database). The Portal sandbox may use one of those,
  // but never a real Worker.
  const configured = () => (AE_SANDBOX ? /^http:\/\/localhost[:/]/.test(API) : /^(https:\/\/|http:\/\/localhost[:/])/.test(API));

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
    inflight = call('GET', '').then((j) => { cache = { list: j.list || [], tags: j.tags || {}, auto: j.auto || {}, rules: j.rules || {}, removed: j.removed || [], closed: j.closed || [] }; load.cache = cache; cacheAt = Date.now(); AE.emit('waymark-changed', cache); return cache; })
      .finally(() => { inflight = null; });
    return inflight;
  }
  const tagsOf = (woId) => (cache && cache.tags[woId]) || [];

  async function setTag(woId, tag, on) {
    if (AE.status.blocked('waymark')) return null;
    AE.track(on ? 'waymark:tag' : 'waymark:untag');
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

  // ------------------------------------------------------------ Auto-Waymark
  const AUTO_DAYS = 3, RFP_STATUS = 13; // 13 = Ready for pickup
  const CLOSED_STATUSES = [14, 15, 25];   // Sale complete, (closed), Cancelled
  // The Auto-Waymark rules: which statuses, how many days, and whether marks wait for end of day.
  // callback keeps its key (marks in D1 carry it) but covers Awaiting device (4) as well as Awaiting callback (7).
  const RULES = {
    rfp: { statuses: [13], days: 3, eod: true, name: 'Ready for pickup', push: [3, 1, 7] },
    callback: { statuses: [7, 4], days: 1, eod: true, name: 'Awaiting callback or device', push: [1, 3, 7] },
  };
  const kindOfStatus = (st) => Object.keys(RULES).find((k) => RULES[k].statuses.includes(Number(st))) || null;
  const markKind = (m) => (m && m.kind) || 'rfp';
  // rfp is always live; the others: off | staged (WOs that newly enter the status) | live (backfill too), from the admin panel.
  const ruleState = (k, c) => (k === 'rfp' ? { state: 'live' } : ((c || cache || {}).rules || {})[k] || { state: 'off' });
  /*
    A new mark's date. The nickname's date wins. Ready for pickup: 3 days after it got there.
    Daily contact: the next day when marked after 7 PM; marked earlier than that (catching up on
    an evening nobody had Portal open), the same day.
  */
  function newDue(kind, since, nick) {
    const typed = parseNick(nick);
    if (typed) return typed;
    if (kind === 'rfp') return addDays(since, RULES.rfp.days);
    return afterEod() ? addDays(today(), RULES[kind].days) : today();
  }
  const isDateNick = (n) => /^\(?\s*\d{1,2}\/\d{1,2}(\/\d{2,4})?\s*\)?$/.test((n || '').trim());
  const EOD_HOUR = 19;                    // marks go on after end of day, 7 PM local
  const afterEod = () => AE.nowDate().getHours() >= EOD_HOUR; // AE.nowDate: the dev tools can shift it
  const pad = (n) => String(n).padStart(2, '0');
  const isoDate = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); // store-local date
  const parseDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (iso, n) => { const d = parseDate(iso); d.setDate(d.getDate() + n); return isoDate(d); };
  const today = () => isoDate(AE.nowDate());
  const fmtDate = (iso) => parseDate(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const dueState = (iso) => (iso < today() ? 'overdue' : iso === today() ? 'today' : 'upcoming');
  const autoOf = (woId) => (cache && cache.auto && cache.auto[woId]) || null;
  // When did it reach Ready for pickup? The list row's updatedAt is the best
  // hint (a WO sitting at RFP rarely changes); never later than now.
  const rfpSince = (r) => { const t = Date.parse(r.updatedAt); return isoDate(new Date(isNaN(t) ? AE.now() : Math.min(t, AE.now()))); };

  // ---- the WO's device nickname mirrors its Auto-Waymark (M/DD, as the store writes it)
  const nickDate = (iso) => { const d = parseDate(iso); return (d.getMonth() + 1) + '/' + pad(d.getDate()); };
  // The date written in a nickname, anywhere in it ("10/02", "PS5 SLIM (10/01)",
  // "HDMI REPLACEMENT 9/29"; the last one wins) → YYYY-MM-DD in the nearest year, else null.
  function parseNick(name) {
    const found = [...String(name || '').matchAll(/(?:^|[^\d/])(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?(?![\d/])/g)];
    for (const m of found.reverse()) {
      const mo = Number(m[1]) - 1, day = Number(m[2]), now = AE.nowDate();
      const best = [-1, 0, 1].map((dy) => new Date(now.getFullYear() + dy, mo, day))
        .filter((d) => d.getMonth() === mo && d.getDate() === day)
        .sort((a, b) => Math.abs(a - now) - Math.abs(b - now))[0];
      if (best) return isoDate(best);
    }
    return null;
  }
  const woDetail = async (woId) => { const j = await AE.api('GET', '/api/workorder/' + woId); return (j && j.workorder) || AE.unwrap(j); };
  // Set the nickname to the mark's date, only while the WO is in its mark's status.
  // Sends the device record back unchanged apart from `name`, as Portal's own edit does.
  async function syncNickname(woId, due, wo) {
    wo = wo || await woDetail(woId);
    const dev = wo && wo.CustomerDevice;
    if (!dev || !dev.customerDeviceId || !kindOfStatus(wo.workorderStatusId)) return false;
    const name = nickDate(due);
    if ((dev.name || '').trim() === name) return false;
    await AE.api('PUT', '/api/customer-devices/' + dev.customerDeviceId, {
      customerDeviceId: dev.customerDeviceId, customerId: dev.customerId, passcode: dev.passcode, serial: dev.serial,
      imei: dev.imei, deviceCatalogId: dev.deviceCatalogId, name,
    });
    if (location.pathname.indexOf('/repair/workorder/' + woId) === 0) AE.refreshView(); // show the new nickname
    return true;
  }

  // The WO left its mark's status: delete the mark and clear a date-only nickname (it starts fresh if it comes back).
  async function endMark(woId, reason, wo) {
    await call('POST', '/wo/' + woId + '/end', { reason });
    if (cache) { delete cache.auto[woId]; AE.emit('waymark-changed', cache); }
    wo = wo || await woDetail(woId);
    const dev = wo && wo.CustomerDevice;
    if (dev && dev.customerDeviceId && isDateNick(dev.name) && !kindOfStatus(wo.workorderStatusId)) {
      await AE.api('PUT', '/api/customer-devices/' + dev.customerDeviceId, {
        customerDeviceId: dev.customerDeviceId, customerId: dev.customerId, passcode: dev.passcode, serial: dev.serial,
        imei: dev.imei, deviceCatalogId: dev.deviceCatalogId, name: '',
      });
      if (location.pathname.indexOf('/repair/workorder/' + woId) === 0) AE.refreshView();
    }
  }

  // opts.by: who it's credited to in the history; opts.why: start of the toast (e.g. "Customer texted").
  async function pushMark(woId, due, opts = {}) {
    if (AE.status.blocked('waymark')) return;
    const j = await call('POST', '/wo/' + woId + '/push', opts.by ? { due, by: opts.by } : { due });
    AE.track(opts.track || 'waymark:push');
    if (cache) cache.auto[woId] = Object.assign({}, cache.auto[woId], { due: j.auto.due });
    AE.emit('waymark-changed', cache);
    const lead = opts.why ? opts.why + ': Auto-Waymark moved to ' : 'Moved to ';
    try {
      if (await syncNickname(woId, j.auto.due)) AE.toast('Auto-Waymark', lead + fmtDate(j.auto.due) + '; nickname is now ' + nickDate(j.auto.due) + '.', 'ok');
      else if (opts.why) AE.toast('Auto-Waymark', lead + fmtDate(j.auto.due) + '.', 'ok');
    } catch (e) { fail('mark moved, but the nickname couldn\'t be updated', e); }
  }

  // A text to the customer restarts the follow-up: the mark moves to its rule's days from today
  // (3 at Ready for pickup, 1 at Awaiting callback or device), never earlier than it already is.
  async function customerTexted(woId) {
    if (!configured() || AE.status.blocked('waymark')) return;
    const c = await load(true);
    const m = c.auto && c.auto[woId];
    if (!m) return;
    const kind = markKind(m), due = addDays(today(), RULES[kind].days);
    if (due <= m.due) return;
    const wo = await woDetail(woId);
    if (!wo || kindOfStatus(wo.workorderStatusId) !== kind) return;
    const p = await me();
    await pushMark(woId, due, { by: (p.name || 'Someone') + ' (texted the customer)', why: 'Customer texted', track: 'waymark:pushTexted' });
  }

  // Right after a tech changes this WO's status (seen from the WO page).
  async function checkWo(woId) {
    if (!configured() || AE.status.paused('waymark')) return;
    let [c, wo] = await Promise.all([load(true), woDetail(woId)]);
    if (!wo) return;
    const kind = kindOfStatus(wo.workorderStatusId);
    let m = c.auto[woId];
    if (m && markKind(m) !== kind) { await endMark(woId, 'left ' + RULES[markKind(m)].name, wo); m = null; wo = await woDetail(woId); }
    if (!kind || ruleState(kind, c).state === 'off') return; // staged: this WO is newly entering, so it counts
    if (!m) {
      if (RULES[kind].eod && !afterEod()) return; // the evening scan (or tomorrow's first load) marks it
      const due = newDue(kind, today(), wo.CustomerDevice && wo.CustomerDevice.name);
      const r = await call('POST', '/auto', { marks: [{ wo: Number(woId), due, kind }] });
      if (!(r.created && r.created.length)) return; // removed earlier with ×: stays removed
      await load(true);
      m = autoOf(woId);
    }
    if (m && await syncNickname(woId, m.due, wo)) AE.toast('Auto-Waymark', 'Follow up by ' + fmtDate(m.due) + '; nickname set to ' + nickDate(m.due) + '.', 'ok');
  }
  async function unmark(woId) {
    if (AE.status.blocked('waymark')) return;
    await call('POST', '/wo/' + woId + '/unmark', {});
    AE.track('waymark:unmark');
    if (cache) delete cache.auto[woId];
    AE.emit('waymark-changed', cache);
  }

  /*
    One pass over Portal's active list: Auto-Waymark WOs at Ready for pickup,
    and report tagged/marked WOs that have closed (cleared 7 days later).
    Every 10 minutes; tabs share a timestamp so only one does it. The board
    passes the list it just loaded.
  */
  const SCAN_KEY = 'ae_wm_scan_at', SCAN_MS = 10 * 60 * 1000;
  const OPEN_KEY = 'ae_wm_open'; // last active-list WO ids (shared across tabs), so counts skip closed WOs

  // Open Auto-Waymarks due today or earlier (for the header badge).
  function dueMarks() {
    if (!cache) return [];
    const o = GM_getValue(OPEN_KEY, null);
    const open = o && Date.now() - o.at < 30 * 60 * 1000 ? new Set(o.ids) : null;
    return Object.entries(cache.auto).filter(([id, m]) => m.due <= today() && (!open || open.has(Number(id))));
  }
  /*
    What a scan would do, as a plan: marks to create, marks that follow a later
    date typed into the nickname, nicknames to rewrite, and WOs waiting for 7 PM.
    The real scan carries it out; the dev tools' dry run just shows it.
    noCreate: plan against existing marks only (after creating, when the
    server may have ignored marks that were removed with ×).
  */
  function planScan(rows, c, noCreate) {
    const plan = { create: [], follow: [], rename: [], waiting: [], end: [] };
    const removed = new Map((c.removed || []).map((x) => (typeof x === 'object' ? [Number(x.wo), x.kind || 'rfp'] : [Number(x), null])));
    for (const r of rows) {
      const wo = Number(r.workorderId), nick = ((r.customerDevice && r.customerDevice.name) || '').trim();
      const kind = kindOfStatus(r.workorderStatusId);
      // Left the status its mark belongs to (or one removed with × in another status): the mark ends.
      if ((c.auto[wo] && markKind(c.auto[wo]) !== kind) || (removed.has(wo) && removed.get(wo) !== kind)) {
        plan.end.push({ wo, from: c.auto[wo] ? markKind(c.auto[wo]) : removed.get(wo), nick, clearNick: !kind && isDateNick(nick) });
        continue;
      }
      if (!kind) continue;
      const rule = RULES[kind], st = ruleState(kind, c);
      let due = c.auto[wo] && c.auto[wo].due;
      if (!due) {
        if (noCreate || st.state === 'off' || removed.has(wo)) continue;
        if (st.state === 'staged' && !(Date.parse(r.updatedAt) >= Date.parse(st.stagedAt))) continue; // staged: only WOs that entered since
        if (rule.eod && !(afterEod() || rfpSince(r) < today())) { plan.waiting.push({ wo, rfp: rfpSince(r), nick }); continue; } // today's arrivals wait for 7 PM
        due = newDue(kind, rfpSince(r), nick);
        plan.create.push({ wo, due, kind, nick, from: parseNick(nick) ? 'nickname' : rule.name + ' + ' + rule.days });
      }
      if (nick === nickDate(due)) continue;
      const typed = parseNick(nick);
      if (typed && typed > due) { plan.follow.push({ wo, from: due, to: typed }); due = typed; } // a later date typed by hand: the mark follows
      if (nick !== nickDate(due)) plan.rename.push({ wo, from: nick, to: nickDate(due), due });
    }
    return plan;
  }

  // Admin panel → Auto-Waymark: what making the not-yet-live rules live would add at this store (backfill).
  async function backfillPreview() {
    const [rows, c] = await Promise.all([AE.data.workorders(Date.now(), 0), load(true)]);
    const removed = new Set((c.removed || []).map((x) => Number(typeof x === 'object' ? x.wo : x)));
    const out = [];
    for (const r of rows) {
      const kind = kindOfStatus(r.workorderStatusId), wo = Number(r.workorderId);
      if (!kind || kind === 'rfp' || ruleState(kind, c).state === 'live' || c.auto[wo] || removed.has(wo)) continue;
      const nick = ((r.customerDevice && r.customerDevice.name) || '').trim(), since = rfpSince(r);
      out.push({ wo, kind, name: AE.data.nameOf(r), since, due: newDue(kind, since, nick) });
    }
    return out.sort((a, b) => a.since.localeCompare(b.since));
  }

  async function scan(rows, opts = {}) {
    if (!rows) {
      if (!opts.force && Date.now() - GM_getValue(SCAN_KEY, 0) < SCAN_MS - 30000) return null;
      GM_setValue(SCAN_KEY, Date.now());
      rows = await AE.data.workorders(Date.now(), 0);
    }
    GM_setValue(OPEN_KEY, { at: Date.now(), ids: rows.map((r) => Number(r.workorderId)) });
    let c = await load(true);
    let plan = planScan(rows, c);
    if (opts.dryRun) return Object.assign(plan, { rows });
    if (!AE.status.paused('waymark')) {
      for (const e of plan.end) {
        try {
          const reason = 'left ' + (RULES[e.from] || RULES.rfp).name;
          if (e.clearNick) await endMark(e.wo, reason); // also clears the date-only nickname
          else await call('POST', '/wo/' + e.wo + '/end', { reason });
        } catch (err) { console.warn('[' + AE_NAME + '] Waymark end, WO ' + e.wo + ':', err.message || err); }
      }
      if (plan.end.length) { c = await load(true); plan = Object.assign(planScan(rows, c), { end: plan.end }); }
      if (plan.create.length) {
        const j = await call('POST', '/auto', { marks: plan.create.map(({ wo, due, kind }) => ({ wo, due, kind })) }); // removed ones are ignored
        if (j.created && j.created.length) c = await load(true);
        plan = planScan(rows, c, true);
      }
      for (const f of plan.follow) {
        try { await call('POST', '/wo/' + f.wo + '/push', { due: f.to, by: 'Nickname edit' }); } catch (e) { console.warn('[' + AE_NAME + '] Waymark follow, WO ' + f.wo + ':', e.message || e); }
      }
      for (const r of plan.rename) {
        try { await syncNickname(r.wo, r.due); } catch (e) { console.warn('[' + AE_NAME + '] Waymark nickname sync, WO ' + r.wo + ':', e.message || e); }
      }
    }
    /*
      Closed WOs (their tags and marks are cleared 7 days later). Missing from the active list
      isn't enough: a short or failed list once reported 14 open WOs closed at once (Sep 30 and
      Oct 3, 2026). So each one is checked in Portal first, and only Sale complete / Cancelled
      (or gone) counts. And WOs recorded as closed that are in the active list are reopened.
    */
    const open = new Set(rows.map((r) => Number(r.workorderId)));
    const reopen = (c.closed || []).map(Number).filter((id) => open.has(id));
    if (reopen.length) await call('POST', '/open', { wos: reopen });
    const recorded = new Set((c.closed || []).map(Number));
    const known = [...new Set([...Object.keys(c.tags), ...Object.keys(c.auto)].map(Number))];
    const missing = rows.length ? known.filter((id) => !open.has(id) && !recorded.has(id)).slice(0, 25) : [];
    const closed = [];
    for (const id of missing) {
      try {
        const wo = await woDetail(id);
        if (wo && CLOSED_STATUSES.includes(Number(wo.workorderStatusId))) closed.push(id); // only a clear "closed" from Portal counts
      } catch (e) { if (/HTTP 404/.test(e.message || '')) closed.push(id); }
    }
    if (closed.length) await call('POST', '/closed', { wos: closed });
    return Object.assign(plan, { reopened: reopen, closed });
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
  #sg-wm-btn { position:relative; }
  #sg-wm-btn .badge { position:absolute; top:-3px; right:-4px; min-width:18px; height:18px; padding:0 5px; border-radius:10000rem; box-sizing:border-box;
    background:#d1344b; color:#fff; border:2px solid var(--aui-elevated-level-01, #fff); font:700 11px/14px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; text-align:center; }
  #sg-wm-bubble { position:fixed; z-index:2147483646; width:300px; padding:14px 14px 12px; font-size:14px; line-height:1.45; animation:sg-in .25s ease-out;
    border-color:#d1344b; box-shadow:0 10px 30px rgba(12,14,17,.25); }
  #sg-wm-bubble .top { display:flex; gap:10px; align-items:flex-start; }
  #sg-wm-bubble .top .n { flex:none; min-width:26px; height:26px; padding:0 7px; border-radius:10000rem; background:#d1344b; color:#fff; font:700 14px/26px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; text-align:center; box-sizing:border-box; }
  #sg-wm-bubble .sg-actions { margin-top:10px; justify-content:flex-end; }
  #sg-wm-bubble .sg-actions .sg-btn { flex:none; }
  #sg-wm-bubble .tail { position:absolute; top:-8px; width:14px; height:14px; background:inherit; border:1px solid #d1344b; border-width:1px 0 0 1px; transform:rotate(45deg); }
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
  .sg-auto { display:inline-flex; align-items:center; gap:4px; height:22px; padding:0 3px 0 6px; border-radius:6px; flex:none; cursor:context-menu;
    font:700 12px/1 Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; white-space:nowrap;
    color:color-mix(in srgb, var(--c) 80%, var(--aui-on-surface, #1a1c1e)); background:color-mix(in srgb, var(--c) 14%, var(--aui-surface, #fff));
    border:1px solid color-mix(in srgb, var(--c) 55%, transparent); }
  .sg-auto svg { width:13px; height:13px; flex:none; }
  .sg-auto.upcoming { --c:#4a68f9; }
  .sg-auto.today { --c:#b38f00; background:color-mix(in srgb, var(--c) 28%, var(--aui-surface, #fff)); }
  .sg-auto.overdue { --c:#d1344b; background:#d1344b; color:#fff; border-color:#d1344b; }
  .sg-auto button { border:0; background:none; padding:0 2px; margin:0; color:inherit; cursor:pointer; font-size:13px; line-height:1; opacity:.75; }
  .sg-auto button:hover { opacity:1; }
  #sg-wm-push { position:fixed; z-index:2147483647; width:230px; padding:8px; font-size:13px; }
  #sg-wm-push .ttl { padding:4px 8px 6px; font-size:11px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; color:var(--aui-on-surface-soft, #5d5e61); }
  #sg-wm-push .opt { display:flex; justify-content:space-between; width:100%; padding:7px 8px; border:0; border-radius:6px; background:none; cursor:pointer;
    color:var(--aui-on-surface, #1a1c1e); font:400 13px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; text-align:left; }
  #sg-wm-push .opt.def { background:var(--aui-primary-soft, #faecff); font-weight:700; }
  #sg-wm-push .opt:hover, #sg-wm-push .opt:focus-visible { background:var(--aui-neutral-soft, #f1f0f4); outline:0; }
  #sg-wm-push .pick { display:flex; gap:6px; padding:6px 8px 2px; border-top:1px solid var(--aui-outline-soft, #eeedf1); margin-top:4px; }
  #sg-wm-push .pick input { flex:1; min-width:0; height:30px; border:1px solid var(--aui-outline, #c6c6ca); border-radius:6px; background:var(--aui-surface, #fff);
    color:var(--aui-on-surface, #1a1c1e); font:13px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; color-scheme:light dark; }
  #sg-wm-push .pick .sg-btn { height:30px; padding:0 10px; font-size:13px; }
  #sg-wm-board .tabs { display:flex; gap:2px; margin:0 0 10px; border-bottom:1px solid var(--aui-outline-soft, #eeedf1); }
  #sg-wm-board .tab { padding:6px 10px 7px; border:0; border-bottom:2px solid transparent; margin-bottom:-1px; background:none; cursor:pointer;
    color:var(--aui-on-surface-soft, #5d5e61); font:600 13px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; }
  #sg-wm-board .tab.on { color:var(--aui-primary, #8223d2); border-bottom-color:var(--aui-primary, #8223d2); }
  #sg-wm-board .tab .n { margin-left:4px; font-weight:400; }
  #sg-wm-board .tab .late { margin-left:4px; padding:0 5px; border-radius:10000rem; background:#d1344b; color:#fff; font-size:11px; }
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
  // Errors: plain words for staff; the error itself only goes with the bug report.
  const bug = (what, e) => ({ where: 'Waymark', error: what + ': ' + ((e && e.message) || String(e)) });
  const reportEl = (what, e) => [' If you keep seeing this, ', AE.bugLinkEl('report a bug', bug(what, e)), '!'];
  const fail = (what, e) => AE.toast('Waymark: ' + what, { html: 'If you keep seeing this, ' + AE.bugLink('report a bug', bug(what, e)) + '!' }, 'err');

  const CAL_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 2h2v2h6V2h2v2h2a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2V2zM5 9v10h14V9H5z"/></svg>';

  // The Auto-Waymark chip: blue ahead of time, amber on the day, red once overdue.
  function autoChip(woId, mark, onChange) {
    const st = dueState(mark.due);
    const label = (st === 'today' ? 'Today · ' : st === 'overdue' ? 'Overdue · ' : '') + fmtDate(mark.due);
    const el = h('span', { class: 'sg-auto ' + st, role: 'note',
      title: 'Auto-Waymark: follow up by ' + fmtDate(mark.due) + ' (set when it reached ' + (RULES[markKind(mark)] || RULES.rfp).name + '). Right-click to push it later; × removes it.' },
      h('span', { html: CAL_SVG, style: 'line-height:0' }), label,
      h('button', { type: 'button', title: 'Remove this Auto-Waymark', 'aria-label': 'Remove Auto-Waymark', onclick: async (e) => {
        e.stopPropagation();
        try { await unmark(woId); } catch (err) { fail("couldn't remove the Auto-Waymark", err); }
        onChange && onChange();
      } }, '×'));
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); pushMenu(e.clientX, e.clientY, woId, mark.due, onChange, markKind(mark)); });
    return el;
  }

  // Right-click menu: only ever later.
  function pushMenu(x, y, woId, due, onChange, kind) {
    document.getElementById('sg-wm-push')?.remove();
    ensureCss();
    const go = async (next) => {
      menu.remove();
      try { await pushMark(woId, next); } catch (e) { fail("couldn't move the Auto-Waymark", e); }
      onChange && onChange();
    };
    // First option = the rule's own step (+1 day for Awaiting callback or device, +3 for Ready for pickup), highlighted.
    const opt = (label, days, first) => { const d = addDays(due, days); return h('button', { type: 'button', class: 'opt' + (first ? ' def' : ''), role: 'menuitem', onclick: () => go(d) }, label, h('span', { class: 'sg-soft' }, fmtDate(d))); };
    const LABEL = { 1: '+1 day', 3: '+3 days', 7: '+1 week' };
    const pick = h('input', { type: 'date', min: addDays(due, 1), value: addDays(due, 1), 'aria-label': 'Pick a later date' });
    const menu = h('div', { id: 'sg-wm-push', class: 'sg sg-card', role: 'menu', 'aria-label': 'Push Auto-Waymark later' },
      h('div', { class: 'ttl' }, 'Push later · now ' + fmtDate(due)),
      ...(RULES[kind] || RULES.rfp).push.map((d, i) => opt(LABEL[d], d, i === 0)),
      h('div', { class: 'pick' }, pick, h('button', { type: 'button', class: 'sg-btn', onclick: () => { if (pick.value && pick.value > due) go(pick.value); } }, 'Set')));
    document.body.appendChild(menu);
    menu.style.left = Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8)) + 'px';
    menu.querySelector('.opt').focus();
    const close = (e) => {
      if (e.type === 'keydown' ? e.key !== 'Escape' : e.composedPath().includes(menu)) return;
      menu.remove(); document.removeEventListener('mousedown', close, true); document.removeEventListener('keydown', close, true);
    };
    setTimeout(() => { document.addEventListener('mousedown', close, true); document.addEventListener('keydown', close, true); }, 0);
  }

  // History line for any Waymark event.
  function historyLine(x) {
    const who = x.by || 'Someone';
    const dates = (d) => String(d || '').split(' → ').map((v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? fmtDate(v) : v)).join(' → ');
    const parts = {
      add: [who + ' added ', x.tag], remove: [who + ' removed ', x.tag],
      auto: ['Auto-Waymark set for ', dates(x.detail)],
      push: [who + ' pushed the Auto-Waymark ', dates(x.detail)],
      unmark: [who + ' removed the Auto-Waymark ', dates(x.detail)],
      'auto-end': ['Auto-Waymark ended: ', dates(x.detail)],
    }[x.action] || [who + ' ' + x.action + ' ', x.tag || x.detail || ''];
    return h('li', null, parts[0], h('b', null, parts[1]), ' ', h('span', { class: 'when' }, '· ' + when(x.at)));
  }

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
    }).catch((e) => root.replaceChildren(h('div', { class: 'sg-soft', style: 'margin-top:8px' }, "Couldn't load the tag list.", ...reportEl('Loading the tag list', e))));
    return root;
  }
  const listSig = () => JSON.stringify(cache && cache.list);
  const summary = () => (cache ? cache.list.length + ' tag' + (cache.list.length === 1 ? '' : 's') : 'Store tags');

  return { reportEl, API, configured, call, load, RULES, ruleState, backfillPreview, tagsOf, autoOf, checkWo, customerTexted, dueMarks, today, OPEN_KEY, planScan, fmtDate, nickDate, parseNick, listSig, setTag, history, saveList, canEdit, scan, chip, autoChip, historyLine, dueState, when, fail, ensureCss, editor, summary, COLORS };
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
    AE.on('text-sent', ({ woId }) => {
      if (!woId) return;
      AE.sleep(1500).then(() => W.customerTexted(woId)) // let Portal's send land first
        .catch((e) => W.fail("the text went out, but the Auto-Waymark couldn't be moved", e));
    });
    const ROW_ID = 'sg-wm-row', POP_ID = 'sg-wm-pop', BTN_ID = 'sg-wm-btn', BOARD_ID = 'sg-wm-board';
    const currentWoId = () => { const m = location.pathname.match(/^\/repair\/workorder\/(\d+)/); return m ? m[1] : null; };
    const nameRow = (woId) => {
      const heading = AE.woHeading(woId);
      return heading && heading.parentElement;
    };

    // ---------------------------------------------------- WO page: chips + "+ Tag"
    function renderRow() {
      const woId = currentWoId();
      const anchor = woId && nameRow(woId);
      let row = document.getElementById(ROW_ID);
      if (!anchor) { row?.remove(); return; }
      const key = woId + '|' + JSON.stringify(W.tagsOf(woId)) + '|' + JSON.stringify(W.autoOf(woId)) + '|' + W.listSig(); // redraw on any change
      if (row && row.dataset.key === key && row.parentElement === anchor) return;
      row?.remove();
      row = h('span', { id: ROW_ID, 'data-key': key },
        W.autoOf(woId) ? W.autoChip(woId, W.autoOf(woId), renderRow) : null,
        W.tagsOf(woId).map((t) => W.chip(t.tag, { title: t.tag + ' · added by ' + (t.by || 'someone') + ', ' + W.when(t.at), onRemove: () => toggle(woId, t.tag, false) })),
        h('button', { type: 'button', class: 'sg-btn add', onclick: (e) => { e.stopPropagation(); togglePop(woId); } }, '+ Tag'));
      anchor.appendChild(row);
    }

    async function toggle(woId, tag, on) {
      try { await W.setTag(woId, tag, on); } catch (e) { W.fail("couldn't update tags", e); }
      renderRow(); renderList();
      if (document.getElementById(POP_ID)) renderPop(woId);
    }

    let popAnchor = null; // the + Tag that opened the popover (WO page, or a row of the WO list)
    function togglePop(woId, anchor) {
      if (document.getElementById(POP_ID)) { document.getElementById(POP_ID).remove(); return; }
      renderPop(woId, anchor);
    }
    function renderPop(woId, anchor) {
      if (anchor) popAnchor = anchor;
      const btn = (popAnchor && popAnchor.isConnected ? popAnchor : null) || document.querySelector('#' + ROW_ID + ' .add');
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
          hist.replaceChildren(...(items.length ? items.map(W.historyLine)
            : [h('li', { class: 'sg-soft' }, 'No tag changes yet.')]));
        }).catch((e) => hist.replaceChildren(h('li', { class: 'sg-soft' }, "Couldn't load history.", ...W.reportEl('Loading WO ' + woId + '\'s tag history', e))));
      }).catch((e) => { pop.replaceChildren(h('div', { class: 'sg-soft' }, "Couldn't load tags.", ...W.reportEl('Loading WO ' + woId + '\'s tags', e))); });
    }
    document.addEventListener('click', (e) => {
      // composedPath: the clicked chip may already be redrawn (detached) by now.
      const pop = document.getElementById(POP_ID), path = e.composedPath();
      if (pop && !path.includes(pop) && !path.includes(document.getElementById(ROW_ID)) && !path.some((n) => n.id === 'sg-wm-push' || (n.classList && (n.classList.contains('sg-wm-li') || n.classList.contains('sg-wm-all'))))) pop.remove();
    });

    /*
      ---------------------------------------------------- Work orders list
      Each order's tags on Portal's Work orders list (/repair/workorders),
      Settings → Waymark (settings.waymarkList): one compact chip beside the
      customer's name, on the line the name already uses (rows don't get taller),
      plus "+N" for the rest. Which chip: an Auto-Waymark due today or overdue,
      else the first tag in the store's list order (one-offs after), else an
      upcoming Auto-Waymark. edit: hovering a row shows × and "+ Tag"; "+N"
      lists them all. filter (off by default): a Waymark dropdown next to
      Portal's filters hides rows without that tag (on the page shown).
      Portal's row opens the WO on click, so our clicks stop there.
      Portal's Customer cell: td > div > a[href=/repair/workorder/<id>] > div (name).
    */
    const LI = 'sg-wm-li', ALL_ID = 'sg-wm-all', FILTER_ID = 'sg-wm-filter';
    const LS = () => Object.assign({ chips: true, edit: true, filter: false }, AE.settings.waymarkList || {});
    const onList = () => /^\/repair\/workorders\/?$/.test(location.pathname);
    document.head.append(h('style', null, `
      .sg-wm-li-wrap { display:flex !important; align-items:center; gap:6px; min-width:0; flex-wrap:nowrap; }
      .sg-wm-li-wrap > a { min-width:0; overflow:hidden; }
      .sg-wm-li-wrap > a > div { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .${LI} { position:relative; display:inline-flex; align-items:center; gap:4px; flex:none; white-space:nowrap; line-height:1; }
      .${LI} .sg-tag, .sg-wm-all .sg-tag { height:18px; padding:0 7px; font-size:11px; max-width:140px; }
      .${LI} .sg-auto, .sg-wm-all .sg-auto { height:18px; padding:0 5px; font-size:11px; border-radius:5px; }
      .${LI} .sg-auto svg { width:11px; height:11px; }
      .${LI} .more { height:18px; padding:0 6px; border-radius:10000rem; border:0; cursor:pointer; font:700 11px/1 Apercu, "Helvetica Neue", Arial, sans-serif;
        background:color-mix(in srgb, var(--aui-on-surface, #1a1c1e) 12%, transparent); color:var(--aui-on-surface, #1a1c1e); }
      /* + Tag and × float over the row on hover (no space reserved, so no gap after the tags, and hovering never reflows) */
      .${LI} .add { position:absolute; left:calc(100% + 4px); top:50%; transform:translateY(-50%); display:inline-flex; align-items:center; visibility:hidden; height:18px; padding:0 7px; border-radius:10000rem; border:1px dashed var(--aui-primary, #8223d2); background:transparent; cursor:pointer;
        color:var(--aui-primary, #8223d2); font:700 11px/1 Apercu, "Helvetica Neue", Arial, sans-serif; }
      .${LI}:not(.edit) .sg-tag button, .${LI}:not(.edit) .sg-auto button { display:none; }
      /* × as a small badge on the chip's top-right corner (hover), so the chip's text stays readable */
      .${LI} .sg-tag, .${LI} .sg-auto { position:relative; overflow:visible; max-width:none; }
      .${LI}.edit .sg-tag button, .${LI}.edit .sg-auto button { visibility:hidden; position:absolute; right:-6px; top:-7px; width:14px; height:14px; padding:0;
        display:inline-flex; align-items:center; justify-content:center; border-radius:50%; opacity:1; font-size:11px; line-height:1;
        background:var(--aui-on-surface, #1a1c1e); color:var(--aui-surface, #fff); box-shadow:0 0 0 1.5px var(--aui-surface, #fff); }
      tr:hover .${LI}.edit .add, tr:hover .${LI}.edit .sg-tag button, tr:hover .${LI}.edit .sg-auto button,
      .${LI}.edit:focus-within .add, .${LI}.edit:focus-within button { visibility:visible; }
      #${ALL_ID} { position:fixed; z-index:2147483646; width:260px; padding:10px 12px; font-size:13px; }
      #${ALL_ID} h4 { margin:0 0 8px; font-size:11px; letter-spacing:.04em; text-transform:uppercase; color:var(--aui-on-surface-soft, #5d5e61); }
      #${ALL_ID} .r { margin:6px 0; display:flex; }
      #${ALL_ID} .add { height:22px; padding:0 9px; border-radius:10000rem; border:1px dashed var(--aui-primary, #8223d2); background:transparent; cursor:pointer;
        color:var(--aui-primary, #8223d2); font:700 12px/1 Apercu, "Helvetica Neue", Arial, sans-serif; }
      tr.sg-wm-hidden { display:none !important; }
      #${FILTER_ID} { position:relative; display:inline-flex; align-items:center; gap:6px; height:32px; padding:0 12px 0 14px; margin-left:8px; border-radius:8px; cursor:pointer;
        border:1px solid var(--aui-primary, #8223d2); background:transparent; color:var(--aui-primary, #8223d2); font:400 15px Apercu, "Helvetica Neue", Arial, sans-serif; }
      #${FILTER_ID} .ae { position:absolute; left:-8px; top:-9px; width:18px; height:18px; border-radius:50%; background:var(--aui-primary, #8223d2); color:#fff;
        font:700 8px/18px Apercu, Arial, sans-serif; text-align:center; box-shadow:0 0 0 2px var(--aui-surface, #fff); }
      #${FILTER_ID}.on { background:var(--aui-primary, #8223d2); color:#fff; }
    `));
    const listOrder = (c) => new Map((c ? c.list : []).map((l, i) => [l.name, i]));
    // Everything on an order, most important first.
    function itemsOf(woId) {
      const auto = W.autoOf(woId), st = auto && W.dueState(auto.due), ord = listOrder(W.load.cache || null);
      const tags = W.tagsOf(woId).slice().sort((a, b) => (ord.has(a.tag) ? ord.get(a.tag) : 999) - (ord.has(b.tag) ? ord.get(b.tag) : 999));
      const urgent = auto && (st === 'today' || st === 'overdue');
      return [...(urgent ? [{ auto }] : []), ...tags.map((t) => ({ t })), ...(auto && !urgent ? [{ auto }] : [])];
    }
    const chipFor = (woId, it, edit) => {
      if (it.auto) {
        const el = W.autoChip(woId, it.auto, () => { renderList(); renderRow(); });
        if (!edit) el.querySelector('button')?.remove();
        return el;
      }
      return W.chip(it.t.tag, { title: it.t.tag + ' · added by ' + (it.t.by || 'someone') + ', ' + W.when(it.t.at), onRemove: edit ? () => toggle(woId, it.t.tag, false) : null });
    };
    const stop = (e) => { e.stopPropagation(); };
    function custIndex(table) {
      const head = table && table.querySelector('thead tr');
      return head ? [...head.children].findIndex((c) => c.textContent.trim().toLowerCase() === 'customer') : -1;
    }
    let listFilter = '';
    function renderList() {
      const S = LS();
      if (!onList() || !S.chips) { document.querySelectorAll('.' + LI).forEach((x) => x.remove()); unfit(); document.querySelectorAll('tr.sg-wm-hidden').forEach((r) => r.classList.remove('sg-wm-hidden')); renderFilter(); return; }
      const idx = new Map();
      for (const row of document.querySelectorAll('tbody tr')) {
        const a = row.querySelector('a[href*="/repair/workorder/"]');
        const m = a && a.getAttribute('href').match(/\/repair\/workorder\/(\d+)/);
        if (!m) continue;
        const woId = m[1], table = row.closest('table');
        if (!idx.has(table)) idx.set(table, custIndex(table));
        const cell = row.children[idx.get(table)];
        const link = cell && cell.querySelector('a[href*="/repair/workorder/"]');
        const wrap = link && link.parentElement;
        if (!wrap) continue;
        wrap.setAttribute('data-ae-fit', ''); // every row's name may use its row's free room (fitNames)
        const items = itemsOf(woId);
        // Tag filter: hide rows without the chosen tag.
        row.classList.toggle('sg-wm-hidden', !!(S.filter && listFilter && !items.some((it) => (it.t && it.t.tag === listFilter) || (listFilter === '@auto' && it.auto))));
        const key = woId + '|' + JSON.stringify(items) + '|' + S.edit;
        let li = wrap.querySelector('.' + LI);
        if (li && li.dataset.key === key) continue;
        li?.remove();
        if (!items.length && !S.edit) continue;
        wrap.classList.add('sg-wm-li-wrap');
        li = h('span', { class: LI + (S.edit ? ' edit' : ''), 'data-key': key, onclick: stop, onmousedown: stop });
        if (items[0]) li.append(chipFor(woId, items[0], S.edit));
        if (items.length > 1) li.append(h('button', { type: 'button', class: 'more', title: 'All ' + items.length + ' tags', onclick: (e) => { e.preventDefault(); e.stopPropagation(); openAll(woId, e.currentTarget); } }, '+' + (items.length - 1)));
        if (S.edit) li.append(h('button', { type: 'button', class: 'add', title: 'Tag this work order', onclick: (e) => { e.preventDefault(); e.stopPropagation(); togglePop(woId, e.currentTarget); } }, '+ Tag'));
        if (!li.childNodes.length) continue;
        wrap.append(li);
      }
      fitNames();
      renderFilter();
    }
    /*
      Portal caps the customer's name at 7.5rem (120 px, "…" after). Rows with tags make the Customer column
      wider (120 px + their chips), so the other rows' names may use that room too. The room comes from what
      the column needs without any fitting (Portal's 120 px + the widest row of chips), never from the cells'
      current widths, so it can't feed back and creep the table wider.
    */
    const PORTAL_CAP = 120, GAP = 6;
    function fitNames() {
      const rows = [...document.querySelectorAll('tbody tr td [data-ae-fit]')].map((wrap) => {
        const link = wrap.querySelector(':scope > a'), name = link && link.querySelector(':scope > div'), li = wrap.querySelector('.' + LI);
        return { wrap, link, name, used: li && li.offsetWidth ? li.offsetWidth + GAP : 0 };
      }).filter((r) => r.name);
      const widest = rows.reduce((m, r) => Math.max(m, PORTAL_CAP + r.used), PORTAL_CAP);
      for (const r of rows) {
        const room = Math.max(PORTAL_CAP, widest - r.used) + 'px';
        if (r.name.style.maxWidth !== room) { r.name.style.maxWidth = room; r.link.style.maxWidth = room; }
      }
    }
    function unfit() {
      document.querySelectorAll('[data-ae-fit]').forEach((w) => { const a = w.querySelector(':scope > a'), d = a && a.querySelector(':scope > div'); if (a) a.style.maxWidth = ''; if (d) d.style.maxWidth = ''; w.removeAttribute('data-ae-fit'); });
    }
    // "+N": every tag on the order (removable when editing), and + Tag.
    function openAll(woId, anchor) {
      document.getElementById(ALL_ID)?.remove();
      const S = LS(), items = itemsOf(woId);
      const name = (anchor.closest('.sg-wm-li-wrap')?.querySelector('a')?.textContent || '').trim();
      const box = h('div', { id: ALL_ID, class: 'sg sg-card', role: 'dialog', 'aria-label': 'Tags', onclick: stop, onmousedown: stop },
        h('h4', null, (name ? name + ' · ' : '') + items.length + ' tags'),
        ...items.map((it) => h('div', { class: 'r' }, chipFor(woId, it, S.edit))),
        S.edit ? h('div', { class: 'r' }, h('button', { type: 'button', class: 'add', onclick: (e) => { e.stopPropagation(); box.remove(); togglePop(woId, anchor); } }, '+ Tag')) : null);
      document.body.append(box);
      const r = anchor.getBoundingClientRect();
      box.style.top = Math.min(r.bottom + 6, innerHeight - box.offsetHeight - 8) + 'px';
      box.style.left = Math.max(8, Math.min(r.left - 10, innerWidth - box.offsetWidth - 8)) + 'px';
    }
    document.addEventListener('click', (e) => { const b = document.getElementById(ALL_ID); if (b && !e.composedPath().includes(b)) b.remove(); });
    // Tag filter (off by default): next to Portal's filters (Needs Attention, Program, Device type).
    function renderFilter() {
      let f = document.getElementById(FILTER_ID);
      const S = LS();
      const anchor = onList() && S.chips && S.filter && [...document.querySelectorAll('button, [role="button"]')].find((b) => b.offsetParent && b.textContent.trim() === 'Device type');
      if (!anchor) { f?.remove(); if (listFilter) { listFilter = ''; } return; }
      const label = !listFilter ? 'Waymark' : listFilter === '@auto' ? 'Waymark: Auto-Waymark' : 'Waymark: ' + listFilter;
      if (!f) {
        f = h('button', { type: 'button', id: FILTER_ID, class: 'sg', title: 'Show only work orders with a Waymark tag (on this page)', onclick: (e) => { e.stopPropagation(); filterMenu(f); } });
      }
      if (f.dataset.label !== label) { f.dataset.label = label; f.replaceChildren(h('span', { class: 'ae' }, 'Ae'), label + ' ▾'); f.classList.toggle('on', !!listFilter); }
      const host = anchor.closest('div') || anchor;
      if (f.previousElementSibling !== host) host.after(f);
    }
    function filterMenu(f) {
      document.getElementById('sg-wm-fmenu')?.remove();
      const pick = (v) => { listFilter = v; menu.remove(); renderList(); };
      const c = W.load.cache || { list: [] };
      const menu = h('div', { id: 'sg-wm-fmenu', class: 'sg sg-card', style: 'position:fixed;z-index:2147483646;padding:6px;min-width:200px', onclick: stop },
        h('button', { type: 'button', class: 'sg-btn', style: 'width:100%;justify-content:flex-start;border:0', onclick: () => pick('') }, 'All work orders'),
        h('button', { type: 'button', class: 'sg-btn', style: 'width:100%;justify-content:flex-start;border:0', onclick: () => pick('@auto') }, 'Auto-Waymark'),
        ...c.list.map((l) => h('button', { type: 'button', class: 'sg-btn', style: 'width:100%;justify-content:flex-start;border:0', onclick: () => pick(l.name) }, W.chip(l.name))));
      document.body.append(menu);
      const r = f.getBoundingClientRect();
      menu.style.top = (r.bottom + 6) + 'px'; menu.style.left = Math.min(r.left, innerWidth - menu.offsetWidth - 8) + 'px';
      setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }));
    }
    AE.every(1000, () => { if (onList() && LS().chips) W.load().catch(() => {}); renderList(); });
    // New or changed rows get their chips in the same frame (2.23). A cheap signature of the list
    // (row count, first/last WO, rows already done) decides whether to redraw; the timer catches the rest.
    let listSig = '';
    AE.onDom(() => {
      if (!onList() || !LS().chips) return;
      const links = document.querySelectorAll('tbody tr a[href*="/repair/workorder/"]');
      const sig = links.length + '|' + (links[0] && links[0].getAttribute('href')) + '|' + (links.length && links[links.length - 1].getAttribute('href')) + '|' + document.querySelectorAll('[data-ae-fit]').length;
      if (sig !== listSig) { renderList(); listSig = links.length + '|' + (links[0] && links[0].getAttribute('href')) + '|' + (links.length && links[links.length - 1].getAttribute('href')) + '|' + document.querySelectorAll('[data-ae-fit]').length; }
    });
    AE.on('waymark-changed', () => renderList());

    // ---------------------------------------------------- header button + board
    function renderButton() {
      const anchor = AE.headerAnchor();
      let b = document.getElementById(BTN_ID);
      if (!anchor) { b?.remove(); return; }
      if (!b) b = h('button', { type: 'button', id: BTN_ID, class: 'sg', title: 'Waymark: work orders by tag', 'aria-label': 'Waymark board', html: AE.actionIcon('waymark', 26), onclick: (e) => { e.stopPropagation(); toggleBoard(); } });
      if (b.parentElement !== anchor.parentElement || b.nextSibling !== anchor) anchor.parentElement.insertBefore(b, anchor);
      // Badge: open Auto-Waymarks due today (or overdue).
      const n = demoBadge != null ? demoBadge : W.dueMarks().length; // demoBadge: dev tools
      let badge = b.querySelector('.badge');
      if (!n) { badge?.remove(); b.title = 'Waymark: work orders by tag'; }
      else {
        if (!badge) { badge = h('span', { class: 'badge' }); b.append(badge); }
        if (badge.textContent !== String(n)) badge.textContent = n > 99 ? '99+' : String(n);
        b.title = 'Waymark: ' + n + ' Auto-Waymark' + (n === 1 ? '' : 's') + ' due';
      }
      placeBubble();
    }

    // ---------------------------------------------------- morning notice (managers)
    // First Portal load of the day: if any Auto-Waymarks were left open past
    // their due day (so open past 9 PM that night), a speech bubble from the icon.
    const MORNING_KEY = 'ae_wm_morning_shown';
    let demoBadge = null;
    function placeBubble() {
      const bub = document.getElementById('sg-wm-bubble'), b = document.getElementById(BTN_ID);
      if (!bub || !b) return;
      const r = b.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.left + r.width / 2 - bub.offsetWidth + 40, innerWidth - bub.offsetWidth - 8));
      bub.style.left = left + 'px'; bub.style.top = (r.bottom + 12) + 'px';
      bub.querySelector('.tail').style.left = (r.left + r.width / 2 - left - 7) + 'px';
    }
    async function morningNotice() {
      if (GM_getValue(MORNING_KEY, '') === W.today()) return;
      const role = await W.canEdit();
      if (!role.ok) return;
      const rows = await AE.data.workorders(Date.now(), 0);
      GM_setValue(W.OPEN_KEY, { at: Date.now(), ids: rows.map((r) => Number(r.workorderId)) });
      const c = await W.load(true);
      const open = new Set(rows.map((r) => String(r.workorderId)));
      const late = Object.entries(c.auto).filter(([id, m]) => open.has(String(id)) && m.due < W.today()).length;
      GM_setValue(MORNING_KEY, W.today()); // once a day, whether or not there's anything to say
      if (late) showBubble(late);
    }
    function showBubble(late) {
      if (document.getElementById('sg-wm-bubble')) return;
      const bub = h('div', { id: 'sg-wm-bubble', class: 'sg sg-card', role: 'alert' },
        h('span', { class: 'tail' }),
        h('div', { class: 'top' }, h('span', { class: 'n' }, String(late)),
          h('div', null, late === 1 ? 'There is 1 Auto-Waymark sitting open. Please take a look at it ASAP.'
            : 'There are ' + late + ' Auto-Waymarks sitting open. Please take a look at these ASAP.')),
        h('div', { class: 'sg-actions' },
          h('button', { type: 'button', class: 'sg-btn', onclick: () => bub.remove() }, 'Later'),
          h('button', { type: 'button', class: 'sg-btn sg-primary', onclick: () => {
            bub.remove(); boardTab = 'auto';
            // After this click finishes, or the board's click-outside handler would close it at once.
            setTimeout(() => { if (!document.getElementById(BOARD_ID)) toggleBoard(); }, 0);
          } }, 'Show them')));
      document.body.appendChild(bub);
      placeBubble();
    }

    let boardFilter = null; // tag name, or null = all
    let boardTab = 'tags';  // 'tags' | 'auto'
    let boardManager = false; // managers clear tags right from the board
    async function toggleBoard() {
      if (document.getElementById(BOARD_ID)) { document.getElementById(BOARD_ID).remove(); return; }
      const header = document.querySelector('.components-header');
      const board = h('div', { id: BOARD_ID, class: 'sg sg-card', role: 'dialog', 'aria-label': 'Waymark board',
        style: 'top:' + Math.round((header ? header.getBoundingClientRect().bottom : 64) + 8) + 'px' },
        h('div', { class: 'head' }, h('span', { html: AE.actionIcon('waymark', 26) }), h('b', null, 'Waymark'),
          h('button', { type: 'button', class: 'sg-x', title: 'Close', onclick: () => board.remove() }, '✕')),
        h('div', { class: 'list' }, h('div', { class: 'sg-soft' }, h('span', { class: 'sg-spin', style: 'display:inline-block;vertical-align:-3px;margin-right:6px' }), 'Loading open work orders…')));
      document.body.appendChild(board);
      AE.track('waymark:board');
      try {
        const [c, wos, role] = await Promise.all([W.load(true), AE.data.workorders(Date.now(), 0), W.canEdit().catch(() => ({ ok: false }))]);
        boardManager = !!role.ok;
        drawBoard(board, c, wos);
        W.scan(wos).then(() => W.load()).then((c2) => { if (board.isConnected) drawBoard(board, c2, wos); }).catch(() => {});
      } catch (e) {
        board.querySelector('.list').replaceChildren(h('div', { class: 'sg-soft' }, "Couldn't load.", ...W.reportEl('Loading the board', e)));
      }
    }
    function drawBoard(board, c, wos) {
      const byId = new Map(wos.map((r) => [String(r.workorderId), r]));
      const marked = Object.entries(c.auto || {}).filter(([id]) => byId.has(String(id)));
      const late = marked.filter(([, m]) => W.dueState(m.due) === 'overdue').length;
      const tabBtn = (id, label, n, extra) => h('button', { type: 'button', class: 'tab' + (boardTab === id ? ' on' : ''), role: 'tab', 'aria-selected': String(boardTab === id),
        onclick: () => { boardTab = id; drawBoard(board, c, wos); } }, label, h('span', { class: 'n' }, n), extra);
      board.querySelector('.tabs')?.remove();
      board.querySelector('.head').after(h('div', { class: 'tabs', role: 'tablist' },
        tabBtn('tags', 'Tags', Object.keys(c.tags).filter((id) => byId.has(String(id))).length),
        tabBtn('auto', 'Auto-Waymark', marked.length, late ? h('span', { class: 'late', title: late + ' overdue' }, late) : null)));
      const woLine = (id) => {
        const r = byId.get(String(id));
        const dev = (r.customerDevice && r.customerDevice.name) || (r.deviceCatalog && r.deviceCatalog.name) || '';
        return h('div', null,
          h('a', { href: '/repair/workorder/' + id }, 'WO ' + id), ' · ', AE.data.nameOf(r) || 'Customer',
          h('div', { class: 'meta' }, [r.workorderStatusName, dev].filter(Boolean).join(' · ')));
      };
      if (boardTab === 'auto') {
        board.querySelector('.filters')?.remove();
        const redraw = () => W.load().then((c2) => drawBoard(board, c2, wos)).catch(() => {});
        const sections = [['overdue', 'Overdue'], ['today', 'Due today'], ['upcoming', 'Upcoming']];
        const sorted = marked.sort(([, a], [, b]) => a.due.localeCompare(b.due));
        board.querySelector('.list').replaceChildren(...(sorted.length ? sections.map(([st, title]) => {
          const rows = sorted.filter(([, m]) => W.dueState(m.due) === st);
          return rows.length ? h('div', { class: 'group' }, h('div', { class: 'gh' }, title + ' · ' + rows.length),
            rows.map(([id, m]) => h('div', { class: 'wo' }, woLine(id), h('div', { class: 'chips' }, W.autoChip(id, m, redraw))))) : null;
        }).filter(Boolean) : [h('div', { class: 'sg-soft', style: 'padding:8px 0' }, 'No Auto-Waymarks. A work order gets one when it reaches Ready for pickup (3 days out) or Awaiting callback or Awaiting device (the next day).')]),
          h('div', { class: 'sg-soft', style: 'padding:6px 0 2px' }, 'Right-click a date to push it later; × removes it.'));
        return;
      }
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
          h('div', { class: 'chips' }, ts.map((t) => W.chip(t.tag, !boardManager ? {} : {
            title: t.tag + ' · added by ' + (t.by || 'someone') + ', ' + W.when(t.at),
            onRemove: async () => {
              try { await W.setTag(id, t.tag, false); } catch (e) { return W.fail("couldn't remove " + t.tag, e); }
              AE.track('waymark:boardUntag');
              drawBoard(board, await W.load(), wos);
            },
          }))));
      };
      const filterChip = (n) => {
        const el = W.chip(n, { label: n + ' (' + counts[n] + ')', cls: 'toggle' + (boardFilter && boardFilter !== n ? ' off' : ''), title: 'Show only ' + n });
        el.onclick = () => { boardFilter = boardFilter === n ? null : n; drawBoard(board, c, wos); };
        return el;
      };
      board.querySelector('.filters')?.remove();
      const filters = h('div', { class: 'filters' }, names.filter((n) => counts[n]).map(filterChip));
      board.querySelector('.tabs').after(filters);
      board.querySelector('.list').replaceChildren(...(shown.length ? shown.map((n) => {
        const rows = tagged.filter(([, ts]) => ts.some((t) => t.tag === n))
          .sort(([a], [b]) => Date.parse(byId.get(String(a)).createdAt) - Date.parse(byId.get(String(b)).createdAt));
        return h('div', { class: 'group' }, h('div', { class: 'gh' }, W.chip(n), rows.length + ' open'), rows.map(([id, ts]) => woRow(id, ts)));
      }) : [h('div', { class: 'sg-soft', style: 'padding:8px 0' }, c.list.length ? 'No open work orders are tagged yet. Open a work order and use + Tag.' : 'No tags yet. A manager can set up the store list in Settings → Waymark; anyone can add one-off tags from a work order.')]),
        h('div', { class: 'sg-soft', style: 'padding:6px 0 2px' }, ((n) => n + ' open work order' + (n === 1 ? ' has' : 's have') + ' no tags.')(wos.length - tagged.length)));
    }
    document.addEventListener('click', (e) => {
      const b = document.getElementById(BOARD_ID), path = e.composedPath();
      if (b && !path.includes(b) && !path.includes(document.getElementById(BTN_ID)) && !path.some((n) => n.id === 'sg-wm-push')) b.remove();
    });

    // A tech setting this WO to Ready for pickup saves it with PUT /api/workorder/{id}
    // (or its /status). The page keeps its own fetch, so watch the network log,
    // then re-read the WO. Our own re-read lands inside the 5 s window and is ignored.
    let lastCheck = 0;
    try {
      new PerformanceObserver((list) => {
        const woId = currentWoId();
        if (!woId || Date.now() - lastCheck < 5000) return;
        const re = new RegExp('/api/workorder/' + woId + '(/status)?(?:[?#]|$)');
        if (!list.getEntries().some((e) => re.test(e.name))) return;
        lastCheck = Date.now();
        setTimeout(() => W.checkWo(woId).catch((e) => console.warn('[' + AE_NAME + '] Auto-Waymark check:', e.message || e)), 1500);
      }).observe({ type: 'resource', buffered: false });
    } catch (_) { /* no PerformanceObserver: the 10-minute scan still covers it */ }

    // Dev tools (dev builds only) drive these.
    Object.assign(AE.hooks, {
      waymarkBubble: (n) => { document.getElementById('sg-wm-bubble')?.remove(); showBubble(n); },
      waymarkBadge: (n) => { demoBadge = n; renderButton(); },
      waymarkMorning: () => { GM_deleteValue(MORNING_KEY); return morningNotice(); },
    });

    AE.on('waymark-changed', () => { renderRow(); });
    W.load().catch(() => {});
    // In the header the moment Portal draws it (2.23); the timer below also refreshes the badge.
    AE.onDom(() => {
      const a = AE.headerAnchor(), b = document.getElementById(BTN_ID);
      if (a && !(b && b.nextSibling === a)) renderButton();
    });
    AE.onDom(() => { // the tag row, in the same frame as Portal's heading (2.23)
      const woId = currentWoId();
      if (!woId) return;
      const row = document.getElementById(ROW_ID), anchor = nameRow(woId);
      if (anchor && !(row && row.parentElement === anchor)) renderRow();
    });
    AE.every(1000, () => {
      renderButton();
      if (currentWoId()) { W.load().then(renderRow).catch(() => {}); renderRow(); }
      else { document.getElementById(ROW_ID)?.remove(); document.getElementById(POP_ID)?.remove(); }
    });
    // Every 10 minutes (shared across tabs): Auto-Waymark new Ready for pickup
    // WOs, and report closed ones so their tags/marks clear 7 days later.
    const tick = () => W.scan().catch((e) => console.warn('[' + AE_NAME + '] Waymark scan:', e.message || e));
    setTimeout(tick, 15000);
    // Managers' morning notice, once the header is up.
    setTimeout(() => morningNotice().catch((e) => console.warn('[' + AE_NAME + '] Waymark morning notice:', e.message || e)), 4000);
    setInterval(tick, 60 * 1000); // scan() itself waits out the 10 minutes
  },
});
