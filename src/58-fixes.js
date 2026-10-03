/*
  Master's Mend — small fixes to Portal, each with its own switch under the
  crystal in Settings (settings.fixes[id]). New fixes go in FIXES below.

  - logoLink: the ubreakifix logo (top left) is a <button> that routes to the
    dashboard ("/") on click, so it can't be middle-clicked or right-clicked
    into a new tab. A real link to "/" sits over it: middle click, Ctrl/⌘
    click and the right-click menu act on the link; a plain click still goes
    through Portal's own button (no page reload). React owns the button and
    image, so they're never moved; the link is an extra child of the logo
    wrapper, put back if Portal re-renders the header.

  - scanNav: scan to open. Portal already detects barcode scans (its root
    layout: keys under features.scan_delay_ms = 40 ms apart, ending in Enter →
    window event "scanDetected" {scan}) and uses them in a few places: an
    item label on a WO adds it to the cart, an "SO…/WO…" receipt opens a
    "Navigate to work order" dialog, the open global search looks up a
    12-character scan. Nothing handled a WO label (the bare WO number), so
    scanning one did nothing. This fix:
      · WO label (a 9-digit WO number, or WO<number>) → opens that WO,
        anywhere except pages where scans are data entry: the check-in steps
        (/check-in, price check), check-out, and inventory pages with data
        (a PO, receiving, a PO's projection, editing/reviewing a count, an
        RMA or buyback order, store transfers, purchase requests, local
        pricing). Arrivals and inventory's list pages (home, POs, counts,
        RMA/buyback, store products) are allowed (LIST_PAGES; anything else
        under /boh, /check-in or /check-out is blocked). Checked against
        Portal first.
      · item label (<item number>-<10+ digit serial>) → opens the item's
        page, from the dashboard, WO list, customers, Arrivals and those
        inventory list pages. On a WO, Portal adds it to the WO instead.
      · never while you're typing in a field or a dialog/drawer is open
        (the scan is meant for that field), and never acts on scans
        Portal's own pages consume.
    Scanners slower than Portal's 40 ms window were missed entirely; when
    Aethernet sees a scan (keys up to 60 ms apart) that Portal didn't, it
    sends Portal the same scanDetected event, so Portal's own scan features
    work with those scanners too.

  - autoNotes: a "Hide auto notes" switch at the top of a WO's notes.
    Portal's notes are noteType Auto (1: status changes, "X started
    check-in", estimate/contact logs…) or Manual (2: what people write; also
    Recitation's text notes). The notes tab (data-testid "notes-tab") draws
    each as a card with id "note-<noteId>" from the Redux "notes" slice, so
    the auto ones' ids come from there (AE.portal select) and a stylesheet
    hides them; nothing is changed or deleted, and Portal's cards aren't
    touched. The switch is remembered in this browser; flip it back any time.
    While it's on, all of the WO's notes are loaded straight away (Portal's
    own "Show more", data-testid "show-more-link", clicked until it's gone),
    so what's left is the full history of what people wrote, not just page 1.

  - notContacted: a "Not contacted" chip on the Arrivals page
    (/check-in/arrivals), in Portal's chip row (ManualSelectionChips:
    data-aui "chips.manual-selection", each chip a .chipElement with
    role=checkbox/aria-checked; ours is cloned from Portal's chip, and the
    Aethernet mark floats over its corner, since the row clips anything that
    sticks out). Contacted arrivals carry arrival attribute 53
    (ArrivalAttributeType.Contacted, Portal's ubif-types bundle) with a value;
    that's what draws the Contacted tag. Portal's list is paged (10 a page)
    and the server only filters *contacted* (contacted=false acts like true),
    so the chip selects Portal's "All" underneath, Aethernet loads every page
    itself (GET /api/arrivals/upcoming-arrivals with the args Portal's
    getUpcomingArrivals query was loaded with), and Portal's own table is
    handed the not-contacted ones: the loaded result is patched in place
    (AE.portal patch = RTK's patchQueryData), so it looks and behaves like
    every other Arrivals page. Settings can limit it to arrivals still Not
    confirmed (status 20). It follows Portal's day, reloads every minute
    (and re-patches if Portal refetches), and any of Portal's chips reloads
    Portal's own list. Like Portal's chips, it isn't remembered once you
    leave the page.

  - reportsRetry: Portal's Reports page (/reporting/metrics) shows its spinner
    until GET /api/reporting/metrics (RTK getMetricsConfig) has data, and has
    no error state, so one blocked request spins forever. Cause confirmed by
    Garrett (Oct 2026, Firefox): uBlock Origin blocks it (Firefox reports
    "NetworkError when attempting to fetch resource"); turning it off for the
    page brings Reports back. Retrying can't beat a blocker, so after 8 s
    without the Reports card a warning says to turn off the ad blocker for
    portal.ubreakifix.net and reload; the details (RTK status/error, whether
    the browser sent the request, Portal's script errors) go where bug
    reports pick them up.

  - appcuesBoxes: Appcues announcement boxes on work orders (e.g. "ACTION
    REQUIRED: Apple iOS 27 and Repair Mode": <appcues data-pattern-type="shorty">
    inside <appcues-container>'s about:blank iframe). Appcues' own × dismisses
    one for good, which Garrett doesn't want, so it's hidden; the box gets
    "– Collapse" (until brought back) and "Hide for today". Either leaves the
    XIV Active Help icon (assets/icons/info.jpg) bottom left; clicking it
    brings the box back. Remembered per box title (GM ae_appcues_boxes), so a
    new announcement shows normally. A first-time speech bubble explains it
    (GM ae_box_tip_seen).

  - woSort: sort the Work orders list by any column. Portal's table only
    offers ▲▼ on one or two columns per tab (repair.js FA[…].sortableColumns),
    though the server sorts by more. The list's sort is Redux state
    (repair.workorderlistFilterSelection[<primary filter>], `order` =
    "<column id>,ASC|DESC", per tab under tabs[<tab>].order), and the list
    refetches when it changes, so a header click here sets it exactly as
    Portal's own icons do (AE.portal dispatch of
    repair/setWorkorderlistFilterSelection, back to page 1).
      · Sorted by the server, across every page (checked Oct 1, 2026): WO #,
        Created, Program, Status, Next update, Last update, Closed, Cancelled,
        Total.
      · The server ignores or fails on Customer, Device/Issue, Location,
        Service Outcome, Completed, Created By, Cancelled By: those sort the
        rows on the page you're looking at (pick 100 per page for more), and
        say so in their tooltip.
    Portal's own ▲▼ columns are left as they are. Rows moved for a page sort
    are React's, and React re-renders assuming its own order, so the list's
    real order is read from Portal's loaded data (getAllWorkOrders) and the
    rows are put back in it whenever no page sort is on.

  - appcuesButtons: Portal's "Support Ticket" (left menu) and "Enhancement
    Idea" (dashboard) buttons aren't Portal's: they're Appcues content
    (Portal loads fast.appcues.com; ids "button-<uuid>", Appcues' theme
    variables), drawn in Appcues' own style and, for Enhancement Idea, pinned
    over the dashboard where it covers the calendar. Appcues keeps placing
    and re-placing its content, so it isn't moved or restyled: each original
    is tucked away off-screen (still rendered, so Appcues is content) and a
    stand-in made of Portal's own parts takes its place:
      · Support Ticket: a left-menu item cloned from Portal's own (icon +
        label), just above More;
      · Enhancement Idea: a pill next to Metrics overview's View all.
    A stand-in clicks the original, so whatever Appcues does on click still
    happens, and only exists while Appcues shows the original (its
    targeting still decides when). The originals are looked for in the page,
    in open shadow roots and in same-origin frames (Appcues draws some
    content in an about:blank iframe); one that can't be placed is left as
    it is.
    Live Portal (Oct 2, 2026): Support Ticket is drawn in an
    <appcues-experience-container id="appcues-container-<uuid>"> with
    display:contents, so tucking also gives the box display:block.
*/
AE.fixesInfo = [
  ['logoLink', 'Logo link', 'The ubreakifix logo is a real link to the dashboard: middle-click or right-click it to open a new tab.'],
  ['autoNotes', 'Hide auto notes switch', 'A switch at the top of a work order\'s notes hides the automatic ones (status changes, check-in logs…) and loads every note, so you see everything people wrote. Flip it back any time; nothing is deleted.'],
  ['notContacted', 'Not contacted (Arrivals)', 'A "Not contacted" chip on the Arrivals page, next to Portal\'s own, lists every arrival that hasn\'t been contacted yet (no Contacted tag), from every page.',
    // Which statuses the chip lists: everything not contacted, or only the ones still Not confirmed.
    (s, h) => {
      const pick = (v) => { s.fixes.notContactedStatus = v; paint(); };
      const btn = (v, label) => h('button', { type: 'button', class: 'sg-btn', 'data-v': v, style: 'height:28px;font-size:12px;padding:0 10px', onclick: () => pick(v) }, label);
      const box = h('div', { style: 'display:flex;align-items:center;gap:6px;margin:-2px 0 10px 14px;font-size:12px', class: 'sg-soft' },
        'Statuses:', btn('all', 'All'), btn('notConfirmed', 'Not confirmed only'));
      function paint() {
        const cur = s.fixes.notContactedStatus === 'notConfirmed' ? 'notConfirmed' : 'all';
        box.querySelectorAll('button').forEach((b) => { const on = b.dataset.v === cur; b.classList.toggle('sg-primary', on); b.setAttribute('aria-pressed', String(on)); });
      }
      paint();
      return box;
    }],
  ['reportsRetry', 'Reports page help', 'If Portal\'s Reports page is stuck loading, a warning explains the usual cause (an ad blocker like uBlock Origin) and how to fix it. The details are included if you send a bug report.'],
  ['woSort', 'Sort by any column', 'Every column of the Work orders list can be sorted. Most sort across all pages; a few that Portal can\'t sort (like Customer) sort the page you\'re on.'],
  ['appcuesBoxes', 'Collapse announcement boxes', 'Announcement boxes on work orders (like "Apple iOS 27 and Repair Mode") get – Collapse, to shrink them to an icon, and Hide for today. They never disappear for good: the icon at the bottom left brings them back.'],
  ['appcuesButtons', 'Support Ticket & Enhancement Idea buttons', 'Portal\'s Support Ticket and Enhancement Idea buttons are made to fit: Support Ticket becomes a normal item in the left menu, and Enhancement Idea sits next to View all under Metrics overview instead of over the calendar. They work just as before.'],
  ['scanNav', 'Scan to open', 'Scan a WO label to open the WO, or an item label to open the item (on a WO, items are added to it as usual). Works on Arrivals and inventory\'s lists, but never while checking in or out, on a PO, receiving, or doing a count, or while typing in a field.',
    // Debugging: a live log of what the scanner sends and what happened.
    (s, h) => h('label', { style: 'display:flex;align-items:center;gap:8px;margin:-2px 0 10px 14px;font-size:12px', class: 'sg-soft' },
      h('input', { type: 'checkbox', checked: !!s.fixes.scanDebug, onchange: (e) => { s.fixes.scanDebug = e.target.checked; } }),
      'Show scan debugging (a log of every scan, bottom right; to find out why a scan didn\'t work)')],
];

AE.crystal({
  id: 'fixes',
  name: "Master's Mend",
  sites: ['portal.ubreakifix.net'],
  run() {
    const on = AE.settings.fixes || {};

    // Appcues (fast.appcues.com) content, shared by appcuesButtons and appcuesBoxes.
    const AC = (() => {
      const TUCK = 'ae-appcues-tucked';
      document.head.append(AE.h('style', null, `
        /* display:block: Appcues' <appcues-experience-container> is display:contents (no box), which positioning can't move */
        .${TUCK} { display:block !important; position:fixed !important; left:-10000px !important; top:0 !important; width:300px !important; opacity:0 !important; pointer-events:none !important; }
      `));
      // Every place Appcues can draw: the page, open shadow roots, same-origin frames.
      function roots() {
        const out = [document];
        for (let i = 0; i < out.length; i++) {
          for (const el of out[i].querySelectorAll('*')) {
            if (el.shadowRoot) out.push(el.shadowRoot);
            if (el.tagName === 'IFRAME') { try { const d = el.contentDocument; if (d && d.documentElement) out.push(d); } catch (_) { /* other origin */ } }
          }
        }
        return out;
      }
      // What to tuck away in the page: the frame or shadow host it's drawn in, and its Appcues wrapper.
      function outerBox(el) {
        let x = el;
        for (;;) {
          const root = x.getRootNode();
          if (root instanceof ShadowRoot) { x = root.host; continue; }
          if (root !== document) { const fe = root.defaultView && root.defaultView.frameElement; if (fe) { x = fe; continue; } }
          break;
        }
        for (let y = x; y && y !== document.body; y = y.parentElement) {
          if (/^appcues/i.test(y.tagName) || /appcues/i.test((y.id || '') + ' ' + (typeof y.className === 'string' ? y.className : ''))) x = y;
        }
        return x;
      }
      // Where `el` is on the page (adds up the frames it's drawn in).
      function pageRect(el) {
        const r = el.getBoundingClientRect();
        let x = r.left, y = r.top, win = el.ownerDocument.defaultView;
        while (win && win !== window && win.frameElement) { const f = win.frameElement.getBoundingClientRect(); x += f.left; y += f.top; win = win.frameElement.ownerDocument.defaultView; }
        return { left: x, top: y, width: r.width, height: r.height, right: x + r.width, bottom: y + r.height };
      }
      // What Appcues has on the page (for bug reports: enough to write a bulletin rule). Appcues content
      // is Asurion's announcements, not customer data; titles only.
      function summary() {
        const out = [];
        for (const r of roots()) {
          for (const el of r.querySelectorAll('*')) {
            const tag = el.tagName.toLowerCase();
            if (!/^appcues/.test(tag) && !/^appcues-container-/.test(el.id || '')) continue;
            const scope = el.shadowRoot || el;
            const hd = scope.querySelector && scope.querySelector('h1, h2, h3, h4, [role="dialog"]');
            out.push({ tag, id: (el.id || '').slice(0, 60), pattern: el.getAttribute('data-pattern-type'), position: el.getAttribute('data-position'),
              shadow: !!el.shadowRoot, frame: el.ownerDocument !== document, title: hd ? (hd.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) : null });
            if (out.length >= 12) return out;
          }
        }
        return out;
      }
      AE.appcuesSummary = summary;
      return { TUCK, roots, outerBox, pageRect, summary };
    })();

    const FIXES = {
      appcuesButtons() {
        const { TUCK, roots, outerBox } = AC, NAV_ID = 'ae-support-ticket', IDEA_ID = 'ae-enhancement-idea';
        const svg = (d) => '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
        const TICKET = svg('<path d="M3.5 7.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v2a2.5 2.5 0 0 0 0 5v2a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-2a2.5 2.5 0 0 0 0-5z"/><path d="M14.5 5.5v13" stroke-dasharray="1.6 2.2"/>');
        const BULB = svg('<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.4 1.1 2.2h5c0-.8.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/>');
        document.head.append(AE.h('style', null, `
          #${NAV_ID} { cursor:pointer; }
          #${NAV_ID} .ae-ico { display:inline-flex; line-height:0; }
          #${IDEA_ID} { gap:6px; margin:0 8px 0 auto; } /* auto: sits by View all even in a space-between row */
          #${IDEA_ID} svg { width:18px; height:18px; }
        `));
        const label = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
        function find(text) {
          for (const r of roots()) {
            for (const el of r.querySelectorAll('button, a, [role="button"]')) {
              if (el.closest('#' + NAV_ID + ', #' + IDEA_ID)) continue;
              if (label(el) === text && (/^button-/.test(el.id || '') || el.hasAttribute('blocktype') || el.hasAttribute('data-field-id'))) return el;
            }
          }
          return null;
        }
        const tucked = new Set();
        function tuck(el) { const box = outerBox(el); box.classList.add(TUCK); tucked.add(box); }
        function untuckAll() { tucked.forEach((b) => b.classList.remove(TUCK)); tucked.clear(); }

        function supportTicket(orig) {
          const nav = document.querySelector('#single-spa-application\\:\\@ubif\\/main-layout nav') || document.querySelector('nav');
          const links = nav ? [...nav.querySelectorAll('a[data-aui="link"]')] : [];
          const more = links.find((a) => label(a) === 'More');
          const model = links.find((a) => a !== more && a.querySelector('[data-aui="icon"]') && !a.classList.contains('active'));
          if (!more || !model) return false;
          let item = document.getElementById(NAV_ID);
          if (!item) {
            item = model.cloneNode(true);
            item.id = NAV_ID;
            item.removeAttribute('href');
            item.setAttribute('role', 'button'); item.setAttribute('tabindex', '0');
            const icoBox = item.querySelector('[data-aui="icon"]').parentElement;
            icoBox.replaceChildren(AE.h('span', { class: 'ae-ico', html: TICKET }));
            [...item.childNodes].filter((n) => n.nodeType === 3).forEach((n) => n.remove());
            item.append('Support ticket');
            const go = (e) => { e.preventDefault(); find('Support Ticket')?.click(); };
            item.addEventListener('click', go);
            item.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') go(e); });
          }
          if (item.nextElementSibling !== more) more.before(item);
          return true;
        }
        function enhancementIdea(orig) {
          const head = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,span,div')].find((e) => e.children.length === 0 && label(e) === 'Metrics overview');
          let row = head, viewAll = null;
          for (let i = 0; row && i < 4 && !viewAll; i++) { row = row.parentElement; viewAll = row && [...row.querySelectorAll('a, button')].find((e) => /^View all/.test(label(e))); }
          if (!viewAll) return false;
          let pill = document.getElementById(IDEA_ID);
          if (!pill) {
            pill = AE.h('button', { id: IDEA_ID, type: 'button', class: 'sg-btn', title: 'Suggest an improvement to Portal' });
            pill.innerHTML = BULB;
            pill.append('Enhancement idea');
            pill.addEventListener('click', () => find('Enhancement Idea')?.click());
          }
          const h = viewAll.getBoundingClientRect().height;
          if (h) pill.style.height = Math.round(h) + 'px';
          if (pill.nextElementSibling !== viewAll) viewAll.before(pill);
          return true;
        }

        AE.every(1500, () => {
          untuckAll();
          const st = find('Support Ticket'), idea = find('Enhancement Idea');
          if (st && supportTicket(st)) tuck(st); else document.getElementById(NAV_ID)?.remove();
          if (idea && enhancementIdea(idea)) tuck(idea); else document.getElementById(IDEA_ID)?.remove();
        });
      },
      appcuesBoxes() {
        const KEY = 'ae_appcues_boxes', TIP_KEY = 'ae_box_tip_seen', ICONS = 'ae-box-icons', MARK = 'data-ae-box';
        /*
          Which boxes are bulletins: built in, plus rules from status.json ("bulletins", 2.22.0+;
          build.py --bulletin-…), so a new kind of bulletin can be covered without an update.
          pages replaces the built-in list; patterns, selectors and closers add to it.
        */
        const BUILT_IN = { pages: ['^/repair/workorder/\\d+'], patterns: ['shorty', 'modal', 'slideout', 'fullscreen'], selectors: [], closers: ['.appcues-skip', '[data-step="skip"]'] };
        const rules = () => {
          const r = (AE.status && AE.status.get().bulletins) || {};
          const uniq = (a) => [...new Set(a)];
          return { pages: (r.pages && r.pages.length ? r.pages : BUILT_IN.pages), patterns: uniq([...BUILT_IN.patterns, ...(r.patterns || [])]),
            selectors: uniq([...BUILT_IN.selectors, ...(r.selectors || [])]), closers: uniq([...BUILT_IN.closers, ...(r.closers || [])]) };
        };
        const reCache = new Map();
        const re = (src) => { if (!reCache.has(src)) { let x = null; try { x = new RegExp(src); } catch (_) { /* bad rule: skipped */ } reCache.set(src, x); } return reCache.get(src); };
        const qsa = (root, sel) => { try { return [...root.querySelectorAll(sel)]; } catch (_) { return []; } };
        const scopeOf = (box) => box.shadowRoot || box;
        // Appcues' newer containers (<appcues-experience-container>, shadow DOM) also hold buttons like Support
        // Ticket; only ones with a heading or a dialog are bulletins.
        const isBulletin = (box) => { const sc = scopeOf(box); return !!sc.querySelector('h1, h2, h3, h4, [role="dialog"]') && !box.closest('.sg'); };
        const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
        const store = () => GM_getValue(KEY, {});
        const put = (k, v) => { const all = store(); if (v) all[k] = v; else delete all[k]; GM_setValue(KEY, all); };
        const onPage = (R) => R.pages.some((src) => { const x = re(src); return x && x.test(location.pathname); });
        const titleOf = (box) => {
          const sc = scopeOf(box), hd = sc.querySelector('h1, h2, h3, h4');
          return ((hd ? hd.textContent : sc.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        };
        // A box is known by its title, so a new announcement shows normally.
        const keyOf = (t) => { let x = 0; for (let i = 0; i < t.length; i++) x = (x * 31 + t.charCodeAt(i)) | 0; return 'b' + (x >>> 0).toString(36); };
        const away = (st) => !!st && (st.collapsed || st.hiddenDay === today());

        document.head.append(AE.h('style', null, `
          #${ICONS} { position:fixed; left:16px; bottom:16px; z-index:2147483645; display:flex; flex-direction:column-reverse; gap:10px; }
          #${ICONS} button { position:relative; width:44px; height:44px; padding:0; border:0; border-radius:22%; cursor:pointer; line-height:0; overflow:visible;
            box-shadow:0 0 0 2px #1a1a1f, 0 0 0 3.5px #c9a75a, 0 6px 18px rgba(12,14,17,.35); background:#1a1a1f; }
          #${ICONS} button img { width:100%; height:100%; border-radius:22%; }
          #${ICONS} button:hover { filter:brightness(1.15); }
          #${ICONS} button .when { position:absolute; left:52px; top:50%; transform:translateY(-50%); white-space:nowrap; padding:3px 8px; border-radius:6px; font:600 12px Apercu, "Helvetica Neue", Arial, sans-serif;
            background:rgba(12,12,18,.88); color:#fff; display:none; line-height:1.3; }
          #${ICONS} button:hover .when, #${ICONS} button:focus-visible .when { display:block; }
          .ae-box-tip { position:fixed; z-index:2147483646; width:280px; padding:12px 14px; font-size:13px; line-height:1.45; }
          .ae-box-tip::after { content:''; position:absolute; top:-8px; left:var(--tail, 24px); width:16px; height:16px; transform:rotate(45deg);
            background:var(--aui-surface, #fff); box-shadow:-2px -2px 3px rgba(12,14,17,.06); }
          .ae-box-tip p { margin:0 0 8px; }
        `));
        // Controls in the box itself (it may be drawn in Appcues' frame, so its own document gets the style).
        const BAR_CSS = '[' + MARK + '-bar]{display:flex;gap:6px;justify-content:flex-end;padding:6px 8px 0;position:relative;z-index:3}' +
          '[' + MARK + '-bar] button{font:600 12px Apercu,"Helvetica Neue",Helvetica,Arial,sans-serif;height:26px;padding:0 10px;border-radius:10000rem;cursor:pointer;' +
          'border:1px solid rgba(0,0,0,.25);background:rgba(255,255,255,.7);color:#1a1c1e}' +
          '[' + MARK + '-bar] button:hover{border-color:#8223d2;color:#8223d2}';
        // Appcues' own close buttons dismiss a bulletin for good: hidden (inside the bulletin only).
        const closerCss = (R, inShadow) => R.closers.map((c) => (inShadow ? '' : '[' + MARK + '] ') + c).join(',') + '{display:none !important}';
        function controls(box, key, title, R) {
          const doc = box.ownerDocument, sc = scopeOf(box), inShadow = !!box.shadowRoot;
          const styleHome = inShadow ? sc : (doc.head || doc.documentElement);
          let st = (inShadow ? sc : doc).querySelector('#ae-box-css');
          if (!st) { st = doc.createElement('style'); st.id = 'ae-box-css'; styleHome.append(st); }
          const css = BAR_CSS + closerCss(R, inShadow);
          if (st.textContent !== css) st.textContent = css;
          if (sc.querySelector('[' + MARK + '-bar]')) return;
          box.setAttribute(MARK, key);
          const bar = doc.createElement('div'); bar.setAttribute(MARK + '-bar', '');
          const btn = (label, tip, fn) => { const b = doc.createElement('button'); b.type = 'button'; b.textContent = label; b.title = tip; b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn(); }); return b; };
          bar.append(
            btn('– Collapse', 'Collapse to an icon (bottom left). Click the icon to bring it back.', () => { put(key, { title, collapsed: true }); AE.track('fixes:boxCollapse'); tick(); }),
            btn('Hide for today', 'Hide until tomorrow. The icon (bottom left) brings it back today.', () => { put(key, { title, hiddenDay: today() }); AE.track('fixes:boxHideToday'); tick(); }));
          (sc.querySelector('modal-container') || (inShadow ? (sc.firstElementChild || sc) : box)).prepend(bar);
        }
        function tip(box) {
          if (GM_getValue(TIP_KEY, false) || document.querySelector('.ae-box-tip')) return;
          const bar = scopeOf(box).querySelector('[' + MARK + '-bar]');
          if (!bar) return;
          const r = AC.pageRect(bar);
          if (!r.width) return;
          const el = AE.h('div', { class: 'sg sg-card ae-box-tip', role: 'note' },
            AE.h('p', null, AE.h('b', null, 'New: '), 'collapse this box to an icon, or hide it for today. It never disappears for good: the icon at the bottom left brings it back.'),
            AE.h('div', { class: 'sg-actions' }, AE.h('button', { type: 'button', class: 'sg-btn sg-primary', onclick: () => { GM_setValue(TIP_KEY, true); el.remove(); } }, 'Got it')));
          document.body.append(el);
          const left = Math.max(8, Math.min(r.right - 280, innerWidth - 288));
          el.style.left = left + 'px'; el.style.top = (r.bottom + 12) + 'px';
          el.style.setProperty('--tail', Math.max(14, Math.min(250, r.right - 60 - left)) + 'px');
        }

        const tucked = new Set();
        function tick() {
          tucked.forEach((b) => b.classList.remove(AC.TUCK)); tucked.clear();
          const boxes = [], R = rules();
          if (onPage(R)) {
            const seen = new Set();
            const take = (box) => {
              if (seen.has(box)) return;
              seen.add(box);
              const title = titleOf(box);
              if (title) boxes.push({ box, title, key: keyOf(title) });
            };
            for (const r of AC.roots()) {
              for (const box of r.querySelectorAll('appcues[data-pattern-type]')) if (R.patterns.includes(box.getAttribute('data-pattern-type'))) take(box);
              for (const box of qsa(r, 'appcues-experience-container')) if (isBulletin(box)) take(box);
              for (const sel of R.selectors) for (const box of qsa(r, sel)) if (isBulletin(box)) take(box);
            }
          }
          const all = store(), shown = [];
          for (const b of boxes) {
            controls(b.box, b.key, b.title, R);
            if (away(all[b.key])) { const o = AC.outerBox(b.box); o.classList.add(AC.TUCK); tucked.add(o); shown.push(b); }
            else tip(b.box);
          }
          // One icon per collapsed / hidden box; click it to bring the box back.
          let wrap = document.getElementById(ICONS);
          if (!shown.length) { wrap?.remove(); return; }
          if (!wrap) { wrap = AE.h('div', { id: ICONS, class: 'sg' }); document.body.append(wrap); }
          const sig = shown.map((b) => b.key + (all[b.key].collapsed ? 'c' : 'h')).join(',');
          if (wrap.dataset.sig === sig) return;
          wrap.dataset.sig = sig;
          wrap.replaceChildren(...shown.map((b) => AE.h('button', { type: 'button', 'aria-label': 'Show: ' + b.title,
            onclick: () => { put(b.key, null); AE.track('fixes:boxShow'); tick(); } },
            AE.h('img', { src: AE.asset('info'), alt: '' }),
            AE.h('span', { class: 'when' }, b.title, AE.h('br'), AE.h('span', { style: 'font-weight:400;opacity:.8' }, all[b.key].collapsed ? 'Collapsed · click to show' : 'Hidden for today · click to show')))));
        }
        AE.every(1000, tick);
        // Old entries (boxes not seen for a while) are dropped: hidden-for-today ones once the day is over.
        const all = store();
        for (const [k, v] of Object.entries(all)) if (v.hiddenDay && v.hiddenDay !== today()) delete all[k];
        GM_setValue(KEY, all);
      },
      logoLink() {
        const ID = 'ae-logo-link';
        document.head.append(AE.h('style', null, `
          .components-header-logo { position: relative; }
          #${ID} { position: absolute; inset: 0; z-index: 1; }
        `));
        AE.every(1000, () => {
          const wrap = document.querySelector('.components-header-logo');
          if (!wrap || wrap.querySelector('#' + ID)) return;
          const btn = wrap.querySelector('button');
          const link = AE.h('a', { id: ID, href: '/', 'aria-label': 'Dashboard', title: 'Dashboard', tabindex: '-1' });
          link.addEventListener('click', (e) => {
            if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; // new tab / window: the browser's
            e.preventDefault();
            (btn && btn.isConnected ? btn : wrap.querySelector('button'))?.click(); // Portal's own route change
          });
          wrap.append(link);
        });
      },
      autoNotes() {
        const KEY = 'ae_hide_auto_notes', AUTO = 1; // Portal's NoteType.Auto
        const BAR = 'ae-notes-bar', STYLE = 'ae-notes-hide';
        document.head.append(AE.h('style', null, `
          #${BAR} { display:flex; align-items:center; justify-content:flex-end; gap:8px; margin:-4px 0 -6px; font-size:13px; color:var(--aui-on-surface-soft, #5d5e61); }
          #${BAR} label { display:inline-flex; align-items:center; gap:8px; padding:4px 10px 4px 6px; border-radius:10000rem; cursor:pointer; user-select:none;
            border:1px solid var(--aui-outline, #c6c6ca); background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e); font-weight:600; }
          #${BAR} label:hover { border-color:var(--aui-primary, #8223d2); }
          #${BAR} input { position:absolute; opacity:0; pointer-events:none; }
          #${BAR} .knob { position:relative; width:30px; height:18px; border-radius:10000rem; background:var(--aui-outline, #c6c6ca); transition:background .15s; flex:none; }
          #${BAR} .knob::after { content:''; position:absolute; top:2px; left:2px; width:14px; height:14px; border-radius:50%; background:#fff; transition:left .15s; }
          #${BAR} input:checked + .knob { background:var(--aui-primary, #8223d2); }
          #${BAR} input:checked + .knob::after { left:14px; }
          #${BAR} input:focus-visible + .knob { outline:2px solid var(--aui-primary, #8223d2); outline-offset:2px; }
          #${BAR} .n { font-weight:400; }
        `));
        let hide = !!GM_getValue(KEY, false);
        const style = AE.h('style', { id: STYLE });
        document.head.append(style);

        function autoIds() {
          const r = AE.portal('select', { slice: 'notes', key: 'notes', pick: ['noteId', 'noteType'] });
          return r && Array.isArray(r.value) ? r.value.filter((n) => Number(n.noteType) === AUTO || /^auto$/i.test(n.noteType)).map((n) => String(n.noteId)) : null;
        }
        // Load every page of notes: click Portal's own Show more until it goes away.
        let loading = null, loadedFor = null;
        const more = (tab) => { const b = tab.querySelector('[data-testid="show-more-link"]'); return b && b.offsetParent !== null && b.getAttribute('aria-disabled') !== 'true' ? b : null; };
        async function loadAll(tab) {
          const wo = location.pathname;
          if (loading || loadedFor === wo) return;
          loading = (async () => {
            for (let i = 0; i < 60; i++) {           // 60 pages is far more than any WO has
              const b = more(tab);
              if (!b || !tab.isConnected || location.pathname !== wo) break;
              const before = tab.querySelectorAll('[id^="note-"]').length;
              b.click();
              for (let t = 0; t < 50; t++) {        // up to 10 s for the page to land
                await AE.sleep(200);
                const busy = tab.querySelector('[data-testid="loading-more"]');
                if (tab.querySelectorAll('[id^="note-"]').length > before && !(busy && busy.offsetParent)) break;
              }
            }
            if (location.pathname === wo) loadedFor = wo;
          })().finally(() => { loading = null; paint(); });
        }

        function paint() {
          const tab = document.querySelector('[data-testid="notes-tab"]');
          if (!tab) { if (style.textContent) style.textContent = ''; return; }
          const cards = [...tab.querySelectorAll('[id^="note-"]')].filter((c) => /^note-\d+$/.test(c.id));
          const ids = autoIds();
          const shownAuto = ids ? cards.filter((c) => ids.includes(c.id.slice(5))) : [];
          const css = hide && shownAuto.length ? shownAuto.map((c) => '#' + CSS.escape(c.id)).join(',') + ' { display:none !important; }' : '';
          if (style.textContent !== css) style.textContent = css;

          let bar = document.getElementById(BAR);
          const list = cards[0] && cards[0].parentElement;
          if (!list) { bar?.remove(); return; }
          if (!bar || bar.nextElementSibling !== list) {
            bar?.remove();
            const input = AE.h('input', { type: 'checkbox', checked: hide, onchange: (e) => { hide = e.target.checked; GM_setValue(KEY, hide); AE.track(hide ? 'fixes:hideAutoNotes' : 'fixes:showAutoNotes'); paint(); } });
            bar = AE.h('div', { id: BAR },
              AE.h('span', { class: 'n' }),
              AE.h('label', { title: 'Hide the automatic notes (status changes, check-in logs…). Nothing is deleted; flip it back any time.' },
                input, AE.h('span', { class: 'knob' }), 'Hide auto notes'));
            list.before(bar); // Portal's list is a flex column; we sit just above it
          }
          bar.querySelector('input').checked = hide;
          if (hide && more(tab) && loadedFor !== location.pathname) loadAll(tab);
          bar.querySelector('.n').textContent = loading ? 'Loading all notes…' : ids === null ? "Can't tell note types apart here"
            : hide ? (shownAuto.length ? shownAuto.length + ' auto note' + (shownAuto.length === 1 ? '' : 's') + ' hidden' : 'No auto notes')
            : shownAuto.length + ' auto note' + (shownAuto.length === 1 ? '' : 's');
        }
        let queued = false;
        new MutationObserver(() => { if (!queued) { queued = true; setTimeout(() => { queued = false; try { paint(); } catch (e) { AE.noteError('autoNotes', e); } }, 150); } })
          .observe(document.body, { childList: true, subtree: true });
        paint();
      },
      notContacted() {
        const CONTACTED = 53, NOT_CONFIRMED = 20, ENDPOINT = 'getUpcomingArrivals'; // Portal's ArrivalAttributeType.Contacted, ArrivalStatusEnum.NotConfirmed; the list's query
        const onlyUnconfirmed = AE.settings.fixes.notContactedStatus === 'notConfirmed'; // Settings: Statuses
        const CHIP = 'ae-nc-chip', BADGE = 'ae-nc-badge', BUSY = 'ae-nc-busy', MUTED = 'ae-nc-muted';
        document.head.append(AE.h('style', null, `
          #${BADGE} { position:fixed; z-index:20; width:18px; height:18px; border-radius:50%; display:flex; align-items:center; justify-content:center;
            background:var(--aui-surface, #fff); color:var(--aui-primary, #8223d2); box-shadow:0 0 0 1px var(--aui-outline, #c6c6ca), 0 1px 3px rgba(12,14,17,.2); line-height:0; pointer-events:none; }
          .${MUTED} > [data-aui="icon"]:first-of-type { display:none !important; } /* Portal's ✓ on the chip we've taken over from */
          .${BUSY} { opacity:.45; pointer-events:none; transition:opacity .15s; }
        `));
        // on: our page is showing. Like Portal's own chips it resets when you leave the page.
        let on = false, rows = null, loading = null, loadedKey = null, loadedAt = 0, muted = null; // muted: { el, cls }
        const contacted = (a) => (a.arrivalAttributes || []).some((x) => Number(x.arrivalAttributeTypeId) === CONTACTED && x.value !== '' && x.value != null);
        const shown = () => AE.portal('query', { endpoint: ENDPOINT, list: 'data', field: 'arrivalId' }) || {};
        const keyOf = (args) => JSON.stringify(args && Object.assign({}, args, { page: 0, pageSize: 0 }));
        const chipsBox = () => document.querySelector('[data-aui="chips.manual-selection"]');
        const portalChips = (box) => [...box.querySelectorAll('.chipElement')].filter((c) => c.id !== CHIP);
        const labelOf = (c) => (c.querySelector('.textElement') || c).textContent.trim();

        async function loadAll(args) {
          const base = Object.assign({}, args); delete base.page; delete base.pageSize;
          const all = [];
          for (let page = 1; page <= 20; page++) {
            const q = new URLSearchParams();
            for (const [k, v] of Object.entries(Object.assign({}, base, { page, pageSize: 100 }))) if (v !== undefined && v !== null && v !== '') q.set(k, v);
            const j = await AE.api('GET', '/api/arrivals/upcoming-arrivals?' + q);
            const data = (j && j.data) || [];
            all.push(...data);
            if (!data.length || all.length >= ((j && j.rowCount) || 0)) break;
          }
          return all;
        }
        // One load at a time; if Portal's day/filters changed meanwhile, paint() starts the next one.
        function refresh(args, key) {
          loading = loadAll(args || {})
            .then((all) => {
              rows = all.filter((a) => !contacted(a) && (!onlyUnconfirmed || Number(a.arrivalStatus && a.arrivalStatus.arrivalStatusId) === NOT_CONFIRMED));
              loadedKey = key; loadedAt = Date.now();
            })
            .catch((e) => { AE.toast('Not contacted', "Couldn't load the arrivals: " + (e.message || e), 'err'); turnOff(); })
            .finally(() => { loading = null; paint(); });
        }
        // Portal's own table shows them: its loaded page becomes the not-contacted list (all of it, one page).
        function showInPortal() {
          const ids = rows.map((a) => a.arrivalId);
          if ((shown().items || []).join() === ids.join()) return;
          AE.portal('patch', { endpoint: ENDPOINT, patches: [{ op: 'replace', path: ['data'], value: rows }, { op: 'replace', path: ['rowCount'], value: Math.min(rows.length, 1) }] });
        }

        // Our chip, built from Portal's own: an unselected chip when off, the selected one when on.
        function makeChip(box) {
          const chips = portalChips(box);
          const tpl = on ? chips.find((c) => c.getAttribute('aria-checked') === 'true') : chips.find((c) => c.getAttribute('aria-checked') !== 'true');
          if (!tpl) return null;
          const c = tpl.cloneNode(true);
          c.id = CHIP; c.dataset.on = String(on);
          c.setAttribute('aria-checked', String(on));
          c.title = 'Arrivals nobody has contacted yet (no Contacted tag)' + (onlyUnconfirmed ? ', still Not confirmed' : '') + ', from every page. Added by ' + AE_NAME + ' (Settings → Master\'s Mend).';
          (c.querySelector('.textElement') || c).textContent = 'Not contacted';
          c.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (!on) turnOn(box); });
          c.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !on) { e.preventDefault(); turnOn(box); } });
          return c;
        }
        // The Aethernet mark on the chip's corner. Portal's chip row clips what sticks out,
        // so it floats above the page, pinned to the chip, over whatever is above it.
        function placeBadge() {
          const chip = document.getElementById(CHIP);
          let b = document.getElementById(BADGE);
          const r = chip && chip.getBoundingClientRect();
          if (!r || !r.width) { b?.remove(); return; }
          if (!b) { b = AE.h('span', { id: BADGE, html: AE.icon('aetheryte', 14) }); document.body.append(b); }
          b.style.left = Math.round(r.left - 7) + 'px';
          b.style.top = Math.round(r.top - 7) + 'px';
        }
        addEventListener('scroll', () => requestAnimationFrame(placeBadge), true);
        addEventListener('resize', () => requestAnimationFrame(placeBadge));

        function unmute() { if (muted) { if (muted.el.isConnected && muted.el.classList.contains(MUTED)) { muted.el.className = muted.cls; muted.el.setAttribute('aria-checked', 'true'); } muted = null; } }
        function turnOn(box) {
          const all = portalChips(box)[0]; // "All": our page is every arrival, not contacted
          if (all && all.getAttribute('aria-checked') !== 'true') all.click();
          on = true; AE.track('fixes:notContacted');
          paint();
        }
        function turnOff() {
          if (!on) return;
          on = false; unmute();
          AE.portal('refresh', { tags: ['Arrivals'] }); // Portal reloads its own page of arrivals
          paint();
        }

        function paint() {
          const box = chipsBox();
          const list = document.querySelector('[data-testid="arrivals-container"]');
          const here = /^\/check-in\/arrivals(\/\d+)?\/?$/.test(location.pathname) && box && list;
          let chip = document.getElementById(CHIP);
          if (!here || !on) document.querySelectorAll('.' + BUSY).forEach((el) => el.classList.remove(BUSY));
          if (!here) {
            chip?.remove(); placeBadge();
            if (on) { on = false; unmute(); }
            return;
          }
          if (!chip || chip.dataset.on !== String(on) || chip.parentElement !== box) {
            chip?.remove();
            chip = makeChip(box);
            if (chip) {
              const after = portalChips(box).find((c) => /^contacted$/i.test(labelOf(c)));
              if (after) after.after(chip); else box.append(chip);
            }
          }
          placeBadge();
          if (!on) return;
          // Portal's selected chip ("All") stays selected underneath; show it as unselected while ours is.
          const sel = portalChips(box).find((c) => c.getAttribute('aria-checked') === 'true');
          const plain = portalChips(box).find((c) => c.getAttribute('aria-checked') !== 'true');
          if (sel && plain && (!muted || muted.el !== sel)) {
            unmute();
            muted = { el: sel, cls: sel.className };
            sel.className = plain.className + ' ' + MUTED;
            sel.setAttribute('aria-checked', 'false');
          }
          const args = shown().args, key = keyOf(args);
          const fresh = loadedKey === key && rows;
          if (!loading && (!fresh || Date.now() - loadedAt > 60000)) refresh(args, key); // new day/filters, or a minute old
          if (fresh) showInPortal();
          list.classList.toggle(BUSY, !fresh); // Portal's unfiltered page, dimmed, until the full list is in
          const label = chip && chip.querySelector('.textElement');
          if (label) label.textContent = fresh ? 'Not contacted · ' + rows.length : 'Not contacted · …';
        }
        // Any of Portal's own chips hands the list back to Portal.
        document.addEventListener('click', (e) => {
          const c = e.target.closest && e.target.closest('[data-aui="chips.manual-selection"] .chipElement');
          if (c && c.id !== CHIP && on) turnOff();
        }, true);
        let queued = false;
        new MutationObserver((ms) => {
          if (ms.every((m) => m.target.closest && m.target.closest('#' + CHIP + ', #' + BADGE))) return; // our own redraws
          if (!queued) { queued = true; setTimeout(() => { queued = false; try { paint(); } catch (e) { AE.noteError('notContacted', e); } }, 150); }
        }).observe(document.body, { childList: true, subtree: true });
        setInterval(() => { if (on) paint(); }, 30000);
        paint();
      },
      reportsRetry() {
        const PATH = /^\/reporting\/metrics\/?$/, WAIT = 8000, CARD = 'ae-reports-warn';
        let timer = null, lastPath = '';
        const loaded = () => !!document.querySelector('.reports-card');
        function diagnose() {
          const st = AE.portal('status', { endpoint: 'getMetricsConfig' }) || {};
          const seen = performance.getEntriesByType('resource').filter((e) => /\/api\/reporting\/metrics(\?|$)/.test(e.name));
          const net = seen.length ? seen[seen.length - 1] : null;
          const blocked = !!(st.error && /FETCH_ERROR|NetworkError|Failed to fetch/i.test(st.error));
          const detail = { rtk: st, blocked, browserSawRequest: !!net,
            request: net ? { status: net.responseStatus || null, ms: Math.round(net.duration), bytes: net.transferSize } : null,
            pageErrors: AE.pageErrors.slice(-3), ua: navigator.userAgent.slice(0, 160) };
          AE.noteError('Reports page stuck', JSON.stringify(detail));
          console.warn('[' + AE_NAME + '] Reports page stuck:', detail);
          return { blocked, st };
        }
        // A warning card on the page (stays until dismissed or the page loads).
        function warn() {
          const { blocked, st } = diagnose();
          document.getElementById(CARD)?.remove();
          const close = () => card.remove();
          const card = AE.h('div', { id: CARD, class: 'sg sg-card', role: 'alert', style:
            'position:fixed;z-index:2147483645;left:16px;bottom:16px;max-width:460px;padding:12px 14px;display:flex;gap:10px;align-items:flex-start;font-size:14px;line-height:1.45;border-left:4px solid #d6a000' },
            AE.h('span', { style: 'line-height:0;flex:none;color:#d6a000', html: AE.icon('aetheryte', 26) }),
            AE.h('div', { style: 'flex:1' },
              AE.h('b', { style: 'display:block;margin-bottom:2px' }, 'Reports isn\'t loading? Turn off your ad blocker on this page'),
              AE.h('div', { class: 'sg-soft', style: 'font-size:13px' },
                (blocked ? 'Your browser stopped Portal\'s reports request before it went out. ' : '') +
                'Ad blockers like uBlock Origin block Portal\'s reports. Turn yours off for portal.ubreakifix.net (click its icon in the toolbar and switch it off for this site), then reload.'),
              !blocked && st && st.status ? AE.h('div', { class: 'sg-soft', style: 'font-size:12px;margin-top:4px' }, 'Still stuck without one? Use Send feedback → Bug; the details are included.') : null,
              AE.h('div', { style: 'display:flex;gap:8px;margin-top:10px' },
                AE.h('button', { type: 'button', class: 'sg-btn sg-primary', style: 'height:30px;font-size:13px', onclick: () => location.reload() }, 'Reload page'))),
            AE.h('button', { type: 'button', class: 'sg-x', title: 'Dismiss', onclick: close }, '✕'));
          document.body.appendChild(card);
          AE.track('fixes:reportsWarn');
        }
        AE.every(500, () => {
          const p = location.pathname;
          if (loaded()) document.getElementById(CARD)?.remove();
          if (p === lastPath) return;
          lastPath = p;
          clearTimeout(timer);
          if (!PATH.test(p)) { document.getElementById(CARD)?.remove(); return; }
          timer = setTimeout(() => { if (PATH.test(location.pathname) && !loaded()) warn(); }, WAIT);
        });
        AE.hooks.reportsDiagnose = diagnose; // dev tools
        AE.hooks.reportsWarn = warn;
      },
      woSort() {
        // Header text → Portal's column id (repair.js WA), and whether the server sorts it.
        const COLS = {
          'WO #': ['woId', 1], 'Created': ['createdDate', 1], 'Customer': ['customerName', 0], 'Device/Issue': ['deviceCatalogName', 0],
          'Program': ['woProgram', 1], 'Next update': ['nextUpdate', 1], 'Location': ['location', 0], 'Status': ['woStatus', 1],
          'Closed': ['closed', 1], 'Cancelled': ['cancelled', 1], 'Created By': ['createdBy', 0], 'Cancelled By': ['cancelledBy', 0],
          'Last update': ['lastUpdate', 1], 'Service Outcome': ['serviceOutcome', 0], 'Completed': ['completed', 0], 'Total': ['workorderTotal', 1],
        };
        const TEXT_FIRST_ASC = ['customerName', 'deviceCatalogName', 'woProgram', 'location', 'woStatus', 'createdBy', 'cancelledBy', 'serviceOutcome'];
        const BTN = 'ae-wosort';
        document.head.append(AE.h('style', null, `
          .${BTN} { display:inline-flex; flex-direction:column; vertical-align:middle; margin-left:4px; padding:0 2px; border:0; background:none; cursor:pointer;
            color:var(--aui-on-surface-soft, #5d5e61); line-height:0; border-radius:4px; }
          .${BTN}:hover { background:var(--aui-neutral-soft, #f1f0f4); color:var(--aui-on-surface, #1a1c1e); }
          .${BTN} svg { width:10px; height:7px; opacity:.45; }
          .${BTN}[data-dir="ASC"] .up, .${BTN}[data-dir="DESC"] .down { opacity:1; color:var(--aui-primary, #8223d2); }
          .${BTN}.page { border-bottom:1px dashed currentColor; border-radius:0; }
        `));
        const ARROWS = '<svg class="up" viewBox="0 0 10 7"><path fill="currentColor" d="M5 0l5 7H0z"/></svg><svg class="down" viewBox="0 0 10 7"><path fill="currentColor" d="M5 7L0 0h10z"/></svg>';

        const getSel = () => { const r = AE.portal('select', { slice: 'repair', key: 'workorderlistFilterSelection' }); return r && r.found ? r.value : null; };
        function current(sel) {
          const pf = sel && Object.keys(sel).find((k) => sel[k] && sel[k].selected);
          if (!pf) return { pf: null, order: '' };
          const g = sel[pf], tab = g.activeTab, t = tab && g.tabs && g.tabs[tab];
          return { pf, g, tab, order: (t && t.order !== undefined ? t.order : g.order) || '' };
        }
        function serverSort(id, dir) {
          const sel = getSel(), c = current(sel);
          if (!c.pf) return AE.toast('Sort', "Couldn't find the list's settings in Portal.", 'err');
          const order = id + ',' + dir;
          const entry = Object.assign({}, c.g, { order, page: 1 });
          if (c.tab) entry.tabs = Object.assign({}, c.g.tabs, { [c.tab]: Object.assign({}, (c.g.tabs || {})[c.tab], { order }) });
          const r = AE.portal('dispatch', { slice: 'repair', action: { type: 'repair/setWorkorderlistFilterSelection', payload: { [c.pf]: entry } } });
          if (!r.stores) AE.toast('Sort', "Couldn't reach Portal's list.", 'err');
          pageSort = null;
          AE.track('fixes:woSort');
        }

        // Page-only sort: reorder the rows on screen (kept through re-renders).
        let pageSort = null, moved = false; // { header, dir }; moved: rows aren't in React's order any more
        const woOf = (row) => { const a = row.querySelector('a[href*="/repair/workorder/"]'); const m = a && a.getAttribute('href').match(/workorder\/(\d+)/); return m ? Number(m[1]) : null; };
        // Portal's own order for the rows on screen (the list query's data), as WO id → position.
        function portalOrder() {
          const r = AE.portal('query', { endpoint: 'getAllWorkOrders', list: 'workOrders', field: 'workorderId' });
          return r && r.items ? new Map(r.items.map((id, i) => [Number(id), i])) : null;
        }
        const cellsOf = (row) => [...row.children].filter((c) => /^(TD|TH)$/.test(c.tagName) || /^(cell|gridcell)$/.test(c.getAttribute('role') || ''));
        const keyOf = (text) => { const t = text.trim(); const d = Date.parse(t.replace(/\s+/g, ' ')); return { t, d: /\d/.test(t) && !isNaN(d) ? d : null }; };
        function applyPageSort(table, headers) {
          const body = table.tBodies ? table.tBodies[0] : null;
          if (!body || (!pageSort && !moved)) return;
          const rows = [...body.rows];
          const base = portalOrder();
          const pos = (row) => { const id = woOf(row); return base && base.has(id) ? base.get(id) : rows.indexOf(row); };
          const i = pageSort ? headers.findIndex((h) => h.label === pageSort.header) : -1;
          const sorted = rows.slice().sort((a, b) => {
            if (i >= 0) {
              const x = keyOf((cellsOf(a)[i] || {}).innerText || ''), y = keyOf((cellsOf(b)[i] || {}).innerText || '');
              const r = x.d !== null && y.d !== null ? x.d - y.d : x.t.localeCompare(y.t, undefined, { numeric: true, sensitivity: 'base' });
              if (r) return pageSort.dir === 'ASC' ? r : -r;
            }
            return pos(a) - pos(b); // ties, and no page sort: Portal's order
          });
          if (!pageSort && base) moved = false; // back in Portal's order
          if (sorted.every((r, k) => r === rows[k])) return;
          body.append(...sorted);
          if (pageSort) moved = true;
        }

        function paint() {
          if (!/^\/repair\/workorders\/?$/.test(location.pathname)) { pageSort = null; moved = false; return; }
          const link = document.querySelector('tbody a[href*="/repair/workorder/"], tbody tr');
          const table = link && link.closest('table');
          const head = table && table.tHead && table.tHead.rows[0];
          if (!head) return;
          const order = current(getSel()).order;
          const headers = [...head.cells].map((th) => ({ th, label: (th.innerText || '').trim().split('\n')[0].trim() }));
          for (const { th, label } of headers) {
            const col = COLS[label];
            if (!col || th.querySelector('[data-testid^="sort-icon"]')) continue; // Portal's own ▲▼
            const [id, server] = col;
            let b = th.querySelector('.' + BTN);
            if (!b) {
              b = AE.h('button', { type: 'button', class: BTN + (server ? '' : ' page'), html: ARROWS,
                title: server ? 'Sort by ' + label : 'Sort this page by ' + label + " (Portal can't sort this column across pages)" });
              b.addEventListener('click', (e) => {
                e.preventDefault(); e.stopPropagation();
                const was = b.dataset.dir, first = TEXT_FIRST_ASC.includes(id) ? 'ASC' : 'DESC';
                const dir = was ? (was === 'ASC' ? 'DESC' : 'ASC') : first;
                if (server) serverSort(id, dir);
                else { pageSort = { header: label, dir }; moved = true; AE.track('fixes:woSortPage'); paint(); }
              });
              (th.querySelector('span, div') || th).append(b);
            }
            const dir = server ? (order.split(',')[0] === id ? order.split(',')[1] : '') : (pageSort && pageSort.header === label ? pageSort.dir : '');
            if ((b.dataset.dir || '') !== (dir || '')) { if (dir) b.dataset.dir = dir; else delete b.dataset.dir; }
          }
          applyPageSort(table, headers);
        }
        let queued = false;
        new MutationObserver(() => { if (!queued) { queued = true; setTimeout(() => { queued = false; try { paint(); } catch (e) { AE.noteError('woSort', e); } }, 120); } })
          .observe(document.body, { childList: true, subtree: true });
        paint();
      },
      scanNav() {
        const GAP_MS = 60; // longest pause between a scanner's keys (Portal uses 40)
        const PORTAL_EVENT = 'scanDetected', RESEND_EVENT = 'aethernet:scan';
        // Portal's scan event has to come from the page itself (the scan is in
        // its `detail`), so a tiny page script sends it for us. Plain string: see Glamour.
        const hook = () => {
          if (document.getElementById('ae-scan-hook')) return;
          const s = document.createElement('script');
          s.id = 'ae-scan-hook';
          s.textContent = '(function (a, p) { document.addEventListener(a, function (e) { dispatchEvent(new CustomEvent(p, { detail: { scan: String(e.detail) } })); }); })(' +
            JSON.stringify(RESEND_EVENT) + ',' + JSON.stringify(PORTAL_EVENT) + ');';
          (document.head || document.documentElement).append(s);
        };
        let portalSaw = 0;
        window.addEventListener(PORTAL_EVENT, () => { portalSaw = performance.now(); });

        const WO_RE = /^(?:WO)?(\d{9})$/i, ITEM_RE = /^([A-Za-z0-9]{2,})-(\d{10,})$/;
        const path = () => location.pathname;
        const busyTyping = () => {
          const a = document.activeElement;
          return !!a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
        };
        // A dialog that blocks the page. Non-modal ones (aria-modal="false", e.g. Appcues announcement
        // boxes) and Aethernet's own cards don't count.
        // Really on screen: Portal keeps some dialogs in the page all the time, hidden with visibility:hidden inside a
        // transparent wrapper (store-change-request modals, Employee login; seen Oct 2, 2026). They took up layout, so
        // a layout-only check counted them as open and every scan was refused ("a dialog is open").
        const seen = (d) => (d.checkVisibility ? d.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
          : d.offsetParent !== null && getComputedStyle(d).visibility !== 'hidden');
        const openDialogs = () => [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
          .filter((d) => seen(d) && !d.closest('.sg') && d.getAttribute('aria-modal') !== 'false');
        const dialogOpen = () => openDialogs().length > 0;
        // Inventory, check-in and check-out are data entry: blocked, except the pages that are only lists or
        // look-ups (Garrett, Oct 2, 2026). Pages Portal adds there later stay blocked until they're added here.
        const LIST_PAGES = [
          /^\/check-in\/arrivals(\/business)?\/?$/,                 // Arrivals (not the check-in steps, /check-in)
          /^\/check-in\/arrivals\/\d+\/?$/,                          // an arrival in the drawer
          /^\/boh\/inventory\/?$/,                                   // Inventory home
          /^\/boh\/inventory\/(purchase-orders|counts|rma-buyback)\/?$/, // lists (not a PO, receiving, or a count)
          /^\/boh\/inventory\/store-products(\/[^/]+)?\/?$/,          // store products and a product's page
        ];
        const listPage = () => LIST_PAGES.some((re) => re.test(path()));
        const scanPage = () => /^\/(boh|check-in|check-out)(\/|$)/.test(path()) && !listPage();
        const itemPage = () => path() === '/' || /^\/repair\/workorders\/?$/.test(path()) || /^\/customer(s)?(\/|$)/.test(path()) || listPage();
        // Same-tab route change without a reload: Portal's router (and single-spa) follow popstate.
        const go = (url) => { history.pushState(null, '', url); dispatchEvent(new PopStateEvent('popstate', { state: null })); };

        async function act(scan, why, devTools) {
          const wo = scan.match(WO_RE), item = scan.match(ITEM_RE);
          if (!wo && !item) return 'not a WO or item label';
          if (busyTyping() && !devTools) return 'typing in a field';
          if (dialogOpen()) return 'a dialog is open';
          if (wo) {
            if (scanPage()) return 'scans are data entry on this page';
            const id = wo[1];
            if (path().startsWith('/repair/workorder/' + id)) return 'already on WO ' + id;
            try { await AE.api('GET', '/api/workorder/' + id); } catch (e) {
              AE.toast('Scan', "Couldn't open WO " + id + ': ' + (/HTTP 404/.test(e.message) ? 'no such work order.' : e.message), 'err', 6000);
              return 'WO lookup failed';
            }
            go('/repair/workorder/' + id);
            AE.track('fixes:scanWo');
            return 'opened WO ' + id + (why ? ' (' + why + ')' : '');
          }
          if (!itemPage()) return 'item scans belong to this page';
          go('/boh/inventory/store-products/' + encodeURIComponent(item[1]));
          AE.track('fixes:scanItem');
          return 'opened item ' + item[1];
        }

        /*
          Scan debugging (Settings → Master's Mend → Scan to open → Show scan debugging):
          a log, bottom right, of every burst of keys (4+): what arrived, how fast
          (slowest gap), what ended it, whether Portal saw a scan, and what
          Aethernet did and why (focus, open dialogs, page).
        */
        const dbg = (() => {
          if (!on.scanDebug) return null;
          const ID = 'ae-scan-debug', rows = [];
          document.head.append(AE.h('style', null, `
            #${ID} { position:fixed; right:16px; bottom:16px; z-index:2147483645; width:440px; max-height:46vh; overflow:auto; padding:10px 12px; font:12px/1.4 ui-monospace, Menlo, monospace; }
            #${ID} .hd { display:flex; align-items:center; gap:8px; font:700 13px Apercu, "Helvetica Neue", Arial, sans-serif; margin-bottom:6px; }
            #${ID} .hd span { flex:1; }
            #${ID} .r { border-top:1px solid var(--aui-outline-soft, #eeedf1); padding:5px 0; overflow-wrap:anywhere; }
            #${ID} .ok { color:var(--aui-status-success, #136d31); font-weight:700; }
            #${ID} .no { color:var(--aui-status-error, #b91a24); font-weight:700; }
            #${ID} .soft { color:var(--aui-on-surface-soft, #5d5e61); }
          `));
          const box = AE.h('div', { id: ID, class: 'sg sg-card' });
          const paint = () => {
            if (!box.isConnected) document.body.append(box);
            box.replaceChildren(AE.h('div', { class: 'hd' }, AE.h('span', null, 'Scan debugging'),
              AE.h('button', { type: 'button', class: 'sg-btn', style: 'height:24px;font-size:12px', onclick: () => { rows.length = 0; paint(); } }, 'Clear'),
              AE.h('button', { type: 'button', class: 'sg-btn', style: 'height:24px;font-size:12px', title: 'Copy the log (to paste in a bug report)',
                onclick: () => navigator.clipboard.writeText(rows.map((r) => r.text).join('\n')).then(() => AE.toast('Scan debugging', 'Log copied.', 'ok')) }, 'Copy')),
            ...(rows.length ? rows.map((r) => AE.h('div', { class: 'r', html: r.html })) : [AE.h('div', { class: 'soft' }, 'Scan something. Every burst of 4+ keys shows up here.')]));
          };
          const esc = AE.esc;
          AE.every(1500, () => { if (!box.isConnected) paint(); });
          return {
            add(o) {
              const focus = document.activeElement && document.activeElement !== document.body
                ? document.activeElement.tagName.toLowerCase() + (document.activeElement.id ? '#' + document.activeElement.id : '') + (document.activeElement.name ? '[name=' + document.activeElement.name + ']' : '') : 'nothing';
              const dl = openDialogs().map((d) => (d.getAttribute('aria-label') || d.getAttribute('data-testid') || d.className.toString().slice(0, 30) || d.tagName.toLowerCase()));
              const page = o.page || location.pathname;
              const text = new Date().toLocaleTimeString() + ' "' + o.chars + '" (' + o.chars.length + ' keys, slowest gap ' + o.gap + ' ms, ended by ' + o.end + ') · Portal saw a scan: ' +
                (o.portal == null ? '—' : o.portal ? 'yes' : 'no') + ' · ' + (o.result || '') + ' · page ' + page + ' · focus: ' + focus + ' · dialogs: ' + (dl.join(', ') || 'none');
              const good = /^opened/.test(o.result || '');
              rows.unshift({ text, html: '<b>' + esc(new Date().toLocaleTimeString()) + '</b> "' + esc(o.chars) + '" <span class="soft">' + o.chars.length + ' keys · slowest gap ' + o.gap + ' ms · ended by ' + esc(o.end) +
                '</span><br>Portal saw a scan: <b>' + (o.portal == null ? '—' : o.portal ? 'yes' : 'no') + '</b> · <span class="' + (good ? 'ok' : 'no') + '">' + esc(o.result || '') + '</span>' +
                '<br><span class="soft">page ' + esc(page) + ' · focus: ' + esc(focus) + ' · dialogs: ' + esc(dl.join(', ') || 'none') + '</span>' });
              rows.length = Math.min(rows.length, 30);
              paint();
            },
          };
        })();

        // The last 10 scan attempts, always kept (in memory only) and sent with bug reports (06-feedback diagnostics):
        // WO numbers and item labels, never customer details.
        AE.scanLog = [];
        const record = (o) => {
          AE.scanLog.push({ at: new Date().toISOString(), scan: o.chars, keys: o.chars.length, slowestGapMs: o.gap, end: o.end, portalSaw: o.portal,
            result: o.result, page: o.page || location.pathname, dialogs: openDialogs().length, typing: busyTyping() });
          if (AE.scanLog.length > 10) AE.scanLog.shift();
          if (dbg) dbg.add(o);
        };

        // Scanner = keys arriving faster than any person types, ending in Enter.
        let buf = '', last = 0, slowest = 0, raw = '';
        // Debugging: a burst that ended without Enter (a pause, Tab, …) is logged too, so a scanner set up differently shows.
        const flushRaw = (end) => { if (raw.length >= 4) record({ chars: raw, gap: Math.round(slowest), end, result: 'not acted on (no Enter at the end)' }); raw = ''; slowest = 0; };
        window.addEventListener('keydown', (e) => {
          if (e.isComposing || /^(Shift|Control|Alt|Meta|CapsLock)$/.test(e.key)) return;
          const t = e.timeStamp, gap = t - last, quick = gap <= GAP_MS;
          last = t;
          if (!quick && raw) flushRaw('a pause of ' + Math.round(gap) + ' ms');
          else if (raw) slowest = Math.max(slowest, gap);
          if (e.key === 'Enter') {
            const scan = quick ? buf : '';
            const chars = raw, gapMax = Math.round(slowest);
            buf = ''; raw = ''; slowest = 0;
            if (scan.length < 4) { if (chars.length >= 4) record({ chars, gap: gapMax, end: 'Enter', result: 'too slow for a scanner (gaps over ' + GAP_MS + ' ms): ignored' }); return; }
            const before = portalSaw, page = location.pathname;
            setTimeout(() => {  // Portal handles the Enter (keypress) after this keydown
              const portal = portalSaw !== before;
              if (!portal) { hook(); document.dispatchEvent(new CustomEvent(RESEND_EVENT, { detail: scan })); }
              act(scan).then((r) => {
                console.debug('[' + AE_NAME + '] scan "' + scan + '": ' + r);
                record({ chars: scan, gap: gapMax, end: 'Enter', portal, result: r, page });
              });
            }, 60);
            return;
          }
          if (e.key === 'Tab' && raw) { flushRaw('Tab'); buf = ''; return; }
          if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) { if (raw) flushRaw(e.key); buf = ''; return; }
          buf = quick ? buf + e.key : e.key;
          raw = quick ? raw + e.key : e.key;
        }, true);
        AE.hooks.scan = (text) => act(String(text).trim(), 'dev tools', true); // dev tools: act on a pretend scan
      },
    };
    for (const [id] of AE.fixesInfo) {
      if (on[id] === false || !FIXES[id]) continue;
      try { FIXES[id](); } catch (e) { AE.noteError("Master's Mend: " + id, e); console.error('[' + AE_NAME + "] Master's Mend: " + id + ' failed', e); }
    }
  },
});
