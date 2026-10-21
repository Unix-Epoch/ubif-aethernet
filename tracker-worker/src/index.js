/*
  Aethernet work order tracker: a server-side copy of every store's work orders,
  collected by Aethernet in store browsers (no server-side Portal login).
  Database "aethernet-tracker" (binding TR); store access comes from the Waymark
  database (binding AE, table store_access), same as every other Aethernet call.

  Customer data never arrives readable: Aethernet seals it with the store's public key
  (src/crypto.js) and only people holding a key copy can open it, in their own browser.

  Store side (x-aethernet-key = the app key that ships in Aethernet; store must have access):
    GET  /v1/tracker/master                      master public key → { publicJwk } (404 before setup)
    GET  /v1/:store/tracker/key                  the store's public key → { publicJwk } (404: none yet)
    POST /v1/:store/tracker/key  { publicJwk, wrappedPrivate }    first install to ask creates it;
                                                 the private half arrives sealed to the master key.
                                                 Answers with the key actually stored.
    POST /v1/:store/tracker/scan { rows, storeName, by }          Portal's open-WO list →
                                                 { need: [{ wo, why }] } WOs to fetch in full
                                                 (new / changed / stale / missing), claimed for
                                                 5 minutes so other browsers skip them.
    POST /v1/:store/tracker/wo/:wo { hash, trigger, plain, sealed, card, by }   one WO's detail
    POST /v1/:store/tracker/wo/:wo/gone { by }   Portal answers 404 for it: recorded closed after a second 404.
    GET  /v1/:store/tracker/rfp                  the store's RFP total (count, value, complete/incomplete split, last scan)
    POST /v1/:store/tracker/daily { day, metrics, source, by }   plain daily numbers for the Metrics page (src/daily.js)
    POST /v1/:store/tracker/sales { day, rows }  Portal's sales history for one business day (see the route)
    GET  /v1/:store/tracker/sales/days?from&to   daily sales totals (Tactician)
    GET  /v1/:store/tracker/rfp/days?from&to     the RFP total at the end of each day (Tactician)
    GET  /v1/:store/tracker/settings             store settings (general managers, …); PUT …/settings/gm
    GET  /v1/:store/assize/rules?v=              the Assize rule graphs published for the store (src/assize.js)

  Agents (programs with their own key, e.g. the Mac's work order audit; x-aethernet-key too):
    POST /v1/agents/register { id, name, publicJwk, token }   → { id, fingerprint, status } (waits for approval)
    then `authorization: Bearer <id>.<token>`:
    GET  /v1/agents/me                           → { id, name, status, stores, fingerprint, keys: [{ store, publicJwk, wrapped }] }
    POST /v1/agents/report { ranAt, ok, emailSent, note, usedRunNow }   after each audit run; usedRunNow clears "run now"
    (/me also returns { settings, runNow, lastRun })
    GET  /v1/agents/wos?store=&closedDays=       open WOs + ones closed within closedDays (max 14), latest sealed snapshot

  `plain` (readable on the server; never customer details):
    { workorder: { workorderId, storeId, statusId, status, programId, program, device,
                   createdAt, updatedAt, nextUpdate, slaEndTime, bin, ... },
      auditTrail: [{ statusId, createdAt, createdBy }], cart: { items: [...], payment: {...} } }

  Admin side: trackerAdmin(), mounted by the admin site (admin-worker/) at /api/tracker/…,
  behind Cloudflare Access; `email` is the signed-in Access user. See the routes below.

  Retention (daily cron): snapshots and changes older than KEEP_DAYS (183) are archived to R2
  (binding ARCHIVE) as gzipped JSON lines per store and month, then deleted. A WO's latest
  snapshot is always kept. Without ARCHIVE nothing is trimmed (nothing is lost before cold
  storage is set up) unless TRIM_WITHOUT_ARCHIVE is set.
*/
import { daily } from './daily.js';

import { PAGES, WIDE_PAGES, owners, cleanPages, presetOf, accessOf, check, stripSealed } from './access.js';
import { metricsApi, statusPeriodStmts, closeStatusPeriod } from './metrics.js';
import { assizeStore, assizeAdmin } from './assize.js';

const KEEP_DAYS = 183, LOG_DAYS = 400, GONE_MIN = 10;
const STALE_MIN = 60, CLAIM_MIN = 5, NEED_MAX = 25, STALE_MAX = 10;
const CLOSED_IDS = new Set([14, 15, 25]); // Sale complete, Closed, Cancelled
const MAX = { scan: 400000, wo: 2000000, plain: 400000, sealed: 1800000, card: 8000 };

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
  'access-control-allow-headers': 'content-type, x-aethernet-key',
  'access-control-max-age': '86400',
};
const json = (body, status = 200, cors = true) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...(cors ? CORS : {}) } });
const fail = (status, error, cors = true) => json({ error }, status, cors);
const now = () => new Date().toISOString();
const later = (min) => new Date(Date.now() + min * 60000).toISOString();
const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const int = (v) => (Number.isInteger(v) ? v : (typeof v === 'string' && /^\d{1,12}$/.test(v) ? Number(v) : null));
const iso = (v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+(Z|[+-]\d\d:?\d\d)?$/.test(v) ? v.slice(0, 40) : null);
const num = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : null);

const B64U = /^[A-Za-z0-9_-]+$/;
const isJwk = (k) => k && k.kty === 'EC' && k.crv === 'P-256' && typeof k.x === 'string' && typeof k.y === 'string' && k.x.length === 43 && k.y.length === 43 && B64U.test(k.x) && B64U.test(k.y) && !('d' in k);
const pubJwk = (k) => ({ kty: 'EC', crv: 'P-256', x: k.x, y: k.y });
const isSealed = (s, max) => typeof s === 'string' && s.length <= max && s.length > 100 && s.startsWith('v1.') && B64U.test(s.slice(3));
const isCopy = (c) => c && typeof c.salt === 'string' && B64U.test(c.salt) && c.salt.length <= 32 && Number.isInteger(c.rounds) && c.rounds >= 100000 && c.rounds <= 5000000
  && typeof c.wrapped === 'string' && c.wrapped.startsWith('p1.') && c.wrapped.length <= 1000 && B64U.test(c.wrapped.slice(3));
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

async function readJson(req, max) {
  const text = await req.text();
  if (text.length > max) throw Object.assign(new Error('too large'), { status: 413 });
  try { return text ? JSON.parse(text) : {}; } catch (_) { throw Object.assign(new Error('bad JSON'), { status: 400 }); }
}

// ------------------------------------------------------------------ store access (Waymark's list)
const accessCache = new Map();
async function allowed(env, store) {
  const hit = accessCache.get(store);
  if (hit && Date.now() - hit.at < 60000) return hit.ok;
  const ok = !!(await env.AE.prepare('SELECT 1 FROM store_access WHERE store = ?').bind(store).first());
  accessCache.set(store, { ok, at: Date.now() });
  return ok;
}

/*
  What a WO is worth: its cart lines before tax (netPrice × quantity), with Partner Credit Tax Exempt (sku PCEXEMPT) ignored.
  Those lines cancel each part and labor line on partner jobs (Asurion etc.), which is why their cart
  totals are $0; without them a partner repair counts at its real value. Same rule as VALUE_SQL below.
*/
export function cartValue(plain) {
  const items = (plain && plain.cart && plain.cart.items) || [];
  if (!plain || !plain.cart) return null;
  let v = 0;
  for (const i of items) {
    if (String(i.sku || '').toUpperCase() === 'PCEXEMPT') continue;
    // netPrice: before tax, after discounts (totalPrice includes tax). The sign is on the price, so quantity counts as a size.
    const t = (typeof i.netPrice === 'number' ? i.netPrice : Number(i.price) || 0) * Math.abs(Number(i.quantity) || 1);
    if (isFinite(t)) v += t;
  }
  return Math.round(v * 100) / 100;
}
const VALUE_SQL = `(SELECT ROUND(SUM(COALESCE(json_extract(value, '$.netPrice'), json_extract(value, '$.price'), 0) * ABS(COALESCE(json_extract(value, '$.quantity'), 1))), 2)
  FROM json_each(json_extract(plain, '$.cart.items')) WHERE UPPER(COALESCE(json_extract(value, '$.sku'), '')) != 'PCEXEMPT')`;

// The store's business day for a UTC time (all stores are on Eastern time for now; env.STORE_TZ overrides).
export function localDay(iso, tz = 'America/New_York') {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); // YYYY-MM-DD
}
// When a WO reached Sale complete (status 14). Portal's status history stops before it, but the WO's own
// updatedAt on its Sale complete version is the sale; the history is a fallback.
const soldAtOf = (plain) => {
  const w = (plain && plain.workorder) || {};
  if (Number(w.statusId) === 14 && w.updatedAt) return w.updatedAt;
  return ((plain && plain.auditTrail) || []).filter((a) => Number(a.statusId) === 14 && a.createdAt).map((a) => a.createdAt).sort().pop() || null;
};
const DAY_RE = /^\d{4}-\d\d-\d\d$/;

/*
  Daily sales per store and day: Portal's (source portal|mac) where the day was synced, else an estimate
  from WOs that reached Sale complete that day (last cart value before tax + its tax). Shared by the
  admin site and the store side (Tactician's sales per labor hour). visible(store) filters.
*/
async function salesDays(env, visible, from, to) {
  const T = env.TR, tz = env.STORE_TZ || 'America/New_York';
  const pad = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const [days, sales, sold] = await T.batch([
    T.prepare('SELECT * FROM sales_days WHERE day BETWEEN ? AND ?').bind(from, to),
    T.prepare('SELECT store, sale_id, wo, sale_day, sale_at, type, total, partner_credits, paid, completed_by, program, device, items, card, source FROM sales WHERE sale_day BETWEEN ? AND ? ORDER BY sale_at').bind(from, to),
    T.prepare(`SELECT store, wo, store_name, program_name, device, last_cart_value, last_cart_tax, COALESCE(sold_at, closed_at) AS sold_at, card FROM workorders
        WHERE status_id = 14 AND COALESCE(sold_at, closed_at) BETWEEN ? AND ?`).bind(pad(from, -1), pad(to, 2)),
  ]);
  const have = new Map(days.results.filter((d) => visible(d.store)).map((d) => [d.store + '|' + d.day, d]));
  const est = new Map();
  for (const w of sold.results) {
    if (!visible(w.store)) continue;
    const day = localDay(w.sold_at, tz);
    if (!day || day < from || day > to || have.has(w.store + '|' + day)) continue;
    const k = w.store + '|' + day;
    (est.get(k) || est.set(k, []).get(k)).push(Object.assign(w, { day, estimate: Math.round(((w.last_cart_value || 0) + (w.last_cart_tax || 0)) * 100) / 100 }));
  }
  const out = [];
  for (const d of have.values()) {
    const list = sales.results.filter((x) => x.store === d.store && x.sale_day === d.day);
    const sum = (f) => Math.round(list.reduce((n, x) => n + (x.type === 'Return' ? -Math.abs(x[f] || 0) : (x[f] || 0)), 0) * 100) / 100;
    out.push({ store: d.store, day: d.day, source: d.source, count: list.length, total: sum('total'), partnerCredits: sum('partner_credits'), paid: sum('paid') });
  }
  for (const [k, v] of est) {
    const [st, day] = k.split('|');
    out.push({ store: Number(st), day, source: 'estimated', count: v.length, total: Math.round(v.reduce((n, w) => n + w.estimate, 0) * 100) / 100, partnerCredits: null, paid: null });
  }
  out.sort((a, b) => (a.day === b.day ? a.store - b.store : a.day < b.day ? 1 : -1));
  return { days: out, sales: sales.results.filter((x) => visible(x.store)), estimated: est };
}

/*
  RFP periods: when a WO reached Ready for pickup (status 13) and when it left, with its value while
  there. Kept from each changed snapshot: in RFP → open a period (start = Portal's rfpAt, else the WO's
  updatedAt, else now) or update its value; anything else → close the open one (end = updatedAt / now).
*/
const closeRfpPeriod = (T, store, wo, at) => T.prepare('UPDATE rfp_periods SET end_at = ? WHERE store = ? AND wo = ? AND end_at IS NULL').bind(at, store, wo);
async function rfpPeriodStmts(T, store, wo, plain, at) {
  const w = (plain && plain.workorder) || {}, inRfp = Number(w.statusId) === 13;
  const open = await T.prepare('SELECT start_at FROM rfp_periods WHERE store = ? AND wo = ? AND end_at IS NULL').bind(store, wo).first();
  if (inRfp) {
    const value = cartValue(plain);
    if (open) return value == null ? [] : [T.prepare('UPDATE rfp_periods SET value = ? WHERE store = ? AND wo = ? AND start_at = ?').bind(value, store, wo, open.start_at)];
    const start = iso(w.rfpAt) || iso(w.updatedAt) || at;
    return [T.prepare('INSERT INTO rfp_periods (store, wo, start_at, value) VALUES (?, ?, ?, ?) ON CONFLICT (store, wo, start_at) DO UPDATE SET end_at = NULL, value = COALESCE(excluded.value, value)').bind(store, wo, start, value)];
  }
  if (open) return [T.prepare('UPDATE rfp_periods SET end_at = ? WHERE store = ? AND wo = ? AND start_at = ?').bind(iso(w.updatedAt) && iso(w.updatedAt) > open.start_at ? iso(w.updatedAt) : at, store, wo, open.start_at)];
  return [];
}
// UTC instant of a local day's end (23:59:59.999 in tz).
function dayEnd(day, tz) {
  const guess = Date.parse(day + 'T23:59:59.999Z');
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(guess));
  const g = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const asLocal = Date.parse(g.year + '-' + g.month + '-' + g.day + 'T' + g.hour + ':' + g.minute + ':' + g.second + '.999Z');
  return new Date(guess + (guess - asLocal)).toISOString();
}
// The RFP total at the end of each day in [from, to] (today: now). [{ day, count, value }]
async function rfpDays(env, store, from, to) {
  const tz = env.STORE_TZ || 'America/New_York', today = localDay(new Date().toISOString(), tz);
  const r = await env.TR.prepare('SELECT wo, start_at, end_at, value FROM rfp_periods WHERE store = ? AND start_at <= ? AND (end_at IS NULL OR end_at >= ?)')
    .bind(store, dayEnd(to, tz), from + 'T00:00:00Z').all();
  const out = [];
  for (let d = new Date(from + 'T12:00:00Z'); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10), at = day === today ? new Date().toISOString() : dayEnd(day, tz);
    const on = r.results.filter((p) => p.start_at <= at && (!p.end_at || p.end_at > at));
    out.push({ day, count: on.length, value: Math.round(on.reduce((n, p) => n + (p.value || 0), 0) * 100) / 100 });
  }
  return out;
}

// ------------------------------------------------------------------ plain-part diff
function flatten(v, path, out) {
  if (v && typeof v === 'object') {
    const keys = Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v);
    if (!keys.length) out[path] = JSON.stringify(v);
    for (const k of keys) flatten(v[k], path ? path + '.' + k : String(k), out);
  } else out[path] = v === undefined ? null : JSON.stringify(v);
  return out;
}
async function hashText(t) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)));
  return [...d.slice(0, 12)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function diff(before, after) {
  const a = before ? flatten(before, '', {}) : {}, b = flatten(after, '', {});
  const out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) out.push([k, a[k] ?? null, b[k] ?? null]);
  return out;
}

// ------------------------------------------------------------------ agents (programs with their own key)
const HEX32 = /^[0-9a-f]{32}$/, HEX64 = /^[0-9a-f]{64}$/;
const sha256hex = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map((x) => x.toString(16).padStart(2, '0')).join('');
// 16 hex chars of sha256({crv,kty,x,y}) in groups of 4, e.g. 3F2A-91C0-7B44-0DDE (shown on the program and the admin site)
const fingerprint = async (k) => (await sha256hex(JSON.stringify({ crv: k.crv, kty: k.kty, x: k.x, y: k.y }))).slice(0, 16).toUpperCase().match(/.{4}/g).join('-');

// Audit settings (set on the admin site, read by the program). Strict on write, defaults filled on read.
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/, AGENT_DEFAULTS = { paused: false, days: [1, 2, 3, 5, 6], times: ['10:00', '18:00'], emailTo: ['green.trimar@gmail.com'], closedDays: 3, staleMinutes: 45, openHours: { from: '10:00', to: '19:00' } };
const isList = (v, min, max) => Array.isArray(v) && v.length >= min && v.length <= max;
export function agentSettings(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const o = {}, has = (k) => b[k] !== undefined;
  for (const k of Object.keys(b)) if (!(k in AGENT_DEFAULTS)) return null;
  if (has('paused')) { if (typeof b.paused !== 'boolean') return null; o.paused = b.paused; }
  if (has('days')) { if (!isList(b.days, 0, 7) || b.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return null; o.days = [...new Set(b.days)].sort(); }
  if (has('times')) { if (!isList(b.times, 1, 6) || b.times.some((t) => !HHMM.test(t) || !['00', '30'].includes(t.slice(3)))) return null; o.times = [...new Set(b.times)].sort(); }
  if (has('emailTo')) { if (!isList(b.emailTo, 1, 3) || b.emailTo.some((e) => typeof e !== 'string' || !EMAIL_RE.test(e) || e.length > 254)) return null; o.emailTo = [...new Set(b.emailTo.map((e) => e.toLowerCase()))]; }
  if (has('closedDays')) { if (!Number.isInteger(b.closedDays) || b.closedDays < 1 || b.closedDays > 14) return null; o.closedDays = b.closedDays; }
  if (has('staleMinutes')) { if (!Number.isInteger(b.staleMinutes) || b.staleMinutes < 15 || b.staleMinutes > 240) return null; o.staleMinutes = b.staleMinutes; }
  if (has('openHours')) { const h = b.openHours; if (!h || !HHMM.test(h.from) || !HHMM.test(h.to) || h.from >= h.to) return null; o.openHours = { from: h.from, to: h.to }; }
  return o;
}
const withDefaults = (text) => { let s = {}; try { s = JSON.parse(text || '{}'); } catch (_) {} return Object.assign({}, AGENT_DEFAULTS, s); };
const parseRun = (t) => { try { return t ? JSON.parse(t) : null; } catch (_) { return null; } };

async function agentApi(req, env, url) {
  const T = env.TR, path = url.pathname.replace(/^\/v1\/agents/, '');
  if (path === '/register' && req.method === 'POST') {
    const b = await readJson(req, 4000), name = clean(b.name, 60);
    if (!HEX32.test(b.id) || !name || !isJwk(b.publicJwk) || !HEX64.test(b.token)) return fail(400, 'id, name, publicJwk and token required');
    await T.prepare("DELETE FROM agents WHERE status = 'pending' AND created_at < ?").bind(new Date(Date.now() - 7 * 86400000).toISOString()).run();
    if (await T.prepare('SELECT 1 FROM agents WHERE id = ?').bind(b.id).first()) return fail(409, 'already registered');
    if ((await T.prepare("SELECT COUNT(*) AS n FROM agents WHERE status = 'pending'").first()).n >= 5) return fail(429, 'too many programs waiting for approval');
    const jwk = pubJwk(b.publicJwk);
    await T.prepare("INSERT INTO agents (id, name, public_jwk, token_hash, status, stores, created_at) VALUES (?, ?, ?, ?, 'pending', '[]', ?)")
      .bind(b.id, name, JSON.stringify(jwk), await sha256hex(b.token), now()).run();
    await log(env, 'agent:' + name, 'agent:register', null, null, b.id);
    return json({ id: b.id, fingerprint: await fingerprint(jwk), status: 'pending' });
  }
  const m = /^Bearer ([0-9a-f]{32})\.([0-9a-f]{64})$/.exec(req.headers.get('authorization') || '');
  const a = m && await T.prepare('SELECT * FROM agents WHERE id = ?').bind(m[1]).first();
  if (!a || (await sha256hex(m[2])) !== a.token_hash) return fail(401, 'unknown program or wrong token');
  await T.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').bind(now(), a.id).run();
  const stores = JSON.parse(a.stores || '[]'), jwk = JSON.parse(a.public_jwk), active = a.status === 'active';

  if (path === '/me' && req.method === 'GET') {
    const keys = active ? (await T.prepare('SELECT k.store, s.public_jwk, k.wrapped FROM agent_keys k JOIN store_keys s ON s.store = k.store WHERE k.agent_id = ? ORDER BY k.store').bind(a.id).all()).results
      .filter((k) => stores.includes(k.store)).map((k) => ({ store: k.store, publicJwk: JSON.parse(k.public_jwk), wrapped: k.wrapped })) : [];
    return json({ id: a.id, name: a.name, status: a.status, stores, fingerprint: await fingerprint(jwk), keys, settings: withDefaults(a.settings), runNow: !!a.run_now, lastRun: parseRun(a.last_run) });
  }
  if (path === '/report' && req.method === 'POST') {
    const b = await readJson(req, 4000), ranAt = iso(b.ranAt);
    if (!ranAt || typeof b.ok !== 'boolean' || typeof b.emailSent !== 'boolean') return fail(400, 'ranAt, ok and emailSent required');
    const run = { ranAt, ok: b.ok, emailSent: b.emailSent, note: clean(b.note, 300), usedRunNow: b.usedRunNow === true };
    await T.prepare('UPDATE agents SET last_run = ?, last_note = ?' + (run.usedRunNow ? ', run_now = 0' : '') + ' WHERE id = ?').bind(JSON.stringify(run), run.note || null, a.id).run();
    return json({ ok: true });
  }
  if (path === '/wos' && req.method === 'GET') {
    const store = int(url.searchParams.get('store'));
    if (!store || !active || !stores.includes(store)) return fail(403, 'not approved for this store');
    const days = Math.min(Math.max(int(url.searchParams.get('closedDays')) ?? 3, 0), 14), since = new Date(Date.now() - days * 86400000).toISOString();
    const [rows, scan] = await T.batch([
      T.prepare(`SELECT w.wo, w.store_name, w.status_id, w.status_name, w.program_id, w.program_name, w.device, w.created_at, w.api_updated_at, w.is_open, w.first_seen_at, w.last_list_seen_at,
          w.missing_since, w.last_detail_at, w.closed_at, w.closed_reason, w.service_outcome, w.plain, s.id AS snapshot_id, s.fetched_at AS snapshot_fetched_at, s.hash AS snapshot_hash, s.sealed
        FROM workorders w LEFT JOIN snapshots s ON s.id = (SELECT MAX(id) FROM snapshots WHERE store = w.store AND wo = w.wo)
        WHERE w.store = ? AND (w.is_open = 1 OR COALESCE(w.closed_at, w.api_updated_at, w.last_detail_at, '') >= ?) ORDER BY w.wo`).bind(store, since),
      T.prepare('SELECT MAX(at) AS at FROM scans WHERE store = ?').bind(store),
    ]);
    await log(env, 'agent:' + a.name, 'agent:wos', store, null, rows.results.length + ' rows');
    return json({ wos: rows.results, last_scan_at: scan.results[0].at || null });
  }
  return fail(404, 'not found');
}

// ------------------------------------------------------------------ store side
async function storeApi(req, env, url, store) {
  const path = url.pathname.replace(/^\/v1\/\d+\/tracker/, '');
  const T = env.TR;

  if (path === '/key' && req.method === 'GET') {
    const r = await T.prepare('SELECT public_jwk FROM store_keys WHERE store = ?').bind(store).first();
    return r ? json({ publicJwk: JSON.parse(r.public_jwk) }) : fail(404, 'no store key yet');
  }
  if (path === '/key' && req.method === 'POST') {
    const b = await readJson(req, 4000);
    if (!isJwk(b.publicJwk) || !isSealed(b.wrappedPrivate, 1000)) return fail(400, 'bad key');
    if (!(await T.prepare('SELECT 1 FROM master_key WHERE id = 1').first())) return fail(409, 'tracker not set up');
    await T.prepare('INSERT INTO store_keys (store, public_jwk, wrapped_private, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (store) DO NOTHING')
      .bind(store, JSON.stringify(pubJwk(b.publicJwk)), b.wrappedPrivate, now()).run();
    const r = await T.prepare('SELECT public_jwk FROM store_keys WHERE store = ?').bind(store).first();
    return json({ publicJwk: JSON.parse(r.public_jwk) });
  }

  if (path === '/daily' && req.method === 'POST') return daily(req, env, store, { readJson, json, fail, clean });

  if (path === '/scan' && req.method === 'POST') {
    const b = await readJson(req, MAX.scan);
    if (!Array.isArray(b.rows) || b.rows.length > 2000) return fail(400, 'rows required');
    const at = now(), by = clean(b.by, 60) || null, storeName = clean(b.storeName, 80) || null;
    const rows = [];
    for (const r of b.rows) {
      const wo = int(r && r.wo);
      if (!wo) continue;
      rows.push({ wo, statusId: int(r.statusId), status: clean(r.status, 60) || null, programId: int(r.programId), program: clean(r.program, 80) || null,
        device: clean(r.device, 80) || null, outcome: clean(r.outcome, 40) || null, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt) });
    }
    // Only what a scan needs: the store's open WOs, plus any listed WO we have (a closed one coming back).
    // Reading the whole history each scan would grow with it.
    const known = new Map((await T.prepare(`SELECT wo, is_open, api_updated_at, last_detail_at, claimed_until, missing_since, gone_seen_at, store_name, status_id, status_name,
        program_id, program_name, device, service_outcome, created_at FROM workorders WHERE store = ? AND (is_open = 1 OR wo IN (SELECT value FROM json_each(?)))`)
      .bind(store, JSON.stringify(rows.map((r) => r.wo))).all()).results.map((r) => [r.wo, r]));
    const need = [], stmts = [];
    let fresh = 0, changed = 0, written = 0;
    const listed = new Set(rows.map((r) => r.wo));
    const claimed = (k) => k && k.claimed_until && k.claimed_until > at;
    // A row is only rewritten when something about it changed (every write is billed, indexes included).
    const differs = (k, r) => !k || (r.updatedAt && r.updatedAt !== k.api_updated_at) || (r.statusId != null && r.statusId !== k.status_id) || (r.status && r.status !== k.status_name)
      || (r.programId != null && r.programId !== k.program_id) || (r.program && r.program !== k.program_name) || (r.device && r.device !== k.device)
      || (r.outcome && !k.service_outcome) || (storeName && !k.store_name) || (r.createdAt && !k.created_at) || k.missing_since || k.gone_seen_at || !k.is_open;
    for (const r of rows) {
      const k = known.get(r.wo);
      if (!k) { fresh++; need.push({ wo: r.wo, why: 'new' }); }
      else if ((r.updatedAt && r.updatedAt !== k.api_updated_at) || (r.statusId != null && r.statusId !== k.status_id)) { changed++; if (!claimed(k)) need.push({ wo: r.wo, why: 'changed' }); }
      else if (!k.is_open && !claimed(k)) need.push({ wo: r.wo, why: 'reopened' });
      if (!differs(k, r)) continue;
      written++;
      stmts.push(T.prepare(`INSERT INTO workorders (store, wo, store_name, status_id, status_name, program_id, program_name, device, service_outcome, created_at, api_updated_at, is_open, first_seen_at, last_list_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT (store, wo) DO UPDATE SET store_name = COALESCE(excluded.store_name, store_name), status_id = COALESCE(excluded.status_id, status_id),
            status_name = COALESCE(excluded.status_name, status_name), program_id = COALESCE(excluded.program_id, program_id), program_name = COALESCE(excluded.program_name, program_name),
            device = COALESCE(excluded.device, device), service_outcome = COALESCE(service_outcome, excluded.service_outcome), created_at = COALESCE(excluded.created_at, created_at), api_updated_at = COALESCE(excluded.api_updated_at, api_updated_at),
            last_list_seen_at = excluded.last_list_seen_at, missing_since = NULL, gone_seen_at = NULL`)
        .bind(store, r.wo, storeName, r.statusId, r.status, r.programId, r.program, r.device, r.outcome, r.createdAt, r.updatedAt, at, at));
    }
    // Open WOs missing from the list: fetched in full to see whether they really closed. A short or
    // failed list (Waymark saw one report 14 WOs closed at once) is ignored rather than trusted.
    const open = [...known.values()].filter((k) => k.is_open);
    const oldestFirst = (x, y) => String(x.last_detail_at || '').localeCompare(String(y.last_detail_at || ''));
    const missing = open.filter((k) => !listed.has(k.wo)).sort(oldestFirst);
    // WOs Portal already answered 404 for don't count toward "short": otherwise enough of them lock the
    // store the same way, since a short list never lets a 404 close them.
    const counted = open.filter((k) => !(k.gone_seen_at && !listed.has(k.wo))).length;
    let note = null;
    // Short = empty, or under half of what we have open (WOs that really closed are fine: each one is
    // checked in Portal before it's recorded closed, so a list can only ever cause extra checks).
    // A short list still sends a few of them for a full check, oldest first, without marking them missing
    // (so a 404 can't close them): skipping them outright locked a busy store once closed WOs passed half
    // of what was on record, and they piled up as ghosts (Lynnhaven, Oct 2026).
    if (!rows.length || (counted >= 10 && rows.length < counted / 2)) {
      note = 'list looks short (' + rows.length + ' rows, ' + open.length + ' open on record): checking missing WOs a few at a time';
      missing.filter((k) => !claimed(k)).slice(0, STALE_MAX)
        .forEach((k) => need.push({ wo: k.wo, why: 'missing' }));
    } else for (const k of missing) {
      if (!k.missing_since) stmts.push(T.prepare('UPDATE workorders SET missing_since = ? WHERE store = ? AND wo = ?').bind(at, store, k.wo));
      if (!claimed(k)) need.push({ wo: k.wo, why: 'missing' });
    }
    // Stale: no full fetch for an hour (notes don't always move updatedAt). Oldest first, a few per scan.
    const staleBefore = new Date(Date.now() - STALE_MIN * 60000).toISOString();
    const due = new Set(need.map((n) => n.wo));
    open.filter((k) => listed.has(k.wo) && !due.has(k.wo) && !claimed(k) && (!k.last_detail_at || k.last_detail_at < staleBefore))
      .sort((x, y) => String(x.last_detail_at || '').localeCompare(String(y.last_detail_at || ''))).slice(0, STALE_MAX)
      .forEach((k) => need.push({ wo: k.wo, why: 'stale' }));
    const out = need.slice(0, NEED_MAX), until = later(CLAIM_MIN);
    for (const n of out) stmts.push(T.prepare('UPDATE workorders SET claimed_until = ? WHERE store = ? AND wo = ?').bind(until, store, n.wo));
    stmts.push(T.prepare('INSERT INTO scans (store, at, by_name, open_count, new_count, changed_count, need_count, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(store, at, by, rows.length, fresh, changed, out.length, note));
    for (let i = 0; i < stmts.length; i += 100) await T.batch(stmts.slice(i, i + 100));
    return json({ need: out, more: need.length > out.length, note, written });
  }

  /*
    Portal's sales history for one business day (Sales tab: GET /api/reporting/sales-history), sent by
    Aethernet: { day, rows: [{ saleId, wo, saleAt, type, total, partnerCredits, paid, completedBy, card }] }
    with the customer sealed in `card`. Items, program and device come from the WO's last cart here.
    Only changed sales are written; sales Portal no longer lists for the day are removed (never on an
    empty list, so a blip can't wipe a day).
  */
  if (path === '/sales' && req.method === 'POST') {
    const b = await readJson(req, 600000), day = clean(b.day, 10);
    if (!DAY_RE.test(day) || !Array.isArray(b.rows) || b.rows.length > 1000) return fail(400, 'day and rows required');
    const at = now(), tz = env.STORE_TZ || 'America/New_York';
    const rows = [];
    for (const r of b.rows) {
      const id = clean(r && r.saleId, 40);
      if (!id) continue;
      if (r.card != null && !isSealed(r.card, MAX.card)) return fail(400, 'bad card');
      const saleAt = iso(r.saleAt);
      if (saleAt && localDay(saleAt, tz) !== day) continue; // another day's sale (Portal's window runs into the next morning)
      rows.push({ id, wo: int(r.wo), saleAt, type: clean(r.type, 20) || null, total: num(r.total), partner: num(r.partnerCredits), paid: num(r.paid), by: clean(r.completedBy, 60) || null, card: r.card || null });
    }
    const old = new Map((await T.prepare('SELECT sale_id, hash FROM sales WHERE store = ? AND sale_day = ?').bind(store, day).all()).results.map((x) => [x.sale_id, x.hash]));
    const wos = [...new Set(rows.map((r) => r.wo).filter(Boolean))];
    const info = new Map();
    if (wos.length) {
      const q = await T.prepare(`SELECT w.wo, w.program_name, w.device, (SELECT s.plain FROM snapshots s WHERE s.store = w.store AND s.wo = w.wo AND json_array_length(json_extract(s.plain, '$.cart.items')) > 0 ORDER BY s.id DESC LIMIT 1) AS cart
          FROM workorders w WHERE w.store = ? AND w.wo IN (SELECT value FROM json_each(?))`).bind(store, JSON.stringify(wos)).all();
      for (const x of q.results) info.set(x.wo, { program: x.program_name, device: x.device, items: x.cart ? (JSON.parse(x.cart).cart.items || []) : null });
    }
    const stmts = [];
    let written = 0;
    for (const r of rows) {
      const i = (r.wo && info.get(r.wo)) || {};
      const items = i.items ? JSON.stringify(i.items) : null;
      const hash = await hashText([r.wo, r.saleAt, r.type, r.total, r.partner, r.paid, r.by, r.card, i.program, i.device, items].join('|'));
      if (old.get(r.id) === hash) continue;
      written++;
      stmts.push(T.prepare(`INSERT INTO sales (store, sale_id, wo, sale_day, sale_at, type, total, partner_credits, paid, completed_by, program, device, items, card, source, hash, seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'portal', ?, ?)
          ON CONFLICT (store, sale_id) DO UPDATE SET wo = excluded.wo, sale_day = excluded.sale_day, sale_at = excluded.sale_at, type = excluded.type, total = excluded.total,
            partner_credits = excluded.partner_credits, paid = excluded.paid, completed_by = excluded.completed_by, program = COALESCE(excluded.program, program),
            device = COALESCE(excluded.device, device), items = COALESCE(excluded.items, items), card = COALESCE(excluded.card, card), source = 'portal', hash = excluded.hash, seen_at = excluded.seen_at`)
        .bind(store, r.id, r.wo, day, r.saleAt, r.type, r.total, r.partner, r.paid, r.by, i.program || null, i.device || null, items, r.card, hash, at));
    }
    let removed = 0;
    if (rows.length) {
      const keep = new Set(rows.map((r) => r.id));
      const gone = [...old.keys()].filter((id) => !keep.has(id));
      removed = gone.length;
      if (gone.length) stmts.push(T.prepare("DELETE FROM sales WHERE store = ? AND sale_day = ? AND source = 'portal' AND sale_id IN (SELECT value FROM json_each(?))").bind(store, day, JSON.stringify(gone)));
    }
    const total = Math.round(rows.reduce((n, r) => n + (r.type === 'Return' ? -Math.abs(r.total || 0) : (r.total || 0)), 0) * 100) / 100;
    stmts.push(T.prepare(`INSERT INTO sales_days (store, day, source, synced_at, count, total) VALUES (?, ?, 'portal', ?, ?, ?)
        ON CONFLICT (store, day) DO UPDATE SET source = 'portal', synced_at = excluded.synced_at, count = excluded.count, total = excluded.total`).bind(store, day, at, rows.length, total));
    for (let k = 0; k < stmts.length; k += 100) await T.batch(stmts.slice(k, k + 100));
    return json({ ok: true, count: rows.length, written, removed, total });
  }

  // The RFP total at the end of each day (Tactician: "if every RFP device were picked up").
  if (path === '/rfp/days' && req.method === 'GET') {
    const from = clean(url.searchParams.get('from'), 10), to = clean(url.searchParams.get('to'), 10);
    if (!DAY_RE.test(from) || !DAY_RE.test(to) || to < from || (Date.parse(to) - Date.parse(from)) > 400 * 86400000) return fail(400, 'from/to required');
    return json({ days: await rfpDays(env, store, from, to) });
  }
  // Daily sales totals for this store (Tactician's sales per labor hour): no customers, no line items.
  if (path === '/sales/days' && req.method === 'GET') {
    const from = clean(url.searchParams.get('from'), 10), to = clean(url.searchParams.get('to'), 10);
    if (!DAY_RE.test(from) || !DAY_RE.test(to) || to < from || (Date.parse(to) - Date.parse(from)) > 400 * 86400000) return fail(400, 'from/to (YYYY-MM-DD, at most ~13 months) required');
    const r = await salesDays(env, (st) => st === store, from, to);
    return json({ days: r.days.map(({ day, source, count, total }) => ({ day, source, count, total })) });
  }
  /*
    The store's settings, set by managers in Aethernet (Settings, Store setup). The manager check is
    Aethernet's (Portal roles), like Waymark's tag list: the server can't see Portal logins.
      GET /settings                     { gm: { userIds: [..], names: { id: name }, by, at } }
      PUT /settings/gm { userIds, names, by }
  */
  if (path === '/settings' && req.method === 'GET') {
    const r = await T.prepare('SELECT key, value, updated_by, updated_at FROM store_settings WHERE store = ?').bind(store).all();
    const out = {};
    for (const x of r.results) { try { out[x.key] = Object.assign(JSON.parse(x.value), { by: x.updated_by, at: x.updated_at }); } catch (_) {} }
    return json(out);
  }
  if (path === '/settings/gm' && req.method === 'PUT') {
    const b = await readJson(req, 20000);
    const ids = [...new Set((Array.isArray(b.userIds) ? b.userIds : []).map(int).filter(Boolean))].slice(0, 20);
    const names = {};
    for (const id of ids) names[id] = clean(b.names && b.names[id], 60) || null;
    await T.prepare('INSERT INTO store_settings (store, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (store, key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at')
      .bind(store, 'gm', JSON.stringify({ userIds: ids, names }), clean(b.by, 60) || null, now()).run();
    return json({ ok: true, gm: { userIds: ids, names } });
  }

  // The store's RFP total (Master's Mend → RFP total on the Sales card): one sum, no WO details.
  if (path === '/rfp' && req.method === 'GET') {
    const r = await T.prepare(`SELECT COUNT(*) AS count, ROUND(COALESCE(SUM(cart_value), 0), 2) AS value,
        SUM(CASE WHEN service_outcome = 'Completed' THEN 1 ELSE 0 END) AS complete, ROUND(COALESCE(SUM(CASE WHEN service_outcome = 'Completed' THEN cart_value END), 0), 2) AS complete_value,
        SUM(CASE WHEN service_outcome IS NOT NULL AND service_outcome != 'Completed' THEN 1 ELSE 0 END) AS incomplete,
        ROUND(COALESCE(SUM(CASE WHEN service_outcome IS NOT NULL AND service_outcome != 'Completed' THEN cart_value END), 0), 2) AS incomplete_value,
        SUM(CASE WHEN service_outcome IS NULL THEN 1 ELSE 0 END) AS unknown
      FROM workorders WHERE store = ? AND is_open = 1 AND status_id = 13`).bind(store).first();
    const sc = await T.prepare('SELECT MAX(at) AS at FROM scans WHERE store = ?').bind(store).first();
    return json({ count: r.count || 0, value: r.value || 0, complete: { count: r.complete || 0, value: r.complete_value || 0 },
      incomplete: { count: r.incomplete || 0, value: r.incomplete_value || 0 }, unknown: r.unknown || 0, updatedAt: (sc && sc.at) || null });
  }

  const mv = path.match(/^\/wo\/(\d{1,12})\/moved$/);
  if (mv && req.method === 'POST') {
    const wo = Number(mv[1]), at = now(), b = await readJson(req, MAX.wo), to = int(b.to);
    if (!to || to === store) return fail(400, 'to (the other store) required');
    const k = await T.prepare('SELECT is_open FROM workorders WHERE store = ? AND wo = ?').bind(store, wo).first();
    if (!k || !k.is_open) return json({ ok: true, ignored: 'not open' });
    await T.batch([T.prepare('UPDATE workorders SET is_open = 0, closed_at = ?, closed_reason = ?, claimed_until = NULL, last_detail_at = ? WHERE store = ? AND wo = ?')
      .bind(at, 'moved to store ' + to, at, store, wo), closeStatusPeriod(T, store, wo, at), closeRfpPeriod(T, store, wo, at)]);
    return json({ ok: true, closed: true });
  }
  const wm = path.match(/^\/wo\/(\d{1,12})(\/gone)?$/);
  if (wm && req.method === 'POST') {
    const wo = Number(wm[1]), at = now();
    const b = await readJson(req, MAX.wo);
    const by = clean(b.by, 60) || null;
    if (wm[2]) {
      // Portal answered 404. Only recorded closed after a second 404 at least GONE_MIN later, and only for a
      // WO that's also missing from the list (a WO from another store, or a Portal hiccup, is never closed).
      const k = await T.prepare('SELECT is_open, missing_since, gone_seen_at FROM workorders WHERE store = ? AND wo = ?').bind(store, wo).first();
      if (!k || !k.is_open) return json({ ok: true, ignored: 'not open' });
      if (!k.missing_since) { // not trusted missing (short list): note the 404, send it to the back of the line
        await T.prepare('UPDATE workorders SET gone_seen_at = COALESCE(gone_seen_at, ?), last_detail_at = ?, claimed_until = NULL WHERE store = ? AND wo = ?').bind(at, at, store, wo).run();
        return json({ ok: true, ignored: 'not confirmed missing' });
      }
      if (!k.gone_seen_at || Date.parse(at) - Date.parse(k.gone_seen_at) < GONE_MIN * 60000) {
        if (!k.gone_seen_at) await T.prepare('UPDATE workorders SET gone_seen_at = ?, claimed_until = NULL WHERE store = ? AND wo = ?').bind(at, store, wo).run();
        else await T.prepare('UPDATE workorders SET claimed_until = NULL WHERE store = ? AND wo = ?').bind(store, wo).run();
        return json({ ok: true, pending: 'confirm later' });
      }
      await T.batch([T.prepare("UPDATE workorders SET is_open = 0, closed_at = ?, closed_reason = 'gone', claimed_until = NULL, last_detail_at = ? WHERE store = ? AND wo = ?").bind(at, at, store, wo), closeStatusPeriod(T, store, wo, at), closeRfpPeriod(T, store, wo, at)]);
      return json({ ok: true, closed: true });
    }
    const hash = clean(b.hash, 64), plain = b.plain;
    if (!hash || !plain || typeof plain !== 'object' || !plain.workorder || int(plain.workorder.workorderId) !== wo) return fail(400, 'hash and plain.workorder required');
    if (!isSealed(b.sealed, MAX.sealed)) return fail(400, 'sealed detail required');
    if (b.card != null && !isSealed(b.card, MAX.card)) return fail(400, 'bad card');
    const own = int(plain.workorder.storeId);
    if (own != null && own !== store) return fail(409, 'work order ' + wo + ' belongs to store ' + own); // a browser switched stores mid-scan
    const plainText = JSON.stringify(plain);
    if (plainText.length > MAX.plain) return fail(413, 'plain part too large');
    if (!(await T.prepare('SELECT 1 FROM store_keys WHERE store = ?').bind(store).first())) return fail(409, 'no store key yet');
    const prev = await T.prepare('SELECT last_hash, plain FROM workorders WHERE store = ? AND wo = ?').bind(store, wo).first();
    if (prev && prev.last_hash === hash) {
      await T.prepare('UPDATE workorders SET last_detail_at = ?, claimed_until = NULL WHERE store = ? AND wo = ?').bind(at, store, wo).run();
      return json({ ok: true, same: true });
    }
    const w = plain.workorder, pay = (plain.cart && plain.cart.payment) || {}, value = cartValue(plain);
    // Portal empties a WO's cart at Sale complete: keep the last non-empty one (sales items, estimates).
    const hasItems = !!(plain.cart && plain.cart.items && plain.cart.items.length), soldAt = soldAtOf(plain);
    const statusId = int(w.statusId), closed = CLOSED_IDS.has(statusId);
    const snap = await T.prepare('INSERT INTO snapshots (store, wo, fetched_at, trigger, by_name, hash, plain, sealed) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
      .bind(store, wo, at, clean(b.trigger, 20) || null, by, hash, plainText, b.sealed).first();
    const changes = prev && prev.plain ? diff(JSON.parse(prev.plain), plain) : [];
    const stmts = changes.slice(0, 1000).map(([field, o, n]) => T.prepare('INSERT INTO changes (store, wo, changed_at, field, old, new, snapshot_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(store, wo, at, field.slice(0, 300), o == null ? null : String(o).slice(0, 4000), n == null ? null : String(n).slice(0, 4000), snap.id));
    stmts.push(T.prepare(`INSERT INTO workorders (store, wo, status_id, status_name, program_id, program_name, device, created_at, api_updated_at, is_open, first_seen_at,
          last_detail_at, last_hash, closed_at, closed_reason, cart_total, cart_paid, cart_due, cart_value, service_outcome, plain, card, last_cart_value, last_cart_tax, sold_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (store, wo) DO UPDATE SET status_id = COALESCE(excluded.status_id, status_id), status_name = COALESCE(excluded.status_name, status_name),
          program_id = COALESCE(excluded.program_id, program_id), program_name = COALESCE(excluded.program_name, program_name), device = COALESCE(excluded.device, device),
          created_at = COALESCE(created_at, excluded.created_at), api_updated_at = COALESCE(api_updated_at, excluded.api_updated_at), -- the list's value drives change detection
          is_open = excluded.is_open, last_detail_at = excluded.last_detail_at, last_hash = excluded.last_hash, claimed_until = NULL,
          closed_at = CASE WHEN excluded.is_open = 1 THEN NULL ELSE COALESCE(closed_at, excluded.closed_at) END,
          closed_reason = CASE WHEN excluded.is_open = 1 THEN NULL ELSE COALESCE(closed_reason, excluded.closed_reason) END,
          missing_since = CASE WHEN excluded.is_open = 1 THEN missing_since ELSE NULL END,
          cart_total = excluded.cart_total, cart_paid = excluded.cart_paid, cart_due = excluded.cart_due, cart_value = excluded.cart_value, service_outcome = COALESCE(excluded.service_outcome, service_outcome), plain = excluded.plain,
          last_cart_value = COALESCE(excluded.last_cart_value, last_cart_value), last_cart_tax = COALESCE(excluded.last_cart_tax, last_cart_tax), sold_at = COALESCE(excluded.sold_at, sold_at), card = COALESCE(excluded.card, card)`)
      .bind(store, wo, statusId, clean(w.status, 60) || null, int(w.programId), clean(w.program, 80) || null, clean(w.device, 80) || null, iso(w.createdAt), iso(w.updatedAt),
        closed ? 0 : 1, at, at, hash, closed ? at : null, closed ? (clean(w.status, 60) || 'closed') : null, num(pay.total), num(pay.amountPaid), num(pay.amountDue), value, clean(w.outcome, 40) || null, plainText, b.card || null,
        hasItems ? value : null, hasItems ? num(pay.tax) : null, iso(soldAt)));
    stmts.push(...(await rfpPeriodStmts(T, store, wo, plain, at)));
    stmts.push(...(await statusPeriodStmts(T, store, wo, plain, at)));
    for (let i = 0; i < stmts.length; i += 100) await T.batch(stmts.slice(i, i + 100));
    return json({ ok: true, snapshot: snap.id, changes: changes.length });
  }
  return fail(404, 'not found');
}

// ------------------------------------------------------------------ admin side (Access-protected)
// Who may open what: src/access.js (one gate for every admin route; developers bypass it).
async function log(env, email, action, store = null, wo = null, detail = null) {
  await env.TR.prepare('INSERT INTO access_log (email, action, store, wo, detail, at) VALUES (?, ?, ?, ?, ?, ?)').bind(email, action, store, wo, detail, now()).run();
}
const PAGE_NAME = { wos: 'work orders', sales: 'sales', metrics: 'metrics', data: 'store data', usage: 'usage', reports: 'reports', auto: 'auto-waymark', stores: 'stores', rules: 'assize rules' };
// "pages +metrics -usage · stores +1276 · details on · role manager → custom" (access_log detail for access:change)
function accessDiff(before, after) {
  const out = [], pm = (a, b, f) => [...b.filter((x) => !a.includes(x)).map((x) => '+' + f(x)), ...a.filter((x) => !b.includes(x)).map((x) => '-' + f(x))];
  const pg = pm(before.pages, after.pages, (x) => x);
  if (pg.length) out.push('pages ' + pg.join(' '));
  const sa = before.scope === 'all' ? ['all'] : before.stores, sb = after.scope === 'all' ? ['all'] : after.stores;
  const sd = pm(sa.map(String), sb.map(String), (x) => x);
  if (sd.length) out.push('stores ' + sd.join(' '));
  if (before.details !== after.details) out.push('details ' + (after.details ? 'on' : 'off'));
  const ra = before.review ? 'review' : presetOf(before), rb = presetOf(after);
  if (ra !== rb) out.push('role ' + ra + ' → ' + rb);
  return out.join(' · ') || 'no change';
}

/*
  Every route below is gated first (src/access.js ROUTES): unknown routes, pages the person
  wasn't given and stores outside their list are refused with 403 and an access_log 'denied' row.
  With customer details off, sealed fields (card, sealed, customerName) are stripped from every answer.

  GET  /me                       { email, person, keys: [copies], master: publicJwk|null, canInit,
                                   access: { owner, pages, scope, stores, details, review } }
  POST /init { publicJwk, copy } first setup (a developer, TRACKER_OWNERS): master key + their copy
  PUT  /me/keys { keys }         replace your own copies (new passphrase / redeeming an invite); details on only
  GET  /store-keys               all stores + details: every store's { store, publicJwk, wrappedPrivate }
  GET  /stores                   stores you can see, with counts
  GET  /wos?store=&open=&status=&since=&limit=&offset=&detail=1   WO rows (plain + sealed card;
                                 detail=1 adds the latest sealed snapshot, for searching note text)
  GET  /wo/:store/:wo            one WO: row, snapshots (plain + sealed), changes
  …    /assize/…                 Assize rules: list, drafts, publish, history, per-store overrides, test orders
                                 (page 'rules'; src/assize.js has the routes)
  Developers only (People; TRACKER_OWNERS, `owner` in the API):
  GET  /people                   everyone + their key copies' kinds, pages, details, review; owners: the developers
  POST /people { email, name, scope, stores, pages, details, keys, keysMode }   add/update. keys = invite
                                 copies (details on only); keysMode 'add' keeps their other copies, otherwise
                                 a new invite replaces them all. Details off deletes every copy.
  POST /people/:email/remove
  GET  /log?limit=&kind=access   who looked at what (kind=access: access changes and denied requests)
  GET  /metrics?from&to&stores&granularity&compare   the Metrics page (src/metrics.js); POST /metrics/backfill
  GET  /agents                   connected programs
  POST /agents/:id/approve { stores, keys: [{ store, wrapped }] }   grant stores (replaces earlier grants)
  POST /agents/:id/remove
  POST /agents/:id/settings { settings }   audit settings (validated; see agentSettings)
  POST /agents/:id/run-now       the program runs its audit at its next check (within 30 minutes)

  `who` (optional): the caller's access as admin-worker already worked it out (accessOf); without it,
  it's read here. Either way the gate runs again here.
*/
export async function trackerAdmin(req, env, url, path, email, who) {
  email = String(email || '').toLowerCase();
  if (!email) return fail(403, 'not signed in', false);
  if (who === undefined) who = await accessOf(env, email);
  const denied = await check(env, who, email, req.method, '/api/tracker' + path, url.search);
  if (denied) return json(denied, 403, false);
  const res = await trackerRoutes(req, env, url, path, email, who);
  if (!who || who.details) return res;
  // Customer details off: nothing sealed leaves the server, whatever the route.
  const text = await res.text();
  let b; try { b = JSON.parse(text); } catch (_) { return new Response(text, res); }
  return json(stripSealed(b), res.status, false);
}

async function trackerRoutes(req, env, url, path, email, who) {
  const T = env.TR;
  const me = who;
  if (me && me.listed) await T.prepare('UPDATE people SET last_seen_at = ? WHERE email = ?').bind(now(), email).run();
  const master = await T.prepare('SELECT public_jwk FROM master_key WHERE id = 1').first();
  const body = () => readJson(req, 200000);
  const canSee = (st) => !!me && me.canSee(st);

  if (req.method === 'GET' && path === '/me') {
    const keys = me && me.listed ? (await T.prepare('SELECT kind, store, salt, rounds, wrapped, invite FROM person_keys WHERE email = ?').bind(email).all()).results : [];
    return json({ email, person: me ? { email, name: me.name, scope: me.scope, stores: me.stores } : null, keys, master: master ? JSON.parse(master.public_jwk) : null,
      canInit: !master && owners(env).includes(email),
      access: me ? { owner: me.owner, pages: me.pages, scope: me.scope, stores: me.stores, details: me.details, review: me.review } : null }, 200, false);
  }
  if (req.method === 'POST' && path === '/init') {
    if (master) return fail(409, 'already set up', false);
    if (!owners(env).includes(email)) return fail(403, 'only a developer can set up the tracker', false);
    const b = await body();
    if (!isJwk(b.publicJwk) || !isCopy(b.copy)) return fail(400, 'publicJwk and copy required', false);
    await T.batch([
      T.prepare('INSERT INTO master_key (id, public_jwk, created_by, created_at) VALUES (1, ?, ?, ?)').bind(JSON.stringify(pubJwk(b.publicJwk)), email, now()),
      T.prepare("INSERT INTO people (email, name, scope, stores, pages, details, added_by, added_at) VALUES (?, ?, 'all', '[]', ?, 1, ?, ?) ON CONFLICT (email) DO UPDATE SET scope = 'all', details = 1")
        .bind(email, clean(b.name, 60) || null, JSON.stringify(PAGES), email, now()),
      T.prepare("INSERT OR REPLACE INTO person_keys (email, kind, store, salt, rounds, wrapped, invite, created_by, created_at) VALUES (?, 'master', 0, ?, ?, ?, 0, ?, ?)").bind(email, b.copy.salt, b.copy.rounds, b.copy.wrapped, email, now()),
    ]);
    await log(env, email, 'init');
    return json({ ok: true }, 200, false);
  }
  if (!me) return fail(403, 'not on the access list; ask whoever manages Aethernet access to add you', false);

  if (req.method === 'PUT' && path === '/me/keys') {
    if (!me.details) return fail(403, 'customer details are off for your account', false);
    const b = await body();
    if (!Array.isArray(b.keys) || !b.keys.length || b.keys.length > 500) return fail(400, 'keys required', false);
    const stmts = [];
    for (const k of b.keys) {
      const store = k.kind === 'store' ? int(k.store) : 0;
      if (!isCopy(k) || !['master', 'store'].includes(k.kind) || (k.kind === 'master' && me.scope !== 'all') || (k.kind === 'store' && !canSee(store))) return fail(400, 'bad key copy', false);
      stmts.push(T.prepare('INSERT OR REPLACE INTO person_keys (email, kind, store, salt, rounds, wrapped, invite, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)')
        .bind(email, k.kind, store, k.salt, k.rounds, k.wrapped, email, now()));
    }
    await T.batch(stmts);
    await log(env, email, 'keys', null, null, b.keys.length + ' copies');
    return json({ ok: true }, 200, false);
  }
  if (req.method === 'GET' && path === '/store-keys') {
    // Each store's private key, sealed to the master key: only useful to (and only given to) master holders.
    if (!(me.owner || (me.scope === 'all' && me.details))) return fail(403, 'all stores with customer details only', false);
    const r = await T.prepare('SELECT store, public_jwk, wrapped_private FROM store_keys ORDER BY store').all();
    return json({ keys: r.results.map((k) => ({ store: k.store, publicJwk: JSON.parse(k.public_jwk), wrappedPrivate: k.wrapped_private })) }, 200, false);
  }
  if (req.method === 'GET' && path === '/stores') {
    const r = await T.prepare(`SELECT store, MAX(store_name) AS name, COUNT(*) AS total, SUM(is_open) AS open, SUM(CASE WHEN is_open = 1 AND status_id = 13 THEN 1 ELSE 0 END) AS rfp,
        SUM(CASE WHEN is_open = 1 AND status_id = 13 THEN COALESCE(cart_due, 0) ELSE 0 END) AS rfp_due,
        SUM(CASE WHEN is_open = 1 AND status_id = 13 THEN COALESCE(cart_value, 0) ELSE 0 END) AS rfp_value,
        SUM(CASE WHEN is_open = 1 AND status_id = 13 AND service_outcome = 'Completed' THEN 1 ELSE 0 END) AS rfp_complete,
        SUM(CASE WHEN is_open = 1 AND status_id = 13 AND service_outcome = 'Completed' THEN COALESCE(cart_value, 0) ELSE 0 END) AS rfp_complete_value,
        SUM(CASE WHEN is_open = 1 AND status_id = 13 AND service_outcome IS NOT NULL AND service_outcome != 'Completed' THEN 1 ELSE 0 END) AS rfp_other,
        SUM(CASE WHEN is_open = 1 AND status_id = 13 AND service_outcome IS NOT NULL AND service_outcome != 'Completed' THEN COALESCE(cart_value, 0) ELSE 0 END) AS rfp_other_value,
        SUM(CASE WHEN is_open = 1 AND status_id = 13 AND service_outcome IS NULL THEN 1 ELSE 0 END) AS rfp_unknown, MAX(last_detail_at) AS last_detail_at FROM workorders GROUP BY store ORDER BY store`).all();
    const scans = new Map((await T.prepare('SELECT store, MAX(at) AS at FROM scans GROUP BY store').all()).results.map((s) => [s.store, s.at]));
    return json({ stores: r.results.filter((s) => canSee(s.store)).map((s) => Object.assign(s, { last_scan_at: scans.get(s.store) || null })) }, 200, false);
  }
  if (req.method === 'GET' && path === '/wos') {
    const q = url.searchParams, where = [], args = [];
    const store = q.get('store') ? int(q.get('store')) : null;
    if (store != null) { if (!canSee(store)) return fail(403, 'not your store', false); where.push('store = ?'); args.push(store); }
    else if (me.scope !== 'all') { if (!me.stores.length) return json({ wos: [] }, 200, false); where.push('store IN (' + me.stores.map(() => '?').join(',') + ')'); args.push(...me.stores); }
    if (q.get('open') === '1') where.push('is_open = 1'); else if (q.get('open') === '0') where.push('is_open = 0');
    if (q.get('status')) { where.push('status_id = ?'); args.push(int(q.get('status'))); }
    if (q.get('outcome') === 'complete') where.push("service_outcome = 'Completed'"); else if (q.get('outcome') === 'other') where.push("service_outcome IS NOT NULL AND service_outcome != 'Completed'"); else if (q.get('outcome') === 'unknown') where.push('service_outcome IS NULL');
    if (q.get('since')) { where.push('COALESCE(api_updated_at, first_seen_at) >= ?'); args.push(clean(q.get('since'), 40)); }
    const limit = Math.min(int(q.get('limit')) || 500, 5000), offset = int(q.get('offset')) || 0;
    const r = await T.prepare(`SELECT store, wo, store_name, status_id, status_name, program_id, program_name, device, created_at, api_updated_at, is_open, first_seen_at,
        last_detail_at, closed_at, closed_reason, cart_total, cart_paid, cart_due, cart_value, service_outcome${me.details ? ', card' : ''}${me.details && q.get('detail') === '1' ? ', (SELECT sealed FROM snapshots s WHERE s.store = workorders.store AND s.wo = workorders.wo ORDER BY id DESC LIMIT 1) AS sealed' : ''} FROM workorders ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY COALESCE(api_updated_at, first_seen_at) DESC LIMIT ? OFFSET ?`).bind(...args, limit, offset).all();
    await log(env, email, 'list', store, null, url.search.slice(0, 200));
    return json({ wos: r.results }, 200, false);
  }
  const om = path.match(/^\/wo\/(\d{1,6})\/(\d{1,12})$/);
  if (req.method === 'GET' && om) {
    const store = Number(om[1]), wo = Number(om[2]);
    if (!canSee(store)) return fail(403, 'not your store', false);
    const [row, snaps, chg] = await T.batch([
      T.prepare('SELECT * FROM workorders WHERE store = ? AND wo = ?').bind(store, wo),
      T.prepare('SELECT id, fetched_at, trigger, by_name, hash, plain, sealed FROM snapshots WHERE store = ? AND wo = ? ORDER BY id DESC LIMIT 200').bind(store, wo),
      T.prepare('SELECT changed_at, field, old, new, snapshot_id FROM changes WHERE store = ? AND wo = ? ORDER BY id DESC LIMIT 2000').bind(store, wo),
    ]);
    if (!row.results.length) return fail(404, 'no such work order', false);
    await log(env, email, 'open', store, wo);
    return json({ wo: row.results[0], snapshots: snaps.results, changes: chg.results }, 200, false);
  }
  /*
    GET /sales/days?store=&from=&to=   per store and day: Portal's sales (source portal|mac) or, for a day
                                       without them, an estimate from WOs that reached Sale complete that day
                                       (their last cart before checkout: value before tax + its tax; quick sales
                                       can't be estimated). [{ store, day, source, count, total, partnerCredits, paid }]
    GET /sales/day?store=&day=         that day's sales (customer sealed in card) or estimated WOs.
  */
  if (req.method === 'GET' && (path === '/sales/days' || path === '/sales/day')) {
    const q = url.searchParams;
    const stores = q.get('store') ? [int(q.get('store'))] : null;
    if (stores && !canSee(stores[0])) return fail(403, 'not your store', false);
    const visible = (st) => canSee(st) && (!stores || stores.includes(st));
    const from = clean(q.get(path === '/sales/day' ? 'day' : 'from'), 10), to = clean(q.get(path === '/sales/day' ? 'day' : 'to'), 10);
    if (!DAY_RE.test(from) || !DAY_RE.test(to) || to < from) return fail(400, 'from/to (YYYY-MM-DD) required', false);
    const r = await salesDays(env, visible, from, to);
    if (path === '/sales/day') {
      const st = stores ? stores[0] : null;
      await log(env, email, 'sales:day', st, null, from);
      return json({ day: from, sales: r.sales.filter((x) => !st || x.store === st).map((x) => Object.assign(x, { items: x.items ? JSON.parse(x.items) : [] })),
        estimated: [...r.estimated.entries()].filter(([k]) => !st || k.startsWith(st + '|')).flatMap(([, v]) => v) }, 200, false);
    }
    await log(env, email, 'sales:days', stores ? stores[0] : null, null, from + '..' + to);
    return json({ days: r.days }, 200, false);
  }
  // Metrics (src/metrics.js): the gate above already required page 'metrics'; metricsApi limits stores to what `me` may see.
  if (path === '/metrics' || path.startsWith('/metrics/')) return metricsApi(req, env, url, path, me);
  // Assize rules (src/assize.js): the gate above already required page 'rules'; edits check the scope there.
  if (path.startsWith('/assize/')) return assizeAdmin(req, env, url, path, me, email, { json, fail, readJson, clean, int, now, log });

  if (!me.owner) return fail(403, 'developers only', false);
  if (req.method === 'GET' && path === '/people') {
    const [p, k] = await T.batch([T.prepare('SELECT * FROM people ORDER BY email'), T.prepare('SELECT email, kind, store, invite FROM person_keys')]);
    const own = owners(env);
    return json({ owners: own, pages: PAGES, wide: WIDE_PAGES, people: p.results.map((x) => Object.assign(x, { stores: JSON.parse(x.stores || '[]'), pages: cleanPages(x.pages), details: !!x.details, review: !!x.review,
      owner: own.includes(x.email), keys: k.results.filter((c) => c.email === x.email) })) }, 200, false);
  }
  if (req.method === 'POST' && path === '/people') {
    const b = await body();
    const who = String(b.email || '').trim().toLowerCase(), scope = b.scope;
    if (!EMAIL_RE.test(who) || !['all', 'stores'].includes(scope)) return fail(400, 'email and scope required', false);
    const stores = scope === 'stores' ? [...new Set((b.stores || []).map(int).filter((s) => s && s < 1000000))] : [];
    if (scope === 'stores' && !stores.length) return fail(400, 'pick at least one store', false);
    const old = await T.prepare('SELECT * FROM people WHERE email = ?').bind(who).first();
    const keysIn = Array.isArray(b.keys) ? b.keys : [];
    if (keysIn.length > 500) return fail(400, 'too many key copies', false);
    // Pages and details: as sent; otherwise kept (an older page that doesn't send them) or, for someone new, Store viewer.
    if (b.pages !== undefined && !Array.isArray(b.pages)) return fail(400, 'pages must be a list', false);
    const pages = b.pages !== undefined ? cleanPages(b.pages) : old ? cleanPages(old.pages) : ['wos'];
    const details = b.details !== undefined ? !!b.details : (keysIn.length > 0 || !!(old && old.details));
    if (!details && keysIn.length) return fail(400, 'customer details are off: no key copies', false);
    const stmts = [T.prepare(`INSERT INTO people (email, name, scope, stores, pages, details, review, added_by, added_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
        ON CONFLICT (email) DO UPDATE SET name = COALESCE(excluded.name, name), scope = excluded.scope, stores = excluded.stores, pages = excluded.pages, details = excluded.details, review = 0,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .bind(who, clean(b.name, 60) || null, scope, JSON.stringify(stores), JSON.stringify(pages), details ? 1 : 0, email, now(), email, now())];
    if (!details) stmts.push(T.prepare('DELETE FROM person_keys WHERE email = ?').bind(who));
    else {
      // A new invite replaces all their copies (they set a passphrase again) unless it only adds to them (keysMode 'add');
      // either way copies they no longer qualify for go.
      if (keysIn.length && b.keysMode !== 'add') stmts.push(T.prepare('DELETE FROM person_keys WHERE email = ?').bind(who));
      if (scope === 'stores') stmts.push(T.prepare("DELETE FROM person_keys WHERE email = ? AND (kind = 'master' OR store NOT IN (" + stores.map(() => '?').join(',') + '))').bind(who, ...stores));
    }
    for (const k of keysIn) {
      const st = k.kind === 'store' ? int(k.store) : 0;
      if (!isCopy(k) || !['master', 'store'].includes(k.kind) || (k.kind === 'master' && scope !== 'all') || (k.kind === 'store' && scope === 'stores' && !stores.includes(st))) return fail(400, 'bad key copy', false);
      stmts.push(T.prepare('INSERT OR REPLACE INTO person_keys (email, kind, store, salt, rounds, wrapped, invite, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)')
        .bind(who, k.kind, st, k.salt, k.rounds, k.wrapped, email, now()));
    }
    await T.batch(stmts);
    const after = { scope, stores, pages, details };
    if (!old) await log(env, email, 'access:add', null, null, who + ' · ' + presetOf(after) + ' · ' + (scope === 'all' ? 'all stores' : 'stores ' + stores.join(', ')) + ' · details ' + (details ? 'on' : 'off'));
    else {
      const before = { scope: old.scope, stores: JSON.parse(old.stores || '[]'), pages: cleanPages(old.pages), details: !!old.details, review: !!old.review };
      await log(env, email, 'access:change', null, null, who + ' · ' + accessDiff(before, after));
    }
    if (keysIn.length) await log(env, email, 'access:keys', null, null, who + ' · details on · invite for ' + keysIn.map((k) => (k.kind === 'master' ? 'all stores' : int(k.store))).join(', '));
    return json({ ok: true }, 200, false);
  }
  const rm = path.match(/^\/people\/([^/]+)\/remove$/);
  if (req.method === 'POST' && rm) {
    const who = decodeURIComponent(rm[1]).toLowerCase();
    const others = await T.prepare("SELECT COUNT(*) AS n FROM people WHERE scope = 'all' AND email != ?").bind(who).first();
    const target = await T.prepare('SELECT scope FROM people WHERE email = ?').bind(who).first();
    if (target && target.scope === 'all' && !others.n) return fail(409, "can't remove the last person with full access", false);
    await T.batch([T.prepare('DELETE FROM person_keys WHERE email = ?').bind(who), T.prepare('DELETE FROM people WHERE email = ?').bind(who)]);
    await log(env, email, 'access:remove', null, null, who);
    return json({ ok: true }, 200, false);
  }
  if (req.method === 'GET' && path === '/agents') {
    const r = await T.prepare('SELECT * FROM agents ORDER BY created_at').all();
    return json({ agents: await Promise.all(r.results.map(async (a) => ({ id: a.id, name: a.name, fingerprint: await fingerprint(JSON.parse(a.public_jwk)), status: a.status, stores: JSON.parse(a.stores || '[]'),
      created_at: a.created_at, approved_by: a.approved_by, approved_at: a.approved_at, last_seen_at: a.last_seen_at, publicJwk: JSON.parse(a.public_jwk),
      settings: withDefaults(a.settings), runNow: !!a.run_now, lastRun: parseRun(a.last_run) }))) }, 200, false);
  }
  const am = path.match(/^\/agents\/([0-9a-f]{32})\/(approve|remove|settings|run-now)$/);
  if (req.method === 'POST' && am) {
    const a = await T.prepare('SELECT id, name FROM agents WHERE id = ?').bind(am[1]).first();
    if (!a) return fail(404, 'no such program', false);
    if (am[2] === 'remove') {
      await T.batch([T.prepare('DELETE FROM agent_keys WHERE agent_id = ?').bind(a.id), T.prepare('DELETE FROM agents WHERE id = ?').bind(a.id)]);
      await log(env, email, 'agent:remove', null, null, a.name + ' ' + a.id);
      return json({ ok: true }, 200, false);
    }
    if (am[2] === 'settings') {
      const st = agentSettings((await body()).settings);
      if (!st) return fail(400, 'bad settings', false);
      await T.prepare('UPDATE agents SET settings = ? WHERE id = ?').bind(JSON.stringify(st), a.id).run();
      await log(env, email, 'agent:settings', null, null, a.name + ' ' + JSON.stringify(st).slice(0, 300));
      return json({ ok: true, settings: withDefaults(JSON.stringify(st)) }, 200, false);
    }
    if (am[2] === 'run-now') {
      await T.prepare('UPDATE agents SET run_now = 1 WHERE id = ?').bind(a.id).run();
      await log(env, email, 'agent:run-now', null, null, a.name);
      return json({ ok: true }, 200, false);
    }
    const b = await body();
    if (!Array.isArray(b.stores) || b.stores.length > 200 || !Array.isArray(b.keys) || b.keys.length > 200) return fail(400, 'stores and keys required', false);
    const stores = [...new Set(b.stores.map(int))];
    if (stores.some((s) => !s || s >= 1000000)) return fail(400, 'bad store', false);
    const wrapped = new Map();
    for (const k of b.keys) { const st = int(k && k.store); if (!stores.includes(st) || !isSealed(k.wrapped, 1000)) return fail(400, 'bad key', false); wrapped.set(st, k.wrapped); }
    if (stores.some((s) => !wrapped.has(s))) return fail(400, 'a key is needed for every store', false);
    const have = (await T.prepare('SELECT store FROM store_keys WHERE store IN (SELECT value FROM json_each(?))').bind(JSON.stringify(stores)).all()).results.length;
    if (have !== stores.length) return fail(400, 'a store has no key yet', false);
    await T.batch([
      T.prepare('DELETE FROM agent_keys WHERE agent_id = ?').bind(a.id),
      T.prepare("UPDATE agents SET status = 'active', stores = ?, approved_by = ?, approved_at = ? WHERE id = ?").bind(JSON.stringify(stores), email, now(), a.id),
      ...stores.map((s) => T.prepare('INSERT INTO agent_keys (agent_id, store, wrapped, created_by, created_at) VALUES (?, ?, ?, ?, ?)').bind(a.id, s, wrapped.get(s), email, now())),
    ]);
    await log(env, email, 'agent:approve', null, null, a.name + ' ' + (stores.join(',') || 'no stores'));
    return json({ ok: true }, 200, false);
  }
  if (req.method === 'GET' && path === '/log') {
    const lim = Math.min(int(url.searchParams.get('limit')) || 200, 2000);
    const r = url.searchParams.get('kind') === 'access'
      ? await T.prepare("SELECT * FROM access_log WHERE action LIKE 'access:%' OR action IN ('denied', 'init', 'person:add', 'person:remove') ORDER BY id DESC LIMIT ?").bind(lim).all()
      : await T.prepare("SELECT * FROM access_log WHERE action NOT LIKE 'access:%' AND action != 'denied' ORDER BY id DESC LIMIT ?").bind(lim).all();
    return json({ log: r.results }, 200, false);
  }
  return fail(404, 'not found', false);
}

// ------------------------------------------------------------------ retention
async function gz(text) {
  return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
}
// Moves rows older than the cutoff to R2 (when bound) in chunks, then deletes them.
export { dayEnd };
export async function trim(env, { keepDays = KEEP_DAYS, chunk = 500, rounds = 20 } = {}) {
  const T = env.TR, cutoff = new Date(Date.now() - keepDays * 86400000).toISOString(), run = now().replace(/[:.]/g, '');
  const out = { snapshots: 0, changes: 0, archived: !!env.ARCHIVE };
  if (!env.ARCHIVE && !env.TRIM_WITHOUT_ARCHIVE) return Object.assign(out, { skipped: 'no cold storage bound' });
  for (const [table, col, extra] of [['snapshots', 'fetched_at', 'AND id NOT IN (SELECT MAX(id) FROM snapshots GROUP BY store, wo)'], ['changes', 'changed_at', '']]) {
    for (let i = 0; i < rounds; i++) {
      const r = await T.prepare(`SELECT * FROM ${table} WHERE ${col} < ? ${extra} ORDER BY id LIMIT ?`).bind(cutoff, chunk).all();
      if (!r.results.length) break;
      if (env.ARCHIVE) {
        const groups = new Map();
        for (const row of r.results) { const k = row.store + '/' + row[col].slice(0, 7); (groups.get(k) || groups.set(k, []).get(k)).push(JSON.stringify(row)); }
        for (const [k, lines] of groups) await env.ARCHIVE.put(`${table}/${k}/${run}-${i}.jsonl.gz`, await gz(lines.join('\n') + '\n'), { httpMetadata: { contentType: 'application/gzip' } });
      }
      const ids = r.results.map((x) => x.id);
      await T.prepare(`DELETE FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).run();
      out[table] += ids.length;
    }
  }
  await T.prepare('DELETE FROM scans WHERE at < ?').bind(cutoff).run();
  await T.prepare('DELETE FROM access_log WHERE at < ?').bind(new Date(Date.now() - LOG_DAYS * 86400000).toISOString()).run();
  return out;
}

// Oct 16, 2026: the local Portal sandbox (sandbox/) once reached this Worker and wrote fake data as store 914.
// Anything that identifies the sandbox is refused before any write: its fake user (id 990001, "Sandbox ..."),
// "Sandbox Store", example.invalid emails, and its store number (999999). Real staff never match.
async function sandboxGuard(req, url) {
  if (req.method === 'OPTIONS') return null;
  const m = url.pathname.match(/^\/v1\/(\d{1,6})\//);
  const isWrite = req.method !== 'GET' || /\/access$/.test(url.pathname);
  if (!isWrite) return null;
  const hit = () => fail(403, 'sandbox data');
  if (m && m[1] === '999999') return hit();
  const sb = (v, p) => typeof v === 'string' && v.trim().toLowerCase().startsWith(p);
  const bad = (k, v) => (/^(byId|by_id|userId|user_id)$/.test(k) && Number(v) === 990001)
    || (/^(by|by_name|completedBy|completed_by|user)$/.test(k) && sb(v, 'sandbox '))
    || (/^(storeName|store_name|name)$/.test(k) && sb(v, 'sandbox store'))
    || (/email/i.test(k) && typeof v === 'string' && v.trim().toLowerCase().endsWith('@example.invalid'));
  for (const [k, v] of url.searchParams) if (bad(k, v)) return hit();
  if (req.method === 'GET') return null;
  let b = null;
  try { b = JSON.parse(await req.clone().text()); } catch (_) { return null; }
  const walk = (x, d) => {
    if (d > 6 || !x || typeof x !== 'object') return false;
    if (Array.isArray(x)) return x.some((y) => walk(y, d + 1));
    return Object.keys(x).some((k) => bad(k, x[k]) || walk(x[k], d + 1));
  };
  return walk(b, 0) ? hit() : null;
}

// ------------------------------------------------------------------ entry
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (env.LIMITER) { const { success } = await env.LIMITER.limit({ key: req.headers.get('cf-connecting-ip') || 'x' }); if (!success) return fail(429, 'slow down'); }
    if (!env.APP_KEY || req.headers.get('x-aethernet-key') !== env.APP_KEY) return fail(403, 'app key required');
    try {
      const sg = await sandboxGuard(req, url);
      if (sg) return sg;
      if (url.pathname === '/v1/tracker/master' && req.method === 'GET') {
        const r = await env.TR.prepare('SELECT public_jwk FROM master_key WHERE id = 1').first();
        return r ? json({ publicJwk: JSON.parse(r.public_jwk) }) : fail(404, 'tracker not set up');
      }
      if (url.pathname.startsWith('/v1/agents/')) return await agentApi(req, env, url);
      const m = url.pathname.match(/^\/v1\/(\d{1,6})\/(tracker|assize)\//);
      if (!m) return fail(404, 'not found');
      const store = Number(m[1]);
      if (!(await allowed(env, store))) return fail(403, 'store has no Aethernet access');
      if (m[2] === 'assize') return await assizeStore(req, env, url, store, { json, fail });
      return await storeApi(req, env, url, store);
    } catch (e) {
      return fail(e.status || 500, e.status ? e.message : 'server error: ' + (e.message || e));
    }
  },
  async scheduled(_ev, env, ctx) {
    ctx.waitUntil(trim(env));
  },
};
