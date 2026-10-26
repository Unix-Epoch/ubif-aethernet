/*
  Retrace collection (Oct 23, 2026): the browser side of Retrace, the inventory movement ledger (tracker Worker
  routes /v1/:store/tracker/retrace/…, tracker-worker/src/retrace-api.js; what a movement is: retrace.js, inlined
  below). Not a shard: it runs in the background wherever the tracker runs (AE.tracker.configured()), for this page's
  store only, and stops when Retrace is paused by a notice (AE.status.paused('retrace')) or Portal's store changes.

  A pass every 10 minutes (one tab per browser: its own GM soft lock, like the tracker's scan), Portal calls 300 ms apart:
    1. GET …/retrace/cursor: where the last passes got to (any browser at the store).
    2. Stock (every 30 minutes at most: each lookup call takes 10–14 s): Portal's item lookup sorted by available,
       reserved and in-transit quantity, paged until that quantity reaches 0 (locationType is ignored by Portal, so
       it can't be filtered to the store's stock). Rows → the sweep's items; the Worker answers which items changed.
       Items that drop out of the lookup are sent once with zero quantities (this browser's list of what it sent),
       so a sell-out reads as a change. A lookup with no row at all is a failure (noted, nothing sent, retried next pass).
    2b. Label totals, so the progress bar's denominators are set early instead of growing as labels are found: each lookup
       item the Worker hasn't a count for (it says which, up to 200 a pass) gets one call, store-products/{item}/inventory
       with pageSize=1 and location All (sold included), and Portal's @odata.count is its label count. If Portal sent no
       count, the list is read in full and counted (those snapshots are kept). 404 counts as 0. Once every item has a
       count and the PO total is known, the Worker freezes the baseline (retrace-api.js "Progress"); the PO total is two
       calls (in-transit and past lists, pageSize=1, @odata.count), made only while it's unknown.
    3. Labels of changed items (150 items a pass; the rest wait in this browser for the next pass):
       store-products/{item}/inventory, paged → label snapshots.
    4. Documents: outstanding RMA / buyback / salvage parts, RMA orders of the last 30 days (each new or changed
       one read in full), store transfers both ways, vans, and purchase orders (draft and in transit in full; past
       ones from the last 14 days, plus the whole past list a few pages a pass until it's all been seen).
       TODO: completed counts and buyback orders. Portal answered 500 to their date-filtered lists (Oct 23) and
       their date format is unknown. Their labels still reach the ledger through serial history (Count events)
       and outstanding parts.
       Item names they carry go up too (RMA lines' item_name, transfer lines' itemName; outstanding parts keep their
       list so the Worker reads PartName as descriptive).
    5. One sweep (split under the Worker's caps) with all of it; the Worker answers with the labels whose serial
       history to read (60 a pass), the POs to read in full (15 a pass: header with lines + receive details) and the
       items still without a name (20). Up to 10 of those get Portal's item record read (store-products/{item}: its
       ProductName), sent back with the PO readings as authoritative names; an item whose read failed or had no name
       waits a day in this browser before it's tried again.
    6. Serial history for those labels → POST …/retrace/history. A label whose history names a sales order this
       browser hasn't linked yet also gets its label details read (15 a pass), sent as a snapshot, so the Worker
       learns which WO the sales order belongs to. Over the budget, the sales order stays unlinked at the Worker, which lists
       it in soNeed (asked on the sweep, 50 a pass): up to 25 of those get label details read after the history loop
       (one label each, its newest sales order), sent as snapshots; a real answer with no WorkOrderId goes back as soNone
       (not asked again for a day); a malformed answer is a failed read and comes back.
  One pass per browser at a time: a heartbeat lock in GM storage (lockTake below), so a second tab or a restored browser waits.
  The GM queues it keeps (todo, failures, short lockouts, counts, quantity-only, parked) are written back merged (gmSet / gmMap):
  another tab's additions survive, only this pass's own removals are removed.
  When a pass ends it posts its own counts (Portal calls, Worker calls, seconds, the lookup's seconds, a random id for this
  browser) to POST …/retrace/pass: the admin Usage page's Retrace and Portal load. Optional on the Worker's side.
  Never throws: each step's failure is noted (AE.noteError) and the pass goes on; a signed-out session, a store
  change, a pause or another tab taking the lock stops it. Two Portal 5xx / timeouts in a row (or AE.health tripped) stop the
  pass's Portal reads (its breaker); a record that fails RFAIL_MAX times in a row (an item count, a PO) rests RFAIL_REST_MS so it
  can't stop every pass at the same spot. The result is kept (AE.retrace.last()); AE.retrace.run() runs a pass now.

  The watcher: Portal's own inventory writes (adjust in / out, defective, swaps, van and store transfers, count
  scans, cart part adds / removes, RMA and buyback order calls; retrace.js WATCH_RULES), seen from inside the page
  the moment Portal makes them. A small script in the page wraps fetch and XMLHttpRequest and reports each matching
  call with Portal's answer; it never changes a request or a response (a Request's body is read from a clone made before
  the call goes out, answers from a clone). A 2xx
  becomes movements (retrace.js watchMovements, the signed-in tech as the user), queued in GM storage and sent to
  POST …/retrace/watch a few seconds later and on every pass; a failed send stays queued.
  Dev builds: "Retrace: record Portal calls" (dev tools) keeps the last 50 matching calls, with anything that
  looks like customer data removed, so the real write shapes can be checked against the rules.

  The sandbox (AE_SANDBOX) never calls the Worker: the same calls go to sandbox/api.py's stand-in (/api/sandbox-retrace).
*/
AE.retrace = (() => {
  if (!AE_ON_PORTAL) return { run: async () => null, last: () => null, state: () => null, flush: async () => 0 };
  const R = (() => { /*__RETRACE__*/ })();
  const BROWSER_KEY = 'ae_retrace_browser';
  const PASS_KEY = 'ae_retrace_pass_at', LAST_KEY = 'ae_retrace_last', QUEUE_KEY = 'ae_retrace_watch_q';
  const STOCK_KEY = (s) => 'ae_retrace_stock_' + s, TODO_KEY = (s) => 'ae_retrace_todo_' + s, SO_KEY = (s) => 'ae_retrace_so_' + s, NAMED_KEY = (s) => 'ae_retrace_named_' + s;
  const PASS_MS = 10 * 60 * 1000, LOOKUP_MS = 30 * 60 * 1000, GAP_MS = 300;
  const COUNT_KEY = (s) => 'ae_retrace_count_' + s, COUNT_BUDGET = 200;
  // Quantity-only items (stock, no labels: counted total 0, e.g. the generic SKU 900348): remembered so their quantity changes don't queue a label read that would find nothing.
  // { item: when marked }: an entry expires after QO_DAYS, or as soon as a count read finds labels (an older array form is read as marked now).
  const QO_KEY = (s) => 'ae_retrace_qtyonly_' + s, QO_DAYS = 7;
  // short2: a baseline item is locked out only after a read that SUCCEEDED (2 h); v1 (marked at queue time, 12 h) lost reads and is not read any more.
  // fail: consecutive failed reads per item, kept in the todo until FAIL_MAX, then back to the short list.
  // park: items given up after FAIL_MAX failed reads, { item: when }; back in the todo after PARK_MS (a later pass, maybe a better Portal day).
  const SHORT_KEY = (s) => 'ae_retrace_short2_' + s, FAIL_KEY = (s) => 'ae_retrace_fail_' + s, SHORT_ASK = 300, SHORT_RETRY_MS = 2 * 3600000, FAIL_MAX = 5;
  const PARK_KEY = (s) => 'ae_retrace_park_' + s, PARK_MS = 6 * 3600000;
  // Per-record failures of the deterministic-order lists (item counts 'count:<item>', PO reads 'po:<po>'): { key: { n, at } }. After
  // RFAIL_MAX failures in a row a record rests RFAIL_REST_MS (skipped, noted), then gets one try at a time; a success clears it.
  const RFAIL_KEY = (s) => 'ae_retrace_rfail_' + s, RFAIL_MAX = 5, RFAIL_REST_MS = 6 * 3600000;
  // The pass lock: { owner: this tab's id, at }, refreshed by every call and every BEAT_MS; older than LOCK_MS = its tab is gone.
  const LOCK_KEY = 'ae_retrace_lock', LOCK_MS = 2 * 60000, BEAT_MS = 20000;
  // A big sweep (up to 2,400 items / 800 labels) can take the Worker longer than workerCall's 30 s; its answer's lists are handed out once.
  const SWEEP_TIMEOUT_MS = 90000;
  // The pass's breaker: this many Portal 5xx / timeouts in a row (a single one is just a bad call).
  const DOWN_RUN = 2;
  // Portal answering 5xx / timing out ("Endpoint request timed out", HTTP 504): it's in trouble, the rest of the pass doesn't pile on.
  const httpOf = (e) => (e && e.status) || Number((/HTTP (\d{3})/.exec((e && e.message) || '') || [])[1]) || 0;
  const portalDown = (e) => httpOf(e) >= 500 || /timed out|timeout/i.test((e && e.message) || '');
  const NEED = 60, ITEM_BUDGET = 150, DETAIL_BUDGET = 15, SO_ASK = 50, SO_BUDGET = 25, PO_BUDGET = 15, RMA_BUDGET = 20, NAME_ASK = 20, NAME_BUDGET = 10, NAME_RETRY_MS = 86400000;
  const LOOKUP_PAGES = 30, LIST_PAGES = 10, PO_BACKFILL_PAGES = 2, PO_DAYS = 14, RMA_DAYS = 30;
  const WATCH_BATCH = 50, QUEUE_MAX = 500, QUEUE_DAYS = 3;
  // The Worker's per-request caps (retrace-api.js LIMIT): bigger lists go up in several sweeps.
  const LIMIT = { items: 2400, labels: 800, docs: 200, movements: 500, touched: 500, pos: 600, names: 200, labelTotals: 800 };
  const enabled = () => AE_SANDBOX || AE.tracker.configured();
  const stopped = () => !!AE.storeChanged() || AE.status.paused('retrace');
  class Stop extends Error {}
  class LockLost extends Stop {}
  const check = () => { if (stopped()) throw new Stop('stopped'); };
  const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d; };

  // A random id this browser makes for itself (no name in it): how many browsers collect for a store, on the admin Usage page.
  const browserId = () => { let id = GM_getValue(BROWSER_KEY, ''); if (!id) { id = crypto.randomUUID().slice(0, 12); GM_setValue(BROWSER_KEY, id); } return id; };

  // ---------------------------------------------------------------- calls (counted for the pass's summary)
  let counts = null, downRun = 0; // downRun: Portal 5xx / timeouts in a row this pass (any valid answer, or a 4xx, ends the run)
  async function portal(method, path, body) {
    check();
    if (counts) { counts.portal++; beat(); }
    try { const j = await AE.api(method, path, body); downRun = 0; return j; }
    catch (e) { if (portalDown(e)) downRun++; else if (httpOf(e)) downRun = 0; throw e; }
    finally { await AE.sleep(GAP_MS); }
  }
  async function worker(store, method, path, body, opts) {
    if (counts) { counts.worker++; beat(); }
    if (!AE_SANDBOX) return AE.tracker.call(method, '/v1/' + store + '/tracker/retrace' + path, body, opts);
    if (method !== 'GET') await AE.assertSameStore();
    return AE.api(method, '/api/sandbox-retrace' + path, body, opts);
  }

  /*
    The pass lock (GM storage, every tab of this browser sees it). GM storage isn't atomic: the lock is read back after taking it,
    and a pass that finds another live owner at its next call stops (LockLost). A dead lock (no beat for LOCK_MS) is taken over.
  */
  const TAB = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const lockNow = () => GM_getValue(LOCK_KEY, null);
  const lockLive = (l) => !!(l && l.owner && Date.now() - Number(l.at) < LOCK_MS);
  function lockTake() { // null = taken by this tab; else the live lock of another
    const l = lockNow();
    if (lockLive(l) && l.owner !== TAB) return l;
    GM_setValue(LOCK_KEY, { owner: TAB, at: Date.now() });
    const back = lockNow();
    return back && back.owner === TAB ? null : back;
  }
  function beat() {
    const l = lockNow();
    if (lockLive(l) && l.owner !== TAB) throw new LockLost('another tab took over the Retrace pass');
    GM_setValue(LOCK_KEY, { owner: TAB, at: Date.now() });
  }
  function lockFree() { const l = lockNow(); if (l && l.owner === TAB) GM_deleteValue(LOCK_KEY); }

  /*
    GM queues written back merged: what is stored NOW (another tab may have added to it since this pass read it), plus this
    pass's additions, minus only this pass's own removals. The Worker hands changed / missed items out once, so a late writer's
    plain overwrite would lose them for good.
      gmSet(key)          an ordered list (strings): has, add (to the back), delete, size, list(), save()
      gmMap(key, norm)    { k: v }: get, set, delete, has, keys(), save(keep)   keep(k, v) false = drop on save (expiry, strays)
    save() writes the merge and takes it as the new local view (other tabs' additions included); later saves only apply later changes.
  */
  function gmSet(key) {
    let cur = new Set((GM_getValue(key, []) || []).map(String));
    let added = new Set(), removed = new Set();
    return {
      has: (x) => cur.has(String(x)),
      add(x) { x = String(x); removed.delete(x); added.delete(x); added.add(x); cur.delete(x); cur.add(x); },
      delete(x) { x = String(x); added.delete(x); removed.add(x); cur.delete(x); },
      get size() { return cur.size; },
      list: () => [...cur],
      save() {
        const out = (GM_getValue(key, []) || []).map(String).filter((x) => !removed.has(x) && !added.has(x)).concat([...added]);
        GM_setValue(key, out);
        cur = new Set(out); added = new Set(); removed = new Set();
        return out;
      },
    };
  }
  function gmMap(key, norm) {
    const read = () => { const v = GM_getValue(key, {}) || {}; return norm ? norm(v) : v; };
    let cur = read();
    let sets = new Map(), dels = new Set();
    return {
      get: (k) => cur[k], has: (k) => Object.prototype.hasOwnProperty.call(cur, k), keys: () => Object.keys(cur),
      set(k, v) { k = String(k); dels.delete(k); sets.set(k, v); cur[k] = v; },
      delete(k) { k = String(k); sets.delete(k); dels.add(k); delete cur[k]; },
      save(keep) {
        const out = read();
        for (const k of dels) delete out[k];
        for (const [k, v] of sets) out[k] = v;
        if (keep) for (const [k, v] of Object.entries(out)) if (!keep(k, v)) delete out[k];
        GM_setValue(key, out);
        cur = out; sets = new Map(); dels = new Set();
        return out;
      },
    };
  }
  /*
    One sweep's rows, split into calls under the Worker's caps. The lists named in LIMIT are split across the calls; EVERY other
    field of `body` (need, poNeed, nameNeed, countNeed, shortNeed, cursors, poTotal, and any field added later) goes on the last
    call, by this one rule, so a request field can't be dropped on its way to the Worker again (shortNeed was, until Oct 24).
    The other calls ask for nothing (need 0: the Worker's default for a missing need is a full claim), so the history queue is
    claimed once. → { changedItems, need, more, added, written, rejected, skipped, named, unnamed, countNeed, missedItems,
    shortItems, pos: { need, events, received, written } }
  */
  async function sweep(store, by, body) {
    const n = Math.max(1, ...Object.keys(LIMIT).map((k) => Math.ceil(((body[k] || []).length) / LIMIT[k])));
    const out = { changedItems: [], need: [], more: false, added: 0, written: 0, rejected: 0, skipped: 0, named: 0, unnamed: [], countNeed: [], missedItems: [], shortItems: [], soNeed: [], pos: { need: [], events: 0, received: 0, written: 0 } };
    for (let i = 0; i < n; i++) {
      const last = i === n - 1, part = { by };
      for (const k of Object.keys(LIMIT)) { const s = (body[k] || []).slice(i * LIMIT[k], (i + 1) * LIMIT[k]); if (s.length) part[k] = s; }
      if (last) for (const [k, v] of Object.entries(body)) if (!(k in LIMIT) && k !== 'by' && v != null) part[k] = v;
      if (!last || !Number.isInteger(part.need)) part.need = 0;
      const j = await worker(store, 'POST', '/sweep', part, { timeoutMs: SWEEP_TIMEOUT_MS });
      out.changedItems.push(...(j.changedItems || []));
      out.missedItems.push(...(j.missedItems || [])); // handed out once, on whichever call
      for (const k of ['added', 'written', 'rejected', 'skipped', 'named']) out[k] += j[k] || 0;
      if (j.pos) for (const k of ['events', 'received', 'written']) out.pos[k] += j.pos[k] || 0;
      if (last) { out.need = j.need || []; out.more = !!j.more; out.pos.need = (j.pos && j.pos.need) || []; out.unnamed = j.unnamed || []; out.countNeed = j.countNeed || []; out.shortItems = j.shortItems || []; out.soNeed = Array.isArray(j.soNeed) ? j.soNeed : []; }
    }
    return out;
  }

  // ---------------------------------------------------------------- 2. stock (item lookup)
  const SORTS = [['availablequantity', 'AvailableQuantity'], ['reservedquantity', 'ReservedQuantity'], ['intransitquantity', 'InTransitQuantity']];
  const QTY = ['AvailableQuantity', 'ReservedQuantity', 'InTransitQuantity', 'OnHandQuantity'];
  /*
    One page of the item lookup: { "$id", OnHandItemDetails: [rows], TotalRecords, ErrorMessage, Success, DebugMessage } (captured live
    at 914, Oct 24 2026; fixtures/retrace/inventory-lookup.json). No OnHandItemDetails list = a failed page; so is Success: false (it
    may be absent: only an explicit false fails). TotalRecords isn't used: what it counts for this call isn't captured.
  */
  function lookupPage(j, what) {
    AE.shape.obj(j, ['OnHandItemDetails'], what);
    const list = AE.shape.list(j, 'OnHandItemDetails', what);
    if (j.Success === false) throw new Error(what + ': Portal answered Success: false' + (j.ErrorMessage ? ' (' + String(j.ErrorMessage).slice(0, 120) + ')' : ''));
    return list;
  }
  /*
    The whole lookup or nothing. Each of the three sorts must END: a short page (the catalog's end) or a page whose last row has none of
    that quantity. A failed or malformed page, or LOOKUP_PAGES pages with stock still in the tail, throws: nothing is recorded or sent,
    since every item the lookup didn't reach would be sent at 0 (a false sell-out) and, the first time, counted as the whole store.
  */
  async function stock(store) {
    const rows = new Map(); // item|warehouse → row
    let read = 0, other = 0;
    for (const [field, qty] of SORTS) {
      let ended = false;
      for (let page = 1; page <= LOOKUP_PAGES; page++) {
        const list = lookupPage(await portal('GET', '/api/boh/inventory-lookup?pageSize=100&page=' + page + '&searchTerm=&locationType=0&categoryFilter=&sortField=' + field + '&sortOrder=desc'), 'item lookup (' + field + ', page ' + page + ')');
        for (const r of list) {
          if (!r || r.ItemNumber == null) continue;
          read++;
          if (r.SiteId != null && /^\d+$/.test(String(r.SiteId)) && Number(r.SiteId) !== Number(store)) { other++; continue; } // another store's row (not seen; just in case)
          if (QTY.some((k) => Number(r[k]) > 0)) rows.set(r.ItemNumber + '|' + r.WarehouseId, r);
        }
        const tail = list[list.length - 1];
        if (list.length < 100 || !(tail && Number(tail[qty]) > 0)) { ended = true; break; }
      }
      if (!ended) throw new Error('the item lookup by ' + field + ' still had stock after ' + LOOKUP_PAGES + ' pages: nothing sent (the items it never reached would read as sold out)');
    }
    // No row with stock at all is a failed lookup, not an empty store: nothing is sent (it would zero every item and, the first time, count
    // as "every item counted"). The note says what came back, to tell Portal's answer shape from the store filter.
    if (!rows.size) throw new Error('the item lookup gave no rows with stock (' + read + ' item rows read, ' + other + ' of another store)');
    /*
      The Worker keeps each item's quantities per warehouse as sent, whole. So an item is always sent with every
      warehouse it was sent with before (0 where it's gone now), and an item gone from the lookup is sent once at 0
      and then forgotten: its quantities read as changed and its labels get read.
    */
    const before = GM_getValue(STOCK_KEY(store), {}) || {}, now = {}, items = [];
    for (const r of rows.values()) (now[r.ItemNumber] = now[r.ItemNumber] || new Set()).add(String(r.WarehouseId));
    const zero = (item, wh) => ({ ItemNumber: item, WarehouseId: wh, OnHandQuantity: 0, AvailableQuantity: 0, ReservedQuantity: 0, InTransitQuantity: 0, SalesOnOrder: 0 });
    for (const r of rows.values()) items.push(r);
    for (const [item, whs] of Object.entries(now)) for (const wh of before[item] || []) if (!whs.has(wh)) { items.push(zero(item, wh)); whs.add(wh); }
    for (const [item, whs] of Object.entries(before)) if (!now[item]) for (const wh of whs) items.push(zero(item, wh));
    return { items, keep: Object.fromEntries(Object.entries(now).map(([k, v]) => [k, [...v]])) };
  }

  // ---------------------------------------------------------------- 3. labels of an item
  /*
    An item's label list answers { "@odata.context", "@odata.count": N, "value": [rows] } (captured live at store 914, Oct 24 2026;
    tracker-worker/test/fixtures/retrace/store-products.json). A real zero is @odata.count 0 with value []. An answer without both
    keys (a {}, a string, another envelope) is a FAILED read, never "no labels": the item stays queued and nothing is marked
    quantity-only or locked out. A count above the rows returned is not an error (sold labels aren't listed).
  */
  function labelPage(j, what) {
    AE.shape.obj(j, ['@odata.count', 'value'], what);
    const list = AE.shape.list(j, 'value', what), count = j['@odata.count'];
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) throw AE.shape.bad(what, '@odata.count is not a whole number', count);
    return { list, count };
  }
  async function labelsOf(store, item) {
    const out = [];
    for (let page = 1; page <= 20; page++) {
      const j = await portal('GET', '/api/boh/store-products/' + encodeURIComponent(item) + '/inventory?pageSize=200&page=' + page + '&searchTerm=&warehouseType=All&warehouseId=' + store);
      const { list, count } = labelPage(j, 'labels of item ' + item);
      for (const r of list) { const s = R.labelSnapshot(r); if (s) out.push(s); }
      if (list.length < 200 || (count && page * 200 >= count)) break;
    }
    return out;
  }

  // An item's label count for the baseline: the list's own @odata.count at pageSize=1 (one tiny call). The answer must carry it
  // (labelPage): no numeric count is a failed read, not 0. Portal has no record (404): 0.
  async function labelTotal(store, item) {
    try {
      const j = await portal('GET', '/api/boh/store-products/' + encodeURIComponent(item) + '/inventory?pageSize=1&page=1&searchTerm=&warehouseType=All&warehouseId=' + store);
      return { item: String(item), total: labelPage(j, 'label count of item ' + item).count };
    } catch (e) { if (httpOf(e) === 404) return { item: String(item), total: 0 }; throw e; }
  }
  // How many purchase orders Portal lists (in transit + past; drafts come and go): the list calls' @odata.count at pageSize=1. null when any lacks one.
  async function poTotal() {
    let sum = 0;
    for (const orderType of ['in-transit', 'past']) {
      const j = await portal('POST', '/api/boh/purchase-orders?pageSize=1&page=1&searchTerm=', { orderType });
      const n = j && !Array.isArray(j) ? j['@odata.count'] : null;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return null;
      sum += n;
    }
    return sum;
  }

  // Portal's item record (the item page's header call): its ProductName, null when it has none.
  async function itemName(store, item) {
    const j = await portal('GET', '/api/boh/store-products/' + encodeURIComponent(item) + '?warehouseType=All&warehouseId=' + store);
    const h = j && !Array.isArray(j) && (j.ProductName != null || j.productName != null) ? j : R.rowsOf(j)[0] || {};
    const name = h.ProductName ?? h.productName;
    return typeof name === 'string' && name.trim() ? { item: String(item), name: name.trim(), authoritative: true } : null;
  }

  // ---------------------------------------------------------------- 4. documents
  // Portal's list envelopes (the ones R.rowsOf reads). An answer that is none of them is a failed read, not an empty list.
  const ENVELOPES = ['value', 'data', 'results', 'items', 'rows', 'orders', 'transferOrders', 'OnHandItemDetails'];
  function listOf(j, what) {
    const rows = R.rowsOf(j);
    if (!rows.length && !Array.isArray(j) && !(AE.shape.isObj(j) && ENVELOPES.some((k) => Array.isArray(j[k])))) throw AE.shape.bad(what, 'no list in the answer', j);
    return rows;
  }
  async function pages(path, method, body, size) {
    const all = [];
    for (let page = 1; page <= LIST_PAGES; page++) {
      const j = await portal(method, path.replace('{page}', page), body);
      const list = listOf(j, path.replace(/\?.*$/, ''));
      all.push(...list);
      const total = j && Number(j['@odata.count']);
      if (list.length < size || (total && page * size >= total)) break;
    }
    return all;
  }
  async function docs(store, cursors, acc, note, trouble) {
    const at = new Date().toISOString();
    const step = async (name, fn) => {
      if (trouble.on) return; // Portal is timing out: no more calls this pass
      try { await fn(); } catch (e) {
        if (e instanceof Stop || e.storeChanged || /session expired/i.test(e.message || '')) throw e;
        note(name, e);
        trouble.mark(name); // the breaker itself counts the 5xx / timeouts in a row (portal())
      }
    };
    await step('outstanding parts', async () => {
      const parts = await portal('GET', '/api/boh/rma-buyback/outstanding-parts');
      // { RMAParts, BuybackParts, SalvageParts } (fixtures/retrace/outstanding-parts.json): none of the three lists = a failed read
      if (!AE.shape.isObj(parts) || !['RMAParts', 'BuybackParts', 'SalvageParts'].some((k) => Array.isArray(parts[k]))) throw AE.shape.bad('outstanding parts', 'none of RMAParts / BuybackParts / SalvageParts', parts);
      const snaps = R.normalize.outstanding(parts);
      acc.labels.push(...snaps); // list stays: the Worker reads their PartName as a descriptive name
      acc.touched.push(...snaps.map((s) => s.label));
    });
    await step('rma orders', async () => {
      const q = '?startDate=' + ymd(daysAgo(RMA_DAYS)).replace(/-/g, '') + '&endDate=' + ymd(new Date()).replace(/-/g, '') + '&searchTerm=&orderStatus=&pageSize=50&page={page}';
      const rows = await pages('/api/boh/rma-buyback/rma-orders' + q, 'GET', undefined, 50);
      const seen = (cursors.rma && cursors.rma.value && cursors.rma.value.seen) || {}, next = {};
      let read = 0;
      for (const r of rows) {
        const d = R.normalize.doc('rma', r);
        if (!d) continue;
        acc.docs.push(Object.assign({ type: 'rma' }, d));
        const status = d.status || '';
        if (seen[d.id] === status) { next[d.id] = status; continue; } // read already at this status
        if (read >= RMA_BUDGET || trouble.on) continue; // over budget: next pass (not marked seen)
        read++;
        // Marked seen only once its full read is a real order (normalize.doc finds its RMAPurchId; fixtures/retrace/rma-order.json): a failed or
        // malformed read leaves it unseen, so the next pass reads it again.
        let o;
        try { o = await portal('GET', '/api/boh/rma-order/' + encodeURIComponent(d.id)); }
        catch (e) { if (e instanceof Stop || e.storeChanged || /session expired/i.test(e.message || '')) throw e; note('rma order ' + d.id, e); continue; }
        const full = R.normalize.doc('rma', o);
        if (!full) { note('rma order ' + d.id, AE.shape.bad('rma order ' + d.id, 'no RMA order id', o)); continue; }
        next[d.id] = status;
        acc.docs.push(Object.assign({ type: 'rma' }, full));
        for (const l of (o && Array.isArray(o.details) ? o.details : [])) if (l && l.item_id != null && l.item_name) acc.names.push({ item: String(l.item_id), name: l.item_name });
        const moves = R.normalize.rma(o, { at });
        acc.movements.push(...moves);
        acc.touched.push(...moves.map((m) => m.label));
      }
      acc.cursors.rma = { seen: Object.fromEntries(Object.entries(next).slice(-150)) };
    });
    await step('store transfers', async () => {
      for (const dir of ['receive', 'transfer']) {
        for (const r of await pages('/api/boh/store-transfer-orders?page={page}&pageSize=50&direction=' + dir, 'GET', undefined, 50)) {
          const d = R.normalize.doc('transfer', r);
          if (d) acc.docs.push(Object.assign({ type: 'transfer' }, d));
          const moves = R.normalize.transfer(r, { store, warehouses: [String(store), store + 'Q'] });
          acc.movements.push(...moves);
          for (const l of (r && Array.isArray(r.lines) ? r.lines : [])) {
            const x = R.cleanLabel(l && l.serialNumber);
            if (x) acc.touched.push(x);
            if (l && l.itemNumber != null && l.itemName) acc.names.push({ item: String(l.itemNumber), name: l.itemName });
          }
        }
      }
    });
    await step('vans', async () => {
      for (const r of listOf(await portal('GET', '/api/boh/remote-tech/van-warehouses'), 'van warehouses')) { const d = R.normalize.doc('van', r); if (d) acc.docs.push(Object.assign({ type: 'van' }, d)); }
    });
    // POs: list rows go up as they are; the Worker keeps their status history and says which to read in full.
    await step('purchase orders', async () => {
      const list = (body) => pages('/api/boh/purchase-orders?pageSize=50&page={page}&searchTerm=', 'POST', body, 50);
      acc.pos.push(...(await list({ orderType: 'draft' })), ...(await list({ orderType: 'in-transit' })),
        ...(await list({ orderType: 'past', startDate: ymd(daysAgo(PO_DAYS)), endDate: ymd(new Date()) })));
      // The whole past list (no dates: every past PO), a few pages a pass, once.
      const bf = (cursors.po_backfill && cursors.po_backfill.value) || { page: 1, done: false };
      if (!bf.done) {
        let page = bf.page, done = false;
        for (let i = 0; i < PO_BACKFILL_PAGES && !done; i++, page++) {
          const j = await portal('POST', '/api/boh/purchase-orders?pageSize=50&page=' + page + '&searchTerm=', { orderType: 'past' });
          const rows = listOf(j, 'purchase orders backfill'), total = j && Number(j['@odata.count']); // a bad answer throws: the backfill page is not marked done
          acc.pos.push(...rows);
          done = rows.length < 50 || (total > 0 && page * 50 >= total);
        }
        acc.cursors.po_backfill = { page, done };
      }
    });
  }

  // ---------------------------------------------------------------- the pass
  let running = false, runStart = 0;
  let skip = null; // why the last call to run() did nothing, for the dev tools
  const skipped = (why) => { skip = { at: new Date().toISOString(), why }; return null; };
  const fatal = (e) => e instanceof Stop || e.storeChanged || /session expired/i.test((e && e.message) || ''); // stops the whole pass
  async function run(opts = {}) {
    if (!enabled()) return skipped('not enabled: no tracker Worker in this build');
    if (running) return skipped('a pass is already running (started ' + Math.round((Date.now() - runStart) / 1000) + ' s ago)');
    if (stopped()) return skipped(AE.storeChanged() ? "paused: Portal's store changed, reload the page" : 'paused by a notice');
    if (!opts.force && Date.now() - GM_getValue(PASS_KEY, 0) < PASS_MS - 30000) return skipped('next pass not due yet (last started ' + new Date(GM_getValue(PASS_KEY, 0)).toLocaleTimeString() + ')');
    if (!opts.force && AE.health.down()) return skipped('Portal is down (AE.health): waiting for its next probe');
    const held = lockTake();
    if (held) return skipped('another tab is running a pass (its lock was refreshed ' + Math.round((Date.now() - held.at) / 1000) + ' s ago)');
    running = true; runStart = Date.now();
    GM_setValue(PASS_KEY, Date.now());
    const beatTimer = setInterval(() => { try { if (running) beat(); } catch (_) { /* the next call stops the pass */ } }, BEAT_MS);
    const t0 = Date.now();
    counts = { portal: 0, worker: 0 }; downRun = 0;
    let passStore = null; // set once the store is known: the pass's own counts go to the Worker when it ends
    const result = { at: new Date().toISOString(), seconds: 0, calls: counts, watched: 0, lookup: null, items: 0, changedItems: 0, itemsRead: 0, itemsWaiting: 0, itemsFailed: 0, itemsParked: 0, itemsUnparked: 0, shortQueued: 0, shortSkippedTried: 0, portalTrouble: false, labels: 0, docs: 0,
      movements: 0, counted: 0, pos: 0, poDetails: 0, histories: 0, historyRows: 0, details: 0, detailsDeferred: 0, soNeed: 0, soRead: 0, soNone: 0, added: 0, names: 0, named: 0, unnamed: 0, namesRead: 0, resting: [], backlogMore: false, errors: [] };
    const note = (where, e) => {
      if (result.errors.length < 8) result.errors.push(where + ': ' + ((e && e.message) || e));
      if (!result.firstError) result.firstError = where + ': ' + ((e && e.message) || e);
      AE.noteError('retrace ' + where, e);
    };
    // The pass's breaker: DOWN_RUN Portal 5xx / timeouts in a row (portal() counts them), or AE.health tripped (Portal down for the whole
    // tab), except in a forced pass (the dev tools' Run now). Item / count / PO / history reads stop for the rest of the pass.
    const trouble = {
      get on() { return downRun >= DOWN_RUN || (!opts.force && AE.health.tripped()); },
      mark(where) { if (this.on) { result.portalTrouble = true; if (!result.troubleAt) result.troubleAt = where; } },
    };
    try {
      const p = await AE.profile();
      if (!p || !p.storeId) throw new Error('No current store');
      const store = p.storeId, by = p.name;
      passStore = store; result.store = store;
      try { result.watched = await flush(store); } catch (e) { if (e.storeChanged || e instanceof Stop) throw e; note('watch queue', e); }
      const cur = await worker(store, 'GET', '/cursor'), cursors = cur.cursors || {}, baseline = cur.baseline || {};
      const acc = { items: [], labels: [], docs: [], movements: [], touched: [], pos: [], names: [], cursors: {}, labelTotals: [] };
      const nowMs = Date.now();
      // This pass's view of the GM queues (merged back on every save: see gmSet / gmMap).
      const todo = gmSet(TODO_KEY(store)), fails = gmMap(FAIL_KEY(store)), park = gmMap(PARK_KEY(store)), rfail = gmMap(RFAIL_KEY(store));
      const qtyOnly = gmMap(QO_KEY(store), (v) => (Array.isArray(v) ? Object.fromEntries(v.map((x) => [String(x), nowMs])) : v));
      const count = gmSet(COUNT_KEY(store));
      const qoKeep = (k, at) => nowMs - Number(at) < QO_DAYS * 86400000;
      const isQo = (i) => qtyOnly.has(String(i)) && qoKeep(String(i), qtyOnly.get(String(i)));
      const resting = (k) => { const x = rfail.get(k); return !!x && x.n >= RFAIL_MAX && nowMs - x.at < RFAIL_REST_MS; };
      const failedRec = (k) => { const x = rfail.get(k); rfail.set(k, { n: ((x && x.n) || 0) + 1, at: Date.now() }); };
      const saveRfail = () => rfail.save((k, x) => x && Date.now() - x.at < 7 * 86400000);
      // Items parked after FAIL_MAX failed reads come back after PARK_MS.
      for (const i of park.keys()) if (nowMs - Number(park.get(i)) >= PARK_MS) { park.delete(i); if (!isQo(i)) { todo.add(i); result.itemsUnparked++; } }
      if (result.itemsUnparked) { todo.save(); park.save(); }
      // Items still to count for the baseline: the stock sweep's answer, else what the last pass was told (frozen = none).
      let countNeed = baseline.frozen ? [] : count.list();

      // 2. stock, at most every 30 minutes (any browser at the store: the cursor)
      const lastLookup = cursors.lookup && cursors.lookup.value && Date.parse(cursors.lookup.value.at);
      if (opts.lookup || !lastLookup || Date.now() - lastLookup > LOOKUP_MS - 60000) {
        try {
          const lt = Date.now(), st = await stock(store);
          const sw = await sweep(store, by, { items: st.items, cursors: { lookup: { at: new Date().toISOString(), rows: st.items.length } }, countNeed: baseline.frozen ? 0 : COUNT_BUDGET });
          if (!baseline.frozen) countNeed = sw.countNeed;
          GM_setValue(STOCK_KEY(store), st.keep);
          result.lookup = { rows: st.items.length, seconds: Math.round((Date.now() - lt) / 1000) };
          result.items = st.items.length; result.changedItems = sw.changedItems.length;
          for (const c of sw.changedItems) if (!isQo(c.item)) todo.add(c.item);
          // The Worker hands a changed / new item out once: kept now, not at the end of the pass (a pass cut short by the counting below, a reload, a session
          // expiry would lose the whole list; Oct 24 store 914 lost 500+ new items' label reads that way).
          todo.save();
        } catch (e) { if (fatal(e)) throw e; note('stock', e); trouble.mark('stock'); }
      }
      // 2b. label totals for the baseline: asked of the Worker when this pass didn't just do the lookup, then one tiny call per item
      if (!baseline.frozen) {
        if (!countNeed.length) { try { countNeed = (await sweep(store, by, { countNeed: COUNT_BUDGET, need: 0 })).countNeed; } catch (e) { if (fatal(e)) throw e; note('count list', e); } }
        let asked = 0;
        for (const raw of countNeed) {
          const item = String(raw);
          if (asked >= COUNT_BUDGET) break;
          if (trouble.on) { trouble.mark('count ' + item); break; } // Portal is in trouble: the other items' counts wait for a later pass
          if (resting('count:' + item)) { if (result.resting.length < 20) result.resting.push('count:' + item); continue; } // failed RFAIL_MAX times: rests, the rest go on
          asked++;
          try {
            const t = await labelTotal(store, item); acc.labelTotals.push({ item: t.item, total: t.total }); result.counted++; // total comes only from a valid count answer (or a 404)
            rfail.delete('count:' + item); count.delete(item);
            if (t.total === 0) { qtyOnly.set(t.item, Date.now()); todo.delete(t.item); result.quantityOnly = (result.quantityOnly || 0) + 1; } // 404 or 0: quantity-only
            else if (qtyOnly.has(t.item)) qtyOnly.delete(t.item); // labels now: no longer quantity-only
          }
          catch (e) { if (fatal(e)) throw e; note('count ' + item, e); failedRec('count:' + item); trouble.mark('count ' + item); }
        }
        qtyOnly.save(qoKeep); todo.save(); saveRfail();
        if (!baseline.posKnown) {
          try { acc.poTotal = await poTotal(); } catch (e) { if (fatal(e)) throw e; note('po total', e); }
        }
      }
      // 3. labels of changed items, a budget a pass. An item leaves the todo only once the sweep below has delivered its labels (they are held in
      // `acc` until then: a pass cut short between the read and the sweep used to lose them for good). A failed read keeps the item, with a count;
      // after FAIL_MAX it is parked (PARK_MS) and comes back by itself.
      const readOk = new Set();
      for (const item of todo.list().slice(0, ITEM_BUDGET)) {
        if (trouble.on) { trouble.mark('labels ' + item); break; }
        try { acc.labels.push(...(await labelsOf(store, item))); readOk.add(item); result.itemsRead++; }
        catch (e) {
          if (fatal(e)) throw e;
          note('labels ' + item, e); result.itemsFailed++;
          const n = (Number(fails.get(item)) || 0) + 1;
          trouble.mark('labels ' + item);
          if (n >= FAIL_MAX) { todo.delete(item); fails.delete(item); park.set(item, Date.now()); result.itemsParked++; } // parked: back after PARK_MS
          else { fails.set(item, n); todo.add(item); } // to the back of the queue
        }
      }
      const saveQueues = () => { todo.save(); fails.save((k) => todo.has(k)); park.save(); }; // a failure count of an item no longer queued is a stray
      saveQueues();
      result.itemsWaiting = todo.size;

      // 4. documents, then 5. one sweep with everything
      await docs(store, cursors, acc, note, trouble);
      if (trouble.on) result.portalTrouble = true;
      acc.touched = [...new Set(acc.touched.filter(Boolean))];
      Object.assign(result, { labels: acc.labels.length, docs: acc.docs.length, movements: acc.movements.length, pos: acc.pos.length, names: acc.names.length });
      const sw = await sweep(store, by, Object.assign({}, acc, { need: NEED, poNeed: PO_BUDGET, nameNeed: NAME_ASK, countNeed: baseline.frozen ? 0 : COUNT_BUDGET, shortNeed: baseline.frozen ? SHORT_ASK : 0, soNeed: SO_ASK }));
      if (baseline.frozen) GM_setValue(COUNT_KEY(store), []);
      else { for (const i of sw.countNeed) if (!count.has(i)) count.add(i); count.save(); }
      // The labels are delivered: the items read leave the todo, and (short list) are locked out for SHORT_RETRY_MS. Only a read that succeeded locks.
      const shortTried = gmMap(SHORT_KEY(store));
      for (const i of readOk) { todo.delete(i); fails.delete(i); shortTried.set(i, nowMs); }
      // Items the Worker's coverage check found referenced but never read: their label lists, next (a budget a pass, like a changed item's)
      for (const i of sw.missedItems) if (!isQo(i)) todo.add(i);
      // Baseline items with fewer labels stored than Portal counts (their read was lost, or never made): read like a changed item, skipping those read
      // successfully within SHORT_RETRY_MS (a list can stay short for a reason the read can't fix, e.g. sold labels it doesn't list).
      const shortAll = (sw.shortItems || []).map(String).filter((x) => !isQo(x) && !todo.has(x) && !park.has(x));
      const shortFresh = shortAll.filter((x) => !(nowMs - (shortTried.get(x) || 0) < SHORT_RETRY_MS));
      result.shortSkippedTried = shortAll.length - shortFresh.length;
      for (const i of shortFresh.slice(0, ITEM_BUDGET)) { todo.add(i); result.shortQueued++; }
      shortTried.save((k, t) => nowMs - t < SHORT_RETRY_MS);
      saveQueues();
      result.itemsWaiting = todo.size;
      result.added += sw.added; result.backlogMore = sw.more; result.named += sw.named; result.unnamed = sw.unnamed.length;
      if (sw.pos) result.poEvents = sw.pos.events;

      // POs to read in full: header (lines) + receive details. Both must be objects (fixtures/retrace/po-header.json, po-receive.json): a PO
      // whose receive read failed is not sent at all (sent with receive null, the Worker would take it as fully read); it stays queued there.
      const full = [];
      for (const po of sw.pos.need.slice(0, PO_BUDGET)) {
        if (trouble.on) { trouble.mark('po ' + po); break; }
        if (resting('po:' + po)) { if (result.resting.length < 20) result.resting.push('po:' + po); continue; }
        try {
          const header = await portal('GET', '/api/boh/purchase-orders/' + encodeURIComponent(po));
          if (!AE.shape.isObj(header)) throw AE.shape.bad('po ' + po, 'no PO header', header);
          let receive;
          try { receive = await portal('GET', '/api/boh/purchase-orders/' + encodeURIComponent(po) + '/receive-details'); }
          catch (e) { if (fatal(e)) throw e; note('po receive ' + po, e); failedRec('po:' + po); trouble.mark('po receive ' + po); continue; }
          if (!AE.shape.isObj(receive)) { note('po receive ' + po, AE.shape.bad('po receive ' + po, 'no receive details', receive)); failedRec('po:' + po); continue; }
          full.push({ header, receive });
          rfail.delete('po:' + po);
        } catch (e) { if (fatal(e)) throw e; note('po ' + po, e); failedRec('po:' + po); trouble.mark('po ' + po); }
      }
      saveRfail();
      // Items still without a name: Portal's item record, a budget a pass (one tried lately is skipped)
      const tried = GM_getValue(NAMED_KEY(store), {}) || {}, names = [];
      for (const item of trouble.on ? [] : sw.unnamed.filter((i) => !(Date.now() - (tried[i] || 0) < NAME_RETRY_MS)).slice(0, NAME_BUDGET)) {
        try { const n = await itemName(store, item); result.namesRead++; if (n) names.push(n); else tried[item] = Date.now(); }
        catch (e) { if (fatal(e)) throw e; if (httpOf(e) !== 404) note('name ' + item, e); tried[item] = Date.now(); } // 404: Portal has no record
      }
      GM_setValue(NAMED_KEY(store), Object.fromEntries(Object.entries(tried).filter(([, t]) => Date.now() - t < NAME_RETRY_MS)));
      if (full.length || names.length) {
        const r = await sweep(store, by, { pos: full, names });
        result.poDetails = full.length; result.added += r.added; result.named += r.named; result.poEvents = (result.poEvents || 0) + r.pos.events;
      }

      // 6. serial history for the labels the Worker handed out; label details for unlinked sales orders
      const sos = new Set(GM_getValue(SO_KEY(store), []) || []), snaps = [];
      for (const label of sw.need) {
        if (trouble.on) { trouble.mark('history ' + label); break; }
        try {
          const h = await portal('GET', '/api/boh/serial-history/' + encodeURIComponent(label));
          // { value: [rows] } (vault Inventory.md; fixtures/retrace/serial-history.json). Anything else ({}, an error envelope, null, a
          // string) is a FAILED read: nothing is posted, so the label stays queued at the Worker and is handed out again.
          AE.shape.obj(h, ['value'], 'serial history ' + label);
          const rows = AE.shape.list(h, 'value', 'serial history ' + label);
          const j = await worker(store, 'POST', '/history', { label, rows, by });
          result.histories++; result.historyRows += rows.length; result.added += j.added || 0;
          const so = rows.map((r) => r && r.RefTable && /^sales orders?$/i.test(r.RefTable) && r.SourceKey).filter(Boolean).pop();
          if (so && !sos.has(so) && result.details < DETAIL_BUDGET) {
            result.details++;
            try {
              const d = await portal('GET', '/api/boh/inventory/' + encodeURIComponent(label) + '?includeQuarantineInfo=true&includeSalvageInfo=true');
              const sn = R.labelSnapshot(d);
              // The sales order counts as linked only once its label details read is a real label (fixtures/retrace/label-details.json).
              if (sn) { snaps.push(sn); sos.add(so); } else note('label details ' + label, AE.shape.bad('label details ' + label, 'no usable label', d));
            } catch (e) { if (fatal(e)) throw e; note('label details ' + label, e); trouble.mark('label details ' + label); }
          } else if (so && !sos.has(so)) result.detailsDeferred++; // over budget: the Worker still lists this sales order in soNeed (no inv_so_wo row), read below / next pass
        } catch (e) { if (fatal(e)) throw e; note('history ' + label, e); trouble.mark('history ' + label); }
      }
      /*
        Sales orders the Worker lists as unlinked (soNeed: no inv_so_wo row), each with one label whose newest sales order it is: its label details
        (fixtures/retrace/label-details.json: SalesOrderNumber + WorkOrderId) are read and posted as a snapshot, which links them. The answer must be a
        real label (an object naming the label asked for, with a status): anything else is a FAILED read, nothing is recorded, the Worker's claim
        runs out and it comes back. A real label whose details carry no WorkOrderId for that sales order is the "no WO" case: soNone tells the Worker,
        which doesn't ask again for a day.
      */
      const soNone = [], soAsk = (sw.soNeed || []).filter((x) => x && x.sales_order && x.label);
      result.soNeed = soAsk.length;
      for (const x of soAsk.slice(0, SO_BUDGET)) {
        if (trouble.on) { trouble.mark('sales order ' + x.sales_order); break; }
        try {
          const d = await portal('GET', '/api/boh/inventory/' + encodeURIComponent(x.label) + '?includeQuarantineInfo=true&includeSalvageInfo=true');
          const sn = AE.shape.isObj(d) && d.Success !== false ? R.labelSnapshot(d) : null, want = R.labelSnapshot({ label: x.label });
          if (!sn || !want || sn.label !== want.label || !sn.status) { note('sales order ' + x.sales_order, AE.shape.bad('label details ' + x.label, 'no usable label', d)); continue; }
          result.soRead++;
          snaps.push(sn);
          if (sn.wo && sn.sales_order === x.sales_order) sos.add(x.sales_order); else soNone.push(x.sales_order);
        } catch (e) { if (fatal(e)) throw e; note('sales order ' + x.sales_order, e); trouble.mark('sales order ' + x.sales_order); }
      }
      result.soNone = soNone.length;
      if (snaps.length || soNone.length) { const r = await sweep(store, by, Object.assign({ labels: snaps }, soNone.length ? { soNone } : {})); result.added += r.added; }
      GM_setValue(SO_KEY(store), [...sos].slice(-2000));
      return result;
    } catch (e) {
      if (e instanceof LockLost) { result.note = 'stopped: another tab took over the pass'; return result; }
      if (e instanceof Stop || e.storeChanged) { result.note = AE.storeChanged() ? "paused: Portal's store changed, reload the page" : 'paused by a notice'; return result; }
      if (e.worker && e.status === 403) { result.note = 'no access: ' + (e.message || e); return result; } // the Worker's 403; Portal's ("session expired") is an error
      result.errors.push(e.message || String(e));
      AE.noteError('retrace', e);
      return result;
    } finally {
      clearInterval(beatTimer);
      result.seconds = Math.round((Date.now() - t0) / 1000);
      // The pass's counts, for the Usage page (not itself one of the counted calls; the Worker's route is optional, an old Worker answers 404).
      if (passStore && !AE_SANDBOX && counts && counts.portal + counts.worker > 0) {
        try { await AE.tracker.call('POST', '/v1/' + passStore + '/tracker/retrace/pass', { portalCalls: counts.portal, workerCalls: counts.worker, seconds: result.seconds, lookupSeconds: result.lookup ? result.lookup.seconds : undefined, browser: browserId() }); } catch (_) {}
      }
      counts = null;
      running = false;
      lockFree();
      GM_setValue(LAST_KEY, result);
    }
  }

  // ---------------------------------------------------------------- the watcher
  const WATCH_EVT = 'aethernet:retrace-watch', REC_KEY = 'ae_dev_retrace_rec', REC_LOG = 'ae_dev_retrace_log', REC_MAX = 50;
  function hook() {
    if (document.getElementById('ae-retrace-hook')) return;
    // A plain string: it runs in the page, outside Aethernet. Reads only: requests go out as Portal made them,
    // and answers are read from a clone (fetch) or after they've arrived (XHR).
    const code = [
      '(function (evt, sources) {',
      '  var res = sources.map(function (s) { return new RegExp(s, "i"); });',
      '  var path = function (u) { return String(u || "").replace(/^https?:\\/\\/[^/]+/i, "").split(/[?#]/)[0].replace(/^\\/?api\\//i, "").replace(/^\\/+|\\/+$/g, ""); };',
      '  var watched = function (m, u) { m = String(m || "GET").toUpperCase(); if (m === "GET" || m === "HEAD" || m === "OPTIONS") return false; var p = path(u); return res.some(function (re) { return re.test(p); }); };',
      '  var send = function (m, u, body, status, text) {',
      '    try { document.dispatchEvent(new CustomEvent(evt, { detail: JSON.stringify({ at: new Date().toISOString(), method: String(m).toUpperCase(), url: String(u), status: status,',
      '      body: typeof body === "string" ? body.slice(0, 20000) : "", response: String(text || "").slice(0, 50000) }) })); } catch (_) {}',
      '  };',
      // A Request's body is read from a clone made BEFORE Portal's call goes out (the call uses the body up; cloning after would throw and the
      // write would go unseen). The call itself always goes out exactly as Portal made it, whatever happens here.
      '  var of = window.fetch;',
      '  if (of) window.fetch = function (input, init) {',
      '    var w = null;',
      '    try {',
      '      var u = typeof input === "string" ? input : (input && input.url) || String(input || "");',
      '      var m = (init && init.method) || (input && input.method) || "GET";',
      '      if (watched(m, u)) {',
      '        var bodyP = init && init.body != null ? Promise.resolve(typeof init.body === "string" ? init.body : "") : (input && typeof input.clone === "function" ? input.clone().text().catch(function () { return ""; }) : Promise.resolve(""));',
      '        w = { m: m, u: u, bodyP: bodyP };',
      '      }',
      '    } catch (_) { w = null; }',
      '    var p = of.apply(this, arguments);',
      '    if (w) {',
      '      try { p.then(function (r) { var t; try { t = r.clone().text(); } catch (_) { t = Promise.resolve(""); } Promise.all([w.bodyP, t.catch(function () { return ""; })]).then(function (v) { send(w.m, w.u, v[0], r.status, v[1]); }); }, function () {}); } catch (_) {}',
      '    }',
      '    return p;',
      '  };',
      '  var X = window.XMLHttpRequest && window.XMLHttpRequest.prototype;',
      '  if (X) {',
      '    var open = X.open, xsend = X.send;',
      '    X.open = function (m, u) { try { this.__aeW = watched(m, u) ? { m: m, u: u } : null; } catch (_) {} return open.apply(this, arguments); };',
      '    X.send = function (body) {',
      '      try {',
      '        var w = this.__aeW, x = this;',
      '        if (w) x.addEventListener("loadend", function () {',
      '          var t = ""; try { t = x.responseType === "" || x.responseType === "text" ? x.responseText : x.responseType === "json" ? JSON.stringify(x.response) : ""; } catch (_) {}',
      '          send(w.m, w.u, body, x.status, t);',
      '        });',
      '      } catch (_) {}',
      '      return xsend.apply(this, arguments);',
      '    };',
      '  }',
      '})(' + JSON.stringify(WATCH_EVT) + ', ' + JSON.stringify(R.WATCH_RULES.map(([re]) => re.source)) + ');',
    ].join('\n');
    const el = document.createElement('script');
    el.id = 'ae-retrace-hook';
    el.textContent = code;
    (document.head || document.documentElement).append(el);
  }

  // The queue: { store, m, at } per movement, kept a few days, sent per store in batches.
  const queue = () => (GM_getValue(QUEUE_KEY, []) || []).filter((x) => x && x.m && Date.now() - x.at < QUEUE_DAYS * 86400000);
  let flushing = null, flushTimer = null;
  function flush(store) {
    if (flushing) return flushing;
    flushing = (async () => {
      let sent = 0;
      for (;;) {
        if (stopped()) break;
        const batch = queue().filter((x) => Number(x.store) === Number(store)).slice(0, WATCH_BATCH);
        if (!batch.length) break;
        let drop = false;
        try { await worker(store, 'POST', '/watch', { movements: batch.map((x) => x.m) }); sent += batch.length; drop = true; }
        catch (e) { if (e.status === 400) drop = true; else throw e; } // 400: never valid, don't retry forever
        if (drop) { const done = new Set(batch.map((x) => x.id)); GM_setValue(QUEUE_KEY, queue().filter((x) => !done.has(x.id))); }
      }
      return sent;
    })().finally(() => { flushing = null; });
    return flushing;
  }

  // Dev: what a Portal call looks like, with anything that could be a customer's removed.
  const PERSONAL = /customer|phone|email|address|street|city|zip|postal|passcode|password|token|auth|cookie|givenName|familyName|fullName|firstName|lastName|imei|signature|card|dob|birth/i;
  function scrubText(t) {
    let v;
    try { v = JSON.parse(t); } catch (_) { return String(t || '').replace(/[^\s@"]+@[^\s@"]+\.[a-z]{2,}/gi, '[email]').replace(/\+?\d[\d\s().-]{8,}\d/g, '[number]').slice(0, 8000); }
    const walk = (x, d) => {
      if (d > 8 || x == null) return x;
      if (Array.isArray(x)) return x.slice(0, 50).map((y) => walk(y, d + 1));
      if (typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, PERSONAL.test(k) ? '[removed]' : walk(y, d + 1)]));
      if (typeof x === 'string') return x.replace(/[^\s@]+@[^\s@]+\.[a-z]{2,}/gi, '[email]').replace(/^\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}$/, '[phone]').slice(0, 300);
      return x;
    };
    return JSON.stringify(walk(v, 0)).slice(0, 8000);
  }
  const recording = () => AE_DEV && !!GM_getValue(REC_KEY, false);
  function record(c) {
    const rec = { at: c.at, method: c.method, url: String(c.url || '').replace(/^https?:\/\/[^/]+/, ''), status: c.status, body: scrubText(c.body), response: scrubText(c.response) };
    GM_setValue(REC_LOG, [rec, ...(GM_getValue(REC_LOG, []) || [])].slice(0, REC_MAX));
  }

  let seq = 0;
  async function onCall(c) {
    if (recording()) record(c);
    if (!enabled() || !(c.status >= 200 && c.status < 300) || stopped()) return;
    const p = await AE.profile();
    if (!p || !p.storeId) return;
    const moves = R.watchMovements({ method: c.method, url: c.url, body: c.body, response: c.response, at: c.at }, { user: p.name || null, store: p.storeId }).filter((m) => R.normalize.watch(m));
    if (!moves.length) return;
    const now = Date.now();
    GM_setValue(QUEUE_KEY, [...queue(), ...moves.map((m) => ({ id: now + '-' + (seq++) + '-' + Math.random().toString(36).slice(2, 6), store: p.storeId, at: now, m }))].slice(-QUEUE_MAX));
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => flush(p.storeId).catch((e) => { if (!e.storeChanged) console.warn('[Aethernet] Retrace: watched moves kept for the next pass', e); }), 3000);
  }
  document.addEventListener(WATCH_EVT, (e) => {
    let c; try { c = JSON.parse(e.detail); } catch (_) { return; }
    onCall(c).catch((err) => AE.noteError('retrace watch', err));
  });
  if (enabled() || recording()) hook();

  return {
    // Dev tools: the collector's label read for one item, shown raw (see labelsOf): what Portal answers and what each row would do at the Worker.
    probeItem: async (item) => {
      const p = await AE.profile(), store = p && p.storeId;
      if (!store) throw new Error('No current store');
      const path = '/api/boh/store-products/' + encodeURIComponent(item) + '/inventory?pageSize=200&page=1&searchTerm=&warehouseType=All&warehouseId=' + store;
      const j = await AE.api('GET', path);
      const list = R.rowsOf(j), scrub = (r) => Object.fromEntries(Object.entries(r || {}).filter(([k]) => !/customer|phone|email|address|first|last|given|family/i.test(k)));
      const verdict = (r) => {
        const sn = R.labelSnapshot(r);
        if (!sn) return 'rejected: no usable label (SerialNumber / InventSerialId missing or not matching the label check)';
        if (R.ignoredItem(sn.item)) return 'dropped: ignored item ' + sn.item;
        const m = /^\s*(\d{1,6})\b/.exec(sn.store == null ? '' : String(sn.store));
        if (m && Number(m[1]) !== Number(store)) return 'skipped: another store (' + sn.store + ')';
        return 'stored as ' + sn.label + ' (item ' + sn.item + ', status ' + (sn.status || '-') + ', warehouse ' + (sn.warehouse || '-') + ')';
      };
      const tally = {};
      for (const r of list) { const v = verdict(r).split(' (')[0].split(' as ')[0]; tally[v] = (tally[v] || 0) + 1; }
      return { store, item: String(item), path, topLevel: Array.isArray(j) ? 'array' : j && typeof j === 'object' ? Object.keys(j) : typeof j,
        odataCount: j && !Array.isArray(j) ? j['@odata.count'] : null, rows: list.length, tally, first2: list.slice(0, 2).map((r) => ({ row: scrub(r), verdict: verdict(r) })),
        statuses: Object.fromEntries(list.reduce((m, r) => m.set(String(r && r.SerialStatus), (m.get(String(r && r.SerialStatus)) || 0) + 1), new Map())) };
    },
    run: (opts = {}) => run(Object.assign({ force: true }, opts)), tick: () => run(), last: () => GM_getValue(LAST_KEY, null), state: () => {
      const l = lockNow(), st = (GM_getValue(LAST_KEY, null) || {}).store, now = Date.now();
      const rf = st ? GM_getValue(RFAIL_KEY(st), {}) || {} : {}, pk = st ? GM_getValue(PARK_KEY(st), {}) || {} : {};
      return { enabled: enabled(), running, runningFor: running ? Math.round((now - runStart) / 1000) : 0, stopped: stopped(), lastPassStart: GM_getValue(PASS_KEY, 0) ? new Date(GM_getValue(PASS_KEY, 0)).toISOString() : null, lastSkip: skip,
        lock: l ? { mine: l.owner === TAB, live: lockLive(l), ageSeconds: Math.round((now - l.at) / 1000) } : null,
        // cool-downs at the last pass's store: records resting after RFAIL_MAX failures, items parked after FAIL_MAX failed reads (minutes left)
        resting: Object.entries(rf).filter(([, x]) => x && x.n >= RFAIL_MAX && now - x.at < RFAIL_REST_MS).map(([k, x]) => k + ' (' + Math.ceil((RFAIL_REST_MS - (now - x.at)) / 60000) + ' min)'),
        parked: Object.entries(pk).map(([k, t]) => k + ' (' + Math.max(0, Math.ceil((PARK_MS - (now - t)) / 60000)) + ' min)') };
    }, flush: async () => { const p = await AE.profile(); return flush(p.storeId); },
    queued: () => queue().length, enabled,
    // dev tools: the Portal call recorder
    recording, setRecording: (on) => { GM_setValue(REC_KEY, !!on); if (on) hook(); }, recorded: () => GM_getValue(REC_LOG, []) || [], clearRecorded: () => GM_deleteValue(REC_LOG),
  };
})();

if (AE.retrace.enabled && AE.retrace.enabled()) {
  setTimeout(() => AE.retrace.tick().catch(() => {}), 45000);
  setInterval(() => AE.retrace.tick().catch(() => {}), 60 * 1000); // tick() waits out the 10 minutes
}
