/*
  Decipher — identify a device from its IMEI.

  The first 8 digits of an IMEI are its TAC: they say which model it is. Portal can't answer that, so Aethernet learns it:
    · Known TAC: the model, how many work orders at how many stores say so, the colors stores recorded for it (most common
      first), and, for Apple only, the serial and Find My status from Portal (GET /api/workorder/check-fmip-status; any error just
      leaves those rows out). Buttons: Copy model, and on check-in's Device step Use this device.
    · Unknown TAC: "no store has seen this model yet". The tech picks it from Portal's own device list (GET /api/device-models) and
      Save model records TAC → model for every store. When the Osmocom TAC database (a one-time import in the Worker, its own table)
      has a guess, it shows first with "That's it", which finds it in Portal's list for the tech to confirm. An i button (only then)
      carries the attribution.
    · Typo: the check digit (Luhn) fails; no lookup.
  Learning: a work order page Aethernet sees (/api/workorder/<id>: CustomerDevice's 15-digit IMEI + catalog model + color) records
  its TAC → model once (the WO numbers sent are remembered here, ae_tac_seen). The most common model per TAC wins, which outvotes a
  wrong pick. The Worker (/v1/:store/tac) only ever gets the 8-digit TAC and the model: never an IMEI, serial or customer.
  Opens from the avatar menu, a Decipher button beside the IMEI box on check-in's Device step, and Master's Mend's scan to open
  (a scanned 15-digit number that passes the check digit; not on check-in itself, where a scan is data entry).
  No lost status (Garrett, Oct 16, 2026).
*/
AE.decipher = (() => {
  const digitsOf = (s) => String(s || '').replace(/\D/g, '');
  // IMEI check digit (Luhn).
  function luhn(s) {
    let sum = 0;
    for (let i = 0; i < s.length; i++) { let n = Number(s[s.length - 1 - i]); if (i % 2) { n *= 2; if (n > 9) n -= 9; } sum += n; }
    return sum % 10 === 0;
  }
  const valid = (s) => /^\d{15}$/.test(s) && luhn(s);
  // "356841 92 047713 6": the TAC's two parts, the serial part, the check digit.
  const fmt = (d) => [d.slice(0, 6), d.slice(6, 8), d.slice(8, 14), d.slice(14)].filter(Boolean).join(' ');
  // Placeholder IMEIs (33333333…, 12345678…) aren't a model's TAC.
  const placeholder = (tac) => /^(\d)\1{7}$/.test(tac) || tac === '12345678';
  const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9+]+/g, ' ').trim();

  // ------------------------------------------------------------ data
  // The Worker's TAC table; in the sandbox, the sandbox's own stand-in (nothing leaves the machine).
  const tacCall = (method, path, body) => (AE_SANDBOX ? AE.api(method, '/api/sandbox-tac' + path, body) : AE.waymark.call(method, '/tac' + path, body));
  const cache = new Map();
  async function lookup(tac) {
    if (!cache.has(tac)) cache.set(tac, tacCall('GET', '/' + tac).catch((e) => { cache.delete(tac); throw e; }));
    return cache.get(tac);
  }
  const record = async (items) => { const j = await tacCall('POST', '', { items }); items.forEach((i) => cache.delete(i.tac)); return j; };

  // Apple's serial and Find My, from Portal; null on any error (those rows are just left out).
  async function appleInfo(imei) {
    try {
      const j = await AE.api('GET', '/api/workorder/check-fmip-status?imei=' + imei);
      const d = j && j.fmipLockStatusServicesResponse && j.fmipLockStatusServicesResponse.fmipLockStatusDevice;
      return d && (d.serial || typeof d.isLocked === 'boolean') ? { serial: d.serial ? String(d.serial) : '', locked: d.isLocked === true } : null;
    } catch (_) { return null; }
  }
  // Portal's own device list: [{ id, name }].
  async function searchModels(text) {
    const j = await AE.api('GET', '/api/device-models?applyStoreFilter=true&searchTerm=' + encodeURIComponent(text));
    const list = Array.isArray(j) ? j : (j && (j.data || j.deviceModels)) || [];
    return list.filter((x) => x && x.id != null && x.name).map((x) => ({ id: Number(x.id), name: String(x.name) }));
  }
  // A model's details (manufacturer, colors): { manufacturer, colors } or nulls.
  async function modelDetails(id) {
    try {
      const j = await AE.api('GET', '/api/device-models/' + id + '?selectedOptions=');
      const color = ((j && j.options) || []).find((o) => o.name === 'Color');
      return { manufacturer: clean(j && j.DeviceManufacturer && j.DeviceManufacturer.name, 60), colors: (color && color.deviceCatalogOptions) || [] };
    } catch (_) { return { manufacturer: '', colors: [] }; }
  }

  // ------------------------------------------------------------ learning from work orders
  const SEEN_KEY = 'ae_tac_seen', SEEN_MAX = 4000;
  const seenWos = () => new Set(GM_getValue(SEEN_KEY, []));
  // What a work order says about its device: { tac, deviceModelId, modelName, manufacturer, color } or null.
  function fromWo(wo) {
    const cd = wo && wo.CustomerDevice;
    const imei = String((cd && cd.imei) || '').trim();
    if (!valid(imei) || placeholder(imei.slice(0, 8))) return null;
    const dc = cd.DeviceCatalog || {}, dm = dc.DeviceModel || {};
    const id = Number(dc.deviceModelId), name = clean(dm.modelNumber, 120);
    if (!Number.isInteger(id) || id < 1 || !name || /^other device/i.test(name)) return null;
    const full = clean(dc.name, 160); // "iPhone 16 Pro Desert Titanium": the model, then the color
    return { tac: imei.slice(0, 8), deviceModelId: id, modelName: name, manufacturer: clean(dm.DeviceManufacturer && dm.DeviceManufacturer.name, 60),
      color: full.startsWith(name) ? clean(full.slice(name.length), 60) : '' };
  }
  const tried = new Set();
  async function learn(woId) {
    if (tried.has(woId) || seenWos().has(woId)) return;
    tried.add(woId);
    const j = await AE.api('GET', '/api/workorder/' + woId);
    const item = fromWo((j && j.workorder) || AE.unwrap(j));
    if (!item) return;
    await record([item]);
    const seen = [...seenWos(), woId].slice(-SEEN_MAX);
    GM_setValue(SEEN_KEY, seen);
  }

  return { valid, luhn, fmt, digitsOf, placeholder, norm, clean, lookup, record, appleInfo, searchModels, modelDetails, fromWo, learn, open: null };
})();

AE.crystal({
  id: 'decipher',
  name: 'Decipher',
  sites: ['portal.ubreakifix.net'],
  run() {
    const { h } = AE, D = AE.decipher;
    const DLG = 'ae-decipher', BTN = 'ae-decipher-btn', MENU = 'option-aethernet-decipher';
    const icon = (size) => h('span', { html: AE.actionIcon('decipher', size), style: 'line-height:0;flex:none' });
    document.head.append(h('style', null, `
      #${DLG} .sg-about.dc { width:min(600px, 100%); padding:22px 26px 16px; max-height:calc(100vh - 32px); overflow:auto; position:relative; }
      #${DLG} .hd { display:flex; align-items:center; gap:10px; margin-bottom:2px; }
      #${DLG} .hd h2 { margin:0; font-size:22px; font-weight:700; }
      #${DLG} .hd .sg-x { margin-left:auto; }
      #${DLG} .hd .info { margin-left:auto; width:24px; height:24px; padding:0; border-radius:50%; border:1px solid var(--aui-on-surface-soft, #5d5e61); background:none; cursor:pointer;
        color:var(--aui-on-surface-soft, #5d5e61); font:italic 700 13px Georgia, serif; line-height:1; }
      #${DLG} .hd .info:not([hidden]) + .sg-x { margin-left:0; }
      #${DLG} .hd [hidden] { display:none; }
      #${DLG} .pop { position:absolute; right:22px; top:62px; z-index:2; width:260px; padding:10px 12px; font-size:12.5px; line-height:1.4; }
      #${DLG} .pop a { color:var(--aui-primary, #8223d2); font-weight:700; }
      #${DLG} label.f { display:block; font-size:12.5px; font-weight:700; margin:14px 0 4px; color:var(--aui-on-surface-soft, #444); }
      #${DLG} .in { display:flex; gap:8px; align-items:center; }
      #${DLG} input.t { flex:1; min-width:0; height:40px; border:1px solid var(--aui-outline, #c6c6ca); border-radius:8px; padding:0 12px; font:inherit; font-size:16px; letter-spacing:.06em;
        background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e); }
      #${DLG} input.t.plain { font-size:14px; letter-spacing:0; }
      #${DLG} input.t.bad { border-color:var(--aui-status-error, #c62828); background:var(--aui-status-error-soft, #fff6f6); }
      #${DLG} .chk { font-size:12.5px; margin-top:5px; min-height:16px; color:var(--aui-status-success, #1d7a3a); }
      #${DLG} .chk.bad { color:var(--aui-status-error, #c62828); }
      #${DLG} .chk.soft { color:var(--aui-on-surface-soft, #5d5e61); }
      #${DLG} .res { margin-top:16px; border:1px solid var(--aui-outline, #d9d9de); border-radius:12px; padding:14px 16px; }
      #${DLG} .res .mk { font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; color:var(--aui-on-surface-soft, #666); }
      #${DLG} .res .md { font-size:24px; font-weight:800; margin:2px 0 4px; }
      #${DLG} .res .src { font-size:12.5px; color:var(--aui-on-surface-soft, #666); }
      #${DLG} .rows { display:grid; grid-template-columns:120px 1fr; gap:8px 12px; margin-top:12px; padding-top:12px; border-top:1px solid var(--aui-outline-variant, #eee); font-size:14px; align-items:center; }
      #${DLG} .rows .k { color:var(--aui-on-surface-soft, #666); font-size:13px; }
      #${DLG} .tag { display:inline-block; font-size:12px; font-weight:700; padding:3px 9px; border-radius:999px; }
      #${DLG} .tag.ok { background:var(--aui-status-success-soft, #e3f4e8); color:var(--aui-status-on-success-soft, #1d7a3a); }
      #${DLG} .tag.warn { background:var(--aui-status-warning-soft, #fdf0dc); color:var(--aui-status-on-warning-soft, #9a5b00); }
      #${DLG} .mono { font-family:ui-monospace, Menlo, monospace; font-size:13.5px; }
      #${DLG} .cp { font:inherit; font-size:12px; font-weight:700; margin-left:8px; padding:0; border:0; background:none; cursor:pointer; color:var(--aui-primary, #8223d2); }
      #${DLG} .chips { display:flex; flex-wrap:wrap; gap:6px; }
      #${DLG} .chip { font:inherit; font-size:12.5px; border:1px solid var(--aui-outline, #d9d9de); border-radius:999px; padding:3px 10px; cursor:pointer; background:none; color:inherit; }
      #${DLG} .chip.on { border:2px solid var(--aui-primary, #8223d2); padding:2px 9px; color:var(--aui-primary, #8223d2); font-weight:700; background:var(--aui-primary-soft, #faf5ff); }
      #${DLG} .note { font-size:12.5px; color:var(--aui-on-surface-soft, #777); margin-top:10px; }
      #${DLG} .unk { margin-top:16px; border-radius:12px; padding:12px 14px; font-size:14px; background:var(--aui-status-warning-soft, #fdf6e7); color:var(--aui-status-on-warning-soft, #3d2e00); border:1px solid #f0d9a8; }
      #${DLG} .unk b { font-size:15px; }
      #${DLG} .unk .s { font-size:13px; opacity:.8; margin-top:2px; }
      #${DLG} .sug { margin-top:10px; display:flex; align-items:center; gap:10px; border:1px solid var(--aui-outline, #d9d9de); border-radius:10px; padding:10px 12px; background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e); }
      #${DLG} .sug .t { flex:1; }
      #${DLG} .sug .t .s { font-size:12px; opacity:.7; margin:0; }
      #${DLG} .list { margin-top:6px; border:1px solid var(--aui-outline, #d9d9de); border-radius:10px; overflow:hidden; }
      #${DLG} .list button { display:flex; gap:10px; align-items:center; width:100%; text-align:left; font:inherit; font-size:14px; padding:9px 12px; border:0; border-top:1px solid var(--aui-outline-variant, #eee);
        background:none; color:inherit; cursor:pointer; }
      #${DLG} .list button:first-child { border-top:0; }
      #${DLG} .list button.on { background:var(--aui-primary-soft, #faf5ff); font-weight:700; color:var(--aui-primary, #8223d2); }
      #${DLG} .list .r { width:14px; height:14px; border-radius:50%; border:1.5px solid #999; flex:none; }
      #${DLG} .list .on .r { border:4px solid var(--aui-primary, #8223d2); }
      #${DLG} .list .none { padding:9px 12px; font-size:13px; color:var(--aui-on-surface-soft, #777); }
      #${DLG} .foot { display:flex; gap:10px; align-items:center; margin-top:16px; border-top:1px solid var(--aui-outline-variant, #eee); padding-top:12px; }
      #${DLG} .foot .sp { flex:1; font-size:12px; opacity:.75; }
      #${BTN} { position:fixed; z-index:1000; display:inline-flex; align-items:center; gap:6px; height:32px; padding:0 12px 0 4px; border-radius:999px; cursor:pointer;
        border:1px solid var(--aui-on-surface, #1a1c1e); background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e); font:500 13px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; }
      #${BTN}:hover { background:var(--aui-neutral-soft, #f1f0f4); }
    `));

    const slice = (key) => { const r = AE.portal('select', { slice: 'checkInSlice', key }); return r && r.found ? r.value : undefined; };
    const onDeviceStep = () => location.pathname === '/check-in' && slice('formStep') === 1;
    const report = (what, e) => ({ html: ' If you keep seeing this, ' + AE.bugLink('report a bug', { where: 'Decipher', error: what + ': ' + ((e && e.message) || e) }) + '!' });
    const copy = async (text, what) => {
      try { await navigator.clipboard.writeText(text); AE.toast('Copied ' + what, text, 'ok', 4000); }
      catch (e) { AE.toast("Couldn't copy", e.message || String(e), 'err'); }
    };
    const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

    // ------------------------------------------------------------ the dialog
    function open(prefill = {}) {
      AE.ensureModalCss();
      document.getElementById(DLG)?.remove();
      AE.track('decipher:open' + (prefill.from ? ':' + prefill.from : ''));
      // st.state: 'idle' (not 15 digits yet) | 'typo' | 'loading' | 'known' | 'unknown' | 'error'
      const st = { digits: '', tac: '', state: 'idle', data: null, color: '', apple: null, query: '', results: [], pick: null, searching: false, suggestion: null, popup: false, busy: false, run: 0 };

      const input = h('input', { type: 'text', class: 't', inputmode: 'numeric', autocomplete: 'off', placeholder: '15 digits', 'aria-label': 'IMEI',
        oninput: () => { setDigits(input.value); }, onpaste: () => setTimeout(() => setDigits(input.value)) });
      const chk = h('div', { class: 'chk' }), body = h('div'), foot = h('div', { class: 'foot' });
      const infoBtn = h('button', { class: 'info', title: 'Where this suggestion comes from', 'aria-label': 'About this suggestion', onclick: (e) => { e.stopPropagation(); st.popup = !st.popup; drawPop(); } }, 'i');
      const pop = h('div', { class: 'sg sg-card pop', role: 'note' },
        'Suggestion from the Osmocom TAC database, CC BY-SA 3.0, © Harald Welte and contributors. ', h('a', { href: 'https://tacdb.osmocom.org/', target: '_blank', rel: 'noopener noreferrer' }, 'tacdb.osmocom.org'));
      pop.hidden = true; infoBtn.hidden = true;
      const hd = h('div', { class: 'hd' }, icon(32), h('h2', null, 'Decipher'), infoBtn, h('button', { class: 'sg-x', title: 'Close', onclick: () => close() }, '✕'));
      const card = h('div', { class: 'sg sg-card sg-about dc', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Decipher', onclick: () => { if (st.popup) { st.popup = false; drawPop(); } } },
        hd, pop, h('div', { class: 'sg-soft' }, 'Identify a device from its IMEI. Type it or scan it.'),
        h('label', { class: 'f' }, 'IMEI'),
        h('div', { class: 'in' }, input, h('button', { type: 'button', class: 'sg-btn', onclick: () => { input.value = ''; setDigits(''); input.focus(); chk.className = 'chk soft'; chk.textContent = 'Ready: scan the barcode now.'; } }, 'Scan')),
        chk, body, foot);
      const scrim = h('div', { class: 'sg sg-about-scrim', id: DLG, onclick: (e) => { if (e.target === scrim) close(); } }, card);
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); if (st.popup) { st.popup = false; drawPop(); } else close(); } };
      function close() { st.run++; scrim.remove(); document.removeEventListener('keydown', onKey, true); }
      document.addEventListener('keydown', onKey, true);
      document.body.append(scrim);

      const drawPop = () => { pop.hidden = !st.popup || !st.suggestion; };
      const btn = (label, onclick, cls, disabled) => h('button', { type: 'button', class: 'sg-btn' + (cls ? ' ' + cls : ''), onclick, disabled: !!disabled }, label);

      // What the IMEI box holds → what to do about it.
      function setDigits(raw) {
        const d = D.digitsOf(raw).slice(0, 15);
        const shown = D.fmt(d);
        if (input.value !== shown) input.value = shown;
        if (d === st.digits && st.state !== 'idle') return;
        st.digits = d; st.run++;
        Object.assign(st, { data: null, apple: null, color: '', pick: null, results: [], query: '', suggestion: null, popup: false });
        if (d.length < 15) { st.state = 'idle'; st.tac = ''; }
        else if (!D.valid(d)) { st.state = 'typo'; st.tac = ''; }
        else { st.state = 'loading'; st.tac = d.slice(0, 8); find(st.run); }
        draw();
      }

      async function find(run) {
        try {
          const data = await D.lookup(st.tac);
          if (run !== st.run) return;
          st.data = data;
          if (data.known) {
            st.state = 'known';
            st.color = (data.colors[0] && data.colors[0].color) || '';
            const apple = /^apple$/i.test(data.models[0].manufacturer || '');
            if (apple) D.appleInfo(st.digits).then((a) => { if (run === st.run) { st.apple = a; draw(); } });
          } else {
            st.state = 'unknown'; st.suggestion = data.suggestion && data.suggestion.model ? data.suggestion : null;
          }
        } catch (e) {
          if (run !== st.run) return;
          st.state = 'error'; st.error = e;
        }
        draw();
      }

      function draw() {
        input.classList.toggle('bad', st.state === 'typo');
        chk.className = 'chk' + (st.state === 'typo' ? ' bad' : st.state === 'idle' ? ' soft' : '');
        chk.textContent = st.state === 'typo' ? '✕ This IMEI has a typo. Check the digits and try again.' : st.state === 'idle' ? (st.digits ? st.digits.length + ' of 15 digits' : '') : '✓ Valid IMEI';
        infoBtn.hidden = !(st.state === 'unknown' && st.suggestion);
        drawPop();
        if (st.state === 'known') return drawKnown();
        if (st.state === 'unknown') return drawUnknown();
        const note = st.state === 'loading' ? h('div', { class: 'note' }, 'Looking it up…')
          : st.state === 'error' ? h('div', { class: 'note' }, "Couldn't look this up.", ...[report('Looking up TAC ' + st.tac, st.error).html].map((x) => h('span', { html: x })))
          : null;
        body.replaceChildren(...(note ? [note] : []));
        foot.replaceChildren(h('span', { class: 'sp' }), btn('Look up', () => { st.run++; st.state = 'loading'; draw(); D.lookup(st.tac).catch(() => {}); find(st.run); }, '', st.state !== 'error'));
      }

      // -------------------------------------------------------- known TAC
      function modelText() { const m = st.data.models[0]; return m.modelName + (st.color ? ' ' + st.color : ''); }
      function drawKnown() {
        const d = st.data, m = d.models[0], apple = /^apple$/i.test(m.manufacturer || '');
        const rows = [];
        if (d.colors.length) rows.push(h('span', { class: 'k' }, 'Color'), h('span', { class: 'chips' }, d.colors.map((c) =>
          h('button', { type: 'button', class: 'chip' + (st.color === c.color ? ' on' : ''), onclick: () => { st.color = c.color; drawKnown(); } }, c.color))));
        if (apple && st.apple && st.apple.serial) rows.push(h('span', { class: 'k' }, 'Serial'),
          h('span', null, h('span', { class: 'mono' }, st.apple.serial), h('button', { type: 'button', class: 'cp', onclick: () => copy(st.apple.serial, 'serial') }, 'Copy')));
        if (apple && st.apple) rows.push(h('span', { class: 'k' }, 'Find My'), h('span', null, h('span', { class: 'tag ' + (st.apple.locked ? 'warn' : 'ok') }, st.apple.locked ? 'On' : 'Off')));
        body.replaceChildren(
          h('div', { class: 'res' }, h('div', { class: 'mk' }, m.manufacturer || ' '), h('div', { class: 'md' }, m.modelName),
            h('div', { class: 'src' }, 'Seen on ' + plural(d.workOrders, 'work order') + ' at ' + plural(d.stores, 'store')),
            rows.length ? h('div', { class: 'rows' }, rows) : null),
          h('div', { class: 'note' }, apple ? (d.colors.length ? "The IMEI doesn't say the color. Pick it from the colors stores have seen for this model." : '')
            : 'Serial and Find My are only available for Apple devices.'));
        const use = onDeviceStep() ? btn('Use this device', () => useDevice(), 'sg-primary', st.busy) : null;
        foot.replaceChildren(h('span', { class: 'sp' }, apple ? 'Serial and Find My from Portal' : ''),
          ...[btn('Copy model', () => { AE.track('decipher:copy'); copy(modelText(), 'model'); }, use ? '' : 'sg-primary'), use].filter(Boolean));
      }

      async function useDevice() {
        st.busy = true; drawKnown();
        try {
          const m = st.data.models[0];
          const how = await fillCheckin({ id: m.deviceModelId, name: m.modelName, color: st.color, imei: st.digits });
          AE.track('decipher:use');
          AE.toast('Decipher', how, 'ok', 6000);
          close();
        } catch (e) {
          st.busy = false; drawKnown();
          AE.toast('Decipher', { html: AE.esc("Couldn't fill in the Device step. Use Copy model instead.") + report('Use this device', e).html }, 'err', 10000);
        }
      }

      // -------------------------------------------------------- unknown TAC
      const search = h('input', { type: 'text', class: 't plain', autocomplete: 'off', placeholder: 'Type the model, e.g. moto g', 'aria-label': 'Model',
        oninput: () => { st.query = search.value; st.pick = null; searchSoon(); drawList(); } });
      const list = h('div', { class: 'list' }), listWrap = h('div');
      let timer = null, searchRun = 0;
      function searchSoon() { clearTimeout(timer); timer = setTimeout(() => runSearch(), 350); }
      // Portal's own list for what's typed (at least 3 characters, as Portal's check-in asks). `wanted`: the suggestion to preselect.
      async function runSearch(wanted) {
        const q = st.query.trim(), my = ++searchRun;
        if (q.length < 3) { st.results = []; st.searching = false; drawList(); return; }
        st.searching = true; drawList();
        try {
          const r = await D.searchModels(q);
          if (my !== searchRun) return;
          st.results = r; st.searching = false;
          // the suggestion's match; typing keeps the pick if it's still listed, else the first (as in the mockup)
          st.pick = wanted ? bestMatch(r, wanted) : (st.pick && r.find((x) => x.id === st.pick.id)) || r[0] || null;
        } catch (e) { if (my !== searchRun) return; st.results = []; st.searching = false; st.searchError = e; }
        drawList();
      }
      // The Portal entry that is the suggestion: same words, else one containing the model, else null.
      function bestMatch(results, s) {
        const model = D.norm(s.model), full = D.norm(s.brand && !D.norm(s.model).startsWith(D.norm(s.brand)) ? s.brand + ' ' + s.model : s.model);
        return results.find((x) => D.norm(x.name) === full) || results.find((x) => D.norm(x.name) === model)
          || results.find((x) => D.norm(x.name).includes(model)) || null;
      }
      function drawList() {
        const q = search.value.trim();
        list.replaceChildren(...(st.searching ? [h('div', { class: 'none' }, 'Searching…')]
          : st.results.length ? st.results.map((x) => h('button', { type: 'button', class: st.pick && st.pick.id === x.id ? 'on' : '', onclick: () => { st.pick = x; drawList(); drawUnknownFoot(); } }, h('span', { class: 'r' }), x.name))
          : [h('div', { class: 'none' }, q.length < 3 ? 'Type at least 3 letters of the model.' : st.searchError ? "Couldn't search Portal's device list." : 'Portal has no model like that.')]));
        drawUnknownFoot();
      }
      function drawUnknownFoot() {
        foot.replaceChildren(h('span', { class: 'sp' }, "Models from Portal's device list"), btn('Save model', () => save(), 'sg-primary', !st.pick || st.busy));
      }
      function drawUnknown() {
        const s = st.suggestion;
        const sugText = s ? (s.brand && !D.norm(s.model).startsWith(D.norm(s.brand)) ? s.brand + ' ' : '') + s.model : '';
        body.replaceChildren(
          h('div', { class: 'unk' }, h('b', null, 'No store has seen this model yet.'), h('div', { class: 's' }, 'Confirm it once and every store gets it from then on.'),
            s ? h('div', { class: 'sug' }, h('div', { class: 't' }, sugText, h('div', { class: 's' }, 'Suggested by a community TAC list')),
              btn("That's it", () => acceptSuggestion(sugText), 'sg-primary')) : null),
          h('label', { class: 'f' }, s ? 'Not it? Pick the model' : 'Pick the model'), h('div', { class: 'in' }, search), listWrap);
        listWrap.replaceChildren(list);
        drawList();
        setTimeout(() => { if (st.state === 'unknown' && !s) search.focus(); });
      }
      async function acceptSuggestion(text) {
        AE.track('decipher:suggestion');
        search.value = text; st.query = text; st.pick = null;
        await runSearch(st.suggestion);
        // Nothing of that name in Portal: the suggestion stays in the box for the tech to adjust.
        if (!st.pick) search.focus();
      }
      async function save() {
        const pick = st.pick;
        st.busy = true; drawUnknownFoot();
        try {
          const info = await D.modelDetails(pick.id);
          await D.record([{ tac: st.tac, deviceModelId: pick.id, modelName: pick.name, manufacturer: info.manufacturer, color: '' }]);
          AE.track('decipher:save');
          AE.toast('Model saved', pick.name + ' for every store.', 'ok', 5000);
          st.busy = false; st.run++; st.state = 'loading'; draw(); find(st.run);
        } catch (e) {
          st.busy = false; drawUnknownFoot();
          AE.toast('Decipher', { html: AE.esc("Couldn't save the model.") + report('Saving TAC ' + st.tac, e).html }, 'err', 10000);
        }
      }

      if (prefill.imei) { input.value = D.fmt(D.digitsOf(prefill.imei).slice(0, 15)); setDigits(input.value); }
      else draw();
      setTimeout(() => input.focus());
    }
    D.open = open;

    // ------------------------------------------------------------ Use this device (check-in's Device step)
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms = 5000) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) return null; await sleep(120); } };
    const modelInput = () => document.querySelector('input[data-testid="deviceSearch-TextInput"]');
    const imeiInput = () => [...document.querySelectorAll('input')].find((i) => /imei/i.test((i.name || '') + (i.id || '') + (i.getAttribute('data-testid') || '')) && i.getClientRects().length);
    // The smallest visible element whose text is exactly `text` (case-insensitive).
    const byText = (text, skip) => [...document.body.querySelectorAll('li, [role="option"], div, span, button')]
      .find((e) => e !== skip && !e.children.length && e.textContent.trim().toLowerCase() === text.toLowerCase() && e.getClientRects().length) || null;
    // Fills the Device step the way a person would: types the model into Portal's search box, clicks the match, then the color.
    async function fillCheckin({ name, color }) {
      if (!onDeviceStep()) throw new Error('not on the Device step');
      const input = await until(modelInput, 3000);
      if (!input) throw new Error('model box not found');
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(input, name); input.dispatchEvent(new Event('input', { bubbles: true }));
      const opt = await until(() => byText(name, input), 6000);
      if (!opt) throw new Error('"' + name + '" not in the Portal list');
      opt.click();
      if (!color) return 'Model filled in: ' + name + '.';
      const lab = await until(() => byText('Color'), 4000);
      if (lab) {
        lab.click();
        const c = await until(() => { const e = byText(color); return e && e !== lab ? e : null; }, 2500);
        if (c) { c.click(); return 'Model and color filled in: ' + name + ' ' + color + '.'; }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }
      return 'Model filled in: ' + name + '. Pick the color (' + color + ') yourself.';
    }

    // The Decipher button on check-in's Device step: beside the IMEI box, or under the model box until that shows up.
    function placeButton() {
      let b = document.getElementById(BTN);
      const step = onDeviceStep();
      const imei = step && imeiInput();
      const anchor = step && (imei || modelInput());
      if (!anchor) { b?.remove(); return; }
      if (!b) {
        b = h('button', { type: 'button', id: BTN, title: 'Decipher: identify a device from its IMEI', onclick: () => { const i = imeiInput(); open({ from: 'checkin', imei: i ? i.value : '' }); } }, icon(24), 'Decipher');
        document.body.append(b);
      }
      const r = anchor.closest('div[class]')?.getBoundingClientRect() || anchor.getBoundingClientRect();
      const want = imei ? [Math.round(r.right + 12), Math.round(r.top + (r.height - 32) / 2)] : [Math.round(r.left), Math.round(r.bottom + 34)];
      if (b.style.left !== want[0] + 'px') b.style.left = want[0] + 'px';
      if (b.style.top !== want[1] + 'px') b.style.top = want[1] + 'px';
    }

    // ------------------------------------------------------------ avatar menu
    function menuItem() {
      const settingsItem = document.querySelector('[data-testid="option-aethernet"]');
      if (!settingsItem || document.querySelector(`[data-testid="${MENU}"]`)) return;
      const item = settingsItem.cloneNode(true);
      item.setAttribute('data-testid', MENU);
      const label = item.querySelector('[data-aui="text"]') || item;
      label.textContent = 'Decipher';
      item.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        open({ from: 'menu' });
      });
      settingsItem.before(item);
    }

    // ------------------------------------------------------------ learning
    const woId = () => { const m = location.pathname.match(/^\/repair\/workorder\/(\d{5,12})(\/|$)/); return m ? m[1] : null; };
    let learning = false;
    async function learnTick() {
      const id = woId();
      if (!id || learning || (!AE_SANDBOX && !AE.waymark.configured())) return;
      learning = true;
      try { await AE.afterLoad(); await D.learn(id); }
      catch (e) { console.debug('[' + AE_NAME + '] Decipher: not learned from WO ' + id + ': ' + ((e && e.message) || e)); }
      finally { learning = false; }
    }

    const tick = () => { menuItem(); placeButton(); learnTick(); };
    AE.onDom(() => { menuItem(); placeButton(); });
    AE.every(1500, tick);
  },
});
