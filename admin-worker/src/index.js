/*
  Aethernet admin site. Served at aethernet-admin.<account>.workers.dev
  with Cloudflare Access in front of the whole hostname; the Waymark Worker that stores
  use is separate and untouched.

  Every request must carry a valid Cloudflare Access token (Cf-Access-Jwt-Assertion,
  RS256, checked against the team's certs, audience = POLICY_AUD, not expired). No
  token, a bad one, or Access not configured yet (TEAM_DOMAIN / POLICY_AUD empty)
  → 403. So the site shows nothing until Access is on, even if it's deployed first.

    GET  /            the admin app (one page)
    *    /api/…       the shared admin routes (worker/src/index.js adminApi): feedback,
                      usage, stores, auto-rules, store/:store
    *    /api/tracker/…  the work order tracker (tracker-worker/src/index.js trackerAdmin),
                      as the signed-in Access user; needs the TR binding

  Per-person access (Oct 17, 2026): after the Access check, every /api/… and /metrics… request goes
  through one gate (tracker-worker/src/access.js): route → page, deny by default, store scope, developers
  (TRACKER_OWNERS) bypass. Refusals are 403 { error, page } and an access_log 'denied' row. Pages
  are only drawn for what GET /api/tracker/me says the person has.
    GET  /metrics-ui.js  the Metrics page (loaded by page.js on first use; data from /api/tracker/metrics)
    GET  /rulegraph.js, /assize-rules.js   the rule graph interpreter and Assize's rules engine as browser modules
                      (page 'rules'; the same files the tracker Worker imports and build.py inlines into Aethernet)
    GET  /rules-ui.js    the Assize rules editor (page 'rules'; loaded by page.js on first use)
  Local testing only: `wrangler dev --var LOCAL_TEST:1` lets requests to localhost in.
*/
import { adminApi } from '../../worker/src/index.js';
import { trackerAdmin } from '../../tracker-worker/src/index.js';
import { accessOf, check } from '../../tracker-worker/src/access.js';
import { PAGE } from './page.js';
import CRYPTO_SRC from '../../tracker-worker/src/crypto.js';
import WORDS from './words.txt';
import TRACKER_UI from './tracker-ui.js';
import METRICS_UI from './metrics-ui.js';
import RULES_UI from './rules-ui.js';
// Assize's rules engine and the graph interpreter, as text for the page (the Assize rules editor runs them in the
// browser); the tracker Worker imports the same files as code.
import RULEGRAPH_SRC from '../../tracker-worker/src/rulegraph.js' with { type: 'text' };
import ASSIZE_RULES_SRC from '../../tracker-worker/src/assize-rules.js' with { type: 'text' };
const SHARED = { '/rulegraph.js': RULEGRAPH_SRC, '/assize-rules.js': ASSIZE_RULES_SRC, '/rules-ui.js': RULES_UI };

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const parse = (s) => JSON.parse(new TextDecoder().decode(b64url(s)));
let certs = null, certsAt = 0;

async function verify(req, env) {
  const url = new URL(req.url);
  if (env.LOCAL_TEST && /^(localhost|127\.0\.0\.1)$/.test(url.hostname)) return { email: new URL(req.url).searchParams.get('as') || (req.headers.get('cookie') || '').match(/(?:^|; )as=([^;]+)/)?.[1] || 'local-test' }; // ?as= / cookie as=: act as someone else (local only)
  if (!env.TEAM_DOMAIN || !env.POLICY_AUD) throw new Error("Cloudflare Access isn't set up for this site yet.");
  const token = req.headers.get('cf-access-jwt-assertion');
  if (!token) throw new Error('Sign in through Cloudflare Access.');
  const [h, p, sig] = token.split('.');
  const head = parse(h), body = parse(p);
  if (head.alg !== 'RS256') throw new Error('Unexpected token.');
  if (!certs || Date.now() - certsAt > 3600000) {
    const r = await fetch('https://' + env.TEAM_DOMAIN + '/cdn-cgi/access/certs');
    certs = (await r.json()).keys; certsAt = Date.now();
  }
  const jwk = certs.find((k) => k.kid === head.kid);
  if (!jwk) throw new Error('Unknown signing key.');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(sig), new TextEncoder().encode(h + '.' + p));
  const aud = Array.isArray(body.aud) ? body.aud : [body.aud];
  if (!ok || !aud.includes(env.POLICY_AUD) || !(body.exp * 1000 > Date.now()) || body.iss !== 'https://' + env.TEAM_DOMAIN) throw new Error('Not signed in.');
  return { email: body.email };
}

const deny = (why) => new Response(why, { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

export default {
  async fetch(req, env) {
    let who;
    try { who = await verify(req, env); } catch (e) { return deny(e.message); }
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(PAGE.replace('__EMAIL__', String(who.email || '').replace(/[<>&"]/g, '')), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY',
          'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://assets.asurion-ui.my.asurion53.com; img-src 'self' data:; connect-src 'self'" } });
    }
    // The tracker's encryption, as a module for the page (unlocking happens in the browser).
    if (url.pathname === '/crypto.js') return new Response(CRYPTO_SRC, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } });
    if (url.pathname === '/tracker-ui.js') return new Response(TRACKER_UI, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } });
    if (url.pathname === '/words.txt') return new Response(WORDS, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'max-age=86400' } });
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/metrics') && !SHARED[url.pathname]) return new Response('Not found', { status: 404 });
    // The access gate: nothing below runs for a route, page or store this person wasn't given.
    if (!env.TR) return new Response(JSON.stringify({ error: 'tracker database not bound' }), { status: 503, headers: { 'content-type': 'application/json' } });
    const me = await accessOf(env, who.email);
    const denied = await check(env, me, who.email, req.method, url.pathname, url.search);
    if (denied) return new Response(JSON.stringify(denied), { status: 403, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    // The Metrics page's own script: after the gate, so only people with page 'metrics' get it.
    if (url.pathname === '/metrics-ui.js') return new Response(METRICS_UI, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } });
    // The Assize rules editor and its engine (page 'rules'): import * as RG from '/rulegraph.js'; import { makeRules } from '/assize-rules.js'.
    if (SHARED[url.pathname]) return new Response(SHARED[url.pathname], { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } });
    if (!url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404 });
    // The next public version (status.json's latest, minor + 1): the default "fixed in" for quoting a report.
    if (url.pathname === '/api/next-version') {
      try {
        const st = await (await fetch('https://gist.githubusercontent.com/Unix-Epoch/0cf4560c4f26d8ff9091a10068fd3464/raw/status.json?t=' + Date.now())).json();
        const [x, y] = String(st.latest.version).split('.').map(Number);
        return new Response(JSON.stringify({ latest: st.latest.version, next: x + '.' + (y + 1) + '.0' }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
      } catch (e) { return new Response(JSON.stringify({ next: '' }), { headers: { 'content-type': 'application/json' } }); }
    }
    if (url.pathname.startsWith('/api/tracker/')) {
      try { return await trackerAdmin(req, env, url, url.pathname.replace(/^\/api\/tracker/, ''), who.email, me); }
      catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: e.status || 500, headers: { 'content-type': 'application/json' } }); }
    }
    if (url.pathname.startsWith('/api/')) {
      try {
        const res = await adminApi(req, env, url, url.pathname.replace(/^\/api/, ''), me);
        const h = new Headers(res.headers); h.set('cache-control', 'no-store'); h.delete('access-control-allow-origin');
        return new Response(res.body, { status: res.status, headers: h });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response('Not found', { status: 404 });
  },
};
