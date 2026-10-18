/*
  Metrics page (admin site → /api/tracker/metrics). One request returns the whole dashboard for a range.
  Plain columns only: sealed columns (workorders.card, snapshots.sealed, sales.card) are never selected.

    GET  /metrics?from=YYYY-MM-DD&to=YYYY-MM-DD&stores=914,326|all&granularity=hour|day|week&compare=0|1
         → { from, to, prevFrom, prevTo, gran, stores, grid, cur, prev, tot, ... } (see build() below)
    POST /metrics/backfill?after=<rowid>     full access: builds status_periods from stored status
         histories (plain auditTrail, else `changes`), 300 work orders per call → { next, done, processed, written }

  Databases: env.TR (tracker); the Waymark database is env.DB on the admin site (env.AE in the tracker Worker),
  read for usage, auto_marks, config.cleaningTarget and store names.

  Uploaded daily numbers (labor hours, cleanings, Assize) come from daily_metrics (filled by Aethernet); when
  a key has no rows in the range the page shows its "no data yet" state.
*/

const DAY_RE = /^\d{4}-\d\d-\d\d$/;
const CLOSED = new Set([14, 15, 25]); // Sale complete, Closed, Cancelled
// Store hours, same as Assize (src/65-assize.js STORE_HOURS / hoursFor): open 10–19 Monday–Saturday; Lexington every day.
export const STORE_HOURS = { open: 10, close: 19, closedDays: [0] };
const OPEN_DAILY = new Set([536]);
export const hoursFor = (store) => (OPEN_DAILY.has(Number(store)) ? Object.assign({}, STORE_HOURS, { closedDays: [] }) : STORE_HOURS);
const H0 = 8, H1 = 20; // hourly buckets 8 AM … 8 PM (anything outside folds into the first/last)
// Status → chart bucket (Open work orders by status).
const BUCKETS = ['bench', 'parts', 'wait', 'rfp', 'other'];
export const bucketOf = (s) => (s === 2 || s === 3 ? 'parts' : s === 4 || s === 7 ? 'wait' : s === 13 ? 'rfp'
  : [1, 5, 8, 9, 10, 11, 12, 24].includes(s) ? 'bench' : 'other');
const DAILY = { labor_hours: 'labor', labor_hours_gm: 'laborGm', headcount: 'headcount', am_orders: 'am', cleanings_linked: 'cln', assize_fail: 'assizeFail', assize_flag: 'assizeFlag', assize_note: 'assizeNote' };

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (status, error) => json({ error }, status);
const int = (v) => (Number.isInteger(v) ? v : (typeof v === 'string' && /^\d{1,12}$/.test(v) ? Number(v) : null));
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
// Any parseable time → ISO UTC (…Z), so text comparisons in SQL are time comparisons.
export const isoZ = (v) => { if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\d/.test(v)) return null; const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(v) || v.length <= 10 ? v : v + 'Z'); return isNaN(d) ? null : d.toISOString(); };

// ------------------------------------------------------------------ time zone helpers (whole-hour offsets)
const offCache = new Map();
function offsetMs(ms, tz) {
  const hr = Math.floor(ms / 3600000), k = tz + hr;
  let o = offCache.get(k);
  if (o == null) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(hr * 3600000)).map((x) => [x.type, x.value]));
    o = Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute) - hr * 3600000;
    if (offCache.size > 60000) offCache.clear();
    offCache.set(k, o);
  }
  return o;
}
export const local = (ms, tz) => { const d = new Date(ms + offsetMs(ms, tz)); return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours(), dow: d.getUTCDay() }; };
export function localToUtc(day, hour, tz) { const g = Date.parse(day + 'T00:00:00Z') + hour * 3600000; return g - offsetMs(g - offsetMs(g, tz), tz); }
export const addDays = (day, n) => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dowOf = (day) => new Date(day + 'T12:00:00Z').getUTCDay();
const span = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1;
const hourMs = (h) => (h ? Date.parse(h + ':00:00Z') : NaN); // 'YYYY-MM-DDTHH' (UTC, from strftime) → ms

// ------------------------------------------------------------------ status periods
/*
  A WO's status intervals from its plain part: the status history (auditTrail) in time order, plus the
  current status when the history stops before it (Portal's history stops before Sale complete). Closed
  statuses (Sale complete / Closed / Cancelled) end the previous interval and get none of their own, so
  "open" intervals are the only ones kept. → [{ status_id, start_at, end_at|null }]
*/
export function statusPeriodsOf(plain, at, events) {
  const w = (plain && plain.workorder) || {};
  const trail = (events || ((plain && plain.auditTrail) || []).map((a) => ({ s: int(a && a.statusId), t: isoZ(a && a.createdAt) })))
    .filter((e) => e.s != null && e.t).sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : 0));
  const ev = [];
  for (const e of trail) if (!ev.length || ev[ev.length - 1].s !== e.s) ev.push(e);
  const cur = int(w.statusId);
  if (cur != null && ev.length && ev[ev.length - 1].s !== cur) {
    const sold = CLOSED.has(cur) ? isoZ(w.soldAt) || isoZ(w.updatedAt) : isoZ(w.updatedAt);
    ev.push({ s: cur, t: sold && sold > ev[ev.length - 1].t ? sold : (at > ev[ev.length - 1].t ? at : ev[ev.length - 1].t) });
  }
  const out = [];
  for (let i = 0; i < ev.length; i++) {
    if (CLOSED.has(ev[i].s)) continue;
    const end = i + 1 < ev.length ? ev[i + 1].t : null;
    if (end && end <= ev[i].t) continue;
    out.push({ status_id: ev[i].s, start_at: ev[i].t, end_at: end });
  }
  return out;
}

// Statements that make the stored rows for one WO equal `want` (only differences are written).
function syncStmts(T, store, wo, have, want) {
  const stmts = [], keep = new Map(want.map((p) => [p.start_at, p]));
  for (const h of have) if (!keep.has(h.start_at)) stmts.push(T.prepare('DELETE FROM status_periods WHERE store = ? AND wo = ? AND start_at = ?').bind(store, wo, h.start_at));
  const old = new Map(have.map((h) => [h.start_at, h]));
  for (const p of want) {
    const h = old.get(p.start_at);
    if (h && h.status_id === p.status_id && (h.end_at || null) === (p.end_at || null)) continue;
    stmts.push(T.prepare('INSERT INTO status_periods (store, wo, status_id, start_at, end_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (store, wo, start_at) DO UPDATE SET status_id = excluded.status_id, end_at = excluded.end_at')
      .bind(store, wo, p.status_id, p.start_at, p.end_at));
  }
  return stmts;
}

/*
  Kept on each WO detail upload (tracker-worker storeApi, next to rfpPeriodStmts). With a status history the
  WO's rows are rebuilt from it; without one, the open interval is closed / a new one opened on a change.
*/
export async function statusPeriodStmts(T, store, wo, plain, at) {
  const have = (await T.prepare('SELECT status_id, start_at, end_at FROM status_periods WHERE store = ? AND wo = ?').bind(store, wo).all()).results;
  const w = (plain && plain.workorder) || {}, cur = int(w.statusId), upd = isoZ(w.updatedAt) || at;
  if (((plain && plain.auditTrail) || []).length) return syncStmts(T, store, wo, have, statusPeriodsOf(plain, at));
  const open = have.find((h) => !h.end_at);
  if (cur == null || (open && open.status_id === cur)) return [];
  const stmts = [];
  const t = open && upd <= open.start_at ? at : upd;
  if (open) stmts.push(T.prepare('UPDATE status_periods SET end_at = ? WHERE store = ? AND wo = ? AND start_at = ?').bind(t, store, wo, open.start_at));
  if (!CLOSED.has(cur)) stmts.push(T.prepare('INSERT INTO status_periods (store, wo, status_id, start_at) VALUES (?, ?, ?, ?) ON CONFLICT (store, wo, start_at) DO UPDATE SET status_id = excluded.status_id, end_at = NULL').bind(store, wo, cur, t));
  return stmts;
}
// A WO recorded closed without a detail (Portal answered 404 twice): its open interval ends then.
export const closeStatusPeriod = (T, store, wo, at) => T.prepare('UPDATE status_periods SET end_at = ? WHERE store = ? AND wo = ? AND end_at IS NULL').bind(at, store, wo);

// One-time backfill from what's stored: 300 work orders per call, resumable by rowid.
async function backfill(env, after, email) {
  const T = env.TR, at = new Date().toISOString();
  const rows = (await T.prepare('SELECT rowid AS id, store, wo, status_id, is_open, created_at, first_seen_at, closed_at, sold_at, api_updated_at, plain FROM workorders WHERE rowid > ? ORDER BY rowid LIMIT 300').bind(after).all()).results;
  // Finished (a short or empty chunk): recorded, so the page knows the history is whole, not just started by uploads.
  const finished = () => T.prepare('INSERT INTO access_log (email, action, detail, at) VALUES (?, ?, ?, ?)').bind(email || 'system', 'metrics:backfill', 'status history built', at).run();
  if (!rows.length) { await finished(); return { done: true, next: after, processed: 0, written: 0 }; }
  const have = new Map();
  for (const h of (await T.prepare('SELECT store, wo, status_id, start_at, end_at FROM status_periods WHERE (store, wo) IN (SELECT json_extract(value, \'$[0]\'), json_extract(value, \'$[1]\') FROM json_each(?))')
    .bind(JSON.stringify(rows.map((r) => [r.store, r.wo]))).all()).results) (have.get(h.store + '|' + h.wo) || have.set(h.store + '|' + h.wo, []).get(h.store + '|' + h.wo)).push(h);
  const stmts = [];
  for (const r of rows) {
    let plain = null;
    try { plain = r.plain ? JSON.parse(r.plain) : null; } catch (_) {}
    plain = plain || { workorder: { statusId: r.status_id, updatedAt: r.api_updated_at } };
    plain.workorder = Object.assign({}, plain.workorder, { soldAt: r.sold_at });
    let events = null;
    if (!(plain.auditTrail || []).length) { // no history in the plain part: status changes recorded in `changes`
      const ch = (await T.prepare("SELECT changed_at, old, new FROM changes WHERE store = ? AND wo = ? AND field = 'workorder.statusId' ORDER BY id").bind(r.store, r.wo).all()).results;
      const first = isoZ(r.created_at) || isoZ(r.first_seen_at);
      events = [];
      if (ch.length && first && int(ch[0].old) != null) events.push({ s: int(ch[0].old), t: first });
      for (const c of ch) events.push({ s: int(c.new), t: isoZ(c.changed_at) });
      if (!events.length && first && r.status_id != null) events.push({ s: r.status_id, t: first });
    }
    const want = statusPeriodsOf(plain, at, events);
    const last = want[want.length - 1];
    if (last && !last.end_at && (!r.is_open || CLOSED.has(r.status_id))) last.end_at = [isoZ(r.closed_at), isoZ(r.sold_at), at].find((t) => t && t > last.start_at) || at;
    stmts.push(...syncStmts(T, r.store, r.wo, have.get(r.store + '|' + r.wo) || [], want));
  }
  for (let i = 0; i < stmts.length; i += 100) await T.batch(stmts.slice(i, i + 100));
  if (rows.length < 300) await finished();
  return { done: rows.length < 300, next: rows[rows.length - 1].id, processed: rows.length, written: stmts.length };
}

// ------------------------------------------------------------------ device type (model name → type)
export function deviceType(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return 'Other';
  if (/iphone/.test(n)) return 'iPhone';
  if (/ipad|tab\b|galaxy tab|tablet|kindle|fire hd|surface go/.test(n)) return 'iPad / tablet';
  if (/galaxy|samsung/.test(n)) return 'Samsung Galaxy';
  if (/pixel/.test(n)) return 'Pixel';
  if (/macbook|imac|laptop|chromebook|notebook|thinkpad|dell|hp |lenovo|asus|acer|surface|computer|desktop|pc\b/.test(n)) return 'Computer';
  if (/playstation|ps[345]|xbox|switch|nintendo|console|steam deck/.test(n)) return 'Game console';
  return 'Other';
}

// ------------------------------------------------------------------ the dashboard
/*
  Response (arrays are per store, one value per bucket; the browser sums for "All stores"):
    grid.main   buckets at the chosen granularity (hour/day/week): [{ k, from, to, hour?, partial? }]
    grid.day    the daily grid for numbers that only exist per day (uses, uploads, Need to order overnight):
                = main for day/week, per day for hour
    cur.main[metric][store] / cur.day[metric][store]; prev (same shape, the period right before) when compare=1
    tot.cur / tot.prev [metric][store]: flows summed, levels = latest value (the tiles and their deltas)
    perDay.am / perDay.cln [store]: per day in the range (Days at target)
    programs, devices, crystals [store][name] (range); rfpAging [store] (now); waymarks [store] (now);
    freshness [store]; estDays [store]: days estimated from work orders; dailyKeys: uploaded keys with rows in range
  Flows: sales, count, saleTotal, salesLab (sales on days with labor hours), created, completed, ckSum, ckN, rpSum, rpN, uses, labor, laborGm, am, cln, assizeFail, assizeFlag
  Levels: open, bench, parts, wait, rfp, other (end of each bucket; weeks average their days), nto (at store close), active
*/
async function build(env, q) {
  const T = env.TR, A = env.DB || env.AE, tz = env.STORE_TZ || 'America/New_York';
  const { from, to, stores, gran } = q, nowMs = q.now || Date.now(), nowIso = new Date(nowMs).toISOString(), today = local(nowMs, tz).day;
  const n = span(from, to), prevTo = addDays(from, -1), prevFrom = addDays(from, -n);
  const S = JSON.stringify(stores);
  const t0 = new Date(localToUtc(prevFrom, 0, tz)).toISOString(), tC = new Date(localToUtc(from, 0, tz)).toISOString(), t1 = new Date(localToUtc(addDays(to, 1), 0, tz)).toISOString();

  // ---- grids (cur and prev share the shape; prev is shifted n days)
  const mkGrid = (start) => {
    const days = Array.from({ length: n }, (_, i) => addDays(start, i)), main = [], day = [];
    const mi = new Map(), di = new Map();
    if (gran === 'hour') {
      for (const d of days) { for (let h = H0; h <= H1; h++) { mi.set(d + 'T' + h, main.length); main.push({ k: d + 'T' + String(h).padStart(2, '0'), from: d, to: d, hour: h }); } di.set(d, day.length); day.push({ k: d, from: d, to: d }); }
    } else if (gran === 'week') {
      for (let i = 0; i < n; i += 7) { const b = { k: days[i], from: days[i], to: days[Math.min(n - 1, i + 6)] }; for (let j = i; j < Math.min(n, i + 7); j++) { mi.set(days[j], main.length); di.set(days[j], main.length); } main.push(b); day.push(b); }
    } else for (const d of days) { mi.set(d, main.length); di.set(d, main.length); main.push({ k: d, from: d, to: d }); day.push({ k: d, from: d, to: d }); }
    return { days, main, day, mIdx: (d, h) => (gran === 'hour' ? mi.get(d + 'T' + Math.min(H1, Math.max(H0, h))) : mi.get(d)), dIdx: (d) => di.get(d) };
  };
  const G = { cur: mkGrid(from), prev: mkGrid(prevFrom) };
  for (const b of G.cur.main) {
    if (gran !== 'hour') { if (b.to === today) b.partial = true; continue; }
    if (b.from !== today) continue;
    const st = localToUtc(b.from, b.hour, tz), en = localToUtc(b.from, b.hour + 1, tz);
    if (st > nowMs) b.future = true; else if (en > nowMs) b.partial = true;
  }
  for (const b of G.cur.day) if (b.to === today) b.partial = true;
  const periodOf = (d) => (d >= from && d <= to ? 'cur' : d >= prevFrom && d <= prevTo ? 'prev' : null);
  // The previous period stops at the same point: with today in the range, it ends n days before now (yesterday up to this time).
  const prevCut = to === today ? nowMs - n * 86400000 : Infinity;

  const out = { cur: { main: {}, day: {} }, prev: { main: {}, day: {} } };
  const arr = (p, g, m, st) => { const o = out[p][g]; o[m] = o[m] || {}; return (o[m][st] = o[m][st] || new Array(G[p][g].length).fill(0)); };
  const add = (m, g, st, d, h, v, ms) => { const p = periodOf(d); if (!p || v == null || (p === 'prev' && ms > prevCut)) return; const i = g === 'main' ? G[p].mIdx(d, h) : G[p].dIdx(d); if (i != null) arr(p, g, m, st)[i] += v; };
  const addMs = (m, st, ms, v) => { if (isNaN(ms)) return; const l = local(ms, tz); add(m, 'main', st, l.day, l.hour, v, ms); };

  // ---- queries: tracker (one batch), uploads, Waymark (one batch), in parallel
  const IN = 'IN (SELECT value FROM json_each(?))';
  const firstRfp = `NOT EXISTS (SELECT 1 FROM rfp_periods e WHERE e.store = r.store AND e.wo = r.wo AND e.start_at < r.start_at)`;
  const trQ = [
    T.prepare(`SELECT store, day, synced_at FROM sales_days WHERE store ${IN} AND day BETWEEN ? AND ?`).bind(S, prevFrom, to),
    T.prepare(`SELECT store, sale_day AS day, strftime('%Y-%m-%dT%H', sale_at) AS h, SUM(CASE WHEN type = 'Return' THEN -ABS(COALESCE(total, 0)) ELSE COALESCE(total, 0) END) AS net,
        SUM(CASE WHEN type = 'Return' THEN 0 ELSE 1 END) AS n, SUM(CASE WHEN type = 'Return' THEN 0 ELSE COALESCE(total, 0) END) AS gross
      FROM sales s WHERE store ${IN} AND sale_day BETWEEN ? AND ? AND EXISTS (SELECT 1 FROM sales_days d WHERE d.store = s.store AND d.day = s.sale_day) GROUP BY store, sale_day, h`).bind(S, prevFrom, to),
    T.prepare(`SELECT store, COALESCE(NULLIF(program, ''), CASE WHEN wo IS NULL THEN 'Retail / quick sale' ELSE 'Unknown program' END) AS p,
        SUM(CASE WHEN type = 'Return' THEN -ABS(COALESCE(total, 0)) ELSE COALESCE(total, 0) END) AS net
      FROM sales s WHERE store ${IN} AND sale_day BETWEEN ? AND ? AND EXISTS (SELECT 1 FROM sales_days d WHERE d.store = s.store AND d.day = s.sale_day) GROUP BY store, p`).bind(S, from, to),
    T.prepare(`SELECT store, strftime('%Y-%m-%dT%H', COALESCE(sold_at, closed_at)) AS h, COALESCE(NULLIF(program_name, ''), 'Unknown program') AS p,
        SUM(COALESCE(last_cart_value, 0) + COALESCE(last_cart_tax, 0)) AS v, COUNT(*) AS n
      FROM workorders WHERE store ${IN} AND is_open = 0 AND status_id = 14 AND COALESCE(sold_at, closed_at) >= ? AND COALESCE(sold_at, closed_at) < ? GROUP BY store, h, p`).bind(S, t0, t1),
    T.prepare(`SELECT store, strftime('%Y-%m-%dT%H', created_at) AS h, COUNT(*) AS n FROM workorders WHERE store ${IN} AND created_at >= ? AND created_at < ? GROUP BY store, h`).bind(S, t0, t1),
    T.prepare(`SELECT r.store, strftime('%Y-%m-%dT%H', r.start_at) AS h, COUNT(*) AS n,
        SUM(CASE WHEN w.created_at IS NOT NULL AND w.created_at <= r.start_at THEN julianday(r.start_at) - julianday(w.created_at) END) AS ck,
        SUM(CASE WHEN w.created_at IS NOT NULL AND w.created_at <= r.start_at THEN 1 ELSE 0 END) AS ckn
      FROM rfp_periods r JOIN workorders w ON w.store = r.store AND w.wo = r.wo WHERE r.store ${IN} AND r.start_at >= ? AND r.start_at < ? AND ${firstRfp} GROUP BY r.store, h`).bind(S, t0, t1),
    T.prepare(`SELECT r.store, w.device, COUNT(*) AS n FROM rfp_periods r JOIN workorders w ON w.store = r.store AND w.wo = r.wo
      WHERE r.store ${IN} AND r.start_at >= ? AND r.start_at < ? AND ${firstRfp} GROUP BY r.store, w.device`).bind(S, tC, t1),
    T.prepare(`SELECT r.store, strftime('%Y-%m-%dT%H', r.end_at) AS h, COUNT(*) AS n, SUM(julianday(r.end_at) - julianday(r.start_at)) AS d
      FROM rfp_periods r JOIN workorders w ON w.store = r.store AND w.wo = r.wo
      WHERE r.store ${IN} AND r.end_at >= ? AND r.end_at < ? AND w.status_id = 14 AND NOT EXISTS (SELECT 1 FROM rfp_periods e WHERE e.store = r.store AND e.wo = r.wo AND e.start_at > r.start_at)
      GROUP BY r.store, h`).bind(S, t0, t1),
    T.prepare(`SELECT store, status_id AS s, start_at AS a, end_at AS b FROM status_periods WHERE store ${IN} AND end_at IS NULL AND start_at < ?
      UNION ALL SELECT store, status_id, start_at, end_at FROM status_periods WHERE store ${IN} AND end_at >= ? AND start_at < ?`).bind(S, t1, S, t0, t1),
    T.prepare(`SELECT store, CAST(julianday(?) - julianday(start_at) AS INTEGER) AS age, COUNT(*) AS n, SUM(COALESCE(value, 0)) AS v FROM rfp_periods WHERE store ${IN} AND end_at IS NULL GROUP BY store, age`).bind(nowIso, S),
    T.prepare(`SELECT store, wo, MIN(start_at) AS a FROM rfp_periods WHERE store ${IN} AND end_at IS NULL GROUP BY store`).bind(S),
    T.prepare(`SELECT value AS store, (SELECT MIN(at) FROM scans WHERE store = j.value) AS first, (SELECT MAX(at) FROM scans WHERE store = j.value) AS last,
        (SELECT COUNT(*) FROM scans WHERE store = j.value AND at >= ?) AS today, (SELECT note FROM scans WHERE store = j.value ORDER BY at DESC LIMIT 1) AS note,
        (SELECT COUNT(*) FROM workorders WHERE store = j.value AND is_open = 1) AS open FROM json_each(?) j`).bind(new Date(localToUtc(today, 0, tz)).toISOString(), S),
    // Built = the one-time backfill finished (uploads alone only start it for the WOs they touch).
    T.prepare("SELECT COUNT(*) AS n FROM access_log WHERE action = 'metrics:backfill'"),
  ];
  const aeQ = A ? [
    A.prepare(`SELECT store, day, CASE WHEN instr(feature, ':') > 0 THEN substr(feature, 1, instr(feature, ':') - 1) ELSE feature END AS c, SUM(count) AS n
      FROM usage WHERE day BETWEEN ? AND ? AND store ${IN} AND feature != 'active' AND feature NOT LIKE 'active:%' GROUP BY store, day, c`).bind(prevFrom, to, S),
    A.prepare(`SELECT store, day, COUNT(DISTINCT user_id) AS n FROM usage WHERE day BETWEEN ? AND ? AND store ${IN} AND feature = 'active' GROUP BY store, day`).bind(prevFrom, to, S),
    A.prepare(`SELECT day, COUNT(DISTINCT user_id) AS n FROM usage WHERE day BETWEEN ? AND ? AND store ${IN} AND feature = 'active' GROUP BY day`).bind(prevFrom, to, S),
    A.prepare(`SELECT store, SUM(CASE WHEN due < ? THEN 1 ELSE 0 END) AS over, SUM(CASE WHEN due = ? THEN 1 ELSE 0 END) AS due, SUM(CASE WHEN due > ? THEN 1 ELSE 0 END) AS up
      FROM auto_marks m WHERE removed_at IS NULL AND store ${IN}
        AND NOT EXISTS (SELECT 1 FROM wo_closed c WHERE c.store = m.store AND c.wo = m.wo) GROUP BY store`).bind(today, today, today, S), // open WOs only, like Waymark's badge (marks stay 7 days after a WO closes)
    A.prepare("SELECT value FROM config WHERE key = 'cleaningTarget'"),
  ] : [];
  const [tr, dm, ae] = await Promise.all([
    T.batch(trQ),
    T.prepare(`SELECT store, day, metric, value FROM daily_metrics WHERE store ${IN} AND day BETWEEN ? AND ?`).bind(S, prevFrom, to).all().then((r) => r.results).catch(() => []), // table comes with daily uploads
    aeQ.length ? A.batch(aeQ).catch(() => aeQ.map(() => ({ results: [] }))) : [],
  ]);
  const [sDays, sales, progs, est, created, done, devs, pick, sp, aging, oldest, scans, spAny] = tr.map((x) => x.results);

  // ---- sales: Portal's where the day was synced, else estimated from WOs at Sale complete
  const synced = new Set(sDays.map((d) => d.store + '|' + d.day)), dayTotal = new Map(); // store|day → sales (for sales per labor hour)
  const addDay = (st, d, v) => dayTotal.set(st + '|' + d, (dayTotal.get(st + '|' + d) || 0) + v);
  let salesSyncedAt = null;
  for (const d of sDays) if (d.synced_at && (!salesSyncedAt || d.synced_at > salesSyncedAt)) salesSyncedAt = d.synced_at;
  for (const r of sales) {
    const ms = hourMs(r.h), hr = isNaN(ms) ? H0 : local(ms, tz).hour;
    for (const [m, v] of [['sales', r.net], ['count', r.n], ['saleTotal', r.gross]]) { add(m, 'main', r.store, r.day, hr, v, ms); add(m, 'day', r.store, r.day, hr, v, ms); }
    addDay(r.store, r.day, r.net);
  }
  const programs = {}, estDays = {};
  const prog = (st, p, v) => { const o = programs[st] = programs[st] || {}; o[p] = (o[p] || 0) + v; };
  for (const r of progs) prog(r.store, r.p, r.net);
  for (const r of est) {
    const ms = hourMs(r.h); if (isNaN(ms)) continue;
    const l = local(ms, tz);
    if (synced.has(r.store + '|' + l.day) || !periodOf(l.day)) continue;
    for (const [m, v] of [['sales', r.v], ['count', r.n], ['saleTotal', r.v]]) { add(m, 'main', r.store, l.day, l.hour, v, ms); add(m, 'day', r.store, l.day, l.hour, v, ms); }
    addDay(r.store, l.day, r.v);
    if (periodOf(l.day) === 'cur') { prog(r.store, r.p, r.v); (estDays[r.store] = estDays[r.store] || new Set()).add(l.day); }
  }

  // ---- work orders
  for (const r of created) addMs('created', r.store, hourMs(r.h), r.n);
  for (const r of done) { const ms = hourMs(r.h); addMs('completed', r.store, ms, r.n); addMs('ckSum', r.store, ms, r.ck || 0); addMs('ckN', r.store, ms, r.ckn); }
  for (const r of pick) { const ms = hourMs(r.h); addMs('rpSum', r.store, ms, r.d || 0); addMs('rpN', r.store, ms, r.n); }
  const devices = {};
  for (const r of devs) { const o = devices[r.store] = devices[r.store] || {}, k = deviceType(r.device); o[k] = (o[k] || 0) + r.n; }

  // ---- levels from status periods: counts at sample instants (difference arrays over sorted samples)
  const inst = [], want = []; // want: [period, grid, metric, idx, sampleIdx...]
  const pushS = (ms) => { inst.push(ms); return inst.length - 1; };
  const endOf = (d) => Math.min(localToUtc(addDays(d, 1), 0, tz) - 1, nowMs);
  for (const p of ['cur', 'prev']) {
    const g = G[p];
    g.main.forEach((b, i) => {
      if (b.future) return;
      if (gran === 'hour') { const t = localToUtc(b.from, b.hour, tz); if (p === 'prev' && t > prevCut) return; want.push([p, 'main', i, [pushS(Math.min(localToUtc(b.from, b.hour + 1, tz) - 1, p === 'prev' ? prevCut : nowMs))]]); }
      else { const ids = []; for (let d = b.from; d <= b.to; d = addDays(d, 1)) ids.push(pushS(endOf(d))); want.push([p, 'main', i, ids]); }
    });
    // Need to order overnight: at store close on each store's open days (today: now, until close)
    g.day.forEach((b, i) => {
      const ids = [], dows = [];
      for (let d = b.from; d <= b.to; d = addDays(d, 1)) { ids.push(pushS(Math.min(localToUtc(d, STORE_HOURS.close, tz), nowMs))); dows.push(dowOf(d)); }
      if (ids.length) want.push([p, 'nto', i, ids, dows]);
    });
  }
  const latest = { cur: pushS(Math.min(localToUtc(addDays(to, 1), 0, tz) - 1, nowMs)), prev: pushS(Math.min(localToUtc(from, 0, tz) - 1, prevCut)) };
  const order = inst.map((_, i) => i).sort((a, b) => inst[a] - inst[b]), sorted = order.map((i) => inst[i]), rank = new Array(inst.length);
  order.forEach((orig, k) => (rank[orig] = k));
  const lb = (x) => { let lo = 0, hi = sorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < x) lo = m + 1; else hi = m; } return lo; };
  const diffs = new Map(); // store|cat → Int32Array
  const D = (st, c) => { const k = st + '|' + c; let a = diffs.get(k); if (!a) diffs.set(k, (a = new Int32Array(sorted.length + 1))); return a; };
  for (const r of sp) {
    const a = Date.parse(r.a), b = r.b ? Date.parse(r.b) : Infinity, lo = lb(a), hi = b === Infinity ? sorted.length : lb(b);
    if (hi <= lo) continue;
    for (const c of [bucketOf(r.s), 'open'].concat(r.s === 2 ? ['nto'] : [])) { const d = D(r.store, c); d[lo]++; d[hi]--; }
  }
  const counts = new Map();
  for (const [k, d] of diffs) { const c = new Int32Array(sorted.length); let run = 0; for (let i = 0; i < sorted.length; i++) { run += d[i]; c[i] = run; } counts.set(k, c); }
  const at = (st, c, sIdx) => { const a = counts.get(st + '|' + c); return a ? a[rank[sIdx]] : 0; };
  const lvl = { cur: { main: {}, day: {} }, prev: { main: {}, day: {} } };
  for (const st of stores) for (const [p, g, i, all, dows] of want) {
    const cats = g === 'nto' ? ['nto'] : ['open', ...BUCKETS], grid = g === 'nto' ? 'day' : 'main';
    const ids = dows ? all.filter((_, k) => !hoursFor(st).closedDays.includes(dows[k])) : all;
    for (const c of cats) {
      const m = c === 'nto' ? 'nto' : c, o = lvl[p][grid][m] = lvl[p][grid][m] || {};
      (o[st] = o[st] || new Array(G[p][grid].length).fill(null))[i] = ids.length ? ids.reduce((s, x) => s + at(st, c, x), 0) / ids.length : null;
    }
  }
  for (const p of ['cur', 'prev']) for (const g of ['main', 'day']) Object.assign(out[p][g], lvl[p][g]);

  // ---- uploads (daily_metrics), usage
  const dailyKeys = new Set(), perDay = { am: {}, cln: {} };
  for (const r of dm) {
    const m = DAILY[r.metric]; if (!m || !periodOf(r.day)) continue;
    add(m, 'day', r.store, r.day, 0, r.value);
    if (m === 'labor' && r.value > 0) add('salesLab', 'day', r.store, r.day, 0, dayTotal.get(r.store + '|' + r.day) || 0); // SPLH: sales of days that have hours
    if (periodOf(r.day) === 'cur') dailyKeys.add(r.metric);
    if ((m === 'am' || m === 'cln') && periodOf(r.day) === 'cur') { const a = perDay[m][r.store] = perDay[m][r.store] || new Array(n).fill(null); const i = span(from, r.day) - 1; a[i] = (a[i] || 0) + r.value; }
  }
  const [use, act, actAll, marks, cfg] = ae.map ? ae.map((x) => x.results) : [];
  const crystals = {};
  for (const r of use || []) { add('uses', 'day', r.store, r.day, 0, r.n); if (periodOf(r.day) === 'cur') { const o = crystals[r.store] = crystals[r.store] || {}; o[r.c] = (o[r.c] || 0) + r.n; } }
  // Active people: a level per day (weeks average their days); "all" = distinct people across the selected stores
  const actLvl = (rows, key) => { for (const r of rows || []) { const p = periodOf(r.day); if (!p) continue; const i = G[p].dIdx(r.day), o = out[p].day.active = out[p].day.active || {}; const a = o[key(r)] = o[key(r)] || new Array(G[p].day.length).fill(0).map(() => []); a[i].push(r.n); } };
  actLvl(act, (r) => r.store); actLvl(actAll, () => 'all');
  for (const p of ['cur', 'prev']) {
    const o = out[p].day.active || {};
    for (const k of Object.keys(o)) o[k] = o[k].map((v, i) => { const b = G[p].day[i], len = span(b.from, b.to > today ? today : b.to); return v.length ? v.reduce((s, x) => s + x, 0) / Math.max(1, len) : 0; });
  }

  // ---- before tracking: tracker-derived buckets that end before a store's first scan are gaps, not zeros
  const since = {}; for (const s of scans) since[s.store] = s.first ? local(Date.parse(s.first), tz).day : null;
  const TRACKED = ['created', 'completed', 'ckSum', 'ckN', 'rpSum', 'rpN', 'open', 'nto', ...BUCKETS];
  for (const p of ['cur', 'prev']) for (const g of ['main', 'day']) for (const m of TRACKED) {
    const o = out[p][g][m]; if (!o) continue;
    for (const st of stores) { const a = o[st]; if (!a) continue; G[p][g].forEach((b, i) => { if (!since[st] || b.to < since[st]) a[i] = null; else if (b.future) a[i] = null; }); }
  }
  // Ensure every store has every metric (zeros), rounded
  const FLOWS_MAIN = ['sales', 'count', 'saleTotal', 'created', 'completed', 'ckSum', 'ckN', 'rpSum', 'rpN'], FLOWS_DAY = ['sales', 'count', 'saleTotal', 'uses', 'salesLab', ...Object.values(DAILY)];
  for (const p of ['cur', 'prev']) {
    for (const m of FLOWS_MAIN) for (const st of stores) { const a = arr(p, 'main', m, st); G[p].main.forEach((b, i) => { if (b.future) a[i] = null; }); }
    for (const m of FLOWS_DAY) for (const st of stores) arr(p, 'day', m, st);
    for (const g of ['main', 'day']) for (const m of Object.keys(out[p][g])) for (const k of Object.keys(out[p][g][m])) out[p][g][m][k] = out[p][g][m][k].map(r2);
  }

  // ---- totals for tiles: flows summed over the period, levels at its latest instant
  const tot = { cur: {}, prev: {} };
  for (const p of ['cur', 'prev']) {
    for (const g of ['main', 'day']) for (const m of Object.keys(out[p][g])) {
      if (['open', 'nto', 'active', ...BUCKETS].includes(m)) continue;
      if (g === 'day' && FLOWS_MAIN.includes(m)) continue;
      tot[p][m] = {}; for (const k of Object.keys(out[p][g][m])) tot[p][m][k] = r2(out[p][g][m][k].reduce((s, v) => s + (v || 0), 0));
    }
    for (const c of ['open', ...BUCKETS]) { tot[p][c] = {}; for (const st of stores) tot[p][c][st] = since[st] ? at(st, c, latest[p]) : null; }
    const lastOf = (a) => { if (!a) return null; for (let i = a.length - 1; i >= 0; i--) if (a[i] != null && !(p === 'cur' && G[p].day[i] && G[p].day[i].from > today)) return a[i]; return null; };
    tot[p].nto = {}; for (const st of stores) tot[p].nto[st] = lastOf((out[p].day.nto || {})[st]);
    // Active people: the latest day with any use (a quiet Sunday shouldn't read as zero)
    tot[p].active = {}; for (const k of Object.keys(out[p].day.active || {})) { const a = out[p].day.active[k]; let v = null; for (let i = a.length - 1; i >= 0; i--) if (a[i]) { v = a[i]; break; } tot[p].active[k] = v; }
  }

  // ---- now: RFP aging, Auto-Waymarks, freshness
  const AGE = [[0, 2, '0–2 days'], [3, 6, '3–6 days'], [7, 13, '7–13 days'], [14, 29, '14–29 days'], [30, 1e9, '30+ days']];
  const rfpAging = {};
  for (const r of aging) { const o = rfpAging[r.store] = rfpAging[r.store] || { buckets: AGE.map((x) => ({ label: x[2], n: 0 })), value: 0, count: 0 }; const b = AGE.findIndex((x) => r.age >= x[0] && r.age <= x[1]); o.buckets[b < 0 ? 0 : b].n += r.n; o.value = r2(o.value + r.v); o.count += r.n; }
  for (const r of oldest) if (rfpAging[r.store]) Object.assign(rfpAging[r.store], { oldestWo: r.wo, oldestDays: Math.floor((nowMs - Date.parse(r.a)) / 86400000) });
  const waymarks = {}; for (const r of marks || []) waymarks[r.store] = { over: r.over || 0, due: r.due || 0, up: r.up || 0 };
  const lt = local(nowMs, tz), openNow = (st) => { const h = hoursFor(st); return !h.closedDays.includes(lt.dow) && lt.hour >= h.open && lt.hour < h.close; };
  const freshness = {};
  for (const s of scans) {
    const age = s.last ? Math.round((nowMs - Date.parse(s.last)) / 60000) : null;
    freshness[s.store] = { last: s.last, ageMin: age, today: s.today, open: s.open, note: s.note,
      state: age == null ? 'critical' : age < 20 ? 'good' : !openNow(s.store) ? 'closed' : age < 120 ? 'warning' : 'critical' };
  }
  let target = 75; try { const v = cfg && cfg[0] ? JSON.parse(cfg[0].value) : null; if (Number.isFinite(v)) target = v; } catch (_) {}

  return {
    from, to, prevFrom, prevTo, gran, days: n, tz, now: nowIso, today, compare: q.compare,
    grid: { main: G.cur.main, day: G.cur.day, prevMain: q.compare ? G.prev.main : undefined },
    cur: out.cur, prev: q.compare ? out.prev : null, tot, perDay,
    programs, devices, crystals, rfpAging, waymarks, freshness, since,
    estDays: Object.fromEntries(Object.entries(estDays).map(([k, v]) => [k, [...v].sort()])),
    dailyKeys: [...dailyKeys], cleaningTarget: target, salesSyncedAt, statusHistory: !!spAny[0].n,
    dataAsOf: scans.reduce((m, s) => (s.last && (!m || s.last > m) ? s.last : m), null),
  };
}

// ------------------------------------------------------------------ route
const full = (me) => !!me && (me.owner === true || me.scope === 'all');
const seeAll = full;
export async function metricsApi(req, env, url, path, me) {
  if (!me) return fail(403, 'not on the tracker list');
  if (req.method === 'POST' && path === '/metrics/backfill') {
    if (!full(me)) return fail(403, 'full access only');
    return json(await backfill(env, Number(url.searchParams.get('after')) || 0, me.email));
  }
  if (req.method !== 'GET' || path !== '/metrics') return fail(404, 'not found');
  const A = env.DB || env.AE, qs = url.searchParams, tz = env.STORE_TZ || 'America/New_York';
  // Stores: Aethernet's store list (names), limited to what this person may see.
  const known = A ? (await A.prepare('SELECT store, name FROM store_access ORDER BY store').all().catch(() => ({ results: [] }))).results : [];
  const mine = (me.stores || []).map(Number);
  const visible = known.filter((s) => seeAll(me) || mine.includes(s.store));
  for (const st of seeAll(me) ? [] : mine) if (!visible.some((s) => s.store === st)) visible.push({ store: st, name: null });
  const ask = String(qs.get('stores') || 'all');
  let stores;
  if (ask === 'all') stores = visible.map((s) => s.store);
  else {
    stores = [...new Set(ask.split(',').map((x) => int(x.trim())).filter(Boolean))];
    if (!stores.length) return fail(400, 'stores: all or a list of store numbers');
    if (stores.some((s) => !visible.some((v) => v.store === s))) return fail(403, 'not your store');
  }
  const today = local(Date.now(), tz).day;
  let from = String(qs.get('from') || ''), to = String(qs.get('to') || '');
  if (!DAY_RE.test(from) || !DAY_RE.test(to) || to < from) return fail(400, 'from/to (YYYY-MM-DD) required');
  if (to > today) to = today;
  if (from > to) from = to;
  const n = span(from, to);
  if (n > 400) return fail(400, 'at most 400 days');
  let gran = String(qs.get('granularity') || 'auto');
  if (gran === 'hour' && n > 7) gran = 'auto';
  if (gran === 'week' && n < 14) gran = 'auto';
  if (!['hour', 'day', 'week'].includes(gran)) gran = n <= 2 ? 'hour' : n <= 92 ? 'day' : 'week';
  const compare = qs.get('compare') === '1';
  const storeList = visible.map((s) => ({ id: s.store, name: s.name }));
  if (!stores.length) return json({ from, to, gran, stores: storeList, selected: [], empty: true });
  // Five-minute cache per (scope, query): repeat loads and other people with the same view cost no D1 reads.
  const cacheKey = 'https://metrics.cache/' + encodeURIComponent([stores.join(','), from, to, gran, compare ? 1 : 0].join('|'));
  const cache = typeof caches !== 'undefined' && qs.get('fresh') !== '1' ? caches.default : null;
  if (cache) { const hit = await cache.match(cacheKey).catch(() => null); if (hit) { const j = await hit.json(); return json(Object.assign(j, { stores: storeList, selected: stores, canBackfill: full(me), cached: true })); } }
  const body = await build(env, { from, to, stores, gran, compare });
  Object.assign(body, { stores: storeList, selected: stores, canBackfill: full(me) });
  if (cache) await cache.put(cacheKey, new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=300' } })).catch(() => {});
  return json(body);
}

export { build as buildMetrics };
