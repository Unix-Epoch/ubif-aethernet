// Morning check (src/68-morning-check.js): the Portal calls each change makes, the store and staleness guards, and which status
// moves count as proven. Fake data only. node test-client/morning-check.mjs
import fs from 'fs';
import vm from 'vm';
import assert from 'assert/strict';

function make(wo, store = 914, link = null) {
  const calls = [], events = [];
  const state = { wo: JSON.parse(JSON.stringify(wo)) };
  const AE = {
    api: async (method, path, body) => {
      calls.push({ method, path, body: body && JSON.parse(JSON.stringify(body)) });
      if (method === 'GET' && /demographic\/customer-data$/.test(path)) return { customerId: 77 };
      if (method === 'GET') return { workorder: JSON.parse(JSON.stringify(state.wo)) };
      if (method === 'PUT' && /^\/api\/workorder\/\d+$/.test(path)) {
        if (body.workorderStatusId) state.wo.workorderStatusId = body.workorderStatusId;
        if (state.keepsBin && body.workorderBin != null) state.wo.WorkorderBinDeviceLocation = { WorkorderBin: { name: body.workorderBin } };
        state.wo.updatedAt = 'later';
      }
      if (method === 'PATCH') state.wo.workorderStatusId = body.workorderStatusId;
      return {};
    },
    shape: { workorder: (j) => { if (!j || !j.workorder || typeof j.workorder.workorderStatusId !== 'number') throw new Error('bad shape'); return j.workorder; } },
    profile: async () => ({ storeId: store, name: 'Sam Tech' }),
    emit: (n, d) => events.push([n, d]), refreshView: () => {},
  };
  const sent = [], handlers = {};
  if (link) {
    const el = () => ({ replaceChildren() {}, remove() {}, append() {} });
    Object.assign(AE, {
      linkshell: { on: (k, fn) => { handlers[k] = fn; }, send: (k, b) => { sent.push([k, JSON.parse(JSON.stringify(b))]); return 'id'; }, linked: () => link },
      data: { workorders: async () => link.rows || [], nameOf: (r) => (r.customer && r.customer.fullName) || '' },
      h: el, actionIcon: () => '', icon: () => '', track: () => {}, noteError: () => {},
    });
  }
  const document = { getElementById: () => null, head: { append() {} }, body: { append() {} } };
  const ctx = vm.createContext({ AE, AE_ON_PORTAL: true, document, location: { pathname: '/repair/workorder/1' }, console });
  vm.runInContext(fs.readFileSync(new URL('../src/68-morning-check.js', import.meta.url), 'utf8'), ctx);
  return { mc: AE.morningCheck, calls, events, state, sent, handlers };
}
// Portal's real shape (test-client/fixtures/wo-template.json): the customer is only on CustomerDevice, as a string.
const WO = { workorderId: 1, workorderStatusId: 8, storeId: 914, updatedAt: 'u1',
  CustomerDevice: { customerDeviceId: 9, customerId: '55', passcode: 'x', serial: 's', imei: 'i', deviceCatalogId: 3, name: 'Blue case' },
  WorkorderBinDeviceLocation: { WorkorderBin: { name: 'B2' } } };
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok  ', name); };

await t('read: status, bin, nickname', async () => {
  const { mc } = make(WO);
  assert.deepEqual(JSON.parse(JSON.stringify(await mc.read(1))), { wo: '1', statusId: 8, status: 'Ready for work', bin: 'B2', nickname: 'Blue case', updatedAt: 'u1' });
});
await t('8 → 9: PATCH status and the start note (proven)', async () => {
  const { mc, calls } = make(WO);
  await mc.setStatus(1, 9);
  const w = calls.filter((c) => c.method !== 'GET');
  assert.equal(w[0].method, 'PATCH'); assert.equal(w[0].path, '/api/workorder/1/status'); assert.deepEqual(w[0].body, { workorderStatusId: 9 });
  assert.equal(w[1].path, '/api/note'); assert.equal(w[1].body.noteTag, 'ready_for_work'); assert.equal(w[1].body.noteText, 'Sam Tech started work.');
});
await t('a move nobody recorded: the PUT back, no note, sendComms false', async () => {
  const { mc, calls } = make(Object.assign({}, WO, { workorderStatusId: 10 }));
  assert.equal(mc.statusPlan(10, 7).proven, false);
  await mc.setStatus(1, 7);
  const w = calls.filter((c) => c.method !== 'GET');
  assert.equal(w.length, 1); assert.equal(w[0].method, 'PUT'); assert.equal(w[0].body.workorderStatusId, 7); assert.equal(w[0].body.sendComms, false);
  assert.equal(w[0].body.markCurrentStepCompleted, false); assert.equal('workorderId' in w[0].body, false);
});
await t('12 → 13: attribute call first, then the PUT and its note', async () => {
  const { mc, calls } = make(Object.assign({}, WO, { workorderStatusId: 12 }));
  await mc.setStatus(1, 13);
  const w = calls.filter((c) => c.method !== 'GET').map((c) => c.method + ' ' + c.path);
  assert.deepEqual(w, ['POST /api/workorder/attribute', 'PUT /api/workorder/1', 'POST /api/note']);
  assert.equal(calls.find((c) => c.path === '/api/workorder/attribute').body.workorderBin, 'B2');
});
await t('changed in Portal since the phone read it: nothing sent', async () => {
  const { mc, calls } = make(WO);
  await assert.rejects(mc.setStatus(1, 9, { updatedAt: 'old' }), /Changed in Portal/);
  await assert.rejects(mc.setBin(1, 'A1', { updatedAt: 'old' }), /Changed in Portal/);
  assert.equal(calls.filter((c) => c.method !== 'GET').length, 0);
});
await t('another store\'s work order: nothing sent', async () => {
  const { mc, calls } = make(WO, 1000);
  await assert.rejects(mc.setNickname(1, 'x'), /Another store/);
  await assert.rejects(mc.addNote(1, 'x'), /Another store/);
  assert.equal(calls.filter((c) => c.method !== 'GET').length, 0);
});
await t('nickname: the device record back with only the name changed', async () => {
  const { mc, calls, events } = make(WO);
  await mc.setNickname(1, 'Red case');
  const c = calls.find((x) => x.method === 'PUT');
  assert.equal(c.path, '/api/customer-devices/9');
  assert.deepEqual(JSON.parse(JSON.stringify(c.body)), { customerDeviceId: 9, customerId: '55', passcode: 'x', serial: 's', imei: 'i', deviceCatalogId: 3, name: 'Red case' });
  assert.deepEqual(JSON.parse(JSON.stringify(events[0])), ['wo-changed', { woId: '1', why: 'nickname' }]);
});
await t('note: a hand-typed note (type 2) tagged with the status; empty refused', async () => {
  const { mc, calls } = make(WO);
  await mc.addNote(1, '  On the bench  ');
  const c = calls.find((x) => x.path === '/api/note');
  assert.deepEqual(c.body, { noteText: 'On the bench', customerId: '55', workorderId: 1, noteTag: 'ready_for_work', noteType: 2 });
  await assert.rejects(mc.addNote(1, '  '), /Empty note/);
});
await t('note: the customer comes from the device record; without one, from the demographic call', async () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/wo-template.json', import.meta.url), 'utf8')).workorder.workorder;
  assert.equal(fixture.customerId, undefined); // why: Portal's detail has no top-level customerId
  const { mc, calls } = make(Object.assign({}, WO, { CustomerDevice: Object.assign({}, WO.CustomerDevice, { customerId: null }) }));
  await mc.addNote(1, 'Hi');
  assert.equal(calls.find((x) => x.path === '/api/note').body.customerId, '77');
});
await t('location: PUT with the new bin, then read back; refused if Portal kept the old one', async () => {
  const a = make(WO); a.state.keepsBin = true;
  assert.equal((await a.mc.setBin(1, ' A1 ')).bin, 'A1');
  const put = a.calls.find((c) => c.method === 'PUT');
  assert.equal(put.path, '/api/workorder/1'); assert.equal(put.body.workorderBin, 'A1'); assert.equal(put.body.binLocation, 'A1'); assert.equal(put.body.sendComms, false);
  const b = make(WO);
  await assert.rejects(b.mc.setBin(1, 'A1'), /didn't take/);
});
await t('the phone may only move up to Work in progress', async () => {
  const { mc } = make(WO);
  assert.equal(mc.PHONE_STATUSES.some((s) => [11, 12, 13].includes(s)), false);
  assert.equal(mc.PHONE_STATUSES.includes(10), true);
});
await t('Linkshell: a host link lists open work orders with the moves the phone may make', async () => {
  const rows = [{ workorderId: 1, workorderStatusId: 8, locationBin: 'B2', customerDevice: { name: 'Blue case' }, deviceCatalog: { name: 'iPhone 14' }, deviceIssues: [{ name: 'Screen' }], customer: { fullName: 'Riley Price' }, programName: 'Retail', updatedAt: 'u1' }];
  const { sent, handlers } = make(WO, 914, { host: true, phoneName: 'Pixel', rows });
  await handlers['check.start']({ run: 'r1' });
  const [kind, b] = sent[0];
  assert.equal(kind, 'check.list'); assert.equal(b.parts, 1); assert.equal(b.bins, true);
  assert.deepEqual(b.rows[0], ['1', 8, 'B2', 'Blue case', 'iPhone 14', 'Screen', 'Riley Price', 'Retail', 'u1']);
  assert.deepEqual(b.statuses.find((x) => x[0] === 8)[2], [9]);
  assert.deepEqual(b.statuses.find((x) => x[0] === 12)[2], []);
});
await t('Linkshell: changes run in order; a bin Portal did not keep and a Portal-only move fail, the rest saved', async () => {
  const { sent, handlers, calls } = make(Object.assign({}, WO, { workorderStatusId: 10 }), 914, { host: true, rows: [] });
  await handlers['check.start']({ run: 'r1' });
  await handlers['check.set']({ run: 'r1', cid: 'c1', wo: '1', updatedAt: 'u1', nickname: 'Red', note: 'Hi', bin: 'A1', status: 13 });
  const r = sent.find((x) => x[0] === 'check.result')[1];
  assert.equal(r.ok, false);
  assert.deepEqual(r.failed.map((f) => f[0]), ['bin', 'status']);
  assert.deepEqual(calls.filter((c) => c.method !== 'GET').map((c) => c.method + ' ' + c.path), ['PUT /api/customer-devices/9', 'POST /api/note', 'PUT /api/workorder/1']);
});
await t('Linkshell: stale order or no check running: nothing written', async () => {
  const { sent, handlers, calls } = make(WO, 914, { host: true, rows: [] });
  await handlers['check.set']({ run: 'r1', cid: 'c0', wo: '1', nickname: 'x' });
  assert.equal(sent[0][1].failed[0][1], 'Not running on the PC');
  await handlers['check.start']({ run: 'r1' });
  await handlers['check.set']({ run: 'r1', cid: 'c1', wo: '1', updatedAt: 'older', nickname: 'x' });
  assert.equal(sent.find((x) => x[0] === 'check.result' && x[1].cid === 'c1')[1].failed[0][1], 'Changed in Portal since');
  assert.equal(calls.filter((c) => c.method !== 'GET').length, 0);
});
console.log('\n' + n + ' Morning check tests passed');
