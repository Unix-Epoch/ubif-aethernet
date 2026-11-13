/*
  Linkpearl, the Aethernet phone app: the shell served under /m (owners only; the access gate in index.js has already run).
    /m  /m/            the page (one HTML document; its script and styles are separate same-origin files, so the policy needs no nonce)
    /m/app.js /m/app.css /m/manifest.webmanifest /m/sw.js (Service-Worker-Allowed: /m) /m/icon.svg /m/icon-192.png /m/icon-512.png /m/icon-maskable-512.png
  Data: GET /api/m/home (tracker-worker/src/mobile.js).
*/
import APP_JS from './m-app.js' with { type: 'text' };
import APP_CSS from './m-app.css' with { type: 'text' };
import SW_JS from './m-sw.js' with { type: 'text' };
import { SVG, PNG } from './m-icons.js';

// A short hash of the shell's files: the service worker's cache name, so any change installs a new worker and drops the old cache.
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
const VERSION = hash(APP_JS + APP_CSS + SW_JS + SVG);

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Linkpearl</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#1b0f41" media="(prefers-color-scheme: dark)"><meta name="theme-color" content="#f4f4f4" media="(prefers-color-scheme: light)">
<meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes">
<link rel="manifest" href="/m/manifest.webmanifest" crossorigin="use-credentials">
<link rel="icon" href="/m/icon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/m/icon-192.png">
<link rel="stylesheet" href="/m/app.css">
</head><body><div id="app"></div><script src="/m/app.js"></script></body></html>`;

// One scheme per manifest (the page's theme-color meta tags follow the phone's setting): the dark one, which is also the splash.
const MANIFEST = JSON.stringify({
  name: 'Linkpearl', short_name: 'Linkpearl', id: '/m', start_url: '/m', scope: '/m', display: 'standalone',
  theme_color: '#1b0f41', background_color: '#1b0f41',
  icons: [{ src: '/m/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: '/m/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/m/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }, { src: '/m/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
});

const bin = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const base = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' };
const file = (body, type, extra = {}) => new Response(body, { headers: Object.assign({ 'content-type': type }, base, extra) });
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function shell(pathname) {
  switch (pathname) {
    case '/m': case '/m/': return file(HTML, 'text/html; charset=utf-8', { 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'content-security-policy': CSP, 'referrer-policy': 'no-referrer' });
    case '/m/app.js': return file(APP_JS, 'text/javascript; charset=utf-8');
    case '/m/app.css': return file(APP_CSS, 'text/css; charset=utf-8');
    case '/m/sw.js': return file('const V = ' + JSON.stringify(VERSION) + ';\n' + SW_JS, 'text/javascript; charset=utf-8', { 'service-worker-allowed': '/m' });
    case '/m/manifest.webmanifest': return file(MANIFEST, 'application/manifest+json');
    case '/m/icon.svg': return file(SVG, 'image/svg+xml');
    case '/m/icon-192.png': return file(bin(PNG['icon-192']), 'image/png');
    case '/m/icon-512.png': return file(bin(PNG['icon-512']), 'image/png');
    case '/m/icon-maskable-512.png': return file(bin(PNG['icon-maskable-512']), 'image/png');
    default: return new Response('Not found', { status: 404 });
  }
}
