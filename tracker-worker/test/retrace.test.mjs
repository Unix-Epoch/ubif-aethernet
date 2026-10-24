// Retrace (Oct 23, 2026): the inventory movement ledger. Normalization of every source (src/retrace.js) against the
// scrubbed Portal fixtures (test/fixtures/retrace/, shapes captured at 914 on Oct 23) and hand-written rows for the
// sources not captured yet; then the routes (src/retrace-api.js) and the WO hook on local D1 (wrangler getPlatformProxy),
// the way the collector, the tracker and the admin site use them.
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { getPlatformProxy } from 'wrangler';
import worker, { trackerAdmin } from '../src/index.js';
import * as R from '../src/retrace.js';
import * as S from '../src/shape.js';

const fx = (name) => JSON.parse(readFileSync(new URL('./fixtures/retrace/' + name + '.json', import.meta.url), 'utf8'));
const kinds = (ms) => ms.map((m) => m.kind);
const AT = '2026-10-23T12:00:00.000Z';

// ------------------------------------------------------------------ labels
assert.deepEqual(R.parseLabel('176255-0000514371'), { label: '176255-0000514371', item: '176255', buyback: false });
assert.deepEqual(R.parseLabel(' b-210004-0000000044 '), { label: 'B-210004-0000000044', item: '210004', buyback: true });
assert.equal(R.parseLabel('hello'), null);
assert.equal(R.cleanLabel('<script>'), null, 'unsafe text is not a label');
assert.equal(R.cleanLabel('ABC.123'), 'ABC.123', 'odd but safe labels are kept as Portal wrote them');

// ------------------------------------------------------------------ serial history (captured shapes)
const H = fx('serial-history');
{
  const sold = R.normalize.historyRows('176255-0000514371', H.sold); // the { value } envelope as Portal sends it
  assert.deepEqual(kinds(sold), ['shipped_to_store', 'received', 'reserved', 'sold']);
  assert.deepEqual(sold.map((m) => m.ref_type), ['po', 'po', 'sales_order', 'sales_order']);
  assert.equal(sold[3].ref_id, 'FSO000011111'); assert.equal(sold[3].ref_line, '2'); assert.equal(sold[3].user, 'System');
  assert.match(sold[3].detail, /^Sold on work order/); assert.equal(sold[0].item, '176255'); assert.equal(sold[0].at, '2026-09-10T14:02:11.000Z');
  assert.ok(sold.every((m) => m.source === 'history' && /^history:/.test(m.key)));
  // order doesn't matter, keys are stable
  assert.deepEqual(R.normalize.historyRows('176255-0000514371', H.sold.value.slice().reverse()).map((m) => m.key), sold.map((m) => m.key));
  assert.deepEqual(kinds(R.normalize.historyRows('180001-0000600001', H.consigned.value)), ['received', 'reserved', 'unreserved', 'consignment_changed', 'count_found']);
  const cnt = R.normalize.historyRows('180001-0000600001', H.consigned.value)[4];
  assert.equal(cnt.ref_type, 'journal'); assert.equal(cnt.ref_id, 'UBF-100001');
  const def = R.normalize.historyRows('190002-0000700002', H.defective.value);
  assert.deepEqual(kinds(def), ['received', 'defective', 'adjusted_in', 'consignment_changed']);
  assert.equal(def[1].ref_type, 'reason'); assert.equal(def[1].ref_id, 'Defective part(s)');
  const lost = R.normalize.historyRows('200003-0000800003', H.lost.value);
  assert.deepEqual(kinds(lost), ['received', 'lost', 'status_changed'], 'an event not in the capture is kept, as status_changed');
  assert.equal(lost[2].raw_event, 'SomethingNew'); assert.equal(lost[2].raw_status, 'Lost'); assert.equal(lost[2].ref_type, 'mystery_table');
  assert.match(lost[2].detail, /RefTable Mystery table/);
}
// kindOf without an event: snapshot statuses
assert.equal(R.kindOf({ status: 'Reserved', prevStatus: 'Available' }), 'reserved');
assert.equal(R.kindOf({ status: 'Available', prevStatus: 'Reserved' }), 'unreserved');
assert.equal(R.kindOf({ status: 'Sold', prevStatus: 'Reserved' }), 'sold');
assert.equal(R.kindOf({ status: 'In Transit', refType: 'transfer' }), 'transfer_out');
assert.equal(R.kindOf({ status: 'Available', prevStatus: 'Received' }), 'status_changed');

// ------------------------------------------------------------------ label snapshots and diffs
{
  const d = R.labelSnapshot(fx('label-details'));
  assert.equal(d.label, '176255-0000514371'); assert.equal(d.status, 'Sold'); assert.equal(d.consignment, 'No'); assert.equal(d.location, 'Main');
  assert.equal(d.warehouse, '914'); assert.equal(d.wo, '500400001'); assert.equal(d.sales_order, 'FSO000011111'); assert.equal(d.cost, 88.5); assert.equal(d.po, 'UBFPO000099001');
  const sp = fx('store-products').value.map(R.labelSnapshot);
  assert.equal(sp.length, 3); assert.equal(sp[2].location, 'Quarantine', '914Q reads as quarantine'); assert.equal(sp[0].location, undefined, 'no location type: never a change');
  assert.equal(sp[1].modified, '2026-10-20T10:00:00.000Z'); assert.equal(sp[1].consignment, 'Yes');
  assert.deepEqual(R.labelSnapshot(d), d, 'its own output reads the same');
  const before = { label: 'X1-000001', status: 'Available', location: 'Main', consignment: 'Yes' };
  assert.deepEqual(kinds(R.normalize.labelDiff(before, { label: 'X1-000001', status: 'Reserved' }, AT)), ['reserved']);
  assert.deepEqual(kinds(R.normalize.labelDiff(before, { label: 'X1-000001', status: 'Defective', location: 'Quarantine' }, AT)), ['defective']);
  assert.deepEqual(kinds(R.normalize.labelDiff(before, { label: 'X1-000001', location: 'Quarantine' }, AT)), ['quarantined']);
  assert.deepEqual(kinds(R.normalize.labelDiff(Object.assign({}, before, { location: 'Van' }), { label: 'X1-000001', location: 'Main' }, AT)), ['van_in']);
  const cons = R.normalize.labelDiff(before, { label: 'X1-000001', consignment: 'No' }, AT);
  assert.deepEqual(kinds(cons), ['consignment_changed']); assert.equal(cons[0].raw_event, 'consignment Yes → No');
  assert.deepEqual(R.normalize.labelDiff(null, { label: 'X1-000001', status: 'Sold' }, AT), [], 'first sight: nothing (history follows)');
  assert.deepEqual(R.normalize.labelDiff(before, { label: 'X1-000001', status: 'available' }, AT), [], 'case alone is no change');
}

// ------------------------------------------------------------------ WO cart lines and parts events
{
  const ev = S.partEvents(fx('wo-events').events);
  assert.deepEqual(ev.map((e) => e.eventType), ['PARTS_UPDATED', 'PARTS_UPDATED'], 'status updates left out');
  assert.ok(!JSON.stringify(ev).includes('192.0.2') && !JSON.stringify(ev).includes('sessionId'), 'staff IPs / sessions never kept');
  assert.equal(ev[0].user, 'Tech Alpha'); assert.equal(ev[0].userId, 70001); assert.deepEqual(ev[0].eventData.items[0], { itemId: 9180001, quantity: 1, item: { name: 'Galaxy S24 Battery', itemNumber: '180001' } });
  // plainPart: the new cart fields and partEvents ride along (and the events answer may come as { events })
  const p = S.plainPart({ workorder: { workorder: { workorderId: 1, storeId: 914 } }, cart: { cartItems: [{ lineId: 1, name: 'Battery', sku: '180001', serial: '180001-0000600002', serialStatus: 'Reserved', partStatus: 'Reserved', warehouseId: '914', itemId: 9180001, productId: 55, customerNote: 'x' }] }, events: fx('wo-events') });
  assert.deepEqual(Object.keys(p.cart.items[0]).sort(), ['itemId', 'lineId', 'name', 'partStatus', 'productId', 'serial', 'serialStatus', 'sku', 'warehouseId']);
  assert.equal(p.partEvents.length, 2);
  assert.equal(S.plainPart({ workorder: { workorder: { workorderId: 1 } } }).partEvents, undefined, 'no events fetched: no partEvents key (hashes unchanged)');
  const line = (lineId, serial, partStatus = 'Reserved') => ({ lineId, name: 'Battery', sku: '180001', serial, partStatus, serialStatus: partStatus, warehouseId: '914', itemId: 9180001 });
  const add = R.normalize.cartDiff([], [line(1, '180001-0000600002')], { wo: 7, at: AT, events: ev.slice(0, 1) }); // (the swap event would explain this label instead)
  assert.deepEqual(kinds(add), ['reserved']); assert.equal(add[0].user, 'Tech Alpha'); assert.equal(add[0].at, '2026-10-20T15:00:00.000Z', 'when: the add event'); assert.equal(add[0].ref_type, 'wo'); assert.equal(add[0].ref_id, '7');
  assert.deepEqual(kinds(R.normalize.cartDiff([line(1, '180001-0000600009')], [], { wo: 7, at: AT })), ['unreserved']);
  assert.deepEqual(kinds(R.normalize.cartDiff([line(1, '180001-0000600009')], [], { wo: 7, at: AT, sold: true })), ['used']);
  assert.deepEqual(kinds(R.normalize.cartDiff([line(1, '180001-0000600009')], [line(1, '180001-0000600009', 'Sold')], { wo: 7, at: AT })), ['used']);
  // the swap in the events explains the line change: no reserved / unreserved for those labels
  const swap = R.woMovements({ cart: { items: [line(1, '180001-0000600002')] } }, { workorder: { statusId: 10 }, cart: { items: [line(1, '180001-0000600004')] }, partEvents: ev }, { wo: 7, at: AT });
  assert.deepEqual(kinds(swap).sort(), ['status_changed', 'swapped_in', 'swapped_out'], 'swap pair + the add event as an item-level row');
  const si = swap.find((m) => m.kind === 'swapped_in');
  assert.equal(si.label, '180001-0000600004'); assert.equal(si.user, 'Tech Bravo'); assert.equal(si.detail, 'replaces 180001-0000600002');
  assert.equal(swap.find((m) => m.kind === 'status_changed').label, null);
  // an old-shape stored cart (no serials yet) can't say what was there: labels are "first seen", never "used"
  const first = R.woMovements({ cart: { items: [{ name: 'Battery', sku: '180001' }] } }, { workorder: { statusId: 14 }, cart: { items: [line(1, '180001-0000600002')] } }, { wo: 7, at: AT });
  assert.deepEqual(kinds(first), ['reserved']); assert.match(first[0].detail, /first seen/);
}

// ------------------------------------------------------------------ the other sources
{
  const tr = { transferOrderId: 'TO-1', createdDate: '2026-10-01T10:00:00Z', shippedDate: '2026-10-02T10:00:00Z', receivedDate: '2026-10-04T10:00:00Z', storeTransferStatus: 'Received',
    fromInventLocationId: '914', fromInventLocationName: 'Newport News', toInventLocationId: '326', toInventLocationName: 'Lynnhaven', lines: [{ lineNum: 1, itemName: 'Battery', itemNumber: '180001', serialNumber: '180001-0000600005' }] };
  const out = R.normalize.transfer(tr, { store: 914 }), inn = R.normalize.transfer(tr, { store: 326 });
  assert.deepEqual(kinds(out), ['transfer_out']); assert.equal(out[0].at, '2026-10-02T10:00:00.000Z'); assert.equal(out[0].to_wh, 'Lynnhaven');
  assert.deepEqual(kinds(inn), ['transfer_in']); assert.equal(inn[0].at, '2026-10-04T10:00:00.000Z');
  assert.deepEqual(kinds(R.normalize.transfer(tr, { store: 1 })), ['status_changed'], 'direction unknown: kept');
  assert.deepEqual(kinds(R.normalize.transfer(Object.assign({}, tr, { shippedDate: null, receivedDate: null }), { store: 914 })), [], 'not shipped yet: no move');
  const c = R.normalize.count({ CountingJournalId: 'UBF-100009', CountType: 'Routine', StartDate: '2026-10-05T10:00:00Z', EndDate: '2026-10-05T11:00:00Z', InitiatedBy: 'Tech Alpha' },
    [{ serialNumber: '180001-0000600001', status: 'Found' }, { SerialNumber: '180001-0000600006', Status: 'Missing' }, { serialNumber: '180001-0000600007', status: 'Weird' }]);
  assert.deepEqual(kinds(c), ['count_found', 'count_missing', 'status_changed']); assert.equal(c[0].ref_type, 'count');
  const rma = R.normalize.rma(fx('rma-order'), { at: AT });
  assert.deepEqual(kinds(rma), ['rma']); assert.equal(rma[0].ref_id, 'UBFPO000099005'); assert.equal(rma[0].raw_status, 'Accepted'); assert.match(rma[0].detail, /Wrong item/); assert.equal(rma[0].at, AT);
  const bb = R.normalize.buyback({ OrderId: 'BB-1', CreatedDate: '2026-10-06T10:00:00Z', lines: [{ SerialNumber: 'B-210004-0000000044', ItemDescription: 'iPhone 12', LineStatus: 'Shipped', Destination: 'UROC' },
    { SerialNumber: 'B-210004-0000000045', LineStatus: 'Shipped', Destination: 'Salvage' }] });
  assert.deepEqual(kinds(bb), ['buyback', 'salvage']); assert.equal(bb[0].item, '210004');
  const po = R.normalize.poReceive({ Lines: [{ ItemId: '180001', ItemName: 'Battery', QtyReceived: 2, Serials: [{ SerialNumber: '180001-0000600010', Status: 'Received' }, { SerialNumber: '180001-0000600011', Status: 'Received' }] }] }, { po: 'UBFPO000099006', at: AT });
  assert.deepEqual(kinds(po), ['received', 'received']); assert.equal(po[0].ref_id, 'UBFPO000099006');
  const os = R.normalize.outstanding(fx('outstanding-parts'));
  assert.deepEqual(os.map((x) => x.list), ['rma', 'buyback']); assert.equal(os[0].location, 'Quarantine'); assert.equal(os[1].label, 'B-210004-0000000044'); assert.equal(os[0].product, 'Galaxy S24 Battery');
  const doc = R.normalize.doc('po', fx('po-list').value[0]);
  assert.equal(doc.id, 'UBFPO000099006'); assert.equal(doc.status, 'Backorder'); assert.equal(doc.at, '2026-10-22T00:00:00.000Z'); assert.equal(R.normalize.doc('po', doc).id, doc.id, 'a shaped doc reads the same');
  assert.equal(R.normalize.doc('bogus', { id: 1 }), null);
  // watcher: checked field by field, key rebuilt, source fixed
  const w = R.normalize.watch({ label: '180001-0000600001', at: AT, kind: 'adjusted_out', source: 'history', key: 'history:abc', user: 'Tech Alpha' });
  assert.equal(w.source, 'watch'); assert.ok(w.key.startsWith('watch:'), 'a client cannot write into another source\'s keys');
  for (const bad of [{ label: '<x>', at: AT, kind: 'lost' }, { label: '180001-0000600001', at: 'yesterday', kind: 'lost' }, { label: '180001-0000600001', at: AT, kind: 'teleported' },
    { at: AT, kind: 'lost' }, { label: '180001-0000600001', at: '1999-01-01T00:00:00Z', kind: 'lost' }, null, []]) assert.equal(R.normalize.watch(bad), null, 'refused: ' + JSON.stringify(bad));
}

// ================================================================== routes (local D1)
rmSync('.wrangler-test-retrace', { recursive: true, force: true });
const { env, dispose } = await getPlatformProxy({ configPath: 'wrangler.toml', persist: { path: '.wrangler-test-retrace' } });
for (const stmt of readFileSync('schema.sql', 'utf8').replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean)) await env.TR.prepare(stmt).run();
// the migration applies on its own too (and again: IF NOT EXISTS everywhere)
for (let i = 0; i < 2; i++) for (const stmt of readFileSync('migrations/2026-10-23-retrace.sql', 'utf8').replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean)) await env.TR.prepare(stmt).run();
for (let i = 0; i < 2; i++) for (const stmt of readFileSync('migrations/2026-10-24-retrace-baseline.sql', 'utf8').replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean)) await env.TR.prepare(stmt).run();
await env.AE.prepare('CREATE TABLE IF NOT EXISTS store_access (store INTEGER PRIMARY KEY, name TEXT, added_by TEXT, added_at TEXT)').run();
await env.AE.prepare("INSERT OR IGNORE INTO store_access (store, name) VALUES (914, 'Newport News'), (326, 'Lynnhaven')").run();
const E = Object.assign({}, env, { APP_KEY: 'k', TRACKER_OWNERS: 'owner@x.com', LIMITER: null });
const T = env.TR;
const call = async (method, path, body) => {
  const r = await worker.fetch(new Request('https://t.test' + path, { method, headers: { 'x-aethernet-key': 'k', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), E, {});
  return { status: r.status, j: await r.json() };
};
const admin = async (email, path) => {
  const r = await trackerAdmin(new Request('https://a.test/api/tracker' + path), E, new URL('https://a.test/api/tracker' + path), path.split('?')[0], email);
  return { status: r.status, j: await r.json() };
};
const ok = (r, what) => assert.ok(r.status < 300, what + ': ' + r.status + ' ' + JSON.stringify(r.j));
const count = async (sql, ...args) => (await T.prepare(sql).bind(...args).first()).n;
const unclaim = () => T.prepare('UPDATE inv_labels SET claimed_until = NULL').run();

// ------------------------------------------------------------------ the in-page watcher's helpers (browser side; payloads GUESSED)
{
  assert.equal(R.watchPath('https://portal.ubreakifix.net/api/boh/inventory/176255-0000514371/adjust-in?x=1'), 'boh/inventory/176255-0000514371/adjust-in');
  assert.equal(R.watchRule('GET', '/api/boh/inventory/176255-0000514371/adjust-in'), null, 'reads are never watched');
  assert.equal(R.watchRule('POST', '/api/boh/inventory/176255-0000514371'), null, 'the label itself only on PATCH');
  assert.equal(R.watchRule('PATCH', '/api/boh/inventory/176255-0000514371').kind, 'status_changed');
  assert.equal(R.watchRule('POST', '/api/boh/purchase-orders'), null, 'POST reads (PO lists) are not writes');
  assert.equal(R.watchRule('POST', '/api/boh/store-transfer-orders/TO-1/ship').kind, 'transfer_out');
  assert.equal(R.watchRule('POST', '/api/boh/store-transfer-orders/receive').kind, 'transfer_in');
  assert.equal(R.watchRule('POST', '/api/boh/rma-buyback/rma-orders').kind, 'order');
  assert.deepEqual(R.labelsIn({ a: [{ SerialNumber: '180001-0000600001' }, '180001-0000600001'], b: { old: 'B-210004-0000000044' }, c: 'not a label' }),
    [{ label: '180001-0000600001', key: 'SerialNumber' }, { label: 'B-210004-0000000044', key: 'old' }]);
  const W = (method, url, body, response, ctx) => R.watchMovements({ method, url, body: body == null ? '' : JSON.stringify(body), response: response == null ? '' : JSON.stringify(response), at: AT }, ctx || { user: 'Tech Alpha', store: 914 });
  let w = W('POST', '/api/boh/inventory/176255-0000514371/adjust-out', { qty: 1, reason: 'x' });
  assert.deepEqual(w.map((m) => [m.label, m.kind, m.user, m.source]), [['176255-0000514371', 'adjusted_out', 'Tech Alpha', 'watch']]);
  assert.ok(w.every((m) => R.normalize.watch(m)), 'what the watcher builds passes the server check');
  assert.notEqual(W('POST', '/api/boh/inventory/176255-0000514371/adjust-out', {}, null)[0].key, R.watchMovements({ method: 'POST', url: '/api/boh/inventory/176255-0000514371/adjust-out', at: '2026-10-23T12:05:00Z' }, {})[0].key, 'two calls, two movements');
  assert.equal(W('POST', '/api/boh/inventory/176255-0000514371/mark-defective-broken', {})[0].kind, 'defective');
  w = W('POST', '/api/repair/swap-serial-on-item', { workorderId: 500400002, oldSerialNumber: '180001-0000600002', newSerialNumber: '180001-0000600004' });
  assert.deepEqual(w.map((m) => m.label + ' ' + m.kind), ['180001-0000600002 swapped_out', '180001-0000600004 swapped_in']);
  assert.equal(w[0].ref_type, 'wo'); assert.equal(w[0].ref_id, '500400002');
  assert.deepEqual(kinds(W('POST', '/api/repair/swap-serial-on-item', { a: '180001-0000600002', b: '180001-0000600004' })), ['status_changed', 'status_changed'], 'unknown swap shape: kept, raw path in detail');
  assert.match(W('POST', '/api/repair/swap-serial-on-item', { a: '180001-0000600002' })[0].detail, /swap-serial-on-item/);
  assert.equal(W('POST', '/api/boh/remote-tech/transfer-inventory', { serialNumber: '180001-0000600001', toWarehouseId: 'VAN-3', fromWarehouseId: '914' })[0].kind, 'van_out');
  assert.equal(W('POST', '/api/boh/remote-tech/transfer-inventory', { serialNumber: '180001-0000600001', toWarehouseId: '914', fromWarehouseId: 'VAN-3' })[0].kind, 'van_in');
  w = W('POST', '/api/boh/counts/UBF-100001/itemSerial', { serialNumber: '180001-0000600001' });
  assert.deepEqual([w[0].kind, w[0].ref_type, w[0].ref_id], ['count_found', 'count', 'UBF-100001']);
  // a cart add answers with the whole cart: labels only found there are keyed per cart, so the next add repeats nothing
  const cart = { cartItems: [{ lineId: 'L1', serial: '180001-0000600001' }, { lineId: 'L2', serial: '176255-0000514371' }] };
  const a1 = W('POST', '/api/order/cart/item/add', { cartId: '914-5631238484180', cartLines: [{ ItemId: '180001' }] }, cart);
  const a2 = R.watchMovements({ method: 'POST', url: '/api/order/cart/item/add', body: JSON.stringify({ cartId: '914-5631238484180' }), response: JSON.stringify(cart), at: '2026-10-23T13:00:00Z' }, {});
  assert.deepEqual(R.labelsIn({ cartId: '914-5631238484180', lineId: '1234-56789' }), [], 'cart / line ids are not labels');
  assert.deepEqual(a1.map((m) => m.label), ['180001-0000600001', '176255-0000514371'], 'the answer\'s labels, not the cart id');
  assert.deepEqual(kinds(a1), ['reserved', 'reserved']); assert.equal(a1[0].ref_type, 'cart'); assert.equal(a1[0].ref_id, '914-5631238484180');
  assert.deepEqual(a1.map((m) => m.key), a2.map((m) => m.key), 'same cart, same labels: same keys');
  assert.equal(W('POST', '/api/order/cart/item/add', { workorderId: 500400001, cartId: '914-1' }, cart)[0].ref_type, 'wo', 'a WO named in the body wins');
  assert.deepEqual(W('POST', '/api/order/cart/item/remove', { cartId: '914-1', cartLines: ['L1'] }, cart), [], 'no label, no item: nothing (the recorder still keeps it)');
  w = W('POST', '/api/order/cart/item/remove', { cartId: '914-1', itemId: '180001' }, null);
  assert.deepEqual([w[0].label, w[0].item, w[0].kind], [null, '180001', 'status_changed']); assert.ok(R.normalize.watch(w[0]), 'item-level rows pass too');
  assert.equal(W('POST', '/api/boh/rma-buyback/buyback-order/ship', { lines: [{ SerialNumber: 'B-210004-0000000044' }] })[0].kind, 'buyback');
  assert.deepEqual(W('GET', '/api/boh/inventory/176255-0000514371/adjust-in', {}), []);
  assert.deepEqual(R.rowsOf({ value: [1] }), [1]); assert.deepEqual(R.rowsOf([2]), [2]); assert.deepEqual(R.rowsOf({ x: 1 }), []);
}

// ------------------------------------------------------------------ purchase orders (status over time)
const POH = fx('po-header'), POR = fx('po-receive'), POL = fx('po-list').value[0];
{
  const a = R.poState(POH, POR);
  assert.equal(a.id, 'UBFPO000099007'); assert.equal(a.status, 'Backorder'); assert.equal(a.approval, 'Confirmed'); assert.equal(a.remaining, 3); assert.equal(a.autoReceivePaused, false);
  assert.equal(a.info.pool, 'AUTO-ORDER'); assert.ok(!('address' in a.info) && !JSON.stringify(a).includes('Net 30'), 'no address or payment method');
  assert.deepEqual(a.lines.map((l) => [l.line, l.item, l.ordered, l.shipped, l.received, l.cancelled, l.consignment]), [['1', '180001', 2, 2, 0, 0, 'Yes'], ['2', '176255', 1, 1, 0, 0, 'No']]);
  assert.deepEqual(a.labels.map((l) => l.label + ' ' + l.status), ['180001-0000600011 In Transit', '180001-0000600012 In Transit', '176255-0000514399 In Transit']);
  assert.equal(a.labels[2].oem, 'OEM0099');
  const row = R.poState(POL);
  assert.equal(row.lines, undefined); assert.equal(row.labels, undefined, 'a list row has no lines');
  assert.deepEqual(R.poEvents(null, row), [{ field: 'status', old: null, new: 'Backorder' }], 'first sight: one status row');
  // a list row on top of a full PO keeps its lines; same values = same signature, nothing changed
  const kept = R.mergePo(a, R.poState(Object.assign({}, POH, { PurchaseOrderLinesV2: undefined })));
  assert.equal(kept.lines.length, 2); assert.equal(R.poSig(kept), R.poSig(a)); assert.deepEqual(R.poEvents(a, kept), []);
  // one label scanned in: header quantities, the line, the label's status; one received movement
  const r2 = JSON.parse(JSON.stringify(POR)); r2.Lines[0].QtyReceived = 1; r2.Lines[0].Serials[0].Status = 'Received';
  const b = R.mergePo(a, R.poState(Object.assign({}, POH, { UbifTotalRemainingQty: 2, UbifTotalRegisteredQty: 1 }), r2));
  assert.notEqual(R.poSig(b), R.poSig(a));
  assert.deepEqual(R.poEvents(a, b).map((e) => e.field + ' ' + e.old + '→' + e.new), ['remaining 3→2', 'registered 0→1', 'line 1 received 0→1', 'label 180001-0000600011 In Transit→Received']);
  const mv = R.poMovements(a, b, AT);
  assert.deepEqual(mv.map((m) => [m.label, m.kind, m.ref_type, m.ref_id, m.ref_line, m.source]), [['180001-0000600011', 'received', 'po', 'UBFPO000099007', '1', 'po']]);
  assert.equal(mv[0].key, R.normalize.poReceive({ PurchaseOrderNumber: 'UBFPO000099007', Lines: [{ Serials: [{ SerialNumber: '180001-0000600011' }] }] }, { at: AT })[0].key, 'same key as poReceive');
  assert.deepEqual(R.poMovements(null, b, AT), [], 'first reading: history has the past');
  const c = R.mergePo(b, R.poState(Object.assign({}, POL, { PurchaseOrderNumber: 'UBFPO000099007', PurchaseOrderStatus: 'Received' })));
  assert.ok(R.poEvents(b, c).some((e) => e.field === 'status' && e.old === 'Backorder' && e.new === 'Received'));
}

// ------------------------------------------------------------------ WO hook (POST /wo/:wo)
await T.prepare("INSERT INTO store_keys (store, public_jwk, wrapped_private, created_at) VALUES (914, '{}', 'x', 'now'), (326, '{}', 'x', 'now')").run();
const SEALED = 'v1.' + 'A'.repeat(200);
const EV = S.partEvents(fx('wo-events').events);
let n = 0;
const sendWo = (wo, statusId, items, partEvents, store = 914) => call('POST', '/v1/' + store + '/tracker/wo/' + wo, { hash: 'h' + (++n), plain: Object.assign({
  workorder: { workorderId: wo, storeId: store, statusId, status: 's' + statusId, updatedAt: '2026-10-20T10:00:00Z', csuSalesOrderId: 'FSO000033333' },
  auditTrail: [], cart: { items, payment: { total: 0 }, salesId: 'FSO000033333' } }, partEvents ? { partEvents } : {}), sealed: SEALED });
const wl = (lineId, serial, partStatus = 'Reserved') => ({ lineId, name: 'Battery', sku: '180001', price: 89, quantity: 1, serial, partStatus, serialStatus: partStatus, warehouseId: '914', itemId: 9180001 });
const woMoves = async (wo) => (await T.prepare("SELECT label, kind, user_name, at, source FROM inv_movements WHERE store = 914 AND ref_type = 'wo' AND ref_id = ? ORDER BY id").bind(String(wo)).all()).results;

ok(await sendWo(700001, 8, []), 'wo empty cart');
assert.equal((await woMoves(700001)).length, 0);
assert.equal((await T.prepare("SELECT wo FROM inv_so_wo WHERE store = 914 AND sales_order = 'FSO000033333'").first()).wo, '700001', 'sales order tied to the WO');
ok(await sendWo(700001, 10, [wl(1, '180001-0000600002')], EV.slice(0, 1)), 'label appears');
let wm = await woMoves(700001);
assert.deepEqual(wm.map((m) => m.kind), ['reserved', 'status_changed'], 'reserved + the add event (item level)');
assert.equal(wm[0].user_name, 'Tech Alpha'); assert.equal(wm[0].label, '180001-0000600002');
const lab = await T.prepare("SELECT wo, need_history FROM inv_labels WHERE store = 914 AND label = '180001-0000600002'").first();
assert.equal(lab.wo, '700001'); assert.equal(lab.need_history, 2, 'touched: history queued');
ok(await sendWo(700001, 11, [wl(1, '180001-0000600002')], EV.slice(0, 1)), 'same cart, other change');
assert.equal((await woMoves(700001)).length, 2, 'a re-sent cart and events add nothing');
ok(await sendWo(700001, 10, [], EV.slice(0, 1)), 'label removed before the sale');
assert.deepEqual((await woMoves(700001)).map((m) => m.kind).slice(2), ['unreserved']);
ok(await sendWo(700001, 10, [wl(2, '180001-0000600008')], EV.slice(0, 1)), 'another label');
ok(await sendWo(700001, 14, [], EV.slice(0, 1)), 'Sale complete: Portal empties the cart');
assert.deepEqual((await woMoves(700001)).map((m) => m.kind + ' ' + m.label).slice(3), ['reserved 180001-0000600008', 'used 180001-0000600008']);
// swap: the event explains the line change
ok(await sendWo(700002, 10, [wl(1, '180001-0000600002')]), 'swap: before');
ok(await sendWo(700002, 10, [wl(1, '180001-0000600004')], EV), 'swap: after');
wm = await woMoves(700002);
assert.deepEqual(wm.map((m) => m.kind + ' ' + (m.label || '-')), ['reserved 180001-0000600002', 'status_changed -', 'swapped_out 180001-0000600002', 'swapped_in 180001-0000600004']);
assert.equal(wm[3].user_name, 'Tech Bravo'); assert.equal(wm[3].source, 'wo_event');
// the upload itself is untouched by a Retrace failure (bad events are just ignored)
ok(await sendWo(700003, 10, [wl(1, '180001-0000600002')], [{ eventType: 'PARTS_UPDATED', eventData: null }]), 'odd events never fail the upload');

// ------------------------------------------------------------------ store isolation
assert.equal((await call('POST', '/v1/999/tracker/retrace/watch', { movements: [{ label: '180001-0000600001', at: AT, kind: 'lost' }] })).status, 403, 'store without access');
const lookup = fx('inventory-lookup').value, products = fx('store-products').value;
let sw = await call('POST', '/v1/326/tracker/retrace/sweep', { labels: products });
ok(sw, 'sweep 326'); assert.equal(sw.j.skipped, 3, '914 labels sent to 326: skipped');
assert.equal(await count('SELECT COUNT(*) AS n FROM inv_labels WHERE store = 326'), 0, 'store 326 got nothing');

// ------------------------------------------------------------------ sweep: items, labels, need queue, claims
sw = await call('POST', '/v1/914/tracker/retrace/sweep', { items: lookup, labels: products, by: 'Tech Alpha', need: 4 });
ok(sw, 'sweep 914');
assert.deepEqual(sw.j.changedItems.map((x) => x.item + ':' + x.why).sort(), ['176255:new', '180001:new']);
const item = await T.prepare("SELECT qty FROM inv_items WHERE store = 914 AND item = '180001'").first();
assert.deepEqual(JSON.parse(item.qty)['914Q'], { onHand: 1, available: 0, reserved: 0, inTransit: 0, salesOnOrder: 0, van: null }, 'quantities per warehouse');
assert.equal(sw.j.need.length, 4); assert.equal(sw.j.more, true);
assert.equal(sw.j.need[0], '180001-0000600002', 'touched (by the WO) before backfill');
assert.equal(await count("SELECT COUNT(*) AS n FROM inv_labels WHERE store = 914 AND label = '180001-0000600001' AND need_history = 1"), 1, 'new label: backfill');
const again = await call('POST', '/v1/914/tracker/retrace/sweep', { items: lookup, labels: products, need: 100 });
assert.deepEqual(again.j.changedItems, [], 'same quantities: nothing to read');
assert.equal(again.j.written, 0, 'unchanged and seen today: no writes');
assert.ok(!again.j.need.some((l) => sw.j.need.includes(l)), 'claimed labels go to nobody else');
await unclaim();
// changes: status Available → Reserved, consignment Yes → No, a quantity, and SerialModified moving on alone
const changed = products.map((p) => Object.assign({}, p));
changed[0].SerialStatus = 'Reserved'; changed[1].ConsignmentStatus = 'No'; changed[2].SerialModified = '2026-10-22T10:00:00Z';
const look2 = lookup.map((r, i) => (i === 0 ? Object.assign({}, r, { ReservedQuantity: 2, AvailableQuantity: 0 }) : r));
const rmaMoves = R.normalize.rma(fx('rma-order'), { at: AT });
sw = await call('POST', '/v1/914/tracker/retrace/sweep', { items: look2, labels: changed, movements: [...rmaMoves, { label: 'nope nope', at: AT, kind: 'rma', source: 'rma' }], touched: ['200003-0000800003'],
  docs: [Object.assign({ type: 'rma' }, fx('rma-order')), Object.assign({ type: 'po' }, fx('po-list').value[0])], cursors: { rma: { from: '20261001' }, po: { page: 3 } }, need: 10 });
ok(sw, 'sweep with changes');
assert.deepEqual(sw.j.changedItems, [{ item: '180001', why: 'changed' }]);
assert.equal(sw.j.rejected, 1);
assert.equal(sw.j.added, 3, 'two diffs + one RMA movement');
const diffs = (await T.prepare("SELECT label, kind, raw_event FROM inv_movements WHERE store = 914 AND source = 'snapshot' ORDER BY label").all()).results;
assert.deepEqual(diffs.map((d) => d.label + ' ' + d.kind), ['180001-0000600001 reserved', '180001-0000600002 consignment_changed']);
assert.deepEqual(sw.j.need.slice(0, 3).sort(), ['180001-0000600001', '180001-0000600002', '180001-0000600003'], 'changed first (SerialModified alone counts)');
assert.ok(sw.j.need.includes('200003-0000800003'), 'touched labels queued');
assert.equal((await T.prepare("SELECT status FROM inv_docs WHERE store = 914 AND type = 'rma' AND id = 'UBFPO000099005'").first()).status, 'Shipped');
const cur = (await call('GET', '/v1/914/tracker/retrace/cursor')).j.cursors;
assert.deepEqual(cur.rma.value, { from: '20261001' }); assert.deepEqual(cur.po.value, { page: 3 }); assert.ok(cur.last_sweep.at);
assert.equal((await call('POST', '/v1/914/tracker/retrace/sweep', { cursors: { last_sweep: 1 } })).status, 400, 'the server\'s own cursor');
assert.equal((await call('POST', '/v1/914/tracker/retrace/sweep', { labels: 'x' })).status, 400);
assert.equal((await call('POST', '/v1/914/tracker/retrace/sweep', { labels: Array(801).fill({}) })).status, 400, 'capped');

// ------------------------------------------------------------------ history ingest + dedupe
let hi = await call('POST', '/v1/914/tracker/retrace/history', { label: '180001-0000600001', rows: H.consigned });
ok(hi, 'history'); assert.equal(hi.j.added, 5); assert.equal(hi.j.same, false);
let lr = await T.prepare("SELECT need_history, claimed_until, last_history_at, history_hash FROM inv_labels WHERE store = 914 AND label = '180001-0000600001'").first();
assert.equal(lr.need_history, 0); assert.equal(lr.claimed_until, null); assert.ok(lr.last_history_at && lr.history_hash);
hi = await call('POST', '/v1/914/tracker/retrace/history', { label: '180001-0000600001', rows: H.consigned.value });
assert.equal(hi.j.same, true, 'same history: nothing to do'); assert.equal(hi.j.added, 0);
const etagOnly = H.consigned.value.map((r) => Object.assign({}, r, { '@odata.etag': 'W/"new"' }));
assert.equal((await call('POST', '/v1/914/tracker/retrace/history', { label: '180001-0000600001', rows: etagOnly })).j.same, true, 'etags alone are no news');
const extra = H.consigned.value.concat([Object.assign({}, H.consigned.value[1], { DateTime: '2026-10-22T10:00:00Z', SourceKey: 'FSO000044444' })]);
hi = await call('POST', '/v1/914/tracker/retrace/history', { label: '180001-0000600001', rows: extra });
assert.equal(hi.j.added, 1, 'only the new row');
assert.equal(await count("SELECT COUNT(*) AS n FROM inv_movements WHERE store = 914 AND label = '180001-0000600001' AND source = 'history'"), 6);
const other = H.sold.value.map((r, i) => (i === 0 ? Object.assign({}, r, { Store: '326' }) : r));
hi = await call('POST', '/v1/914/tracker/retrace/history', { label: '176255-0000514371', rows: other });
assert.equal(hi.j.added, 3); assert.equal(hi.j.skipped, 1, 'a row naming another store is skipped');
assert.equal((await call('POST', '/v1/914/tracker/retrace/history', { label: 'bad label!', rows: [] })).status, 400);

// ------------------------------------------------------------------ watcher
let wt = await call('POST', '/v1/914/tracker/retrace/watch', { movements: [{ label: '180001-0000600001', at: AT, kind: 'adjusted_out', user: 'Tech Alpha', raw_event: 'adjust-out', key: 'call-1' }, { label: 'x', at: AT, kind: 'lost' }] });
ok(wt, 'watch'); assert.equal(wt.j.added, 1); assert.equal(wt.j.rejected, 1);
assert.equal((await call('POST', '/v1/914/tracker/retrace/watch', { movements: [{ label: '180001-0000600001', at: AT, kind: 'adjusted_out', key: 'call-1' }] })).j.added, 0, 'same call twice: once');
assert.equal((await call('POST', '/v1/914/tracker/retrace/watch', { movements: Array(51).fill({ label: '180001-0000600001', at: AT, kind: 'lost' }) })).status, 400, 'batch capped');
assert.equal((await call('POST', '/v1/914/tracker/retrace/watch', { movements: [{ label: '180001-0000600001', at: AT, kind: 'teleported' }] })).status, 400, 'nothing valid');
assert.equal((await T.prepare("SELECT need_history FROM inv_labels WHERE store = 914 AND label = '180001-0000600001'").first()).need_history, 2, 'watched label queued again');

// ------------------------------------------------------------------ purchase orders: sweep (status history, receive movements, poNeed)
{
  let ps = await call('POST', '/v1/914/tracker/retrace/sweep', { pos: [POL, { header: Object.assign({}, POH, { PurchaseOrderLinesV2: undefined }) }], poNeed: 10, need: 0 });
  ok(ps, 'PO list rows');
  assert.equal(ps.j.pos.seen, 2); assert.deepEqual(ps.j.pos.need.slice().sort(), ['UBFPO000099006', 'UBFPO000099007'], 'new POs: read them in full');
  assert.equal((await call('POST', '/v1/914/tracker/retrace/sweep', { pos: [POL], need: 0 })).j.pos.written, 0, 'same list row: no write');
  ps = await call('POST', '/v1/914/tracker/retrace/sweep', { pos: [{ header: POH, receive: POR }], poNeed: 10, need: 0 });
  assert.deepEqual(ps.j.pos.need, ['UBFPO000099006'], 'read in full: off the list');
  const lab = await T.prepare("SELECT po, oem_serial, need_history FROM inv_labels WHERE store = 914 AND label = '176255-0000514399'").first();
  assert.deepEqual([lab.po, lab.oem_serial, lab.need_history], ['UBFPO000099007', 'OEM0099', 2], 'receive-details labels: PO linked, history queued');
  // history already gave 600012 its received row on this PO: the PO reading adds none for it
  await call('POST', '/v1/914/tracker/retrace/history', { label: '180001-0000600012', rows: [{ InventSerialId: '180001-0000600012', ItemId: '180001', Store: '914', DateTime: '2026-10-23T11:00:00Z',
    SerialEventType: 'ProductReceipt', SerialStatus: 'Received', RefTable: 'Purchase orders', SourceKey: 'UBFPO000099007', SourceKeyLineNum: 1, User: 'Tech Alpha', Message: '' }] });
  const r2 = JSON.parse(JSON.stringify(POR)); r2.Lines[0].QtyReceived = 2; r2.Lines[0].Serials.forEach((x) => { x.Status = 'Received'; });
  ps = await call('POST', '/v1/914/tracker/retrace/sweep', { pos: [{ header: Object.assign({}, POH, { UbifTotalRemainingQty: 1, UbifTotalRegisteredQty: 2 }), receive: r2 }], need: 0 });
  assert.equal(ps.j.pos.received, 1, 'one received movement (the other label had one from history)');
  assert.equal(await count("SELECT COUNT(*) AS n FROM inv_movements WHERE store = 914 AND ref_type = 'po' AND ref_id = 'UBFPO000099007' AND kind = 'received'"), 2);
  assert.equal(ps.j.pos.events, 5, 'remaining, registered, line 1 received, two labels');
  ps = await call('POST', '/v1/914/tracker/retrace/sweep', { pos: [{ header: Object.assign({}, POH, { UbifTotalRemainingQty: 1, UbifTotalRegisteredQty: 2 }), receive: r2 }], need: 0 });
  assert.equal(ps.j.pos.received, 0); assert.equal(ps.j.pos.events, 0, 'the same reading again: nothing new');
  // a list row whose status moved asks for the PO again
  ps = await call('POST', '/v1/914/tracker/retrace/sweep', { pos: [Object.assign({}, POH, { PurchaseOrderLinesV2: undefined, PurchaseOrderStatus: 'Received', UbifTotalRemainingQty: 0, UbifTotalRegisteredQty: 2 })], poNeed: 5, need: 0 });
  assert.ok(ps.j.pos.need.includes('UBFPO000099007')); assert.equal(ps.j.pos.events, 2);
  assert.equal((await call('POST', '/v1/326/tracker/retrace/sweep', { pos: [POL], poNeed: 5, need: 0 })).j.pos.need.length, 1, 'per store');
  assert.equal(await count("SELECT COUNT(*) AS n FROM inv_docs WHERE store = 326 AND type = 'po' AND id = 'UBFPO000099007'"), 0);
  assert.equal((await call('POST', '/v1/914/tracker/retrace/sweep', { pos: Array(601).fill(POL) })).status, 400, 'capped');
}

// ------------------------------------------------------------------ admin routes + access
const it = await admin('owner@x.com', '/retrace/item/914/180001');
ok(it, 'item');
assert.equal(it.j.info.name, 'Galaxy S24 Battery'); assert.ok(it.j.info.qty['914']);
assert.ok(it.j.counts.some((c) => c.serial_status === 'Reserved'));
assert.equal(it.j.total, it.j.movements.length); assert.ok(it.j.movements.length >= 10);
assert.ok(it.j.movements[0].at >= it.j.movements[it.j.movements.length - 1].at, 'newest first');
const viaSo = it.j.movements.find((m) => m.ref_id === 'FSO000033333');
assert.equal(viaSo, undefined); // (no history row for that FSO: tied below)
await T.prepare("INSERT INTO inv_so_wo (store, sales_order, wo, source, updated_at) VALUES (914, 'FSO000022222', '700009', 'label', ?)").bind(AT).run();
const tl = await admin('owner@x.com', '/retrace/label/914/180001-0000600001');
ok(tl, 'label');
assert.equal(tl.j.label.label, '180001-0000600001');
assert.ok(tl.j.movements[0].at <= tl.j.movements[tl.j.movements.length - 1].at, 'oldest first');
assert.equal(tl.j.movements.find((m) => m.kind === 'reserved' && m.source === 'history').wo, '700009', 'a sales order shows its WO');
assert.equal((await admin('owner@x.com', '/retrace/item/914/180001?kinds=reserved,unreserved')).j.movements.every((m) => ['reserved', 'unreserved'].includes(m.kind)), true);
assert.equal((await admin('owner@x.com', '/retrace/item/914/180001?from=2026-09-01&to=2026-09-30')).j.movements.every((m) => m.at.startsWith('2026-09')), true);
assert.equal((await admin('owner@x.com', '/retrace/item/914/180001?kinds=teleported')).status, 400);
assert.equal((await admin('owner@x.com', '/retrace/label/326/180001-0000600001')).status, 404, 'another store\'s ledger is its own');
const se = await admin('owner@x.com', '/retrace/search?q=700009');
assert.ok(se.j.refs.some((r) => r.ref_id === 'FSO000022222'), 'a WO number finds its sales order rows');
assert.ok((await admin('owner@x.com', '/retrace/search?store=914&q=180001-00006')).j.labels.length >= 3, 'label prefix');
assert.equal((await admin('owner@x.com', '/retrace/search?q=UBFPO000099005')).j.docs[0].type, 'rma');
assert.equal((await admin('owner@x.com', '/retrace/search?q=x')).status, 400);
const cov = (await admin('owner@x.com', '/retrace/coverage')).j.stores;
const c914 = cov.find((s) => s.store === 914);
assert.ok(c914.labels >= 5 && c914.histories === 3 &&  c914.backlog > 0 && c914.movements > 10 && c914.last_sweep_at && c914.items === 2, JSON.stringify(c914));
// item: chip counts, person picker, first movement, sold in 90 days; the item list
{
  const all = it.j;
  assert.ok(all.by_kind.length && all.by_kind.reduce((n, k) => n + k.n, 0) === all.total, 'by_kind adds up to the movements');
  assert.equal(all.all_total, all.total); assert.ok(all.first_at && all.first_at <= all.movements[all.movements.length - 1].at);
  assert.equal(typeof all.sold90, 'number');
  assert.ok(all.users.some((u) => u.user === 'Tech Alpha'), JSON.stringify(all.users));
  const one = (await admin('owner@x.com', '/retrace/item/914/180001?user=' + encodeURIComponent('Tech Alpha'))).j;
  assert.ok(one.movements.length && one.movements.every((m) => m.user === 'Tech Alpha'), 'user filter');
  assert.deepEqual(one.users, all.users, 'users ignore the user filter');
  assert.equal(one.by_kind.reduce((n, k) => n + k.n, 0), one.total, 'by_kind follows the user filter');
  const rk = (await admin('owner@x.com', '/retrace/item/914/180001?kinds=reserved')).j;
  assert.deepEqual(rk.by_kind, all.by_kind, 'by_kind ignores the kinds filter');
  assert.equal(rk.all_total, all.all_total);
  await T.prepare("INSERT INTO inv_movements (store, label, item, at, kind, source, key, recorded_at) VALUES (914, '180001-0000600001', '180001', ?, 'sold', 'watch', 'test-sold90', ?), (914, '180001-0000600001', '180001', '2025-01-01T00:00:00.000Z', 'sold', 'watch', 'test-sold-old', ?)").bind(new Date().toISOString(), AT, AT).run();
  const s90 = (await admin('owner@x.com', '/retrace/item/914/180001')).j.sold90;
  assert.equal(s90, all.sold90 + 1, 'sold90: only the last 90 days');
  const li = await admin('owner@x.com', '/retrace/items?store=914');
  ok(li, 'items');
  assert.ok(li.j.total >= 1 && li.j.items.length === li.j.total);
  const i1 = li.j.items.find((x) => x.item === '180001');
  assert.equal(i1.name, 'Galaxy S24 Battery'); assert.equal(i1.moves, all.all_total + 2); assert.equal(typeof i1.on_hand, 'number');
  assert.ok(li.j.items.every((x, k, a) => k === 0 || a[k - 1].last_at >= x.last_at), 'most recent movement first');
  assert.equal((await admin('owner@x.com', '/retrace/items?store=914&limit=1')).j.items.length, 1);
  assert.equal((await admin('owner@x.com', '/retrace/items')).status, 400, 'store required');
  assert.deepEqual((await admin('owner@x.com', '/retrace/items?store=555')).j.items, [], 'a store with nothing yet');
  // one row per serial: newest movement, move count, where it stands, group chips, range, paging, item-level movements
  const sr = await admin('owner@x.com', '/retrace/serials/914/180001');
  ok(sr, 'serials');
  const labelsOf = new Set((await T.prepare("SELECT DISTINCT label FROM inv_movements WHERE store = 914 AND item = '180001' AND label IS NOT NULL").all()).results.map((r) => r.label));
  assert.equal(sr.j.total, labelsOf.size, 'one row per label'); assert.equal(new Set(sr.j.serials.map((x) => x.label)).size, sr.j.serials.length);
  assert.equal(sr.j.groups.all, sr.j.total);
  assert.ok(sr.j.serials.every((x, k, a2) => k === 0 || a2[k - 1].last.at >= x.last.at), 'newest last movement first');
  const s1m = sr.j.serials.find((x) => x.label === '180001-0000600001');
  const mv1 = (await admin('owner@x.com', '/retrace/label/914/180001-0000600001')).j.movements;
  assert.equal(s1m.moves, mv1.length, 'moves = every movement of the label');
  assert.equal(s1m.last.at, mv1[mv1.length - 1].at); assert.equal(s1m.last.kind, mv1[mv1.length - 1].kind, 'last = the newest movement');
  assert.equal(s1m.last.kind, 'sold', 'the sold movement added above is the newest');
  assert.deepEqual([s1m.now, s1m.group], ['Sold', 'out']);
  assert.equal(sr.j.groups.in + sr.j.groups.wo + sr.j.groups.out + sr.j.groups.q + sr.j.groups.bad <= sr.j.groups.all, true);
  for (const g of ['in', 'wo', 'out', 'q', 'bad']) {
    const f = (await admin('owner@x.com', '/retrace/serials/914/180001?group=' + g)).j;
    assert.equal(f.total, sr.j.groups[g], 'group ' + g); assert.ok(f.serials.every((x) => x.group === g));
    assert.deepEqual(f.groups, sr.j.groups, 'group counts ignore the group filter');
  }
  assert.ok((await admin('owner@x.com', '/retrace/serials/914/180001?group=out')).j.serials.some((x) => x.label === '180001-0000600001'));
  assert.equal((await admin('owner@x.com', '/retrace/serials/914/180001?group=nope')).status, 400);
  assert.equal((await admin('owner@x.com', '/retrace/serials/914/180001?days=0')).status, 400);
  const pg1 = (await admin('owner@x.com', '/retrace/serials/914/180001?limit=1')).j, pg2 = (await admin('owner@x.com', '/retrace/serials/914/180001?limit=1&offset=1')).j;
  assert.equal(pg1.serials.length, 1); assert.equal(pg1.total, sr.j.total); assert.equal(pg2.serials[0].label, sr.j.serials[1].label, 'paging');
  // days: by the serial's last movement (a label last moved long ago drops out, the sold one stays)
  await T.prepare("INSERT INTO inv_movements (store, label, item, at, kind, source, key, recorded_at) VALUES (914, '180001-0000600099', '180001', '2025-01-01T00:00:00.000Z', 'received', 'watch', 'test-old-serial', ?), (914, NULL, '180001', ?, 'adjusted_in', 'watch', 'test-loose', ?)").bind(AT, new Date().toISOString(), AT).run();
  const wide = (await admin('owner@x.com', '/retrace/serials/914/180001')).j, recent = (await admin('owner@x.com', '/retrace/serials/914/180001?days=30')).j;
  assert.ok(wide.serials.some((x) => x.label === '180001-0000600099') && !recent.serials.some((x) => x.label === '180001-0000600099'), 'days filters on the last movement');
  assert.ok(recent.serials.some((x) => x.label === '180001-0000600001'));
  assert.equal(recent.total, recent.groups.all); assert.equal(recent.groups.all, wide.groups.all - 1);
  assert.ok(wide.loose.some((m) => m.kind === 'adjusted_in' && m.label === null), 'item-level movements apart'); assert.equal(wide.loose_total, wide.loose.length);
  assert.ok(wide.serials.every((x) => x.label), 'no label-less rows among the serials');
  assert.ok(recent.loose.some((m) => m.kind === 'adjusted_in') && recent.loose.every((m) => m.label === null), 'loose follows days');
  assert.deepEqual((await admin('owner@x.com', '/retrace/serials/555/180001')).j.serials, [], 'a store with nothing yet');
  // serialNow: Portal's status on the label, else the last movement
  const { serialNow } = await import('../src/retrace.js');
  assert.deepEqual(serialNow('Available', 'Main', 'received'), ['Available', 'in']);
  assert.deepEqual(serialNow('Reserved', null, 'reserved'), ['Reserved', 'wo']);
  assert.deepEqual(serialNow('Sold', null, 'used'), ['Used on repair', 'out'], 'sold + last used: the repair');
  assert.deepEqual(serialNow('Sold', null, 'sold'), ['Sold', 'out']);
  assert.deepEqual(serialNow(null, null, 'transfer_out'), ['Transferred out', 'out'], 'no status: the last movement');
  assert.deepEqual(serialNow('Defective', null, 'defective'), ['Defective', 'q']);
  assert.deepEqual(serialNow('In Transit', null, 'shipped_to_store'), ['In transit', 'in']);
  assert.deepEqual(serialNow('Available', 'Quarantine', 'quarantined'), ['Quarantined', 'q'], 'quarantine is defective');
  assert.deepEqual(serialNow('Lost', 'Quarantine', 'lost'), ['Lost', 'bad']);
  assert.deepEqual(serialNow('Reserved', null, 'sold', true), ['Sold', 'out'], 'a newer movement beats the label\'s snapshot');
  assert.deepEqual(serialNow('Reserved', null, 'sold', false), ['Reserved', 'wo']);
  assert.deepEqual(serialNow('Weird', null, 'status_changed'), ['Weird', null], 'unknown: only under All');
}
// PO page and list
{
  const pg = await admin('owner@x.com', '/retrace/po/914/UBFPO000099007');
  ok(pg, 'PO page');
  assert.equal(pg.j.header.status, 'Received'); assert.equal(pg.j.header.info.pool, 'AUTO-ORDER'); assert.ok(!('lines' in pg.j.header));
  assert.deepEqual(pg.j.lines.map((l) => [l.line, l.ordered, l.received, l.remaining]), [['1', 2, 2, 2], ['2', 1, 0, 1]], 'remaining as Portal sent it');
  const l11 = pg.j.labels.find((l) => l.label === '180001-0000600011');
  assert.equal(l11.receive_status, 'Received'); assert.ok(l11.now && 'serial_status' in l11.now);
  assert.deepEqual(pg.j.events.slice(0, 1).map((e) => e.field + ' ' + e.new), ['status Backorder'], 'oldest first');
  assert.ok(pg.j.events.some((e) => e.field === 'status' && e.new === 'Received'));
  assert.deepEqual(pg.j.movements.map((m) => m.kind), ['received', 'received']);
  assert.equal((await admin('owner@x.com', '/retrace/po/914/UBFPO000000000')).status, 404);
  const ls = await admin('owner@x.com', '/retrace/pos?store=914');
  ok(ls, 'PO list');
  assert.equal(ls.j.total, 2);
  const p7 = ls.j.pos.find((p) => p.po === 'UBFPO000099007');
  assert.deepEqual([p7.status, p7.lines, p7.labels, p7.received, p7.need_detail], ['Received', 2, 3, 2, 1]); assert.ok(p7.last_change);
  assert.deepEqual((await admin('owner@x.com', '/retrace/pos?store=914&status=Backorder')).j.pos.map((p) => p.po), ['UBFPO000099006']);
  assert.equal((await admin('owner@x.com', '/retrace/pos?store=914&from=2026-10-22&to=2026-10-22')).j.total, 1, 'by accounting date');
  assert.equal((await admin('owner@x.com', '/retrace/pos?from=nope')).status, 400);
}
// people: a manager (the role includes Retrace) for 914 only; a store viewer without the page
await T.prepare("INSERT INTO people (email, scope, stores, pages, details) VALUES ('mgr@x.com', 'stores', '[914]', ?, 1), ('viewer@x.com', 'stores', '[914]', '[\"wos\"]', 0)")
  .bind(JSON.stringify(['wos', 'sales', 'metrics', 'data', 'retrace'])).run();
assert.equal((await admin('mgr@x.com', '/retrace/item/914/180001')).status, 200);
assert.equal((await admin('mgr@x.com', '/retrace/item/326/180001')).status, 403, 'other store');
assert.equal((await admin('mgr@x.com', '/retrace/label/326/180001-0000600001')).status, 403);
assert.equal((await admin('mgr@x.com', '/retrace/search?store=326&q=180001')).status, 403);
assert.deepEqual((await admin('mgr@x.com', '/retrace/coverage')).j.stores.map((s) => s.store), [914], 'coverage cut to their stores');
assert.equal((await admin('mgr@x.com', '/retrace/po/914/UBFPO000099007')).status, 200);
assert.equal((await admin('mgr@x.com', '/retrace/po/326/UBFPO000099007')).status, 403, 'other store');
assert.deepEqual((await admin('mgr@x.com', '/retrace/pos')).j.pos.map((p) => p.store).filter((x) => x !== 914), [], 'PO list cut to their stores');
assert.equal((await admin('mgr@x.com', '/retrace/pos?store=326')).status, 403);
assert.equal((await admin('viewer@x.com', '/retrace/pos?store=914')).status, 403, 'no Retrace page');
assert.equal((await admin('viewer@x.com', '/retrace/item/914/180001')).status, 403, 'no Retrace page');
assert.equal((await admin('viewer@x.com', '/retrace/coverage')).status, 403);
assert.equal((await admin('mgr@x.com', '/retrace/items?store=914')).status, 200);
assert.equal((await admin('mgr@x.com', '/retrace/items?store=326')).status, 403, 'items: other store');
assert.equal((await admin('mgr@x.com', '/retrace/items')).status, 400);
assert.equal((await admin('viewer@x.com', '/retrace/items?store=914')).status, 403, 'no Retrace page');
assert.equal((await admin('mgr@x.com', '/retrace/serials/914/180001')).status, 200);
assert.equal((await admin('mgr@x.com', '/retrace/serials/326/180001')).status, 403, 'serials: other store');
assert.equal((await admin('viewer@x.com', '/retrace/serials/914/180001')).status, 403, 'no Retrace page');
assert.ok((await T.prepare("SELECT COUNT(*) AS n FROM access_log WHERE action = 'retrace:item' AND email = 'mgr@x.com'").first()).n >= 1, 'views logged');
const { presetOf } = await import('../src/access.js');
assert.equal(presetOf({ scope: 'stores', details: true, pages: ['wos', 'sales', 'metrics', 'data', 'retrace'] }), 'manager');
assert.equal(presetOf({ scope: 'stores', details: true, pages: ['wos', 'sales', 'metrics', 'data'] }), 'manager', 'a manager from before Retrace is still a manager');

// ------------------------------------------------------------------ item names (inv_items.name from every source)
{
  // woNames: cart lines (item as cartDiff works it out) and parts events' items
  const wn = R.woNames({ cart: { items: [{ name: 'Screen A', sku: '300001', serial: '300001-0000000001' }, { name: 'Labor', sku: 'LABOR9' }, { sku: '300011', serial: '300011-0000000001' },
    { name: 'From label', serial: '300012-0000000001' }] }, partEvents: [{ eventData: { type: 'add', items: [{ itemId: 1, item: { name: 'Event Part', itemNumber: '300013' } }] } }] });
  assert.deepEqual(wn, [{ item: '300001', name: 'Screen A', label: '300001-0000000001', event: false }, { item: 'LABOR9', name: 'Labor', label: null, event: false },
    { item: '300012', name: 'From label', label: '300012-0000000001', event: false }, { item: '300013', name: 'Event Part', label: null, event: true }]);
  const nameOf = async (item, store = 914) => { const r = await T.prepare('SELECT name, category, qty, qty_hash FROM inv_items WHERE store = ? AND item = ?').bind(store, item).first(); return r ? r.name : undefined; };
  const sweepN = (body, store = 914) => call('POST', '/v1/' + store + '/tracker/retrace/sweep', Object.assign({ need: 0 }, body));

  // WO hook: a labelled line, a labor line (not stock), a known item's line without a label, a known named item (kept)
  await sweepN({ touched: ['300002-0000000001'] });
  ok(await sendWo(700010, 10, [{ lineId: 1, name: 'Screen A', sku: '300001', serial: '300001-0000000001', partStatus: 'Reserved', warehouseId: '914', itemId: 9300001 },
    { lineId: 2, name: 'Labor', sku: 'LABOR9', price: 50 }, { lineId: 3, name: 'Back Glass', sku: '300002' }, { lineId: 4, name: 'Battery X', sku: '180001' }]), 'wo with names');
  assert.equal(await nameOf('300001'), 'Screen A', 'WO: a labelled line names its item');
  assert.equal(await nameOf('LABOR9'), undefined, 'WO: a line Retrace doesn\'t know stays out');
  assert.equal(await nameOf('300002'), 'Back Glass', 'WO: a known item without a label');
  assert.equal(await nameOf('180001'), 'Galaxy S24 Battery', 'WO: descriptive text never overwrites a name');
  const nr = await T.prepare("SELECT qty, qty_hash FROM inv_items WHERE store = 914 AND item = '300001'").first();
  assert.deepEqual([nr.qty, nr.qty_hash], [null, null], 'a name row has no quantities');

  // label snapshots: label details' ProductName is authoritative, outstanding parts' PartName (list set) descriptive
  let s1 = await sweepN({ labels: [{ SerialNumber: '300003-0000000001', ItemNumber: '300003', ProductName: 'Camera Lens', Store: '914' },
    ...R.normalize.outstanding({ RMAParts: [{ Store: '914', ItemNumber: '300004', PartName: 'Mic Flex', SerialNumber: '300004-0000000001', SerialStatus: 'Defective' }] }),
    { SerialNumber: '300001-0000000002', ItemNumber: '300001', ProductName: 'Screen A2', Store: '914' }] });
  ok(s1, 'sweep names from labels');
  assert.equal(s1.j.named, 3); assert.equal(s1.j.written, 3, 'name writes aren\'t counted as written');
  assert.equal(await nameOf('300003'), 'Camera Lens'); assert.equal(await nameOf('300004'), 'Mic Flex');
  assert.equal(await nameOf('300001'), 'Screen A2', 'an authoritative name renames');
  s1 = await sweepN({ labels: R.normalize.outstanding({ RMAParts: [{ Store: '914', ItemNumber: '300003', PartName: 'Lens (part)', SerialNumber: '300003-0000000001' }] }) });
  assert.equal(s1.j.named, 0); assert.equal(await nameOf('300003'), 'Camera Lens', 'outstanding PartName only fills');
  // the same names again: no write
  assert.equal((await sweepN({ labels: [{ SerialNumber: '300003-0000000001', ItemNumber: '300003', ProductName: 'Camera Lens', Store: '914' }] })).j.named, 0, 'same name: no write');

  // POs: header LineDescription and receive details' ItemName (descriptive)
  s1 = await sweepN({ pos: [{ header: { PurchaseOrderNumber: 'UBFPO000099100', PurchaseOrderStatus: 'Backorder', PurchaseOrderLinesV2: [{ LineNumber: 1, ItemNumber: '300005', LineDescription: 'Charge Port' },
    { LineNumber: 3, ItemNumber: '300003', LineDescription: 'Lens, desc' }] }, receive: { PurchaseOrderId: 'UBFPO000099100', Lines: [{ LineNum: 2, ItemId: '300006', ItemName: 'Speaker', Serials: [] }] } }] });
  ok(s1, 'PO names');
  assert.equal(await nameOf('300005'), 'Charge Port'); assert.equal(await nameOf('300006'), 'Speaker'); assert.equal(await nameOf('300003'), 'Camera Lens', 'PO text never renames');

  // names intake: RMA / transfer lines (descriptive), item records (authoritative), validation, caps
  s1 = await sweepN({ names: [{ item: '300007', name: '  RMA   Battery ' }, { item: 300014, name: 'Numeric id' }, { item: '300003', name: 'Lens via RMA' }, { item: '300004', name: 'Mic Flex Cable', authoritative: true },
    { item: '300015', name: 'Cat', category: 'Parts' }, { item: '', name: 'x' }, { item: '300008' }, null, 'str', { item: '300009', name: { x: 1 } }] });
  ok(s1, 'names'); assert.equal(s1.j.named, 4);
  assert.equal(await nameOf('300007'), 'RMA Battery', 'trimmed'); assert.equal(await nameOf('300014'), 'Numeric id');
  assert.equal(await nameOf('300003'), 'Camera Lens', 'descriptive never overwrites'); assert.equal(await nameOf('300004'), 'Mic Flex Cable', 'authoritative renames');
  assert.equal((await T.prepare("SELECT category FROM inv_items WHERE store = 914 AND item = '300015'").first()).category, 'Parts');
  assert.equal(await nameOf('300008'), undefined); assert.equal(await nameOf('300009'), undefined);
  assert.equal((await sweepN({ names: [{ item: '300016', name: 'x'.repeat(300) }] })).status, 200);
  assert.equal((await nameOf('300016')).length, 120, 'capped at 120');
  assert.equal((await sweepN({ names: 'x' })).status, 400); assert.equal((await sweepN({ names: Array(201).fill({ item: '1', name: 'a' }) })).status, 400, 'names capped');
  // one sweep: authoritative beats descriptive whatever the order
  await sweepN({ names: [{ item: '300017', name: 'Desc first' }, { item: '300017', name: 'Record name', authoritative: true }] });
  assert.equal(await nameOf('300017'), 'Record name');
  // ignored items: no name rows
  await sweepN({ names: [{ item: 'BB0001', name: 'Buyback device', authoritative: true }], labels: [{ SerialNumber: 'B-616883-0000103990', ItemNumber: 'BB0001', ProductName: 'Buyback device', Store: '914' }] });
  assert.equal(await count("SELECT COUNT(*) AS n FROM inv_items WHERE lower(item) = 'bb0001'"), 0, 'ignored: no name row');
  // store isolation
  await sweepN({ names: [{ item: '300018', name: 'Elsewhere' }] }, 326);
  assert.equal(await nameOf('300018', 326), 'Elsewhere'); assert.equal(await nameOf('300018'), undefined, 'names stay with their store');

  // a name-only row then the item lookup: new (not a false change), then nothing
  const lk = [{ ItemNumber: '300003', ProductName: 'Camera Lens', RetailCategory: 'Parts', WarehouseId: '914', OnHandQuantity: 1, AvailableQuantity: 1 }];
  assert.deepEqual((await sweepN({ items: lk })).j.changedItems, [{ item: '300003', why: 'new' }], 'a name row reads as new to the lookup');
  assert.deepEqual((await sweepN({ items: lk })).j.changedItems, [], 'then unchanged');
  // the lookup's name wins over another source in the same sweep
  await sweepN({ items: [Object.assign({}, lk[0], { ProductName: 'Camera Lens Pro' })], labels: [{ SerialNumber: '300003-0000000002', ItemNumber: '300003', ProductName: 'Camera Lens Old', Store: '914' }] });
  assert.equal(await nameOf('300003'), 'Camera Lens Pro');

  // unnamed: items with a label / movement and no name, ignored ones never, per store, capped
  await sweepN({ touched: ['300019-0000000001', '300020-0000000001'] });
  let un = (await sweepN({ nameNeed: 50 })).j.unnamed;
  assert.ok(un.includes('300019') && un.includes('300020'), JSON.stringify(un));
  assert.ok(!un.includes('300001') && !un.includes('300003') && !un.some((i) => i.toLowerCase() === 'bb0001'), 'named and ignored items left out');
  assert.equal((await sweepN({ nameNeed: 1000 })).j.unnamed.length <= 50, true, 'capped');
  assert.deepEqual((await sweepN({})).j.unnamed, [], 'none unless asked');
  assert.ok(!(await sweepN({ nameNeed: 50 }, 326)).j.unnamed.includes('300019'), 'per store');
  await sweepN({ names: [{ item: '300019', name: 'Read from the item record', authoritative: true }] });
  un = (await sweepN({ nameNeed: 50 })).j.unnamed;
  assert.ok(!un.includes('300019') && un.includes('300020'), 'named: off the list');

  // admin: the item list and search by name
  const il = (await admin('owner@x.com', '/retrace/items?store=914&limit=500')).j.items;
  assert.equal(il.find((x) => x.item === '300001').name, 'Screen A2');
  const sn = await admin('owner@x.com', '/retrace/search?store=914&q=camera');
  assert.ok(sn.j.items.some((x) => x.item === '300003'), 'search finds an item by name');
  assert.equal((await admin('owner@x.com', '/retrace/item/914/300002')).j.info.name, 'Back Glass');
  const c2 = (await admin('owner@x.com', '/retrace/coverage')).j.stores.find((x) => x.store === 914);
  assert.equal(c2.items, 3, 'coverage counts lookup items only: ' + c2.items);
}

// ------------------------------------------------------------------ baseline: label totals up front, one progress bar, the done signal
{
  await env.AE.prepare("INSERT OR IGNORE INTO store_access (store, name) VALUES (536, 'Lexington')").run();
  const sw5 = (body) => call('POST', '/v1/536/tracker/retrace/sweep', Object.assign({ need: 0 }, body));
  const pr = async (seen) => { const r = await call('GET', '/v1/536/tracker/retrace/progress' + (seen ? '?seen=' + encodeURIComponent(seen) : '')); ok(r, 'progress'); return r.j; };
  const full = async () => (await admin('owner@x.com', '/retrace/coverage')).j.stores.find((x) => x.store === 536).progress;
  const lk = (item, name) => Object.assign({ ItemNumber: item, WarehouseId: '536', OnHandQuantity: 2, AvailableQuantity: 2 }, name ? { ProductName: name } : {});
  const lab = (item, n) => ({ SerialNumber: item + '-' + String(n).padStart(10, '0'), ItemNumber: item, SerialStatus: 'Available', Store: '536', ConsignmentStatus: 'No' });
  const hist = (item, n) => call('POST', '/v1/536/tracker/retrace/history', { label: item + '-' + String(n).padStart(10, '0'), rows: [] });
  const PO5 = (id, lines = true) => Object.assign({}, POH, { PurchaseOrderNumber: id, PurchaseOrderLinesV2: lines ? [{ LineNumber: 1, ItemNumber: '500001', LineDescription: 'Part A', OrderedPurchaseQuantity: 1 }] : undefined });

  // nothing yet: counting, no number
  let p0 = await pr();
  assert.deepEqual([p0.state, p0.pct, p0.done_at, p0.announce], ['counting', null, null, false]);
  assert.equal((await call('GET', '/v1/536/tracker/retrace/cursor')).j.baseline.frozen, false);

  // the lookup lists two items (one without a name); the Worker hands out both for counting, nothing else yet
  let s1 = await sw5({ items: [lk('500001', 'Part A'), lk('500002')], cursors: { lookup: { at: AT } }, countNeed: 10 });
  ok(s1, 'lookup sweep');
  assert.deepEqual(s1.j.countNeed, ['500001', '500002']);
  let pc = (await admin('owner@x.com', '/retrace/coverage')).j.stores.find((x) => x.store === 536).progress;
  assert.deepEqual([pc.state, pc.pct, pc.steps, pc.counting], ['counting', null, null, { items_done: 0, items_total: 2, pos_known: false }]);
  // one count in: still counting, and only the other one is handed out; junk totals are refused
  s1 = await sw5({ labelTotals: [{ item: '500001', total: 3 }, { item: '500002', total: -1 }, { item: '', total: 4 }, { item: 'BB0001', total: 9 }, { item: '500002', total: 'x' }], countNeed: 10 });
  assert.deepEqual(s1.j.countNeed, ['500002']);
  assert.equal(await count('SELECT COUNT(*) AS n FROM inv_item_counts WHERE store = 536'), 1, 'only the valid count kept');
  // the last count; the PO total is still unknown, so it can't freeze
  s1 = await sw5({ labelTotals: [{ item: '500002', total: 2 }], countNeed: 10 });
  assert.equal((await pr()).state, 'counting'); assert.deepEqual(s1.j.countNeed, []);
  assert.equal((await full()).counting.items_done, 2);
  // the PO total arrives (not a number: ignored): frozen at once, with the sums
  await sw5({ poTotal: 'many' }); assert.equal((await pr()).state, 'counting');
  s1 = await sw5({ poTotal: 2, countNeed: 10 });
  let g = await full();
  assert.equal(g.state, 'gathering'); assert.ok(g.counted_at); assert.equal(g.done_at, null);
  assert.deepEqual(g.steps, { stock: { x: 2, y: 2 }, labels: { x: 0, y: 5 }, histories: { x: 0, y: 5 }, pos: { x: 0, y: 2 }, names: { x: 1, y: 2 } });
  assert.ok(g.pct >= 0 && g.pct < 20, 'the name read from the lookup counts, nothing else does: ' + g.pct); assert.ok(g.eta_min >= 10 && g.eta_min % 10 === 0, 'eta in whole passes: ' + g.eta_min);
  assert.deepEqual(s1.j.countNeed, [], 'frozen: nothing more to count');
  assert.equal((await call('GET', '/v1/536/tracker/retrace/cursor')).j.baseline.frozen, true);
  // set in stone: later totals, a later PO total, and new items don't move it
  await sw5({ labelTotals: [{ item: '500001', total: 99 }], poTotal: 50, items: [lk('500003', 'Newcomer')] });
  assert.equal((await call('GET', '/v1/536/tracker/retrace/progress')).j.pct, g.pct);
  const b0 = await T.prepare('SELECT expected_items, expected_labels, expected_pos FROM inv_baseline WHERE store = 536').first();
  assert.deepEqual([b0.expected_items, b0.expected_labels, b0.expected_pos], [2, 5, 2]);
  assert.equal(await count('SELECT COUNT(*) AS n FROM inv_item_counts WHERE store = 536 AND item = ?', '500003'), 0, 'a new item is not in the baseline');
  assert.deepEqual((await sw5({ countNeed: 10 })).j.countNeed, [], 'and is not asked for');

  // labels found: the bar moves; a label of the new item is "new since" and changes nothing in the steps
  await sw5({ labels: [lab('500001', 1), lab('500001', 2), lab('500001', 3), lab('500002', 1), lab('500003', 1)], need: 0 });
  g = await full();
  assert.deepEqual([g.steps.labels, g.new_labels], [{ x: 4, y: 5 }, 1], JSON.stringify(g));
  // labels beyond an item's count are new too (a fourth label for an item Portal counted 3 of)
  await sw5({ labels: [lab('500001', 4)] });
  g = await full(); assert.deepEqual([g.steps.labels, g.new_labels], [{ x: 4, y: 5 }, 2]);
  await sw5({ labels: [lab('500002', 2)] });
  g = await full(); assert.deepEqual(g.steps.labels, { x: 5, y: 5 });
  // histories: each read moves it; weighted: with labels and 2 of 5 histories read the bar is between 0 and 100
  await hist('500001', 1); await hist('500001', 2);
  g = await full(); assert.deepEqual(g.steps.histories, { x: 2, y: 5 }); assert.ok(g.pct > 0 && g.pct < 99, 'pct ' + g.pct);
  const mid = g.pct;
  await hist('500001', 3); await hist('500002', 1);
  g = await full(); assert.ok(g.pct > mid && g.pct < 99); assert.equal(g.state, 'gathering');
  // names, POs: every step but the last at 100% is still not done (99 at most), the PO list must be read through too
  await hist('500002', 2);
  await sw5({ names: [{ item: '500002', name: 'Part B', authoritative: true }] });
  assert.deepEqual((await full()).steps.names, { x: 2, y: 2 });
  await sw5({ pos: [{ header: PO5('UBFPO000536001'), receive: { PurchaseOrderId: 'UBFPO000536001', Lines: [] } }, PO5('UBFPO000536002', false), PO5('UBFPO000536003', false)], poNeed: 5 });
  g = await full(); assert.deepEqual(g.steps.pos, { x: 1, y: 2 }); assert.equal(g.state, 'gathering');
  assert.equal(g.pct < 100, true);
  await sw5({ pos: [{ header: PO5('UBFPO000536002'), receive: { PurchaseOrderId: 'UBFPO000536002', Lines: [] } }] });
  g = await full(); assert.deepEqual(g.steps.pos, { x: 2, y: 2 });
  assert.equal(g.state, 'gathering', 'everything at its total but the PO list is not read through yet'); assert.equal(g.pct, 99);
  assert.equal((await pr()).done_at, null);
  // the list is read through: done, once
  await sw5({ cursors: { po_backfill: { page: 3, done: true } } });
  g = await full(); assert.equal(g.state, 'done'); assert.equal(g.pct, 100); assert.equal(g.eta_min, 0);
  const done = g.done_at; assert.ok(done && /Z$/.test(done));
  const sig = await pr();
  assert.deepEqual([sig.state, sig.pct, sig.done_at, sig.announce], ['done', 100, done, true], 'a client that has not announced it');
  assert.equal((await pr(done)).announce, false, 'announced already');
  assert.equal((await pr('2020-01-01T00:00:00.000Z')).announce, true, 'a different done_at than the one it announced');
  // ordinary later changes: new POs, new labels, a new item, more reads: still done, same time, nothing fires again
  await sw5({ pos: [PO5('UBFPO000536009', false)], labels: [lab('500003', 2)], items: [lk('500004', 'Another')] });
  await hist('500003', 1);
  g = await full(); assert.equal(g.state, 'done'); assert.equal(g.done_at, done); assert.ok(g.new_labels >= 3);
  assert.equal((await pr(done)).announce, false);
  // the response carries nothing else of the baseline's insides; per store
  assert.deepEqual(Object.keys(sig).sort(), ['announce', 'done_at', 'pct', 'state', 'store']);
  assert.equal((await call('GET', '/v1/326/tracker/retrace/progress')).j.state, 'counting', 'another store has its own');
  assert.equal((await call('GET', '/v1/999/tracker/retrace/progress')).status, 403, 'a store without access');
  assert.equal((await call('POST', '/v1/536/tracker/retrace/progress', {})).status, 404, 'read only');
  assert.equal((await admin('mgr@x.com', '/retrace/coverage')).j.stores.some((x) => x.store === 536), false, 'coverage (and its progress) is cut to the person\'s stores');
}

// ------------------------------------------------------------------ ignored items (BB0001: buyback devices)
{
  const { ignoredItem } = await import('../src/retrace.js');
  assert.ok(ignoredItem('BB0001') && ignoredItem('bb0001') && ignoredItem(' BB0001 ') && !ignoredItem('180001') && !ignoredItem(null));
  const bb = 'B-286093-0000137332', bbRow = (ev, t) => ({ InventSerialId: bb, ItemId: 'BB0001', Store: '914', DateTime: t, SerialEventType: ev, SerialStatus: 'Received', RefTable: 'Sales orders', SourceKey: 'FSO000321533', SourceKeyLineNum: 1, User: 'RetailServiceAccount' });
  await call('POST', '/v1/914/tracker/retrace/sweep', { touched: [bb], need: 0 }); // queued by its label alone (item 286093)
  assert.ok(await T.prepare('SELECT 1 FROM inv_labels WHERE store = 914 AND label = ?').bind(bb).first(), 'touched label queued');
  const h = await call('POST', '/v1/914/tracker/retrace/history', { label: bb, rows: [bbRow('SerialReserved', '2026-10-23T12:00:00Z')] });
  assert.equal(h.j.ignored, true);
  assert.equal(await T.prepare('SELECT 1 FROM inv_labels WHERE store = 914 AND label = ?').bind(bb).first(), null, 'its history says BB0001: label dropped');
  assert.equal((await T.prepare("SELECT COUNT(*) AS n FROM inv_movements WHERE lower(item) = 'bb0001'").first()).n, 0, 'no BB0001 movements from history');
  const w = await call('POST', '/v1/914/tracker/retrace/watch', { movements: [{ label: bb, item: 'BB0001', kind: 'reserved', source: 'watch', at: '2026-10-23T12:05:00Z', ref_type: 'wo', ref_id: '500000001' }] });
  assert.equal(w.status, 200); assert.equal(w.j.added, 0, 'watcher: BB0001 not stored');
  await call('POST', '/v1/914/tracker/retrace/sweep', { labels: [{ SerialNumber: 'B-616883-0000103989', ItemNumber: 'BB0001', SerialStatus: 'Reserved', Store: '914' }], items: [{ ItemNumber: 'BB0001', ProductName: 'Buyback device', WarehouseId: '914', OnHandQuantity: 3 }], need: 0 });
  assert.equal((await T.prepare("SELECT COUNT(*) AS n FROM inv_labels WHERE lower(item) = 'bb0001'").first()).n, 0, 'sweep: BB0001 label snapshots skipped');
  assert.equal((await T.prepare("SELECT COUNT(*) AS n FROM inv_items WHERE lower(item) = 'bb0001'").first()).n, 0, 'sweep: BB0001 item rows skipped');
}

await dispose();
rmSync('.wrangler-test-retrace', { recursive: true, force: true });
console.log('retrace: all passed');
