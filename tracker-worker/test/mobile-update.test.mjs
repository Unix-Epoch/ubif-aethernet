// Linkpearl phone API, app updates (/v1/agents/m/update…): latest.json read from the RELEASES R2 bucket (wrangler's local R2, through getPlatformProxy),
// the APK streamed with its headers, only the latest build served, and every failure (no binding, no file, a bad file, a missing APK) answering
// latest: null or 404, never a 500. The APK bytes are invented.
import assert from 'node:assert/strict';
import { setup, worker, APP_KEY } from './mobile-helpers.mjs';
import { MIN_APP } from '../src/mobile-prefs.js';
import { latestOf, LATEST_KEY, apkKey } from '../src/mobile-update.js';

const U = '/v1/agents/m/update';
const sha256hex = async (b) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');

// ---- unit: latest.json is checked before it is believed
const SHA = 'a'.repeat(64);
assert.deepEqual(latestOf({ code: 5, name: '1.2.0', size: 10, sha256: SHA }), { code: 5, name: '1.2.0', size: 10, sha256: SHA });
assert.deepEqual(latestOf({ code: 5, name: '1.2.0', size: 10, sha256: SHA, notes: '  Prices tab  ', extra: 1 }), { code: 5, name: '1.2.0', size: 10, sha256: SHA, notes: 'Prices tab' });
assert.deepEqual(latestOf({ code: 5, name: '1.2.0', size: 10, sha256: SHA, notes: '' }), { code: 5, name: '1.2.0', size: 10, sha256: SHA }, 'empty notes left out');
for (const bad of [null, 'x', {}, { code: '5', name: '1.2.0', size: 10, sha256: SHA }, { code: 0, name: '1.2.0', size: 10, sha256: SHA }, { code: 5, name: '../x', size: 10, sha256: SHA },
  { code: 5, name: '1.2.0', size: 0, sha256: SHA }, { code: 5, name: '1.2.0', size: 10, sha256: 'A'.repeat(64) }, { code: 5, name: '1.2.0', size: 10.5, sha256: SHA }]) assert.equal(latestOf(bad), null, JSON.stringify(bad));
assert.equal(apkKey('1.2.0'), 'linkpearl/Linkpearl-1.2.0.apk');

// ---- the routes, on wrangler's local R2
const T = await setup('.wrangler-test-mobile-update');
const { E, authed, registerPhone, approve } = T;
assert.ok(E.RELEASES, 'wrangler.toml binds RELEASES (local R2 in tests)');
const phone = await registerPhone('Pixel'); await approve(phone, [914]);

// nothing published yet
let r = await authed(phone, U);
assert.equal(r.status, 200); assert.equal(r.h.get('cache-control'), 'no-store');
assert.deepEqual(r.j, { latest: null, min: MIN_APP });
assert.equal((await authed(phone, U + '/apk?code=1')).status, 404);

// publish a build the way android/publish-release.sh does: the APK, then latest.json
const apk = new Uint8Array(300000); for (let i = 0; i < apk.length; i++) apk[i] = (i * 31 + 7) & 0xff; apk.set([0x50, 0x4b, 0x03, 0x04]); // "PK.." (a zip)
const latest = { code: 6, name: '1.2.0', size: apk.length, sha256: await sha256hex(apk), notes: 'Prices and in-app updates.' };
await E.RELEASES.put(apkKey(latest.name), apk, { httpMetadata: { contentType: 'application/vnd.android.package-archive' } });
await E.RELEASES.put(LATEST_KEY, JSON.stringify(latest), { httpMetadata: { contentType: 'application/json' } });

r = await authed(phone, U);
assert.equal(r.status, 200); assert.deepEqual(r.j, { latest, min: MIN_APP });
console.log('update', JSON.stringify(r.j));

// the APK: bytes, type, length, no-store
// a raw Response (authed() parses JSON)
async function fetchRaw(path, p) {
  return worker.fetch(new Request('https://t.test' + path, { headers: Object.assign({ 'x-aethernet-key': APP_KEY }, p ? T.bearer(p) : {}) }), E, {});
}
const a = await fetchRaw(U + '/apk?code=6', phone);
assert.equal(a.status, 200);
assert.equal(a.headers.get('content-type'), 'application/vnd.android.package-archive');
assert.equal(a.headers.get('content-length'), String(apk.length));
assert.equal(a.headers.get('cache-control'), 'no-store');
assert.equal(a.headers.get('content-disposition'), 'attachment; filename="Linkpearl-1.2.0.apk"');
const body = new Uint8Array(await a.arrayBuffer());
assert.equal(body.length, apk.length); assert.equal(await sha256hex(body), latest.sha256, 'the bytes that were published');
console.log('apk', a.status, a.headers.get('content-type'), a.headers.get('content-length'), a.headers.get('cache-control'));

// only the latest build, by its code; bad input; methods; paths; auth
assert.equal((await authed(phone, U + '/apk?code=5')).status, 404, 'an older code');
assert.equal((await authed(phone, U + '/apk?code=7')).status, 404, 'a newer code');
for (const q of ['', '?code=', '?code=abc', '?code=-1', '?code=1.2.0', '?code=12345678901']) assert.equal((await authed(phone, U + '/apk' + q)).status, 400, q);
assert.equal((await authed(phone, U, { method: 'POST', body: {} })).status, 405);
assert.equal((await authed(phone, U + '/apk?code=6', { method: 'POST', body: {} })).status, 405);
assert.equal((await authed(phone, U + '/apk/6')).status, 404); assert.equal((await authed(phone, U + '/x')).status, 404);
assert.equal((await fetchRaw(U + '/apk?code=6', null)).status, 401, 'no token, no APK');
assert.equal((await authed(null, U)).status, 401);
const pending = await registerPhone('Waiting'); assert.equal((await authed(pending, U)).status, 403); assert.equal((await fetchRaw(U + '/apk?code=6', pending)).status, 403);

// latest.json points at an APK that is not there: 404 for the APK (the answer still names the build)
await E.RELEASES.put(LATEST_KEY, JSON.stringify(Object.assign({}, latest, { code: 7, name: '1.3.0' })));
assert.equal((await authed(phone, U)).j.latest.code, 7);
assert.equal((await authed(phone, U + '/apk?code=7')).status, 404);
// a broken latest.json: latest null
for (const bad of ['not json', '{"code":"7"}', 'null']) {
  await E.RELEASES.put(LATEST_KEY, bad);
  r = await authed(phone, U); assert.equal(r.status, 200, bad); assert.deepEqual(r.j, { latest: null, min: MIN_APP }, bad);
  assert.equal((await authed(phone, U + '/apk?code=6')).status, 404, bad);
}
// a bucket that throws (e.g. not created yet): latest null, never a 500
const real = E.RELEASES;
E.RELEASES = { get: async () => { throw new Error('bucket not found'); } };
r = await authed(phone, U); assert.equal(r.status, 200); assert.deepEqual(r.j, { latest: null, min: MIN_APP });
// no binding at all
delete E.RELEASES;
r = await authed(phone, U); assert.equal(r.status, 200); assert.deepEqual(r.j, { latest: null, min: MIN_APP });
assert.equal((await authed(phone, U + '/apk?code=6')).status, 404);
E.RELEASES = real;

await T.dispose();
console.log('mobile-update: all passed');
