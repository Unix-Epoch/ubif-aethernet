/*
  Linkpearl: app updates, under /v1/agents/m/update… (phone API; dispatch in mobile-agent.js, reference in MOBILE-API-update.md).

    GET /v1/agents/m/update               → { latest: { code, name, size, sha256, notes? } | null, min: MIN_APP }
    GET /v1/agents/m/update/apk?code=<n>  → the APK (application/vnd.android.package-archive, content-length, no-store); only the latest build is served

  Releases live in the R2 bucket bound as RELEASES (linkpearl-releases), written by android/publish-release.sh:
    linkpearl/latest.json            { code, name, size, sha256[, notes] }   (code = versionCode, name = versionName)
    linkpearl/Linkpearl-<name>.apk   the signed APK
  No binding, no latest.json or an unreadable one: latest is null (never a 500), and the app keeps the build it has. min is the oldest build the server
  accepts (MIN_APP in mobile-prefs.js), so the app can tell a required update from an optional one.
*/
import { json, fail } from './http.js';
import { MIN_APP } from './mobile-prefs.js';

export const LATEST_KEY = 'linkpearl/latest.json';
export const apkKey = (name) => 'linkpearl/Linkpearl-' + name + '.apk';
const NAME_RE = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$/;

// latest.json, checked; null when absent or not the expected shape.
export function latestOf(o) {
  if (!o || typeof o !== 'object') return null;
  const { code, name, size, sha256, notes } = o;
  if (!Number.isInteger(code) || code < 1 || typeof name !== 'string' || !NAME_RE.test(name) || !Number.isInteger(size) || size < 1
    || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  const out = { code, name, size, sha256 };
  if (typeof notes === 'string' && notes.trim()) out.notes = notes.trim().slice(0, 2000);
  return out;
}
async function readLatest(env) {
  if (!env.RELEASES) return null;
  try {
    const obj = await env.RELEASES.get(LATEST_KEY);
    return obj ? latestOf(JSON.parse(await obj.text())) : null;
  } catch (_) { return null; } // a missing bucket or a bad file reads as "nothing published"
}

export async function updateApi(req, env, url, device, h) {
  const path = url.pathname.replace(/^\/v1\/agents\/m\/update/, '') || '/';
  if (path !== '/' && path !== '/apk') return fail(404, 'not found');
  if (req.method !== 'GET') return fail(405, 'GET only');
  const latest = await readLatest(env);
  if (path === '/') return json({ latest, min: MIN_APP });

  const code = url.searchParams.get('code');
  if (!code || !/^\d{1,9}$/.test(code)) return fail(400, 'code: a versionCode');
  if (!latest || latest.code !== Number(code)) return fail(404, 'no such build');
  const obj = await env.RELEASES.get(apkKey(latest.name));
  if (!obj) return fail(404, 'no such build');
  return new Response(obj.body, {
    status: 200,
    headers: {
      'content-type': 'application/vnd.android.package-archive',
      'content-length': String(obj.size),
      'content-disposition': 'attachment; filename="Linkpearl-' + latest.name + '.apk"',
      'cache-control': 'no-store',
    },
  });
}
