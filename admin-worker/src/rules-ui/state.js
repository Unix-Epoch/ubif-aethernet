// Admin site, the Assize rules editor (rules-ui.js): the editor's state, kept across redraws of the tab.
// Served at /rules-ui.js?part=state.

// ------------------------------------------------------------------ state (kept across redraws of the tab)
export let ui = null, S = null;
export const fresh = () => ({
  list: null, stores: [], q: '', newRule: false, ruleId: null, rule: null, scope: 'all', loadErr: null,
  graph: null, source: 'empty', saved: null, hasDraft: false, draftAt: null, saving: null, saveTimer: 0, conflict: false,
  undo: [], redo: [], path: [], sel: new Set(), wire: null, view: { x: 20, y: 20, z: 0.8 }, fitted: '', morePins: new Set(),
  selectMode: false, pal: null, confirm: null, side: 'node', hist: null, renaming: null,
  test: { store: null, wo: null, orders: [], details: false, keys: null, loading: false, err: null, lastScan: null },
  dbg: null, step: null, playing: 0, showVals: true, errors: [], cmp: null, cmpTimer: 0, refocus: null,
});
export let el = {};
export const clip = { nodes: null };
// draw() starts each of these over; an importing module can read them but not assign them
export const setUi = (v) => { ui = v; }, setS = (v) => { S = v; }, setEl = (v) => { el = v; };
