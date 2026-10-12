/*
  One-time import of the Mac work order tracker's history (~/Scripts/ubif-workorders/workorders.db)
  into the tracker database, shaped and sealed exactly like Aethernet's own uploads
  (src/shape.js, src/crypto.js): passcodes removed, customer data sealed with the store's public
  key, field changes recomputed from the plain parts.

  It writes a SQL file; nothing is sent anywhere. Load it with
    npx wrangler d1 execute aethernet-tracker --remote --file <out.sql>
  Re-running is safe: the file first deletes earlier imported snapshots (trigger "mac:…") and
  their changes. Work order rows that already exist (Aethernet got there first) are kept.

  node import/mac-history.mjs --db ~/Scripts/ubif-workorders/workorders.db --store 914 \
       --store-name "Newport News" --worker https://aethernet-tracker.<account>.workers.dev \
       --app-key ae_… --out mac-import.sql
  (--key-file store-key.json instead of --worker: a public JWK, for local tests.)
  Gets the store's public key from the Worker, and creates it (as Aethernet would, with the master
  public key) if the store has none yet.
*/
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import * as C from '../src/crypto.js';
import { scrub, plainPart, cardOf } from '../src/shape.js';
import { diff } from '../src/index.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const DB = arg('db'), STORE = Number(arg('store')), STORE_NAME = arg('store-name', null), OUT = arg('out', 'mac-import.sql');
if (!DB || !STORE) { console.error('usage: --db <workorders.db> --store <n> [--store-name ..] (--worker URL --app-key K | --key-file F) [--out F]'); process.exit(2); }

async function storeKey() {
  if (arg('key-file')) return JSON.parse(readFileSync(arg('key-file'), 'utf8'));
  const W = arg('worker'), K = arg('app-key');
  const call = async (method, path, body) => {
    const r = await fetch(W + path, { method, headers: { 'x-aethernet-key': K, 'content-type': 'application/json', 'user-agent': 'aethernet-import' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(path + ': ' + (j.error || r.status)), { status: r.status });
    return j;
  };
  try { return (await call('GET', '/v1/' + STORE + '/tracker/key')).publicJwk; }
  catch (e) {
    if (e.status !== 404) throw e;
    const master = (await call('GET', '/v1/tracker/master')).publicJwk;
    return (await call('POST', '/v1/' + STORE + '/tracker/key', await C.newStoreKey(STORE, master))).publicJwk;
  }
}

const iso = (t) => (t ? new Date(t).toISOString() : null);
const q = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'");
const CLOSED_IDS = new Set([14, 15, 25]);

const key = await storeKey();
const db = new DatabaseSync(DB, { readOnly: true });
const wos = db.prepare('SELECT * FROM workorders ORDER BY workorder_id').all();
const snapStmt = db.prepare('SELECT id, fetched_at, trigger, raw_json FROM workorder_snapshots WHERE workorder_id = ? ORDER BY id');

const sql = [
  '-- Mac tracker history import for store ' + STORE + ', made ' + new Date().toISOString(),
  "DELETE FROM changes WHERE snapshot_id IN (SELECT id FROM snapshots WHERE store = " + STORE + " AND trigger LIKE 'mac:%');",
  "DELETE FROM snapshots WHERE store = " + STORE + " AND trigger LIKE 'mac:%';",
];
let nSnap = 0, nChg = 0, nWo = 0, biggest = 0, passcodes = 0;
for (const w of wos) {
  const wo = Number(w.workorder_id);
  const listRow = w.last_list_raw_json ? scrub(JSON.parse(w.last_list_raw_json)) : null;
  const snaps = snapStmt.all(w.workorder_id);
  let prev = null, last = null;
  for (let i = 0; i < snaps.length; i++) {
    const s = snaps[i];
    const raw = JSON.parse(s.raw_json);
    if (/"passcode":\s*"[^"]+"/.test(s.raw_json)) passcodes++;
    const d = scrub(raw);
    const isLast = i === snaps.length - 1;
    if (isLast && listRow) d.list_row = listRow;
    const plain = plainPart(d, isLast ? listRow : null);
    const sealed = await C.sealJson(d, key, C.aad.snapshot(STORE, wo));
    const hash = await C.hashJson([plain, d]), at = iso(s.fetched_at);
    const stmt = 'INSERT INTO snapshots (store, wo, fetched_at, trigger, by_name, hash, plain, sealed) VALUES ('
      + [STORE, wo, q(at), q('mac:' + (s.trigger || '')), q('Mac tracker'), q(hash), q(JSON.stringify(plain)), q(sealed)].join(', ') + ');';
    biggest = Math.max(biggest, stmt.length);
    sql.push(stmt); nSnap++;
    if (prev) for (const [field, o, n] of diff(prev, plain).slice(0, 1000)) {
      sql.push('INSERT INTO changes (store, wo, changed_at, field, old, new, snapshot_id) VALUES (' + [STORE, wo, q(at), q(field.slice(0, 300)), q(o == null ? null : String(o).slice(0, 4000)), q(n == null ? null : String(n).slice(0, 4000)), '(SELECT MAX(id) FROM snapshots WHERE store = ' + STORE + ' AND wo = ' + wo + ')'].join(', ') + ');'); // the snapshot just inserted
      nChg++;
    }
    prev = plain; last = { d, plain, hash, at };
  }
  if (!last) continue;
  const p = last.plain.workorder, pay = (last.plain.cart && last.plain.cart.payment) || {};
  const card = await C.sealJson(cardOf(last.d, listRow), key, C.aad.card(STORE, wo));
  const open = w.is_open ? 1 : 0;
  sql.push('INSERT INTO workorders (store, wo, store_name, status_id, status_name, program_id, program_name, device, created_at, api_updated_at, is_open, first_seen_at, last_list_seen_at, '
    + 'last_detail_at, last_hash, closed_at, closed_reason, cart_total, cart_paid, cart_due, plain, card) VALUES ('
    + [STORE, wo, q(STORE_NAME), q(p.statusId ?? w.status_id), q(p.status || w.status_name), q(p.programId ?? w.program_id), q(p.program || w.program_name), q(p.device), q(iso(p.createdAt)),
      q(iso(w.api_updated_at)), open, q(iso(w.first_seen_at)), q(iso(w.last_list_seen_at)), q(last.at), q(last.hash),
      q(open ? null : iso(w.closed_at) || last.at), q(open ? null : (w.closed_reason || (CLOSED_IDS.has(p.statusId) ? p.status : 'closed'))),
      q(pay.total ?? null), q(pay.amountPaid ?? null), q(pay.amountDue ?? null), q(JSON.stringify(last.plain)), q(card)].join(', ')
    + ') ON CONFLICT (store, wo) DO NOTHING;');
  nWo++;
}
writeFileSync(OUT, sql.join('\n') + '\n');
console.log(`wrote ${OUT}: ${nWo} work orders, ${nSnap} snapshots, ${nChg} changes; largest statement ${(biggest / 1024).toFixed(1)} KB; passcodes removed from ${passcodes} snapshots`);
