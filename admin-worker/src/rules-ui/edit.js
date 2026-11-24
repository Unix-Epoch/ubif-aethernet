// Admin site, the Assize rules editor (rules-ui.js): changing the graph (undo, add, remove, copy, paste, collapse), validation and the debug run.
// Served at /rules-ui.js?part=edit.
import * as RG from '/rulegraph.js';
import { editable, stopPlay, renderDebug, scheduleSave } from '/rules-ui.js';
import { clone, split, R } from '/rules-ui.js?part=words';
import { S, clip, ui } from '/rules-ui.js?part=state';
import { renderCanvas } from '/rules-ui.js?part=canvas';
import { renderSide } from '/rules-ui.js?part=side';
import { renderCompareSoon } from '/rules-ui.js?part=compare';

// ------------------------------------------------------------------ editing
export function lib() { return { nodes: RG.NODE_TYPES, macros: Object.assign({}, RG.MACROS, (S.graph && S.graph.macros) || {}) }; }
export const shown = () => (S.hist ? S.hist.graph : S.graph);
// The level the canvas shows: the graph, or a macro inside it ({ g, inside, prefix, own, name }).
export function level() {
  const top = shown();
  let g = top, inside = null, prefix = '', own = true, name = null;
  for (const p of S.path) {
    const mine = own && top && top.macros && top.macros[p.macro];
    g = mine || RG.MACROS[p.macro]; own = !!mine; inside = g; prefix += p.node + '/'; name = p.macro;
  }
  return { g, inside, prefix, own, name, edit: editable() && own };
}
export function commit(fn, opts = {}) {
  if (!level().edit) return;
  S.undo.push(JSON.stringify(S.graph)); if (S.undo.length > 200) S.undo.shift();
  S.redo = [];
  fn(level().g);
  changed(opts);
}
function changed(opts = {}) {
  S.step = null; stopPlay();
  validate(); runDebug();
  renderCanvas(); renderDebug(); if (!opts.keepInspector) renderSide(); else renderCompareSoon();
  scheduleSave(); renderCompareSoon();
}
export function undo(back) {
  const from = back ? S.undo : S.redo, to = back ? S.redo : S.undo;
  if (!from.length || !editable()) return;
  to.push(JSON.stringify(S.graph));
  S.graph = JSON.parse(from.pop());
  const lv = level();
  if (!lv.g) S.path = [];
  S.sel = new Set([...S.sel].filter((id) => level().g.nodes.some((n) => n.id === id))); S.wire = null;
  changed();
}
export const nodeById = (g, id) => g.nodes.find((n) => n.id === id);
function newId(g, type) { let i = 1; const base = type.replace(/[^a-zA-Z]/g, '') || 'n'; while (g.nodes.some((n) => n.id === base + i)) i++; return base + i; }
function defaults(type) {
  const def = RG.NODE_TYPES[type], s = {};
  for (const f of def.settings || []) {
    if (f.def !== undefined) s[f.name] = clone(f.def);
    else if (f.req && f.options) s[f.name] = f.options[0];
  }
  if ((type === 'finding') && S.graph.kind) s.kind = S.graph.kind;
  return s;
}
export function addNode(type, x, y, extra) {
  let id = null;
  commit((g) => {
    id = newId(g, type);
    const n = { id, type, x: Math.round(x), y: Math.round(y) };
    const s = Object.assign(defaults(type), extra || {});
    if (Object.keys(s).length) n.settings = s;
    g.nodes.push(n);
  });
  if (id) { S.sel = new Set([id]); S.wire = null; renderCanvas(); renderSide(); }
}
export function removeSelected() {
  if (S.wire) { const w = S.wire; S.wire = null; return commit((g) => { (w.kind === 'x' ? g.flow : g.wires).splice(w.i, 1); }); }
  if (!S.sel.size) return;
  const ids = new Set(S.sel);
  commit((g) => {
    g.nodes = g.nodes.filter((n) => !ids.has(n.id) || n.type === 'macroIn' || n.type === 'macroOut');
    const gone = (ref) => ids.has(split(ref)[0]) && !g.nodes.some((n) => n.id === split(ref)[0]);
    g.wires = (g.wires || []).filter((w) => !gone(w.from) && !gone(w.to));
    if (g.flow) g.flow = g.flow.filter((w) => !gone(w.from) && !gone(w.to));
  });
  S.sel = new Set();
  renderSide();
}
export function copySel() {
  const g = level().g, ids = new Set(S.sel);
  if (!ids.size) return false;
  const inner = (ref) => ids.has(split(ref)[0]);
  clip.nodes = { nodes: clone(g.nodes.filter((n) => ids.has(n.id) && n.type !== 'macroIn' && n.type !== 'macroOut')), wires: clone((g.wires || []).filter((w) => inner(w.from) && inner(w.to))), flow: clone((g.flow || []).filter((w) => inner(w.from) && inner(w.to))) };
  return true;
}
export function paste() {
  if (!clip.nodes || !clip.nodes.nodes.length) return;
  const lv = level(), c = clip.nodes, fresh = [];
  commit((g) => {
    const map = {};
    for (const n of c.nodes) {
      if (lv.inside && RG.NODE_TYPES[n.type] && RG.NODE_TYPES[n.type].exec) continue;
      if (n.type === 'start' && g.nodes.some((x) => x.type === 'start')) continue;
      const id = newId(g, n.type); map[n.id] = id;
      g.nodes.push(Object.assign(clone(n), { id, x: n.x + 40, y: n.y + 40 })); fresh.push(id);
    }
    const re = (ref) => { const [a, p] = split(ref); return map[a] ? map[a] + '.' + p : null; };
    for (const w of c.wires) { const f = re(w.from), t = re(w.to); if (f && t) g.wires.push({ from: f, to: t }); }
    if (!lv.inside) for (const w of c.flow) { const f = re(w.from), t = re(w.to); if (f && t) (g.flow = g.flow || []).push({ from: f, to: t }); }
  });
  for (const n of c.nodes) { n.x += 40; n.y += 40; }
  S.sel = new Set(fresh); renderCanvas(); renderSide();
}
// Collapse the selected pure nodes into a macro of the graph's own (graph.macros), wired the same way.
export function collapse() {
  const lv = level();
  if (lv.inside || !lv.edit) return ui.toast('Collapse works on the top level of the graph.');
  const g = lv.g, ids = new Set(S.sel), sel = g.nodes.filter((n) => ids.has(n.id));
  if (!sel.length) return;
  if (sel.some((n) => !RG.NODE_TYPES[n.type] || RG.NODE_TYPES[n.type].exec)) return ui.toast("Flow nodes (Start, Branch, Stop, Finding) can't go in a macro: macros only work things out.");
  const L = lib(), inSel = (ref) => ids.has(split(ref)[0]);
  const outType = (ref) => { const [a, p] = split(ref), n = nodeById(g, a), pn = n && RG.pinsOf(n, L); const o = pn && pn.outputs.find((x) => x.name === p); return o ? o.type : 'any'; };
  const inType = (ref) => { const [a, p] = split(ref), n = nodeById(g, a), pn = n && RG.pinsOf(n, L); const o = pn && pn.inputs.find((x) => x.name === p); return o ? o.type : 'any'; };
  const uniq = (used, name) => { let k = name.replace(/[^A-Za-z0-9_]/g, '') || 'x', i = 2; const b = k; while (used.has(k)) k = b + i++; used.add(k); return k; };
  const inputs = [], outputs = [], inNames = new Set(), outNames = new Set(), byFrom = new Map(), byOut = new Map();
  for (const w of g.wires) if (!inSel(w.from) && inSel(w.to)) { if (!byFrom.has(w.from)) { const t = outType(w.from), name = uniq(inNames, split(w.to)[1]); byFrom.set(w.from, name); inputs.push({ name, type: t === 'any' ? inType(w.to) : t }); } }
  for (const w of g.wires) if (inSel(w.from) && !inSel(w.to)) { if (!byOut.has(w.from)) { const name = uniq(outNames, split(w.from)[1]); byOut.set(w.from, name); outputs.push({ name, type: outType(w.from) }); } }
  let mname = 'macro1', i = 1; while ((g.macros && g.macros[mname]) || RG.MACROS[mname]) mname = 'macro' + ++i;
  const minX = Math.min(...sel.map((n) => n.x)), minY = Math.min(...sel.map((n) => n.y)), maxX = Math.max(...sel.map((n) => n.x));
  const def = { title: 'Collapsed nodes', inputs, outputs,
    nodes: [...(inputs.length ? [{ id: 'in', type: 'macroIn', x: 30, y: 40 }] : []), ...clone(sel).map((n) => Object.assign(n, { x: n.x - minX + 310, y: n.y - minY + 40 })), { id: 'out', type: 'macroOut', x: maxX - minX + 600, y: 40 }],
    wires: [] };
  // inner ids must not clash with in / out
  const ren = {}; for (const n of def.nodes) if ((n.id === 'in' && n.type !== 'macroIn') || (n.id === 'out' && n.type !== 'macroOut')) { ren[n.id] = n.id + '_'; n.id += '_'; }
  const r = (ref) => { const [a, p] = split(ref); return (ren[a] || a) + '.' + p; };
  for (const w of g.wires) {
    if (inSel(w.from) && inSel(w.to)) def.wires.push({ from: r(w.from), to: r(w.to) });
    else if (!inSel(w.from) && inSel(w.to)) def.wires.push({ from: 'in.' + byFrom.get(w.from), to: r(w.to) });
  }
  for (const [from, name] of byOut) def.wires.push({ from: r(from), to: 'out.' + name });
  let mid = null;
  commit((gg) => {
    mid = newId(gg, 'macro');
    gg.macros = Object.assign({}, gg.macros, { [mname]: def });
    const keep = [];
    for (const w of gg.wires) {
      if (inSel(w.from) && inSel(w.to)) continue;
      if (!inSel(w.from) && inSel(w.to)) continue;
      if (inSel(w.from)) keep.push({ from: mid + '.' + byOut.get(w.from), to: w.to }); else keep.push(w);
    }
    for (const [from, name] of byFrom) keep.push({ from, to: mid + '.' + name });
    gg.wires = keep;
    gg.nodes = gg.nodes.filter((n) => !ids.has(n.id));
    gg.nodes.push({ id: mid, type: 'macro', x: Math.round(minX), y: Math.round(minY), settings: { macro: mname } });
  });
  S.sel = new Set([mid]); renderCanvas(); renderSide();
  ui.toast('Collapsed into a macro. Rename it in the inspector; Expand opens it.');
}

// ------------------------------------------------------------------ validation and the debug run
export function validate() {
  const g = shown();
  S.errors = g ? R.checkGraph(g, S.ruleId) : [];
}
// Errors for the level on screen: node ids and wire refs they name.
export function levelErrors() {
  const lv = level(), pre = lv.name ? 'Macro ' + lv.name + ': ' : '';
  const nodes = new Map(), wires = new Set();
  for (const e of S.errors) {
    let t = e;
    if (pre) { if (!t.startsWith(pre)) continue; t = t.slice(pre.length); } else if (/^Macro \S+: /.test(t)) continue;
    let m = t.match(/^(?:Exec )?[Ww]ire (\S+) → (\S+?):/);
    if (m) { wires.add(m[1] + '>' + m[2]); continue; }
    m = t.match(/^Input (\S+) has more than one wire/) || t.match(/^Exec output (\S+) has/);
    if (m) { const id = split(m[1])[0]; nodes.set(id, t); continue; }
    m = t.match(/^([A-Za-z0-9_-]+)(?: \(|:)/);
    if (m && lv.g && lv.g.nodes.some((n) => n.id === m[1])) nodes.set(m[1], t);
  }
  return { nodes, wires };
}
function inputsOf(o) { return o && o.inp; }
export const curOrder = () => S.test.orders.find((o) => o.wo === S.test.wo) || null;
export const optsFor = (store, now) => ({ now: now || Date.now(), hours: R.hoursFor(store), priceFor: null });
export const ctxFor = (inp, opts) => Object.assign(Object.create(R.GH), { f: R.facts(inp.row, inp.detail), opts });
export function runDebug() {
  const o = curOrder(), inp = inputsOf(o), g = shown();
  if (!inp || !g || !S.rule || !S.rule.perOrder) { S.dbg = null; return; }
  try { S.dbg = RG.run(RG.compile(g), ctxFor(inp, optsFor(S.test.store)), { debug: true }); }
  catch (e) { S.dbg = { errors: [e.message], outcome: { ended: 'error', text: 'The run failed: ' + e.message, raised: 0 }, nodes: {}, steps: [], execWires: [], results: {}, trace: {}, findings: [] }; }
}
