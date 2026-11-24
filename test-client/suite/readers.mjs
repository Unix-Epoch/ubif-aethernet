// Client suite, part of `node test-client/run.mjs` (which loads these files in order; see its top for how the tests work).
import assert from 'node:assert/strict';
import { load, runShard } from '../harness.mjs';
import { t, STORE, WO_ANSWER, withStatus, plain, USER, ok, router } from './common.mjs';

// ================================================================== the shards' Portal readers
// Each reader is the shard's own function (runShard: its run(), then what it exposes as _test) on the real core; the DOM is the harness's stand-in.
const BAD_WO = [ok({}), ok({ workorder: {} }), ok('Gateway'), { status: 200, body: 'plain text' }, ok({ data: {} })]; // SYNTHETIC malformed answers
const cleaningWo = { ...WO_ANSWER, workorder: { ...WO_ANSWER.workorder, programId: 9470 } }; // the captured answer as a cleaning (no list lookups)
const woEnv = (answer, more = [], files = [], pathname = '/') => load([...new Set(['00-core.js', ...files])], { pathname, fetch: router([['GET', /^\/api\/auth\/user$/, ok(USER)], ['GET', /^\/api\/workorder\/123$/, answer], ...more]) });

// Esuna
const ESUNA = ['00-core.js', '15-wo-cleanings.js'];
const esuna = (env) => { const e = runShard(env, 'woCleanings'); return async (woId) => { await e.load(woId); return e.state(); }; };
const listRoutes = [['POST', /^\/api\/workorders$/, ok({ workOrders: [], rowCount: 0 })], ['GET', /^\/api\/arrivals\/upcoming-arrivals/, ok({ data: [], rowCount: 0 })]]; // SYNTHETIC empty lists
await t('Esuna: a malformed work order answer is an error, never a work order with nothing in it', async () => {
  for (const a of BAD_WO) { const s = await esuna(woEnv(a, listRoutes, ESUNA, '/repair/workorder/123'))('123'); assert.equal(s.status, 'error', JSON.stringify(a)); assert.match(s.error, /unexpected shape|not JSON/); }
  const s = await esuna(woEnv(ok(cleaningWo), [], ESUNA, '/repair/workorder/123'))('123');
  assert.equal(s.status, 'ready'); assert.equal(s.wo.workorderStatusId, 14);
});
await t('Esuna: the background refresh waits while Portal is down', async () => {
  const run = async (down) => {
    const env = load(ESUNA, { timers: 'fake', pathname: '/repair/workorder/123', fetch: router([['GET', /^\/api\/auth\/user$/, ok(USER)], ['GET', /^\/api\/workorder\/123$/, ok(cleaningWo)]]) });
    const e = runShard(env, 'woCleanings');
    await env.advance(1000); // the 1 s loop finds the work order and reads it
    assert.equal(e.state().status, 'ready'); assert.equal(env.requests(/^\/api\/workorder\/123$/).length, 1);
    await env.advance(118000); // just short of the 2 min refresh
    if (down) for (let i = 0; i < 3; i++) env.AE.health.fail('http', { status: 504, message: 'x' });
    await env.advance(3000); // stale now
    return env.requests(/^\/api\/workorder\/123$/).length - 1;
  };
  assert.equal(await run(true), 0); assert.equal(await run(false), 1);
});

// Recitation
const RECITATION = ['00-core.js', '17-text-notes.js'];
const recitation = (env) => { runShard(env, 'textNotes'); return env.AE.textNotesDebug.logRecentTexts; }; // the shard's own way in for tests
const textRoutes = (env) => [['GET', /customer-data$/, ok({ customerId: 77, CustomerDatum: {} })], // SYNTHETIC customer record
  ['GET', /\/api\/messages\/v1\/customers\/77/, () => ok({ messages: [{ direction: 'OUTBOUND', senderId: 1, contactDate: new Date(env.clock.now).toISOString(), messageId: 'm1', content: 'Your device is ready', customerName: 'Test Customer' }] })], // SYNTHETIC message
  ['POST', /^\/api\/note$/, ok({})]];
await t('Recitation: a malformed work order answer adds no note; the captured one adds it with its status tag', async () => {
  for (const a of BAD_WO) {
    const env = load(RECITATION);
    env.setFetch(router([['GET', /^\/api\/auth\/user$/, ok(USER)], ['GET', /^\/api\/workorder\/123$/, a], ...textRoutes(env)])); // everything else answers: only the work order is bad
    await assert.rejects(recitation(env)('123'), (e) => /BadShape|ApiError/.test(e.name) && /Recitation work order|not JSON/.test(e.message));
    assert.deepEqual(env.requests(/^\/api\/note$/, 'POST'), []);
  }
  const env = load(RECITATION);
  env.setFetch(router([['GET', /^\/api\/auth\/user$/, ok(USER)], ['GET', /^\/api\/workorder\/123$/, ok(WO_ANSWER)], ...textRoutes(env)]));
  assert.equal(await recitation(env)('123'), 1);
  const n = env.requests(/^\/api\/note$/, 'POST');
  assert.equal(n.length, 1); assert.equal(n[0].body.noteTag, 'sale_complete'); assert.equal(n[0].body.workorderId, 123);
});

// Provoke
const PROVOKE = ['00-core.js', '23-price-sheet.js', '24-provoke.js', '55-waymark.js'];
const LEAD_SHEET = { data: { items: [{ title: 'Pickup', group: 'Special Circumstances', texts: ['x'] }] } }; // SYNTHETIC lead sheet: one message, the one "Ready for pickup" puts first
// Provoke on a work order page whose Customer Chat panel is open: the message box inside its form inside the panel (only what the row's
// placing reads). chat() is the shard's own 1 s tick; built lists the status each placed row was built with (null = no status ordering).
const provoke = async (woAnswer) => {
  const env = load(PROVOKE, { pathname: '/repair/workorder/123', fetch: router([['GET', /^\/api\/auth\/user$/, ok(USER)], ['GET', /^\/api\/workorder\/123$/, woAnswer], ['GET', /\/v1\/914\/sheets\/leads$/, ok(LEAD_SHEET)]]) });
  const ui = { row: null, built: [] }, doc = env.ctx.document;
  let p = null;
  const panel = { insertBefore(row) {
    if (ui.row !== row) ui.built.push(p.chatStatus());
    ui.row = row; row.parentElement = panel; row.nextElementSibling = form; row.previousElementSibling = null; row.remove = () => { ui.row = null; };
  } };
  const form = { parentElement: panel };
  const box = { disabled: false, readOnly: false, offsetParent: panel, getAttribute: () => 'Message Test Customer...', closest: () => form };
  doc.querySelectorAll = (sel) => (/^textarea\[placeholder\]/.test(sel) ? [box] : []);
  doc.getElementById = (id) => (id === 'ae-provoke-chat' ? ui.row : null);
  p = runShard(env, 'leadReplies');
  for (let i = 0; i < 200 && !ui.built.length; i++) await env.settle(); // the shard's own first tick places the row
  return { env, chat: p.chat, ui };
};
await t('Provoke: the arrival box draws (a Mobility lead, with the sheet edit date)', async () => {
  const env = load(['00-core.js', '23-price-sheet.js', '24-provoke.js'], { pathname: '/' });
  await env.AE.shards.find((x) => x.id === 'leadReplies').run();
  const leads = { data: { items: [{ title: 'iPhone', group: 'G', texts: ['Hi'] }], modified: '2026-11-17T00:00:00Z' } };
  const a = { arrivalId: 50, program: { programId: 5062 }, customer: { firstName: 'Avery', lastName: 'Stone' }, customerDevice: { deviceName: 'iPhone 15' } };
  assert.ok(env.AE.leadReplies.render(a, leads, null), 'render returned the box');
});
await t('Provoke: a failed work order read still places the row (no status order) and is retried with a backoff, not every second', async () => {
  for (const status of [404, 504]) {
    const { env, chat, ui } = await provoke({ status, body: 'x' });
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
  let p = await provoke(ok({})); await p.chat(); // SYNTHETIC
  assert.equal(p.ui.built.length, 1); assert.equal(p.ui.built[0], null);
  p = await provoke(ok(withStatus(13)));
  for (let s = 0; s < 5; s++) { await p.chat(); p.env.clock.now += 1000; }
  assert.equal(p.ui.built.length, 1); assert.equal(p.ui.built[0].key, 'pickup');
  assert.equal(p.env.requests(/^\/api\/workorder\/123$/).length, 1);
});

// Macrocosmos
const macro = (env) => runShard(env, 'galaxy').collectData;
await t('Macrocosmos: a malformed work order answer stops the filing; the captured one is read', async () => {
  for (const a of BAD_WO) await assert.rejects(macro(woEnv(a, [], ['30-galaxy.js']))('123'), (e) => /BadShape|ApiError/.test(e.name));
  const d = await macro(woEnv(ok(WO_ANSWER), [], ['30-galaxy.js']))('123');
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
const SWIFT = ['00-core.js', '20-auto-close.js'];
const swiftcast = (env) => runShard(env, 'autoClose').run; // the run itself: arrival → work order → sale, every call through the stubbed fetch
const ARRIVAL = { program: { programId: 9470 }, customerDevice: { imei: '356938035643809', customerDeviceId: 9 }, customer: { customerId: 77 }, clientId: 3, storeId: STORE }; // SYNTHETIC arrival (fields run() reads)
const swiftRoutes = (wo, checkout) => router([
  ['GET', /^\/api\/auth\/user$/, ok(USER)], ['GET', /^\/api\/arrivals\/50$/, ok(ARRIVAL)], ['POST', /validate-imei$/, ok({ valid: true })],
  ['POST', /^\/api\/checkin\/workorder$/, ok({ workorder: { workorderId: 555 } })], ['POST', /calculate-sla/, ok({})], ['PUT', /^\/api\/checkin\/workorder$/, ok({})],
  ['PATCH', /\/status$/, ok({})], ['POST', /^\/api\/notes?$/, ok({})], ['GET', /^\/api\/workorder\/555$/, wo], ['PUT', /^\/api\/workorder\/555$/, ok({})], ['POST', /workorder\/attribute$/, ok({})],
  ['GET', /^\/api\/checkout\/workorder\/555$/, checkout], ['GET', /get-cart/, ok({ payment: { total: 0 } })], // SYNTHETIC $0 cart
  ['POST', /demographic\/customer-data$/, ok({})], ['POST', /complete-order$/, ok({ salesOrder: { salesId: 'S1' } })]]);
await t('Swiftcast: a text answer to the (unused) checkout GET doesn\'t stop the run before complete-order', async () => {
  const env = load(SWIFT, { fetch: swiftRoutes(ok(WO_ANSWER), { status: 200, body: 'OK' }) }); // SYNTHETIC text 2xx (the answer is uncaptured)
  const log = Object.assign(() => {}, { plan() {} });
  assert.equal(await swiftcast(env)(50, log), 555);
  assert.equal(env.requests(/complete-order$/, 'POST').length, 1);
});
await t('Swiftcast: a malformed work order answer stops the run before any status PUT is built from it', async () => {
  for (const a of BAD_WO) {
    const env = load(SWIFT, { fetch: swiftRoutes(a, ok({})) });
    await assert.rejects(swiftcast(env)(50, Object.assign(() => {}, { plan() {} })));
    assert.deepEqual(env.requests(/^\/api\/workorder\/555$/, 'PUT'), [], JSON.stringify(a));
    assert.deepEqual(env.requests(/complete-order$/, 'POST'), []);
  }
});

// Divination, Tactician: background reloads wait while Portal is down
await t('Divination: the timed refresh waits while Portal is down', async () => {
  // The shard's first refresh, its 30 s timer and the tab coming back all go through the same gate; a refresh reads the work order list.
  const run = async (down) => {
    const env = load(['00-core.js', '10-cleaning-rate.js'], { timers: 'fake', fetch: router([['GET', /^\/api\/auth\/user$/, ok(USER)], ...listRoutes]) });
    if (down) for (let i = 0; i < 3; i++) env.AE.health.fail('http', { status: 504, message: 'x' });
    runShard(env, 'cleaningRate');
    await env.advance(10000); // past core's wait for Portal's own first load
    return env.requests(/^\/api\/workorders$/, 'POST').length;
  };
  assert.equal(await run(true), 0); assert.ok(await run(false) >= 1);
});
await t('Tactician: the stale reload waits while Portal is down', async () => {
  const run = (down) => {
    const env = load(['00-core.js', '62-tactician.js']);
    if (down) for (let i = 0; i < 3; i++) env.AE.health.fail('http', { status: 504, message: 'x' });
    return runShard(env, 'timeSheet').stale(); // nothing loaded yet: due, unless Portal is down
  };
  assert.equal(run(true), false); assert.equal(run(false), true);
});


// Tactician: period + store window + breakdown (pure helpers of AE.tactician, the rewritten Store time sheet page)
const TAC = load(['00-core.js', '62-tactician.js']).AE.tactician;
const tacRow = (o) => Object.assign({ timeclockId: 1, storeId: 11, storeName: 'Store A', userId: 7, username: 'Pat', clockTypeId: 1, timeIn: null, timeOut: null, storeTimeZone: 'America/New_York', payPeriodStartDay: 1 }, o); // SYNTHETIC values, real field set
await t('Tactician: period text → dates (month, month-crossing, Dec→Jan, 14 days, year from today)', () => {
  assert.deepEqual({ ...TAC.periodFromText('Mon Oct 12 – Sun Oct 18', '2026-10-15') }, { start: '2026-10-12', end: '2026-10-18', span: 7 });
  assert.deepEqual({ ...TAC.periodFromText('Oct 12 – Oct 18', '2026-11-11') }, { start: '2026-10-12', end: '2026-10-18', span: 7 });
  assert.deepEqual({ ...TAC.periodFromText('Mon Sep 28 – Sun Oct 4', '2026-10-01') }, { start: '2026-09-28', end: '2026-10-04', span: 7 });
  assert.deepEqual({ ...TAC.periodFromText('Mon Dec 28 – Sun Jan 3', '2027-01-02') }, { start: '2026-12-28', end: '2027-01-03', span: 7 });
  assert.equal(TAC.periodFromText('Mon Dec 28 – Sun Dec 28', '2026-12-29'), null); // span 1
  assert.deepEqual({ ...TAC.periodFromText('Mon Oct 5 – Sun Oct 18', '2026-10-15') }, { start: '2026-10-05', end: '2026-10-18', span: 14 });
  assert.deepEqual({ ...TAC.periodFromText('Mon Jan 4 – Sun Jan 10', '2027-01-04') }, { start: '2027-01-04', end: '2027-01-10', span: 7 });
  assert.equal(TAC.periodFromText('Mon Jan 4 – Sun Jan 10', '2026-12-30') && TAC.periodFromText('Mon Jan 4 – Sun Jan 10', '2026-12-30').start, '2026-01-04'); // start not after today: the latest such year
  assert.equal(TAC.periodFromText('Oct 12 – Oct 20', '2026-11-11'), null); // span 9
  assert.equal(TAC.periodFromText('Week of nothing', '2026-11-11'), null);
});
await t('Tactician: the request range gives Sunday and span; period() prefers the card text', () => {
  assert.deepEqual({ ...TAC.periodFromRequest('2026-10-11', '2026-10-24') }, { sunday: '2026-10-11', span: 7 });
  assert.deepEqual({ ...TAC.periodFromRequest('2026-10-11', '2026-10-31') }, { sunday: '2026-10-11', span: 14 });
  assert.equal(TAC.periodFromRequest('2026-10-11', '2026-10-20'), null);
  assert.deepEqual({ ...TAC.period({ fromDate: '2026-10-11', toDate: '2026-10-24', payPeriodStartDay: 1 }) }, { start: '2026-10-12', end: '2026-10-18', span: 7, sunday: '2026-10-11', source: 'request' });
  assert.deepEqual({ ...TAC.period({ text: 'Wed Oct 14 – Tue Oct 20', fromDate: '2026-10-11', toDate: '2026-10-24', today: '2026-10-16' }) }, { start: '2026-10-14', end: '2026-10-20', span: 7, sunday: '2026-10-11', source: 'text' });
  assert.equal(TAC.period({}), null);
});
await t('Tactician: a store window from a Sunday, payPeriodStartDay 0/1/3 and span', () => {
  assert.deepEqual({ ...TAC.storeWindow('2026-10-11', 0, 7) }, { start: '2026-10-11', end: '2026-10-17', span: 7, payPeriodStartDay: 0 });
  assert.deepEqual({ ...TAC.storeWindow('2026-10-11', 1, 7) }, { start: '2026-10-12', end: '2026-10-18', span: 7, payPeriodStartDay: 1 });
  assert.deepEqual({ ...TAC.storeWindow('2026-10-11', 3, 14) }, { start: '2026-10-14', end: '2026-10-27', span: 14, payPeriodStartDay: 3 });
  assert.equal(TAC.storeWindow('2026-10-11', undefined, 7).start, '2026-10-12'); // missing: the assumed default (Monday)
  assert.deepEqual({ ...TAC.requestRange('2026-10-14', 3, 14) }, { fromDate: '2026-10-11', toDate: '2026-10-30' });
});
await t('Tactician: days are the store\'s calendar days (time zone), with a fallback for a missing or bad zone', () => {
  const iso = '2026-10-14T03:30:00Z';
  assert.equal(TAC.dayIn(iso, 'America/New_York'), '2026-10-13');
  assert.equal(TAC.dayIn(iso, 'Asia/Tokyo'), '2026-10-14');
  const local = (() => { const d = new Date(iso); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();
  for (const z of [undefined, null, '', 'Not/AZone', 5]) assert.equal(TAC.dayIn(iso, z), local, String(z));
  const rows = [tacRow({ timeIn: iso, timeOut: '2026-10-14T11:30:00Z' })]; // 23:30 → 07:30 Eastern on the 13th/14th
  const b = TAC.breakdown(rows, { store: 11, start: '2026-10-12', span: 7, now: Date.parse('2026-10-18T12:00:00Z') });
  assert.equal(b[0].day[1], 8); assert.equal(b[0].day[2], 0); // Tue the 13th, not Wed the 14th
  assert.equal(TAC.breakdown([tacRow({ timeIn: '2026-10-11T23:00:00-04:00', timeOut: '2026-10-12T02:00:00-04:00' })], { store: 11, start: '2026-10-12', span: 7, now: 0 }).length, 0); // Sunday evening is before a Monday window
});
await t('Tactician: overtime counts every store worked; floaters, left before OT, breaks out, open punch to now', () => {
  const at = (day, h1, h2, o) => tacRow(Object.assign({ timeIn: '2026-10-' + day + 'T' + h1 + ':00Z', timeOut: '2026-10-' + day + 'T' + h2 + ':00Z' }, o));
  const rows = [at('12', '14:00', '22:00'), at('13', '14:00', '22:00'), at('14', '14:00', '22:00'), at('15', '14:00', '22:00'), // 32 h at A
    at('16', '14:00', '22:00', { storeId: 12, storeName: 'Store B' }), at('17', '14:00', '19:00', { storeId: 12, storeName: 'Store B' }), // 13 h at B → 45 h
    at('12', '18:00', '18:30', { clockTypeId: 2 }), // a break: not hours
    at('12', '14:00', '22:00', { userId: 8, username: 'Sam' })]; // 8 h only
  const b = TAC.breakdown(rows, { store: 11, start: '2026-10-12', span: 7, now: Date.parse('2026-10-18T12:00:00Z') });
  const pat = b.find((u) => u.name === 'Pat'), sam = b.find((u) => u.name === 'Sam');
  assert.equal(pat.here, 32); assert.equal(pat.all, 45); assert.equal(pat.ot, 5); assert.equal(pat.left, 0); assert.equal(pat.breaks, 0.5);
  assert.deepEqual([...pat.elsewhere], [['Store B', 13]]); assert.deepEqual(pat.day, [8, 8, 8, 8, 0, 0, 0]);
  assert.equal(sam.ot, 0); assert.equal(sam.left, 32);
  const atB = TAC.breakdown(rows, { store: 12, start: '2026-10-12', span: 7, now: Date.parse('2026-10-18T12:00:00Z') });
  assert.equal(atB.length, 1); assert.equal(atB[0].here, 13); assert.equal(atB[0].ot, 5); // still 45 h in the week
  const open = TAC.breakdown([tacRow({ timeIn: '2026-10-14T12:00:00Z', timeOut: null })], { store: 11, start: '2026-10-12', span: 7, now: Date.parse('2026-10-14T17:30:00Z') });
  assert.equal(open[0].here, 5.5);
});
await t('Tactician: a 14-day window has two weeks and overtime per 7-day week', () => {
  const rows = []; for (const d of ['05', '06', '07', '08', '09', '10']) rows.push(tacRow({ timeIn: '2026-10-' + d + 'T12:00:00Z', timeOut: '2026-10-' + d + 'T19:00:00Z' })); // 42 h week 1
  for (const d of ['12', '13', '14', '15']) rows.push(tacRow({ timeIn: '2026-10-' + d + 'T12:00:00Z', timeOut: '2026-10-' + d + 'T19:00:00Z' })); // 28 h week 2
  const b = TAC.breakdown(rows, { store: 11, start: '2026-10-05', span: 14, now: Date.parse('2026-10-16T12:00:00Z') });
  assert.equal(b[0].day.length, 14); assert.equal(b[0].weeks.length, 2);
  assert.deepEqual(b[0].weeks.map((w) => [w.all, w.ot, w.left]), [[42, 2, 0], [28, 0, 12]]);
  assert.equal(b[0].all, 70); assert.equal(b[0].ot, 2); assert.equal(b[0].left, 12); // not 30 h over: 40 per week
});

await t('Tactician: the store follows Portal\'s menu; "All stores", no menu or junk show the signed-in store', () => {
  assert.deepEqual({ ...TAC.pickStore('326', 999999) }, { store: 326, fromMenu: true });
  assert.deepEqual({ ...TAC.pickStore('all', 999999) }, { store: 999999, fromMenu: false });
  assert.deepEqual({ ...TAC.pickStore(null, '999999') }, { store: 999999, fromMenu: false }); // no menu (one store); the profile id may be a string
  for (const junk of ['', '0', '-5', '12abc', undefined, 326]) assert.equal(TAC.pickStore(junk, 11).store, 11, String(junk));
  assert.equal(TAC.pickStore('all', null), null); assert.equal(TAC.pickStore(undefined, 0), null);
});
await t('Tactician: the window comes from the store card, else the period button (only for a picked store or no menu), else null', () => {
  const today = '2026-11-11', W = (o) => { const w = TAC.pageWindow({ today, ...o }); return w && { ...w }; };
  assert.deepEqual(W({ card: ['Sandbox Store #999999', 'Mon Nov 9 – Sun Nov 15', '4 employees'], label: 'This Work Week', value: 'all' }), { start: '2026-11-09', end: '2026-11-15', span: 7, source: 'card' });
  assert.deepEqual(W({ card: ['Lynnhaven #326', 'Mon Oct 26 – Sun Nov 8'], label: 'Last 2 Wks', value: 'all' }), { start: '2026-10-26', end: '2026-11-08', span: 14, source: 'card' });
  assert.equal(W({ card: ['x', 'Mon Nov 9 – Sun Nov 15'], label: 'Nov 2 – Nov 8', value: '326' }).start, '2026-11-09'); // the card wins over the button
  assert.deepEqual(W({ card: [], label: 'Nov 2 – Nov 8', value: '999999' }), { start: '2026-11-02', end: '2026-11-08', span: 7, source: 'label' }); // a store with no punches draws no card
  assert.equal(W({ card: [], label: 'Nov 2 – Nov 8', value: null }).source, 'label'); // one store: no menu
  assert.equal(W({ card: [], label: 'Nov 2 – Nov 8', value: 'all' }), null); // with All stores the button isn't one store's window
  assert.equal(W({ card: [], label: 'Last Work Week', value: 'all' }), null);
  assert.equal(W({ card: [], label: 'Week of Oct 18', value: '999999' }), null);
  assert.equal(W({ card: 'Mon Nov 9 – Sun Nov 15', label: '', value: null }).source, 'card'); // a single string works too
  assert.equal(W({}), null);
});
await t('Tactician: store name and pay-period start day come from the answer\'s stores, else its rows', () => {
  assert.deepEqual({ ...TAC.storeInfo({ stores: [{ storeId: 11, storeName: 'A', payPeriodStartDay: 3 }], rows: [] }, 11) }, { name: 'A', payPeriodStartDay: 3 });
  assert.deepEqual({ ...TAC.storeInfo({ rows: [tacRow({ storeId: 11, storeName: 'A', payPeriodStartDay: 0 })] }, 11) }, { name: 'A', payPeriodStartDay: 0 }); // Sunday is 0, not missing
  assert.deepEqual({ ...TAC.storeInfo({ stores: [{ storeId: 12, storeName: 'B', payPeriodStartDay: 1 }] }, 11) }, { name: null, payPeriodStartDay: null });
  assert.deepEqual({ ...TAC.storeInfo({ stores: [{ storeId: 11, storeName: 'A', payPeriodStartDay: '1' }] }, 11) }, { name: 'A', payPeriodStartDay: null }); // not a number: assumed default later
  assert.deepEqual({ ...TAC.storeInfo(null, 11) }, { name: null, payPeriodStartDay: null });
});
await t('Tactician: totals add the day columns of a 14-day window and count the people over', () => {
  const rows = []; for (const d of ['05', '06', '07', '08', '09', '10']) rows.push(tacRow({ timeIn: '2026-10-' + d + 'T12:00:00Z', timeOut: '2026-10-' + d + 'T19:00:00Z' })); // Pat 42 h in week 1
  for (const d of ['12', '18']) rows.push(tacRow({ userId: 8, username: 'Sam', timeIn: '2026-10-' + d + 'T12:00:00Z', timeOut: '2026-10-' + d + 'T20:00:00Z' })); // Sam 8 h in each week
  const tot = TAC.totals(TAC.breakdown(rows, { store: 11, start: '2026-10-05', span: 14, now: Date.parse('2026-10-25T12:00:00Z') }), 14);
  assert.equal(tot.day.length, 14); assert.deepEqual([...tot.day].slice(0, 7), [7, 7, 7, 7, 7, 7, 0]); assert.equal(tot.day[7], 8); assert.equal(tot.day[13], 8); // Mon Oct 12 and Sun Oct 18, the window's last day
  assert.equal(tot.here, 58); assert.equal(tot.ot, 2); assert.equal(tot.otPeople, 1); assert.equal(tot.breaks, 0);
});
await t('Tactician: per-week breaks, floater notes and week totals; only people who worked that week; finished weeks', () => {
  const rows = [];
  for (const d of ['05', '06', '07', '08', '09', '10']) rows.push(tacRow({ timeIn: '2026-10-' + d + 'T12:00:00Z', timeOut: '2026-10-' + d + 'T19:00:00Z' })); // Pat 42 h wk 1
  rows.push(tacRow({ clockTypeId: 2, timeIn: '2026-10-05T15:00:00Z', timeOut: '2026-10-05T15:30:00Z' }), tacRow({ clockTypeId: 2, timeIn: '2026-10-13T15:00:00Z', timeOut: '2026-10-13T16:00:00Z' })); // breaks 0.5 / 1
  rows.push(tacRow({ timeIn: '2026-10-13T12:00:00Z', timeOut: '2026-10-13T20:00:00Z' })); // Pat 8 h wk 2
  rows.push(tacRow({ userId: 8, username: 'Sam', timeIn: '2026-10-14T12:00:00Z', timeOut: '2026-10-14T20:00:00Z' })); // Sam only wk 2
  rows.push(tacRow({ storeId: 12, storeName: 'Store B', timeIn: '2026-10-07T12:00:00Z', timeOut: '2026-10-07T15:00:00Z' }), tacRow({ storeId: 12, storeName: 'Store B', timeIn: '2026-10-15T12:00:00Z', timeOut: '2026-10-15T14:00:00Z' })); // Pat floats 3 h wk 1, 2 h wk 2
  const b = TAC.breakdown(rows, { store: 11, start: '2026-10-05', span: 14, now: Date.parse('2026-10-16T12:00:00Z') }), pat = b.find((u) => u.name !== 'Sam');
  assert.deepEqual(pat.weeks.map((w) => w.breaks), [0.5, 1]); assert.equal(pat.breaks, 1.5);
  assert.deepEqual(pat.weeks.map((w) => [...w.elsewhere]), [[['Store B', 3]], [['Store B', 2]]]);
  const w1 = TAC.weekView(b, 0), w2 = TAC.weekView(b, 1);
  assert.equal(w1.people.length, 1); assert.equal(w2.people.length, 2); // Sam did not work week 1
  assert.equal(w1.here, 42); assert.equal(w2.here, 16); assert.equal(w1.here + w2.here, 58);
  assert.equal(w1.breaks, 0.5); assert.equal(w2.breaks, 1); assert.equal(w1.day.length, 7); assert.equal(w2.day[1], 8 + 0); // Tue Oct 13
  assert.equal(w1.ot, 5); assert.equal(w1.otPeople, 1); assert.equal(w2.ot, 0); assert.equal(w2.otPeople, 0); // 42 + 3 elsewhere = 45 h
  assert.equal(TAC.weekOver('2026-10-05', 0, '2026-10-12'), true); assert.equal(TAC.weekOver('2026-10-05', 0, '2026-10-11'), false); // Sunday Oct 11 is its last day
  assert.equal(TAC.weekOver('2026-10-05', 1, '2026-10-19'), true); assert.equal(TAC.weekOver('2026-10-05', 1, '2026-10-18'), false);
});
