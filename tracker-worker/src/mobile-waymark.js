/*
  Linkpearl: Waymark marks on work orders (read only). Shared by mobile-wo.js (open list rows, the follow-ups filter, the detail).

  Waymark's own database (env.AE, ../worker/schema.sql) is read here and never written:
    tags       wo_tags (store, wo, tag) joined to the store's managed list (store, name = tag) for the colour; a tag that is not in the list
               (a one-off tag) has color null. wo_tags.by_name / by_id and history.* carry staff and are never selected.
    followUp   auto_marks: due (YYYY-MM-DD, store-local) and kind (rfp | callback; NULL in old rows = rfp), only rows with removed_at IS NULL and
               only for a work order that is not in wo_closed. The same rules as the follow-up alert in mobile-alerts.js (alertsTick).
  Lookups are batched per page: one tags statement and one marks statement per store on the page (primary-key seeks, the work order numbers
  travel as one JSON parameter, so D1's bound-parameter limit never matters). A failed read is logged and answers "no marks" (never an error).
*/
import { local } from './metrics.js';

export const DUE_MAX = 2000;  // most due work orders read for the follow-ups filter
const TAGS_MAX = 20;          // tags returned per work order
const DAY = /^\d{4}-\d\d-\d\d$/;

export const tzOf = (env) => env.STORE_TZ || 'America/New_York';
// The store-local date (YYYY-MM-DD), the way the follow-up alert computes it (metrics.js local, one zone for every store).
export const todayOf = (env, ms = Date.now()) => local(ms, tzOf(env)).day;

const kindOf = (k) => (k === 'callback' ? 'callback' : 'rfp');

// rows: [{ store, wo, open }]. → Map "store|wo" → { tags: [{ tag, color }], followUp: { kind, due } | null }. A closed work order never has a follow-up.
export async function marksFor(env, rows) {
  const out = new Map();
  for (const r of rows) out.set(r.store + '|' + r.wo, { tags: [], followUp: null });
  if (!rows.length || !env.AE) return out;
  const by = new Map();
  for (const r of rows) { if (!by.has(r.store)) by.set(r.store, []); by.get(r.store).push(r.wo); }
  try {
    const stmts = [];
    for (const [store, wos] of by) {
      const j = JSON.stringify(wos);
      stmts.push(env.AE.prepare(`SELECT t.store, t.wo, t.tag, l.color FROM wo_tags t LEFT JOIN list l ON l.store = t.store AND l.name = t.tag
      WHERE t.store = ?1 AND t.wo IN (SELECT value FROM json_each(?2)) ORDER BY t.wo, t.at, t.tag`).bind(store, j));
      stmts.push(env.AE.prepare(`SELECT m.store, m.wo, m.due, m.kind FROM auto_marks m WHERE m.store = ?1 AND m.wo IN (SELECT value FROM json_each(?2)) AND m.removed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM wo_closed c WHERE c.store = m.store AND c.wo = m.wo)`).bind(store, j));
    }
    const res = await env.AE.batch(stmts);
    for (let i = 0; i < res.length; i += 2) {
      for (const t of res[i].results) { const e = out.get(t.store + '|' + t.wo); if (e && e.tags.length < TAGS_MAX) e.tags.push({ tag: t.tag, color: t.color || null }); }
      for (const m of res[i + 1].results) { const e = out.get(m.store + '|' + m.wo); if (e && DAY.test(m.due || '')) e.followUp = { kind: kindOf(m.kind), due: m.due }; }
    }
    for (const r of rows) if (!r.open) out.get(r.store + '|' + r.wo).followUp = null;
  } catch (e) { console.error('waymark: marks read failed:', e && e.message); }
  return out;
}

// The follow-ups due today or overdue (due <= today, store-local) in these stores, not closed: { store → [wo] } or null when Waymark could not be read.
// Whether each is still an open work order is the caller's join against the tracker's own table.
export async function dueMarks(env, stores, today) {
  if (!env.AE || !stores.length) return new Map();
  try {
    const r = (await env.AE.prepare(`SELECT m.store, m.wo FROM auto_marks m WHERE m.store IN (SELECT value FROM json_each(?1)) AND m.due <= ?2 AND m.removed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM wo_closed c WHERE c.store = m.store AND c.wo = m.wo) ORDER BY m.store, m.wo LIMIT ?3`).bind(JSON.stringify(stores), today, DUE_MAX).all()).results;
    const by = new Map();
    for (const x of r) { if (!by.has(x.store)) by.set(x.store, []); by.get(x.store).push(x.wo); }
    return by;
  } catch (e) { console.error('waymark: due read failed:', e && e.message); return null; }
}

// SQL over workorders w for "is one of these due marks": { sql, args } (args: store, JSON list of numbers, per store). Empty set = a false condition.
export function dueCond(by) {
  if (!by || !by.size) return { sql: '0 = 1', args: [] };
  const parts = [], args = [];
  for (const [s, wos] of by) { parts.push('(w.store = ? AND w.wo IN (SELECT value FROM json_each(?)))'); args.push(s, JSON.stringify(wos)); }
  return { sql: '(' + parts.join(' OR ') + ')', args };
}
