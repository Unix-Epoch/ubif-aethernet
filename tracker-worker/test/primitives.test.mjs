// The people / notes / time primitives (rulegraph.js nodes over assize-rules.js helpers): each node with and without notes
// loaded, an older cached detail without updatedBy, the "User #id" fallback, and a fixed "now" from ctx.opts.
import assert from 'node:assert/strict';
import * as RG from '../src/rulegraph.js';
import { NODE_TYPES, validate, compile, run } from '../src/rulegraph.js';
import { makeRules, trimDetail, fromSnapshot } from '../src/assize-rules.js';

const R = makeRules({ RG });
const NOW = Date.parse('2026-10-22T18:00:00Z'), H = 3600000;
const iso = (hoursAgo) => new Date(NOW - hoursAgo * H).toISOString();
const U = (userId, givenName, familyName) => ({ userId, givenName, familyName });
const note = (hoursAgo, type, tag, text, user) => ({ noteType: type, noteTag: tag, noteText: text, createdAt: iso(hoursAgo), UserDatum: user });
const ANN = U(7, 'Ann', 'Lee'), BO = U(8, 'Bo', 'Diaz');
const NOTES = [note(50, 2, 'initial_checkin', 'intake', ANN), note(30, 1, 'ready_for_work', 'status', BO), note(10, 2, null, 'called customer', BO), note(2, 1, 'ready_for_pickup', 'moved', ANN)];
const ROW = { workorderId: 5, workorderStatusId: 13, workorderStatusName: 'Ready for pickup', programId: 20001, createdAt: iso(60), updatedAt: iso(3), nextUpdate: iso(-5), rfpWorkorderStatusDate: iso(2), locationBin: 'A4', customerDevice: { name: 'PHONE 10/23' }, deviceIssues: ['Screen'], createdBy: { userId: 7, givenName: 'Ann', familyName: 'Lee' } };
const CORE = { workorder: { workorderId: 5, workorderStatusId: 13, createdAt: iso(60), updatedAt: iso(3), createdBy: 7, updatedBy: 8, WorkorderStatus: { name: 'Ready for pickup' } } };
const AUDIT = [{ workorderStatusId: 13, createdAt: iso(2), createdBy: 8 }];
const ctxOf = (row, detail, opts) => Object.assign(Object.create(R.GH), { f: R.facts(row, detail), opts: opts || { now: NOW } });
// One node, evaluated through a tiny graph with no wires (plus the optional wires), outputs read back from the trace.
function node(type, settings, ctx, extra) {
  const g = { v: 1, rule: 'r', check: 'c', title: 't', nodes: [{ id: 'x', type, settings: settings || {} }].concat((extra && extra.nodes) || []), wires: (extra && extra.wires) || [] };
  const c = compile(g);
  assert.deepEqual(c.errors, [], type);
  const r = run(c, ctx, { debug: true });
  assert.deepEqual(r.errors, [], type + ' ' + JSON.stringify(r.errors));
  return Object.fromEntries(Object.entries(r.trace).filter(([k]) => k.startsWith('x.')).map(([k, v]) => [k.slice(2), v]));
}
const withNotes = ctxOf(ROW, trimDetail(CORE, NOTES, AUDIT, null));
const noNotes = ctxOf(ROW, Object.assign(trimDetail(CORE, [], AUDIT, null), { notes: null }));

// ---- data: ids are kept, and an older detail without them still works
{
  const d = trimDetail(CORE, NOTES, AUDIT, null);
  assert.equal(d.wo.createdBy, 7); assert.equal(d.wo.updatedBy, 8);
  const f = R.facts(ROW, d);
  assert.equal(f.createdById, 7); assert.equal(f.updatedById, 8);
  const old = JSON.parse(JSON.stringify(d)); delete old.wo.createdBy; delete old.wo.updatedBy;
  const fo = R.facts(ROW, old);
  assert.equal(fo.updatedById, null); assert.equal(fo.createdById, 7, 'no createdBy in the detail: the list row has it');
  assert.equal(R.facts({ workorderId: 1 }, null).updatedById, null);
  const snap = fromSnapshot({ workorder: { workorderId: 9, createdBy: 3, updatedBy: 4, status: 'Ready for work', statusId: 2 } }, null);
  assert.equal(snap.detail.wo.createdBy, 3); assert.equal(snap.detail.wo.updatedBy, 4);
  const sealed = fromSnapshot({}, { workorder: CORE, audit_trail: AUDIT, notes: { notes: NOTES }, cart: null });
  assert.equal(sealed.detail.wo.updatedBy, 8);
}

// ---- helpers
{
  const f = withNotes.f;
  assert.equal(R.GH.personById(f, 8).name, 'Bo Diaz');
  assert.equal(R.GH.personById(f, 99).name, 'User #99'); assert.equal(R.GH.personById(f, 99).key, 'user-99'); assert.equal(R.GH.personById(f, 99).label, 'User #99');
  assert.equal(R.GH.personById(f, null), R.GH.UNASSIGNED);
  assert.equal(R.GH.personById(noNotes.f, 8).name, 'User #8', 'no notes loaded: the id only');
  assert.equal(R.GH.personById(noNotes.f, 7).name, 'Ann Lee', 'the creator is named by the list row');
}

// ---- notes nodes
{
  let o = node('lastNote', {}, withNotes);
  assert.deepEqual([o.found, o.author.name, o.text, o.tag, o.at, o.hoursAgo], [true, 'Bo Diaz', 'called customer', '', NOW - 10 * H, 10]);
  o = node('lastNote', { kind: 'system' }, withNotes);
  assert.equal(o.text, 'moved'); assert.equal(o.tag, 'ready_for_pickup'); assert.equal(o.hoursAgo, 2);
  o = node('lastNote', { kind: 'any' }, withNotes); assert.equal(o.text, 'moved');
  o = node('lastNote', { kind: 'system', tag: 'ready_for_work' }, withNotes); assert.equal(o.author.name, 'Bo Diaz'); assert.equal(o.hoursAgo, 30);
  o = node('lastNote', { tag: 'nope' }, withNotes);
  assert.deepEqual([o.found, o.author.key, o.text, o.at, o.hoursAgo], [false, 'unassigned', '', 0, 1e6]);
  o = node('lastNote', {}, noNotes); assert.equal(o.found, false);
  o = node('firstNote', {}, withNotes); assert.deepEqual([o.text, o.tag, o.author.name, o.hoursAgo], ['intake', 'initial_checkin', 'Ann Lee', 50]);
  o = node('firstNote', { kind: 'system' }, withNotes); assert.equal(o.text, 'status');
  assert.equal(node('firstNote', {}, noNotes).found, false);
  assert.deepEqual(NODE_TYPES.lastNote.notes, true);
  // a debug run flags the notes nodes when the host has none
  const g = { v: 1, rule: 'r', check: 'c', title: 't', nodes: [{ id: 'x', type: 'lastNote' }], wires: [] };
  const dbg = run(compile(g), noNotes, { debug: true });
  assert.equal(dbg.nodes.x.needsNotes, true);
  assert.ok(!dbg.needsNotes, 'a node nothing reads does not make the run need notes');
}
const WIRE = (from, to) => ({ from, to });
{
  // Filter notes + Note authors + Count, wired from the Work order node
  const wo = { id: 'wo', type: 'wo' };
  const flt = (settings) => node('filterNotes', settings, withNotes, { nodes: [wo], wires: [WIRE('wo.notes', 'x.notes')] });
  assert.equal(flt({}).out.length, 4);
  assert.equal(flt({ kind: 'manual' }).out.length, 2);
  assert.equal(flt({ kind: 'system' }).out.length, 2);
  assert.equal(flt({ tag: 'ready_for_work' }).out.length, 1);
  assert.deepEqual(flt({ author: 'diaz' }).out.map((n) => n.noteText), ['status', 'called customer']);
  assert.deepEqual(flt({ withinHours: 12 }).out.map((n) => n.noteText), ['called customer', 'moved']);
  assert.equal(flt({ withinHours: 0 }).out.length, 4);
  assert.equal(flt({ kind: 'manual', author: 'ann', withinHours: 100 }).out.length, 1);
  assert.deepEqual(node('filterNotes', {}, noNotes, { nodes: [wo], wires: [WIRE('wo.notes', 'x.notes')] }).out, [], 'notes not loaded: none');
  const au = node('noteAuthors', {}, withNotes, { nodes: [wo], wires: [WIRE('wo.notes', 'x.notes')] });
  assert.deepEqual(au.authors, ['Ann Lee', 'Bo Diaz']); assert.equal(au.count, 2);
  const none = node('noteAuthors', {}, noNotes, { nodes: [wo], wires: [WIRE('wo.notes', 'x.notes')] });
  assert.deepEqual(none.authors, []); assert.equal(none.count, 0);
  // an unwired notes input is an error the validator reports
  assert.ok(validate({ v: 1, rule: 'r', check: 'c', title: 't', nodes: [{ id: 'x', type: 'filterNotes' }], wires: [] }).length > 0);
}

// ---- last user / created by / status set by
{
  let o = node('lastUser', {}, withNotes);
  assert.deepEqual([o.who.name, o.at, o.hoursAgo], ['Bo Diaz', NOW - 3 * H, 3]);
  o = node('lastUser', {}, noNotes); assert.equal(o.who.name, 'User #8');
  // an older cached detail without updatedBy: the latest actor on record (a note here)
  const old = trimDetail(CORE, NOTES, [], null); delete old.wo.updatedBy;
  o = node('lastUser', {}, ctxOf(ROW, old)); assert.deepEqual([o.who.name, o.hoursAgo], ['Ann Lee', 2]);
  // ...or the audit trail when it is the newest (no names there: User #id)
  const old2 = trimDetail(CORE, NOTES.slice(0, 2), [{ workorderStatusId: 13, createdAt: iso(1), createdBy: 41 }], null); delete old2.wo.updatedBy;
  o = node('lastUser', {}, ctxOf(ROW, old2)); assert.deepEqual([o.who.name, o.hoursAgo], ['User #41', 1]);
  // nothing at all
  o = node('lastUser', {}, ctxOf({ workorderId: 1 }, null)); assert.deepEqual([o.who.key, o.at, o.hoursAgo], ['unassigned', 0, 1e6]);
  // updatedBy unknown to the notes
  const d9 = trimDetail({ workorder: Object.assign({}, CORE.workorder, { updatedBy: 99 }) }, NOTES, AUDIT, null);
  assert.equal(node('lastUser', {}, ctxOf(ROW, d9)).who.name, 'User #99');
  o = node('createdBy', {}, withNotes); assert.deepEqual([o.who.name, o.hoursAgo], ['Ann Lee', 60]);
  o = node('createdBy', {}, noNotes); assert.equal(o.who.name, 'Ann Lee');
  const dc = trimDetail({ workorder: Object.assign({}, CORE.workorder, { createdBy: 55 }) }, [], [], null);
  assert.equal(node('createdBy', {}, ctxOf({ workorderId: 5 }, dc)).who.name, 'User #55');
  assert.equal(node('createdBy', {}, ctxOf({ workorderId: 5 }, null)).who.key, 'unassigned');
  o = node('statusSetBy', {}, withNotes); assert.deepEqual([o.who.name, o.since, o.hoursAgo], ['Ann Lee', NOW - 2 * H, 2]);
  o = node('statusSetBy', {}, noNotes); assert.deepEqual([o.who.name, o.hoursAgo], ['User #8', 2], 'audit user id, no names');
  o = node('statusSetBy', {}, ctxOf({ workorderId: 1, workorderStatusName: 'Ready for work', workorderStatusId: 2 }, null)); assert.deepEqual([o.who.key, o.since, o.hoursAgo], ['unassigned', 0, 1e6]);
}

// ---- person nodes
{
  const who = { id: 'u', type: 'lastUser' }, w = (to) => [WIRE('u.who', to)];
  const pi = (names) => node('personIs', { names }, withNotes, { nodes: [who], wires: w('x.person') }).yes;
  assert.equal(pi(['bo']), true); assert.equal(pi(['DIAZ', 'zed']), true); assert.equal(pi(['ann']), false); assert.equal(pi([]), false); assert.equal(pi(['', ' ']), false);
  assert.equal(node('personName', {}, withNotes, { nodes: [who], wires: w('x.person') }).name, 'Bo Diaz');
  assert.equal(node('isUnassigned', {}, withNotes, { nodes: [who], wires: w('x.person') }).yes, false);
  assert.equal(node('isUnassigned', {}, ctxOf({ workorderId: 1 }, null), { nodes: [who], wires: w('x.person') }).yes, true);
  assert.equal(node('personName', {}, ctxOf({ workorderId: 1 }, null), { nodes: [who], wires: w('x.person') }).name, 'Unassigned');
  const two = (a, b) => node('samePerson', {}, withNotes, { nodes: [{ id: 'a', type: a }, { id: 'b', type: b }], wires: [WIRE('a.who', 'x.a'), WIRE('b.who', 'x.b')] }).yes;
  assert.equal(two('lastUser', 'lastUser'), true); assert.equal(two('lastUser', 'createdBy'), false); assert.equal(two('createdBy', 'createdBy'), true);
  const un = (c) => node('samePerson', {}, c, { nodes: [{ id: 'a', type: 'lastUser' }, { id: 'b', type: 'createdBy' }], wires: [WIRE('a.who', 'x.a'), WIRE('b.who', 'x.b')] }).yes;
  assert.equal(un(ctxOf({ workorderId: 1 }, null)), false, 'two Unassigned are not the same person');
}

// ---- hours since, order dates, and "now" from ctx.opts
{
  const k = (v) => ({ id: 'k', type: 'constant', settings: { type: 'num', value: v } });
  const hs = (ctx, v) => node('hoursSince', {}, ctx, { nodes: [k(v)], wires: [WIRE('k.out', 'x.at')] }).hours;
  assert.equal(hs(withNotes, NOW - 5 * H), 5); assert.equal(hs(withNotes, 0), 1e6); assert.equal(hs(withNotes, NOW + H), 0, 'a future time is 0, never negative');
  assert.equal(hs(ctxOf(ROW, null, { now: NOW + 24 * H }), NOW), 24, 'now comes from ctx.opts.now');
  assert.equal(node('lastNote', {}, ctxOf(ROW, trimDetail(CORE, NOTES, AUDIT, null), { now: NOW + H })).hoursAgo, 11);
  assert.ok(Math.abs(hs(ctxOf(ROW, null, {}), Date.now() - 2 * H) - 2) < 0.01, 'no opts.now: the clock');
  const d = node('orderDates', {}, withNotes);
  assert.deepEqual([d.createdAt, d.updatedAt, d.nextUpdate, d.rfpAt], [NOW - 60 * H, NOW - 3 * H, NOW + 5 * H, NOW - 2 * H]);
  assert.deepEqual([d.bin, d.nickname, d.issues, d.deviceType], ['A4', 'PHONE 10/23', ['Screen'], '']);
  const e = node('orderDates', {}, ctxOf({ workorderId: 1 }, null));
  assert.deepEqual([e.createdAt, e.updatedAt, e.nextUpdate, e.rfpAt, e.bin, e.nickname, e.issues], [0, 0, 0, 0, '', '', []]);
}

// ---- the editor's palette is built from NODE_TYPES by cat: every new node has one the editor knows
{
  const NEW = ['lastNote', 'firstNote', 'filterNotes', 'noteAuthors', 'lastUser', 'createdBy', 'statusSetBy', 'personIs', 'samePerson', 'personName', 'isUnassigned', 'hoursSince', 'orderDates'];
  for (const t of NEW) { const d = NODE_TYPES[t]; assert.ok(d && d.title && d.desc && ['people', 'num', 'fact'].includes(d.cat), t); }
  const ui = (await import('node:fs')).readFileSync(new URL('../../admin-worker/src/rules-ui.js', import.meta.url), 'utf8');
  assert.ok(ui.includes("people: ['People and notes'") && ui.includes("'num', 'people', 'logic'") && ui.includes('--c-people:'));
  for (const t of ['lastNote', 'firstNote', 'lastUser', 'createdBy', 'statusSetBy']) assert.ok(NODE_TYPES[t].notes, t + ' declares notes');
}
console.log('primitives: ok');
