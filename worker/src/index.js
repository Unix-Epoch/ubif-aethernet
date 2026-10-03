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
    POST /v1/:store/closed              { wos: [id…] }           seen closed (confirmed in Portal by the client)
    POST /v1/:store/open                { wos: [id…] }           seen open again: no longer counted as closed (undoes a wrong closed report)
    POST /v1/:store/auto                { marks: [{wo, due, kind}] }   Auto-Waymark WOs (kind: rfp | callback; existing/removed ignored)
    POST /v1/:store/wo/:wo/end          { by, byId, reason }     the WO left its mark's status: the mark is deleted (not
                                        "removed"), so it comes back fresh if the WO returns to Ready for pickup / Awaiting callback
    POST /v1/:store/wo/:wo/push         { due, by, byId }        move a mark later (never earlier)
    POST /v1/:store/wo/:wo/unmark       { by, byId }             remove a mark (stays removed)
    POST /v1/:store/feedback            { kind, text, version, page, browser, diag, by, byId, storeName }
    POST /v1/:store/usage               { day, counts: {feature: n}, by, byId, storeName }
    GET  /v1/fixed?version=2.22.0       bug reports quoted as fixed in that version: [{id, kind, quote, credit, store}]
                                        (public text: it goes in the patch notes; build.py pulls it in)
    GET  /v1/:store/links?since=YYYY-MM-DD                       Divination's manual cleaning links since that day
    POST /v1/:store/links               { day, device, parent, by, byId }   link a phone's cleanings that day to WO `parent`
    POST /v1/:store/links/remove        { day, device, by, byId }           undo
  Admin (x-aethernet-admin = the ADMIN_KEY secret; never shipped in the script):
    GET  /v1/admin/ping
    GET  /v1/admin/feedback?status=new|planned|fixed|wontfix|all
    POST /v1/admin/feedback/:id         { status?, note?, fixedIn?, quote?, credit? }  fixedIn + quote = quoted in that
                                        version's patch notes (status becomes fixed); fixedIn "" = take it out
    GET  /v1/admin/usage?days=30
    GET  /v1/admin/stores                                        allowed stores + stores waiting
    POST /v1/admin/stores               { store, name, by }      grant access
    POST /v1/admin/stores/:store/remove                          revoke access
    GET  /v1/admin/auto-rules                                    Auto-Waymark rules' states
    POST /v1/admin/auto-rules           { rule, state }          off | staged (new WOs only) | live (backfill too)
  Store access: GET /v1/:store/access?name=&user= answers { allowed } (and
  records the store as seen). Every other /v1/:store/… call is refused (403)
  for stores without access.
  Daily cron: drop tags + history for WOs closed more than 7 days ago; usage older than 180 days;
  cleaning links older than 120 days.
*/
const COLORS = ['purple', 'blue', 'teal', 'green', 'lime', 'yellow', 'orange', 'red', 'grey'];
const MAX_TAGS_PER_WO = 12, MAX_LIST = 40, KEEP_DAYS = 7;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = ['bug', 'idea'], STATUSES = ['new', 'planned', 'fixed', 'wontfix'];
const FEATURE_RE = /^[a-zA-Z]{1,24}(:[a-zA-Z-]{1,24})?$/;
const DEVICE_RE = /^[A-Za-z0-9:_-]{1,40}$/; // a cleaning's phone: its IMEI, or Aethernet's own key for one without
const LINK_DAYS = 120;
const MARK_KINDS = ['rfp', 'callback'], RULE_STATES = ['off', 'staged', 'live'];
const VERSION_RE = /^\d+\.\d+\.\d+$/;

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
  return adminApi(req, env, url, url.pathname.replace(/^\/v1\/admin/, ''));
}

/*
  The admin routes, shared by this Worker (behind the admin key, for the in-Portal
  panel) and the admin site (admin-worker/, behind Cloudflare Access). path: "/feedback", …
*/
export async function adminApi(req, env, url, path) {
  if (req.method === 'GET' && path === '/ping') return json({ ok: true });
  // One store's Aethernet data (admin site → Store data): its tag list, tags, Auto-Waymarks, which WOs Aethernet saw close, manual cleaning links.
  const sd = path.match(/^\/store\/(\d{1,6})$/);
  if (req.method === 'GET' && sd) {
    const store = Number(sd[1]), since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const [name, list, tags, marks, closed, links] = await env.DB.batch([
      env.DB.prepare('SELECT COALESCE(a.name, s.name) AS name FROM (SELECT ? AS store) x LEFT JOIN store_access a ON a.store = x.store LEFT JOIN store_seen s ON s.store = x.store').bind(store),
      env.DB.prepare('SELECT name, color FROM list WHERE store = ? ORDER BY pos').bind(store),
      env.DB.prepare('SELECT wo, tag, by_name AS by, at FROM wo_tags WHERE store = ? ORDER BY at DESC').bind(store),
      env.DB.prepare('SELECT wo, due, kind, created_at AS at, removed_at AS removedAt FROM auto_marks WHERE store = ? ORDER BY due').bind(store),
      env.DB.prepare('SELECT wo, closed_at AS at FROM wo_closed WHERE store = ?').bind(store),
      env.DB.prepare('SELECT day, device, parent, by_name AS by, at FROM cleaning_links WHERE store = ? AND day >= ? ORDER BY day DESC, at DESC').bind(store, since),
    ]);
    return json({ store, name: (name.results[0] || {}).name || null, list: list.results, tags: tags.results,
      marks: marks.results.map((m) => Object.assign(m, { kind: m.kind || 'rfp' })), closed: closed.results, links: links.results });
  }
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
    const row = await env.DB.prepare('SELECT status, note, fixed_in, quote, credit FROM feedback WHERE id = ?').bind(Number(fm[1])).first();
    if (!row) return fail(404, 'no such report');
    const status = STATUSES.includes(b.status) ? b.status : row.status;
    const note = typeof b.note === 'string' ? clean(b.note, 1000) : row.note;
    // Quoting a report in the patch notes: the version it's fixed in, the quote, and who's credited.
    let fixedIn = row.fixed_in ?? null, quote = row.quote ?? null, credit = row.credit ?? null, st = status;
    if (typeof b.fixedIn === 'string') {
      if (b.fixedIn === '') fixedIn = null;
      else if (VERSION_RE.test(b.fixedIn)) { fixedIn = b.fixedIn; st = 'fixed'; }
      else return fail(400, 'fixedIn must be a version like 2.22.0');
    }
    if (typeof b.quote === 'string') quote = clean(b.quote, 400) || null;
    if (typeof b.credit === 'string') credit = clean(b.credit, 60) || null;
    if (fixedIn && !quote) return fail(400, 'a quote is needed to put a report in the patch notes');
    await env.DB.prepare('UPDATE feedback SET status = ?, note = ?, fixed_in = ?, quote = ?, credit = ?, updated_at = ? WHERE id = ?')
      .bind(st, note, fixedIn, quote, credit, now(), Number(fm[1])).run();
    return json({ ok: true, status: st, note, fixedIn, quote, credit });
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
  if (path === '/auto-rules') {
    if (req.method === 'POST') {
      const b = await body(req);
      const rule = clean(b.rule, 24), state = b.state;
      if (!/^[a-z-]{2,24}$/.test(rule) || !RULE_STATES.includes(state)) return fail(400, 'rule and state (off | staged | live) required');
      const t = now();
      await env.DB.prepare('INSERT INTO auto_rules (rule, state, staged_at, live_at) VALUES (?, ?, ?, ?) ON CONFLICT (rule) DO UPDATE SET state = excluded.state, ' +
        'staged_at = COALESCE(auto_rules.staged_at, excluded.staged_at), live_at = CASE WHEN excluded.state = \'live\' THEN COALESCE(auto_rules.live_at, excluded.live_at) ELSE auto_rules.live_at END')
        .bind(rule, state, state === 'off' ? null : t, state === 'live' ? t : null).run();
    }
    const r = await env.DB.prepare('SELECT rule, state, staged_at AS stagedAt, live_at AS liveAt FROM auto_rules ORDER BY rule').all();
    return json({ rules: r.results });
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
  // Bug reports quoted as fixed in a version (public: the same text goes in the patch notes).
  if (req.method === 'GET' && url.pathname === '/v1/fixed') {
    const v = url.searchParams.get('version') || '';
    if (!VERSION_RE.test(v)) return fail(400, 'version=X.Y.Z required');
    const r = await env.DB.prepare("SELECT id, kind, quote, credit, store_name AS store FROM feedback WHERE fixed_in = ? AND quote IS NOT NULL AND quote <> '' ORDER BY id").bind(v).all();
    return json({ version: v, reports: r.results });
  }
  const m = url.pathname.match(/^\/v1\/(\d{1,6})(?:\/(list|closed|open|auto|feedback|usage|access|links|links\/remove)|\/wo\/(\d{5,12})\/(history|tag|untag|push|unmark|end))?$/);
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
    const [list, tags, marks, rules, gone, closedRows] = await env.DB.batch([
      env.DB.prepare('SELECT name, color FROM list WHERE store = ? ORDER BY pos').bind(store),
      env.DB.prepare('SELECT wo, tag, by_name AS by, at FROM wo_tags WHERE store = ? ORDER BY at').bind(store),
      env.DB.prepare('SELECT wo, due, kind, created_at AS at FROM auto_marks WHERE store = ? AND removed_at IS NULL').bind(store),
      env.DB.prepare('SELECT rule, state, staged_at, live_at FROM auto_rules'),
      env.DB.prepare('SELECT wo, kind FROM auto_marks WHERE store = ? AND removed_at IS NOT NULL').bind(store),
      env.DB.prepare('SELECT wo FROM wo_closed WHERE store = ?').bind(store),
    ]);
    const byWo = {}, auto = {}, ruleMap = {};
    for (const r of tags.results) (byWo[r.wo] = byWo[r.wo] || []).push({ tag: r.tag, by: r.by, at: r.at });
    for (const r of marks.results) auto[r.wo] = { due: r.due, at: r.at, kind: r.kind || 'rfp' };
    for (const r of rules.results) ruleMap[r.rule] = { state: r.state, stagedAt: r.staged_at, liveAt: r.live_at };
    // removed: marks removed with × (they stay removed while the WO stays in that status)
    return json({ list: list.results, tags: byWo, auto, rules: ruleMap, removed: gone.results.map((r) => ({ wo: r.wo, kind: r.kind || 'rfp' })),
      closed: closedRows.results.map((r) => r.wo) });
  }

  // Divination: cleanings a person linked to an order by hand (a phone's cleanings that day count for `parent`).
  if (req.method === 'GET' && what === 'links') {
    const since = url.searchParams.get('since');
    if (!DATE_RE.test(since || '')) return fail(400, 'since=YYYY-MM-DD required');
    const r = await env.DB.prepare('SELECT day, device, parent, by_name AS by, at FROM cleaning_links WHERE store = ? AND day >= ? ORDER BY day, at').bind(store, since).all();
    return json({ links: r.results });
  }
  if (req.method === 'POST' && (what === 'links' || what === 'links/remove')) {
    const b = await body(req);
    const day = String(b.day || ''), device = String(b.device || '');
    if (!DATE_RE.test(day) || !DEVICE_RE.test(device)) return fail(400, 'day and device required');
    const by = who(b); // who linked it (shown in Divination); not in Waymark's WO history
    if (what === 'links') {
      const parent = Number(b.parent);
      if (!Number.isInteger(parent) || parent < 10000 || parent > 999999999999) return fail(400, 'parent WO required');
      await env.DB.prepare('INSERT INTO cleaning_links (store, day, device, parent, by_name, by_id, at) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT (store, day, device) DO UPDATE SET parent = excluded.parent, by_name = excluded.by_name, by_id = excluded.by_id, at = excluded.at')
        .bind(store, day, device, parent, by.name, by.id, now()).run();
    } else {
      await env.DB.prepare('DELETE FROM cleaning_links WHERE store = ? AND day = ? AND device = ?').bind(store, day, device).run();
    }
    const r = await env.DB.prepare('SELECT day, device, parent, by_name AS by, at FROM cleaning_links WHERE store = ? AND day = ? ORDER BY at').bind(store, day).all();
    return json({ links: r.results });
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
      const kind = MARK_KINDS.includes(x.kind) ? x.kind : 'rfp';
      const r = await env.DB.prepare('INSERT OR IGNORE INTO auto_marks (store, wo, due, kind, created_at) VALUES (?, ?, ?, ?, ?)').bind(store, x.wo, x.due, kind, now()).run();
      if (r.meta.changes) { created.push(x.wo); await logHistory(env, store, x.wo, 'auto', null, x.due, { name: 'Auto-Waymark', id: null }); }
    }
    return json({ created });
  }

  // The WO left its mark's status: delete the mark (removed ones too), so a later return starts fresh.
  if (req.method === 'POST' && what === 'end') {
    const b = await body(req);
    const cur = await env.DB.prepare('SELECT due, kind, removed_at FROM auto_marks WHERE store = ? AND wo = ?').bind(store, wo).first();
    if (!cur) return json({ ended: false });
    await env.DB.prepare('DELETE FROM auto_marks WHERE store = ? AND wo = ?').bind(store, wo).run();
    if (!cur.removed_at) await logHistory(env, store, wo, 'auto-end', null, clean(b.reason, 80) || cur.due, who(b));
    return json({ ended: true });
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

  if (req.method === 'POST' && what === 'open') {
    const b = await body(req);
    const wos = (Array.isArray(b.wos) ? b.wos : []).filter((w) => Number.isInteger(w) && w > 0).slice(0, 500);
    if (wos.length) await env.DB.batch(wos.map((w) => env.DB.prepare('DELETE FROM wo_closed WHERE store = ? AND wo = ?').bind(store, w)));
    return json({ ok: true, reopened: wos.length });
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
    env.DB.prepare('DELETE FROM cleaning_links WHERE day < ?').bind(new Date(Date.now() - LINK_DAYS * 86400000).toISOString().slice(0, 10)),
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
