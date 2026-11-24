// Client suite, part of `node test-client/run.mjs` (which loads these files in order; see its top for how the tests work).
import assert from 'node:assert/strict';
import { load } from '../harness.mjs';
import { t, WO_ANSWER, plain, ok, waymarkEnv } from './common.mjs';

// ================================================================== Waymark
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
