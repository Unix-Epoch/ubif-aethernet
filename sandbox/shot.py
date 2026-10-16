#!/usr/bin/env python3
"""Playwright harness for the Portal sandbox: load Aethernet, screenshot, drive menus.

Run with the venv that has Playwright (system python lacks it):
  ~/Scripts/ubif-daily-sales/.venv/bin/python sandbox/shot.py /arrivals out.png

Needs the sandbox up first:  python3 sandbox/server.py  (http://localhost:8790)
and a built bundle:          python3 build.py --dev     (dist-dev/aethernet.user.js)

As a module (import with sandbox/ on sys.path):
  from shot import portal_page, shot, open_menu, inject_html
  async with portal_page('/repair/workorders') as pg:
      await open_menu(pg, 'Decipher')
      await shot(pg, 'decipher', selector='.sg-card')

Chrome (channel='chrome'), bypass_csp, 1440x1000 at 2x by default.
Screenshots land in sandbox/shots/ (git-ignored).
"""
import asyncio, contextlib, pathlib, sys, urllib.request
from playwright.async_api import async_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SANDBOX = 'http://localhost:8790'
SHOTS = ROOT / 'sandbox' / 'shots'
BUNDLES = {'dev': ROOT / 'dist-dev' / 'aethernet.user.js'}

# Tampermonkey stand-in: storage in localStorage; menu commands recorded in window.__gmMenu.
GM = """
window.__gmMenu = {};
window.GM_getValue=(k,v)=>{try{const x=localStorage.getItem('gm_'+k);return x===null?v:JSON.parse(x)}catch(_){return v}};
window.GM_setValue=(k,v)=>localStorage.setItem('gm_'+k,JSON.stringify(v));
window.GM_deleteValue=(k)=>localStorage.removeItem('gm_'+k);
window.GM_registerMenuCommand=(n,f)=>{window.__gmMenu[n]=f};
window.GM_xmlhttpRequest=(o)=>{setTimeout(()=>o.onerror&&o.onerror({}),0)};
window.GM_info={scriptHandler:'Tampermonkey',version:'5.3'};
"""

HIDE_SANDBOX_TAB = """for (const el of document.querySelectorAll('body *')) {
  if (getComputedStyle(el).position === 'fixed' && el.textContent.trim() === 'SANDBOX') el.remove(); }"""


def check_sandbox():
    try:
        urllib.request.urlopen(SANDBOX + '/', timeout=3).read(1)
    except Exception:
        sys.exit(f'Sandbox is not running at {SANDBOX}. Start it: python3 sandbox/server.py')


@contextlib.asynccontextmanager
async def portal_page(path='/repair/workorders', build='dev', width=1440, height=1000, scale=2,
                      hide_sandbox_tab=True, hide_banner=True, settle=2500):
    """Open the sandbox at `path` with the GM stand-in and Aethernet injected; yields the page."""
    check_sandbox()
    bundle = BUNDLES[build]
    if not bundle.exists():
        sys.exit(f'{bundle} missing. Build it: python3 build.py --dev')
    async with async_playwright() as p:
        b = await p.chromium.launch(channel='chrome')
        ctx = await b.new_context(viewport={'width': width, 'height': height},
                                  device_scale_factor=scale, bypass_csp=True)
        pg = await ctx.new_page()
        await pg.goto(SANDBOX + path, wait_until='load')
        await pg.wait_for_timeout(3000)  # Portal's app renders
        await pg.add_script_tag(content=GM)
        await pg.add_script_tag(path=str(bundle))
        try:
            await pg.wait_for_selector('html[data-aethernet]', state='attached', timeout=10000)
        except Exception:
            print('warning: Aethernet did not mark <html data-aethernet>', file=sys.stderr)
        await pg.wait_for_timeout(settle)
        if hide_banner:
            await pg.evaluate("document.getElementById('sg-status-banner')?.remove()")
        if hide_sandbox_tab:
            await pg.evaluate(HIDE_SANDBOX_TAB)
        try:
            yield pg
        finally:
            await b.close()


async def shot(pg, name, selector=None, out_dir=SHOTS):
    """Full-page PNG `<name>.png`, plus `<name>-el.png` of `selector` if given. Returns paths."""
    out = pathlib.Path(out_dir); out.mkdir(parents=True, exist_ok=True)
    paths = [out / f'{name}.png']
    await pg.screenshot(path=str(paths[0]))
    if selector:
        paths.append(out / f'{name}-el.png')
        await pg.locator(selector).first.screenshot(path=str(paths[1]))
    return paths


async def open_menu(pg, name):
    """Run a Tampermonkey menu command by (partial) name; else click the item in Portal's avatar menu."""
    ran = await pg.evaluate("""(n) => { const k = Object.keys(window.__gmMenu||{}).find(x => x.includes(n));
      if (k) { window.__gmMenu[k](); return true } return false }""", name)
    if ran:
        await pg.wait_for_timeout(600); return
    item = pg.get_by_text(name, exact=True)
    if not await item.count():  # avatar menu closed: open it
        await pg.locator('button.components-header-opts-avatar').click()
        await pg.wait_for_timeout(500)
    await item.first.click()
    await pg.wait_for_timeout(600)


async def inject_html(pg, html):
    """Append mockup HTML (include its own <style>) to the page body."""
    await pg.evaluate("(h) => { const w = document.createElement('div'); w.innerHTML = h; document.body.append(w); }", html)
    await pg.wait_for_timeout(300)


async def _cli(path, out):
    async with portal_page(path) as pg:
        p = await shot(pg, pathlib.Path(out).stem, out_dir=pathlib.Path(out).parent or '.')
        pathlib.Path(p[0]).rename(out)
        print(out)

if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    asyncio.run(_cli(sys.argv[1], sys.argv[2]))
