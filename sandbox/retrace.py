"""Retrace in the sandbox (Oct 23, 2026): Portal's inventory calls the Retrace collector makes (src/28-retrace-collect.js),
answered from the Portal shapes captured at a real store (tracker-worker/test/fixtures/retrace/, already scrubbed and made
up), with that store renamed to the sandbox's; plus a stand-in for the tracker Worker's Retrace routes
(/api/sandbox-retrace/...), so a dev build runs a whole collector pass here without ever calling the Worker.

Labels on sandbox carts (api.py cart_view gives part lines a label) show up in their item's label list and serial
history as Reserved on that cart's sales order.
"""
import json, re
from pathlib import Path

FIX = Path(__file__).resolve().parent.parent / 'tracker-worker' / 'test' / 'fixtures' / 'retrace'


def fx(name, store):
    # the captured store (914) becomes the sandbox store, whatever field it's in
    txt = (FIX / (name + '.json')).read_text()
    txt = re.sub(r'"914(Q?)"', lambda m: '"%d%s"' % (store, m.group(1)), txt).replace('Store 914', 'Sandbox Store')
    return json.loads(txt)


def page(rows, q, size_default=100):
    size, n = int(q.get('pageSize') or size_default), int(q.get('page') or 1)
    return {'@odata.count': len(rows), 'value': rows[(n - 1) * size: n * size]}


def cart_labels(s):
    """[(label, item, cart line, wo)] for every part line with a label on a sandbox cart."""
    by_cart = {w['csuCartId']: w for w in s['wos'].values()}
    out = []
    for cid, c in s['carts'].items():
        for i in c['items']:
            lab = part_label(i)
            if lab:
                out.append((lab, i['sku'], i, by_cart.get(cid)))
    return out


def part_label(i):
    """The label a sandbox part line carries: <sku>-<10 digits from the line id>. None for labor, credits, accessories."""
    sku = str(i.get('sku') or '')
    if i.get('lineType') != 'item' or not re.fullmatch(r'\d{5,7}', sku) or sku in ('101516', '10156'):
        return None
    digits = re.sub(r'\D', '', str(i.get('lineId') or '')) or '0'
    return sku + '-' + digits.zfill(10)[-10:]


def route(method, p, q, body, s, store, now):
    """→ (status, json) or None when the path isn't Retrace's."""
    # ---- Portal: item lookup (sorted by the quantity asked for, paged)
    if p == 'boh/inventory-lookup' and method == 'GET':
        rows = fx('inventory-lookup', store)['OnHandItemDetails']
        field = {'availablequantity': 'AvailableQuantity', 'reservedquantity': 'ReservedQuantity', 'intransitquantity': 'InTransitQuantity'}.get((q.get('sortField') or '').lower())
        if field:
            rows = sorted(rows, key=lambda r: -(r.get(field) or 0))
        size, n = int(q.get('pageSize') or 100), int(q.get('page') or 1)  # Portal's envelope (captured live at 914, Oct 24 2026)
        return 200, {'$id': '1', 'OnHandItemDetails': rows[(n - 1) * size: n * size], 'TotalRecords': len(rows), 'ErrorMessage': None, 'Success': True, 'DebugMessage': None}
    m = re.fullmatch(r'boh/store-products/([^/]+)/inventory', p)
    if m and method == 'GET':
        item = m.group(1)
        rows = [r for r in fx('store-products', store)['value'] if r['ItemNumber'] == item]
        for lab, sku, line, w in cart_labels(s):
            if sku == item:
                rows.append({'dataAreaId': 'ubf', 'SerialNumber': lab, 'ItemNumber': sku, 'BuybackItemType': 'None', 'UbifSalesOnOrder': 1, 'OnHandQuantity': 1, 'WarehouseId': str(store),
                             'SerialStatus': 'Reserved', 'ConsignmentStatus': 'No', 'UbifSerialStatus': 'Received', 'PurchId': 'UBFPO000099002', 'Locked': False, 'Store': str(store),
                             'SerialModified': now(), 'Vendor': 'Vendor One', 'DistroLabelId': '', 'SiteId': str(store), 'SerialCreated': '2026-08-01T12:00:00Z', 'LineNumber': 1})
        return 200, dict(page(rows, q, 200), **{'@odata.context': 'https://example.invalid/$metadata#StoreProductInventory'})
    m = re.fullmatch(r'boh/store-products/([^/]+)', p)
    if m and method == 'GET':
        # the item page's header call: shape not captured beyond ProductName and the quantities (made up from the lookup row,
        # else a sandbox cart line's name, else a made-up name; 404 for a non-numeric item, as for one Portal doesn't know)
        item = m.group(1)
        row = next((r for r in fx('inventory-lookup', store)['OnHandItemDetails'] if r['ItemNumber'] == item), None)
        name = row['ProductName'] if row else next((line.get('name') for _, sku, line, _w in cart_labels(s) if sku == item and line.get('name')), None)
        if not name and not re.fullmatch(r'\d{4,8}', item):
            return 404, {'message': 'Product not found'}
        name = name or 'Sandbox part ' + item
        return 200, {'ItemNumber': item, 'ProductName': name, 'AvailableQuantity': (row or {}).get('AvailableQuantity', 0), 'InTransitQuantity': (row or {}).get('InTransitQuantity', 0),
                     'RetailCategory': (row or {}).get('RetailCategory', 'Parts')}
    m = re.fullmatch(r'boh/serial-history/([^/]+)', p)
    if m and method == 'GET':
        lab = m.group(1)
        for rows in fx('serial-history', store).values():
            if rows['value'] and rows['value'][0]['InventSerialId'] == lab:
                return 200, rows
        item = lab.split('-')[0]
        base = {'@odata.etag': 'W/"1"', 'dataAreaId': 'ubf', 'InventSerialId': lab, 'ItemId': item, 'Store': str(store), 'User': 'System', 'Message': ''}
        rows = [dict(base, DateTime='2026-10-01T15:00:00Z', SerialEventType='ProductReceipt', SerialStatus='Received', RefTable='Purchase orders', SourceKey='UBFPO000099002', SourceKeyLineNum=1)]
        for l, _, line, w in cart_labels(s):
            if l == lab:
                so = (w or {}).get('csuSalesOrderId') or 'FSO-SBX%05d' % int(re.sub(r'\D', '', str(line.get('lineId'))) or 0)
                rows.append(dict(base, DateTime=now(), SerialEventType='SerialReserved', SerialStatus='Received', RefTable='Sales orders', SourceKey=so, SourceKeyLineNum=1, User='RetailServiceAccount'))
        return 200, {'@odata.context': 'https://example.invalid/$metadata#SerialHistory', 'value': rows}
    m = re.fullmatch(r'boh/inventory/([^/]+)', p)
    if m and method == 'GET':
        lab = m.group(1)
        d = fx('label-details', store)
        d.update({'SerialNumber': lab, 'ItemNumber': lab.split('-')[0], 'WorkOrderId': '', 'SalesOrderNumber': '', 'SerialStatus': 'Available'})
        for l, _, line, w in cart_labels(s):
            if l == lab and w:
                d.update({'WorkOrderId': str(w['workorderId']), 'SalesOrderNumber': w.get('csuSalesOrderId') or '', 'SerialStatus': 'Reserved'})
        return 200, d

    # ---- Portal: documents
    if p == 'boh/rma-buyback/outstanding-parts' and method == 'GET':
        return 200, fx('outstanding-parts', store)
    if p == 'boh/rma-buyback/rma-orders' and method == 'GET':
        o = fx('rma-order', store)
        # list row shape: not captured; the order's header fields without its lines (GUESS)
        return 200, page([{k: v for k, v in o.items() if k != 'details'}], q, 50)
    m = re.fullmatch(r'boh/rma-order/([^/]+)', p)
    if m and method == 'GET':
        o = fx('rma-order', store)
        return (200, o) if m.group(1) == o['RMAPurchId'] else (404, {'message': 'RMA order not found'})
    if p == 'boh/purchase-orders' and method == 'POST':
        t = (body or {}).get('orderType')
        if t == 'past' and (body or {}).get('startDate') and not re.fullmatch(r'\d{4}-\d\d-\d\d', str(body.get('startDate'))):
            return 500, {'message': 'sandbox: dates are YYYY-MM-DD (what Portal accepts)'}
        head = {k: v for k, v in fx('po-header', store).items() if k != 'PurchaseOrderLinesV2'}
        rows = {'in-transit': [head], 'past': fx('po-list', store)['value'], 'draft': []}.get(t, [])
        return 200, page(rows, q, 50)
    m = re.fullmatch(r'boh/purchase-orders/([^/]+)(/receive-details)?', p)
    if m and method == 'GET':
        po, rec = m.group(1), m.group(2)
        h, past = fx('po-header', store), fx('po-list', store)['value'][0]
        if rec:
            return 200, fx('po-receive', store) if po == h['PurchaseOrderNumber'] else {'PurchaseOrderId': po, 'Status': past['PurchaseOrderStatus'], 'Lines': []}
        if po == h['PurchaseOrderNumber']:
            return 200, h
        return (200, dict(past, PurchaseOrderLinesV2=[])) if po == past['PurchaseOrderNumber'] else (404, {'message': 'PO not found'})
    if p == 'boh/store-transfer-orders' and method == 'GET':
        # made up in the shape retrace.js reads (transfer lists not captured yet)
        rows = [{'transferOrderId': 'TO-SBX-1', 'createdDate': '2026-10-20T14:00:00Z', 'shippedDate': '2026-10-21T15:00:00Z', 'receivedDate': '2026-10-22T16:00:00Z',
                 'storeTransferStatus': 'Received', 'fromInventLocationId': '326', 'fromInventLocationName': 'Lynnhaven', 'toInventLocationId': str(store), 'toInventLocationName': 'Sandbox Store',
                 'lines': [{'lineNum': 1, 'itemName': 'Galaxy S24 Battery', 'itemNumber': '180001', 'serialNumber': '180001-0000600009'}]}] if q.get('direction') == 'receive' else []
        return 200, page(rows, q, 50)
    if p == 'boh/remote-tech/van-warehouses' and method == 'GET':
        return 200, []  # shape not captured; the sandbox store has no vans

    # ---- Portal: a WO's events (parts added for each part line on its cart)
    m = re.fullmatch(r'workorder/(\d+)/events', p)
    if m and method == 'GET':
        w = s['wos'].get(m.group(1))
        if not w:
            return 404, {'message': 'not found'}
        evs = []
        for i in (s['carts'].get(w['csuCartId']) or {}).get('items', []):
            if part_label(i):
                evs.append({'userId': 990001, 'entityType': 'WORKORDER', 'metadata': {'ipAddress': '192.0.2.1'}, 'eventType': 'PARTS_UPDATED', 'version': 1,
                            'eventData': {'type': 'add', 'version': 1, 'items': [{'itemId': int(i['sku']), 'quantity': 1, 'item': {'name': i.get('name'), 'itemNumber': i['sku']}}]},
                            'entityId': 'WORKORDER#%s' % w['workorderId'], 'eventId': 'ev-' + str(i['lineId']), 'timestamp': w['updatedAt'],
                            'user': {'userId': 990001, 'givenName': 'Sandbox', 'familyName': 'Tech'}})
        return 200, {'events': evs, 'lastKey': None}

    # ---- the tracker Worker's Retrace routes, stood in for (never the real Worker)
    m = re.fullmatch(r'sandbox-retrace/(cursor|sweep|history|watch|progress)', p)
    if m:
        return worker(m.group(1), method, body or {}, s, now)
    return None


def worker(path, method, b, s, now):
    r = s.setdefault('retrace', {'cursors': {}, 'items': {}, 'labels': {}, 'pos': {}, 'watched': 0, 'histories': 0})
    if path == 'cursor' and method == 'GET':
        return 200, {'cursors': r['cursors'], 'baseline': {'frozen': bool(r.get('frozen')), 'posKnown': r.get('po_total') is not None}}
    if path == 'progress' and method == 'GET':
        # the stand-in keeps only whether counting is finished (the real Worker's numbers: tracker-worker/src/retrace-api.js progress)
        return 200, {'store': None, 'state': 'gathering' if r.get('frozen') else 'counting', 'pct': None, 'done_at': None, 'announce': False}
    if path == 'watch' and method == 'POST':
        mv = b.get('movements') or []
        if not mv or len(mv) > 50:
            return 400, {'error': 'movements required (1 to 50)'}
        r['watched'] += len(mv)
        r.setdefault('watch_log', []).extend(mv)
        r['watch_log'] = r['watch_log'][-50:]
        return 200, {'ok': True, 'added': len(mv), 'rejected': 0}
    if path == 'history' and method == 'POST':
        lab = b.get('label')
        if lab in r['labels']:
            r['labels'][lab] = 0
        r['histories'] += 1
        return 200, {'ok': True, 'added': len(b.get('rows') or []), 'same': False, 'skipped': 0}
    if path == 'sweep' and method == 'POST':
        caps = {'items': 2400, 'labels': 800, 'docs': 200, 'movements': 500, 'touched': 500, 'pos': 600, 'names': 200, 'labelTotals': 800}
        for k, n in caps.items():
            if len(b.get(k) or []) > n:
                return 400, {'error': '%s: a list of at most %d' % (k, n)}
        changed = []
        for row in b.get('items') or []:
            item = str(row.get('ItemNumber'))
            key = json.dumps([row.get(k) for k in ('WarehouseId', 'AvailableQuantity', 'ReservedQuantity', 'InTransitQuantity', 'OnHandQuantity')])
            old = r['items'].get(item + '|' + str(row.get('WarehouseId')))
            if old != key and item not in [c['item'] for c in changed]:
                changed.append({'item': item, 'why': 'changed' if old else 'new'})
            r['items'][item + '|' + str(row.get('WarehouseId'))] = key
        names, named = r.setdefault('names', {}), 0
        def name(item, n, auth):
            nonlocal named
            if item and n and str(item).lower() != 'bb0001' and (str(item) not in names or (auth and names[str(item)] != n)):
                names[str(item)] = n
                named += 1
        for row in b.get('items') or []:
            name(row.get('ItemNumber'), row.get('ProductName'), True)
        for x in (b.get('labels') or []):
            lab = x.get('label') or x.get('SerialNumber')
            if lab and lab not in r['labels']:
                r['labels'][lab] = 1
            name(x.get('item') or (lab or '').split('-')[0], x.get('product'), x.get('list') is None)
        for x in b.get('names') or []:
            name(x.get('item'), x.get('name'), x.get('authoritative') is True)
        for lab in b.get('touched') or []:
            r['labels'][lab] = 2
        for x in b.get('movements') or []:
            if x.get('label'):
                r['labels'][x['label']] = 2
        for x in b.get('pos') or []:
            h = x.get('header') or x
            po = h.get('PurchaseOrderNumber')
            if po:
                r['pos'][po] = r['pos'].get(po, 1) if not (x.get('receive') or h.get('PurchaseOrderLinesV2') is not None) else 0
        for k, v in (b.get('cursors') or {}).items():
            r['cursors'][k] = {'value': v, 'at': now()}
        # the baseline: label counts per lookup item, then the PO total; frozen when every lookup item has a count and the PO total is in
        counts = r.setdefault('counts', {})
        if not r.get('frozen'):
            for x in b.get('labelTotals') or []:
                if str(x.get('item') or '') and isinstance(x.get('total'), int) and x['total'] >= 0 and str(x['item']).lower() != 'bb0001':
                    counts[str(x['item'])] = x['total']
            if isinstance(b.get('poTotal'), int) and r.get('po_total') is None:
                r['po_total'] = b['poTotal']
            looked = {k.split('|')[0] for k in r['items']}
            if 'lookup' in r['cursors'] and r.get('po_total') is not None and all(i in counts for i in looked):
                r['frozen'] = True
        count_need = [] if r.get('frozen') else sorted({k.split('|')[0] for k in r['items']} - set(counts))[:min(int(b.get('countNeed') or 0), 300)]
        want = b.get('need') if isinstance(b.get('need'), int) else 60
        need = [l for l, n in sorted(r['labels'].items(), key=lambda kv: -kv[1]) if n][:want]
        po_need = [po for po, n in r['pos'].items() if n][:b.get('poNeed') or 0]
        known = list(dict.fromkeys([re.sub(r'^B-', '', l).split('-')[0] for l in reversed(list(r['labels']))]))
        unnamed = [i for i in known if i not in names and i.lower() != 'bb0001'][:min(int(b.get('nameNeed') or 0), 50)]
        return 200, {'need': need, 'more': sum(1 for n in r['labels'].values() if n) > len(need), 'changedItems': changed, 'added': len(b.get('movements') or []),
                     'rejected': 0, 'skipped': 0, 'written': len(b.get('items') or []) + len(b.get('labels') or []), 'named': named, 'unnamed': unnamed, 'countNeed': count_need,
                     'pos': {'seen': len(b.get('pos') or []), 'written': 0, 'events': 0, 'received': 0, 'need': po_need}}
    return 404, {'error': 'not found'}
