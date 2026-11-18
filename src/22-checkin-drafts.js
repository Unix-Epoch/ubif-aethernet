/*
  Return (arrivals): intake notes for the techs in the back, a label to find
  the arrival again, and the Asurion Mobility cleanings question.

  - The round Return button at the left of an arrival's drawer footer opens
    the intake form (IMEI last digit, password, callback number, device
    nickname, issue, items with device, initial notes; Password and Items
    with device have a "None" box). Save and print label
    seals the notes in this browser and prints the label (the store's DYMO,
    DYMO Connect at https://127.0.0.1:41951-41960, Portal's 30330 labels):
    the Aethernet mark, "Aethernet - Return", customer · device · date and a
    Code128 barcode "AER" + arrival number + "K" + a 16-digit secret. With
    nothing filled in, the label is just "AER" + arrival number.
  - Sealed: the secret is made here and exists only on the label (and in the
    browsers that saved or scanned it, kept 3 days). The notes are encrypted
    with AES-GCM under a key made from it, and the Worker (/v1/:store/return)
    gets the ciphertext plus a token made from it, of which it keeps only a
    hash. The Worker can't read the notes, and nobody without the label can
    read, change or delete them.
  - Scan (Master's Mend's scan to open sends AER codes here): the arrival
    opens, and its notes show in a box in the drawer and in a panel on every
    check-in step for that arrival. Both fold away. On a check-in step, Fill
    types the notes into the boxes on that step the way a person would
    (Portal's state isn't touched: restoring it never showed in the boxes).
    The notes box (Additional details) gets the initial notes, then the items
    with the device; the issue is not copied there.
  - Deleted: once the arrival's check-in has made a work order that has left
    Initial check-in (status 1), the browser that knows the label removes the
    notes. The Worker deletes anything older than 3 days.
  - Cleanings question: on an Asurion Mobility arrival (program 5062), the
    drawer's Check-in first asks whether cleanings can be created for the
    device. Yes, or "Customer account does not have the option": the
    check-in opens. "Unable to use device" or "Customer does not know carrier
    PIN": the intake form opens, then a Return ticket (the arrival's label,
    carrying the notes) is printed and the BOH is to
    create the cleanings with the device before the work order is created
    (cleanings have to be created within 15 minutes of their work order). If
    the arrival can't be read, the button works as usual.

  Before Nov 17, 2026 Return saved whole check-ins in plain text (paused Nov
  11 after the audit). The Worker's old /checkins routes still answer 410.
*/
AE.shard({
  id: 'checkinDrafts',
  name: 'Return',
  sites: ['portal.ubreakifix.net'],
  run() {
    const { h } = AE;
    const BTN_ID = 'ae-return-label', BOX_ID = 'ae-return-notes', PANEL_ID = 'ae-return-panel', FORM_ID = 'ae-return-form';
    const TITLE = 'Aethernet - Return'; // the label's top line
    const CODE_RE = /^AER(\d{1,12})(?:K(\d{16}))?$/i;
    const CHECK_IN = /^check-?in$/i; // the arrival drawer's button that starts the check-in
    const INITIAL_CHECKIN = 1;       // work order status while the check-in isn't finished
    const KEEP_MS = 3 * 86400000;    // the Worker keeps notes 3 days; so do the browsers that know a label
    const KEYS = 'ae_return_keys';   // GM: { [arrivalId]: { s, at, woId } }
    const REASONS = [
      { label: 'Unable to use device', value: 'device', ticket: true },
      { label: 'Customer does not know carrier PIN', value: 'pin', ticket: true },
      { label: 'Customer account does not have the option', value: 'option', ticket: false },
    ];
    // The intake fields, in form order. long: a wide box; area: several lines; none: a "None" box (saved in notes.none, never filled).
    const FIELDS = [
      { k: 'imei', label: 'IMEI last digit', max: 1 },
      { k: 'password', label: 'Password', max: 60, none: true },
      { k: 'callback', label: 'Callback number', max: 30 },
      { k: 'nickname', label: 'Device nickname', max: 60 },
      { k: 'issue', label: 'Issue', max: 300, long: true },
      { k: 'items', label: 'Items with device', max: 200, long: true, none: true },
      { k: 'notes', label: 'Initial notes', max: 2000, long: true, area: true },
    ];

    document.head.append(h('style', null, `
      #${BTN_ID} { order:-1; margin-right:auto; align-self:center; overflow:hidden; background:#1a1c1e; }
      #${BTN_ID} .sg-aicon { border-radius:50%; display:block; width:100%; height:100%; }
      *:has(> #sg-autoclose-btn) > #${BTN_ID} { margin-right:12px; } /* Swiftcast's button sits next to it and takes the free space */
      #${FORM_ID} .sg-confirm { width:min(560px, 100%); max-height:calc(100vh - 32px); overflow:auto; }
      #${FORM_ID} .grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
      #${FORM_ID} .f { display:flex; flex-direction:column; gap:4px; min-width:0; } #${FORM_ID} .f.long { grid-column:1/-1; }
      #${FORM_ID} label { font-size:13px; color:var(--aui-on-surface-variant, #5d5e61); }
      #${FORM_ID} .lh { display:flex; align-items:center; justify-content:space-between; gap:8px; }
      #${FORM_ID} .none { display:flex; align-items:center; gap:4px; cursor:pointer; }
      #${FORM_ID} .none input { width:16px; height:16px; margin:0; accent-color:var(--aui-primary, #c41230); }
      #${FORM_ID} input:disabled, #${FORM_ID} textarea:disabled { opacity:.45; }
      #${FORM_ID} input:not([type=checkbox]), #${FORM_ID} textarea { border:1px solid var(--aui-outline, #8b8b8f); border-radius:8px; padding:12px; font:inherit;
        background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e); }
      #${FORM_ID} textarea { min-height:72px; resize:vertical; }
      #${FORM_ID} .sg-actions { margin-top:20px; }
      .ae-return-notes { font-size:14px; line-height:1.45; }
      .ae-return-notes .hd { display:flex; align-items:center; gap:10px; cursor:pointer; user-select:none; }
      .ae-return-notes .hd b { flex:1; }
      .ae-return-notes .hd .chev { transition:transform .15s; }
      .ae-return-notes.closed .hd .chev { transform:rotate(-90deg); }
      .ae-return-notes.closed .bd { display:none; }
      .ae-return-notes dl { display:grid; grid-template-columns:auto 1fr; gap:4px 14px; margin:10px 0 0; }
      .ae-return-notes dt { color:var(--aui-on-surface-variant, #5d5e61); } .ae-return-notes dd { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; }
      .ae-return-notes .act { display:flex; gap:8px; margin-top:12px; flex-wrap:wrap; }
      #${BOX_ID} { margin:20px 0 0; padding:14px 16px; border:1.5px dashed var(--aui-primary, #8223d2); border-radius:12px; }
      #${PANEL_ID} { position:fixed; right:20px; bottom:104px; z-index:2147483640; width:340px; max-height:calc(100vh - 200px); overflow:auto; padding:14px 16px; }
    `));

    const report = (what, e) => ' If you keep seeing this, ' + AE.bugLink('report a bug', { where: 'Return', error: what + ': ' + ((e && e.message) || e) }) + '!';
    const fmtDay = (d) => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    const fmtWhen = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

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
    // The label for an arrival: with the secret when it has sealed notes.
    const labelFor = (a, secret) => ({ code: 'AER' + a.arrivalId + (secret ? 'K' + secret : ''),
      line: [AE.data.nameOf(a), deviceName(a), fmtDay(new Date())].filter(Boolean).join(' · ') });

    // ------------------------------------------------------------ sealing
    const enc = new TextEncoder();
    const sha = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
    const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
    const b64 = (u8) => btoa(String.fromCharCode(...u8));
    const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    // 16 random digits (no modulo bias: bytes of 250 and up are drawn again).
    function newSecret() {
      let out = '';
      while (out.length < 16) for (const b of crypto.getRandomValues(new Uint8Array(24))) if (b < 250 && out.length < 16) out += String(b % 10);
      return out;
    }
    const tokenOf = async (secret) => hex(await sha('ae-return-token:' + secret));
    const keyOf = async (secret) => crypto.subtle.importKey('raw', await sha('ae-return-key:' + secret), 'AES-GCM', false, ['encrypt', 'decrypt']);
    async function seal(secret, notes) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyOf(secret), enc.encode(JSON.stringify(notes))));
      return { iv: b64(iv), data: b64(data) };
    }
    async function unseal(secret, row) {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(row.iv) }, await keyOf(secret), unb64(row.data));
      const j = JSON.parse(new TextDecoder().decode(plain));
      return j && typeof j === 'object' ? j : {};
    }

    // ------------------------------------------------------------ labels this browser knows (3 days)
    function keys() {
      const all = GM_getValue(KEYS, {}) || {}, out = {};
      let pruned = false;
      for (const [id, v] of Object.entries(all)) {
        if (v && /^\d{16}$/.test(v.s || '') && Date.now() - (v.at || 0) < KEEP_MS) out[id] = v; else pruned = true;
      }
      if (pruned) GM_setValue(KEYS, out);
      return out;
    }
    const keyFor = (id) => keys()[id] || null;
    function remember(id, s, extra) {
      const all = keys(), old = all[id] && all[id].s === s ? all[id] : null;
      all[id] = { s, at: old ? old.at : Date.now(), woId: old ? old.woId || null : null, ...(extra || {}) };
      GM_setValue(KEYS, all);
    }
    function forget(id) { const all = keys(); delete all[id]; GM_setValue(KEYS, all); notesCache.delete(Number(id)); }

    // ------------------------------------------------------------ the Worker
    const call = (path, body) => AE.waymark.call('POST', '/return' + path, body);
    const readFailed = new Map(); // arrivalId → when the last read failed (the page watcher doesn't retry for 30 s)
    const notesCache = new Map(); // arrivalId → { notes, by, at, updatedAt } | null (no notes), for this page
    async function readNotes(id, fresh) {
      const k = keyFor(id);
      if (!k) return null;
      if (!fresh && notesCache.has(id)) return notesCache.get(id);
      if (!fresh && Date.now() - (readFailed.get(id) || 0) < 30000) throw new Error('the Worker failed just now');
      let v = null;
      try {
        const row = await call('/read', { arrivalId: id, token: await tokenOf(k.s) });
        v = { notes: await unseal(k.s, row), by: row.by, at: row.at, updatedAt: row.updatedAt };
      } catch (e) {
        if (e && e.status === 404) { forget(id); v = null; } // finished, discarded or past 3 days
        else { readFailed.set(id, Date.now()); throw e; }
      }
      notesCache.set(id, v);
      return v;
    }
    async function saveNotes(id, secret, notes) {
      await call('', { arrivalId: id, token: await tokenOf(secret), ...(await seal(secret, notes)) });
      remember(id, secret);
      notesCache.set(id, { notes, by: null, at: null, updatedAt: new Date().toISOString() });
    }

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
    // (about 330 twips in) back inside it, so everything starts there. The barcode takes the whole bottom half: a code
    // with its key is about 240 modules, and at full width that is still 2 dots a module on a 300 dpi LabelWriter.
    async function labelXml(d) {
      return '<?xml version="1.0" encoding="utf-8"?><DieCutLabel Version="8.0" Units="twips"><PaperOrientation>Landscape</PaperOrientation><Id>ReturnAddress</Id><PaperName>30330 Return Address</PaperName>' +
        '<DrawCommands><RoundRectangle X="0" Y="0" Width="1080" Height="2880" Rx="180" Ry="180" /></DrawCommands>' +
        '<ObjectInfo><ImageObject><Name>MARK</Name>' + COLORS + '<Image>' + await markPng() + '</Image><ScaleMode>Uniform</ScaleMode><BorderWidth>0</BorderWidth>' +
        '<BorderColor Alpha="255" Red="0" Green="0" Blue="0" /><HorizontalAlignment>Center</HorizontalAlignment><VerticalAlignment>Center</VerticalAlignment></ImageObject>' +
        '<Bounds X="340" Y="60" Width="400" Height="420" /></ObjectInfo>' +
        textObj('TITLE', TITLE, 11, true, [800, 70, 1770, 210]) +
        textObj('LINE', d.line, 8, false, [800, 290, 1770, 170]) +
        '<ObjectInfo><BarcodeObject><Name>BARCODE</Name>' + COLORS.replace('<IsVariable>False</IsVariable>', '<IsVariable>True</IsVariable>') +
        '<Text>' + xml(d.code) + '</Text><Type>Code128Auto</Type><Size>Small</Size><TextPosition>None</TextPosition>' +
        '<TextFont Family="Arial" Size="8" Bold="False" Italic="False" Underline="False" Strikeout="False" /><CheckSumFont Family="Arial" Size="8" Bold="False" Italic="False" Underline="False" Strikeout="False" />' +
        '<TextEmbedding>None</TextEmbedding><ECLevel>0</ECLevel><HorizontalAlignment>Left</HorizontalAlignment><QuietZonesPadding Left="0" Top="0" Right="0" Bottom="0" /></BarcodeObject>' +
        '<Bounds X="340" Y="520" Width="2420" Height="480" /></ObjectInfo></DieCutLabel>';
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
    // ------------------------------------------------------------ intake form (the Return button)
    // Resolves the saved label (or null if closed). opts.print false leaves printing to the caller.
    function intake(id, opts) {
      return new Promise((resolve) => intakeForm(id, opts || {}, resolve));
    }
    async function intakeForm(id, opts, resolve) {
      if (document.getElementById(FORM_ID)) return resolve(null);
      let a, cur = null;
      try { a = await arrival(id); } catch (e) {
        AE.toast('Return', { html: "Couldn't read this arrival." + report('Return intake for arrival ' + id, e) }, 'err', 10000); return resolve(null);
      }
      if (keyFor(id)) {
        try { cur = await readNotes(id, true); } catch (e) {
          AE.toast('Return', { html: "Couldn't load the saved notes." + report('Loading Return notes for arrival ' + id, e) }, 'err', 10000); return resolve(null);
        }
      }
      const vals = (cur && cur.notes) || {};
      const inputs = {}, nones = {};
      const field = (f) => {
        const el = f.area ? h('textarea', { id: 'ae-return-f-' + f.k, maxlength: f.max }) : h('input', { id: 'ae-return-f-' + f.k, maxlength: f.max, autocomplete: 'off',
          inputmode: f.k === 'imei' ? 'numeric' : f.k === 'callback' ? 'tel' : null });
        el.value = typeof vals[f.k] === 'string' ? vals[f.k] : '';
        inputs[f.k] = el;
        const name = h('label', { for: 'ae-return-f-' + f.k }, f.label);
        if (!f.none) return h('div', { class: 'f' + (f.long ? ' long' : '') }, name, el);
        const box = h('input', { type: 'checkbox', id: 'ae-return-f-' + f.k + '-none', onchange: () => { el.disabled = box.checked; } });
        box.checked = el.disabled = Array.isArray(vals.none) && vals.none.includes(f.k);
        nones[f.k] = box;
        return h('div', { class: 'f' + (f.long ? ' long' : '') }, h('div', { class: 'lh' }, name, h('label', { class: 'none' }, box, 'None')), el);
      };
      const close = () => { scrim.remove(); document.removeEventListener('keydown', onKey, true); };
      const done = () => { close(); resolve(null); };
      const save = h('button', { type: 'button', class: 'sg-btn sg-lg sg-primary', onclick: async () => {
        const notes = {};
        const none = FIELDS.filter((f) => nones[f.k] && nones[f.k].checked).map((f) => f.k);
        for (const f of FIELDS) { const v = inputs[f.k].value.trim().slice(0, f.max); if (v && !none.includes(f.k)) notes[f.k] = v; }
        if (none.length) notes.none = none;
        save.disabled = true;
        let secret = null;
        if (Object.keys(notes).length || cur) {
          secret = cur ? keyFor(id).s : newSecret();
          try { await saveNotes(id, secret, notes); }
          catch (e) {
            save.disabled = false;
            if (e && e.status === 409) AE.toast('Return', 'This arrival already has Return notes. Scan its label to see them.', 'err', 10000);
            else AE.toast('Return', { html: "Couldn't save the notes." + report('Saving Return notes for arrival ' + id, e) }, 'err', 12000);
            return;
          }
          AE.track('checkinDrafts:save');
        }
        close();
        drawBox(id, true);
        const d = labelFor(a, secret);
        resolve(d);
        if (opts.print === false) return;
        AE.track('checkinDrafts:label');
        if (await label(d)) AE.toast('Return', 'Label printed.', 'ok');
        else printedOrRetry(AE.toast('Return', "The label didn't print.", 'err', 30000), 'Return', 'Label printed.', d);
      } }, 'Save and print label');
      const card = h('div', { class: 'sg sg-card sg-confirm', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Return' },
        h('h2', { class: 'ae-head', style: 'display:flex;align-items:center;gap:10px' }, h('span', { html: AE.actionIcon('checkinDrafts', 28), style: 'line-height:0;flex:none' }), 'Return'),
        h('div', { class: 'grid' }, FIELDS.map(field)),
        h('div', { class: 'sg-actions' }, h('button', { type: 'button', class: 'sg-btn sg-lg', onclick: done }, 'Cancel'), save));
      const scrim = h('div', { id: FORM_ID, class: 'sg sg-confirm-scrim' }, card);
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(); } };
      AE.confirm.css && AE.confirm.css();
      document.addEventListener('keydown', onKey, true);
      document.body.append(scrim);
      inputs.imei.focus();
    }

    // ------------------------------------------------------------ the notes (drawer box, check-in panel)
    const FOLD = 'ae_return_folded';
    function notesCard(el, id, v, actions) {
      el.className = 'sg ae-return-notes' + (GM_getValue(FOLD, false) ? ' closed' : '') + (el.id === PANEL_ID ? ' sg-card' : '');
      el.dataset.id = id; el.dataset.at = v.updatedAt || '';
      const none = Array.isArray(v.notes.none) ? v.notes.none : [];
      const rows = FIELDS.filter((f) => v.notes[f.k] || none.includes(f.k)).flatMap((f) => [h('dt', null, f.label), h('dd', null, v.notes[f.k] || 'None')]);
      el.replaceChildren(
        h('div', { class: 'hd' + (el.id === PANEL_ID ? ' ae-head' : ''), role: 'button', tabindex: '0', 'aria-expanded': String(!GM_getValue(FOLD, false)), onclick: () => {
          const closed = !el.classList.contains('closed');
          GM_setValue(FOLD, closed);
          for (const x of document.querySelectorAll('.ae-return-notes')) { x.classList.toggle('closed', closed); x.firstChild.setAttribute('aria-expanded', String(!closed)); }
        }, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); } } },
          h('span', { html: AE.actionIcon('checkinDrafts', 26), style: 'line-height:0' }), h('b', null, 'Return'),
          h('span', { class: 'chev', html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>', style: 'line-height:0' })),
        h('div', { class: 'bd' }, h('dl', null, rows), h('div', { class: 'act' }, actions)));
      return el;
    }
    const reprint = (id) => h('button', { type: 'button', class: 'sg-btn', onclick: async () => {
      const k = keyFor(id), d = labelFor(await arrival(id), k && k.s);
      AE.track('checkinDrafts:reprint');
      if (await label(d)) AE.toast('Return', 'Label printed.', 'ok');
      else printedOrRetry(AE.toast('Return', "The label didn't print.", 'err', 30000), 'Return', 'Label printed.', d);
    } }, 'Reprint label');

    // The drawer's box, at the end of the column that holds "Preferred contact method".
    let boxBusy = false;
    async function drawBox(id, fresh) {
      const old = document.getElementById(BOX_ID);
      if (!keyFor(id)) { old?.remove(); return; }
      if (boxBusy) return;
      const anchor = AE.textEl('Preferred contact method');
      const column = anchor && anchor.closest('div') && anchor.closest('div').parentElement && anchor.closest('div').parentElement.parentElement;
      if (!column) return;
      let v;
      boxBusy = true;
      try { v = await readNotes(id, fresh); } catch (_) { return; } finally { boxBusy = false; }
      if (!v) { old?.remove(); return; }
      if (old && old.parentElement === column && Number(old.dataset.id) === id && old.dataset.at === (v.updatedAt || '')) return;
      const box = notesCard(old && old.parentElement === column ? old : h('div', { id: BOX_ID }), id, v,
        [h('button', { type: 'button', class: 'sg-btn', onclick: () => intake(id) }, 'Edit'), reprint(id)]);
      if (box.parentElement !== column) { old?.remove(); column.append(box); }
    }

    // The check-in's panel, on every step of a check-in whose arrival this browser has a label for.
    function checkinArrival() {
      let r = null;
      try { r = AE.portal('select', { slice: 'checkInSlice', key: 'arrivalDetails', fresh: false }); } catch (_) { /* the route's state still may have it */ }
      const fromSlice = r && r.found && r.value && Number(r.value.arrivalId);
      const fromRoute = history.state && history.state.usr && Number(history.state.usr.arrivalIdForCheckin);
      return fromSlice || fromRoute || null;
    }
    let panelBusy = false;
    async function drawPanel(id) {
      const old = document.getElementById(PANEL_ID);
      if (!id || !keyFor(id)) { old?.remove(); return; }
      if (panelBusy) return;
      let v;
      panelBusy = true;
      try { v = await readNotes(id, false); } catch (_) { return; } finally { panelBusy = false; }
      if (!v || location.pathname !== '/check-in') { old?.remove(); return; }
      if (old && Number(old.dataset.id) === id && old.dataset.at === (v.updatedAt || '')) return;
      const panel = notesCard(old || h('div', { id: PANEL_ID }), id, v,
        [h('button', { type: 'button', class: 'sg-btn sg-primary', onclick: () => fill(v.notes) }, 'Fill'), reprint(id)]);
      if (!panel.isConnected) document.body.append(panel);
    }

    // ------------------------------------------------------------ Fill: type the notes into this step's boxes
    // A box's name: its aria-label, placeholder, <label>, or the label text Portal's field puts next to it.
    function nameOf(el) {
      const bits = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('name')];
      if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) bits.push(l.textContent); }
      const l2 = el.closest('label'); if (l2) bits.push(l2.textContent);
      for (let p = el.parentElement, i = 0; p && i < 3; p = p.parentElement, i++) {
        const l = p.querySelector('label, legend'); if (l && !l.contains(el)) { bits.push(l.textContent); break; }
      }
      return bits.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    }
    const TARGETS = [
      { k: 'imei', re: /last digit/i },
      { k: 'password', re: /pass ?code|password|\bpin\b|unlock/i },
      { k: 'callback', re: /contact number|call ?back|alternate (phone|number)/i },
      { k: 'nickname', re: /nickname|device name/i },
      { k: 'issue', re: /\bissue|problem|symptom/i, text: true },
      { k: 'notes', re: /additional|notes?\b|details|comments/i, area: true },
    ];
    function setValue(el, v) {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      el.focus();
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    }
    function fill(notes) {
      const boxes = [...document.querySelectorAll('input, textarea')].filter((el) => !el.closest('.sg') && el.offsetParent && !el.disabled && !el.readOnly
        && (el.tagName === 'TEXTAREA' || /^(text|tel|password|number|search|)$/i.test(el.getAttribute('type') || '')));
      const used = new Set();
      let filled = 0;
      for (const t of TARGETS) {
        if (t.k === 'notes') continue;
        const v = notes[t.k];
        if (!v) continue;
        const el = boxes.find((b) => !used.has(b) && t.re.test(nameOf(b)) && (!t.area || b.tagName === 'TEXTAREA'));
        if (!el) continue;
        used.add(el);
        if (el.value.trim()) continue; // never over what someone typed
        setValue(el, v); filled++;
      }
      // Notes: the step's notes box gets the initial notes first, then the items with the device. The issue is never copied here.
      const items = typeof notes.items === 'string' && notes.items;
      const text = [typeof notes.notes === 'string' && notes.notes, items && 'Items with device: ' + items].filter(Boolean).join('\n');
      const area = text && boxes.find((b) => !used.has(b) && b.tagName === 'TEXTAREA' && TARGETS[5].re.test(nameOf(b)));
      if (area && !area.value.trim()) { setValue(area, text); filled++; }
      AE.track('checkinDrafts:fill');
      AE.toast('Return', filled ? 'Filled ' + filled + (filled === 1 ? ' box.' : ' boxes.') : 'Nothing to fill on this step.', filled ? 'ok' : 'err', 5000);
      return filled;
    }

    // ------------------------------------------------------------ finished: the work order left Initial check-in
    let sweeping = null;
    const sweep = () => (sweeping = sweeping || sweepNow().finally(() => { sweeping = null; }));
    async function sweepNow() {
      const all = keys();
      for (const [id, k] of Object.entries(all)) {
        if (!k.woId) continue;
        let wo;
        // Only a real work order (numeric workorderStatusId) can say it left Initial check-in: a failed call or odd answer changes nothing.
        try { wo = AE.shape.workorder(await AE.api('GET', '/api/workorder/' + k.woId)); } catch (_) { continue; }
        if (Number(wo.workorderStatusId) === INITIAL_CHECKIN) continue;
        try { await call('/remove', { arrivalId: Number(id), token: await tokenOf(k.s) }); }
        catch (e) { if (!(e && e.status === 404)) continue; } // 404: already gone
        AE.track('checkinDrafts:finished');
        forget(id);
      }
    }
    const watchWo = (id) => {
      const k = keyFor(id);
      if (!k || k.woId) return;
      let w = null;
      try { const r = AE.portal('select', { slice: 'checkInSlice', key: 'workorder', fresh: false }); w = r && r.found ? r.value : null; } catch (_) { /* not yet */ }
      if (w && Number(w.workorderId) > 0) remember(id, k.s, { woId: Number(w.workorderId) });
    };

    // ------------------------------------------------------------ scan to open
    const goTo = (url) => {
      const idx = ((history.state && history.state.idx) || 0) + 1;
      history.pushState({ usr: null, key: Math.random().toString(36).slice(2, 10), idx }, '', url);
      dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    };
    async function open(id, secret) {
      id = Number(id);
      try { await arrival(id); } catch (e) {
        if (/HTTP 404/.test((e && e.message) || '')) { AE.toast('Return', 'No arrival has that label.', 'err', 8000); return 'no such arrival'; }
        AE.toast('Return', { html: "Couldn't open that arrival." + report('Opening arrival ' + id, e) }, 'err', 10000);
        return 'arrival lookup failed';
      }
      if (secret) {
        remember(id, secret);
        let v = null;
        try { v = await readNotes(id, true); } catch (_) { /* shown when the Worker answers again */ }
        if (v === null && !keyFor(id)) AE.toast('Return', 'This label has no saved notes.', 'err', 8000);
      }
      AE.track('checkinDrafts:open');
      if (new RegExp('^/check-in/arrivals/' + id + '/?$').test(location.pathname)) { drawBox(id, false); return 'already on arrival ' + id; }
      goTo('/check-in/arrivals/' + id);
      return 'opened arrival ' + id;
    }
    // ------------------------------------------------------------ cleanings gate
    // The arrival whose drawer is open.
    function arrivalHere() {
      const m = location.pathname.match(/^\/check-in\/arrivals\/(\d+)\/?$/);
      return m ? Number(m[1]) : null;
    }
    const cleared = new Set(); // arrivals answered this page load: their Check-in goes straight through
    let passing = false, asking = false;
    // Ask, then: true = go on with the check-in, false = don't.
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
      // The intake form comes first, so the label carries the notes.
      const d = await AE.checkinDrafts.intake(a.arrivalId, { print: false });
      if (!d) return false;
      AE.track('checkinDrafts:label');
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
      if (!btn || btn.closest('.sg') || !CHECK_IN.test(btn.textContent.trim())) return;
      const id = arrivalHere();
      if (!id || cleared.has(id)) return;
      e.preventDefault(); e.stopImmediatePropagation();
      gate(btn, id);
    }, true);

    // ------------------------------------------------------------ the button, the box, the panel
    function tick() {
      const m = location.pathname.match(/^\/check-in\/arrivals\/(\d+)\/?$/);
      const existing = document.getElementById(BTN_ID);
      if (location.pathname === '/check-in') { const cid = checkinArrival(); if (cid) { watchWo(cid); drawPanel(cid); } else document.getElementById(PANEL_ID)?.remove(); }
      else document.getElementById(PANEL_ID)?.remove();
      if (!m) { existing?.remove(); document.getElementById(BOX_ID)?.remove(); return; }
      const id = Number(m[1]);
      drawBox(id, false);
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
      const btn = h('button', { id: BTN_ID, type: 'button', class: 'sg-fab', 'data-id': id, 'aria-label': 'Return', title: 'Return',
        style: 'width:' + size + 'px;height:' + size + 'px', html: AE.actionIcon('checkinDrafts', size), onclick: () => intake(id) });
      footer.insertBefore(btn, footer.firstChild);
    }
    AE.every(1000, tick);
    // Same frame as Portal's drawer footer (2.23). Off arrival and check-in pages it costs one path check.
    AE.onDom(() => {
      const p = location.pathname, on = /^\/check-in\/arrivals\/\d+\/?$/.test(p), b = document.getElementById(BTN_ID);
      if (on ? !b || !b.isConnected || !document.getElementById(BOX_ID) : !!b || (p !== '/check-in' && document.getElementById(PANEL_ID))) tick();
    });
    // Finished check-ins: their notes are removed (only labels this browser knows, and only once one has a work order).
    AE.every(60000, () => { if (Object.values(keys()).some((k) => k.woId) && !(AE.health && AE.health.down && AE.health.down())) sweep(); }, { background: true });

    AE.checkinDrafts = { open, intake, CODE_RE, labelFor, isMobility, seal, unseal, tokenOf, newSecret, fill, sweep, keys };
  },
});
