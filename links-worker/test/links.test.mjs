// Run with `node links-worker/test/links.test.mjs`. GitHub is faked: every upstream request is recorded.
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const KEY = 'k3y_k3y_k3y_k3y_k3y_k3y_k3y_k3y';
const env = { PUBLIC_GIST: '0cf4560c4f26d8ff9091a10068fd3464', DEV_GIST: '9ac1e1dbc80caa3dff04afb5b89e90c3', EARLY_GIST: 'abcdefabcdefabcdefabcdefabcdefab', DEV_KEY: KEY };
const seen = [];
let upstream = () => new Response('// ==UserScript==', { status: 200 });
globalThis.fetch = async (u, init) => { seen.push({ u: String(u), method: init?.method }); return upstream(String(u)); };
const get = (path, method = 'GET', e = env) => worker.fetch(new Request('https://aethersp.here' + path, { method }), e);
const RAW = (gist, file) => `https://gist.githubusercontent.com/Unix-Epoch/${gist}/raw/${file}`;

// short links
for (const [from, to] of [['/aen/install', '/aen/aethernet.user.js'], ['/aen/install/', '/aen/aethernet.user.js'], ['/aen/early', '/aen/early/aethernet.user.js'], [`/oracle/dev/${KEY}`, `/oracle/dev/${KEY}/aethernet.user.js`]]) {
  const r = await get(from);
  assert.equal(r.status, 302, from);
  assert.equal(r.headers.get('location'), to, from);
}
assert.equal(seen.length, 0, 'redirects never reach GitHub');

// each channel maps to its own Gist
let r = await get('/aen/aethernet.user.js');
assert.equal(r.status, 200);
assert.equal(await r.text(), '// ==UserScript==');
assert.equal(r.headers.get('content-type'), 'text/javascript; charset=utf-8');
assert.equal(seen.at(-1).u, RAW(env.PUBLIC_GIST, 'aethernet.user.js'));
await get('/aen/early/aethernet.readable.js');
assert.equal(seen.at(-1).u, RAW(env.EARLY_GIST, 'aethernet.readable.js'));
await get(`/oracle/dev/${KEY}/aethernet.meta.js`);
assert.equal(seen.at(-1).u, RAW(env.DEV_GIST, 'aethernet.meta.js'));

// status.json: cache bust passed on, readable cross-origin, never cached
r = await get(`/oracle/dev/${KEY}/status.json?t=123`);
assert.equal(seen.at(-1).u, RAW(env.DEV_GIST, 'status.json') + '?t=123');
assert.equal(r.headers.get('access-control-allow-origin'), '*');
assert.equal(r.headers.get('cache-control'), 'no-store');
assert.equal(r.headers.get('content-type'), 'application/json; charset=utf-8');

// nothing else gets through: old paths, wrong or missing dev key, other files, unset secrets
const before = seen.length;
const wrong = KEY.slice(0, -1) + 'X';
for (const p of ['/', '/install', '/early', '/aethernet.user.js', '/dev/aethernet.user.js', '/aen', '/aen/dev/aethernet.user.js', '/aen/demo/aethernet.user.js',
  '/aen/other.js', '/aen/early/other.json', '/aen/early/early/aethernet.user.js', '/aen/aethernet.user.js/x', '/AEN/aethernet.user.js',
  '/oracle', '/oracle/dev', '/oracle/dev/aethernet.user.js', `/oracle/dev/${wrong}`, `/oracle/dev/${wrong}/aethernet.user.js`, `/oracle/dev/${KEY}x/status.json`,
  `/oracle/dev/${KEY}/other.js`, `/oracle/${KEY}/aethernet.user.js`]) {
  assert.equal((await get(p)).status, 404, p);
}
assert.equal((await get('/aen/early/aethernet.user.js', 'GET', { ...env, EARLY_GIST: undefined })).status, 404, 'early without its secret');
assert.equal((await get(`/oracle/dev/${KEY}/aethernet.user.js`, 'GET', { ...env, DEV_KEY: undefined })).status, 404, 'dev without its secret');
assert.equal((await get('/oracle/dev/short/aethernet.user.js', 'GET', { ...env, DEV_KEY: 'short' })).status, 404, 'a too-short DEV_KEY never opens dev');
assert.equal(seen.length, before, '404s never reach GitHub');
assert.equal((await get('/aen/aethernet.user.js', 'POST')).status, 405);

// HEAD has no body; upstream failures don't leak through as 200
r = await get('/aen/aethernet.meta.js', 'HEAD');
assert.equal(r.status, 200);
assert.equal(r.body, null);
upstream = () => new Response('nope', { status: 404 });
assert.equal((await get('/aen/aethernet.user.js')).status, 404);
upstream = () => new Response('boom', { status: 500 });
assert.equal((await get('/aen/aethernet.user.js')).status, 502);
upstream = () => { throw new Error('offline'); };
assert.equal((await get('/aen/aethernet.user.js')).status, 502);

console.log('links worker: ok');
