// Fake data for the Metrics page: stores 914, 326, 536, 1276 over `days` days ending now. Everything is
// invented (no real customers, staff or work orders). Used by local dev (`node test/metrics-seed.mjs <persist dir>`,
// for `wrangler dev --local --persist-to <dir>` in admin-worker/) and available to tests.
import { localToUtc, local, addDays } from '../src/metrics.js';

const TZ = 'America/New_York';
export const STORES = [{ id: 914, name: 'Newport News', k: 1.3, rate: .63 }, { id: 326, name: 'Lynnhaven', k: 1.0, rate: .49 }, { id: 536, name: 'Lexington', k: .82, rate: .72 }, { id: 1276, name: 'Erie PA', k: .7, rate: .41 }];
const PROGRAMS = [['Retail', 1, .34], ['Asurion Mobility', 5062, .27], ['Samsung Care+', 7001, .11], ['Asurion Home+', 7002, .08], ['Google', 7003, .06], ['Verizon', 7004, .07], ['Out of warranty', 7005, .07]];
const DEVICES = [['iPhone 15 Pro', .2], ['iPhone 13', .21], ['Galaxy S23', .12], ['Galaxy A54', .1], ['iPad (9th generation)', .07], ['Galaxy Tab A8', .03], ['MacBook Air M1', .05], ['Dell Inspiron 15', .03], ['Pixel 7', .07], ['Nintendo Switch', .04], ['PlayStation 5', .02], ['Moto G Stylus', .06]];
const STAFF = ['A. Rivera', 'B. Chen', 'C. Okafor', 'D. Patel', 'E. Novak'];
const CRYSTALS = [['waymark', .22], ['cleaningRate', .17], ['textNotes', .12], ['autoClose', .1], ['woCleanings', .09], ['assize', .08], ['printLabels', .07], ['timeSheet', .05], ['fixes', .06], ['decipher', .04]];
const NAMES = { 1: 'Initial check-in', 2: 'Need to order', 3: 'Awaiting item', 7: 'Awaiting callback', 10: 'Work in progress', 13: 'Ready for pickup', 14: 'Sale complete', 23: 'Transferred to depot', 25: 'Cancelled' };
const DOW = [.55, .9, .95, 1, 1, 1.15, 1.2];

function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const pick = (r, list) => { let x = r() * list.reduce((s, l) => s + l[l.length - 1], 0); for (const l of list) { x -= l[l.length - 1]; if (x <= 0) return l; } return list[0]; };
const iso = (ms) => new Date(ms).toISOString();
// Push a time into store hours (10:00–19:00 local); outside → next morning.
function biz(ms, r) {
  const l = local(ms, TZ);
  if (l.hour >= 10 && l.hour < 19) return ms;
  const day = l.hour < 10 ? l.day : addDays(l.day, 1);
  return localToUtc(day, 10, TZ) + Math.floor(r() * 150) * 60000;
}

export function generate({ now = Date.now(), days = 190 } = {}) {
  const today = local(now, TZ).day, out = { workorders: [], rfp: [], sales: [], salesDays: [], scans: [], daily: [], usage: [], marks: [] };
  for (const s of STORES) {
    const r = rng(s.id * 7919);
    let woN = 40000 + s.id * 10;
    const daySales = new Map();
    for (let i = days - 1; i >= 0; i--) {
      const day = addDays(today, -i), dow = new Date(day + 'T12:00:00Z').getUTCDay(), noise = () => 0.8 + r() * 0.4;
      const nWo = Math.max(2, Math.round(15 * s.k * DOW[dow] * noise()));
      for (let j = 0; j < nWo; j++) {
        const created = localToUtc(day, 10, TZ) + Math.floor(r() * 540) * 60000;
        if (created > now) continue;
        const wo = woN++, [prog, progId] = pick(r, PROGRAMS), [device] = pick(r, DEVICES);
        const value = Math.round((79 + r() * 270) * 100) / 100;
        // lifecycle
        const steps = [[1, created]];
        let t = created + (10 + r() * 50) * 60000;
        if (r() < .3) { steps.push([2, t]); t = biz(t + (16 + r() * 50) * 3600000, r); steps.push([3, t]); t = biz(t + (10 + r() * 30) * 3600000, r); }
        if (r() < .14) { steps.push([7, t]); t = biz(t + (8 + r() * 60) * 3600000, r); }
        const end = r();
        if (end < .03) { steps.push([25, t]); }
        else if (end < .06) { steps.push([23, t]); t = biz(t + (5 + r() * 6) * 86400000, r); steps.push([13, t]); t = biz(t + (1 + r() * 3) * 86400000, r); steps.push([14, t]); }
        else {
          steps.push([10, t]); t = biz(t + (0.5 + r() * 6) * 3600000, r); steps.push([13, t]);
          const wait = (r() < .04 ? 7 + r() * 30 : -Math.log(1 - r() * .995) * 1.4 + 0.1) * 86400000; // mostly days, some weeks
          t = biz(t + wait, r); steps.push([14, t]);
        }
        const past = steps.filter((x) => x[1] <= now), cur = past[past.length - 1];
        const status = cur[0], closed = [14, 25].includes(status), soldAt = status === 14 ? iso(cur[1]) : null;
        const trail = past.filter((x) => x[0] !== 14).map(([sid, at]) => ({ statusId: sid, createdAt: iso(at), createdBy: 1 }));
        const outcome = past.some((x) => x[0] === 13) ? (r() < .9 ? 'Completed' : 'Incomplete') : null;
        const plain = { workorder: { workorderId: wo, storeId: s.id, statusId: status, status: NAMES[status], programId: progId, program: prog, device, createdAt: iso(created), updatedAt: iso(cur[1]), outcome },
          auditTrail: trail, cart: { items: status === 14 ? [] : [{ name: 'Repair', sku: 'R1', netPrice: value, quantity: 1 }], payment: { total: value * 1.06, amountPaid: 0, amountDue: value * 1.06 } } };
        out.workorders.push({ store: s.id, wo, store_name: s.name, status_id: status, status_name: NAMES[status], program_id: progId, program_name: prog, device, created_at: iso(created), api_updated_at: iso(cur[1]),
          is_open: closed ? 0 : 1, first_seen_at: iso(created), last_detail_at: iso(Math.min(now, cur[1] + 600000)), closed_at: closed ? iso(cur[1]) : null, closed_reason: closed ? NAMES[status] : null,
          cart_value: status === 14 ? 0 : value, service_outcome: outcome, last_cart_value: value, last_cart_tax: Math.round(value * 6) / 100, sold_at: soldAt, plain: JSON.stringify(plain) });
        // rfp period
        const ri = steps.findIndex((x) => x[0] === 13);
        if (ri >= 0 && steps[ri][1] <= now) out.rfp.push({ store: s.id, wo, start_at: iso(steps[ri][1]), end_at: steps[ri + 1] && steps[ri + 1][1] <= now ? iso(steps[ri + 1][1]) : null, value });
        if (status === 13 && r() < .8) { const due = addDays(local(steps[ri][1], TZ).day, 3); out.marks.push({ store: s.id, wo, due, kind: 'rfp' }); }
        if (status === 7) out.marks.push({ store: s.id, wo, due: addDays(local(cur[1], TZ).day, 1), kind: 'callback' });
        if (soldAt) { const d = local(cur[1], TZ).day; (daySales.get(d) || daySales.set(d, []).get(d)).push({ sale_id: 'S' + s.id + '-' + wo, wo, sale_at: soldAt, type: 'Sale', total: Math.round(value * (prog === 'Retail' || prog === 'Out of warranty' ? 1.06 : .35) * 100) / 100, program: prog, device }); }
      }
      // quick sales and the odd return
      for (let q = 0; q < Math.round(3 * s.k * noise()); q++) {
        const at = localToUtc(day, 10, TZ) + Math.floor(r() * 540) * 60000; if (at > now) continue;
        (daySales.get(day) || daySales.set(day, []).get(day)).push({ sale_id: 'Q' + s.id + '-' + day + '-' + q, wo: null, sale_at: iso(at), type: r() < .06 ? 'Return' : 'Sale', total: Math.round((15 + r() * 45) * 100) / 100, program: null, device: null });
      }
      // uploads (daily_metrics): cleanings for every store, labor hours for the last 60 days (not Erie)
      const am = Math.max(0, Math.round(6.5 * s.k * DOW[dow] * noise())), cln = Math.max(0, Math.round(am * Math.min(1.25, Math.max(0, s.rate + (r() - .5) * .45))));
      if (day < today || local(now, TZ).hour >= 12) { out.daily.push([s.id, day, 'am_orders', am], [s.id, day, 'cleanings_linked', cln]); }
      if (i < 60 && s.id !== 1276 && day < today) { const heads = 2 + Math.floor(r() * 3), hrs = Math.round(heads * (7.5 + r() * 2) * 10) / 10; out.daily.push([s.id, day, 'labor_hours', hrs], [s.id, day, 'labor_hours_gm', 8.5], [s.id, day, 'headcount', heads]); }
      // usage
      const users = Math.max(2, Math.round((4 + r() * 3) * s.k));
      for (let u = 0; u < users; u++) {
        if (r() < (dow === 0 ? .5 : .15)) continue;
        const uid = s.id * 100 + u;
        out.usage.push([day, s.id, s.name, uid, 'Tech ' + (u + 1), 'active', 1]);
        for (let c = 0; c < 4; c++) { const [f] = pick(r, CRYSTALS); out.usage.push([day, s.id, s.name, uid, 'Tech ' + (u + 1), f + ':use', Math.round(1 + r() * 9 * s.k)]); }
      }
      // scans: hourly during store hours since the first one (110 days ago); today every 10 minutes
      if (i < 110) for (let h = 10; h < 19; h++) for (let m = 0; m < 60; m += i === 0 ? 10 : 60) { const at = localToUtc(day, h, TZ) + m * 60000; out.scans.push({ store: s.id, at, by: 'Tech 1' }); }
    }
    // sales_days: synced every day, except Lynnhaven's last 3 days (estimated from work orders)
    for (const [d, list] of daySales) {
      if (s.id === 326 && d > addDays(today, -3)) continue;
      for (const x of list) out.sales.push(Object.assign({ store: s.id, sale_day: d, partner_credits: 0, paid: x.total, completed_by: STAFF[Math.floor(r() * STAFF.length)], items: null, source: 'portal' }, x));
      out.salesDays.push({ store: s.id, day: d, source: 'portal', synced_at: iso(Math.min(now - 30 * 60000, localToUtc(addDays(d, 1), 0, TZ))), count: list.length, total: Math.round(list.reduce((n, x) => n + (x.type === 'Return' ? -x.total : x.total), 0) * 100) / 100 });
    }
  }
  // freshness: 914 live (3 min), 326 live (7 min), 536 stale (48 min), 1276 stopped 26 hours ago
  const lastAt = { 914: now - 3 * 60000, 326: now - 7 * 60000, 536: now - 48 * 60000, 1276: now - 26 * 3600000 };
  out.scans = out.scans.filter((x) => x.at <= lastAt[x.store]).map((x) => Object.assign(x, { at: iso(x.at) }));
  for (const st of [914, 326, 536, 1276]) if (!out.scans.some((x) => x.store === st && x.at === iso(lastAt[st]))) out.scans.push({ store: st, at: iso(lastAt[st]), by: 'Tech 1' });
  return out;
}

const DAILY_SQL = 'CREATE TABLE IF NOT EXISTS daily_metrics (store INTEGER NOT NULL, day TEXT NOT NULL, metric TEXT NOT NULL, value REAL NOT NULL, source TEXT, by_name TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (store, day, metric))';
export const WAYMARK_SQL = [
  'CREATE TABLE IF NOT EXISTS usage (day TEXT NOT NULL, store INTEGER NOT NULL, store_name TEXT, user_id INTEGER NOT NULL, user_name TEXT, feature TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (day, store, user_id, feature))',
  'CREATE TABLE IF NOT EXISTS store_access (store INTEGER PRIMARY KEY, name TEXT, added_by TEXT, added_at TEXT)',
  'CREATE TABLE IF NOT EXISTS auto_marks (store INTEGER NOT NULL, wo INTEGER NOT NULL, due TEXT NOT NULL, created_at TEXT NOT NULL, removed_at TEXT, kind TEXT, PRIMARY KEY (store, wo))',
  'CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL)',
];

// Writes generate()'s rows. TR = tracker D1, AE = Waymark D1 (both local).
export async function load(TR, AE, data, { dailyMetrics = true } = {}) {
  // Statements are prepared per chunk (thousands of prepared statements at once crash the local proxy).
  const run = async (db, rows, fn) => { for (let i = 0; i < rows.length; i += 50) await db.batch(rows.slice(i, i + 50).map(fn)); };
  const now = new Date().toISOString();
  await run(TR, data.workorders, (w) => TR.prepare(`INSERT OR REPLACE INTO workorders (store, wo, store_name, status_id, status_name, program_id, program_name, device, created_at, api_updated_at, is_open, first_seen_at, last_detail_at,
      closed_at, closed_reason, cart_value, service_outcome, last_cart_value, last_cart_tax, sold_at, plain) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(w.store, w.wo, w.store_name, w.status_id, w.status_name, w.program_id, w.program_name, w.device, w.created_at, w.api_updated_at, w.is_open, w.first_seen_at, w.last_detail_at, w.closed_at, w.closed_reason, w.cart_value, w.service_outcome, w.last_cart_value, w.last_cart_tax, w.sold_at, w.plain));
  await run(TR, data.rfp, (p) => TR.prepare('INSERT OR REPLACE INTO rfp_periods (store, wo, start_at, end_at, value) VALUES (?, ?, ?, ?, ?)').bind(p.store, p.wo, p.start_at, p.end_at, p.value));
  await run(TR, data.sales, (x) => TR.prepare(`INSERT OR REPLACE INTO sales (store, sale_id, wo, sale_day, sale_at, type, total, partner_credits, paid, completed_by, program, device, items, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(x.store, x.sale_id, x.wo, x.sale_day, x.sale_at, x.type, x.total, x.partner_credits, x.paid, x.completed_by, x.program, x.device, x.items, x.source));
  await run(TR, data.salesDays, (d) => TR.prepare('INSERT OR REPLACE INTO sales_days (store, day, source, synced_at, count, total) VALUES (?, ?, ?, ?, ?, ?)').bind(d.store, d.day, d.source, d.synced_at, d.count, d.total));
  await run(TR, data.scans, (x) => TR.prepare('INSERT INTO scans (store, at, by_name, open_count) VALUES (?, ?, ?, 0)').bind(x.store, x.at, x.by));
  if (dailyMetrics) {
    await TR.prepare(DAILY_SQL).run();
    await run(TR, data.daily, ([st, day, m, v]) => TR.prepare("INSERT OR REPLACE INTO daily_metrics (store, day, metric, value, source, updated_at) VALUES (?, ?, ?, ?, 'seed', ?)").bind(st, day, m, v, now));
  }
  for (const q of WAYMARK_SQL) await AE.prepare(q).run();
  await run(AE, STORES, (s) => AE.prepare('INSERT OR REPLACE INTO store_access (store, name, added_at) VALUES (?, ?, ?)').bind(s.id, s.name, now));
  await AE.prepare("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('cleaningTarget', '60', ?)").bind(now).run();
  await run(AE, data.usage, (u) => AE.prepare('INSERT OR REPLACE INTO usage (day, store, store_name, user_id, user_name, feature, count) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(...u));
  await run(AE, data.marks, (m) => AE.prepare('INSERT OR REPLACE INTO auto_marks (store, wo, due, kind, created_at) VALUES (?, ?, ?, ?, ?)').bind(m.store, m.wo, m.due, m.kind, now));
}

// CLI: node test/metrics-seed.mjs <persist dir>   (local D1 of admin-worker/wrangler.toml, never remote)
if (import.meta.url === 'file://' + process.argv[1]) {
  const { getPlatformProxy } = await import('wrangler');
  const { readFileSync } = await import('node:fs');
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node test/metrics-seed.mjs <persist dir>'); process.exit(1); }
  const { env, dispose } = await getPlatformProxy({ configPath: new URL('../../admin-worker/wrangler.toml', import.meta.url).pathname, persist: { path: dir + '/v3' }, remoteBindings: false });
  for (const stmt of readFileSync(new URL('../schema.sql', import.meta.url), 'utf8').replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean)) await env.TR.prepare(stmt).run();
  await env.TR.prepare("INSERT OR REPLACE INTO people (email, name, scope, stores, added_at) VALUES ('owner@local', 'Owner', 'all', '[]', ?), ('mgr326@local', 'Lynnhaven manager', 'stores', '[326]', ?)").bind(new Date().toISOString(), new Date().toISOString()).run();
  const data = generate();
  await load(env.TR, env.DB, data);
  const { metricsApi } = await import('../src/metrics.js');
  let after = 0, total = 0;
  for (;;) { const r = await (await metricsApi(new Request('https://x/metrics/backfill?after=' + after, { method: 'POST' }), env, new URL('https://x/metrics/backfill?after=' + after), '/metrics/backfill', { scope: 'all', stores: [] })).json(); total += r.written; after = r.next; if (r.done) break; }
  console.log('seeded', Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])), 'status period writes', total);
  await dispose();
}
