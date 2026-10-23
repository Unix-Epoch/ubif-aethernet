/*
  Provoke (lead replies). In an arrival's drawer, a box with the text that
  answers this lead, taken from the store's lead sheet, ready to send:
  one click texts the customer and marks the arrival Contacted.

  The sheets: sheets/sync_sheets.py on Garrett's Mac downloads the lead sheet
  (.docx) and the Price sheet (.xlsx) from SharePoint every 15 minutes and
  pushes them to the Worker (GET /v1/:store/sheets/leads|prices). Stores with
  no synced sheet see nothing.

  Which message: By program (the M1-M23 table below); Asurion Mobility
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

  Work orders (Oct 10, 2026): in Portal's Customer Chat panel on a WO page, a row
  of the sheet's Special Circumstances texts (+ Parts Arrived) in place of Portal's
  own quick replies; the one that fits the WO's status goes first (Ready for pickup ->
  PICK UP). A click only fills Portal's message box; Portal's Send sends it.
*/
AE.shard({
  id: 'leadReplies',
  name: 'Provoke',
  sites: ['portal.ubreakifix.net'],
  run() {
    const { h } = AE;
    const BOX_ID = 'ae-provoke';
    const APPOINTMENT = 1, CONTACTED = 53;
    // Which message each program gets (Garrett, Oct 6, 2026: M1-M23).
    const NO_BOX = [11759, 9470, 11009, 9901, 10303,  // cleanings
      12532, 8857, 9258, 8088, 11289];                 // not repair leads: in-store pickup, retail, remote tech, screen protector
    const MOBILITY = 5062;                              // the only "Reply ready" program
    const OOP = [20001, 11913];                         // out of warranty (and Xbox OOW): priced first message + price match
    const ASK = [6494, 10335, 10816, 12115, 10553, 11702, 10684, 12236, 11879, 11921, 11128, 11945, 9102, 9955, 8062, 8036,
      6602, 11906, 5427, 12340, 9257, 8979, 9902];     // no sheet message of their own: the "few questions" one
    const CALL = [6494, 20001, 11913];                  // Samsung IW and out of warranty: a call as well as the text
    const SMS = 'SMS', PRIMARY_CONTACT = 1, MANUAL_NOTE = 2;
    // Sheet titles, matched loosely so small edits to the doc don't break them.
    const T = {
      iphone: /^iphone$/i, android: /^samsung and google/i, home: /^atc|home\+/i, verizon: /^verizon$/i,
      oopPrice: /^first oop.*obvious/i, oopAsk: /^first oop.*(unclear|multi)/i, oopSecond: /^second oop/i,
    };
    const BY_PROGRAM = { 20004: 'mobility', 8849: T.home, 20005: T.home, 8379: T.verizon, 8367: /^servify/i, 8850: /^amazon buyout/i, 7384: /^element/i };

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
      #${BOX_ID} .call { margin:0 0 10px; padding:8px 10px; border-radius:8px; background:var(--aui-warning-soft, #fff4cc); color:var(--aui-on-warning-soft, #3d2e00); font-size:13px; }
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

    // ------------------------------------------------------------ prices (matching: src/23-price-sheet.js, shared with Reassemble)
    const { pricesFor, screenPrices } = AE.priceSheet;
    const money = (n) => '$' + (Number.isInteger(n) ? n : n.toFixed(2).replace(/\.00$/, ''));

    // ------------------------------------------------------------ the arrival
    const arrivalId = () => (location.pathname.match(/^\/check-in\/arrivals\/(\d+)/) || [])[1] || null;
    const contacted = (a) => (a.arrivalAttributes || []).some((x) => Number(x.arrivalAttributeTypeId) === CONTACTED && x.value !== '' && x.value != null);
    const deviceOf = (a) => (a.customerDevice && (a.customerDevice.deviceName || a.customerDevice.modelName)) || a.deviceName || '';
    const programOf = (a) => Number((a.program && a.program.programId) || a.programId);
    const typeOf = (a) => Number(a.arrivalTypeId || (a.arrivalType && a.arrivalType.arrivalTypeId));

    // What to send: { ready, item, second, prices }
    function pick(a, leads, prices) {
      const items = (leads && leads.items) || [], prog = programOf(a), dev = deviceOf(a);
      const call = CALL.includes(prog), mobility = find(items, /iphone|ipad/i.test(dev) ? T.iphone : T.android);
      if (prog === MOBILITY) return { ready: true, item: mobility };
      if (BY_PROGRAM[prog]) return { ready: false, call, item: BY_PROGRAM[prog] === 'mobility' ? mobility : find(items, BY_PROGRAM[prog]) };
      if (ASK.includes(prog)) return { ready: false, call, item: find(items, T.oopAsk) };
      if (OOP.includes(prog) || (typeOf(a) === APPOINTMENT && !CLAIM_ONLY(prog))) {
        const sp = prices ? screenPrices(pricesFor(dev, prices)) : [];
        const pickPrice = sp.length && !sp[0].console; // consoles: no "obvious" repair, so no price until one is clicked
        return { ready: false, call, item: find(items, pickPrice ? T.oopPrice : T.oopAsk), priced: find(items, T.oopPrice), second: find(items, T.oopSecond), prices: sp, price: pickPrice ? sp[0].price : null };
      }
      return { ready: false, call, item: null };
    }
    const CLAIM_ONLY = (prog) => !!BY_PROGRAM[prog] || prog === MOBILITY;
    const fill = (text, price) => price == null ? text : text.replace(/\$\s?price\b/gi, money(price));

    // ------------------------------------------------------------ sending
    const report = (what, e) => ' If you keep seeing this, ' + AE.bugLink('report a bug', { where: 'Provoke', error: what + ': ' + ((e && e.message) || e) }) + '!';
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
      const anchor = AE.textEl('Preferred contact method');
      const column = anchor && anchor.closest('div') && anchor.closest('div').parentElement && anchor.closest('div').parentElement.parentElement;
      if (!column || building) return;
      if (old && old.dataset.id === id && old.parentElement === column) return;
      if (boxFor === id && !old) return; // decided: nothing to show here
      building = true;
      try {
        old?.remove(); boxFor = id;
        const a = AE.unwrap(await AE.api('GET', '/api/arrivals/' + id));
        if (!a || NO_BOX.includes(programOf(a)) || contacted(a)) return;
        const [leads, prices] = await Promise.all([sheet('leads'), sheet('prices')]);
        if (!leads || !leads.data || arrivalId() !== id) return;
        column.append(render(a, leads, prices));
      } catch (_) { /* no box rather than a broken one */ } finally { building = false; }
    }

    // " (edited Oct 6)": when the sheet file itself last changed (the sync only pushes changed files).
    const edited = (sh) => { const m = sh && sh.data && (sh.data.modified || sh.syncedAt); return m ? ' (edited ' + new Date(m).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ')' : ''; };
    function render(a, leads, prices) {
      const items = leads.data.items || [];
      const p = pick(a, leads.data, prices && prices.data);
      let price = p.price;
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
        ? h('div', { class: 'chips' }, h('span', { class: 'sg-soft' }, p.prices.every((x) => x.console) ? 'Prices:' : 'Screen:'),
          p.prices.map((x, i) => { const c = h('button', { type: 'button', class: 'chip' + (i === 0 && price != null ? ' on' : ''), title: x.raw, onclick: () => {
            price = x.price; c.parentElement.querySelectorAll('.chip').forEach((o) => o.classList.toggle('on', o === c));
            if (p.priced && p.item !== p.priced) { p.item = p.priced; sel.value = String(items.indexOf(p.priced)); }
            setText();
          } }, x.label + ' ' + money(x.price)); return c; }))
        : (typeOf(a) === APPOINTMENT && prices && prices.data ? h('div', { class: 'chips sg-soft' }, "This device isn't on the price sheet.") : null);
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
          AE.toast('Provoke', 'Texted ' + (a.customer.givenName || a.customer.fullName || 'the customer') + ' and marked the arrival contacted.' + (p.call ? ' Remember to call them too.' : ''), 'ok', p.call ? 15000 : undefined);
        } catch (err) {
          msg.innerHTML = "Couldn't send this." + report('Sending lead reply for arrival ' + a.arrivalId, err);
          btn.disabled = false;
        }
      }
      const root = h('div', { id: BOX_ID, class: 'sg' + (p.ready ? '' : ' need'), 'data-id': String(a.arrivalId) },
        h('div', { class: 'hd' }, h('span', { style: 'line-height:0', html: AE.actionIcon('leadReplies', 26) }),
          h('div', { class: 'txt' }, h('b', null, 'Provoke - Reply')),
          h('span', { class: 'pill' }, p.ready ? 'Reply ready' : 'Needs a reply')),
        p.call ? h('div', { class: 'call' }, h('b', null, 'Call this customer too.'), ' ' + (programOf(a) === 6494 ? 'Samsung In-Warranty' : 'Out-of-warranty') + ' leads need a call as well as a text.') : null,
        sel, chips, ta,
        second ? h('label', { class: 'chk' }, second, h('span', { class: 'hint', title: p.second.texts[0] }, 'Also send the price match message')) : null,
        h('div', { class: 'ft' }, msg, h('span', { class: 'sp' }), btn),
        h('div', { class: 'sg-soft', style: 'font-size:12px;margin-top:6px' }, 'From the lead sheet' + edited(leads) +
          (p.prices && p.prices.length ? ' and Price sheet' + edited(prices) : '') + '.'));
      setText();
      return root;
    }

    // ------------------------------------------------------------ WO chat panel
    // On a WO page, a row of lead-sheet texts in Portal's Customer Chat panel, in place of
    // Portal's own quick replies (hidden while it's there; Garrett, Oct 12, 2026). A click
    // only fills Portal's message box: Portal's Send arrow sends it (so Recitation and
    // Auto-Waymark see an ordinary send).
    // Portal's panel (ubif-components ChatPanel): a flex column of header, Recent jobs,
    // messages, the quick replies (only once the customer has an active WO, so they can
    // appear after the panel does), then a <form> around the message box. The row always
    // sits right before that form.
    const CHAT_ID = 'ae-provoke-chat';
    const WO_TOP = ['pickup', 'partsArrived', 'partsOrdered', 'update', 'fmip']; // the chips; the rest of Special Circumstances go under More
    const WO_T = { pickup: /^pick ?up/i, partsArrived: /^parts arrived/i, partsOrdered: /^parts ordered/i, update: /^update$/i, fmip: /^turn off fmip/i };
    const WO_GROUPS = /special circumstances/i;
    // The WO status → the message that goes first (Garrett, Oct 10, 2026). Name first, id as a fallback.
    const byStatus = (name, id) => /ready for pickup/i.test(name) || id === 13 ? 'pickup'
      : /awaiting item|parts on order|ordered/i.test(name) || id === 3 ? 'partsOrdered'
        : /parts (received|arrived)/i.test(name) ? 'partsArrived' : null;
    const woIdNow = () => (location.pathname.match(/^\/repair\/workorder\/(\d+)/) || [])[1] || null;
    const msgBox = () => [...document.querySelectorAll('textarea[placeholder], input[placeholder]')]
      .find((el) => /^Message .*\.\.\.$|^Message .*…$/.test(el.getAttribute('placeholder')) && el.offsetParent) || null;
    const PORTAL_CHIPS = /^(Need to Order|Parts on Order|Parts Arrived|Awaiting Device|Awaiting Approval|Repair Delayed)$/i;

    document.head.append(h('style', null, `
      [data-ae-provoke-hid] { display:none !important; }
      #${CHAT_ID} { flex-shrink:0; margin:8px 1rem; padding:10px 10px 12px; border:1.5px solid var(--aui-primary, #8223d2); border-radius:10px; font-size:14px; line-height:1.3; }
      #${CHAT_ID} .hd { display:flex; gap:8px; align-items:center; font-size:13px; font-weight:600; margin-bottom:9px; }
      #${CHAT_ID} .hd .sp { flex:1; }
      #${CHAT_ID} .cs { display:flex; flex-wrap:wrap; gap:8px; position:relative; }
      #${CHAT_ID} .c { font:inherit; font-size:14px; padding:5px 12px; border-radius:10000px; cursor:pointer; white-space:nowrap;
        border:1px solid var(--aui-outline-variant, #c9c6cf); background:transparent; color:inherit; }
      #${CHAT_ID} .c.top { background:var(--aui-primary, #8223d2); border-color:var(--aui-primary, #8223d2); color:var(--aui-on-primary, #fff); font-weight:600; }
      #${CHAT_ID} .c.top small { font-weight:400; opacity:.85; margin-left:4px; }
      #${CHAT_ID} .c.on { outline:2px solid var(--aui-primary, #8223d2); outline-offset:2px; }
      #${CHAT_ID} .c.more { border-style:dashed; }
      #${CHAT_ID} .menu { position:absolute; z-index:5; left:0; right:0; bottom:calc(100% + 34px); max-height:320px; overflow:auto; padding:6px 0;
        background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1b1b1f); border:1px solid var(--aui-outline-variant, #c9c6cf); border-radius:10px; box-shadow:0 8px 24px rgba(0,0,0,.3); }
      #${CHAT_ID} .menu button { display:block; width:100%; text-align:left; font:inherit; font-size:14px; padding:7px 14px; border:0; background:transparent; color:inherit; cursor:pointer; }
      #${CHAT_ID} .menu button:hover { background:var(--aui-primary-soft, #f3e8fc); }
      #${CHAT_ID} .menu .g { font-size:11.5px; text-transform:uppercase; letter-spacing:.6px; padding:8px 14px 4px; opacity:.7; }
    `));

    // Put text in Portal's (React) message box the way typing would.
    function fillBox(box, text) {
      const proto = box.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(box, text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.focus();
      try { box.setSelectionRange(text.length, text.length); } catch (_) { /* some inputs don't allow it */ }
    }

    // Keep the row right before Portal's message form, and Portal's quick replies hidden while it's there.
    function place(row, box) {
      const form = box.closest('form');
      if (!form || !form.parentElement) return false;
      const panel = form.parentElement;
      if (row.parentElement !== panel || row.nextElementSibling !== form) panel.insertBefore(row, form);
      // Portal's quick replies end up just before the row (React adds them before the form, the row then moves below them).
      const el = row.previousElementSibling;
      if (el && !el.hasAttribute('data-ae-provoke-hid')) {
        const bs = el.querySelectorAll('button');
        if (bs.length && [...bs].every((b) => PORTAL_CHIPS.test(b.textContent.trim()))) el.setAttribute('data-ae-provoke-hid', '');
      }
      return true;
    }
    function unplace() {
      document.getElementById(CHAT_ID)?.remove();
      document.querySelectorAll('[data-ae-provoke-hid]').forEach((el) => el.removeAttribute('data-ae-provoke-hid'));
    }

    // Built each time the panel opens, so the status is current (a WO just set to Ready for pickup).
    let chatStatus = null, chatBuilding = false;
    async function chat() {
      const old = document.getElementById(CHAT_ID), woId = woIdNow(), box = woId && msgBox();
      if (!box || box.disabled || box.readOnly) { if (old) unplace(); return; } // texting off for this customer: Portal's own message shows
      if (old && old.dataset.wo === woId) { place(old, box); return; }
      if (chatBuilding) return;
      chatBuilding = true;
      try {
        const [leads, j] = await Promise.all([sheet('leads'), AE.api('GET', '/api/workorder/' + woId).catch(() => null)]);
        const items = (leads && leads.data && leads.data.items) || [];
        const b2 = msgBox();
        if (!items.length || !b2 || woIdNow() !== woId) return;
        const wo = (j && j.workorder) || AE.unwrap(j) || {};
        const name = wo.workorderStatusName || (wo.WorkorderStatus && wo.WorkorderStatus.name) || (wo.workorderStatus && wo.workorderStatus.name) || '';
        chatStatus = { key: byStatus(name, Number(wo.workorderStatusId)), name };
        unplace();
        const row = renderChat(items, leads, woId);
        if (!place(row, b2)) row.remove();
      } catch (_) { /* no row rather than a broken one */ } finally { chatBuilding = false; }
    }

    function renderChat(items, leads, woId) {
      const named = {};
      for (const [k, re] of Object.entries(WO_T)) named[k] = find(items, re);
      const top = (chatStatus && chatStatus.key && named[chatStatus.key]) ? chatStatus.key : null;
      const order = (top ? [top] : []).concat(WO_TOP.filter((k) => k !== top)).filter((k) => named[k]);
      const shown = new Set(order.map((k) => named[k]));
      const rest = items.filter((it) => WO_GROUPS.test(it.group || '') && !shown.has(it));
      const turns = new Map(); // a message with more than one text (Turn Off FMIP): each click fills the next one
      let menu = null;
      const use = (it, chip) => {
        const box = msgBox();
        if (!box) return;
        const n = turns.has(it) ? (turns.get(it) + 1) % it.texts.length : 0;
        turns.set(it, n);
        fillBox(box, it.texts[n]);
        root.querySelectorAll('.c').forEach((c) => c.classList.toggle('on', c === chip));
        AE.track('leadReplies:woFill');
      };
      const chip = (it, isTop) => {
        const c = h('button', { type: 'button', class: 'c' + (isTop ? ' top' : ''), title: it.texts.join('\n\n— or —\n\n'), onclick: () => use(it, c) },
          it.title.replace(/\s*\(.*\)\s*$/, ''), isTop && chatStatus && chatStatus.name ? h('small', null, '· ' + chatStatus.name) : null);
        return c;
      };
      const more = rest.length ? h('button', { type: 'button', class: 'c more', onclick: (e) => {
        e.stopPropagation();
        if (menu) { menu.remove(); menu = null; more.classList.remove('on'); return; }
        menu = h('div', { class: 'menu' }, h('div', { class: 'g' }, rest[0].group || 'More'),
          rest.map((it) => h('button', { type: 'button', title: it.texts[0], onclick: () => { menu.remove(); menu = null; use(it, more); } }, it.title)));
        cs.append(menu);
        more.classList.add('on');
        const off = (ev) => { if (menu && !menu.contains(ev.target) && ev.target !== more) { menu.remove(); menu = null; more.classList.remove('on'); } if (!menu) removeEventListener('click', off, true); };
        addEventListener('click', off, true);
      } }, 'More ▾') : null;
      const cs = h('div', { class: 'cs' }, order.map((k) => chip(named[k], k === top)), more);
      const root = h('div', { id: CHAT_ID, class: 'sg', 'data-wo': woId },
        h('div', { class: 'hd' }, h('span', { style: 'line-height:0', html: AE.actionIcon('leadReplies', 22) }), h('span', null, 'Provoke'),
          h('span', { class: 'sp' }), h('span', { class: 'sg-soft', style: 'font-weight:400' }, 'Lead sheet' + edited(leads))),
        cs);
      return root;
    }

    AE.every(1000, box);
    AE.every(1000, chat);
    AE.onDom(() => { // the drawer's column, the frame it appears (2.23); box() keeps its own "decided" state
      if (woIdNow()) chat(); else if (document.getElementById(CHAT_ID)) unplace();
      if (!arrivalId()) { document.getElementById(BOX_ID)?.remove(); return; }
      const b = document.getElementById(BOX_ID);
      if (!b || !b.isConnected) box();
    });
    AE.leadReplies = { pick, pricesFor, screenPrices, byStatus };
  },
});
