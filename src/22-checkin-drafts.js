/*
  Return (incomplete check-ins) — save a check-in that can't be finished yet
  and pick it up later where it left off.

  Why: cleanings have to be created within 15 minutes of their work order,
  and Portal creates the work order when the check-in leaves the Device step.
  Saved before then, the work order (and its 15 minutes) only start once the
  device is ready and the check-in is finished.

  - Save as incomplete: a button in the check-in footer on every step but
    Device (its boxes don't come back from Portal's state). It
    reads Portal's own check-in state (the check-in app's Redux slice
    "checkInSlice", through core's Portal bridge), keeps the parts a person
    typed or picked (customer, device, IMEI/serial, passcode, items with the
    device; once the work order exists also the diagnosis, notes and bin) and
    saves them to the Worker (/v1/:store/checkins). Saving the same check-in
    again updates it. Then it prints a label on the store's DYMO (DYMO
    Connect at https://127.0.0.1:41951-41960, the same 30330 labels as
    Portal's WO labels): the Aethernet mark, "Aethernet - Return", customer ·
    device · date and a Code128 barcode "AEC" + the 6-character code. If it
    can't print, the message offers Retry print.
  - Resume: scanning the label (Master's Mend's scan to open sends AEC codes
    here) or Resume on the customer's arrival. No work order yet: the
    check-in opens the way Portal's own Check-in button opens it (router
    state arrivalIdForCheckin, when it came from an arrival) and the saved
    fields are dispatched back into the slice, then the step is restored.
    Work order already made: Portal's own resume (/check-in?workorderId=…)
    reloads it and the diagnosis, notes and bin it doesn't keep are put back.
  - The arrival drawer shows a saved check-in with Resume, Reprint label and
    Discard.
  - Finished: once the work order the check-in made has left Initial
    check-in (status 1), the saved copy is deleted. The Worker also deletes
    them 7 days after saving. They hold the customer's details and passcode.
*/
AE.crystal({
  id: 'checkinDrafts',
  name: 'Return',
  sites: ['portal.ubreakifix.net'],
  run() {
    const { h } = AE;
    const STEPS = ['Customer', 'Device', 'Diagnosis', 'Parts and services'];
    const SLICE = 'checkInSlice';
    const BTN_ID = 'ae-return-save', BOX_ID = 'ae-return-arrival';
    const INITIAL_CHECKIN = 1; // work order status while the check-in isn't finished
    const DEVICE_STEP = 1;     // formStep of the Device step: no saving there (see tick)
    // What a person typed or picked; the rest of the slice is Portal's own bookkeeping.
    const KEEP = ['formStep', 'activeTab', 'isBusinessCustomerArrivalFlow', 'selectedBusiness', 'authorizedContacts', 'contactFields',
      'customerInfo', 'isImeiUnavailable', 'isSerialUnavailable', 'isServiceTagUnavailable', 'deviceInfo', 'customerDeviceDetails',
      'deviceDiagToggles', 'selectedDeviceIssues', 'selectedGoogleDeviceIssues', 'deviceDiagNotes', 'deviceIssuesAdditionalDetails', 'binLocation'];
    const MAX = 13000; // the Worker takes 14,000 characters of data
    const TITLE = 'Aethernet - Return'; // the label's top line

    document.head.append(h('style', null, `
      #${BTN_ID} { display:inline-flex; align-items:center; gap:8px; margin-right:12px; flex:none; }
      #${BTN_ID} svg { color:var(--aui-primary, #8223d2); }
      #${BOX_ID} { margin:20px 0 0; padding:12px 14px; display:flex; gap:10px; align-items:center; flex-wrap:wrap;
        border:1.5px dashed var(--aui-primary, #8223d2); border-radius:12px; font-size:14px; line-height:1.4; }
      #${BOX_ID} .txt { flex:1; min-width:180px; }
      #${BOX_ID} .sg-btn { height:32px; font-size:13px; }
    `));

    const call = (method, path, body) => AE.waymark.call(method, '/checkins' + path, body);
    const report = (what, e) => ' If you keep seeing this, ' + AE.bugLink('report a bug', { where: 'Return', error: what + ': ' + ((e && e.message) || e) }) + '!';
    const slice = (key, fresh) => { const r = AE.portal('select', { slice: SLICE, key: key == null ? null : key, fresh: !!fresh }); return r && r.found ? r.value : undefined; };
    const dispatch = (type, payload) => AE.portal('dispatch', { slice: SLICE, action: { type: 'check-in/' + type, payload } });
    const fmtWhen = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const fmtDay = (d) => d.toLocaleDateString([], { month: 'short', day: 'numeric' });

    // ------------------------------------------------------------ what to save
    function trim(st) {
      const data = {};
      for (const k of KEEP) if (st[k] !== undefined) data[k] = st[k];
      if (JSON.stringify(data).length > MAX) delete data.customerDeviceDetails; // the biggest part, and Portal reloads it
      return data;
    }
    // The device's name, wherever this check-in keeps it.
    function deviceName(st) {
      const seen = new Set();
      const find = (o, depth) => {
        if (!o || typeof o !== 'object' || depth > 4 || seen.has(o)) return '';
        seen.add(o);
        for (const k of ['deviceName', 'modelName', 'deviceModelName', 'deviceCatalogName']) if (typeof o[k] === 'string' && o[k].trim()) return o[k].trim();
        for (const v of Object.values(o)) { const x = find(v, depth + 1); if (x) return x; }
        return '';
      };
      return find(st.customerDeviceDetails, 0) || find(st.arrivalDetails, 0) || '';
    }
    const customerName = (st) => [st.customerInfo && st.customerInfo.firstName, st.customerInfo && st.customerInfo.lastName].filter(Boolean).join(' ').trim()
      || (st.selectedBusiness && st.selectedBusiness.name) || '';

    // ------------------------------------------------------------ label
    const mark = (size, color) => AE.icon('aetheryte', size).replace(/currentColor/g, color);
    // The mark as a PNG, for the label file (DYMO takes images as base64 PNG).
    async function markPng() {
      const svg = mark(240, '#000').replace(/<svg /, '<svg xmlns="http://www.w3.org/2000/svg" ');
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      await img.decode();
      const c = document.createElement('canvas'); c.width = c.height = 240;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 240, 240); g.drawImage(img, 0, 0, 240, 240);
      return c.toDataURL('image/png').split(',')[1];
    }
    const xml = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
    const COLORS = '<ForeColor Alpha="255" Red="0" Green="0" Blue="0" /><BackColor Alpha="0" Red="255" Green="255" Blue="255" /><LinkedObjectName></LinkedObjectName><Rotation>Rotation0</Rotation><IsMirrored>False</IsMirrored><IsVariable>False</IsVariable>';
    const textObj = (name, text, size, bold, b) => '<ObjectInfo><TextObject><Name>' + name + '</Name>' + COLORS +
      '<HorizontalAlignment>Left</HorizontalAlignment><VerticalAlignment>Middle</VerticalAlignment><TextFitMode>ShrinkToFit</TextFitMode><UseFullFontHeight>True</UseFullFontHeight><Verticalized>False</Verticalized>' +
      '<StyledText><Element><String>' + xml(text) + '</String><Attributes><Font Family="Arial" Size="' + size + '" Bold="' + (bold ? 'True' : 'False') + '" Italic="False" Underline="False" Strikeout="False" /><ForeColor Alpha="255" Red="0" Green="0" Blue="0" /></Attributes></Element></StyledText>' +
      '</TextObject><Bounds X="' + b[0] + '" Y="' + b[1] + '" Width="' + b[2] + '" Height="' + b[3] + '" /></ObjectInfo>';
    // Portal's own WO label (30330 Return Address, landscape, twips). DYMO pushes anything left of its printable area
    // (about 330 twips in) back inside it, so the mark gets its own column from there and the text starts after a gap.
    async function labelXml(d) {
      return '<?xml version="1.0" encoding="utf-8"?><DieCutLabel Version="8.0" Units="twips"><PaperOrientation>Landscape</PaperOrientation><Id>ReturnAddress</Id><PaperName>30330 Return Address</PaperName>' +
        '<DrawCommands><RoundRectangle X="0" Y="0" Width="1080" Height="2880" Rx="180" Ry="180" /></DrawCommands>' +
        '<ObjectInfo><ImageObject><Name>MARK</Name>' + COLORS + '<Image>' + await markPng() + '</Image><ScaleMode>Uniform</ScaleMode><BorderWidth>0</BorderWidth>' +
        '<BorderColor Alpha="255" Red="0" Green="0" Blue="0" /><HorizontalAlignment>Center</HorizontalAlignment><VerticalAlignment>Center</VerticalAlignment></ImageObject>' +
        '<Bounds X="340" Y="200" Width="400" Height="680" /></ObjectInfo>' +
        textObj('TITLE', TITLE, 11, true, [800, 70, 1770, 210]) +
        textObj('LINE', d.line, 8, false, [800, 290, 1770, 170]) +
        '<ObjectInfo><BarcodeObject><Name>BARCODE</Name>' + COLORS.replace('<IsVariable>False</IsVariable>', '<IsVariable>True</IsVariable>') +
        '<Text>' + xml(d.code) + '</Text><Type>Code128Auto</Type><Size>Small</Size><TextPosition>Bottom</TextPosition>' +
        '<TextFont Family="Arial" Size="8" Bold="False" Italic="False" Underline="False" Strikeout="False" /><CheckSumFont Family="Arial" Size="8" Bold="False" Italic="False" Underline="False" Strikeout="False" />' +
        '<TextEmbedding>None</TextEmbedding><ECLevel>0</ECLevel><HorizontalAlignment>Left</HorizontalAlignment><QuietZonesPadding Left="0" Top="0" Right="0" Bottom="0" /></BarcodeObject>' +
        '<Bounds X="800" Y="510" Width="1770" Height="490" /></ObjectInfo></DieCutLabel>';
    }
    // DYMO Connect's web service: the same hosts and ports Portal's DYMO library tries.
    let dymoBase = null;
    const timed = (url, opts, ms) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); return fetch(url, { ...opts, signal: c.signal }).finally(() => clearTimeout(t)); };
    async function findDymo() {
      if (dymoBase) return dymoBase;
      for (const host of ['127.0.0.1', 'localhost']) {
        for (let port = 41951; port <= 41960; port++) {
          const base = 'https://' + host + ':' + port + '/DYMO/DLS/Printing';
          try { const r = await timed(base + '/StatusConnected', {}, 1500); if (r.ok && /true/i.test(await r.text())) return (dymoBase = base); } catch (_) { /* not there */ }
        }
      }
      return null;
    }
    async function printLabel(d) {
      const base = await findDymo();
      if (!base) throw new Error('DYMO Connect not found on this computer');
      const list = await (await timed(base + '/GetPrinters', {}, 10000)).text();
      const doc = new DOMParser().parseFromString(list.replace(/^"|"$/g, '').replace(/\\"/g, '"'), 'text/xml');
      const printers = [...doc.querySelectorAll('LabelWriterPrinter')].map((p) => ({ name: (p.querySelector('Name') || {}).textContent, on: /true/i.test((p.querySelector('IsConnected') || {}).textContent || '') }));
      const printer = (printers.find((p) => p.on) || printers[0] || {}).name;
      if (!printer) throw new Error('no LabelWriter printer in DYMO Connect');
      const form = new URLSearchParams({ printerName: printer, printParamsXml: '', labelXml: await labelXml(d), labelSetXml: '' });
      const r = await timed(base + '/PrintLabel', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() }, 15000);
      if (!r.ok) throw new Error('DYMO answered HTTP ' + r.status);
      return printer;
    }
    async function label(d) {
      try { await printLabel(d); return true; }
      catch (e) { console.warn('[' + AE_NAME + '] Return: label not printed:', e.message || e); return false; }
    }
    // A message that offers Retry print until the label goes through.
    function printedOrRetry(t, title, text, d) {
      const add = () => t.lastElementChild && t.lastElementChild.append(h('div', { style: 'margin-top:8px' },
        h('button', { type: 'button', class: 'sg-btn sg-primary', style: 'height:30px;font-size:13px', onclick: async (e) => {
          e.target.disabled = true; e.target.textContent = 'Printing…';
          const ok = await label(d);
          if (ok) { t.remove(); AE.toast(title, text, 'ok', 6000); }
          else { e.target.disabled = false; e.target.textContent = 'Retry print'; }
        } }, 'Retry print')));
      add();
    }
    const labelFor = (draft) => ({ code: 'AEC' + draft.id, line: draft.label || '' });

    // ------------------------------------------------------------ save
    let current = null; // the saved check-in this page is on: { id, arrivalId, woId }
    async function save(btn) {
      const st = slice(null, true);
      if (!st) { AE.toast('Return', { html: "Couldn't read this check-in." + report('Saving a check-in', 'no check-in state found') }, 'err'); return; }
      const arrivalId = (st.arrivalDetails && st.arrivalDetails.arrivalId) || (current && current.arrivalId) || null;
      const woId = (st.workorder && st.workorder.workorderId) || null;
      const step = Number(st.formStep) || 0;
      const who = customerName(st), dev = deviceName(st);
      const line = [who, dev, fmtDay(new Date())].filter(Boolean).join(' · ');
      btn.disabled = true;
      try {
        const j = await call('POST', '', { id: current && current.id, arrivalId, woId, step, label: line, data: trim(st) });
        current = { id: j.id, arrivalId, woId };
        AE.track('checkinDrafts:save');
        const d = { code: 'AEC' + j.id, line };
        const printed = await label(d);
        const text = [who, dev].filter(Boolean).join(' · ') + ', at the ' + STEPS[step] + ' step. Scan the printed label to pick up where you left off.';
        const t = AE.toast('Saved as incomplete', printed ? text : text + " The label didn't print.", printed ? 'ok' : 'err', printed ? 9000 : 30000);
        if (!printed) printedOrRetry(t, 'Saved as incomplete', text, d);
      } catch (e) {
        AE.toast('Return', { html: "Couldn't save this check-in." + report('Saving a check-in', e) }, 'err', 12000);
      } finally { btn.disabled = false; }
    }

    // ------------------------------------------------------------ resume
    const goTo = (url, usr) => {
      const idx = ((history.state && history.state.idx) || 0) + 1;
      history.pushState(usr ? { usr, key: Math.random().toString(36).slice(2, 10), idx } : null, '', url);
      dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    };
    const waitFor = async (test, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = test(); if (v) return v; await AE.sleep(250); } return null; };
    function putBack(data, step) {
      const has = (k) => data[k] !== undefined && data[k] !== null;
      if (has('activeTab')) dispatch('setActiveTab', data.activeTab);
      if (has('isBusinessCustomerArrivalFlow')) dispatch('setBusinessCustomerArrivalFlow', data.isBusinessCustomerArrivalFlow);
      if (has('selectedBusiness')) dispatch('setSelectedBusiness', data.selectedBusiness);
      if (has('authorizedContacts')) dispatch('setAuthorizedContacts', data.authorizedContacts);
      if (has('contactFields')) dispatch('setContactFields', data.contactFields);
      if (has('customerInfo')) dispatch('updateCustomerInfo', data.customerInfo);
      if (has('deviceInfo')) dispatch('updateDeviceInfo', data.deviceInfo);
      if (has('customerDeviceDetails')) dispatch('updateCustomerDeviceDetails', data.customerDeviceDetails);
      const now = slice(null, false) || {};
      for (const [k, type] of [['isImeiUnavailable', 'toggleIsImeiUnavailable'], ['isSerialUnavailable', 'toggleIsSerialUnavailable'], ['isServiceTagUnavailable', 'toggleIsServiceTagUnavailable']]) {
        if (has(k) && !!now[k] !== !!data[k]) dispatch(type);
      }
      if (step >= 2) {
        if (has('selectedDeviceIssues')) dispatch('updateSelectedDeviceIssues', data.selectedDeviceIssues);
        if (has('selectedGoogleDeviceIssues')) dispatch('updateSelectedGoogleDeviceIssues', data.selectedGoogleDeviceIssues);
        if (has('deviceDiagNotes')) dispatch('updateDeviceDiagNotes', data.deviceDiagNotes);
        if (has('deviceIssuesAdditionalDetails')) dispatch('updateDeviceIssuesAdditionalDetails', data.deviceIssuesAdditionalDetails);
        if (has('deviceDiagToggles')) dispatch('updateDeviceDiagToggles', data.deviceDiagToggles);
      }
      if (has('binLocation')) dispatch('setBinLocation', data.binLocation);
      dispatch('overrideStep', step);
    }
    async function resume(id) {
      let d;
      try { d = (await call('GET', '/' + id)).checkin; }
      catch (e) {
        if (/no saved check-in/.test(e.message || '')) { AE.toast('Return', 'No saved check-in has that code. It may have been finished, discarded, or kept more than 7 days.', 'err', 10000); return 'no such saved check-in'; }
        AE.toast('Return', { html: "Couldn't load that saved check-in." + report('Loading saved check-in ' + id, e) }, 'err', 10000);
        return 'load failed';
      }
      const data = d.data || {};
      const step = Math.max(0, Math.min(3, Number(d.step) || 0));
      document.getElementById(BOX_ID)?.closest('[role="dialog"]')?.querySelector('button[aria-label="close"], button[aria-label="Close"]')?.click();
      if (d.woId) goTo('/check-in?workorderId=' + d.woId, d.arrivalId ? { arrivalIdForCheckin: d.arrivalId } : null);
      else {
        // Portal's check-in only takes the arrival from a page of its own app (as its Check-in button does):
        // from anywhere else, stop at the arrival first, then open the check-in from there.
        if (d.arrivalId && !/^\/check-in(\/|$)/.test(location.pathname)) {
          goTo('/check-in/arrivals/' + d.arrivalId);
          // until the drawer shows the arrival (Portal's check-in takes its details from what that loaded)
          await waitFor(() => [...document.querySelectorAll('*')].some((e) => e.children.length === 0 && e.textContent.trim() === 'Preferred contact method'), 10000);
          await AE.sleep(500);
        }
        goTo('/check-in', d.arrivalId ? { arrivalIdForCheckin: d.arrivalId } : null);
      }
      // Wait for Portal's check-in to open (and, after a work order, for its own resume to land on Diagnosis).
      const ready = await waitFor(() => {
        const st = slice(null, true);
        if (!st) return null;
        if (d.woId) return st.workorder && st.isContinuingCheckIn ? st : null;
        return d.arrivalId ? (st.arrivalDetails && st.arrivalDetails.arrivalId === d.arrivalId ? st : null) : st;
      }, 15000);
      if (!ready) { AE.toast('Return', { html: "Portal's check-in didn't open." + report('Resuming saved check-in ' + id, 'check-in not ready after 15 s') }, 'err', 10000); return 'check-in did not open'; }
      await AE.sleep(1200); // Portal fills in the arrival's own details as it opens: ours go on top
      putBack(data, step);
      current = { id: d.id, arrivalId: d.arrivalId, woId: d.woId };
      AE.track('checkinDrafts:resume');
      AE.toast('Check-in restored', 'Saved ' + fmtWhen(d.updatedAt || d.at) + ' by ' + (d.by || 'someone') + '. Picking up at the ' + STEPS[step] + ' step.', 'ok', 9000);
      return 'resumed ' + id;
    }

    // ------------------------------------------------------------ finished?
    // The check-in is done once its work order has left Initial check-in; the saved copy then goes.
    async function checkDone() {
      if (!current || !current.woId) return;
      let wo;
      try { const j = await AE.api('GET', '/api/workorder/' + current.woId); wo = (j && j.workorder) || AE.unwrap(j); } catch (_) { return; }
      if (wo && Number(wo.workorderStatusId) !== INITIAL_CHECKIN) {
        const done = current; current = null;
        try { await call('POST', '/' + done.id + '/remove', {}); AE.track('checkinDrafts:finished'); } catch (_) { current = done; }
      }
    }

    // ------------------------------------------------------------ arrival drawer
    const arrivalId = () => { const m = location.pathname.match(/^\/check-in\/arrivals\/(\d+)\/?$/); return m ? Number(m[1]) : null; };
    let boxFor = null, boxData = null, boxAt = 0;
    async function arrivalBox() {
      const id = arrivalId();
      const old = document.getElementById(BOX_ID);
      if (!id) { old?.remove(); boxFor = null; return; }
      // The drawer's contact-method box: ours goes at the end of the column that holds it.
      const anchor = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.trim() === 'Preferred contact method');
      const column = anchor && anchor.closest('div') && anchor.closest('div').parentElement && anchor.closest('div').parentElement.parentElement;
      if (!column) return;
      if (boxFor !== id || Date.now() - boxAt > 60000) {
        boxFor = id; boxAt = Date.now();
        try { boxData = (await call('GET', '?arrival=' + id)).checkins || []; } catch (_) { boxData = []; }
      }
      const d = (boxData || [])[0];
      if (!d) { old?.remove(); return; }
      if (old && old.dataset.id === d.id && old.parentElement === column) return;
      old?.remove();
      const box = h('div', { id: BOX_ID, class: 'sg', 'data-id': d.id },
        h('span', { style: 'line-height:0', html: AE.actionIcon('checkinDrafts', 26) }),
        h('div', { class: 'txt' }, h('b', { style: 'display:block' }, 'Incomplete check-in'),
          h('span', { class: 'sg-soft' }, 'Saved ' + fmtWhen(d.updatedAt || d.at) + ' by ' + (d.by || 'someone') + ' · ' + STEPS[Number(d.step) || 0] + ' step')),
        h('button', { type: 'button', class: 'sg-btn sg-primary', onclick: () => resume(d.id) }, 'Resume'),
        h('button', { type: 'button', class: 'sg-btn', onclick: async () => {
          AE.track('checkinDrafts:reprint');
          if (!(await label(labelFor(d)))) printedOrRetry(AE.toast('Return', "The label didn't print.", 'err', 30000), 'Return', 'Label printed.', labelFor(d));
        } }, 'Reprint label'),
        h('button', { type: 'button', class: 'sg-btn', onclick: async () => {
          const ok = await AE.confirm({ icon: 'checkinDrafts', title: 'Delete this saved check-in?', message: 'The label will cease to function, and all data will be deleted.', confirmLabel: 'Delete' });
          if (!ok) return;
          try { await call('POST', '/' + d.id + '/remove', {}); AE.track('checkinDrafts:discard'); boxData = []; box.remove(); }
          catch (e) { AE.toast('Return', { html: "Couldn't discard it." + report('Discarding saved check-in ' + d.id, e) }, 'err'); }
        } }, 'Discard'));
      column.append(box);
    }

    // ------------------------------------------------------------ the button
    const FORWARD = /^(continue|create work ?order|check-?in|next)$/i;
    let lastPath = location.pathname, lastCheck = 0;
    function tick() {
      const onCheckin = location.pathname === '/check-in';
      if (lastPath === '/check-in' && !onCheckin) checkDone().then(() => { if (current && !current.woId) current = null; }); // left the check-in
      lastPath = location.pathname;
      arrivalBox();
      const existing = document.getElementById(BTN_ID);
      if (!onCheckin) { existing?.remove(); return; }
      // Not on the Device step: its boxes keep their own values and don't read them back from Portal's state,
      // so a check-in saved there comes back with nothing filled in (Garrett's live test, Oct 6, 2026).
      if (slice('formStep', false) === DEVICE_STEP) { existing?.remove(); return; }
      const woId = slice('workorder', false);
      if (current && woId && woId.workorderId) current.woId = woId.workorderId;
      if (current && current.woId && Date.now() - lastCheck > 20000) { lastCheck = Date.now(); checkDone(); }
      if (existing && existing.isConnected) return;
      const fwd = [...document.querySelectorAll('button')].find((b) => b.offsetParent && FORWARD.test(b.textContent.trim()) && !b.closest('.sg'));
      if (!fwd) return;
      let at = fwd;
      while (at.parentElement && at.parentElement.children.length === 1) at = at.parentElement;
      const btn = h('button', { id: BTN_ID, type: 'button', class: 'sg sg-btn', style: 'height:' + (fwd.offsetHeight || 48) + 'px',
        html: AE.icon('aetheryte', 18) + 'Save as incomplete', onclick: () => save(btn) });
      at.before(btn);
    }
    AE.every(1000, tick);

    AE.checkinDrafts = { resume, label, labelFor, CODE_RE: /^AEC([A-HJ-NP-Z2-9]{6})$/i };
  },
});
