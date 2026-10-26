// Aethernet client tests: the shared core (AE.api, ApiError, AE.shape, AE.health), the background loops' gates and breakers,
// Retrace's collector (what each sweep / history / PO call SENDS), the tracker, Waymark, and the shards' Portal readers.
//
//   node test-client/run.mjs              (or: npm test --prefix test-client)
//   node test-client/mutate.mjs           (each listed source mutation must make this suite fail)
//
// The src files load into a Node vm with stubbed browser globals (test-client/harness.mjs); `fetch` is stubbed per test and every
// request is recorded as sent (env.requests), so tests assert the bodies that would reach Portal or the Worker. Loops run on the
// harness's virtual clock (timers: 'fake') where timing matters.
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
const failCall = (AE) => AE.api('GET', '/x').catch(() => {});
const MIN = 60000;
// A fetch whose answer the test controls: reply = { status, body } | 'hang' (a call that never answers until release(answer)).
const controlled = () => {
  const c = { reply: { status: 504, body: 'x' }, held: [] };
  c.fetch = (u, i) => (c.reply === 'hang' ? new Promise((r) => c.held.push(r)) : typeof c.reply === 'function' ? c.reply(u, i) : c.reply);
  c.release = (answer) => { for (const r of c.held.splice(0)) r(answer); };
  return c;
};
const down3 = async (AE) => { for (let i = 0; i < 3; i++) await failCall(AE); };

await t('health: 3 failures in a row = down, one toast and one outage hook; calls inside the backoff don\'t end it', async () => {
  const c = controlled();
  const env = outageSetup({ fetch: c.fetch });
  const { AE } = env;
  await failCall(AE); await failCall(AE);
  assert.equal(AE.health.state().down, false); assert.equal(AE.health.down(), false);
  await failCall(AE);
  assert.equal(AE.health.state().down, true);
  assert.deepEqual(env.events, ['down']);
  assert.equal(env.outage.length, 1); assert.equal(env.outage[0].failures, 3); assert.equal(env.outage[0].status, 504);
  assert.equal(env.toasts.length, 1);
  assert.match(env.toasts[0], /Portal is slow or down/); assert.match(env.toasts[0], /Aethernet is pausing its background checks and will retry on its own\./);
  assert.equal(AE.health.down(), true, 'background loops skip');
  await failCall(AE); await failCall(AE);
  assert.equal(env.toasts.length, 1); assert.equal(env.outage.length, 1);
  c.reply = ok({});
  await AE.api('GET', '/x'); // an interactive call still goes out (not blocked)…
  assert.equal(AE.health.state().down, true, '…but inside the backoff it is not the probe: it moves nothing'); assert.deepEqual(env.events, ['down']);
});

await t('health: 5xx, 429, timeouts and network failures count; other 4xx, non-JSON and BadShape never make an outage', async () => {
  const c = controlled();
  const { AE } = outageSetup({ fetch: c.fetch });
  c.reply = { status: 404, body: {} };
  for (let i = 0; i < 5; i++) await failCall(AE);
  assert.equal(AE.health.state().failures, 0);
  c.reply = { status: 429, body: 'slow down' };
  await failCall(AE);
  assert.equal(AE.health.state().failures, 1);
  c.reply = { status: 200, body: 'not json' }; // SYNTHETIC text answer
  for (let i = 0; i < 4; i++) await failCall(AE);
  c.reply = { status: 200, body: '<!doctype html><html></html>' };
  await failCall(AE);
  assert.equal(AE.health.state().down, false, 'non-JSON answers are not an outage'); assert.equal(AE.health.state().shapeFails, 5);
  c.reply = () => { throw new TypeError('Failed to fetch'); };
  const net = await AE.api('GET', '/x').catch((e) => e);
  assert.equal(net.status, 0);
  assert.equal(AE.health.state().failures, 2, 'a network failure counts');
  c.reply = 'hang';
  await AE.api('GET', '/slow', undefined, { timeoutMs: 15 }).catch(() => {}); // real timers here: 15 ms
  assert.equal(AE.health.state().down, true, 'the third: a timeout'); assert.equal(AE.health.state().last.kind, 'timeout');
});

await t('health: a BadShape is counted apart (shapeFails), never an outage or a toast', async () => {
  const env = outageSetup({ fetch: () => ok({}) });
  const { AE } = env;
  for (let i = 0; i < 6; i++) { const j = await AE.api('GET', '/x'); assert.throws(() => AE.shape.workorder(j), AE.BadShape); }
  assert.equal(AE.health.state().down, false); assert.equal(AE.health.state().shapeFails, 6);
  assert.deepEqual(env.events, []); assert.equal(env.toasts.length, 0);
  assert.throws(() => { throw AE.shape.bad('x', 'missing y', { a: 1 }); }, AE.BadShape);
  assert.equal(AE.health.state().shapeFails, 7, 'AE.shape.bad counts too');
  assert.match(AE.health.state().lastShape.message, /x answered in an unexpected shape/);
});

await t('health: down() and tripped() have no side effect; the first Portal call after the backoff is the probe', async () => {
  const c = controlled();
  const { AE, clock } = outageSetup({ fetch: c.fetch });
  await down3(AE);
  clock.now += MIN - 1;
  assert.equal(AE.health.down(), true); assert.equal(AE.health.tripped(), true, 'inside the backoff');
  clock.now += 2;
  for (let i = 0; i < 10; i++) { assert.equal(AE.health.down(), false, 'the backoff is over'); assert.equal(AE.health.tripped(), false); } // asking 10 times claims nothing
  assert.equal(AE.health.state().probing, false);
  await failCall(AE); // this call was the probe: it failed, 2 minutes next
  assert.equal(AE.health.state().level, 1); assert.equal(AE.health.down(), true); assert.equal(AE.health.tripped(), true);
});

await t('health: backoff 1, 2, 5, 10, 10 min; one probe at a time; only the probe\'s answer moves the state (not a click\'s)', async () => {
  const c = controlled();
  const env = outageSetup({ fetch: c.fetch });
  const { AE, clock } = env;
  await down3(AE);
  clock.now += MIN + 1;
  c.reply = 'hang';
  const probe = AE.api('GET', '/probe').catch((e) => e); // the probe, still out
  await env.settle();
  assert.equal(AE.health.state().probing, true); assert.equal(AE.health.down(), true, 'probe out: the others wait'); assert.equal(AE.health.tripped(), false, 'the probe holder may keep calling');
  c.reply = { status: 504, body: 'x' };
  await failCall(AE); await failCall(AE); // a user's clicks failing meanwhile
  assert.equal(AE.health.state().level, 0, 'a click is not the probe'); assert.equal(AE.health.state().probing, true);
  c.release({ status: 504, body: 'x' }); await probe;
  assert.equal(AE.health.state().level, 1); assert.equal(AE.health.state().probing, false);
  clock.now += 2 * MIN - 1000; assert.equal(AE.health.down(), true);
  clock.now += 2000; assert.equal(AE.health.down(), false);
  await failCall(AE); assert.equal(AE.health.state().level, 2);
  clock.now += 5 * MIN + 1; await failCall(AE); assert.equal(AE.health.state().level, 3);
  clock.now += 10 * MIN + 1; await failCall(AE); assert.equal(AE.health.state().level, 3, 'capped at 10 min');
  assert.equal(env.toasts.length, 1, 'one toast for the whole outage'); assert.equal(env.outage.length, 1);
});

await t('health: a successful probe starts recovering (loops run, level kept); 3 successes end the outage', async () => {
  const c = controlled();
  const env = outageSetup({ fetch: c.fetch });
  const { AE, clock } = env;
  await down3(AE);
  clock.now += MIN + 1; await failCall(AE); // level 1
  clock.now += 2 * MIN + 1;
  c.reply = ok({});
  await AE.api('GET', '/x'); // the probe succeeds
  assert.equal(AE.health.state().mode, 'recovering'); assert.equal(AE.health.down(), false); assert.equal(AE.health.tripped(), false);
  assert.equal(AE.health.state().level, 1, 'the backoff level is kept while recovering'); assert.deepEqual(env.events, ['down'], 'not back yet');
  await AE.api('GET', '/x');
  assert.equal(AE.health.state().mode, 'recovering');
  await AE.api('GET', '/x');
  assert.equal(AE.health.state().mode, 'up'); assert.equal(AE.health.state().level, 0);
  assert.deepEqual(env.events, ['down', 'up']); assert.equal(env.toasts.length, 2); assert.match(env.toasts[1], /Portal is back/); assert.match(env.toasts[1], /Aethernet is resuming its background checks\./);
});

await t('health: flapping keeps escalating, toasts at most once per 10 minutes, hook once per outage', async () => {
  const c = controlled();
  const env = outageSetup({ fetch: c.fetch });
  const { AE, clock } = env;
  await down3(AE); // outage 1, toast 1
  clock.now += MIN + 1; c.reply = ok({}); await AE.api('GET', '/x'); // recovering
  c.reply = { status: 504, body: 'x' }; await failCall(AE); // one failure while recovering: down again, one step longer
  assert.equal(AE.health.state().mode, 'down'); assert.equal(AE.health.state().level, 1); assert.equal(AE.health.state().retrips, 1);
  assert.equal(env.outage.length, 1, 'the same outage: no second hook'); assert.equal(env.toasts.length, 1, 'and no second toast'); assert.deepEqual(env.events, ['down']);
  clock.now += 2 * MIN + 1; c.reply = ok({}); for (let i = 0; i < 3; i++) await AE.api('GET', '/x'); // back
  assert.equal(env.toasts.length, 2); assert.deepEqual(env.events, ['down', 'up']);
  clock.now += MIN; c.reply = { status: 504, body: 'x' }; await down3(AE); // a new outage 4 minutes after the first toast
  assert.equal(env.outage.length, 2, 'a new outage calls the hook'); assert.equal(env.toasts.length, 2, 'but its toast waits out the 10 minutes');
  clock.now += MIN + 1; c.reply = ok({}); for (let i = 0; i < 3; i++) await AE.api('GET', '/x');
  assert.equal(env.toasts.length, 2, 'no "Portal is back" for an outage whose toast never showed'); assert.deepEqual(env.events, ['down', 'up', 'down', 'up']);
  clock.now += 10 * MIN; c.reply = { status: 504, body: 'x' }; await down3(AE);
  assert.equal(env.toasts.length, 3); assert.match(env.toasts[2], /Portal is slow or down/);
});

await t('health: a probe that never answers is released after a minute', async () => {
  const c = controlled();
  const env = outageSetup({ fetch: c.fetch });
  const { AE, clock } = env;
  await down3(AE);
  clock.now += MIN + 1; c.reply = 'hang';
  AE.api('GET', '/lost').catch(() => {});
  await env.settle();
  assert.equal(AE.health.down(), true);
  clock.now += MIN + 1; assert.equal(AE.health.down(), false, 'another caller may probe');
  c.reply = { status: 504, body: 'x' }; await failCall(AE);
  assert.equal(AE.health.state().level, 1, 'the new probe\'s answer counts');
});

await t('health: network failures while the browser is offline are not Portal\'s', async () => {
  const env = outageSetup({ online: false, fetch: () => { throw new TypeError('Failed to fetch'); } });
  for (let i = 0; i < 5; i++) await failCall(env.AE);
  assert.equal(env.AE.health.state().failures, 0); assert.equal(env.AE.health.state().down, false);
  env.online(true);
  await down3(env.AE);
  assert.equal(env.AE.health.state().down, true);
});

await t('api (virtual clock): a hung call times out at 30 s and counts; a finished call leaves no timer behind', async () => {
  const c = controlled();
  const env = load(['00-core.js'], { timers: 'fake', fetch: c.fetch });
  const { AE } = env;
  c.reply = ok({ a: 1 });
  await AE.api('GET', '/fast');
  assert.equal(env.pendingTimers(), 0, 'the timeout timer is cleared');
  c.reply = 'hang';
  let err = null; AE.api('GET', '/slow').catch((e) => { err = e; });
  await env.advance(29999); assert.equal(err, null, 'still waiting at 29.999 s');
  await env.advance(2);
  assert.ok(err instanceof AE.ApiError); assert.equal(err.timedOut, true); assert.match(err.message, /timed out after 30 s/);
  assert.equal(AE.health.state().failures, 1); assert.equal(AE.health.state().last.kind, 'timeout');
});

await t('workerCall: not Portal\'s health; every error (HTTP, timeout) is tagged worker', async () => {
  const c = controlled();
  const { AE } = outageSetup({ fetch: c.fetch });
  c.reply = { status: 500, body: 'x' };
  for (let i = 0; i < 5; i++) await AE.workerCall('GET', 'https://w.test/x', {}).catch(() => {});
  assert.equal(AE.health.state().failures, 0);
  const e = await AE.workerCall('GET', 'https://w.test/x', {}).catch((x) => x);
  assert.equal(e.worker, true); assert.equal(e.status, 500);
  c.reply = 'hang';
  const e2 = await AE.workerCall('GET', 'https://w.test/x', {}, 15).catch((x) => x);
  assert.equal(e2.worker, true); assert.equal(e2.timedOut, true);
  c.reply = { status: 403, body: 'x' };
  const p = await AE.api('GET', '/api/x').catch((x) => x);
  assert.equal(p.worker, undefined, 'a Portal error is not tagged');
});

await t('health (virtual clock, real loops): loops that check down() and return early never take the probe', async () => {
  // The tracker (ticks every 60 s, checks down() before its 10-minute gate) and Retrace's tick run on their real timers.
  const c = controlled();
  const env = load(['00-core.js', '27-tracker.js', '28-retrace-collect.js'], { timers: 'fake', fetch: c.fetch,
    gm: { ae_tracker_scan_at: Date.now() + 3600000, ae_retrace_pass_at: Date.now() + 3600000 } }); // neither is due for the next hour
  const { AE } = env;
  await down3(AE);
  await env.advance(3 * MIN);
  assert.equal(c.held.length, 0);
  assert.equal(env.requests(/./).length, 3, 'the loops made no call');
  assert.equal(AE.health.state().probing, false, 'no loop claimed the probe'); assert.equal(AE.health.down(), false, 'the backoff is over: the next real call probes');
  c.reply = ok({}); await AE.api('GET', '/x');
  assert.equal(AE.health.state().mode, 'recovering');
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

// ================================================================== background gates: Waymark, Assize
await t('Waymark scan: skipped while Portal is down (no list read); runs when it is up (control)', async () => {
  const env = waymarkEnv(ok(WO_ANSWER));
  for (let i = 0; i < 3; i++) env.AE.health.fail('http', { status: 504, message: 'x' });
  assert.equal(await env.AE.waymark.scan(), null);
  assert.deepEqual(env.requests(/^\/api\/workorders$/), []);
  const env2 = waymarkEnv(ok(WO_ANSWER));
  env2.setFetch(router([['GET', /^\/api\/auth\/user$/, ok(USER)], ['POST', /^\/api\/workorders$/, ok({ workOrders: [], rowCount: 0 })], ['GET', /^\/v1\/914$/, ok({ list: [], tags: {}, auto: {}, rules: {}, removed: [], closed: [] })]]));
  await env2.AE.waymark.scan().catch(() => {});
  assert.ok(env2.requests(/^\/api\/workorders$/).length >= 1, 'the list is read when Portal is up');
});
const assizePassSrc = extractFn('65-assize.js', 'async function pass(force, full)');
const assizePass = (env) => vm.runInContext(`(function () {
  let busy = false, lastError = null, progress = null, result = null;
  const SCAN_MS = 600000, GAP_MS = 1, DETAIL_TTL = 1800000, key = (k) => 'ae_assize_test_' + k;
  const render = () => {}, renderPanel = () => {}, loadDismissed = () => {}, compute = () => {}, uploadDaily = () => {}, readDetails = () => ({}), trimRow = (r) => r, inScope = () => false;
  const detailOf = async () => { throw new Error('not reached'); };
  ${assizePassSrc}
  return pass; })()`, env.ctx);
await t('Assize pass: skipped while Portal is down; reads the list when it is up (control)', async () => {
  const routes = router([['GET', /^\/api\/auth\/user$/, ok(USER)], ['POST', /^\/api\/workorders$/, ok({ workOrders: [], rowCount: 0 })]]);
  const env = load(['00-core.js'], { fetch: routes });
  for (let i = 0; i < 3; i++) env.AE.health.fail('http', { status: 504, message: 'x' });
  await assizePass(env)(false);
  assert.deepEqual(env.requests(/^\/api\/workorders$/), []);
  const env2 = load(['00-core.js'], { fetch: routes });
  await assizePass(env2)(false);
  assert.ok(env2.requests(/^\/api\/workorders$/).length >= 1);
});

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

// ================================================================== the shards' Portal readers
// Each reader's real code (extractFn) runs in the vm with the real core; only its UI neighbours are stand-ins.
const BAD_WO = [ok({}), ok({ workorder: {} }), ok('Gateway'), { status: 200, body: 'plain text' }, ok({ data: {} })]; // SYNTHETIC malformed answers
const cleaningWo = { ...WO_ANSWER, workorder: { ...WO_ANSWER.workorder, programId: 9470 } }; // the captured answer as a cleaning (no list lookups)
const woEnv = (answer, more = []) => load(['00-core.js'], { fetch: router([['GET', /^\/api\/auth\/user$/, ok(USER)], ['GET', /^\/api\/workorder\/123$/, answer], ...more]) });

// Esuna
const esunaLoadSrc = extractFn('15-wo-cleanings.js', 'async function load(woId, quiet = false)');
const esuna = (env) => vm.runInContext(`(function () { let state = null, loadingFor = null; const WINDOW_MS = 60000, POP_ID = 'x'; const render = () => {}, renderPop = () => {};
  ${esunaLoadSrc}
  return async (woId) => { await load(woId); return state; }; })()`, env.ctx);
const listRoutes = [['POST', /^\/api\/workorders$/, ok({ workOrders: [], rowCount: 0 })], ['GET', /^\/api\/arrivals\/upcoming-arrivals/, ok({ data: [], rowCount: 0 })]]; // SYNTHETIC empty lists
await t('Esuna: a malformed work order answer is an error, never a work order with nothing in it', async () => {
  for (const a of BAD_WO) { const s = await esuna(woEnv(a, listRoutes))('123'); assert.equal(s.status, 'error', JSON.stringify(a)); assert.match(s.error, /unexpected shape|not JSON/); }
  const s = await esuna(woEnv(ok(cleaningWo)))('123');
  assert.equal(s.status, 'ready'); assert.equal(s.wo.workorderStatusId, 14);
});
const esunaTick = extractFn('15-wo-cleanings.js', 'AE.every(1000, () => {').replace(/^AE\.every\(1000, /, '');
await t('Esuna: the background refresh waits while Portal is down', async () => {
  const run = (down) => {
    const env = load(['00-core.js']);
    if (down) for (let i = 0; i < 3; i++) env.AE.health.fail('http', { status: 504, message: 'x' });
    const loads = [];
    const tick = vm.runInContext(`(function (loads) { let state = { woId: '123', status: 'ready', at: Date.now() - 3600000 }, loadingFor = null; const REFRESH_MS = 60000, PILL_ID = 'p', POP_ID = 'q';
      const currentWoId = () => '123', render = () => {}, load = (w, q) => loads.push([w, q]);
      return (${esunaTick}); })`, env.ctx)(loads);
    tick();
    return loads;
  };
  assert.deepEqual(run(true), []); assert.deepEqual(plain(run(false)), [['123', true]]);
});

// Recitation
const recitationSrc = extractFn('17-text-notes.js', 'async function logRecentTexts(woId)');
const recitation = (env) => vm.runInContext(`(function () { const STATUS_TAG = { 14: 'sale_complete' }, WINDOW_MS = 180000, LOGGED_KEY = 'ae_text_notes_logged'; const loadLogged = () => ({});
  ${recitationSrc}
  return logRecentTexts; })()`, env.ctx);
const textRoutes = (env) => [['GET', /customer-data$/, ok({ customerId: 77, CustomerDatum: {} })], // SYNTHETIC customer record
  ['GET', /\/api\/messages\/v1\/customers\/77/, () => ok({ messages: [{ direction: 'OUTBOUND', senderId: 1, contactDate: new Date(env.clock.now).toISOString(), messageId: 'm1', content: 'Your device is ready', customerName: 'Test Customer' }] })], // SYNTHETIC message
  ['POST', /^\/api\/note$/, ok({})]];
await t('Recitation: a malformed work order answer adds no note; the captured one adds it with its status tag', async () => {
  for (const a of BAD_WO) {
    const env = load(['00-core.js']);
    env.setFetch(router([['GET', /^\/api\/auth\/user$/, ok(USER)], ['GET', /^\/api\/workorder\/123$/, a], ...textRoutes(env)])); // everything else answers: only the work order is bad
    await assert.rejects(recitation(env)('123'), (e) => /BadShape|ApiError/.test(e.name) && /Recitation work order|not JSON/.test(e.message));
    assert.deepEqual(env.requests(/^\/api\/note$/, 'POST'), []);
  }
  const env = load(['00-core.js']);
  env.setFetch(router([['GET', /^\/api\/auth\/user$/, ok(USER)], ['GET', /^\/api\/workorder\/123$/, ok(WO_ANSWER)], ...textRoutes(env)]));
  assert.equal(await recitation(env)('123'), 1);
  const n = env.requests(/^\/api\/note$/, 'POST');
  assert.equal(n.length, 1); assert.equal(n[0].body.noteTag, 'sale_complete'); assert.equal(n[0].body.workorderId, 123);
});

// Provoke
const provokeSrc = extractFn('24-provoke.js', 'async function statusOf(woId)') + '\n' + extractFn('24-provoke.js', 'async function chat()');
const provoke = (env) => {
  const ui = { row: null, built: [] };
  const fn = vm.runInContext(`(function (ui) {
    let chatStatus = null, chatBuilding = false; const statusMiss = new Map(); const STATUS_RETRY_MS = 30000, STATUS_RETRY_MAX = 600000, CHAT_ID = 'ae-chat';
    const document = { getElementById: () => ui.row };
    const woIdNow = () => '123', msgBox = () => ({ disabled: false, readOnly: false });
    const sheet = async () => ({ data: { items: [{ title: 'Ready', texts: ['x'] }] } });
    const byStatus = (name, id) => (id === 13 ? 'ready' : null);
    const unplace = () => { ui.row = null; }, place = (row) => { ui.row = row; return true; };
    const renderChat = (items, leads, woId) => { ui.built.push(chatStatus); return { dataset: { wo: woId }, remove() {} }; };
    ${provokeSrc}
    return chat; })`, env.ctx)(ui);
  return { chat: fn, ui };
};
await t('Provoke: a failed work order read still places the row (no status order) and is retried with a backoff, not every second', async () => {
  for (const status of [404, 504]) {
    const env = load(['00-core.js'], { fetch: router([['GET', /^\/api\/workorder\/123$/, { status, body: 'x' }]]) });
    const { chat, ui } = provoke(env);
    for (let s = 0; s < 29; s++) { await chat(); env.clock.now += 1000; } // the 1 s timer, for 29 s
    assert.equal(ui.built.length, 1, 'the row is placed once'); assert.equal(ui.built[0], null, 'without status ordering');
    assert.equal(env.requests(/^\/api\/workorder\/123$/).length, 1, 'one read in 29 s, not one a second');
    assert.equal(env.AE.health.state().down, false, 'no outage from one failing work order');
    assert.equal(env.AE.health.state().shapeFails, 0, 'the failed call\'s nothing is never shape-checked');
    env.clock.now += 2000; await chat();
    assert.equal(env.requests(/^\/api\/workorder\/123$/).length, 2, 'retried after 30 s');
    env.clock.now += 59000; await chat();
    assert.equal(env.requests(/^\/api\/workorder\/123$/).length, 2, 'then after 60 s more');
  }
});
await t('Provoke: a malformed answer places the row without status; the captured one orders by status and is not read again', async () => {
  let env = load(['00-core.js'], { fetch: router([['GET', /^\/api\/workorder\/123$/, ok({})]]) }); // SYNTHETIC
  let p = provoke(env); await p.chat();
  assert.equal(p.ui.built.length, 1); assert.equal(p.ui.built[0], null);
  env = load(['00-core.js'], { fetch: router([['GET', /^\/api\/workorder\/123$/, ok(withStatus(13))]]) });
  p = provoke(env);
  for (let s = 0; s < 5; s++) { await p.chat(); env.clock.now += 1000; }
  assert.equal(p.ui.built.length, 1); assert.equal(p.ui.built[0].key, 'ready');
  assert.equal(env.requests(/^\/api\/workorder\/123$/).length, 1);
});

// Macrocosmos
const macroSrc = extractFn('30-galaxy.js', 'async function collectData(woId)');
const macro = (env) => vm.runInContext(`(function () { const gspnTicketOnPage = () => null;
  ${macroSrc}
  return collectData; })()`, env.ctx);
await t('Macrocosmos: a malformed work order answer stops the filing; the captured one is read', async () => {
  for (const a of BAD_WO) await assert.rejects(macro(woEnv(a))('123'), (e) => /BadShape|ApiError/.test(e.name));
  const d = await macro(woEnv(ok(WO_ANSWER)))('123');
  assert.equal(d.woId, '123'); assert.equal(typeof d.imei, 'string');
});

// Decipher
const decipherEnv = (answer) => load(['00-core.js', '55-waymark.js', '64-decipher.js'], { fetch: router([['GET', /^\/api\/auth\/user$/, ok(USER)], ['GET', /^\/api\/workorder\/\d+$/, answer], ['POST', /\/tac/, ok({ ok: true })]]) });
const learnable = { ...WO_ANSWER, workorder: { ...WO_ANSWER.workorder, CustomerDevice: { imei: '356938035643809', DeviceCatalog: { deviceModelId: 5, name: 'Test Phone 9 Blue', DeviceModel: { modelNumber: 'Test Phone 9', DeviceManufacturer: { name: 'Testco' } } } } } }; // SYNTHETIC device (Luhn-valid test IMEI)
await t('Decipher: a malformed work order answer records nothing; a real one records its TAC', async () => {
  for (const a of BAD_WO) {
    const env = decipherEnv(a);
    await assert.rejects(env.AE.decipher.learn('124'), (e) => /BadShape|ApiError/.test(e.name));
    assert.deepEqual(env.requests(/\/tac/, 'POST'), []);
  }
  const env = decipherEnv(ok(learnable));
  await env.AE.decipher.learn('125');
  const sent = env.requests(/\/tac/, 'POST');
  assert.equal(sent.length, 1); assert.deepEqual(plain(sent[0].body.items.map((i) => i.tac)), ['35693803']);
});

// Swiftcast
const swiftSrc = ['async function api(method, path, body, opts)', 'async function retrying(fn, log, what)', 'async function run(arrivalId, log)'].map((h) => extractFn('20-auto-close.js', h)).join('\n');
const swiftcast = (env) => vm.runInContext(`(function () {
  const STEP_DELAY_MS = 1, DEVICE_ISSUES = ['Cleaning'], BIN = '', REFRESH_PROGRAM = 11759, SP_SKU = '101516', SP_NAME = 'Verizon screen protector';
  let laborNote = null, stopRequested = false;
  const unwrap = AE.unwrap, stepsFor = () => 9, laborOnNow = () => false;
  const cartOf = (r) => { const c = unwrap(r); return (c && (c.cartItems ? c : c.cart)) || c || {}; };
  const skuOf = (i) => String(i.sku || i.itemNumber || i.ItemId || '');
  ${swiftSrc}
  return run; })()`, env.ctx);
const ARRIVAL = { program: { programId: 9470 }, customerDevice: { imei: '356938035643809', customerDeviceId: 9 }, customer: { customerId: 77 }, clientId: 3, storeId: STORE }; // SYNTHETIC arrival (fields run() reads)
const swiftRoutes = (wo, checkout) => router([
  ['GET', /^\/api\/auth\/user$/, ok(USER)], ['GET', /^\/api\/arrivals\/50$/, ok(ARRIVAL)], ['POST', /validate-imei$/, ok({ valid: true })],
  ['POST', /^\/api\/checkin\/workorder$/, ok({ workorder: { workorderId: 555 } })], ['POST', /calculate-sla/, ok({})], ['PUT', /^\/api\/checkin\/workorder$/, ok({})],
  ['PATCH', /\/status$/, ok({})], ['POST', /^\/api\/notes?$/, ok({})], ['GET', /^\/api\/workorder\/555$/, wo], ['PUT', /^\/api\/workorder\/555$/, ok({})], ['POST', /workorder\/attribute$/, ok({})],
  ['GET', /^\/api\/checkout\/workorder\/555$/, checkout], ['GET', /get-cart/, ok({ payment: { total: 0 } })], // SYNTHETIC $0 cart
  ['POST', /demographic\/customer-data$/, ok({})], ['POST', /complete-order$/, ok({ salesOrder: { salesId: 'S1' } })]]);
await t('Swiftcast: a text answer to the (unused) checkout GET doesn\'t stop the run before complete-order', async () => {
  const env = load(['00-core.js'], { fetch: swiftRoutes(ok(WO_ANSWER), { status: 200, body: 'OK' }) }); // SYNTHETIC text 2xx (the answer is uncaptured)
  const log = Object.assign(() => {}, { plan() {} });
  assert.equal(await swiftcast(env)(50, log), 555);
  assert.equal(env.requests(/complete-order$/, 'POST').length, 1);
});
await t('Swiftcast: a malformed work order answer stops the run before any status PUT is built from it', async () => {
  for (const a of BAD_WO) {
    const env = load(['00-core.js'], { fetch: swiftRoutes(a, ok({})) });
    await assert.rejects(swiftcast(env)(50, Object.assign(() => {}, { plan() {} })));
    assert.deepEqual(env.requests(/^\/api\/workorder\/555$/, 'PUT'), [], JSON.stringify(a));
    assert.deepEqual(env.requests(/complete-order$/, 'POST'), []);
  }
});

// Divination, Tactician: background reloads wait while Portal is down
const divSrc = extractFn('10-cleaning-rate.js', 'const autoRefresh = () =>');
await t('Divination: the timed refresh waits while Portal is down', async () => {
  const run = (down) => { const env = load(['00-core.js']); if (down) for (let i = 0; i < 3; i++) env.AE.health.fail('http', { status: 504, message: 'x' }); const calls = []; vm.runInContext(`(function (calls) { const refresh = () => calls.push(1); ${divSrc}; autoRefresh(); })`, env.ctx)(calls); return calls.length; };
  assert.equal(run(true), 0); assert.equal(run(false), 1);
});
const tacTick = extractFn('62-tactician.js', 'AE.every(1000, () => {').replace(/^AE\.every\(1000, /, '');
await t('Tactician: the stale reload waits while Portal is down', async () => {
  const run = (down) => {
    const env = load(['00-core.js']);
    if (down) for (let i = 0; i < 3; i++) env.AE.health.fail('http', { status: 504, message: 'x' });
    const shown = [];
    const tick = vm.runInContext(`(function (shown) { const reports = { parentElement: null }; let shownFor = reports, busy = false, loadedAt = 0; const STALE_MS = 60000, RP = 'rp';
      const location = { pathname: '/reporting/metrics' }, document = { querySelector: () => reports, getElementById: () => ({ parentElement: null }), querySelectorAll: () => [] };
      const showSplh = () => shown.push(1), getComputedStyle = () => ({});
      return (${tacTick}); })`, env.ctx)(shown);
    tick();
    return shown.length;
  };
  assert.equal(run(true), 0); assert.equal(run(false), 1);
});

// ================================================================== summary
const failed = results.filter(([, p]) => !p);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
process.exit(failed.length ? 1 : 0);
