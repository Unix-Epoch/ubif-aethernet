/* Linkpearl service worker, scope /m. Caches only the app shell (under /m) and the last good Home answer per store (/api/m/home).
   Nothing else is ever stored or touched: every other request returns before respondWith, so the browser handles it normally.
   A cached Home answer is always marked (x-lp-cached) so the page says Offline and shows its "as of"; it is never presented as fresh.
   Access: a signed-out session gets a redirect to Access's login. Navigations hand that redirect to the browser untouched; data fetches
   pass it back to the page (which shows Sign in); nothing that isn't a plain 200 is ever cached. V (the build hash) is added above this line. */
const SHELL = 'lp-shell-' + V, DATA = 'lp-data';
const FILES = ['/m', '/m/app.js', '/m/app.css', '/m/manifest.webmanifest', '/m/icon.svg', '/m/icon-192.png'];
const plain = (r) => r && r.ok && r.type === 'basic' && !r.redirected;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => Promise.all(FILES.map((u) => fetch(new Request(u, { cache: 'reload', redirect: 'manual', credentials: 'same-origin' })).then((r) => { if (!plain(r)) throw new Error('not signed in'); return c.put(u, r); })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('lp-shell-') && k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const homeKey = (url) => '/api/m/home?store=' + (new URL(url).searchParams.get('store') || 'all').replace(/[^\w]/g, '');
async function home(req) {
  const key = homeKey(req.url), c = await caches.open(DATA);
  try {
    const r = await fetch(req, { cache: 'no-store' }); // never the browser's own 60 s copy: offline must be seen as offline
    if (plain(r) && (r.headers.get('content-type') || '').includes('json')) await c.put(key, r.clone());
    return r;
  } catch (_) {
    const hit = await c.match(key);
    if (!hit) return new Response('{"error":"offline"}', { status: 503, headers: { 'content-type': 'application/json' } });
    const h = new Headers(hit.headers); h.set('x-lp-cached', '1'); h.set('cache-control', 'no-store');
    return new Response(hit.body, { status: 200, headers: h });
  }
}
async function page(req) {
  const c = await caches.open(SHELL);
  try { const r = await fetch(req); if (plain(r)) c.put('/m', r.clone()); return r; } catch (_) { return (await c.match('/m')) || Response.error(); }
}
async function asset(req, path) {
  const c = await caches.open(SHELL), hit = await c.match(path);
  const net = fetch(req).then((r) => { if (plain(r)) c.put(path, r.clone()); return r; });
  if (hit) { net.catch(() => {}); return hit; }
  return net;
}

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  const p = url.pathname;
  if (p === '/api/m/home') return e.respondWith(home(req));
  if (req.mode === 'navigate' && (p === '/m' || p === '/m/')) return e.respondWith(page(req));
  if (FILES.includes(p) && p !== '/m') return e.respondWith(asset(req, p));
});
