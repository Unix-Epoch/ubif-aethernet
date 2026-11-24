// Admin site, the Assize rules editor (rules-ui.js): Today's orders: this graph next to what runs now.
// Served at /rules-ui.js?part=compare.
import * as RG from '/rulegraph.js';
import * as TK from '/tracker-ui.js';
import { renderHeader, scopeRow, live, stopPlay, renderDebug } from '/rules-ui.js';
import { R, put, plural, KIND_NAME } from '/rules-ui.js?part=words';
import { S, el, ui } from '/rules-ui.js?part=state';
import { ctxFor, shown, optsFor, runDebug } from '/rules-ui.js?part=edit';
import { renderCanvas } from '/rules-ui.js?part=canvas';
import { renderSide } from '/rules-ui.js?part=side';

// ------------------------------------------------------------------ Today's orders: this graph next to what runs now
export function renderCompareSoon() { clearTimeout(S && S.cmpTimer); if (S) S.cmpTimer = setTimeout(() => { computeCompare(); renderCompareView(); if (S.confirm === 'publish') renderHeader(); }, 350); }
// What Assize runs for this rule at the test store today (the scope being edited): its published graph, else the
// all-stores one (a store without its own), else the code rule, else nothing (a new graph-only rule).
function baseline() {
  const own = scopeRow(S.scope), all = scopeRow('all');
  const g = (own && own.published) || (S.scope !== 'all' && all && all.published) || null;
  if (g) { const c = RG.compile(g); return { label: own && own.published ? 'Published' : 'All stores’ graph', run: (inp, opts) => { const r = RG.run(c, ctxFor(inp, opts), { trace: false }); return r.errors.length ? { error: r.errors[0] } : { list: r.findings.filter((x) => x.rule === S.ruleId).map(brief) }; } }; }
  if (S.rule.code) return { label: 'Code rule', run: (inp, opts) => ({ list: R.audit(inp.row, inp.detail, opts).filter((x) => x.rule === S.ruleId).map((x) => brief(x, true)) }) };
  return { label: 'Nothing yet', run: () => ({ list: [] }) };
}
function brief(x, code) {
  const sig = code ? x.sig : R.sigOf(...(x.sigBasis || []));
  const w = x.who || { key: 'unassigned', name: 'Unassigned' };
  return { key: [x.kind, x.check, x.title, x.evidence, w.key, sig].join(' · '), kind: x.kind, title: x.title, evidence: x.evidence, who: w.name || w.label };
}
function computeCompare() {
  if (!S || !S.rule || !S.rule.perOrder || !S.test.orders.length || !shown()) { if (S) S.cmp = null; return; }
  const now = Date.now(), opts = optsFor(S.test.store, now), base = baseline(), c = RG.compile(shown());
  const rows = [];
  for (const o of S.test.orders) {
    if (!o.inp) continue;
    const a = base.run(o.inp, opts);
    let b;
    if (c.errors && c.errors.length) b = { error: 'The graph has problems' };
    else { const r = RG.run(c, ctxFor(o.inp, opts), { trace: false }); b = r.errors.length ? { error: r.errors[0] } : { list: r.findings.filter((x) => x.rule === S.ruleId).map((x) => brief(x)) }; }
    const ka = a.error ? 'E' : a.list.map((x) => x.key).sort().join('\n'), kb = b.error ? 'E' : b.list.map((x) => x.key).sort().join('\n');
    rows.push({ o, a, b, same: ka === kb });
  }
  const n = rows.length, changed = rows.filter((r) => !r.same).length, found = rows.reduce((t, r) => t + (r.b.list ? r.b.list.length : 0), 0);
  S.cmp = { ok: !(c.errors && c.errors.length), label: base.label, rows, n, changed, found, store: S.test.store };
}
export function renderCompareView() {
  if (!live() || !el.cmp) return;
  const h = ui.h, c = S.cmp, t = S.test;
  const head = h('div', { style: 'display:flex;align-items:baseline;gap:8px;flex-wrap:wrap' }, h('h4', null, 'Today’s orders'), h('span', { class: 'mut sm' }, t.store ? 'Store ' + t.store + ' · open now' + (t.lastScan ? ' · tracker read ' + ui.fmt(t.lastScan) : '') : ''));
  if (!S.rule || !S.rule.perOrder) return put(el.cmp, head, h('p', null, 'Nothing to compare for this rule.'));
  if (t.loading) return put(el.cmp, head, h('p', null, 'Loading orders…'));
  if (!c) return put(el.cmp, head, h('p', null, t.err ? "Couldn't load orders: " + t.err : 'No open orders at this store.'));
  const what = S.hist ? 'this version' : 'this graph';
  const match = !c.ok ? h('div', { class: 'rx-match na' }, 'Fix the graph’s problems to compare it.')
    : c.changed ? h('div', { class: 'rx-match bad' }, c.changed + ' of ' + c.n + ' orders would change · ' + plural(c.found, 'finding') + ' with ' + what)
      : c.label === 'Nothing yet' ? h('div', { class: 'rx-match ok' }, '✓ Nothing raises this rule yet, and this graph raises nothing on the ' + c.n + ' open orders')
        : h('div', { class: 'rx-match ok' }, '✓ Matches the ' + (c.label === 'Code rule' ? 'code rule' : c.label === 'Published' ? 'published rule' : c.label.toLowerCase()) + ' on all ' + c.n + ' open orders · ' + plural(c.found, 'finding'));
  const cell = (x) => (x.error ? h('span', { class: 'pill off', title: x.error }, 'Error') : x.list.length ? x.list.map((f) => h('div', null, h('span', { class: 'pill ' + f.kind }, KIND_NAME[f.kind] || f.kind), h('div', { class: 'sm' }, f.evidence))) : h('span', { class: 'mut' }, '—'));
  const sorted = c.rows.slice().sort((a, b) => (a.same - b.same) || ((b.b.list || []).length - (a.b.list || []).length) || (a.o.wo - b.o.wo));
  put(el.cmp, head, match,
    h('div', { style: 'overflow-x:auto;max-height:520px;overflow-y:auto' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Work order'), h('th', null, c.label), h('th', null, S.hist ? 'This version' : 'This graph'))),
      h('tbody', null, sorted.map((r) => h('tr', { class: [r.same ? '' : 'diff', r.o.wo === S.test.wo ? 'cur' : ''].join(' ').trim() || null, 'data-wo': String(r.o.wo), onclick: () => { S.test.wo = r.o.wo; S.step = null; stopPlay(); runDebug(); renderDebug(); renderCanvas(); renderSide(); } },
        h('td', null, h('span', { class: 'wo' }, '#' + r.o.wo), h('div', { class: 'sm mut' }, (r.o.device || '') + (r.o.status_name ? ' · ' + r.o.status_name : ''))), h('td', null, cell(r.a)), h('td', null, cell(r.b))))))),
    h('p', { class: 'sm' }, 'Runs ' + what + ' and ' + (c.label === 'Code rule' ? 'the code rule' : c.label === 'Nothing yet' ? 'nothing (a new rule)' : 'the ' + c.label.toLowerCase()) + ' side by side on every open order. Click an order to trace it on the canvas.' + (S.test.details && !TK.isUnlocked() ? ' Locked: note checks see no notes until you unlock.' : !S.test.details ? ' Without customer details, note checks see no notes.' : '')));
}
export function renderCompareMarks() { if (el.cmp) for (const tr of el.cmp.querySelectorAll('tbody tr')) tr.classList.toggle('cur', Number(tr.dataset.wo) === S.test.wo); }
