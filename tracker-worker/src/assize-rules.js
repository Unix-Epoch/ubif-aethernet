/*
  Assize's rules engine (the live work-order audit's [A] rules): pure functions, list row + detail + now + store hours
  + price lookup → findings. No DOM, no fetching, no GM, no AE helpers, so the same file runs in three places:
    · Aethernet: inlined into src/65-assize.js by build.py (tracker_module: `export` dropped), as AE.assizeRules.
    · the tracker Worker: imported (rule catalog, graph checks before saving or publishing).
    · the admin site: served to the browser as a module (the Assize rules editor runs graphs and the code side by side).
  It never knows about dismissals.

  makeRules({ RG, graphs }) → the engine (what AE.assizeRules always was, plus the rule-graph pieces). RG is the rule
  graph interpreter (rulegraph.js; null = no graphs), graphs the built-in graphs ({ rule: graph }, src/assize-graphs).
  The rest of the exports need neither: CATALOG (every rule the code raises), trimRow / trimDetail (what Assize keeps
  of a list row and a detail), fromSnapshot (a tracker snapshot as Assize's inputs).

  Phone / TV / wearable / foldable: from the work order's catalog entry when its detail is loaded
  (DeviceModel.DeviceType.name: "Cell Phone", "Tablet", "Computer", "Game Console", "Wearable"...;
  DeviceFamily.name "Samsung Galaxy Fold" / "Samsung Galaxy Z Flip", the two Portal itself treats
  as foldables). Portal's list rows carry only the catalog name (deviceCatalog.name), so before the
  detail is in, and for types Portal has no name for (TVs), it's decided from the device name.
*/
export const MAX_GRAPH_NODES = 200;
export const MAX_GRAPH_BYTES = 256 * 1024;
// A rule id: kebab-case, e.g. missed-contact, no-bin.
export const RULE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const RULE_MAX = 60;
export const ruleId = (v) => (typeof v === 'string' && v.length <= RULE_MAX && RULE_RE.test(v) ? v : null);

/*
  Every rule the code raises, in the panel's order: { rule, check, title, kind }. perOrder false: it looks across
  orders (orphanCleanings), so a graph can't stand in for it (graphs run one order at a time); it can still be
  turned off. not-started-3-days is a note instead of a fail when a later note may say why.
*/
export const CATALOG = [
  ['no-intake-note', 'intake', 'No intake note', 'note'], ['short-intake-note', 'intake', 'Short note', 'note'],
  ['liquid-no-agreement', 'intake', 'Liquid, no agreement', 'note'], ['data-risk-no-agreement', 'intake', 'Data risk, no agreement', 'note'],
  ['oop-zero-cart', 'cart', 'OOP, $0 cart', 'note'], ['price-off-sheet', 'cart', 'Price off the sheet', 'note'], ['ntf-no-labor', 'cart', 'No labor line', 'fail'],
  ['no-part-line', 'cart', 'No part line', 'fail'], ['no-priced-lines', 'cart', 'No priced lines', 'note'], ['buyout-has-charges', 'cart', 'Buyout has charges', 'fail'],
  ['cci-zero-cart', 'cart', 'CCI, $0 cart', 'note'], ['cci-not-15', 'cart', 'CCI not $15', 'fail'],
  ['no-quote', 'quote', 'No quote', 'note'],
  ['unknown-partner', 'partner', 'Unknown partner', 'note'], ['wearable-checked-in', 'partner', 'Wearable checked in', 'fail'], ['tv-open-after-close', 'partner', 'TV open after close', 'fail'],
  ['foldable-samsung-iw', 'partner', 'Foldable on Samsung IW', 'fail'], ['buyout-not-phone', 'partner', 'Buyout not a phone', 'fail'], ['buyout-still-open', 'partner', 'Buyout still open', 'fail'],
  ['phone-on-home-plus', 'partner', 'Phone on Home+', 'fail'], ['vzew-not-phone', 'partner', 'VZ EW not a phone', 'fail'], ['vzew-damage', 'partner', 'Damage on VZ EW', 'fail'],
  ['parent-closed-cleaning-open', 'cleaning', 'Parent closed, cleaning open', 'fail'],
  ['no-date', 'contact', 'No date', 'fail'], ['date-not-updated', 'contact', 'Date not updated', 'flag'], ['contact-due', 'contact', 'Contact due', 'flag'], ['missed-contact', 'contact', 'Missed contact', 'fail'],
  ['no-bin', 'bin', 'No bin', 'fail'], ['not-started', 'start', 'Not started', 'fail'], ['not-started-3-days', 'start', 'Not started in 3 days', 'fail'],
  ['unresponsive', 'age', 'Unresponsive', 'flag'], ['not-ordered', 'order', 'Not ordered', 'fail'], ['awaiting-item', 'remind', 'Awaiting item', 'remind'],
].map(([rule, check, title, kind]) => ({ rule, check, title, kind, perOrder: rule !== 'parent-closed-cleaning-open' }));

// ------------------------------------------------------------ what Assize keeps (GM storage; the editor's test orders)
// Only what the rules read, so GM storage stays small (and no passcodes, phones or emails).
export const trimRow = (r) => ({
  workorderId: r.workorderId, workorderStatusId: r.workorderStatusId, workorderStatusName: r.workorderStatusName, programId: r.programId, programName: r.programName,
  createdAt: r.createdAt, updatedAt: r.updatedAt, nextUpdate: r.nextUpdate, rfpWorkorderStatusDate: r.rfpWorkorderStatusDate || null, locationBin: r.locationBin,
  deviceCatalog: { name: (r.deviceCatalog && r.deviceCatalog.name) || '' }, deviceIssues: r.deviceIssues || [], serviceOutcome: r.serviceOutcome || '',
  customerDevice: { name: (r.customerDevice && r.customerDevice.name) || '', imei: (r.customerDevice && r.customerDevice.imei) || '', customerId: (r.customerDevice && r.customerDevice.customerId) || '' },
  customer: { customerId: r.customer && (r.customer.customerId ?? r.customer.id), fullName: (r.customer && r.customer.fullName) || '' },
  createdBy: r.createdBy && typeof r.createdBy === 'object' ? { userId: r.createdBy.userId, givenName: r.createdBy.givenName, familyName: r.createdBy.familyName } : null,
  deviceTypeName: r.deviceTypeName || (r.deviceType && r.deviceType.name) || undefined,
});
// A Portal user id from a number, a numeric string or a { userId } object; null when there is none.
const uid = (v) => { const x = v != null && typeof v === 'object' ? (v.userId ?? v.id) : v; return x == null || x === '' ? null : x; };
const user = (u) => (u ? { userId: u.userId, givenName: u.givenName, familyName: u.familyName } : null);
// Portal's detail (GET /api/workorder/:id's answer, the notes, the audit trail, the cart) as the rules read it.
export function trimDetail(core, notes, audit, cart) {
  const w = (core && core.workorder) || {};
  const cd = w.CustomerDevice || {}, cat = cd.DeviceCatalog || {}, m = cat.DeviceModel || {};
  const bin = w.WorkorderBinDeviceLocation;
  return {
    wo: {
      workorderId: w.workorderId, workorderStatusId: w.workorderStatusId, WorkorderStatus: w.WorkorderStatus && { name: w.WorkorderStatus.name },
      programId: w.programId, Program: w.Program && { name: w.Program.name }, createdAt: w.createdAt, updatedAt: w.updatedAt, nextUpdate: w.nextUpdate, csuCartId: w.csuCartId, createdBy: uid(w.createdBy), updatedBy: uid(w.updatedBy),
      CustomerDevice: { name: cd.name || '', DeviceCatalog: { name: cat.name || '', DeviceModel: { DeviceType: m.DeviceType && { name: m.DeviceType.name }, DeviceFamily: m.DeviceFamily && { name: m.DeviceFamily.name } } } },
      WorkorderBinDeviceLocation: bin ? { WorkorderBin: { name: (bin.WorkorderBin && bin.WorkorderBin.name) || '' } } : null,
      WorkorderAttributes: (w.WorkorderAttributes || []).filter((a) => Number(a.workorderAttributeTypeId) === 22).map((a) => ({ workorderAttributeTypeId: 22, value: a.value })),
      WorkorderDeviceIssueServiceOptions: (w.WorkorderDeviceIssueServiceOptions || []).map((o) => ({ DeviceIssueCategoryTypeOption: { DeviceIssue: { name: o && o.DeviceIssueCategoryTypeOption && o.DeviceIssueCategoryTypeOption.DeviceIssue && o.DeviceIssueCategoryTypeOption.DeviceIssue.name } } })),
    },
    notes: (notes || []).slice(0, 80).map((n) => ({ noteType: n.noteType, noteTag: n.noteTag, noteText: String(n.noteText || '').slice(0, 3000), createdAt: n.createdAt, UserDatum: user(n.UserDatum) })),
    audit: (Array.isArray(audit) ? audit : []).map((a) => ({ workorderStatusId: a.workorderStatusId, createdAt: a.createdAt, createdBy: a.createdBy, completed: a.completed })),
    cart: cart ? { cartItems: (cart.cartItems || []).map((i) => ({ lineId: i.lineId, parentLineId: i.parentLineId, sku: i.sku, itemNumber: i.itemNumber, name: i.name, price: i.price, quantity: i.quantity, lineType: i.lineType })),
      payment: cart.payment ? { subtotal: cart.payment.subtotal, total: cart.payment.total } : null } : null,
  };
}
/*
  fromSnapshot(plain, sealed) → { row, detail, details, missing }: one tracker snapshot (the Worker's plain part and,
  opened in the browser, its sealed detail { workorder, audit_trail, notes, cart, list_row }) as Assize's audit()
  inputs, trimmed the way Assize keeps them. With sealed: what Assize itself would have (details true, missing []).
  Without (no customer details access), from the plain part alone (details false), and `missing` says what isn't
  there: notes (detail.notes = null, so the note rules wait, as they do in Assize before an order's notes load: a
  graph node that reads notes says so in a debug run, needsNotes), nickname (blank: the contact rules see no date),
  deviceType (decided from the device name), issues, lineTypes (cart lines without their kind: labor, trade credit).
  A sealed detail whose notes didn't load also has notes null (and 'notes' missing), never "no notes".
*/
export function fromSnapshot(plain, sealed) {
  if (sealed && sealed.workorder) {
    const loaded = !!(sealed.notes && Array.isArray(sealed.notes.notes));
    const detail = trimDetail(sealed.workorder, loaded ? sealed.notes.notes : [], sealed.audit_trail, sealed.cart);
    if (!loaded) detail.notes = null;
    return { row: sealed.list_row ? trimRow(sealed.list_row) : null, detail, details: true, missing: loaded ? [] : ['notes'] };
  }
  const w = (plain && plain.workorder) || {}, cart = plain && plain.cart;
  const row = {
    workorderId: w.workorderId, workorderStatusId: w.statusId, workorderStatusName: w.status || '', programId: w.programId, programName: w.program || '',
    createdAt: w.createdAt, updatedAt: w.updatedAt, nextUpdate: w.nextUpdate, rfpWorkorderStatusDate: w.rfpAt || null, locationBin: w.bin == null ? '' : w.bin,
    deviceCatalog: { name: w.device || '' }, deviceIssues: [], serviceOutcome: w.outcome || '', createdBy: null,
  };
  const detail = {
    wo: { workorderId: w.workorderId, workorderStatusId: w.statusId, WorkorderStatus: { name: w.status || '' }, programId: w.programId, Program: { name: w.program || '' },
      createdAt: w.createdAt, updatedAt: w.updatedAt, nextUpdate: w.nextUpdate, createdBy: uid(w.createdBy), updatedBy: uid(w.updatedBy), CustomerDevice: { DeviceCatalog: { name: w.device || '' } },
      WorkorderAttributes: w.outcome ? [{ workorderAttributeTypeId: 22, value: w.outcome }] : [] },
    notes: null,
    audit: ((plain && plain.auditTrail) || []).map((a) => ({ workorderStatusId: a.statusId, createdAt: a.createdAt, createdBy: a.createdBy, completed: a.completed })),
    cart: cart ? { cartItems: (cart.items || []).map((i) => ({ lineId: i.lineId, parentLineId: i.parentLineId, sku: i.sku, itemNumber: i.sku, name: i.name, price: i.price, quantity: i.quantity })),
      payment: cart.payment ? { subtotal: cart.payment.subtotal, total: cart.payment.total } : null } : null,
  };
  return { row, detail, details: false, missing: ['notes', 'nickname', 'deviceType', 'issues', 'lineTypes'] };
}

// ------------------------------------------------------------ the engine
export function makeRules({ RG = null, graphs: builtIn = {} } = {}) {
  // Store hours for "after close" (TVs, buyouts) and "last business night" (Need to order). Local time.
  // Open 10:00–19:00 Monday–Saturday (getDay(): 0 = Sunday); Lexington (536) is open every day.
  const STORE_HOURS = { open: 10, close: 19, closedDays: [0] };
  const OPEN_DAILY = new Set([536]);
  const hoursFor = (store) => (OPEN_DAILY.has(Number(store)) ? Object.assign({}, STORE_HOURS, { closedDays: [] }) : STORE_HOURS);
  const MORNING_ENDS = 12; // the "morning audit" for Need to order: before 12:00 local
  const DAY = 86400000, HOUR = 3600000;

  // Checks, in the rules' order (section headings in the panel).
  const CHECKS = [
    ['intake', 'Intake note'], ['cart', 'Cart and price'], ['quote', 'Quote'], ['partner', 'Partner rules'],
    ['cleaning', 'Cleaning rate'], ['contact', 'Nickname and contact'], ['bin', 'Bin'], ['start', 'Start time'],
    ['age', 'Age'], ['order', 'Need to order'], ['remind', 'Reminders'],
  ];
  const KINDS = ['fail', 'flag', 'note', 'remind'];

  // ------------------------------------------------------------ programs
  const CLEANING_IDS = [11759, 9470, 11009, 9901, 10303];
  const CLEANING_RE = /sanitization|device refresh|enhanced device cleaning|device diagnostic|performance (check|promise)/i;
  // Matched by name (the list row's programName / the detail's Program.name), ids where known.
  function programOf(id, name) {
    const n = String(name || ''), i = Number(id);
    if (CLEANING_IDS.includes(i) || CLEANING_RE.test(n)) return { key: 'cleaning', name: n };
    if (i === 20001 || /out of (warranty|pocket)|^oop\b/i.test(n)) return { key: 'oop', name: n, xbox: /xbox/i.test(n) };
    if (/home\s*\+|tech connected home/i.test(n) || i === 8849 || i === 20005) return { key: 'asurion', name: n, partner: true, homePlus: true };
    if (/asurion/i.test(n) || i === 5062) return { key: 'asurion', name: n, partner: true };
    if (/samsung care/i.test(n)) return { key: 'servify', name: n, partner: true, label: 'Samsung Care+' };
    if (/servify/i.test(n)) return { key: 'servify', name: n, partner: true, label: 'Servify' };
    if (/samsung in.?warranty/i.test(n) || i === 6494) return { key: 'samsungIW', name: n, partner: true };
    if (/google|pixel care/i.test(n)) return { key: 'google', name: n, partner: true };
    if (/amazon/i.test(n)) return { key: 'amazon', name: n, partner: true };
    if (/consumer cellular|\bcci\b/i.test(n)) return { key: 'cci', name: n, partner: true };
    if (/verizon extended warranty/i.test(n) || i === 8379) return { key: 'vzew', name: n, partner: true };
    if (/element/i.test(n)) return { key: 'element', name: n, partner: true };
    return { key: 'unknown', name: n || 'Program ' + (id == null ? '?' : id), partner: true };
  }

  // ------------------------------------------------------------ devices
  const WEARABLE_RE = /\bwatch\b|airpods|\bbuds\b|earbud|headphone|\bbeats\b|fitbit|garmin|galaxy ring|oura|\bpixel watch\b/i;
  const TV_RE = /\btv\b|television/i;
  const FOLD_RE = /\bfold|\bflip\b|z flip|razr/i;
  const PHONE_RE = /iphone|galaxy (s|a|z|note)\d*|galaxy z|pixel(?! ?(tablet|watch|buds|book|slate))|\bmoto\b|motorola|oneplus|razr|\bphone\b|revvl|nokia|\blg (stylo|k\d)/i;
  const NOT_PHONE_RE = /ipad|\btab\b|tablet|watch|buds|macbook|laptop|chromebook/i;
  function deviceOf(f) {
    const type = String(f.deviceType || ''), fam = String(f.deviceFamily || ''), name = String(f.device || '');
    const from = type ? 'type' : 'name';
    const wearable = /wearable/i.test(type) || WEARABLE_RE.test(name);
    const tv = /tv|television/i.test(type) || TV_RE.test(name);
    const phone = type ? /cell ?phone|phone/i.test(type) : PHONE_RE.test(name) && !NOT_PHONE_RE.test(name);
    const foldable = /galaxy fold|z flip/i.test(fam) || FOLD_RE.test(name);
    return { phone: phone && !wearable, tv, wearable, foldable, from };
  }

  // ------------------------------------------------------------ signatures
  // A short, stable hash (FNV-1a, base 36) of the facts a finding rests on. No facts = ''.
  function sigOf(...parts) {
    const s = parts.filter((p) => p != null && p !== '').map(String).join('\u241f');
    if (!s) return '';
    let x = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; }
    return x.toString(36).padStart(7, '0');
  }

  // ------------------------------------------------------------ time
  const at = (d, h, m = 0) => { const x = new Date(d); x.setHours(h, m, 0, 0); return x.getTime(); };
  const dayKey = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const md = (ms) => { const d = new Date(ms); return (d.getMonth() + 1) + '/' + d.getDate(); };
  const clock = (ms) => { const d = new Date(ms); const h = d.getHours() % 12 || 12, m = String(d.getMinutes()).padStart(2, '0'); return h + ':' + m + ' ' + (d.getHours() < 12 ? 'AM' : 'PM'); };
  const addDays = (ms, n) => { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); };
  // Calendar days from one date to another (local), so "since 10/9" on 10/16 reads 7 days whatever the hour.
  const daysBetween = (a, b) => Math.round((at(b, 12) - at(a, 12)) / DAY);
  const openDay = (ms, hours) => !hours.closedDays.includes(new Date(ms).getDay());
  // The first store close strictly after ms (closed days skipped).
  function closeAfter(ms, hours) {
    for (let i = 0; i < 14; i++) { const d = addDays(ms, i), c = at(d, hours.close); if (openDay(d, hours) && c > ms) return c; }
    return Infinity;
  }
  // The last store close at or before ms.
  function closeBefore(ms, hours) {
    for (let i = 0; i < 14; i++) { const d = addDays(ms, -i), c = at(d, hours.close); if (openDay(d, hours) && c <= ms) return c; }
    return -Infinity;
  }
  // The next opening at or after ms.
  function openAfter(ms, hours) {
    for (let i = 0; i < 14; i++) { const d = addDays(ms, i), o = at(d, hours.open); if (openDay(d, hours) && o >= ms) return o; }
    return Infinity;
  }
  function whenWord(ms, now) {
    if (dayKey(ms) === dayKey(now)) return 'today';
    if (dayKey(ms) === dayKey(addDays(now, -1))) return 'yesterday';
    return 'on ' + md(ms);
  }
  // "IPHONE 13 SCREEN 10/17" → the date it names (the year nearest now), or null.
  function nickDate(name, now) {
    const all = [...String(name || '').matchAll(/(?:^|[^\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?![\d/])/g)];
    const m = all[all.length - 1];
    if (!m) return null;
    const mo = Number(m[1]), da = Number(m[2]);
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
    const y0 = new Date(now).getFullYear();
    const years = m[3] ? [Number(m[3].length === 2 ? '20' + m[3] : m[3])] : [y0 - 1, y0, y0 + 1];
    let best = null;
    for (const y of years) { const t = new Date(y, mo - 1, da).getTime(); if (best == null || Math.abs(t - now) < Math.abs(best - now)) best = t; }
    return best;
  }

  // ------------------------------------------------------------ notes
  const MANUAL = 2, SYSTEM = 1;
  const CHECKLIST_LINE = /^\s*[•*\-]?\s*\*\*[^*]+:\*\*/;
  const LIQUID_RE = /\b(liquid|water|corrosion|corroded|wet)\b/i;
  const DATA_RE = /\b(reinstall(?:ed|ing)?|re-?flash(?:ed|ing)?|wipe[ds]?|wiping|(?:factory )?reset|(?:mother|logic|main) ?board|board swap|recovery)\b/i;
  const AGREE_RE = /\b(aware|agree[sd]?|agreement|okay with|ok with|fine with|understands?|understood|acknowledge[sd]?|consent(?:s|ed)?|accept(?:s|ed)?|signed)\b/i;
  const CONTACT_RE = /\b(call(?:ed|ing)?|texted|sent a text|left (?:a )?(?:vm|voicemail|message)|voicemail|vm|spoke|talked|emailed|reached|no answer|contacted|messaged)\b/i;
  // A price in a note: $150 · 150$ / 150 $ / 49.99$ (sign after, as techs often write it) · 150.00 · 150 dollars ·
  // a number right after OOP / quote(d) / price ("OOP - 150"). Oct 16, 2026: "OOP - 150$" was missed.
  const DOLLAR_RE = /\$\s?\d|\b\d+(?:[.,]\d{1,2})?\s?\$|\b\d+\.\d{2}\b|\b\d+\s?(?:dollars|usd)\b|\b(?:oop|quoted?|price)\b[^\n\d]{0,8}\d{2,}/i;
  const OVERRIDE_RE = /-\s*per\s+(?:gg|garrett)\b/i;
  const EXPLAIN_RE = /\b(deposit|gspn|checkout complete|waive[ds]?|refund(?:ed)?|atc|no charge)\b/i;
  // A keyword that isn't negated ("no water damage", "not wet").
  function mentions(text, re) {
    const g = new RegExp(re.source, 'gi');
    for (const m of String(text || '').matchAll(g)) {
      const before = text.slice(Math.max(0, m.index - 24), m.index);
      if (!/\b(no|not|without|never)\s+(signs?\s+of\s+|any\s+)?$/i.test(before)) return m[1] || m[0];
    }
    return null;
  }
  const t = (n) => Date.parse(n && n.createdAt) || 0;
  const person = (u) => {
    if (!u) return null;
    const name = [u.givenName, u.familyName].filter(Boolean).join(' ').trim();
    return name ? { key: 'u:' + name.toLowerCase(), name, label: initials(u) } : null;
  };
  function initials(u) {
    const a = String(u.givenName || '').trim(), b = String(u.familyName || '').trim();
    return ((a[0] || '') + (b[0] || '')).toUpperCase() || '?';
  }
  const STORE = { key: 'store', label: 'Store', name: 'Store' };
  const UNASSIGNED = { key: 'unassigned', label: 'Unassigned', name: 'Unassigned' };
  const statusTag = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

  // ------------------------------------------------------------ facts
  // One order as the rules see it: the detail where loaded, the list row otherwise.
  function facts(row, detail) {
    row = row || {};
    const d = detail || null, w = (d && d.wo) || {};
    const cd = w.CustomerDevice || {}, cat = cd.DeviceCatalog || {}, model = cat.DeviceModel || {};
    const issuesDetail = (w.WorkorderDeviceIssueServiceOptions || []).map((o) => o && o.DeviceIssueCategoryTypeOption && o.DeviceIssueCategoryTypeOption.DeviceIssue && o.DeviceIssueCategoryTypeOption.DeviceIssue.name).filter(Boolean);
    const issuesRow = Array.isArray(row.deviceIssues) ? row.deviceIssues.map((x) => (x && typeof x === 'object' ? x.name : x)).filter(Boolean) : [];
    const binName = (w.WorkorderBinDeviceLocation && w.WorkorderBinDeviceLocation.WorkorderBin && w.WorkorderBinDeviceLocation.WorkorderBin.name);
    const outcomes = (w.WorkorderAttributes || []).filter((a) => Number(a.workorderAttributeTypeId) === 22).map((a) => String(a.value || '').trim());
    // List-row fields (status, nickname, bin, dates) come from the list row when there is one: it is re-read every pass,
    // while a cached detail can be older. A detail fetched after the row (d.rowFresher === false: the order's own page,
    // a just-sent text, a Waymark nickname change) wins instead. Detail alone supplies notes, cart, audit trail, checklist.
    const rowFirst = !!row.workorderId && !(d && d.rowFresher === false);
    const notes = d && Array.isArray(d.notes) ? d.notes.slice().sort((a, b) => t(a) - t(b)) : null;
    return {
      id: String(w.workorderId || row.workorderId || ''),
      statusId: Number((rowFirst ? row.workorderStatusId || w.workorderStatusId : w.workorderStatusId || row.workorderStatusId)) || null,
      status: (rowFirst ? row.workorderStatusName || (w.WorkorderStatus && w.WorkorderStatus.name) : (w.WorkorderStatus && w.WorkorderStatus.name) || row.workorderStatusName) || '',
      programId: w.programId != null ? w.programId : row.programId,
      programName: (w.Program && w.Program.name) || row.programName || '',
      device: cat.name || (row.deviceCatalog && row.deviceCatalog.name) || '',
      deviceType: (model.DeviceType && model.DeviceType.name) || row.deviceTypeName || (row.deviceType && row.deviceType.name) || '',
      deviceFamily: (model.DeviceFamily && model.DeviceFamily.name) || '',
      issues: issuesDetail.length ? issuesDetail : issuesRow,
      nickname: (rowFirst && row.customerDevice && row.customerDevice.name != null ? row.customerDevice.name : (d ? cd.name : null) ?? (row.customerDevice && row.customerDevice.name)) ?? '',
      bin: rowFirst && row.locationBin != null ? row.locationBin : d && w.WorkorderBinDeviceLocation !== undefined ? (binName || '') : (row.locationBin != null ? row.locationBin : binName || ''),
      createdAt: Date.parse(w.createdAt || row.createdAt) || null,
      updatedAt: Date.parse(rowFirst ? row.updatedAt || w.updatedAt : w.updatedAt || row.updatedAt) || null,
      nextUpdate: Date.parse(rowFirst ? row.nextUpdate || w.nextUpdate : w.nextUpdate || row.nextUpdate) || null,
      rfpAt: Date.parse(row.rfpWorkorderStatusDate) || null,
      outcome: outcomes.find((v) => ['Completed', 'Incomplete', 'Declined', 'No issue found'].includes(v)) || (row.serviceOutcome || ''),
      createdBy: row.createdBy && typeof row.createdBy === 'object' ? row.createdBy : null,
      // Portal's user ids (null on a cached detail from before Assize kept them): who created / last updated the order.
      createdById: uid(w.createdBy) ?? uid(row.createdBy), updatedById: uid(w.updatedBy),
      notes, audit: d && Array.isArray(d.audit) ? d.audit : null, cart: d ? d.cart || null : null, hasCart: !!(d && 'cart' in d),
      detail: !!d,
    };
  }
  // Who did what, from the notes: user id → person, the intake note, when/who set the current status.
  function people(f) {
    const byId = new Map();
    for (const n of f.notes || []) { const p = person(n.UserDatum); if (p && n.UserDatum.userId != null) byId.set(String(n.UserDatum.userId), p); }
    return byId;
  }
  const intakeNote = (f) => (f.notes || []).find((n) => Number(n.noteType) === MANUAL && n.noteTag === 'initial_checkin') || null;
  function intakeAuthor(f) {
    const n = intakeNote(f);
    return (n && person(n.UserDatum)) || person(f.createdBy) || UNASSIGNED;
  }
  // When the order entered its current status, and who moved it there.
  function statusEntry(f) {
    const tag = statusTag(f.status);
    const sys = (f.notes || []).filter((n) => n.noteTag === tag).sort((a, b) => t(b) - t(a))[0] || null;
    const trail = (f.audit || []).filter((a) => Number(a.workorderStatusId) === f.statusId).sort((a, b) => t(b) - t(a))[0] || null;
    const ids = people(f);
    const since = trail ? t(trail) : sys ? t(sys) : f.statusId === 13 && f.rfpAt ? f.rfpAt : null;
    const who = (sys && person(sys.UserDatum)) || (trail && trail.createdBy != null && ids.get(String(trail.createdBy))) || UNASSIGNED;
    return { since, who };
  }
  // A person from a Portal user id: the name from a note by them, else the order's creator (the list row names them),
  // else "User #id" (key user-<id>); no id at all is Unassigned. The audit trail carries ids only, never names.
  function personById(f, id) {
    id = uid(id);
    if (id == null) return UNASSIGNED;
    const named = people(f).get(String(id));
    if (named) return named;
    const c = f.createdBy && String(uid(f.createdBy)) === String(id) ? person(f.createdBy) : null;
    return c || { key: 'user-' + id, label: 'User #' + id, name: 'User #' + id };
  }
  // Who last updated the order in Portal, and when: updatedBy (at the order's updatedAt); without it (an older cached
  // detail), whoever did the latest thing on record: a note (manual or system) or an audit entry. { who, at, from }.
  function lastUserEntry(f) {
    if (f.updatedById != null) return { who: personById(f, f.updatedById), at: f.updatedAt || null, from: 'updatedBy' };
    let best = null;
    for (const n of f.notes || []) if (n.UserDatum && (!best || t(n) >= best.at)) best = { who: person(n.UserDatum) || personById(f, n.UserDatum.userId), at: t(n) };
    for (const a of f.audit || []) if (uid(a.createdBy) != null && (!best || t(a) > best.at)) best = { who: personById(f, a.createdBy), at: t(a) };
    return best ? { who: best.who, at: best.at || null, from: 'activity' } : { who: UNASSIGNED, at: null, from: null };
  }
  const lastUser = (f) => lastUserEntry(f).who;
  // The order's creator, and when it was created.
  const createdByEntry = (f) => ({ who: f.createdById != null ? personById(f, f.createdById) : person(f.createdBy) || UNASSIGNED, at: f.createdAt });
  // Who moved the order into its current status (statusEntry's, else the audit entry's user id), and since when.
  function statusSetBy(f) {
    const e = statusEntry(f);
    if (e.who !== UNASSIGNED) return e;
    const trail = (f.audit || []).filter((a) => Number(a.workorderStatusId) === f.statusId && uid(a.createdBy) != null).sort((a, b) => t(b) - t(a))[0];
    return trail ? { since: e.since, who: personById(f, trail.createdBy) } : e;
  }
  // Notes by kind (manual | system | any), tag, author name (contains) and since (ms, createdAt at or after).
  function filterNotes(notes, flt) {
    const k = (flt && flt.kind) || 'manual', tag = String((flt && flt.tag) || '').trim(), who = String((flt && flt.author) || '').trim().toLowerCase(), since = Number(flt && flt.since) || 0;
    return (notes || []).filter((n) => {
      if (k !== 'any' && (Number(n.noteType) === MANUAL) !== (k === 'manual')) return false;
      if (tag && n.noteTag !== tag) return false;
      if (who && !(person(n.UserDatum) || { name: '' }).name.toLowerCase().includes(who)) return false;
      return !since || t(n) >= since;
    }).slice().sort((a, b) => t(a) - t(b));
  }
  const lastNote = (f, flt) => filterNotes(f.notes, flt).pop() || null;
  const firstNote = (f, flt) => filterNotes(f.notes, flt)[0] || null;
  const repairText = (f) => f.issues.join(', ');
  const dayOf = (ms) => (ms ? dayKey(ms) : 'unknown');

  // ------------------------------------------------------------ cart
  const lines = (cart) => ((cart && cart.cartItems) || []).filter(Boolean);
  const price = (l) => Number(l.price) || 0;
  const isCredit = (l) => /pcexempt/i.test(l.sku || l.itemNumber || '') || l.lineType === 'trade_credit';
  const neverFlag = (l) => /miscellaneous labor/i.test(l.name || '') || /^bb\d|buyback/i.test((l.sku || '') + ' ' + (l.name || ''));
  // The cart's lines as the rules see them (what, price, quantity, whether a child), so a changed cart is a new signature.
  const cartSig = (cart) => sigOf(lines(cart).map((l) => [l.sku || l.itemNumber || l.name || '', price(l).toFixed(2), l.quantity == null ? 1 : l.quantity, l.parentLineId ? 'c' : ''].join(':')).sort().join('|') || 'empty');
  const money = (n) => '$' + (Math.round(n * 100) % 100 ? n.toFixed(2) : String(Math.round(n)));
  // A deposit (the diagnostic fee, a parts deposit) comes back as a negative offset line, so a cart with a deposit nets to $0
  // or less. The rules judge what the items are priced at, not what's still owed, so offsets stay out of the sum.
  const isDeposit = (l) => /^srv0006$/i.test(l.sku || l.itemNumber || '') || /deposit/i.test(l.name || '');
  const cartSum = (cart) => lines(cart).filter((l) => !neverFlag(l) && !isDeposit(l)).reduce((s, l) => s + price(l), 0);
  const cartTotal = (cart) => { const p = cart && cart.payment; const v = p && (p.subtotal != null ? Number(p.subtotal) : Number(p.total)); return Number.isFinite(v) ? v : cartSum(cart); };
  const repairFrom = (issues) => {
    const m = issues.map((i) => (/battery/i.test(i) ? 'Battery' : /screen|display|lcd|front glass/i.test(i) && !/back/i.test(i) ? 'Screen' : null));
    return m.length === 1 ? m[0] : null;
  };

  // ------------------------------------------------------------ the rules
  /*
    audit(row, detail, opts) → findings for one order.
      row     Portal's list row (may be null when only the detail is known)
      detail  { wo, notes[], audit[], cart } (null before it's fetched: detail-only checks wait)
      opts    { now, hours (STORE_HOURS), priceFor(device, repair) → [prices] | null }
    A finding: { wo, check, kind: fail|flag|note|remind, title, evidence, who: {key, label, name}, device, repair }.
  */
  function audit(row, detail, opts = {}) {
    const now = opts.now || Date.now(), hours = opts.hours || STORE_HOURS;
    const f = facts(row, detail);
    const out = [];
    // rule = the finding's stable id; sig = a short hash of the facts behind it (see the top comment), so a dismissal stops applying when they change.
    const add = (check, kind, title, evidence, who, rule, ...basis) => out.push({ wo: f.id, check, kind, rule, sig: sigOf(...basis), title, evidence, who: who || UNASSIGNED, device: f.device, repair: repairText(f), program: f.programName, status: f.status });
    const st = f.status.toLowerCase();
    if (!f.id || /sale complete|cancel/.test(st) || /repair summary/.test(st)) return out; // closed, cancelled, closing: never audited
    if (/awaiting diag|partner approval/.test(st)) return out; // no rules
    const prog = programOf(f.programId, f.programName);
    if (prog.key === 'cleaning') return out; // cleaning programs: only 4b (orphanCleanings)
    const rfp = st === 'ready for pickup' || f.statusId === 13;
    const active = !rfp;
    const dev = deviceOf(f);
    const manual = (f.notes || []).filter((n) => Number(n.noteType) === MANUAL);
    const noteText = manual.map((n) => String(n.noteText || '')).join('\n');

    // Awaiting item: a reminder, never a fail; nothing else is checked.
    if (st === 'awaiting item') {
      const e = statusEntry(f), since = e.since;
      add('remind', 'remind', 'Awaiting item', since ? 'Waiting ' + plural(Math.max(0, daysBetween(since, now)), 'day') : 'Waiting for the part', e.who, 'awaiting-item', dayOf(since));
      return out;
    }

    // ---- 1 Intake note (Active)
    if (active && f.notes) {
      const intake = intakeNote(f), who = intakeAuthor(f);
      if (!intake) add('intake', 'note', 'No intake note', 'Nothing was written at check-in', who, 'no-intake-note');
      else {
        const own = String(intake.noteText || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !CHECKLIST_LINE.test(l));
        if (own.length < 3) add('intake', 'note', 'Short note', 'Intake note is under 3 lines', who, 'short-intake-note', intake.noteText);
      }
      const agreed = manual.some((n) => AGREE_RE.test(n.noteText || ''));
      if (!agreed) {
        for (const [re, title, what, rule] of [[LIQUID_RE, 'Liquid, no agreement', 'liquid', 'liquid-no-agreement'], [DATA_RE, 'Data risk, no agreement', null, 'data-risk-no-agreement']]) {
          const n = manual.find((x) => mentions(x.noteText, re));
          if (n) add('intake', 'note', title, 'Note says ' + (what || mentions(n.noteText, re).toLowerCase()) + '; no note says the customer agreed', person(n.UserDatum) || who, rule, n.createdAt, mentions(n.noteText, re).toLowerCase());
        }
      }
    }

    // ---- 2 Cart and price (Active + RFP), 3 Quote (Active)
    // Ready for pickup, Incomplete: the cart isn't checked (Oct 21, 2026).
    if (f.hasCart && !(rfp && /^incomplete$/i.test(f.outcome))) {
      const cart = f.cart, who = intakeAuthor(f);
      if (prog.key === 'oop') {
        const sum = cartSum(cart);
        if (sum <= 0.009) {
          const why = mentions(noteText, EXPLAIN_RE);
          add('cart', 'note', 'OOP, $0 cart', why ? 'Cart is $0; a note mentions ' + why.toLowerCase() : DOLLAR_RE.test(noteText) ? 'Cart is $0; the notes have a price' : 'No price in the cart or in any note', who, 'oop-zero-cart', cartSig(cart), why ? why.toLowerCase() : DOLLAR_RE.test(noteText) ? 'priced-in-notes' : '');
        } else if (dev.phone && opts.priceFor && !OVERRIDE_RE.test(noteText)) {
          const repair = repairFrom(f.issues);
          const sheet = repair ? opts.priceFor(f.device, repair) : null;
          if (sheet && sheet.length) {
            const charged = lines(cart).filter((l) => price(l) > 0 && !isCredit(l) && !neverFlag(l) && !isDeposit(l) && !/diagnostic/i.test(l.name || '')).reduce((s, l) => s + price(l), 0);
            if (charged > 0 && !sheet.some((p) => Math.abs(p - charged) <= 1.01)) {
              const near = sheet.slice().sort((a, b) => Math.abs(a - charged) - Math.abs(b - charged))[0];
              add('cart', 'note', 'Price off the sheet', 'Cart is ' + money(charged) + '; the price sheet says ' + money(near) + ' for ' + f.device + ' ' + repair.toLowerCase(), who, 'price-off-sheet', cartSig(cart), near);
            }
          }
        }
      } else if ((prog.key === 'asurion' && dev.phone) || prog.key === 'servify') {
        // Asurion phones, Servify, Samsung Care+: PCEXEMPT offsets are always applied, so the cart isn't checked (Oct 16, 2026).
      } else if (prog.key === 'asurion' && rfp && !/declined|incomplete/i.test(f.outcome)) {
        const ls = lines(cart);
        if (/no issue found/i.test(f.outcome)) {
          const labor = ls.filter((l) => !isCredit(l) && (l.lineType === 'labor' || /labor|asurion repair/i.test(l.name || '')));
          if (!labor.length) add('cart', 'fail', 'No labor line', 'No issue found on an Asurion non-phone: the cart needs the labor line and its offset', who, 'ntf-no-labor', cartSig(cart));
        } else if (!ls.some((l) => !isCredit(l) && !neverFlag(l) && l.lineType !== 'labor' && !/labor|diagnostic|asurion repair/i.test(l.name || ''))) {
          add('cart', 'fail', 'No part line', 'Asurion non-phone at Ready for pickup with no part in the cart', who, 'no-part-line', cartSig(cart));
        }
      } else if ((prog.key === 'samsungIW' || prog.key === 'google') && rfp) {
        if (!lines(cart).some((l) => !isCredit(l) && price(l) > 0)) add('cart', 'note', 'No priced lines', (prog.key === 'google' ? 'Google' : 'Samsung in-warranty') + ' at Ready for pickup with no priced line (GSPN payments don\'t show here)', who, 'no-priced-lines', cartSig(cart));
      } else if (prog.key === 'amazon') {
        const charged = lines(cart).filter((l) => !isCredit(l) && !neverFlag(l) && price(l) > 0.009);
        const total = cartTotal(cart);
        if (charged.length || total > 0.009) add('cart', 'fail', 'Buyout has charges', 'Amazon Buyout: ' + money(Math.max(total, charged.reduce((s, l) => s + price(l), 0))) + ' in the cart; buyouts have no repair lines or charges', who, 'buyout-has-charges', cartSig(cart));
      } else if (prog.key === 'cci' && rfp) {
        const sum = cartSum(cart);
        if (Math.abs(sum) <= 0.009) add('cart', 'note', 'CCI, $0 cart', 'Cart is $0; an incomplete service needs a reason', who, 'cci-zero-cart', cartSig(cart));
        else if (Math.abs(sum - 15) > 0.009) add('cart', 'fail', 'CCI not $15', 'Cart is ' + money(sum) + '; a CCI service is $15', who, 'cci-not-15', cartSig(cart));
      }
    }
    if (active && prog.key === 'oop' && f.notes && !DOLLAR_RE.test(noteText)) add('quote', 'note', 'No quote', 'OOP; no price in any note', intakeAuthor(f), 'no-quote');

    // ---- 4 Partner rules (Active)
    if (active && prog.key !== 'oop') {
      const who = f.notes ? intakeAuthor(f) : person(f.createdBy) || UNASSIGNED;
      if (prog.key === 'unknown') add('partner', 'note', 'Unknown partner', prog.name + ": Assize doesn't know this partner, so only the general rules were checked", UNASSIGNED, 'unknown-partner', prog.name);
      if (dev.wearable) add('partner', 'fail', 'Wearable checked in', f.device + ': partners don\'t take wearables or hearables', who, 'wearable-checked-in', f.device);
      if (dev.tv && f.createdAt) {
        const close = closeAfter(f.createdAt, hours);
        if (now >= close) add('partner', 'fail', 'TV open after close', 'Still open; the store closed at ' + clock(close) + ' ' + whenWord(close, now), who, 'tv-open-after-close', dayKey(close));
      }
      if (prog.key === 'samsungIW' && dev.foldable) add('partner', 'fail', 'Foldable on Samsung IW', f.device + ': Samsung in-warranty takes no foldables', who, 'foldable-samsung-iw', f.device);
      if (prog.key === 'amazon') {
        if (!dev.phone) add('partner', 'fail', 'Buyout not a phone', f.device + ': Amazon buyouts are phones only', who, 'buyout-not-phone', f.device);
        if (f.createdAt && dayKey(f.createdAt) < dayKey(now)) add('partner', 'fail', 'Buyout still open', 'Created ' + whenWord(f.createdAt, now) + '; buyouts finish the same day', who, 'buyout-still-open', dayKey(f.createdAt));
      }
      if (prog.homePlus && dev.phone) add('partner', 'fail', 'Phone on Home+', f.device + ': ' + (prog.name || 'Home+') + ' takes no phones', who, 'phone-on-home-plus', prog.name, f.device);
      if (prog.key === 'vzew') {
        if (!dev.phone) add('partner', 'fail', 'VZ EW not a phone', f.device + ': Verizon Extended Warranty is phones only', who, 'vzew-not-phone', f.device);
        const intake = f.notes && intakeNote(f);
        const m = intake && String(intake.noteText || '').match(/\*\*\s*Physical damage\s*:\s*\*\*\s*([^\n]+)/i);
        if (m && !/^no issues\b/i.test(m[1].trim())) add('partner', 'fail', 'Damage on VZ EW', 'Intake checklist: Physical damage: ' + m[1].trim() + '. Close it as unrepairable', who, 'vzew-damage', m[1].trim());
      }
    }

    // ---- 5 Nickname and contact (RFP, Awaiting callback, Awaiting device)
    const contactKind = rfp ? 'rfp' : /awaiting (callback|device)/.test(st) ? 'daily' : null;
    if (contactKind) {
      const e = statusEntry(f);
      const due = nickDate(f.nickname, now);
      const label = f.status || 'This status';
      if (due == null) {
        const sameDay = e.since && dayKey(e.since) === dayKey(now);
        if (e.since && !sameDay) add('contact', 'fail', 'No date', label + '; ' + (String(f.nickname || '').trim() ? 'nickname has no date' : 'nickname is blank'), e.who, 'no-date', statusTag(f.status), dayOf(e.since));
      } else if (dayKey(due) <= dayKey(now)) {
        const dueStart = at(due, 0);
        const contact = f.notes ? manual.filter((n) => t(n) >= dueStart && (n.noteTag === 'contacted' || CONTACT_RE.test(n.noteText || ''))).sort((a, b) => t(b) - t(a))[0] : null;
        if (contact) add('contact', 'flag', 'Date not updated', 'Contact noted ' + md(t(contact)) + '; nickname still says ' + md(due), person(contact.UserDatum) || e.who, 'date-not-updated', dayKey(due), t(contact));
        else if (dayKey(due) === dayKey(now)) add('contact', 'flag', 'Contact due', label + '; date is today', e.who, 'contact-due', dayKey(due));
        else if (f.notes) add('contact', 'fail', 'Missed contact', label + '; due ' + md(due) + ', no contact note since', STORE, 'missed-contact', dayKey(due));
      }
    }

    // ---- 6 Bin (RFP; Active with no note or status change for 60 minutes; not Ready for work / Awaiting device)
    if (!/^(ready for work|awaiting device)$/.test(st)) {
      const blank = !String(f.bin || '').trim() || String(f.bin).trim() === '.';
      if (blank) {
        const be = statusEntry(f), bsig = [statusTag(f.status), dayOf(be.since)];
        if (rfp) add('bin', 'fail', 'No bin', 'Ready for pickup, bin is blank', UNASSIGNED, 'no-bin', ...bsig);
        else {
          const last = Math.max(f.updatedAt || 0, ...(f.notes || []).map(t), ...(f.audit || []).map(t));
          if (last && now - last >= HOUR) add('bin', 'fail', 'No bin', label2(f.status) + ' for ' + ago(now - last) + ' with no bin', UNASSIGNED, 'no-bin', ...bsig);
        }
      }
    }

    // ---- 6 Start (Active: left Ready for work in time)
    if (st === 'ready for work' && f.createdAt) {
      if (dev.phone && f.nextUpdate) {
        let by = f.nextUpdate - HOUR;
        if (new Date(f.createdAt).getHours() >= 17) by = Math.max(by, openAfter(at(addDays(f.createdAt, 1), 0), hours) + HOUR); // checked in after 5 PM: the next business day
        if (now > by) add('start', 'fail', 'Not started', 'Still Ready for work; start by ' + clock(by) + (dayKey(by) === dayKey(now) ? '' : ' ' + md(by)) + ' (1 hour before pickup)', UNASSIGNED, 'not-started', dayKey(f.createdAt), dayKey(f.nextUpdate));
      } else if (!dev.phone && now - f.createdAt >= 3 * DAY) {
        const later = manual.some((n) => n.noteTag !== 'initial_checkin');
        add('start', later ? 'note' : 'fail', 'Not started in 3 days', 'Still Ready for work ' + plural(Math.floor((now - f.createdAt) / DAY), 'day') + ' after check-in' + (later ? '; a note may say why' : ''), UNASSIGNED, 'not-started-3-days', dayKey(f.createdAt));
      }
    }

    // ---- 6 Age (Awaiting callback / device: 14 days or more)
    if (/awaiting (callback|device)/.test(st)) {
      const e = statusEntry(f);
      if (e.since) { const days = daysBetween(e.since, now); if (days >= 14) add('age', 'flag', 'Unresponsive', f.status + ' for ' + days + ' days; decide what to do', e.who, 'unresponsive', statusTag(f.status), dayOf(e.since)); }
    }

    // ---- 6 Need to order: entered before the last business night's close = not ordered (Store)
    if (st === 'need to order') {
      const e = statusEntry(f);
      const ref = Math.min(now, at(now, MORNING_ENDS)); // the morning audit's view: last night's close
      const lastClose = closeBefore(ref, hours);
      if (e.since && e.since < lastClose) add('order', 'fail', 'Not ordered', 'In Need to order since ' + md(e.since) + '; not ordered ' + (dayKey(lastClose) === dayKey(addDays(now, -1)) ? 'last night' : 'by close on ' + md(lastClose)), STORE, 'not-ordered', dayOf(e.since));
    }
    return out;
  }

  /*
    4b, the one cheap piece: an Asurion Mobility parent already closed while one of its cleanings is
    still open. Divination owns the rate itself. belongs(cleaning, parent) is AE.data.belongs
    (same IMEI, or customer without one).
  */
  function orphanCleanings(openRows, closedRows, belongs) {
    const out = [];
    for (const c of openRows || []) {
      if (programOf(c.programId, c.programName).key !== 'cleaning') continue;
      const ct = Date.parse(c.createdAt) || 0;
      const p = (closedRows || []).find((r) => Number(r.programId) === 5062 && /sale complete/i.test(r.workorderStatusName || '') && Math.abs((Date.parse(r.createdAt) || 0) - ct) < 2 * DAY && belongs(c, r));
      if (p) out.push({ wo: String(c.workorderId), check: 'cleaning', kind: 'fail', rule: 'parent-closed-cleaning-open', sig: sigOf(p.workorderId), title: 'Parent closed, cleaning open', evidence: 'Parent ' + p.workorderId + ' is closed; this cleaning is still ' + (c.workorderStatusName || 'open'), who: UNASSIGNED,
        device: (c.deviceCatalog && c.deviceCatalog.name) || '', repair: c.programName || 'Cleaning', program: c.programName || '', status: c.workorderStatusName || '' });
    }
    return out;
  }

  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
  const ago = (ms) => (ms < DAY ? plural(Math.floor(ms / HOUR), 'hour') : plural(Math.floor(ms / DAY), 'day'));
  const label2 = (s) => s || 'Open';

  // ------------------------------------------------------------ rule graphs
  /*
    Rules as node graphs (rulegraph.js, passed in as RG; the Worker and the admin site import it, Aethernet has it
    inlined by build.py). The graphs read the same helpers the code does (GH), so a fact has one implementation.
    · Shadow mode (phase 1): the built-in graphs (src/assize-graphs/*.json, passed in as graphs) run next to the code
      rules, and shadow() reports every order where the two disagree. A built-in graph that doesn't validate is
      skipped (graphs.skipped). Rules with a graph published at the store are left out (except): that one runs.
    · Published graphs (phase 2): what the admin site published for the store (GET /v1/:store/assize/rules), compiled
      once per version by published() and run by withGraphs() in place of the code rule each stands for.
  */
  const GH = { MANUAL, CHECKLIST_LINE, LIQUID_RE, DATA_RE, AGREE_RE, CONTACT_RE, DOLLAR_RE, OVERRIDE_RE, EXPLAIN_RE, STORE, UNASSIGNED,
    programOf, deviceOf, sigOf, mentions, person, personById, intakeNote, intakeAuthor, statusEntry, statusSetBy, lastUser, lastUserEntry, createdByEntry, lastNote, firstNote, filterNotes, lines, price, isCredit, neverFlag, isDeposit, cartSum, cartSig, money };
  const graphs = { rules: [], skipped: [] };
  if (RG) {
    for (const [name, g] of Object.entries(builtIn || {})) {
      try { const c = RG.compile(g); if (c.errors.length) graphs.skipped.push({ rule: name, errors: c.errors }); else graphs.rules.push(c); }
      catch (e) { graphs.skipped.push({ rule: name, errors: [(e && e.message) || String(e)] }); }
    }
  }
  // One finding as a line, for comparing (and for the mismatch log).
  const brief = (x) => [x.kind, x.check, x.title, x.evidence, x.who && x.who.key, x.sig].join(' · ');
  /*
    shadow(row, detail, opts, code, except) → { compared, mismatches: [{ wo, rule, code, graph }], errors: [{ wo, rule, error }] }
    code: audit()'s findings for the same order (computed here when left out). Compared per rule: the same findings
    with the same kind, check, title, evidence, who and sig. except: rule ids to leave out (a Set).
  */
  function shadow(row, detail, opts = {}, code, except) {
    const res = { compared: 0, mismatches: [], errors: [] };
    if (!graphs.rules.length) return res;
    const f = facts(row, detail);
    if (!code) code = audit(row, detail, opts);
    const ctx = Object.assign(Object.create(GH), { f, opts });
    for (const c of graphs.rules) {
      if (except && except.has(c.rule)) continue;
      const r = RG.run(c, ctx, { trace: false });
      if (r.errors.length) { res.errors.push({ wo: f.id, rule: c.rule, error: r.errors.join('; ') }); continue; }
      const mine = r.findings.map((x) => brief(Object.assign({}, x, { who: x.who || UNASSIGNED, sig: sigOf(...x.sigBasis) }))).sort();
      const theirs = code.filter((x) => x.rule === c.rule).map(brief).sort();
      res.compared++;
      if (mine.join('\n') !== theirs.join('\n') || r.findings.some((x) => x.rule !== c.rule)) res.mismatches.push({ wo: f.id, rule: c.rule, code: theirs.join(' + ') || 'none', graph: mine.join(' + ') || 'none' });
    }
    return res;
  }

  /*
    checkGraph(graph, rule) → readable errors ([] = fine): what the admin site checks before publishing (and Assize
    before running) a graph as `rule`'s. RG.validate, plus: small enough (MAX_GRAPH_NODES nodes, macros included;
    MAX_GRAPH_BYTES as JSON), filed under its own rule id, every finding raising that rule (no other) in one of
    Assize's checks (the panel's sections).
  */
  function checkGraph(g, rule) {
    if (!g || typeof g !== 'object' || Array.isArray(g)) return ['The graph is not an object'];
    const errs = [], bytes = JSON.stringify(g).length;
    const count = (Array.isArray(g.nodes) ? g.nodes.length : 0) + Object.values(g.macros && typeof g.macros === 'object' ? g.macros : {}).reduce((n, m) => n + (m && Array.isArray(m.nodes) ? m.nodes.length : 0), 0);
    if (bytes > MAX_GRAPH_BYTES) errs.push('The graph is ' + Math.ceil(bytes / 1024) + ' KB; the most is ' + MAX_GRAPH_BYTES / 1024 + ' KB');
    if (count > MAX_GRAPH_NODES) errs.push('The graph has ' + count + ' nodes; the most is ' + MAX_GRAPH_NODES);
    if (errs.length) return errs;
    if (rule != null && g.rule !== rule) errs.push('The graph is for rule "' + g.rule + '", not "' + rule + '"');
    if (!ruleId(g.rule)) errs.push('Rule id "' + (g.rule || '') + '" must be lowercase letters, digits and dashes (60 at most)');
    if (!RG) return errs.concat(['No rule graph interpreter here']);
    errs.push(...RG.validate(g));
    const checks = CHECKS.map(([k]) => k);
    for (const n of Array.isArray(g.nodes) ? g.nodes : []) {
      if (!n || (n.type !== 'finding' && n.type !== 'reminder')) continue;
      const s = n.settings || {}, ck = n.type === 'reminder' ? s.check || 'remind' : s.check || g.check;
      if (s.rule && s.rule !== g.rule) errs.push(n.id + ': raises rule "' + s.rule + '"; a graph raises only its own rule (' + g.rule + ')');
      if (!checks.includes(ck)) errs.push(n.id + ': section "' + (ck || '') + '" is not one of ' + checks.join(', '));
    }
    return errs;
  }
  /*
    published({ rules: { rule: { graph, enabled, scope, version } } }) → { rules: Map(rule → { rule, enabled, scope,
    version, c }), skipped: [{ rule, errors }] }: the store's published set (the Worker's answer), compiled once. A
    graph that fails checkGraph is skipped (c null): its code rule stays. enabled false: the rule is off at this store.
  */
  function published(list) {
    const set = { rules: new Map(), skipped: [] };
    for (const [rule, x] of Object.entries((list && list.rules) || {})) {
      if (!x || typeof x !== 'object') continue;
      const one = { rule, enabled: x.enabled !== false, scope: x.scope == null ? null : String(x.scope), version: x.version == null ? null : x.version, c: null };
      if (x.graph) {
        let errors;
        try { errors = checkGraph(x.graph, rule); if (!errors.length) { const c = RG.compile(x.graph); errors = c.errors; if (!errors.length) one.c = c; } }
        catch (e) { errors = [(e && e.message) || String(e)]; }
        if (errors.length) set.skipped.push({ rule, errors });
      }
      set.rules.set(rule, one);
    }
    return set;
  }
  const isOff = (set, rule) => !!(set && set.rules.has(rule) && !set.rules.get(rule).enabled);
  // A graph's finding as Assize's (the same fields, in the same order, as audit()'s add()).
  const toFinding = (f, x) => ({ wo: f.id, check: x.check, kind: x.kind, rule: x.rule, sig: sigOf(...x.sigBasis), title: x.title, evidence: x.evidence, who: x.who || UNASSIGNED,
    device: f.device, repair: repairText(f), program: f.programName, status: f.status });
  /*
    withGraphs(row, detail, opts, set, code) → { findings, errors: [{ wo, rule, error }], ran: [rule ids run as graphs] }
    One order's findings with the store's published set (published()) applied, per rule id: off → nothing; a valid
    graph → its findings instead of the code's (same rule id and signature basis, so dismissals carry over); a
    graph-only rule → its findings added. A graph that errs on this order keeps the code's findings for that rule (if
    any) and is reported. A graph's findings for any other rule id are dropped. code: audit()'s findings for the
    order (computed when left out).
  */
  function withGraphs(row, detail, opts = {}, set, code) {
    if (!code) code = audit(row, detail, opts);
    const res = { findings: code, errors: [], ran: [] };
    if (!set || !set.rules.size) return res;
    const f = facts(row, detail), drop = new Set(), add = [];
    const ctx = Object.assign(Object.create(GH), { f, opts });
    for (const [rule, x] of set.rules) {
      if (!x.enabled) { drop.add(rule); continue; }
      if (!x.c || !f.id) continue;
      let r;
      try { r = RG.run(x.c, ctx, { trace: false }); } catch (e) { r = { errors: [(e && e.message) || String(e)], findings: [] }; }
      if (r.errors.length) { res.errors.push({ wo: f.id, rule, error: r.errors.join('; ') }); continue; }
      drop.add(rule); res.ran.push(rule);
      for (const y of r.findings) if (y.rule === rule) add.push(toFinding(f, y));
    }
    if (drop.size || add.length) res.findings = code.filter((y) => !drop.has(y.rule)).concat(add);
    return res;
  }
  // Every rule Assize's code raises, plus whether a built-in graph exists for it (the admin site's rule list).
  const catalog = CATALOG.map((x) => Object.assign({}, x, { builtInGraph: !!(builtIn && builtIn[x.rule]) }));

  // A finding's identity for dismissals: the order, the rule and the facts behind it.
  const dismissKey = (wo, rule, sig) => wo + '|' + rule + '|' + sig;
  const order = (x) => CHECKS.findIndex(([k]) => k === x.check) * 10 + KINDS.indexOf(x.kind);
  const sort = (list) => list.slice().sort((a, b) => order(a) - order(b) || String(a.wo).localeCompare(String(b.wo)));
  function summarize(list) {
    const n = { fail: 0, flag: 0, note: 0, remind: 0 };
    for (const x of list) n[x.kind]++;
    const worst = n.fail ? 'fail' : n.flag ? 'flag' : n.note ? 'note' : n.remind ? 'remind' : 'ok';
    return Object.assign(n, { worst, act: n.fail + n.flag });
  }
  return { STORE_HOURS, hoursFor, MORNING_ENDS, CHECKS, KINDS, programOf, deviceOf, nickDate, closeAfter, closeBefore, facts, audit, orphanCleanings, summarize, sort, sigOf, dismissKey, shadow, graphs, GH,
    catalog, checkGraph, published, withGraphs, isOff, trimRow, trimDetail, fromSnapshot, ruleId, RULE_RE, MAX_GRAPH_NODES, MAX_GRAPH_BYTES };
}
