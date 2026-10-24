/*
  Macrocosmos (Galaxy Diagnostics exception) — two halves sharing data through
  Tampermonkey storage (GM_*, scoped per script, not per site):

  A. Portal WO page: once a "GSPN No. ######" badge exists, shows a
     draggable, collapsible button. Click → gathers IMEI / device name /
     GSPN ticket / WO number from Portal API, plus the technician,
     email and store from the logged-in user (overridable in settings),
     and opens the Sprinklr form in a new tab.
  B. Sprinklr form: picks up that handoff and fills every field, including
     the Issue → Exception → Reason cascade. It does NOT submit. No status
     card: the Macrocosmos macro icon (gear and all) sits where the button was
     on Portal (gde_btn_pos), its cooldown sweep filling field by field; done →
     it flashes like a skill coming off cooldown, then fades away with a
     drop downwards (no wipe). If fields couldn't be
     filled, it stays with a ✕ and a note listing them; click to dismiss.

  Filling needs real interactions: element.click() for the custom
  dropdowns, and the native value setter + input event for text fields
  (plain .value = doesn't register with React).
*/
AE.shard({
  id: 'galaxy',
  name: 'Macrocosmos',
  sites: ['portal.ubreakifix.net', 'forms-prod.sprinklr.com'],
  run() {
    const { h, icon, sleep } = AE;
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

    // Small status card, top-left (form) or bottom-left (portal). text: plain, or { html } (e.g. with an AE.bugLink).
    function toast(text, kind, where = 'top') {
      AE.ensureCss();
      let el = document.getElementById('sg-galaxy-toast');
      if (!el) {
        el = h('div', { id: 'sg-galaxy-toast', class: 'sg sg-card', style: 'position:fixed;z-index:2147483647;left:16px;max-width:440px;padding:12px 16px;display:flex;gap:10px;align-items:flex-start;font-size:14px;line-height:1.4' });
        document.body.appendChild(el);
      }
      el.style.top = where === 'top' ? '16px' : '';
      el.style.bottom = where === 'top' ? '' : '16px';
      const mark = kind === 'busy' ? '<span class="sg-spin" style="margin-top:2px"></span>'
        : '<span class="sg-icon-state" style="color:' + (kind === 'ok' ? 'var(--aui-status-success,#136d31)' : 'var(--aui-status-error,#b91a24)') + '">' + (kind === 'ok' ? '✓' : '!') + '</span>';
      el.innerHTML = mark + '<div style="flex:1"><b style="display:block;margin-bottom:2px">Galaxy Diagnostics exception</b>' + (text && typeof text === 'object' ? text.html : AE.esc(text)) + '</div>';
      el.style.borderColor = kind === 'err' ? 'var(--aui-status-error,#b91a24)' : '';
      if (where !== 'top' && kind !== 'busy') setTimeout(() => el.remove(), 8000);
    }

    // ------------------------------------------------------------ PART A
    if (AE_ON_PORTAL) {
      let injectedForWoId = null;
      let demoWo = null; // dev tools: show the button on this WO even without a GSPN ticket
      // Position persists across reloads and SPA route changes — tick()
      // rebuilds the button often, so this can't be a local variable.
      const POS_KEY = 'gde_btn_pos';
      const loadPos = () => GM_getValue(POS_KEY, { right: 16, bottom: 16 });
      const savePos = (pos) => GM_setValue(POS_KEY, pos);

      // Window listeners added once; the button's mousedown points dragState
      // at whichever button currently exists.
      let dragState = null, suppressNextClick = false;
      window.addEventListener('mousemove', (e) => {
        if (!dragState) return;
        // A few pixels of wobble is still a click, not a drag.
        if (!dragState.moved && Math.hypot(e.clientX - dragState.startX, e.clientY - dragState.startY) < 4) return;
        dragState.wrap.style.right = Math.max(0, dragState.startRight - (e.clientX - dragState.startX)) + 'px';
        dragState.wrap.style.bottom = Math.max(0, dragState.startBottom - (e.clientY - dragState.startY)) + 'px';
        dragState.moved = true;
        dragState.wrap.classList.add('dragging');
        placeIntro();
      });
      window.addEventListener('mouseup', () => {
        if (!dragState) return;
        savePos(clampToViewport(dragState.wrap));
        // Only the click belonging to this mouseup is swallowed.
        dragState.wrap.classList.remove('dragging');
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
      const gspnTicketOnPage = () => { const m = document.body.textContent.match(/GSPN No\.\s*([0-9]+)/); return m ? m[1] : null; }; // textContent: no layout

      async function collectData(woId) {
        const json = await AE.api('GET', '/api/workorder/' + woId);
        const wo = AE.shape.workorder(json, 'Macrocosmos work order ' + woId);
        const device = wo.CustomerDevice || {};
        const attrs = (wo.PartnerJob || {}).PartnerJobAttributes || [];
        // attribute type 53 = the "GSPN No." ticket (confirmed on two WOs);
        // falls back to the badge text if the API shape changes.
        const gspnAttr = attrs.find((a) => a.partnerJobAttributeTypeId === 53);
        const p = await AE.profile();
        const g = AE.settings.galaxy;
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

      // The button is the Macrocosmos action icon, like a hotbar slot: click
      // to file, drag it to move (Settings → Macrocosmos resets the spot).
      const BTN_CSS = `
      #sg-galaxy-btn { position:fixed; z-index:2147483645; width:56px; height:56px; padding:0; border:0; border-radius:14px; cursor:pointer;
        background:#000; box-shadow:0 6px 20px rgba(12,14,17,.35), 0 0 0 2px rgba(255,255,255,.9), 0 0 0 3px rgba(0,0,0,.35); transition:transform .12s, box-shadow .12s; }
      #sg-galaxy-btn img { display:block; width:56px; height:56px; border-radius:14px; box-shadow:none; pointer-events:none; }
      #sg-galaxy-btn:hover { transform:translateY(-1px); box-shadow:0 8px 24px rgba(12,14,17,.4), 0 0 0 2px #ffd97a, 0 0 14px 3px rgba(255,217,122,.55); }
      #sg-galaxy-btn:active { transform:scale(.96); }
      #sg-galaxy-btn:focus-visible { outline:3px solid var(--aui-primary, #8223d2); outline-offset:3px; }
      #sg-galaxy-btn:disabled { cursor:progress; }
      #sg-galaxy-btn:disabled img { filter:brightness(.45) saturate(.6); }
      #sg-galaxy-btn .sg-spin { position:absolute; left:50%; top:50%; width:22px; height:22px; margin:-11px 0 0 -11px; border-width:3px; display:none; }
      #sg-galaxy-btn:disabled .sg-spin { display:block; }
      /* It's a macro, so it wears the hotbar's macro gear and shows its "macro name" on hover. */
      #sg-galaxy-btn .gear { position:absolute; left:-4px; top:-4px; width:16px; height:16px; pointer-events:none;
        filter:drop-shadow(0 1px 1px rgba(0,0,0,.8)); }
      #sg-galaxy-btn .mname { position:absolute; left:50%; bottom:calc(100% + 10px); transform:translate(-50%, 4px); opacity:0; pointer-events:none;
        padding:5px 10px 4px; border-radius:6px; white-space:nowrap; transition:opacity .12s, transform .12s;
        background:linear-gradient(#3b3b3b, #1e1e1e); border:1px solid #6b6154; box-shadow:0 0 0 1px #000, 0 4px 12px rgba(0,0,0,.45);
        color:#f2ecdf; text-shadow:0 1px 1px #000; font:400 15px/1.2 "Myriad Pro", Myriad, "Meiryo UI", Meiryo, "Segoe UI", sans-serif; letter-spacing:.01em; }
      #sg-galaxy-btn:hover .mname, #sg-galaxy-btn:focus-visible .mname { opacity:1; transform:translate(-50%, 0); }
      #sg-galaxy-btn.dragging .mname, #sg-galaxy-btn.intro .mname { opacity:0; } /* the explainer sits where the name would */
      /* First-time explainer, pointing at the button */
      #sg-galaxy-intro { position:fixed; z-index:2147483646; width:300px; padding:16px 16px 14px; font-size:14px; line-height:1.45; animation:sg-in .2s ease-out; }
      #sg-galaxy-intro .ae { position:absolute; top:10px; right:10px; color:var(--aui-primary, #8223d2); line-height:0; }
      #sg-galaxy-intro b { display:block; margin:0 28px 6px 0; font-size:15px; }
      #sg-galaxy-intro a { color:var(--aui-primary, #8223d2); font-weight:700; cursor:pointer; text-decoration:underline; }
      #sg-galaxy-intro .sg-actions { margin-top:12px; justify-content:flex-end; }
      #sg-galaxy-intro .sg-actions .sg-btn { flex:none; }
      #sg-galaxy-intro .tail { position:absolute; width:14px; height:14px; background:inherit; border:inherit; border-width:0 1px 1px 0; transform:rotate(45deg); }
      `;
      const INTRO_KEY = 'ae_galaxy_intro_seen';
      // Place the explainer beside the button (above it if there's room, else below), tail pointing at it.
      function placeIntro() {
        const pop = document.getElementById('sg-galaxy-intro'), btn = document.getElementById('sg-galaxy-btn');
        if (!pop || !btn) return;
        const b = btn.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight, gap = 14;
        const above = b.top - ph - gap >= 8;
        const left = Math.min(Math.max(8, b.left + b.width / 2 - pw + 40), innerWidth - pw - 8);
        pop.style.left = left + 'px';
        pop.style.top = (above ? b.top - ph - gap : b.bottom + gap) + 'px';
        const tail = pop.querySelector('.tail');
        tail.style.left = Math.min(Math.max(12, b.left + b.width / 2 - left - 7), pw - 26) + 'px';
        tail.style.top = above ? (ph - 8) + 'px' : '-8px';
        tail.style.transform = above ? 'rotate(45deg)' : 'rotate(225deg)';
      }
      function dismissIntro() { GM_setValue(INTRO_KEY, true); document.getElementById('sg-galaxy-intro')?.remove(); document.getElementById('sg-galaxy-btn')?.classList.remove('intro'); }
      function showIntro() {
        if (GM_getValue(INTRO_KEY, false) || document.getElementById('sg-galaxy-intro')) return;
        const link = h('a', { role: 'button', tabindex: '0', onclick: () => { dismissIntro(); AE.openSettings('galaxy'); } }, 'click here');
        const pop = h('div', { id: 'sg-galaxy-intro', class: 'sg sg-card', role: 'dialog', 'aria-label': 'About the Macrocosmos button' },
          h('span', { class: 'ae', title: AE_NAME, html: icon('aetheryte', 22) }),
          h('b', null, 'Macrocosmos'),
          h('div', null, 'Click this button to automatically file the Galaxy Diagnostics exception for this device. If you need to change the values used in the form, ', link, ' to change them.'),
          h('div', { class: 'sg-actions' }, h('button', { type: 'button', class: 'sg-btn sg-primary', onclick: dismissIntro }, 'Got it')),
          h('span', { class: 'tail' }));
        document.body.appendChild(pop);
        document.getElementById('sg-galaxy-btn')?.classList.add('intro');
        placeIntro();
      }
      window.addEventListener('resize', placeIntro);
      function makeButton() {
        if (!document.getElementById('sg-galaxy-css')) document.head.append(h('style', { id: 'sg-galaxy-css' }, BTN_CSS));
        const pos = loadPos();
        const main = h('button', { type: 'button', id: 'sg-galaxy-btn', class: 'sg',
          'aria-label': 'GD Exception: file the Galaxy Diagnostics exception for this WO',
          style: 'right:' + pos.right + 'px;bottom:' + pos.bottom + 'px',
          html: AE.actionIcon('galaxy', 56) + '<img class="gear" src="' + AE.asset('ui/macro-gear') + '" alt="">'
            + '<span class="mname">GD Exception</span><span class="sg-spin"></span>' });
        const wrap = main; // drag + clamp act on the button itself
        main.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;
          const r = wrap.getBoundingClientRect();
          dragState = { wrap, startX: e.clientX, startY: e.clientY, startRight: innerWidth - r.right, startBottom: innerHeight - r.bottom, moved: false };
          e.preventDefault(); // no text selection / image drag while moving
        });
        main.onclick = async () => {
          if (suppressNextClick) { suppressNextClick = false; return; }
          dismissIntro(); // using it counts as having read it
          if (AE.status.blocked('galaxy')) return;
          if (demoWo && !gspnTicketOnPage()) { toast('Demo button (dev tools): on a real Samsung WO with a GSPN ticket this files the exception.', 'ok', 'bottom'); return; }
          AE.track('galaxy:file');
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
            toast({ html: 'Macrocosmos couldn\'t grab its required data from this WO. If you keep seeing this, ' +
              AE.bugLink('report a bug', { where: 'Macrocosmos', error: 'Gathering data for WO ' + woId + ' failed: ' + (e && e.message ? e.message : e) }) + '!' }, 'err', 'bottom');
          } finally {
            main.disabled = false;
          }
        };
        document.body.appendChild(wrap);
        savePos(clampToViewport(wrap));
        showIntro();
      }

      // Dev tools: the button + first-time explainer on the current WO, whatever it is.
      AE.hooks.galaxyDemo = () => {
        const woId = currentWoId();
        if (!woId) return false;
        demoWo = woId; GM_deleteValue(INTRO_KEY);
        document.getElementById('sg-galaxy-btn')?.remove(); document.getElementById('sg-galaxy-intro')?.remove();
        injectedForWoId = null;
        return true;
      };

      // On page changes too (2.23), but reading the page's text is the costly part: at most 4 times a second,
      // and only while this WO has no button yet.
      let lastCheck = 0;
      AE.onDom(() => {
        const woId = currentWoId();
        if (!woId || (injectedForWoId === woId && document.getElementById('sg-galaxy-btn')) || performance.now() - lastCheck < 250) return;
        lastCheck = performance.now();
        place();
      });
      AE.every(1000, place);
      function place() {
        const woId = currentWoId();
        const existing = document.getElementById('sg-galaxy-btn');
        if (!woId) { existing?.remove(); document.getElementById('sg-galaxy-intro')?.remove(); injectedForWoId = null; return; }
        const ticket = gspnTicketOnPage() || (demoWo === woId ? 'demo' : null);
        if (ticket && (injectedForWoId !== woId || !existing)) { existing?.remove(); makeButton(); injectedForWoId = woId; }
        else if (!ticket && existing) { existing.remove(); document.getElementById('sg-galaxy-intro')?.remove(); injectedForWoId = null; }
      }
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

      // The macro icon, cast-style, where the Portal button was.
      const CAST_CSS = `
        #sg-galaxy-cast { position:fixed; z-index:2147483646; width:56px; height:56px; border-radius:14px; cursor:default; box-shadow:0 6px 20px rgba(12,14,17,.35);
          animation:sg-in .2s ease-out; }
        #sg-galaxy-cast .sg-spell { box-shadow:0 0 0 2px #1a1a1f, 0 0 0 3.5px #c9a75a; }
        #sg-galaxy-cast .sg-spell .mark { min-width:20px; height:20px; font-size:12px; line-height:20px; right:3px; bottom:3px; }
        #sg-galaxy-cast .gear { position:absolute; left:-4px; top:-4px; width:16px; height:16px; pointer-events:none; z-index:2; }
        #sg-galaxy-cast .mname { position:absolute; left:50%; bottom:calc(100% + 8px); transform:translateX(-50%); white-space:nowrap; padding:2px 7px; border-radius:6px;
          background:rgba(12,12,18,.85); color:#fff; font:600 12px "Myriad Pro", Myriad, Meiryo, "Helvetica Neue", Arial, sans-serif; }
        #sg-galaxy-cast.leave { animation:sg-cast-leave .7s ease-in forwards; }
        #sg-galaxy-cast.failed { cursor:pointer; }
        @keyframes sg-cast-leave { from { opacity:1; transform:none; } to { opacity:0; transform:translateY(24px); } }
        @media (prefers-reduced-motion: reduce) { #sg-galaxy-cast.leave { animation:sg-fade-out .3s forwards; } @keyframes sg-fade-out { to { opacity:0; } } }
      `;
      function castIcon(total) {
        AE.ensureCss();
        if (!document.getElementById('sg-galaxy-cast-css')) document.head.append(h('style', { id: 'sg-galaxy-cast-css' }, CAST_CSS));
        document.getElementById('sg-galaxy-cast')?.remove();
        const pos = GM_getValue('gde_btn_pos', { right: 16, bottom: 16 });
        const spell = AE.spellIcon('galaxy', 56);
        const el = h('div', { id: 'sg-galaxy-cast', class: 'sg', title: 'GD Exception: filling the form…',
          style: 'right:' + Math.min(pos.right, Math.max(0, innerWidth - 60)) + 'px;bottom:' + Math.min(pos.bottom, Math.max(0, innerHeight - 60)) + 'px' },
          spell, h('img', { class: 'gear', src: AE.asset('ui/macro-gear'), alt: '' }), h('span', { class: 'mname' }, 'GD Exception'));
        document.body.appendChild(el);
        let done = 0, shown = 0, target = 0, anim = null;
        const paint = () => spell.style.setProperty('--a', Math.round(shown * 360) + 'deg');
        const to = (p) => {
          target = Math.min(1, p);
          if (anim) return;
          const tick = () => { shown += (target - shown) * 0.2; if (Math.abs(target - shown) < 0.002) shown = target; paint(); anim = shown === target ? null : requestAnimationFrame(tick); };
          anim = requestAnimationFrame(tick);
        };
        paint();
        return {
          step() { done++; to(Math.min(done / total, 0.97)); },
          finish(ok, note) {
            to(1);
            AE.spellDone(spell, ok ? 'ok' : 'err');
            if (ok) {
              el.title = 'Exception data filled. Hit Submit when you\'re ready.';
              setTimeout(() => { el.classList.add('leave'); setTimeout(() => el.remove(), 750); }, 2400); // after the flash
            } else {
              el.classList.add('failed');
              el.title = note + ' Click to dismiss.';
              toast(note, 'err');
              el.onclick = () => { el.remove(); document.getElementById('sg-galaxy-toast')?.remove(); };
            }
          },
        };
      }

      async function fill() {
        const data = takeHandoff();
        if (!data) return; // not opened from the WO button, or stale
        const total = 13 + (data.storeEmail ? 1 : 0); // email + the 12 fields below (+ store email)
        const cast = castIcon(total);
        const email = await waitForField('Your email address', 8000);
        if (!email) { cast.finish(false, 'Looks like the form didn\'t load itself in time - close this tab and try again.'); return; }

        const failed = [];
        const step = async (label, ok) => { if (!(await ok)) failed.push(label); cast.step(); };
        setNativeValue(email, data.email);
        cast.step();
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

        if (failed.length) cast.finish(false, 'Couldn\'t fill in the proper info, please close this tab and try again, or fill in the missing info by hand. Missing: ' + failed.join(', ') + '.');
        else cast.finish(true);
      }
      setTimeout(fill, 800); // the form renders client-side
    }
  },
});
