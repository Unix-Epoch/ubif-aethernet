/*
  Aethernet links Worker (aethersp.here). Short install links, plus a pass-through of each channel's
  published files on its secret Gist, so the userscript's @updateURL/@downloadURL and status.json can
  live on aethersp.here while publishing still writes to the Gists (build.py).

    GET /aen/install                     302 → /aen/aethernet.user.js
    GET /aen/early                       302 → /aen/early/aethernet.user.js
    GET /oracle/dev/<key>                302 → /oracle/dev/<key>/aethernet.user.js
    GET /aen/<file>                      public channel
    GET /aen/early/<file>                early access channel (EARLY_GIST secret)
    GET /oracle/dev/<key>/<file>         dev channel; <key> must equal the DEV_KEY secret
  <file> is one of FILES. Anything else, a wrong key, or a channel whose secret isn't set is a plain 404.
  Nothing is cached here (status.json carries the kill switch).
*/
const OWNER = 'Unix-Epoch';
const FILES = new Set(['aethernet.user.js', 'aethernet.meta.js', 'aethernet.readable.js', 'status.json']);
const TYPES = { js: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8' };
const NO_STORE = { 'cache-control': 'no-store' };

const notFound = () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', ...NO_STORE } });
const redirect = (to) => new Response(null, { status: 302, headers: { location: to, ...NO_STORE } });

// Constant-time string compare, so the dev key can't be guessed a character at a time from response timing.
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const devKeyOk = (env, key) => typeof env.DEV_KEY === 'string' && env.DEV_KEY.length >= 24 && same(key, env.DEV_KEY);

/** { gist, file } for a file path, a redirect target string for a short link, or null. */
function route(path, env) {
  if (path === '/aen/install') return '/aen/aethernet.user.js';
  if (path === '/aen/early') return '/aen/early/aethernet.user.js';
  let m = path.match(/^\/oracle\/dev\/([A-Za-z0-9_-]+)(?:\/([a-z.]+))?$/);
  if (m) {
    if (!devKeyOk(env, m[1])) return null;
    return m[2] ? { gist: env.DEV_GIST, file: m[2] } : `/oracle/dev/${m[1]}/aethernet.user.js`;
  }
  m = path.match(/^\/aen\/(?:(early)\/)?([a-z.]+)$/);
  if (m) return { gist: m[1] ? env.EARLY_GIST : env.PUBLIC_GIST, file: m[2] };
  return null;
}

export default {
  async fetch(req, env) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
    const url = new URL(req.url);
    const r = route(url.pathname.replace(/\/+$/, ''), env);
    if (typeof r === 'string') return redirect(r);
    if (!r || !FILES.has(r.file) || !/^[0-9a-f]{20,40}$/.test(r.gist || '')) return notFound();

    // ?t= (status.json's cache bust) is passed on; GitHub's raw cache keys on the full URL.
    const src = `https://gist.githubusercontent.com/${OWNER}/${r.gist}/raw/${r.file}${url.search}`;
    let res;
    try {
      res = await fetch(src, { method: req.method, cf: { cacheTtl: 0 } });
    } catch {
      return new Response('Upstream unavailable', { status: 502, headers: NO_STORE });
    }
    if (!res.ok) return res.status === 404 ? notFound() : new Response('Upstream error', { status: 502, headers: NO_STORE });
    return new Response(req.method === 'HEAD' ? null : res.body, {
      status: 200,
      headers: {
        'content-type': TYPES[r.file.split('.').pop()],
        'access-control-allow-origin': '*', // Aethernet reads status.json from Portal's page
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        ...NO_STORE,
      },
    });
  },
};
