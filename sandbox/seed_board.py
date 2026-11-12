#!/usr/bin/env python3
"""Fill the sandbox with fake open work orders across statuses, for trying Spread (the board view).

  python3 sandbox/seed_board.py 18          # 18 fake open work orders
  python3 sandbox/seed_board.py 45          # 45 (a column scrolls)
  python3 sandbox/seed_board.py 18 --odd    # plus 3 in statuses Spread has no column for (5, 17, 26), with invented names

Stop the sandbox server first (it keeps state in memory); then start it again. This REPLACES the sandbox's work orders,
customers, devices and carts (state.json is git-ignored). Everything is invented: fake names, programs, bins, totals.
Row fields use Portal's real names (see wo_row in api.py); hours = how long ago the row was last updated.
"""
import random, sys
sys.path.insert(0, __file__.rsplit('/', 1)[0])
import api

N = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 18
ODD = '--odd' in sys.argv
random.seed(7)
s = api.load()
for k in ('wos', 'customers', 'devices', 'carts'):
    s[k].clear()
# (status, hours since last update)
if N == 18:
    plan = [(2, 50), (2, 20), (3, 100), (3, 8), (8, 3), (8, 29), (8, 70), (9, 5), (9, 52), (9, 1), (10, 26), (10, 9), (11, 2), (12, 120), (4, 45), (7, 30), (7, 6), (13, 4)]
else:
    plan = []
    for st, n in {2: 4, 3: 4, 8: 6, 9: 7, 10: 8, 11: 3, 12: 3, 4: 3, 7: 3, 13: 4, 24: 2}.items():
        plan += [(st, random.choice([1, 2, 3, 5, 8, 12, 20, 26, 31, 48, 55, 75, 100, 130])) for _ in range(n)]
    random.shuffle(plan)
    plan = plan[:N]
if ODD:
    plan += [(5, 10), (17, 60), (26, 30)]
PROGS = [6494, 8849, 5062, 11759, 20001, 9470, 11009]
ISSUES = ['Cracked screen', 'Battery', 'Charge port', 'Back glass', 'Water damage', 'Camera', "Won't power on", 'Speaker', 'Screen']
BINS = ['A3', 'B1', 'C7', 'A12', 'D2', 'B9']
ATT = {2: ('urgent', ['Part is late']), 8: ('warning', ['Customer waiting'])}  # invented reasons
used = set()
for i, (st, h) in enumerate(plan):
    while True:
        nm = random.choice(api.FIRST) + ' ' + random.choice(api.LAST)
        if nm not in used:
            used.add(nm); break
    c = api.new_customer(nm); d = api.new_device(c)
    w = api.new_wo(c, d, random.choice(PROGS), status=st, created=api.now(-h - random.randint(1, 30)))
    w['updatedAt'] = api.now(-h)
    w['rfpAt'] = api.now(-h) if st == 13 else None
    w['issues'] = [random.choice(ISSUES)] + (['Battery'] if i % 7 == 3 else [])
    w['binLocation'] = random.choice(BINS) if (st in (2, 3, 4, 7, 13) and random.random() < .8) or random.random() < .25 else ''
    if i % 3 == 0:
        w['attention'] = random.choice(['', '', 'none', 'warning', 'urgent'])
        if w['attention'] in ('warning', 'urgent'):
            w['attentionReasons'] = ['Needs a look (fake)']
    if st in (5, 17, 26):
        w['statusName'] = 'Fake status ' + str(st)
api.save()
print(len(plan), 'fake open work orders in sandbox/state.json')
