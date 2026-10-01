/*
  Swiftcast (cleaning auto-close) — round purple ⚡ button in a cleaning arrival's
  "Customer arrival" drawer. One click replays Portal's own API sequence
  (see the vault note "Cleaning WO Flow"):

    check-in    validate-imei → checkin/workorder → calculate-sla →
                update-service-job-status → PUT checkin/workorder   (status 8)
    status walk PATCH status 9, then PUT workorder 10 → 11 → 12 → 13,
                each followed by the same auto-note the UI posts
    labor       VZ Device Refresh (program 11759) only: labor SKU 10156 into the
                cart (Portal's own POST order/cart/item/add, LineType labor),
                which earns the tech commission. If it ever leaves anything to
                pay, it's taken back out before checkout (order/cart/item/remove)
                and the run finishes at $0 as before, with a warning.
    checkout    verify cart total is $0 → checkout/complete-order

  Dualcast (Settings → Swiftcast, on by default): when a device has two or
  more cleaning arrivals waiting (e.g. VZ Device Refresh + VZ Sanitization),
  one button runs them all back to back — one confirmation, one progress
  panel, stops at the first problem. Offered in the arrival drawer (next to
  ⚡, when the same IMEI has another cleaning waiting), in Esuna's list and
  in Divination's panel.

  Deliberately NOT replayed: PUT checkin/customers (re-saves the customer)
  and PUT customer-devices (would blank the shared device's nickname and
  passcode on the parent WO). A Stop button halts before the next call.
*/
AE.crystal({
  id: 'autoClose',
  name: 'Swiftcast',
  sites: ['portal.ubreakifix.net'],
  run() {
    const { h, icon } = AE;
    const DEVICE_ISSUES = ['Cleaning'];
    const BIN = ''; // cleanings aren't physical — no bin
    const STEP_DELAY_MS = 400;
    const BTN_ID = 'sg-autoclose-btn', MENU_ID = 'sg-cast-menu', INTRO_ID = 'sg-cast-intro';
    document.head.append(h('style', null, `
      .sg-cast { position:relative; padding:0; overflow:visible; background:#1a1c1e; }
      .sg-cast .sg-aicon { border-radius:50%; display:block; width:100%; height:100%; }
      .sg-cast .n { position:absolute; right:-4px; top:-4px; min-width:18px; height:18px; padding:0 4px; border-radius:10000rem; background:#d1344b; color:#fff;
        font:700 11px/18px Apercu, "Helvetica Neue", Helvetica, Arial, sans-serif; text-align:center; box-shadow:0 0 0 2px var(--aui-surface, #fff); }
      #${MENU_ID} { position:fixed; z-index:2147483646; width:280px; padding:6px; }
      #${MENU_ID} .opt { display:flex; flex-direction:column; align-items:flex-start; gap:1px; width:100%; padding:8px 10px; border:0; border-radius:8px; background:none; cursor:pointer;
        text-align:left; font:inherit; color:inherit; }
      #${MENU_ID} .opt:hover { background:var(--aui-neutral-soft, #f1f0f4); }
      #${MENU_ID} .opt .sg-soft { font-size:12px; }
      #${INTRO_ID} { position:fixed; z-index:2147483646; width:300px; padding:12px 14px; font-size:13px; line-height:1.45; }
      #${INTRO_ID}::after { content:''; position:absolute; bottom:-8px; left:var(--tail, 20px); width:16px; height:16px; transform:rotate(45deg);
        background:var(--aui-surface, #fff); box-shadow:2px 2px 3px rgba(12,14,17,.08); }
      #${INTRO_ID} .hd { display:flex; align-items:center; gap:8px; font-size:15px; margin-bottom:6px; }
      #${INTRO_ID} .hd .sg-aicon { border-radius:6px; }
      #${INTRO_ID} p { margin:0 0 6px; }
      #${INTRO_ID} .sg-actions { margin-top:8px; justify-content:flex-end; }
    `));
    const REFRESH_PROGRAM = 11759, REFRESH_LABOR_SKU = '10156'; // VZ Device Refresh → its labor SKU (commission)
    const LABOR_LINE = { '@odata.type': '#Microsoft.Dynamics.Commerce.Runtime.DataModel.AttributeTextValue', Name: 'LineType', TextValue: 'labor' };
    const cartOf = (r) => { const c = unwrap(r); return (c && (c.cartItems ? c : c.cart)) || c || {}; };
    const skuOf = (i) => String(i.sku || i.itemNumber || i.ItemId || '');
    let laborNote = null; // a warning to show when the run finishes
    let checkedArrivalId = null, isCleaning = false, running = false, stopRequested = false;
    let siblings = [], thisArrival = null; // Dualcast: other cleaning arrivals waiting for the same device

    async function api(method, path, body) {
      const r = await AE.api(method, path, body, { shouldStop: () => stopRequested });
      await AE.sleep(STEP_DELAY_MS);
      return r;
    }
    const unwrap = AE.unwrap;

    async function run(arrivalId, log) {
      const arrival = unwrap(await api('GET', '/api/arrivals/' + arrivalId));
      const programId = arrival.program && arrival.program.programId;
      if (!AE.CLEANING_PROGRAMS[programId]) throw new Error('Not a cleaning program (' + programId + ') — refusing.');
      const dev = arrival.customerDevice || {};
      const customerId = String(arrival.customer.customerId);
      const clientId = arrival.clientId;
      const storeId = arrival.storeId;
      const serviceJobId = arrival.partnerJobDetails && arrival.partnerJobDetails.serviceJobId;

      const tech = (await AE.profile()).name;
      if (!tech) throw new Error("Couldn't read your name from your login — refusing to post nameless notes.");

      // 1. IMEI — the arrival carries all 15 digits (the drawer masks the last).
      //    Try the known last digit first, then the rest of 0–9.
      const imei = String(dev.imei || '');
      if (!/^\d{14,15}$/.test(imei)) throw new Error('No usable IMEI on this arrival — check in by hand.');
      const first14 = imei.slice(0, 14);
      const candidates = imei.length === 15 ? [imei[14], ...'0123456789'.split('').filter((d) => d !== imei[14])] : '0123456789'.split('');
      let validImei = null;
      for (const d of candidates) {
        const r = await api('POST', '/api/arrivals/' + arrivalId + '/validate-imei', { arrivalId, imei: first14 + d, lastDigits: d });
        if (r && r.valid) { validImei = first14 + d; break; }
      }
      if (!validImei) throw new Error('IMEI failed validation for every last digit 0–9.');
      log('IMEI validated');

      // 2. Create the WO.
      const created = await api('POST', '/api/checkin/workorder', {
        itemswithdevice: [], customerDeviceId: String(dev.customerDeviceId), arrivalId, isWarrantyVoided: false, clientId,
      });
      const woId = created && created.workorder && created.workorder.workorderId;
      if (!woId) throw new Error('Check-in returned no work order ID.');
      log('Created WO ' + woId, woId);

      const sla = await api('POST', '/api/calculate-sla/' + woId);
      if (serviceJobId) {
        await api('POST', '/api/checkin/update-service-job-status/' + encodeURIComponent(serviceJobId), { scenario: 'Create work order', arrivalId, programId });
      }
      await api('PUT', '/api/checkin/workorder', {
        workorderId: woId, deviceIssues: DEVICE_ISSUES, deviceDiagNotes: [], additionalDetails: '',
        customerDeviceId: String(dev.customerDeviceId), itemswithdevice: [],
        estimateRepairTime: (sla && sla.estimateEndTime) || new Date(Date.now() + 2 * 3600e3).toISOString(),
        quotedPrice: '0', isWarrantyVoided: false, arrivalId, isImeiUnavailable: false, isSerialUnavailable: false,
        quoteId: null, binLocation: BIN,
      });
      log('Checked in');

      // VZ Device Refresh: add the refresh labor SKU (commission). Never stops the run.
      laborNote = null;
      let laborAdded = false;
      if (Number(programId) === REFRESH_PROGRAM) {
        try {
          const w = await getWoForCart(woId);
          const cart = cartOf(await api('GET', '/api/get-cart/' + encodeURIComponent(w.csuCartId) + '?includePartStatus=true'));
          if ((cart.cartItems || []).some((i) => skuOf(i) === REFRESH_LABOR_SKU)) log('Refresh labor ' + REFRESH_LABOR_SKU + ' already in the cart');
          else {
            await api('POST', '/api/order/cart/item/add', {
              cartId: w.csuCartId, programId: REFRESH_PROGRAM, workorderId: woId, saveCartToSalesOrder: true,
              cartLines: [{ ItemId: REFRESH_LABOR_SKU, Quantity: 1, AttributeValues: [LABOR_LINE] }],
            });
            laborAdded = true;
            AE.track('autoClose:refreshLabor');
            log('Added refresh labor ' + REFRESH_LABOR_SKU);
          }
        } catch (e) {
          if (e instanceof AE.Stopped) throw e;
          laborNote = "Couldn't add refresh labor " + REFRESH_LABOR_SKU + ' (' + (e.message || e) + '), so this cleaning was completed without it.';
          log('Refresh labor not added');
        }
      }

      // 3. Status walk. Notes mirror the UI exactly (incl. its double space
      //    in "completed diagnostics" and which steps use the batch endpoint).
      const note = (noteTag, noteText, batch) => {
        const n = { noteText, customerId, workorderId: woId, noteTag, noteType: 1 };
        return batch ? api('POST', '/api/notes', { notes: [n] }) : api('POST', '/api/note', n);
      };
      const getWo = async () => {
        const r = await api('GET', '/api/workorder/' + woId);
        const wo = Object.assign({}, (r && r.workorder) || unwrap(r));
        delete wo.workorderId;
        return wo;
      };

      await api('PATCH', '/api/workorder/' + woId + '/status', { workorderStatusId: 9 });
      await note('ready_for_work', tech + ' started work.');
      log('Started work');

      const steps = [
        { to: 10, extra: { completedWorkorderStatusId: 9, note: '' }, tag: 'diagnostics', text: tech + '  completed diagnostics.', batch: true, label: 'Diagnostics done' },
        { to: 11, extra: {}, tag: 'work_in_progress', text: tech + ' completed work.', label: 'Work done' },
        { to: 12, extra: {}, tag: 'quality_check', text: tech + ' completed quality check.', label: 'QC done' },
        { to: 13, extra: { sendComms: false }, tag: 'ready_for_pickup', text: tech + ' marked the device as "Ready for pickup." - Completed', batch: true, label: 'Ready for pickup', attribute: true },
      ];
      for (const s of steps) {
        const wo = await getWo();
        if (s.attribute) {
          await api('POST', '/api/workorder/attribute', {
            workorderId: woId, workorderStatusId: 13, sendComms: false, workorderBin: BIN, storeId,
            WorkorderAttribute: [{ workorderId: woId, workorderAttributeTypeId: 22, key: 'service_outcome', value: 'Completed' }],
          });
        }
        await api('PUT', '/api/workorder/' + woId, Object.assign(wo, { workorderStatusId: s.to, markCurrentStepCompleted: true }, s.extra));
        await note(s.tag, s.text, s.batch);
        log(s.label);
      }

      // 4. Checkout — only if the cart really nets to $0.
      await api('GET', '/api/checkout/workorder/' + woId);
      const wo = await getWo();
      const readCart = async () => unwrap(await api('GET', '/api/get-cart/' + encodeURIComponent(wo.csuCartId) + '?includePartStatus=true'));
      const payOf = (c) => (c && (c.payment || (c.cart && c.cart.payment))) || null;
      let cart = await readCart();
      let pay = payOf(cart);
      // The refresh labor is meant to be free to the customer; if it isn't, take it back out.
      if (laborAdded && pay && Number(pay.total) !== 0) {
        const line = (cartOf(cart).cartItems || []).find((i) => skuOf(i) === REFRESH_LABOR_SKU);
        if (line) {
          await api('POST', '/api/order/cart/item/remove', { cartId: wo.csuCartId, cartLines: [line.lineId], itemNumbers: [REFRESH_LABOR_SKU], workorderId: woId });
          laborNote = 'Refresh labor ' + REFRESH_LABOR_SKU + ' would have charged $' + pay.total + ', so it was taken back out and the sale stayed $0.';
          log('Refresh labor removed (it added a charge)');
          cart = await readCart(); pay = payOf(cart);
        }
      }
      const total = pay ? Number(pay.total) : NaN;
      if (total !== 0) throw new Error('Cart total is ' + (pay ? '$' + pay.total : 'unknown') + ', not $0 — stopped before checkout. Finish at Ready for pickup by hand.');
      await api('POST', '/api/workorder/demographic/customer-data', { customerId, clientId });
      const done = await api('POST', '/api/checkout/complete-order', { workorderId: woId, sendComms: false });
      log('Sale complete' + (done && done.salesOrder && done.salesOrder.salesId ? ' (' + done.salesOrder.salesId + ')' : ''));
      return woId;
    }

    async function getWoForCart(woId) {
      const r = await api('GET', '/api/workorder/' + woId);
      return (r && r.workorder) || unwrap(r) || {};
    }
    const woLink = (id) => '<a href="/repair/workorder/' + id + '">WO ' + id + '</a>';

    /*
      Never act while the store is closed (Portal's Close store button). Asked
      fresh each time (/api/auth/user → isStoreOpen, the flag behind Portal's
      own Open/Close store button); if Portal can't be asked, don't act either.
    */
    async function storeClosed() {
      let open;
      try { open = (await AE.api('GET', '/api/auth/user')).isStoreOpen; } catch (e) {
        AE.toast('Swiftcast', "Couldn't check whether the store is open (" + (e.message || e) + '). Nothing was created.', 'err', 9000);
        return true;
      }
      if (open === false) {
        AE.toast('Swiftcast is off while the store is closed', 'Open the store in Portal, then try again. Nothing was created.', 'err', 9000);
        return true;
      }
      return false;
    }

    // Dualcast: several cleanings in one go, one after another, in one panel.
    // fake (dev tools only): the same confirmation and panel, with simulated steps and no API calls.
    async function runMany(items, customerName, fake) {
      if (running || (!fake && AE.status.blocked('autoClose'))) return;
      if (!fake && await storeClosed()) return;
      if (!fake) AE.track('autoClose:dualcast');
      running = true; stopRequested = false;
      const runner = fake ? (it, log) => fakeRun(it, log, fake) : (it, log) => run(it.arrivalId, log);
      const panel = AE.progressPanel('Dualcast · ' + items.length + ' cleanings' + (customerName ? ' for ' + customerName : '') + (fake ? ' (test)' : ''));
      const stop = h('button', { class: 'sg-btn sg-lg sg-danger', onclick: () => { stopRequested = true; stop.disabled = true; stop.textContent = 'Stopping after current call…'; } }, '■ Stop');
      panel.actions(stop);
      const done = [], notes = [];
      let woId = null;
      try {
        for (const [i, it] of items.entries()) {
          panel.step((i + 1) + ' of ' + items.length + ': ' + (AE.CLEANING_PROGRAMS[it.programId] || 'Cleaning'));
          woId = null;
          const id = await runner(it, (t, wid) => { if (wid) woId = wid; panel.step(t); });
          done.push(id);
          if (laborNote) notes.push(laborNote);
          if (!fake) AE.emit('cleaning-changed', { arrivalId: it.arrivalId, woId: id });
        }
        panel.finish('ok', 'Done — ' + done.map(woLink).join(' and ') + ' checked in, completed, and sold at $0.' + notes.map((n) => '<br><b>Note:</b> ' + AE.esc(n)).join(''));
      } catch (e) {
        const stopped = e instanceof AE.Stopped;
        const left = woId ? ' ' + woLink(woId) + ' was left at the last step listed above.' : '';
        panel.finish(stopped ? 'stop' : 'err', (stopped ? 'Stopped.' : AE.esc(e.message)) + left +
          (done.length ? ' Already finished: ' + done.map(woLink).join(', ') + '.' : '') + ' The rest were not started.');
      } finally {
        panel.actions();
        running = false;
        if (!fake) { AE.emit('cleaning-changed', {}); if (done.length) AE.refreshView(); }
      }
    }
    // Dev tools: Swiftcast's steps, timed like the real thing, nothing sent. fake.fail = fail the 2nd cleaning at QC.
    let fakeWo = 599000000;
    async function fakeRun(it, log, fake) {
      laborNote = null;
      const pause = async () => { await AE.sleep(450); if (stopRequested) throw new AE.Stopped(); };
      const woId = ++fakeWo;
      const steps = ['IMEI validated', ['Created WO ' + woId, woId], 'Checked in'];
      if (Number(it.programId) === REFRESH_PROGRAM) steps.push('Added refresh labor ' + REFRESH_LABOR_SKU);
      steps.push('Started work', 'Diagnostics done', 'Work done', 'QC done', 'Ready for pickup', 'Sale complete (SO-TEST)');
      for (const st of steps) {
        await pause();
        if (fake.fail && fakeWo % 2 === 0 && st === 'QC done') throw new Error('PUT /api/workorder/' + woId + ' → HTTP 500 (test failure, nothing was sent)');
        Array.isArray(st) ? log(st[0], st[1]) : log(st);
      }
      return woId;
    }

    async function onClick(arrivalId, checked) {
      if (running || AE.status.blocked('autoClose')) return;
      if (!checked && await storeClosed()) return;
      AE.track('autoClose:run');
      running = true; stopRequested = false;
      const panel = AE.progressPanel('Swiftcast · cleaning auto-close');
      const stop = h('button', { class: 'sg-btn sg-lg sg-danger', onclick: () => { stopRequested = true; stop.disabled = true; stop.textContent = 'Stopping after current call…'; } }, '■ Stop');
      panel.actions(stop);
      let woId = null;
      const log = (t, id) => { if (id) woId = id; panel.step(t); };
      const btn = document.getElementById(BTN_ID);
      if (btn) btn.disabled = true;
      try {
        const id = await run(arrivalId, log);
        panel.finish('ok', 'Done — ' + woLink(id) + ' checked in, completed, and sold at $0.' + (laborNote ? '<br><b>Note:</b> ' + AE.esc(laborNote) : ''));
      } catch (e) {
        const where = woId ? ' ' + woLink(woId) + ' was left at the last step listed above.' : ' No work order was created.';
        const stopped = e instanceof AE.Stopped;
        panel.finish(stopped ? 'stop' : 'err', (stopped ? 'Stopped.' : AE.esc(e.message)) + where);
      } finally {
        panel.actions();
        running = false;
        if (btn) btn.disabled = false;
        AE.emit('cleaning-changed', { arrivalId, woId }); // badge + WO pill refresh
        if (woId) AE.refreshView(); // Portal's own lists (arrivals, WOs) show the change without a reload
      }
    }

    // Also callable from the cleaning-rate list and the WO cleanings pill.
    // Those are one step removed from the arrival itself, so they always ask
    // first; the drawer button (you're looking at the arrival) doesn't.
    /*
      One round button, named for how many cleanings are waiting for the device:
      1 → Swiftcast (this cleaning), 2 → Dualcast, 3+ → Triplecast (all of them,
      after one confirmation). Right-click Dualcast/Triplecast: close only this cleaning.
      The first time a Dualcast/Triplecast shows, a speech bubble explains it.
    */
    const castOf = (n) => (n >= 3 ? ['triplecast', 'Triplecast'] : n === 2 ? ['dualcast', 'Dualcast'] : ['autoClose', 'Swiftcast']);
    function castButton({ size, items, customerName, single, fake }) {
      const n = items.length, [iconId, name] = castOf(n);
      const names = items.map((it) => AE.CLEANING_PROGRAMS[it.programId] || 'Cleaning');
      const b = h('button', {
        type: 'button', class: 'sg-fab sg-cast' + (n > 1 ? ' multi' : ''), 'aria-label': name,
        title: n > 1
          ? name + ': create all ' + n + ' cleanings waiting for this device (' + names.join(' + ') + '), one after the other. Right-click to close only this one.'
          : 'Swiftcast: check in, walk to Ready for pickup, and complete the $0 sale',
        style: 'align-self:center;width:' + size + 'px;height:' + size + 'px',
        html: AE.actionIcon(iconId, size) + (n > 1 ? '<span class="n">' + n + '</span>' : ''),
        onclick: () => (n > 1 ? AE.autoClose.dualcast({ items, customerName, fake }) : single()),
      });
      if (n > 1) b.addEventListener('contextmenu', (e) => { e.preventDefault(); castMenu(e.clientX, e.clientY, items, single, () => AE.autoClose.dualcast({ items, customerName, fake })); });
      return b;
    }
    function castMenu(x, y, items, single, all) {
      document.getElementById(MENU_ID)?.remove();
      const [, name] = castOf(items.length);
      const opt = (label, sub, fn) => h('button', { type: 'button', class: 'opt', role: 'menuitem', onclick: () => { menu.remove(); fn(); } }, h('b', null, label), h('span', { class: 'sg-soft' }, sub));
      const menu = h('div', { id: MENU_ID, class: 'sg sg-card', role: 'menu', style: 'left:' + Math.min(x, innerWidth - 300) + 'px;top:' + Math.max(8, y - 120) + 'px' },
        opt('Close only this cleaning', AE.CLEANING_PROGRAMS[items[0].programId] || 'This arrival', single),
        opt(name + ': close all ' + items.length, items.map((it) => AE.CLEANING_PROGRAMS[it.programId]).join(' + '), all));
      document.body.appendChild(menu);
      const off = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', off, true); } };
      setTimeout(() => document.addEventListener('mousedown', off, true), 0);
      return menu;
    }
    const INTRO_KEY = 'ae_dualcast_intro_seen';
    function castIntro(btn, items, force) {
      if (!force && GM_getValue(INTRO_KEY, false)) return;
      document.getElementById(INTRO_ID)?.remove();
      const [iconId, name] = castOf(items.length);
      const names = items.map((it) => AE.CLEANING_PROGRAMS[it.programId] || 'Cleaning');
      const bubble = h('div', { id: INTRO_ID, class: 'sg sg-card', role: 'dialog', 'aria-label': name },
        h('div', { class: 'hd' }, h('span', { html: AE.actionIcon(iconId, 28), style: 'line-height:0' }), h('b', null, name)),
        h('p', null, 'This device has ' + items.length + ' cleanings waiting (' + names.join(' + ') + '). Click to create them all, one after the other, after one confirmation.'),
        h('p', null, h('b', null, 'Right-click'), ' to close ', h('b', null, 'only this cleaning'), ' instead.'),
        h('p', { class: 'sg-soft' }, 'With one cleaning waiting, this button is Swiftcast; with three or more, Triplecast.'),
        h('div', { class: 'sg-actions' }, h('button', { type: 'button', class: 'sg-btn sg-primary', onclick: () => { GM_setValue(INTRO_KEY, true); bubble.remove(); } }, 'Got it')));
      document.body.appendChild(bubble);
      const place = () => {
        if (!btn.isConnected || !bubble.isConnected) { bubble.remove(); return; }
        const r = btn.getBoundingClientRect();
        bubble.style.left = Math.max(8, Math.min(r.left - 14, innerWidth - bubble.offsetWidth - 8)) + 'px';
        bubble.style.top = Math.max(8, r.top - bubble.offsetHeight - 14) + 'px';
        bubble.style.setProperty('--tail', Math.max(14, r.left - parseFloat(bubble.style.left) + r.width / 2 - 8) + 'px');
        requestAnimationFrame(place);
      };
      place();
    }

    // Dev tools: a fake Dualcast (confirmation + progress, no API calls), and the drawer's two buttons on a test card.
    const FAKE_ITEMS = [{ arrivalId: 900001, programId: REFRESH_PROGRAM }, { arrivalId: 900002, programId: 9470 }];
    AE.hooks.dualcastFake = (opts = {}) => AE.autoClose.dualcast({ items: FAKE_ITEMS, customerName: 'Jordan Reyes', fake: { fail: !!opts.fail } });
    // n: how many cleanings the test device has waiting (1 Swiftcast, 2 Dualcast, 3 Triplecast); the explainer always shows.
    AE.hooks.dualcastButton = (n = 2) => {
      document.getElementById('sg-dual-test')?.remove();
      const items = [{ arrivalId: 900001, programId: REFRESH_PROGRAM }, { arrivalId: 900002, programId: 9470 }, { arrivalId: 900003, programId: 11009 }].slice(0, n);
      const card = h('div', { id: 'sg-dual-test', class: 'sg sg-card', style: 'position:fixed;z-index:2147483645;right:24px;bottom:24px;width:380px;padding:14px 16px' },
        h('div', { style: 'display:flex;align-items:center;margin-bottom:12px' }, h('b', { style: 'flex:1' }, 'Customer arrival (test)'),
          h('button', { type: 'button', class: 'sg-x', onclick: () => { card.remove(); document.getElementById(INTRO_ID)?.remove(); } }, '✕')),
        h('div', { class: 'sg-soft', style: 'font-size:13px;margin-bottom:12px' }, n + ' cleaning' + (n > 1 ? 's' : '') + ' waiting for Jordan Reyes\'s device. Nothing here is sent to Portal.'));
      const fake = { fail: false };
      const btn = castButton({ size: 48, items, customerName: 'Jordan Reyes', fake,
        single: () => runMany(items.slice(0, 1), 'Jordan Reyes', fake) });
      btn.style.marginRight = 'auto';
      const row = h('div', { style: 'display:flex;align-items:center;justify-content:flex-end;gap:8px' }, btn,
        h('button', { type: 'button', class: 'sg-btn', style: 'height:48px' }, 'Cancel'), h('button', { type: 'button', class: 'sg-btn sg-primary', style: 'height:48px' }, 'Check-in'));
      card.append(row);
      document.body.appendChild(card);
      if (n > 1) castIntro(btn, items, true);
    };
    const dualcastOn = () => !AE.settings.autoClose || AE.settings.autoClose.dualcast !== false;
    AE.autoClose = {
      isRunning: () => running,
      dualcastOn,
      // items: [{ arrivalId, programId }] — every cleaning waiting for one device.
      async dualcast({ items, customerName, fake }) {
        if (!items || items.length < 2 || (!fake && AE.status.blocked('autoClose'))) return;
        if (!fake && await storeClosed()) return;
        if (running) { AE.confirm({ title: 'Already running', message: 'Another cleaning is being closed out — wait for it to finish.', confirmLabel: 'OK' }); return; }
        const ok = await AE.confirm({
          title: 'Create all ' + items.length + ' cleanings?',
          message: '<b>' + AE.esc(customerName || 'Customer') + '</b><ul style="margin:6px 0 0;padding-left:20px">' +
            items.map((it) => '<li>' + AE.esc(AE.CLEANING_PROGRAMS[it.programId] || 'Cleaning') + ' <span class="sg-soft">· arrival ' + it.arrivalId + '</span></li>').join('') + '</ul>' +
            '<div class="sg-soft" style="margin-top:6px">Each one is checked in, walked to Ready for pickup, and completed as a $0 sale, one after the other.</div>' +
            (fake ? '<div style="margin-top:6px;color:#e0761a;font-weight:600">Test run from the dev tools: nothing is sent to Portal.</div>' : ''),
          warning: "Are you sure you'd like to create these cleanings? Only use this if you are the one who repaired this device!",
          confirmLabel: 'Yes, create ' + items.length + ' cleanings',
        });
        if (ok) await runMany(items, customerName, fake);
      },
      async confirmAndRun({ arrivalId, programId, customerName }) {
        if (AE.status.blocked('autoClose')) return;
        if (await storeClosed()) return; // before asking, so nobody confirms for nothing
        if (running) { AE.confirm({ title: 'Already running', message: 'Another cleaning is being closed out — wait for it to finish.', confirmLabel: 'OK' }); return; }
        const ok = await AE.confirm({
          title: 'Create this cleaning?',
          message: '<b>' + AE.esc(customerName || 'Customer') + '</b> · ' + AE.esc(AE.CLEANING_PROGRAMS[programId] || 'Cleaning') +
            '<div class="sg-soft" style="margin-top:6px">Checks in arrival ' + arrivalId + ', walks it to Ready for pickup, and completes the $0 sale.</div>',
          warning: "Are you sure you'd like to create this cleaning? Only use this if you are the one who repaired this device!",
          confirmLabel: 'Yes, create cleaning',
        });
        if (ok) await onClick(arrivalId, true);
      },
    };

    const portalCheckinButton = () => [...document.querySelectorAll('button')].find((b) => b.offsetParent && b.textContent.trim() === 'Check-in');

    async function tick() {
      const m = location.pathname.match(/^\/check-in\/arrivals\/(\d+)$/);
      const existing = document.getElementById(BTN_ID);
      if (!m) { existing?.remove(); document.getElementById(INTRO_ID)?.remove(); checkedArrivalId = null; return; }
      const arrivalId = Number(m[1]);
      if (checkedArrivalId !== arrivalId) {
        checkedArrivalId = arrivalId; isCleaning = false; siblings = []; thisArrival = null;
        existing?.remove();
        try {
          const a = unwrap(await AE.api('GET', '/api/arrivals/' + arrivalId));
          isCleaning = !!AE.CLEANING_PROGRAMS[a && a.program && a.program.programId];
          thisArrival = a;
          if (isCleaning && dualcastOn()) {
            const imei = AE.data.imeiOf(a);
            siblings = imei ? (await AE.data.arrivals()).filter((x) => x.arrivalId !== arrivalId && x.program && AE.CLEANING_PROGRAMS[x.program.programId] && AE.data.imeiOf(x) === imei) : [];
            if (siblings.length) document.getElementById(BTN_ID)?.remove(); // redraw with Dualcast beside it
          }
        } catch (_) { checkedArrivalId = null; } // retry next tick
      }
      if (!isCleaning) return;
      const checkin = portalCheckinButton();
      if (!checkin || document.getElementById(BTN_ID)) return;
      // The drawer footer is a full-width flex row justified to flex-end; as its
      // first child with margin-right:auto, the button sits alone at the far left.
      let footer = checkin.parentElement;
      for (let el = checkin.parentElement; el && el !== document.body; el = el.parentElement) {
        if (getComputedStyle(el).justifyContent === 'flex-end') { footer = el; break; }
      }
      const size = checkin.offsetHeight || 48;
      const items = [thisArrival, ...(dualcastOn() ? siblings : [])].map((x) => ({ arrivalId: x.arrivalId, programId: x.program.programId }));
      const b = castButton({ size, items, customerName: AE.data.nameOf(thisArrival), single: () => onClick(arrivalId) });
      b.id = BTN_ID;
      b.style.marginRight = 'auto';
      footer.insertBefore(b, footer.firstChild);
      if (items.length > 1) castIntro(b, items);
    }
    AE.every(1000, tick);
  },
});
