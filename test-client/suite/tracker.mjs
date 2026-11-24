// Client suite, part of `node test-client/run.mjs` (which loads these files in order; see its top for how the tests work).
import assert from 'node:assert/strict';
import { load, retraceFx } from '../harness.mjs';
import { t, woTemplate, WO_ANSWER, plain, USER, ok, router, posted } from './common.mjs';

// ================================================================== Tracker: partial snapshots
const CART_ID = 'CART-1'; // SYNTHETIC: the template's csuCartId is blanked, so the cart call only happens when a test sets one
const trackerEnv = async (overrides = {}) => {
  const probe = load(['00-core.js', '27-tracker.js']);
  const { publicJwk } = await probe.AE.tracker.crypto.newKeyPair();
  const wos = overrides.wos || [1001];
  const rowOf = (wo) => ({ workorderId: wo, workorderStatusId: 14, workorderStatusName: 'Sale complete', programId: 1, programName: 'Test', updatedAt: '2026-10-24T10:00:00Z' }); // SYNTHETIC list row (fields the code reads)
  const cartId = overrides.cartId || WO_ANSWER.workorder.csuCartId;
  const per = (name, dflt) => (b, path) => { const wo = Number((/(\d{4,})/.exec(path) || [])[1]); const o = (overrides.byWo && overrides.byWo[wo] && overrides.byWo[wo][name]) || overrides[name]; return o || dflt(wo); };
  const routes = [
    ...(overrides.routes || []),
    ['GET', /^\/api\/auth\/user$/, ok(USER)],
    ['POST', /^\/api\/workorders$/, (b) => ok({ workOrders: b.primaryFilter === 'Active' ? wos.map(rowOf) : [], rowCount: b.primaryFilter === 'Active' ? wos.length : 0 })],
    ['GET', /^\/v1\/914\/tracker\/key$/, ok({ publicJwk })],
    ['POST', /^\/v1\/914\/tracker\/scan$/, ok({ need: wos.map((wo) => ({ wo, why: 'changed' })) })],
    ['POST', /^\/v1\/914\/tracker\/wo\/\d+$/, ok({ same: false })],
    ['POST', /^\/v1\/914\/tracker\/sales$/, ok({})],
    ['POST', /^\/v1\/914\/tracker\/daily$/, overrides.daily || ok({})],
    ['GET', /^\/api\/workorder\/\d+$/, per('core', (wo) => ok(overrides.cartId ? { ...WO_ANSWER, workorder: { ...WO_ANSWER.workorder, workorderId: wo, csuCartId: overrides.cartId } } : { ...WO_ANSWER, workorder: { ...WO_ANSWER.workorder, workorderId: wo } }))],
    ['GET', /^\/api\/workorder-audit-trail\/\d+$/, per('audit', () => ok([]))],                     // SYNTHETIC: the shape of an empty trail
    ['GET', /^\/api\/note\?/, per('notes', () => ok({ notes: [], total: 0, latestManualNote: null }))], // SYNTHETIC empty notes page
    ['GET', /^\/api\/workorder\/\d+\/events/, per('events', () => ok({ events: [] }))],
    ['GET', new RegExp('^/api/get-cart/' + cartId), overrides.cart || ok(woTemplate.cart)],
    ['GET', /^\/api\/v1\/workorder\/\d+\/demographic\/customer-data$/, ok({})],
    ['GET', /^\/api\/reporting\/sales-history/, ok({ results: [] })], // SYNTHETIC empty sales page
  ];
  const env = load(['00-core.js', '27-tracker.js'], { fetch: router(routes), timers: overrides.timers, gm: overrides.gm });
  return env;
};
await t('Tracker: a complete detail is posted (control)', async () => {
  const env = await trackerEnv();
  const r = await env.AE.tracker.scan({ force: true });
  assert.equal(r.sent, 1, JSON.stringify(r)); assert.equal(r.partial, 0);
  assert.equal(posted(env.fetchLog, /tracker\/wo\/1001$/).length, 1);
  assert.ok(env.gm.get('ae_wod_914') && env.gm.get('ae_wod_914')['1001'], 'a complete copy is cached');
});
// ---- Tracker: sold WOs' parts for Retrace (GET /api/workorder/{wo}/salesorder/{csuCartId} → POST …/retrace/wo-sold)
const SALES_ORDER = retraceFx('wo-salesorder'); // keys as captured Oct 25, 2026; values made up (fixtures README)
const soldEnv = (o = {}) => trackerEnv(Object.assign({ cartId: CART_ID, routes: [
  ['GET', /^\/api\/workorder\/\d+\/salesorder\//, o.salesOrder || ok({ ...SALES_ORDER, cartId: CART_ID })],
  ['POST', /^\/v1\/914\/tracker\/retrace\/wo-sold\/need$/, o.need || ok({ wos: [], left: 0 })],
  ['POST', /^\/v1\/914\/tracker\/retrace\/wo-sold$/, (b) => ok({ done: b.results.filter((r) => r.order).length, empty: 0, failed: b.results.filter((r) => r.failed).length })],
  ...(o.routes || []),
] }, o.env || {}));
const soldPosts = (env) => env.requests(/\/retrace\/wo-sold$/, 'POST').map((r) => r.body);
await t('Tracker sold parts: a WO uploaded as Sale complete gets its sales order read; only part lines go up (no labor, credit, B- buyback)', async () => {
  const env = await soldEnv();
  const r = await env.AE.tracker.scan({ force: true });
  const reads = env.requests(/\/salesorder\//);
  assert.equal(reads.length, 1); assert.match(reads[0].url, /\/api\/workorder\/1001\/salesorder\/CART-1$/);
  const [first] = soldPosts(env);
  assert.equal(first.results.length, 1); assert.equal(first.results[0].wo, '1001'); assert.equal(first.results[0].cart_id, CART_ID);
  const o = first.results[0].order;
  assert.deepEqual(plain(o.salesLines.map((l) => l.serial)), ['180001-0000600001'], 'part lines only');
  assert.deepEqual(Object.keys(o).sort(), ['cartId', 'salesDate', 'salesId', 'salesLines', 'storeId'], 'no payment sent');
  assert.ok(!('grossAmount' in o.salesLines[0]) && !('program' in o.salesLines[0]), 'only the kept line fields');
  assert.equal(o.salesId, 'FSO000700001');
  assert.deepEqual(plain(env.requests(/wo-sold\/need$/, 'POST').map((x) => x.body.want)), [25], 'then the backfill asks for 25');
  assert.equal(r.soldParts.read, 1); assert.equal(r.soldParts.done, 1);
});
await t('Tracker sold parts: the backfill reads what the Worker hands out (oldest first, its order), skipping a WO already read this scan, 25 at most', async () => {
  const wos = [{ wo: '1001', cart_id: CART_ID }, ...Array.from({ length: 30 }, (_, i) => ({ wo: String(2000 + i), cart_id: 'C-' + i }))];
  const env = await soldEnv({ need: ok({ wos, left: 31 }) });
  const r = await env.AE.tracker.scan({ force: true });
  const reads = env.requests(/\/salesorder\//).map((x) => x.url.replace(/^.*\/api\/workorder\//, ''));
  assert.equal(reads.length, 1 + 25); assert.equal(reads[1], '2000/salesorder/C-0'); assert.ok(!reads.slice(1).some((u) => u.startsWith('1001/')));
  assert.equal(soldPosts(env).at(-1).results.length, 25); assert.equal(r.soldParts.left, 31);
});
await t('Tracker sold parts: a WO that is not Sale complete is not read', async () => {
  const env = await soldEnv({ env: { core: ok({ ...WO_ANSWER, workorder: { ...WO_ANSWER.workorder, workorderId: 1001, workorderStatusId: 10, csuCartId: CART_ID } }) } });
  await env.AE.tracker.scan({ force: true });
  assert.equal(env.requests(/\/salesorder\//).length, 0); assert.equal(soldPosts(env).length, 0);
});
for (const [name, answer] of [['{}', ok({})], ['salesLines not a list', ok({ ...SALES_ORDER, salesLines: 'x' })], ['the SPA shell (text)', { status: 200, body: '<!doctype html><html></html>' }], ['a 404', { status: 404, body: { message: 'Not Found' } }]]) {
  await t('Tracker sold parts: ' + name + ' is reported as a failed read, never as a sale with no parts', async () => { // SYNTHETIC bad answers
    const env = await soldEnv({ salesOrder: answer });
    await env.AE.tracker.scan({ force: true });
    const [p0] = soldPosts(env);
    assert.ok(p0 && p0.results.length === 1 && p0.results[0].failed && !p0.results[0].order, JSON.stringify(p0));
  });
}
await t('Tracker sold parts: Portal in trouble (504) stops the reads and reports nothing (an outage never uses up a WO\'s tries)', async () => {
  const env = await soldEnv({ salesOrder: { status: 504, body: 'Endpoint request timed out' }, need: ok({ wos: [{ wo: '2001', cart_id: 'C-1' }], left: 1 }) });
  const r = await env.AE.tracker.scan({ force: true });
  assert.equal(env.requests(/\/salesorder\//).length, 1); assert.equal(soldPosts(env).length, 0); assert.match(r.soldParts.stopped, /Portal trouble/);
  assert.equal(env.requests(/wo-sold\/need$/, 'POST').length, 0, 'no backfill either');
});
await t('Tracker sold parts: a Worker without the route (404) is skipped quietly', async () => {
  const env = await soldEnv({ routes: [] , need: { status: 404, body: { error: 'not found' } } });
  const r = await env.AE.tracker.scan({ force: true });
  assert.ok(!r.errors.some((e) => /sold parts/.test(e)), JSON.stringify(r.errors)); assert.equal(r.soldParts.note, 'tracker Worker has no sold-parts route yet');
});
for (const [part, override] of [['audit trail', { audit: { status: 500, body: 'x' } }], ['notes', { notes: { status: 504, body: 'x' } }], ['cart', { cartId: CART_ID, cart: { status: 500, body: 'x' } }], ['events', { events: { status: 500, body: 'x' } }]]) {
  await t('Tracker: a failed ' + part + ' means no upload for that work order, and nothing cached', async () => {
    const env = await trackerEnv(override);
    const r = await env.AE.tracker.scan({ force: true });
    assert.equal(r.sent, 0); assert.equal(r.partial, 1, JSON.stringify(r)); assert.equal(r.failed, 0);
    assert.deepEqual(env.requests(/tracker\/wo\/1001$/, 'POST'), [], 'no snapshot posted');
    const cache = env.gm.get('ae_wod_914') || {};
    assert.equal(cache['1001'], undefined, 'the partial copy is not kept');
  });
}
await t('Tracker: a malformed work order answer is a failure, not an upload', async () => {
  for (const core of [ok({}), ok('Gateway'), { status: 200, body: 'plain' }]) { // SYNTHETIC bad answers
    const env = await trackerEnv({ core });
    const r = await env.AE.tracker.scan({ force: true });
    assert.equal(r.sent, 0); assert.equal(r.failed, 1, JSON.stringify(r));
    assert.deepEqual(posted(env.fetchLog, /tracker\/wo\/1001$/), []);
  }
});
await t('Tracker: no scan while Portal is down (AE.health)', async () => {
  const env = await trackerEnv();
  for (let i = 0; i < 3; i++) env.AE.health.fail('http', { status: 504, message: 'x' });
  assert.equal(await env.AE.tracker.scan({ force: true }), null);
  assert.equal(env.fetchLog.length, 0);
});

await t('Tracker: Portal going down mid-scan stops the loop (AE.health.tripped), the rest wait for the next scan', async () => {
  const fail = { status: 504, body: 'x' };
  const env = await trackerEnv({ wos: [1001, 1002, 1003], byWo: { 1001: { core: fail, audit: fail, notes: fail, events: fail } } }); // SYNTHETIC outage on WO 1001's calls
  const r = await env.AE.tracker.scan({ force: true });
  assert.equal(env.AE.health.state().down, true, JSON.stringify(r));
  assert.match(r.note || '', /Portal is down: stopped/);
  assert.deepEqual(env.requests(/^\/api\/workorder\/100[23]/), [], 'WOs 1002 and 1003 were not asked');
});
await t('Tracker: a WO whose detail stays partial is sent on the 4th try, flagged plain.partial; a complete send clears the count', async () => {
  const env = await trackerEnv({ notes: { status: 504, body: 'x' } });
  for (let i = 1; i <= 3; i++) {
    const r = await env.AE.tracker.scan({ force: true });
    env.AE.health.reset(); // one 504 a scan; keep the breaker out of this test
    assert.equal(r.partial, 1, 'try ' + i + ': ' + JSON.stringify(r)); assert.match(r.errors[0], new RegExp('notes:504.*' + i + '/3'));
    assert.deepEqual(env.requests(/tracker\/wo\/1001$/, 'POST'), []);
  }
  const r = await env.AE.tracker.scan({ force: true });
  assert.equal(r.sentPartial, 1, JSON.stringify(r));
  const sent = env.requests(/tracker\/wo\/1001$/, 'POST');
  assert.equal(sent.length, 1); assert.deepEqual(plain(sent[0].body.plain.partial), ['notes:504']);
  assert.deepEqual(plain(env.gm.get('ae_tracker_partial_914')), {}, 'count cleared after the send');
});
await t('Tracker: a sub-part 404 is named as such (still a failure: what a 404 means there is not captured)', async () => {
  const env = await trackerEnv({ audit: { status: 404, body: { error: 'x' } } });
  const r = await env.AE.tracker.scan({ force: true });
  assert.equal(r.partial, 1); assert.match(r.errors[0], /audit_trail:404/);
});
await t('Tracker daily: the Worker\'s 403 (no access) is quiet; any other failure is noted', async () => {
  const env = await trackerEnv({ daily: { status: 403, body: { error: 'no access' } } });
  const day = new Date(env.clock.now).toISOString().slice(0, 10);
  assert.equal(await env.AE.tracker.daily(914, day, { x: 1 }, 'test'), false);
  assert.equal(env.AE.recentErrors.length, 0);
  const env2 = await trackerEnv({ daily: { status: 500, body: { error: 'boom' } } });
  assert.equal(await env2.AE.tracker.daily(914, day, { x: 1 }, 'test'), false);
  assert.equal(env2.AE.recentErrors.length, 1);
});
