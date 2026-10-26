/*
  Retrace: the parts sold on each work order (Oct 26, 2026). Portal empties a WO's cart at Sale complete, but
  GET /api/workorder/{wo}/salesorder/{csuCartId} still answers the lines after the sale (captured live Oct 25, 2026, WO 500709932;
  vault "Retrace and Tracker Interop" → "Sold work order parts"):
    { salesId (FSO…), salesLines: [line], cartId, salesDate, storeId, payment { amountPaid, subtotal, discount, tax, total }, paymentTypes: [] }
    line: lineId, lineNumber, productId, name, price, grossAmount, quantity, serial, serialStatus, sku, lineType (labor, trade_credit),
          isChild, parentLineId, isScanned, program, originalLineId
  Part lines carry `serial` (the Retrace label) with serialStatus "Sold"; labor and credit lines have an empty serial; the buyback line
  (sku BB0001) carries a B-<label> serial and is skipped, as Retrace ignores BB0001 everywhere.

  The tracker collector (src/27-tracker.js) reads it for a WO it has just uploaded as sold, and, paced, for every stored sold WO
  (WOS_ASK a pass, oldest sale first) until each one is done. Routes (store side, under /v1/:store/tracker):

    POST /retrace/wo-sold/need { want }   → { wos: [{ wo, cart_id }], left }
          sold WOs (workorders.sold_at set, or status 14 Sale complete) with a csuCartId in their plain part, not done yet, oldest sale
          first; each claimed CLAIM_MIN minutes so two browsers don't read the same one. left = how many are still to do (claimed included).
    POST /retrace/wo-sold { results: [{ wo, cart_id, order } | { wo, cart_id, failed }], by }   → { done, empty, failed, gave_up, rejected, labels }
          order = the collector's copy of Portal's answer (salesId, cartId, salesDate, storeId, salesLines). Per WO:
            - part lines (a label serial, not B-…, sku not an ignored item) → inv_wo_parts (the WO's set replaced), the label's WO link
              (inv_labels.wo: a label sold on several WOs keeps the latest sale), sales order → WO (inv_so_wo, source 'salesorder'),
              and one 'used' movement on ref_type 'wo' per label unless the WO's cart already gave it one (the cart diff, the same sale);
            - no part lines: 'empty' (done, nothing to link);
            - failed (the read failed, or the answer is not a sales order for this cart): tried again later; after TRIES_MAX failures 'gave_up',
              so the backfill always ends. A WO this store's tracker doesn't hold is rejected.
          State per WO: inv_wo_sold (migrations/2026-10-26-retrace-wo-parts.sql).
*/
import { cleanLabel, itemOfLabel, isoAt, ignoredItem } from './retrace.js';
import { insertMv, soWo, tombs, chunks } from './retrace-api.js';

export const WOS_ASK = 25, TRIES_MAX = 5;
const CLAIM_MIN = 10, RESULTS_MAX = 50, LINES_MAX = 200;
const DONE_STATES = "('done', 'empty', 'gave_up')";
const SOLD = '(w.sold_at IS NOT NULL OR w.status_id = 14)';
const CART = "json_extract(w.plain, '$.workorder.csuCartId')";
const s = (v, max) => (v == null || typeof v === 'object' ? null : String(v).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) || null);
const n = (v) => (typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && isFinite(Number(v)) ? Number(v) : null);
const woId = (v) => { const x = s(v, 20); return x && /^\d{1,15}$/.test(x) ? x : null; };

// A sales line that is a part Retrace tracks: a label serial, not a buyback (B-…), not an ignored item (BB0001).
export function partLines(order) {
  const out = [];
  for (const l of Array.isArray(order && order.salesLines) ? order.salesLines.slice(0, LINES_MAX) : []) {
    if (!l || typeof l !== 'object') continue;
    const raw = s(l.serial, 40);
    if (!raw || /^B-/i.test(raw) || ignoredItem(l.sku)) continue;
    const label = cleanLabel(raw);
    if (!label) continue;
    const item = s(l.sku, 40) || itemOfLabel(label);
    if (ignoredItem(item)) continue;
    out.push({ line: s(l.lineId, 40) || (l.lineNumber != null ? 'n' + s(l.lineNumber, 10) : 'l' + label), label, item, sku: s(l.sku, 40), name: s(l.name, 120),
      quantity: n(l.quantity), price: n(l.price), serial_status: s(l.serialStatus, 30), line_type: s(l.lineType, 30) });
  }
  return out;
}

export async function woSoldRoute(req, T, store, path, H) {
  if (path === '/retrace/wo-sold/need' && req.method === 'POST') {
    const b = await H.readJson(req, 2000);
    const want = Math.min(Math.max(Number.isInteger(b.want) ? b.want : WOS_ASK, 0), WOS_ASK), at = H.now();
    const open = `${SOLD} AND typeof(${CART}) = 'text' AND ${CART} <> '' AND (s.wo IS NULL OR s.state NOT IN ${DONE_STATES})`;
    const rows = want ? (await T.prepare(`SELECT CAST(w.wo AS TEXT) AS wo, ${CART} AS cart_id FROM workorders w
        LEFT JOIN inv_wo_sold s ON s.store = w.store AND s.wo = CAST(w.wo AS TEXT)
        WHERE w.store = ?1 AND ${open} AND (s.claimed_until IS NULL OR s.claimed_until < ?2)
        ORDER BY COALESCE(w.sold_at, w.closed_at, w.created_at) IS NULL, COALESCE(w.sold_at, w.closed_at, w.created_at), w.wo LIMIT ?3`).bind(store, at, want).all()).results : [];
    if (rows.length) {
      const until = new Date(Date.parse(at) + CLAIM_MIN * 60000).toISOString();
      await chunks(T, rows.map((r) => T.prepare(`INSERT INTO inv_wo_sold (store, wo, cart_id, state, claimed_until, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)
          ON CONFLICT (store, wo) DO UPDATE SET claimed_until = excluded.claimed_until, cart_id = excluded.cart_id, updated_at = excluded.updated_at`).bind(store, r.wo, r.cart_id, until, at)));
    }
    const left = (await T.prepare(`SELECT COUNT(*) AS n FROM workorders w LEFT JOIN inv_wo_sold s ON s.store = w.store AND s.wo = CAST(w.wo AS TEXT) WHERE w.store = ?1 AND ${open}`).bind(store).first()).n;
    return H.json({ wos: rows.map((r) => ({ wo: r.wo, cart_id: r.cart_id })), left });
  }

  if (path === '/retrace/wo-sold' && req.method === 'POST') {
    const b = await H.readJson(req, 1000000);
    if (!Array.isArray(b.results) || b.results.length > RESULTS_MAX) return H.fail(400, 'results: a list of at most ' + RESULTS_MAX);
    const at = H.now(), out = { done: 0, empty: 0, failed: 0, gave_up: 0, rejected: 0, labels: 0 };
    for (const r of b.results) {
      const wo = woId(r && r.wo);
      const w = wo ? await T.prepare(`SELECT CAST(wo AS TEXT) AS wo, sold_at, ${CART.replace('w.plain', 'plain')} AS cart_id FROM workorders WHERE store = ? AND wo = ?`).bind(store, Number(wo)).first() : null;
      if (!w) { out.rejected++; continue; } // not a WO this store's tracker holds
      const order = r.order;
      let why = r.failed != null ? s(r.failed, 200) || 'failed' : null;
      if (!why && (!order || typeof order !== 'object' || Array.isArray(order) || !Array.isArray(order.salesLines))) why = 'not a sales order (no salesLines)';
      if (!why && order.cartId != null && w.cart_id && String(order.cartId) !== String(w.cart_id)) why = 'another cart (' + s(order.cartId, 40) + ')';
      if (!why && order.storeId != null && Number(order.storeId) !== Number(store)) why = 'another store (' + s(order.storeId, 10) + ')';
      if (why) {
        const row = await T.prepare(`INSERT INTO inv_wo_sold (store, wo, cart_id, state, tries, last_error, updated_at) VALUES (?1, ?2, ?3, CASE WHEN 1 >= ?4 THEN 'gave_up' ELSE 'failed' END, 1, ?5, ?6)
            ON CONFLICT (store, wo) DO UPDATE SET tries = tries + 1, state = CASE WHEN state IN ${DONE_STATES} AND state <> 'gave_up' THEN state WHEN tries + 1 >= ?4 THEN 'gave_up' ELSE 'failed' END,
              last_error = excluded.last_error, claimed_until = NULL, updated_at = excluded.updated_at RETURNING state`).bind(store, wo, w.cart_id, TRIES_MAX, why, at).first();
        if (row && row.state === 'gave_up') out.gave_up++; else out.failed++;
        continue;
      }
      const so = s(order.salesId, 40), soldAt = isoAt(order.salesDate) || w.sold_at || at;
      const dead = await tombs(T, store, partLines(order).map((x) => x.label));
      const parts = partLines(order).filter((x) => !dead.has(x.label));
      // a label the WO's own cart already sold (cart diff 'used' on this WO) gets no second movement
      const had = new Set(parts.length ? (await T.prepare(`SELECT label FROM inv_movements WHERE store = ? AND ref_type = 'wo' AND ref_id = ? AND kind IN ('used', 'sold') AND label IN (SELECT value FROM json_each(?))`)
        .bind(store, wo, JSON.stringify(parts.map((x) => x.label))).all()).results.map((x) => x.label) : []);
      const stmts = [T.prepare('DELETE FROM inv_wo_parts WHERE store = ? AND wo = ?').bind(store, wo)];
      for (const x of parts) {
        stmts.push(T.prepare(`INSERT OR REPLACE INTO inv_wo_parts (store, wo, line, label, item, sku, name, quantity, price, serial_status, line_type, sales_order, sold_at, recorded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(store, wo, x.line, x.label, x.item, x.sku, x.name, x.quantity, x.price, x.serial_status, x.line_type, so, soldAt, at));
        // the label's WO: this one, unless the label is on record on another WO after this sale (sold there later, or a cart / parts movement
        // there since: the backfill runs oldest first, and a WO seen sold just now, or reserved now, may already have linked it)
        stmts.push(T.prepare(`INSERT INTO inv_labels (store, label, item, wo, sales_order, first_seen, last_seen, need_history, queued_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 2, ?6)
            ON CONFLICT (store, label) DO UPDATE SET item = COALESCE(item, excluded.item), sales_order = CASE WHEN wo IS NULL OR wo = excluded.wo THEN COALESCE(excluded.sales_order, sales_order) ELSE sales_order END,
              wo = CASE WHEN wo IS NULL OR wo = excluded.wo OR (NOT EXISTS (SELECT 1 FROM inv_wo_parts p WHERE p.store = inv_labels.store AND p.label = inv_labels.label AND p.wo = inv_labels.wo AND p.sold_at > ?7)
                AND NOT EXISTS (SELECT 1 FROM inv_movements m WHERE m.store = inv_labels.store AND m.label = inv_labels.label AND m.ref_type = 'wo' AND m.ref_id = inv_labels.wo AND m.at > ?7)) THEN excluded.wo ELSE wo END`)
          .bind(store, x.label, x.item, wo, so, at, soldAt));
        if (!had.has(x.label)) stmts.push(insertMv(T, store, { label: x.label, item: x.item, at: soldAt, kind: 'used', raw_status: x.serial_status, raw_event: 'sales order line', ref_type: 'wo', ref_id: wo,
          ref_line: x.line && x.line.slice(0, 20), from_wh: null, to_wh: null, user: null, source: 'wo', detail: so ? 'Sold on sales order ' + so : null, key: 'wo:sold:' + wo + ':' + x.label }, at));
      }
      if (so) stmts.push(soWo(T, store, so, wo, 'salesorder', at));
      stmts.push(T.prepare(`INSERT INTO inv_wo_sold (store, wo, cart_id, sales_order, state, lines, labels, tries, updated_at, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
          ON CONFLICT (store, wo) DO UPDATE SET cart_id = excluded.cart_id, sales_order = excluded.sales_order, state = excluded.state, lines = excluded.lines, labels = excluded.labels,
            claimed_until = NULL, last_error = NULL, updated_at = excluded.updated_at, done_at = excluded.done_at`)
        .bind(store, wo, w.cart_id, so, parts.length ? 'done' : 'empty', order.salesLines.length, parts.length, at, at));
      await chunks(T, stmts);
      out[parts.length ? 'done' : 'empty']++; out.labels += parts.length;
    }
    return H.json(out);
  }
  return null;
}
