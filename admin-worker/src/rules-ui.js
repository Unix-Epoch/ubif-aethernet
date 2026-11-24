// Admin site: the Assize rules editor (page 'rules'). Served at /rules-ui.js and loaded by page.js when the tab opens.
// Rules as node graphs, Blueprint style: a rule list, a hand-rolled canvas (HTML nodes, SVG wires; no library, the
// page's CSP stays tight) and an inspector. Graphs run here, in the browser, with the same interpreter (rulegraph.js)
// and rules engine (assize-rules.js) Assize runs, on the store's open orders from the tracker. Notes come from the
// sealed snapshots, opened with the person's own key copy (tracker-ui.js: one unlock opens both pages).
// The server checks every save, publish and scope (tracker-worker/src/assize.js); this page only keeps the buttons honest.
// This file is the entry, the rule list, opening / saving / publishing, the editor's frame, test orders, the debug bar and the
// keyboard. The rest are modules in src/rules-ui/, served as /rules-ui.js?part=<name>: style, words (names and helpers),
// state (S, ui, el), edit (graph changes, validation, the debug run), canvas (nodes, wires, input, palette), side (inspector,
// history) and compare (Today's orders). They import each other in circles, which is fine while nothing is used at load time.
import * as RG from '/rulegraph.js';
import { fromSnapshot } from '/assize-rules.js';
import * as TK from '/tracker-ui.js';
import { STYLE } from '/rules-ui.js?part=style';
import { put, R, CHECK_NAME, tidyRule, clone, ACTION, who, KIND_NAME, MISSING, REDUCED, plural } from '/rules-ui.js?part=words';
import { setUi, ui, S, setS, fresh, setEl, el, clip } from '/rules-ui.js?part=state';
import { validate, runDebug, shown, curOrder, lib, level, removeSelected, undo, copySel, paste } from '/rules-ui.js?part=edit';
import { renderCanvas, buildStage, closePal } from '/rules-ui.js?part=canvas';
import { renderSide } from '/rules-ui.js?part=side';
import { renderCompareSoon, renderCompareMarks } from '/rules-ui.js?part=compare';

// ------------------------------------------------------------------ entry
export async function draw(m, helpers) {
  setUi(helpers);
  if (!document.getElementById('rx-css')) document.head.append(ui.h('style', { id: 'rx-css' }, STYLE));
  if (!S) setS(fresh());
  S.access = helpers.access || { owner: false, scope: 'stores', stores: [] };
  const h = ui.h;
  setEl({});
  el.root = h('div', { class: 'rx' }, h('div', { class: 'rx-app' },
    el.listPanel = h('aside', { class: 'rx-panel', 'aria-label': 'Rules' }),
    el.ed = h('section', { class: 'rx-panel', 'aria-label': 'Rule editor' }),
    el.side = h('aside', { class: 'rx-panel rx-side', 'aria-label': 'Inspector' })));
  put(m, el.root);
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const [list, stores, keys] = await Promise.all([ui.api('GET', '/tracker/assize/rules'), ui.api('GET', '/tracker/assize/stores').catch(() => ({ stores: [] })), TK.keyState(helpers).catch(() => ({ details: false, unlocked: false }))]);
  S.list = list; S.stores = stores.stores || []; S.test.keys = keys;
  if (!S.test.store) S.test.store = Number(params.get('store')) || (S.stores.slice().sort((a, b) => b.open - a.open)[0] || {}).store || null;
  renderList();
  const want = S.ruleId || params.get('rule') || 'oop-zero-cart';
  if (params.get('scope')) S.scope = params.get('scope');
  await openRule(S.list.rules.some((r) => r.rule === want) ? want : (S.list.rules[0] || {}).rule, S.ruleId === want);
  if (S.test.store && !S.test.orders.length) loadOrders();
  if (!draw.hashBound) {
    draw.hashBound = true;
    // A link to another rule (#rules?rule=…) while the tab is open: page.js only redraws on a tab change.
    addEventListener('hashchange', () => { const r = new URLSearchParams(location.hash.split('?')[1] || '').get('rule'); if (live() && r && r !== S.ruleId) openRule(r); });
  }
}

export const canEdit = (scope) => S.access.owner || (scope === 'all' ? S.access.scope === 'all' : S.access.scope === 'all' || (S.access.stores || []).includes(Number(scope)));
export const scopeRow = (scope) => (S.rule && S.rule.scopes.find((x) => x.scope === String(scope))) || null;
export const live = () => !!(el.root && el.root.isConnected);
function setHash() {
  const q = new URLSearchParams({ rule: S.ruleId || '' });
  if (S.scope !== 'all') q.set('scope', S.scope);
  if (S.test.store) q.set('store', S.test.store);
  history.replaceState(null, '', '#rules?' + q.toString());
}

// ------------------------------------------------------------------ rule list
function chipOf(r) {
  const all = r.scopes.find((x) => x.scope === 'all');
  if (!r.perOrder) return all && all.enabled === 0 ? ['off', 'Off'] : ['', 'On / off'];
  if (all && all.enabled === 0) return ['off', 'Off'];
  if (all && all.draft) return ['draft', 'Draft'];
  if (all && all.published) return ['graph', 'Graph'];
  if (r.builtInGraph) return ['built', 'Built in'];
  return ['', r.code ? 'Code only' : 'Empty'];
}
function renderList() {
  const h = ui.h, q = S.q.trim().toLowerCase();
  const groups = R.CHECKS.map(([k, name]) => [name, S.list.rules.filter((r) => r.check === k && (!q || (r.title + ' ' + r.rule).toLowerCase().includes(q)))]);
  const other = S.list.rules.filter((r) => !CHECK_NAME[r.check] && (!q || (r.title + ' ' + r.rule).toLowerCase().includes(q)));
  if (other.length) groups.push(['Other', other]);
  const search = h('input', { type: 'text', placeholder: 'Find a rule', 'aria-label': 'Find a rule', value: S.q, oninput: (e) => { S.q = e.target.value; renderRuleItems(); } });
  const canNew = canEdit('all');
  put(el.listPanel, 
    h('div', { class: 'rx-phd' }, h('h3', null, 'Rules'), h('span', { class: 'mut sm', style: 'margin-left:auto' }, String(S.list.rules.length))),
    h('div', { class: 'rx-srch' }, search, h('button', { class: 'btn sm', disabled: !canNew, title: canNew ? 'A new rule for every store' : 'A new rule is for every store: it needs all-stores access', onclick: () => { S.newRule = !S.newRule; renderList(); } }, '+ New rule')),
    S.newRule ? newRuleForm() : null,
    el.ruleItems = h('div', { class: 'rx-rules' }));
  renderRuleItems(groups);
  function renderRuleItems(gs) {
    const qq = S.q.trim().toLowerCase();
    gs = gs || R.CHECKS.map(([k, name]) => [name, S.list.rules.filter((r) => r.check === k)]).concat([['Other', S.list.rules.filter((r) => !CHECK_NAME[r.check])]]);
    gs = gs.map(([n, rs]) => [n, rs.filter((r) => !qq || (r.title + ' ' + r.rule).toLowerCase().includes(qq))]).filter(([, rs]) => rs.length);
    put(el.ruleItems, ...(gs.length ? gs.map(([name, rs]) => h('div', { class: 'rx-grp' }, h('b', null, name), rs.map((r) => {
      const [c, t] = chipOf(r), stores = r.scopes.filter((x) => x.scope !== 'all');
      return h('button', { class: 'rx-rule' + (r.rule === S.ruleId ? ' on' : ''), title: r.rule, onclick: () => openRule(r.rule) }, h('span', null, r.title),
        stores.map((x) => h('span', { class: 'pill st' + (x.draft ? ' dr' : ''), title: 'Store ' + x.scope + ' has its own ' + (x.published ? 'graph' : x.draft ? 'draft' : x.enabled === 0 ? 'off switch' : 'setting') }, x.scope)),
        h('span', { class: 'pill ' + c }, t));
    }))) : [h('p', { class: 'mut sm', style: 'padding:8px 14px' }, 'No rule matches.')]));
  }
}
function newRuleForm() {
  const h = ui.h;
  const id = h('input', { type: 'text', placeholder: 'Rule id, e.g. missing-imei', 'aria-label': 'Rule id' });
  const title = h('input', { type: 'text', placeholder: 'Title staff see, e.g. No IMEI', 'aria-label': 'Title', maxlength: 80 });
  const check = h('select', { 'aria-label': 'Section' }, R.CHECKS.map(([k, n]) => h('option', { value: k }, n)));
  const go = h('button', { class: 'btn p sm', onclick: async () => {
    if (!R.ruleId(id.value.trim())) return ui.toast('Rule id: lowercase letters, digits and dashes.');
    if (!title.value.trim()) return ui.toast('Give it a title.');
    go.disabled = true;
    try {
      const r = await ui.api('POST', '/tracker/assize/rules', { rule: id.value.trim(), title: title.value.trim(), check: check.value });
      S.newRule = false; S.list = await ui.api('GET', '/tracker/assize/rules'); renderList(); await openRule(r.rule);
    } catch (e) { go.disabled = false; ui.toast("Couldn't create it: " + e.message); }
  } }, 'Create');
  return h('div', { class: 'rx-new' }, id, title, h('div', { class: 'row' }, check, go, h('button', { class: 'btn sm', onclick: () => { S.newRule = false; renderList(); } }, 'Cancel')));
}

// ------------------------------------------------------------------ opening a rule, scopes
async function openRule(ruleId, keep) {
  if (!ruleId) return;
  await flushSave();
  try { S.rule = tidyRule(await ui.api('GET', '/tracker/assize/rules/' + ruleId)); S.loadErr = null; }
  catch (e) { S.loadErr = e.message; S.rule = null; }
  if (S.ruleId !== ruleId) { S.scope = S.scope !== 'all' && canEdit(S.scope) ? S.scope : 'all'; S.fitted = ''; }
  S.ruleId = ruleId; S.hist = null; S.confirm = null; S.conflict = false;
  if (!keep || !S.graph || S.graph.rule !== ruleId) loadScope(); else { S.hasDraft = !!(scopeRow(S.scope) && scopeRow(S.scope).draft); }
  setHash(); renderList(); renderAll();
}
const emptyGraph = () => ({ v: 1, rule: S.ruleId, check: S.rule.check || 'intake', title: S.rule.title || S.ruleId, nodes: [], wires: [], flow: [] });
function inherited() { const all = scopeRow('all'); return (all && (all.published || all.draft)) || S.rule.builtInGraph || emptyGraph(); }
function loadScope() {
  const row = scopeRow(S.scope);
  S.path = []; S.sel = new Set(); S.wire = null; S.undo = []; S.redo = []; S.step = null; stopPlay();
  if (!S.rule) { S.graph = null; return; }
  if (S.scope !== 'all' && !(row && (row.draft || row.published))) { S.graph = clone(inherited()); S.source = 'inherit'; }
  else if (row && row.draft) S.source = 'draft', S.graph = clone(row.draft);
  else if (row && row.published) S.source = 'published', S.graph = clone(row.published);
  else if (S.rule.builtInGraph) S.source = 'builtIn', S.graph = clone(S.rule.builtInGraph);
  else S.source = 'empty', S.graph = emptyGraph();
  S.graph.flow = S.graph.flow || []; S.graph.wires = S.graph.wires || []; S.graph.nodes = S.graph.nodes || [];
  S.hasDraft = !!(row && row.draft); S.draftAt = (row && row.draftAt) || null;
  S.saved = row && row.draft ? JSON.stringify(row.draft) : null;
}
export const editable = () => !!(S.rule && S.rule.perOrder && S.graph && !S.hist && S.source !== 'inherit' && canEdit(S.scope));
export function readOnlyWhy() {
  if (!S.rule) return '';
  if (S.hist) return 'Viewing an old version';
  if (!canEdit(S.scope)) return S.scope === 'all' ? 'Changing a rule for every store needs all-stores access' : 'No access to store ' + S.scope;
  if (S.source === 'inherit') return 'Store ' + S.scope + ' follows all stores. Make an override to change it here.';
  return '';
}
async function reloadRule(msg) {
  S.rule = tidyRule(await ui.api('GET', '/tracker/assize/rules/' + S.ruleId));
  S.list = await ui.api('GET', '/tracker/assize/rules');
  loadScope(); renderList(); renderAll();
  if (msg) ui.toast(msg);
}
async function post(action, body, msg) {
  try { await ui.api(action === 'draft' ? 'PUT' : 'POST', '/tracker/assize/rules/' + S.ruleId + '/' + action, Object.assign({ scope: S.scope }, body)); await reloadRule(msg); return true; }
  catch (e) { ui.toast("Couldn't do that: " + e.message); return false; }
}

// ------------------------------------------------------------------ saving
export function scheduleSave() {
  if (!editable()) return;
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(() => save(), 1200);
  renderHeader();
}
async function flushSave() { if (S && S.saveTimer) { clearTimeout(S.saveTimer); S.saveTimer = 0; await save(); } else if (S && S.saving) await S.saving; }
async function save(force) {
  S.saveTimer = 0;
  if (!S.graph || !editable() || S.conflict && !force) return;
  const text = JSON.stringify(S.graph);
  if (text === S.saved) return;
  const body = { scope: S.scope, graph: S.graph };
  if (!force) body.ifDraftAt = S.draftAt;
  const p = (async () => {
    try {
      const r = await ui.api('PUT', '/tracker/assize/rules/' + S.ruleId + '/draft', body);
      S.saved = text; S.draftAt = r.draftAt; S.hasDraft = true; S.conflict = false;
      const lr = S.list.rules.find((x) => x.rule === S.ruleId);
      if (lr) { let sc = lr.scopes.find((x) => x.scope === S.scope); if (!sc) lr.scopes.push(sc = { scope: S.scope }); sc.draft = true; }
      if (S.source !== 'draft') S.source = 'draft';
    } catch (e) {
      if (/someone saved/i.test(e.message)) S.conflict = true; else ui.toast("Couldn't save the draft: " + e.message);
    }
  })();
  S.saving = p; await p; S.saving = null;
  if (live()) { renderHeader(); renderList(); }
}

// ------------------------------------------------------------------ render: everything
export function renderAll() {
  if (!live()) return;
  validate(); runDebug();
  renderHeader(); renderDebug(); renderCanvas(); renderSide(); renderCompareSoon();
}

// ------------------------------------------------------------------ render: header, scope, bars
export function renderHeader() {
  if (!live()) return;
  const h = ui.h, r = S.rule;
  if (!r) { put(el.ed, h('div', { class: 'rx-lone' }, h('b', null, S.loadErr ? "Couldn't load this rule" : 'Pick a rule'), S.loadErr || 'Choose a rule on the left.')); return; }
  if (!el.head || !el.ed.contains(el.head)) buildEditor();
  const [chipC, chipT] = chipOf(S.list.rules.find((x) => x.rule === r.rule) || { scopes: [], perOrder: r.perOrder, code: r.code, builtInGraph: !!r.builtInGraph });
  const row = scopeRow(S.scope), errs = S.errors.length, edit = editable();
  const scopeName = S.scope === 'all' ? 'all stores' : 'store ' + S.scope;
  const something = S.hasDraft || !!S.saveTimer || S.source === 'builtIn' || (S.source === 'empty' && S.graph.nodes.length > 0);
  const pubBtn = h('button', { class: 'btn p', disabled: !edit || !something,
    title: !edit ? readOnlyWhy() : !something ? 'No changes to publish' : errs ? 'Fix the problems below first' : '', onclick: () => { if (errs) return ui.toast('Publishing needs a graph without problems: ' + errs + ' to fix.'); S.confirm = 'publish'; renderHeader(); } }, 'Publish to ' + scopeName);
  const pending = S.saveTimer || S.saving;
  put(el.head, 
    h('div', { style: 'min-width:0' }, h('div', { class: 'rx-crumb' }, (CHECK_NAME[r.check] || r.check || 'No section') + ' · ', h('span', null, r.rule)), h('h2', null, r.title)),
    S.source === 'builtIn' && !S.hist ? null : h('span', { class: 'pill ' + chipC }, chipT),
    S.hasDraft || pending ? h('span', { class: 'pill draft' }, pending ? 'Saving…' : 'Unpublished changes') : null,
    S.source === 'builtIn' && !S.hist ? h('span', { class: 'pill built wrap', title: 'The graph built into Aethernet, from the code rule. Assize runs the code until a graph is published.' }, 'Built in — publish to take over from the code rule') : null,
    h('div', { class: 'rx-acts' },
      S.hasDraft && edit ? h('button', { class: 'btn', onclick: () => { S.confirm = 'discard'; renderHeader(); } }, 'Discard changes') : null,
      r.perOrder ? pubBtn : null));
  // scope row
  const stores = S.stores.map((s) => s.store);
  if (S.scope !== 'all' && !stores.includes(Number(S.scope))) stores.push(Number(S.scope));
  const sc = h('select', { 'aria-label': 'Scope', onchange: async (e) => { await flushSave(); S.scope = e.target.value; S.hist = null; S.confirm = null; S.conflict = false; S.fitted = ''; loadScope(); if (S.scope !== 'all') { S.test.store = Number(S.scope); loadOrders(); } setHash(); renderAll(); } },
    h('option', { value: 'all' }, 'All stores'), stores.map((s) => h('option', { value: String(s) }, 'Store ' + s + ((S.stores.find((x) => x.store === s) || {}).name ? ' · ' + S.stores.find((x) => x.store === s).name : ''))));
  sc.value = S.scope;
  const on = row && row.enabled != null ? row.enabled : null, allRow = scopeRow('all'), allOn = !(allRow && allRow.enabled === 0);
  const canScope = canEdit(S.scope);
  const sw = S.scope === 'all'
    ? h('div', { class: 'rx-seg', role: 'group', 'aria-label': 'On or off for all stores' }, [[true, 'On'], [false, 'Off']].map(([v, l]) => h('button', { class: allOn === v ? 'on' : null, disabled: !canScope, onclick: () => allOn !== v && post('enabled', { enabled: v }, v ? 'On for all stores' : 'Off for all stores') }, l)))
    : h('div', { class: 'rx-seg', role: 'group', 'aria-label': 'On or off at this store' }, [[null, 'Follow all stores (' + (allOn ? 'on' : 'off') + ')'], [1, 'On'], [0, 'Off']].map(([v, l]) => h('button', { class: on === v ? 'on' : null, disabled: !canScope, onclick: () => on !== v && post('enabled', { enabled: v === null ? null : !!v }, 'Saved') }, l)));
  const ov = [];
  if (S.scope !== 'all' && r.perOrder) {
    const has = row && (row.draft || row.published);
    if (!has) ov.push(h('span', { class: 'mut sm' }, 'Follows all stores.'), h('button', { class: 'btn sm', disabled: !canScope, title: canScope ? '' : 'No access to store ' + S.scope, onclick: makeOverride }, 'Make an override for ' + S.scope));
    else ov.push(h('span', { class: 'mut sm' }, 'Has its own graph.'));
    if (row) ov.push(h('button', { class: 'btn sm dg', disabled: !canScope, onclick: () => { S.confirm = 'delete'; renderHeader(); } }, 'Delete override'));
  }
  put(el.scope, h('label', { class: 'mut sm' }, 'Scope'), sc, sw, ...ov,
    readOnlyWhy() && !S.hist && S.source !== 'inherit' ? h('span', { class: 'mut sm' }, '· ' + readOnlyWhy()) : null);
  // bars: conflict, confirm, history view, per-order note
  const bars = [];
  if (S.conflict) bars.push(h('div', { class: 'rx-bar bad' }, h('span', null, 'Someone else changed this draft since you opened it. Your changes aren’t saved.'),
    h('button', { class: 'btn sm', onclick: () => { S.conflict = false; reloadRule('Loaded their version'); } }, 'Load their version'),
    h('button', { class: 'btn sm p', onclick: async () => { await save(true); if (!S.conflict) ui.toast('Saved yours over theirs'); } }, 'Keep mine (overwrite)')));
  if (S.confirm === 'publish') {
    const c = S.cmp, note = h('input', { type: 'text', placeholder: 'What changed (optional)', maxlength: 300, 'aria-label': 'Note' });
    const diff = c && c.ok ? (c.changed ? c.changed + ' of ' + c.n + ' open orders at store ' + c.store + ' would change.' : 'No change on the ' + c.n + ' open orders at store ' + c.store + '.') : '';
    bars.push(h('div', { class: 'rx-bar' }, h('span', null, 'Publish to ' + scopeName + '? Assize ' + (S.scope === 'all' ? 'at every store' : 'at store ' + S.scope) + ' picks it up on its next check. ' + diff), note,
      h('button', { class: 'btn sm', onclick: () => { S.confirm = null; renderHeader(); } }, 'Cancel'),
      h('button', { class: 'btn sm p', onclick: (e) => publish(note.value, e.target) }, 'Publish')));
  }
  if (S.confirm === 'discard') bars.push(h('div', { class: 'rx-bar' }, h('span', null, 'Discard the unpublished changes? The canvas goes back to ' + (row && row.published ? 'the published graph' : S.rule.builtInGraph && S.scope === 'all' ? 'the built-in graph' : 'what was there before') + '.'),
    h('button', { class: 'btn sm', onclick: () => { S.confirm = null; renderHeader(); } }, 'Cancel'),
    h('button', { class: 'btn sm p', onclick: async () => { S.confirm = null; clearTimeout(S.saveTimer); S.saveTimer = 0; await post('discard', {}, 'Changes discarded'); } }, 'Discard')));
  if (S.confirm === 'delete') bars.push(h('div', { class: 'rx-bar' }, h('span', null, 'Delete store ' + S.scope + '’s override? It goes back to following all stores (graph and on / off).'),
    h('button', { class: 'btn sm', onclick: () => { S.confirm = null; renderHeader(); } }, 'Cancel'),
    h('button', { class: 'btn sm p', onclick: async () => { S.confirm = null; clearTimeout(S.saveTimer); S.saveTimer = 0; await post('delete', {}, 'Override deleted'); } }, 'Delete override')));
  if (S.hist) {
    const x = S.hist;
    bars.push(h('div', { class: 'rx-bar info' }, h('span', null, 'Viewing version ' + (x.version || '?') + ' (' + (x.scope === 'all' ? 'all stores' : 'store ' + x.scope) + ') · ' + (ACTION[x.action] || x.action).toLowerCase() + ' by ' + who(x.by) + ' ' + ui.fmt(x.at) + (x.note ? ' · “' + x.note + '”' : '') + '. Read only.'),
      x.action === 'publish' && canEdit(S.scope) && r.perOrder ? h('button', { class: 'btn sm p', onclick: () => restore(x) }, 'Restore as draft') : null,
      h('button', { class: 'btn sm', onclick: () => { S.hist = null; S.fitted = ''; renderAll(); } }, 'Back to editing')));
  }
  if (!r.perOrder) bars.push(h('div', { class: 'rx-bar info' }, h('span', null, 'This rule looks across orders (an open cleaning and its closed parent), and graphs check one order at a time, so it can only be turned on or off.')));
  else if (r.code && S.source === 'empty' && !S.hist) bars.push(h('div', { class: 'rx-bar info' }, h('span', null, 'This rule is still in Aethernet’s code, with no graph yet. Draw one and publish it to take over from the code rule.')));
  put(el.bars, ...bars);
}
async function makeOverride() {
  const g = clone(inherited());
  try { await ui.api('PUT', '/tracker/assize/rules/' + S.ruleId + '/draft', { scope: S.scope, graph: g, ifDraftAt: null }); await reloadRule('Override for store ' + S.scope + ': a draft copy of the all-stores graph'); }
  catch (e) { ui.toast("Couldn't make the override: " + e.message); }
}
async function publish(note, btn) {
  btn.disabled = true;
  await flushSave();
  if (S.conflict) { btn.disabled = false; return ui.toast('Sort out the draft conflict first.'); }
  if (!S.hasDraft) { await save(true); }
  try {
    const r = await ui.api('POST', '/tracker/assize/rules/' + S.ruleId + '/publish', { scope: S.scope, note: note || undefined, ifDraftAt: S.draftAt });
    S.confirm = null; await reloadRule('Published version ' + r.version + ' to ' + (S.scope === 'all' ? 'all stores' : 'store ' + S.scope));
  } catch (e) { btn.disabled = false; ui.toast("Couldn't publish: " + e.message); }
}
export async function restore(x) {
  await flushSave();
  try { await ui.api('POST', '/tracker/assize/rules/' + S.ruleId + '/revert', { scope: S.scope, id: x.id }); S.hist = null; await reloadRule('Version ' + x.version + ' is the draft now. Test it, then publish.'); }
  catch (e) { ui.toast("Couldn't restore: " + e.message); }
}

// ------------------------------------------------------------------ the editor's frame
function buildEditor() {
  const h = ui.h;
  el.head = h('div', { class: 'rx-ehd' });
  el.scope = h('div', { class: 'rx-scope' });
  el.bars = h('div');
  el.dbg = h('div', { class: 'rx-dbg' });
  el.out = h('div', { class: 'rx-out', 'aria-live': 'polite' });
  el.steps = h('div', { class: 'rx-steps' });
  el.note = h('div');
  el.stage = h('div', { class: 'rx-stage', tabindex: '0', 'aria-label': 'Rule graph canvas' });
  el.probs = h('div', { class: 'rx-probs' });
  put(el.ed, el.head, el.scope, el.bars, el.dbg, el.out, el.steps, el.note, el.stage, el.probs);
  buildStage();
}

// ------------------------------------------------------------------ test orders
async function loadOrders() {
  const store = S.test.store;
  if (!store) return;
  S.test.loading = true; S.test.err = null; renderDebug();
  try {
    const r = await ui.api('GET', '/tracker/assize/orders?store=' + store);
    if (S.test.store !== store) return;
    S.test.orders = r.orders || []; S.test.details = !!r.details; S.test.lastScan = r.last_scan_at;
    await openInputs();
    if (!S.test.orders.some((o) => o.wo === S.test.wo)) S.test.wo = (S.test.orders[0] || {}).wo || null;
  } catch (e) { S.test.err = e.message; S.test.orders = []; }
  S.test.loading = false;
  if (live()) { runDebug(); renderDebug(); renderCanvas(); renderSide(); renderCompareSoon(); }
}
async function openInputs() {
  const store = S.test.store, open = S.test.details && TK.isUnlocked();
  for (const o of S.test.orders) {
    let sealed = null;
    if (open && o.sealed) { try { sealed = await TK.openSnapshot(store, o.wo, o.sealed); } catch (_) { sealed = null; } }
    o.locked = !!o.sealed && !sealed;
    o.inp = fromSnapshot(o.plain, sealed);
  }
}
function unlockModal() {
  const h = ui.h;
  const close = () => box.remove();
  const after = async () => { close(); S.test.keys = await TK.keyState(ui).catch(() => S.test.keys); await openInputs(); runDebug(); renderDebug(); renderCanvas(); renderSide(); renderCompareSoon(); ui.toast('Unlocked: notes are in the test orders now.'); };
  const card = TK.unlockPrompt(after);
  card.prepend(h('button', { class: 'x', 'aria-label': 'Close', onclick: close }, '×'));
  const box = h('div', { class: 'rx-modal', onclick: (e) => { if (e.target === box) close(); } }, card);
  document.body.append(box);
}

// ------------------------------------------------------------------ render: debug bar, outcome, steps
export function renderDebug() {
  if (!live() || !el.dbg || !S.rule) return;
  const h = ui.h, d = S.dbg, t = S.test;
  const storeSel = h('select', { 'aria-label': 'Test store', onchange: (e) => { S.test.store = Number(e.target.value); S.test.wo = null; S.test.orders = []; setHash(); loadOrders(); } },
    S.stores.length ? S.stores.map((s) => h('option', { value: String(s.store) }, 'Store ' + s.store + (s.name ? ' · ' + s.name : ''))) : h('option', { value: '' }, 'No stores'));
  if (t.store) storeSel.value = String(t.store);
  const ordSel = h('select', { class: 'ord', 'aria-label': 'Test order', disabled: !t.orders.length, onchange: (e) => { S.test.wo = Number(e.target.value); S.step = null; stopPlay(); runDebug(); renderDebug(); renderCanvas(); renderSide(); renderCompareMarks(); } },
    t.loading ? h('option', null, 'Loading orders…') : t.orders.length ? t.orders.map((o) => h('option', { value: String(o.wo) }, '#' + o.wo + ' · ' + (o.device || (o.plain && o.plain.workorder && o.plain.workorder.device) || 'device?') + ' · ' + (o.status_name || '?'))) : h('option', null, t.err ? "Couldn't load: " + t.err : 'No open orders'));
  if (t.wo) ordSel.value = String(t.wo);
  const vals = h('label', { class: 'rx-tg' }, h('input', { type: 'checkbox', checked: S.showVals, onchange: (e) => { S.showVals = e.target.checked; renderCanvas(); } }), h('i'), 'Show values on wires');
  const n = maxStep(), playing = !!S.playing;
  const play = h('div', { class: 'rx-play', role: 'group', 'aria-label': 'Step through the run' },
    h('button', { title: 'Show the whole run', 'aria-label': 'Show the whole run', disabled: S.step == null && !playing, onclick: () => { stopPlay(); S.step = null; stepRender(); } }, '⟲'),
    h('button', { title: 'Step back', 'aria-label': 'Step back', disabled: !d || n < 0 || S.step === 0, onclick: () => { stopPlay(); S.step = S.step == null ? n : Math.max(0, S.step - 1); stepRender(); } }, '◀'),
    h('button', { title: playing ? 'Pause' : 'Play the run', 'aria-label': playing ? 'Pause' : 'Play the run', disabled: !d || n < 0, onclick: () => (playing ? stopPlay(true) : startPlay()) }, playing ? '❚❚' : '▶'),
    h('button', { title: 'Step forward', 'aria-label': 'Step forward', disabled: !d || n < 0 || S.step === n, onclick: () => { stopPlay(); S.step = S.step == null ? 0 : Math.min(n, S.step + 1); stepRender(); } }, '▶︎|'));
  put(el.dbg, h('label', { class: 'l' }, 'Test on'), storeSel, ordSel, vals, play);
  // the outcome, finding or not
  const parts = [];
  if (!S.rule.perOrder) parts.push(h('span', { class: 'mut' }, 'Nothing to test: this rule looks across orders.'));
  else if (!d) parts.push(h('span', { class: 'mut' }, t.loading ? 'Loading test orders…' : t.orders.length ? 'Pick an order to test on.' : 'No open orders to test on at this store.'));
  else {
    const raised = d.findings || [];
    parts.push(h('span', { class: 't' }, d.outcome ? d.outcome.text : ''));
    if (raised.length) for (const f of raised.slice(0, 2)) parts.push(h('span', { class: 'pill ' + f.kind }, KIND_NAME[f.kind] || f.kind), h('b', null, f.title), h('span', { class: 'ev mut' }, f.evidence + ' · ' + ((f.who && f.who.name) || 'Unassigned')));
    else parts.push(h('span', { class: 'pill' }, 'No finding'));
    if (d.aborted) parts.push(h('span', { class: 'pill off' }, 'Assize would hit an error here and keep the code rule'));
    if (S.step != null) { const s = d.steps[S.step]; parts.push(h('span', { class: 'mut sm' }, s ? '· step ' + (S.step + 1) + ' of ' + (n + 1) : '· after the flow: findings with no exec wire checked')); }
  }
  put(el.out, ...parts);
  // steps
  if (d && d.steps && d.steps.length) {
    const g = shown(), items = [];
    d.steps.forEach((s, i) => {
      const nd = g.nodes.find((x) => x.id === s.node), nm = nd ? titleOf(nd) : s.node;
      if (i) items.push(h('i', null, '→'));
      items.push(h('button', { class: S.step === i ? 'on' : S.step != null && i < S.step ? 'past' : null, onclick: () => { stopPlay(); S.step = i; stepRender(); } }, (i + 1) + ' ' + nm + (s.pin && s.pin !== 'then' ? ' → ' + s.pin : '') + (s.error ? ' ⚠' : '')));
    });
    if (n === d.steps.length) { items.push(h('i', null, '→')); items.push(h('button', { class: S.step === n ? 'on' : null, onclick: () => { stopPlay(); S.step = n; stepRender(); } }, 'Findings checked')); }
    el.steps.hidden = false; put(el.steps, h('span', { class: 'mut' }, 'Run:'), ...items);
  } else { el.steps.hidden = !d; put(el.steps, d ? h('span', { class: 'mut' }, 'No exec flow: every finding is checked on its own.') : ''); }
  // notes / access notice
  const o = curOrder(), notes = [];
  if (S.rule.perOrder && o && o.inp && o.inp.missing.length) {
    if (!S.test.details) notes.push(h('div', { class: 'rx-note' }, h('span', null, 'Notes aren’t available without customer details access, so note checks can’t be tested. Also missing here: ' + o.inp.missing.filter((x) => x !== 'notes').map((x) => MISSING[x]).join(', ') + '.')));
    else if (o.locked) notes.push(h('div', { class: 'rx-note info' }, h('span', null, 'Notes are locked in this browser, so note checks can’t be tested yet.'), h('button', { class: 'btn sm p', onclick: unlockModal }, 'Unlock with your passphrase')));
    else if (o.inp.missing.includes('notes')) notes.push(h('div', { class: 'rx-note' }, h('span', null, 'This order’s notes weren’t loaded when the tracker saw it, so note checks wait, as they do in Assize.')));
  }
  if (d && d.needsNotes) notes.push(h('div', { class: 'rx-note' }, h('span', null, 'Some nodes on this run read notes this order doesn’t have here; they’re marked “needs notes”.')));
  if (S.ruleId === 'price-off-sheet') notes.push(h('div', { class: 'rx-note info' }, h('span', null, 'The price sheet isn’t on the admin site, so the price-sheet comparison doesn’t run here (the code rule raises nothing without it).')));
  put(el.note, ...notes);
}
export const titleOf = (n) => n.label || (n.type === 'macro' ? ((lib().macros[(n.settings || {}).macro] || {}).title || 'Macro') : (RG.NODE_TYPES[n.type] || { title: n.type }).title);
// The last step index: the exec steps, plus one for the data-driven findings checked after the flow.
function maxStep() {
  const d = S.dbg;
  if (!d || !d.steps) return -1;
  const after = Object.entries(d.results || {}).some(([id, r]) => r.reached && !d.steps.some((s) => s.node === id));
  return d.steps.length - 1 + (after ? 1 : 0);
}
function stepRender() { renderDebug(); renderCanvas(); }
function startPlay() {
  const n = maxStep();
  if (n < 0) return;
  if (REDUCED()) { S.step = n; return stepRender(); }
  if (S.step == null || S.step >= n) S.step = 0;
  S.playing = setInterval(() => { if (!live() || S.step >= maxStep()) return stopPlay(true); S.step++; stepRender(); }, 750);
  stepRender();
}
export function stopPlay(render) { if (S && S.playing) { clearInterval(S.playing); S.playing = 0; if (render) renderDebug(); } }

// ------------------------------------------------------------------ keyboard
let keysBound = false;
export function bindKeys() {
  if (keysBound) return; keysBound = true;
  document.addEventListener('keydown', (e) => {
    if (!S || !live() || !el.stage) return;
    const t = e.target;
    if (t && (t.matches('input,textarea,select,[contenteditable]') || t.closest('.rx-modal'))) return;
    if (!el.root.contains(t) && t !== document.body) return;
    const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
    if (k === 'escape') { if (S.pal) closePal(); else if (S.sel.size || S.wire) { S.sel = new Set(); S.wire = null; renderCanvas(); renderSide(); } return; }
    if (!level().edit) return;
    if ((k === 'delete' || k === 'backspace') && (S.sel.size || S.wire)) { e.preventDefault(); removeSelected(); return; }
    if (mod && k === 'z') { e.preventDefault(); undo(!e.shiftKey); return; }
    if (mod && k === 'y') { e.preventDefault(); undo(false); return; }
    if (mod && k === 'c') { if (copySel()) { e.preventDefault(); ui.toast('Copied ' + plural(clip.nodes.nodes.length, 'node')); } return; }
    if (mod && k === 'v') { e.preventDefault(); paste(); return; }
    if (mod && k === 'd') { e.preventDefault(); if (copySel()) paste(); return; }
    if (mod && k === 'a') { e.preventDefault(); S.sel = new Set(level().g.nodes.map((n) => n.id)); renderCanvas(); renderSide(); }
  });
}
