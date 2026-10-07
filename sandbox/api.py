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
STORE_ID = 914  # what the sandbox calls itself; none of the store's real data is used

PROGRAMS = {6494: 'Samsung In Warranty Repair', 8849: 'Asurion Home+ Repairs', 5062: 'Asurion Mobility', 11759: 'VZ Device Refresh', 9470: 'VZ Sanitization', 11009: 'AT&T Enhanced Cleaning',
            9901: 'AT&T Device Diagnostic', 10303: 'AT&T Performance Check', 20001: 'Out Of Warranty'}
CLEANINGS = [11759, 9470, 11009, 9901, 10303]
STATUS = {1: 'Initial check-in', 2: 'Need to order', 3: 'Awaiting item', 7: 'Awaiting callback', 8: 'Ready for work', 9: 'Diagnostics',
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
    return json.loads(f.read_text()) if f.exists() else default


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
            'programId': w['programId'], 'programName': PROGRAMS.get(w['programId'], 'Program'), 'createdAt': w['createdAt'], 'updatedAt': w['updatedAt'],
            'nextUpdate': w['nextUpdate'], 'customer': cust_view(w['customerId']), 'customerDevice': dev_view(w['customerDeviceId']),
            'customerDeviceId': w['customerDeviceId'], 'deviceCatalog': {'name': d.get('deviceName')}, 'deviceIssues': ['Cleaning'] if w['programId'] in CLEANINGS else ['Screen'],
            'serviceOutcome': w.get('serviceOutcome', ''), 'workorderTotal': cart_view(w['csuCartId'])['payment']['total'], 'claimNumber': None, 'clientId': 1,
            'matchedRules': [], 'itemswithdevice': ''}


def wo_detail(w):
    tpl = copy.deepcopy((fixture('wo-template', {}) or {}).get('workorder') or {'workorder': {}})
    inner = tpl.setdefault('workorder', {})
    d = load()['devices'].get(str(w['customerDeviceId']), {})
    inner.update({'workorderId': w['workorderId'], 'workorderStatusId': w['workorderStatusId'], 'programId': w['programId'], 'storeId': STORE_ID,
                  'createdAt': w['createdAt'], 'updatedAt': w['updatedAt'], 'nextUpdate': w['nextUpdate'], 'csuCartId': w['csuCartId'],
                  'csuSalesOrderId': w.get('csuSalesOrderId', ''), 'customerDeviceId': w['customerDeviceId'], 'clientId': 1, 'claimNumber': None,
                  'WorkorderStatus': {'name': STATUS.get(w['workorderStatusId'], ''), 'workorderStatusId': w['workorderStatusId']},
                  'Program': {'name': PROGRAMS.get(w['programId'], 'Program'), 'programId': w['programId'], 'programTypeId': 4},
                  'Store': {'storeName': 'Sandbox Store', 'isDepot': None}})
    cd = inner.setdefault('CustomerDevice', {})
    cd.update({'customerDeviceId': w['customerDeviceId'], 'customerId': w['customerId'], 'imei': d.get('imei', ''), 'name': d.get('name', ''),
               'passcode': '', 'serial': ''})
    if isinstance(cd.get('DeviceCatalog'), dict):
        cd['DeviceCatalog']['name'] = d.get('deviceName', '')
    inner['WorkorderAttributes'] = [{'workorderAttributeId': i + 1, 'workorderId': w['workorderId'], 'workorderAttributeTypeId': a.get('workorderAttributeTypeId'),
                                     'key': a.get('key'), 'value': a.get('value'), 'createdAt': now(), 'updatedAt': now()} for i, a in enumerate(w.get('attributes', []))]
    if isinstance(inner.get('PartnerJob'), dict):
        inner['PartnerJob'].update({'workorderId': w['workorderId'], 'arrivalId': w.get('arrivalId'), 'customerDeviceId': w['customerDeviceId'], 'PartnerJobAttributes': []})
    inner['Customer'] = cust_view(w['customerId'])
    return tpl


def arrival_view(a):
    return {'arrivalId': a['arrivalId'], 'program': {'programId': a['programId'], 'name': PROGRAMS.get(a['programId'], 'Program')},
            'arrivalStatus': {'arrivalStatusId': a['statusId'], 'arrivalStatusName': 'Confirmed' if a['statusId'] == 21 else 'Not confirmed'},
            'arrivalAttributes': [{'arrivalAttributeTypeId': 53, 'value': '1'}] if a.get('contacted') else [], 'arrivalTypeId': a.get('arrivalTypeId', 1),
            'appointment': a['appointment'], 'createdAt': a['createdAt'], 'updatedAt': a['createdAt'], 'customer': cust_view(a['customerId']),
            'customerDevice': dev_view(a['customerDeviceId']), 'deviceIssues': [{'name': 'Cleaning'}], 'clientId': 1, 'clientName': 'Asurion',
            'storeId': STORE_ID, 'isDepotStore': False, 'isMissed': False, 'matchedRules': [], 'notes': [n for n in load()['notes'] if n.get('arrivalId') == a['arrivalId']],
            'source': 'Claim' if a.get('arrivalTypeId') == 3 else 'Appointment',
            'csuCartId': None, 'csuSalesOrderId': None, 'partnerJobDetails': {'serviceJobId': a['serviceJobId']}}


# ------------------------------------------------------------------ routes
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
                     'userAttributes': {'PageCount': 25}, 'storeTwilioPhoneNumber': '+15555550199', 'isOutboundCommunicationEnabled': True}
    if p == 'auth/user/stores':
        return 200, fixture('user-stores', [])
    if p == 'auth/store-options':
        return 200, fixture('store-options', {'stores': []})
    if p == 'features':
        return 200, fixture('features', {})
    if p == 'notification/get-partner-downtime':
        return 200, fixture('partner-downtime', [])
    if p == 'store-time-sheet/access':
        return 200, fixture('timesheet-access', {})
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

    # ---- harmless empties for the dashboard and header
    EMPTY = {'store-metrics/overview': {}, 'twilio/unread-count': {'count': 0}, 'training/assigned': [], 'store-metrics/reporting': {}}
    if p in EMPTY:
        return 200, EMPTY[p]
    if re.fullmatch(r'notifications/stores/\d+', p):
        return 200, {'notifications': [], 'total': 0, 'unread': 0}
    return 404, {'message': 'sandbox: not implemented', 'path': path}
