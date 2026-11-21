/*
  Linkpearl: alerts, under /v1/agents/m/alerts… and the 10-minute tick (stream: Alerts). Contract and examples: MOBILE-API-alerts.md.
  There is no push service. The app's background check (about every 15 minutes) asks GET /alerts/new?since=<cursor> and raises local notifications.

    GET  /v1/agents/m/alerts?store=&after=&before=&limit=   the feed, newest first, with read state, notify flags, unread count, cursor
    GET  /v1/agents/m/alerts/new[?since=<cursor>]            the background poll: only entries that should notify now, tiny, + the next cursor
    POST /v1/agents/m/alerts/read   { ids: [..] } | { all: true[, store] }
    GET|PUT /v1/agents/m/alerts/settings                     this phone's switches, thresholds, quiet hours, per-store switches

  alertsTick(env, nowMs) runs every 10 minutes (index.js scheduled(), TICK_CRON) and writes the feed. Rules (types):
    stuck     an open work order in its current status longer than the threshold (status_periods; unknown start = no alert; never Ready for pickup)
    pickup    devices at Ready for pickup longer than the threshold (rfp_periods): ONE alert per store per day, from 9:00 on days the store is open
    followup  an Auto-Waymark mark (Waymark database, auto_marks) with due = today, from the follow-up hour on (default 9:00)
    quiet     no scan for longer than the threshold of OPEN-hours time (hoursFor); once per spell; cleared when scans resume (a 'back' entry, feed only)
    digest    the morning summary, once a day per phone SCOPE (below), from the digest hour on (default 8:00)
    unlinked  Retrace sales orders still without a work order (inv_so_need, no inv_so_wo row) for longer than the threshold (hours since the sales
              order's first movement); one alert per store per tick listing them; each sales order alerts once per level (alert_items)
    coverage  a stored Retrace coverage check result (inv_verify) with failures (count misses or missed items); one alert per result (checked_at)

  Thresholds: the rules run once per store, the thresholds are per phone. A phone's threshold is the `level` of the alerts it sees: the tick
  raises an alert for every DISTINCT level among the store's approved phones (normally one), and a phone's reads match only its own level.
  Nothing is lost when a phone has a higher threshold than another (a minimum-threshold-only design would never alert it at its own level).
  Switches and quiet hours are applied when a phone reads, so the feed stays complete (one exception: a digest is only made for a scope at least
  one phone with the digest switched on asks for; switched on after its hour, the next tick makes today's, feed-only when over an hour late).

  The digest is not per store: it covers ALL of a phone's switched-on stores in one entry. Its scope key is the sorted store list plus the
  phone's stuck threshold ("326,914|3"); phones with the same scope share one digest. The row is filed under the scope's first store, its
  subject is "<scope key>@<day>", its level the digest hour; a phone's feed matches the subject's scope key to its own (so a phone with
  914 + 326 gets one combined digest, never the single-store ones of a 914-only phone). A store switched off leaves the phone's scope, so
  its digest covers only the stores it wants (none on: no digest). A feed filtered to one store leaves digests out.

  No customer or staff names, phones or e-mails anywhere in an alert (facts are status name/id, days, count, times, due date, work order and
  sales order numbers, money totals).
*/
import { local, localToUtc, addDays, hoursFor } from './metrics.js';
import { buildHome, SPLH_TARGET } from './mobile.js';

export const TYPES = ['stuck', 'pickup', 'followup', 'quiet', 'digest', 'unlinked', 'coverage'];
export const DEFAULTS = {
  types: { stuck: { on: true, days: 3 }, pickup: { on: true, days: 7 }, followup: { on: true, hour: 9 }, quiet: { on: true, hours: 2 },
    digest: { on: true, hour: 8 }, unlinked: { on: true, hours: 1 }, coverage: { on: true } },
  quietHours: { on: true, from: '22:00', to: '07:00' },
};
export const RANGES = { stuckDays: [1, 30], pickupDays: [1, 30], quietHours: [1, 12], followupHour: [0, 23], digestHour: [0, 23], unlinkedHours: [1, 48] };
export const DIGEST_LIST = 10;        // work orders listed per digest section (follow-ups, stuck); the count covers all
export const UNLINKED_LIST = 100;     // sales orders per unlinked alert (more wait for the next tick)
export const CAP_PER_TICK = 25;       // alerts created per store per tick, all rules together (the rest wait for the next tick)
export const RETENTION_DAYS = 60;
export const PICKUP_HOUR = 9;         // the daily Ready-for-pickup summary is raised from this local hour
const BACKFILL_SECONDS = 3600;        // a stuck alert raised more than this long after it crossed its threshold is feed-only
const MAX_AGE_MS = 12 * 3600000;      // a poll never notifies an entry older than this (held during quiet hours, then too old)
const MAX_NEW = 50, MAX_IDS = 100, DAY_S = 86400;

const tzOf = (env) => env.STORE_TZ || 'America/New_York';
const isInt = (v) => Number.isInteger(v);
const parse = (s, d) => { try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : d; } catch (_) { return d; } };
const minuteOfDay = (ms, tz) => local(ms, tz).hour * 60 + new Date(ms).getUTCMinutes(); // US zones: whole-hour offsets
const hm = (s) => { const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

// ---------------------------------------------------------------- settings (per phone)
// Stored as the merged JSON of the phone's changes; read as defaults + that, for the phone's approved stores.
export function normalize(raw, stores) {
  const r = raw && typeof raw === 'object' ? raw : {}, t = r.types || {}, q = r.quietHours || {}, st = r.stores || {};
  const pick = (k, f, lo, hi, d) => (t[k] && isInt(t[k][f]) && t[k][f] >= lo && t[k][f] <= hi ? t[k][f] : d);
  const on = (k) => (t[k] && typeof t[k].on === 'boolean' ? t[k].on : true);
  const o = {
    types: {
      stuck: { on: on('stuck'), days: pick('stuck', 'days', ...RANGES.stuckDays, DEFAULTS.types.stuck.days) },
      pickup: { on: on('pickup'), days: pick('pickup', 'days', ...RANGES.pickupDays, DEFAULTS.types.pickup.days) },
      followup: { on: on('followup'), hour: pick('followup', 'hour', ...RANGES.followupHour, DEFAULTS.types.followup.hour) },
      quiet: { on: on('quiet'), hours: pick('quiet', 'hours', ...RANGES.quietHours, DEFAULTS.types.quiet.hours) },
      digest: { on: on('digest'), hour: pick('digest', 'hour', ...RANGES.digestHour, DEFAULTS.types.digest.hour) },
      unlinked: { on: on('unlinked'), hours: pick('unlinked', 'hours', ...RANGES.unlinkedHours, DEFAULTS.types.unlinked.hours) },
      coverage: { on: on('coverage') },
    },
    quietHours: { on: typeof q.on === 'boolean' ? q.on : DEFAULTS.quietHours.on, from: hm(q.from) != null ? q.from : DEFAULTS.quietHours.from, to: hm(q.to) != null ? q.to : DEFAULTS.quietHours.to },
    stores: {},
  };
  for (const s of stores) o.stores[s] = st[s] === false ? false : true;
  return o;
}
const levelsOf = (s) => ({ stuck: s.types.stuck.days, pickup: s.types.pickup.days, followup: s.types.followup.hour, quiet: s.types.quiet.hours,
  digest: s.types.digest.hour, unlinked: s.types.unlinked.hours, coverage: 0 });
// The phone's approved stores that are switched on: the only stores it hears about (alerts, the digest's scope, Linkshell pushes).
export const onStores = (stores, s) => stores.filter((x) => s.stores[x] !== false);
// The digest's scope key: the phone's switched-on stores (sorted) and its stuck threshold (the digest lists stuck work orders at it).
export const scopeKey = (stores, s) => [...stores].map(Number).sort((a, b) => a - b).join(',') + '|' + s.types.stuck.days;

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
// Validates a PUT body against the ranges and merges it onto the stored settings. Unknown keys are refused (a typo must not silently do nothing).
export function mergeSettings(stored, body, stores) {
  const known = (obj, keys, where) => { for (const k of Object.keys(obj)) if (!keys.includes(k)) throw bad(`unknown setting "${where}${k}"`); };
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(body)) throw bad('body must be a JSON object');
  known(body, ['types', 'quietHours', 'stores'], '');
  const out = { types: {}, quietHours: Object.assign({}, stored.quietHours), stores: Object.assign({}, stored.stores) };
  for (const k of TYPES) out.types[k] = Object.assign({}, stored.types[k]);
  const num = { stuck: ['days', RANGES.stuckDays, 'days'], pickup: ['days', RANGES.pickupDays, 'days'], followup: ['hour', RANGES.followupHour, 'hour of the day'], quiet: ['hours', RANGES.quietHours, 'hours of silence'],
    digest: ['hour', RANGES.digestHour, 'hour of the day'], unlinked: ['hours', RANGES.unlinkedHours, 'hours without a work order'] }; // coverage: a switch only
  if (body.types !== undefined) {
    if (!isObj(body.types)) throw bad('types must be an object');
    known(body.types, TYPES, 'types.');
    for (const [k, v] of Object.entries(body.types)) {
      if (!isObj(v)) throw bad(`types.${k} must be an object`);
      const [f, [lo, hi], label] = num[k] || [null, [0, 0], ''];
      known(v, f ? ['on', f] : ['on'], `types.${k}.`);
      if (v.on !== undefined) { if (typeof v.on !== 'boolean') throw bad(`types.${k}.on must be true or false`); out.types[k].on = v.on; }
      if (f && v[f] !== undefined) { if (!isInt(v[f]) || v[f] < lo || v[f] > hi) throw bad(`types.${k}.${f}: ${label} must be a whole number from ${lo} to ${hi}`); out.types[k][f] = v[f]; }
    }
  }
  if (body.quietHours !== undefined) {
    const q = body.quietHours;
    if (!isObj(q)) throw bad('quietHours must be an object');
    known(q, ['on', 'from', 'to'], 'quietHours.');
    if (q.on !== undefined) { if (typeof q.on !== 'boolean') throw bad('quietHours.on must be true or false'); out.quietHours.on = q.on; }
    for (const f of ['from', 'to']) if (q[f] !== undefined) { if (typeof q[f] !== 'string' || hm(q[f]) == null) throw bad(`quietHours.${f} must be a time like "22:00" (24-hour, store local time)`); out.quietHours[f] = q[f]; }
    if (out.quietHours.from === out.quietHours.to) throw bad('quietHours.from and quietHours.to must differ');
  }
  if (body.stores !== undefined) {
    if (!isObj(body.stores)) throw bad('stores must be an object of store id: true or false');
    for (const [k, v] of Object.entries(body.stores)) {
      if (!/^\d{1,6}$/.test(k)) throw bad(`stores: "${k}" is not a store number`);
      if (!stores.includes(Number(k))) throw Object.assign(new Error('not your store'), { status: 403 });
      if (typeof v !== 'boolean') throw bad(`stores.${k} must be true or false`);
      out.stores[Number(k)] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------- the tick
const DEVICES_SQL = `SELECT a.id, a.stores, d.settings FROM agents a JOIN agent_kind k ON k.agent_id = a.id AND k.kind = 'phone'
  LEFT JOIN alert_device d ON d.device_id = a.id WHERE a.status = 'active'`;
const NOWS = "CAST(strftime('%s', ?1) AS INTEGER)";

// Stuck: one statement per store. Dedupe: the same status period (an alert for this WO + status created after the period began) alerts once per level;
// leaving the status and coming back starts a new period, which alerts again. A WO already past its threshold by more than an hour when first seen is feed-only.
const STUCK_SQL = `INSERT OR IGNORE INTO alerts (store, type, subject, level, wo, created_at, data, backfill)
  SELECT p.store, 'stuck', p.status_id || '@' || p.start_at, j.value, p.wo, ?1,
    json_object('statusId', p.status_id, 'status', COALESCE(s.name, w.status_name), 'days', (${NOWS} - CAST(strftime('%s', p.start_at) AS INTEGER)) / ${DAY_S}, 'since', p.start_at),
    CASE WHEN ${NOWS} - CAST(strftime('%s', p.start_at) AS INTEGER) - j.value * ${DAY_S} > ${BACKFILL_SECONDS} THEN 1 ELSE 0 END
  FROM status_periods p
  JOIN workorders w ON w.store = p.store AND w.wo = p.wo AND w.is_open = 1 AND w.status_id = p.status_id
  JOIN json_each(?2) j
  LEFT JOIN statuses s ON s.id = p.status_id
  WHERE p.store = ?3 AND p.end_at IS NULL AND p.status_id != 13
    AND ${NOWS} - CAST(strftime('%s', p.start_at) AS INTEGER) > j.value * ${DAY_S}
    AND NOT EXISTS (SELECT 1 FROM alerts a WHERE a.store = p.store AND a.type = 'stuck' AND a.wo = p.wo AND a.level = j.value AND a.created_at >= p.start_at AND a.subject LIKE p.status_id || '@%')
  ORDER BY p.start_at LIMIT ?4`;

const PICKUP_SQL = `INSERT OR IGNORE INTO alerts (store, type, subject, level, wo, created_at, data, backfill)
  SELECT ?3, 'pickup', ?4, j.value, NULL, ?1,
    json_object('count', COUNT(*), 'days', j.value, 'oldestDays', MAX(${NOWS} - CAST(strftime('%s', r.start_at) AS INTEGER)) / ${DAY_S}), 0
  FROM rfp_periods r JOIN json_each(?2) j
  WHERE r.store = ?3 AND r.end_at IS NULL AND ${NOWS} - CAST(strftime('%s', r.start_at) AS INTEGER) > j.value * ${DAY_S}
  GROUP BY j.value`;

const FOLLOWUP_SQL = `INSERT OR IGNORE INTO alerts (store, type, subject, level, wo, created_at, data, backfill)
  SELECT ?3, 'followup', json_extract(m.value, '$.wo') || '@' || json_extract(m.value, '$.due'), j.value, json_extract(m.value, '$.wo'), ?1,
    json_object('due', json_extract(m.value, '$.due'), 'kind', json_extract(m.value, '$.kind')), 0
  FROM json_each(?2) m JOIN json_each(?4) j LIMIT ?5`;

const QUIET_SQL = `INSERT OR IGNORE INTO alerts (store, type, subject, level, wo, created_at, data, backfill)
  SELECT ?3, 'quiet', ?4, j.value, NULL, ?1, json_object('since', ?4, 'hours', j.value), 0 FROM json_each(?2) j`;

// Unlinked: every approved store in one statement. ?2 stores JSON, ?3 { "s<store>": [levels] }. A sales order Retrace still asks about
// (inv_so_need) with no work order link (inv_so_wo) and not yet alerted at that level (alert_items); its age is from its first movement
// (inv_mv_ref). The age test runs on the rows that survive the key look-ups, so the steady state reads the store's inv_so_need rows and indexes only.
const UNLINKED_SQL = `SELECT store, level, sales_order, since FROM (
    SELECT n.store AS store, j.value AS level, n.sales_order AS sales_order,
      (SELECT MIN(m.at) FROM inv_movements m WHERE m.store = n.store AND m.ref_type = 'sales_order' AND m.ref_id = n.sales_order) AS since
    FROM inv_so_need n JOIN json_each(?3, '$.s' || n.store) j
    WHERE n.store IN (SELECT value FROM json_each(?2))
      AND NOT EXISTS (SELECT 1 FROM inv_so_wo w WHERE w.store = n.store AND w.sales_order = n.sales_order)
      AND NOT EXISTS (SELECT 1 FROM alert_items i WHERE i.store = n.store AND i.type = 'unlinked' AND i.level = j.value AND i.item = n.sales_order))
  WHERE since IS NOT NULL AND ${NOWS} - CAST(strftime('%s', since) AS INTEGER) > level * 3600
  ORDER BY store, level, since, sales_order LIMIT 2000`;
// One grouped alert (subject: its first sales order, which never alerts again at that level) and its sales orders remembered, in one batch.
const UNLINKED_INS = `INSERT OR IGNORE INTO alerts (store, type, subject, level, wo, created_at, data, backfill) VALUES (?1, 'unlinked', ?2, ?3, NULL, ?4, ?5, ?6)`;
const UNLINKED_ITEMS = `INSERT OR IGNORE INTO alert_items (store, type, level, item, alert_id)
  SELECT ?1, 'unlinked', ?3, j.value, a.id FROM json_each(?4) j JOIN alerts a ON a.store = ?1 AND a.type = 'unlinked' AND a.subject = ?2 AND a.level = ?3`;

// Coverage: every approved store in one statement; one alert per stored result (subject = its checked_at) that has failures. Results older than
// the retention are left alone (their alert would be deleted and raised again). A result first seen over an hour after its run is feed-only.
const COVERAGE_SQL = `INSERT OR IGNORE INTO alerts (store, type, subject, level, wo, created_at, data, backfill)
  SELECT v.store, 'coverage', v.checked_at, 0, NULL, ?1,
    json_object('checkedAt', v.checked_at, 'countMisses', COALESCE(json_extract(v.result, '$.counts.n'), 0), 'countItems', json_extract(v.result, '$.counts.total'),
      'missedItems', COALESCE(json_extract(v.result, '$.missed.n'), 0), 'qtyMisses', COALESCE(json_extract(v.result, '$.qty.n'), 0), 'staleLabels', COALESCE(json_extract(v.result, '$.stale.n'), 0)),
    CASE WHEN ${NOWS} - CAST(strftime('%s', v.checked_at) AS INTEGER) > ${BACKFILL_SECONDS} THEN 1 ELSE 0 END
  FROM inv_verify v
  WHERE v.store IN (SELECT value FROM json_each(?2)) AND v.checked_at > ?3
    AND NOT EXISTS (SELECT 1 FROM alerts a WHERE a.store = v.store AND a.type = 'coverage' AND a.subject = v.checked_at AND a.level = 0)
    AND (COALESCE(json_extract(v.result, '$.counts.n'), 0) > 0 OR COALESCE(json_extract(v.result, '$.missed.n'), 0) > 0)
  RETURNING store`;

// Digest: stuck work orders over a scope (count + the oldest DIGEST_LIST), labor hours of the day before, the statuses of today's follow-ups.
const DIGEST_STUCK_SQL = `SELECT p.store, p.wo, COALESCE(s.name, w.status_name) AS status, (${NOWS} - CAST(strftime('%s', p.start_at) AS INTEGER)) / ${DAY_S} AS days, COUNT(*) OVER () AS n
  FROM status_periods p
  JOIN workorders w ON w.store = p.store AND w.wo = p.wo AND w.is_open = 1 AND w.status_id = p.status_id
  LEFT JOIN statuses s ON s.id = p.status_id
  WHERE p.store IN (SELECT value FROM json_each(?2)) AND p.end_at IS NULL AND p.status_id != 13
    AND ${NOWS} - CAST(strftime('%s', p.start_at) AS INTEGER) > ?3 * ${DAY_S}
  ORDER BY p.start_at, p.store, p.wo LIMIT ${DIGEST_LIST}`;
const DIGEST_LABOR_SQL = `SELECT SUM(value) AS h, COUNT(*) AS n FROM daily_metrics WHERE store IN (SELECT value FROM json_each(?1)) AND day = ?2 AND metric = 'labor_hours'`;
const DIGEST_STATUS_SQL = `SELECT w.store, w.wo, COALESCE(s.name, w.status_name) AS status FROM json_each(?1) j
  JOIN workorders w ON w.store = json_extract(j.value, '$[0]') AND w.wo = json_extract(j.value, '$[1]') LEFT JOIN statuses s ON s.id = w.status_id`;
const DIGEST_HAVE_SQL = `SELECT subject, level FROM alerts WHERE type = 'digest' AND store IN (SELECT value FROM json_each(?1)) AND subject IN (SELECT value FROM json_each(?2))`;
const DIGEST_INS = `INSERT OR IGNORE INTO alerts (store, type, subject, level, wo, created_at, data, backfill) VALUES (?1, 'digest', ?2, ?3, NULL, ?4, ?5, ?6)`;

export const SQL = { STUCK_SQL, PICKUP_SQL, FOLLOWUP_SQL, QUIET_SQL, UNLINKED_SQL, COVERAGE_SQL, DIGEST_STUCK_SQL }; // exported for the cost checks in the tests

// Open-hours time between two instants for a store (hoursFor): a night or a closed day is not silence.
export function openMsBetween(store, fromMs, toMs, tz) {
  const h = hoursFor(store), end = local(toMs, tz).day;
  let day = local(fromMs, tz).day;
  const first = addDays(end, -15);
  if (day < first) day = first; // a long silence is counted over its last 16 days
  let total = 0;
  for (; day <= end; day = addDays(day, 1)) {
    if (h.closedDays.includes(new Date(day + 'T12:00:00Z').getUTCDay())) continue;
    const a = Math.max(fromMs, localToUtc(day, h.open, tz)), b = Math.min(toMs, localToUtc(day, h.close, tz));
    if (b > a) total += b - a;
  }
  return total;
}
const isOpenAt = (store, ms, tz) => { const l = local(ms, tz), h = hoursFor(store); return !h.closedDays.includes(l.dow) && l.hour >= h.open && l.hour < h.close; };

// Returns { stores, created, capped } (capped: stores that hit the per-tick cap). Never throws: a failure is logged and the next tick tries again.
export async function alertsTick(env, nowMs = Date.now()) {
  const stats = { stores: 0, created: 0, capped: 0 };
  try { await run(env, nowMs, stats); } catch (e) { stats.error = true; console.error('alerts tick failed:', e && e.message); }
  return stats;
}

async function run(env, nowMs, stats) {
  const T = env.TR, tz = tzOf(env), now = new Date(nowMs).toISOString(), l = local(nowMs, tz);
  const devs = (await T.prepare(DEVICES_SQL).all()).results;

  // Housekeeping once an hour (the tick at minute :00..:09): retention, reads that point at deleted alerts, state of removed phones.
  if (new Date(nowMs).getUTCMinutes() < 10) {
    await T.batch([
      T.prepare('DELETE FROM alerts WHERE created_at < ?').bind(new Date(nowMs - RETENTION_DAYS * 86400000).toISOString()),
      T.prepare('DELETE FROM alert_reads WHERE alert_id < COALESCE((SELECT MIN(id) FROM alerts), 9223372036854775807)'),
      T.prepare('DELETE FROM alert_device WHERE device_id NOT IN (SELECT id FROM agents)'),
      T.prepare('DELETE FROM alert_reads WHERE device_id NOT IN (SELECT device_id FROM alert_device)'),
    ]);
    // Remembered sales orders that got a work order or left Retrace's list (own statement: the table comes with a later migration).
    await T.prepare(`DELETE FROM alert_items WHERE type = 'unlinked' AND (EXISTS (SELECT 1 FROM inv_so_wo w WHERE w.store = alert_items.store AND w.sales_order = alert_items.item)
        OR NOT EXISTS (SELECT 1 FROM inv_so_need n WHERE n.store = alert_items.store AND n.sales_order = alert_items.item))`).run()
      .catch((e) => console.error('alerts: alert_items housekeeping failed:', e && e.message));
  }

  // The levels (distinct thresholds) each store needs, over its approved phones. A store with no approved phone is not touched.
  // Digests: one per distinct scope (all of a phone's stores + its stuck threshold), at each digest hour asked for.
  const plan = new Map(), digests = new Map();
  for (const d of devs) {
    const stores = parse(d.stores, []).map(Number), set = normalize(parse(d.settings, {}), stores), lv = levelsOf(set);
    for (const s of stores) {
      const p = plan.get(s) || Object.fromEntries(TYPES.map((k) => [k, new Set()]));
      for (const k of TYPES) p[k].add(lv[k]);
      plan.set(s, p);
    }
    const on = onStores(stores, set);
    if (!on.length || !set.types.digest.on) continue; // digests are worked out for phones that want one (the one rule whose facts cost reads)
    const key = scopeKey(on, set), g = digests.get(key) || { stores: [...on].sort((a, b) => a - b), stuck: set.types.stuck.days, hours: new Set() };
    g.hours.add(lv.digest);
    digests.set(key, g);
  }
  const budget = new Map();
  const left = (st) => (budget.has(st) ? budget.get(st) : CAP_PER_TICK);
  const ins = async (st, sql, binds) => {
    const r = await T.prepare(sql).bind(...binds).run(), n = (r.meta && r.meta.changes) || 0;
    budget.set(st, left(st) - n); stats.created += n;
  };
  const arr = (set) => JSON.stringify([...set].sort((a, b) => a - b));

  for (const [store, p] of plan) {
    stats.stores++;
    if (left(store) > 0) await ins(store, STUCK_SQL, [now, arr(p.stuck), store, left(store)]);
    if (l.hour >= PICKUP_HOUR && !hoursFor(store).closedDays.includes(l.dow)) await ins(store, PICKUP_SQL, [now, arr(p.pickup), store, l.day]);

    // Gone quiet: last scan (index scans_store) and any open quiet spell in one round trip.
    const [lastQ, openQ] = await T.batch([
      T.prepare('SELECT at FROM scans WHERE store = ? ORDER BY id DESC LIMIT 1').bind(store),
      T.prepare("SELECT subject FROM alerts WHERE store = ? AND type = 'quiet' AND cleared_at IS NULL").bind(store),
    ]);
    const last = lastQ.results[0] && lastQ.results[0].at, spells = openQ.results.map((r) => r.subject).sort();
    if (last) {
      if (spells.length && spells[0] < last) { // scans resumed: close the spell(s), one low-key 'back' entry
        const r = await T.batch([
          T.prepare("UPDATE alerts SET cleared_at = ? WHERE store = ? AND type = 'quiet' AND cleared_at IS NULL AND subject < ?").bind(now, store, last),
          T.prepare("INSERT OR IGNORE INTO alerts (store, type, subject, level, wo, created_at, data, backfill) VALUES (?, 'back', ?, 0, NULL, ?, ?, 0)")
            .bind(store, spells[0], now, JSON.stringify({ since: spells[0], resumedAt: last })),
        ]);
        stats.created += (r[1].meta && r[1].meta.changes) || 0;
      }
      const silentH = openMsBetween(store, Date.parse(last), nowMs, tz) / 3600000;
      if (left(store) > 0 && isOpenAt(store, nowMs, tz) && silentH > Math.min(...p.quiet)) {
        const lv = [...p.quiet].filter((v) => silentH > v); // every level this silence has passed; once per spell (unique subject = the last scan's time)
        await ins(store, QUIET_SQL, [now, JSON.stringify(lv), store, last]);
      }
    }
  }

  // Follow-up due (Waymark's database, one read for every store): today's Auto-Waymark marks, from each level's hour on.
  const fu = [...plan].filter(([, p]) => Math.min(...p.followup) <= l.hour).map(([s]) => s);
  if (fu.length && env.AE) {
    let marks = [];
    try {
      marks = (await env.AE.prepare(`SELECT m.store, m.wo, m.due, m.kind FROM auto_marks m WHERE m.store IN (SELECT value FROM json_each(?1)) AND m.due = ?2 AND m.removed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM wo_closed c WHERE c.store = m.store AND c.wo = m.wo) ORDER BY m.wo`).bind(JSON.stringify(fu), l.day).all()).results;
    } catch (e) { console.error('alerts: follow-up read failed:', e && e.message); }
    const by = new Map();
    for (const m of marks) { if (!by.has(m.store)) by.set(m.store, []); by.get(m.store).push({ wo: m.wo, due: m.due, kind: m.kind || null }); }
    for (const [store, list] of by) {
      const lv = [...plan.get(store).followup].filter((hh) => hh <= l.hour);
      if (left(store) > 0 && lv.length) await ins(store, FOLLOWUP_SQL, [now, JSON.stringify(list), store, JSON.stringify(lv), left(store)]);
    }
  }

  const stores = JSON.stringify([...plan.keys()]);
  // Unlinked sales orders (Retrace): one read for every store; per store and level one alert listing the new ones, written in one batch.
  if (plan.size) {
    try {
      const lv = Object.fromEntries([...plan].map(([s, p]) => ['s' + s, [...p.unlinked]]));
      const found = (await T.prepare(UNLINKED_SQL).bind(now, stores, JSON.stringify(lv)).all()).results;
      const groups = new Map();
      for (const r of found) { const k = r.store + '|' + r.level; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
      const stmts = [], made = [];
      for (const list of groups.values()) {
        const { store, level } = list[0];
        if (left(store) <= 0) continue;
        const some = list.slice(0, UNLINKED_LIST), sos = some.map((r) => r.sales_order), ages = some.map((r) => (nowMs - Date.parse(r.since)) / 1000);
        const late = ages.every((a) => a - level * 3600 > BACKFILL_SECONDS) ? 1 : 0;
        const data = JSON.stringify({ count: sos.length, hours: level, oldestHours: Math.floor(Math.max(...ages) / 3600), salesOrders: sos });
        stmts.push(T.prepare(UNLINKED_INS).bind(store, sos[0], level, now, data, late), T.prepare(UNLINKED_ITEMS).bind(store, sos[0], level, JSON.stringify(sos)));
        made.push(store); budget.set(store, left(store) - 1);
      }
      if (stmts.length) {
        const res = await T.batch(stmts);
        made.forEach((st, i) => { const n = (res[i * 2].meta && res[i * 2].meta.changes) || 0; stats.created += n; if (!n) budget.set(st, left(st) + 1); });
      }
    } catch (e) { console.error('alerts: unlinked rule failed:', e && e.message); }

    // Coverage check results with failures: one statement for every store.
    try {
      const got = (await T.prepare(COVERAGE_SQL).bind(now, stores, new Date(nowMs - RETENTION_DAYS * 86400000).toISOString()).all()).results;
      for (const r of got) { budget.set(r.store, left(r.store) - 1); stats.created++; }
    } catch (e) { console.error('alerts: coverage rule failed:', e && e.message); }
  }

  // The morning digest: one per scope and digest hour per day, from that hour on. One look-up for every scope; the facts are worked out
  // only for a scope that still needs today's digest (so once a day).
  const due = [...digests].filter(([, g]) => Math.min(...g.hours) <= l.hour);
  if (due.length) {
    try {
      const subj = (key) => key + '@' + l.day;
      const have = new Set((await T.prepare(DIGEST_HAVE_SQL).bind(JSON.stringify([...new Set(due.map(([, g]) => g.stores[0]))]), JSON.stringify(due.map(([k]) => subj(k)))).all())
        .results.map((r) => r.subject + '#' + r.level));
      for (const [key, g] of due) {
        const want = [...g.hours].filter((hh) => hh <= l.hour && !have.has(subj(key) + '#' + hh)).sort((a, b) => a - b);
        if (!want.length) continue;
        const data = JSON.stringify(await digestFacts(env, g, nowMs, now, l));
        const mins = new Date(nowMs).getUTCMinutes(), stmts = want.map((hh) => T.prepare(DIGEST_INS).bind(g.stores[0], subj(key), hh, now, data, (l.hour - hh) * 60 + mins > BACKFILL_SECONDS / 60 ? 1 : 0));
        const res = await T.batch(stmts);
        for (const x of res) stats.created += (x.meta && x.meta.changes) || 0;
      }
    } catch (e) { console.error('alerts: digest failed:', e && e.message); }
  }
  for (const [, b] of budget) if (b <= 0) stats.capped++;
}

// The digest's facts for a scope (g.stores, g.stuck). Home's own numbers (buildHome: sales, sales per labor hour by the Metrics rule, the
// target band, the RFP total) for "yesterday" and now; the store day's follow-ups (Waymark's database) and stuck work orders at the phone's
// threshold. Numbers only: work order numbers, status names, days, money.
async function digestFacts(env, g, nowMs, now, l) {
  const T = env.TR, yesterday = addDays(l.day, -1), S = JSON.stringify(g.stores);
  const home = await buildHome(env, g.stores, new Map(), nowMs);
  let marks = [];
  if (env.AE) {
    try {
      marks = (await env.AE.prepare(`SELECT m.store, m.wo FROM auto_marks m WHERE m.store IN (SELECT value FROM json_each(?1)) AND m.due = ?2 AND m.removed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM wo_closed c WHERE c.store = m.store AND c.wo = m.wo) ORDER BY m.store, m.wo`).bind(S, l.day).all()).results;
    } catch (e) { console.error('alerts: digest follow-up read failed:', e && e.message); }
  }
  const fuList = marks.slice(0, DIGEST_LIST);
  const [stuck, labor, fuSt] = await T.batch([
    T.prepare(DIGEST_STUCK_SQL).bind(now, S, g.stuck),
    T.prepare(DIGEST_LABOR_SQL).bind(S, yesterday),
    T.prepare(DIGEST_STATUS_SQL).bind(JSON.stringify(fuList.map((m) => [m.store, m.wo]))),
  ]);
  const st = new Map(fuSt.results.map((r) => [r.store + '|' + r.wo, r.status]));
  const lab = labor.results[0] || {}, i = home.days.indexOf(yesterday);
  const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
  return {
    day: l.day, yesterday, stores: g.stores,
    sales: i < 0 ? null : r2(home.sales.week[i]), splh: i < 0 ? null : home.splh.week[i], hours: lab.n ? r2(lab.h) : null, target: home.splh.target || SPLH_TARGET,
    rfp: { total: home.rfp.total, count: home.rfp.count, oldestDays: home.rfp.oldestDays },
    followups: { count: marks.length, wos: fuList.map((m) => ({ store: m.store, wo: m.wo, status: st.get(m.store + '|' + m.wo) || null })) },
    stuck: { days: g.stuck, count: stuck.results.length ? stuck.results[0].n : 0, wos: stuck.results.map((r) => ({ store: r.store, wo: r.wo, status: r.status, days: r.days })) },
  };
}

// ---------------------------------------------------------------- routes
// Entry as the app gets it: id, store, type, wo, at + the facts of its type (stuck: statusId, status, days, since | pickup: count, days, oldestDays |
// followup: due, kind | quiet: since, hours | back: since, resumedAt | digest: day, yesterday, stores, sales, splh, hours, target, rfp, followups, stuck |
// unlinked: count, hours, oldestHours, salesOrders | coverage: checkedAt, countMisses, countItems, missedItems, qtyMisses, staleLabels).
function entry(row) {
  const o = { id: row.id, store: row.store, type: row.type, wo: row.wo == null ? null : row.wo, at: row.created_at };
  return Object.assign(o, parse(row.data, {}));
}

// The phone's state row (created on first use; a new phone starts with everything so far read).
async function state(T, device, h) {
  let r = await T.prepare('SELECT settings, read_upto FROM alert_device WHERE device_id = ?').bind(device.id).first();
  if (!r) {
    await T.prepare('INSERT OR IGNORE INTO alert_device (device_id, settings, read_upto, updated_at) VALUES (?, ?, COALESCE((SELECT MAX(id) FROM alerts), 0), ?)').bind(device.id, '{}', h.now()).run();
    r = await T.prepare('SELECT settings, read_upto FROM alert_device WHERE device_id = ?').bind(device.id).first();
  }
  return { settings: normalize(parse(r.settings, {}), device.stores), readUpto: r.read_upto };
}

// SQL shared by the feed, the poll and the unread count. Binds ?1 device id, ?2 stores JSON, ?3 read cursor, ?4..?9 the phone's levels,
// ?10 the phone's digest scope key ('' leaves digests out: a feed filtered to one store). Callers' own binds start at ?11.
const FEED_FROM = `FROM alerts a LEFT JOIN alert_reads r ON r.device_id = ?1 AND r.alert_id = a.id
  WHERE a.store IN (SELECT value FROM json_each(?2))
    AND a.level = CASE a.type WHEN 'stuck' THEN ?4 WHEN 'pickup' THEN ?5 WHEN 'followup' THEN ?6 WHEN 'quiet' THEN ?7 WHEN 'digest' THEN ?8 WHEN 'unlinked' THEN ?9 ELSE 0 END
    AND (a.type != 'digest' OR substr(a.subject, 1, length(?10) + 1) = ?10 || '@')`;
const feedBinds = (stores, id, st, scope) => {
  const lv = levelsOf(st.settings), on = onStores(stores, st.settings);
  return [id, JSON.stringify(stores), st.readUpto, lv.stuck, lv.pickup, lv.followup, lv.quiet, lv.digest, lv.unlinked, scope !== undefined ? scope : on.length ? scopeKey(on, st.settings) : ''];
};

const switches = (st) => ({
  type: (t) => (t === 'back' ? st.settings.types.quiet.on : st.settings.types[t] ? st.settings.types[t].on : true),
  store: (s) => st.settings.stores[s] !== false,
  row: (r) => r.type === 'digest' || st.settings.stores[r.store] !== false, // the digest's scope is already only the switched-on stores
});
const unreadOf = async (T, device, st) => {
  const sw = switches(st), offT = TYPES.concat('back').filter((t) => !sw.type(t)), offS = device.stores.filter((s) => !sw.store(s));
  return (await T.prepare(`SELECT COUNT(*) AS n ${FEED_FROM} AND a.id > ?3 AND r.alert_id IS NULL
      AND a.type NOT IN (SELECT value FROM json_each(?11)) AND (a.type = 'digest' OR a.store NOT IN (SELECT value FROM json_each(?12)))`).bind(...feedBinds(device.stores, device.id, st), JSON.stringify(offT), JSON.stringify(offS)).first()).n;
};

async function listApi(req, env, url, device, h) {
  const T = env.TR, st = await state(T, device, h), sw = switches(st), q = url.searchParams;
  let stores = device.stores;
  if (q.get('store') != null && q.get('store') !== 'all') {
    if (!/^\d{1,6}$/.test(q.get('store'))) return h.fail(400, 'store: all or a store number');
    if (!device.stores.includes(Number(q.get('store')))) return h.fail(403, 'not your store');
    stores = [Number(q.get('store'))];
  }
  const lim = Math.min(Math.max(h.int(q.get('limit')) || 25, 1), 100);
  const opt = (k) => { const v = q.get(k); if (v == null || v === '') return null; if (!/^\d{1,12}$/.test(v)) throw Object.assign(new Error(`${k}: a cursor number from an earlier answer`), { status: 400 }); return Number(v); };
  const after = opt('after'), before = opt('before');
  const rows = (await T.prepare(`SELECT a.id, a.store, a.type, a.wo, a.created_at, a.data, a.backfill, a.cleared_at, (a.id <= ?3 OR r.alert_id IS NOT NULL) AS read ${FEED_FROM}
      AND a.id > ?11 AND a.id < ?12 ORDER BY a.id DESC LIMIT ?13`).bind(...feedBinds(stores, device.id, st, stores.length === device.stores.length ? undefined : ''), after == null ? 0 : after, before == null ? 9007199254740991 : before, lim + 1).all()).results;
  const more = rows.length > lim;
  if (more) rows.pop();
  const unread = await unreadOf(T, device, st);
  const top = (await T.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM alerts').first()).m;
  const alerts = rows.map((row) => {
    const e = entry(row), read = !!row.read;
    e.read = read;
    e.notify = !read && !row.backfill && row.type !== 'back' && sw.type(row.type) && sw.row(row);
    if (row.type === 'quiet') e.cleared = row.cleared_at || null;
    return e;
  });
  return h.json({ v: 1, now: h.now(), cursor: top, unread, more, next: more ? rows[rows.length - 1].id : null, alerts });
}

// In quiet hours (store local time) a poll holds everything back and leaves the cursor where it is: the entries come out when quiet hours end,
// as long as they are less than MAX_AGE_MS old (older ones stay in the feed only).
async function newApi(req, env, url, device, h) {
  const T = env.TR, tz = tzOf(env), nowMs = Date.parse(h.now()), st = await state(T, device, h), sw = switches(st);
  const raw = url.searchParams.get('since');
  if (raw == null || raw === '') return h.json({ v: 1, cursor: (await T.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM alerts').first()).m, alerts: [] }); // first run: "from now on"
  if (!/^\d{1,12}$/.test(raw)) return h.fail(400, 'since: a cursor from an earlier answer');
  const since = Number(raw), qh = st.settings.quietHours;
  if (qh.on) {
    const m = minuteOfDay(nowMs, tz), a = hm(qh.from), b = hm(qh.to);
    if (a < b ? m >= a && m < b : m >= a || m < b) return h.json({ v: 1, cursor: since, alerts: [], held: true });
  }
  const rows = (await T.prepare(`SELECT a.id, a.store, a.type, a.wo, a.created_at, a.data, a.backfill ${FEED_FROM} AND a.id > ?11 AND a.id > ?3 AND r.alert_id IS NULL ORDER BY a.id LIMIT ?12`)
    .bind(...feedBinds(device.stores, device.id, st), since, MAX_NEW).all()).results;
  const out = rows.filter((r) => !r.backfill && r.type !== 'back' && sw.type(r.type) && sw.row(r) && nowMs - Date.parse(r.created_at) <= MAX_AGE_MS).map(entry);
  const body = { v: 1, cursor: rows.length ? rows[rows.length - 1].id : since, alerts: out };
  if (rows.length === MAX_NEW) body.more = true; // poll again right away
  return h.json(body);
}

async function readApi(req, env, url, device, h) {
  const T = env.TR, st = await state(T, device, h), b = await h.readJson(req, 4000);
  if (!b || typeof b !== 'object' || Array.isArray(b)) return h.fail(400, 'body must be { "ids": [...] } or { "all": true }');
  if (b.all === true) {
    if (b.store === undefined) {
      await T.batch([
        T.prepare('UPDATE alert_device SET read_upto = MAX(read_upto, COALESCE((SELECT MAX(id) FROM alerts), 0)), updated_at = ?2 WHERE device_id = ?1').bind(device.id, h.now()),
        T.prepare('DELETE FROM alert_reads WHERE device_id = ?1 AND alert_id <= (SELECT read_upto FROM alert_device WHERE device_id = ?1)').bind(device.id),
      ]);
    } else {
      if (!isInt(b.store) || b.store < 0) return h.fail(400, 'store: a store number');
      if (!device.stores.includes(b.store)) return h.fail(403, 'not your store');
      await T.prepare('INSERT OR IGNORE INTO alert_reads (device_id, alert_id) SELECT ?1, a.id FROM alerts a WHERE a.store = ?2 AND a.id > ?3').bind(device.id, b.store, st.readUpto).run();
    }
  } else if (Array.isArray(b.ids)) {
    if (!b.ids.length || b.ids.length > MAX_IDS || !b.ids.every((x) => isInt(x) && x > 0)) return h.fail(400, `ids: 1 to ${MAX_IDS} alert ids`);
    await T.prepare('INSERT OR IGNORE INTO alert_reads (device_id, alert_id) SELECT ?1, a.id FROM alerts a WHERE a.id IN (SELECT value FROM json_each(?2)) AND a.store IN (SELECT value FROM json_each(?3)) AND a.id > ?4')
      .bind(device.id, JSON.stringify(b.ids), JSON.stringify(device.stores), st.readUpto).run();
  } else return h.fail(400, 'body must be { "ids": [...] } or { "all": true }');
  return h.json({ ok: true, unread: await unreadOf(T, device, await state(T, device, h)) });
}

async function settingsApi(req, env, url, device, h) {
  const T = env.TR, st = await state(T, device, h);
  if (req.method === 'PUT') {
    const merged = mergeSettings(st.settings, await h.readJson(req, 2000), device.stores);
    await T.prepare('UPDATE alert_device SET settings = ?, updated_at = ? WHERE device_id = ?').bind(JSON.stringify(merged), h.now(), device.id).run();
    st.settings = normalize(merged, device.stores);
  }
  return h.json({ v: 1, settings: st.settings, stores: device.stores, ranges: RANGES, defaults: DEFAULTS });
}

export async function alertsApi(req, env, url, device, h) {
  const path = url.pathname.replace(/^\/v1\/agents\/m/, '').replace(/\/+$/, '');
  if (/^\/push(\/|$)/.test(path)) return h.fail(404, 'no push service: poll GET /v1/agents/m/alerts/new');
  const only = (method) => (req.method === method ? null : h.fail(405, 'method not allowed'));
  if (path === '/alerts') return only('GET') || listApi(req, env, url, device, h);
  if (path === '/alerts/new') return only('GET') || newApi(req, env, url, device, h);
  if (path === '/alerts/read') return only('POST') || readApi(req, env, url, device, h);
  if (path === '/alerts/settings') return req.method === 'GET' || req.method === 'PUT' ? settingsApi(req, env, url, device, h) : h.fail(405, 'method not allowed');
  return h.fail(404, 'not found');
}
