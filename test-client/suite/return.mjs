// Client suite, part of `node test-client/run.mjs` (which loads these files in order; see its top for how the tests work).
import assert from 'node:assert/strict';
import { load } from '../harness.mjs';
import { t, withStatus, plain, ok, router } from './common.mjs';

// ================================================================== Return: arrival labels and the cleanings gate
// SYNTHETIC arrivals: only program.programId (read the same way by Swiftcast in production), customer and arrivalId.
const R_MOBILITY = { arrivalId: 50, program: { programId: 5062 }, customer: { firstName: 'Avery', lastName: 'Stone' } };
const R_CLEANING = { arrivalId: 51, program: { programId: 9470 }, customer: { firstName: 'Avery', lastName: 'Stone' } };
async function returnEnv({ pathname = '/check-in/arrivals/50', answers = [], routes = [], form = 'save' } = {}) {
  const env = load(['00-core.js', '22-checkin-drafts.js'], { pathname, fetch: router([
    ['GET', /^\/api\/arrivals\/50$/, ok(R_MOBILITY)], ['GET', /^\/api\/arrivals\/51$/, ok(R_CLEANING)], ...routes]) });
  const { AE, ctx } = env;
  const clicks = []; let onClick = null;
  ctx.addEventListener = (n, fn, cap) => { if (n === 'click' && cap) onClick = fn; };
  ctx.history = { state: null, pushState(st, _, url) { this.state = st; ctx.location.pathname = url; } };
  ctx.PopStateEvent = class { constructor(type) { this.type = type; } }; ctx.dispatchEvent = () => true;
  const asked = [];
  AE.confirm = async (o) => { asked.push(o.title); return answers.shift() ?? null; };
  await AE.shards.find((x) => x.id === 'checkinDrafts').run();
  // The intake form: 'save' = saved with notes (label carries a secret), null = closed.
  const forms = [];
  AE.checkinDrafts.intake = async (id, opts) => { forms.push({ id, opts }); asked.push('form');
    return form === 'save' ? AE.checkinDrafts.labelFor(R_MOBILITY, '1234567890123456') : null; };
  const btn = { textContent: 'Check-in', isConnected: true, disabled: false, closest: () => null,
    click() { clicks.push(1); onClick(event(btn)); } };
  const event = (target) => ({ target: { closest: () => target }, prevented: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() {} });
  const press = async () => { const e = event(btn); onClick(e); for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)); return e.prevented; };
  return { env, AE, ctx, asked, clicks, press, btn, forms };
}
await t('Return: Asurion Mobility, "Yes" opens the check-in', async () => {
  const r = await returnEnv({ answers: ['yes'] });
  assert.equal(await r.press(), true, "Portal's click held back while asking");
  assert.deepEqual(r.asked, ['Are you able to create cleanings for this device?']);
  assert.equal(r.clicks.length, 1, 'the button clicked again once answered');
});
for (const why of ['device', 'pin']) {
  await t('Return: Asurion Mobility, "No" + ' + why + ' makes a Return ticket and no check-in', async () => {
    const r = await returnEnv({ answers: ['no', why, false] });
    assert.equal(await r.press(), true);
    assert.deepEqual(r.asked, ['Are you able to create cleanings for this device?', 'Why not?', 'form', 'Return ticket created']);
    assert.deepEqual(r.forms.map((f) => [f.id, f.opts.print]), [[50, false]], 'the intake form comes before the label, and leaves printing to the question');
    assert.equal(r.clicks.length, 0, 'no work order');
    assert.ok(r.env.requests(/DYMO\/DLS\/Printing/).length > 0, 'the label was sent to DYMO');
  });
}
await t('Return: closing the intake form after "No" prints nothing and opens no check-in', async () => {
  const r = await returnEnv({ answers: ['no', 'pin'], form: null });
  await r.press();
  assert.deepEqual(r.asked, ['Are you able to create cleanings for this device?', 'Why not?', 'form']);
  assert.equal(r.clicks.length, 0);
  assert.equal(r.env.requests(/DYMO\/DLS\/Printing/).length, 0);
});
await t('Return: Asurion Mobility, "No" + no option on the account opens the check-in', async () => {
  const r = await returnEnv({ answers: ['no', 'option'] });
  await r.press();
  assert.deepEqual(r.asked, ['Are you able to create cleanings for this device?', 'Why not?']);
  assert.equal(r.forms.length, 0, 'no form when the check-in goes on');
  assert.equal(r.clicks.length, 1);
});
await t('Return: closing either question creates nothing', async () => {
  for (const answers of [[null], ['no', null]]) {
    const r = await returnEnv({ answers });
    await r.press();
    assert.equal(r.clicks.length, 0);
  }
});
await t('Return: once answered, the same arrival is not asked again', async () => {
  const r = await returnEnv({ answers: ['yes'] });
  await r.press();
  assert.equal(await r.press(), false, 'second click goes straight to Portal');
  assert.equal(r.asked.length, 1);
});
await t('Return: other programs and unreadable arrivals are never asked', async () => {
  const r = await returnEnv({ pathname: '/check-in/arrivals/51' });
  await r.press();
  assert.deepEqual(r.asked, []); assert.equal(r.clicks.length, 1);
  const r2 = await returnEnv({ pathname: '/check-in/arrivals/52', routes: [['GET', /^\/api\/arrivals\/52$/, { status: 500, body: 'x' }]] });
  await r2.press();
  assert.deepEqual(r2.asked, []); assert.equal(r2.clicks.length, 1, "Portal's button still works");
});
await t('Return: only the arrival drawer asks (the check-in steps are left alone)', async () => {
  const r = await returnEnv({ pathname: '/check-in' });
  assert.equal(await r.press(), false);
  assert.deepEqual(r.asked, []);
});
await t('Return: never calls the Worker', async () => {
  const r = await returnEnv({ answers: ['no', 'device', false] });
  await r.press();
  await r.AE.checkinDrafts.open(51);
  assert.equal(r.env.requests(/checkins/).length, 0);
});
await t('Return: a label code opens its arrival; an unknown one does not', async () => {
  const r = await returnEnv({ pathname: '/', routes: [['GET', /^\/api\/arrivals\/99$/, { status: 404, body: { message: 'Arrival not found' } }]] });
  const m = 'AER51'.match(r.AE.checkinDrafts.CODE_RE);
  assert.equal(m[1], '51');
  assert.equal('AECT5M7YM'.match(r.AE.checkinDrafts.CODE_RE), null);
  assert.equal(await r.AE.checkinDrafts.open(m[1]), 'opened arrival 51');
  assert.equal(r.ctx.location.pathname, '/check-in/arrivals/51');
  assert.equal(await r.AE.checkinDrafts.open(99), 'no such arrival');
  assert.equal(r.ctx.location.pathname, '/check-in/arrivals/51');
});
await t('Return: the label is the arrival (AER + its number)', async () => {
  const r = await returnEnv();
  const d = r.AE.checkinDrafts.labelFor(R_MOBILITY);
  assert.equal(d.code, 'AER50'); assert.match(d.line, /^Avery Stone · /);
});

// ================================================================== Return: sealed intake notes
async function notesEnv({ gm = {}, routes = [], worker } = {}) {
  const env = load(['00-core.js', '22-checkin-drafts.js'], { pathname: '/', gm, fetch: router([['GET', /^\/api\/arrivals\/50$/, ok(R_MOBILITY)], ...routes]) });
  const sent = [];
  env.AE.waymark = { call: async (method, path, body) => { sent.push({ method, path, body: JSON.parse(JSON.stringify(body)) }); return worker ? worker(path, body) : {}; } };
  env.ctx.history = { state: null, pushState(st, _, url) { this.state = st; env.ctx.location.pathname = url; } };
  env.ctx.PopStateEvent = class { constructor(type) { this.type = type; } }; env.ctx.dispatchEvent = () => true;
  await env.AE.shards.find((x) => x.id === 'checkinDrafts').run();
  return { env, R: env.AE.checkinDrafts, sent, gm: env.gm };
}
const NOTES = { imei: '7', password: '482913', callback: '(555) 555-0142', notes: 'Dropped yesterday.' };
await t('Return notes: sealed with the label secret, and the ciphertext holds none of the notes', async () => {
  const { R } = await notesEnv();
  const s = R.newSecret();
  assert.match(s, /^\d{16}$/);
  const row = await R.seal(s, NOTES);
  const raw = Buffer.from(row.data, 'base64').toString('latin1');
  for (const v of Object.values(NOTES).filter((x) => x.length > 3)) assert.ok(!raw.includes(v), 'plain text in the ciphertext: ' + v);
  assert.deepEqual(await R.unseal(s, row), NOTES);
  await assert.rejects(R.unseal(R.newSecret(), row), 'another label cannot open it');
  assert.match(await R.tokenOf(s), /^[0-9a-f]{64}$/);
  assert.notEqual(await R.tokenOf(s), s);
});
await t('Return notes: the label code carries the secret; old plain codes still open the arrival', async () => {
  const { R } = await notesEnv();
  const m = 'AER50K1234567890123456'.match(R.CODE_RE); assert.equal(m[1], '50'); assert.equal(m[2], '1234567890123456');
  assert.equal('AER50'.match(R.CODE_RE)[2], undefined);
  assert.equal('AER50K123'.match(R.CODE_RE), null);
  assert.equal(R.labelFor(R_MOBILITY, '1234567890123456').code, 'AER50K1234567890123456');
  assert.equal(R.labelFor(R_MOBILITY).code, 'AER50');
});
await t('Return notes: scanning a label remembers its secret and reads the notes with its token, never the secret', async () => {
  const s = '1234567890123456';
  const row = await (await notesEnv()).R.seal(s, NOTES);
  const { R, sent, gm } = await notesEnv({ worker: (path) => (path === '/return/read' ? { ...row, by: 'Erin Baker', at: '2026-11-17T12:00:00Z' } : {}) });
  assert.equal(await R.open(50, s), 'opened arrival 50');
  assert.equal(gm.get('ae_return_keys')['50'].s, s);
  assert.equal(sent[0].path, '/return/read'); assert.equal(sent[0].body.token, await R.tokenOf(s));
  assert.ok(!JSON.stringify(sent).includes(s), 'the secret never goes to the Worker');
});
await t('Return notes: the token and key come from the stretched digits; notes sealed the old way are still read and keep their token', async () => {
  const s = '1234567890123456';
  const sha = async (x) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(x))).toString('hex');
  const A = (await notesEnv()).R;
  assert.equal(await A.tokenOf(s, 1), await sha('ae-return-token:' + s));
  assert.notEqual(await A.tokenOf(s), await A.tokenOf(s, 1));
  await assert.rejects(A.unseal(s, await A.seal(s, NOTES), 1), 'the old key cannot open new notes');
  // An old row: found by the old token after the new one misses, then saved again under the old token.
  const old = await A.seal(s, NOTES, 1), t1 = await A.tokenOf(s, 1);
  const { R, sent, gm } = await notesEnv({ worker: (path, body) => {
    if (path === '/return/read') { if (body.token !== t1) throw Object.assign(new Error('HTTP 404'), { status: 404 }); return { ...old, by: 'Erin Baker', at: '2026-11-17T12:00:00Z' }; }
    return {};
  } });
  assert.equal(await R.open(50, s), 'opened arrival 50');
  assert.deepEqual(sent.filter((x) => x.path === '/return/read').map((x) => x.body.token), [await R.tokenOf(s), t1]);
  assert.equal(gm.get('ae_return_keys')['50'].v, 1);
});
async function sweepWith(status) {
  const now = Date.now();
  const r = await notesEnv({ gm: { ae_return_keys: { 50: { s: '1234567890123456', at: now, woId: 123 } } }, routes: [['GET', /^\/api\/workorder\/123$/, status]] });
  await r.R.sweep();
  return { removed: r.sent.filter((x) => x.path === '/return/remove'), kept: !!r.R.keys()['50'] };
}
await t('Return notes: removed once the work order has left Initial check-in', async () => {
  const r = await sweepWith(ok(withStatus(8)));
  assert.equal(r.removed.length, 1); assert.equal(r.removed[0].body.arrivalId, 50); assert.equal(r.kept, false);
});
await t('Return notes: kept while the work order is at Initial check-in, or when Portal fails or answers oddly', async () => {
  for (const ans of [ok(withStatus(1)), { status: 500, body: 'x' }, { status: 200, body: {} }, { status: 200, body: 'OK' }]) {
    const r = await sweepWith(ans);
    assert.equal(r.removed.length, 0, JSON.stringify(ans).slice(0, 60)); assert.equal(r.kept, true);
  }
});
await t('Return notes: a label is forgotten here 3 days after it was saved or scanned', async () => {
  const { R } = await notesEnv({ gm: { ae_return_keys: { 50: { s: '1234567890123456', at: Date.now() - 3 * 86400000 - 1000 }, 51: { s: '1234567890123456', at: Date.now() } } } });
  assert.deepEqual(Object.keys(R.keys()), ['51']);
});
