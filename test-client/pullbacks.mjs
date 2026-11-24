// Elusive Jump (src/66-pullbacks.js): the .xlsx reader/writer, the list rules, the Portal mark calls, and the shard's answers to
// the phone's messages (Linkshell) with the page as it should be and paused. Fake data only.
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

// The scan order (Linkpearl's PullbacksTest.scanOrder holds the same list).
const ORDER_IN = [
  'iPhone 12 Back Camera (Non OEM)', 'iPhone 11 Charging Port Flex, Black (Non OEM)', 'Galaxy S22 - 128GB - Black - Renewed 2',
  'iPhone 11 Pro Glass/LCD, Select LCD Non OEM', 'iPad Air 2 Battery (Non-OEM)', 'iPhone 6 Glass/ LCD, White, Select Non-OEM',
  'iPhone 12 Wifi Flex', 'iPhone 13 Ear Speaker Sensor Flex', 'Samsung Galaxy S23 Ultra Back Glass, Lavender, GH97-28420D',
  'iPhone 7 Proximity Sensor/Front Camera/Front Mic Flex (Non OEM)', 'iPhone 7 Dock Connector Flex, Black', 'iPhone 11 Front Camera (Non OEM)',
];
const ORDER_OUT = [
  'iPhone 6 Glass/ LCD, White, Select Non-OEM', 'iPhone 11 Pro Glass/LCD, Select LCD Non OEM', 'iPad Air 2 Battery (Non-OEM)',
  'iPhone 7 Dock Connector Flex, Black', 'iPhone 11 Charging Port Flex, Black (Non OEM)', 'iPhone 11 Front Camera (Non OEM)',
  'iPhone 12 Back Camera (Non OEM)', 'iPhone 13 Ear Speaker Sensor Flex', 'iPhone 7 Proximity Sensor/Front Camera/Front Mic Flex (Non OEM)',
  'iPhone 12 Wifi Flex', 'Samsung Galaxy S23 Ultra Back Glass, Lavender, GH97-28420D', 'Galaxy S22 - 128GB - Black - Renewed 2',
];
await test('scan order: part type, then description in natural order, then SKU and serial', async () => {
  const items = ORDER_IN.map((d, i) => ({ store: 'S #1', sku: 100 + i, description: d, serial: 'X-' + i }));
  assert.deepEqual(P.forStore(items, 'S #1').map((x) => x.description), ORDER_OUT);
  const same = [{ store: 'S #1', sku: 2, description: 'iPhone 11 Battery', serial: 'B' }, { store: 'S #1', sku: 2, description: 'iPhone 11 Battery', serial: 'A' },
    { store: 'S #1', sku: 1, description: 'iPhone 11 Battery', serial: 'C' }];
  assert.deepEqual(P.forStore(same, 'S #1').map((x) => x.serial), ['C', 'A', 'B']);
  assert.equal(P.category('iPhone 16 Front Camera Module With Flex (Non OEM)'), 'cameras');
  assert.equal(P.category('Something else'), 'other');
});

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

// ---- the shard itself: the phone's messages against a saved session (the dialog closed)
async function shard() {
  const defs = [], handlers = {}, sent = [], lists = [], portal = [], gm = new Map(), page = { why: '', asked: 0, waits: [] };
  const A = {
    async timedFetch(method, url) { portal.push([method, url]); return { res: { status: 200 }, text: '{"Success":true}' }; },
    shard: (d) => defs.push(d), h: () => ({}), actionIcon: () => '', onDom() {}, every() {}, settings: { crystals: {} },
    linkshell: { on: (k, fn) => { handlers[k] = fn; }, send: (k, b) => { sent.push([k, plain(b)]); return 'id'; }, sendParts: (...a) => { lists.push(plain(a)); }, linked: () => ({ store: 900 }),
      paused: async () => { page.asked++; await new Promise((r) => setTimeout(r, page.waits.shift() || 0)); return page.why; } },
  };
  vm.runInContext(fs.readFileSync(new URL('../src/66-pullbacks.js', import.meta.url), 'utf8'), vm.createContext({ AE: A, TextEncoder, TextDecoder, DecompressionStream, Response, Blob, console,
    document: { head: { append() {} } }, GM_getValue: (k, d) => (gm.has(k) ? plain(gm.get(k)) : d), GM_setValue: (k, v) => gm.set(k, plain(v)), GM_deleteValue: (k) => gm.delete(k) }));
  defs[0].run();
  const parsed = A.pullbacks.parse(await A.pullbacks.readXlsx(A.pullbacks.writeXlsx(exportRows, [], 'Export')));
  const items = A.pullbacks.forStore(parsed.items, 'Test Store #900'); // serials s-1, S-2
  gm.set('ae_pullback_session', { file: 'Pullback Serials.xlsx', store: 'Test Store #900', storeId: '900', headers: parsed.headers, items, idx: 0, history: [], last: null, phone: 'run1' });
  return { handlers, sent, lists, portal, page, session: () => gm.get('ae_pullback_session') };
}

await test('phone: a scan away from the scan screen is kept in the session and answered queued; the list goes through sendParts', async () => {
  const s = await shard();
  await s.handlers['pullbacks.scan']({ run: 'run1', i: 0, serial: 'S-1' });
  assert.equal(s.session().items[0].status, 'matched');
  assert.deepEqual(s.sent, [['pullbacks.result', { run: 'run1', i: 0, state: 'queued' }]]);
  await s.handlers['pullbacks.join']({ run: 'run1' });
  assert.deepEqual(s.lists, [['pullbacks.run', { run: 'run1', file: 'Pullback Serials.xlsx', store: '900' },
    [[0, '100001', 'iPad 11" Glass & LCD', 's-1', 'queued'], [1, '100002', 'Phone B Screen', 'S-2', 'pending']], { size: 40 }]]);
  assert.equal(s.portal.length, 0, 'nothing sent to Portal with the dialog closed');
});

await test('phone: paused on the PC, a scan is answered failed and a skip or undo with the state unchanged; the session is not touched', async () => {
  const s = await shard();
  await s.handlers['pullbacks.scan']({ run: 'run1', i: 0, serial: 'S-1' }); // before the pause: queued
  const before = s.session();
  s.page.why = 'Aethernet is paused on the PC';
  s.sent.length = 0;
  await s.handlers['pullbacks.scan']({ run: 'run1', i: 1, serial: 'S-2' });
  await s.handlers['pullbacks.skip']({ run: 'run1', i: 1 });
  await s.handlers['pullbacks.undo']({ run: 'run1', i: 0 });
  await s.handlers['pullbacks.scan']({ run: 'run1', i: 0, serial: 'S-1' }); // already scanned here: its state, not a failure
  const why = 'Aethernet is paused on the PC';
  assert.deepEqual(s.sent, [
    ['pullbacks.result', { run: 'run1', i: 1, state: 'failed', message: why }],
    ['pullbacks.result', { run: 'run1', i: 1, state: 'pending', message: why }],
    ['pullbacks.result', { run: 'run1', i: 0, state: 'queued', message: why }],
    ['pullbacks.result', { run: 'run1', i: 0, state: 'queued', message: why }],
  ]);
  assert.deepEqual(s.session(), before);
  assert.equal(s.portal.length, 0);
  // the list can still be asked for, without asking about the page
  const asked = s.page.asked;
  await s.handlers['pullbacks.join']({ run: 'run1' });
  assert.equal(s.lists.length, 1); assert.equal(s.page.asked, asked);
  // a message for another run is ignored
  await s.handlers['pullbacks.scan']({ run: 'other', i: 1, serial: 'S-2' });
  assert.equal(s.sent.length, 4); assert.equal(s.page.asked, asked, 'and the page is not asked about for it');
});

await test('phone: messages are handled in the order they came, however long each check of the page takes', async () => {
  const s = await shard();
  s.page.waits = [30, 1]; // the first check answers after the second would have
  const L = s.handlers;
  const a = L['pullbacks.skip']({ run: 'run1', i: 1 }), b = L['pullbacks.undo']({ run: 'run1', i: 1 });
  await Promise.all([a, b]);
  assert.deepEqual(s.sent.map((x) => x[1].state), ['skipped', 'pending']);
  assert.equal(s.session().items[1].status, 'pending');
});

console.log(n + ' passed');
