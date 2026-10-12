/*
  Work order tracker (collection). Not a crystal: it runs in the background for every
  store with Aethernet access, once the tracker Worker is deployed (__TRACKER_API__).

  Every 10 minutes (one tab per browser; the Worker hands each WO to one browser at a time):
    1. Portal's open-WO list → POST /scan with plain fields only (WO, status, program,
       device model, dates). The Worker answers which WOs to fetch in full.
    2. For each: the same detail the Mac tracker kept (workorder, status audit trail,
       customer data, every note, cart). Device passcodes are removed first.
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
    const res = await fetch(API + path, { method, credentials: 'omit', headers: { 'content-type': 'application/json', 'x-aethernet-key': KEY }, body: body ? JSON.stringify(body) : undefined });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(j.error || 'HTTP ' + res.status), { status: res.status });
    return j;
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
  async function detailOf(wo) {
    let core;
    try { core = await AE.api('GET', '/api/workorder/' + wo); }
    catch (e) { if (/HTTP 404/.test(e.message || '')) e.gone = true; throw e; }
    await AE.sleep(GAP_MS);
    const w = (core && core.workorder) || {};
    const audit = await AE.api('GET', '/api/workorder-audit-trail/' + wo).catch(() => null); await AE.sleep(GAP_MS);
    const customer = await AE.api('GET', '/api/v1/workorder/' + wo + '/demographic/customer-data').catch(() => null); await AE.sleep(GAP_MS);
    const notes = await notesOf(wo).catch(() => null); await AE.sleep(GAP_MS);
    const cart = w.csuCartId ? await AE.api('GET', '/api/get-cart/' + w.csuCartId + '?includePartStatus=true').catch(() => null) : null;
    return scrub({ workorder: core, audit_trail: audit, customer_data: customer, notes, cart });
  }

  // One WO, ready to send (or to look at, for the dev tools' dry run).
  async function prepare(store, wo, listRow, jwk) {
    const d = await detailOf(wo);
    if (listRow) d.list_row = scrub(listRow);
    const plain = plainPart(d, listRow), card = cardOf(d, listRow);
    const out = { plain, card, detail: d, hash: await C.hashJson([plain, d]), detailBytes: JSON.stringify(d).length };
    if (jwk) { out.sealed = await C.sealJson(d, jwk, C.aad.snapshot(store, wo)); out.cardSealed = await C.sealJson(card, jwk, C.aad.card(store, wo)); }
    return out;
  }

  // ---------------------------------------------------------------- the scan
  let running = false;
  async function scan(opts = {}) {
    if (!configured() || running || AE.status.paused('tracker')) return null;
    if (!opts.force && Date.now() - GM_getValue(SCAN_KEY, 0) < SCAN_MS - 30000) return null;
    running = true;
    GM_setValue(SCAN_KEY, Date.now());
    const result = { at: new Date().toISOString(), sent: 0, same: 0, gone: 0, failed: 0, errors: [] };
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
        try {
          const x = await prepare(store, n.wo, byId.get(n.wo) || null, jwk);
          const j = await call('POST', '/v1/' + store + '/tracker/wo/' + n.wo, { hash: x.hash, trigger: n.why, plain: x.plain, sealed: x.sealed, card: x.cardSealed, by: p.name });
          if (j.same) result.same++; else result.sent++;
        } catch (e) {
          if (/session expired/i.test(e.message || '')) throw e; // signed out: stop, try again next time
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

  // Dev tools: what one WO would send, without sending it.
  async function dryRun(wo) {
    const p = await AE.profile();
    const rows = await AE.data.workorders(Date.now(), 0);
    const row = rows.find((r) => Number(r.workorderId) === Number(wo)) || null;
    const master = configured() ? await call('GET', '/v1/tracker/master').then((j) => j.publicJwk).catch(() => null) : null;
    const jwk = master || (await C.newKeyPair()).publicJwk; // no Worker yet: a throwaway key, only to measure
    const x = await prepare(p.storeId, wo, row, jwk);
    const d = x.detail, notes = (d.notes && d.notes.notes) || [];
    const sealedParts = { notes: notes.length, noteChars: notes.reduce((n, t) => n + String(t.noteText || '').length, 0), customerRecord: !!d.customer_data,
      statusHistory: Array.isArray(d.audit_trail) ? d.audit_trail.length : 0, cartLines: d.cart ? (d.cart.cartItems || []).length : 0 };
    return { wo: Number(wo), inList: !!row, plain: x.plain, card: x.card, sealedParts, hash: x.hash, detailBytes: x.detailBytes, sealedBytes: x.sealed.length, cardBytes: x.cardSealed.length };
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

  return { configured, scan, dryRun, rfp, last: () => GM_getValue(LAST_KEY, null), plainPart, cardOf, scrub, crypto: C };
})();

if (AE.tracker.configured()) {
  setTimeout(() => AE.tracker.scan().catch(() => {}), 20000);
  setInterval(() => AE.tracker.scan().catch(() => {}), 60 * 1000); // scan() waits out the 10 minutes
}
