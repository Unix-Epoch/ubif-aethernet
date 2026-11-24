// Admin site, the Assize rules editor (rules-ui.js): the engine, display names and small helpers every part uses.
// Served at /rules-ui.js?part=words.
import * as RG from '/rulegraph.js';
import { makeRules } from '/assize-rules.js';

export const R = makeRules({ RG });
export const CHECK_NAME = Object.fromEntries(R.CHECKS);

// ------------------------------------------------------------------ words
export const CAT = { fact: ['Facts', 'Fact'], check: ['Checks', 'Check'], logic: ['Logic', 'Logic'], num: ['Numbers', 'Number'], people: ['People and notes', 'People'], time: ['Time and store hours', 'Time'], text: ['Text', 'Text'], assize: ['Assize', 'Assize'], out: ['Flow and output', 'Flow'] };
export const CAT_ORDER = ['fact', 'check', 'text', 'time', 'num', 'people', 'logic', 'assize', 'out'];
export const TYPE_NAME = { bool: 'Yes / no', num: 'Number', text: 'Text', lines: 'Cart lines', notes: 'Notes', textList: 'Text list', person: 'Person', any: 'Anything' };
const PIN_LABEL = { id: 'WO number', programKey: 'Program key', statusId: 'Status id', isRfp: 'Ready for pickup', isActive: 'Active', hasCart: 'Has a cart', manualNotes: 'Manual notes', noteText: 'Note text',
  hasNotes: 'Notes loaded', cond: 'Condition', who: 'Blame', sig1: 'Signature 1', sig2: 'Signature 2', sig3: 'Signature 3', if1: 'If 1', if2: 'If 2', if3: 'If 3', then1: 'Then 1', then2: 'Then 2', then3: 'Then 3',
  ownLines: 'Own lines', yes: 'Yes', no: 'No', out: 'Out', in: 'In', sum: 'Sum', sig: 'Signature', found: 'Found', word: 'Word', match: 'Match', exists: 'Exists', lines: 'Lines', key: 'Program key' };
export const pinLabel = (k) => PIN_LABEL[k] || (k.length === 1 ? k.toUpperCase() : (k[0].toUpperCase() + k.slice(1).replace(/([A-Z])/g, ' $1').toLowerCase()));
export const PROGRAMS = [['oop', 'Out of pocket'], ['cci', 'Consumer Cellular'], ['asurion', 'Asurion'], ['servify', 'Servify / Samsung Care+'], ['samsungIW', 'Samsung in-warranty'], ['google', 'Google'], ['amazon', 'Amazon Buyout'], ['vzew', 'Verizon Ext. Warranty'], ['element', 'Element'], ['cleaning', 'Cleaning'], ['unknown', 'Unknown partner']];
export const STATUSES = ['Initial check-in', 'Need to order', 'Awaiting item', 'Awaiting device', 'Awaiting diagnostics', 'Awaiting partner approval', 'Awaiting callback', 'Ready for work', 'Diagnostics', 'Work in progress', 'Quality check', 'Repair summary', 'Ready for pickup', 'Sale complete', 'Cancelled'];
export const OUTCOMES = ['Completed', 'Incomplete', 'Declined', 'No issue found'];
export const PATTERNS = { DOLLAR_RE: 'A price ($150, 150.00, 150 dollars, "quoted 150")', EXPLAIN_RE: 'Explains a $0 cart (deposit, GSPN, waived, refund, ATC, no charge)', LIQUID_RE: 'Liquid (water, wet, corrosion)',
  DATA_RE: 'Data risk (reset, wipe, reflash, board)', AGREE_RE: 'Customer agreed (aware, agreed, signed, understands)', CONTACT_RE: 'Contacted (called, texted, voicemail)', OVERRIDE_RE: 'Price override ("- per GG")' };
export const KIND_NAME = { fail: 'Fail', flag: 'Flag', note: 'Note', remind: 'Remind' };
export const ACTION = { publish: 'Published', revert: 'Draft from an old version', create: 'Created', enable: 'Turned on', disable: 'Turned off', inherit: 'Follows all stores', delete: 'Override deleted' };
export const MISSING = { notes: 'notes', nickname: 'the device nickname', deviceType: 'the device type (decided from its name)', issues: 'the repair issues', lineTypes: 'what kind each cart line is' };

// replaceChildren without the null / false children (h() drops them; replaceChildren would print "null").
export const put = (node, ...kids) => node.replaceChildren(...kids.flat(9).filter((k) => k != null && k !== false && k !== ''));
export const clone = (x) => JSON.parse(JSON.stringify(x));
// Everything that reaches markup or CSS from a graph is forced to a known shape first: coordinates to whole numbers (a graph
// from the server may carry anything a store editor saved), pin types and finding kinds to the lists the editor knows.
const COORD_MAX = 100000;
export const coord = (v) => { const n = typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN; return Number.isFinite(n) ? Math.max(-COORD_MAX, Math.min(COORD_MAX, Math.round(n))) : 0; };
const fixNodes = (nodes) => { if (Array.isArray(nodes)) for (const n of nodes) if (n && typeof n === 'object') { n.x = coord(n.x); n.y = coord(n.y); } };
// Coerce every node's x / y (the top level and inside each macro) in place; returns the graph.
export function tidyGraph(g) {
  if (!g || typeof g !== 'object') return g;
  fixNodes(g.nodes);
  if (g.macros && typeof g.macros === 'object') for (const m of Object.values(g.macros)) if (m && typeof m === 'object') fixNodes(m.nodes);
  return g;
}
// A rule as the server sent it: the built-in graph and every scope's draft and published graph.
export function tidyRule(r) {
  if (!r || typeof r !== 'object') return r;
  tidyGraph(r.builtInGraph);
  if (Array.isArray(r.scopes)) for (const sc of r.scopes) if (sc) { tidyGraph(sc.draft); tidyGraph(sc.published); }
  return r;
}
const PIN_TYPES = new Set(['bool', 'num', 'text', 'lines', 'notes', 'textList', 'person', 'any']);
export const ptype = (t) => (PIN_TYPES.has(t) ? t : 'any');
export const who = (email) => String(email || '').split('@')[0] || 'someone';
export const plural = (n, w, ws) => n + ' ' + (n === 1 ? w : ws || w + 's');
export const REDUCED = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const fits = (a, b) => a === b || a === 'any' || b === 'any';
export const split = (ref) => { const s = String(ref || ''), i = s.indexOf('.'); return i > 0 ? [s.slice(0, i), s.slice(i + 1)] : [s, '']; };

// A value as a short pill ({ t, c }), and in full for the inspector.
export function show(v, type) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return { t: v ? 'yes' : 'no', c: v ? 't' : 'f' };
  if (typeof v === 'number') return { t: Number.isFinite(v) ? String(Math.round(v * 100) / 100) : String(v) };
  if (v === null) return { t: type === 'notes' || type === 'any' ? 'not loaded' : 'none' };
  if (Array.isArray(v)) return { t: type === 'lines' ? plural(v.length, 'line') : type === 'notes' ? plural(v.length, 'note') : plural(v.length, 'item') };
  if (typeof v === 'object') return { t: v.name || v.label || '…' };
  const s = String(v);
  return { t: s === '' ? '(blank)' : s.length > 22 ? s.slice(0, 21) + '…' : s };
}
export function full(v) {
  if (v === undefined) return 'not computed';
  if (v === null) return 'none (not loaded)';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) return v.length ? v.map((x) => (x && typeof x === 'object' ? (x.noteText != null ? '• ' + String(x.noteText).slice(0, 200) : '• ' + [x.name, x.sku, x.price != null ? '$' + x.price : ''].filter(Boolean).join(' · ')) : '• ' + x)).join('\n') : '(empty list)';
  if (typeof v === 'object') return v.name ? v.name + (v.key ? ' (' + v.key + ')' : '') : JSON.stringify(v);
  return String(v) === '' ? '(blank)' : String(v);
}
