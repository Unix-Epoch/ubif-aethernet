/*
  Rule graphs (format v1): an audit rule drawn as nodes and wires, Blueprint style (Unreal Engine), instead of
  code. Shared by Aethernet (inlined into Assize by build.py) and, later, the Worker and the admin editor. No
  dependencies, no DOM, no GM: everything about the order comes from the context the host passes to run().

  A graph:
    { v: 1, rule: 'oop-zero-cart', check: 'cart', title: 'OOP, $0 cart',
      nodes:  [{ id: 'n1', type: 'wo', x: 30, y: 360, settings: {...} }, ...]
      wires:  [{ from: 'n1.program', to: 'n2.key' }, ...]      data wires: output pin → input pin, typed
      flow:   [{ from: 'start.then', to: 'b1.in' }, ...]       exec wires (Blueprint's white wires), optional
      macros: { name: { title, inputs: [{name, type}], outputs: [{name, type}], nodes, wires } }   optional }
    x / y (and an optional label, the node's own name) are the editor's only. rule / check / title are the
    defaults for the graph's finding nodes.

  How it runs (one order = one run):
    · Pure nodes (no exec pins) are evaluated lazily, when something downstream asks for one of their outputs,
      and once per run (memoized). An input a node never reads is never computed (and / or / chooseText stop early).
    · Executed nodes have exec pins: start (the entry, one per graph) → branch (follows yes or no on its cond) →
      finding / reminder (raise, then continue) → stop (ends the run: nothing after it, no data-driven findings).
      An exec output takes one wire; an exec input takes any number.
    · A finding with an exec wire in raises when execution reaches it (and its `when`, if wired, is true). One
      with no exec wire in is data-driven: it raises after the flow ends (or at once when there is no flow) iff its
      `when` is true. A graph can be all data, all exec, or both.
    · A macro node (settings.macro) runs a sub-graph from graph.macros or the built-in MACROS: a macroIn node
      inside gives the macro's inputs, a macroOut node takes its outputs. Macros are pure (no exec pins inside).
      The editor shows them collapsed, with an expand affordance.
    · Types: bool num text lines (cart lines) notes textList person (blame) any. `any` wires to anything.
    · Safety: no eval, no user regex (word lists are escaped and matched on word boundaries, case-insensitive;
      named patterns come from the host's context by name), a step limit (STEP_LIMIT node evaluations a run),
      and every node's evaluation is caught: a throw ends that run with an error and no findings, never the host.

  run(compiled, ctx, { trace, limit }) → { findings: [{ check, kind, rule, sigBasis, title, evidence, who }],
    errors: [...], trace: { 'nodeId.pin': value, 'macroNodeId/innerId.pin': value }, path: [executed node ids] }
  run(compiled, ctx, { debug: true }) is the editor's: every node evaluated, errors kept per node (see debugRun).
  sigBasis is what the host hashes into the dismissal signature (Assize: sigOf(...sigBasis)), so it must list the
  same facts, in the same order, as the code rule it stands for.

  ctx (Assize): f (facts()), opts, and the rules engine's own helpers and constants (lines, price, cartSum,
  cartSig, money, mentions, intakeNote, intakeAuthor, programOf, deviceOf, isCredit, neverFlag, isDeposit, MANUAL,
  CHECKLIST_LINE, UNASSIGNED, the *_RE patterns...), so each fact has one implementation, the code's.
*/
export const FORMAT = 1;
export const STEP_LIMIT = 2000;
export const TYPES = ['bool', 'num', 'text', 'lines', 'notes', 'textList', 'person', 'any'];
export const KINDS = ['fail', 'flag', 'note', 'remind'];
// Named patterns a matchesPattern node may use; the host's context supplies the RegExp itself.
export const PATTERN_NAMES = ['DOLLAR_RE', 'LIQUID_RE', 'DATA_RE', 'AGREE_RE', 'CONTACT_RE', 'EXPLAIN_RE', 'OVERRIDE_RE'];

const p = (name, type, req) => (req ? { name, type, req: true } : { name, type });
const opt = (name, type, extra) => Object.assign({ name, type }, extra);
const LETTERS = ['a', 'b', 'c', 'd', 'e', 'f'];
// "Now" is the run's own (ctx.opts.now: tests and debug runs fix it), else the clock. A missing time reads as NEVER hours ago.
const nowOf = (ctx) => Number(ctx.opts && ctx.opts.now) || Date.now();
const NEVER = 1e6;
const hoursSince = (ctx, at) => (at > 0 ? Math.max(0, (nowOf(ctx) - at) / 3600000) : NEVER);
const str = (v) => (v == null ? '' : String(v));
const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A word / phrase list as one case-insensitive RegExp, matched on word boundaries (no user regex).
function wordsRe(words) {
  const ws = (words || []).map((w) => str(w).trim()).filter(Boolean);
  return ws.length ? new RegExp('(?<!\\w)(?:' + ws.map(esc).join('|') + ')(?!\\w)', 'i') : null;
}
const inList = (v, list, mode) => {
  const x = str(v).toLowerCase();
  return list.some((w) => { const y = str(w).toLowerCase(); return mode === 'contains' ? x.includes(y) : x === y; });
};
const NOTE_KINDS = ['manual', 'any', 'system']; // Last / first / filter notes: which notes count
const TRI = ['any', 'keep', 'drop']; // filterLines' flags: ignore, keep only these lines, drop these lines
const tri = (mode, hit) => mode === 'keep' ? hit : mode === 'drop' ? !hit : true;
const placeholders = (t) => [...new Set([...str(t).matchAll(/\{(\w+)\}/g)].map((m) => m[1]))];
const raise = (io, s, ctx, g) => ({
  check: s.check || g.check || '', kind: s.kind || 'note', rule: s.rule || g.rule || '', title: s.title || g.title || '',
  sigBasis: ['sig1', 'sig2', 'sig3'].filter((k) => io.wired(k)).map((k) => io.in(k)),
  evidence: io.wired('evidence') ? str(io.in('evidence')) : str(s.evidence),
  who: (io.wired('who') ? io.in('who') : null) || ctx.UNASSIGNED || null,
});
const FINDING_IN = [p('when', 'bool'), p('evidence', 'text'), p('who', 'person'), p('sig1', 'any'), p('sig2', 'any'), p('sig3', 'any')];
const FINDING_SET = [opt('title', 'text'), opt('check', 'text'), opt('rule', 'text'), opt('evidence', 'text', { desc: 'used when the evidence pin is not wired' })];

/*
  The node library. Each type: title (the editor's), cat (fact check logic text num people assize out), desc, inputs /
  outputs (lists, or functions of the node's settings), settings (the editor's form: name, type text|num|bool|list|
  enum|pattern|macro, options, def), exec ({ in, outs }) for executed nodes, and eval(io, settings, ctx) → outputs
  (pure nodes) or run(io, settings, ctx, state) → the exec output to follow (executed nodes). notes: the node reads
  the order's notes (true, or the outputs that come from them), which a debug run flags when the host has none.
  io.in(pin) evaluates what is wired to an input (lazily), io.wired(pin) says whether anything is.
*/
export const NODE_TYPES = {
  // ---------------------------------------------------------------- facts
  wo: {
    title: 'Work order', cat: 'fact', desc: "The order's facts: program, status, outcome, device, cart, notes.",
    inputs: [], settings: [],
    outputs: [p('id', 'text'), p('program', 'text'), p('programKey', 'text'), p('status', 'text'), p('statusId', 'num'), p('outcome', 'text'),
      p('isRfp', 'bool'), p('isActive', 'bool'), p('device', 'text'), p('cart', 'lines'), p('hasCart', 'bool'), p('notes', 'notes'),
      p('manualNotes', 'notes'), p('noteText', 'text'), p('hasNotes', 'bool')],
    notes: ['notes', 'manualNotes', 'noteText', 'hasNotes'],
    eval(io, s, ctx) {
      const f = ctx.f, manual = (f.notes || []).filter((n) => Number(n.noteType) === ctx.MANUAL);
      // Ready for pickup by name or by id (13), as the rules decide it; everything else open is Active.
      const rfp = str(f.status).toLowerCase() === 'ready for pickup' || f.statusId === 13;
      return {
        id: str(f.id), program: str(f.programName), programKey: ctx.programOf(f.programId, f.programName).key, status: str(f.status), statusId: f.statusId,
        outcome: str(f.outcome), isRfp: rfp, isActive: !rfp, device: str(f.device), cart: ctx.lines(f.cart), hasCart: !!f.hasCart, notes: f.notes,
        manualNotes: manual, noteText: manual.map((n) => String(n.noteText || '')).join('\n'), hasNotes: !!f.notes,
      };
    },
  },
  orderDates: {
    title: 'Order dates', cat: 'fact', desc: 'When the order was created, last updated, is due its next update and went Ready for pickup (ms; 0 when unknown), plus its bin, nickname, issues and device type.',
    inputs: [], settings: [],
    outputs: [p('createdAt', 'num'), p('updatedAt', 'num'), p('nextUpdate', 'num'), p('rfpAt', 'num'), p('bin', 'text'), p('nickname', 'text'), p('issues', 'textList'), p('deviceType', 'text')],
    eval(io, s, ctx) {
      const f = ctx.f;
      return { createdAt: f.createdAt || 0, updatedAt: f.updatedAt || 0, nextUpdate: f.nextUpdate || 0, rfpAt: f.rfpAt || 0, bin: str(f.bin), nickname: str(f.nickname), issues: (f.issues || []).map(str), deviceType: str(f.deviceType) };
    },
  },
  deviceIs: {
    title: 'Device is', cat: 'fact', desc: 'The device is a phone, a foldable, a wearable or a TV (catalog type first, then the name).',
    inputs: [], outputs: [p('yes', 'bool')], settings: [opt('kind', 'enum', { options: ['phone', 'foldable', 'wearable', 'tv'], def: 'phone' })],
    eval: (io, s, ctx) => ({ yes: !!ctx.deviceOf(ctx.f)[s.kind || 'phone'] }),
  },
  // ---------------------------------------------------------------- checks
  programIs: {
    title: 'Program is', cat: 'check', desc: 'The program key (oop, cci, asurion, servify, samsungIW, google, amazon, vzew, element, cleaning, unknown) is one of these.',
    inputs: [p('key', 'text', true)], outputs: [p('yes', 'bool')], settings: [opt('programs', 'list', { def: [] })],
    eval: (io, s) => ({ yes: (s.programs || []).includes(str(io.in('key'))) }),
  },
  statusIs: {
    title: 'Status is', cat: 'check', desc: 'The status is one of these (none listed: any) and the outcome one of those (none listed: any). Case-insensitive, whole name or contains.',
    inputs: (s) => [p('status', 'text', !!(s.statuses || []).length), p('outcome', 'text', !!(s.outcomes || []).length)], outputs: [p('yes', 'bool')],
    settings: [opt('statuses', 'list', { def: [] }), opt('outcomes', 'list', { def: [] }), opt('match', 'enum', { options: ['exact', 'contains'], def: 'exact' })],
    eval(io, s) {
      const sts = s.statuses || [], outs = s.outcomes || [], m = s.match || 'exact';
      return { yes: (!sts.length || inList(io.in('status'), sts, m)) && (!outs.length || inList(io.in('outcome'), outs, m)) };
    },
  },
  // ---------------------------------------------------------------- logic (unwired inputs are ignored; at least one must be wired)
  and: {
    title: 'And', cat: 'logic', desc: 'True when every wired input is true (stops at the first false).',
    inputs: LETTERS.map((k) => p(k, 'bool')), outputs: [p('out', 'bool')], settings: [],
    eval(io) { for (const k of LETTERS) if (io.wired(k) && !io.in(k)) return { out: false }; return { out: true }; },
  },
  or: {
    title: 'Or', cat: 'logic', desc: 'True when any wired input is true (stops at the first true).',
    inputs: LETTERS.map((k) => p(k, 'bool')), outputs: [p('out', 'bool')], settings: [],
    eval(io) { for (const k of LETTERS) if (io.wired(k) && io.in(k)) return { out: true }; return { out: false }; },
  },
  not: { title: 'Not', cat: 'logic', desc: 'The opposite.', inputs: [p('in', 'bool', true)], outputs: [p('out', 'bool')], settings: [], eval: (io) => ({ out: !io.in('in') }) },
  // ---------------------------------------------------------------- numbers (an unwired limit / b / min / max uses the setting)
  atMost: {
    title: 'At most', cat: 'num', desc: 'value ≤ limit.', inputs: [p('value', 'num', true), p('limit', 'num')], outputs: [p('yes', 'bool')], settings: [opt('limit', 'num', { def: 0 })],
    eval: (io, s) => ({ yes: io.in('value') <= num(io, s, 'limit') }),
  },
  atLeast: {
    title: 'At least', cat: 'num', desc: 'value ≥ limit.', inputs: [p('value', 'num', true), p('limit', 'num')], outputs: [p('yes', 'bool')], settings: [opt('limit', 'num', { def: 0 })],
    eval: (io, s) => ({ yes: io.in('value') >= num(io, s, 'limit') }),
  },
  between: {
    title: 'Between', cat: 'num', desc: 'min ≤ value ≤ max.', inputs: [p('value', 'num', true), p('min', 'num'), p('max', 'num')], outputs: [p('yes', 'bool')],
    settings: [opt('min', 'num', { def: 0 }), opt('max', 'num', { def: 0 })],
    eval(io, s) { const v = io.in('value'); return { yes: v >= num(io, s, 'min') && v <= num(io, s, 'max') }; },
  },
  equals: {
    title: 'Equals', cat: 'num', desc: 'a and b differ by at most the tolerance.', inputs: [p('a', 'num', true), p('b', 'num')], outputs: [p('yes', 'bool')],
    settings: [opt('b', 'num', { def: 0 }), opt('tolerance', 'num', { def: 0 })],
    eval: (io, s) => ({ yes: Math.abs(io.in('a') - num(io, s, 'b')) <= (Number(s.tolerance) || 0) }),
  },
  abs: { title: 'Absolute', cat: 'num', desc: '|value|.', inputs: [p('value', 'num', true)], outputs: [p('out', 'num')], settings: [], eval: (io) => ({ out: Math.abs(io.in('value')) }) },
  subtract: {
    title: 'Subtract', cat: 'num', desc: 'a − b.', inputs: [p('a', 'num', true), p('b', 'num')], outputs: [p('out', 'num')], settings: [opt('b', 'num', { def: 0 })],
    eval: (io, s) => ({ out: io.in('a') - num(io, s, 'b') }),
  },
  hoursSince: {
    title: 'Hours since', cat: 'num', desc: 'Hours from a time (ms) to now, never below 0. An unwired or 0 time reads as 1000000 hours (never happened).',
    inputs: [p('at', 'num', true)], outputs: [p('hours', 'num')], settings: [], eval: (io, s, ctx) => ({ hours: hoursSince(ctx, Number(io.in('at')) || 0) }),
  },
  count: { title: 'Count', cat: 'num', desc: 'How many items a list has.', inputs: [p('list', 'any', true)], outputs: [p('out', 'num')], settings: [], eval: (io) => ({ out: (io.in('list') || []).length }) },
  constant: {
    title: 'Constant', cat: 'num', desc: 'A fixed number, text or yes/no.', inputs: [],
    outputs: (s) => [p('out', ['num', 'text', 'bool'].includes(s.type) ? s.type : 'num')],
    settings: [opt('type', 'enum', { options: ['num', 'text', 'bool'], def: 'num' }), opt('value', 'text')],
    eval: (io, s) => ({ out: s.type === 'text' ? str(s.value) : s.type === 'bool' ? s.value === true || s.value === 'true' : Number(s.value) || 0 }),
  },
  // ---------------------------------------------------------------- text
  notesMention: {
    title: 'Notes mention', cat: 'text', desc: 'The text has one of these words or phrases (whole words, any case); a negated one ("no water") can be skipped.',
    inputs: [p('text', 'text', true)], outputs: [p('found', 'bool'), p('word', 'text')],
    settings: [opt('words', 'list', { def: [] }), opt('skipNegated', 'bool', { def: true })],
    eval(io, s, ctx, n) {
      const re = n.cache.re === undefined ? (n.cache.re = wordsRe(s.words)) : n.cache.re;
      const w = re ? find(str(io.in('text')), re, s.skipNegated !== false, ctx) : null;
      return { found: w != null, word: str(w) };
    },
  },
  matchesPattern: {
    title: 'Matches pattern', cat: 'text', desc: 'The text matches a named built-in pattern (DOLLAR_RE: a price, EXPLAIN_RE: deposit / waived / refund…).',
    inputs: [p('text', 'text', true)], outputs: [p('found', 'bool'), p('match', 'text')],
    settings: [opt('pattern', 'pattern', { options: PATTERN_NAMES, req: true }), opt('skipNegated', 'bool', { def: false })],
    eval(io, s, ctx) {
      const re = ctx[s.pattern];
      if (!(re instanceof RegExp)) throw new Error('no pattern ' + s.pattern + ' here');
      const w = find(str(io.in('text')), re, !!s.skipNegated, ctx);
      return { found: w != null, match: str(w) };
    },
  },
  chooseText: {
    title: 'Choose text', cat: 'text', desc: 'The first then whose if is true, else the else (a then / else not wired uses its setting).',
    inputs: [p('if1', 'bool'), p('then1', 'text'), p('if2', 'bool'), p('then2', 'text'), p('if3', 'bool'), p('then3', 'text'), p('else', 'text')], outputs: [p('out', 'text')],
    settings: [opt('then1', 'text'), opt('then2', 'text'), opt('then3', 'text'), opt('else', 'text')],
    eval(io, s) {
      for (const i of [1, 2, 3]) if (io.wired('if' + i) && io.in('if' + i)) return { out: txt(io, s, 'then' + i) };
      return { out: txt(io, s, 'else') };
    },
  },
  template: {
    title: 'Template', cat: 'text', desc: 'Text with {name} placeholders; each placeholder is an input.',
    inputs: (s) => placeholders(s.text).map((k) => p(k, 'any', true)), outputs: [p('out', 'text')], settings: [opt('text', 'text')],
    eval: (io, s) => ({ out: str(s.text).replace(/\{(\w+)\}/g, (m, k) => str(io.in(k))) }),
  },
  money: { title: 'Money', cat: 'text', desc: '15 → "$15", 15.5 → "$15.50".', inputs: [p('value', 'num', true)], outputs: [p('out', 'text')], settings: [], eval: (io, s, ctx) => ({ out: ctx.money(Number(io.in('value')) || 0) }) },
  lowercase: { title: 'Lowercase', cat: 'text', desc: 'The text in lower case.', inputs: [p('text', 'text', true)], outputs: [p('out', 'text')], settings: [], eval: (io) => ({ out: str(io.in('text')).toLowerCase() }) },
  isBlank: { title: 'Is blank', cat: 'text', desc: 'The text is empty (spaces count as empty).', inputs: [p('text', 'text', true)], outputs: [p('yes', 'bool')], settings: [], eval: (io) => ({ yes: !str(io.in('text')).trim() }) },
  // ---------------------------------------------------------------- people and notes (who did what, and when)
  lastNote: {
    title: 'Last note', cat: 'people', desc: 'The newest note of a kind (manual, system or any), optionally with one tag: whether there is one, who wrote it, its text, tag, when (ms) and how many hours ago. None: found is no, author Unassigned, at 0, hoursAgo 1000000.',
    inputs: [], outputs: [p('found', 'bool'), p('author', 'person'), p('text', 'text'), p('tag', 'text'), p('at', 'num'), p('hoursAgo', 'num')],
    settings: [opt('kind', 'enum', { options: NOTE_KINDS, def: 'manual' }), opt('tag', 'text', { desc: 'only notes with this noteTag (blank: any)' })], notes: true,
    eval: (io, s, ctx) => noteOut(ctx, ctx.lastNote(ctx.f, s)),
  },
  firstNote: {
    title: 'First note', cat: 'people', desc: 'The oldest note of a kind (manual, system or any), optionally with one tag: same outputs as Last note.',
    inputs: [], outputs: [p('found', 'bool'), p('author', 'person'), p('text', 'text'), p('tag', 'text'), p('at', 'num'), p('hoursAgo', 'num')],
    settings: [opt('kind', 'enum', { options: NOTE_KINDS, def: 'manual' }), opt('tag', 'text', { desc: 'only notes with this noteTag (blank: any)' })], notes: true,
    eval: (io, s, ctx) => noteOut(ctx, ctx.firstNote(ctx.f, s)),
  },
  filterNotes: {
    title: 'Filter notes', cat: 'people', desc: 'Keep notes by kind, tag, author (name contains) and age (written within this many hours; 0: any). Notes not loaded: none.',
    inputs: [p('notes', 'notes', true)], outputs: [p('out', 'notes')],
    settings: [opt('kind', 'enum', { options: NOTE_KINDS, def: 'any' }), opt('tag', 'text'), opt('author', 'text', { desc: 'author name contains (any case)' }), opt('withinHours', 'num', { def: 0 })],
    eval: (io, s, ctx) => ({ out: ctx.filterNotes(io.in('notes') || [], { kind: s.kind || 'any', tag: s.tag, author: s.author, since: Number(s.withinHours) > 0 ? nowOf(ctx) - Number(s.withinHours) * 3600000 : 0 }) }),
  },
  noteAuthors: {
    title: 'Note authors', cat: 'people', desc: 'Who wrote these notes: their names, each once (oldest first), and how many.',
    inputs: [p('notes', 'notes', true)], outputs: [p('authors', 'textList'), p('count', 'num')], settings: [],
    eval(io, s, ctx) {
      const names = [...new Set((io.in('notes') || []).map((n) => (ctx.person(n.UserDatum) || {}).name).filter(Boolean))];
      return { authors: names, count: names.length };
    },
  },
  lastUser: {
    title: 'Last user', cat: 'people', desc: "Who last updated the order in Portal (its updatedBy) and when. An older cached order without it: whoever made the latest note or status change on record; with nothing at all, Unassigned (at 0).",
    inputs: [], outputs: [p('who', 'person'), p('at', 'num'), p('hoursAgo', 'num')], settings: [], notes: true,
    eval(io, s, ctx) { const e = ctx.lastUserEntry(ctx.f); return { who: e.who, at: e.at || 0, hoursAgo: hoursSince(ctx, e.at) }; },
  },
  createdBy: {
    title: 'Created by', cat: 'people', desc: 'Who created the order and when (Unassigned when Portal did not say).',
    inputs: [], outputs: [p('who', 'person'), p('at', 'num'), p('hoursAgo', 'num')], settings: [], notes: true,
    eval(io, s, ctx) { const e = ctx.createdByEntry(ctx.f); return { who: e.who, at: e.at || 0, hoursAgo: hoursSince(ctx, e.at) }; },
  },
  statusSetBy: {
    title: 'Status set by', cat: 'people', desc: 'Who moved the order into its current status, and since when (the status note or audit trail; Unassigned and 0 when neither says).',
    inputs: [], outputs: [p('who', 'person'), p('since', 'num'), p('hoursAgo', 'num')], settings: [], notes: true,
    eval(io, s, ctx) { const e = ctx.statusSetBy(ctx.f); return { who: e.who, since: e.since || 0, hoursAgo: hoursSince(ctx, e.since) }; },
  },
  personIs: {
    title: 'Person is', cat: 'people', desc: "The person's name contains one of these (any case). None listed: no.",
    inputs: [p('person', 'person', true)], outputs: [p('yes', 'bool')], settings: [opt('names', 'list', { def: [] })],
    eval: (io, s) => ({ yes: !!(s.names || []).filter((w) => str(w).trim()).length && inList(personName(io.in('person')), (s.names || []).filter((w) => str(w).trim()), 'contains') }),
  },
  samePerson: {
    title: 'Same person', cat: 'people', desc: 'a and b are the same person (same key). Unassigned or nobody is never the same person.',
    inputs: [p('a', 'person', true), p('b', 'person', true)], outputs: [p('yes', 'bool')], settings: [],
    eval(io, s, ctx) { const a = io.in('a'), b = io.in('b'); return { yes: !!a && !!b && a.key === b.key && !unassigned(a, ctx) }; },
  },
  personName: { title: 'Person name', cat: 'people', desc: "The person's full name (blank for nobody).", inputs: [p('person', 'person', true)], outputs: [p('name', 'text')], settings: [], eval: (io) => ({ name: personName(io.in('person')) }) },
  isUnassigned: {
    title: 'Is unassigned', cat: 'people', desc: 'The person is Unassigned (or nobody).', inputs: [p('person', 'person', true)], outputs: [p('yes', 'bool')], settings: [],
    eval: (io, s, ctx) => ({ yes: unassigned(io.in('person'), ctx) }),
  },
  // ---------------------------------------------------------------- cart lines and Assize's own
  filterLines: {
    title: 'Filter lines', cat: 'assize', desc: 'Keep or drop cart lines: partner credits, never-flag lines (misc labor, buybacks), deposits, by price sign, by SKU or name words.',
    inputs: [p('lines', 'lines', true)], outputs: [p('out', 'lines')],
    settings: [opt('credit', 'enum', { options: TRI, def: 'any' }), opt('neverFlag', 'enum', { options: TRI, def: 'any' }), opt('deposit', 'enum', { options: TRI, def: 'any' }),
      opt('price', 'enum', { options: ['any', 'positive', 'negative', 'nonzero'], def: 'any' }), opt('skus', 'list', { def: [] }), opt('names', 'list', { def: [] }),
      opt('match', 'enum', { options: ['keep', 'drop'], def: 'keep', desc: 'what happens to lines whose SKU or name matches' })],
    eval(io, s, ctx, n) {
      const skus = (s.skus || []).map((x) => str(x).toLowerCase()), re = n.cache.re === undefined ? (n.cache.re = wordsRe(s.names)) : n.cache.re;
      const byWhat = skus.length || re;
      return { out: (io.in('lines') || []).filter((l) => {
        const pr = ctx.price(l);
        if (!tri(s.credit, ctx.isCredit(l)) || !tri(s.neverFlag, ctx.neverFlag(l)) || !tri(s.deposit, ctx.isDeposit(l))) return false;
        if (s.price === 'positive' ? !(pr > 0) : s.price === 'negative' ? !(pr < 0) : s.price === 'nonzero' ? !pr : false) return false;
        if (!byWhat) return true;
        const hit = skus.includes(str(l.sku || l.itemNumber).toLowerCase()) || !!(re && re.test(str(l.name)));
        return (s.match || 'keep') === 'keep' ? hit : !hit;
      }) };
    },
  },
  sumPrices: { title: 'Sum prices', cat: 'assize', desc: "The lines' prices added up.", inputs: [p('lines', 'lines', true)], outputs: [p('out', 'num')], settings: [], eval: (io, s, ctx) => ({ out: (io.in('lines') || []).reduce((t, l) => t + ctx.price(l), 0) }) },
  cartSum: {
    title: 'Cart sum', cat: 'assize', desc: "What the items are priced at: every line but misc labor, buybacks and deposit offsets (the rules' cartSum).",
    inputs: [p('lines', 'lines', true)], outputs: [p('sum', 'num')], settings: [], eval: (io, s, ctx) => ({ sum: ctx.cartSum({ cartItems: io.in('lines') || [] }) }),
  },
  cartSig: {
    title: 'Cart signature', cat: 'assize', desc: "A short hash of the cart's lines, so a changed cart is a new finding.",
    inputs: [p('lines', 'lines', true)], outputs: [p('sig', 'text')], settings: [], eval: (io, s, ctx) => ({ sig: ctx.cartSig({ cartItems: io.in('lines') || [] }) }),
  },
  intakeNote: {
    title: 'Intake note', cat: 'assize', desc: 'The check-in note: whether there is one, its text, and its own lines (blank and checklist lines left out).',
    inputs: [], outputs: [p('exists', 'bool'), p('text', 'text'), p('ownLines', 'num')], settings: [], notes: true,
    eval(io, s, ctx) {
      const n = ctx.intakeNote(ctx.f), text = n ? str(n.noteText) : '';
      return { exists: !!n, text, ownLines: text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !ctx.CHECKLIST_LINE.test(l)).length };
    },
  },
  intakeAuthor: { title: 'Intake author', cat: 'assize', desc: "Who wrote the intake note (else who created the order, else Unassigned).", inputs: [], outputs: [p('who', 'person')], settings: [], notes: true, eval: (io, s, ctx) => ({ who: ctx.intakeAuthor(ctx.f) }) },
  // ---------------------------------------------------------------- output and flow
  start: { title: 'Start', cat: 'out', desc: 'Where execution begins, once per order.', inputs: [], outputs: [], settings: [], exec: { in: false, outs: ['then'] }, run: () => 'then' },
  branch: {
    title: 'Branch', cat: 'out', desc: 'Follows yes or no.', inputs: [p('cond', 'bool', true)], outputs: [], settings: [], exec: { in: true, outs: ['yes', 'no'] },
    run: (io) => (io.in('cond') ? 'yes' : 'no'),
  },
  stop: { title: 'Stop', cat: 'out', desc: 'Ends the run: skip this order (no data-driven findings either).', inputs: [], outputs: [], settings: [], exec: { in: true, outs: [] }, run: () => null },
  finding: {
    title: 'Finding', cat: 'out', desc: 'Raises a finding: when execution reaches it, or (no exec wire in) when its when is true.',
    inputs: FINDING_IN, outputs: [], exec: { in: true, outs: ['then'] },
    settings: [opt('kind', 'enum', { options: KINDS, def: 'note' }), ...FINDING_SET],
    raise,
    run(io, s, ctx, st) { if (!io.wired('when') || io.in('when')) st.findings.push(this.raise(io, s, ctx, st.graph)); return 'then'; },
  },
  reminder: {
    title: 'Reminder', cat: 'out', desc: 'A reminder (blue, never counted): like a finding, kind remind.',
    inputs: FINDING_IN, outputs: [], exec: { in: true, outs: ['then'] }, settings: FINDING_SET,
    raise: (io, s, ctx, g) => raise(io, Object.assign({}, s, { kind: 'remind', check: s.check || 'remind' }), ctx, g),
    run(io, s, ctx, st) { if (!io.wired('when') || io.in('when')) st.findings.push(this.raise(io, s, ctx, st.graph)); return 'then'; },
  },
  // ---------------------------------------------------------------- macros
  macro: {
    title: 'Macro', cat: 'logic', desc: 'A collapsed sub-graph.', settings: [opt('macro', 'macro', { req: true })],
    inputs: (s, m) => (m ? m.inputs : []), outputs: (s, m) => (m ? m.outputs : []),
    eval(io, s, ctx, n, st, scope) {
      const sub = { c: n.macro, memo: new Map(), prefix: scope.prefix + n.id + '/', io };
      if (st.dbg) st.dbg.scopes.push(sub);
      return outputsOf(st, sub, n.macro.outId);
    },
  },
  macroIn: {
    title: 'Macro inputs', cat: 'logic', desc: "The macro's inputs, inside it.", settings: [], inputs: [], outputs: (s, m, inside) => (inside ? inside.inputs : []),
    eval(io, s, ctx, n, st, scope) { const o = {}; for (const x of scope.c.def.inputs) o[x.name] = scope.io.in(x.name); return o; },
  },
  macroOut: {
    title: 'Macro outputs', cat: 'logic', desc: "The macro's outputs, inside it.", settings: [], outputs: [], inputs: (s, m, inside) => (inside ? inside.outputs.map((x) => p(x.name, x.type, true)) : []),
    eval(io, s, ctx, n, st, scope) { const o = {}; for (const x of scope.c.def.outputs) o[x.name] = io.in(x.name); return o; },
  },
};
const personName = (x) => (x && x.name ? str(x.name) : '');
const unassigned = (x, ctx) => !x || x.key === 'unassigned' || x === ctx.UNASSIGNED;
// Last / first note → outputs; no note: found no, Unassigned, blanks, at 0, hoursAgo NEVER.
function noteOut(ctx, n) {
  const at = n ? Date.parse(n.createdAt) || 0 : 0;
  return { found: !!n, author: (n && ctx.person(n.UserDatum)) || ctx.UNASSIGNED, text: n ? str(n.noteText) : '', tag: n ? str(n.noteTag) : '', at, hoursAgo: hoursSince(ctx, at) };
}
function num(io, s, k) { return io.wired(k) ? io.in(k) : Number(s[k]) || 0; }
function txt(io, s, k) { return io.wired(k) ? str(io.in(k)) : str(s[k]); }
// The first match: skipping negated ones ("no water damage") through the host's mentions(), else a plain match.
function find(text, re, skipNegated, ctx) {
  if (skipNegated) return ctx.mentions(text, re);
  if (re.global || re.sticky) re.lastIndex = 0;
  const m = re.exec(text);
  return m ? m[1] || m[0] : null;
}

/*
  Built-in macros: a native node rebuilt from primitives (cartSum), and the scope every field check shares.
*/
export const MACROS = {
  cartSum: {
    title: 'Cart sum', desc: 'Cart sum from primitives: drop never-flag lines and deposit offsets, add up the rest.',
    inputs: [{ name: 'lines', type: 'lines' }], outputs: [{ name: 'sum', type: 'num' }],
    nodes: [{ id: 'in', type: 'macroIn', x: 30, y: 40 }, { id: 'keep', type: 'filterLines', x: 310, y: 40, settings: { neverFlag: 'drop', deposit: 'drop' } },
      { id: 'add', type: 'sumPrices', x: 590, y: 40 }, { id: 'out', type: 'macroOut', x: 870, y: 40 }],
    wires: [{ from: 'in.lines', to: 'keep.lines' }, { from: 'keep.out', to: 'add.lines' }, { from: 'add.out', to: 'out.sum' }],
  },
  // Assize's field checks only look at an order that is open (not closed, cancelled or closing), not waiting on a
  // diagnosis, a partner's approval or a part (Awaiting item gets its reminder and nothing else), and not a cleaning.
  checked: {
    title: 'Checked order', desc: 'The order gets the field checks: open and not closing, not Awaiting diag / Partner approval / Awaiting item, not a cleaning program.',
    inputs: [], outputs: [{ name: 'yes', type: 'bool' }],
    nodes: [
      { id: 'wo', type: 'wo', x: 30, y: 40 },
      { id: 'blank', type: 'isBlank', x: 310, y: 40 },
      { id: 'closed', type: 'statusIs', x: 310, y: 170, settings: { statuses: ['sale complete', 'cancel', 'repair summary', 'awaiting diag', 'partner approval'], match: 'contains' } },
      { id: 'item', type: 'statusIs', x: 310, y: 400, settings: { statuses: ['awaiting item'] } },
      { id: 'clean', type: 'programIs', x: 310, y: 580, settings: { programs: ['cleaning'] } },
      { id: 'any', type: 'or', x: 590, y: 250 },
      { id: 'no', type: 'not', x: 870, y: 250 },
      { id: 'out', type: 'macroOut', x: 1150, y: 250 },
    ],
    wires: [{ from: 'wo.id', to: 'blank.text' }, { from: 'wo.status', to: 'closed.status' }, { from: 'wo.status', to: 'item.status' }, { from: 'wo.programKey', to: 'clean.key' },
      { from: 'blank.yes', to: 'any.a' }, { from: 'closed.yes', to: 'any.b' }, { from: 'item.yes', to: 'any.c' }, { from: 'clean.yes', to: 'any.d' },
      { from: 'any.out', to: 'no.in' }, { from: 'no.out', to: 'out.yes' }],
  },
};

// ------------------------------------------------------------------ pins and validation
const libOf = (graph, library) => ({ nodes: (library && library.nodes) || NODE_TYPES, macros: Object.assign({}, MACROS, library && library.macros, graph && graph.macros) });
const list = (v, s, m, inside) => (typeof v === 'function' ? v(s, m, inside) : v || []);
// A node's pins: { inputs, outputs, exec } (macro pins come from the macro; macroIn / macroOut from the macro they sit in).
export function pinsOf(node, library, inside) {
  const lib = library && library.nodes ? library : libOf(null, library);
  const def = lib.nodes[node.type];
  if (!def) return null;
  const s = node.settings || {}, m = node.type === 'macro' ? lib.macros[s.macro] : null;
  return { inputs: list(def.inputs, s, m, inside), outputs: list(def.outputs, s, m, inside), exec: def.exec || null };
}
const split = (ref) => { const s = str(ref), i = s.indexOf('.'); return i > 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, '']; };
const fits = (a, b) => a === b || a === 'any' || b === 'any';
function cyclic(ids, edges) {
  const out = new Map(ids.map((i) => [i, []]));
  for (const [a, b] of edges) if (out.has(a)) out.get(a).push(b);
  const mark = new Map();
  const visit = (i) => {
    if (mark.get(i) === 1) return true;
    if (mark.get(i) === 2) return false;
    mark.set(i, 1);
    for (const j of out.get(i) || []) if (visit(j)) return true;
    mark.set(i, 2);
    return false;
  };
  return ids.some((i) => visit(i));
}
function checkSetting(f, v) {
  if (v === undefined) return f.req ? 'is required' : null;
  if (f.type === 'list') return Array.isArray(v) ? null : 'must be a list';
  if (f.type === 'num') return Number.isFinite(Number(v)) && v !== '' ? null : 'must be a number';
  if (f.type === 'bool') return typeof v === 'boolean' ? null : 'must be true or false';
  if (f.type === 'enum' || f.type === 'pattern') return (f.options || []).includes(v) ? null : 'must be one of ' + (f.options || []).join(', ');
  return null;
}

/*
  validate(graph, library) → readable errors ([] = fine): unknown node types or macros, bad wires (unknown
  node / pin, incompatible types, two wires into one input, two exec wires out of one exec pin), missing required
  inputs, data or exec cycles, more than one start, bad settings, macros that use themselves.
*/
export function validate(graph, library) {
  const lib = libOf(graph, library);
  const errs = [];
  if (!graph || typeof graph !== 'object') return ['The graph is not an object'];
  if (graph.v !== FORMAT) errs.push('Format v' + graph.v + ' is not v' + FORMAT);
  body(graph, lib, null, '', errs);
  // Macros: each body on its own, and none may use itself (directly or through another).
  const uses = (m) => (m.nodes || []).filter((n) => n.type === 'macro').map((n) => (n.settings || {}).macro);
  const seen = new Set(), todo = [...new Set(uses(graph))];
  while (todo.length) {
    const name = todo.shift();
    if (seen.has(name) || !lib.macros[name]) continue;
    seen.add(name);
    body(lib.macros[name], lib, lib.macros[name], 'Macro ' + name + ': ', errs);
    todo.push(...uses(lib.macros[name]));
  }
  const names = [...seen];
  if (cyclic(names, names.flatMap((a) => uses(lib.macros[a]).map((b) => [a, b])))) errs.push('A macro uses itself');
  return errs;
}
function body(g, lib, inside, at, errs) {
  const nodes = Array.isArray(g.nodes) ? g.nodes : (errs.push(at + 'nodes must be a list'), []);
  const byId = new Map(), pins = new Map();
  for (const n of nodes) {
    if (!n || !n.id) { errs.push(at + 'A node has no id'); continue; }
    if (byId.has(n.id)) { errs.push(at + 'Two nodes are called ' + n.id); continue; }
    byId.set(n.id, n);
    const def = lib.nodes[n.type];
    if (!def) { errs.push(at + n.id + ': unknown node type "' + n.type + '"'); continue; }
    const s = n.settings || {};
    if (n.type === 'macro' && !lib.macros[s.macro]) { errs.push(at + n.id + ': unknown macro "' + s.macro + '"'); continue; }
    if ((n.type === 'macroIn' || n.type === 'macroOut') && !inside) { errs.push(at + n.id + ': ' + n.type + ' only goes inside a macro'); continue; }
    if (inside && def.exec) { errs.push(at + n.id + ': macros have no exec nodes (' + n.type + ')'); continue; }
    for (const f of def.settings || []) { const e = checkSetting(f, s[f.name]); if (e) errs.push(at + n.id + ': setting ' + f.name + ' ' + e); }
    if (n.label != null && (typeof n.label !== 'string' || n.label.length > 80)) errs.push(at + n.id + ': label must be text, 80 characters at most');
    pins.set(n.id, pinsOf(n, lib, inside));
  }
  if (inside) {
    const outs = nodes.filter((n) => n && n.type === 'macroOut').length, ins = nodes.filter((n) => n && n.type === 'macroIn').length;
    if (outs !== 1) errs.push(at + 'needs exactly one macroOut node (has ' + outs + ')');
    if (ins > 1) errs.push(at + 'has more than one macroIn node');
    if (ins === 0 && (inside.inputs || []).length) errs.push(at + 'has inputs but no macroIn node');
  }
  const starts = nodes.filter((n) => n && n.type === 'start').length;
  if (starts > 1) errs.push(at + 'More than one start node (' + starts + ')');
  // data wires
  const into = new Map(), dataEdges = [];
  for (const w of g.wires || []) {
    const [a, ap] = split(w && w.from), [b, bp] = split(w && w.to), label = at + 'Wire ' + str(w && w.from) + ' → ' + str(w && w.to) + ': ';
    if (!byId.has(a) || !byId.has(b)) { errs.push(label + 'unknown node'); continue; }
    if (!pins.get(a) || !pins.get(b)) continue; // the node's own error is already listed
    const o = pins.get(a).outputs.find((x) => x.name === ap), i = pins.get(b).inputs.find((x) => x.name === bp);
    if (!o) { errs.push(label + a + ' has no output ' + ap); continue; }
    if (!i) { errs.push(label + b + ' has no input ' + bp); continue; }
    if (!fits(o.type, i.type)) { errs.push(label + o.type + ' does not fit ' + i.type); continue; }
    if (into.has(w.to)) { errs.push(at + 'Input ' + w.to + ' has more than one wire'); continue; }
    into.set(w.to, w.from);
    dataEdges.push([a, b]);
  }
  // exec wires
  const execIn = new Set(), execOut = new Set(), execEdges = [];
  for (const w of g.flow || []) {
    const [a, ap] = split(w && w.from), [b, bp] = split(w && w.to), label = at + 'Exec wire ' + str(w && w.from) + ' → ' + str(w && w.to) + ': ';
    if (inside) { errs.push(at + 'macros have no exec wires'); break; }
    if (!byId.has(a) || !byId.has(b)) { errs.push(label + 'unknown node'); continue; }
    const pa = pins.get(a), pb = pins.get(b);
    if (!pa || !pb) continue;
    if (!pa.exec || !pa.exec.outs.includes(ap)) { errs.push(label + a + ' has no exec output ' + ap); continue; }
    if (!pb.exec || !pb.exec.in || bp !== 'in') { errs.push(label + b + ' has no exec input ' + bp); continue; }
    if (execOut.has(w.from)) { errs.push(at + 'Exec output ' + w.from + ' has more than one wire'); continue; }
    execOut.add(w.from); execIn.add(b);
    execEdges.push([a, b]);
  }
  if ((g.flow || []).length && !starts && !inside) errs.push(at + 'Exec wires but no start node');
  // required inputs (a finding with no exec wire in needs its when)
  for (const [id, pn] of pins) {
    if (!pn) continue;
    const n = byId.get(id);
    for (const i of pn.inputs) if (i.req && !into.has(id + '.' + i.name)) errs.push(at + id + ' (' + n.type + '): input ' + i.name + ' is not wired');
    if ((n.type === 'finding' || n.type === 'reminder') && !execIn.has(id) && !into.has(id + '.when')) errs.push(at + id + ': a finding needs an exec wire in or its when input');
    if ((n.type === 'and' || n.type === 'or') && !LETTERS.some((k) => into.has(id + '.' + k))) errs.push(at + id + ' (' + n.type + '): no input is wired');
    if ((n.type === 'finding' || n.type === 'reminder') && !((n.settings || {}).rule || g.rule) && !inside) errs.push(at + id + ': no rule id (settings.rule or the graph\'s rule)');
  }
  if (cyclic([...byId.keys()], dataEdges)) errs.push(at + 'The data wires make a loop');
  if (cyclic([...byId.keys()], execEdges)) errs.push(at + 'The exec wires make a loop');
}

// ------------------------------------------------------------------ compile and run
/*
  compile(graph, library) → { errors } when it doesn't validate, else the compiled graph ({ errors: [], rule, ... }),
  made once and run for every order.
*/
export function compile(graph, library) {
  const errors = validate(graph, library);
  if (errors.length) return { errors, rule: graph && graph.rule };
  const lib = libOf(graph, library), macros = new Map();
  const macroOf = (name) => {
    if (!macros.has(name)) { macros.set(name, null); macros.set(name, part(lib.macros[name], lib, lib.macros[name], macroOf)); }
    return macros.get(name);
  };
  const c = part(graph, lib, null, macroOf);
  return Object.assign(c, { errors: [], v: graph.v, rule: graph.rule || '', check: graph.check || '', title: graph.title || '', graph });
}
function part(g, lib, inside, macroOf) {
  const nodes = {};
  for (const n of g.nodes) {
    const def = lib.nodes[n.type], s = n.settings || {};
    nodes[n.id] = { id: n.id, type: n.type, def, s, ins: {}, next: {}, wire: {}, execIn: false, cache: {}, macro: n.type === 'macro' ? macroOf(s.macro) : null, label: n.label || def.title };
  }
  for (const w of g.wires || []) { const [a, ap] = split(w.from), [b, bp] = split(w.to); nodes[b].ins[bp] = [a, ap]; }
  (g.flow || []).forEach((w, i) => { const [a, ap] = split(w.from), [b] = split(w.to); nodes[a].next[ap] = b; nodes[a].wire[ap] = i; nodes[b].execIn = true; });
  const all = Object.values(nodes);
  return {
    def: inside, nodes, start: (all.find((n) => n.type === 'start') || {}).id || null, outId: (all.find((n) => n.type === 'macroOut') || {}).id || null,
    dataFindings: all.filter((n) => (n.type === 'finding' || n.type === 'reminder') && !n.execIn).map((n) => n.id),
  };
}

class Abort extends Error {}
// Debug runs only: an input's node failed (its own error is kept on it); the message is that node's path.
class Failed extends Error {}
const BUSY = {}, FAILED = {};
// A node's outputs, evaluated once per run (per macro call inside a macro).
function outputsOf(st, scope, id) {
  const memo = scope.memo.get(id);
  if (memo === BUSY) throw new Abort(where(scope, id) + ': its inputs loop back to it');
  if (memo === FAILED) throw new Failed(where(scope, id));
  if (memo) return memo;
  if (++st.steps > st.limit) throw new Abort('Step limit (' + st.limit + ') reached at ' + where(scope, id));
  const n = scope.c.nodes[id];
  scope.memo.set(id, BUSY);
  if (st.dbg) st.dbg.seen(scope, n);
  let o;
  try { o = n.def.eval(ioOf(st, scope, n), n.s, st.ctx, n, st, scope) || {}; }
  catch (e) {
    if (st.dbg && !(e instanceof Abort)) { scope.memo.set(id, FAILED); st.dbg.fail(scope, n, e); throw new Failed(where(scope, id)); }
    throw e instanceof Abort ? e : new Abort(where(scope, id) + ' (' + n.type + '): ' + ((e && e.message) || String(e)));
  }
  scope.memo.set(id, o);
  if (st.trace) for (const k of Object.keys(o)) st.trace[scope.prefix + id + '.' + k] = o[k];
  return o;
}
const where = (scope, id) => scope.prefix + id;
function ioOf(st, scope, n) {
  return {
    wired: (k) => !!n.ins[k],
    in: (k) => { const w = n.ins[k]; return w ? outputsOf(st, scope, w[0])[w[1]] : undefined; },
  };
}
/*
  run(compiled, ctx, { trace: true, limit: STEP_LIMIT }) → { findings, errors, trace, path }. A run that hits an error
  (a node threw, the step limit) has the error and no findings.
*/
export function run(c, ctx, opts = {}) {
  if (opts.debug) return debugRun(c, ctx, opts);
  const res = { findings: [], errors: [], trace: {}, path: [] };
  if (!c || (c.errors && c.errors.length)) { res.errors = (c && c.errors) || ['No graph']; return res; }
  const st = { ctx: ctx || {}, steps: 0, limit: opts.limit || STEP_LIMIT, trace: opts.trace === false ? null : res.trace, findings: res.findings, graph: c };
  const scope = { c, memo: new Map(), prefix: '' };
  try {
    let id = c.start, stopped = false;
    while (id) {
      if (++st.steps > st.limit) throw new Abort('Step limit (' + st.limit + ') reached at ' + id);
      const n = c.nodes[id];
      res.path.push(id);
      let out;
      try { out = n.def.run(ioOf(st, scope, n), n.s, st.ctx, st, n); }
      catch (e) { throw e instanceof Abort ? e : new Abort(id + ' (' + n.type + '): ' + ((e && e.message) || String(e))); }
      if (out === null) { stopped = true; break; }
      id = n.next[out] || null;
    }
    if (!stopped) {
      for (const fid of c.dataFindings) {
        const n = c.nodes[fid], io = ioOf(st, scope, n);
        let hit;
        try { hit = !!io.in('when'); } catch (e) { throw e instanceof Abort ? e : new Abort(fid + ': ' + ((e && e.message) || String(e))); }
        if (!hit) continue;
        if (++st.steps > st.limit) throw new Abort('Step limit (' + st.limit + ') reached at ' + fid);
        try { res.findings.push(n.def.raise(io, n.s, st.ctx, c)); }
        catch (e) { throw e instanceof Abort ? e : new Abort(fid + ' (' + n.type + '): ' + ((e && e.message) || String(e))); }
      }
    }
  } catch (e) {
    res.errors.push(e instanceof Abort ? e.message : 'Graph error: ' + ((e && e.message) || String(e)));
    res.findings.length = 0;
  }
  return res;
}

/*
  debugRun (run(c, ctx, { debug: true })): the editor's run. The same flow as run() (same lazy order, same memo, so
  every value matches what Assize computes), then every node nothing needed is evaluated too, so every wire has a
  value, and every finding says what it would raise. A node that throws is kept as that node's error (and every node
  that needs it says so) instead of ending the run. → run()'s { findings, errors, trace, path } plus:
    steps      the exec path in order: [{ i, node, pin (the exec output taken; null at a stop or an error), at (the
               evaluation count then: pure nodes pulled in between have nodes[id].order below it), error? }]
    execWires  the exec wires taken: [{ from: 'b.yes', to: 'f.in', index (in graph.flow) }]
    nodes      per node ({ 'macroNodeId/innerId' } inside macros): { state, order, error?, needsNotes? }
               state: ran (an executed node execution reached, or a data-driven finding checked after the flow) ·
               used (a pure node pulled by something that ran) · idle (evaluated only for the debug view) ·
               notReached (an executed node execution never reached) · error (threw, or needs a node that did).
               needsNotes: the node reads the order's notes and the host has none (ctx.f.notes null: customer
               details off, or not loaded): true, or the outputs concerned (the Work order node).
    outcome    how the run ended, in words: { ended: 'stop' | 'branch' | 'end' | 'error', node?, pin?, text, raised }
               e.g. { ended: 'stop', node: 'n7', text: 'Stopped at "Skip closed orders"' }, { ended: 'branch',
               node, pin: 'no', text: 'Ended after "Is OOP?" → no' }, { ended: 'end', text: 'Flow finished' }.
    results    per finding / reminder node: { reached, raised, wouldRaise, kind, check, rule, title, evidence, who,
               sigBasis, error? }; wouldRaise and the texts come from its inputs even when execution never got there.
    aborted    a normal run would have hit an error (no findings from this graph on this order: Assize keeps the
               code rule). findings still lists what the debug run raised.
    needsNotes some node that ran or was used reads notes the host doesn't have.
*/
function debugRun(c, ctx, opts) {
  const res = { findings: [], errors: [], trace: {}, path: [], steps: [], execWires: [], nodes: {}, results: {}, outcome: null, aborted: false, needsNotes: false };
  if (!c || (c.errors && c.errors.length)) {
    res.errors = (c && c.errors) || ['No graph'];
    res.outcome = { ended: 'error', text: "The graph doesn't validate: " + res.errors[0], raised: 0 };
    return res;
  }
  let seq = 0;
  const limit = opts.limit || STEP_LIMIT, raisedBy = new Set(), reached = new Set();
  const msg = (e) => (e instanceof Failed ? 'needs ' + e.message + ', which failed' : (e && e.message) || String(e));
  const st = { ctx: ctx || {}, steps: 0, limit, trace: res.trace, findings: res.findings, graph: c, phase: 'real', dbg: {
    scopes: [],
    seen(scope, n) { res.nodes[scope.prefix + n.id] = { state: st.phase === 'real' ? 'used' : 'idle', order: ++seq }; },
    fail(scope, n, e) { failed(scope.prefix + n.id, n, e); },
  } };
  const failed = (key, n, e) => {
    const x = res.nodes[key] || (res.nodes[key] = { order: ++seq });
    x.state = 'error'; x.error = msg(e);
    res.errors.push(key + ' (' + n.type + '): ' + x.error);
    if (st.phase === 'real') res.aborted = true;
  };
  const scope = { c, memo: new Map(), prefix: '' };
  const label = (id) => '"' + c.nodes[id].label + '"';
  let stopped = false, broke = false;
  // 1. The flow, as run() does it.
  try {
    let id = c.start;
    while (id) {
      if (++st.steps > st.limit) throw new Abort('Step limit (' + st.limit + ') reached at ' + id);
      const n = c.nodes[id], before = res.findings.length;
      res.path.push(id); reached.add(id);
      res.nodes[id] = { state: 'ran', order: ++seq };
      let out, error = null;
      try { out = n.def.run(ioOf(st, scope, n), n.s, st.ctx, st, n); }
      catch (e) {
        if (e instanceof Abort) throw e;
        failed(id, n, e); error = res.nodes[id].error;
        // A finding that failed still hands on (its one exec output); anything else ends the flow here.
        if (n.def.exec.outs.length !== 1 || n.type === 'branch') {
          res.steps.push({ i: res.steps.length, node: id, pin: null, at: st.steps, error });
          res.outcome = { ended: 'error', node: id, text: 'Ended with an error at ' + label(id) + ': ' + error };
          broke = true;
          break;
        }
        out = n.def.exec.outs[0];
      }
      if (res.findings.length > before) raisedBy.add(id);
      res.steps.push(Object.assign({ i: res.steps.length, node: id, pin: out, at: st.steps }, error ? { error } : null));
      if (out === null) { stopped = true; res.outcome = { ended: 'stop', node: id, text: 'Stopped at ' + label(id) }; break; }
      const next = n.next[out] || null;
      if (next) res.execWires.push({ from: id + '.' + out, to: next + '.in', index: n.wire[out] });
      else res.outcome = n.type === 'branch' ? { ended: 'branch', node: id, pin: out, text: 'Ended after ' + label(id) + ' → ' + out } : { ended: 'end', node: id, text: 'Flow finished' };
      id = next;
    }
    if (!res.outcome) res.outcome = { ended: 'end', text: c.start ? 'Flow finished' : 'No flow: findings checked on their own' };
    // 2. Data-driven findings, after the flow (not after a stop, nor after an error ended it).
    if (!stopped && !broke) {
      for (const fid of c.dataFindings) {
        const n = c.nodes[fid], io = ioOf(st, scope, n), before = res.findings.length;
        res.nodes[fid] = { state: 'ran', order: ++seq }; reached.add(fid);
        let hit = false;
        try { hit = !!io.in('when'); } catch (e) { if (e instanceof Abort) throw e; failed(fid, n, e); continue; }
        if (!hit) continue;
        if (++st.steps > st.limit) throw new Abort('Step limit (' + st.limit + ') reached at ' + fid);
        try { res.findings.push(n.def.raise(io, n.s, st.ctx, c)); } catch (e) { if (e instanceof Abort) throw e; failed(fid, n, e); }
        if (res.findings.length > before) raisedBy.add(fid);
      }
    }
  } catch (e) {
    const text = e instanceof Abort ? e.message : 'Graph error: ' + ((e && e.message) || String(e));
    res.errors.push(text); res.aborted = true;
    res.outcome = { ended: 'error', text };
  }
  // 3. Everything else, for the view: every pure node (macro insides too), then what each finding would say.
  st.phase = 'idle'; st.limit = st.steps + limit;
  const quiet = (fn) => { try { fn(); } catch (e) { if (!(e instanceof Failed)) throw e; } };
  try {
    for (const id of Object.keys(c.nodes)) if (!c.nodes[id].def.exec) quiet(() => outputsOf(st, scope, id));
    for (let i = 0; i < st.dbg.scopes.length; i++) { const sub = st.dbg.scopes[i]; for (const id of Object.keys(sub.c.nodes)) quiet(() => outputsOf(st, sub, id)); }
    for (const [id, n] of Object.entries(c.nodes)) {
      if (!n.def.exec) continue;
      if (!res.nodes[id]) res.nodes[id] = { state: 'notReached' };
      if (n.type !== 'finding' && n.type !== 'reminder') continue;
      const io = ioOf(st, scope, n), r = { reached: reached.has(id), raised: raisedBy.has(id), wouldRaise: false };
      try {
        r.wouldRaise = !io.wired('when') || !!io.in('when');
        Object.assign(r, n.def.raise(io, n.s, st.ctx, c));
      } catch (e) { if (e instanceof Abort) throw e; r.error = msg(e); }
      res.results[id] = r;
    }
  } catch (e) {
    if (!(e instanceof Abort)) throw e;
    res.errors.push(e.message + ' (while evaluating the rest for the view)');
  }
  // 4. Notes the host doesn't have.
  if (st.ctx.f && st.ctx.f.notes == null) {
    const all = [[scope, c]].concat(st.dbg.scopes.map((x) => [x, x.c]));
    for (const [sc, part] of all) {
      for (const n of Object.values(part.nodes)) {
        const need = n.def.notes, x = res.nodes[sc.prefix + n.id];
        if (!need || !x) continue;
        x.needsNotes = need === true ? true : need.slice();
        // The Work order node: only when something that ran or was used reads one of its notes outputs.
        const live = (k) => res.nodes[sc.prefix + k] && ['ran', 'used'].includes(res.nodes[sc.prefix + k].state);
        const reads = need === true ? ['ran', 'used'].includes(x.state) : Object.values(part.nodes).some((m) => live(m.id) && Object.values(m.ins).some(([a, ap]) => a === n.id && need.includes(ap)));
        if (reads) res.needsNotes = true;
      }
    }
  }
  res.outcome.raised = res.findings.length;
  return res;
}
