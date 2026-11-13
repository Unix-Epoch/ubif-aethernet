# Builds screenshots/overview.png: a contact sheet of the representative screens (dark) at phone, cover and inner sizes.
# Run after `./gradlew screenshots`:  ~/Scripts/ubif-daily-sales/.venv/bin/python -I android/tools/overview.py
import pathlib, sys
from playwright.sync_api import sync_playwright
root = pathlib.Path(__file__).resolve().parent.parent / 'screenshots'
phone = [('home', 'allstores', 'Home'), ('onboarding', 'firstrun', 'First run'), ('onboarding', 'waiting', 'Waiting'),
         ('workorders', 'list-locked', 'Work orders locked'), ('workorders', 'list-unlocked', 'Work orders unlocked'),
         ('workorders', 'detail-locked', 'Detail locked'), ('workorders', 'detail-unlocked', 'Detail unlocked'),
         ('alerts', 'feed', 'Alerts'), ('alerts', 'settings', 'Alert settings'), ('alerts', 'threshold', 'Threshold'), ('settings', 'locked', 'Settings')]
wide = [('home', 'allstores', 'Home'), ('workorders', 'list-unlocked', 'Work orders'), ('alerts', 'feed', 'Alerts'), ('settings', 'locked', 'Settings')]
def cell(f, dev, name, label, w):
    p = root / f / f'{dev}-{name}-dark.png'
    if not p.exists(): print('missing', p, file=sys.stderr); return ''
    return f'<figure style="width:{w}px"><img src="{p.as_uri()}" style="width:{w}px"><figcaption>{label}</figcaption></figure>'
rows = [('Phone 412 x 915', ''.join(cell(f, 'phone', n, l, 260) for f, n, l in phone)),
        ('Cover screen', ''.join(cell(f, 'cover', n, l, 260) for f, n, l in wide)),
        ('Inner screen, vertical fold', ''.join(cell(f, 'inner', n, l, 520) for f, n, l in wide))]
html = '<body style="margin:0;padding:24px;background:#111;color:#ddd;font:14px sans-serif">' + ''.join(
    f'<h2 style="margin:20px 0 8px">{t}</h2><div style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start">{c}</div>' for t, c in rows) + \
    '<style>figure{margin:0}figcaption{text-align:center;padding-top:4px}</style></body>'
page_file = root / '_overview.html'; page_file.write_text(html)
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1900, 'height': 900}); pg.goto(page_file.as_uri()); pg.wait_for_timeout(500)
    pg.screenshot(path=str(root / 'overview.png'), full_page=True); b.close()
page_file.unlink()
