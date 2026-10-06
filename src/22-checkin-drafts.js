/*
  Return (incomplete check-ins) — save a check-in that can't be finished yet
  and pick it up later where it left off.

  Why: cleanings have to be created within 15 minutes of their work order,
  and Portal creates the work order when the check-in leaves the Device step.
  Saved before then, the work order (and its 15 minutes) only start once the
  device is ready and the check-in is finished.

  - Save as incomplete: a button in the check-in footer on every step. It
    reads Portal's own check-in state (the check-in app's Redux slice
    "checkInSlice", through core's Portal bridge), keeps the parts a person
    typed or picked (customer, device, IMEI/serial, passcode, items with the
    device; once the work order exists also the diagnosis, notes and bin) and
    saves them to the Worker (/v1/:store/checkins). Saving the same check-in
    again updates it. Then it prints a label on the store's DYMO (DYMO
    Connect at https://127.0.0.1:41951-41960, the same 30330 labels as
    Portal's WO labels): the Aethernet mark, INCOMPLETE CHECK-IN, customer ·
    device · date and a Code128 barcode "AEC" + the 6-character code. No
    printer: the label is shown on screen to print from the browser.
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
    const { h, esc } = AE;
    const STEPS = ['Customer', 'Device', 'Diagnosis', 'Parts and services'];
    const SLICE = 'checkInSlice';
    const BTN_ID = 'ae-return-save', BOX_ID = 'ae-return-arrival', LABEL_ID = 'ae-return-label';
    const INITIAL_CHECKIN = 1; // work order status while the check-in isn't finished
    // What a person typed or picked; the rest of the slice is Portal's own bookkeeping.
    const KEEP = ['formStep', 'activeTab', 'isBusinessCustomerArrivalFlow', 'selectedBusiness', 'authorizedContacts', 'contactFields',
      'customerInfo', 'isImeiUnavailable', 'isSerialUnavailable', 'isServiceTagUnavailable', 'deviceInfo', 'customerDeviceDetails',
      'deviceDiagToggles', 'selectedDeviceIssues', 'selectedGoogleDeviceIssues', 'deviceDiagNotes', 'deviceIssuesAdditionalDetails', 'binLocation'];
    const MAX = 13000; // the Worker takes 14,000 characters of data

    document.head.append(h('style', null, `
      #${BTN_ID} { display:inline-flex; align-items:center; gap:8px; margin-right:12px; flex:none; }
      #${BTN_ID} svg { color:var(--aui-primary, #8223d2); }
      #${BOX_ID} { margin:20px 0 0; padding:12px 14px; display:flex; gap:10px; align-items:center; flex-wrap:wrap;
        border:1.5px dashed var(--aui-primary, #8223d2); border-radius:12px; font-size:14px; line-height:1.4; }
      #${BOX_ID} .txt { flex:1; min-width:180px; }
      #${BOX_ID} .sg-btn { height:32px; font-size:13px; }
      #${LABEL_ID} .lbl { width:600px; max-width:100%; aspect-ratio:600 / 225; margin:12px 0; border-radius:16px; background:#fff; box-shadow:0 1px 4px rgba(0,0,0,.25); }
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
    // Code128 (code set B: letters, digits, punctuation), as bar widths.
    const C128 = ['212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111', '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232', '2331112'];
    function barcodeSvg(text) {
      const vals = [104, ...[...text].map((c) => c.charCodeAt(0) - 32)];
      vals.push(vals.reduce((sum, v, i) => sum + (i ? i * v : v), 0) % 103, 106);
      let x = 0, rects = '';
      for (const v of vals) [...C128.at(v)].forEach((w, i) => { if (i % 2 === 0) rects += '<rect x="' + x + '" y="0" width="' + w + '" height="40"/>'; x += Number(w); });
      return '<svg viewBox="0 0 ' + x + ' 40" preserveAspectRatio="none" width="100%" height="100%">' + rects + '</svg>';
    }
    const mark = (size, color) => AE.icon('aetheryte', size).replace(/currentColor/g, color);
    // The label as the store sees it (on screen, when there's no printer).
    function labelHtml(d) {
      return '<div class="lbl" style="display:flex;gap:14px;align-items:center;padding:4% 4%;box-sizing:border-box;font-family:Arial,Helvetica,sans-serif;color:#000">' +
        '<div style="width:20%;line-height:0">' + mark(100, '#000').replace(/width="\d+" height="\d+"/, 'width="100%" height="100%"') + '</div>' +
        '<div style="flex:1;min-width:0"><div style="font-weight:700;font-size:20px">INCOMPLETE CHECK-IN</div>' +
        '<div style="font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(d.line) + '</div>' +
        '<div style="height:44px;margin-top:6px">' + barcodeSvg(d.code) + '</div><div style="font-size:12px;letter-spacing:2px">' + esc(d.code) + '</div></div></div>';
    }
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
    // Portal's own WO label layout (30330 Return Address, landscape, twips), with the mark on the left.
    async function labelXml(d) {
      return '<?xml version="1.0" encoding="utf-8"?><DieCutLabel Version="8.0" Units="twips"><PaperOrientation>Landscape</PaperOrientation><Id>ReturnAddress</Id><PaperName>30330 Return Address</PaperName>' +
        '<DrawCommands><RoundRectangle X="0" Y="0" Width="1080" Height="2880" Rx="180" Ry="180" /></DrawCommands>' +
        '<ObjectInfo><ImageObject><Name>MARK</Name>' + COLORS + '<Image>' + await markPng() + '</Image><ScaleMode>Uniform</ScaleMode><BorderWidth>0</BorderWidth>' +
        '<BorderColor Alpha="255" Red="0" Green="0" Blue="0" /><HorizontalAlignment>Center</HorizontalAlignment><VerticalAlignment>Center</VerticalAlignment></ImageObject>' +
        '<Bounds X="120" Y="150" Width="600" Height="780" /></ObjectInfo>' +
        textObj('TITLE', 'INCOMPLETE CHECK-IN', 11, true, [780, 60, 1980, 230]) +
        textObj('LINE', d.line, 8, false, [780, 290, 1980, 180]) +
        '<ObjectInfo><BarcodeObject><Name>BARCODE</Name>' + COLORS.replace('<IsVariable>False</IsVariable>', '<IsVariable>True</IsVariable>') +
        '<Text>' + xml(d.code) + '</Text><Type>Code128Auto</Type><Size>Small</Size><TextPosition>Bottom</TextPosition>' +
        '<TextFont Family="Arial" Size="8" Bold="False" Italic="False" Underline="False" Strikeout="False" /><CheckSumFont Family="Arial" Size="8" Bold="False" Italic="False" Underline="False" Strikeout="False" />' +
        '<TextEmbedding>None</TextEmbedding><ECLevel>0</ECLevel><HorizontalAlignment>Left</HorizontalAlignment><QuietZonesPadding Left="0" Top="0" Right="0" Bottom="0" /></BarcodeObject>' +
        '<Bounds X="780" Y="490" Width="1980" Height="530" /></ObjectInfo></DieCutLabel>';
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
    // No printer: the label on screen, with a Print button (the browser's print).
    function showLabel(d, why) {
      document.getElementById(LABEL_ID)?.remove();
      const close = () => box.remove();
      const box = h('div', { id: LABEL_ID, class: 'sg sg-confirm-scrim', onclick: (e) => { if (e.target === box) close(); } },
        h('div', { class: 'sg sg-card sg-confirm', role: 'dialog', 'aria-modal': 'true', style: 'width:min(680px, 100%)' },
          h('h2', { style: 'display:flex;align-items:center;gap:10px' }, h('span', { html: AE.actionIcon('checkinDrafts', 28), style: 'line-height:0' }), 'Print this label'),
          h('div', { class: 'sg-soft' }, why),
          h('div', { html: labelHtml(d) }),
          h('div', { class: 'sg-actions' }, h('button', { type: 'button', class: 'sg-btn sg-lg', onclick: close }, 'Close'),
            h('button', { type: 'button', class: 'sg-btn sg-lg sg-primary', onclick: () => {
              const w = window.open('', '_blank', 'width=700,height=360');
              if (!w) return;
              w.document.write('<!doctype html><title>' + esc(d.code) + '</title><style>@page{size:2in .75in;margin:0}body{margin:0}.lbl{width:2in;height:.75in}</style>' + labelHtml(d));
              w.document.close(); w.focus(); w.print();
            } }, 'Print'))));
      document.body.append(box);
    }
    async function label(d) {
      try { await printLabel(d); return true; }
      catch (e) { console.warn('[' + AE_NAME + '] Return: label not printed:', e.message || e); showLabel(d, "Couldn't reach the label printer, so here's the label to print from the browser."); return false; }
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
        const printed = await label({ code: 'AEC' + j.id, line });
        AE.toast('Saved as incomplete', [who, dev].filter(Boolean).join(' · ') + ', at the ' + STEPS[step] + ' step. ' +
          (printed ? 'The label is printing; stick it on the device and scan it to pick up where you left off.' : 'Stick the label on the device and scan it to pick up where you left off.') +
          (woId ? ' The work order already exists, so its 15-minute cleaning window has started.' : ''), 'ok', 12000);
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
        h('button', { type: 'button', class: 'sg-btn', onclick: () => { AE.track('checkinDrafts:reprint'); label(labelFor(d)); } }, 'Reprint label'),
        h('button', { type: 'button', class: 'sg-btn', onclick: async () => {
          const ok = await AE.confirm({ icon: 'checkinDrafts', title: 'Discard this saved check-in?', message: 'Its label stops working. What was entered is deleted.', confirmLabel: 'Discard' });
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
