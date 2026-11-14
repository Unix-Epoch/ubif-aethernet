// Linkpearl work order lookup (/v1/agents/m/wo…): list / paging / lanes / sort, time in status, sealed cards, number lookup, detail timeline, sealed detail,
// access rules between phones, revoked and Mac-agent refusals, no names in plain responses, access_log rows, caps. Local D1 in its own scratch dir; everything invented.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup, C } from './mobile-helpers.mjs';
import { scrub, plainPart, cardOf, scanRow } from '../src/shape.js';
import { todayOf, marksFor } from '../src/mobile-waymark.js';
import { addDays } from '../src/metrics.js';

const T = await setup('.wrangler-test-mobile-wo');
const { env, call, admin, authed, registerPhone, approve } = T;
// Waymark's tables (../worker/schema.sql) in the local AE database, the way the live one has them
for (const st of readFileSync('../worker/schema.sql', 'utf8').replace(/--[^\n]*/g, '').split(';').map((x) => x.trim()).filter(Boolean)) await env.AE.prepare(st).run();
const WO = '/v1/agents/m/wo';
const ago = (hours) => new Date(Date.now() - hours * 3600000).toISOString();
const maxLog = async () => (await env.TR.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM access_log').first()).m;

// ---- invented customers and staff: none of these may ever appear in a plain response
const SECRETS = ['Jordan Reyes', 'Reyes', 'Alex Kim', 'Staffy', 'Tech Person', '757-555-0100', '7575550100', 'jordan.reyes@example.com', '353000111222333', 'SN-REYES-1', 'Screen is cracked'];
const bodies = [];
const get = async (p, path) => { const r = await authed(p, path); bodies.push(JSON.stringify(r.j)); return r; };

// ---- seeding through the real upload route (scan → detail), so plain / card / sealed / status_periods are what the Aethernet client makes
const rowsByStore = {};
const spec = (store, wo, status, name, trail, extra = {}) => (rowsByStore[store] = rowsByStore[store] || []).push(Object.assign({ wo, status, name, trail, created: 200 }, extra));
const cartOf = (v) => ({ cartItems: [{ name: 'Screen', sku: '1001', price: v, quantity: 1, totalPrice: v, partStatus: 'Reserved' }, { name: 'Labor', sku: '9', price: 0, quantity: 1, totalPrice: 0 }], payment: { total: v, amountPaid: 0, amountDue: v } });
spec(914, 7000001, 2, 'Need to order', [[2, 120]], { cart: cartOf(199), notes: 2, bin: 'B-12' });   // 5 days in Need to order
spec(914, 7000002, 9, 'Diagnostics', [[2, 150], [8, 100], [9, 48]], { cart: cartOf(89) });          // a timeline of three
spec(914, 7000003, 13, 'Ready for pickup', [[9, 70], [13, 24]], { cart: cartOf(149), notes: 1 });
spec(914, 7000004, 3, 'Awaiting item', [[3, 96]]);
spec(914, 7000005, 8, 'Ready for work', [[8, 72]]);
spec(914, 7000006, 99, 'Mystery status', [[99, 10]]);                                                // any other open status is Waiting
spec(914, 7000007, 24, 'Ready for Diag', [[24, 5]]);
spec(914, 7000010, 14, 'Sale complete', [[9, 300], [14, 60]]);                                       // closed (3 days ago, set below)
spec(914, 7000011, 15, 'Closed', [[9, 600], [15, 400]]);                                             // closed 10 days ago
spec(914, 7000012, 25, 'Cancelled', [[3, 900], [25, 800]]);                                          // closed 20 days ago
spec(326, 7100001, 10, 'Work in progress', [[10, 30]], { cart: cartOf(59) });
spec(326, 7100002, 2, 'Need to order', [[2, 8]]);
spec(536, 7200001, 4, 'Awaiting device', [[4, 20]]);

const detailOf = (store, s) => {
  const trail = s.trail.map(([st, h]) => ({ workorderStatusId: st, createdAt: ago(h), createdBy: 'Tech Person', completed: false }));
  return {
    workorder: { workorder: { workorderId: s.wo, storeId: store, workorderStatusId: s.status, WorkorderStatus: { name: s.name }, programId: 1, Program: { name: 'Retail' },
      CustomerDevice: { DeviceCatalog: { name: 'Galaxy S23 Ultra' }, imei: '353000111222333', serial: 'SN-REYES-1' }, claimNumber: 'CLM-' + s.wo,
      createdAt: ago(s.created), updatedAt: trail[trail.length - 1].createdAt, createdBy: { givenName: 'Staffy', familyName: 'Tech' }, slaEndTime: ago(-24), nextUpdate: ago(-4),
      WorkorderBinDeviceLocation: s.bin ? { WorkorderBin: { name: s.bin } } : null } },
    audit_trail: trail,
    customer_data: { customerId: 'C' + s.wo, CustomerDatum: { fullName: 'Jordan Reyes' }, CustomerDataPhones: [{ phone: '757-555-0100' }], CustomerDataEmails: [{ email: 'jordan.reyes@example.com' }] },
    notes: { total: s.notes || 0, latestManualNote: null, notes: Array.from({ length: s.notes || 0 }, (_, i) => ({ noteId: 'n' + i, noteType: 2, noteTag: i ? null : 'initial_checkin', noteText: 'Screen is cracked, Jordan will pick up', createdAt: ago(100 - i), UserDatum: { userId: 5, givenName: 'Alex', familyName: 'Kim' } })) },
    cart: s.cart || null,
    events: { events: [{ eventId: 'e1', timestamp: ago(90), eventType: 'PARTS_UPDATED', eventData: { type: 'add', items: [{ itemId: 1, quantity: 1, item: { name: 'Screen', itemNumber: '1001' } }] }, userId: 5, user: { givenName: 'Alex', familyName: 'Kim' } }] },
  };
};
const upload = async (store, s, trigger = 'new', withCard = true) => {
  const d = scrub(detailOf(store, s)), plain = plainPart(d, null), pub = T.storeKeys[store].publicJwk;
  return call('POST', `/v1/${store}/tracker/wo/${s.wo}`, { hash: await C.hashJson([plain, d]), trigger, plain, sealed: await C.sealJson(d, pub, C.aad.snapshot(store, s.wo)),
    card: withCard ? await C.sealJson(cardOf(d, null), pub, C.aad.card(store, s.wo)) : undefined, by: 'Tech Person' });
};
for (const [st, list] of Object.entries(rowsByStore)) {
  const store = Number(st);
  const listRows = list.map((s) => ({ workorderId: s.wo, workorderStatusId: s.status, workorderStatusName: s.name, programId: 1, programName: 'Retail', deviceCatalog: { name: 'Galaxy S23 Ultra' }, createdAt: ago(s.created), updatedAt: ago(1) }));
  assert.equal((await call('POST', `/v1/${store}/tracker/scan`, { rows: listRows.map(scanRow), storeName: 'x', by: 'Tech Person' })).status, 200);
  for (const s of list) { const r = await upload(store, s); assert.equal(r.status, 200, JSON.stringify(r.j)); }
}
for (const [wo, days] of [[7000010, 3], [7000011, 10], [7000012, 20]]) await env.TR.prepare('UPDATE workorders SET closed_at = ? WHERE store = 914 AND wo = ?').bind(ago(days * 24), wo).run();
// (the helper also seeded legacy rows 914: 1, 2, 3 · 326: 4 · 536: 5, 6 with no plain, card or status history)

// ---- phones: A has 914 + 326, B only 536, D is A-like but lost its 326 key, R gets revoked, a Mac agent, a pending one
const mk = async (name, stores, extra) => { const p = await registerPhone(name, extra); assert.equal((await approve(p, stores)).status, 200); return p; };
const A = await mk('Pixel A', [914, 326]), B = await mk('Pixel B', [536]), D = await mk('Pixel D', [914, 326]), R = await mk('Pixel R', [914]);
await env.TR.prepare('DELETE FROM agent_keys WHERE agent_id = ? AND store = 326').bind(D.id).run();
const mac = await mk('Mac audit', [914], { kind: undefined }); // no kind: a Mac program, not a phone
const P = await registerPhone('Pending'); // never approved

// ================================================================ list: scope, lanes, sort, time in status
let r = await get(A, WO);
assert.equal(r.status, 200); assert.equal(r.j.v, 1); assert.equal(r.j.state, 'open'); assert.equal(r.j.sort, 'status'); assert.deepEqual(r.j.stores, [914, 326]);
const first = r.j, all = [];
{ // page through everything, 4 at a time: stable, no duplicates, no gaps
  let after = null;
  for (let i = 0; i < 20; i++) {
    const x = await get(A, WO + '?limit=4' + (after ? '&after=' + after : ''));
    assert.equal(x.status, 200); assert.ok(x.j.rows.length <= 4);
    all.push(...x.j.rows); after = x.j.next; if (!after) break;
  }
  assert.equal(after, null, 'paging ends');
  const keys = all.map((x) => x.store + '|' + x.wo);
  assert.equal(new Set(keys).size, keys.length, 'no duplicates');
  assert.deepEqual(keys, (await get(A, WO + '?limit=100')).j.rows.map((x) => x.store + '|' + x.wo), 'pages add up to the whole list, same order');
}
assert.ok(all.every((x) => x.open && [914, 326].includes(x.store)));
assert.equal(all.filter((x) => x.store === 914).length, 3 + 7); assert.equal(all.filter((x) => x.store === 326).length, 1 + 2);
{ // lane chips (first page only) = Home's lane counts, = a recount of the rows
  const c = { order: 0, start: 0, work: 0, wait: 0, rfp: 0 };
  for (const x of all) c[x.lane]++;
  const { total, ...chips } = first.lanes; assert.deepEqual(chips, c); assert.equal(total, all.length);
  assert.deepEqual(first.lanes, (await authed(A, '/v1/agents/m/home?store=all')).j.lanes);
  assert.equal(c.order, 2 + 1); assert.equal(c.start, 2); assert.equal(c.rfp, 2 + 1); assert.equal(c.work, 2 + 1); assert.equal(c.wait, 2);
}
const row1 = all.find((x) => x.wo === 7000001);
assert.deepEqual(Object.keys(row1).sort(), ['bin', 'cartDue', 'cartValue', 'closedAt', 'closedReason', 'createdAt', 'device', 'followUp', 'lane', 'lastCartValue', 'notes', 'open', 'outcome', 'program', 'status', 'statusId', 'statusSince', 'store', 'tags', 'updatedAt', 'wo']);
assert.equal(row1.lane, 'order'); assert.equal(row1.status, 'Need to order'); assert.equal(row1.statusId, 2); assert.equal(row1.device, 'Galaxy S23 Ultra'); assert.equal(row1.program, 'Retail'); assert.equal(row1.bin, 'B-12');
assert.equal(row1.notes, 2); assert.equal(row1.cartValue, 199); assert.equal(row1.cartDue, 199); assert.equal(row1.closedAt, null); assert.ok(row1.createdAt && row1.updatedAt);
assert.ok(Math.abs(Date.parse(row1.statusSince) - (Date.now() - 120 * 3600000)) < 60000, 'status began 120 hours ago');
assert.equal(all.find((x) => x.wo === 7000006).lane, 'wait', 'unknown open status = Waiting');
assert.equal(all.find((x) => x.wo === 7000007).lane, 'start'); assert.equal(all.find((x) => x.wo === 7000003).lane, 'rfp');
assert.equal(all.find((x) => x.wo === 7000004).notes, 0); assert.equal(all.find((x) => x.wo === 1).notes, null, 'a row with no plain part: note count unknown');
{ // sort: longest in status first (oldest statusSince); unknown (null) last, by store then number
  const known = all.filter((x) => x.statusSince), unknown = all.filter((x) => !x.statusSince);
  assert.deepEqual(all.slice(0, known.length), known, 'known times first');
  assert.ok(known.every((x, i) => i === 0 || known[i - 1].statusSince <= x.statusSince), 'oldest first');
  assert.equal(known[0].wo, 7000001);
  assert.deepEqual(unknown.map((x) => [x.store, x.wo]), [[326, 4], [914, 1], [914, 2], [914, 3]], 'rows with no status history: null (never updatedAt), after the rest');
}
// a stale period (the work order's status moved but the period did not) is unknown, not a wrong number
await env.TR.prepare('UPDATE workorders SET status_id = 12 WHERE store = 914 AND wo = 7000001').run();
assert.equal((await get(A, WO + '?store=914&limit=100')).j.rows.find((x) => x.wo === 7000001).statusSince, null);
await env.TR.prepare('UPDATE workorders SET status_id = 2 WHERE store = 914 AND wo = 7000001').run();
for (const [lane, want] of [['order', [2]], ['start', [8, 24]], ['work', [9, 10]], ['rfp', [13]]]) {
  const x = await get(A, WO + '?lane=' + lane + '&limit=100');
  assert.ok(x.j.rows.length >= 2 && x.j.rows.every((y) => y.lane === lane && want.includes(y.statusId)), lane);
}
{ const x = await get(A, WO + '?lane=wait&limit=100'); assert.deepEqual(x.j.rows.map((y) => y.statusId).sort(), [3, 99]); }
{ const x = await get(A, WO + '?lane=order,rfp&limit=100'); assert.ok(x.j.rows.length && x.j.rows.every((y) => ['order', 'rfp'].includes(y.lane))); assert.deepEqual(x.j.lanes, first.lanes, 'chips are not narrowed by the lane filter'); }
assert.equal((await get(A, WO + '?lane=bogus')).status, 400); assert.equal((await get(A, WO + '?lane=order&state=recent')).status, 400);
{ const x = await get(A, WO + '?sort=updated&limit=100'); assert.equal(x.j.sort, 'updated'); assert.ok(x.j.rows.every((y, i) => i === 0 || (x.j.rows[i - 1].updatedAt || '') >= (y.updatedAt || ''))); }
assert.equal((await get(A, WO + '?sort=closed')).status, 400, 'closed order needs state=recent'); assert.equal((await get(A, WO + '?sort=bogus')).status, 400); assert.equal((await get(A, WO + '?state=bogus')).status, 400);
assert.deepEqual([...new Set((await get(A, WO + '?store=326&limit=100')).j.rows.map((x) => x.store))], [326]);
assert.equal((await get(A, WO + '?store=536')).status, 403); assert.equal((await get(A, WO + '?store=536')).j.error, 'not your store'); assert.equal((await get(A, WO + '?store=zzz')).status, 400);
{ const a = await get(A, WO + '?limit=2'); assert.equal((await get(A, WO + '?sort=updated&after=' + a.j.next)).status, 400, 'a cursor belongs to its sort'); assert.equal((await get(A, WO + '?after=%25%25')).status, 400); assert.equal((await get(A, WO + '?state=recent&after=' + a.j.next)).status, 400); }
assert.ok(JSON.stringify((await get(A, WO)).j).length < 12000, 'phone-sized page (25 rows)');

// ================================================================ recent: closed within closedDays
r = await get(A, WO + '?state=recent&store=914');
assert.equal(r.status, 200); assert.equal(r.j.sort, 'closed'); assert.equal(r.j.closedDays, 7);
assert.deepEqual(r.j.rows.map((x) => x.wo), [7000010], 'default 7 days: only the one closed 3 days ago');
assert.ok(r.j.rows[0].open === false && r.j.rows[0].lane === null && r.j.rows[0].statusSince === null && r.j.rows[0].closedAt && r.j.lanes === undefined);
assert.deepEqual((await get(A, WO + '?state=recent&store=914&closedDays=14')).j.rows.map((x) => x.wo), [7000010, 7000011], 'newest close first');
{ const x = await get(A, WO + '?state=recent&store=914&closedDays=999'); assert.equal(x.j.closedDays, 14, 'clamped to 14'); assert.deepEqual(x.j.rows.map((y) => y.wo), [7000010, 7000011]); }

// ================================================================ cards=1: sealed search cards, opened with the store key the phone holds
const me = (await authed(A, '/v1/agents/me')).j, storeKeyOf = {};
for (const k of me.keys) storeKeyOf[k.store] = await C.importPrivate(await C.openBytes(k.wrapped, A.kp.privateKey, 'agentkey|' + A.id + '|' + k.store));
assert.ok(all.every((x) => !('card' in x)), 'no cards unless asked');
let mark = await maxLog();
r = await get(A, WO + '?cards=1&limit=100');
assert.equal(r.status, 200); assert.equal(r.j.cards, true); assert.deepEqual([...r.j.cardsFor].sort(), [326, 914]); assert.deepEqual(r.j.noKey, []);
{
  const mine = r.j.rows.find((x) => x.wo === 7000002);
  assert.match(mine.card, /^v1\./);
  assert.deepEqual(await C.openJson(mine.card, storeKeyOf[914], C.aad.card(914, 7000002)), { name: 'Jordan Reyes', customerId: 'C7000002', phones: ['7575550100'], emails: ['jordan.reyes@example.com'], imei: '353000111222333', serial: 'SN-REYES-1', claim: 'CLM-7000002' });
  await assert.rejects(C.openJson(mine.card, storeKeyOf[914], C.aad.card(914, 7000001)), 'a card cannot be moved to another work order');
  await assert.rejects(C.openJson(mine.card, storeKeyOf[326], C.aad.card(914, 7000002)), 'nor opened with another store key');
  assert.equal(r.j.rows.find((x) => x.wo === 1).card, null, 'a work order with no card yet: null');
  assert.ok(JSON.stringify(r.j).length < 100000);
  const logs = (await env.TR.prepare('SELECT email, action, store, wo, detail FROM access_log WHERE id > ? ORDER BY store').bind(mark).all()).results;
  assert.deepEqual(logs.map((x) => [x.email, x.action, x.store, x.wo]), [['device:Pixel A', 'list', 326, null], ['device:Pixel A', 'list', 914, null]], 'one list row per store whose cards went out, the device as actor');
  assert.ok(logs.every((x) => /^phone cards \d+ [0-9a-f]{8}$/.test(x.detail))); assert.equal(logs[1].detail.split(' ')[2], String(r.j.rows.filter((x) => x.store === 914 && x.card).length));
}
{ // plain reads are not logged (Home-like polling)
  mark = await maxLog(); await get(A, WO + '?limit=10'); await get(A, WO + '/find?q=7000'); await get(A, WO + '/914/7000001');
  assert.equal(await maxLog(), mark, 'no sealed data, no log row');
}
// a phone that lost one store key: cards only for the other; the keyless store alone is refused for cards; plain data still fine
r = await get(D, WO + '?cards=1&limit=100');
assert.equal(r.status, 200); assert.deepEqual(r.j.cardsFor, [914]); assert.deepEqual(r.j.noKey, [326]);
assert.ok(r.j.rows.filter((x) => x.store === 326).every((x) => x.card === null) && r.j.rows.filter((x) => x.store === 914 && x.wo > 7000000).every((x) => /^v1\./.test(x.card)));
assert.equal((await get(D, WO + '?cards=1&store=326')).status, 403); assert.equal((await get(D, WO + '?store=326')).status, 200);
mark = await maxLog();
assert.equal((await get(D, WO + '/326/7100001?sealed=1')).status, 403, 'no wrapped key: no sealed detail'); assert.equal((await get(D, WO + '/326/7100001')).status, 200);
assert.equal(await maxLog(), mark, 'a refused sealed read hands out nothing and logs nothing');

// ================================================================ number lookup: exact or prefix, open and closed, bounded
r = await get(A, WO + '/find?q=7000010');
assert.equal(r.status, 200); assert.deepEqual(r.j.rows.map((x) => [x.store, x.wo, x.open]), [[914, 7000010, false]], 'exact, closed'); assert.equal(r.j.rows[0].lane, null); assert.equal(r.j.more, false);
assert.deepEqual((await get(A, WO + '/find?q=70000')).j.rows.map((x) => x.wo), [7000001, 7000002, 7000003, 7000004, 7000005, 7000006, 7000007, 7000010, 7000011, 7000012], 'a prefix finds open and closed, in order');
assert.deepEqual((await get(A, WO + '/find?q=710')).j.rows.map((x) => [x.store, x.wo]), [[326, 7100001], [326, 7100002]], 'across the device stores');
assert.deepEqual((await get(A, WO + '/find?q=7000012&store=914')).j.rows.map((x) => x.wo), [7000012]);
assert.deepEqual((await get(A, WO + '/find?q=7200001')).j.rows, [], 'a store the phone is not approved for never shows');
assert.equal((await get(A, WO + '/find?q=7200001&store=536')).status, 403);
assert.deepEqual((await get(A, WO + '/find?q=999999')).j.rows, []);
for (const bad of ['', 'abc', '10', '012', '1234567890123', '70 00']) assert.equal((await get(A, WO + '/find?q=' + encodeURIComponent(bad))).status, 400, 'q=' + bad);
{ const x = await get(A, WO + '/find?q=70000&limit=3'); assert.equal(x.j.rows.length, 3); assert.equal(x.j.more, true); }

// ================================================================ detail: header, timeline, cart
r = await get(A, WO + '/914/7000002');
assert.equal(r.status, 200); assert.equal(r.j.v, 1); assert.ok(!('sealed' in r.j));
assert.equal(r.j.wo.wo, 7000002); assert.equal(r.j.wo.lane, 'work'); assert.equal(r.j.wo.status, 'Diagnostics'); assert.ok(r.j.wo.nextUpdate && r.j.wo.slaEnd); assert.equal(r.j.wo.rfpAt, null);
assert.equal(r.j.timelineSource, 'periods');
{
  const tl = r.j.timeline;
  assert.deepEqual(tl.map((x) => x.statusId), [9, 8, 2], 'newest first'); assert.deepEqual(tl.map((x) => x.current), [true, false, false]);
  assert.equal(tl[0].end, null); assert.equal(tl[1].end, tl[0].start); assert.equal(tl[2].end, tl[1].start, 'each ends where the next begins');
  assert.equal(tl[2].status, 'Need to order'); assert.equal(tl[1].lane, 'start'); assert.equal(tl[0].lane, 'work');
  for (const x of tl) assert.equal(x.seconds, Math.round((Date.parse(x.end || r.j.now) - Date.parse(x.start)) / 1000));
  assert.ok(Math.abs(tl[2].seconds - 50 * 3600) < 120 && Math.abs(tl[1].seconds - 52 * 3600) < 120, 'durations in seconds');
  assert.equal(r.j.wo.statusSince, tl[0].start, 'header time in status = the current interval');
}
assert.deepEqual(r.j.cart, { value: 89, total: 89, paid: 0, due: 89, lines: [{ name: 'Screen', sku: '1001', quantity: 1, price: 89, totalPrice: 89, partStatus: 'Reserved' }, { name: 'Labor', sku: '9', quantity: 1, price: 0, totalPrice: 0, partStatus: null }] });
{ const x = (await get(A, WO + '/914/7000010')).j; assert.equal(x.wo.open, false); assert.ok(x.wo.closedAt); assert.equal(x.wo.closedReason, 'Sale complete'); assert.equal(x.wo.statusSince, null); assert.deepEqual(x.timeline.map((y) => y.statusId), [9], 'closed statuses have no interval of their own'); assert.equal(x.timeline[0].current, false); }
{ const x = (await get(A, WO + '/914/1')).j; assert.deepEqual(x.timeline, []); assert.equal(x.timelineSource, null); assert.equal(x.wo.statusSince, null); assert.deepEqual(x.cart.lines, []); assert.equal(x.wo.notes, null); }
{ // no periods but change rows: rebuilt from `changes` (first interval's start unknown)
  await env.TR.prepare('DELETE FROM status_periods WHERE store = 914 AND wo = 7000002').run();
  await env.TR.prepare("INSERT INTO changes (store, wo, changed_at, field, old, new) VALUES (914, 7000002, ?, 'workorder.statusId', '2', '8'), (914, 7000002, ?, 'workorder.statusId', '8', '9')").bind(ago(100), ago(48)).run();
  const x = (await get(A, WO + '/914/7000002')).j;
  assert.equal(x.timelineSource, 'changes'); assert.deepEqual(x.timeline.map((y) => [y.statusId, y.current]), [[9, true], [8, false], [2, false]]); assert.equal(x.timeline[2].start, null); assert.equal(x.timeline[2].seconds, null);
  assert.equal(x.wo.statusSince, null, 'no period: never guessed');
}
assert.equal((await get(A, WO + '/914/999999')).status, 404); assert.equal((await get(A, WO + '/914/999999')).j.error, 'no such work order');
assert.equal((await get(A, WO + '/536/7200001')).status, 403); assert.equal((await get(A, WO + '/326/7000001')).status, 404, 'right store, not there');
assert.equal((await get(A, WO + '/914/abc')).status, 404); assert.equal((await get(A, WO + '/9/9/9')).status, 404);

// ================================================================ detail sealed=1: card + latest snapshot, logged
{
  mark = await maxLog();
  r = await get(A, WO + '/914/7000001?sealed=1');
  assert.equal(r.status, 200); assert.deepEqual(Object.keys(r.j.sealed).sort(), ['card', 'snapshot']); assert.deepEqual(Object.keys(r.j.sealed.snapshot).sort(), ['fetchedAt', 'id', 'sealed']);
  assert.deepEqual(await C.openJson(r.j.sealed.card, storeKeyOf[914], C.aad.card(914, 7000001)), { name: 'Jordan Reyes', customerId: 'C7000001', phones: ['7575550100'], emails: ['jordan.reyes@example.com'], imei: '353000111222333', serial: 'SN-REYES-1', claim: 'CLM-7000001' });
  const snap = await C.openJson(r.j.sealed.snapshot.sealed, storeKeyOf[914], C.aad.snapshot(914, 7000001));
  assert.deepEqual(Object.keys(snap).sort(), ['audit_trail', 'cart', 'customer_data', 'events', 'notes', 'workorder']);
  assert.equal(snap.notes.total, 2); assert.equal(snap.notes.notes.length, 2);
  assert.deepEqual(Object.keys(snap.notes.notes[0]).sort(), ['UserDatum', 'createdAt', 'noteId', 'noteTag', 'noteText', 'noteType']);
  assert.equal(snap.notes.notes[0].noteText, 'Screen is cracked, Jordan will pick up'); assert.equal(snap.notes.notes[0].UserDatum.givenName, 'Alex');
  assert.equal(snap.customer_data.CustomerDatum.fullName, 'Jordan Reyes'); assert.equal(snap.workorder.workorder.CustomerDevice.imei, '353000111222333');
  assert.ok(Math.abs(Date.parse(r.j.sealed.snapshot.fetchedAt) - Date.now()) < 120000);
  const logs = (await env.TR.prepare('SELECT email, action, store, wo, detail FROM access_log WHERE id > ?').bind(mark).all()).results;
  assert.deepEqual(logs.map((x) => [x.email, x.action, x.store, x.wo]), [['device:Pixel A', 'open', 914, 7000001]]); assert.match(logs[0].detail, /^phone sealed [0-9a-f]{8}$/);
  // a work order with no snapshot or card yet: nulls, still logged
  await env.TR.prepare('INSERT INTO workorders (store, wo, status_id, is_open) VALUES (914, 7999999, 2, 1)').run();
  const x = await get(A, WO + '/914/7999999?sealed=1'); assert.equal(x.status, 200); assert.deepEqual(x.j.sealed, { card: null, snapshot: null });
  assert.equal((await env.TR.prepare("SELECT COUNT(*) AS n FROM access_log WHERE email = 'device:Pixel A' AND action = 'open'").first()).n, 2);
  // the latest snapshot wins, and an upload without a card keeps the old card
  assert.equal((await upload(914, { wo: 7000001, status: 2, name: 'Need to order', trail: [[2, 120]], created: 200, notes: 3 }, 'changed', false)).status, 200);
  const y = (await get(A, WO + '/914/7000001?sealed=1')).j;
  assert.equal((await C.openJson(y.sealed.snapshot.sealed, storeKeyOf[914], C.aad.snapshot(914, 7000001))).notes.total, 3); assert.ok(y.sealed.snapshot.id > r.j.sealed.snapshot.id);
  assert.match(y.sealed.card, /^v1\./); assert.equal((await get(A, WO + '/914/7000001')).j.wo.notes, 3);
}

// ================================================================ the documented test vector (MOBILE-API-wo.md must carry the same values)
const VECTOR = {"storePrivateKeyPkcs8Base64Url":"MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgj7zkPtASOtqIrFPoNpVgvyq-isqyjIiXfChJly3kkvehRANCAATukLv1ZEl6KV_vINoEQwkqbIn2D8vIAf7vWLDbYhthTCAMMnVYF4LQo-T3B_kq5_3lH3gv1-UVUVl8z6M-hemF","storePublicJwk":{"kty":"EC","crv":"P-256","x":"7pC79WRJeilf7yDaBEMJKmyJ9g_LyAH-71iw22IbYUw","y":"IAwydVgXgtCj5PcH-Srn_eUfeC_X5RVRWXzPoz6F6YU"},"card":{"aad":"card|914|700000123","sealed":"v1.BOk3HTerTewDZNoHNFtu78uZQ9gBIo1zwU-nckLZkXC6ZTNFlJ9R2-zh7s997jswBl5a5QpThsFq8eCGzGcnsmBo7TUjdz_f5Zln-bUwvJKkKO3duddXkpz7ZxLzIF-tjuPbjMrvy-Z9eLkyTgiZiham3U9QVAC9Pz3Ujl_4jysrqgcQ7GGF_EowscY_-mNVLKXXieYgRTy0gJXGFBpIb3Yh63PxHKkbDjvySHPz8J42fi_3y9oQxMlkM7_ohzUHYkxFn8Xlnne0MB06nshBBL-iK_tXrjmi30Uvxo0I6nV1W-XWNeEivtSF4-mrwqWQZ7dzBzwYUiADwSMMwApW","plaintext":{"name":"Sam Sample","customerId":"C-TEST-1","phones":["5555550123"],"emails":["sam.sample@example.com"],"imei":"490154203237518","serial":"F2LTESTSERIAL","claim":"CLM-TEST-1"}},"snapshot":{"aad":"snapshot|914|700000123","sealed":"v1.BOg1CDkIgRBq-zZmfoPa9Vm715qQK7I_-3Wc9ROFADKXXlyrYeiVBkYbs7KfkT4o45Lyjdqkf1xcMc3VN5apTZ06-FDA0au6G2Ud_bBNNw4EoD_P3AZtjtetfsn5eHl8Bckt8m3ai3Sw-r_kd80M0STXufzyQCNZlXZtjbNQ2GMxPAYDToJWuJKn3NlwUjctKzu3uAtlVFzmYnVl21JOnxhF2sddUxlgQcjgxfOdSYi5sZTk00ZvMIY8WCjm8T7Xn1Nv2LDHlsY9_CMh3Mufj-qmb1sLfSngnuDpxfIC5_m8yyQkPfOb9EePMNzEtnMiukXGvrSxpVgpfy0Js5n6GgsU3bLb9UAQvY4AkqVkARLe6g8DGsqcgudejMQLk4fZK2tIwiNMWmZ_owZfhtABPAv0tvBvjF6GR2d7gDPGjDyGUsFGG-P4GwMdsvLM3PxUKKZe2QgZCYgvYVqpaRq2f6Te0pWOb8A03YwSNUc9NaYtwkH8-iGrGU3OqN6j3JIOWQhnwvtWRBqwGYqXk46Bcf9ZolZzfGuHI0K0F_KZ9oZhsM2eRi8tACFByhZ5n3BQSBsRbh4rKSifs-FP4UFNSB3BdKZVyAdWt2RLtW8_2B87QK7K_q2dFzCCr4yp7IWFdlZj_0V51AEHfMHz4qFF1pjDdOAZAXSynl1h6AGoAFzW9Uli_rrtooYJJOZHaQySExkRJuHyTGddtW3xsK2MQ9cVuzBv_z6Uu0UAEYJa1yJzwV2oEHCju5V4fJQzKR8200ZKjLTLH0fdD5Bc3VJ3oeKV95X7ig9XjfZe8TAkhw6ycJvW-zxzgPhUcwam8nHL5dqm3qa-HXc","plaintext":{"workorder":{"workorder":{"workorderId":700000123,"storeId":914,"workorderStatusId":9,"CustomerDevice":{"imei":"490154203237518","serial":"F2LTESTSERIAL","DeviceCatalog":{"name":"Galaxy S23 Ultra"}}}},"audit_trail":[{"workorderStatusId":9,"createdAt":"2026-11-10T15:00:00.000Z","createdBy":"Test Tech"}],"customer_data":{"customerId":"C-TEST-1","CustomerDatum":{"fullName":"Sam Sample"},"CustomerDataPhones":[{"phone":"555-555-0123"}],"CustomerDataEmails":[{"email":"sam.sample@example.com"}]},"notes":{"total":2,"latestManualNote":null,"notes":[{"noteId":"n2","noteType":2,"noteTag":null,"noteText":"Customer asked for a text when it is ready.","createdAt":"2026-11-11T14:30:00.000Z","UserDatum":{"userId":77,"givenName":"Test","familyName":"Tech"}},{"noteId":"n1","noteType":1,"noteTag":null,"noteText":"Test Tech started Diagnostics.","createdAt":"2026-11-10T15:00:00.000Z","UserDatum":{"userId":77,"givenName":"Test","familyName":"Tech"}}]},"cart":{"cartItems":[{"name":"Screen","sku":"1001","price":199,"quantity":1,"totalPrice":199}],"payment":{"total":199,"amountPaid":0,"amountDue":199}}}}};
{
  const key = await C.importPrivate(C.unb64u(VECTOR.storePrivateKeyPkcs8Base64Url));
  assert.deepEqual(await C.openJson(VECTOR.card.sealed, key, VECTOR.card.aad), VECTOR.card.plaintext);
  assert.deepEqual(await C.openJson(VECTOR.snapshot.sealed, key, VECTOR.snapshot.aad), VECTOR.snapshot.plaintext);
  await assert.rejects(C.openJson(VECTOR.card.sealed, key, VECTOR.snapshot.aad));
  const doc = readFileSync(new URL('../MOBILE-API-wo.md', import.meta.url), 'utf8');
  for (const s of [VECTOR.storePrivateKeyPkcs8Base64Url, VECTOR.card.sealed, VECTOR.snapshot.sealed, VECTOR.card.aad, VECTOR.snapshot.aad, JSON.stringify(VECTOR.card.plaintext)]) assert.ok(doc.includes(s), 'the doc carries the vector: ' + s.slice(0, 30));
}

// ================================================================ access between phones, refusals
r = await get(B, WO + '?limit=100');
assert.deepEqual([...new Set(r.j.rows.map((x) => x.store))], [536]); assert.deepEqual(r.j.stores, [536]);
for (const path of ['?store=914', '?store=326&cards=1', '/914/7000001', '/914/7000001?sealed=1', '/326/7100001?sealed=1', '/find?q=7000001&store=914', '?state=recent&store=914']) assert.equal((await get(B, WO + path)).status, 403, path);
assert.deepEqual((await get(B, WO + '/find?q=7000001')).j.rows, []);
assert.ok((await get(B, WO + '?cards=1')).j.rows.every((x) => x.store === 536));
{ const x = (await get(B, WO + '/536/7200001?sealed=1')).j, kb = await C.importPrivate(await C.openBytes((await authed(B, '/v1/agents/me')).j.keys[0].wrapped, B.kp.privateKey, 'agentkey|' + B.id + '|536'));
  assert.equal((await C.openJson(x.sealed.card, kb, C.aad.card(536, 7200001))).name, 'Jordan Reyes'); await assert.rejects(C.openJson(x.sealed.card, storeKeyOf[914], C.aad.card(536, 7200001)), "A's key does not open B's store"); }
assert.equal((await authed(mac, WO)).status, 403); assert.equal((await authed(mac, WO)).j.error, 'not a phone'); assert.equal((await authed(mac, WO + '/914/7000001?sealed=1')).status, 403);
assert.equal((await authed(P, WO)).status, 403); assert.equal((await authed(null, WO)).status, 401);
assert.equal((await call('GET', WO, null, { 'x-aethernet-key': 'wrong', authorization: 'Bearer ' + A.id + '.' + A.token })).status, 403);
assert.equal((await authed(A, WO, { method: 'POST', body: {} })).status, 404); assert.equal((await authed(A, WO + '/914/7000001', { method: 'DELETE' })).status, 404);
assert.equal((await authed(mac, '/v1/agents/wos?store=914')).status, 200, "the Mac's own route is untouched");
// revoked: the very next call fails
assert.equal((await get(R, WO + '/914/7000001?sealed=1')).status, 200);
assert.equal((await admin('owner@x.com', 'POST', `/agents/${R.id}/remove`)).status, 200);
for (const path of ['', '/find?q=7000', '/914/7000001', '/914/7000001?sealed=1', '?cards=1']) assert.equal((await authed(R, WO + path)).status, 401, 'revoked ' + path);
{ // an approved phone with no stores: empty, not an error
  const E = await registerPhone('Empty'); await env.TR.prepare("UPDATE agents SET status = 'active' WHERE id = ?").bind(E.id).run();
  const x = await authed(E, WO); assert.equal(x.status, 200); assert.deepEqual(x.j.rows, []); assert.deepEqual((await authed(E, WO + '/find?q=7000')).j.rows, []); assert.equal((await authed(E, WO + '/914/7000001')).status, 403);
}


// ================================================================ closed list (state=closed): every closed work order, newest close first
{
  const closed = (path) => get(A, WO + '?state=closed' + path);
  await env.TR.prepare("INSERT INTO workorders (store, wo, status_id, status_name, is_open, closed_at, closed_reason, last_cart_value) VALUES (326, 7100009, 15, 'Closed', 0, ?, 'Closed', 42.5)").bind(ago(3 * 24)).run();
  const tie = (await env.TR.prepare('SELECT closed_at FROM workorders WHERE store = 914 AND wo = 7000010').first()).closed_at;
  await env.TR.prepare('UPDATE workorders SET closed_at = ? WHERE store = 326 AND wo = 7100009').bind(tie).run(); // the same close time as 914/7000010: store breaks the tie
  await env.TR.prepare("INSERT INTO workorders (store, wo, status_id, is_open) VALUES (914, 7000013, 15, 0)").run(); // closed with no close time: not listed
  await env.TR.prepare('UPDATE workorders SET last_cart_value = 149 WHERE store = 914 AND wo = 7000010').run();
  r = await closed('&limit=100');
  assert.equal(r.status, 200); assert.equal(r.j.state, 'closed'); assert.equal(r.j.sort, 'closed'); assert.equal(r.j.closedDays, undefined); assert.equal(r.j.lanes, undefined); assert.equal(r.j.followUps, undefined);
  assert.deepEqual(r.j.rows.map((x) => [x.store, x.wo]), [[326, 7100009], [914, 7000010], [914, 7000011], [914, 7000012]], 'all closed, newest close first, equal times by store');
  assert.ok(r.j.rows.every((x) => x.open === false && x.lane === null && x.statusSince === null && !('tags' in x)));
  assert.deepEqual([r.j.rows[1].closedReason, r.j.rows[1].lastCartValue, r.j.rows[0].closedReason, r.j.rows[0].lastCartValue], ['Sale complete', 149, 'Closed', 42.5]);
  assert.equal(r.j.rows[2].lastCartValue, null);
  assert.equal(r.j.next, null);
  { // paging one at a time reaches the 20-day-old one that `recent` can never show, with no gaps or repeats
    const seenK = []; let after = null;
    for (let i = 0; i < 10; i++) { const x = await closed('&limit=1' + (after ? '&after=' + after : '')); assert.equal(x.status, 200); seenK.push(...x.j.rows.map((y) => y.store + '|' + y.wo)); after = x.j.next; if (!after) break; }
    assert.deepEqual(seenK, r.j.rows.map((y) => y.store + '|' + y.wo)); assert.equal(after, null);
  }
  assert.deepEqual((await closed('&store=914&limit=2')).j.rows.map((x) => x.wo), [7000010, 7000011]);
  assert.deepEqual((await get(A, WO + '?state=closed&store=914&limit=2&after=' + (await closed('&store=914&limit=2')).j.next)).j.rows.map((x) => x.wo), [7000012]);
  assert.equal((await closed('&store=536')).status, 403); assert.equal((await closed('&sort=updated')).status, 400); assert.equal((await closed('&lane=work')).status, 400);
  { const a = await closed('&limit=1'); assert.equal((await get(A, WO + '?state=recent&after=' + a.j.next)).status, 400, 'cursors do not cross lists'); assert.equal((await get(A, WO + '?after=' + a.j.next)).status, 400); }
  assert.equal((await get(B, WO + '?state=closed')).j.rows.length, 0, 'store 536 has none closed'); assert.equal((await get(B, WO + '?state=closed&store=914')).status, 403);
  // cards on the closed list: same rules as the other lists
  { const x = await closed('&store=914&cards=1&limit=5'); assert.equal(x.status, 200); assert.deepEqual(x.j.cardsFor, [914]); assert.ok(x.j.rows.every((y) => /^v1\./.test(y.card))); }
  assert.equal((await get(D, WO + '?state=closed&store=326&cards=1')).status, 403);
  // old clients: state=recent, its default sort, closedDays clamp and its page shape are unchanged by the new state
  { const x = await get(A, WO + '?state=recent&store=914&closedDays=14'); assert.deepEqual(x.j.rows.map((y) => y.wo), [7000010, 7000011]); assert.equal(x.j.closedDays, 14); assert.equal(x.j.state, 'recent');
    assert.deepEqual(Object.keys(x.j).sort(), ['closedDays', 'next', 'now', 'rows', 'scope', 'sort', 'state', 'stores', 'v']); assert.equal(x.j.rows[0].lastCartValue, 149); }
  assert.equal((await get(A, WO + '?state=recent&store=914&sort=closed&closedDays=999')).j.closedDays, 14);
  // the index: each store's statement seeks wo_closed (store, is_open, closed_at) and never reads past its page
  const plan = (await env.TR.prepare("EXPLAIN QUERY PLAN SELECT w.store, w.wo, w.closed_at AS e FROM workorders w WHERE w.store = ? AND w.is_open = 0 AND w.closed_at IS NOT NULL AND w.closed_at <= ? ORDER BY w.closed_at DESC, w.wo LIMIT 5").bind(914, 'x').all()).results.map((x) => x.detail).join(' | ');
  assert.match(plan, /USING INDEX wo_closed/); if (process.env.WO_PLAN) console.log('PLAN', plan);
}

// ================================================================ detail: parts sold, status / next-update changes, closed fields
{
  await env.TR.batch([
    env.TR.prepare("INSERT OR REPLACE INTO statuses (id, name) VALUES (9, 'Diagnostics'), (8, 'Ready for work'), (2, 'Need to order'), (13, 'Ready for pickup'), (14, 'Sale complete')"),
    env.TR.prepare("INSERT INTO inv_items (store, item, name, first_seen, last_seen) VALUES (914, '176255', 'Galaxy S23 screen', ?1, ?1)").bind(ago(500)),
    env.TR.prepare("INSERT INTO inv_wo_sold (store, wo, state, updated_at) VALUES (914, '7000010', 'done', ?)").bind(ago(1)),
    env.TR.prepare("INSERT INTO inv_wo_parts (store, wo, line, label, item, sku, name, quantity, price, serial_status, line_type, sales_order, sold_at, recorded_at) VALUES (914, '7000010', 'L1', '176255-0000514371', '176255', '176255', 'Screen assembly', 1, 129.99, 'Sold', 'part', 'FSO000011111', ?1, ?1), (914, '7000010', 'L2', '176300-0000000009', '176255', '176300', NULL, 2, 5, 'Sold', 'part', 'FSO000011111', ?1, ?1)").bind(ago(60)),
    env.TR.prepare("INSERT INTO inv_wo_parts (store, wo, line, label, item, quantity, price, recorded_at) VALUES (914, '7000011', 'x', '176255-0000000001', '176255', 1, 1, ?)").bind(ago(1)),
    // the changes: status and next-update rows the app wants, rows it must never get (staff, cart, audit trail, other fields)
    env.TR.prepare("DELETE FROM changes WHERE store = 914 AND wo = 7000010"),
  ]);
  const ins = (field, o, n, h) => env.TR.prepare('INSERT INTO changes (store, wo, changed_at, field, old, new) VALUES (914, 7000010, ?, ?, ?, ?)').bind(ago(h), field, o, n);
  await env.TR.batch([ // oldest first, the way the tracker writes them (ids rise with time)
    ins('workorder.statusId', null, '9', 300), ins('workorder.nextUpdate', null, JSON.stringify('2026-11-13T15:00:00.000Z'), 200), ins('workorder.nextUpdate', JSON.stringify('2026-11-13T15:00:00Z'), 'null', 100),
    ins('workorder.nextUpdate', JSON.stringify('not a date'), JSON.stringify('2026-11-20T10:30:00+01:00'), 90),
    ins('workorder.updatedBy', '"Staffy Tech"', '"Alex Kim"', 70), ins('workorder.createdBy.givenName', null, '"Staffy"', 70), ins('auditTrail.0.createdBy', null, '"Tech Person"', 70),
    ins('cart.payment.total', '199', '0', 61), ins('cart.items.0.price', '199', null, 61), ins('workorder.status', '"Diagnostics"', '"Sale complete"', 60), ins('workorder.total', '1', '2', 60),
    ins('workorder.statusId', '9', '14', 60), ins('workorder.statusId', '14', '77', 59),
  ]);
  r = await get(A, WO + '/914/7000010');
  assert.equal(r.status, 200);
  assert.deepEqual(r.j.changes.map((c) => [c.field, c.old, c.new]), [
    ['status', 'Sale complete', '77'],                          // newest: an id the statuses table does not know comes back as the id as text
    ['status', 'Diagnostics', 'Sale complete'],                 // ids resolved through `statuses`
    ['nextUpdate', null, '2026-11-20T09:30:00.000Z'],           // old was not a time: null; new carried an offset: ISO UTC
    ['nextUpdate', '2026-11-13T15:00:00.000Z', null],           // cleared (stored as JSON null)
    ['nextUpdate', null, '2026-11-13T15:00:00.000Z'],           // set (stored JSON-quoted)
    ['status', null, 'Diagnostics'],                            // first sight: no old
  ]);
  assert.ok(r.j.changes.every((c) => Object.keys(c).sort().join() === 'at,field,new,old' && /^\d{4}-\d\d-\d\dT.*Z$/.test(c.at)));
  assert.ok(r.j.changes.every((c, i, a) => !i || a[i - 1].at >= c.at), 'newest first');
  assert.ok(!r.j.changes.some((c) => c.field === 'cartValue'), 'no cart value: the tracker records no single field for it (see MOBILE-API-wo.md)');
  assert.deepEqual(r.j.parts, { state: 'done', rows: [
    { line: 'L1', label: '176255-0000514371', item: '176255', sku: '176255', name: 'Screen assembly', quantity: 1, price: 129.99, status: 'Sold', soldAt: r.j.parts.rows[0].soldAt },
    { line: 'L2', label: '176300-0000000009', item: '176255', sku: '176300', name: 'Galaxy S23 screen', quantity: 2, price: 5, status: 'Sold', soldAt: r.j.parts.rows[1].soldAt }] }, 'a line without a name takes the item name');
  assert.ok(r.j.parts.rows.every((p) => p.soldAt));
  for (const k of ['closedAt', 'closedReason', 'soldAt', 'outcome', 'lastCartValue']) assert.ok(k in r.j.wo, k);
  assert.deepEqual([r.j.wo.closedReason, r.j.wo.lastCartValue, r.j.wo.outcome], ['Sale complete', 149, null]);
  assert.deepEqual([r.j.wo.tags, r.j.wo.followUp], [[], null]);
  // no parts read yet: state null, rows []; an order whose sales order has no part lines: state 'empty'
  assert.deepEqual((await get(A, WO + '/914/7000001')).j.parts, { state: null, rows: [] });
  await env.TR.prepare("INSERT INTO inv_wo_sold (store, wo, state, updated_at) VALUES (914, '7000001', 'empty', ?)").bind(ago(1)).run();
  assert.deepEqual((await get(A, WO + '/914/7000001')).j.parts, { state: 'empty', rows: [] });
  // a work order's own parts never leak to another's detail, nor another store's
  assert.deepEqual((await get(A, WO + '/914/7000011')).j.parts.rows.map((p) => p.line), ['x']); assert.deepEqual((await get(A, WO + '/914/7000012')).j.parts.rows, []);
  // changes come from the real upload route too: a next-update that moved is one 'nextUpdate' row of ISO times, and nothing but status / nextUpdate is returned
  { const x = (await get(A, WO + '/914/7000001')).j, raw = (await env.TR.prepare("SELECT old, new FROM changes WHERE store = 914 AND wo = 7000001 AND field = 'workorder.nextUpdate' ORDER BY id DESC").first());
    assert.match(raw.new, /^"\d{4}-/, 'the tracker stores it JSON-quoted'); const nu = x.changes.filter((c) => c.field === 'nextUpdate'); assert.ok(nu.length >= 1);
    assert.ok(nu.every((c) => /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(c.new))); assert.ok(x.changes.every((c) => ['status', 'nextUpdate'].includes(c.field)));
    const rawFields = (await env.TR.prepare('SELECT DISTINCT field FROM changes WHERE store = 914 AND wo = 7000001').all()).results.map((y) => y.field);
    assert.ok(rawFields.some((f) => /^cart\./.test(f)) && rawFields.length > x.changes.length, 'cart and other rows exist in `changes` and are left out'); }
  // cap and order: 105 status rows → 100, newest first
  { const st = []; for (let i = 0; i < 105; i++) st.push(env.TR.prepare("INSERT INTO changes (store, wo, changed_at, field, old, new) VALUES (914, 7000005, ?, 'workorder.statusId', '8', '9')").bind(ago(1000 - i)));
    for (let i = 0; i < st.length; i += 50) await env.TR.batch(st.slice(i, i + 50));
    const x = (await get(A, WO + '/914/7000005')).j; assert.equal(x.changes.length, 100); assert.ok(x.changes[0].at > x.changes[99].at); assert.equal(x.changes[0].at, (await env.TR.prepare("SELECT MAX(changed_at) AS m FROM changes WHERE wo = 7000005").first()).m); }
  assert.equal((await get(B, WO + '/914/7000010')).status, 403);
}

// ================================================================ Waymark: tags and follow-ups on open rows and the detail, the follow-ups filter
{
  const today = todayOf(env), dd = (n) => addDays(today, n);
  assert.match(today, /^\d{4}-\d\d-\d\d$/);
  const AE = env.AE;
  await AE.batch([
    AE.prepare("INSERT INTO list (store, name, color, pos) VALUES (914, 'Priority', '#d9534f', 0), (914, 'Waiting on customer', '#f0ad4e', 1), (326, 'Priority', '#00aa00', 0)"),
    AE.prepare("INSERT INTO wo_tags (store, wo, tag, by_name, by_id, at) VALUES (914, 7000001, 'Waiting on customer', 'Alex Kim', 5, '2026-11-10T10:00:00Z'), (914, 7000001, 'Priority', 'Alex Kim', 5, '2026-11-09T10:00:00Z'), (914, 7000001, 'One-off', 'Staffy', 6, '2026-11-11T10:00:00Z'), (326, 7100001, 'Priority', 'Tech Person', 7, '2026-11-11T10:00:00Z'), (914, 7000002, 'Priority', 'Alex Kim', 5, '2026-11-11T10:00:00Z')"),
    AE.prepare('INSERT INTO auto_marks (store, wo, due, created_at, removed_at, kind) VALUES (914, 7000003, ?1, ?5, NULL, \'rfp\'), (914, 7000002, ?2, ?5, NULL, \'callback\'), (914, 7000004, ?3, ?5, NULL, \'rfp\'), (914, 7000005, ?2, ?5, ?5, \'rfp\'), (914, 7000007, ?2, ?5, NULL, NULL), (914, 7000006, ?2, ?5, NULL, \'rfp\'), (326, 7100001, ?4, ?5, NULL, \'rfp\'), (914, 7000010, ?2, ?5, NULL, \'rfp\'), (536, 7200001, ?2, ?5, NULL, \'rfp\'), (914, 7000001, ?3, ?5, NULL, \'callback\')').bind(dd(-1), today, dd(1), dd(-10), '2026-11-01T10:00:00Z'),
    AE.prepare("INSERT INTO wo_closed (store, wo, closed_at) VALUES (914, 7000006, '2026-11-12T10:00:00Z')"),
    AE.prepare("INSERT INTO history (store, wo, action, tag, by_name, by_id, at) VALUES (914, 7000001, 'add', 'Priority', 'Alex Kim', 5, '2026-11-09T10:00:00Z')"),
  ]);
  r = await get(A, WO + '?limit=100');
  const row = (n) => r.j.rows.find((x) => x.wo === n);
  assert.deepEqual(row(7000001).tags, [{ tag: 'Priority', color: '#d9534f' }, { tag: 'Waiting on customer', color: '#f0ad4e' }, { tag: 'One-off', color: null }], 'by time added; a tag not in the list has no colour');
  assert.deepEqual(row(7000001).followUp, { kind: 'callback', due: dd(1) }, 'a future follow-up is on the row too');
  assert.deepEqual(row(7000003).followUp, { kind: 'rfp', due: dd(-1) }); assert.deepEqual(row(7000002).followUp, { kind: 'callback', due: today }); assert.deepEqual(row(7000007).followUp, { kind: 'rfp', due: today }, 'NULL kind = rfp');
  assert.equal(row(7000005).followUp, null, 'removed with the x'); assert.equal(row(7000006).followUp, null, 'in wo_closed'); assert.deepEqual(row(7000004).tags, []);
  assert.deepEqual(row(7100001).tags, [{ tag: 'Priority', color: '#00aa00' }], 'the colour is the work order\'s own store list');
  assert.ok(r.j.rows.every((x) => Array.isArray(x.tags) && 'followUp' in x));
  // the filter: due today or overdue, open only, in the phone's stores; the chip count rides on the first page
  assert.deepEqual(r.j.followUps, { count: 4, today });
  r = await get(A, WO + '?followups=1&limit=100');
  assert.deepEqual(r.j.rows.map((x) => x.wo).sort(), [7000002, 7000003, 7000007, 7100001], 'overdue + today; not tomorrow, not removed, not in wo_closed, not a closed work order');
  assert.deepEqual(r.j.followUps, { count: 4, today }); assert.ok(r.j.lanes.total > 4, 'lane chips are not narrowed by the filter');
  assert.ok(r.j.rows.every((x) => x.open && x.followUp && x.followUp.due <= today));
  assert.deepEqual((await get(A, WO + '?followups=1&store=914&limit=100')).j.rows.map((x) => x.wo).sort(), [7000002, 7000003, 7000007]); assert.equal((await get(A, WO + '?followups=1&store=914')).j.followUps.count, 3);
  assert.deepEqual((await get(A, WO + '?followups=1&lane=rfp&limit=100')).j.rows.map((x) => x.wo).sort(), [7000003], 'with a lane: both apply (7000007 is Start, 7000003 is Pickup)');
  { // paging inside the filter; chips only on the first page
    const p1 = await get(A, WO + '?followups=1&limit=2'); assert.equal(p1.j.rows.length, 2); assert.ok(p1.j.next); const p2 = await get(A, WO + '?followups=1&limit=2&after=' + p1.j.next);
    assert.equal(p2.j.rows.length, 2); assert.equal(p2.j.next, null); assert.equal(p2.j.followUps, undefined); assert.equal(new Set([...p1.j.rows, ...p2.j.rows].map((x) => x.wo)).size, 4); }
  assert.deepEqual((await get(B, WO + '?followups=1')).j.rows.map((x) => x.wo), [7200001], 'another phone sees its own store only'); assert.deepEqual((await get(B, WO)).j.followUps, { count: 1, today });
  assert.equal((await get(A, WO + '?followups=1&state=recent')).status, 400); assert.equal((await get(A, WO + '?followups=1&state=closed')).status, 400); assert.equal((await get(A, WO + '?followups=yes')).status, 400);
  assert.equal((await get(A, WO + '?followups=1&store=536')).status, 403);
  assert.equal((await get(A, WO + '?followups=0&limit=100')).j.rows.length, (await get(A, WO + '?limit=100')).j.rows.length, 'followups=0 is no filter');
  // the filter's date is the store-local day, not the UTC day: a mark due on the next local day is not due; STORE_TZ moves the day
  { const tzEnv = Object.assign({}, env, { STORE_TZ: 'Pacific/Kiritimati' }); assert.notEqual(todayOf(tzEnv, Date.parse('2026-11-13T20:00:00Z')), todayOf(env, Date.parse('2026-11-13T20:00:00Z')), 'a zone 14 h ahead is on the next day'); assert.equal(todayOf(env, Date.parse('2026-11-13T03:00:00Z')), '2026-11-12', 'Eastern: still the 12th at 03:00 UTC'); }
  // detail: same marks; a closed order never has a follow-up (its mark row is ignored); tags stay
  { const x = (await get(A, WO + '/914/7000003')).j.wo; assert.deepEqual(x.followUp, { kind: 'rfp', due: dd(-1) }); assert.deepEqual(x.tags, []);
    const y = (await get(A, WO + '/914/7000001')).j.wo; assert.equal(y.tags.length, 3); const z = (await get(A, WO + '/914/7000010')).j.wo; assert.equal(z.followUp, null); assert.equal(z.open, false);
    assert.equal((await get(A, WO + '/914/7000006')).j.wo.followUp, null, 'in wo_closed'); }
  // a Waymark read that fails is "no marks", never an error
  { const bad = { AE: { prepare() { throw new Error('boom'); }, batch() { throw new Error('boom'); } } }; const m = await marksFor(bad, [{ store: 914, wo: 1, open: true }]); assert.deepEqual(m.get('914|1'), { tags: [], followUp: null }); }
  // one batched read per page: a page of 100 rows costs one tags + one marks statement per store, not per row
  { let n = 0; const spy = { AE: { prepare: (q) => env.AE.prepare(q), batch: (st) => { n += st.length; return env.AE.batch(st); } } }; await marksFor(spy, r.j.rows.concat(all.slice(0, 20).map((x) => ({ store: x.store, wo: x.wo, open: true }))));
    assert.ok(n <= 4, 'statements: ' + n); }
}

// ================================================================ caps: page size, find size, closedDays
{
  const stmts = [];
  for (let i = 1; i <= 130; i++) stmts.push(env.TR.prepare("INSERT INTO workorders (store, wo, status_id, status_name, program_name, device, created_at, is_open) VALUES (536, ?, 8, 'Ready for work', 'Retail', 'Pixel 8', ?, 1)").bind(7300000 + i, ago(i)));
  for (let i = 0; i < stmts.length; i += 50) await env.TR.batch(stmts.slice(i, i + 50));
  const total = 2 + 1 + 130; // legacy 5, 6 + 7200001 + the bulk
  const x = await get(B, WO + '?limit=100000'); assert.equal(x.j.rows.length, 100, 'at most 100 a page'); assert.ok(x.j.next); assert.equal(x.j.lanes.total, total);
  assert.equal((await get(B, WO + '?limit=0')).j.rows.length, 25, 'default 25'); assert.equal((await get(B, WO + '?limit=-5')).j.rows.length, 25, 'not a number: default'); assert.equal((await get(B, WO + '?limit=1')).j.rows.length, 1);
  const rest = await get(B, WO + '?limit=100&after=' + x.j.next); assert.equal(rest.j.rows.length, total - 100); assert.equal(rest.j.next, null); assert.equal(rest.j.lanes, undefined, 'chips on the first page only');
  const f = await get(B, WO + '/find?q=7300&limit=100000'); assert.equal(f.j.rows.length, 50, 'at most 50 matches'); assert.equal(f.j.more, true);
  assert.equal((await get(B, WO + '/find?q=7300')).j.rows.length, 20, 'default 20');
  assert.deepEqual((await get(B, WO + '/find?q=7300001')).j.rows.map((y) => y.wo), [7300001], 'the exact match first');
  assert.equal((await get(B, WO + '?cards=1&limit=100000')).j.rows.length, 100, 'cards pages are capped the same');
}

// ================================================================ nothing readable about a customer or staff member in any plain response
const dump = bodies.join('\n');
for (const s of SECRETS) assert.ok(!dump.includes(s), 'leaked: ' + s);
assert.ok(!/"(customer|createdBy|updatedBy|user|author|phones?|emails?|imei|serial|fullName|givenName|familyName)"\s*:/i.test(dump), 'no person-shaped keys in plain responses');
for (const path of ['?store=914', '/914/1?sealed=1', '/find?q=1']) { const x = await authed(B, WO + path); assert.deepEqual(Object.keys(x.j), ['error']); }
if (process.env.WO_DUMP) { // writes example answers (and query plans) for MOBILE-API-wo.md
  const { writeFileSync } = await import('node:fs'), ex = {};
  const cut = (j) => JSON.parse(JSON.stringify(j, (k, v) => (typeof v === 'string' && v.startsWith('v1.') ? v.slice(0, 24) + '…' : v)));
  ex.list = cut((await authed(A, WO + '?store=914&limit=3&lane=order,work,rfp')).j); ex.listCards = cut((await authed(A, WO + '?store=914&limit=1&cards=1')).j);
  ex.recent = cut((await authed(A, WO + '?state=recent&store=914&closedDays=14&limit=2')).j); ex.find = cut((await authed(A, WO + '/find?q=70000&limit=2')).j);
  ex.detail = cut((await authed(A, WO + '/914/7000003')).j); ex.sealed = cut((await authed(A, WO + '/914/7000003?sealed=1')).j.sealed);
  ex.closed = cut((await authed(A, WO + '?state=closed&store=914&limit=2')).j); ex.followups = cut((await authed(A, WO + '?followups=1&store=914&limit=2')).j); ex.detailClosed = cut((await authed(A, WO + '/914/7000010')).j); ex.detailOpen = cut((await authed(A, WO + '/914/7000003')).j);
  ex.err = [(await authed(A, WO + '?store=536')).j, (await authed(A, WO + '/914/1234567')).j];
  const plan = async (sql, ...a) => (await env.TR.prepare('EXPLAIN QUERY PLAN ' + sql).bind(...a).all()).results.map((x) => x.detail);
  ex.plan = { find: await plan("SELECT w.wo FROM workorders w WHERE w.store = ? AND w.wo BETWEEN ? AND ? ORDER BY w.wo LIMIT 5", 914, 1, 2),
    open: await plan("SELECT w.wo, sp.start_at FROM workorders w LEFT JOIN status_periods sp ON sp.store = w.store AND sp.wo = w.wo AND sp.end_at IS NULL WHERE w.store IN (SELECT value FROM json_each(?)) AND w.is_open = 1 ORDER BY sp.start_at LIMIT 5", '[914]'),
    recent: await plan("SELECT w.wo FROM workorders w WHERE w.store IN (SELECT value FROM json_each(?)) AND w.is_open = 0 AND w.closed_at >= ? ORDER BY w.closed_at DESC LIMIT 5", '[914]', 'x'),
    snap: await plan('SELECT id, fetched_at, sealed FROM snapshots WHERE store = ? AND wo = ? ORDER BY id DESC LIMIT 1', 914, 1) };
  writeFileSync(process.env.WO_DUMP, JSON.stringify(ex, null, 1));
}
await T.dispose();
console.log('mobile-wo: all passed');
