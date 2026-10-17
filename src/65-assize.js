/*
  Assize (live work-order audit) — the [A] rules of the ubif-workorders audit (field checks), run
  over the store's open work orders, all day, in every tab.

  What it shows:
    · Header icon: fails + flags on the badge, colored by the worst (red fail, amber flag, grey when
      there are only "check notes", green ✓ when nothing needs doing). The panel under it: summary
      tiles, a chip per tech (plus Store), the findings grouped by check in the rules' order, then
      the Awaiting item reminders.
    · Work order page: an "N findings" pill after the title, for that order's findings.
    · Work orders list: a small Assize icon + count after the customer's name (left of Waymark's
      chips), nothing for reminder-only rows.
  Finding kinds: fail (red), flag (amber), check notes (grey: a note could explain it, so a person
  looks; never a fail) and reminder (blue: Awaiting item; never counted on the badge).
  Blame: the tech who wrote the note or took the action (the intake note's author for intake, cart,
  quote and partner-acceptance issues; whoever set the status for contact, age and reminders),
  "Store" for missed contacts and Need to order, "Unassigned" for bins and anything not logged per
  person. Names come from the notes' authors (UserDatum), shown as initials.

  Dismissing: a finding that doesn't apply can be dismissed for the whole store ("Dismiss" on its row,
  in the panel and the order's pill popover: a reason, an optional note). Every finding carries a stable
  `rule` id (kebab-case, e.g. missed-contact, no-bin) and a `sig`, a short hash of the facts it
  was raised on (the nickname's date, the cart's lines, the status and the date it began...), so a
  dismissal stops applying when those facts change. Dismissals live on the Waymark Worker
  (assize_dismissals, GET /assize/dismissed, POST /assize/dismiss and /assize/restore), are loaded with
  each scan and when the panel opens, and are applied outside the rules engine: a dismissed finding is
  left out of the badge, header color, tiles, chips, the order's pill and the list markers. The panel's
  "Dismissed (n)" lists them (who, when, why) with Restore, for whoever dismissed it or a manager.
  The Worker drops them 7 days after the order closes, and after 60 days.

  Read-only toward Portal: it never writes to Portal (the only POST is Portal's own work-order list
  read, through AE.data). The only things it sends to Aethernet's Workers are usage counts (AE.track)
  and dismissals / restores (through Waymark's call(), which checks the store first).

  Cost: Portal's open list once a pass (+1 page of closed orders, for 4b), then each in-scope open
  order's detail (GET /api/workorder/:id, /api/note?workorderId=… (30 a page), /api/workorder-audit-
  trail/:id and /api/get-cart/:csuCartId: 4 calls) only when its updatedAt changed since the last
  fetch, one after another 300 ms apart. One pass per 10 minutes, shared by every tab (a timestamp
  in GM storage, like Waymark's scan), plus the order being viewed (at most every 2 minutes). Rows
  and details are kept in GM storage per store, so every tab shows the same findings without
  fetching again; each tab re-runs the rules every minute so time-based ones (after close, today's
  contact dates, ages) stay current between passes.

  Rules engine: AE.assizeRules, pure functions (list row + detail + now + store hours + price
  lookup → findings), no DOM, no fetching, no AE helpers, so it also runs in Node for tests. It never
  knows about dismissals.

  Phone / TV / wearable / foldable: from the work order's catalog entry when its detail is loaded
  (DeviceModel.DeviceType.name: "Cell Phone", "Tablet", "Computer", "Game Console", "Wearable"...;
  DeviceFamily.name "Samsung Galaxy Fold" / "Samsung Galaxy Z Flip", the two Portal itself treats
  as foldables). Portal's list rows carry only the catalog name (deviceCatalog.name), so before the
  detail is in, and for types Portal has no name for (TVs), it's decided from the device name.
*/
AE.assizeRules = (() => {
  // Store hours for "after close" (TVs, buyouts) and "last business night" (Need to order). Local time.
  // One block, no settings yet: open 10:00–19:00, closed Thursday and Sunday (getDay(): 0 = Sunday, 4 = Thursday).
  const STORE_HOURS = { open: 10, close: 19, closedDays: [0, 4] };
  const MORNING_ENDS = 12; // the "morning audit" for Need to order: before 12:00 local
  const DAY = 86400000, HOUR = 3600000;

  // Checks, in the rules' order (section headings in the panel).
  const CHECKS = [
    ['intake', 'Intake note'], ['cart', 'Cart and price'], ['quote', 'Quote'], ['partner', 'Partner rules'],
    ['cleaning', 'Cleaning rate'], ['contact', 'Nickname and contact'], ['bin', 'Bin'], ['start', 'Start'],
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
    const notes = d && Array.isArray(d.notes) ? d.notes.slice().sort((a, b) => t(a) - t(b)) : null;
    return {
      id: String(w.workorderId || row.workorderId || ''),
      statusId: Number(w.workorderStatusId || row.workorderStatusId) || null,
      status: (w.WorkorderStatus && w.WorkorderStatus.name) || row.workorderStatusName || '',
      programId: w.programId != null ? w.programId : row.programId,
      programName: (w.Program && w.Program.name) || row.programName || '',
      device: cat.name || (row.deviceCatalog && row.deviceCatalog.name) || '',
      deviceType: (model.DeviceType && model.DeviceType.name) || row.deviceTypeName || (row.deviceType && row.deviceType.name) || '',
      deviceFamily: (model.DeviceFamily && model.DeviceFamily.name) || '',
      issues: issuesDetail.length ? issuesDetail : issuesRow,
      nickname: (d ? cd.name : null) ?? (row.customerDevice && row.customerDevice.name) ?? '',
      bin: d && w.WorkorderBinDeviceLocation !== undefined ? (binName || '') : (row.locationBin != null ? row.locationBin : binName || ''),
      createdAt: Date.parse(w.createdAt || row.createdAt) || null,
      updatedAt: Date.parse(w.updatedAt || row.updatedAt) || null,
      nextUpdate: Date.parse(w.nextUpdate || row.nextUpdate) || null,
      rfpAt: Date.parse(row.rfpWorkorderStatusDate) || null,
      outcome: outcomes.find((v) => ['Completed', 'Incomplete', 'Declined', 'No issue found'].includes(v)) || (row.serviceOutcome || ''),
      createdBy: row.createdBy && typeof row.createdBy === 'object' ? row.createdBy : null,
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
  const cartSum = (cart) => lines(cart).filter((l) => !neverFlag(l)).reduce((s, l) => s + price(l), 0);
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
      if (!intake) add('intake', 'note', 'No intake note', 'No check-in note found', who, 'no-intake-note');
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
    if (f.hasCart) {
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
            const charged = lines(cart).filter((l) => price(l) > 0 && !isCredit(l) && !neverFlag(l) && !/diagnostic|deposit/i.test(l.name || '')).reduce((s, l) => s + price(l), 0);
            if (charged > 0 && !sheet.some((p) => Math.abs(p - charged) <= 1.01)) {
              const near = sheet.slice().sort((a, b) => Math.abs(a - charged) - Math.abs(b - charged))[0];
              add('cart', 'note', 'Price off the sheet', 'Cart ' + money(charged) + '; Price sheet ' + money(near) + ' for ' + f.device + ' ' + repair.toLowerCase(), who, 'price-off-sheet', cartSig(cart), near);
            }
          }
        }
      } else if ((prog.key === 'asurion' && dev.phone) || prog.key === 'servify') {
        // Asurion phones, Servify, Samsung Care+: PCEXEMPT offsets are always applied, so the cart isn't checked (Oct 16, 2026).
      } else if (prog.key === 'asurion' && rfp && !/declined|incomplete/i.test(f.outcome)) {
        const ls = lines(cart);
        if (/no issue found/i.test(f.outcome)) {
          const labor = ls.filter((l) => !isCredit(l) && (l.lineType === 'labor' || /labor|asurion repair/i.test(l.name || '')));
          if (!labor.length) add('cart', 'fail', 'NTF, no labor line', 'Asurion non-phone, no issue found: the cart needs the labor line plus its offset', who, 'ntf-no-labor', cartSig(cart));
        } else if (!ls.some((l) => !isCredit(l) && !neverFlag(l) && l.lineType !== 'labor' && !/labor|diagnostic|asurion repair/i.test(l.name || ''))) {
          add('cart', 'fail', 'No part line', 'Asurion non-phone at Ready for pickup with no part in the cart', who, 'no-part-line', cartSig(cart));
        }
      } else if ((prog.key === 'samsungIW' || prog.key === 'google') && rfp) {
        if (!lines(cart).some((l) => !isCredit(l) && price(l) > 0)) add('cart', 'note', 'No priced lines', (prog.key === 'google' ? 'Google' : 'Samsung in-warranty') + ' at Ready for pickup with no priced line (GSPN payments don\'t show here)', who, 'no-priced-lines', cartSig(cart));
      } else if (prog.key === 'amazon') {
        const charged = lines(cart).filter((l) => !isCredit(l) && !neverFlag(l) && price(l) > 0.009);
        const total = cartTotal(cart);
        if (charged.length || total > 0.009) add('cart', 'fail', 'Buyout has charges', 'Amazon Buyout: ' + money(Math.max(total, charged.reduce((s, l) => s + price(l), 0))) + ' in the cart; buyouts have no repair lines or charge', who, 'buyout-has-charges', cartSig(cart));
      } else if (prog.key === 'cci' && rfp) {
        const sum = cartSum(cart);
        if (Math.abs(sum) <= 0.009) add('cart', 'note', 'CCI, $0 cart', 'Cart is $0; an incomplete service needs a reason', who, 'cci-zero-cart', cartSig(cart));
        else if (Math.abs(sum - 15) > 0.009) add('cart', 'fail', 'CCI not $15', 'Cart is ' + money(sum) + '; a CCI service is $15', who, 'cci-not-15', cartSig(cart));
      }
    }
    if (active && prog.key === 'oop' && f.notes && !DOLLAR_RE.test(noteText)) add('quote', 'note', 'No quote', 'OOP order; no dollar amount in any note', intakeAuthor(f), 'no-quote');

    // ---- 4 Partner rules (Active)
    if (active && prog.key !== 'oop') {
      const who = f.notes ? intakeAuthor(f) : person(f.createdBy) || UNASSIGNED;
      if (prog.key === 'unknown') add('partner', 'note', 'Unknown partner', prog.name + ': only the all-partner rules were checked', UNASSIGNED, 'unknown-partner', prog.name);
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
        if (now > by) add('start', 'fail', 'Not started', 'Still Ready for work; start by ' + clock(by) + (dayKey(by) === dayKey(now) ? '' : ' ' + md(by)) + ' (1 h before pickup)', UNASSIGNED, 'not-started', dayKey(f.createdAt), dayKey(f.nextUpdate));
      } else if (!dev.phone && now - f.createdAt >= 3 * DAY) {
        const later = manual.some((n) => n.noteTag !== 'initial_checkin');
        add('start', later ? 'note' : 'fail', 'Not started in 3 days', 'Still Ready for work ' + plural(Math.floor((now - f.createdAt) / DAY), 'day') + ' after check-in' + (later ? '; a note may say why' : ''), UNASSIGNED, 'not-started-3-days', dayKey(f.createdAt));
      }
    }

    // ---- 6 Age (Awaiting callback / device: 14 days or more)
    if (/awaiting (callback|device)/.test(st)) {
      const e = statusEntry(f);
      if (e.since) { const days = daysBetween(e.since, now); if (days >= 14) add('age', 'flag', 'Unresponsive', f.status + ' for ' + days + ' days. Decide what to do', e.who, 'unresponsive', statusTag(f.status), dayOf(e.since)); }
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
  return { STORE_HOURS, MORNING_ENDS, CHECKS, KINDS, programOf, deviceOf, nickDate, closeAfter, closeBefore, facts, audit, orphanCleanings, summarize, sort, sigOf, dismissKey };
})();

AE.crystal({
  id: 'assize',
  name: 'Assize',
  sites: ['portal.ubreakifix.net'],
  run() {
    const { h, esc } = AE, R = AE.assizeRules;
    const SCAN_MS = 10 * 60 * 1000, GAP_MS = 300, NOTE_PAGE = 30, NOTE_PAGES = 10, WO_MS = 2 * 60 * 1000;
    const PANEL_ID = 'ae-as-panel', PILL_ID = 'ae-as-pill', POP_ID = 'ae-as-pop', MK = 'ae-as-mk';
    const CHECK_NAME = Object.fromEntries(R.CHECKS);
    const orders = (n) => n + (n === 1 ? ' open order' : ' open orders');
    const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    // ------------------------------------------------------------ storage (per store, shared by tabs)
    let storeId = null;
    const key = (k) => 'ae_assize_' + k + '_' + storeId;
    const readRows = () => GM_getValue(key('rows'), null);     // { at, rows: [trimmed open rows], closed: [trimmed closed AM rows] }
    const readDetails = () => GM_getValue(key('details'), {}); // { woId: { u: list updatedAt, at: fetched, d: trimmed detail } }

    // Only what the rules read, so GM storage stays small (and no passcodes, phones or emails).
    const trimRow = (r) => ({
      workorderId: r.workorderId, workorderStatusId: r.workorderStatusId, workorderStatusName: r.workorderStatusName, programId: r.programId, programName: r.programName,
      createdAt: r.createdAt, updatedAt: r.updatedAt, nextUpdate: r.nextUpdate, rfpWorkorderStatusDate: r.rfpWorkorderStatusDate || null, locationBin: r.locationBin,
      deviceCatalog: { name: (r.deviceCatalog && r.deviceCatalog.name) || '' }, deviceIssues: r.deviceIssues || [], serviceOutcome: r.serviceOutcome || '',
      customerDevice: { name: (r.customerDevice && r.customerDevice.name) || '', imei: (r.customerDevice && r.customerDevice.imei) || '', customerId: (r.customerDevice && r.customerDevice.customerId) || '' },
      customer: { customerId: r.customer && (r.customer.customerId ?? r.customer.id), fullName: (r.customer && r.customer.fullName) || '' },
      createdBy: r.createdBy && typeof r.createdBy === 'object' ? { givenName: r.createdBy.givenName, familyName: r.createdBy.familyName } : null,
      deviceTypeName: r.deviceTypeName || (r.deviceType && r.deviceType.name) || undefined,
    });
    const user = (u) => (u ? { userId: u.userId, givenName: u.givenName, familyName: u.familyName } : null);
    function trimDetail(core, notes, audit, cart) {
      const w = (core && core.workorder) || {};
      const cd = w.CustomerDevice || {}, cat = cd.DeviceCatalog || {}, m = cat.DeviceModel || {};
      const bin = w.WorkorderBinDeviceLocation;
      return {
        wo: {
          workorderId: w.workorderId, workorderStatusId: w.workorderStatusId, WorkorderStatus: w.WorkorderStatus && { name: w.WorkorderStatus.name },
          programId: w.programId, Program: w.Program && { name: w.Program.name }, createdAt: w.createdAt, updatedAt: w.updatedAt, nextUpdate: w.nextUpdate, csuCartId: w.csuCartId,
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

    // ------------------------------------------------------------ Portal reads (GET only)
    async function notesOf(wo) {
      const all = [];
      for (let off = 0, i = 0; i < NOTE_PAGES; i++) {
        const p = await AE.api('GET', '/api/note?workorderId=' + wo + '&offset=' + off + '&limit=' + NOTE_PAGE);
        const rows = (p && p.notes) || [];
        all.push(...rows);
        const total = p && Number.isInteger(p.total) ? p.total : rows.length;
        off += rows.length;
        if (!rows.length || off >= total) break;
        await AE.sleep(GAP_MS);
      }
      return all;
    }
    async function detailOf(wo) {
      const core = await AE.api('GET', '/api/workorder/' + wo); await AE.sleep(GAP_MS);
      const w = (core && core.workorder) || {};
      const notes = await notesOf(wo); await AE.sleep(GAP_MS);
      const audit = await AE.api('GET', '/api/workorder-audit-trail/' + wo).catch(() => null);
      let cart = null;
      if (w.csuCartId) { await AE.sleep(GAP_MS); cart = await AE.api('GET', '/api/get-cart/' + w.csuCartId).catch(() => null); }
      if (w.storeId != null && storeId != null && Number(w.storeId) !== Number(storeId)) throw Object.assign(new Error("another store's work order"), { otherStore: true });
      return trimDetail(core, notes, audit, cart);
    }
    // Orders worth a detail fetch: open, in a status with rules, not a cleaning.
    const inScope = (r) => !/sale complete|cancel|repair summary|awaiting diag|partner approval/i.test(r.workorderStatusName || '') && R.programOf(r.programId, r.programName).key !== 'cleaning';

    // ------------------------------------------------------------ the pass
    let busy = false, lastError = null, progress = null;
    async function pass(force) {
      if (busy || AE.status.paused('assize')) return;
      const lock = key('scan_at');
      if (!force && Date.now() - GM_getValue(lock, 0) < SCAN_MS - 30000) return;
      GM_setValue(lock, Date.now());
      busy = true; render();
      loadDismissed(true);
      try {
        const y = new Date(); y.setDate(y.getDate() - 1); y.setHours(0, 0, 0, 0);
        const all = await AE.data.workorders(y.getTime(), 1); // every open order + one page of recent closed ones (4b)
        const closedRe = /sale complete|cancel/i;
        const open = all.filter((r) => !closedRe.test(r.workorderStatusName || '') && ![14, 15, 25].includes(Number(r.workorderStatusId)));
        const closed = all.filter((r) => Number(r.programId) === AE.PARENT_PROGRAM_ID && closedRe.test(r.workorderStatusName || ''));
        GM_setValue(key('rows'), { at: Date.now(), rows: open.map(trimRow), closed: closed.map(trimRow) });
        const details = readDetails(), keep = {};
        const want = open.filter(inScope);
        for (const r of want) if (details[r.workorderId]) keep[r.workorderId] = details[r.workorderId];
        GM_setValue(key('details'), keep);
        compute(); render();
        const stale = want.filter((r) => !keep[r.workorderId] || keep[r.workorderId].u !== r.updatedAt);
        progress = { done: 0, total: stale.length };
        let n = 0;
        for (const r of stale) {
          try {
            const d = await detailOf(r.workorderId);
            const cur = readDetails();
            cur[r.workorderId] = { u: r.updatedAt, at: Date.now(), d };
            GM_setValue(key('details'), cur);
          } catch (e) {
            if (/session expired/i.test(e.message || '') || e.storeChanged) throw e;
            if (!e.otherStore) AE.noteError('Assize detail ' + r.workorderId, e);
          }
          progress.done++;
          if (++n % 4 === 0) { compute(); render(); }
          await AE.sleep(GAP_MS);
        }
        lastError = null;
      } catch (e) {
        lastError = e.storeChanged ? null : (e.message || String(e));
        if (lastError) AE.noteError('Assize', e);
      } finally {
        busy = false; progress = null;
        compute(); render();
      }
    }
    // The order on screen: its own detail, fresh within 2 minutes.
    const woLoading = new Set();
    async function refreshWo(woId) {
      if (!storeId || woLoading.has(woId) || AE.status.paused('assize')) return;
      const cur = readDetails()[woId];
      if (cur && Date.now() - cur.at < WO_MS) return;
      const rows = readRows();
      const row = rows && rows.rows.find((r) => String(r.workorderId) === String(woId));
      if (rows && !row && rows.at > Date.now() - SCAN_MS && !cur) return; // not open (or not ours) at the last pass: nothing to check
      woLoading.add(woId);
      try {
        await AE.afterLoad();
        const d = await detailOf(woId);
        if (!inScope({ workorderStatusName: d.wo.WorkorderStatus && d.wo.WorkorderStatus.name, programId: d.wo.programId, programName: d.wo.Program && d.wo.Program.name })) return;
        const all = readDetails();
        all[woId] = { u: row ? row.updatedAt : d.wo.updatedAt, at: Date.now(), d };
        GM_setValue(key('details'), all);
        compute(); render();
      } catch (e) { if (!e.otherStore) AE.noteError('Assize WO ' + woId, e); }
      finally { woLoading.delete(woId); }
    }

    // ------------------------------------------------------------ dismissals (shared per store, on the Waymark Worker)
    let dismissed = [], dismissedAt = 0, me = null, isManager = false, showDismissed = false, actErr = null;
    let dp = null; // the open Dismiss form: { key, x, where: 'panel' | 'pop', reason, note, err, busy }
    const canDismiss = () => !!(storeId && AE.waymark && AE.waymark.configured() && !AE.status.blocked('waymark'));
    const REASONS = [['not-applicable', 'Not applicable'], ['handled', 'Already handled'], ['rule-doesnt-fit', "Rule doesn't fit"]];
    const REASON_NAME = Object.fromEntries(REASONS);
    async function loadDismissed(force) {
      if (!canDismiss() || (!force && Date.now() - dismissedAt < 30000)) return;
      try {
        const j = await AE.waymark.call('GET', '/assize/dismissed');
        dismissed = Array.isArray(j.dismissed) ? j.dismissed : [];
        dismissedAt = Date.now();
        compute(); render();
      } catch (e) { if (!e.storeChanged) AE.noteError('Assize dismissals', e); }
    }
    async function submitDismiss() {
      if (!dp || !dp.reason || dp.busy) return;
      const f = dp, x = f.x;
      f.busy = true; f.err = null; render();
      try {
        await AE.waymark.call('POST', '/assize/dismiss', { wo: Number(x.wo), rule: x.rule, sig: x.sig, reason: f.reason, note: f.note.trim() });
        AE.track('assize:dismiss');
        if (dp === f) dp = null;
        await loadDismissed(true);
      } catch (e) {
        f.busy = false; f.err = e.storeChanged ? 'Portal switched stores, so nothing was saved.' : "Couldn't dismiss this just now."; f.errRaw = e.message || String(e);
        if (!e.storeChanged) AE.noteError('Assize dismiss', e);
        render();
      }
    }
    async function restore(d) {
      actErr = null;
      try {
        await AE.waymark.call('POST', '/assize/restore', { wo: Number(d.wo), rule: d.rule, sig: d.sig });
        AE.track('assize:restore');
        await loadDismissed(true);
      } catch (e) { actErr = { text: e.storeChanged ? 'Portal switched stores, so nothing was changed.' : "Couldn't restore this just now.", raw: e.message || String(e) }; if (!e.storeChanged) AE.noteError('Assize restore', e); render(); }
    }
    // Restore: whoever dismissed it, or a manager (Waymark's role check).
    const canRestore = (d) => isManager || (d.byId != null && me && Number(d.byId) === Number(me.userId));

    // ------------------------------------------------------------ findings
    let result = null; // { at, open, findings, byWo, sum }
    let sheet = null;
    const priceFor = (device, repair) => {
      if (!sheet || !sheet.data || !AE.priceSheet) return null;
      const r = AE.priceSheet.repairPrices(device, repair, sheet.data);
      return r.rows ? r.prices.map((p) => p.price) : null;
    };
    function compute() {
      const rows = storeId && readRows();
      if (!rows) { result = null; return; }
      const details = readDetails(), now = AE.now();
      const seen = new Set(rows.rows.map((r) => String(r.workorderId)));
      let list = [];
      for (const r of rows.rows) list.push(...R.audit(r, details[r.workorderId] ? details[r.workorderId].d : null, { now, hours: R.STORE_HOURS, priceFor }));
      // An order fetched on its own page that wasn't open at the last pass (new since)
      for (const [id, x] of Object.entries(details)) if (!seen.has(String(id))) list.push(...R.audit(null, x.d, { now, hours: R.STORE_HOURS, priceFor }));
      list.push(...R.orphanCleanings(rows.rows, rows.closed || [], AE.data.belongs));
      list = R.sort(list);
      // Dismissed for the store (the rules stay pure; this is where a dismissal applies): out of every count, chip, pill and marker.
      const dm = new Map(dismissed.map((d) => [R.dismissKey(String(d.wo), d.rule, d.sig), d]));
      const gone = [];
      list = list.filter((x) => { const d = dm.get(R.dismissKey(x.wo, x.rule, x.sig)); if (d) gone.push({ x, d }); return !d; });
      const byWo = new Map();
      for (const x of list) { if (!byWo.has(x.wo)) byWo.set(x.wo, []); byWo.get(x.wo).push(x); }
      result = { at: rows.at, open: rows.rows.length, findings: list, byWo, sum: R.summarize(list), dismissed: gone };
    }

    // ------------------------------------------------------------ styles
    document.head.append(h('style', null, `
      .ae-as { --as-fail:var(--aui-status-error,#b91a24); --as-fail-soft:var(--aui-status-error-soft,#ffdad7); --as-fail-on:var(--aui-status-on-error-soft,#410004);
        --as-flag:#a86400; --as-flag-bar:var(--aui-status-warning,#e0a23a); --as-flag-soft:var(--aui-status-warning-soft,#fff0c0); --as-flag-on:var(--aui-status-on-warning-soft,#3a3000);
        --as-note-bar:#9a9aa0; --as-note-soft:var(--aui-neutral-soft,#f1f0f4); --as-note-on:var(--aui-on-surface,#1a1c1e);
        --as-rem:#1f5fbf; --as-rem-soft:#dce9ff; --as-rem-on:#0a2a5c; }
      body.asurion-dark .ae-as { --as-flag:#e0a23a; --as-rem:#7ab0ff; --as-rem-soft:#16335c; --as-rem-on:#d3e5ff; }
      #${PANEL_ID} { position:fixed; z-index:2147483646; width:min(540px, calc(100vw - 16px)); max-height:calc(100vh - 90px); display:flex; flex-direction:column; padding:16px 16px 12px; font-size:14px; line-height:1.4; }
      @media (prefers-reduced-motion: no-preference) { #${PANEL_ID}, #${POP_ID} { animation:sg-in .15s ease-out; } }
      #${PANEL_ID} .hd, #${POP_ID} .hd { display:flex; align-items:center; gap:10px; }
      #${PANEL_ID} .hd b, #${POP_ID} .hd b { font-size:16px; flex:1; }
      #${PANEL_ID} .sum { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin:12px 0 10px; }
      .ae-as-tile { border-radius:12px; padding:8px 10px; display:flex; flex-direction:column; }
      .ae-as-tile .n { font-size:24px; font-weight:700; line-height:1.1; font-variant-numeric:tabular-nums; } .ae-as-tile .l { font-size:12px; }
      .ae-as-tile.fail { background:var(--as-fail-soft); color:var(--as-fail-on); } .ae-as-tile.flag { background:var(--as-flag-soft); color:var(--as-flag-on); }
      .ae-as-tile.note { background:var(--as-note-soft); color:var(--as-note-on); } .ae-as-tile.remind { background:var(--as-rem-soft); color:var(--as-rem-on); }
      .ae-as-tile.zero { opacity:.55; }
      #${PANEL_ID} .flt { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px; }
      .ae-as-f { display:inline-flex; align-items:center; gap:5px; height:26px; padding:0 11px; border-radius:10000rem; border:1px solid var(--aui-outline,#c6c6ca); cursor:pointer;
        font:400 13px/1 Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; background:transparent; color:var(--aui-on-surface,#1a1c1e); }
      .ae-as-f i { font-style:normal; font-size:11px; color:var(--aui-on-surface-soft,#5d5e61); }
      .ae-as-f.on { border:2px solid var(--aui-primary,#8223d2); padding:0 10px; color:var(--aui-primary,#8223d2); font-weight:700; background:var(--aui-primary-soft,#faecff); }
      .ae-as-f.on i { color:inherit; }
      .ae-as-f:focus-visible { outline:2px solid var(--aui-primary,#8223d2); outline-offset:1px; }
      #${PANEL_ID} .list { overflow:auto; margin:0 -4px; padding:0 4px; min-height:0; }
      .ae-as-g { margin:10px 0 2px; font-size:11px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; color:var(--aui-on-surface-soft,#5d5e61); }
      .ae-as-g:first-child { margin-top:2px; }
      .ae-as-r { display:grid; grid-template-columns:4px 1fr auto; gap:0 10px; padding:7px 2px 7px 0; border-top:1px solid var(--aui-outline-soft,#eeedf1); }
      .ae-as-g + .ae-as-r { border-top:0; }
      .ae-as-r .bar { border-radius:2px; grid-row:1/3; }
      .ae-as-r.fail .bar { background:var(--as-fail); } .ae-as-r.flag .bar { background:var(--as-flag-bar); } .ae-as-r.note .bar { background:var(--as-note-bar); } .ae-as-r.remind .bar { background:var(--as-rem); }
      .ae-as-r .t { display:flex; align-items:baseline; gap:6px; min-width:0; white-space:nowrap; }
      .ae-as-r .k { font-weight:700; font-size:13px; } .ae-as-r.fail .k { color:var(--as-fail); } .ae-as-r.flag .k { color:var(--as-flag); } .ae-as-r.remind .k { color:var(--as-rem); }
      .ae-as-r a { color:var(--aui-primary,#8223d2); font-weight:600; text-decoration:none; } .ae-as-r a:hover { text-decoration:underline; }
      .ae-as-r .dv { color:var(--aui-on-surface-soft,#5d5e61); font-size:13px; overflow:hidden; text-overflow:ellipsis; }
      .ae-as-r .ev { font-size:13px; grid-column:2; }
      .ae-as-r .who { grid-row:1/3; grid-column:3; align-self:center; }
      .ae-as-who { display:inline-flex; align-items:center; justify-content:center; min-width:34px; height:22px; padding:0 8px; border-radius:10000rem; box-sizing:border-box;
        font:700 12px/1 Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; background:var(--aui-neutral-soft,#f1f0f4); color:var(--aui-on-surface,#1a1c1e); }
      .ae-as-who.store { background:var(--aui-primary-soft,#faecff); color:var(--aui-on-primary-soft,#590099); }
      .ae-as-who.unassigned { background:transparent; border:1px dashed var(--aui-outline,#c6c6ca); color:var(--aui-on-surface-soft,#5d5e61); font-weight:400; }
      #${PANEL_ID} .ft, #${POP_ID} .ft { margin-top:8px; padding-top:8px; border-top:1px solid var(--aui-outline-soft,#eeedf1); display:flex; gap:8px; align-items:center; }
      #${PANEL_ID} .ft .sg-soft, #${POP_ID} .ft .sg-soft { flex:1; }
      .ae-as-empty { text-align:center; padding:22px 10px 16px; } .ae-as-empty h3 { margin:10px 0 2px; font-size:18px; } .ae-as-empty p { margin:0; }
      .ae-as-r .dm { margin-left:auto; flex:none; border:0; background:transparent; padding:0 4px; height:20px; border-radius:6px; cursor:pointer; opacity:0;
        font:400 12px/1 Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; color:var(--aui-on-surface-soft,#5d5e61); text-decoration:underline; }
      .ae-as-r:hover .dm, .ae-as-r:focus-within .dm, .ae-as-r .dm[aria-expanded="true"] { opacity:1; }
      @media (hover:none) { .ae-as-r .dm { opacity:1; } }
      .ae-as-r .dm:hover { color:var(--aui-on-surface,#1a1c1e); } .ae-as-r .dm:focus-visible { outline:2px solid var(--aui-primary,#8223d2); outline-offset:1px; }
      .ae-as-dp { grid-column:2 / 4; margin:6px 0 2px; padding:8px 10px 10px; border-radius:12px; background:var(--aui-neutral-soft,#f1f0f4); display:flex; flex-direction:column; gap:8px; }
      .ae-as-dp .q { font-size:12px; font-weight:700; color:var(--aui-on-surface-soft,#5d5e61); }
      .ae-as-dp .dpc { display:flex; flex-wrap:wrap; gap:6px; }
      .ae-as-dp input { box-sizing:border-box; width:100%; height:30px; padding:0 10px; border-radius:8px; border:1px solid var(--aui-outline,#c6c6ca); background:var(--aui-surface,#fff); color:inherit; font:400 13px/1 Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; }
      .ae-as-dp input:focus-visible { outline:2px solid var(--aui-primary,#8223d2); outline-offset:1px; }
      .ae-as-dp .act { display:flex; gap:8px; justify-content:flex-end; }
      .ae-as-dp .ae-as-err { margin:0; }
      .ae-as-r.dis .bar { opacity:.5; } .ae-as-r.dis .k { text-decoration:line-through; color:var(--aui-on-surface-soft,#5d5e61); }
      .ae-as-r.dis .who { display:flex; }
      .ae-as-err { margin:8px 0; color:var(--as-fail); font-size:13px; } .ae-as-err a { color:inherit; font-weight:700; }
      #${PILL_ID} { display:inline-flex; align-items:center; gap:6px; height:28px; margin-left:8px; padding:0 12px 0 5px; border-radius:10000rem; border:1px solid transparent; cursor:pointer;
        font:600 14px/1 Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; white-space:nowrap; flex:none; align-self:center; }
      #${PILL_ID} .sg-aicon { width:20px; height:20px; border-radius:50%; }
      #${PILL_ID}.fail { background:var(--as-fail-soft); color:var(--as-fail-on); } #${PILL_ID}.flag { background:var(--as-flag-soft); color:var(--as-flag-on); }
      #${PILL_ID}.note { background:transparent; border-color:var(--aui-outline,#c6c6ca); color:var(--aui-on-surface-soft,#5d5e61); }
      #${POP_ID} { position:fixed; z-index:2147483646; width:min(430px, calc(100vw - 16px)); padding:14px 16px 12px; font-size:14px; line-height:1.4; }
      #${POP_ID} .hd { margin-bottom:4px; }
      .${MK} { display:inline-flex; align-items:center; gap:3px; height:18px; padding:0 6px 0 2px; border-radius:10000rem; flex:none; white-space:nowrap; vertical-align:middle; cursor:pointer;
        font:700 11px/1 Apercu, "Helvetica Neue", Arial, sans-serif; border:0; }
      .${MK} .sg-aicon { width:14px; height:14px; border-radius:50%; box-shadow:none; }
      .${MK}.fail { background:var(--as-fail-soft); color:var(--as-fail-on); } .${MK}.flag { background:var(--as-flag-soft); color:var(--as-flag-on); }
      .${MK}.note { background:var(--aui-neutral-soft,#f1f0f4); color:var(--aui-on-surface,#1a1c1e); box-shadow:inset 0 0 0 1px var(--aui-outline,#c6c6ca); }
      .ae-as-wrap { display:flex !important; align-items:center; gap:6px; min-width:0; flex-wrap:nowrap; }
      .ae-as-wrap > a { min-width:0; overflow:hidden; }
    `));

    // ------------------------------------------------------------ pieces
    const whoChip = (w) => h('span', { class: 'ae-as-who ' + (w.key === 'store' || w.key === 'unassigned' ? w.key : ''), title: w.name }, w.label);
    // The Dismiss form under a finding: why (three chips), an optional note, Dismiss / Cancel.
    function dismissForm() {
      const f = dp;
      const chips = h('div', { class: 'dpc', role: 'radiogroup', 'aria-label': 'Why does this not apply?' }, ...REASONS.map(([k, label]) =>
        h('button', { type: 'button', role: 'radio', 'aria-checked': String(f.reason === k), class: 'ae-as-f' + (f.reason === k ? ' on' : ''), 'data-fk': 'dr:' + k,
          onclick: (e) => { e.stopPropagation(); f.reason = k; f.err = null; render(); } }, label)));
      const note = h('input', { type: 'text', maxlength: '200', placeholder: 'Note (optional)', 'aria-label': 'Note (optional)', 'data-fk': 'dn', value: f.note,
        oninput: (e) => { f.note = e.target.value; },
        onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); submitDismiss(); } else if (e.key === 'Escape') { e.stopPropagation(); dp = null; render(); } } });
      return h('div', { class: 'ae-as-dp', role: 'group', 'aria-label': 'Dismiss this finding' },
        h('span', { class: 'q' }, "Why doesn't this apply?"), chips, note,
        f.err ? h('div', { class: 'ae-as-err' }, f.err + ' Try again, and if it keeps happening, ', AE.bugLinkEl('report a bug', { where: 'Assize dismiss', error: f.errRaw })) : null,
        h('div', { class: 'act' },
          h('button', { type: 'button', class: 'sg-btn', 'data-fk': 'dc', onclick: (e) => { e.stopPropagation(); dp = null; render(); } }, 'Cancel'),
          h('button', { type: 'button', class: 'sg-btn sg-primary', 'data-fk': 'dd', disabled: !f.reason || f.busy || null, title: f.reason ? null : 'Pick a reason first', onclick: (e) => { e.stopPropagation(); submitDismiss(); } }, f.busy ? 'Dismissing…' : 'Dismiss')));
    }
    function rowEl(x, here) {
      const key = R.dismissKey(x.wo, x.rule, x.sig), open = !!dp && dp.key === key && dp.where === (here ? 'pop' : 'panel');
      const dm = canDismiss() ? h('button', { type: 'button', class: 'dm', 'data-fk': 'dm:' + key, 'aria-expanded': String(open), title: "Dismiss: this doesn't apply",
        onclick: (e) => { e.stopPropagation(); dp = open ? null : { key, x, where: here ? 'pop' : 'panel', reason: null, note: '', err: null, busy: false }; actErr = null; render(); } }, 'Dismiss') : null;
      return h('div', { class: 'ae-as-r ' + x.kind },
        h('span', { class: 'bar' }),
        h('div', { class: 't' }, h('span', { class: 'k' }, x.title),
          here ? h('span', { class: 'dv' }, CHECK_NAME[x.check]) : h('a', { href: '/repair/workorder/' + x.wo }, x.wo),
          here ? null : h('span', { class: 'dv' }, [x.device, x.repair].filter(Boolean).join(' · ')), dm),
        h('div', { class: 'ev' }, x.evidence),
        h('div', { class: 'who' }, whoChip(x.who)),
        open ? dismissForm() : null);
    }
    const whenShort = (iso) => { const ms = Date.parse(iso); if (!ms) return ''; return new Date(ms).toDateString() === new Date(AE.now()).toDateString() ? 'today ' + fmtTime(ms) : new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' }); };
    // A dismissed finding, in the Dismissed list.
    function dismissedRow({ x, d }) {
      const note = [d.by || 'Someone', whenShort(d.at), REASON_NAME[d.reason] || d.reason].filter(Boolean).join(' · ') + (d.note ? '. Note: ' + d.note : '');
      return h('div', { class: 'ae-as-r dis ' + x.kind },
        h('span', { class: 'bar' }),
        h('div', { class: 't' }, h('span', { class: 'k' }, x.title), h('a', { href: '/repair/workorder/' + x.wo }, x.wo), h('span', { class: 'dv' }, [x.device, x.repair].filter(Boolean).join(' · '))),
        h('div', { class: 'ev' }, note),
        h('div', { class: 'who' }, canRestore(d)
          ? h('button', { type: 'button', class: 'sg-btn', 'data-fk': 'rs:' + R.dismissKey(x.wo, x.rule, x.sig), title: 'Bring this finding back', onclick: (e) => { e.stopPropagation(); restore(d); } }, 'Restore')
          : h('span', { class: 'sg-soft', title: 'Only ' + (d.by || 'the person who dismissed it') + ' or a manager can restore this' }, '')));
    }
    // Rebuilding the panel on a timer mustn't drop the keyboard: put focus back on the same control.
    function keepFocus(fn) {
      const a = document.activeElement, fk = a && a.dataset && a.dataset.fk, pos = a && a.selectionStart;
      fn();
      if (!fk) return;
      const el = [...document.querySelectorAll('[data-fk]')].find((n) => n.dataset.fk === fk && n.closest('#' + PANEL_ID + ', #' + POP_ID));
      if (el) { el.focus({ preventScroll: true }); if (pos != null && el.setSelectionRange) try { el.setSelectionRange(pos, pos); } catch (_) { /* not a text field */ } }
    }
    const actErrLine = () => (actErr ? h('div', { class: 'ae-as-err' }, actErr.text + ' Try again, and if it keeps happening, ', AE.bugLinkEl('report a bug', { where: 'Assize', error: actErr.raw })) : null);
    const kindWords = (s) => [s.fail && s.fail + (s.fail === 1 ? ' fail' : ' fails'), s.flag && s.flag + (s.flag === 1 ? ' flag' : ' flags'), s.note && s.note + ' to check in notes'].filter(Boolean).join(', ');
    const errLine = (prefix) => h('div', { class: 'ae-as-err' }, prefix + ' Try again, and if it keeps happening, ', AE.bugLinkEl('report a bug', { where: 'Assize', error: lastError }));

    // ------------------------------------------------------------ header icon
    let icon = null;
    function renderIcon() {
      icon = icon || AE.headerIcon({ id: 'assize', icon: 'assize', order: 5, label: 'Assize', onClick: (e) => togglePanel(e) });
      const s = result && result.sum;
      if (!s) {
        icon.update({ label: lastError ? "Assize couldn't check orders" : 'Assize', detail: lastError ? 'click for details' : 'Checking orders…', badge: lastError ? '?' : '', count: 0, severity: lastError ? 'red' : 'grey', busy });
        return;
      }
      const sev = s.fail ? 'red' : s.flag ? 'amber' : s.note ? 'grey' : 'green';
      icon.update({
        label: lastError && !busy ? "Assize couldn't check orders" : 'Assize' + (s.act || s.note ? ': ' + kindWords(s) : ': nothing to act on'),
        detail: (lastError ? 'last check failed · ' : '') + 'updated ' + fmtTime(result.at) + ' · click for details',
        badge: s.act ? s.act : s.note ? s.note : '✓', count: s.act, severity: sev, busy,
      });
    }

    // ------------------------------------------------------------ panel
    let filter = 'all';
    function renderPanel() { keepFocus(drawPanel); }
    function drawPanel() {
      const p = document.getElementById(PANEL_ID);
      if (!p) return;
      const box = AE.headerIconBox('assize'), r = box && box.rect;
      const w = Math.min(540, innerWidth - 16);
      if (r && !box.floating) { p.style.top = (r.bottom + 8) + 'px'; p.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px'; p.style.bottom = ''; }
      else { p.style.left = '16px'; p.style.bottom = '60px'; p.style.top = ''; }
      const scroll = p.querySelector('.list') ? p.querySelector('.list').scrollTop : 0;
      const close = h('button', { type: 'button', class: 'sg-x', title: 'Close', 'aria-label': 'Close', onclick: () => p.remove() }, '✕');
      const sub = result ? 'Checked ' + fmtTime(result.at) + ' · ' + orders(result.open) : '';
      const head = h('div', { class: 'hd' }, h('span', { html: AE.actionIcon('assize', 26), style: 'line-height:0' }), h('b', null, 'Assize'), h('span', { class: 'sg-soft' }, busy ? (progress && progress.total ? 'Checking orders… ' + progress.done + '/' + progress.total : 'Checking orders…') : sub), close);
      const refresh = h('button', { type: 'button', class: 'sg-btn', disabled: busy || null, onclick: (e) => { e.stopPropagation(); AE.track('assize:refresh'); pass(true); } }, 'Refresh');
      const nGone = result ? result.dismissed.length : 0;
      const toggle = canDismiss() ? h('button', { type: 'button', class: 'sg-btn', 'aria-pressed': String(showDismissed), 'data-fk': 'dt', title: 'Findings dismissed as not applying, for this store',
        onclick: (e) => { e.stopPropagation(); showDismissed = !showDismissed; actErr = null; dp = null; if (showDismissed) loadDismissed(true); renderPanel(); } }, showDismissed ? 'Back to findings' : 'Dismissed (' + nGone + ')') : null;
      const foot = h('div', { class: 'ft' }, h('span', { class: 'sg-soft' }, showDismissed ? 'Dismissed for everyone at this store.' : 'Check notes need a person. A note may explain it.'), toggle, refresh);
      if (!result) { p.replaceChildren(head, lastError ? errLine("Couldn't check orders just now.") : h('p', { class: 'sg-soft' }, 'Checking orders…'), foot); return; }
      const s = result.sum, all = result.findings;
      const tile = (k, name) => h('div', { class: 'ae-as-tile ' + k + (s[k] ? '' : ' zero') }, h('span', { class: 'n' }, String(s[k])), h('span', { class: 'l' }, name));
      const tiles = h('div', { class: 'sum' }, tile('fail', 'Fails'), tile('flag', 'Flags'), tile('note', 'Check notes'), tile('remind', 'Reminders'));
      const kids = [head, tiles];
      if (lastError) kids.push(errLine("Couldn't check orders just now."));
      if (showDismissed && canDismiss()) {
        const dl = h('div', { class: 'list' }, ...(result.dismissed.length
          ? [h('p', { class: 'sg-soft', style: 'margin:4px 0 0' }, 'A dismissal ends on its own if the facts behind it change.'), ...result.dismissed.map(dismissedRow)]
          : [h('p', { class: 'sg-soft' }, 'Nothing dismissed right now.')]));
        const ae = actErrLine();
        kids.push(...(ae ? [ae] : []), dl, foot);
        p.replaceChildren(...kids);
        return;
      }
      if (!all.length) {
        kids.push(h('div', { class: 'ae-as-empty' }, h('span', { html: AE.actionIcon('assize', 48) }), h('h3', null, 'Nothing to act on'),
          h('p', { class: 'sg-soft' }, (result.open === 1 ? 'The 1 open order passes' : 'All ' + orders(result.open) + ' pass') + ' the live checks.')), foot);
        p.replaceChildren(...kids);
        return;
      }
      // Filter chips: Everyone, each tech (initials, busiest first), Store. Counts leave reminders out.
      const counted = all.filter((x) => x.kind !== 'remind');
      const techs = new Map();
      for (const x of counted) if (x.who.key.startsWith('u:')) { const c = techs.get(x.who.key) || { who: x.who, n: 0 }; c.n++; techs.set(x.who.key, c); }
      const chips = [['all', 'Everyone', counted.length, 'Everyone']].concat([...techs.values()].sort((a, b) => b.n - a.n).map((c) => [c.who.key, c.who.label, c.n, c.who.name]));
      const storeN = counted.filter((x) => x.who.key === 'store').length, unN = counted.filter((x) => x.who.key === 'unassigned').length;
      if (storeN) chips.push(['store', 'Store', storeN, 'Store']);
      if (unN) chips.push(['unassigned', 'Unassigned', unN, 'Unassigned']);
      if (!chips.some(([k]) => k === filter)) filter = 'all';
      const flt = h('div', { class: 'flt', role: 'group', 'aria-label': 'Filter by tech' }, ...chips.map(([k, label, n, title]) =>
        h('button', { type: 'button', class: 'ae-as-f' + (filter === k ? ' on' : ''), title, 'aria-pressed': String(filter === k), onclick: (e) => { e.stopPropagation(); filter = k; renderPanel(); } }, label, h('i', null, String(n)))));
      const shown = filter === 'all' ? all : all.filter((x) => x.who.key === filter);
      const list = h('div', { class: 'list' });
      for (const [k, name] of R.CHECKS) {
        const rows = shown.filter((x) => x.check === k);
        if (!rows.length) continue;
        list.append(h('div', { class: 'ae-as-g' }, name), ...rows.map((x) => rowEl(x)));
      }
      if (!list.childNodes.length) list.append(h('p', { class: 'sg-soft' }, 'Nothing for ' + (chips.find(([k]) => k === filter) || [, ''])[3] + '.'));
      kids.push(flt, list, foot);
      p.replaceChildren(...kids);
      list.scrollTop = scroll;
    }
    function togglePanel(e) {
      e && e.stopPropagation();
      const p = document.getElementById(PANEL_ID);
      if (p) { p.remove(); return; }
      document.body.append(h('div', { id: PANEL_ID, class: 'sg sg-card ae-as', role: 'dialog', 'aria-label': 'Assize' }));
      renderPanel();
      AE.track('assize:open');
      loadDismissed(false);
      if (!busy && (!result || Date.now() - result.at > SCAN_MS)) pass(true);
    }

    // ------------------------------------------------------------ WO page pill
    const currentWoId = () => { const m = location.pathname.match(/^\/repair\/workorder\/(\d+)/); return m ? m[1] : null; };
    const worstOf = (list) => (list.some((x) => x.kind === 'fail') ? 'fail' : list.some((x) => x.kind === 'flag') ? 'flag' : 'note');
    function renderPill() {
      const woId = currentWoId();
      const list = woId && result ? (result.byWo.get(woId) || []).filter((x) => x.kind !== 'remind') : [];
      const heading = woId && AE.woHeading(woId), row = heading && heading.parentElement;
      let pill = document.getElementById(PILL_ID);
      if (!list.length || !row) { pill?.remove(); document.getElementById(POP_ID)?.remove(); return; }
      const sev = worstOf(list), text = list.length === 1 ? '1 finding' : list.length + ' findings';
      const sig = woId + '|' + sev + '|' + text;
      if (!pill) pill = h('button', { id: PILL_ID, type: 'button', class: 'sg ae-as', onclick: (e) => togglePop(e) });
      if (pill.dataset.sig !== sig) {
        pill.dataset.sig = sig;
        pill.className = 'sg ae-as ' + sev;
        pill.title = 'Assize: ' + text + ' on this order';
        pill.innerHTML = AE.actionIcon('assize', 20) + esc(text);
      }
      if (pill.parentElement !== row) row.appendChild(pill);
      if (document.getElementById(POP_ID)) renderPop();
    }
    function renderPop() { keepFocus(drawPop); }
    function drawPop() {
      const pill = document.getElementById(PILL_ID), woId = currentWoId();
      let pop = document.getElementById(POP_ID);
      if (!pill || !woId) { pop?.remove(); return; }
      const order = { fail: 0, flag: 1, note: 2 };
      const list = (result.byWo.get(woId) || []).filter((x) => x.kind !== 'remind').sort((a, b) => order[a.kind] - order[b.kind]);
      if (!pop) { pop = h('div', { id: POP_ID, class: 'sg sg-card ae-as', role: 'dialog', 'aria-label': 'Assize, this order' }); document.body.append(pop); }
      const r = pill.getBoundingClientRect();
      pop.style.top = (r.bottom + 8) + 'px';
      pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)) + 'px';
      pop.replaceChildren(
        h('div', { class: 'hd' }, h('span', { html: AE.actionIcon('assize', 22), style: 'line-height:0' }), h('b', null, 'Assize · this order'),
          h('button', { type: 'button', class: 'sg-x', title: 'Close', 'aria-label': 'Close', onclick: () => pop.remove() }, '✕')),
        ...list.map((x) => rowEl(x, true)),
        h('div', { class: 'ft' }, h('span', { class: 'sg-soft' }, 'Check notes need a person. A note may explain it.')));
      pop.style.left = Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)) + 'px';
    }
    function togglePop(e) {
      e.stopPropagation();
      const pop = document.getElementById(POP_ID);
      if (pop) pop.remove(); else { renderPop(); AE.track('assize:wo'); }
    }
    document.addEventListener('click', (e) => {
      const path = e.composedPath();
      for (const [id, owner] of [[PANEL_ID, icon && icon.el], [POP_ID, document.getElementById(PILL_ID)]]) {
        const el = document.getElementById(id);
        if (el && !path.includes(el) && !(owner && path.includes(owner)) && !(id === PANEL_ID && path.some((n) => n && n.id === 'ae-hdr-menu'))) el.remove();
      }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { document.getElementById(PANEL_ID)?.remove(); document.getElementById(POP_ID)?.remove(); } });

    // ------------------------------------------------------------ Work orders list markers
    const onList = () => /^\/repair\/workorders\/?$/.test(location.pathname);
    function custIndex(table) {
      const head = table && table.querySelector('thead tr');
      return head ? [...head.children].findIndex((c) => c.textContent.trim().toLowerCase() === 'customer') : -1;
    }
    function renderList() {
      if (!onList() || !result) { document.querySelectorAll('.' + MK).forEach((m) => { m.parentElement?.classList.remove('ae-as-wrap'); m.remove(); }); return; }
      const idx = new Map();
      for (const tr of document.querySelectorAll('tbody tr')) {
        const a = tr.querySelector('a[href*="/repair/workorder/"]');
        const m = a && a.getAttribute('href').match(/\/repair\/workorder\/(\d+)/);
        if (!m) continue;
        const table = tr.closest('table');
        if (!idx.has(table)) idx.set(table, custIndex(table));
        const cell = tr.children[idx.get(table)];
        const link = cell && cell.querySelector('a[href*="/repair/workorder/"]');
        const wrap = link && link.parentElement;
        if (!wrap) continue;
        const list = (result.byWo.get(m[1]) || []).filter((x) => x.kind !== 'remind');
        const sev = list.length ? worstOf(list) : '';
        let mk = wrap.querySelector(':scope > .' + MK);
        const sig = m[1] + '|' + sev + '|' + list.length;
        if (mk && mk.dataset.sig === sig && mk.previousElementSibling === link) continue;
        mk?.remove();
        if (!list.length) continue;
        mk = h('button', { type: 'button', class: MK + ' ae-as ' + sev, 'data-sig': sig, title: 'Assize: ' + list.length + (list.length === 1 ? ' finding' : ' findings') + ' (click opens the order)',
          html: AE.actionIcon('assize', 14) + list.length });
        mk.onmousedown = (e) => e.stopPropagation();
        mk.onclick = (e) => { e.preventDefault(); e.stopPropagation(); link.click(); };
        wrap.classList.add('ae-as-wrap');
        link.after(mk); // right after the name: Waymark's chips (appended to the same row) stay to its right
      }
    }

    // ------------------------------------------------------------ wiring
    function render() {
      if (!/^\/login/.test(location.pathname)) renderIcon();
      renderPanel();
      renderPill();
      renderList();
    }
    let seenAt = 0, started = false, listSig = '';
    async function start() {
      if (started) return;
      started = true;
      const prof = await AE.profile().catch(() => null);
      if (!prof || prof.storeId == null) { started = false; return; }
      storeId = prof.storeId; me = prof;
      compute(); render();
      if (canDismiss()) {
        AE.waymark.canEdit().then((r) => { isManager = !!(r && r.ok); render(); }).catch(() => {});
        loadDismissed(true);
      }
      if (AE.priceSheet && AE.waymark && AE.waymark.configured()) AE.priceSheet.get().then((v) => { sheet = v && v.data ? v : null; compute(); render(); }).catch(() => {});
      AE.every(60 * 1000, () => { if (!document.hidden) pass(false); compute(); render(); }); // pass() waits out the shared 10 minutes
      // Another tab's pass: pick up its results.
      AE.every(5000, () => {
        const rows = readRows();
        const stamp = (rows ? rows.at : 0) + ':' + Object.keys(readDetails()).length;
        if (stamp !== seenAt) { seenAt = stamp; compute(); render(); }
      });
      AE.every(1000, () => { const woId = currentWoId(); if (woId) refreshWo(woId); renderPill(); renderList(); });
      AE.onDom(() => { // Portal redrew its heading or list: put the pill and markers back in the same frame
        if (!result) return;
        if (currentWoId() && !document.getElementById(PILL_ID)) renderPill();
        if (!onList()) return;
        const links = document.querySelectorAll('tbody tr a[href*="/repair/workorder/"]');
        const sig = links.length + '|' + (links[0] && links[0].getAttribute('href')) + '|' + document.querySelectorAll('.' + MK).length;
        if (sig !== listSig) { renderList(); listSig = links.length + '|' + (links[0] && links[0].getAttribute('href')) + '|' + document.querySelectorAll('.' + MK).length; }
      });
      AE.every(1500, () => { if (!/^\/login/.test(location.pathname)) renderIcon(); }); // SPA re-renders can drop the header
    }
    if (!/^\/login/.test(location.pathname)) start();
    else AE.every(2000, () => { if (!started && !/^\/login/.test(location.pathname)) start(); });
    AE.hooks.assizePass = () => pass(true); // dev tools
  },
});
