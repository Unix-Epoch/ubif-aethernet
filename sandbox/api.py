"""Fake Portal API for the sandbox: work orders, arrivals, carts and notes that
exist only in sandbox/state.json. Shapes follow Portal's real responses (the
captured fixtures + the WO template); values are made up.

Covers what Portal's dashboard, Arrivals and work-order lists need, and every
call Swiftcast/Dualcast, Esuna, Divination and Recitation make. Anything else
answers 404 and is listed on /sandbox.
"""
import copy, datetime, json, random, re, threading
from pathlib import Path
from urllib.parse import urlparse, parse_qs

HERE = Path(__file__).resolve().parent
FIX = HERE / 'fixtures'
STATE_FILE = HERE / 'state.json'
LOCK = threading.RLock()
STORE_ID = 999999  # scratch store: no Aethernet access, so the real Worker refuses it; none of a real store's data is used

PROGRAMS = {6494: 'Samsung In Warranty Repair', 8849: 'Asurion Home+ Repairs', 5062: 'Asurion Mobility', 11759: 'VZ Device Refresh', 9470: 'VZ Sanitization', 11009: 'AT&T Enhanced Cleaning',
            9901: 'AT&T Device Diagnostic', 10303: 'AT&T Performance Check', 20001: 'Out Of Warranty'}
CLEANINGS = [11759, 9470, 11009, 9901, 10303]
STATUS = {1: 'Initial check-in', 2: 'Need to order', 3: 'Awaiting item', 4: 'Awaiting device', 7: 'Awaiting callback', 8: 'Ready for work', 9: 'Diagnostics',
          10: 'Work in progress', 11: 'Quality check', 12: 'Repair summary', 13: 'Ready for pickup', 14: 'Sale complete', 25: 'Cancelled'}
CLOSED = {14, 15, 25}
FIRST = ['Jordan', 'Sam', 'Riley', 'Casey', 'Alex', 'Morgan', 'Taylor', 'Quinn', 'Avery', 'Drew']
LAST = ['Reyes', 'Patel', 'Brooks', 'Lin', 'Moore', 'Hayes', 'Diaz', 'Nguyen', 'Price', 'Cole']
DEVICES = ['iPhone 15 Pro', 'iPhone 14', 'Galaxy S24', 'Galaxy S23 Ultra', 'Pixel 8', 'iPhone 13']
USER = {'userId': 990001, 'givenName': 'Sandbox', 'familyName': 'Tech', 'username': 'sandbox.tech', 'email': 'sandbox.tech@example.invalid',
        'pictureUrl': '', 'phone': None, 'position': None, 'active': 1, 'storeUser': 1, 'defaultStoreId': STORE_ID, 'samsungCertified': 0,
        'asurionRemoteTech': 0, 'createdAt': '2026-01-01T00:00:00.000Z', 'updatedAt': '2026-01-01T00:00:00.000Z', 'GspnEngineer': {'storeId': STORE_ID}}


def now(offset_h=0.0):
    t = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=offset_h)
    return t.strftime('%Y-%m-%dT%H:%M:%S.') + '%03dZ' % (t.microsecond // 1000)


def fixture(name, default=None):
    f = FIX / (name + '.json')
    if not f.exists():
        return default
    # fixtures were captured at a real store; rename it to the scratch sandbox store whatever the capture says
    txt = f.read_text()
    txt = re.sub(r'("(?:storeId|number|defaultStoreId)":\s*)914\b', r'\g<1>%d' % STORE_ID, txt)
    txt = txt.replace('"Newport News"', '"Sandbox Store"').replace('UBIF914', 'UBIF%d' % STORE_ID).replace('"914-', '"%d-' % STORE_ID)
    return json.loads(txt)


# ------------------------------------------------------------------ state
def fresh():
    return {'seq': {'wo': 700000000, 'arrival': 880000, 'cust': 770000, 'dev': 660000, 'note': 1, 'line': 1, 'so': 1},
            'wos': {}, 'arrivals': {}, 'notes': [], 'carts': {}, 'customers': {}, 'devices': {},
            'settings': {'storeOpen': True, 'laborPrice': 0.0}}


STATE = None


def load():
    global STATE
    if STATE is None:
        STATE = json.loads(STATE_FILE.read_text()) if STATE_FILE.exists() else fresh()
    return STATE


def save():
    STATE_FILE.write_text(json.dumps(STATE, indent=1))


def nxt(kind):
    s = load()['seq']
    s[kind] += 1
    return s[kind]


def reset():
    global STATE
    STATE = fresh()
    save()


# ------------------------------------------------------------------ makers
def new_customer(name=None):
    cid = str(nxt('cust'))
    first, last = (name.split(' ', 1) + [''])[:2] if name else (random.choice(FIRST), random.choice(LAST))
    c = {'customerId': cid, 'givenName': first, 'familyName': last, 'fullName': (first + ' ' + last).strip(),
         'phone': '5555550' + cid[-3:], 'email': first.lower() + '.' + cid + '@example.invalid'}
    load()['customers'][cid] = c
    return c


def new_device(cust, device=None, imei=None):
    did = str(nxt('dev'))
    imei = imei or '35' + ''.join(random.choice('0123456789') for _ in range(13))
    d = {'customerDeviceId': did, 'customerId': cust['customerId'], 'deviceName': device or random.choice(DEVICES), 'imei': imei, 'name': '', 'passcode': '', 'serial': ''}
    load()['devices'][did] = d
    return d


def new_cart():
    cid = str(STORE_ID) + '-' + str(random.randint(10 ** 12, 10 ** 13 - 1))
    load()['carts'][cid] = {'cartId': cid, 'items': [], 'salesOrder': None}
    return cid


def new_wo(cust, dev, program, status=8, created=None):
    wid = nxt('wo')
    w = {'workorderId': wid, 'programId': program, 'workorderStatusId': status, 'customerId': cust['customerId'], 'customerDeviceId': dev['customerDeviceId'],
         'createdAt': created or now(), 'updatedAt': now(), 'nextUpdate': now(4), 'csuCartId': new_cart(), 'csuSalesOrderId': '', 'attributes': [],
         'serviceOutcome': '', 'arrivalId': None, 'binLocation': ''}
    load()['wos'][str(wid)] = w
    return w


def new_arrival(cust, dev, program, appointment_h=1.0, arrival_type=1):
    aid = nxt('arrival')
    a = {'arrivalId': aid, 'programId': program, 'arrivalTypeId': arrival_type, 'customerId': cust['customerId'], 'customerDeviceId': dev['customerDeviceId'],
         'createdAt': now(), 'appointment': now(appointment_h), 'statusId': 20, 'checkedIn': False, 'contacted': False, 'workorderId': None,
         'serviceJobId': 'SJ' + str(aid)}
    load()['arrivals'][str(aid)] = a
    return a


def add_note(wo_id, text, tag, note_type, cust_id):
    n = {'noteId': str(nxt('note')), 'noteText': text, 'customerId': str(cust_id), 'workorderId': int(wo_id), 'arrivalId': None, 'noteType': note_type,
         'noteTag': tag, 'createdBy': USER['userId'], 'createdAt': now(), 'updatedAt': now(),
         'UserDatum': {'userId': USER['userId'], 'givenName': USER['givenName'], 'familyName': USER['familyName'], 'pictureUrl': '', 'username': USER['username']}}
    load()['notes'].insert(0, n)
    return n


# ------------------------------------------------------------------ views (Portal's shapes)
def cust_view(cid):
    c = load()['customers'].get(str(cid), {})
    return {'customerId': c.get('customerId'), 'fullName': c.get('fullName'), 'givenName': c.get('givenName'), 'familyName': c.get('familyName'),
            'primaryPhone': c.get('phone'), 'primaryEmail': c.get('email')}


def dev_view(did):
    d = load()['devices'].get(str(did), {})
    return {'customerDeviceId': d.get('customerDeviceId'), 'customerId': d.get('customerId'), 'deviceName': d.get('deviceName'), 'modelName': d.get('deviceName'),
            'imei': d.get('imei'), 'serial': d.get('serial', ''), 'name': d.get('name', ''), 'deviceCatalogId': 7264, 'deviceTypeId': 1, 'isValid': True}


def cart_view(cart_id):
    c = load()['carts'].get(cart_id) or {'cartId': cart_id, 'items': []}
    total = round(sum(i['price'] for i in c['items']), 2)
    return {'cartId': cart_id, 'cartItems': [dict(i) for i in c['items']], 'discountCodes': [], 'isCanceled': False,
            'payment': {'subtotal': total, 'netSubtotal': total, 'discount': 0, 'tax': 0, 'total': total, 'amountDue': total, 'amountPaid': 0}}


def wo_row(w):
    d = load()['devices'].get(str(w['customerDeviceId']), {})
    return {'workorderId': w['workorderId'], 'workorderStatusId': w['workorderStatusId'], 'workorderStatusName': STATUS.get(w['workorderStatusId'], 'Ready for work'),
            'programId': w['programId'], 'programName': w.get('programName') or PROGRAMS.get(w['programId'], 'Program'), 'createdAt': w['createdAt'], 'updatedAt': w['updatedAt'],
            'nextUpdate': w['nextUpdate'], 'customer': cust_view(w['customerId']), 'customerDevice': dev_view(w['customerDeviceId']),
            'customerDeviceId': w['customerDeviceId'], 'deviceCatalog': {'name': d.get('deviceName')}, 'deviceIssues': w.get('issues') or (['Cleaning'] if w['programId'] in CLEANINGS else ['Screen']),
            'serviceOutcome': w.get('serviceOutcome', ''), 'workorderTotal': cart_view(w['csuCartId'])['payment']['total'], 'claimNumber': None, 'clientId': 1,
            'matchedRules': [], 'itemswithdevice': '', 'locationBin': w.get('binLocation', ''), 'rfpWorkorderStatusDate': w.get('rfpAt'),
            'createdBy': {'givenName': (w.get('by') or USER)['givenName'], 'familyName': (w.get('by') or USER)['familyName']}}


def wo_detail(w):
    tpl = copy.deepcopy((fixture('wo-template', {}) or {}).get('workorder') or {'workorder': {}})
    inner = tpl.setdefault('workorder', {})
    d = load()['devices'].get(str(w['customerDeviceId']), {})
    inner.update({'workorderId': w['workorderId'], 'workorderStatusId': w['workorderStatusId'], 'programId': w['programId'], 'storeId': STORE_ID,
                  'createdAt': w['createdAt'], 'updatedAt': w['updatedAt'], 'nextUpdate': w['nextUpdate'], 'csuCartId': w['csuCartId'],
                  'csuSalesOrderId': w.get('csuSalesOrderId', ''), 'customerDeviceId': w['customerDeviceId'], 'clientId': 1, 'claimNumber': None,
                  'WorkorderStatus': {'name': STATUS.get(w['workorderStatusId'], ''), 'workorderStatusId': w['workorderStatusId']},
                  'Program': {'name': w.get('programName') or PROGRAMS.get(w['programId'], 'Program'), 'programId': w['programId'], 'programTypeId': 4},
                  'Store': {'storeName': 'Sandbox Store', 'isDepot': None}})
    cd = inner.setdefault('CustomerDevice', {})
    cd.update({'customerDeviceId': w['customerDeviceId'], 'customerId': w['customerId'], 'imei': d.get('imei', ''), 'name': d.get('name', ''),
               'passcode': '', 'serial': ''})
    if isinstance(cd.get('DeviceCatalog'), dict):
        cd['DeviceCatalog']['name'] = d.get('deviceName', '')
        dm = cd['DeviceCatalog'].setdefault('DeviceModel', {})  # the type Assize reads; the template is always a Cell Phone
        dm['DeviceType'] = {'name': d.get('deviceType') or device_type(d.get('deviceName', ''))}
        dm['DeviceFamily'] = {'name': d.get('deviceFamily', '')}
    inner['WorkorderBinDeviceLocation'] = {'WorkorderBin': {'name': w.get('binLocation', '')}} if w.get('binLocation') else None
    if w.get('issues'):
        inner['WorkorderDeviceIssueServiceOptions'] = [{'DeviceIssueCategoryTypeOption': {'DeviceIssue': {'name': x}}} for x in w['issues']]
    inner['WorkorderAttributes'] = [{'workorderAttributeTypeId': 22, 'value': w['outcome']}] if w.get('outcome') else []
    inner['WorkorderAttributes'] += [{'workorderAttributeId': i + 1, 'workorderId': w['workorderId'], 'workorderAttributeTypeId': a.get('workorderAttributeTypeId'),
                                     'key': a.get('key'), 'value': a.get('value'), 'createdAt': now(), 'updatedAt': now()} for i, a in enumerate(w.get('attributes', []))]
    if isinstance(inner.get('PartnerJob'), dict):
        inner['PartnerJob'].update({'workorderId': w['workorderId'], 'arrivalId': w.get('arrivalId'), 'customerDeviceId': w['customerDeviceId'], 'PartnerJobAttributes': []})
    inner['Customer'] = cust_view(w['customerId'])
    return tpl


def device_type(name):
    n = (name or '').lower()
    if re.search(r'\btv\b|television', n): return 'Other'
    if re.search(r'watch|airpods|buds', n): return 'Wearable'
    if re.search(r'ipad|tab\b|tablet', n): return 'Tablet'
    if re.search(r'ps5|playstation|xbox|switch', n): return 'Game Console'
    if re.search(r'macbook|pavilion|laptop|desktop|\bpc\b|surface', n): return 'Computer'
    return 'Cell Phone'


def arrival_view(a):
    return {'arrivalId': a['arrivalId'], 'program': {'programId': a['programId'], 'name': PROGRAMS.get(a['programId'], 'Program')},
            'arrivalStatus': {'arrivalStatusId': a['statusId'], 'arrivalStatusName': 'Confirmed' if a['statusId'] == 21 else 'Not confirmed'},
            'arrivalAttributes': [{'arrivalAttributeTypeId': 53, 'value': '1'}] if a.get('contacted') else [], 'arrivalTypeId': a.get('arrivalTypeId', 1),
            'appointment': a['appointment'], 'createdAt': a['createdAt'], 'updatedAt': a['createdAt'], 'customer': cust_view(a['customerId']),
            'customerDevice': dev_view(a['customerDeviceId']), 'deviceIssues': [{'name': 'Cleaning'}], 'clientId': 1, 'clientName': 'Asurion',
            'storeId': STORE_ID, 'isDepotStore': False, 'isMissed': False, 'matchedRules': [], 'notes': [n for n in load()['notes'] if n.get('arrivalId') == a['arrivalId']],
            'source': 'Claim' if a.get('arrivalTypeId') == 3 else 'Appointment',
            'csuCartId': None, 'csuSalesOrderId': None, 'partnerJobDetails': {'serviceJobId': a['serviceJobId']}}


# ------------------------------------------------------------------ Decipher's fakes
DEVICE_MODELS = [
    {'id': 1573, 'name': 'iPhone 15 Pro', 'mfr': 'Apple', 'colors': ['Natural Titanium', 'Black Titanium', 'Blue Titanium', 'White Titanium']},
    {'id': 1571, 'name': 'iPhone 15', 'mfr': 'Apple', 'colors': ['Black', 'Blue', 'Green', 'Pink', 'Yellow']},
    {'id': 1700, 'name': 'Samsung Galaxy S24 Ultra', 'mfr': 'Samsung', 'colors': ['Titanium Black', 'Titanium Gray', 'Titanium Violet']},
    {'id': 1801, 'name': 'Motorola Moto G 5G (2025)', 'mfr': 'Motorola', 'colors': ['Slate Grey', 'Sage Green']},
    {'id': 1802, 'name': 'Motorola Moto G Power 5G (2025)', 'mfr': 'Motorola', 'colors': ['Slate Grey']},
    {'id': 1803, 'name': 'Motorola Moto G Stylus 5G (2025)', 'mfr': 'Motorola', 'colors': []},
]
# TAC -> {(model id, color): [model name, manufacturer, count]}; made-up TACs, in memory only (a restart resets them)
TACS = {
    '35684192': {(1573, 'Natural Titanium'): ['iPhone 15 Pro', 'Apple', 12], (1573, 'Black Titanium'): ['iPhone 15 Pro', 'Apple', 7], (1573, 'Blue Titanium'): ['iPhone 15 Pro', 'Apple', 3],
                 (1573, 'White Titanium'): ['iPhone 15 Pro', 'Apple', 1]},
    '35092741': {(1700, 'Titanium Black'): ['Samsung Galaxy S24 Ultra', 'Samsung', 6], (1700, 'Titanium Gray'): ['Samsung Galaxy S24 Ultra', 'Samsung', 3]},
    '35231540': {(1573, 'Black Titanium'): ['iPhone 15 Pro', 'Apple', 4]},
}
# stands in for the Osmocom import (the Worker's osmocom_tac table)
OSMOCOM = {'35926618': {'brand': 'Motorola', 'model': 'moto g 5G (2025)'}, '99001200': {'brand': 'Motorola', 'model': 'moto g 5G (2025)'}}
TAC_STORES = {'35684192': {STORE_ID, 915}, '35092741': {STORE_ID}, '35231540': {STORE_ID}}


def tac_route(method, tac, body):
    if method == 'GET' and tac:
        rows = TACS.get(tac)
        if not rows:
            return 200, {'tac': tac, 'known': False, 'suggestion': OSMOCOM.get(tac)}
        models = {}
        for (mid, color), (name, mfr, n) in rows.items():
            e = models.setdefault(mid, {'deviceModelId': mid, 'modelName': name, 'manufacturer': mfr, 'count': 0})
            e['count'] += n
        ranked = sorted(models.values(), key=lambda x: -x['count'])
        top = ranked[0]['deviceModelId']
        colors = sorted([{'color': c, 'count': n} for (mid, c), (_, _, n) in rows.items() if mid == top and c], key=lambda x: -x['count'])
        return 200, {'tac': tac, 'known': True, 'models': ranked, 'colors': colors, 'workOrders': sum(x['count'] for x in ranked), 'stores': len(TAC_STORES.get(tac, ())) or 1}
    if method == 'POST':
        for it in (body.get('items') or [body]):
            t = str(it.get('tac') or '')
            if not re.fullmatch(r'\d{8}', t) or not it.get('deviceModelId') or not it.get('modelName'):
                return 400, {'message': 'tac, deviceModelId and modelName required'}
            e = TACS.setdefault(t, {}).setdefault((int(it['deviceModelId']), it.get('color') or ''), [it['modelName'], it.get('manufacturer') or '', 0])
            e[2] += 1
            TAC_STORES.setdefault(t, set()).add(STORE_ID)
        return 200, {'ok': True}
    return 404, {'message': 'sandbox: not implemented'}


# ------------------------------------------------------------------ routes
def fake_punches(frm, to):
    """A week of made-up punches (no real people): the sandbox store and 326, one worker at both, a long day, a missing clock-out."""
    import datetime as dt
    start = dt.date.fromisoformat((frm or '2026-10-05')[:10])
    people = [(33254, 'avery.tech', STORE_ID), (33255, 'blake.lead', STORE_ID), (33256, 'casey.mgr', STORE_ID), (33257, 'drew.tech', 326), (33258, 'emery.tech', 326), (33259, 'finley.float', None)]
    rows, n = [], 900000
    def iso(d, h, m=0):
        return (dt.datetime.combine(d, dt.time(0)) + dt.timedelta(hours=h, minutes=m) + dt.timedelta(hours=4)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    for day in range(7):
        d = start + dt.timedelta(days=day)
        if d.weekday() == 3:  # closed Thursdays
            continue
        for uid, name, store in people:
            if (uid + day) % 5 == 0:
                continue
            st = store or (STORE_ID if day % 2 else 326)
            sname = {STORE_ID: 'Sandbox Store', 326: 'Lynnhaven'}[st]
            h_in, h_out = 9.75 + (uid % 3) * 0.25, 18.5 + (uid % 2) * 0.75 + (1.5 if name == 'blake.lead' else 0)
            n += 1; rows.append({'timeclockId': n, 'userId': uid, 'username': name, 'storeId': st, 'storeName': sname, 'clockTypeId': 1,
                                 'timeIn': iso(d, int(h_in), int(h_in % 1 * 60)), 'timeOut': None if (name == 'drew.tech' and day == 6) else iso(d, int(h_out), int(h_out % 1 * 60))})
            n += 1; rows.append({'timeclockId': n, 'userId': uid, 'username': name, 'storeId': st, 'storeName': sname, 'clockTypeId': 2, 'timeIn': iso(d, 13), 'timeOut': iso(d, 13, 30)})
    return rows


def handle(method, path, body):
    with LOCK:
        try:
            status, out = route(method, path, body if isinstance(body, dict) else {})
        except Exception as e:  # a sandbox bug shouldn't look like a Portal outage
            status, out = 500, {'message': 'sandbox error: ' + repr(e)[:300]}
        if method != 'GET':
            save()
        return status, out


def route(method, path, body):
    u = urlparse(path)
    q = {k: v[0] for k, v in parse_qs(u.query).items()}
    p = u.path[len('/api/'):].strip('/')
    s = load()
    W = lambda wid: s['wos'].get(str(wid))

    # ---- who's signed in, store, config
    if p == 'auth/user' and s['settings'].get('signedOut'):  # test Portal's login page
        return 401, {'isAuthenticated': False}
    if p == 'auth/user':
        st = fixture('store', {}) or {}
        st.update({'storeId': STORE_ID, 'storeName': 'Sandbox Store', 'address_1': '1 Sandbox Way', 'city': 'Testville', 'phone': '5555550100', 'email': 'sandbox@example.invalid'})
        # userAttributes: the Work orders list reads its page size from it (blank page without it)
        return 200, {'isAuthenticated': True, 'user': USER, 'currentStore': st, 'isStoreOpen': s['settings']['storeOpen'], 'abilities': fixture('abilities', []),
                     'userAttributes': {'PageCount': 25}, 'storeTwilioPhoneNumber': '+15555550199', 'isOutboundCommunicationEnabled': True,
                     # Portal's isStoreGspnEnabled reads the store config 523 (GspnEnabled) = "1"; settings.gspnOff drops it to test the non-GSPN wording
                     'storeConfigs': [] if s['settings'].get('gspnOff') else [{'storeConfigId': 9001, 'configId': 523, 'configName': 'GspnEnabled', 'storeConfigValue': '1'}]}
    if p == 'auth/user/stores':
        return 200, fixture('user-stores', [])
    if p == 'auth/store-options':
        return 200, fixture('store-options', {'stores': []})
    if p == 'features':
        f = fixture('features', {})
        f.setdefault('layout', {})['reports_metrics_enabled'] = True  # Dashboard's metrics cards (Sales, Completed repairs), on at stores since the fixture was captured
        return 200, f
    if p == 'notification/get-partner-downtime':
        return 200, fixture('partner-downtime', [])
    if p == 'store-time-sheet/access':
        return 200, dict(fixture('timesheet-access', {}), allowed=True)
    if p == 'reporting/metrics':  # Reports page: Portal's Power BI embed config (made up; only needs to exist for the page to draw)
        return 200, {'url': 'https://example.invalid/reports', 'ctid': 'sandbox', 'reports': [], 'reportsFranchise': [], 'viewAllReports': 'https://example.invalid/reports'}
    if p == 'reporting/sales-history':  # fake Sales tab: a few made-up sales on each day asked for
        import datetime as dt
        day = dt.date.fromisoformat((q.get('sale_complete_start_date') or now())[:10])
        if day.weekday() == 6:
            return 200, {'results': [], 'count': 0, 'next': None}
        def at(h, m=0):
            return (dt.datetime.combine(day, dt.time(h, m)) + dt.timedelta(hours=4)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
        n = day.toordinal() % 1000
        rows = [{'salesId': f'FSO9{n:03d}01', 'workOrderId': 700000001, 'saleCompleteDateTime': at(11, 20), 'transactionType': 'Sale', 'total': 199.0, 'partnerCredits': 199.0, 'payments': 0.0,
                 'customerId': 770001, 'customerName': 'Taylor Diaz', 'completedBy': 'Sandbox Tech'},
                {'salesId': f'FSO9{n:03d}02', 'workOrderId': None, 'saleCompleteDateTime': at(14, 5), 'transactionType': 'Sale', 'total': 21.19, 'partnerCredits': 0.0, 'payments': 21.19,
                 'customerId': 770002, 'customerName': 'Morgan Lee', 'completedBy': 'Sandbox Tech'},
                {'salesId': f'FSO9{n:03d}03', 'workOrderId': None, 'saleCompleteDateTime': at(19, 45), 'transactionType': 'Return', 'total': -49.99, 'partnerCredits': 0.0, 'payments': -49.99,
                 'customerId': 770003, 'customerName': 'Riley Park', 'completedBy': 'Sandbox Lead'}]
        return 200, {'results': rows, 'count': len(rows), 'next': None}
    if p == 'store-time-sheet' and method == 'GET':  # fake punches: two stores, one worker at both (Store time sheet page)
        return 200, {'rows': fake_punches(q.get('fromDate'), q.get('toDate'))}
    if p == 'admin/stores/roletypes':
        return 200, fixture('roletypes', [])
    m = re.fullmatch(r'program-attributes/(\d+)', p)
    if m:
        return 200, fixture('program-attributes-' + m.group(1), fixture('program-attributes-5062', []))
    if p == 'technician/clock-status':
        return 200, fixture('clock-status', {})
    if re.fullmatch(r'stores/\d+', p):
        return 200, {'storeId': int(p.split('/')[1]), 'storeName': 'Sandbox Store', 'city': 'Testville', 'state': 'VA'}

    # ---- arrivals
    if p == 'arrivals/upcoming-arrivals':
        rows = [arrival_view(a) for a in s['arrivals'].values() if not a['checkedIn']]
        if q.get('contacted'):
            rows = [r for r in rows if r['arrivalAttributes']]
        if q.get('arrivalStatusId'):
            rows = [r for r in rows if str(r['arrivalStatus']['arrivalStatusId']) == q['arrivalStatusId']]
        rows.sort(key=lambda r: r['appointment'])
        page, size = int(q.get('page', 1)), int(q.get('pageSize', 10))
        return 200, {'data': rows[(page - 1) * size: page * size], 'rowCount': len(rows)}
    m = re.fullmatch(r'arrivals/(\d+)', p)
    if m and method == 'PUT':  # Portal's "Contacted" dialog (and other arrival edits)
        a = s['arrivals'].get(m.group(1))
        if not a:
            return 404, {'message': 'Arrival not found'}
        if 'contacted' in body:
            a['contacted'] = bool(body['contacted'])
        return 200, arrival_view(a)
    if m:
        a = s['arrivals'].get(m.group(1))
        return (200, arrival_view(a)) if a else (404, {'message': 'Arrival not found'})
    m = re.fullmatch(r'arrivals/(\d+)/validate-imei', p)
    if m:
        a = s['arrivals'].get(m.group(1))
        imei = s['devices'].get(str(a['customerDeviceId']), {}).get('imei') if a else None
        return 200, {'valid': bool(imei) and body.get('imei') == imei}

    # ---- check-in (what Swiftcast replays)
    if p == 'checkin/workorder' and method == 'POST':
        a = s['arrivals'].get(str(body.get('arrivalId')))
        if not a:
            return 404, {'message': 'Arrival not found'}
        if a['checkedIn']:
            return 409, {'message': 'Arrival already checked in'}
        w = new_wo({'customerId': a['customerId']}, {'customerDeviceId': a['customerDeviceId']}, a['programId'], status=1)
        w['arrivalId'] = a['arrivalId']
        a['checkedIn'] = True
        a['workorderId'] = w['workorderId']
        return 200, {'workorder': {'workorderId': w['workorderId']}}
    if p == 'checkin/workorder' and method == 'PUT':
        w = W(body.get('workorderId'))
        if not w:
            return 404, {'message': 'Work order not found'}
        w['workorderStatusId'] = 8
        w['binLocation'] = body.get('binLocation', '')
        w['updatedAt'] = now()
        return 200, {'workorder': wo_row(w)}
    if re.fullmatch(r'calculate-sla/(\d+)', p):
        return 200, {'estimateEndTime': now(2)}
    if p.startswith('checkin/update-service-job-status/'):
        return 200, {'ok': True}

    # ---- work orders
    if p == 'workorders' and method == 'POST':
        pf = body.get('primaryFilter', 'Active')
        ids = set(body.get('workOrderStatusIds') or [])
        rows = [w for w in s['wos'].values()
                if (pf == 'Active' and w['workorderStatusId'] not in CLOSED) or (pf == 'Closed' and w['workorderStatusId'] == 14) or (pf == 'Cancelled' and w['workorderStatusId'] == 25)]
        if ids and pf == 'Active':
            rows = [w for w in rows if w['workorderStatusId'] in ids]
        col, _, direction = (body.get('order') or 'createdAt,DESC').partition(',')
        key = {'woId': 'workorderId', 'createdDate': 'createdAt', 'createdAt': 'createdAt', 'nextUpdate': 'nextUpdate', 'lastUpdate': 'updatedAt'}.get(col, 'createdAt')
        rows.sort(key=lambda w: w[key], reverse=direction != 'ASC')
        page, size = int(body.get('page') or 1), int(body.get('pageSize') or 10)
        return 200, {'workOrders': [wo_row(w) for w in rows[(page - 1) * size: page * size]], 'rowCount': len(rows),
                     'repairNotStartedCount': 0, 'repairStartedCount': 0, 'repairWaitingCount': 0, 'readyForPickupCount': 0, 'needToOrderCount': 0,
                     'allWorkordersCount': len(rows), 'repairNeedToOrderCount': 0}
    if p == 'recent-workorders':
        return 200, [wo_row(w) for w in sorted(s['wos'].values(), key=lambda w: w['updatedAt'], reverse=True)[:5]]
    m = re.fullmatch(r'workorder/(\d+)', p)
    if m:
        w = W(m.group(1))
        if not w:
            return 404, {'message': 'Work order not found'}
        if method == 'GET':
            return 200, wo_detail(w)
        if method == 'PUT':
            if int(body.get('workorderStatusId') or 0) == 13 and s['settings'].get('failRfp', 0) > 0:  # Portal's flaky lookup (Oct 2, 2026)
                s['settings']['failRfp'] -= 1
                return 400, {'errorMessage': 'Error while fetching service bench details.'}
            if body.get('workorderStatusId'):
                w['workorderStatusId'] = int(body['workorderStatusId'])
            w['updatedAt'] = now()
            return 200, {'workorder': wo_row(w)}
    m = re.fullmatch(r'workorder-audit-trail/(\d+)', p)  # status history (the tracker reads it)
    if m:
        w = W(m.group(1))
        if not w:
            return 404, {'message': 'Work order not found'}
        hist = w.get('history') or [{'statusId': w['workorderStatusId'], 'at': w.get('createdAt'), 'by': USER['userId']}]
        return 200, [{'workorderStatusAuditTrailId': i + 1, 'workorderId': w['workorderId'], 'workorderStatusId': x['statusId'],
                      'createdAt': x['at'], 'createdBy': x.get('by', USER['userId']), 'completed': i < len(hist) - 1} for i, x in enumerate(hist)]
    m = re.fullmatch(r'workorder/(\d+)/status', p)
    if m:
        w = W(m.group(1))
        if not w:
            return 404, {'message': 'Work order not found'}
        w['workorderStatusId'] = int(body.get('workorderStatusId') or w['workorderStatusId'])
        w['updatedAt'] = now()
        return 200, {'workorder': wo_row(w)}
    if p == 'workorder/attribute':
        w = W(body.get('workorderId'))
        if w:
            for a in body.get('WorkorderAttribute') or []:
                w['attributes'] = [x for x in w['attributes'] if x.get('key') != a.get('key')] + [a]
                if a.get('key') == 'service_outcome':
                    w['serviceOutcome'] = a.get('value')
        return 200, {'ok': True}
    m = re.fullmatch(r'(?:v1/)?workorder/(\d+)/demographic/customer-data', p)
    if m:
        w = W(m.group(1))
        c = s['customers'].get(str(w['customerId'])) if w else None
        if not c:
            return 404, {'message': 'not found'}
        return 200, {'customerId': c['customerId'], 'canSms': 1, 'canEmail': 1, 'canCall': 1,
                     'CustomerDatum': {'customerId': c['customerId'], 'givenName': c['givenName'], 'familyName': c['familyName'], 'fullName': c['fullName']},
                     'CustomerDataEmails': [{'email': c['email'], 'value': 1}], 'CustomerDataPhones': [{'phone': c['phone'], 'value': 1}]}
    if p == 'workorder/demographic/customer-data':
        return 200, {'ok': True}
    m = re.fullmatch(r'customer-devices/(\d+)', p)
    if m and method == 'PUT':
        d = s['devices'].get(m.group(1))
        if d:
            d['name'] = body.get('name', d.get('name', ''))
        return 200, {'ok': True}

    # ---- customer texts (Provoke): the chat panel's calls
    m = re.fullmatch(r'customer/recent-jobs/(\d+)', p)
    if m:
        c = s['customers'].get(m.group(1), {})
        return 200, {'customer': {'customerId': c.get('customerId'), 'fullName': c.get('fullName'), 'givenName': c.get('givenName'), 'familyName': c.get('familyName'),
                                  'primaryPhoneNumber': c.get('phone'), 'contactPhoneNumber': c.get('phone'), 'canSms': True, 'canCall': True, 'canEmail': True},
                     'arrivals': [], 'workorders': [], 'allowSMSForArrival': True}
    m = re.fullmatch(r'messages/v1/customers/(\d+)', p)
    if m:
        rows = sorted([x for x in s.setdefault('messages', []) if x['customerId'] == m.group(1)], key=lambda x: x['contactDate'], reverse=True)
        return 200, {'messages': rows[:int(q.get('pageSize', 10))], 'total': len(rows)}
    if p == 'messages/v1/send' and method == 'POST':
        x = {'messageId': str(nxt('note')), 'customerId': str(body.get('customerId')), 'content': body.get('message', ''), 'direction': 'OUTBOUND',
             'contactDate': now(), 'status': 'sent', 'to': (body.get('messageDestination') or {}).get('smsPhoneNumber'),
             'from': (body.get('messageSource') or {}).get('smsPhoneNumber'), 'senderId': USER['userId'], 'senderGivenName': USER['givenName'], 'senderFamilyName': USER['familyName']}
        s.setdefault('messages', []).append(x)
        return 200, x

    # ---- notes
    if p == 'note' and method == 'POST' and body.get('arrivalId') and not body.get('workorderId'):  # a note on an arrival
        n = {'noteId': str(nxt('note')), 'noteText': body.get('noteText', ''), 'arrivalId': int(body['arrivalId']), 'workorderId': None,
             'noteType': body.get('noteType', 2), 'noteTag': body.get('noteTag'), 'createdBy': USER['userId'], 'createdAt': now()}
        s['notes'].insert(0, n)
        return 200, n
    if p in ('note', 'notes') and method == 'POST':
        items = body.get('notes') if p == 'notes' else [body]
        made = [add_note(n.get('workorderId'), n.get('noteText', ''), n.get('noteTag'), n.get('noteType', 2), n.get('customerId', '')) for n in items or []]
        return 200, made if p == 'notes' else made[0]
    if p in ('notes', 'note') and method == 'GET':
        wid = q.get('workorderId')
        rows = [n for n in s['notes'] if not wid or str(n['workorderId']) == str(wid)]
        offset, limit = int(q.get('offset', 0)), int(q.get('limit', 25))
        manual = next((n for n in rows if n['noteType'] == 2), None)
        return 200, {'notes': rows[offset: offset + limit], 'total': len(rows), 'latestManualNote': manual}

    # ---- cart + checkout
    m = re.fullmatch(r'get-cart/(.+)', p)
    if m:
        return 200, cart_view(m.group(1))
    if p == 'order/cart/item/add':
        c = s['carts'].setdefault(body.get('cartId'), {'cartId': body.get('cartId'), 'items': [], 'salesOrder': None})
        for line in body.get('cartLines') or []:
            sku = str(line.get('ItemId'))
            if sku == '101516':  # Verizon Free Screen Protector: $15 plus the partner credit Portal adds (laborPrice = what's left to pay)
                lid = 'L' + str(nxt('line'))
                c['items'].append({'lineId': lid, 'sku': sku, 'itemNumber': sku, 'name': 'Verizon Free Screen Protector', 'quantity': 1, 'price': 15.0, 'lineType': 'item', 'isChild': False})
                credit = 15.0 - float(s['settings']['laborPrice'])
                if credit:
                    c['items'].append({'lineId': 'L' + str(nxt('line')), 'sku': 'PCEXEMPT', 'itemNumber': 'PCEXEMPT', 'name': 'Partner Credit Tax Exempt', 'quantity': -1,
                                       'price': -credit, 'lineType': 'trade_credit', 'isChild': True, 'parentLineId': lid})
                continue
            if any((a or {}).get('TextValue') == 'labor' for a in line.get('AttributeValues') or []) or sku == '10156':
                return 500, {'csuError': {'type': 'CommerceException', 'correlationId': 'sandbox'}}  # what live Portal answered for 10156
            c['items'].append({'lineId': 'L' + str(nxt('line')), 'sku': sku, 'itemNumber': sku, 'name': 'Item ' + sku,
                               'quantity': int(line.get('Quantity') or 1), 'price': float(line.get('Price') or 0), 'lineType': 'item', 'isChild': False})
        return 200, cart_view(c['cartId'])
    if p == 'order/cart/item/remove':
        c = s['carts'].get(body.get('cartId'))
        if c:
            c['items'] = [i for i in c['items'] if i['lineId'] not in (body.get('cartLines') or [])]
        return 200, cart_view(body.get('cartId'))
    if p == 'checkout/remove-accessory-item':  # Portal's checkout: remove by SKU (a removed item takes its credit with it)
        c = s['carts'].get(body.get('cartId'))
        if c:
            gone = {i['lineId'] for i in c['items'] if i['sku'] in (body.get('skus') or [])}
            c['items'] = [i for i in c['items'] if i['lineId'] not in gone and i.get('parentLineId') not in gone]
        return 200, cart_view(body.get('cartId'))
    m = re.fullmatch(r'checkout/workorder/(\d+)', p)
    if m:
        w = W(m.group(1))
        return (200, {'workorder': wo_row(w), 'cart': cart_view(w['csuCartId'])}) if w else (404, {'message': 'not found'})
    if p == 'checkout/complete-order':
        w = W(body.get('workorderId'))
        if not w:
            return 404, {'message': 'Work order not found'}
        if cart_view(w['csuCartId'])['payment']['total'] != 0:
            return 400, {'message': 'Payment required'}
        so = 'SO-SBX' + str(nxt('so')).zfill(5)
        w['workorderStatusId'] = 14
        w['csuSalesOrderId'] = so
        w['updatedAt'] = now()
        return 200, {'salesOrder': {'salesId': so}}

    # ---- Decipher: Portal's device-model search and Find My lookup, plus a stand-in for Aethernet's TAC table (the Worker)
    if p == 'device-models' and method == 'GET':
        words = (q.get('searchTerm') or '').lower().split()
        hits = [m for m in DEVICE_MODELS if words and all(w in m['name'].lower() for w in words)]
        return 200, [{'id': m['id'], 'name': m['name']} for m in hits[:20]]
    m = re.fullmatch(r'device-models/(\d+)', p)
    if m:
        dm = next((x for x in DEVICE_MODELS if x['id'] == int(m.group(1))), None)
        if not dm:
            return 404, {'message': 'Device model not found'}
        return 200, {'deviceModelId': dm['id'], 'modelNumber': dm['name'].split(' ', 1)[1] if dm['mfr'] != 'Apple' else dm['name'], 'DeviceManufacturer': {'name': dm['mfr']},
                     'deviceCatalog': {'deviceCatalogId': dm['id'], 'name': dm['name']},
                     'options': [{'name': 'Color', 'deviceCatalogOptionTypeId': 1, 'deviceCatalogOptions': dm['colors']}] if dm['colors'] else []}
    if p == 'workorder/check-fmip-status' and method == 'GET':
        imei = q.get('imei') or ''
        if not re.fullmatch(r'\d{15}', imei):
            return 400, {'message': 'imei required'}
        if imei.startswith('99'):  # test: Portal's Find My lookup failing
            return 500, {'message': 'sandbox: lookup failed'}
        return 200, {'fmipLockStatusServicesResponse': {'fmipLockStatusDevice': {'meid': imei[:14], 'serial': 'F7KQ2MXN4P', 'isLocked': imei[8:10] == '55', 'imei': imei, 'isLost': False}}}
    # Portal's Samsung/Dell/Google warranty check (check-in uses it; Decipher too). GUESSES: the real response was never captured. Portal's code
    # only reads inWarranty, warrantyType ("Standard" is the one value it names; an accidental-damage type exists) and extendedWarranty
    # { claimFulfillmentId, extendedWarrantyId }. Keyed by the two digits after the TAC (positions 9-10) of the IMEI:
    #   11 in warranty "Standard" · 22 in warranty "AccidentalDamage" (+ an extended warranty) · 33 out of warranty · 99 HTTP 500 · else out of warranty
    if p == 'customer-devices/checkDeviceWarranty' and method == 'POST':
        imei = str((body or {}).get('imei') or '')
        if not re.fullmatch(r'\d{15}', imei) or str((body or {}).get('manufacturerId')) != '16':
            return 400, {'message': 'sandbox: need manufacturerId 16 and a 15-digit imei'}
        k = imei[8:10]
        if k == '99':
            return 500, {'message': 'sandbox: warranty lookup failed'}
        if k == '11':
            return 200, {'inWarranty': True, 'warrantyType': 'Standard', 'extendedWarranty': {}}
        if k == '22':
            return 200, {'inWarranty': True, 'warrantyType': 'Accidental Damage', 'extendedWarranty': {'claimFulfillmentId': 'SBX-CF-1', 'extendedWarrantyId': 'SBX-EW-1'}}
        return 200, {'inWarranty': False, 'warrantyType': '', 'extendedWarranty': {}}
    m = re.fullmatch(r'sandbox-tac(?:/(\d{8}))?', p)
    if m:
        return tac_route(method, m.group(1), body)

    # ---- harmless empties for the dashboard and header
    if p in ('store-metrics/overview', 'store-metrics/reporting'):  # fake KPI tiles (Dashboard + Reports)
        m = s['settings'].get('metrics') or {'todaysSales': {'actual': 1234.5, 'goal': 2500}, 'mtdSales': {'actual': 21840, 'goal': 52000},
                                            'dropOffs': {'actual': 9, 'goal': 12}, 'completedRepairs': {'actual': 7, 'goal': 10}}
        return 200, dict(m, asOf=now())
    EMPTY = {'twilio/unread-count': {'count': 0}, 'training/assigned': []}
    if p in EMPTY:
        return 200, EMPTY[p]
    if re.fullmatch(r'notifications/stores/\d+', p):
        return 200, {'notifications': [], 'total': 0, 'unread': 0}
    return 404, {'message': 'sandbox: not implemented', 'path': path}
