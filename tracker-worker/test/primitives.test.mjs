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

// ---- the prefab nodes: time and store hours, text, numbers, notes, people, cart, the related order, and the macros
{
  const K = (id, type, value) => ({ id, type: 'constant', settings: { type, value } });
  const L = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
  const NOW2 = L(2026, 10, 22, 11, 30); // a Thursday, 11:30 local
  const c2 = (row, detail, opts) => ctxOf(row || { workorderId: 1 }, detail || null, Object.assign({ now: NOW2 }, opts));
  const one = (type, settings, ins, ctx) => {
    const nodes = [], wires = [];
    for (const [pin, v] of Object.entries(ins || {})) { const id = 'k_' + pin; nodes.push(typeof v === 'object' && v && v.node ? v.node(id) : K(id, typeof v === 'number' ? 'num' : typeof v === 'boolean' ? 'bool' : 'text', v)); wires.push(WIRE(id + '.' + (v && v.pin || 'out'), 'x.' + pin)); }
    return node(type, settings, ctx || c2(), { nodes, wires });
  };
  // numbers
  assert.equal(one('add', {}, { a: 2, b: 3 }).out, 5); assert.equal(one('add', { b: 4 }, { a: 2 }).out, 6);
  assert.equal(one('max', {}, { a: 2, b: 3 }).out, 3); assert.equal(one('min', { b: 1 }, { a: 2 }).out, 1);
  assert.equal(one('above', { limit: 2 }, { value: 2 }).yes, false); assert.equal(one('above', {}, { value: 0.1 }).yes, true);
  assert.equal(one('below', {}, { value: 1, limit: 2 }).yes, true); assert.equal(one('below', { limit: 1 }, { value: 1 }).yes, false);
  assert.equal(one('chooseNum', { then: 7, else: 9 }, { if: true }).out, 7); assert.equal(one('chooseNum', { else: 9 }, { if: false }).out, 9);
  // time
  assert.equal(one('now', {}).at, NOW2);
  assert.deepEqual(one('timeOfDay', {}, { at: L(2026, 10, 18, 17, 5) }), { hour: 17, minute: 5, weekday: 0 });
  assert.equal(one('dayTime', { days: 1, hour: 0 }, { at: L(2026, 10, 22, 18) }).out, L(2026, 10, 23));
  assert.equal(one('dayTime', { hour: 12 }, { at: NOW2 }).out, L(2026, 10, 22, 12));
  assert.equal(one('dayTime', { days: -2 }, { at: NOW2 }).out, L(2026, 10, 20, 11, 30), 'no hour: the same time of day');
  assert.equal(one('daysBetween', {}, { a: L(2026, 10, 21, 23, 59) }).days, 1, 'b unwired: today; calendar days');
  assert.equal(one('daysBetween', {}, { a: L(2026, 10, 22, 0, 1), b: L(2026, 10, 25, 23) }).days, 3);
  assert.equal(one('daysBetween', {}, { a: L(2026, 10, 24) }).days, -2);
  assert.deepEqual(one('elapsed', {}, { from: NOW2 - 5.5 * H }), { hours: 5.5, days: 0, text: '5 hours' });
  assert.deepEqual(one('elapsed', {}, { from: NOW2 - 50 * H }), { hours: 50, days: 2, text: '2 days' });
  assert.equal(one('elapsed', {}, { from: 0, to: H }).text, '1 hour');
  // store hours: 10–7, closed Sundays (Lexington open daily)
  let sh = one('storeHours', {}, { at: L(2026, 10, 17, 20) }); // Saturday 8 PM
  assert.deepEqual([sh.nextOpen, sh.nextClose, sh.lastClose, sh.openDay], [L(2026, 10, 19, 10), L(2026, 10, 19, 19), L(2026, 10, 17, 19), true], 'Sunday skipped');
  sh = one('storeHours', {}, { at: L(2026, 10, 18, 12) }, c2(null, null, { hours: R.hoursFor(536) }));
  assert.deepEqual([sh.nextOpen, sh.nextClose, sh.openDay], [L(2026, 10, 19, 10), L(2026, 10, 18, 19), true], 'open daily');
  assert.equal(one('storeHours', {}, { at: L(2026, 10, 22, 19) }).lastClose, L(2026, 10, 22, 19), 'last close: at or before');
  assert.equal(one('storeHours', {}, { at: L(2026, 10, 22, 19) }).nextClose, L(2026, 10, 23, 19), 'next close: after');
  const ft = (format, at, blank) => one('formatTime', { format, blank }, { at }).out;
  assert.deepEqual([ft('clock', L(2026, 10, 21, 19)), ft('date', L(2026, 10, 21, 19)), ft('day', L(2026, 3, 5)), ft('when', L(2026, 10, 22, 8)), ft('when', L(2026, 10, 21, 8)), ft('when', L(2026, 10, 2))],
    ['7:00 PM', '10/21', '2026-03-05', 'today', 'yesterday', 'on 10/2']);
  assert.equal(ft('day', 0, 'unknown'), 'unknown'); assert.equal(ft('date', 0), '');
  assert.deepEqual(one('dateInText', {}, { text: 'IPHONE 13 10/17 then 10/24' }), { found: true, at: L(2026, 10, 24) }, 'the last date');
  assert.deepEqual(one('dateInText', {}, { text: 'X 1/2' }), { found: true, at: L(2027, 1, 2) }, 'the year nearest now');
  assert.deepEqual(one('dateInText', {}, { text: 'X 13/40' }), { found: false, at: 0 });
  // text
  const ti = (values, match, text) => one('textIs', { values, match }, { text }).yes;
  assert.deepEqual([ti(['.'], 'exact', ' . '), ti(['no issues'], 'starts', 'No issues found'), ti(['no issues'], 'starts', 'no issuesX'), ti(['damage'], 'contains', 'Some DAMAGE'), ti([], 'exact', ''), ti(['  '], 'exact', '')],
    [true, true, false, true, false, false]);
  assert.equal(one('statusTag', {}, { text: ' Ready for pickup!' }).tag, 'ready_for_pickup');
  assert.deepEqual(one('checklistField', { label: 'Physical damage' }, { text: 'a\n• **Physical damage:**  Cracked back \nb' }), { found: true, value: 'Cracked back' });
  assert.deepEqual(one('checklistField', { label: 'Water (any)' }, { text: '**Water (any):** none' }), { found: true, value: 'none' }, 'a label is text, not a regex');
  assert.equal(one('checklistField', { label: 'Physical damage' }, { text: 'Physical damage: none' }).found, false);
  assert.deepEqual([one('plural', {}, { count: 1 }).out, one('plural', { word: 'hour' }, { count: 3 }).out], ['1 day', '3 hours']);
  assert.deepEqual([one('isBlank', {}, { text: '  ' }).yes, one('isBlank', { trim: false }, { text: '  ' }).yes, one('isBlank', { trim: false }, { text: '' }).yes], [true, false, true]);
  // people
  assert.equal(one('namedPerson', {}).who, R.GH.STORE); assert.equal(one('namedPerson', { who: 'Unassigned' }).who, R.GH.UNASSIGNED);
  const person = (who) => ({ node: (id) => ({ id, type: 'namedPerson', settings: { who } }), pin: 'who' });
  assert.equal(one('orPerson', {}, { a: person('Unassigned'), b: person('Store') }).who, R.GH.STORE);
  assert.equal(one('orPerson', {}, { a: person('Store'), b: person('Unassigned') }).who, R.GH.STORE);
  // statusSetBy, named in a note only: the audit trail's user id is not used
  assert.equal(node('statusSetBy', { byId: false }, noNotes).who.key, 'unassigned');
  assert.equal(node('statusSetBy', {}, noNotes).who.name, 'User #8');
  // notes: Find note, Filter notes since
  const notes = { node: (id) => ({ id, type: 'wo' }), pin: 'manualNotes' };
  const T = (h, tag, text, u) => note(h, 2, tag, text, u);
  const nctx = ctxOf(ROW, trimDetail(CORE, [T(40, 'note', 'Called her', ANN), T(30, 'contacted', 'x', BO), T(20, 'note', 'not wet at all', ANN), T(10, 'note', 'water inside', BO), T(10, 'note', 'water again', ANN)], AUDIT, null));
  let fn = one('findNote', { pattern: 'LIQUID_RE', skipNegated: true }, { notes }, nctx);
  assert.deepEqual([fn.found, fn.match, fn.author.name, fn.at, fn.stamp], [true, 'water', 'Bo Diaz', NOW - 10 * H, iso(10)], 'negated one skipped');
  fn = one('findNote', { pattern: 'LIQUID_RE' }, { notes }, nctx); assert.equal(fn.text, 'not wet at all', 'negation kept when asked');
  fn = one('findNote', { which: 'last', tag: 'contacted', pattern: 'CONTACT_RE' }, { notes }, nctx); assert.equal(fn.text, 'x');
  fn = one('findNote', { which: 'last', words: ['water'] }, { notes }, nctx); assert.deepEqual([fn.text, fn.author.name], ['water inside', 'Bo Diaz'], 'ties: the earlier in the list');
  fn = one('findNote', { which: 'last' }, { notes }, nctx); assert.equal(fn.text, 'water inside', 'nothing set: any note');
  fn = one('findNote', { tag: 'nope' }, { notes }, nctx); assert.deepEqual([fn.found, fn.author.key, fn.stamp, fn.at], [false, 'unassigned', '', 0]);
  assert.match(validate({ v: 1, rule: 'r', check: 'c', title: 't', nodes: [{ id: 'x', type: 'findNote', settings: { pattern: 'EVIL_RE' } }, { id: 'w', type: 'wo' }], wires: [WIRE('w.notes', 'x.notes')] }).join(), /pattern must be one of/);
  const since = one('filterNotes', { kind: 'manual' }, { notes: { node: (id) => ({ id, type: 'wo' }), pin: 'notes' }, since: NOW - 20 * H }, nctx).out;
  assert.deepEqual(since.map((x) => x.noteText), ['not wet at all', 'water inside', 'water again']);
  // facts
  const pr = (id, name) => node('program', {}, ctxOf({ workorderId: 1, programId: id, programName: name }, null));
  assert.deepEqual(pr(8849, 'Asurion Home+ Repairs'), { key: 'asurion', name: 'Asurion Home+ Repairs', isPartner: true, isHomePlus: true, isXbox: false });
  assert.deepEqual(pr(998, ''), { key: 'unknown', name: 'Program 998', isPartner: true, isHomePlus: false, isXbox: false });
  assert.equal(pr(null, 'OOP Xbox repair').isXbox, true);
  assert.equal(node('lastActivity', {}, withNotes).at, NOW - 2 * H); assert.equal(node('lastActivity', {}, ctxOf({ workorderId: 1 }, null)).at, 0);
  // cart
  const lines = [{ sku: 'A', name: 'Labor', price: 40, lineType: 'labor' }, { sku: 'B', name: 'Diagnostics fee', price: 89 }, { sku: 'C', name: 'Part', price: 0.005 }, { sku: 'PCEXEMPT', name: 'Credit', price: -15, lineType: 'trade_credit' }, { sku: 'D', name: 'Screen', price: 120 }];
  const cctx = (payment) => ctxOf({ workorderId: 1 }, { wo: { workorderId: 1 }, notes: [], cart: { cartItems: lines, payment } });
  const cart = { node: (id) => ({ id, type: 'wo' }), pin: 'cart' };
  const fl = (settings) => one('filterLines', settings, { lines: cart }, cctx()).out.map((l) => l.sku).join('');
  assert.equal(fl({ names: ['diagnostic'], nameMatch: 'contains', match: 'drop' }), 'ACPCEXEMPTD', 'name: any part');
  assert.equal(fl({ names: ['diagnostic'], match: 'drop' }), 'ABCPCEXEMPTD', 'name: whole words (Diagnostics is not diagnostic)');
  assert.equal(fl({ types: ['labor'] }), 'A'); assert.equal(fl({ types: ['labor', 'trade_credit'], match: 'drop' }), 'BCD');
  assert.equal(fl({ price: 'above', above: 0.009 }), 'ABD'); assert.equal(fl({ price: 'positive' }), 'ABCD');
  assert.equal(node('cartTotal', {}, cctx({ subtotal: 12, total: 30 })).total, 12); assert.equal(node('cartTotal', {}, cctx({ total: 30 })).total, 30);
  assert.equal(node('cartTotal', {}, cctx(null)).total, R.GH.cartSum({ cartItems: lines }));
  const issues = (list) => ({ node: (id) => ({ id, type: 'orderDates' }), pin: 'issues' });
  const rk = (deviceIssues) => one('repairKind', {}, { issues: issues() }, ctxOf({ workorderId: 1, deviceIssues }, null));
  assert.deepEqual([rk(['Screen']).repair, rk(['Battery']).repair, rk(['Back screen']).found, rk(['Screen', 'Battery']).found, rk([]).repair], ['Screen', 'Battery', false, false, '']);
  const sheet = (opts, price, repair = 'Screen') => one('priceSheet', {}, { device: 'iPhone 13', repair, price }, c2(null, null, opts));
  const priceFor = (d, r) => (d === 'iPhone 13' && r === 'Screen' ? [159, 199.99] : null);
  assert.deepEqual(sheet({ priceFor }, 160), { found: true, matches: true, nearest: 159 });
  assert.deepEqual(sheet({ priceFor }, 185), { found: true, matches: false, nearest: 199.99 });
  assert.deepEqual(sheet({ priceFor }, 160, 'Battery'), { found: false, matches: false, nearest: 0 });
  assert.deepEqual(sheet({}, 160), { found: false, matches: false, nearest: 0 }, 'no sheet here');
  // the related order (the store's closed rows, through opts)
  const row = { workorderId: 3, programId: 9470, programName: 'VZ Sanitization', createdAt: iso(5), customerDevice: { imei: '1' } };
  const closed = [{ workorderId: 8, programId: 5062, workorderStatusName: 'Cancelled', createdAt: iso(10), customerDevice: { imei: '1' } },
    { workorderId: 9, programId: 5062, programName: 'Asurion Mobility', workorderStatusName: 'Sale complete', createdAt: iso(10), customerDevice: { imei: '1' } }];
  const belongs = (c, p) => c.customerDevice.imei === p.customerDevice.imei;
  const rel = (opts, settings, r = row) => node('relatedOrder', Object.assign({ programIds: [5062], statuses: ['sale complete'], withinHours: 48 }, settings), Object.assign(ctxOf(r, null, Object.assign({ now: NOW }, opts)), { row: r }));
  assert.deepEqual(rel({ closed, belongs }), { found: true, id: '9', status: 'Sale complete', program: 'Asurion Mobility', createdAt: NOW - 10 * H });
  assert.equal(rel({ closed, belongs }, { withinHours: 4 }).found, false, 'too far apart');
  assert.equal(rel({ closed, belongs: () => false }).found, false, 'another device');
  assert.equal(rel({ closed, belongs: () => false }, { sameDevice: false }).found, true);
  assert.equal(rel({ closed }).found, false, 'no belongs: nothing matches');
  assert.equal(rel({}).found, false, 'no closed rows (the editor): none');
  assert.equal(node('relatedOrder', {}, ctxOf(row, null, { closed, belongs })).found, false, 'no row in ctx: none');
  // the code's orphan check is the same lookup
  assert.deepEqual(R.orphanCleanings([row], closed, belongs).map((x) => x.evidence), ['Parent 9 is closed; this cleaning is still open']);
  assert.deepEqual(R.audit(row, null, { now: NOW, closed, belongs }).map((x) => x.rule), ['parent-closed-cleaning-open'], 'audit checks it per order when given the closed rows');
  assert.deepEqual(R.audit(row, null, { now: NOW }), [], '...and not without them');
  // macros
  const mac = (macro, ctx, ins) => one('macro', { macro }, ins, ctx);
  let m = mac('afterClose', c2(), { at: L(2026, 10, 21, 18) }); assert.deepEqual([m.closed, m.close], [true, L(2026, 10, 21, 19)]);
  m = mac('afterClose', c2(), { at: L(2026, 10, 22, 9) }); assert.deepEqual([m.closed, m.close], [false, L(2026, 10, 22, 19)]);
  m = mac('lastBusinessNight', c2()); assert.deepEqual([m.close, m.lastNight], [L(2026, 10, 21, 19), true]);
  m = mac('lastBusinessNight', c2(null, null, { now: L(2026, 10, 19, 15) })); assert.deepEqual([m.close, m.lastNight], [L(2026, 10, 17, 19), false], 'Monday afternoon: Saturday (noon is the cut-off)');
  m = mac('lastBusinessNight', c2(null, null, { now: L(2026, 10, 22, 20) })); assert.deepEqual([m.close, m.lastNight], [L(2026, 10, 21, 19), true], 'evening: still last night (the morning audit\'s view)');
  m = mac('nickDue', ctxOf({ workorderId: 1, customerDevice: { name: 'X 10/20' } }, null, { now: NOW2 })); assert.deepEqual([m.found, m.due, m.daysPast], [true, L(2026, 10, 20), 2]);
  const st = (name, id, pname) => ctxOf({ workorderId: 1, workorderStatusName: name, workorderStatusId: id, programName: pname || 'Out Of Warranty' }, null);
  assert.deepEqual(['Awaiting item', 'Ready for work', 'Cancelled', 'Awaiting diagnostics'].map((x) => mac('audited', st(x)).yes), [true, true, false, false]);
  assert.deepEqual(['Awaiting callback', 'Ready for pickup', 'Work in progress'].map((x) => mac('contactStatus', st(x)).yes), [true, true, false]);
  assert.deepEqual([mac('partnerChecked', st('Work in progress', 10, 'Asurion Mobility')).yes, mac('partnerChecked', st('Work in progress')).yes, mac('partnerChecked', st('Ready for pickup', 13, 'Asurion Mobility')).yes], [true, false, false]);
  const cartCtx = (outcome) => ctxOf({ workorderId: 1, workorderStatusName: 'Ready for pickup', workorderStatusId: 13 }, { wo: { workorderId: 1, WorkorderAttributes: outcome ? [{ workorderAttributeTypeId: 22, value: outcome }] : [] }, notes: [], cart: { cartItems: [] } });
  assert.deepEqual([mac('cartChecked', cartCtx('Completed')).yes, mac('cartChecked', cartCtx('Incomplete')).yes, mac('cartChecked', ctxOf({ workorderId: 1 }, null)).yes], [true, false, false]);
  // every new node: in the library, with a category the editor knows
  const PREFAB = ['program', 'lastActivity', 'relatedOrder', 'add', 'max', 'min', 'above', 'below', 'chooseNum', 'textIs', 'statusTag', 'checklistField', 'plural', 'now', 'timeOfDay', 'dayTime', 'daysBetween', 'elapsed',
    'storeHours', 'formatTime', 'dateInText', 'findNote', 'orPerson', 'namedPerson', 'cartTotal', 'repairKind', 'priceSheet'];
  const ui = (await import('node:fs')).readFileSync(new URL('../../admin-worker/src/rules-ui.js', import.meta.url), 'utf8');
  for (const t of PREFAB) { const d = NODE_TYPES[t]; assert.ok(d && d.title && d.desc, t); assert.ok(ui.includes("'" + d.cat + "'") || ui.includes(d.cat + ': ['), t + ': editor knows ' + d.cat); }
  assert.ok(ui.includes("time: ['Time and store hours'") && ui.includes('--c-time:'));
  assert.ok(NODE_TYPES.findNote && !NODE_TYPES.findNote.notes, 'Find note reads notes it is given (wired), so it has no notes flag of its own');
  assert.ok(NODE_TYPES.lastActivity.notes, 'Last activity reads the order\'s notes');
}
console.log('primitives: ok');
