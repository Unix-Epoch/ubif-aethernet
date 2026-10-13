/*
  Reassemble — Price Estimate: an out-of-warranty quote from the part cost, with the franchise owner's
  pricing (his NextGen OOW Price Calculator v3.5.0, rebuilt here), and the Price sheet's own price when
  the repair is on it.

  Pricing (every number set in the admin panel → Settings → Reassemble; DEFAULTS are the owner's):
    · Everything but MacBooks: Portal's legacy formula. Easy = low × part + low base, Hard = high × part
      + high base, Medium = halfway; rounded up to .99. Screen at risk (the screen's part cost, for a repair
      that could break it) raises Easy to break even after the royalty.
    · MacBook: Easy = (part + minimum profit) ÷ (1 − royalty), rounded up to .99; minimum profit $150
      (2023 and older) or $250 (2024 and newer) + 25% of the part cost above $500. Medium/Hard = Easy +
      $25/$50. Screen repairs: one price (Easy) + an optional extra, kept at .99.
  Profit (price × (1 − royalty) − part) shows only to the admin panel's profit list (the owner's managers
  and Garrett, Oct 13, 2026), matched on the Portal user's name or email.
  Opens from the avatar menu ("Price estimate") and a Price Estimate button at the bottom left of the
  Estimates page (/price-check) and of check-in's Repair estimate step (above Back). (A Dashboard tile was
  dropped, Garrett, Oct 13, 2026: "it doesn't need to exist".) Copy only: nothing is added to a cart.
*/
AE.reassemble = (() => {
  const DEFAULTS = {
    bases: { phone: [70, 122.5], tablet: [70, 105], computer: [87.5, 122.5], console: [94.5, 129.5], other: [70, 280] },
    multipliers: { low: 1.7, high: 2 },
    macMin: 150, macMin2024: 250, scale: { threshold: 500, rate: 0.25 }, macAddons: { medium: 25, hard: 50 }, royalty: 0.08,
    profitViewers: ['Bret Bauer', 'Justin Wilson', 'Chance Boyd', 'Jon Cavaliere', 'Garrett Green'],
  };
  const DEVICES = [['phone', 'Phone'], ['tablet', 'Tablet'], ['mac', 'MacBook'], ['laptop', 'Laptop / PC (non-Mac)'], ['console', 'Game console'], ['wearable', 'Wearable / watch'], ['other', 'Other']];
  const BASE = { phone: 'phone', wearable: 'phone', tablet: 'tablet', laptop: 'computer', mac: 'computer', console: 'console', other: 'other' };
  const REPAIRS = ['Screen', 'Battery', 'Charge port', 'Back glass', 'Other'];
  const LEVELS = ['easy', 'medium', 'hard'];

  // The admin panel's numbers over the defaults (anything missing or broken falls back).
  function settings() {
    const c = (AE.config().reassemble) || {}, ok = (v) => typeof v === 'number' && isFinite(v) && v >= 0;
    const s = JSON.parse(JSON.stringify(DEFAULTS));
    for (const g in s.bases) { const p = (c.bases || {})[g]; if (p && ok(p[0]) && ok(p[1])) s.bases[g] = [p[0], p[1]]; }
    for (const k of ['low', 'high']) if (ok((c.multipliers || {})[k])) s.multipliers[k] = c.multipliers[k];
    for (const k of ['medium', 'hard']) if (ok((c.macAddons || {})[k])) s.macAddons[k] = c.macAddons[k];
    for (const k of ['macMin', 'macMin2024']) if (ok(c[k])) s[k] = c[k];
    if (ok(c.royalty) && c.royalty < 0.5) s.royalty = c.royalty;
    if (c.scale && ok(c.scale.threshold) && ok(c.scale.rate)) s.scale = { threshold: c.scale.threshold, rate: c.scale.rate };
    if (Array.isArray(c.profitViewers)) s.profitViewers = c.profitViewers.filter((x) => typeof x === 'string' && x.trim());
    return s;
  }

  const r2 = (x) => Math.round(x * 100) / 100;
  // Up to the next .99 (199.99 stays; 200.00 → 200.99), in whole cents so float noise can't tip it.
  function up99(p) { const c = Math.ceil(Math.round(p * 1000) / 10); return (Math.ceil((c + 1) / 100) * 100 - 1) / 100; }

  // { device, part, risk, newer (2024 and newer MacBook), repair, extra } → { easy, medium, hard, single? }:
  // each { price, profit }. MacBook screens get one price (single) with the extra on top.
  function quote(o, s = settings()) {
    const part = Math.max(0, Number(o.part) || 0), risk = Math.max(0, Number(o.risk) || 0), keep = 1 - s.royalty;
    const out = {}, profit = (price) => r2(price * keep - part);
    if (o.device !== 'mac') {
      const [baseLo, baseHi] = s.bases[BASE[o.device] || 'other'];
      const lo = s.multipliers.low * part + baseLo, hi = s.multipliers.high * part + baseHi;
      const floor = risk > 0 ? up99((part + risk) / keep) : 0; // screen at risk: Easy only
      for (const [lvl, raw] of [['easy', lo], ['medium', (lo + hi) / 2], ['hard', hi]]) {
        const price = Math.max(up99(raw), lvl === 'easy' ? floor : 0);
        out[lvl] = { price, profit: profit(price) };
      }
      return out;
    }
    const min = (o.newer ? s.macMin2024 : s.macMin) + s.scale.rate * Math.max(0, part - s.scale.threshold);
    const easy = up99(Math.max((part + min) / keep, (part + risk) / keep));
    out.easy = { price: easy, profit: profit(easy) };
    out.medium = { price: r2(easy + s.macAddons.medium), profit: profit(r2(easy + s.macAddons.medium)) };
    out.hard = { price: r2(easy + s.macAddons.hard), profit: profit(r2(easy + s.macAddons.hard)) };
    out.minProfit = r2(min);
    if (o.repair === 'Screen') {
      const extra = Math.max(0, Number(o.extra) || 0), price = extra > 0 ? up99(easy + extra) : easy;
      out.single = { price, profit: profit(price), base: easy, extra };
    }
    return out;
  }

  const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
  async function canSeeProfit() {
    const p = await AE.profile().catch(() => null);
    if (!p) return false;
    const who = [norm(p.name), norm(p.email)];
    return settings().profitViewers.some((v) => v && who.includes(norm(v)));
  }
  // A device type from a model name (check-in prefill).
  function typeOf(name) {
    const n = norm(name);
    if (/macbook/.test(n)) return 'mac';
    if (/ipad|tab\b|galaxy tab|tablet|surface pro|kindle/.test(n)) return 'tablet';
    if (/watch|fitbit|airpods/.test(n)) return 'wearable';
    if (/xbox|playstation|ps[345]\b|switch|steam deck|quest/.test(n)) return 'console';
    if (/laptop|notebook|chromebook|thinkpad|dell|hp |lenovo|asus|acer|surface/.test(n)) return 'laptop';
    if (/iphone|galaxy|pixel|phone|moto|oneplus/.test(n)) return 'phone';
    return null;
  }
  return { DEFAULTS, DEVICES, REPAIRS, LEVELS, settings, quote, up99, canSeeProfit, typeOf };
})();

AE.crystal({
  id: 'reassemble',
  name: 'Reassemble',
  sites: ['portal.ubreakifix.net'],
  run() {
    const { h } = AE, R = AE.reassemble;
    const DLG = 'ae-reassemble', BTN = 'ae-ra-btn', MENU = 'option-aethernet-reassemble';
    const HINTS = { easy: 'Plug-and-play or screws-out', medium: 'Glued battery or trackpad risk, extra disassembly', hard: 'Top case or keyboard, full transfer of components, high risk' };
    const LABEL = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };
    const icon = (size) => h('span', { html: AE.actionIcon('reassemble', size), style: 'line-height:0;flex:none' });
    document.head.append(h('style', null, `
      #${DLG} .sg-about.ra { width:min(640px, 100%); padding:22px 26px 16px; }
      #${DLG} .hd { display:flex; align-items:center; gap:10px; margin-bottom:2px; }
      #${DLG} .hd h2 { margin:0; font-size:22px; font-weight:700; }
      #${DLG} .hd .sg-x { margin-left:auto; }
      #${DLG} .grid { display:grid; grid-template-columns:1fr 1fr; gap:10px 14px; margin-top:14px; }
      #${DLG} label.f { display:block; font-size:12.5px; font-weight:700; margin-bottom:4px; color:var(--aui-on-surface-soft, #444); }
      #${DLG} label.f .opt { font-weight:400; opacity:.75; }
      #${DLG} select, #${DLG} input { width:100%; height:38px; border:1px solid var(--aui-outline, #c6c6ca); border-radius:8px; padding:0 10px; font:inherit; font-size:14px;
        background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e); }
      #${DLG} .sheet { margin-top:16px; border-radius:10px; padding:12px 14px; background:var(--aui-status-success-soft, #eaf6ee); color:var(--aui-status-on-success-soft, #062011); font-size:14px; }
      #${DLG} .sheet.miss { background:var(--aui-warning-soft, #fff4cc); color:var(--aui-on-warning-soft, #3d2e00); }
      #${DLG} .sheet .s { font-size:12.5px; opacity:.8; margin-top:2px; }
      #${DLG} .chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
      #${DLG} .chip { font:inherit; font-size:14px; padding:4px 12px; border-radius:999px; cursor:pointer; border:1px solid currentColor; background:transparent; color:inherit; }
      #${DLG} .chip.on { background:var(--aui-primary, #8223d2); border-color:var(--aui-primary, #8223d2); color:var(--aui-on-primary, #fff); }
      #${DLG} .chip small { display:block; font-size:11px; opacity:.85; }
      #${DLG} .tiles { display:grid; grid-template-columns:repeat(3, 1fr); gap:10px; margin-top:14px; }
      #${DLG} .tiles.one { grid-template-columns:1fr; }
      #${DLG} .tile { display:flex; flex-direction:column; justify-content:flex-start; align-items:flex-start; text-align:left; font:inherit; border:1px solid var(--aui-outline, #d9d9de); border-radius:10px; padding:10px 12px; cursor:pointer;
        background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e); }
      #${DLG} .tile.on { border:2px solid var(--aui-primary, #8223d2); background:var(--aui-primary-soft, #faf5ff); padding:9px 11px; }
      #${DLG} .tile .l { font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; opacity:.7; }
      #${DLG} .tile .p { font-size:24px; font-weight:800; margin:2px 0; }
      #${DLG} .tile.on .p { color:var(--aui-primary, #8223d2); }
      #${DLG} .tiles.muted .tile .p { opacity:.5; }
      #${DLG} .tile .h { font-size:12px; opacity:.7; line-height:1.35; }
      #${DLG} .pf { font-size:12px; font-weight:600; margin-top:4px; color:var(--aui-status-success, #1d7a3a); }
      #${DLG} .extra { display:flex; align-items:center; gap:8px; margin-top:12px; font-size:13.5px; }
      #${DLG} .extra input { width:110px; }
      #${DLG} .foot { display:flex; gap:10px; align-items:center; margin-top:16px; border-top:1px solid var(--aui-outline-variant, #eee); padding-top:12px; }
      #${DLG} .foot .sp { flex:1; font-size:12px; opacity:.75; }
      #${DLG} .note { font-size:12px; opacity:.75; margin-top:8px; }
      #${BTN} { position:fixed; z-index:1000; /* over Portal's sticky footer (999), under its dialogs */ display:inline-flex; align-items:center; gap:8px; height:40px; padding:0 16px 0 6px; border-radius:999px; cursor:pointer;
        border:1px solid var(--aui-on-surface, #1a1c1e); background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1a1c1e); font:500 15px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif;
        box-shadow:0 2px 8px #0002; }
      #${BTN}:hover { background:var(--aui-neutral-soft, #f1f0f4); }
    `));

    // ------------------------------------------------------------ the dialog
    const money = (n) => '$' + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const amount = (v) => { const n = parseFloat(String(v || '').replace(/[$,\s]/g, '')); return isFinite(n) && n >= 0 ? n : null; };
    let sheetData = null;

    async function open(prefill = {}) {
      AE.ensureModalCss(); // the pop-over styles live with Settings' dialogs
      document.getElementById(DLG)?.remove();
      AE.track('reassemble:open' + (prefill.from ? ':' + prefill.from : ''));
      const st = { device: prefill.device || 'phone', model: prefill.model || '', newer: false, repair: 'Screen', part: '', risk: '', extra: '', extraOn: false, pick: null };
      const showProfit = await R.canSeeProfit();
      AE.priceSheet.get().then((v) => { sheetData = v && v.data ? v : null; draw(); }).catch(() => {});

      const field = (label, el, opt) => h('div', null, h('label', { class: 'f' }, label, opt ? h('span', { class: 'opt' }, ' (optional)') : null), el);
      const sel = (opts, val, set) => { const s = h('select', { onchange: (e) => { set(e.target.value); st.pick = null; draw(); } }, opts.map(([v, l]) => { const o = h('option', { value: v }, l); o.selected = v === val; return o; })); return s; };
      const inp = (key, ph) => h('input', { type: 'text', inputmode: key === 'model' ? 'text' : 'decimal', autocomplete: 'off', placeholder: ph || '', value: st[key],
        oninput: (e) => { st[key] = e.target.value; st.pick = null; drawResult(); } });

      const fields = h('div', { class: 'grid' }), result = h('div'), copyBtn = h('button', { type: 'button', class: 'sg-btn sg-primary', disabled: true }, 'Copy');
      const footNote = h('span', { class: 'sp' });
      const card = h('div', { class: 'sg sg-card sg-about ra', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Price Estimate' },
        h('div', { class: 'hd' }, icon(32), h('h2', null, 'Price Estimate'), h('button', { class: 'sg-x', title: 'Close', onclick: () => close() }, '✕')),
        h('div', { class: 'sg-soft' }, 'Out-of-warranty quote from the part cost. If the Price sheet has the repair, quote the sheet.'),
        fields, result, h('div', { class: 'foot' }, footNote, copyBtn));
      const scrim = h('div', { class: 'sg sg-about-scrim', id: DLG, onclick: (e) => { if (e.target === scrim) close(); } }, card);
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
      function close() { scrim.remove(); document.removeEventListener('keydown', onKey, true); }
      document.addEventListener('keydown', onKey, true);
      document.body.append(scrim);

      function draw() {
        const mac = st.device === 'mac';
        fields.replaceChildren(
          field('Device type', sel(R.DEVICES, st.device, (v) => { st.device = v; })),
          mac ? field('Model year', sel([['old', '2023 and older'], ['new', '2024 and newer']], st.newer ? 'new' : 'old', (v) => { st.newer = v === 'new'; }))
            : field('Model', inp('model', 'e.g. iPhone 13'), true),
          field('Repair', sel(R.REPAIRS.map((x) => [x, x]), st.repair, (v) => { st.repair = v; })),
          field('Part cost (incl. shipping)', inp('part', '$0.00')),
          ...(st.repair !== 'Screen' ? [field('Screen at risk', inp('risk', "The screen's part cost"), true)] : []));
        drawResult();
      }

      function drawResult() {
        const mac = st.device === 'mac', part = amount(st.part);
        const s = R.settings(), q = part == null ? null : R.quote({ device: st.device, part, risk: amount(st.risk), newer: st.newer, repair: st.repair, extra: st.extraOn ? amount(st.extra) : 0 }, s);
        const keep = 1 - s.royalty, pf = (price) => showProfit && part != null ? h('div', { class: 'pf' }, 'Profit ' + money(r2(price * keep - part))) : null;
        const sheet = !mac && st.model.trim() && sheetData ? AE.priceSheet.repairPrices(st.model, st.repair, sheetData.data) : null;
        const parts = [];
        let pickPrice = null;
        // The Price sheet first: its price is the one to quote.
        if (sheet && sheet.prices.length) {
          if (!st.pick || st.pick.kind !== 'sheet') st.pick = { kind: 'sheet', i: 0 };
          const r0 = sheet.prices[0];
          parts.push(h('div', { class: 'sheet' }, '✓ On the Price sheet: ' + (sheet.rows[0].name.split(/\s{3,}|inform customer/i)[0].trim()) + ' · ' + st.repair,
            h('div', { class: 'chips' }, sheet.prices.map((x, i) => h('button', { type: 'button', class: 'chip' + (st.pick.i === i ? ' on' : ''), title: x.raw, onclick: () => { st.pick = { kind: 'sheet', i }; drawResult(); } },
              x.label + ' ' + money(x.price), showProfit && part != null ? h('small', null, 'Profit ' + money(r2(x.price * keep - part))) : null))),
            h('div', { class: 's' }, r0.tab + ' tab · synced ' + new Date(sheetData.syncedAt).toLocaleDateString([], { month: 'short', day: 'numeric' }) + '. Quote this price; the formula below is for reference.')));
          pickPrice = sheet.prices[st.pick.i].price;
        } else if (sheet && sheet.rows) {
          parts.push(h('div', { class: 'sheet miss' }, st.model.trim() + ' is on the Price sheet, but not for ' + st.repair.toLowerCase() + '. Quote the price below.'));
        }
        if (!q) {
          parts.push(h('div', { class: 'note' }, 'Type the part cost to see the price.'));
        } else if (q.single) {
          if (!st.pick) st.pick = { kind: 'single' };
          parts.push(h('div', { class: 'tiles one' }, h('button', { type: 'button', class: 'tile' + (st.pick.kind === 'single' ? ' on' : ''), onclick: () => { st.pick = { kind: 'single' }; drawResult(); } },
            h('div', { class: 'l' }, 'MacBook screen · one price'), h('div', { class: 'p' }, money(q.single.price)),
            h('div', { class: 'h' }, q.single.extra > 0 ? money(q.single.base) + ' + ' + money(q.single.extra) + ' extra' : 'No difficulty for MacBook screens'), pf(q.single.price))));
          const ex = h('input', { type: 'text', inputmode: 'decimal', placeholder: '$0.00', value: st.extra, oninput: (e) => { st.extra = e.target.value; drawResult(); } });
          parts.push(h('div', { class: 'extra' }, h('button', { type: 'button', class: 'sg-btn', onclick: () => { st.extraOn = !st.extraOn; if (!st.extraOn) st.extra = ''; drawResult(); } }, st.extraOn ? '− Remove extra' : '+ Add extra'),
            st.extraOn ? ex : null, h('span', { class: 'sg-soft' }, 'Only when this screen job needs more work than a standard swap.')));
          if (st.pick.kind === 'single') pickPrice = q.single.price;
          if (st.extraOn && document.activeElement !== ex) setTimeout(() => { if (st.extraOn && !st.extra) ex.focus(); });
        } else {
          if (!st.pick) st.pick = { kind: 'level', lvl: 'easy' };
          const muted = st.pick.kind === 'sheet';
          parts.push(h('div', { class: 'tiles' + (muted ? ' muted' : '') }, R.LEVELS.map((lvl) => h('button', { type: 'button', class: 'tile' + (st.pick.kind === 'level' && st.pick.lvl === lvl ? ' on' : ''),
            onclick: () => { st.pick = { kind: 'level', lvl }; AE.track('reassemble:' + lvl); drawResult(); } },
            h('div', { class: 'l' }, LABEL[lvl]), h('div', { class: 'p' }, money(q[lvl].price)), h('div', { class: 'h' }, HINTS[lvl]), pf(q[lvl].price)))));
          if (st.pick.kind === 'level') pickPrice = q[st.pick.lvl].price;
          if (!mac && amount(st.risk) > 0) parts.push(h('div', { class: 'note' }, 'Screen at risk raises Easy so a broken screen is still covered.'));
        }
        if (showProfit && part != null) parts.push(h('div', { class: 'note' }, 'Profit is after the ' + Math.round(s.royalty * 100) + '% royalty and the part. Only you and the profit list see it.'));
        result.replaceChildren(...parts.filter(Boolean));
        footNote.textContent = sheet && sheet.prices.length ? 'Price sheet price · owner pricing for reference'
          : mac && q ? 'Owner pricing: at least ' + money(q.minProfit) + ' profit on ' + (st.newer ? '2024 and newer' : '2023 and older') + ' MacBooks'
          : 'Owner pricing · set in the ' + AE_NAME + ' admin panel';
        copyBtn.disabled = pickPrice == null;
        copyBtn.textContent = pickPrice == null ? 'Copy' : 'Copy ' + money(pickPrice);
        copyBtn.onclick = async () => {
          try { await navigator.clipboard.writeText(pickPrice.toFixed(2)); AE.toast('Copied ' + money(pickPrice), 'Paste it where you need the price.', 'ok'); AE.track('reassemble:copy'); }
          catch (e) { AE.toast("Couldn't copy", e.message || String(e), 'err'); }
        };
      }
      const r2 = (x) => Math.round(x * 100) / 100;
      draw();
      setTimeout(() => fields.querySelector('input')?.focus());
    }
    AE.reassemble.open = open;

    // ------------------------------------------------------------ avatar menu
    function menuItem() {
      const settingsItem = document.querySelector('[data-testid="option-aethernet"]');
      if (!settingsItem || document.querySelector(`[data-testid="${MENU}"]`)) return;
      const item = settingsItem.cloneNode(true);
      item.setAttribute('data-testid', MENU);
      const label = item.querySelector('[data-aui="text"]') || item;
      label.textContent = 'Price estimate';
      item.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        open({ from: 'menu' });
      });
      settingsItem.before(item);
    }

    // ------------------------------------------------------------ the Price Estimate button
    // Check-in's Repair estimate step: bottom left of the step's empty space, just above Back.
    // The Estimates page (/price-check): bottom left, in the footer beside Save estimate / Check-in.
    const slice = (key) => { const r = AE.portal('select', { slice: 'checkInSlice', key }); return r && r.found ? r.value : undefined; };
    // Core's helpers where this build has them (dev's page watcher, 2.23); plain versions otherwise, so this file is the same on every branch.
    const findButton = AE.findButton || ((test) => [...document.querySelectorAll('button')].find((x) => test(x.textContent.trim()) && x.offsetParent) || null);
    const textEl = AE.textEl || ((text) => [...document.querySelectorAll('body *')].find((e) => !e.children.length && e.textContent.trim() === text) || null);
    const onDom = AE.onDom || ((fn) => { let queued = false; new MutationObserver(() => { if (!queued) { queued = true; setTimeout(() => { queued = false; try { fn(); } catch (e) { AE.noteError('reassemble', e); } }, 150); } })
      .observe(document.body, { childList: true, subtree: true }); fn(); });
    const leftOf = (el) => el && el.getBoundingClientRect().left;
    let stepAt = 0, onStep = false;
    function where() {
      const p = location.pathname;
      if (p === '/check-in') {
        if (performance.now() - stepAt > 300) { stepAt = performance.now(); onStep = slice('formStep') === 3; } // Portal's state, at most every 300 ms
        const back = onStep && findButton((t) => t === 'Back');
        if (!back) return null;
        const left = leftOf(document.querySelector('input[placeholder^="Search additional parts"]')) ?? leftOf(back);
        const foot = back.closest('div[class]') || back;
        return { from: 'checkin', left, top: Math.min(back.getBoundingClientRect().top, foot.getBoundingClientRect().top) - 24 - 40,
          prefill: () => { const d = slice('customerDeviceDetails') || {}; return d.deviceName || d.modelName || ''; } };
      }
      if (p === '/price-check') {
        const save = findButton((t) => /^save estimate$/i.test(t));
        if (!save) return null;
        const r = save.getBoundingClientRect(), head = textEl('Device info') || textEl('Estimates');
        const model = () => { const lab = textEl('Device make and model'), box = lab && lab.closest('div') && lab.closest('div').parentElement;
          const i = box && box.querySelector('input'); return (i && i.value) || ''; };
        return { from: 'estimates', left: leftOf(head) ?? r.left, top: r.top + (r.height - 40) / 2, prefill: model };
      }
      return null;
    }
    function placeButton() {
      let b = document.getElementById(BTN);
      const w = where();
      if (!w) { b?.remove(); return; }
      if (!b) {
        b = h('button', { type: 'button', id: BTN, title: 'Reassemble: price an out-of-warranty repair from the part cost', onclick: () => {
          const x = where(), model = x ? x.prefill() : '';
          open({ from: x ? x.from : 'button', model, device: R.typeOf(model) || undefined });
        } }, icon(28), 'Price Estimate');
        document.body.append(b);
      }
      const want = [Math.round(w.left) + 'px', Math.round(w.top) + 'px'];
      if (b.style.left !== want[0]) b.style.left = want[0];
      if (b.style.top !== want[1]) b.style.top = want[1];
    }

    onDom(() => { menuItem(); placeButton(); });
    AE.every(1000, () => { menuItem(); placeButton(); });
    addEventListener('resize', placeButton);
  },
});
