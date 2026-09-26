/*
  Galaxy Diagnostics exception — two halves sharing data through
  Tampermonkey storage (GM_*, scoped per script, not per site):

  A. Portal WO page: once a "GSPN No. ######" badge exists, shows a
     draggable, collapsible button. Click → gathers IMEI / device name /
     GSPN ticket / WO number from the portal API, plus the technician,
     email and store from the logged-in user (overridable in settings),
     and opens the Sprinklr form in a new tab.
  B. Sprinklr form: picks up that handoff and fills every field, including
     the Issue → Exception → Reason cascade. It does NOT submit.

  Filling needs real interactions: element.click() for the custom
  dropdowns, and the native value setter + input event for text fields
  (plain .value = doesn't register with React).
*/
SG.tool({
  id: 'galaxy',
  name: 'Galaxy Diagnostics exception',
  sites: ['portal.ubreakifix.net', 'forms-prod.sprinklr.com'],
  run() {
    const { h, icon, sleep } = SG;
    // Handoffs are a map keyed by WO id, so two forms opened close together
    // each get their own WO's data. Each form tab takes the oldest one.
    const HANDOFFS_KEY = 'gde_handoffs';
    const HANDOFF_MAX_AGE_MS = 10 * 60 * 1000;
    const FORM_URL = 'https://forms-prod.sprinklr.com/guided-workflows/6544db26d4b8393a0b65ebb7?gwId=744690&viewType=FULL_PAGE';
    const FIXED = { REPAIR_LOCATION_TYPE: 'Store', ISSUE_TYPE: 'Exception Request', EXCEPTION_TYPE: 'Galaxy Diagnostic Tool', EXCEPTION_REASON: 'Asurion Repair' };

    function setNativeValue(el, value) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Small status card, top-left (form) or bottom-left (portal).
    function toast(text, kind, where = 'top') {
      SG.ensureCss();
      let el = document.getElementById('sg-galaxy-toast');
      if (!el) {
        el = h('div', { id: 'sg-galaxy-toast', class: 'sg sg-card', style: 'position:fixed;z-index:2147483647;left:16px;max-width:440px;padding:12px 16px;display:flex;gap:10px;align-items:flex-start;font-size:14px;line-height:1.4' });
        document.body.appendChild(el);
      }
      el.style.top = where === 'top' ? '16px' : '';
      el.style.bottom = where === 'top' ? '' : '16px';
      const mark = kind === 'busy' ? '<span class="sg-spin" style="margin-top:2px"></span>'
        : '<span class="sg-icon-state" style="color:' + (kind === 'ok' ? 'var(--aui-status-success,#136d31)' : 'var(--aui-status-error,#b91a24)') + '">' + (kind === 'ok' ? '✓' : '!') + '</span>';
      el.innerHTML = mark + '<div style="flex:1"><b style="display:block;margin-bottom:2px">Galaxy Diagnostics exception</b>' + SG.esc(text) + '</div>';
      el.style.borderColor = kind === 'err' ? 'var(--aui-status-error,#b91a24)' : '';
      if (where !== 'top' && kind !== 'busy') setTimeout(() => el.remove(), 8000);
    }

    // ------------------------------------------------------------ PART A
    if (SG_ON_PORTAL) {
      let injectedForWoId = null;
      // Position/collapsed persist across reloads and SPA route changes —
      // tick() rebuilds the button often, so this can't be a local variable.
      const POS_KEY = 'gde_btn_pos', COLLAPSED_KEY = 'gde_btn_collapsed';
      const loadPos = () => GM_getValue(POS_KEY, { right: 16, bottom: 16 });
      const savePos = (pos) => GM_setValue(POS_KEY, pos);

      // Window listeners added once; the grip's mousedown points dragState
      // at whichever button currently exists.
      let dragState = null, suppressNextClick = false;
      window.addEventListener('mousemove', (e) => {
        if (!dragState) return;
        dragState.wrap.style.right = Math.max(0, dragState.startRight - (e.clientX - dragState.startX)) + 'px';
        dragState.wrap.style.bottom = Math.max(0, dragState.startBottom - (e.clientY - dragState.startY)) + 'px';
        dragState.moved = true;
      });
      window.addEventListener('mouseup', () => {
        if (!dragState) return;
        savePos(clampToViewport(dragState.wrap));
        // Only the click belonging to this mouseup is swallowed.
        if (dragState.moved) { suppressNextClick = true; setTimeout(() => { suppressNextClick = false; }, 0); }
        dragState = null;
      });
      function clampToViewport(wrap) {
        const rect = wrap.getBoundingClientRect();
        const right = Math.min(Math.max(0, parseInt(wrap.style.right, 10) || 0), Math.max(0, innerWidth - rect.width));
        const bottom = Math.min(Math.max(0, parseInt(wrap.style.bottom, 10) || 0), Math.max(0, innerHeight - rect.height));
        wrap.style.right = right + 'px'; wrap.style.bottom = bottom + 'px';
        return { right, bottom };
      }
      window.addEventListener('resize', () => { const w = document.getElementById('sg-galaxy-btn'); if (w) savePos(clampToViewport(w)); });

      const currentWoId = () => { const m = location.pathname.match(/\/workorder\/(\d+)/); return m ? m[1] : null; };
      const gspnTicketOnPage = () => { const m = document.body.innerText.match(/GSPN No\.\s*([0-9]+)/); return m ? m[1] : null; };

      async function collectData(woId) {
        const json = await SG.api('GET', '/api/workorder/' + woId);
        if (!json || !json.workorder) throw new Error('the portal returned no work order data');
        const wo = json.workorder;
        const device = wo.CustomerDevice || {};
        const attrs = (wo.PartnerJob || {}).PartnerJobAttributes || [];
        // attribute type 53 = the "GSPN No." ticket (confirmed on two WOs);
        // falls back to the badge text if the API shape changes.
        const gspnAttr = attrs.find((a) => a.partnerJobAttributeTypeId === 53);
        const p = await SG.profile();
        const g = SG.settings.galaxy;
        return {
          woId,
          imei: device.imei || '',
          deviceName: (device.DeviceCatalog || {}).name || '',
          gspn: (gspnAttr && gspnAttr.value) || gspnTicketOnPage() || '',
          technicianName: g.technicianName || p.name,
          email: g.email || p.email,
          location: g.location || (p.storeId ? p.storeId + ' ' + p.storeName : ''),
          locationSearch: g.location || p.storeName, // typed to filter the store picker
          storeEmail: g.storeEmail,
          toolVersion: g.toolVersion || 'Latest',
          description: g.description,
          ts: Date.now(),
        };
      }

      function makeButton() {
        const pos = loadPos();
        const collapsed = GM_getValue(COLLAPSED_KEY, false);
        const wrap = h('div', { id: 'sg-galaxy-btn', class: 'sg', style:
          'position:fixed;z-index:2147483645;right:' + pos.right + 'px;bottom:' + pos.bottom + 'px;display:flex;align-items:center;height:48px;' +
          'border-radius:10000rem;background:var(--aui-primary,#8223d2);color:var(--aui-on-primary,#fff);box-shadow:0 6px 20px rgba(12,14,17,.25);overflow:hidden' });
        const side = 'display:flex;align-items:center;justify-content:center;width:28px;height:100%;color:rgba(255,255,255,.7);user-select:none;';
        const grip = h('div', { title: 'Drag to move · double-click to reset', style: side + 'cursor:move;padding-left:6px', html: SG.icon('grip', 14) });
        grip.addEventListener('dblclick', () => { wrap.style.right = '16px'; wrap.style.bottom = '16px'; savePos({ right: 16, bottom: 16 }); });
        grip.addEventListener('mousedown', (e) => {
          const r = wrap.getBoundingClientRect();
          dragState = { wrap, startX: e.clientX, startY: e.clientY, startRight: innerWidth - r.right, startBottom: innerHeight - r.bottom, moved: false };
          e.preventDefault();
        });
        const main = h('button', { type: 'button', style:
          'display:flex;align-items:center;gap:8px;height:100%;padding:0 ' + (collapsed ? '6px' : '8px') + ';border:0;background:none;color:inherit;cursor:pointer;' +
          'font:600 14px Apercu,"Helvetica Neue",Helvetica,Arial,sans-serif;white-space:nowrap' });
        const label = h('span', null, 'File Galaxy exception');
        const setLabel = (c) => { main.innerHTML = icon('clipboard', 18); if (!c) main.append(label); main.title = c ? 'File Galaxy Diagnostics exception' : ''; };
        setLabel(collapsed);
        const toggle = h('div', { style: side + 'cursor:pointer;padding-right:6px;font-size:16px', title: collapsed ? 'Expand' : 'Collapse' }, collapsed ? '›' : '‹');
        toggle.onclick = (e) => {
          e.stopPropagation();
          const c = !GM_getValue(COLLAPSED_KEY, false);
          GM_setValue(COLLAPSED_KEY, c);
          setLabel(c); toggle.textContent = c ? '›' : '‹'; toggle.title = c ? 'Expand' : 'Collapse';
          savePos(clampToViewport(wrap));
        };
        main.onclick = async () => {
          if (suppressNextClick) { suppressNextClick = false; return; }
          const woId = currentWoId();
          if (!woId) return;
          main.disabled = true;
          toast('Gathering WO data…', 'busy', 'bottom');
          // Open the tab now, while this still counts as a user click — after
          // an await, Chrome treats window.open as an unrequested popup.
          const formTab = window.open('about:blank', '_blank');
          try {
            const data = await collectData(woId);
            if (!data.gspn) { formTab?.close(); toast('No GSPN ticket number on this work order — nothing to file yet.', 'err', 'bottom'); return; }
            const handoffs = GM_getValue(HANDOFFS_KEY, {});
            handoffs[woId] = data;
            GM_setValue(HANDOFFS_KEY, handoffs);
            if (formTab) formTab.location.href = FORM_URL; else window.open(FORM_URL, '_blank');
            toast('Form opened in a new tab for WO ' + woId + '.', 'ok', 'bottom');
          } catch (e) {
            formTab?.close();
            toast('Could not gather WO data: ' + (e && e.message ? e.message : e), 'err', 'bottom');
          } finally {
            main.disabled = false;
          }
        };
        wrap.append(grip, main, toggle);
        document.body.appendChild(wrap);
        savePos(clampToViewport(wrap));
      }

      SG.every(1000, () => {
        const woId = currentWoId();
        const existing = document.getElementById('sg-galaxy-btn');
        if (!woId) { existing?.remove(); injectedForWoId = null; return; }
        const ticket = gspnTicketOnPage();
        if (ticket && (injectedForWoId !== woId || !existing)) { existing?.remove(); makeButton(); injectedForWoId = woId; }
        else if (!ticket && existing) { existing.remove(); injectedForWoId = null; }
      });
    }

    // ------------------------------------------------------------ PART B
    if (location.hostname === 'forms-prod.sprinklr.com') {
      function fieldByLabel(labelText) {
        const lab = [...document.querySelectorAll('label')].find((l) => l.textContent.trim() === labelText);
        let c = lab && lab.parentElement;
        for (let i = 0; i < 5 && c; i++, c = c.parentElement) { const input = c.querySelector('input, textarea'); if (input) return input; }
        return null;
      }
      async function waitForField(labelText, timeoutMs = 4000) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) { const f = fieldByLabel(labelText); if (f) return f; await sleep(100); }
        return null;
      }
      async function fillText(labelText, value) {
        const el = await waitForField(labelText);
        if (!el) return false;
        setNativeValue(el, value);
        return true;
      }
      // Cascading dropdowns: click open, optionally type to filter, click the
      // matching option. Re-queried each time — fields remount as the cascade grows.
      async function selectOption(labelText, optionText, typeText) {
        const input = await waitForField(labelText);
        if (!input) return false;
        input.click();
        await sleep(250);
        if (typeText) { setNativeValue(input, typeText); await sleep(400); }
        let opt = null;
        for (let t = 0; t < 15 && !opt; t++) {
          await sleep(100);
          opt = [...document.querySelectorAll('div,li,span')].find((e) => e.children.length === 0 && e.textContent.trim() === optionText && e.getClientRects().length > 0);
        }
        if (!opt) return false;
        opt.click();
        await sleep(200);
        return true;
      }
      function takeHandoff() {
        const handoffs = GM_getValue(HANDOFFS_KEY, {});
        const now = Date.now();
        let oldest = null;
        for (const [id, d] of Object.entries(handoffs)) {
          if (!d || now - d.ts > HANDOFF_MAX_AGE_MS) { delete handoffs[id]; continue; }
          if (!oldest || d.ts < oldest.ts) oldest = d;
        }
        if (oldest) delete handoffs[oldest.woId];
        if (Object.keys(handoffs).length) GM_setValue(HANDOFFS_KEY, handoffs); else GM_deleteValue(HANDOFFS_KEY);
        return oldest;
      }

      async function fill() {
        const data = takeHandoff();
        if (!data) return; // not opened from the WO button, or stale
        toast('Auto-filling from WO ' + data.woId + '…', 'busy');
        const email = await waitForField('Your email address', 8000);
        if (!email) { toast('Form did not load in time — fill it in by hand.', 'err'); return; }

        const failed = [];
        const step = async (label, ok) => { if (!(await ok)) failed.push(label); };
        setNativeValue(email, data.email);
        if (!data.email) failed.push('Your email (none found)');
        await step('UBIF Location', selectOption('UBIF Location', data.location, data.locationSearch));
        await step('Repair Location Type', selectOption('Repair Location Type', FIXED.REPAIR_LOCATION_TYPE));
        await step('Technician Name', fillText('Technician Name', data.technicianName));
        await step('Issue Type', selectOption('Issue Type', FIXED.ISSUE_TYPE));
        await waitForField('Exception Type');
        await step('Exception Type', selectOption('Exception Type', FIXED.EXCEPTION_TYPE));
        await waitForField('Galaxy Diagnostic Exception Reason');
        await step('Exception Reason', selectOption('Galaxy Diagnostic Exception Reason', FIXED.EXCEPTION_REASON));
        await waitForField('IMEI'); // last field in the cascade — once it's there, the rest are too
        await step('Tool Version', fillText('Galaxy Diagnostic Tool Version', data.toolVersion));
        await step('Device Full SKU', fillText('Device Full SKU', data.deviceName));
        await step('GSPN Ticket Number', fillText('GSPN Ticket Number', data.gspn));
        await step('Portal Work Order Number', fillText('Portal Work Order Number', data.woId));
        await step('IMEI', fillText('IMEI', data.imei));
        await step('Description', fillText('Description', data.description));
        if (data.storeEmail) await step('Store email', fillText('Store email address', data.storeEmail));
        if (!data.imei) failed.push('IMEI (none on the WO)');
        if (!data.deviceName) failed.push('Device Full SKU (none on the WO)');

        if (failed.length) toast('WO ' + data.woId + ': could NOT fill ' + failed.join(', ') + ' — fill those in by hand before submitting.', 'err');
        else toast('Filled from WO ' + data.woId + ' — check it over, then hit Submit yourself.', 'ok');
      }
      setTimeout(fill, 800); // the form renders client-side
    }
  },
});
