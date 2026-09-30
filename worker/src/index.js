/*
  Waymark API — shared work-order tags for Aethernet, one set per Portal store.

  Trust model (see README): requests carry Aethernet's app key, which ships
  inside the userscript, so it only keeps random traffic out. This Worker
  can't see Portal logins, so who-did-what (by/byId) and "may edit the tag
  list" are asserted by Aethernet, not verified here. Fine for tags; don't
  put anything sensitive behind it.

    GET  /v1/:store                     managed list + every tagged WO
    GET  /v1/:store/wo/:wo/history      that WO's tag history (newest first)
    POST /v1/:store/wo/:wo/tag          { tag, by, byId }        add
    POST /v1/:store/wo/:wo/untag        { tag, by, byId }        remove
    PUT  /v1/:store/list                { list: [{name,color}], by, byId }
    POST /v1/:store/closed              { wos: [id…] }           seen closed
    POST /v1/:store/auto                { marks: [{wo, due}] }   Auto-Waymark new RFP WOs (existing/removed ignored)
    POST /v1/:store/wo/:wo/push         { due, by, byId }        move a mark later (never earlier)
    POST /v1/:store/wo/:wo/unmark       { by, byId }             remove a mark (stays removed)
    POST /v1/:store/feedback            { kind, text, version, page, browser, diag, by, byId, storeName }
    POST /v1/:store/usage               { day, counts: {feature: n}, by, byId, storeName }
  Admin (x-aethernet-admin = the ADMIN_KEY secret; never shipped in the script):
    GET  /v1/admin/ping
    GET  /v1/admin/feedback?status=new|planned|fixed|wontfix|all
    POST /v1/admin/feedback/:id         { status?, note? }
    GET  /v1/admin/usage?days=30
    GET  /v1/admin/stores                                        allowed stores + stores waiting
    POST /v1/admin/stores               { store, name, by }      grant access
    POST /v1/admin/stores/:store/remove                          revoke access
  Store access: GET /v1/:store/access?name=&user= answers { allowed } (and
  records the store as seen). Every other /v1/:store/… call is refused (403)
  for stores without access.
  Daily cron: drop tags + history for WOs closed more than 7 days ago; usage older than 180 days.
*/
const COLORS = ['purple', 'blue', 'teal', 'green', 'lime', 'yellow', 'orange', 'red', 'grey'];
const MAX_TAGS_PER_WO = 12, MAX_LIST = 40, KEEP_DAYS = 7;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = ['bug', 'idea'], STATUSES = ['new', 'planned', 'fixed', 'wontfix'];
const FEATURE_RE = /^[a-zA-Z]{1,24}(:[a-zA-Z-]{1,24})?$/;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
  'access-control-allow-headers': 'content-type, x-aethernet-key, x-aethernet-admin',
  'access-control-max-age': '86400',
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } });
const fail = (status, error) => json({ error }, status);
const now = () => new Date().toISOString();

// Plain text only: trim, collapse whitespace, drop control characters, cap length.
const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const tagName = (v) => clean(v, 32);
const who = (b) => ({ name: clean(b.by, 60) || 'Someone', id: Number.isInteger(b.byId) ? b.byId : null });

async function body(req) {
  const text = await req.text();
  if (text.length > 16000) throw new Error('too large');
  return text ? JSON.parse(text) : {};
}

async function logHistory(env, store, wo, action, tag, detail, by) {
  await env.DB.prepare('INSERT INTO history (store, wo, action, tag, detail, by_name, by_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(store, wo, action, tag, detail, by.name, by.id, now()).run();
}

async function admin(req, env, url) {
  if (!env.ADMIN_KEY || req.headers.get('x-aethernet-admin') !== env.ADMIN_KEY) return fail(403, 'admin key required');
  const path = url.pathname.replace(/^\/v1\/admin/, '');
  if (req.method === 'GET' && path === '/ping') return json({ ok: true });
  if (req.method === 'GET' && path === '/feedback') {
    const st = url.searchParams.get('status') || 'all';
    const q = STATUSES.includes(st)
      ? env.DB.prepare('SELECT * FROM feedback WHERE status = ? ORDER BY id DESC LIMIT 500').bind(st)
      : env.DB.prepare('SELECT * FROM feedback ORDER BY id DESC LIMIT 500');
    const counts = await env.DB.prepare('SELECT status, COUNT(*) AS n FROM feedback GROUP BY status').all();
    return json({ feedback: (await q.all()).results, counts: Object.fromEntries(counts.results.map((r) => [r.status, r.n])) });
  }
  const fm = path.match(/^\/feedback\/(\d+)$/);
  if (req.method === 'POST' && fm) {
    const b = await body(req);
    const row = await env.DB.prepare('SELECT status, note FROM feedback WHERE id = ?').bind(Number(fm[1])).first();
    if (!row) return fail(404, 'no such report');
    const status = STATUSES.includes(b.status) ? b.status : row.status;
    const note = typeof b.note === 'string' ? clean(b.note, 1000) : row.note;
    await env.DB.prepare('UPDATE feedback SET status = ?, note = ?, updated_at = ? WHERE id = ?').bind(status, note, now(), Number(fm[1])).run();
    return json({ ok: true, status, note });
  }
  if (req.method === 'GET' && path === '/stores') {
    const [allowed, seen] = await env.DB.batch([
      env.DB.prepare('SELECT a.store, COALESCE(a.name, s.name) AS name, a.added_by, a.added_at, s.last_at, s.loads FROM store_access a LEFT JOIN store_seen s ON s.store = a.store ORDER BY a.store'),
      env.DB.prepare('SELECT s.* FROM store_seen s WHERE s.store NOT IN (SELECT store FROM store_access) ORDER BY s.last_at DESC LIMIT 200'),
    ]);
    return json({ allowed: allowed.results, waiting: seen.results });
  }
  if (req.method === 'POST' && path === '/stores') {
    const b = await body(req);
    const store = Number(b.store);
    if (!Number.isInteger(store) || store <= 0 || store > 999999) return fail(400, 'store number required');
    await env.DB.prepare('INSERT INTO store_access (store, name, added_by, added_at) VALUES (?, ?, ?, ?) ON CONFLICT (store) DO UPDATE SET name = COALESCE(excluded.name, name)')
      .bind(store, clean(b.name, 80) || null, clean(b.by, 60) || null, now()).run();
    accessCache.delete(store);
    return json({ ok: true });
  }
  const rm = path.match(/^\/stores\/(\d{1,6})\/remove$/);
  if (req.method === 'POST' && rm) {
    await env.DB.prepare('DELETE FROM store_access WHERE store = ?').bind(Number(rm[1])).run();
    accessCache.delete(Number(rm[1]));
    return json({ ok: true });
  }
  if (req.method === 'GET' && path === '/usage') {
    const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));
    const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
    const r = await env.DB.prepare('SELECT day, store, store_name, user_id, user_name, feature, count FROM usage WHERE day >= ? ORDER BY day').bind(since).all();
    return json({ since, rows: r.results });
  }
  return fail(404, 'not found');
}

// Store access, cached briefly per Worker instance (changes apply within a minute).
const accessCache = new Map();
async function allowed(env, store) {
  const c = accessCache.get(store);
  if (c && Date.now() - c.at < 60000) return c.ok;
  const ok = !!(await env.DB.prepare('SELECT 1 FROM store_access WHERE store = ?').bind(store).first());
  accessCache.set(store, { ok, at: Date.now() });
  return ok;
}

async function route(req, env) {
  const url = new URL(req.url);
  if (url.pathname.startsWith('/v1/admin/')) return admin(req, env, url);
  const m = url.pathname.match(/^\/v1\/(\d{1,6})(?:\/(list|closed|auto|feedback|usage|access)|\/wo\/(\d{5,12})\/(history|tag|untag|push|unmark))?$/);
  if (!m) return fail(404, 'not found');
  const store = Number(m[1]);
  const wo = m[3] ? Number(m[3]) : null;
  const what = m[2] || m[4] || 'all';

  if (req.method === 'GET' && what === 'access') {
    const name = clean(url.searchParams.get('name'), 80) || null, user = clean(url.searchParams.get('user'), 60) || null, t = now();
    await env.DB.prepare('INSERT INTO store_seen (store, name, first_at, last_at, loads, last_user) VALUES (?, ?, ?, ?, 1, ?) ' +
      'ON CONFLICT (store) DO UPDATE SET name = COALESCE(excluded.name, name), last_at = excluded.last_at, loads = loads + 1, last_user = COALESCE(excluded.last_user, last_user)')
      .bind(store, name, t, t, user).run();
    return json({ allowed: await allowed(env, store) });
  }
  if (!(await allowed(env, store))) return fail(403, 'this store does not have access to Aethernet');

  if (req.method === 'GET' && what === 'all') {
    const [list, tags, marks] = await env.DB.batch([
      env.DB.prepare('SELECT name, color FROM list WHERE store = ? ORDER BY pos').bind(store),
      env.DB.prepare('SELECT wo, tag, by_name AS by, at FROM wo_tags WHERE store = ? ORDER BY at').bind(store),
      env.DB.prepare('SELECT wo, due, created_at AS at FROM auto_marks WHERE store = ? AND removed_at IS NULL').bind(store),
    ]);
    const byWo = {}, auto = {};
    for (const r of tags.results) (byWo[r.wo] = byWo[r.wo] || []).push({ tag: r.tag, by: r.by, at: r.at });
    for (const r of marks.results) auto[r.wo] = { due: r.due, at: r.at };
    return json({ list: list.results, tags: byWo, auto });
  }

  if (req.method === 'GET' && what === 'history') {
    const r = await env.DB.prepare('SELECT action, tag, detail, by_name AS by, at FROM history WHERE store = ? AND wo = ? ORDER BY id DESC LIMIT 50')
      .bind(store, wo).all();
    return json({ history: r.results });
  }

  if (req.method === 'POST' && (what === 'tag' || what === 'untag')) {
    const b = await body(req);
    const tag = tagName(b.tag);
    if (!tag) return fail(400, 'tag required');
    const by = who(b);
    if (what === 'tag') {
      const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM wo_tags WHERE store = ? AND wo = ?').bind(store, wo).first();
      if (n >= MAX_TAGS_PER_WO) return fail(400, 'too many tags on this work order');
      const r = await env.DB.prepare('INSERT OR IGNORE INTO wo_tags (store, wo, tag, by_name, by_id, at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(store, wo, tag, by.name, by.id, now()).run();
      if (r.meta.changes) await logHistory(env, store, wo, 'add', tag, null, by);
      await env.DB.prepare('DELETE FROM wo_closed WHERE store = ? AND wo = ?').bind(store, wo).run(); // tagged again = still in play
    } else {
      const r = await env.DB.prepare('DELETE FROM wo_tags WHERE store = ? AND wo = ? AND tag = ?').bind(store, wo, tag).run();
      if (r.meta.changes) await logHistory(env, store, wo, 'remove', tag, null, by);
    }
    const tags = await env.DB.prepare('SELECT tag, by_name AS by, at FROM wo_tags WHERE store = ? AND wo = ? ORDER BY at').bind(store, wo).all();
    return json({ tags: tags.results });
  }

  if (req.method === 'POST' && what === 'auto') {
    const b = await body(req);
    const marks = (Array.isArray(b.marks) ? b.marks : []).filter((x) => x && Number.isInteger(x.wo) && x.wo > 0 && DATE_RE.test(x.due)).slice(0, 500);
    const created = [];
    for (const x of marks) {
      const r = await env.DB.prepare('INSERT OR IGNORE INTO auto_marks (store, wo, due, created_at) VALUES (?, ?, ?, ?)').bind(store, x.wo, x.due, now()).run();
      if (r.meta.changes) { created.push(x.wo); await logHistory(env, store, x.wo, 'auto', null, x.due, { name: 'Auto-Waymark', id: null }); }
    }
    return json({ created });
  }

  if (req.method === 'POST' && (what === 'push' || what === 'unmark')) {
    const b = await body(req);
    const by = who(b);
    const cur = await env.DB.prepare('SELECT due FROM auto_marks WHERE store = ? AND wo = ? AND removed_at IS NULL').bind(store, wo).first();
    if (!cur) return fail(404, 'no Auto-Waymark on this work order');
    if (what === 'push') {
      if (!DATE_RE.test(b.due || '') || b.due <= cur.due) return fail(400, 'Auto-Waymarks can only move later');
      await env.DB.prepare('UPDATE auto_marks SET due = ? WHERE store = ? AND wo = ?').bind(b.due, store, wo).run();
      await logHistory(env, store, wo, 'push', null, cur.due + ' → ' + b.due, by);
      return json({ auto: { due: b.due } });
    }
    await env.DB.prepare('UPDATE auto_marks SET removed_at = ? WHERE store = ? AND wo = ?').bind(now(), store, wo).run();
    await logHistory(env, store, wo, 'unmark', null, cur.due, by);
    return json({ auto: null });
  }

  if (req.method === 'POST' && what === 'feedback') {
    const b = await body(req);
    const text = typeof b.text === 'string' ? b.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 4000) : '';
    if (!KINDS.includes(b.kind) || text.length < 3) return fail(400, 'kind and text required');
    const by = who(b);
    let diag = null;
    try { diag = b.diag ? JSON.stringify(b.diag).slice(0, 6000) : null; } catch (_) {}
    const t = now();
    const r = await env.DB.prepare('INSERT INTO feedback (store, store_name, user_id, user_name, kind, text, version, page, browser, diag, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(store, clean(b.storeName, 80), by.id, by.name, b.kind, text, clean(b.version, 20), clean(b.page, 200), clean(b.browser, 80), diag, t, t).run();
    return json({ ok: true, id: r.meta.last_row_id });
  }

  if (req.method === 'POST' && what === 'usage') {
    const b = await body(req);
    const by = who(b);
    if (by.id === null || !DATE_RE.test(b.day || '')) return fail(400, 'day and byId required');
    const counts = Object.entries(b.counts && typeof b.counts === 'object' ? b.counts : {})
      .filter(([f, n]) => FEATURE_RE.test(f) && Number.isInteger(n) && n > 0 && n <= 10000).slice(0, 60);
    if (counts.length) {
      await env.DB.batch(counts.map(([f, n]) => env.DB.prepare(
        'INSERT INTO usage (day, store, store_name, user_id, user_name, feature, count) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT (day, store, user_id, feature) DO UPDATE SET count = count + excluded.count, user_name = excluded.user_name, store_name = excluded.store_name')
        .bind(b.day, store, clean(b.storeName, 80), by.id, by.name, f, n)));
    }
    return json({ ok: true });
  }

  if (req.method === 'PUT' && what === 'list') {
    const b = await body(req);
    const by = who(b);
    const seen = new Set();
    const list = (Array.isArray(b.list) ? b.list : []).map((t) => ({ name: tagName(t && t.name), color: COLORS.includes(t && t.color) ? t.color : 'grey' }))
      .filter((t) => t.name && !seen.has(t.name.toLowerCase()) && seen.add(t.name.toLowerCase())).slice(0, MAX_LIST);
    const old = (await env.DB.prepare('SELECT name, color FROM list WHERE store = ? ORDER BY pos').bind(store).all()).results;
    const oldNames = new Set(old.map((t) => t.name)), newNames = new Set(list.map((t) => t.name));
    const added = list.filter((t) => !oldNames.has(t.name)).map((t) => t.name);
    const removed = old.filter((t) => !newNames.has(t.name)).map((t) => t.name);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM list WHERE store = ?').bind(store),
      ...list.map((t, i) => env.DB.prepare('INSERT INTO list (store, name, color, pos) VALUES (?, ?, ?, ?)').bind(store, t.name, t.color, i)),
    ]);
    const detail = [added.length && 'added ' + added.join(', '), removed.length && 'removed ' + removed.join(', ')].filter(Boolean).join('; ') || 'reordered or recoloured';
    await logHistory(env, store, null, 'list', null, detail, by);
    return json({ list });
  }

  if (req.method === 'POST' && what === 'closed') {
    const b = await body(req);
    const wos = (Array.isArray(b.wos) ? b.wos : []).filter((w) => Number.isInteger(w) && w > 0).slice(0, 500);
    if (wos.length) {
      await env.DB.batch(wos.map((w) => env.DB.prepare(
        'INSERT OR IGNORE INTO wo_closed (store, wo, closed_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM wo_tags WHERE store = ? AND wo = ?) OR EXISTS (SELECT 1 FROM auto_marks WHERE store = ? AND wo = ?)')
        .bind(store, w, now(), store, w, store, w)));
    }
    return json({ ok: true });
  }

  return fail(405, 'method not allowed');
}

async function cleanup(env) {
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString();
  const expired = 'SELECT store, wo FROM wo_closed WHERE closed_at < ?';
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM wo_tags WHERE (store, wo) IN (${expired})`).bind(cutoff),
    env.DB.prepare(`DELETE FROM history WHERE wo IS NOT NULL AND (store, wo) IN (${expired})`).bind(cutoff),
    env.DB.prepare(`DELETE FROM auto_marks WHERE (store, wo) IN (${expired})`).bind(cutoff),
    env.DB.prepare('DELETE FROM wo_closed WHERE closed_at < ?').bind(cutoff),
    env.DB.prepare('DELETE FROM usage WHERE day < ?').bind(new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10)),
    // List-change history: keep 90 days.
    env.DB.prepare('DELETE FROM history WHERE wo IS NULL AND at < ?').bind(new Date(Date.now() - 90 * 86400000).toISOString()),
  ]);
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.headers.get('x-aethernet-key') !== env.APP_KEY) return fail(401, 'missing or wrong app key');
    if (env.LIMITER) {
      const { success } = await env.LIMITER.limit({ key: req.headers.get('cf-connecting-ip') || 'anon' });
      if (!success) return fail(429, 'slow down');
    }
    try {
      return await route(req, env);
    } catch (e) {
      return fail(e instanceof SyntaxError || e.message === 'too large' ? 400 : 500, e instanceof SyntaxError ? 'bad JSON' : e.message);
    }
  },
  async scheduled(_event, env) {
    await cleanup(env);
  },
};
