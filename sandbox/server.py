#!/usr/bin/env python3
"""Portal sandbox — Portal's real web app on fake data, for testing Aethernet.

  python3 sandbox/server.py            → http://localhost:8790

- Pages: Portal's own index.html (FullStory/Appcues tracking removed).
- /assets/*: Portal's public app files, fetched read-only from
  portal.ubreakifix.net and cached in sandbox/.cache/.
- /api/*: answered here from a fake store (sandbox/state.json); nothing is
  ever sent to Portal's API. Unknown endpoints are logged (/sandbox shows them).
- /sandbox: make fake work orders and arrivals, reset, see the call log.
"""
import json, os, re, sys, threading, urllib.request
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path

PORTAL = 'https://portal.ubreakifix.net'
PORT = int(os.environ.get('SANDBOX_PORT', '8790'))
HERE = Path(__file__).resolve().parent
CACHE = HERE / '.cache'
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36'
ORIGIN = f'http://localhost:{PORT}'
LOG = []          # recent /api calls: (method, path, status)
# Portal's app only uses the page's own address for its API if it's on its allowlist,
# otherwise it calls real Portal, and its live-updates socket is hard-wired. Rewrite both
# to the sandbox. The CSP header below is the backstop: the browser itself refuses to
# send anything from a sandbox page anywhere but here (and Portal's icon/font host).
REWRITES = [
    ('["https://portal.ubreakifix.net", "https://portal.ubif.net"]', f'["{ORIGIN}"]'),
    ('wss://portal.ubreakifix.net', f'ws://localhost:{PORT}'),
    ('https://portal.ubreakifix.net', ORIGIN),
    ('https://portal.ubif.net', ORIGIN),
]
UI_HOST = 'https://assets.asurion-ui.my.asurion53.com'
CSP = ("default-src 'self' " + UI_HOST + " data: blob:; "
       "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline' " + UI_HOST + "; "
       "img-src 'self' data: blob: " + UI_HOST + "; font-src 'self' data: " + UI_HOST + "; "
       # Contentful = Portal's interface text (public, read-only); nothing else leaves the sandbox.
       "connect-src 'self' ws://localhost:" + str(PORT) + " " + UI_HOST + " https://cdn.contentful.com; frame-src 'none'")
LOCK = threading.Lock()


def fetch_portal(path):
    """GET a public file from Portal (cached). Only /assets and the index page."""
    key = CACHE / re.sub(r'[^A-Za-z0-9._-]', '_', path.lstrip('/') or 'index')
    if key.exists():
        return key.read_bytes()
    req = urllib.request.Request(PORTAL + path, headers={'User-Agent': UA})
    data = urllib.request.urlopen(req, timeout=30).read()
    CACHE.mkdir(exist_ok=True)
    key.write_bytes(data)
    return data


def index_html():
    html = fetch_portal('/').decode()
    # No session replay / onboarding trackers in the sandbox.
    html = re.sub(r'<script>\s*window\[\'_fs_host\'\].*?</script>', '', html, flags=re.S)
    html = re.sub(r'<script[^>]*appcues[^>]*>\s*</script>', '', html, flags=re.I)
    html = re.sub(r'<script>\s*window\.AppcuesSettings.*?</script>', '', html, flags=re.S)
    return html.encode()


class Handler(BaseHTTPRequestHandler):
    server_version = 'PortalSandbox/1'

    def log_message(self, *a):
        pass

    def send(self, status, body=b'', ctype='application/json', extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(n) if n else b''
        try:
            return json.loads(raw) if raw else None
        except ValueError:
            return raw.decode(errors='replace')

    def route(self, method):
        path = self.path.split('?')[0]
        if path.startswith('/api/'):
            import api  # sandbox/api.py: the fake back end
            status, out = api.handle(method, self.path, self.body())
            with LOCK:
                LOG.append((method, self.path[:200], status))
                del LOG[:-400]
            return self.send(status, out)
        if path.startswith('/sandbox'):
            import admin
            return admin.handle(self, method, LOG)
        if path.startswith('/assets/'):
            try:
                data = fetch_portal(self.path)
            except Exception as e:
                return self.send(404, str(e), 'text/plain')
            ext = path.rsplit('.', 1)[-1]
            if ext in ('js', 'json') or '.js' in path:
                text = data.decode('utf-8', errors='surrogateescape')
                for a, b in REWRITES:
                    text = text.replace(a, b)
                data = text.encode('utf-8', errors='surrogateescape')
            if '.js' in path and ext not in ('json',):
                ext = 'js'
            ctype = {'js': 'application/javascript', 'css': 'text/css', 'json': 'application/json', 'svg': 'image/svg+xml',
                     'png': 'image/png', 'jpg': 'image/jpeg', 'woff2': 'font/woff2', 'woff': 'font/woff'}.get(ext, 'application/octet-stream')
            return self.send(200, data, ctype)
        if path in ('/favicon.ico',):
            return self.send(404, b'', 'text/plain')
        return self.send(200, index_html(), 'text/html; charset=utf-8', {'Content-Security-Policy': CSP})

    def do_GET(self): self.route('GET')
    def do_POST(self): self.route('POST')
    def do_PUT(self): self.route('PUT')
    def do_PATCH(self): self.route('PATCH')
    def do_DELETE(self): self.route('DELETE')


if __name__ == '__main__':
    sys.path.insert(0, str(HERE))
    print(f'Portal sandbox on http://localhost:{PORT}  (control page: http://localhost:{PORT}/sandbox)')
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
