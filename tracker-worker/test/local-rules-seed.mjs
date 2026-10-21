// LOCAL ONLY: fake stores, people, keys and open work orders for trying the Assize rules editor on a local admin site.
// Writes SQL for `wrangler d1 execute --local`; never touches a remote database. Nothing here is real.
//   node tracker-worker/test/local-rules-seed.mjs > admin-worker/.wrangler/seed.sql
// Then (from admin-worker/):
//   npx wrangler d1 execute aethernet-tracker --local --file ../tracker-worker/schema.sql
//   npx wrangler d1 execute aethernet-waymark --local --file ../worker/schema.sql
//   npx wrangler d1 execute aethernet-tracker --local --file .wrangler/seed.sql
//   npx wrangler dev --local --var LOCAL_TEST:1 --var TRACKER_OWNERS:dev@local.test
// Open http://localhost:8787/?as=dev@local.test#rules (passphrase below) or ?as=store@local.test (store 914, no
// customer details). The passphrase is a local test value, not anyone's.
import * as C from '../src/crypto.js';

export const PASSPHRASE = 'otter maple crisp lantern harbor';
const q = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'");
const out = [];
const sql = (s) => out.push(s + ';');
const NOW = Date.now(), ago = (min) => new Date(NOW - min * 60000).toISOString();
const STAFF = { sam: { userId: 101, givenName: 'Sam', familyName: 'Rivera' }, jo: { userId: 102, givenName: 'Jordan', familyName: 'Park' }, alex: { userId: 103, givenName: 'Alex', familyName: 'Moore' } };
const PROG = { oop: [20001, 'Out Of Warranty'], asurion: [5062, 'Asurion Mobility'], cci: [7001, 'Consumer Cellular'], google: [7002, 'Google Pixel Care'] };
const STATUS = { rfw: [8, 'Ready for work'], wip: [10, 'Work in progress'], rfp: [13, 'Ready for pickup'], item: [3, 'Awaiting item'] };
const TYPE = { phone: 'Cell Phone', tablet: 'Tablet', console: 'Game Console' };

// [wo, device, type, program, status, outcome, nickname, bin, cart lines, notes [tag, text, staff, minutes ago]]
const ORDERS = {
  914: [
    [500684557, 'Galaxy S23', 'phone', 'oop', 'rfw', null, 'GALAXY S23 SCREEN', 'A2', [], [['initial_checkin', 'Cracked screen, lines on display.\nQuoted $229 for the OEM screen.\nCustomer will wait for the part.', 'sam', 300]]],
    [500683104, 'iPhone 13', 'phone', 'oop', 'wip', null, 'IPHONE 13 BATT', 'B1', [['SRV0006', 'Parts Deposit Offset', -52.99]], [['initial_checkin', 'Battery drains fast.\nScreen and battery quoted together.\nTook the parts deposit.', 'jo', 420]]],
    [500685011, 'Pixel 7', 'phone', 'oop', 'wip', null, 'PIXEL 7 BACK', 'B3', [], [['initial_checkin', 'Back glass shattered.\nCamera works.\nRegular customer.', 'alex', 200], ['note', 'Diag waived, regular customer.', 'alex', 150]]],
    [500681920, 'iPad 9th gen', 'tablet', 'oop', 'rfp', 'Incomplete', 'IPAD 9 10/23', 'C4', [], [['initial_checkin', 'No power.\nBoard-level fault.\nCustomer declined further work.', 'jo', 2000]]],
    [500685230, 'Galaxy Tab A8', 'tablet', 'oop', 'rfw', null, 'TAB A8 PORT', 'A5', [], [['initial_checkin', 'Charging port loose.\nCustomer wants a call before we start.\nNo case.', 'sam', 90]]],
    [500682776, 'Switch OLED', 'console', 'oop', 'rfw', null, 'SWITCH HDMI', 'D1', [['30412', 'HDMI port repair', 129.99]], [['initial_checkin', 'No video to the dock.\nHDMI port.\nQuoted $129.99.', 'alex', 600]]],
    [500683950, 'iPhone 14 Pro', 'phone', 'asurion', 'rfw', null, 'IPHONE 14P CLAIM', 'A1', [], [['initial_checkin', 'Claim: screen replacement.\nFace ID works.\nBack is fine.', 'sam', 240]]],
    [500686001, 'Moto G Play', 'phone', 'cci', 'rfp', 'Completed', 'MOTO G 10/23', 'E1', [['CCI15', 'CCI service', 15]], [['initial_checkin', 'Screen protector and diag.\nCustomer aware of fee.\nNo damage.', 'jo', 1500]]],
    [500686002, 'Moto G Stylus', 'phone', 'cci', 'rfp', 'Incomplete', 'MOTO STYLUS 10/23', 'E2', [], [['initial_checkin', 'Will not charge.\nCustomer aware.\nPort is corroded.', 'alex', 1400]]],
    [500686003, 'Galaxy A15', 'phone', 'cci', 'rfp', 'Completed', 'A15 10/24', 'E3', [['CCI20', 'CCI service plus', 20]], [['initial_checkin', 'Diag only.\nCustomer aware.\nNo damage.', 'sam', 1300]]],
    [500686004, 'iPhone 12', 'phone', 'oop', 'wip', null, 'IPHONE 12 SCREEN', 'B2', [['SCR12', 'iPhone 12 screen', 189]], [['note', 'Customer called for an update.', 'jo', 60]]],
    [500686005, 'Galaxy A54', 'phone', 'oop', 'item', null, 'A54 PART', 'F1', [['A54SCR', 'Galaxy A54 screen', 179]], [['initial_checkin', 'Screen ordered.\nQuoted $179.\nCustomer will be texted.', 'sam', 3000]]],
    [500686006, 'iPhone 15', 'phone', 'oop', 'rfw', null, 'IPHONE 15 BATT', 'A3', [['BAT15', 'iPhone 15 battery', 89]], [['initial_checkin', 'Battery swap, $89.', 'alex', 45]]],
    [500686007, 'Pixel 8', 'phone', 'google', 'rfp', 'Completed', 'PIXEL 8 10/23', 'E4', [], [['initial_checkin', 'Warranty screen.\nGSPN claim filed.\nCustomer aware.', 'jo', 1800]]],
    [500686008, 'iPhone 11', 'phone', 'oop', 'wip', null, 'IPHONE 11 SCREEN', 'B4', [], [['initial_checkin', 'Screen cracked.\nNo water damage.\nWaiting on approval.', 'sam', 100]]],
  ],
  326: [
    [600100001, 'iPhone 13 mini', 'phone', 'oop', 'rfw', null, 'IPHONE 13M', 'A1', [], [['initial_checkin', 'Cracked back.\nNo price yet.\nCustomer will call.', 'sam', 120]]],
    [600100002, 'Galaxy S22', 'phone', 'oop', 'wip', null, 'S22 SCREEN', 'A2', [['S22SCR', 'Galaxy S22 screen', 249]], [['initial_checkin', 'Screen.\nQuoted $249.\nOK with wait.', 'jo', 200]]],
    [600100003, 'Moto G Power', 'phone', 'cci', 'rfp', 'Completed', 'MOTO 10/23', 'B1', [['CCI15', 'CCI service', 15]], [['initial_checkin', 'Diag.\nCustomer aware.\nNo damage.', 'alex', 900]]],
  ],
};

const master = await C.newKeyPair();
sql('DELETE FROM master_key'); sql('DELETE FROM store_keys'); sql('DELETE FROM people'); sql('DELETE FROM person_keys'); sql('DELETE FROM workorders'); sql('DELETE FROM snapshots'); sql('DELETE FROM scans');
sql(`INSERT INTO master_key (id, public_jwk, created_by, created_at) VALUES (1, ${q(JSON.stringify(master.publicJwk))}, 'dev@local.test', ${q(ago(0))})`);
const pages = JSON.stringify(['wos', 'sales', 'metrics', 'data', 'usage', 'reports', 'auto', 'stores', 'rules']);
sql(`INSERT INTO people (email, name, scope, stores, pages, details) VALUES ('dev@local.test', 'Local Dev', 'all', '[]', ${q(pages)}, 1)`);
sql(`INSERT INTO people (email, name, scope, stores, pages, details) VALUES ('store@local.test', 'Store Lead', 'stores', '[914]', '["rules"]', 0)`);
const copy = await C.lockWithPhrase(await C.exportPrivate(master.privateKey), PASSPHRASE, C.aad.person('dev@local.test', 'master', 0));
sql(`INSERT INTO person_keys (email, kind, store, salt, rounds, wrapped, invite, created_by, created_at) VALUES ('dev@local.test', 'master', 0, ${q(copy.salt)}, ${copy.rounds}, ${q(copy.wrapped)}, 0, 'dev@local.test', ${q(ago(0))})`);

let lineId = 1;
for (const [store, list] of Object.entries(ORDERS)) {
  const sk = await C.newStoreKey(Number(store), master.publicJwk);
  sql(`INSERT INTO store_keys (store, public_jwk, wrapped_private, created_at) VALUES (${store}, ${q(JSON.stringify(sk.publicJwk))}, ${q(sk.wrappedPrivate)}, ${q(ago(0))})`);
  const name = store === '914' ? 'Newport News' : 'Lynnhaven';
  sql(`INSERT INTO scans (store, at, by_name, open_count) VALUES (${store}, ${q(ago(4))}, 'Local seed', ${list.length})`);
  for (const [wo, device, type, prog, status, outcome, nick, bin, cart, notes] of list) {
    const [programId, program] = PROG[prog], [statusId, statusName] = STATUS[status];
    const created = ago(Math.max(...notes.map((n) => n[3])) + 5), updated = ago(Math.min(...notes.map((n) => n[3])));
    const items = cart.map(([sku, nm, price]) => ({ lineId: lineId++, parentLineId: null, sku, itemNumber: sku, name: nm, price, quantity: 1, lineType: /CCI|SRV/.test(sku) ? 'service' : 'part' }));
    const total = items.reduce((t, i) => t + i.price, 0);
    const payment = { subtotal: total, total };
    const noteRows = notes.map(([tag, text, by, min]) => ({ noteType: 2, noteTag: tag, noteText: text, createdAt: ago(min), UserDatum: STAFF[by] }));
    const audit = [{ workorderStatusId: statusId, createdAt: updated, createdBy: STAFF[notes[0][2]].userId, completed: null }];
    const core = { workorder: { workorderId: wo, storeId: Number(store), workorderStatusId: statusId, WorkorderStatus: { name: statusName }, programId, Program: { name: program }, createdAt: created, updatedAt: updated, nextUpdate: ago(-240),
      CustomerDevice: { name: nick, DeviceCatalog: { name: device, DeviceModel: { DeviceType: { name: TYPE[type] } } } }, WorkorderBinDeviceLocation: { WorkorderBin: { name: bin } },
      WorkorderAttributes: outcome ? [{ workorderAttributeTypeId: 22, value: outcome }] : [], WorkorderDeviceIssueServiceOptions: [] } };
    const listRow = { workorderId: wo, workorderStatusId: statusId, workorderStatusName: statusName, programId, programName: program, createdAt: created, updatedAt: updated, nextUpdate: ago(-240), locationBin: bin,
      deviceCatalog: { name: device }, serviceOutcome: outcome || '', customerDevice: { name: nick }, createdBy: { givenName: STAFF[notes[0][2]].givenName, familyName: STAFF[notes[0][2]].familyName }, deviceTypeName: TYPE[type] };
    const sealed = { workorder: core, notes: { notes: noteRows, total: noteRows.length }, audit_trail: audit, cart: { cartItems: items, payment }, list_row: listRow };
    const plain = { workorder: { workorderId: wo, storeId: Number(store), statusId, status: statusName, programId, program, device, bin, outcome, createdAt: created, updatedAt: updated, nextUpdate: ago(-240) },
      auditTrail: audit.map((a) => ({ statusId: a.workorderStatusId, createdAt: a.createdAt, createdBy: a.createdBy, completed: a.completed })), notes: { total: noteRows.length },
      cart: { items: items.map(({ lineId: l, parentLineId, sku, name: nm, price, quantity }) => ({ lineId: l, parentLineId, sku, name: nm, price, quantity })), payment } };
    const box = await C.sealJson(sealed, sk.publicJwk, C.aad.snapshot(Number(store), wo));
    sql(`INSERT INTO workorders (store, wo, store_name, status_id, status_name, program_id, program_name, device, created_at, api_updated_at, is_open, first_seen_at, last_detail_at, service_outcome) VALUES (${store}, ${wo}, ${q(name)}, ${statusId}, ${q(statusName)}, ${programId}, ${q(program)}, ${q(device)}, ${q(created)}, ${q(updated)}, 1, ${q(created)}, ${q(ago(5))}, ${q(outcome)})`);
    sql(`INSERT INTO snapshots (store, wo, fetched_at, trigger, by_name, hash, plain, sealed) VALUES (${store}, ${wo}, ${q(ago(5))}, 'seed', 'Local seed', 'seed${wo}', ${q(JSON.stringify(plain))}, ${q(box)})`);
  }
}
process.stdout.write(out.join('\n') + '\n');
