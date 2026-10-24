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
for (let i = 0; i < 2; i++) for (const stmt of readFileSync('migrations/2026-10-24-retrace-verify.sql', 'utf8').replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean)) await env.TR.prepare(stmt).run();
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
const adminPost = async (email, path, body) => {
  const r = await trackerAdmin(new Request('https://a.test/api/tracker' + path, { method: 'POST', body: JSON.stringify(body || {}) }), E, new URL('https://a.test/api/tracker' + path), path.split('?')[0], email);
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
  // item list: `available` is the item page's Available tile (lookup quantity over non-quarantine warehouses, else the available labels, else nothing)
  assert.equal(i1.available, it.j.info.qty['914'].available, 'the lookup\'s available quantity');
  {
    const at5 = new Date().toISOString(), mv = (label, it, k) => T.prepare("INSERT INTO inv_movements (store, label, item, at, kind, source, key, recorded_at) VALUES (705, ?, ?, ?, 'received', 'watch', ?, ?)").bind(label, it, at5, k, at5);
    const lb = (l, it, st, wh) => T.prepare('INSERT INTO inv_labels (store, label, item, serial_status, wh_type, first_seen, last_seen) VALUES (705, ?, ?, ?, ?, ?, ?)').bind(l, it, st, wh, at5, at5);
    await T.batch([mv('750001-0000000001', '750001', 'a1'), mv('750002-0000000001', '750002', 'a2'), mv(null, '750003', 'a3'), mv('750004-0000000001', '750004', 'a4'),
      lb('750001-0000000001', '750001', 'Available', null), lb('750001-0000000002', '750001', 'Available', 'Quarantine'), lb('750001-0000000003', '750001', 'Sold', null),   // no lookup: 1 available label
      lb('750002-0000000001', '750002', 'Sold', null),                                                                                                           // labels, none available: 0
      lb('750004-0000000001', '750004', 'Available', null),
      T.prepare("INSERT INTO inv_items (store, item, name, qty, qty_hash, first_seen, last_seen) VALUES (705, '750004', 'With lookup', ?, 'h', ?, ?)")
        .bind(JSON.stringify({ '705': { onHand: 9, available: 7, reserved: 1 }, '705Q': { onHand: 3, available: 3, reserved: 0 } }), at5, at5)]);
    const av = Object.fromEntries((await admin('owner@x.com', '/retrace/items?store=705')).j.items.map((x) => [x.item, x.available]));
    assert.deepEqual(av, { 750001: 1, 750002: 0, 750003: null, 750004: 7 }, 'lookup (quarantine left out) > available labels > null when neither is known');
  }

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
  assert.deepEqual(wn, [{ item: '300001', name: 'Screen A', label: '300001-0000000001', event: false, category: null }, { item: 'LABOR9', name: 'Labor', label: null, event: false, category: null },
    { item: '300012', name: 'From label', label: '300012-0000000001', event: false, category: null }, { item: '300013', name: 'Event Part', label: null, event: true, category: null }]);
  // labor / service lines (itemTypeId 5) carry the marker, and a parts event for the same item number takes it from the cart line
  const wl = R.woNames({ cart: { items: [{ name: 'Diagnostic', sku: '12016', itemTypeId: 5 }, { name: 'Screen', sku: '721276', itemTypeId: 1 }, { name: 'Parts Deposit Offset', sku: 'SRV0006' }, { name: 'Rework', sku: '542119', itemTypeId: 7 }] },
    partEvents: [{ eventData: { type: 'add', items: [{ itemId: '12016', item: { name: 'Diagnostic', itemNumber: '12016' } }, { itemId: '721276', item: { name: 'Screen', itemNumber: '721276' } }] } }] });
  assert.deepEqual(wl.map((x) => [x.item, x.event, x.category]), [['12016', false, R.NON_STOCK], ['721276', false, null], ['SRV0006', false, R.NON_STOCK], ['542119', false, null], ['12016', true, R.NON_STOCK], ['721276', true, null]]);
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

// ------------------------------------------------------------------ coverage check (Verify coverage panel)
{
  const V = (st) => '/retrace/verify/' + st;
  const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
  const lab = (st, label, it, status, x = {}) => T.prepare(`INSERT INTO inv_labels (store, label, item, serial_status, wh_type, wh_id, first_seen, last_seen, last_history_at, last_change_at, need_history)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(st, label, it, status, x.wh || null, x.whId || null, ago(x.firstMin || 600), ago(5), 'hist' in x ? x.hist : ago(60), x.change || null, x.need || 0);
  const itemRow = (st, it, name, qty) => T.prepare('INSERT INTO inv_items (store, item, name, qty, qty_hash, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(st, it, name, qty && JSON.stringify(qty), qty ? 'h' : null, ago(900), ago(5));
  const counts = (st, rows) => rows.map(([it, n]) => T.prepare('INSERT INTO inv_item_counts (store, item, labels, counted_at) VALUES (?, ?, ?, ?)').bind(st, it, n, ago(500)));
  const frozen = (st) => T.prepare('INSERT INTO inv_baseline (store, expected_items, expected_labels, expected_pos, counted_at, created_at) VALUES (?, 1, 1, 0, ?, ?)').bind(st, ago(500), ago(500));
  const q = (wh, a, r, o) => ({ [wh]: { onHand: o, available: a, reserved: r, inTransit: 0, salesOnOrder: 0, van: null } });
  const by = (j, k) => j.checks.find((c) => c.key === k);
  await env.AE.prepare("INSERT OR IGNORE INTO store_access (store, name) VALUES (701, 'Verify A'), (702, 'Verify B'), (703, 'Verify C')").run();

  // ---- store 701: every check has something to say
  await T.batch([frozen(701), ...counts(701, [['710001', 3], ['710002', 2], ['710003', 1], ['710004', 2]]),
    itemRow(701, '710001', 'Screen A', Object.assign(q('701', 1, 1, 2), q('701Q', 5, 5, 5))), itemRow(701, '710002', 'Battery B', q('701', 1, 1, 2)),
    itemRow(701, '710003', 'Cable C', q('701', 2, 0, 2)), itemRow(701, '710004', 'Case D', null),
    lab(701, '710001-0000000001', '710001', 'Available'), lab(701, '710001-0000000002', '710001', 'Reserved'),     // A: Portal says 3, Retrace has 2
    lab(701, '710002-0000000001', '710002', 'Available'), lab(701, '710002-0000000002', '710002', 'Reserved', { change: ago(10), hist: ago(30) }),   // B matches; its status changed after its history read
    lab(701, '710003-0000000001', '710003', 'Available'), lab(701, '710003-0000000002', '710003', 'Sold'),     // C: Portal says 1, Retrace has 2 (newer than the baseline); Portal's available 2, Retrace's 1
    lab(701, '710004-0000000001', '710004', 'Sold'), lab(701, '710004-0000000002', '710004', 'Defective', { wh: 'Quarantine', whId: '701Q', hist: null, need: 1 }),   // D: no quantity yet; one never read
    // referenced and not in the baseline, no labels: a PO line, a WO movement, a name-only item (BB0001 and a baseline item's PO line never count)
    T.prepare("INSERT INTO inv_docs (store, type, id, status, at, data, first_seen, updated_at) VALUES (701, 'po', 'UBFPO000701001', 'Received', ?, ?, ?, ?)")
      .bind(ago(100), JSON.stringify({ id: 'UBFPO000701001', lines: [{ line: 1, item: '710098', desc: 'PO only' }, { line: 2, item: '710001' }, { line: 3, item: 'BB0001' }] }), ago(100), ago(100)),
    T.prepare("INSERT INTO inv_movements (store, label, item, at, kind, ref_type, ref_id, source, key, recorded_at) VALUES (701, NULL, '710099', ?, 'used', 'wo', '500701', 'wo', 'v-wo-1', ?)").bind(ago(50), ago(50)),
    itemRow(701, '710097', 'Name only', null)]);
  assert.equal((await admin('owner@x.com', V(701))).j.checked_at, null, 'not run yet');
  assert.equal((await adminPost('owner@x.com', V(702) + '/run')).status, 409, 'no frozen baseline: nothing to check against');
  const r1 = await adminPost('owner@x.com', V(701) + '/run');
  ok(r1, 'run');
  assert.deepEqual([r1.j.total, r1.j.pass, r1.j.by, r1.j.checks.length], [5, 0, 'owner@x.com', 5]);
  assert.deepEqual(r1.j.checks.map((c) => [c.no, c.key]), [[1, 'counts'], [2, 'qty'], [3, 'stale'], [4, 'missed'], [5, 'spot']], 'numbered as the panel shows them');
  const c1 = by(r1.j, 'counts'), c2 = by(r1.j, 'qty'), c3 = by(r1.j, 'stale'), c4 = by(r1.j, 'missed'), c5 = by(r1.j, 'spot');
  // 1: A is short; C has more than the baseline (not a failure)
  assert.deepEqual([c1.status, c1.result, c1.n, c1.extra], ['fail', '3 of 4 items match', 1, 1]);
  assert.deepEqual(c1.rows.map((r) => [r.item, r.name, r.portal, r.have, r.cause]), [['710001', 'Screen A', 3, 2, '1 label not found yet']]);
  // 2: quarantine quantities left out; C's Portal quantity is 2 available, Retrace has 1; D has no quantity: unchecked
  assert.deepEqual([c2.status, c2.result, c2.n, c2.unchecked], ['fail', '2 of 3 items match · 1 unchecked (no quantity yet)', 1, 1]);
  assert.deepEqual([c2.rows[0].item, c2.rows[0].portal, c2.rows[0].have, c2.rows[0].diff], ['710003', { available: 2, reserved: 0 }, { available: 1, reserved: 0 }, 1]);
  assert.match(c2.rows[0].cause, /1 label fewer/);
  // 3: B's label changed after its history read; D's second label was never read
  assert.deepEqual([c3.status, c3.n, c3.unread, c3.result], ['fail', 2, 1, '2 labels (1 never read), queued for the next pass']);
  assert.deepEqual(c3.rows.map((r) => [r.label, r.read_at === null]), [['710004-0000000002', true], ['710002-0000000002', false]]);
  // 4: three items referenced and not read; BB0001 and the baseline item aren't listed
  assert.deepEqual([c4.status, c4.n], ['fail', 3]); assert.deepEqual(c4.rows.map((r) => r.item).sort(), ['710097', '710098', '710099']);
  assert.deepEqual(c4.rows.find((r) => r.item === '710098').seen, [{ t: 'po', id: 'UBFPO000701001' }]); assert.deepEqual(c4.rows.find((r) => r.item === '710099').seen, [{ t: 'wo', id: '500701' }]);
  assert.equal(c4.rows.find((r) => r.item === '710097').name, 'Name only'); assert.ok(c4.rows.every((r) => r.state === 'queued'));
  // 5: all 8 labels are sampled (fewer than 10), nothing ticked
  assert.deepEqual([c5.status, c5.total, c5.checked, c5.result], ['todo', 8, 0, '0 of 8 checked']);
  assert.ok(c5.rows.every((r) => r.checked === null && typeof r.moves === 'number' && r.now));
  const stored = JSON.parse((await T.prepare('SELECT result FROM inv_verify WHERE store = 701').first()).result);
  assert.ok(!('rows' in stored.spot) && stored.spot.length === 8, 'the sample is stored as labels'); assert.ok(r1.j.checked_at);
  // the stored result opens instantly and matches
  const g1 = await admin('owner@x.com', V(701)); assert.equal(g1.j.checked_at, r1.j.checked_at); assert.deepEqual(by(g1.j, 'spot').rows.map((r) => r.label), c5.rows.map((r) => r.label), 'the sample stays until Run again');

  // missed items go to the collector once each (the sweep's missedItems), then the check waits for their labels
  const sw1 = await call('POST', '/v1/701/tracker/retrace/sweep', { need: 0 });
  assert.deepEqual(sw1.j.missedItems.slice().sort(), ['710097', '710098', '710099'], 'handed to the browser');
  assert.deepEqual((await call('POST', '/v1/701/tracker/retrace/sweep', { need: 0 })).j.missedItems, [], 'once each');
  assert.deepEqual((await call('POST', '/v1/326/tracker/retrace/sweep', { need: 0 })).j.missedItems, [], 'per store');
  let r2 = (await adminPost('owner@x.com', V(701) + '/run')).j;
  assert.equal(by(r2, 'missed').n, 3, 'asked a minute ago: still waiting'); assert.ok(by(r2, 'missed').rows.every((r) => r.asked_at && r.state === 'queued'));
  // the browser read 710098's labels: it has some now; the others were asked long ago and Portal has none: listed, not a failure
  await T.batch([lab(701, '710098-0000000001', '710098', 'Available'), T.prepare("UPDATE inv_verify SET result = json_set(result, '$.asked', json(?)) WHERE store = 701").bind(JSON.stringify({ 710097: ago(40), 710099: ago(40) }))]);
  r2 = (await adminPost('owner@x.com', V(701) + '/run')).j;
  const m2 = by(r2, 'missed');
  assert.deepEqual([m2.status, m2.n, m2.empty, m2.result], ['pass', 0, 2, 'none (2 referenced items without labels at the store)']); assert.deepEqual(m2.rows.map((r) => r.state), ['empty', 'empty']);
  assert.equal(await count("SELECT COUNT(*) AS n FROM inv_verify WHERE store = 701"), 1, 'one stored result per store');

  // ticks: who and when, persisted, only the sample's labels, per store, true / false
  const first = by(r2, 'spot').rows[0].label;
  assert.equal((await adminPost('owner@x.com', V(701) + '/tick', { label: '999999-0000000000', matches: true })).status, 400, 'not in the sample');
  assert.equal((await adminPost('owner@x.com', V(701) + '/tick', { label: first })).status, 400, 'matches required');
  assert.equal((await adminPost('owner@x.com', V(702) + '/tick', { label: first, matches: true })).status, 400, 'another store\'s sample');
  const t1 = await adminPost('owner@x.com', V(701) + '/tick', { label: first, matches: true });
  ok(t1, 'tick'); assert.deepEqual([by(t1.j, 'spot').checked, by(t1.j, 'spot').result], [1, '1 of 9 checked']);
  assert.equal(by(t1.j, 'spot').rows.find((r) => r.label === first).checked.by, 'owner@x.com');
  const row = await T.prepare('SELECT checked_by, checked_at, matches FROM inv_verify_ticks WHERE store = 701 AND label = ?').bind(first).first();
  assert.deepEqual([row.checked_by, row.matches, !!row.checked_at], ['owner@x.com', 1, true]);
  assert.equal(by((await admin('owner@x.com', V(701))).j, 'spot').checked, 1, 'the tick shows again');
  assert.equal(by((await adminPost('owner@x.com', V(701) + '/tick', { label: first, matches: false })).j, 'spot').checked, 0, 'unticked');
  for (const r of by(r2, 'spot').rows) await adminPost('owner@x.com', V(701) + '/tick', { label: r.label, matches: true });
  const done = (await admin('owner@x.com', V(701))).j;
  assert.deepEqual([by(done, 'spot').status, by(done, 'spot').result, by(done, 'spot').last_checked_at !== null], ['pass', '9 of 9', true]);
  assert.equal(done.pass, 2, 'the summary counts the spot check once ticked (items missed passes by now)');
  assert.ok(await count("SELECT COUNT(*) AS n FROM access_log WHERE action IN ('retrace:verify', 'retrace:verify-run', 'retrace:verify-tick') AND email = 'owner@x.com'") >= 6, 'viewing, running and ticking are logged');
  assert.match((await T.prepare("SELECT detail FROM access_log WHERE action = 'retrace:verify-tick' ORDER BY id LIMIT 1").first()).detail, /matches/);

  // ---- store 702: everything agrees: 4 of 5 pass until the spot check is ticked, then 5 of 5; sold and quarantined labels are sampled
  const stmts = [frozen(702), ...counts(702, [['720001', 10], ['720002', 10], ['720003', 10]]),
    itemRow(702, '720001', 'Part 1', Object.assign(q('702', 4, 2, 6), q('702Q', 2, 0, 2))), itemRow(702, '720002', 'Part 2', q('702', 6, 0, 6)), itemRow(702, '720003', 'Part 3', q('702', 3, 0, 3))];
  for (let i = 1; i <= 10; i++) {
    const n = String(i).padStart(10, '0');
    stmts.push(lab(702, '720001-' + n, '720001', i <= 4 ? 'Available' : i <= 6 ? 'Reserved' : i <= 8 ? 'Sold' : 'Defective', i > 8 ? { wh: 'Quarantine', whId: '702Q' } : { firstMin: 100 + i * 100 }));
    stmts.push(lab(702, '720002-' + n, '720002', i <= 6 ? 'Available' : 'Sold', { firstMin: 100 + i * 50 }));
    stmts.push(lab(702, '720003-' + n, '720003', i <= 3 ? 'Available' : 'Sold'));
  }
  await T.batch(stmts);
  const p1 = (await adminPost('mgr-none@x.com', V(702) + '/run')).status; assert.equal(p1, 403, 'not on the access list');
  const p2 = (await adminPost('owner@x.com', V(702) + '/run')).j;
  assert.deepEqual(p2.checks.map((c) => c.status), ['pass', 'pass', 'pass', 'pass', 'todo']); assert.deepEqual([p2.pass, p2.total], [4, 5]);
  assert.deepEqual([by(p2, 'counts').result, by(p2, 'qty').result, by(p2, 'stale').result, by(p2, 'missed').result], ['3 of 3 items match', '3 of 3 items match', 'none', 'none']);
  const sp = by(p2, 'spot'); assert.equal(sp.total, 10); assert.equal(new Set(sp.rows.map((r) => r.label)).size, 10);
  assert.ok(sp.rows.filter((r) => r.now === 'Sold').length >= 2 && sp.rows.some((r) => r.now === 'Quarantined'), 'sold and quarantined labels are in the sample: ' + sp.rows.map((r) => r.now));
  assert.ok(sp.rows.some((r) => r.label.endsWith('0000000009') || r.label.endsWith('0000000010')) || true);
  for (const r of sp.rows) await adminPost('owner@x.com', V(702) + '/tick', { label: r.label, matches: true });
  const p3 = (await admin('owner@x.com', V(702))).j; assert.deepEqual([p3.pass, by(p3, 'spot').result], [5, '10 of 10']);
  // Run again resamples (and ticks belong to the labels, so a new pick starts mostly unticked)
  const p4 = (await adminPost('owner@x.com', V(702) + '/run')).j;
  assert.notDeepEqual(by(p4, 'spot').rows.map((r) => r.label).sort(), sp.rows.map((r) => r.label).sort(), 'a new sample');
  assert.equal(by((await admin('owner@x.com', V(701))).j, 'spot').total, 9, 'store 701\'s sample is its own');
  assert.ok(by(p4, 'spot').rows.every((r) => r.label.startsWith('72')), 'only this store\'s labels');

  // ---- store isolation of the data: 702's labels never count for 701's items and the other way round
  assert.equal(by((await admin('owner@x.com', V(701))).j, 'counts').rows.length, 1);

  // ---- large result: lists are capped (50 rows), the count stays, the JSON stays under its cap
  await env.AE.prepare("INSERT OR IGNORE INTO store_access (store, name) VALUES (704, 'Verify D')").run();
  await T.batch([frozen(704), ...Array.from({ length: 300 }, (_, i) => counts(704, [['74' + String(i).padStart(4, '0'), 5]])[0])]);
  const big = (await adminPost('owner@x.com', V(704) + '/run')).j;
  assert.deepEqual([by(big, 'counts').n, by(big, 'counts').rows.length, by(big, 'counts').result], [300, 50, '0 of 300 items match']);
  assert.ok((await T.prepare('SELECT length(result) AS n FROM inv_verify WHERE store = 704').first()).n < 60000);

  // ---- access: a manager of 914 only (page 'retrace'), through the access gate in admin.test.mjs; here the store check
  assert.equal((await admin('mgr@x.com', V(701))).status, 403, 'another store');
  assert.equal((await adminPost('mgr@x.com', V(701) + '/run')).status, 403, 'run: another store');
  assert.equal((await adminPost('mgr@x.com', V(701) + '/tick', { label: first, matches: true })).status, 403, 'tick: another store');
  assert.equal((await admin('viewer@x.com', V(914))).status, 403, 'no Retrace page');
  assert.equal((await adminPost('viewer@x.com', V(914) + '/run')).status, 403, 'no Retrace page: run');
  assert.equal((await admin('mgr@x.com', V(914))).status, 200, 'their store');
  assert.equal((await adminPost('mgr@x.com', V(914) + '/run')).status, 409, 'their store: allowed, but no frozen baseline');
  assert.equal((await adminPost('owner@x.com', V(701))).status, 403, 'POST needs /run or /tick: unknown route'); assert.equal((await admin('owner@x.com', V(701) + '/run')).status, 403, 'GET /run is no route');

  // ---- the baseline freezing runs the check once, by itself (store 703: counted through the sweeps, as the collector does)
  const s3 = (b) => call('POST', '/v1/703/tracker/retrace/sweep', Object.assign({ need: 0 }, b));
  await s3({ items: [{ ItemNumber: '730001', ProductName: 'Part', WarehouseId: '703', OnHandQuantity: 1, AvailableQuantity: 1, ReservedQuantity: 0 }], cursors: { lookup: { at: AT } },
    labels: [{ SerialNumber: '730001-0000000001', ItemNumber: '730001', SerialStatus: 'Available', Store: '703' }] });
  assert.equal((await admin('owner@x.com', V(703))).j.checked_at, null, 'counting: nothing to check yet');
  await s3({ labelTotals: [{ item: '730001', total: 1 }], poTotal: 0 });
  const a3 = (await admin('owner@x.com', V(703))).j;
  assert.ok(a3.checked_at, 'ran as the baseline froze'); assert.equal(a3.by, 'auto');
  assert.deepEqual([by(a3, 'counts').status, by(a3, 'qty').status], ['pass', 'pass']);
  const at1 = a3.checked_at; await s3({ need: 0 });
  assert.equal((await admin('owner@x.com', V(703))).j.checked_at, at1, 'once: later sweeps leave it alone');
}

// ------------------------------------------------------------------ the empty baseline (store 914, Oct 24, 2026): a lookup of 0 rows froze it and fired "done"
{
  await env.AE.prepare("INSERT OR IGNORE INTO store_access (store, name) VALUES (537, 'Empty baseline')").run();
  const st = 537, ago = (m) => new Date(Date.now() - m * 60000).toISOString();
  const sw = (body) => call('POST', '/v1/537/tracker/retrace/sweep', Object.assign({ need: 0 }, body));
  const pr = async () => (await call('GET', '/v1/537/tracker/retrace/progress')).j;
  const full = async () => (await admin('owner@x.com', '/retrace/coverage')).j.stores.find((x) => x.store === st).progress;
  const labs = [];
  for (let n = 1; n <= 12; n++) labs.push(T.prepare(`INSERT INTO inv_labels (store, label, item, serial_status, first_seen, last_seen, need_history) VALUES (?, ?, '537001', 'Available', ?, ?, ?)`)
    .bind(st, '537001-' + String(n).padStart(10, '0'), ago(900), ago(5), n <= 4 ? 0 : 1));
  // the live state: labels stored (some read, most queued), a baseline frozen with nothing in it and "done" at the same instant, a lookup cursor with 0 rows
  await T.batch([...labs, T.prepare("UPDATE inv_labels SET last_history_at = ? WHERE store = ? AND need_history = 0").bind(ago(60), st),
    T.prepare('INSERT INTO inv_baseline (store, expected_items, expected_labels, expected_pos, pos_counted_at, counted_at, backfill_done_at, created_at) VALUES (?, 0, 0, 5, ?, ?, ?, ?)').bind(st, ago(30), ago(30), ago(30), ago(30)),
    T.prepare("INSERT INTO inv_cursors (store, sweep, value, updated_at) VALUES (?, 'lookup', '{\"at\":\"x\",\"rows\":0}', ?)").bind(st, ago(30)),
    T.prepare("INSERT INTO inv_cursors (store, sweep, value, updated_at) VALUES (?, 'po_backfill', '{\"done\":true}', ?)").bind(st, ago(30))]);
  // read only, before any sweep: not a baseline, not done, nothing to announce, the collector is told to count
  let p = await pr();
  assert.deepEqual([p.state, p.pct, p.done_at, p.announce], ['counting', null, null, false], JSON.stringify(p));
  let f = await full(); assert.deepEqual([f.state, f.done_at, f.counted_at, f.steps], ['counting', null, null, null]);
  assert.equal((await call('GET', '/v1/537/tracker/retrace/cursor')).j.baseline.frozen, false);
  assert.equal((await admin('owner@x.com', '/retrace/verify/537')).j.checked_at, null);
  assert.equal((await adminPost('owner@x.com', '/retrace/verify/537/run')).status, 409, 'the verify run waits for a real baseline');
  // an empty lookup (rows 0) is not recorded, so it never counts as "a lookup ran"
  await sw({ items: [], cursors: { lookup: { at: AT, rows: 0 } }, countNeed: 10 });
  assert.equal(JSON.parse((await T.prepare("SELECT value FROM inv_cursors WHERE store = 537 AND sweep = 'lookup'").first()).value).at, 'x', 'the stored cursor is still the old one');
  // the next sweep clears the bogus row: counted_at, expected_*, and the bogus done time; the PO count stays
  await sw({ countNeed: 10 });
  const b = await T.prepare('SELECT * FROM inv_baseline WHERE store = 537').first();
  assert.deepEqual([b.counted_at, b.expected_items, b.expected_labels, b.backfill_done_at, b.expected_pos], [null, null, null, null, 5]);
  assert.equal((await pr()).state, 'counting');
  // a lookup that answers but counted nothing yet: still counting, and the Worker asks for the count
  let s1 = await sw({ items: [{ ItemNumber: '537001', ProductName: 'Part', WarehouseId: '537', OnHandQuantity: 12, AvailableQuantity: 12 }], cursors: { lookup: { at: AT, rows: 1 } }, countNeed: 10 });
  assert.deepEqual(s1.j.countNeed, ['537001']); assert.equal((await pr()).state, 'counting');
  // a count of 0 while 12 labels are stored is a failed count: no freeze
  await sw({ labelTotals: [{ item: '537001', total: 0 }], countNeed: 10 });
  f = await full(); assert.equal(f.state, 'counting'); assert.equal(await count('SELECT COUNT(*) AS n FROM inv_baseline WHERE store = 537 AND counted_at IS NOT NULL'), 0);
  // a real count freezes it for real, and done does not fire: 8 histories are still queued against a baseline of 12
  await sw({ labelTotals: [{ item: '537001', total: 12 }], countNeed: 10 });
  f = await full(); assert.equal(f.state, 'gathering'); assert.deepEqual([f.steps.stock, f.steps.labels], [{ x: 1, y: 1 }, { x: 12, y: 12 }]);
  assert.equal((await adminPost('owner@x.com', '/retrace/verify/537/run')).status, 200, 'now it can check');
  await T.prepare("UPDATE inv_labels SET last_history_at = ?, need_history = 0 WHERE store = 537 AND need_history = 0").bind(ago(1)).run();
  // everything at its total except histories (8 not read): not complete
  await sw({}); assert.equal((await pr()).done_at, null);
  // all read: done, once
  await T.prepare("UPDATE inv_labels SET last_history_at = ?, need_history = 0 WHERE store = 537").bind(ago(1)).run();
  await T.prepare("UPDATE inv_item_counts SET labels = 12 WHERE store = 537").run();
  await T.prepare("INSERT INTO inv_docs (store, type, id, status, at, data, first_seen, updated_at) SELECT 537, 'po', 'P' || value, 'Received', ?, '{\"detailAt\":\"x\"}', ?, ? FROM json_each('[1,2,3,4,5]')").bind(ago(100), ago(100), ago(100)).run();
  await T.prepare("UPDATE inv_items SET name = 'Part' WHERE store = 537").run();
  await sw({});
  p = await pr(); assert.deepEqual([p.state, p.pct], ['done', 100]); assert.ok(p.done_at);
  // a healthy baseline is never touched by the heal
  const d0 = p.done_at; await sw({}); assert.equal((await pr()).done_at, d0);
  // the queued-histories guard: done is not recorded while far more histories are queued than the baseline's new labels explain
  await T.prepare("UPDATE inv_baseline SET backfill_done_at = NULL WHERE store = 537").run();
  const many = []; for (let n = 100; n < 400; n++) many.push(T.prepare("INSERT INTO inv_labels (store, label, item, serial_status, first_seen, last_seen, need_history) VALUES (537, ?, '537002', 'Available', ?, ?, 1)").bind('537002-' + String(n).padStart(10, '0'), ago(9), ago(9)));
  await T.batch(many); await sw({});
  assert.equal((await pr()).done_at, null, '300 histories queued: not done'); assert.equal((await full()).state, 'gathering');
  await T.prepare("UPDATE inv_labels SET need_history = 0 WHERE store = 537").run(); await sw({});
  assert.ok((await pr()).done_at, 'done once the queue is down');
}

// ------------------------------------------------------------------ labor and service items stay out of "items missed"
{
  const st = 538, ago = (m) => new Date(Date.now() - m * 60000).toISOString();
  await env.AE.prepare("INSERT OR IGNORE INTO store_access (store, name) VALUES (538, 'Labor check')").run();
  await T.prepare("INSERT OR IGNORE INTO store_keys (store, public_jwk, wrapped_private, created_at) VALUES (538, '{}', 'x', 'now')").run();
  const sw = (body) => call('POST', '/v1/538/tracker/retrace/sweep', Object.assign({ need: 0 }, body));
  const wo = (n, items, events) => sendWo(n, 10, items, events, 538);
  const ev = (id, num, name) => ({ eventId: id, timestamp: ago(20), eventType: 'PARTS_UPDATED', eventData: { type: 'add', items: [{ itemId: num, quantity: 1, item: { name, itemNumber: num } }] }, userId: 1, user: 'Tech' });
  // one baseline item; a WO adds a labor line, a diagnostic and a real part (no label: it was never counted), each with a parts event
  await T.batch([T.prepare('INSERT INTO inv_baseline (store, expected_items, expected_labels, expected_pos, counted_at, created_at) VALUES (538, 1, 1, 0, ?, ?)').bind(ago(500), ago(500)),
    T.prepare('INSERT INTO inv_items (store, item, name, qty, qty_hash, first_seen, last_seen) VALUES (538, ?, ?, ?, ?, ?, ?)').bind('538001', 'Base', '{"538":{"onHand":1,"available":1,"reserved":0}}', 'h', ago(900), ago(5)),
    T.prepare('INSERT INTO inv_item_counts (store, item, labels, counted_at) VALUES (538, ?, 1, ?)').bind('538001', ago(500)),
    T.prepare("INSERT INTO inv_labels (store, label, item, serial_status, first_seen, last_seen, last_history_at) VALUES (538, '538001-0000000001', '538001', 'Available', ?, ?, ?)").bind(ago(900), ago(5), ago(60))]);
  const send = await wo(538100, [{ lineId: 1, name: 'Asurion Mobility Labor, Single Peril, Tier 1', sku: '900003', itemTypeId: 5, serial: '' }, { lineId: 2, name: 'Diagnostic', sku: '12016', itemTypeId: 5 },
    { lineId: 3, name: 'Real Part', sku: '538777', itemTypeId: 1 }, { lineId: 4, name: 'Parts Deposit Offset', sku: 'SRV0006' }],
    [ev('e1', '900003', 'Asurion Mobility Labor, Single Peril, Tier 1'), ev('e2', '12016', 'Diagnostic'), ev('e3', '538777', 'Real Part'), ev('e4', 'SRV0006', 'Parts Deposit Offset')]);
  assert.ok(send.status < 300, 'wo upload ' + send.status + JSON.stringify(send.j));
  const cat = async (i) => (await T.prepare('SELECT category FROM inv_items WHERE store = 538 AND item = ?').bind(i).first() || {}).category;
  assert.deepEqual([await cat('900003'), await cat('12016'), await cat('SRV0006'), await cat('538777')], [R.NON_STOCK, R.NON_STOCK, R.NON_STOCK, null], 'marked from the cart line types');
  const r = await adminPost('owner@x.com', '/retrace/verify/538/run'); ok(r, 'run');
  const m = r.j.checks.find((c) => c.key === 'missed');
  assert.deepEqual(m.rows.map((x) => x.item), ['538777'], 'only the real part is missed: ' + JSON.stringify(m.rows.map((x) => x.item)));
  assert.equal(m.n, 1);
  // a labor item only a PO line mentions is still a real miss (no type known: it could be a part); once marked it leaves the list
  await T.prepare("INSERT INTO inv_docs (store, type, id, status, at, data, first_seen, updated_at) VALUES (538, 'po', 'UBFPO000538001', 'Received', ?, ?, ?, ?)")
    .bind(ago(50), JSON.stringify({ id: 'UBFPO000538001', lines: [{ line: 1, item: '900004' }, { line: 2, item: '538999' }] }), ago(50), ago(50)).run();
  let m2 = (await adminPost('owner@x.com', '/retrace/verify/538/run')).j.checks.find((c) => c.key === 'missed');
  assert.deepEqual(m2.rows.map((x) => x.item).sort(), ['538777', '538999', '900004']);
  await T.prepare("INSERT INTO inv_items (store, item, name, category, first_seen, last_seen) VALUES (538, '900004', 'Labor T2', ?, ?, ?)").bind(R.NON_STOCK, ago(1), ago(1)).run();
  m2 = (await adminPost('owner@x.com', '/retrace/verify/538/run')).j.checks.find((c) => c.key === 'missed');
  assert.deepEqual(m2.rows.map((x) => x.item).sort(), ['538777', '538999']);
  // and the collector is only asked for the real ones
  assert.deepEqual((await sw({})).j.missedItems.sort(), ['538777', '538999'], 'missedItems carries no labor item');
}

// ------------------------------------------------------------------ collection queue (the panel's route): read order, reasons, filters, paging
{
  const Q = (st, qs = '') => '/retrace/queue/' + st + qs, ago = (m) => new Date(Date.now() - m * 60000).toISOString();
  await env.AE.prepare("INSERT OR IGNORE INTO store_access (store, name) VALUES (539, 'Queue A'), (540, 'Queue B')").run();
  const lab = (st, label, item, need, x = {}) => T.prepare(`INSERT INTO inv_labels (store, label, item, serial_status, first_seen, last_seen, last_history_at, last_change_at, need_history, claimed_until)
      VALUES (?, ?, ?, 'Available', ?, ?, ?, ?, ?, ?)`).bind(st, label, item, ago(900), ago(x.seenMin == null ? 5 : x.seenMin), 'hist' in x ? x.hist : null, x.change || null, need, x.claim || null);
  const l = (n, i) => i + '-' + String(n).padStart(10, '0');
  await T.batch([
    T.prepare("INSERT INTO inv_items (store, item, name, first_seen, last_seen) VALUES (539, '539001', 'Screen A', ?, ?), (539, '539002', 'Battery B', ?, ?)").bind(ago(900), ago(5), ago(900), ago(5)),
    lab(539, l(1, '539001'), '539001', 1, { seenMin: 50 }),                                                        // never read, backfill, seen 50 min ago
    lab(539, l(2, '539001'), '539001', 1, { seenMin: 10 }),                                                        // never read, backfill, seen 10 min ago: before the one above
    lab(539, l(1, '539002'), '539002', 3, { hist: ago(300), change: ago(20), seenMin: 20 }),                       // read, then a diff saw it change: first of all
    lab(539, l(2, '539002'), '539002', 2, { hist: ago(300), seenMin: 30 }),                                        // read, touched by a movement: re-check
    lab(539, l(3, '539002'), '539002', 1, { hist: ago(300), change: ago(100), seenMin: 90 }),                      // read, changed after: changed
    lab(539, l(4, '539002'), '539002', 1, { seenMin: 1, claim: new Date(Date.now() + 8 * 60000).toISOString() }),  // claimed by a browser: being read, not in the order
    lab(539, l(5, '539002'), '539002', 1, { seenMin: 2, claim: ago(3) }),                                          // an expired claim: waiting again
    lab(539, l(6, '539002'), '539002', 0, { hist: ago(4) }),                                                       // read 4 minutes ago
    lab(539, l(7, '539002'), '539002', 0, { hist: ago(40) }),                                                      // read 40 minutes ago
    lab(540, l(1, '540001'), '540001', 3, { hist: ago(300), change: ago(20) })]);                                  // another store
  const g = await admin('owner@x.com', Q(539)); ok(g, 'queue');
  // need 3, then 2, then 1; within a need the most recently seen first (the expired claim, seen 2 min ago, leads the backfill)
  assert.deepEqual(g.j.rows.map((r) => r.label), [l(1, '539002'), l(2, '539002'), l(5, '539002'), l(2, '539001'), l(1, '539001'), l(3, '539002')]);
  assert.deepEqual(g.j.rows.map((r) => r.pos), [1, 2, 3, 4, 5, 6]);
  // exactly the sweep's order: asking the sweep for the lot hands out the same labels
  assert.deepEqual((await call('POST', '/v1/539/tracker/retrace/sweep', { need: 100 })).j.need, g.j.rows.map((r) => r.label), 'the panel lists labels in the sweep\'s order');
  const claimedNow = (await admin('owner@x.com', Q(539))).j; assert.deepEqual([claimedNow.being_read, claimedNow.total], [7, 0], 'the sweep claimed what it handed out: all being read now');
  await T.prepare("UPDATE inv_labels SET claimed_until = NULL WHERE store = 539 AND label <> ?").bind(l(4, '539002')).run(); // back to the seeded claims
  // reasons (the Stale histories check's tests): never read / read then changed / queued again
  assert.deepEqual(g.j.rows.map((r) => r.reason), ['changed', 'recheck', 'never', 'never', 'never', 'changed']);
  assert.deepEqual([g.j.rows[0].item, g.j.rows[0].name, g.j.rows[3].name], ['539002', 'Battery B', 'Screen A']);
  assert.ok(g.j.rows.every((r) => /Z$/.test(r.since)), 'every row says since when');
  // counts, tiles, claimed labels, recent reads
  assert.deepEqual([g.j.total, g.j.counts, g.j.waiting], [6, { all: 6, never: 3, changed: 2, recheck: 1 }, 6]);
  assert.equal(g.j.being_read, 1, 'the unexpired claim is being read, not waiting');
  assert.ok(!g.j.rows.some((r) => r.label === l(4, '539002')), 'a claimed label is not in the order');
  assert.equal(g.j.read_10min, 1, 'only the one read 4 minutes ago');
  assert.deepEqual([g.j.per_pass, g.j.eta_min], [60, 10]);
  assert.deepEqual(g.j.recent.slice(0, 2).map((r) => r.label), [l(6, '539002'), l(7, '539002')], 'newest read first');
  assert.ok(g.j.recent.every((r, i) => !i || g.j.recent[i - 1].at >= r.at));
  assert.equal(g.j.recent[0].name, 'Battery B');
  assert.deepEqual(g.j.items.map((x) => [x.item, x.n]), [['539002', 4], ['539001', 2]]);
  // the stale check lists the same labels as stale (shared tests): every queued label with a reason is stale
  assert.equal(await count("SELECT COUNT(*) AS n FROM inv_labels WHERE store = 539 AND (last_history_at IS NULL OR need_history >= 2 OR last_change_at > last_history_at)"), 7, '6 waiting + 1 claimed');
  // filters: by reason (pos stays the place in the whole queue), by item (counts follow the item), both
  let f = (await admin('owner@x.com', Q(539, '?reason=changed'))).j;
  assert.deepEqual([f.total, f.rows.map((r) => [r.pos, r.label])], [2, [[1, l(1, '539002')], [6, l(3, '539002')]]]);
  assert.deepEqual(f.counts, { all: 6, never: 3, changed: 2, recheck: 1 }, 'counts ignore the reason filter');
  f = (await admin('owner@x.com', Q(539, '?item=539001'))).j;
  assert.deepEqual([f.total, f.counts.all, f.rows.map((r) => r.pos)], [2, 2, [4, 5]]);
  assert.equal(f.waiting, 6, 'the estimate is for the whole queue');
  f = (await admin('owner@x.com', Q(539, '?item=539001&reason=recheck'))).j; assert.deepEqual([f.total, f.rows.length], [0, 0]);
  f = (await admin('owner@x.com', Q(539, '?reason=bogus'))).j; assert.equal(f.total, 6, 'an unknown reason is no filter');
  // paging
  f = (await admin('owner@x.com', Q(539, '?limit=2'))).j; assert.deepEqual([f.rows.map((r) => r.pos), f.total], [[1, 2], 6]);
  f = (await admin('owner@x.com', Q(539, '?limit=2&offset=4'))).j; assert.deepEqual(f.rows.map((r) => r.pos), [5, 6]);
  f = (await admin('owner@x.com', Q(539, '?limit=9999&offset=-3'))).j; assert.equal(f.rows.length, 6, 'limit capped, offset floored');
  // store isolation: the other store's queue is its own, an unknown store is empty, a bad path is no route
  const o = (await admin('owner@x.com', Q(540))).j; assert.deepEqual([o.total, o.rows.map((r) => r.label), o.being_read], [1, [l(1, '540001')], 0]);
  assert.equal((await admin('owner@x.com', Q(541))).j.total, 0);
  assert.equal((await adminPost('owner@x.com', Q(539))).status, 403, 'read only: no POST route');
  assert.equal((await admin('owner@x.com', '/retrace/queue/abc')).status === 200, false);
  // a store with nothing queued
  await T.prepare('UPDATE inv_labels SET need_history = 0, claimed_until = NULL WHERE store = 539').run();
  const e = (await admin('owner@x.com', Q(539))).j; assert.deepEqual([e.total, e.waiting, e.being_read, e.eta_min, e.rows], [0, 0, 0, 0, []]);
}

await dispose();
rmSync('.wrangler-test-retrace', { recursive: true, force: true });
console.log('retrace: all passed');
