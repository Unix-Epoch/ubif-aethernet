// Aethernet client tests: the shared core (AE.api, ApiError, AE.shape, AE.health) and the shards' data-integrity guards
// (Return's draft delete, Retrace's label reads, the tracker's partial snapshots, Waymark's bad shapes).
//
//   node test-client/run.mjs              (or: npm test --prefix test-client, or: python3 test-client/run.py)
//
// The src files load into a Node vm with stubbed browser globals (test-client/harness.mjs); `fetch` is stubbed per test.
// Responses come from the captured fixtures (tracker-worker/test/fixtures/retrace/*.json, sandbox/fixtures/wo-template.json).
// Anything built here by hand is marked SYNTHETIC: a bad shape a real Portal is not known to send, or a stand-in for an answer
// no capture covers yet. Nothing here is evidence of a Portal shape beyond what the fixture it is copied from proves.
// Exit code 0 = all passed. Needs Node 18+ and nothing from npm. No Portal, no Worker, no browser is touched.
import assert from 'node:assert/strict';
import { load, retraceFx, fixture, extractFn } from './harness.mjs';
import vm from 'node:vm';

const results = [];
async function t(name, fn) {
  try { await fn(); results.push([name, true]); console.log('ok   ' + name); }
  catch (e) { results.push([name, false]); console.log('FAIL ' + name + '\n     ' + String((e && e.stack) || e).split('\n').slice(0, 6).join('\n     ')); }
}

// ------------------------------------------------------------------ fixtures
const STORE = 914;
const woTemplate = fixture('sandbox/fixtures/wo-template.json'); // GET /api/workorder/{id} as { workorder: {...}, ... } + the cart (values blanked)
const WO_ANSWER = woTemplate.workorder;                          // captured shape: { workorder: { workorderStatusId: 14, csuCartId, storeId, … }, stage, … }
const withStatus = (n) => ({ ...WO_ANSWER, workorder: { ...WO_ANSWER.workorder, workorderStatusId: n } }); // the same answer at another status
const LABELS = retraceFx('store-products');                      // { @odata.context, @odata.count: 3, value: [3 rows] }
const ZERO_LABELS = { ...LABELS, '@odata.count': 0, value: [] }; // SYNTHETIC: the captured envelope with the count and rows emptied (what a real zero looks like)
const PO_LIST = retraceFx('po-list');
const OUTSTANDING = retraceFx('outstanding-parts');
const NO_PARTS = { RMAParts: [], BuybackParts: [], SalvageParts: [] }; // SYNTHETIC: the captured answer's three lists emptied (keeps the pass's own label counts clean)
const plain = (x) => JSON.parse(JSON.stringify(x === undefined ? null : x));
const USER = { user: { userId: 1, givenName: 'Test', familyName: 'Tech' }, currentStore: { storeId: STORE, storeName: 'Test store' } }; // SYNTHETIC stand-in for /api/auth/user

const ok = (body) => ({ status: 200, body });
// A fetch stub from a route table: [method, RegExp on the path+query, handler(body, url, init) → { status, body }].
const router = (routes) => (url, init = {}) => {
  const method = init.method || 'GET', path = url.replace(/^https?:\/\/[^/]+/, '');
  for (const [m, re, fn] of routes) if (m === method && re.test(path)) return typeof fn === 'function' ? fn(init.body ? JSON.parse(init.body) : undefined, path, init) : fn;
  return { status: 404, body: { error: 'no stub for ' + method + ' ' + path } };
};
const posted = (log, re, method = 'POST') => log.filter((r) => r.method === method && re.test(r.url));

// ================================================================== AE.api
await t('api: a JSON answer comes back; a write\'s empty body is null', async () => {
  const { AE } = load(['00-core.js'], { fetch: router([['GET', /^\/a$/, ok({ x: 1 })], ['PUT', /^\/a$/, { status: 200, body: '' }]]) });
  assert.deepEqual(JSON.parse(JSON.stringify(await AE.api('GET', '/a'))), { x: 1 });
  assert.equal(await AE.api('PUT', '/a', {}), null);
});

await t('api: 401 = session expired (sessionExpired true), exact message', async () => {
  const { AE } = load(['00-core.js'], { fetch: () => ({ status: 401, body: 'nope' }) });
  const e = await AE.api('GET', '/x').catch((x) => x);
  assert.ok(e instanceof AE.ApiError);
  assert.equal(e.message, 'Your Portal session expired. Log in again.');
  assert.equal(e.status, 401); assert.equal(e.sessionExpired, true); assert.equal(e.path, '/x'); assert.equal(e.method, 'GET');
});

await t('api: 403 keeps the session-expired message but is status 403, sessionExpired false', async () => {
  const { AE } = load(['00-core.js'], { fetch: () => ({ status: 403, body: 'forbidden' }) });
  const e = await AE.api('GET', '/x').catch((x) => x);
  assert.equal(e.message, 'Your Portal session expired. Log in again.');
  assert.equal(e.status, 403); assert.equal(e.sessionExpired, false);
});

await t('api: 5xx message is "METHOD path → HTTP n: body" (what the shards\' regexes read), body capped at 200', async () => {
  const { AE } = load(['00-core.js'], { fetch: () => ({ status: 504, body: 'Endpoint request timed out' + 'x'.repeat(300) }) });
  const e = await AE.api('POST', '/api/y', { a: 1 }).catch((x) => x);
  assert.match(e.message, /^POST \/api\/y → HTTP 504: Endpoint request timed out/);
  assert.match(e.message, /HTTP 504/); assert.equal(e.status, 504); assert.equal(e.body.length, 200); assert.equal(e.sessionExpired, false);
  assert.ok(e.message.length <= 'POST /api/y → HTTP 504: '.length + 200);
});

await t('api: 404 keeps "HTTP 404" in the message (the tracker\'s e.gone check)', async () => {
  const { AE } = load(['00-core.js'], { fetch: () => ({ status: 404, body: { error: 'x' } }) });
  const e = await AE.api('GET', '/api/workorder/1').catch((x) => x);
  assert.match(e.message, /HTTP 404/); assert.equal(e.status, 404);
});

await t('api: an HTML 200 is "returned the app page" (notJson)', async () => {
  const { AE } = load(['00-core.js'], { fetch: () => ({ status: 200, body: '<!DOCTYPE html><html></html>' }) });
  const e = await AE.api('GET', '/api/nope').catch((x) => x);
  assert.equal(e.message, 'GET /api/nope returned the app page, not data (wrong route?)');
  assert.equal(e.notJson, true); assert.equal(e.status, 200);
});

await t('api: a non-JSON 200 GET is an ApiError (notJson); { raw: true } and writes still get the text', async () => {
  const { AE } = load(['00-core.js'], { fetch: () => ({ status: 200, body: 'OK, done' }) });
  const e = await AE.api('GET', '/x').catch((x) => x);
  assert.ok(e instanceof AE.ApiError); assert.equal(e.notJson, true); assert.equal(e.status, 200);
  assert.equal(await AE.api('GET', '/x', undefined, { raw: true }), 'OK, done');
  assert.equal(await AE.api('POST', '/x', {}), 'OK, done'); // a write that happened is not turned into an error by its answer's format
});

await t('api: a hung fetch times out (ApiError status 0, "timed out", timedOut)', async () => {
  const { AE } = load(['00-core.js'], { fast: false, fetch: () => new Promise(() => {}) });
  const e = await AE.api('GET', '/slow', undefined, { timeoutMs: 20 }).catch((x) => x);
  assert.ok(e instanceof AE.ApiError); assert.equal(e.status, 0); assert.equal(e.timedOut, true); assert.match(e.message, /timed out/);
});

await t('api: a network failure is an ApiError (status 0) with the original message', async () => {
  const { AE } = load(['00-core.js'], { fetch: () => { throw new TypeError('Failed to fetch'); } });
  const e = await AE.api('GET', '/x').catch((x) => x);
  assert.ok(e instanceof AE.ApiError); assert.equal(e.status, 0); assert.equal(e.message, 'Failed to fetch');
});

await t('api: shouldStop still throws Stopped before any call', async () => {
  const { AE, fetchLog } = load(['00-core.js'], { fetch: () => ok({}) });
  await assert.rejects(AE.api('GET', '/x', undefined, { shouldStop: () => true }), (e) => e instanceof AE.Stopped);
  assert.equal(fetchLog.length, 0);
});

await t('workerCall: the Worker\'s own error text, status and ApiError class; HTTP n without one', async () => {
  const { AE } = load(['00-core.js'], { fetch: router([['GET', /^\/denied/, { status: 403, body: { error: 'no access' } }], ['GET', /^\/boom/, { status: 500, body: 'x' }], ['GET', /^\/fine/, ok({ allowed: true })]]) });
  const a = await AE.workerCall('GET', 'https://w.test/denied', {}).catch((x) => x);
  assert.ok(a instanceof AE.ApiError); assert.equal(a.message, 'no access'); assert.equal(a.status, 403);
  const b = await AE.workerCall('GET', 'https://w.test/boom', {}).catch((x) => x);
  assert.equal(b.message, 'HTTP 500'); assert.equal(b.status, 500);
  assert.deepEqual(JSON.parse(JSON.stringify(await AE.workerCall('GET', 'https://w.test/fine', {}))), { allowed: true });
});

// ================================================================== AE.shape
await t('shape.obj / list: strict by default, { lenient } opts into "empty"', async () => {
  const { AE } = load(['00-core.js']);
  const S = AE.shape;
  assert.equal(S.obj(LABELS, ['@odata.count', 'value'], 'labels'), LABELS);
  assert.throws(() => S.obj({}, ['value'], 'labels'), (e) => e instanceof AE.BadShape && e.label === 'labels' && /value/.test(e.missing));
  assert.throws(() => S.obj('text', ['value'], 'labels'), AE.BadShape);
  assert.throws(() => S.obj(null, ['value'], 'labels'), AE.BadShape);
  assert.deepEqual(plain(S.obj(null, ['value'], { label: 'x', lenient: true })), {});
  assert.equal(S.list(LABELS, 'value', 'labels').length, 3);
  assert.deepEqual(plain(S.list([], 'value')), []);
  assert.equal(S.list({ data: [1] }, ['value', 'data'], 'x').length, 1);
  assert.throws(() => S.list({}, 'value', 'labels'), AE.BadShape);
  assert.throws(() => S.list({ value: 'no' }, 'value', 'labels'), AE.BadShape);
  assert.deepEqual(plain(S.list({}, 'value', { lenient: true })), []);
});

await t('shape.workorder: the captured work order answer passes; {}, string, no status do not', async () => {
  const { AE } = load(['00-core.js']);
  const S = AE.shape;
  assert.equal(S.workorder(WO_ANSWER).workorderStatusId, 14);
  assert.equal(S.workorder(withStatus(1)).workorderStatusId, 1);
  assert.equal(S.workorder({ data: { workorderStatusId: 13 } }).workorderStatusId, 13); // the { data } wrapper every shard also accepted
  for (const bad of [{}, '', 'Gateway', null, undefined, [], { workorder: {} }, { workorder: { workorderStatusId: null } }, { workorder: { workorderStatusId: 'x' } }, { ok: true }]) {
    assert.throws(() => S.workorder(bad), (e) => e instanceof AE.BadShape, 'bad: ' + JSON.stringify(bad)); // SYNTHETIC bad cases
  }
});

// ================================================================== AE.health
const outageSetup = (extra = {}) => {
  const env = load(['00-core.js'], extra);
  const events = [], outage = [];
  env.AE.on('portal-health', (d) => events.push(d.down ? 'down' : 'up'));
  env.AE.health.hook.outageStart = (info) => outage.push(info);
  return Object.assign(env, { events, outage });
};
const failCall = (AE, status = 504) => AE.api('GET', '/x').catch(() => {});

await t('health: 3 failures in a row = down, one toast and one outage hook; interactive calls are not blocked', async () => {
  let status = 504;
  const env = outageSetup({ fetch: () => ({ status, body: status === 200 ? {} : 'x' }) });
  const { AE } = env;
  await failCall(AE); await failCall(AE);
  assert.equal(AE.health.state().down, false);
  assert.equal(AE.health.down(), false);
  await failCall(AE);
  assert.equal(AE.health.state().down, true);
  assert.deepEqual(env.events, ['down']);
  assert.equal(env.outage.length, 1);
  assert.equal(env.outage[0].failures, 3); assert.equal(env.outage[0].status, 504);
  assert.equal(env.toasts.length, 1);
  assert.match(env.toasts[0], /Portal is slow or down/); assert.match(env.toasts[0], /Aethernet is pausing its background checks and will retry on its own\./);
  assert.equal(AE.health.down(), true, 'background loops skip');
  await failCall(AE); await failCall(AE); // more failures while down: no second toast
  assert.equal(env.toasts.length, 1); assert.equal(env.outage.length, 1);
  status = 200;
  await AE.api('GET', '/x'); // an interactive call still goes out, and its answer ends the outage
  assert.equal(AE.health.state().down, false); assert.deepEqual(env.events, ['down', 'up']);
  assert.match(env.toasts[1], /Portal is back/);
});

await t('health: 4xx (not 429) count for nothing, 429 and timeouts and non-JSON do', async () => {
  let reply = { status: 404, body: {} };
  const { AE } = outageSetup({ fetch: () => reply });
  for (let i = 0; i < 5; i++) await failCall(AE);
  assert.equal(AE.health.state().failures, 0);
  reply = { status: 429, body: 'slow down' };
  await failCall(AE); await failCall(AE);
  assert.equal(AE.health.state().failures, 2);
  reply = { status: 200, body: 'not json' };
  await failCall(AE);
  assert.equal(AE.health.state().down, true);
});

await t('health: a BadShape counts (the answer\'s success is taken back)', async () => {
  const env = outageSetup({ fetch: () => ok({}) });
  const { AE } = env;
  for (let i = 0; i < 3; i++) { const j = await AE.api('GET', '/x'); assert.throws(() => AE.shape.workorder(j), AE.BadShape); }
  assert.equal(AE.health.state().down, true);
  assert.deepEqual(env.events, ['down']);
  // a valid answer in between starts the count again
  const e2 = outageSetup({ fetch: (u) => ok(/good/.test(u) ? WO_ANSWER : {}) });
  for (let i = 0; i < 2; i++) assert.throws(() => e2.AE.shape.workorder({}), e2.AE.BadShape);
  await e2.AE.api('GET', '/good'); // answer is valid and used
  assert.equal(e2.AE.shape.workorder(await e2.AE.api('GET', '/good')).workorderStatusId, 14);
  assert.equal(e2.AE.health.state().failures, 0);
  assert.equal(e2.AE.health.state().down, false);
});

await t('health: backoff 1, 2, 5, 10, 10 min; exactly one probe per window; success resets', async () => {
  let status = 504;
  const env = outageSetup({ fetch: () => ({ status, body: status === 200 ? {} : 'x' }) });
  const { AE, clock } = env, MIN = 60000;
  for (let i = 0; i < 3; i++) await failCall(AE);
  assert.equal(AE.health.state().down, true);
  clock.now += MIN - 1; assert.equal(AE.health.down(), true, 'inside the first minute');
  clock.now += 2; // past 1 min: one probe through
  assert.equal(AE.health.down(), false, 'the probe');
  assert.equal(AE.health.down(), true, 'only one probe at a time');
  assert.equal(AE.health.tripped(), false, 'the probe holder may keep calling Portal');
  await failCall(AE); // the probe fails: next window 2 min
  assert.equal(AE.health.state().level, 1);
  assert.equal(AE.health.tripped(), true);
  clock.now += 2 * MIN - 1000; assert.equal(AE.health.down(), true);
  clock.now += 2000; assert.equal(AE.health.down(), false);
  await failCall(AE); assert.equal(AE.health.state().level, 2); // 5 min
  clock.now += 5 * MIN + 1; assert.equal(AE.health.down(), false);
  await failCall(AE); assert.equal(AE.health.state().level, 3); // 10 min
  clock.now += 10 * MIN + 1; assert.equal(AE.health.down(), false);
  await failCall(AE); assert.equal(AE.health.state().level, 3, 'capped at 10 min');
  assert.equal(env.toasts.length, 1, 'one toast for the whole outage');
  clock.now += 10 * MIN + 1; assert.equal(AE.health.down(), false);
  status = 200; await AE.api('GET', '/x'); // the probe succeeds
  assert.equal(AE.health.state().down, false); assert.equal(AE.health.down(), false); assert.equal(AE.health.state().failures, 0);
  assert.deepEqual(env.events, ['down', 'up']);
  assert.equal(env.toasts.length, 2);
});

await t('health: a probe that never calls Portal is released after a minute', async () => {
  const env = outageSetup({ fetch: () => ({ status: 504, body: 'x' }) });
  const { AE, clock } = env;
  for (let i = 0; i < 3; i++) await failCall(AE);
  clock.now += 61000; assert.equal(AE.health.down(), false);
  assert.equal(AE.health.down(), true);
  clock.now += 61000; assert.equal(AE.health.down(), false, 'another caller becomes the probe');
});

await t('health: Worker calls (workerCall) do not feed Portal health', async () => {
  const { AE } = outageSetup({ fetch: () => ({ status: 500, body: 'x' }) });
  for (let i = 0; i < 5; i++) await AE.workerCall('GET', 'https://w.test/x', {}).catch(() => {});
  assert.equal(AE.health.state().failures, 0);
});

// ================================================================== Return: checkDone
const checkDoneSrc = extractFn('22-checkin-drafts.js', 'async function checkDone()');
async function returnCheckDone(answer) {
  const env = load(['00-core.js'], { fetch: router([['GET', /^\/api\/workorder\/123$/, answer]]) });
  const removed = [];
  const factory = vm.runInContext('(function (AE, call, INITIAL_CHECKIN, state) { let current = state.current;\n' + checkDoneSrc + '\n return async () => { current = state.current; await checkDone(); state.after = current; }; })', env.ctx);
  const state = { current: { id: 'draft-1', woId: 123 } };
  await factory(env.AE, async (method, path) => { removed.push(method + ' ' + path); return {}; }, 1, state)();
  return { removed, kept: state.after !== null };
}
await t('Return: a malformed 200 never deletes the draft ({}, wrong object, no status, plain text, JSON string, null)', async () => {
  // SYNTHETIC bad answers: none of these is something Portal is known to send
  for (const body of [{}, { ok: true }, { workorder: {} }, { workorder: { workorderStatusId: null } }, 'OK', '"fine"', 'null', [], '<!doctype html><html></html>']) {
    const r = await returnCheckDone({ status: 200, body });
    assert.deepEqual(r.removed, [], 'kept for ' + JSON.stringify(body));
    assert.equal(r.kept, true);
  }
});
await t('Return: a failed call (5xx, 404) keeps the draft', async () => {
  for (const status of [500, 504, 404, 401]) assert.deepEqual((await returnCheckDone({ status, body: 'x' })).removed, []);
});
await t('Return: a work order still at Initial check-in (status 1) keeps the draft', async () => {
  const r = await returnCheckDone(ok(withStatus(1)));
  assert.deepEqual(r.removed, []); assert.equal(r.kept, true);
});
await t('Return: a real work order past Initial check-in removes the draft', async () => {
  const r = await returnCheckDone(ok(WO_ANSWER)); // captured shape, status 14
  assert.deepEqual(r.removed, ['POST /draft-1/remove']); assert.equal(r.kept, false);
  const r2 = await returnCheckDone(ok(withStatus(9)));
  assert.deepEqual(r2.removed, ['POST /draft-1/remove']);
});

// ================================================================== Waymark
const waymarkEnv = (woAnswer, auto = {}) => {
  const env = load(['00-core.js', '55-waymark.js'], { fetch: router([
    ['GET', /^\/api\/auth\/user$/, ok(USER)],
    ['GET', /^\/api\/workorder\/123$/, woAnswer],
    ['GET', /^\/v1\/914$/, ok({ list: [], tags: {}, auto, rules: {}, removed: [], closed: [] })],
    ['POST', /^\/v1\/914\/(wo\/\d+\/end|auto|closed|open)$/, ok({ created: [] })],
  ]) });
  return env;
};
const wmWrites = (log) => log.filter((r) => r.method !== 'GET' && /\/v1\/914/.test(r.url)).map((r) => r.method + ' ' + r.url.replace(/^https?:\/\/[^/]+/, ''));
await t('Waymark checkWo: a bad work order answer ends nothing and writes nothing', async () => {
  for (const answer of [ok({}), ok('Gateway'), { status: 200, body: 'plain text' }, ok({ workorder: {} }), ok({ data: {} })]) { // SYNTHETIC bad answers
    const env = waymarkEnv(answer, { 123: { due: '2026-10-30' } });
    await env.AE.waymark.checkWo(123).then(() => assert.fail('should reject'), (e) => assert.ok(/BadShape|ApiError/.test(e.name), String(e)));
    assert.deepEqual(wmWrites(env.fetchLog), []);
  }
});
await t('Waymark checkWo: control, a real work order in no marked status ends its mark', async () => {
  const env = waymarkEnv(ok(WO_ANSWER), { 123: { due: '2026-10-30' } }); // captured answer, status 14 (not Ready for pickup)
  await env.AE.waymark.checkWo(123);
  assert.deepEqual(wmWrites(env.fetchLog), ['POST /v1/914/wo/123/end']);
});
await t('Waymark planScan: a list row without a numeric status is unknown, never ends a mark', async () => {
  const { AE } = load(['00-core.js', '55-waymark.js']);
  const c = { auto: { 123: { due: '2026-10-30' }, 124: { due: '2026-10-30' } }, removed: [], rules: {}, tags: {} };
  const rows = [{ workorderId: 123 }, { workorderId: 124, workorderStatusId: null }, { workorderId: 125, workorderStatusId: 'x' }, { workorderId: 126, workorderStatusId: '' }]; // SYNTHETIC rows
  const plan = AE.waymark.planScan(rows, c);
  assert.deepEqual(plain(plan.end), []); assert.deepEqual(plain(plan.unknown), [123, 124, 125, 126]);
  const control = AE.waymark.planScan([{ workorderId: 123, workorderStatusId: 14 }], c); // a real status outside the mark's: the mark ends
  assert.deepEqual(plain(control.end.map((e) => e.wo)), [123]); assert.deepEqual(plain(control.unknown), []);
});

// ================================================================== Tracker: partial snapshots
const CART_ID = 'CART-1'; // SYNTHETIC: the template's csuCartId is blanked, so the cart call only happens when a test sets one
const trackerEnv = async (overrides = {}) => {
  const probe = load(['00-core.js', '27-tracker.js']);
  const { publicJwk } = await probe.AE.tracker.crypto.newKeyPair();
  const row = { workorderId: 1001, workorderStatusId: 14, workorderStatusName: 'Sale complete', programId: 1, programName: 'Test', updatedAt: '2026-10-24T10:00:00Z' }; // SYNTHETIC list row (fields the code reads)
  const cartId = overrides.cartId || WO_ANSWER.workorder.csuCartId;
  const routes = [
    ['GET', /^\/api\/auth\/user$/, ok(USER)],
    ['POST', /^\/api\/workorders$/, (b) => ok({ workOrders: b.primaryFilter === 'Active' ? [row] : [], rowCount: b.primaryFilter === 'Active' ? 1 : 0 })],
    ['GET', /^\/v1\/914\/tracker\/key$/, ok({ publicJwk })],
    ['POST', /^\/v1\/914\/tracker\/scan$/, ok({ need: [{ wo: 1001, why: 'changed' }] })],
    ['POST', /^\/v1\/914\/tracker\/wo\/1001$/, ok({ same: false })],
    ['GET', /^\/api\/workorder\/1001$/, overrides.core || ok(overrides.cartId ? { ...WO_ANSWER, workorder: { ...WO_ANSWER.workorder, csuCartId: overrides.cartId } } : WO_ANSWER)],
    ['GET', /^\/api\/workorder-audit-trail\/1001$/, overrides.audit || ok([])],                     // SYNTHETIC: the shape of an empty trail
    ['GET', /^\/api\/note\?/, overrides.notes || ok({ notes: [], total: 0, latestManualNote: null })], // SYNTHETIC empty notes page
    ['GET', /^\/api\/workorder\/1001\/events/, overrides.events || ok({ events: [] })],
    ['GET', new RegExp('^/api/get-cart/' + cartId), overrides.cart || ok(woTemplate.cart)],
    ['GET', /^\/api\/v1\/workorder\/1001\/demographic\/customer-data$/, ok({})],
  ];
  const env = load(['00-core.js', '27-tracker.js'], { fetch: router(routes) });
  return env;
};
await t('Tracker: a complete detail is posted (control)', async () => {
  const env = await trackerEnv();
  const r = await env.AE.tracker.scan({ force: true });
  assert.equal(r.sent, 1, JSON.stringify(r)); assert.equal(r.partial, 0);
  assert.equal(posted(env.fetchLog, /tracker\/wo\/1001$/).length, 1);
  assert.ok(env.gm.get('ae_wod_914') && env.gm.get('ae_wod_914')['1001'], 'a complete copy is cached');
});
for (const [part, override] of [['audit trail', { audit: { status: 500, body: 'x' } }], ['notes', { notes: { status: 504, body: 'x' } }], ['cart', { cartId: CART_ID, cart: { status: 500, body: 'x' } }], ['events', { events: { status: 500, body: 'x' } }]]) {
  await t('Tracker: a failed ' + part + ' means no upload for that work order, and nothing cached', async () => {
    const env = await trackerEnv(override);
    const r = await env.AE.tracker.scan({ force: true });
    assert.equal(r.sent, 0); assert.equal(r.partial, 1, JSON.stringify(r)); assert.equal(r.failed, 0);
    assert.deepEqual(posted(env.fetchLog, /tracker\/wo\/1001$/), [], 'no snapshot posted');
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

// ================================================================== Retrace
const retraceEnv = (labelAnswer, opts = {}) => {
  const todo = opts.todo || ['180001'];
  const base = opts.gm || {};
  const sweeps = [];
  const env = load(['00-core.js', '27-tracker.js', '28-retrace-collect.js'], {
    gm: Object.assign({ ['ae_retrace_todo_' + STORE]: todo }, base),
    fetch: router([
      ['GET', /^\/api\/auth\/user$/, ok(USER)],
      ['GET', /store-products\/\d+\/inventory\?pageSize=1&/, opts.countAnswer || labelAnswer],
      ['GET', /store-products\/\d+\/inventory\?pageSize=200/, typeof labelAnswer === 'function' ? labelAnswer : labelAnswer],
      ['GET', /outstanding-parts/, opts.outstanding || ok(NO_PARTS)],
      ['GET', /rma-orders/, ok([])], ['GET', /store-transfer-orders/, ok([])], ['GET', /van-warehouses/, ok([])],
      ['POST', /purchase-orders\?pageSize=50/, opts.poList || ok({ ...PO_LIST, '@odata.count': 0, value: [] })], // SYNTHETIC: the captured PO list emptied
      ['GET', /^\/v1\/914\/tracker\/retrace\/cursor$/, ok({ cursors: { lookup: { value: { at: new Date().toISOString() } } }, baseline: opts.baseline || { frozen: true } })],
      ['POST', /^\/v1\/914\/tracker\/retrace\/sweep$/, (b) => { sweeps.push(b); return ok({ changedItems: [], need: [], more: false, added: (b.labels || []).length, written: 0, countNeed: [], missedItems: [], shortItems: [], pos: { need: [], events: 0 }, unnamed: [] }); }],
      ['POST', /^\/v1\/914\/tracker\/retrace\/pass$/, ok({})],
    ]),
  });
  env.sweeps = sweeps;
  return env;
};
const labelCalls = (log) => log.filter((r) => /store-products\/.*\/inventory/.test(r.url));

await t('Retrace labels: the captured answer reads its rows (control) and locks the item out for 2 h', async () => {
  const env = retraceEnv(ok(LABELS));
  const r = await env.AE.retrace.run();
  assert.equal(r.itemsRead, 1, JSON.stringify(r)); assert.equal(r.itemsFailed, 0); assert.equal(r.labels, 3);
  assert.equal(env.sweeps.at(-1).labels.length, 3);
  assert.deepEqual(plain(env.gm.get('ae_retrace_todo_' + STORE)), []);
  assert.ok(env.gm.get('ae_retrace_short2_' + STORE)['180001'], 'locked out after a successful read');
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
    assert.deepEqual(plain(env.gm.get('ae_retrace_todo_' + STORE)), ['180001'], 'still queued');
    assert.equal(env.gm.get('ae_retrace_fail_' + STORE)['180001'], 1, 'retry count');
    assert.deepEqual(plain(env.gm.get('ae_retrace_short2_' + STORE) || {}), {}, 'no lockout');
    assert.equal(env.gm.get('ae_retrace_qtyonly_' + STORE), undefined, 'not quantity-only');
    assert.ok(!env.sweeps.at(-1).labels || env.sweeps.at(-1).labels.length === 0);
  });
}
await t('Retrace count read: only a numeric @odata.count (or a real 0) counts; an unknown shape never marks quantity-only', async () => {
  const run = async (countAnswer) => { const env = retraceEnv(ok(LABELS), { todo: [], countAnswer, baseline: { frozen: false, posKnown: true }, gm: { ['ae_retrace_count_' + STORE]: ['180002'] } }); const r = await env.AE.retrace.run(); return { env, r }; };
  let { env, r } = await run(ok(LABELS)); // pageSize=1 answer with count 3
  assert.equal(r.counted, 1); assert.deepEqual(plain(env.sweeps.flatMap((s) => s.labelTotals || [])), [{ item: '180002', total: 3 }]);
  ({ env, r } = await run(ok(ZERO_LABELS)));
  assert.equal(r.quantityOnly, 1); assert.deepEqual(plain(env.gm.get('ae_retrace_qtyonly_' + STORE)), ['180002']);
  for (const bad of [ok({}), ok('x'), ok({ value: [] }), ok({ '@odata.count': null, value: [] }), { status: 200, body: 'text' }]) { // SYNTHETIC bad answers
    ({ env, r } = await run(bad));
    assert.equal(r.counted, 0, JSON.stringify(r)); assert.equal(r.quantityOnly, undefined);
    assert.equal(env.gm.get('ae_retrace_qtyonly_' + STORE), undefined);
    assert.deepEqual(plain(env.sweeps.flatMap((s) => s.labelTotals || [])), []);
  }
  ({ env, r } = await run({ status: 404, body: { error: 'no record' } })); // Portal has no record of the item: 0, as before (an HTTP answer, not a shape)
  assert.equal(r.quantityOnly, 1);
});
await t('Retrace: three bad label answers in a row open the Portal breaker; the rest of the pass backs off', async () => {
  const env = retraceEnv(ok({}), { todo: ['1', '2', '3', '4', '5'] }); // SYNTHETIC bad answers
  const events = []; env.AE.on('portal-health', (d) => events.push(d.down ? 'down' : 'up'));
  const r = await env.AE.retrace.tick(); // a scheduled pass (run() is the dev tools' forced one, which ignores the tab-wide breaker)
  assert.equal(r.itemsFailed, 3, JSON.stringify(r)); assert.equal(r.portalTrouble, true);
  assert.equal(events[0], 'down'); // (the stub answers every other Portal call fine, so the breaker closes again right after: any valid answer is a success)
  assert.equal(labelCalls(env.fetchLog).length, 3, 'items 4 and 5 were not asked');
  for (let i = 0; i < 3; i++) env.AE.health.fail('http', { status: 504, message: 'x' });
  assert.equal(await env.AE.retrace.tick(), null, 'and no new pass while Portal is down');
  assert.match(env.AE.retrace.state && JSON.stringify(env.AE.retrace.state()), /enabled/);
});
await t('Retrace docs: an unrecognised PO list answer does not complete the PO backfill', async () => {
  const env = retraceEnv(ok(LABELS), { todo: [], poList: ok({ message: 'busy' }) }); // SYNTHETIC bad answer
  const r = await env.AE.retrace.run();
  assert.ok(r.errors.some((e) => /purchase orders/.test(e)), JSON.stringify(r.errors));
  assert.equal((env.sweeps.at(-1).cursors || {}).po_backfill, undefined, 'the backfill cursor is not advanced / marked done');
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
});

// ================================================================== summary
const failed = results.filter(([, p]) => !p);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
