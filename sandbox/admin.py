"""The sandbox control page (/sandbox): make fake work orders and arrivals,
change the sandbox's settings, reset, and see Portal's calls (and which ones
the sandbox doesn't answer yet)."""
import api

PAGE = r"""<!doctype html><html><head><meta charset="utf-8"><title>Portal sandbox</title>
<style>
 :root { color-scheme: light dark; --bg:#f6f5f8; --card:#fff; --fg:#1a1c1e; --soft:#5d5e61; --line:#e4e2e8; --pri:#8223d2; }
 @media (prefers-color-scheme: dark) { :root { --bg:#131216; --card:#1d1c21; --fg:#ececf0; --soft:#a8a7ad; --line:#2e2d33; } }
 body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.45 -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif; }
 main { max-width:1100px; margin:0 auto; padding:20px 16px 60px; }
 h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:16px; margin:0 0 10px; }
 .soft { color:var(--soft); } .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; margin-top:16px; }
 .grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:16px; }
 label { display:block; margin:6px 0; } input[type=text], input[type=number] { width:100%; box-sizing:border-box; padding:7px 9px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); font:inherit; }
 .chk label { display:flex; gap:8px; align-items:center; margin:4px 0; }
 button { font:inherit; font-weight:600; padding:8px 14px; border-radius:10000px; border:1px solid var(--pri); background:var(--pri); color:#fff; cursor:pointer; }
 button.danger { border-color:#b91a24; background:#b91a24; }
 table { width:100%; border-collapse:collapse; font-size:13px; } th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
 th { color:var(--soft); font-weight:600; font-size:12px; } a { color:var(--pri); }
 .pill { display:inline-block; padding:1px 8px; border-radius:10000px; background:var(--bg); border:1px solid var(--line); font-size:12px; }
 .warn { color:#b91a24; } code { font-size:12px; } .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
 .banner { background:#fff4cc; color:#3d2e00; border-radius:10px; padding:10px 12px; margin-top:12px; }
</style></head><body><main>
<h1>Portal sandbox</h1>
<div class="soft">Portal's real app on fake data. Nothing here touches Portal: every <code>/api</code> call is answered by this Mac, and the page is blocked from contacting portal.ubreakifix.net.</div>
<div class="banner">Open <a href="/" target="_blank">the sandbox Portal</a> with the <b>Aethernet (dev)</b> script on. Turn the public Aethernet off while you test.</div>
<div class="grid">
 <div class="card"><h2>New device with cleanings</h2>
  <div class="soft">An Asurion Mobility work order (created now), plus cleaning arrivals for the same device, waiting in Arrivals.</div>
  <label>Customer <input type="text" id="name" placeholder="random"></label>
  <label>Device <input type="text" id="device" placeholder="random"></label>
  <div class="chk" id="progs"></div>
  <div class="chk"><label><input type="checkbox" id="parent" checked> Create the Asurion Mobility work order too</label></div>
  <div class="chk"><label><input type="checkbox" id="contacted"> Mark the arrivals Contacted</label></div>
  <div class="row"><button onclick="make()">Create</button><span id="made" class="soft"></span></div>
 </div>
 <div class="card"><h2>Sandbox settings</h2>
  <div class="chk"><label><input type="checkbox" id="open" onchange="settings()"> Store is open (Swiftcast refuses while it's closed)</label></div>
  <label>Price of refresh labor 10156 <input type="number" id="labor" step="0.01" onchange="settings()"></label>
  <div class="soft">Set above $0 to test Swiftcast taking the labor back out.</div>
  <div class="row" style="margin-top:12px"><button class="danger" onclick="reset()">Reset everything</button></div>
 </div>
</div>
<div class="card"><h2>Waiting in Arrivals</h2><div id="arrivals"></div></div>
<div class="card"><h2>Work orders</h2><div id="wos"></div></div>
<div class="card"><h2>Calls the sandbox doesn't answer yet</h2><div class="soft">Portal asked for these and got a 404. Tell Claude if something you're testing needs one.</div><div id="missing"></div></div>
<div class="card"><h2>Recent calls</h2><div id="log" style="max-height:320px;overflow:auto"></div></div>
<script>
const PROGS = {11759:'VZ Device Refresh', 9470:'VZ Sanitization', 11009:'AT&T Enhanced Cleaning', 9901:'AT&T Device Diagnostic', 10303:'AT&T Performance Check'};
document.getElementById('progs').innerHTML = Object.entries(PROGS).map(([id, n]) => `<label><input type="checkbox" value="${id}" ${id == 11759 || id == 9470 ? 'checked' : ''}> ${n}</label>`).join('');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function post(path, body) { const r = await fetch(path, {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body || {})}); return r.json(); }
async function make() {
  const programs = [...document.querySelectorAll('#progs input:checked')].map((i) => Number(i.value));
  const r = await post('/sandbox/device', { name: document.getElementById('name').value.trim(), device: document.getElementById('device').value.trim(), programs,
    parent: document.getElementById('parent').checked, contacted: document.getElementById('contacted').checked });
  document.getElementById('made').textContent = r.message || ''; refresh();
}
async function settings() { await post('/sandbox/settings', { storeOpen: document.getElementById('open').checked, laborPrice: Number(document.getElementById('labor').value || 0) }); refresh(); }
async function reset() { if (confirm('Delete every fake work order and arrival?')) { await post('/sandbox/reset'); refresh(); } }
async function refresh() {
  const s = await (await fetch('/sandbox/state')).json();
  document.getElementById('open').checked = s.settings.storeOpen;
  if (document.activeElement.id !== 'labor') document.getElementById('labor').value = s.settings.laborPrice;
  document.getElementById('arrivals').innerHTML = s.arrivals.length ? '<table><tr><th>Arrival</th><th>Program</th><th>Customer</th><th>Device / IMEI</th><th>Contacted</th></tr>' +
    s.arrivals.map((a) => `<tr><td><a href="/check-in/arrivals/${a.id}" target="_blank">${a.id}</a></td><td>${esc(a.program)}</td><td>${esc(a.customer)}</td><td>${esc(a.device)}<br><code>${a.imei}</code></td><td>${a.contacted ? 'yes' : ''}</td></tr>`).join('') + '</table>'
    : '<span class="soft">None. Create a device above.</span>';
  document.getElementById('wos').innerHTML = s.wos.length ? '<table><tr><th>WO</th><th>Program</th><th>Status</th><th>Customer</th><th>Cart</th><th>Notes</th></tr>' +
    s.wos.map((w) => `<tr><td><a href="/repair/workorder/${w.id}" target="_blank">${w.id}</a></td><td>${esc(w.program)}</td><td><span class="pill">${esc(w.status)}</span></td><td>${esc(w.customer)}</td><td>${w.cart.map((i) => esc(i.sku) + (i.price ? ' $' + i.price : '')).join(', ') || '—'}${w.sale ? '<br><span class="soft">' + esc(w.sale) + '</span>' : ''}</td><td>${w.notes}</td></tr>`).join('') + '</table>'
    : '<span class="soft">None yet.</span>';
  document.getElementById('missing').innerHTML = s.missing.length ? s.missing.map((m) => `<div><code>${esc(m)}</code></div>`).join('') : '<span class="soft">None.</span>';
  document.getElementById('log').innerHTML = '<table>' + s.log.map(([m, p, st]) => `<tr><td>${m}</td><td><code>${esc(p)}</code></td><td class="${st >= 400 ? 'warn' : ''}">${st}</td></tr>`).join('') + '</table>';
}
refresh(); setInterval(refresh, 3000);
</script></main></body></html>"""


def handle(h, method, log):
    path = h.path.split('?')[0].rstrip('/')
    if path == '/sandbox' and method == 'GET':
        return h.send(200, PAGE, 'text/html; charset=utf-8')
    with api.LOCK:
        s = api.load()
        if path == '/sandbox/state':
            arrivals = [{'id': a['arrivalId'], 'program': api.PROGRAMS.get(a['programId']), 'customer': s['customers'].get(str(a['customerId']), {}).get('fullName'),
                         'device': s['devices'].get(str(a['customerDeviceId']), {}).get('deviceName'), 'imei': s['devices'].get(str(a['customerDeviceId']), {}).get('imei'),
                         'contacted': a.get('contacted')} for a in s['arrivals'].values() if not a['checkedIn']]
            wos = [{'id': w['workorderId'], 'program': api.PROGRAMS.get(w['programId']), 'status': api.STATUS.get(w['workorderStatusId'], str(w['workorderStatusId'])),
                    'customer': s['customers'].get(str(w['customerId']), {}).get('fullName'), 'cart': s['carts'].get(w['csuCartId'], {}).get('items', []),
                    'sale': w.get('csuSalesOrderId'), 'notes': sum(1 for n in s['notes'] if n['workorderId'] == w['workorderId'])}
                   for w in sorted(s['wos'].values(), key=lambda w: -w['workorderId'])]
            missing = sorted({m + ' ' + p.split('?')[0] for m, p, st in log if st == 404})
            return h.send(200, {'settings': s['settings'], 'arrivals': arrivals, 'wos': wos, 'missing': missing, 'log': list(reversed(log[-120:]))})
        body = h.body() or {}
        if path == '/sandbox/device' and method == 'POST':
            cust = api.new_customer(body.get('name') or None)
            dev = api.new_device(cust, body.get('device') or None)
            out = []
            if body.get('parent', True):
                w = api.new_wo(cust, dev, 5062, status=8)
                out.append('WO ' + str(w['workorderId']))
            for i, prog in enumerate(body.get('programs') or []):
                a = api.new_arrival(cust, dev, int(prog), appointment_h=0.5 + i * 0.25)
                a['contacted'] = bool(body.get('contacted'))
                out.append('arrival ' + str(a['arrivalId']))
            api.save()
            return h.send(200, {'message': cust['fullName'] + ': ' + (', '.join(out) or 'nothing')})
        if path == '/sandbox/settings' and method == 'POST':
            s['settings']['storeOpen'] = bool(body.get('storeOpen'))
            s['settings']['laborPrice'] = float(body.get('laborPrice') or 0)
            api.save()
            return h.send(200, {'ok': True})
        if path == '/sandbox/reset' and method == 'POST':
            api.reset()
            del log[:]
            return h.send(200, {'ok': True})
    return h.send(404, {'message': 'unknown sandbox page'})
