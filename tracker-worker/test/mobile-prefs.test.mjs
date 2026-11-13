// Linkpearl phone API, the prefs area: STUB check. The stream that builds it replaces/extends this file (see MOBILE-API.md).
import assert from 'node:assert/strict';
import { setup } from './mobile-helpers.mjs';

const T = await setup('.wrangler-test-mobile-prefs');
const phone = await T.registerPhone('Pixel'); await T.approve(phone, [914]);
const base = '/v1/agents/m/' + ('prefs' === 'wo' ? 'wo' : 'prefs' === 'alerts' ? 'alerts' : 'prefs');
const r = await T.authed(phone, base);
assert.equal(r.status, 501); assert.deepEqual(r.j, { error: 'not built' });
const pending = await T.registerPhone('Waiting');
assert.equal((await T.authed(pending, base)).status, 403, 'not approved');
assert.equal((await T.authed(null, base)).status, 401, 'no token');
assert.equal((await T.authed({ id: phone.id, token: 'ab'.repeat(32) }, base)).status, 401, 'wrong token');
console.log('mobile-prefs: all passed');
await T.dispose();
