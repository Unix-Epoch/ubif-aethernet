// Assize rules (phase 2): the engine's published-graph pieces (published, withGraphs, checkGraph, fromSnapshot), then
// the tracker Worker's routes (src/assize.js) against local D1: drafts, publish, history, revert, per-store overrides,
// on / off, graph-only rules, scope checks, the store side's answer, the editor's test orders. Fake data only.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { getPlatformProxy } from 'wrangler';
import worker, { trackerAdmin } from '../src/index.js';
import * as RG from '../src/rulegraph.js';
import { makeRules, fromSnapshot, trimDetail, trimRow, CATALOG } from '../src/assize-rules.js';
import { GRAPHS } from '../src/assize-graphs.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const R = makeRules({ RG, graphs: GRAPHS });
const clone = (x) => JSON.parse(JSON.stringify(x));

// The Worker's built-in graphs are src/assize-graphs/*.json, all of them.
assert.deepEqual(Object.keys(GRAPHS).sort(), readdirSync(ROOT + 'src/assize-graphs').filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort(), 'assize-graphs.js lists every built-in graph');
for (const [k, g] of Object.entries(GRAPHS)) assert.deepEqual(g, JSON.parse(readFileSync(ROOT + 'src/assize-graphs/' + k + '.json', 'utf8')));

// ------------------------------------------------------------------ engine: orders to test on
const NOW = Date.parse('2026-10-21T15:00:00Z'), opts = { now: NOW, hours: R.STORE_HOURS, priceFor: () => null };
const JO = { userId: 11, givenName: 'Jo', familyName: 'Diaz' };
const order = (id, program, status, notes, items) => ({
  row: { workorderId: id, workorderStatusId: status === 'Ready for pickup' ? 13 : 10, workorderStatusName: status, programId: program === 'Out Of Warranty' ? 20001 : 7001, programName: program,
    createdAt: '2026-10-20T14:00:00Z', updatedAt: '2026-10-20T16:00:00Z', deviceCatalog: { name: 'iPhone 13' }, customerDevice: { name: 'IPHONE 13 10/22' }, locationBin: 'A1', deviceIssues: ['Screen'] },
  detail: { wo: { workorderId: id, workorderStatusId: 10, WorkorderStatus: { name: status }, programId: 20001, Program: { name: program } }, audit: [], cart: { cartItems: items || [] },
    notes: notes.map((t, i) => ({ noteType: 2, noteTag: i ? 'note' : 'initial_checkin', noteText: t, createdAt: '2026-10-20T14:0' + i + ':00Z', UserDatum: JO })) },
});
const ORDERS = [order(1, 'Out Of Warranty', 'Work in progress', ['short']), order(2, 'Out Of Warranty', 'Work in progress', ['a\nb\nc', 'quoted $120']), order(3, 'Consumer Cellular', 'Ready for pickup', ['a\nb\nc'], [{ sku: 'X', name: 'Svc', price: 20 }]),
  order(4, 'Out Of Warranty', 'Work in progress', [])];
const codeOf = (o) => R.audit(o.row, o.detail, opts);
const rules = (list) => list.map((x) => x.rule).sort();

// published(): valid graphs compile, invalid ones are skipped (their code rule stays), off rules are noted.
{
  const bad = Object.assign(clone(GRAPHS['no-intake-note']), { nodes: [{ id: 'x', type: 'nope' }] });
  const set = R.published({ rules: { 'no-intake-note': { graph: GRAPHS['no-intake-note'], enabled: true, scope: 'all', version: 3 }, 'short-intake-note': { graph: bad, enabled: true, scope: '914', version: 1 },
    'no-bin': { graph: null, enabled: false, scope: null }, 'oop-zero-cart': { graph: GRAPHS['cci-zero-cart'], enabled: true } } });
  assert.ok(set.rules.get('no-intake-note').c && set.rules.get('no-intake-note').version === 3);
  assert.equal(set.rules.get('short-intake-note').c, null);
  assert.deepEqual(set.skipped.map((x) => x.rule), ['short-intake-note', 'oop-zero-cart'], 'invalid, and filed under another rule');
  assert.match(set.skipped[1].errors.join(), /graph is for rule "cci-zero-cart", not "oop-zero-cart"/);
  assert.equal(R.isOff(set, 'no-bin'), true); assert.equal(R.isOff(set, 'no-intake-note'), false); assert.equal(R.isOff(null, 'x'), false);
  assert.deepEqual(R.published(null).rules.size, 0);
}
// withGraphs(): faithful graphs give the code's findings exactly; a changed graph changes only its rule; off = nothing;
// graph-only rules add theirs; a graph that errs keeps the code's findings and says so.
{
  const all = R.published({ rules: Object.fromEntries(Object.entries(GRAPHS).map(([k, g]) => [k, { graph: g, enabled: true, scope: 'all', version: 1 }])) });
  assert.equal(all.skipped.length, 0);
  for (const o of ORDERS) {
    const code = codeOf(o), w = R.withGraphs(o.row, o.detail, opts, all, code);
    assert.deepEqual(R.sort(w.findings), R.sort(code), 'faithful graphs: same findings ' + o.row.workorderId);
    assert.deepEqual(w.errors, []); assert.deepEqual(w.ran.sort(), Object.keys(GRAPHS).sort());
    assert.deepEqual(R.withGraphs(o.row, o.detail, opts, null, code), { findings: code, errors: [], ran: [] }, 'nothing published: the code as is');
  }
  assert.ok(rules(codeOf(ORDERS[0])).includes('short-intake-note'));
  const changed = clone(GRAPHS['short-intake-note']);
  changed.nodes.find((n) => n.type === 'finding').settings.title = 'Intake note too short';
  const set = R.published({ rules: { 'short-intake-note': { graph: changed, enabled: true }, 'no-quote': { graph: null, enabled: false } } });
  const w = R.withGraphs(ORDERS[0].row, ORDERS[0].detail, opts, set);
  const code = codeOf(ORDERS[0]);
  assert.deepEqual(w.findings.filter((x) => x.rule === 'short-intake-note').map((x) => x.title), ['Intake note too short']);
  const before = code.find((x) => x.rule === 'short-intake-note'), after = w.findings.find((x) => x.rule === 'short-intake-note');
  assert.deepEqual(Object.keys(after), Object.keys(before), 'same fields, same order'); assert.equal(after.sig, before.sig, 'same signature: dismissals carry over');
  assert.ok(code.some((x) => x.rule === 'no-quote') && !w.findings.some((x) => x.rule === 'no-quote'), 'off: nothing');
  assert.deepEqual(rules(w.findings.filter((x) => !['short-intake-note', 'no-quote'].includes(x.rule))), rules(code.filter((x) => !['short-intake-note', 'no-quote'].includes(x.rule))), 'the rest untouched');
  // Graph-only: a rule the code doesn't have.
  const only = { v: 1, rule: 'cart-over-100', check: 'cart', title: 'Big cart', nodes: [{ id: 'wo', type: 'wo' }, { id: 's', type: 'cartSum' }, { id: 'a', type: 'atLeast', settings: { limit: 100 } }, { id: 'f', type: 'finding', settings: { kind: 'flag', evidence: 'Over $100' } }],
    wires: [{ from: 'wo.cart', to: 's.lines' }, { from: 's.sum', to: 'a.value' }, { from: 'a.yes', to: 'f.when' }] };
  assert.deepEqual(R.checkGraph(only, 'cart-over-100'), []);
  const o5 = order(5, 'Out Of Warranty', 'Work in progress', ['a\nb\nc', '$150'], [{ sku: 'S', name: 'Screen', price: 150 }]);
  const w5 = R.withGraphs(o5.row, o5.detail, opts, R.published({ rules: { 'cart-over-100': { graph: only, enabled: true } } }));
  assert.deepEqual(w5.findings.filter((x) => x.rule === 'cart-over-100').map((x) => [x.wo, x.kind, x.title, x.evidence, x.who.key]), [['5', 'flag', 'Big cart', 'Over $100', 'unassigned']]);
  // A graph that errs on an order: the code's findings for that rule, and the error.
  const boom = R.published({ rules: { 'short-intake-note': { graph: GRAPHS['short-intake-note'], enabled: true } } });
  boom.rules.get('short-intake-note').c = { errors: [], rule: 'short-intake-note', start: 's', nodes: { s: { id: 's', type: 'start', def: { run() { throw new Error('kaboom'); } }, next: {} } }, dataFindings: [] };
  const wb = R.withGraphs(ORDERS[0].row, ORDERS[0].detail, opts, boom);
  assert.deepEqual(wb.findings, code); assert.deepEqual(wb.ran, []); assert.match(wb.errors[0].error, /kaboom/); assert.equal(wb.errors[0].rule, 'short-intake-note');
  // Shadow mode leaves out what's published.
  assert.equal(R.shadow(ORDERS[0].row, ORDERS[0].detail, opts, code, new Set(['short-intake-note', 'oop-zero-cart'])).compared, Object.keys(GRAPHS).length - 2);
}
// checkGraph(): what may be published.
{
  const g = clone(GRAPHS['oop-zero-cart']);
  assert.deepEqual(R.checkGraph(g, 'oop-zero-cart'), []);
  assert.match(R.checkGraph(g, 'no-bin').join(), /for rule "oop-zero-cart", not "no-bin"/);
  const foreign = clone(g); foreign.nodes.find((n) => n.type === 'finding').settings.rule = 'no-bin';
  assert.match(R.checkGraph(foreign, 'oop-zero-cart').join(), /raises rule "no-bin"; a graph raises only its own rule/);
  const section = clone(g); section.check = 'nowhere';
  assert.match(R.checkGraph(section, 'oop-zero-cart').join(), /section "nowhere" is not one of intake, cart/);
  const big = { v: 1, rule: 'x', nodes: Array.from({ length: 201 }, (_, i) => ({ id: 'n' + i, type: 'stop' })) };
  assert.match(R.checkGraph(big, 'x').join(), /201 nodes; the most is 200/);
  assert.match(R.checkGraph({ v: 1, rule: 'x', nodes: [], pad: 'x'.repeat(R.MAX_GRAPH_BYTES) }, 'x').join(), /KB; the most is 256 KB/);
  assert.match(R.checkGraph({ v: 1, rule: 'Bad Id', nodes: [] }, null).join(), /lowercase letters, digits and dashes/);
  assert.deepEqual(R.checkGraph([], 'x'), ['The graph is not an object']);
  assert.match(makeRules().checkGraph(g, 'oop-zero-cart').join(), /No rule graph interpreter/);
}
// fromSnapshot(): a tracker snapshot as Assize's inputs; without the sealed part, no notes (never "no notes").
{
  const core = { workorder: { workorderId: 9, storeId: 914, workorderStatusId: 10, WorkorderStatus: { name: 'Work in progress' }, programId: 20001, Program: { name: 'Out Of Warranty' }, createdAt: '2026-10-20T14:00:00Z',
    CustomerDevice: { name: 'IPHONE 13 10/22', passcode: '[removed]', DeviceCatalog: { name: 'iPhone 13', DeviceModel: { DeviceType: { name: 'Cell Phone' } } } }, WorkorderAttributes: [] } };
  const notes = [{ noteType: 2, noteTag: 'initial_checkin', noteText: 'short', createdAt: '2026-10-20T14:00:00Z', UserDatum: Object.assign({ email: 'x@y' }, JO) }];
  const listRow = { workorderId: 9, workorderStatusId: 10, workorderStatusName: 'Work in progress', programId: 20001, programName: 'Out Of Warranty', customerDevice: { name: 'IPHONE 13 10/22' }, deviceCatalog: { name: 'iPhone 13' }, locationBin: 'B2', customer: { fullName: 'Pat Q' } };
  const sealed = { workorder: core, notes: { notes, total: 1 }, audit_trail: [{ workorderStatusId: 10, createdAt: '2026-10-20T14:05:00Z', createdBy: 11 }], cart: { cartItems: [] }, customer_data: { CustomerDatum: { fullName: 'Pat Q' } }, list_row: listRow };
  const x = fromSnapshot(null, sealed);
  assert.deepEqual(x.detail, trimDetail(core, notes, sealed.audit_trail, sealed.cart)); assert.deepEqual(x.row, trimRow(listRow));
  assert.deepEqual([x.details, x.missing], [true, []]);
  assert.ok(!JSON.stringify(x).includes('x@y'), 'trimmed like Assize keeps it');
  assert.deepEqual(rules(R.audit(x.row, x.detail, opts)), ['no-quote', 'oop-zero-cart', 'short-intake-note']);
  const unloaded = fromSnapshot(null, Object.assign({}, sealed, { notes: null }));
  assert.equal(unloaded.detail.notes, null); assert.deepEqual(unloaded.missing, ['notes']);
  const plain = { workorder: { workorderId: 9, storeId: 914, statusId: 10, status: 'Work in progress', programId: 20001, program: 'Out Of Warranty', device: 'iPhone 13', bin: 'B2', outcome: null, createdAt: '2026-10-20T14:00:00Z' },
    auditTrail: [{ statusId: 10, createdAt: '2026-10-20T14:05:00Z', createdBy: 11 }], notes: { total: 1 }, cart: { items: [{ sku: 'SCR', name: 'Screen', price: 0, quantity: 1 }], payment: { subtotal: 0, total: 0 } } };
  const p = fromSnapshot(plain, null);
  assert.deepEqual([p.details, p.detail.notes, p.missing], [false, null, ['notes', 'nickname', 'deviceType', 'issues', 'lineTypes']]);
  const f = R.facts(p.row, p.detail);
  assert.deepEqual([f.id, f.status, f.programName, f.device, f.bin, f.notes, f.hasCart, f.audit.length], ['9', 'Work in progress', 'Out Of Warranty', 'iPhone 13', 'B2', null, true, 1]);
  assert.deepEqual(rules(R.audit(p.row, p.detail, opts)), ['oop-zero-cart'], 'note rules wait without notes; the cart rule runs');
  const d = RG.run(RG.compile(GRAPHS['no-intake-note']), Object.assign(Object.create(R.GH), { f, opts }), { debug: true });
  assert.equal(d.needsNotes, true, 'the editor can say "needs customer details"');
  assert.deepEqual(fromSnapshot({}, null).row.workorderId, undefined, 'an empty plain part does not throw');
}

// ------------------------------------------------------------------ the Worker's routes
rmSync('.wrangler-test-assize', { recursive: true, force: true });
const { env, dispose } = await getPlatformProxy({ configPath: 'wrangler.toml', persist: { path: '.wrangler-test-assize' } });
for (const stmt of readFileSync('schema.sql', 'utf8').replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean)) await env.TR.prepare(stmt).run();
// The migration applies on its own too (to a database without the tables), and again without harm.
for (const stmt of readFileSync('migrations/2026-10-21-assize-rules.sql', 'utf8').replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean)) await env.TR.prepare(stmt).run();
await env.AE.prepare('CREATE TABLE IF NOT EXISTS store_access (store INTEGER PRIMARY KEY, name TEXT, added_by TEXT, added_at TEXT)').run();
await env.AE.prepare("INSERT INTO store_access (store, name) VALUES (914, 'Newport News'), (326, 'Lynnhaven')").run();
const T = env.TR, E = Object.assign({}, env, { APP_KEY: 'k', TRACKER_OWNERS: 'dev@x.com', LIMITER: null });
const person = (email, scope, stores, pages, details) => T.prepare('INSERT INTO people (email, scope, stores, pages, details) VALUES (?, ?, ?, ?, ?)').bind(email, scope, JSON.stringify(stores), JSON.stringify(pages), details).run();
await person('all@x.com', 'all', [], ['rules', 'wos'], 1);      // every store, customer details
await person('st@x.com', 'stores', [914], ['rules'], 0);         // store 914 only, no details
await person('wos@x.com', 'stores', [914], ['wos'], 1);          // no Assize rules page
const admin = async (email, method, path, body) => {
  const u = new URL('https://a.test/api/tracker' + path);
  const r = await trackerAdmin(new Request(u, { method, body: body ? JSON.stringify(body) : undefined }), E, u, path.split('?')[0], email);
  const text = await r.text();
  return { status: r.status, j: JSON.parse(text), text };
};
const store = async (st, v) => { const r = await worker.fetch(new Request('https://t.test/v1/' + st + '/assize/rules' + (v ? '?v=' + v : ''), { headers: { 'x-aethernet-key': 'k' } }), E, {}); return { status: r.status, j: await r.json() }; };
const ok = (r, what) => assert.ok(r.status < 300, what + ': ' + r.status + ' ' + r.text);
const logs = async (action) => (await T.prepare('SELECT * FROM access_log WHERE action = ? ORDER BY id').bind(action).all()).results;

// Who may: page 'rules' needed; the store side needs the app key and a store with access.
assert.equal((await admin('wos@x.com', 'GET', '/assize/rules')).status, 403, 'no rules page');
assert.equal((await admin('nobody@x.com', 'GET', '/assize/rules')).status, 403);
assert.equal((await store(999)).status, 403, 'store without Aethernet access');
assert.equal((await worker.fetch(new Request('https://t.test/v1/914/assize/rules'), E, {})).status, 403, 'app key');
assert.equal((await worker.fetch(new Request('https://t.test/v1/914/assize/nope', { headers: { 'x-aethernet-key': 'k' } }), E, {})).status, 404);

// The list: every code rule, nothing stored yet. Nothing applies at the stores.
let list = (await admin('st@x.com', 'GET', '/assize/rules')).j;
assert.equal(list.rules.length, CATALOG.length);
assert.deepEqual(list.checks, R.CHECKS);
const oop = list.rules.find((x) => x.rule === 'oop-zero-cart');
assert.deepEqual(oop, { rule: 'oop-zero-cart', check: 'cart', title: 'OOP, $0 cart', kind: 'note', code: true, perOrder: true, builtInGraph: true, scopes: [] });
let s914 = (await store(914)).j;
assert.deepEqual(s914.rules, {}); assert.match(s914.version, /^[0-9a-f]{24}$/);
assert.deepEqual((await store(914, s914.version)).j, { version: s914.version, same: true }, 'same version: no graphs sent');

// Drafts for every store need all-stores access; drafts may be invalid and carry their errors; publishing refuses them.
const g1 = clone(GRAPHS['oop-zero-cart']);
assert.equal((await admin('st@x.com', 'PUT', '/assize/rules/oop-zero-cart/draft', { scope: 'all', graph: g1 })).status, 403, 'store person, all stores');
assert.equal((await admin('all@x.com', 'PUT', '/assize/rules/oop-zero-cart/draft', { scope: 'nowhere', graph: g1 })).status, 400);
assert.equal((await admin('all@x.com', 'POST', '/assize/rules/oop-zero-cart/draft', { scope: 'all', graph: g1 })).status, 405, 'drafts are PUT');
assert.equal((await admin('all@x.com', 'POST', '/assize/rules/oop-zero-cart/publish', { scope: 'all' })).status, 400, 'no draft yet');
const bad = Object.assign(clone(g1), { nodes: g1.nodes.concat([{ id: 'zz', type: 'frobnicate' }]) });
let r = await admin('all@x.com', 'PUT', '/assize/rules/oop-zero-cart/draft', { scope: 'all', graph: bad, note: 'trying' });
ok(r, 'invalid draft saved'); assert.match(r.j.errors.join(), /zz: unknown node type "frobnicate"/);
r = await admin('all@x.com', 'POST', '/assize/rules/oop-zero-cart/publish', { scope: 'all' });
assert.equal(r.status, 400); assert.equal(r.j.error, 'the draft has errors'); assert.match(r.j.errors.join(), /frobnicate/);
r = await admin('all@x.com', 'PUT', '/assize/rules/oop-zero-cart/draft', { scope: 'all', graph: g1 });
ok(r, 'valid draft'); assert.deepEqual(r.j.errors, []);
const draftAt = r.j.draftAt;
assert.equal((await admin('dev@x.com', 'PUT', '/assize/rules/oop-zero-cart/draft', { scope: 'all', graph: g1, ifDraftAt: '2020-01-01T00:00:00Z' })).status, 409, 'someone saved since');
assert.equal((await admin('all@x.com', 'POST', '/assize/rules/oop-zero-cart/publish', { scope: 'all', ifDraftAt: 'nope' })).status, 409);
r = await admin('all@x.com', 'POST', '/assize/rules/oop-zero-cart/publish', { scope: 'all', note: 'first', ifDraftAt: draftAt });
ok(r, 'publish'); assert.equal(r.j.version, 1);
let one = (await admin('all@x.com', 'GET', '/assize/rules/oop-zero-cart')).j;
assert.deepEqual(one.builtInGraph, GRAPHS['oop-zero-cart']);
assert.deepEqual(one.scopes.map((x) => [x.scope, x.draft, x.version, x.published && x.published.rule, x.publishedBy, x.enabled, x.note]), [['all', null, 1, 'oop-zero-cart', 'all@x.com', null, 'trying']]);
assert.deepEqual(one.history.map((h) => [h.action, h.scope, h.version, h.hasGraph, h.note]), [['publish', 'all', 1, true, 'first']]);
assert.ok((await logs('assize:publish')).some((l) => /oop-zero-cart · all stores · version 1/.test(l.detail)), 'access_log row');
assert.ok((await logs('assize:draft')).length >= 2);

// The store side: the graph for every store, until a store has its own.
s914 = (await store(914)).j;
assert.deepEqual(s914.rules, { 'oop-zero-cart': { graph: g1, version: 1, scope: 'all', enabled: true } });
assert.equal((await store(914, s914.version)).j.same, true);
const v326 = (await store(326)).j.version;
assert.equal(v326, s914.version, 'same rules, same version');

// A store override (store 914, by the 914 person): wins at 914 only. Other stores' scopes are refused.
const g914 = clone(g1); g914.nodes.find((n) => n.type === 'finding').settings.title = 'OOP with nothing in the cart';
assert.equal((await admin('st@x.com', 'PUT', '/assize/rules/oop-zero-cart/draft', { scope: 326, graph: g914 })).status, 403, 'not their store');
ok(await admin('st@x.com', 'PUT', '/assize/rules/oop-zero-cart/draft', { scope: 914, graph: g914, note: 'Newport wording' }), 'store draft');
s914 = (await store(914)).j;
assert.equal(s914.rules['oop-zero-cart'].scope, 'all', 'a draft changes nothing');
ok(await admin('st@x.com', 'POST', '/assize/rules/oop-zero-cart/publish', { scope: '914' }), 'store publish');
const n914 = (await store(914)).j;
assert.notEqual(n914.version, s914.version, 'new version at 914');
assert.deepEqual(n914.rules['oop-zero-cart'], { graph: g914, version: 1, scope: '914', enabled: true });
assert.deepEqual((await store(326)).j.rules['oop-zero-cart'].scope, 'all'); assert.equal((await store(326)).j.version, v326, '326 unchanged');
// What the store person sees: 'all' and 914, never 326's rows.
await T.prepare("INSERT INTO assize_rules (rule, scope, enabled) VALUES ('oop-zero-cart', '326', 0)").run();
one = (await admin('st@x.com', 'GET', '/assize/rules/oop-zero-cart')).j;
assert.deepEqual(one.scopes.map((x) => x.scope), ['914', 'all']);
assert.deepEqual((await admin('all@x.com', 'GET', '/assize/rules/oop-zero-cart')).j.scopes.map((x) => x.scope), ['326', '914', 'all']);
list = (await admin('st@x.com', 'GET', '/assize/rules')).j;
assert.deepEqual(list.rules.find((x) => x.rule === 'oop-zero-cart').scopes.map((x) => [x.scope, x.published, x.version, x.draft, x.note]), [['914', true, 1, false, 'Newport wording'], ['all', true, 1, false, 'trying']]);
assert.deepEqual((await store(326)).j.rules['oop-zero-cart'], { graph: g1, version: 1, scope: 'all', enabled: false }, 'off at 326, graph and all');
await T.prepare("DELETE FROM assize_rules WHERE rule = 'oop-zero-cart' AND scope = '326'").run();

// On / off. Off at a store: nothing there. Off everywhere, on again at one store; null: follow all stores.
assert.equal((await admin('st@x.com', 'POST', '/assize/rules/no-bin/enabled', { scope: 914, enabled: 'no' })).status, 400);
assert.equal((await admin('all@x.com', 'POST', '/assize/rules/no-bin/enabled', { scope: 'all', enabled: null })).status, 400, 'null is for stores');
ok(await admin('st@x.com', 'POST', '/assize/rules/no-bin/enabled', { scope: 914, enabled: false }), 'off at 914');
assert.deepEqual((await store(914)).j.rules['no-bin'], { graph: null, version: null, scope: null, enabled: false });
assert.equal((await store(326)).j.rules['no-bin'], undefined);
ok(await admin('all@x.com', 'POST', '/assize/rules/no-quote/enabled', { scope: 'all', enabled: false, note: 'too noisy' }), 'off everywhere');
ok(await admin('st@x.com', 'POST', '/assize/rules/no-quote/enabled', { scope: 914, enabled: true }), 'on at 914');
assert.equal((await store(914)).j.rules['no-quote'], undefined, 'on and no graph: the code rule, nothing to send');
assert.equal((await store(326)).j.rules['no-quote'].enabled, false);
ok(await admin('st@x.com', 'POST', '/assize/rules/no-quote/enabled', { scope: 914, enabled: null }), 'follow all stores');
assert.equal((await store(914)).j.rules['no-quote'].enabled, false);
assert.equal(await T.prepare("SELECT 1 FROM assize_rules WHERE rule = 'no-quote' AND scope = '914'").first(), null, 'an empty override row goes');
one = (await admin('all@x.com', 'GET', '/assize/rules/no-quote')).j;
assert.deepEqual(one.history.map((h) => [h.action, h.scope, h.note]), [['inherit', '914', null], ['enable', '914', null], ['disable', 'all', 'too noisy']]);
ok(await admin('all@x.com', 'POST', '/assize/rules/no-quote/enabled', { scope: 'all', enabled: true }), 'on again');

// Revert: an old version comes back as the draft (it doesn't publish by itself).
const g2 = clone(g1); g2.nodes.find((n) => n.type === 'finding').settings.title = 'Second wording';
ok(await admin('all@x.com', 'PUT', '/assize/rules/oop-zero-cart/draft', { scope: 'all', graph: g2 }), 'draft 2');
ok(await admin('all@x.com', 'POST', '/assize/rules/oop-zero-cart/publish', { scope: 'all' }), 'publish 2');
one = (await admin('all@x.com', 'GET', '/assize/rules/oop-zero-cart')).j;
const v1 = one.history.find((h) => h.action === 'publish' && h.scope === 'all' && h.version === 1);
const h1 = (await admin('st@x.com', 'GET', '/assize/rules/oop-zero-cart/history/' + v1.id)).j;
assert.deepEqual([h1.version, h1.action, h1.graph], [1, 'publish', g1]);
assert.equal((await admin('st@x.com', 'GET', '/assize/rules/no-bin/history/' + v1.id)).status, 404, 'another rule\'s history');
assert.equal((await admin('all@x.com', 'POST', '/assize/rules/oop-zero-cart/revert', { scope: 'all', id: 999999 })).status, 404);
r = await admin('all@x.com', 'POST', '/assize/rules/oop-zero-cart/revert', { scope: 'all', id: v1.id });
ok(r, 'revert'); assert.deepEqual(r.j.errors, []);
one = (await admin('all@x.com', 'GET', '/assize/rules/oop-zero-cart')).j;
const all1 = one.scopes.find((x) => x.scope === 'all');
assert.deepEqual([all1.draft, all1.version, all1.published.nodes.find((n) => n.type === 'finding').settings.title], [g1, 2, 'Second wording'], 'draft = version 1; version 2 still live');
assert.deepEqual(one.history[0], Object.assign({}, one.history[0], { action: 'revert', version: 1, note: 'draft from version 1', hasGraph: false }));
ok(await admin('all@x.com', 'POST', '/assize/rules/oop-zero-cart/discard', { scope: 'all' }), 'discard');
assert.equal((await admin('all@x.com', 'GET', '/assize/rules/oop-zero-cart')).j.scopes.find((x) => x.scope === 'all').draft, null);
// A store can start from the version for all stores.
ok(await admin('st@x.com', 'POST', '/assize/rules/oop-zero-cart/revert', { scope: 914, id: v1.id }), 'store revert from the all-stores version');

// Deleting a store's override: back to the version for all stores.
assert.equal((await admin('st@x.com', 'POST', '/assize/rules/oop-zero-cart/delete', { scope: 'all' })).status, 403, 'all-stores scope');
assert.equal((await admin('all@x.com', 'POST', '/assize/rules/oop-zero-cart/delete', { scope: 'all' })).status, 400, 'only overrides');
ok(await admin('st@x.com', 'POST', '/assize/rules/oop-zero-cart/delete', { scope: 914 }), 'delete override');
assert.deepEqual((await store(914)).j.rules['oop-zero-cart'], { graph: g2, version: 2, scope: 'all', enabled: true });
assert.equal((await admin('all@x.com', 'GET', '/assize/rules/oop-zero-cart')).j.history[0].action, 'delete');

// The rule that looks across orders runs per order now (the store's closed rows come in through opts.closed): it takes
// a graph like any other, and it can be turned off.
ok(await admin('all@x.com', 'PUT', '/assize/rules/parent-closed-cleaning-open/draft', { scope: 'all', graph: GRAPHS['parent-closed-cleaning-open'] }), 'a draft for the cross-order rule');
ok(await admin('all@x.com', 'POST', '/assize/rules/parent-closed-cleaning-open/enabled', { scope: 'all', enabled: false }), 'off');
ok(await admin('all@x.com', 'POST', '/assize/rules/parent-closed-cleaning-open/enabled', { scope: 'all', enabled: true }), 'on');

// Graph-only rules: a new id, unique, for every store (all-stores access).
assert.equal((await admin('all@x.com', 'GET', '/assize/rules/cart-over-100')).status, 404);
assert.equal((await admin('all@x.com', 'POST', '/assize/rules', { rule: 'Cart Over', title: 'x', check: 'cart' })).status, 400);
assert.equal((await admin('all@x.com', 'POST', '/assize/rules', { rule: 'cart-over-100', title: 'Big cart', check: 'nowhere' })).status, 400);
assert.equal((await admin('all@x.com', 'POST', '/assize/rules', { rule: 'no-bin', title: 'x', check: 'bin' })).status, 409, 'a code rule\'s id');
assert.equal((await admin('st@x.com', 'POST', '/assize/rules', { rule: 'cart-over-100', title: 'Big cart', check: 'cart' })).status, 403, 'store person');
ok(await admin('all@x.com', 'POST', '/assize/rules', { rule: 'cart-over-100', title: 'Big cart', check: 'cart', kind: 'flag' }), 'create');
assert.equal((await admin('dev@x.com', 'POST', '/assize/rules', { rule: 'cart-over-100', title: 'Again', check: 'cart' })).status, 409, 'taken');
list = (await admin('all@x.com', 'GET', '/assize/rules')).j;
assert.deepEqual(list.rules.at(-1), { rule: 'cart-over-100', check: 'cart', title: 'Big cart', kind: null, code: false, perOrder: true, builtInGraph: false,
  scopes: [Object.assign({}, list.rules.at(-1).scopes[0], { scope: 'all', draft: true, draftErrors: 0, published: false, version: 0 })] });
one = (await admin('all@x.com', 'GET', '/assize/rules/cart-over-100')).j;
assert.deepEqual([one.code, one.builtInGraph, one.scopes[0].draft], [false, null, { v: 1, rule: 'cart-over-100', check: 'cart', title: 'Big cart', nodes: [], wires: [], kind: 'flag' }]);
const only = { v: 1, rule: 'cart-over-100', check: 'cart', title: 'Big cart', nodes: [{ id: 'wo', type: 'wo' }, { id: 's', type: 'cartSum' }, { id: 'a', type: 'atLeast', settings: { limit: 100 } }, { id: 'f', type: 'finding', settings: { kind: 'flag' } }],
  wires: [{ from: 'wo.cart', to: 's.lines' }, { from: 's.sum', to: 'a.value' }, { from: 'a.yes', to: 'f.when' }] };
ok(await admin('all@x.com', 'PUT', '/assize/rules/cart-over-100/draft', { scope: 'all', graph: only }), 'draft');
ok(await admin('all@x.com', 'POST', '/assize/rules/cart-over-100/publish', { scope: 'all' }), 'publish');
ok(await admin('all@x.com', 'POST', '/assize/rules/cart-over-100/discard', { scope: 'all' }), 'discard with no draft: fine');
assert.ok(await T.prepare("SELECT 1 FROM assize_rules WHERE rule = 'cart-over-100' AND scope = 'all'").first(), 'a graph-only rule keeps its row');
s914 = (await store(914)).j;
assert.deepEqual(Object.keys(s914.rules).sort(), ['cart-over-100', 'no-bin', 'oop-zero-cart']);
// …and Assize can run what the store side sends.
const set = R.published(s914);
assert.deepEqual(set.skipped, []);
const big = order(7, 'Out Of Warranty', 'Work in progress', ['a\nb\nc', '$150'], [{ sku: 'S', name: 'Screen', price: 150 }]);
big.row.locationBin = '';
const wf = R.withGraphs(big.row, big.detail, opts, set);
assert.ok(wf.findings.some((x) => x.rule === 'cart-over-100') && !wf.findings.some((x) => x.rule === 'no-bin') && R.audit(big.row, big.detail, opts).some((x) => x.rule === 'no-bin'));
// A foreign rule in a finding, too many nodes, too big.
const foreign = clone(only); foreign.nodes[3].settings.rule = 'no-bin';
assert.match((await admin('all@x.com', 'PUT', '/assize/rules/cart-over-100/draft', { scope: 'all', graph: foreign })).j.errors.join(), /raises rule "no-bin"/);
assert.match((await admin('all@x.com', 'PUT', '/assize/rules/cart-over-100/draft', { scope: 'all', graph: Object.assign(clone(only), { nodes: Array.from({ length: 201 }, (_, i) => ({ id: 'n' + i, type: 'stop' })) }) })).j.errors.join(), /201 nodes/);
assert.equal((await admin('all@x.com', 'PUT', '/assize/rules/cart-over-100/draft', { scope: 'all', graph: Object.assign(clone(only), { pad: 'x'.repeat(R.MAX_GRAPH_BYTES) }) })).status, 413);
assert.equal((await admin('all@x.com', 'PUT', '/assize/rules/cart-over-100/draft', { scope: 'all', graph: [] })).status, 400);
assert.equal((await admin('all@x.com', 'GET', '/assize/rules/nope-nope')).status, 404);
assert.equal((await admin('all@x.com', 'GET', '/assize/rules/BAD')).status, 404);

// The editor's test orders: open orders' latest snapshots; sealed only with customer details; their stores only.
for (const [wo, open] of [[7001, 1], [7002, 1], [7003, 0]]) {
  await T.prepare("INSERT INTO workorders (store, wo, status_id, status_name, program_name, device, is_open, first_seen_at) VALUES (914, ?, 10, 'Work in progress', 'Out Of Warranty', 'iPhone 13', ?, '2026-10-20T00:00:00Z')").bind(wo, open).run();
  for (const v of [1, 2]) await T.prepare("INSERT INTO snapshots (store, wo, fetched_at, hash, plain, sealed) VALUES (914, ?, ?, 'h', ?, ?)").bind(wo, '2026-10-20T0' + v + ':00:00Z', JSON.stringify({ workorder: { workorderId: wo, statusId: 10, status: 'Work in progress', program: 'Out Of Warranty', v } }), 'v1.SEALED' + v).run();
}
await T.prepare("INSERT INTO scans (store, at, open_count) VALUES (914, '2026-10-20T03:00:00Z', 2)").run();
let od = await admin('all@x.com', 'GET', '/assize/orders?store=914');
ok(od, 'orders');
assert.deepEqual([od.j.store, od.j.details, od.j.last_scan_at], [914, true, '2026-10-20T03:00:00Z']);
assert.deepEqual(od.j.orders.map((o) => [o.wo, o.plain.workorder.v, o.sealed, o.snapshot_at]), [[7001, 2, 'v1.SEALED2', '2026-10-20T02:00:00Z'], [7002, 2, 'v1.SEALED2', '2026-10-20T02:00:00Z']], 'open only, latest snapshot');
assert.deepEqual((await admin('all@x.com', 'GET', '/assize/orders?store=914&wos=7002')).j.orders.map((o) => o.wo), [7002]);
od = await admin('st@x.com', 'GET', '/assize/orders?store=914');
ok(od, 'orders, no details'); assert.equal(od.j.details, false); assert.ok(!/SEALED/.test(od.text) && od.j.orders.every((o) => !('sealed' in o)), 'nothing sealed');
assert.equal((await admin('st@x.com', 'GET', '/assize/orders?store=326')).status, 403, 'not their store');
assert.equal((await admin('st@x.com', 'GET', '/assize/orders')).status, 403, 'a store is needed');
assert.ok((await logs('assize:orders')).length >= 3);
// The stores to test on: the tracker's stores they can see, and every store in their list (even with no orders yet).
await person('st2@x.com', 'stores', [914, 1276], ['rules'], 0);
assert.deepEqual((await admin('all@x.com', 'GET', '/assize/stores')).j.stores, [{ store: 914, name: null, open: 2 }]);
assert.deepEqual((await admin('st2@x.com', 'GET', '/assize/stores')).j.stores.map((s) => [s.store, s.open]), [[914, 2], [1276, 0]]);
assert.equal((await admin('wos@x.com', 'GET', '/assize/stores')).status, 403, 'no Assize rules page');
// Unlocking test orders' notes: an all-stores person with Assize rules (and customer details) may read the store keys.
await person('rulesall@x.com', 'all', [], ['rules'], 1);
assert.equal((await admin('rulesall@x.com', 'GET', '/store-keys')).status, 200, 'rules page reaches store-keys');
assert.equal((await admin('st@x.com', 'GET', '/store-keys')).status, 403, 'still all stores + details only');

await dispose();
rmSync('.wrangler-test-assize', { recursive: true, force: true });
console.log('assize rules: engine and routes all passed');
