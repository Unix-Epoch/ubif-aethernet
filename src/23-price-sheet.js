/*
  The Price sheet, shared by Provoke (lead replies) and Reassemble (price estimates). Not a crystal.

  sheets/sync_sheets.py pushes the store's Price sheet (.xlsx tabs) to the Worker; get() reads it
  (GET /v1/:store/sheets/prices, cached 10 minutes) → { data: { tabs: [{ name, rows: [{ name, cells }] }] }, syncedAt }.
  Only the retail tabs are quoted from. A device matches a row exactly by its model words ("15 Pro"
  never stands in for "15 Pro Max").
*/
AE.priceSheet = (() => {
  const DROP = new Set(['apple', 'samsung', 'google', 'galaxy', '5g', 'motorola', 'nintendo', 'microsoft', 'sony']);
  // Retail tabs only: Eagle of Va (contract prices), Refurb, BER, etc. are synced but never quoted from.
  const QUOTE_TABS = new Set(['Apple', 'Samsung', 'Google', 'ipad', 'Game Console']);
  const QUAL = new Set(['pro', 'max', 'plus', 'ultra', 'fe', 'xl', 'mini', 'e', 'fold', 'flip', 'edge', 'lite', 'air', 'se', 'a', 's', 'note']);
  const toks = (s) => String(s || '').toLowerCase().replace(/\+/g, ' plus ').replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9/ ]/g, ' ')
    .split(/\s+/).filter((t) => t && !DROP.has(t));
  const SCREEN = /lcd|oled|oem|octa|ub screen|screen repair|^glass$|glass\/lcd/i, NOT_SCREEN = /back|camera|cam\b|housing/i;
  // Reassemble's repair types → the sheet's columns (null = every priced column).
  const REPAIR_COLS = { Screen: (c) => SCREEN.test(c) && !NOT_SCREEN.test(c), Battery: (c) => /battery/i.test(c),
    'Charge port': (c) => /charge|charging|dock/i.test(c), 'Back glass': (c) => /back glass/i.test(c), Other: null };
  const num = (raw) => { const m = String(raw).match(/(\d+(?:\.\d+)?)/); return m && !/n\/?a|self repair/i.test(raw) ? Number(m[1]) : null; };

  let cache = null;
  async function get() {
    if (cache && Date.now() - cache.at < 10 * 60000) return cache.v;
    const v = await AE.waymark.call('GET', '/sheets/prices').catch(() => null);
    cache = { at: Date.now(), v };
    return v;
  }

  let priceIndex = null, priceFor = null;
  function indexPrices(p) {
    if (priceFor === p) return priceIndex;
    const idx = {};
    for (const tab of (p && p.tabs) || []) if (QUOTE_TABS.has(tab.name)) for (const row of tab.rows || []) {
      const t = toks(String(row.name).split(/\s{3,}|inform customer/i)[0]);
      let variant = '';
      if (/^(inner|outer)$/.test(t[t.length - 1])) variant = t.pop();
      const last = t[t.length - 1] || '';
      const keys = last.includes('/') ? last.split('/').map((a) => t.slice(0, -1).concat(a).join('')) : [t.join('')];
      for (const k of keys) if (k) (idx[k] = idx[k] || []).push({ tab: tab.name, variant, name: row.name, cells: row.cells });
    }
    priceFor = p; priceIndex = idx;
    return idx;
  }
  function pricesFor(device, p) {
    const idx = indexPrices(p), t = toks(device).filter((x) => !x.includes('/'));
    for (let k = t.length; k > 0; k--) {
      const rows = idx[t.slice(0, k).join('')];
      if (!rows) continue;
      if (k < t.length && QUAL.has(t[k])) return null; // "15 Pro" row, "15 Pro Max" device: not the same phone
      return rows;
    }
    return null;
  }
  // Provoke's chips: [{label, price, raw}], lowest first. Phones and tablets: screen
  // columns only ("always quote the lowest screen price"); consoles: every repair.
  function screenPrices(rows) {
    const out = [], consoles = (rows || []).every((r) => r.tab === 'Game Console');
    for (const r of rows || []) for (const [col, raw] of Object.entries(r.cells)) {
      if (col === 'Notes' || (!consoles && (!SCREEN.test(col) || NOT_SCREEN.test(col)))) continue;
      const n = num(raw);
      if (n != null) out.push({ console: consoles, label: (r.variant ? r.variant[0].toUpperCase() + r.variant.slice(1) + ' ' : '') + col.replace(/screen repair/i, 'Screen'), price: n, raw });
    }
    return out.sort((a, b) => a.price - b.price);
  }
  // Reassemble: one repair's prices for a model → { rows, prices: [{label, price, raw, tab}] } (rows null = no such device on the sheet).
  function repairPrices(device, repair, p) {
    const rows = pricesFor(device, p);
    if (!rows) return { rows: null, prices: [] };
    const want = REPAIR_COLS[repair] || null, out = [];
    for (const r of rows) for (const [col, raw] of Object.entries(r.cells)) {
      if (col === 'Notes' || (want && !want(col))) continue;
      const n = num(raw);
      if (n != null) out.push({ label: (r.variant ? r.variant[0].toUpperCase() + r.variant.slice(1) + ' ' : '') + col.replace(/screen repair/i, 'Screen'), price: n, raw, tab: r.tab, row: r.name });
    }
    return { rows, prices: out.sort((a, b) => a.price - b.price) };
  }
  return { get, pricesFor, screenPrices, repairPrices, num };
})();
