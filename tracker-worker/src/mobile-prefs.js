/*
  Linkpearl: the phone's own settings, under /v1/agents/m/prefs… (stream: Settings). Device-authenticated by mobile-agent.js: the caller is a registered,
  owner-approved phone, and every route here acts on THAT phone only (device.id comes from the Bearer token, never from the request).
    GET  /v1/agents/m/prefs         → { v, device: { id, name, kind, fingerprint }, stores: [{ id, name, lastScanAt }], now, minApp: { code, name } }
    POST /v1/agents/m/prefs/name    { name }  → { ok, name }     rename this phone (same rules as registration: control characters stripped, 60 chars, not empty)
    POST /v1/agents/m/prefs/forget  → { ok: true }               this phone revokes ITSELF: same effect as Remove on the admin site (token dead, wrapped keys deleted)
  No customer or staff names anywhere. Store names are the owner's own store list (store_access); lastScanAt is the newest tracker scan of that store (ISO UTC) or null.
  The phone stores nothing server-side here, so there is no migration. Writes are one row, one device.
*/

// The oldest app the server still accepts. Raise `code` (the Android versionCode) in the same deploy as a breaking change: the app shows an update notice
// instead of failing. Today every build is acceptable.
export const MIN_APP = { code: 1, name: '0.1.0' };

const sha256hex = async (t) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map((x) => x.toString(16).padStart(2, '0')).join('');
// 3F2A-91C0-7B44-0DDE: the same fingerprint the admin site shows next to this phone (index.js fingerprint)
const fingerprint = async (k) => (await sha256hex(JSON.stringify({ crv: k.crv, kty: k.kty, x: k.x, y: k.y }))).slice(0, 16).toUpperCase().match(/.{4}/g).join('-');

export async function prefsApi(req, env, url, device, h) {
  const path = url.pathname.replace(/^\/v1\/agents\/m\/prefs/, '') || '/';
  const T = env.TR;

  if (path === '/') {
    if (req.method !== 'GET') return h.fail(405, 'GET only');
    const ids = [...new Set(device.stores)].sort((a, b) => a - b);
    const names = new Map();
    if (env.AE && ids.length) {
      const r = await env.AE.prepare('SELECT store, name FROM store_access').all().catch(() => ({ results: [] }));
      for (const s of r.results) names.set(s.store, s.name || null);
    }
    const scans = new Map();
    for (const id of ids) scans.set(id, ((await T.prepare('SELECT MAX(at) AS at FROM scans WHERE store = ?').bind(id).first()) || {}).at || null);
    return h.json({
      v: 1,
      device: { id: device.id, name: device.name, kind: device.kind, fingerprint: await fingerprint(device.publicJwk) },
      stores: ids.map((id) => ({ id, name: names.get(id) || null, lastScanAt: scans.get(id) })),
      now: h.now(),
      minApp: MIN_APP,
    });
  }

  if (path === '/name') {
    if (req.method !== 'POST') return h.fail(405, 'POST only');
    const b = await h.readJson(req, 1000), name = h.clean(b && b.name, 60);
    if (!name) return h.fail(400, 'name required');
    await T.prepare('UPDATE agents SET name = ? WHERE id = ?').bind(name, device.id).run();
    await h.log(env, 'device:' + name, 'device:rename', null, null, device.name + ' -> ' + name);
    return h.json({ ok: true, name });
  }

  if (path === '/forget') {
    if (req.method !== 'POST') return h.fail(405, 'POST only');
    // exactly what Remove does on the admin site (index.js trackerAdmin /agents/:id/remove), for this device only
    await T.batch([T.prepare('DELETE FROM agent_keys WHERE agent_id = ?').bind(device.id), T.prepare('DELETE FROM agents WHERE id = ?').bind(device.id)]);
    await T.prepare('DELETE FROM agent_kind WHERE agent_id = ?').bind(device.id).run().catch(() => {});
    await h.log(env, 'device:' + device.name, 'device:forget', null, null, device.id);
    return h.json({ ok: true });
  }

  return h.fail(404, 'not found');
}
