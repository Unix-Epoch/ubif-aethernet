/*
  One-time import of the Mac sales database (~/Scripts/ubif-sales-db/sales.db: Portal's sales history,
  enriched with each WO's items) into the tracker's sales tables, as source "mac". Customer id + name are
  sealed with the store's public key (bound to the sale). Portal's own list wins: rows or days already
  sent by Aethernet (source "portal") are left alone. Writes a SQL file; nothing is sent anywhere.

  node import/mac-sales.mjs --db ~/Scripts/ubif-sales-db/sales.db --store 914 \
       --worker https://aethernet-tracker.<account>.workers.dev --app-key ae_… --out mac-sales.sql
  (--key-file store-key.json instead of --worker: a public JWK, for local tests.)
*/
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync } from 'node:fs';
import * as C from '../src/crypto.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const DB = arg('db'), STORE = Number(arg('store')), OUT = arg('out', 'mac-sales.sql');
if (!DB || !STORE) { console.error('usage: --db <sales.db> --store <n> (--worker URL --app-key K | --key-file F) [--out F]'); process.exit(2); }
async function storeKey() {
  if (arg('key-file')) return JSON.parse(readFileSync(arg('key-file'), 'utf8'));
  const r = await fetch(arg('worker') + '/v1/' + STORE + '/tracker/key', { headers: { 'x-aethernet-key': arg('app-key'), 'user-agent': 'aethernet-import' } });
  if (!r.ok) throw new Error('store key: HTTP ' + r.status);
  return (await r.json()).publicJwk;
}
const q = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'");
const key = await storeKey();
const db = new DatabaseSync(DB, { readOnly: true });
const items = new Map();
for (const i of db.prepare('SELECT sale_id, line_number, sku, item_name, price, net_price, quantity, reason_code FROM sale_items ORDER BY sale_id, line_number').all()) {
  (items.get(i.sale_id) || items.set(i.sale_id, []).get(i.sale_id)).push({ lineNumber: i.line_number, sku: i.sku, name: i.item_name, price: i.price, netPrice: i.net_price, quantity: i.quantity, reasonCode: i.reason_code || undefined });
}
const sql = ['-- Mac sales history import for store ' + STORE + ', made ' + new Date().toISOString()];
const days = new Map();
let n = 0;
for (const s of db.prepare('SELECT * FROM sales ORDER BY sale_date, sale_datetime').all()) {
  const card = (s.customer_id || s.customer_name) ? await C.sealJson({ customerId: s.customer_id || null, customerName: s.customer_name || null }, key, C.aad.sale(STORE, s.sale_id)) : null;
  const it = items.get(s.sale_id);
  sql.push('INSERT INTO sales (store, sale_id, wo, sale_day, sale_at, type, total, partner_credits, paid, completed_by, program, device, items, card, source, seen_at) VALUES ('
    + [STORE, q(s.sale_id), s.workorder_id ? Number(s.workorder_id) : 'NULL', q(s.sale_date), q(s.sale_datetime || null), q(s.transaction_type), q(s.total), q(s.partner_credits), q(s.payments),
      q(s.completed_by), q(s.program_name), q([s.device_brand, s.device_model].filter(Boolean).join(' ') || null), q(it && it.length ? JSON.stringify(it) : null), q(card), "'mac'", q(s.ingested_at)].join(', ')
    + ') ON CONFLICT (store, sale_id) DO NOTHING;');
  const d = days.get(s.sale_date) || days.set(s.sale_date, { count: 0, total: 0 }).get(s.sale_date);
  d.count++; d.total += s.total || 0; n++;
}
for (const [day, d] of days) sql.push(`INSERT INTO sales_days (store, day, source, synced_at, count, total) VALUES (${STORE}, ${q(day)}, 'mac', ${q(new Date().toISOString())}, ${d.count}, ${Math.round(d.total * 100) / 100}) ON CONFLICT (store, day) DO NOTHING;`);
writeFileSync(OUT, sql.join('\n') + '\n');
console.log(`wrote ${OUT}: ${n} sales over ${days.size} days, ${[...items.values()].reduce((a, b) => a + b.length, 0)} items`);
