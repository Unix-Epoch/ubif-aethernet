// Runs the REAL tracker Worker code (tracker-worker/src) over HTTP on localhost with a seeded local D1, for Linkpearl's integration test
// and to capture real answers as test fixtures. Nothing remote is touched (getPlatformProxy local persistence in a throwaway directory).
//
//   cd tracker-worker && node ../android/tools/local-server.mjs serve [port]       app key "k"; control routes below
//   cd tracker-worker && node ../android/tools/local-server.mjs fixtures <outDir>  writes real JSON answers, then exits
//
// Control routes (only here, not in the Worker): POST /__ctl/approve {id, stores}, POST /__ctl/remove {id}, GET /__ctl/ping.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setup, C, APP_KEY, OWNER, hex } from '../../tracker-worker/test/mobile-helpers.mjs';
import worker from '../../tracker-worker/src/index.js';

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
  const headers = {}; for (const [k, v] of Object.entries(req.headers)) if (k !== 'host' && k !== 'connection' && k !== 'content-length') headers[k] = v;
  const r = await worker.fetch(new Request('https://t.test' + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), T.E, {});
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
const port = Number(arg) || 8799;
server.listen(port, '127.0.0.1', () => console.log('listening ' + port));
process.on('SIGTERM', async () => { server.close(); await T.dispose(); process.exit(0); });
