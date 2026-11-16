/*
  Linkpearl: the store's Price sheet, under /v1/agents/m/prices (phone API; dispatch in mobile-agent.js, reference in MOBILE-API-prices.md).

    GET /v1/agents/m/prices?store=<id>             → { store, syncedAt, devices: [{ key, name, tab }] }          every quotable device, for search-as-you-type
    GET /v1/agents/m/prices?store=<id>&q=<device>  → { store, syncedAt, matches: [{ name, tab, variant, repairs: [{ repair, label, price, raw }] }] }

  The sheet is the one sheets/sync_sheets.py pushes to Waymark's database (env.AE, table `sheets`, kind 'prices'; the Aethernet Worker serves the same row to
  the userscript at GET /v1/:store/sheets/prices): data = { tabs: [{ name, rows: [{ name, cells: { <column>: <raw text> } }] }] }. A store without a row
  (only 914 has one today) answers syncedAt null and nothing listed. Store must be one of device.stores (403); missing or malformed is 400.

  Matching is a faithful port of the userscript's src/23-price-sheet.js (nothing shared with the client bundle; test/mobile-prices.test.mjs pins it):
  retail tabs only, a device matches a row by its exact model words ("15 Pro" never stands in for "15 Pro Max"), "a/b" rows answer for both, Inner/Outer
  rows are variants of one device, and a price is the first number in the cell unless it says N/A or "self repair" (then null).
  Repairs: each priced column goes under the first of Screen, Battery, Charge port, Back glass whose column test it passes (Reassemble's mapping), else
  under its own column name when it has a price. The Notes column is left out.
*/
// ---------------------------------------------------------------- the userscript's parser (src/23-price-sheet.js), ported
const DROP = new Set(['apple', 'samsung', 'google', 'galaxy', '5g', 'motorola', 'nintendo', 'microsoft', 'sony']);
// Retail tabs only: Eagle of Va (contract prices), Refurb, BER, etc. are synced but never quoted from.
export const QUOTE_TABS = new Set(['Apple', 'Samsung', 'Google', 'ipad', 'Game Console']);
const QUAL = new Set(['pro', 'max', 'plus', 'ultra', 'fe', 'xl', 'mini', 'e', 'fold', 'flip', 'edge', 'lite', 'air', 'se', 'a', 's', 'note']);
export const toks = (s) => String(s || '').toLowerCase().replace(/\+/g, ' plus ').replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9/ ]/g, ' ')
  .split(/\s+/).filter((t) => t && !DROP.has(t));
const SCREEN = /lcd|oled|oem|octa|ub screen|screen repair|^glass$|glass\/lcd/i, NOT_SCREEN = /back|camera|cam\b|housing/i;
// Reassemble's repair types → the sheet's columns, in the order a column is tried.
export const REPAIRS = [
  ['Screen', (c) => SCREEN.test(c) && !NOT_SCREEN.test(c)],
  ['Battery', (c) => /battery/i.test(c)],
  ['Charge port', (c) => /charge|charging|dock/i.test(c)],
  ['Back glass', (c) => /back glass/i.test(c)],
];
export const num = (raw) => { const m = String(raw).match(/(\d+(?:\.\d+)?)/); return m && !/n\/?a|self repair/i.test(raw) ? Number(m[1]) : null; };
const baseName = (name) => String(name).split(/\s{3,}|inform customer/i)[0];

// { idx: Map key → [{ tab, variant, name, cells }], devices: [{ key, name, tab }] } (indexPrices, plus the list the phone searches)
export function indexSheet(data) {
  const idx = new Map(), devices = [];
  const tabs = data && Array.isArray(data.tabs) ? data.tabs : [];
  for (const tab of tabs) {
    if (!tab || !QUOTE_TABS.has(tab.name) || !Array.isArray(tab.rows)) continue;
    for (const row of tab.rows) {
      if (!row || row.name == null) continue;
      const cells = row.cells && typeof row.cells === 'object' ? row.cells : {};
      const t = toks(baseName(row.name));
      let variant = '';
      if (/^(inner|outer)$/.test(t[t.length - 1])) variant = t.pop();
      const last = t[t.length - 1] || '';
      const alts = last.includes('/') ? last.split('/') : null;
      const keys = alts ? alts.map((a) => t.slice(0, -1).concat(a).join('')) : [t.join('')];
      keys.forEach((k, i) => {
        if (!k) return;
        if (!idx.has(k)) { idx.set(k, []); devices.push({ key: k, name: displayName(row.name, alts, i), tab: tab.name }); }
        idx.get(k).push({ tab: tab.name, variant, name: row.name, cells });
      });
    }
  }
  return { idx, devices };
}
// The row's name as the phone lists it: before any long note, without Inner/Outer, and for an "a/b" row the one alternative ("iPhone 6/6S" → "iPhone 6S").
function displayName(rowName, alts, i) {
  const words = baseName(rowName).trim().replace(/\s+(inner|outer)$/i, '').split(/\s+/);
  if (alts) {
    const at = words.map((w) => w.includes('/')).lastIndexOf(true), parts = at >= 0 ? words[at].split('/') : [];
    if (parts.length === alts.length) words[at] = parts[i];
  }
  return words.join(' ');
}
// pricesFor: the rows for a device text, or null (no row, or the row is a shorter model: "15 Pro" row, "15 Pro Max" device).
export function pricesFor(device, idx) {
  const t = toks(device).filter((x) => !x.includes('/'));
  for (let k = t.length; k > 0; k--) {
    const rows = idx.get(t.slice(0, k).join(''));
    if (!rows) continue;
    if (k < t.length && QUAL.has(t[k])) return null;
    return rows;
  }
  return null;
}
// One row's repairs: the four repair types first (their columns, priced or not), then the other priced columns under their own name; sheet order within.
export function repairsOf(cells) {
  const typed = REPAIRS.map(() => []), other = [];
  for (const [col, raw] of Object.entries(cells || {})) {
    if (col === 'Notes') continue;
    const text = String(raw == null ? '' : raw), price = num(text), label = col.replace(/screen repair/i, 'Screen');
    const i = REPAIRS.findIndex(([, test]) => test(col));
    if (i >= 0) typed[i].push({ repair: REPAIRS[i][0], label, price, raw: text });
    else if (price != null) other.push({ repair: col, label, price, raw: text });
  }
  return typed.flat().concat(other);
}

// ---------------------------------------------------------------- the route
const err = (status, message) => Object.assign(new Error(message), { status });
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
function storeOf(device, v) {
  if (v == null || !/^\d{1,6}$/.test(v)) throw err(400, 'store: a store number');
  if (!device.stores.map(Number).includes(Number(v))) throw err(403, 'not your store');
  return Number(v);
}
const noTable = (e) => /no such table/i.test(String(e && e.message));

// Parsed sheets, per store, until the sync job pushes a new one (synced_at changes). Per isolate; the sheet itself is a few hundred KB at most.
const cache = new Map();
async function sheetOf(env, store) {
  if (!env.AE) return null;
  const head = await env.AE.prepare("SELECT synced_at FROM sheets WHERE store = ? AND kind = 'prices'").bind(store).first().catch((e) => { if (noTable(e)) return null; throw e; });
  if (!head) { cache.delete(store); return null; }
  const hit = cache.get(store);
  if (hit && hit.syncedAt === head.synced_at) return hit;
  const r = await env.AE.prepare("SELECT data, synced_at FROM sheets WHERE store = ? AND kind = 'prices'").bind(store).first();
  if (!r) return null;
  let data = null;
  try { data = JSON.parse(r.data); } catch (_) { data = null; }
  const v = Object.assign({ syncedAt: r.synced_at }, indexSheet(data));
  cache.set(store, v);
  return v;
}

export async function pricesApi(req, env, url, device, h) {
  const path = url.pathname.replace(/^\/v1\/agents\/m\/prices/, '') || '/';
  if (path !== '/') return h.fail(404, 'not found');
  if (req.method !== 'GET') return h.fail(405, 'GET only');
  const store = storeOf(device, url.searchParams.get('store'));
  const q = clean(url.searchParams.get('q'), 80);
  const sheet = await sheetOf(env, store);
  if (!q) return h.json({ store, syncedAt: sheet ? sheet.syncedAt : null, devices: sheet ? sheet.devices : [] });
  const rows = sheet ? pricesFor(q, sheet.idx) || [] : [];
  return h.json({
    store, syncedAt: sheet ? sheet.syncedAt : null,
    matches: rows.map((r) => ({ name: String(r.name), tab: r.tab, variant: r.variant || null, repairs: repairsOf(r.cells) })),
  });
}
