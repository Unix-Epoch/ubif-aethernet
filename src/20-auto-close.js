/*
  Cleaning auto-close — round purple ⚡ button in a cleaning arrival's
  "Customer arrival" drawer. One click replays the portal's own API sequence
  (see the vault note "Cleaning WO Flow"):

    check-in    validate-imei → checkin/workorder → calculate-sla →
                update-service-job-status → PUT checkin/workorder   (status 8)
    status walk PATCH status 9, then PUT workorder 10 → 11 → 12 → 13,
                each followed by the same auto-note the UI posts
    checkout    verify cart total is $0 → checkout/complete-order

  Deliberately NOT replayed: PUT checkin/customers (re-saves the customer)
  and PUT customer-devices (would blank the shared device's nickname and
  passcode on the parent WO). A Stop button halts before the next call.
*/
AE.tool({
  id: 'autoClose',
  name: 'Cleaning auto-close',
  sites: ['portal.ubreakifix.net'],
  run() {
    const { h, icon } = AE;
    const DEVICE_ISSUES = ['Cleaning'];
    const BIN = ''; // cleanings aren't physical — no bin
    const STEP_DELAY_MS = 400;
    const BTN_ID = 'sg-autoclose-btn';
    let checkedArrivalId = null, isCleaning = false, running = false, stopRequested = false;

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
      const cart = unwrap(await api('GET', '/api/get-cart/' + encodeURIComponent(wo.csuCartId) + '?includePartStatus=true'));
      const pay = (cart && (cart.payment || (cart.cart && cart.cart.payment))) || null;
      const total = pay ? Number(pay.total) : NaN;
      if (total !== 0) throw new Error('Cart total is ' + (pay ? '$' + pay.total : 'unknown') + ', not $0 — stopped before checkout. Finish at Ready for pickup by hand.');
      await api('POST', '/api/workorder/demographic/customer-data', { customerId, clientId });
      const done = await api('POST', '/api/checkout/complete-order', { workorderId: woId, sendComms: false });
      log('Sale complete' + (done && done.salesOrder && done.salesOrder.salesId ? ' (' + done.salesOrder.salesId + ')' : ''));
      return woId;
    }

    const woLink = (id) => '<a href="/repair/workorder/' + id + '">WO ' + id + '</a>';

    async function onClick(arrivalId) {
      if (running) return;
      running = true; stopRequested = false;
      const panel = AE.progressPanel('Cleaning auto-close');
      const stop = h('button', { class: 'sg-btn sg-lg sg-danger', onclick: () => { stopRequested = true; stop.disabled = true; stop.textContent = 'Stopping after current call…'; } }, '■ Stop');
      panel.actions(stop);
      let woId = null;
      const log = (t, id) => { if (id) woId = id; panel.step(t); };
      const btn = document.getElementById(BTN_ID);
      if (btn) btn.disabled = true;
      try {
        const id = await run(arrivalId, log);
        panel.finish('ok', 'Done — ' + woLink(id) + ' checked in, completed, and sold at $0.');
      } catch (e) {
        const where = woId ? ' ' + woLink(woId) + ' was left at the last step listed above.' : ' No work order was created.';
        const stopped = e instanceof AE.Stopped;
        panel.finish(stopped ? 'stop' : 'err', (stopped ? 'Stopped.' : AE.esc(e.message)) + where);
      } finally {
        panel.actions();
        running = false;
        if (btn) btn.disabled = false;
      }
    }

    const portalCheckinButton = () => [...document.querySelectorAll('button')].find((b) => b.offsetParent && b.textContent.trim() === 'Check-in');

    async function tick() {
      const m = location.pathname.match(/^\/check-in\/arrivals\/(\d+)$/);
      const existing = document.getElementById(BTN_ID);
      if (!m) { existing?.remove(); checkedArrivalId = null; return; }
      const arrivalId = Number(m[1]);
      if (checkedArrivalId !== arrivalId) {
        checkedArrivalId = arrivalId; isCleaning = false; existing?.remove();
        try {
          const a = unwrap(await AE.api('GET', '/api/arrivals/' + arrivalId));
          isCleaning = !!AE.CLEANING_PROGRAMS[a && a.program && a.program.programId];
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
      const b = h('button', {
        id: BTN_ID, type: 'button', class: 'sg-fab', 'aria-label': 'Auto-close cleaning',
        title: 'Auto-close cleaning: check in, walk to Ready for pickup, and complete the $0 sale',
        style: 'margin-right:auto;align-self:center;color:#fff;width:' + size + 'px;height:' + size + 'px',
        html: icon('bolt', Math.round(size * 0.5)),
        onclick: () => onClick(arrivalId),
      });
      footer.insertBefore(b, footer.firstChild);
    }
    AE.every(1000, tick);
  },
});
