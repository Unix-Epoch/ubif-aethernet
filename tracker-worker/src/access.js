/*
  Per-person access for the admin site (Oct 17, 2026). One gate for every admin route:
  admin-worker/src/index.js runs it before any handler (Waymark's adminApi routes and the
  tracker's), and trackerAdmin() runs it again for its own routes, so a route can't be forgotten.

  Who: `accessOf(env, email)` →
    { email, owner, name, scope: 'all' | 'stores', stores: [914, …], pages: [ids], details, review, canSee(store) }
    or null (not an owner and not on the people list: everything but GET /api/tracker/me is refused).
  Owners (TRACKER_OWNERS) bypass every check: all pages, all stores, customer details. Only owners
  reach People (people, agents, log) and so only owners can change anyone's access.

  Pages a person can be given (people.pages, JSON). 'people' is owners only and never stored.
  "All stores" pages (reports, auto, stores) are Aethernet-wide: not limited by the person's stores.
  Customer details (people.details 0/1): off = no key copies, and trackerAdmin strips every sealed
  field (SEALED_KEYS) from its responses to them.
*/
export const PAGES = ['wos', 'sales', 'metrics', 'data', 'usage', 'reports', 'auto', 'stores', 'rules'];
export const WIDE_PAGES = ['reports', 'auto', 'stores'];
export const SEALED_KEYS = ['card', 'sealed', 'customerName'];

// Route → page. First match wins; anything not listed is refused (deny by default).
// [method ('*' = any), path (as the admin site sees it), page(s) (any one is enough; null = everyone
//  on the list; 'owner' = owners only), index of the path group holding a store number (optional)]
export const ROUTES = [
  ['GET', /^\/api\/tracker\/me$/, null],
  ['PUT', /^\/api\/tracker\/me\/keys$/, null],                 // details checked in trackerAdmin
  ['POST', /^\/api\/tracker\/init$/, 'owner'],
  ['*', /^\/api\/tracker\/(people|agents|log)(\/|$)/, 'owner'],
  ['GET', /^\/api\/tracker\/store-keys$/, 'wos'],             // all-stores + details checked in trackerAdmin
  ['GET', /^\/api\/tracker\/stores$/, ['wos', 'sales', 'metrics']],
  ['GET', /^\/api\/tracker\/wos$/, 'wos'],
  ['GET', /^\/api\/tracker\/wo\/(\d{1,6})\/\d{1,12}$/, 'wos', 1],
  ['GET', /^\/api\/tracker\/sales\/days?$/, 'sales'],
  ['*', /^\/api\/tracker\/metrics(\/|$)/, 'metrics'],
  ['GET', /^\/metrics/, 'metrics'],                           // the Metrics page's own files, if it gets any
  ['GET', /^\/api\/store\/(\d{1,6})$/, 'data', 1],
  ['GET', /^\/api\/stores$/, ['stores', 'data']],             // Store data's store picker: filtered to their stores
  ['POST', /^\/api\/stores(\/\d{1,6}\/remove)?$/, 'stores'],
  ['*', /^\/api\/config$/, 'stores'],
  ['GET', /^\/api\/usage$/, 'usage'],                         // rows filtered to their stores
  ['*', /^\/api\/feedback(\/\d+)?$/, 'reports'],
  ['GET', /^\/api\/next-version$/, 'reports'],
  ['*', /^\/api\/auto-rules$/, 'auto'],
  ['GET', /^\/api\/tracker\/assize\/orders$/, 'rules'],            // ?store= checked here (query)
  ['*', /^\/api\/tracker\/assize\/rules(\/|$)/, 'rules'],         // scope of each edit checked in src/assize.js
  ['GET', /^\/(rulegraph|assize-rules)\.js$/, 'rules'],              // the editor's engine, served to the page
];

export const owners = (env) => String(env.TRACKER_OWNERS || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
export const cleanPages = (v) => {
  let a = v;
  if (typeof v === 'string') { try { a = JSON.parse(v); } catch (_) { a = []; } }
  return Array.isArray(a) ? PAGES.filter((p) => a.includes(p)) : [];
};

// The role a set of access matches (the People list shows it; the editor's presets fill these in).
export function presetOf(a) {
  const same = (x, y) => x.length === y.length && x.every((p) => y.includes(p));
  if (a.scope === 'stores' && !a.details && same(a.pages, ['wos'])) return 'store viewer';
  if (a.scope === 'stores' && a.details && same(a.pages, ['wos', 'sales', 'metrics', 'data'])) return 'manager';
  if (a.scope === 'all' && a.details && same(a.pages, PAGES.filter((p) => p !== 'rules'))) return 'owner-level';
  return 'custom';
}

export async function accessOf(env, email) {
  email = String(email || '').trim().toLowerCase();
  if (!email) return null;
  const owner = owners(env).includes(email);
  const p = await env.TR.prepare('SELECT * FROM people WHERE email = ?').bind(email).first();
  if (!p && !owner) return null;
  const who = {
    email, owner, name: (p && p.name) || null,
    scope: owner ? 'all' : p.scope,
    stores: owner ? [] : JSON.parse(p.stores || '[]'),
    pages: owner ? [...PAGES, 'people'] : cleanPages(p.pages),
    details: owner || !!(p && p.details),
    review: !!(p && p.review),
    listed: !!p,
  };
  who.canSee = (s) => who.scope === 'all' || who.stores.includes(Number(s));
  return who;
}

// null = allowed (and who.gated is set to the route), else { status, error, page, store }.
export function gate(who, method, pathname, search) {
  const r = ROUTES.find(([m, re]) => (m === '*' || m === method) && re.test(pathname));
  if (!r) return { status: 403, error: 'unknown route', page: null };
  const [, re, page, storeAt] = r;
  if (!who) return page === null && method === 'GET' && pathname === '/api/tracker/me' ? null : { status: 403, error: 'not on the access list; ask an owner to add you', page };
  if (!who.owner) {
    const need = page === null ? [] : [].concat(page);
    if (need.includes('owner')) return { status: 403, error: 'owners only', page: 'owner' };
    if (need.length && !need.some((p) => who.pages.includes(p))) return { status: 403, error: 'no access to this page', page: need[0] };
    const fromPath = storeAt ? pathname.match(re)[storeAt] : null;
    const fromQuery = new URLSearchParams(search || '').get('store');
    for (const s of [fromPath, fromQuery]) {
      if (s == null || s === '') continue;
      if (!/^\d{1,6}$/.test(s) || !who.canSee(Number(s))) return { status: 403, error: 'no access to store ' + String(s).slice(0, 8), page: need[0] || null, store: s };
    }
  }
  who.gated = method + ' ' + pathname;
  return null;
}

// One 'denied' row per person and route per hour (the log stays readable when a page retries).
export async function logDenied(env, email, method, pathname, why) {
  const detail = (method + ' ' + pathname).slice(0, 160) + ' · ' + why;
  const since = new Date(Date.now() - 3600000).toISOString();
  const seen = await env.TR.prepare("SELECT 1 FROM access_log WHERE email = ? AND action = 'denied' AND detail = ? AND at > ?").bind(email || '(unknown)', detail, since).first();
  if (!seen) await env.TR.prepare("INSERT INTO access_log (email, action, detail, at) VALUES (?, 'denied', ?, ?)").bind(email || '(unknown)', detail, new Date().toISOString()).run();
}

// Gate + log in one call. Returns null (go on) or the 403 body.
export async function check(env, who, email, method, pathname, search) {
  const g = gate(who, method, pathname, search);
  if (!g) return null;
  try { await logDenied(env, String(email || '').toLowerCase(), method, pathname, g.page && g.error === 'no access to this page' ? 'page ' + g.page + ' not allowed' : g.error); } catch (_) {}
  return { error: g.error, page: g.page };
}

// Customer details off: every sealed field goes, at any depth.
export function stripSealed(v) {
  if (Array.isArray(v)) return v.map(stripSealed);
  if (!v || typeof v !== 'object') return v;
  const out = {};
  for (const [k, x] of Object.entries(v)) if (!SEALED_KEYS.includes(k)) out[k] = stripSealed(x);
  return out;
}
