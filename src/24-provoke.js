/*
  Provoke (lead replies). In an arrival's drawer, a box with the text that
  answers this lead, taken from the store's lead sheet, ready to send:
  one click texts the customer and marks the arrival Contacted.

  The sheets: sheets/sync_sheets.py on Garrett's Mac downloads the lead sheet
  (.docx) and the Price sheet (.xlsx) from SharePoint every 15 minutes and
  pushes them to the Worker (GET /v1/:store/sheets/leads|prices). Stores with
  no synced sheet see nothing.

  Which message: Claim arrivals (arrivalTypeId 3) by program; Asurion Mobility
  ones are "ready" (iPhone message for Apple, the Samsung and Google one
  otherwise). Appointment arrivals (type 1) get the first OOP message, with the
  lowest screen price from the Price sheet when the device has an exact row
  there ("15 Pro" never stands in for "15 Pro Max"), and the second OOP message
  after it. Anything else: no message picked, any sheet message can be chosen.

  Sending replays Portal's chat panel (POST /api/messages/v1/send, from the
  store's Twilio number in Portal's auth state) and its "Contacted" note
  dialog (POST /api/note tagged contacted, then PUT /api/arrivals/:id
  contacted: true). Before sending it reads the customer's thread: a text sent
  since the arrival was created stops it ("already texted").
*/
AE.crystal({
  id: 'leadReplies',
  name: 'Provoke',
  sites: ['portal.ubreakifix.net'],
  run() {
    const { h } = AE;
    const BOX_ID = 'ae-provoke';
    const CLAIM = 3, APPOINTMENT = 1, CONTACTED = 53;
    const CLEANINGS = [11759, 9470, 11009, 9901, 10303];
    const MOBILITY = [5062, 20004];
    const SMS = 'SMS', PRIMARY_CONTACT = 1, MANUAL_NOTE = 2;
    // Sheet titles, matched loosely so small edits to the doc don't break them.
    const T = {
      iphone: /^iphone$/i, android: /^samsung and google/i, home: /^atc|home\+/i, verizon: /^verizon$/i,
      oopPrice: /^first oop.*obvious/i, oopAsk: /^first oop.*(unclear|multi)/i, oopSecond: /^second oop/i,
    };
    const BY_PROGRAM = { 8849: T.home, 20005: T.home, 8379: T.verizon };

    document.head.append(h('style', null, `
      #${BOX_ID} { margin:20px 0 0; padding:14px; border:1.5px solid var(--aui-primary, #8223d2); border-radius:12px; font-size:14px; line-height:1.4; }
      #${BOX_ID}.need { border-style:dashed; }
      #${BOX_ID} .hd { display:flex; gap:10px; align-items:center; margin-bottom:10px; }
      #${BOX_ID} .hd .txt { flex:1; }
      #${BOX_ID} .pill { font-size:12px; font-weight:600; padding:2px 10px; border-radius:10000px; background:var(--aui-primary, #8223d2); color:var(--aui-on-primary, #fff); }
      #${BOX_ID}.need .pill { background:var(--aui-warning-soft, #fff4cc); color:var(--aui-on-warning-soft, #3d2e00); }
      #${BOX_ID} select, #${BOX_ID} textarea { width:100%; box-sizing:border-box; font:inherit; color:inherit; background:var(--aui-surface, #fff);
        border:1px solid var(--aui-outline-variant, #c9c6cf); border-radius:8px; padding:7px 9px; }
      #${BOX_ID} textarea { min-height:96px; resize:vertical; margin-top:8px; }
      #${BOX_ID} .chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; align-items:center; }
      #${BOX_ID} .chip { font:inherit; font-size:13px; padding:3px 10px; border-radius:10000px; cursor:pointer;
        border:1px solid var(--aui-outline-variant, #c9c6cf); background:transparent; color:inherit; }
      #${BOX_ID} .chip.on { border-color:var(--aui-primary, #8223d2); background:var(--aui-primary-soft, #f3e8fc); }
      #${BOX_ID} .ft { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:10px; }
      #${BOX_ID} .ft .sp { flex:1; }
      #${BOX_ID} label.chk { display:flex; gap:6px; align-items:center; font-size:13px; margin-top:8px; }
      #${BOX_ID} .hint { text-decoration:underline dotted; text-underline-offset:3px; cursor:help; }
    `));

    // ------------------------------------------------------------ sheets
    const sheets = {};
    async function sheet(kind) {
      const c = sheets[kind];
      if (c && Date.now() - c.at < 10 * 60000) return c.v;
      const v = await AE.waymark.call('GET', '/sheets/' + kind).catch(() => null);
      sheets[kind] = { at: Date.now(), v };
      return v;
    }
    const find = (items, re) => re && (items || []).find((i) => re.test(i.title));

    // ------------------------------------------------------------ prices
    const DROP = new Set(['apple', 'samsung', 'google', 'galaxy', '5g', 'motorola']);
    const QUAL = new Set(['pro', 'max', 'plus', 'ultra', 'fe', 'xl', 'mini', 'e', 'fold', 'flip', 'edge', 'lite', 'air', 'se', 'a', 's', 'note']);
    const toks = (s) => String(s || '').toLowerCase().replace(/\+/g, ' plus ').replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9/ ]/g, ' ')
      .split(/\s+/).filter((t) => t && !DROP.has(t));
    const SCREEN = /lcd|oled|oem|octa|ub screen|screen repair|^glass$|glass\/lcd/i, NOT_SCREEN = /back|camera|cam\b|housing/i;
    const num = (raw) => { const m = String(raw).match(/(\d+(?:\.\d+)?)/); return m && !/n\/?a|self repair/i.test(raw) ? Number(m[1]) : null; };
    const money = (n) => '$' + (Number.isInteger(n) ? n : n.toFixed(2).replace(/\.00$/, ''));
    let priceIndex = null, priceFor = null;
    function indexPrices(p) {
      if (priceFor === p) return priceIndex;
      const idx = {};
      for (const tab of (p && p.tabs) || []) for (const row of tab.rows) {
        const t = toks(String(row.name).split(/\s{3,}|inform customer/i)[0]);
        let variant = '';
        if (/^(inner|outer)$/.test(t[t.length - 1])) variant = t.pop();
        const last = t[t.length - 1] || '';
        const keys = last.includes('/') ? last.split('/').map((a) => t.slice(0, -1).concat(a).join('')) : [t.join('')];
        for (const k of keys) if (k) (idx[k] = idx[k] || []).push({ tab: tab.name, variant, name: row.name, cells: row.cells });
      }
      priceFor = p; priceIndex = idx;
      return idx;
    }
    function pricesFor(device, p) {
      const idx = indexPrices(p), t = toks(device).filter((x) => !x.includes('/'));
      for (let k = t.length; k > 0; k--) {
        const rows = idx[t.slice(0, k).join('')];
        if (!rows) continue;
        if (k < t.length && QUAL.has(t[k])) return null; // "15 Pro" row, "15 Pro Max" device: not the same phone
        return rows;
      }
      return null;
    }
    // Screen prices for the chips: [{label, price, raw}], lowest first.
    function screenPrices(rows) {
      const out = [];
      for (const r of rows || []) for (const [col, raw] of Object.entries(r.cells)) {
        if (!SCREEN.test(col) || NOT_SCREEN.test(col)) continue;
        const n = num(raw);
        if (n != null) out.push({ label: (r.variant ? r.variant[0].toUpperCase() + r.variant.slice(1) + ' ' : '') + col.replace(/screen repair/i, 'Screen'), price: n, raw });
      }
      return out.sort((a, b) => a.price - b.price);
    }

    // ------------------------------------------------------------ the arrival
    const arrivalId = () => (location.pathname.match(/^\/check-in\/arrivals\/(\d+)/) || [])[1] || null;
    const contacted = (a) => (a.arrivalAttributes || []).some((x) => Number(x.arrivalAttributeTypeId) === CONTACTED && x.value !== '' && x.value != null);
    const deviceOf = (a) => (a.customerDevice && (a.customerDevice.deviceName || a.customerDevice.modelName)) || a.deviceName || '';
    const programOf = (a) => Number((a.program && a.program.programId) || a.programId);
    const typeOf = (a) => Number(a.arrivalTypeId || (a.arrivalType && a.arrivalType.arrivalTypeId));

    // What to send: { ready, item, second, prices }
    function pick(a, leads, prices) {
      const items = (leads && leads.items) || [], prog = programOf(a), dev = deviceOf(a);
      if (typeOf(a) === CLAIM && MOBILITY.includes(prog)) return { ready: true, item: find(items, /iphone|ipad/i.test(dev) ? T.iphone : T.android) };
      if (typeOf(a) === CLAIM) return { ready: false, item: find(items, BY_PROGRAM[prog]) };
      if (typeOf(a) === APPOINTMENT) {
        const sp = prices ? screenPrices(pricesFor(dev, prices)) : [];
        return { ready: false, item: find(items, sp.length ? T.oopPrice : T.oopAsk), second: find(items, T.oopSecond), prices: sp };
      }
      return { ready: false, item: null };
    }
    const fill = (text, price) => price == null ? text : text.replace(/\$\s?price\b/gi, money(price));

    // ------------------------------------------------------------ sending
    const report = (what, e) => ' ' + AE.bugLink('Report a bug', { where: 'Provoke', error: what + ': ' + ((e && e.message) || e) }) + '.';
    async function send(a, texts, title) {
      const [prof, jobs] = await Promise.all([AE.profile(), AE.api('GET', '/api/customer/recent-jobs/' + a.customer.customerId + (a.clientId ? '?clientId=' + a.clientId : ''))]);
      const c = (jobs && jobs.customer) || {};
      const to = String(c.contactPhoneNumber || c.primaryPhoneNumber || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
      if (c.canSms === false || jobs.allowSMSForArrival === false || to.length !== 10) return { blocked: "This customer can't be texted from Portal." };
      const from = AE.portal('select', { slice: 'auth', key: 'storeTwilioPhoneNumber' });
      if (!from || !from.found || !from.value) throw new Error('No store texting number in Portal');
      const hist = await AE.api('GET', '/api/messages/v1/customers/' + a.customer.customerId + '?page=1&pageSize=10&sortOrder=DESC&storeId=' + prof.storeId);
      const since = new Date(a.createdAt).getTime();
      const prior = ((hist && hist.messages) || []).find((m) => String(m.direction).toUpperCase() === 'OUTBOUND' && new Date(m.contactDate || m.createdAt).getTime() > since);
      if (prior) return { already: prior };
      const fromNum = String(from.value).startsWith('+1') ? from.value : '+1' + from.value;
      for (const message of texts) {
        await AE.api('POST', '/api/messages/v1/send', {
          customerId: a.customer.customerId, communicationType: SMS, message,
          messageDestination: { smsPhoneNumber: '+1' + to, smsPhoneNumberType: PRIMARY_CONTACT },
          messageSource: { smsPhoneNumber: fromNum }, senderTechnicianId: prof.userId, storeId: prof.storeId,
        });
      }
      await AE.api('POST', '/api/note', { arrivalId: a.arrivalId, noteText: 'Texted the customer (' + title + '):\n\n' + texts.join('\n\n'), noteType: MANUAL_NOTE, noteTag: 'contacted' });
      await AE.api('PUT', '/api/arrivals/' + a.arrivalId, { arrivalId: a.arrivalId, arrivalStatusId: a.arrivalStatus && a.arrivalStatus.arrivalStatusId, contacted: true });
      AE.portal('refresh', { tags: ['Arrivals'] });
      return { sent: true };
    }

    // ------------------------------------------------------------ the box
    let boxFor = null, building = false;
    async function box() {
      const id = arrivalId(), old = document.getElementById(BOX_ID);
      if (!id) { old?.remove(); boxFor = null; return; }
      const anchor = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.trim() === 'Preferred contact method');
      const column = anchor && anchor.closest('div') && anchor.closest('div').parentElement && anchor.closest('div').parentElement.parentElement;
      if (!column || building) return;
      if (old && old.dataset.id === id && old.parentElement === column) return;
      if (boxFor === id && !old) return; // decided: nothing to show here
      building = true;
      try {
        old?.remove(); boxFor = id;
        const a = AE.unwrap(await AE.api('GET', '/api/arrivals/' + id));
        if (!a || CLEANINGS.includes(programOf(a)) || contacted(a)) return;
        const [leads, prices] = await Promise.all([sheet('leads'), sheet('prices')]);
        if (!leads || !leads.data || arrivalId() !== id) return;
        column.append(render(a, leads, prices));
      } catch (_) { /* no box rather than a broken one */ } finally { building = false; }
    }

    function render(a, leads, prices) {
      const items = leads.data.items || [];
      const p = pick(a, leads.data, prices && prices.data);
      let price = p.prices && p.prices.length ? p.prices[0].price : null;
      const ta = h('textarea', { rows: 4 });
      const sel = h('select', { onchange: () => { p.item = items[Number(sel.value)] || null; setText(); } },
        h('option', { value: '' }, 'Choose a message from the lead sheet…'));
      let group = null, og = null;
      items.forEach((it, i) => {
        if (it.group !== group) { group = it.group; og = h('optgroup', { label: group || 'Messages' }); sel.append(og); }
        og.append(h('option', { value: i, selected: it === p.item }, it.title));
      });
      const setText = () => { ta.value = p.item ? fill(p.item.texts[0], price) : ''; btn.disabled = !ta.value.trim(); };
      const chips = p.prices && p.prices.length
        ? h('div', { class: 'chips' }, h('span', { class: 'sg-soft' }, 'Screen:'),
          p.prices.map((x) => { const c = h('button', { type: 'button', class: 'chip' + (x.price === price ? ' on' : ''), title: x.raw, onclick: () => {
            price = x.price; c.parentElement.querySelectorAll('.chip').forEach((o) => o.classList.toggle('on', o === c)); setText();
          } }, x.label + ' ' + money(x.price)); return c; }))
        : (typeOf(a) === APPOINTMENT && prices && prices.data ? h('div', { class: 'chips sg-soft' }, 'No Price sheet row for this device. Check the Price sheet.') : null);
      const second = p.second ? h('input', { type: 'checkbox', checked: true }) : null;
      const msg = h('span', { class: 'sg-soft' });
      const btn = h('button', { type: 'button', class: 'sg-btn sg-primary', onclick: go, html: AE.actionIcon('leadReplies', 18) + 'Send and mark contacted' });
      async function go() {
        const texts = [ta.value.trim()].concat(second && second.checked ? [p.second.texts[0]] : []);
        btn.disabled = true; msg.textContent = 'Sending…';
        try {
          const r = await send(a, texts, (p.item && p.item.title) || 'Provoke');
          if (r.blocked) { msg.textContent = r.blocked; btn.disabled = false; return; }
          if (r.already) {
            const by = [r.already.senderGivenName, r.already.senderFamilyName].filter(Boolean).join(' ') || 'Someone';
            msg.textContent = 'Already texted by ' + by + ' at ' + new Date(r.already.contactDate || r.already.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '.';
            return;
          }
          AE.track('leadReplies:send' + (p.ready ? 'Ready' : ''));
          root.remove();
          AE.toast('Provoke', 'Texted ' + (a.customer.givenName || a.customer.fullName || 'the customer') + ' and marked the arrival contacted.', 'ok');
        } catch (err) {
          msg.innerHTML = "Couldn't send this." + report('Sending lead reply for arrival ' + a.arrivalId, err);
          btn.disabled = false;
        }
      }
      const root = h('div', { id: BOX_ID, class: 'sg' + (p.ready ? '' : ' need'), 'data-id': String(a.arrivalId) },
        h('div', { class: 'hd' }, h('span', { style: 'line-height:0', html: AE.actionIcon('leadReplies', 26) }),
          h('div', { class: 'txt' }, h('b', null, 'Provoke - Reply')),
          h('span', { class: 'pill' }, p.ready ? 'Reply ready' : 'Needs a reply')),
        sel, chips, ta,
        second ? h('label', { class: 'chk' }, second, h('span', { class: 'hint', title: p.second.texts[0] }, 'Send secondary price match message?')) : null,
        h('div', { class: 'ft' }, msg, h('span', { class: 'sp' }), btn),
        h('div', { class: 'sg-soft', style: 'font-size:12px;margin-top:6px' }, 'From the lead sheet' + (chips && p.prices.length ? ' and Price sheet' : '') +
          (leads.syncedAt ? ', as of ' + new Date(leads.syncedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '') + '.'));
      setText();
      return root;
    }

    AE.every(1000, box);
    AE.leadReplies = { pick, pricesFor, screenPrices };
  },
});
