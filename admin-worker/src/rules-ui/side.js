// Admin site, the Assize rules editor (rules-ui.js): the side panel: inspector, history, and the graph inspector.
// Served at /rules-ui.js?part=side.
import * as RG from '/rulegraph.js';
import { live, bindKeys, canEdit, restore, renderAll, titleOf, readOnlyWhy } from '/rules-ui.js';
import { put, ACTION, who, tidyGraph, split, pinLabel, TYPE_NAME, full, plural, CAT, show, R, CHECK_NAME, KIND_NAME, PROGRAMS, OUTCOMES, STATUSES, PATTERNS } from '/rules-ui.js?part=words';
import { ui, el, S } from '/rules-ui.js?part=state';
import { level, nodeById, lib, removeSelected, copySel, paste, collapse, commit, shown } from '/rules-ui.js?part=edit';
import { resultHtml, renderCanvas } from '/rules-ui.js?part=canvas';
import { renderCompareView } from '/rules-ui.js?part=compare';

// ------------------------------------------------------------------ side: inspector, history, today's orders
export function renderSide() {
  if (!live()) return;
  bindKeys();
  const h = ui.h;
  put(el.side, 
    h('div', { class: 'rx-tabs', role: 'tablist' }, [['node', 'Inspector'], ['history', 'History' + (S.rule ? ' (' + S.rule.history.length + ')' : '')]].map(([k, l]) => h('button', { role: 'tab', 'aria-selected': String(S.side === k), class: S.side === k ? 'on' : null, onclick: () => { S.side = k; renderSide(); } }, l))),
    el.ins = h('div', { class: 'rx-ins' }),
    h('div', { class: 'rx-hr' }),
    el.cmp = h('div', { class: 'rx-ins rx-cmp' }));
  if (S.side === 'history') renderHistory(); else renderInspector();
  renderCompareView();
  if (S.refocus) { const x = el.side.querySelector(S.refocus); S.refocus = null; if (x) x.focus(); }
}
function renderHistory() {
  const h = ui.h, r = S.rule;
  if (!r) return put(el.ins, );
  const list = r.history;
  put(el.ins, h('h4', null, 'History'), h('p', null, 'Every publish keeps its graph. Restoring copies it into the draft; it doesn’t publish by itself.'),
    list.length ? h('div', { class: 'rx-hist' }, list.map((x) => h('div', { class: S.hist && S.hist.id === x.id ? 'on' : null },
      h('div', null, h('b', null, (ACTION[x.action] || x.action) + (x.version ? ' · v' + x.version : '')), ' ', h('span', { class: 'pill st' }, x.scope === 'all' ? 'All stores' : x.scope)),
      h('div', { class: 'mut sm' }, who(x.by) + ' · ' + ui.fmt(x.at)), x.note ? h('div', { class: 'sm' }, '“' + x.note + '”') : null,
      x.hasGraph ? h('div', { class: 'a' }, h('button', { class: 'btn sm', onclick: () => viewVersion(x) }, 'View'),
        x.action === 'publish' && canEdit(S.scope) && r.perOrder ? h('button', { class: 'btn sm', onclick: () => restore(x) }, 'Restore as draft') : null) : null))) : h('p', null, 'Nothing yet.'));
}
async function viewVersion(x) {
  try {
    const v = await ui.api('GET', '/tracker/assize/rules/' + S.ruleId + '/history/' + x.id);
    if (v && v.graph) tidyGraph(v.graph);
    S.hist = v; S.path = []; S.sel = new Set(); S.wire = null; S.fitted = '';
    renderAll();
  } catch (e) { ui.toast("Couldn't open that version: " + e.message); }
}
function renderInspector() {
  const h = ui.h, lv = level(), g = lv.g;
  if (!S.rule) return put(el.ins, );
  if (!S.rule.perOrder) return put(el.ins, h('h4', null, S.rule.title), h('p', null, 'Assize checks this one across orders, so it stays in the code. Turn it on or off with the switch above, for all stores or one.'));
  if (!g) return put(el.ins, );
  const edit = lv.edit;
  // a wire
  if (S.wire) {
    const list = S.wire.kind === 'x' ? g.flow : g.wires, w = list && list[S.wire.i];
    if (!w) { S.wire = null; return renderInspector(); }
    const [nid, pn] = split(w.from), n = nodeById(g, nid), pins = n && RG.pinsOf(n, lib(), lv.inside), o = pins && (pins.outputs.find((x) => x.name === pn));
    const type = S.wire.kind === 'x' ? 'exec' : o ? o.type : 'any';
    const v = S.dbg && S.dbg.trace ? S.dbg.trace[lv.prefix + w.from] : undefined;
    const taken = S.wire.kind === 'x' && S.dbg && S.dbg.execWires.find((x) => x.index === S.wire.i);
    return put(el.ins, h('h4', null, S.wire.kind === 'x' ? 'Exec wire' : 'Data wire'),
      h('dl', { class: 'rx-kv' }, h('dt', null, 'From'), h('dd', null, titleOf(n || { type: '?' }) + ' · ' + pinLabel(pn)), h('dt', null, 'To'), h('dd', null, (() => { const t = nodeById(g, split(w.to)[0]); return titleOf(t || { type: '?' }) + ' · ' + pinLabel(split(w.to)[1]); })()),
        h('dt', null, 'Type'), h('dd', null, type === 'exec' ? 'Exec (the order things run in)' : TYPE_NAME[type] || type)),
      S.wire.kind === 'x' ? h('p', null, taken ? 'Taken on this run (step ' + (S.dbg.execWires.indexOf(taken) + 1) + ').' : S.dbg ? 'Not taken on this run.' : '') : h('div', { class: 'rx-fld' }, h('span', null, 'Value on this run'), h('pre', { class: 'rx-pre' }, S.dbg ? full(v) : 'Pick a test order to see it.')),
      edit ? h('button', { class: 'btn sm dg', onclick: removeSelected }, 'Delete wire') : null);
  }
  // several nodes
  if (S.sel.size > 1) {
    return put(el.ins, h('h4', null, plural(S.sel.size, 'node') + ' selected'), h('p', null, 'Drag one to move them all. ⌘C / ⌘V copy and paste, ⌘D duplicates, Delete removes.'),
      edit ? h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, h('button', { class: 'btn sm', onclick: () => { if (copySel()) paste(); } }, 'Duplicate'), !lv.inside ? h('button', { class: 'btn sm', onclick: collapse }, 'Collapse into a node') : null, h('button', { class: 'btn sm dg', onclick: removeSelected }, 'Delete')) : null);
  }
  // one node
  const id = [...S.sel][0], n = id && nodeById(g, id);
  if (!n) return graphInspector(lv);
  const def = RG.NODE_TYPES[n.type];
  if (!def) return put(el.ins, h('h4', null, 'Unknown node “' + n.type + '”'), edit ? h('button', { class: 'btn sm dg', onclick: removeSelected }, 'Delete') : null);
  const key = lv.prefix + n.id, x = S.dbg && S.dbg.nodes ? S.dbg.nodes[key] : null, s = n.settings || {};
  const set = (k, v) => commit((gg) => { const m = nodeById(gg, n.id); m.settings = Object.assign({}, m.settings, { [k]: v }); if (v === undefined) delete m.settings[k]; }, { keepInspector: false });
  const out = [h('div', { class: 'mut sm' }, (CAT[def.cat] || ['', ''])[1] + ' node · ' + def.title), h('h4', null, titleOf(n)), h('p', null, def.desc)];
  const STATE = { ran: 'Ran on this order', used: 'Worked out on this order (something that ran needed it)', idle: 'Not needed on this order (worked out only to show its values)', notReached: 'Execution never reached it on this order', error: 'Failed on this order' };
  if (x) out.push(h('p', null, h('b', null, STATE[x.state] || x.state), x.error ? ': ' + x.error : '', x.needsNotes ? ' · needs notes this order doesn’t have here' : ''));
  if (edit) out.push(h('label', { class: 'rx-fld' }, h('span', null, 'Name on the canvas'), h('input', { type: 'text', value: n.label || '', placeholder: def.title, maxlength: 80, onchange: (e) => commit((gg) => { const m = nodeById(gg, n.id), v = e.target.value.trim(); if (v) m.label = v; else delete m.label; }) })));
  for (const f of def.settings || []) out.push(field(n, f, s, set, edit, lv));
  if (n.type === 'finding' || n.type === 'reminder') {
    const sig = ['sig1', 'sig2', 'sig3'].map((k) => [k, (g.wires || []).find((w) => w.to === n.id + '.' + k)]).filter(([, w]) => w);
    out.push(h('div', { class: 'rx-fld' }, h('span', null, 'Dismissal signature'), h('p', null, sig.length ? 'A dismissal stops applying when any of these change: ' + sig.map(([, w]) => titleOf(nodeById(g, split(w.from)[0]) || { type: '?' }) + ' · ' + pinLabel(split(w.from)[1])).join(', ') + '.' : 'Nothing wired to Signature 1–3: a dismissal keeps applying even when the order’s facts change.')),
      h('p', { class: 'sm' }, 'Raises rule ', h('b', null, S.ruleId), '. When it should match a code rule, the signature must use the same facts in the same order.'));
    const r = S.dbg && S.dbg.results && S.dbg.results[n.id];
    if (r) out.push(h('div', { class: 'rx-fld' }, h('span', null, 'On this order'), h('div', { html: resultHtml(r, x && x.state) })));
  }
  if (n.type === 'macro') {
    const m = lib().macros[s.macro], own = !!(shown().macros || {})[s.macro];
    out.push(h('button', { class: 'btn sm', onclick: () => { S.path.push({ node: n.id, macro: s.macro }); S.sel = new Set(); S.fitted = ''; renderCanvas(); renderSide(); } }, own && edit ? 'Expand and edit' : 'Expand (read only)'));
    if (m && own && edit) out.push(h('label', { class: 'rx-fld' }, h('span', null, 'Macro title'), h('input', { type: 'text', value: m.title || '', onchange: (e) => commit(() => { S.graph.macros[s.macro].title = e.target.value.trim() || s.macro; }) })));
  }
  // values on its pins
  const pins = RG.pinsOf(n, lib(), lv.inside), tr = (S.dbg && S.dbg.trace) || {};
  if (pins && S.dbg && pins.outputs.length) out.push(h('div', { class: 'rx-fld' }, h('span', null, 'Outputs on this order'), h('dl', { class: 'rx-kv' }, pins.outputs.flatMap((p) => [h('dt', null, pinLabel(p.name)), h('dd', { title: full(tr[key + '.' + p.name]) }, (show(tr[key + '.' + p.name], p.type) || { t: '—' }).t)]))));
  if (edit) out.push(h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, n.type !== 'start' ? h('button', { class: 'btn sm', onclick: () => { if (copySel()) paste(); } }, 'Duplicate') : null, h('button', { class: 'btn sm dg', onclick: removeSelected }, 'Delete node')));
  put(el.ins, ...out);
}
function graphInspector(lv) {
  const h = ui.h, g = lv.g, edit = lv.edit, out = [];
  if (lv.inside) {
    const m = g;
    out.push(h('div', { class: 'mut sm' }, 'Macro'), h('h4', null, m.title || lv.name), h('p', null, m.desc || 'A collapsed set of nodes. Its inputs and outputs are the pins on the collapsed node.'));
    if (edit) {
      out.push(h('label', { class: 'rx-fld' }, h('span', null, 'Title'), h('input', { type: 'text', value: m.title || '', onchange: (e) => commit((gg) => { gg.title = e.target.value.trim() || lv.name; }) })));
      for (const side of ['inputs', 'outputs']) {
        out.push(h('div', { class: 'rx-fld' }, h('span', null, side === 'inputs' ? 'Inputs' : 'Outputs'),
          ...(m[side] || []).map((p, i) => h('div', { style: 'display:flex;gap:6px' },
            h('input', { type: 'text', value: p.name, 'aria-label': 'Name', style: 'flex:1', onchange: (e) => { const v = e.target.value.trim().replace(/[^A-Za-z0-9_]/g, ''); if (v) commit((gg) => { const old = gg[side][i].name; gg[side][i].name = v; const port = side === 'inputs' ? 'macroIn' : 'macroOut'; const pn = gg.nodes.find((x) => x.type === port); if (pn) for (const w of gg.wires) { if (side === 'inputs' && w.from === pn.id + '.' + old) w.from = pn.id + '.' + v; if (side === 'outputs' && w.to === pn.id + '.' + old) w.to = pn.id + '.' + v; } }); } }),
            h('select', { 'aria-label': 'Type', onchange: (e) => commit((gg) => { gg[side][i].type = e.target.value; }) }, RG.TYPES.map((t) => { const o = h('option', { value: t }, TYPE_NAME[t]); o.selected = t === p.type; return o; })),
            h('button', { class: 'btn sm', 'aria-label': 'Remove', onclick: () => commit((gg) => { gg[side].splice(i, 1); }) }, '×'))),
          h('button', { class: 'btn sm', onclick: () => commit((gg) => { gg[side] = gg[side] || []; gg[side].push({ name: (side === 'inputs' ? 'in' : 'out') + (gg[side].length + 1), type: 'bool' }); }) }, '+ Add ' + (side === 'inputs' ? 'an input' : 'an output'))));
      }
    } else out.push(h('p', { class: 'sm' }, lv.own ? '' : 'Built into Aethernet: read only. Copy its nodes (⌘C) into your graph to change them.'));
    return put(el.ins, ...out);
  }
  out.push(h('div', { class: 'mut sm' }, 'Graph'), h('h4', null, g.title || S.rule.title),
    h('p', null, 'Click a node to change it. Drag from a pin to another to wire them; right-click the canvas to add a node. Shift-drag selects a box.'));
  out.push(h('label', { class: 'rx-fld' }, h('span', null, 'Title'), h('input', { type: 'text', value: g.title || '', disabled: !edit, maxlength: 80, onchange: (e) => commit((gg) => { gg.title = e.target.value.trim(); }) })),
    h('label', { class: 'rx-fld' }, h('span', null, 'Section'), (() => { const sl = h('select', { disabled: !edit, onchange: (e) => commit((gg) => { gg.check = e.target.value; }) }, R.CHECKS.map(([k, nm]) => h('option', { value: k }, nm))); sl.value = g.check || ''; return sl; })()),
    h('dl', { class: 'rx-kv' }, h('dt', null, 'Rule id'), h('dd', null, S.ruleId), h('dt', null, 'Nodes'), h('dd', null, String(g.nodes.length + Object.values(g.macros || {}).reduce((t, m) => t + (m.nodes || []).length, 0)) + ' of ' + R.MAX_GRAPH_NODES)),
    h('p', { class: 'sm' }, 'Title and section are what a finding uses when its own are blank.'));
  if (readOnlyWhy()) out.push(h('p', { class: 'sm' }, h('b', null, 'Read only: '), readOnlyWhy()));
  put(el.ins, ...out);
}
// One setting's editor.
function field(n, f, s, set, edit, lv) {
  const h = ui.h, v = s[f.name], label = (t) => h('span', null, t);
  const name = { programs: 'Programs', statuses: 'Statuses', outcomes: 'Outcomes', match: 'Match', words: 'Words and phrases', skipNegated: 'Skip negated mentions', pattern: 'Pattern', limit: 'Limit', min: 'Min', max: 'Max', b: 'B', tolerance: 'Tolerance', type: 'Type', value: 'Value',
    text: 'Text', then1: 'Then 1', then2: 'Then 2', then3: 'Then 3', else: 'Else', credit: 'Partner credits', neverFlag: 'Misc labor and buybacks', deposit: 'Deposit offsets', price: 'Price', skus: 'SKUs', names: 'Line names', kind: 'Kind', title: 'Title', check: 'Section', rule: 'Rule', evidence: 'Evidence', macro: 'Macro' }[f.name] || pinLabel(f.name);
  const g = lv.g, wired = (g.wires || []).some((w) => w.to === n.id + '.' + f.name);
  if (f.name === 'rule' && (n.type === 'finding' || n.type === 'reminder')) return null;
  if (wired && ['limit', 'min', 'max', 'b', 'then1', 'then2', 'then3', 'else', 'evidence'].includes(f.name)) return h('div', { class: 'rx-fld' }, label(name), h('p', null, 'Comes from its wire.'));
  if (f.name === 'check' && (n.type === 'finding' || n.type === 'reminder')) {
    const sl = h('select', { disabled: !edit, onchange: (e) => set('check', e.target.value || undefined) }, h('option', { value: '' }, 'The graph’s (' + (CHECK_NAME[n.type === 'reminder' ? 'remind' : g.check] || '?') + ')'), R.CHECKS.map(([k, nm]) => h('option', { value: k }, nm)));
    sl.value = v || ''; return h('label', { class: 'rx-fld' }, label(name), sl);
  }
  if (f.name === 'title' && (n.type === 'finding' || n.type === 'reminder')) return h('label', { class: 'rx-fld' }, label(name), h('input', { type: 'text', value: v || '', placeholder: 'The graph’s: ' + (g.title || ''), disabled: !edit, maxlength: 80, onchange: (e) => set('title', e.target.value.trim() || undefined) }));
  if (f.name === 'kind' && n.type === 'finding') return h('div', { class: 'rx-fld' }, label(name), h('div', { class: 'rx-seg', role: 'group' }, RG.KINDS.map((k) => h('button', { class: (v || 'note') === k ? 'on' : null, disabled: !edit, onclick: () => set('kind', k) }, KIND_NAME[k]))));
  if (f.type === 'list') {
    const list = Array.isArray(v) ? v : [];
    if (f.name === 'programs') return h('div', { class: 'rx-fld' }, label(name), h('div', { class: 'rx-opts' }, PROGRAMS.map(([k, l]) => h('button', { class: list.includes(k) ? 'on' : null, disabled: !edit, title: k, onclick: () => set('programs', list.includes(k) ? list.filter((x) => x !== k) : list.concat(k)) }, l))));
    if (f.name === 'outcomes') return h('div', { class: 'rx-fld' }, label(name + ' (none: any)'), h('div', { class: 'rx-opts' }, OUTCOMES.map((k) => h('button', { class: list.includes(k) ? 'on' : null, disabled: !edit, onclick: () => set('outcomes', list.includes(k) ? list.filter((x) => x !== k) : list.concat(k)) }, k))));
    const dl = f.name === 'statuses' ? 'rx-statuses' : null;
    const add = h('input', { type: 'text', placeholder: edit ? 'Add, then press Enter' : '', disabled: !edit, list: dl, 'data-chip': n.id + '.' + f.name, 'aria-label': 'Add to ' + name,
      onkeydown: (e) => { if (e.key === 'Enter' && e.target.value.trim()) { e.preventDefault(); const w = e.target.value.trim(); if (!list.some((x) => String(x).toLowerCase() === w.toLowerCase())) { S.refocus = '[data-chip="' + n.id + '.' + f.name + '"]'; set(f.name, list.concat(f.name === 'statuses' ? w.toLowerCase() : w)); } else e.target.value = ''; } else if (e.key === 'Backspace' && !e.target.value && list.length) { S.refocus = '[data-chip="' + n.id + '.' + f.name + '"]'; set(f.name, list.slice(0, -1)); } } });
    return h('div', { class: 'rx-fld' }, label(name + (f.name === 'statuses' ? ' (none: any)' : '')),
      h('div', { class: 'rx-chips' }, list.map((w, i) => h('span', null, String(w), edit ? h('button', { 'aria-label': 'Remove ' + w, onclick: () => set(f.name, list.filter((_, j) => j !== i)) }, '×') : null)), add),
      dl ? h('datalist', { id: dl }, STATUSES.map((x) => h('option', { value: x.toLowerCase() }))) : null,
      f.name === 'words' ? h('p', { class: 'sm' }, 'Whole words, any capitalization. No patterns: each is matched as written.') : null);
  }
  if (f.type === 'enum') {
    const opts = f.options || [], cur = v ?? f.def;
    const lbl = (o) => ({ any: 'Ignore', keep: 'Keep only', drop: 'Drop', exact: 'Whole name', contains: 'Contains', positive: 'Positive', negative: 'Negative', nonzero: 'Not $0', num: 'Number', text: 'Text', bool: 'Yes / no', phone: 'Phone', foldable: 'Foldable', wearable: 'Wearable', tv: 'TV' }[o] || o);
    return h('div', { class: 'rx-fld' }, label(name), h('div', { class: 'rx-seg', role: 'group' }, opts.map((o) => h('button', { class: cur === o ? 'on' : null, disabled: !edit, onclick: () => set(f.name, o) }, lbl(o)))), f.desc ? h('p', { class: 'sm' }, f.desc) : null);
  }
  if (f.type === 'pattern') {
    const sl = h('select', { disabled: !edit, onchange: (e) => set(f.name, e.target.value) }, (f.options || []).map((o) => h('option', { value: o }, PATTERNS[o] || o)));
    sl.value = v || ''; return h('label', { class: 'rx-fld' }, label(name), sl, h('p', { class: 'sm' }, 'Built-in patterns only (the same ones the code uses).'));
  }
  if (f.type === 'macro') {
    const sl = h('select', { disabled: !edit, onchange: (e) => set('macro', e.target.value) }, Object.entries(lib().macros).map(([k, m]) => h('option', { value: k }, m.title || k)));
    sl.value = v || ''; return h('label', { class: 'rx-fld' }, label(name), sl);
  }
  if (f.type === 'bool') return h('label', { class: 'rx-ck' }, h('input', { type: 'checkbox', checked: v === undefined ? !!f.def : !!v, disabled: !edit, onchange: (e) => set(f.name, e.target.checked) }), name);
  if (f.type === 'num') return h('label', { class: 'rx-fld' }, label(name), h('input', { type: 'number', step: 'any', value: v ?? f.def ?? 0, disabled: !edit, onchange: (e) => set(f.name, Number(e.target.value) || 0) }));
  // text
  if (n.type === 'constant' && f.name === 'value' && s.type === 'bool') return h('label', { class: 'rx-ck' }, h('input', { type: 'checkbox', checked: v === true || v === 'true', disabled: !edit, onchange: (e) => set('value', e.target.checked) }), 'Yes');
  const inp = h('input', { type: n.type === 'constant' && (s.type || 'num') === 'num' ? 'number' : 'text', value: v == null ? '' : String(v), disabled: !edit, placeholder: f.desc || '', onchange: (e) => set(f.name, n.type === 'constant' && (s.type || 'num') === 'num' ? Number(e.target.value) || 0 : e.target.value) });
  return h('label', { class: 'rx-fld' }, label(name), inp, n.type === 'template' ? h('p', { class: 'sm' }, 'Each {name} becomes an input pin; its value goes in that spot.') : null);
}
