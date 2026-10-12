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
    POST /v1/:store/tracker/wo/:wo/gone { by }   Portal answers 404 for it: recorded closed.

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

const KEEP_DAYS = 183, LOG_DAYS = 400, GONE_MIN = 10;
const STALE_MIN = 60, CLAIM_MIN = 5, NEED_MAX = 25, STALE_MAX = 10;
const CLOSED_IDS = new Set([14, 15, 25]); // Sale complete, Cancelled, Repair summary
const MAX = { scan: 400000, wo: 2000000, plain: 400000, sealed: 1800000, card: 8000 };

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
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
export const VALUE_SQL = `(SELECT ROUND(SUM(COALESCE(json_extract(value, '$.netPrice'), json_extract(value, '$.price'), 0) * ABS(COALESCE(json_extract(value, '$.quantity'), 1))), 2)
  FROM json_each(json_extract(plain, '$.cart.items')) WHERE UPPER(COALESCE(json_extract(value, '$.sku'), '')) != 'PCEXEMPT')`;

// ------------------------------------------------------------------ plain-part diff
function flatten(v, path, out) {
  if (v && typeof v === 'object') {
    const keys = Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v);
    if (!keys.length) out[path] = JSON.stringify(v);
    for (const k of keys) flatten(v[k], path ? path + '.' + k : String(k), out);
  } else out[path] = v === undefined ? null : JSON.stringify(v);
  return out;
}
export function diff(before, after) {
  const a = before ? flatten(before, '', {}) : {}, b = flatten(after, '', {});
  const out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) out.push([k, a[k] ?? null, b[k] ?? null]);
  return out;
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
    const known = new Map((await T.prepare('SELECT wo, is_open, api_updated_at, last_detail_at, claimed_until, missing_since FROM workorders WHERE store = ?').bind(store).all()).results.map((r) => [r.wo, r]));
    const need = [], stmts = [];
    let fresh = 0, changed = 0;
    const listed = new Set(rows.map((r) => r.wo));
    const claimed = (k) => k && k.claimed_until && k.claimed_until > at;
    for (const r of rows) {
      const k = known.get(r.wo);
      if (!k) { fresh++; need.push({ wo: r.wo, why: 'new' }); }
      else if (r.updatedAt && r.updatedAt !== k.api_updated_at) { changed++; if (!claimed(k)) need.push({ wo: r.wo, why: 'changed' }); }
      else if (!k.is_open && !claimed(k)) need.push({ wo: r.wo, why: 'reopened' });
      stmts.push(T.prepare(`INSERT INTO workorders (store, wo, store_name, status_id, status_name, program_id, program_name, device, service_outcome, created_at, api_updated_at, is_open, first_seen_at, last_list_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT (store, wo) DO UPDATE SET store_name = COALESCE(excluded.store_name, store_name), status_id = COALESCE(excluded.status_id, status_id),
            status_name = COALESCE(excluded.status_name, status_name), program_id = COALESCE(excluded.program_id, program_id), program_name = COALESCE(excluded.program_name, program_name),
            device = COALESCE(excluded.device, device), service_outcome = COALESCE(excluded.service_outcome, service_outcome), created_at = COALESCE(excluded.created_at, created_at), api_updated_at = COALESCE(excluded.api_updated_at, api_updated_at),
            last_list_seen_at = excluded.last_list_seen_at, missing_since = NULL, gone_seen_at = NULL`)
        .bind(store, r.wo, storeName, r.statusId, r.status, r.programId, r.program, r.device, r.outcome, r.createdAt, r.updatedAt, at, at));
    }
    // Open WOs missing from the list: fetched in full to see whether they really closed. A short or
    // failed list (Waymark saw one report 14 WOs closed at once) is ignored rather than trusted.
    const open = [...known.values()].filter((k) => k.is_open);
    const missing = open.filter((k) => !listed.has(k.wo));
    let note = null;
    // Short = empty, or under half of what we have open (WOs that really closed are fine: each one is
    // checked in Portal before it's recorded closed, so a list can only ever cause extra checks).
    if (!rows.length || (open.length >= 10 && rows.length < open.length / 2)) note = 'list looks short (' + rows.length + ' rows, ' + open.length + ' open on record): missing WOs not checked';
    else for (const k of missing) {
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
    return json({ need: out, more: need.length > out.length, note });
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
      if (!k.missing_since) return json({ ok: true, ignored: 'still in the list' });
      if (!k.gone_seen_at || Date.parse(at) - Date.parse(k.gone_seen_at) < GONE_MIN * 60000) {
        if (!k.gone_seen_at) await T.prepare('UPDATE workorders SET gone_seen_at = ?, claimed_until = NULL WHERE store = ? AND wo = ?').bind(at, store, wo).run();
        else await T.prepare('UPDATE workorders SET claimed_until = NULL WHERE store = ? AND wo = ?').bind(store, wo).run();
        return json({ ok: true, pending: 'confirm later' });
      }
      await T.prepare("UPDATE workorders SET is_open = 0, closed_at = ?, closed_reason = 'gone', claimed_until = NULL, last_detail_at = ? WHERE store = ? AND wo = ?").bind(at, at, store, wo).run();
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
    const statusId = int(w.statusId), closed = CLOSED_IDS.has(statusId);
    const snap = await T.prepare('INSERT INTO snapshots (store, wo, fetched_at, trigger, by_name, hash, plain, sealed) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
      .bind(store, wo, at, clean(b.trigger, 20) || null, by, hash, plainText, b.sealed).first();
    const changes = prev && prev.plain ? diff(JSON.parse(prev.plain), plain) : [];
    const stmts = changes.slice(0, 1000).map(([field, o, n]) => T.prepare('INSERT INTO changes (store, wo, changed_at, field, old, new, snapshot_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(store, wo, at, field.slice(0, 300), o == null ? null : String(o).slice(0, 4000), n == null ? null : String(n).slice(0, 4000), snap.id));
    stmts.push(T.prepare(`INSERT INTO workorders (store, wo, status_id, status_name, program_id, program_name, device, created_at, api_updated_at, is_open, first_seen_at,
          last_detail_at, last_hash, closed_at, closed_reason, cart_total, cart_paid, cart_due, cart_value, service_outcome, plain, card)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (store, wo) DO UPDATE SET status_id = COALESCE(excluded.status_id, status_id), status_name = COALESCE(excluded.status_name, status_name),
          program_id = COALESCE(excluded.program_id, program_id), program_name = COALESCE(excluded.program_name, program_name), device = COALESCE(excluded.device, device),
          created_at = COALESCE(created_at, excluded.created_at), api_updated_at = COALESCE(api_updated_at, excluded.api_updated_at), -- the list's value drives change detection
          is_open = excluded.is_open, last_detail_at = excluded.last_detail_at, last_hash = excluded.last_hash, claimed_until = NULL,
          closed_at = CASE WHEN excluded.is_open = 1 THEN NULL ELSE COALESCE(closed_at, excluded.closed_at) END,
          closed_reason = CASE WHEN excluded.is_open = 1 THEN NULL ELSE COALESCE(closed_reason, excluded.closed_reason) END,
          missing_since = CASE WHEN excluded.is_open = 1 THEN missing_since ELSE NULL END,
          cart_total = excluded.cart_total, cart_paid = excluded.cart_paid, cart_due = excluded.cart_due, cart_value = excluded.cart_value, service_outcome = COALESCE(excluded.service_outcome, service_outcome), plain = excluded.plain, card = COALESCE(excluded.card, card)`)
      .bind(store, wo, statusId, clean(w.status, 60) || null, int(w.programId), clean(w.program, 80) || null, clean(w.device, 80) || null, iso(w.createdAt), iso(w.updatedAt),
        closed ? 0 : 1, at, at, hash, closed ? at : null, closed ? (clean(w.status, 60) || 'closed') : null, num(pay.total), num(pay.amountPaid), num(pay.amountDue), value, clean(w.outcome, 40) || null, plainText, b.card || null));
    for (let i = 0; i < stmts.length; i += 100) await T.batch(stmts.slice(i, i + 100));
    return json({ ok: true, snapshot: snap.id, changes: changes.length });
  }
  return fail(404, 'not found');
}

// ------------------------------------------------------------------ admin side (Access-protected)
const owners = (env) => String(env.TRACKER_OWNERS || '').toLowerCase().split(/[\s,]+/).filter(Boolean);

async function person(env, email) {
  const p = await env.TR.prepare('SELECT * FROM people WHERE email = ?').bind(email).first();
  if (!p) return null;
  return { email: p.email, name: p.name, scope: p.scope, stores: JSON.parse(p.stores || '[]') };
}
const canSee = (p, store) => p && (p.scope === 'all' || p.stores.includes(store));
async function log(env, email, action, store = null, wo = null, detail = null) {
  await env.TR.prepare('INSERT INTO access_log (email, action, store, wo, detail, at) VALUES (?, ?, ?, ?, ?, ?)').bind(email, action, store, wo, detail, now()).run();
}

/*
  GET  /me                       { email, person, keys: [copies], master: publicJwk|null, canInit }
  POST /init { publicJwk, copy } first setup (an owner from TRACKER_OWNERS): master key + their copy
  PUT  /me/keys { keys }         replace your own copies (new passphrase / redeeming an invite)
  GET  /store-keys               full access: every store's { store, publicJwk, wrappedPrivate }
  GET  /stores                   stores you can see, with counts
  GET  /wos?store=&open=&status=&since=&limit=&offset=&detail=1   WO rows (plain + sealed card;
                                 detail=1 adds the latest sealed snapshot, for searching note text)
  GET  /wo/:store/:wo            one WO: row, snapshots (plain + sealed), changes
  GET  /people                   full access: everyone + their key copies' kinds
  POST /people { email, name, scope, stores, keys }        full access: add/update, keys = invite copies
  POST /people/:email/remove     full access
  GET  /log?limit=               full access: who looked at what
*/
export async function trackerAdmin(req, env, url, path, email) {
  const T = env.TR;
  email = String(email || '').toLowerCase();
  if (!email) return fail(403, 'not signed in', false);
  const me = await person(env, email);
  if (me) await T.prepare('UPDATE people SET last_seen_at = ? WHERE email = ?').bind(now(), email).run();
  const master = await T.prepare('SELECT public_jwk FROM master_key WHERE id = 1').first();
  const body = () => readJson(req, 200000);
  const full = me && me.scope === 'all';

  if (req.method === 'GET' && path === '/me') {
    const keys = me ? (await T.prepare('SELECT kind, store, salt, rounds, wrapped, invite FROM person_keys WHERE email = ?').bind(email).all()).results : [];
    return json({ email, person: me, keys, master: master ? JSON.parse(master.public_jwk) : null, canInit: !master && owners(env).includes(email) }, 200, false);
  }
  if (req.method === 'POST' && path === '/init') {
    if (master) return fail(409, 'already set up', false);
    if (!owners(env).includes(email)) return fail(403, 'only an owner can set up the tracker', false);
    const b = await body();
    if (!isJwk(b.publicJwk) || !isCopy(b.copy)) return fail(400, 'publicJwk and copy required', false);
    await T.batch([
      T.prepare('INSERT INTO master_key (id, public_jwk, created_by, created_at) VALUES (1, ?, ?, ?)').bind(JSON.stringify(pubJwk(b.publicJwk)), email, now()),
      T.prepare("INSERT INTO people (email, name, scope, stores, added_by, added_at) VALUES (?, ?, 'all', '[]', ?, ?) ON CONFLICT (email) DO UPDATE SET scope = 'all'").bind(email, clean(b.name, 60) || null, email, now()),
      T.prepare("INSERT OR REPLACE INTO person_keys (email, kind, store, salt, rounds, wrapped, invite, created_by, created_at) VALUES (?, 'master', 0, ?, ?, ?, 0, ?, ?)").bind(email, b.copy.salt, b.copy.rounds, b.copy.wrapped, email, now()),
    ]);
    await log(env, email, 'init');
    return json({ ok: true }, 200, false);
  }
  if (!me) return fail(403, 'not on the tracker list; ask an admin to add you', false);

  if (req.method === 'PUT' && path === '/me/keys') {
    const b = await body();
    if (!Array.isArray(b.keys) || !b.keys.length || b.keys.length > 500) return fail(400, 'keys required', false);
    const stmts = [];
    for (const k of b.keys) {
      const store = k.kind === 'store' ? int(k.store) : 0;
      if (!isCopy(k) || !['master', 'store'].includes(k.kind) || (k.kind === 'master' && !full) || (k.kind === 'store' && !canSee(me, store))) return fail(400, 'bad key copy', false);
      stmts.push(T.prepare('INSERT OR REPLACE INTO person_keys (email, kind, store, salt, rounds, wrapped, invite, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)')
        .bind(email, k.kind, store, k.salt, k.rounds, k.wrapped, email, now()));
    }
    await T.batch(stmts);
    await log(env, email, 'keys', null, null, b.keys.length + ' copies');
    return json({ ok: true }, 200, false);
  }
  if (req.method === 'GET' && path === '/store-keys') {
    if (!full) return fail(403, 'full access only', false);
    const r = await T.prepare('SELECT store, public_jwk, wrapped_private FROM store_keys ORDER BY store').all();
    return json({ keys: r.results.map((k) => ({ store: k.store, publicJwk: JSON.parse(k.public_jwk), wrappedPrivate: k.wrapped_private })) }, 200, false);
  }
  if (req.method === 'GET' && path === '/stores') {
    const r = await T.prepare(`SELECT store, MAX(store_name) AS name, COUNT(*) AS total, SUM(is_open) AS open, SUM(CASE WHEN is_open = 1 AND status_id = 13 THEN 1 ELSE 0 END) AS rfp,
        SUM(CASE WHEN is_open = 1 AND status_id = 13 THEN COALESCE(cart_due, 0) ELSE 0 END) AS rfp_due,
        SUM(CASE WHEN is_open = 1 AND status_id = 13 THEN COALESCE(cart_value, 0) ELSE 0 END) AS rfp_value,
        SUM(CASE WHEN is_open = 1 AND status_id = 13 AND service_outcome = 'Completed' THEN 1 ELSE 0 END) AS rfp_complete,
        SUM(CASE WHEN is_open = 1 AND status_id = 13 AND service_outcome = 'Completed' THEN COALESCE(cart_value, 0) ELSE 0 END) AS rfp_complete_value,
        SUM(CASE WHEN is_open = 1 AND status_id = 13 AND COALESCE(service_outcome, '') != 'Completed' THEN 1 ELSE 0 END) AS rfp_other,
        SUM(CASE WHEN is_open = 1 AND status_id = 13 AND COALESCE(service_outcome, '') != 'Completed' THEN COALESCE(cart_value, 0) ELSE 0 END) AS rfp_other_value, MAX(last_detail_at) AS last_detail_at FROM workorders GROUP BY store ORDER BY store`).all();
    const scans = new Map((await T.prepare('SELECT store, MAX(at) AS at FROM scans GROUP BY store').all()).results.map((s) => [s.store, s.at]));
    return json({ stores: r.results.filter((s) => canSee(me, s.store)).map((s) => Object.assign(s, { last_scan_at: scans.get(s.store) || null })) }, 200, false);
  }
  if (req.method === 'GET' && path === '/wos') {
    const q = url.searchParams, where = [], args = [];
    const store = q.get('store') ? int(q.get('store')) : null;
    if (store != null) { if (!canSee(me, store)) return fail(403, 'not your store', false); where.push('store = ?'); args.push(store); }
    else if (!full) { if (!me.stores.length) return json({ wos: [] }, 200, false); where.push('store IN (' + me.stores.map(() => '?').join(',') + ')'); args.push(...me.stores); }
    if (q.get('open') === '1') where.push('is_open = 1'); else if (q.get('open') === '0') where.push('is_open = 0');
    if (q.get('status')) { where.push('status_id = ?'); args.push(int(q.get('status'))); }
    if (q.get('outcome') === 'complete') where.push("service_outcome = 'Completed'"); else if (q.get('outcome') === 'other') where.push("COALESCE(service_outcome, '') != 'Completed'");
    if (q.get('since')) { where.push('COALESCE(api_updated_at, first_seen_at) >= ?'); args.push(clean(q.get('since'), 40)); }
    const limit = Math.min(int(q.get('limit')) || 500, 5000), offset = int(q.get('offset')) || 0;
    const r = await T.prepare(`SELECT store, wo, store_name, status_id, status_name, program_id, program_name, device, created_at, api_updated_at, is_open, first_seen_at,
        last_detail_at, closed_at, closed_reason, cart_total, cart_paid, cart_due, cart_value, service_outcome, card${q.get('detail') === '1' ? ', (SELECT sealed FROM snapshots s WHERE s.store = workorders.store AND s.wo = workorders.wo ORDER BY id DESC LIMIT 1) AS sealed' : ''} FROM workorders ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY COALESCE(api_updated_at, first_seen_at) DESC LIMIT ? OFFSET ?`).bind(...args, limit, offset).all();
    await log(env, email, 'list', store, null, url.search.slice(0, 200));
    return json({ wos: r.results }, 200, false);
  }
  const om = path.match(/^\/wo\/(\d{1,6})\/(\d{1,12})$/);
  if (req.method === 'GET' && om) {
    const store = Number(om[1]), wo = Number(om[2]);
    if (!canSee(me, store)) return fail(403, 'not your store', false);
    const [row, snaps, chg] = await T.batch([
      T.prepare('SELECT * FROM workorders WHERE store = ? AND wo = ?').bind(store, wo),
      T.prepare('SELECT id, fetched_at, trigger, by_name, hash, plain, sealed FROM snapshots WHERE store = ? AND wo = ? ORDER BY id DESC LIMIT 200').bind(store, wo),
      T.prepare('SELECT changed_at, field, old, new, snapshot_id FROM changes WHERE store = ? AND wo = ? ORDER BY id DESC LIMIT 2000').bind(store, wo),
    ]);
    if (!row.results.length) return fail(404, 'no such work order', false);
    await log(env, email, 'open', store, wo);
    return json({ wo: row.results[0], snapshots: snaps.results, changes: chg.results }, 200, false);
  }
  if (!full) return fail(403, 'full access only', false);
  if (req.method === 'GET' && path === '/people') {
    const [p, k] = await T.batch([T.prepare('SELECT * FROM people ORDER BY email'), T.prepare('SELECT email, kind, store, invite FROM person_keys')]);
    return json({ people: p.results.map((x) => Object.assign(x, { stores: JSON.parse(x.stores || '[]'), keys: k.results.filter((c) => c.email === x.email) })) }, 200, false);
  }
  if (req.method === 'POST' && path === '/people') {
    const b = await body();
    const who = String(b.email || '').trim().toLowerCase(), scope = b.scope;
    if (!EMAIL_RE.test(who) || !['all', 'stores'].includes(scope)) return fail(400, 'email and scope required', false);
    const stores = scope === 'stores' ? [...new Set((b.stores || []).map(int).filter((s) => s && s < 1000000))] : [];
    if (scope === 'stores' && !stores.length) return fail(400, 'pick at least one store', false);
    const stmts = [T.prepare('INSERT INTO people (email, name, scope, stores, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (email) DO UPDATE SET name = COALESCE(excluded.name, name), scope = excluded.scope, stores = excluded.stores')
      .bind(who, clean(b.name, 60) || null, scope, JSON.stringify(stores), email, now())];
    // A new invite replaces all their copies (they set a passphrase again); otherwise copies they no longer qualify for go.
    if ((b.keys || []).length) stmts.push(T.prepare('DELETE FROM person_keys WHERE email = ?').bind(who));
    if (scope === 'stores') stmts.push(T.prepare("DELETE FROM person_keys WHERE email = ? AND (kind = 'master' OR store NOT IN (" + stores.map(() => '?').join(',') + '))').bind(who, ...stores));
    for (const k of b.keys || []) {
      const st = k.kind === 'store' ? int(k.store) : 0;
      if (!isCopy(k) || !['master', 'store'].includes(k.kind) || (k.kind === 'master' && scope !== 'all') || (k.kind === 'store' && scope === 'stores' && !stores.includes(st))) return fail(400, 'bad key copy', false);
      stmts.push(T.prepare('INSERT OR REPLACE INTO person_keys (email, kind, store, salt, rounds, wrapped, invite, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)')
        .bind(who, k.kind, st, k.salt, k.rounds, k.wrapped, email, now()));
    }
    await T.batch(stmts);
    await log(env, email, 'person:add', null, null, who + ' ' + scope + (stores.length ? ' ' + stores.join(',') : ''));
    return json({ ok: true }, 200, false);
  }
  const rm = path.match(/^\/people\/([^/]+)\/remove$/);
  if (req.method === 'POST' && rm) {
    const who = decodeURIComponent(rm[1]).toLowerCase();
    const others = await T.prepare("SELECT COUNT(*) AS n FROM people WHERE scope = 'all' AND email != ?").bind(who).first();
    const target = await person(env, who);
    if (target && target.scope === 'all' && !others.n) return fail(409, "can't remove the last person with full access", false);
    await T.batch([T.prepare('DELETE FROM person_keys WHERE email = ?').bind(who), T.prepare('DELETE FROM people WHERE email = ?').bind(who)]);
    await log(env, email, 'person:remove', null, null, who);
    return json({ ok: true }, 200, false);
  }
  if (req.method === 'GET' && path === '/log') {
    const r = await T.prepare('SELECT * FROM access_log ORDER BY id DESC LIMIT ?').bind(Math.min(int(url.searchParams.get('limit')) || 200, 2000)).all();
    return json({ log: r.results }, 200, false);
  }
  return fail(404, 'not found', false);
}

// ------------------------------------------------------------------ retention
async function gz(text) {
  return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
}
// Moves rows older than the cutoff to R2 (when bound) in chunks, then deletes them.
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

// ------------------------------------------------------------------ entry
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (env.LIMITER) { const { success } = await env.LIMITER.limit({ key: req.headers.get('cf-connecting-ip') || 'x' }); if (!success) return fail(429, 'slow down'); }
    if (!env.APP_KEY || req.headers.get('x-aethernet-key') !== env.APP_KEY) return fail(403, 'app key required');
    try {
      if (url.pathname === '/v1/tracker/master' && req.method === 'GET') {
        const r = await env.TR.prepare('SELECT public_jwk FROM master_key WHERE id = 1').first();
        return r ? json({ publicJwk: JSON.parse(r.public_jwk) }) : fail(404, 'tracker not set up');
      }
      const m = url.pathname.match(/^\/v1\/(\d{1,6})\/tracker\//);
      if (!m) return fail(404, 'not found');
      const store = Number(m[1]);
      if (!(await allowed(env, store))) return fail(403, 'store has no Aethernet access');
      return await storeApi(req, env, url, store);
    } catch (e) {
      return fail(e.status || 500, e.status ? e.message : 'server error: ' + (e.message || e));
    }
  },
  async scheduled(_ev, env, ctx) {
    ctx.waitUntil(trim(env));
  },
};
