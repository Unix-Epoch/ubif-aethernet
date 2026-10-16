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

// ---- Assize dismissals: validation, store access, round trip (a tiny in-memory stand-in for the three tables' queries)
const rows = new Map(), access = new Set([914]);
const fake = {
  prepare(sql) {
    let a = [];
    const q = {
      bind(...x) { a = x; return q; },
      async first() {
        if (/FROM store_access/.test(sql)) return access.has(a[0]) ? { 1: 1 } : null;
        if (/COUNT\(\*\) AS n FROM assize_dismissals/.test(sql)) return { n: [...rows.values()].filter((r) => r.store === a[0]).length };
        throw new Error('unexpected first: ' + sql);
      },
      async all() {
        if (/FROM assize_dismissals/.test(sql)) return { results: [...rows.values()].filter((r) => r.store === a[0]).map((r) => ({ wo: r.wo, rule: r.rule, sig: r.sig, reason: r.reason, note: r.note, by: r.by_name, byId: r.by_id, at: r.at })) };
        throw new Error('unexpected all: ' + sql);
      },
      async run() {
        if (/^INSERT INTO assize_dismissals/.test(sql)) { const [store, wo, rule, sig, reason, note, by_name, by_id, at] = a; rows.set([store, wo, rule, sig].join('|'), { store, wo, rule, sig, reason, note, by_name, by_id, at }); return { meta: { changes: 1 } }; }
        if (/^DELETE FROM assize_dismissals/.test(sql)) return { meta: { changes: rows.delete(a.join('|')) ? 1 : 0 } };
        throw new Error('unexpected run: ' + sql);
      },
    };
    return q;
  },
  batch() { throw new Error('DB touched'); },
};
const E2 = { APP_KEY: 'k', DB: fake, LIMITER: null };
const c2 = async (method, path, body) => {
  const r = await worker.fetch(new Request('https://t.test' + path, { method, headers: { 'x-aethernet-key': 'k' }, body: body ? JSON.stringify(body) : undefined }), E2);
  return { status: r.status, j: await r.json() };
};
const good = { wo: 700000123, rule: 'missed-contact', sig: '2026-10-14', reason: 'handled', note: '  Called   back\n today ', by: 'Erin Baker', byId: 12345 };
assert.equal((await c2('GET', '/v1/915/assize/dismissed')).status, 403, 'a store without access is refused');
assert.equal((await c2('POST', '/v1/915/assize/dismiss', good)).status, 403);
assert.deepEqual((await c2('GET', '/v1/914/assize/dismissed')).j, { dismissed: [] });
for (const bad of [{ wo: 'x' }, { wo: 1.5 }, { wo: 12 }, { rule: 'Bad Rule' }, { rule: 'a' }, { rule: 'x'.repeat(41) }, { rule: undefined }, { sig: 'x'.repeat(121) }, { sig: 5 }, { reason: 'because' }, { reason: undefined }, { note: 'n'.repeat(201) }]) {
  const r = await c2('POST', '/v1/914/assize/dismiss', { ...good, ...bad });
  assert.equal(r.status, 400, JSON.stringify(bad));
}
assert.equal((await c2('GET', '/v1/914/assize/dismissed')).j.dismissed.length, 0, 'bad requests wrote nothing');
assert.equal((await c2('POST', '/v1/914/assize/restore', { ...good, wo: 'x' })).status, 400);
assert.equal((await c2('POST', '/v1/914/assize/dismiss', good)).status, 200);
for (const reason of ['not-applicable', 'handled', 'rule-doesnt-fit']) assert.equal((await c2('POST', '/v1/914/assize/dismiss', { ...good, rule: 'cart-not-offset', sig: reason, reason })).status, 200);
let list = (await c2('GET', '/v1/914/assize/dismissed')).j.dismissed;
assert.equal(list.length, 4);
const one = list.find((x) => x.rule === 'missed-contact');
assert.equal(one.note, 'Called back today', 'note cleaned');
assert.equal(one.by, 'Erin Baker'); assert.equal(one.byId, 12345); assert.equal(one.wo, 700000123);
await c2('POST', '/v1/914/assize/dismiss', { ...good, reason: 'not-applicable', note: '' });
list = (await c2('GET', '/v1/914/assize/dismissed')).j.dismissed;
assert.equal(list.length, 4, 'dismissing again updates, not duplicates');
assert.equal(list.find((x) => x.rule === 'missed-contact').reason, 'not-applicable');
assert.equal(list.find((x) => x.rule === 'missed-contact').note, null);
assert.equal((await c2('POST', '/v1/914/assize/restore', { wo: good.wo, rule: good.rule, sig: good.sig, by: 'Erin Baker', byId: 12345 })).j.restored, 1);
assert.equal((await c2('GET', '/v1/914/assize/dismissed')).j.dismissed.length, 3, 'restored');
assert.equal((await c2('POST', '/v1/914/assize/restore', { wo: good.wo, rule: good.rule, sig: good.sig })).j.restored, 0, 'restoring twice is harmless');
// the sandbox guard still comes first
await (async () => { const r = await c2('POST', '/v1/914/assize/dismiss', { ...good, by: 'Sandbox Tech', byId: 990001 }); assert.equal(r.status, 403); assert.equal(r.j.error, 'sandbox data'); })();
await (async () => { const r = await c2('POST', '/v1/999999/assize/dismiss', good); assert.equal(r.status, 403); assert.equal(r.j.error, 'sandbox data'); })();
await (async () => { const r = await c2('POST', '/v1/914/assize/restore', { ...good, by: 'Sandbox Lead' }); assert.equal(r.status, 403); assert.equal(r.j.error, 'sandbox data'); })();
assert.equal((await c2('GET', '/v1/914/assize/dismissed')).j.dismissed.length, 3, 'guarded requests wrote nothing');
console.log('waymark worker: all passed');
