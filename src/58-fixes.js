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
        anywhere except inventory (/boh), check-in and check-out, where
        scans are data entry. Checked against Portal first.
      · item label (<item number>-<10+ digit serial>) → opens the item's
        page, but only from the dashboard, WO lists, customers and the
        store-products pages. On a WO, Portal adds it to the WO instead.
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
    no error state: one failed or blocked request (seen on Firefox, Oct 2026)
    and it spins forever. If the page hasn't drawn its Reports card after
    8 s, Aethernet notes why (the request's RTK status/error, whether the
    browser saw the request at all, Portal's own script errors) where bug
    reports pick it up, says so, and has Portal try again by switching the
    page away and straight back (a fresh mount re-runs a failed query), at
    most twice per visit.

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
  ['reportsRetry', 'Reports page retry', 'If Portal\'s Reports page is stuck loading, Aethernet tries it again and notes why it got stuck (included when you send a bug report).'],
  ['woSort', 'Sort by any column', 'Every column of the Work orders list can be sorted. Most sort across all pages; a few that Portal can\'t sort (like Customer) sort the page you\'re on.'],
  ['scanNav', 'Scan to open', 'Scan a WO label to open the WO, or an item label to open the item (on a WO, items are added to it as usual). Never on inventory, check-in or check-out pages, or while typing in a field.'],
];

AE.crystal({
  id: 'fixes',
  name: "Master's Mend",
  sites: ['portal.ubreakifix.net'],
  run() {
    const on = AE.settings.fixes || {};
    const FIXES = {
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
        const PATH = /^\/reporting\/metrics\/?$/, WAIT = 8000, MAX = 2;
        let visit = 0, tries = 0, timer = null, lastPath = '';
        const loaded = () => !!document.querySelector('.reports-card');
        const go = (url) => { history.pushState(null, '', url); dispatchEvent(new PopStateEvent('popstate', { state: null })); };
        function diagnose() {
          const st = AE.portal('status', { endpoint: 'getMetricsConfig' }) || {};
          const seen = performance.getEntriesByType('resource').filter((e) => /\/api\/reporting\/metrics(\?|$)/.test(e.name));
          const net = seen.length ? seen[seen.length - 1] : null;
          const why = !st.found ? (st.stores ? "Portal never asked for the reports setup" : "Portal's page didn't start (no app state found)")
            : st.status === 'pending' ? 'the reports setup request is still waiting on the server'
            : st.status === 'rejected' ? 'the reports setup request failed' + (st.error ? ' (' + st.error.slice(0, 120) + ')' : '')
            : st.hasData ? 'the data arrived but the page didn\'t draw' : 'the request finished with no data';
          const detail = { why, rtk: st, browserSawRequest: !!net,
            request: net ? { status: net.responseStatus || null, ms: Math.round(net.duration), bytes: net.transferSize } : null,
            pageErrors: AE.pageErrors.slice(-3), ua: navigator.userAgent.slice(0, 160) };
          AE.noteError('Reports page stuck', JSON.stringify(detail));
          console.warn('[' + AE_NAME + '] Reports page stuck:', detail);
          return { why, blocked: st.found && st.status === 'rejected' && !net };
        }
        function check(v) {
          if (v !== visit || !PATH.test(location.pathname) || loaded()) return;
          const { why, blocked } = diagnose();
          if (tries >= MAX) {
            AE.toast('Reports still won\'t load', why + (blocked ? '. The browser never sent it, so an extension or privacy setting may be blocking it.' : '.') +
              ' Reload the page, and if it keeps happening, use Send feedback → Bug (the details are included).', 'err', 15000);
            return;
          }
          tries++;
          AE.toast('Reports was stuck', why + (blocked ? ' (the browser never sent it — possibly blocked)' : '') + '. Trying again…', 'busy', 4000);
          AE.track('fixes:reportsRetry');
          // A fresh mount of the page re-runs the failed request.
          go('/');
          setTimeout(() => { go('/reporting/metrics'); }, 400);
        }
        AE.every(500, () => {
          const p = location.pathname;
          if (p === lastPath) return;
          const back = PATH.test(p) && tries > 0 && lastPath === '/';
          lastPath = p;
          if (!PATH.test(p)) { if (!(p === '/' && tries > 0)) tries = 0; return; } // our own hop to '/' keeps the count
          const v = ++visit;
          clearTimeout(timer);
          timer = setTimeout(() => check(v), back ? WAIT + 2000 : WAIT);
        });
        AE.hooks.reportsDiagnose = diagnose; // dev tools
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
        const dialogOpen = () => [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
          .some((d) => d.offsetParent !== null && !d.closest('.sg')); // Aethernet's own cards don't count
        const scanPage = () => /^\/(boh|check-in|check-out)(\/|$)/.test(path());
        const itemPage = () => path() === '/' || /^\/repair\/workorders\/?$/.test(path()) || /^\/customer(s)?(\/|$)/.test(path()) ||
          /^\/boh\/inventory\/store-products(\/|$)/.test(path());
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

        // Scanner = keys arriving faster than any person types, ending in Enter.
        let buf = '', last = 0;
        window.addEventListener('keydown', (e) => {
          if (e.isComposing || /^(Shift|Control|Alt|Meta|CapsLock)$/.test(e.key)) return;
          const t = e.timeStamp, quick = t - last <= GAP_MS;
          last = t;
          if (e.key === 'Enter') {
            const scan = quick ? buf : '';
            buf = '';
            if (scan.length < 4) return;
            const before = portalSaw;
            setTimeout(() => {  // Portal handles the Enter (keypress) after this keydown
              if (portalSaw === before) { hook(); document.dispatchEvent(new CustomEvent(RESEND_EVENT, { detail: scan })); }
              act(scan).then((r) => console.debug('[' + AE_NAME + '] scan "' + scan + '": ' + r));
            }, 60);
            return;
          }
          if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) { buf = ''; return; }
          buf = quick ? buf + e.key : e.key;
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
