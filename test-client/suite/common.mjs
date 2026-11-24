// What every file of the client suite shares: t() (one test, its line of output), the captured fixtures and the small stubs.
// Nothing here runs a test. See ../run.mjs for how the suite is put together.
import { load, retraceFx, fixture, runShard } from '../harness.mjs';


export const results = [];
export async function t(name, fn) {
  try { await fn(); results.push([name, true]); console.log('ok   ' + name); }
  catch (e) { results.push([name, false]); console.log('FAIL ' + name + '\n     ' + String((e && e.stack) || e).split('\n').slice(0, 6).join('\n     ')); }
}

// ------------------------------------------------------------------ fixtures
export const STORE = 914;
export const woTemplate = fixture('test-client/fixtures/wo-template.json'); // GET /api/workorder/{id} as { workorder: {...}, ... } + the cart (values blanked)
export const WO_ANSWER = woTemplate.workorder;                          // captured shape: { workorder: { workorderStatusId: 14, csuCartId, storeId, … }, stage, … }
export const withStatus = (n) => ({ ...WO_ANSWER, workorder: { ...WO_ANSWER.workorder, workorderStatusId: n } }); // the same answer at another status
export const LABELS = retraceFx('store-products');                      // { @odata.context, @odata.count: 3, value: [3 rows] }
export const ZERO_LABELS = { ...LABELS, '@odata.count': 0, value: [] }; // SYNTHETIC: the captured envelope with the count and rows emptied (what a real zero looks like)
export const PO_LIST = retraceFx('po-list');
export const OUTSTANDING = retraceFx('outstanding-parts');
export const NO_PARTS = { RMAParts: [], BuybackParts: [], SalvageParts: [] }; // SYNTHETIC: the captured answer's three lists emptied (keeps the pass's own label counts clean)
export const plain = (x) => JSON.parse(JSON.stringify(x === undefined ? null : x));
export const USER = { user: { userId: 1, givenName: 'Test', familyName: 'Tech' }, currentStore: { storeId: STORE, storeName: 'Test store' } }; // SYNTHETIC stand-in for /api/auth/user

export const ok = (body) => ({ status: 200, body });
// A fetch stub from a route table: [method, RegExp on the path+query, handler(body, url, init) → { status, body }].
export const router = (routes) => (url, init = {}) => {
  const method = init.method || 'GET', path = url.replace(/^https?:\/\/[^/]+/, '');
  for (const [m, re, fn] of routes) if (m === method && re.test(path)) return typeof fn === 'function' ? fn(init.body ? JSON.parse(init.body) : undefined, path, init) : fn;
  return { status: 404, body: { error: 'no stub for ' + method + ' ' + path } };
};
export const posted = (log, re, method = 'POST') => log.filter((r) => r.method === method && re.test(r.url));


// ------------------------------------------------------------------ shared by more than one file
export const MIN = 60000;
export const waymarkEnv = (woAnswer, auto = {}) => {
  const env = load(['00-core.js', '55-waymark.js'], { fetch: router([
    ['GET', /^\/api\/auth\/user$/, ok(USER)],
    ['GET', /^\/api\/workorder\/123$/, woAnswer],
    ['GET', /^\/v1\/914$/, ok({ list: [], tags: {}, auto, rules: {}, removed: [], closed: [] })],
    ['POST', /^\/v1\/914\/(wo\/\d+\/end|auto|closed|open)$/, ok({ created: [] })],
  ]) });
  return env;
};
export const ASSIZE_FILES = ['00-core.js', '27-tracker.js', '55-waymark.js', '65-assize.js'];
// Assize started on a signed-in page (its first pass, which every start makes, is over): its own pass(force, full) and readDetails().
export const assize = async (env) => { const a = runShard(env, 'assize'); await env.advance(15000); return a; };
