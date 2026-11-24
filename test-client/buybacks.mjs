// Bountiful Yield (src/45-buybacks.js): Scan with phone's Portal calls (AE.buybacks.addAndScan). Fake data only.
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

console.log(n + ' passed');
