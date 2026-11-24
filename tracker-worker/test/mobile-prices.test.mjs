// Linkpearl phone API, prices (/v1/agents/m/prices): the server port of the userscript's Price sheet matching (src/23-price-sheet.js), checked against the
// userscript's own code run in a vm on the same sheet; the device list, matches and repairs; store access; a store with no sheet; a new sync replacing the
// cached one. The sheet is invented (test/fixtures/prices/price-sheet.json: no real sample exists, so its columns follow the parser's own regexes).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { setup } from './mobile-helpers.mjs';
import { toks, num, indexSheet, pricesFor, repairsOf, REPAIRS } from '../src/mobile-prices.js';
import { test } from 'node:test';

const SHEET = JSON.parse(readFileSync(new URL('./fixtures/prices/price-sheet.json', import.meta.url), 'utf8'));
const P = '/v1/agents/m/prices';

let client;
await test("the userscript's code, as it runs in the browser", async () => {
  // ---- the userscript's code, as it runs in the browser (AE.priceSheet), for a side-by-side check
  const sandbox = { AE: {} };
  vm.runInNewContext(readFileSync(new URL('../../src/23-price-sheet.js', import.meta.url), 'utf8'), sandbox);
  const vmc = sandbox.AE.priceSheet, plain = (v) => JSON.parse(JSON.stringify(v)); // the vm's arrays come from another realm
  client = { num: vmc.num, repairPrices: vmc.repairPrices, pricesFor: (d, p) => plain(vmc.pricesFor(d, p)), repairPricesPlain: (d, r, p) => plain(vmc.repairPrices(d, r, p)) };
  assert.equal(typeof client.repairPrices, 'function', 'loaded src/23-price-sheet.js');
});

let idx, devices;
await test('unit: tokens, numbers, exact model matching', async () => {
  assert.deepEqual(toks('Apple iPhone 15 Pro Max (A2849)'), ['iphone', '15', 'pro', 'max']);
  assert.deepEqual(toks('Galaxy S23+ 5G'), ['s23', 'plus']);
  for (const [raw, n] of [['$129.99', 129.99], ['$190 (MS)', 190], ['N/A', null], ['NA', null], ['Apple self repair', null], ['-', null], ['', null], ['call', null]]) {
    assert.equal(num(raw), n, raw); assert.equal(client.num(raw), n, 'client ' + raw);
  }
  ({ idx, devices } = indexSheet(SHEET));
  const rowsOf = (d) => (pricesFor(d, idx) || []).map((r) => r.tab + ':' + r.name);
  assert.deepEqual(rowsOf('iPhone 15 Pro Max'), ['Apple:iPhone 15 Pro Max']);
  assert.deepEqual(rowsOf('iPhone 15 Pro'), ['Apple:iPhone 15 Pro'], '"15 Pro" is not "15 Pro Max"');
  assert.deepEqual(rowsOf('iPhone 15'), ['Apple:iPhone 15'], 'Refurb tab is never quoted from');
  assert.deepEqual(rowsOf('Apple iPhone 15 Pro Max 256GB'), ['Apple:iPhone 15 Pro Max'], 'extra words after the model');
  assert.deepEqual(rowsOf('iPhone 15 Ultra'), [], 'a qualifier the row does not have');
  assert.deepEqual(rowsOf('iPhone 6S'), ['Apple:iPhone 6/6S']); assert.deepEqual(rowsOf('iPhone 6'), ['Apple:iPhone 6/6S'], 'a/b rows answer for both');
  assert.deepEqual(rowsOf('Galaxy Z Fold 5'), ['Samsung:Galaxy Z Fold 5 Inner', 'Samsung:Galaxy Z Fold 5 Outer'], 'Inner/Outer: variants of one device');
  assert.deepEqual(rowsOf('iPhone 14 Plus'), ['Apple:iPhone 14 Plus      inform customer: 2-3 day part'], 'a note after the name is not part of it');
  assert.deepEqual(rowsOf('iPhone 13'), [], 'only on the Refurb tab'); assert.deepEqual(rowsOf('Galaxy S10'), [], 'only on BER');
  assert.deepEqual(rowsOf(''), []); assert.deepEqual(rowsOf('Switch'), []);
});

await test('side by side with the userscript', async () => {
  // ---- side by side with the userscript: same rows, and the same prices for every repair type (Reassemble's repairPrices)
  const QUERIES = ['iPhone 15 Pro Max', 'iPhone 15 Pro', 'iPhone 15', 'iPhone 15 Ultra', 'iPhone 6', 'iPhone 6S', 'iPhone 14 Plus', 'iPhone 13', 'Galaxy S23 Ultra', 'Samsung Galaxy S23',
    'Galaxy S23 FE', 'Galaxy Z Fold 5', 'Pixel 8 Pro', 'Google Pixel 8', 'iPad 9th Gen', 'Sony PS5', 'Nintendo Switch OLED', 'Switch', 'Galaxy S10', 'nothing at all'];
  const label = (variant, l) => (variant ? variant[0].toUpperCase() + variant.slice(1) + ' ' : '') + l;
  const norm = (list) => list.map((x) => [x.tab, x.row, x.label, x.price].join('|')).sort();
  for (const q of QUERIES) {
    const mine = pricesFor(q, idx), theirs = client.pricesFor(q, SHEET);
    assert.deepEqual(mine ? mine.map((r) => r.name) : null, theirs ? theirs.map((r) => r.name) : null, 'rows ' + q);
    for (const repair of ['Screen', 'Battery', 'Charge port', 'Back glass', 'Other']) {
      const want = client.repairPricesPlain(q, repair, SHEET).prices;
      const got = (mine || []).flatMap((r) => repairsOf(r.cells).filter((x) => x.price != null && (repair === 'Other' || x.repair === repair))
        .map((x) => ({ tab: r.tab, row: r.name, label: label(r.variant, x.label), price: x.price })));
      assert.deepEqual(norm(got), norm(want), q + ' / ' + repair);
    }
  }
});

await test('repairs of one row', async () => {
  // ---- repairs of one row: the four types first (priced or not), then the other priced columns, Notes left out
  assert.deepEqual(repairsOf(SHEET.tabs[0].rows[1].cells), [
    { repair: 'Screen', label: 'Screen', price: 329.99, raw: '$329.99' }, { repair: 'Screen', label: 'OEM', price: null, raw: 'N/A' },
    { repair: 'Battery', label: 'Battery', price: null, raw: 'Apple self repair' }, { repair: 'Charge port', label: 'Charging Port', price: 149.99, raw: '$149.99' },
    { repair: 'Back glass', label: 'Back Glass', price: 190, raw: '$190 (MS)' }]);
  assert.deepEqual(repairsOf(SHEET.tabs[0].rows[0].cells).map((x) => x.repair + ':' + x.label), ['Screen:Screen', 'Screen:OEM', 'Battery:Battery', 'Charge port:Charging Port',
    'Back glass:Back Glass', 'Back Camera:Back Camera', 'Camera Lens:Camera Lens'], 'Back Camera is not a screen; Notes left out');
  assert.deepEqual(repairsOf(SHEET.tabs[4].rows[0].cells).map((x) => x.repair), ['HDMI / RETIMER', 'HDD 500GB', 'Disc Drive'], 'console: unpriced other columns left out');
  assert.deepEqual(REPAIRS.map(([r]) => r), ['Screen', 'Battery', 'Charge port', 'Back glass']);
  assert.deepEqual(repairsOf(null), []);
});

await test('the device list', async () => {
  assert.deepEqual(devices.map((d) => d.key), ['iphone15promax', 'iphone15pro', 'iphone15', 'iphone6', 'iphone6s', 'iphone14plus', 's23ultra', 's23', 'zfold5', 'pixel8pro', 'ipad9thgen', 'ps5', 'switcholed']);
  assert.deepEqual(devices.filter((d) => /iphone6|zfold|14plus|ipad/.test(d.key)), [
    { key: 'iphone6', name: 'iPhone 6', tab: 'Apple' }, { key: 'iphone6s', name: 'iPhone 6S', tab: 'Apple' }, { key: 'iphone14plus', name: 'iPhone 14 Plus', tab: 'Apple' },
    { key: 'zfold5', name: 'Galaxy Z Fold 5', tab: 'Samsung' }, { key: 'ipad9thgen', name: 'iPad 9th Gen (10.2)', tab: 'ipad' }]);
  for (const d of devices) assert.ok(pricesFor(d.key, idx), 'a key is a query that finds its device: ' + d.key);
  for (const d of devices) assert.ok(pricesFor(d.name, idx), 'so is its name: ' + d.name);
  assert.deepEqual(indexSheet(null).devices, []); assert.deepEqual(indexSheet({ tabs: 'x' }).devices, []); assert.deepEqual(indexSheet({ tabs: [{ name: 'Apple', rows: [null, { name: 'iPhone 9' }] }] }).devices, [{ key: 'iphone9', name: 'iPhone 9', tab: 'Apple' }]);
});

// ---- the route
const T = await setup('.wrangler-test-mobile-prices');
const { env, authed, registerPhone, approve } = T;
const phone = await registerPhone('Pixel'); await approve(phone, [914, 326]);

let r;
await test('before the sheets table exists', async () => {
  // before the sheets table exists (a fresh local database): nothing listed, not an error
  r = await authed(phone, P + '?store=914');
  assert.equal(r.status, 200); assert.deepEqual(r.j, { store: 914, syncedAt: null, devices: [] });
  // the same table the Aethernet Worker keeps (worker/schema.sql), with the sync job's row for 914
  await env.AE.prepare('CREATE TABLE IF NOT EXISTS sheets (store INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, synced_at TEXT NOT NULL, PRIMARY KEY (store, kind))').run();
  await env.AE.prepare("INSERT INTO sheets (store, kind, data, synced_at) VALUES (914, 'prices', ?, '2026-11-14T13:00:00.000Z'), (914, 'leads', '{\"x\":1}', '2026-11-14T13:00:00.000Z'), (536, 'prices', ?, '2026-11-14T13:00:00.000Z')")
    .bind(JSON.stringify(SHEET), JSON.stringify(SHEET)).run();

  r = await authed(phone, P + '?store=914');
  assert.equal(r.status, 200); assert.equal(r.h.get('cache-control'), 'no-store');
  assert.deepEqual(Object.keys(r.j), ['store', 'syncedAt', 'devices']);
  assert.equal(r.j.syncedAt, '2026-11-14T13:00:00.000Z'); assert.deepEqual(r.j.devices, devices);
  assert.ok(JSON.stringify(r.j).length < 1200, 'small');
  console.log('list', JSON.stringify(r.j).slice(0, 300) + '…');

  r = await authed(phone, P + '?store=914&q=' + encodeURIComponent('Apple iPhone 15 Pro'));
  assert.equal(r.status, 200); assert.deepEqual(Object.keys(r.j), ['store', 'syncedAt', 'matches']);
  assert.deepEqual(r.j.matches, [{ name: 'iPhone 15 Pro', tab: 'Apple', variant: null, repairs: repairsOf(SHEET.tabs[0].rows[1].cells) }]);
  console.log('match', JSON.stringify(r.j));
  r = await authed(phone, P + '?store=914&q=zfold5');
  assert.deepEqual(r.j.matches.map((m) => [m.name, m.variant, m.repairs.map((x) => x.repair + ' ' + x.price).join(', ')]), [
    ['Galaxy Z Fold 5 Inner', 'inner', 'Screen 549.99, Battery 129.99'], ['Galaxy Z Fold 5 Outer', 'outer', 'Screen 219.99']], 'by key, both variants');
  console.log('variants', JSON.stringify(r.j));
  assert.deepEqual((await authed(phone, P + '?store=914&q=iPhone%2013')).j, { store: 914, syncedAt: '2026-11-14T13:00:00.000Z', matches: [] }, 'not on a retail tab');
  assert.deepEqual((await authed(phone, P + '?store=914&q=%20%20')).j.devices.length, devices.length, 'a blank q is the list');
  assert.equal((await authed(phone, P + '?store=914&q=' + 'x'.repeat(5000))).status, 200, 'long q is cut, not an error');
});

await test('other stores', async () => {
  // other stores: no sheet (326), not approved (536, even though it has one), malformed
  assert.deepEqual((await authed(phone, P + '?store=326')).j, { store: 326, syncedAt: null, devices: [] });
  assert.deepEqual((await authed(phone, P + '?store=326&q=iPhone%2015')).j, { store: 326, syncedAt: null, matches: [] });
  for (const [q, s] of [['?store=536', 403], ['?store=536&q=iPhone%2015', 403], ['', 400], ['?store=abc', 400], ['?store=9149149', 400]]) assert.equal((await authed(phone, P + q)).status, s, q);
  assert.equal((await authed(phone, P + '?store=914', { method: 'POST', body: {} })).status, 405);
  assert.equal((await authed(phone, P + '/914')).status, 404);
  assert.equal((await authed(null, P + '?store=914')).status, 401);
  const pending = await registerPhone('Waiting'); assert.equal((await authed(pending, P + '?store=914')).status, 403);
});

await test('a new sync replaces what was read before', async () => {
  // a new sync replaces what was read before (the parsed sheet is cached until synced_at changes)
  const NEXT = JSON.parse(JSON.stringify(SHEET)); NEXT.tabs[0].rows[1].cells['Screen Repair'] = '$319.99';
  await env.AE.prepare("UPDATE sheets SET data = ?, synced_at = '2026-11-15T13:00:00.000Z' WHERE store = 914 AND kind = 'prices'").bind(JSON.stringify(NEXT)).run();
  r = await authed(phone, P + '?store=914&q=iPhone%2015%20Pro');
  assert.equal(r.j.syncedAt, '2026-11-15T13:00:00.000Z'); assert.equal(r.j.matches[0].repairs[0].price, 319.99);
  // a broken row reads as an empty sheet, never a 500
  await env.AE.prepare("UPDATE sheets SET data = 'not json', synced_at = '2026-11-16T13:00:00.000Z' WHERE store = 914 AND kind = 'prices'").run();
  assert.deepEqual((await authed(phone, P + '?store=914')).j, { store: 914, syncedAt: '2026-11-16T13:00:00.000Z', devices: [] });
  await env.AE.prepare("DELETE FROM sheets WHERE store = 914 AND kind = 'prices'").run();
  assert.deepEqual((await authed(phone, P + '?store=914')).j, { store: 914, syncedAt: null, devices: [] }, 'sheet removed');
});

await T.dispose();
