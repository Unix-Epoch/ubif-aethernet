// ==UserScript==
// @name         UBIF Portal — Galaxy Diagnostics Exception button
// @namespace    garrett.ubif
// @version      1.2
// @description  Adds a draggable, collapsible button on a Samsung work order (once a GSPN ticket exists) that opens the Asurion "Galaxy Diagnostics Tool" exception request form and auto-fills it from the WO's own data.
// @match        https://portal.ubreakifix.net/*
// @match        https://forms-prod.sprinklr.com/guided-workflows/6544db26d4b8393a0b65ebb7*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @run-at       document-idle
// ==/UserScript==

/*
  Two halves of one script, sharing data across the two sites via
  GM_setValue/GM_getValue (Tampermonkey scopes that storage per-script, not
  per-domain, so both @match blocks below can read/write the same key even
  though portal.ubreakifix.net and forms-prod.sprinklr.com are different
  origins — a plain button click can't hand data to a new tab on another
  origin any other way).

  Part A runs on the work order page: watches for the "GSPN No. ######"
  badge to appear (that's when a GSPN ticket actually exists on the WO),
  shows a button, and on click pulls IMEI / device name / GSPN ticket / WO
  number from the portal's own API and stashes them for part B.

  Part B runs on the Sprinklr exception-request form: on load, picks up
  what part A stashed, drives the cascading dropdowns (Issue Type ->
  Exception Type -> Exception Reason) and fills every text field. It does
  NOT click Submit — you review and submit it yourself.

  Part A matches the whole portal, not just /repair/workorder/*:
  Tampermonkey only injects on a full page load, and the portal is a
  single-page app — clicking into a WO from the list changes the URL
  without a load, so a narrower @match never ran until a manual refresh.
  tick() checks the path itself.

  Config you might want to change is right below.
*/

const CONFIG = {
  EMAIL: 'garrett.green@ubreakifix.com',
  TECHNICIAN_NAME: 'Garrett Green',
  TOOL_VERSION: 'Latest',
  STORE_EMAIL: '',                 // left blank on purpose
  UBIF_LOCATION_SEARCH: 'Newport News',   // typed into the store picker to filter it
  UBIF_LOCATION_EXACT: '914 Newport News', // exact option text to click
  REPAIR_LOCATION_TYPE: 'Store',
  ISSUE_TYPE: 'Exception Request',
  EXCEPTION_TYPE: 'Galaxy Diagnostic Tool',
  EXCEPTION_REASON: 'Asurion Repair',
  DESCRIPTION_TEXT: 'ER',
};

// Handoffs are a map keyed by WO id, not one shared slot — two forms opened
// close together used to overwrite each other (the first tab got the
// second WO's data, the second got nothing). Each form tab takes the
// oldest waiting handoff.
const HANDOFFS_KEY = 'gde_handoffs';
const HANDOFF_MAX_AGE_MS = 10 * 60 * 1000; // 10 min — ignore a stale leftover payload
const FORM_URL =
  'https://forms-prod.sprinklr.com/guided-workflows/6544db26d4b8393a0b65ebb7?gwId=744690&viewType=FULL_PAGE';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setNativeValue(el, value) {
  const proto = Object.getPrototypeOf(el);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// ---------------------------------------------------------------------
// PART A — the work order page
// ---------------------------------------------------------------------
if (location.hostname === 'portal.ubreakifix.net') {
  (function partA() {
    let injectedForWoId = null;

    // Position/collapsed state persist via GM_setValue so the button stays
    // where Garrett last put it (and stays collapsed if he collapsed it)
    // across page reloads and SPA route changes — tick() below tears the
    // button down and rebuilds it often (any time the GSPN badge appears/
    // disappears), so this can't just live in a local variable.
    const POS_KEY = 'gde_btn_pos';
    const COLLAPSED_KEY = 'gde_btn_collapsed';
    const loadPos = () => GM_getValue(POS_KEY, { right: 16, bottom: 16 });
    const savePos = (pos) => GM_setValue(POS_KEY, pos);
    const loadCollapsed = () => GM_getValue(COLLAPSED_KEY, false);
    const saveCollapsed = (v) => GM_setValue(COLLAPSED_KEY, v);

    // Hoisted out of makeButton() so repeated rebuilds (tick() recreates the
    // button often) don't keep stacking duplicate window-level listeners —
    // these two are added exactly once per page load; the grip's mousedown
    // handler below just points dragState at whichever wrap currently exists.
    let dragState = null;
    // mouseup nulls dragState out before the browser's own subsequent click
    // event fires on the same element, so main.onclick can't read
    // dragState.moved directly — this flag survives that gap instead.
    let suppressNextClick = false;
    window.addEventListener('mousemove', (e) => {
      if (!dragState) return;
      const dx = e.clientX - dragState.startX;
      const dy = e.clientY - dragState.startY;
      const right = Math.max(0, dragState.startRight - dx);
      const bottom = Math.max(0, dragState.startBottom - dy);
      dragState.wrap.style.right = right + 'px';
      dragState.wrap.style.bottom = bottom + 'px';
      dragState.moved = true;
    });
    window.addEventListener('mouseup', () => {
      if (!dragState) return;
      const right = parseInt(dragState.wrap.style.right, 10) || 0;
      const bottom = parseInt(dragState.wrap.style.bottom, 10) || 0;
      savePos({ right, bottom });
      if (dragState.moved) {
        // Only the click belonging to *this* mouseup gets swallowed. A drag
        // usually ends on the grip, so that click never reaches main — if
        // the flag outlived this event, it ate the next real press instead.
        suppressNextClick = true;
        setTimeout(() => { suppressNextClick = false; }, 0);
      }
      dragState = null;
    });

    // Keep the saved position on-screen: a drag to the edge (no upper
    // bound before) or a smaller window later could strand the button
    // out of reach, with the bad position saved for every future page.
    function clampToViewport(wrap) {
      const rect = wrap.getBoundingClientRect();
      const maxRight = Math.max(0, window.innerWidth - rect.width);
      const maxBottom = Math.max(0, window.innerHeight - rect.height);
      const right = Math.min(Math.max(0, parseInt(wrap.style.right, 10) || 0), maxRight);
      const bottom = Math.min(Math.max(0, parseInt(wrap.style.bottom, 10) || 0), maxBottom);
      wrap.style.right = right + 'px';
      wrap.style.bottom = bottom + 'px';
      return { right, bottom };
    }
    window.addEventListener('resize', () => {
      const wrap = document.getElementById('gde-file-btn');
      if (wrap) savePos(clampToViewport(wrap));
    });

    function currentWoId() {
      const m = location.pathname.match(/\/workorder\/(\d+)/);
      return m ? m[1] : null;
    }

    function gspnTicketOnPage() {
      const m = document.body.innerText.match(/GSPN No\.\s*([0-9]+)/);
      return m ? m[1] : null;
    }

    async function collectData(woId) {
      const res = await fetch('/api/workorder/' + woId, { credentials: 'include' });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* handled below */ }
      if (!res.ok || !json || !json.workorder) {
        throw new Error(
          res.status === 401 || res.status === 403 || !json
            ? 'your portal session looks expired — refresh the page / log in again, then retry'
            : 'the portal returned HTTP ' + res.status
        );
      }
      const wo = json.workorder;
      const device = wo.CustomerDevice || {};
      const catalog = device.DeviceCatalog || {};
      const partnerJob = wo.PartnerJob || {};
      const attrs = partnerJob.PartnerJobAttributes || [];
      // attribute type 53 is the GSPN ticket number shown as "GSPN No." on
      // the page (confirmed against two real WOs) — fall back to scraping
      // the badge text if the API shape ever changes.
      const gspnAttr = attrs.find((a) => a.partnerJobAttributeTypeId === 53);
      return {
        woId,
        imei: device.imei || '',
        deviceName: catalog.name || '',
        gspn: (gspnAttr && gspnAttr.value) || gspnTicketOnPage() || '',
        ts: Date.now(),
      };
    }

    const FULL_LABEL = '📋 File Galaxy Diagnostics Exception';
    const COLLAPSED_LABEL = '📋';

    function makeButton() {
      const pos = loadPos();
      const collapsed = loadCollapsed();

      const wrap = document.createElement('div');
      wrap.id = 'gde-file-btn';
      wrap.style.cssText =
        'position:fixed;z-index:2147483647;right:' + pos.right + 'px;bottom:' + pos.bottom + 'px;' +
        'display:flex;align-items:stretch;border-radius:8px;overflow:hidden;' +
        'box-shadow:0 6px 20px rgba(0,0,0,.3);';

      // Drag handle — grabbing anywhere else (the button body) still fires
      // its normal click, so dragging is opt-in via this dedicated grip
      // rather than fighting the button's own click handler.
      const grip = document.createElement('div');
      grip.textContent = '⠿';
      grip.style.cssText =
        'cursor:move;background:#0f3f9e;color:#cdd9f7;display:flex;align-items:center;' +
        'justify-content:center;width:18px;font:13px system-ui,sans-serif;user-select:none;';
      grip.title = 'Drag to move · double-click to reset position';
      grip.addEventListener('dblclick', () => {
        wrap.style.right = '16px';
        wrap.style.bottom = '16px';
        savePos({ right: 16, bottom: 16 });
      });
      grip.addEventListener('mousedown', (e) => {
        const rect = wrap.getBoundingClientRect();
        dragState = {
          wrap,
          startX: e.clientX,
          startY: e.clientY,
          startRight: window.innerWidth - rect.right,
          startBottom: window.innerHeight - rect.bottom,
          moved: false,
        };
        e.preventDefault();
      });

      const main = document.createElement('button');
      main.textContent = collapsed ? COLLAPSED_LABEL : FULL_LABEL;
      main.title = collapsed ? 'File Galaxy Diagnostics Exception' : '';
      main.style.cssText =
        'background:#1a56db;color:#fff;border:0;cursor:pointer;white-space:nowrap;' +
        'font:600 13px system-ui,sans-serif;padding:' + (collapsed ? '10px 12px' : '10px 16px');

      const collapseToggle = document.createElement('div');
      collapseToggle.textContent = collapsed ? '»' : '«';
      collapseToggle.title = collapsed ? 'Expand' : 'Collapse';
      collapseToggle.style.cssText =
        'cursor:pointer;background:#0f3f9e;color:#cdd9f7;display:flex;align-items:center;' +
        'justify-content:center;width:18px;font:13px system-ui,sans-serif;user-select:none;';
      collapseToggle.onclick = (e) => {
        e.stopPropagation();
        const nowCollapsed = !loadCollapsed();
        saveCollapsed(nowCollapsed);
        main.textContent = nowCollapsed ? COLLAPSED_LABEL : FULL_LABEL;
        main.title = nowCollapsed ? 'File Galaxy Diagnostics Exception' : '';
        main.style.padding = nowCollapsed ? '10px 12px' : '10px 16px';
        collapseToggle.textContent = nowCollapsed ? '»' : '«';
        collapseToggle.title = nowCollapsed ? 'Expand' : 'Collapse';
      };

      main.onclick = async () => {
        // a drag that just ended shouldn't also fire the file-exception
        // action — the mouseup that ends a drag lands on this same button.
        if (suppressNextClick) {
          suppressNextClick = false;
          return;
        }
        const woId = currentWoId();
        if (!woId) return;
        const labelBefore = main.textContent;
        main.disabled = true;
        main.textContent = loadCollapsed() ? '⏳' : 'Gathering WO data…';
        // Open the tab now, while this still counts as a user click — after
        // the await below, a slow API response makes Chrome treat window.open
        // as an unrequested popup and block it silently.
        const formTab = window.open('about:blank', '_blank');
        try {
          const data = await collectData(woId);
          if (!data.gspn) {
            if (formTab) formTab.close();
            alert('No GSPN ticket number found on this work order — nothing to file yet.');
            return;
          }
          const handoffs = GM_getValue(HANDOFFS_KEY, {});
          handoffs[woId] = data;
          GM_setValue(HANDOFFS_KEY, handoffs);
          if (formTab) formTab.location.href = FORM_URL;
          else window.open(FORM_URL, '_blank');
        } catch (e) {
          if (formTab) formTab.close();
          alert('Could not gather WO data: ' + (e && e.message ? e.message : e));
        } finally {
          main.disabled = false;
          main.textContent = labelBefore;
        }
      };

      wrap.appendChild(grip);
      wrap.appendChild(main);
      wrap.appendChild(collapseToggle);
      document.body.appendChild(wrap);
      savePos(clampToViewport(wrap));
    }

    function tick() {
      const woId = currentWoId();
      const existing = document.getElementById('gde-file-btn');
      if (!woId) {
        if (existing) existing.remove();
        injectedForWoId = null;
        return;
      }
      const ticket = gspnTicketOnPage();
      // `!existing` too: if the portal re-renders and drops the button,
      // put it back rather than waiting for a different WO.
      if (ticket && (injectedForWoId !== woId || !existing)) {
        if (existing) existing.remove();
        makeButton();
        injectedForWoId = woId;
      } else if (!ticket && existing) {
        // navigated to a WO (or a state) with no GSPN ticket — hide it
        existing.remove();
        injectedForWoId = null;
      }
    }

    setInterval(tick, 1000); // the portal is a single-page app; poll for route/DOM changes
    tick();
  })();
}

// ---------------------------------------------------------------------
// PART B — the Sprinklr exception-request form
// ---------------------------------------------------------------------
if (location.hostname === 'forms-prod.sprinklr.com') {
  (function partB() {
    function fieldByLabel(labelText) {
      const lab = [...document.querySelectorAll('label')].find(
        (l) => l.textContent.trim() === labelText
      );
      if (!lab) return null;
      let container = lab.parentElement;
      for (let i = 0; i < 5 && container; i++) {
        const input = container.querySelector('input, textarea');
        if (input) return input;
        container = container.parentElement;
      }
      return null;
    }

    async function waitForField(labelText, timeoutMs = 4000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const f = fieldByLabel(labelText);
        if (f) return f;
        await sleep(100);
      }
      return null;
    }

    async function fillText(labelText, value) {
      const el = await waitForField(labelText);
      if (!el) return false;
      setNativeValue(el, value);
      return true;
    }

    // For the cascading dropdowns: click to open, optionally type to
    // filter, then click the matching rendered option. Re-queries the
    // field fresh right before each step — these components sometimes
    // remount when sibling fields appear/disappear, so a cached element
    // reference can go stale.
    async function selectOption(labelText, optionText, typeText) {
      const input = await waitForField(labelText);
      if (!input) return false;
      input.click();
      await sleep(250);
      if (typeText) {
        setNativeValue(input, typeText);
        await sleep(400);
      }
      let opt = null;
      for (let t = 0; t < 15 && !opt; t++) {
        await sleep(100);
        opt = [...document.querySelectorAll('div,li,span')].find(
          (e) =>
            e.children.length === 0 &&
            e.textContent.trim() === optionText &&
            e.getClientRects().length > 0
        );
      }
      if (!opt) return false;
      opt.click();
      await sleep(200);
      return true;
    }

    function banner(text, color) {
      let el = document.getElementById('gde-banner');
      if (!el) {
        el = document.createElement('div');
        el.id = 'gde-banner';
        el.style.cssText =
          'position:fixed;z-index:2147483647;left:16px;top:16px;padding:10px 16px;border-radius:8px;' +
          'color:#fff;font:600 13px system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.3);max-width:420px';
        document.body.appendChild(el);
      }
      el.style.background = color;
      el.textContent = text;
    }

    // Take the oldest fresh handoff and remove it (so a page refresh doesn't
    // re-fill), dropping any stale leftovers along the way.
    function takeHandoff() {
      const handoffs = GM_getValue(HANDOFFS_KEY, {});
      const now = Date.now();
      let oldest = null;
      for (const [id, d] of Object.entries(handoffs)) {
        if (!d || now - d.ts > HANDOFF_MAX_AGE_MS) { delete handoffs[id]; continue; }
        if (!oldest || d.ts < oldest.ts) oldest = d;
      }
      if (oldest) delete handoffs[oldest.woId];
      if (Object.keys(handoffs).length) GM_setValue(HANDOFFS_KEY, handoffs);
      else GM_deleteValue(HANDOFFS_KEY);
      return oldest;
    }

    async function run() {
      const data = takeHandoff();
      if (!data) return; // not opened via the WO-page button, or stale

      banner('Auto-filling from WO #' + data.woId + '…', '#1a56db');

      // wait for the form itself to be ready
      const email = await waitForField('Your email address', 8000);
      if (!email) {
        banner('Form did not load in time — fill it in by hand.', '#c0392b');
        return;
      }

      // Every step reports success; anything that didn't fill is listed in
      // the final banner instead of a green "Filled" over a half-empty form.
      const failed = [];
      const step = async (label, ok) => { if (!(await ok)) failed.push(label); };

      setNativeValue(email, CONFIG.EMAIL);
      await step('UBIF Location', selectOption('UBIF Location', CONFIG.UBIF_LOCATION_EXACT, CONFIG.UBIF_LOCATION_SEARCH));
      await step('Repair Location Type', selectOption('Repair Location Type', CONFIG.REPAIR_LOCATION_TYPE));
      await step('Technician Name', fillText('Technician Name', CONFIG.TECHNICIAN_NAME));

      await step('Issue Type', selectOption('Issue Type', CONFIG.ISSUE_TYPE));
      await waitForField('Exception Type');
      await step('Exception Type', selectOption('Exception Type', CONFIG.EXCEPTION_TYPE));
      await waitForField('Galaxy Diagnostic Exception Reason');
      await step('Exception Reason', selectOption('Galaxy Diagnostic Exception Reason', CONFIG.EXCEPTION_REASON));

      await waitForField('IMEI'); // last field to appear in the cascade — once it's there, the rest are too

      await step('Tool Version', fillText('Galaxy Diagnostic Tool Version', CONFIG.TOOL_VERSION));
      await step('Device Full SKU', fillText('Device Full SKU', data.deviceName));
      await step('GSPN Ticket Number', fillText('GSPN Ticket Number', data.gspn));
      await step('Portal Work Order Number', fillText('Portal Work Order Number', data.woId));
      await step('IMEI', fillText('IMEI', data.imei));
      await step('Description', fillText('Description', CONFIG.DESCRIPTION_TEXT));
      if (CONFIG.STORE_EMAIL) await step('Store email', fillText('Store email address', CONFIG.STORE_EMAIL));

      if (!data.imei) failed.push('IMEI (none on the WO)');
      if (!data.deviceName) failed.push('Device Full SKU (none on the WO)');

      if (failed.length) {
        banner(
          'WO #' + data.woId + ': could NOT fill ' + failed.join(', ') +
            ' — fill those in by hand before submitting.',
          '#c0392b'
        );
      } else {
        banner('Filled from WO #' + data.woId + ' — check it over, then hit Submit yourself.', '#2e7d32');
      }
    }

    // the guided-workflow form renders client-side; give it a moment, then run
    setTimeout(run, 800);
  })();
}
