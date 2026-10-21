/*
  Assize rules on the tracker Worker (Oct 21, 2026): rule graphs edited and published on the admin site (page
  'rules'), read by Aethernet's Assize. Tables assize_rules and assize_rule_history (migrations/2026-10-21-assize-rules.sql).

  One row per rule and scope. Scope 'all' = every store; a store number as text ('914') = that store's override.
    graph    a store's published graph wins over the one for all stores; no published graph = the code rule.
    enabled  1 on, 0 off (the rule raises nothing there, code or graph), NULL follow 'all' ('all' NULL = on).
  Drafts may be invalid: they are saved with their errors (assize-rules.js checkGraph). Publishing refuses an
  invalid draft (400 with the errors). Every publish is kept in the history with its graph; reverting copies an old
  version into the draft (it doesn't publish by itself: test it, then publish like any change).
  Editing a scope: 'all' needs all-stores access, a store needs that store; developers (TRACKER_OWNERS) bypass.
  Every change writes an access_log row (assize:draft, assize:publish ...).

  Store side (x-aethernet-key, the store must have Aethernet access):
    GET /v1/:store/assize/rules?v=<version>
      → { version, rules: { rule: { graph, version, scope, enabled } } }, or { version, same: true } when v is the
        current version. Lists only rules something applies to at this store: a published graph (graph, its
        version and the scope it comes from) or turned off (enabled false, graph null when there is none).
  Admin side: assizeAdmin() below, mounted by trackerAdmin at /api/tracker/assize/… (route list there).
*/
import * as RG from './rulegraph.js';
import { makeRules, ruleId, CATALOG } from './assize-rules.js';
import { GRAPHS } from './assize-graphs.js';

export const R = makeRules({ RG, graphs: GRAPHS });
const CHECK_KEYS = R.CHECKS.map(([k]) => k);
const MAX_BODY = R.MAX_GRAPH_BYTES + 20000;
const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch (_) { return null; } };
const sha = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].slice(0, 12).map((x) => x.toString(16).padStart(2, '0')).join('');
// A scope from a request: 'all' or a store number (1–6 digits) as text; null = not a scope.
const scopeOf = (v) => (v === 'all' ? 'all' : (typeof v === 'number' && Number.isInteger(v)) || (typeof v === 'string' && /^\d{1,6}$/.test(v)) ? String(Number(v)) : null);
const storeOf = (scope) => (scope === 'all' ? null : Number(scope));
const inCatalog = (rule) => CATALOG.find((x) => x.rule === rule) || null;

// ------------------------------------------------------------------ store side
export async function assizeStore(req, env, url, store, H) {
  const path = url.pathname.replace(/^\/v1\/\d+\/assize/, '');
  if (path !== '/rules' || req.method !== 'GET') return H.fail(404, 'not found');
  const T = env.TR, mine = String(store);
  const meta = (await T.prepare("SELECT rule, scope, published_version, published IS NOT NULL AS has, enabled FROM assize_rules WHERE scope IN ('all', ?) ORDER BY rule, scope").bind(mine).all()).results;
  const by = new Map();
  for (const r of meta) { const x = by.get(r.rule) || {}; x[r.scope === 'all' ? 'all' : 'store'] = r; by.set(r.rule, x); }
  const pick = [];
  for (const [rule, { all, store: own }] of by) {
    const from = own && own.has ? own : all && all.has ? all : null;
    const enabled = own && own.enabled != null ? own.enabled : all && all.enabled != null ? all.enabled : 1;
    if (!from && enabled) continue;
    pick.push({ rule, scope: from ? from.scope : null, version: from ? from.published_version : null, enabled: !!enabled });
  }
  const version = await sha(JSON.stringify(pick.map((x) => [x.rule, x.scope, x.version, x.enabled])));
  if (url.searchParams.get('v') === version) return H.json({ version, same: true });
  const want = pick.filter((x) => x.scope);
  const graphs = new Map();
  if (want.length) {
    const r = await T.prepare("SELECT rule, scope, published FROM assize_rules WHERE published IS NOT NULL AND scope IN ('all', ?)").bind(mine).all();
    for (const x of r.results) graphs.set(x.rule + '|' + x.scope, parse(x.published));
  }
  const rules = {};
  for (const x of pick) rules[x.rule] = { graph: x.scope ? graphs.get(x.rule + '|' + x.scope) || null : null, version: x.version, scope: x.scope, enabled: x.enabled };
  return H.json({ version, rules });
}

// ------------------------------------------------------------------ admin side
/*
  Behind the access gate (page 'rules'; GET /assize/orders also needs its ?store= in the person's stores).
  Paths below are under /api/tracker. `scope` is 'all' or a store number (number or text).

  GET  /assize/rules                     every rule: { checks: [[key, name]], rules: [{ rule, check, title, kind, code,
                                         perOrder, builtInGraph, scopes: [{ scope, draft, draftErrors, draftBy, draftAt,
                                         published, version, publishedBy, publishedAt, enabled, note }] }] }
                                         (scopes: 'all' and the stores the person can see; draft / published are
                                         booleans here, draftErrors a count). code: Assize's code has this rule.
  POST /assize/rules { rule, title, check, kind? }   a new graph-only rule (all-stores access): 'all' row with an
                                         empty draft graph → { ok, rule } · 400 bad id/title/check · 409 taken
  GET  /assize/rules/:rule               { rule, check, title, kind, code, perOrder, builtInGraph: graph|null,
                                         scopes: [{ scope, draft: graph|null, draftErrors: [..], draftBy, draftAt,
                                         published: graph|null, version, publishedBy, publishedAt, enabled, note }],
                                         history: [{ id, scope, version, action, by, at, note, hasGraph }] } (newest first)
  GET  /assize/rules/:rule/history/:id   { id, rule, scope, version, action, by, at, note, graph }
  PUT  /assize/rules/:rule/draft { scope, graph, note?, ifDraftAt? }   save the draft (even invalid) → { ok, errors,
                                         draftAt } · 409 when ifDraftAt is given and the draft changed since
  POST /assize/rules/:rule/discard { scope }                     drop the draft → { ok }
  POST /assize/rules/:rule/publish { scope, note?, ifDraftAt? }  draft → published, version + 1, history row →
                                         { ok, version } · 400 { error, errors } when it doesn't check out
  POST /assize/rules/:rule/revert { scope, id, note? }   history version id → the draft → { ok, errors, draftAt }
  POST /assize/rules/:rule/enabled { scope, enabled: true | false | null }   null (stores only): follow all stores
  POST /assize/rules/:rule/delete { scope }               remove a store's override (row and all) → { ok }
  GET  /assize/orders?store=&wos=1,2&limit=   the store's open orders for testing graphs: { store, details,
                                         last_scan_at, orders: [{ wo, status_id, status_name, program_name, device,
                                         api_updated_at, last_detail_at, snapshot_id, snapshot_at, plain, sealed }] }
                                         (plain parsed; sealed only with customer details: open it in the browser,
                                         then assize-rules.js fromSnapshot(plain, sealed) gives Assize's (row, detail))
*/
export async function assizeAdmin(req, env, url, path, me, email, H) {
  const T = env.TR, sub = path.replace(/^\/assize/, '');
  const canEdit = (scope) => me.owner || (scope === 'all' ? me.scope === 'all' : me.canSee(Number(scope)));
  const visible = (scope) => scope === 'all' || me.canSee(Number(scope));
  const body = () => H.readJson(req, MAX_BODY);
  const rowsOf = async (rule) => (await T.prepare('SELECT * FROM assize_rules WHERE rule = ? ORDER BY scope').bind(rule).all()).results;
  const known = async (rule) => !!inCatalog(rule) || !!(await T.prepare("SELECT 1 FROM assize_rules WHERE rule = ? AND scope = 'all'").bind(rule).first());
  const history = (rule, scope, action, o = {}) => T.prepare('INSERT INTO assize_rule_history (rule, scope, version, graph, by_email, at, note, action) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(rule, scope, o.version ?? null, o.graph ?? null, email, H.now(), o.note || null, action);
  const note = (b) => H.clean(b && b.note, 300) || null;
  const logIt = (action, rule, scope, detail) => H.log(env, email, 'assize:' + action, scope && scope !== 'all' ? Number(scope) : null, null, rule + ' · ' + (scope === 'all' ? 'all stores' : 'store ' + scope) + (detail ? ' · ' + detail : ''));
  // What a rule is, from the catalog or (graph-only) its graphs.
  const describe = (rule, rows) => {
    const c = inCatalog(rule), all = rows.find((r) => r.scope === 'all'), g = all ? parse(all.published) || parse(all.draft) : null;
    return { rule, check: c ? c.check : (g && g.check) || '', title: c ? c.title : (g && g.title) || rule, kind: c ? c.kind : null, code: !!c, perOrder: c ? c.perOrder : true, builtInGraph: !!GRAPHS[rule] };
  };

  if (sub === '/rules' && req.method === 'GET') {
    const rows = (await T.prepare('SELECT rule, scope, draft IS NOT NULL AS has_draft, draft_errors, draft_by, draft_at, published IS NOT NULL AS has_pub, published_version, published_by, published_at, enabled, note, '
      + "CASE WHEN scope = 'all' THEN COALESCE(json_extract(published, '$.title'), json_extract(draft, '$.title')) END AS g_title, CASE WHEN scope = 'all' THEN COALESCE(json_extract(published, '$.check'), json_extract(draft, '$.check')) END AS g_check FROM assize_rules ORDER BY rule, scope").all()).results;
    const ids = [...CATALOG.map((x) => x.rule), ...[...new Set(rows.filter((r) => r.scope === 'all' && !inCatalog(r.rule)).map((r) => r.rule))].sort()];
    const rules = ids.map((rule) => {
      const mine = rows.filter((r) => r.rule === rule && visible(r.scope)), c = inCatalog(rule), all = mine.find((r) => r.scope === 'all');
      return { rule, check: c ? c.check : (all && all.g_check) || '', title: c ? c.title : (all && all.g_title) || rule, kind: c ? c.kind : null, code: !!c, perOrder: c ? c.perOrder : true, builtInGraph: !!GRAPHS[rule],
        scopes: mine.map((r) => ({ scope: r.scope, draft: !!r.has_draft, draftErrors: (parse(r.draft_errors) || []).length, draftBy: r.draft_by, draftAt: r.draft_at, published: !!r.has_pub, version: r.published_version,
          publishedBy: r.published_by, publishedAt: r.published_at, enabled: r.enabled, note: r.note })) };
    });
    return H.json({ checks: R.CHECKS, rules }, 200, false);
  }
  if (sub === '/rules' && req.method === 'POST') {
    const b = await body(), rule = ruleId(b.rule), title = H.clean(b.title, 80), check = b.check;
    if (!rule) return H.fail(400, 'rule id: lowercase letters, digits and dashes, 60 at most', false);
    if (!title || !CHECK_KEYS.includes(check)) return H.fail(400, 'title and check (' + CHECK_KEYS.join(', ') + ') required', false);
    if (!canEdit('all')) return H.fail(403, 'a new rule is for every store: it needs all-stores access', false);
    if (inCatalog(rule) || (await T.prepare('SELECT 1 FROM assize_rules WHERE rule = ?').bind(rule).first())) return H.fail(409, 'there is already a rule ' + rule, false);
    const graph = { v: 1, rule, check, title, nodes: [], wires: [] };
    if (b.kind && R.KINDS.includes(b.kind)) graph.kind = b.kind; // the editor's default for new finding nodes
    const at = H.now();
    await T.batch([
      T.prepare("INSERT INTO assize_rules (rule, scope, draft, draft_errors, draft_by, draft_at, created_by, created_at) VALUES (?, 'all', ?, ?, ?, ?, ?, ?)")
        .bind(rule, JSON.stringify(graph), JSON.stringify(R.checkGraph(graph, rule)), email, at, email, at),
      history(rule, 'all', 'create', { note: title }),
    ]);
    await logIt('create', rule, 'all', title);
    return H.json({ ok: true, rule }, 200, false);
  }
  if (sub === '/orders' && req.method === 'GET') {
    const q = url.searchParams, store = H.int(q.get('store'));
    if (!store || !me.canSee(store)) return H.fail(403, 'not your store', false);
    const wos = (q.get('wos') || '').split(',').map(H.int).filter(Boolean).slice(0, 500);
    const limit = Math.min(H.int(q.get('limit')) || 300, 500);
    const [rows, scan] = await T.batch([
      T.prepare(`SELECT w.wo, w.status_id, w.status_name, w.program_name, w.device, w.api_updated_at, w.last_detail_at, s.id AS snapshot_id, s.fetched_at AS snapshot_at, s.plain${me.details ? ', s.sealed' : ''}
          FROM workorders w LEFT JOIN snapshots s ON s.id = (SELECT MAX(id) FROM snapshots WHERE store = w.store AND wo = w.wo)
          WHERE w.store = ? AND w.is_open = 1${wos.length ? ' AND w.wo IN (SELECT value FROM json_each(?))' : ''} ORDER BY w.wo LIMIT ?`).bind(...[store, ...(wos.length ? [JSON.stringify(wos)] : []), limit]),
      T.prepare('SELECT MAX(at) AS at FROM scans WHERE store = ?').bind(store),
    ]);
    await H.log(env, email, 'assize:orders', store, null, rows.results.length + ' orders');
    return H.json({ store, details: !!me.details, last_scan_at: scan.results[0].at || null, orders: rows.results.map((r) => Object.assign(r, { plain: parse(r.plain) })) }, 200, false);
  }

  const m = sub.match(/^\/rules\/([a-z0-9-]{1,60})(?:\/(draft|discard|publish|revert|enabled|delete|history\/(\d{1,12})))?$/);
  if (!m) return H.fail(404, 'not found', false);
  const rule = ruleId(m[1]), action = m[2] && m[2].startsWith('history/') ? 'history' : m[2] || null;
  if (!rule || !(await known(rule))) return H.fail(404, 'no rule ' + m[1], false);

  if (!action && req.method === 'GET') {
    const rows = await rowsOf(rule);
    const hist = (await T.prepare('SELECT id, scope, version, action, by_email, at, note, graph IS NOT NULL AS has_graph FROM assize_rule_history WHERE rule = ? ORDER BY id DESC LIMIT 500').bind(rule).all()).results;
    return H.json(Object.assign(describe(rule, rows), {
      builtInGraph: GRAPHS[rule] || null,
      scopes: rows.filter((r) => visible(r.scope)).map((r) => ({ scope: r.scope, draft: parse(r.draft), draftErrors: parse(r.draft_errors) || [], draftBy: r.draft_by, draftAt: r.draft_at,
        published: parse(r.published), version: r.published_version, publishedBy: r.published_by, publishedAt: r.published_at, enabled: r.enabled, note: r.note })),
      history: hist.filter((h) => visible(h.scope)).map((h) => ({ id: h.id, scope: h.scope, version: h.version, action: h.action, by: h.by_email, at: h.at, note: h.note, hasGraph: !!h.has_graph })),
    }), 200, false);
  }
  if (action === 'history' && req.method === 'GET') {
    const h = await T.prepare('SELECT * FROM assize_rule_history WHERE id = ? AND rule = ?').bind(Number(m[3]), rule).first();
    if (!h || !visible(h.scope)) return H.fail(404, 'no such version', false);
    return H.json({ id: h.id, rule, scope: h.scope, version: h.version, action: h.action, by: h.by_email, at: h.at, note: h.note, graph: parse(h.graph) }, 200, false);
  }
  if (req.method !== (action === 'draft' ? 'PUT' : 'POST')) return H.fail(405, 'method not allowed', false);
  const b = await body(), scope = scopeOf(b.scope);
  if (!scope) return H.fail(400, "scope required: 'all' or a store number", false);
  if (!canEdit(scope)) return H.fail(403, scope === 'all' ? 'changing a rule for every store needs all-stores access' : 'no access to store ' + scope, false);
  const cat = inCatalog(rule);
  const row = await T.prepare('SELECT * FROM assize_rules WHERE rule = ? AND scope = ?').bind(rule, scope).first();
  const at = H.now();
  const stale = () => b.ifDraftAt !== undefined && (b.ifDraftAt || null) !== ((row && row.draft_at) || null);
  // A row left with nothing in it goes (a code rule's, or a store's override); a graph-only rule keeps its 'all' row.
  const tidy = () => T.prepare("DELETE FROM assize_rules WHERE rule = ? AND scope = ? AND draft IS NULL AND published IS NULL AND enabled IS NULL AND (scope != 'all' OR ?)").bind(rule, scope, cat ? 1 : 0);

  if (action === 'draft' || action === 'revert') {
    if (cat && !cat.perOrder) return H.fail(400, 'this rule looks across orders; graphs run one order at a time', false);
    if (stale()) return H.fail(409, 'someone saved this draft since you opened it', false);
    let graph = b.graph, from = null;
    if (action === 'revert') {
      from = await T.prepare("SELECT * FROM assize_rule_history WHERE id = ? AND rule = ? AND action = 'publish' AND graph IS NOT NULL").bind(H.int(b.id), rule).first();
      if (!from || !visible(from.scope)) return H.fail(404, 'no such published version', false);
      graph = parse(from.graph);
    }
    if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return H.fail(400, 'graph required', false);
    const text = JSON.stringify(graph);
    if (text.length > R.MAX_GRAPH_BYTES) return H.fail(413, 'the graph is over ' + R.MAX_GRAPH_BYTES / 1024 + ' KB', false);
    const errors = R.checkGraph(graph, rule);
    const stmts = [T.prepare(`INSERT INTO assize_rules (rule, scope, draft, draft_errors, draft_by, draft_at, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (rule, scope) DO UPDATE SET draft = excluded.draft, draft_errors = excluded.draft_errors, draft_by = excluded.draft_by, draft_at = excluded.draft_at, note = COALESCE(excluded.note, note)`)
      .bind(rule, scope, text, JSON.stringify(errors), email, at, b.note !== undefined && action === 'draft' ? note(b) : null, email, at)];
    if (from) stmts.push(history(rule, scope, 'revert', { version: from.version, note: note(b) || 'draft from version ' + from.version + (from.scope !== scope ? ' (' + (from.scope === 'all' ? 'all stores' : 'store ' + from.scope) + ')' : '') }));
    await T.batch(stmts);
    await logIt(action, rule, scope, from ? 'version ' + from.version : errors.length ? errors.length + ' errors' : 'valid');
    return H.json({ ok: true, errors, draftAt: at }, 200, false);
  }
  if (action === 'discard') {
    if (!row || row.draft == null) return H.json({ ok: true }, 200, false);
    await T.batch([T.prepare('UPDATE assize_rules SET draft = NULL, draft_errors = NULL, draft_by = NULL, draft_at = NULL WHERE rule = ? AND scope = ?').bind(rule, scope), tidy()]);
    await logIt('discard', rule, scope);
    return H.json({ ok: true }, 200, false);
  }
  if (action === 'publish') {
    if (cat && !cat.perOrder) return H.fail(400, 'this rule looks across orders; graphs run one order at a time', false);
    if (!row || row.draft == null) return H.fail(400, 'nothing to publish: no draft', false);
    if (stale()) return H.fail(409, 'someone saved this draft since you opened it', false);
    const graph = parse(row.draft), errors = R.checkGraph(graph, rule);
    if (errors.length) return H.json({ error: 'the draft has errors', errors }, 400, false);
    const version = (row.published_version || 0) + 1;
    await T.batch([
      T.prepare('UPDATE assize_rules SET published = draft, published_version = ?, published_by = ?, published_at = ?, draft = NULL, draft_errors = NULL, draft_by = NULL, draft_at = NULL WHERE rule = ? AND scope = ?')
        .bind(version, email, at, rule, scope),
      history(rule, scope, 'publish', { version, graph: row.draft, note: note(b) }),
    ]);
    await logIt('publish', rule, scope, 'version ' + version);
    return H.json({ ok: true, version }, 200, false);
  }
  if (action === 'enabled') {
    const v = b.enabled === true ? 1 : b.enabled === false ? 0 : b.enabled === null && scope !== 'all' ? null : undefined;
    if (v === undefined) return H.fail(400, 'enabled: true or false (null: a store follows all stores)', false);
    const what = v === 1 ? 'enable' : v === 0 ? 'disable' : 'inherit';
    await T.batch([
      T.prepare('INSERT INTO assize_rules (rule, scope, enabled, created_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (rule, scope) DO UPDATE SET enabled = excluded.enabled').bind(rule, scope, v, email, at),
      history(rule, scope, what, { note: note(b) }), tidy(),
    ]);
    await logIt(what, rule, scope);
    return H.json({ ok: true, enabled: v }, 200, false);
  }
  if (action === 'delete') {
    if (scope === 'all') return H.fail(400, 'only a store override can be deleted', false);
    if (!row) return H.json({ ok: true }, 200, false);
    await T.batch([T.prepare('DELETE FROM assize_rules WHERE rule = ? AND scope = ?').bind(rule, scope), history(rule, scope, 'delete', { version: row.published_version || null, note: note(b) })]);
    await logIt('delete', rule, scope);
    return H.json({ ok: true }, 200, false);
  }
  return H.fail(404, 'not found', false);
}
