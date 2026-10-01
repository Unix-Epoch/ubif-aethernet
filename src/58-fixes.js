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
*/
AE.fixesInfo = [
  ['logoLink', 'Logo link', 'The ubreakifix logo is a real link to the dashboard: middle-click or right-click it to open a new tab.'],
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
