/*
  Push: wakes a phone through Firebase Cloud Messaging (FCM HTTP v1). Used by Linkshell when the PC asks the phone to start
  something (a frame sent with wake: true, src/linkshell.js), so the phone hears about it even with Linkpearl closed.

  What goes to Google is a data-only ping: { t: 'linkshell', link, kind, id } (the link's id, the message's fixed kind word such as
  "pullbacks.run", and its id). No customer, job or store data; the phone fetches the sealed message itself over its Linkshell socket.

  The phone's token, one per device (so more phones and more people need nothing new):
    phone  POST   /v1/agents/m/push  { token, platform: 'android' | 'ios' }  → { ok: true }
    phone  DELETE /v1/agents/m/push                                         → { ok: true }
  Tokens live in push_tokens (migration 2026-11-17-push.sql) and go when the device is removed, or when FCM says the token is dead.

  Setup: the Worker secret FCM_SERVICE_ACCOUNT holds the Firebase service-account key (the whole JSON). Without it, pushes are
  skipped and everything else works as before. iOS: FCM forwards to APNs, so an iPhone's FCM token works here too; the message
  for 'ios' carries an alert (mutable, so the app can reword it) because iOS doesn't run an app for a data-only ping.
*/
import { json, fail, readJson } from './http.js';

export const PUSH = { SCOPE: 'https://www.googleapis.com/auth/firebase.messaging', TOKEN_URL: 'https://oauth2.googleapis.com/token', TTL_S: 600 };
const TOKEN = /^[A-Za-z0-9_:.\-]{20,4096}$/, PLATFORMS = ['android', 'ios'];

// ------------------------------------------------------------------ phone routes
export async function pushApi(req, env, url, device, h) {
  const T = env.TR, what = url.pathname.replace(/^\/v1\/agents\/m\/push\/?/, '');
  if (what !== '') return fail(404, 'not found');
  if (req.method === 'DELETE') {
    await T.prepare('DELETE FROM push_tokens WHERE agent_id = ?').bind(device.id).run();
    return json({ ok: true });
  }
  if (req.method !== 'POST') return fail(405, 'method not allowed');
  const b = await readJson(req, 5000);
  if (typeof b.token !== 'string' || !TOKEN.test(b.token)) return fail(400, 'token required');
  const platform = PLATFORMS.includes(b.platform) ? b.platform : 'android';
  await T.prepare('INSERT INTO push_tokens (agent_id, platform, token, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET platform = excluded.platform, token = excluded.token, updated_at = excluded.updated_at')
    .bind(device.id, platform, b.token, new Date().toISOString()).run();
  return json({ ok: true });
}

// ------------------------------------------------------------------ sending
const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uText = (s) => b64u(new TextEncoder().encode(s));

let account = null, accountRaw = null, access = null; // per isolate: the parsed key and a Google access token (~1 hour)

function accountOf(env) {
  const raw = env.FCM_SERVICE_ACCOUNT;
  if (!raw) return null;
  if (raw !== accountRaw) {
    accountRaw = raw; access = null;
    try {
      const a = JSON.parse(raw);
      account = a && a.client_email && a.private_key && a.project_id ? a : null;
    } catch (_) { account = null; }
    if (!account) console.error('push: FCM_SERVICE_ACCOUNT is not a service-account key');
  }
  return account;
}

async function accessToken(a, fetchFn) {
  if (access && access.exp > Date.now() + 60000) return access.token;
  const der = Uint8Array.from(atob(a.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const iat = Math.floor(Date.now() / 1000);
  const unsigned = b64uText(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' +
    b64uText(JSON.stringify({ iss: a.client_email, scope: PUSH.SCOPE, aud: PUSH.TOKEN_URL, iat, exp: iat + 3600 }));
  const jwt = unsigned + '.' + b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));
  const r = await fetchFn(PUSH.TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt });
  if (!r.ok) throw new Error('push: Google token ' + r.status);
  const j = await r.json();
  access = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return access.token;
}

// The FCM message for one device. Android: data only, high priority (the app decides between a notification and its banner).
export function fcmMessage(platform, token, data, alert) {
  const m = { token, data };
  if (platform === 'ios') m.apns = { headers: { 'apns-priority': '10', 'apns-push-type': 'alert' }, payload: { aps: { alert, 'mutable-content': 1 } } };
  else m.android = { priority: 'HIGH', ttl: PUSH.TTL_S + 's' };
  return { message: m };
}

/*
  Sends `data` (string values only) to one phone. Returns 'sent', 'off' (no secret), 'none' (no token), 'gone' (token dead,
  removed) or 'failed'. Never throws.
*/
export async function sendPush(env, agentId, data, alert = { title: 'Linkpearl' }, fetchFn = fetch) {
  try {
    const a = accountOf(env);
    if (!a) return 'off';
    const row = await env.TR.prepare('SELECT platform, token FROM push_tokens WHERE agent_id = ?').bind(agentId).first();
    if (!row) return 'none';
    const send = async () => fetchFn('https://fcm.googleapis.com/v1/projects/' + encodeURIComponent(a.project_id) + '/messages:send', {
      method: 'POST', headers: { authorization: 'Bearer ' + (await accessToken(a, fetchFn)), 'content-type': 'application/json' },
      body: JSON.stringify(fcmMessage(row.platform, row.token, data, alert)),
    });
    let r = await send();
    if (r.status === 401) { access = null; r = await send(); }
    if (r.ok) return 'sent';
    const body = await r.text().catch(() => '');
    if (r.status === 404 || /UNREGISTERED|registration-token-not-registered/.test(body) || (r.status === 400 && /"token"|registration token/i.test(body))) {
      await env.TR.prepare('DELETE FROM push_tokens WHERE agent_id = ? AND token = ?').bind(agentId, row.token).run();
      return 'gone';
    }
    console.error('push: FCM ' + r.status + ' ' + body.slice(0, 300));
    return 'failed';
  } catch (e) {
    console.error('push failed:', e && e.message);
    return 'failed';
  }
}

export const _test = { reset: () => { account = null; accountRaw = null; access = null; } };
