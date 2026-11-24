// Client suite, part of `node test-client/run.mjs` (which loads these files in order; see its top for how the tests work).
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { load, retraceFx } from '../harness.mjs';
import { t, STORE, LABELS, ZERO_LABELS, PO_LIST, OUTSTANDING, NO_PARTS, plain, USER, ok, router, posted, MIN } from './common.mjs';

// ================================================================== Retrace
const SERIAL = retraceFx('serial-history');   // { sold: { "@odata.context", value: [rows] }, … } (the captured envelope; values made up)
const LOOKUP = retraceFx('inventory-lookup'); // { "$id", OnHandItemDetails: [rows], TotalRecords, ErrorMessage, Success, DebugMessage } (captured live)
const PO_HEADER = retraceFx('po-header'), PO_RECEIVE = retraceFx('po-receive'), RMA_ORDER = retraceFx('rma-order'), LABEL_DETAILS = retraceFx('label-details');
const EMPTY_PO_LIST = { ...PO_LIST, '@odata.count': 0, value: [] }; // SYNTHETIC: the captured PO list emptied
const LOOKUP_ROW = LOOKUP.OnHandItemDetails[0];
// SYNTHETIC lookup pages built from the captured row: `n` rows of distinct items, each with `qty` available.
const lookupPage = (n, qty, from = 300000) => ({ ...LOOKUP, OnHandItemDetails: Array.from({ length: n }, (_, i) => ({ ...LOOKUP_ROW, ItemNumber: String(from + i), WarehouseId: '914', AvailableQuantity: qty, ReservedQuantity: 0, InTransitQuantity: 0, OnHandQuantity: qty })), TotalRecords: n });
const RT_FILES = ['00-core.js', '27-tracker.js', '28-retrace-collect.js'];
/*
  A Retrace environment. The Worker stub answers each sweep from what it was SENT (opts.sweep(body, i) → fields to answer with), the way
  the Worker does (shortItems only when shortNeed > 0, need only when need > 0…), so a field dropped on the way shows up as a failure.
*/
const retraceEnv = (labelAnswer, opts = {}) => {
  let env = null;
  const sweepAnswer = (b) => {
    const i = env ? env.requests(/\/retrace\/sweep$/, 'POST').length - 1 : 0;
    return ok(Object.assign({ changedItems: [], need: [], more: false, added: (b.labels || []).length, written: 0, countNeed: [], missedItems: [], shortItems: [], pos: { need: [], events: 0 }, unnamed: [] }, opts.sweep ? opts.sweep(b, i) : {}));
  };
  env = load(RT_FILES, {
    timers: opts.timers, online: opts.online,
    gm: Object.assign({ ['ae_retrace_todo_' + STORE]: opts.todo || ['180001'] }, opts.gm || {}),
    fetch: router([
      ...(opts.routes || []),
      ['GET', /^\/api\/auth\/user$/, ok(USER)],
      ['GET', /store-products\/\d+\/inventory\?pageSize=1&/, opts.countAnswer || labelAnswer],
      ['GET', /store-products\/\d+\/inventory\?pageSize=200/, labelAnswer],
      ['GET', /inventory-lookup/, opts.lookup || ok(LOOKUP)],
      ['GET', /serial-history\//, opts.history || ok(SERIAL.sold)],
      ['GET', /\/api\/boh\/inventory\/[^/?]+\?/, opts.details || ok(LABEL_DETAILS)],
      ['GET', /outstanding-parts/, opts.outstanding || ok(NO_PARTS)],
      ['GET', /rma-orders/, opts.rmaList || ok([])], ['GET', /rma-order\//, opts.rmaOrder || ok(RMA_ORDER)],
      ['GET', /store-transfer-orders/, ok([])], ['GET', /van-warehouses/, ok([])],
      ['GET', /purchase-orders\/[^/]+\/receive-details$/, opts.poReceive || ok(PO_RECEIVE)],
      ['GET', /purchase-orders\/[^/?]+$/, opts.poHeader || ok(PO_HEADER)],
      ['POST', /purchase-orders\?pageSize=50/, opts.poList || ok(EMPTY_PO_LIST)],
      ['POST', /purchase-orders\?pageSize=1&/, ok({ ...PO_LIST, '@odata.count': 7 })], // the captured envelope, count 7
      ['GET', /^\/v1\/914\/tracker\/retrace\/cursor$/, opts.cursor || (() => ok({ cursors: opts.lookupDue ? {} : { lookup: { value: { at: new Date(env.clock.now).toISOString() } } }, baseline: opts.baseline || { frozen: true } }))],
      ['POST', /^\/v1\/914\/tracker\/retrace\/sweep$/, opts.sweepRoute || sweepAnswer],
      ['POST', /^\/v1\/914\/tracker\/retrace\/history$/, ok({ added: 1 })],
      ['POST', /^\/v1\/914\/tracker\/retrace\/pass$/, ok({})],
    ]),
  });
  env.sweeps = () => env.requests(/\/retrace\/sweep$/, 'POST').map((r) => r.body); // what was SENT
  env.todo = () => plain(env.gm.get('ae_retrace_todo_' + STORE) || []);
  return env;
};
const labelCalls = (env) => env.requests(/store-products\/.*\/inventory/);

await t('Retrace labels: the captured answer reads its rows (control) and locks the item out for 2 h', async () => {
  const env = retraceEnv(ok(LABELS));
  const r = await env.AE.retrace.run();
  assert.equal(r.itemsRead, 1, JSON.stringify(r)); assert.equal(r.itemsFailed, 0); assert.equal(r.labels, 3);
  assert.equal(env.sweeps().at(-1).labels.length, 3);
  assert.deepEqual(env.todo(), []);
  assert.ok(env.gm.get('ae_retrace_short2_' + STORE)['180001'], 'locked out after a successful read');
});
await t('Retrace labels: a full read sends the listing (listed: item, @odata.count, every label) with the labels', async () => {
  const env = retraceEnv(ok(LABELS));
  await env.AE.retrace.run();
  const last = env.sweeps().at(-1);
  assert.deepEqual(plain(last.listed), [{ item: '180001', total: 3, labels: LABELS.value.map((r) => ({ label: r.SerialNumber, store: r.Store })) }]);
});
await t('Retrace labels: a listed row naming another store (Store "326" at 914) is left out of the listing', async () => {
  const other = { ...LABELS, value: [...LABELS.value.slice(0, 2), { ...LABELS.value[2], Store: '326' }] }; // the captured rows, one moved to another store (as seen live for 721277)
  const env = retraceEnv(ok(other));
  await env.AE.retrace.run();
  const l = env.sweeps().at(-1).listed[0];
  assert.equal(l.total, 3); assert.deepEqual(plain(l.labels.map((x) => x.label)), LABELS.value.slice(0, 2).map((r) => r.SerialNumber));
});
await t('Retrace labels: a list cut at 20 pages is not a full listing (no listed)', async () => {
  const page = { ...LABELS, '@odata.count': 5000, value: Array.from({ length: 200 }, (_, i) => ({ ...LABELS.value[0], SerialNumber: '180001-00006' + String(10000 + i) })) }; // SYNTHETIC: 200 rows a page, 5000 counted
  const env = retraceEnv(ok(page));
  await env.AE.retrace.run();
  assert.equal(env.requests(/store-products\/\d+\/inventory\?pageSize=200/).length, 20);
  assert.ok(env.sweeps().every((b) => !(b.listed || []).length), JSON.stringify(env.sweeps().map((b) => b.listed)));
});
await t('Retrace labels: a failed read sends no listing', async () => {
  const env = retraceEnv(ok({}));
  await env.AE.retrace.run();
  assert.ok(env.sweeps().every((b) => !(b.listed || []).length));
});
await t('Retrace labels: a real zero (count 0, no rows) is a successful read of zero labels', async () => {
  const env = retraceEnv(ok(ZERO_LABELS));
  const r = await env.AE.retrace.run();
  assert.equal(r.itemsRead, 1); assert.equal(r.itemsFailed, 0); assert.equal(r.labels, 0);
});
for (const [name, answer] of [['{}', ok({})], ['a bare string', ok('"nothing"')], ['plain text', { status: 200, body: 'OK' }], ['an array', ok([])], ['another envelope', ok({ data: [], total: 0 })],
  ['rows without a count', ok({ value: [] })], ['a count without rows', ok({ '@odata.count': 0 })], ['a non-numeric count', ok({ '@odata.count': 'many', value: [] })], ['null', ok(null)]]) {
  await t('Retrace labels: ' + name + ' is a FAILED read (item stays queued with a retry count, no lockout)', async () => { // SYNTHETIC bad answers
    const env = retraceEnv(answer);
    const r = await env.AE.retrace.run();
    assert.equal(r.itemsRead, 0, JSON.stringify(r)); assert.equal(r.itemsFailed, 1); assert.ok(r.errors.some((e) => /labels 180001/.test(e)));
    assert.deepEqual(env.todo(), ['180001'], 'still queued');
    assert.equal(env.gm.get('ae_retrace_fail_' + STORE)['180001'], 1, 'retry count');
    assert.deepEqual(plain(env.gm.get('ae_retrace_short2_' + STORE) || {}), {}, 'no lockout');
    assert.deepEqual(plain(env.gm.get('ae_retrace_qtyonly_' + STORE) || {}), {}, 'not quantity-only');
    assert.ok(!env.sweeps().at(-1).labels || env.sweeps().at(-1).labels.length === 0);
  });
}
await t('Retrace count read: only a numeric @odata.count (or a real 0) counts; an unknown shape never marks quantity-only', async () => {
  const run = async (countAnswer) => { const env = retraceEnv(ok(LABELS), { todo: [], countAnswer, baseline: { frozen: false, posKnown: true }, gm: { ['ae_retrace_count_' + STORE]: ['180002'] } }); const r = await env.AE.retrace.run(); return { env, r }; };
  const qo = (env) => Object.keys(plain(env.gm.get('ae_retrace_qtyonly_' + STORE) || {}));
  let { env, r } = await run(ok(LABELS)); // pageSize=1 answer with count 3
  assert.equal(r.counted, 1); assert.deepEqual(plain(env.sweeps().flatMap((s) => s.labelTotals || [])), [{ item: '180002', total: 3 }]);
  ({ env, r } = await run(ok(ZERO_LABELS)));
  assert.equal(r.quantityOnly, 1); assert.deepEqual(qo(env), ['180002']);
  for (const bad of [ok({}), ok('x'), ok({ value: [] }), ok({ '@odata.count': null, value: [] }), { status: 200, body: 'text' }]) { // SYNTHETIC bad answers
    ({ env, r } = await run(bad));
    assert.equal(r.counted, 0, JSON.stringify(r)); assert.equal(r.quantityOnly, undefined);
    assert.deepEqual(qo(env), []);
    assert.deepEqual(plain(env.sweeps().flatMap((s) => s.labelTotals || [])), []);
  }
  ({ env, r } = await run({ status: 404, body: { error: 'no record' } })); // Portal has no record of the item: 0, as before (an HTTP answer, not a shape)
  assert.equal(r.quantityOnly, 1);
});

// ---- A: what the sweeps send
await t('Retrace sweep (frozen baseline): the last sweep SENDS shortNeed and every request field; the Worker\'s shortItems get queued', async () => {
  const env = retraceEnv(ok(LABELS), { todo: [], sweep: (b) => (b.shortNeed > 0 ? { shortItems: ['190002'] } : {}) }); // the Worker answers shortItems only when asked
  const r = await env.AE.retrace.run();
  const last = env.sweeps().at(-1);
  assert.equal(last.need, 60); assert.equal(last.poNeed, 15); assert.equal(last.nameNeed, 20); assert.equal(last.countNeed, 0); assert.equal(last.shortNeed, 300, JSON.stringify(last));
  assert.equal(last.by, 'Test Tech');
  assert.ok(last.cursors && last.cursors.rma, 'cursors go up');
  assert.equal(r.shortQueued, 1); assert.deepEqual(env.todo(), ['190002'], 'the short item is queued for a label read');
});
await t('Retrace sweep: vendorNeed goes up; the Worker\'s vendorItems are queued for a label read once per 12 hours', async () => {
  const env = retraceEnv(ok(LABELS), { todo: [], sweep: (b) => (b.vendorNeed > 0 ? { vendorItems: ['190002', '200003'] } : {}), gm: { ['ae_retrace_vendor_' + STORE]: { 200003: Date.now() } } });
  const r = await env.AE.retrace.run();
  assert.equal(env.sweeps().at(-1).vendorNeed, 150);
  assert.equal(r.vendorQueued, 1); assert.deepEqual(env.todo(), ['190002'], 'the item read within 12 hours waits');
});
await t('Retrace sweep (counting): countNeed, poTotal and labelTotals go up on the last sweep; shortNeed 0', async () => {
  const env = retraceEnv(ok(LABELS), { todo: [], baseline: { frozen: false, posKnown: false }, countAnswer: ok(LABELS), gm: { ['ae_retrace_count_' + STORE]: ['180002'] } });
  await env.AE.retrace.run();
  const last = env.sweeps().at(-1);
  assert.equal(last.countNeed, 200); assert.equal(last.poTotal, 14); assert.equal(last.shortNeed, 0); assert.deepEqual(plain(last.labelTotals), [{ item: '180002', total: 3 }]);
});
await t('Retrace sweep: a list over the Worker\'s cap is split; only the last part carries the request fields, the others ask for nothing', async () => {
  // SYNTHETIC: 2,500 distinct items with stock (25 full pages, then a page without stock), the other two sorts end at once
  const lookup = (b, path) => { const page = Number(/page=(\d+)/.exec(path)[1]); return ok(/sortField=availablequantity/.test(path) && page <= 25 ? lookupPage(100, 5, 300000 + page * 100) : lookupPage(100, 0, 900000)); };
  const env = retraceEnv(ok(LABELS), { todo: [], lookupDue: true, lookup });
  const r = await env.AE.retrace.run();
  const parts = env.sweeps().filter((b) => b.items);
  assert.equal(parts.length, 2, JSON.stringify(r.errors)); assert.equal(parts[0].items.length, 2400); assert.equal(parts[1].items.length, 100);
  assert.equal(parts[0].need, 0); assert.equal(parts[0].cursors, undefined); assert.equal(parts[0].countNeed, undefined);
  assert.equal(parts[1].need, 0); assert.ok(parts[1].cursors.lookup); assert.equal(parts[1].countNeed, 0);
});

// ---- D: the stock lookup is all or nothing
const stockRun = async (lookup, gm = {}) => {
  const env = retraceEnv(ok(LABELS), { todo: [], lookupDue: true, lookup, gm: Object.assign({ ['ae_retrace_stock_' + STORE]: { 999999: ['914'] } }, gm) }); // 999999: sent last time
  const r = await env.AE.retrace.run();
  return { env, r, items: env.sweeps().flatMap((b) => b.items || []) };
};
await t('Retrace stock: the captured lookup is sent, and an item gone from it is sent once at 0 (control)', async () => {
  const { env, r, items } = await stockRun(ok(LOOKUP));
  assert.ok(items.some((i) => i.ItemNumber === '180001'), JSON.stringify(r.errors));
  assert.ok(items.some((i) => i.ItemNumber === '999999' && i.AvailableQuantity === 0), 'the sell-out is sent');
  assert.ok(plain(env.gm.get('ae_retrace_stock_' + STORE))['180001']);
});
for (const [name, lookup] of [
  ['a malformed first page ({})', ok({})], // SYNTHETIC
  ['Success: false', ok({ ...LOOKUP, Success: false, ErrorMessage: 'busy' })], // SYNTHETIC: the captured envelope, failed
  ['a bad second page', (b, path) => ok(/page=1&/.test(path) ? lookupPage(100, 5) : { message: 'error' })], // SYNTHETIC
  ['a 504 on the second page', (b, path) => (/page=1&/.test(path) ? ok(lookupPage(100, 5)) : { status: 504, body: 'Endpoint request timed out' })],
  ['30 pages still in stock', (b, path) => ok(lookupPage(100, 5, 300000 + Number(/page=(\d+)/.exec(path)[1]) * 100))], // SYNTHETIC
]) {
  await t('Retrace stock: ' + name + ' aborts the whole lookup: nothing recorded, nothing sent, no item zeroed', async () => {
    const { env, r, items } = await stockRun(lookup);
    assert.deepEqual(items, [], 'no items sent'); assert.ok(r.errors.some((e) => /^stock/.test(e)), JSON.stringify(r.errors));
    assert.deepEqual(plain(env.gm.get('ae_retrace_stock_' + STORE)), { 999999: ['914'] }, 'what was sent before is kept');
    assert.equal(r.lookup, null);
  });
}

// ---- B: serial history
const historyRun = (history) => retraceEnv(ok(LABELS), { todo: [], history, sweep: (b) => (b.need > 0 ? { need: ['176255-0000514371'] } : {}) });
await t('Retrace history: the captured { value } answer is posted with its rows (control)', async () => {
  const env = historyRun(ok(SERIAL.sold));
  const r = await env.AE.retrace.run();
  const p = env.requests(/\/retrace\/history$/, 'POST');
  assert.equal(p.length, 1, JSON.stringify(r.errors)); assert.equal(p[0].body.label, '176255-0000514371'); assert.equal(p[0].body.rows.length, SERIAL.sold.value.length);
  assert.equal(r.histories, 1);
});
for (const [name, answer] of [['{}', ok({})], ['an error envelope', ok({ Message: 'An error has occurred.' })], ['null', ok(null)], ['a JSON string', ok('"none"')], ['value not a list', ok({ value: 'x' })], ['plain text', { status: 200, body: 'Server busy' }], ['a 500', { status: 500, body: 'x' }]]) {
  await t('Retrace history: ' + name + ' is a failed read: nothing posted (the label stays queued)', async () => { // SYNTHETIC bad answers
    const env = historyRun(answer);
    const r = await env.AE.retrace.run();
    assert.deepEqual(env.requests(/\/retrace\/history$/, 'POST'), []); assert.equal(r.histories, 0);
    assert.ok(r.errors.some((e) => /history 176255-0000514371/.test(e)), JSON.stringify(r.errors));
  });
}
await t('Retrace label details: the sales order is marked linked only after a real label answer', async () => {
  let env = historyRun(ok(SERIAL.sold));
  await env.AE.retrace.run();
  assert.deepEqual(plain(env.gm.get('ae_retrace_so_' + STORE)), ['FSO000011111']);
  assert.ok(env.sweeps().some((b) => (b.labels || []).some((l) => l.label === '176255-0000514371')), 'the snapshot went up');
  env = retraceEnv(ok(LABELS), { todo: [], details: ok({}), sweep: (b) => (b.need > 0 ? { need: ['176255-0000514371'] } : {}) }); // SYNTHETIC bad details
  const r = await env.AE.retrace.run();
  assert.deepEqual(plain(env.gm.get('ae_retrace_so_' + STORE)), [], 'not marked: the next history of this sales order tries again');
  assert.ok(r.errors.some((e) => /label details/.test(e)));
});

// ---- B2: sales orders the Worker lists as unlinked (soNeed)
const soEnv = (list, details, extra = {}) => retraceEnv(ok(LABELS), Object.assign({ todo: [], details, sweep: (b) => (b.soNeed > 0 ? { soNeed: list } : {}) }, extra)); // the Worker answers soNeed only when asked
const DETAIL_URL = /\/api\/boh\/inventory\/[^/?]+\?/;
const SO1 = { sales_order: 'FSO000011111', label: '176255-0000514371' };
await t('Retrace soNeed: asked on the last sweep (50); the label details of each are read and sent as snapshots', async () => {
  const env = soEnv([SO1], ok(LABEL_DETAILS));
  const r = await env.AE.retrace.run();
  assert.equal(env.sweeps().at(-2).soNeed, 50, JSON.stringify(env.sweeps().map((b) => Object.keys(b))));
  const calls = env.requests(DETAIL_URL); assert.equal(calls.length, 1); assert.match(calls[0].url, /176255-0000514371\?includeQuarantineInfo=true&includeSalvageInfo=true$/);
  assert.ok(env.sweeps().at(-1).labels.some((l) => l.label === '176255-0000514371' && l.wo === '500400001' && l.sales_order === 'FSO000011111'), 'the snapshot (with WorkOrderId) went up');
  assert.equal(env.sweeps().at(-1).soNone, undefined, 'linked: not a "no WO" answer'); assert.equal(r.soRead, 1);
});
await t('Retrace soNeed: a real answer without a WorkOrderId goes back as soNone', async () => {
  const env = soEnv([SO1], ok({ ...LABEL_DETAILS, WorkOrderId: '' })); // SYNTHETIC: the captured label with the WO blanked
  await env.AE.retrace.run();
  assert.deepEqual(plain(env.sweeps().at(-1).soNone), ['FSO000011111']);
  const env2 = soEnv([SO1], ok({ ...LABEL_DETAILS, SalesOrderNumber: 'FSO000099999' })); // the label has moved on to another sales order
  await env2.AE.retrace.run();
  assert.deepEqual(plain(env2.sweeps().at(-1).soNone), ['FSO000011111']);
});
for (const [name, answer] of [['{}', ok({})], ['null', ok(null)], ['a string', ok('nope')], ['Success:false', ok({ ...LABEL_DETAILS, Success: false })], ['another label', ok({ ...LABEL_DETAILS, SerialNumber: '176255-0000000001' })], ['no status', ok({ SerialNumber: '176255-0000514371' })]]) {
  await t('Retrace soNeed: ' + name + ' is a failed read, never recorded as "no WO"', async () => { // SYNTHETIC bad answers
    const env = soEnv([SO1], answer);
    const r = await env.AE.retrace.run();
    assert.ok(env.sweeps().every((b) => b.soNone === undefined), 'no soNone: ' + JSON.stringify(env.sweeps().map((b) => b.soNone)));
    assert.ok(env.sweeps().every((b) => !(b.labels || []).some((l) => l.label === '176255-0000514371')), 'no snapshot either');
    assert.ok(r.errors.some((e) => /sales order FSO000011111/.test(e)), JSON.stringify(r.errors)); assert.equal(r.soRead, 0);
  });
}
await t('Retrace soNeed: at most 25 reads a pass', async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ sales_order: 'FSO' + (1000 + i), label: '176255-00005' + String(10000 + i) }));
  const env = soEnv(many, ok(LABEL_DETAILS));
  const r = await env.AE.retrace.run();
  assert.equal(env.requests(DETAIL_URL).length, 25); assert.equal(r.soNeed, 40);
});
await t('Retrace soNeed: Portal trouble stops the reads (two 5xx in a row), nothing recorded', async () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ sales_order: 'FSO' + (1000 + i), label: '176255-00005' + String(10000 + i) }));
  const env = soEnv(many, { status: 504, body: 'Endpoint request timed out' });
  const r = await env.AE.retrace.run();
  assert.equal(env.requests(DETAIL_URL).length, 2, 'the breaker is on after the second'); assert.equal(r.portalTrouble, true);
  assert.ok(env.sweeps().every((b) => b.soNone === undefined));
});
await t('Retrace soNeed: over the history loop\'s detail budget the sales order is left for the Worker, not dropped', async () => {
  const need = Array.from({ length: 20 }, (_, i) => '176255-00005' + String(20000 + i));
  const history = (_b, path) => { const n = path.replace(/^.*serial-history\//, ''); return ok({ value: SERIAL.sold.value.map((r) => (r.RefTable && /^sales orders?$/i.test(r.RefTable) ? { ...r, SourceKey: 'FSO' + n.slice(-5) } : r)) }); }; // a different sales order per label
  const env = retraceEnv(ok(LABELS), { todo: [], sweep: (b) => (b.need > 0 ? { need } : {}), history });
  const r = await env.AE.retrace.run();
  assert.equal(r.details, 15, JSON.stringify(r)); assert.equal(r.detailsDeferred, 5, 'counted, and still unlinked at the Worker (its soNeed lists them)');
});

// ---- B3: serial history answering 404 (by status only; no 404 body shape is assumed)
const HL = ['176255-0000514371', '176255-0000514372'];
const h404Env = (history, gm = {}) => retraceEnv(ok(LABELS), { todo: [], gm, history, sweep: (b) => (b.need > 0 ? { need: HL } : {}) });
const histPosts = (env) => env.requests(/\/retrace\/history$/, 'POST').map((r) => r.body);
const firstNotFound = (_b, path) => (path.endsWith(HL[0]) ? { status: 404, body: { message: 'Not Found' } } : ok(SERIAL.sold)); // SYNTHETIC 404 (status is all that is read)
await t('Retrace history 404: once is a failed read (nothing posted for it, counted), the next label is still read, no Portal trouble', async () => {
  const env = h404Env(firstNotFound);
  const r = await env.AE.retrace.run();
  assert.deepEqual(plain(histPosts(env).map((b) => b.label)), [HL[1]]);
  assert.equal(env.gm.get('ae_retrace_h404_914')[HL[0]].n, 1); assert.equal(r.history404, 1); assert.equal(r.portalTrouble, false);
});
await t('Retrace history 404: the third in a row is sent as none: 404 (no rows), and the count is cleared', async () => {
  const env = h404Env(firstNotFound, { ae_retrace_h404_914: { [HL[0]]: { n: 2, at: Date.now() } } });
  const r = await env.AE.retrace.run();
  const none = histPosts(env).find((b) => b.label === HL[0]);
  assert.ok(none, JSON.stringify(histPosts(env))); assert.equal(none.none, 404); assert.deepEqual(plain(none.rows), []);
  assert.equal(env.gm.get('ae_retrace_h404_914')[HL[0]], undefined); assert.equal(r.historyNone, 1);
});
await t('Retrace history 404: a 5xx is not a 404 (never none, not counted; the breaker trips after two)', async () => {
  const env = h404Env(() => ({ status: 504, body: 'Endpoint request timed out' }), { ae_retrace_h404_914: { [HL[0]]: { n: 2, at: Date.now() } } });
  const r = await env.AE.retrace.run();
  assert.ok(histPosts(env).every((b) => b.none === undefined)); assert.equal(env.gm.get('ae_retrace_h404_914')[HL[0]].n, 2); assert.equal(r.portalTrouble, true);
});
await t('Retrace history 404: a real read clears the count', async () => {
  const env = h404Env(() => ok(SERIAL.sold), { ae_retrace_h404_914: { [HL[0]]: { n: 2, at: Date.now() } } });
  await env.AE.retrace.run();
  assert.equal(env.gm.get('ae_retrace_h404_914')[HL[0]], undefined);
  assert.ok(histPosts(env).every((b) => b.none === undefined && b.rows.length));
});

// ---- dev tools probes (outline only, never interpreted beyond the collector's own checks)
await t('Retrace probes: RMA list and label details are outlined (keys, arrays, first 2 rows scrubbed) with the collector\'s verdict', async () => {
  const env = retraceEnv(ok(LABELS), { rmaList: ok({ weird: [{ id: 1, customerName: 'X', phone: '1' }, { id: 2 }, { id: 3 }], n: 3 }) }); // SYNTHETIC unknown envelope
  const r = await env.AE.retrace.probeRma();
  assert.match(r.path, /rma-orders\?startDate=\d{8}&endDate=\d{8}&.*page=1$/);
  assert.deepEqual(plain(r.answer.topLevel), ['weird', 'n']); assert.deepEqual(plain(r.answer.arrays), { weird: 3 });
  assert.equal(r.answer.first2.length, 2); assert.ok(!('customerName' in r.answer.first2[0]) && !('phone' in r.answer.first2[0]), 'scrubbed');
  assert.match(r.collector, /refused: .*no list in the answer/);
  const l = await env.AE.retrace.probeLabel('176255-0000514371');
  assert.match(l.collector, /^usable: label 176255-0000514371, status /, JSON.stringify(l));
  const env2 = retraceEnv(ok(LABELS), { details: ok({ Success: true, Data: { SerialNumber: '176255-0000514371' } }) }); // SYNTHETIC wrapped answer
  const l2 = await env2.AE.retrace.probeLabel('176255-0000514371');
  assert.match(l2.collector, /refused: no status/); assert.deepEqual(plain(l2.answer.topLevel), ['Success', 'Data']); assert.ok(l2.answer.raw.includes('Data'));
  const env3 = retraceEnv(ok(LABELS), { details: { status: 404, body: { message: 'x' } } });
  const l3 = await env3.AE.retrace.probeLabel('176255-0000514371');
  assert.equal(l3.status, 404); assert.ok(l3.error);
  assert.deepEqual(env3.requests(/\/retrace\//), [], 'probes never write to the Worker');
});

// ---- live captures of Oct 26, 2026: the RMA order list (StatusList[].Headers) and label details (no label field)
const RMA_LIVE = retraceFx('rma-orders-live').answer, LD_LIVE = retraceFx('label-details-live');
await t('Retrace RMA list (live shape): rows come from StatusList[].Headers; an empty group is no error; CreatedDate is never turned into a time', async () => {
  const env = retraceEnv(ok(LABELS), { todo: [], rmaList: ok(RMA_LIVE) });
  const r = await env.AE.retrace.run();
  assert.ok(!r.errors.some((e) => /rma orders/.test(e)), JSON.stringify(r.errors));
  const docs = env.sweeps().flatMap((b) => b.docs || []).filter((d) => d.type === 'rma' && d.id === 'UBFPO000162258');
  assert.ok(docs.length, 'the Shipped header went up'); assert.equal(docs[0].status, 'Shipped'); assert.equal(docs[0].at, null); assert.equal(docs[0].counterpart, 'Distribution Center');
  assert.equal(docs[0].data.CreatedDate, '10/19/2026 03:55:02 pm', 'the raw text is kept');
  assert.equal(env.requests(/rma-order\/UBFPO000162258$/).length, 1, 'the order is read in full');
  assert.match((await env.AE.retrace.probeRma()).collector, /^read: 1 orders$/);
});
await t('Retrace RMA list: a StatusList group without Headers is a bad shape (nothing read)', async () => {
  const env = retraceEnv(ok(LABELS), { todo: [], rmaList: ok({ ...RMA_LIVE, StatusList: [...RMA_LIVE.StatusList, { Status: 'Received', Count: 2 }] }) }); // SYNTHETIC
  const r = await env.AE.retrace.run();
  assert.ok(r.errors.some((e) => /rma orders/.test(e))); assert.equal(env.requests(/rma-order\//).length, 0);
});
await t('Retrace label details (live shape): the label comes from the request; ArrivalId is an arrival, never a WO; no WorkOrderId = soNone', async () => {
  const lab = LD_LIVE.reserved.label, so = LD_LIVE.reserved.answer.SalesOrderNumber;
  const env = soEnv([{ sales_order: so, label: lab }], ok(LD_LIVE.reserved.answer));
  const r = await env.AE.retrace.run();
  const sn = env.sweeps().at(-1).labels.find((l) => l.label === lab);
  assert.ok(sn, JSON.stringify(r.errors)); assert.equal(sn.status, 'Reserved'); assert.equal(sn.sales_order, 'FSO000358203'); assert.equal(sn.arrival, '500803092');
  assert.equal(sn.wo, undefined, 'ArrivalId is not a WO'); assert.equal(sn.po, 'UBFPO000169300'); assert.equal(sn.warehouse, '914'); assert.equal(sn.oem_serial, 'G9PHU0H0UQT0000MTE');
  assert.deepEqual(plain(env.sweeps().at(-1).soNone), [so], 'a real answer with no WorkOrderId');
  const av = LD_LIVE.available;
  const env2 = soEnv([{ sales_order: 'FSO000000001', label: av.label }], ok(av.answer));
  await env2.AE.retrace.run();
  const s2 = env2.sweeps().at(-1).labels.find((l) => l.label === av.label);
  assert.equal(s2.status, 'Available'); assert.equal(s2.sales_order, undefined, 'SalesOrderNumber "" is no value'); assert.deepEqual(plain(env2.sweeps().at(-1).soNone), ['FSO000000001']);
  const p = await env.AE.retrace.probeLabel(lab);
  assert.match(p.collector, /^usable: label 721278-0000021178, status Reserved, WO -, sales order FSO000358203, arrival 500803092$/);
});
await t('Retrace label details: an ItemNumber that is not the label\'s item is a failed read', async () => {
  const lab = LD_LIVE.reserved.label;
  const env = soEnv([{ sales_order: 'FSO000358203', label: lab }], ok({ ...LD_LIVE.reserved.answer, ItemNumber: '999999' })); // SYNTHETIC mismatch
  const r = await env.AE.retrace.run();
  assert.ok(env.sweeps().every((b) => b.soNone === undefined)); assert.ok(r.errors.some((e) => /sales order FSO000358203/.test(e)));
  const env2 = soEnv([{ sales_order: 'FSO000358203', label: lab }], ok({ ...LD_LIVE.reserved.answer, ItemNumber: '721278' })); // the matching item passes
  await env2.AE.retrace.run();
  assert.ok(env2.sweeps().at(-1).labels.some((l) => l.label === lab));
});

// ---- C: purchase orders
const poRun = (poReceive, poHeader) => retraceEnv(ok(LABELS), { todo: [], poReceive, poHeader, sweep: (b) => (b.poNeed > 0 ? { pos: { need: ['UBFPO000099001'], events: 0 } } : {}) });
await t('Retrace POs: header + receive details go up together (control)', async () => {
  const env = poRun();
  const r = await env.AE.retrace.run();
  const sent = env.sweeps().filter((b) => b.pos && b.pos.some((p) => p.header));
  assert.equal(sent.length, 1, JSON.stringify(r.errors)); assert.equal(sent[0].pos[0].receive.PurchaseOrderId, PO_RECEIVE.PurchaseOrderId);
  assert.equal(r.poDetails, 1);
});
for (const [name, rec] of [['a failed receive read (500)', { status: 500, body: 'x' }], ['a receive answer that is not an object', ok(null)], ['a text receive answer', { status: 200, body: 'nope' }]]) {
  await t('Retrace POs: ' + name + ' sends nothing for that PO (it stays queued at the Worker)', async () => { // SYNTHETIC bad answers
    const env = poRun(rec);
    const r = await env.AE.retrace.run();
    assert.deepEqual(env.sweeps().filter((b) => b.pos && b.pos.some((p) => p && p.header)), []);
    assert.ok(r.errors.some((e) => /po receive UBFPO000099001/.test(e)), JSON.stringify(r.errors));
    assert.equal(env.gm.get('ae_retrace_rfail_' + STORE)['po:UBFPO000099001'].n, 1, 'its failure is counted');
  });
}

// ---- E: one pass per browser, merged GM queues
await t('Retrace lock: another tab\'s live lock = no pass, no call; a dead one is taken over and released at the end', async () => {
  const env = retraceEnv(ok(LABELS), { gm: { ae_retrace_lock: { owner: 'other-tab', at: Date.now() - 30000 } } });
  assert.equal(await env.AE.retrace.run(), null);
  assert.equal(env.fetchLog.length, 0); assert.match(env.AE.retrace.state().lastSkip.why, /another tab/);
  const env2 = retraceEnv(ok(LABELS), { gm: { ae_retrace_lock: { owner: 'other-tab', at: Date.now() - 3 * 60000 } } }); // no beat for 3 min: dead
  const r = await env2.AE.retrace.run();
  assert.equal(r.itemsRead, 1, JSON.stringify(r)); assert.equal(env2.gm.has('ae_retrace_lock'), false, 'released');
});
await t('Retrace lock: a pass that finds another live owner mid-way stops at its next call', async () => {
  let env = null;
  env = retraceEnv(ok(LABELS), { cursor: () => { env.gm.set('ae_retrace_lock', { owner: 'other-tab', at: env.clock.now }); return ok({ cursors: { lookup: { value: { at: new Date(env.clock.now).toISOString() } } }, baseline: { frozen: true } }); } });
  const r = await env.AE.retrace.run();
  assert.match(r.note || '', /another tab took over/); assert.deepEqual(labelCalls(env), []); assert.deepEqual(env.sweeps(), []);
  assert.deepEqual(plain(env.gm.get('ae_retrace_lock')), { owner: 'other-tab', at: env.clock.now }, 'the other tab\'s lock is left alone');
});
await t('Retrace lock (virtual clock): the heartbeat keeps the lock fresh through a long Worker call', async () => {
  let env = null;
  const slowSweep = () => new Promise((r) => env.ctx.setTimeout(() => r(ok({ changedItems: [], need: [], countNeed: [], missedItems: [], shortItems: [], pos: { need: [], events: 0 }, unnamed: [] })), 80000)); // 80 s, no call meanwhile
  env = retraceEnv(ok(LABELS), { todo: [], timers: 'fake', sweepRoute: slowSweep });
  const p = env.AE.retrace.run();
  await env.advance(70000);
  const l = plain(env.gm.get('ae_retrace_lock'));
  assert.ok(l && env.clock.now - l.at <= 20000, 'beaten within the last 20 s: ' + JSON.stringify(l) + ' at ' + env.clock.now);
  await env.advance(2 * MIN); // (not 10: the module's own 60 s tick would start the next due pass)
  const r = await p;
  assert.deepEqual(plain(r.errors), []); assert.equal(env.gm.has('ae_retrace_lock'), false, 'released at the end');
});
await t('Retrace GM queues: items another tab adds during the pass survive this pass\'s writes (merge, not overwrite)', async () => {
  let env = null;
  env = retraceEnv(ok(LABELS), { sweep: (b, i) => { // as the last sweep goes out, another tab queues an item and a lockout
    if (b.need > 0) { env.gm.set('ae_retrace_todo_' + STORE, [...(env.gm.get('ae_retrace_todo_' + STORE) || []), '555555']); env.gm.set('ae_retrace_fail_' + STORE, { 555555: 2 }); env.gm.set('ae_retrace_short2_' + STORE, { 444444: env.clock.now }); }
    return {};
  } });
  await env.AE.retrace.run();
  assert.deepEqual(env.todo(), ['555555'], 'the read item left, the other tab\'s stayed');
  const short = plain(env.gm.get('ae_retrace_short2_' + STORE));
  assert.ok(short['444444'] && short['180001'], JSON.stringify(short));
  assert.deepEqual(plain(env.gm.get('ae_retrace_fail_' + STORE)), { 555555: 2 }, 'the other tab\'s failure count (a map) survives too');
});

// ---- F: the pass breaker and per-record failures
await t('Retrace breaker: one 504 doesn\'t stop the pass; two in a row do', async () => {
  const seq = (fails) => (b, path) => (fails.has(/store-products\/(\d+)/.exec(path)[1]) ? { status: 504, body: 'Endpoint request timed out' } : ok(LABELS));
  let env = retraceEnv(seq(new Set(['1'])), { todo: ['1', '2', '3'] });
  let r = await env.AE.retrace.tick();
  assert.equal(r.itemsRead, 2, JSON.stringify(r)); assert.equal(r.portalTrouble, false);
  env = retraceEnv(seq(new Set(['1', '2'])), { todo: ['1', '2', '3'] });
  r = await env.AE.retrace.tick();
  assert.equal(r.itemsRead, 0); assert.equal(r.portalTrouble, true); assert.equal(labelCalls(env).length, 2, 'item 3 was not asked');
  assert.deepEqual(env.requests(/serial-history|purchase-orders\/[^?]/), []);
});
await t('Retrace breaker: bad shapes, text answers and 4xx are not Portal trouble (no pass breaker, no outage)', async () => {
  for (const answer of [ok({}), { status: 200, body: 'Server busy' }, { status: 404, body: 'x' }]) { // SYNTHETIC bad answers
    const env = retraceEnv(answer, { todo: ['1', '2', '3', '4', '5'] });
    const r = await env.AE.retrace.tick();
    assert.equal(r.itemsFailed, 5, JSON.stringify(r)); assert.equal(r.portalTrouble, false); assert.equal(env.AE.health.state().down, false);
  }
});
await t('Retrace breaker: Portal tripping AE.health mid-pass (another loop\'s failures) stops the reads', async () => {
  let env = null;
  env = retraceEnv(ok(LABELS), { todo: ['1', '2'], cursor: () => { for (let i = 0; i < 3; i++) env.AE.health.fail('http', { status: 504, message: 'x' }); return ok({ cursors: { lookup: { value: { at: new Date(env.clock.now).toISOString() } } }, baseline: { frozen: true } }); } });
  const r = await env.AE.retrace.tick();
  assert.deepEqual(labelCalls(env), [], JSON.stringify(r)); assert.equal(r.portalTrouble, true);
});
await t('Retrace counts: a count that keeps failing rests after 5 tries; the other items are still counted', async () => {
  const count = (b, path) => (/store-products\/180002\//.test(path) ? { status: 500, body: 'x' } : ok(LABELS));
  let env = null;
  const gm = { ['ae_retrace_count_' + STORE]: ['180002', '180003'] };
  for (let i = 1; i <= 6; i++) {
    env = retraceEnv(ok(LABELS), { todo: [], countAnswer: count, baseline: { frozen: false, posKnown: true }, gm });
    const r = await env.AE.retrace.run();
    for (const k of ['ae_retrace_count_' + STORE, 'ae_retrace_rfail_' + STORE]) gm[k] = plain(env.gm.get(k)); // the next pass sees this one's storage
    const asked = env.requests(/store-products\/180002\/inventory\?pageSize=1/).length;
    if (i <= 5) { assert.equal(asked, 1, 'pass ' + i); assert.equal(gm['ae_retrace_rfail_' + STORE]['count:180002'].n, i); }
    else { assert.equal(asked, 0, 'resting'); assert.ok(r.resting.includes('count:180002'), JSON.stringify(r.resting)); }
    if (i === 1) { assert.equal(env.requests(/store-products\/180003\/inventory\?pageSize=1/).length, 1, 'the other item is counted'); assert.deepEqual(gm['ae_retrace_count_' + STORE], ['180002'], 'and leaves the count list'); }
  }
});

// ---- G: nothing given up for good, progress only after a validated read
await t('Retrace: an item given up after 5 failed reads is parked and offered again after 6 h', async () => {
  const env = retraceEnv(ok({}), { todo: ['180001'] }); // SYNTHETIC bad answers
  for (let i = 0; i < 5; i++) await env.AE.retrace.run();
  assert.deepEqual(env.todo(), []); assert.ok(plain(env.gm.get('ae_retrace_park_' + STORE))['180001'], 'parked');
  assert.deepEqual(plain(env.gm.get('ae_retrace_fail_' + STORE)), {}, 'no stray failure count');
  const before = labelCalls(env).length;
  await env.AE.retrace.run();
  assert.equal(labelCalls(env).length, before, 'not read while parked');
  env.clock.now += 6 * 3600000 + 1;
  const r = await env.AE.retrace.run();
  assert.equal(r.itemsUnparked, 1); assert.equal(labelCalls(env).length, before + 1, 'read again');
});
await t('Retrace quantity-only: an entry expires after 7 days; a fresh one still holds; the old list form reads as fresh', async () => {
  const now = Date.now();
  const changed = { changedItems: [{ item: '180007' }, { item: '180008' }, { item: '180009' }] };
  const env = retraceEnv(ok(LABELS), { todo: [], lookupDue: true, sweep: (b) => (b.items ? changed : {}),
    gm: { ['ae_retrace_qtyonly_' + STORE]: { 180007: now - 8 * 86400000, 180008: now - 86400000 } } });
  await env.AE.retrace.run();
  const read = labelCalls(env).map((r) => /store-products\/(\d+)/.exec(r.path)[1]);
  assert.ok(read.includes('180007'), 'expired: read'); assert.ok(!read.includes('180008'), 'fresh: not read'); assert.ok(read.includes('180009'));
  const env2 = retraceEnv(ok(LABELS), { todo: [], lookupDue: true, sweep: (b) => (b.items ? changed : {}), gm: { ['ae_retrace_qtyonly_' + STORE]: ['180007'] } });
  await env2.AE.retrace.run();
  assert.ok(!labelCalls(env2).some((r) => /180007/.test(r.path)), 'old list form: still quantity-only');
});
await t('Retrace quantity-only: a later count with labels clears the mark', async () => {
  const env = retraceEnv(ok(LABELS), { todo: [], countAnswer: ok(LABELS), baseline: { frozen: false, posKnown: true },
    gm: { ['ae_retrace_count_' + STORE]: ['180002'], ['ae_retrace_qtyonly_' + STORE]: { 180002: Date.now() } } });
  await env.AE.retrace.run();
  assert.deepEqual(plain(env.gm.get('ae_retrace_qtyonly_' + STORE)), {});
});
await t('Retrace RMA orders: marked seen only after a real full read', async () => {
  const row = { RMAPurchId: RMA_ORDER.RMAPurchId, rma_order_status: RMA_ORDER.rma_order_status, vendor_name: RMA_ORDER.vendor_name }; // SYNTHETIC list row: the captured order's header fields
  const seen = (env) => ((env.sweeps().at(-1).cursors || {}).rma || {}).seen || {};
  let env = retraceEnv(ok(LABELS), { todo: [], rmaList: ok([row]) });
  await env.AE.retrace.run();
  assert.equal(seen(env)[RMA_ORDER.RMAPurchId], 'Shipped');
  env = retraceEnv(ok(LABELS), { todo: [], rmaList: ok([row]), rmaOrder: ok({}) }); // SYNTHETIC bad answer
  let r = await env.AE.retrace.run();
  assert.equal(seen(env)[RMA_ORDER.RMAPurchId], undefined); assert.ok(r.errors.some((e) => /rma order/.test(e)));
  env = retraceEnv(ok(LABELS), { todo: [], rmaList: ok([row]), rmaOrder: { status: 500, body: 'x' } });
  r = await env.AE.retrace.run();
  assert.equal(seen(env)[RMA_ORDER.RMAPurchId], undefined);
});
await t('Retrace: a failure count for an item no longer queued is pruned', async () => {
  const env = retraceEnv(ok(LABELS), { gm: { ['ae_retrace_fail_' + STORE]: { 777777: 3 } } });
  await env.AE.retrace.run();
  assert.deepEqual(plain(env.gm.get('ae_retrace_fail_' + STORE)), {});
});

// ---- H: the big sweep's timeout
await t('Retrace (virtual clock): a sweep may take the Worker 60 s (90 s timeout), its answer is not lost', async () => {
  let env = null;
  const slowSweep = (b) => new Promise((r) => env.ctx.setTimeout(() => r(ok({ changedItems: [], need: [], countNeed: [], missedItems: [], shortItems: b.shortNeed ? ['190002'] : [], pos: { need: [], events: 0 }, unnamed: [] })), 60000));
  env = retraceEnv(ok(LABELS), { todo: [], timers: 'fake', sweepRoute: slowSweep });
  const p = env.AE.retrace.run();
  await env.advance(5 * MIN);
  const r = await p;
  assert.deepEqual(plain(r.errors), []); assert.deepEqual(env.todo(), ['190002']);
});

// ---- J: Portal's 403 vs the Worker's
await t('Retrace: Portal\'s 403 is an error (noted, visible); the Worker\'s 403 is the quiet "no access" note', async () => {
  const env = retraceEnv({ status: 403, body: 'x' });
  const r = await env.AE.retrace.run();
  assert.equal(r.note, undefined); assert.ok(r.errors.some((e) => /session expired/.test(e)), JSON.stringify(r));
  assert.ok(env.AE.recentErrors.some((e) => e.where === 'retrace'));
  const env2 = retraceEnv(ok(LABELS), { cursor: { status: 403, body: { error: 'no access for this store' } } });
  const r2 = await env2.AE.retrace.run();
  assert.match(r2.note, /no access: no access for this store/); assert.deepEqual(plain(r2.errors), []);
});

// ---- gates
await t('Retrace: no new pass while Portal is down, even when one is due (and one runs when it is up)', async () => {
  const due = { ae_retrace_pass_at: Date.now() - 11 * MIN };
  const env = retraceEnv(ok(LABELS), { gm: due });
  for (let i = 0; i < 3; i++) env.AE.health.fail('http', { status: 504, message: 'x' });
  assert.equal(await env.AE.retrace.tick(), null);
  assert.equal(env.fetchLog.length, 0); assert.match(env.AE.retrace.state().lastSkip.why, /Portal is down/);
  const env2 = retraceEnv(ok(LABELS), { gm: due });
  const r = await env2.AE.retrace.tick();
  assert.ok(r && r.itemsRead === 1, 'control: the due pass runs');
});
await t('Retrace docs: an unrecognised PO list answer does not complete the PO backfill', async () => {
  const env = retraceEnv(ok(LABELS), { todo: [], poList: ok({ message: 'busy' }) }); // SYNTHETIC bad answer
  const r = await env.AE.retrace.run();
  assert.ok(r.errors.some((e) => /purchase orders/.test(e)), JSON.stringify(r.errors));
  assert.equal((env.sweeps().at(-1).cursors || {}).po_backfill, undefined, 'the backfill cursor is not advanced / marked done');
});
await t('Retrace docs: the captured outstanding-parts answer is read (control)', async () => {
  const env = retraceEnv(ok(LABELS), { todo: [], outstanding: ok(OUTSTANDING) });
  const r = await env.AE.retrace.run();
  assert.ok(!r.errors.some((e) => /outstanding parts/.test(e)), JSON.stringify(r.errors)); assert.ok(r.labels >= 1);
});
await t('Retrace docs: outstanding parts without any of its three lists is a failed read', async () => {
  const env = retraceEnv(ok(LABELS), { todo: [], outstanding: ok({ x: 1 }) }); // SYNTHETIC bad answer
  const r = await env.AE.retrace.run();
  assert.ok(r.errors.some((e) => /outstanding parts/.test(e)), JSON.stringify(r.errors));
  assert.equal(env.AE.health.state().shapeFails >= 1, true, 'counted as a shape failure');
});

// ---- M: the watcher
await t('Retrace watcher: a fetch(Request) write is seen with its body, and goes out untouched', async () => {
  const env = retraceEnv(ok(LABELS));
  const hook = env.scripts.find((s) => s.id === 'ae-retrace-hook');
  assert.ok(hook, 'the watcher script was added to the page');
  const seen = [], sentToPortal = [];
  const answer = new Response('{"ok":true}', { status: 200 });
  const page = { Promise, JSON, String, RegExp, Date, Array, Object, Math, Request, Response, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    document: { dispatchEvent: (e) => { seen.push(JSON.parse(e.detail)); return true; } } };
  // Portal's fetch: like the browser's, it uses up a Request's body as it sends it
  page.fetch = function (input, init) { sentToPortal.push(input); if (input instanceof Request) input.text(); return Promise.resolve(answer); };
  page.window = page;
  vm.createContext(page);
  vm.runInContext(hook.code, page);
  const req = new Request('https://portal.ubreakifix.net/api/boh/inventory/176255-0000514371/adjust-out', { method: 'POST', body: '{"reason":"test"}' }); // SYNTHETIC write
  const res = await page.window.fetch(req);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(res, answer, 'Portal gets its own answer back'); assert.equal(sentToPortal[0], req, 'the very Request Portal made went out');
  assert.equal(seen.length, 1, 'seen'); assert.equal(seen[0].body, '{"reason":"test"}'); assert.equal(seen[0].method, 'POST'); assert.equal(seen[0].response, '{"ok":true}');
});
