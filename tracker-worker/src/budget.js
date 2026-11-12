/*
  Per-store write budgets (Nov 11, 2026). Every store-side route is gated only by the app key that ships in every install and a store
  number in the URL, so a store's writes are capped here: a store's real use stays far under every number below (derived from the
  client, src/27-tracker.js and src/28-retrace-collect.js), a script hammering one store's URL stops at the cap.

  Counters live in write_budget (store, kind, bucket): an hour bucket ("2026-11-11T21") and/or a day bucket ("2026-11-11"), UTC,
  with n (operations / rows) and bytes. Checked before anything is stored (over budget → 429, nothing written), charged right after.
  Cheap on purpose: one read of two rows and one upsert per bucket that has a limit. A counter problem (table not migrated yet,
  D1 hiccup) never blocks a request: it is logged and the request goes through.

  Client numbers behind the limits: the tracker scans every 10 minutes per browser and asks for at most NEED_MAX = 25 work orders per
  scan (the Worker hands out each for 5 minutes, so two browsers don't repeat one); a snapshot is only stored when its hash is new.
  Retrace's collector runs a pass every 10 minutes per browser: at most NEED = 60 label histories, a handful of sweep parts and the
  watcher's flushes per pass.
*/
export const BUDGET = {
  // snapshots: rows, and bytes (plain + sealed + card). 600/hour is 4 browsers each uploading a full 25 every scan, all of them new.
  snap: { hour: 600, day: 5000, hourBytes: 150e6, dayBytes: 600e6 },
  // change rows written with those snapshots (up to 1000 each; real ones are a few dozen).
  chg: { hour: 40000, day: 150000 },
  // scans (one row each): 6 an hour per browser.
  scan: { hour: 300 },
  // work orders a scan lists that the store has never listed. A first scan of a big store lists ~1500; after that a few dozen a day.
  fresh: { hour: 2500, day: 4000 },
  // POST /sales: today every 30 minutes and the six days before it once a day, per browser.
  sales: { hour: 120 },
  // Retrace, per store, requests an hour (a browser's pass: ≤ 60 history reads, ≤ ~30 sweep parts, a few watch flushes, every 10 minutes).
  rt_history: { hour: 4000 },
  rt_sweep: { hour: 1500 },
  rt_watch: { hour: 2000 },
};
export const PER_WO_HOUR = 30; // snapshots of one work order in an hour: a scan every 10 minutes per browser, claims keep two browsers off the same one

const hourOf = (t) => new Date(t).toISOString().slice(0, 13);
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const NAMES = { snap: 'work order uploads', chg: 'recorded changes', scan: 'scans', fresh: 'new work orders', sales: 'sales uploads', rt_history: 'Retrace history uploads', rt_sweep: 'Retrace sweep uploads', rt_watch: 'Retrace watch uploads' };

// Each item is [kind, n, bytes]. Returns null when all fit, else a plain message (the caller answers 429). Nothing is charged.
export async function over(T, store, items, t = Date.now()) {
  try {
    const hb = hourOf(t), db = dayOf(t);
    for (const [kind, n, bytes = 0] of items) {
      const L = BUDGET[kind];
      if (!L || !(n > 0 || bytes > 0)) continue;
      const rows = (await T.prepare('SELECT bucket, n, bytes FROM write_budget WHERE store = ? AND kind = ? AND bucket IN (?, ?)').bind(store, kind, hb, db).all()).results;
      const at = (b) => rows.find((r) => r.bucket === b) || { n: 0, bytes: 0 };
      const h = at(hb), d = at(db);
      if (L.hour != null && h.n + n > L.hour) return 'too many ' + NAMES[kind] + ' from store ' + store + ' this hour (limit ' + L.hour + '); try again later';
      if (L.day != null && d.n + n > L.day) return 'too many ' + NAMES[kind] + ' from store ' + store + ' today (limit ' + L.day + '); try again tomorrow';
      if (L.hourBytes != null && h.bytes + bytes > L.hourBytes) return 'too much data from store ' + store + ' this hour; try again later';
      if (L.dayBytes != null && d.bytes + bytes > L.dayBytes) return 'too much data from store ' + store + ' today; try again tomorrow';
    }
  } catch (e) { console.error('write budget check failed (allowing): ' + ((e && e.message) || e)); }
  return null;
}

export async function charge(T, store, items, t = Date.now()) {
  try {
    const hb = hourOf(t), db = dayOf(t), stmts = [];
    for (const [kind, n, bytes = 0] of items) {
      const L = BUDGET[kind];
      if (!L || !(n > 0 || bytes > 0)) continue;
      const buckets = [];
      if (L.hour != null || L.hourBytes != null) buckets.push(hb);
      if (L.day != null || L.dayBytes != null) buckets.push(db);
      for (const b of buckets) stmts.push(T.prepare('INSERT INTO write_budget (store, kind, bucket, n, bytes) VALUES (?, ?, ?, ?, ?) ON CONFLICT (store, kind, bucket) DO UPDATE SET n = n + excluded.n, bytes = bytes + excluded.bytes').bind(store, kind, b, n, bytes));
    }
    if (stmts.length) await T.batch(stmts);
  } catch (e) { console.error('write budget charge failed (ignored): ' + ((e && e.message) || e)); }
}

// Check, then charge. null = go ahead.
export async function spend(T, store, items) {
  const m = await over(T, store, items);
  if (m) return m;
  await charge(T, store, items);
  return null;
}

// Counters older than three days are of no use (housekeeping, daily cron).
export const pruneBudget = (T, t = Date.now()) => T.prepare('DELETE FROM write_budget WHERE bucket < ?').bind(dayOf(t - 3 * 86400000)).run();
