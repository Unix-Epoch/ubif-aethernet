/*
  Daily metrics: plain numbers Aethernet uploads once a store browser has computed them, for the admin Metrics page.
    POST /v1/:store/tracker/daily { day: 'YYYY-MM-DD', metrics: { key: number }, source: 'tactician'|'divination'|'assize', by }
  → { ok, saved }. Only the keys below, finite numbers, a day from the last 14 days up to today (store time).
  Upserts (store, day, metric); a later upload for the same day replaces it. Store access and the sandbox
  guard are checked by index.js before this runs. Nothing here is customer data.
*/
export const METRICS = ['labor_hours', 'labor_hours_gm', 'headcount', 'am_orders', 'cleanings_linked', 'assize_fail', 'assize_flag', 'assize_note'];
const SOURCES = ['tactician', 'divination', 'assize'];
const DAY_RE = /^\d{4}-\d\d-\d\d$/;
const dayIn = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

export async function daily(req, env, store, { readJson, json, fail, clean }) {
  const b = await readJson(req, 4000);
  const tz = env.STORE_TZ || 'America/New_York';
  const day = typeof b.day === 'string' ? b.day : '';
  const today = dayIn(Date.now(), tz), oldest = dayIn(Date.now() - 14 * 86400000, tz);
  if (!DAY_RE.test(day) || isNaN(Date.parse(day)) || day > today || day < oldest) return fail(400, 'day must be within the last 14 days');
  if (!SOURCES.includes(b.source)) return fail(400, 'bad source');
  const m = b.metrics;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return fail(400, 'metrics required');
  const keys = Object.keys(m);
  if (!keys.length || keys.length > METRICS.length) return fail(400, 'metrics required');
  for (const k of keys) {
    if (!METRICS.includes(k)) return fail(400, 'unknown metric: ' + clean(k, 40));
    if (typeof m[k] !== 'number' || !isFinite(m[k]) || m[k] < 0 || m[k] > 100000) return fail(400, 'bad value for ' + k);
  }
  const at = new Date().toISOString(), by = clean(b.by, 60) || null;
  await env.TR.batch(keys.map((k) => env.TR.prepare(`INSERT INTO daily_metrics (store, day, metric, value, source, by_name, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (store, day, metric) DO UPDATE SET value = excluded.value, source = excluded.source, by_name = excluded.by_name, updated_at = excluded.updated_at`)
    .bind(store, day, k, Math.round(m[k] * 1000) / 1000, b.source, by, at)));
  return json({ ok: true, saved: keys.length });
}
