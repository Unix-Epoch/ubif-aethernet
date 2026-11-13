// Runs the REAL tracker Worker code (tracker-worker/src) over HTTP on localhost with a seeded local D1, for Linkpearl's integration test
// and to capture real answers as test fixtures. Nothing remote is touched (getPlatformProxy local persistence in a throwaway directory).
//
//   cd tracker-worker && node ../android/tools/local-server.mjs serve [port]       app key "k"; control routes below
//   cd tracker-worker && node ../android/tools/local-server.mjs fixtures <outDir>  writes real JSON answers, then exits
//
// Control routes (only here, not in the Worker): POST /__ctl/approve {id, stores}, POST /__ctl/remove {id}, GET /__ctl/ping, and the ones the
// whole-app integration test uses: POST /__ctl/clock {at: ISO|null} (moves the Worker's clock: Date.now() and new Date() in this process),
// /__ctl/advance {ms}, /__ctl/seed-wo (invented work orders through the real upload route, sealed to the store keys),
// /__ctl/seed-alerts (a row of every kind of alert condition, then the real alerts tick), /__ctl/resume (store 326 reports again, tick), /__ctl/tick.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setup, C, APP_KEY, OWNER, hex } from '../../tracker-worker/test/mobile-helpers.mjs';
import worker from '../../tracker-worker/src/index.js';
import { scrub, plainPart, cardOf, scanRow } from '../../tracker-worker/src/shape.js';
import { alertsTick } from '../../tracker-worker/src/mobile-alerts.js';

// A movable clock for the Worker code that runs in this process (the local D1 itself does not read the clock).
let clockOffset = 0;
{
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + clockOffset); }
    static now() { return RealDate.now() + clockOffset; }
  };
  globalThis.__setClock = (atMs) => { clockOffset = atMs == null ? 0 : atMs - RealDate.now(); };
}

const [mode = 'serve', arg] = process.argv.slice(2);
const T = await setup('.wrangler-linkpearl-local');

// Invented numbers for the last week at store 914, relative to the Worker's real clock, so Home answers carry values.
{
  const day = (back) => new Date(Date.now() - back * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const at = (back, h) => new Date(Date.now() - back * 86400000 - h * 3600000).toISOString();
  const rows = [];
  for (let back = 0; back < 7; back++) {
    rows.push(T.env.TR.prepare("INSERT INTO sales (store, sale_id, wo, sale_day, sale_at, type, total, card, completed_by, source) VALUES (914, ?, NULL, ?, ?, 'Sale', ?, 'v1.ZZSEALEDSALE', 'Test Person', 'portal')").bind('s' + back, day(back), at(back, 5), 1800 + back * 110));
    rows.push(T.env.TR.prepare("INSERT INTO sales_days (store, day, source, synced_at) VALUES (914, ?, 'portal', ?)").bind(day(back), at(back, 4)));
    rows.push(T.env.TR.prepare("INSERT INTO daily_metrics (store, day, metric, value, source, updated_at) VALUES (914, ?, 'labor_hours', ?, 't', 'x')").bind(day(back), 12 + back % 3));
  }
  rows.push(T.env.TR.prepare("INSERT INTO daily_metrics (store, day, metric, value, source, updated_at) VALUES (914, ?, 'am_orders', 18, 't', 'x'), (914, ?, 'cleanings_linked', 14, 't', 'x')").bind(day(0), day(0)));
  rows.push(T.env.TR.prepare('INSERT INTO scans (store, at, by_name) VALUES (914, ?, ?), (326, ?, ?)').bind(at(0, 0.05), 'x', at(0, 2.5), 'x'));
  rows.push(T.env.TR.prepare('INSERT INTO rfp_periods (store, wo, start_at, end_at, value) VALUES (914, 100, ?, NULL, 400), (914, 101, ?, NULL, 85)').bind(at(12, 0), at(2, 0)));
  await T.env.TR.batch(rows);
}
const approveById = async (id, stores) => {
  const row = await T.env.TR.prepare('SELECT public_jwk FROM agents WHERE id = ?').bind(id).first();
  if (!row) return { status: 404, j: { error: 'no such phone' } };
  const jwk = JSON.parse(row.public_jwk);
  return T.admin(OWNER, 'POST', `/agents/${id}/approve`, { stores, keys: await Promise.all(stores.map(async (st) => ({ store: st, wrapped: await C.sealBytes(T.storeKeys[st].bytes, jwk, 'agentkey|' + id + '|' + st) }))) });
};
const removeById = (id) => T.admin(OWNER, 'POST', `/agents/${id}/remove`);

// ---- work orders and alert conditions for the integration test (everything invented; the customer is "Jordan Reyes" below)
const ago = (hours) => new Date(Date.now() - hours * 3600000).toISOString();
const cartOf = (v) => ({ cartItems: [{ name: 'Screen', sku: '1001', price: v, quantity: 1, totalPrice: v, partStatus: 'Reserved' }], payment: { total: v, amountPaid: 0, amountDue: v } });
const WOS = [ // store, wo, status id, status name, [[status, hours ago it began]], extras
  [914, 7000001, 2, 'Need to order', [[2, 24]], { cart: cartOf(199), notes: 2, bin: 'B-12' }],
  [914, 7000002, 9, 'Diagnostics', [[2, 100], [9, 72.17]], { cart: cartOf(89) }],      // crossed 3 days in Diagnostics 10 minutes ago: a stuck alert that notifies
  [914, 7000003, 13, 'Ready for pickup', [[9, 300], [13, 216]], { cart: cartOf(149), notes: 1 }],
];
const detailOf = (store, [, wo, status, name, trail0, s]) => {
  const trail = trail0.map(([st, h]) => ({ workorderStatusId: st, createdAt: ago(h), createdBy: 'Tech Person', completed: false }));
  return {
    workorder: { workorder: { workorderId: wo, storeId: store, workorderStatusId: status, WorkorderStatus: { name }, programId: 1, Program: { name: 'Retail' },
      CustomerDevice: { DeviceCatalog: { name: 'Galaxy S23 Ultra' }, imei: '353000111222333', serial: 'SN-REYES-1' }, claimNumber: 'CLM-' + wo,
      createdAt: ago(300), updatedAt: trail[trail.length - 1].createdAt, createdBy: { givenName: 'Staffy', familyName: 'Tech' }, slaEndTime: ago(-24), nextUpdate: ago(-4),
      WorkorderBinDeviceLocation: s.bin ? { WorkorderBin: { name: s.bin } } : null } },
    audit_trail: trail,
    customer_data: { customerId: 'C' + wo, CustomerDatum: { fullName: 'Jordan Reyes' }, CustomerDataPhones: [{ phone: '757-555-0100' }], CustomerDataEmails: [{ email: 'jordan.reyes@example.com' }] },
    notes: { total: s.notes || 0, latestManualNote: null, notes: Array.from({ length: s.notes || 0 }, (_, i) => ({ noteId: 'n' + i, noteType: 2, noteTag: i ? null : 'initial_checkin', noteText: 'Screen is cracked, Jordan will pick up', createdAt: ago(100 - i), UserDatum: { userId: 5, givenName: 'Alex', familyName: 'Kim' } })) },
    cart: s.cart || null, events: { events: [] },
  };
};
async function seedWo() {
  const rows = WOS.map((w) => ({ workorderId: w[1], workorderStatusId: w[2], workorderStatusName: w[3], programId: 1, programName: 'Retail', deviceCatalog: { name: 'Galaxy S23 Ultra' }, createdAt: ago(300), updatedAt: ago(1) }));
  let r = await T.call('POST', '/v1/914/tracker/scan', { rows: rows.map(scanRow), storeName: 'x', by: 'Tech Person' });
  if (r.status !== 200) return r;
  for (const w of WOS) {
    const d = scrub(detailOf(914, w)), plain = plainPart(d, null), pub = T.storeKeys[914].publicJwk;
    r = await T.call('POST', `/v1/914/tracker/wo/${w[1]}`, { hash: await C.hashJson([plain, d]), trigger: 'new', plain, sealed: await C.sealJson(d, pub, C.aad.snapshot(914, w[1])),
      card: await C.sealJson(cardOf(d, null), pub, C.aad.card(914, w[1])), by: 'Tech Person' });
    if (r.status !== 200) return r;
  }
  return { status: 200, j: { ok: true } };
}
async function seedAlerts() {
  const TR = T.env.TR, AE = T.env.AE, today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  await AE.prepare('CREATE TABLE IF NOT EXISTS auto_marks (store INTEGER NOT NULL, wo INTEGER NOT NULL, due TEXT NOT NULL, created_at TEXT NOT NULL, removed_at TEXT, kind TEXT, PRIMARY KEY (store, wo))').run();
  await AE.prepare('CREATE TABLE IF NOT EXISTS wo_closed (store INTEGER NOT NULL, wo INTEGER NOT NULL, closed_at TEXT NOT NULL, PRIMARY KEY (store, wo))').run();
  await TR.batch([
    // pickup: two devices at Ready for pickup for more than the default 7 days (the upload above already opened one for 9 days)
    TR.prepare('INSERT INTO rfp_periods (store, wo, start_at, value) VALUES (914, 7000090, ?, 100)').bind(ago(24 * 12)),
    // follow-up: today's Auto-Waymark mark on work order 7000003
    // (its table lives in the admin database)
    // quiet: store 326 last reported 4.5 hours ago, in store hours
    TR.prepare("INSERT INTO scans (store, at, by_name, open_count) VALUES (326, ?, 'Tracker', 10)").bind(ago(4.5)),
  ]);
  await AE.prepare('INSERT OR REPLACE INTO auto_marks (store, wo, due, created_at, removed_at, kind) VALUES (914, 7000003, ?, ?, NULL, ?)').bind(today, ago(30), 'rfp').run();
  return { status: 200, j: await alertsTick(T.E, Date.now()) };
}

if (mode === 'fixtures') {
  const out = arg; mkdirSync(out, { recursive: true });
  const save = (name, r) => { if (r.j && r.j.settings) { r.j = { ...r.j }; delete r.j.settings; } write(name, r); }; // /me's audit settings are irrelevant to the phone (and carry the owner's address)
  const write = (name, r) => writeFileSync(`${out}/${name}.json`, JSON.stringify({ status: r.status, body: r.j }, null, 1));
  const p = await T.registerPhone('Pixel Fold'); save('register', p.reg);
  save('me-pending', await T.authed(p, '/v1/agents/me'));
  save('home-not-approved', await T.authed(p, '/v1/agents/m/home?store=all'));
  save('register-bad-kind', await T.call('POST', '/v1/agents/register', { id: hex(16), name: 'x', publicJwk: p.publicJwk, token: hex(32), kind: 'tablet' }));
  save('register-duplicate', await T.call('POST', '/v1/agents/register', { id: p.id, name: 'again', publicJwk: p.publicJwk, token: p.token, kind: 'phone' }));
  save('wrong-app-key', await T.call('GET', '/v1/agents/me', null, { 'x-aethernet-key': 'wrong' }));
  save('wrong-token', await T.authed({ id: p.id, token: hex(32) }, '/v1/agents/me'));
  await T.approve(p, [914, 326]);
  save('me-active', await T.authed(p, '/v1/agents/me'));
  save('home-all', await T.authed(p, '/v1/agents/m/home?store=all'));
  save('home-one', await T.authed(p, '/v1/agents/m/home?store=914&fresh=1'));
  save('home-not-your-store', await T.authed(p, '/v1/agents/m/home?store=536'));
  save('home-bad-store', await T.authed(p, '/v1/agents/m/home?store=abc'));
  save('not-built', await T.authed(p, '/v1/agents/m/prefs'));
  await T.approve(p, []);
  save('me-active-no-stores', await T.authed(p, '/v1/agents/me'));
  save('home-empty', await T.authed(p, '/v1/agents/m/home?store=all'));
  const q = await T.registerPhone('Second'), r3 = await T.registerPhone('Third'), r4 = await T.registerPhone('Fourth');
  save('register-too-many-waiting', (await T.registerPhone('Fifth')).reg);
  await T.admin(OWNER, 'POST', `/agents/${p.id}/remove`);
  save('me-revoked', await T.authed(p, '/v1/agents/me'));
  await T.dispose(); process.exit(0);
}

const server = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString();
  const url = new URL(req.url, 'http://x');
  const send = (status, j) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
  if (url.pathname === '/__ctl/ping') return send(200, { ok: true });
  if (url.pathname === '/__ctl/approve') { const b = JSON.parse(body); const r = await approveById(b.id, b.stores); return send(r.status, r.j); }
  if (url.pathname === '/__ctl/remove') { const b = JSON.parse(body); const r = await removeById(b.id); return send(r.status, r.j); }
  if (url.pathname === '/__ctl/clock') { const b = JSON.parse(body); globalThis.__setClock(b.at ? Date.parse(b.at) : null); return send(200, { now: new Date().toISOString() }); }
  if (url.pathname === '/__ctl/advance') { const b = JSON.parse(body); globalThis.__setClock(Date.now() + b.ms); return send(200, { now: new Date().toISOString() }); }
  if (url.pathname === '/__ctl/seed-wo') { const r = await seedWo(); return send(r.status, r.j); }
  if (url.pathname === '/__ctl/seed-alerts') { const r = await seedAlerts(); return send(r.status, r.j); }
  if (url.pathname === '/__ctl/resume') { await T.env.TR.prepare("INSERT INTO scans (store, at, by_name, open_count) VALUES (326, ?, 'Tracker', 10)").bind(new Date().toISOString()).run(); return send(200, await alertsTick(T.E, Date.now())); }
  if (url.pathname === '/__ctl/tick') return send(200, await alertsTick(T.E, Date.now()));
  const headers = {}; for (const [k, v] of Object.entries(req.headers)) if (k !== 'host' && k !== 'connection' && k !== 'content-length') headers[k] = v;
  const r = await worker.fetch(new Request('https://t.test' + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), T.E, {});
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
const port = Number(arg) || 8799;
server.listen(port, '127.0.0.1', () => console.log('listening ' + port));
process.on('SIGTERM', async () => { server.close(); await T.dispose(); process.exit(0); });
