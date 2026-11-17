// Elusive Jump (src/66-pullbacks.js): the .xlsx reader/writer, the list rules and the Portal mark calls. Fake data only.
// node test-client/pullbacks.mjs
import fs from 'fs';
import vm from 'vm';
import strict from 'assert/strict';

// Values from the vm context are another realm's arrays/objects: compare as plain JSON.
const plain = (x) => JSON.parse(JSON.stringify(x));
const assert = Object.assign((...a) => strict(...a), strict, { deepEqual: (a, b, m) => strict.deepEqual(plain(a), plain(b), m) });

const calls = [];
let answer = () => ({ res: { status: 200 }, text: '{"Success":true}' });
const AE = { shard() {}, signedOut() { calls.push('signedOut'); }, async timedFetch(method, url, init) { calls.push([method, url, init.body || null]); return answer(method, url); } };
vm.runInContext(fs.readFileSync(new URL('../src/66-pullbacks.js', import.meta.url), 'utf8'),
  vm.createContext({ AE, TextEncoder, TextDecoder, DecompressionStream, Response, Blob }));
const P = AE.pullbacks;
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok', name); };

// A PowerBI-style export: a filter row and a blank row above the header, a qualified Serial header, entities, Total + filter rows.
const exportRows = [
  ['Applied filters: owner is Someone'], [],
  ['Store', 'SKU', 'Description', "'Unique Serials'[Serial]", 'Return Units', 'Return Value', 'Consignment Status'],
  ['Test Store #900', 100002, 'Phone B Screen', 'S-2', 1, 12.5, 1],
  ['Test Store #900', 100001, 'iPad 11&quot; Glass &amp; LCD', 's-1', 1, 40, 1],
  ['Other Store #901', 100003, 'Phone C Battery', 'S-3', 1, 3.25, 0],
  ['Test Store #900', 100004, 'No serial', null, 1, 1, 1],
  ['Total', null, null, null, 3, 55.75, 2],
];

await test('xlsx round trip keeps strings, numbers and blanks', async () => {
  const bytes = P.writeXlsx([['A', 'B', 'C'], ['x & <y>', 12.422999999999998, null], [true, 0, 'z']], [null, 'ok'], 'S');
  const rows = await P.readXlsx(bytes);
  assert.deepEqual(rows, [['A', 'B', 'C'], ['x & <y>', 12.422999999999998], [true, 0, 'z']]);
});

await test('export: header found below filter rows, entities decoded, rows without serial dropped, sorted by description', async () => {
  const p = P.parse(await P.readXlsx(P.writeXlsx(exportRows, [], 'Export')));
  assert.equal(p.kind, 'export');
  assert.deepEqual(P.stores(p.items), [{ store: 'Test Store #900', n: 2 }, { store: 'Other Store #901', n: 1 }]);
  const mine = P.forStore(p.items, 'Test Store #900');
  assert.deepEqual(mine.map((i) => i.description), ['iPad 11" Glass & LCD', 'Phone B Screen']);
  assert.equal(mine[0].status, 'pending');
  assert.equal(P.storeNum('Test Store #900'), '900');
});

await test('results file: script layout, fills, and read back as results with unmarked items', async () => {
  const p = P.parse(await P.readXlsx(P.writeXlsx(exportRows, [], 'Export')));
  const items = P.forStore(p.items, 'Test Store #900');
  Object.assign(items[0], { status: 'matched', scanned_serial: 'S-1', match: 'YES', scanned_at: '2026-11-16T15:00:00' });
  items[1].status = 'skipped';
  const back = await P.readXlsx(P.results(p.headers, items));
  assert.deepEqual(back[0], ['Store', 'SKU', 'Description', "'Unique Serials'[Serial]", 'Return Units', 'Return Value', 'Consignment Status',
    'Scanned Serial', 'Match', 'Status', 'Scanned At', 'Backend Status', 'Backend Message', 'Backend At']);
  assert.equal(back[1][3], 's-1'); // the qualified Serial column is filled
  const again = P.parse(back);
  assert.equal(again.kind, 'results');
  assert.equal(again.items[0].serial, 's-1');
  assert.equal(again.items.filter(P.unmarked).length, 1);
  assert.deepEqual(P.fillOf(items[0]), 'ok');
  assert.deepEqual(P.fillOf(items[1]), 'warn');
  assert.equal(P.fileName('Pullback Serials.xlsx', 'Test Store #900'), 'Pullback Serials - 900 - Scan Results.xlsx');
  assert.equal(P.fileName('Pullback Serials - 900 - Scan Results.xlsx', 'Test Store #900'), 'Pullback Serials - 900 - Scan Results.xlsx');
});

await test('csv export reads like xlsx', async () => {
  const p = P.parse(P.readCsv('Store,SKU,Description,Serial\r\n"Test Store #900",1,"A, b",S-9\r\n'));
  assert.equal(p.items[0].description, 'A, b');
  assert.equal(p.items[0].serial, 'S-9');
});

await test('mark: request as scan_serials.py sends it', async () => {
  calls.length = 0;
  assert.deepEqual(await P.mark(100001, 'S-1', '900'), { ok: true, message: 'confirmed' });
  assert.deepEqual(calls, [['POST', '/api/boh/inventory/S-1/mark-defective-broken', JSON.stringify({ serial: 'S-1', reasonCode: 'OEM Slow Moving Parts', reasonDetails: 'Pullback', brokenBy: '' })]]);
});

await test('mark: a 500 for an item already marked counts as done', async () => {
  calls.length = 0;
  answer = (m, url) => (url.includes('mark-') ? { res: { status: 500 }, text: '' } : { res: { status: 200 }, text: JSON.stringify({ value: [{ SerialNumber: 's-1', SerialStatus: 'NonDefectiveRMA' }] }) });
  const r = await P.mark(100001, 'S-1', '900');
  assert.equal(r.ok, true); assert.equal(r.already, true);
  assert.equal(calls[1][1], '/api/boh/store-products/100001/inventory?pageSize=20&page=1&searchTerm=S-1&warehouseId=900Q');
});

await test('mark: other answers fail', async () => {
  answer = (m, url) => (url.includes('mark-') ? { res: { status: 500 }, text: '' } : { res: { status: 200 }, text: JSON.stringify({ value: [{ SerialNumber: 'S-1', SerialStatus: 'Available' }] }) });
  assert.equal((await P.mark(1, 'S-1', '900')).ok, false);
  answer = () => ({ res: { status: 200 }, text: '{"Success":false,"ErrorMessage":"nope"}' });
  assert.equal((await P.mark(1, 'S-1', '900')).message, 'backend reported failure: nope');
  answer = () => ({ res: { status: 200 }, text: '<!doctype html><html>' });
  assert.equal((await P.mark(1, 'S-1', '900')).ok, false);
  calls.length = 0;
  answer = () => ({ res: { status: 401 }, text: '' });
  assert.match((await P.mark(1, 'S-1', '900')).message, /session expired/);
  assert.ok(calls.includes('signedOut'));
});

console.log(n + ' passed');
