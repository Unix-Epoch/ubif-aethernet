/*
  One-time backfill of rfp_periods from the snapshots already in the tracker (live D1, read with
  wrangler): walks each WO's snapshots in order; status 13 opens a period (start = Portal's rfpAt, else
  the WO's updatedAt, else the fetch time) and keeps its cart value; any other status closes it.
  Writes a SQL file (inserts only; existing periods are kept).  node import/rfp-periods.mjs --out rfp.sql
*/
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { cartValue } from '../src/index.js';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const q = (sql) => JSON.parse(execSync(`npx wrangler d1 execute aethernet-tracker --remote --json --command "${sql}"`, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 28 }))[0].results;
const rows = [];
for (let off = 0; ; off += 400) {
  const page = q(`SELECT store, wo, fetched_at, plain FROM snapshots ORDER BY store, wo, id LIMIT 400 OFFSET ${off}`);
  rows.push(...page);
  if (page.length < 400) break;
}
const iso = (v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(v).toISOString() : null);
const periods = [];
let cur = null, key = null;
for (const r of rows) {
  const k = r.store + '|' + r.wo;
  if (k !== key) { if (cur) periods.push(cur); cur = null; key = k; }
  const plain = JSON.parse(r.plain || '{}'), w = plain.workorder || {};
  if (Number(w.statusId) === 13) {
    const v = cartValue(plain);
    if (!cur) cur = { store: r.store, wo: r.wo, start: iso(w.rfpAt) || iso(w.updatedAt) || iso(r.fetched_at), end: null, value: v };
    else if (v != null) cur.value = v;
  } else if (cur) {
    const u = iso(w.updatedAt); cur.end = u && u > cur.start ? u : iso(r.fetched_at);
    periods.push(cur); cur = null;
  }
}
if (cur) periods.push(cur);
const s = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : "'" + v + "'");
writeFileSync(arg('out', 'rfp.sql'), periods.map((p) => `INSERT INTO rfp_periods (store, wo, start_at, end_at, value) VALUES (${p.store}, ${p.wo}, ${s(p.start)}, ${s(p.end)}, ${s(p.value)}) ON CONFLICT (store, wo, start_at) DO NOTHING;`).join('\n') + '\n');
console.log(`${rows.length} snapshots → ${periods.length} RFP periods (${periods.filter((p) => !p.end).length} still open)`);
