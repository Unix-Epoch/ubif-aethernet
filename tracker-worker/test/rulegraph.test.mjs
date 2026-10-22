// Rule graphs (src/rulegraph.js): the interpreter on its own (lazy pure nodes, exec flow, both finding styles, macros,
// validation, the step limit, a throwing node, the trace), then parity: Assize's real rules engine (src/assize-rules.js,
// the module Aethernet inlines) against the five built-in graphs over synthetic orders and the sandbox's.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import * as RG from '../src/rulegraph.js';
import { NODE_TYPES, MACROS, validate, compile, run } from '../src/rulegraph.js';
import * as AR from '../src/assize-rules.js';
import { makeRules } from '../src/assize-rules.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const GRAPHS = Object.fromEntries(readdirSync(ROOT + 'src/assize-graphs').filter((f) => f.endsWith('.json')).sort().map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(ROOT + 'src/assize-graphs/' + f, 'utf8'))]));

// ------------------------------------------------------------------ Assize's rules engine (src/assize-rules.js), with the graphs
const R = makeRules({ RG, graphs: GRAPHS });
const unbuilt = makeRules();
assert.equal(unbuilt.graphs.rules.length, 0, 'no interpreter: no graphs, no crash');
assert.deepEqual(unbuilt.shadow({ workorderId: 1 }, null, {}), { compared: 0, mismatches: [], errors: [] });
// What build.py inlines into Aethernet (tracker_module(): the ES module minus `export`, plus `return { names }`) works as
// plain function bodies, exports the same names, and is the same engine.
function trackerModule(name) {
  const src = readFileSync(ROOT + 'tracker-worker/src/' + name, 'utf8');
  const names = [...src.matchAll(/^export (?:async )?(?:const|function) (\w+)/gm)].map((m) => m[1]);
  return src.replace(/^export /gm, '') + '\nreturn { ' + names.join(', ') + ' };\n';
}
const injected = new Function(trackerModule('rulegraph.js'))();
assert.deepEqual(Object.keys(injected).sort(), Object.keys(RG).sort(), 'rulegraph: injection exports the same names');
const injectedRules = new Function(trackerModule('assize-rules.js'))();
assert.deepEqual(Object.keys(injectedRules).sort(), Object.keys(AR).sort(), 'assize-rules: injection exports the same names');
const assizeSrc = readFileSync(ROOT + 'src/65-assize.js', 'utf8');
const from = assizeSrc.indexOf('AE.assizeRules = (() => {'), to = assizeSrc.indexOf('\nAE.crystal(', from);
assert.ok(from >= 0 && to > from, 'found AE.assizeRules in 65-assize.js');
const bundled = new Function('AE', assizeSrc.slice(from, to).replace('/*__RULEGRAPH__*/', () => trackerModule('rulegraph.js')).replace('/*__ASSIZE_RULES__*/', () => trackerModule('assize-rules.js'))
  .replace('__ASSIZE_GRAPHS__', () => JSON.stringify(GRAPHS)) + '\nreturn AE.assizeRules;')({});
assert.deepEqual(Object.keys(bundled).sort(), Object.keys(R).sort(), 'the bundle has the same engine');
assert.deepEqual(bundled.graphs.rules.map((c) => c.rule), R.graphs.rules.map((c) => c.rule));

// ------------------------------------------------------------------ interpreter
const ctx0 = Object.assign(Object.create(R.GH), { f: R.facts({ workorderId: 1, workorderStatusName: 'Ready for work', programId: 20001 }, null), opts: {} });
const W = (from, to) => ({ from, to });
const lib = (extra) => ({ nodes: Object.assign({}, NODE_TYPES, extra) });
let probes = 0;
const PROBE = { probe: { title: 'Probe', cat: 'logic', desc: 'counts its evaluations', inputs: [], outputs: [{ name: 'out', type: 'bool' }], settings: [{ name: 'value', type: 'bool' }],
  eval: (io, s) => { probes++; return { out: !!s.value }; } },
  boom: { title: 'Boom', cat: 'logic', desc: 'throws', inputs: [], outputs: [{ name: 'out', type: 'bool' }], settings: [], eval: () => { throw new Error('kaboom'); } } };
const K = (id, value) => ({ id, type: 'constant', settings: { type: 'bool', value } });

// Lazy and memoized: one probe read by three nodes evaluates once; one behind a false `and` never does.
{
  const g = { v: 1, rule: 'r', check: 'intake', title: 'T', nodes: [{ id: 'p', type: 'probe', settings: { value: true } }, { id: 'q', type: 'probe', settings: { value: true } }, K('f', false),
    { id: 'n1', type: 'not' }, { id: 'n2', type: 'not' }, { id: 'a', type: 'and' }, { id: 'lazy', type: 'and' }, { id: 'o', type: 'or' }, { id: 'out', type: 'finding' }],
  wires: [W('p.out', 'n1.in'), W('p.out', 'n2.in'), W('p.out', 'a.a'), W('n1.out', 'o.a'), W('n2.out', 'o.b'), W('a.out', 'o.c'), W('f.out', 'lazy.a'), W('q.out', 'lazy.b'), W('lazy.out', 'o.d'), W('o.out', 'out.when')] };
  const c = compile(g, lib(PROBE));
  assert.deepEqual(c.errors, []);
  probes = 0;
  const r = run(c, ctx0);
  assert.equal(r.findings.length, 1);
  assert.equal(probes, 1, 'p once (memoized); q never (and stopped at f = false; or stopped at a = true)');
  assert.equal(r.trace['p.out'], true);
  assert.equal(r.trace['n1.out'], false);
  assert.ok(!('q.out' in r.trace) && !('lazy.out' in r.trace), 'the trace has only what was computed');
  assert.deepEqual(r.findings[0], { check: 'intake', kind: 'note', rule: 'r', title: 'T', sigBasis: [], evidence: '', who: R.GH.UNASSIGNED });
  probes = 0;
  run(c, ctx0); run(c, ctx0);
  assert.equal(probes, 2, 'memo is per run');
  assert.deepEqual(run(c, ctx0, { trace: false }).trace, {}, 'trace off');
}

// Exec flow: branch, finding in both styles, stop; reminder.
{
  const mk = (cond, stopOnYes) => ({ v: 1, rule: 'r', check: 'cart', title: 'Default', nodes: [{ id: 'start', type: 'start' }, K('c', cond), K('t', true), K('no', false),
    { id: 'b', type: 'branch' }, { id: 'fx', type: 'finding', settings: { title: 'Exec', kind: 'fail', evidence: 'reached' } },
    { id: 'fw', type: 'finding', settings: { title: 'Exec, when false' } }, { id: 'fd', type: 'finding', settings: { title: 'Data', kind: 'flag' } },
    { id: 'rem', type: 'reminder', settings: { title: 'Remind me', rule: 'rem' } }, { id: 'end', type: 'stop' }],
  wires: [W('c.out', 'b.cond'), W('no.out', 'fw.when'), W('t.out', 'fd.when'), W('t.out', 'rem.when')],
  flow: [W('start.then', 'b.in'), W('b.yes', 'fx.in'), W('fx.then', 'fw.in'), ...(stopOnYes ? [W('fw.then', 'end.in')] : []), W('b.no', 'end.in')] });
  let r = run(compile(mk(true, false)), ctx0);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.findings.map((x) => x.title), ['Exec', 'Data', 'Remind me'], 'exec finding, exec finding whose when is false skipped, then the data-driven ones');
  assert.equal(r.findings[0].kind, 'fail'); assert.equal(r.findings[0].evidence, 'reached'); assert.equal(r.findings[0].check, 'cart');
  assert.deepEqual([r.findings[2].kind, r.findings[2].check, r.findings[2].rule], ['remind', 'remind', 'rem'], 'reminder: kind and check remind');
  assert.deepEqual(r.path, ['start', 'b', 'fx', 'fw']);
  r = run(compile(mk(true, true)), ctx0);
  assert.deepEqual(r.findings.map((x) => x.title), ['Exec'], 'stop keeps what was raised and skips the data-driven findings');
  assert.deepEqual(r.path, ['start', 'b', 'fx', 'fw', 'end']);
  r = run(compile(mk(false, false)), ctx0);
  assert.deepEqual(r.findings, [], 'branch no → stop: nothing');
  // A graph with no start: pure data flow.
  r = run(compile({ v: 1, rule: 'x', nodes: [K('t', true), { id: 'f', type: 'finding' }], wires: [W('t.out', 'f.when')] }), ctx0);
  assert.equal(r.findings.length, 1); assert.deepEqual(r.path, []);
}

// Text nodes: word lists are escaped and whole-word; negations skipped; templates; chooseText; named patterns.
{
  const g = (words, text, skipNegated = true) => ({ v: 1, rule: 'x', nodes: [{ id: 't', type: 'constant', settings: { type: 'text', value: text } }, { id: 'm', type: 'notesMention', settings: { words, skipNegated } },
    { id: 'tp', type: 'template', settings: { text: 'Found {w}!' } }, { id: 'f', type: 'finding' }], wires: [W('t.out', 'm.text'), W('m.found', 'f.when'), W('m.word', 'tp.w'), W('tp.out', 'f.evidence')] });
  const ev = (...a) => { const r = run(compile(g(...a)), ctx0); assert.deepEqual(r.errors, []); return r.findings.length ? r.findings[0].evidence : null; };
  assert.equal(ev(['deposit'], 'Paid the Deposit today'), 'Found Deposit!');
  assert.equal(ev(['deposit'], 'no deposit taken'), null, 'negated: skipped');
  assert.equal(ev(['deposit'], 'no deposit taken', false), 'Found deposit!', 'negation not skipped when asked');
  assert.equal(ev(['deposit'], 'deposits'), null, 'whole words only');
  assert.equal(ev(['a.c'], 'abc'), null, 'a word is not a regex');
  assert.equal(ev(['c++', '(x)'], 'needs c++ now'), 'Found c++!', 'special characters escaped');
  assert.equal(ev(['no charge'], 'Store said No Charge.'), 'Found No Charge!', 'phrases, any case');
  assert.equal(ev([], 'anything'), null, 'empty list never matches');
  const pat = (pattern, text, skipNegated) => run(compile({ v: 1, rule: 'x', nodes: [{ id: 't', type: 'constant', settings: { type: 'text', value: text } }, { id: 'm', type: 'matchesPattern', settings: { pattern, skipNegated } },
    { id: 'f', type: 'finding' }], wires: [W('t.out', 'm.text'), W('m.found', 'f.when'), W('m.match', 'f.evidence')] }), ctx0).findings.map((x) => x.evidence);
  assert.deepEqual(pat('DOLLAR_RE', 'OOP - 150$', false), ['OOP - 150']);
  assert.deepEqual(pat('EXPLAIN_RE', 'fee Waived', true), ['Waived']);
  assert.deepEqual(pat('EXPLAIN_RE', 'not waived', true), []);
  const ch = (a, b) => run(compile({ v: 1, rule: 'x', nodes: [K('a', a), K('b', b), { id: 'c', type: 'chooseText', settings: { then1: 'one', then2: 'two', else: 'neither' } }, K('t', true), { id: 'f', type: 'finding' }],
    wires: [W('a.out', 'c.if1'), W('b.out', 'c.if2'), W('c.out', 'f.evidence'), W('t.out', 'f.when')] }), ctx0).findings[0].evidence;
  assert.deepEqual([ch(true, true), ch(false, true), ch(false, false)], ['one', 'two', 'neither']);
}

// Macros: Cart sum from primitives equals the native node (and the rules' cartSum) on every kind of line.
{
  const L = (sku, name, price, extra) => Object.assign({ sku, itemNumber: sku, name, price, quantity: 1, lineType: 'item' }, extra);
  const carts = [[], [L('SRV0006', 'Diagnostic deposit', -89)], [L('DIAG', 'Diagnostic fee', 89), L('SRV0006', 'Deposit', -89)], [L('SCR1', 'iPhone 13 screen', 159.99)],
    [L('PCEXEMPT', 'Partner Credit Tax Exempt', -15, { lineType: 'trade_credit' }), L('101516', 'Screen protector', 15)], [L('ML', 'Miscellaneous Labor', 50)], [L('BB12', 'Buyback iPhone', -100)],
    [L('X', 'Thing', 0.1), L('Y', 'Thing 2', 0.2), L('Z', 'Thing 3', 0.3)], [L('X', 'Discount', -5)], [L('X', 'Part', '12.50'), L('Y', 'Odd', null), L('Z', 'Nan', 'abc')], [null, L('A', 'Deposit hold', -20), L('B', 'Battery', 79)]];
  const g = { v: 1, rule: 'x', nodes: [{ id: 'l', type: 'linesIn' }, { id: 'native', type: 'cartSum' }, { id: 'macro', type: 'macro', settings: { macro: 'cartSum' } }, { id: 'eq', type: 'equals' }, { id: 'f', type: 'finding' }],
    wires: [W('l.out', 'native.lines'), W('l.out', 'macro.lines'), W('native.sum', 'eq.a'), W('macro.sum', 'eq.b'), W('eq.yes', 'f.when')] };
  const LINES = { linesIn: { title: 'Lines', cat: 'fact', desc: 'test lines', inputs: [], outputs: [{ name: 'out', type: 'lines' }], settings: [], eval: (io, s, ctx) => ({ out: ctx.lines(ctx.cart) }) } };
  const c = compile(g, lib(LINES));
  assert.deepEqual(c.errors, []);
  for (const items of carts) {
    const cart = { cartItems: items }, r = run(c, Object.assign(Object.create(R.GH), { cart }));
    assert.deepEqual(r.errors, []);
    assert.equal(r.trace['native.sum'], r.trace['macro.sum'], 'native vs macro: ' + JSON.stringify(items));
    assert.equal(r.trace['native.sum'], R.GH.cartSum(cart));
    assert.equal(r.findings.length, 1);
    assert.ok('macro/keep.out' in r.trace && 'macro/add.out' in r.trace && 'macro/out.sum' in r.trace, 'macro internals in the trace, under the macro node');
  }
  // A graph's own macro, nested in another, with an input and an output.
  const own = { v: 1, rule: 'x', nodes: [K('t', true), { id: 'm', type: 'macro', settings: { macro: 'twice' } }, { id: 'f', type: 'finding' }], wires: [W('t.out', 'm.x'), W('m.y', 'f.when')],
    macros: { twice: { inputs: [{ name: 'x', type: 'bool' }], outputs: [{ name: 'y', type: 'bool' }], nodes: [{ id: 'i', type: 'macroIn' }, { id: 'n', type: 'macro', settings: { macro: 'flip' } }, { id: 'n2', type: 'macro', settings: { macro: 'flip' } }, { id: 'o', type: 'macroOut' }],
      wires: [W('i.x', 'n.x'), W('n.y', 'n2.x'), W('n2.y', 'o.y')] },
    flip: { inputs: [{ name: 'x', type: 'bool' }], outputs: [{ name: 'y', type: 'bool' }], nodes: [{ id: 'i', type: 'macroIn' }, { id: 'no', type: 'not' }, { id: 'o', type: 'macroOut' }], wires: [W('i.x', 'no.in'), W('no.out', 'o.y')] } } };
  const r = run(compile(own), ctx0);
  assert.deepEqual(r.errors, []);
  assert.equal(r.findings.length, 1);
  assert.equal(r.trace['m/n/no.out'], false); assert.equal(r.trace['m/n2/no.out'], true);
  // The built-in macros validate on their own.
  for (const name of Object.keys(MACROS)) assert.deepEqual(validate({ v: 1, rule: 'x', nodes: [{ id: 'm', type: 'macro', settings: { macro: name } }] }), [], name);
}

// Validation: every class of error, as readable text.
{
  const base = () => ({ v: 1, rule: 'x', nodes: [K('t', true), { id: 'f', type: 'finding' }], wires: [W('t.out', 'f.when')] });
  const errs = (mut, l) => { const g = base(); mut(g); return validate(g, l).join(' | '); };
  assert.equal(errs(() => {}), '');
  assert.match(errs((g) => g.nodes.push({ id: 'z', type: 'frobnicate' })), /z: unknown node type "frobnicate"/);
  assert.match(errs((g) => g.nodes.push({ id: 'z', type: 'money' }, { id: 'n', type: 'not' }) && g.wires.push(W('z.out', 'n.in'))), /text does not fit bool/);
  assert.match(errs((g) => g.nodes.push({ id: 'n', type: 'not' })), /n \(not\): input in is not wired/);
  assert.match(errs((g) => g.nodes.push({ id: 'n', type: 'not' }, { id: 'n2', type: 'not' }) && g.wires.push(W('n.out', 'n2.in'), W('n2.out', 'n.in'))), /data wires make a loop/);
  assert.match(errs((g) => { g.nodes.push({ id: 's', type: 'start' }, { id: 'b', type: 'branch' }, { id: 'b2', type: 'branch' }); g.wires.push(W('t.out', 'b.cond'), W('t.out', 'b2.cond')); g.flow = [W('s.then', 'b.in'), W('b.yes', 'b2.in'), W('b2.yes', 'b.in')]; }), /exec wires make a loop/);
  assert.match(errs((g) => g.nodes.push({ id: 's', type: 'start' }, { id: 's2', type: 'start' })), /More than one start node \(2\)/);
  assert.match(errs((g) => g.nodes.push({ id: 'm', type: 'macro', settings: { macro: 'nope' } })), /m: unknown macro "nope"/);
  assert.match(errs((g) => g.nodes.push(K('t2', false)) && g.wires.push(W('t2.out', 'f.when'))), /Input f.when has more than one wire/);
  assert.match(errs((g) => { g.nodes.push({ id: 's', type: 'start' }, { id: 'b', type: 'branch' }, { id: 'b2', type: 'branch' }); g.wires.push(W('t.out', 'b.cond'), W('t.out', 'b2.cond')); g.flow = [W('s.then', 'b.in'), W('s.then', 'b2.in')]; }), /Exec output s.then has more than one wire/);
  assert.match(errs((g) => { g.wires = []; }), /f: a finding needs an exec wire in or its when input/);
  assert.match(errs((g) => g.wires.push(W('t.nope', 'f.evidence'))), /t has no output nope/);
  assert.match(errs((g) => g.wires.push(W('ghost.out', 'f.evidence'))), /unknown node/);
  assert.match(errs((g) => g.nodes.push({ id: 'a', type: 'and' })), /a \(and\): no input is wired/);
  assert.match(errs((g) => g.nodes.push({ id: 'p', type: 'matchesPattern', settings: { pattern: 'EVIL_RE' } })), /setting pattern must be one of/);
  assert.match(errs((g) => g.nodes.push({ id: 'p', type: 'template', settings: { text: 'Hi {name}' } })), /p \(template\): input name is not wired/);
  assert.match(errs((g) => g.nodes.push({ id: 'i', type: 'macroIn' })), /macroIn only goes inside a macro/);
  assert.match(errs((g) => { g.nodes.push({ id: 'm', type: 'macro', settings: { macro: 'a' } }); g.macros = { a: { inputs: [], outputs: [{ name: 'y', type: 'bool' }], nodes: [{ id: 'm', type: 'macro', settings: { macro: 'a' } }, { id: 'o', type: 'macroOut' }], wires: [W('m.y', 'o.y')] } }; }), /A macro uses itself/);
  assert.match(errs((g) => { g.nodes.push({ id: 'm', type: 'macro', settings: { macro: 'a' } }); g.macros = { a: { inputs: [], outputs: [], nodes: [{ id: 's', type: 'start' }] } }; }), /Macro a: s: macros have no exec nodes.*Macro a: needs exactly one macroOut/);
  assert.match(errs((g) => { g.v = 2; }), /Format v2 is not v1/);
  assert.match(errs((g) => { delete g.rule; }), /no rule id/);
  assert.ok(compile({ v: 1, nodes: [{ id: 'x', type: 'nope' }] }).errors.length, 'compile returns the errors instead of a graph');
  assert.deepEqual(run(compile({ v: 1, nodes: [{ id: 'x', type: 'nope' }] }), ctx0).findings, [], 'running an invalid graph raises nothing');
}

// Step limit and a throwing node: an error for that run, no findings, nothing thrown at the host.
{
  const g = { v: 1, rule: 'x', nodes: [K('t', false), { id: 'n1', type: 'not' }, { id: 'n2', type: 'not' }, { id: 'n3', type: 'not' }, { id: 'f', type: 'finding' }],
    wires: [W('t.out', 'n1.in'), W('n1.out', 'n2.in'), W('n2.out', 'n3.in'), W('n3.out', 'f.when')] };
  const c = compile(g);
  assert.equal(run(c, ctx0).findings.length, 1);
  const r = run(c, ctx0, { limit: 3 });
  assert.deepEqual(r.findings, []);
  assert.match(r.errors[0], /Step limit \(3\) reached/);
  const b = run(compile({ v: 1, rule: 'x', nodes: [{ id: 'bad', type: 'boom' }, { id: 'f', type: 'finding' }], wires: [W('bad.out', 'f.when')] }, lib(PROBE)), ctx0);
  assert.deepEqual(b.findings, []);
  assert.deepEqual(b.errors, ['bad (boom): kaboom']);
  const nopat = run(compile({ v: 1, rule: 'x', nodes: [{ id: 't', type: 'constant', settings: { type: 'text', value: '$5' } }, { id: 'm', type: 'matchesPattern', settings: { pattern: 'DOLLAR_RE' } }, { id: 'f', type: 'finding' }], wires: [W('t.out', 'm.text'), W('m.found', 'f.when')] }), {});
  assert.match(nopat.errors[0], /m \(matchesPattern\): no pattern DOLLAR_RE here/);
  // A throw inside a macro names the path to it.
  const inMacro = run(compile({ v: 1, rule: 'x', nodes: [{ id: 'm', type: 'macro', settings: { macro: 'k' } }, { id: 'f', type: 'finding' }], wires: [W('m.y', 'f.when')],
    macros: { k: { inputs: [], outputs: [{ name: 'y', type: 'bool' }], nodes: [{ id: 'bad', type: 'boom' }, { id: 'o', type: 'macroOut' }], wires: [W('bad.out', 'o.y')] } } }, lib(PROBE)), ctx0);
  assert.deepEqual(inMacro.errors, ['m/bad (boom): kaboom']);
}

// Debug runs (the editor's): every node evaluated, states, the exec path and wires taken, the outcome in words,
// what every finding would say, errors kept per node.
{
  const T = (id, value) => ({ id, type: 'constant', settings: { type: 'text', value } });
  const g = { v: 1, rule: 'r', check: 'cart', title: 'Default', nodes: [{ id: 'start', type: 'start' }, K('c', false), K('d', true), T('word', 'deposit'),
    { id: 'b', type: 'branch', label: 'Is OOP?' }, { id: 'skip', type: 'stop', label: 'Skip closed orders' }, { id: 'tp', type: 'template', settings: { text: 'Mentions {w}' } },
    { id: 'f', type: 'finding', settings: { title: 'Exec', kind: 'fail' } }, { id: 'n', type: 'not' }, { id: 'unused', type: 'not' }, { id: 'fd', type: 'finding', settings: { title: 'Data' } }],
  wires: [W('c.out', 'b.cond'), W('word.out', 'tp.w'), W('tp.out', 'f.evidence'), W('d.out', 'n.in'), W('n.out', 'fd.when'), W('c.out', 'unused.in')],
  flow: [W('start.then', 'b.in'), W('b.yes', 'f.in'), W('b.no', 'skip.in')] };
  const c = compile(g);
  assert.deepEqual(c.errors, []);
  const normal = run(c, ctx0), r = run(c, ctx0, { debug: true });
  assert.deepEqual(r.findings, normal.findings, 'same findings as a normal run');
  assert.deepEqual(r.path, normal.path);
  for (const k of Object.keys(normal.trace)) assert.deepEqual(r.trace[k], normal.trace[k], 'same values: ' + k);
  assert.deepEqual(r.path, ['start', 'b', 'skip']);
  assert.deepEqual(r.steps.map((x) => [x.i, x.node, x.pin]), [[0, 'start', 'then'], [1, 'b', 'no'], [2, 'skip', null]]);
  assert.ok(r.steps.every((x, i) => !i || x.at > r.steps[i - 1].at), 'at counts up');
  assert.deepEqual(r.execWires, [{ from: 'start.then', to: 'b.in', index: 0 }, { from: 'b.no', to: 'skip.in', index: 2 }]);
  const st = Object.fromEntries(Object.entries(r.nodes).map(([k, v]) => [k, v.state]));
  assert.deepEqual(st, { start: 'ran', c: 'used', b: 'ran', skip: 'ran', d: 'idle', word: 'idle', tp: 'idle', n: 'idle', unused: 'idle', f: 'notReached', fd: 'notReached' });
  assert.ok(r.nodes.c.order < r.nodes.b.order + 2 && r.nodes.b.order < r.nodes.c.order, 'b starts, then pulls c');
  assert.equal(r.trace['tp.out'], 'Mentions deposit', 'every wire has a value, even ones nothing needed');
  assert.equal(r.trace['unused.out'], true);
  assert.deepEqual(r.outcome, { ended: 'stop', node: 'skip', text: 'Stopped at "Skip closed orders"', raised: 0 });
  assert.deepEqual(r.results.f, { reached: false, raised: false, wouldRaise: true, check: 'cart', kind: 'fail', rule: 'r', title: 'Exec', sigBasis: [], evidence: 'Mentions deposit', who: R.GH.UNASSIGNED });
  assert.deepEqual([r.results.fd.reached, r.results.fd.raised, r.results.fd.wouldRaise, r.results.fd.title], [false, false, false, 'Data'], 'data finding after a stop: not checked');
  assert.equal(r.aborted, false); assert.deepEqual(r.errors, []);
  // Same graph, the other way: yes → finding (raised), then the flow ends; the data finding is checked.
  const c2 = compile(Object.assign({}, g, { nodes: g.nodes.map((n) => (n.id === 'c' ? K('c', true) : n)) }));
  const r2 = run(c2, ctx0, { debug: true });
  assert.deepEqual(r2.findings, run(c2, ctx0).findings);
  assert.deepEqual(r2.outcome, { ended: 'end', node: 'f', text: 'Flow finished', raised: 1 });
  assert.deepEqual([r2.results.f.reached, r2.results.f.raised], [true, true]);
  assert.deepEqual([r2.nodes.fd.state, r2.results.fd.reached, r2.results.fd.wouldRaise, r2.nodes.n.state, r2.nodes.d.state], ['ran', true, false, 'used', 'used']);
  assert.equal(r2.nodes.skip.state, 'notReached');
}
// No finding node at all; a branch with nothing wired after it; no flow at all.
{
  const g = { v: 1, rule: 'r', nodes: [{ id: 's', type: 'start' }, K('c', false), { id: 'b', type: 'branch', label: 'Is OOP?' }], wires: [W('c.out', 'b.cond')], flow: [W('s.then', 'b.in')] };
  const r = run(compile(g), ctx0, { debug: true });
  assert.deepEqual(r.outcome, { ended: 'branch', node: 'b', pin: 'no', text: 'Ended after "Is OOP?" → no', raised: 0 });
  assert.deepEqual(r.results, {}); assert.deepEqual(r.findings, []);
  const b = run(compile({ v: 1, rule: 'r', nodes: [{ id: 's', type: 'start' }, K('c', true), { id: 'b', type: 'branch' }], wires: [W('c.out', 'b.cond')], flow: [W('s.then', 'b.in')] }), ctx0, { debug: true });
  assert.equal(b.outcome.text, 'Ended after "Branch" → yes', 'no label: the node type\'s title');
  const d = run(compile({ v: 1, rule: 'r', nodes: [K('t', true), { id: 'f', type: 'finding' }], wires: [W('t.out', 'f.when')] }), ctx0, { debug: true });
  assert.deepEqual(d.outcome, { ended: 'end', text: 'No flow: findings checked on their own', raised: 1 });
  assert.deepEqual([d.nodes.f.state, d.nodes.t.state, d.results.f.raised], ['ran', 'used', true]);
  const e = run(compile({ v: 1, rule: 'r', nodes: [] }), ctx0, { debug: true });
  assert.deepEqual([e.outcome.ended, e.findings, e.results], ['end', [], {}], 'an empty graph');
  const bad = run(compile({ v: 1, nodes: [{ id: 'x', type: 'nope' }] }), ctx0, { debug: true });
  assert.equal(bad.outcome.ended, 'error'); assert.match(bad.outcome.text, /doesn't validate: x: unknown node type/);
  assert.match(validate({ v: 1, rule: 'r', nodes: [{ id: 'x', type: 'not', label: 5 }] }).join(), /x: label must be text/);
  assert.match(validate({ v: 1, rule: 'r', nodes: [{ id: 'x', type: 'stop', label: 'x'.repeat(81) }] }).join(), /80 characters/);
}
// A node that throws: kept on that node and on every node that needs it; the run goes on. Only errors a normal run
// would hit mark it aborted.
{
  const g = (used) => ({ v: 1, rule: 'r', nodes: [{ id: 's', type: 'start' }, { id: 'bad', type: 'boom' }, { id: 'n', type: 'not' }, K('t', true), { id: 'b', type: 'branch', label: 'Check' },
    { id: 'f', type: 'finding', settings: { title: 'F' } }, { id: 'n2', type: 'not' }],
  wires: [W('bad.out', 'n.in'), W((used ? 'n' : 't') + '.out', 'b.cond'), W('n.out', 'n2.in')], flow: [W('s.then', 'b.in'), W('b.yes', 'f.in')] });
  const idle = run(compile(g(false), lib(PROBE)), ctx0, { debug: true });
  assert.equal(idle.aborted, false, 'nothing the run needed failed');
  assert.deepEqual(idle.findings.map((x) => x.title), ['F']);
  assert.deepEqual(run(compile(g(false), lib(PROBE)), ctx0).findings.map((x) => x.title), ['F'], 'and a normal run agrees');
  assert.deepEqual([idle.nodes.bad.state, idle.nodes.bad.error, idle.nodes.n.state, idle.nodes.n.error, idle.nodes.n2.error], ['error', 'kaboom', 'error', 'needs bad, which failed', 'needs n, which failed']);
  assert.deepEqual(idle.errors, ['bad (boom): kaboom', 'n (not): needs bad, which failed', 'n2 (not): needs n, which failed']);
  const used = run(compile(g(true), lib(PROBE)), ctx0, { debug: true });
  assert.equal(used.aborted, true); assert.deepEqual(run(compile(g(true), lib(PROBE)), ctx0).errors, ['bad (boom): kaboom'], 'a normal run stops there');
  assert.deepEqual(used.outcome, { ended: 'error', node: 'b', text: 'Ended with an error at "Check": needs n, which failed', raised: 0 });
  assert.deepEqual(used.steps.map((x) => [x.node, x.pin, x.error || null]), [['s', 'then', null], ['b', null, 'needs n, which failed']]);
  assert.deepEqual([used.nodes.f.state, used.results.f.reached, used.results.f.wouldRaise], ['notReached', false, true]);
  // A finding whose evidence fails: an error on it, the flow goes on past it.
  const fe = run(compile({ v: 1, rule: 'r', nodes: [{ id: 's', type: 'start' }, { id: 'bad', type: 'boom' }, { id: 'tp', type: 'template', settings: { text: '{x}' } }, { id: 'f', type: 'finding' }, { id: 'f2', type: 'finding', settings: { title: 'After' } }],
    wires: [W('bad.out', 'tp.x'), W('tp.out', 'f.evidence')], flow: [W('s.then', 'f.in'), W('f.then', 'f2.in')] }, lib(PROBE)), ctx0, { debug: true });
  assert.deepEqual(fe.findings.map((x) => x.title), ['After']);
  assert.deepEqual([fe.nodes.f.state, fe.results.f.error, fe.results.f.raised, fe.aborted, fe.outcome.ended], ['error', 'needs tp, which failed', false, true, 'end']);
  // The step limit still ends it all.
  const lim = run(compile({ v: 1, rule: 'r', nodes: [K('t', false), { id: 'a', type: 'not' }, { id: 'b2', type: 'not' }, { id: 'f', type: 'finding' }], wires: [W('t.out', 'a.in'), W('a.out', 'b2.in'), W('b2.out', 'f.when')] }), ctx0, { debug: true, limit: 2 });
  assert.equal(lim.aborted, true); assert.match(lim.outcome.text, /Step limit \(2\)/);
}
// Macros: their insides are in nodes / trace as macroNodeId/innerId, idle ones too.
{
  const g = { v: 1, rule: 'r', nodes: [{ id: 's', type: 'start' }, { id: 'scope', type: 'macro', settings: { macro: 'checked' } }, { id: 'b', type: 'branch' }, { id: 'f', type: 'finding' },
    { id: 'm2', type: 'macro', settings: { macro: 'cartSum' } }, { id: 'wo', type: 'wo' }], wires: [W('scope.yes', 'b.cond'), W('wo.cart', 'm2.lines')], flow: [W('s.then', 'b.in'), W('b.yes', 'f.in')] };
  const ctx = Object.assign(Object.create(R.GH), { f: R.facts({ workorderId: 1, workorderStatusName: 'Ready for work', programId: 20001 }, { wo: { workorderId: 1 }, notes: [], cart: { cartItems: [{ sku: 'A', name: 'Part', price: 5 }] } }), opts: {} });
  const r = run(compile(g), ctx, { debug: true });
  assert.deepEqual(r.findings, run(compile(g), ctx).findings);
  assert.equal(r.nodes['scope/out'].state, 'used'); assert.equal(r.nodes['scope/wo'].state, 'used');
  assert.equal(r.nodes.m2.state, 'idle'); assert.equal(r.nodes['m2/add'].state, 'idle'); assert.equal(r.trace['m2/add.out'], 5);
  assert.ok(Object.keys(r.nodes).filter((k) => k.startsWith('scope/')).length === MACROS.checked.nodes.length, 'every node inside the macro');
}
// Notes the host doesn't have (customer details off): flagged on the nodes that read them, and on the run when one
// that ran or was used does.
{
  const g = (pin) => ({ v: 1, rule: 'r', nodes: [{ id: 'wo', type: 'wo' }, { id: 'in', type: 'intakeNote' }, { id: 'f', type: 'finding' }], wires: [W('wo.' + pin, 'f.when')] });
  const noNotes = Object.assign(Object.create(R.GH), { f: R.facts({ workorderId: 1, workorderStatusName: 'Ready for work' }, { wo: { workorderId: 1 }, notes: null }), opts: {} });
  const withNotes = Object.assign(Object.create(R.GH), { f: R.facts({ workorderId: 1, workorderStatusName: 'Ready for work' }, { wo: { workorderId: 1 }, notes: [] }), opts: {} });
  let r = run(compile(g('hasNotes')), noNotes, { debug: true });
  assert.equal(r.needsNotes, true); assert.deepEqual(r.nodes.wo.needsNotes, ['notes', 'manualNotes', 'noteText', 'hasNotes']); assert.equal(r.nodes.in.needsNotes, true);
  r = run(compile(g('isActive')), noNotes, { debug: true });
  assert.equal(r.needsNotes, false, 'the Work order node read only for its status: fine'); assert.equal(r.nodes.in.state, 'idle');
  assert.equal(run(compile(g('hasNotes')), withNotes, { debug: true }).needsNotes, false, 'notes there');
  assert.ok(!('needsNotes' in run(compile(g('hasNotes')), withNotes, { debug: true }).nodes.wo));
}

// Node library: every type has a title, a category, a description, and pins of known types.
for (const [type, d] of Object.entries(NODE_TYPES)) {
  assert.ok(d.title && d.desc && ['fact', 'check', 'logic', 'text', 'num', 'people', 'assize', 'out'].includes(d.cat), type);
  const pins = RG.pinsOf({ id: 'x', type, settings: {} }, null, { inputs: [], outputs: [] });
  for (const x of [...pins.inputs, ...pins.outputs]) assert.ok(RG.TYPES.includes(x.type), type + '.' + x.name);
  assert.ok(typeof (d.exec ? d.run : d.eval) === 'function', type);
}

// ------------------------------------------------------------------ parity: graphs vs the code rules
assert.deepEqual(R.graphs.skipped, [], 'every built-in graph validates');
assert.deepEqual(R.graphs.rules.map((c) => c.rule).sort(), ['cci-not-15', 'cci-zero-cart', 'no-intake-note', 'oop-zero-cart', 'short-intake-note']);
const RULES = R.graphs.rules.map((c) => c.rule);
const exec = Object.values(GRAPHS).filter((g) => (g.flow || []).length).length, pure = Object.values(GRAPHS).length - exec;
assert.ok(exec >= 1 && pure >= 1, 'both styles are used');

const NOW = Date.parse('2026-10-21T15:00:00Z');
const seenRules = new Set();
const tally = { orders: 0, comparisons: 0, debug: 0, raised: {}, evidence: {} };
const pick = (x) => ({ rule: x.rule, check: x.check, kind: x.kind, title: x.title, evidence: x.evidence, who: x.who.key, sig: x.sig });
function compare(row, detail, label) {
  const opts = { now: NOW, hours: R.STORE_HOURS, priceFor: () => null };
  const code = R.audit(row, detail, opts);
  assert.deepEqual(bundled.audit(row, detail, opts), code, label + ': the bundle and the module agree');
  for (const x of code) seenRules.add(x.rule);
  const f = R.facts(row, detail);
  const ctx = Object.assign(Object.create(R.GH), { f, opts });
  tally.orders++;
  for (const c of R.graphs.rules) {
    const r = run(c, ctx);
    assert.deepEqual(r.errors, [], label + ' ' + c.rule);
    if (tally.comparisons % 37 === 0) {
      const d = run(c, ctx, { debug: true });
      assert.deepEqual([d.findings, d.path, d.aborted, d.errors], [r.findings, r.path, false, []], label + ' ' + c.rule + ': debug = normal');
      for (const k of Object.keys(r.trace)) assert.deepEqual(d.trace[k], r.trace[k], label + ' ' + c.rule + ' ' + k);
      for (const [id, x] of Object.entries(d.results)) assert.equal(x.raised, d.findings.length > 0 && x.reached && x.wouldRaise, label + ' ' + id);
      tally.debug++;
    }
    const graph = r.findings.map((x) => pick(Object.assign({}, x, { who: x.who || R.GH.UNASSIGNED, sig: R.sigOf(...x.sigBasis) })));
    const mine = code.filter((x) => x.rule === c.rule).map(pick);
    assert.deepEqual(graph, mine, label + ' ' + c.rule);
    tally.comparisons++;
    for (const x of mine) { tally.raised[x.rule] = (tally.raised[x.rule] || 0) + 1; tally.evidence[x.rule + ': ' + x.evidence.replace(/\$[\d.]+/, '$N').replace(/mentions \w+/, 'mentions W')] = 1; }
  }
  const sh = R.shadow(row, detail, opts, code);
  assert.deepEqual([sh.mismatches, sh.errors, sh.compared], [[], [], RULES.length], label + ' shadow()');
}

// Synthetic orders: programs × statuses × outcomes × carts × notes.
const user = (id, g, f) => ({ userId: id, givenName: g, familyName: f });
const JO = user(11, 'Jo', 'Diaz'), AL = user(12, 'Al', 'Moore');
const note = (text, o = {}) => Object.assign({ noteType: 2, noteTag: 'note', noteText: text, createdAt: '2026-10-20T15:00:00Z', UserDatum: AL }, o);
const intake = (text, o = {}) => note(text, Object.assign({ noteTag: 'initial_checkin', createdAt: '2026-10-20T14:00:00Z', UserDatum: JO }, o));
const LONG = 'iPhone 13\nCracked screen, replacing\nCustomer wants it today\n• **Physical damage:** No issues';
const NOTES = {
  unfetched: undefined, none: [], long: [intake(LONG)], short: [intake('Cracked screen\n\nreplace it')], checklistOnly: [intake('• **Physical damage:** No issues\n**Passcode:** given\n* **Power:** on\nok')],
  twoPlusChecklist: [intake('Line one\r\nLine two\n- **Water:** none\n**Accessories:** case')], noText: [intake(null)], systemIntake: [intake(LONG, { noteType: 1 })],
  noAuthor: [intake('a\nb', { UserDatum: null })], deposit: [intake(LONG), note('Customer paid the Deposit up front')], negated: [intake(LONG), note('no deposit taken, no refund')],
  waived: [intake('fee waived\nb')], dollars: [intake(LONG), note('OOP - 150$ quoted')], dollarsSign: [intake('$89 diag\nb\nc')], both: [intake(LONG), note('$89 paid as deposit')],
  laterOnly: [note('just a note'), note('quoted 120 for screen')], gspn: [intake(LONG), note('GSPN claim, checkout complete')],
};
const L = (sku, name, price, extra) => Object.assign({ lineId: sku + price, sku, itemNumber: sku, name, price, quantity: 1, lineType: 'item' }, extra);
const CARTS = {
  noKey: undefined, nullCart: null, empty: { cartItems: [] }, depositOnly: { cartItems: [L('SRV0006', 'Diagnostic Deposit', -89)] },
  diagDeposit: { cartItems: [L('DIAG1', 'Diagnostic', 89), L('SRV0006', 'Deposit', -89)] }, priced: { cartItems: [L('SCR', 'iPhone 13 Screen', 159.99)] },
  credit: { cartItems: [L('101516', 'Screen protector', 15), L('PCEXEMPT', 'Partner Credit Tax Exempt', -15, { lineType: 'trade_credit', parentLineId: 'x' })] },
  miscLabor: { cartItems: [L('ML1', 'Miscellaneous Labor', 40)] }, buyback: { cartItems: [L('BB100', 'Buyback', -120)] }, fifteen: { cartItems: [L('CCI15', 'CCI service', 15)] },
  fifteen01: { cartItems: [L('CCI15', 'CCI service', 15.01)] }, nearFifteen: { cartItems: [L('A', 'Part', 14.995)] }, twenty: { cartItems: [L('CCI20', 'CCI service', 20)] },
  tiny: { cartItems: [L('A', 'Part', 0.005)] }, negative: { cartItems: [L('DISC', 'Discount', -5)] }, cents: { cartItems: [L('A', 'Part', 7.5), L('B', 'Part', 7.5), L('C', 'Labor', 0.25)] },
  stringPrice: { cartItems: [L('A', 'Part', '15'), null, L('B', 'Odd', 'n/a')] },
};
const PROGRAMS = [[20001, 'Out Of Warranty'], [null, 'OOP Xbox repair'], [7001, 'Consumer Cellular'], [7002, 'CCI Repairs'], [5062, 'Asurion Mobility'], [9470, 'VZ Sanitization'], [6494, 'Samsung In Warranty Repair'], [999, 'Mystery Partner']];
const STATUSES = [[8, 'Ready for work'], [10, 'Work in progress'], [13, 'Ready for pickup'], [13, ''], [99, 'Ready for pickup'], [3, 'Awaiting item'], [25, 'Cancelled'], [12, 'Repair summary'], [14, 'Sale complete'],
  [5, 'Awaiting diagnostics'], [6, 'Awaiting partner approval'], [2, 'Need to order'], [7, 'Awaiting callback']];
const OUTCOMES = [['', ''], ['Completed', ''], ['Incomplete', ''], ['Declined', ''], ['', 'incomplete'], ['', 'Incomplete'], ['No issue found', '']];
let n = 0;
// Outcomes only matter at Ready for pickup (the cart's Incomplete skip); elsewhere two are enough.
const rfpLike = (sid, sname) => sid === 13 || /ready for pickup/i.test(sname);
for (const [pid, pname] of PROGRAMS) for (const [sid, sname] of STATUSES) for (const [attr, listOutcome] of (rfpLike(sid, sname) ? OUTCOMES : OUTCOMES.slice(1, 3))) for (const [ck, cart] of Object.entries(CARTS)) for (const [nk, notes] of Object.entries(NOTES)) {
  const id = 800000 + (++n);
  const row = { workorderId: id, workorderStatusId: sid, workorderStatusName: sname, programId: pid, programName: pname, createdAt: '2026-10-20T14:00:00Z', updatedAt: '2026-10-20T16:00:00Z',
    deviceCatalog: { name: 'iPhone 13' }, customerDevice: { name: 'IPHONE 13 10/22' }, locationBin: 'A1', serviceOutcome: listOutcome, createdBy: n % 3 ? { givenName: 'Cy', familyName: 'Row' } : null, deviceIssues: ['Screen'] };
  let detail = null;
  if (notes !== undefined) {
    detail = { wo: { workorderId: id, workorderStatusId: sid, WorkorderStatus: { name: sname }, programId: pid, Program: { name: pname }, WorkorderAttributes: attr ? [{ workorderAttributeTypeId: 22, value: attr }] : [] },
      notes: notes.map((x) => Object.assign({}, x)), audit: [] };
    if (cart !== undefined) detail.cart = cart;
  } else if (ck !== 'noKey') continue; // no detail: one combination is enough
  compare(row, detail, 'synthetic ' + [pname, sname || '#' + sid, attr || listOutcome, ck, nk].join(' / '));
}
// Odd ones: no id at all; only the detail (no list row); a row-only order.
compare({}, null, 'empty row');
compare(null, { wo: { workorderStatusId: 10, WorkorderStatus: { name: 'Work in progress' }, programId: 20001, Program: { name: 'Out Of Warranty' } }, notes: [], cart: { cartItems: [] } }, 'detail without an id');
compare(null, { wo: { workorderId: 5, workorderStatusId: 13, WorkorderStatus: { name: 'Ready for pickup' }, programName: 'x', Program: { name: 'Consumer Cellular' } }, notes: NOTES.short, cart: CARTS.twenty }, 'detail only');
const synthetic = tally.orders;

// The sandbox's orders (sandbox/state.json, git-ignored: from this checkout or the main one), shaped as sandbox/api.py serves them.
let sandbox = 0;
const stateFile = [ROOT + 'sandbox/state.json', (() => { try { return execSync('git rev-parse --path-format=absolute --git-common-dir', { cwd: ROOT }).toString().trim().replace(/\.git$/, '') + 'sandbox/state.json'; } catch (_) { return ''; } })()].find((p) => p && existsSync(p));
if (stateFile) {
  const S = JSON.parse(readFileSync(stateFile, 'utf8'));
  const SP = { 6494: 'Samsung In Warranty Repair', 8849: 'Asurion Home+ Repairs', 5062: 'Asurion Mobility', 11759: 'VZ Device Refresh', 9470: 'VZ Sanitization', 11009: 'AT&T Enhanced Cleaning', 9901: 'AT&T Device Diagnostic', 10303: 'AT&T Performance Check', 20001: 'Out Of Warranty' };
  const SS = { 1: 'Initial check-in', 2: 'Need to order', 3: 'Awaiting item', 4: 'Awaiting device', 7: 'Awaiting callback', 8: 'Ready for work', 9: 'Diagnostics', 10: 'Work in progress', 11: 'Quality check', 12: 'Repair summary', 13: 'Ready for pickup', 14: 'Sale complete', 25: 'Cancelled' };
  for (const w of Object.values(S.wos)) {
    const d = S.devices[String(w.customerDeviceId)] || {}, items = ((S.carts[w.csuCartId] || {}).items || []).map((x) => Object.assign({}, x));
    const status = SS[w.workorderStatusId] || 'Ready for work', program = w.programName || SP[w.programId] || 'Program', by = w.by || { givenName: 'Sandbox', familyName: 'Tech' };
    const row = { workorderId: w.workorderId, workorderStatusId: w.workorderStatusId, workorderStatusName: status, programId: w.programId, programName: program, createdAt: w.createdAt, updatedAt: w.updatedAt,
      nextUpdate: w.nextUpdate, deviceCatalog: { name: d.deviceName }, customerDevice: { name: d.name || '' }, deviceIssues: w.issues || ['Screen'], serviceOutcome: w.serviceOutcome || '',
      locationBin: w.binLocation || '', rfpWorkorderStatusDate: w.rfpAt || null, createdBy: { givenName: by.givenName, familyName: by.familyName } };
    const detail = {
      wo: { workorderId: w.workorderId, workorderStatusId: w.workorderStatusId, WorkorderStatus: { name: status }, programId: w.programId, Program: { name: program }, createdAt: w.createdAt, updatedAt: w.updatedAt,
        nextUpdate: w.nextUpdate, CustomerDevice: { name: d.name || '', DeviceCatalog: { name: d.deviceName || '', DeviceModel: { DeviceType: { name: d.deviceType || 'Cell Phone' }, DeviceFamily: { name: d.deviceFamily || '' } } } },
        WorkorderAttributes: w.outcome ? [{ workorderAttributeTypeId: 22, value: w.outcome }] : [] },
      notes: S.notes.filter((x) => String(x.workorderId) === String(w.workorderId)), audit: (w.history || []).map((x) => ({ workorderStatusId: x.statusId, createdAt: x.at, createdBy: x.by })),
      cart: { cartItems: items, payment: null },
    };
    compare(row, detail, 'sandbox ' + w.workorderId);
    compare(row, null, 'sandbox row only ' + w.workorderId);
    sandbox++;
  }
}

// The catalog: every rule id the code can raise (each rule literal in audit() / orphanCleanings()), and every one
// the corpus raised, is listed once, with a check Assize has.
{
  const ids = R.catalog.map((x) => x.rule), src = AR.makeRules.toString();
  assert.equal(new Set(ids).size, ids.length, 'no rule listed twice');
  const body = src.slice(src.indexOf('function audit('), src.indexOf('const plural ='));
  const literals = new Set([...body.matchAll(/'([a-z0-9]+(?:-[a-z0-9]+)+)'/g)].map((m) => m[1]));
  for (const id of ids) assert.ok(body.includes("'" + id + "'"), 'listed but not in the code: ' + id);
  assert.deepEqual([...literals].filter((x) => !ids.includes(x)), ['priced-in-notes'], 'a kebab-case literal in the rules that is not listed (only a signature value may be)');
  for (const r of seenRules) assert.ok(ids.includes(r), 'raised but not listed: ' + r);
  for (const x of R.catalog) assert.ok(R.CHECKS.some(([k]) => k === x.check) && R.KINDS.includes(x.kind) && x.title, x.rule);
  assert.deepEqual(R.catalog.filter((x) => x.builtInGraph).map((x) => x.rule).sort(), Object.keys(GRAPHS).sort());
  assert.deepEqual(R.catalog.filter((x) => !x.perOrder).map((x) => x.rule), ['parent-closed-cleaning-open']);
}

// Every rule was raised, and every OOP evidence variant seen.
for (const rule of RULES) assert.ok(tally.raised[rule] > 0, rule + ' raised at least once');
const oopVariants = Object.keys(tally.evidence).filter((k) => k.startsWith('oop-zero-cart'));
assert.equal(oopVariants.length, 3, 'all three OOP evidence variants: ' + oopVariants.join(' | '));
console.log('rulegraph: interpreter ok; parity ' + tally.orders + ' orders (' + synthetic + ' synthetic, ' + sandbox + ' sandbox × 2) × ' + RULES.length + ' rules = ' + tally.comparisons + ' comparisons, all equal (' + tally.debug + ' debug runs too); raised: ' + JSON.stringify(tally.raised));
