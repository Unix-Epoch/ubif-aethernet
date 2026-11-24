// Bountiful Yield (src/45-buybacks.js): Scan with phone's Portal calls (AE.buybacks.addAndScan), and the shard's answer to a
// phone's scan with the page as it should be and paused. Fake data only.
// Answers are shaped like the two calls captured at store 914 on Nov 18, 2026 (keys exact; every value made up).
// node test-client/buybacks.mjs
import fs from 'fs';
import vm from 'vm';
import strict from 'assert/strict';

const plain = (x) => JSON.parse(JSON.stringify(x));
const assert = Object.assign((...a) => strict(...a), strict, { deepEqual: (a, b, m) => strict.deepEqual(plain(a), plain(b), m) });

const AE = { shard() {} };
vm.runInContext(fs.readFileSync(new URL('../src/45-buybacks.js', import.meta.url), 'utf8'), vm.createContext({ AE }));
const B = AE.buybacks;
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok', name); };

const ORDER = '0000000001', LABEL = 'B-100000-0000000001', DISTRO = 'I-0000000001';
const added = { $id: '1', BuybackOrderLines: [{ $id: '2', ItemId: 'BB0001', ItemDescription: 'Buyback', SerialId: LABEL, IsBuyback: 'Yes', Scanned: 'No', Eligible: 'Eligible',
  LineStatus: 'Draft', Destination: 'Test Destination (TLC)', DistroLabelId: DISTRO, EstimatedSalvageAmount: 0, QRScan: '', BuybackRelatedItem: '100000', SalesId: '' }],
  ErrorMessage: '', Success: true, DebugMessage: '' };
const scanned = { $id: '1', ScanMultipleLabels: [{ $id: '2', storeId: '900', buyBackOrderNumber: ORDER, buybackLabelScan: DISTRO, ErrorMessage: '', Success: true }],
  ErrorMessage: '', Success: true, DebugMessage: '' };
const portal = (...answers) => { const calls = []; return { calls, call: async (method, path, body) => { calls.push([method, path, body]); return answers.shift(); } }; };

await test('B- labels only', async () => {
  assert.equal(B.isLabel('B-660482-0000012671'), true);
  assert.equal(B.isLabel(' b-1 '), true);
  for (const v of ['110318-0000002441', 'I-0017390417', 'B-', '', null]) assert.equal(B.isLabel(v), false, String(v));
});

await test('adds the line, then marks its distro label scanned, with the bodies Portal sends', async () => {
  const p = portal({ status: 200, json: added }, { status: 200, json: scanned });
  assert.deepEqual(await B.addAndScan(p.call, ORDER, LABEL), { state: 'added' });
  assert.deepEqual(p.calls, [
    ['POST', '/api/boh/buyback-order-lines/' + ORDER, { buybackOrderNumber: ORDER, serialNumbers: [LABEL] }],
    ['POST', '/api/boh/buyback-order-lines/' + ORDER + '/scan-status', { buybackOrderNumber: ORDER, distroLabels: [DISTRO] }],
  ]);
});

await test("Portal's error message is passed on, and nothing is marked after a failed add", async () => {
  const p = portal({ status: 200, json: { ErrorMessage: 'Serial is not eligible', Success: false, DebugMessage: '' } });
  assert.deepEqual(await B.addAndScan(p.call, ORDER, LABEL), { state: 'failed', message: 'Serial is not eligible' });
  assert.equal(p.calls.length, 1);
});

await test('no Success: true is a failure, even without a message', async () => {
  for (const json of [null, {}, { Success: 'true' }, { ErrorMessage: '  ', Success: false }]) {
    const r = await B.addAndScan(portal({ status: 200, json }).call, ORDER, LABEL);
    assert.equal(r.state, 'failed'); assert.ok(r.message);
  }
  assert.deepEqual(await B.addAndScan(portal({ status: 500, json: null }).call, ORDER, LABEL), { state: 'failed', message: 'Portal answered HTTP 500' });
  assert.deepEqual(await B.addAndScan(portal({ status: 0 }).call, ORDER, LABEL), { state: 'failed', message: 'No connection to Portal' });
});

await test('an added line without its distro label is not marked', async () => {
  const p = portal({ status: 200, json: Object.assign({}, added, { BuybackOrderLines: [Object.assign({}, added.BuybackOrderLines[0], { SerialId: 'B-OTHER-1' })] }) });
  assert.equal((await B.addAndScan(p.call, ORDER, LABEL)).state, 'failed');
  assert.equal(p.calls.length, 1);
});

await test('a failed scan-status, overall or per label, is a failure with its message', async () => {
  const per = Object.assign({}, scanned, { ScanMultipleLabels: [Object.assign({}, scanned.ScanMultipleLabels[0], { Success: false, ErrorMessage: 'Label already scanned' })] });
  assert.deepEqual(await B.addAndScan(portal({ status: 200, json: added }, { status: 200, json: per }).call, ORDER, LABEL), { state: 'failed', message: 'Label already scanned' });
  const all = Object.assign({}, scanned, { Success: false, ErrorMessage: 'Order is closed' });
  assert.deepEqual(await B.addAndScan(portal({ status: 200, json: added }, { status: 200, json: all }).call, ORDER, LABEL), { state: 'failed', message: 'Order is closed' });
});

// ---- the shard itself: a phone's scan (buybacks.scan) against a stand-in for the "Add buyback parts" popout
function shard() {
  const defs = [], handlers = {}, sent = [], fetched = [], page = { why: '', asked: 0 };
  const cell = (text) => ({ innerText: text });
  const button = { disabled: false, getAttribute: () => null };
  const tab = (text, on) => ({ innerText: text, getAttribute: () => (on ? 'true' : 'false'), click() {} });
  const table = { querySelectorAll: (sel) => (sel === 'thead th' ? [cell('Serial Number'), cell('Destination'), cell('')]
    : [{ children: [cell(LABEL), cell('Test Destination (TLC)')], querySelector: () => button }]) };
  const modal = { querySelector: () => table, querySelectorAll: (sel) => (sel === 'table' ? [table] : [tab('Buybacks (1)', true), tab('Damaged (0)', false)]) };
  const head = { textContent: 'Add buyback parts', parentElement: modal, offsetParent: modal };
  const location = { pathname: '/' };
  const answers = [{ status: 200, json: added }, { status: 200, json: scanned }];
  const A = {
    shard: (d) => defs.push(d), h: () => ({}), sleep: async () => {}, settings: { crystals: {} }, signedOut() {},
    timedFetch: async (method, path, init) => { fetched.push([method, path, JSON.parse(init.body)]); const a = answers.shift(); return { res: { status: a.status }, text: JSON.stringify(a.json) }; },
    linkshell: { on: (k, fn) => { handlers[k] = fn; }, send: (k, b) => { sent.push([k, plain(b)]); return 'id'; }, linked: () => ({ store: 900 }),
      paused: async () => { page.asked++; return page.why; } },
  };
  const document = { head: { append() {} }, body: {}, getElementById: () => null, querySelectorAll: () => [head] };
  vm.runInContext(fs.readFileSync(new URL('../src/45-buybacks.js', import.meta.url), 'utf8'),
    vm.createContext({ AE: A, document, location, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }), MutationObserver: class { observe() {} }, setTimeout, clearTimeout, console }));
  defs[0].run();
  location.pathname = '/boh/inventory/buyback-order/' + ORDER; // the popout is open on this order
  Object.assign(A.buybacks._test.phone, { run: 'run1', order: ORDER, store: '900', items: [[0, LABEL, 'Test Destination (TLC)', 'pending']] });
  return { handlers, sent, fetched, page, phone: A.buybacks._test.phone };
}

await test('a phone\'s scan adds the label in Portal and answers added', async () => {
  const s = shard();
  await s.handlers['buybacks.scan']({ run: 'run1', label: LABEL.toLowerCase() });
  assert.deepEqual(s.fetched.map((c) => c[1]), ['/api/boh/buyback-order-lines/' + ORDER, '/api/boh/buyback-order-lines/' + ORDER + '/scan-status']);
  assert.deepEqual(s.sent, [['buybacks.result', { run: 'run1', label: LABEL, i: 0, state: 'added' }]]);
  assert.equal(s.page.asked, 1, 'the page was asked about first');
});

await test('paused on the PC (Aethernet stopped, or Portal on another store): nothing is added, the phone is told failed', async () => {
  const s = shard();
  s.page.why = 'Aethernet is paused on the PC';
  await s.handlers['buybacks.scan']({ run: 'run1', label: LABEL });
  assert.deepEqual(s.fetched, []);
  assert.deepEqual(s.sent, [['buybacks.result', { run: 'run1', label: LABEL, i: 0, state: 'failed', message: 'Aethernet is paused on the PC' }]]);
  assert.equal(s.phone.items[0][3], 'failed');
  // a label that isn't in the list is refused the same way
  await s.handlers['buybacks.scan']({ run: 'run1', label: 'B-999999-0000000009' });
  assert.deepEqual(s.sent[1], ['buybacks.result', { run: 'run1', label: 'B-999999-0000000009', i: -1, state: 'failed', message: 'Aethernet is paused on the PC' }]);
  assert.deepEqual(s.fetched, []);
  // the page is fine again (only in a test: a real page stays paused until reloaded)
  s.page.why = '';
  await s.handlers['buybacks.scan']({ run: 'run1', label: LABEL });
  assert.equal(s.fetched.length, 2); assert.equal(s.sent[2][1].state, 'added');
});

await test('a scan for another run is ignored without asking anything', async () => {
  const s = shard();
  await s.handlers['buybacks.scan']({ run: 'other', label: LABEL });
  assert.deepEqual([s.sent, s.fetched, s.page.asked], [[], [], 0]);
});

console.log(n + ' passed');
