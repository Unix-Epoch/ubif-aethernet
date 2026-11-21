// Push (src/push.js): the phone's token routes, the FCM call (Google token + message), dead tokens, and Linkshell's wake rules.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { setup } from './mobile-helpers.mjs';
import { sendPush, fcmMessage, _test } from '../src/push.js';
import { LinkshellRoom, LS } from '../src/linkshell.js';

const T = await setup('.wrangler-test-push');
// a throwaway service account: a fresh RSA key in PKCS#8 PEM
const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const pk = Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64');
const SA = JSON.stringify({ type: 'service_account', project_id: 'linkpearl-test', client_email: 'push@linkpearl-test.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\n' + pk.match(/.{1,64}/g).join('\n') + '\n-----END PRIVATE KEY-----\n' });
const TOKEN = 'fcmTok3n:' + 'A'.repeat(140);

// a stand-in for Google: records calls, answers the token endpoint and FCM (status per call from `fcmAnswers`)
const calls = [];
let fcmAnswers = [];
const fakeFetch = async (url, o) => {
  calls.push({ url, o });
  if (url.startsWith('https://oauth2.googleapis.com/')) return new Response(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }), { status: 200 });
  const [status, body] = fcmAnswers.shift() || [200, '{"name":"projects/x/messages/1"}'];
  return new Response(body, { status });
};

try {
  const phone = await T.registerPhone('Pixel');
  await T.approve(phone, [914]);

  // routes: save, replace, reject junk, delete
  let r = await T.authed(phone, '/v1/agents/m/push', { method: 'POST', body: { token: 'short' } });
  assert.equal(r.status, 400);
  r = await T.authed(phone, '/v1/agents/m/push', { method: 'POST', body: { token: 'old-token-' + 'x'.repeat(30), platform: 'android' } });
  assert.equal(r.status, 200);
  r = await T.authed(phone, '/v1/agents/m/push', { method: 'POST', body: { token: TOKEN, platform: 'whatever' } });
  assert.equal(r.status, 200);
  let row = await T.env.TR.prepare('SELECT * FROM push_tokens WHERE agent_id = ?').bind(phone.id).first();
  assert.equal(row.token, TOKEN); assert.equal(row.platform, 'android', 'unknown platform → android');
  assert.equal((await T.authed(phone, '/v1/agents/m/push', { method: 'GET' })).status, 405);
  assert.equal((await T.authed(null, '/v1/agents/m/push', { method: 'POST', body: { token: TOKEN } })).status, 401);

  // no secret: nothing sent
  _test.reset();
  assert.equal(await sendPush({ TR: T.env.TR }, phone.id, { t: 'x' }, undefined, fakeFetch), 'off');
  assert.equal(calls.length, 0);

  // sent: a signed JWT for the token, then a data-only high-priority message
  const env = { TR: T.env.TR, FCM_SERVICE_ACCOUNT: SA };
  assert.equal(await sendPush(env, phone.id, { t: 'linkshell', link: 'l', kind: 'pullbacks.run', id: 'm1' }, undefined, fakeFetch), 'sent');
  assert.equal(calls.length, 2);
  const form = new URLSearchParams(calls[0].o.body);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [h64, c64, s64] = form.get('assertion').split('.');
  const claims = JSON.parse(Buffer.from(c64, 'base64url').toString());
  assert.equal(claims.iss, 'push@linkpearl-test.iam.gserviceaccount.com'); assert.equal(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
  assert.ok(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', kp.publicKey, Buffer.from(s64, 'base64url'), new TextEncoder().encode(h64 + '.' + c64)), 'signed with the key');
  assert.equal(calls[1].url, 'https://fcm.googleapis.com/v1/projects/linkpearl-test/messages:send');
  assert.equal(calls[1].o.headers.authorization, 'Bearer ya29.test');
  const sent = JSON.parse(calls[1].o.body).message;
  assert.deepEqual(sent, { token: TOKEN, data: { t: 'linkshell', link: 'l', kind: 'pullbacks.run', id: 'm1' }, android: { priority: 'HIGH', ttl: '600s' } });
  assert.ok(!('notification' in sent), 'data only');
  // the Google token is reused
  await sendPush(env, phone.id, { t: 'x' }, undefined, fakeFetch);
  assert.equal(calls.length, 3);
  // iOS (later): an alert through APNs
  assert.deepEqual(fcmMessage('ios', 't', { a: '1' }, { title: 'Linkpearl' }).message.apns.payload.aps, { alert: { title: 'Linkpearl' }, 'mutable-content': 1 });
  // FCM errors: a passing failure keeps the token; a dead token is removed
  fcmAnswers = [[500, 'oops']];
  assert.equal(await sendPush(env, phone.id, { t: 'x' }, undefined, fakeFetch), 'failed');
  assert.ok(await T.env.TR.prepare('SELECT 1 FROM push_tokens WHERE agent_id = ?').bind(phone.id).first());
  fcmAnswers = [[404, '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}']];
  assert.equal(await sendPush(env, phone.id, { t: 'x' }, undefined, fakeFetch), 'gone');
  assert.equal(await T.env.TR.prepare('SELECT 1 FROM push_tokens WHERE agent_id = ?').bind(phone.id).first(), null);
  assert.equal(await sendPush(env, phone.id, { t: 'x' }, undefined, fakeFetch), 'none');
  // bad secret: off, never throws
  _test.reset();
  assert.equal(await sendPush({ TR: T.env.TR, FCM_SERVICE_ACCOUNT: '{"nope":1}' }, phone.id, { t: 'x' }, undefined, fakeFetch), 'off');
  // DELETE clears it
  await T.authed(phone, '/v1/agents/m/push', { method: 'POST', body: { token: TOKEN } });
  assert.equal((await T.authed(phone, '/v1/agents/m/push', { method: 'DELETE' })).status, 200);
  assert.equal(await T.env.TR.prepare('SELECT 1 FROM push_tokens WHERE agent_id = ?').bind(phone.id).first(), null);
  console.log('push: all passed');

  // ---------------------------------------------------------------- Linkshell wake: the relay asks for a push
  await T.authed(phone, '/v1/agents/m/push', { method: 'POST', body: { token: TOKEN } });
  const linkId = 'a'.repeat(32);
  await T.env.TR.prepare("INSERT INTO linkshell_links (id, store, agent_id, pc_token_hash, pc_name, pc_jwk, phone_jwk, created_at, used_at) VALUES (?, 914, ?, 'h', 'PC', '{}', '{}', 'x', 'x')").bind(linkId, phone.id).run();
  const db = new DatabaseSync(':memory:'), kv = new Map([['link', linkId]]), sockets = [];
  const ctx = {
    storage: {
      sql: { exec: (q, ...a) => { const st = db.prepare(q); const rows = /^\s*select/i.test(q) ? st.all(...a) : (st.run(...a), []); return { toArray: () => rows }; } },
      get: async (k) => kv.get(k), put: async (k, v) => { kv.set(k, v); }, getAlarm: async () => null, setAlarm: async () => {},
    },
    acceptWebSocket: (ws, tags) => { ws.tags = tags; sockets.push(ws); },
    getWebSockets: (tag) => sockets.filter((w) => w.readyState === 1 && (!tag || w.tags.includes(tag))),
    getTags: (ws) => ws.tags,
  };
  const pushes = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => { if (String(url).includes('fcm.googleapis.com')) pushes.push(JSON.parse(o.body).message.data); return fakeFetch(url, o); };
  try {
    _test.reset();
    const room = new LinkshellRoom(ctx, { TR: T.env.TR, FCM_SERVICE_ACCOUNT: SA });
    const pc = { sent: [], readyState: 1, send(s) { this.sent.push(s); }, close() { this.readyState = 3; } };
    await room.accept(pc, 'pc');
    const msg = (id, kind, wake) => JSON.stringify({ t: 'msg', id, kind, iv: 'AAAAAAAAAAAAAAAA', ct: 'c2VhbGVk', ...(wake ? { wake: true } : {}) });
    await room.webSocketMessage(pc, msg('w0000001', 'pullbacks.result'));
    assert.equal(pushes.length, 0, 'no wake flag: no push');
    await room.webSocketMessage(pc, msg('w0000002', 'pullbacks.run', true));
    assert.deepEqual(pushes, [{ t: 'linkshell', link: linkId, kind: 'pullbacks.run', id: 'w0000002' }]);
    assert.equal(JSON.parse(db.prepare("SELECT frame FROM held WHERE id = 'w0000002'").get().frame).wake, undefined, 'the flag is not relayed');
    await room.webSocketMessage(pc, msg('w0000002', 'pullbacks.run', true));
    kv.set('pushAt', 0);
    await room.webSocketMessage(pc, msg('w0000002', 'pullbacks.run', true));
    assert.equal(pushes.length, 1, 'a resent id is pushed once');
    await room.webSocketMessage(pc, msg('w0000003', 'pullbacks.run', true));
    assert.equal(pushes.length, 2);
    await room.webSocketMessage(pc, msg('w0000004', 'pullbacks.run', true));
    assert.equal(pushes.length, 2, `at most one push per ${LS.PUSH_GAP_MS / 1000} s`);
    const ph = { sent: [], readyState: 1, send(s) { this.sent.push(s); }, close() { this.readyState = 3; } };
    await room.accept(ph, 'phone');
    kv.set('pushAt', 0);
    await room.webSocketMessage(ph, msg('w0000005', 'pullbacks.scan', true));
    assert.equal(pushes.length, 2, 'only the PC wakes the phone');
    await T.env.TR.prepare("INSERT INTO alert_device (device_id, settings, read_upto, updated_at) VALUES (?, ?, 0, 'x')").bind(phone.id, JSON.stringify({ stores: { 914: false } })).run();
    kv.set('pushAt', 0);
    await room.webSocketMessage(pc, msg('w0000006', 'pullbacks.run', true));
    assert.equal(pushes.length, 2, "the link's store switched off on the phone: no push");
    await T.env.TR.prepare('UPDATE alert_device SET settings = ? WHERE device_id = ?').bind(JSON.stringify({ stores: { 914: true } }), phone.id).run();
    kv.set('pushAt', 0);
    await room.webSocketMessage(pc, msg('w0000007', 'pullbacks.run', true));
    assert.equal(pushes.length, 3, 'switched back on: pushed');
    console.log('push: linkshell wake passed');
  } finally { globalThis.fetch = realFetch; }
} finally {
  await T.dispose();
}
