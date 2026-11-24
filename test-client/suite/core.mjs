// Client suite, part of `node test-client/run.mjs` (which loads these files in order; see its top for how the tests work).
import assert from 'node:assert/strict';
import { load } from '../harness.mjs';
import { t, WO_ANSWER, withStatus, LABELS, plain, ok, router, MIN } from './common.mjs';

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

await t('AE.ymd: a Date as the local YYYY-MM-DD, zero-padded; localDay and the shards\' day keys go through it', async () => {
  const { AE, ctx } = load(['00-core.js', '27-tracker.js', '62-tactician.js']);
  assert.equal(AE.ymd(new Date(2026, 0, 5, 23, 59)), '2026-01-05'); // local parts: late evening stays on its own day in any time zone
  assert.equal(AE.ymd(new Date(2026, 10, 24, 0, 0)), '2026-11-24');
  assert.equal(AE.ymd(new Date(999, 11, 31)), '999-12-31'); // the year is not padded (as every copy this replaced)
  assert.equal(AE.localDay(), AE.ymd(new ctx.Date()));
  assert.equal(AE.tactician.ymd, AE.ymd);
});

await t('AE.sleep: resolves after its pause, not before', async () => {
  const env = load(['00-core.js'], { timers: 'fake' });
  let done = false; env.AE.sleep(500).then(() => { done = true; });
  await env.advance(499); assert.equal(done, false);
  await env.advance(1); assert.equal(done, true);
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

await t('AE.every (virtual clock): a hidden tab skips its ticks and catches up once when shown; background loops keep running', async () => {
  const env = load(['00-core.js'], { timers: 'fake', fetch: controlled().fetch });
  const { AE } = env, doc = env.ctx.document;
  let page = 0, bg = 0;
  AE.every(1000, () => { page++; });
  AE.every(1000, () => { bg++; }, { background: true });
  await env.advance(0); assert.equal(page, 1); assert.equal(bg, 1);          // both run once straight away
  await env.advance(3000); assert.equal(page, 4); assert.equal(bg, 4);
  doc.hidden = true;
  await env.advance(5000); assert.equal(page, 4, 'no ticks while hidden'); assert.equal(bg, 9, 'the background loop went on');
  doc.hidden = false; doc.dispatchEvent({ type: 'visibilitychange' });
  await env.advance(0); assert.equal(page, 5, 'one catch-up run when the tab shows again');
  await env.advance(1000); assert.equal(page, 6);
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
