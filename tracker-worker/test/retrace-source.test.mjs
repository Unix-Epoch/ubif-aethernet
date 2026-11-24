// Item source (Nov 24, 2026): Distro / MS / Other per item number (src/retrace-source.js). The rules on their own, then the sweep
// (labels' Vendor kept, the vendor catch-up list, the refresh and the store's pause), the admin routes and the pause push, on local D1.
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { getPlatformProxy } from 'wrangler';
import worker, { trackerAdmin } from '../src/index.js';
import * as R from '../src/retrace.js';
import { decide, vendorSource, msName, effective, pushPause, refreshSources } from '../src/retrace-source.js';
import { resetCaches } from '../src/retrace-api.js';

const AT = '2026-11-24T12:00:00.000Z';

// ------------------------------------------------------------------ the rules
assert.equal(vendorSource('1'), 'distro'); assert.equal(vendorSource(' 6920 '), 'ms'); assert.equal(vendorSource('4410'), 'other');
assert.equal(vendorSource('Vendor One'), null, 'a name is not an account: says nothing'); assert.equal(vendorSource(''), null); assert.equal(vendorSource(null), null);
assert.ok(msName('iPhone 16 Pro Max Glass/LCD MS')); assert.ok(msName('Back Glass (MS)')); assert.ok(!msName('MSRP sticker')); assert.ok(!msName('Pixel Ms battery'));
{
  const d = (x) => { const r = decide(x); return [r.auto, r.basis, r.conflict]; };
  assert.deepEqual(d({ name: 'Pixel 10 Pro XL Battery', vendors: [{ vendor: '1', n: 4 }] }), ['distro', 'vendor', false]);
  assert.deepEqual(d({ name: 'iPhone 16 Pro Max Glass/LCD MS', vendors: [{ vendor: '6920', n: 2 }] }), ['ms', 'vendor', false]);
  assert.deepEqual(d({ name: 'Joy-Con Rail', vendors: [{ vendor: '4410', n: 1 }] }), ['other', 'vendor', false]);
  assert.deepEqual(d({ name: 'Battery', pos: [{ id: 'P1', distro: true }, { id: 'P2', distro: 1 }] }), ['distro', 'po', false]);
  assert.deepEqual(d({ name: 'Battery', pos: [{ id: 'P1', distro: false, vendor: '6920' }] }), ['ms', 'po', false], 'a non-Distro PO with an MS account');
  assert.deepEqual(d({ name: 'Battery', pos: [{ id: 'P1', distro: false }] }), [null, null, false], 'not Distro, but which: unknown');
  assert.deepEqual(d({ name: 'Glass (MS)', pos: [{ id: 'P1', distro: false }] }), ['ms', 'name', false], 'not-Distro PO agrees with the name');
  assert.deepEqual(d({ name: 'Glass MS' }), ['ms', 'name', false]);
  assert.deepEqual(d({ name: 'Adhesive' }), [null, null, false], 'nothing: Not set');
  assert.deepEqual(d({ name: 'Back Glass', vendors: [{ vendor: '1', n: 3 }, { vendor: '6920', n: 1 }] }), [null, null, true], 'two vendors: conflict');
  assert.deepEqual(d({ name: 'Back Glass', vendors: [{ vendor: '1', n: 3 }], pos: [{ id: 'P1', distro: false }] }), [null, null, true], 'Distro labels, a non-Distro PO');
  assert.deepEqual(d({ name: 'Glass MS', vendors: [{ vendor: '1', n: 1 }] }), [null, null, true], 'Distro labels, an MS name');
  assert.deepEqual(d({ name: 'Battery', vendors: [{ vendor: 'Vendor One', n: 2 }], pos: [{ id: 'P1', distro: true }] }), ['distro', 'po', false], 'a vendor name is ignored');
  const ev = decide({ name: 'Back Glass', vendors: [{ vendor: '1', n: 3 }], pos: [{ id: 'P1', distro: 0, vendor: null }] }).evidence;
  assert.deepEqual(ev, { vendors: [{ vendor: '1', n: 3 }], pos: [{ id: 'P1', distro: false, vendor: null }], ms: false });
}
assert.equal(effective(null), 'unset'); assert.equal(effective({ auto: 'ms' }), 'ms'); assert.equal(effective({ auto: null, conflict: 1 }), 'conflict');
assert.equal(effective({ manual: 'other', conflict: 1 }), 'other', 'by hand wins over a conflict');
// labels: Vendor kept (label details and store-products rows carry the same key)
assert.equal(R.labelSnapshot({ SerialNumber: '688939-0000000663', Vendor: '1' }).vendor, '1');
{
  const live = { $id: '1', ItemNumber: '771985', ProductName: 'iPhone 16 Pro Max Glass/LCD MS', ItemCategory: 'Mobility', ConsignmentStatus: 'No', PurchaseOrderNumber: '', SalesOrderNumber: '',
    SerialStatus: 'Available', ArrivalId: '', WorkOrderId: '', Store: '914', Vendor: '6920', Warehouse: '914', WarehouseLocationType: 'Main', Success: true, ErrorMessage: '', DebugMessage: '' };
  assert.equal(R.detailsSnapshot(live, '771985-0010000003').vendor, '6920', 'label details (captured Nov 24)');
}

// ------------------------------------------------------------------ routes (local D1)
rmSync('.wrangler-test-source', { recursive: true, force: true });
const { env, dispose } = await getPlatformProxy({ configPath: 'wrangler.toml', persist: { path: '.wrangler-test-source' } });
for (const stmt of readFileSync('schema.sql', 'utf8').replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean)) await env.TR.prepare(stmt).run();
// the migration's tables apply on their own too (its ALTER is the column schema.sql already has)
for (const stmt of readFileSync('migrations/2026-11-24-retrace-source.sql', 'utf8').replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter((s) => s && !/^ALTER/i.test(s))) await env.TR.prepare(stmt).run();
await env.AE.prepare('CREATE TABLE IF NOT EXISTS store_access (store INTEGER PRIMARY KEY, name TEXT, added_by TEXT, added_at TEXT)').run();
await env.AE.prepare("INSERT OR IGNORE INTO store_access (store, name) VALUES (914, 'Newport News'), (326, 'Lynnhaven')").run();
const E = Object.assign({}, env, { APP_KEY: 'k', TRACKER_OWNERS: 'owner@x.com', LIMITER: null });
const T = env.TR;
const call = async (method, path, body) => {
  const r = await worker.fetch(new Request('https://t.test' + path, { method, headers: { 'x-aethernet-key': 'k', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), E, {});
  return { status: r.status, j: await r.json() };
};
const admin = async (path) => { resetCaches(); const r = await trackerAdmin(new Request('https://a.test/api/tracker' + path), E, new URL('https://a.test/api/tracker' + path), path.split('?')[0], 'owner@x.com'); return { status: r.status, j: await r.json() }; };
const adminPost = async (path, body, email = 'owner@x.com') => {
  const r = await trackerAdmin(new Request('https://a.test/api/tracker' + path, { method: 'POST', body: JSON.stringify(body || {}) }), E, new URL('https://a.test/api/tracker' + path), path.split('?')[0], email);
  return { status: r.status, j: await r.json() };
};
const ok = (r, what) => assert.ok(r.status < 300, what + ': ' + r.status + ' ' + JSON.stringify(r.j));

const row = (item, name, cat, qty = 2) => ({ ItemNumber: item, ProductName: name, SiteId: '914', WarehouseId: '914', OnHandQuantity: qty, InTransitQuantity: 0, ReservedQuantity: 0, AvailableQuantity: qty, RetailCategory: cat });
const lab = (item, n, vendor) => ({ dataAreaId: 'ubf', SerialNumber: item + '-000000000' + n, ItemNumber: item, OnHandQuantity: 1, WarehouseId: '914', SerialStatus: 'Available', ConsignmentStatus: 'No', Store: '914', ...(vendor === undefined ? {} : { Vendor: vendor }) });
const items = [row('688939', 'Pixel 10 Pro XL Battery', 'Mobility'), row('771985', 'iPhone 16 Pro Max Glass/LCD MS', 'Mobility'), row('770440', 'Switch OLED Joy-Con Rail', 'Mobility'),
  row('770961', 'Pixel 8a Back Glass', 'Mobility'), row('900611', 'Adhesive Strips, Large', 'Reportable Consumables', 140), row('681204', 'iPhone 15 Battery', 'Mobility'),
  row('769012', 'iPhone 14 Pro Glass/LCD MS', 'Mobility'), row('555001', 'Phone case', 'Accessories')];
const labels = [lab('688939', 1, '1'), lab('688939', 2, '1'), lab('771985', 1, '6920'), lab('770440', 1, '4410'), lab('770961', 1, '1'), lab('770961', 2, '6920'), lab('681204', 1)];
const po = { header: { PurchaseOrderNumber: 'UBFPO000000901', IsDistro: true, OrderVendorAccountNumber: '1', PurchaseOrderLinesV2: [{ LineNumber: 1, ItemNumber: '681204', OrderedPurchaseQuantity: 2 }] }, receive: null };

let sw = await call('POST', '/v1/914/tracker/retrace/sweep', { items, labels, pos: [po], vendorNeed: 50, need: 0 });
ok(sw, 'sweep');
assert.equal((await T.prepare("SELECT vendor FROM inv_labels WHERE store = 914 AND label = '688939-0000000001'").first()).vendor, '1', 'label vendor stored');
assert.deepEqual(sw.j.vendorItems, ['681204'], 'catch-up: the in-scope item whose labels carry no vendor');
let v = (await admin('/retrace/sources/914')).j;
assert.deepEqual(v.counts, { all: 7, distro: 2, ms: 2, other: 1, unset: 1, conflict: 1 }, JSON.stringify(v.counts));
const by = Object.fromEntries(v.items.map((x) => [x.item, x]));
assert.deepEqual([by['688939'].source, by['688939'].basis], ['distro', 'vendor']);
assert.deepEqual([by['681204'].source, by['681204'].basis], ['distro', 'po'], 'no vendor yet: its PO');
assert.deepEqual([by['769012'].source, by['769012'].basis], ['ms', 'name']);
assert.equal(by['770440'].source, 'other'); assert.equal(by['770961'].source, 'conflict'); assert.equal(by['900611'].source, 'unset');
assert.ok(!by['555001'], 'accessories are out of scope');
assert.deepEqual(v.items.slice(0, 2).map((x) => x.source), ['conflict', 'unset'], 'unmarked first');
assert.deepEqual([v.pause.paused, v.pause.unmarked, !!v.pause.paused_at], [true, 2, true], 'paused');
assert.equal((await T.prepare('SELECT pushed_at FROM inv_source_pause WHERE store = 914').first()).pushed_at, null, 'no push secret here: nothing sent, nothing recorded');
assert.deepEqual((await admin('/retrace/sources/914?source=unmarked')).j.items.map((x) => x.item), ['770961', '900611']);
assert.equal((await admin('/retrace/sources/914?source=bad')).status, 400);

// the items list and item view carry it
const il = (await admin('/retrace/items?store=914')).j;
assert.ok(il.items.every((x) => x.source === null || typeof x.source === 'string'));
const iv = (await admin('/retrace/item/914/770961')).j;
assert.equal(iv.source.source, 'conflict'); assert.deepEqual(iv.source.evidence.vendors.map((x) => x.vendor).sort(), ['1', '6920']);

// marking by hand: bulk, then a conflict decided, then reset
let s = await adminPost('/retrace/sources/914/set', { items: ['900611'], source: 'other', view: 'unmarked' });
ok(s, 'set'); assert.deepEqual(s.j.items.map((x) => x.item), ['770961']); assert.equal(s.j.pause.unmarked, 1);
s = await adminPost('/retrace/sources/914/set', { items: ['770961'], source: 'distro' });
assert.equal(s.j.pause.paused, false); assert.deepEqual(s.j.stores, [{ store: 914, unmarked: 0, paused: false }]);
assert.equal((await T.prepare('SELECT paused_at FROM inv_source_pause WHERE store = 914').first()).paused_at, null, 'unpaused');
assert.equal((await T.prepare("SELECT manual_by FROM inv_item_source WHERE item = '770961'").first()).manual_by, 'owner@x.com');
s = await adminPost('/retrace/sources/914/set', { items: ['770961'], source: null });
assert.equal(s.j.counts.conflict, 1, 'reset: back to the rules'); assert.equal(s.j.pause.paused, true);
for (const bad of [{ items: [], source: 'ms' }, { items: ['1'], source: 'oem' }, { items: ['1'] }]) assert.equal((await adminPost('/retrace/sources/914/set', bad)).status, 400, JSON.stringify(bad));
assert.equal((await adminPost('/retrace/sources/914/set', { items: ['1'], source: 'ms' }, 'nobody@x.com')).status, 403, 'not someone with the page');

// the sweep's refresh runs at most every 10 minutes: a new vendor shows after that
await T.prepare("UPDATE inv_cursors SET updated_at = '2026-01-01T00:00:00.000Z' WHERE store = 914 AND sweep = 'source_refresh'").run();
sw = await call('POST', '/v1/914/tracker/retrace/sweep', { labels: [lab('681204', 1, '1')], vendorNeed: 50, need: 0 });
assert.deepEqual(sw.j.vendorItems, [], 'caught up');
assert.equal((await admin('/retrace/sources/914')).j.items.find((x) => x.item === '681204').basis, 'vendor');

// the pause push: every approved phone with the store, once
{
  await T.prepare("INSERT INTO agents (id, name, public_jwk, token_hash, status, stores, created_at) VALUES ('a1', 'P1', '{}', 'h', 'active', '[914]', ?), ('a2', 'P2', '{}', 'h', 'active', '[\"326\"]', ?), ('a3', 'P3', '{}', 'h', 'pending', '[914]', ?)").bind(AT, AT, AT).run();
  const got = [];
  const n = await pushPause(E, 914, 2, AT, async (e, id, data, alert) => { got.push([id, data, alert]); return 'sent'; });
  assert.equal(n, 1); assert.equal(got[0][0], 'a1');
  assert.deepEqual([got[0][1].t, got[0][1].kind, got[0][1].store, got[0][1].n], ['retrace', 'source.paused', '914', '2']);
  assert.deepEqual(got[0][2], { title: 'Ordering paused', body: '914 · 2 items not marked' });
  assert.match(got[0][1].id, /^[A-Za-z0-9_-]{8,40}$/, 'an id the phone accepts');
  assert.equal(Object.values(got[0][1]).every((x) => typeof x === 'string'), true, 'FCM data: strings only');
  // a fresh pause (store unpaused, then an item unmarked again) is pushed again, once
  await T.prepare("UPDATE inv_source_pause SET paused_at = NULL, pushed_at = NULL WHERE store = 914").run();
  const r = await refreshSources(T, E, 914, AT);
  assert.equal(r.newlyPaused, true);
  assert.equal((await refreshSources(T, E, 914, AT)).newlyPaused, false, 'still the same pause');
}

// the admin page's code uses these routes
{
  const ui = readFileSync('../admin-worker/src/retrace-ui.js', 'utf8');
  assert.ok(ui.includes("'/tracker/retrace/sources/'"), 'admin page reads the sources');
  assert.ok(ui.includes("/set'"), 'admin page marks items');
}

await dispose();
rmSync('.wrangler-test-source', { recursive: true, force: true });
console.log('retrace-source: all passed');
