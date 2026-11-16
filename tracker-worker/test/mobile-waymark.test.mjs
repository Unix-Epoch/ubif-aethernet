// Linkpearl Waymark writes (/v1/agents/m/waymark…): the tag sheet, tag on / off, push and remove a follow-up. Rows and history must match the
// Waymark Worker's own routes (checked by running the same changes through worker/src/index.js on the same database), staff names never come
// from the phone, store / work order / closed / later-only rules, the per-phone bound, access_log rows. Local D1 in its own scratch dir; everything invented.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup, hex } from './mobile-helpers.mjs';
import { todayOf, marksFor, WRITES_PER_HOUR } from '../src/mobile-waymark.js';
import { addDays } from '../src/metrics.js';
import waymarkWorker from '../../worker/src/index.js';

const T = await setup('.wrangler-test-mobile-waymark');
const { env, call, admin, authed, registerPhone, approve } = T;
for (const st of readFileSync('../worker/schema.sql', 'utf8').replace(/--[^\n]*/g, '').split(';').map((x) => x.trim()).filter(Boolean)) await env.AE.prepare(st).run();
const AE = env.AE, W = '/v1/agents/m/waymark';
const post = (p, path, body) => authed(p, W + path, { method: 'POST', body });
const today = todayOf(env), dd = (n) => addDays(today, n);
// The Waymark Worker itself, on the same database, as the userscript calls it.
const wm = async (method, path, body) => {
  const r = await waymarkWorker.fetch(new Request('https://w.test/v1' + path, { method, headers: { 'x-aethernet-key': 'wk', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), { DB: AE, APP_KEY: 'wk' });
  return { status: r.status, j: await r.json() };
};
const rows = async (sql, ...a) => (await AE.prepare(sql).bind(...a).all()).results;
const histOf = (store, wo) => rows('SELECT action, tag, detail, by_name, by_id FROM history WHERE store = ? AND wo = ? ORDER BY id', store, wo);
const logOf = async (from) => (await env.TR.prepare('SELECT email, action, store, wo, detail FROM access_log WHERE id > ? ORDER BY id').bind(from).all()).results;
const maxLog = async () => (await env.TR.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM access_log').first()).m;

// ---- invented work orders in the tracker (open unless noted) and Waymark state
const wo = (store, n, open = 1) => env.TR.prepare("INSERT INTO workorders (store, wo, status_id, device, is_open) VALUES (?, ?, 13, 'iPhone 13', ?)").bind(store, n, open);
await env.TR.batch([wo(914, 8000001), wo(914, 8000002), wo(914, 8000003), wo(914, 8000004), wo(914, 8000005), wo(914, 8000009, 0), wo(326, 8100001), wo(536, 8200001), wo(914, 8000020), wo(914, 8000021), wo(914, 8000030)]);
const at = '2026-11-01T10:00:00Z';
await AE.batch([
  AE.prepare("INSERT INTO list (store, name, color, pos) VALUES (914, 'Priority', 'red', 0), (914, 'Waiting on customer', 'orange', 1), (914, 'Parts', 'blue', 2), (326, 'Other store tag', 'green', 0)"),
  AE.prepare("INSERT INTO wo_tags (store, wo, tag, by_name, by_id, at) VALUES (914, 8000009, 'Priority', 'Alex Kim', 5, ?)").bind(at),
  AE.prepare("INSERT INTO auto_marks (store, wo, due, created_at, removed_at, kind) VALUES (914, 8000001, ?1, ?3, NULL, 'rfp'), (914, 8000002, ?2, ?3, NULL, 'callback'), (914, 8000003, ?1, ?3, ?3, 'rfp'), (914, 8000009, ?1, ?3, NULL, 'rfp'), (914, 8000020, ?1, ?3, NULL, 'rfp'), (914, 8000021, ?1, ?3, NULL, NULL), (914, 8000030, ?1, ?3, NULL, 'rfp')").bind(dd(-1), today, at),
  AE.prepare('INSERT INTO wo_closed (store, wo, closed_at) VALUES (914, 8000004, ?)').bind(at),
]);

const A = await registerPhone('Pixel Fold'); await approve(A, [914, 326]);
const B = await registerPhone('Other phone'); await approve(B, [536]);
// 326 approved for A but without Aethernet access in Waymark (store_access): refused like the Waymark Worker refuses it
await AE.prepare('DELETE FROM store_access WHERE store = 326').run();

// ================================================================ GET /tags
{
  const r = await authed(A, W + '/tags?store=914');
  assert.equal(r.status, 200);
  assert.deepEqual(r.j, { v: 1, store: 914, tags: [{ name: 'Priority', color: 'red' }, { name: 'Waiting on customer', color: 'orange' }, { name: 'Parts', color: 'blue' }], oneOff: true, maxTags: 12, maxLength: 32 });
  console.log('tags', JSON.stringify(r.j));
  assert.equal((await authed(A, W + '/tags?store=536')).status, 403, 'not an approved store');
  assert.deepEqual((await authed(A, W + '/tags?store=326')).j, { error: 'this store does not have access to Aethernet' });
  assert.equal((await authed(A, W + '/tags')).status, 400);
  assert.equal((await authed(A, W + '/tags?store=abc')).status, 400);
  assert.equal((await authed(A, W + '/tags?store=914', { method: 'POST', body: {} })).status, 405);
  assert.equal((await authed(A, W + '/tag?store=914')).status, 405, 'writes are POST');
  assert.equal((await authed(A, W)).status, 404); assert.equal((await authed(A, W + '/push', { method: 'POST', body: {} })).status, 404);
  assert.deepEqual((await authed(B, W + '/tags?store=536')).j.tags, [], 'a store with no list');
}

// ================================================================ POST /tag: rows and history as the Waymark Worker writes them
{
  const L = await maxLog();
  const r = await post(A, '/tag', { store: 914, wo: 8000001, tag: 'Priority', on: true, by: 'Alex Kim', byId: 5 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.j, { ok: true, store: 914, wo: 8000001, tag: 'Priority', on: true, changed: true, tags: [{ tag: 'Priority', color: 'red' }] });
  console.log('tag on', JSON.stringify(r.j));
  const t = await rows('SELECT tag, by_name, by_id FROM wo_tags WHERE store = 914 AND wo = 8000001');
  assert.deepEqual(t, [{ tag: 'Priority', by_name: 'Linkpearl (Pixel Fold)', by_id: null }], 'the author is the phone, never the body\'s by');
  // again: no change, no second history row
  const again = await post(A, '/tag', { store: '914', wo: '8000001', tag: '  priority ', on: true });
  assert.equal(again.j.changed, false); assert.equal(again.j.tag, 'Priority', 'other capitals = the managed tag');
  // a one-off (free text, as anyone may add in Portal): cleaned like the Worker's tagName, colour null
  const one = await post(A, '/tag', { store: 914, wo: 8000001, tag: '  Call\u0007 back\n  after 3  ' + 'x'.repeat(40), on: true });
  assert.equal(one.j.tag, ('Call back after 3 ' + 'x'.repeat(40)).slice(0, 32)); assert.equal(one.j.tags[1].color, null);
  const off = await post(A, '/tag', { store: 914, wo: 8000001, tag: one.j.tag, on: false });
  assert.deepEqual(off.j.tags, [{ tag: 'Priority', color: 'red' }]); assert.equal(off.j.changed, true);
  console.log('tag off', JSON.stringify(off.j));
  assert.equal((await post(A, '/tag', { store: 914, wo: 8000001, tag: 'Nope', on: false })).j.changed, false, 'removing a tag that is not there');
  // the same four changes through the Waymark Worker, as the userscript sends them, on another work order: identical rows apart from the work order
  await wm('POST', '/914/wo/8000005/tag', { tag: 'Priority', by: 'Linkpearl (Pixel Fold)' });
  await wm('POST', '/914/wo/8000005/tag', { tag: 'Priority', by: 'Linkpearl (Pixel Fold)' });
  await wm('POST', '/914/wo/8000005/tag', { tag: one.j.tag, by: 'Linkpearl (Pixel Fold)' });
  await wm('POST', '/914/wo/8000005/untag', { tag: one.j.tag, by: 'Linkpearl (Pixel Fold)' });
  assert.deepEqual(await histOf(914, 8000001), await histOf(914, 8000005), 'history rows match the Waymark Worker\'s');
  assert.deepEqual(await histOf(914, 8000001), [
    { action: 'add', tag: 'Priority', detail: null, by_name: 'Linkpearl (Pixel Fold)', by_id: null },
    { action: 'add', tag: one.j.tag, detail: null, by_name: 'Linkpearl (Pixel Fold)', by_id: null },
    { action: 'remove', tag: one.j.tag, detail: null, by_name: 'Linkpearl (Pixel Fold)', by_id: null }]);
  assert.deepEqual(await rows('SELECT tag, by_name, by_id FROM wo_tags WHERE store = 914 AND wo = 8000001'), await rows('SELECT tag, by_name, by_id FROM wo_tags WHERE store = 914 AND wo = 8000005'));
  // and the Waymark Worker's own read (what Portal shows) sees the phone's tag
  assert.deepEqual((await wm('GET', '/914')).j.tags[8000001].map((x) => x.tag), ['Priority']);
  // access_log: every accepted write, actor device:<name>
  const lg = await logOf(L);
  assert.deepEqual(lg.map((x) => [x.email, x.action, x.store, x.wo]), [['device:Pixel Fold', 'waymark:tag', 914, 8000001], ['device:Pixel Fold', 'waymark:tag', 914, 8000001], ['device:Pixel Fold', 'waymark:tag', 914, 8000001], ['device:Pixel Fold', 'waymark:untag', 914, 8000001], ['device:Pixel Fold', 'waymark:untag', 914, 8000001]]);
  assert.ok(lg[1].detail.startsWith('Priority (no change) ' + A.id.slice(0, 8)));
  // tagging a work order Waymark had as closed takes it off the closed list (the Worker's "tagged again = still in play")
  await post(A, '/tag', { store: 914, wo: 8000004, tag: 'Parts', on: true });
  assert.equal(await AE.prepare('SELECT 1 FROM wo_closed WHERE store = 914 AND wo = 8000004').first(), null);
}

// ---- tag rules
{
  const bad = async (body, status, msg) => { const r = await post(A, '/tag', body); assert.equal(r.status, status, JSON.stringify(body)); if (msg) assert.deepEqual(r.j, { error: msg }); };
  await bad({ store: 914, wo: 8000001, tag: 'X' }, 400, 'on: true or false');
  await bad({ store: 914, wo: 8000001, tag: 'X', on: 'yes' }, 400, 'on: true or false');
  await bad({ store: 914, wo: 8000001, tag: '  \u0007 ', on: true }, 400, 'tag required');
  await bad({ store: 914, wo: 8000001, tag: 5, on: true }, 400, 'tag required');
  await bad({ wo: 8000001, tag: 'X', on: true }, 400, 'store required');
  await bad({ store: 536, wo: 8200001, tag: 'X', on: true }, 403, 'not your store');
  await bad({ store: 326, wo: 8100001, tag: 'X', on: true }, 403, 'this store does not have access to Aethernet');
  await bad({ store: 914, tag: 'X', on: true }, 400, 'wo required');
  await bad({ store: 914, wo: 123, tag: 'X', on: true }, 400, 'wo required');
  await bad({ store: 914, wo: 8000099, tag: 'X', on: true }, 404, 'no such work order');
  await bad({ store: 914, wo: 8200001, tag: 'X', on: true }, 404, 'no such work order'); // another store's number
  await bad({ store: 914, wo: 8000009, tag: 'Parts', on: true }, 409, 'work order is closed');
  // taking a tag off a closed work order is fine
  const r = await post(A, '/tag', { store: 914, wo: 8000009, tag: 'Priority', on: false });
  assert.equal(r.status, 200); assert.deepEqual(r.j.tags, []);
  // at most 12 tags; one already on is still "no change", not an error
  for (let i = 0; i < 12; i++) assert.equal((await post(A, '/tag', { store: 914, wo: 8000003, tag: 'T' + i, on: true })).status, 200);
  await bad({ store: 914, wo: 8000003, tag: 'T12', on: true }, 400, 'too many tags on this work order');
  assert.equal((await post(A, '/tag', { store: 914, wo: 8000003, tag: 'T3', on: true })).j.changed, false);
  assert.equal((await wm('POST', '/914/wo/8000003/tag', { tag: 'T12' })).status, 400, 'the Worker has the same cap');
  // bodies
  assert.equal((await authed(A, W + '/tag', { method: 'POST', body: [1] })).status, 400);
  assert.equal((await post(A, '/tag', { store: 914, wo: 8000001, tag: 'x'.repeat(3000), on: true })).status, 413);
  const raw = await call('POST', W + '/tag', undefined, Object.assign({ authorization: 'Bearer ' + A.id + '.' + A.token }));
  assert.equal(raw.status, 400, 'empty body');
}

// ================================================================ POST /followup: push later only, remove for good
{
  const L = await maxLog();
  const p = await post(A, '/followup', { store: 914, wo: 8000001, due: dd(3), by: 'Alex Kim' });
  assert.equal(p.status, 200);
  assert.deepEqual(p.j, { ok: true, store: 914, wo: 8000001, followUp: { kind: 'rfp', due: dd(3) } });
  console.log('push', JSON.stringify(p.j));
  assert.equal((await AE.prepare('SELECT due FROM auto_marks WHERE store = 914 AND wo = 8000001').first()).due, dd(3));
  // earlier or the same: refused (the Worker's rule)
  for (const due of [dd(3), dd(2), dd(-5)]) assert.deepEqual((await post(A, '/followup', { store: 914, wo: 8000001, due })).j, { error: 'follow-ups can only move later' }, due);
  for (const due of ['2026-02-30', '2026-1-05', 'tomorrow', 20261120, '']) assert.equal((await post(A, '/followup', { store: 914, wo: 8000001, due })).status, 400, String(due));
  assert.deepEqual((await post(A, '/followup', { store: 914, wo: 8000001, due: dd(400) })).j, { error: 'due: at most a year ahead' });
  assert.equal((await post(A, '/followup', { store: 914, wo: 8000001 })).status, 400, 'neither');
  assert.equal((await post(A, '/followup', { store: 914, wo: 8000001, due: dd(5), remove: true })).status, 400, 'both');
  assert.equal((await post(A, '/followup', { store: 914, wo: 8000001, remove: 'yes' })).status, 400);
  assert.equal((await post(A, '/followup', { store: 914, wo: 8000001, remove: false })).status, 400, 'remove false and no due');
  // the callback kind keeps its kind; an old row without one is rfp
  assert.deepEqual((await post(A, '/followup', { store: 914, wo: 8000002, due: dd(1) })).j.followUp, { kind: 'callback', due: dd(1) });
  assert.deepEqual((await post(A, '/followup', { store: 914, wo: 8000021, due: dd(1) })).j.followUp, { kind: 'rfp', due: dd(1) });
  // the same push through the Waymark Worker on another order: the same history row
  await wm('POST', '/914/wo/8000020/push', { due: dd(3), by: 'Linkpearl (Pixel Fold)' });
  const h1 = await histOf(914, 8000001), h2 = await histOf(914, 8000020);
  assert.deepEqual(h1.slice(-1), h2, 'push history matches the Worker\'s');
  assert.deepEqual(h2, [{ action: 'push', tag: null, detail: dd(-1) + ' → ' + dd(3), by_name: 'Linkpearl (Pixel Fold)', by_id: null }]);

  // remove: the row stays with removed_at (never re-created by Auto-Waymark), history 'unmark' with the old due, as the userscript's ×
  const rm = await post(A, '/followup', { store: 914, wo: 8000001, remove: true });
  assert.deepEqual(rm.j, { ok: true, store: 914, wo: 8000001, followUp: null });
  console.log('remove', JSON.stringify(rm.j));
  const row = await AE.prepare('SELECT due, removed_at FROM auto_marks WHERE store = 914 AND wo = 8000001').first();
  assert.equal(row.due, dd(3)); assert.ok(row.removed_at);
  await wm('POST', '/914/wo/8000020/unmark', { by: 'Linkpearl (Pixel Fold)' });
  assert.deepEqual((await histOf(914, 8000001)).slice(-1), (await histOf(914, 8000020)).slice(-1), 'unmark history matches the Worker\'s');
  assert.deepEqual((await histOf(914, 8000001)).slice(-1)[0], { action: 'unmark', tag: null, detail: dd(3), by_name: 'Linkpearl (Pixel Fold)', by_id: null });
  // Auto-Waymark does not bring it back; the Worker's read lists it as removed
  assert.deepEqual((await wm('POST', '/914/auto', { marks: [{ wo: 8000001, due: dd(9), kind: 'rfp' }] })).j.created, []);
  assert.ok((await wm('GET', '/914')).j.removed.some((x) => x.wo === 8000001));
  // after removal there is nothing to push or remove; no follow-up is ever created from the phone
  assert.deepEqual((await post(A, '/followup', { store: 914, wo: 8000001, due: dd(10) })).j, { error: 'no follow-up on this work order' });
  assert.equal((await post(A, '/followup', { store: 914, wo: 8000001, remove: true })).status, 404);
  assert.equal((await post(A, '/followup', { store: 914, wo: 8000003, due: dd(10) })).status, 404, 'removed earlier with x');
  assert.equal((await post(A, '/followup', { store: 914, wo: 8000005, due: dd(10) })).status, 404, 'never had one');
  assert.equal(await AE.prepare('SELECT 1 FROM auto_marks WHERE store = 914 AND wo = 8000005').first(), null, 'not created');
  // closed in the tracker / not tracked / not this phone's store
  assert.deepEqual((await post(A, '/followup', { store: 914, wo: 8000009, due: dd(10) })).j, { error: 'work order is closed' });
  assert.equal((await post(A, '/followup', { store: 914, wo: 8000099, due: dd(10) })).status, 404);
  assert.equal((await post(B, '/followup', { store: 914, wo: 8000030, due: dd(10) })).status, 403);
  assert.equal((await AE.prepare('SELECT due FROM auto_marks WHERE store = 914 AND wo = 8000030').first()).due, dd(-1), 'untouched');
  const lg = await logOf(L);
  assert.deepEqual(lg.map((x) => x.action), ['waymark:push', 'waymark:push', 'waymark:push', 'waymark:unmark']);
  assert.equal(lg[0].detail, dd(-1) + ' -> ' + dd(3) + ' ' + A.id.slice(0, 8));
  // the phone's own list shows the change
  const m = await marksFor(env, [{ store: 914, wo: 8000002, open: true }, { store: 914, wo: 8000001, open: true }]);
  assert.deepEqual(m.get('914|8000002').followUp, { kind: 'callback', due: dd(1) }); assert.equal(m.get('914|8000001').followUp, null);
  assert.deepEqual(m.get('914|8000001').tags, [{ tag: 'Priority', color: 'red' }]);
}

// ================================================================ the per-phone bound, refusals for other kinds of callers
{
  const C2 = await registerPhone('Busy phone'); await approve(C2, [914]);
  const since = new Date().toISOString();
  await env.TR.batch(Array.from({ length: WRITES_PER_HOUR }, () => env.TR.prepare("INSERT INTO access_log (email, action, store, wo, detail, at) VALUES ('device:Busy phone', 'waymark:tag', 914, 8000030, 'x', ?)").bind(since)));
  const r = await post(C2, '/tag', { store: 914, wo: 8000030, tag: 'Parts', on: true });
  assert.equal(r.status, 429); assert.equal(await AE.prepare("SELECT 1 FROM wo_tags WHERE store = 914 AND wo = 8000030").first(), null, 'nothing written');
  assert.equal((await post(A, '/tag', { store: 914, wo: 8000030, tag: 'Parts', on: true })).status, 200, 'other phones unaffected');
  assert.equal((await authed(C2, W + '/tags?store=914')).status, 200, 'reads are not bounded');

  const pending = await registerPhone('Waiting');
  assert.equal((await post(pending, '/tag', { store: 914, wo: 8000030, tag: 'X', on: true })).status, 403);
  assert.equal((await post(null, '/tag', { store: 914, wo: 8000030, tag: 'X', on: true })).status, 401);
  assert.equal((await post({ id: A.id, token: hex(32) }, '/followup', { store: 914, wo: 8000030, remove: true })).status, 401);
  const kp = await registerPhone('unused');
  const macId = hex(16), macTok = hex(32);
  await call('POST', '/v1/agents/register', { id: macId, name: 'Mac audit', publicJwk: kp.publicJwk, token: macTok });
  await admin('owner@x.com', 'POST', `/agents/${macId}/approve`, { stores: [914], keys: [] });
  assert.equal((await post({ id: macId, token: macTok }, '/followup', { store: 914, wo: 8000030, remove: true })).status, 403, 'Mac agent refused');
  assert.equal((await AE.prepare('SELECT removed_at FROM auto_marks WHERE store = 914 AND wo = 8000030').first()).removed_at, null);
}

// ================================================================ no staff names anywhere the phone wrote or read
{
  const all = JSON.stringify(await rows("SELECT by_name FROM history WHERE by_name LIKE 'Linkpearl%' UNION SELECT by_name FROM wo_tags WHERE by_name LIKE 'Linkpearl%'"));
  assert.ok(!all.includes('Alex Kim'));
  assert.equal((await rows("SELECT 1 FROM history WHERE by_name = 'Alex Kim'")).length, 0, 'the body\'s by is never written');
}
await T.dispose();
console.log('mobile-waymark: all passed');
