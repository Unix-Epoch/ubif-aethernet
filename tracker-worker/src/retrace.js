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
/*
  Items Retrace leaves out entirely (case-insensitive): BB0001 is Portal's generic SKU for buyback devices, so its
  labels (B-<item>-<digits>) aren't stock and would swamp the item lists. Nothing for them is stored; a label whose
  history turns out to be one of these is dropped.
*/
export const IGNORED_ITEMS = ['bb0001'];
export const ignoredItem = (item) => item != null && IGNORED_ITEMS.includes(String(item).trim().toLowerCase());
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

/*
  Item names a WO's plain part carries (inv_items.name, descriptive: Portal's cart text), for the WO hook:
  [{ item, name, label, event }]. Cart lines: the item worked out as cartDiff does (itemNumber / sku, else the label's),
  label = the line's (null when it has none). Parts events' items (item.itemNumber + item.name): event = true, since
  each one is a movement already (normalize.partsEvent).
*/
export function woNames(plain) {
  const out = [];
  for (const i of (plain && plain.cart && Array.isArray(plain.cart.items) ? plain.cart.items : [])) {
    const label = cleanLabel(i && i.serial), item = (i && str(first(i, ['itemNumber', 'sku']), 40)) || itemOfLabel(label), name = i && str(i.name, 120);
    if (item && name) out.push({ item, name, label: label || null, event: false });
  }
  for (const e of (plain && Array.isArray(plain.partEvents) ? plain.partEvents : [])) {
    const d = (e && e.eventData) || {};
    for (const it of [d.item ? { item: d.item } : null, ...(Array.isArray(d.items) ? d.items : [])]) {
      const item = str(it && it.item && it.item.itemNumber, 40), name = str(it && it.item && it.item.name, 120);
      if (item && name) out.push({ item, name, label: null, event: true });
    }
  }
  return out;
}

// ------------------------------------------------------------------ the in-page watcher (Aethernet, src/28-retrace-collect.js)
/*
  Portal's own inventory writes, seen in the page as they happen (request and answer, never changed). Paths are
  Portal's after /api/, query dropped. Every rule is a GUESS about the payload (no write captured yet): the dev
  switch "Retrace: record Portal calls" keeps real ones to check against. A rule's kind applies to the labels the
  call names: in the path (label: n = that group), else anywhere in the request body, else (fromAnswer) in Portal's
  answer. kind 'swap' / 'van' are worked out from the body (swapLabels, vanKind); 'status_changed' with the method
  and path in detail when they can't be. ref: the path group holding the document id (else the body's).
*/
export const WATCH_RULES = [
  [/^boh\/inventory\/([^/]+)\/adjust-in$/i, { kind: 'adjusted_in', label: 1 }],
  [/^boh\/inventory\/([^/]+)\/adjust-out$/i, { kind: 'adjusted_out', label: 1 }],
  [/^boh\/inventory\/([^/]+)\/mark-defective-broken$/i, { kind: 'defective', label: 1 }],
  [/^boh\/inventory\/([^/]+)$/i, { kind: 'status_changed', label: 1, methods: ['PATCH'] }],
  [/^repair\/swap-serial-on-item$/i, { kind: 'swap', ref_type: 'wo' }],
  [/^boh\/remote-tech\/transfer-inventory$/i, { kind: 'van', ref_type: 'van' }],
  [/^boh\/store-transfer-orders(?:\/([^/]+))?\/ship$/i, { kind: 'transfer_out', ref_type: 'transfer', ref: 1 }],
  [/^boh\/store-transfer-orders(?:\/([^/]+))?\/receive$/i, { kind: 'transfer_in', ref_type: 'transfer', ref: 1 }],
  [/^boh\/store-transfer-orders(?:\/([^/]+))?\/cancel$/i, { kind: 'status_changed', ref_type: 'transfer', ref: 1 }],
  [/^boh\/counts\/([^/]+)\/itemSerial$/i, { kind: 'count_found', ref_type: 'count', ref: 1 }],
  [/^boh\/counts\/([^/]+)\/(?:post|submit|reject)$/i, { kind: 'status_changed', ref_type: 'count', ref: 1 }],
  [/^order\/cart\/item\/add$/i, { kind: 'reserved', ref_type: 'cart', fromAnswer: true }],
  [/^order\/cart\/item\/remove$/i, { kind: 'unreserved', ref_type: 'cart' }],
  [/^repair\/scan-cart-line$/i, { kind: 'reserved', ref_type: 'cart', fromAnswer: true }],
  [/^workorder\/save-part-scan$/i, { kind: 'reserved', ref_type: 'wo', fromAnswer: true }],
  [/^workorder\/remove-cart-lines$/i, { kind: 'unreserved', ref_type: 'wo' }],
  // RMA / buyback / salvage order writes (create, ship, lines): Portal's paths not captured, so any write under these.
  [/^boh\/(?:rma-buyback\/)?(rma|buyback|salvage)(?:[-/][^?]*)?$/i, { kind: 'order', ref_type: 'order' }],
];
// Portal's path (full URL, /api/… or bare) → the part the rules match: no origin, no /api/, no query, no trailing /.
export const watchPath = (u) => String(u == null ? '' : u).replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0].replace(/^\/?api\//i, '').replace(/^\/+|\/+$/g, '');
// The rule for a call: writes only (GET never), PATCH-only rules for PATCH. → { re, ...rule, m } or null
export function watchRule(method, url) {
  const meth = String(method || 'GET').toUpperCase(), path = watchPath(url);
  if (meth === 'GET' || meth === 'HEAD' || meth === 'OPTIONS') return null;
  for (const [re, rule] of WATCH_RULES) {
    const m = re.exec(path);
    if (m && (!rule.methods || rule.methods.includes(meth))) return Object.assign({ re, m, path }, rule);
  }
  return null;
}
// Every label in a JSON value (depth ≤ 6), with the property it was under: [{ label, key }], each label once.
// Document ids are skipped: Portal's cart ids (<store>-<13 digits>, e.g. 914-5631238484180) read like labels.
const NOT_LABEL_KEYS = /^(cartId|csuCartId|salesId|salesOrderId|csuSalesOrderId|workorderId|workOrderId|woId|transferOrderId|purchId|countingJournalId|orderId|id|lineId|parentLineId)$/i;
export function labelsIn(v) {
  const out = [], seen = new Set();
  const walk = (x, key, d) => {
    if (d > 6 || x == null || (key && NOT_LABEL_KEYS.test(key))) return;
    if (typeof x === 'string' || typeof x === 'number') { const p = parseLabel(x); if (p && !seen.has(p.label)) { seen.add(p.label); out.push({ label: p.label, key: key || '' }); } return; }
    if (Array.isArray(x)) { for (const y of x.slice(0, 500)) walk(y, key, d + 1); return; }
    if (typeof x === 'object') for (const [k, y] of Object.entries(x)) walk(y, k, d + 1);
  };
  walk(v, '', 0);
  return out;
}
const asJson = (v) => { if (typeof v !== 'string') return v == null ? null : v; try { return JSON.parse(v); } catch (_) { return v.trim() || null; } };
// A shallow-ish search for the first value under a key matching re (depth ≤ 3).
const findKey = (o, re, d = 0) => {
  if (!o || typeof o !== 'object' || d > 3) return null;
  for (const [k, v] of Object.entries(o)) if (re.test(k) && v != null && typeof v !== 'object' && String(v).trim() !== '') return v;
  for (const v of Object.values(o)) { const x = v && typeof v === 'object' ? findKey(Array.isArray(v) ? v[0] : v, re, d + 1) : null; if (x != null) return x; }
  return null;
};

/*
  One Portal write call → movements for POST /retrace/watch (still checked there by normalize.watch).
    call { method, url, body, response, at }   body / response: Portal's JSON as text or parsed
    ctx  { user, store }                        the signed-in tech's name; the page's store (van direction)
  Labels from the path or the body are keyed per call (adjusting the same label twice is two movements); labels
  only found in Portal's answer (a cart add answers with the whole cart) are keyed per document, label and kind, so
  the labels already on that cart add nothing the next time. A call naming no label but an item gives one
  item-level 'status_changed'; a call naming neither gives nothing (the recorder still keeps it in dev).
*/
export function watchMovements(call, ctx) {
  const x = call || {}, c = ctx || {}, rule = watchRule(x.method, x.url);
  const at = isoAt(x.at);
  if (!rule || !at) return [];
  const method = String(x.method).toUpperCase(), body = asJson(x.body), resp = asJson(x.response);
  const obj = body && typeof body === 'object' ? body : null;
  const what = method + ' ' + rule.path;
  // The document: the path's id, else the body's (cart / WO / transfer / count / order ids, GUESSED names).
  let refType = rule.ref_type || null, refId = rule.ref ? rule.m[rule.ref] || null : null;
  if (obj && rule.ref_type === 'cart') {
    const wo = findKey(obj, /^(workorderId|workOrderId|woId)$/i);
    if (wo != null) { refType = 'wo'; refId = wo; } else refId = findKey(obj, /^(cartId|csuCartId)$/i);
  }
  if (!refId && obj) refId = findKey(obj, rule.ref_type === 'wo' ? /^(workorderId|workOrderId|woId)$/i : rule.ref_type === 'transfer' ? /^(transferOrderId|transferId)$/i
    : rule.ref_type === 'count' ? /^(countingJournalId|countId)$/i : /^(rmaPurchId|rmaOrderId|buybackOrderId|orderId|purchId|id)$/i);
  if (rule.kind === 'order') { const t = rule.m[1].toLowerCase(); refType = t; }
  // Labels: the path's, else the body's, else (fromAnswer rules) the answer's.
  let found = [], fromAnswer = false;
  if (rule.label) { const p = cleanLabel(decodeURIComponent(rule.m[rule.label] || '')); if (p) found.push({ label: p, key: 'path' }); }
  if (!found.length) found = labelsIn(body);
  if (!found.length && rule.fromAnswer) { found = labelsIn(resp); fromAnswer = found.length > 0; }
  const base = { at, user: c.user || null, source: 'watch', ref_type: refType, ref_id: refId != null ? String(refId) : null, raw_event: what };
  const callKey = [method, rule.path, refId, at].join('|');
  const one = (label, kind, extra) => Object.assign({}, base, { label, item: itemOfLabel(label), kind }, extra || {},
    { key: fromAnswer ? ['answer', rule.path, refType, refId, kind].join('|') : callKey + '|' + kind });
  if (!found.length) {
    const item = obj && findKey(obj, /^(itemId|itemNumber|ItemNumber|ItemId|sku)$/);
    return item != null && str(item, 40) ? [Object.assign({}, base, { label: null, item: str(item, 40), kind: 'status_changed', detail: what, key: callKey + '|item' })] : [];
  }
  if (rule.kind === 'swap') {
    const oldL = found.find((f) => /old|from|current|original|remove/i.test(f.key)), newL = found.find((f) => f !== oldL && /new|to|replace|add/i.test(f.key));
    if (oldL && newL) return [one(oldL.label, 'swapped_out', { detail: 'swapped for ' + newL.label }), one(newL.label, 'swapped_in', { detail: 'replaces ' + oldL.label })];
    return found.map((f) => one(f.label, 'status_changed', { detail: what + ' (' + (f.key || '?') + ')' }));
  }
  if (rule.kind === 'van') {
    // GUESS: a destination that is the store's own warehouse = back from a van; anything else = out to a van.
    const to = obj && findKey(obj, /^(to|dest|target)/i), from = obj && findKey(obj, /^(from|source)/i), st = String(c.store || '');
    const kind = st && to != null && String(to).startsWith(st) ? 'van_in' : st && from != null && String(from).startsWith(st) ? 'van_out' : to != null ? 'van_out' : 'status_changed';
    return found.map((f) => one(f.label, kind, { from_wh: from != null ? String(from) : null, to_wh: to != null ? String(to) : null, detail: kind === 'status_changed' ? what : null }));
  }
  if (rule.kind === 'order') return found.map((f) => one(f.label, refType, { detail: what }));
  return found.map((f) => one(f.label, rule.kind, { detail: rule.kind === 'status_changed' ? what : null }));
}

// A list from any of Portal's envelopes: [rows], { value }, { data }, { results }, { items }, { rows } (else []).
export function rowsOf(j) {
  if (Array.isArray(j)) return j;
  if (!j || typeof j !== 'object') return [];
  for (const k of ['value', 'data', 'results', 'items', 'rows', 'orders', 'transferOrders']) if (Array.isArray(j[k])) return j[k];
  return [];
}

// ------------------------------------------------------------------ purchase orders (status over time)
/*
  A PO as Retrace keeps it (inv_docs type 'po', data = this object), built from Portal's shapes (captured at 914, Oct 23):
    header   POST boh/purchase-orders list rows, or GET boh/purchase-orders/{po} (the same plus PurchaseOrderLinesV2)
    receive  GET boh/purchase-orders/{po}/receive-details ({ Status, TrackingNum, Lines: [{ LineNum, Qty, QtyReceived,
             QtyCancelled, QtyScanned, Serials: [{ SerialNumber, Status ("In Transit" | "Received" | "N/A" | "UnRegistered"),
             OEMSerialNumber, imei, CancelledLine }] }] })
  → { id, status, approval, remaining, registered, tracking, autoReceiveAt, autoReceivePaused, mergedInto, info: {…},
      lines?: [{ line, item, desc, ordered, shipped, received, scanned, cancelled, remaining, price, amount, consignment }],
      labels?: [{ label, line, item, status, oem, imei, cancelled }] }
  lines / labels only when the source had them: a list row (no lines) merged into a stored PO keeps its lines.
  PO_FIELDS are tracked: a change is a status-history row (inv_doc_events), and a list row whose tracked fields
  differ from the stored ones asks for the PO's lines and receive details again (poSig).
*/
const bool = (v) => (v === true || v === false ? v : /^(true|yes|1)$/i.test(String(v)) ? true : /^(false|no|0)$/i.test(String(v)) ? false : null);
const isoOrStr = (v) => isoAt(v) || str(v, 40);
// [field, the header's name, receive-details' name (used when the header has none), shape]
export const PO_FIELDS = [
  ['status', 'PurchaseOrderStatus', 'Status', (v) => str(v, 40)],
  ['approval', 'DocumentApprovalStatus', null, (v) => str(v, 40)],
  ['remaining', 'UbifTotalRemainingQty', null, n2],
  ['registered', 'UbifTotalRegisteredQty', null, n2],
  ['tracking', 'asuTrackingNumber', 'TrackingNum', (v) => str(v, 80)],
  ['autoReceiveAt', 'UbifAutoReceiveDateTime', 'AutoReceiveDateTime', isoOrStr],
  ['autoReceivePaused', 'UbifIsAutoReceivePaused', 'IsAutoReceivePaused', bool],
  ['mergedInto', 'UbifMergedIntoPurchId', null, (v) => str(v, 40)],
];
// Shown, not tracked. Left out on purpose: addresses and payment method.
const PO_INFO = [['pool', 'PurchaseOrderPoolId'], ['type', 'UbifPurchaseOrderType'], ['vendor', 'OrderVendorAccountNumber'], ['vendorRef', 'VendorOrderReference'],
  ['site', 'DefaultReceivingSiteId'], ['warehouse', 'DefaultReceivingWarehouseId'], ['accountingDate', 'AccountingDate'], ['total', 'UbifTotalAmount'],
  ['consignedAmount', 'ConsignedAmount'], ['ownedAmount', 'OwnedAmount'], ['jit', 'UbifIsJIT'], ['fused', 'UbifIsFused'], ['delivery', 'DeliveryModeDescription'],
  ['storeName', 'StoreName'], ['crossStore', 'IsCrossStore'], ['currency', 'CurrencyCode'], ['distro', 'IsDistro']];
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export function poState(header, receive) {
  const h = header && typeof header === 'object' ? header : {}, r = receive && typeof receive === 'object' ? receive : null;
  const id = str(first(h, ['PurchaseOrderNumber', 'PurchId', 'id']) || (r && first(r, ['PurchaseOrderId', 'PurchaseOrderNumber'])), 40);
  if (!id) return null;
  const out = { id };
  for (const [k, hk, rk, f] of PO_FIELDS) {
    if (h[hk] !== undefined && (h[hk] !== null || !(r && rk && r[rk] != null))) out[k] = h[hk] == null ? null : f(h[hk]);
    else if (r && rk && r[rk] !== undefined) out[k] = r[rk] == null ? null : f(r[rk]);
  }
  const info = {};
  for (const [k, key] of PO_INFO) { const v = h[key] !== undefined ? h[key] : r && key === 'IsDistro' ? r.IsDistro : undefined; if (v !== undefined && (v === null || typeof v !== 'object')) info[k] = typeof v === 'string' ? str(v, 120) : v; }
  if (r && r.PurchaseOrderPoolId && !info.pool) info.pool = str(r.PurchaseOrderPoolId, 40);
  if (Object.keys(info).length) out.info = info;
  const lines = new Map();
  const line = (n) => { const k = str(n, 12); if (!k) return null; if (!lines.has(k)) lines.set(k, { line: k }); return lines.get(k); };
  if (Array.isArray(h.PurchaseOrderLinesV2)) for (const l of h.PurchaseOrderLinesV2) {
    const x = line(l && l.LineNumber);
    if (x) Object.assign(x, defined({ item: str(l.ItemNumber, 40) || undefined, desc: str(l.LineDescription, 120) || undefined, ordered: n2(l.OrderedPurchaseQuantity) ?? undefined,
      shipped: n2(l.UBIFShippedQty) ?? undefined, cancelled: n2(l.UBIFCancelQty) ?? undefined, remaining: n2(l.RemainPurchPhysical) ?? undefined, price: n2(l.PurchasePrice) ?? undefined,
      amount: n2(l.LineAmount) ?? undefined, consignment: str(l.UbifIsEnabledForConsignment, 10) || undefined }));
  }
  const labels = [];
  if (r && Array.isArray(r.Lines)) for (const l of r.Lines) {
    const x = line(l && l.LineNum);
    if (!x) continue;
    Object.assign(x, defined({ item: x.item || str(l.ItemId, 40) || undefined, desc: x.desc || str(l.ItemName, 120) || undefined, ordered: x.ordered ?? n2(l.Qty) ?? undefined,
      received: n2(l.QtyReceived ?? l.PurchaseQtyReceived) ?? undefined, scanned: n2(l.QtyScanned) ?? undefined, cancelled: x.cancelled ?? n2(l.QtyCancelled) ?? undefined,
      serialized: typeof l.IsSerialized === 'boolean' ? l.IsSerialized : undefined }));
    for (const s of Array.isArray(l.Serials) ? l.Serials : []) {
      const label = cleanLabel(s && s.SerialNumber);
      if (label && !labels.some((y) => y.label === label)) labels.push(defined({ label, line: x.line, item: x.item || itemOfLabel(label), status: str(s.Status, 30), oem: str(s.OEMSerialNumber, 60) || undefined,
        imei: str(s.imei, 30) || undefined, cancelled: s.CancelledLine ? true : undefined }));
    }
  }
  if (lines.size) out.lines = [...lines.values()].sort((a, b) => Number(a.line) - Number(b.line) || (a.line < b.line ? -1 : 1));
  if (r) out.labels = labels;
  return out;
}
// The stored PO with a newer reading on top: fields the reading didn't carry keep their stored value; lines merge by number.
export function mergePo(prev, next) {
  if (!prev) return next;
  if (!next) return prev;
  const out = Object.assign({}, prev, defined(Object.assign({}, next, { lines: undefined, labels: undefined, info: undefined })));
  if (next.info) out.info = Object.assign({}, prev.info || {}, next.info);
  if (next.lines) {
    const old = new Map((prev.lines || []).map((l) => [l.line, l]));
    out.lines = next.lines.map((l) => Object.assign({}, old.get(l.line) || {}, l));
  }
  if (next.labels) out.labels = next.labels;
  return out;
}
export const poSig = (po) => hash53(JSON.stringify(PO_FIELDS.map(([k]) => (po && po[k] !== undefined ? po[k] : null))));
/*
  What changed between two readings of a PO → status-history rows [{ field, old, new }]:
    a tracked header field (PO_FIELDS) · a line's received / shipped / cancelled / ordered quantity ('line <n> received')
    · a label's receive status ('label <label>'). First sight of the PO = one 'status' row from null; first sight of
  its lines or labels (nothing stored to compare) adds nothing.
*/
const LINE_QTY = ['ordered', 'shipped', 'received', 'cancelled'];
export function poEvents(prev, next) {
  if (!next) return [];
  const t = (v) => (v == null ? null : String(v));
  if (!prev) return next.status != null ? [{ field: 'status', old: null, new: t(next.status) }] : [];
  const out = [];
  for (const [k] of PO_FIELDS) if (next[k] !== undefined && t(prev[k]) !== t(next[k]) && !(prev[k] === undefined && next[k] == null)) out.push({ field: k, old: t(prev[k]), new: t(next[k]) });
  if (prev.lines && next.lines) {
    const old = new Map(prev.lines.map((l) => [l.line, l]));
    for (const l of next.lines) for (const q of LINE_QTY) {
      const o = old.get(l.line);
      if (l[q] !== undefined && (o ? t(o[q]) !== t(l[q]) && !(o[q] === undefined && !l[q]) : l[q])) out.push({ field: 'line ' + l.line + ' ' + q, old: o ? t(o[q]) : null, new: t(l[q]) });
    }
  }
  if (prev.labels && next.labels) {
    const old = new Map(prev.labels.map((l) => [l.label, l]));
    for (const l of next.labels) { const o = old.get(l.label); if (!o || t(o.status) !== t(l.status)) out.push({ field: 'label ' + l.label, old: o ? t(o.status) : null, new: t(l.status) }); }
  }
  return out;
}
// Labels whose receive status went In Transit → Received between two readings: one 'received' movement each (same key
// as normalize.poReceive, so a PO read twice adds nothing; the Worker also skips it when serial history already has one).
export function poMovements(prev, next, at) {
  if (!prev || !prev.labels || !next || !next.labels || !at) return [];
  const old = new Map(prev.labels.map((l) => [l.label, l])), lineOf = new Map((next.lines || []).map((l) => [l.line, l]));
  return next.labels.filter((l) => /^received$/i.test(l.status || '') && old.has(l.label) && /^in ?transit$/i.test(old.get(l.label).status || '')).map((l) => mv({
    label: l.label, item: l.item, at, kind: 'received', raw_status: l.status, raw_event: 'po receive', ref_type: 'po', ref_id: next.id, ref_line: l.line, source: 'po',
    detail: str(lineOf.get(l.line) && lineOf.get(l.line).desc, 120) }, [next.id, l.label]));
}
