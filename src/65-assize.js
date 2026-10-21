/*
  Assize (live work-order audit) — the [A] rules of the ubif-workorders audit (field checks), run
  over the store's open work orders, all day, in every tab.

  What it shows:
    · Header icon: fails + flags on the badge, colored by the worst (red fail, amber flag, grey when
      there are only "check notes", green ✓ when nothing needs doing). The panel under it: summary
      tiles, a chip per tech (plus Store), the findings grouped by check in the rules' order, then
      the Awaiting item reminders.
    · Work order page: an "N findings" pill after the title, for that order's findings.
    · Work orders list: a small Assize icon + count after the customer's name (left of Waymark's
      chips), nothing for reminder-only rows.
  Finding kinds: fail (red), flag (amber), check notes (grey: a note could explain it, so a person
  looks; never a fail) and reminder (blue: Awaiting item; never counted on the badge).
  Blame: the tech who wrote the note or took the action (the intake note's author for intake, cart,
  quote and partner-acceptance issues; whoever set the status for contact, age and reminders),
  "Store" for missed contacts and Need to order, "Unassigned" for bins and anything not logged per
  person. Names come from the notes' authors (UserDatum), shown as initials.

  Dismissing: a finding that doesn't apply can be dismissed for the whole store ("Dismiss" on its row,
  in the panel and the order's pill popover: a reason, an optional note). Every finding carries a stable
  `rule` id (kebab-case, e.g. missed-contact, no-bin) and a `sig`, a short hash of the facts it
  was raised on (the nickname's date, the cart's lines, the status and the date it began...), so a
  dismissal stops applying when those facts change. Dismissals live on the Waymark Worker
  (assize_dismissals, GET /assize/dismissed, POST /assize/dismiss and /assize/restore), are loaded with
  each scan and when the panel opens, and are applied outside the rules engine: a dismissed finding is
  left out of the badge, header color, tiles, chips, the order's pill and the list markers. The panel's
  "Dismissed (n)" lists them (who, when, why) with Restore, for whoever dismissed it or a manager.
  The Worker drops them 7 days after the order closes, and after 60 days.

  Read-only toward Portal: it never writes to Portal (the only POST is Portal's own work-order list
  read, through AE.data). The only things it sends to Aethernet's Workers are usage counts (AE.track)
  and dismissals / restores (through Waymark's call(), which checks the store first). It also reads the
  rules published for the store from the tracker Worker (a GET with the store number and the version it has).

  Cost: Portal's open list once a pass (+1 page of closed orders, for 4b), then each in-scope open
  order's detail (GET /api/workorder/:id, /api/note?workorderId=… (30 a page), /api/workorder-audit-
  trail/:id and /api/get-cart/:csuCartId: 4 calls, made together) when its updatedAt changed, when the
  copy is older than 30 minutes (updatedAt does NOT move for a new note or a nickname edit), on the
  panel's Refresh (every open order, cache ignored: about 4 calls each plus the list), and right away
  after a text, a Recitation note or a Waymark nickname change on that order; one order after another,
  300 ms apart. The detail comes through AE.woDetail (27-tracker.js), shared with the tracker: a copy
  either one fetched in the last 10 minutes (2 for the order on screen) with the same updatedAt is
  used without asking Portal again (not on Refresh or after a change). The list
  row's status, nickname, bin and dates are re-read every pass and win over a cached detail. One pass per 10 minutes, shared by every tab (a timestamp
  in GM storage, like Waymark's scan), plus the order being viewed (at most every 2 minutes). Rows
  and details are kept in GM storage per store, so every tab shows the same findings without
  fetching again; each tab re-runs the rules every minute so time-based ones (after close, today's
  contact dates, ages) stay current between passes. Published rules: one small GET to the tracker Worker
  every 10 minutes at most per tab, answered "same" (no graphs) until something is published.

  Rules engine: AE.assizeRules, pure functions (list row + detail + now + store hours + price lookup →
  findings), no DOM, no fetching, no AE helpers. It lives in tracker-worker/src/assize-rules.js (shared with the
  tracker Worker and the admin site's rules editor) and is inlined here by build.py. It never knows about dismissals.

  Rule graphs: rules drawn as node graphs (tracker-worker/src/rulegraph.js), edited and published on the admin site
  (Assize rules page). Every 10 minutes at most, Assize asks the tracker Worker which graphs apply to this store
  (GET /v1/:store/assize/rules: the published graph per rule, the store's own winning over the one for all stores,
  and which rules are turned off here), keeps the answer per store in GM storage and compiles it once per version.
  For a rule with a published graph, the graph's findings replace the code's (same rule id and signature basis, so
  dismissals carry over); a rule turned off at the store raises nothing; a graph-only rule adds its findings. A graph
  that errs on an order falls back to the code rule for that order (logged with the shadow mismatches). If the
  Worker can't be reached, the last answer stays in use, else the code rules alone. Nothing changes for staff until
  a graph is published.
  Shadow mode (phase 1) goes on for the built-in graphs (src/assize-graphs/*.json) of rules with nothing published:
  every compute runs them next to the code rules and logs where the two disagree (GM ae_assize_graphs_<store>, the
  last 50; dev tools shows it), so the log still says whether a port is faithful.
*/
AE.assizeRules = (() => {
  // The engine (assize-rules.js) with the graph interpreter (rulegraph.js) and the built-in graphs, inlined by build.py.
  const RG = (() => { /*__RULEGRAPH__*/ })();
  const { makeRules } = (() => { /*__ASSIZE_RULES__*/ })();
  return makeRules({ RG, graphs: __ASSIZE_GRAPHS__ });
})();

AE.crystal({
  id: 'assize',
  name: 'Assize',
  sites: ['portal.ubreakifix.net'],
  run() {
    const { h, esc } = AE, R = AE.assizeRules;
    const SCAN_MS = 10 * 60 * 1000, GAP_MS = 300, WO_MS = 2 * 60 * 1000, DETAIL_TTL = 30 * 60 * 1000;
    const PANEL_ID = 'ae-as-panel', PILL_ID = 'ae-as-pill', POP_ID = 'ae-as-pop', MK = 'ae-as-mk';
    const CHECK_NAME = Object.fromEntries(R.CHECKS);
    const orders = (n) => n + (n === 1 ? ' open order' : ' open orders');
    const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    // ------------------------------------------------------------ storage (per store, shared by tabs)
    let storeId = null;
    const key = (k) => 'ae_assize_' + k + '_' + storeId;
    const readRows = () => GM_getValue(key('rows'), null);     // { at, rows: [trimmed open rows], closed: [trimmed closed AM rows] }
    const readDetails = () => GM_getValue(key('details'), {}); // { woId: { u: list updatedAt, at: fetched, d: trimmed detail } }

    // Only what the rules read, so GM storage stays small (and no passcodes, phones or emails): the engine's trimRow / trimDetail.
    const { trimRow, trimDetail } = R;

    // ------------------------------------------------------------ Portal reads (GET only)
    // Portal's detail through AE.woDetail (shared with the tracker: a copy it fetched in the last few minutes is used
    // as is). Notes are required: a failed notes fetch is an error, never "no intake note".
    async function detailOf(wo, opts = {}) {
      const asked = Date.now();
      const x = await AE.woDetail.get(storeId, wo, opts);
      if (!x.notes) throw new Error('notes did not load');
      const w = (x.workorder && x.workorder.workorder) || {};
      if (w.storeId != null && storeId != null && Number(w.storeId) !== Number(storeId)) throw Object.assign(new Error("another store's work order"), { otherStore: true });
      return { d: trimDetail(x.workorder, x.notes.notes, x.audit_trail, x.cart), at: x.at, fetched: x.at >= asked }; // at: when Portal answered
    }
    // Orders worth a detail fetch: open, in a status with rules, not a cleaning.
    const inScope = (r) => !/sale complete|cancel|repair summary|awaiting diag|partner approval/i.test(r.workorderStatusName || '') && R.programOf(r.programId, r.programName).key !== 'cleaning';

    // ------------------------------------------------------------ the pass
    let busy = false, lastError = null, progress = null;
    // A work order's updatedAt does not move when a note is added or the device nickname is edited, so a cached detail is
    // refetched when the list's updatedAt changed, when it is older than DETAIL_TTL, on Refresh (full), and right after
    // anything Aethernet itself did to the order (a text, a Recitation note, a Waymark nickname change: invalidate()).
    async function pass(force, full) {
      if (busy || AE.status.paused('assize')) return;
      const lock = key('scan_at');
      if (!force && Date.now() - GM_getValue(lock, 0) < SCAN_MS - 30000) return;
      GM_setValue(lock, Date.now());
      busy = true; render();
      loadDismissed(true);
      try {
        const y = new Date(); y.setDate(y.getDate() - 1); y.setHours(0, 0, 0, 0);
        const all = await AE.data.workorders(y.getTime(), 1); // every open order + one page of recent closed ones (4b)
        const closedRe = /sale complete|cancel/i;
        const open = all.filter((r) => !closedRe.test(r.workorderStatusName || '') && ![14, 15, 25].includes(Number(r.workorderStatusId)));
        const closed = all.filter((r) => Number(r.programId) === AE.PARENT_PROGRAM_ID && closedRe.test(r.workorderStatusName || ''));
        GM_setValue(key('rows'), { at: Date.now(), rows: open.map(trimRow), closed: closed.map(trimRow) });
        const details = readDetails(), keep = {};
        const want = open.filter(inScope);
        for (const r of want) if (details[r.workorderId]) keep[r.workorderId] = details[r.workorderId];
        GM_setValue(key('details'), keep);
        compute(); render();
        const nowMs = Date.now();
        const stale = want.filter((r) => full || !keep[r.workorderId] || keep[r.workorderId].u !== r.updatedAt || nowMs - (keep[r.workorderId].at || 0) > DETAIL_TTL);
        progress = { done: 0, total: stale.length };
        let n = 0;
        for (const r of stale) {
          let fetched = true;
          try {
            const x = await detailOf(r.workorderId, full ? { force: true } : { updatedAt: r.updatedAt });
            fetched = x.fetched;
            const cur = readDetails();
            cur[r.workorderId] = { u: r.updatedAt, at: x.at, d: x.d };
            GM_setValue(key('details'), cur);
          } catch (e) {
            if (/session expired/i.test(e.message || '') || e.storeChanged) throw e;
            if (!e.otherStore) AE.noteError('Assize detail ' + r.workorderId, e);
          }
          progress.done++;
          if (++n % 4 === 0) { compute(); render(); } else renderPanel();
          if (fetched) await AE.sleep(GAP_MS);
        }
        lastError = null;
      } catch (e) {
        lastError = e.storeChanged ? null : (e.message || String(e));
        if (lastError) AE.noteError('Assize', e);
      } finally {
        busy = false; progress = null;
        compute(); render();
        uploadDaily();
      }
    }
    // Daily metrics for the admin Metrics page: today's counts (dismissed findings are already out of result.sum).
    // Only after a pass that finished; fire and forget (AE.tracker.daily is quiet on failure).
    function uploadDaily() {
      if (lastError || !result || !AE.tracker || !AE.tracker.configured()) return;
      const t = new Date(), day = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0'), s = result.sum;
      AE.profile().then((p) => p.storeId && AE.tracker.daily(p.storeId, day, { assize_fail: s.fail, assize_flag: s.flag, assize_note: s.note }, 'assize')).catch(() => {});
    }
    // The order on screen: its own detail, fresh within 2 minutes.
    const woLoading = new Set(), woAgain = new Set();
    // Something just changed this order (a text, a note, a nickname): fetch it again now, ignoring the cache.
    // If a fetch is already under way it may have missed the change, so it runs once more when it finishes.
    function invalidate(woId) {
      woId = String(woId || '');
      if (!woId || !storeId) return;
      if (woLoading.has(woId)) { woAgain.add(woId); return; }
      refreshWo(woId, true);
    }
    async function refreshWo(woId, force) {
      if (!storeId || woLoading.has(woId) || AE.status.paused('assize')) return;
      const cur = readDetails()[woId];
      if (!force && cur && Date.now() - cur.at < WO_MS) return;
      const rows = readRows();
      const row = rows && rows.rows.find((r) => String(r.workorderId) === String(woId));
      if (rows && !row && rows.at > Date.now() - SCAN_MS && !cur) return; // not open (or not ours) at the last pass: nothing to check
      woLoading.add(woId);
      try {
        await AE.afterLoad();
        const { d, at } = await detailOf(woId, force ? { force: true } : { maxAge: WO_MS, updatedAt: row && row.updatedAt });
        if (!inScope({ workorderStatusName: d.wo.WorkorderStatus && d.wo.WorkorderStatus.name, programId: d.wo.programId, programName: d.wo.Program && d.wo.Program.name })) {
          const gone = readDetails();
          if (gone[woId]) { delete gone[woId]; GM_setValue(key('details'), gone); compute(); render(); } // moved out of scope: its old findings go
          return;
        }
        const all = readDetails();
        all[woId] = { u: row ? row.updatedAt : d.wo.updatedAt, at, d };
        GM_setValue(key('details'), all);
        compute(); render();
      } catch (e) { if (!e.otherStore) AE.noteError('Assize WO ' + woId, e); }
      finally { woLoading.delete(woId); if (woAgain.delete(woId)) refreshWo(woId, true); }
    }

    // ------------------------------------------------------------ dismissals (shared per store, on the Waymark Worker)
    let dismissed = [], dismissedAt = 0, me = null, isManager = false, showDismissed = false, actErr = null;
    let dp = null; // the open Dismiss form: { key, x, where: 'panel' | 'pop', reason, note, err, busy }
    const canDismiss = () => !!(storeId && AE.waymark && AE.waymark.configured() && !AE.status.blocked('waymark'));
    const REASONS = [['not-applicable', 'Not applicable'], ['handled', 'Already handled'], ['rule-doesnt-fit', "Rule doesn't fit"]];
    const REASON_NAME = Object.fromEntries(REASONS);
    async function loadDismissed(force) {
      if (!canDismiss() || (!force && Date.now() - dismissedAt < 30000)) return;
      try {
        const j = await AE.waymark.call('GET', '/assize/dismissed');
        dismissed = Array.isArray(j.dismissed) ? j.dismissed : [];
        dismissedAt = Date.now();
        compute(); render();
      } catch (e) { if (!e.storeChanged) AE.noteError('Assize dismissals', e); }
    }
    async function submitDismiss() {
      if (!dp || !dp.reason || dp.busy) return;
      const f = dp, x = f.x;
      f.busy = true; f.err = null; render();
      try {
        await AE.waymark.call('POST', '/assize/dismiss', { wo: Number(x.wo), rule: x.rule, sig: x.sig, reason: f.reason, note: f.note.trim() });
        AE.track('assize:dismiss');
        if (dp === f) dp = null;
        await loadDismissed(true);
      } catch (e) {
        f.busy = false; f.err = e.storeChanged ? 'Portal switched stores, so nothing was saved.' : "Couldn't dismiss this."; f.errRaw = e.message || String(e);
        if (!e.storeChanged) AE.noteError('Assize dismiss', e);
        render();
      }
    }
    async function restore(d) {
      actErr = null;
      try {
        await AE.waymark.call('POST', '/assize/restore', { wo: Number(d.wo), rule: d.rule, sig: d.sig });
        AE.track('assize:restore');
        await loadDismissed(true);
      } catch (e) { actErr = { text: e.storeChanged ? 'Portal switched stores, so nothing was changed.' : "Couldn't restore this.", raw: e.message || String(e) }; if (!e.storeChanged) AE.noteError('Assize restore', e); render(); }
    }
    // Restore: whoever dismissed it, or a manager (Waymark's role check).
    const canRestore = (d) => isManager || (d.byId != null && me && Number(d.byId) === Number(me.userId));

    // ------------------------------------------------------------ published rules (rule graphs from the admin site)
    // The tracker Worker's answer for this store (GET /v1/:store/assize/rules), at most every 10 minutes, shared by the
    // store's tabs (GM: ae_assize_rules_<store> { at, version, rules }), compiled once per version (R.published). It
    // sends back the version it has, so an unchanged set comes back as "same" without the graphs. A failed fetch
    // keeps the last good copy; none yet = the code rules alone.
    const RULES_MS = 10 * 60 * 1000;
    let pub = null, pubBusy = false; // pub: { store, version, set }
    const readPub = () => GM_getValue(key('rules'), null);
    function pubSet() {
      const x = storeId && readPub();
      if (!x || !x.rules) return null;
      if (!pub || pub.store !== storeId || pub.version !== x.version) {
        try { pub = { store: storeId, version: x.version, set: R.published(x) }; }
        catch (e) { AE.noteError('Assize rules', e); pub = { store: storeId, version: x.version, set: null }; }
        if (pub.set && pub.set.skipped.length) AE.noteError('Assize rules', new Error('skipped (invalid): ' + pub.set.skipped.map((y) => y.rule + ': ' + y.errors[0]).join('; ')));
      }
      return pub.set;
    }
    async function loadRules(force) {
      if (pubBusy || !storeId || !AE.tracker || !AE.tracker.configured() || AE.status.paused('assize')) return;
      const lock = key('rules_at');
      if (!force && Date.now() - GM_getValue(lock, 0) < RULES_MS - 30000) return;
      GM_setValue(lock, Date.now());
      pubBusy = true;
      const asked = storeId, cur = readPub();
      try {
        const j = await AE.tracker.call('GET', '/v1/' + asked + '/assize/rules' + (cur && cur.version ? '?v=' + encodeURIComponent(cur.version) : ''));
        if (asked !== storeId || !j || j.same || !j.rules || typeof j.version !== 'string') return;
        GM_setValue(key('rules'), { at: Date.now(), version: j.version, rules: j.rules });
        compute(); render();
      } catch (e) { if (!e.storeChanged) AE.noteError('Assize rules', e); }
      finally { pubBusy = false; }
    }

    // ------------------------------------------------------------ findings
    let result = null; // { at, open, findings, byWo, sum }
    let sheet = null;
    const priceFor = (device, repair) => {
      if (!sheet || !sheet.data || !AE.priceSheet) return null;
      const r = AE.priceSheet.repairPrices(device, repair, sheet.data);
      return r.rows ? r.prices.map((p) => p.price) : null;
    };
    function compute() {
      const rows = storeId && readRows();
      if (!rows) { result = null; return; }
      const details = readDetails(), now = AE.now();
      const seen = new Set(rows.rows.map((r) => String(r.workorderId)));
      let list = [];
      // rowFresher: this tab's list row was read after the detail was fetched, so the row's status / nickname / bin win (see facts()).
      const dOf = (x) => (x ? Object.assign({}, x.d, { rowFresher: (x.at || 0) <= rows.at }) : null);
      const opts = { now, hours: R.hoursFor(storeId), priceFor }, sh = { orders: 0, compared: 0, mismatches: [], errors: [] };
      // Published rules: a graph (or "off") stands in for its code rule; shadow mode skips those.
      const set = pubSet(), except = set ? new Set([...set.rules.values()].filter((x) => !x.enabled || x.c).map((x) => x.rule)) : null;
      const woOf = (r, d) => String((r && r.workorderId) || (d && d.wo && d.wo.workorderId) || '');
      // Each order's code findings, with the published graphs applied, then the built-in graphs over the same order
      // (shadow mode: compared with the code, never shown).
      const one = (r, d) => {
        const code = R.audit(r, d, opts);
        let found = code;
        if (set) {
          try { const w = R.withGraphs(r, d, opts, set, code); found = w.findings; sh.errors.push(...w.errors.map((x) => Object.assign({}, x, { error: 'published graph: ' + x.error }))); }
          catch (e) { sh.errors.push({ wo: woOf(r, d), rule: '*', error: 'published graphs: ' + ((e && e.message) || String(e)) }); } // the code's findings stand
        }
        list.push(...found);
        try { const x = R.shadow(r, d, opts, code, except); sh.orders++; sh.compared += x.compared; sh.mismatches.push(...x.mismatches); sh.errors.push(...x.errors); }
        catch (e) { sh.errors.push({ wo: woOf(r, d), rule: '*', error: (e && e.message) || String(e) }); }
      };
      for (const r of rows.rows) one(r, dOf(details[r.workorderId]));
      // An order fetched on its own page that wasn't open at the last pass (new since)
      for (const [id, x] of Object.entries(details)) if (!seen.has(String(id))) one(null, x.d);
      try { recordShadow(sh); } catch (e) { AE.noteError('Assize graphs', e); } // shadow mode never stops Assize
      list.push(...R.orphanCleanings(rows.rows, rows.closed || [], AE.data.belongs).filter((x) => !R.isOff(set, x.rule)));
      list = R.sort(list);
      // Dismissed for the store (the rules stay pure; this is where a dismissal applies): out of every count, chip, pill and marker.
      const dm = new Map(dismissed.map((d) => [R.dismissKey(String(d.wo), d.rule, d.sig), d]));
      const gone = [];
      list = list.filter((x) => { const d = dm.get(R.dismissKey(x.wo, x.rule, x.sig)); if (d) gone.push({ x, d }); return !d; });
      const byWo = new Map();
      for (const x of list) { if (!byWo.has(x.wo)) byWo.set(x.wo, []); byWo.get(x.wo).push(x); }
      result = { at: rows.at, open: rows.rows.length, findings: list, byWo, sum: R.summarize(list), dismissed: gone };
    }

    // ------------------------------------------------------------ rule graphs, shadow mode (R.shadow)
    // Where the graphs and the code rules disagree (or a graph errs), per store, newest first, the last 50. Each
    // disagreement is kept once: one that persists only moves its `last` time, written at most every 10 minutes.
    let shadowStat = null;
    function recordShadow(sh) {
      const now = Date.now();
      shadowStat = { at: now, orders: sh.orders, compared: sh.compared, mismatches: sh.mismatches.length, errors: sh.errors.length };
      if (!sh.mismatches.length && !sh.errors.length) return;
      const saved = GM_getValue(key('graphs'), []), log = Array.isArray(saved) ? saved : [];
      let dirty = false;
      for (const x of [...sh.mismatches, ...sh.errors]) {
        const id = [x.wo, x.rule, x.code, x.graph, x.error].join('|'), e = log.find((y) => y.id === id);
        if (e) { if (now - e.last > 10 * 60 * 1000) { e.last = now; dirty = true; } continue; }
        log.unshift(Object.assign({ id, first: now, last: now }, x));
        dirty = true;
      }
      if (dirty) GM_setValue(key('graphs'), log.slice(0, 50));
    }
    AE.hooks.assizeGraphs = () => ({ rules: R.graphs.rules.map((c) => c.rule), skipped: R.graphs.skipped, last: shadowStat,
      published: (() => { const x = storeId && readPub(), set = pubSet(); return x ? { at: x.at, version: x.version, rules: set ? [...set.rules.values()].map((y) => ({ rule: y.rule, scope: y.scope, version: y.version, enabled: y.enabled, graph: !!y.c })) : [], skipped: set ? set.skipped : [] } : null; })(),
      reloadRules: () => loadRules(true),
      log: storeId ? GM_getValue(key('graphs'), []) : [], clear: () => { if (storeId) GM_setValue(key('graphs'), []); } }); // dev tools

    // ------------------------------------------------------------ styles
    document.head.append(h('style', null, `
      .ae-as { --as-fail:var(--aui-status-error,#b91a24); --as-fail-soft:var(--aui-status-error-soft,#ffdad7); --as-fail-on:var(--aui-status-on-error-soft,#410004);
        --as-flag:#a86400; --as-flag-bar:var(--aui-status-warning,#e0a23a); --as-flag-soft:var(--aui-status-warning-soft,#fff0c0); --as-flag-on:var(--aui-status-on-warning-soft,#3a3000);
        --as-note-bar:#9a9aa0; --as-note-soft:var(--aui-neutral-soft,#f1f0f4); --as-note-on:var(--aui-on-surface,#1a1c1e);
        --as-rem:#1f5fbf; --as-rem-soft:#dce9ff; --as-rem-on:#0a2a5c; }
      body.asurion-dark .ae-as { --as-flag:#e0a23a; --as-rem:#7ab0ff; --as-rem-soft:#16335c; --as-rem-on:#d3e5ff; }
      #${PANEL_ID} { position:fixed; z-index:2147483646; width:min(540px, calc(100vw - 16px)); max-height:calc(100vh - 90px); display:flex; flex-direction:column; padding:16px 16px 12px; font-size:14px; line-height:1.4; }
      @media (prefers-reduced-motion: no-preference) { #${PANEL_ID}, #${POP_ID} { animation:sg-in .15s ease-out; } }
      #${PANEL_ID} .hd, #${POP_ID} .hd { display:flex; align-items:center; gap:10px; }
      #${PANEL_ID} .hd b, #${POP_ID} .hd b { font-size:16px; flex:1; }
      #${PANEL_ID} .sum { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin:12px 0 10px; }
      .ae-as-tile { border-radius:12px; padding:8px 10px; display:flex; flex-direction:column; }
      .ae-as-tile .n { font-size:24px; font-weight:700; line-height:1.1; font-variant-numeric:tabular-nums; } .ae-as-tile .l { font-size:12px; }
      .ae-as-tile.fail { background:var(--as-fail-soft); color:var(--as-fail-on); } .ae-as-tile.flag { background:var(--as-flag-soft); color:var(--as-flag-on); }
      .ae-as-tile.note { background:var(--as-note-soft); color:var(--as-note-on); } .ae-as-tile.remind { background:var(--as-rem-soft); color:var(--as-rem-on); }
      .ae-as-tile.zero { opacity:.55; }
      #${PANEL_ID} .flt { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px; }
      .ae-as-f { display:inline-flex; align-items:center; gap:5px; height:26px; padding:0 11px; border-radius:10000rem; border:1px solid var(--aui-outline,#c6c6ca); cursor:pointer;
        font:400 13px/1 Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; background:transparent; color:var(--aui-on-surface,#1a1c1e); }
      .ae-as-f i { font-style:normal; font-size:11px; color:var(--aui-on-surface-soft,#5d5e61); }
      .ae-as-f.on { border:2px solid var(--aui-primary,#8223d2); padding:0 10px; color:var(--aui-primary,#8223d2); font-weight:700; background:var(--aui-primary-soft,#faecff); }
      .ae-as-f.on i { color:inherit; }
      .ae-as-f:focus-visible { outline:2px solid var(--aui-primary,#8223d2); outline-offset:1px; }
      #${PANEL_ID} .list { overflow:auto; margin:0 -4px; padding:0 4px; min-height:0; }
      .ae-as-g { margin:10px 0 2px; font-size:11px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; color:var(--aui-on-surface-soft,#5d5e61); }
      .ae-as-g:first-child { margin-top:2px; }
      .ae-as-r { display:grid; grid-template-columns:4px 1fr auto; gap:0 10px; padding:7px 2px 7px 0; border-top:1px solid var(--aui-outline-soft,#eeedf1); }
      .ae-as-g + .ae-as-r { border-top:0; }
      .ae-as-r .bar { border-radius:2px; grid-row:1/3; }
      .ae-as-r.fail .bar { background:var(--as-fail); } .ae-as-r.flag .bar { background:var(--as-flag-bar); } .ae-as-r.note .bar { background:var(--as-note-bar); } .ae-as-r.remind .bar { background:var(--as-rem); }
      .ae-as-r .t { display:flex; align-items:baseline; gap:6px; min-width:0; white-space:nowrap; }
      .ae-as-r .k { font-weight:700; font-size:13px; } .ae-as-r.fail .k { color:var(--as-fail); } .ae-as-r.flag .k { color:var(--as-flag); } .ae-as-r.remind .k { color:var(--as-rem); }
      .ae-as-r a { color:var(--aui-primary,#8223d2); font-weight:600; text-decoration:none; } .ae-as-r a:hover { text-decoration:underline; }
      .ae-as-r .dv { color:var(--aui-on-surface-soft,#5d5e61); font-size:13px; overflow:hidden; text-overflow:ellipsis; }
      .ae-as-r .ev { font-size:13px; grid-column:2; }
      .ae-as-r .who { grid-row:1/3; grid-column:3; align-self:center; }
      .ae-as-who { display:inline-flex; align-items:center; justify-content:center; min-width:34px; height:22px; padding:0 8px; border-radius:10000rem; box-sizing:border-box;
        font:700 12px/1 Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; background:var(--aui-neutral-soft,#f1f0f4); color:var(--aui-on-surface,#1a1c1e); }
      .ae-as-who.store { background:var(--aui-primary-soft,#faecff); color:var(--aui-on-primary-soft,#590099); }
      .ae-as-who.unassigned { background:transparent; border:1px dashed var(--aui-outline,#c6c6ca); color:var(--aui-on-surface-soft,#5d5e61); font-weight:400; }
      #${PANEL_ID} .ft, #${POP_ID} .ft { margin-top:8px; padding-top:8px; border-top:1px solid var(--aui-outline-soft,#eeedf1); display:flex; gap:8px; align-items:center; }
      #${PANEL_ID} .ft .sg-soft, #${POP_ID} .ft .sg-soft { flex:1; }
      .ae-as-empty { text-align:center; padding:22px 10px 16px; } .ae-as-empty h3 { margin:10px 0 2px; font-size:18px; } .ae-as-empty p { margin:0; }
      .ae-as-r .dm { margin-left:auto; flex:none; border:0; background:transparent; padding:0 4px; height:20px; border-radius:6px; cursor:pointer; opacity:0;
        font:400 12px/1 Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; color:var(--aui-on-surface-soft,#5d5e61); text-decoration:underline; }
      .ae-as-r:hover .dm, .ae-as-r:focus-within .dm, .ae-as-r .dm[aria-expanded="true"] { opacity:1; }
      @media (hover:none) { .ae-as-r .dm { opacity:1; } }
      .ae-as-r .dm:hover { color:var(--aui-on-surface,#1a1c1e); } .ae-as-r .dm:focus-visible { outline:2px solid var(--aui-primary,#8223d2); outline-offset:1px; }
      .ae-as-dp { grid-column:2 / 4; margin:6px 0 2px; padding:8px 10px 10px; border-radius:12px; background:var(--aui-neutral-soft,#f1f0f4); display:flex; flex-direction:column; gap:8px; }
      .ae-as-dp .q { font-size:12px; font-weight:700; color:var(--aui-on-surface-soft,#5d5e61); }
      .ae-as-dp .dpc { display:flex; flex-wrap:wrap; gap:6px; }
      .ae-as-dp input { box-sizing:border-box; width:100%; height:30px; padding:0 10px; border-radius:8px; border:1px solid var(--aui-outline,#c6c6ca); background:var(--aui-surface,#fff); color:inherit; font:400 13px/1 Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; }
      .ae-as-dp input:focus-visible { outline:2px solid var(--aui-primary,#8223d2); outline-offset:1px; }
      .ae-as-dp .act { display:flex; gap:8px; justify-content:flex-end; }
      .ae-as-dp .ae-as-err { margin:0; }
      .ae-as-r.dis .bar { opacity:.5; } .ae-as-r.dis .k { text-decoration:line-through; color:var(--aui-on-surface-soft,#5d5e61); }
      .ae-as-r.dis .who { display:flex; }
      .ae-as-err { margin:8px 0; color:var(--as-fail); font-size:13px; } .ae-as-err a { color:inherit; font-weight:700; }
      #${PILL_ID}.fail { background:var(--as-fail-soft); color:var(--as-fail-on); } #${PILL_ID}.flag { background:var(--as-flag-soft); color:var(--as-flag-on); }
      #${PILL_ID}.note { background:transparent; border-color:var(--aui-outline,#c6c6ca); color:var(--aui-on-surface-soft,#5d5e61); }
      #${POP_ID} { position:fixed; z-index:2147483646; width:min(430px, calc(100vw - 16px)); padding:14px 16px 12px; font-size:14px; line-height:1.4; }
      #${POP_ID} .hd { margin-bottom:4px; }
      .${MK} { vertical-align:middle; border:0; } .${MK} .sg-aicon { box-shadow:none; }
      .${MK}.fail { background:var(--as-fail-soft); color:var(--as-fail-on); } .${MK}.flag { background:var(--as-flag-soft); color:var(--as-flag-on); }
      .${MK}.note { background:var(--aui-neutral-soft,#f1f0f4); color:var(--aui-on-surface,#1a1c1e); box-shadow:inset 0 0 0 1px var(--aui-outline,#c6c6ca); }
      .ae-as-wrap { display:flex !important; align-items:center; gap:6px; min-width:0; flex-wrap:nowrap; }
      .ae-as-wrap > a { min-width:0; overflow:hidden; }
    `));

    // ------------------------------------------------------------ pieces
    const whoChip = (w) => h('span', { class: 'ae-as-who ' + (w.key === 'store' || w.key === 'unassigned' ? w.key : ''), title: w.name }, w.label);
    // The Dismiss form under a finding: why (three chips), an optional note, Dismiss / Cancel.
    function dismissForm() {
      const f = dp;
      const chips = h('div', { class: 'dpc', role: 'radiogroup', 'aria-label': "Why doesn't this apply?" }, ...REASONS.map(([k, label]) =>
        h('button', { type: 'button', role: 'radio', 'aria-checked': String(f.reason === k), class: 'ae-as-f' + (f.reason === k ? ' on' : ''), 'data-fk': 'dr:' + k,
          onclick: (e) => { e.stopPropagation(); f.reason = k; f.err = null; render(); } }, label)));
      const note = h('input', { type: 'text', maxlength: '200', placeholder: 'Note (optional)', 'aria-label': 'Note (optional)', 'data-fk': 'dn', value: f.note,
        oninput: (e) => { f.note = e.target.value; },
        onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); submitDismiss(); } else if (e.key === 'Escape') { e.stopPropagation(); dp = null; render(); } } });
      return h('div', { class: 'ae-as-dp', role: 'group', 'aria-label': 'Dismiss this finding' },
        h('span', { class: 'q' }, "Why doesn't this apply?"), chips, note,
        f.err ? h('div', { class: 'ae-as-err' }, f.err + ' If you keep seeing this, ', AE.bugLinkEl('report a bug', { where: 'Assize dismiss', error: f.errRaw }), '!') : null,
        h('div', { class: 'act' },
          h('button', { type: 'button', class: 'sg-btn', 'data-fk': 'dc', onclick: (e) => { e.stopPropagation(); dp = null; render(); } }, 'Cancel'),
          h('button', { type: 'button', class: 'sg-btn sg-primary', 'data-fk': 'dd', disabled: !f.reason || f.busy || null, title: f.reason ? null : 'Pick a reason first', onclick: (e) => { e.stopPropagation(); submitDismiss(); } }, f.busy ? 'Dismissing…' : 'Dismiss')));
    }
    function rowEl(x, here) {
      const key = R.dismissKey(x.wo, x.rule, x.sig), open = !!dp && dp.key === key && dp.where === (here ? 'pop' : 'panel');
      const dm = canDismiss() ? h('button', { type: 'button', class: 'dm', 'data-fk': 'dm:' + key, 'aria-expanded': String(open), title: "Dismiss: this doesn't apply",
        onclick: (e) => { e.stopPropagation(); dp = open ? null : { key, x, where: here ? 'pop' : 'panel', reason: null, note: '', err: null, busy: false }; actErr = null; render(); } }, 'Dismiss') : null;
      return h('div', { class: 'ae-as-r ' + x.kind },
        h('span', { class: 'bar' }),
        h('div', { class: 't' }, h('span', { class: 'k' }, x.title),
          here ? h('span', { class: 'dv' }, CHECK_NAME[x.check]) : h('a', { href: '/repair/workorder/' + x.wo }, x.wo),
          here ? null : h('span', { class: 'dv' }, [x.device, x.repair].filter(Boolean).join(' · ')), dm),
        h('div', { class: 'ev' }, x.evidence),
        h('div', { class: 'who' }, whoChip(x.who)),
        open ? dismissForm() : null);
    }
    const whenShort = (iso) => { const ms = Date.parse(iso); if (!ms) return ''; return new Date(ms).toDateString() === new Date(AE.now()).toDateString() ? 'today ' + fmtTime(ms) : new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' }); };
    // A dismissed finding, in the Dismissed list.
    function dismissedRow({ x, d }) {
      const note = [d.by || 'Someone', whenShort(d.at), REASON_NAME[d.reason] || d.reason].filter(Boolean).join(' · ') + (d.note ? '. Note: ' + d.note : '');
      return h('div', { class: 'ae-as-r dis ' + x.kind },
        h('span', { class: 'bar' }),
        h('div', { class: 't' }, h('span', { class: 'k' }, x.title), h('a', { href: '/repair/workorder/' + x.wo }, x.wo), h('span', { class: 'dv' }, [x.device, x.repair].filter(Boolean).join(' · '))),
        h('div', { class: 'ev' }, note),
        h('div', { class: 'who' }, canRestore(d)
          ? h('button', { type: 'button', class: 'sg-btn', 'data-fk': 'rs:' + R.dismissKey(x.wo, x.rule, x.sig), title: 'Bring this finding back', onclick: (e) => { e.stopPropagation(); restore(d); } }, 'Restore')
          : h('span', { class: 'sg-soft', title: 'Only ' + (d.by || 'the person who dismissed it') + ' or a manager can restore this' }, '')));
    }
    // Rebuilding the panel on a timer mustn't drop the keyboard: put focus back on the same control.
    function keepFocus(fn) {
      const a = document.activeElement, fk = a && a.dataset && a.dataset.fk, pos = a && a.selectionStart;
      fn();
      if (!fk) return;
      const el = [...document.querySelectorAll('[data-fk]')].find((n) => n.dataset.fk === fk && n.closest('#' + PANEL_ID + ', #' + POP_ID));
      if (el) { el.focus({ preventScroll: true }); if (pos != null && el.setSelectionRange) try { el.setSelectionRange(pos, pos); } catch (_) { /* not a text field */ } }
    }
    const actErrLine = () => (actErr ? h('div', { class: 'ae-as-err' }, actErr.text + ' If you keep seeing this, ', AE.bugLinkEl('report a bug', { where: 'Assize', error: actErr.raw }), '!') : null);
    const kindWords = (s) => [s.fail && s.fail + (s.fail === 1 ? ' fail' : ' fails'), s.flag && s.flag + (s.flag === 1 ? ' flag' : ' flags'), s.note && s.note + ' to check in notes'].filter(Boolean).join(', ');
    const errLine = (prefix) => h('div', { class: 'ae-as-err' }, prefix + ' If you keep seeing this, ', AE.bugLinkEl('report a bug', { where: 'Assize', error: lastError }), '!');

    // ------------------------------------------------------------ header icon
    let icon = null;
    function renderIcon() {
      icon = icon || AE.headerIcon({ id: 'assize', icon: 'assize', order: 5, label: 'Assize', onClick: (e) => togglePanel(e) });
      const s = result && result.sum;
      if (!s) {
        icon.update({ label: lastError ? "Assize couldn't check orders" : 'Assize', detail: lastError ? 'click for details' : 'Checking orders…', badge: lastError ? '?' : '', count: 0, severity: lastError ? 'red' : 'grey', busy });
        return;
      }
      const sev = s.fail ? 'red' : s.flag ? 'amber' : s.note ? 'grey' : 'green';
      icon.update({
        label: lastError && !busy ? "Assize couldn't check orders" : 'Assize' + (s.act || s.note ? ': ' + kindWords(s) : ': nothing to act on'),
        detail: (lastError ? 'last check failed · ' : '') + 'updated ' + fmtTime(result.at) + ' · click for details',
        badge: s.act ? s.act : s.note ? s.note : '✓', count: s.act, severity: sev, busy,
      });
    }

    // ------------------------------------------------------------ panel
    let filter = 'all';
    function renderPanel() { keepFocus(drawPanel); }
    function drawPanel() {
      const p = document.getElementById(PANEL_ID);
      if (!p) return;
      const box = AE.headerIconBox('assize'), r = box && box.rect;
      const w = Math.min(540, innerWidth - 16);
      if (r && !box.floating) { p.style.top = (r.bottom + 8) + 'px'; p.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px'; p.style.bottom = ''; }
      else { p.style.left = '16px'; p.style.bottom = '60px'; p.style.top = ''; }
      const scroll = p.querySelector('.list') ? p.querySelector('.list').scrollTop : 0;
      const close = h('button', { type: 'button', class: 'sg-x', title: 'Close', 'aria-label': 'Close', onclick: () => p.remove() }, '✕');
      const sub = result ? 'Checked ' + fmtTime(result.at) + ' · ' + orders(result.open) : '';
      const head = h('div', { class: 'hd' }, h('span', { html: AE.actionIcon('assize', 26), style: 'line-height:0' }), h('b', null, 'Assize'), h('span', { class: 'sg-soft' }, busy ? (progress && progress.total ? 'Checking ' + Math.min(progress.done + 1, progress.total) + ' of ' + progress.total + '…' : 'Checking orders…') : sub), close);
      const refresh = h('button', { type: 'button', class: 'sg-btn', disabled: busy || null, onclick: (e) => { e.stopPropagation(); AE.track('assize:refresh'); loadRules(true); pass(true, true); } }, 'Refresh');
      const nGone = result ? result.dismissed.length : 0;
      const toggle = canDismiss() ? h('button', { type: 'button', class: 'sg-btn', 'aria-pressed': String(showDismissed), 'data-fk': 'dt', title: 'Findings dismissed at this store',
        onclick: (e) => { e.stopPropagation(); showDismissed = !showDismissed; actErr = null; dp = null; if (showDismissed) loadDismissed(true); renderPanel(); } }, showDismissed ? 'Back to findings' : 'Dismissed (' + nGone + ')') : null;
      const foot = h('div', { class: 'ft' }, h('span', { class: 'sg-soft' }, showDismissed ? 'Dismissed for everyone at this store.' : 'Check notes: a note may explain these, so give them a look.'), toggle, refresh);
      if (!result) { p.replaceChildren(head, lastError ? errLine("Couldn't check orders.") : h('p', { class: 'sg-soft' }, 'Checking orders…'), foot); return; }
      const s = result.sum, all = result.findings;
      const tile = (k, name) => h('div', { class: 'ae-as-tile ' + k + (s[k] ? '' : ' zero') }, h('span', { class: 'n' }, String(s[k])), h('span', { class: 'l' }, name));
      const tiles = h('div', { class: 'sum' }, tile('fail', 'Fails'), tile('flag', 'Flags'), tile('note', 'Check notes'), tile('remind', 'Reminders'));
      const kids = [head, tiles];
      if (lastError) kids.push(errLine("Couldn't check orders."));
      if (showDismissed && canDismiss()) {
        const dl = h('div', { class: 'list' }, ...(result.dismissed.length
          ? [h('p', { class: 'sg-soft', style: 'margin:4px 0 0' }, 'A dismissal ends on its own if the facts behind it change.'), ...result.dismissed.map(dismissedRow)]
          : [h('p', { class: 'sg-soft' }, 'Nothing dismissed right now.')]));
        const ae = actErrLine();
        kids.push(...(ae ? [ae] : []), dl, foot);
        p.replaceChildren(...kids);
        return;
      }
      if (!all.length) {
        kids.push(h('div', { class: 'ae-as-empty' }, h('span', { html: AE.actionIcon('assize', 48) }), h('h3', null, 'Nothing to act on'),
          h('p', { class: 'sg-soft' }, (result.open === 1 ? 'The 1 open order passes' : 'All ' + orders(result.open) + ' pass') + ' the live checks.')), foot);
        p.replaceChildren(...kids);
        return;
      }
      // Filter chips: Everyone, each tech (initials, busiest first), Store. Counts leave reminders out.
      const counted = all.filter((x) => x.kind !== 'remind');
      const techs = new Map();
      for (const x of counted) if (x.who.key.startsWith('u:')) { const c = techs.get(x.who.key) || { who: x.who, n: 0 }; c.n++; techs.set(x.who.key, c); }
      const chips = [['all', 'Everyone', counted.length, 'Everyone']].concat([...techs.values()].sort((a, b) => b.n - a.n).map((c) => [c.who.key, c.who.label, c.n, c.who.name]));
      const storeN = counted.filter((x) => x.who.key === 'store').length, unN = counted.filter((x) => x.who.key === 'unassigned').length;
      if (storeN) chips.push(['store', 'Store', storeN, 'Store']);
      if (unN) chips.push(['unassigned', 'Unassigned', unN, 'Unassigned']);
      if (!chips.some(([k]) => k === filter)) filter = 'all';
      const flt = h('div', { class: 'flt', role: 'group', 'aria-label': 'Filter by tech' }, ...chips.map(([k, label, n, title]) =>
        h('button', { type: 'button', class: 'ae-as-f' + (filter === k ? ' on' : ''), title, 'aria-pressed': String(filter === k), onclick: (e) => { e.stopPropagation(); filter = k; renderPanel(); } }, label, h('i', null, String(n)))));
      const shown = filter === 'all' ? all : all.filter((x) => x.who.key === filter);
      const list = h('div', { class: 'list' });
      for (const [k, name] of R.CHECKS) {
        const rows = shown.filter((x) => x.check === k);
        if (!rows.length) continue;
        list.append(h('div', { class: 'ae-as-g' }, name), ...rows.map((x) => rowEl(x)));
      }
      if (!list.childNodes.length) list.append(h('p', { class: 'sg-soft' }, 'Nothing for ' + (chips.find(([k]) => k === filter) || [, ''])[3] + '.'));
      kids.push(flt, list, foot);
      p.replaceChildren(...kids);
      list.scrollTop = scroll;
    }
    function togglePanel(e) {
      e && e.stopPropagation();
      const p = document.getElementById(PANEL_ID);
      if (p) { p.remove(); return; }
      document.body.append(h('div', { id: PANEL_ID, class: 'sg sg-card ae-as', role: 'dialog', 'aria-label': 'Assize' }));
      renderPanel();
      AE.track('assize:open');
      loadDismissed(false);
      if (!busy && (!result || Date.now() - result.at > SCAN_MS)) pass(true);
    }

    // ------------------------------------------------------------ WO page pill
    const currentWoId = () => { const m = location.pathname.match(/^\/repair\/workorder\/(\d+)/); return m ? m[1] : null; };
    const worstOf = (list) => (list.some((x) => x.kind === 'fail') ? 'fail' : list.some((x) => x.kind === 'flag') ? 'flag' : 'note');
    function renderPill() {
      const woId = currentWoId();
      const list = woId && result ? (result.byWo.get(woId) || []).filter((x) => x.kind !== 'remind') : [];
      const row = woId && AE.woHeadingRow(woId); // core's chip row: Assize goes after Esuna (order 20)
      let pill = document.getElementById(PILL_ID);
      if (!list.length || !row) { pill?.remove(); document.getElementById(POP_ID)?.remove(); return; }
      const sev = worstOf(list), text = list.length === 1 ? '1 finding' : list.length + ' findings';
      const sig = woId + '|' + sev + '|' + text;
      if (!pill) pill = h('button', { id: PILL_ID, type: 'button', class: 'sg ae-as', onclick: (e) => togglePop(e) });
      if (pill.dataset.sig !== sig) {
        pill.dataset.sig = sig;
        pill.className = 'sg ae-as ae-chip has-icon ' + sev;
        pill.title = 'Assize: ' + text + ' on this order';
        pill.innerHTML = AE.actionIcon('assize', 18) + '<span class="ae-t"><span class="ae-n">' + list.length + '</span><span class="ae-lbl"> ' + (list.length === 1 ? 'finding' : 'findings') + '</span></span>';
        pill.setAttribute('aria-label', 'Assize: ' + text);
      }
      AE.woChip(woId, pill, 20);
      if (document.getElementById(POP_ID)) renderPop();
    }
    function renderPop() { keepFocus(drawPop); }
    function drawPop() {
      const pill = document.getElementById(PILL_ID), woId = currentWoId();
      let pop = document.getElementById(POP_ID);
      if (!pill || !woId) { pop?.remove(); return; }
      const order = { fail: 0, flag: 1, note: 2 };
      const list = (result.byWo.get(woId) || []).filter((x) => x.kind !== 'remind').sort((a, b) => order[a.kind] - order[b.kind]);
      if (!pop) { pop = h('div', { id: POP_ID, class: 'sg sg-card ae-as', role: 'dialog', 'aria-label': 'Assize, this order' }); document.body.append(pop); }
      const r = pill.getBoundingClientRect();
      pop.style.top = (r.bottom + 8) + 'px';
      pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)) + 'px';
      pop.replaceChildren(
        h('div', { class: 'hd' }, h('span', { html: AE.actionIcon('assize', 22), style: 'line-height:0' }), h('b', null, 'Assize · this order'),
          h('button', { type: 'button', class: 'sg-x', title: 'Close', 'aria-label': 'Close', onclick: () => pop.remove() }, '✕')),
        ...list.map((x) => rowEl(x, true)),
        h('div', { class: 'ft' }, h('span', { class: 'sg-soft' }, 'Check notes: a note may explain these, so give them a look.')));
      pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)) + 'px';
    }
    function togglePop(e) {
      e.stopPropagation();
      const pop = document.getElementById(POP_ID);
      if (pop) pop.remove(); else { renderPop(); AE.track('assize:wo'); }
    }
    document.addEventListener('click', (e) => {
      const path = e.composedPath();
      for (const [id, owner] of [[PANEL_ID, icon && icon.el], [POP_ID, document.getElementById(PILL_ID)]]) {
        const el = document.getElementById(id);
        if (el && !path.includes(el) && !(owner && path.includes(owner)) && !(id === PANEL_ID && path.some((n) => n && n.id === 'ae-hdr-menu'))) el.remove();
      }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { document.getElementById(PANEL_ID)?.remove(); document.getElementById(POP_ID)?.remove(); } });

    // ------------------------------------------------------------ Work orders list markers
    const onList = () => /^\/repair\/workorders\/?$/.test(location.pathname);
    function custIndex(table) {
      const head = table && table.querySelector('thead tr');
      return head ? [...head.children].findIndex((c) => c.textContent.trim().toLowerCase() === 'customer') : -1;
    }
    function renderList() {
      if (!onList() || !result) { document.querySelectorAll('.' + MK).forEach((m) => { m.parentElement?.classList.remove('ae-as-wrap'); m.remove(); }); return; }
      const idx = new Map();
      for (const tr of document.querySelectorAll('tbody tr')) {
        const a = tr.querySelector('a[href*="/repair/workorder/"]');
        const m = a && a.getAttribute('href').match(/\/repair\/workorder\/(\d+)/);
        if (!m) continue;
        const table = tr.closest('table');
        if (!idx.has(table)) idx.set(table, custIndex(table));
        const cell = tr.children[idx.get(table)];
        const link = cell && cell.querySelector('a[href*="/repair/workorder/"]');
        const wrap = link && link.parentElement;
        if (!wrap) continue;
        const list = (result.byWo.get(m[1]) || []).filter((x) => x.kind !== 'remind');
        const sev = list.length ? worstOf(list) : '';
        let mk = wrap.querySelector(':scope > .' + MK);
        const sig = m[1] + '|' + sev + '|' + list.length;
        if (mk && mk.dataset.sig === sig && mk.previousElementSibling === link) continue;
        mk?.remove();
        if (!list.length) continue;
        mk = h('button', { type: 'button', class: MK + ' ae-as ae-chip mini has-icon ' + sev, 'data-sig': sig, title: 'Assize: ' + list.length + (list.length === 1 ? ' finding' : ' findings') + '. Click to open the WO.',
          html: AE.actionIcon('assize', 14) + list.length, 'aria-label': 'Assize: ' + list.length + (list.length === 1 ? ' finding' : ' findings') });
        mk.onmousedown = (e) => e.stopPropagation();
        mk.onclick = (e) => { e.preventDefault(); e.stopPropagation(); link.click(); };
        wrap.classList.add('ae-as-wrap');
        link.after(mk); // right after the name: Waymark's chips (appended to the same row) stay to its right
      }
    }

    // ------------------------------------------------------------ wiring
    function render() {
      if (!/^\/login/.test(location.pathname)) renderIcon();
      renderPanel();
      renderPill();
      renderList();
    }
    let seenAt = 0, started = false, listSig = '';
    async function start() {
      if (started) return;
      started = true;
      const prof = await AE.profile().catch(() => null);
      if (!prof || prof.storeId == null) { started = false; return; }
      storeId = prof.storeId; me = prof;
      compute(); render();
      if (canDismiss()) {
        AE.waymark.canEdit().then((r) => { isManager = !!(r && r.ok); render(); }).catch(() => {});
        loadDismissed(true);
      }
      if (AE.priceSheet && AE.waymark && AE.waymark.configured()) AE.priceSheet.get().then((v) => { sheet = v && v.data ? v : null; compute(); render(); }).catch(() => {});
      loadRules(false);
      AE.every(60 * 1000, () => { if (!document.hidden) { pass(false); loadRules(false); } compute(); render(); }); // both wait out their shared 10 minutes
      // Another tab's pass: pick up its results.
      AE.every(5000, () => {
        const rows = readRows();
        const dets = Object.values(readDetails()), rl = readPub(), stamp = (rows ? rows.at : 0) + ':' + dets.length + ':' + dets.reduce((m, x) => Math.max(m, x.at || 0), 0) + ':' + ((rl && rl.version) || '');
        if (stamp !== seenAt) { seenAt = stamp; compute(); render(); }
      });
      AE.every(1000, () => { const woId = currentWoId(); if (woId) refreshWo(woId); renderPill(); renderList(); });
      AE.onDom(() => { // Portal redrew its heading or list: put the pill and markers back in the same frame
        if (!result) return;
        if (currentWoId() && !document.getElementById(PILL_ID)) renderPill();
        if (!onList()) return;
        const links = document.querySelectorAll('tbody tr a[href*="/repair/workorder/"]');
        const sig = links.length + '|' + (links[0] && links[0].getAttribute('href')) + '|' + document.querySelectorAll('.' + MK).length;
        if (sig !== listSig) { renderList(); listSig = links.length + '|' + (links[0] && links[0].getAttribute('href')) + '|' + document.querySelectorAll('.' + MK).length; }
      });
      AE.every(1500, () => { if (!/^\/login/.test(location.pathname)) renderIcon(); }); // SPA re-renders can drop the header
    }
    if (!/^\/login/.test(location.pathname)) start();
    else AE.every(2000, () => { if (!started && !/^\/login/.test(location.pathname)) start(); });
    AE.hooks.assizePass = () => pass(true); // dev tools
    AE.on('text-sent', ({ woId }) => { if (woId) invalidate(woId); });
    AE.on('wo-changed', ({ woId }) => { if (woId) invalidate(woId); }); // Recitation's note, Waymark's nickname
  },
});
