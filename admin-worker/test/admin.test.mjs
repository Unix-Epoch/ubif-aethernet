// Admin site cross-site protection (sameSiteCheck): run with `node admin-worker/test/admin.test.mjs`. No database and no Access:
// requests go to the LOCAL_TEST localhost path with no TR binding, so a request that passes the check reaches routing and stops at 503
// "tracker database not bound" (a refused one is 403 before that). Text imports are given to Node the way wrangler's [[rules]] do (see tracker-worker/test/admin.test.mjs).
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function load(url, ctx, next) {
  const asText = url.endsWith('.txt') || url.endsWith('?as-text') || (ctx.importAttributes && ctx.importAttributes.type === 'text')
    || ((url.endsWith('/admin-worker/src/tracker-ui.js') || url.endsWith('/admin-worker/src/metrics-ui.js') || url.endsWith('/admin-worker/src/rules-ui.js') || url.endsWith('/admin-worker/src/retrace-ui.js') || url.endsWith('/tracker-worker/src/crypto.js')) && ctx.parentURL && ctx.parentURL.endsWith('/admin-worker/src/index.js'));
  if (!asText) return next(url, ctx);
  return { format: 'module', source: 'export default ' + JSON.stringify(readFileSync(fileURLToPath(url), 'utf8')), shortCircuit: true };
}
export async function resolve(spec, ctx, next) {
  const r = await next(spec, ctx);
  if (ctx.parentURL && ctx.parentURL.endsWith('/admin-worker/src/index.js') && /(tracker-ui|metrics-ui|rules-ui|retrace-ui|crypto)\\.js$/.test(r.url)) return Object.assign({}, r, { url: r.url + '?as-text' });
  if (ctx.importAttributes && ctx.importAttributes.type === 'text') return Object.assign({}, r, { url: r.url + '?as-text', importAttributes: {} });
  return r;
}`));
const { default: site } = await import('../src/index.js');

const ORIGIN = 'http://localhost:8787';
const E = { LOCAL_TEST: '1' };
const go = async (method, path, { headers = {}, body } = {}) => {
  const r = await site.fetch(new Request(ORIGIN + path, { method, headers, body }), E, { waitUntil() {} });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) { /* not JSON */ }
  return { status: r.status, j, t };
};
const JSON_H = { 'content-type': 'application/json' };
const body = JSON.stringify({ store: 914 });
const refusedCheck = (r, why) => { assert.equal(r.status, 403, why); assert.match(r.j && r.j.error, /cross-site|application\/json/, why); };
const passed = (r, why) => assert.equal(r.status, 503, why + ' (reached routing: no tracker database bound)');

// no Sec-Fetch-Site and no Origin: refused, with and without a body
refusedCheck(await go('POST', '/api/stores', { headers: JSON_H, body }), 'no origin headers');
refusedCheck(await go('POST', '/api/stores/914/remove'), 'no origin headers, no body');
refusedCheck(await go('PUT', '/api/tracker/me/keys', { headers: JSON_H, body: '{}' }), 'PUT');
refusedCheck(await go('DELETE', '/api/anything'), 'DELETE');
// cross-site
refusedCheck(await go('POST', '/api/stores', { headers: { ...JSON_H, origin: 'https://evil.example' }, body }), 'cross-site Origin');
refusedCheck(await go('POST', '/api/stores', { headers: { ...JSON_H, origin: 'http://localhost:9999' }, body }), 'other port is another origin');
refusedCheck(await go('POST', '/api/stores', { headers: { ...JSON_H, origin: 'null' }, body }), 'null Origin');
refusedCheck(await go('POST', '/api/stores', { headers: { ...JSON_H, 'sec-fetch-site': 'cross-site' }, body }), 'Sec-Fetch-Site cross-site');
refusedCheck(await go('POST', '/api/stores', { headers: { ...JSON_H, 'sec-fetch-site': 'same-site' }, body }), 'Sec-Fetch-Site same-site (a sibling subdomain) is not same-origin');
refusedCheck(await go('POST', '/api/stores', { headers: { ...JSON_H, 'sec-fetch-site': 'none' }, body }), 'Sec-Fetch-Site none');
refusedCheck(await go('POST', '/api/stores', { headers: { ...JSON_H, 'sec-fetch-site': 'cross-site', origin: ORIGIN }, body }), 'Sec-Fetch-Site wins over a matching Origin');
// same-origin but not JSON
refusedCheck(await go('POST', '/api/stores', { headers: { 'content-type': 'text/plain', 'sec-fetch-site': 'same-origin' }, body }), 'text/plain body');
refusedCheck(await go('POST', '/api/stores', { headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' }, body: 'store=914' }), 'form body');
refusedCheck(await go('POST', '/api/stores', { headers: { 'content-type': 'application/json-evil', 'sec-fetch-site': 'same-origin' }, body }), 'lookalike type');
refusedCheck(await go('POST', '/api/stores', { headers: { origin: ORIGIN }, body: new Blob([body]) }), 'body with no content type (Origin path)');
// same-origin JSON passes the check
passed(await go('POST', '/api/stores', { headers: { ...JSON_H, 'sec-fetch-site': 'same-origin' }, body }), 'Sec-Fetch-Site same-origin');
passed(await go('POST', '/api/stores', { headers: { ...JSON_H, origin: ORIGIN }, body }), 'Origin equals own origin, no Sec-Fetch-Site');
passed(await go('POST', '/api/stores', { headers: { 'content-type': 'Application/JSON; charset=utf-8', 'sec-fetch-site': 'same-origin' }, body }), 'content type with parameters');
passed(await go('POST', '/api/stores/914/remove', { headers: { ...JSON_H, origin: ORIGIN } }), 'bodyless POST (remove / run-now / backfill)');
passed(await go('PUT', '/api/tracker/me/keys', { headers: { ...JSON_H, 'sec-fetch-site': 'same-origin' }, body: '{}' }), 'PUT');
// GET is unaffected, whatever the headers
passed(await go('GET', '/api/stores'), 'GET, no headers');
passed(await go('GET', '/api/stores', { headers: { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' } }), 'GET, cross-site headers');
assert.equal((await go('GET', '/')).status, 200, 'the page');
assert.equal((await go('HEAD', '/')).status, 200, 'HEAD is not checked');
// the check is also in front of the Access check on a real (non-local) host: refused cross-site without ever verifying a token
const r = await site.fetch(new Request('https://admin.example.workers.dev/api/stores', { method: 'POST', headers: { ...JSON_H, origin: 'https://evil.example', 'cf-access-jwt-assertion': 'a.b.c' }, body }), { TEAM_DOMAIN: 't', POLICY_AUD: 'a' }, { waitUntil() {} });
refusedCheck({ status: r.status, j: await r.json() }, 'production host, cross-site');
// a server error from a route is generic with an id; a thrown 4xx keeps its message
const logged = []; const origErr = console.error; console.error = (...a) => logged.push(a.join(' '));
try {
  const bad = { prepare() { throw new Error('SQLITE_ERROR: no such table: secret_t'); }, batch() { throw new Error('SQLITE_ERROR: no such table: secret_t'); } };
  const rr = await site.fetch(new Request(ORIGIN + '/api/stores', { headers: {} }), { LOCAL_TEST: '1', TR: bad, DB: bad }, { waitUntil() {} });
  const t = await rr.text();
  assert.ok(rr.status >= 400, 'failure surfaced');
  assert.ok(!/secret_t|SQLITE/i.test(t), 'no SQL text in the body: ' + t);
} finally { console.error = origErr; }
console.log('admin site: all passed');
