// Client suite, part of `node test-client/run.mjs` (which loads these files in order; see its top for how the tests work).
import assert from 'node:assert/strict';
import { load } from '../harness.mjs';
import { t, WO_ANSWER, USER, ok, router, waymarkEnv, ASSIZE_FILES, assize } from './common.mjs';

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
await t('Assize pass: skipped while Portal is down; reads the list when it is up (control)', async () => {
  const run = async (down) => {
    const env = load(ASSIZE_FILES, { timers: 'fake', fetch: router([['GET', /^\/api\/auth\/user$/, ok(USER)], ['POST', /^\/api\/workorders$/, ok({ workOrders: [], rowCount: 0 })]]) });
    const a = await assize(env), before = env.requests(/^\/api\/workorders$/).length;
    assert.ok(before >= 1, 'the first pass read the list');
    if (down) for (let i = 0; i < 3; i++) env.AE.health.fail('http', { status: 504, message: 'x' });
    env.gm.delete('ae_assize_scan_at_914'); // the next pass is due
    const p = a.pass(false); await env.advance(15000); await p;
    return env.requests(/^\/api\/workorders$/).length - before;
  };
  assert.equal(await run(true), 0); assert.ok(await run(false) >= 1);
});
