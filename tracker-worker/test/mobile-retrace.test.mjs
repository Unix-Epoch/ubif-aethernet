// Linkpearl Retrace lookup (/v1/agents/m/retrace…): items list (search, label jump, paging, as-of), item, label, purchase orders; store scoping (403), no staff names
// or customer / device identifiers anywhere (user_name, imei, oem_serial, movement detail), caps, refusals for other kinds of devices. Local D1; everything invented.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup } from './mobile-helpers.mjs';

const T = await setup('.wrangler-test-mobile-retrace');
const { env, call, authed, registerPhone, approve } = T;
const RT = '/v1/agents/m/retrace';
const ago = (h) => new Date(Date.now() - h * 3600000).toISOString();
const bodies = [];
const get = async (p, path) => { const r = await authed(p, path); bodies.push(JSON.stringify(r.j)); return r; };

// invented secrets that must never appear
const SECRETS = ['Tech Person', 'Staffy', 'Alex Kim', '353000111222333', 'OEM-SECRET-9', '490154203237518', 'checker@example.com', 'Customer Jordan', 'detail with Jordan'];

// ---- seed: store 914 (items, labels, movements), 326 (one item), 536 (one item)
let mk = 0;
const lab = (store, label, item, o = {}) => env.TR.prepare(`INSERT INTO inv_labels (store, label, item, product, serial_status, consignment, wh_type, wh_id, po, wo, sales_order, oem_serial, imei, first_seen, last_seen)
  VALUES (?, ?, ?, ?, ?, 'No', ?, ?, ?, ?, ?, 'OEM-SECRET-9', '353000111222333', ?, ?)`).bind(store, label, item, o.product || null, o.status === undefined ? 'Available' : o.status, o.wh || 'Main', o.whId || String(store), o.po || null, o.wo || null, o.so || null, ago(900), o.seen || ago(5));
const mv = (store, label, item, hoursAgo, kind, o = {}) => env.TR.prepare(`INSERT INTO inv_movements (store, label, item, at, kind, raw_status, raw_event, ref_type, ref_id, user_name, source, detail, key, recorded_at)
  VALUES (?, ?, ?, ?, ?, 'raw', 'rawev', ?, ?, 'Tech Person', 'history', 'detail with Jordan', ?, ?)`).bind(store, label, item, ago(hoursAgo), kind, o.rt || null, o.ri || null, 'k' + ++mk, ago(1));
const item = (store, no, name, cat, qty) => env.TR.prepare('INSERT INTO inv_items (store, item, name, category, qty, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(store, no, name, cat, qty ? JSON.stringify(qty) : null, ago(800), ago(2));
await env.TR.batch([
  item(914, '176255', 'Galaxy S23 screen', 'Screens', { 914: { onHand: 5, available: 3, reserved: 1 }, '914Q': { onHand: 1, available: 0 } }),
  item(914, '180001', 'Battery pack', 'Batteries', null), item(914, '176300', 'Galaxy case', 'Cases', null), item(326, '555555', 'Other store screen', 'Screens', { 326: { onHand: 9, available: 9 } }),
  item(536, '666666', 'Third store screen', 'Screens', null),
  lab(914, '176255-0000514371', '176255', { status: 'Sold', wo: '7000010', so: 'FSO000011111', po: 'UBFPO000000001' }), lab(914, '176255-0000514372', '176255', { status: 'Available', po: 'UBFPO000000001' }),
  lab(914, '176255-0000514373', '176255', { status: 'Reserved', wo: '7000002' }), lab(914, '176255-0000514374', '176255', { status: 'Defective', wh: 'Quarantine', whId: '914Q' }),
  lab(914, '180001-0000600001', '180001', { status: 'Available' }), lab(914, '180001-0000600002', '180001', { status: 'Available' }),
  lab(914, '190002-0000700002', '190002', { status: 'Available', product: 'Mystery case' }), // an item with labels and movements, no inv_items row: name from the label's product
  lab(326, '555555-0000000001', '555555', {}), lab(536, '666666-0000000001', '666666', {}),
  // movements: item 176255 (newest 1 h ago), 180001 (3 h), 190002 (50 h), 176300 (none), 555555 and 666666 in their stores
  mv(914, '176255-0000514371', '176255', 400, 'received', { rt: 'po', ri: 'UBFPO000000001' }), mv(914, '176255-0000514371', '176255', 200, 'reserved', { rt: 'sales_order', ri: 'FSO000011111' }),
  mv(914, '176255-0000514371', '176255', 100, 'sold', { rt: 'sales_order', ri: 'FSO000011111' }), mv(914, '176255-0000514372', '176255', 1, 'received', { rt: 'po', ri: 'UBFPO000000001' }),
  mv(914, '176255-0000514373', '176255', 30, 'reserved', { rt: 'wo', ri: '7000002' }), mv(914, '176255-0000514374', '176255', 20, 'defective', { rt: 'reason', ri: 'Defective part(s)' }),
  mv(914, '180001-0000600001', '180001', 3, 'received', { rt: 'po', ri: 'UBFPO000000002' }), mv(914, '190002-0000700002', '190002', 50, 'received'), mv(914, null, '176255', 10, 'used', { rt: 'wo', ri: '7000002' }),
  mv(326, '555555-0000000001', '555555', 2, 'received'), mv(536, '666666-0000000001', '666666', 2, 'received'),
  env.TR.prepare("INSERT INTO inv_cursors (store, sweep, value, updated_at) VALUES (914, 'last_sweep', '{}', ?), (326, 'last_sweep', '{}', ?)").bind(ago(0.5), ago(6)),
  env.TR.prepare("INSERT INTO inv_verify_ticks (store, label, checked_by, checked_at, matches) VALUES (914, '176255-0000514372', 'checker@example.com', ?, 1)").bind(ago(1)),
]);
// a label with a long history (cap), and an item the label-search needs: 310 movements on one label
{ const st = []; for (let i = 0; i < 310; i++) st.push(mv(914, '176255-0000999999', '176255', 2000 - i, i % 2 ? 'reserved' : 'unreserved')); st.push(lab(914, '176255-0000999999', '176255', { status: 'Available' }));
  for (let i = 0; i < st.length; i += 50) await env.TR.batch(st.slice(i, i + 50)); }
// POs: a dated, a received one with labels, one with no date, a PO of another store; JSON as retrace.js poState writes it
const D72 = ago(72);
const po = (store, id, status, at, cp, data) => env.TR.prepare("INSERT INTO inv_docs (store, type, id, status, at, counterpart, data, need_detail, first_seen, updated_at) VALUES (?, 'po', ?, ?, ?, ?, ?, 0, ?, ?)").bind(store, id, status, at, cp, JSON.stringify(data), ago(100), ago(1));
await env.TR.batch([
  po(914, 'UBFPO000000003', 'Backorder', ago(24), 'Vendor A', { info: { total: 120, pool: 'AUTO-ORDER' }, lines: [{ line: '1' }], labels: [] }),
  po(914, 'UBFPO000000002', 'Received', D72, 'Vendor B', { info: { total: 4 }, labels: [{ label: 'a-1', status: 'Received', imei: '490154203237518' }, { label: 'a-2', status: 'Received' }, { label: 'a-3', status: 'Open' }] }),
  po(914, 'UBFPO000000001', 'Draft', D72, 'Vendor B', { labels: [] }), // same date as the one above: the id breaks the tie
  po(914, 'UBFPO000000000', 'Open order', null, 'Vendor C', { info: {} }), po(326, 'UBFPO000000100', 'Backorder', ago(5), 'Vendor A', null),
]);

// ---- phones
const mkPhone = async (name, stores, extra) => { const p = await registerPhone(name, extra); assert.equal((await approve(p, stores)).status, 200); return p; };
const A = await mkPhone('Pixel A', [914, 326]), B = await mkPhone('Pixel B', [536]), mac = await mkPhone('Mac audit', [914], { kind: undefined });

// ================================================================ items
let r = await get(A, RT + '/items?store=914');
assert.equal(r.status, 200); assert.equal(r.j.v, 1); assert.equal(r.j.store, 914); assert.equal(r.j.q, null);
assert.deepEqual(r.j.items.map((x) => x.item), ['176255', '180001', '190002'], 'most recent movement first; items with no movement are not listed');
assert.ok(Math.abs(Date.parse(r.j.asOf) - (Date.now() - 1800000)) < 60000, 'asOf = last sweep'); assert.equal(r.j.next, null); assert.equal(r.j.labels, undefined);
assert.deepEqual(r.j.items[0], { item: '176255', name: 'Galaxy S23 screen', category: 'Screens', available: 3, onHand: 6, lastAt: r.j.items[0].lastAt }, 'available skips quarantine, onHand sums warehouses');
assert.ok(Math.abs(Date.parse(r.j.items[0].lastAt) - (Date.now() - 3600000)) < 60000, 'lastAt = newest movement of the item');
assert.deepEqual([r.j.items[1].available, r.j.items[1].onHand, r.j.items[1].name], [2, null, 'Battery pack'], 'no lookup quantity: available labels, onHand unknown');
assert.deepEqual([r.j.items[2].name, r.j.items[2].category, r.j.items[2].available], ['Mystery case', null, 1], 'name falls back to the label product');
assert.deepEqual(Object.keys(r.j.items[0]).sort(), ['available', 'category', 'item', 'lastAt', 'name', 'onHand']);
assert.equal((await get(A, RT + '/items?store=326')).j.asOf !== r.j.asOf, true); assert.deepEqual((await get(A, RT + '/items?store=326')).j.items.map((x) => x.item), ['555555']);
assert.equal((await get(B, RT + '/items?store=536')).j.asOf, null, 'no sweep recorded: null');
{ // search
  const q = async (term, who = A, st = 914) => (await get(who, RT + '/items?store=' + st + '&q=' + encodeURIComponent(term))).j;
  assert.deepEqual((await q('1762')).items.map((x) => x.item), ['176255'], 'item number start'); assert.deepEqual((await q('176255')).items.map((x) => x.item), ['176255']);
  assert.deepEqual((await q('55')).items.map((x) => x.item), [], 'a number matches by its start only');
  assert.deepEqual((await q('screen')).items.map((x) => x.item), ['176255'], 'name part, any case'); assert.deepEqual((await q('GALAXY')).items.map((x) => x.item), ['176255'], 'a name with no movements (case) is not listed');
  assert.deepEqual((await q('mystery')).items.map((x) => x.item), [], 'names of items with no inv_items row are not searched'); assert.deepEqual((await q('190002')).items.map((x) => x.item), ['190002'], '…but their number is');
  assert.deepEqual((await q('100%')).items, [], 'LIKE wildcards are literal'); assert.deepEqual((await q('_')).items, []);
  assert.equal((await q('Other store')).items.length, 0, 'never another store\'s items');
  const l = await q('176255-0000514371'); // a label: items by that text (none) and the label itself
  assert.deepEqual(l.items, []); assert.deepEqual(l.labels, [{ label: '176255-0000514371', item: '176255', name: 'Galaxy S23 screen', now: 'Sold', group: 'out' }]);
  assert.deepEqual((await q('176255-00005143')).labels.map((x) => x.label), ['176255-0000514371', '176255-0000514372', '176255-0000514373', '176255-0000514374'], 'a label start: every label it starts');
  assert.deepEqual((await q('176255-0000514372')).labels.map((x) => [x.now, x.group]), [['Available', 'in']]);
  assert.equal((await q('screen')).labels, undefined, 'only a label-shaped q returns labels'); assert.deepEqual((await q('zz-99')).labels, []);
  assert.equal((await q('176255-00009999')).labels.length, 1);
}
{ // paging: one at a time, the cursor is tied to the search text
  const keys = []; let after = null;
  for (let i = 0; i < 6; i++) { const x = await get(A, RT + '/items?store=914&limit=1' + (after ? '&after=' + after : '')); assert.equal(x.status, 200); keys.push(...x.j.items.map((y) => y.item)); after = x.j.next; if (!after) break; assert.equal(x.j.items.length, 1); }
  assert.deepEqual(keys, ['176255', '180001', '190002']); assert.equal(after, null);
  const a = await get(A, RT + '/items?store=914&limit=1'); assert.equal((await get(A, RT + '/items?store=914&limit=1&q=1&after=' + a.j.next)).status, 400, 'cursor of another search');
  assert.equal((await get(A, RT + '/items?store=914&after=%25%25')).status, 400);
  const s = await get(A, RT + '/items?store=914&q=1&limit=1'); assert.equal((await get(A, RT + '/items?store=914&q=1&limit=5&after=' + s.j.next)).j.items.length, 2);
  assert.equal((await get(A, RT + '/items?store=914&limit=100000')).j.items.length, 3); assert.equal((await get(A, RT + '/items?store=914&limit=0')).status, 200);
}
for (const [p, st] of [['/items?store=536', 403], ['/items', 400], ['/items?store=abc', 400], ['/items?store=all', 400], ['/item/536/666666', 403], ['/label/536/666666-0000000001', 403], ['/pos?store=536', 403], ['/pos', 400]]) assert.equal((await get(A, RT + p)).status, st, p);

// ================================================================ item
r = await get(A, RT + '/item/914/176255');
assert.equal(r.status, 200); assert.equal(r.j.item, '176255'); assert.equal(r.j.store, 914);
assert.deepEqual(r.j.info, { name: 'Galaxy S23 screen', category: 'Screens', onHand: 6, available: 3, lastSeen: r.j.info.lastSeen });
assert.deepEqual(r.j.counts.map((c) => [c.now, c.group, c.n]).sort(), [['Available', 'in', 2], ['Quarantined', 'q', 1], ['Reserved', 'wo', 1], ['Sold', 'out', 1]].sort(), 'by where each label stands now, summed');
assert.equal(r.j.labelsTotal, 5); assert.equal(r.j.labels.length, 5);
assert.equal(r.j.labels[0].label, '176255-0000514372', 'most recent movement first (the long-history label is older)');
{ const sold = r.j.labels.find((l) => l.label === '176255-0000514371'); assert.deepEqual(sold, { label: '176255-0000514371', now: 'Sold', group: 'out', wo: '7000010', po: 'UBFPO000000001', lastKind: 'sold', lastAt: sold.lastAt }); assert.ok(Math.abs(Date.parse(sold.lastAt) - (Date.now() - 100 * 3600000)) < 60000); }
assert.deepEqual(r.j.labels.find((l) => l.label === '176255-0000514373'), { label: '176255-0000514373', now: 'Reserved', group: 'wo', wo: '7000002', po: null, lastKind: 'reserved', lastAt: r.j.labels.find((l) => l.label === '176255-0000514373').lastAt });
assert.equal(r.j.movements.length, 50, 'capped at 50');
assert.deepEqual(r.j.movements.slice(0, 7).map((m) => [m.kind, m.label]), [['received', '176255-0000514372'], ['used', null], ['defective', '176255-0000514374'], ['reserved', '176255-0000514373'], ['sold', '176255-0000514371'], ['reserved', '176255-0000514371'], ['received', '176255-0000514371']], 'newest first, item-level movements (no label) included');
assert.deepEqual(Object.keys(r.j.movements[0]).sort(), ['at', 'kind', 'label', 'refId', 'refType']); assert.deepEqual([r.j.movements[1].refType, r.j.movements[1].refId], ['wo', '7000002']);
assert.deepEqual((await get(A, RT + '/item/914/176255?group=out')).j.labels.map((l) => l.label), ['176255-0000514371']); assert.equal((await get(A, RT + '/item/914/176255?group=out')).j.labelsTotal, 1);
assert.deepEqual((await get(A, RT + '/item/914/176255?group=in')).j.labels.map((l) => l.group), ['in', 'in']); assert.equal((await get(A, RT + '/item/914/176255?group=bad')).j.labels.length, 0);
assert.equal((await get(A, RT + '/item/914/176255?group=zzz')).status, 400);
{ const x = (await get(A, RT + '/item/914/180001')).j; assert.deepEqual([x.info.onHand, x.info.available, x.info.lastSeen], [null, 2, x.info.lastSeen]); }
{ const x = (await get(A, RT + '/item/914/190002')).j; assert.deepEqual([x.info.name, x.info.category, x.info.lastSeen], ['Mystery case', null, null], 'no inv_items row'); }
{ const x = (await get(A, RT + '/item/914/176300')).j; assert.deepEqual([x.labels, x.movements, x.counts, x.labelsTotal], [[], [], [], 0], 'known item, nothing yet'); }
assert.equal((await get(A, RT + '/item/914/999999')).status, 404); assert.equal((await get(A, RT + '/item/914/999999')).j.error, 'item not seen at this store');
assert.equal((await get(A, RT + '/item/326/176255')).status, 404, 'right store, not there'); assert.equal((await get(A, RT + '/item/914/%E0%A4')).status, 400);
{ // a quarantined-only item counts: groups of 100+ labels are capped to 100 with the true total
  const st = []; for (let i = 0; i < 120; i++) st.push(lab(914, '180001-' + String(8000000 + i).padStart(10, '0'), '180001', { status: 'Available' }));
  for (let i = 0; i < st.length; i += 50) await env.TR.batch(st.slice(i, i + 50));
  const x = (await get(A, RT + '/item/914/180001')).j; assert.equal(x.labels.length, 100); assert.equal(x.labelsTotal, 122); assert.equal(x.counts.find((c) => c.group === 'in').n, 122); }

// ================================================================ label
r = await get(A, RT + '/label/914/176255-0000514371');
assert.equal(r.status, 200); assert.equal(r.j.label, '176255-0000514371');
assert.deepEqual(r.j.row, { label: '176255-0000514371', item: '176255', name: 'Galaxy S23 screen', now: 'Sold', group: 'out', wo: '7000010', po: 'UBFPO000000001', salesOrder: 'FSO000011111' });
assert.deepEqual(r.j.movements.map((m) => [m.kind, m.refType, m.refId]), [['received', 'po', 'UBFPO000000001'], ['reserved', 'sales_order', 'FSO000011111'], ['sold', 'sales_order', 'FSO000011111']], 'oldest to newest');
assert.equal(r.j.movementsTotal, 3); assert.deepEqual(Object.keys(r.j.movements[0]).sort(), ['at', 'kind', 'label', 'refId', 'refType']); assert.ok(r.j.movements.every((m, i, a) => !i || a[i - 1].at <= m.at));
assert.deepEqual(Object.keys(r.j.row).sort(), ['group', 'item', 'label', 'name', 'now', 'po', 'salesOrder', 'wo']);
{ const x = (await get(A, RT + '/label/914/176255-0000999999')).j; assert.equal(x.movements.length, 300); assert.equal(x.movementsTotal, 310); assert.ok(x.movements.every((m, i, a) => !i || a[i - 1].at <= m.at), 'still oldest to newest');
  const all = (await env.TR.prepare("SELECT at FROM inv_movements WHERE label = '176255-0000999999' ORDER BY at DESC").all()).results; assert.equal(x.movements[299].at, all[0].at, 'when capped, the newest ones'); assert.equal(x.movements[0].at, all[299].at); }
{ const x = (await get(A, RT + '/label/914/176255-0000514372')).j; assert.deepEqual([x.row.now, x.row.group, x.row.wo], ['Available', 'in', null]); }
{ await env.TR.prepare("INSERT INTO inv_movements (store, label, item, at, kind, source, key, recorded_at) VALUES (914, '176255-0000777777', '176255', ?, 'received', 'history', 'k-only', ?)").bind(ago(9), ago(1)).run();
  const x = await get(A, RT + '/label/914/176255-0000777777'); assert.equal(x.status, 200); assert.equal(x.j.row, null, 'movements but no label row'); assert.equal(x.j.movements.length, 1); }
assert.equal((await get(A, RT + '/label/914/176255-0000000000')).status, 404); assert.equal((await get(A, RT + '/label/914/%3Cscript%3E')).status, 400); assert.equal((await get(A, RT + '/label/326/176255-0000514371')).status, 404);

// ================================================================ purchase orders
r = await get(A, RT + '/pos?store=914');
assert.equal(r.status, 200); assert.deepEqual(r.j.pos.map((p) => p.po), ['UBFPO000000003', 'UBFPO000000002', 'UBFPO000000001', 'UBFPO000000000'], 'newest date first, the id breaks ties, no date last'); assert.equal(r.j.next, null);
assert.deepEqual(r.j.pos[0], { po: 'UBFPO000000003', status: 'Backorder', counterpart: 'Vendor A', date: r.j.pos[0].date, labels: 0, received: 0, total: 120 });
assert.deepEqual([r.j.pos[1].labels, r.j.pos[1].received, r.j.pos[1].total, r.j.pos[1].status, r.j.pos[1].counterpart], [3, 2, 4, 'Received', 'Vendor B']);
assert.deepEqual([r.j.pos[2].received, r.j.pos[2].total], [0, null]); assert.deepEqual([r.j.pos[3].labels, r.j.pos[3].received, r.j.pos[3].total, r.j.pos[3].date], [null, null, null, null], 'no label list read yet: received null');
assert.deepEqual(Object.keys(r.j.pos[0]).sort(), ['counterpart', 'date', 'labels', 'po', 'received', 'status', 'total']);
{ const keys = []; let after = null; for (let i = 0; i < 6; i++) { const x = await get(A, RT + '/pos?store=914&limit=1' + (after ? '&after=' + after : '')); assert.equal(x.status, 200); keys.push(...x.j.pos.map((y) => y.po)); after = x.j.next; if (!after) break; }
  assert.deepEqual(keys, r.j.pos.map((p) => p.po)); assert.equal(after, null); assert.equal((await get(A, RT + '/pos?store=914&after=zz')).status, 400);
  assert.equal((await get(A, RT + '/pos?store=914&limit=2')).j.pos.length, 2); }
assert.deepEqual((await get(A, RT + '/pos?store=326')).j.pos.map((p) => [p.po, p.received, p.total]), [['UBFPO000000100', null, null]]); assert.deepEqual((await get(B, RT + '/pos?store=536')).j.pos, []);

// ================================================================ other devices, methods, the Mac agent
assert.equal((await get(B, RT + '/items?store=914')).status, 403); assert.deepEqual((await get(B, RT + '/items?store=536')).j.items.map((x) => x.item), ['666666']);
assert.equal((await authed(mac, RT + '/items?store=914')).status, 403); assert.equal((await authed(mac, RT + '/items?store=914')).j.error, 'not a phone'); assert.equal((await authed(null, RT + '/items?store=914')).status, 401);
assert.equal((await authed(A, RT + '/items?store=914', { method: 'POST', body: {} })).status, 404); assert.equal((await authed(A, RT + '/nope')).status, 404); assert.equal((await authed(A, RT)).status, 404);
{ const n = (await env.TR.prepare('SELECT COUNT(*) AS n FROM access_log').first()).n; await get(A, RT + '/items?store=914'); await get(A, RT + '/label/914/176255-0000514371'); assert.equal((await env.TR.prepare('SELECT COUNT(*) AS n FROM access_log').first()).n, n, 'plain reads are not logged'); }

// ================================================================ privacy: nothing about staff, customers or devices in any answer
const dump = bodies.join('\n');
for (const s of SECRETS) assert.ok(!dump.includes(s), 'leaked: ' + s);
assert.ok(!/"(user|user_name|userName|by_name|by_id|checked_by|checkedBy|imei|oem_serial|oem|serial|detail|raw_status|raw_event)"\s*:/i.test(dump), 'no staff, device identifier or free-text keys');
assert.ok(dump.length > 5000);
if (process.env.RT_DUMP) { // writes example answers for MOBILE-API-retrace.md
  const { writeFileSync } = await import('node:fs');
  const ex = { items: (await authed(A, RT + '/items?store=914&limit=2')).j, search: (await authed(A, RT + '/items?store=914&q=176255-0000514371')).j, item: (await authed(A, RT + '/item/914/176255')).j,
    label: (await authed(A, RT + '/label/914/176255-0000514371')).j, pos: (await authed(A, RT + '/pos?store=914&limit=3')).j };
  ex.item.movements = ex.item.movements.slice(0, 3); ex.item.labels = ex.item.labels.slice(0, 3);
  writeFileSync(process.env.RT_DUMP, JSON.stringify(ex, null, 1));
}
await T.dispose();
console.log('mobile-retrace: all passed');
