/*
  Return (arrival labels) - save an arrival to a barcode, and scan it to come
  back to the arrival. Nothing is stored anywhere: the barcode is the arrival.

  - Return label: the round Return button at the left of an arrival's drawer
    footer (beside Swiftcast's on a cleaning). Prints a
    label on the store's DYMO (DYMO Connect at https://127.0.0.1:41951-41960,
    the same 30330 labels as Portal's WO labels): the Aethernet mark,
    "Aethernet - Return", customer · device · date and a Code128 barcode
    "AER" + the arrival number. If it can't print, the message offers Retry
    print.
  - Scan: Master's Mend's scan to open sends AER codes here, and the
    arrival opens in its drawer.
  - Cleanings gate: on an Asurion Mobility arrival (program 5062), Create
    work order first asks whether cleanings can be created for the device.
    Yes, or "Customer account does not have the option": the work order is
    created. "Unable to use device" or "Customer does not know carrier PIN":
    a Return ticket (the arrival's label) is printed and the BOH is to create
    the cleanings with the device before the work order is created (cleanings
    have to be created within 15 minutes of their work order). If the
    arrival can't be read, the button works as usual.

  Before Nov 17, 2026 Return saved whole incomplete check-ins (customer
  details and passcode) to the Worker; that was paused Nov 11 and is gone.
  The Worker's /checkins routes still answer 410.
*/
AE.shard({
  id: 'checkinDrafts',
  name: 'Return',
  sites: ['portal.ubreakifix.net'],
  run() {
    const { h } = AE;
    const BTN_ID = 'ae-return-label';
    const TITLE = 'Aethernet - Return'; // the label's top line
    const CODE_RE = /^AER(\d{1,12})$/i;
    const CREATE_WO = /^create work ?order$/i;
    const REASONS = [
      { label: 'Unable to use device', value: 'device', ticket: true },
      { label: 'Customer does not know carrier PIN', value: 'pin', ticket: true },
      { label: 'Customer account does not have the option', value: 'option', ticket: false },
    ];

    document.head.append(h('style', null, `
      #${BTN_ID} { order:-1; margin-right:auto; align-self:center; overflow:hidden; background:#1a1c1e; }
      #${BTN_ID} .sg-aicon { border-radius:50%; display:block; width:100%; height:100%; }
      *:has(> #sg-autoclose-btn) > #${BTN_ID} { margin-right:12px; } /* Swiftcast's button sits next to it and takes the free space */
    `));

    const report = (what, e) => ' If you keep seeing this, ' + AE.bugLink('report a bug', { where: 'Return', error: what + ': ' + ((e && e.message) || e) }) + '!';
    const fmtDay = (d) => d.toLocaleDateString([], { month: 'short', day: 'numeric' });

    // ------------------------------------------------------------ the arrival
    const arrivals = new Map(); // arrivalId → promise of the arrival (dropped on failure, so the next look tries again)
    function arrival(id) {
      if (!arrivals.has(id)) arrivals.set(id, AE.api('GET', '/api/arrivals/' + id).then((j) => {
        const a = AE.unwrap(j);
        if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('not an arrival');
        return a;
      }).catch((e) => { arrivals.delete(id); throw e; }));
      return arrivals.get(id);
    }
    const programOf = (a) => Number((a && a.program && a.program.programId) || (a && a.programId)) || null;
    const isMobility = (a) => programOf(a) === AE.PARENT_PROGRAM_ID;
    // The device's name, wherever the arrival keeps it.
    function deviceName(a) {
      const seen = new Set();
      const find = (o, depth) => {
        if (!o || typeof o !== 'object' || depth > 4 || seen.has(o)) return '';
        seen.add(o);
        for (const k of ['deviceName', 'modelName', 'deviceModelName', 'deviceCatalogName']) if (typeof o[k] === 'string' && o[k].trim()) return o[k].trim();
        for (const v of Object.values(o)) { const x = find(v, depth + 1); if (x) return x; }
        return '';
      };
      return find(a.customerDevice, 0) || find(a, 0) || (a.customerDevice && typeof a.customerDevice.name === 'string' ? a.customerDevice.name.trim() : '');
    }
    const labelFor = (a) => ({ code: 'AER' + a.arrivalId, line: [AE.data.nameOf(a), deviceName(a), fmtDay(new Date())].filter(Boolean).join(' · ') });

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
    // ------------------------------------------------------------ Return label (arrival drawer)
    async function printFor(id, btn) {
      if (btn) btn.disabled = true;
      try {
        const d = labelFor(await arrival(id));
        AE.track('checkinDrafts:label');
        if (await label(d)) AE.toast('Return', 'Label printed.', 'ok');
        else printedOrRetry(AE.toast('Return', "The label didn't print.", 'err', 30000), 'Return', 'Label printed.', d);
      } catch (e) {
        AE.toast('Return', { html: "Couldn't read this arrival." + report('Return label for arrival ' + id, e) }, 'err', 10000);
      } finally { if (btn) btn.disabled = false; }
    }

    // ------------------------------------------------------------ scan to open
    const goTo = (url) => {
      const idx = ((history.state && history.state.idx) || 0) + 1;
      history.pushState({ usr: null, key: Math.random().toString(36).slice(2, 10), idx }, '', url);
      dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    };
    async function open(id) {
      id = Number(id);
      if (new RegExp('^/check-in/arrivals/' + id + '/?$').test(location.pathname)) return 'already on arrival ' + id;
      try { await arrival(id); } catch (e) {
        if (/HTTP 404/.test((e && e.message) || '')) { AE.toast('Return', 'No arrival has that label.', 'err', 8000); return 'no such arrival'; }
        AE.toast('Return', { html: "Couldn't open that arrival." + report('Opening arrival ' + id, e) }, 'err', 10000);
        return 'arrival lookup failed';
      }
      goTo('/check-in/arrivals/' + id);
      AE.track('checkinDrafts:open');
      return 'opened arrival ' + id;
    }

    // ------------------------------------------------------------ cleanings gate
    // The arrival a Create work order button belongs to: the drawer's, or the check-in's (Portal's check-in slice).
    function arrivalHere() {
      const m = location.pathname.match(/^\/check-in\/arrivals\/(\d+)\/?$/);
      if (m) return Number(m[1]);
      if (location.pathname !== '/check-in') return null;
      let r = null;
      try { r = AE.portal('select', { slice: 'checkInSlice', key: 'arrivalDetails', fresh: false }); } catch (_) { /* the route's state still may have it */ }
      const fromSlice = r && r.found && r.value && Number(r.value.arrivalId);
      const fromRoute = history.state && history.state.usr && Number(history.state.usr.arrivalIdForCheckin);
      return fromSlice || fromRoute || null;
    }
    const cleared = new Set(); // arrivals answered this page load: their Create work order goes straight through
    let passing = false, asking = false;
    // Ask, then: true = create the work order, false = don't.
    async function ask(a) {
      const able = await AE.confirm({ icon: 'checkinDrafts', title: 'Are you able to create cleanings for this device?',
        choices: [{ label: 'Yes', value: 'yes', primary: true }, { label: 'No', value: 'no' }] });
      if (able === 'yes') { AE.track('checkinDrafts:gateYes'); return true; }
      if (able !== 'no') return false;
      const why = await AE.confirm({ icon: 'checkinDrafts', title: 'Why not?', choices: REASONS.map(({ label, value }) => ({ label, value })) });
      const reason = REASONS.find((r) => r.value === why);
      if (!reason) return false;
      AE.track('checkinDrafts:gate:' + reason.value);
      if (!reason.ticket) return true;
      const d = labelFor(a);
      for (let printed = await label(d); ; printed = await label(d)) {
        const retry = await AE.confirm({ icon: 'checkinDrafts', title: 'Return ticket created',
          message: AE.esc('Alert the BOH to create the cleanings with the device before creating the work order.'),
          warning: printed ? null : "The label didn't print.",
          confirmLabel: printed ? 'OK' : 'Retry print', cancelLabel: printed ? null : 'OK' });
        if (printed || !retry) return false;
      }
    }
    async function gate(btn, id) {
      if (asking) return;
      asking = true;
      let go = true;
      try {
        let a = null;
        try { a = await arrival(id); } catch (_) { /* can't tell: Portal's button works as usual */ }
        if (a && isMobility(a)) go = await ask(a);
      } finally { asking = false; }
      if (!go) return;
      cleared.add(id);
      if (!btn.isConnected || btn.disabled) return;
      passing = true;
      try { btn.click(); } finally { passing = false; }
    }
    // Capture on window: before Portal's own handlers (React listens at its root).
    window.addEventListener('click', (e) => {
      if (passing) return;
      const btn = e.target && e.target.closest && e.target.closest('button');
      if (!btn || btn.closest('.sg') || !CREATE_WO.test(btn.textContent.trim())) return;
      const id = arrivalHere();
      if (!id || cleared.has(id)) return;
      e.preventDefault(); e.stopImmediatePropagation();
      gate(btn, id);
    }, true);

    // ------------------------------------------------------------ the button
    function tick() {
      const m = location.pathname.match(/^\/check-in\/arrivals\/(\d+)\/?$/);
      const existing = document.getElementById(BTN_ID);
      if (!m) { existing?.remove(); return; }
      const id = Number(m[1]);
      if (existing && existing.isConnected && Number(existing.dataset.id) === id) return;
      existing?.remove();
      const checkin = AE.findButton((t) => t === 'Check-in', (b) => !!b.closest('.sg'));
      if (!checkin) return;
      // The drawer footer, the full-width row justified to flex-end (where Swiftcast's button goes too): the button sits at its far left.
      let footer = checkin.parentElement;
      for (let el = checkin.parentElement; el && el !== document.body; el = el.parentElement) {
        if (getComputedStyle(el).justifyContent === 'flex-end') { footer = el; break; }
      }
      const size = checkin.offsetHeight || 48;
      const btn = h('button', { id: BTN_ID, type: 'button', class: 'sg-fab', 'data-id': id, 'aria-label': 'Return label', title: 'Return label',
        style: 'width:' + size + 'px;height:' + size + 'px', html: AE.actionIcon('checkinDrafts', size), onclick: () => printFor(id, btn) });
      footer.insertBefore(btn, footer.firstChild);
    }
    AE.every(1000, tick);
    // Same frame as Portal's drawer footer (2.23). Off arrival pages it costs one path check.
    AE.onDom(() => {
      const on = /^\/check-in\/arrivals\/\d+\/?$/.test(location.pathname), b = document.getElementById(BTN_ID);
      if (on ? !b || !b.isConnected : !!b) tick();
    });

    AE.checkinDrafts = { open, CODE_RE, labelFor, isMobility };
  },
});
