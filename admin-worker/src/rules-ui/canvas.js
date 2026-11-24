// Admin site, the Assize rules editor (rules-ui.js): the canvas: nodes, wires, pan / zoom / select / drag / wire, and the add-node palette.
// Served at /rules-ui.js?part=canvas.
import * as RG from '/rulegraph.js';
import { esc } from '/esc.js';
import { live, titleOf, scheduleSave } from '/rules-ui.js';
import { TYPE_NAME, put, coord, CAT, pinLabel, show, ptype, KIND_NAME, PROGRAMS, PATTERNS, CHECK_NAME, plural, split, fits, CAT_ORDER } from '/rules-ui.js?part=words';
import { ui, el, S } from '/rules-ui.js?part=state';
import { level, lib, levelErrors, addNode, shown, undo, nodeById, commit } from '/rules-ui.js?part=edit';
import { renderSide } from '/rules-ui.js?part=side';

// ------------------------------------------------------------------ canvas
export function buildStage() {
  const h = ui.h, st = el.stage;
  el.world = h('div', { class: 'rx-world' });
  el.world.innerHTML = '<svg class="rx-wires" width="10" height="10"></svg>';
  el.svg = el.world.firstChild;
  el.nodes = h('div');
  el.world.append(el.nodes);
  el.crumbs = h('div', { class: 'rx-crumbs', hidden: true });
  el.tools = h('div', { class: 'rx-tools' });
  el.legend = h('div', { class: 'rx-legend', 'aria-label': 'Wire types' }, h('span', null, h('i', { class: 'x' }), 'Exec'), ['bool', 'num', 'text', 'lines', 'notes', 'person'].map((t) => h('span', null, h('i', { style: 'background:var(--t-' + t + ')' }), TYPE_NAME[t])));
  el.hint = h('div', { class: 'rx-hint', hidden: true });
  el.pal = h('div', { class: 'rx-pal', hidden: true });
  el.box = h('div', { class: 'rx-box', hidden: true });
  put(st, el.world, el.crumbs, el.tools, el.legend, el.hint, el.pal, el.box);
  wireStage();
}
function applyView() { if (el.world) el.world.style.transform = 'translate(' + S.view.x + 'px,' + S.view.y + 'px) scale(' + S.view.z + ')'; }
function fit() {
  const g = level().g, W = el.stage.clientWidth, H = el.stage.clientHeight;
  if (!g || !g.nodes.length) { S.view = { x: 40, y: 60, z: 0.9 }; return applyView(); }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of g.nodes) { const e = el.nodes.querySelector('[data-node="' + CSS.escape(n.id) + '"]'); const w = e ? e.offsetWidth : 224, hh = e ? e.offsetHeight : 120; x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + w); y1 = Math.max(y1, n.y + hh); }
  const top = 50, bot = 40;
  const z = Math.max(0.25, Math.min(1.1, (W - 40) / (x1 - x0), (H - top - bot) / (y1 - y0)));
  S.view = { z, x: (W - (x1 - x0) * z) / 2 - x0 * z, y: top + Math.max(0, (H - top - bot - (y1 - y0) * z) / 2) - y0 * z };
  applyView();
}
function zoomAt(f, cx, cy) {
  const z = Math.max(0.2, Math.min(2, S.view.z * f));
  S.view.x = cx - (cx - S.view.x) * (z / S.view.z); S.view.y = cy - (cy - S.view.y) * (z / S.view.z); S.view.z = z;
  applyView();
}
// A client point → world coordinates.
function toWorld(cx, cy) { const r = el.stage.getBoundingClientRect(); return { x: (cx - r.left - S.view.x) / S.view.z, y: (cy - r.top - S.view.y) / S.view.z }; }

// State of a node on screen (the debug run, stepped).
function stateOf(key, isExec, id) {
  const d = S.dbg;
  if (!d || !d.nodes) return null;
  const x = d.nodes[key];
  if (!x) return null;
  if (S.step == null || S.step >= d.steps.length) return x.state;
  const cur = d.steps[S.step];
  if (isExec && !key.includes('/')) {
    const idx = d.steps.findIndex((s) => s.node === id);
    if (idx === -1) return x.state === 'ran' ? 'pending' : x.state;
    return idx < S.step ? 'ran' : idx === S.step ? 'cur' : 'pending';
  }
  if (x.state === 'used' || x.state === 'error') return x.order != null && x.order <= cur.at ? x.state : 'pending';
  return x.state;
}
export function renderCanvas() {
  if (!live() || !el.stage) return;
  const lv = level(), g = lv.g, h = ui.h;
  if (!S.rule || !S.rule.perOrder || !g) {
    el.nodes.innerHTML = ''; el.svg.innerHTML = '';
    el.hint.hidden = false;
    put(el.hint, h('div', null, h('b', null, S.rule && !S.rule.perOrder ? 'No graph for this rule' : 'Nothing to show'), S.rule && !S.rule.perOrder ? 'It looks across orders. Use the On / Off switch above.' : ''));
    put(el.tools, ); el.crumbs.hidden = true;
    return;
  }
  const L = lib(), bad = levelErrors(), d = S.dbg, edit = lv.edit;
  const wired = new Set([...(g.wires || []).flatMap((w) => [w.from, w.to]), ...(g.flow || []).flatMap((w) => [w.from, w.to])]);
  const trace = (d && d.trace) || {};
  const valOf = (ref) => trace[lv.prefix + ref];
  let html = '';
  for (const n of g.nodes) {
    const def = RG.NODE_TYPES[n.type];
    if (!def) { html += '<div class="rx-node bad" data-node="' + esc(n.id) + '" style="left:' + coord(n.x) + 'px;top:' + coord(n.y) + 'px"><div class="nh"><b>Unknown node “' + esc(n.type) + '”</b></div></div>'; continue; }
    const pins = RG.pinsOf(n, L, lv.inside) || { inputs: [], outputs: [], exec: null };
    const key = lv.prefix + n.id, x = d && d.nodes ? d.nodes[key] : null;
    const st = stateOf(key, !!def.exec, n.id);
    const cls = ['rx-node', ['finding', 'reminder', 'chooseText', 'template'].includes(n.type) ? 'wide' : '', S.sel.has(n.id) ? 'sel' : '', bad.nodes.has(n.id) ? 'bad' : '',
      st === 'cur' ? 's-ran cur' : st ? 's-' + st : ''].filter(Boolean).join(' ');
    const [catName] = CAT[def.cat] || ['', ''];
    const title = S.renaming === n.id ? '<input data-rename="' + esc(n.id) + '" value="' + esc(n.label || '') + '" placeholder="' + esc(titleOf(Object.assign({}, n, { label: '' }))) + '" maxlength="80" aria-label="Node name">' : '<b title="' + esc(titleOf(n)) + (edit ? ' · double-click to rename' : '') + '">' + esc(titleOf(n)) + '</b>';
    let rows = '';
    // exec pins
    if (def.exec) {
      const outs = def.exec.outs, arrow = '<svg width="13" height="14" viewBox="0 0 13 14"><path d="M1.5 1.5h5.5l4.5 5.5-4.5 5.5H1.5z"/></svg>';
      for (let i = 0; i < Math.max(1, outs.length); i++) {
        const o = outs[i];
        const inPin = i === 0 && def.exec.in ? '<span class="pin x xl' + (wired.has(n.id + '.in') ? ' on' : '') + '" data-pin="' + esc(n.id) + '.in" data-dir="xin" title="Exec in">' + arrow + '</span>' : '';
        const outPin = o ? '<span class="lab" style="margin-left:auto">' + (o === 'then' ? '' : esc(pinLabel(o))) + '</span><span class="pin x xo' + (wired.has(n.id + '.' + o) ? ' on' : '') + '" data-pin="' + esc(n.id) + '.' + esc(o) + '" data-dir="xout" title="Exec out' + (o === 'then' ? '' : ': ' + esc(o)) + '">' + arrow + '</span>' : '';
        rows += '<div class="rw xr">' + inPin + outPin + '</div>';
      }
    }
    for (const p of pins.inputs) {
      const ref = n.id + '.' + p.name, w = (g.wires || []).find((x) => x.to === ref);
      const v = S.showVals && w ? show(valOf(w.from), p.type) : null;
      rows += '<div class="rw i"><span class="pin d' + (w ? ' on' : '') + '" data-pin="' + esc(ref) + '" data-dir="in" data-type="' + ptype(p.type) + '" style="--pc:var(--t-' + ptype(p.type) + ')" title="' + esc(TYPE_NAME[ptype(p.type)]) + (p.req ? ' · required' : '') + '"></span><span class="lab">' + esc(pinLabel(p.name)) + (p.req && !w ? ' *' : '') + '</span>' + (v ? '<span class="val ' + (v.c || '') + '">' + esc(v.t) + '</span>' : '') + '</div>';
    }
    rows += summary(n, def, lv);
    let outs = pins.outputs;
    const many = outs.length > 8, open = S.morePins.has(key), anyWired = outs.some((p) => wired.has(n.id + '.' + p.name));
    if (many && !open && anyWired) outs = outs.filter((p) => wired.has(n.id + '.' + p.name));
    for (const p of outs) {
      const ref = n.id + '.' + p.name, v = S.showVals ? show(valOf(ref), p.type) : null;
      rows += '<div class="rw o">' + (v ? '<span class="val ' + (v.c || '') + '">' + esc(v.t) + '</span>' : '') + '<span class="lab">' + esc(pinLabel(p.name)) + '</span><span class="pin d' + (wired.has(ref) ? ' on' : '') + '" data-pin="' + esc(ref) + '" data-dir="out" data-type="' + ptype(p.type) + '" style="--pc:var(--t-' + ptype(p.type) + ')" title="' + esc(TYPE_NAME[ptype(p.type)]) + '"></span></div>';
    }
    if (many && anyWired) rows += '<button class="more" data-more="' + esc(key) + '">' + (open ? 'Hide unwired pins' : 'Show all ' + pins.outputs.length + ' pins') + '</button>';
    if (n.type === 'macro') rows += '<button class="exp" data-expand="' + esc(n.id) + '">Expand ›</button>';
    if ((n.type === 'finding' || n.type === 'reminder') && d && d.results) rows += resultHtml(d.results[n.id], st);
    if (x && x.needsNotes && (Array.isArray(x.needsNotes) ? x.needsNotes.some((k) => wired.has(n.id + '.' + k)) : ['ran', 'used'].includes(x.state))) rows += '<span class="nn" title="Reads notes this order doesn’t have here">needs notes</span>';
    if (x && x.error) rows += '<div class="er">⚠ ' + esc(x.error) + '</div>';
    html += '<div class="' + cls + '" data-node="' + esc(n.id) + '" style="left:' + coord(n.x) + 'px;top:' + coord(n.y) + 'px"' + (x && x.error ? ' title="' + esc(x.error) + '"' : '') + '><div class="nh"><i class="c" style="background:var(--c-' + def.cat + ')"></i>' + title + '<small>' + esc(CAT[def.cat] ? CAT[def.cat][1] : catName) + '</small></div><div class="nb">' + rows + '</div></div>';
  }
  el.nodes.innerHTML = html;
  measure(); drawWires();
  // the rename box
  const ri = el.nodes.querySelector('[data-rename]');
  if (ri) { ri.focus(); ri.select(); }
  // empty graph hint, macro crumbs, tools
  const empty = !g.nodes.length;
  el.hint.hidden = !empty;
  if (empty) put(el.hint, h('div', null, h('b', null, 'An empty graph'), edit ? 'Start with a Start node: the run begins there. Right-click (or long-press) the canvas, or use + Add node.' : 'Nothing drawn yet.',
    edit && !lv.inside ? h('div', { style: 'margin-top:10px' }, h('button', { class: 'btn sm p', onclick: () => addNode('start', 40, 40) }, 'Add a Start node')) : null));
  el.crumbs.hidden = !S.path.length;
  if (S.path.length) {
    const items = [h('button', { onclick: () => { S.path = []; S.sel = new Set(); S.fitted = ''; renderCanvas(); renderSide(); } }, shown().title || S.rule.title)];
    S.path.forEach((p, i) => { items.push(h('span', { class: 'mut' }, '›')); const m = lib().macros[p.macro] || {}; items.push(i === S.path.length - 1 ? h('b', null, m.title || p.macro) : h('button', { onclick: () => { S.path = S.path.slice(0, i + 1); S.sel = new Set(); S.fitted = ''; renderCanvas(); renderSide(); } }, m.title || p.macro)); });
    items.push(h('span', { class: 'mut sm' }, lv.own ? (lv.edit ? '· this graph’s own macro' : '') : '· built in, read only'));
    put(el.crumbs, ...items);
  }
  const t = (label, attrs) => h('button', attrs, label);
  put(el.tools, 
    edit ? t('+ Add node', { 'aria-expanded': String(!!S.pal), onclick: (e) => { e.stopPropagation(); if (S.pal) closePal(); else { const r = el.stage.getBoundingClientRect(); openPal(r.right - 290, r.top + 46, toWorld(r.left + r.width / 2, r.top + r.height / 2)); } } }) : null,
    edit ? t('Select', { class: S.selectMode ? 'on' : null, title: 'Drag to select a box of nodes (or hold Shift and drag)', 'aria-pressed': String(S.selectMode), onclick: () => { S.selectMode = !S.selectMode; renderCanvas(); } }) : null,
    edit ? t('↶', { title: 'Undo (⌘Z)', 'aria-label': 'Undo', disabled: !S.undo.length, onclick: () => undo(true) }) : null,
    edit ? t('↷', { title: 'Redo (⇧⌘Z)', 'aria-label': 'Redo', disabled: !S.redo.length, onclick: () => undo(false) }) : null,
    t('−', { 'aria-label': 'Zoom out', onclick: () => zoomAt(1 / 1.2, el.stage.clientWidth / 2, el.stage.clientHeight / 2) }),
    t('+', { 'aria-label': 'Zoom in', onclick: () => zoomAt(1.2, el.stage.clientWidth / 2, el.stage.clientHeight / 2) }),
    t('Fit', { onclick: fit }));
  el.stage.classList.toggle('boxing', S.selectMode);
  const fk = S.ruleId + '|' + S.scope + '|' + S.path.map((p) => p.node).join('/') + '|' + (S.hist ? S.hist.id : '');
  if (S.fitted !== fk && el.stage.clientWidth) { S.fitted = fk; fit(); } else applyView();
  renderProblems();
}
export function resultHtml(r, st) {
  if (!r) return st === 'notReached' ? '<div class="res off">Not reached</div>' : '';
  const kind = r.kind ? '<span class="pill ' + esc(r.kind) + '">' + esc(KIND_NAME[r.kind] || r.kind) + '</span> ' : '';
  const blame = r.who ? ' · blames ' + esc(r.who.name || r.who.label || 'Unassigned') : '';
  if (r.error) return '<div class="res on"><b>Error:</b> ' + esc(r.error) + '</div>';
  const what = kind + '<b>' + esc(r.title || '') + '</b><br>' + esc(r.evidence || '(no evidence text)') + blame;
  if (r.raised) return '<div class="res on"><b>Raised:</b> ' + what + '</div>';
  if (!r.reached && r.wouldRaise) return '<div class="res would"><b>Not reached — would raise:</b> ' + what + '</div>';
  if (!r.reached) return '<div class="res off"><b>Not reached</b> · When is no, so it wouldn’t raise either<br><span>' + esc(r.evidence || '') + '</span></div>';
  return '<div class="res off"><b>Wouldn’t raise</b> (When is no)<br><span>Evidence it would use: ' + esc(r.evidence || '(none)') + '</span></div>';
}
// A node's settings, shortly, on the node itself.
function summary(n, def, lv) {
  const s = n.settings || {}, g = lv.g;
  const unwired = (k) => !(g.wires || []).some((w) => w.to === n.id + '.' + k);
  const chips = (list, f) => { const a = (list || []).slice(0, 8).map((x) => '<span>' + esc(f ? f(x) : x) + '</span>').join(''); return '<div class="ch">' + (a || '<span>(none)</span>') + ((list || []).length > 8 ? '<span>+' + (list.length - 8) + '</span>' : '') + '</div>'; };
  const box = (x) => '<div class="set">' + x + '</div>';
  switch (n.type) {
    case 'programIs': return box('One of ' + chips(s.programs, (k) => (PROGRAMS.find((p) => p[0] === k) || [k, k])[1]));
    case 'statusIs': return box(((s.statuses || []).length ? 'Status ' + (s.match === 'contains' ? 'contains' : 'is') + ' ' + chips(s.statuses) : 'Any status') + ((s.outcomes || []).length ? 'Outcome ' + chips(s.outcomes) : ''));
    case 'deviceIs': return box('Is a ' + esc(s.kind || 'phone'));
    case 'notesMention': return box('Any of ' + chips(s.words) + (s.skipNegated !== false ? '<span class="mut">Skips negated (“no water”)</span>' : ''));
    case 'matchesPattern': return box(esc(PATTERNS[s.pattern] || s.pattern || 'No pattern') + (s.skipNegated ? '<br><span class="mut">Skips negated</span>' : ''));
    case 'atMost': case 'atLeast': return unwired('limit') ? box((n.type === 'atMost' ? '≤ ' : '≥ ') + esc(s.limit ?? 0)) : '';
    case 'between': return box(esc(unwired('min') ? s.min ?? 0 : 'min') + ' ≤ value ≤ ' + esc(unwired('max') ? s.max ?? 0 : 'max'));
    case 'equals': return unwired('b') ? box('= ' + esc(s.b ?? 0) + (Number(s.tolerance) ? ' ± ' + esc(s.tolerance) : '')) : '';
    case 'subtract': return unwired('b') ? box('− ' + esc(s.b ?? 0)) : '';
    case 'constant': return box((s.type || 'num') === 'text' ? '“' + esc(s.value || '') + '”' : esc(s.value ?? 0));
    case 'template': return box('“' + esc(s.text || '').replace(/\{(\w+)\}/g, '<b>{$1}</b>') + '”');
    case 'chooseText': return box(['then1', 'then2', 'then3', 'else'].filter((k) => unwired(k) && s[k] != null && s[k] !== '').map((k) => esc(pinLabel(k)) + ' → “' + esc(s[k]) + '”').join('<br>') || '<span class="mut">Texts come from the wires</span>');
    case 'filterLines': {
      const bits = ['credit', 'neverFlag', 'deposit'].filter((k) => s[k] && s[k] !== 'any').map((k) => (s[k] === 'drop' ? 'drop ' : 'keep only ') + { credit: 'partner credits', neverFlag: 'misc labor / buybacks', deposit: 'deposits' }[k]);
      if (s.price && s.price !== 'any') bits.push(s.price === 'above' ? 'prices above ' + (s.above ?? 0) : s.price + ' prices');
      const what = [...(s.skus || []), ...(s.names || []).map((x) => (s.nameMatch === 'contains' ? '…' + x + '…' : x)), ...(s.types || []).map((x) => 'type ' + x)];
      if (what.length) bits.push((s.match === 'drop' ? 'drop ' : 'keep ') + what.join(', '));
      return box(esc(bits.join(' · ') || 'Every line'));
    }
    case 'finding': case 'reminder': {
      const kind = n.type === 'reminder' ? 'remind' : KIND_NAME[s.kind] ? s.kind : 'note';
      return box('<span class="pill ' + kind + '">' + KIND_NAME[kind] + '</span> <b>' + esc(s.title || g.title || '') + '</b><br><span class="mut">' + esc(CHECK_NAME[s.check || (n.type === 'reminder' ? 'remind' : g.check)] || s.check || g.check || 'No section') + (unwired('evidence') && s.evidence ? ' · “' + esc(s.evidence) + '”' : '') + '</span>');
    }
    case 'above': case 'below': return unwired('limit') ? box((n.type === 'above' ? '> ' : '< ') + esc(s.limit ?? 0)) : '';
    case 'add': case 'max': case 'min': return unwired('b') ? box({ add: '+ ', max: 'At least ', min: 'At most ' }[n.type] + esc(s.b ?? 0)) : '';
    case 'chooseNum': return box(['then', 'else'].filter(unwired).map((k) => esc(pinLabel(k)) + ' → ' + esc(s[k] ?? 0)).join('<br>') || '<span class="mut">Numbers come from the wires</span>');
    case 'isBlank': return s.trim === false ? box('Spaces are not blank') : '';
    case 'textIs': return box('Text ' + ({ contains: 'contains', starts: 'starts with' }[s.match] || 'is') + ' ' + chips(s.values));
    case 'checklistField': return box('**' + esc(s.label || '?') + ':** …');
    case 'plural': return box('1 ' + esc(s.word || 'day') + ', 2 ' + esc(s.word || 'day') + 's');
    case 'formatTime': return box(esc({ clock: 'Clock: 7:00 PM', day: 'Day key: 2026-10-21', when: 'today / yesterday / on 10/21' }[s.format] || 'Date: 10/21') + (s.blank ? '<br><span class="mut">No time: “' + esc(s.blank) + '”</span>' : ''));
    case 'dayTime': return box((Number(s.days) ? (s.days > 0 ? '+' : '') + esc(s.days) + ' day' + (Math.abs(s.days) === 1 ? '' : 's') : 'Same day') + (s.hour != null && s.hour !== '' ? ', at ' + esc(s.hour) + ':' + String(s.minute || 0).padStart(2, '0') : ''));
    case 'priceSheet': return box('Matches within ± ' + esc(s.tolerance ?? 1.01));
    case 'namedPerson': return box(esc(s.who || 'Store'));
    case 'statusSetBy': return s.byId === false ? box('Named in a note only') : '';
    case 'filterNotes': { const b = [s.kind && s.kind !== 'any' ? s.kind + ' notes' : 'Any notes', s.tag ? 'tag ' + s.tag : '', s.author ? 'by ' + s.author : '', Number(s.withinHours) ? 'last ' + s.withinHours + ' h' : ''].filter(Boolean); return box(esc(b.join(' · '))); }
    case 'findNote': {
      const by = [s.tag ? 'tagged ' + esc(s.tag) : '', s.pattern ? esc(PATTERNS[s.pattern] || s.pattern) : (s.words || []).length ? 'any of ' + chips(s.words) : ''].filter(Boolean);
      return box((s.which === 'last' ? 'Newest' : 'Oldest') + ' note' + (by.length ? ' ' + by.join(' or ') : '') + (s.skipNegated ? '<br><span class="mut">Skips negated</span>' : ''));
    }
    case 'relatedOrder': return box('Closed order' + ((s.programIds || []).length ? ', program ' + chips(s.programIds) : '') + ((s.statuses || []).length ? 'Status contains ' + chips(s.statuses) : '') + '<span class="mut">' + (Number(s.withinHours) ? 'Within ' + esc(s.withinHours) + ' h · ' : '') + (s.sameDevice === false ? 'any device' : 'same device or customer') + '</span>');
    case 'macro': { const m = lib().macros[s.macro]; return box(m ? (RG.MACROS[s.macro] && !(shown().macros || {})[s.macro] ? 'Built-in macro' : 'This graph’s macro') + ' · ' + plural((m.nodes || []).length, 'node') : 'Unknown macro ' + esc(s.macro || '')); }
    default: return '';
  }
}
// Pin positions relative to their node (world units), measured once per render.
const pinRel = new Map();
function measure() {
  pinRel.clear();
  const z = S.view.z;
  for (const ne of el.nodes.children) {
    const id = ne.dataset.node, r0 = ne.getBoundingClientRect();
    for (const p of ne.querySelectorAll('[data-pin]')) { const r = p.getBoundingClientRect(); pinRel.set(p.dataset.pin, { id, dx: (r.left + r.width / 2 - r0.left) / z, dy: (r.top + r.height / 2 - r0.top) / z }); }
  }
}
function pinAt(ref, g) { const r = pinRel.get(ref); if (!r) return null; const n = nodeById(g, r.id); return n ? { x: n.x + r.dx, y: n.y + r.dy } : null; }
const curve = (a, b) => { a = { x: Number(a.x) || 0, y: Number(a.y) || 0 }; b = { x: Number(b.x) || 0, y: Number(b.y) || 0 }; const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5); return 'M' + a.x + ' ' + a.y + ' C' + (a.x + dx) + ' ' + a.y + ',' + (b.x - dx) + ' ' + b.y + ',' + b.x + ' ' + b.y; };
function drawWires(tmp) {
  const lv = level(), g = lv.g, d = S.dbg, L = lib();
  if (!g) return;
  const bad = levelErrors().wires, trace = (d && d.trace) || {};
  let vis = '', hit = '', labels = '';
  const stepAt = S.step;
  (g.wires || []).forEach((w, i) => {
    const a = pinAt(w.from, g), b = pinAt(w.to, g);
    if (!a || !b) return;
    const [nid, pn] = split(w.from), n = nodeById(g, nid), pins = n && RG.pinsOf(n, L, lv.inside), o = pins && pins.outputs.find((x) => x.name === pn);
    const type = o ? ptype(o.type) : 'any';
    const src = d && d.nodes ? stateOf(lv.prefix + nid, false, nid) : null;
    const dim = d && (src === 'idle' || src === 'notReached' || src === 'pending' || !src);
    const path = curve(a, b), sel = S.wire && S.wire.kind === 'd' && S.wire.i === i;
    vis += '<path class="w' + (dim ? ' dim' : '') + (sel ? ' sel' : '') + (bad.has(w.from + '>' + w.to) ? ' bad' : '') + '" d="' + path + '" stroke="var(--t-' + type + ')" stroke-width="' + (sel ? 3.6 : 2.3) + '"/>';
    hit += '<path class="hit" data-w="d:' + i + '" d="' + path + '"><title>' + esc(TYPE_NAME[type] || type) + ': ' + esc(w.from) + ' → ' + esc(w.to) + '</title></path>';
    if (S.showVals && d && (type === 'bool' || type === 'num' || type === 'text' || type === 'person')) {
      const v = show(trace[lv.prefix + w.from], type);
      if (v) {
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, wd = v.t.length * 6.4 + 12;
        labels += '<g class="wl ' + (v.c || '') + (dim ? ' dim' : '') + '"><rect x="' + (mx - wd / 2) + '" y="' + (my - 9) + '" width="' + wd + '" height="18" rx="9"/><text x="' + mx + '" y="' + (my + 3.6) + '" text-anchor="middle">' + esc(v.t) + '</text></g>';
      }
    }
  });
  if (!lv.inside) {
    const taken = new Map((d && d.execWires ? d.execWires : []).map((w, i) => [w.index, i]));
    (g.flow || []).forEach((w, i) => {
      const a = pinAt(w.from, g), b = pinAt(w.to, g);
      if (!a || !b) return;
      const k = taken.get(i), on = k != null && (stepAt == null || k < stepAt);
      const path = curve(a, b), sel = S.wire && S.wire.kind === 'x' && S.wire.i === i;
      vis += '<path class="w x' + (on ? ' run' : d ? ' dim' : '') + (sel ? ' sel' : '') + (bad.has(w.from + '>' + w.to) ? ' bad' : '') + '" d="' + path + '" stroke-width="' + (sel ? 5 : on ? 4.2 : 3.4) + '"/>';
      hit += '<path class="hit" data-w="x:' + i + '" d="' + path + '"><title>Exec: ' + esc(w.from) + ' → ' + esc(w.to) + '</title></path>';
      if (on) { const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2; labels += '<g class="no"><circle cx="' + mx + '" cy="' + my + '" r="9"/><text x="' + mx + '" y="' + (my + 3.8) + '" text-anchor="middle">' + (k + 1) + '</text></g>'; }
    });
  }
  if (tmp) vis += '<path class="tmp" d="' + tmp.path + '" stroke="' + tmp.color + '"/>';
  el.svg.innerHTML = vis + hit + labels;
  // exec pins lit along the run
  if (d && !lv.inside) for (const w of d.execWires.filter((_, i) => stepAt == null || i < stepAt)) for (const ref of [w.from, w.to]) { const p = el.nodes.querySelector('[data-pin="' + CSS.escape(ref) + '"]'); if (p) p.classList.add('run'); }
}
function renderProblems() {
  const h = ui.h, errs = S.errors;
  if (!S.rule || !S.rule.perOrder) { el.probs.hidden = true; return; }
  el.probs.hidden = false;
  el.probs.className = 'rx-probs' + (errs.length ? '' : ' ok');
  if (!errs.length) return put(el.probs, h('b', null, '✓ No problems'), h('span', { class: 'mut sm' }, 'The graph checks out' + (S.hist ? '' : ' and can be published') + '.'));
  put(el.probs, h('b', null, plural(errs.length, 'problem')), ...errs.slice(0, 12).map((e) => h('button', { onclick: () => {
    const m = e.match(/^(?:Macro \S+: )?([A-Za-z0-9_-]+)(?: \(|:)/);
    if (m && level().g.nodes.some((n) => n.id === m[1])) { S.sel = new Set([m[1]]); S.wire = null; renderCanvas(); renderSide(); centerOn(m[1]); }
  } }, e)), errs.length > 12 ? h('span', { class: 'mut sm' }, '+' + (errs.length - 12) + ' more') : null);
}
function centerOn(id) {
  const n = nodeById(level().g, id); if (!n) return;
  S.view.x = el.stage.clientWidth / 2 - (n.x + 110) * S.view.z; S.view.y = el.stage.clientHeight / 2 - (n.y + 40) * S.view.z; applyView();
}

// ------------------------------------------------------------------ canvas input: pan, zoom, select, drag, wire
function wireStage() {
  const st = el.stage, ptrs = new Map();
  let mode = null, lp = 0;
  st.addEventListener('wheel', (e) => {
    if (e.target.closest('.rx-pal')) return;
    e.preventDefault();
    const r = st.getBoundingClientRect();
    // Scrolling pans; a pinch (ctrlKey on a trackpad) or ⌘/Ctrl + wheel zooms.
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
    else { S.view.x -= e.deltaX; S.view.y -= e.deltaY; applyView(); }
  }, { passive: false });
  st.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.rx-pal,.rx-tools,.rx-legend,.rx-crumbs') || !level().edit) return;
    e.preventDefault();
    openPal(e.clientX, e.clientY, toWorld(e.clientX, e.clientY));
  });
  st.addEventListener('dblclick', (e) => {
    const t = e.target.closest('.nh b');
    if (!t || !level().edit) return;
    S.renaming = t.closest('[data-node]').dataset.node; renderCanvas();
  });
  st.addEventListener('keydown', (e) => {
    if (e.target.matches('[data-rename]')) {
      if (e.key === 'Enter') e.target.blur();
      if (e.key === 'Escape') { S.renaming = null; renderCanvas(); }
      e.stopPropagation();
    }
  });
  st.addEventListener('focusout', (e) => {
    if (!e.target.matches('[data-rename]')) return;
    const id = e.target.dataset.rename, v = e.target.value.trim().slice(0, 80);
    S.renaming = null;
    const n = nodeById(level().g, id);
    if (n && (n.label || '') !== v) commit((g) => { const x = nodeById(g, id); if (v) x.label = v; else delete x.label; }); else renderCanvas();
  });
  st.addEventListener('click', (e) => {
    const more = e.target.closest('[data-more]');
    if (more) { const k = more.dataset.more; if (S.morePins.has(k)) S.morePins.delete(k); else S.morePins.add(k); return renderCanvas(); }
    const ex = e.target.closest('[data-expand]');
    if (ex) { const n = nodeById(level().g, ex.dataset.expand); if (n) { S.path.push({ node: n.id, macro: (n.settings || {}).macro }); S.sel = new Set(); S.wire = null; S.fitted = ''; renderCanvas(); renderSide(); } }
  });
  st.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.rx-pal,.rx-tools,.rx-legend,.rx-crumbs,.rx-hint>div,input,button')) return;
    if (e.button === 2) return;
    if (S.pal) closePal();
    st.focus({ preventScroll: true });
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) { mode && mode.cancel && mode.cancel(); mode = pinch(); return; }
    const lv = level();
    const pin = e.target.closest('[data-pin]'), hitW = e.target.closest('[data-w]'), node = e.target.closest('[data-node]');
    if (pin && lv.edit) {
      if (e.altKey) { const ref = pin.dataset.pin; return commit((g) => { g.wires = g.wires.filter((w) => w.from !== ref && w.to !== ref); if (g.flow) g.flow = g.flow.filter((w) => w.from !== ref && w.to !== ref); }); }
      mode = wireDrag(e, pin); return;
    }
    if (hitW) { const [k, i] = hitW.dataset.w.split(':'); S.wire = { kind: k, i: Number(i) }; S.sel = new Set(); renderCanvas(); renderSide(); return; }
    if (node) {
      const id = node.dataset.node;
      if (e.shiftKey || e.metaKey || e.ctrlKey) { if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id); }
      else if (!S.sel.has(id)) S.sel = new Set([id]);
      S.wire = null;
      for (const ne of el.nodes.children) ne.classList.toggle('sel', S.sel.has(ne.dataset.node));
      renderSide();
      if (lv.edit && S.sel.has(id)) mode = nodeDrag(e);
      return;
    }
    if (e.shiftKey || S.selectMode) { mode = boxSelect(e); return; }
    mode = panDrag(e);
    if (e.pointerType !== 'mouse' && lv.edit) { const x = e.clientX, y = e.clientY; lp = setTimeout(() => { if (mode && !mode.moved) { mode = null; openPal(x, y, toWorld(x, y)); } }, 550); }
  });
  const move = (e) => { if (!ptrs.has(e.pointerId)) return; ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (mode) mode.move(e); };
  const up = (e) => { if (!ptrs.has(e.pointerId)) return; ptrs.delete(e.pointerId); clearTimeout(lp); if (mode) { const m = mode; mode = null; m.up(e); } };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  function panDrag(e) {
    const sx = e.clientX - S.view.x, sy = e.clientY - S.view.y, x0 = e.clientX, y0 = e.clientY;
    const m = { moved: false, move(ev) { if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) > 6) { m.moved = true; st.classList.add('pan'); } S.view.x = ev.clientX - sx; S.view.y = ev.clientY - sy; applyView(); },
      up() { st.classList.remove('pan'); if (!m.moved && (S.sel.size || S.wire)) { S.sel = new Set(); S.wire = null; renderCanvas(); renderSide(); } } };
    return m;
  }
  function pinch() {
    const pts = () => [...ptrs.values()], dist = () => { const [a, b] = pts(); return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
    let d0 = dist();
    return { moved: true, move() { if (ptrs.size < 2) return; const [a, b] = pts(), r = st.getBoundingClientRect(), d = dist(); zoomAt(d / d0, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top); d0 = d; }, up() {} };
  }
  function boxSelect(e) {
    const r = st.getBoundingClientRect(), x0 = e.clientX - r.left, y0 = e.clientY - r.top;
    const base = e.shiftKey ? new Set(S.sel) : new Set();
    el.box.hidden = false; Object.assign(el.box.style, { left: x0 + 'px', top: y0 + 'px', width: '0px', height: '0px' });
    return { moved: true, move(ev) {
      const x1 = ev.clientX - r.left, y1 = ev.clientY - r.top, L = Math.min(x0, x1), T = Math.min(y0, y1), W = Math.abs(x1 - x0), H = Math.abs(y1 - y0);
      Object.assign(el.box.style, { left: L + 'px', top: T + 'px', width: W + 'px', height: H + 'px' });
      const a = toWorld(r.left + L, r.top + T), b = toWorld(r.left + L + W, r.top + T + H);
      S.sel = new Set(base);
      for (const ne of el.nodes.children) { const n = nodeById(level().g, ne.dataset.node); if (n && n.x < b.x && n.x + ne.offsetWidth > a.x && n.y < b.y && n.y + ne.offsetHeight > a.y) S.sel.add(n.id); ne.classList.toggle('sel', S.sel.has(ne.dataset.node)); }
    }, up() { el.box.hidden = true; S.wire = null; renderSide(); } };
  }
  function nodeDrag(e) {
    const g = level().g, ids = [...S.sel], start = ids.map((id) => { const n = nodeById(g, id); return n && [n, n.x, n.y]; }).filter(Boolean), x0 = e.clientX, y0 = e.clientY;
    let moved = false, before = null;
    return { move(ev) {
      const dx = (ev.clientX - x0) / S.view.z, dy = (ev.clientY - y0) / S.view.z;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      if (!moved) { moved = true; before = JSON.stringify(S.graph); }
      for (const [n, x, y] of start) { n.x = Math.round(x + dx); n.y = Math.round(y + dy); const ne = el.nodes.querySelector('[data-node="' + CSS.escape(n.id) + '"]'); if (ne) { ne.style.left = n.x + 'px'; ne.style.top = n.y + 'px'; } }
      drawWires();
    }, up() { if (moved) { S.undo.push(before); S.redo = []; scheduleSave(); renderCanvasTools(); } } };
  }
  function wireDrag(e, pinEl) {
    const lv = level(), g = lv.g, ref = pinEl.dataset.pin, dir = pinEl.dataset.dir, type = pinEl.dataset.type;
    const [nid] = split(ref), exec = dir === 'xin' || dir === 'xout';
    const from = pinAt(ref, g);
    // mark what fits
    st.classList.add('wiring');
    const verdict = (p) => {
      const d2 = p.dataset.dir, [n2] = split(p.dataset.pin);
      if (n2 === nid) return "A node can't wire to itself";
      if (exec !== (d2 === 'xin' || d2 === 'xout')) return exec ? 'Exec pins only connect to exec pins' : 'Data pins only connect to data pins';
      if (exec) return (dir === 'xout' && d2 === 'xin') || (dir === 'xin' && d2 === 'xout') ? null : 'Connect an exec output to an exec input';
      if (!((dir === 'out' && d2 === 'in') || (dir === 'in' && d2 === 'out'))) return 'Connect an output to an input';
      const a = dir === 'out' ? type : p.dataset.type, b = dir === 'out' ? p.dataset.type : type;
      return fits(a, b) ? null : (TYPE_NAME[a] || a) + ' doesn’t fit ' + (TYPE_NAME[b] || b);
    };
    for (const p of el.nodes.querySelectorAll('[data-pin]')) if (p !== pinEl) p.classList.add(verdict(p) ? 'nofit' : 'fit');
    const color = exec ? 'var(--exec)' : 'var(--t-' + type + ')';
    return { move(ev) {
      const w = toWorld(ev.clientX, ev.clientY);
      const a = dir === 'out' || dir === 'xout' ? from : w, b = dir === 'out' || dir === 'xout' ? w : from;
      drawWires({ path: curve(a, b), color });
    }, up(ev) {
      st.classList.remove('wiring');
      for (const p of el.nodes.querySelectorAll('.fit,.nofit')) p.classList.remove('fit', 'nofit');
      const tgt = document.elementFromPoint(ev.clientX, ev.clientY), p = tgt && tgt.closest('[data-pin]');
      if (!p || p === pinEl) { drawWires(); return; }
      const why = verdict(p);
      if (why) { drawWires(); return ui.toast(why); }
      const other = p.dataset.pin;
      if (exec) {
        const out = dir === 'xout' ? ref : other, into = split(dir === 'xout' ? other : ref)[0] + '.in';
        commit((gg) => { gg.flow = (gg.flow || []).filter((w) => w.from !== out); gg.flow.push({ from: out, to: into }); });
      } else {
        const out = dir === 'out' ? ref : other, into = dir === 'out' ? other : ref;
        commit((gg) => { gg.wires = (gg.wires || []).filter((w) => w.to !== into); gg.wires.push({ from: out, to: into }); });
      }
    } };
  }
}
function renderCanvasTools() { /* undo / redo enable states */ const b = el.tools && el.tools.querySelectorAll('button'); if (!b) return; for (const x of b) { if (x.getAttribute('aria-label') === 'Undo') x.disabled = !S.undo.length; if (x.getAttribute('aria-label') === 'Redo') x.disabled = !S.redo.length; } }

// ------------------------------------------------------------------ palette
function openPal(cx, cy, at) {
  const h = ui.h, lv = level(), r = el.stage.getBoundingClientRect();
  S.pal = { at };
  const q = h('input', { type: 'text', placeholder: 'Find a node', 'aria-label': 'Find a node' });
  const ls = h('div', { class: 'ls' });
  const items = [];
  for (const [type, def] of Object.entries(RG.NODE_TYPES)) {
    if (type === 'macro' || type === 'macroOut') continue;
    if (type === 'macroIn' && !(lv.inside && !lv.g.nodes.some((n) => n.type === 'macroIn'))) continue;
    if (lv.inside && def.exec) continue;
    if (type === 'start' && lv.g.nodes.some((n) => n.type === 'start')) continue;
    items.push({ cat: def.cat, title: def.title, desc: def.desc, add: () => addNode(type, at.x, at.y) });
  }
  for (const [name, m] of Object.entries(lib().macros)) if (!(lv.name && name === lv.name)) items.push({ cat: 'macro', title: m.title || name, desc: (m.desc || '') + ((shown().macros || {})[name] ? ' (this graph’s)' : ' (built in)'), add: () => addNode('macro', at.x, at.y, { macro: name }) });
  const fill = () => {
    const t = q.value.trim().toLowerCase(), out = [];
    for (const c of [...CAT_ORDER, 'macro']) {
      const its = items.filter((x) => x.cat === c && (!t || (x.title + ' ' + x.desc).toLowerCase().includes(t)));
      if (!its.length) continue;
      out.push(h('b', null, c === 'macro' ? 'Macros (collapsed nodes)' : CAT[c][0]));
      for (const x of its) out.push(h('button', { onclick: () => { closePal(); x.add(); } }, h('i', { style: 'background:var(--c-' + (c === 'macro' ? 'logic' : c) + ')' }), h('span', null, x.title, h('small', null, x.desc))));
    }
    put(ls, ...(out.length ? out : [h('p', { class: 'mut sm', style: 'padding:6px 8px' }, 'No node matches.')]));
  };
  q.addEventListener('input', fill);
  q.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePal(); if (e.key === 'Enter') { const b = ls.querySelector('button'); if (b) b.click(); } });
  fill();
  put(el.pal, q, ls);
  el.pal.hidden = false;
  const W = 270, x = Math.max(8, Math.min(cx - r.left, r.width - W - 8)), y = Math.max(8, Math.min(cy - r.top, r.height - 300));
  Object.assign(el.pal.style, { left: x + 'px', top: y + 'px' });
  setTimeout(() => q.focus(), 0);
}
export function closePal() { S.pal = null; if (el.pal) el.pal.hidden = true; }
