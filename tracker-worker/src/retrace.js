/*
  Retrace (Oct 23, 2026): Aethernet's inventory movement ledger. Every raw record that says an item moved
  (Portal's serial history, label snapshots, WO cart lines and parts events, store transfers, counts, RMA and
  buyback orders, PO receipts, Portal writes seen in the page) becomes one movement row in inv_movements.
  Shared, pure, no D1: the tracker Worker imports it (src/retrace-api.js, the WO hook) and build.py can inline it
  into Aethernet like shape.js (tracker_module keeps only `export const|function` names, so nothing else is exported).

  A movement:
    { label, item, at, kind, raw_status, raw_event, ref_type, ref_id, ref_line, from_wh, to_wh, user, source, detail, key }
    label     the inventory label (Portal's SerialNumber on a label, e.g. 176255-0000514371; buyback B-<item>-<digits>).
              null only for item-level records (a WO parts event with no serial).
    item      Portal's item number (the label's first part when nothing better is known)
    at        ISO UTC (…Z). Portal times without a zone are read as UTC (same as metrics.js isoZ; check against captures).
    kind      one of KINDS. Unknown raw values are kept as 'status_changed' with the raw fields: nothing is dropped,
              and since raw_status / raw_event / detail are stored, kinds can be worked out again once captures arrive.
    ref_type  po | wo | sales_order | transfer | rma | buyback | count | arrival | van | (Portal's own RefTable text, lowercased)
    source    history | snapshot | wo | wo_event | transfer | count | rma | buyback | po | watch | sweep
    key       stable dedupe key: inv_movements is UNIQUE (store, key), so reading the same record twice adds nothing.
              <source>:<hash of the fields that identify the record>; the record's own id where Portal gives one.

  Mapping tables below: KNOWN = seen in Portal data captured at store 914 on Oct 23, 2026 (fixtures in
  test/fixtures/retrace/, scrubbed); GUESS = not seen yet (extend once a capture shows it).
*/

export const KINDS = ['shipped_to_store', 'received', 'reserved', 'unreserved', 'used', 'sold', 'returned', 'swapped_in', 'swapped_out',
  'transfer_out', 'transfer_in', 'van_out', 'van_in', 'adjusted_in', 'adjusted_out', 'count_found', 'count_missing',
  'quarantined', 'defective', 'lost', 'rma', 'buyback', 'salvage', 'consignment_changed', 'status_changed'];
export const SOURCES = ['history', 'snapshot', 'wo', 'wo_event', 'transfer', 'count', 'rma', 'buyback', 'po', 'watch', 'sweep'];
export const DOC_TYPES = ['transfer', 'rma', 'buyback', 'count', 'po', 'van', 'arrival', 'outstanding'];

// ------------------------------------------------------------------ RAW → KIND (extend as captures show more)
/*
  Serial history's SerialEventType → kind (lowercased). All KNOWN (Oct 23 capture); a { status: kind } entry takes the
  kind from the row's SerialStatus ('*' = any other). An event not listed here is 'status_changed' with its raw
  values: the row's SerialStatus alone can't stand in for it (it reads Received on reservations and sales too).
    POShipped / InTransit / Purchase orders            the vendor shipped the PO to the store (System)
    ProductReceipt(Auto) / Received / Purchase orders  received at the store
    SerialReserved, SerialUnReserved / Sales orders    on / off a WO's sales order (FSO…; the WO number is blank in history)
    Sold / Sales orders                                sold on the WO
    ConsignmentCharge / Purchase orders                consigned → owned ("Converted to owned at store 914 …")
    Count / Inventory journal table                    confirmed by a count (UBF-… journal)
    Disposition / Defective / Reason code              marked defective (SourceKey is the reason, e.g. "Defective part(s)")
    Disposition / Received / Inventory journal table   disposition back to received
    LostConsignedAndAutoReceived / Lost / Reason code  a consigned label lost (auto-received, then lost)
*/
export const EVENT_KINDS = {
  'poshipped': 'shipped_to_store',
  'productreceipt': 'received',
  'productreceiptauto': 'received',
  'serialreserved': 'reserved',
  'serialunreserved': 'unreserved',
  'sold': 'sold',
  'consignmentcharge': 'consignment_changed',
  'count': { lost: 'count_missing', '*': 'count_found' },           // Lost on a count: GUESS (only Received seen)
  'disposition': { defective: 'defective', received: 'adjusted_in', available: 'adjusted_in', lost: 'lost', '*': 'status_changed' }, // available / lost: GUESS
  'lostconsignedandautoreceived': 'lost',
};
/*
  A label's SerialStatus from one snapshot to the next (label details / store-products; spaces dropped, lowercased).
  Seen: Available, Reserved, Sold, Defective (snapshots), Received, InTransit, Defective, Lost (history). The rest of
  Portal's ItemSerialStatus enum (Damaged, Broken, In Transit, None, Adjusted (Deleted), Non Defective RMA) is
  known by name only: their kinds are GUESSES. null = depends on the status before it (AVAILABLE_AFTER) or no move.
*/
export const STATUS_KINDS = {
  'received': 'received',
  'reserved': 'reserved',
  'sold': 'sold',
  'lost': 'lost',
  'defective': 'defective',
  'damaged': 'defective',             // GUESS
  'broken': 'defective',              // GUESS
  'intransit': 'shipped_to_store',    // InTransit on a PO (seen); on a store transfer it's transfer_out (kindOf, by ref_type)
  'adjusted(deleted)': 'adjusted_out', // GUESS
  'nondefectiverma': 'rma',           // GUESS
  'available': null,
  'none': null,
};
// Back to Available after …. Reserved → Available = unreserved (seen in snapshots); the rest are GUESSES.
export const AVAILABLE_AFTER = {
  'reserved': 'unreserved',
  'intransit': 'received',
  'adjusted(deleted)': 'adjusted_in',
  'lost': 'count_found',
  'defective': 'adjusted_in', 'damaged': 'adjusted_in', 'broken': 'adjusted_in',
  'sold': 'returned',
};
// Portal's RefTable → ref_type. The first four KNOWN; the rest GUESSES; anything else is kept, lowercased.
export const REF_TYPES = [
  [/^purchase orders?$/i, 'po'],
  [/^sales orders?$/i, 'sales_order'],
  [/^inventory journal table$/i, 'journal'],
  [/^reason code$/i, 'reason'],
  [/transfer/i, 'transfer'],          // GUESS
  [/rma/i, 'rma'],                    // GUESS
  [/buy.?back/i, 'buyback'],          // GUESS
  [/work.?order/i, 'wo'],             // GUESS
  [/count/i, 'count'],                // GUESS
];
// WarehouseLocationType (label details: Main seen; Quarantine | Lost | Van by name) → what moving there means (GUESSES).
export const LOCATION_KINDS = { quarantine: 'quarantined', lost: 'lost', van: 'van_out' };
// Count line results. GUESSES: Portal's count line shapes not captured yet.
export const COUNT_FOUND = /^(found|counted|scanned|matched|ok|present|true)$/i;
export const COUNT_MISSING = /^(missing|not ?found|lost|unscanned|absent|false)$/i;

// ------------------------------------------------------------------ helpers
const str = (v, max) => (v == null || typeof v === 'object' ? null : String(v).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) || null);
const low = (v) => (str(v, 80) || '').toLowerCase();
const first = (o, keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return null; };
const n2 = (v) => { const x = typeof v === 'string' && v.trim() !== '' ? Number(v) : v; return typeof x === 'number' && isFinite(x) ? Math.round(x * 100) / 100 : null; };

// Any parseable time → ISO UTC (…Z); no zone = UTC. null when it isn't a time.
export const isoAt = (v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\d/.test(v)) return null;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(v) || v.length <= 10 ? v : v + 'Z');
  return isNaN(d) ? null : d.toISOString();
};
// 53-bit string hash (cyrb53) as base 36: short, stable dedupe keys without async crypto (this file runs in the browser too).
export function hash53(s) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
const keyOf = (source, parts) => source + ':' + hash53(parts.map((p) => (p == null ? '' : String(p))).join('|'));

/*
  Labels: <item>-<digits> (176255-0000514371: item 176255 + 10 digits), buyback B-<item>-<digits>. parseLabel
  → { label, item, buyback } or null. Item ids are digits in every label seen so far; letters are allowed in case.
  cleanLabel is the looser check for storage: Portal's own SerialNumber text, trimmed, safe characters only.
*/
export const LABEL_RE = /^(B-)?([A-Za-z0-9]{2,20})-(\d{4,14})$/i;
export function parseLabel(v) {
  const s = str(v, 40);
  const m = s && LABEL_RE.exec(s);
  if (!m) return null;
  return { label: (m[1] ? 'B-' : '') + m[2] + '-' + m[3], item: m[2], buyback: !!m[1] };
}
export function cleanLabel(v) {
  const p = parseLabel(v);
  if (p) return p.label;
  const s = str(v, 40);
  return s && /^[A-Za-z0-9][A-Za-z0-9._\-/]{2,39}$/.test(s) ? s : null;
}
export const itemOfLabel = (label) => { const p = parseLabel(label); return p ? p.item : null; };
export const refTypeOf = (refTable) => {
  const s = str(refTable, 40);
  if (!s) return null;
  const hit = REF_TYPES.find(([re]) => re.test(s));
  return hit ? hit[1] : s.toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 30);
};

/*
  The kind for a raw record. With an event (serial history): EVENT_KINDS, else 'status_changed'. Without one (a
  snapshot diff): the status table, Available's "after" table, InTransit on a transfer = transfer_out.
*/
const stKey = (v) => (str(v, 60) || '').toLowerCase().replace(/\s+/g, '');
export function kindOf({ status, event, prevStatus, refType } = {}) {
  const st = stKey(status), prev = stKey(prevStatus), ev = stKey(event);
  if (ev) {
    const k = EVENT_KINDS[ev];
    if (typeof k === 'string') return k;
    if (k && typeof k === 'object') return k[st] || k['*'];
    return 'status_changed';
  }
  if (st === 'intransit' && refType === 'transfer') return 'transfer_out';
  if (STATUS_KINDS[st]) return STATUS_KINDS[st];
  if (st === 'available' && AVAILABLE_AFTER[prev]) return AVAILABLE_AFTER[prev];
  return 'status_changed';
}

// One movement with every field present (null when unknown) and its key.
function mv(o, keyParts) {
  const label = o.label ? cleanLabel(o.label) : null;
  const m = {
    label, item: str(o.item, 40) || itemOfLabel(label), at: o.at, kind: KINDS.includes(o.kind) ? o.kind : 'status_changed',
    raw_status: str(o.raw_status, 60), raw_event: str(o.raw_event, 80), ref_type: str(o.ref_type, 30), ref_id: str(o.ref_id, 60), ref_line: str(o.ref_line, 20),
    from_wh: str(o.from_wh, 60), to_wh: str(o.to_wh, 60), user: str(o.user, 80), source: o.source, detail: str(o.detail, 300), key: null,
  };
  m.key = keyOf(m.source, keyParts || [m.label, m.at, m.kind, m.raw_status, m.raw_event, m.ref_type, m.ref_id, m.ref_line]);
  return m;
}
const personName = (u) => (u && typeof u === 'object' ? [u.givenName, u.familyName].filter(Boolean).join(' ') || null : str(u, 80));

/*
  A label snapshot from any of Portal's shapes (boh/inventory/{label} details, store-products/{item}/inventory rows)
  or from this function's own output, so the browser may send either. Fields Portal didn't send stay undefined,
  so a partial row (store-products has no location) never reads as a change.
    { label, item, product, status, location, consignment, warehouse, store, cost, po, wo, sales_order, arrival, oem_serial, imei, modified }
  Consignment is Portal's ConsignmentStatus as sent: "Yes" (consigned) / "No" (owned).
*/
export function labelSnapshot(r) {
  if (!r || typeof r !== 'object') return null;
  const label = cleanLabel(first(r, ['label', 'SerialNumber', 'serialNumber', 'InventSerialId', 'serial']));
  if (!label) return null;
  const out = { label };
  const set = (k, keys, f) => { const v = first(r, keys); if (v !== null) { const x = f(v); if (x !== null) out[k] = x; } };
  const s = (max) => (v) => str(v, max);
  set('item', ['item', 'ItemNumber', 'itemNumber', 'ItemId', 'itemId'], s(40));
  if (!out.item) out.item = itemOfLabel(label);
  set('product', ['product', 'ProductName', 'productName', 'ItemName'], s(120));
  set('status', ['status', 'SerialStatus', 'serialStatus'], s(40));
  set('location', ['location', 'WarehouseLocationType', 'warehouseLocationType'], s(30));
  set('consignment', ['consignment', 'ConsignmentStatus', 'consignmentStatus'], s(30));
  set('warehouse', ['warehouse', 'Warehouse', 'WarehouseId', 'warehouseId', 'InventLocationId'], s(40));
  // store-products rows have no location type; their quarantine warehouse is the store's id + Q ("914Q", seen). GUESS:
  // read as Quarantine (the label details for a quarantined label should say the same).
  if (!out.location && out.warehouse && /^\d{1,6}Q$/i.test(out.warehouse)) out.location = 'Quarantine';
  set('store', ['store', 'Store', 'StoreId', 'storeId'], s(40));
  set('cost', ['cost', 'PurchasePrice', 'purchasePrice'], n2);
  set('po', ['po', 'PurchaseOrderNumber', 'PurchId', 'purchId'], s(40));
  set('wo', ['wo', 'WorkOrderId', 'WorkorderId', 'workorderId'], s(20));
  set('sales_order', ['sales_order', 'SalesOrderNumber', 'salesOrderNumber'], s(40));
  set('arrival', ['arrival', 'ArrivalId', 'arrivalId'], s(40));
  set('oem_serial', ['oem_serial', 'OEMSerialNumber', 'oemSerialNumber'], s(60));
  set('imei', ['imei', 'IMEI'], s(30));
  set('modified', ['modified', 'SerialModified'], isoAt);   // store-products: when Portal last changed the label (re-read its history after)
  return out;
}

// ------------------------------------------------------------------ normalizers, one per source
export const normalize = {
  /*
    One serial-history row (GET boh/serial-history/{label} → { value: [rows] }):
      { InventSerialId (= the label), ItemId, Store, DateTime (ISO Z), SerialEventType, SerialStatus, RefTable,
        SourceKey (UBFPO… / FSO… / UBF-… / a reason), SourceKeyLineNum, User, Message, @odata.etag, dataAreaId }
    The WO number is blank in history: sales orders (FSO…) are tied to WOs through inv_so_wo (src/retrace-api.js).
    Keyed on (label, DateTime, event, status, source doc, line): reading the same history again adds nothing.
  */
  history(label, row, prev) {
    const at = isoAt(row && row.DateTime);
    if (!at || !cleanLabel(label)) return null;
    const refType = refTypeOf(row.RefTable), mapped = refType && REF_TYPES.some(([, t]) => t === refType);
    const detail = [str(row.Message, 200), row.RefTable && !mapped ? 'RefTable ' + str(row.RefTable, 40) : null].filter(Boolean).join(' · ') || null;
    return mv({ label, item: str(row.ItemId, 40) || itemOfLabel(label), at, kind: kindOf({ status: row.SerialStatus, event: row.SerialEventType, prevStatus: prev && prev.SerialStatus, refType }),
      raw_status: row.SerialStatus, raw_event: row.SerialEventType, ref_type: refType, ref_id: row.SourceKey, ref_line: row.SourceKeyLineNum, user: row.User, source: 'history', detail },
    [cleanLabel(label), at, str(row.SerialEventType, 80), str(row.SerialStatus, 60), str(row.SourceKey, 60), str(row.SourceKeyLineNum, 20)]);
  },
  // A label's whole history, oldest first (Portal's order isn't trusted), each row with the one before it.
  historyRows(label, rows) {
    const list = (Array.isArray(rows) ? rows : rows && Array.isArray(rows.value) ? rows.value : []).filter((r) => r && isoAt(r.DateTime)).slice().sort((a, b) => (isoAt(a.DateTime) < isoAt(b.DateTime) ? -1 : isoAt(a.DateTime) > isoAt(b.DateTime) ? 1 : 0));
    return list.map((r, i) => normalize.history(label, r, list[i - 1])).filter(Boolean);
  },

  /*
    Two snapshots of one label (labelSnapshot shape; before = what's stored). A status or location change gives one
    movement (the status's kind when it says something, else the location's); a consignment change gives its own.
    First sight (no before) gives nothing: the serial history read that follows has the real past.
  */
  labelDiff(before, after, at) {
    if (!before || !after || !after.label) return [];
    const out = [], ch = (k) => after[k] !== undefined && before[k] != null && after[k] != null && low(before[k]) !== low(after[k]);
    const base = { label: after.label, item: after.item || before.item, at, source: 'snapshot' };
    if (ch('status') || ch('location')) {
      let kind = ch('status') ? kindOf({ status: after.status, prevStatus: before.status }) : 'status_changed';
      if (ch('location')) {
        const to = low(after.location), from = low(before.location);
        const lk = LOCATION_KINDS[to] || (from === 'van' && to === 'main' ? 'van_in' : null);
        if (lk && (kind === 'status_changed' || !ch('status'))) kind = lk;
      }
      out.push(mv(Object.assign({}, base, { kind, raw_status: after.status || before.status, raw_event: ch('status') ? 'status ' + (before.status || '') + ' → ' + after.status : null,
        from_wh: ch('location') ? before.location : null, to_wh: ch('location') ? after.location : null,
        detail: ch('location') ? 'location ' + before.location + ' → ' + after.location : null })));
    }
    if (ch('consignment')) out.push(mv(Object.assign({}, base, { kind: 'consignment_changed', raw_status: after.consignment, raw_event: 'consignment ' + before.consignment + ' → ' + after.consignment })));
    return out;
  },

  /*
    WO cart lines before and after (the plain part's cart.items: serial = the label, serialStatus, partStatus,
    warehouseId, itemId, lineId). ctx { wo, at, sold, events }:
      a label appears on a line                → reserved
      it's gone before the sale                → unreserved
      it's gone at the sale (cart emptied with the WO at Sale complete / Closed: ctx.sold),
        or its line says Sold                  → used
    Swaps explained by a PARTS_UPDATED swap event (ctx.events) are left to normalize.partsEvent. Who and when come
    from the matching add / remove event when there is one (same item), else ctx.at and no user.
    Keyed on (wo, line, label, kind): re-sent carts and a later "emptied" after "Sold" add nothing.
  */
  cartDiff(prevItems, nextItems, ctx) {
    const c = ctx || {}, wo = str(c.wo, 20), at = c.at;
    const lines = (items) => (Array.isArray(items) ? items : []).map((i) => ({ label: cleanLabel(i && i.serial), i })).filter((x) => x.label);
    const prev = lines(prevItems), next = lines(nextItems);
    const before = new Map(prev.map((x) => [x.label, x])), after = new Map(next.map((x) => [x.label, x]));
    const events = Array.isArray(c.events) ? c.events : [];
    const swapped = new Set();
    for (const e of events) if (e && e.eventData && e.eventData.type === 'swap') { swapped.add(cleanLabel(e.eventData.oldSerialNumber)); swapped.add(cleanLabel(e.eventData.newSerialNumber)); }
    const used = new Set();
    const match = (type, x) => {
      const item = String(first(x.i, ['itemId', 'productId']) || ''), num = itemOfLabel(x.label);
      const hit = events.filter((e) => e && e.eventData && e.eventData.type === type && !used.has(e.eventId)
        && (e.eventData.items || []).some((it) => (item && String(it.itemId) === item) || (num && it.item && String(it.item.itemNumber) === num)))
        .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))[0];
      if (hit) used.add(hit.eventId);
      return hit || null;
    };
    const line = (x) => ({ label: x.label, item: str(first(x.i, ['itemNumber', 'sku']), 40) || itemOfLabel(x.label), ref_type: 'wo', ref_id: wo, ref_line: str(x.i.lineId, 20),
      raw_status: str(x.i.partStatus, 40) || str(x.i.serialStatus, 40), from_wh: null, to_wh: null, source: 'wo' });
    const keyed = (o) => mv(o, [wo, o.ref_line, o.label, o.kind]);
    const out = [];
    for (const x of next) {
      const b = before.get(x.label), sold = /^sold$/i.test(str(x.i.partStatus, 40) || '') || /^sold$/i.test(str(x.i.serialStatus, 40) || '');
      if (!b && !swapped.has(x.label)) {
        const e = match('add', x);
        out.push(keyed(Object.assign(line(x), { kind: 'reserved', at: isoAt(e && e.timestamp) || at, user: e ? personName(e.user) : null, raw_event: e ? 'PARTS_UPDATED add' : 'cart line',
          to_wh: str(x.i.warehouseId, 40), detail: c.firstSeen ? 'already on the work order when first seen' : null })));
      }
      if (sold && !(b && (/^sold$/i.test(str(b.i.partStatus, 40) || '') || /^sold$/i.test(str(b.i.serialStatus, 40) || ''))))
        out.push(keyed(Object.assign(line(x), { kind: 'used', at, user: null, raw_event: 'line sold', from_wh: str(x.i.warehouseId, 40) })));
    }
    for (const x of prev) {
      if (after.has(x.label) || swapped.has(x.label)) continue;
      if (c.sold) { out.push(keyed(Object.assign(line(x), { kind: 'used', at, user: null, raw_event: 'cart emptied at sale', from_wh: str(x.i.warehouseId, 40) }))); continue; }
      const e = match('remove', x);
      out.push(keyed(Object.assign(line(x), { kind: 'unreserved', at: isoAt(e && e.timestamp) || at, user: e ? personName(e.user) : null, raw_event: e ? 'PARTS_UPDATED remove' : 'cart line removed', from_wh: str(x.i.warehouseId, 40) })));
    }
    return out;
  },

  /*
    One WO event (GET workorder/{wo}/events, trimmed by shape.js partEvents):
      { eventId, timestamp, eventType: PARTS_UPDATED | SB_PART_UPDATED, eventData, user }
    PARTS_UPDATED swap { itemId, item, oldSerialNumber, newSerialNumber } → swapped_out (old) + swapped_in (new).
    add / remove: item-level rows (label null, 'status_changed'): a part added to a WO isn't a reservation until a
    label is on its line (a Need to order part has none). The cart diff makes the label's reserved / unreserved row
    and borrows this event's user and time for it, so the item list shows both: the WO event and the label move.
    SB_PART_UPDATED: shape unknown; kept as 'status_changed' with its serial when it has one.
    Keyed on the WO and the event id (+ side / item).
  */
  partsEvent(ev, ctx) {
    const c = ctx || {}, wo = str(c.wo, 20), d = (ev && ev.eventData) || {}, at = isoAt(ev && ev.timestamp), id = str(ev && ev.eventId, 80);
    if (!ev || !at || !id) return [];
    const user = personName(ev.user), base = { at, user, ref_type: 'wo', ref_id: wo, source: 'wo_event' };
    const itemNo = (it) => str(it && it.item && it.item.itemNumber, 40) || str(it && it.itemNumber, 40);
    if (ev.eventType === 'PARTS_UPDATED' && d.type === 'swap') {
      const out = [];
      const oldL = cleanLabel(d.oldSerialNumber), newL = cleanLabel(d.newSerialNumber);
      if (oldL) out.push(mv(Object.assign({}, base, { label: oldL, item: itemNo(d) || itemOfLabel(oldL), kind: 'swapped_out', raw_event: 'PARTS_UPDATED swap', detail: newL ? 'swapped for ' + newL : null }), [wo, id, 'out', oldL]));
      if (newL) out.push(mv(Object.assign({}, base, { label: newL, item: itemNo(d) || itemOfLabel(newL), kind: 'swapped_in', raw_event: 'PARTS_UPDATED swap', detail: oldL ? 'replaces ' + oldL : null }), [wo, id, 'in', newL]));
      return out;
    }
    if (ev.eventType === 'PARTS_UPDATED' && (d.type === 'add' || d.type === 'remove')) {
      return (Array.isArray(d.items) ? d.items : []).map((it) => mv(Object.assign({}, base, { label: null, item: itemNo(it), kind: 'status_changed', raw_event: 'PARTS_UPDATED ' + d.type,
        detail: str(it && it.item && it.item.name, 120) })), null).map((m, i) => Object.assign(m, { key: keyOf('wo_event', [wo, id, d.type, m.item, i]) }));
    }
    const serial = cleanLabel(first(d, ['serialNumber', 'serial', 'newSerialNumber']));
    return [mv(Object.assign({}, base, { label: serial, item: itemNo(d) || itemOfLabel(serial), kind: 'status_changed', raw_event: str(ev.eventType, 40) + (d.type ? ' ' + str(d.type, 20) : ''),
      raw_status: str(first(d, ['status', 'partStatus']), 40) }), [wo, id, ev.eventType, serial])];
  },

  /*
    A store transfer (boh/store-transfer-orders row): { transferOrderId, createdDate, shippedDate, receivedDate,
    storeTransferStatus, from/toInventLocationId/Name, lines: [{ lineNum, itemName, itemNumber, serialNumber }] }.
    ctx { store, warehouses: [ids that are this store] }: from here = transfer_out (when shipped), to here =
    transfer_in (when received). Direction unknown (neither side matches) = 'status_changed' at the latest date.
    GUESS: InventLocationId compared with the store number and ctx.warehouses as text (real ids not captured).
  */
  transfer(row, ctx) {
    const c = ctx || {}, id = str(row && row.transferOrderId, 60);
    if (!row || !id) return [];
    const mine = new Set([String(c.store || ''), ...(c.warehouses || []).map(String)].filter(Boolean));
    const from = str(row.fromInventLocationId, 40), to = str(row.toInventLocationId, 40);
    const fromName = str(row.fromInventLocationName, 60) || from, toName = str(row.toInventLocationName, 60) || to;
    const sides = [];
    if (from && mine.has(from) && isoAt(row.shippedDate)) sides.push(['transfer_out', isoAt(row.shippedDate)]);
    if (to && mine.has(to) && isoAt(row.receivedDate)) sides.push(['transfer_in', isoAt(row.receivedDate)]);
    if (!(from && mine.has(from)) && !(to && mine.has(to))) {
      const at = isoAt(row.receivedDate) || isoAt(row.shippedDate) || isoAt(row.createdDate);
      if (at) sides.push(['status_changed', at]);
    }
    const out = [];
    for (const l of Array.isArray(row.lines) ? row.lines : []) {
      const label = cleanLabel(l && l.serialNumber);
      if (!label) continue;
      for (const [kind, at] of sides) out.push(mv({ label, item: str(l.itemNumber, 40), at, kind, raw_status: row.storeTransferStatus, raw_event: 'store transfer', ref_type: 'transfer', ref_id: id,
        ref_line: l.lineNum, from_wh: fromName, to_wh: toName, source: 'transfer', detail: str(l.itemName, 120) }, [id, l.lineNum, label, kind]));
    }
    return out;
  },

  /*
    An inventory count: header (boh/counts: { CountingJournalId, CountType, StartDate, EndDate, InitiatedBy, CountStepType })
    and its serial lines when known ([{ serialNumber | SerialNumber, status | Status | found }]: shape GUESSED, not
    captured). Found → count_found, missing → count_missing, anything else 'status_changed' with the raw value.
  */
  count(header, lines) {
    const h = header || {}, id = str(first(h, ['CountingJournalId', 'countingJournalId', 'id']), 60);
    const at = isoAt(first(h, ['EndDate', 'endDate'])) || isoAt(first(h, ['StartDate', 'startDate']));
    if (!id || !at) return [];
    const out = [];
    for (const l of Array.isArray(lines) ? lines : []) {
      const label = cleanLabel(first(l, ['serialNumber', 'SerialNumber', 'serial', 'label']));
      if (!label) continue;
      const raw = first(l, ['status', 'Status', 'found', 'Found', 'result']), s = str(raw, 40) || '';
      const kind = COUNT_FOUND.test(s) ? 'count_found' : COUNT_MISSING.test(s) ? 'count_missing' : 'status_changed';
      out.push(mv({ label, item: str(first(l, ['itemNumber', 'ItemNumber', 'ItemId']), 40), at: isoAt(first(l, ['scannedAt', 'DateTime'])) || at, kind, raw_status: s, raw_event: 'count ' + (str(h.CountType, 30) || ''),
        ref_type: 'count', ref_id: id, user: str(h.InitiatedBy, 80), source: 'count', detail: str(h.CountStepType, 40) }, [id, label, kind]));
    }
    return out;
  },

  /*
    An RMA order (GET boh/rma-order/{id}, seen): { RMAPurchId (UBFPO…), rma_order_status, vendor_name, vendor_rma,
    tracking_number, details: [{ item_id, item_name, serial_id, rma_line_status, rma_reason, purchase_price,
    purchase_order_id, is_service_item }] }. It has no date: ctx.at (when the sweep saw it) unless one turns up.
    Keyed on (order, label, line status): each status a line reaches is one movement.
  */
  rma(order, ctx) {
    const o = order || {}, id = str(first(o, ['RMAPurchId', 'rma_order_id', 'rmaOrderId', 'PurchId', 'id']), 60);
    const at = isoAt(first(o, ['updated_at', 'updatedAt', 'created_at', 'createdAt', 'date'])) || (ctx && ctx.at);
    if (!id || !at) return [];
    return (Array.isArray(o.details) ? o.details : []).map((l) => {
      const label = cleanLabel(l && l.serial_id);
      return label && mv({ label, item: str(l.item_id, 40), at, kind: 'rma', raw_status: l.rma_line_status, raw_event: 'rma ' + (str(o.rma_order_status, 30) || 'line'), ref_type: 'rma', ref_id: id,
        to_wh: str(o.vendor_name, 60), source: 'rma', detail: [str(l.rma_reason, 100), str(l.item_name, 120)].filter(Boolean).join(' · ') || null },
        [id, label, str(l.rma_line_status, 60)]);
    }).filter(Boolean);
  },

  /*
    A buyback order with its lines ([{ SerialNumber, ItemDescription, LineStatus, Destination, … }]). Destination
    'Salvage' → salvage (GUESS), else buyback. Id / date names GUESSED like rma.
  */
  buyback(order, ctx) {
    const o = order || {}, id = str(first(o, ['BuybackOrderId', 'buybackOrderId', 'OrderId', 'id', 'orderId']), 60);
    const at = isoAt(first(o, ['UpdatedDate', 'updatedAt', 'CreatedDate', 'createdAt', 'date'])) || (ctx && ctx.at);
    if (!id || !at) return [];
    return (Array.isArray(o.lines) ? o.lines : Array.isArray(o.Lines) ? o.Lines : []).map((l) => {
      const label = cleanLabel(l && l.SerialNumber);
      return label && mv({ label, at, kind: /salvage/i.test(str(l.Destination, 40) || '') ? 'salvage' : 'buyback', raw_status: l.LineStatus, raw_event: 'buyback line', ref_type: 'buyback', ref_id: id,
        to_wh: l.Destination, source: 'buyback', detail: str(l.ItemDescription, 120) }, [id, label, str(l.LineStatus, 60), str(l.Destination, 40)]);
    }).filter(Boolean);
  },

  /*
    A PO's receive details: { Lines: [{ ItemId, ItemName, QtyReceived, Serials: [{ SerialNumber, Status }] }] }, one
    'received' per serial. ctx { po, at } when the header isn't in the same object (PO number / date names GUESSED).
  */
  poReceive(po, ctx) {
    const c = ctx || {}, p = po || {}, id = str(first(p, ['PurchaseOrderNumber', 'PurchId', 'purchId', 'poNumber']) || c.po, 60);
    const at = isoAt(first(p, ['ReceivedDate', 'receivedDate', 'DeliveryDate'])) || c.at;
    if (!id || !at) return [];
    const out = [];
    for (const l of Array.isArray(p.Lines) ? p.Lines : []) for (const s of (l && Array.isArray(l.Serials) ? l.Serials : [])) {
      const label = cleanLabel(s && s.SerialNumber);
      if (label) out.push(mv({ label, item: str(l.ItemId, 40), at, kind: 'received', raw_status: s.Status, raw_event: 'po receive', ref_type: 'po', ref_id: id, source: 'po', detail: str(l.ItemName, 120) }, [id, label]));
    }
    return out;
  },

  /*
    A movement built elsewhere (the in-page watcher, or a sweep's normalizer run in the browser), checked field by
    field: label (or item for an item-level row), time, kind from KINDS, everything else trimmed. Never trusted: the
    key is rebuilt here from the source and the fields, so a client can't overwrite or collide with other rows.
    source: 'watch' unless ctx.sources allows the one sent. null = refused.
  */
  watch(m, ctx) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    const c = ctx || {}, allowed = c.sources || ['watch'];
    const source = allowed.includes(m.source) ? m.source : allowed[0];
    const label = m.label != null ? cleanLabel(m.label) : null, at = isoAt(m.at), kind = m.kind;
    if ((m.label != null && !label) || (!label && !str(m.item, 40)) || !at || !KINDS.includes(kind)) return null;
    if (Math.abs(Date.parse(at) - (c.now || Date.now())) > 3 * 366 * 86400000) return null; // not a real time for a movement
    const out = mv(Object.assign({}, m, { label, at, kind, source }));
    if (m.key != null) out.key = source + ':' + hash53(String(str(m.key, 200)) + '|' + label);
    return out;
  },

  /*
    Outstanding parts (GET boh/rma-buyback/outstanding-parts, seen): { RMAParts, BuybackParts, SalvageParts } rows with
    { Store, ItemNumber, PartName, SerialNumber, SerialStatus, WarehouseId ("914Q"), Destination, Vendor, PurchasePrice }.
    → label snapshots (labelSnapshot shape + list: rma | buyback | salvage) for the sweep's labels and touched lists:
    a label joining one of these lists is diffed like any snapshot and its history read.
  */
  outstanding(resp) {
    const out = [];
    for (const [k, list] of [['RMAParts', 'rma'], ['BuybackParts', 'buyback'], ['SalvageParts', 'salvage']])
      for (const r of (resp && Array.isArray(resp[k]) ? resp[k] : [])) { const s = labelSnapshot(Object.assign({ product: r && r.PartName }, r)); if (s) out.push(Object.assign(s, { list })); }
    return out;
  },

  /*
    A document header for inv_docs (linking and display): transfers, RMA / buyback orders, counts, POs, van and
    arrival lists. { type, id, status, at, counterpart, data } with data the header's small fields (no lines).
    Accepts an already shaped doc ({ type, id, … }) too, so the server can run it on what the browser sends.
  */
  doc(type, raw) {
    const r = raw || {}, t = DOC_TYPES.includes(type) ? type : DOC_TYPES.includes(r.type) ? r.type : null;
    if (!t) return null;
    const id = str(r.id != null ? r.id : first(r, ({ transfer: ['transferOrderId'], count: ['CountingJournalId'], po: ['PurchaseOrderNumber', 'PurchId'], rma: ['RMAPurchId', 'PurchId', 'rma_order_id'],
      buyback: ['BuybackOrderId', 'buybackOrderId', 'OrderId'], van: ['vanId', 'VanId', 'warehouseId'], arrival: ['arrivalId', 'ArrivalId'], outstanding: ['id'] })[t]), 60);
    if (!id) return null;
    const status = str(r.status != null ? r.status : first(r, ['storeTransferStatus', 'CountStepType', 'rma_order_status', 'PurchaseOrderStatus', 'Status', 'OrderStatus', 'status']), 40);
    const at = isoAt(r.at) || isoAt(first(r, ['receivedDate', 'shippedDate', 'createdDate', 'EndDate', 'StartDate', 'updated_at', 'created_at', 'UpdatedDate', 'CreatedDate', 'OrderDate', 'AccountingDate']));
    const counterpart = str(r.counterpart != null ? r.counterpart : first(r, ['toInventLocationName', 'fromInventLocationName', 'Vendor', 'vendor', 'vendor_name', 'VanNickName']), 80);
    // data: the header's own small fields, lines and nested objects left out (they become movements).
    const src = r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : r, data = {};
    for (const [k, v] of Object.entries(src)) if (v == null || typeof v !== 'object') { if (Object.keys(data).length >= 30) break; data[str(k, 40)] = typeof v === 'string' ? v.slice(0, 200) : v; }
    return { type: t, id, status, at, counterpart, data };
  },
};

/*
  The WO hook's movements (POST /wo/:wo): the plain part before and after (shape.js plainPart, with cart lines'
  serial / serialStatus / partStatus / warehouseId / itemId and partEvents). ctx { wo, at }.
  Sold = the WO is now Sale complete or Closed (Portal empties the cart at Sale complete); Cancelled is not a sale.
  Only diffed when both carts are known (a plain part without a cart says nothing about the lines).
*/
export const SOLD_IDS = [14, 15];
export function woMovements(prevPlain, plain, ctx) {
  const c = ctx || {}, wo = c.wo, at = c.at;
  if (!plain) return [];
  const events = (Array.isArray(plain.partEvents) ? plain.partEvents : []).filter((e) => e && (e.eventType === 'PARTS_UPDATED' || e.eventType === 'SB_PART_UPDATED'));
  const out = [];
  const prevCart = prevPlain && prevPlain.cart, cart = plain.cart;
  // Before this change the pick list had no serials: a stored cart with lines but no line carrying any of the new
  // fields can't say which labels were already there, so its labels are "first seen" (still reserved, noted as such).
  const oldShape = (cr) => cr && Array.isArray(cr.items) && cr.items.length && !cr.items.some((i) => i && ('serial' in i || 'partStatus' in i || 'serialStatus' in i));
  if (cart && (prevCart || !prevPlain)) {
    const sold = SOLD_IDS.includes(Number(plain.workorder && plain.workorder.statusId)) && !(cart.items || []).length;
    const firstSeen = !prevPlain || oldShape(prevCart);
    out.push(...normalize.cartDiff(firstSeen ? [] : prevCart.items, cart.items, { wo, at, sold: sold && !firstSeen, events, firstSeen }));
  }
  // Events, every one (keyed on its id, so the list coming back on each upload adds nothing): swaps as label rows,
  // add / remove as item-level rows (the cart diff's reserved / unreserved rows above carry their user and time too).
  for (const e of events) out.push(...normalize.partsEvent(e, { wo }));
  return out;
}
