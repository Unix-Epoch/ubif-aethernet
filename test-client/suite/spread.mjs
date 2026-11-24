// Client suite, part of `node test-client/run.mjs` (which loads these files in order; see its top for how the tests work).
import assert from 'node:assert/strict';
import { load } from '../harness.mjs';
import { t, plain, USER, ok, router } from './common.mjs';

// ================================================================== Spread (the Board view of the Work orders list)
// A list row with the field set of sandbox/api.py's wo_row (modelled on Portal's captured list answer, plus attentionState / attentionReasons); every value is
// SYNTHETIC. Personal fields (phone, email, imei) are filled on purpose: a card must never show them.
const SP_NOW = Date.parse('2026-11-11T18:00:00Z');
const spAgo = (h) => new Date(SP_NOW - h * 3600000).toISOString();
let spN = 700000000;
const spRow = (o = {}) => ({
  workorderId: ++spN, workorderStatusId: 8, workorderStatusName: 'Ready for work', programId: 9470, programName: 'Fake Program', createdAt: spAgo(100), updatedAt: spAgo(5), nextUpdate: spAgo(-4),
  customer: { customerId: 1, fullName: 'Pat Example', phone: '5550100', email: 'pat@example.invalid' }, customerDevice: { name: 'Pat phone nickname', imei: '123456789012345' },
  customerDeviceId: 5, deviceCatalog: { name: 'Fake Phone 9' }, deviceIssues: ['Screen'], serviceOutcome: '', workorderTotal: '$100.00', claimNumber: null, clientId: 1,
  attentionState: '', attentionReasons: [], matchedRules: [], itemswithdevice: '', locationBin: '', rfpWorkorderStatusDate: null, createdBy: { givenName: 'Fake', familyName: 'Tech' }, ...o,
});
const SP = load(['00-core.js', '59-spread.js']).AE.spread;
const spCards = (rows) => SP.layout(rows, SP_NOW);

await t('Spread: every open status lands in its column; an open status with no column (5, 6, 17, 26, 27, unknown, none) goes to Waiting', () => {
  const want = { 2: 0, 3: 3, 8: 1, 24: 1, 9: 2, 10: 2, 11: 2, 12: 2, 4: 3, 7: 3, 13: 4, 5: 3, 6: 3, 17: 3, 26: 3, 27: 3, 99: 3 };
  for (const [st, ci] of Object.entries(want)) assert.equal(SP.columnIndex(Number(st)), ci, 'status ' + st);
  assert.equal(SP.columnIndex(SP.statusOf(spRow({ workorderStatusId: null }))), 3); assert.equal(SP.columnIndex(SP.statusOf(spRow({ workorderStatusId: 'x' }))), 3);
  const cols = spCards([spRow({ workorderStatusId: 26, workorderStatusName: 'Fake status 26' }), spRow({ workorderStatusId: 13, workorderStatusName: 'Ready for pickup' }), spRow({ workorderStatusId: 4, workorderStatusName: 'Awaiting device' })]);
  assert.deepEqual(plain(cols.map((c) => c.cards.length)), [0, 0, 0, 2, 1]); // no row is dropped
  const odd = cols[3].cards.find((c) => c.status === 26);
  assert.equal(odd.statusName, 'Fake status 26'); assert.equal(odd.showStatus, true); // its real name stays on the card
  assert.equal(cols[4].cards[0].showStatus, false); // a one-status column's header already says it
  assert.deepEqual(plain(SP.COLUMNS.map((c) => [c.name, c.ids])), [['Need to order', [2]], ['Ready to start', [8, 24]], ['Work started', [9, 10, 11, 12]], ['Waiting', [3, 4, 7]], ['Ready for pickup', [13]]]);
});
await t('Spread: cards are oldest first by the time they show; no time = last; ties by WO number', () => {
  const a = spRow({ workorderStatusId: 9, updatedAt: spAgo(5) }), b = spRow({ workorderStatusId: 9, updatedAt: spAgo(60) }), c = spRow({ workorderStatusId: 9, updatedAt: null }), d = spRow({ workorderStatusId: 9, updatedAt: spAgo(30) });
  const e = spRow({ workorderStatusId: 9, updatedAt: spAgo(30) });
  assert.deepEqual(plain(spCards([a, c, b, e, d])[2].cards.map((x) => x.id)), [b.workorderId, d.workorderId, e.workorderId, a.workorderId, c.workorderId]);
  const r1 = spRow({ workorderStatusId: 13, rfpWorkorderStatusDate: spAgo(3), updatedAt: spAgo(500) }), r2 = spRow({ workorderStatusId: 13, rfpWorkorderStatusDate: spAgo(80), updatedAt: spAgo(1) });
  assert.deepEqual(plain(spCards([r1, r2])[4].cards.map((x) => x.id)), [r2.workorderId, r1.workorderId]); // by the RFP date it shows, not updatedAt
  const fut = spRow({ workorderStatusId: 9, updatedAt: new Date(SP_NOW + 7200000).toISOString() }), nowRow = spRow({ workorderStatusId: 9, updatedAt: new Date(SP_NOW).toISOString() });
  assert.deepEqual(plain(spCards([nowRow, fut])[2].cards.map((x) => x.id)), [fut.workorderId, nowRow.workorderId]); // a time ahead of the clock counts as now (ties by WO number)
});
await t('Spread: "in status" only for Ready for pickup with Portal\'s rfpWorkorderStatusDate; everything else says "Updated … ago" from updatedAt', () => {
  const card = (o) => SP.cardOf(spRow(o), SP_NOW);
  assert.equal(card({ workorderStatusId: 13, rfpWorkorderStatusDate: spAgo(4), updatedAt: spAgo(100) }).time, '4h in status');
  assert.equal(card({ workorderStatusId: 13, rfpWorkorderStatusDate: null, updatedAt: spAgo(30) }).time, 'Updated 1d 6h ago'); // no RFP date: honest wording
  assert.equal(card({ workorderStatusId: 13, rfpWorkorderStatusDate: 'not a date', updatedAt: spAgo(7) }).time, 'Updated 7h ago');
  assert.equal(card({ workorderStatusId: 9, rfpWorkorderStatusDate: spAgo(900), updatedAt: spAgo(52) }).time, 'Updated 2d 4h ago'); // another column ignores the RFP date
  assert.equal(card({ workorderStatusId: 9, updatedAt: null }).time, ''); assert.equal(card({ workorderStatusId: 9, updatedAt: null }).since, null);
  assert.equal(card({ workorderStatusId: 9, updatedAt: spAgo(0.2) }).time, 'Updated <1h ago');
  assert.equal(card({ workorderStatusId: 9, updatedAt: new Date(SP_NOW + 7200000).toISOString() }).time, 'Updated <1h ago'); // a clock ahead of Portal's never reads negative
  assert.equal(SP.ageText(23), '23h'); assert.equal(SP.ageText(24), '1d 0h'); assert.equal(SP.ageText(120), '5d 0h');
});
await t('Spread: a card is "old" from 7 days in Waiting and Ready for pickup, 3 days in every other column, not before', () => {
  assert.deepEqual(plain(SP.COLUMNS.map((c) => c.oldHours)), [72, 72, 72, 168, 168]);
  for (const [st, h] of [[2, 72], [8, 72], [24, 72], [10, 72], [3, 168], [4, 168], [7, 168], [17, 168]]) { // 17: no column of its own, so Waiting's rule
    assert.equal(SP.cardOf(spRow({ workorderStatusId: st, updatedAt: spAgo(h - 0.1) }), SP_NOW).old, false, st + ' before');
    assert.equal(SP.cardOf(spRow({ workorderStatusId: st, updatedAt: spAgo(h) }), SP_NOW).old, true, st + ' at');
  }
  assert.equal(SP.cardOf(spRow({ workorderStatusId: 13, rfpWorkorderStatusDate: spAgo(167.9), updatedAt: spAgo(500) }), SP_NOW).old, false); // RFP: time in status, not updatedAt
  assert.equal(SP.cardOf(spRow({ workorderStatusId: 13, rfpWorkorderStatusDate: spAgo(168) }), SP_NOW).old, true);
  assert.equal(SP.cardOf(spRow({ updatedAt: null }), SP_NOW).old, false);
});
await t('Spread: the RFP total shows only in the Ready for pickup header, and only with a real figure', () => {
  const rfp = { value: 1049.6 };
  assert.deepEqual(plain(SP.COLUMNS.map((c) => SP.header(c, [1], rfp).rfp)), [null, null, null, null, 'RFP total $1,050']); // Master\'s Mend rounds the same way
  assert.equal(SP.header(SP.COLUMNS[4], [1], null).rfp, null); assert.equal(SP.header(SP.COLUMNS[4], [1], { value: NaN }).rfp, null); assert.equal(SP.header(SP.COLUMNS[4], [1], { value: undefined }).rfp, null);
  assert.equal(SP.header(SP.COLUMNS[4], [], rfp).rfp, null); // an empty column shows no figure
  assert.equal(SP.header(SP.COLUMNS[4], [1, 2, 3], rfp).count, 3);
});
await t('Spread: a card carries only what the board shows: no phone, email, serial or IMEI; attention only for warning/urgent; device falls back to the nickname', () => {
  const c = SP.cardOf(spRow({ attentionState: 'urgent', attentionReasons: ['Part late', { odd: 1 }, 5] }), SP_NOW);
  const text = JSON.stringify(c); for (const secret of ['5550100', 'pat@example.invalid', '123456789012345']) assert.ok(!text.includes(secret), secret);
  assert.equal(c.attention, 'urgent'); assert.deepEqual(plain(c.reasons), ['Part late']); assert.equal(c.customer, 'Pat Example'); assert.equal(c.href, '/repair/workorder/' + c.id);
  for (const none of ['', 'none', undefined, 'other']) assert.equal(SP.cardOf(spRow({ attentionState: none }), SP_NOW).attention, null, String(none));
  assert.equal(SP.cardOf(spRow({ attentionState: 'warning' }), SP_NOW).attention, 'warning'); assert.deepEqual(plain(SP.cardOf(spRow({ attentionState: 'none', attentionReasons: ['x'] }), SP_NOW).reasons), []);
  assert.equal(SP.cardOf(spRow({ deviceCatalog: { name: null } }), SP_NOW).device, 'Pat phone nickname'); assert.equal(SP.cardOf(spRow(), SP_NOW).device, 'Fake Phone 9');
  assert.equal(SP.cardOf(spRow({ deviceIssues: ['Screen', 'Battery'] }), SP_NOW).issue, 'Screen, Battery');
});
await t('Spread: the deal-in stagger is column × 40 ms + row × 30 ms, rows past the sixth wait no longer; counts follow at column × 40 + 60', () => {
  assert.equal(SP.dealDelay(0, 0), 0); assert.equal(SP.dealDelay(2, 3), 80 + 90); assert.equal(SP.dealDelay(4, 6), 160 + 180);
  assert.equal(SP.dealDelay(4, 7), 340); assert.equal(SP.dealDelay(4, 44), 340);
  assert.deepEqual(plain([0, 1, 2, 3, 4].map(SP.headDelay)), [60, 100, 140, 180, 220]);
});
await t('Spread: refreshes only while the board is shown, the tab is visible, nothing is loading, Portal is up, and the list is stale', () => {
  const run = (st, down = false) => { const env = load(['00-core.js', '59-spread.js']); if (down) for (let i = 0; i < 3; i++) env.AE.health.fail('http', { status: 504, message: 'x' }); return env.AE.spread.refreshDue({ shown: true, busy: false, hidden: false, last: 0, every: 60000, ...st }, 100000); };
  assert.equal(run({}), true);
  assert.equal(run({}, true), false); // Portal is down: skip quietly
  assert.equal(run({ hidden: true }), false); assert.equal(run({ shown: false }), false); assert.equal(run({ busy: true }), false); assert.equal(run({ last: 60000 }), false); assert.equal(run({ last: 40000 }), true);
});
const SP_BODY = { page: 1, pageSize: 100, deviceTypeIds: [], serviceOutcome: [], programIds: [], needsAttention: false, workOrderStatusIds: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 17, 24, 26, 27], order: 'nextUpdate,DESC', tab: 'All', primaryFilter: 'Active' };
const spServer = (rows, perPage = 100) => router([['GET', /^\/api\/auth\/user$/, ok(USER)], ['POST', /^\/api\/workorders$/, (b) => ok({ workOrders: b.primaryFilter === 'Active' ? rows.slice((b.page - 1) * perPage, b.page * perPage) : [], rowCount: b.primaryFilter === 'Active' ? rows.length : 0 })]]);
await t('Spread: reads the list with the captured open-orders call, only open ones, and pages by rowCount (a short page does not end it)', async () => {
  const rows = Array.from({ length: 250 }, () => spRow());
  for (const per of [100, 60]) { // Portal honoring pageSize 100, then sending fewer rows per page than asked
    const env = load(['00-core.js', '59-spread.js'], { fetch: spServer(rows, per) });
    const got = await env.AE.spread.read();
    assert.equal(got.length, 250, 'per ' + per);
    const sent = env.requests(/^\/api\/workorders$/, 'POST');
    assert.deepEqual(plain(sent[0].body), SP_BODY); assert.deepEqual(sent.map((r) => r.body.page), per === 100 ? [1, 2, 3] : [1, 2, 3, 4, 5]);
    assert.ok(sent.every((r) => r.body.primaryFilter === 'Active')); // no closed pages
  }
});
await t('Spread: a reply with no list is a bad shape (counted, thrown), not "no open work orders"; a real empty list is just empty', async () => {
  const env = load(['00-core.js', '59-spread.js'], { fetch: router([['GET', /^\/api\/auth\/user$/, ok(USER)], ['POST', /^\/api\/workorders$/, ok({ rowCount: 0, somethingElse: [] })]]) });
  const e = await env.AE.spread.read().catch((x) => x);
  assert.ok(e instanceof env.AE.BadShape, String(e && e.message)); assert.equal(env.AE.health.state().shapeFails, 1);
  const env2 = load(['00-core.js', '59-spread.js'], { fetch: spServer([]) });
  assert.deepEqual(plain(await env2.AE.spread.read()), []); assert.equal(env2.AE.health.state().shapeFails, 0);
});
await t('Spread: a list row with no work order number is left off (and noted), the rest are kept', async () => {
  const good = spRow(), env = load(['00-core.js', '59-spread.js'], { fetch: spServer([good, spRow({ workorderId: null }), spRow({ workorderId: undefined }), spRow({ workorderId: 'x' })]) });
  const got = await env.AE.spread.read();
  assert.deepEqual(plain(got.map((r) => r.workorderId)), [good.workorderId]); assert.match(env.AE.recentErrors.at(-1).message, /3 list row\(s\) without a numeric workorderId/);
});
