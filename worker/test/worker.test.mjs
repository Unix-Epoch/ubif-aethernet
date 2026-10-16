// Sandbox guard: run with `node worker/test/worker.test.mjs`. No database needed, because a guarded
// request must be refused before anything touches DB (the fake DB throws if it is used).
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const DB = { prepare() { throw new Error('DB touched'); }, batch() { throw new Error('DB touched'); } };
const E = { APP_KEY: 'k', DB, LIMITER: null };
const call = async (method, path, body) => {
  const r = await worker.fetch(new Request('https://t.test' + path, { method, headers: { 'x-aethernet-key': 'k' }, body: body ? JSON.stringify(body) : undefined }), E);
  return { status: r.status, j: await r.json() };
};
const refused = async (method, path, body) => { const r = await call(method, path, body); assert.equal(r.status, 403, path + ' ' + JSON.stringify(body)); assert.equal(r.j.error, 'sandbox data'); };

await refused('POST', '/v1/914/usage', { by: 'Sandbox Tech', counts: {} });
await refused('POST', '/v1/914/usage', { by: 'sandbox lead', counts: {} });
await refused('POST', '/v1/914/wo/700000001/tag', { byId: 990001, tag: 'x' });
await refused('POST', '/v1/914/feedback', { store_name: 'Sandbox Store', text: 'x' });
await refused('POST', '/v1/914/feedback', { storeName: 'Sandbox Store 2', by_name: 'Real Person' });
await refused('POST', '/v1/914/feedback', { email: 'sandbox.tech@example.invalid' });
await refused('POST', '/v1/999999/usage', { counts: {} });
await refused('GET', '/v1/999999/access');
await refused('GET', '/v1/914/access?name=Sandbox%20Store&user=Sandbox%20Tech');

// normal requests get past the guard (and here fail for their own reasons, not 'sandbox data')
const n = await call('GET', '/v1/fixed?version=bad');
assert.equal(n.status, 400);
const o = await worker.fetch(new Request('https://t.test/v1/914/usage', { method: 'POST', headers: { 'x-aethernet-key': 'k' }, body: JSON.stringify({ by: 'Sandra Boxer', byId: 12345, counts: {} }) }), E);
assert.notEqual((await o.json()).error, 'sandbox data', 'real staff pass the guard');
console.log('waymark worker: all passed');
