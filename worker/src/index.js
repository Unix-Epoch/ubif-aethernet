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
  Daily cron: drop tags + history for WOs closed more than 7 days ago.
*/
const COLORS = ['purple', 'blue', 'teal', 'green', 'lime', 'yellow', 'orange', 'red', 'grey'];
const MAX_TAGS_PER_WO = 12, MAX_LIST = 40, KEEP_DAYS = 7;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
  'access-control-allow-headers': 'content-type, x-aethernet-key',
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

async function route(req, env) {
  const url = new URL(req.url);
  const m = url.pathname.match(/^\/v1\/(\d{1,6})(?:\/(list|closed|auto)|\/wo\/(\d{5,12})\/(history|tag|untag|push|unmark))?$/);
  if (!m) return fail(404, 'not found');
  const store = Number(m[1]);
  const wo = m[3] ? Number(m[3]) : null;
  const what = m[2] || m[4] || 'all';

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
