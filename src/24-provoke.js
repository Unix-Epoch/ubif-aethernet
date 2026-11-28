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
    const APPOINTMENT = 1, CONTACTED = 53, NOT_CONFIRMED = 20; // NOT_CONFIRMED: Portal's ArrivalStatusEnum.NotConfirmed
    // Batch send only takes arrivals still Not confirmed and not missed (Confirmed and missed appointments are left alone).
    const awaiting = (a) => Number(a.arrivalStatus && a.arrivalStatus.arrivalStatusId) === NOT_CONFIRMED && a.isMissed !== true;
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
      // The priced first message has two versions (Oct 24, 2026): "(Everything else)" with one $price, and
      // "(iPhone Display)" quoting a 3rd party display ($price) and an OEM one ($price).
      oopPrice: /^first oop(?!.*iphone display).*obvious/i, oopIphone: /^first oop.*iphone display/i,
      oopAsk: /^first oop.*(unclear|multi)/i, oopSecond: /^second oop/i,
    };
    const BY_PROGRAM = { 20004: 'mobility', 8849: T.home, 20005: T.home, 8379: T.verizon, 8367: /^servify/i, 8850: /^amazon buyout/i, 7384: /^element/i };

    const BOXES = `:is(#${BOX_ID}, #${BOX_ID}-review)`; // the arrival drawer's box, and the same box in Batch send's review
    document.head.append(h('style', null, `
      ${BOXES} { margin:20px 0 0; padding:14px; border:1.5px solid var(--aui-primary, #8223d2); border-radius:12px; font-size:14px; line-height:1.4; }
      ${BOXES}.need { border-style:dashed; }
      ${BOXES} .hd { display:flex; gap:10px; align-items:center; margin-bottom:10px; }
      ${BOXES} .hd .txt { flex:1; }
      ${BOXES} .pill { font-size:12px; font-weight:600; padding:2px 10px; border-radius:10000px; background:var(--aui-primary, #8223d2); color:var(--aui-on-primary, #fff); }
      ${BOXES}.need .pill { background:var(--aui-status-warning-soft, #fff0c0); color:var(--aui-status-on-warning-soft, #3a3000); }
      ${BOXES} select, ${BOXES} textarea { width:100%; box-sizing:border-box; font:inherit; color:inherit; background:var(--aui-surface, #fff);
        border:1px solid var(--aui-outline, #c6c6ca); border-radius:8px; padding:7px 9px; }
      ${BOXES} textarea { min-height:96px; resize:vertical; margin-top:8px; }
      ${BOXES} .chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; align-items:center; }
      ${BOXES} .chip { font:inherit; font-size:13px; padding:3px 10px; border-radius:10000px; cursor:pointer;
        border:1px solid var(--aui-outline, #c6c6ca); background:transparent; color:inherit; }
      ${BOXES} .chip.on { border-color:var(--aui-primary, #8223d2); background:var(--aui-primary-soft, #f3e8fc); }
      ${BOXES} .ft { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:10px; }
      ${BOXES} .ft .sp { flex:1; }
      ${BOXES} label.chk { display:flex; gap:6px; align-items:center; font-size:13px; margin-top:8px; }
      ${BOXES} .call { margin:0 0 10px; padding:8px 10px; border-radius:8px; background:var(--aui-status-warning-soft, #fff0c0); color:var(--aui-status-on-warning-soft, #3a3000); font-size:13px; }
      ${BOXES} .quote { margin:6px 0 0; padding:6px 10px; border-left:3px solid var(--aui-outline, #c6c6ca); border-radius:0 8px 8px 0;
        background:var(--aui-neutral-soft, #f1f0f4); font-size:13px; white-space:pre-wrap; }
      ${BOXES} .quote.off { opacity:.45; }
      ${BOXES} .reset { font:inherit; font-size:13px; font-weight:600; margin-top:6px; padding:0; border:0; background:none; cursor:pointer; color:var(--aui-primary, #8223d2); text-decoration:underline; }
      ${BOXES} .ft .half { display:flex; gap:10px; align-items:center; flex-wrap:wrap; color:var(--aui-status-error, #b91a24); font-weight:600; }
      #${BOX_ID}-review { margin:0; padding:0; border:0; }
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
        // iPhones: the iPhone Display message, priced with the lowest 3rd party display (Apple tab LCD / OLED) and the OEM one.
        const iph = pickPrice && /iphone/i.test(dev) && find(items, T.oopIphone);
        const third = sp.find((x) => !isOem(x)), oem = sp.find(isOem);
        if (iph && third && oem) return { ready: false, call, item: iph, priced: iph, second: find(items, T.oopSecond), prices: sp, price: [third.price, oem.price], slots: [third, oem] };
        return { ready: false, call, item: find(items, pickPrice ? T.oopPrice : T.oopAsk), priced: find(items, T.oopPrice), second: find(items, T.oopSecond), prices: sp, price: pickPrice ? sp[0].price : null };
      }
      return { ready: false, call, item: null };
    }
    const CLAIM_ONLY = (prog) => !!BY_PROGRAM[prog] || prog === MOBILITY;
    // A price chip's slot on the iPhone Display message: OEM (the second $price) or a 3rd party display (the first).
    const isOem = (x) => /\boem\b/i.test(x.label) && !/lcd|oled/i.test(x.label);
    // price: one number for every $price, or [first, second, …] in order (the last one repeats).
    const fill = (text, price) => {
      if (price == null) return text;
      let i = 0;
      return text.replace(/\$\s?price\b/gi, () => money(Array.isArray(price) ? price[Math.min(i++, price.length - 1)] : price));
    };

    /*
      Certainty: how sure Provoke is that pick()'s message is the right one, 0-100. Every lead starts at 100 and
      loses points for each thing that could make the text wrong; only 100 ("sure") can be batch sent.
      100 needs: a "Reply ready" program (Asurion Mobility), a device that is plainly Apple (iPhone/iPad) or plainly
      Samsung/Google (the message is chosen by it), a sheet message with nothing left to fill in, no price picked
      for the tech, no call needed, the customer only once in the list, and the arrival not contacted.
      Sending checks the rest again per lead (send(): can be texted, nobody texted them since the arrival came in).
    */
    const APPLE = /\b(iphone|ipad)\b/i, SAMSUNG_GOOGLE = /\b(samsung|galaxy|google|pixel)\b/i;
    const BLANK = /\$\s?price\b|_{3,}|\[[^\]]*\]|<[^>]*>|\{[^}]*\}/i; // a slot the sheet expects someone to fill
    function certainty(a, leads, prices, twice) {
      const p = pick(a, leads, prices), prog = programOf(a), why = [];
      let score = 100;
      const off = (n, w) => { score -= n; if (!why.includes(w)) why.push(w); };
      if (!p.item || !p.item.texts || !p.item.texts[0]) return { score: 0, sure: false, p, why: ['No message'] };
      if (!p.ready) off(BY_PROGRAM[prog] ? 30 : 60, 'Program');
      if (prog === MOBILITY && APPLE.test(deviceOf(a)) === SAMSUNG_GOOGLE.test(deviceOf(a))) off(40, 'Device');
      if (p.price != null) off(25, 'Price');
      if (BLANK.test(fill(p.item.texts[0], p.price))) off(50, 'Blank in message');
      if (p.call) off(20, 'Needs a call');
      if (twice) off(40, 'Same customer twice');
      if (leads && leads.unplaced && leads.unplaced.length) off(10, 'Lead sheet');
      if (contacted(a)) off(100, 'Contacted');
      if (!awaiting(a)) off(100, 'Status');
      if (!a.customer || !a.customer.customerId) off(100, 'No customer');
      score = Math.max(0, score);
      return { score, sure: score === 100, p, why, text: fill(p.item.texts[0], p.price) };
    }
    // Customers with more than one arrival in the list: one text each at most, so none of them are sure.
    const twiceOf = (arrivals) => {
      const n = new Map();
      for (const a of arrivals) { const c = a.customer && a.customer.customerId; if (c) n.set(c, (n.get(c) || 0) + 1); }
      return (a) => (n.get(a.customer && a.customer.customerId) || 0) > 1;
    };

    /*
      Batch send: one lead at a time. Each arrival is read again first and must still be sure, then send() texts it
      and marks it contacted. onRow(id, state, result) with state sending | sent | skipped | half | failed | stopped.
      A lead texted but not marked contacted (half) stops the batch, and so do two failures in a row; ctl.stop()
      stops after the lead in flight. ctl.gap: the pause between texts (ms).
    */
    async function batch(ids, leads, prices, twice, onRow, ctl = {}) {
      const gap = ctl.gap == null ? 1500 : ctl.gap, out = [];
      let fails = 0;
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (ctl.stopped) { out.push({ id, state: 'stopped' }); onRow(id, 'stopped', out[out.length - 1]); continue; }
        onRow(id, 'sending');
        let r;
        try {
          const a = AE.unwrap(await AE.api('GET', '/api/arrivals/' + id));
          const c = a && certainty(a, leads, prices, twice && twice(a));
          if (!c || !c.sure) r = { state: 'skipped', why: c && c.why.includes('Contacted') ? 'Already contacted' : c && c.why.includes('Status') ? 'No longer Not confirmed' : 'Changed' };
          else {
            const s = await send(a, [c.text], c.p.item.title);
            if (s.blocked) r = { state: 'skipped', why: "Can't be texted" };
            else if (s.already) r = { state: 'skipped', why: 'Already texted by ' + ([s.already.senderGivenName, s.already.senderFamilyName].filter(Boolean).join(' ') || 'someone') };
            else { r = { state: 'sent', title: c.p.item.title }; AE.track('leadReplies:batchSend'); }
          }
          fails = 0;
        } catch (e) {
          r = { state: e && e.sent ? 'half' : 'failed', error: e };
          if (r.state === 'half') ctl.stopped = true;
          else if (++fails >= 2) ctl.stopped = true;
        }
        out.push(Object.assign({ id }, r));
        onRow(id, r.state, r);
        if (r.state === 'sent' && gap && i < ids.length - 1 && !ctl.stopped) await new Promise((ok) => setTimeout(ok, gap));
      }
      return out;
    }

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
      // Once a text has gone out, an error must not read as "nothing sent": it carries what was sent (err.sent, the texts)
      // and how far the finishing steps got (err.noted), so the box offers only the missing step and never a second text.
      const done = { sent: [], noted: false };
      try {
        for (const message of texts) {
          await AE.api('POST', '/api/messages/v1/send', {
            customerId: a.customer.customerId, communicationType: SMS, message,
            messageDestination: { smsPhoneNumber: '+1' + to, smsPhoneNumberType: PRIMARY_CONTACT },
            messageSource: { smsPhoneNumber: fromNum }, senderTechnicianId: prof.userId, storeId: prof.storeId,
          });
          done.sent.push(message);
        }
        await finish(a, done, title);
      } catch (e) {
        if (done.sent.length) throw Object.assign(e, { sent: done.sent, noted: done.noted });
        throw e;
      }
      return { sent: true };
    }
    // The steps after texting: the "contacted" note (with the texts that went out), then the arrival marked contacted.
    async function finish(a, done, title) {
      if (!done.noted) {
        await AE.api('POST', '/api/note', { arrivalId: a.arrivalId, noteText: 'Texted the customer (' + title + '):\n\n' + done.sent.join('\n\n'), noteType: MANUAL_NOTE, noteTag: 'contacted' });
        done.noted = true;
      }
      await AE.api('PUT', '/api/arrivals/' + a.arrivalId, { arrivalId: a.arrivalId, arrivalStatusId: a.arrivalStatus && a.arrivalStatus.arrivalStatusId, contacted: true });
      AE.portal('refresh', { tags: ['Arrivals'] });
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
    const sheetEdited = (sh) => { const m = sh && sh.data && (sh.data.modified || sh.syncedAt); return m ? ' (edited ' + new Date(m).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ')' : ''; };
    // opt (Batch send's review): { review: true, sendLabel, left, before, onDone }: no header or sheet line, its own id, onDone() after a send.
    function render(a, leads, prices, opt = {}) {
      const items = leads.data.items || [];
      const p = pick(a, leads.data, prices && prices.data);
      let price = p.price;
      // edited: the tech changed the text by hand. Then a price chip only swaps the dollar amounts it put there, and
      // picking another message asks before replacing it; "Reset text" (shown only then) puts the sheet's text back.
      let filled = '', edited = false, locked = false; // locked: texts went out, Send stays off
      const reset = h('button', { type: 'button', class: 'reset', hidden: true, onclick: () => { setText(); ta.focus(); } }, 'Reset text');
      const markEdited = () => { edited = ta.value !== filled; reset.hidden = !edited; btn.disabled = locked || !ta.value.trim(); };
      const ta = h('textarea', { rows: 4, oninput: markEdited });
      let selAt = '';
      const sel = h('select', { onchange: async () => {
        if (edited && !(await AE.confirm({ icon: 'leadReplies', title: 'Replace your edited text?', confirmLabel: 'Replace' }))) { sel.value = selAt; return; }
        selAt = sel.value; p.item = items[Number(sel.value)] || null; setText();
      } },
        h('option', { value: '' }, 'Choose a message from the lead sheet…'));
      let group = null, og = null;
      items.forEach((it, i) => {
        if (it.group !== group) { group = it.group; og = h('optgroup', { label: group || 'Messages' }); sel.append(og); }
        og.append(h('option', { value: i, selected: it === p.item }, it.title));
      });
      selAt = sel.value;
      const setText = () => { ta.value = filled = p.item ? fill(p.item.texts[0], price) : ''; markEdited(); };
      // Edited text: put the new price where the old one was, and nothing else.
      const swapPrice = (from, to) => {
        if (from == null || from === to) return;
        const a = money(from), b = money(to);
        if (ta.value.includes(a)) { ta.value = ta.value.split(a).join(b); filled = filled.split(a).join(b); markEdited(); }
      };
      const chips = p.prices && p.prices.length
        ? h('div', { class: 'chips' }, h('span', { class: 'sg-soft' }, p.prices.every((x) => x.console) ? 'Prices:' : 'Screen:'),
          p.prices.map((x, i) => { const on = p.slots ? p.slots.includes(x) : i === 0 && price != null; const c = h('button', { type: 'button', class: 'chip' + (on ? ' on' : ''), 'aria-pressed': String(on), title: x.raw, 'data-slot': p.slots ? (isOem(x) ? 1 : 0) : '', onclick: () => {
            // iPhone Display message: a chip sets its own slot (3rd party or OEM) and keeps the other; otherwise one price.
            const was = p.slots ? price[isOem(x) ? 1 : 0] : price;
            const mark = (sel2) => c.parentElement.querySelectorAll(sel2).forEach((o) => { o.classList.toggle('on', o === c); o.setAttribute('aria-pressed', String(o === c)); });
            if (p.slots) { const slot = isOem(x) ? 1 : 0; price = price.slice(); price[slot] = x.price; mark('.chip[data-slot="' + slot + '"]'); }
            else { price = x.price; mark('.chip'); }
            if (edited) { swapPrice(was, x.price); return; }
            if (p.priced && p.item !== p.priced) { p.item = p.priced; sel.value = selAt = String(items.indexOf(p.priced)); }
            setText();
          } }, x.label + ' ' + money(x.price)); return c; }))
        : (typeOf(a) === APPOINTMENT && prices && prices.data ? h('div', { class: 'chips sg-soft' }, "This device isn't on the price sheet.") : null);
      const quote = p.second ? h('div', { class: 'quote' }, p.second.texts[0]) : null;
      const second = p.second ? h('input', { type: 'checkbox', checked: true, onchange: () => quote.classList.toggle('off', !second.checked) }) : null;
      const msg = h('span', { class: 'sg-soft' });
      const btn = h('button', { type: 'button', class: 'sg-btn sg-primary', onclick: go, html: opt.review ? '' : AE.actionIcon('leadReplies', 18) + 'Send and mark contacted' });
      if (opt.review) btn.textContent = opt.sendLabel;
      async function go() {
        btn.disabled = true; msg.textContent = 'Sending…';
        try {
          const r = await send(a, texts(), (p.item && p.item.title) || 'Provoke');
          if (r.blocked) { msg.textContent = r.blocked; btn.disabled = false; return; }
          if (r.already) {
            const by = [r.already.senderGivenName, r.already.senderFamilyName].filter(Boolean).join(' ') || 'Someone';
            msg.textContent = 'Already texted by ' + by + ' at ' + new Date(r.already.contactDate || r.already.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '.';
            return;
          }
          AE.track('leadReplies:send' + (p.ready ? 'Ready' : ''));
          root.remove();
          if (opt.onDone) { opt.onDone('sent'); if (p.call) AE.toast('Provoke', 'Remember to call ' + (a.customer.givenName || a.customer.fullName || 'the customer') + ' too.', 'ok', 15000); return; }
          AE.toast('Provoke', 'Texted ' + (a.customer.givenName || a.customer.fullName || 'the customer') + ' and marked the arrival contacted.' + (p.call ? ' Remember to call them too.' : ''), 'ok', p.call ? 15000 : undefined);
        } catch (err) {
          if (err.sent) { half(err); return; } // texted: Send stays off, only the missing step is offered
          msg.innerHTML = "Couldn't send this." + report('Sending lead reply for arrival ' + a.arrivalId, err);
          btn.disabled = false;
        }
      }
      // Some or all texts went out but a later step failed: say so and offer "Mark contacted" (note + contacted, as far as they got).
      function half(err) {
        const done = { sent: err.sent, noted: !!err.noted };
        const title = (p.item && p.item.title) || 'Provoke';
        const what = done.sent.length < texts().length ? 'Sent ' + done.sent.length + ' of ' + texts().length + " texts, but couldn't mark contacted." : "Texted, but couldn't mark contacted.";
        const fix = h('button', { type: 'button', class: 'sg-btn sg-primary', onclick: async () => {
          fix.disabled = true;
          try {
            await finish(a, done, title);
            AE.track('leadReplies:markContacted');
            root.remove();
            if (opt.onDone) { opt.onDone('sent'); return; }
            AE.toast('Provoke', 'Marked the arrival contacted.', 'ok');
          } catch (e2) {
            fix.disabled = false;
            line.replaceChildren(what, fix);
            line.insertAdjacentHTML('beforeend', '<span>' + report('Marking arrival ' + a.arrivalId + ' contacted after texting', e2).trim() + '</span>');
          }
        } }, 'Mark contacted');
        const line = h('span', { class: 'half' }, what, fix);
        msg.replaceChildren(line);
        locked = true; btn.disabled = true;
      }
      const texts = () => [ta.value.trim()].concat(second && second.checked ? [p.second.texts[0]] : []);
      const root = h('div', { id: opt.review ? BOX_ID + '-review' : BOX_ID, class: opt.review ? 'sg' : 'sg sg-card' + (p.ready ? '' : ' need'), 'data-id': String(a.arrivalId) },
        opt.review ? null : h('div', { class: 'hd ae-head' }, h('span', { style: 'line-height:0', html: AE.actionIcon('leadReplies', 26) }),
          h('div', { class: 'txt' }, h('b', null, 'Provoke - Reply')),
          h('span', { class: 'pill' }, p.ready ? 'Reply ready' : 'Needs a reply')),
        p.call ? h('div', { class: 'call' }, h('b', null, 'Call this customer too.'), ' ' + (programOf(a) === 6494 ? 'Samsung In-Warranty' : 'Out-of-warranty') + ' leads need a call as well as a text.') : null,
        sel, chips, ta,
        reset,
        second ? h('label', { class: 'chk' }, second, h('span', null, 'Also send the price match message')) : null, quote,
        h('div', { class: 'ft' }, opt.left || null, msg, h('span', { class: 'sp' }), opt.before || null, btn),
        opt.review ? null : h('div', { class: 'sg-soft', style: 'font-size:12px;margin-top:6px' }, 'From the lead sheet' + sheetEdited(leads) +
          (p.prices && p.prices.length ? ' and Price sheet' + sheetEdited(prices) : '') + '.'));
      setText();
      return root;
    }

    // ------------------------------------------------------------ batch send (Arrivals page)
    // "Batch send (N)" beside Portal's chips: every not-contacted arrival in Portal's current day/filters, scored; the
    // dialog lists them all, but only sure ones (100) can be ticked. Counted once per visit and after each batch.
    const BATCH_ID = 'ae-provoke-batch';
    document.head.append(h('style', null, `
      #${BATCH_ID} { margin-left:auto; padding-left:7px; flex:none; align-self:center; } /* the last item of Portal's chip row: no row of its own */
      .ae-pb { width:min(820px, 100%); max-height:calc(100vh - 32px); overflow:auto; padding:20px 22px; font-size:14px; line-height:1.4; }
      .ae-pb h2 { display:flex; align-items:center; gap:10px; margin:0 0 14px; font-size:19px; font-weight:700; }
      .ae-pb table { width:100%; border-collapse:collapse; font-size:13px; }
      .ae-pb th { text-align:left; font-weight:600; padding:9px 10px; color:var(--aui-on-surface-variant, #5d5e61); border-bottom:1px solid var(--aui-outline, #c6c6ca); }
      .ae-pb td { padding:9px 10px; border-bottom:1px solid var(--aui-neutral-soft, #f1f0f4); vertical-align:middle; }
      .ae-pb tr.dim td { color:var(--aui-on-surface-variant, #5d5e61); }
      .ae-pb .why { font-size:12px; color:var(--aui-on-surface-variant, #5d5e61); }
      .ae-pb .sc { display:inline-block; min-width:42px; text-align:center; font-weight:700; font-size:12px; padding:2px 8px; border-radius:10000px;
        background:var(--aui-neutral-soft, #f1f0f4); color:var(--aui-on-surface-variant, #5d5e61); }
      .ae-pb .sc.s100 { background:var(--aui-primary, #8223d2); color:var(--aui-on-primary, #fff); }
      .ae-pb .sc.mid { background:var(--aui-status-warning-soft, #fff0c0); color:var(--aui-status-on-warning-soft, #3a3000); }
      .ae-pb input[type=checkbox] { width:16px; height:16px; accent-color:var(--aui-primary, #8223d2); margin:0; }
      .ae-pb .msgs { margin-top:14px; display:grid; gap:8px; }
      .ae-pb .q { padding:8px 12px; border-left:3px solid var(--aui-primary, #8223d2); border-radius:0 8px 8px 0; background:var(--aui-neutral-soft, #f1f0f4); font-size:13px; white-space:pre-wrap; }
      .ae-pb .q b { display:block; margin-bottom:2px; }
      .ae-pb .ft { display:flex; align-items:center; gap:10px; margin-top:16px; }
      .ae-pb .ft .sp { flex:1; }
      .ae-pb .st { font-weight:600; font-size:13px; }
      .ae-pb .st.sent { color:var(--aui-status-success, #136d31); }
      .ae-pb .st.half, .ae-pb .st.failed { color:var(--aui-status-error, #b91a24); }
      .ae-pb .st.skipped, .ae-pb .st.stopped { color:var(--aui-on-surface-variant, #5d5e61); }
      .ae-pb h2 .n { margin-left:auto; font-size:13px; font-weight:600; color:var(--aui-on-surface-variant, #5d5e61); }
      .ae-pb .bar { height:4px; border-radius:4px; background:var(--aui-neutral-soft, #f1f0f4); margin:-4px 0 14px; overflow:hidden; }
      .ae-pb .bar i { display:block; height:100%; background:var(--aui-primary, #8223d2); }
      .ae-pb .who { display:grid; grid-template-columns:auto 1fr; gap:4px 16px; margin-bottom:12px; }
      .ae-pb .who span { color:var(--aui-on-surface-variant, #5d5e61); }
      .ae-pb .tags { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px; }
      .ae-pb .tag { font-size:12px; font-weight:600; padding:2px 10px; border-radius:10000px; background:var(--aui-status-warning-soft, #fff0c0); color:var(--aui-status-on-warning-soft, #3a3000); }
    `));
    const onArrivals = () => /^\/check-in\/arrivals\/?$/.test(location.pathname);
    const nameOf = (a) => { const c = a.customer || {}; return (c.fullName || [c.givenName || c.firstName, c.familyName || c.lastName].filter(Boolean).join(' ')).trim() || 'Customer'; };
    async function notContacted() {
      const q = AE.portal('query', { endpoint: 'getUpcomingArrivals', list: 'data', field: 'arrivalId' }) || {};
      const base = Object.assign({}, q.args); delete base.page; delete base.pageSize;
      const all = [];
      for (let page = 1; page <= 20; page++) {
        const u = new URLSearchParams();
        for (const [k, v] of Object.entries(Object.assign({}, base, { page, pageSize: 100 }))) if (v !== undefined && v !== null && v !== '') u.set(k, v);
        const j = await AE.api('GET', '/api/arrivals/upcoming-arrivals?' + u);
        const data = (j && j.data) || [];
        all.push(...data);
        if (!data.length || all.length >= ((j && j.rowCount) || 0)) break;
      }
      return all.filter((a) => !contacted(a) && awaiting(a) && !NO_BOX.includes(programOf(a)));
    }
    // The scored list: each arrival read in full (the list's rows aren't proven to carry the program and device).
    async function scored() {
      const [leads, prices] = await Promise.all([sheet('leads'), sheet('prices')]);
      if (!leads || !leads.data) return null;
      const list = await notContacted();
      const full = [];
      for (const r of list.slice(0, 60)) { const a = AE.unwrap(await AE.api('GET', '/api/arrivals/' + r.arrivalId).catch(() => null)); if (a && a.arrivalId) full.push(a); }
      const twice = twiceOf(full);
      const rows = full.map((a) => Object.assign({ a }, certainty(a, leads.data, prices && prices.data, twice(a))))
        .filter((r) => r.score > 0).sort((x, y) => y.score - x.score);
      return { rows, leads: leads.data, prices: prices && prices.data, twice, raw: { leads, prices } };
    }

    /*
      The Arrivals page's own chip row. Portal also draws a chip row inside the search bar's dropdown when it's expanded,
      and that one can come first in the page: so the row taken is the one nearest the arrivals list (the deepest
      ancestor of the list that holds it). Outside a chip row's DOM order nothing about Portal's markup is assumed.
    */
    function pageChips() {
      const boxes = [...document.querySelectorAll('[data-aui="chips.manual-selection"]')];
      const list = document.querySelector('[data-testid="arrivals-container"]');
      if (!boxes.length || !list) return null;
      let best = null, bestDepth = -1, bestBelow = 0;
      for (const box of boxes) {
        let up = list, depth = 0;
        for (let n = list; n; n = n.parentElement) depth++;
        while (up && !up.contains(box)) { up = up.parentElement; depth--; }
        if (!up) continue;
        let below = 0; // how far the row sits under that ancestor: on a tie the shallower one is the page's, a dropdown's is nested deeper
        for (let n = box; n && n !== up; n = n.parentElement) below++;
        if (depth > bestDepth || (depth === bestDepth && below < bestBelow)) { best = box; bestDepth = depth; bestBelow = below; }
      }
      return best;
    }
    let batchState = null, batchLoading = false, batchVisit = null; // batchVisit: the page visit the count belongs to
    async function batchButton() {
      const chips = pageChips();
      let b = document.getElementById(BATCH_ID);
      if (!onArrivals() || !chips) { b?.remove(); batchVisit = null; batchState = null; return; }
      if (batchVisit !== location.href && !batchLoading) {
        batchVisit = location.href; batchLoading = true;
        try { batchState = await scored(); } catch (_) { batchState = null; } finally { batchLoading = false; }
      }
      const rows = batchState && batchState.rows;
      if (!rows || !rows.length) { b?.remove(); return; }
      const n = rows.filter((r) => r.sure).length;
      if (!b) b = h('button', { type: 'button', id: BATCH_ID, class: 'sg-btn sg-primary', onclick: () => openBatch(batchState) });
      b.innerHTML = AE.actionIcon('leadReplies', 20) + 'Batch send (' + n + ')';
      if (b.parentElement !== chips || b.nextElementSibling) chips.append(b);
    }

    function openBatch(st) {
      AE.confirm.css();
      const ticks = new Map(), ctl = { gap: 1500 };
      const sure = st.rows.filter((r) => r.sure), unsure = st.rows.filter((r) => !r.sure);
      const reviewBtn = (primary) => unsure.length ? h('button', { type: 'button', class: 'sg-btn' + (primary ? ' sg-primary' : ''), onclick: () => review(0) }, 'Review ' + unsure.length) : null;
      const msgs = h('div', { class: 'msgs' });
      const go = h('button', { type: 'button', class: 'sg-btn sg-primary', onclick: run });
      const all = h('input', { type: 'checkbox', checked: !!sure.length, disabled: !sure.length, onchange: () => { for (const [, c] of ticks) c.checked = all.checked; paint(); } });
      const body = h('tbody', null, st.rows.map((r) => {
        const c = h('input', { type: 'checkbox', checked: r.sure, disabled: !r.sure, onchange: paint });
        if (r.sure) ticks.set(r, c);
        return h('tr', { class: r.sure ? '' : 'dim' }, h('td', null, c), h('td', null, nameOf(r.a)), h('td', null, deviceOf(r.a)),
          h('td', null, r.p.item.title, r.why.length ? h('div', { class: 'why' }, r.why.join(' · ')) : null),
          h('td', { style: 'text-align:center' }, h('span', { class: 'sc' + (r.sure ? ' s100' : r.score >= 50 ? ' mid' : '') }, String(r.score))));
      }));
      const picked = () => sure.filter((r) => ticks.get(r).checked);
      function paint() {
        const p = picked(), by = new Map();
        for (const r of p) { const k = r.text; by.set(k, { title: r.p.item.title, n: ((by.get(k) || {}).n || 0) + 1 }); }
        msgs.replaceChildren(...[...by].map(([text, m]) => h('div', { class: 'q' }, h('b', null, m.title + ' · ' + m.n), text)));
        go.textContent = 'Send ' + p.length + ' and mark contacted';
        go.disabled = !p.length;
        all.checked = !!p.length && p.length === sure.length;
      }
      const cancel = h('button', { type: 'button', class: 'sg-btn', onclick: () => close() }, 'Cancel');
      const table = h('table', null, h('thead', null, h('tr', null, h('th', { style: 'width:30px' }, all), h('th', null, 'Customer'), h('th', null, 'Device'),
        h('th', null, 'Message'), h('th', { style: 'text-align:center' }, 'Sure'))), body);
      const card = h('div', { class: 'sg sg-card ae-pb', role: 'dialog', 'aria-modal': 'true' },
        h('h2', { class: 'ae-head' }, h('span', { html: AE.actionIcon('leadReplies', 28), style: 'line-height:0;flex:none' }), 'Provoke - Batch send'),
        table, msgs, h('div', { class: 'ft' }, h('span', { class: 'sp' }), cancel, reviewBtn(false), go));
      let busy = false;
      const scrim = h('div', { class: 'sg sg-confirm-scrim', onclick: (e) => { if (e.target === scrim && !busy) close(); } }, card);
      const onKey = (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); close(); } };
      function close() { scrim.remove(); document.removeEventListener('keydown', onKey, true); }
      document.addEventListener('keydown', onKey, true);
      document.body.append(scrim);
      paint();

      async function run() {
        const p = picked();
        if (!p.length) return;
        busy = true;
        const cells = new Map();
        const stop = h('button', { type: 'button', class: 'sg-btn', onclick: () => { ctl.stopped = true; stop.disabled = true; } }, 'Stop');
        table.replaceChildren(h('thead', null, h('tr', null, h('th', null, 'Customer'), h('th', null, 'Device'), h('th', null, 'Message'), h('th', null, ''))),
          h('tbody', null, p.map((r) => { const s = h('td'); cells.set(r.a.arrivalId, s);
            return h('tr', null, h('td', null, nameOf(r.a)), h('td', null, deviceOf(r.a)), h('td', null, r.p.item.title), s); })));
        msgs.remove();
        card.querySelector('.ft').replaceChildren(h('span', { class: 'sp' }), stop);
        const label = { sent: '✓ Sent', stopped: 'Stopped', half: 'Texted, not marked contacted', failed: "Couldn't send" };
        const out = await batch(p.map((r) => r.a.arrivalId), st.leads, st.prices, st.twice, (id, state, r) => {
          const s = cells.get(id);
          if (!s) return;
          if (state === 'sending') { s.innerHTML = '<span class="sg-spin"></span>'; return; }
          s.replaceChildren(h('span', { class: 'st ' + state }, state === 'skipped' ? r.why : label[state]));
          if (r && r.error) s.insertAdjacentHTML('beforeend', '<div class="why">' + report('Batch send for arrival ' + id, r.error).trim() + '</div>');
        }, ctl);
        busy = false;
        const n = out.filter((r) => r.state === 'sent').length;
        if (n) AE.portal('refresh', { tags: ['Arrivals'] });
        card.querySelector('.ft').replaceChildren(h('span', { class: 'sp' }), h('button', { type: 'button', class: unsure.length ? 'sg-btn' : 'sg-btn sg-primary', onclick: () => close() }, 'Close'), reviewBtn(true));
        batchVisit = null; // count again
      }

      // Review: the leads that aren't sure, one at a time, each in the arrival drawer's own box (message picked and
      // editable, price chips, call warning). Each is read again first; one contacted meanwhile is passed over.
      async function review(i) {
        busy = false;
        if (i >= unsure.length) { close(); return; }
        const r = unsure[i], last = i === unsure.length - 1;
        const head = h('h2', { class: 'ae-head' }, h('span', { html: AE.actionIcon('leadReplies', 28), style: 'line-height:0;flex:none' }), 'Provoke - Review',
          h('span', { class: 'n' }, (i + 1) + ' of ' + unsure.length));
        const bar = h('div', { class: 'bar' }, h('i', { style: 'width:' + Math.round((i + 1) / unsure.length * 100) + '%' }));
        card.replaceChildren(head, bar, h('span', { class: 'sg-spin' }));
        let a = null;
        try { a = AE.unwrap(await AE.api('GET', '/api/arrivals/' + r.a.arrivalId)); } catch (_) { a = null; }
        if (!scrim.isConnected) return;
        if (!a || !a.arrivalId || contacted(a) || !awaiting(a)) { review(i + 1); return; }
        const prog = a.program && (a.program.name || a.program.programName);
        const who = h('div', { class: 'who' }, h('span', null, 'Customer'), h('b', null, nameOf(a)), h('span', null, 'Device'), h('b', null, deviceOf(a) || '—'),
          prog ? h('span', null, 'Program') : null, prog ? h('b', null, prog) : null);
        const why = r.why.filter((w) => w !== 'Needs a call'); // the box's own call notice says it
        const tags = why.length ? h('div', { class: 'tags' }, why.map((w) => h('span', { class: 'tag' }, w))) : null;
        const open = h('button', { type: 'button', class: 'sg-btn', onclick: () => window.open('/check-in/arrivals/' + a.arrivalId, '_blank') }, 'Open arrival');
        const skip = h('button', { type: 'button', class: 'sg-btn', onclick: () => review(i + 1) }, 'Skip');
        const box = render(a, st.raw.leads, st.raw.prices, { review: true, sendLabel: last ? 'Send and finish' : 'Send and next', left: open, before: skip,
          onDone: () => { batchVisit = null; AE.track('leadReplies:reviewSend'); review(i + 1); } });
        card.replaceChildren(head, bar, who, tags, box);
      }
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
        border:1px solid var(--aui-outline, #c6c6ca); background:transparent; color:inherit; }
      #${CHAT_ID} .c.top { background:var(--aui-primary, #8223d2); border-color:var(--aui-primary, #8223d2); color:var(--aui-on-primary, #fff); font-weight:600; }
      #${CHAT_ID} .c.top small { font-weight:400; opacity:.85; margin-left:4px; }
      #${CHAT_ID} .c.on { outline:2px solid var(--aui-primary, #8223d2); outline-offset:2px; }
      #${CHAT_ID} .c.more { border-style:dashed; }
      #${CHAT_ID} .menu { position:absolute; z-index:5; left:0; right:0; bottom:calc(100% + 34px); max-height:320px; overflow:auto; padding:6px 0;
        background:var(--aui-surface, #fff); color:var(--aui-on-surface, #1b1b1f); border:1px solid var(--aui-outline, #c6c6ca); border-radius:10px; box-shadow:0 8px 24px rgba(0,0,0,.3); }
      #${CHAT_ID} .menu button { display:block; width:100%; text-align:left; font:inherit; font-size:14px; padding:7px 14px; border:0; background:transparent; color:inherit; cursor:pointer; }
      #${CHAT_ID} .menu button:hover { background:var(--aui-primary-soft, #f3e8fc); }
      #${CHAT_ID} .menu .g { font-size:14px; font-weight:700; padding:8px 14px 4px; }
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

    /*
      Built each time the panel opens, so the status is current (a WO just set to Ready for pickup). The status only orders the chips:
      when the work order read fails (or its answer isn't a work order) the row is placed anyway, without status ordering, as before
      the guard. The read is then retried with a backoff (30 s, doubling, 10 min at most) instead of on every 1 s tick.
    */
    let chatStatus = null, chatBuilding = false;
    const statusMiss = new Map(); // woId → { n, next }: when the status read may be tried again
    const STATUS_RETRY_MS = 30000, STATUS_RETRY_MAX = 10 * 60000;
    async function statusOf(woId) {
      let j;
      try { j = await AE.api('GET', '/api/workorder/' + woId); }
      catch (_) { j = undefined; } // a failed call: nothing to look at (never shape-checked)
      let wo = null;
      if (j !== undefined) { try { wo = AE.shape.workorder(j, 'Provoke work order ' + woId); } catch (_) { wo = null; } }
      if (!wo) {
        const m = statusMiss.get(woId) || { n: 0 };
        statusMiss.set(woId, { n: m.n + 1, next: Date.now() + Math.min(STATUS_RETRY_MS * 2 ** m.n, STATUS_RETRY_MAX) });
        return null;
      }
      statusMiss.delete(woId);
      const name = wo.workorderStatusName || (wo.WorkorderStatus && wo.WorkorderStatus.name) || (wo.workorderStatus && wo.workorderStatus.name) || '';
      return { key: byStatus(name, Number(wo.workorderStatusId)), name };
    }
    async function chat() {
      const old = document.getElementById(CHAT_ID), woId = woIdNow(), box = woId && msgBox();
      if (!box || box.disabled || box.readOnly) { if (old) unplace(); return; } // texting off for this customer: Portal's own message shows
      const miss = statusMiss.get(woId);
      if (old && old.dataset.wo === woId && !(miss && Date.now() >= miss.next)) { place(old, box); return; } // built (a row without its status: until the retry is due)
      if (chatBuilding) return;
      chatBuilding = true;
      try {
        const retryStatus = !(miss && Date.now() < miss.next); // inside the backoff: the row goes in without its status, no call
        const [leads, st] = await Promise.all([sheet('leads'), retryStatus ? statusOf(woId) : null]);
        const items = (leads && leads.data && leads.data.items) || [];
        const b2 = msgBox();
        if (!items.length || !b2 || woIdNow() !== woId) return;
        chatStatus = st;
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
      const root = h('div', { id: CHAT_ID, class: 'sg sg-card', 'data-wo': woId },
        h('div', { class: 'hd ae-head' }, h('span', { style: 'line-height:0', html: AE.actionIcon('leadReplies', 22) }), h('span', null, 'Provoke'),
          h('span', { class: 'sp' }), h('span', { class: 'sg-soft', style: 'font-weight:400' }, 'Lead sheet' + sheetEdited(leads))),
        cs);
      return root;
    }

    AE.every(1000, box);
    AE.every(1000, chat);
    AE.every(1000, batchButton);
    AE.onDom(() => { // the drawer's column, the frame it appears (2.23); box() keeps its own "decided" state
      if (woIdNow()) chat(); else if (document.getElementById(CHAT_ID)) unplace();
      if (!arrivalId()) { document.getElementById(BOX_ID)?.remove(); return; }
      const b = document.getElementById(BOX_ID);
      if (!b || !b.isConnected) box();
    });
    AE.leadReplies = { pick, pricesFor, screenPrices, byStatus, render, certainty, twiceOf, batch, openBatch };
  },
});
