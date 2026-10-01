#!/usr/bin/env python3
"""Copy Portal's *configuration* responses into sandbox/fixtures/ (read-only GETs
through the ubif-workorders tracker session), with anything personal blanked.

  python3 sandbox/capture.py

Only config-type endpoints are listed (permissions, features, store options...);
no work orders, customers or arrivals are ever copied. fixtures/ is git-ignored.
"""
import json, re, sys
from pathlib import Path
sys.path.insert(0, str(Path.home() / 'Scripts' / 'ubif-workorders'))
import portal_client as pc

OUT = Path(__file__).resolve().parent / 'fixtures'
GETS = {
    'abilities': ('/api/auth/user', lambda j: j.get('abilities', [])),
    'store': ('/api/auth/user', lambda j: j.get('currentStore', {})),
    'features': ('/api/features', None),
    'store-options': ('/api/auth/store-options', None),
    'user-stores': ('/api/auth/user/stores', None),
    'partner-downtime': ('/api/notification/get-partner-downtime', None),
    'timesheet-access': ('/api/store-time-sheet/access', None),
    'roletypes': ('/api/admin/stores/roletypes', None),
    'clock-status': ('/api/technician/clock-status', None),
}
# Program settings (turnaround times, allowed actions...) for the programs the sandbox uses.
for prog in (5062, 11759, 9470, 11009, 9901, 10303, 20001):
    GETS['program-attributes-' + str(prog)] = ('/api/program-attributes/' + str(prog), None)
PERSONAL = re.compile(r'(name|email|phone|address|street|first|last|given|family|user(name)?$|pin|birthday|picture|signature|personnel|employee|technicianid|latitude|longitude|postal)', re.I)
KEEP = re.compile(r'^(storeName|programName|roleName|name)$')  # config labels, not people


def scrub(v, key=''):
    if isinstance(v, dict):
        return {k: scrub(x, k) for k, x in v.items()}
    if isinstance(v, list):
        return [scrub(x, key) for x in v]
    if isinstance(v, str) and PERSONAL.search(key) and not KEEP.match(key):
        return 'sandbox'
    return v


OUT.mkdir(exist_ok=True)

# A work-order template: the structure of one recent Asurion Mobility WO from the
# tracker's database, with every personal/device value blanked (sandbox fills its own).
import sqlite3
DEVICE = re.compile(r'^(imei|serial|passcode|noteText|value|claimNumber|csuCartId|csuSalesOrderId)$', re.I)
def scrub_wo(v, key=''):
    if isinstance(v, dict):
        return {k: scrub_wo(x, k) for k, x in v.items()}
    if isinstance(v, list):
        return [scrub_wo(x, key) for x in v[:1]]
    if isinstance(v, str) and ((PERSONAL.search(key) and not KEEP.match(key)) or DEVICE.match(key)):
        return ''
    return v
db = sqlite3.connect('file:' + str(Path.home() / 'Scripts/ubif-workorders/workorders.db') + '?mode=ro', uri=True)
row = db.execute("SELECT raw_json FROM workorder_snapshots WHERE workorder_id = (SELECT workorder_id FROM workorders WHERE program_id = 5062 "
                 "ORDER BY api_updated_at DESC LIMIT 1) ORDER BY fetched_at DESC LIMIT 1").fetchone()
if row:
    snap = json.loads(row[0])
    tpl = {'workorder': scrub_wo(snap['workorder']), 'cart': scrub_wo(snap.get('cart') or {})}
    (OUT / 'wo-template.json').write_text(json.dumps(tpl, indent=1))
    print('wo-template        ok   (tracker snapshot, scrubbed)')

for name, (path, pick) in GETS.items():
    try:
        j = pc.call_with_refresh(path)
        data = pick(j) if pick else j
        (OUT / (name + '.json')).write_text(json.dumps(scrub(data), indent=1))
        print(f'{name:18} ok   {path}')
    except Exception as e:
        print(f'{name:18} FAIL {path}: {str(e)[:100]}')
