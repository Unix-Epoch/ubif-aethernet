/*
  Work order tracker: how a Portal work order is split before it's sent (format v1). Shared by
  Aethernet (inlined by build.py) and the Mac history import, so both shape data the same way.
    scanRow    the open-WO list row → the plain fields the Worker's /scan gets
    scrub      device passcodes removed anywhere in the detail
    plainPart  what the server can read: status, program, device model, bin, dates, staff ids,
               status history, note count, cart lines and totals, parts events. Never customer details.
               Cart lines carry their inventory label (serial), its status and the line's part status,
               warehouse and item id (Oct 23, 2026) for Retrace's WO movements (src/retrace.js woMovements).
    cardOf     the sealed search card: name, customer id, phones, emails, IMEI, serial, claim
*/
export const scanRow = (r) => ({ wo: r.workorderId, statusId: r.workorderStatusId, status: r.workorderStatusName, programId: r.programId, program: r.programName,
  device: (r.deviceCatalog && r.deviceCatalog.name) || null, outcome: OUTCOMES.includes(r.serviceOutcome) ? r.serviceOutcome : null, createdAt: r.createdAt, updatedAt: r.updatedAt });

// Passcodes don't belong in a history: removed wherever they appear.
export function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = (/passcode|password/i.test(k) || /^pin$/i.test(k)) && x != null && typeof x !== 'object' ? '[removed]' : scrub(x);
    return out;
  }
  return v;
}
export const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && o[k] !== undefined).map((k) => [k, o[k]]));

/*
  The repair's outcome. Authoritative: the WO's outcome attribute (WorkorderAttributes type 22), set when
  the repair is marked Completed / Incomplete / Declined / No issue found; a second type-22 value is the
  reason ("Failed post-repair diagnostics", "Parts aren't available", ...). Portal's list field
  serviceOutcome is often blank (54 Completed repairs in the Mac history), so it's only a fallback.
*/
const OUTCOMES = ['Completed', 'Incomplete', 'Declined', 'No issue found'];
export function outcomeOf(w, listRow) {
  const vals = ((w && w.WorkorderAttributes) || []).filter((a) => Number(a.workorderAttributeTypeId) === 22).map((a) => String(a.value || '').trim()).filter(Boolean);
  const outcome = vals.find((v) => OUTCOMES.includes(v)) || (listRow && OUTCOMES.includes(listRow.serviceOutcome) ? listRow.serviceOutcome : null);
  const reason = vals.find((v) => !OUTCOMES.includes(v)) || null;
  return { outcome, outcomeReason: reason ? reason.slice(0, 120) : null };
}

export function plainPart(d, listRow) {
  const w = (d.workorder && d.workorder.workorder) || {};
  const bin = w.WorkorderBinDeviceLocation && w.WorkorderBinDeviceLocation.WorkorderBin;
  const cd = w.CustomerDevice || {};
  return {
    workorder: {
      workorderId: w.workorderId, storeId: w.storeId, statusId: w.workorderStatusId, status: (w.WorkorderStatus && w.WorkorderStatus.name) || (listRow && listRow.workorderStatusName) || null,
      programId: w.programId, program: (w.Program && w.Program.name) || (listRow && listRow.programName) || null,
      device: (cd.DeviceCatalog && cd.DeviceCatalog.name) || (listRow && listRow.deviceCatalog && listRow.deviceCatalog.name) || cd.name || null,
      bin: (bin && (bin.name || bin.binName || bin.label)) || (listRow && listRow.locationBin) || null,
      rfpAt: (listRow && listRow.rfpWorkorderStatusDate) || null, ...outcomeOf(w, listRow), total: listRow ? listRow.workorderTotal : null,
      ...pick(w, ['createdAt', 'updatedAt', 'nextUpdate', 'slaEndTime', 'createdBy', 'updatedBy', 'arrivalId', 'clientId', 'crossStoreRefWorkorderId', 'warrantyWorkorderId', 'iqcComplete', 'csuCartId', 'csuSalesOrderId']),
    },
    auditTrail: (Array.isArray(d.audit_trail) ? d.audit_trail : []).map((a) => ({ statusId: a.workorderStatusId, createdAt: a.createdAt, createdBy: a.createdBy, completed: a.completed })),
    notes: { total: d.notes ? d.notes.total : null }, // the notes themselves are sealed
    cart: d.cart ? {
      items: (d.cart.cartItems || []).map((i) => pick(i, CART_KEYS)),
      payment: d.cart.payment || null, salesId: d.cart.salesId || null, isCanceled: !!d.cart.isCanceled,
    } : null,
    ...(eventList(d.events) ? { partEvents: partEvents(eventList(d.events)) } : {}),
  };
}
// serial = the line's inventory label (not the customer's device serial: that one is sealed in cardOf).
const CART_KEYS = ['lineId', 'parentLineId', 'name', 'sku', 'quantity', 'price', 'netPrice', 'totalPrice', 'originalPrice', 'discount', 'program', 'itemTypeId', 'itemCategoryId',
  'productLineType', 'isRework', 'isRMA', 'reasonCode', 'serial', 'serialStatus', 'partStatus', 'warehouseId', 'itemId', 'productId'];

/*
  The WO's parts events (GET workorder/{wo}/events → { events: [...] }: PARTS_UPDATED add / remove / swap,
  SB_PART_UPDATED), when the detail has them (d.events: that answer or its list). Everything else on the list (status
  updates, pickup contacts) stays out, and so does everything that isn't about the part: `metadata` (staff IP
  addresses, session ids) is never kept; eventData keeps only the part fields (type, items' id / quantity / name /
  item number, the swap's serials); the user only their id and name. Oldest first, at most 200.
*/
const eventList = (e) => (Array.isArray(e) ? e : e && Array.isArray(e.events) ? e.events : null);
const PART_EVENTS = ['PARTS_UPDATED', 'SB_PART_UPDATED'];
const partItem = (it) => (it && typeof it === 'object' ? { itemId: it.itemId ?? null, quantity: it.quantity ?? null, item: it.item ? pick(it.item, ['name', 'itemNumber']) : null } : null);
export function partEvents(events) {
  return events.filter((e) => e && PART_EVENTS.includes(e.eventType)).map((e) => {
    const d = e.eventData && typeof e.eventData === 'object' ? e.eventData : {};
    const data = pick(d, ['type', 'oldSerialNumber', 'newSerialNumber', 'serialNumber', 'status', 'partStatus', 'itemId']);
    if (d.item) data.item = pick(d.item, ['name', 'itemNumber']);
    if (Array.isArray(d.items)) data.items = d.items.map(partItem).filter(Boolean);
    const u = e.user || {};
    return { eventId: e.eventId, timestamp: e.timestamp, eventType: e.eventType, eventData: data, userId: e.userId ?? u.userId ?? null, user: [u.givenName, u.familyName].filter(Boolean).join(' ') || null };
  }).sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))).slice(-200);
}

// What search needs, sealed: who the customer is and which device.
export function cardOf(d, listRow) {
  const w = (d.workorder && d.workorder.workorder) || {}, cd = d.customer_data || {}, c = (listRow && listRow.customer) || {}, dev = w.CustomerDevice || (listRow && listRow.customerDevice) || {};
  const strings = (arr) => JSON.stringify(arr || []).match(/"[^"]*"/g) || [];
  const phones = new Set(), emails = new Set();
  for (const s of strings(cd.CustomerDataPhones).concat(c.primaryPhoneNumber ? ['"' + c.primaryPhoneNumber + '"'] : [])) { const x = s.slice(1, -1).replace(/\D/g, ''); if (x.length >= 10 && x.length <= 11) phones.add(x.slice(-10)); }
  for (const s of strings(cd.CustomerDataEmails).concat(c.email ? ['"' + c.email + '"'] : [])) { const x = s.slice(1, -1).trim().toLowerCase(); if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)) emails.add(x); }
  const datum = cd.CustomerDatum || {};
  return {
    name: datum.fullName || [datum.givenName, datum.familyName].filter(Boolean).join(' ') || c.fullName || [c.givenName, c.familyName].filter(Boolean).join(' ') || null,
    customerId: cd.customerId || c.customerId || null, phones: [...phones], emails: [...emails],
    imei: dev.imei || null, serial: dev.serial || null, claim: w.claimNumber || (listRow && listRow.claimNumber) || null,
  };
}
