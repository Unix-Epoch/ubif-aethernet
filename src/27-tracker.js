/*
  Work order tracker (collection). Not a shard: it runs in the background for every
  store with Aethernet access, once the tracker Worker is deployed (__TRACKER_API__).

  Every 10 minutes (one tab per browser; the Worker hands each WO to one browser at a time):
    1. Portal's open-WO list → POST /scan with plain fields only (WO, status, program,
       device model, dates). The Worker answers which WOs to fetch in full.
    2. For each: the same detail the Mac tracker kept (workorder, status audit trail,
       customer data, every note, cart), plus its event list (parts added / removed /
       swapped, for Retrace). Device passcodes are removed first.
    3. Split it: a plain part (status, program, dates, bin, status history, cart lines and
       totals: no customer details) and the whole detail sealed with the store's public
       key, plus a sealed search card (name, phones, emails, IMEI/serial, claim number).
       Sealed values can only be opened on the admin site, with a key copy.
  The store's key is created here the first time any install at the store needs it (its
  private half leaves sealed to the master key and is forgotten).
*/
AE.tracker = (() => {
  const API = '__TRACKER_API__';
  const KEY = '__WAYMARK_KEY__';
  const C = (() => { /*__TRACKER_CRYPTO__*/ })();
  const SCAN_KEY = 'ae_tracker_scan_at', LAST_KEY = 'ae_tracker_last';
  const SALES_KEY = 'ae_tracker_sales_at', SALES_WEEK_KEY = 'ae_tracker_sales_week', SALES_MS = 30 * 60 * 1000;
  const SCAN_MS = 10 * 60 * 1000, GAP_MS = 300, NOTE_PAGE = 30, NOTE_PAGES = 20;
  const configured = () => (AE_SANDBOX ? /^http:\/\/localhost[:/]/.test(API) : /^(https:\/\/|http:\/\/localhost[:/])/.test(API));

  async function call(method, path, body) {
    if (method !== 'GET') await AE.assertSameStore(); // never upload under this page's store once Portal has switched
    return AE.workerCall(method, API + path, { credentials: 'omit', headers: { 'content-type': 'application/json', 'x-aethernet-key': KEY }, body: body ? JSON.stringify(body) : undefined });
  }

  // The store's public key: from the Worker, or made here (needs the master public key).
  let storeKey = null;
  async function keyFor(store) {
    if (storeKey && storeKey.store === store) return storeKey.jwk;
    let jwk;
    try { jwk = (await call('GET', '/v1/' + store + '/tracker/key')).publicJwk; }
    catch (e) {
      if (e.status !== 404) throw e;
      const master = (await call('GET', '/v1/tracker/master')).publicJwk; // 404 = tracker not set up yet
      jwk = (await call('POST', '/v1/' + store + '/tracker/key', await C.newStoreKey(store, master))).publicJwk;
    }
    storeKey = { store, jwk };
    return jwk;
  }

  const { scanRow, scrub, plainPart, cardOf } = (() => { /*__TRACKER_SHAPE__*/ })();

  // ---------------------------------------------------------------- Portal fetches
  /*
    One work order's detail from Portal, shared with Assize (AE.woDetail.get): the work order, its status audit
    trail, every note and the cart, passcodes removed. Whichever asks first fetches it; the other reuses that copy
    while it's recent and Portal's updatedAt still matches, so Portal isn't asked twice for the same order. Kept
    per store in GM storage (every tab shares it), 2 hours at most. Customer data is never kept here: the tracker
    fetches it on its own. The calls for one order run together (the cart waits only for the work order, which
    names it); note pages after the first stay 300 ms apart. A fetch with a failed part isn't kept.
      get(store, wo, { force, maxAge, updatedAt }) → { workorder, audit_trail, notes: { notes, total, latestManualNote } | null, cart, events: { events } | null, at }
        force      always ask Portal (Refresh, just after a text or note, the tracker's missing-order check)
        maxAge     how old a kept copy may be (ms, default 10 minutes)
        updatedAt  Portal's list row updatedAt: a kept copy from before it is not used
      A 404 on the work order throws with e.gone.
  */
  const WOD_MS = 10 * 60 * 1000, WOD_KEEP = 2 * 60 * 60 * 1000, wodKey = (store) => 'ae_wod_' + store;
  const wodLoading = new Map();
  async function notesOf(wo) {
    const all = []; let total = null, latest = null;
    for (let off = 0, i = 0; i < NOTE_PAGES; i++) {
      const p = await AE.api('GET', '/api/note?workorderId=' + wo + '&offset=' + off + '&limit=' + NOTE_PAGE);
      const rows = (p && p.notes) || [];
      all.push(...rows);
      if (total == null) { total = p && Number.isInteger(p.total) ? p.total : rows.length; latest = (p && p.latestManualNote) || null; }
      off += rows.length;
      if (!rows.length || off >= total) break;
      await AE.sleep(GAP_MS);
    }
    return { notes: all, total, latestManualNote: latest };
  }
  // The WO's event list (parts added / removed / swapped, status updates…), 50 a page following lastKey, 5 pages at
  // most, for Retrace (shape.js partEvents keeps the parts events). Each event's metadata (staff IP addresses,
  // session ids) is dropped here, so it's never kept or sealed.
  const EVENT_PAGES = 5;
  async function eventsOf(wo) {
    const all = [];
    let key = null;
    for (let i = 0; i < EVENT_PAGES; i++) {
      const p = await AE.api('GET', '/api/workorder/' + wo + '/events?pageSize=50' + (key ? '&lastKey=' + encodeURIComponent(typeof key === 'string' ? key : JSON.stringify(key)) : ''));
      const rows = (p && Array.isArray(p.events) ? p.events : Array.isArray(p) ? p : []);
      all.push(...rows.map(({ metadata, ...e }) => e));
      key = p && p.lastKey;
      if (!key || !rows.length) break;
      await AE.sleep(GAP_MS);
    }
    return { events: all };
  }
  async function fetchDetail(wo) {
    let failed = false;
    const soft = (pr) => pr.catch(() => { failed = true; return null; });
    const coreP = AE.api('GET', '/api/workorder/' + wo).catch((e) => { if (/HTTP 404/.test(e.message || '')) e.gone = true; throw e; });
    const cartP = coreP.then((core) => { const id = core && core.workorder && core.workorder.csuCartId; return id ? soft(AE.api('GET', '/api/get-cart/' + id + '?includePartStatus=true')) : null; }, () => null);
    const [core, audit, notes, cart, events] = await Promise.all([coreP, soft(AE.api('GET', '/api/workorder-audit-trail/' + wo)), soft(notesOf(wo)), cartP, soft(eventsOf(wo))]);
    AE.shape.workorder(core, 'work order ' + wo); // a malformed 200 is an error, not a work order with nothing in it
    return { d: scrub({ workorder: core, audit_trail: audit, notes, cart, events }), failed };
  }
  function wodGet(store, wo, opts = {}) {
    const id = String(wo), k = wodKey(store);
    if (!opts.force) {
      const hit = (GM_getValue(k, {}) || {})[id];
      if (hit && Date.now() - hit.at < (opts.maxAge || WOD_MS) && (!opts.updatedAt || hit.u === opts.updatedAt)) return Promise.resolve(Object.assign({ at: hit.at }, hit.d));
      if (wodLoading.has(k + ':' + id)) return wodLoading.get(k + ':' + id);
    }
    const run = fetchDetail(id).then(({ d, failed }) => {
      const at = Date.now(), all = GM_getValue(k, {}) || {};
      for (const [w, x] of Object.entries(all)) if (!x || at - x.at > WOD_KEEP) delete all[w];
      const w = d.workorder && d.workorder.workorder;
      if (!failed && w) all[id] = { at, u: w.updatedAt || null, d }; else delete all[id];
      GM_setValue(k, all);
      return Object.assign({ at, failed }, d); // failed: a part (audit trail, notes, cart, events) didn't load; the tracker doesn't send it
    }).finally(() => { if (wodLoading.get(k + ':' + id) === run) wodLoading.delete(k + ':' + id); });
    wodLoading.set(k + ':' + id, run);
    return run;
  }
  AE.woDetail = { get: wodGet };

  // The tracker's copy: the shared detail plus the customer record (fetched alongside, never kept).
  async function detailOf(store, wo, opts) {
    const [x, customer] = await Promise.all([wodGet(store, wo, opts), AE.api('GET', '/api/v1/workorder/' + wo + '/demographic/customer-data').catch(() => null)]);
    return { d: scrub({ workorder: x.workorder, audit_trail: x.audit_trail, customer_data: customer, notes: x.notes, cart: x.cart, events: x.events }), failed: !!x.failed };
  }

  // One WO, ready to send (or to look at, for the dev tools' dry run).
  async function prepare(store, wo, listRow, jwk, opts = {}) {
    const { d, failed } = await detailOf(store, wo, opts);
    const own = d.workorder && d.workorder.workorder;
    if (own && own.storeId != null && Number(own.storeId) !== Number(store)) throw Object.assign(new Error("another store's work order"), { otherStore: Number(own.storeId) });
    if (listRow) d.list_row = scrub(listRow);
    const plain = plainPart(d, listRow), card = cardOf(d, listRow);
    const out = { plain, card, detail: d, failed, hash: await C.hashJson([plain, d]), detailBytes: JSON.stringify(d).length };
    if (jwk) { out.sealed = await C.sealJson(d, jwk, C.aad.snapshot(store, wo)); out.cardSealed = await C.sealJson(card, jwk, C.aad.card(store, wo)); }
    return out;
  }

  // ---------------------------------------------------------------- the scan
  let running = false;
  async function scan(opts = {}) {
    if (!configured() || running || AE.status.paused('tracker') || AE.health.down()) return null;
    if (!opts.force && Date.now() - GM_getValue(SCAN_KEY, 0) < SCAN_MS - 30000) return null;
    running = true;
    GM_setValue(SCAN_KEY, Date.now());
    const result = { at: new Date().toISOString(), sent: 0, same: 0, gone: 0, failed: 0, partial: 0, errors: [] };
    try {
      const p = await AE.profile();
      if (!p.storeId) throw new Error('No current store');
      const store = p.storeId;
      let jwk;
      try { jwk = await keyFor(store); }
      catch (e) { if (e.status === 404) { result.note = 'tracker not set up yet'; return result; } throw e; }
      const rows = await AE.data.workorders(Date.now(), 0);
      const byId = new Map(rows.map((r) => [Number(r.workorderId), r]));
      const s = await call('POST', '/v1/' + store + '/tracker/scan', { rows: rows.map(scanRow), storeName: p.storeName, by: p.name });
      Object.assign(result, { open: rows.length, need: s.need.length, note: s.note || null });
      for (const n of s.need) {
        if (AE.health.tripped()) { result.note = 'Portal is down: stopped, the rest next scan'; break; } // AE.health: no more calls while Portal fails
        try {
          // A missing order needs Portal's own answer (a 404 closes it); the rest may use Assize's recent copy.
          const row = byId.get(n.wo) || null;
          const x = await prepare(store, n.wo, row, jwk, n.why === 'missing' ? { force: true } : { updatedAt: row && row.updatedAt });
          // Part of the detail failed to load (audit trail, notes, cart or events): that is not the order's state. Not sent; asked for again next scan.
          if (x.failed) { result.partial++; if (result.errors.length < 5) result.errors.push(n.wo + ': partial detail, not sent'); await AE.sleep(GAP_MS); continue; }
          const j = await call('POST', '/v1/' + store + '/tracker/wo/' + n.wo, { hash: x.hash, trigger: n.why, plain: x.plain, sealed: x.sealed, card: x.cardSealed, by: p.name });
          if (j.same) result.same++; else result.sent++;
        } catch (e) {
          if (/session expired/i.test(e.message || '') || e.storeChanged) throw e; // signed out or store switched: stop
          if (e.otherStore) { // never upload another store's work order; one on record here was moved there
            try { await call('POST', '/v1/' + store + '/tracker/wo/' + n.wo + '/moved', { to: e.otherStore, by: p.name }); } catch (_) {}
            continue;
          }
          if (e.gone) { // Portal no longer has it
            try { await call('POST', '/v1/' + store + '/tracker/wo/' + n.wo + '/gone', { by: p.name }); result.gone++; continue; } catch (_) {}
          }
          result.failed++; if (result.errors.length < 5) result.errors.push(n.wo + ': ' + (e.message || e));
        }
        await AE.sleep(GAP_MS);
      }
      try { const sales = await salesSync(store, jwk, opts.force); if (sales) result.sales = Object.fromEntries(Object.entries(sales).map(([d, x]) => [d, x.count + ' sales, $' + x.total])); }
      catch (e) { result.errors.push('sales: ' + (e.message || e)); }
      return result;
    } catch (e) {
      if (e.storeChanged) { result.note = "paused: Portal's store changed, reload the page"; return result; }
      result.errors.push(e.message || String(e));
      AE.noteError('tracker', e);
      return result;
    } finally {
      running = false;
      GM_setValue(LAST_KEY, result);
    }
  }

  /*
    Daily sales: Portal's sales history (the Sales tab's GET /api/reporting/sales-history) for a business
    day, sent to the tracker. Today every 30 minutes; the 6 days before it once a day, since Portal only
    keeps about a week. The window runs into the next morning (the API's dates carry no time zone) and
    each sale is kept by its own local date. The customer (id, name) is sealed.
  */
  const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  async function salesDay(store, day, jwk) {
    const next = new Date(day + 'T12:00:00'); next.setDate(next.getDate() + 1);
    const j = await AE.api('GET', '/api/reporting/sales-history?sale_complete_start_date=' + day + 'T00:00:00.000&sale_complete_end_date=' + ymd(next) + 'T08:00:00.000');
    const list = ((j && j.results) || []).filter((r) => !r.saleCompleteDateTime || ymd(new Date(r.saleCompleteDateTime)) === day);
    const rows = [];
    for (const r of list) {
      if (!r.salesId) continue;
      rows.push({ saleId: r.salesId, wo: r.workOrderId || null, saleAt: r.saleCompleteDateTime || null, type: r.transactionType || null,
        total: r.total, partnerCredits: r.partnerCredits, paid: r.payments, completedBy: r.completedBy || null,
        card: (r.customerId || r.customerName) ? await C.sealJson({ customerId: r.customerId || null, customerName: r.customerName || null }, jwk, C.aad.sale(store, r.salesId)) : null });
    }
    return call('POST', '/v1/' + store + '/tracker/sales', { day, rows });
  }
  async function salesSync(store, jwk, force) {
    if (!force && Date.now() - GM_getValue(SALES_KEY, 0) < SALES_MS - 30000) return null;
    GM_setValue(SALES_KEY, Date.now());
    const today = ymd(new Date()), out = {};
    out[today] = await salesDay(store, today, jwk);
    if (force || GM_getValue(SALES_WEEK_KEY, '') !== today) {
      for (let i = 1; i <= 6; i++) { const d = new Date(); d.setDate(d.getDate() - i); const day = ymd(d); out[day] = await salesDay(store, day, jwk); await AE.sleep(GAP_MS); }
      GM_setValue(SALES_WEEK_KEY, today);
    }
    return out;
  }

  /*
    Daily metrics: plain numbers (hours, counts) for the admin Metrics page, from Tactician, Divination and Assize.
    POST /v1/:store/tracker/daily. Never blocks the caller and never throws: a failure is a console warning and
    AE.noteError. Not sent when the same numbers went up for that store, day and source in the last 3 hours
    (this browser's record, so a few Divination refreshes an hour cost nothing); anything older than 14 days
    is not sent (the Worker refuses it). Same rules as every other write here: configured() only, and
    call() checks the page's store is still Portal's store first.
  */
  const DAILY_KEY = 'ae_tracker_daily', DAILY_SAME_MS = 3 * 60 * 60 * 1000;
  async function daily(store, day, metrics, source, opts = {}) {
    try {
      if (!configured() || !store || !/^\d{4}-\d\d-\d\d$/.test(day || '')) return false;
      const age = (Date.now() - Date.parse(day + 'T12:00:00')) / 86400000;
      if (!(age < 14)) return false;
      const clean = {};
      for (const [k, v] of Object.entries(metrics || {})) if (typeof v === 'number' && isFinite(v) && v >= 0) clean[k] = Math.round(v * 1000) / 1000;
      if (!Object.keys(clean).length) return false;
      const id = store + '|' + day + '|' + source, sig = JSON.stringify(clean), sent = GM_getValue(DAILY_KEY, {});
      if (!opts.force && sent[id] && sent[id].sig === sig && Date.now() - sent[id].at < DAILY_SAME_MS) return false;
      await AE.assertSameStore();
      const p = await AE.profile();
      await call('POST', '/v1/' + store + '/tracker/daily', { day, metrics: clean, source, by: p.name });
      const keep = Object.fromEntries(Object.entries(GM_getValue(DAILY_KEY, {})).filter(([, x]) => Date.now() - x.at < 2 * 86400000));
      keep[id] = { sig, at: Date.now() };
      GM_setValue(DAILY_KEY, keep);
      return true;
    } catch (e) {
      if (e.status === 403) return false; // no access for that store (or sandbox data): expected, not an error
      if (!e.storeChanged) { console.warn('[Aethernet] daily upload failed', e); AE.noteError('tracker daily', e); }
      return false;
    }
  }

  // Dev tools: what one WO would send, without sending it.
  async function dryRun(wo) {
    const p = await AE.profile();
    const rows = await AE.data.workorders(Date.now(), 0);
    const row = rows.find((r) => Number(r.workorderId) === Number(wo)) || null;
    const master = configured() ? await call('GET', '/v1/tracker/master').then((j) => j.publicJwk).catch(() => null) : null;
    const jwk = master || (await C.newKeyPair()).publicJwk; // no Worker yet: a throwaway key, only to measure
    const x = await prepare(p.storeId, wo, row, jwk, { force: true });
    const d = x.detail, notes = (d.notes && d.notes.notes) || [];
    const sealedParts = { notes: notes.length, noteChars: notes.reduce((n, t) => n + String(t.noteText || '').length, 0), customerRecord: !!d.customer_data,
      statusHistory: Array.isArray(d.audit_trail) ? d.audit_trail.length : 0, cartLines: d.cart ? (d.cart.cartItems || []).length : 0 };
    return { wo: Number(wo), partial: !!x.failed, inList: !!row, plain: x.plain, card: x.card, sealedParts, hash: x.hash, detailBytes: x.detailBytes, sealedBytes: x.sealed.length, cardBytes: x.cardSealed.length };
  }

  // The store's RFP total, cached 2 minutes (Master's Mend → RFP total).
  let rfpCache = null;
  async function rfp() {
    if (!configured()) return null;
    if (rfpCache && Date.now() - rfpCache.at < 120000) return rfpCache.data;
    const p = await AE.profile();
    const data = await call('GET', '/v1/' + p.storeId + '/tracker/rfp');
    rfpCache = { at: Date.now(), data };
    return data;
  }

  return { configured, scan, dryRun, rfp, call, daily, last: () => GM_getValue(LAST_KEY, null), plainPart, cardOf, scrub, crypto: C };
})();

if (AE.tracker.configured()) {
  setTimeout(() => AE.tracker.scan().catch(() => {}), 20000);
  setInterval(() => AE.tracker.scan().catch(() => {}), 60 * 1000); // scan() waits out the 10 minutes
}
